//! `keybinds` key input to the `terminput` events the VT encoders take. The
//! two crates share no conversion, and the mapping is a table of names.

use keybinds::{Key, KeyInput, Mods};
use terminput::{KeyCode, KeyEvent, KeyModifiers};

/// `None` for keys a terminal has no bytes for and for chords with the
/// command or windows key, which belong to the browser and the workbench.
pub(crate) fn key_event(input: &KeyInput) -> Option<KeyEvent> {
    let mods = input.mods();
    if mods.intersects(Mods::CMD | Mods::WIN) {
        return None;
    }
    let code = match input.key() {
        Key::Char(c) => KeyCode::Char(c),
        Key::Up => KeyCode::Up,
        Key::Down => KeyCode::Down,
        Key::Left => KeyCode::Left,
        Key::Right => KeyCode::Right,
        Key::Enter => KeyCode::Enter,
        Key::Backspace => KeyCode::Backspace,
        Key::Delete => KeyCode::Delete,
        Key::Home => KeyCode::Home,
        Key::End => KeyCode::End,
        Key::PageUp => KeyCode::PageUp,
        Key::PageDown => KeyCode::PageDown,
        Key::Esc => KeyCode::Esc,
        Key::Tab => KeyCode::Tab,
        Key::Insert => KeyCode::Insert,
        Key::F1 => KeyCode::F(1),
        Key::F2 => KeyCode::F(2),
        Key::F3 => KeyCode::F(3),
        Key::F4 => KeyCode::F(4),
        Key::F5 => KeyCode::F(5),
        Key::F6 => KeyCode::F(6),
        Key::F7 => KeyCode::F(7),
        Key::F8 => KeyCode::F(8),
        Key::F9 => KeyCode::F(9),
        Key::F10 => KeyCode::F(10),
        Key::F11 => KeyCode::F(11),
        Key::F12 => KeyCode::F(12),
        _ => return None,
    };
    let mut modifiers = KeyModifiers::empty();
    if mods.contains(Mods::CTRL) {
        modifiers |= KeyModifiers::CTRL;
    }
    if mods.contains(Mods::ALT) {
        modifiers |= KeyModifiers::ALT;
    }
    if mods.contains(Mods::SHIFT) {
        modifiers |= KeyModifiers::SHIFT;
    }
    Some(KeyEvent::new(code).modifiers(modifiers))
}

pub(crate) fn mouse_modifiers(mods: Mods) -> KeyModifiers {
    let mut out = KeyModifiers::empty();
    if mods.contains(Mods::CTRL) {
        out |= KeyModifiers::CTRL;
    }
    if mods.contains(Mods::ALT) {
        out |= KeyModifiers::ALT;
    }
    if mods.contains(Mods::SHIFT) {
        out |= KeyModifiers::SHIFT;
    }
    out
}
