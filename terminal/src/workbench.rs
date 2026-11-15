//! The Theo Web workbench mount (ARCHITECTURE sections 4, 8 and 9): the
//! interaction core of `theorem-workbench-core` drawn on Ratzilla's DOM
//! backend, driven by the React `Workbench` component through
//! `WorkbenchHandle`.
//!
//! Everything that decides something is plain Rust in [`Core`] and the free
//! functions below it, so the key conversion, the pointer-to-cell mapping and
//! the frame policy are tested on the host. The wasm-bindgen layer only moves
//! JSON and DOM events across.
//!
//! Effects and semantic updates reach JavaScript only after every borrow of the
//! core has ended, because the adapter may answer an effect by calling
//! `dispatch` in the same tick.

use std::{cell::RefCell, rc::Rc, str::FromStr};

use keybinds::{Key, KeyInput, Mods};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
};
use ratzilla::web_sys::{self, KeyboardEvent};
use serde::Deserialize;
use serde_json::{Value, json};
use theorem_workbench_core::{
    ActionId, Actor, Button, Capability, Effect, Inbound, Model, Msg, PanelFactories, Pointer,
    PointerKind, Theme, builtin,
    keys::{KeyIssue, KeyTable, Overrides, Platform, active_contexts},
    registry::Capabilities,
    semantics,
    semantics::{Publish, SemanticPublisher},
    update, view,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use wasm_bindgen::prelude::*;

use crate::{
    Drawn, Palette, Screen, palette, run_frames,
    theo::{self, Directory},
};

/// Where other crates' panels are registered as they land. The picker's panel
/// and the placeholder for a kind this build cannot serve belong to the core
/// itself; the panels crate adds Files, whose opening and workspace identity go
/// through the core.
fn factories(conversations: &Directory) -> PanelFactories {
    let mut factories = PanelFactories::new();
    theorem_workbench_panels::register(&mut factories);
    theo::register(&mut factories, conversations);
    factories
}

/// The core's style roles from the terminal's palette roles, so the workbench
/// changes with the workspace's theme exactly as the agent terminal does. The
/// state and diff roles take the palette field of the same name: a diff line is
/// text on the line's tint, changed words on the stronger one.
fn theme_of(p: &Palette) -> Theme {
    let on = |bg| Style::new().fg(p.ink).bg(bg);
    Theme::chrome(
        Style::new().fg(p.ink).bg(p.bg),
        Style::new().fg(p.ink),
        Style::new().fg(p.muted),
        Style::new().fg(p.line),
        Style::new()
            .fg(p.bg)
            .bg(p.focus)
            .add_modifier(Modifier::BOLD),
        Style::new().fg(p.bright).bg(p.selection),
    )
    .with_state(
        Style::new().fg(p.error),
        Style::new().fg(p.warning),
        Style::new().fg(p.success),
    )
    .with_diff(
        on(p.added_line),
        on(p.removed_line),
        on(p.added_words),
        on(p.removed_words),
    )
}

// --- key conversion -----------------------------------------------------------------------

/// The modifier flags a DOM keyboard or pointer event carries.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct Modifiers {
    ctrl_key: bool,
    alt_key: bool,
    shift_key: bool,
    meta_key: bool,
}

impl Modifiers {
    fn of(event: &KeyboardEvent) -> Self {
        Self {
            ctrl_key: event.ctrl_key(),
            alt_key: event.alt_key(),
            shift_key: event.shift_key(),
            meta_key: event.meta_key(),
        }
    }

    /// `keybinds` tells Cmd from Win; the DOM only says Meta.
    fn mods(self, platform: Platform) -> Mods {
        let mut mods = Mods::NONE;
        mods.set(Mods::CTRL, self.ctrl_key);
        mods.set(Mods::ALT, self.alt_key);
        mods.set(Mods::SHIFT, self.shift_key);
        let meta = if platform == Platform::Mac {
            Mods::CMD
        } else {
            Mods::WIN
        };
        mods.set(meta, self.meta_key);
        mods
    }
}

/// A DOM `KeyboardEvent.key` as a `keybinds` input, or `None` for a key that is
/// no input of its own: a lone modifier, a dead key, an IME's.
///
/// `keybinds` has converters for crossterm, termwiz, winit and iced and none
/// for the web, and Ratzilla's `KeyEvent` drops Meta, so the names go through
/// `keybinds`' own parser. The DOM spells arrows `ArrowUp` and the context menu
/// `ContextMenu`; every other name it sends the parser already knows.
fn key_input(key: &str, mods: Mods) -> Option<KeyInput> {
    let named = match key {
        "Shift" | "Control" | "Alt" | "AltGraph" | "Meta" | "OS" | "Super" | "Hyper" | "Fn"
        | "CapsLock" | "Dead" | "Process" | "Compose" | "Unidentified" | "" => return None,
        " " => Key::Char(' '),
        "ContextMenu" => Key::Menu,
        other => Key::from_str(other.strip_prefix("Arrow").unwrap_or(other)).ok()?,
    };
    match named {
        Key::Ignored | Key::Unidentified => None,
        key => Some(KeyInput::new(key, mods)),
    }
}

fn is_bare_printable(input: &KeyInput) -> bool {
    matches!(input.key(), Key::Char(_))
        && !input
            .mods()
            .intersects(Mods::CTRL | Mods::ALT | Mods::CMD | Mods::WIN)
}

// --- pointer ------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum PointerType {
    Down,
    Up,
    Move,
    Wheel,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum WireButton {
    #[default]
    Left,
    Middle,
    Right,
}

/// What the page sends for `pointer(json)`: DOM coordinates and flags, so the
/// page does no cell arithmetic.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PointerInput {
    #[serde(rename = "type")]
    kind: PointerType,
    #[serde(default)]
    button: WireButton,
    client_x: f64,
    client_y: f64,
    #[serde(default)]
    delta_x: f64,
    #[serde(default)]
    delta_y: f64,
    /// `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages.
    #[serde(default)]
    delta_mode: u8,
    /// `event.detail`: the press count. Absent or 0 is a single press.
    #[serde(default)]
    detail: u16,
    #[serde(flatten)]
    mods: Modifiers,
}

/// The cell under a point, from the grid's top left corner in client
/// coordinates. A point left of or above the grid is cell zero, which is where a
/// drag that leaves the grid is held.
fn cell_at(client: (f64, f64), origin: (f64, f64), cell: CellMetrics) -> (u16, u16) {
    let axis = |at: f64, from: f64, size: f32| {
        let n = ((at - from) / f64::from(size)).floor();
        if n.is_finite() && n > 0.0 {
            n.min(f64::from(u16::MAX)) as u16
        } else {
            0
        }
    };
    (
        axis(client.0, origin.0, cell.width_px),
        axis(client.1, origin.1, cell.height_px),
    )
}

/// Whole cells for one wheel axis. A pixel delta smaller than a cell still
/// moves one, so a trackpad's first tick is not lost.
fn wheel_cells(delta: f64, mode: u8, cell_px: f32, page_cells: u16) -> i16 {
    let cells = match mode {
        1 => delta,
        2 => delta * f64::from(page_cells),
        _ => delta / f64::from(cell_px),
    };
    let rounded = cells.round();
    let whole = if rounded == 0.0 && cells != 0.0 {
        cells.signum()
    } else {
        rounded
    };
    whole.clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

/// The press count the core takes: the DOM's `detail`, never below 1.
fn clicks_of(detail: u16) -> u8 {
    detail.clamp(1, u16::from(u8::MAX)) as u8
}

fn pointer_msg(
    input: &PointerInput,
    origin: (f64, f64),
    cell: CellMetrics,
    rows: u16,
    platform: Platform,
) -> Msg {
    let (x, y) = cell_at((input.client_x, input.client_y), origin, cell);
    let button = match input.button {
        WireButton::Left => Button::Left,
        WireButton::Middle => Button::Middle,
        WireButton::Right => Button::Right,
    };
    let kind = match input.kind {
        PointerType::Down => PointerKind::Down(button),
        PointerType::Up => PointerKind::Up(button),
        PointerType::Move => PointerKind::Move,
        PointerType::Wheel => PointerKind::Wheel {
            dx: wheel_cells(input.delta_x, input.delta_mode, cell.width_px, rows),
            dy: wheel_cells(input.delta_y, input.delta_mode, cell.height_px, rows),
        },
    };
    Msg::Pointer(Pointer {
        kind,
        x,
        y,
        mods: input.mods.mods(platform),
        clicks: clicks_of(input.detail),
    })
}

// --- inbound messages ---------------------------------------------------------------------

/// A `dispatch` payload: the core's one tagged inbound type
/// (`{"channel": "completion" | "host", ...}`).
fn inbound(json: &str) -> Result<Msg, String> {
    serde_json::from_str::<Inbound>(json)
        .map(Msg::from)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct TextInput {
    text: String,
}

// --- first frame -------------------------------------------------------------------------

/// Something that happens once, when a frame has first been drawn, for a
/// callback that may be registered before or after it.
struct FirstFrame<T> {
    drawn: bool,
    waiting: Option<T>,
}

impl<T> FirstFrame<T> {
    fn new() -> Self {
        Self {
            drawn: false,
            waiting: None,
        }
    }

    /// A callback to run when the first frame is drawn. Returned back when it
    /// is already drawn, for the caller to run now.
    fn when_drawn(&mut self, callback: T) -> Option<T> {
        if self.drawn {
            Some(callback)
        } else {
            self.waiting = Some(callback);
            None
        }
    }

    /// A frame was drawn: the waiting callback, the first time only.
    fn drew(&mut self) -> Option<T> {
        self.drawn = true;
        self.waiting.take()
    }
}

// --- the core -----------------------------------------------------------------------------

/// What one animation frame owes the page.
struct Step {
    effects: Vec<Effect>,
    /// The semantic tree or the diff since the last one sent, as JSON.
    semantics: Option<String>,
    redraw: bool,
}

/// The model and the policy around it. No browser.
struct Core {
    model: Model,
    publisher: SemanticPublisher,
    theme: Theme,
    platform: Platform,
    cell: Option<CellMetrics>,
    /// A message went through since the last frame: semantics may have moved
    /// even when nothing needs drawing.
    touched: bool,
    /// The grid was rebuilt blank or the theme changed: draw whatever the model says.
    repaint: bool,
    /// The default layout's Files panel has been asked for (or a saved layout
    /// replaced the default), so it is not asked for again.
    files_opened: bool,
    /// Theo, the main region's principal panel, has been asked for (or a saved
    /// layout replaced the default).
    theo_opened: bool,
    /// The newest conversation snapshot the model was given, for the panels the
    /// core has not bound to a conversation yet.
    conversations: Directory,
}

impl Core {
    /// The key table for this platform from the person's overrides (JSON, the
    /// core's own `Overrides`), handed to the model; the picker's shortcut
    /// hints are drawn from it. The issues are bindings the table refused.
    fn set_overrides(&mut self, json: &str) -> Result<Vec<KeyIssue>, serde_json::Error> {
        let overrides: Overrides = serde_json::from_str(json)?;
        let (table, issues) = KeyTable::build(self.model.registry(), self.platform, &overrides);
        self.model.set_keys(table);
        self.touched = true;
        Ok(issues)
    }

    fn new(platform: Platform) -> Self {
        let registry = builtin::registry();
        let (keys, _issues) = KeyTable::build(&registry, platform, &Overrides::default());
        let (dock, _regions) = Dock::from_preset(DockConfig::default(), Preset::Default);
        let conversations = Directory::default();
        Self {
            model: Model::new(
                registry,
                factories(&conversations),
                keys,
                Capabilities::default(),
                dock,
            ),
            publisher: SemanticPublisher::default(),
            theme: Theme::plain(),
            platform,
            cell: None,
            touched: true,
            repaint: true,
            files_opened: false,
            theo_opened: false,
            conversations,
        }
    }

    fn update(&mut self, msg: Msg) -> Vec<Effect> {
        self.touched = true;
        self.conversations.observe(&msg);
        update(&mut self.model, msg)
    }

    /// Ask for a panel by its own focus action, as a person's key would.
    fn focus(&mut self, action: &str) -> Vec<Effect> {
        self.update(Msg::Action {
            id: ActionId::new(action),
            actor: Actor::Human,
        })
    }

    /// Apply a measured grid. Nothing happens when it is the grid already held.
    fn resize(&mut self, area: Rect, metrics: CellMetrics) -> Vec<Effect> {
        self.cell = Some(metrics);
        let held = self.model.viewport();
        if held.is_some_and(|v| v.area == area && v.metrics == metrics) {
            return vec![];
        }
        self.update(Msg::Resize { area, metrics })
    }

    /// A key from the page. Returns whether the workbench consumed it, so the
    /// page can `preventDefault`, and the effects it caused.
    ///
    /// - The picker open, or a chord in the key table: consumed.
    /// - A bare printable key while the focused panel takes text: not consumed
    ///   and not sent. The browser types it into the host-input textarea and
    ///   `text_input` delivers it once, with IME and dead keys handled.
    /// - Any other key is sent to the panel. Navigation and editing keys are
    ///   consumed; an unresolved Ctrl, Alt or Cmd chord is not, so the browser
    ///   keeps its copy, paste, reload and zoom.
    fn key(&mut self, input: KeyInput) -> (bool, Vec<Effect>) {
        let focus = self.model.focus();
        let owner = focus.panel.as_ref();
        let kind = owner.and_then(|id| {
            self.model
                .panel_ids()
                .find(|(p, _)| *p == id)
                .map(|(_, kind)| kind.clone())
        });
        let text_entry = owner
            .and_then(|id| self.model.panel(id))
            .is_some_and(|panel| panel.text_entry());
        let resolved = self
            .model
            .keys()
            .resolve(&input, &active_contexts(kind.as_ref(), text_entry))
            .is_some();
        if focus.modal || resolved {
            return (true, self.update(Msg::Key(input)));
        }
        if is_bare_printable(&input) && text_entry {
            return (false, vec![]);
        }
        let chord = input
            .mods()
            .intersects(Mods::CTRL | Mods::ALT | Mods::CMD | Mods::WIN);
        (!chord, self.update(Msg::Key(input)))
    }

    /// The grid was rebuilt blank: the next frame draws everything.
    fn invalidate(&mut self) {
        self.repaint = true;
    }

    /// One animation frame: settle the grid, tick, and say what is owed. A draw
    /// only when the model or the theme changed since the last one; semantics
    /// whenever anything moved, as the diff from the last tree sent, so frames
    /// coalesced into one redraw still publish every change.
    fn step(&mut self, area: Rect, cell: CellMetrics, theme: Theme) -> Step {
        let mut effects = self.resize(area, cell);
        // Files is open in the default layout as soon as the host can serve it:
        // the action is the core's own and is refused until `files` is granted.
        if !self.theo_opened {
            self.theo_opened = true;
            effects.extend(self.focus("theo.focus"));
        }
        if !self.files_opened && self.model.capabilities().has(&Capability::new("files")) {
            self.files_opened = true;
            effects.extend(self.focus("files.focus"));
            // The conversation keeps the focus: it is the principal panel.
            effects.extend(self.focus("theo.focus"));
        }
        effects.extend(self.update(Msg::Tick));
        if theme != self.theme {
            self.theme = theme;
            self.repaint = true;
        }
        let redraw = self.model.take_dirty() | std::mem::take(&mut self.repaint);
        let semantics = (redraw || self.touched).then(|| self.publish()).flatten();
        self.touched = false;
        Step {
            effects,
            semantics,
            redraw,
        }
    }

    fn publish(&mut self) -> Option<String> {
        match self.publisher.publish(semantics(&self.model)) {
            Publish::Full(tree) => Some(json!({"type": "full", "tree": tree}).to_string()),
            Publish::Diff(diff) => Some(json!({"type": "diff", "diff": diff}).to_string()),
            Publish::Unchanged => None,
        }
    }

    fn draw(&self, frame: &mut Frame) {
        let area = frame.area();
        view(&self.model, area, frame.buffer_mut(), &self.theme);
    }
}

// --- the page ------------------------------------------------------------------------------

/// Hands effects and the semantic update to the page. Called with no borrow of
/// the core held.
fn deliver(
    on_effect: &js_sys::Function,
    on_semantics: &js_sys::Function,
    effects: &[Effect],
    semantics: Option<&str>,
) {
    for effect in effects {
        match serde_json::to_string(effect) {
            Ok(json) => {
                let _ = on_effect.call1(&JsValue::NULL, &JsValue::from_str(&json));
            }
            Err(error) => web_sys::console::error_1(&JsValue::from_str(&format!(
                "workbench: effect not serializable: {error}"
            ))),
        }
    }
    if let Some(json) = semantics {
        let _ = on_semantics.call1(&JsValue::NULL, &JsValue::from_str(json));
    }
}

/// What the frame loop draws.
struct Mounted {
    core: Rc<RefCell<Core>>,
    on_effect: js_sys::Function,
    on_semantics: js_sys::Function,
    cell: (f32, f32),
    first_frame: Rc<RefCell<FirstFrame<js_sys::Function>>>,
}

impl Drawn for Mounted {
    fn set_cell(&mut self, cell: (f32, f32)) {
        self.cell = cell;
    }

    fn wants_frame(&mut self, area: Rect) -> bool {
        let metrics = CellMetrics::new(self.cell.0, self.cell.1);
        let step = self
            .core
            .borrow_mut()
            .step(area, metrics, theme_of(&palette()));
        deliver(
            &self.on_effect,
            &self.on_semantics,
            &step.effects,
            step.semantics.as_deref(),
        );
        step.redraw
    }

    fn draw(&mut self, frame: &mut Frame) {
        self.core.borrow().draw(frame);
    }

    fn drawn(&mut self) {
        let waiting = self.first_frame.borrow_mut().drew();
        if let Some(callback) = waiting {
            let _ = callback.call0(&JsValue::NULL);
        }
    }

    fn repaint(&mut self) {
        self.core.borrow_mut().invalidate();
    }
}

fn platform_of(window: &web_sys::Window) -> Platform {
    let navigator = window.navigator();
    let mac = |text: Result<String, JsValue>| text.is_ok_and(|t| t.contains("Mac"));
    if mac(navigator.platform()) || mac(navigator.user_agent()) {
        Platform::Mac
    } else {
        Platform::Other
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

/// The mounted workbench. React calls these from its own event handlers.
#[wasm_bindgen]
pub struct WorkbenchHandle {
    core: Rc<RefCell<Core>>,
    parent: web_sys::Element,
    on_effect: js_sys::Function,
    on_semantics: js_sys::Function,
    first_frame: Rc<RefCell<FirstFrame<js_sys::Function>>>,
}

#[wasm_bindgen]
impl WorkbenchHandle {
    /// Calls `callback` once the first frame is on the page: at once if it
    /// already is. A story or an oracle is ready from then, not from mount.
    pub fn when_drawn(&self, callback: js_sys::Function) {
        let now = self.first_frame.borrow_mut().when_drawn(callback);
        if let Some(callback) = now {
            let _ = callback.call0(&JsValue::NULL);
        }
    }

    fn send(&self, msg: Msg) {
        let effects = self.core.borrow_mut().update(msg);
        deliver(&self.on_effect, &self.on_semantics, &effects, None);
    }

    /// A completion or a host message (JSON), as the adapter produces them.
    pub fn dispatch(&self, json: &str) -> Result<(), JsValue> {
        self.send(inbound(json).map_err(js_error)?);
        Ok(())
    }

    /// A keydown; true when the workbench consumed it and the page should
    /// `preventDefault`.
    pub fn key(&self, event: KeyboardEvent) -> bool {
        let Some(input) = key_input(&event.key(), {
            let platform = self.core.borrow().platform;
            Modifiers::of(&event).mods(platform)
        }) else {
            return false;
        };
        let (consumed, effects) = self.core.borrow_mut().key(input);
        deliver(&self.on_effect, &self.on_semantics, &effects, None);
        consumed
    }

    /// A pointer event (JSON `{type, button?, clientX, clientY, deltaX?,
    /// deltaY?, deltaMode?, ctrlKey?, altKey?, shiftKey?, metaKey?}`). The
    /// cell is worked out here from the grid's position and the measured cell.
    pub fn pointer(&self, json: &str) -> Result<(), JsValue> {
        let input: PointerInput = serde_json::from_str(json).map_err(js_error)?;
        let rect = self.parent.get_bounding_client_rect();
        let (cell, rows, platform) = {
            let core = self.core.borrow();
            let rows = core.model.viewport().map_or(0, |v| v.area.height);
            (core.cell, rows, core.platform)
        };
        // No frame has measured a cell yet: there is no grid to point at.
        let Some(cell) = cell else {
            return Ok(());
        };
        self.send(pointer_msg(
            &input,
            (rect.left(), rect.top()),
            cell,
            rows,
            platform,
        ));
        Ok(())
    }

    /// Text the host-input textarea committed: typed characters or a finished
    /// IME composition (JSON `{text}`).
    pub fn text_input(&self, json: &str) -> Result<(), JsValue> {
        let input: TextInput = serde_json::from_str(json).map_err(js_error)?;
        self.send(Msg::Text(input.text));
        Ok(())
    }

    pub fn paste(&self, text: &str) {
        self.send(Msg::Paste(text.to_owned()));
    }

    /// The host element changed size: measure it in cells and tell the model.
    /// The frame loop also follows the grid the backend actually built.
    pub fn resize(&self) {
        let rect = self.parent.get_bounding_client_rect();
        let mut core = self.core.borrow_mut();
        let Some(cell) = core.cell else {
            return;
        };
        let cols = (rect.width() / f64::from(cell.width_px)) as u16;
        let rows = (rect.height() / f64::from(cell.height_px)) as u16;
        if cols == 0 || rows == 0 {
            return;
        }
        let effects = core.resize(Rect::new(0, 0, cols, rows), cell);
        drop(core);
        deliver(&self.on_effect, &self.on_semantics, &effects, None);
    }

    pub fn set_focused(&self, focused: bool) {
        self.send(Msg::Focus(focused));
    }

    /// The semantic tree as it is now (JSON), the same one `on_semantics`
    /// publishes and `workbench.read` returns.
    pub fn semantics(&self) -> Result<String, JsValue> {
        serde_json::to_string(&semantics(&self.core.borrow().model)).map_err(js_error)
    }

    /// Replaces the layout with a saved document (JSON). Until the layout
    /// owner's completion is routed to the model by `dispatch`, the page loads
    /// it here.
    pub fn restore(&self, json: &str) -> Result<(), JsValue> {
        let value: Value = serde_json::from_str(json).map_err(js_error)?;
        let mut core = self.core.borrow_mut();
        core.touched = true;
        core.files_opened = true;
        core.theo_opened = true;
        core.model.restore(value).map(|_| ()).map_err(js_error)
    }

    /// Rebuilds the key table from the person's overrides (JSON: `{version,
    /// bind, unbind}`; `{"version":1}` is the defaults) and gives it to the
    /// model. Returns the bindings the table refused, as a JSON array.
    pub fn set_keys(&self, overrides_json: &str) -> Result<String, JsValue> {
        let mut core = self.core.borrow_mut();
        let issues = core.set_overrides(overrides_json).map_err(js_error)?;
        serde_json::to_string(&issues).map_err(js_error)
    }

    /// The layout document to save (JSON).
    pub fn document(&self) -> String {
        self.core.borrow().model.document().to_string()
    }
}

/// Mounts the workbench into the element with `parent_id`, which it fills and
/// which must be positioned. `on_effect` receives each effect as a JSON string;
/// `on_semantics` the first semantic tree and then each diff
/// (`{type: "full", tree}` or `{type: "diff", diff}`). Frames run until the
/// element leaves the page; mount once per element.
#[wasm_bindgen]
pub fn mount_workbench(
    parent_id: &str,
    on_effect: js_sys::Function,
    on_semantics: js_sys::Function,
) -> Result<WorkbenchHandle, JsValue> {
    let screen = Screen::new(parent_id)?;
    let platform = platform_of(&web_sys::window().ok_or("no window")?);
    let core = Rc::new(RefCell::new(Core::new(platform)));
    let parent = screen.parent.clone();
    let first_frame = Rc::new(RefCell::new(FirstFrame::new()));
    run_frames(
        screen,
        Rc::new(RefCell::new(Mounted {
            core: core.clone(),
            on_effect: on_effect.clone(),
            on_semantics: on_semantics.clone(),
            cell: (0.0, 0.0),
            first_frame: first_frame.clone(),
        })),
    );
    Ok(WorkbenchHandle {
        core,
        parent,
        on_effect,
        on_semantics,
        first_frame,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use theorem_workbench_core::{HostMessage, keys::parse_chord};

    const CELL: CellMetrics = CellMetrics {
        width_px: 8.0,
        height_px: 16.0,
    };
    const AREA: Rect = Rect {
        x: 0,
        y: 0,
        width: 120,
        height: 40,
    };

    fn press(chord: &str) -> KeyInput {
        parse_chord(chord, Platform::Other).unwrap()
    }

    fn core() -> Core {
        let mut core = Core::new(Platform::Other);
        core.step(AREA, CELL, Theme::plain());
        core
    }

    #[test]
    fn dom_key_names_become_inputs() {
        let none = Mods::NONE;
        assert_eq!(
            key_input("ArrowDown", none).map(|k| k.key()),
            Some(Key::Down)
        );
        assert_eq!(key_input("Escape", none).map(|k| k.key()), Some(Key::Esc));
        assert_eq!(key_input("Enter", none).map(|k| k.key()), Some(Key::Enter));
        assert_eq!(
            key_input("PageUp", none).map(|k| k.key()),
            Some(Key::PageUp)
        );
        assert_eq!(key_input("F5", none).map(|k| k.key()), Some(Key::F5));
        assert_eq!(key_input(" ", none).map(|k| k.key()), Some(Key::Char(' ')));
        assert_eq!(key_input("+", none).map(|k| k.key()), Some(Key::Char('+')));
        assert_eq!(key_input("é", none).map(|k| k.key()), Some(Key::Char('é')));
        assert_eq!(
            key_input("ContextMenu", none).map(|k| k.key()),
            Some(Key::Menu)
        );
    }

    #[test]
    fn keys_that_are_not_inputs_are_dropped() {
        for key in [
            "Shift",
            "Control",
            "Alt",
            "Meta",
            "Dead",
            "Process",
            "Unidentified",
            "",
        ] {
            assert_eq!(key_input(key, Mods::NONE), None, "{key}");
        }
        assert_eq!(key_input("NotAKey", Mods::NONE), None);
    }

    #[test]
    fn modifiers_keep_their_meaning() {
        let event = Modifiers {
            ctrl_key: true,
            shift_key: true,
            meta_key: true,
            ..Modifiers::default()
        };
        assert_eq!(
            event.mods(Platform::Mac),
            Mods::CTRL | Mods::SHIFT | Mods::CMD
        );
        assert_eq!(
            event.mods(Platform::Other),
            Mods::CTRL | Mods::SHIFT | Mods::WIN
        );
        // Shift is part of a character's own case, so it only survives on named keys.
        let upper = key_input("A", Mods::CTRL | Mods::SHIFT).unwrap();
        assert_eq!((upper.key(), upper.mods()), (Key::Char('A'), Mods::CTRL));
        let back = key_input("Tab", Mods::SHIFT).unwrap();
        assert_eq!((back.key(), back.mods()), (Key::Tab, Mods::SHIFT));
    }

    #[test]
    fn a_point_maps_to_the_cell_under_it() {
        let origin = (100.0, 50.0);
        assert_eq!(cell_at((100.0, 50.0), origin, CELL), (0, 0));
        assert_eq!(cell_at((107.9, 65.9), origin, CELL), (0, 0));
        assert_eq!(cell_at((108.0, 66.0), origin, CELL), (1, 1));
        assert_eq!(
            cell_at((100.0 + 8.0 * 30.0 + 3.0, 50.0 + 16.0 * 7.0), origin, CELL),
            (30, 7)
        );
        // Left of or above the grid is the first cell; far past it is clamped.
        assert_eq!(cell_at((10.0, -5.0), origin, CELL), (0, 0));
        assert_eq!(cell_at((1e12, 1e12), origin, CELL), (u16::MAX, u16::MAX));
        assert_eq!(cell_at((f64::NAN, f64::INFINITY), origin, CELL), (0, 0));
    }

    #[test]
    fn a_fractional_cell_size_is_honoured() {
        let cell = CellMetrics::new(7.5, 17.25);
        assert_eq!(cell_at((15.0, 17.25), (0.0, 0.0), cell), (2, 1));
        assert_eq!(cell_at((14.99, 17.24), (0.0, 0.0), cell), (1, 0));
    }

    #[test]
    fn wheel_deltas_become_whole_cells() {
        assert_eq!(wheel_cells(48.0, 0, 16.0, 40), 3);
        assert_eq!(wheel_cells(-48.0, 0, 16.0, 40), -3);
        // Less than a cell still moves one.
        assert_eq!(wheel_cells(2.0, 0, 16.0, 40), 1);
        assert_eq!(wheel_cells(-2.0, 0, 16.0, 40), -1);
        assert_eq!(wheel_cells(0.0, 0, 16.0, 40), 0);
        assert_eq!(wheel_cells(3.0, 1, 16.0, 40), 3);
        assert_eq!(wheel_cells(1.0, 2, 16.0, 40), 40);
    }

    #[test]
    fn pointer_json_becomes_a_pointer_message() {
        let input: PointerInput = serde_json::from_str(
            r#"{"type":"down","button":"right","clientX":125,"clientY":84,"ctrlKey":true}"#,
        )
        .unwrap();
        let msg = pointer_msg(&input, (100.0, 50.0), CELL, 40, Platform::Other);
        assert_eq!(
            msg,
            Msg::Pointer(Pointer {
                kind: PointerKind::Down(Button::Right),
                x: 3,
                y: 2,
                mods: Mods::CTRL,
                clicks: 1,
            })
        );
        let wheel: PointerInput =
            serde_json::from_str(r#"{"type":"wheel","clientX":0,"clientY":0,"deltaY":32}"#)
                .unwrap();
        assert_eq!(
            pointer_msg(&wheel, (0.0, 0.0), CELL, 40, Platform::Other),
            Msg::Pointer(Pointer {
                kind: PointerKind::Wheel { dx: 0, dy: 2 },
                x: 0,
                y: 0,
                mods: Mods::NONE,
                clicks: 1,
            })
        );
    }

    #[test]
    fn the_press_count_is_the_dom_detail_and_never_below_one() {
        assert_eq!(clicks_of(0), 1);
        assert_eq!(clicks_of(1), 1);
        assert_eq!(clicks_of(2), 2);
        assert_eq!(clicks_of(3), 3);
        assert_eq!(clicks_of(60000), u8::MAX);
        let down = |extra: &str| -> u8 {
            let json = format!(r#"{{"type":"down","clientX":0,"clientY":0{extra}}}"#);
            let input: PointerInput = serde_json::from_str(&json).unwrap();
            match pointer_msg(&input, (0.0, 0.0), CELL, 40, Platform::Other) {
                Msg::Pointer(p) => p.clicks,
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(down(""), 1);
        assert_eq!(down(r#","detail":0"#), 1);
        assert_eq!(down(r#","detail":2"#), 2);
    }

    #[test]
    fn the_theme_takes_each_role_from_the_palette_field_of_the_same_name() {
        use ratatui::style::Color;
        let p = Palette::default();
        let theme = theme_of(&p);
        assert_eq!(theme.bg, Style::new().fg(p.ink).bg(p.bg));
        assert_eq!(theme.muted, Style::new().fg(p.muted));
        assert_eq!(theme.error, Style::new().fg(p.error));
        assert_eq!(theme.warning, Style::new().fg(p.warning));
        assert_eq!(theme.success, Style::new().fg(p.success));
        assert_eq!(theme.added_line.bg, Some(p.added_line));
        assert_eq!(theme.removed_line.bg, Some(p.removed_line));
        assert_eq!(theme.added_words.bg, Some(p.added_words));
        assert_eq!(theme.removed_words.bg, Some(p.removed_words));
        // Added and removed are told apart, and no role is left at the plain theme's.
        assert_ne!(theme.added_line, theme.removed_line);
        assert_ne!(theme.error, Theme::plain().error);
        assert_ne!(theme.added_words.bg, Some(Color::Reset));
    }

    #[test]
    fn the_first_frame_callback_runs_once_whenever_it_was_registered() {
        let mut early = FirstFrame::new();
        assert!(early.when_drawn(1).is_none());
        assert_eq!(early.drew(), Some(1));
        assert_eq!(early.drew(), None);
        let mut late = FirstFrame::new();
        assert_eq!(late.drew(), None);
        assert_eq!(late.when_drawn(2), Some(2));
    }

    #[test]
    fn files_open_in_the_default_layout_once_the_host_grants_them() {
        let mut core = core();
        let files = |core: &Core| core.model.panel_ids().any(|(_, k)| k.as_str() == "files");
        assert!(!files(&core));
        core.update(Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(["files"]),
        }));
        core.step(AREA, CELL, Theme::plain());
        assert!(files(&core));
        // Not asked for again once closed.
        let count = core.model.panel_ids().count();
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(core.model.panel_ids().count(), count);
    }

    #[test]
    fn the_default_layout_puts_theo_in_main_and_keeps_the_focus_there() {
        let mut core = core();
        core.update(Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(["files"]),
        }));
        core.step(AREA, CELL, Theme::plain());
        let kinds: Vec<String> = core
            .model
            .panel_ids()
            .map(|(_, k)| k.as_str().to_owned())
            .collect();
        assert!(kinds.contains(&"theo".to_owned()), "{kinds:?}");
        assert!(kinds.contains(&"files".to_owned()), "{kinds:?}");
        let focused = core.model.focus().panel.expect("something has the focus");
        let kind = core
            .model
            .panel_ids()
            .find(|(id, _)| **id == focused)
            .map(|(_, k)| k.as_str().to_owned());
        assert_eq!(kind.as_deref(), Some("theo"));
    }

    #[test]
    fn a_conversation_snapshot_reaches_theo_through_the_mount_before_it_is_bound() {
        let snapshot = serde_json::json!({
            "conversationId": "t1", "loading": false, "revision": 1,
            "messages": [{"id": "m1", "role": "user", "status": "complete",
                          "parts": [{"type": "text", "text": "hello from the owner"}],
                          "attachments": []}],
            "run": {"state": "idle"}, "queued": []
        });
        let msg = inbound(
            &serde_json::json!({
                "channel": "host", "type": "conversationSnapshot",
                "resource": {"type": "conversation", "project": "p", "thread": "t1"},
                "revision": {"scheme": "seq", "value": 1},
                "conversationId": "t1", "snapshot": snapshot.to_string()
            })
            .to_string(),
        )
        .unwrap();
        let mut core = core();
        core.update(msg);
        core.step(AREA, CELL, Theme::plain());
        let id = core
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == "theo")
            .map(|(id, _)| id.clone())
            .unwrap();
        let binding = core.model.panel(&id).unwrap().binding().unwrap();
        assert_eq!(
            binding.resource,
            theorem_workbench_core::ResourceRef::Conversation {
                project: "p".into(),
                thread: "t1".into()
            }
        );
    }

    #[test]
    fn a_workspace_message_reaches_the_core() {
        let msg = inbound(
            r#"{"channel":"host","type":"workspaceChanged","workspace":"w1","environment":"e1"}"#,
        )
        .unwrap();
        let mut core = core();
        core.update(msg);
        assert_eq!(core.model.workspace().workspace, "w1");
    }

    #[test]
    fn inbound_json_is_told_apart_by_its_channel() {
        let host = r#"{"channel":"host","type":"themeChanged","revision":2,"dark":true}"#;
        assert!(matches!(inbound(host), Ok(Msg::Host(_))));
        let completion = r#"{"channel":"completion","effect":1,"resource":{"type":"none"},"outcome":{"status":"accepted"}}"#;
        assert!(
            matches!(inbound(completion), Ok(Msg::Completion(_))),
            "{:?}",
            inbound(completion)
        );
        assert!(inbound(r#"{"type":"themeChanged","revision":2,"dark":true}"#).is_err());
        assert!(inbound("not json").is_err());
    }

    #[test]
    fn the_first_frame_draws_and_publishes_the_whole_tree() {
        let mut core = Core::new(Platform::Other);
        let step = core.step(AREA, CELL, Theme::plain());
        assert!(step.redraw);
        assert!(
            step.semantics
                .as_deref()
                .is_some_and(|s| s.contains(r#""type":"full""#))
        );
        assert_eq!(core.model.viewport().map(|v| v.area), Some(AREA));
    }

    #[test]
    fn a_quiet_frame_neither_draws_nor_publishes() {
        let mut core = core();
        for _ in 0..3 {
            let step = core.step(AREA, CELL, Theme::plain());
            assert!(!step.redraw);
            assert!(step.semantics.is_none());
            assert!(step.effects.is_empty());
        }
    }

    #[test]
    fn many_messages_between_frames_cost_one_draw_and_lose_no_semantics() {
        let mut core = core();
        let before = core.publisher.current().cloned().unwrap();
        core.update(Msg::Picker(theorem_workbench_core::picker::PickerMsg::Open));
        core.update(Msg::Picker(
            theorem_workbench_core::picker::PickerMsg::Filter("fi".into()),
        ));
        core.update(Msg::Picker(
            theorem_workbench_core::picker::PickerMsg::Filter("fil".into()),
        ));
        let step = core.step(AREA, CELL, Theme::plain());
        assert!(step.redraw);
        let diff = step.semantics.expect("a diff");
        assert!(diff.contains(r#""type":"diff""#));
        // The published tree is the model's tree now, not an intermediate one.
        assert_eq!(core.publisher.current(), Some(&semantics(&core.model)));
        assert_ne!(core.publisher.current(), Some(&before));
        // And the next frame owes nothing.
        let step = core.step(AREA, CELL, Theme::plain());
        assert!(!step.redraw && step.semantics.is_none());
    }

    #[test]
    fn a_new_grid_or_theme_or_blank_screen_draws_again() {
        let mut core = core();
        let wide = Rect::new(0, 0, 140, 40);
        assert!(core.step(wide, CELL, Theme::plain()).redraw);
        let themed = Theme {
            muted: Style::new().fg(ratatui::style::Color::Red),
            ..Theme::plain()
        };
        assert!(core.step(wide, CELL, themed.clone()).redraw);
        assert!(!core.step(wide, CELL, themed).redraw);
        core.invalidate();
        assert!(core.step(wide, CELL, core.theme.clone()).redraw);
    }

    #[test]
    fn the_picker_chord_is_consumed_and_opens_the_picker() {
        let mut core = core();
        let (consumed, _) = core.key(press("Mod+Alt+T"));
        assert!(consumed);
        assert!(core.model.focus().modal);
        // With the picker open every key is the picker's.
        let (consumed, _) = core.key(press("a"));
        assert!(consumed);
        assert_eq!(core.model.picker().filter(), "a");
    }

    #[test]
    fn an_unresolved_browser_chord_is_left_to_the_browser() {
        let mut core = core();
        let (consumed, _) = core.key(press("Ctrl+c"));
        assert!(!consumed);
        let (consumed, _) = core.key(press("Down"));
        assert!(consumed);
    }

    #[test]
    fn pins_survive_a_save_and_a_restore() {
        let mut core = core();
        let more = core
            .model
            .registry()
            .panels()
            .iter()
            .find(|p| {
                p.actions
                    .iter()
                    .any(|a| a.picker == Some(theorem_workbench_core::registry::PickerSlot::More))
            })
            .expect("the builtin registry has a More tools entry")
            .kind
            .clone();
        core.model
            .set_pinned(std::iter::once(more.clone()).collect());
        let saved = core.model.document();
        assert_eq!(saved["pinned"], json!([more.as_str()]));
        // A fresh workbench takes the saved document back, pins included.
        let mut fresh = self::core();
        assert!(fresh.model.pinned().is_empty());
        fresh.model.restore(saved.clone()).unwrap();
        assert!(fresh.model.pinned().contains(&more));
        assert_eq!(fresh.model.document(), saved);
    }

    #[test]
    fn overrides_rebuild_the_key_table_and_bad_ones_are_an_error() {
        let mut core = core();
        let issues = core.set_overrides(r#"{"version":1}"#).unwrap();
        assert!(issues.is_empty(), "{issues:?}");
        assert!(core.set_overrides("not json").is_err());
    }

    #[test]
    fn restore_round_trips_the_document() {
        let mut core = core();
        let doc = core.model.document();
        core.model.restore(doc.clone()).unwrap();
        assert_eq!(core.model.document(), doc);
    }
}
