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
    style::{Color, Modifier, Style},
};
use ratzilla::web_sys::{self, KeyboardEvent};
use serde::Deserialize;
use serde_json::{Value, json};
use theorem_workbench_core::{
    ActionId, Actor, ArrangementMsg, Button, Capability, Caret, CaretPhase, CaretShape,
    Composition, Effect, Inbound, Model, Msg, PanelFactories, PlacedIcon, Pointer, PointerKind,
    RestoreError, Theme,
    agent::{AgentOutcome, action_msg, agent_outcome, agent_request},
    builtin,
    ids::ResourceKind,
    keys::{KeyIssue, KeyTable, Overrides, Platform, active_contexts},
    registry::{Capabilities, Presentation},
    semantics,
    semantics::{Publish, SemanticPublisher},
    update, view,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use wasm_bindgen::prelude::*;

use crate::{
    BLINK_MS, CaretStyle, Drawn, Palette, Screen,
    cabinet_panel::CabinetLink,
    now, palette, run_frames,
    theo::{self, Directory},
};

/// Where other crates' panels are registered as they land. The picker's panel
/// and the placeholder for a kind this build cannot serve belong to the core
/// itself; the panels crate adds Files, whose opening and workspace identity go
/// through the core.
///
/// The editor is registered ahead of the Markdown panel when `editor_first`: the openers are
/// ranked, so which file opens where does not depend on the order.
fn factories_with(
    conversations: &Directory,
    cabinet: &CabinetLink,
    editor_first: bool,
) -> PanelFactories {
    let mut factories = PanelFactories::new();
    theorem_workbench_panels::register(&mut factories);
    theo::register(&mut factories, conversations);
    crate::cabinet_panel::register(&mut factories, cabinet);
    theorem_workbench_process::register(&mut factories, process_styles(), load_nonce());
    theorem_workbench_changes::register(&mut factories);
    theorem_workbench_ide::register(&mut factories);
    if editor_first {
        theorem_workbench_editor::register(&mut factories);
        theorem_workbench_markdown_panel::register(&mut factories);
    } else {
        theorem_workbench_markdown_panel::register(&mut factories);
        theorem_workbench_editor::register(&mut factories);
    }
    factories
}

/// The registry the model starts from: the core's own, with the workflow
/// actions the process pane, Changes and the editor add to their kinds.
fn registry() -> theorem_workbench_core::registry::Registry {
    let mut registry = builtin::registry();
    theorem_workbench_process::extend_registry(&mut registry)
        .expect("the process actions extend the shell kind once");
    theorem_workbench_changes::extend_registry(&mut registry)
        .expect("the Changes actions extend the changes kind once");
    theorem_workbench_ide::extend_registry(&mut registry)
        .expect("the IDE actions extend the search, diagnostics and run-output kinds once");
    theorem_workbench_markdown_panel::extend_registry(&mut registry)
        .expect("the Markdown actions extend the markdown kind once");
    theorem_workbench_editor::extend_registry(&mut registry)
        .expect("the editor actions extend the document kind once");
    // Two presentations of a document (R48, AC-59): the editor shows every
    // text document, the Markdown panel is the alternate for Markdown files.
    registry
        .declare_presentation(
            Presentation::new(theorem_workbench_editor::KIND, ResourceKind::Document)
                .default_presentation(),
        )
        .expect("the editor is declared a presentation of documents once");
    registry
        .declare_presentation(
            Presentation::new(
                theorem_workbench_markdown_panel::KIND,
                ResourceKind::Document,
            )
            .extensions(["md", "markdown"]),
        )
        .expect("the Markdown panel is declared a presentation of Markdown documents once");
    registry
}

/// The process pane's colours from the page's palette: the sixteen ANSI colours
/// take the palette's roles (black the deep surface, red the error colour, and
/// so on), the default pair is ink on the surface, and the overlays are the
/// selection and a search tint.
fn process_styles() -> theorem_workbench_process::ProcessStyles {
    use theorem_workbench_vt::Palette as Vt;
    let p = palette();
    let ansi = ansi_of(&p);
    theorem_workbench_process::ProcessStyles::new(Vt {
        fg: p.ink,
        bg: p.bg,
        ansi,
        selection: Style::new().bg(p.selection),
        search_match: Style::new().fg(p.mark).add_modifier(Modifier::UNDERLINED),
        search_current: Style::new()
            .fg(p.mark)
            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
    })
}

/// The sixteen ANSI colours from the palette's roles: black the deep surface, red the error
/// colour and so on, the bright eight repeating them with muted for bright black.
fn ansi_of(p: &Palette) -> [Color; 16] {
    [
        p.deep,
        p.error,
        p.success,
        p.warning,
        p.link,
        p.syntax_keyword,
        p.accent,
        p.ink,
        p.muted,
        p.error,
        p.success,
        p.warning,
        p.link,
        p.syntax_keyword,
        p.accent,
        p.bright,
    ]
}

/// Different on every page load, so input ids and attachment names never repeat
/// across reloads.
fn load_nonce() -> String {
    format!("{:x}", crate::now() as u64)
}

/// The core's style roles from the terminal's palette roles, so the workbench
/// changes with the workspace's theme exactly as the agent terminal does. The
/// state and diff roles take the palette field of the same name: a diff line is
/// text on the line's tint, changed words on the stronger one.
fn theme_of(p: &Palette) -> Theme {
    let on = |bg| Style::new().fg(p.ink).bg(bg);
    let fg = |color| Style::new().fg(color);
    // The chosen thing is told by its letters, never by a band behind them: the mark colour,
    // bold, where the panel holds the keyboard; bright ink, bold, where it does not.
    let mark = fg(p.mark).add_modifier(Modifier::BOLD);
    let chosen = fg(p.bright).add_modifier(Modifier::BOLD);
    // What still needs a fill to have an extent: the caret, a form field that holds focus and
    // a button.
    let filled = Style::new()
        .fg(p.bg)
        .bg(p.focus)
        .add_modifier(Modifier::BOLD);
    let theme = Theme::chrome(
        Style::new().fg(p.ink).bg(p.bg),
        Style::new().fg(p.ink),
        Style::new().fg(p.muted),
        Style::new().fg(p.line),
        mark,
        chosen,
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
    // The syntax roles are the page's own token colours, as the transcript's code is drawn.
    .with_syntax(
        fg(p.syntax_keyword).add_modifier(Modifier::BOLD),
        fg(p.syntax_string),
        fg(p.syntax_number),
        fg(p.syntax_comment).add_modifier(Modifier::ITALIC),
        fg(p.syntax_function).add_modifier(Modifier::BOLD),
        fg(p.syntax_variable),
    )
    .with_ansi(ansi_of(p))
    // A popup is ink on the raised surface; its chosen row is the mark colour on that same
    // surface, so nothing is drawn behind the letters but the popup itself.
    .with_popup(Style::new().fg(p.ink).bg(p.raised), mark.bg(p.raised))
    // Every match is underlined in the mark colour; the current one is bold as well.
    .with_search(
        fg(p.mark).add_modifier(Modifier::UNDERLINED),
        mark.add_modifier(Modifier::UNDERLINED),
    );
    Theme {
        // Text a person selected stays a band: selected spaces would not show as letters.
        selection: Style::new().fg(p.bright).bg(p.selection),
        caret: filled,
        field_focus: filled,
        control: filled,
        hunk_current: mark,
        // The surface ladder's roles: each is what the panels drew before the ladder
        // until the page sends a value for it (the `Palette` accessors).
        canvas: Style::new().fg(p.ink).bg(p.canvas()),
        selected_region: p
            .selected_row
            .map_or_else(Style::new, |bg| Style::new().bg(bg)),
        text_disabled: fg(p.text_disabled()),
        info: p.info.map_or_else(Style::new, fg),
        diff_added_mark: fg(p.diff_added_mark()),
        diff_removed_mark: fg(p.diff_removed_mark()),
        // Where the gutter and a time are low-value metadata, not secondary text.
        gutter: fg(p.text_disabled()),
        ..theme
    }
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
        // Shift is dropped from a character key, so a browser's lowercase `z` with Shift and a
        // command key would reach a panel as plain undo: the upper-case letter says redo.
        Key::Char(c)
            if c.is_ascii_lowercase()
                && mods.contains(Mods::SHIFT)
                && mods.intersects(Mods::CTRL | Mods::CMD) =>
        {
            Some(KeyInput::new(Key::Char(c.to_ascii_uppercase()), mods))
        }
        key => Some(KeyInput::new(key, mods)),
    }
}

/// The character printed on a key, from its position (`KeyboardEvent.code`, the US layout the
/// chords are written in), or `None` for a key that is not a letter, digit or punctuation key.
///
/// On a Mac, Option changes what a key reports: `event.key` is "†" for Option+T and a dead key
/// for Option+E, so a chord with Option in it is looked up by where the key is.
// SOURCING: `keybinds` has no DOM converter and `keyboard-types` models `Code` without a table
// from a code to its character, so the forty-seven keys are spelled here.
fn positional_key(code: &str) -> Option<String> {
    let one = |rest: &str, ok: fn(&char) -> bool| {
        let mut chars = rest.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if ok(&c) => Some(c.to_ascii_lowercase().to_string()),
            _ => None,
        }
    };
    if let Some(letter) = code.strip_prefix("Key") {
        return one(letter, char::is_ascii_uppercase);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return one(digit, char::is_ascii_digit);
    }
    let c = match code {
        "Minus" => '-',
        "Equal" => '=',
        "BracketLeft" => '[',
        "BracketRight" => ']',
        "Backslash" => '\\',
        "Semicolon" => ';',
        "Quote" => '\'',
        "Comma" => ',',
        "Period" => '.',
        "Slash" => '/',
        "Backquote" => '`',
        _ => return None,
    };
    Some(c.to_string())
}

/// A keydown as two inputs: the key the browser reports, and, on a Mac with Option held, the
/// key by its position. The second is the chord a person meant when Option turned the first
/// into another character.
fn key_inputs(
    key: &str,
    code: &str,
    mods: Mods,
    platform: Platform,
) -> (Option<KeyInput>, Option<KeyInput>) {
    let reported = key_input(key, mods);
    let positional = (platform == Platform::Mac && mods.contains(Mods::ALT))
        .then(|| positional_key(code))
        .flatten()
        // A shifted letter is its capital everywhere else (the browser reports `F` for
        // Shift+F), and the panels bind the capital.
        .map(|k| match mods.contains(Mods::SHIFT) {
            true => k.to_ascii_uppercase(),
            false => k,
        })
        .and_then(|k| key_input(&k, mods));
    (reported, positional)
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

/// One step of an input-method composition from the page's input surface
/// (`compositionstart`, `compositionupdate`, `compositionend`).
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum CompositionInput {
    Start,
    Update { text: String },
    End { text: String },
}

impl From<CompositionInput> for Composition {
    fn from(input: CompositionInput) -> Self {
        match input {
            CompositionInput::Start => Composition::Start,
            CompositionInput::Update { text } => Composition::Update { text },
            CompositionInput::End { text } => Composition::End { text },
        }
    }
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
    /// The icons the last frame carried, as the page's image layer draws them.
    icons: Vec<PlacedIcon>,
    /// A message went through since the last frame: semantics may have moved
    /// even when nothing needs drawing.
    touched: bool,
    /// The grid was rebuilt blank or the theme changed: draw whatever the model says.
    repaint: bool,
    /// The default arrangement's Files panel has been asked for (or a saved
    /// layout replaced the default), so it is not asked for again.
    files_opened: bool,
    /// The same for Changes, which opens beside Files and shows over it.
    changes_opened: bool,
    /// The same for Threads, alone in the first group.
    threads_opened: bool,
    /// Theo, the main region's principal panel, has been asked for (or a saved
    /// layout replaced the default).
    theo_opened: bool,
    /// The newest conversation snapshot the model was given, for the panels the
    /// core has not bound to a conversation yet.
    conversations: Directory,
    /// The Artifacts panel's link to the page's cabinet controller.
    cabinet: CabinetLink,
    /// When the person last typed, so a blinking caret holds solid a beat after each key.
    typed_at: f64,
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
        Self::with_editor_first(platform, false)
    }

    fn with_editor_first(platform: Platform, editor_first: bool) -> Self {
        Self::build(platform, editor_first, |_| {})
    }

    /// As `with_editor_first`, letting `tweak` change the factories before the model is built.
    fn build(
        platform: Platform,
        editor_first: bool,
        tweak: impl FnOnce(&mut PanelFactories),
    ) -> Self {
        let registry = registry();
        let (keys, _issues) = KeyTable::build(&registry, platform, &Overrides::default());
        let (dock, _regions) = Dock::from_preset(DockConfig::default(), Preset::Default);
        let conversations = Directory::default();
        let cabinet = CabinetLink::default();
        let mut factories = factories_with(&conversations, &cabinet, editor_first);
        tweak(&mut factories);
        let mut model = Model::new(registry, factories, keys, Capabilities::default(), dock);
        // The core draws its own notice row; nothing here takes notices from the queue.
        model.set_notice_queue(false);
        Self {
            model,
            publisher: SemanticPublisher::default(),
            icons: vec![],
            theme: Theme::plain(),
            platform,
            cell: None,
            touched: true,
            repaint: true,
            files_opened: false,
            changes_opened: false,
            threads_opened: false,
            theo_opened: false,
            conversations,
            cabinet,
            typed_at: 0.0,
        }
    }

    fn update(&mut self, msg: Msg) -> Vec<Effect> {
        self.touched = true;
        if matches!(
            msg,
            Msg::Key(_) | Msg::Text(_) | Msg::Paste(_) | Msg::Composition(_)
        ) {
            self.typed_at = now();
        }
        self.conversations.observe(&msg);
        update(&mut self.model, msg)
    }

    /// A saved layout replaces the default arrangement, which is then never opened.
    fn restore(&mut self, value: Value) -> Result<(), RestoreError> {
        self.touched = true;
        self.files_opened = true;
        self.changes_opened = true;
        self.threads_opened = true;
        self.theo_opened = true;
        self.model.restore(value).map(|_| ())
    }

    /// Ask for a panel by its own focus action, as a person's key would.
    fn focus(&mut self, action: &str) -> Vec<Effect> {
        self.update(Msg::Action {
            id: ActionId::new(action),
            actor: Actor::Human,
        })
    }

    /// Run an action for an agent run through the same `update` a key uses.
    /// The answer says the action was dispatched or why it was not; it does
    /// not say the effects succeeded.
    fn agent_act(
        &mut self,
        action: &str,
        run_id: &str,
        panel: Option<&str>,
    ) -> (AgentOutcome, Vec<Effect>) {
        match agent_request(action, run_id, panel) {
            Ok(msg) => self.run_for(msg),
            Err(refused) => (refused, vec![]),
        }
    }

    /// Run an action for the person, as the accessible overlay's buttons do.
    /// The same path and answer as `agent_act`; the actor is the only difference.
    fn person_act(&mut self, action: &str, panel: Option<&str>) -> (AgentOutcome, Vec<Effect>) {
        self.run_for(action_msg(action, Actor::Human, panel))
    }

    fn run_for(&mut self, msg: Msg) -> (AgentOutcome, Vec<Effect>) {
        self.model.capture_notices();
        let effects = self.update(msg);
        let notices = self.model.take_captured();
        (agent_outcome(&notices, effects.len()), effects)
    }

    /// Every action the registry offers, as the agent sees it (JSON).
    fn agent_catalog(&self) -> String {
        let catalog = self.model.registry().catalog(self.model.capabilities());
        serde_json::to_string(&catalog).unwrap_or_else(|_| "[]".to_owned())
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
    #[cfg(test)]
    fn key(&mut self, input: KeyInput) -> (bool, Vec<Effect>) {
        self.press(Some(input), None)
    }

    /// A keydown as `key_inputs` reads it. The positional chord wins only when the workbench
    /// would act on it, and is then consumed; otherwise the reported key goes its usual way, so
    /// Option still types its characters (é, ß) into a panel that binds nothing to them.
    fn press(
        &mut self,
        reported: Option<KeyInput>,
        positional: Option<KeyInput>,
    ) -> (bool, Vec<Effect>) {
        if let Some(chord) = positional
            && self.model.takes_chord(&chord)
        {
            return (true, self.update(Msg::Key(chord)));
        }
        match reported {
            Some(input) => self.reported_key(input),
            None => (false, vec![]),
        }
    }

    fn reported_key(&mut self, input: KeyInput) -> (bool, Vec<Effect>) {
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
        let has = |core: &Self, name: &str| core.model.capabilities().has(&Capability::new(name));
        // The default arrangement: Threads alone in the first group; Changes with Files beside
        // it in the last, Changes showing. Each opens as soon as the host grants what it needs
        // (the focus action is the core's own and is refused until then). All are asked for in
        // one step when the host serves them together, so Changes is the first tab whichever
        // answer reached the page first.
        let threads = !self.threads_opened && has(self, "threads");
        let changes = !self.changes_opened && has(self, "scm");
        let files = !self.files_opened && has(self, "files");
        if !self.theo_opened {
            self.theo_opened = true;
            effects.extend(self.focus("theo.focus"));
            // A fresh workbench (a restored layout sets `theo_opened`) whose last group has
            // nothing to show rests the picker there without taking keys, so it is never a dead
            // end: the composer keeps the focus.
            if !(changes || files) {
                self.model.rest_picker();
            }
        }
        if threads {
            self.threads_opened = true;
            effects.extend(self.focus("threads.focus"));
        }
        if changes {
            self.changes_opened = true;
            effects.extend(self.focus("changes.open"));
        }
        if files {
            self.files_opened = true;
            effects.extend(self.focus("files.focus"));
            if changes {
                effects.extend(self.focus("changes.open"));
            }
        }
        if threads || changes || files {
            if changes || files {
                // Real tools stand where the picker waited.
                self.model.dismiss_resting_picker();
            }
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

    /// Draws the frame. `view` ends with the icon pass, so no icon sentinel reaches the grid;
    /// the icons it collected are kept for the page's image layer.
    fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        self.icons = view(&self.model, area, frame.buffer_mut(), &self.theme);
    }

    /// The icons of the last frame as JSON (`PlacedIcon[]`).
    fn icons_json(&self) -> String {
        serde_json::to_string(&self.icons).unwrap_or_else(|_| "[]".to_owned())
    }
}

// --- the page ------------------------------------------------------------------------------

/// Hands effects and the semantic update to the page. Called with no borrow of
/// the core held.
/// An effect as the host callback receives it: the envelope names who it is
/// for, an agent run or (left out) the person.
fn effect_json(effect: &Effect) -> serde_json::Result<String> {
    serde_json::to_string(effect)
}

fn deliver(
    on_effect: &js_sys::Function,
    on_semantics: &js_sys::Function,
    effects: &[Effect],
    semantics: Option<&str>,
) {
    for effect in effects {
        match effect_json(effect) {
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

/// How the page draws the model's caret: an absolutely positioned element over the grid (never a
/// character or a cell style in it), blinking only when the panel asked and the person has not
/// asked for reduced motion (the model answers that as `Steady`), and the hidden input field
/// moved to the same cell so the IME's candidate window opens there.
fn caret_style(
    caret: Option<Caret>,
    cell: (f32, f32),
    typed_at: f64,
    now: f64,
    color: &str,
) -> CaretStyle {
    let (width, height) = cell;
    let hidden = CaretStyle {
        overlay: "display:none".to_owned(),
        field: String::new(),
    };
    let Some(caret) = caret else {
        return hidden;
    };
    let lit = match caret.phase {
        CaretPhase::Hidden => return hidden,
        CaretPhase::Steady => true,
        CaretPhase::Blinking => (((now - typed_at) / BLINK_MS) as u64).is_multiple_of(2),
    };
    let (left, top) = (f32::from(caret.x) * width, f32::from(caret.y) * height);
    let ink = if lit { color } else { "transparent" };
    let look = match caret.shape {
        CaretShape::HollowBlock => format!("border:1px solid {ink};width:{width}px"),
        CaretShape::FilledBlock => format!("background:{ink};width:{width}px"),
        CaretShape::Bar => format!("background:{ink};width:2px"),
    };
    CaretStyle {
        overlay: format!(
            "position:absolute;pointer-events:none;box-sizing:border-box;{look};\
             left:{left}px;top:{top}px;height:{height}px"
        ),
        field: format!("left:{left}px;top:{top}px;width:{width}px;height:{height}px"),
    }
}

/// What the frame loop draws.
struct Mounted {
    core: Rc<RefCell<Core>>,
    on_effect: js_sys::Function,
    on_semantics: js_sys::Function,
    /// Receives the frame's icons (JSON) when they differ from the last ones sent.
    on_icons: js_sys::Function,
    sent_icons: Option<String>,
    cell: (f32, f32),
    first_frame: Rc<RefCell<FirstFrame<js_sys::Function>>>,
}

impl Drawn for Mounted {
    fn set_cell(&mut self, cell: (f32, f32)) {
        self.cell = cell;
    }

    fn text_caret(&self, now: f64) -> Option<CaretStyle> {
        let core = self.core.borrow();
        let color = palette().sage.to_string();
        Some(caret_style(
            core.model.caret(),
            self.cell,
            core.typed_at,
            now,
            &color,
        ))
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
        let mut core = self.core.borrow_mut();
        core.draw(frame);
        // The panels that were not drawn in this frame report gone.
        core.cabinet.frame_end();
        core.conversations.face().frame_end();
    }

    fn drawn(&mut self) {
        // Called with no borrow of the core held, as every delivery to the page is.
        let icons = self.core.borrow().icons_json();
        if self.sent_icons.as_deref() != Some(&icons) {
            let _ = self
                .on_icons
                .call1(&JsValue::NULL, &JsValue::from_str(&icons));
            self.sent_icons = Some(icons);
        }
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
        let platform = self.core.borrow().platform;
        let mods = Modifiers::of(&event).mods(platform);
        let (reported, positional) = key_inputs(&event.key(), &event.code(), mods, platform);
        let (consumed, effects) = self.core.borrow_mut().press(reported, positional);
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

    /// A composition step (JSON `{type: "start"}`, `{type: "update", text}` or
    /// `{type: "end", text}`). The committed text of an `end` arrives here and
    /// never also through `text_input`.
    pub fn composition(&self, json: &str) -> Result<(), JsValue> {
        let input: CompositionInput = serde_json::from_str(json).map_err(js_error)?;
        self.send(Msg::Composition(input.into()));
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

    /// The person's reduced-motion preference, from
    /// `matchMedia('(prefers-reduced-motion: reduce)')`; call it on mount and
    /// again whenever that query changes.
    pub fn set_reduced_motion(&self, reduced: bool) {
        self.send(Msg::ReducedMotion(reduced));
    }

    /// The cabinet controller's view for `project` (JSON), given to the Artifacts panels.
    pub fn cabinet_set_view(&self, project: &str, json: &str) -> Result<(), JsValue> {
        let link = self.core.borrow().cabinet.clone();
        link.set_view(project, json).map_err(js_error)
    }

    /// Where the Artifacts panel is, as JSON, or nothing while `since` is the latest epoch.
    pub fn cabinet_geometry(&self, since: f64) -> Option<String> {
        self.core.borrow().cabinet.geometry_json(since as u64)
    }

    /// The actions the Artifacts panel's keys and pointer produced (a JSON array).
    pub fn cabinet_actions(&self) -> String {
        self.core.borrow().cabinet.take_actions()
    }

    /// A command from the page's own cabinet controls; true when the cabinet used it.
    pub fn cabinet_command(&self, json: &str) -> bool {
        let link = self.core.borrow().cabinet.clone();
        link.command(json)
    }

    /// Saved arrangements (JSON, the core's `ArrangementMsg`): `{"type":"load"}` once the adapter
    /// is ready and again after an account change; `save`, `apply`, `rename` and `delete`.
    pub fn arrangement(&self, json: &str) -> Result<(), JsValue> {
        let msg: ArrangementMsg = serde_json::from_str(json).map_err(js_error)?;
        self.send(Msg::Arrangement(msg));
        Ok(())
    }

    /// The presets and the account's saved arrangements, as JSON `[{name, builtin}]`.
    pub fn arrangements(&self) -> String {
        let list: Vec<Value> = self
            .core
            .borrow()
            .model
            .arrangements()
            .into_iter()
            .map(|a| json!({ "name": a.name, "builtin": a.builtin }))
            .collect();
        Value::Array(list).to_string()
    }

    /// The measured cell in CSS pixels as JSON `{width, height}`, once a frame has measured it.
    pub fn cell_size(&self) -> Option<String> {
        let core = self.core.borrow();
        let cell = core.cell?;
        Some(json!({ "width": cell.width_px, "height": cell.height_px }).to_string())
    }

    /// Whether the page has a face to lay over the Theo panel's reserved cells.
    pub fn set_face(&self, on: bool) {
        self.core.borrow().conversations.face().set_wanted(on);
    }

    /// The face's cells as JSON `{epoch, cells}`, or nothing while `since` is the latest epoch.
    pub fn face_geometry(&self, since: f64) -> Option<String> {
        self.core
            .borrow()
            .conversations
            .face()
            .geometry_json(since as u64)
    }

    /// The registry's actions as the agent sees them (JSON array of
    /// `CatalogEntry`): availability and reasons as they stand now. Human-only
    /// actions are listed with `humanOnly: true`; they are not the agent's to run.
    pub fn agent_catalog(&self) -> String {
        self.core.borrow().agent_catalog()
    }

    /// Run `action` for the agent run `run_id` through the same `update` a key
    /// uses, aimed at the panel instance `panel` (an id from the semantic tree)
    /// when given. Effects go out through the effect callback.
    ///
    /// Returns JSON, exactly one of
    /// `{"outcome":"accepted","effects":n,"notices":[...]}` or
    /// `{"outcome":"refused","code":"unknown_action"|"human_only"|"unavailable"|"unknown_panel"|"empty_run","reason":"..."}`.
    /// "accepted" means the action was dispatched, not that its effects
    /// succeeded: those are answered later as completions. A refusal emits
    /// nothing and changes nothing except the notice the person sees.
    pub fn agent_act(&self, action: &str, run_id: &str, panel: Option<String>) -> String {
        let (outcome, effects) = self
            .core
            .borrow_mut()
            .agent_act(action, run_id, panel.as_deref());
        deliver(&self.on_effect, &self.on_semantics, &effects, None);
        serde_json::to_string(&outcome).unwrap_or_default()
    }

    /// Run `action` for the person, aimed at `panel` when given: what a button
    /// of the accessible overlay does. Same path and same JSON as `agent_act`
    /// (`refused` codes: `unknown_action`, `unavailable`, `unknown_panel`), but
    /// the actor is the person, so human-only actions are allowed here and only
    /// here.
    pub fn act(&self, action: &str, panel: Option<String>) -> String {
        let (outcome, effects) = self.core.borrow_mut().person_act(action, panel.as_deref());
        deliver(&self.on_effect, &self.on_semantics, &effects, None);
        serde_json::to_string(&outcome).unwrap_or_default()
    }

    /// The semantic tree as it is now (JSON), the same one `on_semantics`
    /// publishes and `workbench.read` returns.
    pub fn semantics(&self) -> Result<String, JsValue> {
        serde_json::to_string(&semantics(&self.core.borrow().model)).map_err(js_error)
    }

    /// The icons of the last frame (JSON, `PlacedIcon[]`), the same ones `on_icons` delivers.
    pub fn icons(&self) -> String {
        self.core.borrow().icons_json()
    }

    /// Replaces the layout with a saved document (JSON). Until the layout
    /// owner's completion is routed to the model by `dispatch`, the page loads
    /// it here.
    pub fn restore(&self, json: &str) -> Result<(), JsValue> {
        let value: Value = serde_json::from_str(json).map_err(js_error)?;
        self.core.borrow_mut().restore(value).map_err(js_error)
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
/// (`{type: "full", tree}` or `{type: "diff", diff}`), `on_icons` the frame's icons
/// (`PlacedIcon[]`) each time they change. Frames run until the
/// element leaves the page; mount once per element.
#[wasm_bindgen]
pub fn mount_workbench(
    parent_id: &str,
    on_effect: js_sys::Function,
    on_semantics: js_sys::Function,
    on_icons: js_sys::Function,
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
            on_icons,
            sent_icons: None,
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

    /// Wide enough for the three groups side by side (224 + 480 + 320 px).
    const WIDE: Rect = Rect {
        x: 0,
        y: 0,
        width: 200,
        height: 40,
    };

    fn press(chord: &str) -> KeyInput {
        parse_chord(chord, Platform::Other).unwrap()
    }

    fn core() -> Core {
        core_ordered(false)
    }

    fn core_ordered(editor_first: bool) -> Core {
        let mut core = Core::with_editor_first(Platform::Other, editor_first);
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
    fn composition_steps_from_the_page_become_core_composition_messages() {
        let step =
            |json: &str| Composition::from(serde_json::from_str::<CompositionInput>(json).unwrap());
        assert_eq!(step(r#"{"type":"start"}"#), Composition::Start);
        assert_eq!(
            step(r#"{"type":"update","text":"にほ"}"#),
            Composition::Update {
                text: "にほ".into()
            }
        );
        assert_eq!(
            step(r#"{"type":"end","text":"日本"}"#),
            Composition::End {
                text: "日本".into()
            }
        );
        assert!(serde_json::from_str::<CompositionInput>(r#"{"type":"middle"}"#).is_err());
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
        // The syntax and ANSI roles are the palette's own, not roles derived from the state ones.
        assert_eq!(theme.syntax_keyword.fg, Some(p.syntax_keyword));
        assert_eq!(theme.syntax_string.fg, Some(p.syntax_string));
        assert_eq!(theme.syntax_name.fg, Some(p.syntax_variable));
        assert_eq!(theme.ansi, ansi_of(&p));
        // A popup's rows are text on a surface of their own: readable over what they cover.
        assert_eq!(theme.popup, Style::new().fg(p.ink).bg(p.raised));
        assert_ne!(theme.popup.fg, Some(p.line));
    }

    #[test]
    fn the_semantic_roles_draw_what_was_drawn_until_the_page_sends_them() {
        let p = Palette::default();
        let theme = theme_of(&p);
        assert_eq!(theme.canvas, Style::new().fg(p.ink).bg(p.bg));
        assert_eq!(theme.canvas.bg, theme.bg.bg);
        assert_eq!(theme.selected_region, Style::new());
        assert_eq!(theme.text_disabled, theme.muted);
        assert_eq!(theme.gutter, theme.muted);
        assert_eq!(theme.info, Style::new());
        // The marks of a diff's lines are the code colours Theo drew them in.
        assert_eq!(theme.diff_added_mark, Style::new().fg(p.syntax_tag));
        assert_eq!(theme.diff_removed_mark, Style::new().fg(p.syntax_keyword));
        // The transcript's roles resolve to the raised ground and the bright name it drew.
        assert_eq!(p.completed_row(), p.raised);
        assert_eq!(p.running_row(), p.raised);
        assert_eq!(p.pending_row(), p.raised);
        assert_eq!(p.failed_row(), p.raised);
        assert_eq!(p.completed_ink(), p.bright);
        assert_eq!(p.text_disabled(), p.muted);
        assert_eq!(p.diff_added_mark(), p.syntax_tag);
        assert_eq!(p.diff_removed_mark(), p.syntax_keyword);
    }

    #[test]
    fn a_page_that_sends_the_semantic_roles_changes_them_and_nothing_else() {
        let sent: Palette = serde_json::from_str(
            r##"{"canvas":"#101820","selectedRow":"#34445a","completedRow":"#101820",
                 "textDisabled":"#7a828a","info":"#58a6ff"}"##,
        )
        .expect("the roles parse beside the legacy keys");
        let base = Palette::default();
        let theme = theme_of(&sent);
        assert_eq!(theme.canvas.bg, Some(Color::Rgb(0x10, 0x18, 0x20)));
        // The panels keep their own ground; only the conversation's moves.
        assert_eq!(theme.bg, theme_of(&base).bg);
        assert_eq!(
            theme.selected_region,
            Style::new().bg(Color::Rgb(0x34, 0x44, 0x5a))
        );
        assert_eq!(sent.completed_row(), Color::Rgb(0x10, 0x18, 0x20));
        assert_eq!(sent.running_row(), base.raised);
        assert_eq!(theme.text_disabled.fg, Some(Color::Rgb(0x7a, 0x82, 0x8a)));
        assert_eq!(theme.gutter, theme.text_disabled);
        assert_eq!(theme.muted, theme_of(&base).muted);
        assert_eq!(theme.info.fg, Some(Color::Rgb(0x58, 0xa6, 0xff)));
        // A role sent as null is the same as one left out.
        let nulled: Palette = serde_json::from_str(r#"{"canvas":null}"#).expect("null parses");
        assert!(nulled == base);
    }

    #[test]
    fn the_chosen_thing_is_told_by_its_letters_and_never_by_a_band() {
        let p = Palette::default();
        let theme = theme_of(&p);
        let bold = Modifier::BOLD;
        // Where the panel holds the keyboard: the mark colour, bold, no background.
        assert_eq!(theme.focus, Style::new().fg(p.mark).add_modifier(bold));
        assert_eq!(theme.hunk_current, theme.focus);
        // Where it does not: bright ink, bold, no accent and no background.
        assert_eq!(theme.selected, Style::new().fg(p.bright).add_modifier(bold));
        // A popup's chosen row stands on the popup's own surface and nothing more.
        assert_eq!(theme.popup_selected.fg, Some(p.mark));
        assert_eq!(theme.popup_selected.bg, theme.popup.bg);
        assert_ne!(theme.popup_selected, theme.popup);
        // A search match is the mark colour, underlined; the current one is bold as well.
        assert_eq!(theme.search_match.fg, Some(p.mark));
        assert_eq!(theme.search_match.bg, None);
        assert!(
            theme
                .search_match
                .add_modifier
                .contains(Modifier::UNDERLINED)
        );
        assert_eq!(theme.current_match.fg, Some(p.mark));
        assert_eq!(theme.current_match.bg, None);
        assert!(
            theme
                .current_match
                .add_modifier
                .contains(bold | Modifier::UNDERLINED)
        );
        // What needs an extent keeps its fill: the caret, a focused field, a button, selected text.
        for filled in [theme.caret, theme.field_focus, theme.control] {
            assert_eq!(filled.bg, Some(p.focus));
        }
        assert_eq!(theme.selection.bg, Some(p.selection));
        // The bar beside the block being typed in is a glyph in the mark colour.
        assert_eq!(theme.editing_bar.fg, Some(p.mark));
        assert_eq!(theme.editing_bar.bg, None);
    }

    #[test]
    fn the_terminal_pane_marks_a_match_in_letters_too() {
        let p = Palette::default();
        let styles = process_styles();
        assert_eq!(styles.palette.search_match.bg, None);
        assert_eq!(styles.palette.search_current.bg, None);
        assert_eq!(styles.palette.search_match.fg, Some(p.mark));
        assert_eq!(styles.palette.search_current.fg, Some(p.mark));
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

    /// The tabs of each group, left to right, as `(role, kinds, kind showing)`.
    fn groups(core: &Core) -> Vec<(theorem_workbench_dock::Role, Vec<String>, Option<String>)> {
        let dock = core.model.dock();
        let mut shown: Vec<_> = dock
            .group_ids()
            .into_iter()
            .filter_map(|g| dock.group(g))
            .map(|g| {
                (
                    g.role(),
                    g.tabs().iter().map(|t| t.kind.name.clone()).collect(),
                    g.active().map(|t| t.kind.name.clone()),
                )
            })
            .collect();
        // Left to right: Files, Main, Tools, as the preset lays them out.
        shown.sort_by_key(|(role, _, _)| match role {
            theorem_workbench_dock::Role::Files => 0,
            theorem_workbench_dock::Role::Main => 1,
            theorem_workbench_dock::Role::Tools => 2,
        });
        shown
    }

    fn focused_kind(core: &Core) -> Option<String> {
        let focused = core.model.focus().panel?;
        core.model
            .panel_ids()
            .find(|(id, _)| **id == focused)
            .map(|(_, k)| k.as_str().to_owned())
    }

    fn tools_of(core: &Core) -> (Vec<String>, Option<String>) {
        let (_, tabs, showing) = groups(core).pop().expect("a last group");
        (tabs, showing)
    }

    #[test]
    fn a_fresh_workbench_has_threads_alone_on_the_left_and_changes_then_files_on_the_right() {
        use theorem_workbench_dock::Role;
        let mut core = core();
        granted(&mut core, &["files", "threads", "scm", "conversation"]);
        core.step(AREA, CELL, Theme::plain());
        let g = groups(&core);
        assert_eq!(g[0].0, Role::Files);
        assert_eq!(
            g[0].1,
            vec!["threads"],
            "Threads is the left group's only tab"
        );
        assert_eq!(g[1].1, vec!["theo"]);
        assert_eq!(g[2].1, vec!["changes", "files"]);
        assert_eq!(g[2].2.as_deref(), Some("changes"), "Changes shows");
        assert!(
            !kinds(&core).contains(&"picker".to_owned()),
            "no picker rests: {:?}",
            kinds(&core)
        );
        assert!(!core.model.picker().is_open());
        assert_eq!(focused_kind(&core).as_deref(), Some("theo"));
    }

    #[test]
    fn files_shows_alone_when_changes_cannot_open() {
        let mut core = core();
        granted(&mut core, &["files", "threads"]);
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(groups(&core)[0].1, vec!["threads"]);
        assert_eq!(
            tools_of(&core),
            (vec!["files".to_owned()], Some("files".to_owned()))
        );
        assert!(!core.model.picker().is_open());
        assert_eq!(focused_kind(&core).as_deref(), Some("theo"));
    }

    #[test]
    fn changes_shows_alone_when_files_cannot_open() {
        let mut core = core();
        granted(&mut core, &["scm"]);
        core.step(AREA, CELL, Theme::plain());
        assert!(
            groups(&core)[0].1.is_empty(),
            "no Threads without the grant"
        );
        assert_eq!(
            tools_of(&core),
            (vec!["changes".to_owned()], Some("changes".to_owned()))
        );
        assert!(!core.model.picker().is_open());
    }

    #[test]
    fn the_picker_rests_in_the_last_group_when_neither_changes_nor_files_can_open() {
        let mut core = core();
        granted(&mut core, &["threads", "conversation"]);
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(groups(&core)[0].1, vec!["threads"]);
        assert_eq!(
            tools_of(&core),
            (vec!["picker".to_owned()], Some("picker".to_owned()))
        );
        assert!(core.model.picker().is_resting());
        assert_eq!(focused_kind(&core).as_deref(), Some("theo"));
    }

    #[test]
    fn a_picker_the_person_opened_stays_when_changes_and_files_arrive() {
        let mut core = core();
        core.focus("picker.open");
        assert!(core.model.picker().holds_keys());
        granted(&mut core, &["files", "scm"]);
        core.step(AREA, CELL, Theme::plain());
        assert!(
            core.model.picker().holds_keys(),
            "the open picker keeps the keys"
        );
    }

    #[test]
    fn a_restored_layout_is_not_given_the_default_arrangement() {
        use theorem_workbench_dock::Role;
        let mut saved = core();
        granted(&mut saved, &["files", "threads", "scm"]);
        saved.step(WIDE, CELL, Theme::plain());
        // Someone moves Files to the left beside Threads and saves.
        saved.focus("files.focus");
        saved.focus("workbench.move.left");
        saved.focus("workbench.move.left");
        let moved = groups(&saved);
        assert_eq!(moved[0].0, Role::Files);
        assert!(moved[0].1.contains(&"files".to_owned()), "{moved:?}");
        let doc = saved.model.document();
        let mut fresh = core();
        fresh.restore(doc).unwrap();
        granted(&mut fresh, &["files", "threads", "scm"]);
        fresh.step(WIDE, CELL, Theme::plain());
        fresh.step(WIDE, CELL, Theme::plain());
        let g = groups(&fresh);
        assert_eq!(
            g[0].1, moved[0].1,
            "the saved arrangement comes back as saved"
        );
        assert_eq!(g[2].1, moved[2].1);
    }

    #[test]
    fn every_panel_of_the_default_arrangement_still_moves_and_closes() {
        let mut core = core();
        granted(&mut core, &["files", "threads", "scm"]);
        core.step(WIDE, CELL, Theme::plain());
        core.focus("threads.focus");
        core.focus("workbench.move.right");
        let in_main = groups(&core)
            .into_iter()
            .find(|g| g.0 == theorem_workbench_dock::Role::Main)
            .map(|g| g.1)
            .unwrap_or_default();
        assert!(in_main.contains(&"threads".to_owned()), "{in_main:?}");
        let files = core
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == "files")
            .map(|(id, _)| id.as_str().to_owned())
            .unwrap();
        core.focus(&format!("tab.close.{files}"));
        assert!(!kinds(&core).contains(&"files".to_owned()));
    }

    #[test]
    fn the_default_preset_seats_the_panels_of_a_running_workbench_as_a_fresh_one() {
        let mut core = core();
        granted(&mut core, &["files", "threads", "scm"]);
        core.step(WIDE, CELL, Theme::plain());
        let fresh = groups(&core);
        // Scatter: Files to the left, Threads to the right, and a picker resting beside them.
        core.focus("files.focus");
        core.focus("workbench.move.left");
        core.focus("threads.focus");
        core.focus("workbench.move.right");
        assert_ne!(groups(&core), fresh);
        core.focus("workbench.layout.default");
        let g = groups(&core);
        assert_eq!(g[0].1, vec!["threads"], "{g:?}");
        assert_eq!(g[2].1, vec!["changes", "files"], "{g:?}");
        assert_eq!(g[2].2.as_deref(), Some("changes"));
        assert_eq!(g[1].1, vec!["theo"]);
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

    /// The model's drawing as text, one row per line.
    fn drawn(core: &Core) -> String {
        let mut buf = ratatui::buffer::Buffer::empty(AREA);
        view(&core.model, AREA, &mut buf, &core.theme);
        (0..AREA.height)
            .map(|y| {
                (0..AREA.width)
                    .map(|x| buf[(x, y)].symbol().to_owned())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_frame_leaves_no_icon_marker_on_the_grid_and_hands_its_icons_to_the_page() {
        let core = opened_from_files("a.rs", false);
        let mut core = core;
        core.focus("files.focus");
        core.step(AREA, CELL, Theme::plain());
        let mut buf = ratatui::buffer::Buffer::empty(AREA);
        let icons = view(&core.model, AREA, &mut buf, &core.theme);
        for cell in &buf.content {
            assert!(
                !cell
                    .symbol()
                    .chars()
                    .any(|c| ('\u{10f000}'..='\u{10f1ff}').contains(&c)),
                "an icon marker reached the grid: {:?}",
                cell.symbol()
            );
        }
        assert!(
            icons
                .iter()
                .any(|i| i.icon == theorem_workbench_core::Icon::FileCode),
            "the Files panel draws a code file's icon: {icons:?}"
        );
        assert!(
            icons
                .iter()
                .all(|i| i.x + 2 <= AREA.width && i.y < AREA.height)
        );
        core.icons = icons.clone();
        let sent: Vec<theorem_workbench_core::PlacedIcon> =
            serde_json::from_str(&core.icons_json()).unwrap();
        assert_eq!(sent, icons);
    }

    fn granted(core: &mut Core, words: &[&'static str]) {
        core.update(Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(words.iter().copied()),
        }));
    }

    fn kinds(core: &Core) -> Vec<String> {
        core.model
            .panel_ids()
            .map(|(_, k)| k.as_str().to_owned())
            .collect()
    }

    #[test]
    fn text_typed_into_a_fresh_workbench_lands_in_the_composer() {
        let mut core = core();
        granted(&mut core, &["files", "conversation"]);
        core.step(AREA, CELL, Theme::plain());
        assert!(!core.model.focus().modal, "no picker holds the keys");
        assert!(
            !core.model.picker().is_open(),
            "Files stands where the picker waited"
        );
        let (consumed, _) = core.key(press("h"));
        assert!(
            !consumed,
            "a printable key is left to the host-input textarea"
        );
        core.update(Msg::Text("hello composer".into()));
        core.step(AREA, CELL, Theme::plain());
        let text = drawn(&core);
        assert!(text.contains("hello composer"), "{text}");
        assert!(
            !text.contains("No tools match"),
            "the text did not go to the picker's filter: {text}"
        );
    }

    #[test]
    fn the_process_pane_changes_and_the_editor_are_registered_and_open_from_their_actions() {
        let mut core = core();
        granted(
            &mut core,
            &["files", "environment", "terminal", "scm", "documents"],
        );
        core.step(AREA, CELL, Theme::plain());
        for (action, kind) in [("shell.choose", "shell"), ("changes.open", "changes")] {
            core.focus(action);
            assert!(
                kinds(&core).contains(&kind.to_owned()),
                "{action} opens a {kind} panel: {:?}",
                kinds(&core)
            );
        }
        // Not a placeholder: the registered panels serve their kinds.
        assert!(
            core.model
                .panel_ids()
                .all(|(id, _)| !core.model.is_unavailable(id))
        );
        // The workflow actions the crates add to their kinds resolve.
        for id in ["shell.attach", "shell.end.confirm", "changes.stage"] {
            assert!(
                core.model.registry().action(&ActionId::new(id)).is_some(),
                "{id} is in the registry"
            );
        }
    }

    /// Opens `name` from the Files panel and returns the kinds of the panels then open.
    fn open_from_files(name: &str, editor_first: bool) -> Vec<String> {
        kinds(&opened_from_files(name, editor_first))
    }

    /// The core after `name` was opened from the Files panel.
    fn opened_from_files(name: &str, editor_first: bool) -> Core {
        use theorem_workbench_core::{
            completion::{
                Completion, CompletionPayload, FileEntry, FileKind, FileListing, Outcome,
            },
            effect::EffectBody,
        };
        let mut core = core_ordered(editor_first);
        granted(&mut core, &["files", "documents"]);
        core.update(Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: Some("e".into()),
        }));
        let mut effects = core.step(AREA, CELL, Theme::plain()).effects;
        effects.extend(core.step(AREA, CELL, Theme::plain()).effects);
        let list = effects
            .iter()
            .find(|e| matches!(e.body, EffectBody::FilesList(_)))
            .expect("Files asks the host for the root listing");
        let mut done = Completion::new(list.id, list.resource.clone(), Outcome::Accepted);
        done.payload = Some(CompletionPayload::Files(FileListing {
            entries: vec![FileEntry::new(name, FileKind::File)],
            partial: false,
        }));
        core.update(Msg::Completion(done));
        core.step(AREA, CELL, Theme::plain());
        core.focus("files.focus");
        core.update(Msg::Key(press("Down")));
        let mut effects = core.update(Msg::Key(press("Enter")));
        effects.extend(core.step(AREA, CELL, Theme::plain()).effects);
        effects.extend(core.step(AREA, CELL, Theme::plain()).effects);
        let opens = |e: &theorem_workbench_core::Effect| {
            matches!(&e.body, EffectBody::DocumentOpen(_))
                && matches!(&e.resource, theorem_workbench_core::ResourceRef::Document { resource_id, .. } if resource_id == name)
        };
        assert!(
            effects.iter().any(opens),
            "the panel reads {name} through the core: {effects:?}"
        );
        core
    }

    #[test]
    fn a_markdown_file_opens_in_markdown_and_other_files_in_the_editor() {
        // The registration order does not decide it.
        for editor_first in [false, true] {
            let md = open_from_files("a.md", editor_first);
            assert!(md.contains(&"markdown".to_owned()), "{md:?}");
            assert!(!md.contains(&"document".to_owned()), "{md:?}");
            let rs = open_from_files("a.rs", editor_first);
            assert!(rs.contains(&"document".to_owned()), "{rs:?}");
            assert!(!rs.contains(&"markdown".to_owned()), "{rs:?}");
        }
    }

    /// R48, AC-59: the editor and the Markdown panel are two presentations of
    /// a Markdown document, swapped in the same tab, and only a Markdown one.
    #[test]
    fn a_markdown_document_is_shown_in_the_markdown_panel_or_the_editor_in_one_tab() {
        let kind_of = |core: &Core, id: &theorem_workbench_core::PanelInstanceId| {
            core.model
                .panel_ids()
                .find(|(p, _)| *p == id)
                .map(|(_, k)| k.as_str().to_owned())
        };
        let mut core = opened_from_files("a.md", false);
        let id = core
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == "markdown")
            .map(|(id, _)| id.clone())
            .expect("a.md opens in the Markdown panel");
        let listed: Vec<(String, bool, bool)> = core
            .model
            .presentations_of(&id)
            .into_iter()
            .map(|e| {
                (
                    e.kind.as_str().to_owned(),
                    e.current,
                    e.availability.is_available(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                ("document".to_owned(), false, true),
                ("markdown".to_owned(), true, true)
            ],
            "the editor is the default and is listed first"
        );
        let resource = core
            .model
            .panel(&id)
            .and_then(|p| p.binding())
            .unwrap()
            .resource;
        let place = core
            .model
            .dock()
            .find_panel(&theorem_workbench_dock::PanelId(id.as_str().to_owned()));

        // The Markdown panel has not settled its read yet: the swap waits for it
        // rather than lose or double it, and says so.
        let (first, _) = core.person_act("panel.presentation.next", Some(id.as_str()));
        assert!(matches!(first, AgentOutcome::Refused { .. }), "{first:?}");
        assert_eq!(kind_of(&core, &id).as_deref(), Some("markdown"));
        // Settle it as the host would: answer what the panel asked.
        let asked: Vec<_> = core
            .model
            .in_flight()
            .pending_for(&resource)
            .map(|(e, _)| *e)
            .collect();
        for effect in asked {
            core.update(Msg::Completion(
                theorem_workbench_core::completion::Completion::new(
                    effect,
                    resource.clone(),
                    theorem_workbench_core::completion::Outcome::Accepted,
                ),
            ));
        }
        let (second, _) = core.person_act("panel.presentation.next", Some(id.as_str()));
        assert!(
            matches!(second, AgentOutcome::Accepted { .. }),
            "{second:?}"
        );
        assert_eq!(kind_of(&core, &id).as_deref(), Some("document"));
        assert_eq!(
            core.model
                .panel(&id)
                .and_then(|p| p.binding())
                .unwrap()
                .resource,
            resource,
            "the same document"
        );
        assert_eq!(
            core.model
                .dock()
                .find_panel(&theorem_workbench_dock::PanelId(id.as_str().to_owned())),
            place,
            "the same group"
        );
        // A person's choice and an agent's go through the same checks.
        let (outcome, _) = core.agent_act(
            "panel.presentation.use:markdown",
            "run-1",
            Some(id.as_str()),
        );
        let refused = matches!(outcome, AgentOutcome::Refused { .. });
        assert!(
            refused || kind_of(&core, &id).as_deref() == Some("markdown"),
            "{outcome:?}"
        );
    }

    /// An editor that opened a source file offers no other way to show it.
    #[test]
    fn a_source_file_has_only_the_editor() {
        let core = opened_from_files("a.rs", false);
        let id = core
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == "document")
            .map(|(id, _)| id.clone())
            .expect("a.rs opens in the editor");
        let listed: Vec<String> = core
            .model
            .presentations_of(&id)
            .into_iter()
            .map(|e| e.kind.as_str().to_owned())
            .collect();
        assert_eq!(listed, ["document"]);
    }

    const IDE_WORDS: [&str; 10] = [
        "files",
        "environment",
        "documents",
        "search.query",
        "diagnostics.subscribe",
        "run.start",
        "run.subscribe",
        "run.list",
        "conversation",
        "scm",
    ];

    /// A workbench with the IDE words granted and a workspace named, settled.
    fn ide_core() -> Core {
        let mut core = core();
        granted(&mut core, &IDE_WORDS);
        core.update(Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: Some("e".into()),
        }));
        core.step(AREA, CELL, Theme::plain());
        core
    }

    /// Gives focus back to the open panel of `kind`, as a click on it would.
    fn focus_panel(core: &mut Core, kind: &str) {
        let id = core
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == kind)
            .map(|(id, _)| id.clone())
            .expect("the panel is open");
        core.update(Msg::Dock(theorem_workbench_core::msg::DockMsg::FocusPanel(
            id,
        )));
    }

    fn count(core: &Core, kind: &str) -> usize {
        kinds(core).iter().filter(|k| *k == kind).count()
    }

    #[test]
    fn search_diagnostics_and_run_output_open_from_their_actions_and_from_their_picker_rows() {
        for (action, kind, filter) in [
            ("search.open", "search", "Search"),
            ("diagnostics.open", "diagnostics", "Diagnostics"),
            ("run-output.open", "run-output", "Run output"),
        ] {
            let mut core = ide_core();
            core.focus(action);
            assert_eq!(count(&core, kind), 1, "{action}: {:?}", kinds(&core));
            assert!(
                core.model
                    .panel_ids()
                    .all(|(id, _)| !core.model.is_unavailable(id)),
                "{kind} is served, not a placeholder"
            );
            // The picker's row opens the same panel.
            let mut core = ide_core();
            core.update(Msg::Picker(theorem_workbench_core::picker::PickerMsg::Open));
            // These tools are listed under More tools: the row first, then the tool's.
            for text in ["More tools", filter] {
                core.update(Msg::Picker(
                    theorem_workbench_core::picker::PickerMsg::Filter(text.into()),
                ));
                core.step(AREA, CELL, Theme::plain());
                core.update(Msg::Key(press("Enter")));
            }
            core.step(AREA, CELL, Theme::plain());
            assert_eq!(count(&core, kind), 1, "{filter} row: {:?}", kinds(&core));
        }
        // The Run list actions are in the registry, gated on their word.
        let core = ide_core();
        for id in [
            "run.list",
            "run.attach",
            "search.run",
            "diagnostics.open-finding",
        ] {
            assert!(
                core.model.registry().action(&ActionId::new(id)).is_some(),
                "{id} is in the registry"
            );
        }
    }

    /// Delivers search rows for `paths` through the real panel and opens each by Enter.
    fn open_rows(paths: &[&str], presses: &[&str]) -> Core {
        use theorem_workbench_core::{
            completion::{Completion, CompletionPayload, Outcome, SearchStarted},
            effect::EffectBody,
            results::{MatchRange, ReadAt, SearchRow, SearchState, SpanEncoding},
        };
        let mut core = ide_core();
        core.focus("search.open");
        let mut effects = Vec::new();
        for c in "needle".chars() {
            effects.extend(core.update(Msg::Text(c.to_string())));
        }
        effects.extend(core.update(Msg::Key(press("Enter"))));
        let query = effects
            .iter()
            .find(|e| matches!(e.body, EffectBody::SearchQuery(_)))
            .expect("the panel sends the query")
            .clone();
        let mut started = Completion::new(query.id, query.resource.clone(), Outcome::Accepted);
        started.payload = Some(CompletionPayload::SearchStarted(SearchStarted {
            id: "s1".into(),
        }));
        core.update(Msg::Completion(started));
        let generation = core.model.workspace().generation.0;
        core.update(Msg::Host(HostMessage::SearchPage {
            id: "s1".into(),
            rows: paths
                .iter()
                .enumerate()
                .map(|(i, path)| SearchRow {
                    path: (*path).into(),
                    line: i as u32 + 1,
                    text: "a needle here".into(),
                    matches: vec![MatchRange { start: 2, end: 8 }],
                    text_offset: None,
                })
                .collect(),
            skipped: 0,
            state: SearchState::Complete,
            end: None,
            read_at: ReadAt {
                workspace_id: "w".into(),
                version: None,
                epoch: None,
                generation,
            },
            encoding: SpanEncoding::Utf16CodeUnits,
        }));
        core.step(AREA, CELL, Theme::plain());
        // Out of the query field and onto the rows, then the given presses.
        core.update(Msg::Key(press("Down")));
        for chord in presses {
            core.update(Msg::Key(press(chord)));
            core.step(AREA, CELL, Theme::plain());
        }
        core
    }

    #[test]
    fn a_search_row_opens_its_file_in_the_editor_or_markdown_and_never_a_second_copy() {
        let core = open_rows(&["a.rs", "b.md"], &["Enter"]);
        assert_eq!(count(&core, "document"), 1, "{:?}", kinds(&core));
        assert_eq!(count(&core, "markdown"), 0, "{:?}", kinds(&core));
        // A Markdown row opens the Markdown panel.
        let core = open_rows(&["a.rs", "b.md"], &["Down", "Enter"]);
        assert_eq!(count(&core, "markdown"), 1, "{:?}", kinds(&core));
        assert_eq!(count(&core, "document"), 0, "{:?}", kinds(&core));
        // The same row again moves the one open copy.
        let core = open_rows(&["a.rs", "a.rs"], &["Enter", "Down", "Enter"]);
        assert_eq!(count(&core, "document"), 1, "{:?}", kinds(&core));
    }

    #[test]
    fn a_finding_opens_its_file_in_the_editor_or_markdown_and_never_a_second_copy() {
        use theorem_workbench_core::{
            ids::Revision,
            results::{FindingAt, Position, Range, Severity, SpanEncoding},
        };
        let finding = |line| FindingAt {
            range: Range {
                start: Position { line, character: 0 },
                end: Position { line, character: 1 },
            },
            severity: Severity::Error,
            message: "broken".into(),
            source: None,
            code: None,
        };
        let mut core = ide_core();
        core.focus("diagnostics.open");
        for path in ["a.rs", "b.md"] {
            core.update(Msg::Host(HostMessage::DiagnosticsSet {
                path: path.into(),
                revision: Revision::Seq(1),
                encoding: SpanEncoding::Utf16CodeUnits,
                findings: vec![finding(0), finding(2)],
            }));
        }
        core.step(AREA, CELL, Theme::plain());
        core.update(Msg::Key(press("Enter")));
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(count(&core, "document"), 1, "{:?}", kinds(&core));
        // Back in the panel, the next finding of the same file moves the open copy.
        focus_panel(&mut core, "diagnostics");
        core.update(Msg::Key(press("Down")));
        core.update(Msg::Key(press("Enter")));
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(count(&core, "document"), 1, "{:?}", kinds(&core));
        // The Markdown file opens in the Markdown panel.
        focus_panel(&mut core, "diagnostics");
        core.update(Msg::Key(press("Down")));
        core.update(Msg::Key(press("Enter")));
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(count(&core, "markdown"), 1, "{:?}", kinds(&core));
        assert_eq!(count(&core, "document"), 1, "{:?}", kinds(&core));
    }

    /// A panel that only reports a caret, standing in for the composer.
    struct StandIn(CaretShape, CaretPhase);

    impl theorem_workbench_core::Panel for StandIn {
        fn update(
            &mut self,
            _: theorem_workbench_core::PanelMsg,
            _: &mut theorem_workbench_core::Ctx,
        ) {
        }
        fn view(
            &self,
            _: Rect,
            _: &mut ratatui::buffer::Buffer,
            _: &theorem_workbench_core::ViewCtx,
        ) {
        }
        fn semantics(
            &self,
            _: Rect,
            _: &theorem_workbench_core::ViewCtx,
        ) -> Vec<theorem_workbench_core::semantics::Node> {
            vec![]
        }
        fn serialize(&self) -> Value {
            Value::Null
        }
        fn caret(&self, area: Rect) -> Option<Caret> {
            Some(Caret {
                x: area.x + 3,
                y: area.y + 1,
                shape: self.0,
                phase: self.1,
            })
        }
    }

    fn with_stand_in(shape: CaretShape, phase: CaretPhase) -> Core {
        let mut core = Core::build(Platform::Other, false, |factories| {
            factories.register("theo", move |_, _| Box::new(StandIn(shape, phase)));
        });
        core.step(AREA, CELL, Theme::plain());
        granted(&mut core, &["files", "conversation"]);
        core.step(AREA, CELL, Theme::plain());
        core.step(AREA, CELL, Theme::plain());
        core
    }

    #[test]
    fn the_page_draws_the_models_caret_as_an_overlay_and_moves_the_input_field_to_it() {
        let core = with_stand_in(CaretShape::HollowBlock, CaretPhase::Steady);
        let caret = core
            .model
            .caret()
            .expect("the stand-in's caret is reported");
        let cell = (8.0, 16.0);
        let style = caret_style(Some(caret), cell, 0.0, 10_000.0, "#abc");
        // The cell it names, in pixels: one outline, no character in the grid.
        let (left, top) = (f32::from(caret.x) * 8.0, f32::from(caret.y) * 16.0);
        assert!(
            style
                .overlay
                .contains(&format!("left:{left}px;top:{top}px")),
            "{}",
            style.overlay
        );
        assert!(
            style.overlay.contains("border:1px solid #abc"),
            "{}",
            style.overlay
        );
        assert!(style.overlay.contains("pointer-events:none"));
        // The hidden field is on the same cell, so the candidate window opens there.
        assert!(
            style.field.contains(&format!("left:{left}px;top:{top}px")),
            "{}",
            style.field
        );
        assert!(
            !drawn(&core).contains('\u{2588}'),
            "the caret is not a character of the grid"
        );
    }

    #[test]
    fn a_blinking_caret_is_timed_by_the_root_and_a_steady_or_hidden_one_is_not() {
        let at = |phase| {
            let core = with_stand_in(CaretShape::Bar, phase);
            core.model.caret()
        };
        let blinking = at(CaretPhase::Blinking);
        let lit = caret_style(blinking, (8.0, 16.0), 0.0, 100.0, "red");
        let dark = caret_style(blinking, (8.0, 16.0), 0.0, BLINK_MS + 100.0, "red");
        assert!(lit.overlay.contains("background:red"), "{}", lit.overlay);
        assert!(
            dark.overlay.contains("background:transparent"),
            "{}",
            dark.overlay
        );
        // A key holds it solid again for a beat.
        let typed = caret_style(
            blinking,
            (8.0, 16.0),
            BLINK_MS + 50.0,
            BLINK_MS + 100.0,
            "red",
        );
        assert!(typed.overlay.contains("background:red"));
        // Steady never goes dark; Hidden and no caret show nothing.
        let steady = caret_style(
            at(CaretPhase::Steady),
            (8.0, 16.0),
            0.0,
            BLINK_MS + 100.0,
            "red",
        );
        assert!(steady.overlay.contains("background:red"));
        for none in [at(CaretPhase::Hidden), None] {
            assert_eq!(
                caret_style(none, (8.0, 16.0), 0.0, 0.0, "red").overlay,
                "display:none"
            );
        }
    }

    #[test]
    fn reduced_motion_makes_a_blinking_caret_steady() {
        let mut core = with_stand_in(CaretShape::FilledBlock, CaretPhase::Blinking);
        assert_eq!(core.model.caret().unwrap().phase, CaretPhase::Blinking);
        core.update(Msg::ReducedMotion(true));
        core.step(AREA, CELL, Theme::plain());
        assert_eq!(core.model.caret().unwrap().phase, CaretPhase::Steady);
    }

    #[test]
    fn a_shifted_command_letter_is_upper_case_whatever_case_the_browser_sent() {
        let mods = Mods::SHIFT | Mods::CMD;
        let lower = key_input("z", mods).unwrap();
        assert_eq!(lower, key_input("Z", mods).unwrap());
        assert_eq!(lower.key(), Key::Char('Z'));
        // Without Shift, or without a command key, the letter is as it came.
        assert_eq!(key_input("z", Mods::CMD).unwrap().key(), Key::Char('z'));
        assert_eq!(key_input("z", Mods::SHIFT).unwrap().key(), Key::Char('z'));
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

    /// A Mac's Cmd+Option, as the DOM reports the modifiers.
    fn cmd_option() -> Mods {
        Modifiers {
            ctrl_key: false,
            alt_key: true,
            shift_key: false,
            meta_key: true,
        }
        .mods(Platform::Mac)
    }

    #[test]
    fn a_key_is_named_by_its_position_for_letters_digits_and_punctuation_only() {
        assert_eq!(positional_key("KeyT").as_deref(), Some("t"));
        assert_eq!(positional_key("Digit4").as_deref(), Some("4"));
        assert_eq!(positional_key("BracketRight").as_deref(), Some("]"));
        assert_eq!(positional_key("Backslash").as_deref(), Some("\\"));
        for other in ["ArrowLeft", "Enter", "Keypad", "KeyTT", "Digit", "F5", ""] {
            assert_eq!(positional_key(other), None, "{other}");
        }
    }

    #[test]
    fn on_a_mac_an_option_chord_is_read_by_position_and_nowhere_else() {
        // Option+T reports a dagger and Option+E a dead key; the chord is the letter on the key.
        let (reported, positional) = key_inputs("\u{2020}", "KeyT", cmd_option(), Platform::Mac);
        assert_eq!(reported.map(|k| k.key()), Some(Key::Char('\u{2020}')));
        assert_eq!(positional.map(|k| k.key()), Some(Key::Char('t')));
        let (reported, positional) = key_inputs("Dead", "KeyE", cmd_option(), Platform::Mac);
        assert!(reported.is_none());
        assert_eq!(positional.map(|k| k.key()), Some(Key::Char('e')));
        // No Option, or not a Mac: only what the browser reports.
        let cmd = Modifiers {
            ctrl_key: false,
            alt_key: false,
            shift_key: false,
            meta_key: true,
        }
        .mods(Platform::Mac);
        assert!(key_inputs("t", "KeyT", cmd, Platform::Mac).1.is_none());
        let ctrl_alt = press("Ctrl+Alt+t").mods();
        assert!(
            key_inputs("t", "KeyT", ctrl_alt, Platform::Other)
                .1
                .is_none()
        );
    }

    #[test]
    fn on_a_mac_a_shifted_option_letter_is_the_capital_the_panels_bind() {
        let option_shift = Modifiers {
            ctrl_key: false,
            alt_key: true,
            shift_key: true,
            meta_key: false,
        }
        .mods(Platform::Mac);
        // Option+Shift+F reports "\u{cf}"; the editor binds Alt+F with the capital.
        let (_, positional) = key_inputs("\u{cf}", "KeyF", option_shift, Platform::Mac);
        assert_eq!(positional.map(|k| k.key()), Some(Key::Char('F')));
        // A digit and a punctuation key have no capital.
        let (_, positional) = key_inputs("\u{201a}", "Digit4", option_shift, Platform::Mac);
        assert_eq!(positional.map(|k| k.key()), Some(Key::Char('4')));
    }

    #[test]
    fn a_mac_option_chord_the_table_binds_runs_and_is_consumed() {
        let mut core = Core::new(Platform::Mac);
        core.step(AREA, CELL, Theme::plain());
        let (reported, positional) = key_inputs("\u{2020}", "KeyT", cmd_option(), Platform::Mac);
        let (consumed, _) = core.press(reported, positional);
        assert!(consumed);
        assert!(core.model.focus().modal, "the picker opened");
        // A dead key: nothing reported, and the chord still runs.
        let mut core = Core::new(Platform::Mac);
        core.step(AREA, CELL, Theme::plain());
        core.update(Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(["files"]),
        }));
        let (reported, positional) = key_inputs("Dead", "KeyE", cmd_option(), Platform::Mac);
        let (consumed, _) = core.press(reported, positional);
        assert!(consumed, "Cmd+Option+E focuses Files");
    }

    #[test]
    fn a_mac_option_key_nothing_binds_still_types_its_character() {
        let mut core = Core::new(Platform::Mac);
        core.step(AREA, CELL, Theme::plain());
        // Option+S alone: the composer binds nothing to it, so the sharp s is the browser's to type.
        let option = Modifiers {
            ctrl_key: false,
            alt_key: true,
            shift_key: false,
            meta_key: false,
        }
        .mods(Platform::Mac);
        let (reported, positional) = key_inputs("\u{df}", "KeyS", option, Platform::Mac);
        assert!(positional.is_some());
        let (consumed, _) = core.press(reported, positional);
        assert!(!consumed);
        // A dead key nothing binds is not touched at all: the browser composes the accent.
        let (reported, positional) = key_inputs("Dead", "KeyU", option, Platform::Mac);
        let (consumed, effects) = core.press(reported, positional);
        assert!(!consumed && effects.is_empty());
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

    // ---- the agent's entry ----

    fn agent_json(
        core: &mut Core,
        action: &str,
        run: &str,
        panel: Option<&str>,
    ) -> (Value, Vec<Effect>) {
        let (outcome, effects) = core.agent_act(action, run, panel);
        (serde_json::to_value(&outcome).unwrap(), effects)
    }

    fn chord_of(core: &Core, action: &str) -> KeyInput {
        let shortcut = core
            .model
            .registry()
            .default_shortcuts()
            .into_iter()
            .find(|s| s.action.as_str() == action)
            .expect("the action has a default chord");
        press(&shortcut.chord)
    }

    fn state(core: &Core) -> (Value, Value) {
        (
            core.model.document(),
            serde_json::to_value(semantics(&core.model)).unwrap(),
        )
    }

    #[test]
    fn an_accepted_agent_action_changes_the_model_as_the_key_does() {
        let (mut by_key, mut by_agent) = (core(), core());
        let chord = chord_of(&by_key, "picker.open");
        by_key.key(chord);
        let (said, effects) = agent_json(&mut by_agent, "picker.open", "run-1", None);
        assert_eq!(
            said,
            json!({"outcome": "accepted", "effects": 0, "notices": []})
        );
        assert!(effects.is_empty());
        assert_eq!(state(&by_agent), state(&by_key));
        assert!(by_agent.model.focus().modal, "the picker is open");
    }

    #[test]
    fn each_refusal_has_its_code_emits_nothing_and_changes_nothing_but_the_notice() {
        let cases = [
            ("no.such.action", "run-1", None, "unknown_action"),
            ("approval.allow", "run-1", None, "human_only"),
            ("files.focus", "run-1", None, "unavailable"),
            ("theo.focus", "run-1", Some("p-none"), "unknown_panel"),
            ("theo.focus", "   ", None, "empty_run"),
            ("theo.focus", "", None, "empty_run"),
        ];
        for (action, run, panel, code) in cases {
            let mut core = core();
            let before = state(&core);
            let in_flight = core.model.in_flight().len();
            let (said, effects) = agent_json(&mut core, action, run, panel);
            assert_eq!(said["outcome"], "refused", "{action}: {said}");
            assert_eq!(said["code"], code, "{action}: {said}");
            assert!(
                said["reason"].as_str().is_some_and(|r| !r.is_empty()),
                "{action}: a readable reason"
            );
            assert!(effects.is_empty(), "{action}");
            assert_eq!(core.model.in_flight().len(), in_flight, "{action}");
            assert_eq!(
                state(&core).0,
                before.0,
                "{action}: the layout is untouched"
            );
        }
        // The human-only refusal names the run.
        let mut core = core();
        let (said, _) = agent_json(&mut core, "approval.allow", "run-9", None);
        assert!(said["reason"].as_str().unwrap().contains("run-9"), "{said}");
    }

    #[test]
    fn an_agents_effect_carries_its_run_to_the_host_callback_and_a_keys_does_not() {
        let mut core = ide_core();
        agent_json(&mut core, "changes.open", "run-1", None);
        core.step(AREA, CELL, Theme::plain());
        let (said, effects) = agent_json(&mut core, "changes.refresh", "run-7", None);
        assert_eq!(said["outcome"], "accepted", "{said}");
        assert!(!effects.is_empty(), "refresh asks the host for something");
        assert_eq!(said["effects"], effects.len());
        for effect in &effects {
            let wire: Value = serde_json::from_str(&effect_json(effect).unwrap()).unwrap();
            assert_eq!(
                wire["actor"],
                json!({"type": "agent", "runId": "run-7"}),
                "{wire}"
            );
        }
        // What the page's own ticks and keys emit is the person's: no actor.
        let mut ticked = core.step(AREA, CELL, Theme::plain()).effects;
        ticked.extend(core.update(Msg::Tick));
        for effect in &ticked {
            let wire: Value = serde_json::from_str(&effect_json(effect).unwrap()).unwrap();
            assert!(wire.get("actor").is_none(), "{wire}");
        }
    }

    #[test]
    fn a_panel_instance_id_from_the_tree_is_the_handle_an_agent_aims_with() {
        let mut core = ide_core();
        agent_json(&mut core, "changes.open", "r", None);
        agent_json(&mut core, "diagnostics.open", "r", None);
        core.step(AREA, CELL, Theme::plain());
        let tree = semantics(&core.model);
        let tab_of = |kind: &str| {
            core.model
                .panel_ids()
                .find(|(_, k)| k.as_str() == kind)
                .map(|(id, _)| id.as_str().to_owned())
                .unwrap()
        };
        let (changes, diag) = (tab_of("changes"), tab_of("diagnostics"));
        assert!(
            tree.nodes
                .iter()
                .any(|n| n.id.as_str() == format!("tab:{changes}"))
        );
        // A Local action aimed at a panel of another kind is refused, at the right one it runs.
        let (said, _) = agent_json(&mut core, "changes.cursorDown", "r", Some(&diag));
        assert_eq!(said["code"], "unavailable", "{said}");
        let (said, _) = agent_json(&mut core, "changes.cursorDown", "r", Some(&changes));
        assert_eq!(said["outcome"], "accepted", "{said}");
    }

    #[test]
    fn the_nodes_actions_run_for_an_agent_as_a_click_would() {
        // A tab's own actions: focus then close.
        let mut by_click = ide_core();
        let mut by_agent = ide_core();
        for core in [&mut by_click, &mut by_agent] {
            agent_json(core, "changes.open", "r", None);
            agent_json(core, "diagnostics.open", "r", None);
            core.step(AREA, CELL, Theme::plain());
        }
        let diag = by_agent
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == "diagnostics")
            .map(|(id, _)| id.clone())
            .unwrap();
        by_click.update(Msg::Dock(theorem_workbench_core::DockMsg::FocusPanel(
            diag.clone(),
        )));
        let (said, _) = agent_json(
            &mut by_agent,
            &format!("tab.focus.{}", diag.as_str()),
            "r",
            None,
        );
        assert_eq!(said["outcome"], "accepted", "{said}");
        assert_eq!(state(&by_agent).0, state(&by_click).0);

        by_click.update(Msg::Dock(theorem_workbench_core::DockMsg::ClosePanel(
            diag.clone(),
        )));
        let (said, effects) = agent_json(
            &mut by_agent,
            &format!("tab.close.{}", diag.as_str()),
            "r",
            None,
        );
        assert_eq!(said["outcome"], "accepted", "{said}");
        assert!(
            effects
                .iter()
                .all(|e| e.actor == Actor::Agent { run_id: "r".into() })
        );
        assert_eq!(state(&by_agent).0, state(&by_click).0);

        // The picker's own actions: an agent opens it, pins a tool and steps back.
        let mut core = ide_core();
        agent_json(&mut core, "picker.open", "r", None);
        core.step(AREA, CELL, Theme::plain());
        // A row's own action, as the tree names it, runs the tool the row stands for.
        let row = semantics(&core.model)
            .nodes
            .iter()
            .find(|n| n.id.as_str().ends_with("/row-0"))
            .and_then(|n| n.actions.first().map(|a| a.id.as_str().to_owned()))
            .expect("the first row offers its action");
        assert!(core.model.focus().modal);
        let (said, _) = agent_json(&mut core, &row, "r", None);
        assert_eq!(said["outcome"], "accepted", "{said}");
        assert!(
            !core.model.focus().modal,
            "choosing the row closes the picker as a click does"
        );
        agent_json(&mut core, "picker.open", "r", None);
        core.step(AREA, CELL, Theme::plain());
        let (said, _) = agent_json(&mut core, "picker.toggle-pin", "r", None);
        assert_eq!(said["outcome"], "accepted", "{said}");
        let (said, _) = agent_json(&mut core, "picker.back", "r", None);
        assert_eq!(said["outcome"], "accepted", "{said}");

        // A panel node's action: every action a node of the tree names that the
        // agent catalogue lists resolves for it the same way, so none is refused as unknown.
        let tree = semantics(&core.model);
        let catalog = core.model.registry().catalog(core.model.capabilities());
        for node in &tree.nodes {
            for offered in &node.actions {
                let id = offered.id.as_str();
                let known = catalog.iter().any(|e| e.action.as_str() == id)
                    || id.starts_with("tab.")
                    || id.starts_with("picker.");
                assert!(
                    known,
                    "{id} on node {} is not runnable by an agent",
                    node.id.as_str()
                );
            }
        }
    }

    #[test]
    fn a_node_action_cannot_carry_an_agent_to_a_human_only_operation() {
        let mut core = ide_core();
        for human_only in [
            "approval.allow",
            "approval.deny",
            "changes.confirm",
            "shell.end.confirm",
            "run.stop-confirm",
        ] {
            let mut c = ide_core();
            let before = state(&c).0;
            let (said, effects) = agent_json(&mut c, human_only, "run-3", None);
            assert_eq!(said["code"], "human_only", "{human_only}: {said}");
            assert!(effects.is_empty());
            assert_eq!(state(&c).0, before);
        }
        // Dressing it up as a node action: an unknown tab or picker id is
        // refused rather than guessed, and naming the panel changes nothing.
        let (said, _) = agent_json(&mut core, "tab.close.nope", "run-3", None);
        assert_eq!(said["code"], "unknown_panel", "{said}");
        let (said, _) = agent_json(&mut core, "picker.pin.not-a-kind", "run-3", None);
        assert_eq!(said["code"], "unknown_action", "{said}");
        let theo = core
            .model
            .panel_ids()
            .find(|(_, k)| k.as_str() == "theo")
            .map(|(id, _)| id.as_str().to_owned())
            .unwrap();
        let (said, _) = agent_json(&mut core, "approval.allow", "run-3", Some(&theo));
        assert_eq!(said["code"], "human_only", "{said}");
    }

    #[test]
    fn the_catalog_lists_every_action_marks_the_human_only_ones_and_keeps_availability() {
        let core = core();
        let catalog: Vec<Value> = serde_json::from_str(&core.agent_catalog()).unwrap();
        let find = |id: &str| {
            catalog
                .iter()
                .find(|e| e["action"] == id)
                .unwrap_or_else(|| panic!("{id}"))
        };
        assert_eq!(find("approval.allow")["humanOnly"], true);
        assert_eq!(find("picker.open")["humanOnly"], false);
        assert_eq!(
            find("picker.open")["availability"],
            json!({"type": "available"})
        );
        let files = find("files.focus");
        assert_eq!(files["availability"]["type"], "unavailable");
        assert!(
            files["availability"]["reason"]
                .as_str()
                .is_some_and(|r| !r.is_empty())
        );
        // The same registrations the picker resolves.
        let registry = core.model.registry().catalog(core.model.capabilities());
        assert_eq!(catalog.len(), registry.len());
    }

    #[test]
    fn a_human_only_action_is_accepted_for_the_person_and_refused_for_an_agent() {
        let mut core = core();
        let (said, _) = core.person_act("approval.allow", None);
        assert_eq!(
            serde_json::to_value(&said).unwrap()["outcome"],
            "accepted",
            "{said:?}"
        );
        let (said, effects) = agent_json(&mut core, "approval.allow", "run-1", None);
        assert_eq!(said["code"], "human_only", "{said}");
        assert!(effects.is_empty());
        // The overlay's refusals use the same codes.
        for (action, panel, code) in [
            ("no.such.action", None, "unknown_action"),
            ("files.focus", None, "unavailable"),
            ("theo.focus", Some("p-none"), "unknown_panel"),
        ] {
            let (said, effects) = core.person_act(action, panel);
            let said = serde_json::to_value(&said).unwrap();
            assert_eq!(said["code"], code, "{action}: {said}");
            assert!(effects.is_empty());
        }
    }

    #[test]
    fn the_persons_effect_reaches_the_host_callback_without_an_actor() {
        let mut core = ide_core();
        core.person_act("changes.open", None);
        core.step(AREA, CELL, Theme::plain());
        let (said, effects) = core.person_act("changes.refresh", None);
        assert_eq!(serde_json::to_value(&said).unwrap()["outcome"], "accepted");
        assert!(!effects.is_empty());
        for effect in &effects {
            assert_eq!(effect.actor, Actor::Human);
            let wire: Value = serde_json::from_str(&effect_json(effect).unwrap()).unwrap();
            assert!(wire.get("actor").is_none(), "{wire}");
        }
    }
}
