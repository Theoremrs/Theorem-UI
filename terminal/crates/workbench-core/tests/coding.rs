//! The coding actions an agent uses to hand work to a coding agent:
//! `code.start`, `code.send` and `code.stop`, with their arguments, driven
//! through the public API the wasm host uses.

use std::cell::RefCell;
use std::rc::Rc;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::Value;
use theorem_workbench_core::agent::{AgentOutcome, RefusalCode, agent_outcome, agent_request};
use theorem_workbench_core::builtin;
use theorem_workbench_core::effect::{ConversationSend, Effect, EffectBody};
use theorem_workbench_core::ids::{ActionId, Actor, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::{
    Ctx, Model, Msg, Panel, PanelFactories, PanelMsg, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

/// What each test panel was asked, with the arguments and actor it read.
#[derive(Default)]
struct Log {
    asked: Vec<Asked>,
    /// The reason the next panel asked gives for doing nothing.
    refuse: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Asked {
    kind: &'static str,
    panel: String,
    action: String,
    input: Option<String>,
    option: Option<String>,
    actor: Actor,
}

type Shared = Rc<RefCell<Log>>;

struct Probe {
    kind: &'static str,
    log: Shared,
}

impl Panel for Probe {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        let PanelMsg::Action(id) = msg else { return };
        self.log.borrow_mut().asked.push(Asked {
            kind: self.kind,
            panel: cx.panel().as_str().to_owned(),
            action: id.as_str().to_owned(),
            input: cx.args().input.clone(),
            option: cx.args().option.clone(),
            actor: cx.actor().clone(),
        });
        if let Some(reason) = self.log.borrow_mut().refuse.take() {
            cx.refuse(reason);
            return;
        }
        let text = cx.args().input.clone().unwrap_or_default();
        let _ = cx.emit(|id| {
            Effect::new(
                id,
                ResourceRef::None,
                EffectBody::ConversationSend(ConversationSend {
                    client_message_id: "c".into(),
                    text,
                    attachments: vec![],
                    references: vec![],
                }),
            )
        });
    }

    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}

    fn semantics(&self, _area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![]
    }

    fn serialize(&self) -> Value {
        Value::Null
    }
}

fn model_with(caps: &[&'static str]) -> (Model, Shared) {
    let log: Shared = Rc::default();
    let registry = builtin::registry();
    let mut factories = PanelFactories::new();
    for kind in ["side-chat", "shell", "theo"] {
        let log = log.clone();
        factories.register(kind, move |_, _| {
            Box::new(Probe {
                kind,
                log: log.clone(),
            })
        });
    }
    let (keys, _) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
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
            area: Rect::new(0, 0, 160, 48),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    (m, log)
}

fn model() -> (Model, Shared) {
    model_with(&["conversation", "conversation.side", "environment"])
}

/// The agent's action as the wasm handle runs it: the request, the update,
/// and the answer from what it raised.
fn act(
    m: &mut Model,
    action: &str,
    panel: Option<&str>,
    args: Option<&str>,
) -> (AgentOutcome, Vec<Effect>) {
    let msg = match agent_request(action, "run-7", panel, args) {
        Ok(msg) => msg,
        Err(refused) => return (refused, vec![]),
    };
    m.capture_notices();
    let effects = update(m, msg);
    let notices = m.take_captured();
    let acted = m.take_acted_panel();
    (agent_outcome(&notices, effects.len(), acted.as_ref()), effects)
}

fn code(outcome: &AgentOutcome) -> Option<RefusalCode> {
    match outcome {
        AgentOutcome::Refused { code, .. } => Some(*code),
        AgentOutcome::Accepted { .. } => None,
    }
}

fn panel_of(outcome: &AgentOutcome) -> Option<String> {
    match outcome {
        AgentOutcome::Accepted { panel, .. } => panel.clone(),
        AgentOutcome::Refused { .. } => None,
    }
}

fn open_of(m: &Model, kind: &str) -> Vec<PanelInstanceId> {
    m.panel_ids()
        .filter(|(_, k)| k.as_str() == kind)
        .map(|(id, _)| id.clone())
        .collect()
}

fn agent() -> Actor {
    Actor::Agent {
        run_id: "run-7".into(),
    }
}

#[test]
fn the_catalog_offers_the_coding_actions_to_an_agent() {
    let (m, _) = model();
    let catalog = m.registry().agent_catalog(m.capabilities());
    for id in ["code.start", "code.send", "code.stop"] {
        let entry = catalog
            .iter()
            .find(|e| e.action.as_str() == id)
            .unwrap_or_else(|| panic!("{id} is not in the agent catalog"));
        assert!(!entry.human_only, "{id}");
    }
}

#[test]
fn arguments_that_are_not_json_or_name_an_unknown_field_are_refused_before_anything_runs() {
    let (mut m, log) = model();
    for bad in ["{", "[1]", r#"{"task":"x"}"#] {
        let (outcome, effects) = act(&mut m, "code.start", None, Some(bad));
        assert_eq!(code(&outcome), Some(RefusalCode::InvalidArgs), "{bad}");
        assert!(effects.is_empty());
    }
    assert!(log.borrow().asked.is_empty());
    // Blank arguments are none at all.
    assert_eq!(
        agent_request("code.stop", "run-7", Some("panel-1"), Some("  ")),
        agent_request("code.stop", "run-7", Some("panel-1"), None),
    );
}

#[test]
fn code_start_needs_a_task_and_an_agent_it_knows() {
    let (mut m, log) = model();
    for args in [None, Some(r#"{"input":"   "}"#), Some(r#"{"option":"claude"}"#)] {
        let (outcome, _) = act(&mut m, "code.start", None, args);
        assert_eq!(code(&outcome), Some(RefusalCode::InvalidArgs), "{args:?}");
    }
    let (outcome, _) = act(
        &mut m,
        "code.start",
        None,
        Some(r#"{"input":"fix it","option":"vim"}"#),
    );
    assert_eq!(code(&outcome), Some(RefusalCode::InvalidArgs));
    let AgentOutcome::Refused { reason, .. } = outcome else {
        unreachable!()
    };
    assert!(reason.contains("theorem, claude or codex"), "{reason}");
    assert!(log.borrow().asked.is_empty());
    assert!(open_of(&m, "side-chat").is_empty() && open_of(&m, "shell").is_empty());
}

#[test]
fn code_start_opens_a_side_chat_for_theorem_and_hands_it_the_task_as_the_agent() {
    let (mut m, log) = model();
    let (outcome, effects) = act(&mut m, "code.start", None, Some(r#"{"input":"add tests"}"#));
    let chats = open_of(&m, "side-chat");
    assert_eq!(chats.len(), 1);
    assert_eq!(panel_of(&outcome).as_deref(), Some(chats[0].as_str()));
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].actor, agent());
    let asked = log.borrow().asked.clone();
    assert_eq!(
        asked,
        vec![Asked {
            kind: "side-chat",
            panel: chats[0].as_str().to_owned(),
            action: "code.start".into(),
            input: Some("add tests".into()),
            option: None,
            actor: agent(),
        }]
    );
    // Theorem by name is the same agent.
    let (outcome, _) = act(
        &mut m,
        "code.start",
        None,
        Some(r#"{"input":"again","option":"theorem"}"#),
    );
    assert_eq!(open_of(&m, "side-chat").len(), 2);
    assert!(panel_of(&outcome).is_some());
}

#[test]
fn code_start_opens_a_shell_for_claude_and_codex() {
    let (mut m, log) = model();
    for option in ["claude", "codex"] {
        let args = format!(r#"{{"input":"refactor","option":"{option}"}}"#);
        let (outcome, effects) = act(&mut m, "code.start", None, Some(&args));
        assert!(panel_of(&outcome).is_some(), "{option}: {outcome:?}");
        assert_eq!(effects.len(), 1);
        let last = log.borrow().asked.last().cloned().unwrap();
        assert_eq!((last.kind, last.option.as_deref()), ("shell", Some(option)));
    }
    assert_eq!(open_of(&m, "shell").len(), 2);
}

#[test]
fn a_panel_that_will_not_start_says_why_and_its_pane_goes_again() {
    let (mut m, log) = model();
    log.borrow_mut().refuse = Some("The host reports Herdr unavailable.".into());
    let (outcome, effects) = act(
        &mut m,
        "code.start",
        None,
        Some(r#"{"input":"x","option":"codex"}"#),
    );
    assert_eq!(
        outcome,
        AgentOutcome::Refused {
            code: RefusalCode::Unavailable,
            reason: "The host reports Herdr unavailable.".into()
        }
    );
    assert!(effects.is_empty());
    assert!(open_of(&m, "shell").is_empty());
}

#[test]
fn code_start_is_refused_when_the_host_offers_no_side_chats_or_no_environment() {
    let (mut m, log) = model_with(&["conversation"]);
    let (outcome, _) = act(&mut m, "code.start", None, Some(r#"{"input":"x"}"#));
    assert_eq!(code(&outcome), Some(RefusalCode::Unavailable));
    let (outcome, _) = act(
        &mut m,
        "code.start",
        None,
        Some(r#"{"input":"x","option":"claude"}"#),
    );
    assert_eq!(code(&outcome), Some(RefusalCode::Unavailable));
    assert!(log.borrow().asked.is_empty());
    assert!(open_of(&m, "side-chat").is_empty() && open_of(&m, "shell").is_empty());
}

#[test]
fn code_send_and_stop_reach_the_named_coding_panel_only() {
    let (mut m, log) = model();
    let (started, _) = act(&mut m, "code.start", None, Some(r#"{"input":"x"}"#));
    let chat = panel_of(&started).unwrap();

    let (outcome, effects) = act(
        &mut m,
        "code.send",
        Some(&chat),
        Some(r#"{"input":"also docs"}"#),
    );
    assert_eq!(panel_of(&outcome).as_deref(), Some(chat.as_str()));
    assert_eq!(effects[0].actor, agent());
    let (outcome, _) = act(&mut m, "code.stop", Some(&chat), None);
    assert_eq!(panel_of(&outcome).as_deref(), Some(chat.as_str()));
    let actions: Vec<String> = log
        .borrow()
        .asked
        .iter()
        .map(|a| format!("{}:{}", a.action, a.input.clone().unwrap_or_default()))
        .collect();
    assert_eq!(actions, ["code.start:x", "code.send:also docs", "code.stop:"]);

    // Words are required to send.
    let (outcome, _) = act(&mut m, "code.send", Some(&chat), None);
    assert_eq!(code(&outcome), Some(RefusalCode::InvalidArgs));
    // A panel that is not open is not guessed.
    let (outcome, _) = act(&mut m, "code.send", Some("panel-99"), Some(r#"{"input":"x"}"#));
    assert_eq!(code(&outcome), Some(RefusalCode::UnknownPanel));
}

#[test]
fn code_send_refuses_a_panel_that_is_not_a_side_chat_or_a_shell() {
    let (mut m, log) = model();
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("theo.focus"),
            actor: Actor::Human,
        },
    );
    let theo = open_of(&m, "theo");
    assert_eq!(theo.len(), 1, "the conversation panel is open");
    let (outcome, _) = act(
        &mut m,
        "code.send",
        Some(theo[0].as_str()),
        Some(r#"{"input":"x"}"#),
    );
    assert_eq!(code(&outcome), Some(RefusalCode::Unavailable));
    assert!(log.borrow().asked.is_empty());
}

#[test]
fn the_arguments_belong_to_their_action_only() {
    let (mut m, log) = model();
    let (started, _) = act(&mut m, "code.start", None, Some(r#"{"input":"x"}"#));
    let chat = panel_of(&started).unwrap();
    // A person's own action on the same panel afterwards carries none.
    update(
        &mut m,
        Msg::ActionOn {
            id: ActionId::new("code.stop"),
            actor: Actor::Human,
            panel: PanelInstanceId::new(&chat),
        },
    );
    let last = log.borrow().asked.last().cloned().unwrap();
    assert_eq!((last.input, last.option, last.actor), (None, None, Actor::Human));
}
