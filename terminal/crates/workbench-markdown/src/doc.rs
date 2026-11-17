//! The document a panel holds: one text session, a mode, and the block
//! Visual mode has open.
//!
//! Text and revision go in. Local edits come out as UTF-16 [`TextChange`]s for
//! the document owner through [`MarkdownDoc::take_next_to_send`]; the owner's
//! changes come in through [`MarkdownDoc::apply_remote`]. Source mode, Split
//! mode and every command edit the one session. Visual mode edits the open
//! block in a session of its own and writes it back into the document
//! session as one edit, and no change of the document under an open block
//! drops what the user typed in it (see `modes.rs`).

use std::ops::Range;

use serde::{Deserialize, Serialize};
use theorem_workbench_text::{
    EditError, EditSession, LocalEdit, OpId, PendingEdit, RemoteApplied, Resolution, Revision,
    SessionConfig, Snap, SyncError, TextChange, Unit, ViewSnapshot,
};

use crate::document::parse::{Parsed, parsed};
use crate::document::{
    BlockCommand, Edit, EditRefusal, InlineFormat, LARGEST_READ, TableEdit, TableRefusal,
    TargetBlock, block_command, inline_format, table_edit,
};
use crate::draw::Cache;
use crate::modes::{Close, MarkdownMode, OpenBlock, Rebased, changed_region, joint, shifted};

/// A top-level block of the document: where it is in bytes and what it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockInfo {
    /// Bytes of the document, without the block's trailing line breaks.
    pub range: Range<usize>,
    /// What the block is.
    pub kind: TargetBlock,
}

/// Why a command or a write-back did not happen.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CommandError {
    /// The command does not apply here.
    #[error("the command was refused: {0:?}")]
    Refused(EditRefusal),
    /// The table command does not apply here.
    #[error("the table command was refused: {0:?}")]
    Table(TableRefusal),
    /// The text session would not take the edit.
    #[error("the text session refused the edit: {0}")]
    Edit(#[from] EditError),
    /// An edit boundary falls inside a grapheme cluster, which the session does not split.
    #[error("the edit starts or ends inside a grapheme cluster")]
    Cluster,
}

impl From<EditRefusal> for CommandError {
    fn from(why: EditRefusal) -> Self {
        Self::Refused(why)
    }
}

impl From<TableRefusal> for CommandError {
    fn from(why: TableRefusal) -> Self {
        Self::Table(why)
    }
}

/// A command that was applied: the revision it was read at, and the local
/// edit the session queued for the owner (none when it changed nothing).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    /// The accepted revision of the text the command read.
    pub revision: Revision,
    /// The edit queued for the owner.
    pub local: Option<LocalEdit>,
}

/// How closing the open block ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    /// No block was open.
    Nothing,
    /// The block was closed and the document already had its text.
    Unchanged {
        /// The block's bytes in the document.
        range: Range<usize>,
    },
    /// The block was written back as one edit.
    Written {
        /// The bytes of the document that were replaced.
        range: Range<usize>,
        /// Bytes written over them; the donor's `(range, written)`.
        written: usize,
        /// The document had changed under the block, and the change was merged in.
        merged: bool,
        /// The edit queued for the owner.
        local: Option<LocalEdit>,
    },
    /// The document changed where the user typed. Nothing was written; the
    /// block stays open with the user's text until it is resolved.
    Held,
    /// The session would not take the write. The block stays open.
    Failed(EditError),
}

/// The open block's two versions, for the user to choose between.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockConflict {
    /// The block's bytes in the document now.
    pub range: Range<usize>,
    /// The block as it was when it opened.
    pub base: String,
    /// What the user has typed.
    pub mine: String,
    /// What the document has there now.
    pub theirs: String,
}

/// How to settle a held block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockResolution {
    /// Write the user's text over the document's. The replaced text is returned.
    KeepMine,
    /// Close the block and keep the document's text. The user's text is returned.
    TakeTheirs,
    /// Keep the document's text and put the user's text after it as its own block.
    KeepBoth,
}

/// Where the top of a view sits: a block and rows into it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    /// Index of the block at the top.
    pub block: usize,
    /// Rows (lines, in Source) into that block.
    pub row: usize,
}

/// What a panel saves of a document's view and restores into a new
/// [`MarkdownDoc`] over the same text: mode, selection, scroll, and a pending
/// block edit with the text typed in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownViewState {
    pub mode: MarkdownMode,
    pub anchor: Anchor,
    pub selection: ViewSnapshot,
    pub open: Option<OpenState>,
}

impl MarkdownViewState {
    /// The state as JSON text, for a panel to keep.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("plain data serializes")
    }

    /// A state read back from [`Self::to_json`].
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

/// An open block, saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenState {
    pub start: usize,
    pub end: usize,
    pub base: String,
    pub typed: String,
    pub append: bool,
    pub held: bool,
}

/// One markdown document in one panel.
pub struct MarkdownDoc {
    pub(crate) session: EditSession,
    pub(crate) mode: MarkdownMode,
    pub(crate) open: Option<OpenBlock>,
    /// Counts every change of the session's text; caches key on it.
    version: u64,
    read: Option<(u64, Parsed)>,
    pub(crate) anchor: Anchor,
    pub(crate) cache: Cache,
}

impl MarkdownDoc {
    /// A document over `text` as the owner has it at `revision`, in Source mode.
    pub fn new(text: &str, revision: Revision, client_id: impl Into<String>) -> Self {
        let mut config = SessionConfig::new(client_id);
        config.wrap = true;
        Self {
            session: EditSession::new(text, revision, config),
            mode: MarkdownMode::Source,
            open: None,
            version: 0,
            read: None,
            anchor: Anchor::default(),
            cache: Cache::default(),
        }
    }

    // ---- reading ----

    /// The text, with the user's edits the owner has not yet accepted.
    pub fn text(&self) -> String {
        self.session.text()
    }

    /// The owner's revision the session stands on.
    pub fn revision(&self) -> Revision {
        self.session.accepted_revision()
    }

    /// The text session, for reading selection, scroll and history.
    pub fn session(&self) -> &EditSession {
        &self.session
    }

    pub fn mode(&self) -> MarkdownMode {
        self.mode
    }

    /// Whether the text is longer than the largest read: Source alone.
    pub fn too_long(&self) -> bool {
        self.session.rope().len_bytes() > LARGEST_READ
    }

    /// The cursor, in bytes of the text.
    pub fn cursor_byte(&self) -> usize {
        self.byte_of(self.session.cursor())
    }

    pub(crate) fn byte_of(&self, scalar: usize) -> usize {
        self.session
            .coords()
            .from_scalar(scalar, Unit::Utf8)
            .unwrap_or(0)
    }

    pub(crate) fn scalar_of(&self, byte: usize) -> usize {
        scalar_in(&self.session, byte)
    }

    /// The top-level blocks, read once per change of the text.
    pub fn blocks(&mut self) -> Vec<BlockInfo> {
        self.parsed()
            .blocks
            .iter()
            .map(|block| BlockInfo {
                range: block.range.clone(),
                kind: block.kind,
            })
            .collect()
    }

    pub(crate) fn parsed(&mut self) -> &Parsed {
        if self.read.as_ref().is_none_or(|(at, _)| *at != self.version) {
            self.read = Some((self.version, parsed(&self.session.text())));
        }
        &self.read.as_ref().expect("just read").1
    }

    /// The index of the block holding byte `at`, or the last one before it.
    pub fn block_at(&mut self, at: usize) -> Option<usize> {
        let blocks = &self.parsed().blocks;
        let after = blocks.partition_point(|block| block.range.start <= at);
        match (after, blocks.is_empty()) {
            (_, true) => None,
            (0, false) => Some(0),
            (after, false) => Some(after - 1),
        }
    }

    // ---- mode ----

    /// Switch to `mode`. The open block is written back first, as in the
    /// donor, unless it is held; selection, history, scroll anchor and the
    /// pending edit all stay. Visual opens the block at the cursor.
    pub fn set_mode(&mut self, mode: MarkdownMode) -> CommitOutcome {
        if mode == self.mode {
            return CommitOutcome::Nothing;
        }
        let outcome = match self.open {
            Some(_) => self.commit_block(),
            None => CommitOutcome::Nothing,
        };
        if matches!(outcome, CommitOutcome::Failed(_)) {
            return outcome;
        }
        if matches!(self.mode, MarkdownMode::Source | MarkdownMode::Split) {
            self.anchor = self.anchor_from_source();
        }
        self.mode = mode;
        self.session.set_read_only(mode == MarkdownMode::Preview);
        if matches!(mode, MarkdownMode::Source | MarkdownMode::Split) {
            self.scroll_source_to_anchor();
        }
        if mode == MarkdownMode::Visual && self.open.is_none() {
            self.open_at_cursor();
        }
        outcome
    }

    // ---- editing the one session ----

    /// Edit the text session. Everything that changes the text goes through
    /// here (or through a command), so an open block hears of the change.
    /// Preview refuses with `EditError::ReadOnly`.
    pub fn apply_local<R>(&mut self, edit: impl FnOnce(&mut EditSession) -> R) -> R {
        let before = self.open.as_ref().map(|_| self.session.text());
        let out = edit(&mut self.session);
        self.text_changed(before);
        out
    }

    /// Bring in a change from the document owner (UTF-16, against its text at
    /// `revision - 1`).
    pub fn apply_remote(
        &mut self,
        changes: &[TextChange],
        revision: Revision,
    ) -> Result<RemoteApplied, SyncError> {
        let before = self.open.as_ref().map(|_| self.session.text());
        let applied = self.session.apply_remote(changes, revision)?;
        self.text_changed(before);
        Ok(applied)
    }

    /// The next local edit for the owner, as UTF-16 changes against the
    /// accepted text at its `base_revision`.
    pub fn take_next_to_send(&mut self) -> Option<LocalEdit> {
        self.session.take_next_to_send()
    }

    /// The owner accepted `op_id` as `revision`.
    pub fn acknowledge(&mut self, op_id: &OpId, revision: Revision) -> Result<(), SyncError> {
        self.session.acknowledge(op_id, revision)
    }

    /// The owner refused `op_id`; the text stays and is marked conflicting.
    pub fn refuse(&mut self, op_id: &OpId, reason: impl Into<String>) -> Result<(), SyncError> {
        self.session.refuse(op_id, reason)
    }

    /// An edit that was sent and not answered goes out again.
    pub fn requeue(&mut self, op_id: &OpId) -> Result<(), SyncError> {
        self.session.requeue(op_id)
    }

    /// Edits the owner has not accepted.
    pub fn pending(&self) -> Vec<PendingEdit> {
        self.session.pending()
    }

    /// Settle a refusal by the owner.
    pub fn resolve_conflict(&mut self, how: Resolution) -> Result<Option<String>, SyncError> {
        let before = self.open.as_ref().map(|_| self.session.text());
        let dropped = self.session.resolve_conflict(how)?;
        self.text_changed(before);
        Ok(dropped)
    }

    /// The session's text changed. `before` is its text before, kept only
    /// while a block is open.
    fn text_changed(&mut self, before: Option<String>) {
        let moved = match before {
            Some(before) => {
                let after = self.session.text();
                (before != after).then_some((before, after))
            }
            None => None,
        };
        // Every change bumps the version; a read of an unchanged text is cheap enough.
        self.version += 1;
        let Some((before, after)) = moved else {
            return;
        };
        let Some((old, new)) = changed_region(&before, &after) else {
            return;
        };
        let Some(open) = self.open.as_mut() else {
            return;
        };
        if open.rebase(old.start, old.end, &after[new]) == Rebased::Gone {
            self.open = None;
        }
    }

    // ---- commands ----

    /// A command of Typora's Paragraph menu at the caret: in the open block
    /// when one is open, otherwise in the document.
    pub fn block_command(&mut self, command: BlockCommand) -> Result<Applied, CommandError> {
        self.command(|text, revision, selection| block_command(text, revision, selection, command))
    }

    /// An inline format at the selection: in the open block when one is open.
    pub fn inline_format(&mut self, format: InlineFormat) -> Result<Applied, CommandError> {
        self.command(|text, revision, selection| inline_format(text, revision, selection, format))
    }

    /// A table edit at the caret: in the open block when one is open.
    pub fn table_edit(&mut self, edit: TableEdit) -> Result<Applied, CommandError> {
        self.command(|text, revision, selection| {
            table_edit(text, revision, selection.start, edit).map_err(CommandError::from)
        })
    }

    fn command<E: Into<CommandError>>(
        &mut self,
        run: impl FnOnce(&str, Revision, Range<usize>) -> Result<Edit, E>,
    ) -> Result<Applied, CommandError> {
        if self.mode == MarkdownMode::Preview {
            return Err(EditRefusal::Preview.into());
        }
        if self.too_long() {
            return Err(EditRefusal::TooLong.into());
        }
        let session = match self.open.as_mut() {
            Some(open) => &mut open.session,
            None => &mut self.session,
        };
        let text = session.text();
        let selection = selection_bytes(session);
        let edit = run(&text, session.accepted_revision(), selection).map_err(Into::into)?;
        let local = splice(session, &edit)?;
        let applied = Applied {
            revision: edit.revision,
            local,
        };
        if self.open.is_none() {
            self.version += 1;
        }
        Ok(applied)
    }

    // ---- the open block ----

    /// The block the user is typing in, as a text session of its own.
    pub fn block_session(&mut self) -> Option<&mut EditSession> {
        self.open.as_mut().map(|open| &mut open.session)
    }

    /// Where the caret is, as a scalar offset in the document's text: inside
    /// the open block when one is open (Visual mode keeps the caret there, and
    /// the document session's own cursor stays where it was), else the
    /// session's cursor.
    pub fn caret_offset(&self) -> usize {
        let Some(open) = &self.open else {
            return self.session.cursor();
        };
        let start = match open.append {
            true => self.session.rope().len_bytes(),
            false => open.range.start,
        };
        let start = self
            .session
            .coords()
            .to_scalar(start, Unit::Utf8, Snap::Backward)
            .unwrap_or(0);
        start + open.session.cursor()
    }

    /// The open block's bytes in the document, if one is open.
    pub fn open_range(&self) -> Option<Range<usize>> {
        self.open.as_ref().map(|open| match open.append {
            true => self.session.rope().len_bytes()..self.session.rope().len_bytes(),
            false => open.range.clone(),
        })
    }

    /// Whether the open block is held for the user to resolve.
    pub fn is_held(&self) -> bool {
        self.open.as_ref().is_some_and(|open| open.held)
    }

    /// Open block `index` to type in, writing back the one open first.
    /// Returns how that went; a held block stays open and nothing opens.
    pub fn open_block(&mut self, index: usize) -> CommitOutcome {
        self.open_with(index, false)
    }

    fn open_with(&mut self, index: usize, at_start: bool) -> CommitOutcome {
        let target = self
            .parsed()
            .blocks
            .get(index)
            .map(|block| block.range.clone());
        let outcome = self.commit_block();
        if matches!(outcome, CommitOutcome::Held | CommitOutcome::Failed(_)) {
            return outcome;
        }
        let Some(target) = target else {
            return outcome;
        };
        // Blocks after what was written moved.
        let target = match &outcome {
            CommitOutcome::Written { range, written, .. } => shifted(target, range, *written),
            _ => target,
        };
        let text = self.session.text();
        let source = text[target.clone()].to_string();
        self.open = Some(OpenBlock::new(target, &source, false, at_start));
        outcome
    }

    /// Open the block holding the cursor; an empty document opens an
    /// appending block.
    pub fn open_at_cursor(&mut self) -> CommitOutcome {
        let at = self.cursor_byte();
        match self.block_at(at) {
            Some(index) => self.open_block(index),
            None => self.open_end(),
        }
    }

    /// Open a block past the last one, to start a new paragraph.
    pub fn open_end(&mut self) -> CommitOutcome {
        let outcome = self.commit_block();
        if matches!(outcome, CommitOutcome::Held | CommitOutcome::Failed(_)) {
            return outcome;
        }
        let end = self.session.rope().len_bytes();
        self.open = Some(OpenBlock::new(end..end, "", true, true));
        outcome
    }

    /// Move to the next or previous block when the caret in the open block
    /// is on its last or first line. `false` when it is not at that edge or
    /// there is no block that way.
    pub fn step_block(&mut self, down: bool) -> Option<CommitOutcome> {
        let open = self.open.as_ref()?;
        let coords = open.session.coords();
        let line = coords.line_of(open.session.cursor());
        let edge = match down {
            true => line + 1 == coords.line_count(),
            false => line == 0,
        };
        if !edge || open.held {
            return None;
        }
        let range = open.range.clone();
        let append = open.append;
        let blocks = self.blocks();
        let index = match (down, append) {
            (true, true) => return None,
            (false, true) => blocks.len().checked_sub(1)?,
            (true, false) => blocks
                .iter()
                .position(|block| block.range.start >= range.end)?,
            (false, false) => blocks
                .iter()
                .rposition(|block| block.range.end <= range.start)?,
        };
        Some(self.open_with(index, down))
    }

    /// Write the open block back into the text as one edit and close it.
    pub fn commit_block(&mut self) -> CommitOutcome {
        let Some(open) = self.open.as_ref() else {
            return CommitOutcome::Nothing;
        };
        let text = self.session.text();
        match open.close(&text) {
            Close::Held => CommitOutcome::Held,
            Close::Unchanged => {
                let range = self.open_range().unwrap_or_default();
                self.open = None;
                CommitOutcome::Unchanged { range }
            }
            Close::Write { range, text: typed } => {
                let merged = open.base != open.theirs();
                let lead = typed.len() - open.typed().len();
                let caret = {
                    let at = open.session.cursor();
                    let bytes = open
                        .session
                        .coords()
                        .from_scalar(at, Unit::Utf8)
                        .unwrap_or(0);
                    range.start + lead + bytes
                };
                match replace_bytes(&mut self.session, &range, &typed) {
                    Ok(local) => {
                        self.version += 1;
                        let written = typed.len();
                        let at = self.scalar_of(caret.min(self.session.rope().len_bytes()));
                        self.session.set_selection(at, at);
                        self.open = None;
                        CommitOutcome::Written {
                            range,
                            written,
                            merged,
                            local,
                        }
                    }
                    Err(CommandError::Edit(why)) => CommitOutcome::Failed(why),
                    Err(_) => CommitOutcome::Failed(EditError::ReadOnly),
                }
            }
        }
    }

    /// The held block's versions.
    pub fn block_conflict(&self) -> Option<BlockConflict> {
        let open = self.open.as_ref().filter(|open| open.held)?;
        Some(BlockConflict {
            range: open.range.clone(),
            base: open.base.clone(),
            mine: open.typed(),
            theirs: self.session.text()[open.range.clone()].to_string(),
        })
    }

    /// Settle the held block. `KeepMine` returns what it replaced and
    /// `TakeTheirs` what it dropped, so neither text is lost to the caller.
    pub fn resolve_block_conflict(
        &mut self,
        how: BlockResolution,
    ) -> Result<Option<String>, CommandError> {
        let Some(open) = self.open.as_mut().filter(|open| open.held) else {
            return Ok(None);
        };
        let (mine, range) = (open.typed(), open.range.clone());
        let theirs = self.session.text()[range.clone()].to_string();
        match how {
            BlockResolution::TakeTheirs => {
                self.open = None;
                Ok(Some(mine))
            }
            BlockResolution::KeepMine => {
                replace_bytes(&mut self.session, &range, &mine)?;
                self.version += 1;
                self.open = None;
                Ok(Some(theirs))
            }
            BlockResolution::KeepBoth => {
                let both = format!("{theirs}{}{mine}", joint(&theirs));
                replace_bytes(&mut self.session, &range, &both)?;
                self.version += 1;
                self.open = None;
                Ok(None)
            }
        }
    }

    // ---- scroll and view ----

    /// Scroll a Visual or Preview view by `rows`; Source and Split scroll
    /// the text session's view by lines. Returns the new anchor.
    pub fn scroll_by(&mut self, rows: isize) -> Anchor {
        match self.mode {
            MarkdownMode::Visual | MarkdownMode::Preview => {
                self.anchor = self.shift_anchor(self.anchor, rows);
            }
            MarkdownMode::Source | MarkdownMode::Split => {
                let mut scroll = self.session.scroll();
                scroll.top_line = scroll.top_line.saturating_add_signed(rows);
                scroll.top_line = scroll.top_line.min(self.session.coords().line_count() - 1);
                scroll.top_row = 0;
                self.session.set_scroll(scroll);
                self.caret_into_view(scroll.top_line);
                self.anchor = self.anchor_from_source();
            }
        }
        self.anchor
    }

    /// The text view scrolls to keep the caret on screen, so a scroll that
    /// leaves it outside takes it along to the nearest visible line.
    fn caret_into_view(&mut self, top: usize) {
        let height = self.session.viewport().1.max(1);
        let coords = self.session.coords();
        let line = coords.line_of(self.session.cursor());
        let want = line
            .clamp(top, top + height - 1)
            .min(coords.line_count() - 1);
        if want != line
            && let Some((start, _)) = coords.line_range(want)
        {
            self.session.set_selection(start, start);
        }
    }

    /// `at` moved by `rows`, a row at a time, by the lines of each block's source.
    fn shift_anchor(&mut self, at: Anchor, rows: isize) -> Anchor {
        let lines: Vec<usize> = {
            let text = self.session.text();
            self.parsed()
                .blocks
                .iter()
                .map(|block| text[block.range.clone()].lines().count().max(1))
                .collect()
        };
        if lines.is_empty() {
            return Anchor::default();
        }
        let (mut block, mut row) = (at.block.min(lines.len() - 1), at.row as isize + rows);
        while row < 0 && block > 0 {
            block -= 1;
            row += lines[block] as isize;
        }
        while row >= lines[block] as isize && block + 1 < lines.len() {
            row -= lines[block] as isize;
            block += 1;
        }
        Anchor {
            block,
            row: row.clamp(0, lines[block] as isize - 1) as usize,
        }
    }

    fn block_start_line(&mut self, index: usize) -> Option<usize> {
        let start = self.parsed().blocks.get(index)?.range.start;
        let scalar = self.scalar_of(start);
        Some(self.session.coords().line_of(scalar))
    }

    /// The anchor that the source view's top line is in.
    pub(crate) fn anchor_from_source(&mut self) -> Anchor {
        let top = self.session.scroll().top_line;
        let count = self.parsed().blocks.len();
        let mut found = Anchor::default();
        for index in 0..count {
            match self.block_start_line(index) {
                Some(line) if line <= top => {
                    found = Anchor {
                        block: index,
                        row: top - line,
                    }
                }
                _ => break,
            }
        }
        found
    }

    /// Scroll the source view so the anchor's block is at its top.
    pub(crate) fn scroll_source_to_anchor(&mut self) {
        let Some(line) = self.block_start_line(self.anchor.block) else {
            return;
        };
        let mut scroll = self.session.scroll();
        scroll.top_line = line + self.anchor.row;
        scroll.top_row = 0;
        scroll.top_line = scroll.top_line.min(self.session.coords().line_count() - 1);
        self.session.set_scroll(scroll);
    }

    /// The view as a panel saves it.
    pub fn view_state(&mut self) -> MarkdownViewState {
        if matches!(self.mode, MarkdownMode::Source | MarkdownMode::Split) {
            self.anchor = self.anchor_from_source();
        }
        let open = self.open.as_ref().map(|open| OpenState {
            start: open.range.start,
            end: open.range.end,
            base: open.base.clone(),
            typed: open.typed(),
            append: open.append,
            held: open.held,
        });
        MarkdownViewState {
            mode: self.mode,
            anchor: self.anchor,
            selection: self.session.view_snapshot(),
            open,
        }
    }

    /// Restore a saved view onto a document over the same text. A pending
    /// block edit comes back with what was typed in it; when the text moved
    /// meanwhile, the block comes back held, not merged and not dropped.
    pub fn restore_view(&mut self, state: &MarkdownViewState) {
        let text = self.session.text();
        self.session.restore_view(&state.selection);
        self.anchor = state.anchor;
        self.mode = state.mode;
        self.session
            .set_read_only(state.mode == MarkdownMode::Preview);
        self.open = state.open.as_ref().map(|saved| {
            let end = saved.end.min(text.len());
            let start = saved.start.min(end);
            let (start, end) = (floor(&text, start), floor(&text, end));
            let theirs = match saved.append {
                true => "",
                false => &text[start..end],
            };
            let held = saved.held || (!saved.append && theirs != saved.base);
            OpenBlock::restored(
                start..end,
                saved.base.clone(),
                theirs,
                &saved.typed,
                saved.append,
                held,
            )
        });
        if matches!(state.mode, MarkdownMode::Source | MarkdownMode::Split) {
            self.session.restore_view(&state.selection);
        }
        self.version += 1;
    }
}

/// `byte` or the character start before it.
fn floor(text: &str, mut byte: usize) -> usize {
    while !text.is_char_boundary(byte) {
        byte -= 1;
    }
    byte
}

fn scalar_in(session: &EditSession, byte: usize) -> usize {
    session
        .coords()
        .to_scalar(byte, Unit::Utf8, Snap::Backward)
        .unwrap_or_else(|| session.len())
}

/// The session's selection as bytes of its text.
fn selection_bytes(session: &EditSession) -> Range<usize> {
    let coords = session.coords();
    let (start, end) = session
        .selection()
        .unwrap_or((session.cursor(), session.cursor()));
    let bytes = |at| coords.from_scalar(at, Unit::Utf8).unwrap_or(0);
    bytes(start)..bytes(end)
}

/// Replace `range` bytes of the session's text with `with` as one edit.
fn replace_bytes(
    session: &mut EditSession,
    range: &Range<usize>,
    with: &str,
) -> Result<Option<LocalEdit>, CommandError> {
    let (start, end) = (
        scalar_in(session, range.start),
        scalar_in(session, range.end),
    );
    session.set_selection(start, end);
    let held = match end > start {
        true => session.selection() == Some((start, end)),
        false => session.selection().is_none() && session.cursor() == start,
    };
    if !held {
        return Err(CommandError::Cluster);
    }
    Ok(session.insert_text(with)?)
}

/// Apply an edit as one change of the session, then place the selection.
fn splice(session: &mut EditSession, edit: &Edit) -> Result<Option<LocalEdit>, CommandError> {
    let text = session.text();
    let local = match (edit.edits.first(), edit.edits.last()) {
        (Some((first, _)), Some((last, _))) => {
            let (lo, hi) = (first.start, last.end);
            let old = &text[lo..hi];
            let mut new = old.to_string();
            for (range, with) in edit.edits.iter().rev() {
                new.replace_range(range.start - lo..range.end - lo, with);
            }
            match changed_region(old, &new) {
                Some((gone, put)) => {
                    replace_bytes(session, &(lo + gone.start..lo + gone.end), &new[put])?
                }
                None => None,
            }
        }
        _ => None,
    };
    let after = session.text();
    let at = |byte: usize| scalar_in(session, byte.min(after.len()));
    session.set_selection(at(edit.selection.start), at(edit.selection.end));
    Ok(local)
}
