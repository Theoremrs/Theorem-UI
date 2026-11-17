//! What a child panel implements, and what the root lends it while it runs.
//!
//! A panel is written against this module only. It never sees the dock, the
//! registry or another panel: the root routes input to it, judges the answers
//! to its effects, and asks it for cells and semantic nodes.
//!
//! One message type, [`PanelMsg`], carries everything the root can say to a
//! panel, so the root keeps no knowledge of a panel's own `Msg`. A panel maps
//! a `PanelMsg` to its own messages inside `update`.

use std::collections::BTreeMap;

use keybinds::{KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use theorem_workbench_dock::CellMetrics;

use crate::completion::Completion;
use crate::draft::SourceReference;
use crate::effect::{CoordinateUnit, Effect, EffectKind};
use crate::host::{HostMessage, ProgramReport};
use crate::ids::{
    ActionId, Actor, EffectId, EffectIds, PanelInstanceId, ResourceRef, WorkspaceIdentity,
};
use crate::queue::SourceQueues;
use crate::registry::{Capabilities, PickerRow};
use crate::semantics::Node;
use crate::stale::{Binding, InFlight, InFlightFull};
use crate::theme::Theme;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerKind {
    Down(Button),
    Up(Button),
    Move,
    /// Scroll by whole cells; positive `dy` is down.
    Wheel {
        dx: i16,
        dy: i16,
    },
}

/// A panel's pointer event. `x` and `y` are cells from the panel body's top
/// left corner. They are negative or past the body only while the panel holds
/// the pointer, between a press inside it and the release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanelPointer {
    pub kind: PointerKind,
    pub x: i32,
    pub y: i32,
    pub mods: Mods,
    /// Consecutive presses at this spot, from the host: 1 for a single press,
    /// 2 for a double click. Only a `Down` carries a count above 1.
    pub clicks: u8,
}

/// Something a panel asks the root to show in a panel of its own. The root
/// decides which panel kind serves it (see [`PanelFactories::register_opener`](crate::factory::PanelFactories::register_opener)),
/// so the asking panel names the thing, never a kind.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum OpenTarget {
    /// A file of a workspace, as a document.
    File { workspace: String, path: String },
    /// A file at a line and column (a transcript's file reference, a
    /// diagnostic), both counted from 1, the column in UTF-16 code units. It is the same document as `File`, so
    /// a panel already showing the file is focused.
    FileAt {
        workspace: String,
        path: String,
        line: u32,
        column: u32,
    },
    /// A commit's diff in a repository (a history row).
    Commit {
        workspace: String,
        repository: String,
        commit: String,
    },
    /// A file as it was at a commit, read only (a history row's file).
    Revision {
        workspace: String,
        repository: String,
        commit: String,
        path: String,
    },
    /// A new document with no path yet (New page), named by an id the asker
    /// minted so a second New page is not the first.
    Untitled { workspace: String, id: String },
    /// One file of a delegation's changes, shown before and after (a run's
    /// delegation card). A panel of kind `delegation` serves it.
    Delegation {
        run_id: String,
        delegation_id: String,
        path: String,
    },
    /// A terminal session of the workspace, in a pane of its own in the main
    /// region (a Herdr row of the Threads panel). A pane already bound to it is
    /// focused instead. A `shell` pane serves it.
    Terminal {
        workspace: String,
        session: String,
        backend: crate::effect::TerminalBackend,
    },
}

impl OpenTarget {
    /// The resource a panel showing this target is bound to. A panel already
    /// bound to it is focused instead of opening a second one.
    pub fn resource(&self) -> ResourceRef {
        match self {
            Self::File { workspace, path }
            | Self::FileAt {
                workspace, path, ..
            } => ResourceRef::Document {
                workspace: workspace.clone(),
                resource_id: path.clone(),
            },
            Self::Commit {
                workspace,
                repository,
                commit,
            } => ResourceRef::Commit {
                workspace: workspace.clone(),
                repository: repository.clone(),
                commit: commit.clone(),
            },
            Self::Revision {
                workspace,
                repository,
                commit,
                path,
            } => ResourceRef::Revision {
                workspace: workspace.clone(),
                repository: repository.clone(),
                commit: commit.clone(),
                path: path.clone(),
            },
            Self::Untitled { workspace, id } => ResourceRef::Untitled {
                workspace: workspace.clone(),
                id: id.clone(),
            },
            Self::Delegation {
                run_id,
                delegation_id,
                path,
            } => ResourceRef::Delegation {
                run_id: run_id.clone(),
                delegation_id: delegation_id.clone(),
                path: path.clone(),
            },
            Self::Terminal {
                workspace, session, ..
            } => ResourceRef::Terminal {
                workspace: workspace.clone(),
                session: session.clone(),
            },
        }
    }

    /// Where the target opens when it is not the kind's own place: a terminal
    /// session is read beside the conversation, not in the tools group.
    pub fn main_region(&self) -> bool {
        matches!(self, Self::Terminal { .. })
    }

    /// The panel kind named when nothing serves the target: the placeholder
    /// keeps [`state`](Self::state) under it, so a build that serves the kind
    /// can open it later.
    pub fn fallback_kind(&self) -> &'static str {
        match self {
            Self::File { .. }
            | Self::FileAt { .. }
            | Self::Revision { .. }
            | Self::Untitled { .. } => "document",
            Self::Commit { .. } => "diff",
            Self::Delegation { .. } => "delegation",
            Self::Terminal { .. } => "shell",
        }
    }

    /// The view state a constructor of a serving kind is built from.
    pub fn state(&self) -> Value {
        match self {
            Self::File { workspace, path } => {
                serde_json::json!({ "workspace": workspace, "path": path })
            }
            Self::FileAt {
                workspace,
                path,
                line,
                column,
            } => serde_json::json!({
                "workspace": workspace, "path": path, "line": line, "column": column
            }),
            Self::Commit {
                workspace,
                repository,
                commit,
            } => serde_json::json!({
                "workspace": workspace, "repository": repository, "commit": commit
            }),
            Self::Revision {
                workspace,
                repository,
                commit,
                path,
            } => serde_json::json!({
                "workspace": workspace, "repository": repository,
                "commit": commit, "path": path, "revision": true
            }),
            Self::Untitled { workspace, id } => {
                serde_json::json!({ "workspace": workspace, "untitled": id })
            }
            Self::Delegation {
                run_id,
                delegation_id,
                path,
            } => serde_json::json!({
                "runId": run_id, "delegationId": delegation_id, "path": path
            }),
            Self::Terminal {
                workspace,
                session,
                backend,
            } => serde_json::json!({
                "v": 1,
                "workspace": workspace,
                "session": session,
                "backend": match backend {
                    crate::effect::TerminalBackend::Herdr => "herdr",
                    crate::effect::TerminalBackend::Native => "native",
                },
            }),
        }
    }

    /// The place to put the caret once the target is shown: `(line, column)`,
    /// both from 1, the column in UTF-16 code units. Only `FileAt` has one.
    pub fn reveal(&self) -> Option<(u32, u32)> {
        match self {
            Self::FileAt { line, column, .. } => Some((*line, *column)),
            _ => None,
        }
    }

    /// A tab title: the last part of the path.
    pub fn title(&self) -> String {
        match self {
            Self::File { path, .. } | Self::FileAt { path, .. } => last_part(path),
            Self::Commit { commit, .. } => short(commit),
            Self::Revision { commit, path, .. } => {
                format!("{} @ {}", last_part(path), short(commit))
            }
            Self::Untitled { .. } => "Untitled".to_owned(),
            Self::Delegation { path, .. } => last_part(path),
            Self::Terminal { session, .. } => session.clone(),
        }
    }

    /// The target in words, for a reason a person reads.
    pub fn describe(&self) -> String {
        match self {
            Self::File { path, .. } => format!("the file \"{path}\""),
            Self::FileAt {
                path, line, column, ..
            } => format!("the file \"{path}\" at {line}:{column}"),
            Self::Commit { commit, .. } => format!("the changes in commit {}", short(commit)),
            Self::Revision { commit, path, .. } => {
                format!("the file \"{path}\" at commit {}", short(commit))
            }
            Self::Untitled { .. } => "a new document".to_owned(),
            Self::Delegation { path, .. } => {
                format!("the changes a delegation made to \"{path}\"")
            }
            Self::Terminal { session, .. } => format!("the terminal \"{session}\""),
        }
    }
}

fn last_part(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_owned()
}

/// A commit id as people read it: its first seven characters.
fn short(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// Everything the root says to a panel. New messages are added over time, so
/// a match outside the core ends in a wildcard arm.
#[derive(Clone, PartialEq)]
#[non_exhaustive]
pub enum PanelMsg {
    /// A key the workbench did not claim.
    Key(KeyInput),
    /// Text from the host input service (IME, dictation, typed text).
    Text(String),
    Paste(String),
    /// A step of an IME composition (the browser's `compositionstart`,
    /// `compositionupdate` and `compositionend`). Text typed during one is
    /// not sent as `Text`.
    Composition(Composition),
    Pointer(PanelPointer),
    /// The body the panel is drawn in, or its cell size, changed.
    ///
    /// Environment messages (`Resize`, `Focus`) arrive on a silent [`Ctx`]:
    /// a panel cannot emit an effect in answer, so opening or focusing a tool
    /// never starts work. A panel that needs data records the need and emits
    /// on its next `Tick` or input.
    Resize {
        area: Rect,
        metrics: CellMetrics,
    },
    Focus(bool),
    /// The answer to an effect this panel emitted, judged [`Apply`](crate::stale::Verdict::Apply).
    /// An `Uncertain` outcome arrives as such.
    Completion(Completion),
    /// The answer to an effect this panel emitted, for a resource it is no
    /// longer bound to. Keep it keyed by its resource; do not show it as the
    /// current state. Arrives on a silent `Ctx`.
    Cached(Completion),
    /// A host event for the resource the panel is bound to (or any panel, for
    /// events that name none). Revision and generation stamps have been judged.
    Host(HostMessage),
    /// Output of the terminal session the panel is bound to, taken from the
    /// bounded PTY queue: `bytes` start at the absolute `offset` of the binding
    /// `epoch` (never older than the panel's own). Feed them with
    /// `Screen::feed_at(offset, &bytes)`. Arrives on a tick or before the next
    /// terminal event, in the order the host sent.
    TerminalOutput {
        epoch: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    /// The host repainted the screen: `formatted` replays the visible grid and
    /// already includes every byte before `offset`. Call
    /// `Screen::reset_with_formatted(&formatted, offset)`.
    TerminalReset {
        epoch: u64,
        offset: u64,
        formatted: Vec<u8>,
    },
    /// Output was dropped before it reached the pane (its session's queue was
    /// full, the total bound was reached by this session, or one frame was
    /// larger than the queue): the screen is no longer contiguous with the
    /// stream. Never silent: ask the host for a reset, by attaching again from
    /// the screen's applied offset. Sent only to the panes bound to the session
    /// that lost output; `frames` and `bytes` count what that session lost.
    TerminalResetRequest {
        frames: u64,
        bytes: u64,
    },
    /// Every document open in the workspace a repository panel is bound to,
    /// whole list each time, one entry per path (several views of one path are
    /// merged: unsaved if any is, the newest accepted revision). Sent only when
    /// the list changed; arrives on a silent `Ctx`.
    Documents(Vec<OpenDocumentState>),
    /// A reference another panel added to this conversation's draft
    /// (`Ctx::refer`), in the order they were added. Arrives on a silent `Ctx`:
    /// append it to the draft's chips; do not send and do not move focus.
    Reference(SourceReference),
    /// What the program in the terminal this panel is bound to says about
    /// itself (R32), as the host last said it. Sent only when the report's
    /// epoch is the binding's. It is the program's word, shown as text: handling
    /// it must not emit an effect, raise a notice, move focus or change what the
    /// panel allows, and its text is never read as an action. Arrives on a
    /// silent `Ctx`. A report with an older `seq` than the one held is the
    /// panel's to ignore (`ProgramReport::replaced_by`).
    TerminalReport(ProgramReport),
    /// A registered action of the panel's kind with intent `Create`, `Start`
    /// or `Destroy`. The panel supplies the effect's payload.
    Action(ActionId),
    /// Another thread was asked for as the open conversation (the Threads
    /// panel's Open): the conversation panel emits the switch, naming the
    /// thread and the project to open it under.
    Switch {
        project: String,
        thread: String,
    },
    /// The host named a different workspace or environment, or this panel was
    /// built after it did. Arrives on a silent `Ctx`: a panel that needs data
    /// for the new workspace records the need and emits on its next `Tick`. Its
    /// `generation` is the binding generation for workspace-bound state.
    Workspace(WorkspaceIdentity),
    /// Whether the person asked for reduced motion. Sent when it changes and
    /// to a panel built after it was set; a panel that was never told has
    /// full motion. Arrives on a silent `Ctx`. Whether the window has focus
    /// is `Focus`, sent to the panel that owns the keyboard.
    Motion {
        reduced: bool,
    },
    /// Put the caret at a place in the document the panel shows: sent after
    /// `OpenTarget::FileAt` focuses the panel already showing the file, and
    /// after it creates one. Arrives on a silent `Ctx`, possibly before the
    /// document has loaded: a panel that is not ready keeps the place and
    /// applies it when it is, and a later `Reveal` replaces an earlier one.
    ///
    /// `line` counts from 1, as search rows and diagnostics give it. `column`
    /// counts from 1 in UTF-16 code units: the unit of LSP `character` and of
    /// Monaco's column, and what a search row's `textOffset + match.start` is
    /// in, plus one. Neither is a byte or a scalar offset.
    Reveal {
        line: u32,
        column: u32,
    },
    /// Follow the agent: an agent run edited this panel's document. Put the view
    /// at `start`, counted in `unit` from the start of the text before the
    /// edit (the text before the first edit is the same in both revisions, so
    /// either places it) and take no focus: the panel owns the text and does
    /// the conversion. Arrives on a silent `Ctx`, possibly before the document
    /// has loaded (keep it, apply it when ready; a later one replaces it). It
    /// is never sent to the panel that has the keyboard, so a person's caret
    /// and draft are not disturbed.
    RevealOffset {
        start: u32,
        unit: CoordinateUnit,
    },
    /// One frame. Work that was deferred from a silent message starts here.
    Tick,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EmitError {
    #[error("this message may not start work")]
    Silent,
    #[error("closing a view may not emit a {0:?} effect")]
    Forbidden(EffectKind),
    #[error("a {0:?} effect is for the person only; an agent's action may not emit it")]
    HumanOnly(EffectKind),
    #[error("too many effects in flight (limit {})", .0.limit)]
    InFlightFull(InFlightFull),
}

/// How a call into a panel may use its [`Ctx`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Normal,
    Silent,
    /// A `Destroy` action is running: a close it asks for destroys.
    Destroying,
    /// Effects of these kinds are refused (a view closing without a destroy).
    Forbid(Vec<EffectKind>),
}

/// What the root lends a panel for one call.
pub struct Ctx<'a> {
    pub(crate) panel: PanelInstanceId,
    pub(crate) ids: &'a mut EffectIds,
    pub(crate) in_flight: &'a mut InFlight,
    pub(crate) origins: &'a mut BTreeMap<EffectId, PanelInstanceId>,
    pub(crate) queues: &'a mut SourceQueues,
    pub(crate) mode: Mode,
    pub(crate) workspace: &'a WorkspaceIdentity,
    pub(crate) caps: &'a Capabilities,
    pub(crate) actor: &'a Actor,
    pub(crate) args: &'a crate::agent::ActionArgs,
    pub(crate) effects: Vec<Effect>,
    pub(crate) opens: Vec<OpenTarget>,
    pub(crate) references: Vec<SourceReference>,
    pub(crate) switches: Vec<(String, String)>,
    pub(crate) close: bool,
    pub(crate) invalidated: bool,
    /// The in-flight bound refused an emit: the limit it hit.
    pub(crate) full: Option<usize>,
    /// Why the panel would not do the action it was asked for.
    pub(crate) refusals: Vec<String>,
}

impl Ctx<'_> {
    /// What the host offers now. It reads the root's own set when called, so
    /// a panel built after `CapabilitiesChanged` (or restored from a layout)
    /// sees the current set, and one that asks again later sees a change.
    pub fn capabilities(&self) -> &Capabilities {
        self.caps
    }

    /// Ask the root to show `target`: focus the panel already bound to it, else
    /// open the panel kind that serves it in the main region and focus that,
    /// else open the unavailable placeholder with a reason. Opening emits no
    /// effect; the new panel loads on its own first `Tick`. Ignored on a silent
    /// `Ctx` and while a view is closing.
    pub fn open(&mut self, target: OpenTarget) {
        if matches!(self.mode, Mode::Silent | Mode::Forbid(_)) {
            return;
        }
        self.opens.push(target);
    }

    /// Add `reference` to the draft of the conversation of this workspace (the
    /// Theo panel: the focused one, else the first, opened when none is, with
    /// the keyboard where it was). It arrives there as
    /// [`PanelMsg::Reference`]. No effect is emitted and nothing is sent: it
    /// only adds a chip to a draft the person still has to send, so an agent's
    /// action may do it. A reference from a panel bound to another workspace
    /// than the current one is dropped. Ignored on a silent `Ctx` and while a
    /// view is closing.
    pub fn refer(&mut self, reference: SourceReference) {
        if matches!(self.mode, Mode::Silent | Mode::Forbid(_)) {
            return;
        }
        self.references.push(reference);
    }

    /// Ask for `thread` of `project` to be the open conversation: the
    /// conversation panel emits the switch (`PanelMsg::Switch`), for the same
    /// party the call is for. Ignored on a silent `Ctx` and while a view is
    /// closing.
    pub fn switch_conversation(&mut self, project: &str, thread: &str) {
        if matches!(self.mode, Mode::Silent | Mode::Forbid(_)) {
            return;
        }
        self.switches.push((project.to_owned(), thread.to_owned()));
    }

    /// Who the call is for: the person (a key, a click, the person's own
    /// action) or the agent run that asked for an action. A panel that starts
    /// work for an action reads it here instead of assuming a person.
    pub fn actor(&self) -> &Actor {
        self.actor
    }

    /// The arguments of the action being run (the task, the words to send,
    /// the option chosen); empty for everything else.
    pub fn args(&self) -> &crate::agent::ActionArgs {
        self.args
    }

    /// Say why the action this call is for was not done. The root raises it
    /// as a refusal, so the agent that asked is answered with the reason and
    /// the person sees it as a notice.
    pub fn refuse(&mut self, reason: impl Into<String>) {
        self.refusals.push(reason.into());
    }

    /// The workspace and environment now, read-only.
    pub fn workspace(&self) -> &WorkspaceIdentity {
        self.workspace
    }

    /// Emit an effect. `build` receives the id to put in its envelope. The
    /// effect is registered as in flight, and its completion comes back to
    /// this panel as [`PanelMsg::Completion`] or [`PanelMsg::Cached`].
    pub fn emit(&mut self, build: impl FnOnce(EffectId) -> Effect) -> Result<EffectId, EmitError> {
        let actor = self.actor.clone();
        self.emit_as(actor, build)
    }

    /// Emit an effect for `actor` instead of this call's: work an earlier
    /// action asked for that waited on an answer, such as a side chat's first
    /// task, sent once the chat exists. The same checks as [`Ctx::emit`],
    /// human-only kinds included.
    pub fn emit_as(
        &mut self,
        actor: Actor,
        build: impl FnOnce(EffectId) -> Effect,
    ) -> Result<EffectId, EmitError> {
        if self.mode == Mode::Silent {
            return Err(EmitError::Silent);
        }
        let mut effect = build(self.ids.mint());
        // The envelope says who the call was for, whatever `build` left there.
        effect.actor = actor;
        if effect.kind().human_only() && matches!(effect.actor, Actor::Agent { .. }) {
            return Err(EmitError::HumanOnly(effect.kind()));
        }
        if let Mode::Forbid(kinds) = &self.mode
            && kinds.contains(&effect.kind())
        {
            return Err(EmitError::Forbidden(effect.kind()));
        }
        if let Err(full) = self.in_flight.register(&effect) {
            self.full = Some(full.limit);
            return Err(EmitError::InFlightFull(full));
        }
        self.origins.insert(effect.id, self.panel.clone());
        let id = effect.id;
        self.effects.push(effect);
        Ok(id)
    }

    /// Ask the root to close this panel's view after this call returns. A
    /// close never destroys the resource unless the root is already running a
    /// `Destroy` action. Ignored on a silent `Ctx`.
    pub fn close_self(&mut self) {
        self.close = true;
    }

    /// Ask for a redraw. Every message the root routes already redraws; a
    /// `Tick` that changed something visible must call this.
    pub fn invalidate(&mut self) {
        self.invalidated = true;
    }

    pub fn panel(&self) -> &PanelInstanceId {
        &self.panel
    }

    /// The bounded per-source queues, shared by every panel.
    pub fn queues(&mut self) -> &mut SourceQueues {
        self.queues
    }
}

/// The picker as the picker panel draws it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickerView {
    pub rows: Vec<PickerRow>,
    pub selected: usize,
    pub filter: String,
    /// Showing a page below the main one ("More tools", Layouts, a name
    /// entry): its back row is drawn.
    pub more: bool,
    /// What the page is called, when it is not "Tools" or "More tools".
    pub heading: Option<String>,
    /// The filter line is a name entry, and this is what it asks for ("Save
    /// layout as"). No rows are drawn for an entry.
    pub entry: Option<String>,
    /// Why the row last chosen could not be, until the selection moves.
    pub reason: Option<String>,
    /// The chord the active bindings give pinning and unpinning, for the
    /// selected row's hint. None: unbound.
    pub pin_shortcut: Option<String>,
}

/// One step of an input-method composition. Its `Debug` prints sizes, not text.
#[derive(Clone, PartialEq, Eq)]
pub enum Composition {
    /// A composition began at the caret.
    Start,
    /// The preedit text now: it replaces the previous preedit, and is not yet
    /// part of the document.
    Update { text: String },
    /// The composition ended with `text` committed (empty when it was
    /// cancelled).
    End { text: String },
}

/// How the caret is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CaretShape {
    /// An outlined cell: the composer's caret, never a character of the text.
    HollowBlock,
    FilledBlock,
    Bar,
}

/// Whether the caret shows. `Blinking` is the panel asking to blink; the root
/// answers `Steady` instead while the person asked for reduced motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CaretPhase {
    Steady,
    Blinking,
    /// Another control owns input, or the caret is not shown at the moment.
    Hidden,
}

/// Where the text caret is, as a cell in absolute frame coordinates. The
/// hidden input field the IME candidate window attaches to sits at `x`, `y`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Caret {
    pub x: u16,
    pub y: u16,
    pub shape: CaretShape,
    pub phase: CaretPhase,
}

/// One open document of a workspace, as a repository panel is told of it (see
/// [`PanelMsg::Documents`]). The model builds it from the document-bound panels;
/// it is not a host message and never leaves the core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenDocumentState {
    /// The document's path in the workspace (its resource id).
    pub path: String,
    /// The revision the owner has accepted for the document: the binding
    /// revision of a document panel, when it is a sequence number. `None` when
    /// no panel has loaded it yet or the owner's revisions are opaque.
    pub saved_revision: Option<u64>,
    /// Some view of the document holds changes the owner has not saved (its tab
    /// says modified).
    pub unsaved: bool,
}

/// What a tab shows for a panel that names itself (see [`Panel::tab_label`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabLabel {
    pub title: String,
    /// Unsaved changes: the tab is marked.
    pub modified: bool,
}

/// Read-only context for `view` and `semantics`.
pub struct ViewCtx<'a> {
    pub theme: &'a Theme,
    /// The workspace and environment now.
    pub workspace: &'a WorkspaceIdentity,
    /// This panel owns the keyboard and the window has focus.
    pub focused: bool,
    /// Present while the tool picker is open.
    pub picker: Option<&'a PickerView>,
    /// What the host offers now: the root's own set, never a copy. A context
    /// built by [`ViewCtx::new`] offers nothing until [`ViewCtx::with_capabilities`].
    pub capabilities: &'a Capabilities,
}

static NO_CAPABILITIES: Capabilities = Capabilities {
    granted: std::collections::BTreeSet::new(),
};

impl<'a> ViewCtx<'a> {
    /// The same context reading `capabilities` (the model's, usually).
    pub fn with_capabilities(mut self, capabilities: &'a Capabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// What the host offers now.
    pub fn capabilities(&self) -> &Capabilities {
        self.capabilities
    }

    /// A context for `theme` and `workspace`, unfocused, with no picker.
    pub fn new(theme: &'a Theme, workspace: &'a WorkspaceIdentity) -> Self {
        Self {
            theme,
            workspace,
            focused: false,
            picker: None,
            capabilities: &NO_CAPABILITIES,
        }
    }
}

/// A child panel. Files, the tool picker, the Theo transcript, a terminal pane
/// and an editor are all written against this and nothing else.
pub trait Panel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx);

    /// Draw into `area` (the body). No I/O.
    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx);

    /// This panel's semantic nodes, root first, for a body at `area`. Ids are
    /// local to the panel: the root namespaces them, so two panels cannot
    /// collide.
    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node>;

    /// View state only, never the resource. Saved in the layout document.
    fn serialize(&self) -> Value;

    /// What its tab says, when that is not the registry's static title: the
    /// document's name and whether it has unsaved changes. The tab strip and
    /// the semantic tree read it each time they draw, so it needs no message
    /// to change. `None`: the registry's title, unmarked.
    fn tab_label(&self) -> Option<TabLabel> {
        None
    }

    /// What the panel is bound to now, which every completion is judged
    /// against. `None` for a panel bound to nothing.
    fn binding(&self) -> Option<Binding> {
        None
    }

    /// Where the text caret is, for the body `area` the panel was last drawn
    /// in (absolute frame coordinates). `None`: no caret. The root reports it
    /// only for the panel that owns text input, only while the window has
    /// focus and no modal owns input, and only when the cell lies inside
    /// `area`: a caret scrolled out of view is not drawn at the edge.
    fn caret(&self, _area: Rect) -> Option<Caret> {
        None
    }

    /// Whether the panel reads the diagnostics feed: `diagnosticsSet` and
    /// `diagnosticsCleared` reach every mounted panel that says yes, whatever
    /// it is bound to, and the latest set per path is replayed to one that
    /// mounts late.
    fn wants_diagnostics(&self) -> bool {
        false
    }

    /// Whether the panel would act on this chord in its current state, for
    /// chords it handles itself outside the key table; the root asks before
    /// deciding whether a Mac Option chord is a command or a typed character.
    fn takes_chord(&self, _key: &KeyInput) -> bool {
        false
    }

    /// Whether typed characters belong to the panel (its text entry context
    /// then replaces its panel shortcuts).
    fn text_entry(&self) -> bool {
        false
    }

    /// Whether Escape means something to the panel now, so a drawer leaves it
    /// to the panel instead of closing. Text entry implies it. Unlike
    /// `text_entry` it changes nothing else: the panel keeps its own key
    /// context.
    fn holds_escape(&self) -> bool {
        self.text_entry()
    }

    /// The view is closing. Emit what the view's own lifetime rule needs (a
    /// terminal detaches, a document keeps its draft). `destroy` is true only
    /// when a `Destroy` action is running; without it the root refuses any
    /// effect that a `Destroy` action emits.
    fn teardown(&mut self, _cx: &mut Ctx, _destroy: bool) {}
}
