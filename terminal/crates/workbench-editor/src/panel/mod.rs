//! The document panel: the editing widget over the shared text session, with
//! the owner of the document on the other side of the core's effects.
//!
//! The panel is a state machine over four phases (waiting for a workspace,
//! opening, refused, ready). All of what the person typed lives in the
//! session; the panel's job is to send it in order, one edit in flight, to
//! show every answer the owner gives, and never to resolve by guess anything
//! the owner left unknown.
//!
//! * `input`: keys, text, pointer, and the editing actions they start.
//! * `flow`: completions and host messages, and the sending of edits.
//! * `chrome`: the cells, the strip under the text, and the semantic nodes.
//! * `language`: hover, completions, places and findings from the language owner.
//! * `create`: naming a new page and creating it through the owner.

mod chrome;
mod create;
mod flow;
mod input;
mod language;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::completion::Outcome;
use theorem_workbench_core::effect::{DocumentOpen, Effect, EffectBody, ReconcileKeep};
use theorem_workbench_core::host::ConnectionState;
use theorem_workbench_core::ids::{
    EffectId, Generation, ResourceRef, Revision as CoreRevision, WorkspaceIdentity,
};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Composition, Ctx, EmitError, OpenTarget, Panel, PanelFactories, PanelMsg, TabLabel, ViewCtx,
};
use theorem_workbench_text::{EditSession, OpId, Scroll, ViewSnapshot};

use crate::actions::Choice;
use crate::field::Field;
use crate::find::Find;
use crate::styles::EditorStyles;
use crate::sync::Changed;
use crate::widget::SourceView;
use create::Naming;
use language::{Findings, Popup, Tokens};

/// The panel kind the registry already lists for documents.
pub const KIND: &str = "document";

/// Sessions of closed panels that still hold text the owner has not accepted.
/// The owner keeps the draft in the end (the panel only releases its hold);
/// until it does, reopening the same document gets its own session back, with
/// its undo history and the edits that were not yet accepted.
#[derive(Clone, Default)]
pub struct Drafts(Rc<RefCell<BTreeMap<ResourceRef, EditSession>>>);

impl Drafts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.0.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.borrow().is_empty()
    }

    pub fn holds(&self, resource: &ResourceRef) -> bool {
        self.0.borrow().contains_key(resource)
    }

    fn put(&self, resource: ResourceRef, session: EditSession) {
        self.0.borrow_mut().insert(resource, session);
    }

    fn take(&self, resource: &ResourceRef) -> Option<EditSession> {
        self.0.borrow_mut().remove(resource)
    }
}

/// Register the editor as the `document` panel kind and as the opener of
/// files. Every editor this factory builds shares one [`Drafts`].
pub fn register(factories: &mut PanelFactories) {
    register_with(factories, Drafts::new());
}

/// [`register`], with the drafts store the caller keeps hold of.
pub fn register_with(factories: &mut PanelFactories, drafts: Drafts) {
    factories.register(KIND, move |state, _version| {
        Box::new(EditorPanel::restore(state, drafts.clone()))
    });
    // A file at a place is a file: the root opens it, then sends the reveal.
    factories.register_opener(KIND, |target| {
        matches!(target, OpenTarget::File { .. } | OpenTarget::FileAt { .. })
    });
}

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

/// Text the owner refused, held in the session until the person chooses.
#[derive(Clone, Debug)]
pub(crate) struct Held {
    pub reason: String,
    /// What the owner has now where the person's edit was. `None` when the
    /// refusal was not a conflict, or the owner sent no current text.
    pub theirs: Option<Changed>,
    pub conflict: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Disk {
    pub revision: u64,
    pub deleted: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Unknown {
    pub op: OpId,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Plan {
    pub id: String,
    /// The revision the plan was computed against.
    pub revision: u64,
}

#[derive(Debug, Default)]
pub(crate) struct Saving {
    /// A save is wanted once the pending edits are accepted.
    pub wanted: bool,
    /// The revision of the save in flight.
    pub inflight: Option<u64>,
    /// The last save's outcome is unknown.
    pub unknown: Option<String>,
}

/// An open document.
pub(crate) struct Doc {
    pub session: EditSession,
    pub view: SourceView,
    /// The revision the owner says the checkout holds. `None`: unknown, which
    /// counts as modified.
    pub saved: Option<u64>,
    /// Counts local changes of the text, so a search is found again.
    pub version: u64,
    pub read_only: Option<String>,
    pub inflight: Option<OpId>,
    pub unknown: Option<Unknown>,
    /// The text is behind the owner's: no edit is sent until its resync.
    pub desync: Option<String>,
    pub held: Option<Held>,
    pub disk: Option<Disk>,
    pub save: Saving,
    pub notice: Option<Notice>,
    pub find: Find,
    pub in_find: bool,
    pub rename: Option<Field>,
    pub plan: Option<Plan>,
    /// The replace field of the find bar has the keyboard.
    pub in_replace: bool,
    /// A hover, a completion list or a list of places over the text.
    pub popup: Option<Popup>,
    /// What the language owner found, for the revision it was asked about.
    pub findings: Findings,
    /// Syntax colour, for the revision the host computed it at.
    pub tokens: Option<Tokens>,
    /// Spans for a revision not reached yet.
    pub waiting: Option<language::Waiting>,
    /// Text an input method is composing at the caret.
    pub preedit: Option<String>,
    /// The whole text from before "take theirs", kept so it can be copied.
    pub recoverable: Option<String>,
    pub busy: Option<&'static str>,
}

impl Doc {
    pub fn dirty(&self) -> bool {
        self.session.has_pending() || self.saved != Some(self.session.accepted_revision())
    }

    pub fn touch(&mut self) {
        self.version += 1;
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
    Rename(u64),
    Apply,
    Format,
    Release,
    Hover { revision: u64, version: u64 },
    Complete { revision: u64, version: u64 },
    Navigate { revision: u64, references: bool },
    Check(u64),
    Create { path: String, adopt: bool },
}

#[derive(Clone, Debug)]
pub(crate) enum Clip {
    Copy,
    Cut {
        text: String,
        selection: (usize, usize),
    },
    Paste,
}

pub struct EditorPanel {
    drafts: Drafts,
    styles: Option<EditorStyles>,
    workspace: String,
    path: String,
    identity: WorkspaceIdentity,
    adopted: bool,
    body: (u16, u16),
    phase: Phase,
    documents: bool,
    language: bool,
    connection: Option<ConnectionState>,
    /// Holds on the owner's document to give back on the next tick.
    releases: Vec<ResourceRef>,
    outstanding: BTreeMap<EffectId, Task>,
    /// Caret, selection and scroll to put back once the text arrives.
    restore: Option<ViewSnapshot>,
    need_pump: bool,
    /// The name of a page being typed, when there is none yet.
    naming: Option<Naming>,
    /// A place to put the caret (`PanelMsg::Reveal`), kept until the text is here.
    reveal: Option<(u32, u32)>,
}

/// The scalar offset of `line` (from 1) and `column` (UTF-16 units, from 1),
/// clamped to the end of the line it names.
fn reveal_offset(text: &str, line: u32, column: u32) -> usize {
    let mut at = 0;
    let mut rows = text.split_inclusive('\n');
    for _ in 1..line.max(1) {
        match rows.next() {
            Some(row) => at += row.chars().count(),
            None => break,
        }
    }
    let row = rows.next().unwrap_or("");
    let want = column.saturating_sub(1) as usize;
    let mut units = 0;
    for ch in row.trim_end_matches(['\n', '\r']).chars() {
        if units >= want {
            break;
        }
        units += ch.len_utf16();
        at += 1;
    }
    at
}

fn seq(r: &CoreRevision) -> Option<u64> {
    match r {
        CoreRevision::Seq(n) => Some(*n),
        CoreRevision::Opaque(_) => None,
    }
}

impl EditorPanel {
    /// Build from the saved view state (`{"workspace", "path", ...}`; `Null`
    /// for a panel nothing has named yet).
    pub fn restore(state: &Value, drafts: Drafts) -> Self {
        let n = |v: &Value| v.as_u64().unwrap_or(0) as usize;
        let restore = state.get("anchor").map(|_| ViewSnapshot {
            anchor: n(&state["anchor"]),
            head: n(&state["head"]),
            scroll: Scroll {
                top_line: n(&state["scroll"]["top_line"]),
                top_row: n(&state["scroll"]["top_row"]),
                left_cell: n(&state["scroll"]["left_cell"]),
            },
        });
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
            language: true,
            connection: None,
            releases: Vec::new(),
            outstanding: BTreeMap::new(),
            restore,
            reveal: None,
            need_pump: false,
            naming: state["path"]
                .as_str()
                .is_none_or(str::is_empty)
                .then(|| Naming {
                    adopt: true,
                    ..Naming::default()
                }),
        }
    }

    /// Draw with these roles instead of the ones derived from the theme.
    pub fn with_styles(mut self, styles: EditorStyles) -> Self {
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

    /// Put the caret where `Reveal` named, once there is text to put it in.
    /// The column counts UTF-16 code units from 1, as the message says.
    pub(super) fn place_reveal(&mut self) {
        let Some((line, column)) = self.reveal else {
            return;
        };
        if self.doc().is_none() {
            return;
        }
        self.reveal = None;
        let Some(d) = self.doc_mut() else { return };
        let at = reveal_offset(&d.session.text(), line, column);
        d.session.set_selection(at, at);
        d.view.reveal(&mut d.session);
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
                self.restore = Some(d.session.view_snapshot());
                if d.session.has_pending() {
                    self.drafts.put(old.clone(), d.session);
                }
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
        self.check_due(cx);
        self.need_pump = false;
    }

    /// The input method's events: the preedit is shown at the caret and the
    /// text enters the document only when the composition ends.
    fn on_composition(&mut self, event: Composition) {
        match event {
            Composition::Start => self.compose(None),
            Composition::Update { text } => self.compose(Some(&text)),
            Composition::End { text } => self.commit_composition(&text),
        }
    }

    /// An input method is composing `preedit` at the caret (`None`: it
    /// stopped). The text is drawn underlined where it will go and is not in
    /// the session until [`commit_composition`](Self::commit_composition), so
    /// it is never sent, undone or found by a search while it is only a guess.
    pub fn compose(&mut self, preedit: Option<&str>) {
        let Some(d) = self.doc_mut() else { return };
        d.preedit = preedit
            .filter(|p| !p.is_empty() && !d.session.config().read_only)
            .map(str::to_owned);
    }

    /// The input method committed `text`: it enters the document as one edit
    /// at the caret.
    pub fn commit_composition(&mut self, text: &str) {
        let Some(d) = self.doc_mut() else { return };
        d.preedit = None;
        if text.is_empty() {
            return;
        }
        match d.session.insert_text(text) {
            Ok(Some(_)) => {
                d.touch();
                d.view.reveal(&mut d.session);
            }
            Ok(None) => {}
            Err(e) => {
                let note = self.edit_error(&e);
                self.say(note, Tone::Warn);
            }
        }
    }
}

impl Panel for EditorPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        match msg {
            PanelMsg::Resize { area, .. } => self.body = (area.width, area.height),
            PanelMsg::Workspace(identity) => self.adopt(identity),
            PanelMsg::Tick => self.tick(cx),
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Text(text) => self.on_text(&text),
            PanelMsg::Paste(text) => self.on_paste(&text),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Completion(c) => self.on_completion(c, false, cx),
            PanelMsg::Cached(c) => self.on_completion(c, true, cx),
            PanelMsg::Host(message) => self.on_host(message),
            PanelMsg::Action(id) => {
                if let Some(choice) = Choice::from_id(id.as_str()) {
                    self.choose(choice, cx);
                }
            }
            PanelMsg::Reveal { line, column } => {
                self.reveal = Some((line, column));
                self.place_reveal();
            }
            PanelMsg::Composition(event) => self.on_composition(event),
            // Focus and the terminal's messages mean nothing to a document; the
            // core adds messages over time, so the rest are ignored the same way.
            _ => {}
        }
        self.after(cx);
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.draw(area, buf, cx);
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        self.nodes(area, cx)
    }

    fn serialize(&self) -> Value {
        let view = match &self.phase {
            Phase::Ready(d) => Some((d.session.view_snapshot(), d.session.accepted_revision())),
            _ => self.restore.map(|v| (v, 0)),
        };
        let mut out = json!({ "workspace": self.workspace, "path": self.path });
        if let Some((v, revision)) = view {
            // Offsets are scalars of the text at `revision` (0: not yet
            // opened); restoring clamps them to whatever text arrives.
            out["anchor"] = json!(v.anchor);
            out["head"] = json!(v.head);
            out["scroll"] = json!({
                "top_line": v.scroll.top_line,
                "top_row": v.scroll.top_row,
                "left_cell": v.scroll.left_cell,
            });
            out["unit"] = json!("scalar");
            out["revision"] = json!(revision);
        }
        out
    }

    fn tab_label(&self) -> Option<TabLabel> {
        let title = self.path.rsplit('/').next().filter(|n| !n.is_empty())?;
        Some(TabLabel {
            title: title.to_owned(),
            modified: self.doc().is_some_and(Doc::dirty),
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: self
                .doc()
                .map(|d| CoreRevision::Seq(d.session.accepted_revision())),
            generation: Some(self.generation()),
        })
    }

    fn text_entry(&self) -> bool {
        matches!(self.phase, Phase::Ready(_))
    }

    /// Closing the view keeps the draft with its owner: unsent text is kept
    /// for the next editor of the document and the panel's hold on the owner's
    /// session is released. Nothing is discarded.
    fn teardown(&mut self, cx: &mut Ctx, _destroy: bool) {
        let resource = self.resource();
        match &self.phase {
            Phase::Ready(_) => {
                self.pump(cx);
                if let Phase::Ready(mut d) = std::mem::replace(&mut self.phase, Phase::Waiting)
                    && d.session.has_pending()
                {
                    d.session.break_undo_group();
                    self.drafts.put(resource.clone(), d.session);
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

#[cfg(test)]
mod tests {
    use super::reveal_offset;

    #[test]
    fn a_reveal_counts_its_column_in_utf16_units_and_stays_on_its_line() {
        let text = "ab\nx\u{1F600}yz\nlast";
        assert_eq!(reveal_offset(text, 1, 1), 0);
        assert_eq!(reveal_offset(text, 2, 1), 3);
        // The emoji is two UTF-16 units and one scalar.
        assert_eq!(reveal_offset(text, 2, 4), 5);
        assert_eq!(reveal_offset(text, 2, 99), 7, "clamped to the line end");
        assert_eq!(reveal_offset(text, 3, 3), 10);
        assert_eq!(reveal_offset(text, 99, 1), text.chars().count());
    }
}
