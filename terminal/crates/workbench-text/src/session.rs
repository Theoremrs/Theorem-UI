//! The editing session: text, cursor, selection, undo, atomic ranges, IME
//! composition, and the exchange with the document owner.
//!
//! # Model
//!
//! The session holds two texts that share structure (a rope clone is cheap):
//!
//! * `accepted`: the owner's text at `accepted_revision`.
//! * `local`: what the user sees. It is always `accepted` with every pending
//!   operation applied in order.
//!
//! Pending operations form a chain: the first applies to `accepted`, the next
//! to the text the first produces, and so on. Only the first is ever sent
//! ([`EditSession::take_next_to_send`]), so the owner can transform it against
//! whatever it accepted meanwhile and the chain behind it stays valid.
//!
//! * A change from the owner ([`EditSession::apply_remote`]) is against
//!   `accepted`. It is applied there, then transformed past the pending chain
//!   (the owner's change wins an insertion tie, matching an owner that
//!   transforms the incoming operation against what it already accepted), and
//!   the transformed form is applied to `local`.
//! * An acknowledgement moves the acknowledged operations from the chain into
//!   `accepted`.
//! * A refusal keeps the operation and everything after it in the chain, marks
//!   them conflicting, and holds them back from sending. The text stays in
//!   `local` and is reported through [`EditSession::conflict`].
//!
//! # Units
//!
//! Positions on the session (cursor, selection, atomic ranges) are Unicode
//! scalar offsets, always on a grapheme cluster boundary. Changes handed to
//! the owner are in UTF-16 code units ([`TextChange`]) and, for the wire, in
//! scalars ([`ScalarChange`]). [`EditSession::coords`] converts the rest.

use crate::change::{
    Bias, ChangeError, ScalarChange, TextChange, apply_op, diff_op, invert_op, map_pos,
    op_from_changes, op_scalar_edits, op_to_scalar_changes, op_to_text_changes, touches_interior,
};
use crate::coords::{Coords, Snap, Unit};
use crate::history::{EditShape, History, Kind, class_of};
use crate::layout::{line_rows, row_index};
use operational_transform::{Operation, OperationSeq};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use std::fmt;
use unicode_segmentation::UnicodeSegmentation;

/// A document revision as the owner numbers them.
pub type Revision = u64;

/// Identifies one operation sent to the owner; doubles as its idempotency key.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OpId(pub String);

impl fmt::Display for OpId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Handle for a span the caller marked atomic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AtomicId(pub u32);

/// A marked span: the cursor skips over it and it deletes as one unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AtomicRange {
    pub id: AtomicId,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug)]
pub struct SessionConfig {
    /// Names this client in operation ids. Must differ between clients of one document.
    pub client_id: String,
    pub read_only: bool,
    /// One line only: no line breaks can be inserted.
    pub single_line: bool,
    pub tab_width: usize,
    /// Soft wrap to the viewport width.
    pub wrap: bool,
}

impl SessionConfig {
    pub fn new(client_id: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            read_only: false,
            single_line: false,
            tab_width: 4,
            wrap: true,
        }
    }
}

/// What a local edit did, ready for the owner: the change against the text
/// before the edit, in both unit systems. `base_revision` is the accepted
/// revision at the time of the edit. Send through
/// [`EditSession::take_next_to_send`], which gives the up-to-date form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalEdit {
    pub op_id: OpId,
    pub base_revision: Revision,
    /// UTF-16 code units, against the text before this change set.
    pub changes: Vec<TextChange>,
    /// Unicode scalars, the wire form.
    pub wire: Vec<ScalarChange>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingState {
    /// Not sent, or waiting for the one before it.
    Queued,
    /// Sent, not acknowledged.
    Sent,
    /// Refused, or typed after a refusal; held until the conflict is resolved.
    Conflicting,
}

/// One pending operation as it stands now (after transforms by remote changes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingEdit {
    pub op_id: OpId,
    pub state: PendingState,
    /// UTF-16, against the accepted text plus the pending edits before this one.
    pub changes: Vec<TextChange>,
    pub wire: Vec<ScalarChange>,
}

/// The user's text that the owner refused, still present in the document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict {
    pub reason: String,
    pub op_ids: Vec<OpId>,
    /// Where the held text sits in the current text, as scalar ranges.
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Send the held edits again, rebased on what the owner has.
    KeepMine,
    /// Drop the held edits and show the owner's text. The dropped text is returned.
    TakeTheirs,
    /// Keep the owner's text in the changed region and add the user's text next to it.
    KeepBoth,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    Left,
    Right,
    Up,
    Down,
    WordLeft,
    WordRight,
    LineStart,
    LineEnd,
    DocStart,
    DocEnd,
    PageUp,
    PageDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deletion {
    /// Backspace: one cluster, or one atomic range.
    Backward,
    /// Delete: one cluster, or one atomic range.
    Forward,
    WordBackward,
    WordForward,
    ToLineStart,
    ToLineEnd,
}

/// What to do to line breaks in pasted text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Newlines {
    Keep,
    /// Convert every line break to the document's own (LF or CRLF).
    ToDocument,
    /// Replace every line break with one space (for single-line inputs).
    ToSpace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasteOptions {
    pub max_bytes: usize,
    pub newlines: Newlines,
}

impl PasteOptions {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            newlines: Newlines::Keep,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EditError {
    #[error("the session is read-only")]
    ReadOnly,
    #[error("an IME composition is in progress")]
    Composing,
    #[error("line breaks cannot be inserted in a single-line session")]
    SingleLine,
    #[error("pasted text is {bytes} bytes; the limit is {limit}")]
    TooLarge { bytes: usize, limit: usize },
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    #[error(
        "revision {got} skips ahead of the expected {expected}; apply the missing changes first"
    )]
    RevisionGap { expected: Revision, got: Revision },
    #[error("revision {got} is not newer than the accepted {accepted}")]
    StaleRevision { accepted: Revision, got: Revision },
    #[error("no pending operation {0}")]
    UnknownOperation(OpId),
    #[error("the change does not fit the text: {0}")]
    BadChange(#[from] ChangeError),
    #[error("there is no conflict to resolve")]
    NoConflict,
    #[error("the pending chain no longer fits the text")]
    Inconsistent,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AtomicError {
    #[error("the range is empty or past the end of the text")]
    BadRange,
    #[error("the range overlaps another atomic range")]
    Overlaps,
}

/// What a remote change did besides changing the text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteApplied {
    /// Atomic ranges whose text the change edited; they are no longer marked.
    pub dissolved_atomics: Vec<AtomicId>,
}

/// Where the viewport sits: the first visible row (a line and a row within
/// it) and the horizontal offset in cells when not wrapping.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scroll {
    pub top_line: usize,
    pub top_row: usize,
    pub left_cell: usize,
}

/// Cursor, selection and scroll, apart from the text, for panel persistence
/// and draft checkpoints. Restoring clamps to the text and snaps to boundaries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewSnapshot {
    pub anchor: usize,
    pub head: usize,
    pub scroll: Scroll,
}

/// The text as drawn: with the preedit spliced in during a composition.
pub struct Display {
    pub rope: Rope,
    /// The preedit text's range in `rope`, when there is one.
    pub preedit: Option<(usize, usize)>,
    /// Where the caret is drawn, in `rope`.
    pub caret: usize,
    /// The range of the session's text the preedit stands in for.
    replaced: Option<(usize, usize)>,
}

impl Display {
    /// Carry an offset in the session's text over to `rope`.
    pub fn map(&self, pos: usize) -> usize {
        match (self.preedit, self.replaced) {
            (Some((start, new_end)), Some((_, old_end))) => {
                if pos <= start {
                    pos
                } else if pos >= old_end {
                    pos + (new_end - start) - (old_end - start)
                } else {
                    start
                }
            }
            _ => pos,
        }
    }
}

#[derive(Clone, Debug)]
struct PendingOp {
    id: OpId,
    op: OperationSeq,
    state: PendingState,
}

#[derive(Clone, Debug)]
struct Composition {
    start: usize,
    end: usize,
    preedit: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct Viewport {
    width: usize,
    height: usize,
}

enum Record {
    Edit(EditShape),
    Undo,
    Redo,
}

pub struct EditSession {
    local: Rope,
    accepted: Rope,
    accepted_revision: Revision,
    pending: Vec<PendingOp>,
    conflict_reason: Option<String>,
    anchor: usize,
    head: usize,
    goal_cell: Option<usize>,
    history: History,
    atomics: Vec<AtomicRange>,
    next_atomic: u32,
    composition: Option<Composition>,
    config: SessionConfig,
    eol: &'static str,
    viewport: Viewport,
    scroll: Scroll,
    next_op: u64,
}

impl EditSession {
    /// A session over `text` as the owner has it at `revision`. The cursor starts at 0.
    pub fn new(text: &str, revision: Revision, config: SessionConfig) -> Self {
        let crlf = text.matches("\r\n").count();
        let lf = text.matches('\n').count() - crlf;
        let rope = Rope::from_str(text);
        Self {
            accepted: rope.clone(),
            local: rope,
            accepted_revision: revision,
            pending: Vec::new(),
            conflict_reason: None,
            anchor: 0,
            head: 0,
            goal_cell: None,
            history: History::default(),
            atomics: Vec::new(),
            next_atomic: 0,
            composition: None,
            config,
            eol: if crlf > lf { "\r\n" } else { "\n" },
            viewport: Viewport::default(),
            scroll: Scroll::default(),
            next_op: 0,
        }
    }

    // ---- reading ----

    pub fn text(&self) -> String {
        self.local.to_string()
    }

    pub fn rope(&self) -> &Rope {
        &self.local
    }

    /// Length in scalars.
    pub fn len(&self) -> usize {
        self.local.len_chars()
    }

    pub fn is_empty(&self) -> bool {
        self.local.len_chars() == 0
    }

    /// The owner's text at [`accepted_revision`](Self::accepted_revision).
    pub fn accepted_text(&self) -> String {
        self.accepted.to_string()
    }

    pub fn accepted_revision(&self) -> Revision {
        self.accepted_revision
    }

    pub fn coords(&self) -> Coords<'_> {
        Coords::new(&self.local)
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    pub fn set_read_only(&mut self, read_only: bool) {
        self.config.read_only = read_only;
    }

    pub fn set_wrap(&mut self, wrap: bool) {
        self.config.wrap = wrap;
    }

    pub fn set_tab_width(&mut self, tab_width: usize) {
        self.config.tab_width = tab_width.max(1);
    }

    /// The document's own line break, found when the session was made.
    pub fn line_ending(&self) -> &'static str {
        self.eol
    }

    pub fn cursor(&self) -> usize {
        self.head
    }

    pub fn cursor_utf16(&self) -> usize {
        self.coords()
            .from_scalar(self.head, Unit::Utf16)
            .unwrap_or(0)
    }

    pub fn anchor(&self) -> usize {
        self.anchor
    }

    /// The selected range, start before end, when there is one.
    pub fn selection(&self) -> Option<(usize, usize)> {
        (self.anchor != self.head).then(|| (self.anchor.min(self.head), self.anchor.max(self.head)))
    }

    pub fn selected_text(&self) -> Option<String> {
        self.selection()
            .map(|(s, e)| self.local.slice(s..e).to_string())
    }

    pub fn atomics(&self) -> &[AtomicRange] {
        &self.atomics
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    // ---- cursor and selection ----

    /// Set the selection. Positions clamp to the text, snap to cluster
    /// boundaries and move out of atomic ranges (the selection grows to cover them).
    pub fn set_selection(&mut self, anchor: usize, head: usize) {
        if self.composition.is_some() {
            return;
        }
        let (lo, hi) = (anchor.min(head), anchor.max(head));
        let (lo, hi) =
            self.expand_atomic(self.fix(lo, Snap::Backward), self.fix(hi, Snap::Forward));
        if lo == hi {
            let p = self.fix(head, Snap::Forward);
            (self.anchor, self.head) = (p, p);
        } else if anchor <= head {
            (self.anchor, self.head) = (lo, hi);
        } else {
            (self.anchor, self.head) = (hi, lo);
        }
        self.goal_cell = None;
        self.history.close_group();
    }

    pub fn select_all(&mut self) {
        self.set_selection(0, self.len());
    }

    /// Move the cursor, keeping the anchor when `extend` is set. Returns
    /// whether the cursor or selection changed. Ignored during a composition.
    pub fn move_cursor(&mut self, motion: Motion, extend: bool) -> bool {
        if self.composition.is_some() {
            return false;
        }
        let before = (self.anchor, self.head);
        if !extend
            && let Some((s, e)) = self.selection()
            && matches!(motion, Motion::Left | Motion::Right)
        {
            let p = if motion == Motion::Left { s } else { e };
            (self.anchor, self.head) = (p, p);
            self.goal_cell = None;
            return before != (self.anchor, self.head);
        }
        let single = self.config.single_line;
        let target = match motion {
            Motion::Left => self.atomic_snap(self.coords().prev_grapheme(self.head), false),
            Motion::Right => self.atomic_snap(self.coords().next_grapheme(self.head), true),
            Motion::Up if single => 0,
            Motion::Down if single => self.len(),
            Motion::Up => self.vertical(-1),
            Motion::Down => self.vertical(1),
            Motion::PageUp | Motion::PageDown => {
                let rows = self.viewport.height.saturating_sub(1).max(1);
                let dir = if motion == Motion::PageUp { -1 } else { 1 };
                let saved = self.head;
                let mut at = saved;
                for _ in 0..rows {
                    self.head = at;
                    let next = if single {
                        if dir < 0 { 0 } else { self.len() }
                    } else {
                        self.vertical(dir)
                    };
                    if next == at {
                        break;
                    }
                    at = next;
                }
                self.head = saved;
                at
            }
            Motion::WordLeft => self.atomic_snap(word_left(&self.local, self.head), false),
            Motion::WordRight => self.atomic_snap(word_right(&self.local, self.head), true),
            Motion::LineStart => self.line_edge(false),
            Motion::LineEnd => self.line_edge(true),
            Motion::DocStart => 0,
            Motion::DocEnd => self.len(),
        };
        if !matches!(
            motion,
            Motion::Up | Motion::Down | Motion::PageUp | Motion::PageDown
        ) {
            self.goal_cell = None;
        }
        self.head = target;
        if !extend {
            self.anchor = target;
        } else {
            let (lo, hi) =
                self.expand_atomic(self.anchor.min(self.head), self.anchor.max(self.head));
            if self.anchor <= self.head {
                (self.anchor, self.head) = (lo, hi);
            } else {
                (self.anchor, self.head) = (hi, lo);
            }
        }
        self.history.close_group();
        before != (self.anchor, self.head)
    }

    // ---- local editing ----

    /// Insert typed or committed text at the cursor, replacing the selection.
    pub fn insert_text(&mut self, text: &str) -> Result<Option<LocalEdit>, EditError> {
        self.guard_edit()?;
        let (s, e) = self.selection().unwrap_or((self.head, self.head));
        let kind = if s == e { Kind::Insert } else { Kind::Other };
        self.edit_range(s, e, text, kind)
    }

    /// Insert the document's line break. Refused in single-line mode.
    pub fn insert_newline(&mut self) -> Result<Option<LocalEdit>, EditError> {
        let eol = self.eol;
        self.insert_text(eol)
    }

    /// Insert pasted text, converting line breaks as asked and refusing text over the size bound.
    pub fn paste(
        &mut self,
        text: &str,
        options: &PasteOptions,
    ) -> Result<Option<LocalEdit>, EditError> {
        self.guard_edit()?;
        if text.len() > options.max_bytes {
            return Err(EditError::TooLarge {
                bytes: text.len(),
                limit: options.max_bytes,
            });
        }
        let text = match options.newlines {
            Newlines::Keep => text.to_string(),
            Newlines::ToDocument => convert_newlines(text, self.eol),
            Newlines::ToSpace => convert_newlines(text, " "),
        };
        let (s, e) = self.selection().unwrap_or((self.head, self.head));
        self.edit_range(s, e, &text, Kind::Other)
    }

    /// Delete by `deletion`. A selection is deleted whole whatever the kind.
    pub fn delete(&mut self, deletion: Deletion) -> Result<Option<LocalEdit>, EditError> {
        self.guard_edit()?;
        if let Some((s, e)) = self.selection() {
            return self.edit_range(s, e, "", Kind::Other);
        }
        let head = self.head;
        let coords = self.coords();
        let (line_start, line_end) = coords.line_range(coords.line_of(head)).unwrap_or((0, 0));
        let (start, end, kind) = match deletion {
            Deletion::Backward => (
                self.atomic_snap(coords.prev_grapheme(head), false),
                head,
                Kind::Backspace,
            ),
            Deletion::Forward => (
                head,
                self.atomic_snap(coords.next_grapheme(head), true),
                Kind::DeleteForward,
            ),
            Deletion::WordBackward => (
                self.atomic_snap(word_left(&self.local, head), false),
                head,
                Kind::Other,
            ),
            Deletion::WordForward => (
                head,
                self.atomic_snap(word_right(&self.local, head), true),
                Kind::Other,
            ),
            Deletion::ToLineStart if head == line_start => {
                (coords.prev_grapheme(head), head, Kind::Other)
            }
            Deletion::ToLineStart => (line_start, head, Kind::Other),
            Deletion::ToLineEnd if head == line_end => {
                (head, coords.next_grapheme(head), Kind::Other)
            }
            Deletion::ToLineEnd => (head, line_end, Kind::Other),
        };
        self.edit_range(start, end, "", kind)
    }

    /// The selected text and the edit that removes it.
    pub fn cut(&mut self) -> Result<Option<(String, LocalEdit)>, EditError> {
        self.guard_edit()?;
        let Some(text) = self.selected_text() else {
            return Ok(None);
        };
        let (s, e) = self.selection().expect("selection exists");
        Ok(self
            .edit_range(s, e, "", Kind::Other)?
            .map(|edit| (text, edit)))
    }

    /// Replace the whole text as one edit (restoring a draft onto a fresh session).
    pub fn replace_all(&mut self, text: &str) -> Result<Option<LocalEdit>, EditError> {
        self.guard_edit()?;
        let end = self.len();
        self.edit_range(0, end, text, Kind::Other)
    }

    pub fn undo(&mut self) -> Result<Option<LocalEdit>, EditError> {
        self.guard_edit()?;
        let Some(entry) = self.history.pop_undo() else {
            return Ok(None);
        };
        let at = op_end(&entry.op);
        let edit = self.commit(entry.op, Record::Undo);
        self.restore_atomics(&entry.marks);
        self.place_cursor(at);
        Ok(Some(edit))
    }

    pub fn redo(&mut self) -> Result<Option<LocalEdit>, EditError> {
        self.guard_edit()?;
        let Some(entry) = self.history.pop_redo() else {
            return Ok(None);
        };
        let at = op_end(&entry.op);
        let edit = self.commit(entry.op, Record::Redo);
        self.restore_atomics(&entry.marks);
        self.place_cursor(at);
        Ok(Some(edit))
    }

    /// End the current typing group so the next edit is its own undo step
    /// (call after an idle pause).
    pub fn break_undo_group(&mut self) {
        self.history.close_group();
    }

    // ---- atomic ranges ----

    /// Mark `[start, end)` atomic. The ends snap outward to cluster boundaries.
    pub fn mark_atomic(&mut self, start: usize, end: usize) -> Result<AtomicId, AtomicError> {
        if start >= end || end > self.len() {
            return Err(AtomicError::BadRange);
        }
        let c = Coords::new(&self.local);
        let (start, end) = (
            c.snap_grapheme(start, Snap::Backward),
            c.snap_grapheme(end, Snap::Forward),
        );
        if self.atomics.iter().any(|a| start < a.end && a.start < end) {
            return Err(AtomicError::Overlaps);
        }
        let id = AtomicId(self.next_atomic);
        self.next_atomic += 1;
        self.atomics.push(AtomicRange { id, start, end });
        // A selection end that now sits inside the new range moves out of it.
        let (a, h) = (self.anchor, self.head);
        self.anchor = self.atomic_snap(a, a > h);
        self.head = self.atomic_snap(h, h >= a);
        Ok(id)
    }

    pub fn unmark_atomic(&mut self, id: AtomicId) -> bool {
        let before = self.atomics.len();
        self.atomics.retain(|a| a.id != id);
        before != self.atomics.len()
    }

    // ---- IME composition ----

    /// Begin a composition at the cursor (or over the selection). Nothing
    /// enters the document or the undo history until [`composition_end`](Self::composition_end).
    pub fn composition_start(&mut self) -> Result<(), EditError> {
        if self.config.read_only {
            return Err(EditError::ReadOnly);
        }
        let (s, e) = self.selection().unwrap_or((self.head, self.head));
        self.composition = Some(Composition {
            start: s,
            end: e,
            preedit: String::new(),
        });
        self.history.close_group();
        Ok(())
    }

    /// Replace the preedit text. False when no composition is open.
    pub fn composition_update(&mut self, preedit: &str) -> bool {
        match &mut self.composition {
            Some(c) => {
                c.preedit = preedit.to_string();
                true
            }
            None => false,
        }
    }

    /// Finish the composition and commit `text` (empty cancels) as one edit.
    pub fn composition_end(&mut self, text: &str) -> Result<Option<LocalEdit>, EditError> {
        let Some(c) = self.composition.take() else {
            return Ok(None);
        };
        if text.is_empty() {
            return Ok(None);
        }
        let kind = if c.start == c.end {
            Kind::Insert
        } else {
            Kind::Other
        };
        self.edit_range(c.start, c.end, text, kind)
    }

    pub fn is_composing(&self) -> bool {
        self.composition.is_some()
    }

    /// The text as drawn, with the preedit in place during a composition.
    pub fn display(&self) -> Display {
        match &self.composition {
            Some(c) if !c.preedit.is_empty() => {
                let mut rope = self.local.clone();
                rope.remove(c.start..c.end);
                rope.insert(c.start, &c.preedit);
                let end = c.start + c.preedit.chars().count();
                Display {
                    rope,
                    preedit: Some((c.start, end)),
                    caret: end,
                    replaced: Some((c.start, c.end)),
                }
            }
            _ => Display {
                rope: self.local.clone(),
                preedit: None,
                caret: self.head,
                replaced: None,
            },
        }
    }

    // ---- the owner ----

    /// True when there are edits the owner has not accepted.
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Every pending edit in order, as it stands now.
    pub fn pending(&self) -> Vec<PendingEdit> {
        let mut rope = self.accepted.clone();
        let mut out = Vec::with_capacity(self.pending.len());
        for p in &self.pending {
            out.push(PendingEdit {
                op_id: p.id.clone(),
                state: p.state,
                changes: op_to_text_changes(&rope, &p.op),
                wire: op_to_scalar_changes(&p.op),
            });
            let _ = apply_op(&mut rope, &p.op);
        }
        out
    }

    /// The next edit to send, if none is in flight and none is held by a
    /// conflict. It is marked sent. Its changes apply to the accepted text at
    /// `base_revision`. Call after every local edit and every acknowledgement.
    pub fn take_next_to_send(&mut self) -> Option<LocalEdit> {
        if self.pending.iter().any(|p| p.state == PendingState::Sent) {
            return None;
        }
        let head = self.pending.first_mut()?;
        if head.state != PendingState::Queued {
            return None;
        }
        head.state = PendingState::Sent;
        Some(LocalEdit {
            op_id: head.id.clone(),
            base_revision: self.accepted_revision,
            changes: op_to_text_changes(&self.accepted, &head.op),
            wire: op_to_scalar_changes(&head.op),
        })
    }

    /// Mark a sent edit as not sent (the request failed or its outcome is
    /// unknown) so [`take_next_to_send`](Self::take_next_to_send) returns it
    /// again under the same id.
    pub fn requeue(&mut self, op_id: &OpId) -> Result<(), SyncError> {
        let p = self
            .pending
            .iter_mut()
            .find(|p| &p.id == op_id)
            .ok_or_else(|| SyncError::UnknownOperation(op_id.clone()))?;
        if p.state == PendingState::Sent {
            p.state = PendingState::Queued;
        }
        Ok(())
    }

    /// Apply a change from the owner (UTF-16, against the owner's text at
    /// `revision - 1`). Events must arrive in revision order; a gap is an error
    /// and changes nothing.
    pub fn apply_remote(
        &mut self,
        changes: &[TextChange],
        revision: Revision,
    ) -> Result<RemoteApplied, SyncError> {
        self.check_next(revision)?;
        let op = op_from_changes(
            &self.accepted,
            changes.iter().map(|c| (c.start, c.end, c.insert.clone())),
            Unit::Utf16,
        )?;
        self.integrate_remote(op, revision)
    }

    /// [`apply_remote`](Self::apply_remote) for the wire form, in scalars.
    pub fn apply_remote_scalars(
        &mut self,
        changes: &[ScalarChange],
        revision: Revision,
    ) -> Result<RemoteApplied, SyncError> {
        self.check_next(revision)?;
        let op = op_from_changes(
            &self.accepted,
            changes.iter().map(|c| (c.start, c.end, c.insert.clone())),
            Unit::Scalar,
        )?;
        self.integrate_remote(op, revision)
    }

    /// The owner accepted `op_id` as `revision`. Everything up to and
    /// including it becomes accepted text.
    pub fn acknowledge(&mut self, op_id: &OpId, revision: Revision) -> Result<(), SyncError> {
        let idx = self.index_of(op_id)?;
        if idx == 0 {
            self.check_next(revision)?;
        } else if revision <= self.accepted_revision {
            return Err(SyncError::StaleRevision {
                accepted: self.accepted_revision,
                got: revision,
            });
        }
        let mut accepted = self.accepted.clone();
        for p in &self.pending[..=idx] {
            apply_op(&mut accepted, &p.op)?;
        }
        self.pending.drain(..=idx);
        self.accepted = accepted;
        self.accepted_revision = revision;
        if !self.has_conflict() {
            self.conflict_reason = None;
        }
        Ok(())
    }

    /// The owner refused `op_id`. The edit and every later one stay in the
    /// text, marked conflicting and held back from sending.
    pub fn refuse(&mut self, op_id: &OpId, reason: impl Into<String>) -> Result<(), SyncError> {
        let idx = self.index_of(op_id)?;
        for p in &mut self.pending[idx..] {
            p.state = PendingState::Conflicting;
        }
        self.conflict_reason.get_or_insert_with(|| reason.into());
        Ok(())
    }

    pub fn has_conflict(&self) -> bool {
        self.pending
            .iter()
            .any(|p| p.state == PendingState::Conflicting)
    }

    /// The held text, when there is a conflict.
    pub fn conflict(&self) -> Option<Conflict> {
        let first = self
            .pending
            .iter()
            .position(|p| p.state == PendingState::Conflicting)?;
        let mut composed: Option<OperationSeq> = None;
        for p in &self.pending[first..] {
            composed = Some(match composed {
                None => p.op.clone(),
                Some(c) => c.compose(&p.op).unwrap_or(c),
            });
        }
        Some(Conflict {
            reason: self.conflict_reason.clone().unwrap_or_default(),
            op_ids: self.pending[first..].iter().map(|p| p.id.clone()).collect(),
            ranges: composed.map(|c| inserted_ranges(&c)).unwrap_or_default(),
        })
    }

    /// Resolve the conflict. `TakeTheirs` returns the text that was dropped
    /// (the whole former document) so the caller can keep a copy.
    pub fn resolve_conflict(&mut self, how: Resolution) -> Result<Option<String>, SyncError> {
        let first = self
            .pending
            .iter()
            .position(|p| p.state == PendingState::Conflicting)
            .ok_or(SyncError::NoConflict)?;
        self.conflict_reason = None;
        match how {
            Resolution::KeepMine => {
                let tail: Vec<PendingOp> = self.pending.split_off(first);
                let mut composed = tail[0].op.clone();
                for p in &tail[1..] {
                    composed = composed
                        .compose(&p.op)
                        .map_err(|_| SyncError::Inconsistent)?;
                }
                if !composed.is_noop() {
                    let id = self.new_op_id();
                    self.pending.push(PendingOp {
                        id,
                        op: composed,
                        state: PendingState::Queued,
                    });
                }
                Ok(None)
            }
            Resolution::TakeTheirs => {
                let discarded = self.local.to_string();
                let base = self.base_before(first)?;
                self.pending.truncate(first);
                self.replace_local(base, None);
                Ok(Some(discarded))
            }
            Resolution::KeepBoth => {
                let base = self.base_before(first)?;
                let mine = self.local.clone();
                self.pending.truncate(first);
                let changed = op_scalar_edits(&diff_op(&base, &mine));
                let Some((start, end, inserted)) = changed.into_iter().next() else {
                    self.replace_local(base, None);
                    return Ok(None);
                };
                // Keep what the owner has in [start, end) and put the user's text right after it.
                let mut op = OperationSeq::default();
                op.retain(end as u64);
                op.insert(&inserted);
                op.retain((base.len_chars() - end) as u64);
                let mut merged = base.clone();
                apply_op(&mut merged, &op)?;
                let at = end + inserted.chars().count();
                let _ = start;
                self.replace_local(merged, Some(at));
                let id = self.new_op_id();
                self.pending.push(PendingOp {
                    id,
                    op,
                    state: PendingState::Queued,
                });
                Ok(None)
            }
        }
    }

    // ---- view state ----

    pub fn scroll(&self) -> Scroll {
        self.scroll
    }

    pub fn set_scroll(&mut self, scroll: Scroll) {
        self.scroll = scroll;
    }

    /// The viewport size in cells, used for soft wrap and page motions.
    /// The renderer sets this every frame.
    pub fn set_viewport(&mut self, width: usize, height: usize) {
        self.viewport = Viewport { width, height };
    }

    pub fn viewport(&self) -> (usize, usize) {
        (self.viewport.width, self.viewport.height)
    }

    /// Width to wrap at, or 0 when not wrapping.
    pub fn wrap_width(&self) -> usize {
        if self.config.wrap {
            self.viewport.width
        } else {
            0
        }
    }

    pub fn view_snapshot(&self) -> ViewSnapshot {
        ViewSnapshot {
            anchor: self.anchor,
            head: self.head,
            scroll: self.scroll,
        }
    }

    pub fn restore_view(&mut self, snapshot: &ViewSnapshot) {
        self.composition = None;
        self.set_selection(snapshot.anchor, snapshot.head);
        self.scroll = snapshot.scroll;
    }

    /// A description of the first broken internal invariant, for tests.
    #[doc(hidden)]
    pub fn invariant_violation(&self) -> Option<String> {
        let mut rebuilt = self.accepted.clone();
        for p in &self.pending {
            if apply_op(&mut rebuilt, &p.op).is_err() {
                return Some("pending chain does not apply to the accepted text".into());
            }
        }
        if rebuilt != self.local {
            return Some("local text differs from accepted text plus pending edits".into());
        }
        let c = self.coords();
        for (name, p) in [("anchor", self.anchor), ("head", self.head)] {
            if p > self.len() || !c.is_grapheme_boundary(p) {
                return Some(format!("{name} {p} is out of range or inside a cluster"));
            }
            if self.atomics.iter().any(|a| p > a.start && p < a.end) {
                return Some(format!("{name} {p} is inside an atomic range"));
            }
        }
        for a in &self.atomics {
            if a.start >= a.end || a.end > self.len() {
                return Some(format!("atomic range {a:?} is invalid"));
            }
        }
        None
    }

    // ---- internals ----

    fn guard_edit(&self) -> Result<(), EditError> {
        if self.config.read_only {
            return Err(EditError::ReadOnly);
        }
        if self.composition.is_some() {
            return Err(EditError::Composing);
        }
        Ok(())
    }

    fn new_op_id(&mut self) -> OpId {
        self.next_op += 1;
        OpId(format!("{}-{}", self.config.client_id, self.next_op))
    }

    fn index_of(&self, op_id: &OpId) -> Result<usize, SyncError> {
        self.pending
            .iter()
            .position(|p| &p.id == op_id)
            .ok_or_else(|| SyncError::UnknownOperation(op_id.clone()))
    }

    fn check_next(&self, revision: Revision) -> Result<(), SyncError> {
        let expected = self.accepted_revision + 1;
        if revision < expected {
            Err(SyncError::StaleRevision {
                accepted: self.accepted_revision,
                got: revision,
            })
        } else if revision > expected {
            Err(SyncError::RevisionGap {
                expected,
                got: revision,
            })
        } else {
            Ok(())
        }
    }

    /// The text after the first `count` pending operations.
    fn base_before(&self, count: usize) -> Result<Rope, SyncError> {
        let mut rope = self.accepted.clone();
        for p in &self.pending[..count] {
            apply_op(&mut rope, &p.op)?;
        }
        Ok(rope)
    }

    fn integrate_remote(
        &mut self,
        op: OperationSeq,
        revision: Revision,
    ) -> Result<RemoteApplied, SyncError> {
        let mut accepted = self.accepted.clone();
        apply_op(&mut accepted, &op)?;
        let mut carried = op;
        let mut chain = Vec::with_capacity(self.pending.len());
        for p in &self.pending {
            let (after_p, p_after) = carried
                .transform(&p.op)
                .map_err(|_| SyncError::Inconsistent)?;
            chain.push(p_after);
            carried = after_p;
        }
        for (p, op) in self.pending.iter_mut().zip(chain) {
            p.op = op;
        }
        self.accepted = accepted;
        self.accepted_revision = revision;
        let dissolved = self.adopt(&carried);
        self.history.transform_past(&carried);
        Ok(RemoteApplied {
            dissolved_atomics: dissolved,
        })
    }

    /// Apply a change that did not come from the user's own editing to the
    /// local text, carrying cursor, selection, atomic ranges and the
    /// composition across it.
    fn adopt(&mut self, op: &OperationSeq) -> Vec<AtomicId> {
        let (lo, hi) = (self.anchor.min(self.head), self.anchor.max(self.head));
        let (nlo, nhi) = if lo == hi {
            let p = map_pos(op, lo, Bias::Before);
            (p, p)
        } else {
            (map_pos(op, lo, Bias::After), map_pos(op, hi, Bias::Before))
        };
        if self.anchor <= self.head {
            (self.anchor, self.head) = (nlo, nhi);
        } else {
            (self.anchor, self.head) = (nhi, nlo);
        }
        let dissolved = self.carry_marks(op).iter().map(|a| a.id).collect();
        let applied = apply_op(&mut self.local, op);
        debug_assert!(applied.is_ok(), "operation built against another text");
        self.goal_cell = None;
        self.normalize();
        dissolved
    }

    /// Carry atomic ranges and the composition across `op`.
    /// The atomic ranges `op` edited inside come back, as they lay before it.
    fn carry_marks(&mut self, op: &OperationSeq) -> Vec<AtomicRange> {
        let mut dissolved = Vec::new();
        self.atomics.retain_mut(|a| {
            if touches_interior(op, a.start, a.end) {
                dissolved.push(*a);
                false
            } else {
                a.start = map_pos(op, a.start, Bias::After);
                a.end = map_pos(op, a.end, Bias::Before);
                true
            }
        });
        if let Some(c) = &mut self.composition {
            let collapsed = c.start == c.end;
            c.start = map_pos(op, c.start, Bias::After);
            c.end = if collapsed {
                c.start
            } else {
                map_pos(op, c.end, Bias::Before).max(c.start)
            };
        }
        dissolved
    }

    /// Put back atomic ranges an undo or redo gave the text of, with the ids
    /// they had. One that would overlap a live range, or whose id is live, is
    /// left out.
    fn restore_atomics(&mut self, marks: &[AtomicRange]) {
        for m in marks {
            let fits = m.start < m.end
                && m.end <= self.len()
                && !self
                    .atomics
                    .iter()
                    .any(|a| a.id == m.id || (m.start < a.end && a.start < m.end));
            if fits {
                self.atomics.push(*m);
            }
        }
    }

    /// Replace the local text with `new`, carrying the view across the
    /// difference and starting the undo history over.
    fn replace_local(&mut self, new: Rope, cursor: Option<usize>) {
        let d = diff_op(&self.local, &new);
        self.adopt(&d);
        debug_assert_eq!(self.local.to_string(), new.to_string());
        self.history.clear();
        if let Some(at) = cursor {
            self.place_cursor(at);
        }
    }

    fn place_cursor(&mut self, at: usize) {
        let p = self.fix(at, Snap::Forward);
        (self.anchor, self.head) = (p, p);
        self.goal_cell = None;
    }

    /// Clamp the cursor and anchor to the text and put them on cluster boundaries.
    fn normalize(&mut self) {
        self.anchor = self.fix(self.anchor, Snap::Forward);
        self.head = self.fix(self.head, Snap::Forward);
    }

    /// `pos` clamped, on a cluster boundary, and outside any atomic range.
    fn fix(&self, pos: usize, snap: Snap) -> usize {
        let p = Coords::new(&self.local).snap_grapheme(pos.min(self.len()), snap);
        self.atomic_snap(p, snap != Snap::Backward)
    }

    /// Move `pos` out of the inside of an atomic range, forward to its end or backward to its start.
    fn atomic_snap(&self, pos: usize, forward: bool) -> usize {
        match self.atomics.iter().find(|a| pos > a.start && pos < a.end) {
            Some(a) if forward => a.end,
            Some(a) => a.start,
            None => pos,
        }
    }

    /// Widen `[start, end)` so neither end is inside an atomic range.
    fn expand_atomic(&self, start: usize, end: usize) -> (usize, usize) {
        (self.atomic_snap(start, false), self.atomic_snap(end, true))
    }

    fn line_edge(&self, end: bool) -> usize {
        let c = self.coords();
        let (s, e) = c.line_range(c.line_of(self.head)).unwrap_or((0, 0));
        self.atomic_snap(if end { e } else { s }, end)
    }

    /// The cursor position one visual row up (`-1`) or down (`1`), at the remembered column.
    fn vertical(&mut self, dir: i32) -> usize {
        let (tab, width) = (self.config.tab_width, self.wrap_width());
        let coords = Coords::new(&self.local);
        let line = coords.line_of(self.head);
        let rows = line_rows(&self.local, line, width, tab);
        let idx = row_index(&rows, self.head);
        let row = rows[idx];
        let goal = *self
            .goal_cell
            .get_or_insert_with(|| coords.cells_between(row.start, self.head, tab));
        let target = if dir < 0 {
            if idx > 0 {
                rows[idx - 1]
            } else if line > 0 {
                *line_rows(&self.local, line - 1, width, tab)
                    .last()
                    .expect("a line has a row")
            } else {
                return 0;
            }
        } else if idx + 1 < rows.len() {
            rows[idx + 1]
        } else if line + 1 < coords.line_count() {
            line_rows(&self.local, line + 1, width, tab)[0]
        } else {
            return self.local.len_chars();
        };
        let mut at = coords.offset_at_cell(target.start, target.end, goal, tab, Snap::Backward);
        if !target.last && at >= target.end {
            at = coords.prev_grapheme(target.end).max(target.start);
        }
        self.atomic_snap(at, false)
    }

    /// Replace `[start, end)` with `text` as one local edit.
    fn edit_range(
        &mut self,
        start: usize,
        end: usize,
        text: &str,
        kind: Kind,
    ) -> Result<Option<LocalEdit>, EditError> {
        let (start, end) = self.expand_atomic(start.min(self.len()), end.min(self.len()));
        if start == end && text.is_empty() {
            return Ok(None);
        }
        if self.config.single_line && text.contains(['\n', '\r']) {
            return Err(EditError::SingleLine);
        }
        let mut op = OperationSeq::default();
        op.retain(start as u64);
        op.delete((end - start) as u64);
        op.insert(text);
        op.retain((self.len() - end) as u64);
        let inserted = text.chars().count();
        let shape = EditShape {
            kind,
            start,
            end,
            inserted,
            class: class_of(text),
            has_newline: text.contains(['\n', '\r']),
        };
        let edit = self.commit(op, Record::Edit(shape));
        self.place_cursor(start + inserted);
        Ok(Some(edit))
    }

    /// Apply a local operation: text, marks, history, and the pending chain.
    fn commit(&mut self, op: OperationSeq, record: Record) -> LocalEdit {
        let changes = op_to_text_changes(&self.local, &op);
        let wire = op_to_scalar_changes(&op);
        let inverse = invert_op(&op, &self.local);
        let applied = apply_op(&mut self.local, &op);
        debug_assert!(applied.is_ok(), "operation built against another text");
        let dissolved = self.carry_marks(&op);
        match record {
            Record::Edit(shape) => self.history.record(inverse, dissolved, shape),
            Record::Undo => self.history.push_redo(inverse, dissolved),
            Record::Redo => self.history.push_undo(inverse, dissolved),
        }
        let id = self.new_op_id();
        let state = if self.has_conflict() {
            PendingState::Conflicting
        } else {
            PendingState::Queued
        };
        self.pending.push(PendingOp {
            id: id.clone(),
            op,
            state,
        });
        self.goal_cell = None;
        LocalEdit {
            op_id: id,
            base_revision: self.accepted_revision,
            changes,
            wire,
        }
    }
}

/// Where the cursor belongs after `op`: the end of its last change, in the text it produces.
fn op_end(op: &OperationSeq) -> usize {
    let (mut at, mut end) = (0usize, 0usize);
    for comp in op.ops() {
        match comp {
            Operation::Retain(n) => at += *n as usize,
            Operation::Insert(s) => {
                at += s.chars().count();
                end = at;
            }
            Operation::Delete(_) => end = at,
        }
    }
    end
}

/// The ranges of inserted text in the text `op` produces; a pure deletion is an empty range.
fn inserted_ranges(op: &OperationSeq) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut at = 0usize;
    let mut touching = false;
    for comp in op.ops() {
        match comp {
            Operation::Retain(n) => {
                at += *n as usize;
                touching = false;
            }
            Operation::Insert(s) => {
                let n = s.chars().count();
                if touching {
                    out.last_mut().expect("range open").1 = at + n;
                } else {
                    out.push((at, at + n));
                    touching = true;
                }
                at += n;
            }
            Operation::Delete(_) => {
                if !touching {
                    out.push((at, at));
                    touching = true;
                }
            }
        }
    }
    out
}

fn convert_newlines(text: &str, to: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str(to);
            }
            '\n' => out.push_str(to),
            c => out.push(c),
        }
    }
    out
}

/// Start of the previous word on the line; at a line start, the end of the line before.
fn word_left(rope: &Rope, pos: usize) -> usize {
    let c = Coords::new(rope);
    let (start, _) = c.line_range(c.line_of(pos)).unwrap_or((0, 0));
    if pos <= start {
        return c.prev_grapheme(pos);
    }
    let text = rope.slice(start..pos).to_string();
    text.split_word_bound_indices()
        .rev()
        .find(|(_, w)| !w.chars().all(char::is_whitespace))
        .map(|(i, _)| start + text[..i].chars().count())
        .unwrap_or(start)
}

/// End of the next word on the line; at a line end, the start of the line after.
fn word_right(rope: &Rope, pos: usize) -> usize {
    let c = Coords::new(rope);
    let (_, end) = c.line_range(c.line_of(pos)).unwrap_or((0, 0));
    if pos >= end {
        return c.next_grapheme(pos);
    }
    let text = rope.slice(pos..end).to_string();
    text.split_word_bound_indices()
        .find(|(_, w)| !w.chars().all(char::is_whitespace))
        .map(|(i, w)| pos + text[..i + w.len()].chars().count())
        .unwrap_or(end)
}
