mod common;

use common::*;
use keybinds::{Key, Mods};
use theorem_workbench_composer::{Event, SubmitMode};
use theorem_workbench_core::PointerKind;

#[test]
fn enter_submits_the_trimmed_text_and_keeps_the_draft() {
    let mut r = rig(40, 6);
    r.type_str("  hello ");
    let out = r.enter();
    assert!(matches!(
        submitted(&out),
        Some(Event::Submit { text, mode: SubmitMode::Send, .. }) if text == "hello"
    ));
    assert_eq!(r.c.text(), "  hello ", "Submit does not clear the draft");
}

#[test]
fn an_empty_or_blank_draft_submits_nothing() {
    let mut r = rig(40, 6);
    assert!(r.enter().events.is_empty());
    r.type_str("  ");
    assert!(submitted(&r.enter()).is_none());
    assert_eq!(r.c.text(), "  ");
}

#[test]
fn shift_alt_enter_and_ctrl_j_insert_a_newline_and_do_not_submit() {
    let mut r = rig(40, 6);
    r.type_str("a");
    assert!(submitted(&r.key(Key::Enter, shift())).is_none());
    r.type_str("b");
    assert!(submitted(&r.key(Key::Enter, Mods::ALT)).is_none());
    r.type_str("c");
    assert!(submitted(&r.key(Key::Char('j'), ctrl())).is_none());
    r.type_str("d");
    assert_eq!(r.c.text(), "a\nb\nc\nd");
}

#[test]
fn the_height_grows_with_the_content_then_scrolls() {
    let mut r = rig(20, 3);
    // chips 0 + text 1 + footer 1
    assert_eq!(r.c.desired_height(20, 5), 2);
    for _ in 0..3 {
        r.key(Key::Enter, shift());
    }
    assert_eq!(r.c.desired_height(20, 5), 5);
    for _ in 0..10 {
        r.key(Key::Enter, shift());
    }
    assert_eq!(
        r.c.desired_height(20, 5),
        6,
        "five text rows and the footer"
    );
    // The text is as tall as the area and scrolled to the caret.
    r.type_str("last");
    r.resize(20, 4);
    assert!(r.dump().contains("last"), "{}", r.dump());
}

#[test]
fn a_long_line_wraps_and_counts_toward_the_height() {
    let r = {
        let mut r = rig(12, 6);
        r.type_str("aaaa bbbb cccc dddd");
        r
    };
    // 12 columns less the prompt is 10: two words per row, so two text rows and the footer.
    assert_eq!(r.c.desired_height(12, 8), 3);
    assert_eq!(r.c.desired_height(40, 8), 2);
}

#[test]
fn there_is_no_line_number_gutter() {
    let mut r = rig(30, 6);
    r.type_str("one");
    r.key(Key::Enter, shift());
    r.type_str("two");
    let dump = r.dump();
    let rows: Vec<&str> = dump.lines().collect();
    assert_eq!(rows[0], "\u{203A} one", "{dump}");
    assert_eq!(rows[1], "  two", "{dump}");
}

#[test]
fn the_gutter_stays_out_when_the_line_count_gains_a_digit() {
    let mut r = rig(30, 14);
    for i in 0..11 {
        r.type_str(&format!("l{i}"));
        r.key(Key::Enter, shift());
    }
    let dump = r.dump();
    assert!(
        dump.lines().next().unwrap().starts_with("\u{203A} l"),
        "{dump}"
    );
    assert!(
        !dump.lines().any(|l| l.trim_start().starts_with("1 ")),
        "{dump}"
    );
}

#[test]
fn shift_arrows_select_and_typing_replaces() {
    let mut r = rig(40, 4);
    r.type_str("hello world");
    for _ in 0..5 {
        r.key(Key::Left, shift());
    }
    assert_eq!(r.c.selection(), Some((6, 11)));
    r.type_str("X");
    assert_eq!(r.c.text(), "hello X");
}

#[test]
fn word_and_line_motions_and_select_all() {
    let mut r = rig(40, 4);
    r.type_str("one two three");
    r.key(Key::Left, Mods::ALT | Mods::SHIFT);
    assert_eq!(r.c.selection(), Some((8, 13)));
    r.key(Key::Home, shift());
    assert_eq!(r.c.selection(), Some((0, 13)));
    r.press(Key::End);
    r.key(Key::Char('a'), ctrl());
    assert_eq!(r.c.selection(), Some((0, 13)));
}

#[test]
fn double_click_selects_a_word_and_a_drag_selects_a_span() {
    let mut r = rig(40, 4);
    r.type_str("alpha beta gamma");
    // Text starts after the two-cell prompt: "beta" is at columns 8..12.
    r.click(9, 0, 2);
    assert_eq!(r.c.selection(), Some((6, 10)));
    r.click(2, 0, 1);
    r.pointer(PointerKind::Move, 7, 0, 1);
    assert_eq!(r.c.selection(), Some((0, 5)));
    r.pointer(
        PointerKind::Up(theorem_workbench_core::Button::Left),
        7,
        0,
        1,
    );
}

#[test]
fn copy_and_cut_return_the_text_and_cut_removes_it() {
    let mut r = rig(40, 4);
    r.type_str("cut me");
    r.key(Key::Char('a'), Mods::CMD);
    let out = r.key(Key::Char('c'), Mods::CMD);
    assert_eq!(
        out.events,
        vec![Event::Copy {
            text: "cut me".into()
        }]
    );
    assert_eq!(r.c.text(), "cut me");
    let out = r.key(Key::Char('x'), Mods::CMD);
    assert_eq!(
        out.events,
        vec![Event::Cut {
            text: "cut me".into()
        }]
    );
    assert_eq!(r.c.text(), "cut me", "nothing leaves before the write");
    r.c.cut_finished(true);
    assert_eq!(r.c.text(), "");
    // The undo brings the cut text back.
    r.key(Key::Char('z'), Mods::CMD);
    assert_eq!(r.c.text(), "cut me");
}

#[test]
fn a_cut_whose_write_failed_leaves_the_text_and_says_so() {
    let mut r = rig(40, 4);
    r.type_str("keep me");
    r.key(Key::Char('a'), Mods::CMD);
    r.key(Key::Char('x'), Mods::CMD);
    r.c.cut_finished(false);
    assert_eq!(r.c.text(), "keep me");
    assert_eq!(r.c.notice(), Some("Not cut"));
}

#[test]
fn a_cut_whose_text_changed_before_the_write_returned_is_not_applied() {
    let mut r = rig(40, 4);
    r.type_str("abc");
    r.key(Key::Char('a'), Mods::CMD);
    r.key(Key::Char('x'), Mods::CMD);
    // The person types over the selection while the write is in flight.
    r.type_str("z");
    r.c.cut_finished(true);
    assert_eq!(r.c.text(), "z");
    assert_eq!(r.c.notice(), Some("Not cut"));
}

#[test]
fn copy_with_nothing_selected_is_the_panels() {
    let mut r = rig(40, 4);
    r.type_str("x");
    let out = r.key(Key::Char('c'), ctrl());
    assert!(
        !out.handled,
        "Ctrl+C stops a run or clears; the composer does not use it"
    );
}

#[test]
fn the_paste_key_asks_the_host_for_the_clipboard() {
    let mut r = rig(40, 4);
    let out = r.key(Key::Char('v'), Mods::CMD);
    assert_eq!(out.events, vec![Event::ReadClipboard]);
}

#[test]
fn a_paste_with_newlines_is_one_undo_step_and_never_submits() {
    let mut r = rig(40, 8);
    r.type_str("before ");
    let out = r.paste("rm -rf /\nsudo reboot\n");
    assert!(out.events.is_empty(), "{:?}", out.events);
    assert_eq!(r.c.text(), "before rm -rf /\nsudo reboot\n");
    r.key(Key::Char('z'), Mods::CMD);
    assert_eq!(r.c.text(), "before ");
    r.key(Key::Char('Z'), Mods::CMD);
    assert_eq!(
        r.c.text(),
        "before rm -rf /\nsudo reboot\n",
        "redo with an upper-case Z"
    );
    assert!(
        submitted(&r.enter()).is_some(),
        "only the person's Enter sends"
    );
}

#[test]
fn undo_and_redo_run_through_the_session() {
    let mut r = rig(40, 4);
    r.type_str("abc");
    r.send(theorem_workbench_composer::Input::Key(
        keybinds::KeyInput::new(Key::Char('z'), Mods::CTRL),
    ));
    assert_eq!(r.c.text(), "");
    r.key(Key::Char('y'), ctrl());
    assert_eq!(r.c.text(), "abc");
    r.key(Key::Char('z'), ctrl());
    r.key(Key::Char('Z'), ctrl());
    assert_eq!(r.c.text(), "abc", "upper-case Z is redo");
}

#[test]
fn emacs_line_keys() {
    let mut r = rig(40, 4);
    r.type_str("abc def");
    r.key(Key::Char('u'), ctrl());
    assert_eq!(r.c.text(), "");
    r.type_str("abc def");
    r.key(Key::Home, Mods::empty());
    r.key(Key::Char('k'), ctrl());
    assert_eq!(r.c.text(), "");
    r.type_str("xyz");
    r.press(Key::Home);
    r.key(Key::Char('e'), ctrl());
    assert_eq!(r.c.caret_offset(), 3);
}

#[test]
fn keys_that_belong_to_the_panel_are_not_handled() {
    let mut r = rig(40, 4);
    for (k, m) in [
        (Key::Esc, Mods::empty()),
        (Key::Tab, Mods::empty()),
        (Key::PageUp, Mods::empty()),
        (Key::PageDown, Mods::empty()),
        (Key::Char('['), Mods::ALT),
        (Key::Char(']'), Mods::ALT),
        (Key::Char('l'), ctrl()),
        (Key::Char('o'), ctrl()),
    ] {
        assert!(!r.key(k, m).handled, "{k:?} {m:?}");
    }
}

fn history_rig() -> Rig {
    let mut r = rig(40, 4);
    r.c.set_history(vec!["one".into(), "two\nlines".into(), "three".into()]);
    r
}

#[test]
fn up_on_an_empty_draft_walks_the_sent_prompts_and_down_comes_back() {
    let mut r = history_rig();
    assert!(r.press(Key::Up).events.is_empty());
    assert_eq!(r.c.text(), "three");
    r.press(Key::Up);
    assert_eq!(r.c.text(), "two\nlines");
    // The caret is at the end, on the last row: Up moves within the text first.
    r.press(Key::Up);
    assert_eq!(r.c.text(), "two\nlines");
    r.press(Key::Up);
    assert_eq!(r.c.text(), "one");
    r.press(Key::Up);
    assert_eq!(r.c.text(), "one", "the oldest stays");
    r.press(Key::Down);
    assert_eq!(r.c.text(), "two\nlines");
    r.press(Key::Down);
    assert_eq!(r.c.text(), "three");
    r.press(Key::Down);
    assert_eq!(
        r.c.text(),
        "",
        "past the newest is the draft the person had"
    );
    assert!(!r.c.is_walking_history());
}

#[test]
fn editing_a_recalled_prompt_stops_the_walk_and_keeps_the_text() {
    let mut r = history_rig();
    r.press(Key::Up);
    assert!(r.c.is_walking_history());
    r.type_str("!");
    assert!(!r.c.is_walking_history());
    assert_eq!(r.c.text(), "three!");
    r.press(Key::Down);
    assert_eq!(r.c.text(), "three!", "Down is plain cursor motion now");
    // A draft that is not empty does not start a walk.
    r.press(Key::Up);
    assert_eq!(r.c.text(), "three!");
}

#[test]
fn history_is_bounded_and_a_repeat_of_the_newest_is_not_added() {
    let mut r = rig(40, 4);
    for i in 0..(theorem_workbench_composer::HISTORY_LIMIT + 5) {
        r.c.push_history(&format!("p{i}"));
    }
    r.c.push_history(&format!(
        "p{}",
        theorem_workbench_composer::HISTORY_LIMIT + 4
    ));
    for _ in 0..(theorem_workbench_composer::HISTORY_LIMIT + 20) {
        r.press(Key::Up);
    }
    assert_eq!(r.c.text(), "p5", "the oldest five were dropped");
}

#[test]
fn with_no_history_up_on_an_empty_draft_still_recalls_the_last_message() {
    let mut r = rig(40, 4);
    assert_eq!(r.press(Key::Up).events, vec![Event::RecallLast]);
}
