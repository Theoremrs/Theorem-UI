//! What the panel draws into a buffer: cell-text snapshots of a small status and a
//! small diff, widths, elision and styles. The panel draws; it has not been compared
//! against a reference render.

mod common;

use common::*;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use theorem_workbench_changes::*;
use unicode_width::UnicodeWidthStr;

fn small() -> Changes {
    loaded(vec![
        change("src/main.rs", "M", " "),
        change("README.md", " ", "M"),
        change("new.txt", "?", "?"),
    ])
}

#[test]
fn snapshot_of_a_small_status() {
    let model = small();
    assert_eq!(
        render(&model, 44, 16),
        [
            "main",
            " Staged 1                        unstage all",
            " > M main.rs  src",
            " Unstaged 1                        stage all",
            " > M README.md",
            " Untracked 1",
            " > U new.txt",
            "",
            "",
            "",
            "",
            "",
            "  Commit message                        0/50",
            "  Description",
            "",
            " [ ] Amend                [ Commit to main ]",
        ]
    );
}

fn with_diff() -> Changes {
    let mut model = small();
    let i = model
        .toggle_diff_of(&RowKey::new(Section::Staged, "src/main.rs"))
        .unwrap()
        .unwrap();
    accept(
        &mut model,
        &i,
        diff_answer("src/main.rs", true, SMALL_DIFF, 1),
    );
    model
}

#[test]
fn snapshot_of_a_small_unified_diff() {
    let model = with_diff();
    assert_eq!(
        render(&model, 44, 16),
        [
            "main",
            " Staged 1                        unstage all",
            " v M main.rs  src",
            "  v @@ -1,4 +1,4 @@",
            "   1  1  fn main() {",
            "   2    -    println!(\"hello\");",
            "      2 +    println!(\"hello, world\");",
            "   3  3      run();",
            "   4  4  }",
            " Unstaged 1                        stage all",
            " > M README.md",
            " Untracked 1",
            "  Commit message                        0/50",
            "  Description",
            "",
            " [ ] Amend                [ Commit to main ]",
        ]
    );
}

#[test]
fn snapshot_of_a_small_split_diff() {
    let mut model = with_diff();
    model.toggle_layout();
    assert_eq!(
        render(&model, 84, 16),
        [
            "main",
            " Staged 1                                                                unstage all",
            " v M main.rs  src",
            "  v @@ -1,4 +1,4 @@",
            "   1 fn main() {                          │ 1 fn main() {",
            "   2     println!(\"hello\");               │ 2     println!(\"hello, world\");",
            "   3     run();                           │ 3     run();",
            "   4 }                                    │ 4 }",
            " Unstaged 1                                                                stage all",
            " > M README.md",
            " Untracked 1",
            " > U new.txt",
            "  Commit message                                                                0/50",
            "  Description",
            "",
            " [ ] Amend                                                        [ Commit to main ]",
        ]
    );
}

#[test]
fn a_narrow_panel_falls_back_to_unified_for_a_split_request() {
    let mut model = with_diff();
    model.toggle_layout();
    assert!(!render(&model, 44, 16).iter().any(|l| l.contains('│')));
    assert!(
        render(&model, 44, 16)
            .iter()
            .any(|l| l.contains("println!(\"hello, world\")"))
    );
    assert!(
        render(&model, SPLIT_MIN, 16)
            .iter()
            .any(|l| l.contains('│'))
    );
}

#[test]
fn a_long_path_is_elided_in_the_middle_and_keeps_its_file_name() {
    let long = "crates/very/deeply/nested/module/structure/with_a_long_name/handler_impl.rs";
    let model = loaded(vec![change(long, " ", "M")]);
    let screen = render(&model, 40, 10);
    let row = screen
        .iter()
        .find(|l| l.contains("handler_impl.rs"))
        .expect("the file name stays");
    assert!(row.contains('…'), "the middle is elided: {row}");
    assert!(row.width() <= 40);
}

#[test]
fn wide_characters_are_counted_by_display_width_and_never_overflow() {
    let model = loaded(vec![
        change("文档/说明书/最终版本的很长的文件名称.md", " ", "M"),
        change("emoji-🙂-file.txt", " ", "M"),
        change("cafe\u{301}.txt", " ", "M"),
    ]);
    for width in [16u16, 24, 31, 40] {
        let area = Rect::new(0, 0, width, 12);
        let mut buf = Buffer::empty(area);
        model.draw(area, &mut buf, &ChangesStyles::plain());
        for line in lines(&buf) {
            assert!(line.width() <= width as usize, "{width}: {line:?}");
        }
    }
    let screen = render(&model, 40, 12).join("\n");
    assert!(screen.contains("文"));
}

#[test]
fn drawing_into_a_tiny_or_empty_area_does_not_panic() {
    let model = with_diff();
    for (w, h) in [(0, 0), (1, 1), (3, 2), (10, 1), (5, 40)] {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        model.draw(area, &mut buf, &ChangesStyles::plain());
    }
    // And the area is clipped to the buffer.
    let mut buf = Buffer::empty(Rect::new(0, 0, 20, 5));
    model.draw(Rect::new(0, 0, 80, 40), &mut buf, &ChangesStyles::plain());
}

#[test]
fn drawing_in_an_offset_area_stays_inside_it() {
    let model = with_diff();
    let mut buf = Buffer::empty(Rect::new(0, 0, 60, 24));
    let area = Rect::new(10, 4, 40, 16);
    model.draw(area, &mut buf, &ChangesStyles::plain());
    for y in 0..24u16 {
        for x in 0..60u16 {
            let inside = area.contains((x, y).into());
            if !inside {
                assert_eq!(buf[(x, y)].symbol(), " ", "({x},{y}) is outside the area");
            }
        }
    }
}

#[test]
fn added_removed_and_context_lines_are_styled_apart() {
    let model = with_diff();
    let area = Rect::new(0, 0, 44, 16);
    let mut buf = Buffer::empty(area);
    model.draw(area, &mut buf, &ChangesStyles::plain());
    let style_at = |needle: &str| {
        let y = lines(&buf).iter().position(|l| l.contains(needle)).unwrap() as u16;
        let x = lines(&buf)[y as usize].find(needle).unwrap() as u16;
        buf[(x, y)].style()
    };
    let removed = style_at("println!(\"hello\")");
    let added = style_at("println!(\"hello, world\")");
    let context = style_at("run();");
    assert_ne!(removed, context);
    assert_ne!(added, context);
    assert_ne!(added, removed);
    assert!(
        [removed, added]
            .iter()
            .any(|s| s.add_modifier != Modifier::empty() || s.fg.is_some() || s.bg.is_some()),
        "plain roles tell them apart by modifier"
    );
}

#[test]
fn the_cursor_row_is_marked_by_style_and_follows_focus() {
    let mut model = small();
    let area = Rect::new(0, 0, 44, 16);
    let styles = ChangesStyles::plain();
    let mut files = Buffer::empty(area);
    model.draw(area, &mut files, &styles);
    model.set_focus(Focus::Message);
    let mut message = Buffer::empty(area);
    model.draw(area, &mut message, &styles);
    // The commit box shows which part holds the keys.
    assert_ne!(files, message);
}

#[test]
fn the_commit_button_is_ready_only_with_a_message_and_something_to_commit() {
    let mut model = small();
    assert!(!model.commit_button().1, "no message yet");
    model.set_subject("subject");
    let (label, ready) = model.commit_button();
    assert!(ready);
    assert_eq!(label, "Commit to main");
    // Nothing staged but changes to stage: the button offers to stage them first.
    let mut unstaged = loaded(vec![change("a.rs", " ", "M")]);
    unstaged.set_subject("subject");
    assert_eq!(
        unstaged.commit_button(),
        ("Stage all and commit to main".to_owned(), true)
    );
    // Nothing at all: nothing to commit.
    let mut clean = loaded(vec![]);
    clean.set_subject("subject");
    assert!(!clean.commit_button().1);
    // While a commit runs the button says so and cannot be pressed again.
    let commit = model.commit().unwrap();
    assert_eq!(model.commit_button(), ("Committing...".to_owned(), false));
    accept_bare(&mut model, &commit);
}

#[test]
fn the_commit_box_counts_the_subject_against_its_limits() {
    let mut model = small();
    model.set_subject("x".repeat(60));
    assert!(render(&model, 50, 16).join("\n").contains("60/50"));
    let (soft, hard) = SUBJECT;
    assert!((soft, hard) == (50, 72));
}

#[test]
fn a_small_panel_gives_the_list_the_room_before_the_commit_box_and_log() {
    let model = small();
    let cramped = render(&model, 44, 8);
    assert!(cramped.iter().any(|l| l.contains("README.md")));
    assert!(!cramped.iter().any(|l| l.contains("Commits")));
    let tall = render(&model, 44, 30);
    assert!(tall.iter().any(|l| l.contains("Commits")));
    assert!(tall.iter().any(|l| l.contains("first")));
}

#[test]
fn scrolling_moves_the_list_and_keeps_the_cursor_visible() {
    let many: Vec<_> = (0..40)
        .map(|n| change(&format!("file{n:02}.rs"), " ", "M"))
        .collect();
    let mut model = loaded(many);
    model.set_area(40, 12);
    for _ in 0..30 {
        model.move_cursor(1, false);
    }
    let screen = render(&model, 40, 12).join("\n");
    assert!(
        screen.contains("file29.rs"),
        "the cursor row is on screen:\n{screen}"
    );
    assert!(model.scroll() > 0);
    assert!(!screen.contains("file00.rs"));
}

#[test]
fn a_long_list_says_how_many_it_lists_of_how_many() {
    let many: Vec<_> = (0..(LISTED + 5))
        .map(|n| change(&format!("f{n}.rs"), " ", "M"))
        .collect();
    let model = loaded(many);
    let screen = render(&model, 50, 12).join("\n");
    assert!(screen.contains(&format!("Listing {LISTED} of {} changes", LISTED + 5)));
}

#[test]
fn control_characters_in_a_path_are_shown_quoted_not_drawn() {
    let model = loaded(vec![change("bad\nname\u{1b}[31m.rs", " ", "M")]);
    let screen = render(&model, 50, 8).join("\n");
    assert!(!screen.contains('\u{1b}'));
    assert!(screen.contains("\\n"));
}
