//! The root's state: one dock, the panels it holds, and everything `update`
//! needs to route, judge and persist (ARCHITECTURE section 3, R33).

use std::collections::BTreeMap;

use ratatui::layout::{Direction, Rect};
use serde_json::{Value, json};
use theorem_workbench_dock::{
    CellMetrics, Dock, DockDocument, DockError, GroupId, PanelId, RestoreReport, Role as DockRole,
    SolvedFrame,
};

use crate::effect::EffectKind;
use crate::factory::PanelFactories;
use crate::host::HostMessage;
use crate::ids::{
    ActionId, EffectId, EffectIds, PanelInstanceId, PanelKind, ResourceRef, WorkspaceIdentity,
};
use crate::keys::KeyTable;
use crate::panel::{Panel, PickerView};
use crate::panels::{PICKER_KIND, Unavailable};
use crate::picker::Picker;
use crate::queue::{QueueLimits, SourceQueues};
use crate::registry::{ActionIntent, Capabilities, PickerSlot, Refusal, Registry, VersionCheck};
use crate::stale::{Binding, InFlight, Stale};

/// Effects that may be outstanding at once, across every panel.
pub const IN_FLIGHT_LIMIT: usize = 256;
/// How many notices wait to be taken.
pub const NOTICE_LIMIT: usize = 16;

pub const DOCUMENT_SCHEMA: &str = "theorem.workbench";
pub const DOCUMENT_VERSION: u32 = 1;

/// The grid the dock is solved for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub area: Rect,
    pub metrics: CellMetrics,
}

/// What `update` did with answers and events it did not hand to a panel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// Completions applied to the panel that asked.
    pub applied: u64,
    /// Completions kept only for a resource the panel is no longer bound to.
    pub cached: u64,
    /// Completions and host messages dropped as stale (AC-43).
    pub dropped: u64,
    pub last_drop: Option<Stale>,
    /// Effects a panel emitted that the in-flight bound refused.
    pub refused_full: u64,
    /// Retained host messages pushed out by their bounds, oldest first.
    pub evicted: u64,
    /// Notices pushed out of a full queue (told by `Notice::Overflow`).
    pub notices_dropped: u64,
}

/// Why the last operation did nothing. Read it with [`Model::take_notice`].
#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Refused(Refusal),
    Dock(DockError),
    /// A `Create`, `Start` or `Destroy` action named a kind with no open panel
    /// to supply its payload.
    NoPanel(ActionId),
    /// Too many effects were waiting for answers: this one was not sent. The
    /// ones already waiting are untouched.
    EffectsFull {
        limit: usize,
    },
    /// Notices were lost because none was taken in time.
    Overflow {
        dropped: u32,
    },
    /// What a saved arrangement did or could not do.
    Arrangement(crate::arrangement::ArrangementNotice),
}

/// Where keys and focus are now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Focus {
    pub group: GroupId,
    /// The active panel of the focused group.
    pub panel: Option<PanelInstanceId>,
    /// The picker is open and owns the keys (not while it only rests).
    pub modal: bool,
    /// The window has focus.
    pub window: bool,
}

pub(crate) struct Entry {
    pub(crate) panel: Box<dyn Panel>,
    pub(crate) kind: PanelKind,
    /// A real panel, not the placeholder.
    pub(crate) available: bool,
    /// The body last announced to the panel.
    pub(crate) body: Option<Rect>,
    /// The workspace generation last announced to the panel.
    pub(crate) workspace_seen: Option<u64>,
    /// The resource whose retained snapshot this panel was last handed (or
    /// found none for), so each binding is replayed once.
    pub(crate) replayed: Option<ResourceRef>,
}

/// How many conversations' latest snapshots the root keeps for panels that
/// mount later, and how many workspaces' session lists. The oldest goes first.
pub(crate) const RETAINED_SNAPSHOTS: usize = 32;
pub(crate) const RETAINED_SESSION_LISTS: usize = 4;
/// How many paths' latest diagnostics the root keeps.
pub(crate) const RETAINED_DIAGNOSTIC_PATHS: usize = 256;
/// How many documents' latest local state the root keeps.
pub(crate) const RETAINED_LOCALS: usize = 256;

/// The latest state a panel mounted later needs and would otherwise have
/// missed: one `ConversationSnapshot` per conversation resource and one
/// `TerminalSessions` per workspace, oldest first, both bounded.
#[derive(Default)]
pub(crate) struct Retained {
    pub(crate) snapshots: Vec<(ResourceRef, HostMessage)>,
    pub(crate) sessions: Vec<(String, HostMessage)>,
    /// The latest draft attachment list and model list of each conversation.
    pub(crate) attachments: Vec<(ResourceRef, HostMessage)>,
    pub(crate) models: Vec<(ResourceRef, HostMessage)>,
    /// The latest `DiagnosticsSet` per path, oldest first.
    pub(crate) diagnostics: Vec<(String, HostMessage)>,
    /// The latest `DocumentLocal` of each document.
    pub(crate) locals: Vec<(ResourceRef, HostMessage)>,
    /// How many held messages their bounds have pushed out, oldest first.
    pub(crate) evicted: u64,
}

impl Retained {
    /// Keep `message` as the latest for `resource`, unless the one held is
    /// newer (a late, older snapshot never replaces it).
    pub(crate) fn keep_snapshot(&mut self, resource: &ResourceRef, message: &HostMessage) {
        let incoming = match message {
            HostMessage::ConversationSnapshot { revision, .. } => revision,
            _ => return,
        };
        if let Some(at) = self.snapshots.iter().position(|(r, _)| r == resource) {
            let newer = matches!(
                &self.snapshots[at].1,
                HostMessage::ConversationSnapshot { revision, .. }
                    if revision.order(incoming) == Some(std::cmp::Ordering::Greater)
            );
            if newer {
                return;
            }
            self.snapshots.remove(at);
        }
        self.snapshots.push((resource.clone(), message.clone()));
        if self.snapshots.len() > RETAINED_SNAPSHOTS {
            self.evicted += 1;
            self.snapshots.remove(0);
        }
    }

    pub(crate) fn keep_sessions(&mut self, workspace: &str, message: &HostMessage) {
        self.sessions.retain(|(w, _)| w != workspace);
        self.sessions.push((workspace.to_owned(), message.clone()));
        if self.sessions.len() > RETAINED_SESSION_LISTS {
            self.evicted += 1;
            self.sessions.remove(0);
        }
    }

    /// Keep `message` (a `DiagnosticsSet`) as the latest for its path. False
    /// when the one held is newer or unordered against it: the set is stale.
    pub(crate) fn keep_diagnostics(&mut self, message: &HostMessage) -> bool {
        let HostMessage::DiagnosticsSet { path, revision, .. } = message else {
            return false;
        };
        if let Some(at) = self.diagnostics.iter().position(|(p, _)| p == path) {
            let older = matches!(
                &self.diagnostics[at].1,
                HostMessage::DiagnosticsSet { revision: held, .. }
                    if revision.order(held) == Some(std::cmp::Ordering::Less)
            );
            if older {
                return false;
            }
            self.diagnostics.remove(at);
        }
        self.diagnostics.push((path.clone(), message.clone()));
        if self.diagnostics.len() > RETAINED_DIAGNOSTIC_PATHS {
            self.evicted += 1;
            self.diagnostics.remove(0);
        }
        true
    }

    /// Keep the latest local state of a document, bounded.
    pub(crate) fn keep_local(&mut self, resource: &ResourceRef, message: &HostMessage) {
        self.locals.retain(|(r, _)| r != resource);
        self.locals.push((resource.clone(), message.clone()));
        if self.locals.len() > RETAINED_LOCALS {
            self.evicted += 1;
            self.locals.remove(0);
        }
    }

    pub(crate) fn forget_local(&mut self, resource: &ResourceRef) {
        self.locals.retain(|(r, _)| r != resource);
    }

    pub(crate) fn forget_diagnostics(&mut self, path: &str) {
        self.diagnostics.retain(|(p, _)| p != path);
    }

    /// Keep the latest draft attachment list for `resource`; each message is
    /// the whole list, so it replaces the one held.
    pub(crate) fn keep_attachments(&mut self, resource: &ResourceRef, message: &HostMessage) {
        self.evicted += u64::from(keep_latest(&mut self.attachments, resource, message));
    }

    /// Keep the latest model list for `resource`.
    pub(crate) fn keep_models(&mut self, resource: &ResourceRef, message: &HostMessage) {
        self.evicted += u64::from(keep_latest(&mut self.models, resource, message));
    }

    /// A conversation that was ended is forgotten.
    pub(crate) fn forget(&mut self, resource: &ResourceRef) {
        self.snapshots.retain(|(r, _)| r != resource);
        self.attachments.retain(|(r, _)| r != resource);
        self.models.retain(|(r, _)| r != resource);
    }
}

fn keep_latest(
    held: &mut Vec<(ResourceRef, HostMessage)>,
    resource: &ResourceRef,
    message: &HostMessage,
) -> bool {
    held.retain(|(r, _)| r != resource);
    held.push((resource.clone(), message.clone()));
    let full = held.len() > RETAINED_SNAPSHOTS;
    if full {
        held.remove(0);
    }
    full
}

impl Entry {
    pub(crate) fn binding(&self) -> Binding {
        self.panel.binding().unwrap_or(Binding {
            resource: ResourceRef::None,
            revision: None,
            generation: None,
        })
    }
}

/// A splitter being dragged. `grab` is how far inside the gutter the pointer
/// went down, so the gutter follows the pointer without jumping.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Drag {
    pub(crate) path: Vec<bool>,
    pub(crate) axis: Direction,
    pub(crate) grab: i32,
    /// The dock as it was when the drag began, for Esc to put back.
    pub(crate) start: Box<Dock>,
}

pub struct Model {
    pub(crate) registry: Registry,
    pub(crate) factories: PanelFactories,
    pub(crate) keys: KeyTable,
    pub(crate) caps: Capabilities,
    pub(crate) pinned: std::collections::BTreeSet<PanelKind>,

    pub(crate) dock: Dock,
    pub(crate) panels: BTreeMap<PanelInstanceId, Entry>,
    pub(crate) picker: Picker,

    pub(crate) ids: EffectIds,
    pub(crate) in_flight: InFlight,
    /// The panel that emitted each pending effect.
    pub(crate) origins: BTreeMap<EffectId, PanelInstanceId>,
    /// The panel that started each search whose pages are still arriving.
    pub(crate) searches: BTreeMap<String, PanelInstanceId>,
    pub(crate) retained: Retained,
    pub(crate) queues: SourceQueues,
    /// The workspace and environment the host last named.
    pub(crate) workspace: WorkspaceIdentity,
    /// Effect kinds some `Destroy` action emits: a view closing may not.
    pub(crate) destroying: Vec<EffectKind>,

    pub(crate) viewport: Option<Viewport>,
    pub(crate) frame: Option<SolvedFrame>,
    pub(crate) window_focused: bool,
    /// Reduced motion as the host last said, and what each panel was last told.
    pub(crate) reduced_motion: bool,
    pub(crate) motion_told: BTreeMap<PanelInstanceId, bool>,
    /// The panels that have been handed the retained diagnostics.
    pub(crate) diagnostics_told: std::collections::BTreeSet<PanelInstanceId>,
    pub(crate) announced_focus: Option<PanelInstanceId>,
    /// The last panel other than the picker that owned the keyboard: where
    /// focus goes back to when the picker closes.
    pub(crate) before_picker: Option<PanelInstanceId>,
    pub(crate) drag: Option<Drag>,
    /// The panel that had the keyboard when the drawer opened: where Esc
    /// returns it.
    pub(crate) before_drawer: Option<PanelInstanceId>,
    /// The account's saved arrangements, and the layout effects the root has
    /// out for them.
    pub(crate) arrangements: crate::arrangement::Arrangements,
    pub(crate) layout_pending: BTreeMap<EffectId, crate::arrangement::LayoutOp>,
    /// The panel holding the pointer between a press in its body and the release.
    pub(crate) capture: Option<PanelInstanceId>,

    pub(crate) counters: Counters,
    /// Notices not yet taken, oldest first, at most [`NOTICE_LIMIT`].
    pub(crate) notices: std::collections::VecDeque<Notice>,
    /// How many were pushed out of a full queue, told by a `Notice::Overflow`.
    pub(crate) notices_overflowed: u32,
    pub(crate) dirty: bool,
}

impl Model {
    /// A model over `dock`, which may already hold empty groups (a preset).
    /// The picker's panel is registered here; every other kind comes from
    /// `factories`.
    pub fn new(
        registry: Registry,
        mut factories: PanelFactories,
        keys: KeyTable,
        caps: Capabilities,
        dock: Dock,
    ) -> Self {
        factories.register(PICKER_KIND, |_, _| Box::new(crate::panels::PickerPanel));
        let mut destroying: Vec<EffectKind> = registry
            .panels()
            .iter()
            .flat_map(|p| &p.actions)
            .filter(|a| a.intent == ActionIntent::Destroy)
            .flat_map(|a| a.emits.iter().copied())
            .collect();
        destroying.dedup();
        let mut model = Self {
            registry,
            factories,
            keys,
            caps,
            pinned: Default::default(),
            dock,
            panels: BTreeMap::new(),
            picker: Picker::default(),
            ids: EffectIds::default(),
            in_flight: InFlight::new(IN_FLIGHT_LIMIT),
            origins: BTreeMap::new(),
            searches: BTreeMap::new(),
            retained: Retained::default(),
            queues: SourceQueues::new(QueueLimits::default()),
            workspace: WorkspaceIdentity::default(),
            destroying,
            viewport: None,
            frame: None,
            window_focused: true,
            reduced_motion: false,
            motion_told: BTreeMap::new(),
            diagnostics_told: std::collections::BTreeSet::new(),
            announced_focus: None,
            before_picker: None,
            drag: None,
            before_drawer: None,
            arrangements: Default::default(),
            layout_pending: BTreeMap::new(),
            capture: None,
            counters: Counters::default(),
            notices: std::collections::VecDeque::new(),
            notices_overflowed: 0,
            dirty: true,
        };
        model.sync_shortcuts();
        model
    }

    pub fn dock(&self) -> &Dock {
        &self.dock
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub fn keys(&self) -> &KeyTable {
        &self.keys
    }

    /// The title and modified mark a panel's tab shows: what it names itself
    /// with, else `registered`, the title the dock holds for it.
    pub fn tab_label(&self, panel: &PanelInstanceId, registered: &str) -> crate::panel::TabLabel {
        self.panels
            .get(panel)
            .and_then(|e| e.panel.tab_label())
            .unwrap_or_else(|| crate::panel::TabLabel {
                title: registered.to_owned(),
                modified: false,
            })
    }

    pub fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    pub fn picker(&self) -> &Picker {
        &self.picker
    }

    /// Tools shown as their own picker rows.
    pub fn set_pinned(&mut self, pinned: std::collections::BTreeSet<PanelKind>) {
        self.pinned = pinned;
        self.picker.clamp(&self.registry, &self.caps, &self.pinned);
        self.dirty = true;
    }

    /// The pinned tools. They are part of the layout document: they survive a
    /// restore.
    pub fn pinned(&self) -> &std::collections::BTreeSet<PanelKind> {
        &self.pinned
    }

    /// Replace the key bindings (the person changed them). The picker's hints
    /// follow.
    pub fn set_keys(&mut self, keys: KeyTable) {
        self.keys = keys;
        self.sync_shortcuts();
        self.dirty = true;
    }

    /// Hand the picker the chord each of its actions has now.
    pub(crate) fn sync_shortcuts(&mut self) {
        let labels = self
            .registry
            .actions()
            .filter(|(_, a)| a.picker.is_some())
            .filter_map(|(_, a)| Some((a.id.clone(), self.keys.label(&a.id)?)))
            .collect();
        self.picker.set_shortcuts(labels);
        self.picker.set_pin_shortcut(
            self.keys
                .label(&ActionId::new(crate::panels::ACTION_TOGGLE_PIN)),
        );
    }

    /// Pin or unpin a tool. Only a More tools entry can be pinned. Returns
    /// whether the pins changed.
    pub(crate) fn set_pin(&mut self, panel: &PanelKind, pinned: bool) -> bool {
        let pinnable = self
            .registry
            .get(panel)
            .is_some_and(|p| p.actions.iter().any(|a| a.picker == Some(PickerSlot::More)));
        if !pinnable {
            return false;
        }
        let changed = if pinned {
            self.pinned.insert(panel.clone())
        } else {
            self.pinned.remove(panel)
        };
        if changed {
            self.picker.clamp(&self.registry, &self.caps, &self.pinned);
            self.dirty = true;
        }
        changed
    }

    /// The workspace and environment the host last named (empty until it does).
    pub fn workspace(&self) -> &WorkspaceIdentity {
        &self.workspace
    }

    pub fn in_flight(&self) -> &InFlight {
        &self.in_flight
    }

    pub fn queues(&self) -> &SourceQueues {
        &self.queues
    }

    pub fn counters(&self) -> Counters {
        Counters {
            evicted: self.retained.evicted,
            ..self.counters
        }
    }

    /// The dock as last solved, for hit testing and drawing.
    pub fn frame(&self) -> Option<&SolvedFrame> {
        self.frame.as_ref()
    }

    pub fn viewport(&self) -> Option<Viewport> {
        self.viewport
    }

    pub fn focus(&self) -> Focus {
        Focus {
            group: self.dock.focused(),
            panel: self.focus_owner(),
            modal: self.picker.holds_keys(),
            window: self.window_focused,
        }
    }

    /// The text caret of the panel that owns text input, as of the last
    /// solved frame. `None` while the window is unfocused, while an open
    /// picker owns input (a resting one does not), when the focused panel
    /// reports none, and when its cell lies outside the panel's visible body.
    /// A blinking caret is steady while the person asked for reduced motion.
    pub fn caret(&self) -> Option<crate::panel::Caret> {
        use crate::panel::CaretPhase;
        if !self.window_focused || self.picker.holds_keys() {
            return None;
        }
        let owner = self.focus_owner()?;
        let entry = self.panels.get(&owner)?;
        if !entry.available {
            return None;
        }
        let frame = self.frame.as_ref()?;
        let focused = self.dock.focused();
        let group = frame.groups.iter().find(|g| g.id == focused)?;
        let body = group.body.intersection(frame.area);
        let mut caret = entry.panel.caret(group.body)?;
        let inside = caret.x >= body.x
            && caret.x < body.x.saturating_add(body.width)
            && caret.y >= body.y
            && caret.y < body.y.saturating_add(body.height);
        if !inside {
            return None;
        }
        if caret.phase == CaretPhase::Blinking && self.reduced_motion {
            caret.phase = CaretPhase::Steady;
        }
        Some(caret)
    }

    pub fn panel(&self, id: &PanelInstanceId) -> Option<&dyn Panel> {
        self.panels.get(id).map(|e| e.panel.as_ref())
    }

    /// Open panels in id order, with their kind.
    pub fn panel_ids(&self) -> impl Iterator<Item = (&PanelInstanceId, &PanelKind)> {
        self.panels.iter().map(|(id, e)| (id, &e.kind))
    }

    /// Whether the panel is the placeholder for a kind this build cannot serve.
    pub fn is_unavailable(&self, id: &PanelInstanceId) -> bool {
        self.panels.get(id).is_some_and(|e| !e.available)
    }

    /// The oldest notice not yet taken. When the queue overflowed, a
    /// `Notice::Overflow` comes first and says how many were lost.
    pub fn take_notice(&mut self) -> Option<Notice> {
        if self.notices_overflowed > 0 {
            let dropped = std::mem::take(&mut self.notices_overflowed);
            return Some(Notice::Overflow { dropped });
        }
        self.notices.pop_front()
    }

    /// Queue a notice. A full queue pushes its oldest out and counts it, so
    /// the loss is told and never silent.
    pub(crate) fn notify(&mut self, notice: Notice) {
        if self.notices.len() >= NOTICE_LIMIT {
            self.notices.pop_front();
            self.notices_overflowed = self.notices_overflowed.saturating_add(1);
            self.counters.notices_dropped += 1;
        }
        self.notices.push_back(notice);
        self.dirty = true;
    }

    /// Whether a redraw is owed, clearing the flag. The host calls this once
    /// per animation frame, so any number of messages cost one redraw.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    pub(crate) fn focus_owner(&self) -> Option<PanelInstanceId> {
        let group = self.dock.group(self.dock.focused())?;
        let tab = group.active()?;
        Some(PanelInstanceId::new(tab.panel.0.clone()))
    }

    /// Show the picker in the tool destination without taking the keyboard:
    /// the default composition's starting state. Opening it has no effect.
    pub fn rest_picker(&mut self) {
        let _ = self.picker_msg(crate::picker::PickerMsg::Rest);
        self.settle();
        self.dirty = true;
    }

    /// As [`rest_picker`](Self::rest_picker), saying whether the picker is
    /// now resting.
    pub fn rest_picker_now(&mut self) -> bool {
        self.rest_picker();
        self.picker.is_resting()
    }

    pub(crate) fn picker_view(&self) -> Option<PickerView> {
        self.picker
            .is_open()
            .then(|| self.picker.view(&self.registry, &self.caps, &self.pinned))
    }

    pub(crate) fn mint_panel(&mut self) -> PanelInstanceId {
        let mut n = self.panels.len() as u64;
        loop {
            n += 1;
            let id = PanelInstanceId::new(format!("p{n}"));
            if !self.panels.contains_key(&id) {
                return id;
            }
        }
    }

    /// The panel for `kind` saved at `version` with `state`, or the placeholder
    /// that says why this build cannot serve it.
    pub(crate) fn build_panel(
        &self,
        kind: &PanelKind,
        version: u32,
        state: &Value,
    ) -> (Box<dyn Panel>, bool) {
        match self.unserved(kind, version) {
            None => match self.factories.create(kind, state, version) {
                Some(panel) => (panel, true),
                None => unreachable!("unserved() checks for a constructor"),
            },
            Some(reason) => (
                Box::new(Unavailable::new(kind.as_str(), reason, state.clone())),
                false,
            ),
        }
    }

    /// Why this build cannot serve `kind` at `version`, or `None` when it can.
    pub(crate) fn unserved(&self, kind: &PanelKind, version: u32) -> Option<String> {
        match self.registry.check_version(kind, version) {
            VersionCheck::UnknownKind => {
                Some(format!("This build has no panel \"{}\".", kind.as_str()))
            }
            VersionCheck::Newer => Some(format!(
                "Saved by a newer version ({version}) of \"{}\".",
                kind.as_str()
            )),
            VersionCheck::Current | VersionCheck::Older if !self.factories.has(kind) => Some(
                format!("No constructor is registered for \"{}\".", kind.as_str()),
            ),
            VersionCheck::Current | VersionCheck::Older => None,
        }
    }

    // --- persistence ---

    /// The layout document: the dock's, with each panel's view state in its tab
    /// and each available panel's kind at the version this build serves.
    pub fn document(&self) -> Value {
        let mut dock = self.dock.document();
        for group in dock.groups.values_mut() {
            for tab in &mut group.tabs {
                let Some(entry) = self.panels.get(&PanelInstanceId::new(tab.panel.0.clone()))
                else {
                    continue;
                };
                tab.view_state = entry.panel.serialize();
                if entry.available
                    && let Some(d) = self.registry.get(&entry.kind)
                {
                    tab.kind.version = d.version;
                }
            }
        }
        json!({
            "schema": DOCUMENT_SCHEMA,
            "version": DOCUMENT_VERSION,
            "dock": serde_json::to_value(dock).expect("a dock document is plain data"),
            "pinned": self.pinned.iter().map(PanelKind::as_str).collect::<Vec<_>>(),
        })
    }

    /// Replace the dock and every panel with those in `value`. It emits no
    /// effect and sends no panel an effect-capable message: panels are built
    /// from their saved view state only. A kind this build cannot serve stays
    /// in its tab as a placeholder holding its saved state (R48, AC-45).
    pub fn restore(&mut self, value: Value) -> Result<RestoreReport, RestoreError> {
        let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
        if schema != DOCUMENT_SCHEMA {
            return Err(RestoreError::UnknownSchema(schema.to_owned()));
        }
        let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version != u64::from(DOCUMENT_VERSION) {
            return Err(RestoreError::UnsupportedVersion {
                found: version,
                supported: DOCUMENT_VERSION,
            });
        }
        let mut doc: DockDocument =
            serde_json::from_value(value.get("dock").cloned().unwrap_or_default())
                .map_err(RestoreError::Malformed)?;
        // A panel owns its view state; the live dock holds layout only.
        let mut states: BTreeMap<PanelId, Value> = BTreeMap::new();
        for tab in doc.groups.values_mut().flat_map(|g| &mut g.tabs) {
            states.insert(tab.panel.clone(), std::mem::take(&mut tab.view_state));
        }
        let serves = |kind: &theorem_workbench_dock::PanelKind| {
            let k = PanelKind::new(kind.name.as_str());
            self.unserved(&k, kind.version).is_none()
        };
        let (dock, report) = Dock::restore(doc, *self.dock.config(), serves)?;

        let mut panels = BTreeMap::new();
        for group in dock.group_ids() {
            let Some(group) = dock.group(group) else {
                continue;
            };
            for tab in group.tabs() {
                let kind = PanelKind::new(tab.kind.name.as_str());
                let state = states.get(&tab.panel).unwrap_or(&Value::Null);
                let (panel, available) = self.build_panel(&kind, tab.kind.version, state);
                panels.insert(
                    PanelInstanceId::new(tab.panel.0.clone()),
                    Entry {
                        panel,
                        kind,
                        available,
                        body: None,
                        workspace_seen: None,
                        replayed: None,
                    },
                );
            }
        }
        let has_picker = panels.values().any(|e| e.kind.as_str() == PICKER_KIND);

        // Pins ride in the document. One saved before pins existed has none
        // and leaves the pins as they are.
        if let Some(saved) = value.get("pinned").and_then(Value::as_array) {
            self.pinned = saved
                .iter()
                .filter_map(Value::as_str)
                .map(PanelKind::new)
                .filter(|k| {
                    self.registry.get(k).is_some_and(|p| {
                        p.actions.iter().any(|a| a.picker == Some(PickerSlot::More))
                    })
                })
                .collect();
        }

        self.dock = dock;
        self.panels = panels;
        self.in_flight = InFlight::new(IN_FLIGHT_LIMIT);
        self.origins.clear();
        self.searches.clear();
        self.drag = None;
        self.capture = None;
        self.announced_focus = None;
        self.picker = Picker::default();
        self.sync_shortcuts();
        if has_picker {
            // A saved picker tab is the picker, open and empty. No effect:
            // opening the picker has none (R07).
            self.picker.update(
                crate::picker::PickerMsg::Rest,
                &self.registry,
                &self.caps,
                &self.pinned,
            );
        }
        self.settle();
        self.dirty = true;
        Ok(report)
    }

    pub(crate) fn dock_id(id: &PanelInstanceId) -> PanelId {
        PanelId(id.as_str().to_owned())
    }

    /// The group of `role` to open into: a visible one first, else any, else
    /// none (its last tab was closed and the group went with it).
    pub(crate) fn group_of_role(&self, role: DockRole) -> Option<GroupId> {
        let of_role = |hidden: bool| {
            self.dock.group_ids().into_iter().find(|id| {
                self.dock
                    .group(*id)
                    .is_some_and(|g| g.role() == role && g.is_hidden() == hidden)
            })
        };
        of_role(false).or_else(|| of_role(true))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error("unknown schema {0:?}")]
    UnknownSchema(String),
    #[error("workbench document version {found} is not supported (this build reads {supported})")]
    UnsupportedVersion { found: u64, supported: u32 },
    #[error("the dock document is malformed: {0}")]
    Malformed(serde_json::Error),
    #[error(transparent)]
    Dock(#[from] theorem_workbench_dock::RestoreError),
}
