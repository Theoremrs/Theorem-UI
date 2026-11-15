//! The Files panel driven through a real root: keys, pointer, completions and
//! host messages go in as `Msg`, effects and cells come out.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use serde_json::{Value, json};
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, FileEntry, FileKind, FileListing, Outcome,
};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::{ConnectionState, HostMessage};
use theorem_workbench_core::ids::{ActionId, Actor, EffectId, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::{Node, NodeId, Role, SemanticTree};
use theorem_workbench_core::stale::{Binding, Stale};
use theorem_workbench_core::{
    Button, Ctx, Model, Msg, OpenTarget, Panel, PanelFactories, PanelMsg, Pointer, PointerKind,
    Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use theorem_workbench_panels::register;

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

/// A stand-in for the document panel the real workbench registers: it shows
/// the file it was opened on and is bound to it.
struct Doc {
    workspace: String,
    path: String,
}

impl Panel for Doc {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}

    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}

    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![Node::new("doc", Role::Region, &self.path, area)]
    }

    fn serialize(&self) -> Value {
        json!({"workspace": self.workspace, "path": self.path})
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: ResourceRef::Document {
                workspace: self.workspace.clone(),
                resource_id: self.path.clone(),
            },
            revision: None,
            generation: None,
        })
    }
}

struct Rig {
    m: Model,
    id: PanelInstanceId,
}

fn named(workspace: &str) -> Msg {
    Msg::Host(HostMessage::WorkspaceChanged {
        workspace: workspace.into(),
        environment: None,
    })
}

/// A workbench with the Files panel and a document opener, in `workspace`
/// (none when empty, as before the host has named one).
fn model(workspace: &str) -> Model {
    let mut factories = PanelFactories::new();
    register(&mut factories);
    factories.register("document", |state, _| {
        Box::new(Doc {
            workspace: state["workspace"].as_str().unwrap_or("").to_owned(),
            path: state["path"].as_str().unwrap_or("").to_owned(),
        })
    });
    factories.register_opener("document", |target| {
        matches!(target, OpenTarget::File { .. })
    });
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

fn files_id(m: &Model) -> PanelInstanceId {
    m.panel_ids()
        .find(|(_, k)| k.as_str() == "files")
        .map(|(id, _)| id.clone())
        .expect("a files panel is open")
}

fn focus_files(m: &mut Model) {
    update(
        m,
        Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        },
    );
}

fn rig() -> Rig {
    let mut m = model("w");
    focus_files(&mut m);
    let id = files_id(&m);
    Rig { m, id }
}

fn ws() -> ResourceRef {
    ResourceRef::Workspace {
        workspace: "w".into(),
    }
}

fn payload(entries: Vec<FileEntry>) -> CompletionPayload {
    CompletionPayload::Files(FileListing {
        entries,
        partial: false,
    })
}

fn listing(entries: &[(&str, FileKind)]) -> CompletionPayload {
    payload(
        entries
            .iter()
            .map(|(name, kind)| FileEntry::new(*name, *kind))
            .collect(),
    )
}

use FileKind::{Directory as D, File as F, Symlink as S};

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

    fn typed(&mut self, text: &str) {
        for c in text.chars() {
            self.key(Key::Char(c));
        }
    }

    fn tick(&mut self) -> Vec<Effect> {
        self.send(Msg::Tick)
    }

    /// The host names another workspace.
    fn move_to(&mut self, workspace: &str) {
        self.send(named(workspace));
    }

    fn done(
        &mut self,
        effect: EffectId,
        outcome: Outcome,
        payload: Option<CompletionPayload>,
    ) -> Vec<Effect> {
        let mut c = Completion::new(effect, ws(), outcome);
        c.payload = payload;
        self.send(Msg::Completion(c))
    }

    fn answer_list(&mut self, effect: &Effect, entries: &[(&str, FileKind)]) {
        self.done(effect.id, Outcome::Accepted, Some(listing(entries)));
    }

    /// The first tick lists the root; answer it with the usual small tree.
    fn open_root(&mut self) {
        let fx = self.tick();
        assert_eq!(paths(&fx), vec![""]);
        self.answer_list(
            &fx[0],
            &[
                ("src", D),
                ("docs", D),
                ("README.md", F),
                ("link", S),
                ("a.txt", F),
            ],
        );
    }

    fn draw(&self, theme: &Theme, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let mut cx = ViewCtx::new(theme, self.m.workspace());
        cx.focused = true;
        self.m.panel(&self.id).unwrap().view(area, &mut buf, &cx);
        buf
    }

    fn text(&self, width: u16, height: u16) -> Vec<String> {
        let buf = self.draw(&Theme::plain(), width, height);
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

    fn screen(&self) -> String {
        self.text(90, 20).join("\n")
    }

    fn selected_line(&self) -> Option<String> {
        // The selected row is the one the theme draws reversed and bold.
        let buf = self.draw(&Theme::plain(), 40, 20);
        (0..20).find_map(|y| {
            buf[(0, y)]
                .modifier
                .contains(Modifier::REVERSED)
                .then(|| self.text(40, 20)[usize::from(y)].clone())
        })
    }

    /// The style of the first cell of `needle` on the row that shows it.
    fn style_of(&self, theme: &Theme, needle: &str) -> Style {
        let buf = self.draw(theme, 90, 20);
        for y in 0..20 {
            let line: String = (0..90).map(|x| buf[(x, y)].symbol().to_owned()).collect();
            if let Some(at) = line.find(needle) {
                let x = line[..at].chars().count() as u16;
                return buf[(x, y)].style();
            }
        }
        panic!("{needle:?} is not on the screen:\n{}", self.screen());
    }

    fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the files group")
            .body
    }

    /// A left press with `clicks` consecutive presses, then its release.
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

    fn click(&mut self, x: u16, y: u16) -> Vec<Effect> {
        self.press(x, y, 1)
    }

    /// The panels of `kind` that are open.
    fn panels_of(&self, kind: &str) -> Vec<PanelInstanceId> {
        self.m
            .panel_ids()
            .filter(|(_, k)| k.as_str() == kind)
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn focused(&self) -> Option<PanelInstanceId> {
        self.m.focus().panel.clone()
    }
}

fn paths(effects: &[Effect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|e| match &e.body {
            EffectBody::FilesList(p) => Some(p.path.clone()),
            _ => None,
        })
        .collect()
}

fn find(effects: &[Effect], pred: impl Fn(&EffectBody) -> bool) -> &Effect {
    effects
        .iter()
        .find(|e| pred(&e.body))
        .unwrap_or_else(|| panic!("no such effect in {effects:?}"))
}

/// A theme whose roles are told apart by color, so a test can say which role
/// a cell was drawn in.
fn colored() -> Theme {
    Theme {
        muted: Style::default().fg(Color::DarkGray),
        error: Style::default().fg(Color::Red),
        warning: Style::default().fg(Color::Yellow),
        ..Theme::plain()
    }
}

// ---- lazy loading (R08, AC-08) -----------------------------------------

#[test]
fn opening_and_focusing_start_nothing_and_the_first_tick_lists_the_root() {
    let mut m = model("w");
    let fx = update(
        &mut m,
        Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        },
    );
    assert!(fx.is_empty());
    update(&mut m, Msg::Focus(true));
    let fx = update(&mut m, Msg::Tick);
    assert_eq!(paths(&fx), vec![""]);
    assert!(fx[0].generation.is_some());
    assert_eq!(fx[0].resource, ws());
}

#[test]
fn expanding_lists_the_directory_once_and_only_that_directory() {
    let mut r = rig();
    r.open_root();
    assert!(r.screen().contains("> src/"));
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    assert_eq!(paths(&fx), vec!["docs"], "expanding is the trigger");
    assert!(r.screen().contains("loading"), "loading is drawn");
    // No second listing while one is in flight, or after it answered.
    assert!(paths(&r.tick()).is_empty());
    r.answer_list(&fx[0], &[("main.rs", F), ("lib", D)]);
    let screen = r.screen();
    assert!(
        screen.contains("v docs/") && screen.contains("main.rs"),
        "{screen}"
    );
    r.key(Key::Left);
    let again = r.key(Key::Right);
    assert!(
        paths(&again).is_empty(),
        "a loaded directory is not listed again"
    );
    assert!(paths(&r.tick()).is_empty());
}

#[test]
fn directories_sort_first_and_kinds_are_drawn() {
    let mut r = rig();
    r.open_root();
    let lines = r.text(40, 8);
    assert_eq!(lines[0], "> docs/");
    assert_eq!(lines[1], "> src/");
    assert_eq!(lines[2], "  a.txt");
    assert_eq!(lines[3], "  link@");
    assert_eq!(lines[4], "  README.md");
}

#[test]
fn an_empty_directory_and_an_empty_answer_are_said_so() {
    let mut r = rig();
    let fx = r.tick();
    r.answer_list(&fx[0], &[("only", D)]);
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[]);
    assert!(r.screen().contains("empty"));
}

#[test]
fn a_partial_listing_is_labeled_partial() {
    let mut r = rig();
    let fx = r.tick();
    r.done(
        fx[0].id,
        Outcome::Accepted,
        Some(CompletionPayload::Files(FileListing {
            entries: vec![FileEntry::new("a", F)],
            partial: true,
        })),
    );
    assert!(r.screen().contains("partial"));
}

// ---- stale answers -----------------------------------------------------

#[test]
fn a_listing_of_another_workspace_is_cached_not_applied() {
    let mut r = rig();
    let fx = r.tick();
    // The host moves the panel to a new workspace before the answer arrives.
    r.move_to("w2");
    r.answer_list(&fx[0], &[("old.txt", F)]);
    assert_eq!(r.m.counters().cached, 1);
    assert!(!r.screen().contains("old.txt"));
    // The panel started over for the new workspace.
    let fx = r.tick();
    assert_eq!(paths(&fx), vec![""]);
    assert_eq!(
        fx[0].resource,
        ResourceRef::Workspace {
            workspace: "w2".into()
        }
    );
}

#[test]
fn an_older_generation_is_dropped_by_the_root() {
    let mut r = rig();
    let fx = r.tick();
    let old = fx[0].generation;
    // Same resource name, newer generation: the workspace is rebound.
    r.move_to("w2");
    r.move_to("w");
    let mut c = Completion::new(fx[0].id, ws(), Outcome::Accepted);
    c.generation = old;
    c.payload = Some(listing(&[("stale", F)]));
    r.send(Msg::Completion(c));
    assert_eq!(r.m.counters().last_drop, Some(Stale::OlderGeneration));
    assert!(!r.screen().contains("stale"));
}

#[test]
fn a_listing_in_flight_across_a_resync_is_ignored_and_the_directory_is_listed_again() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    let first = fx[0].clone();
    let relist = r.send(Msg::Host(HostMessage::Resync {
        workspace: "w".into(),
        reason: "cursor_expired".into(),
    }));
    // Every listed or expanded directory is re-listed: the root and src.
    let mut got = paths(&relist);
    got.sort();
    assert_eq!(got, vec!["", "docs"]);
    r.answer_list(&first, &[("stale.rs", F)]);
    assert!(!r.screen().contains("stale.rs"));
    let src = relist
        .iter()
        .find(|e| matches!(&e.body, EffectBody::FilesList(p) if p.path == "docs"))
        .unwrap()
        .clone();
    r.answer_list(&src, &[("fresh.rs", F)]);
    assert!(r.screen().contains("fresh.rs"));
}

#[test]
fn a_change_re_lists_only_the_changed_directory() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let docs = r.key(Key::Right);
    r.answer_list(&docs[0], &[("g.md", F)]);
    r.key(Key::Down);
    r.key(Key::Down);
    let src = r.key(Key::Right);
    r.answer_list(&src[0], &[("a.rs", F)]);

    let fx = r.send(Msg::Host(HostMessage::FileChanged {
        workspace: "w".into(),
        path: "src/a.rs".into(),
    }));
    assert_eq!(paths(&fx), vec!["src"]);
    r.answer_list(&fx[0], &[("a.rs", F), ("b.rs", F)]);
    assert!(r.screen().contains("b.rs") && r.screen().contains("g.md"));

    // A change in a directory nothing loaded is not our business.
    let fx = r.send(Msg::Host(HostMessage::FileChanged {
        workspace: "w".into(),
        path: "elsewhere/x".into(),
    }));
    assert!(fx.is_empty());
    // Another workspace's change is not ours either.
    let fx = r.send(Msg::Host(HostMessage::FileChanged {
        workspace: "other".into(),
        path: "src/a.rs".into(),
    }));
    assert!(fx.is_empty());
    // Lost events: everything expanded.
    let fx = r.send(Msg::Host(HostMessage::FileChanged {
        workspace: "w".into(),
        path: ".".into(),
    }));
    assert_eq!(paths(&fx).len(), 3);
}

#[test]
fn a_change_while_listing_re_lists_after_the_answer() {
    let mut r = rig();
    let fx = r.tick();
    let during = r.send(Msg::Host(HostMessage::FileChanged {
        workspace: "w".into(),
        path: "x".into(),
    }));
    assert!(paths(&during).is_empty(), "one listing at a time");
    let _ = during;
    r.answer_list(&fx[0], &[("x", F)]);
    // The directory was not loaded when the change came, so it was not owed:
    // the answer already reflects it.
    assert!(paths(&r.tick()).is_empty());
}

// ---- states ------------------------------------------------------------

#[test]
fn refused_unavailable_and_failed_listings_are_drawn_per_directory() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let docs = r.key(Key::Right);
    r.done(
        docs[0].id,
        Outcome::Refused {
            code: "permission_denied".into(),
            reason: "no access to docs".into(),
        },
        None,
    );
    let screen = r.screen();
    assert!(
        screen.contains("refused (permission_denied): no access to docs"),
        "{screen}"
    );
    // The siblings are untouched.
    assert!(screen.contains("src/") && screen.contains("README.md"));

    r.key(Key::Down);
    let src = r.key(Key::Right);
    r.done(
        src[0].id,
        Outcome::Refused {
            code: "environment_unavailable".into(),
            reason: "the workspace host is down".into(),
        },
        None,
    );
    assert!(
        r.screen()
            .contains("unavailable: the workspace host is down")
    );

    // Expanding again retries a directory that never loaded.
    r.key(Key::Left);
    let retry = r.key(Key::Right);
    assert_eq!(paths(&retry), vec!["src"]);
    r.done(
        retry[0].id,
        Outcome::Failed {
            reason: "boom".into(),
        },
        None,
    );
    assert!(r.screen().contains("failed: boom"));
}

#[test]
fn a_dropped_connection_is_a_line_above_the_rows() {
    let mut r = rig();
    r.open_root();
    r.send(Msg::Host(HostMessage::ConnectionChanged {
        workspace: "w".into(),
        state: ConnectionState::Reconnecting,
    }));
    let lines = r.text(60, 4);
    assert!(lines[0].starts_with("reconnecting"), "{lines:?}");
    assert_eq!(lines[1], "> docs/");
    r.send(Msg::Host(HostMessage::ConnectionChanged {
        workspace: "w".into(),
        state: ConnectionState::Open,
    }));
    assert_eq!(r.text(60, 2)[0], "> docs/");
}

#[test]
fn losing_the_files_capability_says_so_and_regaining_it_lists_again() {
    let mut r = rig();
    r.open_root();
    r.send(Msg::Host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["documents"]),
    }));
    assert!(r.screen().contains("files service is unavailable"));
    assert!(paths(&r.tick()).is_empty());
    let fx = r.send(Msg::Host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(CAPS),
    }));
    assert_eq!(paths(&fx), vec![""]);
}

#[test]
fn without_a_workspace_nothing_is_listed() {
    let mut m = model("");
    focus_files(&mut m);
    assert!(update(&mut m, Msg::Tick).is_empty());
    assert!(
        update(&mut m, Msg::Tick).is_empty(),
        "and it keeps saying so"
    );
}

// ---- keyboard ---------------------------------------------------------

#[test]
fn arrow_home_end_and_page_keys_move_the_selection() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Down);
    assert!(r.selected_line().unwrap().contains("docs/"));
    r.key(Key::Down);
    assert!(r.selected_line().unwrap().contains("src/"));
    r.key(Key::End);
    assert!(r.selected_line().unwrap().contains("README.md"));
    r.key(Key::Home);
    assert!(r.selected_line().unwrap().contains("docs/"));
    r.key(Key::PageDown);
    assert!(
        r.selected_line().unwrap().contains("README.md"),
        "clamps at the end"
    );
    r.key(Key::PageUp);
    assert!(r.selected_line().unwrap().contains("docs/"));
}

#[test]
fn left_and_right_collapse_expand_and_walk_to_the_parent_and_first_child() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("deep", D), ("f.rs", F)]);
    r.key(Key::Right);
    assert!(r.selected_line().unwrap().contains("deep/"), "first child");
    r.key(Key::Left);
    assert!(
        r.selected_line().unwrap().contains("docs/"),
        "to the parent"
    );
    r.key(Key::Left);
    assert!(!r.screen().contains("deep"), "collapsed");
}

#[test]
fn type_ahead_finds_by_prefix_and_cycles() {
    let mut r = rig();
    r.open_root();
    r.typed("rea");
    assert!(r.selected_line().unwrap().contains("README.md"));
    // A pause starts a new search.
    for _ in 0..100 {
        r.tick();
    }
    r.typed("s");
    assert!(r.selected_line().unwrap().contains("src/"));
    r.typed("x");
    assert!(
        r.selected_line().unwrap().contains("src/"),
        "no match leaves the selection where it was"
    );
}

#[test]
fn enter_on_a_directory_toggles_and_lists_it() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Enter);
    assert_eq!(paths(&fx), vec!["docs"]);
    assert!(r.panels_of("document").is_empty(), "a folder opens nothing");
}

#[test]
fn open_asks_the_root_and_a_second_enter_focuses_rather_than_duplicates() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    let fx = r.key(Key::Enter);
    assert!(fx.is_empty(), "opening is not an effect");
    let docs = r.panels_of("document");
    assert_eq!(docs.len(), 1, "the root opened the document panel");
    assert_eq!(r.focused().as_ref(), Some(&docs[0]), "and focused it");
    assert_eq!(
        r.m.panel(&docs[0]).unwrap().serialize(),
        json!({"workspace": "w", "path": "a.txt"}),
        "for the file in the panel's workspace"
    );

    // Back in the tree, the same file is shown by the panel that has it.
    focus_files(&mut r.m);
    assert_eq!(r.focused().as_ref(), Some(&r.id));
    r.key(Key::Enter);
    assert_eq!(r.panels_of("document"), docs, "no second panel");
    assert_eq!(r.focused().as_ref(), Some(&docs[0]), "the first is focused");

    // Another file gets a panel of its own.
    focus_files(&mut r.m);
    r.typed("rea");
    r.key(Key::Enter);
    assert_eq!(r.panels_of("document").len(), 2);
}

// ---- writes -------------------------------------------------------------

fn rename_a_txt(r: &mut Rig, new_name: &str) -> Effect {
    r.typed("a.t");
    r.key(Key::F2);
    assert!(r.m.panel(&r.id).unwrap().text_entry());
    r.mods(Key::Char('u'), Mods::CTRL);
    r.typed(new_name);
    let fx = r.key(Key::Enter);
    find(&fx, |b| matches!(b, EffectBody::FilesRename(_))).clone()
}

#[test]
fn rename_is_an_inline_edit_then_a_pending_row_then_applied() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    r.key(Key::F2);
    assert!(r.screen().contains("a.txt"), "the edit row holds the name");
    r.key(Key::Esc);
    assert!(!r.m.panel(&r.id).unwrap().text_entry());

    let rename = rename_a_txt(&mut r, "b.txt");
    let EffectBody::FilesRename(body) = &rename.body else {
        unreachable!()
    };
    assert_eq!((body.from.as_str(), body.to.as_str()), ("a.txt", "b.txt"));
    assert!(r.screen().contains("a.txt  renaming to b.txt..."));
    assert!(paths(&r.tick()).is_empty(), "a write is sent once");

    let fx = r.done(rename.id, Outcome::Accepted, None);
    let screen = r.screen();
    assert!(
        screen.contains("b.txt") && !screen.contains("a.txt"),
        "{screen}"
    );
    assert!(
        r.selected_line().unwrap().contains("b.txt"),
        "selection follows"
    );
    // The accepted write is confirmed against the host.
    assert_eq!(paths(&fx), vec![""]);
}

#[test]
fn the_panel_will_not_send_a_name_it_can_see_is_taken_or_invalid() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    r.key(Key::F2);
    r.mods(Key::Char('u'), Mods::CTRL);
    r.typed("README.md");
    let fx = r.key(Key::Enter);
    assert!(fx.is_empty());
    assert!(r.screen().contains("that name is taken"));
    r.mods(Key::Char('u'), Mods::CTRL);
    r.typed("a/b");
    assert!(r.key(Key::Enter).is_empty());
    assert!(r.screen().contains("not a valid name"));
    r.mods(Key::Char('u'), Mods::CTRL);
    assert!(r.key(Key::Enter).is_empty());
    assert!(r.screen().contains("a name is required"));
}

#[test]
fn refused_and_failed_writes_stay_on_the_row_until_dismissed() {
    let mut r = rig();
    r.open_root();
    let rename = rename_a_txt(&mut r, "b.txt");
    r.done(
        rename.id,
        Outcome::Refused {
            code: "already_exists".into(),
            reason: "b.txt exists".into(),
        },
        None,
    );
    assert!(
        r.screen()
            .contains("a.txt  refused (already_exists): b.txt exists")
    );
    r.key(Key::Esc);
    assert!(!r.screen().contains("refused"));

    let rename = rename_a_txt(&mut r, "c.txt");
    r.done(
        rename.id,
        Outcome::Failed {
            reason: "disk full".into(),
        },
        None,
    );
    assert!(r.screen().contains("a.txt  failed: disk full"));
}

#[test]
fn an_uncertain_write_is_unknown_until_a_person_refreshes_and_is_never_retried() {
    let mut r = rig();
    r.open_root();
    let rename = rename_a_txt(&mut r, "b.txt");
    r.done(
        rename.id,
        Outcome::Uncertain {
            reason: "reply lost".into(),
        },
        None,
    );
    assert!(r.screen().contains("a.txt  unknown result: reply lost"));
    for _ in 0..5 {
        assert!(r.tick().is_empty(), "nothing is retried or re-listed alone");
    }
    // F5 lists the directory; what the host says replaces the guess.
    let fx = r.key(Key::F5);
    assert_eq!(paths(&fx), vec![""]);
    r.answer_list(&fx[0], &[("b.txt", F)]);
    let screen = r.screen();
    assert!(
        screen.contains("b.txt") && !screen.contains("unknown"),
        "{screen}"
    );
}

#[test]
fn delete_asks_first_and_only_then_sends() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    let fx = r.key(Key::Delete);
    assert!(fx.is_empty(), "the key alone sends nothing");
    assert!(
        r.screen()
            .contains("Delete a.txt? Enter deletes, Escape cancels")
    );
    assert!(r.key(Key::Esc).is_empty());
    assert!(!r.screen().contains("Delete a.txt?"));

    r.key(Key::Delete);
    assert!(
        r.key(Key::Char('q')).is_empty(),
        "other keys do not confirm"
    );
    let fx = r.key(Key::Enter);
    let del = find(&fx, |b| matches!(b, EffectBody::FilesDelete(_))).clone();
    assert!(r.screen().contains("a.txt  deleting..."));
    r.done(del.id, Outcome::Accepted, None);
    let screen = r.screen();
    assert!(!screen.contains("a.txt"), "{screen}");
    assert!(r.selected_line().is_some(), "selection moved to a neighbor");
}

#[test]
fn deleting_a_directory_names_what_it_holds() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    r.key(Key::Delete);
    assert!(r.screen().contains("Delete docs and everything in it?"));
}

#[test]
fn new_file_and_new_folder_are_inline_rows_created_on_enter() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.mods(Key::Char('N'), Mods::ALT);
    assert!(
        paths(&fx).contains(&"docs".to_owned()),
        "docs is expanded to hold it"
    );
    r.answer_list(&fx[0], &[]);
    r.typed("notes");
    let fx = r.key(Key::Enter);
    let create = find(&fx, |b| matches!(b, EffectBody::FilesCreate(_))).clone();
    let EffectBody::FilesCreate(c) = &create.body else {
        unreachable!()
    };
    assert_eq!((c.path.as_str(), c.directory), ("docs/notes", true));
    assert!(r.screen().contains("notes/  creating..."));
    r.done(create.id, Outcome::Accepted, None);
    assert!(r.screen().contains("notes/") && !r.screen().contains("creating"));

    r.key(Key::Home);
    r.mods(Key::Char('n'), Mods::ALT);
    r.typed("x.rs");
    let fx = r.key(Key::Enter);
    let create = find(&fx, |b| matches!(b, EffectBody::FilesCreate(_))).clone();
    r.done(
        create.id,
        Outcome::Refused {
            code: "outside_workspace".into(),
            reason: "no".into(),
        },
        None,
    );
    assert!(
        r.screen().contains("x.rs  refused (outside_workspace): no"),
        "{}",
        r.screen()
    );
}

#[test]
fn cut_and_paste_moves() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    r.mods(Key::Char('x'), Mods::CTRL);
    assert!(r.screen().contains("a.txt (cut)"));
    r.key(Key::Home);
    let fx = r.mods(Key::Char('v'), Mods::CTRL);
    let mv = find(&fx, |b| matches!(b, EffectBody::FilesRename(_))).clone();
    let EffectBody::FilesRename(b) = &mv.body else {
        unreachable!()
    };
    assert_eq!((b.from.as_str(), b.to.as_str()), ("a.txt", "docs/a.txt"));
    r.done(mv.id, Outcome::Accepted, None);
    assert!(!r.screen().contains("a.txt"), "moved out of the root");
}

#[test]
fn a_cut_onto_a_name_that_is_there_is_refused_not_sent() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    r.mods(Key::Char('x'), Mods::CTRL);
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("a.txt", F)]);
    let fx = r.mods(Key::Char('v'), Mods::CTRL);
    assert!(fx.is_empty(), "{fx:?}");
    assert!(r.screen().contains("name_taken"), "{}", r.screen());
}

fn copy_of(effects: &[Effect]) -> (Effect, String, String, bool) {
    let e = find(effects, |b| matches!(b, EffectBody::FilesCopy(_))).clone();
    let EffectBody::FilesCopy(c) = &e.body else {
        unreachable!()
    };
    let (from, to, overwrite) = (c.from.clone(), c.to.clone(), c.overwrite);
    (e, from, to, overwrite)
}

#[test]
fn copy_and_paste_emits_a_copy_that_does_not_overwrite() {
    let mut r = rig();
    r.open_root();
    r.typed("rea");
    r.mods(Key::Char('c'), Mods::CTRL);
    assert!(r.screen().contains("README.md (copy)"));
    r.key(Key::Home);
    let fx = r.mods(Key::Char('v'), Mods::CTRL);
    let (copy, from, to, overwrite) = copy_of(&fx);
    assert_eq!(
        (from.as_str(), to.as_str(), overwrite),
        ("README.md", "docs/README.md", false)
    );
    assert!(
        r.screen()
            .contains("README.md (copy)  copying to docs/README.md..."),
        "{}",
        r.screen()
    );
    assert!(
        r.mods(Key::Char('v'), Mods::CTRL).is_empty(),
        "one copy at a time while it is pending"
    );
    r.done(copy.id, Outcome::Accepted, None);
    let screen = r.screen();
    assert!(!screen.contains("copying"), "{screen}");
    assert!(
        screen.contains("README.md (copy)"),
        "a copy stays marked, so it can be pasted again: {screen}"
    );
}

#[test]
fn a_copy_onto_a_name_that_is_there_asks_before_it_overwrites() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    r.mods(Key::Char('c'), Mods::CTRL);
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("a.txt", F), ("keep.md", F)]);
    let fx = r.mods(Key::Char('v'), Mods::CTRL);
    assert!(fx.is_empty(), "nothing is sent before the answer: {fx:?}");
    assert!(
        r.screen()
            .contains("Replace a.txt? Enter replaces, Escape cancels"),
        "{}",
        r.screen()
    );
    assert!(r.key(Key::Char('q')).is_empty(), "other keys do not answer");

    // No: nothing is sent and the question goes away.
    assert!(r.key(Key::Esc).is_empty());
    assert!(!r.screen().contains("Replace a.txt?"));

    // Yes: the copy goes out with overwrite set.
    r.mods(Key::Char('v'), Mods::CTRL);
    let fx = r.key(Key::Enter);
    let (copy, from, to, overwrite) = copy_of(&fx);
    assert_eq!(
        (from.as_str(), to.as_str(), overwrite),
        ("a.txt", "docs/a.txt", true)
    );
    r.done(
        copy.id,
        Outcome::Refused {
            code: "permission_denied".into(),
            reason: "read-only".into(),
        },
        None,
    );
    assert!(
        r.screen()
            .contains("a.txt (copy)  refused (permission_denied): read-only"),
        "{}",
        r.screen()
    );
}

// ---- pointer ----------------------------------------------------------------

#[test]
fn click_selects_the_disclosure_toggles_double_click_opens_and_the_wheel_scrolls() {
    let mut r = rig();
    r.open_root();
    r.click(6, 4);
    assert!(r.selected_line().unwrap().contains("README.md"));
    assert!(r.panels_of("document").is_empty(), "a click only selects");

    let fx = r.click(0, 0);
    assert_eq!(paths(&fx), vec!["docs"], "the disclosure toggles");
    r.answer_list(&fx[0], &[("a", F)]);
    assert!(r.screen().contains("v docs/"));

    // Enough rows to scroll: the host says everything changed and the root
    // comes back long.
    let relist = r.send(Msg::Host(HostMessage::FileChanged {
        workspace: "w".into(),
        path: ".".into(),
    }));
    let root = relist
        .iter()
        .find(|e| matches!(&e.body, EffectBody::FilesList(p) if p.path.is_empty()))
        .unwrap()
        .clone();
    let many: Vec<(String, FileKind)> = (0..60).map(|i| (format!("f{i:02}"), F)).collect();
    let entries: Vec<(&str, FileKind)> = many.iter().map(|(n, k)| (n.as_str(), *k)).collect();
    r.answer_list(&root, &entries);
    assert_eq!(r.text(40, 20)[0], "  f00");
    let b = r.body();
    r.send(Msg::Pointer(Pointer {
        kind: PointerKind::Wheel { dx: 0, dy: 5 },
        x: b.x + 1,
        y: b.y + 1,
        mods: Mods::NONE,
        clicks: 1,
    }));
    assert_eq!(r.text(40, 20)[0], "  f05", "scrolled five rows");
}

#[test]
fn double_click_is_the_hosts_count_not_the_time_between_presses() {
    let mut r = rig();
    r.open_root();
    // Many ticks between two presses of count 1: two single clicks.
    r.press(6, 4, 1);
    for _ in 0..3 {
        r.tick();
    }
    r.press(6, 4, 1);
    assert!(
        r.panels_of("document").is_empty(),
        "{:?}",
        r.panels_of("document")
    );

    // A press the host counts as the second opens the row it is on.
    r.press(6, 4, 2);
    let docs = r.panels_of("document");
    assert_eq!(docs.len(), 1);
    assert_eq!(
        r.m.panel(&docs[0]).unwrap().serialize()["path"],
        "README.md"
    );

    // On a folder, the second press toggles it like Enter does.
    focus_files(&mut r.m);
    let fx = r.press(6, 0, 2);
    assert_eq!(paths(&fx), vec!["docs"]);
}

#[test]
fn a_double_press_on_the_disclosure_mark_does_not_toggle_twice() {
    let mut r = rig();
    r.open_root();
    let fx = r.press(0, 0, 1);
    assert_eq!(paths(&fx), vec!["docs"], "the first press expands");
    r.answer_list(&fx[0], &[("x", F)]);
    assert!(r.screen().contains("v docs/"));
    r.press(0, 0, 2);
    assert!(
        r.screen().contains("v docs/"),
        "the second does not undo it"
    );
}

// ---- persistence ----------------------------------------------------------------

#[test]
fn view_state_is_saved_without_contents_and_restored_lazily() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("secret-file-name.txt", F)]);
    let saved = r.m.document();
    let text = saved.to_string();
    assert!(text.contains("\"expanded\":[\"docs\"]"), "{text}");
    assert!(
        !text.contains("secret-file-name") && !text.contains("README"),
        "no listing is saved: {text}"
    );

    let mut m2 = model("w");
    m2.restore(saved).expect("restores");
    let id = m2
        .panel_ids()
        .find(|(_, k)| k.as_str() == "files")
        .map(|(id, _)| id.clone())
        .expect("files restored");
    // Restoring emitted nothing; the first tick lists what is expanded and visible.
    let fx = update(&mut m2, Msg::Tick);
    let mut got = paths(&fx);
    got.sort();
    assert_eq!(got, vec!["", "docs"]);
    let _ = id;
}

#[test]
fn a_saved_state_that_is_nonsense_still_opens() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("a", F)]);
    let text = r.m.document().to_string().replace(
        "\"expanded\":[\"docs\"]",
        "\"expanded\":5,\"selected\":3,\"scroll\":\"x\"",
    );
    let mut m = model("w");
    m.restore(serde_json::from_str(&text).unwrap())
        .expect("restores");
    let fx = update(&mut m, Msg::Tick);
    assert_eq!(paths(&fx), vec![""]);
}

// ---- semantics and cells ------------------------------------------------------------

fn tree_of(r: &Rig, height: u16) -> SemanticTree {
    let area = Rect::new(0, 0, 40, height);
    let theme = Theme::plain();
    let mut cx = ViewCtx::new(&theme, r.m.workspace());
    cx.focused = true;
    let nodes = r.m.panel(&r.id).unwrap().semantics(area, &cx);
    SemanticTree {
        root: nodes[0].id.clone(),
        nodes,
    }
}

#[test]
fn the_semantic_tree_is_a_valid_tree_of_treeitems_with_state_and_position() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("x.rs", F)]);
    r.key(Key::Down);
    let tree = tree_of(&r, 20);
    tree.validate().expect("one valid tree");
    let root = tree.node(&tree.root).unwrap();
    assert_eq!(root.role, Role::Tree);
    let docs = tree.node(&NodeId::new("f:docs")).unwrap();
    assert_eq!(docs.role, Role::TreeItem);
    assert_eq!(docs.state.expanded, Some(true));
    assert!(!docs.state.selected);
    assert_eq!(
        (docs.level, docs.pos_in_set, docs.set_size),
        (Some(1), Some(1), Some(5)),
        "typed fields, not words in the description"
    );
    assert_eq!(docs.state.description, None, "nothing to act on");
    let x = tree.node(&NodeId::new("f:docs/x.rs")).unwrap();
    assert!(x.state.selected && x.state.focused);
    assert_eq!(
        (x.level, x.pos_in_set, x.set_size),
        (Some(2), Some(1), Some(1))
    );
    let src = tree.node(&NodeId::new("f:src")).unwrap();
    assert_eq!(src.state.expanded, Some(false));
    assert_eq!(
        (src.level, src.pos_in_set, src.set_size),
        (Some(1), Some(2), Some(5))
    );
    let link = tree.node(&NodeId::new("f:link")).unwrap();
    assert_eq!(link.name, "link (symlink)", "the node has no kind field");
    assert_eq!(
        (link.level, link.pos_in_set, link.set_size),
        (Some(1), Some(4), Some(5))
    );
    assert!(
        tree.nodes
            .iter()
            .filter(|n| n.role == Role::TreeItem)
            .all(|n| n.state.description.is_none()),
        "no row has a reason to give yet"
    );
    // The loading line under a folder has a level too.
    let status = tree.nodes.iter().find(|n| n.role == Role::Status);
    assert!(status.is_none_or(|n| n.level.is_some()));
    // Ids come from paths, so the same row has the same id after a re-render.
    assert_eq!(tree_of(&r, 20), tree);
}

#[test]
fn only_the_visible_window_has_nodes_and_pending_rows_are_busy() {
    let mut r = rig();
    r.open_root();
    let small = tree_of(&r, 3);
    small.validate().unwrap();
    assert_eq!(small.nodes.len(), 1 + 3);
    let rename = rename_a_txt(&mut r, "b.txt");
    let _ = rename;
    let tree = tree_of(&r, 20);
    tree.validate().unwrap();
    assert!(tree.nodes.iter().any(|n| n.state.busy));
}

#[test]
fn a_refusal_is_the_description_of_its_row_and_nothing_else_is() {
    let mut r = rig();
    r.open_root();
    let rename = rename_a_txt(&mut r, "b.txt");
    r.done(
        rename.id,
        Outcome::Refused {
            code: "already_exists".into(),
            reason: "b.txt exists".into(),
        },
        None,
    );
    let tree = tree_of(&r, 20);
    tree.validate().unwrap();
    let described: Vec<(&str, &str)> = tree
        .nodes
        .iter()
        .filter_map(|n| Some((n.id.as_str(), n.state.description.as_deref()?)))
        .collect();
    assert_eq!(
        described,
        vec![("f:a.txt", "refused (already_exists): b.txt exists")]
    );
}

#[test]
fn level_position_and_size_validate_for_every_row_kind() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("deep", D), ("x.rs", F)]);
    r.key(Key::Right);
    let fx = r.key(Key::Right);
    // A folder still loading, a delete question and the name field.
    assert_eq!(paths(&fx), vec!["docs/deep"]);
    r.mods(Key::Char('n'), Mods::ALT);
    let tree = tree_of(&r, 20);
    tree.validate().expect("one valid tree");
    for n in tree.nodes.iter().filter(|n| n.role == Role::TreeItem) {
        let (level, pos, size) = (n.level.unwrap(), n.pos_in_set.unwrap(), n.set_size.unwrap());
        assert!(level >= 1 && (1..=size).contains(&pos), "{n:?}");
    }
    assert!(tree.nodes.iter().any(|n| n.role == Role::TextBox));
    r.key(Key::Esc);
    r.key(Key::Delete);
    let tree = tree_of(&r, 20);
    tree.validate().expect("one valid tree");
    assert!(tree.nodes.iter().any(|n| n.role == Role::Alert));
}

#[test]
fn the_whole_workbench_tree_validates_with_the_panel_in_it() {
    let mut r = rig();
    r.open_root();
    let tree = theorem_workbench_core::semantics(&r.m);
    tree.validate().expect("one valid tree");
    assert!(tree.nodes.iter().any(|n| n.role == Role::TreeItem));
}

#[test]
fn a_small_tree_draws_with_disclosure_marks_indent_and_the_selected_row() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("deep", D), ("x.rs", F)]);
    r.key(Key::Down);
    let lines = r.text(30, 9);
    assert_eq!(
        lines,
        vec![
            "v docs/",
            "  > deep/",
            "    x.rs",
            "> src/",
            "  a.txt",
            "  link@",
            "  README.md",
            "",
            ""
        ]
    );
    // The selection is styled through the theme's role, not drawn as text.
    assert_eq!(r.selected_line().as_deref(), Some("  > deep/"));
}

// ---- the workspace the root names ---------------------------------------------

#[test]
fn the_panel_is_bound_to_the_roots_workspace_from_the_moment_it_is_built() {
    let mut m = model("w");
    focus_files(&mut m);
    let panel = m.panel(&files_id(&m)).unwrap();
    let binding = panel.binding().expect("always bound");
    assert_eq!(binding.resource, ws());
    assert_eq!(
        binding.generation,
        Some(m.workspace().generation),
        "no tick or key has reached the panel yet"
    );
    assert!(m.workspace().generation.0 > 0);

    // Before the host names a workspace the panel is bound to none, at 0.
    let mut empty = model("");
    focus_files(&mut empty);
    let binding = empty.panel(&files_id(&empty)).unwrap().binding().unwrap();
    assert_eq!(
        binding.resource,
        ResourceRef::Workspace {
            workspace: String::new()
        }
    );
    assert_eq!(binding.generation.map(|g| g.0), Some(0));
}

#[test]
fn a_workspace_change_resets_the_tree_rebinds_and_lists_the_new_root_lazily() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    let fx = r.key(Key::Right);
    r.answer_list(&fx[0], &[("kept.txt", F)]);
    r.key(Key::Down);
    r.mods(Key::Char('c'), Mods::CTRL);
    let before = r.m.workspace().generation;

    // Changing the workspace starts nothing by itself.
    r.send(named("w2"));
    assert!(r.m.workspace().generation > before);
    let binding = r.m.panel(&r.id).unwrap().binding().unwrap();
    assert_eq!(
        binding.resource,
        ResourceRef::Workspace {
            workspace: "w2".into()
        }
    );
    assert_eq!(binding.generation, Some(r.m.workspace().generation));
    let screen = r.screen();
    assert!(
        !screen.contains("docs") && !screen.contains("kept.txt") && !screen.contains("(copy)"),
        "nothing of the old tree, selection or clipboard survives: {screen}"
    );
    assert!(screen.contains("loading"), "{screen}");
    assert_eq!(
        r.m.panel(&r.id).unwrap().serialize(),
        json!({"expanded": [], "selected": null, "scroll": 0})
    );

    // The next tick lists the root of the new workspace, at the new generation.
    let fx = r.tick();
    assert_eq!(paths(&fx), vec![""]);
    assert_eq!(
        fx[0].resource,
        ResourceRef::Workspace {
            workspace: "w2".into()
        }
    );
    assert_eq!(fx[0].generation, Some(r.m.workspace().generation));

    // Its answer is applied; the same message again changes nothing.
    let mut c = Completion::new(fx[0].id, fx[0].resource.clone(), Outcome::Accepted);
    c.generation = fx[0].generation;
    c.payload = Some(listing(&[("new.md", F)]));
    r.send(Msg::Completion(c));
    assert!(r.screen().contains("new.md"));
    r.send(named("w2"));
    assert!(
        r.screen().contains("new.md"),
        "a repeated identity is not a change"
    );
    assert!(paths(&r.tick()).is_empty());
}

#[test]
fn a_new_environment_of_the_same_workspace_is_a_new_binding() {
    let mut r = rig();
    r.open_root();
    r.send(Msg::Host(HostMessage::WorkspaceChanged {
        workspace: "w".into(),
        environment: Some("remote".into()),
    }));
    assert!(!r.screen().contains("README.md"));
    let fx = r.tick();
    assert_eq!(paths(&fx), vec![""]);
    assert_eq!(fx[0].generation, Some(r.m.workspace().generation));
}

// ---- muted rows -----------------------------------------------------------------

fn flagged() -> CompletionPayload {
    payload(vec![
        FileEntry::new("src", D),
        FileEntry {
            ignored: Some(true),
            ..FileEntry::new("target", D)
        },
        FileEntry {
            hidden: Some(true),
            ..FileEntry::new(".env", F)
        },
        FileEntry {
            ignored: Some(false),
            hidden: Some(false),
            ..FileEntry::new("plain.txt", F)
        },
    ])
}

#[test]
fn ignored_and_hidden_entries_are_drawn_muted_and_never_left_out() {
    let mut r = rig();
    let fx = r.tick();
    r.done(fx[0].id, Outcome::Accepted, Some(flagged()));
    let plain = Theme::plain();
    let dim = |name: &str| {
        r.style_of(&plain, name)
            .add_modifier
            .contains(Modifier::DIM)
    };
    assert!(dim("target/"), "ignored: {}", r.screen());
    assert!(dim(".env"), "hidden: {}", r.screen());
    assert!(!dim("src/") && !dim("plain.txt"), "{}", r.screen());

    // The theme's own muted role, not a modifier of the panel's.
    let colors = colored();
    assert_eq!(r.style_of(&colors, "target/").fg, Some(Color::DarkGray));
    assert_eq!(r.style_of(&colors, ".env").fg, Some(Color::DarkGray));
    assert_ne!(r.style_of(&colors, "plain.txt").fg, Some(Color::DarkGray));

    // The cursor row stays legible: it keeps the selection's own style.
    r.typed("targ");
    let line = r.selected_line().unwrap();
    assert!(line.contains("target/"), "{line}");
    assert!(
        !r.style_of(&plain, "target/")
            .add_modifier
            .contains(Modifier::DIM)
    );

    // A muted row is not described as anything: it is not a reason to act.
    let tree = tree_of(&r, 20);
    tree.validate().unwrap();
    assert!(
        tree.node(&NodeId::new("f:.env"))
            .unwrap()
            .state
            .description
            .is_none()
    );
}

#[test]
fn a_muted_entry_stays_muted_when_it_is_renamed_in_place() {
    let mut r = rig();
    let fx = r.tick();
    r.done(fx[0].id, Outcome::Accepted, Some(flagged()));
    r.typed(".e");
    r.key(Key::F2);
    r.mods(Key::Char('u'), Mods::CTRL);
    r.typed(".env.local");
    let fx = r.key(Key::Enter);
    let rename = find(&fx, |b| matches!(b, EffectBody::FilesRename(_))).clone();
    r.done(rename.id, Outcome::Accepted, None);
    r.key(Key::Esc);
    r.key(Key::Home);
    let dim = r
        .style_of(&Theme::plain(), ".env.local")
        .add_modifier
        .contains(Modifier::DIM);
    assert!(dim, "until the host says otherwise: {}", r.screen());
}

// ---- theme roles for refusals and unknown results -----------------------------------

#[test]
fn on_the_focus_fill_a_problem_keeps_its_role_color_on_the_panes_background() {
    // The role colors are chosen against the pane; on the focus fill they cannot be read.
    let mut r = rig();
    r.open_root();
    let theme = Theme {
        bg: Style::default().bg(Color::Blue),
        text: Style::default().fg(Color::White),
        focus: Style::default().fg(Color::Black).bg(Color::Cyan),
        ..colored()
    };
    let rename = rename_a_txt(&mut r, "b.txt");
    r.done(
        rename.id,
        Outcome::Refused {
            code: "already_exists".into(),
            reason: "b.txt exists".into(),
        },
        None,
    );
    let note = r.style_of(&theme, "refused (already_exists)");
    assert_eq!(
        (note.fg, note.bg),
        (Some(Color::Red), Some(Color::Blue)),
        "{}",
        r.screen()
    );
}

#[test]
fn refusals_and_failures_use_the_error_role_and_unknown_results_the_warning_role() {
    let mut r = rig();
    r.open_root();
    let theme = colored();

    // A refused write.
    let rename = rename_a_txt(&mut r, "b.txt");
    r.done(
        rename.id,
        Outcome::Refused {
            code: "already_exists".into(),
            reason: "b.txt exists".into(),
        },
        None,
    );
    assert_eq!(
        r.style_of(&theme, "refused (already_exists)").fg,
        Some(Color::Red),
        "{}",
        r.screen()
    );

    // A failed write.
    r.key(Key::Esc);
    let rename = rename_a_txt(&mut r, "c.txt");
    r.done(
        rename.id,
        Outcome::Failed {
            reason: "disk full".into(),
        },
        None,
    );
    assert_eq!(r.style_of(&theme, "failed: disk full").fg, Some(Color::Red));

    // An unknown result is not an error: nobody knows.
    r.key(Key::Esc);
    let rename = rename_a_txt(&mut r, "d.txt");
    r.done(
        rename.id,
        Outcome::Uncertain {
            reason: "reply lost".into(),
        },
        None,
    );
    assert_eq!(
        r.style_of(&theme, "unknown result: reply lost").fg,
        Some(Color::Yellow)
    );

    // A pending write is neither.
    r.key(Key::Esc);
    let _ = rename_a_txt(&mut r, "e.txt");
    assert_eq!(
        r.style_of(&theme, "renaming to e.txt...").fg,
        Some(Color::DarkGray)
    );
}

#[test]
fn listing_problems_and_the_connection_line_use_their_roles() {
    let mut r = rig();
    r.open_root();
    let theme = colored();
    r.key(Key::Home);
    let docs = r.key(Key::Right);
    r.done(
        docs[0].id,
        Outcome::Refused {
            code: "permission_denied".into(),
            reason: "no access".into(),
        },
        None,
    );
    assert_eq!(
        r.style_of(&theme, "refused (permission_denied)").fg,
        Some(Color::Red)
    );
    r.key(Key::Left);
    let retry = r.key(Key::Right);
    r.done(
        retry[0].id,
        Outcome::Uncertain {
            reason: "timed out".into(),
        },
        None,
    );
    assert_eq!(
        r.style_of(&theme, "unknown result: timed out").fg,
        Some(Color::Yellow)
    );
    r.send(Msg::Host(HostMessage::ConnectionChanged {
        workspace: "w".into(),
        state: ConnectionState::Closed,
    }));
    assert_eq!(
        r.style_of(&theme, "disconnected").fg,
        Some(Color::Yellow),
        "out of date is attention, not failure"
    );
}

#[test]
fn an_invalid_name_and_a_delete_question_are_told_by_role_too() {
    let mut r = rig();
    r.open_root();
    let theme = colored();
    r.typed("a.t");
    r.key(Key::F2);
    r.mods(Key::Char('u'), Mods::CTRL);
    r.typed("README.md");
    r.key(Key::Enter);
    assert_eq!(
        r.style_of(&theme, "that name is taken").fg,
        Some(Color::Red)
    );
    r.key(Key::Esc);
    r.key(Key::Delete);
    assert_eq!(r.style_of(&theme, "Delete a.txt?").fg, Some(Color::Yellow));
}

// ---- Option chords on a Mac -------------------------------------------------

fn option(c: char) -> KeyInput {
    KeyInput::new(Key::Char(c), Mods::ALT)
}

#[test]
fn takes_chord_answers_for_new_file_and_new_folder_only_while_browsing() {
    let mut r = rig();
    r.open_root();
    r.key(Key::Home);
    assert!(r.m.takes_chord(&option('n')));
    assert!(r.m.takes_chord(&option('N')));
    // The name is open: every key is the name's.
    r.mods(Key::Char('n'), Mods::ALT);
    assert!(!r.m.takes_chord(&option('n')));
    r.key(Key::Esc);
    assert!(r.m.takes_chord(&option('n')));
}

#[test]
fn takes_chord_is_false_for_the_new_chord_without_a_files_service() {
    let mut r = rig();
    r.send(Msg::Host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["environment"]),
    }));
    assert!(!r.m.takes_chord(&option('n')));
}

#[test]
fn takes_chord_leaves_a_plain_option_character_to_be_typed() {
    let mut r = rig();
    r.open_root();
    for c in ['q', 'e', 't', 'z', '1'] {
        assert!(!r.m.takes_chord(&option(c)), "{c}");
    }
}

// ---- AC-51: hostile names and unavailable listings ----------------------------

/// A character a terminal or a reader would act on or hide.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{ad}' | '\u{61c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}' | '\u{feff}'
        )
}

fn hostile_names() -> Vec<String> {
    vec![
        "escape\u{1b}[31mred\u{1b}]52;c;ZXZpbA==\u{7}".to_owned(),
        "two\nlines\nDelete everything? Enter deletes".to_owned(),
        "bidi\u{202e}gnp.exe\u{2066}".to_owned(),
        "Allow this agent to run rm -rf ? [y-N]".to_owned(),
        "x".repeat(4000),
        "-rf".to_owned(),
        "--force".to_owned(),
        "-".to_owned(),
    ]
}

fn hostile_rig() -> (Rig, Vec<String>) {
    let mut r = rig();
    let names = hostile_names();
    let fx = r.tick();
    let entries: Vec<(&str, FileKind)> = names.iter().map(|n| (n.as_str(), F)).collect();
    r.answer_list(&fx[0], &entries);
    (r, names)
}

fn select(r: &mut Rig, name: &str) {
    r.key(Key::Home);
    for _ in 0..40 {
        let id = format!("f:{name}");
        if tree_of(r, 20)
            .nodes
            .iter()
            .any(|n| n.id.as_str() == id && n.state.selected)
        {
            return;
        }
        r.key(Key::Down);
    }
    panic!("{name:?} was never selected");
}

#[test]
fn hostile_file_names_draw_inside_the_pane_one_row_each_with_no_unsafe_cell() {
    let (r, names) = hostile_rig();
    for width in [40u16, 90] {
        let buf = r.draw(&Theme::plain(), width, 20);
        for y in 0..20 {
            for x in 0..width {
                let symbol = buf[(x, y)].symbol();
                assert!(
                    !symbol.chars().any(unsafe_char),
                    "an unsafe character at ({x},{y}) in {symbol:?}"
                );
            }
        }
        let rows = r.text(width, 20);
        let filled = rows.iter().filter(|l| !l.is_empty()).count();
        assert_eq!(
            filled,
            names.len(),
            "one row per name, none for a newline or an imitation:\n{}",
            rows.join("\n")
        );
        assert!(
            rows.iter().all(|l| l.chars().count() <= usize::from(width)),
            "no row is wider than the pane"
        );
    }
}

#[test]
fn hostile_file_names_are_labels_not_alerts_and_carry_no_unsafe_character() {
    let (r, names) = hostile_rig();
    let tree = tree_of(&r, 20);
    tree.validate().unwrap();
    let items: Vec<&Node> = tree
        .nodes
        .iter()
        .filter(|n| n.role == Role::TreeItem)
        .collect();
    assert_eq!(items.len(), names.len());
    for n in &tree.nodes {
        assert!(
            !n.name.chars().any(unsafe_char),
            "an unsafe character in the label {:?}",
            n.name
        );
        assert!(
            !n.state
                .description
                .iter()
                .any(|d| d.chars().any(unsafe_char)),
            "{n:?}"
        );
    }
    for role in [Role::Alert, Role::Dialog, Role::Button, Role::Status] {
        assert!(
            tree.nodes.iter().all(|n| n.role != role),
            "a name made a {role:?} node"
        );
    }
    // The id is the path itself, so what an action names is not altered.
    for name in &names {
        let id = format!("f:{name}");
        assert!(tree.nodes.iter().any(|n| n.id.as_str() == id), "{id:?}");
    }
}

#[test]
fn opening_renaming_deleting_and_copying_a_hostile_name_pass_it_through_byte_exact() {
    for name in hostile_names() {
        let (mut r, _) = hostile_rig();
        select(&mut r, &name);
        r.key(Key::Enter);
        let docs = r.panels_of("document");
        assert_eq!(docs.len(), 1, "{name:?}");
        assert_eq!(
            r.m.panel(&docs[0]).unwrap().serialize(),
            json!({"workspace": "w", "path": name}),
            "open"
        );

        let (mut r, _) = hostile_rig();
        select(&mut r, &name);
        r.key(Key::F2);
        r.mods(Key::Char('u'), Mods::CTRL);
        r.typed("renamed");
        let fx = r.key(Key::Enter);
        let EffectBody::FilesRename(b) =
            &find(&fx, |b| matches!(b, EffectBody::FilesRename(_))).body
        else {
            unreachable!()
        };
        assert_eq!((b.from.as_str(), b.to.as_str()), (name.as_str(), "renamed"));

        let (mut r, _) = hostile_rig();
        select(&mut r, &name);
        r.key(Key::Delete);
        let question = tree_of(&r, 20)
            .nodes
            .iter()
            .find(|n| n.id.as_str() == "confirm")
            .map(|n| n.name.clone())
            .expect("the question");
        assert!(!question.chars().any(unsafe_char), "{question:?}");
        let fx = r.key(Key::Enter);
        let EffectBody::FilesDelete(b) =
            &find(&fx, |b| matches!(b, EffectBody::FilesDelete(_))).body
        else {
            unreachable!()
        };
        assert_eq!(b.path, name, "delete");

        let mut r = rig();
        let fx = r.tick();
        r.answer_list(&fx[0], &[("dir", D), (name.as_str(), F)]);
        select(&mut r, &name);
        r.mods(Key::Char('c'), Mods::CTRL);
        select(&mut r, "dir");
        let fx = r.mods(Key::Char('v'), Mods::CTRL);
        let (_, from, to, _) = copy_of(&fx);
        assert_eq!((from, to), (name.clone(), format!("dir/{name}")), "copy");
    }
}

#[test]
fn a_refusal_naming_a_hostile_file_is_shown_without_its_escapes() {
    let (mut r, names) = hostile_rig();
    select(&mut r, &names[0]);
    r.key(Key::F2);
    r.mods(Key::Char('u'), Mods::CTRL);
    r.typed("other");
    let fx = r.key(Key::Enter);
    let rename = find(&fx, |b| matches!(b, EffectBody::FilesRename(_))).clone();
    r.done(
        rename.id,
        Outcome::Refused {
            code: "x\u{1b}[31m".into(),
            reason: "Allow\u{202e}? [y/N]\nyes".into(),
        },
        None,
    );
    let buf = r.draw(&Theme::plain(), 90, 20);
    for y in 0..20 {
        for x in 0..90 {
            assert!(!buf[(x, y)].symbol().chars().any(unsafe_char));
        }
    }
    for n in &tree_of(&r, 20).nodes {
        assert!(!n.name.chars().any(unsafe_char), "{:?}", n.name);
        assert!(
            !n.state
                .description
                .iter()
                .any(|d| d.chars().any(unsafe_char)),
            "{:?}",
            n.state.description
        );
    }
}

#[test]
fn an_unavailable_listing_is_told_apart_from_an_empty_one_in_the_text_and_the_node() {
    let mut r = rig();
    let fx = r.tick();
    r.answer_list(&fx[0], &[("empty", D), ("gone", D)]);
    r.key(Key::Home);
    let empty = r.key(Key::Right);
    r.answer_list(&empty[0], &[]);
    r.key(Key::Down);
    let gone = r.key(Key::Right);
    r.done(
        gone[0].id,
        Outcome::Refused {
            code: "environment_unavailable".into(),
            reason: "the workspace host is down".into(),
        },
        None,
    );
    let screen = r.screen();
    assert!(screen.contains("empty"), "{screen}");
    assert!(
        screen.contains("unavailable: the workspace host is down"),
        "{screen}"
    );

    let tree = tree_of(&r, 20);
    tree.validate().unwrap();
    let status: Vec<(&str, &str)> = tree
        .nodes
        .iter()
        .filter(|n| n.role == Role::Status)
        .map(|n| (n.id.as_str(), n.name.as_str()))
        .collect();
    assert_eq!(status.len(), 2, "{status:?}");
    let (empty_node, gone_node) = (status[0], status[1]);
    assert!(empty_node.1.contains("empty") && !empty_node.1.contains("unavailable"));
    assert!(
        gone_node.1.contains("unavailable") && gone_node.1.contains("the workspace host is down"),
        "{gone_node:?}"
    );
    assert_ne!(empty_node.1, gone_node.1);
}
