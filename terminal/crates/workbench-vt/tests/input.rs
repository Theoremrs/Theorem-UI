//! Input encoding against the sequences xterm sends.

use terminput::{
    KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind, ScrollDirection,
};
use theorem_workbench_vt::{
    InputModes, MouseProtocolEncoding, MouseProtocolMode, Screen, encode_focus, encode_key,
    encode_mouse, encode_paste,
};

const NONE: KeyModifiers = KeyModifiers::empty();
const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
const ALT: KeyModifiers = KeyModifiers::ALT;
const CTRL: KeyModifiers = KeyModifiers::CTRL;

fn key(code: KeyCode, mods: KeyModifiers, modes: &InputModes) -> Option<Vec<u8>> {
    encode_key(&KeyEvent::new(code).modifiers(mods), modes)
}

fn ch(c: char) -> KeyCode {
    KeyCode::Char(c)
}

#[test]
fn keys_in_the_normal_modes() {
    let m = InputModes::default();
    let table: &[(KeyCode, KeyModifiers, &[u8])] = &[
        (ch('a'), NONE, b"a"),
        (ch('A'), SHIFT, b"A"),
        (ch('é'), NONE, "é".as_bytes()),
        (ch('漢'), NONE, "漢".as_bytes()),
        (ch('a'), CTRL, b"\x01"),
        (ch('c'), CTRL, b"\x03"),
        (ch('z'), CTRL, b"\x1a"),
        (ch(' '), CTRL, b"\x00"),
        (ch('['), CTRL, b"\x1b"),
        (ch('\\'), CTRL, b"\x1c"),
        (ch(']'), CTRL, b"\x1d"),
        (ch('x'), ALT, b"\x1bx"),
        (ch('x'), ALT | CTRL, b"\x1b\x18"),
        (KeyCode::Enter, NONE, b"\r"),
        (KeyCode::Tab, NONE, b"\t"),
        (KeyCode::Tab, SHIFT, b"\x1b[Z"),
        (KeyCode::Backspace, NONE, b"\x7f"),
        (KeyCode::Backspace, CTRL, b"\x08"),
        (KeyCode::Esc, NONE, b"\x1b"),
        (KeyCode::Up, NONE, b"\x1b[A"),
        (KeyCode::Down, NONE, b"\x1b[B"),
        (KeyCode::Right, NONE, b"\x1b[C"),
        (KeyCode::Left, NONE, b"\x1b[D"),
        (KeyCode::Home, NONE, b"\x1b[H"),
        (KeyCode::End, NONE, b"\x1b[F"),
        (KeyCode::PageUp, NONE, b"\x1b[5~"),
        (KeyCode::PageDown, NONE, b"\x1b[6~"),
        (KeyCode::Insert, NONE, b"\x1b[2~"),
        (KeyCode::Delete, NONE, b"\x1b[3~"),
        (KeyCode::F(1), NONE, b"\x1bOP"),
        (KeyCode::F(4), NONE, b"\x1bOS"),
        (KeyCode::F(5), NONE, b"\x1b[15~"),
        (KeyCode::F(12), NONE, b"\x1b[24~"),
        (KeyCode::Left, CTRL, b"\x1b[1;5D"),
        (KeyCode::Right, SHIFT, b"\x1b[1;2C"),
        (KeyCode::Up, ALT, b"\x1b[1;3A"),
        (KeyCode::Home, CTRL | SHIFT, b"\x1b[1;6H"),
        (KeyCode::Delete, CTRL, b"\x1b[3;5~"),
        (KeyCode::PageUp, SHIFT, b"\x1b[5;2~"),
        (KeyCode::F(5), SHIFT, b"\x1b[15;2~"),
        (KeyCode::F(1), CTRL, b"\x1b[1;5P"),
    ];
    for (code, mods, want) in table {
        assert_eq!(
            key(*code, *mods, &m).as_deref(),
            Some(*want),
            "{code:?} + {mods:?}"
        );
    }
}

#[test]
fn application_cursor_changes_only_unmodified_cursor_keys() {
    let m = InputModes {
        application_cursor: true,
        ..InputModes::default()
    };
    let table: &[(KeyCode, KeyModifiers, &[u8])] = &[
        (KeyCode::Up, NONE, b"\x1bOA"),
        (KeyCode::Down, NONE, b"\x1bOB"),
        (KeyCode::Right, NONE, b"\x1bOC"),
        (KeyCode::Left, NONE, b"\x1bOD"),
        (KeyCode::Home, NONE, b"\x1bOH"),
        (KeyCode::End, NONE, b"\x1bOF"),
        (KeyCode::Left, CTRL, b"\x1b[1;5D"),
        (KeyCode::PageUp, NONE, b"\x1b[5~"),
        (ch('a'), NONE, b"a"),
    ];
    for (code, mods, want) in table {
        assert_eq!(key(*code, *mods, &m).as_deref(), Some(*want), "{code:?}");
    }
}

#[test]
fn application_keypad_only_for_keypad_keys() {
    let m = InputModes {
        application_keypad: true,
        ..InputModes::default()
    };
    let pad = |c: KeyCode| encode_key(&KeyEvent::new(c).state(KeyEventState::KEYPAD), &m);
    assert_eq!(pad(ch('0')).as_deref(), Some(&b"\x1bOp"[..]));
    assert_eq!(pad(ch('9')).as_deref(), Some(&b"\x1bOy"[..]));
    assert_eq!(pad(ch('+')).as_deref(), Some(&b"\x1bOk"[..]));
    assert_eq!(pad(ch('-')).as_deref(), Some(&b"\x1bOm"[..]));
    assert_eq!(pad(ch('.')).as_deref(), Some(&b"\x1bOn"[..]));
    assert_eq!(pad(KeyCode::Enter).as_deref(), Some(&b"\x1bOM"[..]));
    assert_eq!(
        key(ch('5'), NONE, &m).as_deref(),
        Some(&b"5"[..]),
        "main row digit"
    );
    let off = InputModes::default();
    assert_eq!(
        encode_key(&KeyEvent::new(ch('5')).state(KeyEventState::KEYPAD), &off).as_deref(),
        Some(&b"5"[..])
    );
}

#[test]
fn releases_make_no_bytes_and_repeats_act_as_presses() {
    let m = InputModes::default();
    let ev = KeyEvent::new(ch('a')).kind(KeyEventKind::Release);
    assert_eq!(encode_key(&ev, &m), None);
    let ev = KeyEvent::new(KeyCode::Up).kind(KeyEventKind::Repeat);
    assert_eq!(encode_key(&ev, &m).as_deref(), Some(&b"\x1b[A"[..]));
    assert_eq!(key(KeyCode::CapsLock, NONE, &m), None);
}

#[test]
fn paste_is_wrapped_only_when_the_program_asked() {
    let on = InputModes {
        bracketed_paste: true,
        ..InputModes::default()
    };
    let off = InputModes::default();
    assert_eq!(encode_paste("ls -l\nx", &on), b"\x1b[200~ls -l\nx\x1b[201~");
    assert_eq!(encode_paste("a\x1b[201~b", &on), b"\x1b[200~ab\x1b[201~");
    assert_eq!(encode_paste("one\ntwo\r\nthree", &off), b"one\rtwo\rthree");
    assert_eq!(encode_paste("漢", &off), "漢".as_bytes());
}

#[test]
fn focus_only_when_reported() {
    let on = InputModes {
        focus_reporting: true,
        ..InputModes::default()
    };
    assert_eq!(encode_focus(true, &on).as_deref(), Some(&b"\x1b[I"[..]));
    assert_eq!(encode_focus(false, &on).as_deref(), Some(&b"\x1b[O"[..]));
    assert_eq!(encode_focus(true, &InputModes::default()), None);
}

fn mouse(kind: MouseEventKind, col: u16, row: u16, mods: KeyModifiers) -> MouseEvent {
    MouseEvent {
        kind,
        column: col,
        row,
        modifiers: mods,
    }
}

fn modes(mode: MouseProtocolMode, enc: MouseProtocolEncoding) -> InputModes {
    InputModes {
        mouse_mode: mode,
        mouse_encoding: enc,
        ..InputModes::default()
    }
}

#[test]
fn mouse_sgr_encoding() {
    use MouseButton::{Left, Middle, Right};
    use MouseEventKind::{Down, Drag, Moved, Scroll, Up};
    let m = modes(MouseProtocolMode::AnyMotion, MouseProtocolEncoding::Sgr);
    let table: &[(MouseEventKind, KeyModifiers, &[u8])] = &[
        (Down(Left), NONE, b"\x1b[<0;11;6M"),
        (Up(Left), NONE, b"\x1b[<0;11;6m"),
        (Down(Middle), NONE, b"\x1b[<1;11;6M"),
        (Down(Right), NONE, b"\x1b[<2;11;6M"),
        (Drag(Left), NONE, b"\x1b[<32;11;6M"),
        (Moved, NONE, b"\x1b[<35;11;6M"),
        (Scroll(ScrollDirection::Up), NONE, b"\x1b[<64;11;6M"),
        (Scroll(ScrollDirection::Down), NONE, b"\x1b[<65;11;6M"),
        (Down(Left), SHIFT, b"\x1b[<4;11;6M"),
        (Down(Left), ALT, b"\x1b[<8;11;6M"),
        (Down(Left), CTRL, b"\x1b[<16;11;6M"),
    ];
    for (kind, mods, want) in table {
        assert_eq!(
            encode_mouse(&mouse(*kind, 10, 5, *mods), &m).as_deref(),
            Some(*want),
            "{kind:?}"
        );
    }
    let far = encode_mouse(&mouse(Down(Left), 500, 300, NONE), &m);
    assert_eq!(
        far.as_deref(),
        Some(&b"\x1b[<0;501;301M"[..]),
        "SGR has no coordinate limit"
    );
}

#[test]
fn mouse_default_and_utf8_encodings() {
    use MouseButton::Left;
    use MouseEventKind::{Down, Up};
    let d = modes(
        MouseProtocolMode::PressRelease,
        MouseProtocolEncoding::Default,
    );
    // Cb = 32 + button, Cx = 32 + col + 1, Cy = 32 + row + 1.
    assert_eq!(
        encode_mouse(&mouse(Down(Left), 10, 5, NONE), &d).as_deref(),
        Some(&b"\x1b[M +&"[..])
    );
    // A release has no button: 3.
    assert_eq!(
        encode_mouse(&mouse(Up(Left), 10, 5, NONE), &d).as_deref(),
        Some(&b"\x1b[M#+&"[..])
    );
    assert_eq!(
        encode_mouse(&mouse(Down(Left), 10, 5, CTRL), &d).as_deref(),
        Some(&b"\x1b[M0+&"[..])
    );
    assert_eq!(
        encode_mouse(&mouse(Down(Left), 222, 0, NONE), &d).as_deref(),
        Some(&b"\x1b[M \xff!"[..])
    );
    assert_eq!(
        encode_mouse(&mouse(Down(Left), 223, 0, NONE), &d),
        None,
        "does not fit one byte"
    );

    let u = modes(MouseProtocolMode::PressRelease, MouseProtocolEncoding::Utf8);
    assert_eq!(
        encode_mouse(&mouse(Down(Left), 300, 5, NONE), &u).as_deref(),
        Some("\x1b[M \u{14d}&".as_bytes()),
        "301 + 32 = 333 as UTF-8"
    );
}

#[test]
fn mouse_events_are_filtered_by_mode() {
    use MouseButton::Left;
    use MouseEventKind::{Down, Drag, Moved, Scroll, Up};
    let wheel = Scroll(ScrollDirection::Up);
    let cases: [(MouseProtocolMode, [bool; 5]); 5] = [
        // down, up, drag, moved, wheel
        (MouseProtocolMode::None, [false, false, false, false, false]),
        (MouseProtocolMode::Press, [true, false, false, false, true]),
        (
            MouseProtocolMode::PressRelease,
            [true, true, false, false, true],
        ),
        (
            MouseProtocolMode::ButtonMotion,
            [true, true, true, false, true],
        ),
        (MouseProtocolMode::AnyMotion, [true, true, true, true, true]),
    ];
    for (mode, expect) in cases {
        let m = modes(mode, MouseProtocolEncoding::Sgr);
        for (kind, want) in [Down(Left), Up(Left), Drag(Left), Moved, wheel]
            .into_iter()
            .zip(expect)
        {
            assert_eq!(
                encode_mouse(&mouse(kind, 1, 1, NONE), &m).is_some(),
                want,
                "{mode:?} {kind:?}"
            );
        }
    }
}

#[test]
fn x10_mode_sends_no_modifiers() {
    let m = modes(MouseProtocolMode::Press, MouseProtocolEncoding::Default);
    let ev = mouse(MouseEventKind::Down(MouseButton::Left), 0, 0, CTRL | SHIFT);
    assert_eq!(encode_mouse(&ev, &m).as_deref(), Some(&b"\x1b[M !!"[..]));
}

#[test]
fn modes_come_from_the_screen() {
    let mut s = Screen::new(4, 20);
    s.feed(b"\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h");
    let m = s.input_modes();
    assert!(m.application_cursor && m.bracketed_paste && m.focus_reporting);
    assert_eq!(m.mouse_mode, MouseProtocolMode::PressRelease);
    assert_eq!(m.mouse_encoding, MouseProtocolEncoding::Sgr);
    assert_eq!(key(KeyCode::Up, NONE, &m).as_deref(), Some(&b"\x1bOA"[..]));
    s.feed(b"\x1b[?1l\x1b[?1000l");
    assert_eq!(
        key(KeyCode::Up, NONE, &s.input_modes()).as_deref(),
        Some(&b"\x1b[A"[..])
    );
}
