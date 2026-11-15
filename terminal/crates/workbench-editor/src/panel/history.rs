//! The history drawer: the points the owner can put the document back to,
//! the text of the one chosen shown read-only and labelled as a past version,
//! and the restore, which is the person's alone and asks first.
//!
//! The drawer takes the place of the text while it is open and every key is
//! its own, so nothing typed can reach the document behind it. What it shows
//! of a past version is held here and never enters the session: after an
//! accepted restore the editor shows what the owner reports through the
//! ordinary change path. An answer is for one drawer and, for a preview, one
//! point; one that arrives for another is not shown.

use std::cell::RefCell;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{DocumentHistoryPoint, EffectBody};
use theorem_workbench_core::ids::{Actor, Revision as CoreRevision};
use theorem_workbench_core::semantics::{Node, Role};
use theorem_workbench_core::{Ctx, PanelPointer, PointerKind, ViewCtx};
use theorem_workbench_text::visible::visible;
use unicode_width::UnicodeWidthStr;

use super::chrome::{shorten_path, take_cells, wrap};
use super::flow::emit_notice;
use super::{Doc, EditorPanel, Task, Tone};
use crate::actions::Choice;

/// The most points listed rows show at once.
const LIST_MAX: usize = 8;

/// The most of a past version that is kept to show. A longer text is cut at a
/// character and says so.
pub(crate) const PREVIEW_LIMIT: usize = 256 * 1024;

/// One point of the document's history.
pub(crate) struct Entry {
    /// The owner's name for it, handed back to preview and restore.
    point: String,
    /// The revision the document had there, as the person reads it.
    label: String,
    /// The same, when the owner orders its revisions.
    seq: Option<u64>,
}

pub(crate) enum Listing {
    Loading,
    Listed(Vec<Entry>),
    /// Why there is no list, in the owner's words.
    Failed(String),
}

/// The text of a past version, kept apart from the document.
pub(crate) struct Past {
    /// Its lines, escaped for display; wrapped on demand.
    lines: Vec<String>,
    /// The text was longer than [`PREVIEW_LIMIT`] and was cut.
    cut: bool,
    /// The lines wrapped at the width last drawn, so a frame does not wrap
    /// them again.
    wrapped: RefCell<Option<(u16, Vec<String>)>>,
}

impl Past {
    fn new(text: &str) -> Self {
        let (text, cut) = if text.len() > PREVIEW_LIMIT {
            let mut end = PREVIEW_LIMIT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            (&text[..end], true)
        } else {
            (text, false)
        };
        let lines = text
            .split('\n')
            .map(|line| visible(&line.trim_end_matches('\r').replace('\t', "    ")))
            .collect();
        Self {
            lines,
            cut,
            wrapped: RefCell::new(None),
        }
    }

    /// The rows at `width` cells.
    fn rows(&self, width: u16) -> Vec<String> {
        let mut cache = self.wrapped.borrow_mut();
        match &*cache {
            Some((w, rows)) if *w == width => rows.clone(),
            _ => {
                let rows: Vec<String> = self.lines.iter().flat_map(|l| wrap(l, width)).collect();
                *cache = Some((width, rows.clone()));
                rows
            }
        }
    }
}

pub(crate) enum Preview {
    /// Asked for, and not answered.
    Loading(String),
    Shown(String, Past),
    /// The owner did not give it, in its words.
    Failed(String, String),
}

impl Preview {
    fn point(&self) -> &str {
        match self {
            Self::Loading(p) | Self::Shown(p, _) | Self::Failed(p, _) => p,
        }
    }
}

/// Where a restore stands.
pub(crate) enum Restoring {
    Idle,
    Sent,
    /// The owner did not say whether it restored. Not sent again by guess.
    Unknown(String),
}

pub(crate) struct History {
    /// Tells this drawer from one opened after it, so a late answer is known.
    pub id: u64,
    pub list: Listing,
    pub selected: usize,
    /// The first listed point shown.
    pub top: usize,
    pub preview: Option<Preview>,
    /// A preview is asked for and not answered: one at a time.
    pub asking: bool,
    /// The first row of the past version shown.
    pub scroll: usize,
    /// The point a restore waits for the person's yes on.
    pub confirm: Option<String>,
    pub restoring: Restoring,
}

impl History {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            list: Listing::Loading,
            selected: 0,
            top: 0,
            preview: None,
            asking: false,
            scroll: 0,
            confirm: None,
            restoring: Restoring::Idle,
        }
    }

    fn entries(&self) -> &[Entry] {
        match &self.list {
            Listing::Listed(entries) => entries,
            _ => &[],
        }
    }

    fn entry(&self) -> Option<&Entry> {
        self.entries().get(self.selected)
    }

    /// The preview that belongs to the point chosen, if it is here.
    fn shown(&self) -> Option<&Preview> {
        let point = &self.entry()?.point;
        self.preview.as_ref().filter(|p| p.point() == point)
    }

    /// Choose another point; what was asked about it is no longer asked.
    fn choose(&mut self, to: usize, rows: usize) {
        let last = self.entries().len().saturating_sub(1);
        self.selected = to.min(last);
        self.confirm = None;
        self.scroll = 0;
        self.top = window(self.selected, self.top, rows);
    }
}

/// `top` moved as little as it takes for `selected` to be one of `rows`.
fn window(selected: usize, top: usize, rows: usize) -> usize {
    let rows = rows.max(1);
    if selected < top {
        selected
    } else if selected >= top + rows {
        selected + 1 - rows
    } else {
        top
    }
}

/// Where the parts of the drawer are in its area.
#[derive(Clone, Copy)]
pub(crate) struct Parts {
    pub header: Rect,
    pub list: Rect,
    pub rule: Rect,
    pub preview: Rect,
}

fn parts(area: Rect, entries: usize) -> Parts {
    let header = Rect::new(area.x, area.y, area.width, area.height.min(1));
    let rest = area.height.saturating_sub(1);
    let want = entries.clamp(1, LIST_MAX) as u16;
    let list_rows = if rest <= 1 {
        rest
    } else {
        want.min(rest - 2).min(rest.div_ceil(2)).max(1)
    };
    let rule_rows = u16::from(rest > list_rows);
    let below = rest - list_rows - rule_rows;
    let y = area.y + header.height;
    Parts {
        header,
        list: Rect::new(area.x, y, area.width, list_rows),
        rule: Rect::new(area.x, y + list_rows, area.width, rule_rows),
        preview: Rect::new(area.x, y + list_rows + rule_rows, area.width, below),
    }
}

fn label_of(revision: &CoreRevision) -> (String, Option<u64>) {
    match revision {
        CoreRevision::Seq(n) => (n.to_string(), Some(*n)),
        CoreRevision::Opaque(token) => (take_cells(&visible(token), 24), None),
    }
}

/// What an owner's refusal says: its reason, then its code.
fn refusal(code: &str, reason: &str) -> String {
    visible(&format!("{reason} ({code})"))
}

impl EditorPanel {
    fn history(&self) -> Option<&History> {
        self.doc()?.history.as_ref()
    }

    pub(super) fn history_open(&self) -> bool {
        self.history().is_some()
    }

    fn history_mut(&mut self) -> Option<&mut History> {
        self.doc_mut()?.history.as_mut()
    }

    /// The drawer's parts in the editor's text area now.
    pub(super) fn history_parts(&self) -> Option<Parts> {
        let area = Rect::new(0, 0, self.body.0, self.body.1);
        let text = self.frame(area)?.text;
        Some(parts(text, self.history()?.entries().len()))
    }

    // ---- the choices -------------------------------------------------------

    /// Why the history choices cannot be done now.
    pub(super) fn history_unavailable(&self, choice: Choice, d: &Doc) -> Option<String> {
        let read_only = || d.sync.read_only.clone().map(|r| format!("Read-only: {r}"));
        match choice {
            Choice::AddSelection => d.history.as_ref().map(|_| {
                "The history shows a past version; close it to add text from the document."
                    .to_owned()
            }),
            Choice::History => {
                if !self.documents {
                    Some("The document service is not available in this workspace.".to_owned())
                } else if d.rename.is_some() || self.naming.is_some() {
                    Some("Finish the name being typed first.".to_owned())
                } else {
                    None
                }
            }
            Choice::Restore | Choice::RestoreConfirm => {
                let Some(h) = d.history.as_ref() else {
                    return Some("Open the history first.".to_owned());
                };
                if !self.documents {
                    return Some("The document service is not available in this workspace.".into());
                }
                match &h.restoring {
                    Restoring::Sent => return Some("A restore is already in flight.".to_owned()),
                    Restoring::Unknown(reason) => {
                        return Some(format!(
                            "Unknown if the document was restored ({reason}); it is not sent again by guess. Open the history again to choose again."
                        ));
                    }
                    Restoring::Idle => {}
                }
                if let Some(r) = read_only() {
                    return Some(format!("{r}; a restore would be refused."));
                }
                // The owner sees only the edits that reached it or were kept;
                // typing held here is invisible to it, so nothing is sent
                // while any is unsettled.
                if d.session.has_pending()
                    || d.session.has_conflict()
                    || d.sync.inflight.is_some()
                    || d.sync.unknown.is_some()
                    || d.sync.held.is_some()
                    || d.sync.restored.is_some()
                {
                    return Some(
                        "There is typing the owner has not accepted (sent, held, unknown or recovered); it has to be sent, saved or discarded first, so nothing is restored."
                            .to_owned(),
                    );
                }
                if choice == Choice::RestoreConfirm {
                    return h
                        .confirm
                        .is_none()
                        .then(|| "No restore is waiting for your yes.".to_owned());
                }
                if h.confirm.is_some() {
                    return Some("Confirm the restore or keep the current text.".to_owned());
                }
                match (&h.list, h.entry()) {
                    (Listing::Loading, _) => Some("The history is still loading.".to_owned()),
                    (Listing::Failed(_), _) => Some("The history could not be read.".to_owned()),
                    (Listing::Listed(_), None) => {
                        Some("There is no earlier version to restore.".to_owned())
                    }
                    (Listing::Listed(_), Some(_)) => match h.shown() {
                        Some(Preview::Shown(..)) => None,
                        Some(Preview::Failed(..)) => Some(
                            "This version could not be shown, so it is not restored unseen."
                                .to_owned(),
                        ),
                        _ => Some("Wait for this version to be shown first.".to_owned()),
                    },
                }
            }
            _ => None,
        }
    }

    /// Open the drawer and ask the owner for the points.
    pub(super) fn open_history(&mut self, cx: &mut Ctx) {
        self.drawers += 1;
        let drawer = self.drawers;
        match self.start(
            cx,
            Task::HistoryList { drawer },
            EffectBody::DocumentHistoryList,
            None,
        ) {
            Ok(_) => {
                if let Some(d) = self.doc_mut() {
                    d.popup = None;
                    d.history = Some(History::new(drawer));
                }
            }
            Err(e) => self.say(emit_notice(e), Tone::Warn),
        }
    }

    /// Esc, or the choice that dismisses: a restore waiting for a yes is
    /// called off first, then the drawer closes. Nothing is changed.
    pub(super) fn dismiss_history(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        match d.history.as_mut() {
            Some(h) if h.confirm.is_some() => h.confirm = None,
            _ => d.history = None,
        }
    }

    /// Ask for the person's yes. Nothing is sent.
    pub(super) fn ask_restore(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        let Some(point) = d
            .history
            .as_ref()
            .and_then(|h| h.entry())
            .map(|e| e.point.clone())
        else {
            return;
        };
        if let Some(h) = d.history.as_mut() {
            h.confirm = Some(point);
        }
    }

    /// The person said yes: send the restore.
    pub(super) fn send_restore(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let Some(h) = d.history.as_mut() else { return };
        let Some(point) = h.confirm.take() else {
            return;
        };
        let drawer = h.id;
        let label = h
            .entries()
            .iter()
            .find(|e| e.point == point)
            .map(|e| e.label.clone())
            .unwrap_or_default();
        let body = EffectBody::DocumentHistoryRestore(DocumentHistoryPoint { point });
        match self.start(cx, Task::HistoryRestore { drawer, label }, body, None) {
            Ok(_) => {
                if let Some(h) = self.history_mut() {
                    h.restoring = Restoring::Sent;
                }
            }
            Err(e) => self.say(emit_notice(e), Tone::Warn),
        }
    }

    /// A restore is the person's: an agent's call is refused before it can
    /// change what the drawer asks.
    pub(super) fn restore_refused(&mut self, choice: Choice, cx: &Ctx) -> bool {
        if !matches!(choice, Choice::Restore | Choice::RestoreConfirm)
            || !matches!(cx.actor(), Actor::Agent { .. })
        {
            return false;
        }
        self.say(
            "Restoring a version is for you to do; the agent may read the history but not restore it.",
            Tone::Warn,
        );
        true
    }

    // ---- keys and the pointer ----------------------------------------------

    /// A key while the drawer is open. Every key is the drawer's.
    pub(super) fn history_key(&mut self, key: &KeyInput, cx: &mut Ctx) {
        let mods = key.mods();
        let rows = self
            .history_parts()
            .map_or(1, |p| usize::from(p.list.height));
        let page = self.history_parts().map_or(1, |p| {
            usize::from(p.preview.height).saturating_sub(1).max(1)
        });
        let waiting = self.history().is_some_and(|h| h.confirm.is_some());
        match key.key() {
            Key::Esc => self.choose(Choice::Dismiss, cx),
            Key::Enter if waiting => self.choose(Choice::RestoreConfirm, cx),
            Key::Enter => self.choose(Choice::Restore, cx),
            Key::Char('v' | 'V') if mods.contains(Mods::ALT) => self.choose(Choice::History, cx),
            _ if waiting => {}
            Key::Up => self.history_step(-1, rows),
            Key::Down => self.history_step(1, rows),
            Key::Home => self.history_to(0, rows),
            Key::End => self.history_to(usize::MAX, rows),
            Key::PageDown => self.history_scroll(page as isize),
            Key::PageUp => self.history_scroll(-(page as isize)),
            _ => {}
        }
    }

    fn history_step(&mut self, by: isize, rows: usize) {
        let Some(h) = self.history_mut() else { return };
        let to = h.selected.saturating_add_signed(by);
        h.choose(to, rows);
    }

    fn history_to(&mut self, to: usize, rows: usize) {
        if let Some(h) = self.history_mut() {
            h.choose(to, rows);
        }
    }

    fn history_scroll(&mut self, by: isize) {
        let width = self.history_parts().map_or(1, |p| p.preview.width);
        let height = self
            .history_parts()
            .map_or(1, |p| usize::from(p.preview.height));
        let Some(h) = self.history_mut() else { return };
        let total = match h.shown() {
            Some(Preview::Shown(_, past)) => past.rows(width).len(),
            _ => 0,
        };
        let last = total.saturating_sub(height);
        h.scroll = h.scroll.saturating_add_signed(by).min(last);
    }

    /// The pointer over the drawer: a press on a point chooses it, the wheel
    /// moves the part it is over.
    pub(super) fn history_pointer(&mut self, p: &PanelPointer) {
        let Some(parts) = self.history_parts() else {
            return;
        };
        let inside = |r: Rect| {
            p.x >= i32::from(r.x)
                && p.x < i32::from(r.x + r.width)
                && p.y >= i32::from(r.y)
                && p.y < i32::from(r.y + r.height)
        };
        match p.kind {
            PointerKind::Down(_) if inside(parts.list) => {
                let row = usize::try_from(p.y - i32::from(parts.list.y)).unwrap_or(0);
                let rows = usize::from(parts.list.height);
                if let Some(h) = self.history_mut() {
                    let at = h.top + row;
                    if at < h.entries().len() && h.confirm.is_none() {
                        h.choose(at, rows);
                    }
                }
            }
            PointerKind::Wheel { dy, .. } if inside(parts.list) => {
                let rows = usize::from(parts.list.height);
                if let Some(h) = self.history_mut() {
                    let most = h.entries().len().saturating_sub(rows);
                    h.top = h
                        .top
                        .saturating_add_signed(isize::from(dy.signum()))
                        .min(most);
                }
            }
            PointerKind::Wheel { dy, .. } if inside(parts.preview) => {
                self.history_scroll(isize::from(dy.signum()) * 3);
            }
            _ => {}
        }
    }

    // ---- what the owner answers ---------------------------------------------

    /// Ask for the text of the point chosen, one at a time. A call that
    /// cannot start work leaves it for the next message.
    pub(super) fn history_pump(&mut self, cx: &mut Ctx) {
        let (drawer, point) = {
            let Some(h) = self.history() else { return };
            let Some(entry) = h.entry() else { return };
            if h.asking || h.preview.as_ref().is_some_and(|p| p.point() == entry.point) {
                return;
            }
            (h.id, entry.point.clone())
        };
        let body = EffectBody::DocumentHistoryPreview(DocumentHistoryPoint {
            point: point.clone(),
        });
        let task = Task::HistoryPreview {
            drawer,
            point: point.clone(),
        };
        if self.start(cx, task, body, None).is_ok()
            && let Some(h) = self.history_mut()
        {
            h.asking = true;
            h.preview = Some(Preview::Loading(point));
        }
    }

    pub(super) fn on_history_list(&mut self, drawer: u64, c: Completion) {
        let accepted = self.accepted();
        let Some(h) = self.history_mut().filter(|h| h.id == drawer) else {
            return;
        };
        h.list = match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentHistory(list))) => {
                let entries = list
                    .entries
                    .iter()
                    .map(|e| {
                        let (label, seq) = label_of(&e.revision);
                        Entry {
                            point: e.point.clone(),
                            label,
                            seq,
                        }
                    })
                    .collect();
                Listing::Listed(entries)
            }
            (Outcome::Accepted, _) => Listing::Failed("The owner sent no history.".to_owned()),
            (Outcome::Refused { code, reason }, _) => {
                Listing::Failed(format!("Refused: {}", refusal(&code, &reason)))
            }
            (Outcome::Failed { reason }, _) => Listing::Failed(format!(
                "The history could not be read: {}",
                visible(&reason)
            )),
            (Outcome::Uncertain { reason }, _) => Listing::Failed(format!(
                "Unknown if the history was read: {}",
                visible(&reason)
            )),
        };
        h.selected = 0;
        h.top = 0;
        // The newest point that is the live revision is the one already here;
        // the list does not hide it.
        let _ = accepted;
    }

    pub(super) fn on_history_preview(&mut self, drawer: u64, point: String, c: Completion) {
        let Some(h) = self.history_mut().filter(|h| h.id == drawer) else {
            return;
        };
        h.asking = false;
        let current = h.entry().is_some_and(|e| e.point == point);
        if !current {
            // The person moved on: this is not what is shown now, and the
            // next ask is for the point chosen.
            if h.preview.as_ref().is_some_and(|p| p.point() == point) {
                h.preview = None;
            }
            return;
        }
        h.scroll = 0;
        h.preview = Some(match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentPreview(text))) => {
                Preview::Shown(point, Past::new(&text.text))
            }
            (Outcome::Accepted, _) => {
                Preview::Failed(point, "The owner sent no text for it.".to_owned())
            }
            (Outcome::Refused { code, reason }, _) => {
                Preview::Failed(point, format!("Refused: {}", refusal(&code, &reason)))
            }
            (Outcome::Failed { reason }, _) => {
                Preview::Failed(point, format!("It could not be read: {}", visible(&reason)))
            }
            (Outcome::Uncertain { reason }, _) => Preview::Failed(
                point,
                format!("Unknown if it was read: {}", visible(&reason)),
            ),
        });
    }

    pub(super) fn on_history_restore(&mut self, drawer: u64, label: &str, c: Completion) {
        let same = self.history().is_some_and(|h| h.id == drawer);
        let (tone, text) = match c.outcome {
            Outcome::Accepted => (
                Tone::Info,
                format!(
                    "Restored to revision {label}. The owner's text arrives as the document's own change."
                ),
            ),
            Outcome::Refused { code, reason } => (
                Tone::Warn,
                format!("Not restored: {}", refusal(&code, &reason)),
            ),
            Outcome::Failed { reason } => (
                Tone::Error,
                format!("The document was not restored: {}", visible(&reason)),
            ),
            Outcome::Uncertain { reason } => (
                Tone::Warn,
                format!("Unknown if the document was restored: {}", visible(&reason)),
            ),
        };
        let accepted = tone == Tone::Info;
        let unknown = text.starts_with("Unknown");
        if let Some(d) = self.doc_mut() {
            if same && let Some(h) = d.history.as_mut() {
                h.restoring = if unknown {
                    Restoring::Unknown(text.clone())
                } else {
                    Restoring::Idle
                };
            }
            if same && accepted {
                d.history = None;
            }
            d.notice(text, tone);
        }
    }

    fn accepted(&self) -> Option<u64> {
        self.doc().map(|d| d.session.accepted_revision())
    }

    // ---- what is shown --------------------------------------------------------

    /// The strip for the drawer: the question when a restore waits for a yes,
    /// else how to choose one.
    pub(super) fn history_strip(
        &self,
        d: &Doc,
        confirming: bool,
    ) -> Option<(String, Tone, Vec<Choice>)> {
        let h = d.history.as_ref()?;
        match &h.confirm {
            Some(_) if !confirming => None,
            None if confirming => None,
            Some(point) => {
                let label = h
                    .entries()
                    .iter()
                    .find(|e| &e.point == point)
                    .map_or("", |e| e.label.as_str());
                let mut text = format!(
                    "Restore the document to revision {label}? The text in the editor is replaced by that version."
                );
                if d.dirty() {
                    text.push_str(" Your unsaved changes are lost.");
                }
                if d.session.has_pending() {
                    text.push_str(
                        " Text you typed that the owner has not accepted yet is lost too, and the owner may refuse until it has.",
                    );
                }
                Some((
                    text,
                    Tone::Warn,
                    vec![Choice::RestoreConfirm, Choice::Dismiss],
                ))
            }
            None => Some((
                "A past version, read-only. Up and Down choose, Enter restores after you confirm."
                    .to_owned(),
                Tone::Info,
                vec![Choice::Restore, Choice::Dismiss],
            )),
        }
    }

    pub(super) fn draw_history(&self, d: &Doc, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        let Some(h) = d.history.as_ref() else { return };
        let p = parts(area, h.entries().len());
        let accepted = d.session.accepted_revision();
        let width = usize::from(area.width);

        // The title.
        if p.header.height > 0 {
            buf.set_style(p.header, cx.theme.line);
            let mut title = format!(
                "History of {}",
                shorten_path(&visible(&self.path), width.saturating_sub(12))
            );
            if let Restoring::Unknown(_) = h.restoring {
                title.push_str(" (unknown if restored)");
            } else if let Restoring::Sent = h.restoring {
                title.push_str(" (restoring)");
            }
            buf.set_stringn(p.header.x, p.header.y, &title, width, cx.theme.text);
        }

        // The points, or why there are none.
        let mut say = |lines: Vec<String>, style| {
            for (i, line) in lines.iter().take(usize::from(p.list.height)).enumerate() {
                buf.set_stringn(p.list.x, p.list.y + i as u16, line, width, style);
            }
        };
        match &h.list {
            Listing::Loading => say(
                vec!["Loading the history\u{2026}".to_owned()],
                cx.theme.muted,
            ),
            Listing::Failed(reason) => say(wrap(reason, area.width), cx.theme.error),
            Listing::Listed(entries) if entries.is_empty() => say(
                vec!["There are no earlier versions to restore.".to_owned()],
                cx.theme.muted,
            ),
            Listing::Listed(entries) => {
                for (row, entry) in entries
                    .iter()
                    .enumerate()
                    .skip(h.top)
                    .take(usize::from(p.list.height))
                {
                    let y = p.list.y + (row - h.top) as u16;
                    let chosen = row == h.selected;
                    let mut text = format!(
                        "{} Revision {}",
                        if chosen { '>' } else { ' ' },
                        entry.label
                    );
                    if entry.seq == Some(accepted) {
                        text.push_str(" (this text's revision)");
                    }
                    let style = if chosen {
                        cx.theme.selected
                    } else {
                        cx.theme.text
                    };
                    buf.set_style(Rect::new(p.list.x, y, p.list.width, 1), style);
                    buf.set_stringn(p.list.x, y, &text, width, style);
                }
            }
        }

        // What the chosen point had, labelled as what it is.
        let (rule, body) = self.past_lines(h, p.preview.width);
        if p.rule.height > 0 {
            buf.set_style(p.rule, cx.theme.line);
            buf.set_stringn(p.rule.x, p.rule.y, &rule, width, cx.theme.warning);
        }
        let bar = "\u{2502} ";
        let room = usize::from(p.preview.width).saturating_sub(bar.width());
        for (i, line) in body
            .iter()
            .skip(h.scroll)
            .take(usize::from(p.preview.height))
            .enumerate()
        {
            let y = p.preview.y + i as u16;
            buf.set_stringn(p.preview.x, y, bar, width, cx.theme.muted);
            buf.set_stringn(
                p.preview.x + bar.width() as u16,
                y,
                line,
                room,
                cx.theme.text,
            );
        }
    }

    /// The label above the past version, and its rows at `width` less the
    /// bar drawn beside them.
    fn past_lines(&self, h: &History, width: u16) -> (String, Vec<String>) {
        let inner = width.saturating_sub(2).max(1);
        let Some(entry) = h.entry() else {
            return ("No version chosen.".to_owned(), vec![]);
        };
        match h.shown() {
            Some(Preview::Shown(_, past)) => {
                let mut rule = format!(
                    "Past version, revision {} \u{2022} read-only, not the live text",
                    entry.label
                );
                if past.cut {
                    rule.push_str(&format!(
                        " \u{2022} first {} KiB only",
                        PREVIEW_LIMIT / 1024
                    ));
                }
                (rule, past.rows(inner))
            }
            Some(Preview::Failed(_, why)) => (
                format!("Past version, revision {} could not be shown", entry.label),
                wrap(why, inner),
            ),
            _ => (format!("Loading revision {}\u{2026}", entry.label), vec![]),
        }
    }

    /// The drawer's nodes: the dialog, its list of points, the past version,
    /// each with what it offers. `rect` is the text area it fills; `focused` is
    /// whether the panel owns the keyboard.
    pub(super) fn history_nodes(&self, d: &Doc, rect: Rect, focused: bool) -> Vec<Node> {
        let Some(h) = d.history.as_ref() else {
            return vec![];
        };
        let p = parts(rect, h.entries().len());
        let accepted = d.session.accepted_revision();
        let mut dialog = Node::new(
            "history",
            Role::Dialog,
            &format!("History of {}", visible(&self.path)),
            rect,
        );
        dialog.binding = self.resource();
        dialog.state.focused = focused;
        dialog.state.busy =
            matches!(h.list, Listing::Loading) || matches!(h.restoring, Restoring::Sent);
        dialog.actions = [Choice::Restore, Choice::History, Choice::Dismiss]
            .into_iter()
            .map(|c| self.action(c))
            .collect();
        dialog.state.description = match &h.restoring {
            Restoring::Unknown(why) => Some(why.clone()),
            _ => None,
        };
        let mut list = Node::new("history-list", Role::List, "Versions, newest first", p.list);
        list.state.busy = matches!(h.list, Listing::Loading);
        list.state.description = match &h.list {
            Listing::Loading => Some("Loading the history.".to_owned()),
            Listing::Failed(why) => Some(why.clone()),
            Listing::Listed(entries) if entries.is_empty() => {
                Some("There are no earlier versions to restore.".to_owned())
            }
            Listing::Listed(entries) => Some(format!("{} versions", entries.len())),
        };
        let mut out = vec![];
        let total = h.entries().len();
        for (i, entry) in h.entries().iter().enumerate() {
            let row = i
                .checked_sub(h.top)
                .filter(|r| *r < usize::from(p.list.height))
                .map_or_else(
                    || Rect::new(p.list.x, p.list.y, 0, 0),
                    |r| Rect::new(p.list.x, p.list.y + r as u16, p.list.width, 1),
                );
            let mut item = Node::new(
                &format!("history:{i}"),
                Role::ListItem,
                &format!("Revision {}", entry.label),
                row,
            );
            item.state.selected = i == h.selected;
            item.state.description =
                (entry.seq == Some(accepted)).then(|| "This text's revision.".to_owned());
            item.pos_in_set = u16::try_from(i + 1).ok();
            item.set_size = u16::try_from(total).ok();
            item.actions = vec![self.action(Choice::Restore)];
            list.children.push(item.id.clone());
            out.push(item);
        }
        let (rule, body) = self.past_lines(h, p.preview.width);
        let mut past = Node::new("history-preview", Role::Document, &rule, p.preview);
        past.state.busy = !matches!(h.shown(), Some(Preview::Shown(..) | Preview::Failed(..)))
            && h.entry().is_some();
        if let Some(Preview::Shown(_, _)) = h.shown() {
            past = past.with_text(&body.join("\n"));
        } else if let Some(Preview::Failed(_, why)) = h.shown() {
            past.state.description = Some(why.clone());
        }
        dialog.children = vec![list.id.clone(), past.id.clone()];
        let mut all = vec![dialog, list];
        all.extend(out);
        all.push(past);
        all
    }
}

#[cfg(test)]
mod tests {
    use super::{Past, parts, window};
    use ratatui::layout::Rect;

    #[test]
    fn the_window_moves_as_little_as_it_takes() {
        assert_eq!(window(0, 0, 4), 0);
        assert_eq!(window(3, 0, 4), 0);
        assert_eq!(window(4, 0, 4), 1);
        assert_eq!(window(2, 5, 4), 2);
    }

    #[test]
    fn the_parts_fill_the_area_and_leave_the_preview_the_rest() {
        let p = parts(Rect::new(0, 0, 40, 30), 20);
        assert_eq!(
            p.header.height + p.list.height + p.rule.height + p.preview.height,
            30
        );
        assert_eq!(p.list.height, 8);
        let tiny = parts(Rect::new(0, 0, 40, 3), 5);
        assert_eq!(
            tiny.header.height + tiny.list.height + tiny.rule.height + tiny.preview.height,
            3
        );
        let none = parts(Rect::new(0, 0, 40, 0), 5);
        assert_eq!(none.list.height + none.preview.height, 0);
    }

    #[test]
    fn a_past_version_is_escaped_and_cut_at_a_character() {
        let past = Past::new("a\u{1b}[31mred\nb\tc\r\n");
        let rows = past.rows(40);
        assert!(rows[0].contains("\\u{1b}"), "{rows:?}");
        assert_eq!(rows[1], "b    c");
        let long = "\u{e9}".repeat(super::PREVIEW_LIMIT);
        let cut = Past::new(&long);
        assert!(cut.cut);
        assert!(cut.lines[0].len() <= super::PREVIEW_LIMIT);
    }
}
