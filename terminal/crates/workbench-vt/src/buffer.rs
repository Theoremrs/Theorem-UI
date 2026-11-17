//! Absolute positions, row snapshots, selection units, text extraction and
//! search. Pure data: no `vt100` here, so the algorithms test on their own.

/// A cell position in the whole buffer: row 0 is the oldest scrollback line,
/// the live screen follows the scrollback.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
    pub row: usize,
    pub col: u16,
}

/// An inclusive run of cells from `start` to `end`, possibly across rows.
/// Used for the selection and for search matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: Pos,
    pub end: Pos,
}

impl Span {
    /// The columns of this span that fall on `row`, if any.
    pub fn cols_on(&self, row: usize, width: u16) -> Option<(u16, u16)> {
        if row < self.start.row || row > self.end.row || width == 0 {
            return None;
        }
        let first = if row == self.start.row {
            self.start.col
        } else {
            0
        };
        let last = if row == self.end.row {
            self.end.col
        } else {
            width - 1
        };
        Some((first, last.min(width - 1)))
    }
}

/// What one selection step covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionKind {
    /// Single cells (a wide character counts as one unit).
    Cell,
    /// Whole words: runs of letters and digits, runs of blanks, or one run of
    /// the same punctuation.
    Word,
    /// Whole logical lines (wrapped rows count as one line).
    Line,
}

/// One character of a row and the cell it sits in. Combining marks have
/// width 0 and share the column of their base character.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Glyph {
    /// `'\0'` marks a cell that was never written.
    pub ch: char,
    pub col: u16,
    pub width: u8,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RowData {
    pub glyphs: Vec<Glyph>,
    pub wrapped: bool,
}

impl RowData {
    /// The glyph that covers cell `col` (either half of a wide character).
    pub fn glyph_at(&self, col: u16) -> Option<&Glyph> {
        let end = self.glyphs.partition_point(|g| g.col <= col);
        self.glyphs[..end]
            .iter()
            .rev()
            .find(|g| g.width > 0)
            .filter(|g| col < g.col + u16::from(g.width))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Word,
    Blank,
    Other(char),
}

fn class(ch: char) -> Class {
    if ch == '\0' || ch.is_whitespace() {
        Class::Blank
    } else if ch.is_alphanumeric() || ch == '_' {
        Class::Word
    } else {
        Class::Other(ch)
    }
}

/// The first and last column of the word around `col`.
pub(crate) fn word_unit(row: &RowData, col: u16) -> (u16, u16) {
    let Some(at) = row
        .glyphs
        .iter()
        .position(|g| g.width > 0 && col >= g.col && col < g.col + u16::from(g.width))
    else {
        return (col, col);
    };
    let base = |i: usize| row.glyphs[i].width > 0;
    let want = class(row.glyphs[at].ch);
    let mut lo = at;
    while lo > 0 {
        let mut prev = lo - 1;
        while prev > 0 && !base(prev) {
            prev -= 1;
        }
        if class(row.glyphs[prev].ch) != want {
            break;
        }
        lo = prev;
    }
    let mut hi = at;
    while hi + 1 < row.glyphs.len() {
        let mut next = hi + 1;
        while next < row.glyphs.len() && !base(next) {
            next += 1;
        }
        if next >= row.glyphs.len() || class(row.glyphs[next].ch) != want {
            break;
        }
        hi = next;
    }
    let last = &row.glyphs[hi];
    (row.glyphs[lo].col, last.col + u16::from(last.width) - 1)
}

/// The text of `span`. `rows[0]` is the span's first row. Wrapped rows join
/// without a newline, other rows end in one; cells never written at the end
/// of a row are dropped; the second half of a wide character adds nothing.
pub(crate) fn text_of(rows: &[RowData], span: Span) -> String {
    let mut out = String::new();
    for (i, row) in rows
        .iter()
        .take(span.end.row - span.start.row + 1)
        .enumerate()
    {
        let abs = span.start.row + i;
        let first = if abs == span.start.row {
            span.start.col
        } else {
            0
        };
        let last = if abs == span.end.row {
            span.end.col
        } else {
            u16::MAX
        };
        let mut line: Vec<char> = row
            .glyphs
            .iter()
            .filter(|g| g.col <= last && g.col + u16::from(g.width.max(1)) > first)
            .map(|g| g.ch)
            .collect();
        while line.last() == Some(&'\0') {
            line.pop();
        }
        out.extend(line.into_iter().map(|c| if c == '\0' { ' ' } else { c }));
        if abs < span.end.row && !row.wrapped {
            out.push('\n');
        }
    }
    out
}

fn fold(c: char, sensitive: bool) -> char {
    let c = if c == '\0' { ' ' } else { c };
    if sensitive {
        c
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

/// All non-overlapping matches of `query` in `rows` (the whole buffer, row 0
/// first). A query with an uppercase letter matches case-sensitively, any
/// other query ignores case. Wrapped rows are searched as one line.
pub(crate) fn find_matches(rows: &[RowData], query: &str) -> Vec<Span> {
    let sensitive = query.chars().any(char::is_uppercase);
    let needle: Vec<char> = query.chars().map(|c| fold(c, sensitive)).collect();
    let mut found = Vec::new();
    if needle.is_empty() {
        return found;
    }
    let mut at = 0;
    while at < rows.len() {
        let mut end = at;
        while end + 1 < rows.len() && rows[end].wrapped {
            end += 1;
        }
        let mut hay = Vec::new();
        let mut locs = Vec::new();
        for (r, row) in rows.iter().enumerate().take(end + 1).skip(at) {
            for g in &row.glyphs {
                hay.push(fold(g.ch, sensitive));
                locs.push(Pos {
                    row: r,
                    col: g.col + u16::from(g.width.max(1)) - 1,
                });
            }
        }
        let mut i = 0;
        while i + needle.len() <= hay.len() {
            if hay[i..i + needle.len()] == needle[..] {
                let first = locs[i];
                let start_col = rows[first.row]
                    .glyph_at(first.col)
                    .map_or(first.col, |g| g.col);
                found.push(Span {
                    start: Pos {
                        row: first.row,
                        col: start_col,
                    },
                    end: locs[i + needle.len() - 1],
                });
                i += needle.len();
            } else {
                i += 1;
            }
        }
        at = end + 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(text: &str, wrapped: bool) -> RowData {
        let mut glyphs = Vec::new();
        let mut col = 0u16;
        for ch in text.chars() {
            let width = if ch == '漢' { 2 } else { 1 };
            glyphs.push(Glyph { ch, col, width });
            col += u16::from(width);
        }
        RowData { glyphs, wrapped }
    }

    #[test]
    fn word_unit_groups_classes() {
        let r = row("ab_1 -- x", false);
        assert_eq!(word_unit(&r, 2), (0, 3));
        assert_eq!(word_unit(&r, 4), (4, 4));
        assert_eq!(word_unit(&r, 5), (5, 6));
        assert_eq!(word_unit(&r, 8), (8, 8));
    }

    #[test]
    fn wide_glyph_covers_both_cells() {
        let r = row("a漢b", false);
        assert_eq!(r.glyph_at(1).unwrap().ch, '漢');
        assert_eq!(r.glyph_at(2).unwrap().ch, '漢');
        assert_eq!(r.glyph_at(3).unwrap().ch, 'b');
        assert_eq!(word_unit(&r, 2), (0, 3));
    }

    #[test]
    fn text_joins_wrapped_rows_and_keeps_wide_once() {
        let rows = [row("hello ", true), row("wor漢", false), row("next", false)];
        let span = Span {
            start: Pos { row: 0, col: 0 },
            end: Pos { row: 2, col: 3 },
        };
        assert_eq!(text_of(&rows, span), "hello wor漢\nnext");
        let mid = Span {
            start: Pos { row: 1, col: 3 },
            end: Pos { row: 1, col: 3 },
        };
        assert_eq!(text_of(&rows[1..], mid), "漢");
    }

    #[test]
    fn search_spans_wrapped_rows_and_folds_case() {
        let rows = [row("say hel", true), row("lo there", false)];
        let hits = find_matches(&rows, "HELLO");
        assert!(hits.is_empty(), "uppercase query is case-sensitive");
        let hits = find_matches(&rows, "hello");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start, Pos { row: 0, col: 4 });
        assert_eq!(hits[0].end, Pos { row: 1, col: 1 });
    }
}
