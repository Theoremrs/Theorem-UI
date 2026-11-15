//! The panel registry (ARCHITECTURE section 6, R05). The picker, command
//! palette, shortcuts, context actions and the agent's `workbench.act` all
//! resolve the same descriptors; nothing keeps a second list.
//!
//! Descriptors are data. A panel's state serializer and factory live with the
//! panel (`workbench-panels`); the descriptor's `version` is what lets a saved
//! layout fail safely when it names a panel version nobody serves (R48).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::effect::EffectKind;
use crate::ids::{
    ActionId, Actor, Capability, PanelInstanceId, PanelKind, ResourceKind, ResourceRef,
};
use crate::keys::{KeyContext, Shortcut};
use crate::semantics::Role;

/// What the host reports it can do. Gates panels and actions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub granted: BTreeSet<Capability>,
}

impl Capabilities {
    pub fn of<I: IntoIterator<Item = &'static str>>(names: I) -> Self {
        Self {
            granted: names.into_iter().map(Capability::new).collect(),
        }
    }

    pub fn has(&self, capability: &Capability) -> bool {
        self.granted.contains(capability)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Availability {
    Available,
    /// With the reason a person can act on. Unavailable rows stay listed.
    Unavailable {
        reason: String,
    },
}

impl Availability {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }
}

fn availability_of(requires: &[Capability], caps: &Capabilities) -> Availability {
    match requires.iter().find(|c| !caps.has(c)) {
        None => Availability::Available,
        Some(missing) => Availability::Unavailable {
            reason: format!(
                "This host does not report the \"{}\" capability.",
                missing.as_str()
            ),
        },
    }
}

/// How an action relates to the world. Only `Create`, `Start` and `Destroy`
/// may emit a domain effect, and only when the entry is chosen (R07).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ActionIntent {
    /// Bring an existing view forward.
    Focus,
    /// Open something that already exists, or a chooser for one.
    Open,
    Create,
    Start,
    Destroy,
    /// Handled by the panel itself and emits no effect: the panel's own undo,
    /// find, retry and the like. Reached by the palette, a chord or an agent
    /// like any other action; the root delivers it to the focused panel of the
    /// action's kind as `PanelMsg::Action(id)`, or refuses when none is.
    Local,
}

impl ActionIntent {
    pub fn may_emit_effect(self) -> bool {
        matches!(self, Self::Create | Self::Start | Self::Destroy)
    }
}

/// Where a default shortcut applies, before the panel kind is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum KeyScope {
    Global,
    /// Only while this action's panel has focus.
    Panel,
    TextEntry,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DefaultKey {
    /// `Mod+Shift+G` and the like; `Mod` is Cmd on Mac, Ctrl elsewhere.
    pub chord: String,
    pub scope: KeyScope,
}

/// Where an action appears in the tool picker.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PickerSlot {
    /// A main row; rows sort by `order`.
    Row { order: u8 },
    /// Under More tools.
    More,
}

/// What choosing an action in the tool picker does to the workbench, said by
/// the registration (not guessed from the title). The picker shows a short
/// muted qualifier only for `Creates` and `Starts`, where a person would
/// otherwise not know that choosing does more than show something.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Chooses {
    /// Brings an existing view forward.
    Focuses,
    /// Opens something that already exists, or a chooser for one.
    Opens,
    /// Makes a new thing: `what` is its noun ("document").
    Creates { what: String },
    /// Starts a process: `what` is its noun ("process").
    Starts { what: String },
}

impl Chooses {
    /// What the picker shows beside the label, if anything.
    pub fn qualifier(&self) -> Option<String> {
        match self {
            Self::Focuses | Self::Opens => None,
            Self::Creates { what } => Some(format!("creates a {what}")),
            Self::Starts { what } => Some(format!("starts a {what}")),
        }
    }
}

impl From<ActionIntent> for Chooses {
    /// What an intent means when the registration says nothing more.
    fn from(intent: ActionIntent) -> Self {
        match intent {
            ActionIntent::Focus => Self::Focuses,
            ActionIntent::Open | ActionIntent::Local => Self::Opens,
            ActionIntent::Create => Self::Creates {
                what: "thing".to_owned(),
            },
            ActionIntent::Start | ActionIntent::Destroy => Self::Starts {
                what: "process".to_owned(),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ActionDescriptor {
    pub id: ActionId,
    pub title: String,
    pub intent: ActionIntent,
    #[serde(default)]
    pub requires: Vec<Capability>,
    /// The effects choosing this action may produce (the panel picks one when
    /// it handles the action). Non-empty exactly when the intent may emit one;
    /// empty for `Focus`, `Open` and `Local`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emits: Vec<EffectKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub default_key: Option<DefaultKey>,
    /// Approvals and the like: a model-origin request is refused, whatever id
    /// it names (R34).
    #[serde(default)]
    pub human_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub picker: Option<PickerSlot>,
    /// What choosing it in the picker does, when that is more than its intent
    /// says. Absent: the intent's own meaning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub choosing: Option<Chooses>,
    /// A leading mark for the picker row: one or two cells wide (measured with
    /// unicode-width), a plain BMP symbol the terminal's font covers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub glyph: Option<String>,
}

impl ActionDescriptor {
    pub fn new(id: &str, title: &str, intent: ActionIntent) -> Self {
        Self {
            id: ActionId::new(id),
            title: title.to_owned(),
            intent,
            requires: vec![],
            emits: vec![],
            default_key: None,
            human_only: false,
            picker: None,
            choosing: None,
            glyph: None,
        }
    }

    /// The mark the picker draws before the label.
    pub fn glyph(mut self, glyph: &str) -> Self {
        self.glyph = Some(glyph.to_owned());
        self
    }

    /// Choosing this in the picker makes a new `what`.
    pub fn creates(mut self, what: &str) -> Self {
        self.choosing = Some(Chooses::Creates {
            what: what.to_owned(),
        });
        self
    }

    /// Choosing this in the picker starts a `what`.
    pub fn starts(mut self, what: &str) -> Self {
        self.choosing = Some(Chooses::Starts {
            what: what.to_owned(),
        });
        self
    }

    /// What choosing it in the picker does: the registration's word, else the
    /// intent's meaning.
    pub fn chooses(&self) -> Chooses {
        self.choosing
            .clone()
            .unwrap_or_else(|| Chooses::from(self.intent))
    }

    pub fn requires(mut self, capability: &str) -> Self {
        self.requires.push(Capability::new(capability));
        self
    }

    /// Adds an effect this action may emit; call again for each more.
    pub fn emits(mut self, kind: EffectKind) -> Self {
        if !self.emits.contains(&kind) {
            self.emits.push(kind);
        }
        self
    }

    /// Marks the action as handled by its panel with no effect
    /// (`ActionIntent::Local`). Equivalent to registering with that intent.
    pub fn local(id: &str, title: &str) -> Self {
        Self::new(id, title, ActionIntent::Local)
    }

    pub fn key(mut self, chord: &str, scope: KeyScope) -> Self {
        self.default_key = Some(DefaultKey {
            chord: chord.to_owned(),
            scope,
        });
        self
    }

    pub fn human_only(mut self) -> Self {
        self.human_only = true;
        self
    }

    pub fn row(mut self, order: u8) -> Self {
        self.picker = Some(PickerSlot::Row { order });
        self
    }

    pub fn more(mut self) -> Self {
        self.picker = Some(PickerSlot::More);
        self
    }
}

/// Ratatui cells, or a DOM region placed on Rust-reported geometry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum BodyKind {
    Drawn,
    Hosted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    Left,
    Main,
    Tools,
}

/// A size in terminal cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CellSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PanelDescriptor {
    pub kind: PanelKind,
    /// Bumped when the panel's saved view state changes shape.
    pub version: u32,
    pub title: String,
    pub icon: String,
    pub body: BodyKind,
    pub binding: ResourceKind,
    pub actions: Vec<ActionDescriptor>,
    #[serde(default)]
    pub requires: Vec<Capability>,
    pub min_size: CellSize,
    pub default_placement: Placement,
    /// Terminal roles the panel paints with (`chrome.bg`, `diff.addedLine`).
    pub theme_roles: Vec<String>,
    pub semantic_role: Role,
}

/// A registered panel kind declared as one way to show a kind of resource
/// (R48, AC-59). It is data: the kind it names was registered the ordinary way
/// (descriptor, version, capabilities, factory), and what the declaration adds
/// is which resources the kind can show. Nothing here names code or a location
/// to load it from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub kind: PanelKind,
    /// The kind of resource it shows; the panel's own `binding`.
    pub shows: ResourceKind,
    /// For documents: the file extensions it shows, lowercase without the dot.
    /// Empty means every resource of the kind.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// The presentation a resource opens in, listed first.
    #[serde(default)]
    pub default: bool,
}

impl Presentation {
    pub fn new(kind: &str, shows: ResourceKind) -> Self {
        Self {
            kind: PanelKind::new(kind),
            shows,
            extensions: Vec::new(),
            default: false,
        }
    }

    /// Show only documents with one of these extensions.
    pub fn extensions<'a>(mut self, extensions: impl IntoIterator<Item = &'a str>) -> Self {
        self.extensions = extensions.into_iter().map(str::to_owned).collect();
        self
    }

    /// The presentation resources open in.
    pub fn default_presentation(mut self) -> Self {
        self.default = true;
        self
    }

    fn matches(&self, resource: &ResourceRef) -> bool {
        if resource.kind() != self.shows {
            return false;
        }
        if self.extensions.is_empty() {
            return true;
        }
        let ResourceRef::Document { resource_id, .. } = resource else {
            return false;
        };
        let name = resource_id.rsplit('/').next().unwrap_or(resource_id);
        name.rsplit_once('.')
            .is_some_and(|(_, ext)| self.extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)))
    }
}

/// One way to show a resource, as the registry lists it for the host's
/// capabilities. An unavailable one stays listed with the reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PresentationEntry {
    pub kind: PanelKind,
    /// The descriptor version this build serves it at.
    pub version: u32,
    pub title: String,
    pub default: bool,
    pub availability: Availability,
    /// The panel asked about shows the resource this way now.
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryError {
    DuplicateKind(PanelKind),
    DuplicateAction(ActionId),
    /// A `Focus` or `Open` action names an effect.
    EffectOnPassiveAction(ActionId),
    /// A `Create`, `Start` or `Destroy` action names none.
    ActiveActionWithoutEffect(ActionId),
    ZeroSize(PanelKind),
    ZeroVersion(PanelKind),
    /// `extend_actions` or `declare_presentation` named a kind nobody
    /// registered.
    UnknownKind(PanelKind),
    /// The kind is already declared as a presentation.
    DuplicatePresentation(PanelKind),
    /// A presentation shows a different kind of resource than its panel is
    /// bound to.
    PresentationBindingMismatch(PanelKind),
    /// A declared extension is empty, has a dot or is not lowercase.
    BadExtension {
        kind: PanelKind,
        extension: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VersionCheck {
    Current,
    /// Saved by an older panel version: restore through its migration.
    Older,
    /// Saved by a newer one than this build serves: keep the binding, show the
    /// panel as unavailable, do not guess.
    Newer,
    UnknownKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    UnknownAction(ActionId),
    Unavailable {
        reason: String,
    },
    /// An agent asked for a human-only action. The actor is kept so the
    /// refusal can say who asked.
    HumanOnly {
        action: ActionId,
        actor: Actor,
    },
    /// An action was aimed at a panel that is not open.
    UnknownPanel(PanelInstanceId),
}

/// An action resolved against the registry and the host's capabilities.
#[derive(Clone, Copy, Debug)]
pub struct Resolved<'a> {
    pub panel: &'a PanelDescriptor,
    pub action: &'a ActionDescriptor,
}

impl Resolved<'_> {
    pub fn emits(&self) -> &[EffectKind] {
        &self.action.emits
    }
}

/// One row of the tool picker or of More tools.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PickerRow {
    pub action: ActionId,
    pub panel: PanelKind,
    pub title: String,
    pub intent: ActionIntent,
    pub availability: Availability,
    pub pinned: bool,
    /// What choosing the row does; the picker draws a qualifier from it.
    pub chooses: Chooses,
    /// Can be pinned to the main rows or unpinned (the More tools entries).
    #[serde(default)]
    pub pinnable: bool,
    /// The chord the active key bindings give the action, as people read it.
    /// None: no binding, and the row shows no hint. The registry does not know
    /// the bindings; the picker fills this in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub shortcut: Option<String>,
    /// The action's leading mark, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub glyph: Option<String>,
}

/// One action as the agent sees it (`workbench.act`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub action: ActionId,
    pub panel: PanelKind,
    pub title: String,
    pub intent: ActionIntent,
    pub availability: Availability,
    /// A person's to do. Listed so the agent can see the action exists; the
    /// model refuses it when asked for an agent.
    #[serde(default)]
    pub human_only: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Registry {
    panels: Vec<PanelDescriptor>,
    presentations: Vec<Presentation>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, panel: PanelDescriptor) -> Result<(), RegistryError> {
        if self.get(&panel.kind).is_some() {
            return Err(RegistryError::DuplicateKind(panel.kind));
        }
        if panel.version == 0 {
            return Err(RegistryError::ZeroVersion(panel.kind));
        }
        if panel.min_size.cols == 0 || panel.min_size.rows == 0 {
            return Err(RegistryError::ZeroSize(panel.kind));
        }
        self.check_actions(&panel.actions)?;
        self.panels.push(panel);
        Ok(())
    }

    /// Adds actions to a panel kind already registered, after the checks
    /// `register` makes: no id may repeat among the new actions or any action
    /// already registered, and an action names an effect exactly when its
    /// intent may emit one. Nothing is added when any action fails.
    pub fn extend_actions(
        &mut self,
        kind: &PanelKind,
        actions: impl IntoIterator<Item = ActionDescriptor>,
    ) -> Result<(), RegistryError> {
        let actions: Vec<ActionDescriptor> = actions.into_iter().collect();
        if self.get(kind).is_none() {
            return Err(RegistryError::UnknownKind(kind.clone()));
        }
        self.check_actions(&actions)?;
        if let Some(panel) = self.panels.iter_mut().find(|p| &p.kind == kind) {
            panel.actions.extend(actions);
        }
        Ok(())
    }

    /// Declare a registered kind as a presentation of a kind of resource.
    /// Nothing is added when the kind is unknown, already declared, bound to
    /// another kind of resource, or names a malformed extension.
    pub fn declare_presentation(&mut self, p: Presentation) -> Result<(), RegistryError> {
        let Some(panel) = self.get(&p.kind) else {
            return Err(RegistryError::UnknownKind(p.kind));
        };
        if panel.binding != p.shows {
            return Err(RegistryError::PresentationBindingMismatch(p.kind));
        }
        if self.presentations.iter().any(|q| q.kind == p.kind) {
            return Err(RegistryError::DuplicatePresentation(p.kind));
        }
        if let Some(bad) = p
            .extensions
            .iter()
            .find(|e| e.is_empty() || e.contains('.') || **e != e.to_lowercase())
        {
            return Err(RegistryError::BadExtension {
                kind: p.kind,
                extension: bad.clone(),
            });
        }
        self.presentations.push(p);
        Ok(())
    }

    pub fn presentations(&self) -> &[Presentation] {
        &self.presentations
    }

    /// The presentations that can show `resource`: the default first, then in
    /// the order they were declared. One whose capabilities the host has not
    /// granted is listed unavailable, with the reason.
    pub fn presentations_for(
        &self,
        resource: &ResourceRef,
        caps: &Capabilities,
    ) -> Vec<PresentationEntry> {
        let mut entries: Vec<PresentationEntry> = self
            .presentations
            .iter()
            .filter(|p| p.matches(resource))
            .filter_map(|p| {
                let panel = self.get(&p.kind)?;
                Some(PresentationEntry {
                    kind: p.kind.clone(),
                    version: panel.version,
                    title: panel.title.clone(),
                    default: p.default,
                    availability: availability_of(&panel.requires, caps),
                    current: false,
                })
            })
            .collect();
        entries.sort_by_key(|e| !e.default);
        entries
    }

    fn check_actions(&self, actions: &[ActionDescriptor]) -> Result<(), RegistryError> {
        let mut seen = BTreeSet::new();
        for action in actions {
            if self.action(&action.id).is_some() || !seen.insert(&action.id) {
                return Err(RegistryError::DuplicateAction(action.id.clone()));
            }
            match (action.intent.may_emit_effect(), action.emits.is_empty()) {
                (false, false) => {
                    return Err(RegistryError::EffectOnPassiveAction(action.id.clone()));
                }
                (true, true) => {
                    return Err(RegistryError::ActiveActionWithoutEffect(action.id.clone()));
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn get(&self, kind: &PanelKind) -> Option<&PanelDescriptor> {
        self.panels.iter().find(|p| &p.kind == kind)
    }

    pub fn panels(&self) -> &[PanelDescriptor] {
        &self.panels
    }

    pub fn action(&self, id: &ActionId) -> Option<(&PanelDescriptor, &ActionDescriptor)> {
        self.panels
            .iter()
            .find_map(|p| p.actions.iter().find(|a| &a.id == id).map(|a| (p, a)))
    }

    pub(crate) fn actions(&self) -> impl Iterator<Item = (&PanelDescriptor, &ActionDescriptor)> {
        self.panels
            .iter()
            .flat_map(|p| p.actions.iter().map(move |a| (p, a)))
    }

    pub fn panel_availability(
        &self,
        kind: &PanelKind,
        caps: &Capabilities,
    ) -> Option<Availability> {
        self.get(kind).map(|p| availability_of(&p.requires, caps))
    }

    /// An action is available when its panel is and its own capabilities are.
    pub fn action_availability(
        &self,
        panel: &PanelDescriptor,
        action: &ActionDescriptor,
        caps: &Capabilities,
    ) -> Availability {
        match availability_of(&panel.requires, caps) {
            Availability::Available => availability_of(&action.requires, caps),
            unavailable => unavailable,
        }
    }

    /// Resolve an action id for an actor. Every entry point (a picker row, the
    /// palette, a shortcut, the agent) goes through here.
    pub fn resolve(
        &self,
        id: &ActionId,
        actor: &Actor,
        caps: &Capabilities,
    ) -> Result<Resolved<'_>, Refusal> {
        let (panel, action) = self
            .action(id)
            .ok_or_else(|| Refusal::UnknownAction(id.clone()))?;
        if action.human_only && matches!(actor, Actor::Agent { .. }) {
            return Err(Refusal::HumanOnly {
                action: id.clone(),
                actor: actor.clone(),
            });
        }
        match self.action_availability(panel, action, caps) {
            Availability::Available => Ok(Resolved { panel, action }),
            Availability::Unavailable { reason } => Err(Refusal::Unavailable { reason }),
        }
    }

    fn row(
        &self,
        panel: &PanelDescriptor,
        action: &ActionDescriptor,
        caps: &Capabilities,
        pinned: bool,
    ) -> PickerRow {
        PickerRow {
            action: action.id.clone(),
            panel: panel.kind.clone(),
            title: action.title.clone(),
            intent: action.intent,
            availability: self.action_availability(panel, action, caps),
            pinned,
            chooses: action.chooses(),
            pinnable: action.picker == Some(PickerSlot::More),
            shortcut: None,
            glyph: action.glyph.clone(),
        }
    }

    /// The picker's rows: the main rows in order, with the user's pinned tools
    /// after the initial rows and before the row that leads to More tools.
    /// Unavailable rows stay, with their reason.
    pub fn picker_rows(&self, caps: &Capabilities, pinned: &BTreeSet<PanelKind>) -> Vec<PickerRow> {
        let mut main: Vec<(u8, PickerRow)> = self
            .actions()
            .filter_map(|(p, a)| match a.picker {
                Some(PickerSlot::Row { order }) => Some((order, self.row(p, a, caps, false))),
                _ => None,
            })
            .collect();
        main.sort_by_key(|(order, _)| *order);
        let mut rows: Vec<PickerRow> = main.into_iter().map(|(_, row)| row).collect();
        let at = rows
            .iter()
            .position(|r| r.action.as_str() == crate::picker::MORE_TOOLS)
            .unwrap_or(rows.len());
        let pins: Vec<PickerRow> = self
            .more_entries(caps, pinned)
            .into_iter()
            .filter(|r| r.pinned)
            .collect();
        rows.splice(at..at, pins);
        rows
    }

    /// Everything under More tools that is not pinned.
    pub fn more_tools(&self, caps: &Capabilities, pinned: &BTreeSet<PanelKind>) -> Vec<PickerRow> {
        self.more_entries(caps, pinned)
            .into_iter()
            .filter(|r| !r.pinned)
            .collect()
    }

    fn more_entries(&self, caps: &Capabilities, pinned: &BTreeSet<PanelKind>) -> Vec<PickerRow> {
        self.actions()
            .filter(|(_, a)| a.picker == Some(PickerSlot::More))
            .map(|(p, a)| self.row(p, a, caps, pinned.contains(&p.kind)))
            .collect()
    }

    /// What the agent may ask for: every action it is allowed to invoke, with
    /// its availability. Human-only actions are not listed.
    pub fn agent_catalog(&self, caps: &Capabilities) -> Vec<CatalogEntry> {
        let mut all = self.catalog(caps);
        all.retain(|entry| !entry.human_only);
        all
    }

    /// Every action as the agent sees it, availability and reasons included.
    /// Human-only actions are listed and marked, so the agent knows they exist
    /// and that they are not its to run.
    pub fn catalog(&self, caps: &Capabilities) -> Vec<CatalogEntry> {
        self.actions()
            .map(|(p, a)| CatalogEntry {
                action: a.id.clone(),
                panel: p.kind.clone(),
                title: a.title.clone(),
                intent: a.intent,
                availability: self.action_availability(p, a, caps),
                human_only: a.human_only,
            })
            .collect()
    }

    /// The shortcuts the descriptors ship with, scoped to their panel.
    pub fn default_shortcuts(&self) -> Vec<Shortcut> {
        self.actions()
            .filter_map(|(p, a)| {
                let key = a.default_key.as_ref()?;
                let context = match key.scope {
                    KeyScope::Global => KeyContext::Global,
                    KeyScope::Panel => KeyContext::Panel {
                        kind: p.kind.clone(),
                    },
                    KeyScope::TextEntry => KeyContext::TextEntry,
                };
                Some(Shortcut {
                    chord: key.chord.clone(),
                    context,
                    action: a.id.clone(),
                })
            })
            .collect()
    }

    /// Whether a saved panel (kind and version) can be restored by this build.
    pub fn check_version(&self, kind: &PanelKind, saved: u32) -> VersionCheck {
        match self.get(kind) {
            None => VersionCheck::UnknownKind,
            Some(p) if saved == p.version => VersionCheck::Current,
            Some(p) if saved < p.version => VersionCheck::Older,
            Some(_) => VersionCheck::Newer,
        }
    }
}
