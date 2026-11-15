//! The artifact cabinet as a workbench panel (workbench spec section 12).
//!
//! The panel is the shipping [`Cabinet`] drawn into the panel's body: the same
//! layout, the same cells, the same geometry, and the same React controller
//! (`src/components/cabinet`) laying the same canvases and controls over the
//! rectangles it reports. Nothing here lists artifacts or reads the catalog;
//! the page's controller owns that, and a model call or a terminal process is
//! never started to browse it.
//!
//! The page and the panel meet in a [`CabinetLink`], a shared handle made once
//! by the workbench mount (as Theo's `Directory` is). Going in, it holds the
//! latest `CabinetView` JSON per project, so a panel opened later is handed it
//! at once. Going out, it holds the geometry of the cabinet that was drawn in
//! the last frame, in the workbench grid's cells, and the actions its keys and
//! pointer produced. [`CabinetLink::frame_end`] reports an empty geometry on a
//! frame that drew the workbench but no cabinet (its tab is hidden, its drawer
//! is closed, the panel was closed), so no canvas stays over another panel.

// Until the workbench mount registers the panel and calls the link, only the
// tests reach it.
#![allow(dead_code)]

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::{Rc, Weak},
};

use keybinds::{Key, KeyInput, Mods};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    widgets::{Block, Widget},
};
use ratzilla::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};
use theorem_workbench_core::{
    Ctx, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, ResourceRef, ViewCtx,
    semantics::{Node, Role},
    stale::Binding,
};

use crate::{
    Drawn,
    cabinet::{Area, Cabinet, Canvas, Geometry, View},
    palette,
};

/// The registry's kind for the panel.
const KIND: &str = "cabinet";

/// Below this the cabinet's header and a card cannot both be drawn: the body
/// is a background and nothing is reported, so no control floats over it.
const MIN_COLUMNS: u16 = 12;
const MIN_ROWS: u16 = 6;

/// The most actions held for the page between two reads. The page drains them
/// on every frame it is mounted; a page that is gone does not grow them.
const MAX_ACTIONS: usize = 256;

/// What the page last said for a project.
struct Held {
    version: u64,
    json: Rc<str>,
}

/// What a cabinet drew in the current frame, in the panel's own cells.
struct Report {
    panel: String,
    project: Option<String>,
    focused: bool,
    geometry: Geometry,
    view: Echo,
    cabinet: Weak<RefCell<Cabinet>>,
}

/// The controller-owned fields the panel holds, so a page that mounts after a
/// layout was restored starts from them.
#[derive(Clone, Debug, PartialEq)]
struct Echo {
    filter: String,
    query: String,
    expanded: bool,
}

/// What the page last read: which panel, which project, and where its
/// rectangles are, or nothing.
#[derive(Default)]
struct Published {
    epoch: u64,
    panel: String,
    project: Option<String>,
    geometry: Option<Geometry>,
    view: Option<Echo>,
    cabinet: Weak<RefCell<Cabinet>>,
}

#[derive(Default)]
struct Shared {
    views: BTreeMap<String, Held>,
    versions: u64,
    /// The project of the latest view the page set: the one a panel without a
    /// project of its own shows.
    current: Option<String>,
    frame: Option<Report>,
    published: Published,
    actions: Vec<Value>,
}

/// The shared handle between the page (through the workbench handle) and the
/// cabinet panels. Cloning shares it.
#[derive(Clone, Default)]
pub(crate) struct CabinetLink(Rc<RefCell<Shared>>);

impl CabinetLink {
    /// The page's view for `project` (JSON of the controller's `CabinetView`).
    /// Held, and given to every cabinet panel showing the project, now or
    /// later. A view the cabinet cannot read is refused whole.
    pub(crate) fn set_view(&self, project: &str, json: &str) -> Result<(), String> {
        serde_json::from_str::<View>(json).map_err(|e| e.to_string())?;
        let mut shared = self.0.borrow_mut();
        shared.current = Some(project.to_owned());
        // The page sets its view on every render; an unchanged one is not news.
        if shared.views.get(project).is_some_and(|h| *h.json == *json) {
            return Ok(());
        }
        shared.versions += 1;
        let held = Held {
            version: shared.versions,
            json: Rc::from(json),
        };
        shared.views.insert(project.to_owned(), held);
        Ok(())
    }

    /// What the page should lay over the workbench grid, as JSON, or `None`
    /// when `since` is already the latest epoch. `geometry` is null when no
    /// cabinet is on screen. Cells are the workbench grid's.
    pub(crate) fn geometry_json(&self, since: u64) -> Option<String> {
        let shared = self.0.borrow();
        let published = &shared.published;
        (published.epoch != since).then(|| {
            json!({
                "epoch": published.epoch,
                "panel": published.panel,
                "project": published.project,
                "view": published.view.as_ref().map(|v| json!({
                    "filter": v.filter, "query": v.query, "expanded": v.expanded,
                })),
                "geometry": published.geometry,
            })
            .to_string()
        })
    }

    /// The actions the cabinet's keys and pointer produced since the last
    /// call, as a JSON array of the same objects the mounted cabinet gives
    /// `on_action`: `{type: "select", key}` and `{type: "open", key, revision}`.
    pub(crate) fn take_actions(&self) -> String {
        let actions = std::mem::take(&mut self.0.borrow_mut().actions);
        Value::Array(actions).to_string()
    }

    /// A command from the page's own controls, applied to the cabinet that is
    /// on screen, as the mounted cabinet's handle does: `{type: "select",
    /// key}` (a card took focus), `{type: "scroll", rows}` and `{type: "key",
    /// key, ctrl?, alt?, shift?}` with a `KeyboardEvent.key` name. Returns
    /// whether the cabinet used it (a key it used is the page's to prevent).
    pub(crate) fn command(&self, json: &str) -> bool {
        let Ok(command) = serde_json::from_str::<Value>(json) else {
            return false;
        };
        let Some(cabinet) = self.0.borrow().published.cabinet.upgrade() else {
            return false;
        };
        let mut cabinet = cabinet.borrow_mut();
        match command["type"].as_str() {
            Some("select") => {
                let key = command["key"].as_str().unwrap_or_default();
                if let Some(index) = cabinet.view.entries.iter().position(|e| e.key == key) {
                    cabinet.select(index);
                }
                true
            }
            Some("scroll") => {
                cabinet.scroll_by(command["rows"].as_i64().unwrap_or(0) as i32);
                true
            }
            Some("key") => {
                let flag = |name: &str| command[name].as_bool().unwrap_or(false);
                let Some(code) = command["key"].as_str().and_then(code_of_name) else {
                    return false;
                };
                let event = KeyEvent {
                    code,
                    ctrl: flag("ctrl"),
                    alt: flag("alt"),
                    shift: flag("shift"),
                };
                let (handled, action) = cabinet.key(event);
                drop(cabinet);
                self.push(action);
                handled
            }
            _ => false,
        }
    }

    /// Called by the mount after each frame it drew the workbench, so a
    /// cabinet that was not drawn in it is reported gone. Publishes a new
    /// epoch when what the page should show changed.
    pub(crate) fn frame_end(&self) {
        let mut shared = self.0.borrow_mut();
        let drawn = shared.frame.take();
        let published = &mut shared.published;
        match drawn {
            Some(report) => {
                let moved = published.panel != report.panel
                    || published.project != report.project
                    || published.geometry.as_ref() != Some(&report.geometry);
                published.view = Some(report.view);
                published.cabinet = report.cabinet;
                if moved {
                    published.epoch += 1;
                    published.panel = report.panel;
                    published.project = report.project;
                    published.geometry = Some(report.geometry);
                }
            }
            None if published.geometry.is_some() => {
                published.epoch += 1;
                *published = Published {
                    epoch: published.epoch,
                    ..Published::default()
                };
            }
            None => {}
        }
    }

    fn push(&self, action: Option<Value>) {
        let Some(action) = action else { return };
        let mut shared = self.0.borrow_mut();
        if shared.actions.len() < MAX_ACTIONS {
            shared.actions.push(action);
        }
    }

    fn current(&self) -> Option<String> {
        self.0.borrow().current.clone()
    }

    fn held(&self, project: &str) -> Option<(u64, Rc<str>)> {
        let shared = self.0.borrow();
        let held = shared.views.get(project)?;
        Some((held.version, held.json.clone()))
    }

    /// One cabinet's frame. Of several, the focused one is the one the page
    /// shows; otherwise the first drawn.
    fn report(&self, report: Report) {
        let mut shared = self.0.borrow_mut();
        let replace = shared
            .frame
            .as_ref()
            .is_none_or(|held| report.focused && !held.focused);
        if replace {
            shared.frame = Some(report);
        }
    }
}

/// A `KeyboardEvent.key` name the cabinet reads.
fn code_of_name(name: &str) -> Option<KeyCode> {
    Some(match name {
        "ArrowUp" => KeyCode::Up,
        "ArrowDown" => KeyCode::Down,
        "ArrowLeft" => KeyCode::Left,
        "ArrowRight" => KeyCode::Right,
        "Home" => KeyCode::Home,
        "End" => KeyCode::End,
        "PageUp" => KeyCode::PageUp,
        "PageDown" => KeyCode::PageDown,
        "Enter" => KeyCode::Enter,
        _ => return None,
    })
}

/// A workbench key as the cabinet reads it: the keys it uses, and nothing else.
fn event_of(input: &KeyInput) -> Option<KeyEvent> {
    let code = match input.key() {
        Key::Enter => KeyCode::Enter,
        Key::Left => KeyCode::Left,
        Key::Right => KeyCode::Right,
        Key::Up => KeyCode::Up,
        Key::Down => KeyCode::Down,
        Key::Home => KeyCode::Home,
        Key::End => KeyCode::End,
        Key::PageUp => KeyCode::PageUp,
        Key::PageDown => KeyCode::PageDown,
        _ => return None,
    };
    let mods = input.mods();
    Some(KeyEvent {
        code,
        ctrl: mods.contains(Mods::CTRL),
        alt: mods.contains(Mods::ALT),
        shift: mods.contains(Mods::SHIFT),
    })
}

/// `area` moved by `(dx, dy)` and cut to `bound`; `None` when nothing is left.
fn placed(area: Area, (dx, dy): (i32, i32), bound: Rect) -> Option<Area> {
    let left = (area.x + dx).max(i32::from(bound.x));
    let top = (area.y + dy).max(i32::from(bound.y));
    let right = (area.x + dx + i32::from(area.w)).min(i32::from(bound.right()));
    let bottom = (area.y + dy + i32::from(area.h)).min(i32::from(bound.bottom()));
    (right > left && bottom > top).then(|| Area {
        x: left,
        y: top,
        w: (right - left) as u16,
        h: (bottom - top) as u16,
    })
}

/// `area` moved by `(dx, dy)`, uncut: a card scrolled above the gallery keeps
/// its signed row.
fn shifted(area: Area, (dx, dy): (i32, i32)) -> Area {
    Area {
        x: area.x + dx,
        y: area.y + dy,
        ..area
    }
}

/// The cabinet's geometry, which is in cells from its body's corner, in the
/// workbench grid's cells: every rectangle moved by the body's position, the
/// gallery clip and the controls cut to the body. Slots keep their whole
/// rectangles (they are drawn through the clip, as in the mounted cabinet).
fn in_grid(geometry: &Geometry, body: Rect) -> Geometry {
    let by = (i32::from(body.x), i32::from(body.y));
    let mut out = geometry.clone();
    out.clip = placed(geometry.clip, by, body).unwrap_or_default();
    for slot in &mut out.slots {
        slot.preview = shifted(slot.preview, by);
        slot.card = shifted(slot.card, by);
    }
    out.controls = geometry
        .controls
        .iter()
        .filter_map(|control| {
            let mut control = control.clone();
            control.area = placed(control.area, by, body)?;
            Some(control)
        })
        .collect();
    out
}

pub(crate) struct CabinetPanel {
    link: CabinetLink,
    cabinet: Rc<RefCell<Cabinet>>,
    /// The instance id the root gave this panel, learned from its first
    /// message (a body is always measured before it is drawn).
    id: RefCell<String>,
    /// The project saved in the layout: shown only while the page has named none.
    saved_project: Option<String>,
    /// The version of the page's view this cabinet holds.
    seen: Cell<u64>,
    /// A selection restored from the layout, applied once its card arrives.
    restore_selected: RefCell<Option<String>>,
    focused: Cell<bool>,
    /// Where the body was last drawn, in grid cells.
    area: Cell<Rect>,
    scratch: RefCell<Buffer>,
}

impl CabinetPanel {
    fn new(link: CabinetLink, state: &Value) -> Self {
        let mut cabinet = Cabinet::detached();
        cabinet.restore(
            state["scroll"].as_u64().and_then(|n| u16::try_from(n).ok()),
            state["filter"].as_str().unwrap_or_default(),
            state["query"].as_str().unwrap_or_default(),
            state["expanded"].as_bool().unwrap_or(false),
        );
        Self {
            link,
            cabinet: Rc::new(RefCell::new(cabinet)),
            id: RefCell::new(String::new()),
            saved_project: state["project"].as_str().map(str::to_owned),
            seen: Cell::new(0),
            restore_selected: RefCell::new(state["selected"].as_str().map(str::to_owned)),
            focused: Cell::new(false),
            area: Cell::new(Rect::default()),
            scratch: RefCell::new(Buffer::empty(Rect::default())),
        }
    }

    /// The project shown: the page's current one, else the one saved.
    fn project(&self) -> Option<String> {
        self.link.current().or_else(|| self.saved_project.clone())
    }

    /// Takes the page's latest view for the project, once per change.
    fn catch_up(&self) {
        let Some((version, json)) = self.project().and_then(|p| self.link.held(&p)) else {
            return;
        };
        if version == self.seen.get() {
            return;
        }
        self.seen.set(version);
        let mut cabinet = self.cabinet.borrow_mut();
        // A view that was refused when it was set never gets here.
        if cabinet.set_view(&json).is_err() {
            return;
        }
        let mut restore = self.restore_selected.borrow_mut();
        if let Some(index) = restore
            .as_deref()
            .and_then(|key| cabinet.view.entries.iter().position(|e| e.key == key))
        {
            cabinet.selected = Some(cabinet.view.entries[index].key.clone());
            *restore = None;
        }
    }

    fn pointer(&mut self, p: PanelPointer) {
        match p.kind {
            PointerKind::Wheel { dy, .. } => self.cabinet.borrow_mut().scroll_by(i32::from(dy)),
            PointerKind::Down(theorem_workbench_core::Button::Left) => {
                let (x, y) = (p.x, p.y);
                let mut cabinet = self.cabinet.borrow_mut();
                // A card under the press, within the gallery: the same two
                // things the card's own button does on a click.
                let hit = cabinet.geometry.as_ref().and_then(|g| {
                    let clip = g.clip;
                    let inside = |a: Area| {
                        x >= a.x && x < a.x + i32::from(a.w) && y >= a.y && y < a.y + i32::from(a.h)
                    };
                    inside(clip)
                        .then(|| g.slots.iter().find(|s| inside(s.card)))
                        .flatten()
                        .map(|s| s.index)
                });
                let Some(index) = hit else { return };
                cabinet.select(index);
                let entry = &cabinet.view.entries[index];
                let open = json!({"type": "open", "key": entry.key, "revision": entry.revision});
                drop(cabinet);
                self.link.push(Some(open));
            }
            _ => {}
        }
    }
}

impl Panel for CabinetPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        match msg {
            PanelMsg::Resize { metrics, .. } => {
                *self.id.borrow_mut() = cx.panel().0.clone();
                self.cabinet
                    .borrow_mut()
                    .set_cell((metrics.width_px, metrics.height_px));
            }
            PanelMsg::Key(input) => {
                if let Some(event) = event_of(&input) {
                    let (_, action) = self.cabinet.borrow_mut().key(event);
                    self.link.push(action);
                }
            }
            PanelMsg::Pointer(p) => self.pointer(p),
            PanelMsg::Focus(focused) => self.focused.set(focused),
            _ => {}
        }
        self.catch_up();
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.area.set(area);
        self.focused.set(cx.focused);
        self.catch_up();
        let area = area.intersection(buf.area);
        if area.width < MIN_COLUMNS || area.height < MIN_ROWS {
            let p = palette();
            Block::new()
                .style(Style::new().bg(p.bg).fg(p.ink))
                .render(area, buf);
            return;
        }
        // The cabinet lays out from its own corner, as it does in a window of
        // its own, so it draws into a buffer of the body's size and the cells
        // are copied into place.
        let local = Rect::new(0, 0, area.width, area.height);
        let mut scratch = self.scratch.borrow_mut();
        if scratch.area == local {
            scratch.reset();
        } else {
            *scratch = Buffer::empty(local);
        }
        let (geometry, echo) = {
            let mut cabinet = self.cabinet.borrow_mut();
            let geometry = cabinet.layout_and_draw_in(&mut Canvas(&mut scratch));
            // What the pointer is hit-tested against.
            cabinet.geometry = Some(geometry.clone());
            let echo = Echo {
                filter: cabinet.view.filter.clone(),
                query: cabinet.view.query.clone(),
                expanded: cabinet.view.expanded,
            };
            (geometry, echo)
        };
        for y in 0..area.height {
            for x in 0..area.width {
                buf[(area.x + x, area.y + y)] = scratch[(x, y)].clone();
            }
        }
        drop(scratch);
        self.link.report(Report {
            panel: self.id.borrow().clone(),
            project: self.project(),
            focused: cx.focused,
            geometry: in_grid(&geometry, area),
            view: echo,
            cabinet: Rc::downgrade(&self.cabinet),
        });
    }

    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        // The page's own controls over the drawn cards are the accessible
        // gallery (search, filters, one button per card); the panel is the
        // landmark that holds them.
        let mut root = Node::new("cabinet", Role::Region, "Artifacts", area);
        if let Some(project) = self.project() {
            root.binding = ResourceRef::Project { project };
        }
        vec![root]
    }

    fn serialize(&self) -> Value {
        let cabinet = self.cabinet.borrow();
        let pending = self.restore_selected.borrow().clone();
        json!({
            "project": self.project(),
            "selected": cabinet.selected.clone().or(pending),
            "scroll": cabinet.scroll,
            "filter": cabinet.view.filter,
            "query": cabinet.view.query,
            "expanded": cabinet.view.expanded,
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: ResourceRef::Project {
                project: self.project()?,
            },
            revision: None,
            generation: None,
        })
    }
}

/// Register the Artifacts panel. `link` is the mount's.
pub(crate) fn register(factories: &mut PanelFactories, link: &CabinetLink) {
    let link = link.clone();
    factories.register(KIND, move |state, _| {
        Box::new(CabinetPanel::new(link.clone(), state))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratzilla::event::KeyCode as Code;
    use theorem_workbench_core::{
        Actor, Button, Msg, Pointer, Theme, builtin,
        ids::{ActionId, WorkspaceIdentity},
        keys::{KeyTable, Overrides, Platform},
        registry::Capabilities,
        update,
    };
    use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

    const CELL: (f32, f32) = (7.5, 18.75);

    fn view() -> Value {
        json!({
            "title": "Gallery",
            "scope": "Headland survey · every session · newest first",
            "count": "03 objects",
            "preferenceLabel": "Default",
            "filters": [
                {"id": "all", "label": "All"},
                {"id": "docs", "label": "Docs"}
            ],
            "filter": "all",
            "query": "",
            "targetPx": 24,
            "entries": [
                {"key": "a", "revision": "1", "title": "headland-at-dusk.png", "meta": "Image", "description": "At dusk.", "state": "ready"},
                {"key": "b", "revision": "2", "title": "field-notes.md", "meta": "Document", "description": "Notes.", "state": "ready"},
                {"key": "c", "revision": "3", "title": "survey.md", "meta": "Document", "description": "Survey.", "state": "ready"}
            ]
        })
    }

    /// `view` with `count` cards, enough to scroll.
    fn many(count: usize) -> Value {
        let mut tall = view();
        tall["entries"] = json!(
            (0..count)
                .map(|i| json!({
                    "key": format!("k{i}"), "revision": "1", "title": format!("t{i}"),
                    "meta": "Image", "description": "d", "state": "ready"
                }))
                .collect::<Vec<_>>()
        );
        tall
    }

    fn rows(buf: &Buffer, area: Rect) -> Vec<String> {
        (area.y..area.bottom())
            .map(|y| {
                (area.x..area.right())
                    .map(|x| buf[(x, y)].symbol().to_owned())
                    .collect()
            })
            .collect()
    }

    /// The mounted cabinet's cells for `view` at `width` by `height`.
    fn standalone(view: &Value, width: u16, height: u16) -> (Vec<String>, Geometry) {
        let mut cabinet = Cabinet::detached();
        cabinet.set_cell(CELL);
        cabinet.set_view(&view.to_string()).unwrap();
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        let mut geometry = None;
        terminal
            .draw(|frame| {
                geometry = Some(cabinet.layout_and_draw_in(&mut Canvas(frame.buffer_mut())))
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        (rows(buffer, buffer.area), geometry.unwrap())
    }

    fn draw_panel(panel: &CabinetPanel, grid: Rect, body: Rect) -> Buffer {
        let theme = Theme::plain();
        let workspace = WorkspaceIdentity::default();
        let mut buf = Buffer::empty(grid);
        panel.view(body, &mut buf, &ViewCtx::new(&theme, &workspace));
        buf
    }

    fn panel(link: &CabinetLink, state: Value) -> CabinetPanel {
        let panel = CabinetPanel::new(link.clone(), &state);
        panel.cabinet.borrow_mut().set_cell(CELL);
        *panel.id.borrow_mut() = "p1".into();
        panel
    }

    #[test]
    fn the_panel_draws_the_cells_of_the_mounted_cabinet() {
        let link = CabinetLink::default();
        link.set_view("p", &view().to_string()).unwrap();
        let panel = panel(&link, json!({"project": "p"}));
        let (expected, _) = standalone(&view(), 60, 53);
        // Drawn away from the grid's corner, in a larger grid.
        let body = Rect::new(7, 4, 60, 53);
        let buf = draw_panel(&panel, Rect::new(0, 0, 100, 70), body);
        assert_eq!(rows(&buf, body), expected);
        // Nothing outside the body was touched.
        assert_eq!(buf[(6, 4)].symbol(), " ");
        assert_eq!(buf[(7, 3)].symbol(), " ");
    }

    #[test]
    fn geometry_is_offset_by_the_body_and_clipped_to_it() {
        let link = CabinetLink::default();
        link.set_view("p", &view().to_string()).unwrap();
        let panel = panel(&link, json!({"project": "p"}));
        let (_, local) = standalone(&view(), 60, 53);
        let body = Rect::new(7, 4, 60, 53);
        draw_panel(&panel, Rect::new(0, 0, 100, 70), body);
        link.frame_end();
        let published: Value = serde_json::from_str(&link.geometry_json(0).unwrap()).unwrap();
        assert_eq!(published["epoch"], 1);
        assert_eq!(published["project"], "p");
        let moved = &published["geometry"];
        let first = &local.slots[0];
        assert_eq!(moved["slots"][0]["key"], "a");
        assert_eq!(moved["slots"][0]["preview"]["x"], first.preview.x + 7);
        assert_eq!(moved["slots"][0]["preview"]["y"], first.preview.y + 4);
        assert_eq!(moved["slots"][0]["card"]["x"], first.card.x + 7);
        assert_eq!(moved["clip"]["x"], local.clip.x + 7);
        assert_eq!(moved["clip"]["y"], local.clip.y + 4);
        assert_eq!(
            moved["controls"].as_array().unwrap().len(),
            local.controls.len()
        );
        assert_eq!(moved["controls"][0]["id"], "search");
        assert_eq!(
            moved["controls"][0]["area"]["x"],
            local.controls[0].area.x + 7
        );
        // Every reported cell lies inside the body.
        let inside = |a: &Value| {
            a["x"].as_i64().unwrap() >= 7
                && a["y"].as_i64().unwrap() >= 4
                && a["x"].as_i64().unwrap() + a["w"].as_i64().unwrap() <= 67
                && a["y"].as_i64().unwrap() + a["h"].as_i64().unwrap() <= 57
        };
        assert!(inside(&moved["clip"]));
        assert!(
            moved["controls"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| inside(&c["area"]))
        );
        // Nothing changed: the same epoch, so the page has nothing new to read.
        draw_panel(&panel, Rect::new(0, 0, 100, 70), body);
        link.frame_end();
        assert_eq!(link.geometry_json(1), None);
    }

    #[test]
    fn a_control_the_body_cuts_off_is_not_reported() {
        let local = standalone(&view(), 60, 53).1;
        let body = Rect::new(0, 0, 60, 3);
        let cut = in_grid(&local, body);
        assert!(cut.controls.len() < local.controls.len());
        assert!(
            cut.controls
                .iter()
                .all(|c| c.area.y + i32::from(c.area.h) <= 3)
        );
    }

    #[test]
    fn geometry_goes_empty_with_a_new_epoch_when_the_panel_is_not_drawn() {
        let link = CabinetLink::default();
        link.set_view("p", &view().to_string()).unwrap();
        let panel = panel(&link, json!({"project": "p"}));
        let (grid, body) = (Rect::new(0, 0, 100, 70), Rect::new(7, 4, 60, 53));
        draw_panel(&panel, grid, body);
        link.frame_end();
        assert!(!link.geometry_json(0).unwrap().contains("\"geometry\":null"));
        // A frame in which the workbench drew and the cabinet did not.
        link.frame_end();
        let gone: Value = serde_json::from_str(&link.geometry_json(1).unwrap()).unwrap();
        assert_eq!(gone["epoch"], 2);
        assert!(gone["geometry"].is_null());
        // Reported once: later empty frames change nothing.
        link.frame_end();
        assert_eq!(link.geometry_json(2), None);
        // Drawn again, it is back with another epoch.
        draw_panel(&panel, grid, body);
        link.frame_end();
        let back: Value = serde_json::from_str(&link.geometry_json(2).unwrap()).unwrap();
        assert_eq!(back["epoch"], 3);
        assert!(back["geometry"].is_object());
    }

    #[test]
    fn a_body_too_small_for_the_cabinet_reports_nothing() {
        let link = CabinetLink::default();
        let panel = panel(&link, json!({}));
        draw_panel(&panel, Rect::new(0, 0, 40, 20), Rect::new(0, 0, 8, 4));
        link.frame_end();
        assert_eq!(link.geometry_json(0), None);
    }

    #[test]
    fn a_view_set_before_the_panel_exists_reaches_it_and_a_bad_one_is_refused() {
        let link = CabinetLink::default();
        assert!(link.set_view("p", "{\"entries\": 3}").is_err());
        link.set_view("p", &view().to_string()).unwrap();
        // The panel follows the page's project; a later view replaces the earlier one.
        let panel = panel(&link, json!({}));
        let (grid, body) = (Rect::new(0, 0, 80, 60), Rect::new(0, 0, 60, 53));
        let drawn = rows(&draw_panel(&panel, grid, body), body).join("\n");
        assert!(drawn.contains("headland-at-dusk.png"), "{drawn}");
        let mut next = view();
        next["entries"] = json!([]);
        link.set_view("p", &next.to_string()).unwrap();
        let drawn = rows(&draw_panel(&panel, grid, body), body).join("\n");
        assert!(!drawn.contains("headland-at-dusk.png"));
        assert_eq!(
            panel.binding().unwrap().resource,
            ResourceRef::Project {
                project: "p".into()
            }
        );
    }

    #[test]
    fn keys_and_the_wheel_act_on_the_cabinet_and_give_the_mounted_actions() {
        let link = CabinetLink::default();
        link.set_view("p", &many(40).to_string()).unwrap();
        let panel = panel(&link, json!({}));
        let (grid, body) = (Rect::new(0, 0, 80, 60), Rect::new(0, 0, 60, 53));
        draw_panel(&panel, grid, body);
        link.frame_end();
        // The page's own command path.
        let key = |name: &str| link.command(&json!({"type": "key", "key": name}).to_string());
        assert!(key("ArrowRight"));
        assert!(key("Enter"));
        assert!(!key("q"));
        let actions: Value = serde_json::from_str(&link.take_actions()).unwrap();
        // The first arrow from no selection moves to the second card.
        assert_eq!(
            actions,
            json!([
                {"type": "select", "key": "k1"},
                {"type": "open", "key": "k1", "revision": "1"}
            ])
        );
        assert_eq!(link.take_actions(), "[]");
        // The same keys against the mounted cabinet's own `key` give the same actions.
        let mut mounted = Cabinet::detached();
        mounted.set_cell(CELL);
        mounted.set_view(&many(40).to_string()).unwrap();
        let down = |c: &mut Cabinet, code| {
            c.key(KeyEvent {
                code,
                ctrl: false,
                alt: false,
                shift: false,
            })
            .1
        };
        assert_eq!(
            down(&mut mounted, Code::Right),
            Some(json!({"type": "select", "key": "k1"}))
        );
        assert_eq!(
            down(&mut mounted, Code::Enter),
            Some(json!({"type": "open", "key": "k1", "revision": "1"}))
        );
        // Select and scroll from the page's controls.
        assert!(link.command(&json!({"type": "select", "key": "k2"}).to_string()));
        assert_eq!(panel.cabinet.borrow().selected.as_deref(), Some("k2"));
        assert!(link.command(&json!({"type": "scroll", "rows": 4}).to_string()));
        assert!(panel.cabinet.borrow().scroll > 0);
        assert!(!link.command("not json"));
    }

    // The root's own routing: open the Artifacts tool, then press, scroll and type.
    fn opened(link: &CabinetLink) -> (theorem_workbench_core::Model, Rect) {
        let mut factories = PanelFactories::new();
        register(&mut factories, link);
        theorem_workbench_panels::register(&mut factories);
        let registry = builtin::registry();
        let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
        assert!(issues.is_empty(), "{issues:?}");
        let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
        let mut m = theorem_workbench_core::Model::new(
            registry,
            factories,
            keys,
            Capabilities::of(["artifacts"]),
            dock,
        );
        update(
            &mut m,
            Msg::Resize {
                area: Rect::new(0, 0, 160, 60),
                metrics: CellMetrics::new(CELL.0, CELL.1),
            },
        );
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("cabinet.open"),
                actor: Actor::Human,
            },
        );
        let (id, _) = m
            .panel_ids()
            .find(|(_, k)| k.as_str() == KIND)
            .expect("the cabinet opens from its action");
        let id = id.clone();
        let body = m
            .frame()
            .unwrap()
            .groups
            .iter()
            .find(|g| g.active.as_ref().is_some_and(|a| a.0 == id.0))
            .expect("the cabinet's group")
            .body;
        (m, body)
    }

    fn frame(m: &theorem_workbench_core::Model, link: &CabinetLink) {
        let area = Rect::new(0, 0, 160, 60);
        let mut buf = Buffer::empty(area);
        theorem_workbench_core::view(m, area, &mut buf, &Theme::plain());
        link.frame_end();
    }

    #[test]
    fn the_artifacts_tool_opens_without_a_model_call_and_takes_the_pointer_and_keys() {
        let link = CabinetLink::default();
        link.set_view("p", &view().to_string()).unwrap();
        let (mut m, body) = opened(&link);
        // Opening and drawing emit no effect at all.
        let fx = update(&mut m, Msg::Tick);
        assert!(fx.is_empty(), "{fx:?}");
        frame(&m, &link);
        let shown: Value = serde_json::from_str(&link.geometry_json(0).unwrap()).unwrap();
        assert!(shown["panel"].as_str().is_some_and(|p| !p.is_empty()));
        let slots = shown["geometry"]["slots"].as_array().unwrap();
        assert!(!slots.is_empty());
        // A press on a card selects it and asks to open it.
        let card = &slots[1]["card"];
        let at = |v: &Value, k: &str| v[k].as_i64().unwrap() as u16;
        let fx = update(
            &mut m,
            Msg::Pointer(Pointer {
                kind: PointerKind::Down(Button::Left),
                x: at(card, "x") + 2,
                y: at(card, "y") + 2,
                mods: Mods::NONE,
                clicks: 1,
            }),
        );
        assert!(fx.is_empty(), "{fx:?}");
        let actions: Value = serde_json::from_str(&link.take_actions()).unwrap();
        assert_eq!(
            actions,
            json!([{"type": "open", "key": "b", "revision": "2"}])
        );
        frame(&m, &link);
        let after: Value = serde_json::from_str(&link.geometry_json(1).unwrap()).unwrap();
        assert_eq!(after["geometry"]["selected"], "b");
        // A key the workbench leaves to the focused panel moves the selection.
        update(&mut m, Msg::Key(KeyInput::new(Key::Right, Mods::NONE)));
        let actions: Value = serde_json::from_str(&link.take_actions()).unwrap();
        assert_eq!(actions, json!([{"type": "select", "key": "c"}]));
        let _ = body;
    }

    #[test]
    fn the_wheel_over_the_panel_scrolls_the_gallery_and_moves_the_reported_cards() {
        let link = CabinetLink::default();
        link.set_view("p", &many(40).to_string()).unwrap();
        let (mut m, body) = opened(&link);
        frame(&m, &link);
        let before: Value = serde_json::from_str(&link.geometry_json(0).unwrap()).unwrap();
        update(
            &mut m,
            Msg::Pointer(Pointer {
                kind: PointerKind::Wheel { dx: 0, dy: 5 },
                x: body.x + 3,
                y: body.y + 20,
                mods: Mods::NONE,
                clicks: 1,
            }),
        );
        frame(&m, &link);
        let after: Value = serde_json::from_str(&link.geometry_json(1).unwrap()).unwrap();
        assert_eq!(after["epoch"], 2);
        let top = |g: &Value| g["geometry"]["slots"][0]["card"]["y"].as_i64().unwrap();
        assert_eq!(top(&after), top(&before) - 5);
    }

    #[test]
    fn saved_state_restores_selection_scroll_filter_and_query() {
        let link = CabinetLink::default();
        let mut tall = view();
        tall["entries"] =
            json!((0..40)
            .map(|i| json!({"key": format!("k{i}"), "revision": "1", "title": format!("t{i}"),
                "meta": "Image", "description": "d", "state": "ready"}))
            .collect::<Vec<_>>());
        let state = json!({
            "project": "p", "selected": "k30", "scroll": 20,
            "filter": "docs", "query": "headland", "expanded": true
        });
        let panel = panel(&link, state.clone());
        let (grid, body) = (Rect::new(0, 0, 80, 60), Rect::new(0, 0, 60, 53));
        // Before any view: filter, query and expanded are already back.
        assert_eq!(panel.serialize()["filter"], "docs");
        draw_panel(&panel, grid, body);
        link.frame_end();
        let echoed: Value = serde_json::from_str(&link.geometry_json(0).unwrap()).unwrap();
        assert_eq!(
            echoed["view"],
            json!({"filter": "docs", "query": "headland", "expanded": true})
        );
        // The page's view arrives (filter and query as the controller holds them).
        tall["filter"] = "docs".into();
        tall["query"] = "headland".into();
        tall["expanded"] = true.into();
        link.set_view("p", &tall.to_string()).unwrap();
        draw_panel(&panel, grid, body);
        let saved = panel.serialize();
        assert_eq!(saved["selected"], "k30");
        assert_eq!(saved["scroll"], 20);
        assert_eq!(saved["filter"], "docs");
        assert_eq!(saved["query"], "headland");
        assert_eq!(saved["expanded"], true);
        assert_eq!(saved["project"], "p");
        // A panel built from what this one saved holds the same.
        let again = CabinetPanel::new(link.clone(), &saved);
        assert_eq!(again.serialize()["selected"], "k30");
    }

    #[test]
    fn the_semantic_node_is_a_landmark_bound_to_the_project() {
        let link = CabinetLink::default();
        link.set_view("p", &view().to_string()).unwrap();
        let panel = panel(&link, json!({}));
        let theme = Theme::plain();
        let workspace = WorkspaceIdentity::default();
        let nodes = panel.semantics(Rect::new(1, 2, 40, 10), &ViewCtx::new(&theme, &workspace));
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "Artifacts");
        assert_eq!(
            nodes[0].binding,
            ResourceRef::Project {
                project: "p".into()
            }
        );
        assert!(!panel.text_entry());
    }
}
