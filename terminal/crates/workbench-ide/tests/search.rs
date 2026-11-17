//! The Search panel driven through a real root.

mod common;

use common::{WORKSPACE, marked, names, open, open_with, row_with};
use keybinds::{Key, KeyInput, Mods};
use ratatui::style::{Color, Style};
use serde_json::json;
use theorem_workbench_core::Theme;
use theorem_workbench_core::completion::{CompletionPayload, Outcome, SearchStarted};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::results::{
    MatchRange, ReadAt, SearchEnd, SearchEndOutcome, SearchRow, SearchState, SpanEncoding,
};
use theorem_workbench_ide::SearchPanel;

const CAPS: [&str; 3] = ["files", "documents", "search.query"];

fn rig() -> common::Rig {
    open("search", &CAPS, WORKSPACE).0
}

fn page(rig: &common::Rig, id: &str, rows: Vec<SearchRow>, state: SearchState) -> HostMessage {
    page_in(rig, id, rows, state, SpanEncoding::Utf16CodeUnits)
}

fn page_in(
    rig: &common::Rig,
    id: &str,
    rows: Vec<SearchRow>,
    state: SearchState,
    encoding: SpanEncoding,
) -> HostMessage {
    HostMessage::SearchPage {
        id: id.into(),
        rows,
        skipped: 0,
        state,
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

fn row(path: &str, line: u32, text: &str, start: u32, end: u32) -> SearchRow {
    SearchRow {
        path: path.into(),
        line,
        text: text.into(),
        matches: vec![MatchRange { start, end }],
        text_offset: None,
    }
}

/// Types `query`, presses Enter and answers the start with `id`.
fn search_for(rig: &mut common::Rig, query: &str, id: &str) -> Vec<Effect> {
    rig.typed(query);
    let sent = rig.key(Key::Enter);
    let start = sent
        .iter()
        .find(|e| matches!(e.body, EffectBody::SearchQuery(_)))
        .expect("a search query went out")
        .clone();
    rig.accept(
        &start,
        CompletionPayload::SearchStarted(SearchStarted { id: id.into() }),
    );
    sent
}

/// The status line in full, as the semantic tree carries it: the screen may wrap it.
fn status(rig: &common::Rig) -> String {
    rig.node("status").name
}

fn search_query(effects: &[Effect]) -> theorem_workbench_core::effect::SearchQuery {
    effects
        .iter()
        .find_map(|e| match &e.body {
            EffectBody::SearchQuery(q) => Some(q.clone()),
            _ => None,
        })
        .expect("a search query went out")
}

#[test]
fn typing_a_query_and_pressing_enter_sends_one_search_with_the_toggles_and_globs() {
    let mut rig = rig();
    rig.typed("needle");
    rig.mods(Key::Char('r'), Mods::ALT);
    rig.mods(Key::Char('w'), Mods::ALT);
    rig.key(Key::Tab);
    rig.key(Key::Tab);
    rig.typed("src/**/*.rs, docs/**");
    rig.key(Key::Tab);
    rig.typed("**/target/**");
    let sent = rig.key(Key::Enter);
    assert_eq!(names(&sent), ["search"]);
    let q = search_query(&sent);
    assert_eq!(q.query, "needle");
    assert!(q.regex && q.whole_word && !q.case_sensitive);
    assert_eq!(
        q.include,
        Some(vec!["src/**/*.rs".into(), "docs/**".into()])
    );
    assert_eq!(q.exclude, Some(vec!["**/target/**".into()]));
}

#[test]
fn an_empty_query_sends_nothing_and_says_what_to_type() {
    let mut rig = rig();
    let sent = rig.key(Key::Enter);
    assert!(sent.is_empty());
    assert!(
        rig.text().contains("Type what to find first."),
        "{}",
        rig.text()
    );
}

#[test]
fn a_new_query_cancels_the_running_one_before_it_sends_its_own() {
    let mut rig = rig();
    search_for(&mut rig, "one", "s1");
    rig.key(Key::Tab);
    rig.key(Key::Tab);
    rig.key(Key::Tab);
    rig.key(Key::Char('/'));
    rig.typed("x");
    let sent = rig.key(Key::Enter);
    assert_eq!(names(&sent), ["search cancel", "search"]);
    match &sent[0].body {
        EffectBody::SearchCancel(c) => assert_eq!(c.id, "s1"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_page_for_a_search_the_panel_has_left_is_dropped() {
    let mut rig = rig();
    search_for(&mut rig, "one", "s1");
    rig.typed("x");
    let sent = rig.key(Key::Enter);
    let second = sent
        .iter()
        .find(|e| matches!(e.body, EffectBody::SearchQuery(_)))
        .expect("the second search")
        .clone();
    rig.accept(
        &second,
        CompletionPayload::SearchStarted(SearchStarted { id: "s2".into() }),
    );
    let old = page(
        &rig,
        "s1",
        vec![row("old.rs", 1, "stale one", 0, 5)],
        SearchState::More,
    );
    rig.host(old);
    assert!(!rig.text().contains("old.rs"), "{}", rig.text());
    let new = page(
        &rig,
        "s2",
        vec![row("new.rs", 1, "fresh onex", 0, 5)],
        SearchState::More,
    );
    rig.host(new);
    assert!(rig.text().contains("new.rs"), "{}", rig.text());
    assert!(!rig.text().contains("old.rs"));
}

#[test]
fn a_search_still_reading_is_labelled_partial_and_cancel_stops_it() {
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    let more = page(
        &rig,
        "s1",
        vec![row("a.rs", 1, "needle", 0, 6)],
        SearchState::More,
    );
    rig.host(more);
    let text = rig.text();
    assert!(text.contains("1 match in 1 file"), "{text}");
    assert!(text.contains("(partial)"), "{text}");
    assert!(text.contains("[Cancel]"), "{text}");
    assert_eq!(
        rig.panel().tab_label().map(|t| t.title),
        Some("Search \u{2026}".to_owned())
    );
    let sent = rig.click("[Cancel]");
    assert_eq!(names(&sent), ["search cancel"]);
    assert_eq!(
        status(&rig),
        "Cancelled. 1 match in 1 file read before it stopped (partial)."
    );
    // The owner delivers nothing for a cancelled id, and a late page is not shown.
    let late = page(
        &rig,
        "s1",
        vec![row("late.rs", 1, "needle", 0, 6)],
        SearchState::More,
    );
    rig.host(late);
    assert!(!rig.text().contains("late.rs"));
}

#[test]
fn a_finished_search_drops_the_partial_label_and_the_tab_counts_matches() {
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    let done = page(
        &rig,
        "s1",
        vec![
            row("a.rs", 1, "needle", 0, 6),
            row("a.rs", 9, "needle again", 0, 6),
        ],
        SearchState::Complete,
    );
    rig.host(done);
    let text = rig.text();
    assert!(text.contains("2 matches in 1 file."), "{text}");
    assert!(!text.contains("(partial)"), "{text}");
    assert_eq!(
        rig.panel().tab_label().map(|t| t.title),
        Some("Search (2)".to_owned())
    );
}

#[test]
fn an_empty_result_says_there_were_no_matches() {
    let mut rig = rig();
    search_for(&mut rig, "zzz", "s1");
    let done = page(&rig, "s1", vec![], SearchState::Complete);
    rig.host(done);
    assert!(
        rig.text().contains("No matches for \"zzz\"."),
        "{}",
        rig.text()
    );
}

#[test]
fn choosing_a_result_opens_the_file_at_its_line_and_utf16_column() {
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    let mut late = row("src/lib.rs", 3, "needle", 2, 8);
    // The host cut ten code units from the start of a long line.
    late.text_offset = Some(10);
    let done = page(&rig, "s1", vec![late], SearchState::Complete);
    rig.host(done);
    rig.key(Key::Down);
    rig.key(Key::Enter);
    let opened = rig.opened.borrow().clone();
    assert_eq!(opened.len(), 1, "{opened:?}");
    assert_eq!(opened[0]["path"], "src/lib.rs");
    assert_eq!(opened[0]["line"], 3);
    assert_eq!(opened[0]["column"], 13);
}

#[test]
fn clicking_a_result_with_the_pointer_opens_it_without_hover() {
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    let done = page(
        &rig,
        "s1",
        vec![row("src/lib.rs", 7, "let needle = 1;", 4, 10)],
        SearchState::Complete,
    );
    rig.host(done);
    rig.click("let needle");
    let opened = rig.opened.borrow().clone();
    assert_eq!(opened.len(), 1, "{opened:?}");
    assert_eq!(
        (opened[0]["line"].as_u64(), opened[0]["column"].as_u64()),
        (Some(7), Some(5))
    );
}

#[test]
fn clicking_the_search_chip_and_a_toggle_chip_work_like_the_keys() {
    let mut rig = rig();
    rig.typed("needle");
    rig.click("[.*]");
    let sent = rig.click("[Search]");
    assert_eq!(names(&sent), ["search"]);
    assert!(search_query(&sent).regex);
}

#[test]
fn a_refused_search_is_shown_as_the_owner_said_it_and_never_sent_again() {
    let mut rig = rig();
    rig.typed("needle");
    let sent = rig.key(Key::Enter);
    let start = sent[0].clone();
    rig.refuse(
        &start,
        "workspace_not_trusted",
        "This workspace is not trusted for search.",
    );
    assert_eq!(
        status(&rig),
        "Refused (workspace_not_trusted): This workspace is not trusted for search. Not retried."
    );
    assert!(
        rig.text().contains("Refused (workspace_not_trusted)"),
        "{}",
        rig.text()
    );
    assert!(rig.text().contains("Not retried."), "{}", rig.text());
    assert!(rig.ticks(5).is_empty());
    assert!(rig.key(Key::Down).is_empty());
}

#[test]
fn a_failed_start_and_an_uncertain_end_are_each_shown_in_the_owners_words() {
    let mut rig = rig();
    rig.typed("needle");
    let sent = rig.key(Key::Enter);
    rig.answer(
        &sent[0],
        Outcome::Failed {
            reason: "the index is rebuilding".into(),
        },
        None,
    );
    assert_eq!(status(&rig), "Failed: the index is rebuilding Not retried.");

    let mut rig = rig_for_end();
    let end = HostMessage::SearchPage {
        id: "s1".into(),
        rows: vec![row("a.rs", 1, "needle", 0, 6)],
        skipped: 0,
        state: SearchState::Ended,
        end: Some(SearchEnd {
            outcome: SearchEndOutcome::Uncertain,
            code: None,
            reason: "the connection dropped".into(),
        }),
        encoding: SpanEncoding::Utf16CodeUnits,
        read_at: ReadAt {
            workspace_id: WORKSPACE.into(),
            version: None,
            epoch: None,
            generation: rig.m.workspace().generation.0,
        },
    };
    rig.host(end);
    assert_eq!(
        status(&rig),
        "Unknown: the connection dropped Not retried. 1 match in 1 file read before it ended (partial)."
    );
    assert!(rig.ticks(3).is_empty());
}

fn rig_for_end() -> common::Rig {
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    rig
}

#[test]
fn a_match_over_a_tab_cjk_text_and_a_zwj_emoji_marks_exactly_the_cells_the_host_matched() {
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    let tab = row("a.txt", 1, "a\tneedle b", 2, 8);
    let cjk = row(
        "b.txt",
        2,
        "\u{65E5}\u{672C}\u{8A9E}\u{306E} needle \u{691C}\u{7D22}",
        5,
        11,
    );
    let zwj = row("c.txt", 3, &format!("{family} needle end"), 9, 15);
    // A range that starts inside the cluster marks the whole of it.
    let inside = row("d.txt", 4, &format!("x{family}y mid"), 3, 4);
    let done = page(
        &rig,
        "s1",
        vec![tab, cjk, zwj, inside],
        SearchState::Complete,
    );
    rig.host(done);
    let green = Color::Green;
    let theme = Theme::plain().with_search(Style::new().bg(green), Style::new().bg(Color::Blue));
    let buf = rig.cells(&theme, 80, 24);
    assert_eq!(marked(&buf, row_with(&buf, "needle b"), green), "needle");
    assert_eq!(
        marked(&buf, row_with(&buf, "\u{691C}\u{7D22}"), green),
        "needle"
    );
    assert_eq!(marked(&buf, row_with(&buf, "needle end"), green), "needle");
    assert_eq!(marked(&buf, row_with(&buf, "mid"), green), family);
}

/// The same match on a line of CJK text and a ZWJ emoji, counted in each unit the host may
/// state. The highlight and the opened column must land on the same characters in all three.
#[test]
fn a_match_after_cjk_and_a_zwj_emoji_is_placed_by_the_encoding_the_page_states() {
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    let before = format!("\u{65E5}\u{672C}\u{8A9E} {family} ");
    let line = format!("{before}needle end");
    let utf8 = before.len() as u32;
    let scalars = before.chars().count() as u32;
    let utf16 = before.encode_utf16().count() as u32;
    // The three counts differ, so a panel that assumed one would mark the wrong cells.
    assert!(utf8 > utf16 && utf16 > scalars);
    for (encoding, start) in [
        (SpanEncoding::Utf8Bytes, utf8),
        (SpanEncoding::Utf16CodeUnits, utf16),
        (SpanEncoding::UnicodeScalars, scalars),
    ] {
        let mut rig = rig();
        search_for(&mut rig, "needle", "s1");
        let done = page_in(
            &rig,
            "s1",
            vec![row("a.txt", 7, &line, start, start + 6)],
            SearchState::Complete,
            encoding,
        );
        rig.host(done);
        let green = Color::Green;
        let theme =
            Theme::plain().with_search(Style::new().bg(green), Style::new().bg(Color::Blue));
        let buf = rig.cells(&theme, 80, 24);
        assert_eq!(
            marked(&buf, row_with(&buf, "needle end"), green),
            "needle",
            "{encoding:?}"
        );
        // Opening it names the column in UTF-16 code units from 1, whatever the page counted.
        rig.key(Key::Down);
        rig.key(Key::Enter);
        assert_eq!(
            rig.opened.borrow().last(),
            Some(&json!({"workspace": WORKSPACE, "path": "a.txt", "line": 7, "column": utf16 + 1})),
            "{encoding:?}"
        );
    }
}

#[test]
fn a_match_that_starts_inside_a_character_marks_the_whole_character_in_every_encoding() {
    let line = "x\u{65E5}y";
    // The middle of the CJK character is byte 2 of 1..4, and it is one scalar and one unit.
    for (encoding, start, end) in [
        (SpanEncoding::Utf8Bytes, 2, 3),
        (SpanEncoding::Utf16CodeUnits, 1, 2),
        (SpanEncoding::UnicodeScalars, 1, 2),
    ] {
        let mut rig = rig();
        search_for(&mut rig, "q", "s1");
        let done = page_in(
            &rig,
            "s1",
            vec![row("a.txt", 1, line, start, end)],
            SearchState::Complete,
            encoding,
        );
        rig.host(done);
        let theme =
            Theme::plain().with_search(Style::new().bg(Color::Green), Style::new().bg(Color::Blue));
        let buf = rig.cells(&theme, 80, 24);
        assert_eq!(
            marked(&buf, row_with(&buf, "x\u{65E5}y"), Color::Green),
            "\u{65E5}",
            "{encoding:?}"
        );
    }
}

#[test]
fn a_tab_in_a_matched_line_advances_to_the_next_stop_of_four() {
    let mut rig = rig();
    search_for(&mut rig, "needle", "s1");
    let done = page(
        &rig,
        "s1",
        vec![row("a.txt", 1, "a\tneedle b", 2, 8)],
        SearchState::Complete,
    );
    rig.host(done);
    assert!(rig.text().contains("a   needle b"), "{}", rig.text());
}

#[test]
fn the_query_toggles_and_scroll_are_saved_and_restoring_them_starts_no_search() {
    let mut rig = rig();
    rig.typed("needle");
    rig.mods(Key::Char('c'), Mods::ALT);
    rig.key(Key::Tab);
    rig.key(Key::Tab);
    rig.typed("src/**");
    let saved = rig.panel().serialize();
    assert_eq!(saved["query"], "needle");
    assert_eq!(saved["caseSensitive"], true);
    assert_eq!(saved["include"], json!(["src/**"]));
    let restored = SearchPanel::restore(&saved);
    assert_eq!(theorem_workbench_core::Panel::serialize(&restored), saved);
    // A restored panel shows the saved query and sends nothing until the person asks.
    let (mut fresh, fx) = open_with("search", &CAPS, WORKSPACE, Some(saved));
    assert!(names(&fx).is_empty(), "restoring sends no search");
    assert!(fresh.ticks(4).is_empty());
    assert!(fresh.text().contains("needle"));
}

#[test]
fn the_semantic_tree_names_the_state_the_counts_and_every_action_with_a_reason() {
    let mut rig = rig();
    let root = rig.node("search");
    let run = root
        .actions
        .iter()
        .find(|a| a.id.as_str() == "search.run")
        .unwrap();
    assert!(!run.enabled);
    assert_eq!(run.reason.as_deref(), Some("Type what to find first."));
    let cancel = root
        .actions
        .iter()
        .find(|a| a.id.as_str() == "search.cancel")
        .unwrap();
    assert_eq!(cancel.reason.as_deref(), Some("No search is running."));

    search_for(&mut rig, "needle", "s1");
    let done = page(
        &rig,
        "s1",
        vec![
            row("a.rs", 1, "needle", 0, 6),
            row("a.rs", 2, "needle", 0, 6),
        ],
        SearchState::Complete,
    );
    rig.host(done);
    let root = rig.node("search");
    assert!(
        root.actions
            .iter()
            .find(|a| a.id.as_str() == "search.run")
            .unwrap()
            .enabled
    );
    assert!(
        root.state
            .description
            .as_deref()
            .unwrap()
            .contains("2 matches in 1 file")
    );
    let results = rig.node("results");
    assert_eq!(
        results.state.description.as_deref(),
        Some("2 matches in 1 file")
    );
    rig.key(Key::Down);
    let rows: Vec<_> = rig
        .nodes()
        .into_iter()
        .filter(|n| n.id.as_str().starts_with("result:"))
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows.iter().filter(|n| n.state.selected).count(), 1);
    assert!(rows[1].state.selected);
}

#[test]
fn the_sending_actions_are_registered_as_emitting_and_the_rest_are_local() {
    use theorem_workbench_core::effect::EffectKind;
    use theorem_workbench_core::ids::ActionId;
    let mut registry = theorem_workbench_core::builtin::registry();
    theorem_workbench_ide::extend_registry(&mut registry).unwrap();
    let emits = |id: &str| {
        registry
            .action(&ActionId::new(id))
            .unwrap_or_else(|| panic!("{id} is registered"))
            .1
            .emits
            .clone()
    };
    assert_eq!(emits("search.run"), [EffectKind::SearchQuery]);
    assert_eq!(emits("search.cancel"), [EffectKind::SearchCancel]);
    for id in [
        "search.toggle-regex",
        "search.open-result",
        "search.cursor-down",
    ] {
        assert!(emits(id).is_empty(), "{id}");
    }
}

#[test]
fn search_at_80_by_24_draws_the_form_the_status_and_the_grouped_results() {
    let mut rig = rig();
    rig.standard();
    search_for(&mut rig, "needle", "s1");
    let done = page(
        &rig,
        "s1",
        vec![
            row("src/lib.rs", 3, "a\tneedle b", 2, 8),
            row("src/lib.rs", 40, "let needle = 1;", 4, 10),
            row(
                "docs/readme.md",
                12,
                "\u{65E5}\u{672C}\u{8A9E}\u{306E} needle",
                5,
                11,
            ),
        ],
        SearchState::Complete,
    );
    rig.host(done);
    let screen = rig.screen();
    println!("{}", screen.join("\n"));
    assert_eq!(screen.len(), 24);
    assert!(screen[0].starts_with("Find"), "{screen:?}");
    assert!(screen[0].contains("needle") && screen[0].contains("[.*]"));
    assert!(screen[4].contains("3 matches in 2 files.") && screen[4].contains("[Search]"));
    assert!(screen[5].starts_with("src/lib.rs (2)"));
    assert!(screen.iter().any(|l| l.contains("a   needle b")));
}

#[test]
fn takes_chord_answers_for_the_three_toggles_in_every_field_and_leaves_other_option_letters_to_type()
 {
    let mut rig = rig();
    let option = |c: char| KeyInput::new(Key::Char(c), Mods::ALT);
    for focus in 0..4 {
        for c in ['r', 'c', 'w', 'R'] {
            assert!(rig.m.takes_chord(&option(c)), "{c} in field {focus}");
        }
        for c in ['q', 'e', 't', 'n', '1', '['] {
            assert!(!rig.m.takes_chord(&option(c)), "{c} in field {focus}");
        }
        rig.key(Key::Tab);
    }
}

// ---- the text and caret each field publishes ----------------------------------

fn caret_of(n: &theorem_workbench_core::semantics::Node) -> (u32, u32) {
    let s = n.selection.expect("a text box publishes its selection");
    (s.anchor, s.focus)
}

#[test]
fn every_field_publishes_its_text_and_caret_in_utf16_units_of_the_escaped_text() {
    let mut rig = rig();
    // 'a', an astral character (2 units), 'e' and a combining mark (2 units).
    rig.typed("a\u{1F600}e\u{301}");
    let q = rig.node("query");
    assert_eq!(q.text.as_deref(), Some("a\u{1F600}e\u{301}"));
    assert_eq!(caret_of(&q), (5, 5));
    rig.key(Key::Left);
    assert_eq!(
        caret_of(&rig.node("query")),
        (3, 3),
        "the caret steps a grapheme: a letter and its mark"
    );
    rig.key(Key::Home);
    assert_eq!(caret_of(&rig.node("query")), (0, 0));
    rig.key(Key::Right);
    assert_eq!(caret_of(&rig.node("query")), (1, 1));
    rig.key(Key::Right);
    assert_eq!(
        caret_of(&rig.node("query")),
        (3, 3),
        "past the astral character: two units"
    );
    // Every field has one, and the others keep their own caret.
    for id in ["replacement", "include", "exclude"] {
        let n = rig.node(id);
        assert_eq!(n.text.as_deref(), Some(""), "{id}");
        assert_eq!(caret_of(&n), (0, 0), "{id}");
    }
    rig.key(Key::Tab);
    rig.key(Key::Tab);
    rig.typed("src/\u{65e5}");
    let inc = rig.node("include");
    assert_eq!(inc.text.as_deref(), Some("src/\u{65e5}"));
    assert_eq!(caret_of(&inc), (5, 5));
    assert!(inc.state.focused && !rig.node("query").state.focused);
}

#[test]
fn a_hostile_query_is_spelled_out_and_the_caret_counts_into_what_is_shown() {
    let mut rig = rig();
    rig.typed("x\u{1b}y\u{202e}");
    let q = rig.node("query");
    assert_eq!(q.text.as_deref(), Some("x\\u{1b}y\\u{202e}"));
    // 1 + 6 + 1 + 8 units.
    assert_eq!(caret_of(&q), (16, 16));
    rig.key(Key::Left);
    assert_eq!(
        caret_of(&rig.node("query")),
        (8, 8),
        "before the override, after the y"
    );
    let tree = theorem_workbench_core::semantics::SemanticTree {
        root: rig.nodes()[0].id.clone(),
        nodes: rig.nodes(),
    };
    assert_eq!(tree.validate(), Ok(()));
}

// ---- selection in the one-line fields -------------------------------------------

#[test]
fn shift_left_then_typing_replaces_the_query_selection_and_select_all_replaces_it_all() {
    let mut rig = rig();
    rig.typed("needle");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    assert_eq!(
        caret_of(&rig.node("query")),
        (6, 4),
        "the published selection runs from the anchor to the moved end"
    );
    rig.typed("X");
    assert_eq!(rig.node("query").text.as_deref(), Some("needX"));
    rig.mods(Key::Char('a'), Mods::CTRL);
    assert_eq!(caret_of(&rig.node("query")), (0, 5));
    rig.typed("hay");
    assert_eq!(rig.node("query").text.as_deref(), Some("hay"));
    let sent = rig.key(Key::Enter);
    assert_eq!(search_query(&sent).query, "hay");
}

fn clipboard_write(fx: &[Effect]) -> (Effect, String) {
    let write = fx
        .iter()
        .find(|e| matches!(e.body, EffectBody::ClipboardWrite(_)))
        .unwrap_or_else(|| panic!("no clipboard write in {fx:?}"));
    let EffectBody::ClipboardWrite(w) = &write.body else {
        unreachable!()
    };
    (write.clone(), w.text.clone())
}

#[test]
fn copy_and_cut_in_a_search_field_go_through_the_clipboard_effect() {
    let mut rig = rig();
    rig.typed("needle");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    // Copy sends exactly the selection and changes nothing.
    let (write, text) = clipboard_write(&rig.mods(Key::Char('c'), Mods::CTRL));
    assert_eq!(text, "le");
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.node("query").text.as_deref(), Some("needle"));
    // Cut waits for the clipboard, then takes the selection out.
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    assert_eq!(rig.node("query").text.as_deref(), Some("needle"));
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.node("query").text.as_deref(), Some("need"));
}

#[test]
fn a_refused_cut_in_a_search_field_leaves_the_text_and_says_so() {
    let mut rig = rig();
    rig.typed("needle");
    rig.mods(Key::Char('a'), Mods::CTRL);
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    rig.refuse(&write, "denied", "no clipboard here");
    assert_eq!(rig.node("query").text.as_deref(), Some("needle"));
    assert!(rig.text().contains("no clipboard here"), "{}", rig.text());
}

#[test]
fn a_cut_leaves_a_field_that_changed_while_it_was_out_alone() {
    let mut rig = rig();
    rig.typed("needle");
    rig.mods(Key::Char('a'), Mods::CTRL);
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    rig.typed("Z");
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.node("query").text.as_deref(), Some("Z"));
}
