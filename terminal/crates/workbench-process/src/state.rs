//! The pane's stages and the small types they share.

use theorem_workbench_core::effect::TerminalBackend;
use theorem_workbench_core::ids::EffectId;

use crate::bound::{Bound, Want};

/// A profile row, copied at the moment it was chosen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Choice {
    pub id: String,
    pub label: String,
    pub backend: TerminalBackend,
    pub argv: Option<Vec<String>>,
}

/// What a failed stage can be tried again as, by a person's explicit choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Intent {
    Open(Choice),
    Attach {
        session: String,
        backend: TerminalBackend,
        want: Want,
    },
}

/// An open in flight. Its answer is the only thing that says whether a
/// process started, so an unknown one stays unknown.
pub(crate) struct Opening {
    pub choice: Choice,
    pub effect: EffectId,
    pub uncertain: Option<String>,
    /// The program this one follows, named so it is never read as continuation.
    pub follows: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    Unavailable,
    NotFound,
    Refused,
    Failed,
}

pub(crate) struct Failure {
    pub kind: FailureKind,
    pub reason: String,
    pub code: Option<String>,
    pub intent: Intent,
}

/// A saved binding waiting for the first call that may start work.
#[derive(Clone, Debug)]
pub(crate) struct Saved {
    pub workspace: String,
    pub session: String,
    pub backend: TerminalBackend,
}

pub(crate) enum Stage {
    Choosing,
    Restoring(Saved),
    Opening(Opening),
    Bound(Box<Bound>),
    Failed(Failure),
}
