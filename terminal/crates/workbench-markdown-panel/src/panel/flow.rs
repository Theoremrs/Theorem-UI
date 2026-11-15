//! The answers: completions of the effects the panel emitted, host messages
//! for its document, and the sending of its edits.
//!
//! What the owner owes and answers is the editor crate's `OwnerSync`, run over
//! the Markdown model's session through `apply_local`, so an open block hears
//! of every change the owner makes to the text and is merged or held, never
//! dropped. This file emits what `OwnerSync` says is owed and shows what its
//! steps say; the block rule and the tokens are the panel's own.

use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    ClipboardWrite, DocumentReconcile, DocumentSettle, EffectBody, ReconcileKeep,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{Capability, ResourceRef};
use theorem_workbench_core::{Ctx, EmitError};
use theorem_workbench_editor::{
    Held, Level, Owed, OwnerSync, SourceView, Step, resync, revision_number,
};
use theorem_workbench_markdown::{BlockResolution, MarkdownDoc, MarkdownMode};
use theorem_workbench_text::{PendingState, Resolution};

use super::{Clip, Doc, MarkdownPanel, Notice, Phase, Problem, Task, Tone};

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
            d.refresh_tokens();
            d.sync.settle_stale_save(d.md.get_mut().session());
        }
    }

    // ---- sending ----------------------------------------------------------

    /// Send what is owed: the next edit when none is in flight, then a wanted
    /// save once every edit is accepted. A call that cannot emit (a silent
    /// message) leaves the need for the next tick.
    pub(super) fn pump(&mut self, cx: &mut Ctx) {
        let owed = {
            let Phase::Ready(d) = &mut self.phase else {
                return;
            };
            let md = d.md.get_mut();
            // Nothing is owed without a pending edit or a wanted save, and
            // asking through the model costs a read of the text while a block
            // is open.
            if md.session().has_pending() || d.sync.save.wanted {
                md.apply_local(|s| d.sync.owed(s))
            } else {
                None
            }
        };
        match owed {
            Some(Owed::Edit { op, base, body }) => {
                let sent = self.start(
                    cx,
                    Task::Edit(op.clone()),
                    EffectBody::DocumentEdit(body),
                    Some(base),
                );
                if let Err(error) = sent {
                    self.need_pump = true;
                    if let Some(d) = self.doc_mut() {
                        d.md.get_mut().apply_local(|s| d.sync.edit_not_sent(s, &op));
                        if !matches!(error, EmitError::Silent) {
                            d.notice(emit_notice(error), Tone::Warn);
                        }
                    }
                }
            }
            Some(Owed::Save { revision }) => {
                let sent = self.start(
                    cx,
                    Task::Save(revision),
                    EffectBody::DocumentSave,
                    Some(revision),
                );
                if let Err(error) = sent {
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

    /// Show what a step says and let the owner go of what it settled.
    fn show(&mut self, step: Step, cx: &mut Ctx) {
        if let Some(d) = self.doc_mut() {
            for note in step.notes {
                let tone = match note.level {
                    Level::Info => Tone::Info,
                    Level::Warn => Tone::Warn,
                    Level::Error => Tone::Error,
                };
                d.notice(note.text, tone);
            }
        }
        for op in step.settle {
            let body = EffectBody::DocumentSettle(DocumentSettle { operation_id: op.0 });
            if let Ok(id) = self.emit(cx, self.resource(), body, None) {
                self.outstanding.insert(id, Task::Release);
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
            // For a resource the panel is no longer bound to: not the current
            // state, so not shown.
            _ if cached => {}
            Task::Open => self.on_open(c),
            Task::Edit(op) => {
                let Some(d) = self.doc_mut() else { return };
                let step =
                    d.md.get_mut()
                        .apply_local(|s| d.sync.edit_answered(s, op, c));
                self.show(step, cx);
            }
            Task::Save(revision) => {
                let Some(d) = self.doc_mut() else { return };
                let step = d.sync.save_answered(revision, c);
                self.show(step, cx);
            }
            Task::Reconcile(keep) => {
                let Some(d) = self.doc_mut() else { return };
                let step =
                    d.md.get_mut()
                        .apply_local(|s| d.sync.reconcile_answered(s, keep, c));
                self.show(step, cx);
            }
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
        let Some(revision) = revision_number(&opened.revision) else {
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
                .and_then(revision_number)
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
        let mut sync = OwnerSync::new(saved);
        // Text the last panel left held is held still.
        sync.held = md.session().conflict().map(|k| Held {
            reason: k.reason,
            theirs: None,
            conflict: true,
        });
        if let Some(r) = opened.read_only {
            md.apply_local(|s| sync.make_read_only(s, r.reason));
        }
        let mut d = Doc {
            md: std::cell::RefCell::new(md),
            source: SourceView::new(),
            block: SourceView::new(),
            sync,
            notice: note.map(|text| Notice {
                text,
                tone: Tone::Warn,
            }),
            link: None,
            preedit: None,
            tokens: None,
            waiting: None,
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

    pub(super) fn on_host(&mut self, message: HostMessage, cx: &mut Ctx) {
        match message {
            // What the owner says of the document goes through the sync, over
            // the model's session so an open block hears of any change.
            HostMessage::DocumentChanged { .. }
            | HostMessage::DocumentAcknowledged { .. }
            | HostMessage::DocumentResync { .. }
            | HostMessage::DocumentConflict { .. }
            | HostMessage::DocumentSaved { .. }
            | HostMessage::DocumentRetired { .. } => {
                if let Some(d) = self.doc_mut() {
                    let step = d.md.get_mut().apply_local(|s| d.sync.host(s, &message));
                    self.show(step, cx);
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
            }
            HostMessage::ConnectionChanged { state, .. } => self.connection = Some(state),
            HostMessage::DocumentTokens {
                resource,
                revision,
                encoding,
                spans,
            } => {
                let (Some(revision), true) =
                    (revision_number(&revision), resource == self.resource())
                else {
                    return;
                };
                if let Some(d) = self.doc_mut() {
                    let accepted = d.md.get_mut().revision();
                    // Spans for an older revision describe other text and are
                    // not applied; newer ones wait for the text to catch up.
                    if revision >= accepted {
                        d.waiting = Some(super::tokens::Waiting {
                            revision,
                            encoding,
                            spans,
                        });
                    }
                }
            }
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
                    d.sync.recoverable = set_aside;
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
        let step = d.md.get_mut().apply_local(|s| d.sync.resolve(s, how));
        self.show_resolved(step, how, cx);
    }

    /// A resolution's notes name the panel's own key for copying what was set
    /// aside; the editor's note is neutral.
    fn show_resolved(&mut self, mut step: Step, how: Resolution, cx: &mut Ctx) {
        if how == Resolution::TakeTheirs
            && let Some(last) = step.notes.last_mut()
            && last.level == Level::Info
        {
            last.text.push_str(" Alt+Y copies it.");
        }
        self.show(step, cx);
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
