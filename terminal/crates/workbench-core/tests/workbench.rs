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
use theorem_workbench_core::draft::SourceReference;
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
    Button, Ctx, DockMsg, EmitError, Model, Msg, Notice, OpenTarget, Panel, PanelFactories,
    PanelMsg, Pointer, PointerKind, Theme, ViewCtx, semantics, update, view,
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
    /// The session the next "term" panel is bound to; empty means "s1".
    term_session: String,
    /// The workspace the next "note" panel is bound to; empty means "w".
    doc_ws: String,
    /// The document each conversation panel that got a reference was showing.
    theo_refs: Vec<String>,
    /// Whether the model builds real "theo" panels instead of the placeholder.
    with_theo: bool,
    /// What each "term" panel was sent, by the session it is bound to.
    by_session: Vec<(String, PanelMsg)>,
    /// A "note" panel asks to open a file on every environment message.
    open_on_env: bool,
    /// The workspace generation a panel read from its `Ctx` on a tick.
    ws_at_tick: Vec<(String, u64)>,
    /// The workspace a panel read from its `ViewCtx` while drawing.
    ws_in_view: Option<String>,
    /// How many capabilities a panel read from its `Ctx` on a tick.
    caps_at_tick: Vec<usize>,
    /// Whether a panel read `search.query` from its `ViewCtx` while drawing.
    search_in_view: Option<bool>,
    /// What a "note" or "chat" panel reports as its caret: a offset from
    /// the top left of its body, and how it shows.
    caret: Option<(u16, u16, theorem_workbench_core::CaretPhase)>,
    /// Whether "note" panels take text (an editor or composer).
    text_entry: bool,
    /// Whether "note" panels keep Escape for themselves without taking text.
    holds_escape: bool,
    /// The one chord "note" panels handle themselves.
    takes: Option<KeyInput>,
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
    session: String,
    ws: String,
}

impl TestPanel {
    fn new(kind: &'static str, state: &Value, log: Shared) -> Self {
        let term_epoch = log.borrow().term_epoch;
        let session = match log.borrow().term_session.as_str() {
            "" => "s1".to_owned(),
            other => other.to_owned(),
        };
        let ws = match log.borrow().doc_ws.as_str() {
            "" => "w".to_owned(),
            other => other.to_owned(),
        };
        Self {
            kind,
            log,
            ws,
            session,
            rev: state["rev"].as_u64().unwrap_or(5),
            doc: state["doc"]
                .as_str()
                .or_else(|| state["path"].as_str())
                .unwrap_or("a.md")
                .to_owned(),
            taps: state["taps"].as_u64().unwrap_or(0),
            epoch: state["epoch"].as_u64().unwrap_or(term_epoch),
        }
    }

    fn resource(&self) -> ResourceRef {
        match self.kind {
            "term" => ResourceRef::Terminal {
                workspace: "w".into(),
                session: self.session.clone(),
            },
            "chat" => ResourceRef::Conversation {
                project: "p".into(),
                thread: "t1".into(),
            },
            _ => ResourceRef::Document {
                workspace: self.ws.clone(),
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
        if self.kind == "term" {
            let entry = (self.session.clone(), msg.clone());
            self.log.borrow_mut().by_session.push(entry);
        }
        let greedy = self.log.borrow().greedy;
        if self.log.borrow().open_on_env
            && matches!(msg, PanelMsg::Resize { .. } | PanelMsg::Focus(_))
        {
            cx.open(OpenTarget::File {
                workspace: "w".into(),
                path: "env.md".into(),
            });
        }
        if matches!(msg, PanelMsg::Tick) {
            let ws = (
                cx.workspace().workspace.clone(),
                cx.workspace().generation.0,
            );
            self.log.borrow_mut().ws_at_tick.push(ws);
            let granted = cx.capabilities().granted.len();
            self.log.borrow_mut().caps_at_tick.push(granted);
        }
        if let (PanelMsg::Reference(_), "theo") = (&msg, self.kind) {
            self.log.borrow_mut().theo_refs.push(self.doc.clone());
        }
        match msg {
            // Open, then edit, a document this panel does not show.
            PanelMsg::Key(k) if matches!(k.key(), Key::Char('E') | Key::Char('F')) => {
                let body = if k.key() == Key::Char('E') {
                    EffectBody::DocumentOpen(theorem_workbench_core::effect::DocumentOpen {
                        seed_text: None,
                    })
                } else {
                    EffectBody::DocumentSave
                };
                let r = cx.emit(|id| {
                    Effect::new(id, doc("other.md"), body).with_revision(Revision::Seq(2))
                });
                self.log.borrow_mut().emits.push(r);
            }
            PanelMsg::Key(k) if k.key() == Key::Char('D') => cx.open(OpenTarget::Delegation {
                run_id: "run-1".into(),
                delegation_id: "d-1".into(),
                path: "src/a.rs".into(),
            }),
            PanelMsg::Key(k) if k.key() == Key::Char('o') => cx.open(OpenTarget::File {
                workspace: "w".into(),
                path: "c.md".into(),
            }),
            PanelMsg::Key(k) if k.key() == Key::Char('g') => cx.open(OpenTarget::FileAt {
                workspace: "w".into(),
                path: "c.md".into(),
                line: 12,
                column: 4,
            }),
            PanelMsg::Key(k) if k.key() == Key::Char('q') => self.try_emit(
                cx,
                EffectBody::SearchQuery(theorem_workbench_core::effect::SearchQuery {
                    query: "x".into(),
                    regex: false,
                    case_sensitive: false,
                    whole_word: false,
                    include: Some(vec!["*.rs".into()]),
                    exclude: None,
                    limit: 50,
                }),
            ),
            PanelMsg::Key(k) if k.key() == Key::Char('c') => {
                let r = cx.emit(|id| Effect::new(id, ResourceRef::None, EffectBody::ClipboardRead));
                self.log.borrow_mut().emits.push(r);
            }
            PanelMsg::Key(k) if k.key() == Key::Char('x') => cx.open(OpenTarget::File {
                workspace: "w".into(),
                path: "docs/pic.png".into(),
            }),
            PanelMsg::Key(k) if k.key() == Key::Char('Z') => {
                cx.refer(SourceReference {
                    path: self.doc.clone(),
                    range: None,
                    label: None,
                    excerpt: Some(format!("excerpt-{}", self.taps)),
                });
                self.taps += 1;
            }
            PanelMsg::Key(k) if k.key() == Key::Char('+') => {
                self.rev += 1;
                self.taps += 1;
            }
            PanelMsg::Key(k) if k.key() == Key::Char('r') => self.doc = "b.md".into(),
            PanelMsg::Key(k) if k.key() == Key::Char('C') => self.doc = "c.md".into(),
            PanelMsg::Key(k) if k.key() == Key::Char('R') => self.doc = "long-name-here.md".into(),
            PanelMsg::Action(id) => match id.as_str() {
                "note.save" => self.try_emit(cx, EffectBody::DocumentSave),
                "note.history" => self.try_emit(cx, EffectBody::DocumentHistoryList),
                "note.restore" => self.try_emit(
                    cx,
                    EffectBody::DocumentHistoryRestore(
                        theorem_workbench_core::effect::DocumentHistoryPoint {
                            point: "h-2".into(),
                        },
                    ),
                ),
                "term.end" => self.try_emit(cx, EffectBody::TerminalEnd),
                "chat.end" => cx.close_self(),
                "note.find" => cx.refer(SourceReference {
                    path: self.doc.clone(),
                    range: None,
                    label: Some("asked".into()),
                    excerpt: Some("found".into()),
                }),
                _ => {}
            },
            PanelMsg::Resize { .. } | PanelMsg::Focus(_) | PanelMsg::Tick if greedy => {
                self.try_emit(cx, EffectBody::DocumentSave);
            }
            _ => {}
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.log.borrow_mut().ws_in_view = Some(cx.workspace.workspace.clone());
        self.log.borrow_mut().search_in_view = Some(cx.capabilities().has(
            &theorem_workbench_core::ids::Capability::new("search.query"),
        ));
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

    fn tab_label(&self) -> Option<theorem_workbench_core::TabLabel> {
        (self.kind == "note").then(|| theorem_workbench_core::TabLabel {
            title: self.doc.clone(),
            modified: self.taps > 0,
        })
    }

    fn caret(&self, area: Rect) -> Option<theorem_workbench_core::Caret> {
        let (dx, dy, phase) = self.log.borrow().caret?;
        matches!(self.kind, "note" | "chat").then_some(theorem_workbench_core::Caret {
            x: area.x + dx,
            y: area.y + dy,
            shape: theorem_workbench_core::CaretShape::HollowBlock,
            phase,
        })
    }

    fn wants_diagnostics(&self) -> bool {
        self.kind == "diag"
    }

    fn text_entry(&self) -> bool {
        self.kind == "note" && self.log.borrow().text_entry
    }

    fn holds_escape(&self) -> bool {
        self.text_entry() || (self.kind == "note" && self.log.borrow().holds_escape)
    }

    fn takes_chord(&self, key: &KeyInput) -> bool {
        self.kind == "note" && self.log.borrow().takes.as_ref() == Some(key)
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

const ALL_CAPS: [&str; 18] = [
    "conversation.side",
    "conversation.attach",
    "conversation.model",
    "diagnostics.subscribe",
    "run.start",
    "run.subscribe",
    "search.query",
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
                ActionDescriptor::new("note.history", "Note history", ActionIntent::Start)
                    .emits(EffectKind::DocumentHistoryList),
                ActionDescriptor::new("note.restore", "Restore note", ActionIntent::Start)
                    .emits(EffectKind::DocumentHistoryRestore),
                ActionDescriptor::local("note.find", "Find in note")
                    .key("Mod+Alt+F", KeyScope::Panel),
                ActionDescriptor::local("note.wipe", "Wipe note").human_only(),
            ],
        ))
        .unwrap();
    registry
        .register(descriptor(
            "diag",
            ResourceKind::Document,
            vec![ActionDescriptor::new(
                "diag.open",
                "Findings",
                ActionIntent::Open,
            )],
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
            vec![
                ActionDescriptor::new("chat.open", "New chat", ActionIntent::Open),
                ActionDescriptor::new("chat.end", "End chat", ActionIntent::Destroy)
                    .emits(EffectKind::ConversationCancel),
            ],
        ))
        .unwrap();
    let mut factories = PanelFactories::new();
    let theo = log.borrow().with_theo;
    for kind in ["note", "term", "chat", "diag", "theo"]
        .into_iter()
        .filter(|k| *k != "theo" || theo)
    {
        let log = log.clone();
        factories.register(kind, move |state, _| {
            Box::new(TestPanel::new(kind, state, log.clone()))
        });
    }
    // Notes open Markdown files; nothing opens anything else.
    factories.register_opener("note", |target| {
        matches!(
            target,
            OpenTarget::File { path, .. } | OpenTarget::FileAt { path, .. }
                if path.ends_with(".md")
        )
    });
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
            clicks: 1,
        }),
    );
    fx.extend(send(
        m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Up(Button::Left),
            x,
            y,
            mods: Mods::NONE,
            clicks: 1,
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
        // Columns, pins and unavailable rows are browsing too.
        vec![PickerMsg::Open, PickerMsg::Right, PickerMsg::Left],
        vec![
            PickerMsg::Open,
            PickerMsg::Prev,
            PickerMsg::Choose,
            PickerMsg::TogglePin,
            PickerMsg::TogglePinAt(1),
            PickerMsg::Left,
        ],
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
        assert_eq!(m.in_flight().len(), 0);
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
        assert_eq!(m.in_flight().len(), 0);
    }

    // The same rows chosen by a pointer click.
    for row in 0..6 {
        let (mut m, _) = new_model();
        send(&mut m, Msg::Picker(PickerMsg::Open));
        send(&mut m, Msg::Picker(PickerMsg::Select(row)));
        let fx = send(&mut m, Msg::Picker(PickerMsg::ChooseAt(row)));
        assert!(fx.is_empty(), "row {row} returned {fx:?}");
        assert_eq!(m.in_flight().len(), 0);
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
        assert_eq!(m.in_flight().len(), 0);
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
        Some(Notice::Refused(Refusal::HumanOnly { .. }))
    ));
    assert_eq!(m.document(), before);
}

fn action_msgs(log: &Shared, kind: &str, id: &str) -> usize {
    msgs_of(log, kind)
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Action(a) if a.as_str() == id))
        .count()
}

fn tab_rect(m: &Model, id: &PanelInstanceId) -> (u16, u16) {
    let node = semantics(m)
        .nodes
        .iter()
        .find(|n| n.id.as_str() == format!("tab:{}", id.as_str()))
        .cloned()
        .expect("tab");
    (node.rect.x + 1, node.rect.y)
}

#[test]
fn a_resting_picker_is_shown_without_the_keyboard_and_text_reaches_the_focused_panel() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    assert!(m.rest_picker_now());
    assert!(m.picker().is_resting() && m.picker().is_open());
    assert_eq!(kinds(&m, "picker").len(), 1, "shown in the tool group");
    assert_eq!(m.focus().panel, Some(note.clone()));
    assert!(!m.focus().modal);
    let keys_before = msgs_of(&log, "note")
        .iter()
        .filter(|m| matches!(m, PanelMsg::Key(_)))
        .count();
    let fx = ch(&mut m, 'a');
    assert!(fx.is_empty());
    let keys_after = msgs_of(&log, "note")
        .iter()
        .filter(|m| matches!(m, PanelMsg::Key(_)))
        .count();
    assert_eq!(keys_after, keys_before + 1, "the key reached the panel");
    assert_eq!(m.picker().filter(), "");
    send(&mut m, Msg::Text("hi".into()));
    assert_eq!(m.picker().filter(), "");
}

#[test]
fn the_chord_a_click_or_focus_moving_to_it_takes_the_resting_picker_and_esc_gives_it_back() {
    // The chord.
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    m.rest_picker_now();
    key(&mut m, Key::Char('t'), Mods::CTRL | Mods::ALT);
    assert!(m.focus().modal && !m.picker().is_resting());
    ch(&mut m, 'z');
    assert_eq!(m.picker().filter(), "z");
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.picker().filter(), "", "Esc goes back a step");
    key(&mut m, Key::Esc, Mods::NONE);
    assert!(!m.picker().is_open());
    assert!(kinds(&m, "picker").is_empty());
    assert_eq!(m.focus().panel, Some(note.clone()), "focus is where it was");

    // A click on the picker's tab.
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    m.rest_picker_now();
    let picker = kinds(&m, "picker")[0].clone();
    let (x, y) = tab_rect(&m, &picker);
    click(&mut m, x, y);
    assert!(m.focus().modal, "a click takes it");
    assert_eq!(m.focus().panel, Some(picker));
    ch(&mut m, 'q');
    assert_eq!(m.picker().filter(), "q");
    key(&mut m, Key::Esc, Mods::NONE);
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.focus().panel, Some(note), "Esc restores focus");

    // Focus moving to it.
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    m.rest_picker_now();
    let picker = kinds(&m, "picker")[0].clone();
    send(&mut m, Msg::Dock(DockMsg::FocusPanel(picker)));
    assert!(m.focus().modal);
}

#[test]
fn opening_a_resting_picker_has_no_domain_effects() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    assert!(m.rest_picker_now());
    assert_eq!(m.in_flight().len(), 0);
}

#[test]
fn a_tool_group_nobody_asked_for_is_not_shown_and_comes_back_with_its_first_tool() {
    let (mut m, _) = new_model();
    let roles = |m: &Model| {
        m.frame()
            .unwrap()
            .groups
            .iter()
            .map(|g| g.role)
            .collect::<Vec<_>>()
    };
    assert!(!roles(&m).contains(&theorem_workbench_dock::Role::Tools));
    action(&mut m, "note.open");
    assert!(roles(&m).contains(&theorem_workbench_dock::Role::Tools));
}

#[test]
fn a_local_action_reaches_the_focused_panel_of_its_kind_and_emits_nothing() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "term.open"); // focus moves to the terminal
    let fx = action(&mut m, "note.find");
    assert!(fx.is_empty());
    assert_eq!(action_msgs(&log, "note", "note.find"), 0);
    assert!(matches!(m.take_notice(), Some(Notice::Refused(_))));
    // Focus the note again, then it arrives.
    let note = kinds(&m, "note")[0].clone();
    let fx = send(
        &mut m,
        Msg::ActionOn {
            id: ActionId::new("note.find"),
            actor: Actor::Agent { run_id: "r".into() },
            panel: note,
        },
    );
    assert!(fx.is_empty());
    assert_eq!(action_msgs(&log, "note", "note.find"), 1, "the named panel");
    let mut m2 = new_model();
    action(&mut m2.0, "note.open");
    assert!(action(&mut m2.0, "note.find").is_empty());
    assert_eq!(
        action_msgs(&m2.1, "note", "note.find"),
        1,
        "the focused one"
    );
    assert!(m2.0.take_notice().is_none());
}

#[test]
fn a_local_action_with_no_panel_of_its_kind_is_refused_with_a_reason() {
    let (mut m, log) = new_model();
    assert!(action(&mut m, "note.find").is_empty());
    let Some(Notice::Refused(Refusal::Unavailable { reason })) = m.take_notice() else {
        panic!("not refused with a reason");
    };
    assert!(
        reason.contains("note") || reason.contains("Note"),
        "{reason}"
    );
    assert_eq!(action_msgs(&log, "note", "note.find"), 0);
    // A panel of another kind is not a stand-in, and neither is a named
    // panel of the wrong kind.
    action(&mut m, "term.open");
    assert!(action(&mut m, "note.find").is_empty());
    assert!(matches!(m.take_notice(), Some(Notice::Refused(_))));
    let term = kinds(&m, "term")[0].clone();
    send(
        &mut m,
        Msg::ActionOn {
            id: ActionId::new("note.find"),
            actor: Actor::Human,
            panel: term,
        },
    );
    assert!(matches!(m.take_notice(), Some(Notice::Refused(_))));
}

#[test]
fn a_human_only_local_action_is_refused_for_an_agent_and_kept_for_a_person() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    send(
        &mut m,
        Msg::ActionOn {
            id: ActionId::new("note.wipe"),
            actor: Actor::Agent { run_id: "r".into() },
            panel: note,
        },
    );
    assert!(matches!(
        m.take_notice(),
        Some(Notice::Refused(Refusal::HumanOnly { .. }))
    ));
    assert_eq!(action_msgs(&log, "note", "note.wipe"), 0);
    action(&mut m, "note.wipe");
    assert_eq!(action_msgs(&log, "note", "note.wipe"), 1);
}

#[test]
fn a_local_action_holds_its_capabilities_and_may_have_no_key() {
    use theorem_workbench_core::registry::{Registry, RegistryError};
    let mut registry = Registry::new();
    let bad = descriptor(
        "x",
        ResourceKind::Document,
        vec![ActionDescriptor::local("x.a", "A").emits(EffectKind::DocumentSave)],
    );
    assert_eq!(
        registry.register(bad),
        Err(RegistryError::EffectOnPassiveAction(ActionId::new("x.a")))
    );
    let ok = descriptor(
        "x",
        ResourceKind::Document,
        vec![ActionDescriptor::local("x.a", "A").requires("documents")],
    );
    registry.register(ok).unwrap();
    let none = Capabilities::of([]);
    assert!(
        registry
            .resolve(&ActionId::new("x.a"), &Actor::Human, &none)
            .is_err()
    );
    let (a, _) = (registry.action(&ActionId::new("x.a")).unwrap(), 0);
    assert!(a.1.default_key.is_none());
}

#[test]
fn an_action_may_name_several_effects() {
    let a = ActionDescriptor::new("c.confirm", "Confirm", ActionIntent::Start)
        .emits(EffectKind::ScmDiscard)
        .emits(EffectKind::ScmResolve)
        .emits(EffectKind::ScmRestore)
        .emits(EffectKind::ScmDiscard);
    assert_eq!(
        a.emits,
        [
            EffectKind::ScmDiscard,
            EffectKind::ScmResolve,
            EffectKind::ScmRestore
        ]
    );
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
    assert_eq!(m.in_flight().len(), 0);

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
    assert_eq!(m.in_flight().len(), 0);
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
            clicks: 1,
        }),
    );
    send(
        &mut m,
        Msg::Pointer(Pointer {
            kind: PointerKind::Move,
            x: body.x - 1,
            y: body.y + 1,
            mods: Mods::NONE,
            clicks: 1,
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
            clicks: 1,
        })
    };
    let moved = |x, y| {
        Msg::Pointer(Pointer {
            kind: PointerKind::Move,
            x,
            y,
            mods: Mods::NONE,
            clicks: 1,
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
            clicks: 1,
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
        ("theo.branch", EffectKind::ConversationSwitchBranch),
        ("theo.new", EffectKind::ConversationCreate),
        ("theo.stop", EffectKind::ConversationCancel),
    ] {
        let (_, action) = reg.action(&ActionId::new(id)).expect(id);
        assert_eq!(action.emits, [kind], "{id}");
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
            clicks: 1,
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

// ---- a panel asks the root to open something ----------------------------

fn role_of(m: &Model, id: &PanelInstanceId) -> theorem_workbench_dock::Role {
    let group = m
        .dock()
        .find_panel(&theorem_workbench_dock::PanelId(id.as_str().to_owned()))
        .expect("the panel is in a tab");
    m.dock().group(group).unwrap().role()
}

#[test]
fn a_panel_opens_what_a_registered_opener_serves_where_its_kind_places_it_and_focuses_it() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let first = kinds(&m, "note")[0].clone();
    assert_eq!(m.focus().panel, Some(first.clone()));

    let fx = ch(&mut m, 'o');
    assert!(fx.is_empty(), "opening emits nothing");
    let notes = kinds(&m, "note");
    assert_eq!(notes.len(), 2);
    let opened = notes.iter().find(|id| **id != first).unwrap().clone();
    assert_eq!(m.focus().panel, Some(opened.clone()));
    assert_eq!(role_of(&m, &opened), theorem_workbench_dock::Role::Tools);
    assert!(!m.is_unavailable(&opened));
    // Built from the target, bound to its document, and nothing was emitted.
    assert_eq!(
        m.panel(&opened).unwrap().binding().unwrap().resource,
        ResourceRef::Document {
            workspace: "w".into(),
            resource_id: "c.md".into()
        }
    );
    assert!(log.borrow().emits.is_empty());

    // The same target again focuses the panel bound to it instead of opening a
    // second one.
    send(&mut m, Msg::Dock(DockMsg::FocusPanel(first.clone())));
    assert_eq!(m.focus().panel, Some(first));
    ch(&mut m, 'o');
    assert_eq!(kinds(&m, "note").len(), 2);
    assert_eq!(m.focus().panel, Some(opened));
}

#[test]
fn opening_a_file_at_a_place_tells_the_new_panel_and_the_one_already_open_where() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let reveals = |log: &Shared| {
        msgs_of(log, "note")
            .into_iter()
            .filter_map(|m| match m {
                PanelMsg::Reveal { line, column } => Some((line, column)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert!(reveals(&log).is_empty());

    // A panel is created for the file: it is told the place.
    let fx = ch(&mut m, 'g');
    assert!(fx.is_empty(), "revealing emits nothing");
    assert_eq!(kinds(&m, "note").len(), 2);
    assert_eq!(reveals(&log), vec![(12, 4)]);

    // The panel already showing the file is focused and told again.
    ch(&mut m, 'g');
    assert_eq!(kinds(&m, "note").len(), 2, "no second panel");
    assert_eq!(reveals(&log), vec![(12, 4), (12, 4)]);
    assert!(log.borrow().emits.is_empty());
}

#[test]
fn a_panel_built_after_a_capability_change_reads_the_current_set_and_so_does_its_view() {
    let (mut m, log) = new_model();
    send(
        &mut m,
        Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(["files", "scm"]),
        }),
    );
    action(&mut m, "note.open");
    send(&mut m, Msg::Tick);
    assert_eq!(log.borrow().caps_at_tick.last(), Some(&2));
    let theme = Theme::plain();
    let mut buf = Buffer::empty(Rect::new(0, 0, 200, 50));
    view(&m, Rect::new(0, 0, 200, 50), &mut buf, &theme);
    assert_eq!(log.borrow().search_in_view, Some(false));

    // A later change is read on the next call, not replayed.
    send(
        &mut m,
        Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: Capabilities::of(["files", "scm", "search.query"]),
        }),
    );
    send(&mut m, Msg::Tick);
    assert_eq!(log.borrow().caps_at_tick.last(), Some(&3));
    view(&m, Rect::new(0, 0, 200, 50), &mut buf, &theme);
    assert_eq!(log.borrow().search_in_view, Some(true));
}

#[test]
fn search_pages_reach_only_the_panel_that_started_the_search_until_the_last_one() {
    use theorem_workbench_core::completion::{CompletionPayload, SearchStarted};
    use theorem_workbench_core::results::{ReadAt, SearchRow, SearchState};
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "note.open");
    let asker = kinds(&m, "note")[0].clone();
    send(&mut m, Msg::Dock(DockMsg::FocusPanel(asker)));
    let fx = ch(&mut m, 'q');
    let effect = last_effect_id(&fx);
    send(
        &mut m,
        Msg::Completion(
            completion(effect, "a.md", 5, Outcome::Accepted).with_payload(
                CompletionPayload::SearchStarted(SearchStarted { id: "s1".into() }),
            ),
        ),
    );
    let page = |id: &str, state: SearchState| HostMessage::SearchPage {
        id: id.into(),
        rows: vec![SearchRow {
            path: "a.rs".into(),
            line: 3,
            text: "x".into(),
            matches: vec![],
            text_offset: None,
        }],
        skipped: 0,
        state,
        end: None,
        encoding: theorem_workbench_core::results::SpanEncoding::Utf16CodeUnits,
        read_at: ReadAt {
            workspace_id: "w".into(),
            version: None,
            epoch: None,
            generation: 1,
        },
    };
    let pages = |log: &Shared| {
        msgs_of(log, "note")
            .into_iter()
            .filter(|m| matches!(m, PanelMsg::Host(HostMessage::SearchPage { .. })))
            .count()
    };
    send(&mut m, Msg::Host(page("s1", SearchState::More)));
    assert_eq!(pages(&log), 1, "one panel, not both");
    send(&mut m, Msg::Host(page("s1", SearchState::Complete)));
    assert_eq!(pages(&log), 2);

    // After the last page, and for a search nobody here started, it is dropped.
    let dropped = m.counters().dropped;
    send(&mut m, Msg::Host(page("s1", SearchState::More)));
    send(&mut m, Msg::Host(page("other", SearchState::More)));
    assert_eq!(pages(&log), 2);
    assert_eq!(m.counters().dropped, dropped + 2);
}

fn snapshot(thread: &str, rev: u64) -> Msg {
    Msg::Host(HostMessage::ConversationSnapshot {
        resource: ResourceRef::Conversation {
            project: "p".into(),
            thread: thread.into(),
        },
        revision: Revision::Seq(rev + 10), // the panel accepts 5
        conversation_id: thread.into(),
        snapshot: "{}".into(),
    })
}

fn snapshots_seen(log: &Shared) -> usize {
    msgs_of(log, "chat")
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Host(HostMessage::ConversationSnapshot { .. })))
        .count()
}

#[test]
fn a_chat_mounted_after_its_snapshot_is_handed_the_latest_one_without_emitting() {
    let (mut m, log) = new_model();
    send(&mut m, snapshot("t1", 1));
    send(&mut m, snapshot("t1", 2));
    // One whose conversation id is not its thread is dropped, not retained.
    send(
        &mut m,
        Msg::Host(HostMessage::ConversationSnapshot {
            resource: ResourceRef::Conversation {
                project: "p".into(),
                thread: "t1".into(),
            },
            revision: Revision::Seq(9),
            conversation_id: "other".into(),
            snapshot: "{}".into(),
        }),
    );
    assert_eq!(snapshots_seen(&log), 0, "nobody is bound yet");
    let fx = action(&mut m, "chat.open");
    assert!(fx.is_empty() && log.borrow().emits.is_empty());
    let seen: Vec<_> = msgs_of(&log, "chat")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Host(HostMessage::ConversationSnapshot { revision, .. }) => Some(revision),
            _ => None,
        })
        .collect();
    assert_eq!(seen, vec![Revision::Seq(12)], "the latest, once");
    // A second tick does not replay it again.
    send(&mut m, Msg::Tick);
    assert_eq!(snapshots_seen(&log), 1);
}

#[test]
fn only_the_newest_conversations_are_kept_and_an_older_snapshot_never_replaces_a_newer() {
    let (mut m, log) = new_model();
    send(&mut m, snapshot("t1", 5));
    send(&mut m, snapshot("t1", 3)); // late and older: ignored
    for n in 0..40 {
        send(&mut m, snapshot(&format!("x{n}"), 1));
    }
    // t1 was the oldest of 41 and is forgotten.
    action(&mut m, "chat.open");
    assert_eq!(snapshots_seen(&log), 0);

    let (mut m, log) = new_model();
    send(&mut m, snapshot("t1", 5));
    send(&mut m, snapshot("t1", 3));
    action(&mut m, "chat.open");
    let revision = msgs_of(&log, "chat").into_iter().find_map(|m| match m {
        PanelMsg::Host(HostMessage::ConversationSnapshot { revision, .. }) => Some(revision),
        _ => None,
    });
    assert_eq!(revision, Some(Revision::Seq(15)));
}

#[test]
fn a_conversation_that_was_ended_is_forgotten() {
    let (mut m, log) = new_model();
    send(&mut m, snapshot("t1", 1));
    action(&mut m, "chat.open");
    assert_eq!(snapshots_seen(&log), 1);
    action(&mut m, "chat.end");
    assert!(kinds(&m, "chat").is_empty());
    action(&mut m, "chat.open");
    assert_eq!(snapshots_seen(&log), 1, "nothing left to replay");
}

#[test]
fn a_closed_but_not_ended_conversation_is_still_replayed_to_the_next_panel() {
    let (mut m, log) = new_model();
    send(&mut m, snapshot("t1", 1));
    action(&mut m, "chat.open");
    let chat = kinds(&m, "chat")[0].clone();
    send(&mut m, Msg::Dock(DockMsg::ClosePanel(chat)));
    action(&mut m, "chat.open");
    assert_eq!(snapshots_seen(&log), 2);
}

#[test]
fn a_terminal_panel_mounted_later_is_told_the_latest_sessions_of_its_workspace() {
    let (mut m, log) = new_model();
    send(&mut m, workspace("w", None));
    let sessions = |name: &str| {
        Msg::Host(HostMessage::TerminalSessions {
            workspace: "w".into(),
            profiles: vec![],
            sessions: vec![theorem_workbench_core::host::TerminalSessionInfo {
                session: name.into(),
                profile: "Shell".into(),
                backend: theorem_workbench_core::effect::TerminalBackend::Native,
                workspace: "w".into(),
                host: None,
                program: None,
                state: Default::default(),
                controlled_elsewhere: false,
                modes: None,
                program_report: Default::default(),
            }],
            adoption: None,
        })
    };
    send(&mut m, sessions("first"));
    send(&mut m, sessions("second"));
    action(&mut m, "term.open");
    let told: Vec<String> = msgs_of(&log, "term")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Host(HostMessage::TerminalSessions { sessions, .. }) => {
                Some(sessions[0].session.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(told, vec!["second".to_owned()]);
    // A panel of another binding is not told.
    action(&mut m, "note.open");
    assert!(
        msgs_of(&log, "note")
            .iter()
            .all(|m| !matches!(m, PanelMsg::Host(HostMessage::TerminalSessions { .. })))
    );
}

#[test]
fn composition_steps_reach_the_panel_that_owns_the_keyboard_in_order() {
    use theorem_workbench_core::Composition;
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    for step in [
        Composition::Start,
        Composition::Update { text: "ni".into() },
        Composition::End {
            text: "\u{4f60}".into(),
        },
    ] {
        send(&mut m, Msg::Composition(step));
    }
    let got: Vec<_> = msgs_of(&log, "note")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Composition(c) => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(
        got,
        vec![
            Composition::Start,
            Composition::Update { text: "ni".into() },
            Composition::End {
                text: "\u{4f60}".into()
            },
        ]
    );
    // While the picker is open the committed text is its filter.
    send(&mut m, Msg::Picker(PickerMsg::Open));
    send(&mut m, Msg::Composition(Composition::Start));
    send(
        &mut m,
        Msg::Composition(Composition::End { text: "fi".into() }),
    );
    assert_eq!(m.picker().filter(), "fi");
}

#[test]
fn a_tab_shows_what_its_panel_names_itself_and_marks_unsaved_changes() {
    let (mut m, _log) = new_model();
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    let theme = Theme::plain();
    let area = Rect::new(0, 0, 200, 50);
    let drawn = |m: &Model| {
        let mut buf = Buffer::empty(area);
        view(m, area, &mut buf, &theme);
        (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buf[(x, y)].symbol().to_owned())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let tab_node = |m: &Model| {
        let tree = semantics(m);
        tree.nodes
            .iter()
            .find(|n| n.id.as_str() == format!("tab:{}", note.as_str()))
            .cloned()
            .expect("the tab is in the tree")
    };
    let before = tab_node(&m);
    assert_eq!(before.name, "a.md");
    assert!(!before.state.modified);
    assert!(!drawn(&m).contains('\u{25cf}'));

    ch(&mut m, '+');
    let after = tab_node(&m);
    assert!(after.state.modified);
    assert!(drawn(&m).contains('\u{25cf}'));
    // A panel that names nothing keeps the registry's title.
    action(&mut m, "term.open");
    let term = kinds(&m, "term")[0].clone();
    let tree = semantics(&m);
    let node = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == format!("tab:{}", term.as_str()))
        .unwrap();
    assert_eq!(node.name, "term");
}

#[test]
fn a_tab_whose_label_grows_is_measured_whole_and_the_dock_follows() {
    let (mut m, _log) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "term.open");
    let note = kinds(&m, "note")[0].clone();
    let term = kinds(&m, "term")[0].clone();
    let rect = |m: &Model, id: &PanelInstanceId| {
        semantics(m)
            .nodes
            .iter()
            .find(|n| n.id.as_str() == format!("tab:{}", id.as_str()))
            .map(|n| n.rect)
            .expect("tab")
    };
    let (n0, t0) = (rect(&m, &note), rect(&m, &term));
    assert_eq!(n0.x + n0.width, t0.x);
    // Focus the note and grow its label.
    click(&mut m, n0.x + 1, n0.y);
    ch(&mut m, 'R');
    let (n1, t1) = (rect(&m, &note), rect(&m, &term));
    assert_eq!(n1.width, "long-name-here.md".len() as u16 + 4);
    assert!(n1.width > n0.width);
    assert_eq!(t1.x, n1.x + n1.width, "the neighbour moved with it");
}

#[test]
fn an_answer_for_no_resource_reaches_the_panel_that_asked_on_the_same_turn_whatever_it_says() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let completions = |log: &Shared| {
        msgs_of(log, "note")
            .into_iter()
            .filter(|m| matches!(m, PanelMsg::Completion(_)))
            .count()
    };
    let cached = |log: &Shared| {
        msgs_of(log, "note")
            .into_iter()
            .filter(|m| matches!(m, PanelMsg::Cached(_)))
            .count()
    };
    for outcome in [
        Outcome::Accepted,
        Outcome::Refused {
            code: "denied".into(),
            reason: "the browser said no".into(),
        },
        Outcome::Failed {
            reason: "no clipboard".into(),
        },
    ] {
        let fx = ch(&mut m, 'c');
        assert!(!fx.is_empty());
        let before = completions(&log);
        send(
            &mut m,
            Msg::Completion(Completion::new(
                last_effect_id(&fx),
                ResourceRef::None,
                outcome,
            )),
        );
        assert_eq!(completions(&log), before + 1);
    }
    assert_eq!(cached(&log), 0);
}

#[test]
fn a_save_for_an_older_revision_is_still_delivered_but_other_older_answers_are_not() {
    use theorem_workbench_core::completion::{CompletionPayload, DocumentSaved};
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let saved = action(&mut m, "note.save");
    let save = last_effect_id(&saved);
    ch(&mut m, '+'); // the text moved on to revision 6
    send(
        &mut m,
        Msg::Completion(completion(save, "a.md", 5, Outcome::Accepted).with_payload(
            CompletionPayload::DocumentSaved(DocumentSaved {
                revision: Revision::Seq(5),
            }),
        )),
    );
    let delivered = |log: &Shared| {
        msgs_of(log, "note")
            .into_iter()
            .filter(|m| matches!(m, PanelMsg::Completion(_)))
            .count()
    };
    assert_eq!(delivered(&log), 1);
    assert_eq!(m.counters().dropped, 0);

    // The same answer without the saved payload is an older answer: dropped.
    let again = action(&mut m, "note.save");
    ch(&mut m, '+');
    send(
        &mut m,
        Msg::Completion(completion(
            last_effect_id(&again),
            "a.md",
            5,
            Outcome::Accepted,
        )),
    );
    assert_eq!(delivered(&log), 1);
    assert_eq!(m.counters().dropped, 1);
}

#[test]
fn syntax_colour_for_an_older_revision_is_dropped_and_for_the_bound_document_delivered() {
    use theorem_workbench_core::host::TokenSpan;
    use theorem_workbench_core::results::SpanEncoding;
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let tokens = |resource: &str, rev: u64| {
        Msg::Host(HostMessage::DocumentTokens {
            resource: doc(resource),
            revision: Revision::Seq(rev),
            encoding: SpanEncoding::Utf8Bytes,
            spans: vec![TokenSpan {
                start: 0,
                end: 3,
                class: "keyword".into(),
            }],
        })
    };
    let seen = |log: &Shared| {
        msgs_of(log, "note")
            .into_iter()
            .filter(|m| matches!(m, PanelMsg::Host(HostMessage::DocumentTokens { .. })))
            .count()
    };
    send(&mut m, tokens("a.md", 4)); // the panel is at 5
    assert_eq!((seen(&log), m.counters().dropped), (0, 1));
    send(&mut m, tokens("other.md", 9)); // nobody is bound to it
    assert_eq!(seen(&log), 0);
    send(&mut m, tokens("a.md", 5));
    assert_eq!(seen(&log), 1);
}

#[test]
fn a_target_nothing_serves_opens_the_placeholder_with_a_reason_once() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let fx = ch(&mut m, 'x');
    assert!(fx.is_empty());
    let docs = kinds(&m, "document");
    assert_eq!(
        docs.len(),
        1,
        "the placeholder is named for what it stands in for"
    );
    assert!(m.is_unavailable(&docs[0]));
    assert_eq!(m.focus().panel, Some(docs[0].clone()));
    let tree = semantics(&m);
    tree.validate().unwrap();
    let node = tree
        .nodes
        .iter()
        .find(|n| n.name.ends_with("is unavailable") && n.name.starts_with("document"))
        .expect("the placeholder is on the tree");
    assert_eq!(
        node.state.description.as_deref(),
        Some("This build has no panel that can open the file \"docs/pic.png\".")
    );
    // Asking again does not stack a second one.
    let note = kinds(&m, "note")[0].clone();
    send(&mut m, Msg::Dock(DockMsg::FocusPanel(note)));
    ch(&mut m, 'x');
    assert_eq!(kinds(&m, "document").len(), 1);
    assert!(log.borrow().emits.is_empty());
    // The target survives a save, for a build that serves it.
    let saved = m.document().to_string();
    assert!(saved.contains("docs/pic.png"));
}

#[test]
fn an_environment_message_cannot_open_anything() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    log.borrow_mut().open_on_env = true;
    let before = m.panel_ids().count();
    send(&mut m, Msg::Focus(false));
    send(&mut m, Msg::Focus(true));
    send(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 180, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    assert_eq!(
        m.panel_ids().count(),
        before,
        "silent messages open nothing"
    );
}

// ---- workspace identity ----------------------------------------------------

fn workspace(name: &str, environment: Option<&str>) -> Msg {
    Msg::Host(HostMessage::WorkspaceChanged {
        workspace: name.into(),
        environment: environment.map(Into::into),
    })
}

fn workspace_msgs(log: &Shared) -> Vec<theorem_workbench_core::WorkspaceIdentity> {
    log.borrow()
        .msgs
        .iter()
        .filter_map(|(_, m)| match m {
            PanelMsg::Workspace(w) => Some(w.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn the_workspace_is_held_by_the_root_and_told_to_panels_with_a_new_generation() {
    let (mut m, log) = new_model();
    assert!(!m.workspace().is_set());
    action(&mut m, "note.open");
    assert!(
        workspace_msgs(&log).is_empty(),
        "nothing to tell before the host says"
    );

    let fx = send(&mut m, workspace("w1", Some("env-a")));
    assert!(fx.is_empty());
    assert_eq!(m.workspace().workspace, "w1");
    assert_eq!(m.workspace().environment.as_deref(), Some("env-a"));
    assert_eq!(m.workspace().generation, Generation(1));
    let told = workspace_msgs(&log);
    assert_eq!(told.len(), 1);
    assert_eq!(told[0].generation, Generation(1));

    // Saying the same again changes nothing and tells nobody.
    send(&mut m, workspace("w1", Some("env-a")));
    assert_eq!(m.workspace().generation, Generation(1));
    assert_eq!(workspace_msgs(&log).len(), 1);

    // Another workspace, or another environment, is a new generation.
    send(&mut m, workspace("w2", Some("env-a")));
    send(&mut m, workspace("w2", None));
    assert_eq!(m.workspace().generation, Generation(3));
    assert_eq!(workspace_msgs(&log).len(), 3);

    // A panel opened afterwards is told the current one, not the history.
    action(&mut m, "term.open");
    let all = workspace_msgs(&log);
    assert_eq!(all.len(), 4);
    assert_eq!(all[3].workspace, "w2");
    assert_eq!(all[3].generation, Generation(3));

    // Panels read it on their Ctx and ViewCtx.
    send(&mut m, Msg::Tick);
    assert!(
        log.borrow()
            .ws_at_tick
            .iter()
            .all(|(w, g)| w == "w2" && *g == 3)
    );
    let mut buf = Buffer::empty(Rect::new(0, 0, 200, 50));
    view(&m, Rect::new(0, 0, 200, 50), &mut buf, &Theme::plain());
    assert_eq!(log.borrow().ws_in_view.as_deref(), Some("w2"));
}

#[test]
fn a_workspace_change_cannot_start_work_by_itself() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    log.borrow_mut().greedy = true;
    // The greedy panel tries to emit on Resize/Focus/Tick; the workspace
    // message is environment too, so its answer to it is refused.
    let fx = send(&mut m, workspace("w1", None));
    assert!(fx.is_empty());
}

// ---- pointer click counts --------------------------------------------------

#[test]
fn a_pointer_carries_its_click_count_to_the_panel() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let body = m
        .frame()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.active.is_some())
        .unwrap()
        .body;
    for clicks in [1u8, 2] {
        send(
            &mut m,
            Msg::Pointer(Pointer {
                kind: PointerKind::Down(Button::Left),
                x: body.x + 1,
                y: body.y + 1,
                mods: Mods::NONE,
                clicks,
            }),
        );
        send(
            &mut m,
            Msg::Pointer(Pointer {
                kind: PointerKind::Up(Button::Left),
                x: body.x + 1,
                y: body.y + 1,
                mods: Mods::NONE,
                clicks: 1,
            }),
        );
    }
    let downs: Vec<u8> = msgs_of(&log, "note")
        .iter()
        .filter_map(|m| match m {
            PanelMsg::Pointer(p) if matches!(p.kind, PointerKind::Down(_)) => Some(p.clicks),
            _ => None,
        })
        .collect();
    assert_eq!(downs, [1, 2]);
}

// ---- per-session PTY queues ------------------------------------------------

#[test]
fn a_flooding_session_resets_only_its_own_pane() {
    let (mut m, log) = new_model();
    log.borrow_mut().term_epoch = 1;
    action(&mut m, "term.open");
    log.borrow_mut().term_session = "s2".into();
    action(&mut m, "term.open");
    // The quiet session sends one frame, then the other floods past its bound.
    send(&mut m, output("s2", 1, 0, b"quiet"));
    for i in 0..4200u64 {
        send(&mut m, output("s1", 1, i, b"x"));
    }
    send(&mut m, Msg::Tick);
    let of = |session: &str| -> Vec<PanelMsg> {
        log.borrow()
            .by_session
            .iter()
            .filter(|(s, _)| s == session)
            .map(|(_, m)| m.clone())
            .filter(|m| {
                matches!(
                    m,
                    PanelMsg::TerminalOutput { .. } | PanelMsg::TerminalResetRequest { .. }
                )
            })
            .collect()
    };
    assert_eq!(
        of("s2"),
        [PanelMsg::TerminalOutput {
            epoch: 1,
            offset: 0,
            bytes: b"quiet".to_vec()
        }],
        "the quiet pane saw its frame and no reset"
    );
    let flooded = of("s1");
    assert_eq!(
        flooded[0],
        PanelMsg::TerminalResetRequest {
            frames: 104,
            bytes: 104
        }
    );
    assert_eq!(flooded.len(), 1 + 4096);
}

#[test]
fn a_session_too_big_for_the_queue_resets_only_its_own_pane() {
    let (mut m, log) = new_model();
    log.borrow_mut().term_epoch = 1;
    action(&mut m, "term.open");
    log.borrow_mut().term_session = "s2".into();
    action(&mut m, "term.open");
    send(&mut m, output("s1", 1, 0, &vec![b'z'; 1024 * 1024 + 1]));
    let resets = |session: &str| {
        log.borrow()
            .by_session
            .iter()
            .filter(|(s, m)| s == session && matches!(m, PanelMsg::TerminalResetRequest { .. }))
            .count()
    };
    assert_eq!((resets("s1"), resets("s2")), (1, 0));
}

// ---- the root's view: tab overflow and presentation --------------------------

fn draw(m: &Model, w: u16, h: u16) -> Buffer {
    let area = Rect::new(0, 0, w, h);
    let mut buf = Buffer::empty(area);
    view(m, area, &mut buf, &Theme::plain());
    buf
}

fn row(buf: &Buffer, y: u16, x0: u16, x1: u16) -> String {
    (x0..x1)
        .map(|x| buf.cell((x, y)).map_or(" ", |c| c.symbol()))
        .collect()
}

fn tools_group(m: &Model) -> theorem_workbench_dock::GroupFrame {
    m.frame()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.role == theorem_workbench_dock::Role::Tools)
        .cloned()
        .expect("a tools group is shown")
}

#[test]
fn tab_overflow_is_drawn_on_both_sides_of_the_strip() {
    let (mut m, _) = new_model();
    for _ in 0..24 {
        action(&mut m, "note.open");
    }
    let g = tools_group(&m);
    assert!(g.tabs_before > 0, "the active tab is the newest");
    let strip = g.tab_strip;
    let buf = draw(&m, 200, 50);
    let line = row(&buf, strip.y, strip.x, strip.right());
    assert!(line.starts_with('\u{2039}'), "{line:?}");
    assert!(!line.contains('\u{203a}'), "nothing is after the last tab");

    // Slide to the first tab: tabs are now after it.
    let first = kinds(&m, "note")[0].clone();
    send(&mut m, Msg::Dock(DockMsg::FocusPanel(first)));
    let g = tools_group(&m);
    assert_eq!(g.tabs_before, 0);
    assert!(g.tabs_after > 0);
    let buf = draw(&m, 200, 50);
    let line = row(&buf, g.tab_strip.y, g.tab_strip.x, g.tab_strip.right());
    assert!(!line.starts_with('\u{2039}'));
    // The strip is packed, so only the glyph fits.
    assert!(line.trim_end().ends_with('\u{203a}'), "{line:?}");
    // With room to spare, it also counts what is out of sight.
    let mut counted = false;
    for width in 150..230u16 {
        send(
            &mut m,
            Msg::Resize {
                area: Rect::new(0, 0, width, 50),
                metrics: CellMetrics::new(8.0, 16.0),
            },
        );
        let g = tools_group(&m);
        let last = g.tabs.last().map_or(g.tab_strip.x, |t| t.rect.right());
        if g.tabs_after > 0 && last + 3 <= g.tab_strip.right() {
            let buf = draw(&m, width, 50);
            let line = row(&buf, g.tab_strip.y, g.tab_strip.x, g.tab_strip.right());
            assert!(
                line.trim_end()
                    .ends_with(&format!("\u{203a}{}", g.tabs_after)),
                "{line:?}"
            );
            counted = true;
            break;
        }
    }
    assert!(counted, "some width leaves room for the count");
    send(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    let g = tools_group(&m);
    // The strip says it too, for those who cannot see it.
    let tree = semantics(&m);
    let strip_node = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == format!("tabs:{}", g.id.raw()))
        .unwrap();
    assert!(
        strip_node
            .state
            .description
            .as_deref()
            .unwrap()
            .contains("scrolled out")
    );
}

#[test]
fn a_group_that_fits_its_tabs_draws_no_overflow_mark() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let g = tools_group(&m);
    let buf = draw(&m, 200, 50);
    let line = row(&buf, g.tab_strip.y, g.tab_strip.x, g.tab_strip.right());
    assert!(
        !line.contains('\u{2039}') && !line.contains('\u{203a}'),
        "{line:?}"
    );
}

#[test]
fn a_maximized_group_says_so_and_the_others_stay_on_the_tree() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let tools = tools_group(&m).id;
    send(&mut m, Msg::Dock(DockMsg::Maximize(tools)));
    let frame = m.frame().unwrap().clone();
    assert_eq!(
        frame.presentation,
        theorem_workbench_dock::Presentation::Maximized
    );
    assert_eq!(frame.groups.len(), 1);
    let g = &frame.groups[0];
    let buf = draw(&m, 200, 50);
    assert!(row(&buf, g.tab_strip.y, g.tab_strip.x, g.tab_strip.right()).contains("maximized"));

    let tree = semantics(&m);
    tree.validate().unwrap();
    assert!(!frame.suppressed.is_empty());
    for (id, _) in &frame.suppressed {
        let node = tree
            .nodes
            .iter()
            .find(|n| n.id.as_str() == format!("group:{}", id.raw()))
            .expect("a group behind the maximized one is on the tree");
        assert!(
            node.state
                .description
                .as_deref()
                .unwrap()
                .contains("maximized")
        );
    }
    let root = tree.node(&tree.root).unwrap();
    assert_eq!(
        root.state.description.as_deref(),
        Some("One panel maximized")
    );
}

#[test]
fn when_only_one_group_fits_the_principal_one_says_how_many_wait() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    send(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 40, 20),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    let frame = m.frame().unwrap().clone();
    assert_eq!(
        frame.presentation,
        theorem_workbench_dock::Presentation::Principal
    );
    let waiting = frame
        .suppressed
        .iter()
        .filter(|(_, why)| *why == theorem_workbench_dock::Suppressed::Collapsed)
        .count();
    assert!(waiting > 0);
    let g = &frame.groups[0];
    let buf = draw(&m, 40, 20);
    let line = row(&buf, g.tab_strip.y, g.tab_strip.x, g.tab_strip.right());
    assert!(
        line.contains(&format!("{waiting} more")) || line.contains(&format!("+{waiting}")),
        "{line:?}"
    );

    let tree = semantics(&m);
    tree.validate().unwrap();
    for (id, why) in &frame.suppressed {
        let node = tree
            .nodes
            .iter()
            .find(|n| n.id.as_str() == format!("group:{}", id.raw()))
            .expect("a suppressed group is on the tree");
        if *why == theorem_workbench_dock::Suppressed::Collapsed {
            assert!(
                node.state
                    .description
                    .as_deref()
                    .unwrap()
                    .contains("no room")
            );
        }
    }
}

// ---- the composer wire (batch six) --------------------------------------

fn conv(thread: &str) -> ResourceRef {
    ResourceRef::Conversation {
        project: "p".into(),
        thread: thread.into(),
    }
}

fn attachments(thread: &str, id_in_message: &str, names: &[&str]) -> Msg {
    Msg::Host(HostMessage::ConversationAttachments {
        resource: conv(thread),
        conversation_id: id_in_message.into(),
        attachments: names
            .iter()
            .map(|n| theorem_workbench_core::DraftAttachment {
                id: format!("id-{n}"),
                name: (*n).into(),
                content_type: None,
                size: None,
                state: theorem_workbench_core::DraftAttachmentState::Ready,
                reason: None,
            })
            .collect(),
    })
}

fn models(thread: &str, selected: &str) -> Msg {
    Msg::Host(HostMessage::ConversationModels {
        resource: conv(thread),
        conversation_id: thread.into(),
        models: vec![theorem_workbench_core::ModelChoice {
            model_ref: "m/one".into(),
            label: "One".into(),
            context_tokens: None,
        }],
        selected: Some(selected.into()),
        effort: None,
        efforts: vec![],
    })
}

fn draft_lists(log: &Shared) -> (Vec<Vec<String>>, Vec<String>) {
    let mut lists = Vec::new();
    let mut picked = Vec::new();
    for m in msgs_of(log, "chat") {
        match m {
            PanelMsg::Host(HostMessage::ConversationAttachments { attachments, .. }) => {
                lists.push(attachments.into_iter().map(|a| a.name).collect());
            }
            PanelMsg::Host(HostMessage::ConversationModels {
                selected: Some(s), ..
            }) => picked.push(s),
            _ => {}
        }
    }
    (lists, picked)
}

#[test]
fn the_draft_and_model_messages_reach_the_bound_chat_and_only_it() {
    let (mut m, log) = new_model();
    action(&mut m, "chat.open"); // bound to p/t1
    send(&mut m, attachments("t1", "t1", &["a.png"]));
    send(&mut m, models("t1", "m/one"));
    send(&mut m, attachments("t2", "t2", &["other.png"]));
    // Names another conversation than its resource: dropped.
    let dropped = m.counters().dropped;
    send(&mut m, attachments("t1", "t2", &["wrong.png"]));
    send(&mut m, models("t2", "m/one"));
    assert!(m.counters().dropped > dropped);
    let (lists, picked) = draft_lists(&log);
    assert_eq!(lists, vec![vec!["a.png".to_string()]]);
    assert_eq!(picked, vec!["m/one".to_string()]);
}

#[test]
fn a_chat_mounted_late_is_handed_the_latest_draft_and_model_lists_once() {
    let (mut m, log) = new_model();
    send(&mut m, attachments("t1", "t1", &["a.png"]));
    send(&mut m, attachments("t1", "t1", &["a.png", "b.png"]));
    send(&mut m, models("t1", "m/one"));
    send(&mut m, attachments("t1", "wrong", &["bad.png"])); // not retained
    assert_eq!(draft_lists(&log), (vec![], vec![]), "nobody is bound yet");
    let fx = action(&mut m, "chat.open");
    assert!(fx.is_empty() && log.borrow().emits.is_empty());
    let (lists, picked) = draft_lists(&log);
    assert_eq!(lists, vec![vec!["a.png".to_string(), "b.png".to_string()]]);
    assert_eq!(picked, vec!["m/one".to_string()]);
    send(&mut m, Msg::Tick);
    assert_eq!(draft_lists(&log).0.len(), 1, "replayed once");
}

#[test]
fn an_ended_conversation_forgets_its_draft_and_models() {
    let (mut m, log) = new_model();
    send(&mut m, attachments("t1", "t1", &["a.png"]));
    send(&mut m, models("t1", "m/one"));
    action(&mut m, "chat.open");
    assert_eq!(draft_lists(&log).0.len(), 1);
    action(&mut m, "chat.end");
    action(&mut m, "chat.open");
    let (lists, picked) = draft_lists(&log);
    assert_eq!(
        (lists.len(), picked.len()),
        (1, 1),
        "nothing left to replay"
    );
}

#[test]
fn the_composer_actions_need_their_capability_word() {
    let reg = builtin::registry();
    let with = Capabilities::of(["conversation", "conversation.attach", "conversation.model"]);
    let without = Capabilities::of(["conversation"]);
    for (id, kinds, word) in [
        (
            "theo.attach",
            vec![EffectKind::ConversationAttachPick],
            "conversation.attach",
        ),
        (
            "theo.model",
            vec![
                EffectKind::ConversationModels,
                EffectKind::ConversationSetModel,
            ],
            "conversation.model",
        ),
        (
            "theo.effort",
            vec![EffectKind::ConversationSetEffort],
            "conversation.model",
        ),
    ] {
        let (_, action) = reg.action(&ActionId::new(id)).expect(id);
        assert_eq!(action.emits, kinds, "{id}");
        assert_eq!(action.intent, ActionIntent::Start, "{id}");
        assert!(action.picker.is_none(), "{id}");
        assert!(
            reg.resolve(&ActionId::new(id), &Actor::Human, &with)
                .is_ok()
        );
        assert!(
            reg.resolve(&ActionId::new(id), &Actor::Human, &without)
                .is_err(),
            "{id} is absent without {word}"
        );
    }
}

#[test]
fn the_composer_effects_are_the_conversations_and_carry_their_fields() {
    use theorem_workbench_core::effect::{EffectBody, Owner};
    for (value, kind) in [
        (
            json!({"kind": "conversationAttachPick"}),
            EffectKind::ConversationAttachPick,
        ),
        (
            json!({"kind": "conversationAttachRemove", "payload": {"id": "a1"}}),
            EffectKind::ConversationAttachRemove,
        ),
        (
            json!({"kind": "conversationModels"}),
            EffectKind::ConversationModels,
        ),
        (
            json!({"kind": "conversationSetModel", "payload": {"ref": "m/one"}}),
            EffectKind::ConversationSetModel,
        ),
        (
            json!({"kind": "conversationSetEffort", "payload": {"level": "high"}}),
            EffectKind::ConversationSetEffort,
        ),
    ] {
        let body: EffectBody = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&body).unwrap(), value);
        assert_eq!(EffectKind::from(&body), kind);
        assert_eq!(kind.owner(), Owner::Conversation);
    }
    // References are optional on input, kept when present, skipped when empty.
    let send_body: EffectBody = serde_json::from_value(json!({
        "kind": "conversationSend",
        "payload": {"clientMessageId": "c", "text": "hi", "references": [
            {"path": "src/a.rs", "range": {"start": {"line": 1, "character": 0}, "end": {"line": 2, "character": 0}}, "label": "a"}
        ]}
    }))
    .unwrap();
    let EffectBody::ConversationSend(s) = &send_body else {
        panic!("not a send");
    };
    assert_eq!(s.references.len(), 1);
    assert!(s.attachments.is_empty());
}

#[test]
fn reduced_motion_reaches_each_panel_when_it_changes_and_on_mount() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let motion = |log: &Shared, kind: &str| -> Vec<bool> {
        msgs_of(log, kind)
            .into_iter()
            .filter_map(|m| match m {
                PanelMsg::Motion { reduced } => Some(reduced),
                _ => None,
            })
            .collect()
    };
    assert!(
        motion(&log, "note").is_empty(),
        "full motion is the default"
    );
    send(&mut m, Msg::ReducedMotion(true));
    send(&mut m, Msg::ReducedMotion(true));
    assert_eq!(motion(&log, "note"), vec![true], "told once");
    action(&mut m, "chat.open"); // built after the setting
    assert_eq!(motion(&log, "chat"), vec![true]);
    send(&mut m, Msg::ReducedMotion(false));
    assert_eq!(motion(&log, "note"), vec![true, false]);
    assert!(log.borrow().emits.is_empty());
}

// ---- batch seven: feeds, run list, search encoding ----------------------

fn finding(line: u32, message: &str) -> theorem_workbench_core::results::FindingAt {
    use theorem_workbench_core::results::{FindingAt, Position, Range, Severity};
    FindingAt {
        range: Range {
            start: Position { line, character: 0 },
            end: Position { line, character: 3 },
        },
        severity: Severity::Error,
        message: message.into(),
        source: None,
        code: None,
    }
}

fn diag_set(path: &str, rev: u64, messages: &[&str]) -> Msg {
    Msg::Host(HostMessage::DiagnosticsSet {
        path: path.into(),
        revision: Revision::Seq(rev),
        encoding: theorem_workbench_core::results::SpanEncoding::Utf16CodeUnits,
        findings: messages.iter().map(|m| finding(1, m)).collect(),
    })
}

fn diag_seen(log: &Shared, kind: &str) -> Vec<String> {
    msgs_of(log, kind)
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Host(HostMessage::DiagnosticsSet {
                path,
                revision: Revision::Seq(rev),
                findings,
                ..
            }) => Some(format!("{path}@{rev}:{}", findings.len())),
            PanelMsg::Host(HostMessage::DiagnosticsCleared { path }) => {
                Some(format!("cleared {path}"))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn diagnostics_reach_every_panel_that_asks_for_them_whatever_it_is_bound_to() {
    let (mut m, log) = new_model();
    action(&mut m, "diag.open"); // bound to a.md
    action(&mut m, "note.open");
    send(&mut m, diag_set("c.md", 1, &["x", "y"]));
    send(&mut m, diag_set("a.md", 1, &["z"]));
    assert_eq!(diag_seen(&log, "diag"), vec!["c.md@1:2", "a.md@1:1"]);
    assert!(
        diag_seen(&log, "note").is_empty(),
        "a kind that did not ask"
    );
    send(
        &mut m,
        Msg::Host(HostMessage::DiagnosticsCleared {
            path: "c.md".into(),
        }),
    );
    assert_eq!(diag_seen(&log, "diag").last().unwrap(), "cleared c.md");
    assert!(diag_seen(&log, "note").is_empty());
}

#[test]
fn an_older_set_for_a_path_is_dropped_and_a_newer_one_replaces_it() {
    let (mut m, log) = new_model();
    action(&mut m, "diag.open");
    send(&mut m, diag_set("c.md", 5, &["a"]));
    let dropped = m.counters().dropped;
    send(&mut m, diag_set("c.md", 4, &["old"]));
    assert_eq!(m.counters().dropped, dropped + 1);
    assert_eq!(m.counters().last_drop, Some(Stale::OlderRevision));
    send(&mut m, diag_set("c.md", 5, &["same", "again"]));
    send(&mut m, diag_set("c.md", 6, &[]));
    assert_eq!(
        diag_seen(&log, "diag"),
        vec!["c.md@5:1", "c.md@5:2", "c.md@6:0"]
    );
    // After a close, any revision is a new beginning.
    send(
        &mut m,
        Msg::Host(HostMessage::DiagnosticsCleared {
            path: "c.md".into(),
        }),
    );
    send(&mut m, diag_set("c.md", 1, &["fresh"]));
    assert_eq!(diag_seen(&log, "diag").last().unwrap(), "c.md@1:1");
}

#[test]
fn a_diagnostics_panel_mounted_late_is_handed_the_latest_set_per_path_once() {
    let (mut m, log) = new_model();
    send(&mut m, diag_set("a.md", 1, &["old"]));
    send(&mut m, diag_set("a.md", 2, &["new", "newer"]));
    send(&mut m, diag_set("b.md", 1, &["x"]));
    send(&mut m, diag_set("gone.md", 1, &["x"]));
    send(
        &mut m,
        Msg::Host(HostMessage::DiagnosticsCleared {
            path: "gone.md".into(),
        }),
    );
    assert!(diag_seen(&log, "diag").is_empty(), "nobody mounted yet");
    let fx = action(&mut m, "diag.open");
    assert!(fx.is_empty() && log.borrow().emits.is_empty());
    assert_eq!(diag_seen(&log, "diag"), vec!["a.md@2:2", "b.md@1:1"]);
    send(&mut m, Msg::Tick);
    assert_eq!(diag_seen(&log, "diag").len(), 2, "replayed once");
}

#[test]
fn only_the_newest_paths_of_the_feed_are_kept() {
    let (mut m, log) = new_model();
    for n in 0..300 {
        send(&mut m, diag_set(&format!("f{n}.rs"), 1, &["x"]));
    }
    action(&mut m, "diag.open");
    let seen = diag_seen(&log, "diag");
    assert_eq!(seen.len(), 256);
    assert_eq!(seen[0], "f44.rs@1:1");
}

#[test]
fn a_panel_that_reads_a_document_for_its_findings_opens_the_editor_never_itself() {
    let (mut m, log) = new_model();
    action(&mut m, "diag.open");
    let diag = kinds(&m, "diag")[0].clone();
    ch(&mut m, 'C'); // the findings panel now reads c.md
    assert_eq!(
        m.panel(&diag).unwrap().binding().unwrap().resource,
        ResourceRef::Document {
            workspace: "w".into(),
            resource_id: "c.md".into()
        }
    );
    ch(&mut m, 'g'); // open c.md at 12:4
    let notes = kinds(&m, "note");
    assert_eq!(notes.len(), 1, "the opener's panel was made");
    assert_eq!(m.focus().panel, Some(notes[0].clone()));
    assert_eq!(kinds(&m, "diag").len(), 1, "no second findings panel");
    assert!(
        msgs_of(&log, "diag")
            .iter()
            .all(|m| !matches!(m, PanelMsg::Reveal { .. })),
        "it was not told to reveal"
    );
    assert!(msgs_of(&log, "note").iter().any(|m| matches!(
        m,
        PanelMsg::Reveal {
            line: 12,
            column: 4
        }
    )));
}

#[test]
fn a_run_list_is_asked_by_the_run_owner_and_answered_with_summaries() {
    use theorem_workbench_core::completion::CompletionPayload;
    use theorem_workbench_core::effect::Owner;
    let body: EffectBody = serde_json::from_value(json!({"kind": "runList"})).unwrap();
    assert_eq!(EffectKind::from(&body), EffectKind::RunList);
    assert_eq!(EffectKind::RunList.owner(), Owner::Run);
    assert_eq!(
        serde_json::to_value(&body).unwrap(),
        json!({"kind": "runList"})
    );
    let value = json!({
        "type": "runList",
        "runs": [
            {"handle": "h1", "name": "build", "command": ["cargo", "build"],
             "state": "running", "startedAtMs": 1700000000000u64},
            {"handle": "h2", "state": "exited"}
        ]
    });
    let payload: CompletionPayload = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&payload).unwrap(), value);
    let CompletionPayload::RunList(list) = payload else {
        panic!("not a run list");
    };
    assert_eq!(list.runs[0].command.as_deref().unwrap()[0], "cargo");
    assert!(list.runs[1].name.is_none() && list.runs[1].started_at_ms.is_none());
}

#[test]
fn a_search_page_states_its_encoding_and_defaults_to_utf16_when_absent() {
    use theorem_workbench_core::results::SpanEncoding;
    let page = |extra: Value| {
        let mut v = json!({
            "type": "searchPage", "id": "s1", "skipped": 0, "state": "complete", "rows": [],
            "readAt": {"workspaceId": "w", "generation": 1}
        });
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    let bare: HostMessage = serde_json::from_value(page(json!({}))).unwrap();
    assert!(matches!(
        bare,
        HostMessage::SearchPage {
            encoding: SpanEncoding::Utf16CodeUnits,
            ..
        }
    ));
    assert_eq!(
        serde_json::to_value(&bare).unwrap()["encoding"],
        "utf16_code_units"
    );
    let stated: HostMessage =
        serde_json::from_value(page(json!({"encoding": "utf8_bytes"}))).unwrap();
    assert!(matches!(
        stated,
        HostMessage::SearchPage {
            encoding: SpanEncoding::Utf8Bytes,
            ..
        }
    ));
}

#[test]
fn the_diagnostics_messages_round_trip() {
    let value = json!({
        "type": "diagnosticsSet", "path": "a.rs",
        "revision": {"scheme": "seq", "value": 3}, "encoding": "utf8_bytes",
        "findings": [{
            "range": {"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 5}},
            "severity": "warning", "message": "unused", "source": "rustc", "code": "W1"
        }, {
            "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
            "severity": "hint", "message": "m"
        }]
    });
    let msg: HostMessage = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&msg).unwrap(), value);
    let cleared = json!({"type": "diagnosticsCleared", "path": "a.rs"});
    let msg: HostMessage = serde_json::from_value(cleared.clone()).unwrap();
    assert_eq!(serde_json::to_value(&msg).unwrap(), cleared);
}

// ---- the caret report (batch eight) -------------------------------------

#[test]
fn the_caret_of_the_panel_that_owns_input_is_reported_inside_its_body() {
    use theorem_workbench_core::{CaretPhase, CaretShape};
    let (mut m, log) = new_model();
    assert_eq!(m.caret(), None, "no panel, no caret");
    action(&mut m, "chat.open");
    assert_eq!(m.caret(), None, "the panel reports none");
    log.borrow_mut().caret = Some((3, 1, CaretPhase::Steady));
    let body = m
        .frame()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.focused)
        .unwrap()
        .body;
    let caret = m.caret().expect("a caret");
    assert_eq!((caret.x, caret.y), (body.x + 3, body.y + 1));
    assert_eq!(caret.shape, CaretShape::HollowBlock);
    assert_eq!(caret.phase, CaretPhase::Steady);
    // Another panel owning input moves the answer: the note reports too.
    action(&mut m, "note.open");
    let now = m.caret().unwrap();
    assert_eq!(m.focus().panel, Some(kinds(&m, "note")[0].clone()));
    let nb = m
        .frame()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.focused)
        .unwrap()
        .body;
    assert_eq!((now.x, now.y), (nb.x + 3, nb.y + 1));
}

#[test]
fn no_caret_while_the_window_is_unfocused_or_a_modal_owns_input() {
    use theorem_workbench_core::CaretPhase;
    let (mut m, log) = new_model();
    action(&mut m, "chat.open");
    log.borrow_mut().caret = Some((0, 0, CaretPhase::Blinking));
    assert!(m.caret().is_some());
    send(&mut m, Msg::Focus(false));
    assert_eq!(m.caret(), None, "unfocused window");
    send(&mut m, Msg::Focus(true));
    assert!(m.caret().is_some());
    send(&mut m, Msg::Picker(PickerMsg::Open));
    assert!(m.focus().modal);
    assert_eq!(m.caret(), None, "an open picker owns input");
    key(&mut m, Key::Esc, Mods::NONE);
    assert!(m.caret().is_some(), "and gives it back");
}

#[test]
fn a_resting_picker_does_not_own_input_so_the_composers_caret_is_still_reported() {
    use theorem_workbench_core::CaretPhase;
    let (mut m, log) = new_model();
    action(&mut m, "chat.open");
    log.borrow_mut().caret = Some((2, 0, CaretPhase::Steady));
    assert!(m.rest_picker_now());
    assert!(!m.focus().modal);
    assert!(m.caret().is_some());
}

#[test]
fn a_caret_outside_the_visible_body_is_not_drawn_at_the_edge() {
    use theorem_workbench_core::CaretPhase;
    let (mut m, log) = new_model();
    action(&mut m, "chat.open");
    let body = m
        .frame()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.focused)
        .unwrap()
        .body;
    for (dx, dy) in [(body.width, 0), (0, body.height), (body.width + 40, 2)] {
        log.borrow_mut().caret = Some((dx, dy, CaretPhase::Steady));
        assert_eq!(m.caret(), None, "({dx}, {dy}) is out of view");
    }
    // The last visible cell is still inside.
    log.borrow_mut().caret = Some((body.width - 1, body.height - 1, CaretPhase::Steady));
    assert!(m.caret().is_some());
}

#[test]
fn a_blinking_caret_is_steady_while_motion_is_reduced() {
    use theorem_workbench_core::CaretPhase;
    let (mut m, log) = new_model();
    action(&mut m, "chat.open");
    log.borrow_mut().caret = Some((0, 0, CaretPhase::Blinking));
    assert_eq!(m.caret().unwrap().phase, CaretPhase::Blinking);
    send(&mut m, Msg::ReducedMotion(true));
    assert_eq!(m.caret().unwrap().phase, CaretPhase::Steady);
    log.borrow_mut().caret = Some((0, 0, CaretPhase::Hidden));
    assert_eq!(
        m.caret().unwrap().phase,
        CaretPhase::Hidden,
        "hidden stays hidden"
    );
}

// ---- Gate 5: saved arrangements, account change, bounds, keyboard ----------

use theorem_workbench_core::ArrangementMsg;
use theorem_workbench_core::ArrangementNotice;
use theorem_workbench_core::completion::{
    CompletionPayload, LayoutDocument, LayoutLoaded, LayoutSaved, LayoutSource,
};

fn notices(m: &mut Model) -> Vec<Notice> {
    std::iter::from_fn(|| m.take_notice()).collect()
}

fn arrangement_notices(m: &mut Model) -> Vec<ArrangementNotice> {
    notices(m)
        .into_iter()
        .filter_map(|n| match n {
            Notice::Arrangement(a) => Some(a),
            _ => None,
        })
        .collect()
}

fn arrange(m: &mut Model, msg: ArrangementMsg) -> Vec<Effect> {
    send(m, Msg::Arrangement(msg))
}

fn save_text(effects: &[Effect]) -> (String, String) {
    match &effects.last().expect("an effect").body {
        EffectBody::LayoutSave(s) => (s.current.clone(), s.named_layouts.clone()),
        other => panic!("not a layout save: {other:?}"),
    }
}

fn saved(effect: EffectId, revision: u64) -> Msg {
    Msg::Completion(
        Completion::new(effect, ResourceRef::None, Outcome::Accepted).with_payload(
            CompletionPayload::LayoutSaved(LayoutSaved {
                revision: Revision::Seq(revision),
            }),
        ),
    )
}

fn loaded(effect: EffectId, revision: u64, current: &str, named: &str) -> Msg {
    loaded_from(effect, LayoutSource::Account, revision, current, named)
}

fn loaded_from(
    effect: EffectId,
    source: LayoutSource,
    revision: u64,
    current: &str,
    named: &str,
) -> Msg {
    Msg::Completion(
        Completion::new(effect, ResourceRef::None, Outcome::Accepted).with_payload(
            CompletionPayload::LayoutLoaded(LayoutLoaded {
                source,
                revision: Revision::Seq(revision),
                document: Some(LayoutDocument {
                    current: current.into(),
                    named_layouts: named.into(),
                }),
            }),
        ),
    )
}

fn named_item(name: &str, document: &Value) -> String {
    json!({
        "schema": "theorem.workbench.arrangements", "version": 1,
        "items": [{"name": name, "document": document}]
    })
    .to_string()
}

#[test]
fn arrangements_are_saved_listed_applied_renamed_and_deleted_through_the_layout_owner() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");

    // The presets come first and are always there.
    let names: Vec<_> = m
        .arrangements()
        .into_iter()
        .map(|a| (a.name, a.builtin))
        .collect();
    assert_eq!(names.len(), 4);
    assert!(names.iter().all(|(_, builtin)| *builtin));

    let fx = arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Writing".into(),
        },
    );
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].kind(), EffectKind::LayoutSave);
    assert_eq!(fx[0].revision, None, "nothing was read yet");
    let (current, named) = save_text(&fx);
    assert_eq!(
        serde_json::from_str::<Value>(&current).unwrap(),
        m.document()
    );
    assert_eq!(
        serde_json::from_str::<Value>(&named).unwrap()["items"][0]["name"],
        "Writing"
    );
    assert!(
        m.arrangements()
            .iter()
            .any(|a| a.name == "Writing" && !a.builtin)
    );

    // A change made while a save is out waits for its answer, then goes out
    // against the revision that answer gave.
    let held = arrange(
        &mut m,
        ArrangementMsg::Rename {
            from: "writing".into(),
            to: "Notes".into(),
        },
    );
    assert!(held.is_empty());
    let next = send(&mut m, saved(fx[0].id, 7));
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].revision, Some(Revision::Seq(7)));
    let (_, named) = save_text(&next);
    assert_eq!(
        serde_json::from_str::<Value>(&named).unwrap()["items"][0]["name"],
        "Notes"
    );
    send(&mut m, saved(next[0].id, 8));

    let del = arrange(
        &mut m,
        ArrangementMsg::Delete {
            name: "Notes".into(),
        },
    );
    assert_eq!(del[0].revision, Some(Revision::Seq(8)));
    assert!(m.arrangements().iter().all(|a| a.builtin));
    send(&mut m, saved(del[0].id, 9));
    assert!(m.in_flight().is_empty());

    // Names are checked: empty, a preset's, one that is not there.
    notices(&mut m);
    assert!(arrange(&mut m, ArrangementMsg::Save { name: "  ".into() }).is_empty());
    assert!(
        arrange(
            &mut m,
            ArrangementMsg::Save {
                name: "minimal".into()
            }
        )
        .is_empty()
    );
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "nope".into(),
        },
    );
    let told = arrangement_notices(&mut m);
    assert!(matches!(told[0], ArrangementNotice::BadName { .. }));
    assert!(matches!(told[1], ArrangementNotice::NameTaken { .. }));
    assert!(matches!(told[2], ArrangementNotice::Unknown { .. }));
}

#[test]
fn a_save_the_owner_refuses_is_told_and_the_arrangement_stays_here() {
    let (mut m, _) = new_model();
    let fx = arrange(&mut m, ArrangementMsg::Save { name: "A".into() });
    notices(&mut m);
    send(
        &mut m,
        Msg::Completion(Completion::new(
            fx[0].id,
            ResourceRef::None,
            Outcome::Refused {
                code: "stale_revision".into(),
                reason: "Someone else saved first.".into(),
            },
        )),
    );
    let told = arrangement_notices(&mut m);
    assert_eq!(
        told,
        vec![ArrangementNotice::NotSaved {
            reason: "Someone else saved first.".into()
        }]
    );
    assert!(m.arrangements().iter().any(|a| a.name == "A"));
    // The next change is not held behind the refused one.
    assert_eq!(
        arrange(&mut m, ArrangementMsg::Save { name: "B".into() }).len(),
        1
    );
}

#[test]
fn applying_an_arrangement_never_closes_a_panel_or_drops_its_state() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "term.open");
    action(&mut m, "note.open");
    ch(&mut m, '+');
    ch(&mut m, '+');
    let before: Vec<_> = m
        .panel_ids()
        .map(|(id, k)| (id.clone(), k.clone()))
        .collect();
    let dirty = m.focus().panel.unwrap();
    let kept = arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Spread".into(),
        },
    );
    send(&mut m, saved(kept[0].id, 1));

    for target in ["minimal", "agent", "editor", "default", "Spread", "minimal"] {
        let fx = arrange(
            &mut m,
            ArrangementMsg::Apply {
                name: target.into(),
            },
        );
        assert!(fx.is_empty(), "{target} emitted {fx:?}");
        let after: Vec<_> = m
            .panel_ids()
            .map(|(id, k)| (id.clone(), k.clone()))
            .collect();
        assert_eq!(after, before, "{target} changed what is open");
        for (id, _) in &before {
            let tab = theorem_workbench_dock::PanelId(id.as_str().to_owned());
            assert!(
                m.dock().find_panel(&tab).is_some(),
                "{target} left {id:?} in no group"
            );
        }
        assert_eq!(
            m.panel(&dirty).unwrap().serialize()["taps"],
            2,
            "{target} lost the draft"
        );
        assert!(m.in_flight().is_empty());
    }
    assert!(log.borrow().teardowns.is_empty(), "no panel was torn down");
    // Minimal shows one group; the panels of the hidden ones are in it.
    let shown = m
        .dock()
        .group_ids()
        .into_iter()
        .filter(|g| !m.dock().group(*g).unwrap().is_hidden())
        .count();
    assert_eq!(shown, 1);
}

#[test]
fn a_saved_arrangement_comes_back_as_it_was_saved() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "note.open");
    let path = m.frame().unwrap().splitters[0].path.clone();
    send(&mut m, Msg::Dock(DockMsg::ResizeSplit { path, delta: 6 }));
    arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Wide".into(),
        },
    );
    let wide = m.document();
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    assert_ne!(m.document()["dock"], wide["dock"]);
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "wide".into(),
        },
    );
    assert_eq!(m.document()["dock"], wide["dock"]);
    assert_eq!(
        arrangement_notices(&mut m).last(),
        Some(&ArrangementNotice::Applied {
            name: "Wide".into()
        })
    );
}

#[test]
fn an_arrangement_from_another_version_or_naming_an_unknown_kind_restores_what_it_can_and_says_so()
{
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let mut doc = m.document();
    // A tab of a kind this build lacks, in the first group.
    let first = doc["dock"]["groups"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    doc["dock"]["groups"][&first]["tabs"].as_array_mut().unwrap().push(json!({
        "panel": "g1", "kind": {"name": "ghost", "version": 3}, "title": "Ghost", "view_state": {"k": 1}
    }));
    let load = arrange(&mut m, ArrangementMsg::Load);
    assert_eq!(load[0].kind(), EffectKind::LayoutLoad);
    send(
        &mut m,
        loaded(load[0].id, 4, "", &named_item("Ghosts", &doc)),
    );
    assert!(m.arrangements().iter().any(|a| a.name == "Ghosts"));
    notices(&mut m);

    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Ghosts".into(),
        },
    );
    let told = arrangement_notices(&mut m);
    let [ArrangementNotice::Partial { dropped, .. }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(
        dropped,
        &["ghost".to_owned()],
        "a kind with no registration is named"
    );
    assert!(
        m.panel_ids().all(|(_, k)| k.as_str() != "ghost"),
        "and left out, not kept as a placeholder"
    );
    assert_eq!(kinds(&m, "note").len(), 1, "the open note is still there");

    // Saved by a newer version of the layout: read as far as it goes, told.
    let mut newer = m.document();
    newer["version"] = json!(9);
    newer["dock"]["version"] = json!(4);
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded(load[0].id, 5, "", &named_item("Newer", &newer)),
    );
    notices(&mut m);
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Newer".into(),
        },
    );
    let told = arrangement_notices(&mut m);
    let [ArrangementNotice::Partial { caveats, .. }] = told.as_slice() else {
        panic!("{told:?}");
    };
    assert_eq!(caveats.len(), 2);

    // One that cannot be read at all changes nothing.
    let layout = m.document();
    let junk = json!({"schema": "theorem.workbench", "version": 1, "dock": {"not": "a dock"}});
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded(load[0].id, 6, "", &named_item("Junk", &junk)),
    );
    notices(&mut m);
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Junk".into(),
        },
    );
    assert!(matches!(
        arrangement_notices(&mut m)[0],
        ArrangementNotice::Unreadable { .. }
    ));
    assert_eq!(m.document(), layout);
}

#[test]
fn loading_the_record_restores_the_layout_it_was_left_in_without_closing_what_is_open() {
    let (mut a, _) = new_model();
    action(&mut a, "note.open");
    action(&mut a, "term.open");
    arrange(
        &mut a,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    let left = a.document().to_string();

    let (mut b, _) = new_model();
    action(&mut b, "chat.open");
    let open = kinds(&b, "chat");
    let load = arrange(&mut b, ArrangementMsg::Load);
    send(&mut b, loaded(load[0].id, 3, &left, ""));
    assert!(!kinds(&b, "note").is_empty() && !kinds(&b, "term").is_empty());
    assert_eq!(kinds(&b, "chat"), open, "what was already open stays");
    assert!(b.in_flight().is_empty());

    // A record that cannot be read is told; the arrangements are not guessed.
    let load = arrange(&mut b, ArrangementMsg::Load);
    notices(&mut b);
    send(&mut b, loaded(load[0].id, 4, "", "not json"));
    assert!(matches!(
        arrangement_notices(&mut b)[0],
        ArrangementNotice::LoadedWithLoss { .. }
    ));
}

#[test]
fn an_account_change_drops_what_the_old_account_held_and_its_late_answers_are_stale() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "chat.open");
    send(&mut m, snapshot("t1", 5));
    let waiting = action(&mut m, "note.save");
    let id = last_effect_id(&waiting);
    let save = arrange(&mut m, ArrangementMsg::Save { name: "Old".into() });
    assert_eq!(m.in_flight().len(), 2);
    send(
        &mut m,
        Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w1".into(),
            environment: None,
        }),
    );
    let generation = m.workspace().generation.0;

    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    assert_eq!(m.workspace().account, "bob");
    assert!(
        !m.workspace().is_set(),
        "no workspace until the host names one"
    );
    assert!(m.workspace().generation.0 > generation);
    assert!(m.in_flight().is_empty());
    assert!(
        m.arrangements().iter().all(|a| a.builtin),
        "the old account's arrangements are gone"
    );
    // What the panel was waiting for is told as unknown, not left spinning.
    let told = msgs_of(&log, "note").into_iter().any(|msg| matches!(
        msg,
        PanelMsg::Completion(c) if c.effect == id && matches!(c.outcome, Outcome::Uncertain { .. })
    ));
    assert!(told);

    // Late answers for the old account find nothing in flight.
    let dropped = m.counters().dropped;
    send(
        &mut m,
        Msg::Completion(completion(id, "a.md", 5, Outcome::Accepted)),
    );
    send(&mut m, saved(save[0].id, 99));
    assert_eq!(m.counters().dropped, dropped + 2);
    assert_eq!(m.counters().last_drop, Some(Stale::UnknownEffect));
    // The revision it carried did not reach the new account's record.
    let again = arrange(&mut m, ArrangementMsg::Save { name: "New".into() });
    assert_eq!(again[0].revision, None);

    // The conversation retained for a mount later is gone too.
    action(&mut m, "chat.open");
    assert_eq!(
        snapshots_seen(&log),
        1,
        "only the one the first chat was given"
    );

    // The same account again changes nothing.
    let n = m.workspace().generation.0;
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    assert_eq!(m.workspace().generation.0, n);
}

#[test]
fn the_bounds_hold_and_hitting_one_is_told() {
    // Effects in flight: the 257th is refused, the 256 already waiting stay.
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    for _ in 0..300 {
        ch(&mut m, 'q');
    }
    assert_eq!(m.in_flight().len(), 256);
    assert_eq!(m.counters().refused_full, 44);
    let refused = log
        .borrow()
        .emits
        .iter()
        .filter(|r| matches!(r, Err(EmitError::InFlightFull(_))))
        .count();
    assert_eq!(refused, 44);
    // Told, and the queue of notices is itself bounded and says what it lost.
    let told = notices(&mut m);
    assert!(told.len() <= 17, "{}", told.len());
    assert!(
        told.iter()
            .any(|n| matches!(n, Notice::EffectsFull { limit: 256 }))
    );
    let lost = told.iter().find_map(|n| match n {
        Notice::Overflow { dropped } => Some(*dropped),
        _ => None,
    });
    assert_eq!(
        u64::from(lost.expect("the overflow is told")),
        m.counters().notices_dropped
    );
    assert!(m.counters().notices_dropped >= 28);

    // Retained host messages: the oldest of 41 conversations is pushed out and counted.
    let (mut m, _) = new_model();
    for n in 0..41 {
        send(&mut m, snapshot(&format!("x{n}"), 1));
    }
    assert_eq!(m.counters().evicted, 9);

    // Arrangements: the 33rd is refused, in a notice, and nothing is sent.
    let (mut m, _) = new_model();
    for n in 0..32 {
        let fx = arrange(
            &mut m,
            ArrangementMsg::Save {
                name: format!("L{n}"),
            },
        );
        send(&mut m, saved(fx[0].id, n + 1));
    }
    notices(&mut m);
    assert!(
        arrange(
            &mut m,
            ArrangementMsg::Save {
                name: "one more".into()
            }
        )
        .is_empty()
    );
    assert_eq!(
        arrangement_notices(&mut m),
        vec![ArrangementNotice::StoreFull { limit: 32 }]
    );
    assert_eq!(m.arrangements().len(), 4 + 32);
    // Replacing one that is kept is not a new one.
    assert_eq!(
        arrange(&mut m, ArrangementMsg::Save { name: "l3".into() }).len(),
        1
    );
}

fn chord(m: &mut Model, k: Key, mods: Mods) -> Vec<Effect> {
    key(m, k, mods)
}

const CA: Mods = Mods::CTRL.union(Mods::ALT);

#[test]
fn the_keyboard_moves_focus_between_groups_and_moves_the_panel_with_it() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let note = m.focus().panel.unwrap();
    assert_eq!(role_of(&m, &note), theorem_workbench_dock::Role::Tools);
    let tools = m.focus().group;

    chord(&mut m, Key::Left, CA);
    assert_ne!(
        m.focus().group,
        tools,
        "focus moved to the group on the left"
    );
    chord(&mut m, Key::Right, CA);
    assert_eq!(m.focus().group, tools);

    // Move the panel left: it lands in the main group and keeps the keyboard.
    chord(&mut m, Key::Left, CA.union(Mods::SHIFT));
    assert_eq!(role_of(&m, &note), theorem_workbench_dock::Role::Main);
    assert_eq!(m.focus().panel, Some(note.clone()));

    // Nothing above: refused with a reason, nothing moves.
    notices(&mut m);
    chord(&mut m, Key::Up, CA.union(Mods::SHIFT));
    assert_eq!(role_of(&m, &note), theorem_workbench_dock::Role::Main);
    assert!(notices(&mut m).iter().any(|n| matches!(n, Notice::Dock(_))));
}

#[test]
fn the_keyboard_resizes_the_focused_group_in_steps_and_maximises_it() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let width = |m: &Model| {
        let f = m.frame().unwrap();
        f.group(m.focus().group).unwrap().rect.width
    };
    let w = width(&m);
    chord(&mut m, Key::Char(']'), CA);
    assert_eq!(width(&m), w + 2);
    chord(&mut m, Key::Char('['), CA);
    chord(&mut m, Key::Char('['), CA);
    assert_eq!(width(&m), w - 2);

    // Past the minimum the dock refuses, and says so.
    notices(&mut m);
    for _ in 0..200 {
        chord(&mut m, Key::Char('['), CA);
    }
    assert!(notices(&mut m).iter().any(|n| matches!(n, Notice::Dock(_))));
    assert!(width(&m) >= 10);

    assert!(m.dock().maximized().is_none());
    chord(&mut m, Key::Char('m'), CA);
    assert_eq!(m.dock().maximized(), Some(m.focus().group));
    chord(&mut m, Key::Char('m'), CA);
    assert!(m.dock().maximized().is_none());

    // The same by action, so an adapter or the picker can do it.
    action(&mut m, "workbench.layout.minimal");
    assert_eq!(
        m.dock()
            .group_ids()
            .into_iter()
            .filter(|g| !m.dock().group(*g).unwrap().is_hidden())
            .count(),
        1
    );
}

#[test]
fn escape_closes_the_innermost_transient_and_returns_focus_to_where_it_was() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let note = m.focus().panel.unwrap();
    let main = m.dock().group_ids()[1];

    let dock_before_drag = m.dock().clone();

    // A drawer: Esc closes it and the keyboard goes back to the note.
    send(&mut m, Msg::Dock(DockMsg::OpenDrawer(main)));
    assert_eq!(m.dock().drawer(), Some(main));
    assert_ne!(m.focus().panel, Some(note.clone()));
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.dock().drawer(), None);
    assert_eq!(m.focus().panel, Some(note.clone()));

    // A splitter drag: Esc cancels it. The split goes back to what it was
    // and a later move drags nothing.
    let s = m.frame().unwrap().splitters[0].clone();
    let pt = |kind, x| {
        Msg::Pointer(Pointer {
            kind,
            x,
            y: s.rect.y + 1,
            mods: Mods::NONE,
            clicks: 1,
        })
    };
    send(&mut m, pt(PointerKind::Down(Button::Left), s.rect.x));
    send(&mut m, pt(PointerKind::Move, s.rect.x + 9));
    assert_eq!(m.frame().unwrap().splitters[0].first_len, s.first_len + 9);
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.frame().unwrap().splitters[0].first_len, s.first_len);
    assert_eq!(m.dock(), &dock_before_drag);
    send(&mut m, pt(PointerKind::Move, s.rect.x + 12));
    send(&mut m, pt(PointerKind::Up(Button::Left), s.rect.x + 12));
    assert_eq!(m.frame().unwrap().splitters[0].first_len, s.first_len);

    // With nothing transient open, Esc is the panel's.
    let seen = |log: &Shared| {
        msgs_of(log, "note")
            .iter()
            .filter(|m| matches!(m, PanelMsg::Key(k) if k.key() == Key::Esc))
            .count()
    };
    let before = seen(&log);
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(seen(&log), before + 1);
}

#[test]
fn esc_in_a_drawer_goes_to_a_text_panel_and_closes_it_otherwise_and_the_action_closes_it_either_way()
 {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let note = m.focus().panel.unwrap();
    let tools = m.focus().group;
    let esc_seen = |log: &Shared| {
        msgs_of(log, "note")
            .iter()
            .filter(|m| matches!(m, PanelMsg::Key(k) if k.key() == Key::Esc))
            .count()
    };

    // A note in the drawer that takes text keeps Esc for itself.
    log.borrow_mut().text_entry = true;
    send(&mut m, Msg::Dock(DockMsg::OpenDrawer(tools)));
    assert_eq!(m.dock().drawer(), Some(tools));
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.dock().drawer(), Some(tools));
    assert_eq!(esc_seen(&log), 1);
    // The action closes it whatever is focused, and focus goes back.
    let main = m.dock().group_ids()[1];
    send(&mut m, Msg::Dock(DockMsg::FocusGroup(main)));
    send(&mut m, Msg::Dock(DockMsg::FocusGroup(tools)));
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.dock().drawer(), Some(tools));
    chord(&mut m, Key::Esc, CA);
    assert_eq!(m.dock().drawer(), None);
    assert_eq!(m.focus().panel, Some(note.clone()));

    // A panel that is not taking text lets Esc close the drawer.
    log.borrow_mut().text_entry = false;
    send(&mut m, Msg::Dock(DockMsg::OpenDrawer(tools)));
    let before = esc_seen(&log);
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.dock().drawer(), None);
    assert_eq!(esc_seen(&log), before);
    assert_eq!(m.focus().panel, Some(note.clone()));

    // The action closes it with another group focused, too.
    send(&mut m, Msg::Dock(DockMsg::OpenDrawer(main)));
    action(&mut m, "workbench.drawer.close");
    assert_eq!(m.dock().drawer(), None);
    assert_eq!(m.focus().panel, Some(note));
}

#[test]
fn a_drawer_panel_that_holds_escape_without_text_entry_keeps_it_and_its_own_bindings() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let note = m.focus().panel.unwrap();
    let tools = m.focus().group;
    let esc_seen = |log: &Shared| {
        msgs_of(log, "note")
            .iter()
            .filter(|m| matches!(m, PanelMsg::Key(k) if k.key() == Key::Esc))
            .count()
    };

    // Holds Escape, takes no text: Escape goes to the panel, the drawer stays,
    // and the panel's own chord still resolves (its context is not TextEntry).
    log.borrow_mut().holds_escape = true;
    assert!(!log.borrow().text_entry);
    send(&mut m, Msg::Dock(DockMsg::OpenDrawer(tools)));
    assert_eq!(m.dock().drawer(), Some(tools));
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.dock().drawer(), Some(tools));
    assert_eq!(esc_seen(&log), 1);
    let finds = action_msgs(&log, "note", "note.find");
    chord(&mut m, Key::Char('f'), CA);
    assert_eq!(action_msgs(&log, "note", "note.find"), finds + 1);

    // Neither: Escape closes the drawer and the panel never sees it.
    log.borrow_mut().holds_escape = false;
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(m.dock().drawer(), None);
    assert_eq!(esc_seen(&log), 1);
    assert_eq!(m.focus().panel, Some(note));
}

// ---- local state, restored edits, where a layout came from, revoked access ----

use theorem_workbench_core::{LocalProblem, LocalState, LocalStatus};

fn local(path: &str, local: LocalState) -> Msg {
    Msg::Host(HostMessage::DocumentLocal {
        resource: doc(path),
        local,
    })
}

fn locals_seen(log: &Shared) -> Vec<LocalState> {
    msgs_of(log, "note")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Host(HostMessage::DocumentLocal { local, .. }) => Some(local),
            _ => None,
        })
        .collect()
}

#[test]
fn a_documents_local_state_reaches_its_panels_is_kept_for_later_ones_and_dropped_with_the_document()
{
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let checkpointed = LocalState {
        status: LocalStatus::Checkpointed {
            saved_at_ms: 1_700_000_000_000,
            recovered: true,
        },
        problem: None,
    };
    send(&mut m, local("a.md", checkpointed.clone()));
    send(
        &mut m,
        local(
            "other.md",
            LocalState {
                status: LocalStatus::Draft,
                problem: None,
            },
        ),
    );
    assert_eq!(
        locals_seen(&log),
        vec![checkpointed.clone()],
        "only the panel bound to a.md"
    );

    // A panel that binds later is told the latest at once.
    let draft = LocalState {
        status: LocalStatus::Draft,
        problem: Some(LocalProblem {
            code: "write_failed".into(),
            reason: "The local store is full.".into(),
        }),
    };
    send(&mut m, local("a.md", draft.clone()));
    action(&mut m, "note.open");
    let seen = locals_seen(&log);
    assert_eq!(seen.last(), Some(&draft));
    assert_eq!(seen.len(), 3);

    // Retired: nothing is replayed to the next panel.
    send(
        &mut m,
        Msg::Host(HostMessage::DocumentRetired {
            resource: doc("a.md"),
        }),
    );
    let before = locals_seen(&log).len();
    action(&mut m, "note.open");
    assert_eq!(locals_seen(&log).len(), before);

    // Closing the last panel of a document drops it too.
    send(&mut m, local("a.md", draft));
    for id in kinds(&m, "note") {
        send(&mut m, Msg::Dock(DockMsg::ClosePanel(id)));
    }
    let before = locals_seen(&log).len();
    action(&mut m, "note.open");
    assert_eq!(locals_seen(&log).len(), before);
}

#[test]
fn a_layout_read_from_the_device_is_labelled_and_never_the_base_of_a_save() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    assert!(!m.layout_is_device_copy());
    let mut doc = m.document();
    doc["version"] = json!(1);
    let named = named_item("Mine", &doc);

    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded_from(load[0].id, LayoutSource::Device, 12, "", &named),
    );
    assert!(m.layout_is_device_copy(), "the mount can keep showing it");
    assert!(arrangement_notices(&mut m).contains(&ArrangementNotice::DeviceCopy));
    // It can be read and applied.
    assert!(m.arrangements().iter().any(|a| a.name == "Mine"));
    assert!(
        arrange(
            &mut m,
            ArrangementMsg::Apply {
                name: "Mine".into()
            }
        )
        .is_empty()
    );

    // Every change that would be saved is refused, with the reason, and sends nothing.
    notices(&mut m);
    for msg in [
        ArrangementMsg::Save { name: "New".into() },
        ArrangementMsg::Rename {
            from: "Mine".into(),
            to: "Yours".into(),
        },
        ArrangementMsg::Delete {
            name: "Mine".into(),
        },
    ] {
        assert!(arrange(&mut m, msg).is_empty());
    }
    let told = arrangement_notices(&mut m);
    assert_eq!(told.len(), 3);
    assert!(
        told.iter()
            .all(|n| matches!(n, ArrangementNotice::NeedsAccountLoad { .. }))
    );
    assert!(
        m.arrangements().iter().any(|a| a.name == "Mine"),
        "nothing changed"
    );
    assert!(m.in_flight().is_empty());

    // An account load clears the label, and the save is based on its revision.
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded_from(load[0].id, LayoutSource::Account, 21, "", &named),
    );
    assert!(!m.layout_is_device_copy());
    let fx = arrange(&mut m, ArrangementMsg::Save { name: "New".into() });
    assert_eq!(fx[0].revision, Some(Revision::Seq(21)));

    // A device load never leaves a stale account revision behind to save on.
    send(&mut m, saved(fx[0].id, 22));
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded_from(load[0].id, LayoutSource::Device, 99, "", &named),
    );
    assert!(arrange(&mut m, ArrangementMsg::Save { name: "x".into() }).is_empty());
}

#[test]
fn a_refusal_that_says_access_is_gone_is_told_apart_from_one_that_is_not() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let revoked = [
        "forbidden",
        "unauthorized",
        "signed_out",
        "account_changed",
        "access_revoked",
    ];
    let mut seen = Vec::new();
    for code in revoked
        .iter()
        .chain(&["conflict", "stale_revision", "not_found"])
    {
        let id = last_effect_id(&action(&mut m, "note.save"));
        let refused = Outcome::Refused {
            code: (*code).into(),
            reason: "no".into(),
        };
        send(&mut m, Msg::Completion(completion(id, "a.md", 5, refused)));
        seen.push(
            msgs_of(&log, "note")
                .into_iter()
                .rev()
                .find_map(|m| match m {
                    PanelMsg::Completion(c) => Some(c.outcome.is_access_revoked()),
                    _ => None,
                }),
        );
    }
    assert_eq!(
        seen,
        [Some(true); 5]
            .into_iter()
            .chain([Some(false); 3])
            .collect::<Vec<_>>()
    );
    assert!(
        !Outcome::Failed {
            reason: "forbidden".into()
        }
        .is_access_revoked()
    );
}

#[test]
fn adoption_and_modes_reach_a_late_terminal_panel_and_are_dropped_on_a_change() {
    use theorem_workbench_core::host::{MouseProtocol, TerminalAdoption, TerminalModes};
    let (mut m, log) = new_model();
    send(&mut m, workspace("w", None));
    let modes = TerminalModes {
        alternate_screen: true,
        application_cursor: false,
        application_keypad: false,
        bracketed_paste: true,
        hide_cursor: false,
        mouse_protocol: MouseProtocol::AnyMotion,
        mouse_encoding: Default::default(),
    };
    let list = |adoption| {
        Msg::Host(HostMessage::TerminalSessions {
            workspace: "w".into(),
            profiles: vec![],
            sessions: vec![theorem_workbench_core::host::TerminalSessionInfo {
                session: "s".into(),
                profile: "Shell".into(),
                backend: theorem_workbench_core::effect::TerminalBackend::Native,
                workspace: "w".into(),
                host: None,
                program: None,
                state: Default::default(),
                controlled_elsewhere: false,
                modes: Some(modes),
                program_report: Default::default(),
            }],
            adoption,
        })
    };
    send(&mut m, list(Some(TerminalAdoption::Pending)));
    send(
        &mut m,
        list(Some(TerminalAdoption::Unavailable {
            reason: Some("down".into()),
        })),
    );
    action(&mut m, "term.open");
    let told: Vec<_> = msgs_of(&log, "term")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Host(HostMessage::TerminalSessions {
                sessions, adoption, ..
            }) => Some((adoption, sessions[0].modes)),
            _ => None,
        })
        .collect();
    assert_eq!(
        told,
        vec![(
            Some(TerminalAdoption::Unavailable {
                reason: Some("down".into())
            }),
            Some(modes)
        )]
    );
    // Another workspace drops the list; coming back replays nothing stale.
    send(&mut m, workspace("other", None));
    send(&mut m, workspace("w", None));
    action(&mut m, "term.open");
    let after = msgs_of(&log, "term")
        .into_iter()
        .filter(|m| matches!(m, PanelMsg::Host(HostMessage::TerminalSessions { .. })))
        .count();
    assert_eq!(after, 1);
}

#[test]
fn the_new_wire_fields_are_optional_and_older_hosts_still_parse() {
    use theorem_workbench_core::host::TerminalAdoption;
    let old: HostMessage = serde_json::from_value(serde_json::json!({
        "type": "terminalSessions", "workspace": "w", "profiles": [], "sessions": []
    }))
    .unwrap();
    assert!(matches!(
        old,
        HostMessage::TerminalSessions { adoption: None, .. }
    ));
    let pending: HostMessage = serde_json::from_value(serde_json::json!({
        "type": "terminalSessions", "workspace": "w", "profiles": [], "sessions": [],
        "adoption": {"state": "pending"}
    }))
    .unwrap();
    assert!(matches!(
        pending,
        HostMessage::TerminalSessions {
            adoption: Some(TerminalAdoption::Pending),
            ..
        }
    ));
    let side: theorem_workbench_core::completion::ConflictSides =
        serde_json::from_value(serde_json::json!({"path": "a", "conflict": true})).unwrap();
    assert!(!side.binary);
    assert!(serde_json::to_value(&side).unwrap().get("binary").is_none());
    let run: theorem_workbench_core::results::RunSummary = serde_json::from_value(
        serde_json::json!({"handle": "h", "state": "failed", "exitCode": 2, "kind": "test"}),
    )
    .unwrap();
    assert_eq!(
        (run.exit_code, run.kind.as_deref()),
        (Some(2), Some("test"))
    );
}

// ---- batch eleven: layouts in the picker, the notice row, an empty account ----

fn layout_rows(m: &Model) -> Vec<String> {
    m.picker()
        .rows(m.registry(), m.capabilities(), m.pinned())
        .into_iter()
        .map(|r| r.title)
        .collect()
}

/// Walk the highlight to `row` with the arrow keys, whatever the column count.
fn select_row(m: &mut Model, row: usize) {
    for _ in 0..32 {
        let at = m.picker().selected();
        if at == row {
            return;
        }
        let k = if row < at {
            Key::Up
        } else if row - at >= 2 {
            Key::Down
        } else {
            Key::Right
        };
        key(m, k, Mods::NONE);
        if m.picker().selected() == at {
            key(m, Key::Down, Mods::NONE);
        }
    }
    panic!("could not reach row {row}");
}

fn type_text(m: &mut Model, text: &str) {
    for c in text.chars() {
        ch(m, c);
    }
}

fn keep(m: &mut Model, name: &str, revision: u64) {
    let fx = arrange(m, ArrangementMsg::Save { name: name.into() });
    send(m, saved(fx[0].id, revision));
}

fn layout_save_name(effects: &[Effect]) -> Vec<String> {
    let (_, named) = save_text(effects);
    let value: Value = serde_json::from_str(&named).unwrap();
    value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_layouts_page_lists_the_presets_then_the_saved_and_enter_applies() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    keep(&mut m, "Writing", 1);
    keep(&mut m, "Review", 2);
    notices(&mut m);

    let fx = action(&mut m, "workbench.layouts");
    assert!(fx.is_empty());
    assert!(m.picker().holds_keys());
    assert_eq!(
        layout_rows(&m),
        [
            "Default",
            "Editor-centred",
            "Agent-centred",
            "Minimal",
            "Writing",
            "Review",
            "Save layout as\u{2026}"
        ]
    );
    // The rows are in the semantic tree under their own heading.
    let tree = semantics(&m);
    assert!(
        tree.nodes
            .iter()
            .any(|n| n.name == "Layouts" && n.role == Role::Heading)
    );
    assert!(
        tree.nodes
            .iter()
            .any(|n| n.name == "Writing" && n.role == Role::MenuItem)
    );

    select_row(&mut m, 3);
    key(&mut m, Key::Enter, Mods::NONE);
    assert!(!m.picker().is_open(), "applying closes the picker");
    assert_eq!(
        arrangement_notices(&mut m),
        [ArrangementNotice::Applied {
            name: "minimal".into()
        }]
    );
    assert_eq!(
        m.notice_line().map(|l| l.text),
        Some("Layout: minimal applied".to_owned())
    );

    // A saved one by name.
    action(&mut m, "workbench.layouts");
    select_row(&mut m, 4);
    key(&mut m, Key::Enter, Mods::NONE);
    assert_eq!(
        arrangement_notices(&mut m),
        [ArrangementNotice::Applied {
            name: "Writing".into()
        }]
    );
    // Escape goes back a page, then closes.
    action(&mut m, "workbench.layouts");
    key(&mut m, Key::Esc, Mods::NONE);
    assert!(m.picker().holds_keys());
    assert_eq!(
        m.picker().page(),
        theorem_workbench_core::picker::Page::Main
    );
    key(&mut m, Key::Esc, Mods::NONE);
    assert!(!m.picker().is_open());
}

#[test]
fn save_layout_as_asks_for_a_name_in_the_picker_and_refuses_in_words() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    notices(&mut m);

    // By the named action: straight to the entry.
    action(&mut m, "workbench.layout.save");
    assert_eq!(
        m.picker().naming(),
        Some(&theorem_workbench_core::picker::NameFor::Save)
    );
    // An empty name is refused on the entry row and nothing is sent.
    assert!(key(&mut m, Key::Enter, Mods::NONE).is_empty());
    assert_eq!(m.picker().reason(), Some("A name is needed."));
    assert!(m.picker().holds_keys());
    // So is a preset's name.
    type_text(&mut m, "minimal");
    assert!(key(&mut m, Key::Enter, Mods::NONE).is_empty());
    assert!(m.picker().reason().unwrap().contains("built-in"));
    // The entry is in the tree as a text box with its reason beside it.
    let tree = semantics(&m);
    assert!(
        tree.nodes
            .iter()
            .any(|n| n.role == Role::TextBox && n.name == "Save layout as")
    );
    assert!(tree.nodes.iter().any(|n| n.role == Role::Alert));
    // Typing again clears the reason; Enter saves.
    for _ in 0..7 {
        key(&mut m, Key::Backspace, Mods::NONE);
    }
    assert_eq!(m.picker().reason(), None);
    type_text(&mut m, "Focus");
    let fx = key(&mut m, Key::Enter, Mods::NONE);
    assert_eq!(fx.len(), 1);
    assert_eq!(layout_save_name(&fx), ["Focus"]);
    assert!(!m.picker().is_open());
    send(&mut m, saved(fx[0].id, 1));
    assert_eq!(
        arrangement_notices(&mut m),
        [ArrangementNotice::Saved {
            name: "Focus".into()
        }]
    );
    assert!(
        m.arrangements()
            .iter()
            .any(|a| a.name == "Focus" && !a.builtin)
    );

    // Escape cancels: nothing is sent, the picker closes.
    action(&mut m, "workbench.layout.save");
    type_text(&mut m, "Never");
    assert!(key(&mut m, Key::Esc, Mods::NONE).is_empty());
    assert!(!m.picker().is_open());
    assert!(!m.arrangements().iter().any(|a| a.name == "Never"));

    // From the Layouts page the Save row opens the entry and Escape returns to
    // the page.
    action(&mut m, "workbench.layouts");
    select_row(&mut m, 5);
    key(&mut m, Key::Enter, Mods::NONE);
    assert!(m.picker().naming().is_some());
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(
        m.picker().page(),
        theorem_workbench_core::picker::Page::Layouts
    );
}

#[test]
fn rename_and_delete_act_on_the_highlighted_saved_layout_and_delete_asks_once() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    keep(&mut m, "Writing", 1);
    keep(&mut m, "Review", 2);
    notices(&mut m);
    action(&mut m, "workbench.layouts");

    // A built-in one is neither renamed nor deleted, and says so.
    key(&mut m, Key::Char('r'), Mods::CTRL | Mods::ALT);
    assert!(m.picker().reason().unwrap().contains("built in"));
    assert_eq!(
        m.picker().page(),
        theorem_workbench_core::picker::Page::Layouts
    );
    key(&mut m, Key::Char('d'), Mods::CTRL | Mods::ALT);
    assert!(m.picker().reason().unwrap().contains("built in"));

    // Rename "Writing" (the fifth row).
    select_row(&mut m, 4);
    key(&mut m, Key::Char('r'), Mods::CTRL | Mods::ALT);
    assert_eq!(
        m.picker().naming(),
        Some(&theorem_workbench_core::picker::NameFor::Rename(
            "Writing".into()
        ))
    );
    assert_eq!(
        m.picker().filter(),
        "Writing",
        "starts from the current name"
    );
    // A name a saved layout has is refused.
    for _ in 0..7 {
        key(&mut m, Key::Backspace, Mods::NONE);
    }
    type_text(&mut m, "review");
    assert!(key(&mut m, Key::Enter, Mods::NONE).is_empty());
    assert!(m.picker().reason().unwrap().contains("already"));
    for _ in 0..6 {
        key(&mut m, Key::Backspace, Mods::NONE);
    }
    type_text(&mut m, "Prose");
    let fx = key(&mut m, Key::Enter, Mods::NONE);
    assert_eq!(layout_save_name(&fx), ["Prose", "Review"]);
    assert_eq!(
        m.picker().page(),
        theorem_workbench_core::picker::Page::Layouts
    );
    send(&mut m, saved(fx[0].id, 3));

    // Delete asks once: another key withdraws it, Enter confirms it.
    select_row(&mut m, 4);
    key(&mut m, Key::Char('d'), Mods::CTRL | Mods::ALT);
    assert!(m.picker().reason().unwrap().contains("Delete \"Prose\""));
    assert!(key(&mut m, Key::Down, Mods::NONE).is_empty());
    assert_eq!(m.picker().reason(), None);
    assert!(layout_rows(&m).contains(&"Prose".to_owned()));
    key(&mut m, Key::Up, Mods::NONE);
    key(&mut m, Key::Char('d'), Mods::CTRL | Mods::ALT);
    let fx = key(&mut m, Key::Enter, Mods::NONE);
    assert_eq!(layout_save_name(&fx), ["Review"]);
    assert!(m.picker().holds_keys(), "the page stays for the next one");
    assert!(!layout_rows(&m).contains(&"Prose".to_owned()));
    // By the named actions, too.
    action(&mut m, "picker.layout.delete");
    assert!(m.picker().reason().is_some());
}

#[test]
fn a_saved_arrangement_restores_groups_sizes_tabs_active_tab_and_focus() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "term.open");
    action(&mut m, "chat.open");
    // Make it unlike a fresh preset: another active tab, a moved splitter,
    // the keyboard on a panel in another group.
    action(&mut m, "workbench.resize.wider");
    action(&mut m, "workbench.focus.left");
    let before = m.document()["dock"].clone();
    keep(&mut m, "Mine", 1);
    // Change everything.
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    action(&mut m, "workbench.focus.right");
    assert_ne!(m.document()["dock"], before);

    action(&mut m, "workbench.layouts");
    select_row(&mut m, 4);
    key(&mut m, Key::Enter, Mods::NONE);
    assert_eq!(
        m.document()["dock"],
        before,
        "groups, splits, sizes, tabs, active tabs, focus"
    );
}

#[test]
fn a_kind_with_no_registration_is_dropped_and_named_on_the_notice_row() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let mut doc = m.document();
    let first = doc["dock"]["groups"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    doc["dock"]["groups"][&first]["tabs"].as_array_mut().unwrap().push(json!({
        "panel": "g1", "kind": {"name": "ghost", "version": 3}, "title": "Ghost", "view_state": {}
    }));
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded(load[0].id, 4, "", &named_item("Ghosts", &doc)),
    );
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Ghosts".into(),
        },
    );
    let line = m.notice_line().expect("a notice");
    assert!(line.text.contains("ghost"), "{}", line.text);
    assert_eq!(
        line.severity,
        theorem_workbench_core::NoticeSeverity::Warning
    );
    assert!(m.panel_ids().all(|(_, k)| k.as_str() != "ghost"));
}

fn group_rects(m: &Model) -> Vec<(Rect, Rect)> {
    m.frame()
        .unwrap()
        .groups
        .iter()
        .map(|g| (g.body, g.tab_strip))
        .collect()
}

fn draw_cells(m: &Model, full: Rect, theme: &Theme) -> Buffer {
    let mut buf = Buffer::empty(full);
    view(m, full, &mut buf, theme);
    buf
}

#[test]
fn a_transient_notice_never_moves_the_dock_and_is_drawn_over_the_bottom_row() {
    let (mut m, _) = new_model();
    let full = Rect::new(0, 0, 200, 50);
    let theme = Theme {
        error: ratatui::style::Style::new().fg(ratatui::style::Color::Red),
        ..Theme::plain()
    };
    assert_eq!(m.notice_line(), None);
    assert_eq!(m.notice_row(full), None);
    assert_eq!(m.notice_rect(full), None);
    let before_rects = group_rects(&m);
    let before_area = m.frame().unwrap().area;
    let before_cells = draw_cells(&m, full, &theme);
    assert_eq!(before_area, full);

    action(&mut m, "no.such.action");
    let line = m.notice_line().unwrap();
    assert!(!line.persistent);
    assert_eq!(line.severity, theorem_workbench_core::NoticeSeverity::Error);
    // No row is taken: the dock is solved where it was.
    assert_eq!(m.notice_row(full), None);
    assert_eq!(m.dock_area_in(full), full);
    assert_eq!(m.frame().unwrap().area, before_area);
    assert_eq!(group_rects(&m), before_rects);

    // Drawn at the right of the bottom row, text plus one cell each side.
    let width = u16::try_from(line.text.chars().count() + 2).unwrap();
    let rect = m.notice_rect(full).unwrap();
    assert_eq!(rect, Rect::new(200 - width, 49, width, 1));
    let during = draw_cells(&m, full, &theme);
    let drawn: String = (rect.x..rect.right())
        .map(|x| during[(x, 49)].symbol().to_owned())
        .collect();
    assert_eq!(drawn, format!(" {} ", line.text));
    assert_eq!(during[(rect.x + 1, 49)].fg, ratatui::style::Color::Red);
    // Nothing left of it changed.
    for x in 0..rect.x {
        assert_eq!(during[(x, 49)], before_cells[(x, 49)], "cell {x}");
    }
    // It is a status in the semantic tree, where it is drawn.
    let tree = semantics(&m);
    let node = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "notice")
        .unwrap();
    assert_eq!(
        (node.role, node.name.as_str(), node.rect),
        (
            Role::Status,
            line.text.as_str(),
            theorem_workbench_core::semantics::CellRect::of(rect)
        )
    );

    // The next key press clears it; geometry and cells are as they were.
    ch(&mut m, 'x');
    assert_eq!(m.notice_line(), None);
    assert_eq!(m.dock_area_in(full), full);
    assert_eq!(group_rects(&m), before_rects);
    let after = draw_cells(&m, full, &theme);
    for x in 0..200u16 {
        assert_eq!(after[(x, 49)], before_cells[(x, 49)], "cell {x} restored");
    }
}

#[test]
fn a_transient_wider_than_the_frame_is_cut_with_an_ellipsis() {
    let (mut m, _) = new_model();
    let full = Rect::new(0, 0, 20, 10);
    send(
        &mut m,
        Msg::Resize {
            area: full,
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    action(&mut m, "no.such.action");
    let rect = m.notice_rect(full).unwrap();
    assert_eq!(rect, Rect::new(0, 9, 20, 1));
    let buf = draw_cells(&m, full, &Theme::plain());
    let drawn: String = (0..20u16)
        .map(|x| buf[(x, 9)].symbol().to_owned())
        .collect();
    assert!(drawn.ends_with("\u{2026} "), "{drawn:?}");
    assert_eq!(m.dock_area_in(full), full);
}

#[test]
fn a_transient_notice_goes_with_the_next_notice_and_a_persistent_one_stays() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let load = arrange(&mut m, ArrangementMsg::Load);
    let doc = m.document();
    send(
        &mut m,
        loaded_from(
            load[0].id,
            LayoutSource::Device,
            0,
            "",
            &named_item("Mine", &doc),
        ),
    );
    assert!(m.layout_is_device_copy());
    let full = Rect::new(0, 0, 200, 50);
    let persistent_rects = group_rects(&m);
    assert_eq!(m.dock_area_in(full), Rect::new(0, 0, 200, 49));
    let line = m.notice_line().unwrap();
    assert!(line.persistent);
    assert_eq!(line.text, "Layout: this device's copy, not your account's");
    assert_eq!(
        line.severity,
        theorem_workbench_core::NoticeSeverity::Warning
    );
    // Keys do not clear it.
    ch(&mut m, 'x');
    assert_eq!(m.notice_line().unwrap().text, line.text);

    // A transient notice shows over it, the next one replaces that, and a key
    // press brings the persistent one back.
    action(&mut m, "no.such.action");
    assert!(!m.notice_line().unwrap().persistent);
    // It takes the persistent row's place, with no change of geometry.
    assert_eq!(m.notice_row(full), Some(Rect::new(0, 49, 200, 1)));
    assert_eq!(m.notice_rect(full), m.notice_row(full));
    assert_eq!(m.dock_area_in(full), Rect::new(0, 0, 200, 49));
    assert_eq!(group_rects(&m), persistent_rects);
    let over = draw_cells(&m, full, &Theme::plain());
    let drawn: String = (0..200u16)
        .map(|x| over[(x, 49)].symbol().to_owned())
        .collect();
    assert!(
        drawn.contains("no.such.action") && !drawn.contains("device"),
        "{drawn}"
    );
    action(&mut m, "no.other.action");
    assert!(m.notice_line().unwrap().text.contains("no.other.action"));
    ch(&mut m, 'x');
    assert_eq!(m.notice_line(), Some(line.clone()));
    assert_eq!(group_rects(&m), persistent_rects);
    let back = draw_cells(&m, full, &Theme::plain());
    let drawn: String = (0..200u16)
        .map(|x| back[(x, 49)].symbol().to_owned())
        .collect();
    assert!(drawn.contains(&line.text), "{drawn}");
    // It is on the semantic tree as a standing status.
    let tree = semantics(&m);
    let node = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str() == "notice")
        .unwrap();
    assert_eq!(node.role, Role::Status);
    assert!(
        node.state
            .description
            .as_deref()
            .unwrap()
            .contains("standing")
    );

    // When the account's own layout arrives the persistent state ends, and the
    // dock takes the row back: the second and last geometry change.
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        loaded_from(load[0].id, LayoutSource::Account, 1, "", "[]"),
    );
    assert!(!m.layout_is_device_copy());
    assert_eq!(m.notice_row(full), None);
    assert_eq!(m.dock_area_in(full), full);

    // A host that reads the row stops the queue.
    m.set_notice_queue(false);
    action(&mut m, "no.third.action");
    assert_eq!(m.take_notice(), None);
    assert!(m.notice_line().is_some());
}

#[test]
fn an_account_with_no_saved_layout_gets_the_default_not_the_old_ones() {
    let (mut m, _) = new_model();
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "ann".into(),
        }),
    );
    action(&mut m, "note.open");
    action(&mut m, "term.open");
    action(&mut m, "chat.open");
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    assert_eq!(m.document()["dock"]["groups"]["1"]["hidden"], json!(true));

    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    // The old account's documents and terminals are gone from the tabs; what is
    // not account content stays.
    assert!(kinds(&m, "note").is_empty());
    assert!(kinds(&m, "term").is_empty());
    assert_eq!(kinds(&m, "chat").len(), 1);

    // The new account's record is empty.
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        Msg::Completion(
            Completion::new(load[0].id, ResourceRef::None, Outcome::Accepted).with_payload(
                CompletionPayload::LayoutLoaded(LayoutLoaded {
                    source: LayoutSource::Account,
                    revision: Revision::Seq(0),
                    document: None,
                }),
            ),
        ),
    );
    assert_eq!(
        m.document()["dock"]["groups"]["1"]["hidden"],
        json!(false),
        "the default shows the files group the minimal one hid"
    );
    assert_eq!(
        arrangement_notices(&mut m).last(),
        Some(&ArrangementNotice::Applied {
            name: "Default".into()
        })
    );
    // Nothing on screen points at a resource of the old account.
    let tree = semantics(&m);
    assert!(!tree.nodes.iter().any(|n| n.id.as_str().starts_with("tab:")
        && (n.name.contains("note") || n.name.contains("term"))));

    // The first account of a session is not a switch: its empty record
    // changes nothing.
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    let minimal = m.document()["dock"]["layout"].clone();
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "ann".into(),
        }),
    );
    assert_eq!(
        kinds(&m, "note").len(),
        1,
        "a restored layout is not another account's"
    );
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        Msg::Completion(
            Completion::new(load[0].id, ResourceRef::None, Outcome::Accepted).with_payload(
                CompletionPayload::LayoutLoaded(LayoutLoaded {
                    source: LayoutSource::Account,
                    revision: Revision::Seq(0),
                    document: None,
                }),
            ),
        ),
    );
    assert_eq!(m.document()["dock"]["layout"], minimal);
}

#[test]
fn a_reset_ends_with_the_conversation_focused_and_the_picker_resting() {
    let (mut m, _) = new_model();
    action(&mut m, "theo.focus");
    assert!(m.rest_picker_now());
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "ann".into(),
        }),
    );
    // The person was in the tool group with the picker holding the keys.
    action(&mut m, "workbench.layouts");
    assert!(m.picker().holds_keys());
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        Msg::Completion(
            Completion::new(load[0].id, ResourceRef::None, Outcome::Accepted).with_payload(
                CompletionPayload::LayoutLoaded(LayoutLoaded {
                    source: LayoutSource::Account,
                    revision: Revision::Seq(0),
                    document: None,
                }),
            ),
        ),
    );
    assert!(
        !m.picker().holds_keys(),
        "the picker does not hold the keys"
    );
    assert!(m.picker().is_resting() || !m.picker().is_open());
    assert_eq!(focused_kind(&m).as_deref(), Some("theo"));
    // A chord in the key table runs rather than going to the picker.
    key(&mut m, Key::Char('e'), Mods::CTRL | Mods::ALT);
    assert!(!m.picker().holds_keys());
    assert_eq!(
        focused_kind(&m).as_deref(),
        Some("files"),
        "files.focus ran"
    );
}

fn focused_kind(m: &Model) -> Option<String> {
    let group = m.dock().group(m.dock().focused())?;
    Some(group.active()?.kind.name.clone())
}

#[test]
fn takes_chord_mirrors_on_key_without_changing_the_model() {
    let (mut m, log) = new_model();
    let chord = |k: Key, mods: Mods| KeyInput::new(k, mods);
    let global = chord(Key::Char('k'), Mods::CTRL | Mods::ALT);
    let unbound = chord(Key::Char('q'), Mods::CTRL | Mods::ALT);
    let picker_only = chord(Key::Char('d'), Mods::CTRL | Mods::ALT);
    action(&mut m, "note.open");
    let before = m.document();
    assert!(m.takes_chord(&global));
    assert!(!m.takes_chord(&unbound));
    // A picker-scoped chord counts only while the picker holds the keys.
    assert!(!m.takes_chord(&picker_only));
    action(&mut m, "workbench.layouts");
    assert!(m.takes_chord(&picker_only));
    assert!(m.takes_chord(&chord(Key::Enter, Mods::NONE)));
    assert!(!m.takes_chord(&chord(Key::Char('x'), Mods::CTRL)));
    key(&mut m, Key::Esc, Mods::NONE);
    key(&mut m, Key::Esc, Mods::NONE);
    assert!(!m.picker().holds_keys());
    assert_eq!(m.document(), before);
    // A panel that handles a chord itself says so.
    log.borrow_mut().takes = Some(unbound);
    assert!(m.takes_chord(&unbound));
    assert_eq!(m.document(), before);
}

#[test]
fn a_tool_chord_names_an_open_tool_while_the_picker_holds_the_keys() {
    let (mut m, log) = new_model();
    // Files open on the left, a note beside it, and the picker taking keys.
    action(&mut m, "files.focus");
    let files = focused_kind(&m);
    assert_eq!(files.as_deref(), Some("files"));
    action(&mut m, "note.open");
    action(&mut m, "workbench.layouts");
    assert!(m.picker().holds_keys());
    let files_chord = KeyInput::new(Key::Char('e'), Mods::CTRL | Mods::ALT);
    assert!(
        m.takes_chord(&files_chord),
        "the root may read it by position"
    );

    key(&mut m, Key::Char('e'), Mods::CTRL | Mods::ALT);
    assert!(!m.picker().holds_keys(), "the picker rests");
    assert_eq!(focused_kind(&m).as_deref(), Some("files"));
    assert_eq!(kinds(&m, "files").len(), 1, "opened once");
    // The next arrow reaches Files, not the picker.
    let before = m.picker().selected();
    key(&mut m, Key::Down, Mods::NONE);
    assert_eq!(m.picker().selected(), before);
    let _ = log;
}

#[test]
fn takes_chord_is_true_for_every_chord_the_picker_acts_on_and_false_for_option_letters() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "workbench.layouts");
    assert!(m.picker().holds_keys());
    for k in [
        Key::Esc,
        Key::Enter,
        Key::Down,
        Key::Up,
        Key::Left,
        Key::Right,
        Key::Backspace,
    ] {
        assert!(m.takes_chord(&KeyInput::new(k, Mods::NONE)), "{k:?}");
    }
    assert!(m.takes_chord(&KeyInput::new(Key::Char('a'), Mods::NONE)));
    for (c, why) in [('d', "delete"), ('r', "rename"), ('e', "files")] {
        assert!(
            m.takes_chord(&KeyInput::new(Key::Char(c), Mods::CTRL | Mods::ALT)),
            "{why}"
        );
    }
    // A chord that would open another document is the picker's to swallow.
    assert!(!m.takes_chord(&KeyInput::new(Key::Char('k'), Mods::CTRL | Mods::ALT)));
    // A letter with Option alone is a typed character, not a command.
    assert!(!m.takes_chord(&KeyInput::new(Key::Char('t'), Mods::ALT)));
    // And what takes_chord says, key() does: the model is untouched by asking.
    let before = m.document();
    let _ = m.takes_chord(&KeyInput::new(Key::Char('e'), Mods::CTRL | Mods::ALT));
    assert_eq!(m.document(), before);
}

#[test]
fn an_account_load_with_a_saved_layout_ends_with_the_keyboard_on_a_live_panel() {
    let (mut m, _) = new_model();
    action(&mut m, "theo.focus");
    action(&mut m, "files.focus");
    action(&mut m, "theo.focus");
    assert!(m.rest_picker_now());
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "ada".into(),
        }),
    );
    // Ada's record: the layout as it is now, with Files focused.
    action(&mut m, "files.focus");
    let ada = m.document();
    let record = |m: &mut Model, document: &Value| {
        let load = arrange(m, ArrangementMsg::Load);
        let current = serde_json::to_string(document).unwrap();
        send(
            m,
            loaded_from(load[0].id, LayoutSource::Account, 1, &current, "[]"),
        );
    };
    // Grace has none; the keyboard was in the picker.
    action(&mut m, "workbench.layouts");
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "grace".into(),
        }),
    );
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(
        &mut m,
        Msg::Completion(
            Completion::new(load[0].id, ResourceRef::None, Outcome::Accepted).with_payload(
                CompletionPayload::LayoutLoaded(LayoutLoaded {
                    source: LayoutSource::Account,
                    revision: Revision::Seq(0),
                    document: None,
                }),
            ),
        ),
    );
    // Back to Ada, with the picker holding the keys at the moment of the switch.
    action(&mut m, "workbench.layouts");
    assert!(m.picker().holds_keys());
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "ada".into(),
        }),
    );
    record(&mut m, &ada);
    assert!(!m.picker().holds_keys());
    assert_eq!(
        focused_kind(&m).as_deref(),
        Some("files"),
        "the layout's own focus"
    );
    // Arrows go to the panel; the chord for an open tool still works.
    let before = m.picker().selected();
    key(&mut m, Key::Down, Mods::NONE);
    assert_eq!(m.picker().selected(), before);
    key(&mut m, Key::Char('e'), Mods::CTRL | Mods::ALT);
    assert_eq!(focused_kind(&m).as_deref(), Some("files"));
}

#[test]
fn the_chord_printed_on_a_row_chooses_that_row_while_the_picker_holds_the_keys() {
    // The row, chosen by Enter.
    let (mut by_enter, _) = new_model();
    action(&mut by_enter, "picker.open");
    let titles = layout_rows(&by_enter);
    let at = titles.iter().position(|t| t == "New page").expect("row");
    select_row(&mut by_enter, at);
    let enter_fx = key(&mut by_enter, Key::Enter, Mods::NONE);

    // Its chord, with the picker holding the keys.
    let (mut by_chord, _) = new_model();
    action(&mut by_chord, "picker.open");
    assert!(by_chord.picker().holds_keys());
    let chord = KeyInput::new(Key::Char('n'), Mods::CTRL | Mods::ALT);
    assert!(by_chord.takes_chord(&chord));
    let chord_fx = key(&mut by_chord, Key::Char('n'), Mods::CTRL | Mods::ALT);

    assert_eq!(format!("{chord_fx:?}"), format!("{enter_fx:?}"));
    assert!(!by_chord.picker().holds_keys());
    assert_eq!(
        by_chord.document()["dock"]["groups"],
        by_enter.document()["dock"]["groups"],
        "the same panel opened in the same place"
    );
    assert_eq!(
        kinds(&by_chord, "page").len() + kinds(&by_chord, "picker").len(),
        kinds(&by_enter, "page").len() + kinds(&by_enter, "picker").len()
    );

    // A row under More tools, by its chord, from the main page.
    let (mut m, _) = new_model();
    action(&mut m, "picker.open");
    let layouts = KeyInput::new(Key::Char('w'), Mods::CTRL | Mods::ALT);
    assert!(m.takes_chord(&layouts));
    key(&mut m, Key::Char('w'), Mods::CTRL | Mods::ALT);
    assert_eq!(
        m.picker().page(),
        theorem_workbench_core::picker::Page::Layouts
    );
}

#[test]
fn a_chord_that_is_no_rows_action_is_swallowed_and_takes_chord_agrees() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    action(&mut m, "picker.open");
    let before = m.document();
    let chord = KeyInput::new(Key::Char('k'), Mods::CTRL | Mods::ALT);
    assert!(!m.takes_chord(&chord), "note.open is not a picker row");
    let fx = key(&mut m, Key::Char('k'), Mods::CTRL | Mods::ALT);
    assert!(fx.is_empty());
    assert!(m.picker().holds_keys());
    assert_eq!(kinds(&m, "note").len(), 1);
    assert_eq!(m.document(), before);
}

// ---- an arrangement keeps the appearance it was saved with --------------

const THEME: &str = r#"{"profile":"stone-dark","motion":"calm"}"#;

fn told(m: &mut Model, appearance: &str) {
    assert!(
        arrange(
            m,
            ArrangementMsg::Appearance {
                value: appearance.into()
            }
        )
        .is_empty()
    );
}

fn appearance_effect(effects: &[Effect]) -> Option<&str> {
    effects.iter().find_map(|e| match &e.body {
        EffectBody::AppearanceApply(a) => Some(a.appearance.as_str()),
        _ => None,
    })
}

fn answer(effect: EffectId, outcome: Outcome) -> Msg {
    Msg::Completion(Completion::new(effect, ResourceRef::None, outcome))
}

fn refused(reason: &str) -> Outcome {
    Outcome::Refused {
        code: "unknown_profile".into(),
        reason: reason.into(),
    }
}

/// A model that has read an empty account record, with `name` saved under
/// `appearance` (if any).
fn kept(name: &str, appearance: &str) -> Model {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(&mut m, loaded(load[0].id, 0, "", ""));
    told(&mut m, appearance);
    let fx = arrange(&mut m, ArrangementMsg::Save { name: name.into() });
    send(&mut m, saved(fx[0].id, 1));
    notices(&mut m);
    m
}

#[test]
fn a_save_keeps_the_appearance_the_host_told_and_a_save_without_one_keeps_none() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    told(&mut m, THEME);
    let fx = arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Dark".into(),
        },
    );
    let (_, named) = save_text(&fx);
    let value: Value = serde_json::from_str(&named).unwrap();
    assert_eq!(value["items"][0]["appearance"], THEME);
    assert!(value["items"][0]["document"].is_object());
    send(&mut m, saved(fx[0].id, 1));
    // Empty means none.
    told(&mut m, "");
    let fx = arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Plain".into(),
        },
    );
    let (_, named) = save_text(&fx);
    let value: Value = serde_json::from_str(&named).unwrap();
    assert_eq!(value["items"][0]["appearance"], THEME, "Dark is kept");
    assert!(value["items"][1].get("appearance").is_none());
}

#[test]
fn applying_a_saved_arrangement_sends_its_appearance_and_a_preset_sends_none() {
    let mut m = kept("Dark", THEME);
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Dark".into(),
        },
    );
    assert_eq!(appearance_effect(&fx), Some(THEME));
    assert_eq!(fx[0].kind(), EffectKind::AppearanceApply);
    assert_eq!(fx[0].owner(), theorem_workbench_core::Owner::Layout);
    send(&mut m, answer(fx[0].id, Outcome::Accepted));
    assert_eq!(
        arrangement_notices(&mut m),
        [ArrangementNotice::Applied {
            name: "Dark".into()
        }]
    );
    for preset in ["minimal", "Default", "editor"] {
        let fx = arrange(
            &mut m,
            ArrangementMsg::Apply {
                name: preset.into(),
            },
        );
        assert!(fx.is_empty(), "{preset} touches no appearance");
    }
    // An agent's apply is the same path: the same effect.
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "dark".into(),
        },
    );
    assert_eq!(appearance_effect(&fx), Some(THEME));
}

#[test]
fn a_refused_appearance_is_told_and_the_layout_stays_applied() {
    let mut m = kept("Dark", THEME);
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    let minimal = m.document();
    notices(&mut m);
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Dark".into(),
        },
    );
    let layout = m.document();
    assert_ne!(layout, minimal);
    send(
        &mut m,
        answer(fx[0].id, refused("this build has no stone-dark")),
    );
    assert_eq!(m.document(), layout, "the layout stays applied");
    let told = arrangement_notices(&mut m);
    assert_eq!(
        told.last(),
        Some(&ArrangementNotice::AppearanceNotApplied {
            name: "Dark".into(),
            reason: "this build has no stone-dark".into()
        })
    );
    let line = m.notice_line().unwrap();
    assert_eq!(
        line.severity,
        theorem_workbench_core::NoticeSeverity::Warning
    );
    assert!(
        line.text.contains("saved theme could not be"),
        "{}",
        line.text
    );
    assert!(line.text.contains("stone-dark"));
    // A failure is told the same way.
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Dark".into(),
        },
    );
    send(
        &mut m,
        answer(
            fx[0].id,
            Outcome::Failed {
                reason: "offline".into(),
            },
        ),
    );
    assert!(matches!(
        arrangement_notices(&mut m).last(),
        Some(ArrangementNotice::AppearanceNotApplied { .. })
    ));
}

#[test]
fn an_appearance_answer_after_another_apply_or_an_account_switch_is_dropped() {
    let mut m = kept("Dark", THEME);
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Dark".into(),
        },
    );
    arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "minimal".into(),
        },
    );
    notices(&mut m);
    send(&mut m, answer(fx[0].id, refused("late")));
    assert!(
        !arrangement_notices(&mut m)
            .iter()
            .any(|n| matches!(n, ArrangementNotice::AppearanceNotApplied { .. }))
    );
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Dark".into(),
        },
    );
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    notices(&mut m);
    send(&mut m, answer(fx[0].id, refused("late")));
    assert!(
        !arrangement_notices(&mut m)
            .iter()
            .any(|n| matches!(n, ArrangementNotice::AppearanceNotApplied { .. }))
    );
}

#[test]
fn an_item_without_an_appearance_round_trips_unchanged_and_an_unreadable_one_is_dropped() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let doc = m.document();
    let record = json!({
        "schema": "theorem.workbench.arrangements", "version": 1,
        "items": [
            {"name": "Old", "document": doc},
            {"name": "Odd", "document": doc, "appearance": 7}
        ]
    })
    .to_string();
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(&mut m, loaded(load[0].id, 3, "", &record));
    // Reading kept both layouts; applying either asks for no appearance.
    for name in ["Old", "Odd"] {
        let fx = arrange(&mut m, ArrangementMsg::Apply { name: name.into() });
        assert!(fx.is_empty(), "{name}");
    }
    // Saving another writes the old ones back without an appearance.
    let fx = arrange(&mut m, ArrangementMsg::Save { name: "New".into() });
    let (_, named) = save_text(&fx);
    let value: Value = serde_json::from_str(&named).unwrap();
    assert!(value["items"][0].get("appearance").is_none());
    assert!(value["items"][1].get("appearance").is_none());
    assert_eq!(value["items"][0]["document"], doc);
    assert_eq!(value["version"], 1);
}

#[test]
fn rename_keeps_the_appearance_and_delete_removes_it_with_the_item() {
    let mut m = kept("Dark", THEME);
    let fx = arrange(
        &mut m,
        ArrangementMsg::Rename {
            from: "Dark".into(),
            to: "Night".into(),
        },
    );
    let (_, named) = save_text(&fx);
    let value: Value = serde_json::from_str(&named).unwrap();
    assert_eq!(value["items"][0]["name"], "Night");
    assert_eq!(value["items"][0]["appearance"], THEME);
    send(&mut m, saved(fx[0].id, 2));
    let fx = arrange(
        &mut m,
        ArrangementMsg::Apply {
            name: "Night".into(),
        },
    );
    assert_eq!(appearance_effect(&fx), Some(THEME));
    send(&mut m, answer(fx[0].id, Outcome::Accepted));
    let fx = arrange(
        &mut m,
        ArrangementMsg::Delete {
            name: "Night".into(),
        },
    );
    let (_, named) = save_text(&fx);
    assert!(!named.contains("appearance") && !named.contains(THEME[2..8].trim()));
    send(&mut m, saved(fx[0].id, 3));
    assert!(
        arrange(
            &mut m,
            ArrangementMsg::Apply {
                name: "Night".into()
            }
        )
        .is_empty()
    );
}

#[test]
fn an_over_long_appearance_is_ignored_and_told_and_the_last_good_one_stays() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    told(&mut m, THEME);
    let big = "x".repeat(theorem_workbench_core::arrangement::APPEARANCE_MAX_BYTES + 1);
    assert!(arrange(&mut m, ArrangementMsg::Appearance { value: big }).is_empty());
    assert!(matches!(
        arrangement_notices(&mut m).last(),
        Some(ArrangementNotice::BadAppearance { .. })
    ));
    let fx = arrange(&mut m, ArrangementMsg::Save { name: "A".into() });
    let (_, named) = save_text(&fx);
    let value: Value = serde_json::from_str(&named).unwrap();
    assert_eq!(value["items"][0]["appearance"], THEME);
}

#[test]
fn the_told_appearance_is_the_hosts_and_survives_an_account_switch() {
    let mut m = kept("Dark", THEME);
    send(
        &mut m,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    let load = arrange(&mut m, ArrangementMsg::Load);
    send(&mut m, loaded(load[0].id, 0, "", ""));
    // Bob has none of Ada's arrangements, but the browser's theme is still on.
    assert!(
        arrange(
            &mut m,
            ArrangementMsg::Apply {
                name: "Dark".into()
            }
        )
        .is_empty()
    );
    let fx = arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Mine".into(),
        },
    );
    let (_, named) = save_text(&fx);
    let value: Value = serde_json::from_str(&named).unwrap();
    assert_eq!(value["items"][0]["appearance"], THEME);
}

#[test]
fn a_load_of_the_current_layout_never_changes_the_appearance() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let doc = m.document();
    let record = json!({
        "schema": "theorem.workbench.arrangements", "version": 1,
        "items": [{"name": "Dark", "document": doc, "appearance": THEME}]
    })
    .to_string();
    let load = arrange(&mut m, ArrangementMsg::Load);
    let fx = send(&mut m, loaded(load[0].id, 1, &doc.to_string(), &record));
    assert!(appearance_effect(&fx).is_none());
    assert!(!fx.iter().any(|e| e.kind() == EffectKind::AppearanceApply));
}

#[test]
fn the_layouts_page_marks_the_arrangements_that_carry_a_theme() {
    let mut m = kept("Dark", THEME);
    let fx = arrange(
        &mut m,
        ArrangementMsg::Save {
            name: "Plain".into(),
        },
    );
    told(&mut m, "");
    let _ = fx;
    action(&mut m, "workbench.layouts");
    let rows = m.picker().rows(m.registry(), m.capabilities(), m.pinned());
    let by = |t: &str| rows.iter().find(|r| r.title == t).unwrap();
    assert_eq!(by("Dark").shortcut.as_deref(), Some("theme"));
    // "Plain" was saved with the same theme still told; a preset never has one.
    assert_eq!(by("Minimal").shortcut, None);
    let tree = semantics(&m);
    let node = tree
        .nodes
        .iter()
        .find(|n| n.name == "Dark" && n.role == Role::MenuItem)
        .unwrap();
    assert_eq!(
        node.state.description.as_deref(),
        Some("Also applies its saved theme")
    );
    assert_eq!(node.shortcut, None);
    // Drawn in the row's hint cell, so it gives way first at a narrow width.
    let wide = Rect::new(0, 0, 100, 30);
    let mut buf = Buffer::empty(wide);
    view(&m, wide, &mut buf, &Theme::plain());
    let text: String = (0..30u16)
        .flat_map(|y| (0..100u16).map(move |x| (x, y)))
        .map(|(x, y)| buf[(x, y)].symbol().to_owned())
        .collect();
    assert!(text.contains("theme"), "wide");
}

// ---- a program's own status report (R32) -------------------------------

use theorem_workbench_core::host::{
    ProgramReport, ProgramState, ProgramStatus, TerminalSessionInfo,
};

fn status(state: ProgramState, msg: &str) -> ProgramStatus {
    ProgramStatus {
        state,
        raw_state: None,
        kind: Some("task".into()),
        msg: Some(msg.into()),
        app: Some("build".into()),
        title: Some(msg.into()),
        progress: Some(40),
    }
}

fn current(state: ProgramState, msg: &str, seq: Option<u64>) -> ProgramReport {
    ProgramReport::Current {
        status: status(state, msg),
        status_ms: Some(1_700_000_000_000),
        seq,
    }
}

fn report_msg(session: &str, epoch: u64, report: ProgramReport) -> Msg {
    Msg::Host(HostMessage::TerminalReport {
        resource: ResourceRef::Terminal {
            workspace: "w".into(),
            session: session.into(),
        },
        epoch,
        report,
    })
}

fn reports_sent(log: &Shared, kind: &str) -> Vec<ProgramReport> {
    msgs_of(log, kind)
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::TerminalReport(r) => Some(r),
            _ => None,
        })
        .collect()
}

#[test]
fn the_report_has_four_cases_on_the_wire_and_an_absent_one_reads_as_unavailable() {
    let cases = [
        (ProgramReport::Unavailable, json!({"kind": "unavailable"})),
        (
            ProgramReport::NeverReported,
            json!({"kind": "never_reported"}),
        ),
        (
            ProgramReport::Cleared {
                status_ms: Some(5),
                seq: Some(2),
            },
            json!({"kind": "cleared", "statusMs": 5, "seq": 2}),
        ),
        (
            current(ProgramState::Blocked, "waiting", Some(9)),
            json!({"kind": "current", "status": {"state": "blocked", "kind": "task",
                "msg": "waiting", "app": "build", "title": "waiting", "progress": 40},
                "statusMs": 1_700_000_000_000u64, "seq": 9}),
        ),
    ];
    for (report, wire) in cases {
        assert_eq!(serde_json::to_value(&report).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<ProgramReport>(wire).unwrap(),
            report
        );
    }
    // The order fields are optional on the wire.
    let bare: ProgramReport = serde_json::from_value(json!({"kind": "cleared"})).unwrap();
    assert_eq!(
        bare,
        ProgramReport::Cleared {
            status_ms: None,
            seq: None
        }
    );
    // A session an older host lists carries no report: it reads as unavailable,
    // and an unavailable one is not written back.
    let old: TerminalSessionInfo = serde_json::from_value(json!({
        "session": "s1", "profile": "Shell", "backend": "native", "workspace": "w"
    }))
    .unwrap();
    assert_eq!(old.program_report, ProgramReport::Unavailable);
    assert!(
        serde_json::to_value(&old)
            .unwrap()
            .get("programReport")
            .is_none()
    );
    let reported: TerminalSessionInfo = serde_json::from_value(json!({
        "session": "s1", "profile": "Shell", "backend": "native", "workspace": "w",
        "programReport": {"kind": "never_reported"}
    }))
    .unwrap();
    assert_eq!(reported.program_report, ProgramReport::NeverReported);
}

#[test]
fn a_report_reaches_the_pane_bound_to_its_terminal_at_its_epoch_and_no_other() {
    let (mut m, log) = term_model(2);
    action(&mut m, "note.open");
    let report = current(ProgramState::Working, "compiling", Some(1));

    assert!(send(&mut m, report_msg("s1", 2, report.clone())).is_empty());
    assert_eq!(reports_sent(&log, "term"), vec![report.clone()]);
    assert!(reports_sent(&log, "note").is_empty());

    // An older epoch and a newer one are not this binding's: dropped, counted.
    send(&mut m, report_msg("s1", 1, report.clone()));
    assert_eq!(m.counters().last_drop, Some(Stale::OlderEpoch));
    send(&mut m, report_msg("s1", 3, report.clone()));
    assert_eq!(m.counters().last_drop, Some(Stale::ResourceChanged));
    assert_eq!(reports_sent(&log, "term").len(), 1);

    // A terminal no panel is bound to: dropped, with no notice.
    let dropped = m.counters().dropped;
    send(&mut m, report_msg("elsewhere", 2, report));
    assert_eq!(m.counters().dropped, dropped + 1);
    assert_eq!(m.counters().last_drop, Some(Stale::NotBound));
    assert!(notices(&mut m).is_empty());
    assert_eq!(reports_sent(&log, "term").len(), 1);
}

#[test]
fn a_pane_bound_without_an_epoch_takes_a_report_for_any_epoch() {
    let (mut m, log) = term_model(0);
    send(&mut m, report_msg("s1", 7, ProgramReport::NeverReported));
    assert_eq!(reports_sent(&log, "term"), [ProgramReport::NeverReported]);
}

fn sessions_message(reports: &[(&str, ProgramReport)]) -> Msg {
    Msg::Host(HostMessage::TerminalSessions {
        workspace: "w".into(),
        profiles: vec![],
        sessions: reports
            .iter()
            .map(|(name, report)| TerminalSessionInfo {
                session: (*name).into(),
                profile: "Shell".into(),
                backend: theorem_workbench_core::effect::TerminalBackend::Native,
                workspace: "w".into(),
                host: None,
                program: Some(1),
                state: Default::default(),
                controlled_elsewhere: false,
                modes: None,
                program_report: report.clone(),
            })
            .collect(),
        adoption: None,
    })
}

fn listed_reports(log: &Shared) -> Vec<(String, ProgramReport)> {
    let last = msgs_of(log, "term")
        .into_iter()
        .rev()
        .find_map(|m| match m {
            PanelMsg::Host(HostMessage::TerminalSessions { sessions, .. }) => Some(sessions),
            _ => None,
        })
        .expect("the pane was handed a session list");
    last.into_iter()
        .map(|s| (s.session, s.program_report))
        .collect()
}

#[test]
fn the_session_list_a_chooser_reads_carries_the_latest_report_for_that_terminal() {
    let (mut m, log) = term_model(2);
    send(
        &mut m,
        Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: None,
        }),
    );
    send(
        &mut m,
        sessions_message(&[
            ("s1", ProgramReport::NeverReported),
            ("s2", ProgramReport::Unavailable),
        ]),
    );
    let first = current(ProgramState::Working, "one", Some(5));
    send(&mut m, report_msg("s1", 2, first.clone()));
    assert_eq!(
        listed_reports(&log),
        [
            ("s1".to_owned(), first.clone()),
            ("s2".to_owned(), ProgramReport::Unavailable)
        ]
    );

    // An update that is older by sequence does not replace what is held.
    let older = current(ProgramState::Idle, "older", Some(4));
    send(&mut m, report_msg("s1", 2, older));
    assert_eq!(listed_reports(&log)[0].1, first);

    // One with no sequence replaces; a terminal that is not listed changes nothing.
    send(
        &mut m,
        report_msg(
            "s1",
            2,
            ProgramReport::Cleared {
                status_ms: None,
                seq: None,
            },
        ),
    );
    assert_eq!(
        listed_reports(&log)[0].1,
        ProgramReport::Cleared {
            status_ms: None,
            seq: None
        }
    );
    send(&mut m, report_msg("nobody", 2, first));
    assert_eq!(listed_reports(&log).len(), 2);
}

#[derive(Debug, PartialEq)]
struct ModelState {
    document: Value,
    tree: String,
    focus: String,
    in_flight: usize,
    panels: Vec<(PanelInstanceId, bool)>,
    labels: Vec<String>,
    catalog: String,
}

fn model_state(m: &Model) -> ModelState {
    let mut panels: Vec<_> = m
        .panel_ids()
        .map(|(id, _)| (id.clone(), m.is_unavailable(id)))
        .collect();
    panels.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
    let labels = panels
        .iter()
        .map(|(id, _)| m.tab_label(id, "x").title)
        .collect();
    ModelState {
        document: m.document(),
        tree: serde_json::to_string(&semantics(m)).unwrap(),
        focus: format!("{:?}", m.focus()),
        in_flight: m.in_flight().len(),
        panels,
        labels,
        catalog: serde_json::to_string(&m.registry().agent_catalog(m.capabilities())).unwrap(),
    }
}

#[test]
fn a_report_of_any_state_or_text_changes_nothing_but_what_the_pane_stores() {
    let hostile: Vec<String> = vec![
        "note.open".into(),
        "approval.allow".into(),
        "term.end".into(),
        "\u{1b}[2J\u{1b}]0;pwned\u{7}\u{9b}31m".into(),
        "e\u{301}".repeat(2048),
        "x".repeat(4096),
        "ok\0\r\n".into(),
    ];
    for state in [
        ProgramState::Idle,
        ProgramState::Working,
        ProgramState::Done,
        ProgramState::Blocked,
        ProgramState::Error,
        ProgramState::Unknown,
    ] {
        for text in &hostile {
            let (mut m, log) = term_model(2);
            action(&mut m, "note.open");
            m.take_dirty();
            let _ = notices(&mut m);
            let before = model_state(&m);
            let panels_before = m.panel_ids().count();
            let dropped = m.counters().dropped;
            let mut report = current(state, text, Some(1));
            if let ProgramReport::Current { status, .. } = &mut report {
                status.raw_state = Some(text.clone());
                status.kind = Some(text.clone());
                status.app = Some(text.clone());
                status.title = Some(text.clone());
            }
            let fx = send(&mut m, report_msg("s1", 2, report.clone()));

            assert!(fx.is_empty(), "a report emits no effect");
            assert_eq!(model_state(&m), before, "{state:?} {text:?}");
            assert_eq!(m.panel_ids().count(), panels_before);
            assert_eq!(m.counters().dropped, dropped);
            assert!(notices(&mut m).is_empty(), "a report raises no notice");
            assert!(m.take_dirty(), "the pane shows it, so a frame is due");
            // The pane was handed the report and nothing was run for it.
            let sent: Vec<_> = msgs_of(&log, "term")
                .into_iter()
                .filter(|p| matches!(p, PanelMsg::TerminalReport(_) | PanelMsg::Action(_)))
                .collect();
            assert_eq!(sent, [PanelMsg::TerminalReport(report)]);
        }
    }
}

// ---- single-view tools focus the open one -------------------------------

#[test]
fn a_single_view_tool_focuses_the_open_one_and_opens_one_only_when_none_exists() {
    for (action, kind) in [
        ("changes.open", "changes"),
        ("cabinet.open", "cabinet"),
        ("diagnostics.open", "diagnostics"),
        ("run-output.open", "run-output"),
        ("search.open", "search"),
        ("history.open", "history"),
    ] {
        let (mut m, _) = new_model();
        action_ok(&mut m, action);
        assert_eq!(kinds(&m, kind).len(), 1, "{action} opens one");
        let first = kinds(&m, kind)[0].clone();
        // Focus moves elsewhere, then the same tool is asked for again.
        action_ok(&mut m, "note.open");
        assert_ne!(m.focus().panel.as_ref(), Some(&first));
        action_ok(&mut m, action);
        assert_eq!(
            kinds(&m, kind),
            std::slice::from_ref(&first),
            "{action} pressed twice"
        );
        assert_eq!(
            m.focus().panel.as_ref(),
            Some(&first),
            "{action} focuses it"
        );
        // A third press with it already focused changes nothing.
        action_ok(&mut m, action);
        assert_eq!(kinds(&m, kind).len(), 1);
    }
}

fn action_ok(m: &mut Model, id: &str) {
    assert!(action(m, id).is_empty());
    assert!(notices(m).is_empty(), "{id} was refused");
}

#[test]
fn the_picker_row_and_the_catalog_say_focus_for_the_single_view_tools_and_open_for_shell_and_page()
{
    let (m, _) = new_model();
    let caps = m.capabilities().clone();
    let catalog = m.registry().catalog(&caps);
    let intent = |id: &str| {
        catalog
            .iter()
            .find(|e| e.action.as_str() == id)
            .unwrap_or_else(|| panic!("{id} is listed"))
            .intent
    };
    use theorem_workbench_core::registry::ActionIntent;
    for id in [
        "changes.open",
        "cabinet.open",
        "diagnostics.open",
        "run-output.open",
        "search.open",
        "history.open",
        "files.focus",
        "theo.focus",
    ] {
        assert_eq!(intent(id), ActionIntent::Focus, "{id}");
    }
    for id in ["shell.choose", "page.new", "side-chat.choose"] {
        assert_eq!(intent(id), ActionIntent::Open, "{id}");
    }
    // What the picker says choosing the row does is what it does.
    use theorem_workbench_core::registry::Chooses;
    let rows = m.registry().picker_rows(&caps, m.pinned());
    let chooses = |id: &str| {
        rows.iter()
            .find(|r| r.action.as_str() == id)
            .map(|r| r.chooses.clone())
    };
    assert_eq!(chooses("changes.open"), Some(Chooses::Focuses));
    assert_eq!(chooses("files.focus"), Some(Chooses::Focuses));
    assert!(matches!(
        chooses("shell.choose"),
        Some(Chooses::Starts { .. })
    ));
    assert!(matches!(chooses("page.new"), Some(Chooses::Creates { .. })));
    let more = m.registry().more_tools(&caps, m.pinned());
    for id in [
        "cabinet.open",
        "diagnostics.open",
        "run-output.open",
        "search.open",
        "history.open",
    ] {
        let row = more.iter().find(|r| r.action.as_str() == id);
        assert_eq!(
            row.map(|r| r.chooses.clone()),
            Some(Chooses::Focuses),
            "{id}"
        );
    }
}

// ---- Add selection to chat: Ctx::refer -> PanelMsg::Reference ------------

fn new_model_with_theo() -> (Model, Shared) {
    let log: Shared = Rc::default();
    log.borrow_mut().with_theo = true;
    (model(&log), log)
}

fn references(log: &Shared, kind: &str) -> Vec<SourceReference> {
    msgs_of(log, kind)
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::Reference(r) => Some(r),
            _ => None,
        })
        .collect()
}

fn excerpts(refs: &[SourceReference]) -> Vec<String> {
    refs.iter().filter_map(|r| r.excerpt.clone()).collect()
}

fn in_workspace(m: &mut Model, workspace: &str) {
    send(
        m,
        Msg::Host(HostMessage::WorkspaceChanged {
            workspace: workspace.into(),
            environment: None,
        }),
    );
}

#[test]
fn a_reference_reaches_the_conversation_panel_in_order_and_emits_nothing() {
    let (mut m, log) = new_model_with_theo();
    in_workspace(&mut m, "w");
    action(&mut m, "theo.focus");
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    let theo = kinds(&m, "theo")[0].clone();
    action(&mut m, "note.focus");
    assert_eq!(m.focus().panel.as_ref(), Some(&note));
    let before = m.in_flight().len();
    let _ = notices(&mut m);

    assert!(ch(&mut m, 'Z').is_empty());
    assert!(ch(&mut m, 'Z').is_empty());
    assert_eq!(
        excerpts(&references(&log, "theo")),
        ["excerpt-0", "excerpt-1"]
    );
    assert_eq!(references(&log, "theo")[0].path, "a.md");
    // Nothing was sent, started or asked; the keyboard stayed with the note.
    assert_eq!(m.in_flight().len(), before);
    assert!(notices(&mut m).is_empty());
    assert_eq!(m.focus().panel.as_ref(), Some(&note));
    assert_eq!(kinds(&m, "theo"), [theo]);
    assert!(references(&log, "note").is_empty());
}

#[test]
fn a_reference_with_no_conversation_panel_opens_one_without_taking_the_keyboard() {
    let (mut m, log) = new_model_with_theo();
    in_workspace(&mut m, "w");
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    action(&mut m, "note.focus");
    assert!(kinds(&m, "theo").is_empty());

    assert!(ch(&mut m, 'Z').is_empty());
    assert_eq!(kinds(&m, "theo").len(), 1);
    assert_eq!(excerpts(&references(&log, "theo")), ["excerpt-0"]);
    assert_eq!(m.focus().panel.as_ref(), Some(&note));

    // The second goes to the one that is open, not another.
    ch(&mut m, 'Z');
    assert_eq!(kinds(&m, "theo").len(), 1);
    assert_eq!(
        excerpts(&references(&log, "theo")),
        ["excerpt-0", "excerpt-1"]
    );
}

#[test]
fn a_reference_goes_to_the_focused_conversation_panel_else_the_first() {
    let (mut a, _) = new_model_with_theo();
    action(&mut a, "theo.focus");
    action(&mut a, "note.open");
    let mut saved = a.document();
    // A second conversation panel beside the first, as a restored layout has.
    let group = saved["dock"]["groups"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|g| {
            g["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["kind"]["name"] == "theo")
        })
        .unwrap();
    let mut copy = group["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["kind"]["name"] == "theo")
        .unwrap()
        .clone();
    copy["panel"] = json!("p90");
    copy["view_state"] = json!({"doc": "second.md"});
    group["tabs"].as_array_mut().unwrap().push(copy);

    let (mut m, log) = new_model_with_theo();
    in_workspace(&mut m, "w");
    m.restore(saved).expect("the layout loads");
    let theos = kinds(&m, "theo");
    assert_eq!(theos.len(), 2);
    let (first, second) = (theos[0].clone(), theos[1].clone());
    let note = kinds(&m, "note")[0].clone();

    let ask = |m: &mut Model| {
        send(
            m,
            Msg::ActionOn {
                id: ActionId::new("note.find"),
                actor: Actor::Human,
                panel: note.clone(),
            },
        )
    };
    let received = |log: &Shared| log.borrow().theo_refs.clone();

    // The keyboard is on the note: the first conversation panel takes it.
    action(&mut m, "note.focus");
    ask(&mut m);
    assert_eq!(received(&log), ["a.md"]);
    assert_eq!(m.focus().panel.as_ref(), Some(&note));

    // With the second one focused, it is the one that receives it.
    send(&mut m, Msg::Dock(DockMsg::FocusPanel(second.clone())));
    assert_eq!(m.focus().panel.as_ref(), Some(&second));
    ask(&mut m);
    assert_eq!(received(&log), ["a.md", "second.md"]);
    assert_eq!(m.focus().panel.as_ref(), Some(&second));
    let _ = first;
}

#[test]
fn a_reference_never_crosses_into_another_workspaces_conversation() {
    let (mut m, log) = new_model_with_theo();
    log.borrow_mut().doc_ws = "other".into();
    in_workspace(&mut m, "w");
    action(&mut m, "theo.focus");
    action(&mut m, "note.open");
    action(&mut m, "note.focus");
    let dropped = m.counters().dropped;
    ch(&mut m, 'Z');
    assert!(references(&log, "theo").is_empty());
    assert_eq!(m.counters().dropped, dropped + 1);
    assert_eq!(m.counters().last_drop, Some(Stale::ResourceChanged));
    assert!(notices(&mut m).is_empty());
    // No panel was opened for it either.
    assert_eq!(kinds(&m, "theo").len(), 1);
}

#[test]
fn an_agents_action_may_add_a_reference_and_it_is_still_only_a_chip() {
    // The panel adds it whoever asked; the agent's own action path reaches the
    // same `Ctx::refer`, which has no actor check: it sends nothing.
    let (mut m, log) = new_model_with_theo();
    in_workspace(&mut m, "w");
    action(&mut m, "theo.focus");
    action(&mut m, "note.open");
    action(&mut m, "note.focus");
    let fx = send(
        &mut m,
        Msg::Action {
            id: ActionId::new("note.find"),
            actor: Actor::Agent {
                run_id: "run-1".into(),
            },
        },
    );
    assert!(fx.is_empty());
    assert!(notices(&mut m).is_empty());
    let got = references(&log, "theo");
    assert_eq!(excerpts(&got), ["found"]);
    assert_eq!(got[0].label.as_deref(), Some("asked"));
}

// ---- Follow the agent ----------------------------------------------------

fn followed(m: &mut Model, runs: &[&str]) {
    send(
        m,
        Msg::Host(HostMessage::FollowedRuns {
            runs: runs.iter().map(|r| r.to_string()).collect(),
        }),
    );
}

fn agent_edit(resource: &str, actor: &str, starts: &[u32]) -> Msg {
    use theorem_workbench_core::effect::{CoordinateUnit, TextChange};
    Msg::Host(HostMessage::DocumentChanged {
        resource: doc(resource),
        revision: Revision::Seq(9),
        actor: actor.into(),
        operation_id: None,
        unit: CoordinateUnit::Utf16,
        edits: starts
            .iter()
            .map(|s| TextChange {
                start: *s,
                end: *s,
                insert: "x".into(),
            })
            .collect(),
    })
}

fn reveals(log: &Shared) -> Vec<(u32, theorem_workbench_core::effect::CoordinateUnit)> {
    msgs_of(log, "note")
        .into_iter()
        .filter_map(|m| match m {
            PanelMsg::RevealOffset { start, unit } => Some((start, unit)),
            _ => None,
        })
        .collect()
}

/// A focused note on a.md, and an unfocused one on b.md.
fn two_notes() -> (Model, Shared, PanelInstanceId, PanelInstanceId) {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let other = kinds(&m, "note")[0].clone();
    ch(&mut m, 'r'); // this one now shows b.md
    action(&mut m, "note.open"); // a.md, with the keyboard
    let mine = kinds(&m, "note")
        .into_iter()
        .find(|id| *id != other)
        .unwrap();
    assert_eq!(m.focus().panel.as_ref(), Some(&mine));
    // Setting up moved the keyboard, which paused follow; start from on.
    assert!(!m.follow().on);
    action(&mut m, "follow.resume");
    (m, log, mine, other)
}

#[test]
fn a_followed_run_reveals_its_file_without_taking_the_keyboard() {
    let (mut m, log, mine, other) = two_notes();
    followed(&mut m, &["r1"]);
    assert_eq!(m.follow().runs, 1);
    let fx = send(&mut m, agent_edit("b.md", "theorem:run:r1", &[40, 7, 90]));
    assert!(fx.is_empty());
    // The smallest start, in the unit the edit gave.
    assert_eq!(
        reveals(&log),
        vec![(7, theorem_workbench_core::effect::CoordinateUnit::Utf16)]
    );
    assert_eq!(kinds(&m, "note").len(), 2, "the open panel is reused");
    assert_eq!(m.focus().panel.as_ref(), Some(&mine));
    assert_ne!(Some(&mine), Some(&other));
    assert!(m.follow().on);
}

#[test]
fn a_followed_file_with_no_panel_opens_one_unfocused_and_the_next_one_replaces_it() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let mine = kinds(&m, "note")[0].clone();
    action(&mut m, "follow.resume");
    followed(&mut m, &["r1"]);
    send(&mut m, agent_edit("b.md", "theorem:run:r1", &[3]));
    assert_eq!(kinds(&m, "note").len(), 2);
    assert_eq!(m.focus().panel.as_ref(), Some(&mine));
    assert_eq!(reveals(&log).len(), 1);
    send(&mut m, agent_edit("c.md", "theorem:run:r1", &[5]));
    assert_eq!(kinds(&m, "note").len(), 2, "one preview at a time");
    assert_eq!(m.focus().panel.as_ref(), Some(&mine));
    assert_eq!(reveals(&log).len(), 2);
}

#[test]
fn nothing_follows_a_foreign_actor_an_unfollowed_run_a_pause_or_no_runs() {
    let (mut m, log, mine, _) = two_notes();
    for actor in ["u", "theorem:run:r2", "theorem:runner:r1", "theorem:run:"] {
        followed(&mut m, &["r1"]);
        send(&mut m, agent_edit("b.md", actor, &[1]));
    }
    followed(&mut m, &[]);
    send(&mut m, agent_edit("b.md", "theorem:run:r1", &[1]));
    followed(&mut m, &["r1"]);
    action(&mut m, "follow.pause");
    assert!(!m.follow().on);
    send(&mut m, agent_edit("b.md", "theorem:run:r1", &[1]));
    assert!(reveals(&log).is_empty());
    assert_eq!(kinds(&m, "note").len(), 2);
    assert_eq!(m.focus().panel.as_ref(), Some(&mine));
    // An edit with no ranges names no position.
    action(&mut m, "follow.resume");
    send(&mut m, agent_edit("b.md", "theorem:run:r1", &[]));
    assert!(reveals(&log).is_empty());
}

#[test]
fn the_focused_panel_its_draft_and_its_caret_are_untouched() {
    let (mut m, log, mine, _) = two_notes();
    followed(&mut m, &["r1"]);
    let before = msgs_of(&log, "note").len();
    send(&mut m, agent_edit("a.md", "theorem:run:r1", &[2]));
    assert!(reveals(&log).is_empty(), "the person's panel is not moved");
    assert_eq!(m.focus().panel.as_ref(), Some(&mine));
    // It still hears the change like any bound panel.
    assert!(msgs_of(&log, "note").len() > before);
    assert!(m.follow().on);
}

#[test]
fn the_persons_own_navigation_pauses_follow_and_resume_turns_it_on() {
    let (mut m, log, _, other) = two_notes();
    followed(&mut m, &["r1"]);
    // Typing in the focused panel is not navigation.
    ch(&mut m, 'z');
    assert!(m.follow().on);
    // The person focusing another panel is.
    action(&mut m, "note.focus");
    assert!(m.follow().on, "focusing what already has the keyboard");
    action(&mut m, &format!("tab.focus.{}", other.as_str()));
    assert_eq!(m.focus().panel.as_ref(), Some(&other));
    assert!(!m.follow().on, "moving to another panel pauses follow");
    send(&mut m, agent_edit("b.md", "theorem:run:r1", &[1]));
    assert!(reveals(&log).is_empty());
    action(&mut m, "follow.resume");
    assert!(m.follow().on);
    send(&mut m, agent_edit("a.md", "theorem:run:r1", &[4]));
    assert_eq!(reveals(&log).len(), 1);
}

#[test]
fn an_agent_moving_the_keyboard_does_not_pause_follow() {
    let (mut m, _, _, other) = two_notes();
    send(
        &mut m,
        Msg::Action {
            id: ActionId::new(format!("tab.focus.{}", other.as_str())),
            actor: Actor::Agent {
                run_id: "r1".into(),
            },
        },
    );
    assert_eq!(m.focus().panel.as_ref(), Some(&other), "the agent moved it");
    assert!(m.follow().on);
}

#[test]
fn the_follow_status_is_in_the_semantics_with_both_actions() {
    let (mut m, _, _, _) = two_notes();
    followed(&mut m, &["r1", "r2"]);
    let text = format!("{:?}", semantics(&m));
    assert!(text.contains("Following 2 run"), "{text}");
    action(&mut m, "follow.pause");
    let text = format!("{:?}", semantics(&m));
    assert!(text.contains("Follow paused"), "{text}");
    assert!(text.contains("follow.resume"));
}

// ---- Document history and restore ---------------------------------------

#[test]
fn a_documents_history_is_listed_and_answered_through_the_documents_owner() {
    use theorem_workbench_core::completion::{DocumentHistory, DocumentHistoryEntry};
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let fx = action(&mut m, "note.history");
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].kind(), EffectKind::DocumentHistoryList);
    assert_eq!(fx[0].owner(), theorem_workbench_core::Owner::Documents);
    assert_eq!(fx[0].resource, doc("a.md"));
    let id = fx[0].id;
    let entries = vec![DocumentHistoryEntry {
        point: "h-2".into(),
        revision: Revision::Seq(4),
    }];
    send(
        &mut m,
        Msg::Completion(completion(id, "a.md", 5, Outcome::Accepted).with_payload(
            CompletionPayload::DocumentHistory(DocumentHistory { entries }),
        )),
    );
    let got = msgs_of(&log, "note").into_iter().any(|msg| {
        matches!(&msg, PanelMsg::Completion(c)
            if matches!(&c.payload, Some(CompletionPayload::DocumentHistory(h)) if h.entries.len() == 1))
    });
    assert!(got, "the panel was handed the entries");
    // An empty history is an answer too.
    let fx = action(&mut m, "note.history");
    send(
        &mut m,
        Msg::Completion(
            completion(fx[0].id, "a.md", 5, Outcome::Accepted).with_payload(
                CompletionPayload::DocumentHistory(DocumentHistory { entries: vec![] }),
            ),
        ),
    );
    assert_eq!(m.counters().applied, 2);
    assert_eq!(m.counters().dropped, 0);
}

#[test]
fn a_history_answer_for_an_older_revision_or_another_document_is_not_applied() {
    use theorem_workbench_core::completion::DocumentPreview;
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let fx = action(&mut m, "note.history");
    let id = fx[0].id;
    // Older than revision 5: dropped, like any document effect.
    send(
        &mut m,
        Msg::Completion(completion(id, "a.md", 3, Outcome::Accepted).with_payload(
            CompletionPayload::DocumentPreview(DocumentPreview { text: "old".into() }),
        )),
    );
    assert_eq!(m.counters().dropped, 1);
    assert_eq!(m.counters().applied, 0);
}

#[test]
fn a_restore_is_the_persons_to_make_and_an_agent_is_refused_at_the_emit() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    // The person's restore goes out.
    let fx = action(&mut m, "note.restore");
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].kind(), EffectKind::DocumentHistoryRestore);
    assert!(fx[0].actor.is_human());
    assert!(EffectKind::DocumentHistoryRestore.human_only());
    assert!(!EffectKind::DocumentHistoryList.human_only());
    assert!(!EffectKind::DocumentHistoryPreview.human_only());
    // An agent's action reaches the panel, and the emit is refused.
    let before = log.borrow().emits.len();
    let fx = send(
        &mut m,
        Msg::Action {
            id: ActionId::new("note.restore"),
            actor: Actor::Agent {
                run_id: "r1".into(),
            },
        },
    );
    assert!(fx.is_empty(), "nothing was sent for the agent");
    let emits = log.borrow().emits.clone();
    assert_eq!(
        emits[before..],
        [Err(theorem_workbench_core::EmitError::HumanOnly(
            EffectKind::DocumentHistoryRestore
        ))]
    );
    // Reading the history is not the person's alone.
    let fx = send(
        &mut m,
        Msg::Action {
            id: ActionId::new("note.history"),
            actor: Actor::Agent {
                run_id: "r1".into(),
            },
        },
    );
    assert_eq!(fx.len(), 1);
    assert_eq!(
        fx[0].actor,
        Actor::Agent {
            run_id: "r1".into()
        }
    );
}

// ---- Delegation before and after ----------------------------------------

#[test]
fn a_delegation_target_opens_a_readable_placeholder_while_no_panel_serves_it() {
    let (mut m, _) = new_model();
    action(&mut m, "note.open");
    let note = kinds(&m, "note")[0].clone();
    let fx = ch(&mut m, 'D');
    assert!(fx.is_empty());
    let panels = kinds(&m, "delegation");
    assert_eq!(panels.len(), 1, "named for what it stands in for");
    assert!(m.is_unavailable(&panels[0]));
    assert_ne!(m.focus().panel, Some(note.clone()));
    let tree = semantics(&m);
    let node = tree
        .nodes
        .iter()
        .find(|n| n.name.starts_with("delegation") && n.name.ends_with("is unavailable"))
        .expect("the placeholder is on the tree");
    assert_eq!(
        node.state.description.as_deref(),
        Some(
            "This build has no panel that can open the changes a delegation made to \"src/a.rs\"."
        )
    );
    // The same delegation file again is the same placeholder.
    m_focus(&mut m, &note);
    ch(&mut m, 'D');
    assert_eq!(kinds(&m, "delegation").len(), 1);
}

fn m_focus(m: &mut Model, panel: &PanelInstanceId) {
    action(m, &format!("tab.focus.{}", panel.as_str()));
}

#[test]
fn the_delegation_effects_belong_to_their_own_owner_and_answer_with_their_payloads() {
    use theorem_workbench_core::completion::{
        DelegationChange, DelegationChangeList, DelegationText,
    };
    use theorem_workbench_core::effect::{DelegationContentRead, DelegationRef, DelegationSide};
    let target = OpenTarget::Delegation {
        run_id: "run-1".into(),
        delegation_id: "d-1".into(),
        path: "src/a.rs".into(),
    };
    let whole = ResourceRef::Delegation {
        run_id: "run-1".into(),
        delegation_id: "d-1".into(),
        path: String::new(),
    };
    assert_eq!(
        target.resource(),
        ResourceRef::Delegation {
            run_id: "run-1".into(),
            delegation_id: "d-1".into(),
            path: "src/a.rs".into()
        }
    );
    assert_eq!(
        whole.kind(),
        theorem_workbench_core::ids::ResourceKind::Delegation
    );
    assert_eq!(whole.workspace(), None);
    for body in [
        EffectBody::DelegationChanges(DelegationRef {
            run_id: "run-1".into(),
            delegation_id: "d-1".into(),
        }),
        EffectBody::DelegationContent(DelegationContentRead {
            run_id: "run-1".into(),
            delegation_id: "d-1".into(),
            path: "src/a.rs".into(),
            side: DelegationSide::After,
        }),
    ] {
        let effect = Effect::new(EffectId(1), whole.clone(), body);
        assert_eq!(effect.owner(), theorem_workbench_core::Owner::Delegations);
    }
    let answer = CompletionPayload::DelegationChanges(DelegationChangeList {
        changes: vec![DelegationChange {
            path: "src/a.rs".into(),
            change: "modified".into(),
            binary: false,
            has_before: true,
            has_after: true,
        }],
    });
    let json = serde_json::to_value(&answer).unwrap();
    assert_eq!(json["type"], "delegationChanges");
    assert_eq!(json["changes"][0]["hasBefore"], true);
    let back: CompletionPayload = serde_json::from_value(json).unwrap();
    assert_eq!(back, answer);
    let text = CompletionPayload::DelegationText(DelegationText { text: "x".into() });
    assert_eq!(
        serde_json::to_value(&text).unwrap()["type"],
        "delegationText"
    );
}

// ---- Workspace replace: effects for a document the panel does not show ----

#[test]
fn a_panel_may_open_and_save_a_document_it_is_not_bound_to_and_hears_every_outcome() {
    let (mut m, log) = new_model();
    action(&mut m, "note.open"); // bound to a.md
    let note = kinds(&m, "note")[0].clone();
    let open = ch(&mut m, 'E');
    let save = ch(&mut m, 'F');
    assert_eq!((open.len(), save.len()), (1, 1));
    assert_eq!(open[0].resource, doc("other.md"));
    assert_eq!(open[0].kind(), EffectKind::DocumentOpen);
    assert!(log.borrow().emits.iter().all(|e| e.is_ok()));
    // An accepted answer reaches the panel as an answer, not as a cache entry.
    send(
        &mut m,
        Msg::Completion(completion(open[0].id, "other.md", 2, Outcome::Accepted)),
    );
    // A refusal (the conflict a replace must honour) is delivered too: it was
    // dropped as stale before, and the panel never learned of it.
    send(
        &mut m,
        Msg::Completion(completion(
            save[0].id,
            "other.md",
            2,
            Outcome::Refused {
                code: "conflict".into(),
                reason: "the file changed".into(),
            },
        )),
    );
    let answers: Vec<Outcome> = msgs_of(&log, "note")
        .into_iter()
        .filter_map(|msg| match msg {
            PanelMsg::Completion(c) => Some(c.outcome),
            _ => None,
        })
        .collect();
    assert_eq!(answers.len(), 2, "{answers:?}");
    assert!(matches!(&answers[1], Outcome::Refused { code, .. } if code == "conflict"));
    assert_eq!(m.counters().applied, 2);
    assert_eq!(m.counters().dropped, 0);
    assert_eq!(m.focus().panel, Some(note));
}

#[test]
fn an_answer_for_a_resource_the_panel_was_bound_to_is_still_only_cached() {
    // The panel's own document, asked about while it showed it: the old rule.
    let (mut m, log) = new_model();
    action(&mut m, "note.open");
    let fx = action(&mut m, "note.save");
    ch(&mut m, 'r'); // now bound to b.md; the save was for a.md
    send(
        &mut m,
        Msg::Completion(completion(fx[0].id, "a.md", 5, Outcome::Accepted)),
    );
    assert_eq!(m.counters().cached, 1);
    assert!(
        !msgs_of(&log, "note")
            .iter()
            .any(|msg| matches!(msg, PanelMsg::Completion(_)))
    );
}
