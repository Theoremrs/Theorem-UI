//! The find bar, the rename name and the new page's name edit with the workspace's one-line
//! field, `theorem_workbench_text::field::Field`. What this adds is what the panel does with the
//! keys that are not editing: Enter and Esc end the field, and a clipboard key is the panel's to
//! carry out through the core's effects.

use keybinds::{Key, KeyInput};
pub use theorem_workbench_text::field::Field;
use theorem_workbench_text::field::Keyed;

use crate::widget::Clipboard;

/// What a key did to the field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The field did not use the key.
    Ignored,
    /// The text, the caret or the selection changed.
    Edited,
    Enter,
    Escape,
    /// The field wants the clipboard: the panel sends the effect and applies the answer to
    /// whichever field has the keyboard.
    Clipboard(Clipboard),
}

pub fn press(field: &mut Field, key: &KeyInput) -> Event {
    match key.key() {
        Key::Enter => return Event::Enter,
        Key::Esc => return Event::Escape,
        _ => {}
    }
    match field.key(key) {
        Keyed::Ignored => Event::Ignored,
        Keyed::Handled => Event::Edited,
        Keyed::Copy => Event::Clipboard(Clipboard::Copy),
        Keyed::Cut => Event::Clipboard(Clipboard::Cut),
        Keyed::Paste => Event::Clipboard(Clipboard::Paste),
    }
}

/// Typed or pasted text, without control characters.
pub fn typed(field: &mut Field, text: &str) -> Event {
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    field.insert(&text);
    Event::Edited
}
