//! The editing widget: a view over an [`EditSession`] that the caller owns.
//!
//! [`SourceView`] holds only what belongs to the view (the size it was given,
//! a drag in progress). The text, the selection, the undo history and the
//! pending edits all stay in the session, so a second front end (Markdown
//! source mode) can lend its own session to the same widget, and the document
//! panel can keep the session alive while the view goes away.
//!
//! Why this draws its own rows instead of calling `workbench_text::render`:
//! that function takes `&mut EditSession` and snaps the scroll back to the
//! caret on every call, so a wheel scroll could not leave the caret off screen
//! and a `Panel::view(&self)` could not call it; it also has no way to paint a
//! search match or the caret's line. The row layout, the cell widths and the
//! hit testing here are the text crate's own (`line_rows`, `grapheme_cells`,
//! `Coords`); only the painting and the scroll arithmetic are repeated.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::{PanelPointer, PointerKind};
use theorem_workbench_text::coords::{grapheme_cells, stand_in};
use theorem_workbench_text::layout::{Row, line_rows, row_index};
use theorem_workbench_text::{
    Caret, Coords, Deletion, EditError, EditSession, Motion, Newlines, PasteOptions, Scroll, Snap,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::styles::EditorStyles;

/// The most a paste may carry. The owner's own bound is larger; this keeps one
/// keystroke from turning into a frame-sized edit.
pub const PASTE_LIMIT: usize = 4 * 1024 * 1024;

/// What the widget needs the host's clipboard for. It never keeps a buffer of
/// its own: the caller sends a write or a read through the core's effects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clipboard {
    /// Write the selected text.
    Copy,
    /// Write the selected text, then delete it once the write is accepted.
    Cut,
    /// Read the clipboard, then call [`SourceView::paste`] with what it held.
    Paste,
}

/// What an input did to the session.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reaction {
    /// The widget used the input. An unhandled key is the caller's.
    pub handled: bool,
    /// The text changed: the caller sends the pending edit.
    pub edited: bool,
    /// The caret or selection moved.
    pub moved: bool,
    pub clipboard: Option<Clipboard>,
    /// The session refused the edit (read-only, too large).
    pub error: Option<EditError>,
}

impl Reaction {
    fn handled() -> Self {
        Self {
            handled: true,
            ..Self::default()
        }
    }
}

/// How one paint is styled and what it shows besides the text.
pub struct Paint<'a> {
    pub styles: &'a EditorStyles,
    /// Draw the caret cell. Off while the panel does not have the keyboard.
    pub focused: bool,
    /// Scalar ranges, in order and apart, at the session's current text.
    pub matches: &'a [(usize, usize)],
    /// The index in `matches` the caret is on.
    pub current: Option<usize>,
    /// Syntax colour: ranges in order and apart, each with the style it is
    /// drawn in, at the session's current text. The host that has spans for a
    /// revision other than the text's passes none.
    pub tokens: &'a [Mark],
    /// Findings: ranges that may overlap each other and the tokens, each
    /// patched over whatever else the text there is drawn in.
    pub marks: &'a [Mark],
    /// A mark in the line-number column: the line (from 0), the glyph and its
    /// style. Lines that are not listed show only their number.
    pub gutter: &'a [(usize, char, Style)],
    /// Text an input method is composing at the caret. It is drawn in
    /// `EditorStyles::preedit` over what follows the caret and is not in the session until committed.
    pub preedit: Option<&'a str>,
}

/// A stretch of the text and how it is drawn, in Unicode scalars of the text
/// the paint is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub start: usize,
    pub end: usize,
    pub style: Style,
}

#[derive(Clone, Copy, Debug)]
enum By {
    Char,
    Word(usize, usize),
    Line(usize, usize),
}

#[derive(Clone, Copy, Debug)]
struct Drag {
    anchor: usize,
    by: By,
}

/// Where the caret stands, in each unit that leaves the crate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    /// Counted from 1.
    pub line: usize,
    /// Grapheme clusters from the line start, counted from 1: what an arrow
    /// key counts and what the display shows.
    pub column: usize,
    /// Display cells from the line start, counted from 1.
    pub cell: usize,
    /// UTF-16 code units from the line start, counted from 0: the owner's and
    /// the language server's unit.
    pub utf16: usize,
    /// Unicode scalars from the start of the text, counted from 0.
    pub offset: usize,
}

#[derive(Debug, Default)]
pub struct SourceView {
    width: u16,
    height: u16,
    drag: Option<Drag>,
    /// No line-number column at all (a composer, a one-line field).
    no_gutter: bool,
}

impl SourceView {
    pub fn new() -> Self {
        Self::default()
    }

    // ---- geometry ----

    /// Give the view the cells it is drawn in and tell the session, whose soft
    /// wrap and page motions follow the viewport.
    pub fn resize(&mut self, session: &mut EditSession, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        self.sync(session);
    }

    /// Whether the line-number column is drawn (it is, by default). Off, the
    /// text starts at column 0 whatever the line count, and wrapping, `hit`,
    /// `caret_cell`, `draw` and the session's viewport all use the full width.
    /// Call `resize` afterwards so the session's viewport follows.
    pub fn set_gutter(&mut self, on: bool) {
        self.no_gutter = !on;
    }

    pub fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    /// A press is held and the pointer is selecting.
    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// The selected text, or else the word under the caret: what a search
    /// starts from.
    pub fn seed(&self, session: &EditSession) -> Option<String> {
        if let Some(text) = session.selected_text() {
            return Some(text);
        }
        let (s, e) = word_range(session, session.cursor());
        let word = session.rope().slice(s..e).to_string();
        word.chars().any(char::is_alphanumeric).then_some(word)
    }

    /// Width of the line number column, with its trailing space (0 when the
    /// view is too narrow to spare it).
    pub fn gutter(&self, session: &EditSession) -> u16 {
        self.gutter_in(session, self.width)
    }

    fn gutter_in(&self, session: &EditSession, width: u16) -> u16 {
        if self.no_gutter {
            return 0;
        }
        let digits = session.coords().line_count().to_string().len() as u16;
        if width > digits + 1 { digits + 1 } else { 0 }
    }

    fn content_width(&self, session: &EditSession) -> u16 {
        self.width - self.gutter(session)
    }

    fn sync(&self, session: &mut EditSession) {
        let w = self.content_width(session);
        session.set_viewport(usize::from(w), usize::from(self.height));
    }

    fn wrap(&self, session: &EditSession) -> usize {
        if session.config().wrap {
            usize::from(self.content_width(session))
        } else {
            0
        }
    }

    // ---- scrolling ----

    fn top(&self, session: &EditSession) -> (usize, usize) {
        let (wrap, tab) = (self.wrap(session), session.config().tab_width);
        let rope = session.rope();
        let s = session.scroll();
        let line = s.top_line.min(rope.len_lines().saturating_sub(1));
        let rows = line_rows(rope, line, wrap, tab).len();
        (line, s.top_row.min(rows.saturating_sub(1)))
    }

    /// Scroll so the caret row is on screen, moving as little as possible.
    pub fn reveal(&mut self, session: &mut EditSession) {
        let at = session.cursor();
        self.reveal_at(session, at);
    }

    /// Scroll so the row of the scalar offset `at` is on screen, moving as
    /// little as possible. The caret and the selection stay where they are.
    pub fn reveal_at(&mut self, session: &mut EditSession, at: usize) {
        self.sync(session);
        if self.height == 0 {
            return;
        }
        let height = usize::from(self.height);
        let (wrap, tab) = (self.wrap(session), session.config().tab_width);
        let top = self.top(session);
        let at = {
            let rope = session.rope();
            let place = at.min(rope.len_chars());
            let line = Coords::new(rope).line_of(place);
            let rows = line_rows(rope, line, wrap, tab);
            (line, row_index(&rows, place))
        };
        let rope = session.rope();
        let new_top = if at < top {
            at
        } else if rows_between(rope, top, at, wrap, tab, height) >= height {
            rows_back(rope, at, height - 1, wrap, tab)
        } else {
            top
        };
        session.set_scroll(Scroll {
            top_line: new_top.0,
            top_row: new_top.1,
            left_cell: 0,
        });
    }

    /// Scroll by whole rows without moving the caret. Positive is down.
    pub fn scroll_by(&mut self, session: &mut EditSession, rows: i32) {
        self.sync(session);
        let (wrap, tab) = (self.wrap(session), session.config().tab_width);
        let top = self.top(session);
        let rope = session.rope();
        let n = rows.unsigned_abs() as usize;
        let to = if rows >= 0 {
            advance(rope, top, n, wrap, tab)
        } else {
            rows_back(rope, top, n, wrap, tab)
        };
        session.set_scroll(Scroll {
            top_line: to.0,
            top_row: to.1,
            left_cell: 0,
        });
    }

    // ---- position ----

    /// The caret in every unit that leaves the crate.
    pub fn position(&self, session: &EditSession) -> Position {
        let coords = session.coords();
        let at = session.cursor();
        let line = coords.line_of(at);
        let (start, _) = coords.line_range(line).unwrap_or((0, 0));
        let tab = session.config().tab_width;
        let utf16 = coords
            .line_col(at, theorem_workbench_text::Unit::Utf16)
            .map_or(0, |p| p.col);
        Position {
            line: line + 1,
            column: coords.grapheme_index(at) - coords.grapheme_index(start) + 1,
            cell: coords.cells_between(start, at, tab) + 1,
            utf16,
            offset: at,
        }
    }

    // ---- input ----

    /// A key. Keys the widget does not use come back with `handled` false.
    pub fn key(&mut self, session: &mut EditSession, input: &KeyInput) -> Reaction {
        self.sync(session);
        let mods = input.mods();
        let command = mods.intersects(Mods::CTRL | Mods::CMD);
        let word = mods.intersects(Mods::ALT | Mods::CTRL);
        let line = mods.contains(Mods::CMD);
        let extend = mods.contains(Mods::SHIFT);
        let mut r = Reaction::handled();
        match input.key() {
            Key::Char(c) if command => match c.to_ascii_lowercase() {
                'a' => {
                    session.select_all();
                    r.moved = true;
                }
                'c' => r.clipboard = Some(Clipboard::Copy),
                'x' => r.clipboard = Some(Clipboard::Cut),
                'v' => r.clipboard = Some(Clipboard::Paste),
                'z' if c == 'Z' || extend => self.edit(session, |s| s.redo(), &mut r),
                'z' => self.edit(session, |s| s.undo(), &mut r),
                'y' => self.edit(session, |s| s.redo(), &mut r),
                _ => r.handled = false,
            },
            Key::Char(c) => {
                let mut buf = [0u8; 4];
                self.edit(session, |s| s.insert_text(c.encode_utf8(&mut buf)), &mut r);
            }
            Key::Enter => self.edit(session, |s| s.insert_newline(), &mut r),
            Key::Tab if !extend => self.edit(session, |s| s.insert_text("\t"), &mut r),
            Key::Backspace => {
                let d = if line {
                    Deletion::ToLineStart
                } else if word {
                    Deletion::WordBackward
                } else {
                    Deletion::Backward
                };
                self.edit(session, |s| s.delete(d), &mut r);
            }
            Key::Delete => {
                let d = if line {
                    Deletion::ToLineEnd
                } else if word {
                    Deletion::WordForward
                } else {
                    Deletion::Forward
                };
                self.edit(session, |s| s.delete(d), &mut r);
            }
            Key::Left | Key::Right | Key::Up | Key::Down | Key::Home | Key::End => {
                let motion = match input.key() {
                    Key::Left if line => Motion::LineStart,
                    Key::Left if word => Motion::WordLeft,
                    Key::Left => Motion::Left,
                    Key::Right if line => Motion::LineEnd,
                    Key::Right if word => Motion::WordRight,
                    Key::Right => Motion::Right,
                    Key::Up if line => Motion::DocStart,
                    Key::Up => Motion::Up,
                    Key::Down if line => Motion::DocEnd,
                    Key::Down => Motion::Down,
                    Key::Home if command => Motion::DocStart,
                    Key::Home => Motion::LineStart,
                    Key::End if command => Motion::DocEnd,
                    _ => Motion::LineEnd,
                };
                self.go(session, motion, extend, &mut r);
            }
            Key::PageUp => self.go(session, Motion::PageUp, extend, &mut r),
            Key::PageDown => self.go(session, Motion::PageDown, extend, &mut r),
            Key::Copy => r.clipboard = Some(Clipboard::Copy),
            Key::Cut => r.clipboard = Some(Clipboard::Cut),
            Key::Paste => r.clipboard = Some(Clipboard::Paste),
            Key::Undo => self.edit(session, |s| s.undo(), &mut r),
            Key::Redo => self.edit(session, |s| s.redo(), &mut r),
            _ => r.handled = false,
        }
        r
    }

    /// Text from the host's input service (committed IME text, dictation).
    pub fn text(&mut self, session: &mut EditSession, text: &str) -> Reaction {
        self.sync(session);
        let mut r = Reaction::handled();
        self.edit(session, |s| s.insert_text(text), &mut r);
        r
    }

    /// Pasted text, line breaks made the document's own.
    pub fn paste(&mut self, session: &mut EditSession, text: &str) -> Reaction {
        self.sync(session);
        let mut r = Reaction::handled();
        let options = PasteOptions {
            max_bytes: PASTE_LIMIT,
            newlines: Newlines::ToDocument,
        };
        self.edit(session, |s| s.paste(text, &options), &mut r);
        r
    }

    fn edit(
        &mut self,
        session: &mut EditSession,
        f: impl FnOnce(&mut EditSession) -> Result<Option<theorem_workbench_text::LocalEdit>, EditError>,
        r: &mut Reaction,
    ) {
        match f(session) {
            Ok(Some(_)) => {
                r.edited = true;
                r.moved = true;
                self.reveal(session);
            }
            Ok(None) => {}
            Err(e) => r.error = Some(e),
        }
    }

    fn go(&mut self, session: &mut EditSession, motion: Motion, extend: bool, r: &mut Reaction) {
        r.moved = session.move_cursor(motion, extend);
        self.reveal(session);
    }

    // ---- pointer ----

    /// A pointer event with `x` and `y` in cells from the view's top left.
    pub fn pointer(&mut self, session: &mut EditSession, p: PanelPointer) -> Reaction {
        use theorem_workbench_core::Button;
        self.sync(session);
        let mut r = Reaction::default();
        match p.kind {
            PointerKind::Down(Button::Left) => {
                r.handled = true;
                let at = self.hit(session, p.x, p.y);
                let extend = p.mods.contains(Mods::SHIFT) && p.clicks <= 1;
                let (anchor, by) = match p.clicks {
                    0 | 1 => {
                        let anchor = if extend { session.anchor() } else { at };
                        session.set_selection(anchor, at);
                        (anchor, By::Char)
                    }
                    2 => {
                        let (s, e) = word_range(session, at);
                        session.set_selection(s, e);
                        (s, By::Word(s, e))
                    }
                    _ => {
                        let (s, e) = line_span(session, at);
                        session.set_selection(s, e);
                        (s, By::Line(s, e))
                    }
                };
                self.drag = Some(Drag { anchor, by });
                r.moved = true;
                self.reveal(session);
            }
            PointerKind::Move => {
                let Some(drag) = self.drag else {
                    return r;
                };
                r.handled = true;
                // Past an edge the view scrolls a row for every event, so a
                // held pointer walks the text.
                let y = if p.y < 0 {
                    self.scroll_by(session, -1);
                    0
                } else if p.y >= i32::from(self.height) {
                    self.scroll_by(session, 1);
                    i32::from(self.height) - 1
                } else {
                    p.y
                };
                let at = self.hit(session, p.x, y);
                let (anchor, head) = match drag.by {
                    By::Char => (drag.anchor, at),
                    By::Word(a, b) => {
                        let (s, e) = word_range(session, at);
                        if at < a { (b, s) } else { (a, e) }
                    }
                    By::Line(a, b) => {
                        let (s, e) = line_span(session, at);
                        if at < a { (b, s) } else { (a, e) }
                    }
                };
                session.set_selection(anchor, head);
                r.moved = true;
            }
            PointerKind::Up(Button::Left) => {
                r.handled = self.drag.take().is_some();
            }
            PointerKind::Wheel { dy, .. } => {
                r.handled = true;
                self.scroll_by(session, i32::from(dy));
            }
            PointerKind::Down(_) | PointerKind::Up(_) => {}
        }
        r
    }

    /// The scalar offset under the cell (`x`, `y`) of the view.
    pub fn hit(&self, session: &EditSession, x: i32, y: i32) -> usize {
        let (wrap, tab) = (self.wrap(session), session.config().tab_width);
        let rope = session.rope();
        let top = self.top(session);
        let at = advance(rope, top, y.max(0) as usize, wrap, tab);
        let rows = line_rows(rope, at.0, wrap, tab);
        let row = rows[at.1.min(rows.len() - 1)];
        let cell = (x - i32::from(self.gutter(session))).max(0) as usize;
        let coords = Coords::new(rope);
        let found = coords.offset_at_cell(row.start, row.end, cell, tab, Snap::Nearest);
        // The end of a row that wraps is the start of the next one; a click
        // past the text stays on this row.
        if !row.last && found >= row.end {
            coords.prev_grapheme(row.end).max(row.start)
        } else {
            found
        }
    }

    // ---- drawing ----

    /// The caret as a cell of `area`, when its row is on screen.
    pub fn caret_cell(&self, session: &EditSession, area: Rect) -> Option<Caret> {
        let mut caret = None;
        self.paint(session, area, None, &Paint::none(), &mut caret);
        caret
    }

    /// Draw the text into `area`. The caret cell comes back so the host can
    /// place its own caret and its hidden input there.
    pub fn draw(
        &self,
        session: &EditSession,
        area: Rect,
        buf: &mut Buffer,
        paint: &Paint,
    ) -> Option<Caret> {
        let mut caret = None;
        self.paint(session, area, Some(buf), paint, &mut caret);
        caret
    }

    fn paint(
        &self,
        session: &EditSession,
        area: Rect,
        mut buf: Option<&mut Buffer>,
        paint: &Paint,
        caret_out: &mut Option<Caret>,
    ) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let rope = session.rope();
        let coords = Coords::new(rope);
        let tab = session.config().tab_width;
        let gutter = self.gutter_in(session, area.width);
        let content = Rect {
            x: area.x + gutter,
            y: area.y,
            width: area.width - gutter,
            height: area.height,
        };
        let wrap = if session.config().wrap {
            usize::from(content.width)
        } else {
            0
        };
        let styles = paint.styles;
        if let Some(buf) = buf.as_deref_mut() {
            buf.set_style(area, styles.text);
        }

        let caret_at = session.cursor();
        let caret_line = coords.line_of(caret_at);
        let selection = session.selection();
        let conflicts: Vec<(usize, usize)> =
            session.conflict().map(|c| c.ranges).unwrap_or_default();
        let atomics: Vec<(usize, usize)> =
            session.atomics().iter().map(|a| (a.start, a.end)).collect();
        let height = usize::from(content.height);
        let top = {
            let s = session.scroll();
            let line = s.top_line.min(coords.line_count() - 1);
            let rows = line_rows(rope, line, wrap, tab).len();
            (line, s.top_row.min(rows - 1))
        };

        let (mut line, mut skip, mut y) = (top.0, top.1, 0usize);
        'lines: while line < coords.line_count() && y < height {
            let rows: Vec<Row> = line_rows(rope, line, wrap, tab);
            let caret_row = (line == caret_line).then(|| row_index(&rows, caret_at));
            for row in rows.into_iter().skip(skip) {
                if y >= height {
                    break 'lines;
                }
                let py = content.y + y as u16;
                let on_caret_row = caret_row == Some(row.index);
                if let Some(buf) = buf.as_deref_mut() {
                    if gutter > 0 {
                        let (label, style) = if row.index == 0 {
                            let style = if line == caret_line {
                                styles.gutter_current
                            } else {
                                styles.gutter
                            };
                            (
                                format!("{:>w$} ", line + 1, w = usize::from(gutter - 1)),
                                style,
                            )
                        } else {
                            (" ".repeat(usize::from(gutter)), styles.gutter)
                        };
                        buf.set_string(area.x, py, label, styles.gutter.patch(style));
                        // The last cell of the column is blank; a finding on
                        // the line takes it.
                        if row.index == 0
                            && let Some(&(_, glyph, mark)) =
                                paint.gutter.iter().find(|g| g.0 == line)
                        {
                            buf.set_string(
                                area.x + gutter - 1,
                                py,
                                glyph.to_string(),
                                styles.gutter.patch(mark),
                            );
                        }
                    }
                    if line == caret_line && selection.is_none() {
                        buf.set_style(
                            Rect::new(content.x, py, content.width, 1),
                            styles.current_line,
                        );
                    }
                }
                let mut cell = 0usize;
                coords.for_each_cluster(row.start, row.end, |at, g| {
                    let w = grapheme_cells(g, cell, tab);
                    if cell >= usize::from(content.width) {
                        return false;
                    }
                    if let Some(buf) = buf.as_deref_mut()
                        && w > 0
                        && cell + w <= usize::from(content.width)
                    {
                        let style = style_at(paint, &conflicts, &atomics, selection, at);
                        let px = content.x + cell as u16;
                        if g.starts_with('\t') {
                            buf.set_stringn(px, py, " ".repeat(w), w, style);
                        } else if let Some(glyph) = stand_in(g) {
                            let selected = selection.is_some_and(|(s, e)| at >= s && at < e);
                            let style = if selected {
                                style
                            } else {
                                style.patch(styles.gutter)
                            };
                            buf.set_stringn(px, py, glyph.to_string(), w, style);
                        } else {
                            buf.set_stringn(px, py, g, w, style);
                        }
                    }
                    cell += w;
                    true
                });
                if let Some(buf) = buf.as_deref_mut() {
                    // A selection that runs over the line break shows one
                    // selected cell after the text.
                    if row.last
                        && row.end < rope.len_chars()
                        && selection.is_some_and(|(s, e)| s <= row.end && e > row.end)
                        && cell < usize::from(content.width)
                    {
                        buf.set_stringn(
                            content.x + cell as u16,
                            py,
                            " ",
                            1,
                            styles.text.patch(styles.selection),
                        );
                    }
                }
                if on_caret_row {
                    let at_cell = coords.cells_between(row.start, caret_at, tab);
                    let width = caret_width(&coords, caret_at, row.end, at_cell, tab);
                    if at_cell < usize::from(content.width) {
                        let x = content.x + at_cell as u16;
                        let width = (width as u16).min(content.width - at_cell as u16).max(1);
                        *caret_out = Some(Caret { x, y: py, width });
                        if let Some(buf) = buf.as_deref_mut() {
                            match paint.preedit.filter(|p| !p.is_empty()) {
                                Some(pre) => {
                                    let room = usize::from(content.width) - at_cell;
                                    let (end, _) = buf.set_stringn(
                                        x,
                                        py,
                                        pre,
                                        room,
                                        styles.text.patch(styles.preedit),
                                    );
                                    // The caret follows the composed text.
                                    if paint.focused && end < content.x + content.width {
                                        buf.set_style(Rect::new(end, py, 1, 1), styles.caret);
                                    }
                                }
                                None if paint.focused => {
                                    buf.set_style(Rect::new(x, py, width, 1), styles.caret);
                                }
                                None => {}
                            }
                        }
                    }
                }
                y += 1;
            }
            skip = 0;
            line += 1;
        }
    }
}

impl<'a> Paint<'a> {
    /// Text only: not focused, with nothing marked.
    pub fn new(styles: &'a EditorStyles) -> Self {
        Self {
            styles,
            focused: false,
            matches: &[],
            current: None,
            tokens: &[],
            marks: &[],
            gutter: &[],
            preedit: None,
        }
    }

    /// A paint that draws nothing visible, to find the caret.
    fn none() -> Paint<'static> {
        static PLAIN: std::sync::OnceLock<EditorStyles> = std::sync::OnceLock::new();
        Paint::new(PLAIN.get_or_init(EditorStyles::plain))
    }
}

fn style_at(
    paint: &Paint,
    conflicts: &[(usize, usize)],
    atomics: &[(usize, usize)],
    selection: Option<(usize, usize)>,
    at: usize,
) -> Style {
    let s = paint.styles;
    let mut style = s.text;
    let t = paint.tokens.partition_point(|m| m.end <= at);
    if let Some(m) = paint.tokens.get(t)
        && m.start <= at
    {
        style = style.patch(m.style);
    }
    let found = paint.matches.partition_point(|&(_, end)| end <= at);
    if let Some(&(start, _)) = paint.matches.get(found)
        && start <= at
    {
        style = style.patch(if paint.current == Some(found) {
            s.current_match
        } else {
            s.search_match
        });
    }
    for m in paint.marks {
        if at >= m.start && at < m.end {
            style = style.patch(m.style);
        }
    }
    if atomics.iter().any(|&(a, b)| at >= a && at < b) {
        style = style.patch(s.atomic);
    }
    if conflicts.iter().any(|&(a, b)| at >= a && at < b) {
        style = style.patch(s.conflict);
    }
    if selection.is_some_and(|(a, b)| at >= a && at < b) {
        style = style.patch(s.selection);
    }
    style
}

fn caret_width(coords: &Coords, caret: usize, row_end: usize, at_cell: usize, tab: usize) -> usize {
    if caret >= row_end {
        return 1;
    }
    let next = coords.next_grapheme(caret).min(row_end);
    let mut w = 1;
    coords.for_each_cluster(caret, next, |_, g| {
        w = grapheme_cells(g, at_cell, tab).max(1);
        false
    });
    w
}

/// The row `n` rows below `at`, or the last row of the text.
fn advance(
    rope: &ropey::Rope,
    mut at: (usize, usize),
    mut n: usize,
    wrap: usize,
    tab: usize,
) -> (usize, usize) {
    let lines = rope.len_lines();
    while n > 0 {
        let rows = line_rows(rope, at.0, wrap, tab).len();
        if at.1 + 1 < rows {
            at.1 += 1;
        } else if at.0 + 1 < lines {
            at = (at.0 + 1, 0);
        } else {
            break;
        }
        n -= 1;
    }
    at
}

/// Rows from `from` up to (not including) `to`, counting no further than `limit`.
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

/// The row `count` rows above `at`, or the start of the text.
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

/// The word, or the run of spaces, or the symbol, around `at`, as scalars.
fn word_range(session: &EditSession, at: usize) -> (usize, usize) {
    let coords = session.coords();
    let line = coords.line_of(at);
    let (start, end) = coords.line_range(line).unwrap_or((0, 0));
    if start == end {
        return (start, start);
    }
    let text = session.rope().slice(start..end).to_string();
    let rel = at.min(end) - start;
    let (mut pos, mut last) = (0usize, (0usize, 0usize));
    for segment in text.split_word_bounds() {
        let n = segment.chars().count();
        last = (pos, pos + n);
        if rel < pos + n {
            break;
        }
        pos += n;
    }
    (start + last.0, start + last.1)
}

/// The line holding `at`, with its terminator.
fn line_span(session: &EditSession, at: usize) -> (usize, usize) {
    let rope = session.rope();
    let line = Coords::new(rope).line_of(at);
    let start = rope.line_to_char(line);
    let end = if line + 1 < rope.len_lines() {
        rope.line_to_char(line + 1)
    } else {
        rope.len_chars()
    };
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use theorem_workbench_core::Button;
    use theorem_workbench_text::SessionConfig;
    use unicode_width::UnicodeWidthStr;

    fn view(text: &str, width: u16, height: u16) -> (EditSession, SourceView) {
        let mut session = EditSession::new(text, 1, SessionConfig::new("t"));
        let mut view = SourceView::new();
        view.resize(&mut session, width, height);
        (session, view)
    }

    fn key(view: &mut SourceView, s: &mut EditSession, key: Key, mods: Mods) -> Reaction {
        view.key(s, &KeyInput::new(key, mods))
    }

    fn rows(s: &EditSession, v: &SourceView, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let styles = EditorStyles::plain();
        let paint = Paint::new(&styles);
        v.draw(s, area, &mut buf, &paint);
        (0..height)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < width {
                    let symbol = buf[(x, y)].symbol();
                    row.push_str(symbol);
                    x += (symbol.width() as u16).max(1);
                }
                row.trim_end().to_owned()
            })
            .collect()
    }

    fn mouse(kind: PointerKind, x: i32, y: i32, clicks: u8) -> PanelPointer {
        PanelPointer {
            kind,
            x,
            y,
            mods: Mods::NONE,
            clicks,
        }
    }

    #[test]
    fn a_tab_is_drawn_to_the_next_stop_and_the_caret_counts_its_cells() {
        let (mut s, mut v) = view("a\tb\n", 20, 5);
        let tab = s.config().tab_width;
        assert_eq!(
            rows(&s, &v, 20, 1)[0],
            format!("1 a{}b", " ".repeat(tab - 1))
        );
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        let at = v.position(&s);
        assert_eq!(at.column, 3, "a, tab, then the caret");
        assert_eq!(at.cell, tab + 1, "the tab filled to the stop");
        assert_eq!(at.offset, 2);
    }

    #[test]
    fn wide_characters_take_two_cells_and_the_caret_moves_one_character_at_a_time() {
        let (mut s, mut v) = view("\u{65e5}\u{672c}\u{8a9e}x\n", 20, 5);
        assert_eq!(rows(&s, &v, 20, 1)[0], "1 \u{65e5}\u{672c}\u{8a9e}x");
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        let at = v.position(&s);
        assert_eq!((at.column, at.cell, at.utf16), (2, 3, 1));
        // A click on the second cell of a wide character lands on one side or
        // the other of it, never inside.
        v.pointer(&mut s, mouse(PointerKind::Down(Button::Left), 2 + 3, 0, 1));
        assert!(matches!(s.cursor(), 1 | 2), "{}", s.cursor());
    }

    #[test]
    fn a_combining_mark_stays_with_its_letter_for_motion_and_deletion() {
        let (mut s, mut v) = view("e\u{301}x\n", 20, 5);
        assert_eq!(rows(&s, &v, 20, 1)[0], "1 e\u{301}x");
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        assert_eq!(s.cursor(), 2, "one step over the letter and its accent");
        assert_eq!(v.position(&s).column, 2);
        let r = key(&mut v, &mut s, Key::Backspace, Mods::NONE);
        assert!(r.edited);
        assert_eq!(s.text(), "x\n");
    }

    #[test]
    fn a_zero_width_joiner_sequence_is_one_cluster() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let (mut s, mut v) = view(&format!("{family}x\n"), 20, 5);
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        assert_eq!(s.cursor(), 5, "all five scalars in one step");
        let at = v.position(&s);
        assert_eq!((at.column, at.cell), (2, 3));
        key(&mut v, &mut s, Key::Home, Mods::NONE);
        let r = key(&mut v, &mut s, Key::Delete, Mods::NONE);
        assert!(r.edited);
        assert_eq!(s.text(), "x\n");
    }

    #[test]
    fn a_crlf_line_break_is_one_step_and_is_never_drawn() {
        let (mut s, mut v) = view("ab\r\ncd\r\n", 20, 5);
        let r = rows(&s, &v, 20, 3);
        assert_eq!((r[0].as_str(), r[1].as_str()), ("1 ab", "2 cd"));
        key(&mut v, &mut s, Key::End, Mods::NONE);
        assert_eq!(s.cursor(), 2, "before the break");
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        assert_eq!(s.cursor(), 4, "over both characters of the break at once");
        assert_eq!(v.position(&s).line, 2);
    }

    #[test]
    fn a_long_line_wraps_and_the_caret_walks_down_its_rows() {
        let (mut s, mut v) = view("abcdefghij\nz\n", 8, 6);
        // Width 8 less the two-cell gutter leaves six cells a row.
        let r = rows(&s, &v, 8, 3);
        assert_eq!(r[0], "1 abcdef");
        assert_eq!(r[1], "  ghij");
        assert_eq!(r[2], "2 z");
        key(&mut v, &mut s, Key::Right, Mods::NONE);
        key(&mut v, &mut s, Key::Down, Mods::NONE);
        assert_eq!(s.cursor(), 7, "the same column on the wrapped row");
        assert_eq!(v.position(&s).line, 1, "still the first line");
    }

    #[test]
    fn shift_with_motion_selects_and_the_selection_is_drawn_reversed() {
        let (mut s, mut v) = view("hello\n", 20, 3);
        for _ in 0..3 {
            key(&mut v, &mut s, Key::Right, Mods::SHIFT);
        }
        assert_eq!(s.selection(), Some((0, 3)));
        let area = Rect::new(0, 0, 20, 3);
        let mut buf = Buffer::empty(area);
        let styles = EditorStyles::plain();
        let paint = Paint::new(&styles);
        v.draw(&s, area, &mut buf, &paint);
        let reversed: Vec<bool> = (2..7)
            .map(|x| buf[(x, 0)].modifier.contains(Modifier::REVERSED))
            .collect();
        assert_eq!(reversed, vec![true, true, true, false, false]);
    }

    #[test]
    fn control_and_hidden_characters_draw_as_stand_ins_and_the_caret_walks_over_them() {
        let text = "a\u{7}\u{1b}\u{0}\u{202e}b\n";
        let (mut s, mut v) = view(text, 20, 3);
        let area = Rect::new(0, 0, 20, 3);
        let draw = |s: &EditSession, v: &SourceView| {
            let mut buf = Buffer::empty(area);
            let styles = EditorStyles::plain();
            let caret = v.draw(s, area, &mut buf, &Paint::new(&styles));
            (buf, caret)
        };
        let (buf, _) = draw(&s, &v);
        let row: String = (2..9).map(|x| buf[(x, 0)].symbol()).collect();
        assert_eq!(row, "a\u{2407}\u{241b}\u{2400}\u{25af}b ");
        assert!(buf[(3, 0)].modifier.contains(Modifier::DIM), "muted");
        assert!(!buf[(2, 0)].modifier.contains(Modifier::DIM));
        key(&mut v, &mut s, Key::Home, Mods::CTRL);
        for step in 0..=5u16 {
            let (_, caret) = draw(&s, &v);
            let caret = caret.expect("the caret is on screen");
            assert_eq!((caret.x, caret.width), (2 + step, 1), "step {step}");
            key(&mut v, &mut s, Key::Right, Mods::NONE);
        }
        assert_eq!(s.text(), text, "the text is not changed");
    }

    use ratatui::style::Modifier;

    #[test]
    fn select_all_and_word_and_line_motion() {
        let (mut s, mut v) = view("one two\nthree\n", 20, 5);
        key(&mut v, &mut s, Key::Char('a'), Mods::CTRL);
        assert_eq!(s.selection(), Some((0, 14)));
        key(&mut v, &mut s, Key::Home, Mods::CTRL);
        key(&mut v, &mut s, Key::Right, Mods::ALT);
        assert_eq!(s.cursor(), 3, "to the end of the word");
        key(&mut v, &mut s, Key::End, Mods::NONE);
        assert_eq!(s.cursor(), 7);
        key(&mut v, &mut s, Key::End, Mods::CTRL);
        assert_eq!(s.cursor(), 14, "document end");
        key(&mut v, &mut s, Key::Home, Mods::CTRL);
        assert_eq!(s.cursor(), 0, "document start");
    }

    #[test]
    fn page_keys_move_by_the_height_of_the_view() {
        let text: String = (0..50).map(|n| format!("line {n}\n")).collect();
        let (mut s, mut v) = view(&text, 20, 10);
        key(&mut v, &mut s, Key::PageDown, Mods::NONE);
        let after = v.position(&s).line;
        assert!(after >= 8, "moved about a page, not {after}");
        key(&mut v, &mut s, Key::PageUp, Mods::NONE);
        assert!(v.position(&s).line <= 2);
    }

    #[test]
    fn enter_tab_backspace_and_delete_edit_multiline_text() {
        let (mut s, mut v) = view("", 20, 5);
        for c in "ab".chars() {
            key(&mut v, &mut s, Key::Char(c), Mods::NONE);
        }
        key(&mut v, &mut s, Key::Enter, Mods::NONE);
        key(&mut v, &mut s, Key::Tab, Mods::NONE);
        key(&mut v, &mut s, Key::Char('c'), Mods::NONE);
        assert_eq!(s.text(), "ab\n\tc");
        key(&mut v, &mut s, Key::Left, Mods::NONE);
        key(&mut v, &mut s, Key::Backspace, Mods::NONE);
        assert_eq!(s.text(), "ab\nc");
        key(&mut v, &mut s, Key::Delete, Mods::NONE);
        assert_eq!(s.text(), "ab\n");
    }

    #[test]
    fn unicode_text_from_the_host_is_inserted_whole() {
        let (mut s, mut v) = view("", 20, 5);
        let r = v.text(&mut s, "na\u{ef}ve \u{1F600}");
        assert!(r.edited);
        assert_eq!(s.text(), "na\u{ef}ve \u{1F600}");
    }

    #[test]
    fn a_double_click_selects_the_word_and_a_triple_click_the_line() {
        let (mut s, mut v) = view("hello world\nnext\n", 20, 5);
        v.pointer(&mut s, mouse(PointerKind::Down(Button::Left), 2 + 8, 0, 2));
        assert_eq!(s.selection(), Some((6, 11)));
        v.pointer(&mut s, mouse(PointerKind::Up(Button::Left), 2 + 8, 0, 1));
        v.pointer(&mut s, mouse(PointerKind::Down(Button::Left), 2 + 8, 0, 3));
        assert_eq!(s.selection(), Some((0, 12)), "the line and its break");
    }

    #[test]
    fn a_drag_selects_from_the_press_to_the_pointer_and_stops_at_the_release() {
        let (mut s, mut v) = view("hello world\n", 20, 5);
        v.pointer(&mut s, mouse(PointerKind::Down(Button::Left), 2 + 1, 0, 1));
        assert!(v.dragging());
        v.pointer(&mut s, mouse(PointerKind::Move, 2 + 4, 0, 1));
        assert_eq!(s.selection(), Some((1, 4)));
        v.pointer(&mut s, mouse(PointerKind::Up(Button::Left), 2 + 4, 0, 1));
        assert!(!v.dragging());
        v.pointer(&mut s, mouse(PointerKind::Move, 2 + 9, 0, 1));
        assert_eq!(
            s.selection(),
            Some((1, 4)),
            "a move with no press is nobody's"
        );
    }

    #[test]
    fn the_wheel_scrolls_the_view_and_leaves_the_caret_where_it_was() {
        let text: String = (0..40).map(|n| format!("line {n}\n")).collect();
        let (mut s, mut v) = view(&text, 20, 5);
        v.pointer(&mut s, mouse(PointerKind::Wheel { dx: 0, dy: 4 }, 3, 2, 1));
        assert_eq!(s.scroll().top_line, 4);
        assert_eq!(s.cursor(), 0);
        v.pointer(&mut s, mouse(PointerKind::Wheel { dx: 0, dy: -9 }, 3, 2, 1));
        assert_eq!(s.scroll().top_line, 0, "no further than the start");
    }

    #[test]
    fn typing_reveals_the_caret_and_a_read_only_session_refuses_with_its_error() {
        let text: String = (0..40).map(|n| format!("line {n}\n")).collect();
        let (mut s, mut v) = view(&text, 20, 5);
        key(&mut v, &mut s, Key::End, Mods::CTRL);
        assert!(s.scroll().top_line >= 35, "{:?}", s.scroll());
        s.set_read_only(true);
        let r = key(&mut v, &mut s, Key::Char('x'), Mods::NONE);
        assert_eq!(r.error, Some(EditError::ReadOnly));
        assert!(!r.edited);
    }

    #[test]
    fn the_clipboard_keys_ask_for_the_clipboard_and_never_keep_a_buffer() {
        let (mut s, mut v) = view("hello\n", 20, 5);
        assert_eq!(
            key(&mut v, &mut s, Key::Char('c'), Mods::CTRL).clipboard,
            Some(Clipboard::Copy)
        );
        assert_eq!(
            key(&mut v, &mut s, Key::Char('x'), Mods::CTRL).clipboard,
            Some(Clipboard::Cut)
        );
        assert_eq!(
            key(&mut v, &mut s, Key::Char('v'), Mods::CTRL).clipboard,
            Some(Clipboard::Paste)
        );
        assert_eq!(s.text(), "hello\n", "asking changes nothing");
    }

    #[test]
    fn with_the_gutter_off_the_text_starts_at_column_zero_across_a_digit_change() {
        let nine = "a\nb\nc\nd\ne\nf\ng\nh\ni";
        let (mut s, mut v) = view(nine, 12, 20);
        v.set_gutter(false);
        v.resize(&mut s, 12, 20);
        assert_eq!(v.gutter(&s), 0);
        assert_eq!(rows(&s, &v, 12, 3)[0], "a");
        assert_eq!(v.hit(&s, 0, 0), 0);
        // A tenth line takes the numbered view from two columns to three; with
        // the gutter off nothing moves.
        s.set_selection(s.len(), s.len());
        s.insert_text("\nj").unwrap();
        v.resize(&mut s, 12, 20);
        assert_eq!(v.gutter(&s), 0);
        assert_eq!(rows(&s, &v, 12, 10)[9], "j");
        assert_eq!(v.hit(&s, 0, 9), s.len() - 1);
        assert_eq!(v.hit(&s, 1, 9), s.len());
        let c = v.caret_cell(&s, Rect::new(0, 0, 12, 20)).unwrap();
        assert_eq!((c.x, c.y), (1, 9));
        // On, the same view reserves the column again.
        v.set_gutter(true);
        assert_eq!(v.gutter(&s), 3);
    }

    #[test]
    fn with_the_gutter_off_wrapping_uses_the_full_width() {
        let mut cfg = SessionConfig::new("t");
        cfg.wrap = true;
        let mut s = EditSession::new("abcdefgh", 1, cfg);
        let mut v = SourceView::new();
        v.set_gutter(false);
        v.resize(&mut s, 8, 4);
        assert_eq!(rows(&s, &v, 8, 2)[0], "abcdefgh");
        assert_eq!(s.viewport().0, 8);
    }
}
