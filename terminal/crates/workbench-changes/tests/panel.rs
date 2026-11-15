//! The panel's states, generations, confirmation, unknown results, drafts and the
//! semantic tree, through the public API. Written for this crate; the donor has no
//! tests of its own for these (its tests are the pure ones carried in `src/`).

mod common;

use common::*;
use theorem_workbench_changes::*;
use theorem_workbench_core::completion::{
    BranchInfo, CompletionPayload, Outcome, RepoState, ScmBranches, ScmDiscarded,
};
use theorem_workbench_core::semantics::Role;

fn mixed() -> Changes {
    loaded(vec![
        change("src/main.rs", "M", " "),
        change("README.md", " ", "M"),
        change("notes.txt", " ", "M"),
        change("new.txt", "?", "?"),
    ])
}

fn key(section: Section, path: &str) -> RowKey {
    RowKey::new(section, path)
}

// ---- visible states ---------------------------------------------------------

#[test]
fn loading_before_the_first_answer() {
    let mut model = Changes::new();
    assert_eq!(model.state(), PanelState::Loading);
    let read = model.refresh();
    assert_eq!(model.state(), PanelState::Loading);
    assert!(render(&model, 40, 10)[1].contains("Reading changes"));
    assert_eq!(read.kind, IntentKind::Status);
}

#[test]
fn empty_says_no_changes() {
    let model = loaded(vec![]);
    assert_eq!(model.state(), PanelState::Empty);
    assert!(
        render(&model, 40, 10)
            .iter()
            .any(|l| l.contains("No changes"))
    );
}

#[test]
fn refused_shows_the_code_and_the_reason() {
    let mut model = Changes::new();
    let read = model.refresh();
    fail(
        &mut model,
        &read,
        Outcome::Refused {
            code: "no_repository".into(),
            reason: "This folder is not a git repository".into(),
        },
    );
    assert_eq!(
        model.state(),
        PanelState::Refused {
            code: "no_repository".into(),
            reason: "This folder is not a git repository".into()
        }
    );
    let screen = render(&model, 60, 10).join("\n");
    assert!(screen.contains("no_repository"));
    assert!(screen.contains("not a git repository"));
}

#[test]
fn uncertain_status_is_shown_as_unknown_and_never_retried() {
    let mut model = Changes::new();
    let read = model.refresh();
    let next = fail(
        &mut model,
        &read,
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
    );
    assert!(next.is_empty(), "nothing is asked again by itself");
    assert_eq!(
        model.state(),
        PanelState::Uncertain {
            reason: "timed out".into()
        }
    );
    let screen = render(&model, 60, 12).join("\n");
    assert!(screen.contains("Unknown result"));
    assert!(screen.contains("Refresh to read it again"));
    // Only the user's refresh asks again, and it is a new request.
    let again = model.refresh();
    assert_ne!(again.id, read.id);
}

#[test]
fn failed_status_shows_the_reason() {
    let mut model = Changes::new();
    let read = model.refresh();
    fail(
        &mut model,
        &read,
        Outcome::Failed {
            reason: "git exited 128".into(),
        },
    );
    assert_eq!(
        model.state(),
        PanelState::Failed {
            reason: "git exited 128".into()
        }
    );
    assert!(render(&model, 60, 10).join("\n").contains("git exited 128"));
}

#[test]
fn a_failed_reread_keeps_the_list_and_says_it_is_out_of_date() {
    let mut model = mixed();
    let read = model.refresh();
    fail(
        &mut model,
        &read,
        Outcome::Failed {
            reason: "git exited 128".into(),
        },
    );
    assert_eq!(model.state(), PanelState::Ready);
    assert!(model.status_problem().is_some());
    let screen = render(&model, 70, 16).join("\n");
    assert!(screen.contains("The list is out of date"));
    assert!(screen.contains("README.md"));
}

#[test]
fn ready_lists_groups_in_the_owners_order_with_counts_and_letters() {
    let model = loaded(vec![
        conflict("both.rs"),
        change("a.rs", "A", "M"),
        change("odd", "", ""),
        change("new.txt", "?", "?"),
    ]);
    let screen = render(&model, 50, 16);
    let at = |needle: &str| {
        screen
            .iter()
            .position(|l| l.contains(needle))
            .unwrap_or(usize::MAX)
    };
    assert!(at("Conflicted 1") < at("Staged 1"));
    assert!(at("Staged 1") < at("Unstaged 1"));
    assert!(at("Unstaged 1") < at("Untracked 1"));
    assert!(at("Untracked 1") < at("Status not reported 1"));
    // A path changed on both sides is in both groups, with its own letter in each.
    assert!(screen.iter().any(|l| l.contains("A a.rs")));
    assert!(screen.iter().any(|l| l.contains("M a.rs")));
    assert!(screen.iter().any(|l| l.contains("U new.txt")));
    assert!(screen.iter().any(|l| l.contains("! both.rs")));
}

// ---- branch line ------------------------------------------------------------

#[test]
fn branch_line_names_a_branch_a_detached_head_and_an_unreported_one() {
    let with = |branch: BranchStateCase| {
        let mut model = Changes::new();
        let read = model.refresh();
        let mut state = repo(1);
        let (branch_name, branch_state) = branch.parts();
        state.branch = branch_state;
        let payload = CompletionPayload::Scm(theorem_workbench_core::completion::ScmStatus {
            branch: branch_name,
            head: Some("deadbeefcafe".into()),
            changes: vec![],
            state: Some(state),
        });
        accept(&mut model, &read, payload);
        model
    };
    let named = with(BranchStateCase::Named);
    assert_eq!(named.head().unwrap().label(), "main");
    assert!(render(&named, 40, 6)[0].starts_with("main"));
    let detached = with(BranchStateCase::Detached);
    assert_eq!(detached.head().unwrap().label(), "(deadbee detached)");
    assert!(render(&detached, 40, 6)[0].contains("detached"));
    let unreported = with(BranchStateCase::Unreported);
    assert_eq!(unreported.head().unwrap().label(), "branch not reported");
    assert!(render(&unreported, 40, 6)[0].contains("branch not reported"));
}

enum BranchStateCase {
    Named,
    Detached,
    Unreported,
}

impl BranchStateCase {
    fn parts(
        &self,
    ) -> (
        Option<String>,
        theorem_workbench_core::completion::BranchState,
    ) {
        use theorem_workbench_core::completion::BranchState;
        match self {
            Self::Named => (Some("main".into()), BranchState::Named("main".into())),
            Self::Detached => (None, BranchState::Detached),
            Self::Unreported => (None, BranchState::Unreported),
        }
    }
}

#[test]
fn ahead_and_behind_are_not_shown_because_the_wire_does_not_report_them() {
    let model = mixed();
    let screen = render(&model, 60, 6)[0].clone();
    assert!(!screen.contains('↑') && !screen.contains('↓'));
}

// ---- generations ------------------------------------------------------------

#[test]
fn a_changed_status_advances_the_generation_and_an_identical_one_does_not() {
    let mut model = mixed();
    let before = model.generation();
    let read = model.refresh();
    accept(
        &mut model,
        &read,
        status(
            1,
            vec![
                change("src/main.rs", "M", " "),
                change("README.md", " ", "M"),
                change("notes.txt", " ", "M"),
                change("new.txt", "?", "?"),
            ],
        ),
    );
    assert_eq!(
        model.generation(),
        before,
        "the same list is the same state"
    );
    let read = model.refresh();
    accept(
        &mut model,
        &read,
        status(2, vec![change("README.md", " ", "M")]),
    );
    assert!(model.generation() > before);
}

#[test]
fn intents_carry_the_generation_they_were_decided_against() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    let stage = model.stage().unwrap();
    assert_eq!(stage.generation, model.generation());
}

#[test]
fn a_diff_decided_against_an_older_generation_is_dropped_and_counted() {
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    let open = model.toggle_diff_of(&k).unwrap().unwrap();
    assert_eq!(open.generation, model.generation());
    // The list moves on while the diff is being read.
    let read = model.refresh();
    accept(
        &mut model,
        &read,
        status(
            2,
            vec![change("README.md", " ", "M"), change("extra.rs", " ", "M")],
        ),
    );
    assert!(model.generation() > open.generation);
    let before = model.counters().stale_dropped;
    accept(
        &mut model,
        &open,
        diff_answer("README.md", false, SMALL_DIFF, 1),
    );
    assert_eq!(model.counters().stale_dropped, before + 1);
    assert_eq!(model.diff(&k).unwrap().state, DiffState::Outdated);
    assert!(render(&model, 90, 20).join("\n").contains("was dropped"));
}

#[test]
fn a_diff_whose_answer_names_another_repository_state_is_dropped() {
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    let open = model.toggle_diff_of(&k).unwrap().unwrap();
    accept(
        &mut model,
        &open,
        diff_answer("README.md", false, SMALL_DIFF, 9),
    );
    assert_eq!(model.diff(&k).unwrap().state, DiffState::Outdated);
    assert_eq!(model.counters().stale_dropped, 1);
}

#[test]
fn an_older_status_answered_after_a_newer_one_is_dropped() {
    let mut model = Changes::new();
    let first = model.refresh();
    let second = model.refresh();
    accept(
        &mut model,
        &second,
        status(2, vec![change("b.rs", " ", "M")]),
    );
    accept(
        &mut model,
        &first,
        status(1, vec![change("a.rs", " ", "M")]),
    );
    assert_eq!(model.counters().stale_dropped, 1);
    let groups = model.groups().unwrap();
    assert_eq!(groups.unstaged[0].path, "b.rs");
}

#[test]
fn an_answer_for_an_intent_the_model_does_not_hold_is_counted_not_applied() {
    let mut model = mixed();
    let next = model.complete(IntentId(999), &Outcome::Accepted, Some(&status(5, vec![])));
    assert!(next.is_empty());
    assert_eq!(model.counters().unknown, 1);
    assert_eq!(model.state(), PanelState::Ready);
}

#[test]
fn an_open_diff_is_marked_stale_when_its_file_changes_and_is_not_swapped() {
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    let open = model.toggle_diff_of(&k).unwrap().unwrap();
    accept(
        &mut model,
        &open,
        diff_answer("README.md", false, SMALL_DIFF, 1),
    );
    assert!(!model.diff(&k).unwrap().stale);
    let lines_before = model.diff(&k).unwrap().hunks().to_vec();
    // The file is edited again: the host reports the same file with other letters.
    let read = model.refresh();
    accept(
        &mut model,
        &read,
        status(
            2,
            vec![
                change("src/main.rs", "M", " "),
                change("README.md", " ", "D"),
                change("notes.txt", " ", "M"),
                change("new.txt", "?", "?"),
            ],
        ),
    );
    let view = model.diff(&k).unwrap();
    assert!(view.stale);
    assert_eq!(
        view.hunks(),
        lines_before.as_slice(),
        "the lines stay until reloaded"
    );
    assert!(render(&model, 90, 20).join("\n").contains("Out of date"));
    // Reloading asks again, and only the answer replaces the lines.
    let again = model.reload_diff(&k).unwrap().unwrap();
    assert!(matches!(again.kind, IntentKind::Diff { .. }));
    accept(
        &mut model,
        &again,
        diff_answer("README.md", false, SMALL_DIFF, 2),
    );
    assert!(!model.diff(&k).unwrap().stale);
}

#[test]
fn an_untouched_open_diff_is_not_marked_stale_by_a_new_status() {
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    let open = model.toggle_diff_of(&k).unwrap().unwrap();
    accept(
        &mut model,
        &open,
        diff_answer("README.md", false, SMALL_DIFF, 1),
    );
    let read = model.refresh();
    accept(
        &mut model,
        &read,
        status(
            1,
            vec![
                change("src/main.rs", "M", " "),
                change("README.md", " ", "M"),
                change("notes.txt", " ", "M"),
                change("new.txt", "?", "?"),
            ],
        ),
    );
    assert!(!model.diff(&k).unwrap().stale);
}

// ---- diff states ------------------------------------------------------------

#[test]
fn diff_reading_binary_empty_folder_and_problem_states() {
    let mut model = loaded(vec![
        change("logo.png", " ", "M"),
        change("mode.sh", " ", "M"),
        change("target/", "?", "?"),
        change("odd", "", ""),
        change("broken.rs", " ", "M"),
    ]);
    let binary = key(Section::Unstaged, "logo.png");
    let i = model.toggle_diff_of(&binary).unwrap().unwrap();
    accept(
        &mut model,
        &i,
        diff_answer(
            "logo.png",
            false,
            "Binary files a/logo.png and b/logo.png differ\n",
            1,
        ),
    );
    assert_eq!(model.diff(&binary).unwrap().state, DiffState::Binary);

    let empty = key(Section::Unstaged, "mode.sh");
    let i = model.toggle_diff_of(&empty).unwrap().unwrap();
    accept(
        &mut model,
        &i,
        diff_answer(
            "mode.sh",
            false,
            "diff --git a/mode.sh b/mode.sh\nold mode 100644\nnew mode 100755\n",
            1,
        ),
    );
    assert_eq!(model.diff(&empty).unwrap().state, DiffState::NoLines);

    let folder = key(Section::Untracked, "target/");
    assert_eq!(
        model.toggle_diff_of(&folder).unwrap(),
        None,
        "a folder asks nothing"
    );
    assert_eq!(model.diff(&folder).unwrap().state, DiffState::Folder);

    let none = key(Section::Unclassified, "odd");
    assert_eq!(model.toggle_diff_of(&none).unwrap(), None);
    assert_eq!(model.diff(&none).unwrap().state, DiffState::NoStatus);

    let broken = key(Section::Unstaged, "broken.rs");
    let i = model.toggle_diff_of(&broken).unwrap().unwrap();
    fail(
        &mut model,
        &i,
        Outcome::Refused {
            code: "path_outside".into(),
            reason: "outside the folder".into(),
        },
    );
    assert!(matches!(
        model.diff(&broken).unwrap().state,
        DiffState::Problem(Problem::Refused { .. })
    ));

    let screen = render(&model, 80, 30).join("\n");
    assert!(screen.contains("A binary file"));
    assert!(screen.contains("No line changes"));
    assert!(screen.contains("An untracked folder"));
    assert!(screen.contains("did not report this file's status"));
    assert!(screen.contains("path_outside"));
}

#[test]
fn a_diff_is_asked_the_way_the_section_compares() {
    let mut model = mixed();
    let staged = model
        .toggle_diff_of(&key(Section::Staged, "src/main.rs"))
        .unwrap()
        .unwrap();
    assert_eq!(
        staged.kind,
        IntentKind::Diff {
            path: "src/main.rs".into(),
            staged: true
        }
    );
    let unstaged = model
        .toggle_diff_of(&key(Section::Unstaged, "README.md"))
        .unwrap()
        .unwrap();
    assert_eq!(
        unstaged.kind,
        IntentKind::Diff {
            path: "README.md".into(),
            staged: false
        }
    );
}

#[test]
fn hunk_navigation_and_fold_work_and_hide_the_lines() {
    let two = "@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -10,2 +10,2 @@\n-x\n+y\n z\n";
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    model.select(&k, false);
    let i = model.toggle_diff().unwrap().unwrap();
    accept(&mut model, &i, diff_answer("README.md", false, two, 1));
    assert_eq!(model.diff(&k).unwrap().hunk, 0);
    model.move_hunk(1);
    assert_eq!(model.diff(&k).unwrap().hunk, 1);
    let open = render(&model, 60, 24).join("\n");
    assert!(open.contains("+y") || open.contains(" y"));
    model.toggle_fold();
    assert!(model.diff(&k).unwrap().folded.contains(&1));
    let folded = render(&model, 60, 24).join("\n");
    assert!(
        !folded.contains(" y"),
        "a folded hunk shows no lines: {folded}"
    );
    assert!(folded.contains("@@ -10,2 +10,2 @@"), "its header stays");
    model.toggle_fold();
    assert!(model.diff(&k).unwrap().folded.is_empty());
}

#[test]
fn hunk_staging_is_not_offered() {
    // No intent stages part of a file: the only stage and unstage requests carry paths.
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    let stage = model.stage().unwrap();
    assert_eq!(
        stage.kind,
        IntentKind::Stage {
            paths: vec!["README.md".into()]
        }
    );
    let tree = model.semantics("changes", ratatui::layout::Rect::new(0, 0, 60, 20));
    let offered: Vec<&str> = tree
        .nodes
        .iter()
        .flat_map(|n| &n.actions)
        .map(|a| a.id.as_str())
        .collect();
    assert!(
        offered
            .iter()
            .all(|id| !id.contains("StageHunk") && !id.contains("stageHunk"))
    );
}

// ---- mutations --------------------------------------------------------------

#[test]
fn stage_and_unstage_act_on_the_selection_in_the_right_sections() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.select(&key(Section::Untracked, "new.txt"), true);
    let stage = model.stage().unwrap();
    // Notes sit between README.md and new.txt in list order, so the range holds them too.
    assert_eq!(
        stage.kind,
        IntentKind::Stage {
            paths: vec!["README.md".into(), "notes.txt".into(), "new.txt".into()]
        }
    );
    accept_bare(&mut model, &stage);
}

#[test]
fn unstage_ignores_rows_that_are_not_staged() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    let err = model.unstage().unwrap_err();
    assert_eq!(err.code(), "no_paths");
    assert!(
        model
            .notices()
            .iter()
            .any(|n| n.problem.text().contains("no_paths"))
    );
    model.select(&key(Section::Staged, "src/main.rs"), false);
    assert_eq!(
        model.unstage().unwrap().kind,
        IntentKind::Unstage {
            paths: vec!["src/main.rs".into()]
        }
    );
}

#[test]
fn stage_all_and_unstage_all_take_every_row_of_the_section() {
    let mut model = mixed();
    assert_eq!(
        model.stage_all().unwrap().kind,
        IntentKind::Stage {
            paths: vec!["README.md".into(), "notes.txt".into()]
        }
    );
}

#[test]
fn one_mutation_runs_at_a_time() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    let stage = model.stage().unwrap();
    assert!(model.is_busy(ActionKind::Stage));
    assert_eq!(model.stage().unwrap_err(), Refusal::Busy(ActionKind::Stage));
    assert_eq!(
        model.commit().unwrap_err(),
        Refusal::Busy(ActionKind::Stage)
    );
    // The answer frees it, and a status read follows.
    let next = accept(&mut model, &stage, CompletionPayload::ScmState(repo(2)));
    assert_eq!(kinds(&next), vec![&IntentKind::Status]);
    assert!(!model.is_busy(ActionKind::Stage));
}

#[test]
fn no_status_means_no_mutation() {
    let mut model = Changes::new();
    assert_eq!(model.stage_all().unwrap_err(), Refusal::NotLoaded);
    assert_eq!(model.push().unwrap_err(), Refusal::NotLoaded);
}

#[test]
fn fetch_push_and_branch_requests_are_effects_the_wire_has() {
    let mut model = mixed();
    let fetch = model.fetch().unwrap();
    assert!(format!("{:?}", fetch.kind.effect_body()).contains("ScmFetch"));
    accept_bare(&mut model, &fetch);
    let push = model.push().unwrap();
    assert!(format!("{:?}", push.kind.effect_body()).contains("ScmPush"));
}

#[test]
fn amend_is_its_own_wire_kind_and_is_refused_when_the_host_does_not_offer_it() {
    use theorem_workbench_core::effect::{EffectBody, ScmAmend};
    assert_eq!(
        IntentKind::Commit {
            message: "m".into(),
            amend: true
        }
        .effect_body(),
        EffectBody::ScmAmend(ScmAmend {
            message: "m".into()
        })
    );
    assert_eq!(IntentKind::Branches.effect_body(), EffectBody::ScmBranches);
    let mut model = mixed();
    assert!(!model.amend_available());
    assert_eq!(
        model.set_amend(true).unwrap_err(),
        Refusal::AmendUnavailable
    );
    assert!(!model.amend());
}

// ---- confirm before discard -------------------------------------------------

#[test]
fn selecting_moving_and_focus_never_ask_to_discard() {
    let mut model = mixed();
    model.move_cursor(1, false);
    model.move_cursor(1, true);
    model.select_all();
    model.toggle_selected();
    model.set_focus(Focus::Message);
    model.focus_next();
    model.set_focus(Focus::Files);
    model.toggle_layout();
    assert_eq!(model.confirm_pending(), None);
    assert!(!model.is_busy(ActionKind::Discard));
}

#[test]
fn discard_asks_first_and_sends_nothing_until_confirmed() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.request_discard().unwrap();
    let pending = model.confirm_pending().cloned();
    assert!(matches!(pending, Some(Confirm::Discard(ref items)) if items.len() == 1));
    assert!(
        !model.is_busy(ActionKind::Discard),
        "nothing is sent by asking"
    );
    let screen = render(&model, 70, 16).join("\n");
    assert!(screen.contains("Discard README.md?"));
    assert!(screen.contains("Its unstaged changes are lost."));
    let sent = model.confirm().unwrap();
    assert_eq!(
        kinds(&sent),
        vec![&IntentKind::Discard {
            path: "README.md".into()
        }]
    );
    assert_eq!(model.confirm_pending(), None);
}

#[test]
fn cancelling_sends_nothing() {
    let mut model = mixed();
    model.select(&key(Section::Untracked, "new.txt"), false);
    model.request_discard().unwrap();
    model.cancel_confirm();
    assert_eq!(model.confirm_pending(), None);
    assert_eq!(model.confirm().unwrap_err(), Refusal::NothingToConfirm);
}

#[test]
fn discarding_staged_rows_is_not_offered() {
    let mut model = mixed();
    model.select(&key(Section::Staged, "src/main.rs"), false);
    assert_eq!(model.request_discard().unwrap_err().code(), "no_paths");
    assert_eq!(model.confirm_pending(), None);
}

#[test]
fn a_file_that_changed_since_the_question_is_not_discarded() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.request_discard().unwrap();
    let read = model.refresh();
    accept(
        &mut model,
        &read,
        status(
            2,
            vec![
                change("src/main.rs", "M", " "),
                change("README.md", " ", "D"),
                change("notes.txt", " ", "M"),
            ],
        ),
    );
    let sent = model.confirm().unwrap();
    assert!(sent.is_empty());
    assert!(
        model
            .notices()
            .iter()
            .any(|n| n.problem.text().contains("changed_since_asked"))
    );
}

#[test]
fn a_busy_model_leaves_the_question_open() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.request_discard().unwrap();
    // Another mutation starts first.
    model.select(&key(Section::Unstaged, "notes.txt"), false);
    let stage = model.stage().unwrap();
    assert_eq!(
        model.confirm().unwrap_err(),
        Refusal::Busy(ActionKind::Stage)
    );
    assert!(model.confirm_pending().is_some(), "the question stays open");
    accept_bare(&mut model, &stage);
}

#[test]
fn several_discards_run_one_after_the_other_and_stop_at_a_failure() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.select(&key(Section::Unstaged, "notes.txt"), true);
    model.request_discard().unwrap();
    let first = model.confirm().unwrap();
    assert_eq!(first.len(), 1, "one at a time");
    assert_eq!(
        first[0].kind,
        IntentKind::Discard {
            path: "README.md".into()
        }
    );
    assert!(model.in_flight().contains(&ActionKind::Discard));
    let next = accept(
        &mut model,
        &first[0],
        CompletionPayload::ScmDiscarded(ScmDiscarded {
            path: "README.md".into(),
            restore_id: "r1".into(),
            state: None,
        }),
    );
    assert_eq!(
        kinds(&next),
        vec![&IntentKind::Discard {
            path: "notes.txt".into()
        }]
    );
    let after = fail(
        &mut model,
        &next[0],
        Outcome::Failed {
            reason: "locked".into(),
        },
    );
    assert!(after.is_empty());
    assert!(!model.in_flight().contains(&ActionKind::Discard));
    assert!(
        model
            .notices()
            .iter()
            .any(|n| n.problem.text().contains("locked"))
    );
}

#[test]
fn a_discard_that_fails_sends_none_of_the_rest() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.select(&key(Section::Unstaged, "notes.txt"), true);
    model.request_discard().unwrap();
    let first = model.confirm().unwrap();
    let next = fail(
        &mut model,
        &first[0],
        Outcome::Refused {
            code: "path_outside".into(),
            reason: "no".into(),
        },
    );
    assert!(next.is_empty());
    assert!(!model.is_busy(ActionKind::Discard));
}

#[test]
fn restore_over_local_edits_asks_and_restore_over_a_clean_file_does_not() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.request_discard().unwrap();
    let discard = model.confirm().unwrap().remove(0);
    let next = accept(
        &mut model,
        &discard,
        CompletionPayload::ScmDiscarded(ScmDiscarded {
            path: "README.md".into(),
            restore_id: "r1".into(),
            state: None,
        }),
    );
    // The status after it shows the file clean.
    let clean = accept(
        &mut model,
        &next[0],
        status(2, vec![change("notes.txt", " ", "M")]),
    );
    assert!(clean.is_empty());
    let direct = model.restore_last().unwrap().unwrap();
    assert_eq!(
        direct.kind,
        IntentKind::Restore {
            restore_id: "r1".into()
        }
    );
    accept_bare(&mut model, &direct);

    // Discard it again, then edit the file before restoring.
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.request_discard().unwrap();
    let discard = model.confirm().unwrap().remove(0);
    let next = accept(
        &mut model,
        &discard,
        CompletionPayload::ScmDiscarded(ScmDiscarded {
            path: "README.md".into(),
            restore_id: "r2".into(),
            state: None,
        }),
    );
    accept(
        &mut model,
        &next[0],
        status(2, vec![change("README.md", " ", "M")]),
    );
    assert_eq!(
        model.restore_last().unwrap(),
        None,
        "asks instead of sending"
    );
    assert!(matches!(
        model.confirm_pending(),
        Some(Confirm::Restore { .. })
    ));
    let sent = model.confirm().unwrap();
    assert_eq!(
        kinds(&sent),
        vec![&IntentKind::Restore {
            restore_id: "r2".into()
        }]
    );
}

#[test]
fn restore_with_nothing_discarded_is_refused() {
    let mut model = mixed();
    assert_eq!(model.restore_last().unwrap_err(), Refusal::NoRestorePoint);
}

// ---- unknown results --------------------------------------------------------

fn commit_ready() -> Changes {
    let mut model = mixed();
    model.set_subject("fix the thing");
    model
}

#[test]
fn an_uncertain_commit_is_never_retried_and_blocks_the_next_mutation() {
    let mut model = commit_ready();
    let commit = model.commit().unwrap();
    assert_eq!(
        commit.kind,
        IntentKind::Commit {
            message: "fix the thing".into(),
            amend: false
        }
    );
    let next = fail(
        &mut model,
        &commit,
        Outcome::Uncertain {
            reason: "the connection dropped".into(),
        },
    );
    assert!(next.is_empty(), "nothing follows an unknown result");
    assert_eq!(model.unreconciled(), vec![ActionKind::Commit]);
    assert_eq!(model.subject(), "fix the thing", "the draft is kept");
    let screen = render(&model, 80, 24).join("\n");
    assert!(screen.contains("unknown result"));
    assert!(screen.contains("Refresh and check before trying again"));
    // No mutation is asked for until the state has been read.
    assert_eq!(
        model.commit().unwrap_err(),
        Refusal::Reconcile(ActionKind::Commit)
    );
    model.select(&key(Section::Unstaged, "README.md"), false);
    assert_eq!(
        model.stage().unwrap_err(),
        Refusal::Reconcile(ActionKind::Commit)
    );
}

#[test]
fn a_manual_refresh_reconciles_an_unknown_result() {
    let mut model = commit_ready();
    let commit = model.commit().unwrap();
    fail(
        &mut model,
        &commit,
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
    );
    let read = model.refresh();
    let next = accept(
        &mut model,
        &read,
        status(1, vec![change("src/main.rs", "M", " ")]),
    );
    assert!(model.unreconciled().is_empty());
    // The log is read again with it, to show whether the commit landed.
    assert!(
        next.iter()
            .any(|i| matches!(i.kind, IntentKind::Log { .. }))
    );
    assert!(model.commit().is_ok());
}

#[test]
fn a_read_asked_for_before_the_unknown_result_does_not_reconcile_it() {
    let mut model = commit_ready();
    let commit = model.commit().unwrap();
    let early = model.refresh();
    fail(
        &mut model,
        &commit,
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
    );
    accept(
        &mut model,
        &early,
        status(1, vec![change("src/main.rs", "M", " ")]),
    );
    assert_eq!(model.unreconciled(), vec![ActionKind::Commit]);
}

#[test]
fn a_refused_or_failed_mutation_is_shown_and_does_not_block() {
    let mut model = commit_ready();
    let commit = model.commit().unwrap();
    fail(
        &mut model,
        &commit,
        Outcome::Refused {
            code: "hook_failed".into(),
            reason: "pre-commit".into(),
        },
    );
    assert!(model.unreconciled().is_empty());
    assert_eq!(model.subject(), "fix the thing");
    assert!(render(&model, 80, 24).join("\n").contains("hook_failed"));
    assert!(model.commit().is_ok());
}

// ---- the draft --------------------------------------------------------------

#[test]
fn commit_needs_a_message_and_something_staged() {
    let mut model = mixed();
    assert_eq!(model.commit().unwrap_err(), Refusal::EmptyMessage);
    model.set_subject("   ");
    assert_eq!(model.commit().unwrap_err(), Refusal::EmptyMessage);
    let mut clean = loaded(vec![change("README.md", " ", "M")]);
    clean.set_subject("msg");
    assert_eq!(clean.commit().unwrap_err(), Refusal::NothingStaged);
}

#[test]
fn the_message_joins_subject_and_description() {
    let mut model = mixed();
    model.set_subject("subject");
    model.set_body("more words");
    assert_eq!(model.message(), "subject\n\nmore words");
}

#[test]
fn a_second_commit_is_not_started_while_one_runs() {
    let mut model = commit_ready();
    let first = model.commit().unwrap();
    assert_eq!(
        model.commit().unwrap_err(),
        Refusal::Busy(ActionKind::Commit)
    );
    accept_bare(&mut model, &first);
}

#[test]
fn an_accepted_commit_clears_the_draft_it_sent() {
    let mut model = commit_ready();
    model.set_body("details");
    let commit = model.commit().unwrap();
    accept(&mut model, &commit, CompletionPayload::ScmState(repo(2)));
    assert_eq!(model.subject(), "");
    assert_eq!(model.body(), "");
}

#[test]
fn text_typed_while_a_commit_runs_survives_its_acknowledgement() {
    let mut model = commit_ready();
    let commit = model.commit().unwrap();
    model.set_subject("fix the thing, and more");
    accept(&mut model, &commit, CompletionPayload::ScmState(repo(2)));
    assert_eq!(model.subject(), "fix the thing, and more");
}

#[test]
fn staging_all_then_committing_chains_through_the_stage_acknowledgement() {
    let mut model = loaded(vec![change("README.md", " ", "M")]);
    model.set_subject("docs");
    let stage = model.commit_staging_all().unwrap();
    assert_eq!(
        stage.kind,
        IntentKind::Stage {
            paths: vec!["README.md".into()]
        }
    );
    let next = accept(&mut model, &stage, CompletionPayload::ScmState(repo(2)));
    assert_eq!(
        kinds(&next),
        vec![&IntentKind::Commit {
            message: "docs".into(),
            amend: false
        }]
    );
    // A failed stage sends no commit.
    let mut model = loaded(vec![change("README.md", " ", "M")]);
    model.set_subject("docs");
    let stage = model.commit_staging_all().unwrap();
    let next = fail(
        &mut model,
        &stage,
        Outcome::Failed {
            reason: "locked".into(),
        },
    );
    assert!(next.is_empty());
    assert_eq!(model.subject(), "docs");
}

#[test]
fn the_log_is_asked_after_a_commit_and_read_in_full() {
    let mut model = commit_ready();
    let commit = model.commit().unwrap();
    let after = accept(&mut model, &commit, CompletionPayload::ScmState(repo(2)));
    let read = after.into_iter().next().unwrap();
    let next = accept(
        &mut model,
        &read,
        status(2, vec![change("README.md", " ", "M")]),
    );
    let log = next
        .into_iter()
        .find(|i| matches!(i.kind, IntentKind::Log { .. }))
        .unwrap();
    assert_eq!(log.kind, IntentKind::Log { max_count: RECENT });
    accept(&mut model, &log, log_answer(&["newest", "older"]));
    assert!(matches!(model.log(), LogState::Ready(entries) if entries.len() == 2));
    assert!(render(&model, 60, 30).join("\n").contains("newest"));
}

#[test]
fn a_repository_with_no_commit_has_no_log() {
    let mut model = Changes::new();
    let read = model.refresh();
    let payload = CompletionPayload::Scm(theorem_workbench_core::completion::ScmStatus {
        branch: Some("main".into()),
        head: None,
        changes: vec![change("a.rs", "?", "?")],
        state: Some(RepoState {
            head: None,
            ..repo(1)
        }),
    });
    let next = accept(&mut model, &read, payload);
    assert!(next.is_empty());
    assert_eq!(model.log(), &LogState::NoCommits);
}

// ---- branches ---------------------------------------------------------------

#[test]
fn branches_are_listed_and_switched_through_intents() {
    let mut model = mixed();
    let ask = model.open_branches();
    assert_eq!(ask.kind, IntentKind::Branches);
    accept(
        &mut model,
        &ask,
        CompletionPayload::ScmBranches(ScmBranches {
            branches: vec![
                BranchInfo {
                    name: "main".into(),
                    remote: false,
                    current: true,
                    upstream: Some("origin/main".into()),
                },
                BranchInfo {
                    name: "topic".into(),
                    remote: false,
                    current: false,
                    upstream: None,
                },
            ],
        }),
    );
    assert!(render(&model, 50, 12).join("\n").contains("topic"));
    model.move_cursor(1, false);
    let pick = model.pick_branch().unwrap();
    assert_eq!(
        pick.kind,
        IntentKind::SwitchBranch {
            name: "topic".into()
        }
    );
    let next = accept(&mut model, &pick, CompletionPayload::ScmState(repo(2)));
    assert_eq!(kinds(&next), vec![&IntentKind::Status]);
    assert_eq!(model.mode(), Mode::Changes);
    assert_eq!(
        model.create_branch("  ").unwrap_err(),
        Refusal::EmptyBranchName
    );
}

// ---- view state -------------------------------------------------------------

#[test]
fn view_state_round_trips_through_json_and_keeps_no_diff_text() {
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    model.select(&k, false);
    let open = model.toggle_diff().unwrap().unwrap();
    accept(
        &mut model,
        &open,
        diff_answer("README.md", false, SMALL_DIFF, 1),
    );
    model.set_subject("draft");
    model.set_body("more");
    model.toggle_layout();
    let saved = model.view_state();
    let json = serde_json::to_string(&saved).unwrap();
    assert!(!json.contains("println"), "no diff lines are saved");
    assert!(!json.contains("hello"));
    let back: ViewState = serde_json::from_str(&json).unwrap();
    assert_eq!(back, saved);

    // A new model takes it back: the draft at once, the open diff after the first status.
    let mut fresh = Changes::new();
    fresh.restore(&back);
    assert_eq!(fresh.subject(), "draft");
    assert_eq!(fresh.body(), "more");
    assert_eq!(fresh.layout(), DiffLayout::Split);
    let read = fresh.refresh();
    let next = accept(
        &mut fresh,
        &read,
        status(
            1,
            vec![
                change("src/main.rs", "M", " "),
                change("README.md", " ", "M"),
                change("notes.txt", " ", "M"),
                change("new.txt", "?", "?"),
            ],
        ),
    );
    assert!(next.iter().any(|i| i.kind
        == IntentKind::Diff {
            path: "README.md".into(),
            staged: false
        }));
    assert_eq!(fresh.cursor(), Some(&k));
    assert!(fresh.selected().contains(&k));
}

#[test]
fn restore_tolerates_paths_that_have_vanished() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.select(&key(Section::Unstaged, "notes.txt"), true);
    let open = model
        .toggle_diff_of(&key(Section::Unstaged, "notes.txt"))
        .unwrap()
        .unwrap();
    accept(
        &mut model,
        &open,
        diff_answer("notes.txt", false, SMALL_DIFF, 1),
    );
    let saved = model.view_state();

    let mut fresh = Changes::new();
    fresh.restore(&saved);
    let read = fresh.refresh();
    // Neither file is in the list any more.
    let next = accept(
        &mut fresh,
        &read,
        status(3, vec![change("other.rs", " ", "M")]),
    );
    assert!(
        !next
            .iter()
            .any(|i| matches!(i.kind, IntentKind::Diff { .. }))
    );
    assert!(fresh.selected().iter().all(|k| k.path == "other.rs"));
    assert_eq!(fresh.expanded().count(), 0);
    assert!(fresh.cursor().is_some_and(|k| k.path == "other.rs"));
}

#[test]
fn restore_after_the_list_exists_cuts_to_the_rows_there_are() {
    let mut model = loaded(vec![change("only.rs", " ", "M")]);
    let state = ViewState {
        version: VERSION,
        cursor: Some(key(Section::Unstaged, "gone.rs")),
        selected: vec![
            key(Section::Unstaged, "gone.rs"),
            key(Section::Unstaged, "only.rs"),
        ],
        expanded: vec![key(Section::Unstaged, "gone.rs")],
        scroll: 4,
        subject: "kept".into(),
        ..ViewState::default()
    };
    model.restore(&state);
    assert_eq!(model.selected().len(), 1);
    assert_eq!(model.cursor(), Some(&key(Section::Unstaged, "only.rs")));
    assert_eq!(model.subject(), "kept");
}

#[test]
fn another_version_restores_nothing() {
    let mut model = mixed();
    let state = ViewState {
        version: VERSION + 1,
        subject: "x".into(),
        ..ViewState::default()
    };
    model.restore(&state);
    assert_eq!(model.subject(), "");
}

#[test]
fn restore_does_not_enable_amend_the_host_does_not_offer() {
    let mut model = mixed();
    let state = ViewState {
        version: VERSION,
        amend: true,
        ..ViewState::default()
    };
    model.restore(&state);
    assert!(!model.amend());
}

// ---- semantics --------------------------------------------------------------

#[test]
fn semantics_describe_rows_with_level_position_state_and_actions() {
    let mut model = mixed();
    let k = key(Section::Unstaged, "README.md");
    model.select(&k, false);
    let open = model.toggle_diff().unwrap().unwrap();
    accept(
        &mut model,
        &open,
        diff_answer("README.md", false, SMALL_DIFF, 1),
    );
    let area = ratatui::layout::Rect::new(0, 0, 70, 24);
    let tree = model.semantics("changes", area);
    tree.validate().expect("a valid tree");
    let row = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "changes/file/Unstaged/README.md")
        .expect("the file row");
    assert_eq!(row.role, Role::TreeItem);
    assert_eq!(row.level, Some(2));
    assert_eq!((row.pos_in_set, row.set_size), (Some(1), Some(2)));
    assert!(row.state.selected);
    assert_eq!(row.state.expanded, Some(true));
    let ids: Vec<&str> = row.actions.iter().map(|a| a.id.as_str()).collect();
    assert!(
        ids.contains(&actions::STAGE)
            && ids.contains(&actions::DISCARD)
            && ids.contains(&actions::DIFF)
    );
    assert!(!ids.contains(&actions::UNSTAGE));
    assert!(
        tree.nodes
            .iter()
            .any(|n| n.role == Role::Document && n.id.as_str().contains("diff"))
    );
    let staged = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "changes/file/Staged/src/main.rs")
        .unwrap();
    assert!(
        staged
            .actions
            .iter()
            .any(|a| a.id.as_str() == actions::UNSTAGE)
    );
    assert!(
        staged
            .actions
            .iter()
            .all(|a| a.id.as_str() != actions::DISCARD)
    );
}

#[test]
fn semantics_offer_a_disabled_action_with_its_reason_while_busy() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    let stage = model.stage().unwrap();
    let tree = model.semantics("changes", ratatui::layout::Rect::new(0, 0, 70, 24));
    let row = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "changes/file/Unstaged/README.md")
        .unwrap();
    let action = row
        .actions
        .iter()
        .find(|a| a.id.as_str() == actions::STAGE)
        .unwrap();
    assert!(!action.enabled);
    assert!(
        action
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("still running"))
    );
    accept_bare(&mut model, &stage);
}

#[test]
fn semantics_show_the_confirm_as_a_dialog_and_amend_as_unavailable() {
    let mut model = mixed();
    model.select(&key(Section::Unstaged, "README.md"), false);
    model.request_discard().unwrap();
    let tree = model.semantics("changes", ratatui::layout::Rect::new(0, 0, 70, 24));
    tree.validate().unwrap();
    let dialog = tree
        .nodes
        .iter()
        .find(|n| n.role == Role::Dialog)
        .expect("a dialog");
    assert!(dialog.name.contains("Discard README.md"));
    assert!(
        dialog
            .actions
            .iter()
            .any(|a| a.id.as_str() == actions::CONFIRM)
    );
    // Without the host's `scm.commit.amend` the amend control is disabled, with the reason.
    let amend = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "changes/commit/amend")
        .unwrap();
    assert!(amend.state.disabled);
    assert!(
        amend
            .state
            .description
            .as_deref()
            .unwrap()
            .contains("scm.commit.amend")
    );
}

#[test]
fn semantics_of_every_panel_state_is_a_valid_tree() {
    let area = ratatui::layout::Rect::new(0, 0, 60, 20);
    let loading = Changes::new();
    loading.semantics("c", area).validate().unwrap();
    let mut refused = Changes::new();
    let read = refused.refresh();
    fail(
        &mut refused,
        &read,
        Outcome::Refused {
            code: "no_repository".into(),
            reason: "none".into(),
        },
    );
    let tree = refused.semantics("c", area);
    tree.validate().unwrap();
    assert!(tree.nodes.iter().any(|n| {
        n.state
            .description
            .as_deref()
            .is_some_and(|d| d.contains("no_repository"))
    }));
    loaded(vec![]).semantics("c", area).validate().unwrap();
    let mut model = mixed();
    model.open_branches();
    model.semantics("c", area).validate().unwrap();
}

#[test]
fn semantics_with_a_tiny_area_is_still_valid() {
    let model = mixed();
    for (w, h) in [(0, 0), (1, 1), (10, 3)] {
        model
            .semantics("c", ratatui::layout::Rect::new(0, 0, w, h))
            .validate()
            .unwrap();
    }
}

// ---- AC-53: nothing printed of a request, a diff, a file or a draft holds its content --

const SECRET: &str = "sk_live_51NzQx7Hk2LmP9dRtUvW3yZaBcDeFgHiJ";

#[test]
fn debug_and_display_of_a_request_a_diff_a_read_a_log_and_a_draft_never_hold_the_content() {
    let mut model = mixed();
    model.set_subject(format!("rotate {SECRET}"));
    model.set_body(format!("the key was {SECRET}"));
    let commit = model.commit().expect("a commit");
    assert!(
        matches!(commit.kind, IntentKind::Commit { .. }),
        "{commit:?}"
    );
    let shown = format!("{commit:?} {:?}", commit.kind);
    assert!(shown.contains("commit"), "still says what it is: {shown}");
    assert!(!shown.contains(SECRET), "{shown}");

    let diff_text = format!("@@ -1 +1 @@ fn {SECRET}\n-old\n+API_KEY={SECRET}\n");
    model.select(&key(Section::Staged, "src/main.rs"), false);
    let open = model.toggle_diff().unwrap().expect("a diff request");
    accept(
        &mut model,
        &open,
        diff_answer("src/main.rs", true, &diff_text, 1),
    );
    let hunks: Vec<Hunk> = model
        .diff(&key(Section::Staged, "src/main.rs"))
        .expect("the diff is open")
        .hunks()
        .to_vec();
    assert_eq!(
        hunks[0].lines[1].text,
        format!("API_KEY={SECRET}"),
        "the lines are there"
    );
    for dump in [
        format!("{hunks:?}"),
        format!("{model:?}"),
        format!("{:?}", model.view_state()),
    ] {
        assert!(!dump.contains(SECRET), "{dump}");
        assert!(!dump.contains("API_KEY"), "{dump}");
    }
    assert!(
        format!("{model:?}").contains("generation"),
        "it still says where it stands"
    );

    let bad = format!("@@ -1 +1 @@\n?{SECRET}\n");
    let error = parse(&bad).unwrap_err();
    for dump in [format!("{error:?}"), error.to_string()] {
        assert!(!dump.contains(SECRET), "{dump}");
    }

    let text = ReadBody::Text {
        exists: true,
        text: format!("TOKEN={SECRET}\n"),
    };
    assert!(!format!("{text:?}").contains(SECRET));
    let log = LogState::Ready(vec![theorem_workbench_core::completion::LogEntry {
        commit: "a1b2c3d".into(),
        author: "Ada".into(),
        email: None,
        timestamp: "0".into(),
        subject: format!("rotate {SECRET}"),
        body: Some(SECRET.into()),
    }]);
    assert!(!format!("{log:?}").contains(SECRET));
}

#[test]
fn a_diff_the_panel_cannot_read_says_so_without_the_line_that_failed() {
    let mut model = mixed();
    model.select(&key(Section::Staged, "src/main.rs"), false);
    let open = model.toggle_diff().unwrap().expect("a diff request");
    let bad = format!("@@ -1 +1 @@\n?API_KEY={SECRET}\n");
    accept(&mut model, &open, diff_answer("src/main.rs", true, &bad, 1));
    let view = model.diff(&key(Section::Staged, "src/main.rs")).unwrap();
    let DiffState::Unreadable(why) = &view.state else {
        panic!("{:?}", view.state)
    };
    assert!(why.contains("malformed"), "{why}");
    assert!(!why.contains(SECRET), "{why}");
    let screen = render(&model, 100, 30).join("\n");
    assert!(screen.contains("malformed"), "{screen}");
    assert!(!screen.contains(SECRET), "{screen}");
}
