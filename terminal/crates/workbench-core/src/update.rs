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
//! 4. Closing a view detaches. A destroying effect is refused unless a
//!    `Destroy` action is running (R36).

use ratatui::layout::{Direction, Rect};
use serde_json::Value;
use theorem_workbench_dock::{self as dock, GroupId, Hit, OpenAt, Tab};

use crate::completion::{Completion, Outcome};
use crate::effect::Effect;
use crate::host::HostMessage;
use crate::ids::{ActionId, Actor, EffectId, PanelInstanceId, PanelKind, ResourceRef, Revision};
use crate::keys::active_contexts;
use crate::model::{Drag, Entry, Model, Notice, Viewport};
use crate::msg::{DockMsg, Msg, Pointer};
use crate::panel::{Button, Ctx, Mode, Panel, PanelMsg, PanelPointer, PointerKind};
use crate::panels::PICKER_KIND;
use crate::picker::{PickerMsg, PickerOutcome};
use crate::registry::{ActionIntent, Placement, Refusal};
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
        Msg::Resize { area, metrics } => {
            model.viewport = Some(Viewport { area, metrics });
            vec![]
        }
        Msg::Focus(focused) => {
            model.window_focused = focused;
            vec![]
        }
        Msg::Host(message) => model.on_host(message),
        Msg::Completion(completion) => model.on_completion(completion),
        Msg::Action { id, actor } => model.run_action(id, actor),
        Msg::Picker(msg) => model.picker_msg(msg),
        Msg::Dock(msg) => model.on_dock(msg),
        Msg::Tick => model.on_tick(),
    };
    model.settle();
    if !tick {
        model.dirty = true;
    }
    effects
}

/// What a call into a panel left behind.
pub(crate) struct CtxOut {
    pub(crate) effects: Vec<Effect>,
    pub(crate) close: bool,
    pub(crate) invalidated: bool,
}

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
            effects: vec![],
            close: false,
            invalidated: false,
        };
        f(&mut cx);
        CtxOut {
            effects: cx.effects,
            close: cx.close,
            invalidated: cx.invalidated,
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
        let mut effects = out.effects;
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

    // --- keys and text ---

    pub(crate) fn on_key(&mut self, key: KeyInput) -> Vec<Effect> {
        if self.picker.is_open() {
            return self.picker_key(key);
        }
        let owner = self.focus_owner();
        let (kind, text_entry) = match owner.as_ref().and_then(|id| self.panels.get(id)) {
            Some(e) => (Some(e.kind.clone()), e.panel.text_entry()),
            None => (None, false),
        };
        let contexts = active_contexts(kind.as_ref(), text_entry);
        if let Some(action) = self.keys.resolve(&key, &contexts).cloned() {
            return self.run_action(action, Actor::Human);
        }
        match owner {
            Some(id) => self.send(&id, PanelMsg::Key(key)),
            None => vec![],
        }
    }

    fn picker_key(&mut self, key: KeyInput) -> Vec<Effect> {
        let msg = match key.key() {
            Key::Esc => PickerMsg::Back,
            Key::Enter => PickerMsg::Choose,
            Key::Down => PickerMsg::Next,
            Key::Up => PickerMsg::Prev,
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
        if self.picker.is_open() {
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

    pub(crate) fn on_tick(&mut self) -> Vec<Effect> {
        let ids: Vec<PanelInstanceId> = self.panels.keys().cloned().collect();
        ids.iter()
            .flat_map(|id| self.send(id, PanelMsg::Tick))
            .collect()
    }

    // --- actions and the picker ---

    pub(crate) fn run_action(&mut self, id: ActionId, actor: Actor) -> Vec<Effect> {
        let (kind, intent) = match self.registry.resolve(&id, &actor, &self.caps) {
            Ok(r) => (r.panel.kind.clone(), r.action.intent),
            Err(refusal) => {
                self.notice = Some(Notice::Refused(refusal));
                return vec![];
            }
        };
        if kind.as_str() == PICKER_KIND {
            return self.picker_msg(PickerMsg::Open);
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
            ActionIntent::Create | ActionIntent::Start | ActionIntent::Destroy => {
                let Some(target) = self.target_of_kind(&kind) else {
                    self.notice = Some(Notice::NoPanel(id));
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
        let desc = self.registry.get(kind)?;
        let (title, version, placement) =
            (desc.title.clone(), desc.version, desc.default_placement);
        let role = match placement {
            Placement::Left => dock::Role::Files,
            Placement::Main => dock::Role::Main,
            Placement::Tools => dock::Role::Tools,
        };
        let (panel, available) = self.build_panel(kind, version, &Value::Null);
        let id = self.mint_panel();
        let mut tab = Tab::new(
            id.as_str(),
            dock::PanelKind::new(kind.as_str(), version),
            &title,
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
                    },
                );
                Some(id)
            }
            Err(e) => {
                self.notice = Some(Notice::Dock(e));
                None
            }
        }
    }

    pub(crate) fn picker_msg(&mut self, msg: PickerMsg) -> Vec<Effect> {
        let opening = msg == PickerMsg::Open;
        let outcome = self
            .picker
            .update(msg, &self.registry, &self.caps, &self.pinned);
        if opening {
            self.show_picker_panel();
        }
        match outcome {
            PickerOutcome::Nothing => vec![],
            PickerOutcome::Closed => {
                self.close_picker_panels();
                vec![]
            }
            PickerOutcome::Unavailable { reason } => {
                self.notice = Some(Notice::Refused(Refusal::Unavailable { reason }));
                vec![]
            }
            PickerOutcome::Chosen(action) => {
                // The chosen tool takes the picker's place.
                let effects = self.run_action(action, Actor::Human);
                self.close_picker_panels();
                effects
            }
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
        let notice = self.notice.take();
        for id in ids {
            self.close_panel(&id, false);
        }
        self.notice = notice;
    }

    // --- closing ---

    /// Close a view. The panel's own `teardown` decides what its lifetime rule
    /// needs; `destroy` is true only while a `Destroy` action runs, and without
    /// it a destroying effect is refused (R36).
    pub(crate) fn close_panel(&mut self, id: &PanelInstanceId, destroy: bool) -> Vec<Effect> {
        if let Err(e) = self.dock.close_tab(&Self::dock_id(id)) {
            self.notice = Some(Notice::Dock(e));
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
        self.dirty = true;
        out.effects
    }

    // --- the dock ---

    fn dock_result<T>(&mut self, result: Result<T, dock::DockError>) {
        if let Err(e) = result {
            self.notice = Some(Notice::Dock(e));
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
                let r = self.dock.open_drawer(g);
                self.dock_result(r);
            }
            DockMsg::CloseDrawer => self.dock.close_drawer(),
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
                    self.drag = Some(Drag { path, axis, grab });
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
        self.send(
            id,
            PanelMsg::Pointer(PanelPointer {
                kind: p.kind,
                x: i32::from(p.x) - i32::from(body.x),
                y: i32::from(p.y) - i32::from(body.y),
                mods: p.mods,
            }),
        )
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

    pub(crate) fn on_host(&mut self, message: HostMessage) -> Vec<Effect> {
        if let HostMessage::CapabilitiesChanged { capabilities } = &message {
            self.caps = capabilities.clone();
        }
        let (resource, revision) = host_route(&message);
        let targets: Vec<PanelInstanceId> = self
            .panels
            .iter()
            .filter(|(_, e)| match resource {
                Some(r) => e.binding().resource == *r,
                None => true,
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = vec![];
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
        ConversationSnapshot {
            resource, revision, ..
        } => (Some(resource), revision.clone()),
        DocumentMoved { from, .. } => (Some(from), None),
        DocumentRetired { resource }
        | TerminalOutput { resource, .. }
        | TerminalOpened { resource, .. }
        | TerminalExited { resource, .. }
        | TerminalControl { resource, .. } => (Some(resource), None),
        FileChanged { .. }
        | ThemeChanged { .. }
        | CapabilitiesChanged { .. }
        | ConnectionChanged { .. }
        | Resync { .. } => (None, None),
    }
}
