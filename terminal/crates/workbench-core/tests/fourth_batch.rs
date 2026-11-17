//! Wire shapes of the fourth batch: side chat scope and list, conflict sides
//! and resolve, read-only documents and syntax tokens.

use serde_json::json;
use theorem_workbench_core::completion::CompletionPayload;
use theorem_workbench_core::effect::EffectBody;
use theorem_workbench_core::host::HostMessage;

fn payload(value: serde_json::Value) -> CompletionPayload {
    let parsed: CompletionPayload = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    parsed
}

fn body(value: serde_json::Value) -> EffectBody {
    let parsed: EffectBody = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    parsed
}

#[test]
fn a_side_chat_scope_is_optional_and_the_list_is_a_unit_effect() {
    body(json!({"kind": "conversationSideChat", "payload": {}}));
    body(json!({"kind": "conversationSideChat", "payload": {"scope": "forked"}}));
    body(json!({"kind": "conversationSideList"}));
    let CompletionPayload::ConversationSideList(list) = payload(json!({
        "type": "conversationSideList",
        "chats": [
            {"conversationId": "c1", "scope": "fresh"},
            {"conversationId": "c2", "scope": "forked", "from": "c1", "threadId": "t"}
        ]
    })) else {
        panic!("not a side list");
    };
    assert_eq!(list.chats.len(), 2);
}

#[test]
fn conflicts_and_their_resolution_use_the_same_side_objects() {
    body(json!({"kind": "scmConflict", "payload": {"path": "a.rs"}}));
    body(json!({"kind": "scmResolve", "payload": {"path": "a.rs", "take": "merged", "text": "x"}}));
    body(json!({"kind": "scmResolve", "payload": {"path": "a.rs", "take": "ours"}}));
    let sides = json!({"path": "a.rs", "conflict": true, "ours": "o", "theirs": "t"});
    payload(
        json!({"type": "scmConflict", "path": "a.rs", "conflict": true, "ours": "o", "theirs": "t"}),
    );
    let CompletionPayload::ScmMerged(merged) = payload(json!({
        "type": "scmMerged", "merged": false, "conflicts": [sides]
    })) else {
        panic!("not a merge answer");
    };
    assert_eq!(merged.conflicts[0].path, "a.rs");
    assert!(merged.conflicts[0].base.is_none());
}

#[test]
fn syntax_tokens_name_their_revision_and_encoding() {
    let message: HostMessage = serde_json::from_value(json!({
        "type": "documentTokens",
        "resource": {"type": "document", "workspace": "w", "resourceId": "a.md"},
        "revision": {"scheme": "seq", "value": 3},
        "encoding": "utf8_bytes",
        "spans": [{"start": 0, "end": 3, "class": "keyword"}]
    }))
    .unwrap();
    assert!(matches!(message, HostMessage::DocumentTokens { .. }));
}
