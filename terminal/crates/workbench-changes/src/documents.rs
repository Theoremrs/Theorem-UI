//! What the editor holds that Git does not, and what the panel says it did.
//!
//! Written for this crate; not translated. Staging and committing act on the saved
//! file, never on a draft the editor has not saved. The host tells the panel which
//! documents are open (see [`OpenDocument`]); the panel marks the rows whose file has
//! an unsaved draft, says at the action that the draft is not included, and keeps a
//! [`Receipt`] naming what was staged or committed. The panel never holds a draft's
//! text, so no effect or receipt can carry it.

use theorem_workbench_core::completion::RepoState;

use crate::intent::{ActionKind, IntentId};
use crate::status::shown;

/// A document open in the editor, by workspace path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenDocument {
    pub path: String,
    /// The revision the owner last saved, when it has said.
    pub saved_revision: Option<u64>,
    /// The editor holds changes the owner has not saved.
    pub unsaved: bool,
}

/// Where the repository stood when an action was accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Landed {
    pub head: Option<String>,
    pub index_generation: Option<String>,
}

impl Landed {
    pub(crate) fn of(state: &RepoState) -> Self {
        Self {
            head: state.head.clone(),
            index_generation: state.index_generation.clone(),
        }
    }
}

/// What a stage, unstage or commit acted on: the files, each with the saved revision
/// the editor had for it, and the drafts that were not part of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub id: IntentId,
    pub action: ActionKind,
    pub paths: Vec<String>,
    /// The saved revision of each open document among `paths`.
    pub saved: Vec<(String, u64)>,
    /// The paths among `paths` whose editor had unsaved changes at the action.
    pub unsaved: Vec<String>,
    /// Set when the owner accepted the action; a receipt of an action that was not
    /// accepted is dropped, so nothing reads as done.
    pub landed: Option<Landed>,
}

const LISTED_PATHS: usize = 3;

fn list(paths: &[String]) -> String {
    let mut out: Vec<String> = paths.iter().take(LISTED_PATHS).map(|p| shown(p)).collect();
    if paths.len() > LISTED_PATHS {
        out.push(format!("{} more", paths.len() - LISTED_PATHS));
    }
    out.join(", ")
}

impl Receipt {
    /// The line that says what was done, or is being done.
    pub fn text(&self) -> String {
        let (doing, done) = match self.action {
            ActionKind::Stage => ("Staging", "Staged"),
            ActionKind::Unstage => ("Unstaging", "Unstaged"),
            ActionKind::Commit => ("Committing", "Committed"),
            _ => ("Working on", "Finished"),
        };
        let verb = if self.landed.is_some() { done } else { doing };
        let count = self.paths.len();
        let mut text = match (self.action, count) {
            (ActionKind::Commit, 0) => format!("{verb} the amended message"),
            (ActionKind::Commit, n) => format!(
                "{verb} {n} staged file{}: {}",
                if n == 1 { "" } else { "s" },
                self.files()
            ),
            (_, n) => format!(
                "{verb} {n} file{}: {}",
                if n == 1 { "" } else { "s" },
                self.files()
            ),
        };
        if let Some(landed) = &self.landed {
            if self.action == ActionKind::Commit
                && let Some(head) = &landed.head
            {
                text.push_str(&format!(". Head is now {}", &head[..head.len().min(10)]));
            } else if let Some(generation) = &landed.index_generation {
                text.push_str(&format!(". Index generation {generation}"));
            }
        }
        text.push('.');
        text
    }

    fn files(&self) -> String {
        let mut out = vec![];
        for path in self.paths.iter().take(LISTED_PATHS) {
            let saved = self.saved.iter().find(|(p, _)| p == path);
            out.push(match saved {
                Some((_, revision)) => format!("{} (saved revision {revision})", shown(path)),
                None => shown(path),
            });
        }
        if self.paths.len() > LISTED_PATHS {
            out.push(format!("{} more", self.paths.len() - LISTED_PATHS));
        }
        out.join(", ")
    }

    /// The line that says a draft is not part of it, when one was not.
    pub fn draft_text(&self) -> Option<String> {
        if self.unsaved.is_empty() {
            return None;
        }
        let many = self.unsaved.len() > 1;
        Some(format!(
            "Not included: the unsaved draft{} of {}. The saved file{} {} used.",
            if many { "s" } else { "" },
            list(&self.unsaved),
            if many { "s" } else { "" },
            if many { "are" } else { "is" },
        ))
    }
}
