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
    /// stated binding epoch.
    TerminalOutput {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        offset: u64,
        data: String,
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
    /// takes it. The core does not interpret it.
    ConversationSnapshot {
        resource: ResourceRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        revision: Option<Revision>,
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
}
