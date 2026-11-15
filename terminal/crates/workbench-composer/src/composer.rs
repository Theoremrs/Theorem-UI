//! The composer's state and its input handling.

use std::cell::Cell;

use keybinds::{Key, KeyInput, Mods};
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::{
    Composition, DraftAttachment, DraftAttachmentState, ModelChoice, PanelPointer, PointerKind,
    SourceReference,
};
use theorem_workbench_editor::{Clipboard, Reaction, SourceView};
use theorem_workbench_text::layout::line_rows;
use theorem_workbench_text::{AtomicId, Deletion, EditSession, Motion, Scroll, SessionConfig};

use crate::types::{
    Caret, CaretPhase, ComposerStatus, Draft, Event, Input, PlacedReference, Policy, Response,
    SubmitMode,
};

/// The width of the prompt column: the glyph and a space.
pub(crate) const PROMPT_WIDTH: u16 = 2;
/// The caret holds still this long after an input, then blinks. The same half
/// period the terminal drawer's hollow cursor uses.
pub const DEFAULT_HOLD_MS: f64 = 530.0;
/// A pause this long ends the typing group, so the next edit is its own undo step.
const UNDO_PAUSE_MS: f64 = 1000.0;
/// Committed IME text that the browser also delivers as typed input arrives
/// within this long of the commit.
const DUPLICATE_MS: f64 = 300.0;
/// The most rows a popup shows.
pub(crate) const POPUP_ROWS: usize = 6;
/// How far back from the caret an `@` can start a reference.
const MENTION_SCAN: usize = 256;
/// Dead reference payloads kept so an undo can restore them.
const POOL_LIMIT: usize = 64;
/// The most sent prompts the history keeps.
pub const HISTORY_LIMIT: usize = 200;

/// A reference whose text is an atomic range of the draft.
#[derive(Clone, Debug)]
pub(crate) struct Slot {
    pub id: AtomicId,
    pub reference: SourceReference,
}

#[derive(Clone, Debug)]
pub(crate) enum Popup {
    Files {
        /// Scalar offset of the `@`.
        start: usize,
        query: String,
        token: u64,
        /// None until the panel has answered.
        rows: Option<Vec<String>>,
        selected: usize,
    },
    Models {
        choices: Vec<ModelChoice>,
        selected: usize,
    },
}

impl Popup {
    pub fn len(&self) -> usize {
        match self {
            Self::Files { rows, .. } => rows.as_ref().map_or(0, Vec::len),
            Self::Models { choices, .. } => choices.len(),
        }
    }

    pub fn selected(&self) -> usize {
        match self {
            Self::Files { selected, .. } | Self::Models { selected, .. } => *selected,
        }
    }

    fn selected_mut(&mut self) -> &mut usize {
        match self {
            Self::Files { selected, .. } | Self::Models { selected, .. } => selected,
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Self::Files { .. } => "Files to reference",
            Self::Models { .. } => "Models",
        }
    }

    /// The text of each row.
    pub fn labels(&self) -> Vec<String> {
        match self {
            Self::Files { rows, .. } => rows.clone().unwrap_or_default(),
            Self::Models { choices, .. } => choices
                .iter()
                .map(|c| match c.context_tokens {
                    Some(n) => format!("{}  ({} context)", c.label, tokens(n)),
                    None => c.label.clone(),
                })
                .collect(),
        }
    }
}

fn tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{}M", n / 1_000_000)
    } else if n >= 1_000 {
        format!("{}k", n / 1_000)
    } else {
        n.to_string()
    }
}

/// The text a reference shows in the draft.
pub fn reference_token(r: &SourceReference) -> String {
    match r.range {
        Some(range) => format!("@{}:{}", r.path, range.start.line + 1),
        None => format!("@{}", r.path),
    }
}

/// The multiline message composer. State, input handling, drawing and
/// semantics; it has no effects of its own and no clock.
pub struct Composer {
    pub(crate) prefix: String,
    pub(crate) label: String,
    /// The prompt glyph, one cell wide, then a space.
    pub(crate) prompt: char,
    pub(crate) placeholder: String,
    pub(crate) session: EditSession,
    pub(crate) view: SourceView,
    /// The cells the composer was last given.
    pub(crate) area: Cell<Rect>,
    pub(crate) status: ComposerStatus,
    pub(crate) attachments: Vec<DraftAttachment>,
    /// The chip the keyboard is on, when it is in the chip row.
    pub(crate) chip: Option<usize>,
    pub(crate) slots: Vec<Slot>,
    pub(crate) popup: Option<Popup>,
    /// The `@` the person dismissed the popup for.
    dismissed: Option<usize>,
    next_token: u64,
    pub(crate) preedit: Option<String>,
    composing_early: Option<String>,
    suppress: Option<(String, f64)>,
    /// The message loaded for editing, as it was.
    pub(crate) editing: Option<String>,
    pub(crate) focused: bool,
    pub(crate) window_focused: bool,
    pub(crate) reduced_motion: bool,
    hold_ms: f64,
    last_input_ms: f64,
    pub(crate) notice: Option<String>,
    revision: u64,
    /// Sent prompts, oldest first, given by the owner.
    history: Vec<String>,
    /// The history entry shown, while the person walks it.
    walk: Option<usize>,
    /// A cut waiting for the clipboard write: its range and text.
    pending_cut: Option<(usize, usize, String)>,
}

fn new_session(text: &str) -> EditSession {
    EditSession::new(text, 0, SessionConfig::new("composer"))
}

impl Composer {
    /// `prefix` is the stable root of every semantic node id.
    pub fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.to_owned(),
            label: "Message".to_owned(),
            prompt: '\u{203A}',
            placeholder: "Message".to_owned(),
            session: new_session(""),
            view: SourceView::new(),
            area: Cell::new(Rect::default()),
            status: ComposerStatus::default(),
            attachments: Vec::new(),
            chip: None,
            slots: Vec::new(),
            popup: None,
            dismissed: None,
            next_token: 0,
            preedit: None,
            composing_early: None,
            suppress: None,
            editing: None,
            focused: true,
            window_focused: true,
            reduced_motion: false,
            hold_ms: DEFAULT_HOLD_MS,
            last_input_ms: f64::NEG_INFINITY,
            notice: None,
            revision: 0,
            history: Vec::new(),
            walk: None,
            pending_cut: None,
        }
    }

    // ---- configuration ----

    pub fn set_label(&mut self, label: &str) {
        self.label = label.to_owned();
    }

    /// The glyph before the first row; one cell wide.
    pub fn set_prompt(&mut self, glyph: char) {
        self.prompt = glyph;
    }

    /// A press is held in the text and the pointer is selecting: moves and
    /// the release belong to the composer even outside its cells.
    pub fn is_dragging(&self) -> bool {
        self.view.dragging()
    }

    /// The text shown, and described to assistive technology, while the draft is empty.
    pub fn set_placeholder(&mut self, placeholder: &str) {
        self.placeholder = placeholder.to_owned();
    }

    pub fn set_status(&mut self, status: ComposerStatus) {
        self.status = status;
    }

    pub fn status(&self) -> &ComposerStatus {
        &self.status
    }

    /// This panel owns the keyboard.
    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
    }

    /// The host window has focus.
    pub fn set_window_focused(&mut self, focused: bool) {
        self.window_focused = focused;
    }

    pub fn set_reduced_motion(&mut self, reduced: bool) {
        self.reduced_motion = reduced;
    }

    /// How long the caret holds steady after an input (default [`DEFAULT_HOLD_MS`]).
    pub fn set_hold_ms(&mut self, ms: f64) {
        self.hold_ms = ms;
    }

    /// Replace the attachment list; the host owns it.
    pub fn set_attachments(&mut self, attachments: Vec<DraftAttachment>) {
        self.attachments = attachments;
        // "waiting for an attachment" is about the old list.
        self.notice = None;
        match self.chip {
            Some(_) if self.attachments.is_empty() => self.chip = None,
            Some(i) => self.chip = Some(i.min(self.attachments.len() - 1)),
            None => {}
        }
    }

    pub fn attachments(&self) -> &[DraftAttachment] {
        &self.attachments
    }

    /// Give the composer its cells. The text's wrap and scroll follow.
    pub fn resize(&mut self, area: Rect) {
        self.area.set(area);
        self.sync_view();
        // A draft that fits starts at its first row: the box may have grown
        // since the caret last scrolled it.
        if self.total_rows(area.width) <= usize::from(self.text_rect().height) {
            self.session.set_scroll(Scroll::default());
        }
        self.view.reveal(&mut self.session);
    }

    /// The rows the draft takes when wrapped for a box `width` cells wide.
    fn total_rows(&self, width: u16) -> usize {
        let w = usize::from(width.saturating_sub(PROMPT_WIDTH));
        let wrap = if self.session.config().wrap { w } else { 0 };
        let tab = self.session.config().tab_width;
        let rope = self.session.rope();
        (0..self.session.coords().line_count())
            .map(|l| line_rows(rope, l, wrap, tab).len())
            .sum()
    }

    // ---- reading ----

    /// The draft text. It never holds a caret glyph: the caret is the host's.
    pub fn text(&self) -> String {
        self.session.text()
    }

    pub fn is_empty(&self) -> bool {
        self.session.is_empty()
    }

    pub fn is_editing(&self) -> bool {
        self.editing.is_some()
    }

    pub fn is_composing(&self) -> bool {
        self.preedit.is_some()
    }

    /// The caret as a scalar offset into [`text`](Self::text).
    pub fn caret_offset(&self) -> usize {
        self.session.cursor()
    }

    /// The selection as scalar offsets, when there is one.
    pub fn selection(&self) -> Option<(usize, usize)> {
        self.session.selection()
    }

    pub fn has_popup(&self) -> bool {
        self.popup.is_some()
    }

    /// The footer's notice (why Enter did nothing), until the next input.
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    /// The references still in the text, in text order.
    pub fn references(&self) -> Vec<SourceReference> {
        self.placed().into_iter().map(|p| p.reference).collect()
    }

    fn placed(&self) -> Vec<PlacedReference> {
        let mut out: Vec<PlacedReference> = self
            .slots
            .iter()
            .filter_map(|s| {
                let a = self.session.atomics().iter().find(|a| a.id == s.id)?;
                Some(PlacedReference {
                    start: a.start,
                    end: a.end,
                    reference: s.reference.clone(),
                })
            })
            .collect();
        out.sort_by_key(|p| p.start);
        out
    }

    /// Where the host draws its caret and how.
    pub fn caret(&self, now_ms: f64) -> Caret {
        let owns = self.focused
            && self.window_focused
            && self.chip.is_none()
            && !matches!(self.popup, Some(Popup::Models { .. }));
        if !owns {
            return Caret {
                cell: None,
                phase: CaretPhase::Hidden,
            };
        }
        let holding = self.preedit.is_some() || now_ms - self.last_input_ms < self.hold_ms;
        let phase = if holding || self.reduced_motion {
            CaretPhase::Steady
        } else {
            CaretPhase::Blinking
        };
        Caret {
            cell: self.caret_cell(),
            phase,
        }
    }

    // ---- input ----

    pub fn handle(&mut self, input: Input, now_ms: f64) -> Response {
        self.sync_view();
        if now_ms - self.last_input_ms > UNDO_PAUSE_MS {
            self.session.break_undo_group();
        }
        self.last_input_ms = now_ms;
        self.notice = None;
        let mut out = Response {
            handled: true,
            events: Vec::new(),
        };
        match input {
            Input::Key(k) => {
                self.suppress = None;
                self.key(k, &mut out);
            }
            Input::Text(t) => self.text_in(t, now_ms, &mut out),
            Input::Paste(t) => {
                self.suppress = None;
                self.paste(&t, &mut out);
            }
            Input::Pointer(p) => {
                self.suppress = None;
                self.pointer(p, &mut out);
            }
            Input::Composition(c) => self.composition(c, now_ms, &mut out),
        }
        out
    }

    /// An attach request (a button, a shortcut the host owns).
    pub fn attach(&mut self) -> Response {
        Response {
            handled: true,
            events: vec![Event::AttachPick],
        }
    }

    fn text_in(&mut self, t: String, now_ms: f64, out: &mut Response) {
        if self.preedit.is_some() {
            // The committed text arrives again as typed input while the
            // composition is open: the End event carries it, once.
            self.composing_early = Some(t);
            return;
        }
        if let Some((s, at)) = self.suppress.take()
            && s == t
            && now_ms - at < DUPLICATE_MS
        {
            return;
        }
        self.chip = None;
        self.close_models();
        let r = self.view.text(&mut self.session, &t);
        self.apply(r, out);
    }

    fn paste(&mut self, t: &str, out: &mut Response) {
        if self.preedit.is_some() {
            return;
        }
        self.chip = None;
        self.close_models();
        let r = self.view.paste(&mut self.session, t);
        self.apply(r, out);
    }

    fn composition(&mut self, c: Composition, now_ms: f64, out: &mut Response) {
        match c {
            Composition::Start => {
                self.chip = None;
                self.close_models();
                self.composing_early = None;
                self.session.break_undo_group();
                self.preedit = Some(String::new());
            }
            Composition::Update { text } => {
                if self.preedit.is_none() {
                    self.chip = None;
                    self.composing_early = None;
                }
                self.preedit = Some(text);
            }
            Composition::End { text } => {
                self.preedit = None;
                self.composing_early = None;
                if !text.is_empty() {
                    let r = self.view.text(&mut self.session, &text);
                    self.apply(r, out);
                    self.suppress = Some((text, now_ms));
                }
            }
        }
    }

    fn key(&mut self, k: KeyInput, out: &mut Response) {
        let mods = k.mods();
        if self.preedit.is_some() {
            // While composing, keys belong to the input method. Enter never
            // submits; Esc abandons the composition.
            if k.key() == Key::Esc {
                self.preedit = None;
                self.composing_early = None;
            }
            return;
        }
        if self.popup.is_some() && self.popup_key(&k, out) {
            return;
        }
        if self.chip.is_some() {
            self.chip_key(&k, out);
            return;
        }
        let plain = !mods.intersects(Mods::CTRL | Mods::CMD | Mods::ALT);
        let extend = mods.contains(Mods::SHIFT);
        match k.key() {
            Key::Enter if !mods.intersects(Mods::SHIFT | Mods::ALT) => self.submit(out),
            Key::Enter => self.newline(out),
            Key::Char(c) if mods.contains(Mods::CTRL) && c.eq_ignore_ascii_case(&'j') => {
                self.newline(out)
            }
            Key::Char(c) if mods.contains(Mods::CTRL) && c.eq_ignore_ascii_case(&'e') => {
                let moved = self.session.move_cursor(Motion::LineEnd, extend);
                self.view.reveal(&mut self.session);
                if moved {
                    self.refresh_mention(out);
                }
            }
            Key::Char(c) if mods.contains(Mods::CTRL) && c.eq_ignore_ascii_case(&'u') => {
                self.delete(Deletion::ToLineStart, out)
            }
            Key::Char(c) if mods.contains(Mods::CTRL) && c.eq_ignore_ascii_case(&'k') => {
                self.delete(Deletion::ToLineEnd, out)
            }
            // The panel's: branches, tabs, transcript paging.
            Key::Char('[' | ']') if mods.contains(Mods::ALT) => out.handled = false,
            Key::Tab | Key::PageUp | Key::PageDown => out.handled = false,
            Key::Esc => self.escape(out),
            Key::Up if plain && !extend && self.on_first_row() => self.up_from_top(out),
            Key::Down if plain && !extend && self.walk.is_some() && self.row_ends().1 => {
                self.history_newer()
            }
            _ => {
                let r = self.view.key(&mut self.session, &k);
                self.apply(r, out);
            }
        }
    }

    fn newline(&mut self, out: &mut Response) {
        let r = self
            .view
            .key(&mut self.session, &KeyInput::new(Key::Enter, Mods::empty()));
        // SourceView inserts the document's line break on a bare Enter.
        self.apply(r, out);
    }

    fn delete(&mut self, d: Deletion, out: &mut Response) {
        let mut r = Reaction {
            handled: true,
            ..Reaction::default()
        };
        match self.session.delete(d) {
            Ok(Some(_)) => {
                r.edited = true;
                r.moved = true;
            }
            Ok(None) => {}
            Err(e) => r.error = Some(e),
        }
        self.view.reveal(&mut self.session);
        self.apply(r, out);
    }

    fn escape(&mut self, out: &mut Response) {
        let untouched = self
            .editing
            .as_ref()
            .is_some_and(|o| *o == self.session.text() || self.session.is_empty());
        if untouched {
            self.reset_text();
            self.editing = None;
        } else {
            out.handled = false;
        }
    }

    /// Up on the first row: the chip row, or the last message.
    fn up_from_top(&mut self, out: &mut Response) {
        if self.walk.is_some() {
            self.history_older();
        } else if !self.attachments.is_empty() {
            self.chip = Some(0);
        } else if self.session.is_empty() && !self.history.is_empty() {
            self.history_older();
        } else if self.session.is_empty() {
            out.events.push(Event::RecallLast);
        } else {
            // Up on the first row of a draft goes to its start, as a text box does.
            self.session.move_cursor(Motion::DocStart, false);
            self.view.reveal(&mut self.session);
        }
    }

    fn on_first_row(&self) -> bool {
        self.row_ends().0
    }

    fn chip_key(&mut self, k: &KeyInput, out: &mut Response) {
        let Some(i) = self.chip else { return };
        let n = self.attachments.len();
        match k.key() {
            Key::Left => self.chip = Some(i.saturating_sub(1)),
            Key::Right => self.chip = Some((i + 1).min(n.saturating_sub(1))),
            Key::Home => self.chip = Some(0),
            Key::End => self.chip = Some(n.saturating_sub(1)),
            Key::Backspace | Key::Delete => {
                if let Some(a) = self.attachments.get(i) {
                    out.events.push(Event::AttachRemove { id: a.id.clone() });
                }
            }
            Key::Down | Key::Esc => self.chip = None,
            Key::Char(_) | Key::Paste if k.mods().intersects(Mods::CTRL | Mods::CMD) => {
                out.handled = false
            }
            Key::Char(_) => {
                // Typing leaves the chip row and goes to the text.
                self.chip = None;
                let r = self.view.key(&mut self.session, k);
                self.apply(r, out);
            }
            Key::Tab | Key::PageUp | Key::PageDown => out.handled = false,
            _ => {}
        }
    }

    fn popup_key(&mut self, k: &KeyInput, out: &mut Response) -> bool {
        let models = matches!(self.popup, Some(Popup::Models { .. }));
        let len = self.popup.as_ref().map_or(0, Popup::len);
        let plain = !k
            .mods()
            .intersects(Mods::CTRL | Mods::CMD | Mods::ALT | Mods::SHIFT);
        match k.key() {
            Key::Up if len > 0 && plain => {
                if let Some(p) = &mut self.popup {
                    let s = p.selected_mut();
                    *s = if *s == 0 { len - 1 } else { *s - 1 };
                }
                true
            }
            Key::Down if len > 0 && plain => {
                if let Some(p) = &mut self.popup {
                    let s = p.selected_mut();
                    *s = (*s + 1) % len;
                }
                true
            }
            Key::Enter | Key::Tab if len > 0 && plain => {
                self.choose(out);
                true
            }
            Key::Esc => {
                if let Some(Popup::Files { start, .. }) = self.popup.take() {
                    self.dismissed = Some(start);
                }
                true
            }
            // The model list owns the keyboard; everything else is ignored.
            _ if models => true,
            _ => false,
        }
    }

    fn choose(&mut self, out: &mut Response) {
        match self.popup.take() {
            Some(Popup::Models { choices, selected }) => {
                if let Some(c) = choices.get(selected) {
                    out.events.push(Event::ModelChosen {
                        model_ref: c.model_ref.clone(),
                    });
                }
            }
            Some(Popup::Files {
                start,
                rows: Some(rows),
                selected,
                ..
            }) => {
                if let Some(path) = rows.get(selected) {
                    self.insert_reference(
                        SourceReference {
                            path: path.clone(),
                            range: None,
                            label: None,
                            excerpt: None,
                        },
                        Some(start),
                    );
                    self.after_edit(out);
                }
            }
            _ => {}
        }
    }

    // ---- submit ----

    fn submit(&mut self, out: &mut Response) {
        let ready: Vec<String> = self
            .attachments
            .iter()
            .filter(|a| a.state == DraftAttachmentState::Ready)
            .map(|a| a.id.clone())
            .collect();
        let text = self.session.text();
        if text.trim().is_empty() && ready.is_empty() {
            return;
        }
        match &self.status.policy {
            Policy::Blocked { .. } => return,
            Policy::Running { can_steer: false } if self.editing.is_none() => {
                self.notice = Some("the run cannot take input now; Esc stops it".to_owned());
                return;
            }
            _ => {}
        }
        let adding = self
            .attachments
            .iter()
            .filter(|a| a.state == DraftAttachmentState::Adding)
            .count();
        if adding > 0 {
            self.notice = Some(if adding == 1 {
                "waiting for 1 attachment to finish adding".to_owned()
            } else {
                format!("waiting for {adding} attachments to finish adding")
            });
            return;
        }
        let mode = if self.editing.is_some() {
            SubmitMode::Edit
        } else if matches!(self.status.policy, Policy::Running { .. }) {
            SubmitMode::Steer
        } else {
            SubmitMode::Send
        };
        out.events.push(Event::Submit {
            text: text.trim().to_owned(),
            attachments: ready,
            references: self.references(),
            mode,
        });
    }

    // ---- editing results ----

    /// Fold a `SourceView` reaction into the response and the composer.
    fn apply(&mut self, r: Reaction, out: &mut Response) {
        if !r.handled {
            out.handled = false;
            return;
        }
        if let Some(e) = &r.error {
            self.notice = Some(e.to_string());
        }
        match r.clipboard {
            Some(Clipboard::Copy) => match self.session.selected_text() {
                Some(text) => out.events.push(Event::Copy { text }),
                // Ctrl+C with nothing selected is the panel's (stop, clear).
                None => out.handled = false,
            },
            Some(Clipboard::Cut) => {
                match (self.session.selection(), self.session.selected_text()) {
                    (Some((a, b)), Some(text)) => {
                        // Nothing leaves the draft until the write is accepted.
                        self.pending_cut = Some((a, b, text.clone()));
                        out.events.push(Event::Cut { text });
                    }
                    _ => out.handled = false,
                }
            }
            Some(Clipboard::Paste) => out.events.push(Event::ReadClipboard),
            None => {
                if r.edited {
                    self.after_edit(out);
                } else if r.moved {
                    self.sync_view();
                    self.refresh_mention(out);
                }
            }
        }
    }

    /// After the text changed: settle the session, keep the references in step
    /// with the text, and look at what the caret is in.
    fn after_edit(&mut self, out: &mut Response) {
        self.walk = None;
        while let Some(e) = self.session.take_next_to_send() {
            self.revision += 1;
            let _ = self.session.acknowledge(&e.op_id, self.revision);
        }
        self.reconcile();
        self.sync_view();
        self.view.reveal(&mut self.session);
        self.refresh_mention(out);
    }

    // ---- references ----

    /// Insert `reference` as an atomic `@path`: over `[from, caret)` when given,
    /// else at the caret (over the selection).
    fn insert_reference(&mut self, reference: SourceReference, from: Option<usize>) {
        let token = reference_token(&reference);
        let (s, e) = match from {
            Some(f) => (f, self.session.cursor()),
            None => self
                .session
                .selection()
                .unwrap_or((self.session.cursor(), self.session.cursor())),
        };
        self.session.set_selection(s, e);
        let rope = self.session.rope();
        let before_ok = s == 0 || rope.char(s - 1).is_whitespace();
        let lead = if before_ok || from.is_some() { "" } else { " " };
        let _ = self.session.insert_text(&format!("{lead}{token}"));
        let end = self.session.cursor();
        let start = end - token.chars().count();
        if let Ok(id) = self.session.mark_atomic(start, end) {
            self.slots.push(Slot { id, reference });
        }
        let rope = self.session.rope();
        let at = self.session.cursor();
        let next_blank = at < rope.len_chars() && rope.char(at).is_whitespace();
        if !next_blank {
            let _ = self.session.insert_text(" ");
        }
    }

    /// Insert a reference at the caret: "ask about this" from another panel.
    pub fn add_reference(&mut self, reference: SourceReference) {
        self.chip = None;
        self.insert_reference(reference, None);
        let mut sink = Response::default();
        self.after_edit(&mut sink);
    }

    /// The session restores an atomic range, under its own id, when an undo
    /// or redo brings its text back, so a slot stays while its id may return;
    /// only the oldest dead ones are dropped.
    fn reconcile(&mut self) {
        let live: Vec<AtomicId> = self.session.atomics().iter().map(|a| a.id).collect();
        let dead = self.slots.iter().filter(|s| !live.contains(&s.id)).count();
        let mut extra = dead.saturating_sub(POOL_LIMIT);
        self.slots.retain(|s| {
            if extra > 0 && !live.contains(&s.id) {
                extra -= 1;
                false
            } else {
                true
            }
        });
    }

    // ---- the @ popup ----

    /// The `@` the caret is in the query of: its offset and what follows it.
    fn mention(&self) -> Option<(usize, String)> {
        if self.session.selection().is_some() {
            return None;
        }
        let rope = self.session.rope();
        let caret = self.session.cursor();
        let floor = caret.saturating_sub(MENTION_SCAN);
        let mut i = caret;
        while i > floor {
            let c = rope.char(i - 1);
            if c.is_whitespace() {
                return None;
            }
            if c == '@' {
                let start = i - 1;
                let word_start = start == 0 || rope.char(start - 1).is_whitespace();
                let inside = self
                    .session
                    .atomics()
                    .iter()
                    .any(|a| a.start <= start && start < a.end);
                if !word_start || inside {
                    return None;
                }
                return Some((start, rope.slice(i..caret).to_string()));
            }
            i -= 1;
        }
        None
    }

    fn refresh_mention(&mut self, out: &mut Response) {
        if matches!(self.popup, Some(Popup::Models { .. })) {
            return;
        }
        match self.mention() {
            Some((start, query)) => {
                if self.dismissed == Some(start) {
                    return;
                }
                let same = matches!(
                    &self.popup,
                    Some(Popup::Files { start: s, query: q, .. }) if *s == start && *q == query
                );
                if same {
                    return;
                }
                self.next_token += 1;
                let token = self.next_token;
                let (rows, selected) = match self.popup.take() {
                    Some(Popup::Files { rows, selected, .. }) => (rows, selected),
                    _ => (None, 0),
                };
                self.popup = Some(Popup::Files {
                    start,
                    query: query.clone(),
                    token,
                    rows,
                    selected,
                });
                out.events.push(Event::WantFiles { query, token });
            }
            None => {
                self.dismissed = None;
                if matches!(self.popup, Some(Popup::Files { .. })) {
                    self.popup = None;
                }
            }
        }
    }

    /// The panel's answer to [`Event::WantFiles`]. An answer for any query but
    /// the latest is ignored.
    pub fn files_found(&mut self, token: u64, paths: Vec<String>) {
        if let Some(Popup::Files {
            token: t,
            rows,
            selected,
            ..
        }) = &mut self.popup
            && *t == token
        {
            *selected = (*selected).min(paths.len().saturating_sub(1));
            *rows = Some(paths);
        }
    }

    // ---- models ----

    /// Open the model list with `selected` active. Enter or Tab chooses; Esc
    /// closes it.
    pub fn open_models(&mut self, choices: Vec<ModelChoice>, selected: usize) {
        if choices.is_empty() {
            return;
        }
        let selected = selected.min(choices.len() - 1);
        self.chip = None;
        self.popup = Some(Popup::Models { choices, selected });
    }

    fn close_models(&mut self) {
        if matches!(self.popup, Some(Popup::Models { .. })) {
            self.popup = None;
        }
    }

    // ---- pointer ----

    fn pointer(&mut self, p: PanelPointer, out: &mut Response) {
        use theorem_workbench_core::Button;
        if self.preedit.is_some() {
            return;
        }
        let area = self.area.get();
        let inside = |r: Rect| {
            p.x >= i32::from(r.x)
                && p.x < i32::from(r.x) + i32::from(r.width)
                && p.y >= i32::from(r.y)
                && p.y < i32::from(r.y) + i32::from(r.height)
        };
        let lay = self.layout(area);
        if let PointerKind::Down(Button::Left) = p.kind {
            if let Some(r) = lay.popup.filter(|r| inside(*r)) {
                let row = (p.y - i32::from(r.y)) as usize;
                let first = self.popup_first(usize::from(r.height));
                if let Some(pop) = &mut self.popup
                    && first + row < pop.len()
                {
                    *pop.selected_mut() = first + row;
                    self.choose(out);
                }
                return;
            }
            if let Some(r) = lay.chips.filter(|r| inside(*r)) {
                let x = (p.x - i32::from(r.x)) as u16;
                let hit = self
                    .chip_cells(r.width)
                    .into_iter()
                    .find(|c| x >= c.x && x < c.x + c.width);
                if let Some(c) = hit {
                    self.chip = Some(c.index);
                }
                return;
            }
            if !inside(lay.text) {
                out.handled = false;
                return;
            }
            self.chip = None;
            self.close_models();
        }
        let t = lay.text;
        let routed = match p.kind {
            PointerKind::Wheel { .. } => inside(area),
            PointerKind::Down(_) => inside(t),
            _ => inside(t) || self.view.dragging(),
        };
        if !routed {
            out.handled = false;
            return;
        }
        let q = PanelPointer {
            x: p.x - i32::from(t.x),
            y: p.y - i32::from(t.y),
            ..p
        };
        let r = self.view.pointer(&mut self.session, q);
        if r.handled {
            self.sync_view();
            self.refresh_mention(out);
        } else {
            out.handled = false;
        }
    }

    /// The outcome of the clipboard write a [`Event::Cut`] asked for. Accepted,
    /// and the text it cut is still where it was: the selection is deleted.
    /// Otherwise the draft stays and the footer says "Not cut".
    pub fn cut_finished(&mut self, accepted: bool) -> Response {
        let mut out = Response {
            handled: true,
            events: Vec::new(),
        };
        let Some((a, b, text)) = self.pending_cut.take() else {
            return out;
        };
        let (lo, hi) = (a.min(b), a.max(b));
        let same = hi <= self.session.len() && self.session.rope().slice(lo..hi) == text.as_str();
        if !accepted || !same {
            self.notice = Some("Not cut".to_owned());
            return out;
        }
        self.session.set_selection(a, b);
        match self.session.cut() {
            Ok(_) => self.after_edit(&mut out),
            Err(e) => self.notice = Some(e.to_string()),
        }
        out
    }

    // ---- history ----

    /// The sent prompts Up and Down walk, oldest first; the owner's list,
    /// kept to the most recent [`HISTORY_LIMIT`].
    pub fn set_history(&mut self, history: Vec<String>) {
        let skip = history.len().saturating_sub(HISTORY_LIMIT);
        self.history = history.into_iter().skip(skip).collect();
        self.walk = None;
    }

    /// A prompt was sent: it is now the newest entry (a repeat of the newest
    /// is not added again).
    pub fn push_history(&mut self, prompt: &str) {
        let prompt = prompt.trim();
        if prompt.is_empty() || self.history.last().is_some_and(|l| l == prompt) {
            return;
        }
        self.history.push(prompt.to_owned());
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
        self.walk = None;
    }

    /// A recalled prompt is showing and has not been edited.
    pub fn is_walking_history(&self) -> bool {
        self.walk.is_some()
    }

    fn show_history(&mut self, at: Option<usize>) {
        self.reset_text();
        if let Some(i) = at {
            let text = self.history[i].clone();
            self.session = new_session(&text);
            let end = self.session.len();
            self.session.set_selection(end, end);
            self.sync_view();
            self.view.reveal(&mut self.session);
        }
        self.walk = at;
    }

    fn history_older(&mut self) {
        let at = match self.walk {
            None => self.history.len() - 1,
            Some(i) => i.saturating_sub(1),
        };
        self.show_history(Some(at));
    }

    fn history_newer(&mut self) {
        let Some(i) = self.walk else { return };
        self.show_history((i + 1 < self.history.len()).then_some(i + 1));
    }

    /// Whether the caret is on the first and on the last row of the draft.
    fn row_ends(&self) -> (bool, bool) {
        let c = self.session.cursor();
        let coords = self.session.coords();
        let line = coords.line_of(c);
        let w = usize::from(self.text_rect().width);
        let wrap = if self.session.config().wrap { w } else { 0 };
        let rows = line_rows(
            self.session.rope(),
            line,
            wrap,
            self.session.config().tab_width,
        );
        let at = rows
            .iter()
            .position(|r| c >= r.start && (c < r.end || r.last))
            .unwrap_or(0);
        (
            line == 0 && at == 0,
            line + 1 == coords.line_count() && at + 1 == rows.len(),
        )
    }

    // ---- draft lifetime ----

    /// The draft as it stands, without leaving the composer.
    pub fn draft(&self) -> Draft {
        let (anchor, caret) = (self.session.anchor(), self.session.cursor());
        Draft {
            text: self.session.text(),
            anchor,
            caret,
            references: self.placed(),
            attachments: self.attachments.clone(),
            editing: self.editing.clone(),
        }
    }

    /// The draft leaves with a send: the composer is empty, its undo history
    /// is dropped, and its attachments go with the draft.
    pub fn take(&mut self) -> Draft {
        let d = self.draft();
        self.reset_text();
        self.walk = None;
        self.attachments.clear();
        self.editing = None;
        self.chip = None;
        self.popup = None;
        self.preedit = None;
        self.notice = None;
        d
    }

    /// The owner refused the send, or it failed before anything went: the draft
    /// comes back with its references and attachments. False, and nothing
    /// changes, when the person has already started another draft. When the
    /// outcome is uncertain the panel does not call this.
    pub fn put_back(&mut self, draft: Draft) -> bool {
        if !self.session.is_empty() || !self.placed().is_empty() || !self.attachments.is_empty() {
            return false;
        }
        self.load(&draft.text, draft.anchor, draft.caret, &draft.references);
        if self.attachments.is_empty() {
            self.attachments = draft.attachments;
        }
        self.editing = draft.editing;
        true
    }

    /// Load a sent message so Enter returns `Submit { mode: Edit }`. `references`
    /// are matched to their `@path` text; one the text does not show is added at the end.
    pub fn load_for_edit(&mut self, text: &str, references: Vec<SourceReference>) {
        self.reset_text();
        self.attachments.clear();
        self.session = new_session(text);
        self.sync_view();
        let mut missing = Vec::new();
        for r in references {
            let token = reference_token(&r);
            let hay = self.session.text();
            let found = hay.match_indices(&token).find_map(|(b, _)| {
                let s = hay[..b].chars().count();
                let e = s + token.chars().count();
                let taken = self
                    .session
                    .atomics()
                    .iter()
                    .any(|a| s < a.end && a.start < e);
                (!taken).then_some((s, e))
            });
            match found.and_then(|(s, e)| self.session.mark_atomic(s, e).ok()) {
                Some(id) => self.slots.push(Slot { id, reference: r }),
                None => missing.push(r),
            }
        }
        let end = self.session.len();
        self.session.set_selection(end, end);
        for r in missing {
            self.insert_reference(r, None);
        }
        self.editing = Some(self.session.text());
        let mut sink = Response::default();
        self.after_edit(&mut sink);
        self.session.break_undo_group();
    }

    fn reset_text(&mut self) {
        self.session = new_session("");
        self.slots.clear();
        self.popup = None;
        self.dismissed = None;
        self.composing_early = None;
        self.suppress = None;
        self.revision = 0;
        self.sync_view();
    }

    fn load(&mut self, text: &str, anchor: usize, caret: usize, refs: &[PlacedReference]) {
        self.reset_text();
        self.session = new_session(text);
        for p in refs {
            let token = reference_token(&p.reference);
            let ok = text
                .chars()
                .skip(p.start)
                .take(p.end.saturating_sub(p.start))
                .collect::<String>()
                == token;
            if ok && let Ok(id) = self.session.mark_atomic(p.start, p.end) {
                self.slots.push(Slot {
                    id,
                    reference: p.reference.clone(),
                });
            }
        }
        self.session.set_selection(anchor, caret);
        self.sync_view();
        self.view.reveal(&mut self.session);
    }

    /// Text, caret, selection and references, for a saved layout.
    pub fn serialize(&self) -> Value {
        let d = self.draft();
        json!({
            "text": d.text,
            "anchor": d.anchor,
            "caret": d.caret,
            "references": d.references,
        })
    }

    /// The inverse of [`serialize`](Self::serialize). A plain string is a draft
    /// with no references. False when the value is neither.
    pub fn restore(&mut self, value: &Value) -> bool {
        if let Some(text) = value.as_str() {
            self.load(text, text.chars().count(), text.chars().count(), &[]);
            return true;
        }
        let Some(text) = value["text"].as_str() else {
            return false;
        };
        let refs: Vec<PlacedReference> =
            serde_json::from_value(value["references"].clone()).unwrap_or_default();
        let len = text.chars().count();
        let anchor = value["anchor"].as_u64().map_or(len, |n| n as usize);
        let caret = value["caret"].as_u64().map_or(len, |n| n as usize);
        self.load(text, anchor.min(len), caret.min(len), &refs);
        true
    }

    // ---- geometry ----

    /// The view gets exactly the text cells; it draws without a gutter.
    fn sync_view(&mut self) {
        let t = self.text_rect();
        self.view.set_gutter(false);
        if self.view.size() != (t.width, t.height) {
            self.view.resize(&mut self.session, t.width, t.height);
        }
    }

    pub(crate) fn text_rect(&self) -> Rect {
        self.layout(self.area.get()).text
    }

    fn caret_cell(&self) -> Option<(u16, u16)> {
        let area = self.area.get();
        let t = self.layout(area).text;
        if t.width == 0 || t.height == 0 {
            return None;
        }
        let c = self.view.caret_cell(&self.session, t)?;
        let pre = self.preedit.as_deref().map_or(0, |p| {
            u16::try_from(crate::view::width(p)).unwrap_or(u16::MAX)
        });
        let x = c.x.saturating_sub(t.x).saturating_add(pre).min(t.width - 1);
        Some((t.x + x, c.y))
    }

    /// How many rows the composer wants at `width` cells: the chip row, the
    /// text up to `max_rows` (then it scrolls), a popup, and the footer.
    pub fn desired_height(&self, width: u16, max_rows: u16) -> u16 {
        let rows = self.total_rows(width);
        let text = rows.clamp(1, usize::from(max_rows.max(1))) as u16;
        let chips = u16::from(!self.attachments.is_empty());
        let popup = self.popup_height();
        chips + text + popup + 1
    }

    pub(crate) fn popup_height(&self) -> u16 {
        self.popup
            .as_ref()
            .map_or(0, |p| p.len().clamp(1, POPUP_ROWS) as u16)
    }

    /// The first row of a popup that shows `rows` rows.
    pub(crate) fn popup_first(&self, rows: usize) -> usize {
        let s = self.popup.as_ref().map_or(0, Popup::selected);
        if rows == 0 || s < rows {
            0
        } else {
            s + 1 - rows
        }
    }
}
