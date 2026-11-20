//! The text field: the value a Search box, a commit subject, a rename row or a find bar edits,
//! and, built with [`Field::multiline`], a commit description.
//!
//! A field is a value, a caret and an anchor, all counted in Unicode scalars. Every edit, motion
//! and selection is the [`EditSession`]'s: a field makes a one-line session over its value for
//! the length of one key, applies the key the way the composer's own keys do, and keeps what the
//! session ended with. So carets and deletions move by grapheme cluster, words end where the
//! composer's words end, the selection is the session's, and a field is a plain `Clone + Debug`
//! value that a panel can hold and draw from `&self`.
//!
//! Drawing is [`render`], on a throwaway session over the same value, so a control or hidden
//! character is one stand-in cell exactly as in the composer, the selection takes the theme's
//! selection style, and the field scrolls horizontally to keep the caret in view.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;

use crate::coords::Snap;
use crate::render::{EditorStyles, RenderOptions, render};
use crate::session::{Deletion, EditSession, Motion, SessionConfig};

/// Columns a tab advances to. A one-line field has no tab key; this is the width the session
/// measures a tab pasted into a value with.
const TAB: usize = 4;

/// The styles a field is drawn with.
#[derive(Clone, Copy, Debug)]
pub struct FieldStyles {
    pub text: Style,
    /// The theme's selection style: the one the composer draws its selection with.
    pub selection: Style,
    /// Over the caret's cells while the field is focused.
    pub caret: Style,
    /// The placeholder, and the stand-in for a control or hidden character.
    pub hint: Style,
}

/// What a key did to a field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keyed {
    /// The key is not the field's.
    Ignored,
    /// The field used it: the text, the caret or the selection may have changed.
    Handled,
    /// Copy the selection. Only asked for while something is selected.
    Copy,
    /// Copy the selection, then take it out ([`Field::delete_selection`]) once the clipboard
    /// has it. Only asked for while something is selected.
    Cut,
    /// Read the clipboard and [`Field::insert`] what it holds.
    Paste,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Field {
    text: String,
    /// Scalar offsets into `text`; `head` is the caret.
    anchor: usize,
    head: usize,
    /// The value is several lines: Enter breaks a line, Up and Down move between lines, and
    /// pasted line breaks stay. A field made with [`Field::new`] is one line.
    multiline: bool,
}

impl Field {
    /// A field holding `value`, the caret at its end.
    pub fn new(value: &str) -> Self {
        let end = value.chars().count();
        Self {
            text: value.to_owned(),
            anchor: end,
            head: end,
            multiline: false,
        }
    }

    /// A field holding `value` as lines, the caret at its end. It is the same value and the
    /// same session as a one-line field; only Enter, Up, Down and line breaks in inserted text
    /// differ. The site draws its rows itself, from [`line_count`](Self::line_count),
    /// [`cursor_line`](Self::cursor_line), [`cursor_cells`](Self::cursor_cells) and
    /// [`selection_cells`](Self::selection_cells).
    pub fn multiline(value: &str) -> Self {
        Self {
            multiline: true,
            ..Self::new(value)
        }
    }

    pub fn value(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// The caret, in Unicode scalars from the start of the value.
    pub fn cursor(&self) -> usize {
        self.head
    }

    /// The other end of the selection; the caret's own offset when nothing is selected.
    pub fn anchor(&self) -> usize {
        self.anchor
    }

    /// The selected range, start before end.
    pub fn selection(&self) -> Option<(usize, usize)> {
        (self.anchor != self.head).then(|| (self.anchor.min(self.head), self.anchor.max(self.head)))
    }

    pub fn selected_text(&self) -> Option<String> {
        let (s, e) = self.selection()?;
        Some(self.text.chars().skip(s).take(e - s).collect())
    }

    /// Puts the caret at scalar offset `at` (clamped to the value, snapped to a cluster) and
    /// drops the selection.
    pub fn set_cursor(&mut self, at: usize) {
        self.edit(|s| s.set_selection(at, at));
    }

    pub fn select_all(&mut self) {
        self.edit(EditSession::select_all);
    }

    /// Display cells from the start of the line holding scalar offset `at` (the whole value for
    /// a one-line field) to `at`: the column a caret or a selection edge is drawn in before any
    /// scrolling.
    pub fn cells_at(&self, at: usize) -> usize {
        let session = self.session();
        let coords = session.coords();
        coords.cells_between(self.line_start(&coords, at), at, TAB)
    }

    /// The number of lines: always 1 for a one-line field, and a trailing break starts another.
    pub fn line_count(&self) -> usize {
        if self.multiline {
            self.session().coords().line_count()
        } else {
            1
        }
    }

    /// The line the caret is on.
    pub fn cursor_line(&self) -> usize {
        if self.multiline {
            self.session().coords().line_of(self.head)
        } else {
            0
        }
    }

    /// The line holding scalar offset `at`.
    pub fn line_of(&self, at: usize) -> usize {
        if self.multiline {
            self.session().coords().line_of(at)
        } else {
            0
        }
    }

    /// The scalar range of `line`'s content, without its line break.
    pub fn line_range(&self, line: usize) -> Option<(usize, usize)> {
        if self.multiline {
            self.session().coords().line_range(line)
        } else {
            (line == 0).then(|| (0, self.text.chars().count()))
        }
    }

    /// The cells the selection covers on `line`, counted from the line's start (start, end
    /// exclusive). A selection that runs on past the line's end covers it to its last cell.
    pub fn selection_cells(&self, line: usize) -> Option<(usize, usize)> {
        let (from, to) = self.selection()?;
        let (start, end) = self.line_range(line)?;
        let (from, to) = (from.max(start), to.min(end));
        if from >= to {
            return None;
        }
        let session = self.session();
        let coords = session.coords();
        Some((
            coords.cells_between(start, from, TAB),
            coords.cells_between(start, to, TAB),
        ))
    }

    fn line_start(&self, coords: &crate::coords::Coords<'_>, at: usize) -> usize {
        if self.multiline {
            coords.line_range(coords.line_of(at)).map_or(0, |r| r.0)
        } else {
            0
        }
    }

    /// [`cells_at`](Self::cells_at) for the caret.
    pub fn cursor_cells(&self) -> usize {
        self.cells_at(self.head)
    }

    /// The first cell of the value that shows when `shown` cells are on offer: the caret and the
    /// cell under it stay in view.
    pub fn scroll(&self, shown: usize) -> usize {
        let session = self.session();
        let coords = session.coords();
        let at = coords.cells_between(0, self.head, TAB);
        let next = coords.next_grapheme(self.head);
        let under = (coords.cells_between(0, next, TAB) - at).max(1);
        (at + under).saturating_sub(shown.max(1))
    }

    /// Applies a key that moves the caret, selects, edits or asks for the clipboard. The keys
    /// are the composer's: Shift extends a selection, an unshifted motion collapses it, Ctrl or
    /// Cmd with A selects all, Ctrl or Alt makes a motion or a deletion a word's, Cmd makes it a
    /// line's, and Ctrl or Cmd with E, U and K are line end, delete to start and delete to end.
    pub fn key(&mut self, input: &KeyInput) -> Keyed {
        let mods = input.mods();
        let command = mods.intersects(Mods::CTRL | Mods::CMD);
        let word = mods.intersects(Mods::ALT | Mods::CTRL);
        let line = mods.contains(Mods::CMD);
        let extend = mods.contains(Mods::SHIFT);
        let clip = |on: Keyed, field: &Self| {
            if field.selection().is_some() {
                on
            } else {
                Keyed::Ignored
            }
        };
        match input.key() {
            Key::Char(c) if command => match c.to_ascii_lowercase() {
                'a' => self.select_all(),
                'c' => return clip(Keyed::Copy, self),
                'x' => return clip(Keyed::Cut, self),
                'v' => return Keyed::Paste,
                'e' => self.go(Motion::LineEnd, extend),
                'u' => self.erase(Deletion::ToLineStart),
                'k' => self.erase(Deletion::ToLineEnd),
                _ => return Keyed::Ignored,
            },
            // An Alt chord is the panel's unless it makes a character a layout makes with Alt.
            Key::Char(c) if !mods.contains(Mods::ALT) || !c.is_ascii() => {
                let mut one = [0u8; 4];
                self.insert(c.encode_utf8(&mut one));
            }
            Key::Backspace if line => self.erase(Deletion::ToLineStart),
            Key::Backspace if word => self.erase(Deletion::WordBackward),
            Key::Backspace => self.erase(Deletion::Backward),
            Key::Delete if line => self.erase(Deletion::ToLineEnd),
            Key::Delete if word => self.erase(Deletion::WordForward),
            Key::Delete => self.erase(Deletion::Forward),
            Key::Left if line => self.go(Motion::LineStart, extend),
            Key::Left if word => self.go(Motion::WordLeft, extend),
            Key::Left => self.go(Motion::Left, extend),
            Key::Right if line => self.go(Motion::LineEnd, extend),
            Key::Right if word => self.go(Motion::WordRight, extend),
            Key::Right => self.go(Motion::Right, extend),
            Key::Home if command => self.go(Motion::DocStart, extend),
            Key::Home => self.go(Motion::LineStart, extend),
            Key::End if command => self.go(Motion::DocEnd, extend),
            Key::End => self.go(Motion::LineEnd, extend),
            Key::Enter if self.multiline && !command => self.edit(|s| {
                let _ = s.insert_newline();
            }),
            Key::Up if self.multiline => self.go(Motion::Up, extend),
            Key::Down if self.multiline => self.go(Motion::Down, extend),
            Key::Copy => return clip(Keyed::Copy, self),
            Key::Cut => return clip(Keyed::Cut, self),
            Key::Paste => return Keyed::Paste,
            _ => return Keyed::Ignored,
        }
        Keyed::Handled
    }

    /// Typed, pasted or committed text, replacing the selection. A one-line field drops line
    /// breaks; a multi-line one keeps them as `\n`. What else to drop is the site's to decide
    /// before it gets here.
    pub fn insert(&mut self, text: &str) {
        let text: String = if self.multiline {
            text.replace("\r\n", "\n").replace('\r', "\n")
        } else {
            text.chars().filter(|c| !matches!(c, '\n' | '\r')).collect()
        };
        if !text.is_empty() {
            self.edit(|s| {
                let _ = s.insert_text(&text);
            });
        }
    }

    /// Removes the selection. False when nothing was selected.
    pub fn delete_selection(&mut self) -> bool {
        if self.selection().is_none() {
            return false;
        }
        self.erase(Deletion::Backward);
        true
    }

    /// Puts the caret on the cluster under display cell `column` of the field as drawn in
    /// `shown` cells, and drops the selection.
    pub fn click(&mut self, column: usize, shown: usize) {
        let target = column + self.scroll(shown);
        self.edit(|s| {
            let end = s.len();
            let at = s
                .coords()
                .offset_at_cell(0, end, target, TAB, Snap::Backward);
            s.set_selection(at, at);
        });
    }

    /// Draws the value in `rect` (one row), scrolled so the caret shows, with a caret in
    /// `styles.caret` while `focused`. An empty value shows `placeholder` in `styles.hint`.
    /// Returns the column after the last cell the text took.
    pub fn draw(
        &self,
        buf: &mut Buffer,
        rect: Rect,
        styles: &FieldStyles,
        focused: bool,
        placeholder: &str,
    ) -> u16 {
        if rect.width == 0 || rect.height == 0 {
            return rect.x;
        }
        let rect = Rect { height: 1, ..rect };
        let mut end = rect.x;
        let mut caret = Some((rect.x, 1u16));
        if self.text.is_empty() {
            buf.set_style(rect, styles.text);
            buf.set_stringn(
                rect.x,
                rect.y,
                placeholder,
                usize::from(rect.width),
                styles.hint,
            );
        } else {
            let mut session = self.session();
            let editor = EditorStyles {
                base: styles.text,
                selection: styles.selection,
                line_number: styles.hint,
                ..EditorStyles::default()
            };
            let options = RenderOptions {
                styles: editor,
                line_numbers: false,
            };
            let drawn = render(&mut session, rect, buf, &options);
            caret = drawn.caret.map(|c| (c.x, c.width));
            let scroll = self.scroll(usize::from(rect.width));
            let total = session.coords().cells_between(0, session.len(), TAB);
            end = rect.x + total.saturating_sub(scroll).min(usize::from(rect.width)) as u16;
        }
        if focused && let Some((x, width)) = caret {
            let width = width.min(rect.x + rect.width - x).max(1);
            buf.set_style(Rect::new(x, rect.y, width, 1), styles.caret);
        }
        end
    }

    // ---- the session over the value ----

    fn session(&self) -> EditSession {
        let mut config = SessionConfig::new("field");
        config.single_line = !self.multiline;
        config.wrap = false;
        config.tab_width = TAB;
        let mut session = EditSession::new(&self.text, 0, config);
        session.set_selection(self.anchor, self.head);
        session
    }

    /// Runs `f` on a session over the value and keeps the text, anchor and caret it ends with.
    fn edit<R>(&mut self, f: impl FnOnce(&mut EditSession) -> R) -> R {
        let mut session = self.session();
        let out = f(&mut session);
        self.text = session.text();
        self.anchor = session.anchor();
        self.head = session.cursor();
        out
    }

    fn go(&mut self, motion: Motion, extend: bool) {
        self.edit(|s| s.move_cursor(motion, extend));
    }

    fn erase(&mut self, deletion: Deletion) {
        self.edit(|s| {
            let _ = s.delete(deletion);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMILY: &str = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    const FLAG: &str = "\u{1F1FA}\u{1F1F8}";

    fn key(k: Key, mods: Mods) -> KeyInput {
        KeyInput::new(k, mods)
    }

    fn press(f: &mut Field, k: Key, mods: Mods) -> Keyed {
        f.key(&key(k, mods))
    }

    fn typed(f: &mut Field, c: char) {
        press(f, Key::Char(c), Mods::empty());
    }

    fn at(value: &str, caret: usize) -> Field {
        let mut f = Field::new(value);
        f.set_cursor(caret);
        f
    }

    #[test]
    fn shifted_motions_extend_a_selection() {
        let cases: [(Key, Mods, usize, (usize, usize)); 6] = [
            (Key::Left, Mods::SHIFT, 5, (4, 5)),
            (Key::Right, Mods::SHIFT, 2, (2, 3)),
            (Key::Home, Mods::SHIFT, 5, (0, 5)),
            (Key::End, Mods::SHIFT, 2, (2, 11)),
            (Key::Left, Mods::SHIFT | Mods::ALT, 11, (6, 11)),
            (Key::Right, Mods::SHIFT | Mods::CTRL, 0, (0, 5)),
        ];
        for (k, mods, from, want) in cases {
            let mut f = at("hello world", from);
            assert_eq!(press(&mut f, k, mods), Keyed::Handled);
            assert_eq!(f.selection(), Some(want), "{k:?} {mods:?} from {from}");
        }
    }

    #[test]
    fn an_unshifted_motion_collapses_the_selection_the_way_the_composer_does() {
        let mut f = at("hello world", 2);
        press(&mut f, Key::End, Mods::SHIFT);
        press(&mut f, Key::Left, Mods::empty());
        assert_eq!(f.selection(), None);
        assert_eq!(f.cursor(), 2, "Left goes to the start of the selection");
        press(&mut f, Key::End, Mods::SHIFT);
        press(&mut f, Key::Right, Mods::empty());
        assert_eq!(f.cursor(), 11, "Right goes to its end");
        let mut g = at("hello world", 2);
        press(&mut g, Key::End, Mods::SHIFT);
        press(&mut g, Key::Home, Mods::empty());
        assert_eq!((g.selection(), g.cursor()), (None, 0));
    }

    #[test]
    fn select_all_is_ctrl_or_cmd_a() {
        for mods in [Mods::CTRL, Mods::CMD] {
            let mut f = at("hello", 2);
            press(&mut f, Key::Char('a'), mods);
            assert_eq!(f.selection(), Some((0, 5)));
        }
    }

    #[test]
    fn typing_and_paste_replace_the_selection() {
        let mut f = at("hello world", 6);
        press(&mut f, Key::End, Mods::SHIFT);
        typed(&mut f, 'W');
        assert_eq!((f.value(), f.cursor(), f.selection()), ("hello W", 7, None));
        let mut g = at("hello world", 0);
        press(&mut g, Key::Char('a'), Mods::CTRL);
        g.insert("pasted");
        assert_eq!(g.value(), "pasted");
        let mut h = at("abc", 0);
        press(&mut h, Key::Right, Mods::SHIFT);
        h.insert("x\ny\r\nz");
        assert_eq!(
            h.value(),
            "xyzbc",
            "line breaks never enter a one-line field"
        );
    }

    #[test]
    fn backspace_and_delete_remove_the_selection() {
        for k in [Key::Backspace, Key::Delete] {
            let mut f = at("hello world", 5);
            press(&mut f, Key::Right, Mods::SHIFT | Mods::CTRL);
            assert_eq!(f.selection(), Some((5, 11)));
            press(&mut f, k, Mods::empty());
            assert_eq!((f.value(), f.cursor()), ("hello", 5), "{k:?}");
        }
    }

    #[test]
    fn the_caret_and_deletion_step_over_one_cluster() {
        // A combining mark, a family of emoji joined with joiners, a flag.
        for (cluster, scalars) in [("e\u{301}", 2), (FAMILY, 5), (FLAG, 2)] {
            let value = format!("a{cluster}b");
            let mut f = at(&value, 1);
            press(&mut f, Key::Right, Mods::empty());
            assert_eq!(f.cursor(), 1 + scalars, "Right over {cluster:?}");
            press(&mut f, Key::Left, Mods::empty());
            assert_eq!(f.cursor(), 1, "Left over {cluster:?}");
            press(&mut f, Key::Right, Mods::SHIFT);
            assert_eq!(f.selection(), Some((1, 1 + scalars)));
            press(&mut f, Key::Backspace, Mods::empty());
            assert_eq!(f.value(), "ab", "the selected cluster goes whole");
            let mut g = at(&value, 1 + scalars);
            press(&mut g, Key::Backspace, Mods::empty());
            assert_eq!(g.value(), "ab", "Backspace removes {cluster:?} whole");
            let mut h = at(&value, 1);
            press(&mut h, Key::Delete, Mods::empty());
            assert_eq!(h.value(), "ab", "Delete removes {cluster:?} whole");
        }
    }

    #[test]
    fn the_line_keys_and_the_readline_keys() {
        let mut f = at("hello world", 5);
        press(&mut f, Key::Char('e'), Mods::CTRL);
        assert_eq!(f.cursor(), 11);
        press(&mut f, Key::Char('u'), Mods::CTRL);
        assert_eq!(f.value(), "");
        let mut g = at("hello world", 5);
        press(&mut g, Key::Char('k'), Mods::CTRL);
        assert_eq!(g.value(), "hello");
        let mut h = at("hello world", 11);
        press(&mut h, Key::Backspace, Mods::ALT);
        assert_eq!(h.value(), "hello ");
        press(&mut h, Key::Home, Mods::empty());
        press(&mut h, Key::Delete, Mods::CTRL);
        assert_eq!(h.value(), " ");
        let mut c = at("hello", 3);
        assert_eq!(press(&mut c, Key::Char('c'), Mods::CTRL), Keyed::Ignored);
        assert_eq!(press(&mut c, Key::Char('b'), Mods::ALT), Keyed::Ignored);
        assert_eq!(press(&mut c, Key::Enter, Mods::empty()), Keyed::Ignored);
        assert_eq!(press(&mut c, Key::Up, Mods::empty()), Keyed::Ignored);
        assert_eq!(c.value(), "hello");
    }

    #[test]
    fn the_clipboard_keys_ask_only_with_something_selected() {
        let mut f = at("hello", 0);
        assert_eq!(press(&mut f, Key::Char('c'), Mods::CTRL), Keyed::Ignored);
        assert_eq!(press(&mut f, Key::Char('x'), Mods::CMD), Keyed::Ignored);
        assert_eq!(press(&mut f, Key::Char('v'), Mods::CTRL), Keyed::Paste);
        press(&mut f, Key::End, Mods::SHIFT);
        assert_eq!(press(&mut f, Key::Char('c'), Mods::CTRL), Keyed::Copy);
        assert_eq!(press(&mut f, Key::Char('x'), Mods::CTRL), Keyed::Cut);
        assert_eq!(f.selected_text().as_deref(), Some("hello"));
        assert_eq!(f.value(), "hello", "asking does not cut");
        assert!(f.delete_selection());
        assert_eq!(f.value(), "");
        assert!(!f.delete_selection());
    }

    #[test]
    fn an_alt_chord_is_not_text_but_an_alt_layout_character_is() {
        let mut f = Field::new("");
        assert_eq!(press(&mut f, Key::Char('b'), Mods::ALT), Keyed::Ignored);
        assert_eq!(
            press(&mut f, Key::Char('\u{e5}'), Mods::ALT),
            Keyed::Handled
        );
        assert_eq!(f.value(), "\u{e5}");
    }

    fn row(f: &Field, width: u16, focused: bool) -> (Buffer, u16) {
        let area = Rect::new(0, 0, width, 1);
        let mut buf = Buffer::empty(area);
        let styles = FieldStyles {
            text: Style::default(),
            selection: Style::default().add_modifier(ratatui::style::Modifier::REVERSED),
            caret: Style::default().add_modifier(ratatui::style::Modifier::UNDERLINED),
            hint: Style::default().add_modifier(ratatui::style::Modifier::DIM),
        };
        let end = f.draw(&mut buf, area, &styles, focused, "hint");
        (buf, end)
    }

    fn symbols(buf: &Buffer, width: u16) -> String {
        (0..width).map(|x| buf[(x, 0)].symbol()).collect()
    }

    #[test]
    fn the_selection_is_drawn_in_the_selection_style_and_scrolls_with_the_caret() {
        use ratatui::style::Modifier;
        let mut f = at("abcdefghij", 0);
        press(&mut f, Key::Right, Mods::SHIFT);
        press(&mut f, Key::Right, Mods::SHIFT);
        let (buf, end) = row(&f, 6, true);
        assert_eq!(symbols(&buf, 6), "abcdef");
        assert_eq!(end, 6);
        assert!(buf[(0, 0)].modifier.contains(Modifier::REVERSED));
        assert!(buf[(1, 0)].modifier.contains(Modifier::REVERSED));
        assert!(!buf[(3, 0)].modifier.contains(Modifier::REVERSED));
        assert!(
            buf[(2, 0)].modifier.contains(Modifier::UNDERLINED),
            "the caret"
        );

        // The caret goes to the end: the row scrolls so it and the selection's end show.
        let mut g = at("abcdefghij", 3);
        press(&mut g, Key::End, Mods::SHIFT);
        assert_eq!(g.scroll(6), 5);
        let (buf, _) = row(&g, 6, true);
        assert_eq!(symbols(&buf, 6), "fghij ");
        assert!(buf[(0, 0)].modifier.contains(Modifier::REVERSED));
        assert!(buf[(4, 0)].modifier.contains(Modifier::REVERSED));
        assert!(
            buf[(5, 0)].modifier.contains(Modifier::UNDERLINED),
            "the caret"
        );
    }

    #[test]
    fn a_control_character_is_drawn_as_its_one_cell_stand_in() {
        let f = Field::new("a\u{7}\u{202e}b");
        assert_eq!(f.cursor_cells(), 4, "one cell each");
        let (buf, end) = row(&f, 8, false);
        assert_eq!(symbols(&buf, 5), "a\u{2407}\u{25af}b ");
        assert_eq!(end, 4);
        assert_eq!(f.value(), "a\u{7}\u{202e}b", "the value is not changed");
    }

    #[test]
    fn an_empty_field_shows_its_placeholder_and_its_caret() {
        use ratatui::style::Modifier;
        let (buf, end) = row(&Field::new(""), 8, true);
        assert_eq!(symbols(&buf, 4), "hint");
        assert_eq!(end, 0);
        assert!(buf[(0, 0)].modifier.contains(Modifier::UNDERLINED));
    }

    #[test]
    fn a_click_puts_the_caret_on_the_cluster_under_the_column_in_the_scrolled_row() {
        let mut f = at("abcdefghij", 10);
        f.click(2, 6);
        assert_eq!(f.cursor(), 7, "the row is scrolled by 5");
        let mut g = Field::new(&format!("a{FAMILY}b"));
        g.click(1, 10);
        assert_eq!(g.cursor(), 1, "a wide cluster is one step");
        g.click(3, 10);
        assert_eq!(g.cursor(), 6);
    }

    #[test]
    fn the_anchor_and_caret_are_what_a_text_node_publishes() {
        let mut f = at("a\u{1F600}bc", 1);
        press(&mut f, Key::Right, Mods::SHIFT);
        press(&mut f, Key::Right, Mods::SHIFT);
        assert_eq!((f.anchor(), f.cursor()), (1, 3));
        press(&mut f, Key::Left, Mods::SHIFT);
        assert_eq!(
            (f.anchor(), f.cursor()),
            (1, 2),
            "the anchor stays, the caret walks"
        );
    }

    // ---- a multi-line value ----

    fn lines(value: &str, caret: usize) -> Field {
        let mut f = Field::multiline(value);
        f.set_cursor(caret);
        f
    }

    #[test]
    fn enter_breaks_a_line_and_replaces_the_selection_and_a_one_line_field_ignores_it() {
        let mut f = lines("abcd", 2);
        assert_eq!(press(&mut f, Key::Enter, Mods::empty()), Keyed::Handled);
        assert_eq!((f.value(), f.cursor()), ("ab\ncd", 3));
        press(&mut f, Key::Left, Mods::SHIFT);
        press(&mut f, Key::Left, Mods::SHIFT);
        press(&mut f, Key::Enter, Mods::empty());
        assert_eq!(f.value(), "a\ncd", "the selection is replaced by the break");
        let mut one = at("ab", 1);
        assert_eq!(press(&mut one, Key::Enter, Mods::empty()), Keyed::Ignored);
        assert_eq!(press(&mut one, Key::Down, Mods::SHIFT), Keyed::Ignored);
    }

    #[test]
    fn up_and_down_move_between_lines_and_shift_extends_across_the_break() {
        let mut f = lines("abcd\nefgh", 2);
        press(&mut f, Key::Down, Mods::SHIFT);
        assert_eq!(
            (f.anchor(), f.cursor()),
            (2, 7),
            "the same column of the next line"
        );
        assert_eq!(f.selected_text().as_deref(), Some("cd\nef"));
        press(&mut f, Key::Up, Mods::empty());
        assert_eq!(
            (f.anchor(), f.cursor()),
            (2, 2),
            "an unshifted motion collapses"
        );
        press(&mut f, Key::Down, Mods::empty());
        assert_eq!(f.cursor(), 7);
        press(&mut f, Key::Up, Mods::SHIFT);
        assert_eq!((f.anchor(), f.cursor()), (7, 2));
    }

    #[test]
    fn select_all_takes_every_line_and_typing_replaces_them() {
        let mut f = lines("one\ntwo\nthree", 5);
        press(&mut f, Key::Char('a'), Mods::CTRL);
        assert_eq!(f.selected_text().as_deref(), Some("one\ntwo\nthree"));
        typed(&mut f, 'x');
        assert_eq!(f.value(), "x");
    }

    #[test]
    fn backspace_at_a_line_start_joins_the_lines() {
        let mut f = lines("ab\ncd", 3);
        press(&mut f, Key::Backspace, Mods::empty());
        assert_eq!((f.value(), f.cursor()), ("abcd", 2));
    }

    #[test]
    fn insert_keeps_line_breaks_in_a_multi_line_value_and_drops_them_in_a_one_line_one() {
        let mut f = Field::multiline("");
        f.insert("a\r\nb\rc\nd");
        assert_eq!(f.value(), "a\nb\nc\nd");
        assert_eq!(f.line_count(), 4);
        let mut one = Field::new("");
        one.insert("a\nb");
        assert_eq!(one.value(), "ab");
    }

    #[test]
    fn a_selection_over_lines_is_cells_on_each_line_it_covers() {
        let mut f = lines("abcd\nef\nghij", 2);
        f.set_cursor(2);
        press(&mut f, Key::Down, Mods::SHIFT);
        press(&mut f, Key::Down, Mods::SHIFT);
        // From column 2 of line 0 to column 2 of line 2, over a short middle line.
        assert_eq!(f.selection_cells(0), Some((2, 4)));
        assert_eq!(f.selection_cells(1), Some((0, 2)));
        assert_eq!(f.selection_cells(2), Some((0, 2)));
        assert_eq!(f.selection_cells(3), None);
        assert_eq!((f.cursor_line(), f.cursor_cells()), (2, 2));
        let one = at("abcd", 2);
        assert_eq!((one.line_count(), one.cursor_line()), (1, 0));
    }
}
