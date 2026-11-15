//! A one-line text field: `tui-input` for the buffer, caret and word motions, and the few
//! cells it takes to draw it and to place its caret from a pointer press.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use tui_input::{Input, InputRequest};
use unicode_width::UnicodeWidthChar;

use crate::text;

/// The three styles a field is drawn with.
#[derive(Clone, Copy)]
pub(crate) struct Look {
    pub text: Style,
    pub caret: Style,
    pub hint: Style,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Field {
    input: Input,
}

/// The buffer request a key makes, when it edits text. Keys with a command modifier other
/// than the readline ones are the panel's.
fn request(key: &KeyInput) -> Option<InputRequest> {
    let mods = key.mods();
    let word = mods.intersects(Mods::ALT | Mods::CTRL);
    Some(match key.key() {
        Key::Left if word => InputRequest::GoToPrevWord,
        Key::Right if word => InputRequest::GoToNextWord,
        Key::Left => InputRequest::GoToPrevChar,
        Key::Right => InputRequest::GoToNextChar,
        Key::Home => InputRequest::GoToStart,
        Key::End => InputRequest::GoToEnd,
        Key::Backspace if word => InputRequest::DeletePrevWord,
        Key::Backspace => InputRequest::DeletePrevChar,
        Key::Delete => InputRequest::DeleteNextChar,
        Key::Char(c) if mods.intersects(Mods::CTRL | Mods::CMD) => match c {
            'a' => InputRequest::GoToStart,
            'e' => InputRequest::GoToEnd,
            'u' => InputRequest::DeleteFromStart,
            'k' => InputRequest::DeleteTillEnd,
            _ => return None,
        },
        Key::Char(c) if mods.difference(Mods::SHIFT).is_empty() => InputRequest::InsertChar(c),
        _ => return None,
    })
}

impl Field {
    pub(crate) fn new(value: &str) -> Self {
        Self {
            input: Input::new(value.to_owned()),
        }
    }

    pub(crate) fn value(&self) -> &str {
        self.input.value()
    }

    /// The caret, in Unicode scalars from the start of the value.
    pub(crate) fn cursor(&self) -> usize {
        self.input.cursor()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.input.value().is_empty()
    }

    /// Applies a key that edits or moves the caret. False: the key is not the field's.
    pub(crate) fn key(&mut self, key: &KeyInput) -> bool {
        match request(key) {
            Some(r) => {
                self.input.handle(r);
                true
            }
            None => false,
        }
    }

    /// Typed or pasted text, with line breaks dropped: a field is one line.
    pub(crate) fn insert(&mut self, text: &str) {
        for c in text.chars().filter(|c| !matches!(c, '\n' | '\r')) {
            self.input.handle(InputRequest::InsertChar(c));
        }
    }

    /// Puts the caret at the character under column `column` of the field's own cells.
    pub(crate) fn click(&mut self, column: usize, shown: usize) {
        let scroll = self.input.visual_scroll(shown.max(1));
        let target = column + scroll;
        let mut at = 0usize;
        let mut index = 0usize;
        for c in self.input.value().chars() {
            let w = UnicodeWidthChar::width(c).unwrap_or(0);
            if at + w > target {
                break;
            }
            at += w;
            index += 1;
        }
        self.input.handle(InputRequest::SetCursor(index));
    }

    /// Draws the value in `rect` (one row), scrolled so the caret shows, with a caret cell
    /// in `caret` while `focused`. An empty value shows `placeholder` in `hint`.
    pub(crate) fn draw(
        &self,
        buf: &mut Buffer,
        rect: Rect,
        look: Look,
        focused: bool,
        placeholder: &str,
    ) {
        let Look {
            text: text_style,
            caret,
            hint,
        } = look;
        if rect.width == 0 || rect.height == 0 {
            return;
        }
        let shown = rect.width as usize;
        if self.input.value().is_empty() {
            text::put(buf, rect.x, rect.y, shown, placeholder, hint);
        } else {
            let scroll = self.input.visual_scroll(shown);
            let cells = text::cells(self.input.value(), &[]);
            let line = text::line(&cells, scroll, shown, text_style, Style::default());
            buf.set_line(rect.x, rect.y, &line, rect.width);
        }
        if focused {
            let scroll = self.input.visual_scroll(shown);
            let at = self.input.visual_cursor().saturating_sub(scroll);
            if at < shown {
                buf[(rect.x + at as u16, rect.y)].set_style(caret);
            }
        }
    }
}
