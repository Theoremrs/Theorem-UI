//! Input to bytes. Key, mouse and focus events are `terminput` events (its
//! `terminput-web-sys` adapter turns browser events into them). `terminput`
//! knows the xterm byte layouts but not the terminal's current modes, so the
//! mode-dependent parts are decided here: application cursor and keypad keys,
//! which mouse events the program asked for and in which encoding, and
//! whether focus and paste are wrapped.

use terminput::{
    Encoding, Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseEvent,
    MouseEventKind,
};
use vt100::{MouseProtocolEncoding, MouseProtocolMode};

/// The terminal modes that change how input is encoded.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputModes {
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub bracketed_paste: bool,
    pub mouse_mode: MouseProtocolMode,
    pub mouse_encoding: MouseProtocolEncoding,
    pub focus_reporting: bool,
}

fn encode(event: &Event) -> Option<Vec<u8>> {
    let mut buf = [0u8; 32];
    let n = event.encode(&mut buf, Encoding::Xterm).ok()?;
    Some(buf[..n].to_vec())
}

/// The bytes for a key press. `None` for key releases and keys a terminal
/// has no bytes for. Repeats count as presses.
pub fn encode_key(key: &KeyEvent, modes: &InputModes) -> Option<Vec<u8>> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    let mut key = *key;
    key.kind = KeyEventKind::Press;
    let plain = key.modifiers.is_empty();

    if plain && modes.application_cursor {
        let last = match key.code {
            KeyCode::Up => Some(b'A'),
            KeyCode::Down => Some(b'B'),
            KeyCode::Right => Some(b'C'),
            KeyCode::Left => Some(b'D'),
            KeyCode::Home => Some(b'H'),
            KeyCode::End => Some(b'F'),
            _ => None,
        };
        if let Some(last) = last {
            return Some(vec![0x1b, b'O', last]);
        }
    }
    if plain && modes.application_keypad && key.state.contains(KeyEventState::KEYPAD) {
        let last = match key.code {
            KeyCode::Char(c @ '0'..='9') => Some(b'p' + (c as u8 - b'0')),
            KeyCode::Char('*') => Some(b'j'),
            KeyCode::Char('+') => Some(b'k'),
            KeyCode::Char(',') => Some(b'l'),
            KeyCode::Char('-') => Some(b'm'),
            KeyCode::Char('.') => Some(b'n'),
            KeyCode::Char('/') => Some(b'o'),
            KeyCode::Char('=') => Some(b'X'),
            KeyCode::Enter => Some(b'M'),
            _ => None,
        };
        if let Some(last) = last {
            return Some(vec![0x1b, b'O', last]);
        }
    }
    if let Some(bytes) = encode(&Event::Key(key)) {
        return Some(bytes);
    }
    // Control with the punctuation that sits among the C0 codes.
    if let KeyCode::Char(c) = key.code
        && key.modifiers.contains(KeyModifiers::CTRL)
        && let Some(code) = match c {
            '@' | '`' => Some(0x00),
            '[' => Some(0x1b),
            '\\' => Some(0x1c),
            ']' => Some(0x1d),
            '^' | '~' => Some(0x1e),
            '_' | '?' => Some(0x1f),
            _ => None,
        }
    {
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        return Some(if alt { vec![0x1b, code] } else { vec![code] });
    }
    None
}

/// The bytes for pasted text. With bracketed paste on, the text is wrapped
/// and any embedded end marker is removed so the text cannot close the
/// bracket early. Without it, line breaks become carriage returns, as a
/// typed Enter would. (The host's `terminal.paste` does this wrapping
/// itself: send it the raw text instead, not these bytes.)
pub fn encode_paste(text: &str, modes: &InputModes) -> Vec<u8> {
    const END: &str = "\x1b[201~";
    if modes.bracketed_paste {
        let mut out = b"\x1b[200~".to_vec();
        out.extend_from_slice(text.replace(END, "").as_bytes());
        out.extend_from_slice(END.as_bytes());
        out
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

/// `CSI I` or `CSI O`, only when the program turned focus reporting on.
pub fn encode_focus(gained: bool, modes: &InputModes) -> Option<Vec<u8>> {
    if !modes.focus_reporting {
        return None;
    }
    encode(&if gained {
        Event::FocusGained
    } else {
        Event::FocusLost
    })
}

/// The bytes for a mouse event at the cell in `mouse.column`/`mouse.row`
/// (zero-based, relative to the pane). `None` when the program did not ask
/// for this kind of event, or the cell does not fit the encoding.
pub fn encode_mouse(mouse: &MouseEvent, modes: &InputModes) -> Option<Vec<u8>> {
    let wanted = match mouse.kind {
        MouseEventKind::Down(_) | MouseEventKind::Scroll(_) => {
            modes.mouse_mode != MouseProtocolMode::None
        }
        MouseEventKind::Up(_) => !matches!(
            modes.mouse_mode,
            MouseProtocolMode::None | MouseProtocolMode::Press
        ),
        MouseEventKind::Drag(_) => matches!(
            modes.mouse_mode,
            MouseProtocolMode::ButtonMotion | MouseProtocolMode::AnyMotion
        ),
        MouseEventKind::Moved => modes.mouse_mode == MouseProtocolMode::AnyMotion,
    };
    if !wanted {
        return None;
    }
    let mut mouse = *mouse;
    // X10 reports presses only, with no modifiers.
    if modes.mouse_mode == MouseProtocolMode::Press {
        mouse.modifiers = KeyModifiers::empty();
    }
    let sgr = encode(&Event::Mouse(mouse))?;
    if modes.mouse_encoding == MouseProtocolEncoding::Sgr {
        return Some(sgr);
    }
    // terminput writes SGR; the older encodings carry the same button code
    // (release has no button there: it is 3) and the position, plus 32.
    let text = std::str::from_utf8(sgr.strip_prefix(b"\x1b[<")?).ok()?;
    let released = text.ends_with('m');
    let mut fields = text[..text.len() - 1]
        .split(';')
        .map(|f| f.parse::<u32>().ok());
    let (button, col, row) = (fields.next()??, fields.next()??, fields.next()??);
    let button = if released { button | 3 } else { button };
    let mut out = b"\x1b[M".to_vec();
    out.push(u8::try_from(button + 32).ok()?);
    for v in [col, row] {
        let v = v + 32;
        if modes.mouse_encoding == MouseProtocolEncoding::Utf8 {
            let c = char::from_u32(v).filter(|_| v <= 2047)?;
            let mut tmp = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
        } else {
            out.push(u8::try_from(v).ok()?);
        }
    }
    Some(out)
}
