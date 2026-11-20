//! The terminal screen: `vt100` plus the state a pane needs around it (stream
//! offset, scrollback view, selection, search, replies to terminal queries).

use std::fmt;

use tui_term::widget::CursorShape;
use vt100::{MouseProtocolEncoding, MouseProtocolMode, Parser};

use crate::buffer::{Glyph, Pos, RowData, SelectionKind, Span, find_matches, text_of, word_unit};
use crate::input::InputModes;

/// Scrollback lines kept. The workspace host builds its repaint snapshot with
/// the same number.
pub const SCROLLBACK_LINES: usize = 2000;

/// `feed_at` was given bytes that start after the last byte applied, so
/// bytes in between are missing. The caller should re-attach from `expected`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OffsetGap {
    pub expected: u64,
    pub got: u64,
}

impl fmt::Display for OffsetGap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "output gap: next byte is {} but the stream continues at {}",
            self.expected, self.got
        )
    }
}

impl std::error::Error for OffsetGap {}

/// What `vt100` does not keep, gathered from its callbacks: the title, bells,
/// cursor shape, focus reporting, and the answers to terminal queries.
#[derive(Default)]
struct Events {
    title: String,
    bells: u32,
    cursor_shape: CursorShape,
    focus_reporting: bool,
    replies: Vec<u8>,
}

impl vt100::Callbacks for Events {
    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.bells += 1;
    }

    fn visual_bell(&mut self, _: &mut vt100::Screen) {
        self.bells += 1;
    }

    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = String::from_utf8_lossy(title).into_owned();
    }

    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        let first = params.first().and_then(|p| p.first()).copied().unwrap_or(0);
        match (i1, i2, c) {
            // Device status: "ready", and the cursor position report.
            (None, None, 'n') if first == 5 => self.replies.extend_from_slice(b"\x1b[0n"),
            (None, None, 'n') | (Some(b'?'), None, 'n') if first == 6 => {
                let (row, col) = screen.cursor_position();
                let lead = if i1.is_some() { "?" } else { "" };
                let reply = format!("\x1b[{lead}{};{}R", row + 1, col + 1);
                self.replies.extend_from_slice(reply.as_bytes());
            }
            // Primary and secondary device attributes.
            (None, None, 'c') if first == 0 => self.replies.extend_from_slice(b"\x1b[?62;22c"),
            (Some(b'>'), None, 'c') if first == 0 => {
                self.replies.extend_from_slice(b"\x1b[>0;0;0c");
            }
            // Focus reporting arrives among modes `vt100` does not track.
            (Some(b'?'), None, 'h' | 'l') if params.iter().any(|p| p.first() == Some(&1004)) => {
                self.focus_reporting = c == 'h';
            }
            // DECSCUSR: cursor shape.
            (Some(b' '), None, 'q') => {
                self.cursor_shape = match first {
                    1 => CursorShape::BlinkingBlock,
                    2 => CursorShape::SteadyBlock,
                    3 => CursorShape::BlinkingUnderline,
                    4 => CursorShape::SteadyUnderline,
                    5 => CursorShape::BlinkingBar,
                    6 => CursorShape::SteadyBar,
                    _ => CursorShape::Default,
                };
            }
            _ => {}
        }
    }
}

struct Selection {
    anchor: Span,
    head: Span,
    kind: SelectionKind,
}

impl Selection {
    fn span(&self) -> Span {
        Span {
            start: self.anchor.start.min(self.head.start),
            end: self.anchor.end.max(self.head.end),
        }
    }
}

#[derive(Default)]
struct Search {
    query: String,
    matches: Vec<Span>,
    current: Option<usize>,
}

/// One terminal screen with scrollback.
pub struct Screen {
    parser: Parser<Events>,
    /// The offset of the next stream byte this screen expects.
    applied: u64,
    /// Lines in the scrollback of the active grid.
    scrollback_len: usize,
    selection: Option<Selection>,
    search: Search,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: Parser::new_with_callbacks(rows, cols, SCROLLBACK_LINES, Events::default()),
            applied: 0,
            scrollback_len: 0,
            selection: None,
            search: Search::default(),
        }
    }

    // ---- bytes in -------------------------------------------------------

    /// Interprets output bytes. Sequences split across calls are fine.
    pub fn feed(&mut self, bytes: &[u8]) {
        let full = self.scrollback_len >= SCROLLBACK_LINES;
        let was_alt = self.alternate_screen();
        self.parser.process(bytes);
        self.applied += bytes.len() as u64;
        self.scrollback_len = self.probe_scrollback_len();
        // Absolute rows shift when a full scrollback evicts its oldest line,
        // and the main buffer is not the one on screen after a switch.
        if (full && !bytes.is_empty()) || was_alt != self.alternate_screen() {
            self.selection = None;
        }
        self.refresh_search();
    }

    /// Interprets `bytes` that the host log holds at `offset`. Bytes already
    /// applied are skipped, so overlapping ranges after a re-attach are fine.
    /// Returns how many bytes were new. A range that starts after the next
    /// expected byte is refused and nothing is applied.
    pub fn feed_at(&mut self, offset: u64, bytes: &[u8]) -> Result<usize, OffsetGap> {
        if offset > self.applied {
            return Err(OffsetGap {
                expected: self.applied,
                got: offset,
            });
        }
        let skip = usize::try_from(self.applied - offset).unwrap_or(usize::MAX);
        if skip >= bytes.len() {
            return Ok(0);
        }
        let fresh = &bytes[skip..];
        self.feed(fresh);
        Ok(fresh.len())
    }

    /// The offset of the next stream byte this screen expects.
    pub fn applied_offset(&self) -> u64 {
        self.applied
    }

    /// Drops every cell, mode and scrollback line and replays `formatted`,
    /// the host's repaint taken at stream offset `offset`. Use it when the
    /// stream epoch changes or an attach reply says the log was truncated.
    /// The size stays as it is: resize to the host's size first.
    pub fn reset_with_formatted(&mut self, formatted: &[u8], offset: u64) {
        let (rows, cols) = self.size();
        self.parser = Parser::new_with_callbacks(rows, cols, SCROLLBACK_LINES, Events::default());
        self.parser.process(formatted);
        self.applied = offset;
        self.scrollback_len = self.probe_scrollback_len();
        self.selection = None;
        self.search.matches.clear();
        self.search.current = None;
        self.refresh_search();
    }

    /// Changes the grid size. Scrollback is kept; selection and search
    /// matches are dropped because rows no longer line up.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        if (rows, cols) == self.size() {
            return;
        }
        self.parser.screen_mut().set_size(rows, cols);
        self.scrollback_len = self.probe_scrollback_len();
        self.selection = None;
        self.refresh_search();
    }

    /// Bytes the terminal owes the program in answer to its queries (cursor
    /// position, device status and attributes). Send them as `reply` input.
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.parser.callbacks_mut().replies)
    }

    // ---- state ----------------------------------------------------------

    /// The `vt100` screen, for `tui-term` and cell-level reads.
    pub fn vt(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// `(rows, cols)`.
    pub fn size(&self) -> (u16, u16) {
        self.vt().size()
    }

    /// The text of the rows on view (affected by the scroll position).
    pub fn contents(&self) -> String {
        self.vt().contents()
    }

    /// Cursor `(row, col)` on the live screen, zero-based, ignoring scroll.
    pub fn cursor_position(&self) -> (u16, u16) {
        self.vt().cursor_position()
    }

    pub fn cursor_visible(&self) -> bool {
        !self.vt().hide_cursor()
    }

    pub fn cursor_shape(&self) -> CursorShape {
        self.parser.callbacks().cursor_shape
    }

    pub fn title(&self) -> &str {
        &self.parser.callbacks().title
    }

    /// Bells since the last call.
    pub fn take_bells(&mut self) -> u32 {
        std::mem::take(&mut self.parser.callbacks_mut().bells)
    }

    pub fn alternate_screen(&self) -> bool {
        self.vt().alternate_screen()
    }

    pub fn application_cursor(&self) -> bool {
        self.vt().application_cursor()
    }

    pub fn application_keypad(&self) -> bool {
        self.vt().application_keypad()
    }

    pub fn bracketed_paste(&self) -> bool {
        self.vt().bracketed_paste()
    }

    pub fn mouse_mode(&self) -> MouseProtocolMode {
        self.vt().mouse_protocol_mode()
    }

    pub fn mouse_encoding(&self) -> MouseProtocolEncoding {
        self.vt().mouse_protocol_encoding()
    }

    pub fn focus_reporting(&self) -> bool {
        self.parser.callbacks().focus_reporting
    }

    /// The modes that decide how input is encoded right now.
    pub fn input_modes(&self) -> InputModes {
        InputModes {
            application_cursor: self.application_cursor(),
            application_keypad: self.application_keypad(),
            bracketed_paste: self.bracketed_paste(),
            mouse_mode: self.mouse_mode(),
            mouse_encoding: self.mouse_encoding(),
            focus_reporting: self.focus_reporting(),
        }
    }

    // ---- scrollback -----------------------------------------------------

    /// Lines in the scrollback (always 0 on the alternate screen).
    pub fn scrollback_len(&self) -> usize {
        self.scrollback_len
    }

    /// How many lines the view is scrolled above the bottom. 0 follows live
    /// output; while it is above 0, new output does not move the view.
    pub fn scrollback_offset(&self) -> usize {
        self.vt().scrollback()
    }

    pub fn is_following(&self) -> bool {
        self.scrollback_offset() == 0
    }

    /// Scrolls toward older lines.
    pub fn scroll_up(&mut self, lines: usize) {
        let to = self.scrollback_offset().saturating_add(lines);
        self.parser.screen_mut().set_scrollback(to);
    }

    /// Scrolls toward the live screen.
    pub fn scroll_down(&mut self, lines: usize) {
        let to = self.scrollback_offset().saturating_sub(lines);
        self.parser.screen_mut().set_scrollback(to);
    }

    pub fn scroll_page_up(&mut self) {
        self.scroll_up(self.page());
    }

    pub fn scroll_page_down(&mut self) {
        self.scroll_down(self.page());
    }

    pub fn scroll_to_top(&mut self) {
        self.parser.screen_mut().set_scrollback(self.scrollback_len);
    }

    pub fn scroll_to_bottom(&mut self) {
        self.parser.screen_mut().set_scrollback(0);
    }

    fn page(&self) -> usize {
        usize::from(self.size().0).saturating_sub(1).max(1)
    }

    fn probe_scrollback_len(&mut self) -> usize {
        let saved = self.scrollback_offset();
        self.parser.screen_mut().set_scrollback(usize::MAX);
        let len = self.scrollback_offset();
        self.parser.screen_mut().set_scrollback(saved);
        len
    }

    // ---- positions ------------------------------------------------------

    /// The buffer position of a cell on view.
    pub fn view_pos(&self, view_row: u16, col: u16) -> Pos {
        Pos {
            row: self.view_top() + usize::from(view_row),
            col,
        }
    }

    /// The buffer row shown at the top of the view.
    pub fn view_top(&self) -> usize {
        self.scrollback_len - self.scrollback_offset()
    }

    fn total_rows(&self) -> usize {
        self.scrollback_len + usize::from(self.size().0)
    }

    /// Scrolls the least amount that puts `row` in view, centred when it
    /// was out of view.
    fn reveal(&mut self, row: usize) {
        let rows = usize::from(self.size().0);
        let top = self.view_top();
        if row >= top && row < top + rows {
            return;
        }
        let new_top = row.saturating_sub(rows / 2).min(self.scrollback_len);
        self.parser
            .screen_mut()
            .set_scrollback(self.scrollback_len - new_top);
    }

    /// Row snapshots for buffer rows `from..=to` (clamped to the buffer).
    fn rows(&mut self, from: usize, to: usize) -> Vec<RowData> {
        let (rows_n, cols) = self.size();
        let last = to.min(self.total_rows().saturating_sub(1));
        let saved = self.scrollback_offset();
        let mut out = Vec::new();
        let mut at = from;
        while at <= last {
            let top = at.min(self.scrollback_len);
            self.parser
                .screen_mut()
                .set_scrollback(self.scrollback_len - top);
            let screen = self.parser.screen();
            let mut v = at - top;
            while v < usize::from(rows_n) && at <= last {
                out.push(read_row(screen, v as u16, cols));
                v += 1;
                at += 1;
            }
        }
        self.parser.screen_mut().set_scrollback(saved);
        out
    }

    // ---- selection ------------------------------------------------------

    /// Starts a new selection at `at`, replacing any earlier one.
    pub fn select(&mut self, kind: SelectionKind, at: Pos) {
        let unit = self.unit(kind, at);
        self.selection = Some(Selection {
            anchor: unit,
            head: unit,
            kind,
        });
    }

    /// Moves the free end of the selection to `to`, by the unit of the kind
    /// it was started with.
    pub fn extend_selection(&mut self, to: Pos) {
        let Some(kind) = self.selection.as_ref().map(|s| s.kind) else {
            return;
        };
        let head = self.unit(kind, to);
        if let Some(sel) = self.selection.as_mut() {
            sel.head = head;
        }
    }

    pub fn clear_selection(&mut self) {
        self.selection = None;
    }

    /// The selected cells, ordered, ends inclusive.
    pub fn selection(&self) -> Option<Span> {
        self.selection.as_ref().map(Selection::span)
    }

    /// The selected text, ready for the clipboard.
    pub fn selection_text(&mut self) -> Option<String> {
        let span = self.selection()?;
        let rows = self.rows(span.start.row, span.end.row);
        Some(text_of(&rows, span))
    }

    /// The cells a click at `at` covers for this kind of selection.
    fn unit(&mut self, kind: SelectionKind, at: Pos) -> Span {
        let (_, cols) = self.size();
        let at = Pos {
            row: at.row.min(self.total_rows().saturating_sub(1)),
            col: at.col.min(cols.saturating_sub(1)),
        };
        match kind {
            SelectionKind::Cell => {
                let row = self.rows(at.row, at.row).remove(0);
                let (lo, hi) = row.glyph_at(at.col).map_or((at.col, at.col), |g| {
                    (g.col, g.col + u16::from(g.width) - 1)
                });
                Span {
                    start: Pos {
                        row: at.row,
                        col: lo,
                    },
                    end: Pos {
                        row: at.row,
                        col: hi,
                    },
                }
            }
            SelectionKind::Word => {
                let row = self.rows(at.row, at.row).remove(0);
                let (lo, hi) = word_unit(&row, at.col);
                Span {
                    start: Pos {
                        row: at.row,
                        col: lo,
                    },
                    end: Pos {
                        row: at.row,
                        col: hi,
                    },
                }
            }
            SelectionKind::Line => {
                let mut first = at.row;
                while first > 0 && self.rows(first - 1, first - 1)[0].wrapped {
                    first -= 1;
                }
                let mut last = at.row;
                while last + 1 < self.total_rows() && self.rows(last, last)[0].wrapped {
                    last += 1;
                }
                Span {
                    start: Pos { row: first, col: 0 },
                    end: Pos {
                        row: last,
                        col: cols.saturating_sub(1),
                    },
                }
            }
        }
    }

    // ---- search ---------------------------------------------------------

    /// Searches the scrollback and the screen. An empty query clears the
    /// search. A query with an uppercase letter is case-sensitive. Matches
    /// follow new output.
    pub fn search(&mut self, query: &str) {
        self.search = Search {
            query: query.to_owned(),
            ..Search::default()
        };
        self.refresh_search();
    }

    pub fn clear_search(&mut self) {
        self.search = Search::default();
    }

    /// Every match, oldest first.
    pub fn search_matches(&self) -> &[Span] {
        &self.search.matches
    }

    /// Index into `search_matches` of the match last stepped to.
    pub fn search_current(&self) -> Option<usize> {
        self.search.current
    }

    /// Steps to the next match (the first one at or below the top of the view
    /// when none is current), wrapping at the end, and scrolls it into view.
    pub fn search_next(&mut self) -> Option<Span> {
        let count = self.search.matches.len();
        if count == 0 {
            return None;
        }
        let top = self.view_top();
        let next = match self.search.current {
            Some(i) => (i + 1) % count,
            None => self
                .search
                .matches
                .iter()
                .position(|m| m.end.row >= top)
                .unwrap_or(0),
        };
        self.step_to(next)
    }

    /// Steps to the previous match, wrapping at the start.
    pub fn search_prev(&mut self) -> Option<Span> {
        let count = self.search.matches.len();
        if count == 0 {
            return None;
        }
        let bottom = self.view_top() + usize::from(self.size().0);
        let prev = match self.search.current {
            Some(i) => (i + count - 1) % count,
            None => self
                .search
                .matches
                .iter()
                .rposition(|m| m.start.row < bottom)
                .unwrap_or(count - 1),
        };
        self.step_to(prev)
    }

    fn step_to(&mut self, index: usize) -> Option<Span> {
        self.search.current = Some(index);
        let span = self.search.matches[index];
        self.reveal(span.start.row);
        Some(span)
    }

    fn refresh_search(&mut self) {
        if self.search.query.is_empty() {
            return;
        }
        let kept = self.search.current.map(|i| self.search.matches[i].start);
        let rows = self.rows(0, usize::MAX);
        self.search.matches = find_matches(&rows, &self.search.query);
        self.search.current =
            kept.and_then(|s| self.search.matches.iter().position(|m| m.start == s));
    }
}

fn read_row(screen: &vt100::Screen, view_row: u16, cols: u16) -> RowData {
    let mut glyphs = Vec::new();
    for col in 0..cols {
        let Some(cell) = screen.cell(view_row, col) else {
            glyphs.push(Glyph {
                ch: '\0',
                col,
                width: 1,
            });
            continue;
        };
        if cell.is_wide_continuation() {
            continue;
        }
        if !cell.has_contents() {
            glyphs.push(Glyph {
                ch: '\0',
                col,
                width: 1,
            });
            continue;
        }
        for (i, ch) in cell.contents().chars().enumerate() {
            let width = match (i, cell.is_wide()) {
                (0, true) => 2,
                (0, false) => 1,
                _ => 0,
            };
            glyphs.push(Glyph { ch, col, width });
        }
    }
    RowData {
        glyphs,
        wrapped: screen.row_wrapped(view_row),
    }
}
