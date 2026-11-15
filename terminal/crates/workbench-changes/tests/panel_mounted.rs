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
use theorem_workbench_changes::{ChangesPanel, actions, descriptors, extend_registry};
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

/// A stand-in for the document panel the real workbench registers.
struct Doc(String);

impl Panel for Doc {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}
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
        let panel = Rc::new(RefCell::new(ChangesPanel::restore(state)));
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
    rig.mods(Key::Char('a'), Mods::CTRL);
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
    assert_eq!(ids.len(), 44);
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
