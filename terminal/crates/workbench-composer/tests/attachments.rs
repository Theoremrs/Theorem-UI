mod common;

use common::*;
use keybinds::Key;
use theorem_workbench_composer::{Event, Policy, SubmitMode};
use theorem_workbench_core::DraftAttachmentState::{Adding, Ready, Refused};

fn three() -> Vec<theorem_workbench_core::DraftAttachment> {
    vec![
        attachment("a", "notes.md", Ready),
        attachment("b", "photo.png", Adding),
        attachment("c", "huge.bin", Refused),
    ]
}

#[test]
fn chips_are_drawn_above_the_text_with_name_and_state() {
    let mut r = rig(80, 5);
    r.c.set_attachments(three());
    r.type_str("hi");
    let dump = r.dump();
    let rows: Vec<&str> = dump.lines().collect();
    assert_eq!(
        rows[0], "[notes.md ready] [photo.png adding\u{2026}] [huge.bin refused: too large]",
        "{dump}"
    );
    assert_eq!(rows[1], "\u{203A} hi");
}

#[test]
fn keyboard_path_into_the_chip_row_and_out() {
    let mut r = rig(80, 5);
    r.c.set_attachments(three());
    r.type_str("x");
    // Up from the first text line moves into the chip row.
    r.press(Key::Up);
    assert!(
        r.dump().contains("[\u{25B8}notes.md ready]"),
        "{}",
        r.dump()
    );
    r.press(Key::Right);
    assert!(r.dump().contains("[\u{25B8}photo.png"), "{}", r.dump());
    r.press(Key::Right);
    r.press(Key::Right);
    assert!(
        r.dump().contains("[\u{25B8}huge.bin"),
        "clamped at the last chip"
    );
    r.press(Key::Left);
    r.press(Key::Left);
    r.press(Key::Left);
    assert!(r.dump().contains("[\u{25B8}notes.md"));
    // Down returns to the text.
    r.press(Key::Down);
    assert!(!r.dump().contains('\u{25B8}'));
    r.type_str("y");
    assert_eq!(r.c.text(), "xy");
    // Esc returns too.
    r.press(Key::Up);
    assert!(r.dump().contains('\u{25B8}'));
    r.press(Key::Esc);
    assert!(!r.dump().contains('\u{25B8}'));
}

#[test]
fn up_on_a_later_line_moves_the_caret_not_the_chip() {
    let mut r = rig(80, 6);
    r.c.set_attachments(three());
    r.type_str("a");
    r.key(Key::Enter, shift());
    r.type_str("b");
    r.press(Key::Up);
    assert!(!r.dump().contains('\u{25B8}'));
    assert_eq!(r.c.caret_offset(), 1);
}

#[test]
fn backspace_or_delete_on_a_chip_asks_the_host_to_remove_it() {
    let mut r = rig(80, 5);
    r.c.set_attachments(three());
    r.press(Key::Up);
    r.press(Key::Right);
    let out = r.press(Key::Backspace);
    assert_eq!(out.events, vec![Event::AttachRemove { id: "b".into() }]);
    r.press(Key::Right);
    let out = r.press(Key::Delete);
    assert_eq!(out.events, vec![Event::AttachRemove { id: "c".into() }]);
    // The host answers with the shorter list; the chip choice stays in range.
    r.c.set_attachments(vec![attachment("a", "notes.md", Ready)]);
    assert!(r.dump().contains("[\u{25B8}notes.md"), "{}", r.dump());
    r.c.set_attachments(vec![]);
    assert!(!r.dump().contains("notes.md"));
    r.type_str("t");
    assert_eq!(r.c.text(), "t", "the keyboard is back in the text");
}

#[test]
fn an_attach_request_returns_attach_pick() {
    let mut r = rig(40, 4);
    assert_eq!(r.c.attach().events, vec![Event::AttachPick]);
}

#[test]
fn submit_carries_the_ready_ids_only() {
    let mut r = rig(80, 5);
    r.c.set_attachments(vec![
        attachment("a", "notes.md", Ready),
        attachment("c", "huge.bin", Refused),
        attachment("d", "b.txt", Ready),
    ]);
    r.type_str("go");
    let out = r.enter();
    match submitted(&out) {
        Some(Event::Submit { attachments, .. }) => {
            assert_eq!(attachments, &vec!["a".to_owned(), "d".to_owned()])
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_attachment_alone_is_a_sendable_draft() {
    let mut r = rig(80, 5);
    r.c.set_attachments(vec![attachment("a", "notes.md", Ready)]);
    assert!(submitted(&r.enter()).is_some());
    let mut r = rig(80, 5);
    r.c.set_attachments(vec![attachment("c", "huge.bin", Refused)]);
    assert!(
        submitted(&r.enter()).is_none(),
        "a refused file is not an attachment"
    );
}

#[test]
fn enter_does_not_submit_while_an_attachment_is_adding_and_the_footer_says_why() {
    let mut r = rig(80, 5);
    r.c.set_attachments(vec![
        attachment("a", "notes.md", Ready),
        attachment("b", "photo.png", Adding),
    ]);
    r.type_str("go");
    let out = r.enter();
    assert!(out.events.is_empty());
    assert_eq!(r.c.text(), "go");
    assert!(
        r.dump()
            .contains("waiting for 1 attachment to finish adding"),
        "{}",
        r.dump()
    );
    // The host finishes it; Enter now sends, and the notice is gone.
    r.c.set_attachments(vec![
        attachment("a", "notes.md", Ready),
        attachment("b", "photo.png", Ready),
    ]);
    assert!(!r.dump().contains("waiting"));
    assert!(submitted(&r.enter()).is_some());
}

#[test]
fn a_blocked_policy_refuses_enter_whatever_the_attachments() {
    let mut r = rig(80, 5);
    r.c.set_status(theorem_workbench_composer::ComposerStatus {
        policy: Policy::Blocked {
            reason: "offline".into(),
        },
        ..Default::default()
    });
    r.type_str("go");
    assert!(submitted(&r.enter()).is_none());
    let _ = SubmitMode::Send;
}

#[test]
fn chips_clip_at_narrow_widths_and_keep_the_chosen_one_visible() {
    let mut r = rig(20, 5);
    r.c.set_attachments(three());
    let dump = r.dump();
    assert!(dump.lines().next().unwrap().chars().count() <= 20, "{dump}");
    r.press(Key::Up);
    for _ in 0..2 {
        r.press(Key::Right);
    }
    assert!(
        r.dump().lines().next().unwrap().contains('\u{25B8}'),
        "{}",
        r.dump()
    );
}
