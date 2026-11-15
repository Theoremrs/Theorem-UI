//! What comes back for an effect. Completion `payload` shapes are the ones the
//! inventory fixes today; an owner whose panel is not built yet answers with
//! just an outcome.

use serde::{Deserialize, Serialize};

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

/// Result data an accepted effect returns.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompletionPayload {
    Files(FileListing),
    FileStat(FileStat),
    Document(DocumentSnapshot),
    Scm(ScmStatus),
    Terminal(TerminalOpened),
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    /// `file`, `directory` or `missing`.
    #[serde(rename = "type")]
    pub kind: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub mtime_ms: u64,
    pub readonly: bool,
}

/// The authority's text and revision after an open, edit or save.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ScmChange {
    pub path: String,
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
}

/// The binding a terminal open or attach reports (`terminal-path.md` 2.1).
/// Binding epoch, program generation and the lease generation stay separate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub session: String,
    pub cols: u16,
    pub rows: u16,
    pub backend: crate::effect::TerminalBackend,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub epoch: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub program: u64,
    /// `host` or `herdr-core`.
    pub process_owned_by: String,
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

    #[test]
    fn uncertain_is_not_accepted() {
        let uncertain: Outcome =
            serde_json::from_value(json!({"status": "uncertain", "reason": "reply lost"})).unwrap();
        assert_ne!(uncertain, Outcome::Accepted);
    }
}
