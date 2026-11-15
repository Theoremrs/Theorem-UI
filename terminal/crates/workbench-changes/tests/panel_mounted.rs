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
use theorem_workbench_changes::{ChangesPanel, actions, descriptors, with_actions};
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    BlameHunk, Completion, CompletionPayload, Outcome, ScmBlameResult, ScmMerged, ScmShowResult,
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
    let registry = with_actions(builtin::registry()).expect("the actions register");
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

    fn text(&self, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let mut cx = ViewCtx::new(&theme, self.m.workspace());
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
    let (mut rig, fx) = opened_with(&CAPS, "w");
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
        assert!(rig.action(id, Actor::Human).is_empty(), "{id}");
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
    let registry = with_actions(builtin::registry()).unwrap();
    let ids: Vec<String> = descriptors()
        .iter()
        .map(|d| d.id.as_str().to_owned())
        .collect();
    assert_eq!(ids.len(), 21);
    let with = registry.agent_catalog(&Capabilities::of(CAPS));
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
