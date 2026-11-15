//! The answers: completions of the effects the panel emitted, host messages
//! for its document, and the sending of its edits.

use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    ClipboardWrite, DocumentReconcile, DocumentSettle, EffectBody, LanguageApplyPlan,
    LanguagePosition, LanguageRename, ReconcileKeep,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{Capability, ResourceRef};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_text::{EditSession, OpId, PendingState, Resolution, SessionConfig};

use super::{Clip, Doc, EditorPanel, Notice, Phase, Plan, Problem, Task, Tone, language, seq};
use crate::find::Find;
use crate::owner::{Level, Owed, OwnerSync, Step};
use crate::sync::resync;
use crate::tokens::TokenState;
use crate::widget::SourceView;

pub(super) fn emit_notice(error: EmitError) -> String {
    match error {
        EmitError::InFlightFull(full) => format!(
            "Too many requests are in flight (limit {}); try again in a moment.",
            full.limit
        ),
        EmitError::Silent => "That cannot start from here; try again.".to_owned(),
        EmitError::Forbidden(kind) => format!("A {kind:?} request cannot start from here."),
        EmitError::HumanOnly(kind) => format!("A {kind:?} request is for you to make."),
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
            d.tokens.refresh(&d.session, version);
            // A save of an older revision is judged stale once edits are
            // accepted past it, so its answer will not come: stop showing it.
            d.sync.settle_stale_save(&d.session);
            let accepted = d.session.accepted_revision();
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

    /// Send what the owner is owed: the next edit when none is in flight, then
    /// a wanted save once every edit is accepted. A call that cannot emit (a
    /// silent message) leaves the need for the next tick.
    pub(super) fn pump(&mut self, cx: &mut Ctx) {
        let owed = {
            let Phase::Ready(d) = &mut self.phase else {
                return;
            };
            d.sync.owed(&mut d.session)
        };
        match owed {
            Some(Owed::Edit { op, base, body }) => {
                let result = self.start(
                    cx,
                    Task::Edit(op.clone()),
                    EffectBody::DocumentEdit(body),
                    Some(base),
                );
                if let Err(error) = result {
                    self.need_pump = true;
                    if let Phase::Ready(d) = &mut self.phase {
                        d.sync.edit_not_sent(&mut d.session, &op);
                        if !matches!(error, EmitError::Silent) {
                            d.notice(emit_notice(error), Tone::Warn);
                        }
                    }
                }
            }
            Some(Owed::Save { revision }) => {
                let result = self.start(
                    cx,
                    Task::Save(revision),
                    EffectBody::DocumentSave,
                    Some(revision),
                );
                if let Err(error) = result {
                    self.need_pump = true;
                    if let Some(d) = self.doc_mut() {
                        d.sync.save_not_sent();
                        if !matches!(error, EmitError::Silent) {
                            d.notice(emit_notice(error), Tone::Warn);
                        }
                    }
                }
            }
            None => {}
        }
    }

    /// Ask the owner to keep, on this device, the edits held behind an
    /// unsettled one, so a reload does not lose them. On a tick, so a run of
    /// typing is one request, and with no revision, so a late answer is not
    /// judged stale (and never answered for nobody) because an edit was
    /// accepted meanwhile.
    pub(super) fn checkpoint(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let (keep, note) = d.sync.keep_owed(&d.session);
        if let Some(n) = note {
            d.notice(n.text, Tone::Warn);
        }
        let Some(keep) = keep else { return };
        if let Ok(id) = self.emit(
            cx,
            self.resource(),
            EffectBody::DocumentKeep(keep.clone()),
            None,
        ) {
            self.outstanding.insert(id, Task::Keep);
            if let Some(d) = self.doc_mut() {
                d.sync.keep_asked(&keep);
            }
        }
    }

    /// What a transition of the owner's state asks of the panel.
    pub(super) fn apply_step(&mut self, step: Step, cx: &mut Ctx) {
        if let Some(d) = self.doc_mut() {
            if step.text_changed {
                d.touch();
            }
            for n in &step.notes {
                let tone = match n.level {
                    Level::Info => Tone::Info,
                    Level::Warn => Tone::Warn,
                    Level::Error => Tone::Error,
                };
                d.notice(n.text.clone(), tone);
            }
        }
        for op in step.settle {
            let body = EffectBody::DocumentSettle(DocumentSettle { operation_id: op.0 });
            if let Ok(id) = self.emit(cx, self.resource(), body, None) {
                self.outstanding.insert(id, Task::Release);
            }
        }
        // Each recovered operation is settled before the owner takes another
        // edit, so the count of answers owed holds the edits back.
        for op in step.settle_restored {
            let body = EffectBody::DocumentSettle(DocumentSettle { operation_id: op });
            match self.emit(cx, self.resource(), body, None) {
                Ok(id) => {
                    self.outstanding.insert(id, Task::Restore);
                    if let Some(d) = self.doc_mut() {
                        d.sync.settling += 1;
                    }
                }
                Err(e) => self.say(emit_notice(e), Tone::Warn),
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
            // Giving back a hold says nothing about the document now bound.
            Task::Release => {}
            // The owner says access to the document is gone: nothing of it
            // stays on screen or in memory, and nothing more is sent.
            _ if c.outcome.is_access_revoked() => self.revoke(&c.outcome),
            Task::Open => self.on_open(c, cx),
            Task::Edit(op) => self.on_edit(op, c, cx),
            Task::Save(revision) => self.on_save(revision, c, cx),
            Task::Reconcile(keep) => self.on_reconcile(keep, c, cx),
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
            Task::Restore => {
                let Some(d) = self.doc_mut() else { return };
                let step = d.sync.restored_settled(&c);
                self.apply_step(step, cx);
            }
            Task::Keep => {
                let Some(d) = self.doc_mut() else { return };
                let step = d.sync.keep_answered(&c);
                self.apply_step(step, cx);
            }
        }
    }

    /// Forget the document: the text, the held edits, the drafts and what was
    /// kept to put the view back. The owner's reason is shown in place of it.
    fn revoke(&mut self, outcome: &Outcome) {
        let resource = self.resource();
        self.drafts.take(&resource);
        self.restore = None;
        self.local = None;
        self.phase = Phase::Failed(Problem::revoked(outcome));
        // Whatever was in flight is answered for nobody now.
        self.outstanding.retain(|_, t| matches!(t, Task::Clip(_)));
        self.need_pump = false;
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
        let fresh = kept.is_none();
        let mut session = kept.unwrap_or_else(|| {
            let client = format!("{}.{}", cx.panel().as_str(), c.effect.0);
            EditSession::new(&opened.text, revision, SessionConfig::new(client))
        });
        if let Some(view) = self.restore.take() {
            session.restore_view(&view);
        }
        let held = session.conflict().map(|k| crate::owner::Held {
            reason: k.reason,
            theirs: None,
            conflict: true,
        });
        let mut d = Doc {
            session,
            view: SourceView::new(),
            version: 0,
            sync: OwnerSync {
                held,
                ..OwnerSync::new(saved)
            },
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
            tokens: TokenState::new(),
            preedit: None,
            busy: None,
        };
        if let Some(n) = d
            .sync
            .recover(&mut d.session, &opened.pending, revision, fresh)
        {
            d.notice(n.text, Tone::Warn);
        }
        if let Some(r) = &opened.read_only {
            d.sync.make_read_only(&mut d.session, r.reason.clone());
        }
        let (w, h) = self.body;
        d.view.resize(&mut d.session, w, h);
        self.phase = Phase::Ready(Box::new(d));
        self.place_reveal();
    }

    fn on_edit(&mut self, op: OpId, c: Completion, cx: &mut Ctx) {
        let Phase::Ready(d) = &mut self.phase else {
            return;
        };
        let step = d.sync.edit_answered(&mut d.session, op, c);
        self.apply_step(step, cx);
    }

    fn on_save(&mut self, revision: u64, c: Completion, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let step = d.sync.save_answered(revision, c);
        self.apply_step(step, cx);
    }

    fn on_reconcile(&mut self, keep: ReconcileKeep, c: Completion, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let step = d.sync.reconcile_answered(&mut d.session, keep, c);
        self.apply_step(step, cx);
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

    pub(super) fn on_host(&mut self, message: HostMessage, cx: &mut Ctx) {
        match message {
            m @ (HostMessage::DocumentChanged { .. }
            | HostMessage::DocumentAcknowledged { .. }
            | HostMessage::DocumentResync { .. }
            | HostMessage::DocumentConflict { .. }
            | HostMessage::DocumentSaved { .. }
            | HostMessage::DocumentRetired { .. }) => {
                let Some(d) = self.doc_mut() else { return };
                let step = d.sync.host(&mut d.session, &m);
                self.apply_step(step, cx);
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
                    d.tokens.offer(&d.session, revision, encoding, &spans);
                }
            }
            HostMessage::DocumentLocal { resource, local } => {
                if resource == self.resource() {
                    self.local = Some(local);
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
        let step = d.sync.resolve(&mut d.session, how);
        self.apply_step(step, cx);
    }

    /// Keep or discard the edits recovered from this device.
    pub(super) fn settle_recovered(&mut self, keep: bool, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let step = if keep {
            d.sync.keep_restored(&mut d.session)
        } else {
            d.sync.discard_restored(&mut d.session)
        };
        self.apply_step(step, cx);
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
