//! Identities that cross the wasm boundary: effect ids, panel instances,
//! the resource a panel is bound to, revisions and generations.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

/// A string identity that means nothing beyond equality.
macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS))]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

pub(crate) use string_id;

string_id!(
    /// A panel view's identity, stable across moves between regions and tabs.
    /// The dock mints it; the core only compares it.
    PanelInstanceId
);
string_id!(
    /// A registered panel kind, such as `files` or `shell`.
    PanelKind
);
string_id!(
    /// A registered action, such as `shell.start`. Humans, shortcuts, the
    /// palette and the agent all name an action by this id.
    ActionId
);
string_id!(
    /// A capability the host reports, such as `scm` or `terminal.herdr`.
    Capability
);

/// Names one effect from emission to completion. A retry of the same logical
/// operation reuses the id, so an owner that deduplicates can recognise it.
/// JavaScript numbers are exact to 2^53, far beyond one session's count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct EffectId(#[cfg_attr(feature = "ts", ts(type = "number"))] pub u64);

/// Hands out effect ids in order.
#[derive(Debug, Default)]
pub struct EffectIds {
    next: u64,
}

impl EffectIds {
    pub fn mint(&mut self) -> EffectId {
        self.next += 1;
        EffectId(self.next)
    }
}

/// What a panel is bound to. Two refs are the same resource only when every
/// field matches, so a rebinding changes the ref and strands old completions.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResourceRef {
    /// No resource: clipboard and other host-only effects.
    None,
    Workspace {
        workspace: String,
    },
    /// A document in a workspace, by the owner's resource id (its path).
    Document {
        workspace: String,
        resource_id: String,
    },
    /// A repository inside a workspace, by its root path.
    Repository {
        workspace: String,
        repository: String,
    },
    /// A terminal session on the workspace host (`pty-...` or `hc-...`).
    Terminal {
        workspace: String,
        session: String,
    },
    Conversation {
        project: String,
        thread: String,
    },
    Project {
        project: String,
    },
    /// A directory of a workspace, by its path (no trailing slash; the
    /// workspace root is the empty path).
    Directory {
        workspace: String,
        path: String,
    },
    /// A commit's diff in a repository, as the history rows open it.
    Commit {
        workspace: String,
        repository: String,
        commit: String,
    },
    /// A file as it was at a revision (read only).
    Revision {
        workspace: String,
        repository: String,
        commit: String,
        path: String,
    },
    /// A new document that has no path yet, named by the id its opener minted.
    Untitled {
        workspace: String,
        id: String,
    },
}

/// The kind of resource a panel kind binds to, without the ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    None,
    Workspace,
    Document,
    Repository,
    Terminal,
    Conversation,
    Project,
    Directory,
    Commit,
    Revision,
    Untitled,
}

impl ResourceRef {
    pub fn kind(&self) -> ResourceKind {
        match self {
            Self::None => ResourceKind::None,
            Self::Workspace { .. } => ResourceKind::Workspace,
            Self::Document { .. } => ResourceKind::Document,
            Self::Repository { .. } => ResourceKind::Repository,
            Self::Terminal { .. } => ResourceKind::Terminal,
            Self::Conversation { .. } => ResourceKind::Conversation,
            Self::Project { .. } => ResourceKind::Project,
            Self::Directory { .. } => ResourceKind::Directory,
            Self::Commit { .. } => ResourceKind::Commit,
            Self::Revision { .. } => ResourceKind::Revision,
            Self::Untitled { .. } => ResourceKind::Untitled,
        }
    }
}

/// A resource's version as its owner reports it. Equality always works; order
/// exists only between two `Seq` values, because an opaque token (an artifact
/// revision, an `If-Match` etag) has no order the workbench may assume.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "scheme", content = "value", rename_all = "camelCase")]
pub enum Revision {
    Seq(#[cfg_attr(feature = "ts", ts(type = "number"))] u64),
    Opaque(String),
}

impl Revision {
    /// `Some` only when the owner defines an order between the two.
    pub fn order(&self, other: &Self) -> Option<Ordering> {
        match (self, other) {
            (Self::Seq(a), Self::Seq(b)) => Some(a.cmp(b)),
            (Self::Opaque(a), Self::Opaque(b)) if a == b => Some(Ordering::Equal),
            _ => None,
        }
    }
}

/// A binding generation: a pane's rebinding, or a terminal's binding epoch.
/// It only ever goes up, so an older one marks a stale effect.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Generation(#[cfg_attr(feature = "ts", ts(type = "number"))] pub u64);

impl Generation {
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

/// The workspace and environment the workbench is about, as the host last said
/// (`HostMessage::WorkspaceChanged`). `generation` goes up with every change of
/// either, so a workspace-bound panel binds with it and a listing of the old
/// workspace is dropped as stale. Before the host says anything the workspace is
/// empty and the generation 0.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceIdentity {
    /// The account the host is signed in as. Empty until it says.
    pub account: String,
    pub workspace: String,
    pub environment: Option<String>,
    pub generation: Generation,
}

impl WorkspaceIdentity {
    /// Whether the host has named a workspace yet.
    pub fn is_set(&self) -> bool {
        !self.workspace.is_empty()
    }
}

/// Who asked for an operation. A model-origin request never carries a human's
/// approval, whatever action id it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Actor {
    Human,
    Agent { run_id: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_revisions_have_no_order_unless_equal() {
        let a = Revision::Opaque("a".into());
        let b = Revision::Opaque("b".into());
        assert_eq!(a.order(&a.clone()), Some(Ordering::Equal));
        assert_eq!(a.order(&b), None);
        assert_eq!(
            Revision::Seq(2).order(&Revision::Seq(5)),
            Some(Ordering::Less)
        );
        assert_eq!(Revision::Seq(2).order(&a), None);
    }

    #[test]
    fn rebinding_changes_the_resource_ref() {
        let one = ResourceRef::Document {
            workspace: "w".into(),
            resource_id: "a.md".into(),
        };
        let two = ResourceRef::Document {
            workspace: "w".into(),
            resource_id: "b.md".into(),
        };
        assert_ne!(one, two);
        assert_eq!(one.kind(), ResourceKind::Document);
    }

    #[test]
    fn effect_ids_are_distinct_and_rise() {
        let mut ids = EffectIds::default();
        let (a, b) = (ids.mint(), ids.mint());
        assert!(a < b);
    }
}
