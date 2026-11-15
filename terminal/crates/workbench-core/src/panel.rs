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
use serde_json::Value;
use theorem_workbench_dock::CellMetrics;

use crate::completion::Completion;
use crate::effect::{Effect, EffectKind};
use crate::host::HostMessage;
use crate::ids::{ActionId, EffectId, EffectIds, PanelInstanceId, ResourceRef, WorkspaceIdentity};
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
        }
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
#[derive(Clone, Debug, PartialEq)]
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
    /// A registered action of the panel's kind with intent `Create`, `Start`
    /// or `Destroy`. The panel supplies the effect's payload.
    Action(ActionId),
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
    /// One frame. Work that was deferred from a silent message starts here.
    Tick,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EmitError {
    #[error("this message may not start work")]
    Silent,
    #[error("closing a view may not emit a {0:?} effect")]
    Forbidden(EffectKind),
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
    pub(crate) effects: Vec<Effect>,
    pub(crate) opens: Vec<OpenTarget>,
    pub(crate) close: bool,
    pub(crate) invalidated: bool,
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

    /// The workspace and environment now, read-only.
    pub fn workspace(&self) -> &WorkspaceIdentity {
        self.workspace
    }

    /// Emit an effect. `build` receives the id to put in its envelope. The
    /// effect is registered as in flight, and its completion comes back to
    /// this panel as [`PanelMsg::Completion`] or [`PanelMsg::Cached`].
    pub fn emit(&mut self, build: impl FnOnce(EffectId) -> Effect) -> Result<EffectId, EmitError> {
        if self.mode == Mode::Silent {
            return Err(EmitError::Silent);
        }
        let effect = build(self.ids.mint());
        if let Mode::Forbid(kinds) = &self.mode
            && kinds.contains(&effect.kind())
        {
            return Err(EmitError::Forbidden(effect.kind()));
        }
        self.in_flight
            .register(&effect)
            .map_err(EmitError::InFlightFull)?;
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
    /// Showing the "More tools" page.
    pub more: bool,
    /// Why the row last chosen could not be, until the selection moves.
    pub reason: Option<String>,
    /// The chord the active bindings give pinning and unpinning, for the
    /// selected row's hint. None: unbound.
    pub pin_shortcut: Option<String>,
}

/// One step of an input-method composition.
#[derive(Clone, Debug, PartialEq, Eq)]
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

    /// Whether the panel reads the diagnostics feed: `diagnosticsSet` and
    /// `diagnosticsCleared` reach every mounted panel that says yes, whatever
    /// it is bound to, and the latest set per path is replayed to one that
    /// mounts late.
    fn wants_diagnostics(&self) -> bool {
        false
    }

    /// Whether typed characters belong to the panel (its text entry context
    /// then replaces its panel shortcuts).
    fn text_entry(&self) -> bool {
        false
    }

    /// The view is closing. Emit what the view's own lifetime rule needs (a
    /// terminal detaches, a document keeps its draft). `destroy` is true only
    /// when a `Destroy` action is running; without it the root refuses any
    /// effect that a `Destroy` action emits.
    fn teardown(&mut self, _cx: &mut Ctx, _destroy: bool) {}
}
