//! Soft wrap by display cells.
//!
//! A line is cut into rows no wider than `width` cells. A row ends after the
//! last whitespace cluster that fits; when a word is wider than the row it is
//! cut between clusters. A wide cluster is never split, and a row always takes
//! at least one cluster so a narrow viewport still makes progress. Width 0
//! turns wrapping off: every line is one row.

use crate::coords::{Coords, grapheme_cells};
use ropey::Rope;
use unicode_segmentation::UnicodeSegmentation;

/// One visual row of a line. Offsets are scalars in the whole text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Row {
    pub line: usize,
    /// Index of this row within its line.
    pub index: usize,
    pub start: usize,
    /// End of the row's content (exclusive). For the last row of a line this
    /// is the end of the line's content, before its terminator.
    pub end: usize,
    pub last: bool,
}

/// The rows of one line. A line has at least one row, even when empty.
pub fn line_rows(rope: &Rope, line: usize, width: usize, tab_width: usize) -> Vec<Row> {
    let coords = Coords::new(rope);
    let Some((start, end)) = coords.line_range(line) else {
        return Vec::new();
    };
    let mut cuts: Vec<usize> = Vec::new();
    if width > 0 && start < end {
        let text = rope.slice(start..end).to_string();
        let mut at = start;
        let clusters: Vec<(usize, &str, bool)> = text
            .graphemes(true)
            .map(|g| {
                let c = (at, g, g.chars().all(char::is_whitespace));
                at += g.chars().count();
                c
            })
            .collect();
        let mut i = 0usize;
        let mut row_start = 0usize;
        let mut cells = 0usize;
        let mut last_break: Option<usize> = None;
        while i < clusters.len() {
            let w = grapheme_cells(clusters[i].1, cells, tab_width);
            if cells + w > width && i > row_start {
                let cut = match last_break.filter(|b| *b > row_start) {
                    Some(b) => b,
                    None => i,
                };
                cuts.push(clusters[cut].0);
                row_start = cut;
                i = cut;
                cells = 0;
                last_break = None;
                continue;
            }
            cells += w;
            if clusters[i].2 {
                last_break = Some(i + 1);
            }
            i += 1;
        }
    }
    let mut rows = Vec::with_capacity(cuts.len() + 1);
    let mut s = start;
    for (index, cut) in cuts.iter().enumerate() {
        rows.push(Row {
            line,
            index,
            start: s,
            end: *cut,
            last: false,
        });
        s = *cut;
    }
    rows.push(Row {
        line,
        index: cuts.len(),
        start: s,
        end,
        last: true,
    });
    rows
}

/// Index of the row holding `offset`. An offset at the end of a row that is
/// not the last of its line belongs to the next row, which is where the caret
/// is drawn.
pub fn row_index(rows: &[Row], offset: usize) -> usize {
    rows.iter()
        .position(|r| offset < r.end || (r.last && offset <= r.end))
        .unwrap_or(rows.len().saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(text: &str, width: usize) -> Vec<(usize, usize)> {
        let rope = Rope::from_str(text);
        line_rows(&rope, 0, width, 4)
            .iter()
            .map(|r| (r.start, r.end))
            .collect()
    }

    #[test]
    fn no_wrap_when_width_is_zero_or_the_line_fits() {
        assert_eq!(rows("hello world", 0), vec![(0, 11)]);
        assert_eq!(rows("hello", 5), vec![(0, 5)]);
        assert_eq!(rows("", 5), vec![(0, 0)]);
    }

    #[test]
    fn wraps_after_whitespace_and_cuts_long_words() {
        assert_eq!(rows("hello world", 7), vec![(0, 6), (6, 11)]);
        assert_eq!(rows("abcdefghij", 4), vec![(0, 4), (4, 8), (8, 10)]);
    }

    #[test]
    fn never_splits_a_wide_or_combined_cluster() {
        // Each CJK char is 2 cells; width 3 fits one per row.
        assert_eq!(
            rows("\u{4e2d}\u{6587}\u{5b57}", 3),
            vec![(0, 1), (1, 2), (2, 3)]
        );
        // e + combining acute is one cluster of two scalars and one cell.
        assert_eq!(rows("e\u{301}e\u{301}e\u{301}", 2), vec![(0, 4), (4, 6)]);
        // A cluster wider than the row still takes a row of its own.
        assert_eq!(rows("\u{4e2d}", 1), vec![(0, 1)]);
    }

    #[test]
    fn row_index_puts_a_row_end_on_the_next_row() {
        let rope = Rope::from_str("hello world");
        let r = line_rows(&rope, 0, 7, 4);
        assert_eq!(row_index(&r, 5), 0);
        assert_eq!(row_index(&r, 6), 1);
        assert_eq!(row_index(&r, 11), 1);
    }
}
