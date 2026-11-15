//! The answers: completions of the effects the panel emitted, host messages
//! for its document, and the sending of its edits.
//!
//! The flow is the editor panel's, over the Markdown model's session. The
//! editor's own flow is private to its panel, so this is the same flow written
//! against `MarkdownDoc`; the helpers that fold the owner's text into a session
//! (`resync`, `step_before`, `apply_owner_change`) are the editor crate's.

use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    ClipboardWrite, CoordinateUnit, DocumentEdit, DocumentReconcile, DocumentSettle, EffectBody,
    ReconcileKeep, TextChange as CoreChange,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{Capability, ResourceRef};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_editor::{SourceView, apply_owner_change, resync, step_before};
use theorem_workbench_markdown::{BlockResolution, MarkdownDoc, MarkdownMode};
use theorem_workbench_text::{OpId, PendingState, Resolution, SessionConfig, SyncError};

use super::{
    Clip, Disk, Doc, Held, MarkdownPanel, Notice, Phase, Problem, Saving, Task, Tone, Unknown, seq,
};

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

impl MarkdownPanel {
    /// Everything that follows any message: the layout of the views and the
    /// sending of whatever is owed.
    pub(super) fn after(&mut self, cx: &mut Ctx) {
        self.relayout();
        self.pump(cx);
        if let Some(d) = self.doc_mut() {
            // A save of an older revision is judged stale once edits are
            // accepted past it, so its answer will not come: stop showing it.
            let accepted = d.md.get_mut().revision();
            if d.save.inflight.is_some_and(|r| r < accepted) {
                d.save.inflight = None;
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
                d.md.get_mut().take_next_to_send()
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
                        let _ = d.md.get_mut().requeue(&op);
                        if !matches!(error, EmitError::Silent) {
                            d.notice(emit_notice(error), Tone::Warn);
                        }
                    }
                }
                return;
            }
            let md = d.md.get_mut();
            d.save.wanted
                && d.save.inflight.is_none()
                && !md.session().has_pending()
                && !md.session().has_conflict()
        };
        if save_due {
            self.send_save(cx);
        }
    }

    pub(super) fn send_save(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let revision = d.md.get_mut().revision();
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

    pub(super) fn on_completion(&mut self, c: Completion, cached: bool, _cx: &mut Ctx) {
        let Some(task) = self.outstanding.remove(&c.effect) else {
            return;
        };
        match task {
            // Host-only: the root cannot tie them to the document, so the
            // answer may arrive as the cached kind. It is still the answer.
            Task::Clip(clip) => self.on_clip(clip, c),
            // For a resource the panel is no longer bound to: not the current
            // state, so not shown.
            _ if cached => {}
            Task::Open => self.on_open(c),
            Task::Edit(op) => self.on_edit(op, c),
            Task::Save(revision) => self.on_save(revision, c),
            Task::Reconcile(keep) => self.on_reconcile(keep, c),
            Task::Release => {}
        }
    }

    fn on_open(&mut self, c: Completion) {
        let effect = c.effect;
        let opened = match (&c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::DocumentOpened(o))) => o,
            (outcome, _) => {
                self.phase = Phase::Failed(Problem::of(outcome));
                return;
            }
        };
        let Some(revision) = seq(&opened.revision) else {
            self.phase = Phase::Failed(Problem::plain(
                "This panel cannot show the document",
                "The owner numbers its revisions with an opaque token, and the panel needs an ordered one."
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
            Some(mut kept) => match kept.apply_local(|s| resync(s, &opened.text, revision)) {
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
                        "The text kept from the last panel no longer fits the owner's ({e}); it was not restored."
                    ));
                    None
                }
            },
            None => None,
        };
        let restored = kept.is_some();
        let mut md = kept.unwrap_or_else(|| {
            let client = format!("{}.{}", self.panel_name(), effect.0);
            MarkdownDoc::new(&opened.text, revision, client)
        });
        match self.restore.take() {
            Some(view) if !restored => md.restore_view(&view),
            // A first open shows the document as it reads.
            None if !restored => {
                md.set_mode(MarkdownMode::Visual);
            }
            _ => {}
        }
        let held = md.session().conflict().map(|k| Held {
            reason: k.reason,
            theirs: None,
            conflict: true,
        });
        let mut d = Doc {
            md: std::cell::RefCell::new(md),
            source: SourceView::new(),
            block: SourceView::new(),
            saved,
            read_only: opened.read_only.map(|r| r.reason),
            inflight: None,
            unknown: None,
            desync: None,
            held,
            disk: None,
            save: Saving::default(),
            notice: note.map(|text| Notice {
                text,
                tone: Tone::Warn,
            }),
            recoverable: None,
            link: None,
            preedit: None,
        };
        d.sync_read_only();
        self.phase = Phase::Ready(Box::new(d));
        self.relayout();
        self.place_reveal();
    }

    /// The name that makes a session client id: the panel instance, which the
    /// effect envelope does not carry, so the effect id and the resource do.
    fn panel_name(&self) -> String {
        format!("{}:{}", self.workspace, self.path)
    }

    /// The owner accepted `op` as `revision`.
    pub(super) fn acknowledge(&mut self, op: &OpId, revision: u64) {
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        let mut result = md.acknowledge(op, revision);
        if matches!(result, Err(SyncError::RevisionGap { .. })) {
            // The revisions in between were other people's. Their text is not
            // known here, so no edit goes out until the owner's resync.
            let _ = md.apply_local(|s| step_before(s, revision));
            result = md.acknowledge(op, revision);
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
                let md = d.md.get_mut();
                let _ = md.refuse(&op, reason.clone());
                d.save.wanted = false;
                if let Some(CompletionPayload::DocumentConflicted(dc)) = payload {
                    let theirs = match seq(&dc.current.revision) {
                        Some(r) => match md.apply_local(|s| resync(s, &dc.current.text, r)) {
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
                        d.sync_read_only();
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
                let _ = d.md.get_mut().refuse(&op, reason.clone());
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
                match d.md.get_mut().apply_local(|s| resync(s, &r.text, revision)) {
                    Ok(_) => {
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

    fn on_clip(&mut self, clip: Clip, c: Completion) {
        match (clip, c.outcome, c.payload) {
            (Clip::Copy, Outcome::Accepted, _) => self.say("Copied.", Tone::Info),
            (
                Clip::Cut {
                    text,
                    selection,
                    block,
                },
                Outcome::Accepted,
                _,
            ) => {
                let result = self.doc_mut().map(|d| {
                    let md = d.md.get_mut();
                    // The text leaves the page only now that the clipboard has
                    // it, and only if it is still what was selected.
                    if block {
                        let Some(s) = md.block_session() else {
                            return Err("Copied, but not cut: the block closed meanwhile.".into());
                        };
                        if s.selection() == Some(selection)
                            && s.selected_text().as_deref() == Some(text.as_str())
                        {
                            let _ = s.cut();
                            Ok(())
                        } else {
                            Err("Copied, but not cut: the selection changed meanwhile.".into())
                        }
                    } else {
                        md.apply_local(|s| {
                            if s.selection() == Some(selection)
                                && s.selected_text().as_deref() == Some(text.as_str())
                            {
                                s.cut().map(|_| ()).map_err(|e| e.to_string())
                            } else {
                                Err("Copied, but not cut: the selection changed meanwhile."
                                    .to_owned())
                            }
                        })
                    }
                });
                if let Some(Err(note)) = result {
                    self.say(note, Tone::Warn);
                }
            }
            (
                Clip::Paste { block },
                Outcome::Accepted,
                Some(CompletionPayload::Clipboard(text)),
            ) => {
                let error = match self.doc_mut() {
                    Some(d) => {
                        let md = d.md.get_mut();
                        if block {
                            md.block_session()
                                .and_then(|s| d.block.paste(s, &text.text).error)
                        } else {
                            md.apply_local(|s| d.source.paste(s, &text.text).error)
                        }
                    }
                    None => None,
                };
                if let Some(e) = error {
                    let note = self.edit_error(&e);
                    self.say(note, Tone::Warn);
                }
            }
            (Clip::Paste { .. }, Outcome::Accepted, _) => {
                self.say("The clipboard sent no text.", Tone::Warn);
            }
            (clip, Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                let what = match clip {
                    Clip::Copy => "Not copied",
                    Clip::Cut { .. } => "Not cut",
                    Clip::Paste { .. } => "Not pasted",
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
                let md = d.md.get_mut();
                if let Some(op) = operation_id.map(OpId)
                    && md.pending().iter().any(|p| p.op_id == op)
                {
                    self.acknowledge(&op, revision);
                    return;
                }
                let accepted = md.revision();
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
                // The change reaches the open block through the model, which
                // merges it or holds the block; nothing typed is dropped.
                if let Err(e) = md.apply_local(|s| apply_owner_change(s, unit, &edits, revision)) {
                    d.desync = Some(format!("{e}; waiting for the owner's resync."));
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
                match d.md.get_mut().apply_local(|s| resync(s, &text, revision)) {
                    Ok(_) => d.desync = None,
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
                    d.saved = Some(revision);
                    d.save.unknown = None;
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
                    d.read_only = Some("The owner retired this document.".to_owned());
                    d.sync_read_only();
                }
            }
            HostMessage::CapabilitiesChanged { capabilities } => {
                self.documents = capabilities.has(&Capability::new("documents"));
            }
            HostMessage::ConnectionChanged { state, .. } => self.connection = Some(state),
            _ => {}
        }
    }

    // ---- what a choice sends ----------------------------------------------

    /// Settle held text one way. The held Visual block comes first: it is the
    /// one the person is looking at. Otherwise the owner keeps the refused edit
    /// until the caller says it has dealt with it, so each held operation is
    /// settled once the session has taken the person's choice.
    pub(super) fn resolve(&mut self, how: Resolution, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        if d.md.get_mut().is_held() {
            let which = match how {
                Resolution::KeepMine => BlockResolution::KeepMine,
                Resolution::TakeTheirs => BlockResolution::TakeTheirs,
                Resolution::KeepBoth => BlockResolution::KeepBoth,
            };
            match d.md.get_mut().resolve_block_conflict(which) {
                Ok(set_aside) => {
                    d.recoverable = set_aside;
                    d.notice(
                        match how {
                            Resolution::KeepMine => {
                                "Your block replaced theirs and goes to the owner. Alt+Y copies the text it replaced."
                            }
                            Resolution::TakeTheirs => {
                                "Took their text. Yours is kept: Alt+Y copies it."
                            }
                            Resolution::KeepBoth => {
                                "Kept their block and added yours after it."
                            }
                        },
                        Tone::Info,
                    );
                }
                Err(e) => d.notice(format!("The block was not settled: {e}"), Tone::Error),
            }
            return;
        }
        let held: Vec<OpId> =
            d.md.get_mut()
                .session()
                .conflict()
                .map(|c| c.op_ids)
                .unwrap_or_default();
        let result = d.md.get_mut().resolve_conflict(how);
        let settled = result.is_ok();
        match result {
            Ok(dropped) => {
                d.held = None;
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

/// The client id of a session this panel makes.
#[allow(dead_code)]
fn config(client: &str) -> SessionConfig {
    SessionConfig::new(client)
}
