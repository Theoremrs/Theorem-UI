//! A text session kept in step with the owner of its document.
//!
//! [`OwnerSync`] is the state machine every front end of an owner's document
//! needs and none should write twice: the session's edits go out one at a
//! time and in order, each with its base revision and operation id; the
//! owner's answer to one is accepted, refused (held for the person to
//! settle), failed, or unknown; the owner's own changes, resyncs, conflicts,
//! saves and disk changes come in on the host stream. It draws nothing and
//! emits nothing: it says what is owed ([`Owed`]) and what an answer meant
//! ([`Step`]), and the panel does the emitting and the showing.
//!
//! A panel holds one `OwnerSync` beside its [`EditSession`], and:
//!
//! 1. after any message, asks [`owed`](OwnerSync::owed) and emits what it
//!    names; when the emit fails it says so with
//!    [`edit_not_sent`](OwnerSync::edit_not_sent) or
//!    [`save_not_sent`](OwnerSync::save_not_sent);
//! 2. gives the answer to an edit, a save or a reconcile to
//!    [`edit_answered`](OwnerSync::edit_answered),
//!    [`save_answered`](OwnerSync::save_answered) or
//!    [`reconcile_answered`](OwnerSync::reconcile_answered);
//! 3. gives each host message for its document to [`host`](OwnerSync::host);
//! 4. settles held text with [`resolve`](OwnerSync::resolve), and emits the
//!    `DocumentSettle` for each operation in the [`Step`] it returns.

use theorem_workbench_core::completion::{
    Completion, CompletionPayload, Outcome, PendingEdit as WireEdit, PendingState as WireState,
};
use theorem_workbench_core::effect::{
    CoordinateUnit, DocumentEdit, ReconcileKeep, TextChange as CoreChange,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::Revision as CoreRevision;
use theorem_workbench_text::recovery;
use theorem_workbench_text::{EditSession, LocalEdit, OpId, Resolution, SyncError, TextChange};

use crate::sync::{Changed, apply_owner_change, resync, step_before};

/// A core revision as a number, when the owner numbers its revisions in
/// order. An opaque token cannot be compared, and a session needs to.
pub fn revision_number(r: &CoreRevision) -> Option<u64> {
    match r {
        CoreRevision::Seq(n) => Some(*n),
        CoreRevision::Opaque(_) => None,
    }
}

/// A length where a text would be: what a `Debug` of anything that holds the
/// document's text prints in its place, so a log line never carries it.
pub(crate) struct Withheld(pub usize);

impl std::fmt::Debug for Withheld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<{} bytes withheld>", self.0)
    }
}

/// Text the owner refused, held in the session until the person chooses.
#[derive(Clone)]
pub struct Held {
    pub reason: String,
    /// What the owner has now where the person's edit was. `None` when the
    /// refusal was not a conflict, or the owner sent no current text.
    pub theirs: Option<Changed>,
    pub conflict: bool,
}

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Held")
            .field("reason", &self.reason)
            .field("theirs", &self.theirs)
            .field("conflict", &self.conflict)
            .finish()
    }
}

/// Edits the owner got back from this device's checkpoint after a reload. It
/// sends none of them on its own and refuses new edits until each is settled,
/// so nothing goes out until the person chooses.
#[derive(Clone)]
pub struct Restored {
    /// The owner's operation ids, each settled once the person has chosen.
    pub ops: Vec<String>,
    /// Why the edits were not put into the text: they were made against a
    /// revision other than the one the document opened at (or against text
    /// these ranges do not fit), so placing them would be a guess.
    pub moved_from: Option<String>,
    /// What the edits insert, so the person can copy it.
    pub text: String,
    pub reason: Option<String>,
}

impl std::fmt::Debug for Restored {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Restored")
            .field("ops", &self.ops)
            .field("moved_from", &self.moved_from)
            .field("text", &Withheld(self.text.len()))
            .field("reason", &self.reason)
            .finish()
    }
}

/// The file on disk changed under the document.
#[derive(Clone, Debug)]
pub struct Disk {
    pub revision: u64,
    pub deleted: bool,
}

/// An edit the owner was asked to take and has not said it did: it may have.
#[derive(Clone, Debug)]
pub struct Unknown {
    pub op: OpId,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct Saving {
    /// A save is wanted once the pending edits are accepted.
    pub wanted: bool,
    /// The revision of the save in flight.
    pub inflight: Option<u64>,
    /// The last save's outcome is unknown.
    pub unknown: Option<String>,
}

/// How much a [`Note`] matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

/// Something to tell the person, from a transition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub text: String,
    pub level: Level,
}

/// What a transition did, for the panel to act on.
#[derive(Debug, Default)]
pub struct Step {
    /// The session's text changed other than by typing: redraw, search again.
    pub text_changed: bool,
    /// What to say; the last one is the current word.
    pub notes: Vec<Note>,
    /// Recovered operations the person has now chosen about: send a
    /// `DocumentSettle` for each, and hold every new edit back until each is
    /// answered.
    pub settle_restored: Vec<String>,
    /// Held operations the session has now dealt with: send a
    /// `DocumentSettle` for each so the owner lets go of them.
    pub settle: Vec<OpId>,
}

impl Step {
    fn say(&mut self, level: Level, text: impl Into<String>) {
        self.notes.push(Note {
            text: text.into(),
            level,
        });
    }
}

/// What is owed to the owner now.
pub enum Owed {
    /// Send this edit, against `base`. It is marked in flight.
    Edit {
        op: OpId,
        base: u64,
        body: DocumentEdit,
    },
    /// Send a save of `revision`. It is marked in flight.
    Save { revision: u64 },
}

impl std::fmt::Debug for Owed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Edit { op, base, body } => f
                .debug_struct("Edit")
                .field("op", op)
                .field("base", base)
                .field("changes", &body.edits.len())
                .finish(),
            Self::Save { revision } => f.debug_struct("Save").field("revision", revision).finish(),
        }
    }
}

#[derive(Default)]
pub struct OwnerSync {
    /// The revision the owner says the checkout holds. `None`: unknown, which
    /// counts as modified.
    pub saved: Option<u64>,
    /// Why the document takes no edits, when it does not.
    pub read_only: Option<String>,
    /// The edit the owner has been asked to take.
    pub inflight: Option<OpId>,
    pub unknown: Option<Unknown>,
    /// The text is behind the owner's: no edit is sent until its resync.
    pub desync: Option<String>,
    pub held: Option<Held>,
    pub disk: Option<Disk>,
    pub save: Saving,
    /// The whole text from before "take theirs", kept so it can be copied.
    pub recoverable: Option<String>,
    /// Edits recovered from this device, waiting for the person's choice.
    pub restored: Option<Restored>,
    /// Settles of recovered operations not yet answered. The owner refuses
    /// edits until each is, so none goes out meanwhile.
    pub settling: usize,
}

impl std::fmt::Debug for OwnerSync {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnerSync")
            .field("saved", &self.saved)
            .field("read_only", &self.read_only)
            .field("inflight", &self.inflight)
            .field("unknown", &self.unknown)
            .field("desync", &self.desync)
            .field("held", &self.held)
            .field("disk", &self.disk)
            .field("save", &self.save)
            .field(
                "recoverable",
                &self.recoverable.as_ref().map(|t| Withheld(t.len())),
            )
            .field("restored", &self.restored)
            .field("settling", &self.settling)
            .finish()
    }
}

const BEHIND: &str = "waiting for the owner's resync.";

fn core_changes(edit: &LocalEdit) -> Vec<CoreChange> {
    edit.changes
        .iter()
        .map(|c| CoreChange {
            start: c.start as u32,
            end: c.end as u32,
            insert: c.insert.clone(),
        })
        .collect()
}

impl OwnerSync {
    /// A document opened clean (`saved` is the revision) or modified (`None`).
    pub fn new(saved: Option<u64>) -> Self {
        Self {
            saved,
            ..Self::default()
        }
    }

    /// Unsaved changes: edits not yet accepted, or text past the saved revision.
    pub fn dirty(&self, session: &EditSession) -> bool {
        session.has_pending() || self.saved != Some(session.accepted_revision())
    }

    /// Mark the document read-only, from the owner's word.
    pub fn make_read_only(&mut self, session: &mut EditSession, reason: impl Into<String>) {
        session.set_read_only(true);
        self.read_only = Some(reason.into());
    }

    // ---- sending ----------------------------------------------------------

    /// What to send now: the next edit when none is in flight and nothing is
    /// unknown, then a wanted save once every edit is accepted. Nothing while
    /// the text is behind the owner's.
    pub fn owed(&mut self, session: &mut EditSession) -> Option<Owed> {
        if self.desync.is_some() || self.restored.is_some() || self.settling > 0 {
            return None;
        }
        if self.inflight.is_none()
            && self.unknown.is_none()
            && let Some(edit) = session.take_next_to_send()
        {
            let op = edit.op_id.clone();
            let body = DocumentEdit {
                operation_id: op.0.clone(),
                unit: CoordinateUnit::Utf16,
                edits: core_changes(&edit),
            };
            self.inflight = Some(op.clone());
            return Some(Owed::Edit {
                op,
                base: edit.base_revision,
                body,
            });
        }
        if self.inflight.is_none()
            && self.save.wanted
            && self.save.inflight.is_none()
            && !session.has_pending()
            && !session.has_conflict()
        {
            let revision = session.accepted_revision();
            self.save.wanted = false;
            self.save.inflight = Some(revision);
            self.save.unknown = None;
            return Some(Owed::Save { revision });
        }
        None
    }

    /// The edit named by [`owed`](Self::owed) could not be emitted: it goes
    /// back to be sent again.
    pub fn edit_not_sent(&mut self, session: &mut EditSession, op: &OpId) {
        self.inflight = None;
        let _ = session.requeue(op);
    }

    /// The save named by [`owed`](Self::owed) could not be emitted.
    pub fn save_not_sent(&mut self) {
        self.save.inflight = None;
        self.save.wanted = true;
    }

    /// Ask for a save: it goes once the owner has accepted every edit.
    pub fn want_save(&mut self) {
        self.save.wanted = true;
    }

    /// Call after every message: a save of an older revision is judged stale
    /// once edits are accepted past it, so its answer will not come.
    pub fn settle_stale_save(&mut self, session: &EditSession) {
        if self
            .save
            .inflight
            .is_some_and(|r| r < session.accepted_revision())
        {
            self.save.inflight = None;
        }
    }

    // ---- edits recovered from this device -----------------------------------

    /// Take the owner's restored edits (`pending` of the open) over the text
    /// opened at `opened`. When they were made against that revision, on the
    /// text the session shows, they go into it as held text: seen, and sent by
    /// nobody. Otherwise they are not placed, only kept to be chosen about.
    /// The undo history starts after the recovery either way.
    pub fn recover(
        &mut self,
        session: &mut EditSession,
        pending: &[WireEdit],
        opened: u64,
        fresh: bool,
    ) -> Option<Note> {
        let kept: Vec<&WireEdit> = pending
            .iter()
            .filter(|p| p.state == WireState::Restored)
            .collect();
        if kept.is_empty() {
            return None;
        }
        let sets: Vec<Vec<TextChange>> = kept
            .iter()
            .map(|p| {
                p.edits
                    .iter()
                    .map(|e| TextChange {
                        start: e.start as usize,
                        end: e.end as usize,
                        insert: e.insert.clone(),
                    })
                    .collect()
            })
            .collect();
        let text = recovery::recovered_text(&sets);
        let reason = kept.iter().find_map(|p| p.reason.clone());
        let mut moved_from = kept.iter().find_map(|p| match &p.base_revision {
            CoreRevision::Seq(n) if *n == opened && fresh => None,
            CoreRevision::Seq(n) if *n == opened => Some("the editor's own unsent text".to_owned()),
            CoreRevision::Seq(n) => Some(format!("revision {n}")),
            CoreRevision::Opaque(t) => Some(format!("revision {t}")),
        });
        if moved_from.is_none() {
            // Tried on a copy of the text first: every set fits, or none goes in.
            if let Err(e) = recovery::fits(&session.text(), &sets) {
                moved_from = Some(format!("text these ranges do not fit ({e})"));
            } else if let Some(op) = recovery::place(session, &sets) {
                let why = reason
                    .clone()
                    .unwrap_or_else(|| "recovered from this device".to_owned());
                let _ = session.refuse(&op, why);
            }
        }
        let placed = moved_from.is_none();
        self.restored = Some(Restored {
            ops: kept.iter().map(|p| p.operation_id.clone()).collect(),
            moved_from,
            text,
            reason,
        });
        Some(Note {
            text: if placed {
                "Edits recovered from this device are shown. Nothing is sent until you choose."
            } else {
                "Edits recovered from this device were not placed: the file changed since. Nothing is sent until you choose."
            }
            .to_owned(),
            level: Level::Warn,
        })
    }

    /// Keep the recovered edits: settle each, then send the text as new edits
    /// against the revision the document is at now. Edits that were not
    /// placed are added after the file's text, as "keep both" does.
    pub fn keep_restored(&mut self, session: &mut EditSession) -> Step {
        let mut step = Step::default();
        let Some(r) = self.restored.take() else {
            return step;
        };
        if r.moved_from.is_some() {
            let end = session.len();
            let added = recovery::after_file_text(&session.text(), &r.text);
            session.set_selection(end, end);
            if let Err(e) = session.insert_text(&added) {
                step.say(Level::Warn, format!("Not kept: {e}"));
                self.restored = Some(r);
                return step;
            }
        } else if session.has_conflict() {
            let _ = session.resolve_conflict(Resolution::KeepMine);
        }
        step.text_changed = true;
        step.say(
            Level::Info,
            "Kept the recovered edits. They are sent as new edits on the current text.",
        );
        step.settle_restored = r.ops;
        step
    }

    /// Discard the recovered edits: settle each and drop the text.
    pub fn discard_restored(&mut self, session: &mut EditSession) -> Step {
        let mut step = Step::default();
        let Some(r) = self.restored.take() else {
            return step;
        };
        if r.moved_from.is_none() && session.has_conflict() {
            let _ = session.resolve_conflict(Resolution::TakeTheirs);
        }
        step.text_changed = true;
        step.say(
            Level::Info,
            "Discarded the edits recovered from this device.",
        );
        step.settle_restored = r.ops;
        step
    }

    /// The owner's answer to the settle of one recovered operation.
    pub fn restored_settled(&mut self, c: &Completion) -> Step {
        let mut step = Step::default();
        self.settling = self.settling.saturating_sub(1);
        match &c.outcome {
            Outcome::Accepted => {}
            // The edit that follows is then refused for the draft the owner
            // still holds, which says so where the person can see it.
            Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
                step.say(
                    Level::Warn,
                    format!("A recovered edit was not settled: {reason}"),
                );
            }
            Outcome::Uncertain { reason } => step.say(
                Level::Warn,
                format!("Unknown whether a recovered edit was settled: {reason}"),
            ),
        }
        step
    }

    // ---- the owner's answers ----------------------------------------------

    /// The owner accepted `op` as `revision`.
    pub fn acknowledge(&mut self, session: &mut EditSession, op: &OpId, revision: u64) {
        let mut result = session.acknowledge(op, revision);
        if matches!(result, Err(SyncError::RevisionGap { .. })) {
            // The revisions in between were other people's. Their text is not
            // known here, so no edit goes out until the owner's resync.
            let _ = step_before(session, revision);
            result = session.acknowledge(op, revision);
            self.desync = Some(format!(
                "Revisions before {revision} were not seen; {BEHIND}"
            ));
        }
        match result {
            Ok(()) => {
                if self.inflight.as_ref() == Some(op) {
                    self.inflight = None;
                }
                if self.unknown.as_ref().is_some_and(|u| &u.op == op) {
                    self.unknown = None;
                }
            }
            // Already seen on the live stream, or never ours: nothing to do.
            Err(SyncError::UnknownOperation(_)) => {}
            Err(e) => self.desync = Some(format!("{e}; {BEHIND}")),
        }
    }

    /// The owner's answer to the edit `op`.
    pub fn edit_answered(&mut self, session: &mut EditSession, op: OpId, c: Completion) -> Step {
        let mut step = Step::default();
        let stamp = c.revision.as_ref().and_then(revision_number);
        match (c.outcome, c.payload) {
            (Outcome::Accepted, payload) => {
                let revision = match payload {
                    Some(CompletionPayload::DocumentEdited(e)) => revision_number(&e.revision),
                    _ => stamp,
                };
                match revision {
                    Some(r) => self.acknowledge(session, &op, r),
                    None => {
                        self.inflight = None;
                        self.desync = Some(format!(
                            "The owner accepted an edit without saying at which revision; {BEHIND}"
                        ));
                    }
                }
            }
            (Outcome::Refused { code, reason }, payload) => {
                self.inflight = None;
                let _ = session.refuse(&op, reason.clone());
                self.save.wanted = false;
                if let Some(CompletionPayload::DocumentConflicted(dc)) = payload {
                    let theirs = match revision_number(&dc.current.revision) {
                        Some(r) => match resync(session, &dc.current.text, r) {
                            Ok(changed) => Some(changed),
                            Err(e) => {
                                self.desync = Some(format!("{e}; {BEHIND}"));
                                None
                            }
                        },
                        None => {
                            self.desync = Some("The owner's current revision is opaque.".into());
                            None
                        }
                    };
                    step.text_changed = true;
                    self.held = Some(Held {
                        reason,
                        theirs,
                        conflict: true,
                    });
                } else if code == "conflict" {
                    self.desync = Some(format!(
                        "The owner refused the edit as stale and sent no current text; {BEHIND}"
                    ));
                    self.held = Some(Held {
                        reason,
                        theirs: None,
                        conflict: true,
                    });
                } else {
                    let low = code.to_lowercase();
                    if ["read", "permission", "denied", "forbidden"]
                        .iter()
                        .any(|w| low.contains(w))
                    {
                        self.make_read_only(session, reason.clone());
                    }
                    self.held = Some(Held {
                        reason,
                        theirs: None,
                        conflict: false,
                    });
                }
            }
            (Outcome::Failed { reason }, _) => {
                self.inflight = None;
                let _ = session.refuse(&op, reason.clone());
                self.save.wanted = false;
                self.held = Some(Held {
                    reason,
                    theirs: None,
                    conflict: false,
                });
            }
            (Outcome::Uncertain { reason }, _) => {
                // In flight stays in flight: the owner may have it. Nothing
                // is sent behind it, and nothing sends it again unless asked.
                self.unknown = Some(Unknown { op, reason });
            }
        }
        step
    }

    /// The owner's answer to a save of `revision`.
    pub fn save_answered(&mut self, revision: u64, c: Completion) -> Step {
        let mut step = Step::default();
        if self.save.inflight == Some(revision) {
            self.save.inflight = None;
        }
        match (c.outcome, c.payload) {
            (Outcome::Accepted, payload) => {
                let at = match payload {
                    Some(CompletionPayload::DocumentSaved(s)) => revision_number(&s.revision),
                    _ => None,
                }
                .unwrap_or(revision);
                // An answer for an older revision says that revision is on
                // disk; it never moves the mark back.
                if self.saved.is_none_or(|s| s < at) {
                    self.saved = Some(at);
                }
                self.save.unknown = None;
                step.say(Level::Info, format!("Saved revision {at}."));
            }
            (Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                step.say(Level::Error, format!("Not saved: {reason}"));
            }
            (Outcome::Uncertain { reason }, _) => {
                step.say(Level::Warn, format!("Unknown whether it saved: {reason}"));
                self.save.unknown = Some(reason);
            }
        }
        step
    }

    /// The owner's answer to a reconcile with the file on disk.
    pub fn reconcile_answered(
        &mut self,
        session: &mut EditSession,
        keep: ReconcileKeep,
        c: Completion,
    ) -> Step {
        let mut step = Step::default();
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentReconciled(r))) => {
                let Some(revision) = revision_number(&r.revision) else {
                    return step;
                };
                match resync(session, &r.text, revision) {
                    Ok(_) => {
                        step.text_changed = true;
                        self.disk = None;
                        if keep == ReconcileKeep::Disk {
                            self.saved = Some(revision);
                        }
                        step.say(Level::Info, "Settled with the file on disk.");
                    }
                    Err(e) => self.desync = Some(format!("{e}; {BEHIND}")),
                }
            }
            (Outcome::Accepted, _) => self.disk = None,
            (Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                step.say(Level::Error, format!("Not settled: {reason}"));
            }
            (Outcome::Uncertain { reason }, _) => {
                step.say(Level::Warn, format!("Unknown whether it settled: {reason}"));
            }
        }
        step
    }

    // ---- the host stream --------------------------------------------------

    /// A host message about the document: the owner's changes and
    /// acknowledgements, a resync, a conflict, a save, a retirement. Every
    /// other message is ignored.
    pub fn host(&mut self, session: &mut EditSession, message: &HostMessage) -> Step {
        let mut step = Step::default();
        match message {
            HostMessage::DocumentChanged {
                revision,
                operation_id,
                unit,
                edits,
                ..
            } => {
                let Some(revision) = revision_number(revision) else {
                    return step;
                };
                if let Some(op) = operation_id.clone().map(OpId)
                    && session.pending().iter().any(|p| p.op_id == op)
                {
                    self.acknowledge(session, &op, revision);
                    return step;
                }
                let accepted = session.accepted_revision();
                if revision <= accepted {
                    return step;
                }
                if revision > accepted + 1 {
                    self.desync = Some(format!(
                        "Revisions {}..{} were not seen; {BEHIND}",
                        accepted + 1,
                        revision - 1
                    ));
                    return step;
                }
                match apply_owner_change(session, *unit, edits, revision) {
                    Ok(()) => step.text_changed = true,
                    Err(e) => self.desync = Some(format!("{e}; {BEHIND}")),
                }
            }
            HostMessage::DocumentAcknowledged {
                revision,
                operation_id,
                ..
            } => {
                if let Some(revision) = revision_number(revision) {
                    self.acknowledge(session, &OpId(operation_id.clone()), revision);
                }
            }
            HostMessage::DocumentResync { revision, text, .. } => {
                let Some(revision) = revision_number(revision) else {
                    return step;
                };
                match resync(session, text, revision) {
                    Ok(_) => {
                        self.desync = None;
                        step.text_changed = true;
                    }
                    // An older resync than what is shown is not news.
                    Err(SyncError::StaleRevision { .. }) => {}
                    Err(e) => self.desync = Some(format!("{e}; {BEHIND}")),
                }
            }
            HostMessage::DocumentConflict {
                revision,
                disk_deleted,
                ..
            } => {
                if let Some(revision) = revision_number(revision) {
                    self.disk = Some(Disk {
                        revision,
                        deleted: *disk_deleted,
                    });
                }
            }
            HostMessage::DocumentSaved { revision, .. } => {
                if let Some(revision) = revision_number(revision) {
                    if self.saved.is_none_or(|s| s < revision) {
                        self.saved = Some(revision);
                    }
                    self.save.unknown = None;
                }
            }
            HostMessage::DocumentRetired { .. } => {
                self.make_read_only(session, "The owner retired this document.");
            }
            _ => {}
        }
        step
    }

    // ---- the person's choice over held text -------------------------------

    /// Settle the held text one way. The owner keeps the refused edit until
    /// the caller says it has dealt with it, so each held operation comes back
    /// in [`Step::settle`] once the session has taken the person's choice.
    pub fn resolve(&mut self, session: &mut EditSession, how: Resolution) -> Step {
        let mut step = Step::default();
        let held: Vec<OpId> = session.conflict().map(|c| c.op_ids).unwrap_or_default();
        match session.resolve_conflict(how) {
            Ok(dropped) => {
                self.held = None;
                step.text_changed = true;
                if dropped.is_some() {
                    self.recoverable = dropped;
                }
                step.say(
                    Level::Info,
                    match how {
                        Resolution::KeepMine => "Your text will be sent again on top of theirs.",
                        Resolution::TakeTheirs => {
                            "Took their text. Yours is kept so it can be copied."
                        }
                        Resolution::KeepBoth => "Kept their text and added yours next to it.",
                    },
                );
                step.settle = held;
            }
            Err(e) => {
                self.held = None;
                step.say(Level::Warn, e.to_string());
            }
        }
        step
    }
}
