//! Drawing. Colors come from the core theme roles and, inside the terminal
//! region, from the vt palette the host supplied; nothing here names a color.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::host::ConnectionState;
use theorem_workbench_vt::TerminalView;

use crate::bound::{Bound, EndAsk, Role, Status, Tone};
use crate::catalog::{backend_word, persistence};
use crate::chooser::{self, LineKind};
use crate::panel::ProcessPanel;
use crate::state::{Failure, FailureKind, Opening, Saved, Stage};

/// The three bands of a live pane.
#[derive(Clone, Copy)]
pub(crate) struct Geo {
    pub header: Rect,
    pub term: Rect,
    pub footer: Rect,
}

pub(crate) fn geo(area: Rect) -> Geo {
    let header = Rect::new(area.x, area.y, area.width, area.height.min(1));
    let footer_h = u16::from(area.height >= 3);
    let footer = Rect::new(
        area.x,
        area.y + area.height - footer_h,
        area.width,
        footer_h,
    );
    let used = header.height + footer.height;
    let term = Rect::new(
        area.x,
        area.y + header.height,
        area.width,
        area.height.saturating_sub(used),
    );
    Geo {
        header,
        term,
        footer,
    }
}

const END_LABEL: &str = "[End process]";

/// Where the End process control sits, when the process can be ended.
pub(crate) fn end_button(header: Rect, b: &Bound) -> Option<Rect> {
    let width = END_LABEL.chars().count() as u16;
    if !b.running() || b.attaching() || header.width <= width + 8 {
        return None;
    }
    Some(Rect::new(header.right() - width, header.y, width, 1))
}

fn tone_style(tone: Tone, cx: &ViewCtx) -> Style {
    match tone {
        Tone::Error => cx.theme.error,
        Tone::Warning => cx.theme.warning,
        Tone::Muted => cx.theme.muted,
    }
}

fn put(buf: &mut Buffer, area: Rect, y: u16, text: &str, style: Style) {
    if y < area.y || y >= area.bottom() || area.width == 0 {
        return;
    }
    buf.set_stringn(area.x, y, text, usize::from(area.width), style);
}

/// The one line that says what the pane is, from host fields only.
pub(crate) fn status_line(b: &Bound) -> String {
    let what = match &b.status {
        Status::Running if b.attaching() => match &b.initial {
            Some(Some(reason)) => format!("attach outcome unknown ({reason})"),
            _ => "attaching".to_owned(),
        },
        Status::Running => match &b.role {
            Role::Controller => "controlling".to_owned(),
            Role::Observer(_) => "observing".to_owned(),
        },
        Status::Exited { code, reason } => match code {
            Some(code) => format!("exited with code {code} ({reason})"),
            None => format!("exited ({reason})"),
        },
        Status::Lost { reason } => format!("lost ({reason})"),
    };
    format!(
        "{} | {} | {} | epoch {}",
        b.session,
        backend_word(b.backend),
        what,
        b.epoch
    )
}

/// The footer's text and tone, most urgent first.
pub(crate) fn footer(b: &Bound) -> Option<(String, Tone)> {
    match &b.end {
        EndAsk::Asking => {
            return Some((
                format!(
                    "End process {}? This stops the program for everyone. Enter or y ends it, Esc cancels.",
                    b.session
                ),
                Tone::Warning,
            ));
        }
        EndAsk::Pending => {
            return Some(("Ending... waiting for the host.".to_owned(), Tone::Muted));
        }
        EndAsk::Unknown(reason) => {
            return Some((
                format!("Whether the process ended is unknown ({reason}). Not retried."),
                Tone::Warning,
            ));
        }
        EndAsk::No => {}
    }
    if b.offer_control && !b.controlling() && b.running() && !b.attaching() {
        let why = match &b.role {
            Role::Observer(why) => why.text(),
            Role::Controller => String::new(),
        };
        return Some((
            format!("{why} Enter requests control, Esc dismisses."),
            Tone::Warning,
        ));
    }
    if let Some(note) = &b.notice {
        return Some((note.text.clone(), note.tone));
    }
    let unknown = b.unknown_inputs();
    if unknown > 0 {
        return Some((
            format!("{unknown} input(s) unconfirmed. Click here to resend the same input."),
            Tone::Warning,
        ));
    }
    match &b.status {
        Status::Exited { reason, .. } | Status::Lost { reason } => {
            let lost = matches!(b.status, Status::Lost { .. });
            return Some((
                format!(
                    "{} Host reason: {reason}. n starts a new shell (a different process), a attaches again, Esc returns to the chooser.",
                    if lost {
                        "The program is lost."
                    } else {
                        "The program has ended."
                    }
                ),
                Tone::Warning,
            ));
        }
        Status::Running => {}
    }
    if let Some(from) = &b.follows {
        return Some((
            format!("A new process. It does not continue {from}."),
            Tone::Muted,
        ));
    }
    b.provenance
        .text(b.program, b.epoch)
        .map(|t| (t, Tone::Muted))
}

pub(crate) fn view(p: &ProcessPanel, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    buf.set_style(area, cx.theme.bg);
    match &p.stage {
        Stage::Choosing => choosing(p, area, buf, cx),
        Stage::Restoring(saved) => restoring(saved, area, buf, cx),
        Stage::Opening(op) => opening(p, op, area, buf, cx),
        Stage::Failed(failure) => failed(failure, area, buf, cx),
        Stage::Bound(b) => live(p, b, area, buf, cx),
    }
}

fn choosing(p: &ProcessPanel, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    let rows = chooser::rows(&p.catalog.snapshot(&p.identity.workspace), &p.identity);
    let lines = chooser::lines(&rows, &p.identity, p.note.as_deref());
    let selected = p.selected.min(rows.len().saturating_sub(1));
    let top = chooser::top_for(&lines, selected, usize::from(area.height));
    for (i, line) in lines
        .iter()
        .skip(top)
        .take(usize::from(area.height))
        .enumerate()
    {
        let y = area.y + i as u16;
        let is_selected = line.row == Some(selected) && !rows.is_empty();
        let enabled = line.row.and_then(|r| rows.get(r)).is_none_or(|r| r.enabled);
        let base = match line.kind {
            LineKind::Heading => cx.theme.text,
            LineKind::Body => cx.theme.text,
            LineKind::Muted | LineKind::RowDetail => cx.theme.muted,
            LineKind::Note => cx.theme.warning,
            LineKind::Row => cx.theme.text,
        };
        let style = match (is_selected, enabled) {
            (true, true) => cx.theme.selected,
            (_, false) if line.row.is_some() => cx.theme.muted,
            _ => base,
        };
        let text = match line.kind {
            LineKind::Row => format!("{} {}", if is_selected { ">" } else { " " }, line.text),
            LineKind::RowDetail => format!("  {}", line.text),
            _ => line.text.clone(),
        };
        if is_selected {
            buf.set_style(Rect::new(area.x, y, area.width, 1), style);
        }
        put(buf, area, y, &text, style);
    }
}

fn restoring(saved: &Saved, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    put(
        buf,
        area,
        area.y,
        &format!("Shell | re-attaching to {}", saved.session),
        cx.theme.text,
    );
    put(
        buf,
        area,
        area.y + 1,
        &format!(
            "Saved terminal {} in workspace {} ({}). Attaching by identity; nothing is relaunched. Esc returns to the chooser.",
            saved.session,
            saved.workspace,
            persistence(saved.backend)
        ),
        cx.theme.muted,
    );
}

fn opening(p: &ProcessPanel, op: &Opening, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    let host = chooser::host_of(&p.identity, None);
    put(
        buf,
        area,
        area.y,
        &format!("Shell | starting {} on {host}", op.choice.label),
        cx.theme.text,
    );
    match &op.uncertain {
        Some(reason) => {
            put(
                buf,
                area,
                area.y + 1,
                &format!(
                    "Unknown whether a shell started ({reason}). It was not retried and is not assumed."
                ),
                cx.theme.warning,
            );
            put(
                buf,
                area,
                area.y + 2,
                "If it did start, it will be listed under existing sessions. Esc returns to the chooser.",
                cx.theme.muted,
            );
        }
        None => {
            put(
                buf,
                area,
                area.y + 1,
                "Waiting for the host to start it.",
                cx.theme.muted,
            );
        }
    }
    if let Some(from) = &op.follows {
        put(
            buf,
            area,
            area.y + 3,
            &format!("This is a new process. It does not continue {from}."),
            cx.theme.muted,
        );
    }
}

pub(crate) fn failure_title(failure: &Failure) -> &'static str {
    match failure.kind {
        FailureKind::Unavailable => "Backend unavailable",
        FailureKind::NotFound => "Terminal not found",
        FailureKind::Refused => "The host refused",
        FailureKind::Failed => "The request failed",
    }
}

fn failed(failure: &Failure, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    put(
        buf,
        area,
        area.y,
        &format!("Shell | {}", failure_title(failure)),
        cx.theme.error,
    );
    put(
        buf,
        area,
        area.y + 1,
        &format!("Host reason: {}", failure.reason),
        cx.theme.text,
    );
    if let Some(code) = &failure.code {
        put(
            buf,
            area,
            area.y + 2,
            &format!("Code: {code}"),
            cx.theme.muted,
        );
    }
    put(
        buf,
        area,
        area.y + 4,
        "Enter tries it again as a new request. Esc returns to the chooser.",
        cx.theme.muted,
    );
}

fn live(p: &ProcessPanel, b: &Bound, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    let g = geo(area);
    let header_style = if b.running() {
        cx.theme.text
    } else {
        cx.theme.muted
    };
    let mut head = status_line(b);
    if let Some(c) = p.connection
        && c != ConnectionState::Open
    {
        head.push_str(&format!(" | connection {c:?}"));
    }
    let button = end_button(g.header, b);
    let room = button.map_or(g.header.width, |r| r.x - g.header.x - 1);
    put(
        buf,
        Rect::new(g.header.x, g.header.y, room, 1),
        g.header.y,
        &head,
        header_style,
    );
    if let Some(r) = button {
        put(buf, r, r.y, END_LABEL, cx.theme.focus);
    }

    // The grid keeps the size the host last confirmed; the rest is background.
    let pal = &p.styles.palette;
    buf.set_style(g.term, Style::new().fg(pal.fg).bg(pal.bg));
    let (rows, cols) = b.screen.size();
    let shown = Rect::new(
        g.term.x,
        g.term.y,
        cols.min(g.term.width),
        rows.min(g.term.height),
    );
    if shown.width > 0 && shown.height > 0 {
        let view = TerminalView::new(&b.screen, pal)
            .show_cursor(cx.focused && b.controlling() && b.running());
        ratatui::widgets::Widget::render(view, shown, buf);
    }

    if let Some((text, tone)) = footer(b) {
        put(buf, g.footer, g.footer.y, &text, tone_style(tone, cx));
    }
}
