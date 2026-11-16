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
use theorem_workbench_text::visible::visible;

use crate::completion::{Completion, CompletionPayload, Outcome};
use crate::draft::SourceReference;
use crate::effect::Effect;
use crate::host::{HostMessage, ProgramReport};
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
use crate::panels::{PICKER_KIND, THEO_KIND, THREADS_KIND, Unavailable};
use crate::picker::{LayoutChoice, PickerMsg, PickerOutcome};
use crate::picker_layout::{Layout, PickerHit};
use crate::queue::{Popped, PtyFrame, Push, QueueLimits, SourceQueues};
use crate::registry::{ActionIntent, Placement, Refusal};
use crate::results::SearchState;
use crate::stale::{Binding, Stale, Verdict, judge};
use keybinds::{Key, KeyInput, Mods};

/// Apply `msg` and return the effects the host must perform.
pub fn update(model: &mut Model, msg: Msg) -> Vec<Effect> {
    let tick = matches!(msg, Msg::Tick);
    // The person moving somewhere themselves pauses Follow the agent: a key,
    // click, dock move, picker choice or action of theirs that changes which
    // panel has the keyboard. Typing in the focused panel does not, and
    // nothing an agent or the host does can.
    let by_person = matches!(
        msg,
        Msg::Key(_)
            | Msg::Pointer(_)
            | Msg::Dock(_)
            | Msg::Picker(_)
            | Msg::Action {
                actor: Actor::Human,
                ..
            }
            | Msg::ActionOn {
                actor: Actor::Human,
                ..
            }
            | Msg::ActionWith {
                actor: Actor::Human,
                ..
            }
    );
    let held = by_person.then(|| (model.dock.focused(), model.focus_owner()));
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
        Msg::ActionWith {
            id,
            actor,
            panel,
            args,
        } => {
            let before = std::mem::replace(&mut model.acting_args, args);
            let effects = model.run_action(id, actor, panel);
            model.acting_args = before;
            effects
        }
        Msg::Picker(msg) => model.picker_msg(msg),
        Msg::Dock(msg) => model.on_dock(msg),
        Msg::Arrangement(msg) => model.on_arrangement(msg),
        Msg::Tick => model.on_tick(),
    };
    if let Some(held) = held
        && held != (model.dock.focused(), model.focus_owner())
        && model.follow.on
    {
        model.follow.on = false;
        model.dirty = true;
    }
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
    pub(crate) references: Vec<SourceReference>,
    pub(crate) switches: Vec<(String, String)>,
    pub(crate) close: bool,
    pub(crate) invalidated: bool,
    pub(crate) full: Option<usize>,
    pub(crate) refusals: Vec<String>,
}

/// How far the keyboard moves a splitter at a time.
const RESIZE_COLS: i32 = 2;
const RESIZE_ROWS: i32 = 1;

impl Model {
    // --- calling panels ---

    pub(crate) fn run_ctx(
        &mut self,
        id: &PanelInstanceId,
        mode: Mode,
        f: impl FnOnce(&mut Ctx),
    ) -> CtxOut {
        let mut cx = Ctx {
            panel: id.clone(),
            ids: &mut self.ids,
            in_flight: &mut self.in_flight,
            origins: &mut self.origins,
            queues: &mut self.queues,
            mode,
            workspace: &self.workspace,
            caps: &self.caps,
            actor: &self.acting,
            args: &self.acting_args,
            effects: vec![],
            opens: vec![],
            references: vec![],
            switches: vec![],
            close: false,
            invalidated: false,
            full: None,
            refusals: vec![],
        };
        f(&mut cx);
        CtxOut {
            effects: cx.effects,
            opens: cx.opens,
            references: cx.references,
            switches: cx.switches,
            close: cx.close,
            invalidated: cx.invalidated,
            full: cx.full,
            refusals: cx.refusals,
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
        let bound_before = entry.binding().resource;
        let out = self.run_ctx(id, mode, |cx| f(entry.panel.as_mut(), cx));
        // An effect for a resource the panel is not bound to, before or after
        // this call, is the panel acting for something it does not show (a
        // replace across files): its answer is not judged by the panel's binding.
        let bound_after = entry.binding().resource;
        for effect in &out.effects {
            if effect.resource != ResourceRef::None
                && effect.resource != bound_before
                && effect.resource != bound_after
            {
                self.in_flight.mark_foreign(effect.id);
            }
        }
        self.panels.insert(id.clone(), entry);
        self.dirty |= out.invalidated;
        if let Some(limit) = out.full {
            // Told, not swallowed: the effect was not sent and the ones
            // already waiting for answers are untouched.
            self.counters.refused_full += 1;
            self.notify(Notice::EffectsFull { limit });
        }
        for reason in out.refusals {
            self.notify(Notice::Refused(Refusal::Unavailable { reason }));
        }
        let mut effects = out.effects;
        for target in out.opens {
            self.open_target(target);
        }
        for reference in out.references {
            self.deliver_reference(id, reference);
        }
        for (project, thread) in out.switches {
            effects.extend(self.deliver_switch(project, thread));
        }
        if out.close && !silent {
            effects.extend(self.close_panel(id, destroying));
        }
        effects
    }

    /// A reference a panel collected goes to the draft of the conversation panel
    /// of the current workspace, without moving the keyboard. A conversation is
    /// named by a project, not a workspace, so the scope is the emitter's own:
    /// a panel bound to another workspace than the current one has nothing to
    /// add to this one's draft.
    fn deliver_reference(&mut self, from: &PanelInstanceId, reference: SourceReference) {
        let workspace = self
            .panels
            .get(from)
            .and_then(|e| e.binding().resource.workspace().map(str::to_owned));
        if let Some(workspace) = workspace
            && !self.workspace.workspace.is_empty()
            && workspace != self.workspace.workspace
        {
            self.drop_stale(Stale::ResourceChanged);
            return;
        }
        let kind = PanelKind::new(THEO_KIND);
        let target = match self.target_of_kind(&kind) {
            Some(target) => target,
            None => {
                let (focused, group) = (self.focus_owner(), self.dock.focused());
                let Some(opened) = self.open_panel(&kind) else {
                    return;
                };
                // The tool is there to be read, not to take the keyboard.
                match focused {
                    Some(prev) if self.panels.contains_key(&prev) => {
                        let r = self.dock.focus_panel(&Self::dock_id(&prev));
                        self.dock_result(r);
                    }
                    _ => {
                        let _ = self.dock.focus_group(group);
                    }
                }
                opened
            }
        };
        if !self.panels.get(&target).is_some_and(|e| e.available) {
            self.drop_stale(Stale::NotBound);
            return;
        }
        self.dirty = true;
        self.call(&target, Mode::Silent, |p, cx| {
            p.update(PanelMsg::Reference(reference), cx)
        });
    }

    /// A panel asked for another thread to be the open conversation. The
    /// conversation panel is the one that switches (its answer is what names
    /// the thread it now shows), so the ask goes to it, on the same acting
    /// party, and the effect it emits is the panel's own. The focused one, else
    /// the first; none open means there is nothing to switch.
    fn deliver_switch(&mut self, project: String, thread: String) -> Vec<Effect> {
        let kind = PanelKind::new(THEO_KIND);
        let Some(target) = self.target_of_kind(&kind) else {
            self.notify(Notice::NoPanel(ActionId::new("threads.open")));
            return vec![];
        };
        self.dirty = true;
        // Picking a thread goes back to Theo: its tab shows and holds the keys.
        let r = self.dock.focus_panel(&Self::dock_id(&target));
        self.dock_result(r);
        self.call(&target, Mode::Normal, |p, cx| {
            p.update(PanelMsg::Switch { project, thread }, cx)
        })
    }

    fn send(&mut self, id: &PanelInstanceId, msg: PanelMsg) -> Vec<Effect> {
        self.call(id, Mode::Normal, |p, cx| p.update(msg, cx))
    }

    /// Re-solve the dock and tell panels what changed around them: their body,
    /// and whether they own the keyboard. Neither can start work.
    pub(crate) fn settle(&mut self) {
        self.announce_workspace();
        self.announce_motion();
        self.announce_documents();
        self.replay_diagnostics();
        self.replay_retained();
        self.sync_tab_titles();
        self.follow_focus_for_picker();
        self.picker.set_layouts(self.arrangements());
        self.picker.clamp(&self.registry, &self.caps, &self.pinned);
        let Some(vp) = self.viewport else {
            self.frame = None;
            return;
        };
        let area = self.dock_area_in(vp.area);
        let mut frame = self.dock.solve(area, vp.metrics);
        if self.reconcile_drawer(&frame) {
            frame = self.dock.solve(area, vp.metrics);
        }
        self.settled_focus = self.focus_owner();
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

    /// Tell each repository panel which documents of its workspace are open and
    /// which hold unsaved changes, when that list differs from what it was last
    /// told. The model's own panels are the source: no host message says it.
    fn announce_documents(&mut self) {
        use crate::panel::OpenDocumentState;
        use std::collections::BTreeMap;
        let mut open: BTreeMap<String, BTreeMap<String, OpenDocumentState>> = BTreeMap::new();
        let mut repositories: Vec<(PanelInstanceId, String)> = vec![];
        for (id, entry) in &self.panels {
            if !entry.available {
                continue;
            }
            let Some(binding) = entry.panel.binding() else {
                continue;
            };
            match binding.resource {
                ResourceRef::Document {
                    workspace,
                    resource_id,
                } => {
                    let unsaved = entry.panel.tab_label().is_some_and(|l| l.modified);
                    let saved = match binding.revision {
                        Some(Revision::Seq(n)) => Some(n),
                        _ => None,
                    };
                    let slot = open
                        .entry(workspace)
                        .or_default()
                        .entry(resource_id.clone())
                        .or_insert(OpenDocumentState {
                            path: resource_id,
                            saved_revision: None,
                            unsaved: false,
                        });
                    slot.unsaved |= unsaved;
                    slot.saved_revision = slot.saved_revision.max(saved);
                }
                ResourceRef::Repository { workspace, .. } => {
                    repositories.push((id.clone(), workspace));
                }
                _ => {}
            }
        }
        self.documents_told
            .retain(|id, _| repositories.iter().any(|(r, _)| r == id));
        for (id, workspace) in repositories {
            let list: Vec<OpenDocumentState> = open
                .get(&workspace)
                .map(|m| m.values().cloned().collect())
                .unwrap_or_default();
            let told = self.documents_told.get(&id).cloned().unwrap_or_default();
            if list == told {
                continue;
            }
            self.documents_told.insert(id.clone(), list.clone());
            self.call(&id, Mode::Silent, |p, cx| {
                p.update(PanelMsg::Documents(list), cx)
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
                    // The width of the title as the tab draws it, spelled out.
                    visible(&label.title),
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
            replay.extend(find(&self.retained.locals));
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
        // Every panel is handed the last list of threads, as a live one reaches
        // every panel (the conversation names its project from it); a panel
        // that lists threads is handed the sessions too: the agents it shows
        // are the terminals' own.
        let available = self.panels.get(id).is_some_and(|e| e.available);
        let lists_threads = self
            .panels
            .get(id)
            .is_some_and(|e| e.available && e.kind.as_str() == THREADS_KIND);
        if available && let Some(message) = self.retained.threads.clone() {
            self.call(id, Mode::Silent, |p, cx| {
                p.update(PanelMsg::Host(message), cx)
            });
        }
        let terminal = lists_threads
            || self.panels.get(id).is_some_and(|e| {
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
        self.clear_transient_notice();
        if self.picker.holds_keys() {
            return self.picker_key(key);
        }
        if key.key() == Key::Esc && key.mods().is_empty() && self.close_transient() {
            return vec![];
        }
        let owner = self.focus_owner();
        let contexts = self.active_key_contexts(owner.as_ref());
        if let Some(action) = self.keys.resolve(&key, &contexts).cloned() {
            return self.run_action(action, Actor::Human, None);
        }
        match owner {
            Some(id) => self.send(&id, PanelMsg::Key(key)),
            None => vec![],
        }
    }

    /// The contexts a key resolves in while the keyboard is on `owner`: shared
    /// by [`on_key`](Self::on_key) and [`takes_chord`](Self::takes_chord) so
    /// the two cannot drift.
    fn active_key_contexts(&self, owner: Option<&PanelInstanceId>) -> Vec<KeyContext> {
        let (kind, text_entry) = match owner.and_then(|id| self.panels.get(id)) {
            Some(e) => (Some(e.kind.clone()), e.panel.text_entry()),
            None => (None, false),
        };
        active_contexts(kind.as_ref(), text_entry)
    }

    /// Whether `id` only moves the keyboard to a tool (opening it when it is
    /// not there): the one kind of table chord the picker lets through.
    fn is_focus_action(&self, id: &ActionId) -> bool {
        self.registry
            .resolve(id, &Actor::Human, &self.caps)
            .is_ok_and(|r| r.action.intent == ActionIntent::Focus)
    }

    /// The contexts a key resolves in while the picker holds the keyboard.
    fn picker_key_contexts() -> [KeyContext; 2] {
        [
            KeyContext::Panel {
                kind: PanelKind::new(PICKER_KIND),
            },
            KeyContext::Global,
        ]
    }

    /// Whether `on_key` would act on this chord now, without running anything.
    /// While the picker holds the keys that is a key the picker handles (its
    /// own table names, or the keys it reads); otherwise a binding in the
    /// active contexts, or a chord the focused panel handles itself
    /// ([`Panel::takes_chord`](crate::panel::Panel::takes_chord)).
    pub fn takes_chord(&self, key: &KeyInput) -> bool {
        if self.picker.holds_keys() {
            let tool = self
                .keys
                .resolve(key, &Self::picker_key_contexts())
                .is_some_and(|id| {
                    matches!(
                        id.as_str(),
                        crate::panels::ACTION_TOGGLE_PIN
                            | crate::panels::ACTION_BACK
                            | crate::picker::LAYOUT_RENAME
                            | crate::picker::LAYOUT_DELETE
                    ) || self.is_focus_action(id)
                        || self
                            .picker
                            .offers(id, &self.registry, &self.caps, &self.pinned)
                });
            return tool
                || match key.key() {
                    Key::Esc | Key::Enter | Key::Down | Key::Up | Key::Left | Key::Right => true,
                    Key::Backspace => true,
                    Key::Char(_) => key.mods().difference(Mods::SHIFT).is_empty(),
                    _ => false,
                };
        }
        let owner = self.focus_owner();
        let contexts = self.active_key_contexts(owner.as_ref());
        self.keys.resolve(key, &contexts).is_some()
            || owner
                .and_then(|id| self.panels.get(&id))
                .is_some_and(|e| e.panel.takes_chord(key))
    }

    fn picker_key(&mut self, key: KeyInput) -> Vec<Effect> {
        // Pinning and going back by name come from the key table, so a remap
        // moves them. Anything else the table binds is not the picker's.
        let named = self
            .keys
            .resolve(&key, &Self::picker_key_contexts())
            .map(ActionId::as_str);
        match named {
            Some(crate::panels::ACTION_TOGGLE_PIN) => {
                return self.picker_msg(PickerMsg::TogglePin);
            }
            Some(crate::panels::ACTION_BACK) => return self.picker_msg(PickerMsg::Back),
            Some(crate::picker::LAYOUT_RENAME) => {
                return self.picker_msg(PickerMsg::RenameSelected);
            }
            Some(crate::picker::LAYOUT_DELETE) => {
                return self.picker_msg(PickerMsg::DeleteSelected);
            }
            // The chord printed on a row chooses that row, as Enter on it would.
            // Any other chord the table binds is the workbench's own, and the
            // picker does not swallow it only when it merely moves the
            // keyboard to a tool (opening it when it is not there).
            Some(_) => {
                if let Some(action) = self
                    .keys
                    .resolve(&key, &Self::picker_key_contexts())
                    .cloned()
                {
                    if self
                        .picker
                        .offers(&action, &self.registry, &self.caps, &self.pinned)
                    {
                        return self.picker_msg(PickerMsg::ChooseRow(action));
                    }
                    if self.is_focus_action(&action) {
                        let _ = self.picker_msg(PickerMsg::Rest);
                        return self.run_action(action, Actor::Human, None);
                    }
                }
            }
            None => {}
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
        // Panels called while the action runs are told who it is for.
        let before = std::mem::replace(&mut self.acting, actor.clone());
        let effects = self.run_action_for(id, actor, on);
        self.acting = before;
        effects
    }

    fn run_action_for(
        &mut self,
        id: ActionId,
        actor: Actor,
        on: Option<PanelInstanceId>,
    ) -> Vec<Effect> {
        // An action aimed at a panel that is not open is refused whatever its
        // intent, so a wrong handle never falls back to another panel.
        if let Some(panel) = &on
            && !self.panels.contains_key(panel)
        {
            self.notify(Notice::Refused(Refusal::UnknownPanel(panel.clone())));
            return vec![];
        }
        // The tab strip's and the picker's own semantic actions.
        if let Some(effects) = self.tab_node_action(&id) {
            return effects;
        }
        // A delegation row of the conversation: the panel that shows it opens
        // the changes panel, for a person's Enter and an agent's action alike.
        // So do the conversation view's own actions on its blocks and activity level.
        if id
            .as_str()
            .starts_with(crate::panels::ACTION_DELEGATION_OPEN)
            || id.as_str().starts_with(crate::builtin::ACTION_THEO_VIEW)
        {
            return self.delegation_node_action(id, on);
        }
        // One presentation of the panel's document, by kind. The same checks
        // run for a person's choice and an agent's.
        if let Some(kind) = id
            .as_str()
            .strip_prefix(crate::presentation::PRESENTATION_USE)
        {
            return self.use_presentation(&PanelKind::new(kind), on);
        }
        if let Some(effects) = self.picker_node_action(&id) {
            return effects;
        }
        // An agent naming a row the open picker offers chooses it as a click
        // would (the picker closes), and the tool runs for that agent.
        if !actor.is_human()
            && self.picker.is_open()
            && !self.picker.is_resting()
            && self
                .picker
                .offers(&id, &self.registry, &self.caps, &self.pinned)
            && self.registry.resolve(&id, &actor, &self.caps).is_ok()
        {
            return self.picker_msg(PickerMsg::ChooseRow(id));
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
            return self.workbench_action(id.as_str(), on);
        }
        if kind.as_str() == crate::panels::CODING_KIND {
            return self.coding_action(id, on);
        }
        match intent {
            ActionIntent::Focus => {
                self.focus_or_open(&kind);
                if let Some(owner) = self.focus_owner()
                    && self.panels.get(&owner).is_some_and(|e| e.kind == kind)
                {
                    self.note_acted(&owner);
                }
                vec![]
            }
            ActionIntent::Open => {
                if let Some(opened) = self.open_panel(&kind) {
                    self.note_acted(&opened);
                }
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
                self.note_acted(&target);
                self.call(&target, Mode::Normal, |p, cx| {
                    p.update(PanelMsg::Action(id), cx)
                })
            }
            ActionIntent::Create | ActionIntent::Start | ActionIntent::Destroy => {
                let Some(target) = self.target_of_kind(&kind) else {
                    self.notify(Notice::NoPanel(id));
                    return vec![];
                };
                self.note_acted(&target);
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
                    let role = target.main_region().then_some(dock::Role::Main);
                    self.open_panel_with(&kind, &target.state(), role)
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

    /// `tab.focus.<panel>` and `tab.close.<panel>`: what a tab node of the
    /// semantic tree offers. Each is the dock operation a click on the tab or
    /// its close mark does. None when `id` is not one of them.
    fn tab_node_action(&mut self, id: &ActionId) -> Option<Vec<Effect>> {
        use crate::panels::{ACTION_TAB_CLOSE, ACTION_TAB_FOCUS};
        let name = id.as_str();
        let (panel, close) = match (
            name.strip_prefix(ACTION_TAB_FOCUS),
            name.strip_prefix(ACTION_TAB_CLOSE),
        ) {
            (Some(panel), _) => (panel, false),
            (_, Some(panel)) => (panel, true),
            _ => return None,
        };
        let panel = PanelInstanceId::new(panel);
        if !self.panels.contains_key(&panel) {
            self.notify(Notice::Refused(Refusal::UnknownPanel(panel)));
            return Some(vec![]);
        }
        Some(self.on_dock(if close {
            DockMsg::ClosePanel(panel)
        } else {
            DockMsg::FocusPanel(panel)
        }))
    }

    /// `theo.delegation.open.<delegation>`: handed to the conversation panel the
    /// action is for (the one named, else the focused one, else the first).
    /// Opening starts nothing, so it is the same for every actor.
    fn delegation_node_action(&mut self, id: ActionId, on: Option<PanelInstanceId>) -> Vec<Effect> {
        // The conversation and a side chat both list their delegations.
        let theo = PanelKind::new(THEO_KIND);
        let is_theo = |model: &Self, p: &PanelInstanceId| {
            model
                .panels
                .get(p)
                .is_some_and(|e| e.available && (e.kind == theo || e.kind.as_str() == "side-chat"))
        };
        let target = match on {
            Some(p) => is_theo(self, &p).then_some(p),
            None => self
                .focus_owner()
                .filter(|p| is_theo(self, p))
                .or_else(|| self.target_of_kind(&theo)),
        };
        let Some(target) = target else {
            self.notify(Notice::NoPanel(id));
            return vec![];
        };
        self.call(&target, Mode::Normal, |p, cx| {
            p.update(PanelMsg::Action(id), cx)
        })
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
        match name {
            crate::picker::LAYOUT_RENAME => {
                return Some(self.picker_msg(PickerMsg::RenameSelected));
            }
            crate::picker::LAYOUT_DELETE => {
                return Some(self.picker_msg(PickerMsg::DeleteSelected));
            }
            _ => {}
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
            PickerOutcome::Layout(choice) => self.on_layout_choice(choice),
            PickerOutcome::Presentation(kind) => {
                // The keyboard goes back to the panel before the swap, so the
                // panel that is swapped is the one that has it.
                self.leave_picker();
                self.use_presentation(&kind, None)
            }
            PickerOutcome::Chosen(action) => {
                // The chosen tool takes the picker's place.
                // Whoever chose the row is who it runs for: the person's key
                // or click, or the agent run that named the row's action.
                let who = self.acting.clone();
                let effects = self.run_action(action, who, None);
                self.close_picker_panels();
                effects
            }
        }
    }

    /// A layout row or the name entry was confirmed in the picker.
    fn on_layout_choice(&mut self, choice: LayoutChoice) -> Vec<Effect> {
        use crate::arrangement::ArrangementMsg as A;
        let msg = match choice {
            LayoutChoice::Apply(name) => {
                self.leave_picker();
                A::Apply { name }
            }
            LayoutChoice::Save(name) => {
                self.leave_picker();
                A::Save { name }
            }
            LayoutChoice::Rename { from, to } => A::Rename { from, to },
            LayoutChoice::Delete(name) => A::Delete { name },
        };
        self.on_arrangement(msg)
    }

    /// The picker closed with a choice: its tab goes and the keyboard goes
    /// back where it was, before the choice acts, so a saved arrangement's own
    /// focus is the last word.
    fn leave_picker(&mut self) {
        self.close_picker_panels();
        self.refocus_before_picker();
    }

    pub(crate) fn is_picker_panel(&self, id: &PanelInstanceId) -> bool {
        self.panels
            .get(id)
            .is_some_and(|e| e.kind.as_str() == PICKER_KIND)
    }

    /// Remember where the keyboard is, unless it is already on the picker.
    pub(crate) fn note_focus_before_picker(&mut self) {
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
        self.show_picker_panel_in(None);
    }

    fn show_picker_panel_in(&mut self, role: Option<dock::Role>) {
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
                self.open_panel_with(&kind, &Value::Null, role);
            }
        }
    }

    fn dock_holds_no_tab(&self) -> bool {
        self.dock
            .group_ids()
            .into_iter()
            .all(|g| self.dock.group(g).is_none_or(|g| g.tabs().is_empty()))
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
        let line = self.transient.clone();
        for id in ids {
            self.close_panel(&id, false);
        }
        self.notices.truncate(mark);
        self.transient = line;
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
        let was_picker = entry.kind.as_str() == PICKER_KIND;
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
        let resource = entry.binding().resource;
        if destroy {
            self.retained.forget(&resource);
        }
        // A document nobody has open any more keeps no local state.
        if !self
            .panels
            .values()
            .any(|e| e.binding().resource == resource)
        {
            self.retained.forget_local(&resource);
        }
        self.dirty = true;
        let effects = out.effects;
        // Closing the last panel leaves the main pane empty. The spec is
        // silent on what an empty dock shows; the tool picker ("Add tool") is
        // the one thing that is always there to choose from.
        // A picker the person dismissed stays dismissed: its chord still opens it.
        if !was_picker && self.dock_holds_no_tab() {
            self.note_focus_before_picker();
            self.picker
                .update(PickerMsg::Rest, &self.registry, &self.caps, &self.pinned);
            self.show_picker_panel_in(Some(dock::Role::Main));
        }
        effects
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
            // A panel in the drawer that holds Esc (it takes text, like an
            // editor, a terminal or a composer, or it says so) needs it
            // itself; the action closes the drawer then.
            let typing = self.dock.focused() == drawer
                && self
                    .focus_owner()
                    .and_then(|id| self.panels.get(&id))
                    .is_some_and(|e| e.panel.holds_escape());
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
        let Some(drawer) = self.dock.drawer() else {
            return;
        };
        self.dock.close_drawer();
        // A collapsed group's own panel is no place to go back to: focus
        // there would open the drawer again.
        let collapsed = self
            .frame
            .as_ref()
            .is_some_and(|f| f.drawers.iter().any(|d| d.group == drawer));
        let back = self.before_drawer.take().filter(|id| {
            self.panels.contains_key(id)
                && !(collapsed && self.dock.find_panel(&Self::dock_id(id)) == Some(drawer))
        });
        if let Some(id) = back {
            let r = self.dock.focus_panel(&Self::dock_id(&id));
            self.dock_result(r);
        } else if self.dock.focused() == drawer {
            // Nowhere to go back to (focus was in the drawer's own group
            // before it collapsed): leave for a group that is drawn, or a
            // collapsed group would just open again.
            self.focus_a_drawn_group(drawer);
        }
    }

    /// Focus the first visible group other than `not` that is not a
    /// collapsed Files group, preferring Main.
    fn focus_a_drawn_group(&mut self, not: GroupId) {
        let ids = self.dock.group_ids();
        let pick = |role: Option<dock::Role>| {
            ids.iter().copied().find(|id| {
                *id != not
                    && self
                        .dock
                        .group(*id)
                        .is_some_and(|g| !g.is_hidden() && role.is_none_or(|r| g.role() == r))
            })
        };
        if let Some(id) = pick(Some(dock::Role::Main)).or_else(|| pick(None)) {
            let _ = self.dock.focus_group(id);
        }
    }

    /// Keep the drawer true to the keyboard. A group the window has no room
    /// for collapses to a drawer; focus that lands in it, by a chord,
    /// `tab.focus` or anything else, opens the drawer so the focused panel is
    /// drawn and gets the keys, and focus that leaves it closes the drawer.
    /// Only collapsed groups are touched. Returns whether the dock changed.
    fn reconcile_drawer(&mut self, frame: &dock::SolvedFrame) -> bool {
        let focused = self.dock.focused();
        if let Some(d) = frame.drawers.iter().find(|d| d.group == focused && !d.open) {
            let came_from = self
                .settled_focus
                .clone()
                .filter(|id| self.dock.find_panel(&Self::dock_id(id)) != Some(d.group));
            if self.dock.drawer().is_none() {
                self.before_drawer = came_from;
            }
            let r = self.dock.open_drawer(d.group);
            self.dock_result(r);
            return true;
        }
        if frame.drawers.iter().any(|d| d.open && d.group != focused) {
            self.dock.close_drawer();
            self.before_drawer = None;
            return true;
        }
        false
    }

    /// One of the workbench's own actions, by its name after `workbench.`.
    fn workbench_action(&mut self, id: &str, on: Option<PanelInstanceId>) -> Vec<Effect> {
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
            ("panel", "presentation" | "presentation.next") => {
                return self.presentation_action(id, on);
            }
            ("follow", "pause") => self.set_following(false),
            ("follow", "resume") => self.set_following(true),
            ("layouts", _) => {
                let _ = self.picker_msg(PickerMsg::Open);
                return self.picker_msg(PickerMsg::Layouts);
            }
            ("layout", "save") => {
                let _ = self.picker_msg(PickerMsg::Open);
                return self.picker_msg(PickerMsg::SaveAs);
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

    /// `code.start`, `code.send` and `code.stop`. The model checks what it
    /// can see (the arguments, the kind of panel, the kind's availability);
    /// the panel that does the work checks the rest and refuses with its
    /// reason.
    fn coding_action(&mut self, id: ActionId, on: Option<PanelInstanceId>) -> Vec<Effect> {
        use crate::panels::{
            ACTION_CODE_SEND, ACTION_CODE_START, CODING_PROFILES, SHELL_KIND, SIDE_CHAT_KIND,
        };
        let invalid = |me: &mut Self, reason: String| {
            me.notify(Notice::Refused(Refusal::InvalidArgs { reason }));
            vec![]
        };
        if id.as_str() == ACTION_CODE_START {
            if self.acting_args.input().is_none() {
                return invalid(self, "code.start needs the task as input.".into());
            }
            let (kind, opener) = match self.acting_args.option() {
                None | Some("theorem") => (SIDE_CHAT_KIND, "side-chat.choose"),
                Some(o) if CODING_PROFILES.iter().any(|(name, _)| *name == o) => {
                    (SHELL_KIND, "shell.choose")
                }
                Some(o) => {
                    return invalid(
                        self,
                        format!(
                            "code.start takes the option theorem, claude or codex, not \"{o}\"."
                        ),
                    );
                }
            };
            // The kind's own availability, as its opener would be refused.
            if let Err(refusal) =
                self.registry
                    .resolve(&ActionId::new(opener), &self.acting, &self.caps)
            {
                self.notify(Notice::Refused(refusal));
                return vec![];
            }
            let Some(panel) = self.open_panel(&PanelKind::new(kind)) else {
                return vec![];
            };
            self.note_acted(&panel);
            // The new panel is told the workspace, the retained session and
            // thread lists and its size now, as the end of this update would,
            // so it acts knowing what the host offers and where.
            self.settle();
            let effects = self.call(&panel, Mode::Normal, |p, cx| {
                p.update(PanelMsg::Action(id), cx)
            });
            // A panel that started nothing refused, and said why: the pane it
            // was opened in goes again, so no empty chooser is left behind.
            if effects.is_empty() {
                return self.close_panel(&panel, false);
            }
            return effects;
        }
        let Some(target) = on.or_else(|| self.focus_owner()) else {
            self.notify(Notice::Refused(Refusal::Unavailable {
                reason: format!(
                    "{} needs the side chat or shell panel to act on.",
                    id.as_str()
                ),
            }));
            return vec![];
        };
        let Some((kind, available)) = self
            .panels
            .get(&target)
            .map(|e| (e.kind.clone(), e.available))
        else {
            self.notify(Notice::Refused(Refusal::UnknownPanel(target)));
            return vec![];
        };
        if !matches!(kind.as_str(), SIDE_CHAT_KIND | SHELL_KIND) {
            self.notify(Notice::Refused(Refusal::Unavailable {
                reason: format!(
                    "{} acts on a side chat or a shell, not a {} panel.",
                    id.as_str(),
                    kind.as_str()
                ),
            }));
            return vec![];
        }
        if !available {
            self.notify(Notice::Refused(Refusal::Unavailable {
                reason: "That panel is unavailable here.".into(),
            }));
            return vec![];
        }
        if id.as_str() == ACTION_CODE_SEND && self.acting_args.input().is_none() {
            return invalid(self, "code.send needs the words to send as input.".into());
        }
        self.note_acted(&target);
        self.call(&target, Mode::Normal, |p, cx| {
            p.update(PanelMsg::Action(id), cx)
        })
    }

    fn set_following(&mut self, on: bool) {
        if self.follow.on != on {
            self.follow.on = on;
            self.dirty = true;
        }
    }

    /// An agent run edited a document: when Follow the agent is on and the run
    /// is followed, show where without taking the keyboard. The panel showing
    /// the document gets the position; else a panel is opened for it, in the
    /// place its kind goes, and the keyboard goes back where it was. The panel
    /// that has the keyboard is left alone, so a person's caret and draft
    /// are not disturbed. Never an effect: the opened panel loads on its own
    /// tick.
    fn follow_edit(&mut self, message: &HostMessage) -> Vec<Effect> {
        let HostMessage::DocumentChanged {
            resource:
                resource @ ResourceRef::Document {
                    workspace,
                    resource_id,
                },
            actor,
            unit,
            edits,
            ..
        } = message
        else {
            return vec![];
        };
        let followed = actor
            .strip_prefix("theorem:run:")
            .is_some_and(|run| self.follow.runs.contains(run));
        if !self.follow.on || !followed {
            return vec![];
        }
        if !self.workspace.workspace.is_empty() && *workspace != self.workspace.workspace {
            return vec![];
        }
        let target = OpenTarget::File {
            workspace: workspace.clone(),
            path: resource_id.clone(),
        };
        let owner = self.focus_owner();
        let bound = self
            .panels
            .iter()
            .find(|(_, e)| {
                e.available
                    && e.binding().resource == *resource
                    && self.factories.is_opener(&e.kind)
            })
            .map(|(id, _)| id.clone());
        let mut effects = vec![];
        let opened = bound.is_none();
        let shown = match bound {
            Some(id) => id,
            None => {
                // One preview at a time: the last one the follow opened goes
                // when the person has not touched it.
                if let Some(old) = self.follow.preview.take()
                    && Some(&old) != owner.as_ref()
                    && self
                        .panels
                        .get(&old)
                        .is_some_and(|e| e.panel.tab_label().is_none_or(|l| !l.modified))
                {
                    effects.extend(self.close_panel(&old, false));
                }
                let kind = match self.factories.opener_of(&target).cloned() {
                    Some(kind) if self.registry.get(&kind).is_some() => kind,
                    _ => return effects,
                };
                let Some(id) = self.open_panel_with(&kind, &target.state(), None) else {
                    return effects;
                };
                self.follow.preview = Some(id.clone());
                id
            }
        };
        self.dirty = true;
        // Bring it forward, then give the keyboard back. A panel that was
        // already open in the focused group cannot be shown without taking
        // the keyboard (the dock has one active tab per group, and it is the
        // person's); it still receives the position.
        if owner.as_ref() != Some(&shown) {
            let same_group = self
                .dock
                .find_panel(&Self::dock_id(&shown))
                .is_some_and(|g| g == self.dock.focused());
            if opened || !same_group {
                if !same_group {
                    let _ = self.dock.focus_panel(&Self::dock_id(&shown));
                }
                if let Some(prev) = owner.as_ref().filter(|p| self.panels.contains_key(*p)) {
                    let _ = self.dock.focus_panel(&Self::dock_id(prev));
                }
            }
            if let Some(start) = edits.iter().map(|e| e.start).min() {
                self.call(&shown, Mode::Silent, |p, cx| {
                    p.update(PanelMsg::RevealOffset { start, unit: *unit }, cx)
                });
            }
        }
        effects
    }

    /// Move the active panel of the focused group into the nearest group in
    /// `dir`, and keep the keyboard on it. Refused (in a notice) when there is
    /// no group that way, and then nothing moves.
    fn move_panel_toward(&mut self, dir: dock::NavDirection) {
        let (Some(vp), Some(panel)) = (self.viewport, self.focus_owner()) else {
            return;
        };
        let from = self.dock.focused();
        match self
            .dock
            .focus_direction(dir, self.dock_area_in(vp.area), vp.metrics)
        {
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
            result = self.dock.resize_group_edge(
                group,
                edge,
                grow,
                self.dock_area_in(vp.area),
                vp.metrics,
            );
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
                    let r = self
                        .dock
                        .focus_direction(d, self.dock_area_in(vp.area), vp.metrics);
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
                    let r = self.dock.resize_split(
                        &path,
                        delta,
                        self.dock_area_in(vp.area),
                        vp.metrics,
                    );
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
            .resize_split(&drag.path, delta, self.dock_area_in(vp.area), vp.metrics)
        {
            Err(dock::DockError::BelowMinimum { allowed }) if allowed != 0 => {
                let _ = self.dock.resize_split(
                    &drag.path,
                    allowed,
                    self.dock_area_in(vp.area),
                    vp.metrics,
                );
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
        // Panels that show the old account's documents and terminals go with
        // it: nothing of theirs can be saved or sent as the new account. What
        // their teardown would say is for a host that no longer answers, so
        // it is dropped. The first account of the session has nothing to close:
        // a restored layout is not another account's.
        let switched = !self.workspace.account.is_empty();
        if switched {
            let old: Vec<PanelInstanceId> = self
                .panels
                .iter()
                .filter(|(_, e)| {
                    matches!(
                        e.binding().resource,
                        ResourceRef::Document { .. }
                            | ResourceRef::Untitled { .. }
                            | ResourceRef::Terminal { .. }
                            | ResourceRef::Directory { .. }
                            | ResourceRef::Repository { .. }
                            | ResourceRef::Commit { .. }
                            | ResourceRef::Revision { .. }
                            | ResourceRef::Delegation { .. }
                    )
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in old {
                let _ = self.close_panel(&id, false);
            }
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
        self.follow.runs.clear();
        self.follow.preview = None;
        self.forget_arrangements(switched);
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
        if let HostMessage::FollowedRuns { runs } = &message {
            let runs: std::collections::BTreeSet<String> = runs.iter().cloned().collect();
            if runs != self.follow.runs {
                self.follow.runs = runs;
                self.dirty = true;
            }
            return vec![];
        }
        if let HostMessage::WorkspaceChanged {
            workspace,
            environment,
        } = &message
        {
            // The root's own state, not a panel's: panels are told by `settle`.
            if self.workspace.workspace != *workspace || self.workspace.environment != *environment
            {
                // A session list, and the adoption state it carried, describes
                // one workspace at one moment: none is replayed after a change.
                self.retained.sessions.clear();
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
            HostMessage::DocumentLocal { resource, .. } => {
                self.retained.keep_local(resource, &message);
            }
            HostMessage::DocumentRetired { resource } => self.retained.forget_local(resource),
            HostMessage::DocumentMoved { from, .. } => self.retained.forget_local(from),
            HostMessage::ConversationModels {
                resource: resource @ ResourceRef::Conversation { thread, .. },
                conversation_id,
                ..
            } if thread == conversation_id => self.retained.keep_models(resource, &message),
            HostMessage::TerminalSessions { workspace, .. } => {
                self.retained.keep_sessions(workspace, &message);
            }
            HostMessage::ThreadsChanged { .. } => self.retained.threads = Some(message.clone()),
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
            HostMessage::TerminalReport {
                resource,
                epoch,
                report,
            } => return self.on_terminal_report(resource, *epoch, report),
            // Output that arrived first is handed over first.
            HostMessage::TerminalOpened { .. }
            | HostMessage::TerminalExited { .. }
            | HostMessage::TerminalConnectivity { .. }
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
            if let HostMessage::TerminalConnectivity { epoch, .. } = &message
                && self.older_epoch(&id, *epoch)
            {
                self.drop_stale(Stale::OlderEpoch);
                continue;
            }
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
        effects.extend(self.follow_edit(&message));
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

    /// A program's own status report (R32). The program's word, not the
    /// workbench's: it is stored on the session list a chooser reads and handed
    /// to the panes bound to that terminal, and nothing else happens. No effect,
    /// no notice, no focus move, and nothing in it reaches an action, a tab
    /// title or a notice. A stale count is the only trace of a report dropped.
    fn on_terminal_report(
        &mut self,
        resource: &ResourceRef,
        epoch: u64,
        report: &ProgramReport,
    ) -> Vec<Effect> {
        self.keep_report(resource, report);
        let targets = self.bound_to(Some(resource));
        if targets.is_empty() {
            return self.drop_stale(Stale::NotBound);
        }
        for id in targets {
            let bound = self.panels.get(&id).and_then(|e| e.binding().generation);
            if let Some(bound) = bound
                && epoch != bound.0
            {
                self.drop_stale(if epoch < bound.0 {
                    Stale::OlderEpoch
                } else {
                    Stale::ResourceChanged
                });
                continue;
            }
            self.dirty = true;
            self.call(&id, Mode::Silent, |p, cx| {
                p.update(PanelMsg::TerminalReport(report.clone()), cx)
            });
        }
        vec![]
    }

    /// Put the report on the retained session list entry for this terminal and
    /// hand the changed list to the panes that read it, as the host would on
    /// any change to the list.
    fn keep_report(&mut self, resource: &ResourceRef, report: &ProgramReport) {
        let ResourceRef::Terminal { workspace, session } = resource else {
            return;
        };
        let Some((_, HostMessage::TerminalSessions { sessions, .. })) = self
            .retained
            .sessions
            .iter_mut()
            .find(|(w, _)| w == workspace)
        else {
            return;
        };
        let Some(entry) = sessions.iter_mut().find(|s| s.session == *session) else {
            return;
        };
        if !entry.program_report.replaced_by(report) || entry.program_report == *report {
            return;
        }
        entry.program_report = report.clone();
        if *workspace != self.workspace.workspace {
            return;
        }
        let ids: Vec<PanelInstanceId> = self.panels.keys().cloned().collect();
        for id in ids {
            self.replay_sessions(&id);
        }
        self.dirty = true;
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
        | DocumentLocal { resource, .. }
        | TerminalOutput { resource, .. }
        | TerminalReset { resource, .. }
        | TerminalResized { resource, .. }
        | TerminalOpened { resource, .. }
        | TerminalExited { resource, .. }
        | TerminalConnectivity { resource, .. }
        | TerminalReport { resource, .. }
        | TerminalControl { resource, .. } => (Some(resource), None),
        FileChanged { .. }
        | ThemeChanged { .. }
        | CapabilitiesChanged { .. }
        | WorkspaceChanged { .. }
        | AccountChanged { .. }
        | ConnectionChanged { .. }
        | TerminalSessions { .. }
        | ThreadsChanged { .. }
        | FollowedRuns { .. }
        | SearchPage { .. }
        | DiagnosticsSet { .. }
        | DiagnosticsCleared { .. }
        | Resync { .. } => (None, None),
    }
}
