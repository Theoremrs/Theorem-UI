//! Replace across the workspace, driven through a real root from the Search panel.

mod common;

use common::{WORKSPACE, agent, lines, open};
use keybinds::{Key, KeyInput, Mods};
use theorem_workbench_core::Theme;
use theorem_workbench_core::completion::{
    CompletionPayload, DocumentEdited, DocumentOpened, DocumentSaved, Outcome, PendingEdit,
    PendingState, ReadOnly, SearchStarted,
};
use theorem_workbench_core::effect::{CoordinateUnit, Effect, EffectBody, EffectKind};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ResourceRef, Revision};
use theorem_workbench_core::results::{MatchRange, ReadAt, SearchRow, SearchState, SpanEncoding};

const CAPS: [&str; 3] = ["files", "documents", "search.query"];

fn doc(path: &str) -> ResourceRef {
    ResourceRef::Document {
        workspace: WORKSPACE.into(),
        resource_id: path.into(),
    }
}

fn row(path: &str, line: u32, text: &str, start: u32, end: u32) -> SearchRow {
    SearchRow {
        path: path.into(),
        line,
        text: text.into(),
        matches: vec![MatchRange { start, end }],
        text_offset: None,
    }
}

fn page(rig: &common::Rig, rows: Vec<SearchRow>, encoding: SpanEncoding) -> HostMessage {
    HostMessage::SearchPage {
        id: "s1".into(),
        rows,
        skipped: 0,
        state: SearchState::Complete,
        end: None,
        read_at: ReadAt {
            workspace_id: WORKSPACE.into(),
            version: None,
            epoch: None,
            generation: rig.m.workspace().generation.0,
        },
        encoding,
    }
}

/// A finished search for `foo` over `rows`, with `replacement` typed in the Replace field and
/// the focus still there.
fn ready_in(
    caps: &[&'static str],
    rows: Vec<SearchRow>,
    replacement: &str,
    encoding: SpanEncoding,
) -> common::Rig {
    let (mut rig, _) = open("search", caps, WORKSPACE);
    rig.typed("foo");
    let sent = rig.key(Key::Enter);
    let start = sent
        .iter()
        .find(|e| matches!(e.body, EffectBody::SearchQuery(_)))
        .expect("a search went out")
        .clone();
    rig.accept(
        &start,
        CompletionPayload::SearchStarted(SearchStarted { id: "s1".into() }),
    );
    let done = page(&rig, rows, encoding);
    rig.host(done);
    rig.key(Key::Tab);
    rig.typed(replacement);
    rig
}

fn ready(rows: Vec<SearchRow>, replacement: &str) -> common::Rig {
    ready_in(&CAPS, rows, replacement, SpanEncoding::Utf16CodeUnits)
}

fn two_files() -> Vec<SearchRow> {
    vec![
        row("a.rs", 1, "let foo = 1;", 4, 7),
        row("b.rs", 2, "foo()", 0, 3),
    ]
}

fn status(rig: &common::Rig) -> String {
    rig.node("status").name
}

fn kinds(fx: &[Effect]) -> Vec<EffectKind> {
    fx.iter().map(Effect::kind).collect()
}

fn opened(text: &str, revision: u64) -> CompletionPayload {
    CompletionPayload::DocumentOpened(DocumentOpened {
        text: text.into(),
        revision: Revision::Seq(revision),
        saved_revision: Some(Revision::Seq(revision)),
        dirty: false,
        read_only: None,
        pending: vec![],
    })
}

fn edited(op: &str, revision: u64) -> CompletionPayload {
    CompletionPayload::DocumentEdited(DocumentEdited {
        operation_id: op.into(),
        revision: Revision::Seq(revision),
    })
}

fn saved(revision: u64) -> CompletionPayload {
    CompletionPayload::DocumentSaved(DocumentSaved {
        revision: Revision::Seq(revision),
    })
}

fn refused(code: &str, reason: &str) -> Outcome {
    Outcome::Refused {
        code: code.into(),
        reason: reason.into(),
    }
}

fn uncertain(reason: &str) -> Outcome {
    Outcome::Uncertain {
        reason: reason.into(),
    }
}

fn failed(reason: &str) -> Outcome {
    Outcome::Failed {
        reason: reason.into(),
    }
}

fn only(fx: &[Effect], kind: EffectKind) -> Effect {
    let found: Vec<_> = fx.iter().filter(|e| e.kind() == kind).collect();
    assert_eq!(found.len(), 1, "{:?}", kinds(fx));
    found[0].clone()
}

/// Asks (Enter in Replace) and confirms (Enter), giving the effects the confirmation sent.
fn confirmed(rig: &mut common::Rig) -> Vec<Effect> {
    assert!(rig.key(Key::Enter).is_empty(), "asking sends nothing");
    rig.key(Key::Enter)
}

/// Runs one file through a clean open, edit and save, returning the effects of each step.
struct Walk {
    open: Effect,
    edit: Effect,
    save: Effect,
    after_save: Vec<Effect>,
}

fn walk(rig: &mut common::Rig, open: &Effect, text: &str, rev: u64) -> Walk {
    let fx = rig.accept(open, opened(text, rev));
    let edit = only(&fx, EffectKind::DocumentEdit);
    let op = match &edit.body {
        EffectBody::DocumentEdit(e) => e.operation_id.clone(),
        _ => unreachable!(),
    };
    let fx = rig.accept(&edit, edited(&op, rev + 1));
    let save = only(&fx, EffectKind::DocumentSave);
    let after_save = rig.accept(&save, saved(rev + 1));
    Walk {
        open: open.clone(),
        edit,
        save,
        after_save,
    }
}

fn screen(rig: &common::Rig) -> String {
    rig.screen().join("\n").replace("  ", " ")
}

/// The screen as running words: wrapped lines joined, the Search chip and runs of spaces gone.
fn flat(rig: &common::Rig) -> String {
    rig.screen()
        .join(" ")
        .replace("[Search]", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- the question and the preview -------------------------------------------------------------

#[test]
fn the_preview_shows_each_matchs_line_before_and_after_and_the_question_the_counts() {
    let mut rig = ready(two_files(), "bar");
    assert!(rig.key(Key::Enter).is_empty());
    let text = screen(&rig);
    assert!(text.contains("a.rs (1 match)"), "{text}");
    assert!(text.contains("1 - let foo = 1;"), "{text}");
    assert!(text.contains("+ let bar = 1;"), "{text}");
    assert!(
        text.contains("2 - foo()") && text.contains("+ bar()"),
        "{text}"
    );
    assert_eq!(
        status(&rig),
        "Replace 2 matches in 2 files with \"bar\"? Enter replaces and saves each file, one at a time. Esc cancels. Find and Replace stay as typed until you answer."
            .replace(" Find and Replace stay as typed until you answer.", "")
    );
}

#[test]
fn nothing_is_sent_until_the_person_confirms_and_cancelling_sends_nothing_ever() {
    let mut rig = ready(two_files(), "bar");
    assert!(rig.key(Key::Enter).is_empty());
    assert!(rig.ticks(5).is_empty(), "a question is not an answer");
    assert!(rig.key(Key::Esc).is_empty());
    assert!(rig.ticks(5).is_empty());
    assert!(!rig.text().contains("Replace 2 matches"));
    // The same through the actions: the ask sends nothing, the confirm does.
    assert!(
        rig.action(
            "search.replaceAll",
            theorem_workbench_core::ids::Actor::Human
        )
        .is_empty()
    );
    let fx = rig.action(
        "search.replaceConfirm",
        theorem_workbench_core::ids::Actor::Human,
    );
    assert_eq!(kinds(&fx), [EffectKind::DocumentOpen]);
}

#[test]
fn the_replace_actions_are_the_persons_only_and_an_agents_request_is_refused() {
    let mut rig = ready(two_files(), "bar");
    for id in [
        "search.replaceAll",
        "search.replaceInFile",
        "search.replaceConfirm",
    ] {
        assert!(rig.action(id, agent()).is_empty(), "{id}");
        assert!(
            !rig.text().contains("Replace 2 matches"),
            "{id} opened a question"
        );
    }
    // Even with the question open, an agent cannot answer it.
    assert!(rig.key(Key::Enter).is_empty());
    assert!(rig.action("search.replaceConfirm", agent()).is_empty());
    assert!(rig.ticks(3).is_empty());
    let mut registry = theorem_workbench_core::builtin::registry();
    theorem_workbench_ide::extend_registry(&mut registry).unwrap();
    for id in [
        "search.replaceAll",
        "search.replaceInFile",
        "search.replaceConfirm",
    ] {
        let (_, a) = registry
            .action(&theorem_workbench_core::ids::ActionId::new(id))
            .unwrap();
        assert!(a.human_only, "{id}");
    }
}

#[test]
fn replace_in_file_asks_about_the_selected_file_only() {
    let mut rig = ready(two_files(), "bar");
    rig.key(Key::Esc); // to the results
    rig.key(Key::Down);
    assert!(rig.mods(Key::Enter, Mods::ALT).is_empty());
    assert_eq!(
        status(&rig),
        "Replace 1 match in 1 file (b.rs) with \"bar\"? Enter replaces and saves each file, one at a time. Esc cancels."
    );
    let fx = rig.key(Key::Enter);
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].resource, doc("b.rs"));
}

#[test]
fn an_empty_replacement_says_it_deletes_and_regex_says_references_are_not_expanded() {
    let mut rig = ready(two_files(), "");
    rig.key(Key::Enter);
    assert!(status(&rig).starts_with("Delete (replace with nothing) 2 matches in 2 files?"));

    // Without regex a `$` is only text: nothing to explain.
    let mut plain = ready(two_files(), "$1");
    plain.key(Key::Enter);
    assert!(
        !status(&plain).contains("capture references"),
        "{}",
        status(&plain)
    );

    // With regex on, the search is run with it, and the question says `$1` is inserted as typed.
    let (mut rig, _) = open("search", &CAPS, WORKSPACE);
    rig.mods(Key::Char('r'), Mods::ALT);
    rig.typed("fo+");
    let start = rig
        .key(Key::Enter)
        .into_iter()
        .find(|e| matches!(e.body, EffectBody::SearchQuery(_)))
        .expect("a search went out");
    rig.accept(
        &start,
        CompletionPayload::SearchStarted(SearchStarted { id: "s1".into() }),
    );
    let done = page(&rig, two_files(), SpanEncoding::Utf16CodeUnits);
    rig.host(done);
    rig.key(Key::Tab);
    rig.typed("[$1]");
    rig.key(Key::Enter);
    assert!(
        status(&rig).contains("capture references such as $1 are not expanded"),
        "{}",
        status(&rig)
    );
    // And it is true: the edit carries the text as typed.
    let open = rig.key(Key::Enter).remove(0);
    let fx = rig.accept(&open, opened("let foo = 1;\n", 1));
    match &only(&fx, EffectKind::DocumentEdit).body {
        EffectBody::DocumentEdit(e) => assert_eq!(e.edits[0].insert, "[$1]"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn replace_is_refused_in_words_when_it_cannot_be_asked() {
    // No documents capability.
    let mut rig = ready_in(
        &["files", "search.query"],
        two_files(),
        "bar",
        SpanEncoding::Utf16CodeUnits,
    );
    assert!(rig.key(Key::Enter).is_empty());
    assert!(
        flat(&rig).contains("this host does not report the \"documents\" capability"),
        "{}",
        flat(&rig)
    );
    // Nothing to replace before a search has been read.
    let (mut rig, _) = open("search", &CAPS, WORKSPACE);
    rig.key(Key::Tab);
    assert!(rig.key(Key::Enter).is_empty());
    assert!(!flat(&rig).contains("Replace 0"), "{}", flat(&rig));
    assert!(
        rig.action(
            "search.replaceConfirm",
            theorem_workbench_core::ids::Actor::Human
        )
        .is_empty()
    );
}

// ---- a clean run -------------------------------------------------------------------------------

#[test]
fn a_clean_run_opens_edits_against_the_opened_revision_saves_and_closes_one_file_at_a_time() {
    let mut rig = ready(two_files(), "bar");
    let fx = confirmed(&mut rig);
    assert_eq!(kinds(&fx), [EffectKind::DocumentOpen]);
    let open_a = fx[0].clone();
    assert_eq!(open_a.resource, doc("a.rs"));
    assert!(status(&rig).contains("locked"), "{}", status(&rig));

    let w = walk(&mut rig, &open_a, "let foo = 1;\n", 7);
    match &w.edit.body {
        EffectBody::DocumentEdit(e) => {
            assert_eq!(e.unit, CoordinateUnit::Utf16);
            assert!(e.operation_id.starts_with("search-replace."));
            assert_eq!(e.edits.len(), 1);
            assert_eq!(
                (e.edits[0].start, e.edits[0].end, e.edits[0].insert.as_str()),
                (4, 7, "bar")
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        w.edit.revision,
        Some(Revision::Seq(7)),
        "against the opened revision"
    );
    assert_eq!(
        w.save.revision,
        Some(Revision::Seq(8)),
        "saved at the accepted revision"
    );
    assert_eq!(w.edit.resource, doc("a.rs"));
    assert_eq!(kinds(&w.after_save), [EffectKind::DocumentClose]);
    assert_eq!(w.after_save[0].resource, doc("a.rs"));
    let _ = w.open;

    // The next file waits for the next tick: there is a moment to stop between files.
    let fx = rig.tick();
    assert_eq!(kinds(&fx), [EffectKind::DocumentOpen]);
    assert_eq!(fx[0].resource, doc("b.rs"));
    let w = walk(&mut rig, &fx[0], "\nfoo()\n", 3);
    match &w.edit.body {
        EffectBody::DocumentEdit(e) => {
            assert_eq!((e.edits[0].start, e.edits[0].end), (1, 4));
        }
        other => panic!("{other:?}"),
    }
    let text = flat(&rig);
    assert!(
        status(&rig).starts_with("2 files changed (2 matches), 0 skipped, 0 failed, 0 unknown."),
        "{}\n{text}",
        status(&rig)
    );
    assert!(text.contains("a.rs: 1 match replaced and saved"), "{text}");
    // The summary stays until it is dismissed.
    assert!(rig.ticks(5).is_empty());
    assert!(flat(&rig).contains("a.rs: 1 match replaced and saved"));
    rig.key(Key::Esc);
    assert!(!flat(&rig).contains("replaced and saved"));
}

#[test]
fn a_file_whose_text_moved_since_the_search_is_skipped_and_the_run_goes_on() {
    let mut rig = ready(two_files(), "bar");
    let open_a = confirmed(&mut rig).remove(0);
    let fx = rig.accept(&open_a, opened("let fox = 1;\n", 2));
    assert_eq!(
        kinds(&fx),
        [EffectKind::DocumentClose],
        "no edit for a moved file"
    );
    let fx = rig.tick();
    walk(&mut rig, &fx[0], "\nfoo()\n", 1);
    let text = flat(&rig);
    assert!(
        text.contains(
            "a.rs: changed since the search: line 1 no longer reads what the search found"
        ),
        "{text}"
    );
    assert!(status(&rig).starts_with("1 file changed (1 match), 1 skipped"));
}

#[test]
fn a_file_that_is_unsaved_unsettled_or_read_only_is_skipped_with_the_owners_words() {
    let cases: Vec<(DocumentOpened, &str)> = vec![
        (
            DocumentOpened {
                text: "let foo = 1;".into(),
                revision: Revision::Seq(1),
                saved_revision: Some(Revision::Seq(0)),
                dirty: true,
                read_only: None,
                pending: vec![],
            },
            "it has unsaved changes (the owner reports it dirty)",
        ),
        (
            DocumentOpened {
                text: "let foo = 1;".into(),
                revision: Revision::Seq(1),
                saved_revision: Some(Revision::Seq(1)),
                dirty: false,
                read_only: Some(ReadOnly {
                    reason: "the checkout is locked".into(),
                }),
                pending: vec![],
            },
            "read-only: the checkout is locked",
        ),
        (
            DocumentOpened {
                text: "let foo = 1;".into(),
                revision: Revision::Seq(1),
                saved_revision: Some(Revision::Seq(1)),
                dirty: true,
                read_only: None,
                pending: vec![PendingEdit {
                    operation_id: "op".into(),
                    base_revision: Revision::Seq(1),
                    edits: vec![],
                    state: PendingState::Restored,
                    reason: Some("kept on this device".into()),
                }],
            },
            "the owner holds 1 unsettled edit for it (Restored: kept on this device)",
        ),
    ];
    for (o, words) in cases {
        let mut rig = ready(vec![row("a.rs", 1, "let foo = 1;", 4, 7)], "bar");
        let open = confirmed(&mut rig).remove(0);
        let fx = rig.accept(&open, CompletionPayload::DocumentOpened(o));
        assert_eq!(kinds(&fx), [EffectKind::DocumentClose], "{words}: no edit");
        let text = flat(&rig);
        assert!(text.contains(&format!("a.rs: {words}")), "{words}: {text}");
        assert!(status(&rig).contains("1 skipped"));
    }
}

#[test]
fn a_refusal_to_open_is_a_skip_in_the_owners_words_a_failure_fails_and_unknown_is_not_retried() {
    for (outcome, line, bucket) in [
        (
            refused("too_large", "over the limit"),
            "a.rs: opening it refused (too_large): over the limit",
            "1 skipped",
        ),
        (
            failed("disk gone"),
            "a.rs: opening it failed: disk gone",
            "1 failed",
        ),
        (
            uncertain("timed out"),
            "a.rs: whether it opened is unknown (timed out); nothing was sent after it",
            "1 unknown",
        ),
    ] {
        let mut rig = ready(vec![row("a.rs", 1, "let foo = 1;", 4, 7)], "bar");
        let open = confirmed(&mut rig).remove(0);
        let fx = rig.answer(&open, outcome, None);
        assert!(fx.is_empty(), "{line}: nothing is sent for it after");
        assert!(rig.ticks(3).is_empty());
        assert!(flat(&rig).contains(line), "{}", rig.text());
        assert!(status(&rig).contains(bucket), "{}", status(&rig));
    }
}

fn two_file_run_with_first(stage: &str, outcome: Outcome) -> (common::Rig, Vec<Effect>) {
    let mut rig = ready(two_files(), "bar");
    let open_a = confirmed(&mut rig).remove(0);
    let fx = rig.accept(&open_a, opened("let foo = 1;\n", 5));
    let edit = only(&fx, EffectKind::DocumentEdit);
    let op = match &edit.body {
        EffectBody::DocumentEdit(e) => e.operation_id.clone(),
        _ => unreachable!(),
    };
    let fx = if stage == "edit" {
        rig.answer(&edit, outcome, None)
    } else {
        let fx = rig.accept(&edit, edited(&op, 6));
        let save = only(&fx, EffectKind::DocumentSave);
        rig.answer(&save, outcome, None)
    };
    (rig, fx)
}

#[test]
fn each_refusal_failure_and_uncertain_answer_on_the_edit_lands_in_its_line_and_the_run_goes_on() {
    for (outcome, line, bucket, released) in [
        (
            refused("conflict", "the file changed"),
            "a.rs: the edit refused (conflict): the file changed; nothing was changed",
            "1 skipped",
            vec![EffectKind::DocumentSettle, EffectKind::DocumentClose],
        ),
        (
            failed("the owner fell over"),
            "a.rs: the edit failed: the owner fell over; nothing was changed",
            "1 failed",
            vec![EffectKind::DocumentSettle, EffectKind::DocumentClose],
        ),
        (
            uncertain("no answer"),
            "a.rs: whether the edit was applied is unknown (no answer); nothing was sent after it",
            "1 unknown",
            vec![],
        ),
    ] {
        let (mut rig, fx) = two_file_run_with_first("edit", outcome);
        assert_eq!(kinds(&fx), released, "{line}");
        if released.is_empty() {
            assert!(rig.ticks(0).is_empty());
        }
        // Not retried, and the run goes on: the next tick opens the second file.
        let fx = rig.tick();
        assert_eq!(kinds(&fx), [EffectKind::DocumentOpen], "{line}");
        assert_eq!(fx[0].resource, doc("b.rs"));
        walk(&mut rig, &fx[0], "\nfoo()\n", 1);
        assert!(flat(&rig).contains(line), "{}", rig.text());
        assert!(status(&rig).contains(bucket), "{}", status(&rig));
        assert!(
            status(&rig).starts_with("1 file changed (1 match)"),
            "{}",
            status(&rig)
        );
    }
}

#[test]
fn each_refusal_failure_and_uncertain_answer_on_the_save_lands_in_its_line_and_the_run_goes_on() {
    for (outcome, line, bucket, released) in [
        (
            refused("conflict", "disk moved"),
            "a.rs: the edit was applied but is not saved: the save refused (conflict): disk moved",
            "1 skipped",
            vec![EffectKind::DocumentClose],
        ),
        (
            failed("no space"),
            "a.rs: the edit was applied but is not saved: the save failed: no space",
            "1 failed",
            vec![EffectKind::DocumentClose],
        ),
        (
            uncertain("lost"),
            "a.rs: the edit was applied; whether it was saved is unknown (lost); nothing was sent after it",
            "1 unknown",
            vec![],
        ),
    ] {
        let (mut rig, fx) = two_file_run_with_first("save", outcome);
        assert_eq!(kinds(&fx), released, "{line}");
        let fx = rig.tick();
        assert_eq!(kinds(&fx), [EffectKind::DocumentOpen], "{line}");
        walk(&mut rig, &fx[0], "\nfoo()\n", 1);
        assert!(flat(&rig).contains(line), "{}", rig.text());
        assert!(status(&rig).contains(bucket), "{}", status(&rig));
    }
}

// ---- stopping -------------------------------------------------------------------------------------

#[test]
fn stopping_between_files_keeps_what_was_done_reports_the_rest_and_a_late_answer_changes_nothing() {
    let mut rig = ready(two_files(), "bar");
    let open_a = confirmed(&mut rig).remove(0);
    let w = walk(&mut rig, &open_a, "let foo = 1;\n", 1);
    let close = w.after_save[0].clone();
    // The first file is done; the second has not opened. Stop here.
    assert!(rig.key(Key::Esc).is_empty());
    assert!(rig.ticks(4).is_empty(), "the second file never opens");
    let text = flat(&rig);
    assert!(
        status(&rig).starts_with(
            "1 file changed (1 match), 0 skipped, 0 failed, 0 unknown, 1 not started."
        ),
        "{}",
        status(&rig)
    );
    assert!(
        text.contains("Changed 1:") && text.contains("Not started 1:") && text.contains("b.rs"),
        "{text}"
    );
    assert!(status(&rig).contains("Stopped by you; what was done stays done."));
    // The answer to the first file's close comes late, and says it failed: nothing changes.
    let before = rig.text();
    let fx = rig.answer(&close, failed("too late"), None);
    assert!(fx.is_empty());
    assert_eq!(rig.text(), before);
}

#[test]
fn stopping_in_the_middle_of_a_file_lets_that_file_finish_and_starts_no_other() {
    let mut rig = ready(two_files(), "bar");
    let open_a = confirmed(&mut rig).remove(0);
    assert!(rig.key(Key::Esc).is_empty());
    assert!(status(&rig).starts_with("Stopping after file 1 of 2; what was done stays done."));
    let w = walk(&mut rig, &open_a, "let foo = 1;\n", 1);
    assert_eq!(kinds(&w.after_save), [EffectKind::DocumentClose]);
    assert!(rig.ticks(3).is_empty());
    assert!(
        status(&rig).contains("1 file changed (1 match)") && status(&rig).contains("1 not started")
    );
}

#[test]
fn the_find_and_replace_fields_are_locked_while_it_runs_and_the_tree_says_why() {
    let mut rig = ready(two_files(), "bar");
    confirmed(&mut rig);
    for c in "xyz".chars() {
        rig.ch(c);
    }
    rig.send(theorem_workbench_core::Msg::Text("pasted".into()));
    let q = rig.node("query");
    let r = rig.node("replacement");
    assert_eq!(q.text.as_deref(), Some("foo"));
    assert_eq!(r.text.as_deref(), Some("bar"));
    for n in [&q, &r] {
        assert!(n.state.disabled);
        assert!(
            n.state
                .description
                .as_deref()
                .unwrap()
                .contains("Locked while a replace"),
            "{:?}",
            n.state.description
        );
    }
    assert!(!rig.panel().text_entry());
    assert!(rig.panel().holds_escape());
    assert!(status(&rig).contains(
        "Find and Replace are locked until it ends, so the matches stay as you confirmed."
    ));
    // A new search is refused too.
    assert!(
        rig.action("search.run", theorem_workbench_core::ids::Actor::Human)
            .is_empty()
    );
}

// ---- coordinates ------------------------------------------------------------------------------------

#[test]
fn ranges_over_multibyte_and_astral_text_land_where_the_owner_counts_them_in_every_encoding() {
    // Line 2 follows an astral character and a line break; its own text has astral, CJK.
    let doc_text = "\u{1F600}\n\u{1D54F}\u{65E5} foo \u{1F600} foo\n";
    // UTF-16 units: the X (2) the CJK (1) a space (1) -> foo at 4..7, second foo at 10..13.
    let (u16s, u8s, scalars) = ([(4, 7), (11, 14)], [(8, 11), (17, 20)], [(3, 6), (9, 12)]);
    for (encoding, ranges) in [
        (SpanEncoding::Utf16CodeUnits, u16s),
        (SpanEncoding::Utf8Bytes, u8s),
        (SpanEncoding::UnicodeScalars, scalars),
    ] {
        let text = "\u{1D54F}\u{65E5} foo \u{1F600} foo";
        let mut r = row("a.txt", 2, text, ranges[0].0, ranges[0].1);
        r.matches.push(MatchRange {
            start: ranges[1].0,
            end: ranges[1].1,
        });
        let mut rig = ready_in(&CAPS, vec![r], "\u{1D54F}", encoding);
        let open = confirmed(&mut rig).remove(0);
        let fx = rig.accept(&open, opened(doc_text, 1));
        let edit = only(&fx, EffectKind::DocumentEdit);
        match &edit.body {
            EffectBody::DocumentEdit(e) => {
                // The first line is the astral character (2) and its break (1).
                let got: Vec<(u32, u32, &str)> = e
                    .edits
                    .iter()
                    .map(|c| (c.start, c.end, c.insert.as_str()))
                    .collect();
                assert_eq!(
                    got,
                    [(7, 10, "\u{1D54F}"), (14, 17, "\u{1D54F}")],
                    "{encoding:?}"
                );
            }
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn a_match_that_is_no_longer_on_its_line_in_an_astral_text_is_found_out_not_guessed() {
    let mut rig = ready(vec![row("a.txt", 1, "\u{1F600} foo", 3, 6)], "bar");
    let open = confirmed(&mut rig).remove(0);
    let fx = rig.accept(&open, opened("\u{1F600}\u{1F600} foo\n", 1));
    assert_eq!(kinds(&fx), [EffectKind::DocumentClose]);
    assert!(flat(&rig).contains("changed since the search"));
}

// ---- hostile text ---------------------------------------------------------------------------------

#[test]
fn hostile_text_is_spelled_out_in_the_question_the_preview_and_the_summary() {
    let hostile_row = row(
        "dir/\u{1b}[31mevil\u{202e}.rs",
        1,
        "a\u{1b}[2Jfoo\u{7}",
        5,
        8,
    );
    let mut rig = ready(vec![hostile_row], "\u{1b}[0mR\u{202e}");
    rig.key(Key::Enter);
    let all = rig.screen().join("\n");
    for c in all.chars() {
        assert!(!c.is_control() || c == '\n', "{c:?} reached the screen");
        assert!(!matches!(c, '\u{202e}'), "bidi override reached the screen");
    }
    let flat = all.replace(['\n', ' '], "");
    assert!(flat.contains("dir/\\u{1b}[31mevil\\u{202e}.rs"), "{all}");
    assert!(flat.contains("a\\u{1b}[2Jfoo\\u{7}"), "{all}");
    assert!(
        flat.contains("a\\u{1b}[2J\\u{1b}[0mR\\u{202e}\\u{7}"),
        "{all}"
    );
    let q = status(&rig);
    assert!(q.contains("with \"\\u{1b}[0mR\\u{202e}\""), "{q}");
    // The tree is made safe the same way.
    for n in rig.nodes() {
        assert!(
            !n.name.chars().any(|c| c.is_control() || c == '\u{202e}'),
            "{:?}",
            n.name
        );
    }
    // And the wrapped lines are not clipped at 24 columns.
    rig.resize(60, 30);
    let _ = lines(&rig.cells(&Theme::plain(), 24, 20));
}

#[test]
fn the_semantic_tree_is_valid_through_the_question_the_run_and_the_summary() {
    let mut rig = ready(two_files(), "bar");
    let valid = |rig: &common::Rig| {
        theorem_workbench_core::tree::semantics(&rig.m)
            .validate()
            .expect("a valid tree")
    };
    valid(&rig);
    rig.key(Key::Enter);
    valid(&rig);
    let ids: Vec<String> = rig
        .nodes()
        .iter()
        .map(|n| n.id.as_str().to_owned())
        .collect();
    assert!(ids.contains(&"replace-lines".to_owned()), "{ids:?}");
    let lines_node = rig.node("replace-lines");
    assert_eq!(lines_node.name, "Replace preview");
    let open = rig.key(Key::Enter).remove(0);
    valid(&rig);
    assert_eq!(rig.node("replace-lines").name, "Replace progress");
    assert!(rig.node("replace-lines").state.busy);
    let w = walk(&mut rig, &open, "let foo = 1;\n", 1);
    let _ = w;
    rig.key(Key::Esc);
    valid(&rig);
    assert_eq!(rig.node("replace-lines").name, "Replace summary");
    rig.key(Key::Esc);
    valid(&rig);
    assert!(rig.nodes().iter().all(|n| n.id.as_str() != "replace-lines"));
}

#[test]
fn the_replacement_is_saved_with_the_panel_and_a_restored_panel_asks_nothing() {
    let rig = ready(two_files(), "bar");
    let saved = rig.panel().serialize();
    assert_eq!(saved["replacement"], "bar");
    let (mut fresh, fx) = common::open_with("search", &CAPS, WORKSPACE, Some(saved));
    assert!(fx.is_empty());
    assert!(fresh.ticks(3).is_empty());
    assert!(fresh.text().contains("bar"));
    let _ = KeyInput::new(Key::Esc, Mods::NONE);
}
