//! Where everything in the tool picker is, as one pure function of what the
//! picker holds and the cells it has. The drawing, the pointer's hit test, the
//! keyboard's Left and Right and the semantic tree all read this one answer, so
//! what is drawn, what a click means and what an assistive reader is told
//! cannot drift apart.
//!
//! Rows run down a column and the second column continues where the first ends
//! (column-major), so "next" is always the row drawn below, and the last row of
//! the first column is followed by the top of the second.

use ratatui::layout::Rect;
use ratatui::text::Span;

use crate::panel::PickerView;
use crate::registry::PickerRow;

/// Cells between the two columns.
pub const GAP: u16 = 2;
/// The least width a row may have and still be a target a pointer can hit.
pub const MIN_HIT: u16 = 12;
/// Cells before the label and after the last thing on the row.
pub const PAD: u16 = 1;
/// A pin control: a separating cell and the glyph.
pub const PIN_W: u16 = 2;
/// Between a label and its qualifier, and before a hint.
pub const SEP: u16 = 2;

pub const HEADING_MAIN: &str = "Tools";
pub const HEADING_MORE: &str = "More tools";
pub const BACK: &str = "\u{2039} Back";
pub const NO_MATCH: &str = "No tools match";
pub const PINNED: &str = "\u{25cf}";
pub const UNPINNED: &str = "\u{25cb}";

/// The cell width of `text`.
pub fn text_width(text: &str) -> u16 {
    u16::try_from(Span::raw(text).width()).unwrap_or(u16::MAX)
}

/// `text` cut to at most `width` cells, ending in an ellipsis when it was cut.
pub fn fit(text: &str, width: u16) -> String {
    if text_width(text) <= width {
        return text.to_owned();
    }
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    for c in text.chars() {
        let mut next = out.clone();
        next.push(c);
        if text_width(&next) + 1 > width {
            break;
        }
        out = next;
    }
    out.push('\u{2026}');
    out
}

/// The cells a row needs to show its label, qualifier, hint and pin control
/// whole, but never fewer than [`MIN_HIT`].
pub fn required_width(row: &PickerRow) -> u16 {
    let mut w = PAD + text_width(&row.title) + PAD;
    if let Some(q) = row.chooses.qualifier() {
        w = w.saturating_add(SEP + text_width(&q));
    }
    if let Some(h) = &row.shortcut {
        w = w.saturating_add(SEP + text_width(h));
    }
    if row.pinnable {
        w = w.saturating_add(PIN_W);
    }
    w.max(MIN_HIT)
}

/// How many columns `rows` take in `width` cells: two only when every row fits
/// in half the width (less the gap), else one.
pub fn fit_columns(rows: &[PickerRow], width: u16) -> u8 {
    let half = width.saturating_sub(GAP) / 2;
    if rows.len() >= 2 && rows.iter().all(|r| required_width(r) <= half) {
        2
    } else {
        1
    }
}

/// One row's place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    /// Index into the view's rows.
    pub index: usize,
    pub rect: Rect,
    /// The pin control, on a pinnable row that has room for it.
    pub pin: Option<Rect>,
}

/// What a cell of the picker is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerHit {
    Back,
    Row(usize),
    Pin(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub columns: u8,
    /// Rows in each column but the last (the first column's length).
    pub per_column: usize,
    pub heading: Rect,
    pub back: Option<Rect>,
    pub filter: Rect,
    /// "No tools match", when the filter leaves nothing.
    pub empty: Option<Rect>,
    /// The line for the reason a chosen row is unavailable.
    pub reason: Option<Rect>,
    /// The rows showing, by index. Rows scrolled out have no cell.
    pub cells: Vec<Cell>,
}

fn line(area: Rect, y: u16) -> Rect {
    if y < area.bottom() {
        Rect::new(area.x, y, area.width, 1)
    } else {
        Rect::new(area.x, area.bottom(), area.width, 0)
    }
}

impl Layout {
    pub fn compute(view: &PickerView, area: Rect) -> Self {
        let n = view.rows.len();
        let columns = fit_columns(&view.rows, area.width);
        let per_column = n.div_ceil(usize::from(columns)).max(1);

        let mut y = area.y;
        let heading = line(area, y);
        y = y.saturating_add(1);
        let back = view.more.then(|| {
            let r = line(area, y);
            y = y.saturating_add(1);
            r
        });
        let filter = line(area, y);
        y = y.saturating_add(1);
        let top = y;

        let room = usize::from(area.bottom().saturating_sub(top));
        let reason_rows = usize::from(view.reason.is_some());
        let visible = room.saturating_sub(reason_rows).max(usize::from(room > 0));
        let selected_line = view.selected.min(n.saturating_sub(1)) % per_column;
        let offset = (selected_line + 1).saturating_sub(visible);

        let col_width = if columns == 2 {
            area.width.saturating_sub(GAP) / 2
        } else {
            area.width
        };
        let mut cells = vec![];
        for index in 0..n {
            let (col, row_line) = (index / per_column, index % per_column);
            if row_line < offset || row_line - offset >= visible {
                continue;
            }
            let Ok(dy) = u16::try_from(row_line - offset) else {
                continue;
            };
            let x = area.x + (col_width + GAP) * u16::try_from(col).unwrap_or(0);
            let rect = Rect::new(x, top.saturating_add(dy), col_width, 1);
            if rect.is_empty() || rect.bottom() > area.bottom() {
                continue;
            }
            let row = &view.rows[index];
            let pin = (row.pinnable && col_width > PIN_W)
                .then(|| Rect::new(rect.right() - 1, rect.y, 1, 1));
            cells.push(Cell { index, rect, pin });
        }
        let shown = per_column.saturating_sub(offset).min(visible);
        let below = top.saturating_add(u16::try_from(shown).unwrap_or(u16::MAX));
        let empty = (n == 0).then(|| line(area, top));
        let reason = view.reason.as_ref().map(|_| {
            let y = if n == 0 { top.saturating_add(1) } else { below };
            line(area, y)
        });
        Self {
            columns,
            per_column,
            heading,
            back,
            filter,
            empty,
            reason,
            cells,
        }
    }

    /// What is at the cell `(x, y)`, if anything.
    pub fn hit(&self, x: u16, y: u16) -> Option<PickerHit> {
        let at = |r: &Rect| r.contains((x, y).into());
        if self.back.as_ref().is_some_and(at) {
            return Some(PickerHit::Back);
        }
        self.cells.iter().find_map(|c| {
            if c.pin.as_ref().is_some_and(at) {
                Some(PickerHit::Pin(c.index))
            } else if at(&c.rect) {
                Some(PickerHit::Row(c.index))
            } else {
                None
            }
        })
    }

    pub fn cell(&self, index: usize) -> Option<&Cell> {
        self.cells.iter().find(|c| c.index == index)
    }
}

/// What a row says, cut to its cell. Pure, so the view and the tests agree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowText {
    pub label: String,
    pub qualifier: Option<String>,
    pub hint: Option<String>,
    /// Offsets from the cell's left edge.
    pub label_at: u16,
    pub qualifier_at: u16,
    pub hint_at: u16,
}

pub fn row_text(row: &PickerRow, width: u16, pin: bool) -> RowText {
    let right = if pin { PIN_W } else { 0 };
    let usable = width.saturating_sub(PAD * 2 + right);
    let label = fit(&row.title, usable);
    let label_w = text_width(&label);
    let mut used = label_w;
    let hint = row.shortcut.as_ref().filter(|h| {
        let need = used + SEP + text_width(h);
        need <= usable
    });
    if let Some(h) = hint {
        used += SEP + text_width(h);
    }
    let qualifier = row.chooses.qualifier().filter(|q| {
        // The qualifier gives way before the hint does.
        used + SEP + text_width(q) <= usable
    });
    let hint_w = hint.map_or(0, |h| text_width(h));
    RowText {
        label_at: PAD,
        qualifier_at: PAD + label_w + SEP,
        hint_at: width.saturating_sub(PAD + right + hint_w),
        label,
        qualifier,
        hint: hint.cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{ActionId, PanelKind};
    use crate::registry::{Availability, Chooses};

    fn row(title: &str, hint: Option<&str>, chooses: Chooses, pinnable: bool) -> PickerRow {
        PickerRow {
            action: ActionId::new(format!("{title}.open")),
            panel: PanelKind::new("x"),
            title: title.to_owned(),
            intent: crate::registry::ActionIntent::Open,
            availability: Availability::Available,
            pinned: false,
            chooses,
            pinnable,
            shortcut: hint.map(str::to_owned),
        }
    }

    fn main_rows() -> Vec<PickerRow> {
        vec![
            row("Changes", Some("Ctrl+Alt+G"), Chooses::Opens, false),
            row(
                "Shell",
                Some("Ctrl+Alt+S"),
                Chooses::Starts {
                    what: "process".into(),
                },
                false,
            ),
            row("Files", Some("Ctrl+Alt+E"), Chooses::Focuses, false),
            row("Side chat", None, Chooses::Opens, false),
            row(
                "New page",
                Some("Ctrl+Alt+N"),
                Chooses::Creates {
                    what: "document".into(),
                },
                false,
            ),
            row("More tools", None, Chooses::Opens, false),
        ]
    }

    fn view(rows: Vec<PickerRow>, more: bool) -> PickerView {
        PickerView {
            rows,
            selected: 0,
            filter: String::new(),
            more,
            reason: None,
        }
    }

    #[test]
    fn the_fit_rule_chooses_columns_by_width() {
        let rows = main_rows();
        // "Shell  starts a process  Ctrl+Alt+S" plus padding, and the widest:
        // "New page  creates a document  Ctrl+Alt+N".
        assert_eq!(required_width(&rows[1]), 1 + 5 + 2 + 16 + 2 + 10 + 1);
        assert_eq!(required_width(&rows[4]), 1 + 8 + 2 + 18 + 2 + 10 + 1);
        for (width, columns) in [
            (200, 2),
            (96, 2),
            // Each column is (75 - 2) / 2 = 36 wide; New page needs 42.
            (75, 1),
            (85, 1),
            (86, 2),
            (60, 1),
            (28, 1),
            (12, 1),
            (1, 1),
            (0, 1),
        ] {
            assert_eq!(fit_columns(&rows, width), columns, "width {width}");
        }
        // One row never makes two columns.
        assert_eq!(fit_columns(&rows[..1], 200), 1);
        // A row narrower than the hit target still counts as the hit target.
        let short = vec![row("A", None, Chooses::Opens, false); 2];
        assert_eq!(required_width(&short[0]), MIN_HIT);
        assert_eq!(fit_columns(&short, 2 * MIN_HIT + GAP), 2);
        assert_eq!(fit_columns(&short, 2 * MIN_HIT + GAP - 1), 1);
    }

    #[test]
    fn rows_run_down_the_columns_and_the_cells_hit_test_back_to_their_rows() {
        let v = view(main_rows(), false);
        let area = Rect::new(4, 2, 96, 14);
        let l = Layout::compute(&v, area);
        assert_eq!(l.columns, 2);
        assert_eq!(l.per_column, 3);
        assert_eq!(l.heading, Rect::new(4, 2, 96, 1));
        assert_eq!(l.filter, Rect::new(4, 3, 96, 1));
        let at = |i: usize| l.cell(i).unwrap().rect;
        assert_eq!(at(0), Rect::new(4, 4, 47, 1));
        assert_eq!(at(2), Rect::new(4, 6, 47, 1));
        assert_eq!(at(3), Rect::new(53, 4, 47, 1));
        assert_eq!(at(5), Rect::new(53, 6, 47, 1));
        for c in &l.cells {
            let (x, y) = (c.rect.x + 3, c.rect.y);
            assert_eq!(l.hit(x, y), Some(PickerHit::Row(c.index)));
        }
        // The gap between the columns and the lines above the rows are nothing.
        assert_eq!(l.hit(51, 4), None);
        assert_eq!(l.hit(10, 2), None);
        assert_eq!(l.hit(10, 3), None);
        assert_eq!(l.hit(10, 7), None);
    }

    #[test]
    fn one_column_when_the_rows_do_not_fit_in_half() {
        let v = view(main_rows(), false);
        let l = Layout::compute(&v, Rect::new(0, 0, 60, 14));
        assert_eq!(l.columns, 1);
        assert_eq!(l.per_column, 6);
        for (i, c) in l.cells.iter().enumerate() {
            assert_eq!(c.rect, Rect::new(0, 2 + i as u16, 60, 1));
        }
    }

    #[test]
    fn more_tools_has_a_back_row_above_the_filter_and_pins_have_a_cell() {
        let rows = vec![
            row("Artifacts", None, Chooses::Opens, true),
            row("Diagnostics", None, Chooses::Opens, true),
        ];
        let v = view(rows, true);
        let l = Layout::compute(&v, Rect::new(0, 0, 28, 14));
        assert_eq!(l.back, Some(Rect::new(0, 1, 28, 1)));
        assert_eq!(l.filter, Rect::new(0, 2, 28, 1));
        assert_eq!(l.hit(2, 1), Some(PickerHit::Back));
        let first = l.cell(0).unwrap();
        assert_eq!(first.rect, Rect::new(0, 3, 28, 1));
        assert_eq!(first.pin, Some(Rect::new(27, 3, 1, 1)));
        assert_eq!(l.hit(27, 3), Some(PickerHit::Pin(0)));
        assert_eq!(l.hit(26, 3), Some(PickerHit::Row(0)));
    }

    #[test]
    fn a_reason_sits_under_the_rows_and_an_empty_filter_says_so() {
        let mut v = view(main_rows(), false);
        v.reason = Some("This host does not report the \"x\" capability.".into());
        let l = Layout::compute(&v, Rect::new(0, 0, 60, 14));
        assert_eq!(l.reason, Some(Rect::new(0, 8, 60, 1)));

        let mut empty = view(vec![], false);
        empty.filter = "zzz".into();
        let l = Layout::compute(&empty, Rect::new(0, 0, 60, 14));
        assert_eq!(l.empty, Some(Rect::new(0, 2, 60, 1)));
        assert!(l.cells.is_empty());
    }

    #[test]
    fn a_short_area_scrolls_to_keep_the_selected_row_and_never_overruns() {
        let mut v = view(main_rows(), false);
        v.selected = 5;
        let l = Layout::compute(&v, Rect::new(0, 0, 40, 5));
        // Three lines for rows: the last three rows show.
        assert_eq!(
            l.cells.iter().map(|c| c.index).collect::<Vec<_>>(),
            [3, 4, 5]
        );
        for c in &l.cells {
            assert!(c.rect.bottom() <= 5);
        }
        for height in 0..4 {
            let l = Layout::compute(&v, Rect::new(0, 0, 40, height));
            assert!(l.cells.iter().all(|c| c.rect.bottom() <= height));
        }
        // Nothing panics or overruns at the narrowest widths.
        for width in 0..4 {
            let l = Layout::compute(&v, Rect::new(0, 0, width, 14));
            assert!(l.cells.iter().all(|c| c.rect.right() <= width));
        }
    }

    #[test]
    fn row_text_gives_way_to_the_label_in_a_narrow_cell() {
        let shell = &main_rows()[1];
        let wide = row_text(shell, 47, false);
        assert_eq!(wide.label, "Shell");
        assert_eq!(wide.qualifier.as_deref(), Some("starts a process"));
        assert_eq!(wide.hint.as_deref(), Some("Ctrl+Alt+S"));
        assert_eq!(wide.hint_at, 47 - 1 - 10);
        // The qualifier goes first, then the hint, then the label is cut.
        let narrow = row_text(shell, 20, false);
        assert_eq!(narrow.qualifier, None);
        assert_eq!(narrow.hint.as_deref(), Some("Ctrl+Alt+S"));
        let tiny = row_text(shell, 8, false);
        assert_eq!((tiny.qualifier, tiny.hint), (None, None));
        assert_eq!(tiny.label, "Shell");
        let cut = row_text(shell, 5, false);
        assert_eq!(cut.label, "Sh\u{2026}");
        assert_eq!(row_text(shell, 0, false).label, "");
    }
}
