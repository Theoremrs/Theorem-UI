//! The Elm root, driven only through its public API, the way a host and a
//! panel crate would use it.

use std::cell::RefCell;
use std::rc::Rc;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{Completion, Outcome};
use theorem_workbench_core::effect::{Effect, EffectBody, EffectKind, TerminalClaim};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{
    ActionId, Actor, EffectId, Generation, PanelInstanceId, PanelKind, ResourceKind, ResourceRef,
    Revision,
};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::picker::PickerMsg;
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent, BodyKind, Capabilities, CellSize, KeyScope, PanelDescriptor,
    Placement, Refusal,
};
use theorem_workbench_core::semantics::{Node, Role};
use theorem_workbench_core::stale::{Binding, Stale};
use theorem_workbench_core::{
    Button, Ctx, DockMsg, EmitError, Model, Msg, Notice, Panel, PanelFactories, PanelMsg, Pointer,
    PointerKind, Theme, ViewCtx, semantics, update, view,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

#[derive(Default)]
struct Log {
    msgs: Vec<(&'static str, PanelMsg)>,
    emits: Vec<Result<EffectId, EmitError>>,
    teardowns: Vec<bool>,
    greedy: bool,
    /// The binding epoch the next "term" panel is bound at; 0 means none.
    term_epoch: u64,
}

type Shared = Rc<RefCell<Log>>;

/// One test panel for two kinds: "note" is bound to a document, "term" to a
/// terminal. It records everything it is sent and every emit it attempts.
struct TestPanel {
    kind: &'static str,
    log: Shared,
    rev: u64,
    doc: String,
    taps: u64,
    epoch: u64,
}

impl TestPanel {
    fn new(kind: &'static str, state: &Value, log: Shared) -> Self {
        let term_epoch = log.borrow().term_epoch;
        Self {
            kind,
            log,
            rev: state["rev"].as_u64().unwrap_or(5),
            doc: state["doc"].as_str().unwrap_or("a.md").to_owned(),
            taps: state["taps"].as_u64().unwrap_or(0),
            epoch: state["epoch"].as_u64().unwrap_or(term_epoch),
        }
    }

    fn resource(&self) -> ResourceRef {
        match self.kind {
            "term" => ResourceRef::Terminal {
                workspace: "w".into(),
                session: "s1".into(),
            },
            "chat" => ResourceRef::Conversation {
                project: "p".into(),
                thread: "t1".into(),
            },
            _ => ResourceRef::Document {
                workspace: "w".into(),
                resource_id: self.doc.clone(),
            },
        }
    }

    fn try_emit(&mut self, cx: &mut Ctx, body: EffectBody) {
        let (resource, rev) = (self.resource(), self.rev);
        let r = cx.emit(|id| Effect::new(id, resource, body).with_revision(Revision::Seq(rev)));
        self.log.borrow_mut().emits.push(r);
    }
}

impl Panel for TestPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.log.borrow_mut().msgs.push((self.kind, msg.clone()));
        let greedy = self.log.borrow().greedy;
        match msg {
            PanelMsg::Key(k) if k.key() == Key::Char('+') => {
                self.rev += 1;
                self.taps += 1;
            }
            PanelMsg::Key(k) if k.key() == Key::Char('r') => self.doc = "b.md".into(),
            PanelMsg::Action(id) => match id.as_str() {
                "note.save" => self.try_emit(cx, EffectBody::DocumentSave),
                "term.end" => self.try_emit(cx, EffectBody::TerminalEnd),
                _ => {}
            },
            PanelMsg::Resize { .. } | PanelMsg::Focus(_) | PanelMsg::Tick if greedy => {
                self.try_emit(cx, EffectBody::DocumentSave);
            }
            _ => {}
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        buf.set_stringn(
            area.x,
            area.y,
            format!("{} taps={}", self.kind, self.taps),
            usize::from(area.width),
            cx.theme.text,
        );
    }

    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        let mut root = Node::new("root", Role::Region, self.kind, area);
        let leaf = Node::new("line", Role::Status, "line", area);
        root.children.push(leaf.id.clone());
        vec![root, leaf]
    }

    fn serialize(&self) -> Value {
        json!({"rev": self.rev, "doc": self.doc, "taps": self.taps})
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: Some(Revision::Seq(self.rev)),
            generation: (self.epoch > 0).then_some(Generation(self.epoch)),
        })
    }

    fn teardown(&mut self, cx: &mut Ctx, destroy: bool) {
        self.log.borrow_mut().teardowns.push(destroy);
        if self.kind == "term" {
            // A view detaches. This panel also tries to end the process every
            // time, so the test sees the root refuse it unless a Destroy runs.
            self.try_emit(
                cx,
                EffectBody::TerminalDetach(TerminalClaim {
                    attachment: "a1".into(),
                    lease_generation: 1,
                    epoch: 1,
                }),
            );
            self.try_emit(cx, EffectBody::TerminalEnd);
        }
    }
}

fn descriptor(
    kind: &str,
    binding: ResourceKind,
    actions: Vec<ActionDescriptor>,
) -> PanelDescriptor {
    PanelDescriptor {
        kind: PanelKind::new(kind),
        version: 1,
        title: kind.to_owned(),
        icon: "x".into(),
        body: BodyKind::Drawn,
        binding,
        actions,
        requires: vec![],
        min_size: CellSize { cols: 10, rows: 4 },
        default_placement: Placement::Tools,
        theme_roles: vec![],
        semantic_role: Role::Region,
    }
}

const ALL_CAPS: [&str; 11] = [
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

fn model(log: &Shared) -> Model {
    let mut registry = builtin::registry();
    registry
        .register(descriptor(
            "note",
            ResourceKind::Document,
            vec![
                ActionDescriptor::new("note.focus", "Note", ActionIntent::Focus),
                ActionDescriptor::new("note.open", "New note", ActionIntent::Open)
                    .key("Mod+Alt+K", KeyScope::Global),
                ActionDescriptor::new("note.save", "Save note", ActionIntent::Start)
                    .emits(EffectKind::DocumentSave),
            ],
        ))
        .unwrap();
    registry
        .register(descriptor(
            "term",
            ResourceKind::Terminal,
            vec![
                ActionDescriptor::new("term.open", "New term", ActionIntent::Open),
                ActionDescriptor::new("term.end", "End term", ActionIntent::Destroy)
                    .emits(EffectKind::TerminalEnd),
            ],
        ))
        .unwrap();
    registry
        .register(descriptor(
            "chat",
            ResourceKind::Conversation,
            vec![ActionDescriptor::new(
                "chat.open",
                "New chat",
                ActionIntent::Open,
            )],
        ))
        .unwrap();
    let mut factories = PanelFactories::new();
    for kind in ["note", "term", "chat"] {
        let log = log.clone();
        factories.register(kind, move |state, _| {
            Box::new(TestPanel::new(kind, state, log.clone()))
        });
    }
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(registry, factories, keys, Capabilities::of(ALL_CAPS), dock);
    send(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    m
}

fn new_model() -> (Model, Shared) {
    let log: Shared = Rc::default();
    (model(&log), log)
}

fn send(m: &mut Model, msg: Msg) -> Vec<Effect> {
    update(m, msg)
}

fn action(m: &mut Model, id: &str) -> Vec<Effect> {
    send(
        m,
        Msg::Action {
            id: ActionId::new(id),
            actor: Actor::Human,
        },
    )
}

fn key(m: &mut Model, key: Key, mods: Mods) -> Vec<Effect> {
    send(m, Msg::Key(KeyInput::new(key, mods)))
}

fn ch(m: &mut Model, c: char) -> Vec<Effect> {
    key(m, Key::Char(c), Mods::NONE)
}

fn kinds(m: &Model, kind: &str) -> Vec<PanelInstanceId> {
    m.panel_ids()
        .filter(|(_, k)| k.as_str() == kind)
        .map(|(id, _)| id.clone())
        .collect()
}

fn click(m: &mut Model, x: u16, y: u16) -> Vec<Effect> {
    let mut fx = send(
        m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Down(Button::Left),
            x,
            y,
            mods: Mods::NONE,
        }),
    );
    fx.extend(send(
        m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Up(Button::Left),
            x,
            y,
            mods: Mods::NONE,
        }),
    ));
    fx
}

fn doc(resource: &str) -> ResourceRef {
    ResourceRef::Document {
        workspace: "w".into(),
        resource_id: resource.into(),
    }
}

fn completion(effect: EffectId, resource: &str, rev: u64, outcome: Outcome) -> Completion {
    Completion::new(effect, doc(resource), outcome).with_revision(Revision::Seq(rev))
}

fn msgs_of(log: &Shared, kind: &str) -> Vec<PanelMsg> {
    log.borrow()
        .msgs
        .iter()
        .filter(|(k, _)| *k == kind)
        .map(|(_, m)| m.clone())
        .collect()
}

fn last_effect_id(effects: &[Effect]) -> EffectId {
    effects.last().expect("an effect was emitted").id
}

// ---- R07, AC-06: the picker has no hidden effects ---------------------

#[test]
fn picker_messages_produce_zero_effects() {
    let sequences: Vec<Vec<PickerMsg>> = vec![
        vec![PickerMsg::Open],
        vec![PickerMsg::Open, PickerMsg::Filter("sh".into())],
        vec![PickerMsg::Open, PickerMsg::Next, PickerMsg::Prev],
        vec![PickerMsg::Open, PickerMsg::Choose],
        // Prev wraps to the last row, More tools: Choose turns the page.
        vec![
            PickerMsg::Open,
            PickerMsg::Prev,
            PickerMsg::Choose,
            PickerMsg::Back,
        ],
        vec![
            PickerMsg::Open,
            PickerMsg::Filter("zzz".into()),
            PickerMsg::Choose,
        ],
        vec![PickerMsg::Open, PickerMsg::Back],
        vec![PickerMsg::Open, PickerMsg::Close],
        // Pointer selection: hover, click, and out of range.
        vec![PickerMsg::Open, PickerMsg::Select(2), PickerMsg::Select(99)],
        vec![PickerMsg::Open, PickerMsg::ChooseAt(0)],
        vec![PickerMsg::Open, PickerMsg::ChooseAt(5), PickerMsg::Back],
        vec![PickerMsg::Open, PickerMsg::ChooseAt(99)],
        vec![PickerMsg::Select(1), PickerMsg::ChooseAt(1)],
        vec![
            PickerMsg::Close,
            PickerMsg::Choose,
            PickerMsg::Filter("x".into()),
        ],
    ];
    for seq in sequences {
        let (mut m, _) = new_model();
        for msg in seq {
            let fx = send(&mut m, Msg::Picker(msg.clone()));
            assert!(fx.is_empty(), "{msg:?} returned {fx:?}");
        }
        assert!(m.in_flight().is_empty());
    }

    // Choosing each of the main rows only opens a tool: nothing starts.
    for row in 0..6 {
        let (mut m, _) = new_model();
        send(&mut m, Msg::Picker(PickerMsg::Open));
        for _ in 0..row {
            send(&mut m, Msg::Picker(PickerMsg::Next));
        }
        let fx = send(&mut m, Msg::Picker(PickerMsg::Choose));
        assert!(fx.is_empty(), "row {row} returned {fx:?}");
        assert!(m.in_flight().is_empty());
    }

    // The same rows chosen by a pointer click.
    for row in 0..6 {
        let (mut m, _) = new_model();
        send(&mut m, Msg::Picker(PickerMsg::Open));
        send(&mut m, Msg::Picker(PickerMsg::Select(row)));
        let fx = send(&mut m, Msg::Picker(PickerMsg::ChooseAt(row)));
        assert!(fx.is_empty(), "row {row} returned {fx:?}");
        assert!(m.in_flight().is_empty());
    }

    // The same through keys and text, which is how a person reaches them.
    let (mut m, _) = new_model();
    let opened = key(&mut m, Key::Char('t'), Mods::CTRL | Mods::ALT);
    assert!(
        opened.is_empty() && m.picker().is_open(),
        "the chord opens the picker"
    );
    for fx in [
        send(&mut m, Msg::Text("sh".into())),
        send(&mut m, Msg::Paste("ell".into())),
        key(&mut m, Key::Down, Mods::NONE),
        key(&mut m, Key::Backspace, Mods::NONE),
        key(&mut m, Key::Esc, Mods::NONE),
    ] {
        assert!(fx.is_empty());
    }
    assert!(!m.picker().is_open());
}

#[test]
fn the_picker_is_a_tab_in_tools_that_the_chosen_tool_replaces() {
    let (mut m, _) = new_model();
    action(&mut m, "picker.open");
    assert!(m.picker().is_open());
    let picker = kinds(&m, "picker");
    assert_eq!(picker.len(), 1);
    // The tools region is the empty destination: the picker panel is in it.
    let tools = m.dock().group_ids().into_iter().find(|g| {
        m.dock()
            .group(*g)
            .is_some_and(|g| g.role() == theorem_workbench_dock::Role::Tools)
    });
    assert_eq!(m.dock().find_panel(&picker[0].as_str().into()), tools);

    // Row 0 is Changes.
    let fx = key(&mut m, Key::Enter, Mods::NONE);
    assert!(fx.is_empty());
    assert!(!m.picker().is_open());
    assert!(kinds(&m, "picker").is_empty());
    assert_eq!(kinds(&m, "changes").len(), 1);
}

// ---- R05, R07: Focus and Open change only the dock --------------------

#[test]
fn focus_and_open_actions_produce_zero_effects() {
    let (mut m, log) = new_model();
    log.borrow_mut().greedy = true;
    for id in [
        "note.open",
        "note.focus",
        "note.open",
        "term.open",
        "files.focus",
    ] {
        let fx = action(&mut m, id);
        assert!(fx.is_empty(), "{id} returned {fx:?}");
        assert!(m.in_flight().is_empty());
    }
    assert_eq!(kinds(&m, "note").len(), 2);
    // Focus on a kind that is open focuses it; it does not open another.
    let before = m.panel_ids().count();
    action(&mut m, "note.focus");
    assert_eq!(m.panel_ids().count(), before);

    // The panels tried to start work when told their size and focus, and were
    // refused: opening a tool cannot start one.
    let attempts = log.borrow().emits.clone();
    assert!(!attempts.is_empty());
    assert!(attempts.iter().all(|r| r == &Err(EmitError::Silent)));
}

#[test]
fn an_unknown_or_refused_action_changes_nothing() {
    let (mut m, _) = new_model();
    let before = m.document();
    assert!(action(&mut m, "no.such.action").is_empty());
    assert!(matches!(
        m.take_notice(),
        Some(Notice::Refused(Refusal::UnknownAction(_)))
    ));
    // A model-origin approval is refused (R34).
    let fx = send(
        &mut m,
        Msg::Action {
            id: ActionId::new("approval.allow"),
            actor: Actor::Agent { run_id: "r".into() },
        },
    );
    assert!(fx.is_empty());
    assert!(matches!(
        m.take_notice(),
        Some(Notice::Refused(Refusal::HumanOnly(_)))
    ));
    assert_eq!(m.document(), before);
}

#[test]
fn a_start_action_asks_the_open_panel_for_its_effect() {
    let (mut m, _) = new_model();
    // Nothing to supply the payload: refused, with a notice.
    assert!(action(&mut m, "note.save").is_empty());
    assert!(matches!(m.take_notice(), Some(Notice::NoPanel(_))));

    action(&mut m, "note.open");
    let fx = action(&mut m, "note.save");
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].kind(), EffectKind::DocumentSave);
    assert!(m.in_flight().is_pending(fx[0].id));
}

// ---- R36: detach is not kill ------------------------------------------

#[test]
fn closing_a_view_never_emits_a_destroy_effect() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");

    // By the tab's close control.
    action(&mut m, "term.open");
    let term = kinds(&m, "term")[0].clone();
    let frame = m.frame().unwrap().clone();
    let close = frame
        .groups
        .iter()
        .flat_map(|g| &g.tabs)
        .find(|t| t.panel.0 == term.as_str())
        .unwrap()
        .close;
    let fx = click(&mut m, close.x, close.y);
    assert_eq!(
        fx.iter().map(Effect::kind).collect::<Vec<_>>(),
        [EffectKind::TerminalDetach]
    );
    assert!(kinds(&m, "term").is_empty());
    assert_eq!(log.borrow().teardowns, [false]);
    assert!(
        log.borrow()
            .emits
            .contains(&Err(EmitError::Forbidden(EffectKind::TerminalEnd)))
    );

    // By the dock message.
    action(&mut m, "term.open");
    let term = kinds(&m, "term")[0].clone();
    let fx = send(&mut m, Msg::Dock(DockMsg::ClosePanel(term)));
    assert_eq!(
        fx.iter().map(Effect::kind).collect::<Vec<_>>(),
        [EffectKind::TerminalDetach]
    );

    // Only a Destroy action emits the destroying effect, and it does not close
    // the view by itself.
    action(&mut m, "term.open");
    let fx = action(&mut m, "term.end");
    assert_eq!(
        fx.iter().map(Effect::kind).collect::<Vec<_>>(),
        [EffectKind::TerminalEnd]
    );
    assert_eq!(kinds(&m, "term").len(), 1);
}

// ---- R33, AC-43, AC-15: completions are judged -------------------------

#[test]
fn a_stale_completion_is_dropped_and_a_matching_one_is_applied() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let e1 = last_effect_id(&action(&mut m, "note.save")); // revision 5
    ch(&mut m, '+'); // the panel is now at revision 6
    let e2 = last_effect_id(&action(&mut m, "note.save"));

    // The late acknowledgement for revision 5 cannot replace revision 6.
    let fx = send(
        &mut m,
        Msg::Completion(completion(e1, "a.md", 5, Outcome::Accepted)),
    );
    assert!(fx.is_empty());
    assert_eq!(m.counters().dropped, 1);
    assert_eq!(m.counters().last_drop, Some(Stale::OlderRevision));
    assert!(
        !msgs_of(&log, "note")
            .iter()
            .any(|m| matches!(m, PanelMsg::Completion(_)))
    );

    // The one for the current revision applies.
    send(
        &mut m,
        Msg::Completion(completion(e2, "a.md", 6, Outcome::Accepted)),
    );
    assert_eq!(m.counters().applied, 1);
    assert!(
        msgs_of(&log, "note")
            .iter()
            .any(|m| matches!(m, PanelMsg::Completion(c) if c.effect == e2))
    );
    assert!(m.in_flight().is_empty());

    // An answer to an effect nobody asked for is dropped.
    send(
        &mut m,
        Msg::Completion(completion(EffectId(999), "a.md", 6, Outcome::Accepted)),
    );
    assert_eq!(m.counters().last_drop, Some(Stale::UnknownEffect));
}

#[test]
fn a_completion_for_a_rebound_panel_is_only_cached() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let e = last_effect_id(&action(&mut m, "note.save"));
    ch(&mut m, 'r'); // the panel now shows b.md
    send(
        &mut m,
        Msg::Completion(completion(e, "a.md", 5, Outcome::Accepted)),
    );
    assert_eq!(m.counters().cached, 1);
    assert_eq!(m.counters().applied, 0);
    let got = msgs_of(&log, "note");
    assert!(got.iter().any(|m| matches!(m, PanelMsg::Cached(_))));
    assert!(!got.iter().any(|m| matches!(m, PanelMsg::Completion(_))));
}

#[test]
fn an_uncertain_completion_reaches_the_panel_as_uncertain() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let e = last_effect_id(&action(&mut m, "note.save"));
    let uncertain = Outcome::Uncertain {
        reason: "the reply was lost".into(),
    };
    send(
        &mut m,
        Msg::Completion(completion(e, "a.md", 5, uncertain.clone())),
    );
    let delivered: Vec<_> = msgs_of(&log, "note")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Completion(c) => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].outcome, uncertain);
    assert_eq!(m.counters().applied, 1);
}

#[test]
fn a_completion_for_a_closed_view_is_dropped_and_settled() {
    let (mut m, _) = new_model();
    action(&mut m, "term.open");
    let term = kinds(&m, "term")[0].clone();
    let fx = send(&mut m, Msg::Dock(DockMsg::ClosePanel(term)));
    // The detach it left in flight settles when it is answered.
    let detach = last_effect_id(&fx);
    assert!(m.in_flight().is_pending(detach));
    let done = Completion::new(
        detach,
        ResourceRef::Terminal {
            workspace: "w".into(),
            session: "s1".into(),
        },
        Outcome::Accepted,
    );
    send(&mut m, Msg::Completion(done));
    assert!(m.in_flight().is_empty());
    assert_eq!(m.counters().dropped, 1);
}

#[test]
fn host_messages_are_judged_against_the_bound_panel() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let changed = |resource: &str, rev: u64| HostMessage::DocumentChanged {
        resource: doc(resource),
        revision: Revision::Seq(rev),
        actor: "u".into(),
        operation_id: None,
        unit: theorem_workbench_core::effect::CoordinateUnit::Utf16,
        edits: vec![],
    };
    send(&mut m, Msg::Host(changed("a.md", 4))); // older than revision 5
    assert_eq!(m.counters().dropped, 1);
    send(&mut m, Msg::Host(changed("other.md", 9))); // nobody is bound to it
    send(&mut m, Msg::Host(changed("a.md", 5)));
    let hosts: Vec<_> = msgs_of(&log, "note")
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Host(_)))
        .collect();
    assert_eq!(hosts.len(), 1);

    // A message that names no resource goes to every panel.
    action(&mut m, "note.open");
    send(
        &mut m,
        Msg::Host(HostMessage::ThemeChanged {
            revision: 1,
            dark: true,
        }),
    );
    let hosts = msgs_of(&log, "note")
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Host(HostMessage::ThemeChanged { .. })))
        .count();
    assert_eq!(hosts, 2);
}

// ---- key routing -------------------------------------------------------

#[test]
fn key_routing_precedence() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let one = kinds(&m, "note")[0].clone();
    assert_eq!(m.focus().panel, Some(one));

    // An unclaimed key reaches the focused panel.
    ch(&mut m, '+');
    assert_eq!(
        msgs_of(&log, "note")
            .iter()
            .filter(|m| matches!(m, PanelMsg::Key(_)))
            .count(),
        1
    );

    // A chord the workbench claims runs its action and never reaches the panel.
    let fx = key(&mut m, Key::Char('k'), Mods::CTRL | Mods::ALT);
    assert!(fx.is_empty());
    assert_eq!(kinds(&m, "note").len(), 2);
    assert_eq!(
        msgs_of(&log, "note")
            .iter()
            .filter(|m| matches!(m, PanelMsg::Key(_)))
            .count(),
        1
    );

    // The picker is the modal layer: it takes every key, claimed or not.
    action(&mut m, "picker.open");
    let keys_before = msgs_of(&log, "note").len();
    key(&mut m, Key::Char('k'), Mods::CTRL | Mods::ALT);
    ch(&mut m, '+');
    assert_eq!(kinds(&m, "note").len(), 2, "the chord did not run");
    assert_eq!(
        msgs_of(&log, "note").len(),
        keys_before,
        "no panel saw a key"
    );
    assert_eq!(m.picker().filter(), "+");
    assert!(m.focus().modal);

    // Escape closes it, and the keys go back to the panel.
    key(&mut m, Key::Esc, Mods::NONE);
    assert!(!m.focus().modal);
    ch(&mut m, '+');
    assert!(msgs_of(&log, "note").len() > keys_before);
}

// ---- geometry and pointer ----------------------------------------------

#[test]
fn a_tab_click_focuses_and_a_body_click_reaches_the_panel_in_body_coordinates() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "term.open");
    let note = kinds(&m, "note")[0].clone();
    assert_eq!(m.focus().panel, Some(kinds(&m, "term")[0].clone()));

    let frame = m.frame().unwrap().clone();
    let tab = frame
        .groups
        .iter()
        .flat_map(|g| &g.tabs)
        .find(|t| t.panel.0 == note.as_str())
        .unwrap()
        .rect;
    click(&mut m, tab.x + 1, tab.y);
    assert_eq!(m.focus().panel, Some(note));

    let body = m.frame().unwrap().group(m.focus().group).unwrap().body;
    click(&mut m, body.x + 3, body.y + 2);
    let seen: Vec<_> = msgs_of(&log, "note")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Pointer(p) => Some((p.x, p.y)),
            _ => None,
        })
        .collect();
    assert_eq!(seen, [(3, 2), (3, 2)]);

    // A press holds the pointer: a move outside the body still reaches it.
    send(
        &mut m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Down(Button::Left),
            x: body.x + 1,
            y: body.y + 1,
            mods: Mods::NONE,
        }),
    );
    send(
        &mut m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Move,
            x: body.x - 1,
            y: body.y + 1,
            mods: Mods::NONE,
        }),
    );
    let last = msgs_of(&log, "note")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Pointer(p) => Some((p.kind, p.x)),
            _ => None,
        })
        .next_back()
        .unwrap();
    assert_eq!(last, (PointerKind::Move, -1));
}

#[test]
fn dragging_a_splitter_resizes_through_the_dock() {
    let (mut m, _) = new_model();
    let s = m.frame().unwrap().splitters[0].clone();
    let at = (s.rect.x, s.rect.y + 1);
    let down = |x, y| {
        Msg::Pointer(Pointer {
            kind: PointerKind::Down(Button::Left),
            x,
            y,
            mods: Mods::NONE,
        })
    };
    let moved = |x, y| {
        Msg::Pointer(Pointer {
            kind: PointerKind::Move,
            x,
            y,
            mods: Mods::NONE,
        })
    };
    send(&mut m, down(at.0, at.1));
    send(&mut m, moved(at.0 + 4, at.1));
    send(&mut m, moved(at.0 + 7, at.1));
    send(
        &mut m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Up(Button::Left),
            x: at.0 + 7,
            y: at.1,
            mods: Mods::NONE,
        }),
    );
    let after = m.frame().unwrap().splitters[0].clone();
    assert_eq!(after.first_len, s.first_len + 7);
    // Released: further moves do not drag.
    send(&mut m, moved(at.0 + 20, at.1));
    assert_eq!(m.frame().unwrap().splitters[0].first_len, after.first_len);

    // A drag past the minimum goes as far as the dock allows and no further.
    send(&mut m, down(after.rect.x, after.rect.y + 1));
    send(&mut m, moved(after.rect.x + 150, after.rect.y + 1));
    let far = m.frame().unwrap().splitters[0].clone();
    assert!(far.first_len > after.first_len);
    assert!(far.first_len <= far.available - far.min_second);
}

#[test]
fn resize_re_solves_and_tells_the_panels_their_body() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let sizes = || {
        msgs_of(&log, "note")
            .into_iter()
            .filter_map(|m| match m {
                PanelMsg::Resize { area, .. } => Some(area),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let first = *sizes().last().expect("told its body when it opened");
    send(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 160, 40),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    assert_ne!(*sizes().last().unwrap(), first);
    assert_eq!(m.frame().unwrap().area, Rect::new(0, 0, 160, 40));
}

#[test]
fn redraws_coalesce_into_one_flag() {
    let (mut m, _) = new_model();
    assert!(m.take_dirty());
    assert!(!m.take_dirty());
    send(&mut m, Msg::Tick);
    assert!(!m.take_dirty(), "an idle tick owes no redraw");
    ch(&mut m, 'x');
    ch(&mut m, 'y');
    assert!(m.take_dirty());
    assert!(!m.take_dirty());
}

// ---- view and semantics -------------------------------------------------

#[test]
fn view_draws_tabs_gutters_and_panel_bodies() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    ch(&mut m, '+');
    let area = Rect::new(0, 0, 200, 50);
    let mut buf = Buffer::empty(area);
    view(&m, area, &mut buf, &Theme::plain());
    let text: String = buf
        .content()
        .iter()
        .map(|c| c.symbol().to_owned())
        .collect();
    assert!(text.contains("note taps=1"), "the panel drew its body");
    assert!(text.contains("note"), "the tab shows its title");
    assert!(text.contains('\u{2502}'), "a gutter is drawn");
    assert!(text.contains('\u{00d7}'), "a close control is drawn");

    // A buffer smaller than the area is clipped, not overrun.
    let small = Rect::new(0, 0, 30, 10);
    let mut buf = Buffer::empty(small);
    view(&m, area, &mut buf, &Theme::plain());
}

#[test]
fn the_semantic_tree_covers_tabs_panels_splitters_and_picker_rows() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "note.open");
    // Put the first note in the main group so both are showing.
    let first = kinds(&m, "note")[0].clone();
    let main = m
        .dock()
        .group_ids()
        .into_iter()
        .find(|g| {
            m.dock()
                .group(*g)
                .is_some_and(|g| g.role() == theorem_workbench_dock::Role::Main)
        })
        .unwrap();
    send(
        &mut m,
        Msg::Dock(DockMsg::MoveTab {
            panel: first,
            to: main,
            index: None,
        }),
    );

    let tree = semantics(&m);
    tree.validate().expect("one valid tree");
    let by_role = |t: &theorem_workbench_core::semantics::SemanticTree, r: Role| {
        t.nodes.iter().filter(|n| n.role == r).count()
    };
    assert_eq!(by_role(&tree, Role::Tab), 2);
    assert_eq!(by_role(&tree, Role::TabList), 3);
    assert!(by_role(&tree, Role::Separator) >= 1);
    // Both notes have a "line" node and neither collides.
    let lines = tree
        .nodes
        .iter()
        .filter(|n| n.id.as_str().ends_with("/line"))
        .count();
    assert_eq!(lines, 2);
    // The tab of the focused panel is focused and selected.
    assert!(
        tree.nodes
            .iter()
            .any(|n| n.role == Role::Tab && n.state.focused && n.state.selected)
    );

    // With the picker open its rows are in the same tree, each with its action.
    action(&mut m, "picker.open");
    let tree = semantics(&m);
    tree.validate().expect("one valid tree");
    let rows: Vec<_> = tree
        .nodes
        .iter()
        .filter(|n| n.role == Role::MenuItem)
        .collect();
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().all(|r| r.actions.len() == 1));
    assert_eq!(by_role(&tree, Role::Tab), 3, "two notes and the picker");
}

// ---- persistence, R48, AC-45, AC-61 -------------------------------------

#[test]
fn a_document_round_trip_restores_the_same_dock_and_panel_states_with_no_effects() {
    let (mut a, _) = new_model();
    action(&mut a, "note.open");
    action(&mut a, "term.open");
    action(&mut a, "note.open");
    ch(&mut a, '+');
    ch(&mut a, '+');
    ch(&mut a, 'r');
    let path = a.frame().unwrap().splitters[0].path.clone();
    send(&mut a, Msg::Dock(DockMsg::ResizeSplit { path, delta: 5 }));
    action(&mut a, "picker.open");
    key(&mut a, Key::Esc, Mods::NONE);

    // Through text, as a stored layout would be.
    let saved = serde_json::to_string(&a.document()).unwrap();

    let (mut b, _) = new_model();
    let report = b.restore(serde_json::from_str(&saved).unwrap()).unwrap();
    assert!(report.repairs.is_empty(), "{:?}", report.repairs);
    assert!(report.unavailable.is_empty());
    assert_eq!(b.dock(), a.dock());
    assert_eq!(b.document(), a.document());
    for (id, kind) in a.panel_ids() {
        assert_eq!(
            b.panel(id).unwrap().serialize(),
            a.panel(id).unwrap().serialize(),
            "{kind:?}"
        );
    }
    assert_eq!(b.focus().panel, a.focus().panel);
    assert_eq!(
        b.panel(&b.focus().panel.unwrap()).unwrap().serialize()["taps"],
        2
    );
    // Restore sent nothing and started nothing.
    assert!(b.in_flight().is_empty());
    assert!(b.frame().is_some());
}

#[test]
fn an_unknown_panel_kind_restores_as_an_unavailable_placeholder() {
    let (mut a, _) = new_model();
    action(&mut a, "note.open");
    action(&mut a, "note.open");
    let mut saved = a.document();
    let mut tabs: Vec<&mut Value> = saved["dock"]["groups"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .flat_map(|g| g["tabs"].as_array_mut().unwrap().iter_mut())
        .collect();
    assert_eq!(tabs.len(), 2);
    tabs[0]["kind"]["name"] = json!("mystery");
    tabs[0]["view_state"] = json!({"keep": [1, 2, 3]});
    // A version no build serves yet.
    tabs[1]["kind"]["version"] = json!(99);
    drop(tabs);

    let (mut b, _) = new_model();
    let report = b.restore(saved.clone()).expect("the layout loads");
    assert_eq!(report.unavailable.len(), 2);
    let ids: Vec<_> = b.panel_ids().map(|(id, _)| id.clone()).collect();
    assert!(ids.iter().all(|id| b.is_unavailable(id)));

    // It draws what it is, with the reason, instead of panicking or vanishing.
    let area = Rect::new(0, 0, 200, 50);
    let mut buf = Buffer::empty(area);
    view(&b, area, &mut buf, &Theme::plain());
    let text: String = buf
        .content()
        .iter()
        .map(|c| c.symbol().to_owned())
        .collect();
    assert!(text.contains("is unavailable"));
    semantics(&b).validate().unwrap();

    // Saved state survives a save: a later build that serves the kind gets it.
    assert_eq!(b.document(), saved);

    // It takes messages without effect.
    assert!(ch(&mut b, '+').is_empty());
    assert!(send(&mut b, Msg::Tick).is_empty());
}

#[test]
fn restore_refuses_a_document_it_cannot_read_and_keeps_the_model() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let before = m.document();
    assert!(m.restore(json!({"schema": "other", "version": 1})).is_err());
    assert!(
        m.restore(json!({"schema": "theorem.workbench", "version": 9}))
            .is_err()
    );
    assert!(
        m.restore(json!({"schema": "theorem.workbench", "version": 1, "dock": {"nope": 1}}))
            .is_err()
    );
    assert_eq!(m.document(), before);
}

#[test]
fn a_registered_kind_with_no_constructor_opens_as_the_placeholder() {
    // An action naming a kind with no constructor opens the placeholder.
    let (mut m, _) = new_model();
    let fx = action(&mut m, "changes.open");
    assert!(fx.is_empty());
    let id = kinds(&m, "changes")[0].clone();
    assert!(m.is_unavailable(&id));
}

// ---- terminal output routing, the PTY queue, resets --------------------

fn term() -> ResourceRef {
    ResourceRef::Terminal {
        workspace: "w".into(),
        session: "s1".into(),
    }
}

fn output(session: &str, epoch: u64, offset: u64, bytes: &[u8]) -> Msg {
    use base64::Engine as _;
    Msg::Host(HostMessage::TerminalOutput {
        resource: ResourceRef::Terminal {
            workspace: "w".into(),
            session: session.into(),
        },
        epoch,
        offset,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn term_msgs(log: &Shared) -> Vec<PanelMsg> {
    msgs_of(log, "term")
        .into_iter()
        .filter(|m| {
            matches!(
                m,
                PanelMsg::TerminalOutput { .. }
                    | PanelMsg::TerminalReset { .. }
                    | PanelMsg::TerminalResetRequest { .. }
                    | PanelMsg::Host(_)
            )
        })
        .collect()
}

fn term_model(epoch: u64) -> (Model, Shared) {
    let (mut m, log) = new_model();
    log.borrow_mut().term_epoch = epoch;
    action(&mut m, "term.open");
    (m, log)
}

#[test]
fn output_reaches_only_the_pane_bound_to_its_session_and_on_the_next_tick() {
    let (mut m, log) = term_model(2);
    action(&mut m, "note.open");
    send(&mut m, output("s1", 2, 0, b"hi"));
    assert!(term_msgs(&log).is_empty(), "queued, not yet handed over");
    send(&mut m, Msg::Tick);
    assert_eq!(
        term_msgs(&log),
        [PanelMsg::TerminalOutput {
            epoch: 2,
            offset: 0,
            bytes: b"hi".to_vec()
        }]
    );
    // The note is bound to a document: it never sees terminal output.
    assert!(
        msgs_of(&log, "note")
            .iter()
            .all(|m| !matches!(m, PanelMsg::TerminalOutput { .. }))
    );
    // Nobody is bound to another session: counted, not delivered.
    let before = m.counters().dropped;
    send(&mut m, output("elsewhere", 2, 0, b"x"));
    send(&mut m, Msg::Tick);
    assert_eq!(m.counters().dropped, before + 1);
    assert_eq!(m.counters().last_drop, Some(Stale::NotBound));
    assert_eq!(term_msgs(&log).len(), 1);
}

#[test]
fn a_frame_for_an_older_binding_epoch_is_dropped_and_counted() {
    let (mut m, log) = term_model(3);
    send(&mut m, output("s1", 2, 40, b"old"));
    send(&mut m, Msg::Tick);
    assert!(term_msgs(&log).is_empty());
    assert_eq!(m.counters().dropped, 1);
    assert_eq!(m.counters().last_drop, Some(Stale::OlderEpoch));
    // The pane's own epoch is delivered, and so is a newer one: the announcement
    // of the rebind is the pane's to act on.
    send(&mut m, output("s1", 3, 0, b"now"));
    send(&mut m, output("s1", 4, 0, b"next"));
    send(&mut m, Msg::Tick);
    assert_eq!(term_msgs(&log).len(), 2);
    assert_eq!(m.counters().dropped, 1);
}

#[test]
fn a_frame_that_is_not_base64_is_dropped_and_counted() {
    let (mut m, log) = term_model(1);
    send(
        &mut m,
        Msg::Host(HostMessage::TerminalOutput {
            resource: term(),
            epoch: 1,
            offset: 0,
            data: "***".into(),
        }),
    );
    send(&mut m, Msg::Tick);
    assert!(term_msgs(&log).is_empty());
    assert_eq!(m.counters().last_drop, Some(Stale::MalformedFrame));
}

#[test]
fn output_arrives_before_the_event_that_followed_it() {
    let (mut m, log) = term_model(1);
    send(&mut m, output("s1", 1, 0, b"bye"));
    send(
        &mut m,
        Msg::Host(HostMessage::TerminalExited {
            resource: term(),
            epoch: 1,
            exit_code: Some(0),
            reason: "exited".into(),
        }),
    );
    let seen = term_msgs(&log);
    assert!(matches!(seen[0], PanelMsg::TerminalOutput { .. }));
    assert!(matches!(
        seen[1],
        PanelMsg::Host(HostMessage::TerminalExited { .. })
    ));
}

#[test]
fn a_busy_stream_is_bounded_and_the_gap_reaches_the_pane_as_a_reset_request() {
    let (mut m, log) = term_model(1);
    // The queue holds 4096 frames; 4200 one-byte frames overflow it by 104.
    for i in 0..4200u64 {
        send(&mut m, output("s1", 1, i, b"x"));
    }
    assert!(
        term_msgs(&log).is_empty(),
        "nothing handed over before the tick"
    );
    send(&mut m, Msg::Tick);
    let seen = term_msgs(&log);
    assert_eq!(
        seen[0],
        PanelMsg::TerminalResetRequest {
            frames: 104,
            bytes: 104
        },
        "the gap comes first, in front of what survived"
    );
    // The survivors are the newest, contiguous with each other.
    assert_eq!(seen.len(), 1 + 4096);
    assert_eq!(
        seen[1],
        PanelMsg::TerminalOutput {
            epoch: 1,
            offset: 104,
            bytes: b"x".to_vec()
        }
    );
}

#[test]
fn a_frame_larger_than_the_queue_asks_for_a_reset_at_once() {
    let (mut m, log) = term_model(1);
    let big = vec![b'z'; 1024 * 1024 + 1];
    send(&mut m, output("s1", 1, 0, &big));
    assert_eq!(
        term_msgs(&log),
        [PanelMsg::TerminalResetRequest {
            frames: 1,
            bytes: 1024 * 1024 + 1
        }]
    );
}

#[test]
fn a_reset_carries_the_repaint_and_its_offset_and_respects_the_epoch() {
    use base64::Engine as _;
    let (mut m, log) = term_model(2);
    send(&mut m, output("s1", 2, 0, b"before"));
    let reset = |epoch: u64| {
        Msg::Host(HostMessage::TerminalReset {
            resource: term(),
            epoch,
            offset: 900,
            data: base64::engine::general_purpose::STANDARD.encode("\x1b[2Jscreen"),
        })
    };
    send(&mut m, reset(1)); // an older binding: dropped
    assert_eq!(m.counters().last_drop, Some(Stale::OlderEpoch));
    send(&mut m, reset(2));
    assert_eq!(
        term_msgs(&log),
        [
            PanelMsg::TerminalOutput {
                epoch: 2,
                offset: 0,
                bytes: b"before".to_vec()
            },
            PanelMsg::TerminalReset {
                epoch: 2,
                offset: 900,
                formatted: b"\x1b[2Jscreen".to_vec()
            }
        ],
        "queued output is handed over before the reset that supersedes it"
    );
}

// ---- document and conversation host messages ---------------------------

#[test]
fn document_acknowledgements_and_resyncs_are_judged_like_any_document_event() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open"); // bound to a.md at revision 5
    send(
        &mut m,
        Msg::Host(HostMessage::DocumentAcknowledged {
            resource: doc("a.md"),
            revision: Revision::Seq(4),
            operation_id: "op".into(),
        }),
    );
    assert_eq!(m.counters().last_drop, Some(Stale::OlderRevision));
    send(
        &mut m,
        Msg::Host(HostMessage::DocumentResync {
            resource: doc("a.md"),
            revision: Revision::Seq(6),
            text: "t".into(),
        }),
    );
    send(
        &mut m,
        Msg::Host(HostMessage::DocumentAcknowledged {
            resource: doc("a.md"),
            revision: Revision::Seq(6),
            operation_id: "op".into(),
        }),
    );
    let hosts = msgs_of(&log, "note")
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Host(_)))
        .count();
    assert_eq!(hosts, 2);
}

#[test]
fn a_stale_or_mismatched_conversation_snapshot_is_dropped() {
    let (mut m, log) = new_model();
    action(&mut m, "chat.open"); // bound to p/t1 at revision 5
    let snapshot = |thread: &str, revision: u64, id: &str| {
        Msg::Host(HostMessage::ConversationSnapshot {
            resource: ResourceRef::Conversation {
                project: "p".into(),
                thread: thread.into(),
            },
            revision: Revision::Seq(revision),
            conversation_id: id.into(),
            snapshot: "{}".into(),
        })
    };
    send(&mut m, snapshot("t1", 4, "t1")); // older than the pane's
    assert_eq!(m.counters().last_drop, Some(Stale::OlderRevision));
    send(&mut m, snapshot("t1", 9, "t2")); // says it is another conversation
    assert_eq!(m.counters().dropped, 2);
    send(&mut m, snapshot("t2", 9, "t2")); // another thread: not this pane's
    send(&mut m, snapshot("t1", 9, "t1"));
    let seen = msgs_of(&log, "chat")
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Host(_)))
        .count();
    assert_eq!(seen, 1);
}

#[test]
fn the_conversation_actions_are_start_destroy_or_create_never_focus_or_open() {
    let reg = builtin::registry();
    for (id, kind) in [
        ("theo.send", EffectKind::ConversationSend),
        ("theo.retry", EffectKind::ConversationRetry),
        ("theo.edit", EffectKind::ConversationEdit),
        ("theo.switch", EffectKind::ConversationSwitch),
        ("theo.new", EffectKind::ConversationCreate),
        ("theo.stop", EffectKind::ConversationCancel),
    ] {
        let (_, action) = reg.action(&ActionId::new(id)).expect(id);
        assert_eq!(action.emits, Some(kind), "{id}");
        assert!(
            !matches!(action.intent, ActionIntent::Focus | ActionIntent::Open),
            "{id}"
        );
        assert!(action.picker.is_none(), "{id} is not a picker row");
    }
    let intent = |id: &str| reg.action(&ActionId::new(id)).unwrap().1.intent;
    assert_eq!(intent("theo.send"), ActionIntent::Start);
    assert_eq!(intent("theo.stop"), ActionIntent::Destroy);
}

// ---- one inbound entry --------------------------------------------------

#[test]
fn dispatch_takes_a_completion_or_a_host_message_by_one_tagged_type() {
    use theorem_workbench_core::Inbound;
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let fx = m.dispatch(
        serde_json::from_value(json!({
            "channel": "host", "type": "themeChanged", "revision": 1, "dark": true
        }))
        .unwrap(),
    );
    assert!(fx.is_empty());
    assert!(
        msgs_of(&log, "note")
            .iter()
            .any(|m| matches!(m, PanelMsg::Host(HostMessage::ThemeChanged { .. })))
    );
    let before = m.counters().dropped;
    let inbound: Inbound = serde_json::from_value(json!({
        "channel": "completion", "effect": 77,
        "resource": {"type": "none"}, "outcome": {"status": "accepted"}
    }))
    .unwrap();
    m.dispatch(inbound);
    assert_eq!(m.counters().dropped, before + 1, "an effect nobody sent");
    assert_eq!(m.counters().last_drop, Some(Stale::UnknownEffect));
}

// ---- the picker takes the pointer --------------------------------------

fn picker_row_rect(m: &Model, i: usize) -> (u16, u16) {
    let tree = semantics(m);
    let rows: Vec<_> = tree
        .nodes
        .iter()
        .filter(|n| n.role == Role::MenuItem)
        .collect();
    (rows[i].rect.x, rows[i].rect.y)
}

#[test]
fn hovering_a_picker_row_selects_it_and_clicking_chooses_it_with_no_effects() {
    let (mut m, _) = new_model();
    action(&mut m, "picker.open");
    assert_eq!(m.picker().selected(), 0);
    let (x, y) = picker_row_rect(&m, 3);
    let fx = send(
        &mut m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Move,
            x,
            y,
            mods: Mods::NONE,
        }),
    );
    assert!(fx.is_empty());
    assert_eq!(m.picker().selected(), 3);
    assert!(m.picker().is_open(), "hover chooses nothing");

    // Click Changes (row 0): the picker closes and the tool opens.
    let (x, y) = picker_row_rect(&m, 0);
    let fx = click(&mut m, x, y);
    assert!(fx.is_empty());
    assert!(!m.picker().is_open());
    assert_eq!(kinds(&m, "changes").len(), 1);
    assert!(kinds(&m, "picker").is_empty());
}

#[test]
fn a_click_on_the_pickers_filter_line_or_below_its_rows_chooses_nothing() {
    let (mut m, _) = new_model();
    action(&mut m, "picker.open");
    let (x, y) = picker_row_rect(&m, 0);
    click(&mut m, x, y - 1);
    assert!(m.picker().is_open());
    click(&mut m, x, y + 20);
    assert!(m.picker().is_open());
}
