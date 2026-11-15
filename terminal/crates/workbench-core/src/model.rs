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
use crate::ids::{
    ActionId, EffectId, EffectIds, PanelInstanceId, PanelKind, ResourceRef, WorkspaceIdentity,
};
use crate::keys::KeyTable;
use crate::panel::{Panel, PickerView};
use crate::panels::{PICKER_KIND, Unavailable};
use crate::picker::{Page, Picker};
use crate::queue::{QueueLimits, SourceQueues};
use crate::registry::{ActionIntent, Capabilities, Refusal, Registry, VersionCheck};
use crate::stale::{Binding, InFlight, Stale};

/// Effects that may be outstanding at once, across every panel.
pub const IN_FLIGHT_LIMIT: usize = 256;

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
}

/// Why the last operation did nothing. Read it with [`Model::take_notice`].
#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Refused(Refusal),
    Dock(DockError),
    /// A `Create`, `Start` or `Destroy` action named a kind with no open panel
    /// to supply its payload.
    NoPanel(ActionId),
}

/// Where keys and focus are now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Focus {
    pub group: GroupId,
    /// The active panel of the focused group.
    pub panel: Option<PanelInstanceId>,
    /// The picker is open and owns the keys.
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Drag {
    pub(crate) path: Vec<bool>,
    pub(crate) axis: Direction,
    pub(crate) grab: i32,
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
    pub(crate) queues: SourceQueues,
    /// The workspace and environment the host last named.
    pub(crate) workspace: WorkspaceIdentity,
    /// Effect kinds some `Destroy` action emits: a view closing may not.
    pub(crate) destroying: Vec<EffectKind>,

    pub(crate) viewport: Option<Viewport>,
    pub(crate) frame: Option<SolvedFrame>,
    pub(crate) window_focused: bool,
    pub(crate) announced_focus: Option<PanelInstanceId>,
    pub(crate) drag: Option<Drag>,
    /// The panel holding the pointer between a press in its body and the release.
    pub(crate) capture: Option<PanelInstanceId>,

    pub(crate) counters: Counters,
    pub(crate) notice: Option<Notice>,
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
            .filter_map(|a| a.emits)
            .collect();
        destroying.dedup();
        Self {
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
            queues: SourceQueues::new(QueueLimits::default()),
            workspace: WorkspaceIdentity::default(),
            destroying,
            viewport: None,
            frame: None,
            window_focused: true,
            announced_focus: None,
            drag: None,
            capture: None,
            counters: Counters::default(),
            notice: None,
            dirty: true,
        }
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

    pub fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    pub fn picker(&self) -> &Picker {
        &self.picker
    }

    /// Tools shown as their own picker rows.
    pub fn set_pinned(&mut self, pinned: std::collections::BTreeSet<PanelKind>) {
        self.pinned = pinned;
        self.dirty = true;
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
        self.counters
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
            modal: self.picker.is_open(),
            window: self.window_focused,
        }
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

    pub fn take_notice(&mut self) -> Option<Notice> {
        self.notice.take()
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

    pub(crate) fn picker_view(&self) -> Option<PickerView> {
        self.picker.is_open().then(|| PickerView {
            rows: self.picker.rows(&self.registry, &self.caps, &self.pinned),
            selected: self.picker.selected(),
            filter: self.picker.filter().to_owned(),
            more: self.picker.page() == Page::More,
        })
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
    fn unserved(&self, kind: &PanelKind, version: u32) -> Option<String> {
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
                    },
                );
            }
        }
        let has_picker = panels.values().any(|e| e.kind.as_str() == PICKER_KIND);

        self.dock = dock;
        self.panels = panels;
        self.in_flight = InFlight::new(IN_FLIGHT_LIMIT);
        self.origins.clear();
        self.drag = None;
        self.capture = None;
        self.announced_focus = None;
        self.picker = Picker::default();
        if has_picker {
            // A saved picker tab is the picker, open and empty. No effect:
            // opening the picker has none (R07).
            self.picker.update(
                crate::picker::PickerMsg::Open,
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
