//! Draw an [`EditSession`] into a ratatui `Buffer`.
//!
//! The renderer wraps by display cells, scrolls so the caret stays visible,
//! and reports the caret in buffer cells. The host draws its hollow block
//! caret there and moves its hidden `<textarea>` to the same cell; the caret
//! is never part of the text. Selection, preedit, atomic ranges and held
//! conflict text are styled with the styles the caller supplies.

use crate::coords::{Coords, grapheme_cells};
use crate::layout::{Row, line_rows, row_index};
use crate::session::EditSession;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};

#[derive(Clone, Debug)]
pub struct EditorStyles {
    pub base: Style,
    pub selection: Style,
    pub preedit: Style,
    pub atomic: Style,
    pub conflict: Style,
    pub line_number: Style,
}

impl Default for EditorStyles {
    fn default() -> Self {
        Self {
            base: Style::default(),
            selection: Style::default().add_modifier(Modifier::REVERSED),
            preedit: Style::default().add_modifier(Modifier::UNDERLINED),
            atomic: Style::default().add_modifier(Modifier::BOLD),
            conflict: Style::default().add_modifier(Modifier::UNDERLINED | Modifier::ITALIC),
            line_number: Style::default().add_modifier(Modifier::DIM),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct RenderOptions {
    pub styles: EditorStyles,
    pub line_numbers: bool,
}

/// The caret as a cell in the buffer, and how many cells wide the character under it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caret {
    pub x: u16,
    pub y: u16,
    pub width: u16,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rendered {
    pub caret: Option<Caret>,
    /// Width of the line number gutter in cells (0 without line numbers).
    pub gutter: u16,
}

/// Draw `session` into `area` of `buf`. Updates the session's viewport size
/// and scroll so the caret is visible.
pub fn render(
    session: &mut EditSession,
    area: Rect,
    buf: &mut Buffer,
    options: &RenderOptions,
) -> Rendered {
    if area.width == 0 || area.height == 0 {
        return Rendered::default();
    }
    let display = session.display();
    let rope = &display.rope;
    let coords = Coords::new(rope);
    let digits = coords.line_count().to_string().len() as u16;
    let gutter = if options.line_numbers && area.width > digits + 1 {
        digits + 1
    } else {
        0
    };
    let content = Rect {
        x: area.x + gutter,
        y: area.y,
        width: area.width - gutter,
        height: area.height,
    };
    session.set_viewport(content.width as usize, content.height as usize);
    let (height, tab) = (content.height as usize, session.config().tab_width);
    let wrap = session.wrap_width();
    let styles = &options.styles;
    buf.set_style(area, styles.base);

    // Where the caret sits.
    let caret_line = coords.line_of(display.caret);
    let caret_rows = line_rows(rope, caret_line, wrap, tab);
    let caret_idx = row_index(&caret_rows, display.caret);
    let caret_row = caret_rows[caret_idx];
    let caret_cell = coords.cells_between(caret_row.start, display.caret, tab);
    let caret_width = if display.caret < caret_row.end {
        let next = coords.next_grapheme(display.caret).min(caret_row.end);
        let mut w = 1;
        coords.for_each_cluster(display.caret, next, |_, g| {
            w = grapheme_cells(g, caret_cell, tab).max(1);
            false
        });
        w
    } else {
        1
    };

    // Scroll so the caret row is on screen.
    let mut scroll = session.scroll();
    scroll.top_line = scroll.top_line.min(coords.line_count() - 1);
    let top_rows = line_rows(rope, scroll.top_line, wrap, tab).len();
    scroll.top_row = scroll.top_row.min(top_rows - 1);
    if (caret_line, caret_idx) < (scroll.top_line, scroll.top_row) {
        (scroll.top_line, scroll.top_row) = (caret_line, caret_idx);
    } else if rows_between(
        rope,
        (scroll.top_line, scroll.top_row),
        (caret_line, caret_idx),
        wrap,
        tab,
        height,
    ) >= height
    {
        (scroll.top_line, scroll.top_row) =
            rows_back(rope, (caret_line, caret_idx), height - 1, wrap, tab);
    }
    scroll.left_cell = if wrap > 0 {
        0
    } else if caret_cell < scroll.left_cell {
        caret_cell
    } else if caret_cell + caret_width > scroll.left_cell + content.width as usize {
        caret_cell + caret_width - content.width as usize
    } else {
        scroll.left_cell
    };
    session.set_scroll(scroll);

    // What to style.
    let selection = if session.is_composing() {
        None
    } else {
        session.selection()
    };
    let atomics: Vec<(usize, usize)> = session
        .atomics()
        .iter()
        .map(|a| (display.map(a.start), display.map(a.end)))
        .collect();
    let conflicts: Vec<(usize, usize)> = session
        .conflict()
        .map(|c| {
            c.ranges
                .iter()
                .map(|&(s, e)| (display.map(s), display.map(e)))
                .collect()
        })
        .unwrap_or_default();
    let within =
        |ranges: &[(usize, usize)], at: usize| ranges.iter().any(|&(s, e)| at >= s && at < e);

    // Draw the rows from the top.
    let mut y = 0usize;
    let mut caret = None;
    let mut line = scroll.top_line;
    let mut skip = scroll.top_row;
    'lines: while line < coords.line_count() && y < height {
        let rows: Vec<Row> = line_rows(rope, line, wrap, tab);
        for row in rows.into_iter().skip(skip) {
            if y >= height {
                break 'lines;
            }
            let py = content.y + y as u16;
            if gutter > 0 && row.index == 0 {
                let label = format!("{:>w$} ", line + 1, w = (gutter - 1) as usize);
                buf.set_string(area.x, py, label, styles.line_number);
            }
            let mut cell = 0usize;
            coords.for_each_cluster(row.start, row.end, |at, g| {
                let w = grapheme_cells(g, cell, tab);
                let left = scroll.left_cell;
                let fits = cell >= left && cell + w <= left + content.width as usize;
                if cell >= left + content.width as usize {
                    return false;
                }
                if fits && w > 0 {
                    let mut style = styles.base;
                    if within(&atomics, at) {
                        style = style.patch(styles.atomic);
                    }
                    if within(&conflicts, at) {
                        style = style.patch(styles.conflict);
                    }
                    if display.preedit.is_some_and(|(s, e)| at >= s && at < e) {
                        style = style.patch(styles.preedit);
                    }
                    if selection.is_some_and(|(s, e)| at >= s && at < e) {
                        style = style.patch(styles.selection);
                    }
                    let px = content.x + (cell - left) as u16;
                    if g.starts_with('\t') {
                        buf.set_stringn(px, py, " ".repeat(w), w, style);
                    } else {
                        buf.set_stringn(px, py, g, w, style);
                    }
                }
                cell += w;
                true
            });
            // A selection that runs over the line break shows one selected cell after the text.
            if row.last
                && row.end < rope.len_chars()
                && selection.is_some_and(|(s, e)| s <= row.end && e > row.end)
                && cell >= scroll.left_cell
                && cell < scroll.left_cell + content.width as usize
            {
                let px = content.x + (cell - scroll.left_cell) as u16;
                buf.set_stringn(px, py, " ", 1, styles.base.patch(styles.selection));
            }
            if row.line == caret_line && row.index == caret_idx {
                let x = caret_cell.saturating_sub(scroll.left_cell);
                if x < content.width as usize {
                    caret = Some(Caret {
                        x: content.x + x as u16,
                        y: py,
                        width: (caret_width as u16).min(content.width - x as u16),
                    });
                }
            }
            y += 1;
        }
        skip = 0;
        line += 1;
    }
    Rendered { caret, gutter }
}

/// Number of rows from `from` up to (not including) `to`, counting no further than `limit`.
fn rows_between(
    rope: &ropey::Rope,
    from: (usize, usize),
    to: (usize, usize),
    wrap: usize,
    tab: usize,
    limit: usize,
) -> usize {
    let mut n = 0usize;
    for line in from.0..=to.0 {
        let count = line_rows(rope, line, wrap, tab).len();
        let first = if line == from.0 { from.1 } else { 0 };
        let last = if line == to.0 { to.1 } else { count };
        n += last.saturating_sub(first);
        if n >= limit {
            return n;
        }
    }
    n
}

/// The (line, row) that is `count` rows above `at`, or the start of the text.
fn rows_back(
    rope: &ropey::Rope,
    at: (usize, usize),
    count: usize,
    wrap: usize,
    tab: usize,
) -> (usize, usize) {
    if at.1 >= count {
        return (at.0, at.1 - count);
    }
    let mut need = count - at.1;
    let mut line = at.0;
    while line > 0 {
        line -= 1;
        let rows = line_rows(rope, line, wrap, tab).len();
        if rows >= need {
            return (line, rows - need);
        }
        need -= rows;
    }
    (0, 0)
}
