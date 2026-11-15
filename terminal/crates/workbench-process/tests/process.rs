//! The process pane driven through a real root: keys, pointer, completions and
//! host messages go in as `Msg`; effects and cells come out.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome, TerminalOpened};
use theorem_workbench_core::effect::{
    Effect, EffectBody, InputKind, TerminalBackend, TerminalRole,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ActionId, Actor, EffectId, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::SemanticTree;
use theorem_workbench_core::{
    Button, DockMsg, Model, Msg, PanelFactories, Pointer, PointerKind, Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use theorem_workbench_process::{
    CatalogData, ProcessCatalog, ProcessProfile, ProcessSession, ProcessStyles, SessionState,
    register,
};
use theorem_workbench_vt::Palette;

const CAPS: [&str; 11] = [
    "files",
    "documents",
    "scm",
    "language",
    "run",
    "search",
    "environment",
    "artifacts",
    "conversation",
    "terminal.native",
    "terminal.herdr",
];

macro_rules! fixture {
    ($name:literal) => {
        include_bytes!(concat!("fixtures/", $name))
    };
}

fn named(workspace: &str) -> Msg {
    Msg::Host(HostMessage::WorkspaceChanged {
        workspace: workspace.into(),
        environment: Some("devbox".into()),
    })
}

fn session(name: &str, backend: TerminalBackend) -> ProcessSession {
    ProcessSession {
        session: name.into(),
        profile: "zsh".into(),
        backend,
        workspace: "w".into(),
        host: Some("devbox".into()),
        program: Some(1),
        state: SessionState::Running,
        controlled_elsewhere: false,
    }
}

fn profile(id: &str, backend: TerminalBackend, available: bool) -> ProcessProfile {
    ProcessProfile {
        id: id.into(),
        label: id.into(),
        backend,
        argv: None,
        available,
        unavailable_reason: (!available).then(|| "herdr is not running on devbox".to_owned()),
    }
}

fn data() -> CatalogData {
    CatalogData {
        sessions: vec![session("s1", TerminalBackend::Herdr)],
        profiles: vec![
            profile("herdr-zsh", TerminalBackend::Herdr, false),
            profile("native-zsh", TerminalBackend::Native, true),
        ],
    }
}

fn palette() -> Palette {
    Palette::default()
}

fn model(workspace: &str, catalog: &ProcessCatalog) -> Model {
    let mut factories = PanelFactories::new();
    register(
        &mut factories,
        catalog.clone(),
        ProcessStyles::new(palette()),
    );
    let registry = builtin::registry();
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(registry, factories, keys, Capabilities::of(CAPS), dock);
    update(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    if !workspace.is_empty() {
        update(&mut m, named(workspace));
    }
    m
}

struct Rig {
    m: Model,
    id: PanelInstanceId,
    catalog: ProcessCatalog,
}

fn shell_id(m: &Model) -> PanelInstanceId {
    m.panel_ids()
        .find(|(_, k)| k.as_str() == "shell")
        .map(|(id, _)| id.clone())
        .expect("a shell panel is open")
}

/// Shell opened in workspace `w`, nothing chosen.
fn rig() -> Rig {
    let catalog = ProcessCatalog::new("n1");
    catalog.set(data());
    let mut m = model("w", &catalog);
    let fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new("shell.choose"),
            actor: Actor::Human,
        },
    );
    assert!(fx.is_empty(), "opening Shell emitted {fx:?}");
    let id = shell_id(&m);
    update(&mut m, Msg::Dock(DockMsg::FocusPanel(id.clone())));
    Rig { m, id, catalog }
}

fn terminal() -> ResourceRef {
    ResourceRef::Terminal {
        workspace: "w".into(),
        session: "s1".into(),
    }
}

fn opened(epoch: u64, program: u64, cols: u16, rows: u16, origin: &str) -> TerminalOpened {
    TerminalOpened {
        session: "s1".into(),
        cols,
        rows,
        backend: TerminalBackend::Herdr,
        stream_epoch: Some("e".into()),
        epoch,
        program,
        origin: Some(origin.into()),
        lease_generation: Some(1),
        process_owned_by: None,
    }
}

impl Rig {
    fn send(&mut self, msg: Msg) -> Vec<Effect> {
        update(&mut self.m, msg)
    }

    fn key(&mut self, key: Key) -> Vec<Effect> {
        self.mods(key, Mods::NONE)
    }

    fn mods(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
        self.send(Msg::Key(KeyInput::new(key, mods)))
    }

    fn typed(&mut self, text: &str) -> Vec<Effect> {
        text.chars().flat_map(|c| self.key(Key::Char(c))).collect()
    }

    fn tick(&mut self) -> Vec<Effect> {
        self.send(Msg::Tick)
    }

    fn answer(
        &mut self,
        e: &Effect,
        outcome: Outcome,
        payload: Option<CompletionPayload>,
    ) -> Vec<Effect> {
        let mut c = Completion::new(e.id, e.resource.clone(), outcome);
        c.payload = payload;
        self.send(Msg::Completion(c))
    }

    fn accept_attach(&mut self, e: &Effect, opened: TerminalOpened) -> Vec<Effect> {
        self.answer(
            e,
            Outcome::Accepted,
            Some(CompletionPayload::Terminal(opened)),
        )
    }

    fn bytes(&mut self, epoch: u64, offset: u64, data: &[u8]) -> Vec<Effect> {
        let mut fx = self.send(Msg::Host(HostMessage::TerminalOutput {
            resource: terminal(),
            epoch,
            offset,
            data: B64.encode(data),
        }));
        fx.extend(self.tick());
        fx
    }

    fn reset(&mut self, epoch: u64, offset: u64, data: &[u8]) -> Vec<Effect> {
        self.send(Msg::Host(HostMessage::TerminalReset {
            resource: terminal(),
            epoch,
            offset,
            data: B64.encode(data),
        }))
    }

    fn host(&mut self, message: HostMessage) -> Vec<Effect> {
        self.send(Msg::Host(message))
    }

    /// Choose the session row and answer the attach: a controller on an 80x24
    /// grid.
    fn live(&mut self) {
        let fx = self.key(Key::Enter);
        let attach = only_attach(&fx);
        let fx = self.accept_attach(&attach, opened(1, 1, 80, 24, "reattached"));
        // The pane asked for its own size; answer so no resize is in flight.
        self.settle_resize(fx);
    }

    fn settle_resize(&mut self, fx: Vec<Effect>) {
        if let Some(e) = fx
            .iter()
            .find(|e| matches!(e.body, EffectBody::TerminalResize(_)))
        {
            let EffectBody::TerminalResize(r) = &e.body else {
                unreachable!()
            };
            let (cols, rows) = (r.cols, r.rows);
            self.answer(&e.clone(), Outcome::Accepted, None);
            self.host(HostMessage::TerminalResized {
                resource: terminal(),
                epoch: Some(1),
                cols,
                rows,
            });
        }
    }

    fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the shell group")
            .body
    }

    fn draw(&self, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let mut cx = ViewCtx::new(&theme, self.m.workspace());
        cx.focused = true;
        self.m.panel(&self.id).unwrap().view(area, &mut buf, &cx);
        buf
    }

    fn text(&self, width: u16, height: u16) -> Vec<String> {
        let buf = self.draw(width, height);
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buf[(x, y)].symbol().to_owned())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    /// The pane drawn at the size the root gave it.
    fn grid(&self) -> Vec<String> {
        let b = self.body();
        self.text(b.width, b.height)
    }

    fn screen(&self) -> String {
        self.text(100, 30).join("\n")
    }

    fn click_at(&mut self, x: u16, y: u16) -> Vec<Effect> {
        let b = self.body();
        let mut fx = vec![];
        for kind in [
            PointerKind::Down(Button::Left),
            PointerKind::Up(Button::Left),
        ] {
            fx.extend(self.send(Msg::Pointer(Pointer {
                kind,
                x: b.x + x,
                y: b.y + y,
                mods: Mods::NONE,
                clicks: 1,
            })));
        }
        fx
    }

    fn semantics(&self) -> SemanticTree {
        let theme = Theme::plain();
        let cx = ViewCtx::new(&theme, self.m.workspace());
        let b = self.body();
        let nodes = self
            .m
            .panel(&self.id)
            .unwrap()
            .semantics(Rect::new(0, 0, b.width, b.height), &cx);
        SemanticTree {
            root: nodes[0].id.clone(),
            nodes,
        }
    }

    fn valid_tree(&self) -> SemanticTree {
        let tree = self.semantics();
        tree.validate()
            .unwrap_or_else(|e| panic!("{e:?}\n{tree:#?}"));
        tree
    }
}

fn only_attach(fx: &[Effect]) -> Effect {
    let found: Vec<&Effect> = fx
        .iter()
        .filter(|e| matches!(e.body, EffectBody::TerminalAttach(_)))
        .collect();
    assert_eq!(found.len(), 1, "expected one attach in {fx:?}");
    found[0].clone()
}

fn kinds(fx: &[Effect]) -> Vec<&'static str> {
    fx.iter()
        .map(|e| match &e.body {
            EffectBody::TerminalOpen(_) => "open",
            EffectBody::TerminalAttach(_) => "attach",
            EffectBody::TerminalInput(_) => "input",
            EffectBody::TerminalResize(_) => "resize",
            EffectBody::TerminalDetach(_) => "detach",
            EffectBody::TerminalEnd => "end",
            EffectBody::ClipboardWrite(_) => "clipboard",
            _ => "other",
        })
        .collect()
}

fn inputs(fx: &[Effect]) -> Vec<(String, String, u64)> {
    fx.iter()
        .filter_map(|e| match &e.body {
            EffectBody::TerminalInput(i) => Some((
                i.bytes.clone(),
                i.input_id.clone(),
                i.claim.lease_generation,
            )),
            _ => None,
        })
        .collect()
}

fn cell_fg(buf: &Buffer, x: u16, y: u16) -> Color {
    buf[(x, y)].fg
}

// ---- 1. choosing -----------------------------------------------------------

#[test]
fn opening_shell_starts_nothing_and_lists_rows_with_what_persistence_means() {
    let mut r = rig();
    assert!(r.tick().is_empty());
    assert!(r.tick().is_empty());
    let s = r.screen();
    for needle in [
        "s1",
        "w @ devbox",
        "Herdr",
        "survives pane close and refresh",
        "Start native-zsh",
        "not kept by Herdr, ends with the host",
        "unavailable: herdr is not running on devbox",
    ] {
        assert!(s.contains(needle), "{needle:?} missing from\n{s}");
    }
    r.valid_tree();
}

#[test]
fn choosing_a_session_emits_exactly_one_attach() {
    let mut r = rig();
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), ["attach"]);
    let EffectBody::TerminalAttach(a) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Controller);
    assert_eq!(fx[0].resource, terminal());
    assert!(r.tick().is_empty(), "no second effect while attaching");
}

#[test]
fn choosing_a_profile_emits_exactly_one_open_and_an_unavailable_profile_none() {
    let mut r = rig();
    r.key(Key::Down);
    let fx = r.key(Key::Enter);
    assert!(fx.is_empty(), "the Herdr profile is unavailable: {fx:?}");
    assert!(r.screen().contains("herdr is not running on devbox"));
    r.key(Key::Down);
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), ["open"]);
    let EffectBody::TerminalOpen(o) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(o.backend, TerminalBackend::Native);
    assert!(r.tick().is_empty());
    r.valid_tree();
}

#[test]
fn a_double_click_chooses_and_a_single_click_only_selects() {
    let mut r = rig();
    // Line 4 is the session row's title (heading, hint, blank, heading).
    assert!(r.click_at(2, 4).is_empty(), "a single click only selects");
    let b = r.body();
    let fx = r.send(Msg::Pointer(Pointer {
        kind: PointerKind::Down(Button::Left),
        x: b.x + 2,
        y: b.y + 4,
        mods: Mods::NONE,
        clicks: 2,
    }));
    assert_eq!(kinds(&fx), ["attach"]);
}

// ---- 2. opening ------------------------------------------------------------

#[test]
fn an_uncertain_open_is_shown_unknown_never_retried_or_resolved() {
    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let fx = r.key(Key::Enter);
    let open = fx[0].clone();
    assert!(
        r.answer(
            &open,
            Outcome::Uncertain {
                reason: "socket closed".into()
            },
            None
        )
        .is_empty()
    );
    for _ in 0..3 {
        assert!(r.tick().is_empty());
    }
    let s = r.screen();
    assert!(
        s.contains("Unknown whether a shell started (socket closed)"),
        "{s}"
    );
    assert!(r.key(Key::Enter).is_empty());
    let tree = r.valid_tree();
    assert!(
        tree.nodes
            .iter()
            .any(|n| n.name.starts_with("Unknown whether"))
    );
}

#[test]
fn an_accepted_open_attaches_under_the_panels_own_attachment() {
    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let fx = r.key(Key::Enter);
    let open = fx[0].clone();
    let fx = r.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            ..opened(1, 1, 80, 24, "launched")
        })),
    );
    let attach = only_attach(&fx);
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Controller);
    assert_eq!(attach.resource, terminal());
}

// ---- 3. live, controlling --------------------------------------------------

#[test]
fn input_carries_a_fresh_id_and_the_claim_and_a_retry_reuses_the_id() {
    let mut r = rig();
    r.live();
    let first = r.typed("l");
    let second = r.typed("s");
    let (a, b) = (inputs(&first), inputs(&second));
    assert_eq!((a.len(), b.len()), (1, 1));
    assert_eq!(a[0].0, "l");
    assert_ne!(a[0].1, b[0].1, "each logical input has its own id");
    assert_eq!(a[0].2, 1, "the lease generation of the claim");
    let EffectBody::TerminalInput(sent) = &first[0].body else {
        unreachable!()
    };
    assert_eq!(sent.kind, InputKind::Human);
    assert_eq!(sent.claim.epoch, 1);

    // Unknown outcome: not resent by itself.
    r.answer(
        &second[0],
        Outcome::Uncertain {
            reason: "timeout".into(),
        },
        None,
    );
    assert!(r.tick().is_empty());
    assert!(r.screen().contains("Input unconfirmed (timeout)"));
    // A person resends it: same id, same bytes, same claim.
    let b = r.body();
    let fx = r.click_at(2, b.height - 1);
    let again = inputs(&fx);
    assert_eq!(again, b_vec(&second));
}

fn b_vec(fx: &[Effect]) -> Vec<(String, String, u64)> {
    inputs(fx)
}

#[test]
fn paste_and_focus_leave_through_the_encoders() {
    let mut r = rig();
    r.live();
    let fx = r.send(Msg::Paste("echo hi".into()));
    let sent = inputs(&fx);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].0, "echo hi",
        "no bracketed paste until the program asks"
    );
    r.bytes(1, 0, b"\x1b[?2004h\x1b[?1004h");
    let fx = r.send(Msg::Paste("x".into()));
    assert_eq!(inputs(&fx)[0].0, "\x1b[200~x\x1b[201~");
    r.send(Msg::Focus(false));
    let fx = r.tick();
    assert_eq!(inputs(&fx)[0].0, "\x1b[O");
}

#[test]
fn the_screen_resizes_only_when_the_host_confirms_and_one_resize_is_in_flight() {
    let mut r = rig();
    let fx = r.key(Key::Enter);
    let attach = only_attach(&fx);
    let fx = r.accept_attach(&attach, opened(1, 1, 80, 24, "reattached"));
    let b = r.body();
    let want = (b.width, b.height - 2);
    assert_eq!(kinds(&fx), ["resize"]);
    let EffectBody::TerminalResize(first) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!((first.cols, first.rows), want);
    assert_eq!(first.claim.attachment, {
        let EffectBody::TerminalAttach(a) = &attach.body else {
            unreachable!()
        };
        a.attachment.clone()
    });
    // The grid is still the host's 80x24: output is drawn on it.
    r.bytes(1, 0, b"x");
    assert!(r.grid()[1].starts_with('x'));

    // The body changes twice while the first resize is in flight.
    for height in [40, 30] {
        r.send(Msg::Resize {
            area: Rect::new(0, 0, 200, height),
            metrics: CellMetrics::new(8.0, 16.0),
        });
        assert!(r.tick().is_empty(), "one resize at a time");
    }
    let latest = r.body();
    // The answer frees the slot; the latest size, not each intermediate one,
    // is what follows.
    let mut fx = r.answer(&fx[0], Outcome::Accepted, None);
    fx.extend(r.host(HostMessage::TerminalResized {
        resource: terminal(),
        epoch: Some(1),
        cols: first.cols,
        rows: first.rows,
    }));
    fx.extend(r.tick());
    assert_eq!(kinds(&fx), ["resize"]);
    let EffectBody::TerminalResize(second) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(
        (second.cols, second.rows),
        (latest.width, latest.height - 2)
    );
}

#[test]
fn color_cursor_and_wide_characters_draw_the_expected_cells() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, fixture!("sgr.vt"));
    let b = r.body();
    let buf = r.draw(b.width, b.height);
    let pal = palette();
    // "red" is ANSI 1; "bold" is bold ANSI 2 (green).
    assert_eq!(cell_fg(&buf, 0, 1), pal.ansi[1]);
    assert_eq!(buf[(0, 1)].symbol(), "r");
    assert_eq!(cell_fg(&buf, 4, 1), pal.ansi[2]);
    assert_eq!(cell_fg(&buf, 9, 1), Color::Indexed(196));
    assert_eq!(cell_fg(&buf, 13, 1), Color::Rgb(1, 2, 3));
    assert!(r.grid()[1].starts_with("red bold idx rgb inv bgblue dim"));
}

#[test]
fn cursor_movement_and_erase_land_on_the_right_cells() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, fixture!("cursor_erase.vt"));
    let t = r.grid();
    assert_eq!(t[1], "145", "row 1: two chars deleted after the first");
    assert_eq!(t[2], "ab", "row 2: erased from column 3");
    assert!(t[3].contains('q'));
    assert!(t[4].contains('X'));
}

#[test]
fn wide_characters_occupy_two_cells() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, fixture!("wide.vt"));
    let b = r.body();
    let buf = r.draw(b.width, b.height);
    assert_eq!(buf[(0, 1)].symbol(), "a");
    assert_eq!(buf[(1, 1)].symbol(), "\u{6f22}");
    assert_eq!(buf[(3, 1)].symbol(), "\u{5b57}");
    assert_eq!(buf[(5, 1)].symbol(), "b");
}

#[test]
fn the_alternate_screen_draws_and_its_cursor_hides() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"before\r\n");
    let off = b"before\r\n".len() as u64;
    r.bytes(1, off, fixture!("alt_enter.vt"));
    let t = r.grid();
    assert!(t[1].starts_with("FULL SCREEN"), "{t:?}");
    assert!(t[2].starts_with("line two"));
    assert!(!t.join("\n").contains("before"));
}

#[test]
fn scrollback_by_page_keys_and_wheel_until_typing_returns_to_the_bottom() {
    let mut r = rig();
    r.live();
    let mut out = String::new();
    for i in 0..60 {
        out.push_str(&format!("line {i}\r\n"));
    }
    r.bytes(1, 0, out.as_bytes());
    assert!(r.grid().iter().any(|l| l == "line 59"));
    r.key(Key::PageUp);
    assert!(!r.grid().iter().any(|l| l == "line 59"), "scrolled up");
    let b = r.body();
    r.send(Msg::Pointer(Pointer {
        kind: PointerKind::Wheel { dx: 0, dy: 1 },
        x: b.x + 2,
        y: b.y + 3,
        mods: Mods::NONE,
        clicks: 1,
    }));
    let fx = r.typed("q");
    assert_eq!(inputs(&fx).len(), 1);
    assert!(
        r.grid().iter().any(|l| l == "line 59"),
        "typing returned to the bottom"
    );
}

#[test]
fn selection_and_copy_go_to_the_clipboard_not_the_program() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"hello world\r\n");
    let b = r.body();
    let at = |kind, x, y| {
        Msg::Pointer(Pointer {
            kind,
            x: b.x + x,
            y: b.y + y,
            mods: Mods::NONE,
            clicks: 1,
        })
    };
    r.send(at(PointerKind::Down(Button::Left), 0, 1));
    r.send(at(PointerKind::Move, 4, 1));
    r.send(at(PointerKind::Up(Button::Left), 4, 1));
    let fx = r.mods(Key::Char('c'), Mods::CMD);
    assert_eq!(kinds(&fx), ["clipboard"]);
    let EffectBody::ClipboardWrite(w) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(w.text, "hello");
}

// ---- 4. observing ----------------------------------------------------------

fn observing() -> Rig {
    let mut r = rig();
    let fx = r.key(Key::Char('o'));
    let attach = only_attach(&fx);
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Observer);
    r.accept_attach(&attach, opened(1, 1, 80, 24, "reattached"));
    r
}

#[test]
fn an_observer_emits_nothing_shows_the_reason_and_offers_control() {
    let mut r = observing();
    assert!(r.tick().is_empty(), "no resize from an observer");
    assert!(r.typed("ls").is_empty());
    assert!(r.send(Msg::Paste("x".into())).is_empty());
    let s = r.screen();
    assert!(s.contains("observing"), "{s}");
    assert!(
        s.contains("did not take control") || s.contains("observer"),
        "{s}"
    );
    assert!(s.contains("Enter requests control"), "{s}");
    let tree = r.valid_tree();
    let ctrl = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "request-control")
        .unwrap();
    assert!(ctrl.actions[0].enabled);
    // Output still arrives.
    r.bytes(1, 0, b"hi");
    assert!(r.grid()[1].starts_with("hi"));
}

#[test]
fn requesting_control_attaches_as_controller_and_a_refusal_is_shown_with_its_reason() {
    let mut r = observing();
    r.typed("x");
    let fx = r.key(Key::Enter);
    let attach = only_attach(&fx);
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Controller);
    r.answer(
        &attach,
        Outcome::Refused {
            code: "terminal_control_refused".into(),
            reason: "held".into(),
        },
        None,
    );
    let s = r.screen();
    assert!(
        s.contains("Another viewer holds control (host: held)"),
        "{s}"
    );
    assert!(r.typed("a").is_empty(), "still observing");
}

#[test]
fn a_refused_input_moves_a_controller_to_observing_with_the_hosts_reason() {
    let mut r = rig();
    r.live();
    let fx = r.typed("a");
    r.answer(
        &fx[0],
        Outcome::Refused {
            code: "terminal_control_refused".into(),
            reason: "stale_generation".into(),
        },
        None,
    );
    assert!(r.screen().contains("(host: stale_generation)"));
    assert!(r.typed("b").is_empty());
}

#[test]
fn losing_the_lease_moves_to_observing_without_dropping_output() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"abc");
    r.host(HostMessage::TerminalControl {
        resource: terminal(),
        epoch: 1,
        generation: 2,
        controlled: false,
    });
    assert!(r.typed("z").is_empty());
    r.bytes(1, 3, b"def");
    let s = r.screen();
    assert!(s.contains("abcdef"), "{s}");
    assert!(s.contains("observing"));
}

// ---- 5. epochs -------------------------------------------------------------

#[test]
fn a_newer_epoch_reset_replaces_the_screen_and_an_older_epoch_is_dropped() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"old screen");
    r.host(HostMessage::TerminalOpened {
        resource: terminal(),
        epoch: 2,
        program: 2,
        backend: TerminalBackend::Herdr,
        origin: "replacement".into(),
        cols: 80,
        rows: 24,
    });
    let fx = r.tick();
    assert!(kinds(&fx).is_empty());
    r.reset(2, 5, b"\x1b[H\x1b[2Jnew program");
    let s = r.screen();
    assert!(
        s.contains("new program") && !s.contains("old screen"),
        "{s}"
    );
    assert!(s.contains("Program replaced"), "{s}");
    // A frame of the old epoch changes nothing.
    r.bytes(1, 10, b"STALE");
    assert!(!r.screen().contains("STALE"));
}

#[test]
fn an_offset_gap_asks_for_a_reset_with_the_current_role() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"abc");
    let fx = r.bytes(1, 99, b"zzz");
    let attach = only_attach(&fx);
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(
        a.role,
        TerminalRole::Controller,
        "a repaint must not give the lease up"
    );
    assert_eq!(a.from_offset, 3);
    assert!(!r.screen().contains("zzz"));
    assert!(r.screen().contains("asking") || r.screen().contains("Asking"));
}

#[test]
fn replacement_continuation_reattachment_and_host_reset_read_differently() {
    let mut texts = vec![];
    for origin in ["launched", "adopted", "reattached"] {
        let mut r = rig();
        let fx = r.key(Key::Enter);
        let attach = only_attach(&fx);
        let fx = r.accept_attach(&attach, opened(1, 1, 80, 24, origin));
        r.settle_resize(fx);
        texts.push(r.screen());
    }
    assert!(texts[0].contains("Started in this pane"));
    assert!(texts[1].contains("Adopted a terminal"));
    assert!(texts[2].contains("kept running while no view was attached"));
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"abc");
    r.reset(1, 3, b"\x1b[Habc");
    assert!(r.screen().contains("host log reset") || r.screen().contains("host repainted"));
}

// ---- 6. ended, lost, unavailable --------------------------------------------

#[test]
fn an_exit_names_the_hosts_reason_and_never_offers_continuation() {
    let mut r = rig();
    r.live();
    r.host(HostMessage::TerminalExited {
        resource: terminal(),
        epoch: 1,
        exit_code: Some(3),
        reason: "exited".into(),
    });
    let s = r.screen();
    assert!(s.contains("exited with code 3 (exited)"), "{s}");
    assert!(s.contains("The program has ended"), "{s}");
    assert!(r.typed("z").is_empty());
    let tree = r.valid_tree();
    let end = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "end-process")
        .unwrap();
    assert!(!end.actions[0].enabled && end.actions[0].reason.is_some());
}

#[test]
fn a_lost_program_is_lost_and_a_new_shell_is_a_different_process() {
    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let open = r.key(Key::Enter)[0].clone();
    let fx = r.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            ..opened(1, 1, 80, 24, "launched")
        })),
    );
    let attach = only_attach(&fx);
    r.accept_attach(
        &attach,
        TerminalOpened {
            backend: TerminalBackend::Native,
            ..opened(1, 1, 80, 24, "launched")
        },
    );
    r.host(HostMessage::TerminalExited {
        resource: terminal(),
        epoch: 1,
        exit_code: None,
        reason: "lost".into(),
    });
    let s = r.screen();
    assert!(
        s.contains("lost (lost)") && s.contains("The program is lost"),
        "{s}"
    );
    let fx = r.key(Key::Char('n'));
    assert_eq!(kinds(&fx), ["detach", "open"]);
    assert!(r.screen().contains("does not continue s1"));
}

#[test]
fn an_unavailable_backend_is_a_failure_line_with_the_hosts_reason() {
    let mut r = rig();
    let attach = only_attach(&r.key(Key::Enter));
    r.answer(
        &attach,
        Outcome::Refused {
            code: "terminal_backend_unavailable".into(),
            reason: "herdr is not running".into(),
        },
        None,
    );
    let s = r.screen();
    assert!(
        s.contains("Backend unavailable") && s.contains("herdr is not running"),
        "{s}"
    );
    r.valid_tree();
    r.key(Key::Esc);
    assert!(r.screen().contains("Existing sessions"));
}

// ---- 7. closing and ending -------------------------------------------------

#[test]
fn closing_the_pane_detaches_with_the_claim_and_never_ends() {
    let mut r = rig();
    r.live();
    let fx = r.send(Msg::Dock(DockMsg::ClosePanel(r.id.clone())));
    assert_eq!(kinds(&fx), ["detach"]);
    let EffectBody::TerminalDetach(claim) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(claim.lease_generation, 1);
    assert_eq!(claim.epoch, 1);
}

#[test]
fn ending_asks_first_and_only_a_person_confirms() {
    let mut r = rig();
    r.live();
    let act = |r: &mut Rig| {
        r.send(Msg::Action {
            id: ActionId::new("shell.end"),
            actor: Actor::Agent { run_id: "r".into() },
        })
    };
    // An agent asking only raises the question.
    assert!(act(&mut r).is_empty());
    assert!(act(&mut r).is_empty());
    assert!(r.screen().contains("End process s1?"));
    assert!(
        r.valid_tree()
            .nodes
            .iter()
            .any(|n| n.name.starts_with("End process s1?"))
    );
    // Esc cancels: nothing left.
    assert!(r.key(Key::Esc).is_empty());
    assert!(!r.screen().contains("End process s1?"));
    // A person asks, then confirms.
    assert!(act(&mut r).is_empty());
    let fx = r.typed("y");
    assert_eq!(kinds(&fx), ["end"]);
    assert!(r.typed("n").is_empty(), "the program no longer takes keys");
}

#[test]
fn clicking_end_process_asks_and_enter_confirms() {
    let mut r = rig();
    r.live();
    let b = r.body();
    assert!(r.click_at(b.width - 3, 0).is_empty());
    assert!(r.screen().contains("End process s1?"));
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), ["end"]);
}

#[test]
fn a_destroy_close_still_only_detaches() {
    let mut r = rig();
    r.live();
    let fx = r.send(Msg::Dock(DockMsg::ClosePanel(r.id.clone())));
    assert!(!kinds(&fx).contains(&"end"));
}

// ---- binding, workspace, restore --------------------------------------------

#[test]
fn binding_reports_the_terminal_and_its_epoch() {
    let mut r = rig();
    r.live();
    let b = r.m.panel(&r.id).unwrap().binding().unwrap();
    assert_eq!(b.resource, terminal());
    assert_eq!(b.generation.map(|g| g.0), Some(1));
}

#[test]
fn a_workspace_change_detaches_and_returns_to_the_chooser() {
    let mut r = rig();
    r.live();
    let mut fx = r.send(named("other"));
    fx.extend(r.tick());
    assert_eq!(kinds(&fx), ["detach"]);
    assert_eq!(fx[0].resource, terminal());
    let s = r.screen();
    assert!(s.contains("The workspace changed to other"), "{s}");
    assert!(s.contains("workspace other"));
    assert!(
        !s.contains("s1  zsh"),
        "the other workspace has no such session"
    );
    assert!(r.tick().is_empty());
}

#[test]
fn serialize_then_restore_attaches_by_identity_and_does_not_relaunch() {
    let mut r = rig();
    r.live();
    let doc = r.m.document();
    let saved = doc.to_string();
    assert!(saved.contains("\"session\":\"s1\""), "{saved}");

    let catalog = ProcessCatalog::new("n2");
    catalog.set(data());
    let mut m = model("w", &catalog);
    m.restore(doc).expect("restores");
    let mut r2 = Rig {
        id: shell_id(&m),
        m,
        catalog,
    };
    let fx = r2.tick();
    assert_eq!(kinds(&fx), ["attach"]);
    assert!(!kinds(&fx).contains(&"open"));
    assert_eq!(fx[0].resource, terminal());
}

#[test]
fn a_restored_pane_whose_terminal_is_gone_says_so_and_offers_the_chooser() {
    let mut r = rig();
    r.live();
    let doc = r.m.document();
    let catalog = ProcessCatalog::new("n3");
    catalog.set(data());
    let mut m = model("w", &catalog);
    m.restore(doc).unwrap();
    let mut r2 = Rig {
        id: shell_id(&m),
        m,
        catalog,
    };
    let attach = only_attach(&r2.tick());
    r2.answer(
        &attach,
        Outcome::Refused {
            code: "terminal_session_not_found".into(),
            reason: "no such terminal".into(),
        },
        None,
    );
    let s = r2.screen();
    assert!(
        s.contains("Terminal not found") && s.contains("no such terminal"),
        "{s}"
    );
    r2.valid_tree();
    r2.key(Key::Esc);
    assert!(r2.screen().contains("Existing sessions"));
}

// ---- semantics, every state ---------------------------------------------------

#[test]
fn every_state_has_a_valid_semantic_tree_with_a_status_line() {
    let mut r = rig();
    let check = |r: &Rig, what: &str| {
        let tree = r.valid_tree();
        assert!(
            tree.nodes.iter().any(|n| n.id.as_str() == "status"),
            "{what}: no status node"
        );
    };
    check(&r, "choosing");
    let attach = only_attach(&r.key(Key::Enter));
    check(&r, "attaching");
    r.accept_attach(&attach, opened(1, 1, 80, 24, "reattached"));
    check(&r, "controlling");
    let tree = r.valid_tree();
    assert!(tree.nodes.iter().any(|n| n.id.as_str() == "terminal"));
    r.host(HostMessage::TerminalControl {
        resource: terminal(),
        epoch: 1,
        generation: 2,
        controlled: false,
    });
    check(&r, "observing");
    r.host(HostMessage::TerminalExited {
        resource: terminal(),
        epoch: 1,
        exit_code: Some(0),
        reason: "exited".into(),
    });
    check(&r, "ended");
}

#[test]
fn the_terminal_node_says_why_an_observer_cannot_type() {
    let r = observing();
    let tree = r.valid_tree();
    let term = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "terminal")
        .unwrap();
    assert!(term.state.disabled);
    assert!(
        term.state
            .description
            .as_deref()
            .unwrap_or("")
            .contains("observer")
            || term.state.description.is_some()
    );
}

// ---- renders for the report -----------------------------------------------------

#[test]
fn renders_of_the_choosing_and_live_states_at_80_by_24() {
    let mut r = rig();
    println!("--- Choosing (80x24)\n{}", r.text(80, 24).join("\n"));
    r.live();
    r.bytes(1, 0, fixture!("live.vt"));
    println!("--- Live (80x24)\n{}", r.text(80, 24).join("\n"));
}

#[allow(dead_code)]
fn unused(_: EffectId) {}

#[test]
fn the_chooser_follows_the_catalog_the_mount_updates() {
    let mut r = rig();
    let mut next = data();
    next.sessions.push(session("s2", TerminalBackend::Native));
    r.catalog.set(next);
    assert!(r.tick().is_empty());
    assert!(r.screen().contains("s2"));
}
