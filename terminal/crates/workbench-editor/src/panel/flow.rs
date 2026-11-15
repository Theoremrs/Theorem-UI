//! The answers: completions of the effects the panel emitted, host messages
//! for its document, and the sending of its edits.

use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    ClipboardWrite, CoordinateUnit, DocumentEdit, DocumentReconcile, DocumentSettle, EffectBody,
    LanguageApplyPlan, LanguagePosition, LanguageRename, ReconcileKeep, TextChange as CoreChange,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{Capability, ResourceRef};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_text::{
    EditSession, OpId, PendingState, Resolution, SessionConfig, SyncError,
};

use super::{
    Clip, Disk, Doc, EditorPanel, Held, Notice, Phase, Plan, Problem, Task, Tone, Unknown,
    language, seq,
};
use crate::find::Find;
use crate::sync::{apply_owner_change, resync, step_before};
use crate::widget::SourceView;

fn core_changes(edit: &theorem_workbench_text::LocalEdit) -> Vec<CoreChange> {
    edit.changes
        .iter()
        .map(|c| CoreChange {
            start: c.start as u32,
            end: c.end as u32,
            insert: c.insert.clone(),
        })
        .collect()
}

pub(super) fn emit_notice(error: EmitError) -> String {
    match error {
        EmitError::InFlightFull(full) => format!(
            "Too many requests are in flight (limit {}); try again in a moment.",
            full.limit
        ),
        EmitError::Silent => "That cannot start from here; try again.".to_owned(),
        EmitError::Forbidden(kind) => format!("A {kind:?} request cannot start from here."),
    }
}

impl EditorPanel {
    /// Everything that follows any message: the layout of the view, the
    /// sending of whatever is owed, and the search.
    pub(super) fn after(&mut self, cx: &mut Ctx) {
        self.relayout();
        self.pump(cx);
        if let Some(d) = self.doc_mut() {
            let version = d.version;
            d.find.refresh(&d.session, version);
            d.refresh_tokens();
            // A save of an older revision is judged stale once edits are
            // accepted past it, so its answer will not come: stop showing it.
            let accepted = d.session.accepted_revision();
            if d.save.inflight.is_some_and(|r| r < accepted) {
                d.save.inflight = None;
            }
            // A hover or a completion list belongs to the text it was asked
            // about; a place list does not move with the caret.
            let version = d.version;
            if let Some(
                language::Popup::Hover {
                    revision,
                    version: v,
                    ..
                }
                | language::Popup::Completions {
                    revision,
                    version: v,
                    ..
                },
            ) = &d.popup
                && (*v != version || *revision != accepted)
            {
                d.popup = None;
            }
        }
    }

    // ---- sending ----------------------------------------------------------

    /// Send what is owed: the next edit when none is in flight, then a wanted
    /// save once every edit is accepted. A call that cannot emit (a silent
    /// message) leaves the need for the next tick.
    pub(super) fn pump(&mut self, cx: &mut Ctx) {
        let save_due = {
            let Phase::Ready(d) = &mut self.phase else {
                return;
            };
            if d.desync.is_some() {
                return;
            }
            let next = if d.inflight.is_none() && d.unknown.is_none() {
                d.session.take_next_to_send()
            } else {
                None
            };
            if let Some(edit) = next {
                let base = edit.base_revision;
                let op = edit.op_id.clone();
                let body = EffectBody::DocumentEdit(DocumentEdit {
                    operation_id: op.0.clone(),
                    unit: CoordinateUnit::Utf16,
                    edits: core_changes(&edit),
                });
                d.inflight = Some(op.clone());
                if let Err(error) = self.start(cx, Task::Edit(op.clone()), body, Some(base)) {
                    self.need_pump = true;
                    if let Phase::Ready(d) = &mut self.phase {
                        d.inflight = None;
                        let _ = d.session.requeue(&op);
                        if !matches!(error, EmitError::Silent) {
                            d.notice(emit_notice(error), Tone::Warn);
                        }
                    }
                }
                return;
            }
            d.save.wanted
                && d.save.inflight.is_none()
                && !d.session.has_pending()
                && !d.session.has_conflict()
        };
        if save_due {
            self.send_save(cx);
        }
    }

    pub(super) fn send_save(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let revision = d.session.accepted_revision();
        d.save.wanted = false;
        match self.start(
            cx,
            Task::Save(revision),
            EffectBody::DocumentSave,
            Some(revision),
        ) {
            Ok(_) => {
                if let Some(d) = self.doc_mut() {
                    d.save.inflight = Some(revision);
                    d.save.unknown = None;
                }
            }
            Err(error) => {
                self.need_pump = true;
                if let Some(d) = self.doc_mut() {
                    d.save.wanted = true;
                    if !matches!(error, EmitError::Silent) {
                        d.notice(emit_notice(error), Tone::Warn);
                    }
                }
            }
        }
    }

    // ---- completions ------------------------------------------------------

    pub(super) fn on_completion(&mut self, c: Completion, cached: bool, cx: &mut Ctx) {
        let Some(task) = self.outstanding.remove(&c.effect) else {
            return;
        };
        match task {
            // Host-only: the root cannot tie them to the document, so the
            // answer may arrive as the cached kind. It is still the answer.
            Task::Clip(clip) => self.on_clip(clip, c),
            // A create for a name is the answer to a name, whichever editor is
            // bound to what: the one that asked takes it.
            Task::Create { path, adopt } => self.on_create(path, adopt, c, cx),
            // For a resource the panel is no longer bound to: not the current
            // state, so not shown.
            _ if cached => {}
            Task::Open => self.on_open(c, cx),
            Task::Edit(op) => self.on_edit(op, c),
            Task::Save(revision) => self.on_save(revision, c),
            Task::Reconcile(keep) => self.on_reconcile(keep, c),
            Task::Rename(revision) => self.on_rename(revision, c),
            Task::Apply => self.on_apply(c),
            Task::Format => self.on_format(c),
            Task::Hover { revision, version } => self.on_hover(revision, version, c),
            Task::Complete { revision, version } => self.on_completions(revision, version, c),
            Task::Navigate {
                revision,
                references,
            } => self.on_places(revision, references, c),
            Task::Check(revision) => self.on_check(revision, c),
            Task::Release => {}
        }
    }

    pub(super) fn on_open(&mut self, c: Completion, cx: &mut Ctx) {
        let opened = match (&c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentOpened(o))) => o,
            (outcome, _) => {
                self.phase = Phase::Failed(Problem::of(outcome));
                return;
            }
        };
        let Some(revision) = seq(&opened.revision) else {
            self.phase = Phase::Failed(Problem::plain(
                "This editor cannot show the document",
                "The owner numbers its revisions with an opaque token, and the editor needs an ordered one."
                    .into(),
            ));
            return;
        };
        // Clean as the owner says, unless it also names an older saved revision.
        let saved = if opened.dirty {
            opened
                .saved_revision
                .as_ref()
                .and_then(seq)
                .filter(|s| *s != revision)
        } else {
            Some(revision)
        };
        let resource = self.resource();
        let mut note = None;
        let kept = match self.drafts.take(&resource) {
            Some(mut kept) => match resync(&mut kept, &opened.text, revision) {
                Ok(_) => {
                    // An edit that was in flight when the panel closed may or
                    // may not have been accepted: send it again under its own
                    // id, which the owner takes once.
                    for p in kept.pending() {
                        if p.state == PendingState::Sent {
                            let _ = kept.requeue(&p.op_id);
                        }
                    }
                    Some(kept)
                }
                Err(e) => {
                    note = Some(format!(
                        "The text kept from the last editor no longer fits the owner's ({e}); it was not restored."
                    ));
                    None
                }
            },
            None => None,
        };
        let mut session = kept.unwrap_or_else(|| {
            let client = format!("{}.{}", cx.panel().as_str(), c.effect.0);
            EditSession::new(&opened.text, revision, SessionConfig::new(client))
        });
        if let Some(view) = self.restore.take() {
            session.restore_view(&view);
        }
        let held = session.conflict().map(|k| Held {
            reason: k.reason,
            theirs: None,
            conflict: true,
        });
        let mut d = Doc {
            session,
            view: SourceView::new(),
            saved,
            version: 0,
            read_only: None,
            inflight: None,
            unknown: None,
            desync: None,
            held,
            disk: None,
            save: Default::default(),
            notice: note.map(|text| Notice {
                text,
                tone: Tone::Warn,
            }),
            find: Find::default(),
            in_find: false,
            rename: None,
            plan: None,
            in_replace: false,
            popup: None,
            findings: Default::default(),
            tokens: None,
            waiting: None,
            preedit: None,
            recoverable: None,
            busy: None,
        };
        if let Some(r) = &opened.read_only {
            d.read_only = Some(r.reason.clone());
            d.session.set_read_only(true);
        }
        let (w, h) = self.body;
        d.view.resize(&mut d.session, w, h);
        self.phase = Phase::Ready(Box::new(d));
        self.place_reveal();
    }

    /// The owner accepted `op` as `revision`.
    pub(super) fn acknowledge(&mut self, op: &OpId, revision: u64) {
        let Some(d) = self.doc_mut() else { return };
        let mut result = d.session.acknowledge(op, revision);
        if matches!(result, Err(SyncError::RevisionGap { .. })) {
            // The revisions in between were other people's. Their text is not
            // known here, so no edit goes out until the owner's resync.
            let _ = step_before(&mut d.session, revision);
            result = d.session.acknowledge(op, revision);
            d.desync = Some(format!(
                "Revisions before {revision} were not seen; waiting for the owner's resync."
            ));
        }
        match result {
            Ok(()) => {
                if d.inflight.as_ref() == Some(op) {
                    d.inflight = None;
                }
                if d.unknown.as_ref().is_some_and(|u| &u.op == op) {
                    d.unknown = None;
                }
            }
            // Already seen on the live stream, or never ours: nothing to do.
            Err(SyncError::UnknownOperation(_)) => {}
            Err(e) => d.desync = Some(format!("{e}; waiting for the owner's resync.")),
        }
    }

    fn on_edit(&mut self, op: OpId, c: Completion) {
        let revision_stamp = c.revision.as_ref().and_then(seq);
        let Phase::Ready(d) = &mut self.phase else {
            return;
        };
        match (c.outcome, c.payload) {
            (Outcome::Accepted, payload) => {
                let revision = match payload {
                    Some(CompletionPayload::DocumentEdited(e)) => seq(&e.revision),
                    _ => revision_stamp,
                };
                match revision {
                    Some(r) => self.acknowledge(&op, r),
                    None => {
                        d.inflight = None;
                        d.desync = Some(
                            "The owner accepted an edit without saying at which revision; waiting for its resync."
                                .into(),
                        );
                    }
                }
            }
            (Outcome::Refused { code, reason }, payload) => {
                d.inflight = None;
                let _ = d.session.refuse(&op, reason.clone());
                d.save.wanted = false;
                if let Some(CompletionPayload::DocumentConflicted(dc)) = payload {
                    let theirs = match seq(&dc.current.revision) {
                        Some(r) => match resync(&mut d.session, &dc.current.text, r) {
                            Ok(changed) => Some(changed),
                            Err(e) => {
                                d.desync = Some(format!("{e}; waiting for the owner's resync."));
                                None
                            }
                        },
                        None => {
                            d.desync = Some("The owner's current revision is opaque.".into());
                            None
                        }
                    };
                    d.touch();
                    d.held = Some(Held {
                        reason,
                        theirs,
                        conflict: true,
                    });
                } else if code == "conflict" {
                    d.desync = Some(
                        "The owner refused the edit as stale and sent no current text; waiting for its resync."
                            .into(),
                    );
                    d.held = Some(Held {
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
                        d.read_only = Some(reason.clone());
                        d.session.set_read_only(true);
                    }
                    d.held = Some(Held {
                        reason,
                        theirs: None,
                        conflict: false,
                    });
                }
            }
            (Outcome::Failed { reason }, _) => {
                d.inflight = None;
                let _ = d.session.refuse(&op, reason.clone());
                d.save.wanted = false;
                d.held = Some(Held {
                    reason,
                    theirs: None,
                    conflict: false,
                });
            }
            (Outcome::Uncertain { reason }, _) => {
                // In flight stays in flight: the owner may have it. Nothing
                // is sent behind it, and nothing sends it again unless asked.
                d.unknown = Some(Unknown { op, reason });
            }
        }
    }

    fn on_save(&mut self, revision: u64, c: Completion) {
        let Some(d) = self.doc_mut() else { return };
        if d.save.inflight == Some(revision) {
            d.save.inflight = None;
        }
        match (c.outcome, c.payload) {
            (Outcome::Accepted, payload) => {
                let at = match payload {
                    Some(CompletionPayload::DocumentSaved(s)) => seq(&s.revision),
                    _ => None,
                }
                .unwrap_or(revision);
                d.saved = Some(at);
                d.save.unknown = None;
                d.notice(format!("Saved revision {at}."), Tone::Info);
            }
            (Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                d.notice(format!("Not saved: {reason}"), Tone::Error);
            }
            (Outcome::Uncertain { reason }, _) => {
                d.save.unknown = Some(reason.clone());
                d.notice(format!("Unknown whether it saved: {reason}"), Tone::Warn);
            }
        }
    }

    fn on_reconcile(&mut self, keep: ReconcileKeep, c: Completion) {
        let Some(d) = self.doc_mut() else { return };
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentReconciled(r))) => {
                let Some(revision) = seq(&r.revision) else {
                    return;
                };
                match resync(&mut d.session, &r.text, revision) {
                    Ok(_) => {
                        d.touch();
                        d.disk = None;
                        if keep == ReconcileKeep::Disk {
                            d.saved = Some(revision);
                        }
                        d.notice("Settled with the file on disk.", Tone::Info);
                    }
                    Err(e) => d.desync = Some(format!("{e}; waiting for the owner's resync.")),
                }
            }
            (Outcome::Accepted, _) => d.disk = None,
            (Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                d.notice(format!("Not settled: {reason}"), Tone::Error);
            }
            (Outcome::Uncertain { reason }, _) => {
                d.notice(format!("Unknown whether it settled: {reason}"), Tone::Warn);
            }
        }
    }

    fn on_rename(&mut self, revision: u64, c: Completion) {
        let Some(d) = self.doc_mut() else { return };
        d.busy = None;
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::LanguagePlan(p))) => {
                d.plan = Some(Plan {
                    id: p.plan_id,
                    revision,
                });
            }
            (Outcome::Accepted, _) => d.notice(
                "The language service accepted the rename and sent no plan.",
                Tone::Warn,
            ),
            (Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                d.notice(format!("Rename refused: {reason}"), Tone::Error);
            }
            (Outcome::Uncertain { reason }, _) => d.notice(
                format!("Unknown whether a rename plan exists: {reason}"),
                Tone::Warn,
            ),
        }
    }

    fn on_apply(&mut self, c: Completion) {
        let Some(d) = self.doc_mut() else { return };
        d.busy = None;
        match c.outcome {
            Outcome::Accepted => d.notice(
                "The rename was applied; its edits arrive as the owner's changes.",
                Tone::Info,
            ),
            Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
                d.notice(format!("The rename was not applied: {reason}"), Tone::Error);
            }
            Outcome::Uncertain { reason } => d.notice(
                format!("Unknown whether the rename was applied: {reason}"),
                Tone::Warn,
            ),
        }
    }

    fn on_format(&mut self, c: Completion) {
        let Some(d) = self.doc_mut() else { return };
        d.busy = None;
        match c.outcome {
            Outcome::Accepted => d.notice(
                "Formatting accepted; its edits arrive as the owner's changes.",
                Tone::Info,
            ),
            Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
                d.notice(format!("Not formatted: {reason}"), Tone::Error);
            }
            Outcome::Uncertain { reason } => d.notice(
                format!("Unknown whether it was formatted: {reason}"),
                Tone::Warn,
            ),
        }
    }

    fn on_clip(&mut self, clip: Clip, c: Completion) {
        match (clip, c.outcome, c.payload) {
            (Clip::Copy, Outcome::Accepted, _) => self.say("Copied.", Tone::Info),
            (Clip::Cut { text, selection }, Outcome::Accepted, _) => {
                if let Some(d) = self.doc_mut() {
                    // The text leaves the page only now that the clipboard has
                    // it, and only if it is still what was selected.
                    if d.session.selection() == Some(selection)
                        && d.session.selected_text().as_deref() == Some(text.as_str())
                    {
                        match d.session.cut() {
                            Ok(_) => {
                                d.touch();
                                d.view.reveal(&mut d.session);
                            }
                            Err(e) => d.notice(e.to_string(), Tone::Warn),
                        }
                    } else {
                        d.notice(
                            "Copied, but not cut: the selection changed meanwhile.",
                            Tone::Warn,
                        );
                    }
                }
            }
            (Clip::Paste, Outcome::Accepted, Some(CompletionPayload::Clipboard(text))) => {
                let error = match self.doc_mut() {
                    Some(d) => {
                        let r = d.view.paste(&mut d.session, &text.text);
                        if r.edited {
                            d.touch();
                        }
                        r.error
                    }
                    None => None,
                };
                if let Some(e) = error {
                    let note = self.edit_error(&e);
                    self.say(note, Tone::Warn);
                }
            }
            (Clip::Paste, Outcome::Accepted, _) => {
                self.say("The clipboard sent no text.", Tone::Warn);
            }
            (clip, Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                let what = match clip {
                    Clip::Copy => "Not copied",
                    Clip::Cut { .. } => "Not cut",
                    Clip::Paste => "Not pasted",
                };
                self.say(format!("{what}: {reason}"), Tone::Error);
            }
            (_, Outcome::Uncertain { reason }, _) => {
                self.say(
                    format!("Unknown whether the clipboard took it: {reason}"),
                    Tone::Warn,
                );
            }
        }
    }

    pub(super) fn say(&mut self, text: impl Into<String>, tone: Tone) {
        if let Some(d) = self.doc_mut() {
            d.notice(text, tone);
        }
    }

    // ---- host messages ----------------------------------------------------

    pub(super) fn on_host(&mut self, message: HostMessage) {
        match message {
            HostMessage::DocumentChanged {
                revision,
                operation_id,
                unit,
                edits,
                ..
            } => {
                let Some(revision) = seq(&revision) else {
                    return;
                };
                let Some(d) = self.doc_mut() else { return };
                if let Some(op) = operation_id.map(OpId)
                    && d.session.pending().iter().any(|p| p.op_id == op)
                {
                    self.acknowledge(&op, revision);
                    return;
                }
                let accepted = d.session.accepted_revision();
                if revision <= accepted {
                    return;
                }
                if revision > accepted + 1 {
                    d.desync = Some(format!(
                        "Revisions {}..{} were not seen; waiting for the owner's resync.",
                        accepted + 1,
                        revision - 1
                    ));
                    return;
                }
                match apply_owner_change(&mut d.session, unit, &edits, revision) {
                    Ok(()) => d.touch(),
                    Err(e) => d.desync = Some(format!("{e}; waiting for the owner's resync.")),
                }
            }
            HostMessage::DocumentAcknowledged {
                revision,
                operation_id,
                ..
            } => {
                if let Some(revision) = seq(&revision) {
                    self.acknowledge(&OpId(operation_id), revision);
                }
            }
            HostMessage::DocumentResync { revision, text, .. } => {
                let (Some(revision), Some(d)) = (seq(&revision), self.doc_mut()) else {
                    return;
                };
                match resync(&mut d.session, &text, revision) {
                    Ok(_) => {
                        d.desync = None;
                        d.touch();
                    }
                    // An older resync than what is shown is not news.
                    Err(SyncError::StaleRevision { .. }) => {}
                    Err(e) => d.desync = Some(format!("{e}; waiting for the owner's resync.")),
                }
            }
            HostMessage::DocumentConflict {
                revision,
                disk_deleted,
                ..
            } => {
                if let (Some(revision), Some(d)) = (seq(&revision), self.doc_mut()) {
                    d.disk = Some(Disk {
                        revision,
                        deleted: disk_deleted,
                    });
                }
            }
            HostMessage::DocumentSaved { revision, .. } => {
                if let (Some(revision), Some(d)) = (seq(&revision), self.doc_mut()) {
                    // A save of an older revision says that revision is on
                    // disk; the mark stays if the text has moved past it.
                    if d.saved.is_none_or(|s| s < revision) {
                        d.saved = Some(revision);
                    }
                    d.save.unknown = None;
                }
            }
            HostMessage::DocumentTokens {
                resource,
                revision,
                encoding,
                spans,
            } => {
                let (Some(revision), true) = (seq(&revision), resource == self.resource()) else {
                    return;
                };
                if let Some(d) = self.doc_mut() {
                    let accepted = d.session.accepted_revision();
                    if revision == accepted {
                        d.take_tokens(revision, encoding, &spans);
                        d.waiting = None;
                    } else if revision > accepted {
                        d.waiting = Some(language::Waiting {
                            revision,
                            encoding,
                            spans,
                        });
                    }
                }
            }
            HostMessage::DocumentMoved { from, to } => {
                if from == self.resource()
                    && let ResourceRef::Document {
                        workspace,
                        resource_id,
                    } = to
                {
                    self.workspace = workspace;
                    self.path = resource_id;
                }
            }
            HostMessage::DocumentRetired { .. } => {
                if let Some(d) = self.doc_mut() {
                    d.session.set_read_only(true);
                    d.read_only = Some("The owner retired this document.".to_owned());
                }
            }
            HostMessage::CapabilitiesChanged { capabilities } => {
                self.documents = capabilities.has(&Capability::new("documents"));
                self.language = capabilities.has(&Capability::new("language"));
            }
            HostMessage::ConnectionChanged { state, .. } => self.connection = Some(state),
            _ => {}
        }
    }

    // ---- what a choice sends ----------------------------------------------

    /// Settle the held text one way. The owner keeps the refused edit until
    /// the caller says it has dealt with it, so each held operation is settled
    /// once the session has taken the person's choice.
    pub(super) fn resolve(&mut self, how: Resolution, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let held: Vec<OpId> = d.session.conflict().map(|c| c.op_ids).unwrap_or_default();
        let result = d.session.resolve_conflict(how);
        let settled = result.is_ok();
        match result {
            Ok(dropped) => {
                d.held = None;
                d.touch();
                if dropped.is_some() {
                    d.recoverable = dropped;
                }
                d.notice(
                    match how {
                        Resolution::KeepMine => "Your text will be sent again on top of theirs.",
                        Resolution::TakeTheirs => {
                            "Took their text. Yours is kept: Alt+Y copies it."
                        }
                        Resolution::KeepBoth => "Kept their text and added yours next to it.",
                    },
                    Tone::Info,
                );
            }
            Err(e) => {
                d.held = None;
                d.notice(e.to_string(), Tone::Warn);
            }
        }
        if settled {
            for op in held {
                let body = EffectBody::DocumentSettle(DocumentSettle { operation_id: op.0 });
                if let Ok(id) = self.emit(cx, self.resource(), body, None) {
                    self.outstanding.insert(id, Task::Release);
                }
            }
        }
    }

    pub(super) fn reconcile(&mut self, keep: ReconcileKeep, cx: &mut Ctx) {
        let body = EffectBody::DocumentReconcile(DocumentReconcile { keep });
        if let Err(e) = self.start(cx, Task::Reconcile(keep), body, None) {
            self.say(emit_notice(e), Tone::Warn);
        }
    }

    pub(super) fn send_rename(&mut self, name: String, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let at = d.view.position(&d.session);
        let revision = d.session.accepted_revision();
        let body = EffectBody::LanguageRename(LanguageRename {
            position: LanguagePosition {
                line: (at.line - 1) as u32,
                character: at.utf16 as u32,
            },
            new_name: name,
        });
        match self.start(cx, Task::Rename(revision), body, Some(revision)) {
            Ok(_) => {
                if let Some(d) = self.doc_mut() {
                    d.busy = Some("asking for a rename plan");
                }
            }
            Err(e) => self.say(emit_notice(e), Tone::Warn),
        }
    }

    pub(super) fn apply_plan(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let Some(plan) = d.plan.take() else { return };
        let now = d.session.accepted_revision();
        if plan.revision != now || d.session.has_pending() {
            let waiting = if d.session.has_pending() {
                " with edits waiting"
            } else {
                ""
            };
            d.notice(
                format!(
                    "The rename was not applied: it was planned for revision {} and the document is at {now}{waiting}.",
                    plan.revision
                ),
                Tone::Warn,
            );
            return;
        }
        let body = EffectBody::LanguageApplyPlan(LanguageApplyPlan { plan_id: plan.id });
        match self.start(cx, Task::Apply, body, Some(plan.revision)) {
            Ok(_) => {
                if let Some(d) = self.doc_mut() {
                    d.busy = Some("applying the rename");
                }
            }
            Err(e) => self.say(emit_notice(e), Tone::Warn),
        }
    }

    pub(super) fn send_format(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let revision = d.session.accepted_revision();
        match self.start(cx, Task::Format, EffectBody::LanguageFormat, Some(revision)) {
            Ok(_) => {
                if let Some(d) = self.doc_mut() {
                    d.busy = Some("formatting");
                }
            }
            Err(e) => self.say(emit_notice(e), Tone::Warn),
        }
    }

    pub(super) fn write_clipboard(&mut self, text: String, task: Clip, cx: &mut Ctx) {
        let body = EffectBody::ClipboardWrite(ClipboardWrite { text });
        if let Err(e) = self.emit_clip(cx, body, task) {
            self.say(emit_notice(e), Tone::Warn);
        }
    }

    pub(super) fn emit_clip(
        &mut self,
        cx: &mut Ctx,
        body: EffectBody,
        task: Clip,
    ) -> Result<(), EmitError> {
        let id = self.emit(cx, ResourceRef::None, body, None)?;
        self.outstanding.insert(id, Task::Clip(task));
        Ok(())
    }
}
