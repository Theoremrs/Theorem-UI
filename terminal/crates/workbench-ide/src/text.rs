//! Text as cells: what a line of file text, a message or a path looks like in a row of the
//! terminal, with a highlight placed from the host's UTF-16 ranges.
//!
//! A row is cut into graphemes (so a ZWJ emoji or a base with its combining marks is one
//! unit), each with the cells it takes (`unicode-width`, as Ratatui's own buffer counts
//! them). A tab goes to the next stop of four, and a control character shows as `?`. The
//! highlight is by grapheme: a range that starts or ends inside one marks the whole of it,
//! so the cells marked are the cells of the characters the host matched.

use ratatui::buffer::Buffer;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use theorem_workbench_core::results::SpanEncoding;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Columns a tab advances to.
pub(crate) const TAB: usize = 4;

pub(crate) fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// The longest start of `text` that fits `max` cells.
pub(crate) fn clip(text: &str, max: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > max {
            return &text[..at];
        }
        used += w;
    }
    text
}

/// The longest end of `text` that fits `max` cells.
fn clip_end(text: &str, max: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices().rev() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > max {
            return &text[at + c.len_utf8()..];
        }
        used += w;
    }
    text
}

/// `text` in `max` cells, cut at the end with an ellipsis.
pub(crate) fn fit(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    if max == 0 {
        return String::new();
    }
    format!("{}\u{2026}", clip(text, max - 1))
}

/// `text` broken at word ends into at most `rows` lines of `width` cells. What does not fit
/// ends the last line with an ellipsis, so a long refusal shows its start and says it goes
/// on, rather than losing its end silently.
pub(crate) fn wrap(text: &str, width: usize, rows: usize) -> Vec<String> {
    if width == 0 || rows == 0 {
        return vec![];
    }
    let mut lines: Vec<String> = textwrap::wrap(text, width)
        .into_iter()
        .map(std::borrow::Cow::into_owned)
        .collect();
    if lines.len() > rows {
        lines.truncate(rows);
        let last = lines.pop().unwrap_or_default();
        lines.push(fit(&format!("{last}\u{2026}"), width));
    }
    lines
}

/// `text` in `max` cells with the middle replaced by an ellipsis, so a path shows both its
/// start and its file name.
pub(crate) fn elide_middle(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    match max {
        0 => String::new(),
        1 => "\u{2026}".to_owned(),
        _ => {
            let keep = max - 1;
            let head = keep.div_ceil(2);
            let tail = keep - head;
            format!("{}\u{2026}{}", clip(text, head), clip_end(text, tail))
        }
    }
}

/// Draws `text` at `(x, y)` within `max` cells and returns the cells used.
pub(crate) fn put(buf: &mut Buffer, x: u16, y: u16, max: usize, text: &str, style: Style) -> u16 {
    if max == 0 {
        return 0;
    }
    let (end, _) = buf.set_stringn(x, y, text, max, style);
    end - x
}

/// One grapheme of a row and the cells it takes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cell {
    pub symbol: String,
    pub width: u16,
    /// The host matched this character.
    pub hit: bool,
}

/// `text` as cells. `ranges` are `[start, end)` in UTF-16 code units of `text`, as the host
/// counts a match; an empty range marks nothing.
pub(crate) fn cells(text: &str, ranges: &[(u32, u32)]) -> Vec<Cell> {
    let mut out: Vec<Cell> = Vec::new();
    let mut column = 0usize;
    let mut unit = 0u32;
    for grapheme in text.graphemes(true) {
        let end = unit + grapheme.encode_utf16().count() as u32;
        let hit = ranges.iter().any(|&(s, e)| s < e && s < end && e > unit);
        unit = end;
        if grapheme == "\t" {
            let stop = (column / TAB + 1) * TAB;
            for _ in column..stop {
                out.push(Cell {
                    symbol: " ".to_owned(),
                    width: 1,
                    hit,
                });
            }
            column = stop;
            continue;
        }
        let first = grapheme.chars().next().unwrap_or(' ');
        let w = width(grapheme);
        let (symbol, w) = if first.is_control() || w == 0 {
            ("?".to_owned(), 1)
        } else {
            (grapheme.to_owned(), w as u16)
        };
        column += w as usize;
        out.push(Cell {
            symbol,
            width: w,
            hit,
        });
    }
    out
}

/// A `[start, end)` range counted in `encoding` over `text`, as UTF-16 code units. A bound
/// that falls inside a character moves out to that character's edge, so the range always
/// covers whole characters; past the end it stops at the end.
pub(crate) fn to_utf16(text: &str, (start, end): (u32, u32), encoding: SpanEncoding) -> (u32, u32) {
    let mut from: Option<u32> = None;
    let mut to: Option<u32> = None;
    let (mut bytes, mut scalars, mut units) = (0u32, 0u32, 0u32);
    for c in text.chars() {
        let (here, step) = match encoding {
            SpanEncoding::Utf8Bytes => (bytes, c.len_utf8() as u32),
            SpanEncoding::UnicodeScalars => (scalars, 1),
            SpanEncoding::Utf16CodeUnits => (units, c.len_utf16() as u32),
        };
        if from.is_none() && here + step > start {
            from = Some(units);
        }
        if to.is_none() && here >= end {
            to = Some(units);
        }
        bytes += c.len_utf8() as u32;
        scalars += 1;
        units += c.len_utf16() as u32;
    }
    (from.unwrap_or(units), to.unwrap_or(units))
}

/// The column the first marked cell starts at.
pub(crate) fn first_hit(cells: &[Cell]) -> Option<usize> {
    let mut column = 0usize;
    for cell in cells {
        if cell.hit {
            return Some(column);
        }
        column += cell.width as usize;
    }
    None
}

/// The cells from column `from` for at most `max` columns, as one line: marked cells wear
/// `hit` over `base`. A wide cell cut by `from` shows as a space, and one that would pass
/// the end is left out.
pub(crate) fn line(
    cells: &[Cell],
    from: usize,
    max: usize,
    base: Style,
    hit: Style,
) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut run = String::new();
    let mut run_hit = false;
    let flush = |run: &mut String, run_hit: bool, spans: &mut Vec<Span<'static>>| {
        if !run.is_empty() {
            let style = if run_hit { base.patch(hit) } else { base };
            spans.push(Span::styled(std::mem::take(run), style));
        }
    };
    let mut column = 0usize;
    let mut used = 0usize;
    for cell in cells {
        let w = cell.width as usize;
        let start = column;
        column += w;
        if column <= from {
            continue;
        }
        let (symbol, w) = if start < from {
            (" ", column - from)
        } else {
            (cell.symbol.as_str(), w)
        };
        if used + w > max {
            break;
        }
        if cell.hit != run_hit {
            flush(&mut run, run_hit, &mut spans);
            run_hit = cell.hit;
        }
        if symbol == " " && w > 1 {
            run.push_str(&" ".repeat(w));
        } else {
            run.push_str(symbol);
        }
        used += w;
    }
    flush(&mut run, run_hit, &mut spans);
    Line::from(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_goes_to_the_next_stop_and_a_match_over_it_marks_its_cells() {
        let c = cells("a\tb", &[(1, 2)]);
        let symbols: String = c.iter().map(|c| c.symbol.as_str()).collect();
        assert_eq!(symbols, "a   b");
        assert_eq!(
            c.iter().map(|c| c.hit).collect::<Vec<_>>(),
            [false, true, true, true, false]
        );
    }

    #[test]
    fn a_match_inside_a_zwj_emoji_marks_the_whole_emoji() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let c = cells(&format!("x{family}y"), &[(3, 4)]);
        assert_eq!(c.len(), 3);
        assert!(c[1].hit && !c[0].hit && !c[2].hit);
        assert_eq!(c[1].width, 2);
    }
}
