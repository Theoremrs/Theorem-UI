//! The Diagnostics panel driven through a real root, fed the way the core feeds it.

mod common;

use common::{WORKSPACE, names, open, open_with};
use keybinds::Key;
use serde_json::json;
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ActionId, Actor, Revision};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::results::{FindingAt, Position, Range, Severity, SpanEncoding};
use theorem_workbench_core::{Msg, Panel};
use theorem_workbench_ide::DiagnosticsPanel;

const CAPS: [&str; 3] = ["files", "documents", "diagnostics.subscribe"];

fn at(
    line: u32,
    character: u32,
    severity: Severity,
    message: &str,
    source: &str,
    code: Option<&str>,
) -> FindingAt {
    FindingAt {
        range: Range {
            start: Position { line, character },
            end: Position {
                line,
                character: character + 1,
            },
        },
        severity,
        message: message.into(),
        source: Some(source.into()),
        code: code.map(Into::into),
    }
}

fn set(path: &str, revision: u64, findings: Vec<FindingAt>) -> HostMessage {
    HostMessage::DiagnosticsSet {
        path: path.into(),
        revision: Revision::Seq(revision),
        encoding: SpanEncoding::Utf16CodeUnits,
        findings,
    }
}

fn a_findings() -> Vec<FindingAt> {
    vec![
        at(
            1,
            12,
            Severity::Error,
            "Cannot find name 'y'.",
            "tsc",
            Some("TS2304"),
        ),
        at(
            2,
            0,
            Severity::Warning,
            "Unused closing brace.",
            "eslint",
            None,
        ),
    ]
}

fn b_findings() -> Vec<FindingAt> {
    vec![
        at(
            1,
            1,
            Severity::Info,
            "Consider using const.",
            "eslint",
            None,
        ),
        at(
            8,
            4,
            Severity::Hint,
            "Rename to snake_case.",
            "clippy",
            None,
        ),
    ]
}

fn settled() -> common::Rig {
    let (mut rig, fx) = open("diagnostics", &CAPS, WORKSPACE);
    assert!(fx.is_empty(), "opening sends nothing: {fx:?}");
    rig.host(set("a.rs", 3, a_findings()));
    rig.host(set("b.rs", 5, b_findings()));
    rig
}

fn status(rig: &common::Rig) -> String {
    rig.node("status").name
}

#[test]
fn findings_arrive_by_the_feed_grouped_by_file_with_severity_message_source_and_place() {
    let rig = settled();
    assert_eq!(
        rig.panel().tab_label().map(|t| t.title),
        Some("Diagnostics (4)".into())
    );
    let screen = rig.screen();
    let text = screen.join("\n");
    assert!(
        screen[0].contains("All 4") && screen[0].contains("Errors 1"),
        "{text}"
    );
    assert!(text.contains("a.rs (2) r3"), "{text}");
    assert!(text.contains("b.rs (2) r5"), "{text}");
    assert!(text.contains("error") && text.contains("2:13"), "{text}");
    assert!(
        text.contains("Cannot find name 'y'.  [tsc TS2304]"),
        "{text}"
    );
    assert!(text.contains("hint") && text.contains("9:5"), "{text}");
    assert!(!text.contains('@'), "no byte offsets are shown: {text}");
}

#[test]
fn the_panel_says_it_covers_open_documents_only_and_names_the_three_empty_cases() {
    let (mut rig, fx) = open("diagnostics", &CAPS, WORKSPACE);
    assert!(fx.is_empty());
    // No documents open.
    let none = status(&rig);
    assert!(
        none.starts_with("No documents are open in the workbench."),
        "{none}"
    );
    assert!(none.contains("does not scan the workspace"), "{none}");
    // Documents open, no findings.
    rig.host(set("a.rs", 1, vec![]));
    let clean = status(&rig);
    assert!(
        clean.starts_with("No findings in 1 open document."),
        "{clean}"
    );
    assert!(clean.contains("workspace is not scanned"), "{clean}");
    assert!(rig.screen().join("\n").contains("a.rs (0) r1 no findings"));
    // Findings.
    rig.host(set("a.rs", 2, a_findings()));
    assert!(status(&rig).starts_with("2 findings in 1 open document."));
    // The host cannot report findings at all.
    rig.host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["files", "documents"]),
    });
    let cannot = status(&rig);
    assert!(
        cannot.starts_with("The host cannot report findings"),
        "{cannot}"
    );
    assert!(cannot.contains("not because there are none"), "{cannot}");
    assert_eq!(
        rig.node("status").role,
        theorem_workbench_core::semantics::Role::Alert
    );
}

#[test]
fn a_newer_set_replaces_a_file_and_an_older_revision_is_dropped_by_the_core() {
    let mut rig = settled();
    rig.host(set(
        "a.rs",
        4,
        vec![at(0, 0, Severity::Error, "Now only this.", "tsc", None)],
    ));
    let text = rig.screen().join("\n");
    assert!(
        text.contains("Now only this.") && !text.contains("Unused closing brace."),
        "{text}"
    );
    assert!(text.contains("a.rs (1) r4"), "{text}");
    // An older set does not bring the old findings back.
    rig.host(set("a.rs", 3, a_findings()));
    let text = rig.screen().join("\n");
    assert!(
        text.contains("a.rs (1) r4") && !text.contains("Unused closing brace."),
        "{text}"
    );
}

#[test]
fn closing_a_document_clears_its_findings_and_the_last_one_says_no_documents_are_open() {
    let mut rig = settled();
    rig.host(HostMessage::DiagnosticsCleared {
        path: "a.rs".into(),
    });
    assert!(status(&rig).starts_with("2 findings in 1 open document."));
    assert!(!rig.screen().join("\n").contains("a.rs ("));
    rig.host(HostMessage::DiagnosticsCleared {
        path: "b.rs".into(),
    });
    assert!(status(&rig).starts_with("No documents are open"));
    assert!(rig.panel().tab_label().is_none());
}

#[test]
fn a_panel_that_mounts_late_is_handed_the_sets_the_core_kept() {
    let mut rig = settled();
    rig.close();
    rig.host(set(
        "c.rs",
        1,
        vec![at(3, 2, Severity::Warning, "Late.", "x", None)],
    ));
    rig.send(Msg::Action {
        id: ActionId::new("diagnostics.open"),
        actor: Actor::Human,
    });
    rig.id = rig
        .m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "diagnostics")
        .map(|(id, _)| id.clone())
        .expect("a diagnostics panel");
    rig.tick();
    let text = rig.screen().join("\n");
    assert!(
        text.contains("a.rs (2) r3") && text.contains("c.rs (1) r1"),
        "{text}"
    );
    assert!(
        status(&rig).starts_with("5 findings in 3 open documents."),
        "{}",
        status(&rig)
    );
}

#[test]
fn the_panel_asks_for_the_feed_and_sends_no_request_of_its_own() {
    assert!(DiagnosticsPanel::restore(&json!({})).wants_diagnostics());
    let mut rig = settled();
    assert!(rig.ticks(40).is_empty(), "nothing is read on a timer");
    rig.key(Key::Down);
    assert!(rig.key(Key::Char('f')).is_empty());
}

#[test]
fn choosing_a_finding_opens_the_editor_at_its_line_and_column_from_1() {
    let mut rig = settled();
    // The first selected finding is a.rs line 2 (index 1), character 12.
    let fx = rig.key(Key::Enter);
    assert!(fx.is_empty());
    assert_eq!(
        rig.opened.borrow().last(),
        Some(&json!({"workspace": WORKSPACE, "path": "a.rs", "line": 2, "column": 13}))
    );
    assert_eq!(
        rig.reveals.borrow().last(),
        Some(&(2, 13)),
        "the editor is told the place"
    );
}

#[test]
fn a_second_finding_in_an_open_file_moves_the_open_editor_instead_of_opening_another() {
    let mut rig = settled();
    rig.key(Key::Enter);
    // The editor took focus; come back to the panel for the next choice.
    let id = rig.id.clone();
    rig.send(Msg::Dock(theorem_workbench_core::msg::DockMsg::FocusPanel(
        id,
    )));
    rig.key(Key::Down);
    rig.key(Key::Enter);
    assert_eq!(rig.opened.borrow().len(), 1, "one editor for the file");
    assert_eq!(rig.reveals.borrow().last(), Some(&(3, 1)));
}

#[test]
fn clicking_a_finding_opens_it_and_clicking_a_file_opens_the_file() {
    let mut rig = settled();
    rig.click("Rename to snake_case.");
    assert_eq!(
        rig.opened.borrow().last(),
        Some(&json!({"workspace": WORKSPACE, "path": "b.rs", "line": 9, "column": 5}))
    );
}

#[test]
fn counts_filter_by_key_and_by_chip_and_an_empty_filter_hides_the_file() {
    let mut rig = settled();
    assert!(rig.screen()[0].contains("Errors 1") && rig.screen()[0].contains("Hints 1"));
    rig.ch('1');
    let text = rig.screen().join("\n");
    assert!(
        text.contains("Cannot find name")
            && !text.contains("Unused closing")
            && !text.contains("b.rs"),
        "{text}"
    );
    rig.ch('4');
    let text = rig.screen().join("\n");
    assert!(
        text.contains("Rename to snake_case.") && !text.contains("a.rs"),
        "{text}"
    );
    rig.ch('0');
    rig.click("Warnings");
    assert!(rig.screen().join("\n").contains("Unused closing brace."));
    assert!(rig.node("filter:2").state.selected);
    rig.ch('f');
    assert!(rig.node("filter:3").state.selected);
}

#[test]
fn the_tab_counts_findings_and_the_semantic_tree_names_the_selected_row_and_each_action() {
    let mut rig = settled();
    let root = rig.node("diagnostics");
    assert!(
        root.state
            .description
            .as_deref()
            .unwrap()
            .contains("4 findings in 2 open documents")
    );
    for id in [
        "diagnostics.filter-all",
        "diagnostics.filter-error",
        "diagnostics.open-finding",
        "diagnostics.cursor-down",
    ] {
        assert!(root.actions.iter().any(|a| a.id.as_str() == id), "{id}");
    }
    assert!(
        !root
            .actions
            .iter()
            .any(|a| a.id.as_str() == "diagnostics.refresh"),
        "there is nothing to refresh: the feed is pushed"
    );
    let rows: Vec<_> = rig
        .nodes()
        .into_iter()
        .filter(|n| n.id.as_str().starts_with("finding:"))
        .collect();
    assert_eq!(rows.len(), 6, "two headers and four findings");
    let selected: Vec<_> = rows.iter().filter(|n| n.state.selected).collect();
    assert_eq!(selected.len(), 1);
    assert!(
        selected[0].name.contains(
            "error in a.rs at line 2 column 13: Cannot find name 'y'. from tsc code TS2304"
        ),
        "{}",
        selected[0].name
    );
    rig.key(Key::Down);
    let moved: Vec<_> = rig
        .nodes()
        .into_iter()
        .filter(|n| n.state.selected && n.id.as_str().starts_with("finding:"))
        .collect();
    assert!(moved[0].name.contains("warning"), "{}", moved[0].name);
    assert!(rig.node("filter:0").state.selected);
}

#[test]
fn the_filter_and_scroll_are_saved_and_a_restored_panel_waits_for_the_feed_and_sends_nothing() {
    let mut rig = settled();
    rig.ch('2');
    let saved = rig.panel().serialize();
    assert_eq!(saved["filter"], "warning");
    assert!(
        saved.get("files").is_none(),
        "the findings are the feed's, not the panel's"
    );
    assert_eq!(
        DiagnosticsPanel::restore(&saved).serialize()["filter"],
        "warning"
    );
    let (mut fresh, fx) = open_with("diagnostics", &CAPS, WORKSPACE, Some(saved));
    assert!(names(&fx).is_empty());
    assert!(fresh.ticks(4).is_empty());
    fresh.host(set("a.rs", 3, a_findings()));
    let text = fresh.screen().join("\n");
    assert!(
        text.contains("Unused closing brace.") && !text.contains("Cannot find name"),
        "{text}"
    );
}

#[test]
fn moving_to_another_workspace_drops_the_findings_of_the_first() {
    let mut rig = settled();
    rig.host(HostMessage::WorkspaceChanged {
        workspace: "other".into(),
        environment: None,
    });
    assert!(
        status(&rig).starts_with("No documents are open"),
        "{}",
        status(&rig)
    );
}

#[test]
fn diagnostics_at_80_by_24_draws_the_counts_the_status_and_the_findings_by_file() {
    let mut rig = settled();
    rig.standard();
    let screen = rig.screen();
    println!("{}", screen.join("\n"));
    assert_eq!(screen.len(), 24);
    assert!(screen[0].contains("Errors 1"), "{screen:?}");
    assert!(
        screen[1].contains("4 findings in 2 open documents."),
        "{screen:?}"
    );
    let a = screen
        .iter()
        .position(|l| l.starts_with("a.rs (2) r3"))
        .expect("a.rs header");
    assert!(
        screen[a + 1].contains("error") && screen[a + 1].contains("2:13"),
        "{screen:?}"
    );
}
