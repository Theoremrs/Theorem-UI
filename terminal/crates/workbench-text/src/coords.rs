//! Text coordinates: one place that converts positions between UTF-8 bytes,
//! UTF-16 code units, Unicode scalars, (line, column) in each of those units,
//! grapheme clusters and display cells.
//!
//! The text is a `ropey::Rope`, which keeps a line index that stays correct
//! under edits and converts between bytes, scalars, UTF-16 units and lines.
//! This module adds what Ropey does not model: grapheme cluster boundaries
//! (through `unicode-segmentation`, walking the rope chunk by chunk) and
//! display cells (through `unicode-width`, with tab stops).
//!
//! Every conversion that can land inside a multi-unit character (the middle of
//! a UTF-8 sequence, between the halves of a surrogate pair) or inside a
//! grapheme cluster takes a [`Snap`] direction and returns a boundary. Offsets
//! past the end of the text give `None`, never a clamped guess.
//!
//! Line breaks are LF, CRLF and CR. A (line, column) column never counts the
//! line terminator.

use ropey::{Rope, RopeSlice};
use unicode_segmentation::{GraphemeCursor, GraphemeIncomplete, UnicodeSegmentation};
use unicode_width::UnicodeWidthStr;

/// The unit an offset or column is counted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Unit {
    /// UTF-8 bytes (diagnostics from the language host).
    Utf8,
    /// UTF-16 code units (the SDK's `TextChange`, LSP positions).
    Utf16,
    /// Unicode scalar values (the wire format of document edits; this crate's own unit).
    Scalar,
}

/// Which way a position that falls inside a character or cluster moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Snap {
    /// To the start of the character or cluster.
    Backward,
    /// To the end of the character or cluster.
    Forward,
    /// To the closer end; a tie goes backward.
    Nearest,
}

/// A line index and a column counted in some [`Unit`] from the line start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LineCol {
    pub line: usize,
    pub col: usize,
}

/// Width in cells of one grapheme cluster that starts at display column
/// `at_cell`. A tab runs to the next tab stop; everything else uses
/// `unicode-width`, so wide characters take two cells and combining marks none.
pub fn grapheme_cells(grapheme: &str, at_cell: usize, tab_width: usize) -> usize {
    if grapheme.starts_with('\t') {
        let tab = tab_width.max(1);
        tab - at_cell % tab
    } else {
        UnicodeWidthStr::width(grapheme)
    }
}

/// A read-only view of a rope with all the conversions.
#[derive(Clone, Copy)]
pub struct Coords<'a> {
    rope: &'a Rope,
}

impl<'a> Coords<'a> {
    pub fn new(rope: &'a Rope) -> Self {
        Self { rope }
    }

    /// Length of the whole text in `unit`.
    pub fn len(&self, unit: Unit) -> usize {
        match unit {
            Unit::Utf8 => self.rope.len_bytes(),
            Unit::Utf16 => self.rope.len_utf16_cu(),
            Unit::Scalar => self.rope.len_chars(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rope.len_chars() == 0
    }

    // ---- units ----

    /// Convert an offset in `unit` to a scalar offset. An offset inside a
    /// scalar (a UTF-8 continuation byte, the second half of a surrogate pair)
    /// moves according to `snap`. `None` when the offset is past the end.
    pub fn to_scalar(&self, offset: usize, unit: Unit, snap: Snap) -> Option<usize> {
        match unit {
            Unit::Scalar => (offset <= self.rope.len_chars()).then_some(offset),
            Unit::Utf8 => {
                if offset > self.rope.len_bytes() {
                    return None;
                }
                let c = self.rope.byte_to_char(offset);
                let start = self.rope.char_to_byte(c);
                if start == offset {
                    return Some(c);
                }
                let end = self.rope.char_to_byte(c + 1);
                Some(pick(snap, c, c + 1, offset - start, end - offset))
            }
            Unit::Utf16 => {
                if offset > self.rope.len_utf16_cu() {
                    return None;
                }
                let c = self.rope.utf16_cu_to_char(offset);
                let start = self.rope.char_to_utf16_cu(c);
                if start == offset {
                    return Some(c);
                }
                let end = self.rope.char_to_utf16_cu(c + 1);
                Some(pick(snap, c, c + 1, offset - start, end - offset))
            }
        }
    }

    /// Convert a scalar offset to `unit`. Always exact. `None` past the end.
    pub fn from_scalar(&self, scalar: usize, unit: Unit) -> Option<usize> {
        if scalar > self.rope.len_chars() {
            return None;
        }
        Some(match unit {
            Unit::Scalar => scalar,
            Unit::Utf8 => self.rope.char_to_byte(scalar),
            Unit::Utf16 => self.rope.char_to_utf16_cu(scalar),
        })
    }

    /// Convert between two units. The result is on a scalar boundary.
    pub fn convert(&self, offset: usize, from: Unit, to: Unit, snap: Snap) -> Option<usize> {
        let s = self.to_scalar(offset, from, snap)?;
        self.from_scalar(s, to)
    }

    /// Like [`convert`](Self::convert), but the result is also on a grapheme
    /// cluster boundary.
    pub fn convert_to_grapheme(
        &self,
        offset: usize,
        from: Unit,
        to: Unit,
        snap: Snap,
    ) -> Option<usize> {
        let s = self.to_scalar(offset, from, snap)?;
        self.from_scalar(self.snap_grapheme(s, snap), to)
    }

    // ---- graphemes ----

    /// True when `scalar` is between two grapheme clusters (or at either end).
    pub fn is_grapheme_boundary(&self, scalar: usize) -> bool {
        let len = self.rope.len_bytes();
        let byte = self.rope.char_to_byte(scalar.min(self.rope.len_chars()));
        if byte == 0 || byte >= len {
            return true;
        }
        let mut gc = GraphemeCursor::new(byte, len, true);
        let (mut chunk, mut start, _, _) = self.rope.chunk_at_byte(byte);
        loop {
            match gc.is_boundary(chunk, start) {
                Ok(b) => return b,
                Err(GraphemeIncomplete::PreContext(n)) => {
                    let (c, s, _, _) = self.rope.chunk_at_byte(n - 1);
                    gc.provide_context(c, s);
                }
                Err(GraphemeIncomplete::NextChunk) => {
                    start += chunk.len();
                    chunk = self.rope.chunk_at_byte(start).0;
                }
                Err(_) => return true,
            }
        }
    }

    /// The first cluster boundary after `scalar` (the end of text at the end).
    pub fn next_grapheme(&self, scalar: usize) -> usize {
        let len = self.rope.len_bytes();
        let byte = self.rope.char_to_byte(scalar.min(self.rope.len_chars()));
        if byte >= len {
            return self.rope.len_chars();
        }
        let mut gc = GraphemeCursor::new(byte, len, true);
        let (mut chunk, mut start, _, _) = self.rope.chunk_at_byte(byte);
        loop {
            match gc.next_boundary(chunk, start) {
                Ok(None) => return self.rope.len_chars(),
                Ok(Some(n)) => return self.rope.byte_to_char(n),
                Err(GraphemeIncomplete::NextChunk) => {
                    start += chunk.len();
                    chunk = self.rope.chunk_at_byte(start).0;
                }
                Err(GraphemeIncomplete::PreContext(n)) => {
                    let (c, s, _, _) = self.rope.chunk_at_byte(n - 1);
                    gc.provide_context(c, s);
                }
                Err(_) => return self.rope.len_chars(),
            }
        }
    }

    /// The last cluster boundary before `scalar` (0 at the start).
    pub fn prev_grapheme(&self, scalar: usize) -> usize {
        let byte = self.rope.char_to_byte(scalar.min(self.rope.len_chars()));
        if byte == 0 {
            return 0;
        }
        let mut gc = GraphemeCursor::new(byte, self.rope.len_bytes(), true);
        let (mut chunk, mut start, _, _) = self.rope.chunk_at_byte(byte - 1);
        loop {
            match gc.prev_boundary(chunk, start) {
                Ok(None) => return 0,
                Ok(Some(n)) => return self.rope.byte_to_char(n),
                Err(GraphemeIncomplete::PrevChunk) => {
                    let (c, s, _, _) = self.rope.chunk_at_byte(start - 1);
                    chunk = c;
                    start = s;
                }
                Err(GraphemeIncomplete::PreContext(n)) => {
                    let (c, s, _, _) = self.rope.chunk_at_byte(n - 1);
                    gc.provide_context(c, s);
                }
                Err(_) => return 0,
            }
        }
    }

    /// Move a scalar offset to a cluster boundary. Offsets past the end clamp to the end.
    pub fn snap_grapheme(&self, scalar: usize, snap: Snap) -> usize {
        let scalar = scalar.min(self.rope.len_chars());
        if self.is_grapheme_boundary(scalar) {
            return scalar;
        }
        let back = self.prev_grapheme(scalar);
        let fwd = self.next_grapheme(scalar);
        pick(snap, back, fwd, scalar - back, fwd - scalar)
    }

    /// Number of clusters before `scalar` (which is first snapped backward to a boundary).
    pub fn grapheme_index(&self, scalar: usize) -> usize {
        let target = self.snap_grapheme(scalar, Snap::Backward);
        let (mut at, mut n) = (0, 0);
        while at < target {
            at = self.next_grapheme(at);
            n += 1;
        }
        n
    }

    /// Scalar offset of the start of cluster number `index`; `None` past the end.
    pub fn grapheme_offset(&self, index: usize) -> Option<usize> {
        let mut at = 0;
        for _ in 0..index {
            if at >= self.rope.len_chars() {
                return None;
            }
            at = self.next_grapheme(at);
        }
        Some(at)
    }

    // ---- lines ----

    /// Number of lines (a trailing line break starts one more, empty line).
    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    /// Line holding scalar offset `scalar`.
    pub fn line_of(&self, scalar: usize) -> usize {
        self.rope.char_to_line(scalar.min(self.rope.len_chars()))
    }

    /// Scalar range of a line's content, without its terminator.
    pub fn line_range(&self, line: usize) -> Option<(usize, usize)> {
        let slice = self.rope.get_line(line)?;
        let start = self.rope.line_to_char(line);
        Some((start, start + slice.len_chars() - terminator_len(slice)))
    }

    /// (line, column) of an offset in `unit`. The column counts `unit`s from
    /// the line start. An offset inside a scalar snaps backward; one that sits
    /// between a CR and its LF reports the column past the line content, so
    /// callers should snap to a grapheme boundary first when that matters.
    pub fn line_col(&self, offset: usize, unit: Unit) -> Option<LineCol> {
        let scalar = self.to_scalar(offset, unit, Snap::Backward)?;
        let line = self.rope.char_to_line(scalar);
        let start = self.rope.line_to_char(line);
        let col = self.from_scalar(scalar, unit)? - self.from_scalar(start, unit)?;
        Some(LineCol { line, col })
    }

    /// Offset in `unit` of a (line, column). `None` when the line does not
    /// exist or the column is past the line's content. A column inside a
    /// scalar moves according to `snap`.
    pub fn offset_of(&self, pos: LineCol, unit: Unit, snap: Snap) -> Option<usize> {
        let (start, end) = self.line_range(pos.line)?;
        let base = self.from_scalar(start, unit)?;
        let limit = self.from_scalar(end, unit)? - base;
        if pos.col > limit {
            return None;
        }
        let scalar = self.to_scalar(base + pos.col, unit, snap)?.min(end);
        self.from_scalar(scalar, unit)
    }

    // ---- display cells ----

    /// Visit the grapheme clusters in the scalar range `[start, end)` in order,
    /// as `(scalar offset of the cluster, cluster text)`. `start` and `end`
    /// should be cluster boundaries; the visit stops when `f` returns false.
    pub fn for_each_cluster(
        &self,
        start: usize,
        end: usize,
        mut f: impl FnMut(usize, &str) -> bool,
    ) {
        let end = end.min(self.rope.len_chars());
        if start >= end {
            return;
        }
        let text = self.rope.slice(start..end).to_string();
        let mut at = start;
        for g in text.graphemes(true) {
            if !f(at, g) {
                return;
            }
            at += g.chars().count();
        }
    }

    /// Display cells from `start` (a scalar offset that begins a row) to
    /// `offset`, walking whole clusters. `offset` is snapped backward to a
    /// cluster boundary first.
    pub fn cells_between(&self, start: usize, offset: usize, tab_width: usize) -> usize {
        let target = self.snap_grapheme(offset, Snap::Backward);
        let mut cells = 0;
        self.for_each_cluster(start, target, |_, g| {
            cells += grapheme_cells(g, cells, tab_width);
            true
        });
        cells
    }

    /// The scalar offset in `[start, end]` whose cluster covers display cell
    /// `cell`, counting from `start`. A cell in the middle of a wide cluster or
    /// a tab moves according to `snap`; a cell past the end gives `end`.
    pub fn offset_at_cell(
        &self,
        start: usize,
        end: usize,
        cell: usize,
        tab_width: usize,
        snap: Snap,
    ) -> usize {
        let mut cells = 0;
        let mut found = None;
        self.for_each_cluster(start, end, |at, g| {
            let w = grapheme_cells(g, cells, tab_width);
            if cell < cells + w {
                let next = at + g.chars().count();
                found = Some(pick(snap, at, next, cell - cells, cells + w - cell));
                return false;
            }
            cells += w;
            true
        });
        found.unwrap_or(end)
    }

    /// (line, display column in cells) of a scalar offset, columns counted from the line start.
    pub fn display_col(&self, scalar: usize, tab_width: usize) -> (usize, usize) {
        let line = self.line_of(scalar);
        let (start, _) = self.line_range(line).unwrap_or((0, 0));
        (line, self.cells_between(start, scalar, tab_width))
    }

    /// Scalar offset on `line` at display column `cell`.
    pub fn offset_at_display_col(
        &self,
        line: usize,
        cell: usize,
        tab_width: usize,
        snap: Snap,
    ) -> Option<usize> {
        let (start, end) = self.line_range(line)?;
        Some(self.offset_at_cell(start, end, cell, tab_width, snap))
    }
}

/// Pick between `back` and `fwd` by direction; `Nearest` compares the two distances.
fn pick(snap: Snap, back: usize, fwd: usize, dist_back: usize, dist_fwd: usize) -> usize {
    match snap {
        Snap::Backward => back,
        Snap::Forward => fwd,
        Snap::Nearest => {
            if dist_fwd < dist_back {
                fwd
            } else {
                back
            }
        }
    }
}

/// Length of the line terminator at the end of a rope line (0, 1 or 2 scalars).
pub(crate) fn terminator_len(line: RopeSlice) -> usize {
    let n = line.len_chars();
    if n == 0 {
        return 0;
    }
    match line.char(n - 1) {
        '\n' if n >= 2 && line.char(n - 2) == '\r' => 2,
        '\n' | '\r' => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> Rope {
        Rope::from_str(s)
    }

    #[test]
    fn units_round_trip_on_mixed_text() {
        // "a", a 2-byte char, a 3-byte char, a 4-byte char (a surrogate pair), "b"
        let rope = r("a\u{e9}\u{4e2d}\u{1F600}b");
        let c = Coords::new(&rope);
        assert_eq!(c.len(Unit::Scalar), 5);
        assert_eq!(c.len(Unit::Utf8), 1 + 2 + 3 + 4 + 1);
        assert_eq!(c.len(Unit::Utf16), 1 + 1 + 1 + 2 + 1);
        for s in 0..=5 {
            let b = c.from_scalar(s, Unit::Utf8).unwrap();
            let u = c.from_scalar(s, Unit::Utf16).unwrap();
            assert_eq!(c.to_scalar(b, Unit::Utf8, Snap::Backward), Some(s));
            assert_eq!(c.to_scalar(u, Unit::Utf16, Snap::Forward), Some(s));
        }
    }

    #[test]
    fn mid_scalar_offsets_snap_in_the_stated_direction() {
        let rope = r("a\u{1F600}b");
        let c = Coords::new(&rope);
        // UTF-16 offset 2 is between the halves of the pair.
        assert_eq!(c.to_scalar(2, Unit::Utf16, Snap::Backward), Some(1));
        assert_eq!(c.to_scalar(2, Unit::Utf16, Snap::Forward), Some(2));
        assert_eq!(c.to_scalar(2, Unit::Utf16, Snap::Nearest), Some(1));
        // UTF-8 offset 3 is inside the 4-byte scalar (bytes 1..5).
        assert_eq!(c.to_scalar(3, Unit::Utf8, Snap::Backward), Some(1));
        assert_eq!(c.to_scalar(3, Unit::Utf8, Snap::Forward), Some(2));
        assert_eq!(c.to_scalar(4, Unit::Utf8, Snap::Nearest), Some(2));
        assert_eq!(c.to_scalar(99, Unit::Utf8, Snap::Backward), None);
    }

    #[test]
    fn graphemes_zwj_combining_and_crlf() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let rope = r(&format!("x{family}e\u{301}\r\ny"));
        let c = Coords::new(&rope);
        // x | family (5 scalars) | e+acute (2) | CRLF (2) | y
        assert_eq!(c.next_grapheme(1), 6);
        assert_eq!(c.prev_grapheme(6), 1);
        assert_eq!(c.snap_grapheme(3, Snap::Backward), 1);
        assert_eq!(c.snap_grapheme(3, Snap::Forward), 6);
        assert_eq!(c.next_grapheme(6), 8);
        assert_eq!(c.next_grapheme(8), 10, "CRLF is one cluster");
        assert_eq!(c.snap_grapheme(9, Snap::Backward), 8);
        assert_eq!(c.grapheme_index(10), 4);
        assert_eq!(c.grapheme_offset(4), Some(10));
        assert_eq!(c.grapheme_offset(99), None);
    }

    #[test]
    fn lines_and_columns_in_each_unit() {
        let rope = r("ab\r\n\u{1F600}x\nlast");
        let c = Coords::new(&rope);
        assert_eq!(c.line_count(), 3);
        assert_eq!(c.line_range(0), Some((0, 2)));
        assert_eq!(c.line_range(1), Some((4, 6)));
        assert_eq!(c.line_range(2), Some((7, 11)));
        // The emoji is 2 UTF-16 units and 4 bytes; the column of "x" differs by unit.
        let x_scalar = 5;
        assert_eq!(
            c.line_col(x_scalar, Unit::Scalar),
            Some(LineCol { line: 1, col: 1 })
        );
        let x16 = c.from_scalar(x_scalar, Unit::Utf16).unwrap();
        assert_eq!(
            c.line_col(x16, Unit::Utf16),
            Some(LineCol { line: 1, col: 2 })
        );
        let x8 = c.from_scalar(x_scalar, Unit::Utf8).unwrap();
        assert_eq!(
            c.line_col(x8, Unit::Utf8),
            Some(LineCol { line: 1, col: 4 })
        );
        assert_eq!(
            c.offset_of(LineCol { line: 1, col: 2 }, Unit::Utf16, Snap::Backward),
            Some(x16)
        );
        assert_eq!(
            c.offset_of(LineCol { line: 1, col: 9 }, Unit::Utf16, Snap::Backward),
            None
        );
        assert_eq!(
            c.offset_of(LineCol { line: 7, col: 0 }, Unit::Scalar, Snap::Backward),
            None
        );
    }

    #[test]
    fn cells_for_tabs_wide_and_zero_width() {
        let rope = r("a\tb\u{4e2d}e\u{301}z");
        let c = Coords::new(&rope);
        // a(1) tab to stop 4 (3) b(1) CJK(2) e+acute(1) z(1)
        assert_eq!(c.cells_between(0, 1, 4), 1);
        assert_eq!(c.cells_between(0, 2, 4), 4);
        assert_eq!(c.cells_between(0, 3, 4), 5);
        assert_eq!(c.cells_between(0, 4, 4), 7);
        assert_eq!(c.cells_between(0, 6, 4), 8);
        // A scalar offset between e and the accent snaps back to the cluster start.
        assert_eq!(c.cells_between(0, 6, 4), c.cells_between(0, 5, 4) + 1);
        assert_eq!(c.offset_at_cell(0, 7, 5, 4, Snap::Backward), 3);
        assert_eq!(
            c.offset_at_cell(0, 7, 5, 4, Snap::Forward),
            4,
            "inside the wide char"
        );
        assert_eq!(
            c.offset_at_cell(0, 7, 2, 4, Snap::Backward),
            1,
            "inside the tab"
        );
        assert_eq!(c.offset_at_cell(0, 7, 50, 4, Snap::Backward), 7);
        assert_eq!(c.display_col(4, 4), (0, 5 + 2));
    }

    #[test]
    fn grapheme_functions_cross_rope_chunks() {
        // Long enough to span several rope chunks; the cluster is placed near a chunk edge.
        let mut s = "a".repeat(3000);
        s.push_str("e\u{301}");
        s.push_str(&"b".repeat(3000));
        let rope = r(&s);
        let c = Coords::new(&rope);
        assert!(!c.is_grapheme_boundary(3001));
        assert_eq!(c.next_grapheme(3000), 3002);
        assert_eq!(c.prev_grapheme(3002), 3000);
    }
}
