//! What the model asks the owner for, and why it may refuse to ask.
//!
//! Written for this crate; not translated. The donor calls `git` from its panel (`act`
//! and the functions it passes); here a user action returns a value describing the
//! request, tagged with the repository generation it was decided against, and the host
//! performs it through the SCM owner.

use serde::{Deserialize, Serialize};
use theorem_workbench_core::effect::{
    EffectBody, FilesPath, ScmBranch, ScmCommit, ScmDiff, ScmLog, ScmPaths, ScmPush, ScmRemote,
    ScmRestore,
};

/// Names one request from the user's action to its result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct IntentId(pub u64);

/// A request for the owner, decided against `generation` of the repository state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intent {
    pub id: IntentId,
    pub generation: u64,
    pub kind: IntentKind,
}

/// The requests the Changes panel makes. One for each call the SCM owner (`scm.ts`)
/// answers that this panel uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IntentKind {
    Status,
    /// One file's diff: the working tree against the index, or (`staged`) the index
    /// against HEAD.
    Diff {
        path: String,
        staged: bool,
    },
    Log {
        max_count: u32,
    },
    Branches,
    Stage {
        paths: Vec<String>,
    },
    Unstage {
        paths: Vec<String>,
    },
    Discard {
        path: String,
    },
    Restore {
        restore_id: String,
    },
    Commit {
        message: String,
        amend: bool,
    },
    SwitchBranch {
        name: String,
    },
    CreateBranch {
        name: String,
    },
    Fetch,
    Push,
}

/// An action as the panel tells it apart: the key of in-flight state and of a notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Status,
    Diff,
    Log,
    Branches,
    Stage,
    Unstage,
    Discard,
    Restore,
    Commit,
    SwitchBranch,
    CreateBranch,
    Fetch,
    Push,
}

impl ActionKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Diff => "diff",
            Self::Log => "log",
            Self::Branches => "branch list",
            Self::Stage => "stage",
            Self::Unstage => "unstage",
            Self::Discard => "discard",
            Self::Restore => "restore",
            Self::Commit => "commit",
            Self::SwitchBranch => "branch switch",
            Self::CreateBranch => "branch create",
            Self::Fetch => "fetch",
            Self::Push => "push",
        }
    }

    /// Whether the action changes the repository. A mutation is never retried by the
    /// model, and one that ends `uncertain` blocks the next until the state is read.
    pub fn mutates(self) -> bool {
        !matches!(self, Self::Status | Self::Diff | Self::Log | Self::Branches)
    }
}

/// A request the effect bodies of the wire cannot carry today.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    /// `ScmCommit` has only `message`; the owner's `scm.commit` takes `amend`.
    Amend,
    /// The wire has no effect that asks for the branch list, though it has the answer's
    /// payload (`ScmBranches`).
    BranchList,
}

impl IntentKind {
    pub fn action(&self) -> ActionKind {
        match self {
            Self::Status => ActionKind::Status,
            Self::Diff { .. } => ActionKind::Diff,
            Self::Log { .. } => ActionKind::Log,
            Self::Branches => ActionKind::Branches,
            Self::Stage { .. } => ActionKind::Stage,
            Self::Unstage { .. } => ActionKind::Unstage,
            Self::Discard { .. } => ActionKind::Discard,
            Self::Restore { .. } => ActionKind::Restore,
            Self::Commit { .. } => ActionKind::Commit,
            Self::SwitchBranch { .. } => ActionKind::SwitchBranch,
            Self::CreateBranch { .. } => ActionKind::CreateBranch,
            Self::Fetch => ActionKind::Fetch,
            Self::Push => ActionKind::Push,
        }
    }

    /// The effect body that carries this request. A commit that amends has none: the
    /// wire's `ScmCommit` has no `amend` field yet, and an amend sent as a plain commit
    /// would make a second commit.
    pub fn effect_body(&self) -> Result<EffectBody, Unsupported> {
        Ok(match self {
            Self::Status => EffectBody::ScmStatus,
            Self::Diff { path, staged } => EffectBody::ScmDiff(ScmDiff {
                path: Some(path.clone()),
                staged: *staged,
            }),
            Self::Log { max_count } => EffectBody::ScmLog(ScmLog {
                path: None,
                max_count: *max_count,
            }),
            Self::Branches => return Err(Unsupported::BranchList),
            Self::Stage { paths } => EffectBody::ScmStage(ScmPaths {
                paths: paths.clone(),
            }),
            Self::Unstage { paths } => EffectBody::ScmUnstage(ScmPaths {
                paths: paths.clone(),
            }),
            Self::Discard { path } => EffectBody::ScmDiscard(FilesPath { path: path.clone() }),
            Self::Restore { restore_id } => EffectBody::ScmRestore(ScmRestore {
                restore_id: restore_id.clone(),
            }),
            Self::Commit { amend: true, .. } => return Err(Unsupported::Amend),
            Self::Commit { message, .. } => EffectBody::ScmCommit(ScmCommit {
                message: message.clone(),
            }),
            Self::SwitchBranch { name } => EffectBody::ScmBranch(ScmBranch {
                name: name.clone(),
                create: false,
            }),
            Self::CreateBranch { name } => EffectBody::ScmBranch(ScmBranch {
                name: name.clone(),
                create: true,
            }),
            Self::Fetch => EffectBody::ScmFetch(ScmRemote { remote: None }),
            Self::Push => EffectBody::ScmPush(ScmPush {
                remote: None,
                reference: None,
            }),
        })
    }
}

/// Why a user action produced no request. Each has a code a person can read in the
/// notice, in the owner's style (`empty_message`, `no_paths`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No status has been read yet.
    NotLoaded,
    /// A repository-changing action is still running.
    Busy(ActionKind),
    /// An earlier action ended with an unknown result and the state has not been read
    /// since.
    Reconcile(ActionKind),
    /// The selection holds nothing the action applies to.
    Nothing(&'static str),
    EmptyMessage,
    NothingStaged,
    /// The host does not offer `scm.commit.amend`.
    AmendUnavailable,
    EmptyBranchName,
    NoRestorePoint,
    /// `confirm` with nothing waiting to be confirmed.
    NothingToConfirm,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotLoaded => "not_loaded",
            Self::Busy(_) => "busy",
            Self::Reconcile(_) => "reconcile_first",
            Self::Nothing(_) => "no_paths",
            Self::EmptyMessage => "empty_message",
            Self::NothingStaged => "nothing_staged",
            Self::AmendUnavailable => "missing_capability",
            Self::EmptyBranchName => "empty_branch",
            Self::NoRestorePoint => "no_restore_id",
            Self::NothingToConfirm => "nothing_to_confirm",
        }
    }

    pub fn reason(&self) -> String {
        match self {
            Self::NotLoaded => "The repository has not been read yet".into(),
            Self::Busy(action) => format!("A {} is still running", action.label()),
            Self::Reconcile(action) => format!(
                "The result of the earlier {} is unknown. Refresh and check the state before trying again",
                action.label()
            ),
            Self::Nothing(what) => format!("Nothing selected can be {what}"),
            Self::EmptyMessage => "Write a commit message first".into(),
            Self::NothingStaged => "There are no changes to commit".into(),
            Self::AmendUnavailable => "This host does not offer amend".into(),
            Self::EmptyBranchName => "A branch needs a name".into(),
            Self::NoRestorePoint => "There is no discarded change to restore".into(),
            Self::NothingToConfirm => "There is nothing waiting to be confirmed".into(),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.reason())
    }
}
