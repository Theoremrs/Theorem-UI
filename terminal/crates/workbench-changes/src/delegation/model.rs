//! What the delegation panel knows: the files a delegation changed, and for the one file
//! that is open, its before and after.
//!
//! Written for this crate; not translated. Nothing here does I/O or reads a key: the
//! panel asks the model what to request and gives it the answers. All text from the
//! owner is hostile (a path, a reason, a file's lines), so every string that is shown is
//! made printable here, once, with `theorem_workbench_text::visible::visible`; nothing a
//! drawing or a semantic node reads is raw.

use similar::{ChangeTag, TextDiff, udiff::UnifiedHunkHeader};
use theorem_workbench_core::completion::{DelegationChange, DelegationChangeKind, Outcome};
use theorem_workbench_text::visible::visible;

use crate::diff::{DiffLine, Hunk, LineKind, mark_words};

/// The most changed files the list holds; the rest are counted, not listed.
pub const MAX_LISTED: usize = 1_000;
/// The most bytes of one side the panel will compare.
pub const MAX_SIDE_BYTES: usize = 256 * 1024;
/// The most lines of one side the panel will compare.
pub const MAX_SIDE_LINES: usize = 5_000;
/// The most characters of one line that are kept; a longer line is cut and says so.
pub const MAX_LINE_CHARS: usize = 2_000;
/// Unchanged lines kept around a change.
const CONTEXT: usize = 3;

/// One thing the panel read from the owner, or why it has not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Read<T> {
    /// Not asked yet.
    Idle,
    /// Asked, no answer.
    Loading,
    Ready(T),
    Refused {
        code: String,
        reason: String,
    },
    Failed(String),
    Uncertain(String),
    /// The owner said access to the delegation is gone: nothing is kept.
    Revoked,
}

impl<T> Read<T> {
    pub(crate) fn waiting(&self) -> bool {
        matches!(self, Self::Idle | Self::Loading)
    }

    /// An outcome that is not an acceptance, as the state it leaves. `None` for an
    /// acceptance: the caller then reads the payload.
    pub(crate) fn from_outcome(outcome: &Outcome) -> Option<Self> {
        if outcome.is_access_revoked() {
            return Some(Self::Revoked);
        }
        match outcome {
            Outcome::Accepted => None,
            Outcome::Refused { code, reason } => Some(Self::Refused {
                code: code.clone(),
                reason: reason.clone(),
            }),
            Outcome::Uncertain { reason } => Some(Self::Uncertain(reason.clone())),
            Outcome::Failed { reason } => Some(Self::Failed(reason.clone())),
        }
    }
}

/// A side of the open file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Side {
    /// The file has no such side (added: no before; deleted: no after), or it is binary
    /// and no side is read.
    Absent,
    Text(Read<String>),
}

/// What the open file shows once its sides are known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Shown {
    /// A side is still to come or could not be had; the words say which.
    Nothing,
    /// The two are the same text.
    Same,
    /// The lines are the same and the texts differ: only the final line break does.
    LineBreakOnly,
    Hunks(Vec<Hunk>),
    /// One side only, as plain lines, because the other could not be read.
    Plain {
        side: &'static str,
        hunks: Vec<Hunk>,
    },
    /// A side is past what the panel compares.
    TooLarge,
}

/// The open file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct File {
    pub change: DelegationChange,
    pub before: Side,
    pub after: Side,
    pub shown: Shown,
}

impl File {
    pub(crate) fn new(change: &DelegationChange) -> Self {
        let reads = |has: bool| {
            if has && !change.binary {
                Side::Text(Read::Idle)
            } else {
                Side::Absent
            }
        };
        let mut file = Self {
            change: change.clone(),
            before: reads(change.has_before),
            after: reads(change.has_after),
            shown: Shown::Nothing,
        };
        file.settle();
        file
    }

    pub(crate) fn side(&self, after: bool) -> &Side {
        if after { &self.after } else { &self.before }
    }

    pub(crate) fn side_mut(&mut self, after: bool) -> &mut Side {
        if after {
            &mut self.after
        } else {
            &mut self.before
        }
    }

    /// Whether either side still waits for the owner.
    pub(crate) fn waiting(&self) -> bool {
        [&self.before, &self.after]
            .iter()
            .any(|s| matches!(s, Side::Text(r) if r.waiting()))
    }

    /// Works out what is shown from what the sides hold. Called after each side changes.
    pub(crate) fn settle(&mut self) {
        self.shown = Shown::Nothing;
        if self.change.binary || self.waiting() {
            return;
        }
        // What a side contributes: `Absent` is the empty text, a side still unread or
        // refused contributes none.
        fn text(side: &Side) -> Option<&str> {
            match side {
                Side::Absent => Some(""),
                Side::Text(Read::Ready(t)) => Some(t.as_str()),
                Side::Text(_) => None,
            }
        }
        let readable = |side: &Side| matches!(side, Side::Text(Read::Ready(_)));
        self.shown = match (text(&self.before), text(&self.after)) {
            (Some(b), Some(a)) => compare(b, a),
            (Some(b), None) if readable(&self.before) => plain("Before", b),
            (None, Some(a)) if readable(&self.after) => plain("After", a),
            _ => Shown::Nothing,
        };
    }
}

fn too_big(text: &str) -> bool {
    text.len() > MAX_SIDE_BYTES || text.lines().count() > MAX_SIDE_LINES
}

/// A line of a file made safe to show: tabs are four spaces, every control or hidden
/// character is spelled out, and a very long line is cut and says how much it lost.
pub(crate) fn shape(line: &str) -> String {
    let expanded;
    let line = if line.contains('\t') {
        expanded = line.replace('\t', "    ");
        expanded.as_str()
    } else {
        line
    };
    let mut kept: String = line.chars().take(MAX_LINE_CHARS).collect();
    let lost = line.chars().count().saturating_sub(MAX_LINE_CHARS);
    kept = visible(&kept);
    if lost > 0 {
        kept.push_str(&format!(" [{lost} more characters not shown]"));
    }
    kept
}

/// A text's lines, shaped, without their line breaks.
fn lines_of(text: &str) -> Vec<String> {
    text.split_inclusive('\n')
        .map(|l| shape(l.strip_suffix('\n').unwrap_or(l)))
        .collect()
}

fn plain(side: &'static str, text: &str) -> Shown {
    if too_big(text) {
        return Shown::TooLarge;
    }
    let lines: Vec<DiffLine> = lines_of(text)
        .into_iter()
        .enumerate()
        .map(|(at, text)| DiffLine {
            kind: LineKind::Same,
            old: None,
            new: Some(at + 1),
            text,
            words: Vec::new(),
        })
        .collect();
    let header = format!("{side}: {} lines", lines.len());
    Shown::Plain {
        side,
        hunks: vec![Hunk { header, lines }],
    }
}

/// The before and after as hunks of lines with the changed words marked: the line diff
/// is `similar`'s, the words are the Changes panel's own `mark_words`.
fn compare(before: &str, after: &str) -> Shown {
    if before == after {
        return Shown::Same;
    }
    if too_big(before) || too_big(after) {
        return Shown::TooLarge;
    }
    let (old, new) = (lines_of(before), lines_of(after));
    let old_refs: Vec<&str> = old.iter().map(String::as_str).collect();
    let new_refs: Vec<&str> = new.iter().map(String::as_str).collect();
    let diff = TextDiff::from_slices(&old_refs, &new_refs);
    let mut hunks = Vec::new();
    for group in diff.grouped_ops(CONTEXT) {
        let header = UnifiedHunkHeader::new(&group).to_string();
        let mut lines = Vec::new();
        for op in &group {
            for change in diff.iter_changes(op) {
                let kind = match change.tag() {
                    ChangeTag::Equal => LineKind::Same,
                    ChangeTag::Delete => LineKind::Removed,
                    ChangeTag::Insert => LineKind::Added,
                };
                lines.push(DiffLine {
                    kind,
                    old: change.old_index().map(|i| i + 1),
                    new: change.new_index().map(|i| i + 1),
                    text: change.value().to_owned(),
                    words: Vec::new(),
                });
            }
        }
        mark_words(&mut lines);
        hunks.push(Hunk { header, lines });
    }
    if hunks.is_empty() {
        Shown::LineBreakOnly
    } else {
        Shown::Hunks(hunks)
    }
}

/// The owner's refusal in words, then its own code and reason as it said them. The
/// code is data: an unknown one is still shown.
pub(crate) fn refusal_words(code: &str, reason: &str) -> String {
    let words = match code {
        "no_such_delegation" => "The owner has no such delegation.",
        "disposed" => "This delegation was disposed of, so its changes are no longer kept.",
        "stale_account" => "The account has changed since this was opened.",
        "no_such_change" => "The delegation has no change for this file.",
        "binary_skipped" => "This file is binary: not shown as text.",
        "no_such_side" => "The file has no such side.",
        "no_longer_stored" => "The owner no longer stores this text.",
        "too_large" => "This text is too large to show.",
        "not_text" => "This file is not text: not shown as text.",
        _ => "The owner refused.",
    };
    visible(&format!("{words} ({code}: {reason})"))
}

/// A short mark for a change as the list shows it.
pub(crate) fn letter(change: DelegationChangeKind) -> char {
    match change {
        DelegationChangeKind::Add => 'A',
        DelegationChangeKind::Modify => 'M',
        DelegationChangeKind::Delete => 'D',
    }
}

/// A change in words.
pub(crate) fn change_word(change: DelegationChangeKind) -> String {
    match change {
        DelegationChangeKind::Add => "added",
        DelegationChangeKind::Modify => "modified",
        DelegationChangeKind::Delete => "deleted",
    }
    .to_owned()
}

/// What a file's side is, in words. `None`: nothing to say (it is read and shown, or it
/// is a side the file has not).
pub(crate) fn side_words(label: &str, side: &Side) -> Option<String> {
    let Side::Text(read) = side else { return None };
    match read {
        Read::Idle | Read::Loading => Some(format!("{label}: loading.")),
        Read::Ready(_) => None,
        Read::Refused { code, reason } => Some(format!("{label}: {}", refusal_words(code, reason))),
        Read::Failed(reason) => Some(visible(&format!("{label}: could not be read: {reason}"))),
        Read::Uncertain(reason) => Some(visible(&format!(
            "{label}: unknown whether it was read ({reason}). Press r to read again."
        ))),
        Read::Revoked => Some(format!(
            "{label}: access to this delegation was revoked, so nothing is shown."
        )),
    }
}

/// Everything the panel shows, apart from where it is scrolled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct State {
    pub run_id: String,
    pub delegation_id: String,
    /// The path the panel was opened on; empty for the whole delegation.
    pub opened_path: String,
    pub list: Read<Vec<DelegationChange>>,
    /// How many changed files the owner named past [`MAX_LISTED`].
    pub unlisted: usize,
    pub cursor: usize,
    pub file: Option<File>,
    /// A file to open as soon as the list says it is there: the one the panel was
    /// opened on, or the one a saved layout had open.
    pub want: Option<String>,
    /// Said above the list when a wanted file was not among the changes.
    pub notice: Option<String>,
    /// Bumped by every change a drawing depends on.
    pub version: u64,
}

impl State {
    pub(crate) fn new(run_id: &str, delegation_id: &str, path: &str) -> Self {
        Self {
            run_id: run_id.to_owned(),
            delegation_id: delegation_id.to_owned(),
            opened_path: path.to_owned(),
            list: Read::Idle,
            unlisted: 0,
            cursor: 0,
            file: None,
            want: (!path.is_empty()).then(|| path.to_owned()),
            notice: None,
            version: 0,
        }
    }

    pub(crate) fn touch(&mut self) {
        self.version += 1;
    }

    pub(crate) fn changes(&self) -> &[DelegationChange] {
        match &self.list {
            Read::Ready(changes) => changes,
            _ => &[],
        }
    }

    pub(crate) fn current(&self) -> Option<&DelegationChange> {
        self.changes().get(self.cursor)
    }

    /// The answer to the list read, kept as the owner gave it up to [`MAX_LISTED`].
    pub(crate) fn set_list(&mut self, mut changes: Vec<DelegationChange>) {
        self.unlisted = changes.len().saturating_sub(MAX_LISTED);
        changes.truncate(MAX_LISTED);
        let keep = self.file.as_ref().map(|f| f.change.path.clone());
        self.list = Read::Ready(changes);
        self.cursor = keep
            .and_then(|p| self.changes().iter().position(|c| c.path == p))
            .unwrap_or(self.cursor)
            .min(self.changes().len().saturating_sub(1));
        self.touch();
    }

    /// The list line that says how the list stands, or what the owner said.
    pub(crate) fn list_words(&self) -> String {
        match &self.list {
            Read::Idle | Read::Loading => "Loading the files this delegation changed.".to_owned(),
            Read::Ready(changes) if changes.is_empty() => {
                "This delegation changed no files.".to_owned()
            }
            Read::Ready(changes) => {
                let n = changes.len() + self.unlisted;
                let noun = if n == 1 { "file" } else { "files" };
                let more = if self.unlisted > 0 {
                    format!(" {} are not listed here.", self.unlisted)
                } else {
                    String::new()
                };
                format!("{n} {noun} changed.{more} Enter shows a file's before and after.")
            }
            Read::Refused { code, reason } => format!(
                "The changes could not be read. {}",
                refusal_words(code, reason)
            ),
            Read::Failed(reason) => visible(&format!("The changes could not be read: {reason}")),
            Read::Uncertain(reason) => visible(&format!(
                "Unknown whether the changes were read ({reason}). Press r to read again."
            )),
            Read::Revoked => {
                "Access to this delegation was revoked, so nothing is shown.".to_owned()
            }
        }
    }

    /// The open file's line of words about the file itself.
    pub(crate) fn file_words(file: &File) -> String {
        let change = change_word(file.change.change);
        let mut words = if file.change.binary {
            format!("{change}. This file is binary: not shown as text.")
        } else if !file.change.has_before && file.change.has_after {
            format!("{change}. There is no before: the file did not exist, so every line is new.")
        } else if file.change.has_before && !file.change.has_after {
            format!("{change}. There is no after: the file was removed, so every line is gone.")
        } else if !file.change.has_before && !file.change.has_after {
            format!("{change}. The owner has neither a before nor an after for it.")
        } else {
            format!("{change}.")
        };
        match &file.shown {
            Shown::Same => words.push_str(" The before and after are the same text."),
            Shown::LineBreakOnly => {
                words.push_str(" The lines are the same: only the final line break differs.");
            }
            Shown::TooLarge => words.push_str(&format!(
                " Too large to compare here (over {} KiB or {} lines on a side).",
                MAX_SIDE_BYTES / 1024,
                MAX_SIDE_LINES
            )),
            Shown::Nothing if file.waiting() => {
                words.push_str(" Loading the before and after.");
            }
            _ => {}
        }
        words
    }
}
