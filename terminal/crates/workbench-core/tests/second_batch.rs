//! Wire shapes and targets added in the second core batch.

use serde_json::json;
use theorem_workbench_core::effect::{
    EffectBody, EffectKind, InputKind, Owner, TerminalAbandonOpen, TerminalBackend, TerminalClaim,
    TerminalInputBytes, TerminalOpen,
};
use theorem_workbench_core::host::{
    HostMessage, TerminalProfileInfo, TerminalSessionInfo, TerminalSessionState,
};
use theorem_workbench_core::ids::{EffectId, ResourceKind, ResourceRef};
use theorem_workbench_core::panel::OpenTarget;

fn round_trip<T>(value: &T, expected: serde_json::Value)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    assert_eq!(serde_json::to_value(value).unwrap(), expected);
    assert_eq!(&serde_json::from_value::<T>(expected).unwrap(), value);
}

#[test]
fn an_open_carries_the_attachment_it_was_given_and_older_ones_still_read() {
    let open = TerminalOpen {
        backend: TerminalBackend::Native,
        argv: None,
        name: None,
        cols: 80,
        rows: 24,
        attachment: Some("pane-1".into()),
        operation: None,
    };
    round_trip(
        &open,
        json!({"backend": "native", "cols": 80, "rows": 24, "attachment": "pane-1"}),
    );
    let old: TerminalOpen =
        serde_json::from_value(json!({"backend": "native", "cols": 80, "rows": 24})).unwrap();
    assert_eq!(old.attachment, None);
}

#[test]
fn input_bytes_and_abandoning_an_open_belong_to_the_terminal_owner() {
    let bytes = EffectBody::TerminalInputBytes(TerminalInputBytes {
        data: "gP8=".into(),
        kind: InputKind::Human,
        input_id: "i-1".into(),
        claim: TerminalClaim {
            attachment: "pane-1".into(),
            lease_generation: 2,
            epoch: 1,
        },
    });
    assert_eq!(EffectKind::from(&bytes), EffectKind::TerminalInputBytes);
    assert_eq!(EffectKind::from(&bytes).owner(), Owner::Terminal);
    let value = serde_json::to_value(&bytes).unwrap();
    assert_eq!(value["kind"], "terminalInputBytes");
    assert_eq!(value["payload"]["data"], "gP8=");
    assert_eq!(serde_json::from_value::<EffectBody>(value).unwrap(), bytes);

    let abandon = EffectBody::TerminalAbandonOpen(TerminalAbandonOpen { open: EffectId(7) });
    assert_eq!(EffectKind::from(&abandon), EffectKind::TerminalAbandonOpen);
    assert_eq!(EffectKind::from(&abandon).owner(), Owner::Terminal);
    let value = serde_json::to_value(&abandon).unwrap();
    assert_eq!(value["kind"], "terminalAbandonOpen");
    assert_eq!(value["payload"]["open"], 7);
    assert_eq!(
        serde_json::from_value::<EffectBody>(value).unwrap(),
        abandon
    );
}

#[test]
fn the_session_list_message_round_trips_and_defaults_what_the_host_leaves_out() {
    let message = HostMessage::TerminalSessions {
        workspace: "w".into(),
        profiles: vec![TerminalProfileInfo {
            id: "native".into(),
            label: "Shell".into(),
            backend: TerminalBackend::Native,
            argv: None,
            available: true,
            unavailable_reason: None,
        }],
        sessions: vec![TerminalSessionInfo {
            session: "s-1".into(),
            profile: "Shell".into(),
            backend: TerminalBackend::Native,
            workspace: "w".into(),
            host: None,
            program: Some(2),
            state: TerminalSessionState::Exited,
            reason: None,
            next_step: None,
            controlled_elsewhere: true,
            modes: None,
            program_report: Default::default(),
        }],
        adoption: None,
    };
    let value = serde_json::to_value(&message).unwrap();
    assert_eq!(value["type"], "terminalSessions");
    assert_eq!(value["sessions"][0]["state"], "exited");
    assert_eq!(value["sessions"][0]["controlledElsewhere"], true);
    assert_eq!(
        serde_json::from_value::<HostMessage>(value).unwrap(),
        message
    );

    let sparse: HostMessage = serde_json::from_value(json!({
        "type": "terminalSessions", "workspace": "w",
        "profiles": [{"id": "p", "label": "P", "backend": "herdr"}],
        "sessions": [{"session": "s", "profile": "P", "backend": "herdr", "workspace": "w"}]
    }))
    .unwrap();
    let HostMessage::TerminalSessions {
        profiles, sessions, ..
    } = sparse
    else {
        panic!("not the session list");
    };
    assert!(profiles[0].available);
    assert_eq!(sessions[0].state, TerminalSessionState::Running);
    assert!(!sessions[0].controlled_elsewhere);
}

#[test]
fn directories_commits_revisions_and_new_pages_are_resources_of_their_own() {
    let cases = [
        (
            ResourceRef::Directory {
                workspace: "w".into(),
                path: "src".into(),
            },
            ResourceKind::Directory,
            json!({"type": "directory", "workspace": "w", "path": "src"}),
        ),
        (
            ResourceRef::Commit {
                workspace: "w".into(),
                repository: "r".into(),
                commit: "abc".into(),
            },
            ResourceKind::Commit,
            json!({"type": "commit", "workspace": "w", "repository": "r", "commit": "abc"}),
        ),
        (
            ResourceRef::Revision {
                workspace: "w".into(),
                repository: "r".into(),
                commit: "abc".into(),
                path: "a.rs".into(),
            },
            ResourceKind::Revision,
            json!({"type": "revision", "workspace": "w", "repository": "r",
                   "commit": "abc", "path": "a.rs"}),
        ),
        (
            ResourceRef::Untitled {
                workspace: "w".into(),
                id: "u-1".into(),
            },
            ResourceKind::Untitled,
            json!({"type": "untitled", "workspace": "w", "id": "u-1"}),
        ),
    ];
    for (resource, kind, wire) in cases {
        assert_eq!(resource.kind(), kind);
        round_trip(&resource, wire);
    }
}

#[test]
fn opening_at_a_line_is_the_same_document_and_the_other_targets_are_distinct() {
    let file = OpenTarget::File {
        workspace: "w".into(),
        path: "a.rs".into(),
    };
    let at = OpenTarget::FileAt {
        workspace: "w".into(),
        path: "a.rs".into(),
        line: 12,
        column: 3,
    };
    assert_eq!(file.resource(), at.resource());
    assert!(at.describe().contains("12:3"));

    let commit = OpenTarget::Commit {
        workspace: "w".into(),
        repository: "r".into(),
        commit: "0123456789".into(),
    };
    let revision = OpenTarget::Revision {
        workspace: "w".into(),
        repository: "r".into(),
        commit: "0123456789".into(),
        path: "src/a.rs".into(),
    };
    let first = OpenTarget::Untitled {
        workspace: "w".into(),
        id: "u-1".into(),
    };
    let second = OpenTarget::Untitled {
        workspace: "w".into(),
        id: "u-2".into(),
    };
    assert!(matches!(commit.resource(), ResourceRef::Commit { .. }));
    assert!(matches!(revision.resource(), ResourceRef::Revision { .. }));
    assert_ne!(first.resource(), second.resource());
    assert_eq!(commit.title(), "0123456");
    assert_eq!(revision.title(), "a.rs @ 0123456");
    assert_eq!(first.title(), "Untitled");
}
