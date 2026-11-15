//! Content stays out of Debug (R42): an effect or a completion printed with
//! `{:?}` or `{:#?}` names its kind, its identities and its sizes, never the
//! text a person or a program wrote.

use serde_json::{Value, json};
use theorem_workbench_core::{Completion, Effect, HostMessage};

const KEY: &str = "sk-live-4eC39HqLyjWDarjtT1zdp7dc";
const SENTENCE: &str = "the quick brown fox signs the release at midnight";

fn fill(template: &Value) -> Value {
    let text = serde_json::to_string(template)
        .unwrap()
        .replace("@KEY@", KEY)
        .replace("@SENTENCE@", SENTENCE);
    serde_json::from_str(&text).unwrap()
}

fn revision(n: u64) -> Value {
    json!({"scheme": "seq", "value": n})
}

fn claim() -> Value {
    json!({"attachment": "a1", "leaseGeneration": 4, "epoch": 2})
}

fn effect_cases() -> Vec<(&'static str, Value)> {
    vec![
        (
            "documentEdit",
            json!({"operationId": "op1", "unit": "utf16", "edits": [{"start": 0, "end": 3, "insert": "@SENTENCE@"}, {"start": 3, "end": 3, "insert": "@KEY@"}]}),
        ),
        (
            "documentKeep",
            json!({"edits": [{"operationId": "op9", "baseRevision": {"scheme": "seq", "value": 3}, "edits": [{"start": 0, "end": 1, "insert": "@SENTENCE@"}]}, {"operationId": "op10", "baseRevision": {"scheme": "seq", "value": 3}, "edits": [{"start": 2, "end": 2, "insert": "@KEY@"}]}]}),
        ),
        (
            "documentCreate",
            json!({"path": "a.md", "seedText": "@SENTENCE@"}),
        ),
        ("documentOpen", json!({"seedText": "@KEY@"})),
        ("scmCommit", json!({"message": "@SENTENCE@"})),
        ("scmAmend", json!({"message": "@KEY@"})),
        (
            "scmResolve",
            json!({"path": "a.rs", "take": "merged", "text": "@SENTENCE@"}),
        ),
        ("filesSearch", json!({"query": "@KEY@"})),
        (
            "searchQuery",
            json!({"query": "@SENTENCE@", "regex": false, "caseSensitive": false, "wholeWord": false, "limit": 10}),
        ),
        (
            "terminalInput",
            json!({"bytes": "@KEY@", "kind": "human", "inputId": "load1:7", "claim": claim()}),
        ),
        (
            "terminalInputBytes",
            json!({"data": "@KEY@", "kind": "human", "inputId": "load1:8", "claim": claim()}),
        ),
        (
            "conversationSend",
            json!({"clientMessageId": "c1", "text": "@SENTENCE@", "references": [{"path": "a.rs", "excerpt": "@KEY@"}]}),
        ),
        (
            "conversationInput",
            json!({"runId": "r1", "clientMessageId": "c2", "text": "@SENTENCE@"}),
        ),
        (
            "conversationEdit",
            json!({"messageId": "m1", "clientMessageId": "c3", "text": "@SENTENCE@", "references": [{"path": "a.rs", "excerpt": "@KEY@"}]}),
        ),
        ("clipboardWrite", json!({"text": "@KEY@"})),
    ]
}

fn completion_cases() -> Vec<(&'static str, Value)> {
    let edit = json!({"start": 0, "end": 0, "insert": "@KEY@"});
    vec![
        (
            "document",
            json!({"type": "document", "text": "@SENTENCE@"}),
        ),
        (
            "documentOpened",
            json!({"type": "documentOpened", "text": "@SENTENCE@", "revision": revision(3), "dirty": false, "pending": [{"operationId": "o", "baseRevision": revision(2), "edits": [edit], "state": "inflight"}]}),
        ),
        (
            "documentConflicted",
            json!({"type": "documentConflicted", "operationId": "o", "baseRevision": revision(1), "current": {"revision": revision(2), "text": "@SENTENCE@"}, "pending": []}),
        ),
        (
            "documentReconciled",
            json!({"type": "documentReconciled", "revision": revision(4), "text": "@SENTENCE@"}),
        ),
        (
            "scmDiff",
            json!({"type": "scmDiff", "staged": false, "text": "@SENTENCE@", "hunks": [{"path": "a", "oldStart": 1, "oldCount": 1, "newStart": 1, "newCount": 1, "header": "@KEY@", "patch": "@SENTENCE@"}]}),
        ),
        (
            "scmShow",
            json!({"type": "scmShow", "path": "a", "reference": "HEAD", "exists": true, "text": "@SENTENCE@"}),
        ),
        (
            "scmLog",
            json!({"type": "scmLog", "commits": [{"commit": "abc123", "author": "A", "timestamp": "t", "subject": "@SENTENCE@", "body": "@KEY@"}]}),
        ),
        (
            "scmBlame",
            json!({"type": "scmBlame", "path": "a", "hunks": [{"author": "x", "commit": "c1", "startLine": 1, "lineCount": 2, "summary": "@SENTENCE@", "timestamp": "t"}]}),
        ),
        (
            "scmConflict",
            json!({"type": "scmConflict", "path": "a", "conflict": true, "binary": false, "base": "@KEY@", "ours": "@SENTENCE@", "theirs": "@SENTENCE@"}),
        ),
        ("clipboard", json!({"type": "clipboard", "text": "@KEY@"})),
        (
            "artifactContent",
            json!({"type": "artifactContent", "key": "k1", "text": "@SENTENCE@"}),
        ),
        (
            "languageHover",
            json!({"type": "languageHover", "contents": "@SENTENCE@"}),
        ),
        (
            "runState",
            json!({"type": "runState", "handle": "h1", "state": "done", "stdout": "@KEY@", "stderr": "@SENTENCE@", "readAt": {"workspaceId": "w", "generation": 1}}),
        ),
    ]
}

fn host_cases() -> Vec<Value> {
    let res = json!({"type": "terminal", "workspace": "w", "session": "s1"});
    vec![
        json!({"type": "documentResync", "resource": {"type": "document", "workspace": "w", "resourceId": "a.md"}, "revision": revision(5), "text": "@SENTENCE@"}),
        json!({"type": "terminalOutput", "resource": res, "epoch": 2, "offset": 10, "data": "@KEY@"}),
        json!({"type": "terminalReset", "resource": res, "epoch": 2, "offset": 10, "data": "@SENTENCE@"}),
    ]
}

fn no_marker(shown: &str, what: &str) {
    assert!(!shown.contains(KEY), "{what} printed the key: {shown}");
    assert!(
        !shown.contains(SENTENCE),
        "{what} printed the sentence: {shown}"
    );
    for word in ["quick", "midnight", "sk-live"] {
        assert!(!shown.contains(word), "{what} printed `{word}`: {shown}");
    }
}

fn effect_of(kind: &str, payload: &Value) -> Effect {
    serde_json::from_value(json!({
        "id": 4242,
        "resource": {"type": "document", "workspace": "ws-9", "resourceId": "doc-17.md"},
        "revision": revision(77),
        "generation": 31,
        "actor": {"type": "agent", "runId": "run-55"},
        "kind": kind,
        "payload": fill(payload),
    }))
    .unwrap_or_else(|e| panic!("{kind}: {e}"))
}

fn completion_of(payload: &Value) -> Completion {
    serde_json::from_value(json!({
        "effect": 4243,
        "resource": {"type": "document", "workspace": "ws-9", "resourceId": "doc-17.md"},
        "revision": revision(78),
        "generation": 32,
        "outcome": {"status": "accepted"},
        "payload": fill(payload),
    }))
    .unwrap_or_else(|e| panic!("{payload}: {e}"))
}

fn both_forms<T: std::fmt::Debug>(value: &T) -> [String; 2] {
    [format!("{value:?}"), format!("{value:#?}")]
}

#[test]
fn an_effect_with_content_prints_its_identities_and_sizes_but_never_the_content() {
    for (kind, payload) in effect_cases() {
        let effect = effect_of(kind, &payload);
        let list = vec![effect.clone(), effect.clone()];
        for (what, shown) in [
            ("effect", both_forms(&effect)),
            ("body", both_forms(&effect.body)),
            ("vec", both_forms(&list)),
        ] {
            for text in &shown {
                no_marker(text, &format!("{kind} {what}"));
                if what != "body" {
                    for identity in ["4242", "ws-9", "doc-17.md", "77", "31", "run-55"] {
                        assert!(
                            text.contains(identity),
                            "{kind} {what} lost {identity}: {text}"
                        );
                    }
                }
            }
        }
        // The size of what was held back is told, whichever of the two it was.
        let shown = format!("{effect:?}");
        assert!(
            shown.contains(&format!("<{} bytes withheld>", KEY.len()))
                || shown.contains(&format!("<{} bytes withheld>", SENTENCE.len())),
            "{kind}: {shown}"
        );
    }
}

#[test]
fn a_completion_with_content_prints_its_identities_and_sizes_but_never_the_content() {
    for (name, payload) in completion_cases() {
        let completion = completion_of(&payload);
        let list = vec![completion.clone()];
        for (what, shown) in [
            ("completion", both_forms(&completion)),
            ("payload", both_forms(&completion.payload)),
            ("vec", both_forms(&list)),
        ] {
            for text in &shown {
                no_marker(text, &format!("{name} {what}"));
                if what != "payload" {
                    for identity in ["4243", "ws-9", "doc-17.md", "78", "32"] {
                        assert!(
                            text.contains(identity),
                            "{name} {what} lost {identity}: {text}"
                        );
                    }
                }
            }
        }
        let shown = format!("{completion:?}");
        assert!(
            shown.contains(&format!("<{} bytes withheld>", KEY.len()))
                || shown.contains(&format!("<{} bytes withheld>", SENTENCE.len())),
            "{name}: {shown}"
        );
    }
}

#[test]
fn a_host_message_with_content_prints_its_identities_and_sizes_but_never_the_content() {
    for template in host_cases() {
        let message: HostMessage =
            serde_json::from_value(fill(&template)).unwrap_or_else(|e| panic!("{template}: {e}"));
        for shown in both_forms(&message)
            .iter()
            .chain(both_forms(&vec![message.clone()]).iter())
        {
            no_marker(shown, &template["type"].to_string());
            assert!(shown.contains("withheld"), "{shown}");
        }
    }
}

#[test]
fn serialization_still_carries_the_content_and_content_free_types_print_as_before() {
    // The wire is untouched: the content is in the JSON.
    for (kind, payload) in effect_cases() {
        let wire = serde_json::to_string(&effect_of(kind, &payload)).unwrap();
        assert!(wire.contains(KEY) || wire.contains(SENTENCE), "{kind}");
    }
    // A completion with no content keeps its ordinary Debug.
    let c = completion_of(&json!({"type": "documentSaved", "revision": revision(9)}));
    let shown = format!("{c:?}");
    assert!(
        shown.contains("DocumentSaved") && shown.contains("Seq(9)"),
        "{shown}"
    );
}
