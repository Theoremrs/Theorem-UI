//! Wire shapes of the language, run and search results, as their TypeScript
//! ports answer with them.

use serde_json::json;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{CompletionPayload, LogEntry};
use theorem_workbench_core::effect::SearchQuery;
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::PanelKind;
use theorem_workbench_core::registry::{Availability, Capabilities};
use theorem_workbench_core::results::{
    CompletionRange, LocationRow, SearchState, Span, SpanEncoding,
};

fn payload(value: serde_json::Value) -> CompletionPayload {
    let parsed: CompletionPayload = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    parsed
}

#[test]
fn a_hover_carries_markdown_and_the_place_as_a_range_or_a_span() {
    let CompletionPayload::LanguageHover(hover) = payload(json!({
        "type": "languageHover", "contents": "**x**",
        "range": {"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 5}},
        "span": {"start": 10, "end": 13, "encoding": "utf8_bytes"}
    })) else {
        panic!("not a hover");
    };
    assert_eq!(hover.span.unwrap().encoding, SpanEncoding::Utf8Bytes);
    let CompletionPayload::LanguageHover(bare) =
        payload(json!({"type": "languageHover", "contents": ""}))
    else {
        panic!("not a hover");
    };
    assert!(bare.range.is_none() && bare.span.is_none());
}

#[test]
fn span_encodings_are_spelled_as_the_host_sends_them() {
    for (encoding, word) in [
        (SpanEncoding::Utf8Bytes, "utf8_bytes"),
        (SpanEncoding::Utf16CodeUnits, "utf16_code_units"),
        (SpanEncoding::UnicodeScalars, "unicode_scalars"),
    ] {
        let span = Span {
            start: 1,
            end: 2,
            encoding,
        };
        assert_eq!(
            serde_json::to_value(span).unwrap(),
            json!({"start": 1, "end": 2, "encoding": word})
        );
    }
}

#[test]
fn completions_take_one_range_or_an_inserting_and_replacing_pair() {
    let range = json!({"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3}});
    let CompletionPayload::LanguageCompletions(done) = payload(json!({
        "type": "languageCompletions",
        "items": [
            {"label": "a"},
            {"label": "b", "kind": 3, "detail": "d", "documentation": "doc",
             "insertText": "b()", "itemId": "i-1", "range": range},
            {"label": "c", "range": {"inserting": range, "replacing": range}}
        ]
    })) else {
        panic!("not completions");
    };
    assert!(matches!(done.items[1].range, Some(CompletionRange::One(_))));
    assert!(matches!(
        done.items[2].range,
        Some(CompletionRange::Split { .. })
    ));
}

#[test]
fn locations_answer_navigation_and_references_for_documents_and_uris() {
    let CompletionPayload::LanguageLocations(found) = payload(json!({
        "type": "languageLocations",
        "locations": [
            {"resourceId": "a.rs", "span": {"start": 0, "end": 4, "encoding": "unicode_scalars"},
             "revision": 7},
            {"uri": "file:///lib.rs",
             "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 1}}}
        ]
    })) else {
        panic!("not locations");
    };
    let LocationRow { revision, uri, .. } = found.locations[0].clone();
    assert_eq!(revision, Some(7));
    assert!(uri.is_none());
}

#[test]
fn diagnostics_keep_the_stamps_the_owner_gave_and_none_it_did_not() {
    let CompletionPayload::LanguageDiagnostics(snapshot) = payload(json!({
        "type": "languageDiagnostics", "revision": 4, "sessionEpoch": 2,
        "contentHash": "h", "full": true,
        "findings": [
            {"id": "f1", "start": 3, "end": 9, "severity": "warning", "message": "m",
             "provider": "p", "fixHandle": "fx"},
            {"id": "f2", "start": 0, "end": 1, "severity": "hint", "message": "n"}
        ]
    })) else {
        panic!("not diagnostics");
    };
    assert_eq!(snapshot.findings.len(), 2);
    let CompletionPayload::LanguageDiagnostics(bare) = payload(json!({
        "type": "languageDiagnostics", "full": false, "findings": []
    })) else {
        panic!("not diagnostics");
    };
    assert!(bare.revision.is_none() && bare.content_hash.is_none());
}

#[test]
fn a_run_state_carries_everything_written_so_far_and_where_it_was_read() {
    let CompletionPayload::RunState(state) = payload(json!({
        "type": "runState", "handle": "h", "state": "exited", "exitCode": 2,
        "stdout": "out", "stderr": "err",
        "readAt": {"workspaceId": "w", "version": "1", "epoch": "e", "generation": 3}
    })) else {
        panic!("not a run state");
    };
    assert_eq!(state.exit_code, Some(2));
    let CompletionPayload::RunState(running) = payload(json!({
        "type": "runState", "handle": "h", "state": "running", "stdout": "", "stderr": "",
        "readAt": {"workspaceId": "w", "generation": 1}
    })) else {
        panic!("not a run state");
    };
    assert!(running.exit_code.is_none() && running.read_at.version.is_none());
}

#[test]
fn a_search_page_reads_as_a_host_message_with_its_state_and_end() {
    let message: HostMessage = serde_json::from_value(json!({
        "type": "searchPage", "id": "s1", "skipped": 2, "state": "ended",
        "rows": [{"path": "a.rs", "line": 4, "text": "let x",
                  "matches": [{"start": 4, "end": 5}], "textOffset": 8}],
        "end": {"outcome": "failed", "code": "boom", "reason": "the host failed"},
        "readAt": {"workspaceId": "w", "generation": 1}
    }))
    .unwrap();
    let HostMessage::SearchPage {
        rows, state, end, ..
    } = &message
    else {
        panic!("not a page");
    };
    assert_eq!(*state, SearchState::Ended);
    assert_eq!(rows[0].text_offset, Some(8));
    assert_eq!(end.as_ref().unwrap().code.as_deref(), Some("boom"));
    assert_eq!(serde_json::to_value(&message).unwrap()["state"], "ended");
}

#[test]
fn a_search_asks_with_lists_of_globs_and_the_host_gets_arrays() {
    let query = SearchQuery {
        query: "x".into(),
        regex: false,
        case_sensitive: false,
        whole_word: false,
        include: Some(vec!["*.rs".into(), "src/**".into()]),
        exclude: None,
        limit: 100,
    };
    assert_eq!(
        serde_json::to_value(&query).unwrap(),
        json!({"query": "x", "regex": false, "caseSensitive": false, "wholeWord": false,
               "include": ["*.rs", "src/**"], "limit": 100})
    );
    // The old comma-separated string is not a list and is refused.
    assert!(
        serde_json::from_value::<SearchQuery>(json!({
            "query": "x", "regex": false, "caseSensitive": false, "wholeWord": false,
            "include": "*.rs,*.ts", "limit": 1
        }))
        .is_err()
    );
}

#[test]
fn a_log_entry_has_a_body_only_when_the_host_sent_one() {
    let with: LogEntry = serde_json::from_value(json!({
        "commit": "c", "author": "a", "timestamp": "1", "subject": "s", "body": "more"
    }))
    .unwrap();
    assert_eq!(with.body.as_deref(), Some("more"));
    let without: LogEntry = serde_json::from_value(json!({
        "commit": "c", "author": "a", "timestamp": "1", "subject": "s"
    }))
    .unwrap();
    assert!(without.body.is_none());
    assert!(
        serde_json::to_value(&without)
            .unwrap()
            .get("body")
            .is_none()
    );
}

#[test]
fn the_panels_these_results_belong_to_say_which_operation_they_wait_for() {
    let registry = builtin::registry();
    let caps = Capabilities::of(["run.start"]);
    let why = |kind: &str| match registry.panel_availability(&PanelKind::new(kind), &caps) {
        Some(Availability::Unavailable { reason }) => reason,
        other => panic!("{kind} should be unavailable, got {other:?}"),
    };
    assert!(why("diagnostics").contains("diagnostics.subscribe"));
    assert!(why("search").contains("search.query"));
    // Run output needs both, and names the one still missing.
    assert!(why("run-output").contains("run.subscribe"));
    let all = Capabilities::of(["run.start", "run.subscribe"]);
    assert_eq!(
        registry.panel_availability(&PanelKind::new("run-output"), &all),
        Some(Availability::Available)
    );
}
