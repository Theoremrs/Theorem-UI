//! What comes back for an effect. Completion `payload` shapes are the ones the
//! inventory fixes today; an owner whose panel is not built yet answers with
//! just an outcome.

use serde::{Deserialize, Serialize};

use crate::effect::TextChange;
use crate::ids::{EffectId, Generation, ResourceRef, Revision};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Accepted,
    /// The owner said no. `code` is the owner's own word (`stale_revision`,
    /// `terminal_control_refused`, ...); `reason` is for a person.
    Refused {
        code: String,
        reason: String,
    },
    /// The result is unknown. Shown as unknown, never as done, never retried
    /// blind (R47).
    Uncertain {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub effect: EffectId,
    pub resource: ResourceRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub revision: Option<Revision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub generation: Option<Generation>,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub payload: Option<CompletionPayload>,
}

impl Completion {
    pub fn new(effect: EffectId, resource: ResourceRef, outcome: Outcome) -> Self {
        Self {
            effect,
            resource,
            revision: None,
            generation: None,
            outcome,
            payload: None,
        }
    }

    pub fn with_revision(mut self, revision: Revision) -> Self {
        self.revision = Some(revision);
        self
    }

    pub fn with_generation(mut self, generation: Generation) -> Self {
        self.generation = Some(generation);
        self
    }

    pub fn with_payload(mut self, payload: CompletionPayload) -> Self {
        self.payload = Some(payload);
        self
    }
}

/// Result data an effect returns. An `Accepted` completion carries the answer;
/// a `Refused` one may carry the owner's state when the refusal is itself
/// information (a document conflict names the current text).
///
/// Each variant is the answer to one or more effect kinds, named beside it.
/// The `type` tag is the variant name; no payload struct has a field called
/// `type`, so the JSON never has two.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompletionPayload {
    /// `filesList`, `filesSearch`.
    Files(FileListing),
    /// `filesStat`.
    FileStat(FileStat),
    /// A document's text after a read the owner does not stamp further.
    Document(DocumentSnapshot),
    /// `documentOpen`, `documentCreate`.
    DocumentOpened(DocumentOpened),
    /// `documentEdit`, accepted.
    DocumentEdited(DocumentEdited),
    /// `documentEdit`, refused with code `conflict`.
    DocumentConflicted(DocumentConflicted),
    /// `documentSave`.
    DocumentSaved(DocumentSaved),
    /// `documentReconcile`.
    DocumentReconciled(DocumentReconciled),
    /// `scmStatus`.
    Scm(ScmStatus),
    /// `scmDiff`.
    ScmDiff(ScmDiffResult),
    /// `scmShow`.
    ScmShow(ScmShowResult),
    /// `scmLog`.
    ScmLog(ScmLogResult),
    /// `scmBlame`.
    ScmBlame(ScmBlameResult),
    /// The branch list. No effect kind asks for it yet; this is the answer the
    /// SCM owner's `branches` already produces, for the branch effect's panel.
    ScmBranches(ScmBranches),
    /// `scmDiscard`: the id that brings the change back through `scmRestore`.
    ScmDiscarded(ScmDiscarded),
    /// `scmMerge`: a conflict is an accepted answer with `merged: false`.
    ScmMerged(ScmMerged),
    /// `scmStage`, `scmUnstage`, `scmRestore`, `scmCommit`, `scmBranch`,
    /// `scmFetch`, `scmPush`: the repository state the answer was read at.
    ScmState(RepoState),
    /// `terminalOpen`, `terminalAttach`.
    Terminal(TerminalOpened),
    /// `layoutLoad`.
    LayoutLoaded(LayoutLoaded),
    /// `layoutSave`.
    LayoutSaved(LayoutSaved),
    /// `clipboardRead`.
    Clipboard(ClipboardText),
    /// `conversationSend`, `conversationInput`, `conversationEdit`.
    ConversationSent(ConversationSent),
    /// `conversationRetry`.
    ConversationRetried(ConversationRetried),
    /// `conversationCancel`.
    ConversationStopped(ConversationStopped),
    /// `conversationApproval`.
    ConversationApproved(ConversationApproved),
    /// `conversationCreate`, `conversationSwitch`: the thread now open.
    ConversationOpened(ConversationOpened),
    /// `artifactsList`.
    Artifacts(ArtifactsListing),
    /// `artifactRead`.
    ArtifactContent(ArtifactContent),
    /// `languageRename`: the plan `languageApplyPlan` applies.
    LanguagePlan(LanguagePlan),
    /// `runStart`: the handle `runStop` and `runPoll` take.
    RunStarted(RunStarted),
    /// `searchQuery`: the id `searchCancel` takes.
    SearchStarted(SearchStarted),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Directory,
    Symlink,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
}

/// A directory listing or a name search. `partial` is true when the result is
/// a cached or truncated subset, so it is never read as exhaustive (R08).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileListing {
    pub entries: Vec<FileEntry>,
    pub partial: bool,
}

/// What a path is now. `missing` is an answer, not a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum StatKind {
    File,
    Directory,
    Symlink,
    Missing,
}

/// The inner discriminator is `kind`, not `type`: the payload's own tag is
/// `type`, and two fields of that name made the JSON ambiguous. `size` and
/// `mtimeMs` are the files owner's own (`mtime_ms`, in milliseconds); each is
/// absent when the host did not report it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub kind: StatKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub mtime_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub readonly: Option<bool>,
}

// ---- documents ---------------------------------------------------------

/// The authority's text after a read. Absent when the owner sent none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub text: Option<String>,
}

/// A document opened or created: the authority's text and where it stands
/// against the checkout. `dirty` is the owner's report, not inferred here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentOpened {
    pub text: String,
    pub revision: Revision,
    /// The revision the checkout holds, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub saved_revision: Option<Revision>,
    pub dirty: bool,
}

/// An edit the authority accepted. `operation_id` is the effect's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentEdited {
    pub operation_id: String,
    pub revision: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentCurrent {
    pub revision: Revision,
    pub text: String,
}

/// Why an edit is held by the owner until the caller settles it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PendingState {
    /// Sent; no answer yet.
    Inflight,
    /// Its base revision was not the document's: nothing was applied.
    Conflicted,
    /// Refused for another reason: nothing was applied.
    Refused,
    /// The answer was lost: it may or may not be applied. Never resent blind.
    Uncertain,
}

/// An edit the owner holds. `edits` are ranges against the text at
/// `base_revision`, in UTF-16 units as the caller sent them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PendingEdit {
    pub operation_id: String,
    pub base_revision: Revision,
    pub edits: Vec<TextChange>,
    pub state: PendingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub reason: Option<String>,
}

/// An edit refused because its base revision was not the document's
/// (`refused` with code `conflict`). The owner applied nothing and kept the
/// edit in `pending`; the Rust side rebases it over `current` and resends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentConflicted {
    pub operation_id: String,
    /// The base revision that was refused.
    pub base_revision: Revision,
    pub current: DocumentCurrent,
    pub pending: Vec<PendingEdit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentSaved {
    pub revision: Revision,
}

/// The authority's revision and text after a conflict with the checkout was
/// resolved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentReconciled {
    pub revision: Revision,
    pub text: String,
}

// ---- scm ---------------------------------------------------------------

/// What the host says about the repository when it answers: the state a result
/// was read at, so a late answer can be told from the current one (AC-43).
/// Every field is the host's own and absent when it reported none. A detached
/// head and an unreported branch are both an absent `branch`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub index_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub worktree_generation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmChange {
    pub path: String,
    /// Git's two porcelain letters. A row the host sent without them is kept
    /// with both empty, never guessed into a group.
    pub index: String,
    pub worktree: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub original_path: Option<String>,
    pub conflict: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmStatus {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub changes: Vec<ScmChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub path: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub header: String,
    pub patch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmDiffResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub path: Option<String>,
    pub staged: bool,
    /// Set when the diff is one commit's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub commit: Option<String>,
    /// Unified diff text.
    pub text: String,
    pub hunks: Vec<DiffHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmShowResult {
    pub path: String,
    /// `head`, `index` or the revision that was asked for.
    pub reference: String,
    pub exists: bool,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub commit: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub email: Option<String>,
    /// Seconds since the epoch, as the host sends it.
    pub timestamp: String,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmLogResult {
    pub commits: Vec<LogEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    pub author: String,
    pub commit: String,
    pub start_line: u32,
    pub line_count: u32,
    pub summary: String,
    /// The host sends a string or a number; the adapter sends it as text.
    pub timestamp: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmBlameResult {
    pub path: String,
    pub hunks: Vec<BlameHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub upstream: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmBranches {
    pub branches: Vec<BranchInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmDiscarded {
    pub path: String,
    pub restore_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmMerged {
    pub merged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub state: Option<RepoState>,
}

// ---- terminal ----------------------------------------------------------

/// The binding a terminal open or attach reports (`terminal-path.md` 2.1).
///
/// Four versions, each its own field and never folded into one number:
/// - `stream_epoch`: the live stream's epoch (a string, as the host sends it);
/// - `epoch`: the binding epoch, which strands old byte offsets when it moves;
/// - `program` with `origin`: the program incarnation (1 = original, +1 per
///   replacement) and how it came to be there;
/// - `lease_generation`: the control lease's generation.
///
/// Fields the session does not report are absent, never invented.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub session: String,
    pub cols: u16,
    pub rows: u16,
    pub backend: crate::effect::TerminalBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub stream_epoch: Option<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub epoch: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub program: u64,
    /// `launched`, `adopted`, `replacement`, `reattached` or the host's other
    /// word.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "number"))]
    pub lease_generation: Option<u64>,
    /// What the host reported (`host` or `herdr-core`). Absent when it did
    /// not: [`TerminalOpened::process_owner`] derives it from the backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub process_owned_by: Option<String>,
}

impl TerminalOpened {
    /// Who owns the process: the host's word if it gave one, else the owner the
    /// backend implies (Herdr keeps its programs in its own core).
    pub fn process_owner(&self) -> &str {
        match (&self.process_owned_by, self.backend) {
            (Some(reported), _) => reported,
            (None, crate::effect::TerminalBackend::Herdr) => "herdr-core",
            (None, crate::effect::TerminalBackend::Native) => "host",
        }
    }
}

// ---- layout, clipboard -------------------------------------------------

/// The workbench record's two opaque documents, as JSON text, as
/// [`LayoutSave`](crate::effect::LayoutSave) sends them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocument {
    pub current: String,
    pub named_layouts: String,
}

/// What the server holds. `document` is absent until the first save, and the
/// revision is then 0. The revision is the one to save against.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LayoutLoaded {
    pub revision: Revision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub document: Option<LayoutDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LayoutSaved {
    /// The new revision of the record.
    pub revision: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ClipboardText {
    pub text: String,
}

// ---- conversation ------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationSent {
    pub client_message_id: String,
    /// The runtime's id for the message, once it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationRetried {
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationStopped {
    /// The run that was stopped, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationApproved {
    pub approval_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationOpened {
    pub conversation_id: String,
}

// ---- artifacts, language, run, search ----------------------------------
//
// These owners do not exist yet. Each shape holds only what the effect body
// already commits to: a cursor and a key for artifacts, and the id one effect
// returns for the next to take.

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub category: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsListing {
    pub entries: Vec<ArtifactEntry>,
    /// Pass back as `cursor` for the next page; absent on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub key: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguagePlan {
    pub plan_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub handle: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchStarted {
    pub id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completion_json_shape() {
        let completion = Completion::new(
            EffectId(4),
            ResourceRef::Terminal {
                workspace: "w1".into(),
                session: "hc-9".into(),
            },
            Outcome::Refused {
                code: "terminal_control_refused".into(),
                reason: "held".into(),
            },
        )
        .with_generation(Generation(3));
        assert_eq!(
            serde_json::to_value(&completion).unwrap(),
            json!({
                "effect": 4,
                "resource": {"type": "terminal", "workspace": "w1", "session": "hc-9"},
                "generation": 3,
                "outcome": {"status": "refused", "code": "terminal_control_refused", "reason": "held"}
            })
        );
    }

    /// Serialise, compare with the shape TypeScript sees, and read it back.
    fn shape(payload: CompletionPayload, expected: serde_json::Value) {
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value, expected);
        assert_eq!(
            serde_json::from_value::<CompletionPayload>(value).unwrap(),
            payload
        );
    }

    fn seq(n: u64) -> Revision {
        Revision::Seq(n)
    }

    #[test]
    fn file_stat_has_one_type_field_and_the_kind_beside_it() {
        shape(
            CompletionPayload::FileStat(FileStat {
                kind: StatKind::File,
                size: Some(12),
                mtime_ms: Some(1_700_000_000_000),
                readonly: None,
            }),
            json!({"type": "fileStat", "kind": "file", "size": 12, "mtimeMs": 1_700_000_000_000u64}),
        );
        // A path that is not there is an answer with nothing else on it.
        shape(
            CompletionPayload::FileStat(FileStat {
                kind: StatKind::Missing,
                size: None,
                mtime_ms: None,
                readonly: None,
            }),
            json!({"type": "fileStat", "kind": "missing"}),
        );
    }

    #[test]
    fn layout_payloads() {
        shape(
            CompletionPayload::LayoutLoaded(LayoutLoaded {
                revision: seq(3),
                document: Some(LayoutDocument {
                    current: "{\"a\":1}".into(),
                    named_layouts: "{}".into(),
                }),
            }),
            json!({
                "type": "layoutLoaded",
                "revision": {"scheme": "seq", "value": 3},
                "document": {"current": "{\"a\":1}", "namedLayouts": "{}"}
            }),
        );
        // Before the first save there is a revision and no document.
        shape(
            CompletionPayload::LayoutLoaded(LayoutLoaded {
                revision: seq(0),
                document: None,
            }),
            json!({"type": "layoutLoaded", "revision": {"scheme": "seq", "value": 0}}),
        );
        shape(
            CompletionPayload::LayoutSaved(LayoutSaved { revision: seq(4) }),
            json!({"type": "layoutSaved", "revision": {"scheme": "seq", "value": 4}}),
        );
        shape(
            CompletionPayload::Clipboard(ClipboardText { text: "x".into() }),
            json!({"type": "clipboard", "text": "x"}),
        );
    }

    #[test]
    fn document_payloads() {
        shape(
            CompletionPayload::DocumentOpened(DocumentOpened {
                text: "hi".into(),
                revision: seq(7),
                saved_revision: Some(seq(6)),
                dirty: true,
            }),
            json!({
                "type": "documentOpened", "text": "hi", "dirty": true,
                "revision": {"scheme": "seq", "value": 7},
                "savedRevision": {"scheme": "seq", "value": 6}
            }),
        );
        shape(
            CompletionPayload::DocumentEdited(DocumentEdited {
                operation_id: "op-1".into(),
                revision: seq(8),
            }),
            json!({"type": "documentEdited", "operationId": "op-1", "revision": {"scheme": "seq", "value": 8}}),
        );
        shape(
            CompletionPayload::DocumentSaved(DocumentSaved { revision: seq(8) }),
            json!({"type": "documentSaved", "revision": {"scheme": "seq", "value": 8}}),
        );
        shape(
            CompletionPayload::DocumentReconciled(DocumentReconciled {
                revision: seq(9),
                text: "t".into(),
            }),
            json!({"type": "documentReconciled", "text": "t", "revision": {"scheme": "seq", "value": 9}}),
        );
    }

    #[test]
    fn a_conflict_names_the_refused_base_the_current_text_and_the_held_edit() {
        let conflict = CompletionPayload::DocumentConflicted(DocumentConflicted {
            operation_id: "op-2".into(),
            base_revision: seq(5),
            current: DocumentCurrent {
                revision: seq(7),
                text: "theirs".into(),
            },
            pending: vec![PendingEdit {
                operation_id: "op-2".into(),
                base_revision: seq(5),
                edits: vec![TextChange {
                    start: 0,
                    end: 1,
                    insert: "x".into(),
                }],
                state: PendingState::Conflicted,
                reason: None,
            }],
        });
        shape(
            conflict.clone(),
            json!({
                "type": "documentConflicted",
                "operationId": "op-2",
                "baseRevision": {"scheme": "seq", "value": 5},
                "current": {"revision": {"scheme": "seq", "value": 7}, "text": "theirs"},
                "pending": [{
                    "operationId": "op-2",
                    "baseRevision": {"scheme": "seq", "value": 5},
                    "edits": [{"start": 0, "end": 1, "insert": "x"}],
                    "state": "conflicted"
                }]
            }),
        );
        // It travels with a refusal: the refusal is the outcome, the payload the state.
        let completion = Completion::new(
            EffectId(2),
            ResourceRef::None,
            Outcome::Refused {
                code: "conflict".into(),
                reason: "base is old".into(),
            },
        )
        .with_payload(conflict);
        let back: Completion =
            serde_json::from_value(serde_json::to_value(&completion).unwrap()).unwrap();
        assert_eq!(back, completion);
    }

    #[test]
    fn scm_payloads() {
        let state = RepoState {
            head: Some("abc1234".into()),
            branch: Some("main".into()),
            index_generation: Some("4".into()),
            worktree_generation: None,
        };
        let state_json = json!({"head": "abc1234", "branch": "main", "indexGeneration": "4"});
        shape(
            CompletionPayload::Scm(ScmStatus {
                branch: Some("main".into()),
                head: Some("abc1234".into()),
                changes: vec![ScmChange {
                    path: "a.rs".into(),
                    index: "M".into(),
                    worktree: " ".into(),
                    original_path: None,
                    conflict: false,
                }],
                state: Some(state.clone()),
            }),
            json!({
                "type": "scm", "branch": "main", "head": "abc1234",
                "changes": [{"path": "a.rs", "index": "M", "worktree": " ", "conflict": false}],
                "state": state_json
            }),
        );
        shape(
            CompletionPayload::ScmDiff(ScmDiffResult {
                path: Some("a.rs".into()),
                staged: true,
                commit: None,
                text: "@@".into(),
                hunks: vec![DiffHunk {
                    path: "a.rs".into(),
                    old_start: 1,
                    old_count: 2,
                    new_start: 1,
                    new_count: 3,
                    header: "@@ -1,2 +1,3 @@".into(),
                    patch: "+x".into(),
                }],
                state: None,
            }),
            json!({
                "type": "scmDiff", "path": "a.rs", "staged": true, "text": "@@",
                "hunks": [{"path": "a.rs", "oldStart": 1, "oldCount": 2, "newStart": 1,
                           "newCount": 3, "header": "@@ -1,2 +1,3 @@", "patch": "+x"}]
            }),
        );
        shape(
            CompletionPayload::ScmShow(ScmShowResult {
                path: "a.rs".into(),
                reference: "head".into(),
                exists: false,
                text: String::new(),
                state: None,
            }),
            json!({"type": "scmShow", "path": "a.rs", "reference": "head", "exists": false, "text": ""}),
        );
        shape(
            CompletionPayload::ScmLog(ScmLogResult {
                commits: vec![LogEntry {
                    commit: "abc".into(),
                    author: "A".into(),
                    email: Some("a@b".into()),
                    timestamp: "1700000000".into(),
                    subject: "s".into(),
                }],
                state: Some(state.clone()),
            }),
            json!({
                "type": "scmLog",
                "commits": [{"commit": "abc", "author": "A", "email": "a@b",
                             "timestamp": "1700000000", "subject": "s"}],
                "state": state_json
            }),
        );
        shape(
            CompletionPayload::ScmBlame(ScmBlameResult {
                path: "a.rs".into(),
                hunks: vec![BlameHunk {
                    author: "A".into(),
                    commit: "abc".into(),
                    start_line: 1,
                    line_count: 4,
                    summary: "s".into(),
                    timestamp: "17".into(),
                }],
                state: None,
            }),
            json!({
                "type": "scmBlame", "path": "a.rs",
                "hunks": [{"author": "A", "commit": "abc", "startLine": 1, "lineCount": 4,
                           "summary": "s", "timestamp": "17"}]
            }),
        );
        shape(
            CompletionPayload::ScmBranches(ScmBranches {
                branches: vec![BranchInfo {
                    name: "main".into(),
                    remote: false,
                    current: true,
                    upstream: Some("origin/main".into()),
                }],
            }),
            json!({"type": "scmBranches", "branches": [
                {"name": "main", "remote": false, "current": true, "upstream": "origin/main"}]}),
        );
        shape(
            CompletionPayload::ScmDiscarded(ScmDiscarded {
                path: "a.rs".into(),
                restore_id: "r1".into(),
                state: None,
            }),
            json!({"type": "scmDiscarded", "path": "a.rs", "restoreId": "r1"}),
        );
        shape(
            CompletionPayload::ScmMerged(ScmMerged {
                merged: false,
                state: None,
            }),
            json!({"type": "scmMerged", "merged": false}),
        );
        shape(
            CompletionPayload::ScmState(RepoState::default()),
            json!({"type": "scmState"}),
        );
    }

    #[test]
    fn conversation_payloads() {
        shape(
            CompletionPayload::ConversationSent(ConversationSent {
                client_message_id: "c1".into(),
                message_id: None,
            }),
            json!({"type": "conversationSent", "clientMessageId": "c1"}),
        );
        shape(
            CompletionPayload::ConversationRetried(ConversationRetried {
                message_id: "m2".into(),
            }),
            json!({"type": "conversationRetried", "messageId": "m2"}),
        );
        shape(
            CompletionPayload::ConversationStopped(ConversationStopped {
                run_id: Some("run-1".into()),
            }),
            json!({"type": "conversationStopped", "runId": "run-1"}),
        );
        shape(
            CompletionPayload::ConversationApproved(ConversationApproved {
                approval_id: "ap1".into(),
            }),
            json!({"type": "conversationApproved", "approvalId": "ap1"}),
        );
        shape(
            CompletionPayload::ConversationOpened(ConversationOpened {
                conversation_id: "t9".into(),
            }),
            json!({"type": "conversationOpened", "conversationId": "t9"}),
        );
    }

    #[test]
    fn artifacts_language_run_and_search_carry_only_what_the_effects_commit_to() {
        shape(
            CompletionPayload::Artifacts(ArtifactsListing {
                entries: vec![ArtifactEntry {
                    key: "k".into(),
                    category: Some("c".into()),
                }],
                next_cursor: Some("n".into()),
            }),
            json!({"type": "artifacts", "entries": [{"key": "k", "category": "c"}], "nextCursor": "n"}),
        );
        shape(
            CompletionPayload::ArtifactContent(ArtifactContent {
                key: "k".into(),
                text: "t".into(),
            }),
            json!({"type": "artifactContent", "key": "k", "text": "t"}),
        );
        shape(
            CompletionPayload::LanguagePlan(LanguagePlan {
                plan_id: "p".into(),
            }),
            json!({"type": "languagePlan", "planId": "p"}),
        );
        shape(
            CompletionPayload::RunStarted(RunStarted { handle: "h".into() }),
            json!({"type": "runStarted", "handle": "h"}),
        );
        shape(
            CompletionPayload::SearchStarted(SearchStarted { id: "s".into() }),
            json!({"type": "searchStarted", "id": "s"}),
        );
    }

    #[test]
    fn terminal_opened_reports_four_versions_and_no_invented_owner() {
        use crate::effect::TerminalBackend;
        let opened = TerminalOpened {
            session: "hc-1".into(),
            cols: 80,
            rows: 24,
            backend: TerminalBackend::Herdr,
            stream_epoch: Some("se-1".into()),
            epoch: 2,
            program: 3,
            origin: Some("replacement".into()),
            lease_generation: Some(5),
            process_owned_by: None,
        };
        shape(
            CompletionPayload::Terminal(opened.clone()),
            json!({
                "type": "terminal", "session": "hc-1", "cols": 80, "rows": 24,
                "backend": "herdr", "streamEpoch": "se-1", "epoch": 2, "program": 3,
                "origin": "replacement", "leaseGeneration": 5
            }),
        );
        // Not sent by the host: derived from the backend, never required.
        assert_eq!(opened.process_owner(), "herdr-core");
        let native = TerminalOpened {
            backend: TerminalBackend::Native,
            ..opened.clone()
        };
        assert_eq!(native.process_owner(), "host");
        let said = TerminalOpened {
            process_owned_by: Some("host".into()),
            ..opened
        };
        assert_eq!(said.process_owner(), "host");
        // The smallest thing a session reports still parses.
        let minimal: TerminalOpened = serde_json::from_value(json!({
            "session": "pty-1", "cols": 1, "rows": 1, "backend": "native", "epoch": 1, "program": 1
        }))
        .unwrap();
        assert!(minimal.origin.is_none() && minimal.stream_epoch.is_none());
    }

    #[test]
    fn uncertain_is_not_accepted() {
        let uncertain: Outcome =
            serde_json::from_value(json!({"status": "uncertain", "reason": "reply lost"})).unwrap();
        assert_ne!(uncertain, Outcome::Accepted);
    }
}
