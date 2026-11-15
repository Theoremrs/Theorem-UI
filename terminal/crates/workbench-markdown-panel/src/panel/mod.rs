//! The Markdown panel: four modes over one document session, with the owner of
//! the document on the other side of the core's effects.
//!
//! The panel is a state machine over four phases (waiting for a workspace,
//! opening, refused, ready). Everything the person typed lives in the Markdown
//! model's one session (or, while a Visual block is open, in that block's own
//! session until it is written back). The panel sends the session's edits in
//! order, one in flight, shows every answer the owner gives, and never
//! resolves by guess anything the owner left unknown.
//!
//! * `input`: keys, text, pointer, and the choices they start.
//! * `flow`: completions and host messages, and the sending of edits.
//! * `chrome`: the cells, the strip under the text, and the semantic nodes.

mod chrome;
mod flow;
mod input;

use std::cell::RefCell;
use std::collections::BTreeMap;

use serde_json::{Value, json};
use theorem_workbench_core::completion::Outcome;
use theorem_workbench_core::effect::{DocumentOpen, Effect, EffectBody, ReconcileKeep};
use theorem_workbench_core::host::{ConnectionState, LocalState};
use theorem_workbench_core::ids::{
    EffectId, Generation, ResourceRef, Revision as CoreRevision, WorkspaceIdentity,
};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{Composition, Ctx, EmitError, Panel, PanelMsg, TabLabel, ViewCtx};
use theorem_workbench_editor::{EditorStyles, Mark, OwnerSync, SourceView, TokenState};
use theorem_workbench_markdown::{MarkdownDoc, MarkdownMode, MarkdownViewState};
use theorem_workbench_text::{OpId, recovery};

use crate::Drafts;
use crate::actions::Choice;
use crate::links;
use crate::styles::MarkdownPanelStyles;

/// The fewest cells of width Split draws two panes in. Below it the panel
/// shows the source alone and says so.
pub(crate) const SPLIT_MIN: u16 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug)]
pub(crate) struct Notice {
    pub text: String,
    pub tone: Tone,
}

/// Why a document is not shown, in the owner's words.
#[derive(Clone, Debug)]
pub(crate) struct Problem {
    pub headline: String,
    pub reason: String,
    pub code: Option<String>,
    /// The owner said it does not know. Never retried, never guessed.
    pub unknown: bool,
    pub can_retry: bool,
}

impl Problem {
    fn of(outcome: &Outcome) -> Self {
        if outcome.is_access_revoked()
            && let Outcome::Refused { code, reason } = outcome
        {
            return Self::revoked(code, reason);
        }
        match outcome {
            Outcome::Refused { code, reason } => {
                let low = code.to_lowercase();
                let permanent = ["binary", "too_large", "toolarge", "too-large", "size"]
                    .iter()
                    .any(|w| low.contains(w));
                Self {
                    headline: "The owner refused to open this file".into(),
                    reason: reason.clone(),
                    code: Some(code.clone()),
                    unknown: false,
                    can_retry: !permanent,
                }
            }
            Outcome::Failed { reason } => Self {
                headline: "The file could not be opened".into(),
                reason: reason.clone(),
                code: None,
                unknown: false,
                can_retry: true,
            },
            Outcome::Uncertain { reason } => Self {
                headline: "Unknown: the owner did not say whether the file opened".into(),
                reason: reason.clone(),
                code: None,
                unknown: true,
                can_retry: false,
            },
            Outcome::Accepted => Self {
                headline: "The owner sent no document".into(),
                reason: "The open was accepted without the document's text.".into(),
                code: None,
                unknown: false,
                can_retry: true,
            },
        }
    }

    /// Access to the document is gone: what was shown is not kept, and asking
    /// again would only be refused again.
    fn revoked(code: &str, reason: &str) -> Self {
        Self {
            headline: recovery::REVOKED.into(),
            reason: reason.to_owned(),
            code: Some(code.to_owned()),
            unknown: false,
            can_retry: false,
        }
    }

    fn plain(headline: &str, reason: String) -> Self {
        Self {
            headline: headline.into(),
            reason,
            code: None,
            unknown: false,
            can_retry: false,
        }
    }
}

/// An open document.
pub(crate) struct Doc {
    /// The one document session, with the Visual block that is open in it.
    /// `view` draws through a shared borrow, and the Markdown model draws from
    /// `&mut self`, so the model sits in a cell.
    pub md: RefCell<MarkdownDoc>,
    /// Source mode's widget, over the model's session.
    pub source: SourceView,
    /// The same widget over the open block's session.
    pub block: SourceView,
    /// What the owner has said about the document, and what is owed it.
    pub sync: OwnerSync,
    pub notice: Option<Notice>,
    /// The link Tab last selected, by its index among the text's links.
    pub link: Option<usize>,
    /// Text an input method is composing at the caret: drawn there, and not
    /// in the session until the composition ends.
    pub preedit: Option<String>,
    /// Syntax colour from the host, kept in step with the text.
    pub tokens: TokenState,
    /// Changes with every message that can change the text, so colour laid
    /// out for earlier text is not drawn on this.
    pub version: u64,
}

impl Doc {
    /// The colour to draw in Source and on the source side of Split.
    pub fn token_marks(&self, styles: &EditorStyles) -> Vec<Mark> {
        self.tokens
            .marks(self.md.borrow().session(), self.version, styles)
    }

    /// Typed text that has not reached the owner's session: in the open block.
    pub fn block_dirty(&self) -> bool {
        self.md
            .borrow_mut()
            .block_session()
            .is_some_and(|s| s.text() != s.accepted_text())
    }

    pub fn dirty(&self) -> bool {
        self.sync.dirty(self.md.borrow().session()) || self.block_dirty()
    }

    /// The session takes no edits while the owner says read-only or Preview
    /// shows the document.
    pub fn sync_read_only(&mut self) {
        let md = self.md.get_mut();
        let read_only = self.sync.read_only.is_some() || md.mode() == MarkdownMode::Preview;
        md.apply_local(|s| s.set_read_only(read_only));
    }

    pub fn notice(&mut self, text: impl Into<String>, tone: Tone) {
        self.notice = Some(Notice {
            text: text.into(),
            tone,
        });
    }
}

pub(crate) enum Phase {
    /// No workspace yet, or the document service is not available.
    Waiting,
    Opening,
    Failed(Problem),
    Ready(Box<Doc>),
}

/// What an effect in flight was for.
#[derive(Clone, Debug)]
pub(crate) enum Task {
    Open,
    Edit(OpId),
    Save(u64),
    Reconcile(ReconcileKeep),
    Clip(Clip),
    Release,
    /// The settle of an edit recovered from this device.
    Recovered,
}

#[derive(Clone, Debug)]
pub(crate) enum Clip {
    Copy,
    Cut {
        text: String,
        selection: (usize, usize),
        block: bool,
    },
    Paste {
        block: bool,
    },
}

/// What the body shows now, which is the mode unless the panel cannot draw it.
pub(crate) struct Shown {
    pub mode: MarkdownMode,
    /// Why this is not the mode the person chose.
    pub note: Option<String>,
}

pub struct MarkdownPanel {
    drafts: Drafts,
    styles: Option<MarkdownPanelStyles>,
    workspace: String,
    path: String,
    identity: WorkspaceIdentity,
    adopted: bool,
    body: (u16, u16),
    phase: Phase,
    documents: bool,
    connection: Option<ConnectionState>,
    /// Holds on the owner's document to give back on the next tick.
    releases: Vec<ResourceRef>,
    outstanding: BTreeMap<EffectId, Task>,
    /// The view to put back once the text arrives: mode, caret, selection,
    /// scroll anchor and the text typed in an open block.
    restore: Option<MarkdownViewState>,
    need_pump: bool,
    /// A place to put the caret (`PanelMsg::Reveal`), kept until the text is here.
    reveal: Option<(u32, u32)>,
    /// How far the document's edits are from being safe, as the host last said.
    local: Option<LocalState>,
}

impl MarkdownPanel {
    /// Build from the saved view state (`{"workspace", "path", "view", ...}`).
    pub fn restore(state: &Value, drafts: Drafts) -> Self {
        let restore = state
            .get("view")
            .and_then(|v| serde_json::from_value::<MarkdownViewState>(v.clone()).ok());
        Self {
            drafts,
            styles: None,
            workspace: state["workspace"].as_str().unwrap_or("").to_owned(),
            path: state["path"].as_str().unwrap_or("").to_owned(),
            identity: WorkspaceIdentity::default(),
            adopted: false,
            body: (0, 0),
            phase: Phase::Waiting,
            documents: true,
            connection: None,
            releases: Vec::new(),
            outstanding: BTreeMap::new(),
            restore,
            reveal: None,
            need_pump: false,
            local: None,
        }
    }

    /// Draw with these roles instead of the ones derived from the theme.
    pub fn with_styles(mut self, styles: MarkdownPanelStyles) -> Self {
        self.styles = Some(styles);
        self
    }

    fn resource(&self) -> ResourceRef {
        ResourceRef::Document {
            workspace: self.workspace.clone(),
            resource_id: self.path.clone(),
        }
    }

    fn generation(&self) -> Generation {
        self.identity.generation
    }

    fn emit(
        &self,
        cx: &mut Ctx,
        resource: ResourceRef,
        body: EffectBody,
        revision: Option<u64>,
    ) -> Result<EffectId, EmitError> {
        let generation = self.generation();
        cx.emit(|id| {
            let mut effect = Effect::new(id, resource, body).with_generation(generation);
            if let Some(n) = revision {
                effect = effect.with_revision(CoreRevision::Seq(n));
            }
            effect
        })
    }

    /// Emit and remember what it was for. A refusal to emit (too many in
    /// flight, a silent call) comes back for the caller to show or to retry on
    /// the next tick.
    fn start(
        &mut self,
        cx: &mut Ctx,
        task: Task,
        body: EffectBody,
        revision: Option<u64>,
    ) -> Result<EffectId, EmitError> {
        let id = self.emit(cx, self.resource(), body, revision)?;
        self.outstanding.insert(id, task);
        Ok(id)
    }

    /// Recovered edits wait that were not placed in the text.
    fn unplaced(&self) -> bool {
        self.doc()
            .and_then(|d| d.sync.restored.as_ref())
            .is_some_and(|r| r.moved_from.is_some())
    }

    fn doc(&self) -> Option<&Doc> {
        match &self.phase {
            Phase::Ready(d) => Some(d),
            _ => None,
        }
    }

    fn doc_mut(&mut self) -> Option<&mut Doc> {
        match &mut self.phase {
            Phase::Ready(d) => Some(d),
            _ => None,
        }
    }

    /// The mode the body is drawn and driven in. Split below its minimum width
    /// is the source alone; a text too long to read is the source alone.
    fn shown(&self, d: &Doc) -> Shown {
        let md = d.md.borrow();
        let mode = md.mode();
        if mode != MarkdownMode::Source && md.too_long() {
            return Shown {
                mode: MarkdownMode::Source,
                note: Some("too long to render: source only".to_owned()),
            };
        }
        if mode == MarkdownMode::Split && self.body.0 < SPLIT_MIN {
            return Shown {
                mode: MarkdownMode::Source,
                // Short, because it sits in the status line beside the path.
                note: Some(format!("split needs {SPLIT_MIN} columns")),
            };
        }
        Shown { mode, note: None }
    }

    /// Put the caret where `Reveal` named, once there is text to put it in.
    /// The column counts UTF-16 code units from 1, as the message says.
    pub(super) fn place_reveal(&mut self) {
        let Some((line, column)) = self.reveal else {
            return;
        };
        let Phase::Ready(d) = &mut self.phase else {
            return;
        };
        self.reveal = None;
        let at = {
            let md = d.md.get_mut();
            links::reveal_offset(&md.session().coords(), line, column)
        };
        self.go_to(at);
    }

    /// Take the workspace the root names. The first one the panel sees is the
    /// one its saved view state was for. A different one after that, or a new
    /// generation of the same one, means the document it showed is another
    /// resource now: give back the hold on the old one, keep what was typed,
    /// and open again.
    fn adopt(&mut self, identity: WorkspaceIdentity) {
        let first = !self.adopted;
        self.adopted = true;
        let moved = identity.generation != self.identity.generation
            || identity.workspace != self.identity.workspace;
        self.identity = identity;
        if first {
            if self.identity.is_set() {
                self.workspace = self.identity.workspace.clone();
            }
            return;
        }
        if !moved {
            return;
        }
        let old = self.resource();
        match std::mem::replace(&mut self.phase, Phase::Waiting) {
            Phase::Ready(d) => {
                let mut md = d.md.into_inner();
                self.restore = Some(md.view_state());
                // Typed text is never dropped: the session with its unsent
                // edits and the open block go to the drafts.
                self.drafts.put(old.clone(), md);
                self.releases.push(old);
            }
            Phase::Opening => self.releases.push(old),
            Phase::Waiting | Phase::Failed(_) => {}
        }
        self.outstanding.retain(|_, t| matches!(t, Task::Clip(_)));
        if self.identity.is_set() {
            self.workspace = self.identity.workspace.clone();
        }
    }

    fn tick(&mut self, cx: &mut Ctx) {
        for resource in std::mem::take(&mut self.releases) {
            if let Ok(id) = self.emit(cx, resource, EffectBody::DocumentClose, None) {
                self.outstanding.insert(id, Task::Release);
            }
        }
        if matches!(self.phase, Phase::Waiting)
            && self.identity.is_set()
            && self.documents
            && !self.path.is_empty()
        {
            let open = EffectBody::DocumentOpen(DocumentOpen { seed_text: None });
            if self.start(cx, Task::Open, open, None).is_ok() {
                self.phase = Phase::Opening;
            }
        }
        self.need_pump = false;
    }
}

impl MarkdownPanel {
    /// The input method's events: the preedit is shown at the caret and only
    /// the end of a composition enters the document.
    fn on_composition(&mut self, event: Composition) {
        let typing = self.doc().is_some_and(|d| self.typing(d));
        let Some(d) = self.doc_mut() else { return };
        match event {
            Composition::Start => d.preedit = Some(String::new()),
            Composition::Update { text } => d.preedit = typing.then_some(text),
            Composition::End { text } => {
                d.preedit = None;
                if typing && !text.is_empty() {
                    self.on_text(&text);
                }
            }
        }
    }
}

impl Panel for MarkdownPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        // A tick changes no text; every other message may.
        if !matches!(msg, PanelMsg::Tick)
            && let Some(d) = self.doc_mut()
        {
            d.version += 1;
        }
        match msg {
            PanelMsg::Resize { area, .. } => self.body = (area.width, area.height),
            PanelMsg::Workspace(identity) => self.adopt(identity),
            PanelMsg::Tick => self.tick(cx),
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Text(text) => self.on_text(&text),
            PanelMsg::Paste(text) => self.on_paste(&text),
            PanelMsg::Composition(event) => self.on_composition(event),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Completion(c) => self.on_completion(c, false, cx),
            PanelMsg::Cached(c) => self.on_completion(c, true, cx),
            PanelMsg::Host(message) => self.on_host(message, cx),
            PanelMsg::Action(id) => {
                if let Some(choice) = Choice::from_id(id.as_str()) {
                    self.choose(choice, cx);
                }
            }
            PanelMsg::Reveal { line, column } => {
                self.reveal = Some((line, column));
                self.place_reveal();
            }
            // Focus, composition and the terminal's messages mean nothing here;
            // the core adds messages over time, so the rest are ignored the
            // same way.
            _ => {}
        }
        self.after(cx);
    }

    fn view(&self, area: ratatui::layout::Rect, buf: &mut ratatui::buffer::Buffer, cx: &ViewCtx) {
        self.draw(area, buf, cx);
    }

    fn semantics(&self, area: ratatui::layout::Rect, cx: &ViewCtx) -> Vec<Node> {
        self.nodes(area, cx)
    }

    fn serialize(&self) -> Value {
        let mut out = json!({ "workspace": self.workspace, "path": self.path });
        let view = match &self.phase {
            Phase::Ready(d) => {
                let mut md = d.md.borrow_mut();
                Some((md.view_state(), md.revision()))
            }
            _ => self.restore.clone().map(|v| (v, 0)),
        };
        if let Some((view, revision)) = view {
            // Offsets are Unicode scalars of the text at `revision` (0: not
            // yet opened); the scroll anchor is a block and the rows into it.
            // Restoring clamps all of them to whatever text arrives.
            out["mode"] = json!(view.mode.name());
            out["view"] = serde_json::to_value(&view).unwrap_or(Value::Null);
            out["unit"] = json!("scalar");
            out["revision"] = json!(revision);
        }
        out
    }

    fn tab_label(&self) -> Option<TabLabel> {
        let title = self.path.rsplit('/').next().unwrap_or(&self.path);
        (!title.is_empty()).then(|| TabLabel {
            title: title.to_owned(),
            modified: self.doc().is_some_and(Doc::dirty),
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: self
                .doc()
                .map(|d| CoreRevision::Seq(d.md.borrow().revision())),
            generation: Some(self.generation()),
        })
    }

    fn text_entry(&self) -> bool {
        self.doc().is_some_and(|d| self.typing(d))
    }

    fn takes_chord(&self, key: &keybinds::KeyInput) -> bool {
        MarkdownPanel::takes_chord(self, key)
    }

    /// Closing the view keeps the draft with its owner: unsent text and the
    /// block that was open are kept for the next panel of the document and the
    /// panel's hold on the owner's session is released. Nothing is discarded.
    fn teardown(&mut self, cx: &mut Ctx, _destroy: bool) {
        let resource = self.resource();
        match &self.phase {
            Phase::Ready(_) => {
                self.pump(cx);
                if let Phase::Ready(d) = std::mem::replace(&mut self.phase, Phase::Waiting) {
                    let mut md = d.md.into_inner();
                    let keep = md.session().has_pending()
                        || md.session().has_conflict()
                        || md
                            .block_session()
                            .is_some_and(|s| s.text() != s.accepted_text());
                    if keep {
                        md.apply_local(|s| s.break_undo_group());
                        self.drafts.put(resource.clone(), md);
                    }
                }
                let _ = self.emit(cx, resource, EffectBody::DocumentClose, None);
            }
            Phase::Opening => {
                let _ = self.emit(cx, resource, EffectBody::DocumentClose, None);
            }
            Phase::Waiting | Phase::Failed(_) => {}
        }
    }
}
