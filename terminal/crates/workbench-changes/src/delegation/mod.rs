//! What a run's delegation changed: the files it touched, and each file's before and
//! after, read only.
//!
//! The old IDE showed, for a run's delegation, the files it changed and a before/after
//! diff for each. This is that, in the Changes panel's visual language: the same line
//! diff and changed-word marks (`crate::diff`), the same theme roles, and the same
//! unified layout, except that a line is wrapped at the pane's edge and never cut.
//!
//! The panel kind is `"delegation"`. It opens for `OpenTarget::Delegation`: on a whole
//! delegation (an empty path) it lists the changed files; on one path it shows that file
//! directly. A conversation that lists a run's delegations opens it with
//! `cx.open(OpenTarget::Delegation { run_id, delegation_id, path })`.
//!
//! Nothing here can change anything. The two effects it emits are reads, and its actions
//! are reads, movement and a way back.

mod model;
mod panel;
mod view;

pub use model::{MAX_LINE_CHARS, MAX_LISTED, MAX_SIDE_BYTES, MAX_SIDE_LINES};
pub use panel::{DelegationPanel, KIND, register};

use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::ids::{Capability, PanelKind, ResourceKind};
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent::Start, BodyKind, CellSize, PanelDescriptor, Placement,
};
use theorem_workbench_core::semantics::Role;

/// The actions the panel registers, by id. Each is delivered to it as
/// `PanelMsg::Action`.
pub mod actions {
    pub const REFRESH: &str = "delegation.refresh";
    pub const OPEN: &str = "delegation.open";
    pub const BACK: &str = "delegation.back";
    pub const NEXT: &str = "delegation.next";
    pub const PREVIOUS: &str = "delegation.previous";
}

/// The registry entry for the panel kind. It binds to a delegation, has no picker row
/// (it opens for a delegation a person or the conversation names, never from the
/// picker), and needs no capability of the host beyond the owner answering its reads.
pub fn descriptor() -> PanelDescriptor {
    use EffectKind::{DelegationChanges, DelegationContent};
    PanelDescriptor {
        kind: PanelKind::new(KIND),
        version: 1,
        title: "Delegation changes".to_owned(),
        icon: "git-branch".to_owned(),
        body: BodyKind::Drawn,
        binding: ResourceKind::Delegation,
        actions: vec![
            ActionDescriptor::new(
                actions::REFRESH,
                "Read the delegation's changes again",
                Start,
            )
            .emits(DelegationChanges)
            .emits(DelegationContent),
            ActionDescriptor::new(
                actions::OPEN,
                "Show the before and after of the selected file",
                Start,
            )
            .emits(DelegationContent),
            ActionDescriptor::local(actions::BACK, "Go back to the list of changed files"),
            ActionDescriptor::local(actions::NEXT, "Move to the next file, or scroll down"),
            ActionDescriptor::local(actions::PREVIOUS, "Move to the previous file, or scroll up"),
        ],
        requires: Vec::<Capability>::new(),
        min_size: CellSize { cols: 24, rows: 6 },
        default_placement: Placement::Tools,
        theme_roles: [
            "chrome.bg",
            "chrome.text",
            "diff.addedLine",
            "diff.removedLine",
            "diff.addedWords",
            "diff.removedWords",
        ]
        .iter()
        .map(|r| (*r).to_owned())
        .collect(),
        semantic_role: Role::Region,
    }
}
