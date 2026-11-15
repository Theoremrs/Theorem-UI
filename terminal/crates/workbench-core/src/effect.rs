//! What `update` asks the host to do. Every effect carries the same envelope
//! (ARCHITECTURE section 3) and a closed, owner-grouped body.
//!
//! Payload fields come from the Gate 0 owner inventory
//! (`gate-0/owners-documents-and-persistence.md`, `gate-0/terminal-path.md`).
//! A panel that is not built yet gets a placeholder with only the fields the
//! inventory already fixes; no endpoint shape is invented here.

use serde::{Deserialize, Serialize};
use strum::EnumDiscriminants;

use crate::draft::SourceReference;
use crate::ids::{Actor, EffectId, Generation, ResourceRef, Revision};

/// Which owner performs an effect. The adapter routes by this
/// (`src/lib/workbench/{files,documents,scm,...}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    Files,
    Documents,
    Scm,
    Language,
    Run,
    Search,
    Terminal,
    Conversation,
    Layout,
    Artifacts,
    /// A run's delegations: what each changed, before and after.
    Delegations,
    /// Clipboard and other browser services.
    Host,
}

/// An effect: the envelope plus a body. `kind` and `payload` sit beside the
/// envelope fields on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: EffectId,
    pub resource: ResourceRef,
    /// The revision the effect was computed against; the owner's `base_revision`
    /// or `If-Match`. Absent for resources without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub revision: Option<Revision>,
    /// The pane's binding generation when the effect was emitted. For terminals
    /// this is the binding epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub generation: Option<Generation>,
    /// Who the effect is for: the person, or the agent run that asked for the
    /// action that made it (R34, R42). The model stamps this when the effect
    /// leaves a panel, from the actor of the message being handled: an action
    /// run for an agent stamps that run, a key, click or text the person.
    ///
    /// It says who asked for the call that emitted the effect, no more. An
    /// effect emitted later on its own account (a follow-up to a completion,
    /// a tick, a save that follows an edit) is stamped for the person, because
    /// the model keeps no link from a completion back to the action that began
    /// the work and does not guess one. An absent actor reads as the person,
    /// so older payloads stay readable, and the person is not written out.
    #[serde(default, skip_serializing_if = "Actor::is_human")]
    #[cfg_attr(feature = "ts", ts(as = "Option<Actor>", optional))]
    pub actor: Actor,
    #[serde(flatten)]
    pub body: EffectBody,
}

impl Effect {
    pub fn new(id: EffectId, resource: ResourceRef, body: EffectBody) -> Self {
        Self {
            id,
            resource,
            revision: None,
            generation: None,
            actor: Actor::Human,
            body,
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

    pub fn with_actor(mut self, actor: Actor) -> Self {
        self.actor = actor;
        self
    }

    pub fn kind(&self) -> EffectKind {
        EffectKind::from(&self.body)
    }

    pub fn owner(&self) -> Owner {
        self.kind().owner()
    }
}

/// The closed set of effects, grouped by owner. `EffectKind` (generated) is the
/// same list without payloads, for the registry and the semantic tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, EnumDiscriminants)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
#[strum_discriminants(name(EffectKind))]
#[strum_discriminants(derive(Hash, Serialize, Deserialize))]
#[strum_discriminants(serde(rename_all = "camelCase"))]
#[cfg_attr(feature = "ts", strum_discriminants(derive(ts_rs::TS)))]
pub enum EffectBody {
    // Files
    FilesList(FilesPath),
    FilesStat(FilesPath),
    /// Name search. Cached results may be partial; the completion says so.
    FilesSearch(FilesSearch),
    FilesCreate(FilesCreate),
    FilesRename(FilesRename),
    /// Copy `from` to `to` (`files.copy`). Same intent class and completion as
    /// rename: an accepted outcome with no payload.
    FilesCopy(FilesCopy),
    FilesDelete(FilesPath),

    // Documents (the SDK `DocumentSession`)
    /// Explicit creation, as New page does after its name prompt.
    DocumentCreate(DocumentCreate),
    DocumentOpen(DocumentOpen),
    /// Edits against the effect's `revision`, in the stated unit.
    DocumentEdit(DocumentEdit),
    DocumentSave,
    DocumentClose,
    DocumentReconcile(DocumentReconcile),
    /// Drop unsaved edits and return to the checkout's text (`DocumentHandle.revert`).
    /// Answered by `documentReconciled`.
    DocumentRevert,
    /// The caller has dealt with a held edit (`DocumentHandle.settle`): a local
    /// call on the owner with no host round trip. Accepted with no payload.
    DocumentSettle(DocumentSettle),
    /// The edits the editor is holding back behind an edit whose outcome is
    /// unknown (see [`DocumentKeep`]). Accepted with no payload; refused or
    /// failed carry a reason.
    DocumentKeep(DocumentKeep),
    /// The points the document can be put back to, newest first. Accepted with
    /// `documentHistory`; an empty list is an answer.
    DocumentHistoryList,
    /// The text the document had at `point`. Accepted with `documentPreview`.
    DocumentHistoryPreview(DocumentHistoryPoint),
    /// Put the document back to `point`. For the person only: an agent's action
    /// is refused at the emit (see [`EffectKind::human_only`]). Accepted with no
    /// payload; the restored text arrives as an ordinary `documentChanged`.
    DocumentHistoryRestore(DocumentHistoryPoint),

    // SCM
    ScmStatus,
    ScmDiff(ScmDiff),
    ScmShow(ScmShow),
    ScmStage(ScmPaths),
    ScmUnstage(ScmPaths),
    ScmDiscard(FilesPath),
    ScmRestore(ScmRestore),
    ScmCommit(ScmCommit),
    /// Replace the last commit (`scm.commit` with `amend`). The host must
    /// advertise `scm.commit.amend`; the owner refuses `missing_capability`
    /// otherwise.
    ScmAmend(ScmAmend),
    /// List the branches (`Scm.branches`), answered by `scmBranches`.
    ScmBranches,
    /// A commit's diff (`Scm.diffCommit`), so a log row opens as that commit.
    ScmDiffCommit(ScmDiffCommit),
    /// A file at any revision the host resolves (`Scm.show` with a revision
    /// string); `ScmShow` stays the head-or-index form.
    ScmShowRevision(ScmShowRevision),
    ScmBranch(ScmBranch),
    ScmFetch(ScmRemote),
    ScmPush(ScmPush),
    ScmMerge(ScmMerge),
    ScmBlame(FilesPath),
    ScmLog(ScmLog),
    /// The three sides of a conflicted path (`scm.conflict`), answered by
    /// `scmConflict`.
    ScmConflict(FilesPath),
    /// Settle a conflicted path (`scm.resolve`): take a side, or the text the
    /// person merged. Answered by the repository state it left.
    ScmResolve(ScmResolve),

    // Language (bound to a document and its revision)
    LanguageHover(LanguagePosition),
    LanguageComplete(LanguagePosition),
    LanguageNavigate(LanguageNavigate),
    LanguageReferences(LanguagePosition),
    LanguageDiagnostics,
    LanguageFormat,
    LanguageRename(LanguageRename),
    LanguageApplyPlan(LanguageApplyPlan),

    // Run
    RunConfigure(RunConfigure),
    RunStart(RunStart),
    RunStop(RunHandle),
    RunPoll(RunHandle),
    /// The runs the backend knows, so a panel can attach to one started
    /// elsewhere. Answered by `runList`; the host operation is `run.list`.
    RunList,

    // Search
    SearchQuery(SearchQuery),
    SearchCancel(SearchCancel),

    // Terminal. Detach and End are separate on purpose: closing a view only
    // ever detaches (R29).
    TerminalOpen(TerminalOpen),
    TerminalAttach(TerminalAttach),
    TerminalInput(TerminalInput),
    /// Input that is not text (a legacy mouse report): the bytes as base64,
    /// beside `terminalInput`, which stays the text form.
    TerminalInputBytes(TerminalInputBytes),
    TerminalResize(TerminalResize),
    TerminalDetach(TerminalClaim),
    TerminalEnd,
    /// The pane that asked for `open` closed before `terminalOpened` came
    /// back. The adapter ends whatever that open starts, whichever side of
    /// this effect its answer falls on, so no process outlives its pane.
    TerminalAbandonOpen(TerminalAbandonOpen),

    // Conversation and runs
    ConversationCreate,
    /// A turn, when no run is working. Intent `Start`; never emitted by a
    /// `Focus` or `Open` action.
    ConversationSend(ConversationSend),
    /// Steer a running run (`runs.command` `input`).
    ConversationInput(ConversationInput),
    /// Stop the working run. Intent `Destroy`: closing a view never stops a run.
    ConversationCancel(ConversationCancel),
    /// Run the reply to a user message again as a new branch.
    ConversationRetry(ConversationRetry),
    /// Send changed text for a user message as a new branch.
    ConversationEdit(ConversationEdit),
    /// Make another thread of the project the open one.
    ConversationSwitch(ConversationSwitch),
    /// Select a branch of a reply in a thread: answered as `ConversationSwitch`
    /// is (with the thread's snapshot).
    ConversationSwitchBranch(ConversationSwitchBranch),
    /// Human-only: the registry refuses it from an agent actor.
    ConversationApproval(ConversationApproval),
    /// A second conversation beside this one (`Conversation.sideChat`), on its
    /// own runtime. Answered by `conversationSideOpened`; effects for it carry a
    /// `conversation` resource naming the id that answer returned.
    ConversationSideChat(SideChatOpen),
    /// The side chats that exist, answered by `conversationSideList`.
    ConversationSideList,
    /// End the side chat the effect's `conversation` resource names
    /// (`SideChat.close`). Accepted with no payload; Intent `Destroy`.
    ConversationSideClose,
    /// Ask the host to open its file chooser for the draft. The result is the
    /// host message `conversationAttachments`, never this effect's completion.
    ConversationAttachPick,
    /// Drop one file from the draft; answered by `conversationAttachments`.
    ConversationAttachRemove(AttachRemove),
    /// Ask for the models the conversation can run on; answered by the host
    /// message `conversationModels`.
    ConversationModels,
    /// Choose the model the next turn runs on; answered by `conversationModels`.
    ConversationSetModel(SetModel),
    /// Choose the reasoning effort of the next turn; answered by
    /// `conversationModels`.
    ConversationSetEffort(SetEffort),

    // Layout (`client.workbench.get/save`, revisioned with `If-Match`)
    LayoutLoad,
    LayoutSave(LayoutSave),
    /// Put the appearance a saved arrangement was kept with on screen. Answered
    /// Accepted, or Refused or Failed with a reason the person is told.
    AppearanceApply(AppearanceApply),

    // Artifacts (the cabinet's catalog)
    ArtifactsList(ArtifactsList),
    ArtifactRead(ArtifactRead),

    // Delegations (what a run's delegation changed)
    /// The files a delegation changed. Accepted with `delegationChanges`.
    DelegationChanges(DelegationRef),
    /// A file of a delegation, as it was before or is after. Accepted with
    /// `delegationText`.
    DelegationContent(DelegationContentRead),

    // Clipboard and host
    ClipboardWrite(ClipboardWrite),
    ClipboardRead,
}

impl EffectKind {
    /// Whether an agent's action may not emit this kind: the person's own
    /// decision, which an agent may propose but not carry out.
    pub fn human_only(self) -> bool {
        matches!(self, Self::DocumentHistoryRestore)
    }

    pub fn owner(self) -> Owner {
        use EffectKind::*;
        match self {
            FilesList | FilesStat | FilesSearch | FilesCreate | FilesRename | FilesCopy
            | FilesDelete => Owner::Files,
            DocumentCreate
            | DocumentOpen
            | DocumentEdit
            | DocumentSave
            | DocumentClose
            | DocumentReconcile
            | DocumentRevert
            | DocumentSettle
            | DocumentKeep
            | DocumentHistoryList
            | DocumentHistoryPreview
            | DocumentHistoryRestore => Owner::Documents,
            DelegationChanges | DelegationContent => Owner::Delegations,
            ScmStatus | ScmDiff | ScmShow | ScmStage | ScmUnstage | ScmDiscard | ScmRestore
            | ScmCommit | ScmAmend | ScmBranches | ScmDiffCommit | ScmShowRevision | ScmBranch
            | ScmFetch | ScmPush | ScmMerge | ScmBlame | ScmLog | ScmConflict | ScmResolve => {
                Owner::Scm
            }
            LanguageHover | LanguageComplete | LanguageNavigate | LanguageReferences
            | LanguageDiagnostics | LanguageFormat | LanguageRename | LanguageApplyPlan => {
                Owner::Language
            }
            RunConfigure | RunStart | RunStop | RunPoll | RunList => Owner::Run,
            SearchQuery | SearchCancel => Owner::Search,
            TerminalOpen | TerminalAttach | TerminalInput | TerminalInputBytes | TerminalResize
            | TerminalDetach | TerminalEnd | TerminalAbandonOpen => Owner::Terminal,
            ConversationCreate
            | ConversationSend
            | ConversationInput
            | ConversationCancel
            | ConversationRetry
            | ConversationEdit
            | ConversationSwitch
            | ConversationSwitchBranch
            | ConversationApproval
            | ConversationSideChat
            | ConversationSideList
            | ConversationAttachPick
            | ConversationAttachRemove
            | ConversationModels
            | ConversationSetModel
            | ConversationSetEffort
            | ConversationSideClose => Owner::Conversation,
            LayoutLoad | LayoutSave | AppearanceApply => Owner::Layout,
            ArtifactsList | ArtifactRead => Owner::Artifacts,
            ClipboardWrite | ClipboardRead => Owner::Host,
        }
    }
}

// ---- files -------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FilesPath {
    pub path: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FilesSearch {
    pub query: String,
    /// Rows per page (`Files.search` `limit`); absent means the owner's page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub limit: Option<u32>,
    /// Rows to skip (`Files.search` `offset`): the `next` of the page before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub offset: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FilesCreate {
    pub path: String,
    pub directory: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FilesRename {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FilesCopy {
    pub from: String,
    pub to: String,
    /// Replace `to` when it exists; without it an existing `to` is refused.
    pub overwrite: bool,
}

// ---- documents ---------------------------------------------------------

/// The unit an offset is counted in. Never interchangeable (R13).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CoordinateUnit {
    Utf16,
    Scalar,
    Utf8Bytes,
}

/// One edit against the text before the whole change set.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TextChange {
    pub start: u32,
    pub end: u32,
    pub insert: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentCreate {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub seed_text: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentOpen {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub seed_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentEdit {
    /// Doubles as the host's idempotency key.
    pub operation_id: String,
    pub unit: CoordinateUnit,
    pub edits: Vec<TextChange>,
}

/// Which side a conflict resolves to (`documents.reconcile` `keep`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ReconcileKeep {
    Disk,
    Authority,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentReconcile {
    pub keep: ReconcileKeep,
}

/// `DocumentHandle.settle(operationId)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentSettle {
    pub operation_id: String,
}

/// The edits the editor is holding back behind an edit whose outcome is
/// unknown. It is the whole queue each time, an empty list once nothing is held.
/// The owner keeps them on the device and sends none of them.
///
/// The document resource is on the envelope, as for [`DocumentEdit`]. It carries
/// document content, so its `Debug` prints sizes only.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentKeep {
    pub edits: Vec<KeptEdit>,
}

/// One held edit: the operation, the revision it was made against, and its changes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeptEdit {
    pub operation_id: String,
    pub base_revision: Revision,
    pub edits: Vec<TextChange>,
}

/// A point in a document's history, as the owner named it. Opaque to the
/// workbench; it is only handed back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentHistoryPoint {
    pub point: String,
}

// ---- delegations -------------------------------------------------------

/// One delegation of one run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DelegationRef {
    pub run_id: String,
    pub delegation_id: String,
}

/// Which side of a change to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DelegationSide {
    Before,
    After,
}

/// One file of a delegation, before or after.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DelegationContentRead {
    pub run_id: String,
    pub delegation_id: String,
    pub path: String,
    pub side: DelegationSide,
}

// ---- scm ---------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmPaths {
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmDiff {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub path: Option<String>,
    pub staged: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ScmRef {
    Head,
    Index,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmShow {
    pub path: String,
    pub reference: ScmRef,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmRestore {
    pub restore_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmCommit {
    pub message: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmAmend {
    /// The owner refuses an empty message (`empty_message`), amend or not.
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmDiffCommit {
    pub commit: String,
    /// Narrows the diff to one path; absent means the whole commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmShowRevision {
    pub path: String,
    /// A commit id or any revision the host resolves.
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmBranch {
    pub name: String,
    pub create: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmRemote {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub remote: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmPush {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub reference: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmMerge {
    pub branch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmLog {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub path: Option<String>,
    pub max_count: u32,
}

/// Which side of a conflict wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ConflictTake {
    Ours,
    Theirs,
    /// The text the person merged, in `ScmResolve.text`.
    Merged,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmResolve {
    pub path: String,
    pub take: ConflictTake,
    /// The merged text; the owner refuses `merged` without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub text: Option<String>,
}

// ---- language ----------------------------------------------------------

/// LSP position: `character` counts UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguagePosition {
    pub line: u32,
    pub character: u32,
}

/// What a side chat starts from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SideChatScope {
    /// No history: an empty conversation. What an absent scope means.
    #[default]
    Fresh,
    /// The open conversation's history, carried on in the side chat.
    Continued,
    /// A copy of the open conversation at this moment, then its own.
    Forked,
}

/// The payload of `conversationSideChat`. An empty one is a fresh side chat.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SideChatOpen {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub scope: Option<SideChatScope>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageNavigate {
    /// The SDK's `navigate(kind)` word; the host owns the set.
    pub kind: String,
    pub position: LanguagePosition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageRename {
    pub position: LanguagePosition,
    pub new_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LanguageApplyPlan {
    pub plan_id: String,
}

// ---- run and search ----------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunConfigure {
    pub name: String,
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunStart {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RunHandle {
    pub handle: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Globs a path must match one of, as the host takes them: a list, never
    /// one comma-separated string. Absent or empty: every path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub include: Option<Vec<String>>,
    /// Globs that leave a path out, as a list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub exclude: Option<Vec<String>>,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchCancel {
    pub id: String,
}

// ---- terminal ----------------------------------------------------------

/// Named explicitly on every open: there is no silent fallback from Herdr to
/// native (R25).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TerminalBackend {
    Native,
    Herdr,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpen {
    pub backend: TerminalBackend,
    /// Herdr only; absent means the machine shell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub name: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// The attachment name to attach with once the program is running, so
    /// opening and attaching are one effect. The answer carries it back. Absent:
    /// the open only starts the program, and a `terminalAttach` follows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub attachment: Option<String>,
    /// One id per launch intent. A second attempt of the same failed or
    /// uncertain launch carries the same one, so the host can tell a retry
    /// from a new launch; a new launch gets a new one. Absent from a caller
    /// that names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub operation: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TerminalRole {
    Controller,
    Observer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub from_offset: u64,
    pub role: TerminalRole,
    pub attachment: String,
}

/// The claim a controller presents with input and resize: its attachment and
/// the lease generation and binding epoch it believes are current.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalClaim {
    pub attachment: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub lease_generation: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum InputKind {
    Human,
    Reply,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalInput {
    pub bytes: String,
    pub kind: InputKind,
    /// Minted by the terminal panel, once per logical input, and unique within
    /// the binding epoch across page loads (the panel includes a per-load
    /// nonce). The core never mints or rewrites it: a retry of an `Uncertain`
    /// input re-emits this same body, so the id is the same.
    ///
    /// The host remembers the last 256 per binding epoch and writes a repeat
    /// once. Uncertain input is never replayed past that window.
    ///
    /// The adapter MUST pass `input_id` and `claim` through to the terminal
    /// session and must not let the session mint its own id for this input,
    /// or a resend would be a new input and be written twice.
    pub input_id: String,
    pub claim: TerminalClaim,
}

/// [`TerminalInput`] for bytes that are not UTF-8. Same ledger, same claim:
/// `input_id` is minted once per logical input and a retry re-emits it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputBytes {
    /// Base64 of the bytes to write.
    pub data: String,
    pub kind: InputKind,
    pub input_id: String,
    pub claim: TerminalClaim,
}

/// The effect whose `terminalOpen` is to be undone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalAbandonOpen {
    pub open: crate::ids::EffectId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalResize {
    pub cols: u16,
    pub rows: u16,
    pub claim: TerminalClaim,
}

// ---- conversation ------------------------------------------------------

/// A file attached to a turn, by the id the attachment service gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub content_type: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationSend {
    /// Minted by the composer once per turn. The owner never sends the same id
    /// twice, so a retry of this effect reuses it and cannot double-send.
    pub client_message_id: String,
    pub text: String,
    /// Absent on input means none.
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    /// Workspace locations the turn carries. Absent on input means none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<SourceReference>,
}

/// One file of the draft, by the id `conversationAttachments` gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AttachRemove {
    pub id: String,
}

/// Choose a model by the `ref` a `ModelChoice` named it by.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SetModel {
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "ts", ts(rename = "ref"))]
    pub model_ref: String,
}

/// Choose an effort level, one of the `efforts` the host listed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SetEffort {
    pub level: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationInput {
    pub run_id: String,
    pub client_message_id: String,
    pub text: String,
}

/// Stops a run. `run_id` names the run the person saw working; absent means
/// whichever run the thread has now (the owner answers with the one it
/// stopped).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationCancel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationRetry {
    pub message_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationEdit {
    pub message_id: String,
    pub client_message_id: String,
    pub text: String,
    /// The locations the edited message carries, restated whole. Absent on
    /// input means none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<SourceReference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationSwitch {
    pub thread_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationSwitchBranch {
    pub thread_id: String,
    pub branch_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

/// Records the exact operation approved, so the receipt can name it (spec 13).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationApproval {
    pub run_id: String,
    pub approval_id: String,
    pub decision: ApprovalDecision,
}

// ---- layout, artifacts, clipboard --------------------------------------

/// The workbench record's two opaque documents, as JSON text. The core does
/// not interpret them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LayoutSave {
    pub current: String,
    pub named_layouts: String,
}

/// The appearance a saved arrangement carries: the host's own JSON text,
/// exactly as the host last told it. The core does not interpret it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AppearanceApply {
    pub appearance: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsList {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRead {
    pub key: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWrite {
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::EffectIds;
    use serde_json::json;

    #[test]
    fn effect_json_shape() {
        let mut ids = EffectIds::default();
        let effect = Effect::new(
            ids.mint(),
            ResourceRef::Document {
                workspace: "w1".into(),
                resource_id: "docs/a.md".into(),
            },
            EffectBody::DocumentEdit(DocumentEdit {
                operation_id: "op-1".into(),
                unit: CoordinateUnit::Utf16,
                edits: vec![TextChange {
                    start: 0,
                    end: 0,
                    insert: "hi".into(),
                }],
            }),
        )
        .with_revision(Revision::Seq(7))
        .with_generation(Generation(2));
        assert_eq!(
            serde_json::to_value(&effect).unwrap(),
            json!({
                "id": 1,
                "resource": {"type": "document", "workspace": "w1", "resourceId": "docs/a.md"},
                "revision": {"scheme": "seq", "value": 7},
                "generation": 2,
                "kind": "documentEdit",
                "payload": {
                    "operationId": "op-1",
                    "unit": "utf16",
                    "edits": [{"start": 0, "end": 0, "insert": "hi"}]
                }
            })
        );
        let round: Effect = serde_json::from_value(serde_json::to_value(&effect).unwrap()).unwrap();
        assert_eq!(round, effect);
    }

    #[test]
    fn unit_effects_carry_no_payload() {
        let effect = Effect::new(EffectId(3), ResourceRef::None, EffectBody::ClipboardRead);
        let value = serde_json::to_value(&effect).unwrap();
        assert_eq!(value["kind"], "clipboardRead");
        assert!(value.get("payload").is_none());
        assert!(value.get("revision").is_none());
    }

    fn round_trip(body: EffectBody, kind: &str, payload: serde_json::Value) {
        let effect = Effect::new(EffectId(1), ResourceRef::None, body);
        let value = serde_json::to_value(&effect).unwrap();
        assert_eq!(value["kind"], kind);
        assert_eq!(value["payload"], payload);
        assert_eq!(serde_json::from_value::<Effect>(value).unwrap(), effect);
    }

    #[test]
    fn files_copy_round_trips_and_belongs_to_files() {
        round_trip(
            EffectBody::FilesCopy(FilesCopy {
                from: "a.md".into(),
                to: "b.md".into(),
                overwrite: false,
            }),
            "filesCopy",
            json!({"from": "a.md", "to": "b.md", "overwrite": false}),
        );
        assert_eq!(EffectKind::FilesCopy.owner(), Owner::Files);
    }

    #[test]
    fn conversation_effects_round_trip() {
        round_trip(
            EffectBody::ConversationSend(ConversationSend {
                client_message_id: "c1".into(),
                text: "hi".into(),
                attachments: vec![AttachmentRef {
                    id: "a1".into(),
                    name: "x.png".into(),
                    content_type: Some("image/png".into()),
                }],
                references: vec![],
            }),
            "conversationSend",
            json!({
                "clientMessageId": "c1", "text": "hi",
                "attachments": [{"id": "a1", "name": "x.png", "contentType": "image/png"}]
            }),
        );
        round_trip(
            EffectBody::ConversationInput(ConversationInput {
                run_id: "r".into(),
                client_message_id: "c2".into(),
                text: "t".into(),
            }),
            "conversationInput",
            json!({"runId": "r", "clientMessageId": "c2", "text": "t"}),
        );
        round_trip(
            EffectBody::ConversationCancel(ConversationCancel {
                run_id: Some("r".into()),
            }),
            "conversationCancel",
            json!({"runId": "r"}),
        );
        round_trip(
            EffectBody::ConversationCancel(ConversationCancel { run_id: None }),
            "conversationCancel",
            json!({}),
        );
        round_trip(
            EffectBody::ConversationRetry(ConversationRetry {
                message_id: "m".into(),
            }),
            "conversationRetry",
            json!({"messageId": "m"}),
        );
        round_trip(
            EffectBody::ConversationEdit(ConversationEdit {
                message_id: "m".into(),
                client_message_id: "c3".into(),
                text: "t".into(),
                references: vec![],
            }),
            "conversationEdit",
            json!({"messageId": "m", "clientMessageId": "c3", "text": "t"}),
        );
        round_trip(
            EffectBody::ConversationSwitchBranch(ConversationSwitchBranch {
                thread_id: "t1".into(),
                branch_id: "b2".into(),
            }),
            "conversationSwitchBranch",
            serde_json::json!({"threadId": "t1", "branchId": "b2"}),
        );
        round_trip(
            EffectBody::ConversationSwitch(ConversationSwitch {
                thread_id: "t1".into(),
            }),
            "conversationSwitch",
            json!({"threadId": "t1"}),
        );
        round_trip(
            EffectBody::ConversationApproval(ConversationApproval {
                run_id: "r".into(),
                approval_id: "ap".into(),
                decision: ApprovalDecision::Deny,
            }),
            "conversationApproval",
            json!({"runId": "r", "approvalId": "ap", "decision": "deny"}),
        );
        // A send with no attachments reads without the field.
        let send: ConversationSend =
            serde_json::from_value(json!({"clientMessageId": "c", "text": "t"})).unwrap();
        assert!(send.attachments.is_empty());
    }

    #[test]
    fn a_terminal_input_retry_carries_the_same_input_id_and_claim() {
        let body = EffectBody::TerminalInput(TerminalInput {
            bytes: "ls\r".into(),
            kind: InputKind::Human,
            input_id: "load1:7".into(),
            claim: TerminalClaim {
                attachment: "a1".into(),
                lease_generation: 4,
                epoch: 2,
            },
        });
        let first = Effect::new(EffectId(9), ResourceRef::None, body.clone());
        // A retry reuses the effect's id and body, so the id the host dedups on
        // is unchanged on the wire.
        let retry = Effect::new(EffectId(9), ResourceRef::None, body);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&retry).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&first).unwrap()["payload"],
            json!({
                "bytes": "ls\r", "kind": "human", "inputId": "load1:7",
                "claim": {"attachment": "a1", "leaseGeneration": 4, "epoch": 2}
            })
        );
    }

    #[test]
    fn wire_order_effects_round_trip_and_have_owners() {
        round_trip(
            EffectBody::ScmAmend(ScmAmend {
                message: "m".into(),
            }),
            "scmAmend",
            json!({"message": "m"}),
        );
        round_trip(
            EffectBody::ScmDiffCommit(ScmDiffCommit {
                commit: "abc".into(),
                path: Some("a.rs".into()),
            }),
            "scmDiffCommit",
            json!({"commit": "abc", "path": "a.rs"}),
        );
        round_trip(
            EffectBody::ScmShowRevision(ScmShowRevision {
                path: "a.rs".into(),
                revision: "abc".into(),
            }),
            "scmShowRevision",
            json!({"path": "a.rs", "revision": "abc"}),
        );
        round_trip(
            EffectBody::DocumentSettle(DocumentSettle {
                operation_id: "op1".into(),
            }),
            "documentSettle",
            json!({"operationId": "op1"}),
        );
        round_trip(
            EffectBody::DocumentKeep(DocumentKeep {
                edits: vec![KeptEdit {
                    operation_id: "op2".into(),
                    base_revision: Revision::Seq(4),
                    edits: vec![TextChange {
                        start: 1,
                        end: 2,
                        insert: "x".into(),
                    }],
                }],
            }),
            "documentKeep",
            json!({"edits": [{
                "operationId": "op2",
                "baseRevision": {"scheme": "seq", "value": 4},
                "edits": [{"start": 1, "end": 2, "insert": "x"}],
            }]}),
        );
        round_trip(
            EffectBody::DocumentKeep(DocumentKeep { edits: vec![] }),
            "documentKeep",
            json!({"edits": []}),
        );
        round_trip(
            EffectBody::DocumentHistoryPreview(DocumentHistoryPoint {
                point: "h-3".into(),
            }),
            "documentHistoryPreview",
            json!({"point": "h-3"}),
        );
        round_trip(
            EffectBody::DocumentHistoryRestore(DocumentHistoryPoint {
                point: "h-3".into(),
            }),
            "documentHistoryRestore",
            json!({"point": "h-3"}),
        );
        round_trip(
            EffectBody::DelegationChanges(DelegationRef {
                run_id: "run-1".into(),
                delegation_id: "d-1".into(),
            }),
            "delegationChanges",
            json!({"runId": "run-1", "delegationId": "d-1"}),
        );
        round_trip(
            EffectBody::DelegationContent(DelegationContentRead {
                run_id: "run-1".into(),
                delegation_id: "d-1".into(),
                path: "src/a.rs".into(),
                side: DelegationSide::Before,
            }),
            "delegationContent",
            json!({"runId": "run-1", "delegationId": "d-1", "path": "src/a.rs", "side": "before"}),
        );
        round_trip(
            EffectBody::FilesSearch(FilesSearch {
                query: "q".into(),
                limit: Some(50),
                offset: Some(100),
            }),
            "filesSearch",
            json!({"query": "q", "limit": 50, "offset": 100}),
        );
        // A search that names no page still reads as before.
        let old: FilesSearch = serde_json::from_value(json!({"query": "q"})).unwrap();
        assert_eq!((old.limit, old.offset), (None, None));
        for (kind, owner) in [
            (EffectKind::ScmAmend, Owner::Scm),
            (EffectKind::ScmBranches, Owner::Scm),
            (EffectKind::ScmDiffCommit, Owner::Scm),
            (EffectKind::ScmShowRevision, Owner::Scm),
            (EffectKind::DocumentRevert, Owner::Documents),
            (EffectKind::DocumentSettle, Owner::Documents),
            (EffectKind::DocumentKeep, Owner::Documents),
            (EffectKind::DocumentHistoryList, Owner::Documents),
            (EffectKind::DocumentHistoryPreview, Owner::Documents),
            (EffectKind::DocumentHistoryRestore, Owner::Documents),
            (EffectKind::DelegationChanges, Owner::Delegations),
            (EffectKind::DelegationContent, Owner::Delegations),
            (EffectKind::ConversationSideChat, Owner::Conversation),
            (EffectKind::ConversationSideList, Owner::Conversation),
            (EffectKind::ConversationAttachPick, Owner::Conversation),
            (EffectKind::ConversationAttachRemove, Owner::Conversation),
            (EffectKind::ConversationModels, Owner::Conversation),
            (EffectKind::ConversationSetModel, Owner::Conversation),
            (EffectKind::ConversationSetEffort, Owner::Conversation),
            (EffectKind::ScmConflict, Owner::Scm),
            (EffectKind::ScmResolve, Owner::Scm),
            (EffectKind::ConversationSideClose, Owner::Conversation),
        ] {
            assert_eq!(kind.owner(), owner);
        }
    }

    #[test]
    fn unit_wire_order_effects_carry_no_payload() {
        for (body, kind) in [
            (EffectBody::ScmBranches, "scmBranches"),
            (EffectBody::DocumentRevert, "documentRevert"),
            (EffectBody::DocumentHistoryList, "documentHistoryList"),
            (EffectBody::ConversationSideClose, "conversationSideClose"),
            (EffectBody::ConversationSideList, "conversationSideList"),
            (EffectBody::ConversationAttachPick, "conversationAttachPick"),
            (EffectBody::ConversationModels, "conversationModels"),
        ] {
            let v = serde_json::to_value(Effect::new(EffectId(1), ResourceRef::None, body.clone()))
                .unwrap();
            assert_eq!(v["kind"], kind);
            let back: Effect = serde_json::from_value(v).unwrap();
            assert_eq!(back.body, body);
        }
    }

    #[test]
    fn every_kind_has_one_owner() {
        // Detach and End are distinct kinds in the terminal group (R29).
        assert_eq!(EffectKind::TerminalDetach.owner(), Owner::Terminal);
        assert_eq!(EffectKind::TerminalEnd.owner(), Owner::Terminal);
        assert_ne!(EffectKind::TerminalDetach, EffectKind::TerminalEnd);
        assert_eq!(EffectKind::ClipboardWrite.owner(), Owner::Host);
        assert_eq!(EffectKind::LayoutSave.owner(), Owner::Layout);
        for kind in [
            EffectKind::ConversationRetry,
            EffectKind::ConversationEdit,
            EffectKind::ConversationSwitch,
            EffectKind::ConversationSwitchBranch,
            EffectKind::ConversationCancel,
        ] {
            assert_eq!(kind.owner(), Owner::Conversation);
        }
    }
}
