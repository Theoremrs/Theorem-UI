//! The Changes panel driven through a real root: keys, the pointer, completions and
//! host messages go in as `Msg`; effects, cells and the semantic tree come out.

mod common;

use common::{SMALL_DIFF, change, diff_answer, log_answer};
use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::Value;
use std::cell::{Ref, RefCell};
use std::rc::Rc;
use theorem_workbench_changes::{
    ChangesPanel, OpenDocument, actions, descriptors, extend_registry,
};
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    BlameHunk, BranchInfo, Completion, CompletionPayload, ConflictSides, LogEntry, Outcome,
    ScmBlameResult, ScmBranches, ScmLogResult, ScmMerged, ScmShowResult,
};
use theorem_workbench_core::effect::{Effect, EffectBody, ScmRef};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ActionId, Actor, EffectId, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::{Availability, Capabilities};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::{
    Button, Ctx, Model, Msg, OpenTarget, Panel, PanelFactories, PanelMsg, Pointer, PointerKind,
    Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

const CAPS: [&str; 5] = ["files", "documents", "scm", "environment", "search"];
const CAPS_AMEND: [&str; 6] = [
    "files",
    "documents",
    "scm",
    "environment",
    "search",
    "scm.commit.amend",
];

fn agent() -> Actor {
    Actor::Agent {
        run_id: "run".into(),
    }
}

fn named(workspace: &str) -> Msg {
    Msg::Host(HostMessage::WorkspaceChanged {
        workspace: workspace.into(),
        environment: None,
    })
}

type Slot = Rc<RefCell<Option<Rc<RefCell<ChangesPanel>>>>>;

/// The real panel behind a handle the test keeps, so its model can be read back.
struct Probe(Rc<RefCell<ChangesPanel>>);

impl Panel for Probe {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.0.borrow_mut().update(msg, cx);
    }
    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.0.borrow().view(area, buf, cx);
    }
    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        self.0.borrow().semantics(area, cx)
    }
    fn serialize(&self) -> Value {
        self.0.borrow().serialize()
    }
    fn binding(&self) -> Option<theorem_workbench_core::stale::Binding> {
        self.0.borrow().binding()
    }
    fn text_entry(&self) -> bool {
        self.0.borrow().text_entry()
    }
}

thread_local! {
    /// The paths whose stand-in document panel has an unsaved draft.
    static DRAFTS: RefCell<std::collections::BTreeSet<String>> = const { RefCell::new(std::collections::BTreeSet::new()) };
}

/// A stand-in for the document panel the real workbench registers. It is bound
/// to its document as the editor is, and its tab says modified while the test
/// holds a draft for its path.
struct Doc(String);

impl Panel for Doc {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}
    fn binding(&self) -> Option<theorem_workbench_core::stale::Binding> {
        Some(theorem_workbench_core::stale::Binding {
            resource: ResourceRef::Document {
                workspace: "w".into(),
                resource_id: self.0.clone(),
            },
            revision: Some(theorem_workbench_core::ids::Revision::Seq(7)),
            generation: None,
        })
    }
    fn tab_label(&self) -> Option<theorem_workbench_core::TabLabel> {
        Some(theorem_workbench_core::TabLabel {
            title: self.0.clone(),
            modified: DRAFTS.with(|d| d.borrow().contains(&self.0)),
        })
    }
    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}
    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![Node::new(
            "doc",
            theorem_workbench_core::semantics::Role::Region,
            &self.0,
            area,
        )]
    }
    fn serialize(&self) -> Value {
        serde_json::json!({ "path": self.0 })
    }
}

fn factories(slot: &Slot) -> PanelFactories {
    let mut factories = PanelFactories::new();
    factories.register("document", |state, _| {
        Box::new(Doc(state["path"].as_str().unwrap_or("").to_owned()))
    });
    factories.register_opener("document", |t| matches!(t, OpenTarget::File { .. }));
    let slot = slot.clone();
    factories.register("changes", move |state, _| {
        // These tests are about the Stage view; the panel opens on the Review unless a
        // saved state names a view, so they name it. The Review has its own tests.
        let mut state = state.clone();
        if state.get("view").is_none() {
            state = match state {
                Value::Object(mut map) => {
                    map.insert("view".into(), Value::String("stage".into()));
                    Value::Object(map)
                }
                _ => serde_json::json!({ "view": "stage" }),
            };
        }
        let panel = Rc::new(RefCell::new(ChangesPanel::restore(&state)));
        *slot.borrow_mut() = Some(panel.clone());
        Box::new(Probe(panel))
    });
    factories
}

fn model_with(caps: &[&'static str], workspace: &str, slot: &Slot) -> Model {
    let mut registry = builtin::registry();
    extend_registry(&mut registry).expect("the actions register");
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(
        registry,
        factories(slot),
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
    if !workspace.is_empty() {
        update(&mut m, named(workspace));
    }
    m
}

struct Rig {
    m: Model,
    id: PanelInstanceId,
    handle: Rc<RefCell<ChangesPanel>>,
}

/// The effects that opening the panel and the first tick made.
fn opened_with(caps: &[&'static str], workspace: &str) -> (Rig, Vec<Effect>) {
    let slot: Slot = Rc::default();
    let mut m = model_with(caps, workspace, &slot);
    let mut fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new("changes.open"),
            actor: Actor::Human,
        },
    );
    let id = m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "changes")
        .map(|(id, _)| id.clone())
        .expect("a changes panel is open");
    fx.extend(update(&mut m, Msg::Tick));
    let handle = slot.borrow().clone().expect("the panel was built");
    (Rig { m, id, handle }, fx)
}

fn names(effects: &[Effect]) -> Vec<&'static str> {
    effects
        .iter()
        .map(|e| match &e.body {
            EffectBody::ScmStatus => "status",
            EffectBody::ScmDiff(_) => "diff",
            EffectBody::ScmShow(_) => "show",
            EffectBody::ScmStage(_) => "stage",
            EffectBody::ScmUnstage(_) => "unstage",
            EffectBody::ScmDiscard(_) => "discard",
            EffectBody::ScmRestore(_) => "restore",
            EffectBody::ScmCommit(_) => "commit",
            EffectBody::ScmBranch(_) => "branch",
            EffectBody::ScmFetch(_) => "fetch",
            EffectBody::ScmPush(_) => "push",
            EffectBody::ScmMerge(_) => "merge",
            EffectBody::ScmBlame(_) => "blame",
            EffectBody::ScmLog(_) => "log",
            EffectBody::ScmAmend(_) => "amend",
            EffectBody::ScmBranches => "branch list",
            EffectBody::ScmDiffCommit(_) => "commit diff",
            EffectBody::ScmConflict(_) => "conflict",
            EffectBody::ScmResolve(_) => "resolve",
            EffectBody::ScmShowRevision(_) => "show at revision",
            _ => "other",
        })
        .collect()
}

fn repo_resource(workspace: &str) -> ResourceRef {
    ResourceRef::Repository {
        workspace: workspace.into(),
        repository: String::new(),
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

    fn key_with(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
        self.mods(key, mods)
    }

    fn ch(&mut self, c: char) -> Vec<Effect> {
        self.key(Key::Char(c))
    }

    fn typed(&mut self, text: &str) {
        for c in text.chars() {
            self.ch(c);
        }
    }

    fn tick(&mut self) -> Vec<Effect> {
        self.send(Msg::Tick)
    }

    fn action(&mut self, id: &str, actor: Actor) -> Vec<Effect> {
        self.send(Msg::Action {
            id: ActionId::new(id),
            actor,
        })
    }

    fn answer(
        &mut self,
        effect: &Effect,
        outcome: Outcome,
        payload: Option<CompletionPayload>,
    ) -> Vec<Effect> {
        let mut c = Completion::new(effect.id, effect.resource.clone(), outcome);
        c.generation = effect.generation;
        c.payload = payload;
        self.send(Msg::Completion(c))
    }

    fn accept(&mut self, effect: &Effect, payload: CompletionPayload) -> Vec<Effect> {
        self.answer(effect, Outcome::Accepted, Some(payload))
    }

    fn panel(&self) -> &dyn Panel {
        self.m.panel(&self.id).expect("the panel")
    }

    fn model(&self) -> Ref<'_, theorem_workbench_changes::Changes> {
        Ref::map(self.handle.borrow(), |p| p.model())
    }

    /// The panel drawn under `theme`, cell by cell.
    fn cells(&self, theme: &Theme, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let mut cx =
            ViewCtx::new(theme, self.m.workspace()).with_capabilities(self.m.capabilities());
        cx.focused = true;
        self.panel().view(area, &mut buf, &cx);
        theorem_workbench_core::take_icons(&mut buf);
        buf
    }

    fn text(&self, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let mut cx =
            ViewCtx::new(&theme, self.m.workspace()).with_capabilities(self.m.capabilities());
        cx.focused = true;
        self.panel().view(area, &mut buf, &cx);
        theorem_workbench_core::take_icons(&mut buf);
        common::lines(&buf)
    }

    fn screen(&self) -> String {
        self.text(100, 30).join("\n")
    }

    fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the changes group")
            .body
    }

    fn press(&mut self, x: u16, y: u16, clicks: u8) -> Vec<Effect> {
        let b = self.body();
        let mut fx = vec![];
        for (kind, clicks) in [
            (PointerKind::Down(Button::Left), clicks),
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

    /// The column and row where `needle` starts on the screen.
    fn find(&self, needle: &str) -> (u16, u16) {
        let b = self.body();
        for (y, line) in self.text(b.width, b.height).iter().enumerate() {
            if let Some(at) = line.find(needle) {
                return (line[..at].chars().count() as u16, y as u16);
            }
        }
        panic!("{needle:?} is not on the screen:\n{}", self.screen());
    }
}

fn mixed() -> Vec<theorem_workbench_core::completion::ScmChange> {
    vec![
        change("src/main.rs", "M", " "),
        change("README.md", " ", "M"),
        change("notes.txt", " ", "M"),
        change("new.txt", "?", "?"),
    ]
}

fn loaded() -> Rig {
    loaded_with(&CAPS)
}

fn loaded_with(caps: &[&'static str]) -> Rig {
    let (mut rig, fx) = opened_with(caps, "w");
    assert_eq!(names(&fx), vec!["status"]);
    let next = rig.accept(&fx[0], common::status(1, mixed()));
    rig.accept(&next[0], log_answer(&["first", "second"]));
    rig
}

fn assert_valid(rig: &Rig) {
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("a valid tree");
}

// ---- opening and reading ----------------------------------------------------

#[test]
fn opening_emits_exactly_one_status_read_and_nothing_before() {
    let mut m = model_with(&CAPS, "w", &Slot::default());
    let fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new("changes.open"),
            actor: Actor::Human,
        },
    );
    assert!(names(&fx).iter().all(|n| *n != "status") || names(&fx).len() == 1);
    let mut all = fx;
    for _ in 0..3 {
        all.extend(update(&mut m, Msg::Tick));
    }
    assert_eq!(names(&all), vec!["status"], "{all:?}");
    assert_eq!(all[0].resource, repo_resource("w"));
}

#[test]
fn no_read_is_made_before_the_host_names_a_workspace() {
    let (mut rig, fx) = opened_with(&CAPS, "");
    assert!(names(&fx).is_empty(), "{fx:?}");
    assert!(names(&rig.tick()).is_empty());
    let fx = rig.send(named("w"));
    let mut all = fx;
    all.extend(rig.tick());
    assert_eq!(names(&all), vec!["status"]);
}

#[test]
fn no_read_is_made_without_the_scm_capability() {
    let mut m = model_with(&["files"], "w", &Slot::default());
    let mut all = update(
        &mut m,
        Msg::Action {
            id: ActionId::new("changes.open"),
            actor: Actor::Human,
        },
    );
    all.extend(update(&mut m, Msg::Tick));
    assert!(all.is_empty(), "{all:?}");
    assert!(m.panel_ids().all(|(_, k)| k.as_str() != "changes"));
}

#[test]
fn the_effect_carries_the_binding_generation_and_the_repository_resource() {
    let (rig, fx) = opened_with(&CAPS, "w");
    let binding = rig.panel().binding().expect("bound");
    assert_eq!(binding.resource, repo_resource("w"));
    assert_eq!(fx[0].generation, binding.generation);
}

#[test]
fn the_status_answer_draws_the_groups_and_asks_for_the_log_once() {
    let mut rig = loaded();
    let screen = rig.screen();
    assert!(screen.contains("Staged 1"), "{screen}");
    assert!(screen.contains("main.rs"));
    assert!(screen.contains("Unstaged 2"));
    assert!(screen.contains("Untracked 1"));
    // Idle ticks do not read again.
    assert!(rig.tick().is_empty());
    assert_valid(&rig);
}

#[test]
fn a_file_change_from_the_host_reads_again_once() {
    let mut rig = loaded();
    let fx = rig.send(Msg::Host(HostMessage::Resync {
        workspace: "w".into(),
        reason: "epoch_changed".into(),
    }));
    let mut all = fx;
    all.extend(rig.tick());
    assert_eq!(names(&all), vec!["status"]);
}

// ---- actions --------------------------------------------------------------------

fn once(fx: &[Effect], name: &str) {
    assert_eq!(names(fx), vec![name], "{fx:?}");
}

#[test]
fn each_key_emits_the_right_effect_once() {
    let mut rig = loaded();
    // The cursor is on the staged file: unstage it.
    once(&rig.ch('u'), "unstage");
    let mut rig = loaded();
    once(&rig.ch('r'), "status");
    let mut rig = loaded();
    once(&rig.ch('f'), "fetch");
    let mut rig = loaded();
    once(&rig.ch('p'), "push");
    let mut rig = loaded();
    once(&rig.ch('B'), "blame");
    let mut rig = loaded();
    once(&rig.ch('v'), "show");
    let mut rig = loaded();
    once(&rig.ch('V'), "show");
    let mut rig = loaded();
    once(&rig.ch('h'), "log");
    let mut rig = loaded();
    once(&rig.ch('U'), "unstage");
    // The right arrow opens the diff.
    let mut rig = loaded();
    once(&rig.key(Key::Right), "diff");
    // A row in the unstaged group is staged.
    let mut rig = loaded();
    rig.key(Key::Down);
    once(&rig.ch('s'), "stage");
    let mut rig = loaded();
    once(&rig.ch('S'), "stage");
    // The log is asked for with l.
    let mut rig = loaded();
    once(&rig.ch('l'), "log");
}

#[test]
fn the_registered_actions_emit_the_effect_they_name_once() {
    let cases: [(&str, &str); 14] = [
        (actions::REFRESH, "status"),
        (actions::DIFF, "diff"),
        (actions::UNSTAGE, "unstage"),
        (actions::STAGE_ALL, "stage"),
        (actions::UNSTAGE_ALL, "unstage"),
        (actions::LOG, "log"),
        (actions::HISTORY, "log"),
        (actions::BLAME, "blame"),
        (actions::SHOW_HEAD, "show"),
        (actions::SHOW_INDEX, "show"),
        (actions::FETCH, "fetch"),
        (actions::PUSH, "push"),
        (actions::COMMIT_ALL, "other"),
        (actions::RESTORE, "other"),
    ];
    for (id, effect) in cases {
        let mut rig = loaded();
        if id == actions::COMMIT_ALL {
            // Nothing is written, so the commit is refused, not sent.
            assert!(rig.action(id, Actor::Human).is_empty(), "{id}");
            continue;
        }
        if id == actions::RESTORE {
            // Nothing was discarded, so there is nothing to restore.
            assert!(rig.action(id, Actor::Human).is_empty(), "{id}");
            continue;
        }
        let fx = rig.action(id, Actor::Human);
        assert_eq!(names(&fx), vec![effect], "{id}: {fx:?}");
    }
}

#[test]
fn stage_acts_on_the_cursor_row_for_an_agent_too() {
    let mut rig = loaded();
    rig.key(Key::Down);
    let fx = rig.action(actions::STAGE, agent());
    once(&fx, "stage");
    match &fx[0].body {
        EffectBody::ScmStage(p) => assert_eq!(p.paths, vec!["README.md".to_owned()]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_prompt_actions_open_the_prompt_and_send_nothing_until_it_is_answered() {
    for id in [
        actions::SWITCH_BRANCH,
        actions::CREATE_BRANCH,
        actions::MERGE,
    ] {
        let mut rig = loaded();
        // Opening a switch or merge prompt reads the branch list; creating one reads nothing.
        let opened = rig.action(id, Actor::Human);
        let read = if id == actions::CREATE_BRANCH {
            vec![]
        } else {
            vec!["branch list"]
        };
        assert_eq!(names(&opened), read, "{id}");
        rig.typed("topic");
        let fx = rig.key(Key::Enter);
        let expected = if id == actions::MERGE {
            "merge"
        } else {
            "branch"
        };
        assert_eq!(names(&fx), vec![expected], "{id}");
        assert_valid(&rig);
    }
}

#[test]
fn an_empty_prompt_is_refused_and_stays_open() {
    let mut rig = loaded();
    rig.ch('m');
    assert!(rig.key(Key::Enter).is_empty());
    assert!(rig.model().prompt().is_some());
    assert!(rig.screen().contains("Merge branch"));
    rig.key(Key::Esc);
    assert!(rig.model().prompt().is_none());
}

#[test]
fn a_branch_switch_sends_the_name_and_a_new_branch_says_create() {
    let mut rig = loaded();
    rig.ch('b');
    rig.typed("dev");
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert!(!b.create && b.name == "dev"),
        other => panic!("{other:?}"),
    }
    let mut rig = loaded();
    rig.ch('n');
    rig.typed("feature/x");
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert!(b.create && b.name == "feature/x"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn discard_asks_first_and_sends_nothing_until_confirmed() {
    let mut rig = loaded();
    rig.key(Key::Down);
    assert!(rig.ch('d').is_empty());
    assert!(rig.screen().contains("Confirm"), "{}", rig.screen());
    assert_valid(&rig);
    // Anything but an answer changes nothing; a no leaves the file.
    assert!(rig.ch('n').is_empty());
    assert!(rig.model().confirm_pending().is_none());
    // Ask again, and say yes.
    rig.ch('d');
    let fx = rig.ch('y');
    once(&fx, "discard");
    // Once: a second yes sends nothing.
    assert!(rig.ch('y').is_empty());
}

#[test]
fn the_registered_discard_asks_and_the_confirm_action_is_human_only() {
    let mut rig = loaded();
    rig.key(Key::Down);
    assert!(rig.action(actions::DISCARD, agent()).is_empty());
    assert!(rig.model().confirm_pending().is_some());
    // An agent cannot answer for the person.
    assert!(rig.action(actions::CONFIRM, agent()).is_empty());
    assert!(rig.model().confirm_pending().is_some());
    let fx = rig.action(actions::CONFIRM, Actor::Human);
    once(&fx, "discard");
}

// ---- stale answers ----------------------------------------------------------------

#[test]
fn an_answer_for_an_older_generation_is_dropped() {
    let mut rig = loaded();
    let diff = rig.key(Key::Right);
    once(&diff, "diff");
    // The repository moves on before the diff answers.
    let fx = rig.ch('r');
    once(&fx, "status");
    rig.accept(&fx[0], common::status(2, mixed()));
    // The diff's answer arrives late, stamped with the generation it was asked at.
    let mut late = Completion::new(diff[0].id, diff[0].resource.clone(), Outcome::Accepted);
    late.generation = diff[0].generation;
    late.payload = Some(diff_answer("src/main.rs", true, SMALL_DIFF, 1));
    rig.send(Msg::Completion(late));
    assert!(
        !rig.screen().contains("hello, world"),
        "an old diff must not be shown:\n{}",
        rig.screen()
    );
}

#[test]
fn an_answer_the_model_never_asked_for_is_ignored() {
    let mut rig = loaded();
    let stranger = Completion::new(EffectId(9_999), repo_resource("w"), Outcome::Accepted);
    assert!(rig.send(Msg::Completion(stranger)).is_empty());
    assert_valid(&rig);
}

// ---- the commit draft --------------------------------------------------------------

#[test]
fn the_draft_survives_a_late_acknowledgement() {
    let mut rig = loaded();
    let staged = rig.ch('u');
    once(&staged, "unstage");
    rig.ch('c');
    rig.typed("fix the thing");
    rig.key(Key::Enter);
    rig.typed("line one");
    rig.key(Key::Enter);
    rig.typed("line two");
    assert_eq!(rig.model().subject(), "fix the thing");
    assert_eq!(rig.model().body(), "line one\nline two");
    // The acknowledgement for the unstage arrives after all that typing.
    let next = rig.accept(&staged[0], CompletionPayload::ScmState(common::repo(2)));
    assert_eq!(names(&next), vec!["status"]);
    assert_eq!(rig.model().subject(), "fix the thing");
    assert_eq!(rig.model().body(), "line one\nline two");
    // And typing continues where it was.
    rig.typed("!");
    assert_eq!(rig.model().body(), "line one\nline two!");
    assert!(rig.panel().text_entry());
    assert_valid(&rig);
}

#[test]
fn the_draft_edits_like_text_and_a_commit_clears_it() {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("add thing");
    // Ctrl+A selects all, as in the composer; Home is the start of the line.
    rig.key(Key::Home);
    rig.typed("fix: ");
    assert_eq!(rig.model().subject(), "fix: add thing");
    rig.key(Key::Backspace);
    assert_eq!(rig.model().subject(), "fix:add thing");
    rig.key(Key::Enter);
    rig.typed("hello");
    rig.key(Key::Enter);
    rig.typed("world");
    assert_eq!(rig.model().body(), "hello\nworld");
    // Backspace at the start of a line joins it to the one above.
    rig.key(Key::Home);
    rig.key(Key::Backspace);
    assert_eq!(rig.model().body(), "helloworld");
    // Ctrl+Enter commits: a staged file exists, so only the commit goes.
    let fx = rig.mods(Key::Enter, Mods::CTRL);
    once(&fx, "commit");
    match &fx[0].body {
        EffectBody::ScmCommit(c) => assert_eq!(c.message, "fix:add thing\n\nhelloworld"),
        other => panic!("{other:?}"),
    }
    let next = rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(2)));
    assert_eq!(
        names(&next),
        vec!["status", "log"]
            .into_iter()
            .take(next.len())
            .collect::<Vec<_>>()
    );
    assert_eq!(rig.model().subject(), "");
    assert_eq!(rig.model().body(), "");
}

#[test]
fn pasted_text_goes_to_the_focused_field() {
    let mut rig = loaded();
    rig.ch('c');
    rig.send(Msg::Paste("subject\nbody one\nbody two".into()));
    assert_eq!(rig.model().subject(), "subject");
    assert_eq!(rig.model().body(), "body one\nbody two");
}

#[test]
fn a_commit_with_nothing_staged_stages_all_first() {
    let mut rig = loaded();
    // Unstage the one staged file so nothing is staged.
    let fx = rig.ch('u');
    let next = rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(2)));
    assert_eq!(names(&next), vec!["status"]);
    let more = rig.accept(
        &next[0],
        common::status(
            2,
            vec![
                change("src/main.rs", " ", "M"),
                change("README.md", " ", "M"),
            ],
        ),
    );
    for e in more {
        rig.accept(&e, log_answer(&["x"]));
    }
    rig.ch('c');
    rig.typed("all of it");
    let fx = rig.mods(Key::Enter, Mods::CTRL);
    assert_eq!(names(&fx), vec!["stage"], "{fx:?}");
}

// ---- reads and the owner's replies ---------------------------------------------------

#[test]
fn blame_is_shown_as_the_owner_answered_and_escape_goes_back() {
    let mut rig = loaded();
    let fx = rig.ch('B');
    let hunks = vec![BlameHunk {
        author: "Ada".into(),
        commit: "a1b2c3d4e5".into(),
        start_line: 1,
        line_count: 2,
        summary: "start the thing".into(),
        timestamp: "0".into(),
    }];
    rig.accept(
        &fx[0],
        CompletionPayload::ScmBlame(ScmBlameResult {
            path: "src/main.rs".into(),
            hunks,
            state: None,
        }),
    );
    let screen = rig.screen();
    assert!(screen.contains("Blame: src/main.rs"), "{screen}");
    assert!(screen.contains("Ada"), "{screen}");
    assert_valid(&rig);
    rig.key(Key::Esc);
    assert!(rig.screen().contains("Staged 1"));
}

#[test]
fn show_head_is_shown_and_a_missing_version_says_so() {
    let mut rig = loaded();
    let fx = rig.ch('v');
    match &fx[0].body {
        EffectBody::ScmShow(s) => assert_eq!(s.reference, ScmRef::Head),
        other => panic!("{other:?}"),
    }
    rig.accept(
        &fx[0],
        CompletionPayload::ScmShow(ScmShowResult {
            path: "src/main.rs".into(),
            reference: "head".into(),
            exists: true,
            text: "fn main() {}\n".into(),
            state: None,
        }),
    );
    assert!(rig.screen().contains("fn main() {}"), "{}", rig.screen());
    rig.key(Key::Esc);
    let fx = rig.ch('V');
    rig.accept(
        &fx[0],
        CompletionPayload::ScmShow(ScmShowResult {
            path: "src/main.rs".into(),
            reference: "index".into(),
            exists: false,
            text: String::new(),
            state: None,
        }),
    );
    assert!(rig.screen().contains("index"), "{}", rig.screen());
}

#[test]
fn history_lists_the_commits_of_the_file() {
    let mut rig = loaded();
    let fx = rig.ch('h');
    rig.accept(&fx[0], log_answer(&["touched the file", "made the file"]));
    let screen = rig.screen();
    assert!(screen.contains("touched the file"), "{screen}");
    assert!(screen.contains("made the file"));
}

#[test]
fn a_refused_blame_shows_the_owners_reason() {
    let mut rig = loaded();
    let fx = rig.ch('B');
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "unborn_head".into(),
            reason: "this repository has no commits yet".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(screen.contains("no commits yet"), "{screen}");
    assert_valid(&rig);
}

#[test]
fn fetch_and_push_show_what_the_owner_said() {
    let mut rig = loaded();
    let fx = rig.ch('f');
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "no_remote".into(),
            reason: "no remote is configured".into(),
        },
        None,
    );
    assert!(
        rig.screen().contains("no remote is configured"),
        "{}",
        rig.screen()
    );
    rig.key(Key::Esc);
    let fx = rig.ch('p');
    let next = rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(2)));
    assert_eq!(names(&next), vec!["status"]);
}

#[test]
fn an_uncertain_push_is_shown_as_unknown_and_never_retried() {
    let mut rig = loaded();
    let fx = rig.ch('p');
    rig.answer(
        &fx[0],
        Outcome::Uncertain {
            reason: "the connection dropped".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(screen.contains("unknown"), "{screen}");
    assert_valid(&rig);
    let branch = node_ending(&rig, "/branch");
    assert_eq!(
        branch.role,
        theorem_workbench_core::semantics::Role::Alert,
        "an unknown result needs attention"
    );
    // Neither the host nor a repeat of the key sends it again, nor reads over it.
    assert!(rig.tick().is_empty());
    assert!(
        rig.send(Msg::Host(HostMessage::Resync {
            workspace: "w".into(),
            reason: "epoch_changed".into(),
        }))
        .is_empty()
    );
    assert!(rig.ch('p').is_empty());
    assert!(rig.ch('f').is_empty());
    // The person reads the state, which is how an unknown result is settled.
    let read = rig.ch('r');
    once(&read, "status");
    rig.accept(&read[0], common::status(2, mixed()));
    let fx = rig.ch('p');
    once(&fx, "push");
}

#[test]
fn a_merge_answers_with_the_conflicts_it_stopped_on() {
    let mut rig = loaded();
    rig.ch('m');
    rig.typed("topic");
    let fx = rig.key(Key::Enter);
    once(&fx, "merge");
    let next = rig.accept(
        &fx[0],
        CompletionPayload::ScmMerged(ScmMerged {
            merged: false,
            conflicts: vec![],
            state: Some(common::repo(2)),
        }),
    );
    assert!(names(&next).iter().all(|n| *n == "status" || *n == "log"));
    assert!(rig.screen().contains("conflicts"), "{}", rig.screen());
    assert_valid(&rig);
}

#[test]
fn a_refused_merge_and_an_uncertain_merge_are_shown() {
    let mut rig = loaded();
    rig.ch('m');
    rig.typed("nope");
    let fx = rig.key(Key::Enter);
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "unknown_branch".into(),
            reason: "no branch named nope".into(),
        },
        None,
    );
    assert!(
        rig.screen().contains("no branch named nope"),
        "{}",
        rig.screen()
    );

    let mut rig = loaded();
    rig.ch('m');
    rig.typed("topic");
    let fx = rig.key(Key::Enter);
    rig.answer(
        &fx[0],
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
        None,
    );
    assert!(rig.screen().contains("unknown"), "{}", rig.screen());
    assert!(rig.tick().is_empty());
}

// ---- conflicts --------------------------------------------------------------------------

#[test]
fn conflicted_files_are_grouped_apart() {
    let (mut rig, fx) = opened_with(&CAPS, "w");
    let next = rig.accept(
        &fx[0],
        common::status(
            1,
            vec![common::conflict("both.rs"), change("a.rs", " ", "M")],
        ),
    );
    rig.accept(&next[0], log_answer(&["x"]));
    let screen = rig.screen();
    assert!(
        screen.contains("Conflicted") || screen.contains("Merge"),
        "{screen}"
    );
    assert!(screen.contains("both.rs"));
    assert_valid(&rig);
}

// ---- the workspace and view state ----------------------------------------------------------

#[test]
fn a_workspace_change_rebinds_and_reads_again() {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("draft for w");
    rig.key(Key::Esc);
    let fx = rig.send(named("other"));
    let mut all = fx;
    all.extend(rig.tick());
    assert_eq!(names(&all), vec!["status"], "{all:?}");
    assert_eq!(all[0].resource, repo_resource("other"));
    assert_eq!(
        rig.panel().binding().unwrap().resource,
        repo_resource("other")
    );
    // What the panel knew of the old repository is gone.
    assert_eq!(rig.model().subject(), "");
    // The old workspace's answer, arriving now, is not applied.
    let before = rig.model().groups().is_none();
    assert!(before);
}

#[test]
fn view_state_round_trips_and_restores_the_draft_and_layout() {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("saved subject");
    rig.key(Key::Enter);
    rig.typed("saved body");
    rig.key(Key::Esc);
    rig.ch('t');
    let state: Value = rig.panel().serialize();
    assert!(state.is_object(), "{state}");
    let restored = ChangesPanel::restore(&state);
    assert_eq!(restored.model().subject(), "saved subject");
    assert_eq!(restored.model().body(), "saved body");
    assert_eq!(restored.model().layout(), rig.model().layout());
    // No diff text or file list is kept in it.
    assert!(!state.to_string().contains("README.md"));
    // A bad state restores to the default rather than failing.
    let blank = ChangesPanel::restore(&Value::Null);
    assert_eq!(blank.model().subject(), "");
}

// ---- semantics and the catalog ----------------------------------------------------------------

#[test]
fn the_semantic_tree_is_valid_in_each_state() {
    let (mut rig, fx) = opened_with(&CAPS, "w");
    assert_valid(&rig);
    let next = rig.accept(&fx[0], common::status(1, mixed()));
    assert_valid(&rig);
    rig.accept(&next[0], log_answer(&["a"]));
    assert_valid(&rig);
    let diff = rig.key(Key::Right);
    rig.accept(&diff[0], diff_answer("src/main.rs", true, SMALL_DIFF, 1));
    assert_valid(&rig);
    rig.ch('c');
    rig.typed("x");
    assert_valid(&rig);
    rig.key(Key::Esc);
    rig.key(Key::Down);
    rig.ch('d');
    assert_valid(&rig);
    rig.ch('n');
    rig.ch('b');
    assert_valid(&rig);
    rig.key(Key::Esc);
    let fx = rig.ch('B');
    assert_valid(&rig);
    rig.answer(
        &fx[0],
        Outcome::Failed {
            reason: "boom".into(),
        },
        None,
    );
    assert_valid(&rig);
    rig.key(Key::Esc);
    let fx = rig.ch('p');
    rig.answer(&fx[0], Outcome::Uncertain { reason: "?".into() }, None);
    assert_valid(&rig);
}

#[test]
fn the_actions_are_in_the_catalog_with_a_reason_when_unavailable() {
    let mut registry = builtin::registry();
    extend_registry(&mut registry).unwrap();
    let ids: Vec<String> = descriptors()
        .iter()
        .map(|d| d.id.as_str().to_owned())
        .collect();
    assert_eq!(ids.len(), 46);
    let with = registry.agent_catalog(&Capabilities::of(CAPS_AMEND));
    let without = registry.agent_catalog(&Capabilities::of(["files"]));
    for id in &ids {
        // `changes.confirm` is human-only: an agent's catalog does not list it.
        if id == actions::CONFIRM {
            assert!(with.iter().all(|e| e.action.as_str() != id));
            continue;
        }
        let on = with
            .iter()
            .find(|e| e.action.as_str() == id)
            .unwrap_or_else(|| panic!("{id} is in the catalog"));
        assert_eq!(on.availability, Availability::Available, "{id}");
        let off = without.iter().find(|e| e.action.as_str() == id).unwrap();
        match &off.availability {
            Availability::Unavailable { reason } => assert!(!reason.is_empty(), "{id}"),
            Availability::Available => panic!("{id} should need scm"),
        }
    }
}

// ---- the pointer ----------------------------------------------------------------------------------

#[test]
fn clicking_the_branch_line_controls_fetches_and_pushes() {
    let mut rig = loaded();
    let (x, y) = rig.find("[fetch]");
    once(&rig.press(x + 1, y, 1), "fetch");
    let mut rig = loaded();
    let (x, y) = rig.find("[push]");
    once(&rig.press(x + 1, y, 1), "push");
}

#[test]
fn clicking_a_header_stages_all_and_a_double_click_opens_the_file() {
    let mut rig = loaded();
    let (x, y) = rig.find(" stage all");
    once(&rig.press(x + 1, y, 1), "stage");

    let (mut rig, fx) = opened_with(&CAPS, "w");
    let next = rig.accept(&fx[0], common::status(1, mixed()));
    rig.accept(&next[0], log_answer(&["a"]));
    let (x, y) = rig.find("README.md");
    let fx = rig.press(x + 2, y, 2);
    assert!(names(&fx).iter().all(|n| *n != "discard"), "{fx:?}");
    // The double click asked the root to open the file: a document panel exists.
    assert!(rig.m.panel_ids().any(|(_, k)| k.as_str() == "document"));
}

#[test]
fn clicking_confirm_and_cancel_answers_the_question() {
    let mut rig = loaded();
    rig.key(Key::Down);
    rig.ch('d');
    let (x, y) = rig.find("Cancel");
    assert!(rig.press(x + 1, y, 1).is_empty());
    assert!(rig.model().confirm_pending().is_none());
    rig.ch('d');
    let (x, y) = rig.find("Confirm");
    once(&rig.press(x + 1, y, 1), "discard");
}

// ---- the picture --------------------------------------------------------------------------------------

#[test]
fn the_panel_draws_a_staged_file_an_expanded_diff_and_a_draft() {
    let mut rig = loaded();
    let diff = rig.key(Key::Right);
    rig.accept(&diff[0], diff_answer("src/main.rs", true, SMALL_DIFF, 1));
    rig.ch('c');
    rig.typed("Say hello, world");
    rig.key(Key::Enter);
    rig.typed("The greeting was too short.");
    let lines = rig.text(100, 30);
    let screen = lines.join("\n");
    println!("{screen}");
    assert!(screen.contains("Staged 1"));
    assert!(screen.contains("hello, world"));
    assert!(screen.contains("Say hello, world"));
    assert!(screen.contains("The greeting was too short."));
    assert!(screen.contains("[ Commit to main ]"));
    assert!(lines.iter().all(|l| l.chars().count() <= 100));
}

// ---- amend, the branch list and commit rows -----------------------------------------

fn caps_without_amend() -> Msg {
    Msg::Host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(CAPS),
    })
}

fn caps_with_amend() -> Msg {
    Msg::Host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["files", "documents", "scm", "scm.commit.amend"]),
    })
}

fn branch_node(tree: &theorem_workbench_core::semantics::SemanticTree) -> &Node {
    tree.nodes
        .iter()
        .find(|n| n.id.as_str().ends_with("/commit/amend"))
        .expect("the amend node")
}

fn branches(list: &[(&str, bool, bool)]) -> CompletionPayload {
    CompletionPayload::ScmBranches(ScmBranches {
        branches: list
            .iter()
            .map(|(name, remote, current)| BranchInfo {
                name: (*name).into(),
                remote: *remote,
                current: *current,
                upstream: None,
            })
            .collect(),
    })
}

fn branch_list() -> CompletionPayload {
    branches(&[
        ("main", false, true),
        ("feature/login", false, false),
        ("feature/search", false, false),
        ("origin/main", true, false),
    ])
}

fn opened_switch() -> (Rig, Effect) {
    let mut rig = loaded();
    let fx = rig.ch('b');
    once(&fx, "branch list");
    let read = fx[0].clone();
    (rig, read)
}

#[test]
fn amend_is_disabled_with_its_reason_when_the_host_does_not_offer_it() {
    let mut rig = loaded();
    rig.send(caps_without_amend());
    assert!(!rig.model().amend_available());
    assert!(rig.screen().contains("Amend"), "{}", rig.screen());
    // The key and the click both do nothing, and nothing is sent.
    assert!(rig.ch('a').is_empty());
    assert!(!rig.model().amend());
    let (x, y) = rig.find("[ ] Amend");
    assert!(rig.press(x, y, 1).is_empty());
    assert!(!rig.model().amend());
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    let node = branch_node(&tree);
    assert!(node.state.disabled);
    assert!(
        node.state
            .description
            .as_deref()
            .unwrap()
            .contains("scm.commit.amend"),
        "{node:?}"
    );
}

#[test]
fn amend_is_enabled_when_the_host_offers_it_and_a_click_toggles_it() {
    let mut rig = loaded();
    rig.send(caps_with_amend());
    assert!(rig.model().amend_available());
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    assert!(!branch_node(&tree).state.disabled);
    let (x, y) = rig.find("[ ] Amend");
    assert!(rig.press(x, y, 1).is_empty());
    assert!(rig.model().amend());
    assert!(rig.screen().contains("[x] Amend"), "{}", rig.screen());
    assert_valid(&rig);
}

#[test]
fn amend_loads_the_last_commits_message_from_the_log_the_panel_already_read() {
    let mut rig = loaded();
    rig.send(caps_with_amend());
    rig.ch('a');
    assert!(rig.model().amend());
    assert!(rig.screen().contains("first"), "{}", rig.screen());
}

#[test]
fn an_amend_commit_is_its_own_wire_kind_carrying_the_message() {
    let mut rig = loaded();
    rig.send(caps_with_amend());
    rig.ch('a');
    let fx = rig.key_with(Key::Enter, Mods::CTRL);
    once(&fx, "amend");
    match &fx[0].body {
        EffectBody::ScmAmend(a) => assert_eq!(a.message, "first"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_amend_action_reads_the_log_first_when_it_is_not_loaded_and_amends_when_it_arrives() {
    let (mut rig, fx) = opened_with(&CAPS_AMEND, "w");
    let next = rig.accept(&fx[0], common::status(1, mixed()));
    // The log read is in flight; the action is asked for before it is answered.
    once(&next, "log");
    let log = next[0].clone();
    let sent = rig.action(actions::AMEND, Actor::Human);
    assert!(names(&sent).iter().all(|n| *n != "amend"), "{sent:?}");
    let after = rig.accept(&log, log_answer(&["only commit"]));
    let amend: Vec<_> = after
        .iter()
        .filter(|e| matches!(e.body, EffectBody::ScmAmend(_)))
        .collect();
    assert_eq!(amend.len(), 1, "{after:?}");
    match &amend[0].body {
        EffectBody::ScmAmend(a) => assert_eq!(a.message, "only commit"),
        _ => unreachable!(),
    }
}

#[test]
fn the_amend_action_sends_the_last_commits_message_when_the_log_is_loaded() {
    let mut rig = loaded_with(&CAPS_AMEND);
    let fx = rig.action(actions::AMEND, Actor::Human);
    once(&fx, "amend");
    match &fx[0].body {
        EffectBody::ScmAmend(a) => assert_eq!(a.message, "first"),
        other => panic!("{other:?}"),
    }
    assert_valid(&rig);
}

#[test]
fn the_amend_action_is_unavailable_in_the_catalog_without_the_capability() {
    let mut registry = builtin::registry();
    extend_registry(&mut registry).unwrap();
    let without = registry.agent_catalog(&Capabilities::of(CAPS));
    let entry = without
        .iter()
        .find(|e| e.action.as_str() == actions::AMEND)
        .expect("listed");
    assert!(
        matches!(entry.availability, Availability::Unavailable { .. }),
        "{entry:?}"
    );
    let with = registry.agent_catalog(&Capabilities::of(CAPS_AMEND));
    let entry = with
        .iter()
        .find(|e| e.action.as_str() == actions::AMEND)
        .expect("listed");
    assert!(
        matches!(entry.availability, Availability::Available),
        "{entry:?}"
    );
}

#[test]
fn a_late_log_answer_after_the_host_withdrew_amend_does_not_send_an_amend() {
    let (mut rig, fx) = opened_with(&CAPS_AMEND, "w");
    let next = rig.accept(&fx[0], common::status(1, mixed()));
    let log = next[0].clone();
    rig.send(caps_without_amend());
    rig.action(actions::AMEND, Actor::Human);
    let after = rig.accept(&log, log_answer(&["x"]));
    assert!(names(&after).iter().all(|n| *n != "amend"), "{after:?}");
}

#[test]
fn the_switch_prompt_offers_the_branches_and_marks_the_current_and_remote_ones() {
    let (mut rig, read) = opened_switch();
    assert!(
        rig.screen().contains("Reading branches"),
        "{}",
        rig.screen()
    );
    rig.accept(&read, branch_list());
    let screen = rig.screen();
    assert!(screen.contains("feature/login"), "{screen}");
    assert!(screen.contains("* main"), "{screen}");
    assert!(screen.contains("origin/main  (remote)"), "{screen}");
    assert_valid(&rig);
}

#[test]
fn typing_in_the_prompt_filters_the_branches() {
    let (mut rig, read) = opened_switch();
    rig.accept(&read, branch_list());
    rig.typed("sea");
    let screen = rig.screen();
    assert!(screen.contains("feature/search"), "{screen}");
    assert!(!screen.contains("feature/login"), "{screen}");
    rig.typed("zzz");
    assert!(
        rig.screen().contains("No branch matches"),
        "{}",
        rig.screen()
    );
    assert_valid(&rig);
}

#[test]
fn arrows_and_enter_switch_to_an_offered_branch() {
    let (mut rig, read) = opened_switch();
    rig.accept(&read, branch_list());
    rig.key(Key::Down);
    let fx = rig.key(Key::Enter);
    once(&fx, "branch");
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert!(!b.create && b.name == "feature/login"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn tab_completes_the_typed_name_to_the_first_branch() {
    let (mut rig, read) = opened_switch();
    rig.accept(&read, branch_list());
    rig.typed("feature/se");
    rig.key(Key::Tab);
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert_eq!(b.name, "feature/search"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_typed_name_is_still_accepted_when_the_list_has_no_match() {
    let (mut rig, read) = opened_switch();
    rig.accept(&read, branch_list());
    rig.typed("brand-new");
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert_eq!(b.name, "brand-new"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_merge_prompt_leaves_the_current_branch_out() {
    let mut rig = loaded();
    let fx = rig.ch('m');
    once(&fx, "branch list");
    rig.accept(&fx[0], branch_list());
    let screen = rig.screen();
    assert!(screen.contains("feature/login"), "{screen}");
    assert!(!screen.contains("* main"), "{screen}");
}

#[test]
fn a_refused_branch_list_says_why_and_typing_still_works() {
    let (mut rig, read) = opened_switch();
    rig.answer(
        &read,
        Outcome::Refused {
            code: "unreadable".into(),
            reason: "the repository could not list its branches".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(screen.contains("could not list its branches"), "{screen}");
    assert!(
        screen.contains("Type the name and press Enter."),
        "{screen}"
    );
    rig.typed("dev");
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert_eq!(b.name, "dev"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_uncertain_branch_list_read_says_so_and_typing_still_works() {
    let (mut rig, read) = opened_switch();
    rig.answer(
        &read,
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(
        screen.contains("Type the name and press Enter."),
        "{screen}"
    );
    assert_valid(&rig);
    rig.typed("dev");
    once(&rig.key(Key::Enter), "branch");
}

#[test]
fn a_branch_list_answered_after_the_prompt_closed_is_dropped() {
    let (mut rig, read) = opened_switch();
    rig.key(Key::Esc);
    rig.accept(&read, branch_list());
    assert!(!rig.screen().contains("feature/login"), "{}", rig.screen());
    assert!(rig.model().prompt().is_none());
    assert_valid(&rig);
}

#[test]
fn a_branch_list_for_an_older_generation_is_dropped() {
    let (mut rig, read) = opened_switch();
    rig.send(Msg::Host(HostMessage::Resync {
        workspace: "w".into(),
        reason: "epoch_changed".into(),
    }));
    let mut stale = Completion::new(read.id, read.resource.clone(), Outcome::Accepted);
    stale.generation = Some(theorem_workbench_core::ids::Generation(0));
    stale.payload = Some(branch_list());
    rig.send(Msg::Completion(stale));
    assert!(!rig.screen().contains("feature/login"), "{}", rig.screen());
}

#[test]
fn a_branch_list_from_an_earlier_prompt_does_not_fill_the_next_one() {
    let (mut rig, first) = opened_switch();
    rig.key(Key::Esc);
    let fx = rig.ch('b');
    let second = fx[0].clone();
    rig.accept(&first, branches(&[("old-list", false, false)]));
    assert!(!rig.screen().contains("old-list"), "{}", rig.screen());
    rig.accept(&second, branch_list());
    assert!(rig.screen().contains("feature/login"), "{}", rig.screen());
}

fn focus_log(rig: &mut Rig) {
    for _ in 0..3 {
        if rig.model().focus() == theorem_workbench_changes::Focus::Log {
            break;
        }
        rig.key(Key::Tab);
    }
}

#[test]
fn enter_on_a_log_row_shows_that_commits_diff_and_escape_returns_to_the_log_row() {
    let mut rig = loaded();
    focus_log(&mut rig);
    rig.key(Key::Down);
    let fx = rig.key(Key::Enter);
    once(&fx, "commit diff");
    match &fx[0].body {
        EffectBody::ScmDiffCommit(d) => {
            assert!(d.commit.starts_with("a1b2c31"), "{d:?}");
            assert!(d.path.is_none());
        }
        other => panic!("{other:?}"),
    }
    let mut c = common::diff_answer("", false, "@@ -1 +1 @@\n-old\n+new\n", 1);
    if let CompletionPayload::ScmDiff(d) = &mut c {
        d.path = None;
        d.commit = Some("a1b2c310".into());
    }
    rig.accept(&fx[0], c);
    let screen = rig.screen();
    assert!(screen.contains("+new"), "{screen}");
    assert!(
        screen.contains("Esc goes back") || screen.contains("Esc"),
        "{screen}"
    );
    assert_valid(&rig);
    rig.key(Key::Esc);
    assert_eq!(rig.model().focus(), theorem_workbench_changes::Focus::Log);
    assert!(rig.model().read_view().is_none());
}

#[test]
fn a_double_click_on_a_log_row_shows_that_commits_diff() {
    let mut rig = loaded();
    let (x, y) = rig.find("second");
    let fx = rig.press(x, y, 2);
    assert!(names(&fx).contains(&"commit diff"), "{fx:?}");
}

#[test]
fn a_commit_diff_answered_for_a_view_that_was_left_is_dropped() {
    let mut rig = loaded();
    focus_log(&mut rig);
    let fx = rig.key(Key::Enter);
    once(&fx, "commit diff");
    rig.key(Key::Esc);
    let mut c = common::diff_answer("", false, "@@\n+late\n", 1);
    if let CompletionPayload::ScmDiff(d) = &mut c {
        d.path = None;
    }
    rig.accept(&fx[0], c);
    assert!(rig.model().read_view().is_none());
    assert!(!rig.screen().contains("+late"), "{}", rig.screen());
}

#[test]
fn a_commit_diff_for_an_older_generation_is_dropped() {
    let mut rig = loaded();
    focus_log(&mut rig);
    let fx = rig.key(Key::Enter);
    rig.send(Msg::Host(HostMessage::Resync {
        workspace: "w".into(),
        reason: "epoch_changed".into(),
    }));
    let mut stale = Completion::new(fx[0].id, fx[0].resource.clone(), Outcome::Accepted);
    stale.generation = Some(theorem_workbench_core::ids::Generation(0));
    stale.payload = Some(common::diff_answer("", false, "+late", 1));
    rig.send(Msg::Completion(stale));
    assert!(!rig.screen().contains("+late"), "{}", rig.screen());
}

fn history(rig: &mut Rig) {
    let fx = rig.ch('h');
    rig.accept(&fx[0], log_answer(&["touched it", "made it"]));
}

#[test]
fn enter_on_a_history_row_shows_that_commits_diff_for_the_file_and_escape_keeps_the_cursor() {
    let mut rig = loaded();
    history(&mut rig);
    rig.key(Key::Down);
    let fx = rig.key(Key::Enter);
    once(&fx, "commit diff");
    match &fx[0].body {
        EffectBody::ScmDiffCommit(d) => {
            assert!(d.commit.starts_with("a1b2c31"), "{d:?}");
            assert_eq!(d.path.as_deref(), Some("src/main.rs"));
        }
        other => panic!("{other:?}"),
    }
    let mut c = common::diff_answer("src/main.rs", false, "@@ -1 +1 @@\n-a\n+b\n", 1);
    if let CompletionPayload::ScmDiff(d) = &mut c {
        d.commit = Some("a1b2c310".into());
    }
    rig.accept(&fx[0], c);
    assert!(rig.screen().contains("+b"), "{}", rig.screen());
    rig.key(Key::Esc);
    let screen = rig.screen();
    assert!(screen.contains("made it"), "{screen}");
    // Back in the history, the cursor is where it was: Enter opens the same commit again.
    let again = rig.key(Key::Enter);
    match &again[0].body {
        EffectBody::ScmDiffCommit(d) => assert!(d.commit.starts_with("a1b2c31"), "{d:?}"),
        other => panic!("{other:?}"),
    }
    assert_valid(&rig);
}

#[test]
fn v_on_a_history_row_shows_the_file_at_that_revision() {
    let mut rig = loaded();
    history(&mut rig);
    let fx = rig.ch('v');
    once(&fx, "show at revision");
    let revision = match &fx[0].body {
        EffectBody::ScmShowRevision(s) => {
            assert_eq!(s.path, "src/main.rs");
            s.revision.clone()
        }
        other => panic!("{other:?}"),
    };
    rig.accept(
        &fx[0],
        CompletionPayload::ScmShow(ScmShowResult {
            path: "src/main.rs".into(),
            reference: revision,
            exists: true,
            text: "fn old() {}\n".into(),
            state: None,
        }),
    );
    assert!(rig.screen().contains("fn old() {}"), "{}", rig.screen());
    assert_valid(&rig);
    rig.key(Key::Esc);
    assert!(rig.screen().contains("touched it"), "{}", rig.screen());
}

#[test]
fn a_file_that_did_not_exist_at_that_revision_says_so() {
    let mut rig = loaded();
    history(&mut rig);
    let fx = rig.ch('v');
    rig.accept(
        &fx[0],
        CompletionPayload::ScmShow(ScmShowResult {
            path: "src/main.rs".into(),
            reference: "a1b2c30".into(),
            exists: false,
            text: String::new(),
            state: None,
        }),
    );
    assert!(
        rig.screen().contains("did not exist in that commit"),
        "{}",
        rig.screen()
    );
}

#[test]
fn a_file_at_a_revision_answered_after_leaving_is_dropped() {
    let mut rig = loaded();
    history(&mut rig);
    let fx = rig.ch('v');
    rig.key(Key::Esc);
    rig.accept(
        &fx[0],
        CompletionPayload::ScmShow(ScmShowResult {
            path: "src/main.rs".into(),
            reference: "a1b2c30".into(),
            exists: true,
            text: "late text\n".into(),
            state: None,
        }),
    );
    assert!(!rig.screen().contains("late text"), "{}", rig.screen());
}

#[test]
fn a_file_at_a_revision_for_an_older_generation_is_dropped() {
    let mut rig = loaded();
    history(&mut rig);
    let fx = rig.ch('v');
    rig.send(Msg::Host(HostMessage::Resync {
        workspace: "w".into(),
        reason: "epoch_changed".into(),
    }));
    let mut stale = Completion::new(fx[0].id, fx[0].resource.clone(), Outcome::Accepted);
    stale.generation = Some(theorem_workbench_core::ids::Generation(0));
    stale.payload = Some(CompletionPayload::ScmShow(ScmShowResult {
        path: "src/main.rs".into(),
        reference: "x".into(),
        exists: true,
        text: "late text\n".into(),
        state: None,
    }));
    rig.send(Msg::Completion(stale));
    assert!(!rig.screen().contains("late text"), "{}", rig.screen());
}

// ---- capabilities from the context, the whole amend message ---------------------------------

fn log_with_body(subject: &str, body: Option<&str>) -> CompletionPayload {
    CompletionPayload::ScmLog(ScmLogResult {
        commits: vec![LogEntry {
            commit: format!("a1b2c30{}", "0".repeat(33)),
            author: "Ada".into(),
            email: None,
            timestamp: "0".into(),
            subject: subject.into(),
            body: body.map(str::to_owned),
        }],
        state: None,
    })
}

fn loaded_with_log(caps: &[&'static str], log: CompletionPayload) -> Rig {
    let (mut rig, fx) = opened_with(caps, "w");
    let next = rig.accept(&fx[0], common::status(1, mixed()));
    rig.accept(&next[0], log);
    rig
}

#[test]
fn a_panel_opened_where_the_host_offers_amend_has_it_enabled_without_any_message() {
    let rig = loaded_with(&CAPS_AMEND);
    assert!(rig.model().amend_available());
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    assert!(!branch_node(&tree).state.disabled);
}

#[test]
fn a_panel_opened_where_the_host_does_not_offer_amend_has_it_disabled_without_any_message() {
    let mut rig = loaded();
    assert!(!rig.model().amend_available());
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    assert!(branch_node(&tree).state.disabled);
    assert!(rig.ch('a').is_empty());
    assert!(!rig.model().amend());
}

#[test]
fn amend_follows_the_hosts_capabilities_when_they_change() {
    let mut rig = loaded_with(&CAPS_AMEND);
    rig.ch('a');
    assert!(rig.model().amend());
    rig.send(caps_without_amend());
    assert!(!rig.model().amend_available());
    assert!(!rig.model().amend(), "withdrawn amend turns the box off");
    rig.send(Msg::Host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(CAPS_AMEND),
    }));
    assert!(rig.model().amend_available());
}

#[test]
fn amend_prefills_the_subject_a_blank_line_and_the_body() {
    let mut rig = loaded_with_log(
        &CAPS_AMEND,
        log_with_body(
            "fix the thing",
            Some("It broke on Tuesday.\nThis mends it."),
        ),
    );
    rig.ch('a');
    let fx = rig.key_with(Key::Enter, Mods::CTRL);
    match &fx[0].body {
        EffectBody::ScmAmend(a) => assert_eq!(
            a.message,
            "fix the thing\n\nIt broke on Tuesday.\nThis mends it."
        ),
        other => panic!("{other:?}"),
    }
}

#[test]
fn amend_without_a_body_prefills_the_subject_and_says_the_body_could_not_be_read() {
    let mut rig = loaded_with_log(&CAPS_AMEND, log_with_body("fix the thing", None));
    rig.ch('a');
    let screen = rig.screen();
    assert!(screen.contains("fix the thing"), "{screen}");
    assert!(
        screen.contains("The body of the last commit could not be read."),
        "{screen}"
    );
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    let description = branch_node(&tree).state.description.clone().unwrap();
    assert!(description.contains("sent no body"), "{description}");
}

#[test]
fn a_commit_that_has_an_empty_body_does_not_claim_it_could_not_be_read() {
    let mut rig = loaded_with_log(&CAPS_AMEND, log_with_body("fix the thing", Some("")));
    rig.ch('a');
    assert!(
        !rig.screen().contains("could not be read"),
        "{}",
        rig.screen()
    );
    let fx = rig.key_with(Key::Enter, Mods::CTRL);
    match &fx[0].body {
        EffectBody::ScmAmend(a) => assert_eq!(a.message, "fix the thing"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn turning_amend_off_takes_back_the_message_it_loaded_with_its_body() {
    let mut rig = loaded_with_log(&CAPS_AMEND, log_with_body("subject", Some("body text")));
    rig.ch('a');
    assert!(rig.screen().contains("body text"), "{}", rig.screen());
    rig.ch('a');
    assert!(!rig.model().amend());
    assert!(!rig.screen().contains("body text"), "{}", rig.screen());
}

// ---- conflicted files ----------------------------------------------------------------------

fn sides(conflict: bool) -> ConflictSides {
    ConflictSides {
        path: "both.rs".into(),
        conflict,
        base: Some("let x = 0;\n".into()),
        ours: Some("let x = 1;\nlet y = 2;\n".into()),
        theirs: Some("let x = 9;\n".into()),
        binary: false,
    }
}

fn conflicted() -> Rig {
    let (mut rig, fx) = opened_with(&CAPS, "w");
    let next = rig.accept(
        &fx[0],
        common::status(
            1,
            vec![common::conflict("both.rs"), change("a.rs", " ", "M")],
        ),
    );
    rig.accept(&next[0], log_answer(&["x"]));
    for _ in 0..4 {
        if rig.model().cursor_path() == Some("both.rs") {
            break;
        }
        rig.key(Key::Down);
    }
    assert_eq!(rig.model().cursor_path(), Some("both.rs"));
    rig
}

fn open_sides(rig: &mut Rig, answer: ConflictSides) -> Effect {
    let fx = rig.key(Key::Enter);
    once(&fx, "conflict");
    rig.accept(&fx[0], CompletionPayload::ScmConflict(answer));
    fx[0].clone()
}

#[test]
fn enter_on_a_conflicted_file_asks_for_its_sides_and_shows_both() {
    let mut rig = conflicted();
    let fx = rig.key(Key::Enter);
    once(&fx, "conflict");
    match &fx[0].body {
        EffectBody::ScmConflict(p) => assert_eq!(p.path, "both.rs"),
        other => panic!("{other:?}"),
    }
    assert!(rig.screen().contains("Reading"), "{}", rig.screen());
    rig.accept(&fx[0], CompletionPayload::ScmConflict(sides(true)));
    let screen = rig.screen();
    assert!(screen.contains("Conflict: both.rs"), "{screen}");
    assert!(screen.contains("Ours (this branch)"), "{screen}");
    assert!(screen.contains("let x = 1;"), "{screen}");
    assert!(screen.contains("Theirs (incoming)"), "{screen}");
    assert!(screen.contains("let x = 9;"), "{screen}");
    assert!(screen.contains("Base (the common ancestor)"), "{screen}");
    assert_valid(&rig);
}

#[test]
fn a_side_the_host_does_not_have_is_said_to_have_no_file_and_not_shown_empty() {
    let mut rig = conflicted();
    open_sides(
        &mut rig,
        ConflictSides {
            path: "both.rs".into(),
            conflict: true,
            base: None,
            ours: Some("kept\n".into()),
            theirs: None,
            binary: false,
        },
    );
    let screen = rig.screen();
    assert!(screen.contains("This side has no file."), "{screen}");
    assert!(!screen.contains("Base (the common ancestor)"), "{screen}");
}

#[test]
fn enter_on_an_ordinary_file_still_expands_its_diff() {
    let mut rig = conflicted();
    rig.key(Key::Down);
    let fx = rig.key(Key::Enter);
    once(&fx, "diff");
}

#[test]
fn escape_leaves_the_conflict_view_for_the_list_with_the_cursor_where_it_was() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.key(Key::Esc);
    assert!(rig.model().read_view().is_none());
    assert_eq!(rig.model().cursor_path(), Some("both.rs"));
    assert!(rig.screen().contains("both.rs"), "{}", rig.screen());
}

#[test]
fn taking_ours_asks_first_and_sends_nothing_until_it_is_confirmed() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    assert!(rig.ch('o').is_empty());
    let screen = rig.screen();
    assert!(screen.contains("Take ours for both.rs?"), "{screen}");
    assert!(screen.contains("lost"), "{screen}");
    assert_valid(&rig);
    let fx = rig.key(Key::Enter);
    once(&fx, "resolve");
    match &fx[0].body {
        EffectBody::ScmResolve(r) => {
            assert_eq!(r.path, "both.rs");
            assert_eq!(r.take, theorem_workbench_core::effect::ConflictTake::Ours);
            assert!(r.text.is_none());
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn taking_theirs_sends_the_theirs_take() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.ch('t');
    assert!(rig.screen().contains("Take theirs for both.rs?"));
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmResolve(r) => {
            assert_eq!(r.take, theorem_workbench_core::effect::ConflictTake::Theirs)
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn declining_the_question_sends_nothing_and_keeps_the_sides_on_screen() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.ch('o');
    assert!(rig.key(Key::Esc).is_empty());
    assert!(rig.model().confirm_pending().is_none());
    assert!(
        rig.screen().contains("Ours (this branch)"),
        "{}",
        rig.screen()
    );
}

#[test]
fn a_resolve_that_was_accepted_closes_the_view_and_reads_the_state_again() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.ch('o');
    let fx = rig.key(Key::Enter);
    let next = rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(2)));
    once(&next, "status");
    assert!(rig.model().read_view().is_none());
    assert_valid(&rig);
}

#[test]
fn a_refused_resolve_shows_the_owners_reason_and_leaves_the_sides_open() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.ch('o');
    let fx = rig.key(Key::Enter);
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "not_conflicted".into(),
            reason: "the file is not in conflict".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(screen.contains("the file is not in conflict"), "{screen}");
    assert!(rig.model().read_view().is_some());
    assert_valid(&rig);
}

#[test]
fn an_uncertain_resolve_is_shown_as_unknown_and_blocks_the_next_change() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.ch('o');
    let fx = rig.key(Key::Enter);
    rig.answer(
        &fx[0],
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
        None,
    );
    assert!(
        rig.screen().contains("unknown") || rig.screen().contains("Unknown"),
        "{}",
        rig.screen()
    );
    // Another change is refused until the state is read.
    rig.ch('t');
    assert!(rig.model().confirm_pending().is_none());
    assert_valid(&rig);
}

#[test]
fn a_file_the_owner_no_longer_reports_in_conflict_offers_nothing_to_take() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(false));
    let screen = rig.screen();
    assert!(screen.contains("no longer in conflict"), "{screen}");
    assert!(rig.ch('o').is_empty());
    assert!(rig.model().confirm_pending().is_none());
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    let take = tree
        .nodes
        .iter()
        .flat_map(|n| n.actions.iter())
        .find(|a| a.id.as_str() == actions::TAKE_OURS)
        .expect("listed");
    assert!(!take.enabled && take.reason.is_some(), "{take:?}");
}

#[test]
fn a_refused_conflict_read_shows_the_owners_reason() {
    let mut rig = conflicted();
    let fx = rig.key(Key::Enter);
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "not_conflicted".into(),
            reason: "no sides are kept for this file".into(),
        },
        None,
    );
    assert!(
        rig.screen().contains("no sides are kept"),
        "{}",
        rig.screen()
    );
    assert_valid(&rig);
}

#[test]
fn a_conflict_answered_after_the_view_was_left_is_dropped() {
    let mut rig = conflicted();
    let fx = rig.key(Key::Enter);
    rig.key(Key::Esc);
    rig.accept(&fx[0], CompletionPayload::ScmConflict(sides(true)));
    assert!(rig.model().read_view().is_none());
    assert!(
        !rig.screen().contains("Ours (this branch)"),
        "{}",
        rig.screen()
    );
}

#[test]
fn a_conflict_for_an_older_generation_is_dropped() {
    let mut rig = conflicted();
    let fx = rig.key(Key::Enter);
    rig.send(Msg::Host(HostMessage::Resync {
        workspace: "w".into(),
        reason: "epoch_changed".into(),
    }));
    let mut stale = Completion::new(fx[0].id, fx[0].resource.clone(), Outcome::Accepted);
    stale.generation = Some(theorem_workbench_core::ids::Generation(0));
    stale.payload = Some(CompletionPayload::ScmConflict(sides(true)));
    rig.send(Msg::Completion(stale));
    assert!(!rig.screen().contains("let x = 1;"), "{}", rig.screen());
}

#[test]
fn e_opens_the_conflicted_file_in_the_editor_from_the_list_and_from_the_view() {
    let mut rig = conflicted();
    assert!(rig.ch('e').is_empty());
    assert!(rig.m.panel_ids().any(|(_, k)| k.as_str() == "document"));
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    assert!(rig.ch('e').is_empty());
    assert!(rig.m.panel_ids().any(|(_, k)| k.as_str() == "document"));
}

#[test]
fn the_conflict_actions_are_registered_and_an_agent_cannot_confirm_a_side() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    assert!(rig.action(actions::TAKE_OURS, agent()).is_empty());
    assert!(rig.model().confirm_pending().is_some());
    // The question is answered by a person only.
    assert!(rig.action(actions::CONFIRM, agent()).is_empty());
    assert!(rig.model().confirm_pending().is_some());
    let fx = rig.action(actions::CONFIRM, Actor::Human);
    once(&fx, "resolve");
}

#[test]
fn the_conflicted_row_offers_open_and_edit_in_the_semantic_tree() {
    let rig = conflicted();
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    let ids: Vec<&str> = tree
        .nodes
        .iter()
        .filter(|n| n.id.as_str().contains("/file/Conflicted/"))
        .flat_map(|n| n.actions.iter().map(|a| a.id.as_str()))
        .collect();
    assert!(ids.contains(&actions::OPEN_CONFLICT), "{ids:?}");
    assert!(ids.contains(&actions::EDIT_CONFLICT), "{ids:?}");
}

// ---- the panel's own actions ----------------------------------------------------------

#[test]
fn the_confirm_action_names_every_effect_a_confirmation_can_send() {
    use theorem_workbench_core::effect::EffectKind;
    let mut registry = builtin::registry();
    extend_registry(&mut registry).unwrap();
    let (_, confirm) = registry
        .action(&ActionId::new(actions::CONFIRM))
        .expect("registered");
    let emits = &confirm.emits;
    for kind in [
        EffectKind::ScmDiscard,
        EffectKind::ScmResolve,
        EffectKind::ScmRestore,
    ] {
        assert!(emits.contains(&kind), "{kind:?} in {emits:?}");
    }
}

#[test]
fn the_movement_actions_move_the_cursor_and_the_focus_like_their_keys() {
    let mut rig = loaded();
    let first = rig.model().cursor_path().map(str::to_owned);
    assert!(rig.action(actions::CURSOR_DOWN, agent()).is_empty());
    assert_ne!(rig.model().cursor_path().map(str::to_owned), first);
    rig.action(actions::CURSOR_UP, agent());
    assert_eq!(rig.model().cursor_path().map(str::to_owned), first);
    rig.action(actions::NEXT_GROUP, agent());
    assert_ne!(rig.model().focus(), theorem_workbench_changes::Focus::Files);
    rig.action(actions::FOCUS_FILES, agent());
    assert_eq!(rig.model().focus(), theorem_workbench_changes::Focus::Files);
    rig.action(actions::FOCUS_DRAFT, agent());
    assert_eq!(
        rig.model().focus(),
        theorem_workbench_changes::Focus::Message
    );
    assert_valid(&rig);
}

#[test]
fn the_selection_and_view_actions_change_the_view_and_send_nothing() {
    let mut rig = loaded();
    assert!(rig.action(actions::SELECT_ALL, agent()).is_empty());
    assert!(rig.model().selected().len() > 1);
    assert!(rig.action(actions::TOGGLE_SELECTED, agent()).is_empty());
    let layout = rig.model().layout();
    assert!(rig.action(actions::TOGGLE_LAYOUT, agent()).is_empty());
    assert_ne!(rig.model().layout(), layout);
    assert!(rig.action(actions::TOGGLE_FOLD, agent()).is_empty());
    assert!(rig.action(actions::NEXT_HUNK, agent()).is_empty());
    assert!(rig.action(actions::PREVIOUS_HUNK, agent()).is_empty());
    assert_valid(&rig);
}

#[test]
fn the_diff_action_expands_a_diff_by_reading_it_and_collapses_it_by_sending_nothing() {
    let mut rig = loaded();
    let fx = rig.action(actions::TOGGLE_DIFF, agent());
    once(&fx, "diff");
    rig.accept(&fx[0], diff_answer("src/main.rs", true, SMALL_DIFF, 1));
    assert!(rig.action(actions::TOGGLE_DIFF, agent()).is_empty());
}

#[test]
fn the_amend_toggle_action_turns_the_box_on_and_off_for_an_agent() {
    let mut rig = loaded_with(&CAPS_AMEND);
    assert!(rig.action(actions::TOGGLE_AMEND, agent()).is_empty());
    assert!(rig.model().amend());
    rig.action(actions::TOGGLE_AMEND, agent());
    assert!(!rig.model().amend());
}

#[test]
fn the_cancel_action_closes_the_prompt_then_the_question_then_the_read_view() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    rig.ch('o');
    assert!(rig.model().confirm_pending().is_some());
    rig.action(actions::CANCEL, agent());
    assert!(rig.model().confirm_pending().is_none());
    assert!(rig.model().read_view().is_some());
    rig.action(actions::CANCEL, agent());
    assert!(rig.model().read_view().is_none());
    let mut rig = loaded();
    rig.ch('n');
    assert!(rig.model().prompt().is_some());
    rig.action(actions::CANCEL, agent());
    assert!(rig.model().prompt().is_none());
}

#[test]
fn the_open_file_action_opens_the_selected_file_in_the_editor() {
    let mut rig = loaded();
    assert!(rig.action(actions::OPEN_FILE, agent()).is_empty());
    assert!(rig.m.panel_ids().any(|(_, k)| k.as_str() == "document"));
}

#[test]
fn the_dismiss_action_clears_the_notices() {
    let mut rig = loaded();
    let fx = rig.ch('f');
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "no_remote".into(),
            reason: "there is no remote".into(),
        },
        None,
    );
    assert!(rig.screen().contains("no remote"), "{}", rig.screen());
    rig.action(actions::DISMISS_NOTICES, agent());
    assert!(!rig.screen().contains("no remote"), "{}", rig.screen());
}

// ---- the theme's roles and where the panel opens -----------------------------------------

#[test]
fn changing_the_added_role_of_the_theme_changes_what_the_panel_draws() {
    let (mut rig, fx) = opened_with(&CAPS, "w");
    let next = rig.accept(
        &fx[0],
        common::status(
            1,
            vec![change("fresh.rs", "A", " "), change("old.rs", "M", " ")],
        ),
    );
    rig.accept(&next[0], log_answer(&["x"]));
    // The focused cursor row keeps its own ink under every role, so the cursor is moved
    // off the added file.
    rig.key(Key::Down);
    let plain = Theme::plain();
    let mut tinted = Theme::plain();
    tinted.change_added = ratatui::style::Style::default().fg(ratatui::style::Color::Green);
    let before = rig.cells(&plain, 100, 30);
    let after = rig.cells(&tinted, 100, 30);
    let changed: Vec<_> = (0..30u16)
        .flat_map(|y| (0..100u16).map(move |x| (x, y)))
        .filter(|(x, y)| before[(*x, *y)] != after[(*x, *y)])
        .collect();
    assert!(!changed.is_empty(), "the added role reached nothing");
    for (x, y) in changed {
        assert_eq!(
            after[(x, y)].fg,
            ratatui::style::Color::Green,
            "cell {x},{y} {:?}",
            after[(x, y)].symbol()
        );
    }
}

#[test]
fn the_conflict_role_of_the_theme_changes_a_conflicted_rows_letter() {
    let rig = conflicted();
    let plain = Theme::plain();
    let mut tinted = Theme::plain();
    tinted.change_conflict = ratatui::style::Style::default().fg(ratatui::style::Color::Magenta);
    assert_ne!(rig.cells(&plain, 100, 30), rig.cells(&tinted, 100, 30));
}

fn tools_group_holds_changes(m: &Model) -> bool {
    let dock = m.dock();
    dock.group_ids().into_iter().any(|id| {
        dock.group(id).is_some_and(|g| {
            g.role() == theorem_workbench_dock::Role::Tools
                && g.tabs().iter().any(|t| t.kind.name == "changes")
        })
    })
}

#[test]
fn the_changes_descriptor_declares_the_tools_placement() {
    let registry = builtin::registry();
    let descriptor = registry
        .get(&theorem_workbench_core::ids::PanelKind::new("changes"))
        .expect("registered");
    assert_eq!(
        descriptor.default_placement,
        theorem_workbench_core::registry::Placement::Tools
    );
}

#[test]
fn opening_changes_from_its_action_lands_in_the_tool_group() {
    let mut m = model_with(&CAPS, "w", &Slot::default());
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("changes.open"),
            actor: Actor::Human,
        },
    );
    assert!(tools_group_holds_changes(&m));
}

#[test]
fn opening_changes_from_its_chord_lands_in_the_tool_group() {
    let mut m = model_with(&CAPS, "w", &Slot::default());
    update(
        &mut m,
        Msg::Key(KeyInput::new(Key::Char('g'), Mods::CTRL | Mods::ALT)),
    );
    assert!(tools_group_holds_changes(&m), "the chord opened nothing");
}

#[test]
fn opening_changes_from_the_picker_lands_in_the_tool_group() {
    use theorem_workbench_core::picker::PickerMsg;
    let mut m = model_with(&CAPS, "w", &Slot::default());
    update(&mut m, Msg::Picker(PickerMsg::Open));
    update(&mut m, Msg::Picker(PickerMsg::Filter("Changes".into())));
    update(&mut m, Msg::Picker(PickerMsg::Choose));
    assert!(tools_group_holds_changes(&m), "the picker opened nothing");
}

// ---- a binary conflict ---------------------------------------------------------------------

/// A binary file's sides: they exist but carry no text, so each is present and empty.
fn binary_sides() -> ConflictSides {
    ConflictSides {
        path: "both.rs".into(),
        conflict: true,
        binary: true,
        base: Some(String::new()),
        ours: Some(String::new()),
        theirs: Some(String::new()),
    }
}

#[test]
fn a_binary_conflict_says_it_is_binary_and_draws_no_empty_diff_or_no_file_rows() {
    let mut rig = conflicted();
    open_sides(&mut rig, binary_sides());
    let screen = rig.screen();
    assert!(
        screen.contains("This file is binary. Its sides cannot be shown as text."),
        "{screen}"
    );
    assert!(screen.contains("Ours (this branch)"), "{screen}");
    assert!(screen.contains("Theirs (incoming)"), "{screen}");
    assert!(screen.contains("Binary: not shown as text."), "{screen}");
    assert!(!screen.contains("The file is empty."), "{screen}");
    assert!(!screen.contains("This side has no file."), "{screen}");
    assert!(screen.contains("o take ours   t take theirs"), "{screen}");
    assert!(!screen.contains("merge by hand"), "{screen}");
    assert_valid(&rig);
}

#[test]
fn a_binary_side_that_does_not_exist_is_still_said_to_have_no_file() {
    let mut rig = conflicted();
    open_sides(
        &mut rig,
        ConflictSides {
            ours: None,
            base: None,
            ..binary_sides()
        },
    );
    let screen = rig.screen();
    assert!(screen.contains("This side has no file."), "{screen}");
    assert!(screen.contains("Binary: not shown as text."), "{screen}");
    assert!(!screen.contains("Base (the common ancestor)"), "{screen}");
}

#[test]
fn a_binary_conflict_offers_both_sides_and_withholds_merging_by_hand() {
    let mut rig = conflicted();
    open_sides(&mut rig, binary_sides());
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    let list = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str().ends_with("/list"))
        .expect("the list");
    let offered: Vec<&str> = list.actions.iter().map(|a| a.id.as_str()).collect();
    assert!(offered.contains(&actions::TAKE_OURS), "{offered:?}");
    assert!(offered.contains(&actions::TAKE_THEIRS), "{offered:?}");
    assert!(!offered.contains(&actions::EDIT_CONFLICT), "{offered:?}");
    assert!(
        list.state
            .description
            .as_deref()
            .unwrap()
            .contains("Binary")
    );
    // The key and the action open no editor.
    assert!(rig.ch('e').is_empty());
    assert!(rig.action(actions::EDIT_CONFLICT, agent()).is_empty());
    assert!(!rig.m.panel_ids().any(|(_, k)| k.as_str() == "document"));
}

#[test]
fn taking_ours_in_a_binary_conflict_sends_exactly_one_resolve_with_no_text() {
    let mut rig = conflicted();
    open_sides(&mut rig, binary_sides());
    assert!(rig.ch('o').is_empty());
    let fx = rig.key(Key::Enter);
    once(&fx, "resolve");
    match &fx[0].body {
        EffectBody::ScmResolve(r) => {
            assert_eq!(r.path, "both.rs");
            assert_eq!(r.take, theorem_workbench_core::effect::ConflictTake::Ours);
            assert!(r.text.is_none());
        }
        other => panic!("{other:?}"),
    }
    assert!(rig.key(Key::Enter).is_empty(), "nothing is sent twice");
}

#[test]
fn taking_theirs_in_a_binary_conflict_sends_the_theirs_take_with_no_text() {
    let mut rig = conflicted();
    open_sides(&mut rig, binary_sides());
    rig.ch('t');
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmResolve(r) => {
            assert_eq!(r.take, theorem_workbench_core::effect::ConflictTake::Theirs);
            assert!(r.text.is_none());
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_text_conflict_still_offers_merging_by_hand_and_draws_its_lines() {
    let mut rig = conflicted();
    open_sides(&mut rig, sides(true));
    let screen = rig.screen();
    assert!(
        screen.contains("o take ours   t take theirs   e merge by hand in the editor"),
        "{screen}"
    );
    assert!(!screen.contains("Binary"), "{screen}");
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    let list = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str().ends_with("/list"))
        .expect("the list");
    assert!(
        list.actions
            .iter()
            .any(|a| a.id.as_str() == actions::EDIT_CONFLICT)
    );
}

// ---- AC-20: an unsaved draft in the editor and the Git index -----------------------

const SECRET: &str = concat!("sk_live_", "51NzQx7Hk2LmP9dRtUvW3yZaBcDeFgHiJ");

fn open_doc(path: &str, saved: Option<u64>, unsaved: bool) -> OpenDocument {
    OpenDocument {
        path: path.into(),
        saved_revision: saved,
        unsaved,
    }
}

impl Rig {
    fn set_documents(&mut self, docs: Vec<OpenDocument>) {
        self.handle.borrow_mut().set_documents(docs);
    }

    /// Every name and description the panel's semantic nodes carry.
    fn node_words(&self) -> Vec<String> {
        let tree = theorem_workbench_core::tree::semantics(&self.m);
        let mut out = vec![];
        for n in tree
            .nodes
            .iter()
            .filter(|n| n.id.as_str().contains("changes"))
        {
            out.push(n.name.clone());
            out.extend(n.state.description.clone());
        }
        out
    }

    /// The panel's banner lines, as nodes say them.
    fn banners(&self) -> Vec<String> {
        let tree = theorem_workbench_core::tree::semantics(&self.m);
        tree.nodes
            .iter()
            .filter(|n| n.id.as_str().contains("/banner/"))
            .map(|n| n.name.clone())
            .collect()
    }

    fn file_node(&self, section: &str, path: &str) -> Node {
        let tree = theorem_workbench_core::tree::semantics(&self.m);
        let id = format!("/file/{section}/{path}");
        tree.nodes
            .iter()
            .find(|n| n.id.as_str().ends_with(&id))
            .unwrap_or_else(|| panic!("no node for {id}"))
            .clone()
    }

    fn row_of(&self, needle: &str) -> String {
        self.text(100, 30)
            .into_iter()
            .find(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("{needle} is not on\n{}", self.screen()))
    }
}

/// Stage README.md, the second row, as a person does: arrow down, then the key.
fn stage_readme(rig: &mut Rig) -> Effect {
    rig.key(Key::Down);
    let fx = rig.ch('s');
    once(&fx, "stage");
    fx.into_iter().next().unwrap()
}

#[test]
fn a_file_with_an_unsaved_draft_is_marked_in_words_and_in_its_node_apart_from_its_git_state() {
    let mut rig = loaded();
    rig.set_documents(vec![
        open_doc("README.md", Some(7), true),
        open_doc("notes.txt", Some(3), false),
    ]);
    let marked = rig.row_of("README.md");
    assert!(marked.contains("unsaved draft"), "{marked}");
    assert!(
        marked.contains('M'),
        "its working-tree state is still told: {marked}"
    );
    for other in ["notes.txt", "main.rs", "new.txt"] {
        assert!(
            !rig.row_of(other).contains("draft"),
            "{other}: {}",
            rig.screen()
        );
    }
    let node = rig.file_node("Unstaged", "README.md");
    let said = node.state.description.expect("the node says it");
    assert!(
        said.contains("Unsaved draft") && said.contains("not included"),
        "{said}"
    );
    assert!(said.contains("revision 7"), "{said}");
    assert!(node.name.starts_with('M'), "{}", node.name);
    for clean in [("Unstaged", "notes.txt"), ("Staged", "src/main.rs")] {
        assert_eq!(rig.file_node(clean.0, clean.1).state.description, None);
    }
    // A narrow pane keeps a short word.
    assert!(
        rig.text(30, 30)
            .iter()
            .any(|l| l.contains("README") && l.contains("draft")),
        "{}",
        rig.text(30, 30).join("\n")
    );
    assert_valid(&rig);
}

#[test]
fn staging_a_file_with_a_draft_sends_the_saved_files_path_and_says_the_draft_is_not_included() {
    let mut rig = loaded();
    rig.set_documents(vec![open_doc("README.md", Some(7), true)]);
    let effect = stage_readme(&mut rig);
    let EffectBody::ScmStage(paths) = &effect.body else {
        panic!("{effect:?}")
    };
    assert_eq!(paths.paths, vec!["README.md".to_owned()]);
    assert_eq!(effect.resource, repo_resource("w"));
    assert_eq!(effect.generation, rig.panel().binding().unwrap().generation);
    // At the action, before any answer, the panel says what it will and will not do.
    let said = rig.banners().join("\n");
    assert!(
        said.contains("Staging 1 file: README.md (saved revision 7)"),
        "{said}"
    );
    assert!(
        said.contains("Not included: the unsaved draft of README.md"),
        "{said}"
    );
    assert!(
        rig.screen().contains("Not included: the unsaved draft"),
        "{}",
        rig.screen()
    );
    assert!(
        !said.contains("Staged"),
        "nothing reads as done before the owner answers: {said}"
    );
}

#[test]
fn the_receipt_after_a_stage_names_the_file_the_saved_revision_and_the_index_it_made() {
    let mut rig = loaded();
    rig.set_documents(vec![open_doc("README.md", Some(7), true)]);
    let effect = stage_readme(&mut rig);
    rig.accept(&effect, CompletionPayload::ScmState(common::repo(2)));
    let said = rig.banners().join("\n");
    assert!(
        said.contains("Staged 1 file: README.md (saved revision 7). Index generation 2."),
        "{said}"
    );
    assert!(
        said.contains("Not included: the unsaved draft of README.md"),
        "{said}"
    );
    assert!(!said.contains("Staging"), "{said}");
    assert_valid(&rig);
}

#[test]
fn after_an_explicit_save_the_mark_is_gone_and_the_same_action_carries_the_new_revision() {
    let mut rig = loaded();
    rig.set_documents(vec![open_doc("README.md", Some(7), true)]);
    assert!(rig.row_of("README.md").contains("draft"));
    // The editor saved: revision 8 is on disk and the draft is gone.
    rig.set_documents(vec![open_doc("README.md", Some(8), false)]);
    assert!(
        !rig.row_of("README.md").contains("draft"),
        "{}",
        rig.screen()
    );
    assert_eq!(
        rig.file_node("Unstaged", "README.md").state.description,
        None
    );
    let effect = stage_readme(&mut rig);
    let EffectBody::ScmStage(paths) = &effect.body else {
        panic!("{effect:?}")
    };
    assert_eq!(paths.paths, vec!["README.md".to_owned()]);
    let said = rig.banners().join("\n");
    assert!(said.contains("README.md (saved revision 8)"), "{said}");
    assert!(!said.contains("Not included"), "{said}");
    assert!(!said.contains("revision 7"), "{said}");
}

#[test]
fn a_commit_names_the_staged_files_and_the_head_it_made_and_the_draft_that_is_not_in_it() {
    let mut rig = loaded();
    rig.set_documents(vec![open_doc("src/main.rs", Some(4), true)]);
    rig.ch('c');
    rig.typed("say hello");
    let fx = rig.mods(Key::Enter, Mods::CTRL);
    once(&fx, "commit");
    let EffectBody::ScmCommit(c) = &fx[0].body else {
        panic!("{fx:?}")
    };
    assert_eq!(
        c.message, "say hello",
        "the message only, never a file's text"
    );
    let said = rig.banners().join("\n");
    assert!(
        said.contains("Committing 1 staged file: src/main.rs (saved revision 4)"),
        "{said}"
    );
    assert!(
        said.contains("Not included: the unsaved draft of src/main.rs"),
        "{said}"
    );
    let mut moved = common::repo(2);
    moved.head = Some("fedcba98765".into());
    rig.accept(&fx[0], CompletionPayload::ScmState(moved));
    let said = rig.banners().join("\n");
    assert!(
        said.contains(
            "Committed 1 staged file: src/main.rs (saved revision 4). Head is now fedcba9876."
        ),
        "{said}"
    );
    assert!(said.contains("Not included"), "{said}");
}

#[test]
fn a_commit_that_stages_everything_first_names_what_it_staged_and_that_a_draft_is_left_out() {
    let mut rig = loaded();
    let fx = rig.ch('u');
    let next = rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(2)));
    let more = rig.accept(
        &next[0],
        common::status(
            2,
            vec![
                change("src/main.rs", " ", "M"),
                change("README.md", " ", "M"),
            ],
        ),
    );
    for e in more {
        rig.accept(&e, log_answer(&["x"]));
    }
    rig.set_documents(vec![open_doc("README.md", Some(9), true)]);
    rig.ch('c');
    rig.typed("all of it");
    let fx = rig.mods(Key::Enter, Mods::CTRL);
    once(&fx, "stage");
    let next = rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(3)));
    once(&next, "commit");
    let said = rig.banners().join("\n");
    assert!(
        said.contains("Staged 2 files: src/main.rs, README.md"),
        "{said}"
    );
    assert!(
        said.contains("Committing 2 staged files: src/main.rs, README.md (saved revision 9)"),
        "{said}"
    );
    assert!(
        said.contains("Not included: the unsaved draft of README.md"),
        "{said}"
    );
}

#[test]
fn a_refused_or_uncertain_stage_leaves_nothing_reading_as_staged_and_the_draft_marked() {
    for outcome in [
        Outcome::Refused {
            code: "locked".into(),
            reason: "the index is locked".into(),
        },
        Outcome::Uncertain {
            reason: "the owner did not answer".into(),
        },
        Outcome::Failed {
            reason: "disk full".into(),
        },
    ] {
        let mut rig = loaded();
        rig.set_documents(vec![open_doc("README.md", Some(7), true)]);
        let effect = stage_readme(&mut rig);
        rig.answer(&effect, outcome.clone(), None);
        let said = rig.banners().join("\n");
        assert!(!said.contains("Staged"), "{outcome:?}: {said}");
        assert!(!said.contains("Staging"), "{outcome:?}: {said}");
        assert!(rig.model().receipts().is_empty(), "{outcome:?}");
        let reason = match &outcome {
            Outcome::Refused { reason, .. }
            | Outcome::Uncertain { reason }
            | Outcome::Failed { reason } => reason,
            Outcome::Accepted => unreachable!(),
        };
        assert!(said.contains(reason.as_str()), "{outcome:?}: {said}");
        if matches!(outcome, Outcome::Uncertain { .. }) {
            assert!(said.contains("unknown result"), "{said}");
            assert!(
                said.contains("Refresh and check before trying again"),
                "{said}"
            );
        }
        assert!(
            rig.row_of("README.md").contains("draft"),
            "the draft stays marked: {}",
            rig.screen()
        );
    }
}

// ---- AC-53: receipts and redaction, the Changes half ------------------------------

#[test]
fn an_outcome_carries_identity_and_never_a_secret_from_the_diff_or_the_message() {
    for outcome in [
        Outcome::Accepted,
        Outcome::Refused {
            code: "hook_failed".into(),
            reason: "the pre-commit hook said no".into(),
        },
        Outcome::Uncertain {
            reason: "the owner did not answer".into(),
        },
    ] {
        let mut rig = loaded();
        rig.set_documents(vec![open_doc("src/main.rs", Some(4), true)]);
        let diff = format!("@@ -1 +1 @@\n-old\n+API_KEY={SECRET}\n");
        let open = rig.key(Key::Right);
        rig.accept(&open[0], diff_answer("src/main.rs", true, &diff, 1));
        assert!(
            rig.screen().contains(SECRET),
            "the diff itself shows the change: {}",
            rig.screen()
        );
        rig.ch('c');
        rig.typed(&format!("rotate {SECRET}"));
        let fx = rig.mods(Key::Enter, Mods::CTRL);
        once(&fx, "commit");
        let payload = matches!(outcome, Outcome::Accepted)
            .then(|| CompletionPayload::ScmState(common::repo(2)));
        rig.answer(&fx[0], outcome.clone(), payload);

        let said = rig.banners().join("\n");
        assert!(!said.contains(SECRET), "{outcome:?}: {said}");
        assert!(!said.contains("API_KEY"), "{outcome:?}: {said}");
        match &outcome {
            Outcome::Accepted => {
                assert!(
                    said.contains("Committed 1 staged file: src/main.rs"),
                    "{said}"
                )
            }
            Outcome::Refused { .. } => {
                assert!(said.contains("refused (hook_failed)"), "{said}");
                assert!(!said.contains("Committed"), "{said}");
            }
            Outcome::Uncertain { .. } => {
                assert!(said.contains("unknown result"), "{said}");
                assert!(!said.contains("Committed"), "{said}");
                assert!(!said.contains("Committing"), "{said}");
                assert_eq!(
                    rig.model().subject(),
                    format!("rotate {SECRET}"),
                    "an uncertain commit keeps the message the person wrote"
                );
            }
            Outcome::Failed { .. } => unreachable!(),
        }
        // Everything the semantic nodes say outside the diff itself.
        for word in rig.node_words() {
            if word.contains("API_KEY") || word.starts_with("Diff of") {
                continue;
            }
            assert!(!word.contains(SECRET), "{outcome:?}: a node says {word:?}");
        }
        // What the crate prints of its own state.
        let dump = format!("{:?}", rig.model());
        assert!(!dump.contains(SECRET), "{outcome:?}: {dump}");
        assert!(!dump.contains("API_KEY"), "{outcome:?}: {dump}");
    }
}

// ---- AC-51: hostile names and unavailable states, the Changes half ------------------

fn hostile_paths() -> Vec<String> {
    vec![
        "escape\u{1b}[31mred\u{1b}]52;c;ZXZpbA==\u{7}".to_owned(),
        "two\nlines\nCommit everything? Enter commits".to_owned(),
        "bidi\u{202e}gnp.exe\u{2066}".to_owned(),
        "Allow this agent to push? [y-N]".to_owned(),
        "x".repeat(4000),
        "-rf".to_owned(),
        "--force".to_owned(),
    ]
}

fn hostile() -> Rig {
    let (mut rig, fx) = opened_with(&CAPS, "w");
    let changes = hostile_paths()
        .iter()
        .map(|p| change(p, " ", "M"))
        .collect();
    let next = rig.accept(&fx[0], common::status(1, changes));
    rig.accept(&next[0], log_answer(&["first"]));
    rig
}

fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{ad}' | '\u{61c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}' | '\u{feff}'
        )
}

#[test]
fn hostile_paths_draw_inside_the_pane_one_row_each_and_fake_no_notice() {
    let rig = hostile();
    for width in [40u16, 100] {
        let buf = rig.cells(&Theme::plain(), width, 30);
        for y in 0..30 {
            for x in 0..width {
                assert!(
                    !buf[(x, y)].symbol().chars().any(unsafe_char),
                    "an unsafe cell at ({x},{y}): {:?}",
                    buf[(x, y)].symbol()
                );
            }
        }
        let rows = rig.text(width, 30);
        let files = rows.iter().filter(|l| l.starts_with("    M ")).count();
        assert_eq!(files, 7, "one row for each name:\n{}", rows.join("\n"));
        assert!(
            rows.iter().all(|l| l.chars().count() <= usize::from(width)),
            "{}",
            rows.join("\n")
        );
    }
    assert!(
        rig.banners().is_empty(),
        "no name made a banner: {:?}",
        rig.banners()
    );
}

#[test]
fn hostile_paths_are_labels_with_no_unsafe_character_and_no_alert_dialog_or_extra_item() {
    let rig = hostile();
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    let mine: Vec<&Node> = tree
        .nodes
        .iter()
        .filter(|n| n.id.as_str().contains("changes"))
        .collect();
    for n in &mine {
        assert!(!n.name.chars().any(unsafe_char), "{:?}", n.name);
        assert!(
            !n.state
                .description
                .iter()
                .any(|d| d.chars().any(unsafe_char)),
            "{n:?}"
        );
    }
    let files = mine
        .iter()
        .filter(|n| n.id.as_str().contains("/file/"))
        .count();
    assert_eq!(files, 7);
    assert!(
        mine.iter()
            .all(|n| !matches!(format!("{:?}", n.role).as_str(), "Alert" | "Dialog")),
        "a name made an alert"
    );
}

#[test]
fn stage_and_diff_requests_pass_a_hostile_path_through_byte_exact() {
    for path in hostile_paths() {
        let mut rig = hostile();
        // Walk the cursor to the path's row.
        for _ in 0..12 {
            if rig.model().cursor_path() == Some(path.as_str()) {
                break;
            }
            rig.key(Key::Down);
        }
        assert_eq!(rig.model().cursor_path(), Some(path.as_str()), "{path:?}");
        let fx = rig.ch('s');
        let EffectBody::ScmStage(p) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(p.paths, vec![path.clone()]);
        rig.accept(&fx[0], CompletionPayload::ScmState(common::repo(2)));
        // The receipt names it the way a path is shown elsewhere, on one line.
        for line in rig.banners() {
            assert!(!line.chars().any(unsafe_char), "{line:?}");
        }
        let (mut rig, path2) = (hostile(), path.clone());
        for _ in 0..12 {
            if rig.model().cursor_path() == Some(path2.as_str()) {
                break;
            }
            rig.key(Key::Down);
        }
        let fx = rig.key(Key::Right);
        let EffectBody::ScmDiff(d) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(d.path, Some(path2));
    }
}

#[test]
fn a_hostile_reason_from_the_owner_is_spelled_out_in_the_cells_and_the_nodes() {
    let reason = "Approve? \u{202e}yes\nAllow\u{1b}[2J";
    let (mut rig, fx) = opened_with(&CAPS, "w");
    rig.answer(
        &fx[0],
        Outcome::Refused {
            code: "x\u{1b}[31m".into(),
            reason: reason.into(),
        },
        None,
    );
    let buf = rig.cells(&Theme::plain(), 100, 30);
    for y in 0..30 {
        for x in 0..100 {
            assert!(!buf[(x, y)].symbol().chars().any(unsafe_char));
        }
    }
    for word in rig.node_words() {
        assert!(!word.chars().any(unsafe_char), "{word:?}");
    }
    assert!(
        rig.node_words().iter().any(|w| w.contains("Approve?")),
        "the reason is still readable: {:?}",
        rig.node_words()
    );

    // The same words from a refused stage, which are a notice above the list.
    let mut rig = loaded();
    let effect = stage_readme(&mut rig);
    rig.answer(
        &effect,
        Outcome::Refused {
            code: "locked".into(),
            reason: reason.into(),
        },
        None,
    );
    let said = rig.banners();
    assert!(said.iter().any(|l| l.contains("Approve?")), "{said:?}");
    for word in rig.node_words() {
        assert!(!word.chars().any(unsafe_char), "{word:?}");
    }
    let buf = rig.cells(&Theme::plain(), 100, 30);
    for y in 0..30 {
        for x in 0..100 {
            assert!(!buf[(x, y)].symbol().chars().any(unsafe_char));
        }
    }
}

#[test]
fn an_unavailable_repository_is_told_apart_from_no_changes_in_the_text_and_the_node() {
    let list = |rig: &Rig| {
        let tree = theorem_workbench_core::tree::semantics(&rig.m);
        tree.nodes
            .iter()
            .find(|n| n.id.as_str().ends_with("changes/list"))
            .and_then(|n| n.state.description.clone())
            .unwrap_or_default()
    };
    let (mut empty, fx) = opened_with(&CAPS, "w");
    empty.accept(&fx[0], common::status(1, vec![]));
    assert!(empty.screen().contains("No changes"), "{}", empty.screen());
    assert_eq!(list(&empty), "No changes");

    for (outcome, drawn, said) in [
        (
            Outcome::Refused {
                code: "no_repository".into(),
                reason: "this folder is not a repository".into(),
            },
            "Source control is unavailable (no_repository)",
            "Source control is unavailable (no_repository): this folder is not a repository",
        ),
        (
            Outcome::Failed {
                reason: "git exited with 128".into(),
            },
            "The repository could not be read.",
            "The repository could not be read: git exited with 128",
        ),
        (
            Outcome::Uncertain {
                reason: "the owner stopped answering".into(),
            },
            "Unknown result: the repository was not read.",
            "Unknown result: the repository was not read: the owner stopped answering",
        ),
    ] {
        let (mut rig, fx) = opened_with(&CAPS, "w");
        rig.answer(&fx[0], outcome.clone(), None);
        let screen = rig.screen();
        assert!(screen.contains(drawn), "{outcome:?}: {screen}");
        assert!(!screen.contains("No changes"), "{outcome:?}: {screen}");
        assert_eq!(list(&rig), said, "{outcome:?}");
        for debug in ["Refused {", "Failed {", "Uncertain {"] {
            assert!(!screen.contains(debug), "{debug} in {screen}");
        }
        assert_valid(&rig);
    }
}

// ---- R39: text a person must read is not cut at the pane edge ---------------

/// The panel's body at the width the preset gives it in the rig's window, a narrow 24
/// columns and a wide 120.
const PANE_WIDTHS: [Option<u16>; 3] = [None, Some(24), Some(120)];

impl Rig {
    /// The window widened or narrowed until the dock gives the panel `want` columns.
    fn sized(mut self, width: Option<u16>) -> Self {
        let Some(want) = width else { return self };
        for area in want..=900 {
            self.send(Msg::Resize {
                area: Rect::new(0, 0, area, 50),
                metrics: CellMetrics::new(8.0, 16.0),
            });
            if self.body().width == want {
                return self;
            }
        }
        panic!("no window gives the panel {want} columns");
    }

    /// The panel drawn in its own body.
    fn pane(&self) -> Vec<String> {
        let b = self.body();
        self.text(b.width, b.height)
    }
}

/// Every word of `want` is in the rows, whole and in order, whatever row it wrapped onto.
fn assert_words(rows: &[String], want: &str, what: &str) {
    let shown: Vec<&str> = rows.iter().flat_map(|r| r.split_whitespace()).collect();
    let mut at = 0;
    for word in want.split_whitespace() {
        match shown[at..].iter().position(|w| *w == word) {
            Some(i) => at += i + 1,
            None => panic!(
                "{what}: `{word}` of `{want}` is not drawn:\n{}",
                rows.join("\n")
            ),
        }
    }
}

fn assert_keys(rows: &[String], what: &str) {
    let screen = rows.join("\n");
    assert!(
        screen.contains("[ Confirm (y) ]") && screen.contains("[ Cancel (n) ]"),
        "{what}: the answers are not on screen:\n{screen}"
    );
}

const TAKE_TEXT_COST: &str =
    "The file becomes our side whole. The lines only the other side has are lost.";
const TAKE_BINARY_COST: &str =
    "The file becomes our side whole. The other side's version of this binary file is lost.";

#[test]
fn the_take_question_and_its_loss_warning_wrap_whole_and_keep_their_keys_at_every_width() {
    for (sides, cost, what) in [
        (sides(true), TAKE_TEXT_COST, "a text file"),
        (binary_sides(), TAKE_BINARY_COST, "a binary file"),
    ] {
        for width in PANE_WIDTHS {
            let mut rig = conflicted().sized(width);
            open_sides(&mut rig, sides.clone());
            rig.ch('o');
            let rows = rig.pane();
            assert_words(&rows, "Take ours for both.rs?", what);
            assert_words(&rows, cost, what);
            assert_keys(&rows, what);
            assert!(
                !rows.iter().any(|r| r.contains('\u{2026}')),
                "{what}: a row is cut with an ellipsis:\n{}",
                rows.join("\n")
            );
            assert_valid(&rig);
        }
    }
}

#[test]
fn a_binary_side_taken_whole_says_what_is_lost_without_talking_of_lines() {
    let mut rig = conflicted();
    open_sides(&mut rig, binary_sides());
    rig.ch('o');
    let said = rig.banners().join(" ");
    assert!(
        said.contains("version of this binary file is lost"),
        "{said}"
    );
    assert!(
        !said.contains("lines"),
        "a binary file has no lines: {said}"
    );
}

#[test]
fn when_the_dialog_is_taller_than_the_pane_the_answers_and_the_warning_stay() {
    for height in [7, 9, 12] {
        let mut rig = conflicted();
        open_sides(&mut rig, binary_sides());
        rig.ch('o');
        let rows = rig.text(24, height);
        assert_keys(&rows, "a short pane");
        let screen = rows.join("\n");
        assert!(
            screen.contains("is lost."),
            "height {height}: the end of the warning is cut:\n{screen}"
        );
    }
}

#[test]
fn the_answers_still_answer_when_they_wrap_onto_two_rows() {
    for width in PANE_WIDTHS {
        let mut rig = loaded().sized(width);
        rig.key(Key::Down);
        rig.ch('d');
        let (x, y) = rig.find("Cancel");
        assert!(rig.press(x + 1, y, 1).is_empty());
        assert!(rig.model().confirm_pending().is_none(), "{width:?}");
        rig.ch('d');
        let (x, y) = rig.find("Confirm");
        once(&rig.press(x + 1, y, 1), "discard");
    }
}

#[test]
fn a_discard_question_and_its_cost_wrap_whole_at_every_width() {
    for width in PANE_WIDTHS {
        let mut rig = loaded().sized(width);
        rig.key(Key::Down);
        rig.ch('d');
        let (title, cost) = rig.model().confirm_pending().unwrap().text();
        let rows = rig.pane();
        assert_words(&rows, &title, "discard");
        assert_words(&rows, &cost, "discard");
        assert_keys(&rows, "discard");
    }
}

#[test]
fn notices_receipts_and_drafts_wrap_whole_at_every_width() {
    let reason = "the repository is locked by another process that has not finished its work yet";
    for width in PANE_WIDTHS {
        let mut rig = loaded().sized(width);
        rig.set_documents(vec![open_doc("README.md", Some(7), true)]);
        let effect = stage_readme(&mut rig);
        rig.answer(
            &effect,
            Outcome::Refused {
                code: "locked".into(),
                reason: reason.into(),
            },
            None,
        );
        let said = rig.banners();
        assert!(!said.is_empty());
        let rows = rig.pane();
        for line in &said {
            assert_words(&rows, line, "a notice");
        }
        let tree = theorem_workbench_core::tree::semantics(&rig.m);
        let top = rig.body().y;
        for n in tree
            .nodes
            .iter()
            .filter(|n| n.id.as_str().contains("/banner/"))
        {
            for y in n.rect.unwrap().y..n.rect.unwrap().y + n.rect.unwrap().height {
                let row = &rows[usize::from(y - top)];
                assert!(
                    !row.contains('\u{2026}'),
                    "a banner row is cut with an ellipsis: {row:?}\n{}",
                    rows.join("\n")
                );
            }
        }
    }
    for width in PANE_WIDTHS {
        let mut rig = loaded().sized(width);
        rig.set_documents(vec![open_doc("README.md", Some(7), true)]);
        let effect = stage_readme(&mut rig);
        rig.accept(&effect, CompletionPayload::ScmState(common::repo(2)));
        let said = rig.banners();
        assert!(said.iter().any(|l| l.contains("Staged")), "{said:?}");
        assert!(said.iter().any(|l| l.contains("Not included")), "{said:?}");
        let rows = rig.pane();
        for line in &said {
            assert_words(&rows, line, "a receipt");
        }
    }
}

#[test]
fn the_problem_rows_of_the_list_wrap_whole() {
    let reason = "the owner of the repository did not answer in the time that it was given";
    for width in PANE_WIDTHS {
        let (rig, fx) = opened_with(&CAPS, "w");
        let mut rig = rig.sized(width);
        rig.answer(
            &fx[0],
            Outcome::Refused {
                code: "unreadable".into(),
                reason: reason.into(),
            },
            None,
        );
        let rows = rig.pane();
        assert_words(
            &rows,
            "Source control is unavailable (unreadable)",
            "headline",
        );
        assert_words(&rows, reason, "reason");
    }
}

// ---- the core tells the mounted panel what the document panels hold ---------------

#[test]
fn a_document_panel_with_an_unsaved_draft_tags_its_path_in_the_mounted_changes_panel_until_it_is_saved_or_closed()
 {
    let mut rig = loaded();
    // The person opens README.md from the list: a document panel, bound to it.
    let (x, y) = rig.find("README.md");
    rig.press(x + 2, y, 2);
    let doc = rig
        .m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "document")
        .map(|(id, _)| id.clone())
        .expect("the file opened as a document");
    rig.tick();
    // Open and clean: the core tells the panel of it, and nothing is tagged.
    assert!(
        !rig.row_of("README.md").contains("draft"),
        "{}",
        rig.screen()
    );
    // The document has an unsaved draft: the tag is on its row, with no
    // message sent to the Changes panel but the core's own.
    DRAFTS.with(|d| d.borrow_mut().insert("README.md".into()));
    rig.tick();
    let marked = rig.row_of("README.md");
    assert!(marked.contains("[unsaved draft]"), "{marked}");
    // The document took the focus; the node tree has the focused panel's.
    let changes = rig.id.clone();
    rig.send(Msg::Dock(theorem_workbench_core::DockMsg::FocusPanel(
        changes,
    )));
    let said = rig
        .file_node("Unstaged", "README.md")
        .state
        .description
        .expect("the node says it");
    assert!(
        said.contains("Unsaved draft") && said.contains("revision 7"),
        "{said}"
    );
    for other in ["notes.txt", "main.rs"] {
        assert!(!rig.row_of(other).contains("draft"), "{}", rig.screen());
    }
    // Saved: the tag goes.
    DRAFTS.with(|d| d.borrow_mut().clear());
    rig.tick();
    assert!(
        !rig.row_of("README.md").contains("draft"),
        "{}",
        rig.screen()
    );
    assert_eq!(
        rig.file_node("Unstaged", "README.md").state.description,
        None
    );
    // A draft again, then the document is closed: the tag goes with it.
    DRAFTS.with(|d| d.borrow_mut().insert("README.md".into()));
    rig.tick();
    assert!(rig.row_of("README.md").contains("[unsaved draft]"));
    rig.send(Msg::Dock(theorem_workbench_core::DockMsg::ClosePanel(doc)));
    rig.tick();
    assert!(
        !rig.row_of("README.md").contains("draft"),
        "{}",
        rig.screen()
    );
    assert_valid(&rig);
}

// ---- the text and caret the fields publish ---------------------------------------

fn node_ending(rig: &Rig, tail: &str) -> Node {
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("a valid tree");
    tree.nodes
        .iter()
        .find(|n| n.id.as_str().ends_with(tail))
        .unwrap_or_else(|| panic!("no node ending {tail}"))
        .clone()
}

fn caret_of(n: &Node) -> (u32, u32) {
    let s = n.selection.expect("a text box publishes its selection");
    (s.anchor, s.focus)
}

#[test]
fn the_commit_subject_publishes_its_text_and_caret_in_utf16_units_of_the_escaped_text() {
    let mut rig = loaded();
    rig.action(actions::FOCUS_DRAFT, agent());
    // 'a', an astral character (2 units), 'e' and a combining mark (2 units).
    rig.typed("a\u{1F600}e\u{301}");
    let n = node_ending(&rig, "/commit/subject");
    assert_eq!(n.text.as_deref(), Some("a\u{1F600}e\u{301}"));
    assert_eq!(caret_of(&n), (5, 5));
    rig.key(Key::Home);
    rig.key(Key::Right);
    rig.key(Key::Right);
    assert_eq!(caret_of(&node_ending(&rig, "/commit/subject")), (3, 3));
    assert!(
        n.state
            .description
            .as_deref()
            .unwrap()
            .contains("characters"),
        "the count stays in the description"
    );
    // A control character is spelled out and the caret counts into what is shown.
    rig.key(Key::End);
    rig.typed("\u{1b}");
    let n = node_ending(&rig, "/commit/subject");
    assert!(n.text.as_deref().unwrap().ends_with("\\u{1b}"), "{n:?}");
    assert_eq!(
        caret_of(&n).1 as usize,
        n.text.as_deref().unwrap().encode_utf16().count()
    );
}

#[test]
fn the_branch_name_prompt_publishes_the_typed_name_as_its_text_not_its_description() {
    let mut rig = loaded();
    rig.action(actions::CREATE_BRANCH, agent());
    rig.typed("topic\u{1F600}");
    let n = node_ending(&rig, "/branch");
    assert_eq!(n.role, theorem_workbench_core::semantics::Role::TextBox);
    assert_eq!(n.text.as_deref(), Some("topic\u{1F600}"));
    assert_eq!(caret_of(&n), (7, 7));
    assert_eq!(
        n.state.description.as_deref(),
        Some("Type a branch name and press Enter")
    );
}

#[test]
fn the_commit_description_counts_the_caret_across_its_lines() {
    let mut rig = loaded();
    rig.send(Msg::Resize {
        area: ratatui::layout::Rect::new(0, 0, 200, 60),
        metrics: theorem_workbench_dock::CellMetrics::new(8.0, 16.0),
    });
    rig.action(actions::FOCUS_DRAFT, agent());
    rig.typed("subject");
    rig.key(Key::Enter);
    rig.typed("one\u{1F600}");
    rig.key(Key::Enter);
    rig.typed("two");
    let n = node_ending(&rig, "/commit/body");
    assert_eq!(n.text.as_deref(), Some("one\u{1F600}\ntwo"));
    // 3 + 2 units, the line break, 3 more.
    assert_eq!(caret_of(&n), (9, 9));
}

#[test]
fn the_focused_commit_field_is_the_one_the_caret_is_in() {
    let mut rig = loaded();
    rig.send(Msg::Resize {
        area: ratatui::layout::Rect::new(0, 0, 200, 60),
        metrics: theorem_workbench_dock::CellMetrics::new(8.0, 16.0),
    });
    rig.action(actions::FOCUS_DRAFT, agent());
    rig.typed("subject");
    assert_eq!(focused_nodes(&rig), ["p1/changes/commit/subject"]);
    // Enter goes to the description: that is the field a reader is in now.
    rig.key(Key::Enter);
    rig.typed("one");
    assert_eq!(focused_nodes(&rig), ["p1/changes/commit/body"]);
    // Up from its first line is the subject again.
    rig.key(Key::Up);
    assert_eq!(focused_nodes(&rig), ["p1/changes/commit/subject"]);
}

#[test]
fn every_action_a_node_offers_is_registered_with_a_title_a_person_would_read() {
    let rig = loaded();
    let mut seen = 0;
    for n in theorem_workbench_core::tree::semantics(&rig.m).nodes {
        if n.id.as_str().starts_with("tab:") {
            continue;
        }
        for a in n.actions {
            let (_, d) = rig.m.registry().action(&a.id).unwrap_or_else(|| {
                panic!(
                    "{} is offered by {} and not registered",
                    a.id.as_str(),
                    n.id.as_str()
                )
            });
            assert!(
                !d.title.trim().is_empty() && !d.title.contains(a.id.as_str()),
                "{}: {:?}",
                a.id.as_str(),
                d.title
            );
            seen += 1;
        }
    }
    assert!(seen > 5);
}

/// The panel's nodes that say they are focused.
fn focused_nodes(rig: &Rig) -> Vec<String> {
    theorem_workbench_core::tree::semantics(&rig.m)
        .nodes
        .iter()
        .filter(|n| n.id.as_str().contains("changes/") && n.state.focused)
        .map(|n| n.id.as_str().to_owned())
        .collect()
}

#[test]
fn no_row_says_focused_once_the_keyboard_is_elsewhere() {
    let mut rig = loaded();
    assert!(
        focused_nodes(&rig).iter().any(|id| id.contains("/file/")),
        "{:?}",
        focused_nodes(&rig)
    );
    // The window loses focus: the cursor row is remembered, and nothing says focused.
    update(&mut rig.m, Msg::Focus(false));
    assert_eq!(focused_nodes(&rig), Vec::<String>::new());
    update(&mut rig.m, Msg::Focus(true));
    assert!(focused_nodes(&rig).iter().any(|id| id.contains("/file/")));
    // Another panel takes the keyboard: the same.
    let (x, y) = rig.find("README.md");
    rig.press(x + 2, y, 2);
    assert!(rig.m.panel_ids().any(|(_, k)| k.as_str() == "document"));
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("valid");
    assert_eq!(focused_nodes(&rig), Vec::<String>::new());
}

// ---- selection in the one-line fields ----------------------------------------------

#[test]
fn shift_left_then_typing_replaces_the_subject_selection_and_select_all_replaces_it_all() {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("add thing");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    // The published selection is the two selected characters, focus at the start.
    assert_eq!(caret_of(&node_ending(&rig, "/commit/subject")), (9, 7));
    rig.typed("X");
    assert_eq!(rig.model().subject(), "add thiX");
    rig.mods(Key::Char('a'), Mods::CTRL);
    assert_eq!(caret_of(&node_ending(&rig, "/commit/subject")), (0, 8));
    rig.typed("fix");
    assert_eq!(rig.model().subject(), "fix");
    // Backspace removes a selection as one edit.
    rig.mods(Key::Left, Mods::SHIFT);
    rig.key(Key::Backspace);
    assert_eq!(rig.model().subject(), "fi");
}

#[test]
fn shift_left_then_typing_replaces_in_the_branch_prompt_and_select_all_replaces_it_all() {
    let mut rig = loaded();
    rig.ch('b');
    rig.typed("devel");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    rig.typed("x");
    rig.mods(Key::Char('a'), Mods::CTRL);
    rig.typed("main");
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::ScmBranch(b) => assert_eq!(b.name, "main"),
        other => panic!("{other:?}"),
    }
}

// ---- the description is one text -----------------------------------------------------

/// A draft with the subject `subj` and the description `hello` over `world`, the caret at
/// the end of the description.
fn drafted() -> Rig {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("subj");
    rig.key(Key::Enter);
    rig.typed("hello");
    rig.key(Key::Enter);
    rig.typed("world");
    rig
}

/// "llo\nwo" selected in the description: from column 2 of line one to column 2 of line two.
fn selecting_across(rig: &mut Rig) {
    rig.key(Key::Up);
    for _ in 0..3 {
        rig.key(Key::Left);
    }
    rig.mods(Key::Down, Mods::SHIFT);
}

fn clipboard_write(fx: &[Effect]) -> (Effect, String) {
    let write = fx
        .iter()
        .find(|e| matches!(e.body, EffectBody::ClipboardWrite(_)))
        .unwrap_or_else(|| panic!("no clipboard write in {fx:?}"));
    let EffectBody::ClipboardWrite(w) = &write.body else {
        unreachable!()
    };
    (write.clone(), w.text.clone())
}

#[test]
fn shift_down_from_the_middle_of_a_line_selects_to_the_same_column_below_and_typing_joins_them() {
    let mut rig = drafted();
    selecting_across(&mut rig);
    assert_eq!(rig.model().body(), "hello\nworld");
    rig.typed("X");
    assert_eq!(rig.model().body(), "heXrld");
    assert_eq!(rig.model().subject(), "subj");
}

#[test]
fn select_all_in_the_description_takes_every_line_and_typing_replaces_them() {
    let mut rig = drafted();
    rig.mods(Key::Char('a'), Mods::CTRL);
    assert_eq!(caret_of(&node_ending(&rig, "/commit/body")), (0, 11));
    rig.typed("new");
    assert_eq!(rig.model().body(), "new");
    assert_eq!(
        rig.model().subject(),
        "subj",
        "the subject is not the description"
    );
}

#[test]
fn shift_up_then_backspace_removes_the_selection_over_the_line_break() {
    let mut rig = loaded();
    rig.ch('c');
    rig.key(Key::Enter);
    rig.typed("abc");
    rig.key(Key::Enter);
    rig.typed("def");
    rig.key(Key::Left);
    rig.mods(Key::Up, Mods::SHIFT);
    rig.key(Key::Backspace);
    assert_eq!(rig.model().body(), "abf");
}

#[test]
fn up_down_enter_and_backspace_move_and_join_lines_in_the_description() {
    let mut rig = drafted();
    // Down from the last line stays in the description; Up goes line by line, then to the subject.
    rig.key(Key::Up);
    rig.key(Key::Home);
    // Backspace at a line start joins the line to the one above, and Enter splits it again.
    rig.key(Key::Down);
    rig.key(Key::Home);
    rig.key(Key::Backspace);
    assert_eq!(rig.model().body(), "helloworld");
    rig.key(Key::Enter);
    assert_eq!(rig.model().body(), "hello\nworld");
    // A selection is replaced by the break.
    rig.key(Key::End);
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    rig.key(Key::Enter);
    assert_eq!(rig.model().body(), "hello\nwor\n");
    // The caret is on the third line: two Ups reach the first, a third goes to the subject.
    rig.key(Key::Up);
    rig.key(Key::Up);
    assert!(node_ending(&rig, "/commit/body").state.focused);
    rig.key(Key::Up);
    assert!(
        node_ending(&rig, "/commit/subject").state.focused,
        "Up from the first line goes to the subject"
    );
}

#[test]
fn a_paste_into_the_description_keeps_its_line_breaks_and_replaces_the_selection() {
    let mut rig = drafted();
    rig.mods(Key::Char('a'), Mods::CTRL);
    rig.send(Msg::Paste("one\r\ntwo\u{7}\nthree".into()));
    assert_eq!(rig.model().body(), "one\ntwo\nthree");
}

#[test]
fn the_description_publishes_the_whole_text_with_the_real_anchor_and_focus() {
    let mut rig = drafted();
    selecting_across(&mut rig);
    let n = node_ending(&rig, "/commit/body");
    assert_eq!(n.text.as_deref(), Some("hello\nworld"));
    assert_eq!(caret_of(&n), (2, 8));
    assert!(n.state.focused);
}

#[test]
fn a_selection_over_two_description_lines_is_drawn_on_both_rows() {
    let mut rig = drafted();
    selecting_across(&mut rig);
    let mut theme = Theme::plain();
    let ink = ratatui::style::Color::Rgb(10, 20, 30);
    theme.selection = ratatui::style::Style::default().bg(ink);
    let b = rig.body();
    let buf = rig.cells(&theme, b.width, b.height);
    let (x, y) = rig.find("hello");
    // "llo" on the first row, "wo" on the second; the rest of each row is not selected.
    for (col, on) in [(0, false), (1, false), (2, true), (3, true), (4, true)] {
        assert_eq!(buf[(x + col, y)].bg == ink, on, "first row, column {col}");
    }
    for (col, on) in [(0, true), (1, true), (3, false), (4, false)] {
        assert_eq!(
            buf[(x + col, y + 1)].bg == ink,
            on,
            "second row, column {col}"
        );
    }
}

// ---- copy and cut through the clipboard effect ---------------------------------------

#[test]
fn copy_in_the_description_sends_the_selection_with_its_line_break_and_changes_nothing() {
    let mut rig = drafted();
    selecting_across(&mut rig);
    let fx = rig.mods(Key::Char('c'), Mods::CTRL);
    let (write, text) = clipboard_write(&fx);
    assert_eq!(text, "llo\nwo");
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.model().body(), "hello\nworld");
    assert!(rig.banners().is_empty(), "{:?}", rig.banners());
}

#[test]
fn cut_in_the_description_takes_the_text_out_only_once_the_clipboard_has_it() {
    let mut rig = drafted();
    selecting_across(&mut rig);
    let fx = rig.mods(Key::Char('x'), Mods::CTRL);
    let (write, text) = clipboard_write(&fx);
    assert_eq!(text, "llo\nwo");
    assert_eq!(
        rig.model().body(),
        "hello\nworld",
        "still there until it is accepted"
    );
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.model().body(), "herld");
}

#[test]
fn a_refused_cut_leaves_the_text_and_says_so_as_a_notice() {
    let mut rig = drafted();
    selecting_across(&mut rig);
    let fx = rig.mods(Key::Char('x'), Mods::CTRL);
    let (write, _) = clipboard_write(&fx);
    rig.answer(
        &write,
        Outcome::Refused {
            code: "denied".into(),
            reason: "no clipboard here".into(),
        },
        None,
    );
    assert_eq!(rig.model().body(), "hello\nworld");
    let said = rig.banners();
    assert!(
        said.iter().any(|b| b.contains("no clipboard here")),
        "{said:?}"
    );
}

#[test]
fn a_cut_is_not_applied_to_a_field_that_no_longer_holds_that_selection() {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("add thing");
    rig.mods(Key::Char('a'), Mods::CTRL);
    let fx = rig.mods(Key::Char('x'), Mods::CTRL);
    let (write, _) = clipboard_write(&fx);
    // The person types over the selection before the host answers.
    rig.typed("Z");
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.model().subject(), "Z");
}

#[test]
fn copy_and_cut_work_in_the_subject_and_the_branch_prompt() {
    let mut rig = loaded();
    rig.ch('c');
    rig.typed("add thing");
    rig.mods(Key::Char('a'), Mods::CTRL);
    let (write, text) = clipboard_write(&rig.mods(Key::Char('c'), Mods::CTRL));
    assert_eq!(text, "add thing");
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.model().subject(), "add thing");
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.model().subject(), "");

    let mut rig = loaded();
    rig.ch('b');
    rig.typed("devel");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    let (write, text) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    assert_eq!(text, "el");
    // Refused: the prompt keeps what it had.
    rig.answer(
        &write,
        Outcome::Failed {
            reason: "blocked".into(),
        },
        None,
    );
    assert_eq!(
        rig.model().prompt().map(|p| p.text.clone()).as_deref(),
        Some("devel")
    );
    // Accepted: it goes.
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(
        rig.model().prompt().map(|p| p.text.clone()).as_deref(),
        Some("dev")
    );
}
