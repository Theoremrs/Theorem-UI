//! The registry entries for the panel's workflows.
//!
//! Written for this crate; not translated. The core's `builtin::registry()` knows the
//! "changes" kind and its `changes.open` row, and nothing else of it, because the registry
//! is data and the core does not depend on this crate. These are the rest: every workflow
//! the panel can ask the SCM owner for, as an action the registry resolves for a person
//! or the agent. An action that starts work is `Start`, `Create` or `Destroy` and names
//! the effect it produces; the core delivers it to the panel as `PanelMsg::Action`, and
//! the panel decides (a discard asks first; a branch name is asked for in a prompt). The
//! `changes.confirm` action answers that question and is `human_only`, so an agent can
//! ask for a discard and never approve one.

use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::registry::{
    ActionDescriptor,
    ActionIntent::{Create, Destroy, Start},
    PanelDescriptor, Registry, RegistryError,
};

use crate::semantics::actions as id;

const CAPABILITY: &str = "scm";
/// What the host advertises when its owner can amend.
pub const AMEND_CAPABILITY: &str = "scm.commit.amend";

fn start(id: &str, title: &str, emits: EffectKind) -> ActionDescriptor {
    ActionDescriptor::new(id, title, Start)
        .requires(CAPABILITY)
        .emits(emits)
}

/// The workflow actions of the "changes" panel kind.
pub fn descriptors() -> Vec<ActionDescriptor> {
    use EffectKind::*;
    vec![
        start(id::REFRESH, "Refresh changes", ScmStatus),
        start(id::DIFF, "Show the diff of the selected file", ScmDiff),
        start(id::STAGE, "Stage the selected files", ScmStage),
        start(id::UNSTAGE, "Unstage the selected files", ScmUnstage),
        start(id::STAGE_ALL, "Stage all changes", ScmStage),
        start(id::UNSTAGE_ALL, "Unstage all changes", ScmUnstage),
        // Asks first; nothing is discarded until `changes.confirm`.
        ActionDescriptor::new(id::DISCARD, "Discard the selected changes", Destroy)
            .requires(CAPABILITY)
            .emits(ScmDiscard),
        ActionDescriptor::new(id::CONFIRM, "Confirm the discard", Destroy)
            .requires(CAPABILITY)
            .emits(ScmDiscard)
            .human_only(),
        start(
            id::RESTORE,
            "Bring back the last discarded change",
            ScmRestore,
        ),
        start(id::COMMIT, "Commit what is staged", ScmCommit),
        start(id::COMMIT_ALL, "Stage all changes and commit", ScmStage),
        // The host must offer `scm.commit.amend`; the registry says so when it does not.
        start(id::AMEND, "Amend the last commit", ScmAmend).requires(AMEND_CAPABILITY),
        start(id::LOG, "Read the recent commits", ScmLog),
        start(id::HISTORY, "Show the history of the selected file", ScmLog),
        start(
            id::OPEN_COMMIT,
            "Show the diff of the commit under the cursor",
            ScmDiffCommit,
        ),
        start(
            id::SHOW_AT_COMMIT,
            "Show the file as the commit in its history had it",
            ScmShowRevision,
        ),
        start(
            id::BLAME,
            "Show who changed each line of the selected file",
            ScmBlame,
        ),
        start(
            id::SHOW_HEAD,
            "Show the selected file as HEAD has it",
            ScmShow,
        ),
        start(
            id::SHOW_INDEX,
            "Show the selected file as the index has it",
            ScmShow,
        ),
        start(id::FETCH, "Fetch from the remote", ScmFetch),
        start(id::PUSH, "Push to the remote", ScmPush),
        // These three ask for the branch name in a prompt, which lists the branches the
        // owner reports (`scmBranches`) as the name is typed.
        start(id::SWITCH_BRANCH, "Switch branch", ScmBranch),
        ActionDescriptor::new(id::CREATE_BRANCH, "Create a branch", Create)
            .requires(CAPABILITY)
            .emits(ScmBranch),
        start(id::MERGE, "Merge a branch into this one", ScmMerge),
    ]
}

/// `registry` with the panel's workflow actions added to its "changes" kind. The builtin
/// registry cannot list them itself, so the mount builds its registry through this.
pub fn with_actions(registry: Registry) -> Result<Registry, RegistryError> {
    let mut out = Registry::new();
    for panel in registry.panels() {
        let mut panel: PanelDescriptor = panel.clone();
        if panel.kind.as_str() == "changes" {
            panel.actions.extend(descriptors());
        }
        out.register(panel)?;
    }
    Ok(out)
}
