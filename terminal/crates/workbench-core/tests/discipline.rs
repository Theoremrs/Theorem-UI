//! AC-43, AC-44 and the core half of AC-42: the Elm discipline (a fixed script
//! replays the same, a view launches nothing, a late answer never overwrites
//! what a pane is bound to now), the semantic tree's ids and actions, and who
//! an action is for. Driven only through the public API.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::arrangement::ArrangementMsg;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, LayoutDocument, LayoutLoaded, LayoutSaved, LayoutSource, Outcome,
};
use theorem_workbench_core::effect::{
    ApprovalDecision, ConversationApproval, ConversationSend, ConversationSwitch, DocumentOpen,
    DocumentReconcile, Effect, EffectBody, EffectKind, FilesPath, ReconcileKeep, ScmDiff,
    TerminalAttach, TerminalBackend, TerminalOpen, TerminalRole,
};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{
    ActionId, Actor, EffectId, Generation, PanelInstanceId, PanelKind, ResourceKind, ResourceRef,
    Revision,
};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::panels::{ACTION_TAB_CLOSE, ACTION_TAB_FOCUS};
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent, BodyKind, Capabilities, CellSize, KeyScope, PanelDescriptor,
    Placement, Refusal,
};
use theorem_workbench_core::semantics::{Node, Role, SemanticTree};
use theorem_workbench_core::stale::{Binding, Stale};
use theorem_workbench_core::{
    Button, Ctx, DockMsg, Model, Msg, Notice, Panel, PanelFactories, PanelMsg, Pointer,
    PointerKind, Theme, ViewCtx, semantics, update, view,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

// ---- the rig ------------------------------------------------------------

#[derive(Default)]
struct Log {
    /// Bodies the probe emits, one per `f`.
    fire: VecDeque<EffectBody>,
    /// What the probe is bound to after each `b`: a resource and a generation.
    rebind: VecDeque<(ResourceRef, Option<u64>)>,
    /// Completions the root handed a probe as the answer to its effect.
    applied: Vec<EffectId>,
    /// Completions the root handed a probe only to cache.
    cached: Vec<EffectId>,
    /// Who each action the probes were sent was for.
    actions: Vec<(String, Actor)>,
    /// The outcome each applied completion carried.
    outcomes: Vec<Outcome>,
    /// Host messages the root handed a probe.
    hosts: Vec<HostMessage>,
    /// How many times a probe was drawn.
    views: u64,
    /// Every open-documents list a probe was told, with the panel told.
    documents: Vec<(
        PanelInstanceId,
        Vec<theorem_workbench_core::OpenDocumentState>,
    )>,
}

type Shared = Rc<RefCell<Log>>;

/// One test panel for every kind. `f` emits the next queued body against what
/// it is bound to, `b` rebinds it. What a completion delivered to it set is
/// `shown`: the thing a stale answer must not overwrite.
struct Probe {
    kind: &'static str,
    log: Shared,
    resource: ResourceRef,
    generation: Option<u64>,
    shown: Option<EffectId>,
    /// The tab says modified (a document probe).
    modified: bool,
    /// The revision the owner accepted for the probe's document.
    revision: Option<u64>,
}

fn default_resource(kind: &str) -> ResourceRef {
    match kind {
        "term" => ResourceRef::Terminal {
            workspace: "w".into(),
            session: "s1".into(),
        },
        "chat" | "theo" => ResourceRef::Conversation {
            project: "p".into(),
            thread: "t1".into(),
        },
        "dir" => ResourceRef::Directory {
            workspace: "w".into(),
            path: "src".into(),
        },
        "repo" => ResourceRef::Repository {
            workspace: "w".into(),
            repository: "r".into(),
        },
        _ => doc("a.md"),
    }
}

impl Panel for Probe {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        match msg {
            PanelMsg::Key(k) if k.key() == Key::Char('f') => {
                let Some(body) = self.log.borrow_mut().fire.pop_front() else {
                    return;
                };
                let (resource, generation) = (self.resource.clone(), self.generation);
                let _ = cx.emit(|id| {
                    let effect = Effect::new(id, resource, body);
                    match generation {
                        Some(g) => effect.with_generation(Generation(g)),
                        None => effect,
                    }
                });
            }
            PanelMsg::Key(k) if k.key() == Key::Char('M') => self.modified = !self.modified,
            PanelMsg::Key(k) if k.key() == Key::Char('R') => {
                self.revision = Some(self.revision.map_or(1, |r| r + 1));
            }
            PanelMsg::Documents(list) => {
                self.log
                    .borrow_mut()
                    .documents
                    .push((cx.panel().clone(), list));
            }
            PanelMsg::Key(k) if k.key() == Key::Char('b') => {
                if let Some((resource, generation)) = self.log.borrow_mut().rebind.pop_front() {
                    self.resource = resource;
                    self.generation = generation;
                }
            }
            PanelMsg::Completion(c) => {
                self.shown = Some(c.effect);
                self.log.borrow_mut().applied.push(c.effect);
                self.log.borrow_mut().outcomes.push(c.outcome);
            }
            PanelMsg::Host(h) => self.log.borrow_mut().hosts.push(h),
            PanelMsg::Cached(c) => self.log.borrow_mut().cached.push(c.effect),
            PanelMsg::Action(id) => {
                self.log
                    .borrow_mut()
                    .actions
                    .push((id.as_str().to_owned(), cx.actor().clone()));
                if id.as_str() == "doc.act" {
                    let resource = self.resource.clone();
                    let _ = cx.emit(|eid| Effect::new(eid, resource, EffectBody::DocumentSave));
                }
                if id.as_str().starts_with("approval.") {
                    let decision = if id.as_str() == "approval.allow" {
                        ApprovalDecision::Allow
                    } else {
                        ApprovalDecision::Deny
                    };
                    let resource = self.resource.clone();
                    let _ = cx.emit(|eid| {
                        Effect::new(
                            eid,
                            resource,
                            EffectBody::ConversationApproval(ConversationApproval {
                                run_id: "run".into(),
                                approval_id: "ap".into(),
                                decision,
                            }),
                        )
                    });
                }
            }
            _ => {}
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.log.borrow_mut().views += 1;
        buf.set_stringn(
            area.x,
            area.y,
            format!("{} {:?}", self.kind, self.shown),
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
        json!({"shown": self.shown.map(|e| e.0)})
    }

    fn tab_label(&self) -> Option<theorem_workbench_core::TabLabel> {
        (self.kind == "doc").then(|| theorem_workbench_core::TabLabel {
            title: "doc".to_owned(),
            modified: self.modified,
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource.clone(),
            revision: self.revision.map(Revision::Seq),
            generation: self.generation.map(Generation),
        })
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

fn registry() -> theorem_workbench_core::registry::Registry {
    let mut registry = builtin::registry();
    let kinds: [(&str, ResourceKind); 5] = [
        ("doc", ResourceKind::Document),
        ("term", ResourceKind::Terminal),
        ("chat", ResourceKind::Conversation),
        ("dir", ResourceKind::Directory),
        ("repo", ResourceKind::Repository),
    ];
    for (kind, binding) in kinds {
        let mut actions = vec![ActionDescriptor::new(
            format!("{kind}.open").as_str(),
            kind,
            ActionIntent::Open,
        )];
        match kind {
            "doc" => {
                actions.push(
                    ActionDescriptor::new("doc.focus", "Doc", ActionIntent::Focus)
                        .key("Mod+Alt+J", KeyScope::Global),
                );
                actions.push(
                    ActionDescriptor::new("doc.act", "Act", ActionIntent::Start)
                        .emits(EffectKind::DocumentSave)
                        .key("Mod+Alt+U", KeyScope::Global),
                );
            }
            "term" => actions.push(
                ActionDescriptor::new("term.focus", "Term", ActionIntent::Focus)
                    .key("Mod+Alt+K", KeyScope::Global),
            ),
            _ => {}
        }
        registry
            .register(descriptor(kind, binding, actions))
            .unwrap();
    }
    registry
}

fn model_with(log: &Shared) -> Model {
    let registry = registry();
    let mut factories = PanelFactories::new();
    // "theo" is the builtin conversation panel's kind: the probe stands in for
    // it so an approval can reach a panel when a person asks.
    for kind in ["doc", "term", "chat", "dir", "repo", "theo"] {
        let log = log.clone();
        factories.register(kind, move |state, _| {
            let shown = state["shown"].as_u64().map(EffectId);
            Box::new(Probe {
                kind,
                log: log.clone(),
                resource: default_resource(kind),
                generation: None,
                shown,
                modified: false,
                revision: None,
            })
        });
    }
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(registry, factories, keys, Capabilities::of(ALL_CAPS), dock);
    update(
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
    (model_with(&log), log)
}

fn action(m: &mut Model, id: &str) -> Vec<Effect> {
    update(
        m,
        Msg::Action {
            id: ActionId::new(id),
            actor: Actor::Human,
        },
    )
}

fn key(m: &mut Model, key: Key, mods: Mods) -> Vec<Effect> {
    update(m, Msg::Key(KeyInput::new(key, mods)))
}

fn ch(m: &mut Model, c: char) -> Vec<Effect> {
    key(m, Key::Char(c), Mods::NONE)
}

fn doc(path: &str) -> ResourceRef {
    ResourceRef::Document {
        workspace: "w".into(),
        resource_id: path.into(),
    }
}

fn panels_of(m: &Model, kind: &str) -> Vec<PanelInstanceId> {
    m.panel_ids()
        .filter(|(_, k)| k.as_str() == kind)
        .map(|(id, _)| id.clone())
        .collect()
}

fn drawn(m: &Model) -> Buffer {
    let full = Rect::new(0, 0, 200, 50);
    let mut buf = Buffer::empty(full);
    view(m, full, &mut buf, &Theme::plain());
    buf
}

fn notices(m: &mut Model) -> Vec<Notice> {
    std::iter::from_fn(|| m.take_notice()).collect()
}

fn answer(effect: EffectId, resource: ResourceRef, outcome: Outcome) -> Msg {
    Msg::Completion(Completion::new(effect, resource, outcome))
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
    Msg::Completion(
        Completion::new(effect, ResourceRef::None, Outcome::Accepted).with_payload(
            CompletionPayload::LayoutLoaded(LayoutLoaded {
                source: LayoutSource::Account,
                revision: Revision::Seq(revision),
                document: Some(LayoutDocument {
                    current: current.into(),
                    named_layouts: named.into(),
                }),
            }),
        ),
    )
}

// ---- AC-43 (a): a fixed script replays the same --------------------------

/// What a run of the script left for the host to see.
#[derive(Debug, PartialEq)]
struct Trace {
    /// Every effect `update` returned, in order.
    effects: Vec<Effect>,
    /// The drawn grid after each step.
    frames: Vec<Buffer>,
    /// The semantic tree after each step.
    trees: Vec<SemanticTree>,
    /// The layout document after each step.
    documents: Vec<Value>,
    /// Notices told, in order, by their words.
    notices: Vec<String>,
}

/// Run the script on a fresh model. Every step is a message the host or a
/// person could send; answers are built from the ids the run itself minted.
fn script() -> Trace {
    let (mut m, log) = new_model();
    let mut trace = Trace {
        effects: vec![],
        frames: vec![],
        trees: vec![],
        documents: vec![],
        notices: vec![],
    };
    let step = |m: &mut Model, trace: &mut Trace, msg: Msg| -> Vec<Effect> {
        let fx = update(m, msg);
        trace.effects.extend(fx.iter().cloned());
        trace.frames.push(drawn(m));
        trace.trees.push(semantics(m));
        trace.documents.push(m.document());
        for n in std::iter::from_fn(|| m.take_notice()) {
            trace.notices.push(format!("{n:?}"));
        }
        fx
    };
    let act = |id: &str| Msg::Action {
        id: ActionId::new(id),
        actor: Actor::Human,
    };
    let key = |c: char| Msg::Key(KeyInput::new(Key::Char(c), Mods::NONE));

    step(&mut m, &mut trace, act("doc.open"));
    step(&mut m, &mut trace, act("term.open"));
    step(&mut m, &mut trace, act("chat.open"));
    step(
        &mut m,
        &mut trace,
        Msg::Host(HostMessage::AccountChanged {
            account: "alice".into(),
        }),
    );
    step(
        &mut m,
        &mut trace,
        Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: None,
        }),
    );
    step(
        &mut m,
        &mut trace,
        Msg::Host(HostMessage::ThemeChanged {
            revision: 1,
            dark: true,
        }),
    );
    // Keys: focus the document by its chord, then have it start work.
    step(
        &mut m,
        &mut trace,
        Msg::Key(KeyInput::new(Key::Char('j'), Mods::CTRL | Mods::ALT)),
    );
    log.borrow_mut().fire.push_back(EffectBody::DocumentSave);
    let fx = step(&mut m, &mut trace, key('f'));
    let save = fx.last().expect("the probe emitted a save").id;
    // The answer to that save, then the same answer again (a duplicate).
    step(
        &mut m,
        &mut trace,
        answer(save, doc("a.md"), Outcome::Accepted),
    );
    step(
        &mut m,
        &mut trace,
        answer(save, doc("a.md"), Outcome::Accepted),
    );
    step(&mut m, &mut trace, Msg::Tick);
    // An arrangement: read the record, keep this layout, apply a preset, then
    // the kept one.
    let fx = step(&mut m, &mut trace, Msg::Arrangement(ArrangementMsg::Load));
    let load = fx.last().expect("a load").id;
    step(&mut m, &mut trace, loaded(load, 1, "", ""));
    let fx = step(
        &mut m,
        &mut trace,
        Msg::Arrangement(ArrangementMsg::Save {
            name: "Mine".into(),
        }),
    );
    let layout_save = fx.last().expect("a save").id;
    step(&mut m, &mut trace, saved(layout_save, 2));
    step(
        &mut m,
        &mut trace,
        Msg::Arrangement(ArrangementMsg::Apply {
            name: "minimal".into(),
        }),
    );
    step(
        &mut m,
        &mut trace,
        Msg::Arrangement(ArrangementMsg::Apply {
            name: "Mine".into(),
        }),
    );
    // Another save is in flight when the account changes under it.
    log.borrow_mut().fire.push_back(EffectBody::DocumentSave);
    let fx = step(&mut m, &mut trace, key('f'));
    let late = fx.last().map(|e| e.id);
    let fx = step(
        &mut m,
        &mut trace,
        Msg::Arrangement(ArrangementMsg::Save {
            name: "Late".into(),
        }),
    );
    let late_layout = fx.last().expect("a save").id;
    step(
        &mut m,
        &mut trace,
        Msg::Host(HostMessage::AccountChanged {
            account: "bob".into(),
        }),
    );
    if let Some(late) = late {
        step(
            &mut m,
            &mut trace,
            answer(late, doc("a.md"), Outcome::Accepted),
        );
    }
    step(&mut m, &mut trace, saved(late_layout, 9));
    step(&mut m, &mut trace, Msg::Tick);
    trace
}

#[test]
fn a_fixed_script_run_twice_gives_the_same_effects_frames_trees_and_documents() {
    let first = script();
    let second = script();
    // The script is not trivial: it reached the owners it names.
    let kinds: Vec<EffectKind> = first.effects.iter().map(Effect::kind).collect();
    for wanted in [
        EffectKind::DocumentSave,
        EffectKind::LayoutLoad,
        EffectKind::LayoutSave,
    ] {
        assert!(kinds.contains(&wanted), "{wanted:?} in {kinds:?}");
    }
    assert!(first.frames.len() > 20);
    assert!(
        first.frames.windows(2).any(|w| w[0] != w[1]),
        "the frames differ along the way, so equality is not vacuous"
    );
    assert!(
        !first.notices.is_empty(),
        "late answers and the account switch told something"
    );
    assert_eq!(first.effects, second.effects, "effect sequences");
    assert_eq!(first.frames, second.frames, "drawn buffers");
    assert_eq!(first.trees, second.trees, "semantic trees");
    assert_eq!(first.documents, second.documents, "layout documents");
    assert_eq!(first.notices, second.notices, "notices");
}

// ---- AC-43 (b): drawing launches nothing and changes nothing -------------

#[test]
fn drawing_and_reading_the_tree_over_and_over_emit_nothing_and_change_nothing() {
    // Two models take the same steps. One is drawn and read between every step
    // and many times at the end; the other never is.
    let steps = |m: &mut Model, log: &Shared, between: &mut dyn FnMut(&mut Model)| {
        let mut out: Vec<Effect> = vec![];
        for id in ["doc.open", "term.open", "chat.open"] {
            out.extend(action(m, id));
            between(m);
        }
        out.extend(key(m, Key::Char('j'), Mods::CTRL | Mods::ALT));
        log.borrow_mut().fire.push_back(EffectBody::DocumentSave);
        out.extend(ch(m, 'f'));
        between(m);
        let save = out.last().expect("a save").id;
        out.extend(update(m, answer(save, doc("a.md"), Outcome::Accepted)));
        out.extend(update(m, Msg::Tick));
        out
    };
    let (mut seen, seen_log) = new_model();
    let (mut unseen, unseen_log) = new_model();
    let mut redraw = |m: &mut Model| {
        for _ in 0..5 {
            drawn(m);
            semantics(m);
        }
    };
    let fx_seen = steps(&mut seen, &seen_log, &mut redraw);
    let fx_unseen = steps(&mut unseen, &unseen_log, &mut |_| {});
    assert!(!fx_seen.is_empty());
    assert_eq!(
        fx_seen, fx_unseen,
        "drawing between steps changed the effects"
    );

    let views_before = seen_log.borrow().views;
    let before = (
        seen.document(),
        seen.counters(),
        seen.in_flight().len(),
        semantics(&seen),
        drawn(&seen),
    );
    for _ in 0..50 {
        assert_eq!(drawn(&seen), before.4);
        assert_eq!(semantics(&seen), before.3);
    }
    assert!(
        seen_log.borrow().views >= views_before + 50,
        "the panels really were drawn each time"
    );
    assert_eq!(seen.document(), before.0);
    assert_eq!(seen.counters(), before.1);
    assert_eq!(seen.in_flight().len(), before.2);
    assert!(notices(&mut seen).is_empty());
    // And what happens next is what would have happened without the drawing.
    seen_log
        .borrow_mut()
        .fire
        .push_back(EffectBody::DocumentSave);
    unseen_log
        .borrow_mut()
        .fire
        .push_back(EffectBody::DocumentSave);
    assert_eq!(ch(&mut seen, 'f'), ch(&mut unseen, 'f'));
    assert_eq!(seen.document(), unseen.document());
}

#[test]
fn idle_ticks_launch_nothing() {
    let (mut m, _) = new_model();
    for id in ["doc.open", "term.open", "chat.open"] {
        action(&mut m, id);
    }
    let before = (m.document(), m.counters(), m.in_flight().len());
    for _ in 0..20 {
        assert!(update(&mut m, Msg::Tick).is_empty());
    }
    assert_eq!((m.document(), m.counters(), m.in_flight().len()), before);
}

// ---- AC-43 (c): a late answer never overwrites the new binding -----------

/// One effect that binds a pane to something, with the panel kind that asks
/// for it.
struct Case {
    kind: &'static str,
    body: EffectBody,
    /// What the pane is bound to after the rebind.
    next: ResourceRef,
}

fn cases() -> Vec<Case> {
    let term = |s: &str| ResourceRef::Terminal {
        workspace: "w".into(),
        session: s.into(),
    };
    let chat = |t: &str| ResourceRef::Conversation {
        project: "p".into(),
        thread: t.into(),
    };
    vec![
        Case {
            kind: "doc",
            body: EffectBody::DocumentOpen(DocumentOpen { seed_text: None }),
            next: doc("b.md"),
        },
        Case {
            kind: "doc",
            body: EffectBody::DocumentSave,
            next: doc("b.md"),
        },
        Case {
            kind: "doc",
            body: EffectBody::DocumentClose,
            next: doc("b.md"),
        },
        Case {
            kind: "doc",
            body: EffectBody::DocumentRevert,
            next: doc("b.md"),
        },
        Case {
            kind: "doc",
            body: EffectBody::DocumentReconcile(DocumentReconcile {
                keep: ReconcileKeep::Disk,
            }),
            next: doc("b.md"),
        },
        Case {
            kind: "term",
            body: EffectBody::TerminalOpen(TerminalOpen {
                backend: TerminalBackend::Native,
                argv: None,
                name: None,
                cols: 80,
                rows: 24,
                attachment: None,
            }),
            next: term("s2"),
        },
        Case {
            kind: "term",
            body: EffectBody::TerminalAttach(TerminalAttach {
                from_offset: 0,
                role: TerminalRole::Controller,
                attachment: "a1".into(),
            }),
            next: term("s2"),
        },
        Case {
            kind: "term",
            body: EffectBody::TerminalEnd,
            next: term("s2"),
        },
        Case {
            kind: "chat",
            body: EffectBody::ConversationSwitch(ConversationSwitch {
                thread_id: "t2".into(),
            }),
            next: chat("t2"),
        },
        Case {
            kind: "chat",
            body: EffectBody::ConversationSend(ConversationSend {
                client_message_id: "m1".into(),
                text: "hi".into(),
                attachments: vec![],
                references: vec![],
            }),
            next: chat("t2"),
        },
        Case {
            kind: "chat",
            body: EffectBody::ConversationCancel(
                theorem_workbench_core::effect::ConversationCancel { run_id: None },
            ),
            next: chat("t2"),
        },
        Case {
            kind: "dir",
            body: EffectBody::FilesList(FilesPath { path: "src".into() }),
            next: ResourceRef::Directory {
                workspace: "w".into(),
                path: "docs".into(),
            },
        },
        Case {
            kind: "repo",
            body: EffectBody::ScmStatus,
            next: ResourceRef::Repository {
                workspace: "w".into(),
                repository: "other".into(),
            },
        },
        Case {
            kind: "repo",
            body: EffectBody::ScmDiff(ScmDiff {
                path: None,
                staged: false,
            }),
            next: ResourceRef::Repository {
                workspace: "w".into(),
                repository: "other".into(),
            },
        },
    ]
}

/// A model with one open `kind` panel that has emitted `body` against what it
/// is bound to, and the id of that effect.
fn in_flight_case(case: &Case, generation: Option<u64>) -> (Model, Shared, EffectId, ResourceRef) {
    in_flight_case_for(case, generation, None)
}

/// As [`in_flight_case`], with the host having named `account` first.
fn in_flight_case_for(
    case: &Case,
    generation: Option<u64>,
    account: Option<&str>,
) -> (Model, Shared, EffectId, ResourceRef) {
    let (mut m, log) = new_model();
    if let Some(account) = account {
        m_account(&mut m, account);
    }
    action(&mut m, &format!("{}.open", case.kind));
    let bound = default_resource(case.kind);
    if generation.is_some() {
        log.borrow_mut()
            .rebind
            .push_back((bound.clone(), generation));
        ch(&mut m, 'b');
    }
    log.borrow_mut().fire.push_back(case.body.clone());
    let fx = ch(&mut m, 'f');
    assert_eq!(
        fx.len(),
        1,
        "{:?} emitted one effect",
        EffectKind::from(&case.body)
    );
    assert_eq!(fx[0].resource, bound);
    assert_eq!(fx[0].kind(), EffectKind::from(&case.body));
    assert!(m.in_flight().is_pending(fx[0].id));
    (m, log, fx[0].id, bound)
}

fn shown_of(m: &Model, kind: &str) -> Value {
    let id = panels_of(m, kind).remove(0);
    m.panel(&id).expect("the panel").serialize()
}

#[test]
fn an_answer_for_what_a_pane_was_bound_to_is_cached_never_applied_for_every_binding_effect() {
    for case in cases() {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case(&case, None);
        // The pane moves on before the answer comes.
        log.borrow_mut().rebind.push_back((case.next.clone(), None));
        ch(&mut m, 'b');
        let before = (m.document(), shown_of(&m, case.kind));
        let fx = update(&mut m, answer(effect, old, Outcome::Accepted));
        assert!(fx.is_empty(), "{label}");
        assert_eq!(m.counters().applied, 0, "{label}");
        assert_eq!(m.counters().cached, 1, "{label}");
        assert!(log.borrow().applied.is_empty(), "{label}: not applied");
        assert_eq!(log.borrow().cached, vec![effect], "{label}");
        assert_eq!(
            (m.document(), shown_of(&m, case.kind)),
            before,
            "{label}: the new binding is untouched"
        );
        assert!(m.in_flight().is_empty(), "{label}");
    }
}

#[test]
fn a_failed_answer_for_what_a_pane_was_bound_to_is_dropped_for_every_binding_effect() {
    for case in cases() {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case(&case, None);
        log.borrow_mut().rebind.push_back((case.next.clone(), None));
        ch(&mut m, 'b');
        let before = m.document();
        update(
            &mut m,
            answer(
                effect,
                old,
                Outcome::Failed {
                    reason: "no".into(),
                },
            ),
        );
        assert_eq!(m.counters().dropped, 1, "{label}");
        assert_eq!(m.counters().last_drop, Some(Stale::NotBound), "{label}");
        assert!(log.borrow().applied.is_empty() && log.borrow().cached.is_empty());
        assert_eq!(m.document(), before, "{label}");
    }
}

#[test]
fn an_answer_that_names_another_resource_than_its_effect_is_dropped() {
    for case in cases() {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, _) = in_flight_case(&case, None);
        let before = m.document();
        update(&mut m, answer(effect, case.next.clone(), Outcome::Accepted));
        assert_eq!(
            m.counters().last_drop,
            Some(Stale::ResourceChanged),
            "{label}"
        );
        assert!(log.borrow().applied.is_empty() && log.borrow().cached.is_empty());
        assert_eq!(m.document(), before, "{label}");
        assert!(m.in_flight().is_empty(), "{label}");
    }
}

#[test]
fn an_answer_for_an_older_generation_of_the_same_binding_is_dropped() {
    // A terminal rebinds at a new epoch of the same session; the answer to what
    // the old epoch asked for must not reach it.
    for case in cases().into_iter().filter(|c| c.kind == "term") {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case(&case, Some(1));
        log.borrow_mut().rebind.push_back((old.clone(), Some(2)));
        ch(&mut m, 'b');
        let before = m.document();
        update(
            &mut m,
            Msg::Completion(
                Completion::new(effect, old, Outcome::Accepted).with_generation(Generation(1)),
            ),
        );
        assert_eq!(
            m.counters().last_drop,
            Some(Stale::OlderGeneration),
            "{label}"
        );
        assert!(log.borrow().applied.is_empty() && log.borrow().cached.is_empty());
        assert_eq!(m.document(), before, "{label}");
    }
}

#[test]
fn an_answer_that_leaves_out_its_generation_is_still_judged_by_the_effects() {
    // The host is meant to echo the generation, but a reply that forgets it
    // must not pass for the current binding's.
    for case in cases().into_iter().filter(|c| c.kind == "term") {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case(&case, Some(1));
        log.borrow_mut().rebind.push_back((old.clone(), Some(2)));
        ch(&mut m, 'b');
        update(&mut m, answer(effect, old, Outcome::Accepted));
        assert_eq!(
            m.counters().last_drop,
            Some(Stale::OlderGeneration),
            "{label}"
        );
        assert!(log.borrow().applied.is_empty(), "{label}");
    }
}

#[test]
fn an_answer_that_matches_the_current_binding_is_applied() {
    // The control for the tests above: the same rig applies a good answer, so
    // "not applied" there is the gate's doing and not a broken probe.
    for case in cases() {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case(&case, None);
        update(&mut m, answer(effect, old, Outcome::Accepted));
        assert_eq!(m.counters().applied, 1, "{label}");
        assert_eq!(log.borrow().applied, vec![effect], "{label}");
        assert_eq!(shown_of(&m, case.kind)["shown"], json!(effect.0), "{label}");
    }
}

#[test]
fn an_answer_for_a_view_that_was_closed_is_dropped_and_a_closed_view_is_not_reopened() {
    for case in cases() {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case(&case, None);
        let panel = panels_of(&m, case.kind).remove(0);
        update(&mut m, Msg::Dock(DockMsg::ClosePanel(panel)));
        let panels = panels_of(&m, case.kind).len();
        update(&mut m, answer(effect, old, Outcome::Accepted));
        assert!(log.borrow().applied.is_empty(), "{label}");
        assert_eq!(m.counters().applied, 0, "{label}");
        assert_eq!(panels_of(&m, case.kind).len(), panels, "{label}");
        assert!(m.in_flight().is_empty(), "{label}");
    }
}

#[test]
fn an_answer_after_an_account_switch_is_dropped_and_the_pane_was_told_unknown() {
    // Panels bound to a conversation stay open through a switch; what they were
    // waiting for is told as unknown and the real answer, late, is not theirs.
    for case in cases().into_iter().filter(|c| c.kind == "chat") {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case_for(&case, None, Some("alice"));
        m_account(&mut m, "bob");
        assert!(m.in_flight().is_empty(), "{label}");
        assert_eq!(log.borrow().applied, vec![effect], "{label}: told once");
        assert!(matches!(
            log.borrow().outcomes.as_slice(),
            [Outcome::Uncertain { .. }]
        ));
        let dropped = m.counters().dropped;
        update(&mut m, answer(effect, old, Outcome::Accepted));
        assert_eq!(m.counters().dropped, dropped + 1, "{label}");
        assert_eq!(
            m.counters().last_drop,
            Some(Stale::UnknownEffect),
            "{label}"
        );
        assert_eq!(log.borrow().applied, vec![effect], "{label}: still once");
    }
    // Panels bound to the old account's documents and terminals are closed with
    // it, so nothing of theirs can be answered into the new account.
    for case in cases()
        .into_iter()
        .filter(|c| c.kind == "doc" || c.kind == "term")
    {
        let label = format!("{:?}", EffectKind::from(&case.body));
        let (mut m, log, effect, old) = in_flight_case_for(&case, None, Some("alice"));
        m_account(&mut m, "bob");
        assert!(panels_of(&m, case.kind).is_empty(), "{label}");
        update(&mut m, answer(effect, old, Outcome::Accepted));
        assert_eq!(m.counters().applied, 0, "{label}");
        assert!(log.borrow().applied.is_empty(), "{label}");
        assert_eq!(
            m.counters().last_drop,
            Some(Stale::UnknownEffect),
            "{label}"
        );
    }
}

#[test]
fn a_layout_load_answered_after_an_account_switch_does_not_reach_the_new_account() {
    let (mut m, _) = new_model();
    action(&mut m, "doc.open");
    m_account(&mut m, "alice");
    let load = update(&mut m, Msg::Arrangement(ArrangementMsg::Load));
    let old_load = load.last().expect("a load").id;
    m_account(&mut m, "bob");
    let load = update(&mut m, Msg::Arrangement(ArrangementMsg::Load));
    let new_load = load.last().expect("a load").id;
    assert_ne!(old_load, new_load);

    let secret = json!({
        "schema": "theorem.workbench.arrangements", "version": 1,
        "items": [{"name": "AliceOnly", "document": m.document()}]
    })
    .to_string();
    let before = m.document();
    update(&mut m, loaded(old_load, 7, "", &secret));
    assert_eq!(m.counters().last_drop, Some(Stale::UnknownEffect));
    assert!(
        m.arrangements().iter().all(|a| a.name != "AliceOnly"),
        "the old account's layouts did not arrive"
    );
    assert_eq!(m.document(), before);
    // The new account's own answer still lands, and a save based on it is based
    // on its revision.
    update(&mut m, loaded(new_load, 3, "", ""));
    let fx = update(
        &mut m,
        Msg::Arrangement(ArrangementMsg::Save { name: "Bob".into() }),
    );
    assert_eq!(
        fx.last().and_then(|e| e.revision.clone()),
        Some(Revision::Seq(3))
    );
}

fn m_account(m: &mut Model, account: &str) {
    update(
        m,
        Msg::Host(HostMessage::AccountChanged {
            account: account.into(),
        }),
    );
}

#[test]
fn a_layout_save_or_appearance_answer_that_nobody_is_waiting_for_changes_nothing() {
    let (mut m, _) = new_model();
    action(&mut m, "doc.open");
    let before = (m.document(), m.arrangements().len());
    update(&mut m, saved(EffectId(404), 5));
    update(
        &mut m,
        answer(EffectId(405), ResourceRef::None, Outcome::Accepted),
    );
    assert_eq!(m.counters().last_drop, Some(Stale::UnknownEffect));
    assert_eq!(m.counters().applied, 0);
    assert_eq!((m.document(), m.arrangements().len()), before);
    // A save with no base is still based on nothing.
    let fx = update(
        &mut m,
        Msg::Arrangement(ArrangementMsg::Save { name: "X".into() }),
    );
    assert_eq!(fx.last().and_then(|e| e.revision.clone()), None);
}

// ---- AC-44: ids and actions ------------------------------------------------

fn node<'a>(tree: &'a SemanticTree, id: &str) -> &'a Node {
    tree.nodes
        .iter()
        .find(|n| n.id.as_str() == id)
        .unwrap_or_else(|| panic!("no node {id} among {:?}", ids(tree)))
}

fn ids(tree: &SemanticTree) -> Vec<String> {
    tree.nodes
        .iter()
        .map(|n| n.id.as_str().to_owned())
        .collect()
}

/// A model showing everything the core itself draws: tabs and groups, the
/// picker, a placeholder for a kind nothing serves, and a notice.
fn core_owned() -> (Model, Shared) {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    // A layout that names a kind this build does not serve.
    let mut document = m.document();
    let tabs = document["dock"]["groups"]
        .as_object_mut()
        .expect("groups")
        .values_mut()
        .find_map(|g| g["tabs"].as_array_mut().filter(|t| !t.is_empty()))
        .expect("a group with a tab");
    let mut stranger = tabs[0].clone();
    stranger["panel"] = json!("stranger-1");
    stranger["kind"]["name"] = json!("not-built-yet");
    tabs.push(stranger);
    m.restore(document).expect("a layout with a stranger");
    action(&mut m, "picker.open");
    // A refusal puts a notice on the row.
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("approval.allow"),
            actor: Actor::Agent {
                run_id: "r1".into(),
            },
        },
    );
    (m, log)
}

/// Bring the placeholder's tab forward by the tab's own semantic action.
fn show_stranger(m: &mut Model) {
    update(
        m,
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_FOCUS}stranger-1")),
            actor: Actor::Human,
        },
    );
}

#[test]
fn every_surface_the_core_owns_is_in_the_tree_with_an_id_and_the_actions_it_allows() {
    let (m, _) = core_owned();
    let tree = semantics(&m);
    tree.validate().expect("one valid tree");

    // Layout chrome: each tab can be shown or closed, and says so by id.
    let tabs: Vec<&Node> = tree.nodes.iter().filter(|n| n.role == Role::Tab).collect();
    assert!(tabs.len() >= 3, "a page, the picker and the placeholder");
    for tab in &tabs {
        let panel = tab.id.as_str().strip_prefix("tab:").expect("tab:<panel>");
        let offered: Vec<&str> = tab.actions.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            offered,
            vec![
                format!("{ACTION_TAB_FOCUS}{panel}"),
                format!("{ACTION_TAB_CLOSE}{panel}")
            ],
            "{}",
            tab.id.as_str()
        );
        assert!(tab.actions.iter().all(|a| a.enabled && a.reason.is_none()));
    }
    // Groups and the strips have ids and no actions of their own; splitters
    // are named separators.
    assert!(tree.nodes.iter().any(|n| n.role == Role::Group));
    assert!(tree.nodes.iter().any(|n| n.role == Role::TabList));
    assert!(tree.nodes.iter().any(|n| n.role == Role::Separator));

    // The picker: its menu, filter and every row with the action it runs.
    let picker = panels_of(&m, "picker").remove(0);
    let root = node(&tree, &format!("{}/picker", picker.as_str()));
    assert_eq!(root.role, Role::Menu);
    let rows: Vec<&Node> = tree
        .nodes
        .iter()
        .filter(|n| n.role == Role::MenuItem)
        .collect();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| !r.actions.is_empty()));
    assert!(
        rows.iter().any(|r| !r.state.disabled),
        "an available row is offered as enabled"
    );

    // The placeholder's tab is disabled, and once it is shown its body is
    // named, disabled, gives the reason and offers no action.
    assert!(node(&tree, "tab:stranger-1").state.disabled);
    let mut shown = m;
    show_stranger(&mut shown);
    let tree = semantics(&shown);
    let stranger = node(&tree, "stranger-1/unavailable");
    assert_eq!(stranger.role, Role::Status);
    assert!(stranger.state.disabled);
    assert!(stranger.state.description.is_some());
    assert!(stranger.actions.is_empty());

    // The notice: a status by a fixed id that names who was refused.
    let notice = node(&tree, "notice");
    assert_eq!(notice.role, Role::Status);
    assert!(notice.name.contains("approval.allow"), "{}", notice.name);
    assert!(notice.name.contains("r1"), "{}", notice.name);
    assert!(notice.actions.is_empty());
}

#[test]
fn the_ids_are_the_same_across_renders_and_across_a_layout_restore() {
    let (m, _) = core_owned();
    let first = semantics(&m);
    let second = semantics(&m);
    assert_eq!(first, second, "two renders of one model");

    // The layout comes back in a fresh model built the same way.
    let document = m.document();
    let (mut again, _) = new_model();
    again.restore(document).expect("restore");
    // The picker is a modal layer the document does not keep; open it again.
    action(&mut again, "picker.open");
    update(
        &mut again,
        Msg::Action {
            id: ActionId::new("approval.allow"),
            actor: Actor::Agent {
                run_id: "r1".into(),
            },
        },
    );
    let restored_with_picker = semantics(&again);
    show_stranger(&mut again);
    let restored = semantics(&again);
    restored.validate().expect("valid");
    let tab_ids = |t: &SemanticTree| -> Vec<String> {
        ids(t)
            .into_iter()
            .filter(|id| {
                id.starts_with("tab:") || id.starts_with("group:") || id.starts_with("tabs:")
            })
            .collect()
    };
    let mut before = tab_ids(&first);
    let mut after = tab_ids(&restored_with_picker);
    before.sort();
    after.sort();
    assert_eq!(before, after, "tabs, strips and groups keep their ids");
    assert!(
        ids(&restored).contains(&"stranger-1/unavailable".to_owned()),
        "the placeholder keeps its id"
    );
    assert!(ids(&restored_with_picker).contains(&"notice".to_owned()));
    let actions = |t: &SemanticTree, id: &str| -> Vec<String> {
        node(t, id)
            .actions
            .iter()
            .map(|a| a.id.as_str().to_owned())
            .collect()
    };
    for id in before.iter().filter(|id| id.starts_with("tab:")) {
        assert_eq!(
            actions(&first, id),
            actions(&restored_with_picker, id),
            "{id}"
        );
    }
}

fn tab_center(m: &Model, panel: &PanelInstanceId) -> (u16, u16) {
    let tree = semantics(m);
    let n = node(&tree, &format!("tab:{}", panel.as_str()));
    (n.rect.x + 1, n.rect.y)
}

fn click(m: &mut Model, x: u16, y: u16) -> Vec<Effect> {
    let mut fx = vec![];
    for kind in [
        PointerKind::Down(Button::Left),
        PointerKind::Up(Button::Left),
    ] {
        fx.extend(update(
            m,
            Msg::Pointer(Pointer {
                kind,
                x,
                y,
                mods: Mods::NONE,
                clicks: 1,
            }),
        ));
    }
    fx
}

/// Everything a person or an agent could look at afterwards.
fn state_of(m: &mut Model) -> (Value, SemanticTree, Buffer, Vec<String>) {
    let notices = notices(m).iter().map(|n| format!("{n:?}")).collect();
    (m.document(), semantics(m), drawn(m), notices)
}

#[test]
fn an_agent_revealing_a_panel_ends_where_the_persons_key_or_click_does() {
    let setup = || {
        let (mut m, log) = new_model();
        action(&mut m, "doc.open");
        action(&mut m, "term.open");
        action(&mut m, "chat.open");
        (m, log)
    };
    let agent = Actor::Agent {
        run_id: "r1".into(),
    };

    // The person: a key chord reaches the document.
    let (mut by_key, _) = setup();
    let key_fx = key(&mut by_key, Key::Char('j'), Mods::CTRL | Mods::ALT);
    // The agent asks for the same registered action.
    let (mut by_agent, _) = setup();
    let agent_fx = update(
        &mut by_agent,
        Msg::Action {
            id: ActionId::new("doc.focus"),
            actor: agent.clone(),
        },
    );
    // The agent names the panel too.
    let (mut by_agent_on, _) = setup();
    let doc_panel = panels_of(&by_agent_on, "doc").remove(0);
    let on_fx = update(
        &mut by_agent_on,
        Msg::ActionOn {
            id: ActionId::new("doc.focus"),
            actor: agent.clone(),
            panel: doc_panel,
        },
    );
    assert!(key_fx.is_empty() && agent_fx.is_empty() && on_fx.is_empty());
    let focused_kind = |m: &Model| {
        let id = m.focus().panel.clone().expect("a panel has the keyboard");
        m.panel_ids()
            .find(|(p, _)| **p == id)
            .map(|(_, k)| k.as_str().to_owned())
    };
    assert_eq!(focused_kind(&by_key).as_deref(), Some("doc"));
    let want = state_of(&mut by_key);
    assert_eq!(state_of(&mut by_agent), want, "the action by an agent");
    assert_eq!(
        state_of(&mut by_agent_on),
        want,
        "the action naming the panel"
    );

    // The same through the tree: the tab's own focus action against a click.
    let (mut clicked, _) = setup();
    let (mut by_node, _) = setup();
    let target = panels_of(&clicked, "doc").remove(0);
    let (x, y) = tab_center(&clicked, &target);
    click(&mut clicked, x, y);
    let node_fx = update(
        &mut by_node,
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_FOCUS}{}", target.as_str())),
            actor: agent,
        },
    );
    assert!(node_fx.is_empty());
    assert_eq!(state_of(&mut by_node), state_of(&mut clicked));
}

#[test]
fn closing_a_view_by_its_tab_action_is_the_dock_close_and_emits_no_destroy() {
    let (mut m, _) = new_model();
    action(&mut m, "term.open");
    let (mut by_dock, _) = new_model();
    action(&mut by_dock, "term.open");
    let panel = panels_of(&m, "term").remove(0);
    let fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_CLOSE}{}", panel.as_str())),
            actor: Actor::Agent {
                run_id: "r1".into(),
            },
        },
    );
    let twin = panels_of(&by_dock, "term").remove(0);
    let want = update(&mut by_dock, Msg::Dock(DockMsg::ClosePanel(twin)));
    assert_eq!(fx, want);
    assert!(panels_of(&m, "term").is_empty());
    assert_eq!(state_of(&mut m), state_of(&mut by_dock));

    // A tab that is not there is refused in words and changes nothing.
    let before = m.document();
    let fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_FOCUS}gone")),
            actor: Actor::Human,
        },
    );
    assert!(fx.is_empty());
    assert!(matches!(
        m.take_notice(),
        Some(Notice::Refused(Refusal::UnknownPanel(_)))
    ));
    assert_eq!(m.document(), before);
}

#[test]
fn a_model_origin_approval_is_refused_naming_the_actor_and_nothing_changes() {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    action(&mut m, "theo.focus");
    assert_eq!(panels_of(&m, "theo").len(), 1);
    let before = (m.document(), m.counters(), m.in_flight().len());
    for id in ["approval.allow", "approval.deny"] {
        let who = Actor::Agent {
            run_id: "run-7".into(),
        };
        let fx = update(
            &mut m,
            Msg::Action {
                id: ActionId::new(id),
                actor: who.clone(),
            },
        );
        assert!(fx.is_empty(), "{id}");
        let told = m.take_notice();
        assert_eq!(
            told,
            Some(Notice::Refused(Refusal::HumanOnly {
                action: ActionId::new(id),
                actor: who,
            })),
            "{id}: the refusal keeps who asked"
        );
        // The same refusal when it names the panel.
        let theo = panels_of(&m, "theo").remove(0);
        let fx = update(
            &mut m,
            Msg::ActionOn {
                id: ActionId::new(id),
                actor: Actor::Agent {
                    run_id: "run-7".into(),
                },
                panel: theo,
            },
        );
        assert!(fx.is_empty(), "{id}");
        assert!(matches!(
            m.take_notice(),
            Some(Notice::Refused(Refusal::HumanOnly { .. }))
        ));
    }
    assert!(log.borrow().actions.is_empty(), "no panel was asked");
    assert_eq!((m.document(), m.counters(), m.in_flight().len()), before);

    // The words say who: the notice row names the run.
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("approval.allow"),
            actor: Actor::Agent {
                run_id: "run-7".into(),
            },
        },
    );
    let tree = semantics(&m);
    assert!(node(&tree, "notice").name.contains("run-7"));
    assert!(node(&tree, "notice").name.contains("approval.allow"));
}

#[test]
fn a_persons_approval_reaches_the_panel_as_the_person_and_an_agents_ordinary_action_as_the_agent() {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    action(&mut m, "theo.focus");
    let fx = action(&mut m, "approval.allow");
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].kind(), EffectKind::ConversationApproval);
    assert_eq!(
        log.borrow().actions.last(),
        Some(&("approval.allow".to_owned(), Actor::Human))
    );

    // An action an agent may take reaches the panel with the agent's identity,
    // and the person's chord for the same action with the person's.
    let run = Actor::Agent {
        run_id: "r9".into(),
    };
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("doc.act"),
            actor: run.clone(),
        },
    );
    key(&mut m, Key::Char('u'), Mods::CTRL | Mods::ALT);
    let doc_panel = panels_of(&m, "doc").remove(0);
    update(
        &mut m,
        Msg::ActionOn {
            id: ActionId::new("doc.act"),
            actor: run.clone(),
            panel: doc_panel,
        },
    );
    let got: Vec<(String, Actor)> = log
        .borrow()
        .actions
        .iter()
        .filter(|(id, _)| id == "doc.act")
        .cloned()
        .collect();
    assert_eq!(
        got,
        vec![
            ("doc.act".to_owned(), run.clone()),
            ("doc.act".to_owned(), Actor::Human),
            ("doc.act".to_owned(), run),
        ]
    );
    // Typing into a panel is the person's, not the last agent's.
    ch(&mut m, 'z');
    assert_eq!(log.borrow().actions.len(), 4);
}

#[test]
fn the_agents_catalog_lists_no_human_only_action_and_every_listed_action_resolves_for_it() {
    let (m, _) = new_model();
    let agent = Actor::Agent { run_id: "r".into() };
    let catalog = m.registry().agent_catalog(m.capabilities());
    assert!(!catalog.is_empty());
    for entry in &catalog {
        assert!(
            !entry.action.as_str().starts_with("approval."),
            "{}",
            entry.action.as_str()
        );
        let resolved = m
            .registry()
            .resolve(&entry.action, &agent, m.capabilities());
        assert!(
            !matches!(resolved, Err(Refusal::HumanOnly { .. })),
            "{}",
            entry.action.as_str()
        );
    }
    let human_only: Vec<&ActionDescriptor> = m
        .registry()
        .panels()
        .iter()
        .flat_map(|p| &p.actions)
        .filter(|a| a.human_only)
        .collect();
    assert!(human_only.len() >= 2, "approve and deny at least");
    for a in human_only {
        let refused = m.registry().resolve(&a.id, &agent, m.capabilities()).err();
        assert_eq!(
            refused,
            Some(Refusal::HumanOnly {
                action: a.id.clone(),
                actor: agent.clone(),
            })
        );
    }
}

// ---- AC-42, core half ------------------------------------------------------
//
// The core carries no program status of its own: a program's report reaches a
// panel as a host message (`terminalExited`) or a run list the panel shows. What
// the root owes is that it passes the report on as reported, decides nothing
// from it, and lets nothing printed or reported reach an approval.

fn term_resource() -> ResourceRef {
    default_resource("term")
}

#[test]
fn a_programs_exit_report_reaches_its_pane_as_reported_and_decides_nothing() {
    let (mut m, log) = new_model();
    action(&mut m, "term.open");
    action(&mut m, "theo.focus");
    let before = (m.document(), m.counters(), m.in_flight().len());
    // No exit code, a reason word the core does not know, and a clean exit.
    let reports = [
        (None, "lost"),
        (None, "reported-by-nobody"),
        (Some(0), "exited"),
        (Some(1), "killed"),
    ];
    for (exit_code, reason) in reports {
        let message = HostMessage::TerminalExited {
            resource: term_resource(),
            epoch: 0,
            exit_code,
            reason: reason.into(),
        };
        let fx = update(&mut m, Msg::Host(message.clone()));
        assert!(fx.is_empty(), "{reason}");
        assert_eq!(
            log.borrow().hosts.last(),
            Some(&message),
            "{reason}: as sent"
        );
    }
    // Nothing was approved, started or told as refused.
    assert!(log.borrow().actions.is_empty());
    assert_eq!((m.counters().applied, m.in_flight().len()), (0, 0));
    assert!(
        notices(&mut m)
            .iter()
            .all(|n| !matches!(n, Notice::Refused(_)))
    );
    assert_eq!(m.document(), before.0, "no layout change");
    // A report for a session no pane is bound to reaches no pane.
    let seen = log.borrow().hosts.len();
    update(
        &mut m,
        Msg::Host(HostMessage::TerminalExited {
            resource: ResourceRef::Terminal {
                workspace: "w".into(),
                session: "other".into(),
            },
            epoch: 0,
            exit_code: Some(0),
            reason: "exited".into(),
        }),
    );
    assert_eq!(log.borrow().hosts.len(), seen);
}

#[test]
fn an_unknown_answer_to_an_approval_reaches_the_pane_as_unknown_never_as_approved() {
    let (mut m, log) = new_model();
    action(&mut m, "theo.focus");
    let fx = action(&mut m, "approval.allow");
    let effect = fx.last().expect("the person's approval").id;
    let resource = fx[0].resource.clone();
    update(
        &mut m,
        answer(
            effect,
            resource,
            Outcome::Uncertain {
                reason: "no reply".into(),
            },
        ),
    );
    assert_eq!(
        log.borrow().outcomes,
        vec![Outcome::Uncertain {
            reason: "no reply".into()
        }]
    );
    assert_eq!(m.counters().applied, 1);
    // The core did not turn it into an accepted answer, a retry or a new
    // approval of its own.
    assert!(m.in_flight().is_empty());
    assert_eq!(
        log.borrow().actions.len(),
        1,
        "only the person's own action"
    );
    assert!(update(&mut m, Msg::Tick).is_empty());
}

#[test]
fn text_a_program_prints_is_never_run_as_an_action_or_an_approval() {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    action(&mut m, "term.open");
    action(&mut m, "theo.focus");
    let before = (m.document(), m.counters(), m.in_flight().len());
    // Output that looks like workbench actions, approvals and escape commands.
    let printed = "approval.allow\nworkbench.layout.minimal\r\n\u{1b}]777;approval.allow\u{7}";
    update(&mut m, Msg::Text(printed.into()));
    update(&mut m, Msg::Paste(printed.into()));
    {
        use base64::Engine as _;
        update(
            &mut m,
            Msg::Host(HostMessage::TerminalOutput {
                resource: term_resource(),
                epoch: 0,
                offset: 0,
                data: base64::engine::general_purpose::STANDARD.encode(printed),
            }),
        );
    }
    assert!(update(&mut m, Msg::Tick).is_empty());
    assert!(
        log.borrow().actions.is_empty(),
        "printed text was not run as an action"
    );
    assert_eq!((m.document(), m.counters(), m.in_flight().len()), before);
    assert!(notices(&mut m).is_empty());
}

#[test]
fn a_run_report_with_nothing_in_it_stays_empty_on_the_wire() {
    use theorem_workbench_core::results::RunSummary;
    // Only the handle and a state word: no exit code, no start time, no name.
    let report: RunSummary =
        serde_json::from_value(json!({"handle": "h", "state": "unknown"})).unwrap();
    assert_eq!(report.exit_code, None);
    assert_eq!(report.state, "unknown");
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        json!({"handle": "h", "state": "unknown"}),
        "nothing was filled in on the way through"
    );
}

// ---- who an effect is for (R34, R42) ----------------------------------------

fn agent(run: &str) -> Actor {
    Actor::Agent {
        run_id: run.to_owned(),
    }
}

fn act_as(m: &mut Model, id: &str, who: Actor) -> Vec<Effect> {
    update(
        m,
        Msg::Action {
            id: ActionId::new(id),
            actor: who,
        },
    )
}

#[test]
fn an_effect_says_who_it_is_for_the_person_or_the_agent_run_that_asked() {
    let (mut m, _) = new_model();
    action(&mut m, "doc.open");
    action(&mut m, "theo.focus");

    let fx = act_as(&mut m, "doc.act", agent("r1"));
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].kind(), EffectKind::DocumentSave);
    assert_eq!(fx[0].actor, agent("r1"));

    let doc_panel = panels_of(&m, "doc").remove(0);
    let fx = update(
        &mut m,
        Msg::ActionOn {
            id: ActionId::new("doc.act"),
            actor: agent("r2"),
            panel: doc_panel,
        },
    );
    assert_eq!(fx[0].actor, agent("r2"), "a targeted action is stamped too");

    // The person's chord for the same action, and the person's approval.
    let fx = key(&mut m, Key::Char('u'), Mods::CTRL | Mods::ALT);
    assert_eq!(fx.len(), 1);
    assert_eq!(fx[0].actor, Actor::Human);
    let fx = action(&mut m, "approval.allow");
    assert_eq!(fx[0].actor, Actor::Human);

    // On the wire: the person is left out, an agent run is named, and a
    // payload that never had the field reads as the person.
    let human = serde_json::to_value(&fx[0]).unwrap();
    assert!(human.get("actor").is_none(), "{human}");
    let agent_fx = act_as(&mut m, "doc.act", agent("r1"));
    let wire = serde_json::to_value(&agent_fx[0]).unwrap();
    assert_eq!(wire["actor"], json!({"type": "agent", "runId": "r1"}));
    let back: Effect = serde_json::from_value(wire).unwrap();
    assert_eq!(back, agent_fx[0]);
    let old: Effect = serde_json::from_value(human).unwrap();
    assert_eq!(old.actor, Actor::Human);
}

#[test]
fn a_key_after_an_agents_action_is_stamped_for_the_person() {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    act_as(&mut m, "doc.act", agent("r1"));
    log.borrow_mut().fire.push_back(EffectBody::ClipboardRead);
    let fx = key(&mut m, Key::Char('f'), Mods::NONE);
    assert_eq!(fx[0].actor, Actor::Human);
}

#[test]
fn an_agents_human_only_request_emits_nothing_and_the_actor_is_restored_after_every_refusal() {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    action(&mut m, "theo.focus");

    let asks = [
        Msg::Action {
            id: ActionId::new("approval.allow"),
            actor: agent("r1"),
        },
        Msg::Action {
            id: ActionId::new("no.such.action"),
            actor: agent("r1"),
        },
        Msg::ActionOn {
            id: ActionId::new("doc.act"),
            actor: agent("r1"),
            panel: PanelInstanceId::new("no-such-panel"),
        },
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_CLOSE}no-such-panel")),
            actor: agent("r1"),
        },
    ];
    for ask in asks {
        let before = (m.document(), m.in_flight().len());
        let fx = update(&mut m, ask.clone());
        assert!(fx.is_empty(), "{ask:?}");
        assert_eq!((m.document(), m.in_flight().len()), before, "{ask:?}");
        // The next thing the person does is the person's, every time.
        log.borrow_mut().fire.push_back(EffectBody::ClipboardRead);
        action(&mut m, "doc.focus");
        let fx = key(&mut m, Key::Char('f'), Mods::NONE);
        assert_eq!(fx.len(), 1, "{ask:?}");
        assert_eq!(fx[0].actor, Actor::Human, "{ask:?}");
    }

    // After an agent action that worked, the same.
    act_as(&mut m, "doc.act", agent("r1"));
    log.borrow_mut().fire.push_back(EffectBody::ClipboardRead);
    let fx = key(&mut m, Key::Char('f'), Mods::NONE);
    assert_eq!(fx[0].actor, Actor::Human);
}

// ---- which open documents hold a draft, told to repository panels ----------

use theorem_workbench_core::OpenDocumentState;

fn told_to_repos(log: &Shared) -> Vec<Vec<OpenDocumentState>> {
    log.borrow()
        .documents
        .iter()
        .map(|(_, l)| l.clone())
        .collect()
}

fn entry(path: &str, saved: Option<u64>, unsaved: bool) -> OpenDocumentState {
    OpenDocumentState {
        path: path.to_owned(),
        saved_revision: saved,
        unsaved,
    }
}

fn focus_panel(m: &mut Model, id: &PanelInstanceId) {
    update(
        m,
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_FOCUS}{}", id.as_str())),
            actor: Actor::Human,
        },
    );
}

#[test]
fn a_repository_panel_is_told_the_open_documents_on_each_change_and_only_then() {
    let (mut m, log) = new_model();
    action(&mut m, "repo.open");
    assert!(
        told_to_repos(&log).is_empty(),
        "nothing open, nothing to say"
    );

    action(&mut m, "doc.open");
    let doc_panel = panels_of(&m, "doc").remove(0);
    assert_eq!(told_to_repos(&log), vec![vec![entry("a.md", None, false)]]);

    // Quiet frames, ticks, draws and unrelated keys tell nothing.
    for _ in 0..5 {
        update(&mut m, Msg::Tick);
        drawn(&m);
        semantics(&m);
    }
    assert_eq!(told_to_repos(&log).len(), 1);

    // An edit that first makes the document modified.
    focus_panel(&mut m, &doc_panel);
    ch(&mut m, 'M');
    assert_eq!(told_to_repos(&log).len(), 2);
    assert_eq!(told_to_repos(&log)[1], vec![entry("a.md", None, true)]);
    // A second edit that changes nothing in the list.
    ch(&mut m, 'x');
    assert_eq!(told_to_repos(&log).len(), 2);

    // A save answer: the owner accepted revision 1 and the draft is gone.
    ch(&mut m, 'R');
    ch(&mut m, 'M');
    let told = told_to_repos(&log);
    assert_eq!(told.last().unwrap(), &vec![entry("a.md", Some(1), false)]);
    assert_eq!(told.len(), 4, "one message per change: {told:?}");

    // The view moves to another path.
    log.borrow_mut().rebind.push_back((doc("b.md"), None));
    ch(&mut m, 'b');
    assert_eq!(
        told_to_repos(&log).last().unwrap(),
        &vec![entry("b.md", Some(1), false)]
    );

    // It closes.
    let before = told_to_repos(&log).len();
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new(format!("{ACTION_TAB_CLOSE}{}", doc_panel.as_str())),
            actor: Actor::Human,
        },
    );
    let told = told_to_repos(&log);
    assert_eq!(told.len(), before + 1);
    assert!(told.last().unwrap().is_empty());
}

#[test]
fn a_repository_panel_opened_after_the_documents_is_told_at_once() {
    let (mut m, log) = new_model();
    action(&mut m, "doc.open");
    let doc_panel = panels_of(&m, "doc").remove(0);
    focus_panel(&mut m, &doc_panel);
    ch(&mut m, 'M');
    assert!(told_to_repos(&log).is_empty());
    action(&mut m, "repo.open");
    assert_eq!(told_to_repos(&log), vec![vec![entry("a.md", None, true)]]);
}

#[test]
fn the_list_is_scoped_to_the_repository_panels_workspace() {
    let (mut m, log) = new_model();
    action(&mut m, "repo.open");
    action(&mut m, "doc.open");
    let elsewhere = ResourceRef::Document {
        workspace: "other".into(),
        resource_id: "z.md".into(),
    };
    log.borrow_mut().rebind.push_back((elsewhere, None));
    ch(&mut m, 'b');
    // The only document is in another workspace: this repository hears it is gone.
    assert!(told_to_repos(&log).last().unwrap().is_empty());
    action(&mut m, "doc.open");
    assert_eq!(
        told_to_repos(&log).last().unwrap(),
        &vec![entry("a.md", None, false)],
        "z.md of the other workspace is not in the list"
    );
}

#[test]
fn two_editors_on_one_path_make_one_entry_that_agrees_with_both() {
    let (mut m, log) = new_model();
    action(&mut m, "repo.open");
    action(&mut m, "doc.open");
    ch(&mut m, 'M');
    ch(&mut m, 'R');
    ch(&mut m, 'R');
    action(&mut m, "doc.open");
    ch(&mut m, 'R');
    ch(&mut m, 'R');
    ch(&mut m, 'R');
    let told = told_to_repos(&log);
    assert_eq!(
        told.last().unwrap(),
        &vec![entry("a.md", Some(3), true)],
        "unsaved if either is, the newest accepted revision"
    );
    for list in &told {
        assert!(list.len() <= 1, "one entry per path: {list:?}");
    }
}

#[test]
fn a_workspace_or_account_switch_that_changes_nothing_in_the_list_tells_nothing() {
    let (mut m, log) = new_model();
    action(&mut m, "repo.open");
    action(&mut m, "doc.open");
    ch(&mut m, 'M');
    let before = told_to_repos(&log).len();
    update(
        &mut m,
        Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: Some("e".into()),
        }),
    );
    update(&mut m, Msg::Tick);
    assert_eq!(told_to_repos(&log).len(), before, "same list, no message");
}
