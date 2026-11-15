mod common;

use common::*;
use keybinds::{Key, Mods};
use theorem_workbench_composer::{ComposerStatus, Event, Policy, SubmitMode};
use theorem_workbench_core::{DraftAttachmentState::Ready, ModelChoice, SourceReference};

fn status(policy: Policy) -> ComposerStatus {
    ComposerStatus {
        policy,
        model: Some("DeepSeek V4.1 Flash".into()),
        effort: Some("high".into()),
        context_percent: Some(42),
    }
}

fn last_row(r: &Rig) -> String {
    r.dump().lines().last().unwrap().to_owned()
}

#[test]
fn the_footer_says_what_enter_does_and_the_model_on_the_right() {
    let mut r = rig(80, 3);
    r.c.set_status(status(Policy::Idle));
    let row = last_row(&r);
    assert!(
        row.starts_with("Enter sends, Shift+Enter new line"),
        "{row}"
    );
    assert!(
        row.ends_with("DeepSeek V4.1 Flash \u{00B7} high \u{00B7} 42% context"),
        "{row}"
    );
    r.c.set_status(status(Policy::Running { can_steer: true }));
    assert!(last_row(&r).starts_with("Enter steers the run, Esc stops"));
    r.c.set_status(status(Policy::Blocked {
        reason: "Sign in to send".into(),
    }));
    assert!(last_row(&r).starts_with("Sign in to send"));
}

#[test]
fn the_right_side_goes_first_when_narrow() {
    let mut r = rig(40, 3);
    r.c.set_status(status(Policy::Idle));
    let row = last_row(&r);
    assert_eq!(row, "Enter sends, Shift+Enter new line", "{row}");
    r.resize(30, 3);
    assert_eq!(last_row(&r), "Enter sends, Shift+Enter: line");
    r.resize(20, 3);
    assert_eq!(
        last_row(&r),
        "Enter sends",
        "worded shorter before it is cut"
    );
    r.c.set_status(status(Policy::Blocked {
        reason: "Sign in to send messages".into(),
    }));
    let row = last_row(&r);
    assert!(
        row.chars().count() <= 20 && row.ends_with('\u{2026}'),
        "{row}"
    );
}

#[test]
fn enter_steers_a_running_run_and_sends_when_idle() {
    let mut r = rig(60, 4);
    r.c.set_status(status(Policy::Running { can_steer: true }));
    r.type_str("more");
    match submitted(&r.enter()) {
        Some(Event::Submit { mode, .. }) => assert_eq!(*mode, SubmitMode::Steer),
        o => panic!("{o:?}"),
    }
    r.c.set_status(status(Policy::Idle));
    match submitted(&r.enter()) {
        Some(Event::Submit { mode, .. }) => assert_eq!(*mode, SubmitMode::Send),
        o => panic!("{o:?}"),
    }
}

#[test]
fn a_run_that_cannot_steer_takes_no_submit_and_says_so() {
    let mut r = rig(80, 4);
    r.c.set_status(status(Policy::Running { can_steer: false }));
    r.type_str("more");
    assert!(r.enter().events.is_empty());
    assert_eq!(r.c.text(), "more");
    assert!(
        last_row(&r).contains("cannot take input"),
        "{}",
        last_row(&r)
    );
}

#[test]
fn blocked_returns_nothing_and_keeps_the_draft() {
    let mut r = rig(60, 4);
    r.c.set_status(status(Policy::Blocked {
        reason: "offline".into(),
    }));
    r.type_str("hello");
    let out = r.enter();
    assert!(out.events.is_empty());
    assert_eq!(r.c.text(), "hello");
}

#[test]
fn take_returns_the_draft_and_empties_the_composer_and_its_undo_history() {
    let mut r = rig(60, 6);
    r.c.set_attachments(vec![attachment("a", "n.md", Ready)]);
    r.type_str("see ");
    r.c.add_reference(SourceReference {
        path: "x.rs".into(),
        range: None,
        label: None,
        excerpt: None,
        excerpt_cut: false,
    })
    .expect("placed");
    let d = r.c.take();
    assert_eq!(d.text, "see @x.rs ");
    assert_eq!(d.references.len(), 1);
    assert_eq!(d.attachments.len(), 1);
    assert_eq!(r.c.text(), "");
    assert!(r.c.references().is_empty());
    assert!(r.c.attachments().is_empty());
    r.key(Key::Char('z'), Mods::CMD);
    assert_eq!(r.c.text(), "", "undo history was dropped");
}

#[test]
fn put_back_returns_the_draft_with_references_and_attachments() {
    let mut r = rig(60, 6);
    r.c.set_attachments(vec![attachment("a", "n.md", Ready)]);
    r.type_str("see ");
    r.c.add_reference(SourceReference {
        path: "x.rs".into(),
        range: None,
        label: None,
        excerpt: Some("e".into()),
        excerpt_cut: false,
    })
    .expect("placed");
    r.type_str("end");
    let before = r.c.draft();
    let d = r.c.take();
    assert!(r.c.put_back(d));
    assert_eq!(r.c.draft(), before);
    assert_eq!(r.c.references()[0].excerpt.as_deref(), Some("e"));
    // The restored reference is atomic.
    r.press(Key::Home);
    r.key(Key::Right, Mods::ALT);
    r.key(Key::Right, Mods::ALT);
    assert!(r.c.caret_offset() >= "see @x.rs".chars().count());
    // The caret is where it was.
    let mut r2 = rig(60, 6);
    r2.type_str("abc");
    r2.press(Key::Left);
    let d = r2.c.take();
    r2.c.put_back(d);
    assert_eq!(r2.c.caret_offset(), 2);
}

#[test]
fn put_back_does_not_overwrite_a_newer_draft() {
    let mut r = rig(60, 6);
    r.type_str("first");
    let d = r.c.take();
    r.type_str("second");
    assert!(!r.c.put_back(d));
    assert_eq!(r.c.text(), "second");
}

#[test]
fn an_uncertain_send_keeps_the_composer_empty() {
    let mut r = rig(60, 6);
    r.type_str("maybe sent");
    let _ = r.c.take();
    // The panel does not call put_back; nothing returns on its own.
    r.resize(60, 6);
    assert_eq!(r.c.text(), "");
}

#[test]
fn serialize_and_restore_round_trip_text_caret_selection_and_references() {
    let mut r = rig(60, 6);
    r.type_str("ask ");
    r.c.add_reference(SourceReference {
        path: "src/a.rs".into(),
        range: None,
        label: Some("a".into()),
        excerpt: None,
        excerpt_cut: false,
    })
    .expect("placed");
    r.type_str("about \u{1F600} \u{4E2D}\u{6587}");
    r.press(Key::Left);
    r.key(Key::Left, shift());
    r.key(Key::Left, shift());
    let value = r.c.serialize();
    let json = serde_json::to_string(&value).unwrap();
    let mut b = rig(60, 6);
    assert!(b.c.restore(&serde_json::from_str(&json).unwrap()));
    assert_eq!(b.c.text(), r.c.text());
    assert_eq!(b.c.selection(), r.c.selection());
    assert_eq!(b.c.caret_offset(), r.c.caret_offset());
    assert_eq!(b.c.references(), r.c.references());
    assert_eq!(b.c.serialize(), value);
    // The restored reference is atomic.
    b.press(Key::Home);
    for _ in 0..5 {
        b.press(Key::Right);
    }
    assert_eq!(b.c.caret_offset(), "ask @src/a.rs".chars().count());
}

#[test]
fn restore_takes_a_plain_string_and_refuses_nonsense() {
    let mut r = rig(60, 6);
    assert!(r.c.restore(&serde_json::json!("half a thought")));
    assert_eq!(r.c.text(), "half a thought");
    assert!(!r.c.restore(&serde_json::json!({"nope": 1})));
    assert!(!r.c.restore(&serde_json::json!(7)));
}

#[test]
fn a_theme_change_and_a_resize_lose_nothing() {
    let mut r = rig(40, 5);
    r.type_str("alpha beta gamma delta epsilon zeta eta theta iota");
    r.press(Key::Home);
    r.key(Key::Right, shift());
    r.key(Key::Right, shift());
    let before = (r.c.text(), r.c.selection(), r.c.caret_offset());
    r.resize(15, 3);
    r.resize(60, 8);
    // Drawing under another theme changes only colours.
    let mut buf = ratatui::buffer::Buffer::empty(r.area);
    r.c.draw(r.area, &mut buf, &theorem_workbench_core::Theme::plain());
    assert_eq!(before, (r.c.text(), r.c.selection(), r.c.caret_offset()));
    // Undo history survives.
    r.press(Key::End);
    r.type_str("!");
    r.resize(20, 4);
    r.key(Key::Char('z'), Mods::CMD);
    assert!(!r.c.text().ends_with('!'));
}

#[test]
fn up_on_an_empty_draft_recalls_the_last_message() {
    let mut r = rig(60, 5);
    assert_eq!(r.press(Key::Up).events, vec![Event::RecallLast]);
    r.type_str("x");
    r.press(Key::Up);
    assert_eq!(r.c.caret_offset(), 0, "with a draft, Up goes to its start");
    assert!(r.press(Key::Up).events.is_empty());
}

#[test]
fn a_loaded_message_submits_as_an_edit_and_esc_untouched_returns_to_empty() {
    let mut r = rig(60, 5);
    r.c.load_for_edit("fix the build", vec![]);
    assert!(r.c.is_editing());
    assert!(last_row(&r).starts_with("Enter sends the edit, Esc cancels"));
    match submitted(&r.enter()) {
        Some(Event::Submit { mode, text, .. }) => {
            assert_eq!(*mode, SubmitMode::Edit);
            assert_eq!(text, "fix the build");
        }
        o => panic!("{o:?}"),
    }
    assert!(r.press(Key::Esc).handled);
    assert_eq!(r.c.text(), "");
    assert!(!r.c.is_editing());
}

#[test]
fn esc_on_a_touched_loaded_message_is_the_panels() {
    let mut r = rig(60, 5);
    r.c.load_for_edit("fix", vec![]);
    r.type_str("!");
    assert!(!r.press(Key::Esc).handled);
    assert_eq!(r.c.text(), "fix!");
}

#[test]
fn a_loaded_message_keeps_its_references_atomic() {
    let mut r = rig(60, 5);
    let reference = SourceReference {
        path: "a.rs".into(),
        range: None,
        label: None,
        excerpt: Some("x".into()),
        excerpt_cut: false,
    };
    r.c.load_for_edit("look at @a.rs now", vec![reference.clone()]);
    assert_eq!(r.c.references(), vec![reference.clone()]);
    // A reference the text does not show is added, so it is not lost.
    let other = SourceReference {
        path: "b.rs".into(),
        range: None,
        label: None,
        excerpt: None,
        excerpt_cut: false,
    };
    r.c.load_for_edit("plain", vec![other.clone()]);
    assert_eq!(r.c.text(), "plain @b.rs ");
    assert_eq!(r.c.references(), vec![other]);
}

#[test]
fn the_model_list_returns_model_chosen_and_esc_closes_it() {
    let mut r = rig(60, 8);
    let models = vec![
        ModelChoice {
            model_ref: "a".into(),
            label: "Alpha".into(),
            context_tokens: Some(200_000),
        },
        ModelChoice {
            model_ref: "b".into(),
            label: "Beta".into(),
            context_tokens: None,
        },
    ];
    r.c.open_models(models.clone(), 1);
    let h = r.c.desired_height(60, 3);
    r.resize(60, h);
    // The chosen row is told by its letters' colour; nothing marks it and the models have no icon.
    assert!(r.chosen("Beta"), "{}", r.dump());
    assert!(!r.chosen("Alpha"));
    assert!(!r.dump().contains('\u{25B8}'), "{}", r.dump());
    assert!(r.icons().is_empty());
    assert!(r.dump().contains("Alpha  (200k context)"), "{}", r.dump());
    r.press(Key::Up);
    // Typing does nothing while the list owns the keys.
    r.press(Key::Char('q'));
    assert_eq!(r.c.text(), "");
    let out = r.enter();
    assert_eq!(
        out.events,
        vec![Event::ModelChosen {
            model_ref: "a".into()
        }]
    );
    assert!(!r.c.has_popup());
    r.c.open_models(models, 0);
    r.press(Key::Esc);
    assert!(!r.c.has_popup());
}
