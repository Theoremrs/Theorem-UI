//! The delegation panel mounted in the workbench.
//!
//! Written for this crate; not translated. It reads what one run's delegation changed
//! and shows each file's before and after. It is read only: the only effects it can
//! emit are the two reads (`delegationChanges`, `delegationContent`), and nothing a key,
//! the pointer or an action does can emit another kind.
//!
//! The panel is bound to the delegation resource it was opened on. Every effect it sends
//! carries that resource, and the file a read is for is held by the panel itself: an
//! answer is applied only if its effect is still the one asked for the file now open, so
//! a late answer for a file the person has left changes nothing.
//!
//! Saved view state is the three ids, the open file's path and the cursor's path. It
//! keeps no text: the first tick after a restore asks the owner again. If the owner says
//! the delegation is gone, the panel says so in words and keeps its ids, so the layout
//! still names what it was; a saved path that is no longer among the changes is said to
//! be gone, and the list shows.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::completion::{Completion, CompletionPayload};
use theorem_workbench_core::effect::{
    DelegationContentRead, DelegationRef, DelegationSide, Effect, EffectBody,
};
use theorem_workbench_core::ids::{ActionId, EffectId, ResourceRef};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Button, Ctx, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, ViewCtx,
};
use theorem_workbench_text::visible::visible;

use super::actions;
use super::model::{File, Read, Side, State, shape};
use super::view::{Layout, Paint, draw, hint_rows, layout, semantics};
use crate::styles::ChangesStyles;

/// The kind the panel registers under.
pub const KIND: &str = "delegation";

/// Registers the panel under its kind, and as what opens a delegation target.
pub fn register(factories: &mut PanelFactories) {
    factories.register(KIND, |state, _version| {
        Box::new(DelegationPanel::restore(state))
    });
    factories.register_opener(KIND, |target| {
        matches!(
            target,
            theorem_workbench_core::OpenTarget::Delegation { .. }
        )
    });
}

/// What an effect in flight was asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Req {
    List,
    Side { path: String, after: bool },
}

/// A page of lines for the page keys.
const PAGE: isize = 10;
/// Far enough to reach either end of the document.
const EDGE: isize = 1_000_000;
/// Lines a wheel step moves.
const WHEEL: isize = 3;

pub struct DelegationPanel {
    state: State,
    area: Rect,
    /// The panel has been laid out with room: until then it reads nothing.
    shown: bool,
    sent: BTreeMap<EffectId, Req>,
    list_scroll: usize,
    file_scroll: usize,
    /// The path the cursor was on when the layout was saved, applied when the list
    /// arrives.
    saved_cursor: Option<String>,
    cache: RefCell<Option<(u64, usize, Rc<Layout>)>>,
}

impl DelegationPanel {
    pub fn restore(state: &Value) -> Self {
        let text = |key: &str| state.get(key).and_then(Value::as_str).unwrap_or("");
        let mut model = State::new(text("runId"), text("delegationId"), text("path"));
        if let Some(file) = state.get("file").and_then(Value::as_str) {
            model.want = Some(file.to_owned());
        }
        let saved_cursor = state
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Self {
            state: model,
            area: Rect::default(),
            shown: false,
            sent: BTreeMap::new(),
            list_scroll: 0,
            file_scroll: 0,
            saved_cursor,
            cache: RefCell::new(None),
        }
    }

    fn resource(&self) -> ResourceRef {
        ResourceRef::Delegation {
            run_id: self.state.run_id.clone(),
            delegation_id: self.state.delegation_id.clone(),
            path: self.state.opened_path.clone(),
        }
    }

    fn lay(&self, width: usize) -> Rc<Layout> {
        let version = self.state.version;
        if let Some((v, w, lay)) = &*self.cache.borrow()
            && *v == version
            && *w == width
        {
            return lay.clone();
        }
        let lay = Rc::new(layout(&self.state, width));
        *self.cache.borrow_mut() = Some((version, width, lay.clone()));
        lay
    }

    fn body_height(&self, lay: &Layout) -> usize {
        self.area
            .height
            .saturating_sub(hint_rows(lay, self.area.height)) as usize
    }

    fn scroll(&self) -> usize {
        if self.state.file.is_some() {
            self.file_scroll
        } else {
            self.list_scroll
        }
    }

    fn set_scroll(&mut self, to: usize) {
        if self.state.file.is_some() {
            self.file_scroll = to;
        } else {
            self.list_scroll = to;
        }
    }

    fn clamp(&mut self) {
        let lay = self.lay(self.area.width as usize);
        let max = lay
            .lines
            .len()
            .saturating_sub(self.body_height(&lay).max(1));
        let at = self.scroll().min(max);
        self.set_scroll(at);
    }

    fn scroll_by(&mut self, delta: isize) {
        let at = self.scroll().saturating_add_signed(delta);
        self.set_scroll(at);
        self.clamp();
    }

    /// Scrolls the list so the cursor's file is on screen.
    fn show_cursor(&mut self) {
        if self.state.file.is_some() {
            return;
        }
        let lay = self.lay(self.area.width as usize);
        let Some((_, range)) = lay.files.get(self.state.cursor) else {
            return;
        };
        let body = self.body_height(&lay).max(1);
        let mut at = self.list_scroll;
        if range.start < at {
            at = range.start;
        } else if range.end > at + body {
            at = (range.end - body).min(range.start);
        }
        self.list_scroll = at;
        self.clamp();
    }

    // ---- reading -----------------------------------------------------------

    fn ask(&mut self, cx: &mut Ctx, body: EffectBody, req: Req) -> Result<(), String> {
        let resource = self.resource();
        match cx.emit(|id| Effect::new(id, resource, body)) {
            Ok(id) => {
                self.sent.insert(id, req);
                Ok(())
            }
            Err(error) => Err(error.to_string()),
        }
    }

    fn ask_list(&mut self, cx: &mut Ctx) {
        let body = EffectBody::DelegationChanges(DelegationRef {
            run_id: self.state.run_id.clone(),
            delegation_id: self.state.delegation_id.clone(),
        });
        self.state.list = match self.ask(cx, body, Req::List) {
            Ok(()) => Read::Loading,
            Err(why) => Read::Failed(format!("the request could not be sent: {why}")),
        };
        self.state.touch();
    }

    fn ask_side(&mut self, cx: &mut Ctx, after: bool) {
        let Some(path) = self.state.file.as_ref().map(|f| f.change.path.clone()) else {
            return;
        };
        let body = EffectBody::DelegationContent(DelegationContentRead {
            run_id: self.state.run_id.clone(),
            delegation_id: self.state.delegation_id.clone(),
            path: path.clone(),
            side: if after {
                DelegationSide::After
            } else {
                DelegationSide::Before
            },
        });
        let read = match self.ask(cx, body, Req::Side { path, after }) {
            Ok(()) => Read::Loading,
            Err(why) => Read::Failed(format!("the request could not be sent: {why}")),
        };
        if let Some(file) = &mut self.state.file {
            *file.side_mut(after) = Side::Text(read);
            file.settle();
        }
        self.state.touch();
    }

    /// Sends the reads that are owed: the list once the panel is shown, and the open
    /// file's sides. Only a tick or an input starts them, never the environment.
    fn pump(&mut self, cx: &mut Ctx) {
        if !self.shown {
            return;
        }
        if matches!(self.state.list, Read::Idle) {
            self.ask_list(cx);
        }
        for after in [false, true] {
            let owed = self
                .state
                .file
                .as_ref()
                .is_some_and(|f| matches!(f.side(after), Side::Text(Read::Idle)));
            if owed {
                self.ask_side(cx, after);
            }
        }
    }

    /// Forgets what is in flight for the open file: an answer to it is dropped.
    fn forget_sides(&mut self) {
        self.sent.retain(|_, req| !matches!(req, Req::Side { .. }));
    }

    fn reload(&mut self) {
        if let Some(file) = &mut self.state.file {
            self.sent.retain(|_, req| !matches!(req, Req::Side { .. }));
            *file = File::new(&file.change.clone());
        } else {
            self.sent.retain(|_, req| *req != Req::List);
            self.state.list = Read::Idle;
        }
        self.state.touch();
    }

    // ---- what the person asks for -------------------------------------------

    fn open_entry(&mut self, at: usize) {
        let Some(change) = self.state.changes().get(at).cloned() else {
            return;
        };
        self.forget_sides();
        self.state.cursor = at;
        self.state.file = Some(File::new(&change));
        self.state.notice = None;
        self.file_scroll = 0;
        self.state.touch();
    }

    fn enter(&mut self) {
        if self.state.file.is_none() {
            self.open_entry(self.state.cursor);
        }
    }

    fn back(&mut self) {
        if self.state.file.is_some() {
            self.forget_sides();
            self.state.file = None;
            self.state.touch();
            self.clamp();
            self.show_cursor();
        }
    }

    fn step(&mut self, delta: isize) {
        if self.state.file.is_some() {
            self.scroll_by(delta);
            return;
        }
        let last = self.state.changes().len().saturating_sub(1);
        self.state.cursor = self.state.cursor.saturating_add_signed(delta).min(last);
        self.show_cursor();
    }

    fn on_key(&mut self, key: KeyInput) {
        if key.mods().intersects(Mods::CTRL | Mods::CMD | Mods::ALT) {
            return;
        }
        match key.key() {
            Key::Esc => self.back(),
            Key::Enter => self.enter(),
            Key::Up | Key::Char('k') => self.step(-1),
            Key::Down | Key::Char('j') => self.step(1),
            Key::PageUp => self.page(-PAGE),
            Key::PageDown => self.page(PAGE),
            Key::Home => self.page(-EDGE),
            Key::End => self.page(EDGE),
            Key::Char('r') => self.reload(),
            _ => {}
        }
    }

    /// A page key: a page of the document in a file, a page of entries in the list.
    fn page(&mut self, delta: isize) {
        if self.state.file.is_some() {
            self.scroll_by(delta);
        } else {
            self.step(delta);
        }
    }

    fn on_action(&mut self, id: &ActionId) {
        match id.as_str() {
            actions::REFRESH => self.reload(),
            actions::OPEN => self.enter(),
            actions::BACK => self.back(),
            actions::NEXT => self.step(1),
            actions::PREVIOUS => self.step(-1),
            _ => {}
        }
    }

    fn on_pointer(&mut self, p: PanelPointer) {
        match p.kind {
            PointerKind::Wheel { dy, .. } => self.scroll_by(isize::from(dy) * WHEEL),
            PointerKind::Down(Button::Left) => {
                if self.state.file.is_some() || p.x < 0 || p.y < 0 {
                    return;
                }
                let lay = self.lay(self.area.width as usize);
                if p.y as usize >= self.body_height(&lay) {
                    return;
                }
                let Some(entry) = lay
                    .lines
                    .get(self.list_scroll + p.y as usize)
                    .and_then(|l| l.entry)
                else {
                    return;
                };
                self.state.cursor = entry;
                if p.clicks >= 2 {
                    self.open_entry(entry);
                }
            }
            _ => {}
        }
    }

    // ---- what the owner answers ----------------------------------------------

    fn on_completion(&mut self, completion: Completion) {
        let Some(req) = self.sent.remove(&completion.effect) else {
            return;
        };
        if completion.outcome.is_access_revoked() {
            // The access itself is gone: nothing that was shown stays.
            self.sent.clear();
            self.state.list = Read::Revoked;
            self.state.unlisted = 0;
            self.state.file = None;
            self.state.touch();
            return;
        }
        match req {
            Req::List => self.on_list(&completion),
            Req::Side { path, after } => self.on_side(&path, after, &completion),
        }
        self.clamp();
    }

    fn on_list(&mut self, completion: &Completion) {
        if let Some(read) = Read::from_outcome(&completion.outcome) {
            self.state.list = read;
            self.state.touch();
            return;
        }
        let Some(CompletionPayload::DelegationChanges(list)) = &completion.payload else {
            self.state.list = Read::Failed("the owner's answer did not hold the changes".into());
            self.state.touch();
            return;
        };
        self.state.set_list(list.changes.clone());
        if let Some(path) = self.saved_cursor.take()
            && let Some(at) = self.state.changes().iter().position(|c| c.path == path)
        {
            self.state.cursor = at;
        }
        if let Some(want) = self.state.want.take() {
            match self.state.changes().iter().position(|c| c.path == want) {
                Some(at) if self.state.file.is_none() => self.open_entry(at),
                Some(_) => {}
                None => {
                    self.state.notice = Some(visible(&format!(
                        "{} is not among the files this delegation changed.",
                        shape(&want)
                    )));
                    self.state.touch();
                }
            }
        }
        if self.state.file.is_none() {
            self.show_cursor();
        }
    }

    fn on_side(&mut self, path: &str, after: bool, completion: &Completion) {
        // Only the read for the file that is open now, and still waiting, is applied.
        let waiting = self.state.file.as_ref().is_some_and(|f| {
            f.change.path == path && matches!(f.side(after), Side::Text(Read::Loading))
        });
        if !waiting {
            return;
        }
        let read = match Read::from_outcome(&completion.outcome) {
            Some(read) => read,
            None => match &completion.payload {
                Some(CompletionPayload::DelegationText(t)) => Read::Ready(t.text.clone()),
                _ => Read::Failed("the owner's answer did not hold the text".into()),
            },
        };
        if let Some(file) = &mut self.state.file {
            *file.side_mut(after) = Side::Text(read);
            file.settle();
        }
        self.state.touch();
    }
}

impl Panel for DelegationPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        // The environment cannot start work: a read is owed and goes on the next tick or
        // input.
        let quiet = matches!(
            msg,
            PanelMsg::Resize { .. }
                | PanelMsg::Focus(_)
                | PanelMsg::Cached(_)
                | PanelMsg::Workspace(_)
                | PanelMsg::Documents(_)
        );
        match msg {
            PanelMsg::Key(key) => self.on_key(key),
            PanelMsg::Pointer(p) => self.on_pointer(p),
            PanelMsg::Resize { area, .. } => {
                self.area = area;
                self.shown = area.width > 0 && area.height > 0;
                self.clamp();
            }
            PanelMsg::Completion(completion) => self.on_completion(completion),
            PanelMsg::Action(id) => self.on_action(&id),
            // A late answer for a delegation this panel is not showing is not shown.
            PanelMsg::Cached(_) => {}
            // There is nothing to type, and nothing else the root says concerns it.
            _ => {}
        }
        if !quiet {
            self.pump(cx);
            self.clamp();
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        let lay = self.lay(area.width as usize);
        let styles = ChangesStyles::from_theme(cx.theme);
        let body = area.height.saturating_sub(hint_rows(&lay, area.height)) as usize;
        let max = lay.lines.len().saturating_sub(body.max(1));
        draw(
            &Paint {
                state: &self.state,
                layout: &lay,
                scroll: self.scroll().min(max),
                focused: cx.focused,
                styles: &styles,
            },
            area,
            buf,
        );
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let lay = self.lay(area.width as usize);
        let styles = ChangesStyles::from_theme(cx.theme);
        let body = area.height.saturating_sub(hint_rows(&lay, area.height)) as usize;
        let max = lay.lines.len().saturating_sub(body.max(1));
        let loading =
            self.state.list.waiting() || self.state.file.as_ref().is_some_and(File::waiting);
        semantics(
            &Paint {
                state: &self.state,
                layout: &lay,
                scroll: self.scroll().min(max),
                focused: cx.focused,
                styles: &styles,
            },
            "delegation",
            area,
            &self.resource(),
            loading,
        )
    }

    fn serialize(&self) -> Value {
        let mut state = json!({
            "runId": self.state.run_id,
            "delegationId": self.state.delegation_id,
            "path": self.state.opened_path,
        });
        if let Some(file) = &self.state.file {
            state["file"] = json!(file.change.path);
        }
        if let Some(change) = self.state.current() {
            state["cursor"] = json!(change.path);
        }
        state
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: None,
            generation: None,
        })
    }

    fn holds_escape(&self) -> bool {
        self.state.file.is_some()
    }
}
