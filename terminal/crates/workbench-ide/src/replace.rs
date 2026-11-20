//! Replace across the workspace, from the results of a finished search.
//!
//! The search owner says where each match is: a line, the text of the row, the UTF-16
//! range of every match in it. Nothing here searches again and nothing here reads a
//! pattern: the replacement is inserted exactly as typed, in every mode (the owner gives
//! no capture groups, so `$1` is three literal characters). What this module owns is the
//! plan the person confirms, the check that each match is still where the search said,
//! and the walk over the files through the documents owner, one file at a time:
//!
//! 1. `documentOpen`: the owner's current text and revision, or its refusal;
//! 2. every confirmed match is looked for where the search said it was (else the file is
//!    skipped as changed since the search), and a file the owner reports unsaved,
//!    unsettled or read-only is skipped with the owner's words;
//! 3. one `documentEdit` with all of the file's changes against the opened revision;
//! 4. `documentSave` at the revision the owner accepted the edit at;
//! 5. `documentClose` (and `documentSettle` for an edit the owner refused), without
//!    waiting: the answer to those is of no use to the next file.
//!
//! After an uncertain outcome nothing more is sent for that file, not a retry, not a
//! release: the owner may have applied it. A refusal, a failure or an uncertain answer is
//! put in the summary and the run goes on with the next file.

use std::collections::BTreeMap;

use ropey::Rope;
use theorem_workbench_core::completion::{Completion, CompletionPayload, DocumentOpened, Outcome};
use theorem_workbench_core::effect::{
    CoordinateUnit, DocumentEdit, DocumentOpen, DocumentSettle, Effect, EffectBody,
    TextChange as CoreChange,
};
use theorem_workbench_core::ids::{EffectId, Generation, ResourceRef, Revision};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_text::visible::visible;
use theorem_workbench_text::{Coords, Snap, TextChange, Unit};

/// One result row, as the search owner delivered it. `matches` are UTF-16 ranges in `text`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Row {
    pub line: u32,
    pub text: String,
    pub matches: Vec<(u32, u32)>,
    /// UTF-16 units the owner cut from the start of the line before `text`.
    pub text_offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Group {
    pub path: String,
    pub rows: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    All,
    File(String),
}

/// What the person is asked to confirm: the rows that will change, frozen from the results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    pub scope: Scope,
    pub replacement: String,
    pub files: Vec<Group>,
    pub matches: usize,
    /// Rows the search marked no range in: nothing to place, so left alone.
    pub unmarked: usize,
}

impl Plan {
    pub(crate) fn new(groups: &[Group], scope: Scope, replacement: &str) -> Self {
        let mut files = Vec::new();
        let (mut matches, mut unmarked) = (0, 0);
        for group in groups {
            if matches!(&scope, Scope::File(path) if *path != group.path) {
                continue;
            }
            let rows: Vec<Row> = group
                .rows
                .iter()
                .filter(|r| {
                    let marked = !r.matches.is_empty();
                    unmarked += usize::from(!marked);
                    marked
                })
                .cloned()
                .collect();
            if rows.is_empty() {
                continue;
            }
            matches += rows.iter().map(|r| r.matches.len()).sum::<usize>();
            files.push(Group {
                path: group.path.clone(),
                rows,
            });
        }
        Self {
            scope,
            replacement: replacement.to_owned(),
            files,
            matches,
            unmarked,
        }
    }

    pub(crate) fn file_count(&self) -> usize {
        self.files.len()
    }

    /// The question the person answers, with the numbers the run will act on.
    pub(crate) fn question(&self) -> String {
        let n = self.matches;
        let f = self.file_count();
        let what = if self.replacement.is_empty() {
            "Delete (replace with nothing)".to_owned()
        } else {
            "Replace".to_owned()
        };
        let with = if self.replacement.is_empty() {
            String::new()
        } else {
            format!(" with \"{}\"", visible(&self.replacement))
        };
        let scope = match &self.scope {
            Scope::All => String::new(),
            Scope::File(path) => format!(" ({})", visible(path)),
        };
        format!(
            "{what} {n} {} in {f} {}{scope}{with}? Enter replaces and saves each file, one at a time. Esc cancels.",
            plural(n, "match", "matches"),
            plural(f, "file", "files"),
        )
    }
}

pub(crate) fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// The byte index of UTF-16 offset `unit` in `text`, `None` past the end or inside a pair.
fn byte_at(text: &str, unit: u32) -> Option<usize> {
    let mut at = 0u32;
    for (i, c) in text.char_indices() {
        if at == unit {
            return Some(i);
        }
        if at > unit {
            return None;
        }
        at += c.len_utf16() as u32;
    }
    (at == unit).then_some(text.len())
}

fn slice16(text: &str, from: u32, to: u32) -> Option<&str> {
    text.get(byte_at(text, from)?..byte_at(text, to)?)
}

fn len16(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// A row's text with its matches replaced, as the preview shows it.
pub(crate) fn replaced(row: &Row, replacement: &str) -> String {
    let mut out = String::new();
    let mut at = 0u32;
    for &(s, e) in &row.matches {
        if let (Some(head), Some(_)) = (slice16(&row.text, at, s), slice16(&row.text, s, e)) {
            out.push_str(head);
            out.push_str(replacement);
            at = e;
        }
    }
    out.push_str(slice16(&row.text, at, len16(&row.text)).unwrap_or(""));
    out
}

/// Why a file no longer holds what the search read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Moved(pub String);

/// The changes for one file against `text` (the owner's text now), each match checked to be
/// exactly where the search said: the line is there, it still reads what the row says from
/// the same column, and the marked range is inside it.
pub(crate) fn changes_for(
    file: &Group,
    text: &str,
    replacement: &str,
) -> Result<Vec<TextChange>, Moved> {
    let rope = Rope::from_str(text);
    let coords = Coords::new(&rope);
    let mut out: Vec<TextChange> = Vec::new();
    for row in &file.rows {
        let moved = |why: &str| Moved(format!("changed since the search: line {} {why}", row.line));
        let Some((start, end)) = (row.line as usize)
            .checked_sub(1)
            .and_then(|l| coords.line_range(l))
        else {
            return Err(moved("is no longer in the file"));
        };
        let line = rope.slice(start..end).to_string();
        let base = coords
            .from_scalar(start, Unit::Utf16)
            .ok_or_else(|| moved("is no longer in the file"))?;
        // A CR the owner left on the row is not part of what was matched.
        let want = row.text.strip_suffix('\r').unwrap_or(&row.text);
        let from = row.text_offset;
        if slice16(&line, from, from + len16(want)) != Some(want) {
            return Err(moved("no longer reads what the search found"));
        }
        for &(s, e) in &row.matches {
            if s > e || e > len16(want) {
                return Err(moved("has a match outside the row the search read"));
            }
            let (s, e) = (
                base + from as usize + s as usize,
                base + from as usize + e as usize,
            );
            // The ends must be characters' edges in the owner's text.
            let ok = |o: usize| {
                coords
                    .to_scalar(o, Unit::Utf16, Snap::Backward)
                    .and_then(|sc| coords.from_scalar(sc, Unit::Utf16))
                    == Some(o)
            };
            if !ok(s) || !ok(e) {
                return Err(moved("has a match that splits a character"));
            }
            if out.last().is_some_and(|p| s < p.end) {
                return Err(moved("has matches that overlap"));
            }
            out.push(TextChange::new(s, e, replacement));
        }
    }
    Ok(out)
}

// ---- the run -------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Done {
    Changed(usize),
    Skipped(String),
    Failed(String),
    Unknown(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub path: String,
    pub result: Done,
    /// The file was done but the owner could not be told to let go of it.
    pub release: Option<String>,
}

/// A request owed to the owner: sent (`sent`) or waiting to be.
#[derive(Clone, Debug)]
struct Slot {
    sent: Option<EffectId>,
    body: EffectBody,
    revision: Option<Revision>,
}

impl Slot {
    fn new(body: EffectBody, revision: Option<Revision>) -> Self {
        Self {
            sent: None,
            body,
            revision,
        }
    }
}

#[derive(Clone, Debug)]
enum Stage {
    /// Nothing is owed: the next file opens on the next tick.
    Between,
    Open(Slot),
    Edit {
        slot: Slot,
        op: String,
        matches: usize,
    },
    Save {
        slot: Slot,
        matches: usize,
    },
}

pub(crate) struct Run {
    pub plan: Plan,
    workspace: String,
    generation: Generation,
    /// The file being worked on, or the next to open.
    index: usize,
    stage: Stage,
    pub stopping: bool,
    stop_note: Option<String>,
    /// A file just ended: the next opens on a tick, so there is a moment to stop between.
    cooling: bool,
    entries: Vec<Entry>,
    releasing: BTreeMap<EffectId, usize>,
    owed: Vec<(usize, EffectBody)>,
    id: u64,
    pub notice: Option<String>,
}

/// How a run ended, to stay on screen until dismissed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Summary {
    pub replacement: String,
    pub entries: Vec<Entry>,
    pub not_started: Vec<String>,
    pub stop_note: Option<String>,
}

fn told(step: &str, outcome: &Outcome) -> String {
    match outcome {
        Outcome::Refused { code, reason } => {
            format!("{step} refused ({}): {}", visible(code), visible(reason))
        }
        Outcome::Failed { reason } => format!("{step} failed: {}", visible(reason)),
        Outcome::Uncertain { reason } => format!("{step}: unknown ({})", visible(reason)),
        Outcome::Accepted => format!("{step} was accepted"),
    }
}

/// Files that were open with work the owner knows is not settled are left alone.
fn unsettled(o: &DocumentOpened) -> Option<String> {
    if let Some(r) = &o.read_only {
        return Some(format!("read-only: {}", visible(&r.reason)));
    }
    if !o.pending.is_empty() {
        let first = o.pending[0].reason.as_deref().unwrap_or("no reason given");
        return Some(format!(
            "the owner holds {} unsettled {} for it ({:?}: {})",
            o.pending.len(),
            plural(o.pending.len(), "edit", "edits"),
            o.pending[0].state,
            visible(first)
        ));
    }
    if o.dirty {
        return Some("it has unsaved changes (the owner reports it dirty)".to_owned());
    }
    None
}

impl Run {
    pub(crate) fn new(plan: Plan, workspace: &str, generation: Generation, id: u64) -> Self {
        Self {
            plan,
            workspace: workspace.to_owned(),
            generation,
            index: 0,
            stage: Stage::Between,
            stopping: false,
            stop_note: None,
            cooling: false,
            entries: vec![],
            releasing: BTreeMap::new(),
            owed: vec![],
            id,
            notice: None,
        }
    }

    pub(crate) fn current(&self) -> Option<&Group> {
        self.plan.files.get(self.index)
    }

    pub(crate) fn position(&self) -> (usize, usize) {
        (
            (self.index + 1).min(self.plan.file_count()),
            self.plan.file_count(),
        )
    }

    pub(crate) fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The person stops it: no file starts after the one in hand.
    pub(crate) fn stop(&mut self, why: &str) {
        self.stopping = true;
        self.stop_note.get_or_insert_with(|| why.to_owned());
    }

    pub(crate) fn finished(&self) -> bool {
        matches!(self.stage, Stage::Between)
            && (self.stopping || self.index >= self.plan.file_count())
    }

    pub(crate) fn tick(&mut self) {
        self.cooling = false;
    }

    pub(crate) fn summary(self) -> Summary {
        let not_started = self.plan.files[self.index.min(self.plan.files.len())..]
            .iter()
            .map(|g| g.path.clone())
            .collect();
        Summary {
            replacement: self.plan.replacement,
            entries: self.entries,
            not_started,
            stop_note: self.stop_note,
        }
    }

    fn resource(&self, path: &str) -> ResourceRef {
        ResourceRef::Document {
            workspace: self.workspace.clone(),
            resource_id: path.to_owned(),
        }
    }

    fn finish_file(&mut self, result: Done, release: Vec<EffectBody>) {
        let path = self.plan.files[self.index].path.clone();
        self.entries.push(Entry {
            path,
            result,
            release: None,
        });
        let at = self.entries.len() - 1;
        self.owed.extend(release.into_iter().map(|b| (at, b)));
        self.index += 1;
        self.stage = Stage::Between;
        self.cooling = true;
    }

    fn close() -> EffectBody {
        EffectBody::DocumentClose
    }

    /// Emits what is owed. Called after every message that may start work.
    pub(crate) fn pump(&mut self, cx: &mut Ctx) {
        // Letting go of a file does not wait for anything.
        let owed = std::mem::take(&mut self.owed);
        for (at, body) in owed {
            let resource = self.resource(&self.entries[at].path);
            match self.emit(cx, resource, body.clone(), None) {
                Ok(id) => {
                    self.releasing.insert(id, at);
                }
                Err(e) => self.not_sent(e, Some((at, body))),
            }
        }
        if matches!(self.stage, Stage::Between)
            && !self.stopping
            && !self.cooling
            && self.index < self.plan.file_count()
        {
            self.stage = Stage::Open(Slot::new(
                EffectBody::DocumentOpen(DocumentOpen { seed_text: None }),
                None,
            ));
        }
        let Some(path) = self.current().map(|g| g.path.clone()) else {
            return;
        };
        let resource = self.resource(&path);
        let slot = match &mut self.stage {
            Stage::Open(s) | Stage::Edit { slot: s, .. } | Stage::Save { slot: s, .. } => s,
            Stage::Between => return,
        };
        if slot.sent.is_some() {
            return;
        }
        let (body, revision) = (slot.body.clone(), slot.revision.clone());
        match self.emit(cx, resource, body, revision) {
            Ok(id) => {
                if let Stage::Open(s) | Stage::Edit { slot: s, .. } | Stage::Save { slot: s, .. } =
                    &mut self.stage
                {
                    s.sent = Some(id);
                }
                self.notice = None;
            }
            Err(e) => self.not_sent(e, None),
        }
    }

    fn emit(
        &self,
        cx: &mut Ctx,
        resource: ResourceRef,
        body: EffectBody,
        revision: Option<Revision>,
    ) -> Result<EffectId, EmitError> {
        let generation = self.generation;
        cx.emit(|id| {
            let mut e = Effect::new(id, resource, body).with_generation(generation);
            if let Some(r) = revision {
                e = e.with_revision(r);
            }
            e
        })
    }

    /// A request that could not be emitted was never sent, so it waits for the next try.
    fn not_sent(&mut self, error: EmitError, release: Option<(usize, EffectBody)>) {
        if let Some(r) = release {
            self.owed.push(r);
        }
        if !matches!(error, EmitError::Silent) {
            self.notice = Some(format!("Not sent yet: {error}. It is tried again."));
        }
    }

    /// An answer to a request of this run. False: it is not one, and nothing changed.
    pub(crate) fn on_completion(&mut self, c: &Completion) -> bool {
        if let Some(at) = self.releasing.remove(&c.effect) {
            if !matches!(c.outcome, Outcome::Accepted) {
                let reason = told("letting go of the file", &c.outcome);
                if let Some(e) = self.entries.get_mut(at) {
                    e.release = Some(reason);
                }
            }
            return true;
        }
        let sent = match &self.stage {
            Stage::Open(s) | Stage::Edit { slot: s, .. } | Stage::Save { slot: s, .. } => s.sent,
            Stage::Between => None,
        };
        if sent != Some(c.effect) {
            return false;
        }
        if c.outcome.is_access_revoked() {
            self.stop("Access was revoked, so the run stopped.");
        }
        match std::mem::replace(&mut self.stage, Stage::Between) {
            Stage::Open(_) => self.opened(c),
            Stage::Edit { op, matches, .. } => self.edited(c, &op, matches),
            Stage::Save { matches, .. } => self.saved(c, matches),
            Stage::Between => {}
        }
        true
    }

    fn opened(&mut self, c: &Completion) {
        let o = match (&c.outcome, &c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentOpened(o))) => o.clone(),
            (Outcome::Accepted, _) => {
                return self.finish_file(
                    Done::Failed("the owner accepted the open and sent no text".into()),
                    vec![Self::close()],
                );
            }
            (Outcome::Refused { .. }, _) => {
                return self.finish_file(Done::Skipped(told("opening it", &c.outcome)), vec![]);
            }
            (Outcome::Failed { .. }, _) => {
                return self.finish_file(Done::Failed(told("opening it", &c.outcome)), vec![]);
            }
            (Outcome::Uncertain { reason }, _) => {
                return self.finish_file(
                    Done::Unknown(format!(
                        "whether it opened is unknown ({}); nothing was sent after it",
                        visible(reason)
                    )),
                    vec![],
                );
            }
        };
        if let Some(why) = unsettled(&o) {
            return self.finish_file(Done::Skipped(why), vec![Self::close()]);
        }
        let file = self.plan.files[self.index].clone();
        match changes_for(&file, &o.text, &self.plan.replacement) {
            Err(Moved(why)) => self.finish_file(Done::Skipped(why), vec![Self::close()]),
            Ok(changes) => {
                if changes.iter().any(|c| c.end > u32::MAX as usize) {
                    return self.finish_file(
                        Done::Skipped("too large to place the edit".into()),
                        vec![Self::close()],
                    );
                }
                let matches = changes.len();
                let op = format!("search-replace.{}.{}", self.id, self.index);
                let body = EffectBody::DocumentEdit(DocumentEdit {
                    operation_id: op.clone(),
                    unit: CoordinateUnit::Utf16,
                    edits: changes
                        .into_iter()
                        .map(|c| CoreChange {
                            start: c.start as u32,
                            end: c.end as u32,
                            insert: c.insert,
                        })
                        .collect(),
                });
                self.stage = Stage::Edit {
                    slot: Slot::new(body, Some(o.revision)),
                    op,
                    matches,
                };
            }
        }
    }

    fn edited(&mut self, c: &Completion, op: &str, matches: usize) {
        match (&c.outcome, &c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentEdited(e))) => {
                self.stage = Stage::Save {
                    slot: Slot::new(EffectBody::DocumentSave, Some(e.revision.clone())),
                    matches,
                };
            }
            (Outcome::Accepted, _) => self.finish_file(
                Done::Unknown(
                    "the owner accepted the edit but gave no revision to save; nothing was sent after it"
                        .into(),
                ),
                vec![],
            ),
            (Outcome::Uncertain { reason }, _) => self.finish_file(
                Done::Unknown(format!(
                    "whether the edit was applied is unknown ({}); nothing was sent after it",
                    visible(reason)
                )),
                vec![],
            ),
            (Outcome::Refused { .. }, _) => self.finish_file(
                Done::Skipped(format!("{}; nothing was changed", told("the edit", &c.outcome))),
                vec![
                    EffectBody::DocumentSettle(DocumentSettle {
                        operation_id: op.to_owned(),
                    }),
                    Self::close(),
                ],
            ),
            (Outcome::Failed { .. }, _) => self.finish_file(
                Done::Failed(format!("{}; nothing was changed", told("the edit", &c.outcome))),
                vec![
                    EffectBody::DocumentSettle(DocumentSettle {
                        operation_id: op.to_owned(),
                    }),
                    Self::close(),
                ],
            ),
        }
    }

    fn saved(&mut self, c: &Completion, matches: usize) {
        const APPLIED: &str = "the edit was applied but is not saved";
        match &c.outcome {
            Outcome::Accepted => self.finish_file(Done::Changed(matches), vec![Self::close()]),
            Outcome::Refused { .. } => self.finish_file(
                Done::Skipped(format!("{APPLIED}: {}", told("the save", &c.outcome))),
                vec![Self::close()],
            ),
            Outcome::Failed { .. } => self.finish_file(
                Done::Failed(format!("{APPLIED}: {}", told("the save", &c.outcome))),
                vec![Self::close()],
            ),
            Outcome::Uncertain { reason } => self.finish_file(
                Done::Unknown(format!(
                    "the edit was applied; whether it was saved is unknown ({}); nothing was sent after it",
                    visible(reason)
                )),
                vec![],
            ),
        }
    }
}

// ---- words ---------------------------------------------------------------------------------

impl Entry {
    pub(crate) fn words(&self) -> String {
        let path = visible(&self.path);
        let base = match &self.result {
            Done::Changed(n) => format!(
                "{path}: {n} {} replaced and saved",
                plural(*n, "match", "matches")
            ),
            Done::Skipped(r) | Done::Failed(r) | Done::Unknown(r) => {
                format!("{path}: {r}")
            }
        };
        match &self.release {
            Some(r) => format!("{base} ({r})"),
            None => base,
        }
    }
}

impl Summary {
    fn of(&self, f: impl Fn(&Done) -> bool) -> Vec<&Entry> {
        self.entries.iter().filter(|e| f(&e.result)).collect()
    }

    pub(crate) fn changed(&self) -> Vec<&Entry> {
        self.of(|r| matches!(r, Done::Changed(_)))
    }
    pub(crate) fn skipped(&self) -> Vec<&Entry> {
        self.of(|r| matches!(r, Done::Skipped(_)))
    }
    pub(crate) fn failed(&self) -> Vec<&Entry> {
        self.of(|r| matches!(r, Done::Failed(_)))
    }
    pub(crate) fn unknown(&self) -> Vec<&Entry> {
        self.of(|r| matches!(r, Done::Unknown(_)))
    }

    /// The headline: what happened, in counts.
    pub(crate) fn headline(&self) -> String {
        let changed = self.changed();
        let n: usize = changed
            .iter()
            .map(|e| match e.result {
                Done::Changed(n) => n,
                _ => 0,
            })
            .sum();
        let mut s = format!(
            "{} {} changed ({n} {}), {} skipped, {} failed, {} unknown",
            changed.len(),
            plural(changed.len(), "file", "files"),
            plural(n, "match", "matches"),
            self.skipped().len(),
            self.failed().len(),
            self.unknown().len(),
        );
        if !self.not_started.is_empty() {
            s.push_str(&format!(", {} not started", self.not_started.len()));
        }
        s.push('.');
        if let Some(note) = &self.stop_note {
            s.push(' ');
            s.push_str(note);
        }
        s.push_str(" Enter or Esc dismisses this.");
        s
    }
}
