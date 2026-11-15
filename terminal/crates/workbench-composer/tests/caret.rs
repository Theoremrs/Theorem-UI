mod common;

use common::*;
use keybinds::Key;
use theorem_workbench_composer::{CaretPhase, DEFAULT_HOLD_MS};
use theorem_workbench_core::Composition;

#[test]
fn the_caret_is_steady_after_a_key_then_blinks_when_idle() {
    let mut r = rig(40, 4);
    r.type_str("hi");
    let at = r.now;
    let c = r.c.caret(at + 10.0);
    assert_eq!(c.phase, CaretPhase::Steady);
    assert_eq!(c.cell, Some((4, 0)));
    assert_eq!(
        r.c.caret(at + DEFAULT_HOLD_MS + 1.0).phase,
        CaretPhase::Blinking
    );
}

#[test]
fn reduced_motion_makes_it_steady_instead_of_blinking() {
    let mut r = rig(40, 4);
    r.c.set_reduced_motion(true);
    assert_eq!(r.c.caret(1e9).phase, CaretPhase::Steady);
}

#[test]
fn the_hold_period_is_a_parameter() {
    let mut r = rig(40, 4);
    r.c.set_hold_ms(100.0);
    r.press(Key::Char('a'));
    assert_eq!(r.c.caret(r.now + 50.0).phase, CaretPhase::Steady);
    assert_eq!(r.c.caret(r.now + 150.0).phase, CaretPhase::Blinking);
}

#[test]
fn the_caret_is_hidden_when_the_composer_does_not_own_input() {
    let mut r = rig(40, 4);
    r.c.set_focused(false);
    let c = r.c.caret(1e9);
    assert_eq!((c.phase, c.cell), (CaretPhase::Hidden, None));
    r.c.set_focused(true);
    r.c.set_window_focused(false);
    assert_eq!(r.c.caret(1e9).phase, CaretPhase::Hidden);
    r.c.set_window_focused(true);
    assert_eq!(r.c.caret(1e9).phase, CaretPhase::Blinking);
}

#[test]
fn the_model_list_owns_the_keys_and_hides_the_caret() {
    let mut r = rig(40, 8);
    r.c.open_models(
        vec![theorem_workbench_core::ModelChoice {
            model_ref: "m".into(),
            label: "Model".into(),
            context_tokens: None,
        }],
        0,
    );
    assert_eq!(r.c.caret(1e9).phase, CaretPhase::Hidden);
}

#[test]
fn composing_keeps_it_steady_however_long_ago_the_last_key_was() {
    let mut r = rig(40, 4);
    r.compose(Composition::Start);
    assert_eq!(r.c.caret(r.now + 1e9).phase, CaretPhase::Steady);
}

#[test]
fn no_caret_glyph_is_ever_in_the_draft() {
    let mut r = rig(40, 6);
    r.type_str("some text");
    r.compose(Composition::Start);
    r.compose(Composition::Update { text: "pre".into() });
    for glyph in ['\u{2588}', '\u{258D}', '\u{2502}', '\u{258F}', '|', '_'] {
        assert!(!r.c.text().contains(glyph));
        assert!(!r.c.serialize().to_string().contains(glyph));
    }
    assert_eq!(r.c.text(), "some text");
    assert_eq!(r.c.serialize()["text"], "some text");
    assert_eq!(r.c.draft().text, "some text");
    // And the drawn cells carry no block where the host's caret goes.
    let (x, y) = r.c.caret(r.now).cell.unwrap();
    let buf = r.buffer();
    assert_ne!(buf[(x, y)].symbol(), "\u{2588}");
}
