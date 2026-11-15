//! Cells and semantic nodes for the Files panel, from the same rows.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::completion::FileKind;
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::semantics::{Node, NodeId, Role};

use super::tree::{NoteState, Row};
use super::{Edit, FilesPanel, Mode};

/// Write `text` from `x`, stopping at `limit`; returns the next free column.
fn put(buf: &mut Buffer, x: u16, y: u16, limit: u16, text: &str, style: Style) -> u16 {
    if x >= limit {
        return x;
    }
    let room = usize::from(limit - x);
    let (nx, _) = buf.set_stringn(x, y, text, room, style);
    nx
}

fn mark(row: &Row) -> &'static str {
    match row {
        Row::Entry {
            expanded: Some(true),
            ..
        } => "v ",
        Row::Entry {
            expanded: Some(false),
            ..
        } => "> ",
        _ => "  ",
    }
}

pub(super) fn view(p: &FilesPanel, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    let theme = cx.theme;
    buf.set_style(area, theme.bg);
    let right = area.x + area.width;
    let mut y = area.y;
    if let Some(text) = p.banner() {
        let mut style = theme.text;
        style = style.add_modifier(Modifier::BOLD);
        put(buf, area.x, y, right, text, style);
        y += 1;
    }
    let rows = p.rows();
    let cursor = p.cursor_path(&rows);
    let bottom = area.y + area.height;
    let scroll = p.scroll.min(rows.len().saturating_sub(1));
    for row in rows.iter().skip(scroll) {
        if y >= bottom {
            break;
        }
        let here = row.path().is_some() && row.path() == cursor.as_deref();
        let line = if here {
            if cx.focused {
                theme.focus
            } else {
                theme.selected
            }
        } else {
            theme.text
        };
        buf.set_style(Rect::new(area.x, y, area.width, 1), line);
        let mut x = put(buf, area.x, y, right, &" ".repeat(row.depth() * 2), line);
        match row {
            Row::Entry {
                name,
                kind,
                note,
                mark: clip,
                ..
            } => {
                x = put(buf, x, y, right, mark(row), line);
                let shown = match kind {
                    FileKind::Directory => format!("{name}/"),
                    FileKind::Symlink => format!("{name}@"),
                    FileKind::File => name.clone(),
                };
                x = put(buf, x, y, right, &shown, line);
                if let Some(clip) = clip {
                    x = put(
                        buf,
                        x,
                        y,
                        right,
                        &format!(" ({clip})"),
                        line.patch(theme.muted),
                    );
                }
                if let Some(note) = note {
                    let style = match note {
                        NoteState::Pending(_) => theme.muted,
                        NoteState::Problem(_) => line.add_modifier(Modifier::BOLD),
                    };
                    put(buf, x, y, right, &format!("  {}", note.label()), style);
                }
            }
            Row::Status { text, .. } => {
                put(
                    buf,
                    x,
                    y,
                    right,
                    &format!("  {text}"),
                    line.patch(theme.muted),
                );
            }
            Row::Confirm { text, .. } => {
                put(
                    buf,
                    x,
                    y,
                    right,
                    &format!("  {text}"),
                    line.add_modifier(Modifier::BOLD),
                );
            }
            Row::Edit { directory, .. } => {
                if let Mode::Edit(Edit { input, error, .. }) = &p.mode {
                    let field = if *directory { "> " } else { "  " };
                    x = put(buf, x, y, right, field, line);
                    let width = usize::from(right.saturating_sub(x));
                    let scroll = input.visual_scroll(width.max(1));
                    let value: String = input.value().chars().skip(scroll).collect();
                    let end = put(buf, x, y, right, &value, theme.focus);
                    let caret = x + (input.visual_cursor().saturating_sub(scroll)) as u16;
                    if caret < right {
                        let cell = &mut buf[(caret, y)];
                        let style = cell.style().add_modifier(Modifier::REVERSED);
                        cell.set_style(style);
                        if caret >= end {
                            cell.set_symbol(" ");
                        }
                    }
                    if let Some(error) = error {
                        put(
                            buf,
                            end.max(caret + 1),
                            y,
                            right,
                            &format!("  {error}"),
                            line.add_modifier(Modifier::BOLD),
                        );
                    }
                }
            }
        }
        y += 1;
    }
}

/// `level N, P of S`: what a tree item carries beyond its name. The core's
/// node has no fields for level or position yet, so they ride in the
/// description, the one place a screen reader reads after the name.
fn place(depth: usize, pos: usize, set: usize) -> String {
    format!("level {}, {pos} of {set}", depth + 1)
}

pub(super) fn semantics(p: &FilesPanel, area: Rect, cx: &ViewCtx) -> Vec<Node> {
    let rows = p.rows();
    let cursor = p.cursor_path(&rows);
    let first = p.scroll.min(rows.len().saturating_sub(1));
    let window = usize::from(area.height).saturating_sub(p.header());
    let mut tree = Node::new("tree", Role::Tree, "Files", area);
    tree.binding = ResourceRef::Workspace {
        workspace: p.workspace(),
    };
    tree.state.description = p.banner().map(str::to_owned);
    let mut items = vec![];
    let mut y = area.y + p.header() as u16;
    let mut last_entry: Option<String> = None;
    for row in rows.iter().skip(first).take(window) {
        let rect = Rect::new(area.x, y, area.width, 1);
        y += 1;
        let selected = row.path().is_some() && row.path() == cursor.as_deref();
        let node = match row {
            Row::Entry {
                path,
                name,
                kind,
                depth,
                expanded,
                note,
                pos,
                set,
                ..
            } => {
                last_entry = Some(path.clone());
                let mut n = Node::new(&format!("f:{path}"), Role::TreeItem, name, rect);
                n.state.selected = selected;
                n.state.focused = selected && cx.focused;
                n.state.expanded = *expanded;
                n.state.busy = matches!(note, Some(NoteState::Pending(_)));
                let kind = match kind {
                    FileKind::File => "",
                    FileKind::Directory => "; folder",
                    FileKind::Symlink => "; symlink",
                };
                let note = note
                    .as_ref()
                    .map(|s| format!("; {}", s.label()))
                    .unwrap_or_default();
                n.state.description = Some(format!("{}{kind}{note}", place(*depth, *pos, *set)));
                n
            }
            Row::Status { text, depth } => {
                let id = format!("s:{}:{y}", last_entry.as_deref().unwrap_or(""));
                let mut n = Node::new(&id, Role::Status, text, rect);
                n.state.description = Some(format!("level {}", depth + 1));
                n
            }
            Row::Confirm { text, .. } => Node::new("confirm", Role::Alert, text, rect),
            Row::Edit { rename, .. } => {
                let name = if *rename { "Rename" } else { "New name" };
                let mut n = Node::new("edit", Role::TextBox, name, rect);
                n.state.focused = cx.focused;
                if let Mode::Edit(edit) = &p.mode {
                    n.state.description = edit.error.clone();
                }
                n
            }
        };
        items.push(node);
    }
    tree.children = items.iter().map(|n| NodeId::new(n.id.as_str())).collect();
    let mut out = vec![tree];
    out.extend(items);
    out
}
