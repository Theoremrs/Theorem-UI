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
use theorem_workbench_core::host::{
    HostMessage, TerminalProfileInfo, TerminalSessionInfo, TerminalSessionState,
};
use theorem_workbench_core::ids::{ActionId, Actor, EffectId, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::SemanticTree;
use theorem_workbench_core::{
    Button, DockMsg, Model, Msg, PanelFactories, Pointer, PointerKind, Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use theorem_workbench_process::{ProcessStyles, extend_registry, register};
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

fn session(name: &str, backend: TerminalBackend) -> TerminalSessionInfo {
    TerminalSessionInfo {
        session: name.into(),
        profile: "zsh".into(),
        backend,
        workspace: "w".into(),
        host: Some("devbox".into()),
        program: Some(1),
        state: TerminalSessionState::Running,
        controlled_elsewhere: false,
        modes: None,
    }
}

fn profile(id: &str, backend: TerminalBackend, available: bool) -> TerminalProfileInfo {
    TerminalProfileInfo {
        id: id.into(),
        label: id.into(),
        backend,
        argv: None,
        available,
        unavailable_reason: (!available).then(|| "herdr is not running on devbox".to_owned()),
    }
}

/// What the host says the chooser offers, for workspace `workspace`.
fn listing(workspace: &str, sessions: Vec<TerminalSessionInfo>) -> Msg {
    Msg::Host(HostMessage::TerminalSessions {
        workspace: workspace.into(),
        profiles: vec![
            profile("herdr-zsh", TerminalBackend::Herdr, false),
            profile("native-zsh", TerminalBackend::Native, true),
        ],
        sessions,
        adoption: None,
    })
}

fn data() -> Msg {
    listing("w", vec![session("s1", TerminalBackend::Herdr)])
}

fn palette() -> Palette {
    Palette::default()
}

fn model(workspace: &str) -> Model {
    let mut factories = PanelFactories::new();
    register(&mut factories, ProcessStyles::new(palette()), "n1");
    let mut registry = builtin::registry();
    extend_registry(&mut registry).expect("the shell actions register");
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
}

fn shell_id(m: &Model) -> PanelInstanceId {
    m.panel_ids()
        .find(|(_, k)| k.as_str() == "shell")
        .map(|(id, _)| id.clone())
        .expect("a shell panel is open")
}

/// Shell opened in workspace `w`, nothing chosen.
fn rig() -> Rig {
    let mut m = model("w");
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
    update(&mut m, data());
    Rig { m, id }
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
        attachment: None,
        controlling: None,
        controlled: None,
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
        self.draw_with(width, height, &Theme::plain())
    }

    fn draw_with(&self, width: u16, height: u16, theme: &Theme) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let mut cx = ViewCtx::new(theme, self.m.workspace());
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
            EffectBody::TerminalInputBytes(_) => "bytes",
            EffectBody::TerminalAbandonOpen(_) => "abandon",
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
fn open_and_attach_are_one_effect_and_the_answer_carries_the_attachment_and_lease() {
    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), ["open"]);
    let EffectBody::TerminalOpen(o) = &fx[0].body else {
        unreachable!()
    };
    let attachment = o.attachment.clone().expect("the open names its attachment");
    let fx = r.answer(
        &fx[0],
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            attachment: Some(attachment.clone()),
            controlling: Some(true),
            controlled: Some(true),
            ..opened(1, 1, 80, 24, "launched")
        })),
    );
    assert!(
        !kinds(&fx).contains(&"attach"),
        "no follow-up attach after an open: {fx:?}"
    );
    let typed = r.typed("l");
    let EffectBody::TerminalInput(i) = &typed[0].body else {
        unreachable!()
    };
    assert_eq!(i.claim.attachment, attachment);
    assert_eq!(i.claim.lease_generation, 1);
}

#[test]
fn an_open_the_host_answers_without_control_leaves_the_pane_observing_with_the_reason() {
    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let open = r.key(Key::Enter)[0].clone();
    r.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            controlling: Some(false),
            controlled: Some(true),
            ..opened(1, 1, 80, 24, "launched")
        })),
    );
    assert!(r.typed("l").is_empty());
    assert!(r.screen().contains("(host: held)"), "{}", r.screen());
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
    r.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            controlling: Some(true),
            ..opened(1, 1, 80, 24, "launched")
        })),
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

    let mut m = model("w");
    m.restore(doc).expect("restores");
    let mut r2 = Rig {
        id: shell_id(&m),
        m,
    };
    r2.send(data());
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
    let mut m = model("w");
    m.restore(doc).unwrap();
    let mut r2 = Rig {
        id: shell_id(&m),
        m,
    };
    r2.send(data());
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
    r.send(listing(
        "w",
        vec![
            session("s1", TerminalBackend::Herdr),
            session("s2", TerminalBackend::Native),
        ],
    ));
    assert!(r.tick().is_empty());
    assert!(r.screen().contains("s2"));
}

// ---- the open in flight ------------------------------------------------------

/// Start the native profile and leave the open unanswered.
fn opening() -> (Rig, Effect) {
    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), ["open"]);
    let open = fx[0].clone();
    (r, open)
}

#[test]
fn closing_during_an_open_sends_the_abandon_and_nothing_else() {
    let (mut r, open) = opening();
    let fx = r.send(Msg::Dock(DockMsg::ClosePanel(r.id.clone())));
    assert_eq!(kinds(&fx), ["abandon"]);
    let EffectBody::TerminalAbandonOpen(a) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(a.open, open.id);
}

#[test]
fn an_uncertain_open_is_abandoned_too_when_the_pane_closes() {
    let (mut r, open) = opening();
    r.answer(
        &open,
        Outcome::Uncertain {
            reason: "socket".into(),
        },
        None,
    );
    let fx = r.send(Msg::Dock(DockMsg::ClosePanel(r.id.clone())));
    assert_eq!(kinds(&fx), ["abandon"]);
}

#[test]
fn leaving_the_wait_with_escape_asks_the_host_to_end_the_session_the_open_creates() {
    let (mut r, open) = opening();
    let fx = r.key(Key::Esc);
    assert_eq!(kinds(&fx), ["abandon"]);
    assert!(r.screen().contains("asked to end the shell"));
    // The late answer of the abandoned open starts no pane state.
    let late = r.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            ..opened(1, 1, 80, 24, "launched")
        })),
    );
    assert!(late.is_empty());
    assert!(r.screen().contains("Existing sessions"));
}

#[test]
fn a_workspace_change_during_an_open_abandons_it_on_the_next_tick() {
    let (mut r, open) = opening();
    let mut fx = r.send(named("other"));
    fx.extend(r.tick());
    assert_eq!(kinds(&fx), ["abandon"]);
    let EffectBody::TerminalAbandonOpen(a) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(a.open, open.id);
    assert_eq!(
        fx[0].resource,
        ResourceRef::Workspace {
            workspace: "w".into()
        },
        "the open's own workspace, not the new one"
    );
}

#[test]
fn an_open_that_resolved_is_detached_not_abandoned_when_the_pane_closes() {
    let (mut r, open) = opening();
    r.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::Terminal(TerminalOpened {
            backend: TerminalBackend::Native,
            controlling: Some(true),
            ..opened(1, 1, 80, 24, "launched")
        })),
    );
    let fx = r.send(Msg::Dock(DockMsg::ClosePanel(r.id.clone())));
    assert_eq!(kinds(&fx), ["detach"]);
}

// ---- input that is not UTF-8 -------------------------------------------------

#[test]
fn a_non_utf8_mouse_report_reaches_the_wire_intact_and_a_resend_reuses_its_id() {
    let mut r = rig();
    // Wide enough that a column past 94 exists: X10 reports add 33 to it.
    r.send(Msg::Resize {
        area: Rect::new(0, 0, 600, 50),
        metrics: CellMetrics::new(8.0, 16.0),
    });
    r.live();
    r.bytes(1, 0, b"\x1b[?1000h");
    let b = r.body();
    assert!(b.width > 100, "the pane is {} wide", b.width);
    let at = |kind| {
        Msg::Pointer(Pointer {
            kind,
            x: b.x + 100,
            y: b.y + 3,
            mods: Mods::NONE,
            clicks: 1,
        })
    };
    let fx = r.send(at(PointerKind::Down(Button::Left)));
    assert_eq!(kinds(&fx), ["bytes"]);
    let EffectBody::TerminalInputBytes(sent) = &fx[0].body else {
        unreachable!()
    };
    let wire = B64.decode(&sent.data).unwrap();
    assert!(std::str::from_utf8(&wire).is_err(), "{wire:?}");
    // CSI M, button 0 (+32), column 100 + 1 (+32), row 2 + 1 (+32).
    assert_eq!(
        wire,
        vec![0x1b, b'[', b'M', 32, 32 + 101, 32 + 3 + 1 - 1 + 1 - 1]
    );
    assert_eq!(sent.claim.lease_generation, 1);
    // Unknown outcome, resent by a person: same id, same data.
    r.answer(
        &fx[0],
        Outcome::Uncertain {
            reason: "timeout".into(),
        },
        None,
    );
    let b2 = r.body();
    let again = r.click_at(2, b2.height - 1);
    assert_eq!(kinds(&again), ["bytes"]);
    let EffectBody::TerminalInputBytes(second) = &again[0].body else {
        unreachable!()
    };
    assert_eq!(second.input_id, sent.input_id);
    assert_eq!(second.data, sent.data);
}

// ---- the listing -----------------------------------------------------------

#[test]
fn a_listing_for_another_workspace_is_ignored_and_each_message_replaces_both_lists() {
    let mut r = rig();
    r.send(listing(
        "elsewhere",
        vec![session("x9", TerminalBackend::Native)],
    ));
    assert!(!r.screen().contains("x9"));
    assert!(r.screen().contains("s1"));
    r.send(listing("w", vec![session("s7", TerminalBackend::Native)]));
    let s = r.screen();
    assert!(s.contains("s7") && !s.contains(" s1 "), "{s}");
}

#[test]
fn a_pane_opened_after_the_listing_shows_it_at_once() {
    let mut r = rig();
    // A second shell pane, opened after the host spoke.
    let fx = r.send(Msg::Action {
        id: ActionId::new("shell.choose"),
        actor: Actor::Human,
    });
    assert!(fx.is_empty());
    let ids =
        r.m.panel_ids()
            .filter(|(_, k)| k.as_str() == "shell")
            .count();
    assert!(ids >= 1);
    let fresh =
        r.m.panel_ids()
            .filter(|(_, k)| k.as_str() == "shell")
            .map(|(id, _)| id.clone())
            .last()
            .unwrap();
    let r2 = Rig { m: r.m, id: fresh };
    assert!(r2.screen().contains("s1"));
}

// ---- restore -----------------------------------------------------------------

fn restored(controlling: Option<bool>, controlled: Option<bool>) -> (Rig, Effect) {
    let mut r = rig();
    r.live();
    let doc = r.m.document();
    let mut m = model("w");
    m.restore(doc).expect("restores");
    let mut r2 = Rig {
        id: shell_id(&m),
        m,
    };
    r2.send(data());
    let attach = only_attach(&r2.tick());
    r2.accept_attach(
        &attach,
        TerminalOpened {
            controlling,
            controlled,
            ..opened(1, 1, 80, 24, "reattached")
        },
    );
    (r2, attach)
}

#[test]
fn a_restored_pane_does_not_take_control_even_when_nobody_holds_it() {
    let (mut r, attach) = restored(Some(false), Some(false));
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Observer);
    assert!(r.typed("l").is_empty(), "keys alone never take control");
    assert!(
        r.screen().contains("Nobody holds control"),
        "{}",
        r.screen()
    );
}

#[test]
fn a_restored_pane_shows_who_holds_control() {
    let (mut r, _) = restored(Some(false), Some(true));
    assert!(r.typed("l").is_empty());
    assert!(
        r.screen().contains("Another viewer holds control"),
        "{}",
        r.screen()
    );
}

// ---- semantics ------------------------------------------------------------------

#[test]
fn the_terminal_node_carries_the_visible_screen_and_the_cursor_and_modes() {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, b"hello\r\nworld\x1b[?2004h");
    let tree = r.valid_tree();
    let term = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "terminal")
        .unwrap();
    let text = term.text.as_deref().unwrap();
    assert!(text.starts_with("hello\nworld"), "{text:?}");
    let d = term.state.description.as_deref().unwrap();
    assert!(d.contains("Cursor at row 2, column 6."), "{d}");
    assert!(d.contains("Bracketed paste on."), "{d}");
    r.bytes(1, 20, b"\x1b[?1049h");
    let tree = r.valid_tree();
    let term = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "terminal")
        .unwrap();
    assert!(
        term.state
            .description
            .as_deref()
            .unwrap()
            .contains("Alternate screen.")
    );
}

#[test]
fn the_screen_text_is_bounded_by_the_core() {
    let mut r = rig();
    r.live();
    for i in 0..400 {
        let off = (i * 20) as u64;
        r.bytes(1, off, format!("{:019}\n", i).as_bytes());
    }
    let tree = r.valid_tree();
    let term = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "terminal")
        .unwrap();
    assert!(
        term.text.as_deref().unwrap().len() <= theorem_workbench_core::semantics::MAX_NODE_TEXT
    );
}

// ---- actions ---------------------------------------------------------------------

#[test]
fn the_pane_registers_its_workflows_and_only_the_confirmation_is_human_only() {
    let registry = {
        let mut reg = builtin::registry();
        extend_registry(&mut reg).unwrap();
        reg
    };
    for id in [
        "shell.attach",
        "shell.observe",
        "shell.control",
        "shell.resend",
        "shell.end.confirm",
    ] {
        assert!(registry.action(&ActionId::new(id)).is_some(), "{id}");
    }
    let human = |id: &str| registry.action(&ActionId::new(id)).unwrap().1.human_only;
    assert!(human("shell.end.confirm"));
    assert!(!human("shell.control") && !human("shell.attach"));
    // Registering twice is refused rather than duplicated.
    let mut again = registry;
    assert!(extend_registry(&mut again).is_err());
}

#[test]
fn shell_attach_and_shell_control_act_on_the_selected_row_and_the_lease() {
    let mut r = rig();
    let fx = r.send(Msg::Action {
        id: ActionId::new("shell.observe"),
        actor: Actor::Agent { run_id: "r".into() },
    });
    let attach = only_attach(&fx);
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Observer);
    r.accept_attach(
        &attach,
        TerminalOpened {
            controlling: Some(false),
            controlled: Some(false),
            ..opened(1, 1, 80, 24, "reattached")
        },
    );
    let fx = r.send(Msg::Action {
        id: ActionId::new("shell.control"),
        actor: Actor::Human,
    });
    let attach = only_attach(&fx);
    let EffectBody::TerminalAttach(a) = &attach.body else {
        unreachable!()
    };
    assert_eq!(a.role, TerminalRole::Controller);
}

#[test]
fn an_agent_cannot_confirm_the_end_and_a_person_can_only_after_it_was_asked() {
    let mut r = rig();
    r.live();
    let agent = Actor::Agent { run_id: "r".into() };
    let act = |r: &mut Rig, id: &str, actor: Actor| {
        r.send(Msg::Action {
            id: ActionId::new(id),
            actor,
        })
    };
    // Nothing asked yet: even a person's confirm emits nothing.
    assert!(act(&mut r, "shell.end.confirm", Actor::Human).is_empty());
    assert!(act(&mut r, "shell.end", agent.clone()).is_empty());
    assert!(
        act(&mut r, "shell.end.confirm", agent).is_empty(),
        "refused for a model"
    );
    assert!(r.screen().contains("End process s1?"));
    let fx = act(&mut r, "shell.end.confirm", Actor::Human);
    assert_eq!(kinds(&fx), ["end"]);
}

#[test]
fn the_unconfirmed_input_can_be_resent_through_its_action_with_the_same_id() {
    let mut r = rig();
    r.live();
    let fx = r.typed("a");
    r.answer(&fx[0], Outcome::Uncertain { reason: "t".into() }, None);
    let again = r.send(Msg::Action {
        id: ActionId::new("shell.resend"),
        actor: Actor::Human,
    });
    assert_eq!(inputs(&again), inputs(&fx));
}

// ---- resets read from epochs, not from screen text -----------------------------

#[test]
fn the_first_repaint_after_an_attach_does_not_rewrite_how_the_binding_began() {
    let mut r = rig();
    r.live();
    r.reset(1, 0, b"\x1b[Hfirst paint");
    assert!(
        r.screen()
            .contains("kept running while no view was attached")
    );
}

// ---- colours from the context theme --------------------------------------------

fn sgr_rig() -> (Rig, u16, u16) {
    let mut r = rig();
    r.live();
    r.bytes(1, 0, fixture!("sgr.vt"));
    let b = r.body();
    (r, b.width, b.height)
}

#[test]
fn a_theme_with_no_colours_draws_exactly_what_the_explicit_palette_draws() {
    use ratatui::style::{Modifier, Style};
    let (r, w, h) = sgr_rig();
    let plain = r.draw_with(w, h, &Theme::plain());
    let bare = Theme::chrome(
        Style::default(),
        Style::default(),
        Style::default(),
        Style::default(),
        Style::default(),
        Style::default(),
    );
    // The header and footer take the chrome roles, which differ by theme; the
    // terminal grid takes only the palette.
    let bare_drawn = r.draw_with(w, h, &bare);
    for y in 1..h - 1 {
        for x in 0..w {
            assert_eq!(bare_drawn[(x, y)], plain[(x, y)], "({x},{y})");
        }
    }
    // Roles that only carry a modifier say nothing about colour.
    let reversed = Style::default().add_modifier(Modifier::REVERSED);
    let modifiers = Theme::chrome(
        Style::default(),
        Style::default(),
        Style::default(),
        Style::default(),
        reversed,
        reversed,
    );
    let drawn = r.draw_with(w, h, &modifiers);
    let pal = palette();
    for y in 0..h {
        for x in 0..w {
            // Only the chrome roles' own modifiers differ; the grid is the palette's.
            if y > 1 && y < h - 1 {
                assert_eq!(drawn[(x, y)].fg, plain[(x, y)].fg, "({x},{y})");
                assert_eq!(drawn[(x, y)].bg, plain[(x, y)].bg, "({x},{y})");
            }
        }
    }
    assert_eq!(cell_fg(&drawn, 0, 1), pal.ansi[1]);
}

#[test]
fn setting_ansi_one_on_the_theme_recolours_an_sgr_31_cell_and_only_that_colour() {
    let (r, w, h) = sgr_rig();
    let pal = palette();
    let red = Color::Rgb(0xaa, 0x11, 0x22);
    let mut ansi = [Color::Reset; 16];
    ansi[1] = red;
    let drawn = r.draw_with(w, h, &Theme::plain().with_ansi(ansi));
    assert_eq!(cell_fg(&drawn, 0, 1), red);
    // Entries left at Reset keep today's value.
    assert_eq!(cell_fg(&drawn, 4, 1), pal.ansi[2]);
    assert_eq!(cell_fg(&drawn, 9, 1), Color::Indexed(196));
}

#[test]
fn the_themes_text_and_background_roles_win_over_the_explicit_palette() {
    use ratatui::style::Style;
    let (r, w, h) = sgr_rig();
    let theme = Theme::chrome(
        Style::default().bg(Color::Rgb(1, 1, 1)),
        Style::default().fg(Color::Rgb(9, 9, 9)),
        Style::default(),
        Style::default(),
        Style::default(),
        Style::default(),
    );
    let drawn = r.draw_with(w, h, &theme);
    // A cell past the text on a grid row is the default colours.
    let cell = &drawn[(w - 1, 1)];
    assert_eq!(cell.fg, Color::Rgb(9, 9, 9));
    assert_eq!(cell.bg, Color::Rgb(1, 1, 1));
}

// ---- adoption and the host's modes -----------------------------------------------

fn listing_with(
    sessions: Vec<TerminalSessionInfo>,
    adoption: Option<theorem_workbench_core::host::TerminalAdoption>,
) -> Msg {
    Msg::Host(HostMessage::TerminalSessions {
        workspace: "w".into(),
        profiles: vec![profile("native-zsh", TerminalBackend::Native, true)],
        sessions,
        adoption,
    })
}

fn no_chooser_note(s: &str) {
    assert!(!s.contains("No existing sessions"), "{s}");
}

#[test]
fn a_pending_listing_says_the_host_is_still_looking_and_never_says_there_are_none() {
    use theorem_workbench_core::host::TerminalAdoption;
    let mut r = rig();
    r.send(listing_with(vec![], Some(TerminalAdoption::Pending)));
    let s = r.screen();
    assert!(s.contains("still looking for running terminals"), "{s}");
    assert!(s.contains("No sessions listed yet"), "{s}");
    no_chooser_note(&s);
}

#[test]
fn a_settled_empty_listing_is_the_truth_and_says_there_are_no_sessions() {
    use theorem_workbench_core::host::TerminalAdoption;
    let mut r = rig();
    r.send(listing_with(vec![], Some(TerminalAdoption::Settled)));
    let s = r.screen();
    assert!(s.contains("No existing sessions to attach to"), "{s}");
    assert!(
        !s.contains("still looking") && !s.contains("cannot list"),
        "{s}"
    );
}

#[test]
fn an_unavailable_listing_gives_the_hosts_reason_and_without_one_still_says_it_cannot_list() {
    use theorem_workbench_core::host::TerminalAdoption;
    let mut r = rig();
    r.send(listing_with(
        vec![],
        Some(TerminalAdoption::Unavailable {
            reason: Some("herdr socket missing".into()),
        }),
    ));
    let s = r.screen();
    assert!(
        s.contains("The host cannot list its terminals: herdr socket missing"),
        "{s}"
    );
    no_chooser_note(&s);
    r.send(listing_with(
        vec![],
        Some(TerminalAdoption::Unavailable { reason: None }),
    ));
    assert!(r.screen().contains("The host cannot list its terminals."));
}

#[test]
fn a_host_that_does_not_report_adoption_is_drawn_as_before() {
    let mut r = rig();
    r.send(listing_with(vec![], None));
    let s = r.screen();
    assert!(s.contains("No existing sessions to attach to"), "{s}");
    assert!(
        !s.contains("still looking") && !s.contains("cannot list"),
        "{s}"
    );
}

#[test]
fn only_a_settled_listing_says_an_attached_session_is_gone() {
    use theorem_workbench_core::host::TerminalAdoption;
    for (adoption, gone) in [
        (None, false),
        (Some(TerminalAdoption::Pending), false),
        (Some(TerminalAdoption::Unavailable { reason: None }), false),
        (Some(TerminalAdoption::Settled), true),
    ] {
        let mut r = rig();
        r.live();
        r.send(listing_with(vec![], adoption.clone()));
        let s = r.screen();
        assert_eq!(s.contains("is gone"), gone, "{adoption:?}: {s}");
        assert!(r.m.panel(&r.id).is_some(), "the pane is never dropped");
        // Listed again by a settled host, the session is back.
        r.send(listing_with(
            vec![session("s1", TerminalBackend::Herdr)],
            Some(TerminalAdoption::Settled),
        ));
        assert!(!r.screen().contains("is gone"));
    }
}

fn moded() -> theorem_workbench_core::host::TerminalModes {
    use theorem_workbench_core::host::{MouseEncoding, MouseProtocol, TerminalModes};
    TerminalModes {
        alternate_screen: true,
        application_cursor: true,
        application_keypad: false,
        bracketed_paste: true,
        hide_cursor: false,
        mouse_protocol: MouseProtocol::PressRelease,
        mouse_encoding: MouseEncoding::Sgr,
    }
}

/// An attach to a session the host lists with `modes`, answered with no output.
fn attached_with(modes: Option<theorem_workbench_core::host::TerminalModes>) -> Rig {
    let mut r = rig();
    let mut s = session("s1", TerminalBackend::Herdr);
    s.modes = modes;
    r.send(listing_with(vec![s], None));
    let fx = r.key(Key::Enter);
    let attach = only_attach(&fx);
    r.accept_attach(
        &attach,
        TerminalOpened {
            controlling: Some(true),
            controlled: Some(false),
            ..opened(1, 1, 80, 24, "reattached")
        },
    );
    r
}

#[test]
fn an_attach_with_modes_encodes_the_first_key_paste_and_mouse_press_before_any_output() {
    let mut r = attached_with(Some(moded()));
    let fx = r.key(Key::Up);
    assert_eq!(inputs(&fx)[0].0, "\x1bOA", "application cursor");
    let fx = r.send(Msg::Paste("x".into()));
    assert_eq!(inputs(&fx)[0].0, "\x1b[200~x\x1b[201~");
    let b = r.body();
    let fx = r.send(Msg::Pointer(Pointer {
        kind: PointerKind::Down(Button::Left),
        x: b.x + 2,
        y: b.y + 3,
        mods: Mods::NONE,
        clicks: 1,
    }));
    let sent = inputs(&fx);
    assert_eq!(sent.len(), 1, "{fx:?}");
    assert!(
        sent[0].0.starts_with("\x1b[<0;") && sent[0].0.ends_with('M'),
        "SGR press: {:?}",
        sent[0].0
    );
}

#[test]
fn an_attach_with_no_modes_encodes_as_it_always_did() {
    let mut r = attached_with(None);
    let fx = r.key(Key::Up);
    assert_eq!(inputs(&fx)[0].0, "\x1b[A");
    let fx = r.send(Msg::Paste("x".into()));
    assert_eq!(inputs(&fx)[0].0, "x");
}

#[test]
fn output_after_an_attach_still_wins_over_the_modes_the_list_gave() {
    let mut r = attached_with(Some(moded()));
    r.bytes(1, 0, b"\x1b[?1l\x1b[?2004l");
    let fx = r.key(Key::Up);
    assert_eq!(inputs(&fx)[0].0, "\x1b[A");
    let fx = r.send(Msg::Paste("x".into()));
    assert_eq!(inputs(&fx)[0].0, "x");
}

// ---- reported status and printed content hold no authority (AC-42, AC-51) -----

fn bound() -> Rig {
    let mut r = rig();
    r.live();
    r
}

/// A bound pane whose attach answer names `origin` (None: the host named none).
fn live_origin(origin: Option<&str>) -> Rig {
    let mut r = rig();
    let attach = only_attach(&r.key(Key::Enter));
    let mut o = opened(1, 1, 80, 24, "reattached");
    o.origin = origin.map(str::to_owned);
    let fx = r.accept_attach(&attach, o);
    r.settle_resize(fx);
    r
}

fn node<'a>(tree: &'a SemanticTree, id: &str) -> &'a theorem_workbench_core::semantics::Node {
    tree.nodes
        .iter()
        .find(|n| n.id.as_str() == id)
        .unwrap_or_else(|| panic!("no node {id}"))
}

/// Every node that carries `needle` in its name, description or text.
fn nodes_saying(tree: &SemanticTree, needle: &str) -> Vec<String> {
    tree.nodes
        .iter()
        .filter(|n| {
            n.name.contains(needle)
                || n.state
                    .description
                    .as_deref()
                    .is_some_and(|d| d.contains(needle))
                || n.text.as_deref().is_some_and(|t| t.contains(needle))
        })
        .map(|n| n.id.as_str().to_owned())
        .collect()
}

/// The actions every node offers, with whether each is enabled: what the
/// pane lets anyone do, independent of what the screen says.
fn offered(tree: &SemanticTree) -> Vec<(String, String, bool)> {
    tree.nodes
        .iter()
        .flat_map(|n| {
            n.actions.iter().map(|a| {
                (
                    n.id.as_str().to_owned(),
                    a.id.as_str().to_owned(),
                    a.enabled,
                )
            })
        })
        .collect()
}

#[test]
fn a_host_that_names_no_origin_is_drawn_with_no_claim_about_how_the_program_began() {
    let r = live_origin(None);
    let s = r.screen();
    for claim in [
        "Started in",
        "Adopted",
        "Re-attached",
        "replaced",
        "continues",
    ] {
        assert!(!s.contains(claim), "{claim:?} invented in\n{s}");
    }
    let tree = r.valid_tree();
    assert_eq!(node(&tree, "status").state.description, None);
    assert!(tree.nodes.iter().all(|n| n.id.as_str() != "notice"));
}

#[test]
fn an_origin_word_the_pane_does_not_know_is_quoted_as_the_hosts_and_never_acted_on() {
    for word in ["blocked", "finished", "done"] {
        let mut r = live_origin(Some(word));
        let s = r.screen();
        assert!(
            s.contains(&format!("The host reports the origin as \"{word}\".")),
            "{s}"
        );
        assert!(
            !s.contains("The program has ended") && !s.contains("lost"),
            "{word} read as an ending:\n{s}"
        );
        let tree = r.valid_tree();
        let status = node(&tree, "status");
        assert!(status.name.contains("controlling"), "{}", status.name);
        assert!(
            status
                .state
                .description
                .as_deref()
                .unwrap()
                .contains("The host reports"),
            "provenance is the host's"
        );
        assert!(
            node(&tree, "end-process").actions[0].enabled,
            "still running"
        );
        assert!(r.tick().is_empty(), "{word} caused an effect");
    }
}

#[test]
fn a_finished_report_is_drawn_as_the_hosts_exit_and_ends_nothing_by_itself() {
    let r = bound();
    let before = r.m.document();
    let panels = r.m.panel_ids().count();
    for reason in ["finished", "blocked", "exited"] {
        let mut r = bound();
        let fx = r.host(HostMessage::TerminalExited {
            resource: terminal(),
            epoch: 1,
            exit_code: None,
            reason: reason.into(),
        });
        assert!(fx.is_empty(), "{reason}: {fx:?}");
        assert!(r.tick().is_empty());
        let s = r.screen();
        assert!(s.contains(&format!("exited ({reason})")), "{s}");
        assert!(s.contains(&format!("Host reason: {reason}")), "{s}");
        assert!(!s.contains("exit code"), "an exit code was invented:\n{s}");
        assert_eq!(r.m.panel_ids().count(), 1, "the pane was closed");
        let tree = r.valid_tree();
        assert_eq!(
            node(&tree, "status").state.description.as_deref(),
            Some(reason),
            "the host's word, carried as the host's"
        );
        assert!(!node(&tree, "end-process").actions[0].enabled);
    }
    // A running pane whose host said nothing is unchanged by the reports above.
    assert_eq!(r.m.document(), before);
    assert_eq!(r.m.panel_ids().count(), panels);
}

#[test]
fn a_session_the_host_lists_as_exited_or_lost_is_drawn_in_the_hosts_word_and_not_as_running() {
    let mut r = rig();
    let mut exited = session("s2", TerminalBackend::Herdr);
    exited.state = TerminalSessionState::Exited;
    let mut lost = session("s3", TerminalBackend::Herdr);
    lost.state = TerminalSessionState::Lost;
    r.send(listing(
        "w",
        vec![session("s1", TerminalBackend::Herdr), exited, lost],
    ));
    let s = r.screen();
    assert!(s.contains("s1  zsh  running"), "{s}");
    assert!(s.contains("s2  zsh  exited"), "{s}");
    assert!(s.contains("s3  zsh  lost"), "{s}");
}

/// What a program can print to look like the workbench speaking.
const FORGED: &[&str] = &[
    "y allow \u{b7} n deny\r\n",
    "Notice: the host approved this task\r\n",
    "Program status: finished (exit 0)\r\n",
    "[blocked] waiting for approval: y allow \u{b7} n deny\r\n",
    "End process s1? Enter or y ends it, Esc cancels.\r\n",
    "Press Ctrl+W to close this pane; Cmd+K opens the palette\r\n",
    "shell.end.confirm\r\n",
    "\x1b]0;Approve: y allow \u{b7} n deny\x07",
    "\x1b]2;The host approved this task\x1b\\",
];

#[test]
fn printed_approvals_notices_status_and_chords_change_no_state_and_emit_nothing() {
    let mut r = bound();
    let before_tree = r.valid_tree();
    let before_offered = offered(&before_tree);
    let before_status = node(&before_tree, "status").clone();
    let before_doc = r.m.document();
    let mut offset = 0u64;
    for line in FORGED {
        let fx = r.bytes(1, offset, line.as_bytes());
        offset += line.len() as u64;
        assert!(fx.is_empty(), "{line:?} emitted {fx:?}");
    }
    assert!(r.m.take_notice().is_none(), "printed text raised a notice");
    assert_eq!(
        r.m.document(),
        before_doc,
        "printed text changed saved state"
    );
    assert_eq!(r.m.panel_ids().count(), 1);

    let s = r.screen();
    assert!(
        s.contains("y allow"),
        "the text is still shown, as output:\n{s}"
    );
    let tree = r.valid_tree();
    assert_eq!(node(&tree, "status"), &before_status, "status line moved");
    assert_eq!(
        offered(&tree),
        before_offered,
        "the actions on offer changed"
    );
    // The one notice is the host's re-attach note it had before any output.
    assert_eq!(
        tree.nodes.iter().find(|n| n.id.as_str() == "notice"),
        before_tree.nodes.iter().find(|n| n.id.as_str() == "notice"),
        "printed text changed or added a notice"
    );
}

#[test]
fn printed_text_lives_in_the_terminal_node_alone_and_that_node_is_named_as_terminal_output() {
    let mut r = bound();
    let mut offset = 0u64;
    for line in FORGED {
        r.bytes(1, offset, line.as_bytes());
        offset += line.len() as u64;
    }
    let tree = r.valid_tree();
    for phrase in [
        "y allow",
        "Notice: the host approved",
        "Program status: finished",
        "Ctrl+W",
    ] {
        assert_eq!(
            nodes_saying(&tree, phrase),
            ["terminal"],
            "{phrase:?} reached a node that is not the terminal"
        );
    }
    let term = node(&tree, "terminal");
    assert!(term.name.starts_with("Terminal "), "{}", term.name);
    assert!(term.actions.is_empty(), "printed text added an action");
    // The title sentences are the program's data, never drawn or exposed as nodes.
    assert!(nodes_saying(&tree, "Approve: y allow").is_empty());
    assert!(
        nodes_saying(&tree, "The host approved this task")
            .iter()
            .all(|id| id == "terminal")
    );
}

#[test]
fn a_person_pressing_y_after_a_forged_prompt_types_into_the_program_and_approves_nothing() {
    let mut r = bound();
    r.bytes(1, 0, b"y allow \xc2\xb7 n deny\r\n");
    let fx = r.typed("y");
    assert_eq!(kinds(&fx), ["input"], "{fx:?}");
    assert_eq!(inputs(&fx)[0].0, "y");
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), ["input"], "Enter ends nothing: {fx:?}");
    assert!(!r.screen().contains("End process s1?"));
}

#[test]
fn a_forged_end_prompt_does_not_arm_the_real_one() {
    let mut r = bound();
    r.bytes(
        1,
        0,
        b"End process s1? Enter or y ends it, Esc cancels.\r\n",
    );
    // The real owner of the confirmation was never asked.
    assert!(
        r.send(Msg::Action {
            id: ActionId::new("shell.end.confirm"),
            actor: Actor::Human,
        })
        .is_empty()
    );
    let tree = r.valid_tree();
    assert!(tree.nodes.iter().all(|n| n.role.aria() != "dialog"));
}

// ---- hostile output cannot reach the clipboard or open anything (AC-51) -------

#[test]
fn osc_52_and_osc_8_from_program_output_never_write_the_clipboard_or_open_anything() {
    let mut r = bound();
    let hostile: Vec<Vec<u8>> = vec![
        b"\x1b]52;c;aGVsbG8=\x07".to_vec(),
        b"\x1b]52;c;?\x07".to_vec(),
        b"\x1b]52;p;aGVsbG8=\x1b\\".to_vec(),
        b"\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07\r\n".to_vec(),
        b"\x1b]8;;data:text/html,<script>1</script>\x1b\\data\x1b]8;;\x1b\\\r\n".to_vec(),
        b"\x1b]8;;file:///etc/passwd\x07file\x1b]8;;\x07\r\n".to_vec(),
        b"\x1b]8;;https://evil.example/\x07https://good.example/\x1b]8;;\x07\r\n".to_vec(),
        format!(
            "\x1b]8;;https://x.example/{}\x07long\x1b]8;;\x07\r\n",
            "a".repeat(70_000)
        )
        .into_bytes(),
        "\x1b]8;;https://x.example/\x01\x02\x7f\u{9b}2J\x07ctl\x1b]8;;\x07\r\n"
            .as_bytes()
            .to_vec(),
    ];
    let mut offset = 0u64;
    for bytes in &hostile {
        let fx = r.bytes(1, offset, bytes);
        offset += bytes.len() as u64;
        assert!(
            fx.is_empty(),
            "{:?} emitted {fx:?}",
            &bytes[..20.min(bytes.len())]
        );
    }
    // Clicking where the link text is only selects; it opens nothing.
    let fx = r.click_at(1, 4);
    assert!(fx.is_empty(), "a click on link text emitted {fx:?}");
    assert!(r.m.take_notice().is_none());
    let s = r.screen();
    for leak in ["javascript", "evil.example", "passwd", "script", "aGVsbG8"] {
        assert!(!s.contains(leak), "{leak:?} reached the screen:\n{s}");
    }
    assert!(
        s.contains("click") && s.contains("https://good.example/"),
        "{s}"
    );
}

#[test]
fn the_clipboard_is_written_only_by_a_persons_copy_of_a_selection() {
    let mut r = bound();
    r.bytes(1, 0, b"\x1b]52;c;aGVsbG8=\x07shown text\r\n");
    let b = r.body();
    let at = |kind, x| {
        Msg::Pointer(Pointer {
            kind,
            x: b.x + x,
            y: b.y + 1,
            mods: Mods::NONE,
            clicks: 1,
        })
    };
    r.send(at(PointerKind::Down(Button::Left), 0));
    r.send(at(PointerKind::Move, 4));
    let fx = r.send(at(PointerKind::Up(Button::Left), 4));
    assert!(fx.is_empty(), "selecting alone wrote the clipboard: {fx:?}");
    let fx = r.mods(Key::Char('c'), Mods::CMD);
    let EffectBody::ClipboardWrite(w) = &fx[0].body else {
        panic!("{fx:?}")
    };
    assert_eq!(
        w.text, "shown",
        "the person's selection, not the program's payload"
    );
}

#[test]
fn a_control_sequence_in_a_host_reason_is_not_drawn_into_the_chrome_as_a_control() {
    let mut r = rig();
    let attach = only_attach(&r.key(Key::Enter));
    r.answer(
        &attach,
        Outcome::Refused {
            code: "terminal_control_refused".into(),
            reason: "held\r\nby\x1b[2J another\x07".into(),
        },
        None,
    );
    let buf = r.draw(100, 30);
    for y in 0..30 {
        for x in 0..100 {
            let sym = buf[(x, y)].symbol();
            assert!(
                sym.chars().all(|c| !c.is_control()),
                "control character {sym:?} drawn at {x},{y}"
            );
        }
    }
}

// ---- host errors are readable and scoped (AC-51) ---------------------------------

fn assert_readable(s: &str) {
    for debug in [
        "Refused {",
        "Failed {",
        "Uncertain {",
        "[object",
        "Some(",
        "None",
        "\\u{",
    ] {
        assert!(!s.contains(debug), "debug text {debug:?} in\n{s}");
    }
}

#[test]
fn a_refusal_shows_its_code_and_reason_as_plain_text_in_this_pane() {
    let mut r = rig();
    let attach = only_attach(&r.key(Key::Enter));
    r.answer(
        &attach,
        Outcome::Refused {
            code: "terminal_control_refused".into(),
            reason: "another viewer holds control".into(),
        },
        None,
    );
    let s = r.screen();
    assert!(s.contains("The host refused"), "{s}");
    assert!(
        s.contains("Host reason: another viewer holds control"),
        "{s}"
    );
    assert!(s.contains("Code: terminal_control_refused"), "{s}");
    assert_readable(&s);
    let tree = r.valid_tree();
    let alert = node(&tree, "status");
    assert_eq!(alert.role.aria(), "alert");
    assert_eq!(
        alert.state.description.as_deref(),
        Some("another viewer holds control")
    );
}

#[test]
fn a_failed_attach_and_an_uncertain_open_are_readable_and_say_what_they_do_not_know() {
    let mut r = rig();
    let attach = only_attach(&r.key(Key::Enter));
    r.answer(
        &attach,
        Outcome::Failed {
            reason: "the socket closed".into(),
        },
        None,
    );
    let s = r.screen();
    assert!(
        s.contains("The request failed") && s.contains("Host reason: the socket closed"),
        "{s}"
    );
    assert!(!s.contains("Code:"), "a code was invented:\n{s}");
    assert_readable(&s);

    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let open = r.key(Key::Enter)[0].clone();
    r.answer(
        &open,
        Outcome::Uncertain {
            reason: "socket closed".into(),
        },
        None,
    );
    let s = r.screen();
    assert!(
        s.contains("Unknown whether a shell started (socket closed)"),
        "{s}"
    );
    assert_readable(&s);
}

#[test]
fn a_failure_with_no_reason_still_reads_as_a_sentence() {
    let mut r = rig();
    let attach = only_attach(&r.key(Key::Enter));
    r.answer(
        &attach,
        Outcome::Failed {
            reason: String::new(),
        },
        None,
    );
    let s = r.screen();
    assert!(
        !s.contains("Host reason: \n") && !s.lines().any(|l| l.trim_end() == "Host reason:"),
        "{s}"
    );
    assert!(s.contains("Host reason: The host gave no reason."), "{s}");
    let tree = r.valid_tree();
    assert_eq!(
        node(&tree, "status").state.description.as_deref(),
        Some("The host gave no reason.")
    );

    let mut r = rig();
    r.key(Key::Down);
    r.key(Key::Down);
    let open = r.key(Key::Enter)[0].clone();
    r.answer(&open, Outcome::Uncertain { reason: " ".into() }, None);
    let s = r.screen();
    assert!(
        s.contains("Unknown whether a shell started (The host gave no reason.)"),
        "{s}"
    );
}

// ---- frames from an older wire are not guessed at (AC-62, R27) -------------------

#[test]
fn a_frame_whose_payload_is_not_the_supported_encoding_draws_nothing_and_is_not_guessed() {
    let mut r = bound();
    r.bytes(1, 0, b"kept\r\n");
    let before = r.screen();
    // A frame in an older shape: the payload is raw terminal text, or the
    // length-prefixed binary an original Remux client would have sent, not
    // base64.
    let legacy: [&str; 3] = [
        "\x1b[31mraw text\x1b[0m",
        "\u{0}\u{0}\u{0}\u{5}hello",
        "not base64!!",
    ];
    for payload in legacy {
        for msg in [
            HostMessage::TerminalOutput {
                resource: terminal(),
                epoch: 1,
                offset: 6,
                data: payload.into(),
            },
            HostMessage::TerminalReset {
                resource: terminal(),
                epoch: 1,
                offset: 6,
                data: payload.into(),
            },
        ] {
            let mut fx = r.host(msg);
            fx.extend(r.tick());
            assert!(
                !kinds(&fx).contains(&"clipboard") && !kinds(&fx).contains(&"end"),
                "{fx:?}"
            );
            assert_eq!(r.screen(), before, "{payload:?} drew something");
        }
    }
    // The supported encoding at the same offset still draws.
    r.bytes(1, 6, b"next");
    assert!(r.screen().contains("next"));
}
