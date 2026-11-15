//! A one-line text field for the find bar and the rename name.
//!
//! The editing is `tui_input::Input`'s. What this adds is the mapping from the
//! workbench's keys to its requests; the Files panel has the same mapping for
//! its rename row, but it is private to that crate.

use keybinds::{Key, KeyInput, Mods};
use tui_input::{Input, InputRequest};

/// What a key did to the field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The field did not use the key.
    Ignored,
    /// The text or the cursor changed.
    Edited,
    Enter,
    Escape,
}

#[derive(Clone, Debug, Default)]
pub struct Field {
    input: Input,
}

impl Field {
    pub fn with_value(value: &str) -> Self {
        Self {
            input: Input::new(value.to_owned()),
        }
    }

    pub fn value(&self) -> &str {
        self.input.value()
    }

    /// Cells from the start of the visible part to the cursor.
    pub fn cursor(&self) -> usize {
        self.input.visual_cursor()
    }

    pub fn scroll(&self, width: usize) -> usize {
        self.input.visual_scroll(width.max(1))
    }

    pub fn is_empty(&self) -> bool {
        self.input.value().is_empty()
    }

    pub fn text(&mut self, text: &str) -> Event {
        for c in text.chars().filter(|c| !c.is_control()) {
            self.input.handle(InputRequest::InsertChar(c));
        }
        Event::Edited
    }

    pub fn key(&mut self, key: &KeyInput) -> Event {
        let mods = key.mods();
        let word = mods.intersects(Mods::ALT | Mods::CTRL);
        let request = match key.key() {
            Key::Enter => return Event::Enter,
            Key::Esc => return Event::Escape,
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
                _ => return Event::Ignored,
            },
            Key::Char(c) if !mods.contains(Mods::ALT) || !c.is_ascii() => {
                InputRequest::InsertChar(c)
            }
            _ => return Event::Ignored,
        };
        self.input.handle(request);
        Event::Edited
    }
}
