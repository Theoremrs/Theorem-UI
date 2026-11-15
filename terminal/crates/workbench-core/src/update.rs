//! `update`: the one function that changes a [`Model`] (R33).
//!
//! Routing rules, in order:
//!
//! 1. Keys: the picker (the modal layer) first; then the workbench key table,
//!    which turns a chord into an action; then the focused panel. A key the
//!    workbench claims never reaches the panel, and the reverse.
//! 2. Actions resolve through the registry. `Focus` and `Open` change only the
//!    dock and focus. `Create`, `Start` and `Destroy` are handed to the panel
//!    of that kind, which supplies the effect's payload.
//! 3. A completion or host message is judged against the panel's binding. Only
//!    `Apply` reaches the panel as a message to act on; `CacheOnly` reaches it
//!    as `Cached`; the rest are counted and dropped.
//! 4. Terminal output does not go straight to a panel: it is judged against the
//!    pane's binding epoch, queued in the bounded PTY queue and handed over on
//!    the next `Tick` or before the next terminal event, in order. A frame lost
//!    to the bound reaches only the panes bound to its session, as a reset
//!    request.
//! 5. Closing a view detaches. A destroying effect is refused unless a
//!    `Destroy` action is running (R36).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ratatui::layout::{Direction, Rect};
use serde_json::Value;
use theorem_workbench_dock::{self as dock, GroupId, Hit, OpenAt, Tab};

use crate::completion::{Completion, CompletionPayload, Outcome};
use crate::effect::Effect;
use crate::host::HostMessage;
use crate::ids::{
    ActionId, Actor, EffectId, PanelInstanceId, PanelKind, ResourceKind, ResourceRef, Revision,
    WorkspaceIdentity,
};
use crate::keys::{KeyContext, active_contexts};
use crate::model::{Drag, Entry, Model, Notice, Viewport};
use crate::msg::{DockMsg, Inbound, Msg, Pointer};
use crate::panel::{
    Button, Composition, Ctx, Mode, OpenTarget, Panel, PanelMsg, PanelPointer, PointerKind,
};
use crate::panels::{PICKER_KIND, Unavailable};
use crate::picker::{PickerMsg, PickerOutcome};
use crate::picker_layout::{Layout, PickerHit};
use crate::queue::{Popped, PtyFrame, Push, QueueLimits, SourceQueues};
use crate::registry::{ActionIntent, Placement, Refusal};
use crate::results::SearchState;
use crate::stale::{Binding, Stale, Verdict, judge};
use keybinds::{Key, KeyInput, Mods};

/// Apply `msg` and return the effects the host must perform.
pub fn update(model: &mut Model, msg: Msg) -> Vec<Effect> {
    let tick = matches!(msg, Msg::Tick);
    let effects = match msg {
        Msg::Key(key) => model.on_key(key),
        Msg::Pointer(p) => model.on_pointer(p),
        Msg::Text(text) => model.on_text(text, false),
        Msg::Paste(text) => model.on_text(text, true),
        Msg::Composition(event) => model.on_composition(event),
        Msg::Resize { area, metrics } => {
            model.viewport = Some(Viewport { area, metrics });
            vec![]
        }
        Msg::Focus(focused) => {
            model.window_focused = focused;
            vec![]
        }
        Msg::ReducedMotion(reduced) => {
            model.reduced_motion = reduced;
            vec![]
        }
        Msg::Host(message) => model.on_host(message),
        Msg::Completion(completion) => model.on_completion(completion),
        Msg::Action { id, actor } => model.run_action(id, actor, None),
        Msg::ActionOn { id, actor, panel } => model.run_action(id, actor, Some(panel)),
        Msg::Picker(msg) => model.picker_msg(msg),
        Msg::Dock(msg) => model.on_dock(msg),
        Msg::Arrangement(msg) => model.on_arrangement(msg),
        Msg::Tick => model.on_tick(),
    };
    model.settle();
    if !tick {
        model.dirty = true;
    }
    effects
}

impl Model {
    /// The one entry the host's `dispatch` calls: a completion or a host
    /// message, told apart by the `channel` tag of [`Inbound`].
    pub fn dispatch(&mut self, inbound: Inbound) -> Vec<Effect> {
        update(self, inbound.into())
    }
}

/// What a call into a panel left behind.
pub(crate) struct CtxOut {
    pub(crate) effects: Vec<Effect>,
    pub(crate) opens: Vec<OpenTarget>,
    pub(crate) close: bool,
    pub(crate) invalidated: bool,
    pub(crate) full: Option<usize>,
}

/// How far the keyboard moves a splitter at a time.
const RESIZE_COLS: i32 = 2;
const RESIZE_ROWS: i32 = 1;

impl Model {
    // --- calling panels ---

    fn run_ctx(&mut self, id: &PanelInstanceId, mode: Mode, f: impl FnOnce(&mut Ctx)) -> CtxOut {
        let mut cx = Ctx {
            panel: id.clone(),
            ids: &mut self.ids,
            in_flight: &mut self.in_flight,
            origins: &mut self.origins,
            queues: &mut self.queues,
            mode,
            workspace: &self.workspace,
            caps: &self.caps,
            effects: vec![],
            opens: vec![],
            close: false,
            invalidated: false,
            full: None,
        };
        f(&mut cx);
        CtxOut {
            effects: cx.effects,
            opens: cx.opens,
            close: cx.close,
            invalidated: cx.invalidated,
            full: cx.full,
        }
    }

    /// Run `f` on one panel. The panel is out of the map while it runs, so it
    /// cannot reach another panel or the dock.
    fn call(
        &mut self,
        id: &PanelInstanceId,
        mode: Mode,
        f: impl FnOnce(&mut dyn Panel, &mut Ctx),
    ) -> Vec<Effect> {
        let Some(mut entry) = self.panels.remove(id) else {
            return vec![];
        };
        let silent = mode == Mode::Silent;
        let destroying = mode == Mode::Destroying;
        let out = self.run_ctx(id, mode, |cx| f(entry.panel.as_mut(), cx));
        self.panels.insert(id.clone(), entry);
        self.dirty |= out.invalidated;
        if let Some(limit) = out.full {
            // Told, not swallowed: the effect was not sent and the ones
            // already waiting for answers are untouched.
            self.counters.refused_full += 1;
            self.notify(Notice::EffectsFull { limit });
        }
        let mut effects = out.effects;
        for target in out.opens {
            self.open_target(target);
        }
        if out.close && !silent {
            effects.extend(self.close_panel(id, destroying));
        }
        effects
    }

    fn send(&mut self, id: &PanelInstanceId, msg: PanelMsg) -> Vec<Effect> {
        self.call(id, Mode::Normal, |p, cx| p.update(msg, cx))
    }

    /// Re-solve the dock and tell panels what changed around them: their body,
    /// and whether they own the keyboard. Neither can start work.
    pub(crate) fn settle(&mut self) {
        self.announce_workspace();
        self.announce_motion();
        self.replay_diagnostics();
        self.replay_retained();
        self.sync_tab_titles();
        self.follow_focus_for_picker();
        let Some(vp) = self.viewport else {
            self.frame = None;
            return;
        };
        let frame = self.dock.solve(vp.area, vp.metrics);
        let bodies: Vec<(PanelInstanceId, Rect)> = frame
            .groups
            .iter()
            .filter_map(|g| {
                let panel = g.active.as_ref()?;
                Some((PanelInstanceId::new(panel.0.clone()), g.body))
            })
            .collect();
        self.frame = Some(frame);
        for (id, body) in bodies {
            let Some(entry) = self.panels.get_mut(&id) else {
                continue;
            };
            if entry.kind.as_str() == PICKER_KIND {
                self.picker.set_area(body);
            }
            if entry.body == Some(body) {
                continue;
            }
            entry.body = Some(body);
            self.call(&id, Mode::Silent, |p, cx| {
                p.update(
                    PanelMsg::Resize {
                        area: body,
                        metrics: vp.metrics,
                    },
                    cx,
                )
            });
        }

        let desired = self.window_focused.then(|| self.focus_owner()).flatten();
        if desired != self.announced_focus {
            if let Some(old) = self.announced_focus.take() {
                self.call(&old, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::Focus(false), cx)
                });
            }
            if let Some(new) = desired.clone() {
                self.call(&new, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::Focus(true), cx)
                });
            }
            self.announced_focus = desired;
        }
    }

    /// Hand each available panel that reads the diagnostics feed the latest
    /// set per path, once, when it first appears. Silent.
    fn replay_diagnostics(&mut self) {
        self.diagnostics_told
            .retain(|id| self.panels.contains_key(id));
        let fresh: Vec<PanelInstanceId> = self
            .panels
            .iter()
            .filter(|(id, e)| {
                e.available && e.panel.wants_diagnostics() && !self.diagnostics_told.contains(*id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in fresh {
            self.diagnostics_told.insert(id.clone());
            let held: Vec<HostMessage> = self
                .retained
                .diagnostics
                .iter()
                .map(|(_, m)| m.clone())
                .collect();
            for message in held {
                self.call(&id, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::Host(message), cx)
                });
                self.dirty = true;
            }
        }
    }

    /// Deliver a diagnostics message to every panel that reads the feed and
    /// has been handed the retained sets. Fresh panels get it by replay.
    fn deliver_diagnostics(&mut self, message: HostMessage) -> Vec<Effect> {
        let targets: Vec<PanelInstanceId> = self
            .panels
            .iter()
            .filter(|(id, e)| {
                e.available && e.panel.wants_diagnostics() && self.diagnostics_told.contains(*id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = Vec::new();
        for id in targets {
            effects.extend(self.send(&id, PanelMsg::Host(message.clone())));
        }
        effects
    }

    /// Tell each available panel the reduced-motion setting when it differs
    /// from what it was last told (nothing told means full motion). Silent.
    fn announce_motion(&mut self) {
        let reduced = self.reduced_motion;
        self.motion_told
            .retain(|id, _| self.panels.contains_key(id));
        let stale: Vec<PanelInstanceId> = self
            .panels
            .iter()
            .filter(|(id, e)| {
                e.available && self.motion_told.get(*id).copied().unwrap_or(false) != reduced
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            self.motion_told.insert(id.clone(), reduced);
            self.call(&id, Mode::Silent, |p, cx| {
                p.update(PanelMsg::Motion { reduced }, cx)
            });
            self.dirty = true;
        }
    }

    /// Tell each panel the workspace it has not been told yet: a panel built
    /// after the host named it, and every panel when it changes. Silent: the
    /// panel emits on its next tick or input.
    fn announce_workspace(&mut self) {
        let identity = self.workspace.clone();
        if identity.generation.0 == 0 {
            return;
        }
        let stale: Vec<PanelInstanceId> = self
            .panels
            .iter()
            .filter(|(_, e)| e.workspace_seen != Some(identity.generation.0))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(entry) = self.panels.get_mut(&id) {
                entry.workspace_seen = Some(identity.generation.0);
            }
            let msg = PanelMsg::Workspace(identity.clone());
            self.call(&id, Mode::Silent, |p, cx| p.update(msg, cx));
            self.replay_sessions(&id);
            self.dirty = true;
        }
    }

    /// Hand a panel the latest state it missed by mounting, or binding, after
    /// it arrived: the retained conversation snapshot for the resource it is
    /// bound to, and (once per workspace announcement) the workspace's
    /// terminal sessions for a panel bound to terminals. Silent, and judged
    /// by the same gate a live message passes, so a snapshot older than the
    /// panel's revision is not replayed.
    /// Hand the dock each tab's current title so it measures the width the tab
    /// draws. Only panels that name themselves are touched; the others keep the
    /// title they were registered with.
    fn sync_tab_titles(&mut self) {
        let renames: Vec<(theorem_workbench_dock::PanelId, String)> = self
            .panels
            .iter()
            .filter_map(|(id, e)| {
                let label = e.panel.tab_label()?;
                Some((
                    theorem_workbench_dock::PanelId(id.as_str().to_owned()),
                    label.title,
                ))
            })
            .collect();
        for (panel, title) in renames {
            self.dock.set_tab_title(&panel, &title);
        }
    }

    fn replay_retained(&mut self) {
        let ids: Vec<PanelInstanceId> = self.panels.keys().cloned().collect();
        for id in ids {
            let Some(entry) = self.panels.get_mut(&id) else {
                continue;
            };
            if !entry.available {
                continue;
            }
            let binding = entry.binding();
            if entry.replayed.as_ref() == Some(&binding.resource) {
                continue;
            }
            entry.replayed = Some(binding.resource.clone());
            let find = |held: &[(ResourceRef, HostMessage)]| {
                held.iter()
                    .find(|(r, _)| *r == binding.resource)
                    .map(|(_, m)| m.clone())
            };
            let mut replay = Vec::new();
            if let Some(message) = find(&self.retained.snapshots) {
                let fresh = match (host_route(&message).0, host_route(&message).1) {
                    (Some(resource), Some(revision)) => {
                        let probe =
                            Completion::new(EffectId(0), resource.clone(), Outcome::Accepted)
                                .with_revision(revision);
                        !matches!(judge(&binding, &probe), Verdict::Drop(_))
                    }
                    _ => true,
                };
                if fresh {
                    replay.push(message);
                }
            }
            replay.extend(find(&self.retained.attachments));
            replay.extend(find(&self.retained.models));
            for message in replay {
                self.call(&id, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::Host(message), cx)
                });
                self.dirty = true;
            }
        }
    }

    /// The terminal sessions the host last listed for the workspace, to a
    /// panel bound to terminals that has just been told the workspace.
    fn replay_sessions(&mut self, id: &PanelInstanceId) {
        let workspace = self.workspace.workspace.clone();
        let terminal = self.panels.get(id).is_some_and(|e| {
            e.available
                && self
                    .registry
                    .get(&e.kind)
                    .is_some_and(|d| d.binding == ResourceKind::Terminal)
        });
        if !terminal {
            return;
        }
        let Some((_, message)) = self.retained.sessions.iter().find(|(w, _)| *w == workspace)
        else {
            return;
        };
        let message = message.clone();
        self.call(id, Mode::Silent, |p, cx| {
            p.update(PanelMsg::Host(message), cx)
        });
    }

    // --- keys and text ---

    pub(crate) fn on_key(&mut self, key: KeyInput) -> Vec<Effect> {
        if self.picker.holds_keys() {
            return self.picker_key(key);
        }
        if key.key() == Key::Esc && key.mods().is_empty() && self.close_transient() {
            return vec![];
        }
        let owner = self.focus_owner();
        let (kind, text_entry) = match owner.as_ref().and_then(|id| self.panels.get(id)) {
            Some(e) => (Some(e.kind.clone()), e.panel.text_entry()),
            None => (None, false),
        };
        let contexts = active_contexts(kind.as_ref(), text_entry);
        if let Some(action) = self.keys.resolve(&key, &contexts).cloned() {
            return self.run_action(action, Actor::Human, None);
        }
        match owner {
            Some(id) => self.send(&id, PanelMsg::Key(key)),
            None => vec![],
        }
    }

    fn picker_key(&mut self, key: KeyInput) -> Vec<Effect> {
        // Pinning and going back by name come from the key table, so a remap
        // moves them. Anything else the table binds is not the picker's.
        let contexts = [
            KeyContext::Panel {
                kind: PanelKind::new(PICKER_KIND),
            },
            KeyContext::Global,
        ];
        let named = self.keys.resolve(&key, &contexts).map(ActionId::as_str);
        match named {
            Some(crate::panels::ACTION_TOGGLE_PIN) => {
                return self.picker_msg(PickerMsg::TogglePin);
            }
            Some(crate::panels::ACTION_BACK) => return self.picker_msg(PickerMsg::Back),
            _ => {}
        }
        let msg = match key.key() {
            Key::Esc => PickerMsg::Back,
            Key::Enter => PickerMsg::Choose,
            Key::Down => PickerMsg::Next,
            Key::Up => PickerMsg::Prev,
            Key::Left => PickerMsg::Left,
            Key::Right => PickerMsg::Right,
            Key::Backspace => {
                let mut filter = self.picker.filter().to_owned();
                filter.pop();
                PickerMsg::Filter(filter)
            }
            Key::Char(c) if key.mods().difference(Mods::SHIFT).is_empty() => {
                PickerMsg::Filter(format!("{}{c}", self.picker.filter()))
            }
            // The picker owns the keyboard: nothing else sees the key.
            _ => return vec![],
        };
        self.picker_msg(msg)
    }

    pub(crate) fn on_text(&mut self, text: String, paste: bool) -> Vec<Effect> {
        if self.picker.holds_keys() {
            let text: String = text.chars().filter(|c| !c.is_control()).collect();
            let filter = format!("{}{text}", self.picker.filter());
            return self.picker_msg(PickerMsg::Filter(filter));
        }
        match self.focus_owner() {
            Some(id) if paste => self.send(&id, PanelMsg::Paste(text)),
            Some(id) => self.send(&id, PanelMsg::Text(text)),
            None => vec![],
        }
    }

    /// Composition goes to the panel that owns the keyboard. While the picker
    /// is open it owns the keyboard: a committed text is typed into its filter
    /// and the preedit is not shown.
    pub(crate) fn on_composition(&mut self, event: Composition) -> Vec<Effect> {
        if self.picker.holds_keys() {
            return match event {
                Composition::End { text } if !text.is_empty() => self.on_text(text, false),
                _ => vec![],
            };
        }
        match self.focus_owner() {
            Some(id) => self.send(&id, PanelMsg::Composition(event)),
            None => vec![],
        }
    }

    pub(crate) fn on_tick(&mut self) -> Vec<Effect> {
        let mut effects = self.drain_pty();
        let ids: Vec<PanelInstanceId> = self.panels.keys().cloned().collect();
        effects.extend(ids.iter().flat_map(|id| self.send(id, PanelMsg::Tick)));
        effects
    }

    // --- actions and the picker ---

    pub(crate) fn run_action(
        &mut self,
        id: ActionId,
        actor: Actor,
        on: Option<PanelInstanceId>,
    ) -> Vec<Effect> {
        // The picker's own semantic actions: back, and pin or unpin a tool.
        if let Some(effects) = self.picker_node_action(&id) {
            return effects;
        }
        let (kind, intent, title) = match self.registry.resolve(&id, &actor, &self.caps) {
            Ok(r) => (r.panel.kind.clone(), r.action.intent, r.panel.title.clone()),
            Err(refusal) => {
                self.notify(Notice::Refused(refusal));
                return vec![];
            }
        };
        if kind.as_str() == PICKER_KIND {
            return self.picker_msg(PickerMsg::Open);
        }
        if kind.as_str() == crate::panels::WORKBENCH_KIND {
            return self.workbench_action(id.as_str());
        }
        match intent {
            ActionIntent::Focus => {
                self.focus_or_open(&kind);
                vec![]
            }
            ActionIntent::Open => {
                self.open_panel(&kind);
                vec![]
            }
            ActionIntent::Local => {
                // Only the panel the action is for: the one named, else the
                // focused one. A panel of that kind elsewhere is not guessed.
                let target = match on {
                    Some(panel) => self
                        .panels
                        .get(&panel)
                        .is_some_and(|e| e.kind == kind && e.available)
                        .then_some(panel),
                    None => self.focus_owner().filter(|p| {
                        self.panels
                            .get(p)
                            .is_some_and(|e| e.kind == kind && e.available)
                    }),
                };
                let Some(target) = target else {
                    self.notify(Notice::Refused(Refusal::Unavailable {
                        reason: format!("Focus a {title} panel first."),
                    }));
                    return vec![];
                };
                self.call(&target, Mode::Normal, |p, cx| {
                    p.update(PanelMsg::Action(id), cx)
                })
            }
            ActionIntent::Create | ActionIntent::Start | ActionIntent::Destroy => {
                let Some(target) = self.target_of_kind(&kind) else {
                    self.notify(Notice::NoPanel(id));
                    return vec![];
                };
                let mode = if intent == ActionIntent::Destroy {
                    Mode::Destroying
                } else {
                    Mode::Normal
                };
                self.call(&target, mode, |p, cx| p.update(PanelMsg::Action(id), cx))
            }
        }
    }

    /// The open panel of `kind` an action is for: the focused one, else the
    /// first.
    fn target_of_kind(&self, kind: &PanelKind) -> Option<PanelInstanceId> {
        let owner = self.focus_owner().filter(|id| {
            self.panels
                .get(id)
                .is_some_and(|e| &e.kind == kind && e.available)
        });
        owner.or_else(|| {
            self.panels
                .iter()
                .find(|(_, e)| &e.kind == kind && e.available)
                .map(|(id, _)| id.clone())
        })
    }

    fn focus_or_open(&mut self, kind: &PanelKind) {
        let existing = self
            .panels
            .iter()
            .find(|(_, e)| &e.kind == kind)
            .map(|(id, _)| id.clone());
        let target = self
            .focus_owner()
            .filter(|id| self.panels.get(id).is_some_and(|e| &e.kind == kind))
            .or(existing);
        match target {
            Some(id) => {
                let r = self.dock.focus_panel(&Self::dock_id(&id));
                self.dock_result(r);
            }
            None => {
                self.open_panel(kind);
            }
        }
    }

    /// Open a new panel of `kind` in its default region. Opening starts
    /// nothing: the panel is built from no saved state and sent no message that
    /// could emit an effect.
    pub(crate) fn open_panel(&mut self, kind: &PanelKind) -> Option<PanelInstanceId> {
        self.open_panel_with(kind, &Value::Null, None)
    }

    /// Open a new panel of `kind` built from `state`, in `role`'s region or, by
    /// default, the kind's own.
    fn open_panel_with(
        &mut self,
        kind: &PanelKind,
        state: &Value,
        role: Option<dock::Role>,
    ) -> Option<PanelInstanceId> {
        let desc = self.registry.get(kind)?;
        let (title, version, placement) =
            (desc.title.clone(), desc.version, desc.default_placement);
        let role = role.unwrap_or(match placement {
            Placement::Left => dock::Role::Files,
            Placement::Main => dock::Role::Main,
            Placement::Tools => dock::Role::Tools,
        });
        let (panel, available) = self.build_panel(kind, version, state);
        self.place_panel(kind, version, &title, panel, available, role)
    }

    fn place_panel(
        &mut self,
        kind: &PanelKind,
        version: u32,
        title: &str,
        panel: Box<dyn Panel>,
        available: bool,
        role: dock::Role,
    ) -> Option<PanelInstanceId> {
        let id = self.mint_panel();
        let mut tab = Tab::new(
            id.as_str(),
            dock::PanelKind::new(kind.as_str(), version),
            title,
        );
        tab.unavailable = !available;
        let at = match self.group_of_role(role) {
            Some(group) => OpenAt::Group(group),
            None => OpenAt::Split {
                group: self.dock.focused(),
                side: match role {
                    dock::Role::Files | dock::Role::Main => dock::NavDirection::Left,
                    dock::Role::Tools => dock::NavDirection::Right,
                },
                role: Some(role),
            },
        };
        match self.dock.open_panel(tab, at) {
            Ok(_) => {
                self.panels.insert(
                    id.clone(),
                    Entry {
                        panel,
                        kind: kind.clone(),
                        available,
                        body: None,
                        workspace_seen: None,
                        replayed: None,
                    },
                );
                Some(id)
            }
            Err(e) => {
                self.notify(Notice::Dock(e));
                None
            }
        }
    }

    /// A panel asked to show `target`. Focus the panel already bound to it;
    /// else open the kind a registered opener names, where its descriptor places it; else
    /// the placeholder, with the reason. Never an effect: the new panel loads
    /// on its own first tick (R06).
    fn open_target(&mut self, target: OpenTarget) {
        let resource = target.resource();
        let bound = self
            .panels
            .iter()
            .find(|(_, e)| {
                // Only a panel that opens files shows the target: one that
                // reads the same document for another reason (a list of its
                // findings) is not it, and must not be focused in its place.
                e.available && e.binding().resource == resource && self.factories.is_opener(&e.kind)
            })
            .map(|(id, _)| id.clone());
        let opened = match bound {
            Some(id) => Some(id),
            None => match self.factories.opener_of(&target).cloned() {
                Some(kind) if self.registry.get(&kind).is_some() => {
                    // Where the kind says it opens (its descriptor's placement):
                    // documents, Changes and artifacts in the tool group.
                    self.open_panel_with(&kind, &target.state(), None)
                }
                _ => self.open_unavailable(&target),
            },
        };
        if let Some(id) = opened {
            let r = self.dock.focus_panel(&Self::dock_id(&id));
            self.dock_result(r);
            // The same document, a different place: say where. A placeholder
            // has no caret to move.
            if let Some((line, column)) = target.reveal()
                && self.panels.get(&id).is_some_and(|e| e.available)
            {
                self.call(&id, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::Reveal { line, column }, cx)
                });
            }
        }
    }

    /// The placeholder for a target nothing in this build opens. It keeps the
    /// target as its saved state, so a build that serves it can open it later.
    fn open_unavailable(&mut self, target: &OpenTarget) -> Option<PanelInstanceId> {
        let kind = PanelKind::new(target.fallback_kind());
        let state = target.state();
        let again = self
            .panels
            .iter()
            .find(|(_, e)| !e.available && e.kind == kind && e.panel.serialize() == state)
            .map(|(id, _)| id.clone());
        if again.is_some() {
            return again;
        }
        let reason = format!(
            "This build has no panel that can open {}.",
            target.describe()
        );
        let version = self.registry.get(&kind).map_or(1, |d| d.version);
        let panel = Box::new(Unavailable::new(kind.as_str(), reason, state));
        self.place_panel(
            &kind,
            version,
            &target.title(),
            panel,
            false,
            dock::Role::Tools,
        )
    }

    /// `picker.back`, `picker.pin.<kind>` and `picker.unpin.<kind>`: what the
    /// picker's semantic tree offers besides choosing a row. None when `id` is
    /// not one of them.
    fn picker_node_action(&mut self, id: &ActionId) -> Option<Vec<Effect>> {
        use crate::panels::{ACTION_BACK, ACTION_PIN, ACTION_UNPIN};
        let name = id.as_str();
        if name == ACTION_BACK {
            return Some(self.picker_msg(PickerMsg::Back));
        }
        if name == crate::panels::ACTION_TOGGLE_PIN {
            return Some(self.picker_msg(PickerMsg::TogglePin));
        }
        let (kind, pinned) = match (
            name.strip_prefix(ACTION_PIN),
            name.strip_prefix(ACTION_UNPIN),
        ) {
            (Some(kind), _) => (kind, true),
            (_, Some(kind)) => (kind, false),
            _ => return None,
        };
        if !self.set_pin(&PanelKind::new(kind), pinned) {
            self.notify(Notice::Refused(Refusal::UnknownAction(id.clone())));
        }
        Some(vec![])
    }

    pub(crate) fn picker_msg(&mut self, msg: PickerMsg) -> Vec<Effect> {
        let resting = msg == PickerMsg::Rest;
        let opening = resting || msg == PickerMsg::Open;
        if opening {
            self.note_focus_before_picker();
        }
        let outcome = self
            .picker
            .update(msg, &self.registry, &self.caps, &self.pinned);
        if opening {
            self.show_picker_panel();
            if resting {
                self.refocus_before_picker();
            }
        }
        match outcome {
            PickerOutcome::Nothing => vec![],
            PickerOutcome::Closed => {
                self.close_picker_panels();
                self.refocus_before_picker();
                vec![]
            }
            PickerOutcome::Unavailable { reason } => {
                self.notify(Notice::Refused(Refusal::Unavailable { reason }));
                vec![]
            }
            PickerOutcome::Pin { panel, pinned } => {
                self.set_pin(&panel, pinned);
                vec![]
            }
            PickerOutcome::Chosen(action) => {
                // The chosen tool takes the picker's place.
                let effects = self.run_action(action, Actor::Human, None);
                self.close_picker_panels();
                effects
            }
        }
    }

    fn is_picker_panel(&self, id: &PanelInstanceId) -> bool {
        self.panels
            .get(id)
            .is_some_and(|e| e.kind.as_str() == PICKER_KIND)
    }

    /// Remember where the keyboard is, unless it is already on the picker.
    fn note_focus_before_picker(&mut self) {
        if let Some(owner) = self.focus_owner().filter(|id| !self.is_picker_panel(id)) {
            self.before_picker = Some(owner);
        }
    }

    /// Put the keyboard back where it was before the picker took it, when that
    /// panel is still open.
    fn refocus_before_picker(&mut self) {
        let Some(id) = self.before_picker.clone() else {
            return;
        };
        if self.panels.contains_key(&id) {
            let r = self.dock.focus_panel(&Self::dock_id(&id));
            self.dock_result(r);
        }
    }

    /// A resting picker whose panel now owns the keyboard (its chord, a click
    /// on it, focus moving to its group) takes the keys from here on; anything
    /// else that owns the keyboard is where Esc will return to.
    fn follow_focus_for_picker(&mut self) {
        let Some(owner) = self.focus_owner() else {
            return;
        };
        if self.is_picker_panel(&owner) {
            if self.picker.is_resting() {
                self.picker
                    .update(PickerMsg::Take, &self.registry, &self.caps, &self.pinned);
            }
        } else {
            self.before_picker = Some(owner);
        }
    }

    /// The picker's body is a panel in the tools region: the empty destination
    /// a new tool tab starts as.
    fn show_picker_panel(&mut self) {
        let kind = PanelKind::new(PICKER_KIND);
        let existing = self
            .panels
            .iter()
            .find(|(_, e)| e.kind == kind)
            .map(|(id, _)| id.clone());
        match existing {
            Some(id) => {
                let r = self.dock.focus_panel(&Self::dock_id(&id));
                self.dock_result(r);
            }
            None => {
                self.open_panel(&kind);
            }
        }
    }

    fn close_picker_panels(&mut self) {
        let ids: Vec<PanelInstanceId> = self
            .panels
            .iter()
            .filter(|(_, e)| e.kind.as_str() == PICKER_KIND)
            .map(|(id, _)| id.clone())
            .collect();
        // The picker's tab is housekeeping: failing to remove the last one is
        // not something to tell the person about.
        let mark = self.notices.len();
        for id in ids {
            self.close_panel(&id, false);
        }
        self.notices.truncate(mark);
    }

    // --- closing ---

    /// Close a view. The panel's own `teardown` decides what its lifetime rule
    /// needs; `destroy` is true only while a `Destroy` action runs, and without
    /// it a destroying effect is refused (R36).
    pub(crate) fn close_panel(&mut self, id: &PanelInstanceId, destroy: bool) -> Vec<Effect> {
        if let Err(e) = self.dock.close_tab(&Self::dock_id(id)) {
            self.notify(Notice::Dock(e));
            return vec![];
        }
        let Some(mut entry) = self.panels.remove(id) else {
            return vec![];
        };
        if self.capture.as_ref() == Some(id) {
            self.capture = None;
        }
        if self.announced_focus.as_ref() == Some(id) {
            self.announced_focus = None;
        }
        let mode = if destroy {
            Mode::Destroying
        } else {
            Mode::Forbid(self.destroying.clone())
        };
        let out = self.run_ctx(id, mode, |cx| entry.panel.teardown(cx, destroy));
        self.origins.retain(|e, _| self.in_flight.is_pending(*e));
        self.searches.retain(|_, panel| panel != id);
        if destroy {
            self.retained.forget(&entry.binding().resource);
        }
        self.dirty = true;
        out.effects
    }

    // --- the keyboard's way around the dock ---

    /// Escape closes the innermost transient that is open: the picker first
    /// (it holds the keys, so it never gets here), then a splitter being
    /// dragged, then the drawer. Returns whether there was one; if not, the
    /// key goes on to the panel.
    fn close_transient(&mut self) -> bool {
        if let Some(drag) = self.drag.take() {
            // Cancel: the split goes back to the sizes it had, and the
            // pointer is let go.
            self.dock = *drag.start;
            self.capture = None;
            return true;
        }
        if let Some(drawer) = self.dock.drawer() {
            // A panel in the drawer that takes text (an editor, a terminal, a
            // composer) needs Esc itself; the action closes the drawer then.
            let typing = self.dock.focused() == drawer
                && self
                    .focus_owner()
                    .and_then(|id| self.panels.get(&id))
                    .is_some_and(|e| e.panel.text_entry());
            if typing {
                return false;
            }
            self.close_drawer();
            return true;
        }
        false
    }

    /// Close the drawer and put the keyboard back where it was when it opened.
    fn close_drawer(&mut self) {
        if self.dock.drawer().is_none() {
            return;
        }
        self.dock.close_drawer();
        if let Some(id) = self.before_drawer.take()
            && self.panels.contains_key(&id)
        {
            let r = self.dock.focus_panel(&Self::dock_id(&id));
            self.dock_result(r);
        }
    }

    /// One of the workbench's own actions, by its name after `workbench.`.
    fn workbench_action(&mut self, id: &str) -> Vec<Effect> {
        use dock::NavDirection::{Down, Left, Right, Up};
        let direction = |s: &str| match s {
            "left" => Some(Left),
            "right" => Some(Right),
            "up" => Some(Up),
            "down" => Some(Down),
            _ => None,
        };
        let name = id.strip_prefix("workbench.").unwrap_or(id);
        let (verb, arg) = name.split_once('.').unwrap_or((name, ""));
        match (verb, arg) {
            ("focus", d) => {
                if let Some(d) = direction(d) {
                    return self.on_dock(DockMsg::FocusDirection(d));
                }
            }
            ("move", d) => {
                if let Some(d) = direction(d) {
                    self.move_panel_toward(d);
                }
            }
            ("resize", "wider") => self.resize_focused([Right, Left], RESIZE_COLS),
            ("resize", "narrower") => self.resize_focused([Right, Left], -RESIZE_COLS),
            ("resize", "taller") => self.resize_focused([Down, Up], RESIZE_ROWS),
            ("resize", "shorter") => self.resize_focused([Down, Up], -RESIZE_ROWS),
            ("drawer", "close") => self.close_drawer(),
            ("maximize", _) => {
                if self.dock.maximized().is_some() {
                    self.dock.unmaximize();
                } else {
                    let r = self.dock.maximize(self.dock.focused());
                    self.dock_result(r);
                }
            }
            ("layout", preset) => {
                return self.on_arrangement(crate::arrangement::ArrangementMsg::Apply {
                    name: preset.to_owned(),
                });
            }
            _ => {}
        }
        vec![]
    }

    /// Move the active panel of the focused group into the nearest group in
    /// `dir`, and keep the keyboard on it. Refused (in a notice) when there is
    /// no group that way, and then nothing moves.
    fn move_panel_toward(&mut self, dir: dock::NavDirection) {
        let (Some(vp), Some(panel)) = (self.viewport, self.focus_owner()) else {
            return;
        };
        let from = self.dock.focused();
        match self.dock.focus_direction(dir, vp.area, vp.metrics) {
            Ok(to) => {
                let r = self.dock.move_tab(&Self::dock_id(&panel), to, None);
                if r.is_err() {
                    let _ = self.dock.focus_group(from);
                }
                self.dock_result(r);
                let r = self.dock.focus_panel(&Self::dock_id(&panel));
                self.dock_result(r);
            }
            Err(e) => self.notify(Notice::Dock(e)),
        }
    }

    /// Grow (or shrink) the focused group on the first of `edges` that has a
    /// splitter.
    fn resize_focused(&mut self, edges: [dock::NavDirection; 2], grow: i32) {
        let Some(vp) = self.viewport else {
            return;
        };
        let group = self.dock.focused();
        let mut result = Err(dock::DockError::NoSplitter(edges[0]));
        for edge in edges {
            result = self
                .dock
                .resize_group_edge(group, edge, grow, vp.area, vp.metrics);
            if !matches!(result, Err(dock::DockError::NoSplitter(_))) {
                break;
            }
        }
        self.dock_result(result);
    }

    // --- the dock ---

    fn dock_result<T>(&mut self, result: Result<T, dock::DockError>) {
        if let Err(e) = result {
            self.notify(Notice::Dock(e));
        }
    }

    pub(crate) fn on_dock(&mut self, msg: DockMsg) -> Vec<Effect> {
        let vp = self.viewport;
        match msg {
            DockMsg::ClosePanel(id) => return self.close_panel(&id, false),
            DockMsg::FocusGroup(g) => {
                let r = self.dock.focus_group(g);
                self.dock_result(r);
            }
            DockMsg::FocusPanel(id) => {
                let r = self.dock.focus_panel(&Self::dock_id(&id));
                self.dock_result(r);
            }
            DockMsg::FocusDirection(d) => {
                if let Some(vp) = vp {
                    let r = self.dock.focus_direction(d, vp.area, vp.metrics);
                    self.dock_result(r);
                }
            }
            DockMsg::MoveTab { panel, to, index } => {
                let r = self.dock.move_tab(&Self::dock_id(&panel), to, index);
                self.dock_result(r);
            }
            DockMsg::ReorderTab { panel, index } => {
                let r = self.dock.reorder_tab(&Self::dock_id(&panel), index);
                self.dock_result(r);
            }
            DockMsg::Maximize(g) => {
                let r = self.dock.maximize(g);
                self.dock_result(r);
            }
            DockMsg::Unmaximize => {
                self.dock.unmaximize();
            }
            DockMsg::HideGroup(g) => {
                let r = self.dock.hide_group(g);
                self.dock_result(r);
            }
            DockMsg::ShowGroup(g) => {
                let r = self.dock.show_group(g);
                self.dock_result(r);
            }
            DockMsg::OpenDrawer(g) => {
                if self.dock.drawer().is_none() {
                    self.before_drawer = self.focus_owner();
                }
                let r = self.dock.open_drawer(g);
                self.dock_result(r);
            }
            DockMsg::CloseDrawer => self.close_drawer(),
            DockMsg::ResizeSplit { path, delta } => {
                if let Some(vp) = vp {
                    let r = self.dock.resize_split(&path, delta, vp.area, vp.metrics);
                    self.dock_result(r);
                }
            }
        }
        vec![]
    }

    // --- pointer ---

    pub(crate) fn on_pointer(&mut self, p: Pointer) -> Vec<Effect> {
        let Some(hit) = self.frame.as_ref().map(|f| f.hit_test(p.x, p.y)) else {
            return vec![];
        };
        match p.kind {
            PointerKind::Down(Button::Left) => self.pointer_down(p, hit),
            PointerKind::Down(_) => self.pointer_body(p, &hit, true),
            PointerKind::Move => {
                if let Some(drag) = self.drag.clone() {
                    self.drag_to(&drag, p);
                    vec![]
                } else if let Some(id) = self.capture.clone() {
                    self.pointer_to(&id, p)
                } else {
                    self.pointer_body(p, &hit, false)
                }
            }
            PointerKind::Up(_) => {
                self.drag = None;
                match self.capture.take() {
                    Some(id) => self.pointer_to(&id, p),
                    None => vec![],
                }
            }
            PointerKind::Wheel { .. } => self.pointer_body(p, &hit, false),
        }
    }

    fn pointer_down(&mut self, p: Pointer, hit: Hit) -> Vec<Effect> {
        match hit {
            Hit::TabClose { panel, .. } => self.close_panel(&PanelInstanceId::new(panel.0), false),
            Hit::Tab { panel, .. } => {
                let r = self.dock.focus_panel(&panel);
                self.dock_result(r);
                vec![]
            }
            Hit::TabStrip { group } => {
                let r = self.dock.focus_group(group);
                self.dock_result(r);
                vec![]
            }
            Hit::Body { group } => {
                let r = self.dock.focus_group(group);
                self.dock_result(r);
                self.capture = self.active_of(group);
                match self.capture.clone() {
                    Some(id) => self.pointer_to(&id, p),
                    None => vec![],
                }
            }
            Hit::Splitter { path } => {
                let found = self
                    .frame
                    .as_ref()
                    .and_then(|f| f.splitters.iter().find(|s| s.path == path))
                    .map(|s| (s.direction, s.rect));
                if let Some((axis, rect)) = found {
                    let grab = match axis {
                        Direction::Horizontal => i32::from(p.x) - i32::from(rect.x),
                        Direction::Vertical => i32::from(p.y) - i32::from(rect.y),
                    };
                    self.drag = Some(Drag {
                        path,
                        axis,
                        grab,
                        start: Box::new(self.dock.clone()),
                    });
                }
                vec![]
            }
            Hit::Outside => vec![],
        }
    }

    /// A pointer event over a group's body, with no press to hold the pointer.
    fn pointer_body(&mut self, p: Pointer, hit: &Hit, focus: bool) -> Vec<Effect> {
        let Hit::Body { group } = hit else {
            return vec![];
        };
        if focus {
            let r = self.dock.focus_group(*group);
            self.dock_result(r);
        }
        match self.active_of(*group) {
            Some(id) => self.pointer_to(&id, p),
            None => vec![],
        }
    }

    fn active_of(&self, group: GroupId) -> Option<PanelInstanceId> {
        let panel = self.frame.as_ref()?.group(group)?.active.as_ref()?;
        Some(PanelInstanceId::new(panel.0.clone()))
    }

    /// Deliver `p` to a panel in coordinates relative to its body.
    fn pointer_to(&mut self, id: &PanelInstanceId, p: Pointer) -> Vec<Effect> {
        let Some(body) = self.frame.as_ref().and_then(|f| {
            f.groups
                .iter()
                .find(|g| g.active.as_ref().is_some_and(|a| a.0 == id.as_str()))
                .map(|g| g.body)
        }) else {
            return vec![];
        };
        if self.picker.is_open()
            && self
                .panels
                .get(id)
                .is_some_and(|e| e.kind.as_str() == PICKER_KIND)
        {
            return self.picker_pointer(p, body);
        }
        self.send(
            id,
            PanelMsg::Pointer(PanelPointer {
                kind: p.kind,
                x: i32::from(p.x) - i32::from(body.x),
                y: i32::from(p.y) - i32::from(body.y),
                mods: p.mods,
                clicks: p.clicks,
            }),
        )
    }

    /// A pointer over the picker's body. What is under it is the picker
    /// layout's answer (the one the view drew from): hovering a row selects
    /// it, a left click chooses it, a click on a pin control pins or unpins,
    /// a click on the back row goes back. Nothing else the pointer does
    /// reaches the picker.
    fn picker_pointer(&mut self, p: Pointer, body: Rect) -> Vec<Effect> {
        let Some(view) = self.picker_view() else {
            return vec![];
        };
        let hit = Layout::compute(&view, body).hit(p.x, p.y);
        let msg = match (p.kind, hit) {
            (PointerKind::Down(Button::Left), _) if self.picker.is_resting() => {
                // A click on a resting picker takes the keyboard, then acts.
                self.picker
                    .update(PickerMsg::Take, &self.registry, &self.caps, &self.pinned);
                return match hit {
                    Some(PickerHit::Row(i)) => self.picker_msg(PickerMsg::ChooseAt(i)),
                    Some(PickerHit::Pin(i)) => self.picker_msg(PickerMsg::TogglePinAt(i)),
                    Some(PickerHit::Back) => self.picker_msg(PickerMsg::Back),
                    None => vec![],
                };
            }
            (PointerKind::Down(Button::Left), Some(PickerHit::Row(i))) => PickerMsg::ChooseAt(i),
            (PointerKind::Down(Button::Left), Some(PickerHit::Pin(i))) => PickerMsg::TogglePinAt(i),
            (PointerKind::Down(Button::Left), Some(PickerHit::Back)) => PickerMsg::Back,
            (PointerKind::Move, Some(PickerHit::Row(i) | PickerHit::Pin(i))) => {
                PickerMsg::Select(i)
            }
            _ => return vec![],
        };
        self.picker_msg(msg)
    }

    /// Move the dragged splitter so its gutter follows the pointer. A move
    /// that would take a side under its minimum goes as far as it can.
    fn drag_to(&mut self, drag: &Drag, p: Pointer) {
        let (Some(vp), Some(frame)) = (self.viewport, self.frame.as_ref()) else {
            return;
        };
        let Some(s) = frame.splitters.iter().find(|s| s.path == drag.path) else {
            return;
        };
        let (pointer, gutter) = match drag.axis {
            Direction::Horizontal => (i32::from(p.x), i32::from(s.rect.x)),
            Direction::Vertical => (i32::from(p.y), i32::from(s.rect.y)),
        };
        let delta = pointer - drag.grab - gutter;
        if delta == 0 {
            return;
        }
        match self
            .dock
            .resize_split(&drag.path, delta, vp.area, vp.metrics)
        {
            Err(dock::DockError::BelowMinimum { allowed }) if allowed != 0 => {
                let _ = self
                    .dock
                    .resize_split(&drag.path, allowed, vp.area, vp.metrics);
            }
            _ => {}
        }
    }

    // --- completions and host messages ---

    pub(crate) fn on_completion(&mut self, completion: Completion) -> Vec<Effect> {
        if let Some(effects) = self.on_layout_completion(&completion) {
            return effects;
        }
        let origin = self.origins.remove(&completion.effect);
        let verdict = match origin.as_ref().and_then(|id| self.panels.get(id)) {
            Some(entry) => self.in_flight.settle(&entry.binding(), &completion),
            None => {
                // The view that asked is gone (or the effect was never ours):
                // settle the bookkeeping, deliver to no one.
                let nobody = Binding {
                    resource: ResourceRef::None,
                    revision: None,
                    generation: None,
                };
                match self.in_flight.settle(&nobody, &completion) {
                    Verdict::Apply | Verdict::CacheOnly => Verdict::Drop(Stale::NotBound),
                    dropped => dropped,
                }
            }
        };
        let target = origin.filter(|id| self.panels.contains_key(id));
        match (verdict, target) {
            (Verdict::Apply, Some(id)) => {
                self.counters.applied += 1;
                if let Some(CompletionPayload::SearchStarted(started)) = &completion.payload {
                    self.searches.insert(started.id.clone(), id.clone());
                }
                self.send(&id, PanelMsg::Completion(completion))
            }
            (Verdict::CacheOnly, Some(id)) => {
                self.counters.cached += 1;
                self.call(&id, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::Cached(completion), cx)
                })
            }
            (Verdict::Drop(stale), _) => self.drop_stale(stale),
            (_, None) => self.drop_stale(Stale::NotBound),
        }
    }

    fn drop_stale(&mut self, stale: Stale) -> Vec<Effect> {
        self.counters.dropped += 1;
        self.counters.last_drop = Some(stale);
        vec![]
    }

    /// The account changed: nothing held for the old one may reach the new.
    /// What a panel was waiting for is told as uncertain (it may have been
    /// done), silently, so a retry is the person's. Everything the root kept
    /// is dropped; a later completion of an old effect finds nothing in
    /// flight and is dropped as stale.
    fn on_account_changed(&mut self, account: String) -> Vec<Effect> {
        if self.workspace.account == account {
            return vec![];
        }
        let waiting = self.in_flight.take_all();
        let origins = std::mem::take(&mut self.origins);
        for (effect, pending) in waiting {
            let Some(panel) = origins.get(&effect).cloned() else {
                continue;
            };
            let told = Completion::new(
                effect,
                pending.resource,
                Outcome::Uncertain {
                    reason: "The account changed before this was answered.".into(),
                },
            );
            self.call(&panel, Mode::Silent, |p, cx| {
                p.update(PanelMsg::Completion(told), cx)
            });
        }
        self.searches.clear();
        self.retained = Default::default();
        self.queues = SourceQueues::new(QueueLimits::default());
        self.diagnostics_told.clear();
        self.forget_arrangements();
        for entry in self.panels.values_mut() {
            entry.replayed = None;
        }
        self.workspace = WorkspaceIdentity {
            account,
            workspace: String::new(),
            environment: None,
            generation: self.workspace.generation.next(),
        };
        self.dirty = true;
        vec![]
    }

    pub(crate) fn on_host(&mut self, message: HostMessage) -> Vec<Effect> {
        if let HostMessage::CapabilitiesChanged { capabilities } = &message {
            self.caps = capabilities.clone();
        }
        if let HostMessage::AccountChanged { account } = &message {
            return self.on_account_changed(account.clone());
        }
        if let HostMessage::WorkspaceChanged {
            workspace,
            environment,
        } = &message
        {
            // The root's own state, not a panel's: panels are told by `settle`.
            if self.workspace.workspace != *workspace || self.workspace.environment != *environment
            {
                self.workspace = WorkspaceIdentity {
                    account: self.workspace.account.clone(),
                    workspace: workspace.clone(),
                    environment: environment.clone(),
                    generation: self.workspace.generation.next(),
                };
                self.dirty = true;
            }
            return vec![];
        }
        if let HostMessage::SearchPage { id, state, .. } = &message {
            let Some(panel) = self.searches.get(id).cloned() else {
                return self.drop_stale(Stale::NotBound);
            };
            if *state != SearchState::More {
                self.searches.remove(id);
            }
            return self.send(&panel, PanelMsg::Host(message));
        }
        match &message {
            HostMessage::DiagnosticsSet { .. } => {
                if !self.retained.keep_diagnostics(&message) {
                    return self.drop_stale(Stale::OlderRevision);
                }
                return self.deliver_diagnostics(message);
            }
            HostMessage::DiagnosticsCleared { path } => {
                self.retained.forget_diagnostics(path);
                return self.deliver_diagnostics(message);
            }
            _ => {}
        }
        match &message {
            HostMessage::ConversationSnapshot {
                resource: resource @ ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            } if thread == conversation_id => self.retained.keep_snapshot(resource, &message),
            HostMessage::ConversationAttachments {
                resource: resource @ ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            } if thread == conversation_id => self.retained.keep_attachments(resource, &message),
            HostMessage::ConversationModels {
                resource: resource @ ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            } if thread == conversation_id => self.retained.keep_models(resource, &message),
            HostMessage::TerminalSessions { workspace, .. } => {
                self.retained.keep_sessions(workspace, &message);
            }
            _ => {}
        }
        let mut effects = match &message {
            HostMessage::TerminalOutput {
                resource,
                epoch,
                offset,
                data,
            } => return self.on_terminal_output(resource, *epoch, *offset, data),
            HostMessage::TerminalReset {
                resource,
                epoch,
                offset,
                data,
            } => {
                let mut effects = self.drain_pty();
                effects.extend(self.on_terminal_reset(resource, *epoch, *offset, data));
                return effects;
            }
            // Output that arrived first is handed over first.
            HostMessage::TerminalOpened { .. }
            | HostMessage::TerminalExited { .. }
            | HostMessage::TerminalControl { .. }
            | HostMessage::TerminalResized { .. } => self.drain_pty(),
            HostMessage::ConversationSnapshot {
                resource: ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            }
            | HostMessage::ConversationAttachments {
                resource: ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            }
            | HostMessage::ConversationModels {
                resource: ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            } if thread != conversation_id => {
                return self.drop_stale(Stale::ResourceChanged);
            }
            _ => vec![],
        };
        let (resource, revision) = host_route(&message);
        let targets = self.bound_to(resource);
        for id in targets {
            if let (Some(resource), Some(revision)) = (resource, &revision) {
                // The same gate a completion passes: an event older than the
                // panel's revision must not overwrite newer work.
                let probe = Completion::new(EffectId(0), resource.clone(), Outcome::Accepted)
                    .with_revision(revision.clone());
                let binding = self.panels[&id].binding();
                if let Verdict::Drop(stale) = judge(&binding, &probe) {
                    self.drop_stale(stale);
                    continue;
                }
            }
            effects.extend(self.send(&id, PanelMsg::Host(message.clone())));
        }
        effects
    }

    /// The panels a message about `resource` is for; every panel when it names
    /// none.
    fn bound_to(&self, resource: Option<&ResourceRef>) -> Vec<PanelInstanceId> {
        self.panels
            .iter()
            .filter(|(_, e)| match resource {
                Some(r) => e.binding().resource == *r,
                None => true,
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// A terminal frame older than the pane's binding epoch belongs to a
    /// binding that is gone.
    fn older_epoch(&self, id: &PanelInstanceId, epoch: u64) -> bool {
        self.panels
            .get(id)
            .and_then(|e| e.binding().generation)
            .is_some_and(|bound| epoch < bound.0)
    }

    /// Queue a frame for the panes bound to its session. Nothing is handed over
    /// here: the bounded queue holds it until the next tick, and a frame it
    /// cannot hold becomes a reset request, never a silent loss.
    fn on_terminal_output(
        &mut self,
        resource: &ResourceRef,
        epoch: u64,
        offset: u64,
        data: &str,
    ) -> Vec<Effect> {
        let Ok(bytes) = BASE64.decode(data) else {
            return self.drop_stale(Stale::MalformedFrame);
        };
        let targets = self.bound_to(Some(resource));
        if targets.is_empty() {
            return self.drop_stale(Stale::NotBound);
        }
        if targets.iter().all(|id| self.older_epoch(id, epoch)) {
            return self.drop_stale(Stale::OlderEpoch);
        }
        let frame = PtyFrame {
            resource: resource.clone(),
            epoch,
            offset,
            bytes,
        };
        match self.queues.pty.push(frame) {
            Push::Full(frame) => self.request_reset(&frame.resource, 1, frame.bytes.len() as u64),
            Push::Queued | Push::Merged | Push::QueuedAfterDrop { .. } => vec![],
        }
    }

    fn on_terminal_reset(
        &mut self,
        resource: &ResourceRef,
        epoch: u64,
        offset: u64,
        data: &str,
    ) -> Vec<Effect> {
        let Ok(formatted) = BASE64.decode(data) else {
            return self.drop_stale(Stale::MalformedFrame);
        };
        let mut effects = vec![];
        let targets = self.bound_to(Some(resource));
        if targets.is_empty() {
            return self.drop_stale(Stale::NotBound);
        }
        for id in targets {
            if self.older_epoch(&id, epoch) {
                self.drop_stale(Stale::OlderEpoch);
                continue;
            }
            self.dirty = true;
            effects.extend(self.send(
                &id,
                PanelMsg::TerminalReset {
                    epoch,
                    offset,
                    formatted: formatted.clone(),
                },
            ));
        }
        effects
    }

    /// Hand every queued frame to its panes, oldest first within a session. A
    /// gap in front of a session's frames means frames were dropped for the
    /// bound: the panes bound to that session, and no others, are asked to
    /// reset.
    pub(crate) fn drain_pty(&mut self) -> Vec<Effect> {
        let mut effects = vec![];
        while let Some((resource, popped)) = self.queues.pty.pop() {
            match popped {
                Popped::Gap { items, weight } => {
                    effects.extend(self.request_reset(&resource, items, weight))
                }
                Popped::Item(frame) => effects.extend(self.deliver_frame(frame)),
            }
        }
        effects
    }

    fn deliver_frame(&mut self, frame: PtyFrame) -> Vec<Effect> {
        let targets = self.bound_to(Some(&frame.resource));
        if targets.is_empty() {
            return self.drop_stale(Stale::NotBound);
        }
        let mut effects = vec![];
        for id in targets {
            if self.older_epoch(&id, frame.epoch) {
                self.drop_stale(Stale::OlderEpoch);
                continue;
            }
            self.dirty = true;
            effects.extend(self.send(
                &id,
                PanelMsg::TerminalOutput {
                    epoch: frame.epoch,
                    offset: frame.offset,
                    bytes: frame.bytes.clone(),
                },
            ));
        }
        effects
    }

    /// Ask the panes bound to `resource` (one terminal session) to reset.
    fn request_reset(&mut self, resource: &ResourceRef, frames: u64, bytes: u64) -> Vec<Effect> {
        let terminals = self.bound_to(Some(resource));
        let mut effects = vec![];
        for id in terminals {
            self.dirty = true;
            effects.extend(self.send(&id, PanelMsg::TerminalResetRequest { frames, bytes }));
        }
        effects
    }
}

/// The resource a host message is about, and the revision it is stamped with.
/// Messages that name no resource go to every panel.
fn host_route(message: &HostMessage) -> (Option<&ResourceRef>, Option<Revision>) {
    use HostMessage::*;
    match message {
        DocumentChanged {
            resource, revision, ..
        }
        | DocumentConflict {
            resource, revision, ..
        }
        | DocumentSaved { resource, revision } => (Some(resource), Some(revision.clone())),
        DocumentAcknowledged {
            resource, revision, ..
        }
        | DocumentResync {
            resource, revision, ..
        }
        | DocumentTokens {
            resource, revision, ..
        }
        | ConversationSnapshot {
            resource, revision, ..
        } => (Some(resource), Some(revision.clone())),
        ConversationAttachments { resource, .. } | ConversationModels { resource, .. } => {
            (Some(resource), None)
        }
        DocumentMoved { from, .. } => (Some(from), None),
        DocumentRetired { resource }
        | TerminalOutput { resource, .. }
        | TerminalReset { resource, .. }
        | TerminalResized { resource, .. }
        | TerminalOpened { resource, .. }
        | TerminalExited { resource, .. }
        | TerminalControl { resource, .. } => (Some(resource), None),
        FileChanged { .. }
        | ThemeChanged { .. }
        | CapabilitiesChanged { .. }
        | WorkspaceChanged { .. }
        | AccountChanged { .. }
        | ConnectionChanged { .. }
        | TerminalSessions { .. }
        | SearchPage { .. }
        | DiagnosticsSet { .. }
        | DiagnosticsCleared { .. }
        | Resync { .. } => (None, None),
    }
}
