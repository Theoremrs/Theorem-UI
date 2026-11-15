//! What the panel shows around the text (the find bar, the strip with the
//! owner's refusals and the choices they offer, the status line), the phases
//! before there is a document, and the semantic nodes.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Widget, Wrap};
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::host::ConnectionState;
use theorem_workbench_core::ids::Revision as CoreRevision;
use theorem_workbench_core::semantics::{Node, NodeAction, NodeId, Role};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::{Doc, EditorPanel, Phase, Tone};
use crate::actions::Choice;
use crate::styles::EditorStyles;
use crate::widget::Paint;

/// Where each part of a ready editor is.
pub(super) struct Frame {
    pub find: Option<Rect>,
    pub text: Rect,
    pub strip: Option<Rect>,
    pub status: Option<Rect>,
}

enum Prompt {
    Text(String, Tone),
    Rename,
}

struct Strip {
    prompt: Prompt,
    buttons: Vec<Choice>,
}

impl Strip {
    /// Rows wanted: the text, wrapped with a row of slack, and the buttons.
    fn rows(&self, width: u16) -> u16 {
        let text = match &self.prompt {
            Prompt::Rename => 1,
            Prompt::Text(t, _) => {
                let cells = t.width();
                let w = usize::from(width.max(1));
                (cells.div_ceil(w) + usize::from(cells > w)).clamp(1, 3) as u16
            }
        };
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

impl EditorPanel {
    fn styles(&self, cx: &ViewCtx) -> EditorStyles {
        self.styles
            .clone()
            .unwrap_or_else(|| EditorStyles::from_theme(cx.theme))
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
        let read_only = || d.read_only.clone().map(|r| format!("Read-only: {r}"));
        let language = || {
            if !self.language {
                Some("No language service in this workspace.".to_owned())
            } else if let Some(r) = read_only() {
                Some(r)
            } else if d.session.has_conflict() {
                Some("Settle the held text first.".to_owned())
            } else if d.session.has_pending() {
                Some("Wait until the owner has accepted the edits.".to_owned())
            } else if d.desync.is_some() {
                Some("Waiting for the owner's text.".to_owned())
            } else if d.busy.is_some() {
                Some("Another request is in flight.".to_owned())
            } else {
                None
            }
        };
        let conflict = || (!d.session.has_conflict()).then(|| "There is no held text.".to_owned());
        match choice {
            Choice::Save => {
                if !self.documents {
                    Some("The document service is not available.".to_owned())
                } else if d.session.has_conflict() {
                    Some("Settle the held text first.".to_owned())
                } else if d.desync.is_some() {
                    Some("Waiting for the owner's text.".to_owned())
                } else if d.save.inflight == Some(d.session.accepted_revision())
                    && !d.session.has_pending()
                {
                    Some("A save of this revision is already in flight.".to_owned())
                } else if !d.dirty() {
                    Some("There is nothing to save.".to_owned())
                } else {
                    None
                }
            }
            Choice::Undo => read_only().or_else(|| {
                (!d.session.can_undo()).then(|| "There is nothing to undo.".to_owned())
            }),
            Choice::Redo => read_only().or_else(|| {
                (!d.session.can_redo()).then(|| "There is nothing to redo.".to_owned())
            }),
            Choice::Find => None,
            Choice::FindNext | Choice::FindPrevious => (!d.find.is_open()
                || d.find.ranges().is_empty())
            .then(|| "There are no matches.".to_owned()),
            Choice::Rename | Choice::Format => language(),
            Choice::ApplyPlan => {
                if !self.language {
                    Some("No language service in this workspace.".to_owned())
                } else if d.plan.is_none() {
                    Some("No rename is planned.".to_owned())
                } else {
                    None
                }
            }
            Choice::KeepMine => {
                if let Some(r) = read_only() {
                    Some(format!("{r}; sending the text again would be refused."))
                } else {
                    conflict()
                }
            }
            Choice::TakeTheirs | Choice::KeepBoth => conflict(),
            Choice::CopyMine => (!d.session.has_conflict() && d.recoverable.is_none())
                .then(|| "There is no held text.".to_owned()),
            Choice::Resend => d
                .unknown
                .is_none()
                .then(|| "No edit is waiting on an unknown answer.".to_owned()),
            Choice::KeepDisk | Choice::KeepAuthority => d
                .disk
                .is_none()
                .then(|| "The file on disk has not changed under the editor.".to_owned()),
            Choice::Dismiss => (!(d.find.is_open()
                || d.notice.is_some()
                || d.recoverable.is_some()
                || d.plan.is_some()))
            .then(|| "There is nothing to dismiss.".to_owned()),
            Choice::Retry => Some("Nothing failed.".to_owned()),
            Choice::Close => None,
        }
    }

    // ---- layout -----------------------------------------------------------

    fn strip(&self) -> Option<Strip> {
        let d = self.doc()?;
        let text = |t: String, tone, buttons| {
            Some(Strip {
                prompt: Prompt::Text(t, tone),
                buttons,
            })
        };
        if d.rename.is_some() {
            return Some(Strip {
                prompt: Prompt::Rename,
                buttons: vec![],
            });
        }
        if d.session.has_conflict() || d.held.is_some() {
            let reason = d
                .held
                .as_ref()
                .map(|h| h.reason.clone())
                .or_else(|| d.session.conflict().map(|c| c.reason))
                .unwrap_or_default();
            let conflict = d.held.as_ref().is_none_or(|h| h.conflict);
            let mine = d
                .session
                .conflict()
                .map(|c| {
                    c.ranges
                        .iter()
                        .map(|&(a, b)| d.session.rope().slice(a..b).to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let theirs = match d.held.as_ref().and_then(|h| h.theirs.as_ref()) {
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
            let buttons = if d.read_only.is_some() {
                vec![Choice::TakeTheirs, Choice::CopyMine]
            } else {
                vec![
                    Choice::KeepMine,
                    Choice::TakeTheirs,
                    Choice::KeepBoth,
                    Choice::CopyMine,
                ]
            };
            return text(body, Tone::Error, buttons);
        }
        if let Some(disk) = &d.disk {
            let what = if disk.deleted {
                "The file was deleted on disk."
            } else {
                "The file changed on disk."
            };
            return text(
                format!(
                    "{what} Revision {} differs from the editor's.",
                    disk.revision
                ),
                Tone::Warn,
                vec![Choice::KeepDisk, Choice::KeepAuthority],
            );
        }
        if let Some(u) = &d.unknown {
            return text(
                format!(
                    "Unknown whether the owner took an edit: {} Nothing is sent behind it.",
                    u.reason
                ),
                Tone::Warn,
                vec![Choice::Resend],
            );
        }
        if let Some(p) = &d.plan {
            return text(
                format!("Rename planned against revision {}.", p.revision),
                Tone::Info,
                vec![Choice::ApplyPlan, Choice::Dismiss],
            );
        }
        if d.recoverable.is_some() {
            return text(
                "Their text was taken. Your text is kept.".to_owned(),
                Tone::Info,
                vec![Choice::CopyMine, Choice::Dismiss],
            );
        }
        if let Some(why) = &d.desync {
            return text(why.clone(), Tone::Warn, vec![]);
        }
        None
    }

    pub(super) fn frame(&self, area: Rect) -> Option<Frame> {
        let d = self.doc()?;
        let (mut top, mut bottom) = (area.y, area.y + area.height);
        let status = (area.height >= 2).then(|| {
            bottom -= 1;
            Rect::new(area.x, bottom, area.width, 1)
        });
        let find = (d.find.is_open() && bottom - top >= 2).then(|| {
            let r = Rect::new(area.x, top, area.width, 1);
            top += 1;
            r
        });
        let strip = self.strip().and_then(|s| {
            let rows = s.rows(area.width).min((bottom - top).saturating_sub(1));
            (rows > 0).then(|| {
                bottom -= rows;
                Rect::new(area.x, bottom, area.width, rows)
            })
        });
        Some(Frame {
            find,
            text: Rect::new(area.x, top, area.width, bottom - top),
            strip,
            status,
        })
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
            .find(|(_, r, _)| {
                x >= i32::from(r.x) && x < i32::from(r.x + r.width) && y == i32::from(r.y)
            })
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
            .find(|(_, r, _)| {
                x >= i32::from(r.x) && x < i32::from(r.x + r.width) && y == i32::from(r.y)
            })
            .map(|(c, _, _)| c)
    }

    // ---- the status line --------------------------------------------------

    /// The left side: the path, what is true of the document, and the last
    /// notice apart (it has its own tone).
    fn status_left(&self, d: &Doc) -> (String, bool) {
        let mut s = self.path.clone();
        let mut attention = false;
        let mut flag = |text: String, warn: bool| {
            s.push_str(&format!(" [{text}]"));
            attention |= warn;
        };
        if d.dirty() {
            flag("modified".to_owned(), false);
        }
        if let Some(r) = &d.read_only {
            flag(format!("read-only: {r}"), true);
        }
        if d.save.inflight.is_some() {
            flag("saving".to_owned(), false);
        }
        if d.save.unknown.is_some() {
            flag("save unknown".to_owned(), true);
        }
        if d.unknown.is_some() {
            flag("edit unknown".to_owned(), true);
        } else if d.inflight.is_some() {
            flag("sending".to_owned(), false);
        }
        if d.desync.is_some() {
            flag("out of sync".to_owned(), true);
        }
        if d.save.wanted {
            flag("save waits for edits".to_owned(), false);
        }
        if let Some(b) = d.busy {
            flag(b.to_owned(), false);
        }
        match self.connection {
            None | Some(ConnectionState::Open) => {}
            Some(state) => flag(format!("{state:?}").to_lowercase(), true),
        }
        (s, attention)
    }

    /// The right side, longest form first: line and column in grapheme
    /// clusters (what an arrow key counts), the selection, the line ending and
    /// the accepted revision.
    fn status_right(&self, d: &Doc) -> Vec<String> {
        let at = d.view.position(&d.session);
        let place = format!("Ln {}, Col {} (graphemes)", at.line, at.column);
        let selected = d.session.selection().map_or(0, |(a, b)| {
            let c = d.session.coords();
            c.grapheme_index(b) - c.grapheme_index(a)
        });
        let sel = if selected > 0 {
            format!(" | {selected} selected")
        } else {
            String::new()
        };
        let rope = d.session.rope();
        let first = rope.line(0);
        let n = first.len_chars();
        let eol = if n >= 2 && first.char(n - 2) == '\r' && first.char(n - 1) == '\n' {
            "CRLF"
        } else {
            "LF"
        };
        vec![
            format!("{place}{sel} | {eol} | r{}", d.session.accepted_revision()),
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

        // The text.
        let paint = Paint {
            styles: &styles,
            focused: cx.focused && !d.in_find && d.rename.is_none(),
            matches: if d.find.is_open() {
                d.find.ranges()
            } else {
                &[]
            },
            current: d.find.current(&d.session),
        };
        d.view.draw(&d.session, frame.text, buf, &paint);

        // The find bar.
        if let Some(row) = frame.find {
            buf.set_style(row, cx.theme.line);
            let prefix = if d.find.case_sensitive() {
                "Find (case) "
            } else {
                "Find "
            };
            buf.set_stringn(row.x, row.y, prefix, usize::from(row.width), cx.theme.muted);
            let summary = d.find.summary(&d.session);
            let hint = "Alt+C case";
            let tail = format!("{summary}  {hint}");
            let tail_w = tail.width() as u16;
            let x0 = row.x + prefix.width() as u16;
            let room = row.width.saturating_sub(prefix.width() as u16 + tail_w + 1);
            let value = d.find.field.value();
            let scroll = d.find.field.scroll(usize::from(room.max(1)));
            let shown = skip_cells(value, scroll);
            buf.set_stringn(x0, row.y, &shown, usize::from(room), cx.theme.text);
            if d.in_find && cx.focused {
                let at = d
                    .find
                    .field
                    .cursor()
                    .min(usize::from(room.saturating_sub(1)));
                buf.set_style(Rect::new(x0 + at as u16, row.y, 1, 1), styles.caret);
            }
            if row.width > tail_w {
                buf.set_stringn(
                    row.x + row.width - tail_w,
                    row.y,
                    &tail,
                    usize::from(tail_w),
                    cx.theme.muted,
                );
            }
        }

        // The strip.
        if let (Some(rect), Some(strip)) = (frame.strip, self.strip()) {
            let has_buttons = !strip.buttons.is_empty();
            let text_rows = rect.height - u16::from(has_buttons);
            let text_rect = Rect::new(rect.x, rect.y, rect.width, text_rows);
            match &strip.prompt {
                Prompt::Text(t, t_tone) => {
                    if text_rows > 0 {
                        Paragraph::new(Line::from(t.as_str()))
                            .wrap(Wrap { trim: true })
                            .style(tone(*t_tone))
                            .render(text_rect, buf);
                    }
                }
                Prompt::Rename => {
                    let field = d.rename.as_ref();
                    let prefix = "Rename to ";
                    buf.set_stringn(
                        rect.x,
                        rect.y,
                        prefix,
                        usize::from(rect.width),
                        cx.theme.muted,
                    );
                    if let Some(field) = field {
                        let x0 = rect.x + prefix.width() as u16;
                        let room = rect.width.saturating_sub(prefix.width() as u16);
                        let shown =
                            skip_cells(field.value(), field.scroll(usize::from(room.max(1))));
                        buf.set_stringn(x0, rect.y, &shown, usize::from(room), cx.theme.text);
                        if cx.focused && room > 0 {
                            let at = field.cursor().min(usize::from(room - 1));
                            buf.set_style(Rect::new(x0 + at as u16, rect.y, 1, 1), styles.caret);
                        }
                    }
                }
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
            let (left, attention) = self.status_left(d);
            let base = if attention {
                cx.theme.warning
            } else {
                cx.theme.muted
            };
            let right = self
                .status_right(d)
                .into_iter()
                .find(|r| r.width() + 8 < usize::from(row.width))
                .unwrap_or_default();
            let right_w = right.width() as u16;
            let left_room = row.width.saturating_sub(right_w + 1);
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

    fn message_lines(&self) -> Vec<(String, Tone)> {
        let path = (self.path.clone(), Tone::Info);
        match &self.phase {
            Phase::Waiting if self.path.is_empty() => vec![
                ("No file".to_owned(), Tone::Info),
                (
                    "This editor has not been given a file to show.".to_owned(),
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
        let lines = self.message_lines();
        for (i, (text, t)) in lines.iter().enumerate() {
            let y = area.y + i as u16;
            let style: Style = if i == 0 { cx.theme.muted } else { tone(*t) };
            match i {
                // The reason may be long: it gets two rows and wraps.
                2 => {
                    let rect = Rect::new(area.x, y, area.width, 2.min(area.height - (y - area.y)));
                    Paragraph::new(Line::from(text.as_str()))
                        .wrap(Wrap { trim: true })
                        .style(style)
                        .render(rect, buf);
                }
                3 => {
                    // The code sits under the two reason rows.
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
        let at = d.view.position(&d.session);
        let mut root = Node::new("text", Role::TextBox, &self.path, frame.text);
        root.binding = self.resource();
        root.revision = Some(CoreRevision::Seq(d.session.accepted_revision()));
        root.state.focused = cx.focused && !d.in_find && d.rename.is_none();
        root.state.busy = d.inflight.is_some() || d.save.inflight.is_some() || d.busy.is_some();
        let selected = d.session.selection().map_or(0, |(a, b)| {
            let c = d.session.coords();
            c.grapheme_index(b) - c.grapheme_index(a)
        });
        let mut words = vec![if d.dirty() { "modified" } else { "saved" }.to_owned()];
        if let Some(r) = &d.read_only {
            words.push(format!("read-only: {r}"));
        }
        words.push(format!(
            "line {}, column {} in graphemes ({} in UTF-16 units)",
            at.line, at.column, at.utf16
        ));
        if selected > 0 {
            words.push(format!("{selected} graphemes selected"));
        }
        if d.find.is_open() {
            words.push(format!("find: {}", d.find.summary(&d.session)));
        }
        root.state.description = Some(words.join("; "));
        root.actions = [
            Choice::Save,
            Choice::Undo,
            Choice::Redo,
            Choice::Find,
            Choice::FindNext,
            Choice::FindPrevious,
            Choice::Rename,
            Choice::Format,
            Choice::ApplyPlan,
        ]
        .into_iter()
        .map(|c| self.action(c))
        .collect();
        root.shortcut = Some("Ctrl+S".to_owned());

        let mut out = vec![];
        let mut children = vec![];

        if let Some(row) = frame.status {
            let (left, _) = self.status_left(d);
            let right = self.status_right(d).remove(0);
            let mut n = Node::new("status", Role::Status, &format!("{left}  {right}"), row);
            n.state.description = d.notice.as_ref().map(|n| n.text.clone());
            children.push(n.id.clone());
            out.push(n);
        }
        if let Some(c) = d.view.caret_cell(&d.session, frame.text) {
            let mut n = Node::new(
                "caret",
                Role::Group,
                "Caret",
                Rect::new(c.x, c.y, c.width, 1),
            );
            n.state.description = Some(format!(
                "line {}, column {} (graphemes), display cell {}",
                at.line, at.column, at.cell
            ));
            children.push(n.id.clone());
            out.push(n);
        }
        if let Some(row) = frame.find {
            let mut group = Node::new("find", Role::Group, "Find in file", row);
            group.state.description = Some(format!(
                "{}{}",
                d.find.summary(&d.session),
                if d.find.case_sensitive() {
                    "; case sensitive"
                } else {
                    "; ignoring case"
                }
            ));
            group.actions = [Choice::FindNext, Choice::FindPrevious]
                .into_iter()
                .map(|c| self.action(c))
                .collect();
            let mut field = Node::new("find-query", Role::TextBox, "Find", row);
            field.state.focused = d.in_find && cx.focused;
            field.state.description = Some(d.find.field.value().to_owned());
            group.children = vec![field.id.clone()];
            children.push(group.id.clone());
            out.push(group);
            out.push(field);
        }
        if let (Some(rect), Some(strip)) = (frame.strip, self.strip()) {
            match &strip.prompt {
                Prompt::Rename => {
                    let mut n = Node::new("rename", Role::TextBox, "Rename symbol", rect);
                    n.state.focused = cx.focused;
                    n.state.description = d.rename.as_ref().map(|f| f.value().to_owned());
                    children.push(n.id.clone());
                    out.push(n);
                }
                Prompt::Text(text, _) => {
                    let mut alert = Node::new("strip", Role::Alert, text, rect);
                    alert.binding = self.resource();
                    let buttons = strip.buttons.clone();
                    let mut kids = vec![];
                    for choice in &buttons {
                        let a = self.action(*choice);
                        alert.actions.push(a.clone());
                        let shown = self
                            .strip_buttons(rect)
                            .into_iter()
                            .find(|(c, _, _)| c == choice)
                            .map(|(_, r, _)| r)
                            .unwrap_or_else(|| Rect::new(rect.x, rect.y, 0, 0));
                        let mut b = Node::new(
                            &format!("strip:{}", choice.id()),
                            Role::Button,
                            choice.descriptor().title,
                            shown,
                        );
                        b.state.disabled = !a.enabled;
                        b.state.description = a.reason.clone();
                        b.shortcut =
                            Some(choice.descriptor().chord.to_owned()).filter(|c| !c.is_empty());
                        b.actions = vec![a];
                        kids.push(b);
                    }
                    alert.children = kids.iter().map(|k| k.id.clone()).collect();
                    children.push(alert.id.clone());
                    out.push(alert);
                    out.extend(kids);
                }
            }
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

/// The text after its first `skip` display cells.
fn skip_cells(text: &str, skip: usize) -> String {
    let mut cells = 0;
    let mut out = String::new();
    for c in text.chars() {
        if cells >= skip {
            out.push(c);
        }
        cells += c.width().unwrap_or(0);
    }
    out
}
