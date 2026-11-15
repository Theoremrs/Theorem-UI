//! Events that arrive without a prior effect. Closed set, fields from the
//! `WorkspaceLive` and `TerminalChannel` inventory.

use serde::{Deserialize, Serialize};

use crate::draft::{DraftAttachment, ModelChoice};
use crate::effect::{CoordinateUnit, TerminalBackend, TextChange};
use crate::ids::{ResourceRef, Revision};
use crate::registry::Capabilities;
use crate::results::{FindingAt, ReadAt, SearchEnd, SearchRow, SearchState, SpanEncoding};

fn utf16() -> SpanEncoding {
    SpanEncoding::Utf16CodeUnits
}

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

/// How far a document's edits are from being safe (spec 11, R40).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LocalStatus {
    /// The owner has them.
    Accepted,
    /// Held in this page only.
    Draft,
    /// Written to the local checkpoint at `saved_at_ms` (milliseconds since
    /// the epoch); `recovered` is true when this page found it after a reload.
    Checkpointed {
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        saved_at_ms: u64,
        recovered: bool,
    },
}

/// A failed or unknown local write, or no local store, in a person's words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalProblem {
    pub code: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    #[serde(flatten)]
    pub status: LocalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub problem: Option<LocalProblem>,
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
    /// The terminal modes the host reports for the session. Absent when the
    /// host does not report them (an older host); a panel then keeps its own
    /// reading of the stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub modes: Option<TerminalModes>,
    /// What the program says about itself. `unavailable` when the host sends
    /// nothing, so an older host reads as before.
    #[serde(default, skip_serializing_if = "ProgramReport::is_unavailable")]
    #[cfg_attr(feature = "ts", ts(as = "Option<ProgramReport>", optional))]
    pub program_report: ProgramReport,
}

/// The words the host maps a program's own status report to. `Unknown`
/// carries the program's own word in [`ProgramStatus::raw_state`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ProgramState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
    Unknown,
}

/// What a program says about itself (R32). The text is the program's, kept as
/// text: nothing here is read as an action, and its `Debug` prints the state
/// and the sizes of the text, never the text.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProgramStatus {
    pub state: ProgramState,
    /// The program's own word, only with `state: unknown`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub raw_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub msg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub title: Option<String>,
    /// 0-255, as sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub progress: Option<u8>,
}

/// What the host says a terminal's program reported. Four cases, never a
/// boolean; none is task, approval, lifecycle or availability state, and none
/// is derived from output or liveness. The report is the program's word, not
/// the workbench's: it changes what a pane shows and nothing else.
///
/// - `unavailable`: the host says nothing (an older host, a native terminal,
///   or a report it could not read).
/// - `never_reported`: the program has never reported.
/// - `cleared`: it reported before and has no current word. `status_ms` and
///   `seq` are the core's, when sent.
/// - `current`: its current word.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProgramReport {
    #[default]
    Unavailable,
    NeverReported,
    Cleared {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
        status_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
        seq: Option<u64>,
    },
    Current {
        status: ProgramStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
        status_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
        seq: Option<u64>,
    },
}

impl ProgramReport {
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable)
    }

    fn seq(&self) -> Option<u64> {
        match self {
            Self::Cleared { seq, .. } | Self::Current { seq, .. } => *seq,
            _ => None,
        }
    }

    /// Whether an update replaces this report. It does unless both carry the
    /// core's sequence and the update's is older: sequences order only against
    /// sequences, and an update with neither says nothing about order.
    pub fn replaced_by(&self, update: &Self) -> bool {
        !matches!((self.seq(), update.seq()), (Some(held), Some(new)) if new < held)
    }
}

/// The modes of a terminal as the host's screen holds them (`IdeTerminalModes`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalModes {
    pub alternate_screen: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub bracketed_paste: bool,
    pub hide_cursor: bool,
    pub mouse_protocol: MouseProtocol,
    pub mouse_encoding: MouseEncoding,
}

/// Which mouse events a program asked the terminal to report.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum MouseProtocol {
    #[default]
    None,
    Press,
    PressRelease,
    ButtonMotion,
    AnyMotion,
}

/// How reported mouse events are encoded.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum MouseEncoding {
    #[default]
    Default,
    Utf8,
    Sgr,
}

/// Whether the host has finished finding the workspace's surviving terminals
/// (`terminal.list` `adoption`).
///
/// A session missing from the list proves nothing unless this is `settled`.
/// Under `pending` the host is still adopting terminals; an empty or short
/// list may be incomplete, and an attach to an unknown session may be refused
/// with `terminal_adoption_pending` rather than "not found". Under
/// `unavailable` the backend cannot be reached, so only native sessions are
/// listed. Absence of the whole field means the host does not report adoption
/// (an older host); that is not the same as `settled`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TerminalAdoption {
    Pending,
    Settled,
    /// The backend cause, as the host words it.
    Unavailable {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        reason: Option<String>,
    },
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

#[derive(Clone, PartialEq, Serialize, Deserialize)]
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
    /// Where a document's edits stand locally: accepted by the owner, held as
    /// a draft, or checkpointed on this device. Delivered to the panels bound
    /// to the document; the latest is kept for a panel that binds later and
    /// dropped when the document is retired or no panel has it open.
    DocumentLocal {
        resource: ResourceRef,
        local: LocalState,
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
    /// A terminal's program reported its own status (R32). Delivered as
    /// `PanelMsg::TerminalReport` to the panel bound to `resource`, only when
    /// `epoch` is the epoch of its binding, and kept on the session list a
    /// chooser reads. A report for a terminal no panel is bound to is dropped
    /// without a notice. It is the program's word: it moves no lifecycle,
    /// lease, approval, task or availability state and is never an action.
    TerminalReport {
        resource: ResourceRef,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        epoch: u64,
        report: ProgramReport,
    },
    /// The runs whose edits Follow the agent shows: the working turn's run and
    /// the child runs of its delegations, as the page holds them now. The
    /// whole set each time; empty when no turn works. Handled by the root and
    /// sent to no panel.
    FollowedRuns {
        runs: Vec<String>,
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
    /// The account the workbench belongs to changed (signed out, switched).
    /// The core forgets what it held for the old one: outstanding effects,
    /// searches, retained host messages, saved arrangements. It names no
    /// workspace until the host sends `workspaceChanged`.
    AccountChanged {
        account: String,
    },
    ConnectionChanged {
        workspace: String,
        state: ConnectionState,
    },
    /// What the chooser offers: the profiles a process may be started from and
    /// the terminal sessions of the workspace, as the host last said. Each
    /// message replaces both lists.
    ///
    /// `adoption` is the host's word on whether the list is complete. Absent
    /// means the host does not say, which is not `settled`; under `pending`
    /// the absence of a terminal proves nothing. The root keeps it with the
    /// sessions and hands it to terminal panels together with them, and drops
    /// both when the workspace or account changes.
    TerminalSessions {
        workspace: String,
        profiles: Vec<TerminalProfileInfo>,
        sessions: Vec<TerminalSessionInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        adoption: Option<TerminalAdoption>,
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
        /// The unit the rows' match columns count in. Absent on input means
        /// UTF-16 code units, the contract before this field existed.
        #[serde(default = "utf16")]
        encoding: SpanEncoding,
    },
    /// Every finding of one open document at `revision`, replacing whatever
    /// was held for `path`. Columns count in `encoding`. Delivered to every
    /// mounted panel that asks for diagnostics (`Panel::wants_diagnostics`),
    /// whatever it is bound to; a set older than the one held is dropped.
    DiagnosticsSet {
        path: String,
        revision: Revision,
        encoding: SpanEncoding,
        findings: Vec<FindingAt>,
    },
    /// The document at `path` closed: its findings are gone.
    DiagnosticsCleared {
        path: String,
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
    fn local_state_is_a_flat_tagged_object_with_an_optional_problem() {
        let message = HostMessage::DocumentLocal {
            resource: ResourceRef::None,
            local: LocalState {
                status: LocalStatus::Checkpointed {
                    saved_at_ms: 1_700_000_000_000,
                    recovered: true,
                },
                problem: Some(LocalProblem {
                    code: "no_store".into(),
                    reason: "This browser has no local store.".into(),
                }),
            },
        };
        let value = serde_json::to_value(&message).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "documentLocal", "resource": {"type": "none"},
                "local": {
                    "state": "checkpointed", "savedAtMs": 1_700_000_000_000u64, "recovered": true,
                    "problem": {"code": "no_store", "reason": "This browser has no local store."}
                }
            })
        );
        assert_eq!(
            serde_json::from_value::<HostMessage>(value).unwrap(),
            message
        );
        let plain: LocalState = serde_json::from_value(json!({"state": "accepted"})).unwrap();
        assert_eq!(plain.status, LocalStatus::Accepted);
        assert!(plain.problem.is_none());
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
