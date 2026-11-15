//! Events that arrive without a prior effect. Closed set, fields from the
//! `WorkspaceLive` and `TerminalChannel` inventory.

use serde::{Deserialize, Serialize};

use crate::draft::{DraftAttachment, ModelChoice};
use crate::effect::{CoordinateUnit, TerminalBackend, TextChange};
use crate::ids::{ResourceRef, Revision};
use crate::registry::Capabilities;
use crate::results::{ReadAt, SearchEnd, SearchRow, SearchState, SpanEncoding};

fn yes() -> bool {
    true
}

/// A profile a process may be started from (`TheoremTerminalProfile`). The
/// backend is the profile's own and is never swapped for another: a Herdr
/// profile the host reports not ready stays unavailable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfileInfo {
    pub id: String,
    pub label: String,
    pub backend: TerminalBackend,
    /// Absent: the host machine's shell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub argv: Option<Vec<String>>,
    /// False when the host reports the backend not ready
    /// (`backends.herdr.ready`).
    #[serde(default = "yes")]
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub unavailable_reason: Option<String>,
}

/// A stretch of a document and the highlight class of its token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TokenSpan {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub start: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub end: u64,
    /// The class string the TypeScript tokenizer emits.
    pub class: String,
}

/// What the host says about a session's program, never read from its output.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TerminalSessionState {
    #[default]
    Running,
    Exited,
    Lost,
}

/// A terminal session of the workspace a pane may attach to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session: String,
    /// The profile it was started from, as people name it.
    pub profile: String,
    pub backend: TerminalBackend,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub host: Option<String>,
    /// The program's incarnation: 1 is the original, plus one per replacement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub program: Option<u64>,
    #[serde(default)]
    pub state: TerminalSessionState,
    /// Another viewer holds the control lease.
    #[serde(default)]
    pub controlled_elsewhere: bool,
}

/// The live stream's state (`WorkspaceLive`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connecting,
    Open,
    Reconnecting,
    Resyncing,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[non_exhaustive]
pub enum HostMessage {
    /// `document.changed`: a remote edit, in the stated unit. `operation_id`
    /// matches one of our own edits when this is its acknowledgement.
    DocumentChanged {
        resource: ResourceRef,
        revision: Revision,
        actor: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        operation_id: Option<String>,
        unit: CoordinateUnit,
        edits: Vec<TextChange>,
    },
    /// The caller's own edit was accepted, seen on the live stream before or
    /// instead of its answer. `revision` is the document's after the edit.
    DocumentAcknowledged {
        resource: ResourceRef,
        revision: Revision,
        operation_id: String,
    },
    /// A gap in the events, a reconnect or a revert: replace what is shown
    /// with this full text at `revision`.
    DocumentResync {
        resource: ResourceRef,
        revision: Revision,
        text: String,
    },
    DocumentConflict {
        resource: ResourceRef,
        revision: Revision,
        disk_deleted: bool,
    },
    DocumentSaved {
        resource: ResourceRef,
        revision: Revision,
    },
    DocumentMoved {
        from: ResourceRef,
        to: ResourceRef,
    },
    DocumentRetired {
        resource: ResourceRef,
    },
    /// `file.changed`. A path of `.` means events were lost: re-read.
    FileChanged {
        workspace: String,
        path: String,
    },
    /// A terminal's output frame, base64, at an absolute byte offset of the
    /// stated binding epoch. `resource` names the terminal session. The root
    /// routes it only to a panel bound to that session; a frame for an older
    /// binding epoch is dropped and counted, and the rest reach the pane as
    /// `PanelMsg::TerminalOutput` through the bounded PTY queue.
    TerminalOutput {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        offset: u64,
        data: String,
    },
    /// Discard the screen and replay `data` (base64 of the UTF-8 escape-coded
    /// repaint of the visible grid). The repaint already includes every byte
    /// before `offset`: the next `terminalOutput` of this epoch starts at
    /// `offset`. The pane calls `Screen::reset_with_formatted(bytes, offset)`.
    TerminalReset {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        offset: u64,
        data: String,
    },
    /// `terminal.resized`: another client changed the size. The host's event
    /// names no epoch, so none is required.
    TerminalResized {
        resource: ResourceRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
        epoch: Option<u64>,
        cols: u16,
        rows: u16,
    },
    /// `terminal.opened`: a rebind or adoption. A new epoch strands old offsets.
    TerminalOpened {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        program: u64,
        backend: TerminalBackend,
        /// `adopted`, `replacement` or the host's other origin words.
        origin: String,
        cols: u16,
        rows: u16,
    },
    TerminalExited {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        exit_code: Option<i32>,
        /// `exited`, `killed`, `lost` or the core's word.
        reason: String,
    },
    /// `terminal.control`: the lease changed holder.
    TerminalControl {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        generation: u64,
        controlled: bool,
    },
    /// React's latest snapshot of a conversation, as the existing terminal
    /// takes it. The core does not interpret `snapshot`. `revision` is the
    /// snapshot's own and goes up across switches, so `judge` drops an older one;
    /// `conversation_id` must be the `thread` of `resource`, and a snapshot
    /// where they differ is dropped.
    ConversationSnapshot {
        resource: ResourceRef,
        revision: Revision,
        conversation_id: String,
        snapshot: String,
    },
    /// The whole draft attachment list of a conversation, as the host holds it
    /// now. Sent after every change (a pick, a remove, a paste or a drop), so a
    /// panel never merges: the latest list replaces its own.
    /// `conversation_id` must be the `thread` of `resource`.
    ConversationAttachments {
        resource: ResourceRef,
        conversation_id: String,
        attachments: Vec<DraftAttachment>,
    },
    /// The models a conversation can run on, and which one and which effort
    /// the next turn will use. `efforts` lists the levels the selected model
    /// accepts, empty when it has none. `conversation_id` must be the
    /// `thread` of `resource`.
    ConversationModels {
        resource: ResourceRef,
        conversation_id: String,
        models: Vec<ModelChoice>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        selected: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        effort: Option<String>,
        #[serde(default)]
        efforts: Vec<String>,
    },
    /// The role contract changed. The palette itself arrives through
    /// `set_palette`; this only says to repaint.
    ThemeChanged {
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        revision: u64,
        dark: bool,
    },
    CapabilitiesChanged {
        capabilities: Capabilities,
    },
    /// The workspace (and the environment serving it) the workbench is about.
    /// The root holds it, tells every panel with `PanelMsg::Workspace`, and
    /// bumps the generation workspace-bound panels bind with. A message that
    /// repeats the current identity changes nothing.
    WorkspaceChanged {
        workspace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        environment: Option<String>,
    },
    ConnectionChanged {
        workspace: String,
        state: ConnectionState,
    },
    /// What the chooser offers: the profiles a process may be started from and
    /// the terminal sessions of the workspace, as the host last said. Each
    /// message replaces both lists.
    TerminalSessions {
        workspace: String,
        profiles: Vec<TerminalProfileInfo>,
        sessions: Vec<TerminalSessionInfo>,
    },
    /// Syntax colour for a document: where each token is, and the highlight
    /// class the tokenizer gave it, at `revision`. Offsets count in `encoding`
    /// from the start of the document's text at that revision.
    ///
    /// Routed to the panels bound to `resource`. A message for a revision older
    /// than the panel's accepted one is dropped and counted stale (the gate
    /// every revisioned host message passes), because its offsets describe text
    /// the panel no longer has; one for a newer revision is delivered, and the
    /// panel decides whether to hold it until its text catches up.
    DocumentTokens {
        resource: ResourceRef,
        revision: Revision,
        encoding: SpanEncoding,
        spans: Vec<TokenSpan>,
    },
    /// One page of a search's results, after the `searchStarted` completion
    /// that named `id`. The root delivers it to the panel that started the
    /// search and to no other; once the state is not `more` it forgets the id.
    SearchPage {
        id: String,
        rows: Vec<SearchRow>,
        /// Rows of a kind the owner does not read (the host's non-text rows).
        skipped: u32,
        state: SearchState,
        /// Why the search ended early; only with state `ended`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        end: Option<SearchEnd>,
        /// The host and generation the rows were read from.
        read_at: ReadAt,
    },
    /// The live stream says everything listeners know may be stale
    /// (`onResync`): `malformed_cursor`, `epoch_changed`, `cursor_ahead`,
    /// `cursor_expired`.
    Resync {
        workspace: String,
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft::DraftAttachmentState;
    use serde_json::json;

    #[test]
    fn host_message_round_trips() {
        let message = HostMessage::TerminalOutput {
            resource: ResourceRef::Terminal {
                workspace: "w".into(),
                session: "pty-1".into(),
            },
            epoch: 2,
            offset: 40,
            data: "aGk=".into(),
        };
        let value = serde_json::to_value(&message).unwrap();
        assert_eq!(value["type"], "terminalOutput");
        assert_eq!(value["offset"], json!(40));
        assert_eq!(
            serde_json::from_value::<HostMessage>(value).unwrap(),
            message
        );
    }

    fn term() -> ResourceRef {
        ResourceRef::Terminal {
            workspace: "w".into(),
            session: "pty-1".into(),
        }
    }

    fn doc() -> ResourceRef {
        ResourceRef::Document {
            workspace: "w".into(),
            resource_id: "a.md".into(),
        }
    }

    fn round(message: HostMessage, expected: serde_json::Value) {
        let value = serde_json::to_value(&message).unwrap();
        assert_eq!(value, expected);
        assert_eq!(
            serde_json::from_value::<HostMessage>(value).unwrap(),
            message
        );
    }

    #[test]
    fn terminal_reset_and_resize_round_trip() {
        round(
            HostMessage::TerminalReset {
                resource: term(),
                epoch: 2,
                offset: 900,
                data: "G1sySg==".into(),
            },
            json!({
                "type": "terminalReset",
                "resource": {"type": "terminal", "workspace": "w", "session": "pty-1"},
                "epoch": 2, "offset": 900, "data": "G1sySg=="
            }),
        );
        round(
            HostMessage::TerminalResized {
                resource: term(),
                epoch: None,
                cols: 100,
                rows: 30,
            },
            json!({
                "type": "terminalResized",
                "resource": {"type": "terminal", "workspace": "w", "session": "pty-1"},
                "cols": 100, "rows": 30
            }),
        );
    }

    #[test]
    fn document_acknowledged_and_resync_round_trip() {
        round(
            HostMessage::DocumentAcknowledged {
                resource: doc(),
                revision: Revision::Seq(8),
                operation_id: "op-1".into(),
            },
            json!({
                "type": "documentAcknowledged",
                "resource": {"type": "document", "workspace": "w", "resourceId": "a.md"},
                "revision": {"scheme": "seq", "value": 8}, "operationId": "op-1"
            }),
        );
        round(
            HostMessage::DocumentResync {
                resource: doc(),
                revision: Revision::Seq(9),
                text: "full".into(),
            },
            json!({
                "type": "documentResync",
                "resource": {"type": "document", "workspace": "w", "resourceId": "a.md"},
                "revision": {"scheme": "seq", "value": 9}, "text": "full"
            }),
        );
    }

    #[test]
    fn a_conversation_snapshot_names_its_revision_and_conversation() {
        round(
            HostMessage::ConversationSnapshot {
                resource: ResourceRef::Conversation {
                    project: "p".into(),
                    thread: "t1".into(),
                },
                revision: Revision::Seq(4),
                conversation_id: "t1".into(),
                snapshot: "{}".into(),
            },
            json!({
                "type": "conversationSnapshot",
                "resource": {"type": "conversation", "project": "p", "thread": "t1"},
                "revision": {"scheme": "seq", "value": 4},
                "conversationId": "t1", "snapshot": "{}"
            }),
        );
    }

    fn conv() -> ResourceRef {
        ResourceRef::Conversation {
            project: "p".into(),
            thread: "t1".into(),
        }
    }

    #[test]
    fn draft_attachments_and_models_round_trip() {
        round(
            HostMessage::ConversationAttachments {
                resource: conv(),
                conversation_id: "t1".into(),
                attachments: vec![
                    DraftAttachment {
                        id: "a1".into(),
                        name: "x.png".into(),
                        content_type: Some("image/png".into()),
                        size: Some(10),
                        state: DraftAttachmentState::Ready,
                        reason: None,
                    },
                    DraftAttachment {
                        id: "a2".into(),
                        name: "big.bin".into(),
                        content_type: None,
                        size: None,
                        state: DraftAttachmentState::Refused,
                        reason: Some("too large".into()),
                    },
                ],
            },
            json!({
                "type": "conversationAttachments",
                "resource": {"type": "conversation", "project": "p", "thread": "t1"},
                "conversationId": "t1",
                "attachments": [
                    {"id": "a1", "name": "x.png", "contentType": "image/png", "size": 10, "state": "ready"},
                    {"id": "a2", "name": "big.bin", "state": "refused", "reason": "too large"}
                ]
            }),
        );
        round(
            HostMessage::ConversationModels {
                resource: conv(),
                conversation_id: "t1".into(),
                models: vec![ModelChoice {
                    model_ref: "m/one".into(),
                    label: "One".into(),
                    context_tokens: Some(200_000),
                }],
                selected: Some("m/one".into()),
                effort: Some("high".into()),
                efforts: vec!["low".into(), "high".into()],
            },
            json!({
                "type": "conversationModels",
                "resource": {"type": "conversation", "project": "p", "thread": "t1"},
                "conversationId": "t1",
                "models": [{"ref": "m/one", "label": "One", "contextTokens": 200000}],
                "selected": "m/one", "effort": "high", "efforts": ["low", "high"]
            }),
        );
        // Optionals and the effort list may be absent on input.
        let bare: HostMessage = serde_json::from_value(json!({
            "type": "conversationModels",
            "resource": {"type": "conversation", "project": "p", "thread": "t1"},
            "conversationId": "t1", "models": []
        }))
        .unwrap();
        assert!(matches!(
            bare,
            HostMessage::ConversationModels { selected: None, effort: None, ref efforts, .. }
                if efforts.is_empty()
        ));
    }
}
