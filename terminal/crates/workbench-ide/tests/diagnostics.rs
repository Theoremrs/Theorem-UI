//! The Diagnostics panel driven through a real root.

mod common;

use common::{WORKSPACE, names, open_with};
use keybinds::Key;
use serde_json::json;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{EffectId, ResourceRef, Revision};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::results::{Finding, LanguageDiagnostics, Severity};
use theorem_workbench_core::{Msg, Panel};
use theorem_workbench_ide::DiagnosticsPanel;

const CAPS: [&str; 3] = ["files", "documents", "diagnostics.subscribe"];

const MAIN: &str = "fn main() {\n    let x = y;\n}\n";

fn doc(path: &str) -> ResourceRef {
    ResourceRef::Document {
        workspace: WORKSPACE.into(),
        resource_id: path.into(),
    }
}

fn finding(id: &str, severity: Severity, start: u64, message: &str, provider: &str) -> Finding {
    Finding {
        id: id.into(),
        start,
        end: start + 1,
        severity,
        message: message.into(),
        provider: Some(provider.into()),
        fix_handle: None,
    }
}

fn snapshot(revision: u64, full: bool, findings: Vec<Finding>) -> CompletionPayload {
    CompletionPayload::LanguageDiagnostics(LanguageDiagnostics {
        revision: Some(revision),
        session_epoch: None,
        content_hash: None,
        full,
        findings,
    })
}

fn a_findings() -> Vec<Finding> {
    vec![
        finding("a1", Severity::Error, 24, "Cannot find name 'y'.", "tsc"),
        finding(
            "a2",
            Severity::Warning,
            27,
            "Unused closing brace.",
            "eslint",
        ),
    ]
}

fn b_findings() -> Vec<Finding> {
    vec![
        finding("b1", Severity::Info, 2, "Consider using const.", "eslint"),
        finding("b2", Severity::Hint, 9, "Rename to snake_case.", "clippy"),
    ]
}

/// A panel restored with two documents it knows the revisions of: a.rs at 3, b.rs at 5.
fn restored() -> (common::Rig, Vec<Effect>) {
    open_with(
        "diagnostics",
        &CAPS,
        WORKSPACE,
        Some(json!({
            "files": [
                {"path": "a.rs", "revision": 3},
                {"path": "b.rs", "revision": 5}
            ]
        })),
    )
}

fn read_of(effect: &Effect) -> (&ResourceRef, Option<&Revision>) {
    assert!(
        matches!(effect.body, EffectBody::LanguageDiagnostics),
        "{:?}",
        effect.body
    );
    (&effect.resource, effect.revision.as_ref())
}

/// Restores, answers a.rs at 3 and b.rs at 5, and returns the settled rig.
fn settled() -> common::Rig {
    let (mut rig, fx) = restored();
    let first = fx[0].clone();
    let fx = rig.accept(&first, snapshot(3, true, a_findings()));
    let second = fx[0].clone();
    rig.accept(&second, snapshot(5, true, b_findings()));
    rig
}

#[test]
fn a_restored_panel_reads_one_document_at_a_time_at_the_revision_it_knows() {
    let (mut rig, fx) = restored();
    assert_eq!(names(&fx), ["diagnostics"]);
    assert_eq!(read_of(&fx[0]), (&doc("a.rs"), Some(&Revision::Seq(3))));
    // Nothing more is sent while the first read is out.
    assert!(rig.ticks(3).is_empty());
    let fx = rig.accept(&fx[0], snapshot(3, true, a_findings()));
    assert_eq!(names(&fx), ["diagnostics"]);
    assert_eq!(read_of(&fx[0]), (&doc("b.rs"), Some(&Revision::Seq(5))));
}

#[test]
fn findings_are_grouped_by_file_with_severity_message_source_and_position() {
    let rig = settled();
    let text = rig.text();
    assert!(text.contains("4 findings in 2 files."), "{text}");
    let at = |needle: &str| {
        text.lines()
            .position(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("{needle}\n{text}"))
    };
    assert!(at("a.rs (2) r3") < at("Cannot find name 'y'."));
    assert!(at("Cannot find name 'y'.") < at("Unused closing brace."));
    assert!(at("Unused closing brace.") < at("b.rs (2) r5"));
    assert!(text.contains("error"), "{text}");
    assert!(text.contains("[tsc]") && text.contains("[eslint]") && text.contains("[clippy]"));
    // Without the document text only the byte offset is known, and the row says so.
    assert!(text.contains("@24"), "{text}");
    assert!(rig.node("status").name.contains("without a line"));
}

#[test]
fn the_header_counts_each_severity_and_the_filter_narrows_the_list_by_key_and_by_chip() {
    let mut rig = settled();
    let top = rig.screen()[0].clone();
    assert!(
        top.contains("All 4") && top.contains("Errors 1") && top.contains("Warnings 1"),
        "{top}"
    );
    assert!(top.contains("Info 1") && top.contains("Hints 1"), "{top}");

    rig.ch('1');
    let text = rig.text();
    assert!(text.contains("Cannot find name 'y'."), "{text}");
    assert!(
        !text.contains("Unused closing brace.") && !text.contains("b.rs"),
        "{text}"
    );

    rig.click("Hints 1");
    let text = rig.text();
    assert!(
        text.contains("Rename to snake_case.") && !text.contains("Cannot find"),
        "{text}"
    );

    rig.ch('0');
    assert!(rig.text().contains("Cannot find name 'y'."));
}

#[test]
fn choosing_a_finding_opens_the_file_at_its_line_and_column_once_the_text_is_known() {
    let mut rig = settled();
    rig.host(HostMessage::DocumentResync {
        resource: doc("a.rs"),
        revision: Revision::Seq(3),
        text: MAIN.into(),
    });
    let text = rig.text();
    assert!(text.contains("2:13"), "{text}");
    assert!(text.contains("3:1"), "{text}");
    rig.key(Key::Enter);
    let opened = rig.opened.borrow().clone();
    assert_eq!(opened.len(), 1, "{opened:?}");
    assert_eq!(opened[0]["path"], "a.rs");
    assert_eq!(
        (opened[0]["line"].as_u64(), opened[0]["column"].as_u64()),
        (Some(2), Some(13))
    );
}

#[test]
fn choosing_a_finding_without_the_text_opens_the_file_and_says_it_has_no_position() {
    let mut rig = settled();
    rig.key(Key::Enter);
    let opened = rig.opened.borrow().clone();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0]["path"], "a.rs");
    assert!(opened[0].get("line").is_none(), "{opened:?}");
    assert!(
        rig.node("status").name.contains("without a position"),
        "{}",
        rig.node("status").name
    );
}

#[test]
fn clicking_a_finding_opens_it_with_no_hover_needed() {
    let mut rig = settled();
    rig.host(HostMessage::DocumentResync {
        resource: doc("a.rs"),
        revision: Revision::Seq(3),
        text: MAIN.into(),
    });
    rig.click("Unused closing brace.");
    let opened = rig.opened.borrow().clone();
    assert_eq!(opened.len(), 1, "{opened:?}");
    assert_eq!(
        (opened[0]["line"].as_u64(), opened[0]["column"].as_u64()),
        (Some(3), Some(1))
    );
}

#[test]
fn a_changed_document_is_read_again_and_its_findings_are_replaced_not_added_to() {
    let mut rig = settled();
    let fx = rig.host(HostMessage::DocumentChanged {
        resource: doc("a.rs"),
        revision: Revision::Seq(4),
        actor: "me".into(),
        operation_id: None,
        unit: theorem_workbench_core::effect::CoordinateUnit::Utf16,
        edits: vec![],
    });
    let fx = if fx.is_empty() { rig.tick() } else { fx };
    assert_eq!(names(&fx), ["diagnostics"], "{fx:?}");
    assert_eq!(read_of(&fx[0]), (&doc("a.rs"), Some(&Revision::Seq(4))));
    rig.accept(
        &fx[0],
        snapshot(
            4,
            true,
            vec![finding("a9", Severity::Error, 0, "New problem.", "tsc")],
        ),
    );
    let text = rig.text();
    assert!(
        text.contains("New problem.") && !text.contains("Cannot find name"),
        "{text}"
    );
    assert!(text.contains("a.rs (1) r4"), "{text}");
}

#[test]
fn a_set_for_an_older_revision_than_the_one_shown_is_dropped() {
    let mut rig = settled();
    // An answer for b.rs that arrives while the panel is bound elsewhere is only cached by
    // the root, and the panel still refuses it when its revision is older than the one shown.
    let older = Completion::new(EffectId(900), doc("b.rs"), Outcome::Accepted)
        .with_revision(Revision::Seq(4))
        .with_payload(snapshot(
            4,
            true,
            vec![finding("old", Severity::Error, 0, "From the past.", "tsc")],
        ));
    rig.send(Msg::Completion(older));
    let text = rig.text();
    assert!(!text.contains("From the past."), "{text}");
    assert!(text.contains("b.rs (2) r5"), "{text}");
}

#[test]
fn a_refused_read_is_shown_in_the_owners_words_and_is_not_sent_again() {
    let (mut rig, fx) = restored();
    let fx = rig.refuse(
        &fx[0],
        "stale_revision",
        "The document moved to revision 4.",
    );
    // The refusal does not stop the next document being read.
    assert_eq!(names(&fx), ["diagnostics"]);
    assert_eq!(read_of(&fx[0]).0, &doc("b.rs"));
    assert!(
        rig.node("status").name.contains(
            "a.rs: Refused (stale_revision): The document moved to revision 4. Not retried."
        ),
        "{}",
        rig.node("status").name
    );
    assert!(
        rig.text().contains("Refused (stale_revision)"),
        "{}",
        rig.text()
    );
    rig.refuse(
        &fx[0],
        "unsupported_language",
        "No language service for this file.",
    );
    assert!(rig.ticks(5).is_empty());
    let header = rig.text();
    assert!(
        header.contains("b.rs (0) Refused (unsupported_language)"),
        "{header}"
    );
}

#[test]
fn without_the_language_capability_the_panel_says_the_service_is_unavailable_and_nothing_is_read() {
    let (mut rig, _) = restored();
    rig.host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["files", "documents"]),
    });
    let said = rig.node("status").name;
    assert!(
        said.contains("The language service is unavailable"),
        "{said}"
    );
    assert!(said.contains("not because there are none"), "{said}");
    assert!(
        rig.text().contains("language service is unavailable"),
        "{}",
        rig.text()
    );
    let root = rig.node("diagnostics");
    let refresh = root
        .actions
        .iter()
        .find(|a| a.id.as_str() == "diagnostics.refresh")
        .unwrap();
    assert!(!refresh.enabled);
    assert!(refresh.reason.as_deref().unwrap().contains("unavailable"));
}

#[test]
fn a_panel_with_no_documents_says_why_it_has_no_findings() {
    let (rig, fx) = open_with("diagnostics", &CAPS, WORKSPACE, None);
    assert!(fx.is_empty());
    assert!(
        rig.node("status")
            .name
            .contains("nothing has told this panel which documents")
    );
}

#[test]
fn the_tab_counts_findings_and_the_semantic_tree_names_the_selected_row_and_each_action() {
    let mut rig = settled();
    assert_eq!(
        rig.panel().tab_label().map(|t| t.title),
        Some("Diagnostics (4)".to_owned())
    );
    let root = rig.node("diagnostics");
    assert!(
        root.state
            .description
            .as_deref()
            .unwrap()
            .contains("4 findings in 2 files")
    );
    for id in [
        "diagnostics.refresh",
        "diagnostics.filter-all",
        "diagnostics.filter-error",
        "diagnostics.open-finding",
        "diagnostics.cursor-down",
    ] {
        assert!(root.actions.iter().any(|a| a.id.as_str() == id), "{id}");
    }
    let rows: Vec<_> = rig
        .nodes()
        .into_iter()
        .filter(|n| n.id.as_str().starts_with("finding:"))
        .collect();
    assert_eq!(rows.len(), 6, "two headers and four findings");
    let selected: Vec<_> = rows.iter().filter(|n| n.state.selected).collect();
    assert_eq!(selected.len(), 1);
    assert!(
        selected[0]
            .name
            .contains("error in a.rs at byte 24: Cannot find name 'y'. from tsc"),
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
    let chip = rig.node("filter:0");
    assert!(chip.state.selected);
}

#[test]
fn the_filter_and_scroll_are_saved_and_a_restored_panel_reads_only_what_it_was_showing() {
    let mut rig = settled();
    rig.ch('2');
    let saved = rig.panel().serialize();
    assert_eq!(saved["filter"], "warning");
    assert_eq!(saved["files"][0]["path"], "a.rs");
    assert_eq!(saved["files"][1]["revision"], 5);
    let again = DiagnosticsPanel::restore(&saved).serialize();
    assert_eq!(again["filter"], "warning");
    let (mut fresh, fx) = open_with("diagnostics", &CAPS, WORKSPACE, Some(saved));
    // Only the first document is read, as for any restored panel.
    assert_eq!(names(&fx), ["diagnostics"]);
    assert!(fresh.ticks(2).is_empty());
}

#[test]
fn diagnostics_at_80_by_24_draws_the_counts_the_status_and_the_findings_by_file() {
    let (mut rig, fx) = {
        let (mut r, fx) = restored();
        r.standard();
        (r, fx)
    };
    let fx = rig.accept(&fx[0], snapshot(3, true, a_findings()));
    rig.accept(&fx[0], snapshot(5, true, b_findings()));
    rig.host(HostMessage::DocumentResync {
        resource: doc("a.rs"),
        revision: Revision::Seq(3),
        text: MAIN.into(),
    });
    let screen = rig.screen();
    println!("{}", screen.join("\n"));
    assert_eq!(screen.len(), 24);
    assert!(screen[0].contains("Errors 1"), "{screen:?}");
    assert!(screen[1].contains("4 findings in 2 files."), "{screen:?}");
    assert!(screen[3].starts_with("a.rs (2) r3"), "{screen:?}");
    assert!(
        screen[4].contains("error") && screen[4].contains("2:13"),
        "{screen:?}"
    );
}
