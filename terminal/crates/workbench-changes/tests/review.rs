//! The Review view: a tree of the changed files beside one scroll of their diffs. These
//! tests drive the model and read what it draws.

mod common;

use common::*;
use theorem_workbench_changes::*;
use theorem_workbench_core::completion::{CompletionPayload, Outcome};

/// A unified diff of one file with `adds` lines added and `dels` removed, between two
/// unchanged lines.
fn diff_of(path: &str, adds: usize, dels: usize) -> String {
    let mut text = format!(
        "diff --git a/{path} b/{path}\nindex 1111111..2222222 100644\n--- a/{path}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n context before\n",
        dels + 2,
        adds + 2
    );
    for n in 0..dels {
        text.push_str(&format!("-old line {n}\n"));
    }
    for n in 0..adds {
        text.push_str(&format!("+new line {n}\n"));
    }
    text.push_str(" context after\n");
    text
}

/// A model on the Review view, at `width` by `height`, that has read these changes.
fn review(changes: Vec<theorem_workbench_core::completion::ScmChange>, w: u16, h: u16) -> Changes {
    let mut model = loaded(changes);
    model.set_area(w, h);
    model.set_view(View::Review);
    model
}

fn twelve() -> Vec<theorem_workbench_core::completion::ScmChange> {
    let mut all = Vec::new();
    for dir in ["alpha", "beta", "gamma"] {
        for file in ["one.rs", "two.rs", "three.rs", "four.rs"] {
            all.push(change(&format!("{dir}/{file}"), " ", "M"));
        }
    }
    all
}

/// Answers every diff the Review asks for, with `adds` and `dels` lines each, until it
/// asks for no more. Returns how many it answered.
fn answer_all(model: &mut Changes, adds: usize, dels: usize) -> usize {
    let mut answered = 0;
    loop {
        let wanted = model.review_wants();
        if wanted.is_empty() {
            return answered;
        }
        for intent in wanted {
            let IntentKind::Diff { path, staged } = &intent.kind else {
                panic!("the Review asks for diffs only");
            };
            let text = diff_of(path, adds, dels);
            accept(model, &intent, diff_answer(path, *staged, &text, 1));
            answered += 1;
        }
    }
}

fn screen(model: &Changes, w: u16, h: u16) -> Vec<String> {
    render(model, w, h)
}

#[test]
fn the_view_a_bare_model_starts_on_is_the_stage_and_the_panel_opens_on_the_review() {
    assert_eq!(Changes::new().view(), View::Stage);
    assert_eq!(ViewState::default().view, View::Review);
}

#[test]
fn the_header_says_since_the_last_commit_and_counts_the_files() {
    let model = review(twelve(), 120, 30);
    let top = &screen(&model, 120, 30)[1];
    assert!(top.contains("Since last commit"), "{top}");
    assert!(top.contains("12 files"), "{top}");
    assert!(top.contains("[refresh]"), "{top}");
}

#[test]
fn a_header_too_narrow_for_the_file_count_leaves_it_out_whole() {
    let mut model = review(twelve(), 52, 30);
    answer_all(&mut model, 300, 100);
    let top = &screen(&model, 52, 30)[1];
    assert!(top.contains("[refresh]"), "{top}");
    assert!(top.contains("+3600 \u{2212}1200"), "{top}");
    assert!(!top.contains("file"), "a cut word: {top}");
    let wider = &screen(&model, 70, 30)[1];
    assert!(wider.contains("12 files"), "{wider}");
}

#[test]
fn the_only_base_is_the_last_commit_because_that_is_all_the_port_can_diff() {
    assert_eq!(Base::ALL, &[Base::LastCommit]);
    let mut model = review(twelve(), 120, 30);
    model.review_next_base();
    assert_eq!(model.base(), Base::LastCommit);
}

#[test]
fn totals_are_complete_only_once_every_diff_has_arrived() {
    let mut model = review(twelve(), 120, 12);
    let before = screen(&model, 120, 12)[1].clone();
    assert!(
        before.contains('\u{2026}'),
        "unread diffs leave the total open: {before}"
    );
    // A short window asks near the top first and then for the rest, without a scroll.
    assert_eq!(answer_all(&mut model, 3, 1), 12);
    let after = &screen(&model, 120, 12)[1];
    assert!(after.contains("+36 \u{2212}12"), "{after}");
    assert!(!after.contains('\u{2026}'), "{after}");
}

#[test]
fn past_two_hundred_files_only_the_diffs_near_the_viewport_are_read() {
    let many = (0..201)
        .map(|n| change(&format!("src/file_{n:03}.rs"), " ", "M"))
        .collect();
    let mut model = review(many, 120, 12);
    let answered = answer_all(&mut model, 3, 1);
    assert!(answered < 201, "{answered} read without a scroll");
    let header = &screen(&model, 120, 12)[1];
    assert!(
        header.contains('\u{2026}'),
        "the total stays open: {header}"
    );
}

#[test]
fn only_the_files_near_the_top_are_asked_for_and_never_more_than_three_at_once() {
    let mut model = review(twelve(), 120, 12);
    let first = model.review_wants();
    assert_eq!(first.len(), 3, "{:?}", kinds(&first));
    let paths: Vec<String> = first
        .iter()
        .map(|i| match &i.kind {
            IntentKind::Diff { path, .. } => path.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        paths,
        ["alpha/four.rs", "alpha/one.rs", "alpha/three.rs"],
        "tree order: by name within the folder"
    );
    assert!(model.review_wants().is_empty(), "three are out; no more go");
}

#[test]
fn a_diff_that_grows_above_the_viewport_does_not_move_it() {
    let mut model = review(twelve(), 120, 12);
    let wanted = model.review_wants();
    for intent in &wanted {
        let IntentKind::Diff { path, staged } = &intent.kind else {
            panic!()
        };
        accept(
            &mut model,
            intent,
            diff_answer(path, *staged, &diff_of(path, 40, 0), 1),
        );
    }
    model.review_jump("beta/two.rs");
    let top = model.review_current();
    assert_eq!(top.as_deref(), Some("beta/two.rs"));
    let at = model.review_scroll();
    // The file above the viewport reads in; its rows come in above the first row.
    let mut again = model.review_wants();
    again.retain(|i| matches!(&i.kind, IntentKind::Diff { path, .. } if path == "alpha/two.rs"));
    for intent in &again {
        let IntentKind::Diff { path, staged } = &intent.kind else {
            panic!()
        };
        accept(
            &mut model,
            intent,
            diff_answer(path, *staged, &diff_of(path, 40, 0), 1),
        );
    }
    assert_eq!(model.review_current().as_deref(), Some("beta/two.rs"));
    assert!(model.review_scroll() >= at);
}

#[test]
fn a_single_child_chain_of_folders_reads_as_one_name() {
    let model = review(
        vec![
            change("src/lib/deep/a.rs", " ", "M"),
            change("src/lib/deep/b.rs", " ", "M"),
            change("top.rs", " ", "M"),
        ],
        120,
        20,
    );
    let rows = screen(&model, 120, 20);
    assert!(rows.iter().any(|l| l.contains("src/lib/deep")), "{rows:?}");
    assert!(!rows.iter().any(|l| l.contains(" lib ")), "{rows:?}");
}

#[test]
fn a_file_has_a_state_letter_and_its_counts_once_its_diff_has_arrived() {
    let mut model = review(
        vec![
            change("added.rs", "A", " "),
            change("gone.rs", " ", "D"),
            change("kept.rs", " ", "M"),
            change("fresh.rs", "?", "?"),
        ],
        120,
        20,
    );
    answer_all(&mut model, 2, 1);
    let rows = screen(&model, 120, 20).join("\n");
    for expected in ["A added.rs", "D gone.rs", "M kept.rs", "U fresh.rs"] {
        assert!(rows.contains(expected), "{expected} in\n{rows}");
    }
    assert!(rows.contains("+2 \u{2212}1"), "{rows}");
}

#[test]
fn a_folder_sums_its_files_and_keeps_the_sum_when_it_closes() {
    let mut model = review(twelve(), 120, 40);
    answer_all(&mut model, 3, 1);
    let open = screen(&model, 120, 40).join("\n");
    assert!(open.contains("alpha"), "{open}");
    // The folder `alpha` has four files of +3 -1.
    assert!(open.contains("+12 \u{2212}4"), "{open}");
    // The cursor starts on the first file; walk it out to the folder and close it.
    model.review_left();
    assert_eq!(model.review_cursor(), Some(&TreeSel::Dir("alpha".into())));
    model.review_left();
    let closed = screen(&model, 120, 40).join("\n");
    assert_eq!(closed.matches("M four.rs").count(), 2, "{closed}");
    assert!(closed.contains("+12 \u{2212}4"), "{closed}");
    model.review_right();
    assert_eq!(
        screen(&model, 120, 40)
            .join("\n")
            .matches("M four.rs")
            .count(),
        3
    );
}

#[test]
fn enter_on_a_file_puts_its_header_at_the_top_and_marks_it_current() {
    let mut model = review(twelve(), 120, 20);
    answer_all(&mut model, 6, 2);
    for _ in 0..2 {
        model.review_move(1);
    }
    let TreeSel::File(path) = model.review_cursor().cloned().unwrap() else {
        panic!("the third row is a file")
    };
    model.review_enter();
    assert_eq!(model.review_current().as_deref(), Some(path.as_str()));
    let rows = screen(&model, 120, 20);
    let top = &rows[2];
    assert!(
        top.contains(&path),
        "the header is the first row of the diff: {top}"
    );
    // The cursor moves on; the current file stays marked by its bold name, not by a rail.
    model.review_move(1);
    let area = ratatui::layout::Rect::new(0, 0, 120, 20);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    model.draw(area, &mut buf, &ChangesStyles::plain());
    theorem_workbench_core::take_icons(&mut buf);
    let rows = lines(&buf);
    assert!(
        !rows.iter().any(|l| l.contains('\u{258d}')),
        "no rail: {rows:#?}"
    );
    let name = path.rsplit('/').next().unwrap();
    // The tree is right of the divider; a row counts when its file name is bold.
    let divider = (0..120u16)
        .find(|x| buf[(*x, 2)].symbol() == "\u{2502}")
        .unwrap();
    let bold_names: Vec<String> = (2..20u16)
        .filter_map(|y| {
            let cells: Vec<&str> = (divider + 1..120).map(|x| buf[(x, y)].symbol()).collect();
            let text = cells.concat();
            let at = text.find(" M ")? + 3;
            let start = text[..at].chars().count();
            let len = text[at..].split(' ').next()?.chars().count();
            let bold = (start..start + len).all(|i| {
                buf[(divider + 1 + i as u16, y)]
                    .modifier
                    .contains(ratatui::style::Modifier::BOLD)
            });
            bold.then(|| text[at..].split(' ').next().unwrap().to_owned())
        })
        .collect();
    // The cursor moved one row down, to two.rs, which is bold as the cursor; the rest are plain.
    assert_eq!(
        bold_names,
        vec![name.to_owned(), "two.rs".to_owned()],
        "the current file's name is bold in the tree"
    );
}

#[test]
fn scrolling_changes_the_current_file_and_its_header_stays_at_the_top() {
    let mut model = review(twelve(), 120, 20);
    answer_all(&mut model, 6, 2);
    let first = model.review_current().unwrap();
    model.review_scroll_by(30);
    answer_all(&mut model, 6, 2);
    let later = model.review_current().unwrap();
    assert_ne!(first, later);
    let rows = screen(&model, 120, 20);
    assert!(rows[2].contains(&later), "the header sticks: {}", rows[2]);
}

#[test]
fn the_tree_is_on_the_right_from_a_hundred_columns_and_above_the_diff_below() {
    let wide = review(twelve(), 120, 30);
    let rows = screen(&wide, 120, 30);
    let at = rows[2].find('\u{2502}').expect("the rule is drawn");
    assert!(
        at > 80,
        "the tree is the right-hand column: {at} in {}",
        rows[2]
    );
    let narrow = review(twelve(), 60, 30);
    let rows = screen(&narrow, 60, 30);
    assert!(rows[2].contains("Files 12"), "{}", rows[2]);
    assert!(
        rows[3].contains("alpha"),
        "the tree sits above the diff: {}",
        rows[3]
    );
}

#[test]
fn the_stacked_tree_takes_at_most_a_third_and_folds_to_its_heading() {
    let mut model = review(twelve(), 60, 30);
    let with_tree = screen(&model, 60, 30);
    let tree_rows = with_tree
        .iter()
        .skip(3)
        .take_while(|l| !l.contains("loading"))
        .count();
    assert!(tree_rows <= 30 / 3, "{tree_rows}");
    model.review_toggle_tree();
    let folded = screen(&model, 60, 30);
    assert!(folded[2].contains("Files 12"));
    assert!(
        folded[3].contains(" M alpha/"),
        "the diff follows the heading: {}",
        folded[3]
    );
    assert!(model.review_tree_hidden());
}

#[test]
fn what_the_tree_selects_is_what_stage_acts_on() {
    let mut model = review(
        vec![change("a/one.rs", " ", "M"), change("a/two.rs", " ", "M")],
        120,
        20,
    );
    let staged = model.stage().expect("the file under the cursor stages");
    match &staged.kind {
        IntentKind::Stage { paths } => assert_eq!(paths, &["a/one.rs"]),
        other => panic!("{other:?}"),
    }
    // A folder selects every file under it.
    let mut model = review(
        vec![change("a/one.rs", " ", "M"), change("a/two.rs", " ", "M")],
        120,
        20,
    );
    model.review_left();
    assert_eq!(model.review_cursor(), Some(&TreeSel::Dir("a".into())));
    let staged = model.stage().expect("the folder stages its files");
    match &staged.kind {
        IntentKind::Stage { paths } => assert_eq!(paths, &["a/one.rs", "a/two.rs"]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_stage_view_still_has_the_commit_box_and_the_review_has_none() {
    let mut model = review(twelve(), 120, 30);
    assert!(
        !screen(&model, 120, 30)
            .join("\n")
            .contains("Commit message")
    );
    model.toggle_view();
    assert_eq!(model.view(), View::Stage);
    let rows = screen(&model, 120, 30).join("\n");
    assert!(rows.contains("Commit message"), "{rows}");
    assert!(
        rows.contains("Staged") || rows.contains("Unstaged"),
        "{rows}"
    );
    model.toggle_view();
    assert_eq!(model.view(), View::Review);
}

#[test]
fn a_binary_file_and_one_with_no_line_changes_take_one_row_each() {
    let mut model = review(
        vec![change("pic.png", " ", "M"), change("mode.sh", " ", "M")],
        120,
        20,
    );
    for intent in model.review_wants() {
        let IntentKind::Diff { path, staged } = &intent.kind else {
            panic!()
        };
        let text = if path == "pic.png" {
            "diff --git a/pic.png b/pic.png\nBinary files a/pic.png and b/pic.png differ\n"
        } else {
            "diff --git a/mode.sh b/mode.sh\nold mode 100644\nnew mode 100755\n"
        };
        accept(&mut model, &intent, diff_answer(path, *staged, text, 1));
    }
    let rows = screen(&model, 120, 20).join("\n");
    assert!(rows.contains("binary file"), "{rows}");
    assert!(rows.contains("no line changes"), "{rows}");
}

#[test]
fn a_diff_over_the_size_limit_is_one_row_that_says_so() {
    let mut model = review(vec![change("huge.txt", " ", "M")], 120, 20);
    for intent in model.review_wants() {
        let IntentKind::Diff { path, staged } = &intent.kind else {
            panic!()
        };
        let text = diff_of(path, MAX_DIFF_LINES + 10, 0);
        accept(&mut model, &intent, diff_answer(path, *staged, &text, 1));
    }
    let rows = screen(&model, 120, 20).join("\n");
    assert!(rows.contains("too large to show"), "{rows}");
}

#[test]
fn far_apart_hunks_have_a_separator_that_counts_the_lines_between() {
    let mut model = review(vec![change("two.rs", " ", "M")], 120, 20);
    let text = "diff --git a/two.rs b/two.rs\n--- a/two.rs\n+++ b/two.rs\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -40,3 +40,3 @@\n x\n-y\n+Y\n z\n";
    for intent in model.review_wants() {
        accept(&mut model, &intent, diff_answer("two.rs", false, text, 1));
    }
    let rows = screen(&model, 120, 20).join("\n");
    assert!(rows.contains("unchanged lines"), "{rows}");
}

#[test]
fn a_file_changed_on_both_sides_shows_both_diffs_under_one_header() {
    let mut model = review(vec![change("both.rs", "M", "M")], 120, 30);
    let wanted = model.review_wants();
    assert_eq!(wanted.len(), 2, "one diff per side");
    for intent in &wanted {
        let IntentKind::Diff { path, staged } = &intent.kind else {
            panic!()
        };
        accept(
            &mut model,
            intent,
            diff_answer(path, *staged, &diff_of(path, 1, 1), 1),
        );
    }
    let rows = screen(&model, 120, 30).join("\n");
    assert!(
        rows.contains("Staged") && rows.contains("Unstaged"),
        "{rows}"
    );
    assert!(rows.matches("both.rs").count() >= 2);
}

#[test]
fn a_diff_asked_for_before_the_repository_moved_is_asked_for_again() {
    let mut model = review(twelve(), 120, 12);
    let first = model.review_wants();
    // The repository moves on: a new status at a new generation.
    let read = model.refresh();
    let mut moved = twelve();
    moved[0] = change("alpha/one.rs", "M", "M");
    accept(&mut model, &read, status(2, moved));
    // The old answers come back for a generation that is gone.
    for intent in &first {
        let IntentKind::Diff { path, staged } = &intent.kind else {
            panic!()
        };
        model.complete(
            intent.id,
            &Outcome::Accepted,
            Some(&diff_answer(path, *staged, &diff_of(path, 1, 1), 1)),
        );
    }
    let again = model.review_wants();
    assert!(
        !again.is_empty(),
        "the files in view are asked for at the new generation"
    );
    assert!(again.iter().all(|i| i.generation == model.generation()));
}

#[test]
fn the_view_is_saved_and_restored() {
    let mut model = review(twelve(), 120, 30);
    model.toggle_view();
    let saved = model.view_state();
    assert_eq!(saved.view, View::Stage);
    let json = serde_json::to_value(&saved).unwrap();
    assert_eq!(json["view"], "stage");
    // A layout saved before the Review existed has no view and opens on it.
    let old: ViewState = serde_json::from_value(serde_json::json!({ "version": VERSION })).unwrap();
    assert_eq!(old.view, View::Review);
    let _ = (CompletionPayload::Scm, Outcome::Accepted);
}

#[test]
fn nothing_to_review_says_so_as_the_stage_does() {
    let model = review(vec![], 120, 20);
    let rows = screen(&model, 120, 20).join("\n");
    assert!(rows.contains("No changes"), "{rows}");
}
