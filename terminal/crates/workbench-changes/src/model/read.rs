//! Read-only views of one file (blame, a version of it, its history), the small prompt that
//! asks for a branch name, and where the text caret is drawn.
//!
//! Written for this crate; not translated. The donor has no blame, show or merge and
//! switches branches from a menu. Here each is one request against the wire's effects
//! (`scmBlame`, `scmShow`, `scmLog` with a path, `scmMerge`, `scmBranch`), and the owner's
//! answer is shown as it came: the lines, its refusal, or "unknown result".

use theorem_workbench_core::completion::{
    BlameHunk, BranchInfo, CompletionPayload, ConflictSides, LogEntry, Outcome,
};
use theorem_workbench_core::effect::ScmRef;

use crate::intent::Side;
use crate::status::Section;
use crate::text::Withheld;

use super::{
    ActionKind, Changes, Confirm, Focus, Intent, IntentId, IntentKind, LogState, Mode, Pending,
    Problem, Refusal, step,
};

/// What the read view shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadKind {
    Blame,
    /// The file as HEAD or as the index holds it.
    Show(ScmRef),
    History,
    /// One commit's diff, narrowed to the view's file when `narrowed`.
    Commit {
        commit: String,
        narrowed: bool,
    },
    /// The view's file as one commit holds it.
    Revision {
        commit: String,
    },
    /// The view's file as a merge left it: both sides, and the base when there is one.
    Conflict,
}

fn short(commit: &str) -> String {
    commit.chars().take(7).collect()
}

impl ReadKind {
    pub fn action(&self) -> ActionKind {
        match self {
            Self::Blame => ActionKind::Blame,
            Self::Show(_) => ActionKind::Show,
            Self::History => ActionKind::History,
            Self::Commit { .. } => ActionKind::CommitDiff,
            Self::Revision { .. } => ActionKind::ShowRevision,
            Self::Conflict => ActionKind::Conflict,
        }
    }

    /// The view's heading, for a path (the commit's, when it is not narrowed to one).
    pub fn title(&self, path: &str) -> String {
        match self {
            Self::Blame => format!("Blame: {path}"),
            Self::Show(ScmRef::Head) => format!("{path} at HEAD"),
            Self::Show(ScmRef::Index) => format!("{path} in the index"),
            Self::History => format!("History: {path}"),
            Self::Commit {
                commit,
                narrowed: true,
            } => format!("Commit {}: {path}", short(commit)),
            Self::Commit { commit, .. } => format!("Commit {}", short(commit)),
            Self::Revision { commit } => format!("{path} at {}", short(commit)),
            Self::Conflict => format!("Conflict: {path}"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum ReadBody {
    Loading,
    Blame(Vec<BlameHunk>),
    /// `exists` is false when the file has no such version (not in HEAD, not in the index).
    Text {
        exists: bool,
        text: String,
    },
    History(Vec<LogEntry>),
    /// The sides of a conflicted file, as the owner answered.
    Conflict(ConflictSides),
    /// The owner's refusal, an unknown result, or a failure, as it said it.
    Problem(Problem),
    /// The answer was for a repository state that has been left; nothing was kept.
    Outdated,
}

// What a file, a blame or a conflict holds is content: `Debug` says how much.
impl std::fmt::Debug for ReadBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Loading => f.write_str("Loading"),
            Self::Blame(hunks) => write!(f, "Blame({} hunks withheld)", hunks.len()),
            Self::Text { exists, text } => f
                .debug_struct("Text")
                .field("exists", exists)
                .field("text", &Withheld(text.len()))
                .finish(),
            Self::History(entries) => write!(f, "History({} commits withheld)", entries.len()),
            Self::Conflict(_) => f.write_str("Conflict(sides withheld)"),
            Self::Problem(problem) => f.debug_tuple("Problem").field(problem).finish(),
            Self::Outdated => f.write_str("Outdated"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadView {
    /// The file the view is about; empty for a whole commit opened from the log.
    pub path: String,
    pub kind: ReadKind,
    pub body: ReadBody,
    pub scroll: usize,
    /// The commit under the cursor in a history.
    pub cursor: usize,
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
    /// The person moved to a branch in the list: Enter takes it, not the typed text.
    pub picked: bool,
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

    /// Asks for the sides of the cursor file when it is conflicted.
    pub fn open_conflict(&mut self) -> Result<Intent, Refusal> {
        self.loaded(ActionKind::Conflict)?;
        if self.cursor.as_ref().map(|k| k.section) != Some(Section::Conflicted) {
            return self.refuse(ActionKind::Conflict, Refusal::NotInConflict);
        }
        self.open_read(ReadKind::Conflict)
    }

    /// The path of the conflict view, once the owner has said it is still in conflict.
    fn conflict_open(&self) -> Option<(&str, bool)> {
        let read = self.read.as_ref()?;
        match (&read.kind, &read.body) {
            (ReadKind::Conflict, ReadBody::Conflict(sides)) => {
                Some((read.path.as_str(), sides.conflict))
            }
            _ => None,
        }
    }

    /// The conflicted file the panel is about: the one in the open conflict view, else the
    /// one under the cursor when it is in the conflicted group.
    pub fn conflict_path(&self) -> Option<String> {
        if let Some(read) = &self.read {
            return (read.kind == ReadKind::Conflict).then(|| read.path.clone());
        }
        self.cursor
            .as_ref()
            .filter(|k| k.section == Section::Conflicted)
            .map(|k| k.path.clone())
    }

    /// Whether the open conflict is a binary file: its sides are not text, so only a whole
    /// side can be taken and merging by hand is not offered.
    pub fn conflict_binary(&self) -> bool {
        matches!(
            self.read.as_ref().map(|r| &r.body),
            Some(ReadBody::Conflict(sides)) if sides.binary
        )
    }

    /// Whether a conflict view is open (so the side keys apply).
    pub fn conflict_view(&self) -> bool {
        self.read
            .as_ref()
            .is_some_and(|r| r.kind == ReadKind::Conflict)
    }

    /// Asks to take one side of the open conflict whole. The question comes first
    /// (nothing is sent until [`confirm`](Self::confirm)): the other side's lines are
    /// lost. A file the owner no longer reports in conflict has nothing to take.
    pub fn take_side(&mut self, side: Side) -> Result<(), Refusal> {
        self.may_mutate(ActionKind::Resolve)?;
        let Some((path, true)) = self.conflict_open() else {
            return self.refuse(ActionKind::Resolve, Refusal::NotInConflict);
        };
        let path = path.to_owned();
        let binary = self.conflict_binary();
        self.confirm = Some(Confirm::Take { path, side, binary });
        Ok(())
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
        let intent_kind = match &kind {
            ReadKind::Blame => IntentKind::Blame { path: path.clone() },
            ReadKind::Show(reference) => IntentKind::Show {
                path: path.clone(),
                reference: *reference,
            },
            ReadKind::History => IntentKind::History { path: path.clone() },
            ReadKind::Conflict => IntentKind::Conflict { path: path.clone() },
            ReadKind::Commit { .. } | ReadKind::Revision { .. } => {
                unreachable!("a commit is opened from a log or history row")
            }
        };
        // A read of a file starts from the list: nothing is behind it.
        self.read_back.clear();
        Ok(self.start_read(path, kind, intent_kind))
    }

    fn start_read(&mut self, path: String, kind: ReadKind, intent_kind: IntentKind) -> Intent {
        let pending = Pending {
            action: kind.action(),
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
            cursor: 0,
            request: intent.id,
        });
        self.mode = Mode::Read;
        intent
    }

    /// The commit under the cursor of the log, or of an open file history.
    fn commit_under_cursor(&self) -> Option<String> {
        if let Some(read) = &self.read
            && let ReadBody::History(commits) = &read.body
        {
            return commits.get(read.cursor).map(|c| c.commit.clone());
        }
        match &self.log {
            LogState::Ready(entries) if self.focus == Focus::Log => {
                entries.get(self.log_cursor).map(|e| e.commit.clone())
            }
            _ => None,
        }
    }

    /// Whether Enter on the cursor would open a commit: a history is open, or the log has
    /// the keys.
    pub fn commit_row_open(&self) -> bool {
        self.commit_under_cursor().is_some()
    }

    /// Opens the commit under the cursor as its diff: the whole commit from the log, the
    /// commit's change to the file from a file's history. The view it was opened from is
    /// kept, so Escape comes back to it with its cursor.
    pub fn open_commit(&mut self) -> Result<Intent, Refusal> {
        self.loaded(ActionKind::CommitDiff)?;
        let Some(commit) = self.commit_under_cursor() else {
            return self.refuse(ActionKind::CommitDiff, Refusal::Nothing("shown"));
        };
        let from_history = matches!(self.read.as_ref().map(|r| &r.kind), Some(ReadKind::History));
        let path = if from_history {
            self.read.as_ref().map(|r| r.path.clone())
        } else {
            None
        };
        self.push_read();
        let kind = ReadKind::Commit {
            commit: commit.clone(),
            narrowed: path.is_some(),
        };
        let intent = IntentKind::CommitDiff {
            commit,
            path: path.clone(),
        };
        Ok(self.start_read(path.unwrap_or_default(), kind, intent))
    }

    /// From a file's history: the file as the commit under the cursor held it.
    pub fn show_at_commit(&mut self) -> Result<Intent, Refusal> {
        self.loaded(ActionKind::ShowRevision)?;
        let from_history = self
            .read
            .as_ref()
            .is_some_and(|r| r.kind == ReadKind::History && matches!(r.body, ReadBody::History(_)));
        let commit = self.commit_under_cursor().filter(|_| from_history);
        let (Some(commit), Some(path)) = (commit, self.read.as_ref().map(|r| r.path.clone()))
        else {
            return self.refuse(ActionKind::ShowRevision, Refusal::Nothing("shown"));
        };
        self.push_read();
        let kind = ReadKind::Revision {
            commit: commit.clone(),
        };
        let intent = IntentKind::ShowRevision {
            path: path.clone(),
            revision: commit,
        };
        Ok(self.start_read(path, kind, intent))
    }

    fn push_read(&mut self) {
        if let Some(read) = self.read.take() {
            self.read_back.push(read);
        }
    }

    /// Moves the cursor of an open history.
    pub fn move_read_cursor(&mut self, delta: isize) {
        let page = self.page();
        if let Some(read) = &mut self.read
            && let ReadBody::History(commits) = &read.body
        {
            let at = read.cursor as isize + delta;
            read.cursor = at.clamp(0, commits.len().saturating_sub(1) as isize) as usize;
            // The heading and the way back come first.
            let row = read.cursor + 2;
            if row < read.scroll {
                read.scroll = row;
            } else if row >= read.scroll + page {
                read.scroll = row + 1 - page;
            }
        }
    }

    /// Puts the history's cursor on a row (a click).
    pub fn select_commit(&mut self, index: usize) {
        if let Some(read) = &mut self.read
            && let ReadBody::History(commits) = &read.body
            && index < commits.len()
        {
            read.cursor = index;
        }
    }

    /// Leaves the read view: back to the view it was opened from, with its cursor, else
    /// to the list, where the log's cursor is where it was.
    pub fn close_read(&mut self) {
        self.read = self.read_back.pop();
        if self.read.is_none() && self.mode == Mode::Read {
            self.mode = Mode::Changes;
        }
    }

    /// Whether Escape would go back to an earlier read view rather than the list.
    pub fn read_has_back(&self) -> bool {
        !self.read_back.is_empty()
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
        let kind = self.read.as_ref().map(|r| r.kind.clone()).expect("current");
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
            (
                Outcome::Accepted,
                Some(CompletionPayload::ScmDiff(answer)),
                ReadKind::Commit { .. },
            ) => ReadBody::Text {
                exists: true,
                text: answer.text.clone(),
            },
            (
                Outcome::Accepted,
                Some(CompletionPayload::ScmShow(answer)),
                ReadKind::Revision { .. },
            ) => ReadBody::Text {
                exists: answer.exists,
                text: answer.text.clone(),
            },
            (Outcome::Accepted, Some(CompletionPayload::ScmLog(answer)), ReadKind::History) => {
                ReadBody::History(answer.commits.clone())
            }
            (
                Outcome::Accepted,
                Some(CompletionPayload::ScmConflict(sides)),
                ReadKind::Conflict,
            ) => ReadBody::Conflict(sides.clone()),
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

    /// Whether the person moved to an offered branch, so Enter takes it.
    pub fn prompt_picked(&self) -> bool {
        self.prompt.as_ref().is_some_and(|p| p.picked)
    }

    pub fn prompt(&self) -> Option<&Prompt> {
        self.prompt.as_ref()
    }

    /// Opens the prompt for a branch name. A switch, a new branch and a merge change the
    /// repository, so a refusal to start (nothing read, one running, an unknown result)
    /// is given now and the prompt does not open. A switch and a merge also ask for the
    /// branch list, which the prompt offers as the person types; a new branch is a new
    /// name, so it asks for none.
    pub fn open_prompt(&mut self, kind: PromptKind) -> Result<Option<Intent>, Refusal> {
        self.may_mutate(kind.action())?;
        self.read = None;
        self.read_back.clear();
        self.prompt = Some(Prompt {
            kind,
            text: String::new(),
            picked: false,
        });
        if kind == PromptKind::Create {
            self.mode = Mode::Changes;
            return Ok(None);
        }
        self.mode = Mode::Branches;
        self.branches = super::BranchList::Loading;
        self.branch_cursor = 0;
        let intent = self.plain(IntentKind::Branches);
        self.branches_request = Some(intent.id);
        Ok(Some(intent))
    }

    pub fn set_prompt_text(&mut self, text: impl Into<String>) {
        if let Some(prompt) = &mut self.prompt {
            prompt.text = text.into();
            prompt.picked = false;
            self.branch_cursor = 0;
        }
    }

    pub fn cancel_prompt(&mut self) {
        if self.prompt.take().is_some() && self.mode == Mode::Branches {
            self.mode = Mode::Changes;
            self.branches = super::BranchList::Idle;
            self.branches_request = None;
        }
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

    /// The branches the list offers: those the typed text is part of, with the current
    /// one left out of a merge (it cannot merge into itself).
    pub fn candidates(&self) -> Vec<&BranchInfo> {
        let super::BranchList::Ready(list) = &self.branches else {
            return Vec::new();
        };
        let (needle, merging) = match &self.prompt {
            Some(p) => (p.text.trim().to_lowercase(), p.kind == PromptKind::Merge),
            None => (String::new(), false),
        };
        list.iter()
            .filter(|b| needle.is_empty() || b.name.to_lowercase().contains(&needle))
            .filter(|b| !(merging && b.current))
            .collect()
    }

    /// Moves the cursor in the offered branches; Enter then takes that branch.
    pub fn prompt_move(&mut self, delta: isize) {
        let shown = self.candidates().len();
        if shown == 0 {
            return;
        }
        self.branch_cursor = step(self.branch_cursor, delta, shown);
        if let Some(prompt) = &mut self.prompt {
            prompt.picked = true;
        }
    }

    /// Completes the typed text to the branch under the cursor (or the first offered)
    /// and returns it, for the text buffer to take.
    pub fn prompt_complete(&mut self) -> Option<String> {
        let name = self
            .candidates()
            .get(self.branch_cursor)
            .map(|b| b.name.clone())?;
        self.set_prompt_text(name.clone());
        Some(name)
    }

    /// Takes the offered branch at `index` (a click).
    pub fn prompt_pick(&mut self, index: usize) -> Result<Intent, Refusal> {
        if index < self.candidates().len() {
            self.branch_cursor = index;
            if let Some(prompt) = &mut self.prompt {
                prompt.picked = true;
            }
        }
        self.submit_prompt()
    }

    /// Asks for the branch under the cursor if the person moved to one, else the typed
    /// name. A refusal leaves the prompt open.
    pub fn submit_prompt(&mut self) -> Result<Intent, Refusal> {
        let Some(prompt) = self.prompt.clone() else {
            return self.refuse(ActionKind::SwitchBranch, Refusal::EmptyBranchName);
        };
        let name = match (prompt.picked, self.candidates().get(self.branch_cursor)) {
            (true, Some(branch)) => branch.name.clone(),
            _ => prompt.text.trim().to_owned(),
        };
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
