//! Cells and semantic nodes for the Threads panel, from the same rows.
//!
//! Every title, project name, delegation label, machine and program word comes
//! from outside and is spelled out by `visible` before it is drawn; the exact
//! text goes on the semantic node through `caret_text`.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Clear, Widget};
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::semantics::{Node, NodeId, Role};
use theorem_workbench_core::threads::{ThreadItem, ThreadTag, relative};
use theorem_workbench_core::{Theme, ViewCtx};
use theorem_workbench_text::field::FieldStyles;
use theorem_workbench_text::visible::visible;

use super::rows::{Row, cwd_tail, program_word, session_name};
use super::{Menu, Mode, ThreadsPanel};
use crate::caret::caret_text;
use theorem_workbench_core::host::{ProgramReport, ProgramState, TerminalSessionState};

fn width(text: &str) -> usize {
    Span::raw(text).width()
}

/// `text` cut to `room` cells, with an ellipsis where it was cut.
fn fit(text: &str, room: usize) -> String {
    if width(text) <= room {
        return text.to_owned();
    }
    if room == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = width(c.encode_utf8(&mut [0; 4]));
        if used + w + 1 > room {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('\u{2026}');
    out
}

/// Write `text` from `x`, spelled out and cut at `limit`; returns the next free column.
fn put(buf: &mut Buffer, x: u16, y: u16, limit: u16, text: &str, style: Style) -> u16 {
    if x >= limit {
        return x;
    }
    let (nx, _) = buf.set_stringn(x, y, visible(text), usize::from(limit - x), style);
    nx
}

/// The ANSI color a tag names.
fn tag_color(theme: &Theme, tag: ThreadTag) -> Color {
    let at = match tag {
        ThreadTag::Red => 1,
        ThreadTag::Green => 2,
        ThreadTag::Yellow => 3,
        ThreadTag::Blue => 4,
        ThreadTag::Magenta => 5,
        ThreadTag::Cyan => 6,
    };
    theme.ansi[at]
}

/// What a row's state adds to its text: a thread waiting on the person is in the warning
/// colour. Running and unread are said by the stripe, the words at the right and a bold title.
fn tint(theme: &Theme, t: &ThreadItem) -> Style {
    if t.needs_you.is_some() {
        theme.warning
    } else {
        Style::default()
    }
}

/// The edge stripe: the tag's color, else the state's.
fn stripe(theme: &Theme, line: Style, t: &ThreadItem) -> Option<Style> {
    if let Some(tag) = t.tag {
        return Some(line.fg(tag_color(theme, tag)));
    }
    if t.needs_you.is_some() {
        Some(line.patch(theme.warning))
    } else if t.running {
        Some(line.patch(theme.success))
    } else {
        None
    }
}

fn state_words(t: &ThreadItem) -> String {
    let mut words: Vec<String> = vec![];
    if t.running {
        words.push("running".into());
    }
    if let Some(why) = &t.needs_you {
        words.push(format!("needs you: {}", visible(why)));
    }
    if t.unread {
        words.push("unread".into());
    }
    if t.pinned {
        words.push("pinned".into());
    }
    if t.archived {
        words.push("archived".into());
    }
    if let Some(tag) = t.tag {
        words.push(format!("tag {}", tag.name()));
    }
    words.join(", ")
}

/// The word at the right of a session row: the program's own report, else the
/// host's own session state when the session ended.
fn session_word(s: &theorem_workbench_core::host::TerminalSessionInfo) -> Option<String> {
    program_word(s).or(match s.state {
        TerminalSessionState::Running => None,
        TerminalSessionState::Exited => Some("exited".into()),
        TerminalSessionState::Lost => Some("lost".into()),
    })
}

fn session_tone(theme: &Theme, s: &theorem_workbench_core::host::TerminalSessionInfo) -> Style {
    match &s.program_report {
        ProgramReport::Current { status, .. } => match status.state {
            ProgramState::Working | ProgramState::Done => theme.success,
            ProgramState::Blocked => theme.warning,
            ProgramState::Error => theme.error,
            ProgramState::Idle | ProgramState::Unknown => theme.muted,
        },
        _ => theme.muted,
    }
}

pub(super) fn details_lines(p: &ThreadsPanel, t: &ThreadItem) -> Vec<String> {
    let l = p.listing.as_ref();
    let now = l.map_or(0, |l| l.as_of_ms);
    let project_names: Vec<String> = t
        .project_ids
        .iter()
        .map(|id| {
            l.and_then(|l| l.projects.iter().find(|p| &p.id == id))
                .map_or_else(|| id.clone(), |p| p.name.clone())
        })
        .collect();
    let mut lines = vec![
        format!("Title: {}", t.title),
        format!("Id: {}", t.id),
        format!("Projects: {}", project_names.join(", ")),
    ];
    let state = state_words(t);
    lines.push(format!(
        "State: {}",
        if state.is_empty() { "idle" } else { &state }
    ));
    if let Some(ms) = t.created_ms {
        lines.push(format!("Started: {}", relative(now, ms)));
    }
    if let Some(ms) = t.last_message_ms {
        lines.push(format!("Last activity: {}", relative(now, ms)));
    }
    if let Some(origin) = &t.origin {
        let name = l
            .and_then(|l| l.threads.iter().find(|x| &x.id == origin))
            .map_or(origin.as_str(), |x| x.title.as_str());
        lines.push(format!("Began from: {name}"));
    }
    if !t.delegations.is_empty() {
        lines.push(format!("Delegations: {}", t.delegations.len()));
    }
    lines
}

/// Where the cursor row sits in the body and how tall it is.
fn cursor_span(p: &ThreadsPanel) -> Option<(usize, usize)> {
    let rows = p.rows();
    let at = p.cursor(&rows)?;
    if at < p.scroll {
        return None;
    }
    let y = p.header() + rows[p.scroll..at].iter().map(Row::height).sum::<usize>();
    Some((y, rows[at].height()))
}

/// The menu's place in the body, below the cursor row when it fits, else above.
pub(super) fn menu_rect(p: &ThreadsPanel, menu: &Menu) -> Rect {
    let (bw, bh) = (p.body.width, p.body.height);
    let widest = menu.items.iter().map(|(_, l)| width(l)).max().unwrap_or(0) as u16;
    let w = (widest + 4).min(bw.saturating_sub(1)).max(1);
    let h = (menu.items.len() as u16).min(bh).max(1);
    let (y, rows) = cursor_span(p).unwrap_or((0, 1));
    let below = (y + rows) as u16;
    let top = if below + h <= bh {
        below
    } else {
        (y as u16).saturating_sub(h).min(bh.saturating_sub(h))
    };
    Rect::new(1.min(bw.saturating_sub(w)), top, w, h)
}

/// The first item shown when the menu is taller than its room.
pub(super) fn menu_first(menu: &Menu, rect: Rect) -> usize {
    (menu.at + 1).saturating_sub(usize::from(rect.height))
}

pub(super) fn view(p: &ThreadsPanel, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    let theme = cx.theme;
    buf.set_style(area, theme.bg);
    let right = area.x + area.width;
    let bottom = area.y + area.height;
    let mut y = area.y;
    if let Some(text) = &p.banner {
        put(buf, area.x, y, right, text, theme.text.patch(theme.warning));
        y += 1;
    }
    let rows = p.rows();
    let cursor = p.cursor(&rows);
    let now = p.listing.as_ref().map_or(0, |l| l.as_of_ms);
    for (i, row) in rows
        .iter()
        .enumerate()
        .skip(p.scroll.min(rows.len().saturating_sub(1)))
    {
        if y >= bottom {
            break;
        }
        let here = cursor == Some(i);
        let thread = match row {
            Row::Thread { idx, .. } => p.listing.as_ref().map(|l| &l.threads[*idx]),
            _ => None,
        };
        let line = if here {
            if cx.focused {
                theme.focus
            } else {
                theme.selected
            }
        } else {
            theme
                .text
                .patch(thread.map_or(Style::default(), |t| tint(theme, t)))
        };
        let lines = row.height().min(usize::from(bottom - y)) as u16;
        buf.set_style(Rect::new(area.x, y, area.width, lines), line);
        // Column 0 is the stripe; the rest is indented by depth.
        let x0 = area.x + 1 + (row.depth() * 2) as u16;
        match row {
            Row::Label { text, .. } => {
                put(buf, area.x + 1, y, right, text, line.patch(theme.muted));
            }
            Row::Group { text, .. } => {
                put(buf, area.x + 1, y, right, text, line.patch(theme.muted));
            }
            Row::Status { text, .. } => {
                put(buf, area.x + 2, y, right, text, line.patch(theme.muted));
            }
            Row::Confirm { text } => {
                put(buf, x0, y, right, text, line.patch(theme.warning));
            }
            Row::Project { name, open, .. } => {
                let mark = if *open { "v " } else { "> " };
                let x = put(buf, area.x + 1, y, right, mark, line);
                put(buf, x, y, right, name, line.add_modifier(Modifier::BOLD));
            }
            Row::Edit { .. } => {
                if let Mode::Edit(edit) = &p.mode {
                    let x = x0 + 2;
                    let styles = FieldStyles {
                        text: theme.field_focus,
                        selection: theme.selection,
                        caret: Style::new().add_modifier(Modifier::REVERSED),
                        hint: theme.muted,
                    };
                    let end = edit.input.draw(
                        buf,
                        Rect::new(x, y, right.saturating_sub(x), 1),
                        &styles,
                        true,
                        "",
                    );
                    if let Some(error) = &edit.error {
                        put(buf, end + 1, y, right, error, line.patch(theme.error));
                    }
                }
            }
            Row::Thread { open, second, .. } => {
                let Some(t) = thread else { continue };
                let base = if t.archived && !here {
                    line.patch(theme.muted)
                } else {
                    line
                };
                if let Some(s) = stripe(theme, base, t) {
                    put(buf, area.x, y, right, "\u{258e}", s);
                }
                let mark = match open {
                    Some(true) => "v ",
                    Some(false) => "> ",
                    None => "  ",
                };
                let tx = put(buf, x0, y, right, mark, base);
                // What is at the right: running, needs you, unread, or the time.
                let (label, style) = if t.running {
                    ("running".to_owned(), base.patch(theme.success))
                } else if let Some(why) = &t.needs_you {
                    (fit(&visible(why), 14), base.patch(theme.warning))
                } else if t.unread {
                    ("\u{25cf}".to_owned(), base.add_modifier(Modifier::BOLD))
                } else {
                    let ms = t.last_message_ms.or(t.created_ms);
                    (
                        ms.map(|m| relative(now, m)).unwrap_or_default(),
                        base.patch(theme.muted),
                    )
                };
                let lw = width(&label) as u16;
                let lx = right.saturating_sub(lw + 1).max(tx);
                if lw > 0 {
                    put(buf, lx, y, right, &label, style);
                }
                let room = usize::from(lx.saturating_sub(tx)).saturating_sub(1);
                let title_style = if t.unread
                    || p.listing
                        .as_ref()
                        .is_some_and(|l| l.open.as_ref().is_some_and(|o| o.thread_id == t.id))
                {
                    base.add_modifier(Modifier::BOLD)
                } else {
                    base
                };
                put(
                    buf,
                    tx,
                    y,
                    right,
                    &fit(&visible(&t.title), room),
                    title_style,
                );
                if let Some(name) = second
                    && y + 1 < bottom
                {
                    let sub = base.patch(theme.muted);
                    put(
                        buf,
                        tx,
                        y + 1,
                        right,
                        &fit(&visible(name), usize::from(right.saturating_sub(tx))),
                        sub,
                    );
                }
            }
            Row::Delegation { label, .. } => {
                let x = put(buf, x0, y, right, "  ", line);
                let style = line.patch(theme.muted);
                put(
                    buf,
                    x,
                    y,
                    right,
                    &fit(&visible(label), usize::from(right.saturating_sub(x))),
                    style,
                );
            }
            Row::Session { idx, .. } => {
                let Some(s) = p.sessions.get(*idx) else {
                    continue;
                };
                let base = if s.admitted || here {
                    line
                } else {
                    line.patch(theme.muted)
                };
                let mark = if s.admitted { "  " } else { "+ " };
                let tx = put(buf, x0, y, right, mark, base);
                let word = session_word(s);
                let ww = word.as_deref().map_or(0, |w| width(&visible(w))).min(14) as u16;
                let wx = right.saturating_sub(ww + 1).max(tx);
                if let Some(w) = &word {
                    let style = base.patch(session_tone(theme, s));
                    put(buf, wx, y, right, &fit(&visible(w), 14), style);
                }
                let room = usize::from(wx.saturating_sub(tx)).saturating_sub(1);
                let name = visible(session_name(s));
                let name_w = width(&name).min(room);
                let mut x = put(buf, tx, y, right, &fit(&name, room), base);
                if let Some(cwd) = &s.cwd {
                    let left = room.saturating_sub(name_w + 1);
                    if left > 1 {
                        x = put(
                            buf,
                            x + 1,
                            y,
                            right,
                            &fit(&visible(&cwd_tail(cwd)), left),
                            base.patch(theme.muted),
                        );
                    }
                }
                let _ = x;
            }
        }
        y += row.height() as u16;
    }
    match &p.mode {
        Mode::Menu(menu) => draw_menu(p, menu, area, buf, theme),
        Mode::Details(id) => {
            if let Some(t) = p.thread_by_id(id) {
                let r = Rect::new(area.x, area.y, area.width, area.height);
                Clear.render(r, buf);
                buf.set_style(r, theme.popup);
                for (n, text) in details_lines(p, t).iter().enumerate() {
                    let ly = area.y + n as u16;
                    if ly >= bottom {
                        break;
                    }
                    put(buf, area.x + 1, ly, right, text, theme.popup);
                }
            }
        }
        _ => {}
    }
}

fn draw_menu(p: &ThreadsPanel, menu: &Menu, area: Rect, buf: &mut Buffer, theme: &Theme) {
    let rect = menu_rect(p, menu);
    let first = menu_first(menu, rect);
    for n in 0..usize::from(rect.height) {
        let Some((_, label)) = menu.items.get(first + n) else {
            break;
        };
        let style = if first + n == menu.at {
            theme.popup_selected
        } else {
            theme.popup
        };
        let r = Rect::new(area.x + rect.x, area.y + rect.y + n as u16, rect.width, 1);
        Clear.render(r, buf);
        buf.set_style(r, style);
        put(buf, r.x + 1, r.y, r.x + r.width, label, style);
    }
}

fn level(depth: usize) -> u16 {
    u16::try_from(depth + 1).unwrap_or(u16::MAX)
}

fn count(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

pub(super) fn semantics(p: &ThreadsPanel, area: Rect, cx: &ViewCtx) -> Vec<Node> {
    let rows = p.rows();
    let cursor = p.cursor(&rows);
    let first = p.scroll.min(rows.len().saturating_sub(1));
    let mut tree = Node::new("tree", Role::Tree, "Threads", area);
    tree.binding = ResourceRef::None;
    tree.state.description = p.banner.as_deref().map(visible);
    let mut items = vec![];
    let mut y = area.y + p.header() as u16;
    let bottom = area.y + area.height;
    for (i, row) in rows.iter().enumerate().skip(first) {
        if y >= bottom {
            break;
        }
        let rect = Rect::new(area.x, y, area.width, 1);
        y += row.height() as u16;
        let selected = cursor == Some(i);
        let node = match row {
            Row::Label { id, text } => Node::new(&format!("l:{id}"), Role::Heading, text, rect),
            Row::Group { id, text } => {
                Node::new(&format!("g:{id}"), Role::Group, &visible(text), rect)
            }
            Row::Status { id, text } => {
                Node::new(&format!("s:{id}"), Role::Status, &visible(text), rect)
            }
            Row::Confirm { text } => Node::new("confirm", Role::Alert, &visible(text), rect),
            Row::Edit { .. } => {
                let mut n = Node::new("edit", Role::TextBox, "Rename", rect);
                n.state.focused = cx.focused;
                if let Mode::Edit(edit) = &p.mode {
                    n.state.description = edit.error.as_deref().map(visible);
                    let (anchor, at) = (edit.input.anchor(), edit.input.cursor());
                    caret_text(edit.input.value(), anchor, at).put(&mut n);
                }
                n
            }
            Row::Project {
                key,
                name,
                open,
                pos,
                set,
                ..
            } => {
                let mut n = Node::new(&format!("r:{key}"), Role::TreeItem, &visible(name), rect);
                n.level = Some(1);
                n.pos_in_set = Some(count(*pos));
                n.set_size = Some(count(*set));
                n.state.selected = selected;
                n.state.focused = selected && cx.focused;
                n.state.expanded = Some(*open);
                caret_text(name, 0, 0).put(&mut n);
                n
            }
            Row::Thread {
                key,
                idx,
                depth,
                open,
                pos,
                set,
                ..
            } => {
                let Some(t) = p.listing.as_ref().map(|l| &l.threads[*idx]) else {
                    continue;
                };
                let mut n = Node::new(
                    &format!("r:{key}"),
                    Role::TreeItem,
                    &visible(&t.title),
                    rect,
                );
                n.level = Some(level(*depth));
                n.pos_in_set = Some(count(*pos));
                n.set_size = Some(count(*set));
                n.state.selected = selected;
                n.state.focused = selected && cx.focused;
                n.state.expanded = *open;
                n.state.busy = t.running;
                let words = state_words(t);
                n.state.description = (!words.is_empty()).then_some(words);
                caret_text(&t.title, 0, 0).put(&mut n);
                n
            }
            Row::Delegation {
                key,
                label,
                depth,
                pos,
                set,
                ..
            } => {
                let mut n = Node::new(&format!("r:{key}"), Role::TreeItem, &visible(label), rect);
                n.level = Some(level(*depth));
                n.pos_in_set = Some(count(*pos));
                n.set_size = Some(count(*set));
                n.state.selected = selected;
                n.state.focused = selected && cx.focused;
                n.state.description = Some("delegation".into());
                caret_text(label, 0, 0).put(&mut n);
                n
            }
            Row::Session {
                key,
                idx,
                depth,
                pos,
                set,
            } => {
                let Some(s) = p.sessions.get(*idx) else {
                    continue;
                };
                let name = session_name(s);
                let mut n = Node::new(&format!("r:{key}"), Role::TreeItem, &visible(name), rect);
                n.level = Some(level(*depth));
                n.pos_in_set = Some(count(*pos));
                n.set_size = Some(count(*set));
                n.state.selected = selected;
                n.state.focused = selected && cx.focused;
                let mut words: Vec<String> = vec![];
                if !s.admitted {
                    words.push("on your Herdr, not in this workspace yet".into());
                }
                if let Some(cwd) = &s.cwd {
                    words.push(visible(&cwd_tail(cwd)));
                }
                if let Some(word) = session_word(s) {
                    words.push(visible(&word));
                }
                n.state.description = (!words.is_empty()).then(|| words.join(", "));
                caret_text(name, 0, 0).put(&mut n);
                n
            }
        };
        items.push(node);
    }
    let mut extra: Vec<Node> = vec![];
    match &p.mode {
        Mode::Menu(menu) => {
            let r = menu_rect(p, menu);
            let rect = Rect::new(area.x + r.x, area.y + r.y, r.width, r.height);
            let mut m = Node::new("menu", Role::Menu, "Thread menu", rect);
            let mut kids = vec![];
            for (n, (_, label)) in menu.items.iter().enumerate() {
                let mut item = Node::new(
                    &format!("m:{n}"),
                    Role::MenuItem,
                    label,
                    Rect::new(rect.x, rect.y + n as u16, rect.width, 1),
                );
                item.state.selected = n == menu.at;
                kids.push(NodeId::new(item.id.as_str()));
                extra.push(item);
            }
            m.children = kids;
            extra.insert(0, m);
        }
        Mode::Details(id) => {
            if let Some(t) = p.thread_by_id(id) {
                let mut d = Node::new("details", Role::Dialog, "Thread details", area);
                caret_text(&details_lines(p, t).join("\n"), 0, 0).put(&mut d);
                extra.push(d);
            }
        }
        _ => {}
    }
    tree.children = items
        .iter()
        .chain(
            extra
                .iter()
                .filter(|n| matches!(n.role, Role::Menu | Role::Dialog)),
        )
        .map(|n| NodeId::new(n.id.as_str()))
        .collect();
    let mut out = vec![tree];
    out.extend(items);
    out.extend(extra);
    out
}
