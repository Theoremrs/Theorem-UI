//! Drawing. Colors come from the core theme roles and, inside the terminal
//! region, from the vt palette the host supplied; nothing here names a color.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::host::ConnectionState;
use theorem_workbench_text::visible::visible;
use theorem_workbench_vt::TerminalView;

use crate::bound::{Bound, EndAsk, Role, Status, Tone};
use crate::catalog::{backend_word, persistence};
use crate::chooser::{self, LineKind};
use crate::panel::ProcessPanel;
use crate::report;
use crate::state::{Failure, FailureKind, Opening, Saved, Stage, reason_text};
use crate::wrap::{wrap, wrap_first};

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

/// Text wrapped to the pane's width on word boundaries, one row after
/// another from `y`; returns the row after the last. A word wider than the
/// pane is the only thing cut.
fn put_wrapped(buf: &mut Buffer, area: Rect, y: u16, text: &str, style: Style) -> u16 {
    let mut y = y;
    for row in wrap(text, area.width) {
        put(buf, area, y, &row, style);
        y = y.saturating_add(1);
    }
    y
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
        Status::Lost { link: true, .. } => "connection lost".to_owned(),
        Status::Lost { reason, .. } => format!("lost ({reason})"),
    };
    format!(
        "{} | {} | {} | epoch {}",
        b.session,
        backend_word(b.backend),
        what,
        b.epoch
    )
}

/// What a lost connection says, in a person's words: it is the connection
/// and not the program, why, and what to do. The host's own cause word is
/// mapped when it is one the contract names and otherwise shown as sent,
/// escaped; its next step the same.
pub(crate) fn loss_text(reason: &str, next_step: Option<&str>) -> String {
    let cause = match reason {
        "core_closed" => "the core closed the connection".to_owned(),
        "core_unavailable" => "the core cannot be reached".to_owned(),
        "subscribe_timed_out" => "the core did not answer the subscription in time".to_owned(),
        other if other.trim().is_empty() => "the host gave no cause".to_owned(),
        other => visible(other),
    };
    let step = match next_step {
        Some("retry") | None => {
            "Retry to reconnect: Enter or a attaches again. Esc returns to the chooser.".to_owned()
        }
        Some(other) => format!(
            "The host's next step: {}. Enter or a attaches again. Esc returns to the chooser.",
            visible(other)
        ),
    };
    format!(
        "Connection to the terminal lost: {cause}. The program may still be running; its outcome is not known. {step}"
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
        Status::Lost {
            reason,
            next_step,
            link: true,
        } => {
            return Some((loss_text(reason, next_step.as_deref()), Tone::Warning));
        }
        Status::Exited { reason, .. } | Status::Lost { reason, .. } => {
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
    if b.gone {
        return Some((
            format!(
                "The host no longer lists session {}: it is gone. Esc returns to the chooser.",
                b.session
            ),
            Tone::Warning,
        ));
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
    let data = p.catalog.snapshot(&p.identity.workspace);
    let rows = chooser::rows(&data, &p.identity);
    let lines = chooser::lines(
        &rows,
        &p.identity,
        data.adoption.as_ref(),
        p.note.as_deref(),
        area.width,
    );
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
            LineKind::Row => format!(
                "{} {}",
                if is_selected && !line.cont { ">" } else { " " },
                line.text
            ),
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
    let y = put_wrapped(
        buf,
        area,
        area.y,
        &format!("Shell | re-attaching to {}", saved.session),
        cx.theme.text,
    );
    put_wrapped(
        buf,
        area,
        y,
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
    let mut y = put_wrapped(
        buf,
        area,
        area.y,
        &format!("Shell | starting {} on {host}", op.choice.label),
        cx.theme.text,
    );
    match &op.uncertain {
        Some(reason) => {
            y = put_wrapped(
                buf,
                area,
                y,
                &format!(
                    "Unknown whether a shell started ({}). It was not retried and is not assumed.",
                    reason_text(reason)
                ),
                cx.theme.warning,
            );
            y = put_wrapped(
                buf,
                area,
                y,
                "If it did start, it will be listed under existing sessions. Esc returns to the chooser.",
                cx.theme.muted,
            );
        }
        None => {
            y = put_wrapped(
                buf,
                area,
                y,
                "Waiting for the host to start it.",
                cx.theme.muted,
            );
            y += 1;
        }
    }
    if let Some(from) = &op.follows {
        put_wrapped(
            buf,
            area,
            y,
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
    let mut y = put_wrapped(
        buf,
        area,
        area.y,
        &format!("Shell | {}", failure_title(failure)),
        cx.theme.error,
    );
    y = put_wrapped(
        buf,
        area,
        y,
        &format!("Host reason: {}", reason_text(&failure.reason)),
        cx.theme.text,
    );
    y = match &failure.code {
        Some(code) => put_wrapped(buf, area, y, &format!("Code: {code}"), cx.theme.muted),
        None => y + 1,
    };
    put_wrapped(
        buf,
        area,
        y + 1,
        "Enter tries it again as a new request. Esc returns to the chooser.",
        cx.theme.muted,
    );
}

/// The footer as it is drawn: wrapped to the pane's width, growing upward over
/// the screen's bottom rows so the grid keeps the size the host confirmed.
pub(crate) struct FooterView {
    pub rect: Rect,
    pub rows: Vec<String>,
    pub tone: Tone,
}

pub(crate) fn footer_view(area: Rect, b: &Bound) -> Option<FooterView> {
    if area.height < 3 {
        return None;
    }
    let (text, tone) = footer(b)?;
    let mut rows = wrap(&text, area.width);
    // Never over the header's own row.
    rows.truncate(usize::from(area.height - 1));
    let n = u16::try_from(rows.len()).unwrap_or(u16::MAX);
    Some(FooterView {
        rect: Rect::new(area.x, area.bottom() - n, area.width, n),
        rows,
        tone,
    })
}

/// The status line's rows: the first shares its row with the End control.
pub(crate) fn header_rows(head: &str, area: Rect, button: Option<Rect>) -> Vec<String> {
    let room = button.map_or(area.width, |r| r.x - area.x - 1);
    let mut rows = wrap_first(head, room, area.width);
    rows.truncate(usize::from(area.height.saturating_sub(1)).max(1));
    rows
}

/// Blank a rect so what is drawn over the screen does not show it through.
fn blank(buf: &mut Buffer, r: Rect, style: Style) {
    for y in r.y..r.bottom() {
        for x in r.x..r.right() {
            buf[(x, y)].reset();
        }
    }
    buf.set_style(r, style);
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
    let head_rows = header_rows(&head, area, button);

    // The grid keeps the size the host last confirmed; the rest is background.
    let resolved = p.styles.resolve(cx.theme);
    let pal = &resolved;
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

    // Status rows past the first, and the footer, are drawn over the screen.
    for (i, row) in head_rows.iter().enumerate() {
        let y = area.y + u16::try_from(i).unwrap_or(0);
        if i > 0 {
            blank(buf, Rect::new(area.x, y, area.width, 1), cx.theme.bg);
        }
        put(buf, area, y, row, header_style);
    }
    if let Some(r) = button {
        put(buf, r, r.y, END_LABEL, cx.theme.focus);
    }
    let footer = footer_view(area, b);
    // The program's own word, in its own band above the footer: never the
    // header's lifecycle row and never a notice.
    let bottom = footer.as_ref().map_or(area.bottom(), |f| f.rect.y);
    let head_n = u16::try_from(head_rows.len()).unwrap_or(u16::MAX);
    if let Some(band) = report::band(area, b, head_n, bottom) {
        blank(buf, band.rect, cx.theme.bg);
        for (i, row) in band.rows.iter().enumerate() {
            let y = band.rect.y + u16::try_from(i).unwrap_or(0);
            put(buf, band.rect, y, row, cx.theme.muted);
        }
    }
    if let Some(f) = footer {
        blank(buf, f.rect, cx.theme.bg);
        for (i, row) in f.rows.iter().enumerate() {
            let y = f.rect.y + u16::try_from(i).unwrap_or(0);
            put(buf, f.rect, y, row, tone_style(f.tone, cx));
        }
    }
}
