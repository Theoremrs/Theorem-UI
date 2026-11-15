mod common;

use common::*;
use keybinds::Key;
use theorem_workbench_composer::{CaretPhase, Event};
use theorem_workbench_core::Composition;

#[test]
fn preedit_is_drawn_at_the_caret_and_is_not_in_the_text() {
    let mut r = rig(40, 4);
    r.type_str("ab");
    r.compose(Composition::Start);
    r.compose(Composition::Update {
        text: "ni\u{3053}".into(),
    });
    assert_eq!(r.c.text(), "ab");
    assert!(
        r.dump().starts_with("\u{203A} abni\u{3053}"),
        "{}",
        r.dump()
    );
    assert!(r.c.is_composing());
    // The caret follows the composed text and stays steady.
    let c = r.c.caret(r.now + 5000.0);
    assert_eq!(c.phase, CaretPhase::Steady);
    assert_eq!(c.cell, Some((2 + 2 + 4, 0)), "ab + ni + a wide kana");
}

#[test]
fn the_committed_text_enters_once() {
    let mut r = rig(40, 4);
    r.compose(Composition::Start);
    r.compose(Composition::Update { text: "ka".into() });
    r.compose(Composition::End {
        text: "\u{304B}".into(),
    });
    assert_eq!(r.c.text(), "\u{304B}");
    assert!(!r.c.is_composing());
    // The browser also delivers the committed text as typed input.
    r.text("\u{304B}");
    assert_eq!(r.c.text(), "\u{304B}", "not inserted twice");
    // A later, real input of the same character is the person's.
    r.press(Key::Char('x'));
    r.text("\u{304B}");
    assert_eq!(r.c.text(), "\u{304B}x\u{304B}");
}

#[test]
fn typed_input_that_arrives_before_the_end_does_not_double_either() {
    let mut r = rig(40, 4);
    r.compose(Composition::Start);
    r.compose(Composition::Update { text: "x".into() });
    r.text("\u{4E2D}");
    assert_eq!(r.c.text(), "");
    r.compose(Composition::End {
        text: "\u{4E2D}".into(),
    });
    assert_eq!(r.c.text(), "\u{4E2D}");
}

#[test]
fn a_cancelled_composition_leaves_the_text_alone() {
    let mut r = rig(40, 4);
    r.type_str("q");
    r.compose(Composition::Start);
    r.compose(Composition::Update { text: "zz".into() });
    r.compose(Composition::End {
        text: String::new(),
    });
    assert_eq!(r.c.text(), "q");
    assert!(!r.dump().contains("zz"));
}

#[test]
fn enter_while_composing_never_submits() {
    let mut r = rig(40, 4);
    r.type_str("hi");
    r.compose(Composition::Start);
    r.compose(Composition::Update { text: "w".into() });
    let out = r.enter();
    assert!(out.events.is_empty());
    assert_eq!(r.c.text(), "hi");
    assert!(r.c.is_composing());
    r.compose(Composition::End { text: "w".into() });
    assert!(matches!(
        r.enter().events.as_slice(),
        [Event::Submit { .. }]
    ));
}

#[test]
fn a_composition_commit_is_one_undo_step_apart_from_typing() {
    let mut r = rig(40, 4);
    r.type_str("ab");
    r.compose(Composition::Start);
    r.compose(Composition::End {
        text: "\u{4E2D}\u{6587}".into(),
    });
    r.key(Key::Char('z'), keybinds::Mods::CMD);
    assert_eq!(r.c.text(), "ab");
}

#[test]
fn the_preedit_survives_a_resize_and_a_redraw() {
    let mut r = rig(40, 4);
    r.compose(Composition::Start);
    r.compose(Composition::Update { text: "abc".into() });
    r.resize(30, 5);
    assert!(r.dump().contains("abc"));
    assert!(r.c.is_composing());
}
