//! A real root around one panel: keys, the pointer, completions and host messages go in as
//! `Msg`; effects, cells, opens and the semantic tree come out.
#![allow(dead_code)]

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::Value;
use std::cell::RefCell;
use std::rc::Rc;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ActionId, Actor, PanelInstanceId};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::{Node, Role};
use theorem_workbench_core::{
    Button, Ctx, Model, Msg, OpenTarget, Panel, PanelFactories, PanelMsg, Pointer, PointerKind,
    Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

pub const WORKSPACE: &str = "ws";

pub fn agent() -> Actor {
    Actor::Agent {
        run_id: "run".into(),
    }
}

/// What the stand-in document panel was built with, in order: the state an opener gave it.
pub type Opened = Rc<RefCell<Vec<Value>>>;

/// A stand-in for the editor the real workbench registers: it keeps the state it was built
/// with and the places it was asked to reveal.
struct Doc {
    reveals: Rc<RefCell<Vec<(u32, u32)>>>,
    path: String,
}

impl Panel for Doc {
    fn update(&mut self, msg: PanelMsg, _cx: &mut Ctx) {
        if let PanelMsg::Reveal { line, column } = msg {
            self.reveals.borrow_mut().push((line, column));
        }
    }
    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}
    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![Node::new("doc", Role::Region, &self.path, area)]
    }
    fn serialize(&self) -> Value {
        serde_json::json!({ "path": self.path })
    }
}

pub struct Rig {
    pub m: Model,
    pub id: PanelInstanceId,
    pub opened: Opened,
    pub reveals: Rc<RefCell<Vec<(u32, u32)>>>,
}

fn model(
    caps: &[&'static str],
    opened: &Opened,
    reveals: &Rc<RefCell<Vec<(u32, u32)>>>,
    kind: &str,
    state: Option<&Value>,
) -> Model {
    let mut registry = builtin::registry();
    theorem_workbench_ide::extend_registry(&mut registry).expect("the actions register");
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let mut factories = PanelFactories::new();
    theorem_workbench_ide::register(&mut factories);
    // A panel the layout restores: the host builds it from saved view state.
    if let Some(state) = state {
        let state = state.clone();
        match kind {
            "search" => factories.register(kind, move |_, _| {
                Box::new(theorem_workbench_ide::SearchPanel::restore(&state))
            }),
            "diagnostics" => factories.register(kind, move |_, _| {
                Box::new(theorem_workbench_ide::DiagnosticsPanel::restore(&state))
            }),
            _ => factories.register(kind, move |_, _| {
                Box::new(theorem_workbench_ide::RunPanel::restore(&state))
            }),
        }
    }
    let (o, r) = (opened.clone(), reveals.clone());
    factories.register("document", move |state, _| {
        o.borrow_mut().push(state.clone());
        Box::new(Doc {
            reveals: r.clone(),
            path: state["path"].as_str().unwrap_or("").to_owned(),
        })
    });
    factories.register_opener("document", |t| {
        matches!(t, OpenTarget::File { .. } | OpenTarget::FileAt { .. })
    });
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(
        registry,
        factories,
        keys,
        Capabilities::of(caps.iter().copied()),
        dock,
    );
    update(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    m
}

/// Opens the panel of `kind` in a workspace and ticks once. Returns the effects that made.
pub fn open(kind: &str, caps: &[&'static str], workspace: &str) -> (Rig, Vec<Effect>) {
    open_with(kind, caps, workspace, None)
}

/// As `open`, with the panel restored from saved view state.
pub fn open_with(
    kind: &str,
    caps: &[&'static str],
    workspace: &str,
    state: Option<Value>,
) -> (Rig, Vec<Effect>) {
    let opened: Opened = Rc::default();
    let reveals = Rc::default();
    let mut m = model(caps, &opened, &reveals, kind, state.as_ref());
    if !workspace.is_empty() {
        update(
            &mut m,
            Msg::Host(HostMessage::WorkspaceChanged {
                workspace: workspace.into(),
                environment: None,
            }),
        );
    }
    let mut fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new(format!("{kind}.open")),
            actor: Actor::Human,
        },
    );
    let id = m
        .panel_ids()
        .find(|(_, k)| k.as_str() == kind)
        .map(|(id, _)| id.clone())
        .unwrap_or_else(|| panic!("a {kind} panel is open"));
    fx.extend(update(&mut m, Msg::Tick));
    (
        Rig {
            m,
            id,
            opened,
            reveals,
        },
        fx,
    )
}

impl Rig {
    /// Resizes the whole screen. The panel is told its new body.
    pub fn resize(&mut self, width: u16, height: u16) {
        self.send(Msg::Resize {
            area: Rect::new(0, 0, width, height),
            metrics: CellMetrics::new(8.0, 16.0),
        });
    }

    /// The screen size at which the panel's body is 80 columns by 24 rows, the size the
    /// renders are checked at. Fails loudly if the dock stops solving to that.
    pub fn standard(&mut self) {
        self.resize(269, 25);
        let b = self.body();
        assert_eq!((b.width, b.height), (80, 24), "the dock layout changed");
    }

    pub fn send(&mut self, msg: Msg) -> Vec<Effect> {
        update(&mut self.m, msg)
    }

    pub fn key(&mut self, key: Key) -> Vec<Effect> {
        self.mods(key, Mods::NONE)
    }

    pub fn mods(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
        self.send(Msg::Key(KeyInput::new(key, mods)))
    }

    pub fn ch(&mut self, c: char) -> Vec<Effect> {
        self.key(Key::Char(c))
    }

    pub fn typed(&mut self, text: &str) {
        for c in text.chars() {
            self.ch(c);
        }
    }

    /// Moves focus to a panel's output area (the third field) and types `c` there.
    pub fn key_in_output(&mut self, c: char) -> Vec<Effect> {
        self.key(Key::Esc);
        self.ch(c)
    }

    pub fn tick(&mut self) -> Vec<Effect> {
        self.send(Msg::Tick)
    }

    pub fn ticks(&mut self, n: usize) -> Vec<Effect> {
        (0..n).flat_map(|_| self.tick()).collect()
    }

    pub fn action(&mut self, id: &str, actor: Actor) -> Vec<Effect> {
        self.send(Msg::Action {
            id: ActionId::new(id),
            actor,
        })
    }

    pub fn host(&mut self, message: HostMessage) -> Vec<Effect> {
        self.send(Msg::Host(message))
    }

    pub fn answer(
        &mut self,
        effect: &Effect,
        outcome: Outcome,
        payload: Option<CompletionPayload>,
    ) -> Vec<Effect> {
        let mut c = Completion::new(effect.id, effect.resource.clone(), outcome);
        c.generation = effect.generation;
        c.revision = effect.revision.clone();
        c.payload = payload;
        self.send(Msg::Completion(c))
    }

    pub fn accept(&mut self, effect: &Effect, payload: CompletionPayload) -> Vec<Effect> {
        self.answer(effect, Outcome::Accepted, Some(payload))
    }

    pub fn refuse(&mut self, effect: &Effect, code: &str, reason: &str) -> Vec<Effect> {
        self.answer(
            effect,
            Outcome::Refused {
                code: code.into(),
                reason: reason.into(),
            },
            None,
        )
    }

    /// Closes the panel's view. Closing never destroys what it showed.
    pub fn close(&mut self) -> Vec<Effect> {
        let id = self.id.clone();
        self.send(Msg::Dock(theorem_workbench_core::msg::DockMsg::ClosePanel(
            id,
        )))
    }

    pub fn panel(&self) -> &dyn Panel {
        self.m.panel(&self.id).expect("the panel")
    }

    /// The panel's body in the solved layout.
    pub fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the panel's group")
            .body
    }

    pub fn cells(&self, theme: &Theme, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let mut cx =
            ViewCtx::new(theme, self.m.workspace()).with_capabilities(self.m.capabilities());
        cx.focused = true;
        self.panel().view(area, &mut buf, &cx);
        buf
    }

    /// The panel drawn at its own body size under the plain theme, as lines of text.
    pub fn screen(&self) -> Vec<String> {
        let b = self.body();
        lines(&self.cells(&Theme::plain(), b.width, b.height))
    }

    pub fn text(&self) -> String {
        self.screen().join("\n")
    }

    pub fn nodes(&self) -> Vec<Node> {
        // A panel that another tab has covered keeps its last size.
        let b = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.body()))
            .unwrap_or(Rect::new(0, 0, 80, 24));
        let theme = Theme::plain();
        let mut cx =
            ViewCtx::new(&theme, self.m.workspace()).with_capabilities(self.m.capabilities());
        cx.focused = true;
        self.panel()
            .semantics(Rect::new(0, 0, b.width, b.height), &cx)
    }

    pub fn node(&self, id: &str) -> Node {
        self.nodes()
            .into_iter()
            .find(|n| n.id.as_str() == id)
            .unwrap_or_else(|| panic!("no node {id}"))
    }

    pub fn press(&mut self, x: u16, y: u16) -> Vec<Effect> {
        let b = self.body();
        let mut fx = vec![];
        for (kind, clicks) in [
            (PointerKind::Down(Button::Left), 1),
            (PointerKind::Up(Button::Left), 1),
        ] {
            fx.extend(self.send(Msg::Pointer(Pointer {
                kind,
                x: b.x + x,
                y: b.y + y,
                mods: Mods::NONE,
                clicks,
            })));
        }
        fx
    }

    /// The column and row where `needle` starts in the panel's body.
    pub fn find(&self, needle: &str) -> (u16, u16) {
        for (y, line) in self.screen().iter().enumerate() {
            if let Some(at) = line.find(needle) {
                return (line[..at].chars().count() as u16, y as u16);
            }
        }
        panic!("{needle:?} is not on the screen:\n{}", self.text());
    }

    pub fn click(&mut self, needle: &str) -> Vec<Effect> {
        let (x, y) = self.find(needle);
        self.press(x, y)
    }
}

pub fn lines(buf: &Buffer) -> Vec<String> {
    (buf.area.y..buf.area.y + buf.area.height)
        .map(|y| {
            let mut line = String::new();
            let mut skip = 0usize;
            for x in buf.area.x..buf.area.x + buf.area.width {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                let symbol = buf[(x, y)].symbol();
                skip = unicode_width::UnicodeWidthStr::width(symbol).saturating_sub(1);
                line.push_str(symbol);
            }
            line.trim_end().to_owned()
        })
        .collect()
}

/// The effect bodies by name, for asserting what a message started.
pub fn names(effects: &[Effect]) -> Vec<&'static str> {
    effects
        .iter()
        .map(|e| match &e.body {
            EffectBody::SearchQuery(_) => "search",
            EffectBody::SearchCancel(_) => "search cancel",
            EffectBody::LanguageDiagnostics => "diagnostics",
            EffectBody::RunConfigure(_) => "run configure",
            EffectBody::RunStart(_) => "run start",
            EffectBody::RunStop(_) => "run stop",
            EffectBody::RunPoll(_) => "run poll",
            _ => "other",
        })
        .collect()
}

/// The symbols of the cells in row `y` whose background is `bg`, wide-cell continuations
/// skipped: what a highlight covers.
pub fn marked(buf: &Buffer, y: u16, bg: ratatui::style::Color) -> String {
    let mut out = String::new();
    let mut skip = 0usize;
    for x in buf.area.x..buf.area.x + buf.area.width {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        let cell = &buf[(x, y)];
        skip = unicode_width::UnicodeWidthStr::width(cell.symbol()).saturating_sub(1);
        if cell.bg == bg {
            out.push_str(cell.symbol());
        }
    }
    out
}

/// The row of the buffer whose text contains `needle`.
pub fn row_with(buf: &Buffer, needle: &str) -> u16 {
    let rows = lines(buf);
    rows.iter()
        .position(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("{needle:?} is not drawn:\n{}", rows.join("\n"))) as u16
}
