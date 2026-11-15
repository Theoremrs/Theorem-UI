//! Cells and semantic nodes for the Files panel, from the same rows.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use theorem_workbench_core::completion::FileKind;
use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::semantics::{Node, NodeId, Role};
use theorem_workbench_core::{Theme, ViewCtx};

use super::tree::{NoteState, Row, Tone};
use super::{Edit, FilesPanel, Mode};
use crate::caret::caret_text;
use theorem_workbench_text::field::FieldStyles;
use theorem_workbench_text::visible::visible;

/// Write `text` from `x`, stopping at `limit`; returns the next free column.
///
/// Names come from the host and may hold escapes or overrides: they are spelled
/// out, so a row shows what the name is and not a cleaned-up lookalike.
fn put(buf: &mut Buffer, x: u16, y: u16, limit: u16, text: &str, style: Style) -> u16 {
    put_raw(buf, x, y, limit, &visible(text), style)
}

/// As `put`, for text the person is editing: its cells are the text's own.
fn put_raw(buf: &mut Buffer, x: u16, y: u16, limit: u16, text: &str, style: Style) -> u16 {
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

/// `base` in the theme role a tone names.
fn toned(theme: &Theme, base: Style, tone: Tone) -> Style {
    base.patch(match tone {
        Tone::Plain => theme.muted,
        Tone::Warning => theme.warning,
        Tone::Error => theme.error,
    })
}

pub(super) fn view(p: &FilesPanel, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
    let theme = cx.theme;
    buf.set_style(area, theme.bg);
    let right = area.x + area.width;
    let mut y = area.y;
    if let Some(text) = p.banner() {
        put(buf, area.x, y, right, text, theme.text.patch(theme.warning));
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
                muted,
                ..
            } => {
                // The cursor row keeps its own colors: it must stay legible.
                let line = if *muted && !here {
                    line.patch(theme.muted)
                } else {
                    line
                };
                x = put(buf, x, y, right, mark(row), line);
                let shown = match kind {
                    FileKind::Directory => format!("{name}/"),
                    FileKind::Symlink => format!("{name}@"),
                    FileKind::File => name.clone(),
                };
                x = put(buf, x, y, right, &shown, line);
                // Role colors are chosen against the pane and fall under 4.5:1 on the
                // focus fill. There the mark beside the name takes the row's own ink, and
                // a note, which says what happened in its role color, stands on the pane's
                // background.
                let filled = here && cx.focused;
                if let Some(clip) = clip {
                    let style = if filled {
                        line
                    } else {
                        line.patch(theme.muted)
                    };
                    x = put(buf, x, y, right, &format!(" ({clip})"), style);
                }
                if let Some(note) = note {
                    let base = match (filled, line.bg) {
                        (true, Some(_)) => Style {
                            bg: Some(theme.bg.bg.unwrap_or(Color::Reset)),
                            ..theme.text
                        },
                        _ => line,
                    };
                    let tone = match note {
                        NoteState::Pending(_) => Tone::Plain,
                        NoteState::Problem(p) => p.tone(),
                    };
                    let style = toned(theme, base, tone);
                    put(buf, x, y, right, &format!("  {}", note.label()), style);
                }
            }
            Row::Status { text, tone, .. } => {
                put(
                    buf,
                    x,
                    y,
                    right,
                    &format!("  {text}"),
                    toned(theme, line, *tone),
                );
            }
            Row::Confirm { text, .. } => {
                put(
                    buf,
                    x,
                    y,
                    right,
                    &format!("  {text}"),
                    line.patch(theme.warning),
                );
            }
            Row::Edit { directory, .. } => {
                if let Mode::Edit(Edit { input, error, .. }) = &p.mode {
                    let field = if *directory { "> " } else { "  " };
                    x = put(buf, x, y, right, field, line);
                    let width = usize::from(right.saturating_sub(x));
                    let styles = FieldStyles {
                        text: theme.focus,
                        selection: theme.selection,
                        caret: Style::new().add_modifier(Modifier::REVERSED),
                        hint: theme.muted,
                    };
                    let end = input.draw(
                        buf,
                        Rect::new(x, y, right.saturating_sub(x), 1),
                        &styles,
                        true,
                        "",
                    );
                    let scroll = input.scroll(width);
                    let caret = x + input.cursor_cells().saturating_sub(scroll) as u16;
                    if let Some(error) = error {
                        put(
                            buf,
                            end.max(caret + 1),
                            y,
                            right,
                            &format!("  {error}"),
                            line.patch(theme.error),
                        );
                    }
                }
            }
        }
        y += 1;
    }
}

/// Levels count from 1.
fn level(depth: usize) -> u16 {
    u16::try_from(depth + 1).unwrap_or(u16::MAX)
}

fn count(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

pub(super) fn semantics(p: &FilesPanel, area: Rect, cx: &ViewCtx) -> Vec<Node> {
    let rows = p.rows();
    let cursor = p.cursor_path(&rows);
    let first = p.scroll.min(rows.len().saturating_sub(1));
    let window = usize::from(area.height).saturating_sub(p.header());
    let mut tree = Node::new("tree", Role::Tree, "Files", area);
    tree.binding = ResourceRef::Workspace {
        workspace: p.identity.workspace.clone(),
    };
    tree.state.description = p.banner().map(visible);
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
                // A node has no field for the kind of file, so a link says so
                // in its name; a folder is told by `expanded`.
                let label = match kind {
                    FileKind::Symlink => format!("{} (symlink)", visible(name)),
                    FileKind::File | FileKind::Directory => visible(name),
                };
                let mut n = Node::new(&format!("f:{path}"), Role::TreeItem, &label, rect);
                n.level = Some(level(*depth));
                n.pos_in_set = Some(count(*pos));
                n.set_size = Some(count(*set));
                n.state.selected = selected;
                n.state.focused = selected && cx.focused;
                n.state.expanded = *expanded;
                n.state.busy = matches!(note, Some(NoteState::Pending(_)));
                // Only what a person can act on: why a write was refused.
                n.state.description = note.as_ref().map(|n| visible(&n.label()));
                n
            }
            Row::Status { text, depth, .. } => {
                let id = format!("s:{}:{y}", last_entry.as_deref().unwrap_or(""));
                let mut n = Node::new(&id, Role::Status, &visible(text), rect);
                n.level = Some(level(*depth));
                n
            }
            Row::Confirm { text, .. } => Node::new("confirm", Role::Alert, &visible(text), rect),
            Row::Edit { rename, .. } => {
                let name = if *rename { "Rename" } else { "New name" };
                let mut n = Node::new("edit", Role::TextBox, name, rect);
                n.state.focused = cx.focused;
                if let Mode::Edit(edit) = &p.mode {
                    n.state.description = edit.error.as_deref().map(visible);
                    let (anchor, at) = (edit.input.anchor(), edit.input.cursor());
                    caret_text(edit.input.value(), anchor, at).put(&mut n);
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
