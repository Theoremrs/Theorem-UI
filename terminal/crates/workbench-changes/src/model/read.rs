//! Read-only views of one file (blame, a version of it, its history), the small prompt that
//! asks for a branch name, and where the text caret is drawn.
//!
//! Written for this crate; not translated. The donor has no blame, show or merge and
//! switches branches from a menu. Here each is one request against the wire's effects
//! (`scmBlame`, `scmShow`, `scmLog` with a path, `scmMerge`, `scmBranch`), and the owner's
//! answer is shown as it came: the lines, its refusal, or "unknown result".

use theorem_workbench_core::completion::{BlameHunk, CompletionPayload, LogEntry, Outcome};
use theorem_workbench_core::effect::ScmRef;

use super::{ActionKind, Changes, Intent, IntentId, IntentKind, Mode, Pending, Problem, Refusal};

/// What the read view shows of the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadKind {
    Blame,
    /// The file as HEAD or as the index holds it.
    Show(ScmRef),
    History,
}

impl ReadKind {
    pub fn action(self) -> ActionKind {
        match self {
            Self::Blame => ActionKind::Blame,
            Self::Show(_) => ActionKind::Show,
            Self::History => ActionKind::History,
        }
    }

    /// The view's heading, for a path.
    pub fn title(self, path: &str) -> String {
        match self {
            Self::Blame => format!("Blame: {path}"),
            Self::Show(ScmRef::Head) => format!("{path} at HEAD"),
            Self::Show(ScmRef::Index) => format!("{path} in the index"),
            Self::History => format!("History: {path}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadBody {
    Loading,
    Blame(Vec<BlameHunk>),
    /// `exists` is false when the file has no such version (not in HEAD, not in the index).
    Text {
        exists: bool,
        text: String,
    },
    History(Vec<LogEntry>),
    /// The owner's refusal, an unknown result, or a failure, as it said it.
    Problem(Problem),
    /// The answer was for a repository state that has been left; nothing was kept.
    Outdated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadView {
    pub path: String,
    pub kind: ReadKind,
    pub body: ReadBody,
    pub scroll: usize,
    pub(crate) request: IntentId,
}

/// What the branch prompt asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptKind {
    Switch,
    Create,
    Merge,
}

impl PromptKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Switch => "Switch to branch",
            Self::Create => "New branch",
            Self::Merge => "Merge branch",
        }
    }

    pub fn action(self) -> ActionKind {
        match self {
            Self::Switch => ActionKind::SwitchBranch,
            Self::Create => ActionKind::CreateBranch,
            Self::Merge => ActionKind::Merge,
        }
    }
}

/// The prompt on the branch line. The text is the panel's text buffer, mirrored here so
/// the model can draw it and decide on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub kind: PromptKind,
    pub text: String,
}

/// Which text field a caret is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Subject,
    Body,
    Prompt,
}

/// Where the caret is drawn: a field, a line of it and a column in characters. Display
/// only; the panel's text buffer owns the editing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caret {
    pub field: Field,
    pub row: usize,
    pub col: usize,
}

impl Changes {
    // ---- read views --------------------------------------------------------

    pub fn read_view(&self) -> Option<&ReadView> {
        self.read.as_ref()
    }

    /// Asks who last changed each line of the cursor file.
    pub fn blame(&mut self) -> Result<Intent, Refusal> {
        self.open_read(ReadKind::Blame)
    }

    /// Asks for the cursor file as HEAD or the index holds it.
    pub fn show(&mut self, reference: ScmRef) -> Result<Intent, Refusal> {
        self.open_read(ReadKind::Show(reference))
    }

    /// Asks for the commits that changed the cursor file.
    pub fn history(&mut self) -> Result<Intent, Refusal> {
        self.open_read(ReadKind::History)
    }

    fn open_read(&mut self, kind: ReadKind) -> Result<Intent, Refusal> {
        let action = kind.action();
        self.loaded(action)?;
        let Some(path) = self.cursor.as_ref().map(|k| k.path.clone()) else {
            return self.refuse(action, Refusal::Nothing("read"));
        };
        let intent_kind = match kind {
            ReadKind::Blame => IntentKind::Blame { path: path.clone() },
            ReadKind::Show(reference) => IntentKind::Show {
                path: path.clone(),
                reference,
            },
            ReadKind::History => IntentKind::History { path: path.clone() },
        };
        let pending = Pending {
            action,
            generation: 0,
            subject: Some(path.clone()),
            key: None,
            sent: None,
            then_commit: None,
        };
        let intent = self.issue(intent_kind, pending);
        self.read = Some(ReadView {
            path,
            kind,
            body: ReadBody::Loading,
            scroll: 0,
            request: intent.id,
        });
        self.mode = Mode::Read;
        Ok(intent)
    }

    /// Leaves the read view for the list.
    pub fn close_read(&mut self) {
        self.read = None;
        if self.mode == Mode::Read {
            self.mode = Mode::Changes;
        }
    }

    pub(super) fn read_done(
        &mut self,
        id: IntentId,
        pending: &Pending,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) {
        let current = self.read.as_ref().map(|r| r.request) == Some(id);
        if !current {
            // Closed, or asked for again since: this answer no longer applies.
            self.counters.stale_dropped += 1;
            return;
        }
        if self.older(pending) {
            if let Some(read) = &mut self.read {
                read.body = ReadBody::Outdated;
            }
            return;
        }
        let kind = self.read.as_ref().map(|r| r.kind).expect("current");
        let body = match (outcome, payload, kind) {
            (Outcome::Accepted, Some(CompletionPayload::ScmBlame(answer)), ReadKind::Blame) => {
                ReadBody::Blame(answer.hunks.clone())
            }
            (Outcome::Accepted, Some(CompletionPayload::ScmShow(answer)), ReadKind::Show(_)) => {
                ReadBody::Text {
                    exists: answer.exists,
                    text: answer.text.clone(),
                }
            }
            (Outcome::Accepted, Some(CompletionPayload::ScmLog(answer)), ReadKind::History) => {
                ReadBody::History(answer.commits.clone())
            }
            (Outcome::Accepted, _, _) => ReadBody::Problem(Problem::Failed {
                reason: "the owner's answer was not the one asked for".into(),
            }),
            (other, _, _) => ReadBody::Problem(Problem::of(other).expect("not accepted")),
        };
        if let Some(read) = &mut self.read {
            read.body = body;
            read.scroll = 0;
        }
    }

    // ---- the branch prompt -------------------------------------------------

    pub fn prompt(&self) -> Option<&Prompt> {
        self.prompt.as_ref()
    }

    /// Opens the prompt for a branch name. A switch, a new branch and a merge change the
    /// repository, so a refusal to start (nothing read, one running, an unknown result)
    /// is given now and the prompt does not open.
    pub fn open_prompt(&mut self, kind: PromptKind) -> Result<(), Refusal> {
        self.may_mutate(kind.action())?;
        self.prompt = Some(Prompt {
            kind,
            text: String::new(),
        });
        Ok(())
    }

    pub fn set_prompt_text(&mut self, text: impl Into<String>) {
        if let Some(prompt) = &mut self.prompt {
            prompt.text = text.into();
        }
    }

    pub fn cancel_prompt(&mut self) {
        self.prompt = None;
        if matches!(
            self.caret,
            Some(Caret {
                field: Field::Prompt,
                ..
            })
        ) {
            self.caret = None;
        }
    }

    /// Asks for what the prompt holds. A refusal leaves the prompt open.
    pub fn submit_prompt(&mut self) -> Result<Intent, Refusal> {
        let Some(prompt) = self.prompt.clone() else {
            return self.refuse(ActionKind::SwitchBranch, Refusal::EmptyBranchName);
        };
        let name = prompt.text.trim().to_owned();
        let intent = match prompt.kind {
            PromptKind::Switch => self.switch_branch(&name),
            PromptKind::Create => self.create_branch(&name),
            PromptKind::Merge => self.merge(&name),
        }?;
        self.cancel_prompt();
        Ok(intent)
    }

    /// Merges the named branch into the current one.
    pub fn merge(&mut self, branch: &str) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Merge)?;
        if branch.trim().is_empty() {
            return self.refuse(ActionKind::Merge, Refusal::EmptyBranchName);
        }
        let pending = Pending {
            action: ActionKind::Merge,
            generation: 0,
            subject: Some(branch.to_owned()),
            key: None,
            sent: None,
            then_commit: None,
        };
        Ok(self.issue(
            IntentKind::Merge {
                branch: branch.to_owned(),
            },
            pending,
        ))
    }

    // ---- the caret ---------------------------------------------------------

    /// Where the caret is, so the draw can show it. `None` hides it.
    pub fn set_caret(&mut self, caret: Option<Caret>) {
        self.caret = caret;
    }

    pub fn caret(&self) -> Option<Caret> {
        self.caret
    }
}
