mod common;

use common::*;
use keybinds::{Key, Mods};
use theorem_workbench_composer::{Event, reference_token};
use theorem_workbench_core::SourceReference;

fn file(path: &str) -> SourceReference {
    SourceReference {
        path: path.into(),
        range: None,
        label: None,
        excerpt: None,
    }
}

fn want(out: &theorem_workbench_composer::Response) -> Option<(String, u64)> {
    out.events.iter().rev().find_map(|e| match e {
        Event::WantFiles { query, token } => Some((query.clone(), *token)),
        _ => None,
    })
}

fn open_files(r: &mut Rig, typed: &str, paths: &[&str]) -> u64 {
    let mut token = 0;
    for ch in typed.chars() {
        let out = r.press(Key::Char(ch));
        if let Some((_, t)) = want(&out) {
            token = t;
        }
    }
    r.c.files_found(token, paths.iter().map(|p| (*p).to_owned()).collect());
    token
}

#[test]
fn an_at_at_a_word_start_opens_the_popup_and_asks_for_files() {
    let mut r = rig(60, 10);
    r.type_str("see ");
    let out = r.press(Key::Char('@'));
    assert_eq!(want(&out).map(|w| w.0), Some(String::new()));
    assert!(r.c.has_popup());
    let out = r.press(Key::Char('s'));
    assert_eq!(want(&out).map(|w| w.0), Some("s".to_owned()));
    let out = r.press(Key::Char('r'));
    assert_eq!(want(&out).map(|w| w.0), Some("sr".to_owned()));
}

#[test]
fn an_at_inside_a_word_is_not_a_reference() {
    let mut r = rig(60, 10);
    let out = r.type_and_events("me@example");
    assert!(out.is_empty());
    assert!(!r.c.has_popup());
}

impl Rig {
    fn type_and_events(&mut self, s: &str) -> Vec<Event> {
        let mut all = Vec::new();
        for ch in s.chars() {
            all.extend(self.press(Key::Char(ch)).events);
        }
        all.into_iter()
            .filter(|e| matches!(e, Event::WantFiles { .. }))
            .collect()
    }
}

#[test]
fn a_stale_answer_is_ignored() {
    let mut r = rig(60, 10);
    r.press(Key::Char('@'));
    let first = want(&r.press(Key::Char('a'))).unwrap().1;
    let second = want(&r.press(Key::Char('b'))).unwrap().1;
    assert_ne!(first, second);
    r.c.files_found(first, vec!["stale.rs".into()]);
    assert!(!r.dump().contains("stale.rs"), "{}", r.dump());
    r.c.files_found(second, vec!["fresh.rs".into()]);
    assert!(r.dump().contains("fresh.rs"), "{}", r.dump());
}

#[test]
fn up_and_down_move_and_enter_chooses() {
    let mut r = rig(60, 10);
    open_files(&mut r, "@m", &["src/main.rs", "src/mod.rs", "README.md"]);
    assert!(r.dump().contains("\u{25B8} src/main.rs"), "{}", r.dump());
    r.press(Key::Down);
    assert!(r.dump().contains("\u{25B8} src/mod.rs"));
    r.press(Key::Down);
    r.press(Key::Down);
    assert!(r.dump().contains("\u{25B8} src/main.rs"), "wraps");
    r.press(Key::Up);
    assert!(r.dump().contains("\u{25B8} README.md"), "wraps up");
    r.press(Key::Up);
    let out = r.enter();
    assert!(
        out.events
            .iter()
            .all(|e| !matches!(e, Event::Submit { .. }))
    );
    assert_eq!(r.c.text(), "@src/mod.rs ");
    assert!(!r.c.has_popup());
    assert_eq!(r.c.references(), vec![file("src/mod.rs")]);
}

#[test]
fn tab_chooses_too() {
    let mut r = rig(60, 10);
    open_files(&mut r, "@", &["a.rs"]);
    r.press(Key::Tab);
    assert_eq!(r.c.text(), "@a.rs ");
}

#[test]
fn esc_dismisses_the_popup_and_leaves_the_typed_text() {
    let mut r = rig(60, 10);
    open_files(&mut r, "@ma", &["main.rs"]);
    let out = r.press(Key::Esc);
    assert!(out.handled);
    assert!(!r.c.has_popup());
    assert_eq!(r.c.text(), "@ma");
    assert!(r.c.references().is_empty());
    // It does not come back for the same @ as the person keeps typing.
    r.press(Key::Char('i'));
    assert!(!r.c.has_popup());
    // A new @ opens it again.
    r.press(Key::Char(' '));
    r.press(Key::Char('@'));
    assert!(r.c.has_popup());
}

#[test]
fn enter_with_no_matches_still_sends() {
    let mut r = rig(60, 10);
    r.type_str("ask ");
    open_files(&mut r, "@zz", &[]);
    assert!(r.dump().contains("No matches"));
    let out = r.enter();
    assert!(submitted(&out).is_some());
}

#[test]
fn a_chosen_reference_is_atomic_and_backspace_removes_it_whole() {
    let mut r = rig(60, 10);
    r.type_str("see ");
    open_files(&mut r, "@ma", &["src/main.rs"]);
    r.enter();
    r.type_str("now");
    assert_eq!(r.c.text(), "see @src/main.rs now");
    // The caret cannot enter the reference.
    for _ in 0..3 {
        r.press(Key::Left);
    }
    r.press(Key::Left);
    assert_eq!(r.c.caret_offset(), 16, "after the space, before 'now'");
    r.press(Key::Left);
    assert_eq!(
        r.c.caret_offset(),
        4,
        "jumped over the reference to its start"
    );
    r.press(Key::Right);
    assert_eq!(r.c.caret_offset(), 16, "jumped to its end");
    r.press(Key::Backspace);
    assert_eq!(r.c.text(), "see  now", "removed whole");
    assert!(r.c.references().is_empty());
}

#[test]
fn undo_restores_a_removed_reference_with_its_reference() {
    let mut r = rig(60, 10);
    open_files(&mut r, "@ma", &["src/main.rs"]);
    r.enter();
    r.press(Key::Left);
    r.press(Key::Backspace);
    assert_eq!(r.c.text(), " ");
    assert!(r.c.references().is_empty());
    r.key(Key::Char('z'), Mods::CMD);
    assert_eq!(r.c.text(), "@src/main.rs ");
    assert_eq!(r.c.references(), vec![file("src/main.rs")]);
    // And the restored range is atomic again.
    r.press(Key::Home);
    r.press(Key::Right);
    assert_eq!(r.c.caret_offset(), "@src/main.rs".chars().count());
    // Redo removes it again.
    r.key(Key::Char('Z'), Mods::CMD);
    assert!(r.c.references().is_empty());
    // Undo back past the choice: the typed query is left and no reference.
    for _ in 0..6 {
        r.key(Key::Char('z'), Mods::CMD);
    }
    assert_eq!(r.c.text(), "");
    assert!(r.c.references().is_empty());
    // Redo forward to the choice: the text and its reference return.
    for _ in 0..12 {
        r.key(Key::Char('Z'), Mods::CMD);
        if r.c.text() == "@src/main.rs " {
            break;
        }
    }
    assert_eq!(r.c.text(), "@src/main.rs ");
    assert_eq!(r.c.references(), vec![file("src/main.rs")]);
}

#[test]
fn edits_around_a_reference_leave_it_alone() {
    let mut r = rig(60, 10);
    r.type_str("a ");
    open_files(&mut r, "@m", &["m.rs"]);
    r.enter();
    r.press(Key::Home);
    r.type_str("XY ");
    r.press(Key::End);
    r.type_str("tail");
    assert_eq!(r.c.text(), "XY a @m.rs tail");
    assert_eq!(r.c.references(), vec![file("m.rs")]);
    r.press(Key::Home);
    r.key(Key::Right, Mods::ALT);
    r.key(Key::Right, Mods::ALT);
    assert_eq!(r.c.references().len(), 1);
}

#[test]
fn add_reference_inserts_at_the_caret_for_ask_about_this() {
    let mut r = rig(60, 10);
    r.type_str("what is");
    r.c.add_reference(SourceReference {
        path: "src/lib.rs".into(),
        range: Some(theorem_workbench_core::results::Range {
            start: theorem_workbench_core::results::Position {
                line: 9,
                character: 0,
            },
            end: theorem_workbench_core::results::Position {
                line: 12,
                character: 0,
            },
        }),
        label: Some("parse".into()),
        excerpt: Some("fn parse() {}".into()),
    });
    assert_eq!(r.c.text(), "what is @src/lib.rs:10 ");
    let refs = r.c.references();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].excerpt.as_deref(), Some("fn parse() {}"));
    assert_eq!(reference_token(&refs[0]), "@src/lib.rs:10");
    let out = r.enter();
    match submitted(&out) {
        Some(Event::Submit { references, .. }) => assert_eq!(references, &refs),
        o => panic!("{o:?}"),
    }
}

#[test]
fn references_come_back_in_text_order() {
    let mut r = rig(60, 10);
    r.c.add_reference(file("b.rs"));
    r.press(Key::Home);
    r.c.add_reference(file("a.rs"));
    let paths: Vec<String> = r.c.references().into_iter().map(|x| x.path).collect();
    assert_eq!(paths, ["a.rs", "b.rs"]);
}

#[test]
fn a_reference_chosen_by_pointer() {
    let mut r = rig(60, 10);
    open_files(&mut r, "@", &["one.rs", "two.rs"]);
    // The popup sits under the text row: row 1 is "one.rs", row 2 "two.rs".
    let h = r.c.desired_height(60, 5);
    r.resize(60, h);
    r.click(4, 2, 1);
    assert_eq!(r.c.text(), "@two.rs ");
}

#[test]
fn the_reference_text_is_drawn_in_the_atomic_role() {
    let mut r = rig(60, 6);
    r.c.add_reference(file("x.rs"));
    let buf = r.buffer();
    let theme = theorem_workbench_core::Theme::plain();
    let cell = &buf[(2, 0)];
    assert_eq!(cell.symbol(), "@");
    assert_eq!(cell.style().add_modifier, theme.atomic.add_modifier);
}
