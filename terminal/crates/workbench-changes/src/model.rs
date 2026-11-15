//! The Changes panel's model: the change list, the selection, each file's expanded diff,
//! the commit draft, the log, and the state of every request in flight.
//!
//! Translated from ELY-Open-Source/ELYTerminal at fbb536ec8f6e1466fa8c736967671ebf99a34080
//! (MIT, see `LICENSE-ELY`): `src/git/panel.rs` (blob 26133bcffa1a2de18dcb50d169fb55b959be0369),
//! the `GitPanel` state (`State`, `Diff`, `error`, `amend`, `discarding`, `acting`) and its
//! actions (`row_action`, `all`, `discard`, `commit`, `open`), and from
//! ELY-Open-Source/Ely-GPUI-Components at 294a8323c08a06bd8e7782d16acee43b6bb0c5eb
//! `src/git/changes.rs` (blob 9591530a7aadc9f88b726afd97d81a1079ecc795): the commit
//! subject limits (`SUBJECT`) and when the commit button is ready.
//!
//! Changed: the donor spawns a task per action that runs `git` and then reads again; here
//! every action returns an [`Intent`] and every answer is applied by [`Changes::complete`].
//! The donor finds a row by its path string only (`row_action`); here an intent carries
//! the repository generation it was decided against, and an answer decided against an
//! older generation is dropped and counted. The donor's one confirmation dialog for a
//! discard is a step of this model that selection and focus never reach. The donor had no
//! uncertain, refused or stale state: an unknown mutation result blocks the next mutation
//! until the state is read, and an open diff whose file changed is marked out of date, not
//! replaced.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use theorem_workbench_core::completion::{
    BranchInfo, CompletionPayload, LogEntry, Outcome, RepoState, ScmDiffResult, ScmStatus,
};

use crate::diff::{Hunk, Parsed, parse};
use crate::intent::{ActionKind, Intent, IntentId, IntentKind, Refusal};
use crate::status::{Basis, Change, Groups, Head, RowKey, Section, is_folder, loss, shown};

/// A subject's comfortable length, and its most (donor `SUBJECT`).
pub const SUBJECT: (usize, usize) = (50, 72);
/// The newest commits asked for (donor `RECENT`).
pub const RECENT: u32 = 50;

/// How a diff is laid out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLayout {
    #[default]
    Unified,
    Split,
}

/// What the owner said when it did not accept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    /// The owner said no, with its own word for it.
    Refused {
        code: String,
        reason: String,
    },
    /// The result is unknown. Shown as unknown, never as done, never retried.
    Uncertain {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

impl Problem {
    pub fn text(&self) -> String {
        match self {
            Self::Refused { code, reason } => format!("refused ({code}): {reason}"),
            Self::Uncertain { reason } => format!("unknown result: {reason}"),
            Self::Failed { reason } => format!("failed: {reason}"),
        }
    }

    fn of(outcome: &Outcome) -> Option<Self> {
        match outcome {
            Outcome::Accepted => None,
            Outcome::Refused { code, reason } => Some(Self::Refused {
                code: code.clone(),
                reason: reason.clone(),
            }),
            Outcome::Uncertain { reason } => Some(Self::Uncertain {
                reason: reason.clone(),
            }),
            Outcome::Failed { reason } => Some(Self::Failed {
                reason: reason.clone(),
            }),
        }
    }
}

/// A problem with the action that had it and what it was about (donor `error`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub action: ActionKind,
    pub subject: Option<String>,
    pub problem: Problem,
}

impl Notice {
    pub fn text(&self) -> String {
        match &self.subject {
            Some(subject) => format!(
                "{} {}: {}",
                self.action.label(),
                shown(subject),
                self.problem.text()
            ),
            None => format!("{}: {}", self.action.label(), self.problem.text()),
        }
    }
}

/// What the whole panel shows (donor `State`, widened).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelState {
    /// Nothing has been read yet, or the first read is running.
    Loading,
    /// A read gave no change at all: "No changes". Not the same as the owner being
    /// unreachable.
    Empty,
    Ready,
    /// The owner refused the read, with its code (no repository, no capability, ...).
    Refused {
        code: String,
        reason: String,
    },
    Uncertain {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

/// One file's expanded diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffState {
    Loading,
    Hunks(Vec<Hunk>),
    Binary,
    NoLines,
    /// Git keeps an untracked folder whole, so it has no lines (donor).
    Folder,
    /// A row whose status the host did not report has nothing to compare.
    NoStatus,
    Problem(Problem),
    /// The answer could not be read as a unified diff.
    Unreadable(String),
    /// An answer arrived for a state the repository has left; nothing was kept.
    Outdated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffView {
    pub state: DiffState,
    /// The file changed after these lines were read. The lines stay until the user
    /// reloads; they are not replaced under the cursor.
    pub stale: bool,
    pub(crate) basis: Option<Basis>,
    pub(crate) request: Option<IntentId>,
    /// The hunk hunk-navigation is on.
    pub hunk: usize,
    pub folded: BTreeSet<usize>,
}

impl DiffView {
    fn new(state: DiffState, basis: Option<Basis>, request: Option<IntentId>) -> Self {
        Self {
            state,
            stale: false,
            basis,
            request,
            hunk: 0,
            folded: BTreeSet::new(),
        }
    }

    pub fn hunks(&self) -> &[Hunk] {
        match &self.state {
            DiffState::Hunks(hunks) => hunks,
            _ => &[],
        }
    }
}

/// The log list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogState {
    /// Not asked for.
    Idle,
    Loading,
    /// Git refuses a log before the first commit (donor).
    NoCommits,
    Ready(Vec<LogEntry>),
    Problem(Problem),
    Outdated,
}

/// The branch list, for switching.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchList {
    Idle,
    Loading,
    Ready(Vec<BranchInfo>),
    Problem(Problem),
    Outdated,
}

/// Which part of the panel the keys belong to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Focus {
    #[default]
    Files,
    Message,
    Log,
}

/// What the middle of the panel lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Changes,
    Branches,
}

/// What a confirmation is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Confirm {
    /// Discard these rows as they were when asked.
    Discard(Vec<(RowKey, Change)>),
    /// Bring a discarded change back over edits made since.
    Restore { path: String, restore_id: String },
}

impl Confirm {
    /// The title and cost, in the donor's words.
    pub fn text(&self) -> (String, String) {
        match self {
            Self::Discard(items) => {
                let title = match items.as_slice() {
                    [(key, _)] => format!("Discard {}?", shown(&key.path)),
                    many => format!("Discard {} files?", many.len()),
                };
                let cost = items
                    .iter()
                    .map(|(key, change)| loss(key.section, change).text())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(" ");
                (title, cost)
            }
            Self::Restore { path, .. } => (
                format!("Restore {}?", shown(path)),
                "The discarded change is brought back over the edits made since.".into(),
            ),
        }
    }
}

/// Counts of answers that no longer applied.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// Decided against an older generation, superseded, or for a target that is gone.
    pub stale_dropped: u32,
    /// For an intent the model does not hold.
    pub unknown: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub groups: Groups,
    pub head: Head,
    pub state: Option<RepoState>,
    pub oid: Option<String>,
}

#[derive(Clone, Debug)]
struct Sent {
    subject: String,
    body: String,
    amend: bool,
}

#[derive(Clone, Debug)]
struct Pending {
    action: ActionKind,
    generation: u64,
    subject: Option<String>,
    key: Option<RowKey>,
    sent: Option<Sent>,
    /// A commit to make once this stage is accepted.
    then_commit: Option<(String, Sent)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Uncertain {
    pub action: ActionKind,
    pub reason: String,
    /// A status intent with this id or later reads the repository after the action.
    pub marked_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Undo {
    pub path: String,
    pub restore_id: String,
}

/// The Changes model.
#[derive(Clone, Debug)]
pub struct Changes {
    pub(crate) next_intent: u64,
    pub(crate) generation: u64,
    pub(crate) snapshot: Option<Snapshot>,
    pub(crate) status_problem: Option<Problem>,
    last_status: u64,
    pending: BTreeMap<IntentId, Pending>,
    /// Mutations waiting for the one before them (donor `acting`).
    queue: VecDeque<(IntentKind, Pending)>,
    pub(crate) notices: Vec<Notice>,
    pub(crate) uncertain: Vec<Uncertain>,
    pub(crate) cursor: Option<RowKey>,
    pub(crate) anchor: Option<RowKey>,
    pub(crate) selected: BTreeSet<RowKey>,
    pub(crate) diffs: BTreeMap<RowKey, DiffView>,
    pub(crate) layout: DiffLayout,
    pub(crate) subject: String,
    pub(crate) body: String,
    pub(crate) amend: bool,
    amend_available: bool,
    pub(crate) focus: Focus,
    pub(crate) mode: Mode,
    pub(crate) log: LogState,
    pub(crate) log_cursor: usize,
    want_log: bool,
    pub(crate) branches: BranchList,
    pub(crate) branch_cursor: usize,
    pub(crate) confirm: Option<Confirm>,
    pub(crate) undo: Vec<Undo>,
    pub(crate) scroll: usize,
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) counters: Counters,
    /// Diffs a restored view had open, asked for when the first status arrives.
    pub(crate) restored_open: BTreeSet<RowKey>,
}

impl Default for Changes {
    fn default() -> Self {
        Self::new()
    }
}

impl Changes {
    pub fn new() -> Self {
        Self {
            next_intent: 1,
            generation: 0,
            snapshot: None,
            status_problem: None,
            last_status: 0,
            pending: BTreeMap::new(),
            queue: VecDeque::new(),
            notices: Vec::new(),
            uncertain: Vec::new(),
            cursor: None,
            anchor: None,
            selected: BTreeSet::new(),
            diffs: BTreeMap::new(),
            layout: DiffLayout::Unified,
            subject: String::new(),
            body: String::new(),
            amend: false,
            amend_available: false,
            focus: Focus::Files,
            mode: Mode::Changes,
            log: LogState::Idle,
            log_cursor: 0,
            want_log: true,
            branches: BranchList::Idle,
            branch_cursor: 0,
            confirm: None,
            undo: Vec::new(),
            scroll: 0,
            width: 60,
            height: 24,
            counters: Counters::default(),
            restored_open: BTreeSet::new(),
        }
    }

    // ---- reading the model -------------------------------------------------

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn counters(&self) -> Counters {
        self.counters
    }

    pub fn groups(&self) -> Option<&Groups> {
        self.snapshot.as_ref().map(|s| &s.groups)
    }

    pub fn head(&self) -> Option<&Head> {
        self.snapshot.as_ref().map(|s| &s.head)
    }

    pub fn state(&self) -> PanelState {
        match (&self.snapshot, &self.status_problem) {
            (None, Some(Problem::Refused { code, reason })) => PanelState::Refused {
                code: code.clone(),
                reason: reason.clone(),
            },
            (None, Some(Problem::Uncertain { reason })) => PanelState::Uncertain {
                reason: reason.clone(),
            },
            (None, Some(Problem::Failed { reason })) => PanelState::Failed {
                reason: reason.clone(),
            },
            (None, None) => PanelState::Loading,
            (Some(snapshot), _) if snapshot.groups.is_empty() => PanelState::Empty,
            (Some(_), _) => PanelState::Ready,
        }
    }

    /// The problem the last status read had, when a list is still shown from before it.
    pub fn status_problem(&self) -> Option<&Problem> {
        self.status_problem.as_ref()
    }

    pub fn notices(&self) -> &[Notice] {
        &self.notices
    }

    pub fn dismiss_notices(&mut self) {
        self.notices.clear();
    }

    /// The actions that have been asked for and not answered.
    pub fn in_flight(&self) -> BTreeSet<ActionKind> {
        self.pending
            .values()
            .map(|p| p.action)
            .chain(self.queue.iter().map(|(_, p)| p.action))
            .collect()
    }

    pub fn is_busy(&self, action: ActionKind) -> bool {
        self.in_flight().contains(&action)
    }

    /// Mutations whose result is unknown and whose state has not been read since.
    pub fn unreconciled(&self) -> Vec<ActionKind> {
        self.uncertain.iter().map(|u| u.action).collect()
    }

    pub fn cursor(&self) -> Option<&RowKey> {
        self.cursor.as_ref()
    }

    pub fn selected(&self) -> &BTreeSet<RowKey> {
        &self.selected
    }

    pub fn diff(&self, key: &RowKey) -> Option<&DiffView> {
        self.diffs.get(key)
    }

    pub fn expanded(&self) -> impl Iterator<Item = &RowKey> {
        self.diffs.keys()
    }

    pub fn focus(&self) -> Focus {
        self.focus
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn log(&self) -> &LogState {
        &self.log
    }

    pub fn branches(&self) -> &BranchList {
        &self.branches
    }

    pub fn confirm_pending(&self) -> Option<&Confirm> {
        self.confirm.as_ref()
    }

    pub fn layout(&self) -> DiffLayout {
        self.layout
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn amend(&self) -> bool {
        self.amend
    }

    pub fn amend_available(&self) -> bool {
        self.amend_available
    }

    /// The message a commit sends: the subject, and the body after a blank line when
    /// there is one (donor `commit`).
    pub fn message(&self) -> String {
        match self.body.trim() {
            "" => self.subject.trim().to_owned(),
            body => format!("{}\n\n{body}", self.subject.trim()),
        }
    }

    /// The path of the file the cursor is on, for opening it.
    pub fn cursor_path(&self) -> Option<&str> {
        self.cursor.as_ref().map(|k| k.path.as_str())
    }

    // ---- inputs that are not requests --------------------------------------

    /// The size the panel is drawn at, so scrolling knows its page.
    pub fn set_area(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        self.reveal_cursor();
    }

    pub fn set_subject(&mut self, subject: impl Into<String>) {
        self.subject = subject.into();
    }

    pub fn set_body(&mut self, body: impl Into<String>) {
        self.body = body.into();
    }

    /// Whether the host offers `scm.commit.amend` (the owner refuses amend without it).
    pub fn set_amend_available(&mut self, available: bool) {
        self.amend_available = available;
        if !available {
            self.amend = false;
        }
    }

    pub fn set_amend(&mut self, amend: bool) -> Result<(), Refusal> {
        if amend && !self.amend_available {
            return self.refuse(ActionKind::Commit, Refusal::AmendUnavailable);
        }
        self.amend = amend;
        Ok(())
    }

    pub fn set_focus(&mut self, focus: Focus) {
        self.focus = focus;
    }

    /// Files, then the message, then the log; a key press moves between them.
    pub fn focus_next(&mut self) {
        self.focus = match self.focus {
            Focus::Files => Focus::Message,
            Focus::Message => Focus::Log,
            Focus::Log => Focus::Files,
        };
    }

    pub fn toggle_layout(&mut self) {
        self.layout = match self.layout {
            DiffLayout::Unified => DiffLayout::Split,
            DiffLayout::Split => DiffLayout::Unified,
        };
    }

    // ---- selection ---------------------------------------------------------

    pub(crate) fn keys(&self) -> Vec<RowKey> {
        self.snapshot
            .as_ref()
            .map(|s| s.groups.keys().collect())
            .unwrap_or_default()
    }

    fn position(keys: &[RowKey], key: &RowKey) -> Option<usize> {
        keys.iter().position(|k| k == key)
    }

    /// Moves the cursor by `delta` rows of what the focus holds. Selection and focus
    /// never make a request and never open a confirmation. With `extend`, the rows
    /// from the anchor to the cursor are selected.
    pub fn move_cursor(&mut self, delta: isize, extend: bool) {
        match (self.mode, self.focus) {
            (Mode::Branches, _) => {
                if let BranchList::Ready(list) = &self.branches {
                    self.branch_cursor = step(self.branch_cursor, delta, list.len());
                }
            }
            (_, Focus::Log) => {
                if let LogState::Ready(entries) = &self.log {
                    self.log_cursor = step(self.log_cursor, delta, entries.len());
                }
            }
            (_, Focus::Message) => {}
            (_, Focus::Files) => {
                let keys = self.keys();
                if keys.is_empty() {
                    return;
                }
                let at = self
                    .cursor
                    .as_ref()
                    .and_then(|k| Self::position(&keys, k))
                    .map(|i| step(i, delta, keys.len()))
                    .unwrap_or(if delta >= 0 { 0 } else { keys.len() - 1 });
                self.place_cursor(&keys, at, extend);
            }
        }
        self.reveal_cursor();
    }

    /// Puts the cursor on `key` (a click), with no request.
    pub fn select(&mut self, key: &RowKey, extend: bool) {
        let keys = self.keys();
        if let Some(at) = Self::position(&keys, key) {
            self.focus = Focus::Files;
            self.place_cursor(&keys, at, extend);
            self.reveal_cursor();
        }
    }

    fn place_cursor(&mut self, keys: &[RowKey], at: usize, extend: bool) {
        let key = keys[at].clone();
        if extend {
            let anchor = self.anchor.clone().unwrap_or_else(|| key.clone());
            let from = Self::position(keys, &anchor).unwrap_or(at);
            let (lo, hi) = (from.min(at), from.max(at));
            self.selected = keys[lo..=hi].iter().cloned().collect();
            self.anchor = Some(anchor);
        } else {
            self.selected = BTreeSet::from([key.clone()]);
            self.anchor = Some(key.clone());
        }
        self.cursor = Some(key);
    }

    /// Adds the cursor row to the selection, or takes it out, keeping the rest.
    pub fn toggle_selected(&mut self) {
        if let Some(key) = self.cursor.clone()
            && !self.selected.remove(&key)
        {
            self.selected.insert(key);
        }
    }

    pub fn select_all(&mut self) {
        self.selected = self.keys().into_iter().collect();
    }

    /// The rows an action applies to: the selection, or the cursor row.
    fn targets(&self) -> Vec<RowKey> {
        let keys = self.keys();
        let mut rows: Vec<RowKey> = keys
            .into_iter()
            .filter(|k| self.selected.contains(k))
            .collect();
        if rows.is_empty()
            && let Some(cursor) = &self.cursor
        {
            rows.push(cursor.clone());
        }
        rows
    }

    // ---- requests ----------------------------------------------------------

    fn issue(&mut self, kind: IntentKind, pending: Pending) -> Intent {
        let id = IntentId(self.next_intent);
        self.next_intent += 1;
        let pending = Pending {
            generation: self.generation,
            ..pending
        };
        self.pending.insert(id, pending);
        Intent {
            id,
            generation: self.generation,
            kind,
        }
    }

    fn plain(&mut self, kind: IntentKind) -> Intent {
        let pending = Pending {
            action: kind.action(),
            generation: 0,
            subject: None,
            key: None,
            sent: None,
            then_commit: None,
        };
        self.issue(kind, pending)
    }

    fn refuse<T>(&mut self, action: ActionKind, refusal: Refusal) -> Result<T, Refusal> {
        self.push_notice(Notice {
            action,
            subject: None,
            problem: Problem::Refused {
                code: refusal.code().to_owned(),
                reason: refusal.reason(),
            },
        });
        Err(refusal)
    }

    fn push_notice(&mut self, notice: Notice) {
        self.notices.push(notice);
        let over = self.notices.len().saturating_sub(3);
        self.notices.drain(..over);
    }

    /// The first read, or a read the user asked for: status, with the log and any
    /// restored open diffs asked for once it is applied. Never repeats an action whose
    /// result is unknown; this is the read that reconciles it.
    pub fn refresh(&mut self) -> Intent {
        if !self.uncertain.is_empty() {
            self.want_log = true;
        }
        self.status_problem = None;
        self.plain(IntentKind::Status)
    }

    /// Asks for the log, now.
    pub fn request_log(&mut self) -> Option<Intent> {
        let head = self.snapshot.as_ref()?.oid.is_some();
        if !head {
            self.log = LogState::NoCommits;
            return None;
        }
        self.log = LogState::Loading;
        Some(self.plain(IntentKind::Log { max_count: RECENT }))
    }

    /// Opens the branch list and asks for it.
    pub fn open_branches(&mut self) -> Intent {
        self.mode = Mode::Branches;
        self.branches = BranchList::Loading;
        self.branch_cursor = 0;
        self.plain(IntentKind::Branches)
    }

    pub fn close_branches(&mut self) {
        self.mode = Mode::Changes;
    }

    fn loaded(&mut self, action: ActionKind) -> Result<(), Refusal> {
        if self.snapshot.is_none() {
            return self.refuse(action, Refusal::NotLoaded);
        }
        Ok(())
    }

    /// Why a mutation cannot be asked for now, if it cannot: nothing read yet, one still
    /// running, or an unknown result not read since.
    pub fn mutation_block(&self) -> Option<Refusal> {
        if self.snapshot.is_none() {
            return Some(Refusal::NotLoaded);
        }
        let busy = self
            .pending
            .values()
            .map(|p| p.action)
            .chain(self.queue.iter().map(|(_, p)| p.action))
            .find(|a| a.mutates());
        if let Some(busy) = busy {
            return Some(Refusal::Busy(busy));
        }
        self.uncertain.first().map(|u| Refusal::Reconcile(u.action))
    }

    /// A mutation waits for the one before it and for an unknown result to be read.
    fn may_mutate(&mut self, action: ActionKind) -> Result<(), Refusal> {
        match self.mutation_block() {
            Some(refusal) => self.refuse(action, refusal),
            None => Ok(()),
        }
    }

    /// Opens or closes the cursor file's diff. Opening asks the owner; closing drops
    /// what was read.
    pub fn toggle_diff(&mut self) -> Result<Option<Intent>, Refusal> {
        match self.cursor.clone() {
            Some(key) => self.toggle_diff_of(&key),
            None => Ok(None),
        }
    }

    pub fn toggle_diff_of(&mut self, key: &RowKey) -> Result<Option<Intent>, Refusal> {
        if self.diffs.remove(key).is_some() {
            return Ok(None);
        }
        self.open_diff(key)
    }

    /// Asks again for a diff that is out of date, or one whose answer was dropped. The
    /// only way a stale diff is replaced.
    pub fn reload_diff(&mut self, key: &RowKey) -> Result<Option<Intent>, Refusal> {
        if !self.diffs.contains_key(key) {
            return Ok(None);
        }
        self.open_diff(key)
    }

    fn open_diff(&mut self, key: &RowKey) -> Result<Option<Intent>, Refusal> {
        self.loaded(ActionKind::Diff)?;
        let snapshot = self.snapshot.as_ref().expect("loaded");
        let Some(change) = snapshot.groups.find(key) else {
            return Ok(None);
        };
        let basis = Basis {
            state: snapshot.state.clone(),
            head: snapshot.oid.clone(),
            change: change.clone(),
        };
        if !key.section.can_diff() {
            self.diffs.insert(
                key.clone(),
                DiffView::new(DiffState::NoStatus, Some(basis), None),
            );
            return Ok(None);
        }
        // Git keeps an untracked folder whole, so it has no lines.
        if key.section == Section::Untracked && is_folder(&key.path) {
            self.diffs.insert(
                key.clone(),
                DiffView::new(DiffState::Folder, Some(basis), None),
            );
            return Ok(None);
        }
        let kind = IntentKind::Diff {
            path: key.path.clone(),
            staged: key.section.diff_staged(),
        };
        let pending = Pending {
            action: ActionKind::Diff,
            generation: 0,
            subject: Some(key.path.clone()),
            key: Some(key.clone()),
            sent: None,
            then_commit: None,
        };
        let intent = self.issue(kind, pending);
        let mut view = DiffView::new(DiffState::Loading, Some(basis), Some(intent.id));
        if let Some(old) = self.diffs.get(key) {
            view.layout_from(old);
        }
        self.diffs.insert(key.clone(), view);
        Ok(Some(intent))
    }

    /// Moves to the next or previous hunk of the cursor file's open diff.
    pub fn move_hunk(&mut self, delta: isize) {
        let Some(key) = self.cursor.clone() else {
            return;
        };
        if let Some(view) = self.diffs.get_mut(&key) {
            let count = view.hunks().len();
            if count > 0 {
                view.hunk = step(view.hunk, delta, count);
            }
        }
    }

    /// Folds or unfolds the current hunk of the cursor file's open diff.
    pub fn toggle_fold(&mut self) {
        let Some(key) = self.cursor.clone() else {
            return;
        };
        if let Some(view) = self.diffs.get_mut(&key) {
            let hunk = view.hunk;
            if hunk < view.hunks().len() && !view.folded.remove(&hunk) {
                view.folded.insert(hunk);
            }
        }
    }

    fn paths_of(&self, rows: &[RowKey], allowed: fn(Section) -> bool) -> Vec<String> {
        let mut paths: Vec<String> = Vec::new();
        for key in rows.iter().filter(|k| allowed(k.section)) {
            if !paths.contains(&key.path) {
                paths.push(key.path.clone());
            }
        }
        paths
    }

    /// Stages the selected unstaged and untracked files.
    pub fn stage(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Stage)?;
        let paths = self.paths_of(&self.targets(), Section::can_stage);
        self.stage_paths(paths)
    }

    /// Stages every unstaged change (donor `all(true)`).
    pub fn stage_all(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Stage)?;
        let paths = self.section_paths(Section::Unstaged);
        self.stage_paths(paths)
    }

    fn section_paths(&self, section: Section) -> Vec<String> {
        self.snapshot
            .as_ref()
            .map(|s| {
                s.groups
                    .section(section)
                    .iter()
                    .map(|c| c.path.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn stage_paths(&mut self, paths: Vec<String>) -> Result<Intent, Refusal> {
        if paths.is_empty() {
            return self.refuse(ActionKind::Stage, Refusal::Nothing("staged"));
        }
        Ok(self.plain(IntentKind::Stage { paths }))
    }

    /// Unstages the selected staged files.
    pub fn unstage(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Unstage)?;
        let paths = self.paths_of(&self.targets(), Section::can_unstage);
        self.unstage_paths(paths)
    }

    /// Unstages every staged change (donor `all(false)`).
    pub fn unstage_all(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Unstage)?;
        let paths = self.section_paths(Section::Staged);
        self.unstage_paths(paths)
    }

    fn unstage_paths(&mut self, paths: Vec<String>) -> Result<Intent, Refusal> {
        if paths.is_empty() {
            return self.refuse(ActionKind::Unstage, Refusal::Nothing("unstaged"));
        }
        Ok(self.plain(IntentKind::Unstage { paths }))
    }

    /// Asks what a discard of the selected rows would cost. Nothing is sent until
    /// [`confirm`](Self::confirm).
    pub fn request_discard(&mut self) -> Result<(), Refusal> {
        self.may_mutate(ActionKind::Discard)?;
        let groups = &self.snapshot.as_ref().expect("loaded").groups;
        let items: Vec<(RowKey, Change)> = self
            .targets()
            .into_iter()
            .filter(|k| k.section.can_discard())
            .filter_map(|k| groups.find(&k).map(|c| (k.clone(), c.clone())))
            .collect();
        if items.is_empty() {
            return self.refuse(ActionKind::Discard, Refusal::Nothing("discarded"));
        }
        self.confirm = Some(Confirm::Discard(items));
        Ok(())
    }

    /// Brings back the last discarded change. Asks first when the file has edits now.
    pub fn restore_last(&mut self) -> Result<Option<Intent>, Refusal> {
        self.may_mutate(ActionKind::Restore)?;
        let Some(undo) = self.undo.last().cloned() else {
            return self.refuse(ActionKind::Restore, Refusal::NoRestorePoint);
        };
        let groups = &self.snapshot.as_ref().expect("loaded").groups;
        let edited = [Section::Unstaged, Section::Untracked, Section::Conflicted]
            .iter()
            .any(|s| groups.section(*s).iter().any(|c| c.path == undo.path));
        if edited {
            self.confirm = Some(Confirm::Restore {
                path: undo.path,
                restore_id: undo.restore_id,
            });
            return Ok(None);
        }
        Ok(Some(self.restore_intent(undo.path, undo.restore_id)))
    }

    fn restore_intent(&mut self, path: String, restore_id: String) -> Intent {
        let pending = Pending {
            action: ActionKind::Restore,
            generation: 0,
            subject: Some(path),
            key: None,
            sent: None,
            then_commit: None,
        };
        self.issue(IntentKind::Restore { restore_id }, pending)
    }

    pub fn cancel_confirm(&mut self) {
        self.confirm = None;
    }

    /// The user said yes. A discard is sent for each row still as it was when asked, one
    /// after the other; a row that changed since is left alone and said so.
    pub fn confirm(&mut self) -> Result<Vec<Intent>, Refusal> {
        if self.confirm.is_none() {
            return self.refuse(ActionKind::Discard, Refusal::NothingToConfirm);
        }
        // A refusal to start leaves the question open.
        let action = match &self.confirm {
            Some(Confirm::Restore { .. }) => ActionKind::Restore,
            _ => ActionKind::Discard,
        };
        self.may_mutate(action)?;
        let confirm = self.confirm.take().expect("checked");
        match confirm {
            Confirm::Restore { path, restore_id } => {
                Ok(vec![self.restore_intent(path, restore_id)])
            }
            Confirm::Discard(items) => {
                let mut paths = Vec::new();
                for (key, asked) in items {
                    let now = self
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.groups.find(&key).cloned());
                    if now.as_ref() == Some(&asked) {
                        paths.push(key.path);
                    } else {
                        self.push_notice(Notice {
                            action: ActionKind::Discard,
                            subject: Some(key.path),
                            problem: Problem::Refused {
                                code: "changed_since_asked".into(),
                                reason: "The file changed after the question was asked; nothing was discarded".into(),
                            },
                        });
                    }
                }
                let mut sends = paths.into_iter().map(|path| {
                    let kind = IntentKind::Discard { path: path.clone() };
                    let pending = Pending {
                        action: ActionKind::Discard,
                        generation: 0,
                        subject: Some(path),
                        key: None,
                        sent: None,
                        then_commit: None,
                    };
                    (kind, pending)
                });
                let Some((first, first_pending)) = sends.next() else {
                    return Ok(vec![]);
                };
                self.queue.extend(sends);
                Ok(vec![self.issue(first, first_pending)])
            }
        }
    }

    /// Commits what is staged with the typed message (donor `commit`).
    pub fn commit(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Commit)?;
        let (message, sent) = self.commit_message()?;
        let staged = self.snapshot.as_ref().expect("loaded").groups.staged.len();
        if staged == 0 && !self.amend {
            return self.refuse(ActionKind::Commit, Refusal::NothingStaged);
        }
        let amend = sent.amend;
        let pending = Pending {
            action: ActionKind::Commit,
            generation: 0,
            subject: None,
            key: None,
            sent: Some(sent),
            then_commit: None,
        };
        Ok(self.issue(IntentKind::Commit { message, amend }, pending))
    }

    /// With nothing staged: stages every unstaged change, then commits (the Theia
    /// view's "Stage All and Commit"). The commit is decided once the stage is accepted.
    pub fn commit_staging_all(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Commit)?;
        let (message, sent) = self.commit_message()?;
        let paths = self.section_paths(Section::Unstaged);
        if paths.is_empty() {
            return self.refuse(ActionKind::Commit, Refusal::NothingStaged);
        }
        let pending = Pending {
            action: ActionKind::Stage,
            generation: 0,
            subject: None,
            key: None,
            sent: None,
            then_commit: Some((message, sent)),
        };
        Ok(self.issue(IntentKind::Stage { paths }, pending))
    }

    fn commit_message(&mut self) -> Result<(String, Sent), Refusal> {
        if self.subject.trim().is_empty() {
            return self.refuse(ActionKind::Commit, Refusal::EmptyMessage);
        }
        let sent = Sent {
            subject: self.subject.clone(),
            body: self.body.clone(),
            amend: self.amend,
        };
        Ok((self.message(), sent))
    }

    /// Switches to the branch under the branch list's cursor.
    pub fn pick_branch(&mut self) -> Result<Intent, Refusal> {
        let name = match &self.branches {
            BranchList::Ready(list) => list.get(self.branch_cursor).map(|b| b.name.clone()),
            _ => None,
        };
        match name {
            Some(name) => self.switch_branch(&name),
            None => self.refuse(ActionKind::SwitchBranch, Refusal::EmptyBranchName),
        }
    }

    pub fn switch_branch(&mut self, name: &str) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::SwitchBranch)?;
        if name.trim().is_empty() {
            return self.refuse(ActionKind::SwitchBranch, Refusal::EmptyBranchName);
        }
        let pending = Pending {
            action: ActionKind::SwitchBranch,
            generation: 0,
            subject: Some(name.to_owned()),
            key: None,
            sent: None,
            then_commit: None,
        };
        Ok(self.issue(
            IntentKind::SwitchBranch {
                name: name.to_owned(),
            },
            pending,
        ))
    }

    pub fn create_branch(&mut self, name: &str) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::CreateBranch)?;
        if name.trim().is_empty() {
            return self.refuse(ActionKind::CreateBranch, Refusal::EmptyBranchName);
        }
        let pending = Pending {
            action: ActionKind::CreateBranch,
            generation: 0,
            subject: Some(name.to_owned()),
            key: None,
            sent: None,
            then_commit: None,
        };
        Ok(self.issue(
            IntentKind::CreateBranch {
                name: name.to_owned(),
            },
            pending,
        ))
    }

    pub fn fetch(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Fetch)?;
        Ok(self.plain(IntentKind::Fetch))
    }

    pub fn push(&mut self) -> Result<Intent, Refusal> {
        self.may_mutate(ActionKind::Push)?;
        Ok(self.plain(IntentKind::Push))
    }

    // ---- results -----------------------------------------------------------

    /// Applies the owner's answer to one request and returns the reads or the queued
    /// mutation that follow it. A mutation is never repeated here: after an unknown
    /// result nothing follows and the state waits to be read by the user.
    pub fn complete(
        &mut self,
        id: IntentId,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) -> Vec<Intent> {
        let Some(pending) = self.pending.remove(&id) else {
            self.counters.unknown += 1;
            return vec![];
        };
        match pending.action {
            ActionKind::Status => self.status_done(id, outcome, payload),
            ActionKind::Diff => {
                self.diff_done(id, &pending, outcome, payload);
                vec![]
            }
            ActionKind::Log => {
                self.log_done(&pending, outcome, payload);
                vec![]
            }
            ActionKind::Branches => {
                self.branches_done(&pending, outcome, payload);
                vec![]
            }
            _ => self.mutation_done(&pending, outcome, payload),
        }
    }

    fn older(&mut self, pending: &Pending) -> bool {
        let older = pending.generation < self.generation;
        if older {
            self.counters.stale_dropped += 1;
        }
        older
    }

    fn status_done(
        &mut self,
        id: IntentId,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) -> Vec<Intent> {
        if id.0 < self.last_status {
            self.counters.stale_dropped += 1;
            return vec![];
        }
        self.last_status = id.0;
        match (outcome, payload) {
            (Outcome::Accepted, Some(CompletionPayload::Scm(status))) => {
                self.status_problem = None;
                self.apply_status(status);
                // A read asked for after an unknown result reconciles it.
                self.uncertain.retain(|u| id.0 < u.marked_at);
                let mut next = Vec::new();
                if self.want_log {
                    self.want_log = false;
                    next.extend(self.request_log());
                }
                next.extend(self.ask_restored());
                next
            }
            (Outcome::Accepted, _) => {
                self.status_problem = Some(Problem::Failed {
                    reason: "the owner's answer was not a status".into(),
                });
                vec![]
            }
            (other, _) => {
                self.status_problem = Problem::of(other);
                vec![]
            }
        }
    }

    fn ask_restored(&mut self) -> Vec<Intent> {
        let wanted = std::mem::take(&mut self.restored_open);
        let mut intents = Vec::new();
        for key in wanted {
            if let Ok(Some(intent)) = self.open_diff(&key) {
                intents.push(intent);
            }
        }
        intents
    }

    fn apply_status(&mut self, status: &ScmStatus) {
        let next = Snapshot {
            groups: Groups::classify(&status.changes),
            head: Head::of(status),
            state: status.state.clone(),
            oid: status.head.clone(),
        };
        let old_keys = self.keys();
        if self.snapshot.as_ref() != Some(&next) {
            self.generation += 1;
        }
        self.snapshot = Some(next);
        let keys = self.keys();
        self.selected.retain(|k| keys.contains(k));
        self.cursor = self.nearest(&old_keys, &keys, self.cursor.clone());
        self.anchor = self.nearest(&old_keys, &keys, self.anchor.clone());
        if self.selected.is_empty()
            && let Some(cursor) = self.cursor.clone()
        {
            self.selected.insert(cursor);
        }
        self.diffs.retain(|k, _| keys.contains(k));
        let snapshot = self.snapshot.as_ref().expect("just set");
        for (key, view) in &mut self.diffs {
            let now = snapshot.groups.find(key).map(|change| Basis {
                state: snapshot.state.clone(),
                head: snapshot.oid.clone(),
                change: change.clone(),
            });
            if view.basis != now && view.basis.is_some() && view.state != DiffState::Loading {
                view.stale = true;
            }
        }
        if self.log_cursor >= self.log_len() {
            self.log_cursor = 0;
        }
        self.reveal_cursor();
    }

    /// The key to put the cursor on after the list changed: itself, else the row now
    /// where it was.
    fn nearest(&self, old: &[RowKey], new: &[RowKey], key: Option<RowKey>) -> Option<RowKey> {
        let key = key?;
        if new.contains(&key) {
            return Some(key);
        }
        if new.is_empty() {
            return None;
        }
        let at = old.iter().position(|k| *k == key).unwrap_or(0);
        Some(new[at.min(new.len() - 1)].clone())
    }

    fn log_len(&self) -> usize {
        match &self.log {
            LogState::Ready(entries) => entries.len(),
            _ => 0,
        }
    }

    fn diff_done(
        &mut self,
        id: IntentId,
        pending: &Pending,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) {
        let Some(key) = pending.key.clone() else {
            self.counters.stale_dropped += 1;
            return;
        };
        let current = self.diffs.get(&key).and_then(|v| v.request) == Some(id);
        if !current {
            // Closed, or asked for again since: this answer no longer applies.
            self.counters.stale_dropped += 1;
            return;
        }
        if self.older(pending) {
            if let Some(view) = self.diffs.get_mut(&key) {
                view.state = DiffState::Outdated;
            }
            return;
        }
        let state = match (outcome, payload) {
            (Outcome::Accepted, Some(CompletionPayload::ScmDiff(result))) => {
                if self.state_moved(result.state.as_ref()) {
                    self.counters.stale_dropped += 1;
                    DiffState::Outdated
                } else {
                    Self::read_diff(result)
                }
            }
            (Outcome::Accepted, _) => {
                DiffState::Unreadable("the owner's answer was not a diff".into())
            }
            (other, _) => DiffState::Problem(Problem::of(other).expect("not accepted")),
        };
        if let Some(view) = self.diffs.get_mut(&key) {
            view.state = state;
            view.stale = false;
            view.hunk = 0;
            view.folded.clear();
            view.request = None;
        }
    }

    fn read_diff(result: &ScmDiffResult) -> DiffState {
        match parse(&result.text) {
            Ok(Parsed::Hunks(hunks)) => DiffState::Hunks(hunks),
            Ok(Parsed::Binary) => DiffState::Binary,
            Ok(Parsed::NoLines) => DiffState::NoLines,
            Err(error) => DiffState::Unreadable(error.to_string()),
        }
    }

    /// Whether an answer says it was read at a repository state other than the one the
    /// list shows: a field both name that differs.
    fn state_moved(&self, answer: Option<&RepoState>) -> bool {
        let (Some(answer), Some(shown)) = (
            answer,
            self.snapshot.as_ref().and_then(|s| s.state.as_ref()),
        ) else {
            return false;
        };
        fn differs<T: PartialEq>(a: &Option<T>, b: &Option<T>) -> bool {
            matches!((a, b), (Some(a), Some(b)) if a != b)
        }
        differs(&answer.head, &shown.head)
            || differs(&answer.index_generation, &shown.index_generation)
            || differs(&answer.worktree_generation, &shown.worktree_generation)
    }

    fn log_done(
        &mut self,
        pending: &Pending,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) {
        if self.older(pending) {
            self.log = LogState::Outdated;
            return;
        }
        self.log = match (outcome, payload) {
            (Outcome::Accepted, Some(CompletionPayload::ScmLog(result))) => {
                self.log_cursor = 0;
                LogState::Ready(result.commits.clone())
            }
            (Outcome::Accepted, _) => LogState::Problem(Problem::Failed {
                reason: "the owner's answer was not a log".into(),
            }),
            (other, _) => LogState::Problem(Problem::of(other).expect("not accepted")),
        };
    }

    fn branches_done(
        &mut self,
        pending: &Pending,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) {
        if self.older(pending) {
            self.branches = BranchList::Outdated;
            return;
        }
        self.branches = match (outcome, payload) {
            (Outcome::Accepted, Some(CompletionPayload::ScmBranches(result))) => {
                self.branch_cursor = result.branches.iter().position(|b| b.current).unwrap_or(0);
                BranchList::Ready(result.branches.clone())
            }
            (Outcome::Accepted, _) => BranchList::Problem(Problem::Failed {
                reason: "the owner's answer was not a branch list".into(),
            }),
            (other, _) => BranchList::Problem(Problem::of(other).expect("not accepted")),
        };
    }

    fn mutation_done(
        &mut self,
        pending: &Pending,
        outcome: &Outcome,
        payload: Option<&CompletionPayload>,
    ) -> Vec<Intent> {
        match outcome {
            Outcome::Accepted => {
                self.generation += 1;
                if let Some(CompletionPayload::ScmDiscarded(done)) = payload {
                    self.undo.push(Undo {
                        path: done.path.clone(),
                        restore_id: done.restore_id.clone(),
                    });
                }
                if pending.action == ActionKind::Restore {
                    self.undo.pop();
                }
                if let Some(sent) = &pending.sent {
                    self.draft_sent(sent);
                    self.want_log = true;
                }
                if let Some((message, sent)) = &pending.then_commit {
                    let commit = Pending {
                        action: ActionKind::Commit,
                        generation: 0,
                        subject: None,
                        key: None,
                        sent: Some(sent.clone()),
                        then_commit: None,
                    };
                    let amend = sent.amend;
                    return vec![self.issue(
                        IntentKind::Commit {
                            message: message.clone(),
                            amend,
                        },
                        commit,
                    )];
                }
                if let Some((kind, next)) = self.queue.pop_front() {
                    return vec![self.issue(kind, next)];
                }
                if matches!(
                    pending.action,
                    ActionKind::SwitchBranch | ActionKind::CreateBranch
                ) {
                    self.mode = Mode::Changes;
                    self.want_log = true;
                }
                self.status_problem = None;
                vec![self.plain(IntentKind::Status)]
            }
            other => {
                // The rest of a batch is not sent after one that did not succeed.
                self.queue.clear();
                let problem = Problem::of(other).expect("not accepted");
                if let Problem::Uncertain { reason } = &problem {
                    // The state is read again, and the log with it, when the user asks.
                    self.want_log = true;
                    self.uncertain.push(Uncertain {
                        action: pending.action,
                        reason: reason.clone(),
                        marked_at: self.next_intent,
                    });
                }
                self.push_notice(Notice {
                    action: pending.action,
                    subject: pending.subject.clone(),
                    problem,
                });
                vec![]
            }
        }
    }

    /// What a commit sent leaves of the draft: a field typed in while it ran stays, and
    /// so does a box ticked (donor `commit`'s `then`).
    fn draft_sent(&mut self, sent: &Sent) {
        if self.subject == sent.subject {
            self.subject.clear();
        }
        if self.body == sent.body {
            self.body.clear();
        }
        if self.amend == sent.amend {
            self.amend = false;
        }
    }

    // ---- scrolling ---------------------------------------------------------

    pub fn scroll_by(&mut self, delta: isize) {
        let rows = self.row_count();
        let page = self.page();
        let max = rows.saturating_sub(page);
        self.scroll = step_clamped(self.scroll, delta, max);
    }

    /// The first row the list shows.
    pub fn scroll(&self) -> usize {
        self.scroll
    }

    fn reveal_cursor(&mut self) {
        let Some(cursor) = self.cursor.clone() else {
            return;
        };
        let at = {
            let rows = crate::layout::rows(self, false);
            rows.iter().position(|row| row.is_file(&cursor))
        };
        if let Some(at) = at {
            self.reveal(at);
        }
    }

    pub(crate) fn reveal(&mut self, row: usize) {
        let page = self.page().max(1);
        if row < self.scroll {
            self.scroll = row;
        } else if row >= self.scroll + page {
            self.scroll = row + 1 - page;
        }
    }

    pub(crate) fn page(&self) -> usize {
        crate::layout::regions(
            self,
            ratatui::layout::Rect::new(0, 0, self.width, self.height),
        )
        .list
        .height as usize
    }

    pub(crate) fn row_count(&self) -> usize {
        crate::layout::rows(self, false).len()
    }
}

impl DiffView {
    /// A diff asked for again keeps the hunk the reader was on and what they folded.
    fn layout_from(&mut self, old: &DiffView) {
        self.hunk = old.hunk;
        self.folded = old.folded.clone();
    }
}

/// `at` moved by `delta` within `len` rows, stopping at the ends.
fn step(at: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    step_clamped(at, delta, len - 1)
}

fn step_clamped(at: usize, delta: isize, max: usize) -> usize {
    (at as isize + delta).clamp(0, max as isize) as usize
}
