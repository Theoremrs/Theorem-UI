//! What the panel shows around the text (the mode bar, the strip with the
//! conflicts and refusals and the choices they offer, the status line), the
//! phases before there is a document, the four modes drawn, and the semantic
//! nodes.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Widget, Wrap};
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::host::{ConnectionState, LocalStatus};
use theorem_workbench_core::ids::Revision as CoreRevision;
use theorem_workbench_core::semantics::{Node, NodeAction, NodeId, Role};
use theorem_workbench_editor::Paint;
use theorem_workbench_markdown::{MarkdownMode, TargetBlock};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::{Doc, MarkdownPanel, Phase, Tone};
use crate::actions::Choice;
use crate::links::{self, Target};
use crate::styles::MarkdownPanelStyles;

/// Where each part of a ready panel is.
pub(super) struct Frame {
    pub bar: Option<Rect>,
    pub text: Rect,
    pub strip: Option<Rect>,
    pub status: Option<Rect>,
}

struct Strip {
    text: String,
    tone: Tone,
    buttons: Vec<Choice>,
    /// Both revisions of something are on show.
    conflict: bool,
}

impl Strip {
    /// Rows wanted: the text, wrapped with a row of slack, and the buttons.
    fn rows(&self, width: u16) -> u16 {
        let cells = self.text.width();
        let w = usize::from(width.max(1));
        let text = (cells.div_ceil(w) + usize::from(cells > w)).clamp(1, 3) as u16;
        text + u16::from(!self.buttons.is_empty())
    }
}

/// One line of a snippet of text: line breaks shown, long text cut.
fn snip(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in text.chars() {
        let c = if c == '\n' || c == '\r' { '\u{b6}' } else { c };
        let w = c.width().unwrap_or(0);
        if n + w > max {
            out.push('\u{2026}');
            break;
        }
        out.push(c);
        n += w;
    }
    out
}

fn label(choice: Choice) -> String {
    let d = choice.descriptor();
    if d.chord.is_empty() {
        format!("[{}]", d.title)
    } else {
        format!("[{} {}]", d.title, d.chord)
    }
}

fn mode_title(mode: MarkdownMode) -> &'static str {
    match mode {
        MarkdownMode::Visual => "Visual",
        MarkdownMode::Source => "Source",
        MarkdownMode::Split => "Split",
        MarkdownMode::Preview => "Preview",
    }
}

/// A block's kind in words. The kinds the reading view has no rendering for
/// are named as the source they are shown as.
pub(super) fn kind_name(kind: TargetBlock) -> String {
    match kind {
        TargetBlock::Paragraph => "paragraph".to_owned(),
        TargetBlock::Heading(n) => format!("heading {n}"),
        TargetBlock::Quote => "quotation".to_owned(),
        TargetBlock::Alert => "alert".to_owned(),
        TargetBlock::List => "list".to_owned(),
        TargetBlock::Code => "fenced code".to_owned(),
        TargetBlock::Table => "table".to_owned(),
        TargetBlock::Rule => "rule".to_owned(),
        TargetBlock::Toc => "table of contents".to_owned(),
        TargetBlock::Math => "math (source fallback)".to_owned(),
        TargetBlock::Html => "HTML (source fallback, never run)".to_owned(),
        TargetBlock::Footnote => "footnote (source fallback)".to_owned(),
        TargetBlock::Definition => "link definition (source fallback)".to_owned(),
        TargetBlock::FrontMatter => "front matter (source fallback)".to_owned(),
    }
}

fn inside(r: Rect, x: i32, y: i32) -> bool {
    x >= i32::from(r.x)
        && x < i32::from(r.x + r.width)
        && y >= i32::from(r.y)
        && y < i32::from(r.y + r.height)
}

impl MarkdownPanel {
    fn styles(&self, cx: &ViewCtx) -> MarkdownPanelStyles {
        self.styles
            .clone()
            .unwrap_or_else(|| MarkdownPanelStyles::from_theme(cx.theme))
    }

    // ---- what is unavailable, and why ------------------------------------

    /// Why `choice` cannot be done now, in words a person can act on.
    pub(super) fn unavailable(&self, choice: Choice) -> Option<String> {
        let Some(d) = self.doc() else {
            return match choice {
                Choice::Close => None,
                Choice::Retry => match &self.phase {
                    Phase::Failed(p) if p.can_retry => None,
                    Phase::Failed(p) if p.unknown => Some(
                        "The owner did not say whether the file opened, so it is not asked again by guess."
                            .to_owned(),
                    ),
                    Phase::Failed(_) => Some("The owner's answer will not change.".to_owned()),
                    _ => Some("Nothing failed.".to_owned()),
                },
                _ => Some("No document is open.".to_owned()),
            };
        };
        let mode = d.md.borrow().mode();
        let (has_conflict, block_open, held_block) = {
            let md = d.md.borrow();
            (
                md.session().has_conflict() || md.is_held(),
                md.open_range().is_some(),
                md.is_held(),
            )
        };
        let read_only = || d.sync.read_only.clone().map(|r| format!("Read-only: {r}"));
        let preview = || {
            (mode == MarkdownMode::Preview)
                .then(|| "Preview shows the document and does not edit it.".to_owned())
        };
        let conflict = || (!has_conflict).then(|| "There is nothing held.".to_owned());
        match choice {
            Choice::Visual | Choice::Source | Choice::Split | Choice::Preview => {
                (choice.mode() == Some(mode)).then(|| "Already in this mode.".to_owned())
            }
            Choice::Save => {
                let dirty = d.dirty();
                let md = d.md.borrow();
                if !self.documents {
                    Some("The document service is not available.".to_owned())
                } else if d.restored.is_some() {
                    Some("Settle the recovered edits first.".to_owned())
                } else if has_conflict {
                    Some("Settle the held text first.".to_owned())
                } else if d.sync.desync.is_some() {
                    Some("Waiting for the owner's text.".to_owned())
                } else if d.sync.save.inflight == Some(md.revision()) && !md.session().has_pending()
                {
                    Some("A save of this revision is already in flight.".to_owned())
                } else if !dirty {
                    Some("There is nothing to save.".to_owned())
                } else {
                    None
                }
            }
            Choice::ToggleCheckbox => read_only()
                .or_else(preview)
                .or_else(|| held_block.then(|| "Settle the held block first.".to_owned())),
            Choice::OpenBlock => read_only()
                .or_else(|| held_block.then(|| "Settle the held block first.".to_owned())),
            Choice::CloseBlock => (!block_open).then(|| "No block is open.".to_owned()),
            Choice::NextBlock
            | Choice::PreviousBlock
            | Choice::OpenLink
            | Choice::NextLink
            | Choice::PreviousLink => None,
            Choice::KeepMine => {
                if let Some(r) = read_only() {
                    Some(format!("{r}; sending the text again would be refused."))
                } else {
                    conflict()
                }
            }
            Choice::TakeTheirs | Choice::KeepBoth => conflict(),
            Choice::CopyMine => (!has_conflict && d.sync.recoverable.is_none())
                .then(|| "There is no held text.".to_owned()),
            Choice::Resend => d
                .sync
                .unknown
                .is_none()
                .then(|| "No edit is waiting on an unknown answer.".to_owned()),
            Choice::KeepRecovered | Choice::DiscardRecovered => d
                .restored
                .is_none()
                .then(|| "No recovered edits are waiting.".to_owned()),
            Choice::KeepDisk | Choice::KeepAuthority => d
                .sync
                .disk
                .is_none()
                .then(|| "The file on disk has not changed under the panel.".to_owned()),
            Choice::Dismiss => {
                (!(d.notice.is_some() || d.sync.recoverable.is_some() || d.link.is_some()))
                    .then(|| "There is nothing to dismiss.".to_owned())
            }
            Choice::Retry => Some("Nothing failed.".to_owned()),
            Choice::Close => None,
        }
    }

    // ---- layout -----------------------------------------------------------

    fn strip(&self) -> Option<Strip> {
        let d = self.doc()?;
        let make = |text: String, tone, buttons, conflict| {
            Some(Strip {
                text,
                tone,
                buttons,
                conflict,
            })
        };
        let buttons_for_conflict = if d.sync.read_only.is_some() {
            vec![Choice::TakeTheirs, Choice::CopyMine]
        } else {
            vec![
                Choice::KeepMine,
                Choice::TakeTheirs,
                Choice::KeepBoth,
                Choice::CopyMine,
            ]
        };
        let md = d.md.borrow();
        if let Some(k) = md.block_conflict() {
            let theirs = if k.theirs.is_empty() {
                "(deleted)".to_owned()
            } else {
                snip(&k.theirs, 24)
            };
            return make(
                format!(
                    "Both changed this block; yours is kept open. Mine: \"{}\" Theirs: \"{theirs}\"",
                    snip(&k.mine, 24)
                ),
                Tone::Error,
                buttons_for_conflict,
                true,
            );
        }
        if let Some(r) = &d.restored {
            let words = if r.applied {
                format!(
                    "Edits recovered from this device ({}) were never sent, and are shown in the text. Nothing is sent until you choose: keep sends them as new edits, discard drops them.",
                    r.ops.len()
                )
            } else {
                let base = r.base.as_deref().map_or_else(
                    || "this text".to_owned(),
                    |b| format!("revision {b}, and the document is at {}", md.revision()),
                );
                format!(
                    "Edits recovered from this device ({}) were made against {base}, so they are not applied. Nothing is sent until you choose: keep adds the text they inserted at the end, discard drops them.",
                    r.ops.len()
                )
            };
            return make(
                words,
                Tone::Warn,
                vec![Choice::KeepRecovered, Choice::DiscardRecovered],
                false,
            );
        }
        let session = md.session();
        if session.has_conflict() || d.sync.held.is_some() {
            let reason = d
                .sync
                .held
                .as_ref()
                .map(|h| h.reason.clone())
                .or_else(|| session.conflict().map(|c| c.reason))
                .unwrap_or_default();
            let conflict = d.sync.held.as_ref().is_none_or(|h| h.conflict);
            let mine = session
                .conflict()
                .map(|c| {
                    c.ranges
                        .iter()
                        .map(|&(a, b)| session.rope().slice(a..b).to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let theirs = match d.sync.held.as_ref().and_then(|h| h.theirs.as_ref()) {
                Some(t) if t.inserted.is_empty() && !t.removed.is_empty() => "(deleted)".to_owned(),
                Some(t) => snip(&t.inserted, 24),
                None if conflict => "(the owner sent no text)".to_owned(),
                None => String::new(),
            };
            let head = if conflict {
                "Both changed this."
            } else {
                "The owner refused the edit."
            };
            let body = if conflict {
                format!(
                    "{head} {reason} Mine: \"{}\" Theirs: \"{theirs}\"",
                    snip(&mine, 24)
                )
            } else {
                format!("{head} {reason} Mine, kept here: \"{}\"", snip(&mine, 24))
            };
            return make(body, Tone::Error, buttons_for_conflict, true);
        }
        if let Some(disk) = &d.sync.disk {
            let what = if disk.deleted {
                "The file was deleted on disk."
            } else {
                "The file changed on disk."
            };
            return make(
                format!(
                    "{what} Revision {} differs from the panel's.",
                    disk.revision
                ),
                Tone::Warn,
                vec![Choice::KeepDisk, Choice::KeepAuthority],
                false,
            );
        }
        if let Some(u) = &d.sync.unknown {
            return make(
                format!(
                    "Unknown whether the owner took an edit: {} Nothing is sent behind it.",
                    u.reason
                ),
                Tone::Warn,
                vec![Choice::Resend],
                false,
            );
        }
        if d.sync.recoverable.is_some() {
            return make(
                "Their text was taken. Your text is kept.".to_owned(),
                Tone::Info,
                vec![Choice::CopyMine, Choice::Dismiss],
                false,
            );
        }
        if let Some(why) = &d.sync.desync {
            return make(why.clone(), Tone::Warn, vec![], false);
        }
        if self.local.as_ref().is_some_and(|l| l.problem.is_some())
            && let Some(sentence) = self.local_words().into_iter().next()
        {
            return make(sentence, Tone::Warn, vec![], false);
        }
        if let Some(i) = d.link {
            let found = links::links(&md.text());
            if let Some(l) = found.get(i) {
                let what = match links::classify(&self.path, &l.url) {
                    Target::Workspace { path, .. } => format!("opens {path} in the workspace"),
                    Target::Remote(_) => "a remote address: it is not opened or fetched".to_owned(),
                    Target::Fragment(f) => format!("goes to the heading #{f}"),
                    Target::Refused(why) => why,
                };
                return make(
                    format!("Link {} of {}: {} ({what})", i + 1, found.len(), l.url),
                    Tone::Info,
                    vec![Choice::OpenLink, Choice::Dismiss],
                    false,
                );
            }
        }
        // Last, so that anything needing a choice speaks first: the status line
        // is too short to carry this one in a narrow pane.
        self.shown(d).note.and_then(|note| {
            let mut words = note.chars();
            let head: String = words
                .next()
                .into_iter()
                .flat_map(char::to_uppercase)
                .collect();
            make(
                format!("{head}{}. Showing the source alone.", words.as_str()),
                Tone::Info,
                vec![],
                false,
            )
        })
    }

    pub(super) fn frame(&self, area: Rect) -> Option<Frame> {
        self.doc()?;
        let (mut top, mut bottom) = (area.y, area.y + area.height);
        let bar = (area.height >= 6).then(|| {
            let r = Rect::new(area.x, top, area.width, 1);
            top += 1;
            r
        });
        let status = (area.height >= 3).then(|| {
            bottom -= 1;
            Rect::new(area.x, bottom, area.width, 1)
        });
        let strip = self.strip().and_then(|s| {
            let rows = s.rows(area.width).min((bottom - top).saturating_sub(1));
            (rows > 0).then(|| {
                bottom -= rows;
                Rect::new(area.x, bottom, area.width, rows)
            })
        });
        Some(Frame {
            bar,
            text: Rect::new(area.x, top, area.width, bottom - top),
            strip,
            status,
        })
    }

    /// The cells the source widget has: the text in Source, the left pane in
    /// Split (laid out as the Markdown model lays it), and the text otherwise.
    pub(super) fn source_rect(&self, frame: &Frame, mode: MarkdownMode) -> Rect {
        match mode {
            MarkdownMode::Split => Rect {
                width: frame.text.width.saturating_sub(1) / 2,
                ..frame.text
            },
            _ => frame.text,
        }
    }

    /// The buttons laid out left to right on `row`. A button that does not
    /// fit is left out (its chord still works).
    fn buttons_on(&self, row: Rect, buttons: &[Choice]) -> Vec<(Choice, Rect, Option<String>)> {
        let mut x = row.x;
        let mut out = Vec::new();
        for &b in buttons {
            let text = label(b);
            let w = text.width() as u16;
            if x + w > row.x + row.width {
                break;
            }
            out.push((b, Rect::new(x, row.y, w, 1), self.unavailable(b)));
            x += w + 1;
        }
        out
    }

    /// The four mode buttons: with their chords when they fit, else by name.
    fn bar_buttons(&self, row: Rect) -> Vec<(Choice, Rect, String)> {
        let modes = [
            MarkdownMode::Visual,
            MarkdownMode::Source,
            MarkdownMode::Split,
            MarkdownMode::Preview,
        ];
        let long: Vec<String> = modes
            .iter()
            .map(|&m| label(Choice::of_mode(m)).replace(" mode", ""))
            .collect();
        let need: usize = long.iter().map(|l| l.width() + 1).sum();
        let mut x = row.x;
        let mut out = Vec::new();
        for (&m, long) in modes.iter().zip(long) {
            let text = if need <= usize::from(row.width) {
                long
            } else {
                format!("[{}]", mode_title(m))
            };
            let w = text.width() as u16;
            if x + w > row.x + row.width {
                break;
            }
            out.push((Choice::of_mode(m), Rect::new(x, row.y, w, 1), text));
            x += w + 1;
        }
        out
    }

    pub(super) fn bar_button_at(&self, frame: &Frame, x: i32, y: i32) -> Option<Choice> {
        let bar = frame.bar?;
        self.bar_buttons(bar)
            .into_iter()
            .find(|(_, r, _)| inside(*r, x, y))
            .map(|(c, _, _)| c)
    }

    fn strip_buttons(&self, rect: Rect) -> Vec<(Choice, Rect, Option<String>)> {
        let Some(strip) = self.strip() else {
            return vec![];
        };
        if strip.buttons.is_empty() {
            return vec![];
        }
        let row = Rect::new(rect.x, rect.y + rect.height - 1, rect.width, 1);
        self.buttons_on(row, &strip.buttons)
    }

    pub(super) fn strip_button_at(&self, frame: &Frame, x: i32, y: i32) -> Option<Choice> {
        let strip = frame.strip?;
        self.strip_buttons(strip)
            .into_iter()
            .find(|(_, r, _)| inside(*r, x, y))
            .map(|(c, _, _)| c)
    }

    fn message_buttons(&self) -> Vec<Choice> {
        match &self.phase {
            Phase::Failed(p) if p.can_retry => vec![Choice::Retry, Choice::Close],
            _ => vec![Choice::Close],
        }
    }

    fn message_row(&self, area: Rect) -> Rect {
        Rect::new(
            area.x,
            area.y + 5.min(area.height.saturating_sub(1)),
            area.width,
            1,
        )
    }

    pub(super) fn message_button_at(&self, area: Rect, x: i32, y: i32) -> Option<Choice> {
        self.buttons_on(self.message_row(area), &self.message_buttons())
            .into_iter()
            .find(|(_, r, _)| inside(*r, x, y))
            .map(|(c, _, _)| c)
    }

    // ---- the status line --------------------------------------------------

    /// The block the caret or the open block is in: its place among the blocks
    /// and what it is.
    fn block_words(&self, d: &Doc) -> Option<(usize, usize, String)> {
        let (index, blocks) = d.block_position();
        let i = index?;
        Some((i + 1, blocks.len(), kind_name(blocks.get(i)?.kind)))
    }

    /// The left side: the path, what is true of the document.
    /// The left of the status line. The state of the edits matters more than
    /// where the caret is: a form of its words that does not fit beside the
    /// position takes the whole row (`true`: the position goes) before a
    /// shorter form is used.
    fn status_left(&self, d: &Doc, beside: usize, whole: usize) -> (String, bool, bool) {
        let tiers = self.local_words();
        if tiers.is_empty() {
            let (s, attention) = self.status_flags(d, None);
            return (s, attention, false);
        }
        let mut last = (String::new(), false, false);
        for words in &tiers {
            let (s, attention) = self.status_flags(d, Some(words));
            let width = s.width();
            last = (s, attention, width > beside);
            if width <= whole {
                break;
            }
        }
        last
    }

    /// How far the edits are from being safe, in plain words and never more
    /// than the host said: the sentence first, then shorter forms for a status
    /// line with less room. Empty for edits the owner has.
    fn local_words(&self) -> Vec<String> {
        let Some(local) = self.local.as_ref() else {
            return vec![];
        };
        if let Some(p) = &local.problem {
            return vec![
                format!(
                    "Keeping your edits on this device failed ({}). They are only in this page.",
                    p.reason
                ),
                "keeping failed, only in this page".to_owned(),
            ];
        }
        match local.status {
            LocalStatus::Accepted => vec![],
            LocalStatus::Draft => vec![
                "Your edits are not yet kept on this device.".to_owned(),
                "not yet kept on this device".to_owned(),
            ],
            LocalStatus::Checkpointed { recovered, .. } => vec![
                if recovered {
                    "Your edits were recovered from this device and are kept on it. They are not saved to the file."
                } else {
                    "Your edits are kept on this device. They are not saved to the file."
                }
                .to_owned(),
                "kept on this device, not saved".to_owned(),
                "kept on this device".to_owned(),
            ],
        }
    }

    fn status_flags(&self, d: &Doc, local: Option<&str>) -> (String, bool) {
        let mut s = self.path.clone();
        let mut attention = false;
        let mut flag = |text: String, warn: bool| {
            s.push_str(&format!(" [{text}]"));
            attention |= warn;
        };
        if let Some(words) = local {
            let warn = self.local.as_ref().is_some_and(|l| l.problem.is_some());
            // The status line says it in a flag: the sentence is the strip's
            // and the semantic tree's.
            flag(words.trim_end_matches('.').to_owned(), warn);
        }
        let shown = self.shown(d);
        flag(mode_title(shown.mode).to_lowercase(), false);
        if let Some(note) = &shown.note {
            flag(note.clone(), true);
        }
        if d.dirty() {
            flag("modified".to_owned(), false);
        }
        if let Some(r) = &d.sync.read_only {
            flag(format!("read-only: {r}"), true);
        }
        if d.md.borrow().is_held() {
            flag("block held".to_owned(), true);
        }
        if d.sync.save.inflight.is_some() {
            flag("saving".to_owned(), false);
        }
        if d.sync.save.unknown.is_some() {
            flag("save unknown".to_owned(), true);
        }
        if d.sync.unknown.is_some() {
            flag("edit unknown".to_owned(), true);
        } else if d.sync.inflight.is_some() {
            flag("sending".to_owned(), false);
        }
        if d.sync.desync.is_some() {
            flag("out of sync".to_owned(), true);
        }
        if d.sync.save.wanted {
            flag("save waits for edits".to_owned(), false);
        }
        match self.connection {
            None | Some(ConnectionState::Open) => {}
            Some(state) => flag(format!("{state:?}").to_lowercase(), true),
        }
        (s, attention)
    }

    /// The right side, longest form first: the block, the line and column in
    /// grapheme clusters (what an arrow key counts), the selection and the
    /// accepted revision.
    fn status_right(&self, d: &Doc) -> Vec<String> {
        let md = d.md.borrow();
        let session = md.session();
        let at = d.source.position(session);
        let place = format!("Ln {}, Col {} (graphemes)", at.line, at.column);
        let selected = session.selection().map_or(0, |(a, b)| {
            let c = session.coords();
            c.grapheme_index(b) - c.grapheme_index(a)
        });
        let sel = if selected > 0 {
            format!(" | {selected} selected")
        } else {
            String::new()
        };
        drop(md);
        let block = self
            .block_words(d)
            .map(|(i, n, k)| format!("{k} {i}/{n} | "))
            .unwrap_or_default();
        let revision = d.md.borrow().revision();
        vec![
            format!("{block}{place}{sel} | r{revision}"),
            format!("{place}{sel}"),
            format!("Ln {}, Col {}", at.line, at.column),
        ]
    }

    // ---- drawing ----------------------------------------------------------

    pub(super) fn draw(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        buf.set_style(area, cx.theme.bg);
        let Some(frame) = self.frame(area) else {
            self.draw_message(area, buf, cx);
            return;
        };
        let Phase::Ready(d) = &self.phase else { return };
        let styles = self.styles(cx);
        let tone = |t: Tone| match t {
            Tone::Info => cx.theme.text,
            Tone::Warn => cx.theme.warning,
            Tone::Error => cx.theme.error,
        };
        let shown = self.shown(d);

        // The mode bar.
        if let Some(bar) = frame.bar {
            for (choice, r, text) in self.bar_buttons(bar) {
                let style = if choice.mode() == Some(shown.mode) {
                    cx.theme.selected
                } else {
                    cx.theme.muted
                };
                buf.set_stringn(r.x, r.y, text, usize::from(r.width), style);
            }
        }

        // The text.
        let text = frame.text;
        if text.width > 0 && text.height > 0 {
            match shown.mode {
                MarkdownMode::Source => self.draw_source(d, text, buf, cx, &styles),
                MarkdownMode::Split => {
                    d.md.borrow_mut().draw(text, buf, &styles.markdown);
                    // The widget draws the source pane so that its marks, the
                    // held text and the caret are the ones Source mode shows.
                    let pane = self.source_rect(&frame, shown.mode);
                    for y in pane.y..pane.y + pane.height {
                        for x in pane.x..pane.x + pane.width {
                            buf[(x, y)].reset();
                        }
                    }
                    self.draw_source(d, pane, buf, cx, &styles);
                }
                MarkdownMode::Visual | MarkdownMode::Preview => {
                    let drawn = d.md.borrow_mut().draw(text, buf, &styles.markdown);
                    if let Some(c) = drawn.caret
                        && cx.focused
                        && shown.mode == MarkdownMode::Visual
                    {
                        buf.set_style(Rect::new(c.x, c.y, c.width.max(1), 1), styles.editor.caret);
                        if let Some(composing) = d.preedit.as_deref().filter(|t| !t.is_empty()) {
                            draw_preedit(
                                buf,
                                composing,
                                (c.x, c.y, text.x + text.width),
                                styles.markdown.preedit,
                            );
                        }
                    }
                }
            }
        }

        // The strip.
        if let (Some(rect), Some(strip)) = (frame.strip, self.strip()) {
            let has_buttons = !strip.buttons.is_empty();
            let text_rows = rect.height - u16::from(has_buttons);
            if text_rows > 0 {
                Paragraph::new(Line::from(strip.text.as_str()))
                    .wrap(Wrap { trim: true })
                    .style(tone(strip.tone))
                    .render(Rect::new(rect.x, rect.y, rect.width, text_rows), buf);
            }
            for (choice, r, why) in self.strip_buttons(rect) {
                let style = if why.is_none() {
                    cx.theme.selected
                } else {
                    cx.theme.muted
                };
                buf.set_stringn(r.x, r.y, label(choice), usize::from(r.width), style);
            }
        }

        // The status line.
        if let Some(row) = frame.status {
            buf.set_style(row, cx.theme.line);
            let right = self
                .status_right(d)
                .into_iter()
                .find(|r| r.width() + 8 < usize::from(row.width))
                .unwrap_or_default();
            let right_w = right.width() as u16;
            let left_room = row.width.saturating_sub(right_w + 1);
            let (left, attention, whole_row) =
                self.status_left(d, usize::from(left_room), usize::from(row.width));
            let base = if attention {
                cx.theme.warning
            } else {
                cx.theme.muted
            };
            let (right, right_w, left_room) = if whole_row {
                (String::new(), 0, row.width)
            } else {
                (right, right_w, left_room)
            };
            let (x, _) = buf.set_stringn(row.x, row.y, &left, usize::from(left_room), base);
            if let Some(n) = &d.notice {
                let used = x - row.x;
                if left_room > used + 2 {
                    buf.set_stringn(
                        x + 2,
                        row.y,
                        &n.text,
                        usize::from(left_room - used - 2),
                        tone(n.tone),
                    );
                }
            }
            if right_w > 0 {
                buf.set_stringn(
                    row.x + row.width - right_w,
                    row.y,
                    &right,
                    usize::from(right_w),
                    cx.theme.muted,
                );
            }
        }
    }

    fn draw_source(
        &self,
        d: &Doc,
        area: Rect,
        buf: &mut Buffer,
        cx: &ViewCtx,
        styles: &MarkdownPanelStyles,
    ) {
        let md = d.md.borrow();
        let tokens = d.token_marks(&styles.editor);
        let paint = Paint {
            focused: cx.focused,
            tokens: &tokens,
            preedit: d.preedit.as_deref(),
            ..Paint::new(&styles.editor)
        };
        d.source.draw(md.session(), area, buf, &paint);
    }

    fn message_lines(&self) -> Vec<(String, Tone)> {
        let path = (self.path.clone(), Tone::Info);
        match &self.phase {
            Phase::Waiting if self.path.is_empty() => vec![
                ("No file".to_owned(), Tone::Info),
                (
                    "This panel has not been given a file to show.".to_owned(),
                    Tone::Warn,
                ),
            ],
            Phase::Waiting if !self.documents => vec![
                path,
                (
                    "The document service is not available in this workspace.".to_owned(),
                    Tone::Warn,
                ),
            ],
            Phase::Waiting => vec![path, ("Waiting for the workspace.".to_owned(), Tone::Info)],
            Phase::Opening => vec![path, ("Opening the document...".to_owned(), Tone::Info)],
            Phase::Failed(p) => {
                let mut v = vec![
                    path,
                    (
                        p.headline.clone(),
                        if p.unknown { Tone::Warn } else { Tone::Error },
                    ),
                    (p.reason.clone(), Tone::Info),
                ];
                if let Some(code) = &p.code {
                    v.push((format!("({code})"), Tone::Info));
                }
                v
            }
            Phase::Ready(_) => vec![],
        }
    }

    fn draw_message(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        if area.height == 0 || area.width == 0 {
            return;
        }
        let tone = |t: Tone| match t {
            Tone::Info => cx.theme.text,
            Tone::Warn => cx.theme.warning,
            Tone::Error => cx.theme.error,
        };
        for (i, (text, t)) in self.message_lines().iter().enumerate() {
            let y = area.y + i as u16;
            let style = if i == 0 { cx.theme.muted } else { tone(*t) };
            match i {
                // The reason may be long: it gets two rows and wraps.
                2 if y < area.y + area.height => {
                    let rect = Rect::new(area.x, y, area.width, 2.min(area.height - (y - area.y)));
                    Paragraph::new(Line::from(text.as_str()))
                        .wrap(Wrap { trim: true })
                        .style(style)
                        .render(rect, buf);
                }
                // The code sits under the two reason rows.
                3 => {
                    if area.y + 4 < area.y + area.height {
                        buf.set_stringn(
                            area.x,
                            area.y + 4,
                            text,
                            usize::from(area.width),
                            cx.theme.muted,
                        );
                    }
                }
                _ => {
                    if y < area.y + area.height {
                        buf.set_stringn(area.x, y, text, usize::from(area.width), style);
                    }
                }
            }
        }
        for (choice, r, why) in self.buttons_on(self.message_row(area), &self.message_buttons()) {
            let style = if why.is_none() {
                cx.theme.selected
            } else {
                cx.theme.muted
            };
            buf.set_stringn(r.x, r.y, label(choice), usize::from(r.width), style);
        }
    }

    // ---- semantics --------------------------------------------------------

    fn action(&self, choice: Choice) -> NodeAction {
        let why = self.unavailable(choice);
        NodeAction {
            id: choice.action_id(),
            enabled: why.is_none(),
            reason: why,
        }
    }

    pub(super) fn nodes(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let Some(frame) = self.frame(area) else {
            return self.message_nodes(area, cx);
        };
        let Phase::Ready(d) = &self.phase else {
            return vec![];
        };
        let shown = self.shown(d);
        let revision = d.md.borrow().revision();
        let at = d.source.position(d.md.borrow().session());

        let mut root = Node::new("markdown", Role::Document, &self.path, area);
        root.binding = self.resource();
        root.revision = Some(CoreRevision::Seq(revision));
        root.state.focused = cx.focused;
        root.state.modified = d.dirty();
        root.state.busy = d.sync.inflight.is_some() || d.sync.save.inflight.is_some();
        let mut words = vec![
            format!("mode: {}", mode_title(shown.mode).to_lowercase()),
            if d.dirty() { "modified" } else { "saved" }.to_owned(),
        ];
        if let Some(note) = &shown.note {
            words.push(note.clone());
        }
        if let Some(sentence) = self.local_words().into_iter().next() {
            words.push(sentence);
        }
        if let Some(r) = &d.sync.read_only {
            words.push(format!("read-only: {r}"));
        }
        if let Some((i, n, kind)) = self.block_words(d) {
            words.push(format!("block {i} of {n}: {kind}"));
        }
        words.push(format!(
            "line {}, column {} in graphemes ({} in UTF-16 units)",
            at.line, at.column, at.utf16
        ));
        root.state.description = Some(words.join("; "));
        root.actions = [
            Choice::Visual,
            Choice::Source,
            Choice::Split,
            Choice::Preview,
            Choice::Save,
            Choice::ToggleCheckbox,
            Choice::OpenBlock,
            Choice::CloseBlock,
            Choice::NextBlock,
            Choice::PreviousBlock,
            Choice::OpenLink,
            Choice::NextLink,
            Choice::PreviousLink,
            Choice::KeepMine,
            Choice::TakeTheirs,
            Choice::KeepBoth,
            Choice::CopyMine,
            Choice::KeepRecovered,
            Choice::DiscardRecovered,
        ]
        .into_iter()
        .map(|c| self.action(c))
        .collect();
        root.shortcut = Some("Ctrl+S".to_owned());

        let mut out = vec![];
        let mut children = vec![];

        // The mode: one tab per mode, the chosen one selected.
        let bar = frame.bar.unwrap_or_else(|| Rect::new(area.x, area.y, 0, 0));
        let mut modes = Node::new("mode", Role::TabList, "Mode", bar);
        let buttons = frame.bar.map(|b| self.bar_buttons(b)).unwrap_or_default();
        for (i, m) in [
            MarkdownMode::Visual,
            MarkdownMode::Source,
            MarkdownMode::Split,
            MarkdownMode::Preview,
        ]
        .into_iter()
        .enumerate()
        {
            let choice = Choice::of_mode(m);
            let rect = buttons
                .iter()
                .find(|(c, _, _)| *c == choice)
                .map_or_else(|| Rect::new(bar.x, bar.y, 0, 0), |(_, r, _)| *r);
            let mut tab = Node::new(
                &format!("mode:{}", m.name().to_lowercase()),
                Role::Tab,
                mode_title(m),
                rect,
            );
            tab.state.selected = m == shown.mode;
            tab.state.focused = cx.focused && m == shown.mode;
            tab.pos_in_set = Some(i as u16 + 1);
            tab.set_size = Some(4);
            tab.shortcut = Some(choice.descriptor().chord.to_owned());
            tab.actions = vec![NodeAction {
                id: choice.action_id(),
                enabled: true,
                reason: None,
            }];
            modes.children.push(tab.id.clone());
            out.push(tab);
        }
        children.push(modes.id.clone());
        out.push(modes);

        // The block.
        if let Some((i, n, kind)) = self.block_words(d) {
            let mut b = Node::new(
                "block",
                Role::Group,
                &format!("Block {i} of {n}: {kind}"),
                frame.text,
            );
            b.state.description = match &d.sync.read_only {
                Some(why) => Some(format!("read-only: {why}")),
                None => {
                    d.md.borrow()
                        .open_range()
                        .map(|r| format!("open for editing, bytes {} to {}", r.start, r.end))
                }
            };
            b.actions = [
                Choice::OpenBlock,
                Choice::CloseBlock,
                Choice::NextBlock,
                Choice::PreviousBlock,
                Choice::ToggleCheckbox,
            ]
            .into_iter()
            .map(|c| self.action(c))
            .collect();
            children.push(b.id.clone());
            out.push(b);
        }

        if let Some(sentence) = self.local_words().into_iter().next() {
            let mut n = Node::new(
                "local",
                Role::Status,
                &sentence,
                frame.status.unwrap_or(area),
            );
            n.binding = self.resource();
            children.push(n.id.clone());
            out.push(n);
        }

        if let Some(row) = frame.status {
            let (left, _, _) = self.status_left(d, usize::MAX, usize::MAX);
            let right = self.status_right(d).remove(0);
            let mut n = Node::new("status", Role::Status, &format!("{left}  {right}"), row);
            n.state.description = d.notice.as_ref().map(|n| n.text.clone());
            children.push(n.id.clone());
            out.push(n);
        }

        if let (Some(rect), Some(strip)) = (frame.strip, self.strip()) {
            let id = if strip.conflict { "conflict" } else { "strip" };
            let mut alert = Node::new(id, Role::Alert, &strip.text, rect);
            alert.binding = self.resource();
            let mut kids = vec![];
            for choice in &strip.buttons {
                let a = self.action(*choice);
                alert.actions.push(a.clone());
                let shown_at = self
                    .strip_buttons(rect)
                    .into_iter()
                    .find(|(c, _, _)| c == choice)
                    .map(|(_, r, _)| r)
                    .unwrap_or_else(|| Rect::new(rect.x, rect.y, 0, 0));
                let mut b = Node::new(
                    &format!("{id}:{}", choice.id()),
                    Role::Button,
                    choice.descriptor().title,
                    shown_at,
                );
                b.state.disabled = !a.enabled;
                b.state.description = a.reason.clone();
                b.shortcut = Some(choice.descriptor().chord.to_owned()).filter(|c| !c.is_empty());
                b.actions = vec![a];
                kids.push(b);
            }
            alert.children = kids.iter().map(|k| k.id.clone()).collect();
            children.push(alert.id.clone());
            out.push(alert);
            out.extend(kids);
        }

        root.children = children;
        let mut all = vec![root];
        all.extend(out);
        all
    }

    fn message_nodes(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let lines = self.message_lines();
        let name = lines
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join(". ");
        let role = if matches!(self.phase, Phase::Failed(_)) {
            Role::Alert
        } else {
            Role::Status
        };
        let mut root = Node::new("state", role, &name, area);
        root.binding = self.resource();
        root.state.busy = matches!(self.phase, Phase::Opening);
        root.state.focused = cx.focused;
        let mut kids = vec![];
        for choice in self.message_buttons() {
            let a = self.action(choice);
            let shown = self
                .buttons_on(self.message_row(area), &[choice])
                .into_iter()
                .next()
                .map(|(_, r, _)| r)
                .unwrap_or_else(|| Rect::new(area.x, area.y, 0, 0));
            let mut b = Node::new(
                &format!("state:{}", choice.id()),
                Role::Button,
                choice.descriptor().title,
                shown,
            );
            b.state.disabled = !a.enabled;
            b.state.description = a.reason.clone();
            root.actions.push(a.clone());
            b.actions = vec![a];
            kids.push(b);
        }
        root.children = kids.iter().map(|k| NodeId::new(k.id.as_str())).collect();
        let mut out = vec![root];
        out.extend(kids);
        out
    }
}

/// Text being composed, put in at the caret of the open block: the rest of the
/// row moves right to make room, as it does in Source mode, and what runs past
/// the pane's edge is cut off.
fn draw_preedit(
    buf: &mut Buffer,
    text: &str,
    (x, y, end): (u16, u16, u16),
    style: ratatui::style::Style,
) {
    let room = usize::from(end.saturating_sub(x));
    let shift = text.width().min(room) as u16;
    for col in (x + shift..end).rev() {
        let moved = buf[(col - shift, y)].clone();
        buf[(col, y)] = moved;
    }
    for col in x..x + shift {
        buf[(col, y)].reset();
    }
    buf.set_stringn(x, y, text, room, style);
}
