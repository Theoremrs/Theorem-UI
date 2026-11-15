//! Events that arrive without a prior effect. Closed set, fields from the
//! `WorkspaceLive` and `TerminalChannel` inventory.

use serde::{Deserialize, Serialize};

use crate::effect::{CoordinateUnit, TerminalBackend, TextChange};
use crate::ids::{ResourceRef, Revision};
use crate::registry::Capabilities;

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
}
