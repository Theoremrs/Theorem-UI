//! The delegation panel driven through a real root: keys, completions and ticks go in as
//! `Msg`; effects, cells and the semantic tree come out. A stand-in panel opens the
//! delegation the way a conversation would, with `cx.open(OpenTarget::Delegation { .. })`.

mod common;

use std::cell::RefCell;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use serde_json::{Value, json};
use theorem_workbench_changes::{
    ChangesStyles, DelegationPanel, MAX_LINE_CHARS, MAX_SIDE_BYTES, delegation_actions,
    delegation_descriptor, extend_registry,
};
use theorem_workbench_core::PanelKind;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, DelegationChange, DelegationChangeKind, DelegationChangeList,
    DelegationText, Outcome,
};
use theorem_workbench_core::effect::{DelegationSide, Effect, EffectBody, EffectKind};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::Capability;
use theorem_workbench_core::ids::{ActionId, Actor, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::{Node, Role};
use theorem_workbench_core::{Button, Pointer, PointerKind};
use theorem_workbench_core::{
    Ctx, Model, Msg, OpenTarget, Panel, PanelFactories, PanelMsg, Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use unicode_width::UnicodeWidthStr;

const CAPS: [&str; 5] = ["files", "documents", "scm", "environment", "search"];

thread_local! {
    /// What the stand-in opens when it hears a key.
    static TARGET: RefCell<Option<OpenTarget>> = const { RefCell::new(None) };
    /// A saved state the delegation factory restores from instead of the target's own,
    /// as a saved layout would.
    static RESTORE: RefCell<Option<Value>> = const { RefCell::new(None) };
}

/// The panel a conversation would be: it opens the target on any key.
struct Opener;

impl Panel for Opener {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        if matches!(msg, PanelMsg::Key(_))
            && let Some(target) = TARGET.with(|t| t.borrow_mut().take())
        {
            cx.open(target);
        }
    }
    fn view(&self, _: Rect, _: &mut Buffer, _: &ViewCtx) {}
    fn semantics(&self, area: Rect, _: &ViewCtx) -> Vec<Node> {
        vec![Node::new("opener", Role::Region, "Opener", area)]
    }
    fn serialize(&self) -> Value {
        Value::Null
    }
}

fn factories() -> PanelFactories {
    let mut factories = PanelFactories::new();
    theorem_workbench_changes::register(&mut factories);
    // The "changes" kind is only the way to get a focused panel that can open things.
    factories.register("changes", |_, _| Box::new(Opener));
    factories.register("delegation", |state, _| {
        let saved = RESTORE.with(|r| r.borrow_mut().take());
        Box::new(DelegationPanel::restore(saved.as_ref().unwrap_or(state)))
    });
    factories
}

fn new_model() -> Model {
    let mut registry = builtin::registry();
    extend_registry(&mut registry).expect("the actions register");
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(registry, factories(), keys, Capabilities::of(CAPS), dock);
    update(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    update(
        &mut m,
        Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: None,
        }),
    );
    m
}

fn target(path: &str) -> OpenTarget {
    OpenTarget::Delegation {
        run_id: "run-1".into(),
        delegation_id: "d-1".into(),
        path: path.into(),
    }
}

fn resource(path: &str) -> ResourceRef {
    target(path).resource()
}

fn change(path: &str, kind: &str, has_before: bool, has_after: bool) -> DelegationChange {
    DelegationChange {
        path: path.into(),
        change: match kind {
            "added" => DelegationChangeKind::Add,
            "deleted" => DelegationChangeKind::Delete,
            _ => DelegationChangeKind::Modify,
        },
        binary: false,
        has_before,
        has_after,
    }
}

fn modified(path: &str) -> DelegationChange {
    change(path, "modified", true, true)
}

fn list(changes: Vec<DelegationChange>) -> CompletionPayload {
    CompletionPayload::DelegationChanges(DelegationChangeList { changes })
}

fn text(t: &str) -> CompletionPayload {
    CompletionPayload::DelegationText(DelegationText { text: t.into() })
}

/// What an effect asked, in a word.
fn say(e: &Effect) -> String {
    match &e.body {
        EffectBody::DelegationChanges(_) => "changes".into(),
        EffectBody::DelegationContent(c) => format!(
            "{}:{}",
            match c.side {
                DelegationSide::Before => "before",
                DelegationSide::After => "after",
            },
            c.path
        ),
        other => format!("OTHER {:?}", EffectKind::from(other)),
    }
}

fn says(fx: &[Effect]) -> Vec<String> {
    fx.iter().map(say).collect()
}

struct Rig {
    m: Model,
    id: PanelInstanceId,
    /// Everything emitted so far.
    all: Vec<Effect>,
}

/// Opens `target` as the stand-in does, and gives the effects of the first tick.
fn open(target: OpenTarget) -> (Rig, Vec<Effect>) {
    open_as(target, None)
}

/// As [`open`], the panel restored from `saved` as a saved layout would.
fn open_as(target: OpenTarget, saved: Option<Value>) -> (Rig, Vec<Effect>) {
    RESTORE.with(|r| *r.borrow_mut() = saved);
    let mut m = new_model();
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("changes.open"),
            actor: Actor::Human,
        },
    );
    TARGET.with(|t| *t.borrow_mut() = Some(target));
    let mut fx = update(&mut m, Msg::Key(KeyInput::new(Key::Char('x'), Mods::NONE)));
    let id = m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "delegation")
        .map(|(id, _)| id.clone())
        .expect("a delegation panel is open");
    let mut rig = Rig {
        m,
        id,
        all: Vec::new(),
    };
    fx.extend(rig.send(Msg::Tick));
    rig.all.extend(fx.clone());
    (rig, fx)
}

/// The list answered, with the first effect's answer.
fn listed(changes: Vec<DelegationChange>) -> Rig {
    let (mut rig, fx) = open(target(""));
    assert_eq!(says(&fx), ["changes"]);
    rig.accept(&fx[0], list(changes));
    rig
}

impl Rig {
    fn send(&mut self, msg: Msg) -> Vec<Effect> {
        let fx = update(&mut self.m, msg);
        self.all.extend(fx.clone());
        fx
    }

    fn key(&mut self, key: Key) -> Vec<Effect> {
        self.send(Msg::Key(KeyInput::new(key, Mods::NONE)))
    }

    fn ch(&mut self, c: char) -> Vec<Effect> {
        self.key(Key::Char(c))
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

    fn refuse(&mut self, effect: &Effect, code: &str, reason: &str) -> Vec<Effect> {
        self.answer(
            effect,
            Outcome::Refused {
                code: code.into(),
                reason: reason.into(),
            },
            None,
        )
    }

    fn panel(&self) -> &dyn Panel {
        self.m.panel(&self.id).expect("the panel")
    }

    /// The body the panel is drawn in.
    fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the delegation group")
            .body
    }

    /// Shrinks or grows the whole window; the panel's body follows.
    fn window(&mut self, width: u16, height: u16) {
        self.send(Msg::Resize {
            area: Rect::new(0, 0, width, height),
            metrics: CellMetrics::new(8.0, 16.0),
        });
    }

    fn buf(&self, theme: &Theme, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let mut cx =
            ViewCtx::new(theme, self.m.workspace()).with_capabilities(self.m.capabilities());
        cx.focused = true;
        self.panel().view(area, &mut buf, &cx);
        theorem_workbench_core::take_icons(&mut buf);
        buf
    }

    /// The panel drawn at its own size, one string per row.
    fn text(&self) -> Vec<String> {
        let body = self.body();
        common::lines(&self.buf(&Theme::plain(), body.width, body.height))
    }

    fn screen(&self) -> String {
        self.text().join("\n")
    }

    fn nodes(&self) -> Vec<Node> {
        let theme = Theme::plain();
        let cx = ViewCtx::new(&theme, self.m.workspace()).with_capabilities(self.m.capabilities());
        let body = self.body();
        self.panel()
            .semantics(Rect::new(0, 0, body.width, body.height), &cx)
    }

    /// Makes the panel's body `columns` wide (the window grows or shrinks to it).
    fn columns(&mut self, columns: u16) {
        for width in columns..=1200 {
            self.window(width, 50);
            if self.body().width >= columns {
                assert_eq!(self.body().width, columns, "a window gives exactly that");
                return;
            }
        }
        panic!("no window gives {columns} columns");
    }

    /// The saved state of the panel.
    fn saved(&self) -> Value {
        self.panel().serialize()
    }
}

/// The two reads a modified file asks for, in the order they were sent.
fn open_first(rig: &mut Rig) -> Vec<Effect> {
    rig.key(Key::Enter)
}

const BEFORE: &str = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
const AFTER: &str = "alpha\nbeta\nGAMMA changed\ndelta\nepsilon\nzeta\n";

/// A file open with both its sides answered.
fn shown() -> Rig {
    let mut rig = listed(vec![modified("src/a.rs"), modified("src/b.rs")]);
    let fx = open_first(&mut rig);
    assert_eq!(says(&fx), ["before:src/a.rs", "after:src/a.rs"]);
    rig.accept(&fx[0], text(BEFORE));
    rig.accept(&fx[1], text(AFTER));
    rig
}

/// How many of `c` are on the screen.
fn count(lines: &[String], c: char) -> usize {
    lines.iter().map(|l| l.matches(c).count()).sum()
}

// ---- opening and the list -----------------------------------------------------------

#[test]
fn opening_asks_for_the_changes_once_on_the_tick_and_says_it_is_loading() {
    let mut m = new_model();
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("changes.open"),
            actor: Actor::Human,
        },
    );
    TARGET.with(|t| *t.borrow_mut() = Some(target("")));
    let opened = update(&mut m, Msg::Key(KeyInput::new(Key::Char('x'), Mods::NONE)));
    assert!(opened.is_empty(), "opening emits no effect: {opened:?}");
    let id = m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "delegation")
        .map(|(id, _)| id.clone())
        .unwrap();
    let mut rig = Rig { id, m, all: vec![] };
    assert!(
        rig.screen()
            .contains("Loading the files this delegation changed.")
    );
    let fx = rig.send(Msg::Tick);
    assert_eq!(says(&fx), ["changes"]);
    assert_eq!(fx[0].resource, resource(""));
    assert!(says(&rig.send(Msg::Tick)).is_empty(), "asked once");
    assert!(
        rig.screen()
            .contains("Loading the files this delegation changed.")
    );
}

#[test]
fn the_list_shows_each_file_with_its_kind_and_marks_a_binary_one() {
    let mut files = vec![
        change("src/new.rs", "added", false, true),
        modified("src/main.rs"),
        change("old.txt", "deleted", true, false),
        change("logo.png", "modified", true, true),
    ];
    files[3].binary = true;
    let rig = listed(files);
    let screen = rig.text();
    assert_eq!(screen[0], "Changes by delegation d-1");
    assert_eq!(
        screen[1],
        "4 files changed. Enter shows a file's before and after."
    );
    assert_eq!(screen[2], "A src/new.rs");
    assert_eq!(screen[3], "M src/main.rs");
    assert_eq!(screen[4], "D old.txt");
    assert_eq!(screen[5], "M logo.png (binary)");
}

#[test]
fn an_empty_delegation_says_so() {
    let rig = listed(vec![]);
    assert!(rig.screen().contains("This delegation changed no files."));
}

#[test]
fn up_and_down_move_the_cursor_and_the_semantic_tree_follows() {
    let mut rig = listed(vec![modified("a"), modified("b"), modified("c")]);
    let selected = |rig: &Rig| -> Vec<String> {
        rig.nodes()
            .iter()
            .filter(|n| n.role == Role::ListItem && n.state.selected)
            .map(|n| n.name.clone())
            .collect()
    };
    assert_eq!(selected(&rig), ["a, modified"]);
    rig.key(Key::Down);
    rig.ch('j');
    assert_eq!(selected(&rig), ["c, modified"]);
    rig.key(Key::Down);
    assert_eq!(selected(&rig), ["c, modified"], "stops at the last");
    rig.ch('k');
    assert_eq!(selected(&rig), ["b, modified"]);
}

#[test]
fn a_long_list_scrolls_to_keep_the_cursor_on_screen() {
    let files: Vec<_> = (0..120).map(|i| modified(&format!("f{i:02}.rs"))).collect();
    let mut rig = listed(files);
    for _ in 0..100 {
        rig.key(Key::Down);
    }
    let screen = rig.screen();
    assert!(screen.contains("f100.rs"), "{screen}");
    assert!(!screen.contains("f00.rs"));
    rig.key(Key::Home);
    assert!(rig.screen().contains("f00.rs"));
}

// ---- opening a file --------------------------------------------------------------------

#[test]
fn enter_reads_both_sides_of_the_file_under_the_cursor() {
    let mut rig = listed(vec![modified("src/a.rs"), modified("src/b.rs")]);
    rig.key(Key::Down);
    let fx = open_first(&mut rig);
    assert_eq!(says(&fx), ["before:src/b.rs", "after:src/b.rs"]);
    for e in &fx {
        assert_eq!(e.resource, resource(""));
    }
    assert!(rig.screen().contains("Loading the before and after."));
}

#[test]
fn a_modified_file_shows_its_before_and_after_as_a_diff() {
    let rig = shown();
    let screen = rig.text();
    assert_eq!(
        screen[..9],
        [
            "src/a.rs",
            "modified.",
            "@@ -1,5 +1,6 @@",
            "1 1  alpha",
            "2 2  beta",
            "3   -gamma",
            "  3 +GAMMA changed",
            "4 4  delta",
            "5 5  epsilon",
        ]
    );
    assert_eq!(screen[9], "  6 +zeta");
    assert_eq!(screen.last().unwrap(), "Esc: back  r: reload");
}

#[test]
fn the_diff_uses_the_changes_panels_roles_for_lines_and_changed_words() {
    let mut rig = listed(vec![modified("src/a.rs")]);
    let fx = open_first(&mut rig);
    rig.accept(&fx[0], text("keep\nlet x = 1;\nkeep\n"));
    rig.accept(&fx[1], text("keep\nlet x = 2;\nkeep\n"));
    let green = Style::new().bg(Color::Green);
    let red = Style::new().bg(Color::Red);
    let theme = Theme::plain().with_diff(
        green,
        red,
        Style::new().fg(Color::Yellow),
        Style::new().fg(Color::Magenta),
    );
    let body = rig.body();
    let buf = rig.buf(&theme, body.width, body.height);
    let screen = common::lines(&buf);
    assert_eq!(screen[4], "2   -let x = 1;");
    assert_eq!(screen[5], "  2 +let x = 2;");
    assert_eq!(buf[(0, 4)].bg, Color::Red, "a removed line");
    assert_eq!(buf[(0, 5)].bg, Color::Green, "an added line");
    assert_eq!(buf[(0, 3)].bg, Color::Reset, "an unchanged line");
    // The one word that differs carries the words role over the line's own.
    assert_eq!(
        (buf[(13, 4)].fg, buf[(13, 4)].bg),
        (Color::Magenta, Color::Red)
    );
    assert_eq!(
        (buf[(13, 5)].fg, buf[(13, 5)].bg),
        (Color::Yellow, Color::Green)
    );
    assert_eq!(buf[(12, 5)].fg, Color::Reset, "the words around it do not");
    assert_eq!(ChangesStyles::from_theme(&theme).added_line, green);
}

#[test]
fn a_file_with_no_before_asks_for_only_its_after_and_says_every_line_is_new() {
    let mut rig = listed(vec![change("src/new.rs", "added", false, true)]);
    let fx = open_first(&mut rig);
    assert_eq!(says(&fx), ["after:src/new.rs"]);
    rig.accept(&fx[0], text("one\ntwo\n"));
    rig.columns(100);
    let screen = rig.text();
    assert_eq!(screen[0], "src/new.rs");
    assert_eq!(
        screen[1],
        "added. There is no before: the file did not exist, so every line is new."
    );
    assert_eq!(screen[2], "@@ -0,0 +1,2 @@");
    assert_eq!(screen[3], "  1 +one");
    assert_eq!(screen[4], "  2 +two");
}

#[test]
fn a_file_with_no_after_asks_for_only_its_before_and_says_every_line_is_gone() {
    let mut rig = listed(vec![change("old.txt", "deleted", true, false)]);
    let fx = open_first(&mut rig);
    assert_eq!(says(&fx), ["before:old.txt"]);
    rig.accept(&fx[0], text("one\ntwo\n"));
    rig.columns(100);
    let screen = rig.text();
    assert_eq!(
        screen[1],
        "deleted. There is no after: the file was removed, so every line is gone."
    );
    assert_eq!(screen[3], "1   -one");
    assert_eq!(screen[4], "2   -two");
}

#[test]
fn a_binary_file_reads_nothing_and_says_it_is_not_shown_as_text() {
    let mut binary = modified("logo.png");
    binary.binary = true;
    let mut rig = listed(vec![binary]);
    let fx = open_first(&mut rig);
    assert!(fx.is_empty(), "no read for a binary file: {fx:?}");
    assert_eq!(
        rig.text()[1],
        "modified. This file is binary: not shown as text."
    );
    assert!(says(&rig.send(Msg::Tick)).is_empty());
}

#[test]
fn identical_texts_and_a_line_break_difference_are_said_in_words() {
    let mut rig = listed(vec![modified("same.txt"), modified("eol.txt")]);
    let fx = open_first(&mut rig);
    rig.accept(&fx[0], text("a\nb\n"));
    rig.accept(&fx[1], text("a\nb\n"));
    assert_eq!(
        rig.text()[1],
        "modified. The before and after are the same text."
    );
    rig.key(Key::Esc);
    rig.key(Key::Down);
    let fx = open_first(&mut rig);
    rig.accept(&fx[0], text("a\nb"));
    rig.accept(&fx[1], text("a\nb\n"));
    rig.columns(100);
    assert_eq!(
        rig.text()[1],
        "modified. The lines are the same: only the final line break differs."
    );
}

#[test]
fn escape_goes_back_to_the_list_and_only_a_file_holds_escape() {
    let mut rig = shown();
    assert!(rig.panel().holds_escape());
    assert!(!rig.panel().text_entry());
    let fx = rig.key(Key::Esc);
    assert!(fx.is_empty());
    assert!(!rig.panel().holds_escape());
    let screen = rig.text();
    assert_eq!(screen[0], "Changes by delegation d-1");
    assert!(screen.iter().any(|l| l == "M src/b.rs"));
    // Returning is not a new read, and the cursor stays on the file that was open.
    assert!(says(&rig.send(Msg::Tick)).is_empty());
}

#[test]
fn a_panel_opened_on_a_path_shows_that_file_without_a_key() {
    let (mut rig, fx) = open(target("src/b.rs"));
    assert_eq!(fx[0].resource, resource("src/b.rs"));
    let fx = rig.accept(
        &fx[0],
        list(vec![modified("src/a.rs"), modified("src/b.rs")]),
    );
    assert_eq!(says(&fx), ["before:src/b.rs", "after:src/b.rs"]);
    assert_eq!(rig.text()[0], "src/b.rs");
    for e in &fx {
        assert_eq!(e.resource, resource("src/b.rs"));
    }
    // Escape still reaches the list, with the file's row under the cursor.
    rig.key(Key::Esc);
    assert!(rig.screen().contains("2 files changed."));
}

#[test]
fn a_path_the_delegation_did_not_change_is_said_and_the_list_shows() {
    let (mut rig, fx) = open(target("gone.rs"));
    let fx = rig.accept(&fx[0], list(vec![modified("src/a.rs")]));
    assert!(fx.is_empty());
    let screen = rig.text();
    assert_eq!(
        screen[1],
        "gone.rs is not among the files this delegation changed."
    );
    assert!(screen.iter().any(|l| l == "M src/a.rs"));
}

// ---- refusals, failures, uncertainty -------------------------------------------------

#[test]
fn each_refusal_of_the_list_is_said_with_its_reason() {
    for (code, words) in [
        ("no_such_delegation", "The owner has no such delegation."),
        (
            "disposed",
            "This delegation was disposed of, so its changes are no longer kept.",
        ),
        (
            "stale_account",
            "The account has changed since this was opened.",
        ),
        ("something_new", "The owner refused."),
    ] {
        let (mut rig, fx) = open(target(""));
        rig.refuse(&fx[0], code, "the reason");
        let screen = rig.screen().replace('\n', " ");
        assert!(
            screen.contains(&format!(
                "The changes could not be read. {words} ({code}: the reason)"
            )),
            "{code}: {screen}"
        );
    }
}

#[test]
fn each_refusal_of_a_side_is_said_and_the_other_side_is_still_shown() {
    for (code, words) in [
        (
            "no_such_change",
            "The delegation has no change for this file.",
        ),
        ("binary_skipped", "This file is binary: not shown as text."),
        ("no_such_side", "The file has no such side."),
        ("no_longer_stored", "The owner no longer stores this text."),
        ("too_large", "This text is too large to show."),
        ("not_text", "This file is not text: not shown as text."),
        ("other_code", "The owner refused."),
    ] {
        let mut rig = listed(vec![modified("a.rs")]);
        let fx = open_first(&mut rig);
        rig.refuse(&fx[0], code, "why");
        rig.accept(&fx[1], text("kept\n"));
        let screen = rig.screen().replace('\n', " ");
        assert!(
            screen.contains(&format!("Before: {words} ({code}: why)")),
            "{code}: {screen}"
        );
        // The side that was read is shown as plain lines, not as a diff against nothing.
        assert!(screen.contains("After: 1 lines"), "{screen}");
        assert!(screen.contains("kept"), "{screen}");
        assert!(!screen.contains('+'), "no diff is made from half: {screen}");
    }
}

#[test]
fn a_failed_read_and_an_uncertain_one_are_said_and_an_uncertain_one_is_not_retried() {
    let (mut rig, fx) = open(target(""));
    rig.answer(
        &fx[0],
        Outcome::Failed {
            reason: "socket closed".into(),
        },
        None,
    );
    assert!(
        rig.screen()
            .replace('\n', " ")
            .contains("The changes could not be read: socket closed")
    );
    // A person asks again with r.
    let fx = rig.ch('r');
    assert_eq!(says(&fx), ["changes"]);
    rig.answer(
        &fx[0],
        Outcome::Uncertain {
            reason: "no answer".into(),
        },
        None,
    );
    let screen = rig.screen().replace('\n', " ");
    assert!(
        screen
            .contains("Unknown whether the changes were read (no answer). Press r to read again."),
        "{screen}"
    );
    assert!(says(&rig.send(Msg::Tick)).is_empty(), "never retried blind");

    let mut rig = listed(vec![modified("a.rs")]);
    let fx = open_first(&mut rig);
    rig.answer(
        &fx[0],
        Outcome::Failed {
            reason: "boom".into(),
        },
        None,
    );
    rig.answer(
        &fx[1],
        Outcome::Uncertain {
            reason: "late".into(),
        },
        None,
    );
    let screen = rig.screen().replace('\n', " ");
    assert!(
        screen.contains("Before: could not be read: boom"),
        "{screen}"
    );
    assert!(
        screen.contains("After: unknown whether it was read (late). Press r to read again."),
        "{screen}"
    );
    assert!(says(&rig.send(Msg::Tick)).is_empty());
}

#[test]
fn access_revoked_clears_what_was_shown() {
    let mut rig = shown();
    rig.key(Key::Esc);
    rig.key(Key::Enter);
    let fx: Vec<Effect> = rig.all.iter().rev().take(2).cloned().collect();
    rig.refuse(&fx[0], "access_revoked", "signed out");
    let screen = rig.screen();
    assert!(
        screen
            .replace('\n', " ")
            .contains("Access to this delegation was revoked, so nothing is shown."),
        "{screen}"
    );
    assert!(
        !screen.contains("src/a.rs") && !screen.contains("alpha"),
        "{screen}"
    );
}

// ---- a late answer ------------------------------------------------------------------------

#[test]
fn a_late_answer_for_a_file_the_person_has_left_changes_nothing() {
    let mut rig = listed(vec![modified("a.rs"), modified("b.rs")]);
    let a = open_first(&mut rig);
    rig.key(Key::Esc);
    rig.key(Key::Down);
    let b = open_first(&mut rig);
    assert_eq!(says(&b), ["before:b.rs", "after:b.rs"]);
    let before = rig.screen();
    // a's answers arrive now: both are for the file that was left.
    rig.accept(&a[0], text("LEFT BEHIND\n"));
    rig.accept(&a[1], text("LEFT BEHIND TOO\n"));
    assert_eq!(rig.screen(), before, "nothing a left behind is shown");
    rig.accept(&b[0], text("b before\n"));
    rig.accept(&b[1], text("b after\n"));
    let screen = rig.screen();
    assert!(screen.contains("b before") && screen.contains("b after"));
    assert!(!screen.contains("LEFT BEHIND"));
}

#[test]
fn an_answer_after_going_back_to_the_list_is_dropped_and_so_is_one_from_before_a_reload() {
    let mut rig = listed(vec![modified("a.rs")]);
    let first = open_first(&mut rig);
    rig.key(Key::Esc);
    let before = rig.screen();
    rig.accept(&first[0], text("late\n"));
    rig.accept(&first[1], text("later\n"));
    assert_eq!(rig.screen(), before);
    // The same file opened again: the old reads are not the new ones.
    let second = open_first(&mut rig);
    rig.accept(&first[0], text("OLD\n"));
    assert!(!rig.screen().contains("OLD"));
    rig.accept(&second[0], text("new\n"));
    rig.accept(&second[1], text("new\n"));
    assert!(rig.screen().contains("same text"));
    // A reload forgets what was in flight too.
    rig.ch('r');
    let sent: Vec<Effect> = rig.all.iter().rev().take(2).cloned().collect();
    rig.accept(&second[0], text("STALE\n"));
    assert!(!rig.screen().contains("STALE"));
    drop(sent);
}

// ---- read only ------------------------------------------------------------------------------

/// Every key a person or an agent's keystrokes could send.
fn every_key() -> Vec<KeyInput> {
    let mut keys = Vec::new();
    let named = [
        Key::Up,
        Key::Down,
        Key::Left,
        Key::Right,
        Key::Enter,
        Key::Backspace,
        Key::Delete,
        Key::Home,
        Key::End,
        Key::PageUp,
        Key::PageDown,
        Key::Esc,
        Key::Tab,
        Key::Insert,
        Key::Copy,
        Key::Cut,
        Key::Paste,
        Key::Undo,
        Key::Redo,
    ];
    for mods in [Mods::NONE, Mods::SHIFT, Mods::CTRL, Mods::ALT, Mods::CMD] {
        for key in &named {
            keys.push(KeyInput::new(*key, mods));
        }
        for c in (' '..='~').chain(['é', '日', '\u{202e}']) {
            keys.push(KeyInput::new(Key::Char(c), mods));
        }
    }
    keys
}

/// Whether an effect is one of the two reads, and nothing else.
fn is_read(e: &Effect) -> bool {
    matches!(
        e.kind(),
        EffectKind::DelegationChanges | EffectKind::DelegationContent
    )
}

#[test]
fn no_key_text_or_action_can_emit_anything_but_the_two_reads() {
    // The states a person can be in: reading, listed, a file loading, a file shown, a side
    // refused, a read failed.
    let states: Vec<Rig> = vec![
        open(target("")).0,
        listed(vec![modified("a.rs"), change("b.rs", "added", false, true)]),
        {
            let mut rig = listed(vec![modified("a.rs")]);
            open_first(&mut rig);
            rig
        },
        shown(),
        {
            let mut rig = listed(vec![modified("a.rs")]);
            let fx = open_first(&mut rig);
            rig.refuse(&fx[0], "no_longer_stored", "gone");
            rig.answer(&fx[1], Outcome::Uncertain { reason: "?".into() }, None);
            rig
        },
    ];
    let mut sent = 0;
    for (n, _) in states.iter().enumerate() {
        for key in every_key() {
            // Rebuild the state so one key does not change what the next meets.
            let mut rig = match n {
                0 => open(target("")).0,
                1 => listed(vec![modified("a.rs"), change("b.rs", "added", false, true)]),
                2 => {
                    let mut rig = listed(vec![modified("a.rs")]);
                    open_first(&mut rig);
                    rig
                }
                3 => shown(),
                _ => {
                    let mut rig = listed(vec![modified("a.rs")]);
                    let fx = open_first(&mut rig);
                    rig.refuse(&fx[0], "no_longer_stored", "gone");
                    rig.answer(&fx[1], Outcome::Uncertain { reason: "?".into() }, None);
                    rig
                }
            };
            let fx = rig.send(Msg::Key(key));
            assert!(
                fx.iter().all(is_read),
                "state {n}, key {key:?}: {:?}",
                says(&fx)
            );
            sent += fx.len();
        }
        let mut rig = shown();
        for msg in [
            Msg::Text("abc".into()),
            Msg::Paste("paste\nme".into()),
            Msg::Tick,
        ] {
            let fx = rig.send(msg);
            assert!(fx.iter().all(is_read), "{:?}", says(&fx));
        }
    }
    assert!(sent > 0, "the reads were reached too");
}

#[test]
fn no_action_the_kind_registers_emits_or_is_offered_beyond_the_reads() {
    let reads = [EffectKind::DelegationChanges, EffectKind::DelegationContent];
    let descriptor = delegation_descriptor();
    assert_eq!(descriptor.kind, PanelKind::new("delegation"));
    for action in &descriptor.actions {
        assert!(
            !action.human_only,
            "{}: nothing here needs a person only",
            action.id.as_str()
        );
        assert!(
            action.emits.iter().all(|k| reads.contains(k)),
            "{}",
            action.id.as_str()
        );
        assert!(
            action.id.as_str().starts_with("delegation."),
            "{}",
            action.id.as_str()
        );
    }
    let ids: Vec<&str> = descriptor.actions.iter().map(|a| a.id.as_str()).collect();
    for banned in [
        "stage", "discard", "edit", "resolve", "commit", "save", "revert",
    ] {
        assert!(
            ids.iter().all(|id| !id.to_lowercase().contains(banned)),
            "{banned}: {ids:?}"
        );
    }
    // The agent's catalog lists them all, none marked for a person only.
    let mut registry = builtin::registry();
    extend_registry(&mut registry).unwrap();
    let catalog = registry.agent_catalog(&Capabilities::of(CAPS));
    let ours: Vec<_> = catalog
        .iter()
        .filter(|e| e.panel == PanelKind::new("delegation"))
        .collect();
    assert_eq!(ours.len(), descriptor.actions.len());
    assert!(ours.iter().all(|e| !e.human_only));
    assert!(
        registry
            .get(&PanelKind::new("delegation"))
            .unwrap()
            .requires
            .iter()
            .all(|c: &Capability| c.as_str().is_empty() || !c.as_str().is_empty())
    );
}

#[test]
fn every_registered_action_run_by_the_agent_emits_only_reads_and_the_nodes_offer_only_those() {
    let ids = [
        delegation_actions::REFRESH,
        delegation_actions::OPEN,
        delegation_actions::BACK,
        delegation_actions::NEXT,
        delegation_actions::PREVIOUS,
    ];
    for id in ids {
        for rig in [listed(vec![modified("a.rs")]), shown()] {
            let mut rig = rig;
            let fx = rig.action(
                id,
                Actor::Agent {
                    run_id: "run-9".into(),
                },
            );
            assert!(fx.iter().all(is_read), "{id}: {:?}", says(&fx));
            for node in rig.nodes() {
                for action in &node.actions {
                    assert!(
                        ids.contains(&action.id.as_str()),
                        "{} offers {}",
                        node.name,
                        action.id.as_str()
                    );
                }
            }
        }
    }
    // The agent's open reaches the file, as Enter does.
    let mut rig = listed(vec![modified("a.rs")]);
    let fx = rig.action(
        delegation_actions::OPEN,
        Actor::Agent {
            run_id: "run-9".into(),
        },
    );
    assert_eq!(says(&fx), ["before:a.rs", "after:a.rs"]);
    assert_eq!(
        fx[0].actor,
        Actor::Agent {
            run_id: "run-9".into()
        }
    );
}

// ---- hostile text, wrapping, bounds ------------------------------------------------------

fn hidden_or_control(c: char) -> bool {
    c.is_control() || theorem_workbench_text::visible::hidden(c)
}

/// No cell of the buffer holds a control or hidden character, and no row is wider than
/// the pane.
fn assert_safe(buf: &Buffer, width: u16) {
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            let symbol = buf[(x, y)].symbol();
            assert!(
                !symbol.chars().any(hidden_or_control),
                "a raw control or hidden character at {x},{y}: {symbol:?}"
            );
        }
    }
    for line in common::lines(buf) {
        assert!(
            UnicodeWidthStr::width(line.as_str()) <= width as usize,
            "{line:?}"
        );
    }
}

fn squash(lines: &[String]) -> String {
    lines.join("").replace(' ', "")
}

const HOSTILE_PATH: &str = "dir/a\u{1b}[31m\u{202e}evil\u{0}.rs";
const HOSTILE_ESCAPED: &str = "dir/a\\u{1b}[31m\\u{202e}evil\\u{0}.rs";

#[test]
fn hostile_text_is_escaped_and_wrapped_never_clipped_at_24_and_default_and_120() {
    for columns in [24u16, 57, 120] {
        let mut rig = listed(vec![
            modified(HOSTILE_PATH),
            change("\u{85}next\tpath", "added", false, true),
        ]);
        rig.columns(columns);
        let body = rig.body();
        let buf = rig.buf(&Theme::plain(), body.width, body.height);
        assert_safe(&buf, columns);
        let screen = common::lines(&buf);
        assert!(
            squash(&screen).contains(&HOSTILE_ESCAPED.replace(' ', "")),
            "{columns}: the whole path is there, spelled out, wrapped: {screen:?}"
        );
        assert!(
            squash(&screen).contains("\\u{85}next    path".replace(' ', "").as_str()),
            "{columns}: {screen:?}"
        );
        // The semantic names are made safe the same way.
        for node in rig.nodes() {
            assert!(
                !node.name.chars().any(hidden_or_control),
                "{columns}: {:?}",
                node.name
            );
            assert!(
                !node
                    .state
                    .description
                    .as_deref()
                    .unwrap_or("")
                    .chars()
                    .any(hidden_or_control)
            );
        }
        // Open the first: hostile file content, a long line and a refusal's reason.
        let fx = open_first(&mut rig);
        let hostile = "ok\u{1b}[2Jline\u{202e}\tend\n";
        let long = format!("{}\n", "Q".repeat(100));
        rig.accept(&fx[0], text(hostile));
        rig.accept(&fx[1], text(&format!("{hostile}{long}")));
        let buf = rig.buf(&Theme::plain(), body.width, body.height);
        assert_safe(&buf, columns);
        let screen = common::lines(&buf);
        let all = squash(&screen);
        assert!(
            all.contains("ok\\u{1b}[2Jline\\u{202e}"),
            "{columns}: {screen:?}"
        );
        assert!(all.contains("\\u{1b}[31m"), "the title too");
        assert_eq!(
            count(&screen, 'Q'),
            100,
            "{columns}: a long line wraps, none is lost"
        );
        for node in rig.nodes() {
            assert!(!node.name.chars().any(hidden_or_control));
            assert!(
                !node
                    .text
                    .as_deref()
                    .unwrap_or("")
                    .chars()
                    .any(|c| hidden_or_control(c) && c != '\n')
            );
        }
    }
}

#[test]
fn the_owners_reason_for_a_refusal_is_escaped_too() {
    let (mut rig, fx) = open(target(""));
    rig.refuse(&fx[0], "weird\u{1b}code", "\u{1b}[2J\u{202e}reason");
    rig.columns(24);
    let body = rig.body();
    let buf = rig.buf(&Theme::plain(), body.width, body.height);
    assert_safe(&buf, 24);
    assert!(squash(&common::lines(&buf)).contains("(weird\\u{1b}code:\\u{1b}[2J\\u{202e}reason)"));
}

#[test]
fn a_line_longer_than_the_bound_is_cut_and_says_how_much() {
    let mut rig = listed(vec![change("big.txt", "added", false, true)]);
    let fx = open_first(&mut rig);
    rig.columns(120);
    rig.accept(
        &fx[0],
        text(&format!("{}\n", "Q".repeat(MAX_LINE_CHARS + 500))),
    );
    let screen = rig.text();
    assert_eq!(count(&screen, 'Q'), MAX_LINE_CHARS);
    assert!(
        squash(&screen).contains("[500morecharactersnotshown]"),
        "{screen:?}"
    );
}

#[test]
fn a_side_over_the_bound_is_not_compared_and_says_so() {
    let mut rig = listed(vec![modified("big.txt")]);
    let fx = open_first(&mut rig);
    rig.accept(&fx[0], text("small\n"));
    rig.accept(&fx[1], text(&"x".repeat(MAX_SIDE_BYTES + 1)));
    assert!(
        rig.screen()
            .replace('\n', " ")
            .contains("Too large to compare here (over 256 KiB or 5000 lines on a side)."),
        "{}",
        rig.screen()
    );
    let tall = "l\n".repeat(5_001);
    let mut rig = listed(vec![modified("tall.txt")]);
    let fx = open_first(&mut rig);
    rig.accept(&fx[0], text(&tall));
    rig.accept(&fx[1], text("x\n"));
    assert!(rig.screen().contains("Too large to compare here"));
}

#[test]
fn a_long_diff_scrolls_and_never_past_its_ends() {
    let before: String = (0..200).map(|i| format!("line {i}\n")).collect();
    let after: String = (0..200).map(|i| format!("LINE {i}\n")).collect();
    let mut rig = listed(vec![modified("long.txt")]);
    let fx = open_first(&mut rig);
    rig.accept(&fx[0], text(&before));
    rig.accept(&fx[1], text(&after));
    assert!(rig.screen().contains("line 0"));
    for _ in 0..4 {
        rig.key(Key::PageDown);
    }
    assert!(!rig.screen().contains("-line 0\n"));
    rig.key(Key::End);
    let end = rig.text();
    assert!(end.iter().any(|l| l.contains("LINE 199")), "{end:?}");
    rig.key(Key::End);
    assert_eq!(rig.text(), end, "no scrolling past the end");
    rig.key(Key::Home);
    assert!(rig.screen().contains("long.txt"));
}

#[test]
fn the_wheel_scrolls_and_a_click_selects_and_a_double_click_opens() {
    let files: Vec<_> = (0..5).map(|i| modified(&format!("f{i}.rs"))).collect();
    let mut rig = listed(files);
    let body = rig.body();
    let at = |x: u16, y: u16, kind, clicks| {
        Msg::Pointer(Pointer {
            kind,
            x: body.x + x,
            y: body.y + y,
            mods: Mods::NONE,
            clicks,
        })
    };
    // Rows: 0 title, 1-2 status (wrapped at this width or not), then files.
    let first_file = rig
        .text()
        .iter()
        .position(|l| l.ends_with("f0.rs"))
        .unwrap() as u16;
    rig.send(at(2, first_file + 2, PointerKind::Down(Button::Left), 1));
    rig.send(at(2, first_file + 2, PointerKind::Up(Button::Left), 1));
    let selected: Vec<String> = rig
        .nodes()
        .iter()
        .filter(|n| n.state.selected)
        .map(|n| n.name.clone())
        .collect();
    assert_eq!(selected, ["f2.rs, modified"]);
    let fx = rig.send(at(2, first_file + 2, PointerKind::Down(Button::Left), 2));
    assert_eq!(says(&fx), ["before:f2.rs", "after:f2.rs"]);
    rig.send(at(2, 2, PointerKind::Wheel { dx: 0, dy: 2 }, 1));
    assert!(says(&rig.send(Msg::Tick)).is_empty());
}

// ---- the semantic tree ------------------------------------------------------------------------

#[test]
fn the_tree_is_valid_bound_to_the_delegation_and_describes_the_list_and_the_diff() {
    let rig = listed(vec![
        modified("src/a.rs"),
        change("logo.png", "added", false, true),
    ]);
    rig.m.panel_ids().count();
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("a valid tree");
    let nodes = rig.nodes();
    for node in &nodes {
        assert_eq!(node.binding, resource(""), "{}", node.name);
    }
    let names: Vec<(Role, &str)> = nodes.iter().map(|n| (n.role, n.name.as_str())).collect();
    assert_eq!(names[0], (Role::Region, "Delegation changes"));
    assert!(names.contains(&(Role::List, "Changed files")));
    assert!(names.contains(&(Role::ListItem, "src/a.rs, modified")));
    assert!(names.contains(&(Role::ListItem, "logo.png, added")));
    let status = nodes.iter().find(|n| n.role == Role::Status).unwrap();
    assert!(
        status.name.starts_with("2 files changed."),
        "{}",
        status.name
    );
    let item = nodes.iter().find(|n| n.name == "logo.png, added").unwrap();
    assert_eq!((item.pos_in_set, item.set_size), (Some(2), Some(2)));

    let mut rig = shown();
    let tree = theorem_workbench_core::tree::semantics(&rig.m);
    tree.validate().expect("a valid tree");
    let nodes = rig.nodes();
    let doc = nodes.iter().find(|n| n.role == Role::Document).unwrap();
    assert_eq!(doc.name, "Before and after of src/a.rs");
    let said = doc.text.as_deref().unwrap();
    assert!(
        said.contains("-gamma") && said.contains("+GAMMA changed"),
        "{said}"
    );
    assert!(
        doc.actions
            .iter()
            .any(|a| a.id.as_str() == delegation_actions::BACK)
    );
    // Loading says busy.
    let (rig2, _) = open(target(""));
    assert!(rig2.nodes()[0].state.busy);
    rig.key(Key::Esc);
    assert!(!rig.nodes()[0].state.busy);
}

// ---- saved state ---------------------------------------------------------------------------------

#[test]
fn the_saved_state_is_the_targets_own_until_something_is_open_and_keeps_no_text() {
    let (rig, _) = open(target(""));
    assert_eq!(rig.saved(), target("").state());
    let rig = shown();
    assert_eq!(
        rig.saved(),
        json!({
            "runId": "run-1", "delegationId": "d-1", "path": "",
            "file": "src/a.rs", "cursor": "src/a.rs",
        })
    );
    let saved = rig.saved().to_string();
    assert!(!saved.contains("alpha") && !saved.contains("GAMMA"));
}

#[test]
fn a_restored_panel_asks_again_and_reopens_the_file_it_had_and_its_cursor() {
    let saved = json!({
        "runId": "run-1", "delegationId": "d-1", "path": "",
        "file": "src/b.rs", "cursor": "src/b.rs",
    });
    let (mut rig, fx) = open_as(target(""), Some(saved));
    assert_eq!(says(&fx), ["changes"], "it reads again, with no text kept");
    let fx = rig.accept(
        &fx[0],
        list(vec![modified("src/a.rs"), modified("src/b.rs")]),
    );
    assert_eq!(says(&fx), ["before:src/b.rs", "after:src/b.rs"]);
    assert_eq!(rig.text()[0], "src/b.rs");
    rig.key(Key::Esc);
    let selected: Vec<String> = rig
        .nodes()
        .iter()
        .filter(|n| n.state.selected)
        .map(|n| n.name.clone())
        .collect();
    assert_eq!(selected, ["src/b.rs, modified"]);
}

#[test]
fn a_restored_file_that_is_no_longer_among_the_changes_is_said_and_forgotten() {
    let saved = json!({
        "runId": "run-1", "delegationId": "d-1", "path": "", "file": "gone.rs",
    });
    let (mut rig, fx) = open_as(target(""), Some(saved));
    rig.accept(&fx[0], list(vec![modified("src/a.rs")]));
    assert_eq!(
        rig.text()[1],
        "gone.rs is not among the files this delegation changed."
    );
    assert!(rig.saved().get("file").is_none());
}

#[test]
fn a_restored_panel_whose_delegation_is_gone_says_so_and_keeps_what_it_was() {
    let saved = json!({
        "runId": "run-1", "delegationId": "d-1", "path": "src/a.rs",
    });
    let (mut rig, fx) = open_as(target("src/a.rs"), Some(saved.clone()));
    rig.refuse(&fx[0], "no_such_delegation", "no d-1");
    let screen = rig.screen().replace('\n', " ");
    assert!(
        screen.contains(
            "The changes could not be read. The owner has no such delegation. (no_such_delegation: no d-1)"
        ),
        "{screen}"
    );
    assert_eq!(rig.saved(), saved, "the layout still names what it was");
    assert!(says(&rig.send(Msg::Tick)).is_empty());
}

#[test]
fn the_kind_is_registered_and_opens_a_delegation_target_not_a_placeholder() {
    let mut registry = builtin::registry();
    extend_registry(&mut registry).unwrap();
    assert!(registry.get(&PanelKind::new("delegation")).is_some());
    let mut f = PanelFactories::new();
    theorem_workbench_changes::register(&mut f);
    assert_eq!(
        f.opener_of(&target("x")).map(PanelKind::as_str),
        Some("delegation")
    );
    assert!(
        f.opener_of(&OpenTarget::File {
            workspace: "w".into(),
            path: "a".into()
        })
        .is_none()
    );
    let (rig, _) = open(target("src/a.rs"));
    assert!(!rig.m.is_unavailable(&rig.id));
}
