//! The Threads panel driven through a real root: keys, completions and host messages go in as
//! `Msg`, effects, cells and the semantic tree come out. A stand-in Theo and a stand-in terminal
//! pane are registered so both directions of the switch can be seen.

use std::cell::RefCell;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use serde_json::{Value, json};
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ActionId, Actor, PanelInstanceId, PanelKind, ResourceKind};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::{
    BodyKind, Capabilities, CellSize, PanelDescriptor, Placement,
};
use theorem_workbench_core::semantics::{Node, Role, SemanticTree};
use theorem_workbench_core::threads::{ThreadCreated, ThreadTag};
use theorem_workbench_core::{
    Ctx, Icon, Model, Msg, OpenTarget, Panel, PanelFactories, PanelMsg, PlacedIcon, Theme, ViewCtx,
    take_icons, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use theorem_workbench_panels::register;

const BASE: [&str; 6] = [
    "threads",
    "environment",
    "conversation",
    "terminal",
    "terminal.native",
    "terminal.herdr",
];
const FULL: [&str; 12] = [
    "threads.create",
    "threads.rename",
    "threads.archive",
    "threads.delete",
    "threads.markdown",
    "threads.pin",
    "threads.tags",
    "threads.unread",
    "threads.retitle",
    "terminal.admit",
    "files",
    "documents",
];

thread_local! {
    /// The conversations the stand-in Theo was asked to switch to.
    static SWITCHED: RefCell<Vec<(String, String)>> = const { RefCell::new(vec![]) };
}

struct Theo;

impl Panel for Theo {
    fn update(&mut self, msg: PanelMsg, _cx: &mut Ctx) {
        if let PanelMsg::Switch { project, thread } = msg {
            SWITCHED.with(|s| s.borrow_mut().push((project, thread)));
        }
    }
    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}
    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![Node::new("theo", Role::Region, "Theo", area)]
    }
    fn serialize(&self) -> Value {
        json!({})
    }
}

struct Shell(String);

impl Panel for Shell {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}
    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}
    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        vec![Node::new("shell", Role::Region, &self.0, area)]
    }
    fn serialize(&self) -> Value {
        json!({"session": self.0})
    }
}

struct Rig {
    m: Model,
}

fn model(caps: &[&'static str]) -> Model {
    let mut factories = PanelFactories::new();
    register(&mut factories);
    factories.register("theo", |_, _| Box::new(Theo));
    factories.register("shell", |state, _| {
        Box::new(Shell(state["session"].as_str().unwrap_or("").to_owned()))
    });
    factories.register_opener("shell", |t| matches!(t, OpenTarget::Terminal { .. }));
    factories.register("delegation", |state, _| {
        Box::new(Shell(
            state["delegationId"].as_str().unwrap_or("").to_owned(),
        ))
    });
    factories.register_opener("delegation", |t| matches!(t, OpenTarget::Delegation { .. }));
    let mut registry = builtin::registry();
    // The delegation kind lives in the Changes crate, which depends on this
    // one, so the rig registers a stand-in entry for it.
    registry
        .register(PanelDescriptor {
            kind: PanelKind::new("delegation"),
            version: 1,
            title: "Delegation changes".to_owned(),
            icon: "git-branch".to_owned(),
            body: BodyKind::Drawn,
            binding: ResourceKind::Delegation,
            actions: vec![],
            requires: vec![],
            min_size: CellSize { cols: 24, rows: 6 },
            default_placement: Placement::Tools,
            theme_roles: vec![],
            semantic_role: Role::Region,
        })
        .expect("the stand-in registers");
    let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
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

fn caps(extra: &[&str]) -> Vec<&'static str> {
    let mut all: Vec<&'static str> = BASE.to_vec();
    all.extend(
        FULL.iter()
            .copied()
            .filter(|c| extra.is_empty() || extra.contains(c)),
    );
    all
}

fn action(m: &mut Model, id: &str) {
    update(
        m,
        Msg::Action {
            id: ActionId::new(id),
            actor: Actor::Human,
        },
    );
}

/// A hostile title: a bidi override, a bell and a ZWJ family.
const HOSTILE: &str =
    "Plan \u{202E}txt.exe\u{202C} bell\u{7} \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

fn listing() -> Value {
    let t = |id: &str, title: &str, projects: Vec<&str>, ms: i64, extra: Value| {
        let mut v = json!({
            "id": id, "title": title, "projectIds": projects,
            "lastMessageMs": ms, "createdMs": ms - 1000, "delegations": [],
        });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    let now = 1_800_000_000_000_i64;
    json!({
        "projects": [
            {"id": "pa", "name": "Atlas"},
            {"id": "ph", "name": "Harbor"},
        ],
        "threads": [
            t("t-pin", "Pinned one", vec!["pa"], now - 7_200_000, json!({"pinned": true})),
            t("t-parent", "Parent thread", vec!["pa"], now - 300_000, json!({
                "delegations": [{"id": "d1", "label": "Reviewer", "runId": "r1"}]
            })),
            t("t-kid", "Child thread", vec!["pa"], now - 1_800_000, json!({"origin": "t-parent"})),
            t("t-run", "Running thread", vec!["pa"], now - 60_000, json!({"running": true})),
            t("t-need", "Needs you thread", vec!["ph"], now - 900_000, json!({"needsYou": "Approve"})),
            t("t-unread", "Unread thread", vec!["ph"], now - 5_400_000, json!({"unread": true})),
            t("t-old", "Archived thread", vec!["ph"], now - 9_000_000, json!({"archived": true})),
            t("t-bad", HOSTILE, vec!["ph"], now - 12_000_000, json!({})),
        ],
        "open": {"projectId": "pa", "threadId": "t-parent"},
        "asOfMs": now,
    })
}

fn sessions() -> Value {
    let s = |id: &str,
             name: Option<&str>,
             host: &str,
             cwd: &str,
             admitted: bool,
             word: Option<&str>| {
        let mut v = json!({
            "session": id, "profile": "zsh", "backend": "herdr", "workspace": "w",
            "host": host, "cwd": cwd, "program": 1, "state": "running",
            "admitted": admitted,
        });
        if let Some(n) = name {
            v["name"] = json!(n);
        }
        if let Some(w) = word {
            v["programReport"] = json!({"kind": "current", "status": {"state": w}, "seq": 1});
        }
        v
    };
    json!([
        s(
            "h-work",
            Some("build"),
            "studio",
            "/work/atlas/server",
            true,
            Some("working")
        ),
        s(
            "h-block",
            Some("review"),
            "studio",
            "/work/harbor/docs",
            true,
            Some("blocked")
        ),
        s(
            "h-agent",
            Some("agent"),
            "laptop",
            "/work/lantern/app",
            false,
            None
        ),
        s("h-shell", None, "laptop", "/home/guest", false, None),
    ])
}

impl Rig {
    fn new(extra: &[&str]) -> Self {
        SWITCHED.with(|s| s.borrow_mut().clear());
        let mut m = model(&caps(extra));
        action(&mut m, "theo.focus");
        action(&mut m, "threads.focus");
        let mut r = Rig { m };
        r.host(json!({"type": "threadsChanged", "listing": listing()}));
        r.host(json!({
            "type": "terminalSessions", "workspace": "w", "profiles": [],
            "sessions": sessions(), "adoption": {"state": "settled"},
        }));
        r
    }

    fn host(&mut self, message: Value) {
        let message: HostMessage = serde_json::from_value(message).expect("a host message");
        update(&mut self.m, Msg::Host(message));
    }

    fn key(&mut self, key: Key) -> Vec<Effect> {
        self.mods(key, Mods::NONE)
    }

    fn mods(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
        update(&mut self.m, Msg::Key(KeyInput::new(key, mods)))
    }

    fn typed(&mut self, text: &str) {
        for c in text.chars() {
            self.key(Key::Char(c));
        }
    }

    fn tree(&self) -> SemanticTree {
        theorem_workbench_core::semantics(&self.m)
    }

    /// The panel's nodes, their ids as the panel names them (the root prefixes the panel's own id).
    fn nodes(&self) -> Vec<Node> {
        let prefix = format!("{}/", self.id("threads").unwrap().as_str());
        self.tree()
            .nodes
            .into_iter()
            .filter_map(|mut n| {
                let own = n.id.as_str().strip_prefix(&prefix)?.to_owned();
                n.id = theorem_workbench_core::semantics::NodeId::new(&own);
                Some(n)
            })
            .collect()
    }

    fn selected(&self) -> Option<Node> {
        self.nodes()
            .into_iter()
            .find(|n| n.role == Role::TreeItem && n.state.selected)
    }

    fn node(&self, id: &str) -> Option<Node> {
        self.nodes().into_iter().find(|n| n.id.as_str() == id)
    }

    /// Moves the cursor to the row with node id `id` by the keys a person would press.
    fn select(&mut self, id: &str) {
        self.key(Key::Home);
        for _ in 0..60 {
            if self.selected().is_some_and(|n| n.id.as_str() == id) {
                return;
            }
            self.key(Key::Down);
        }
        panic!(
            "{id} is not reachable; rows: {:?}",
            self.nodes()
                .iter()
                .map(|n| n.id.as_str().to_owned())
                .collect::<Vec<_>>()
        );
    }

    fn done(&mut self, effect: &Effect, outcome: Outcome, payload: Option<CompletionPayload>) {
        let mut c = Completion::new(effect.id, effect.resource.clone(), outcome);
        c.payload = payload;
        update(&mut self.m, Msg::Completion(c));
    }

    fn id(&self, kind: &str) -> Option<PanelInstanceId> {
        self.m
            .panel_ids()
            .find(|(_, k)| k.as_str() == kind)
            .map(|(i, _)| i.clone())
    }

    /// The panel drawn in `theme`, with or without the keyboard.
    fn cells(&self, theme: &Theme, focused: bool, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let mut cx = ViewCtx::new(theme, self.m.workspace());
        cx.focused = focused;
        let id = self.id("threads").unwrap();
        self.m.panel(&id).unwrap().view(area, &mut buf, &cx);
        take_icons(&mut buf);
        buf
    }

    /// The icons the panel draws, as the frame's pass collects them.
    fn icons(&self, width: u16, height: u16) -> Vec<PlacedIcon> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let mut cx = ViewCtx::new(&theme, self.m.workspace());
        cx.focused = true;
        let id = self.id("threads").unwrap();
        self.m.panel(&id).unwrap().view(area, &mut buf, &cx);
        take_icons(&mut buf)
    }

    /// The icon on the row whose text holds `needle`, and the column its name starts at.
    fn icon_of(&self, needle: &str) -> Option<(Icon, u16)> {
        let lines = self.text(60, 40);
        let icons = self.icons(60, 40);
        lines.iter().enumerate().find_map(|(y, line)| {
            let at = line.find(needle)? as u16;
            let icon = icons.iter().find(|i| usize::from(i.y) == y)?;
            assert!(icon.x + 2 <= at, "{icon:?} before {needle} at {at}");
            Some((icon.icon, icon.x))
        })
    }

    fn text(&self, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let cx = ViewCtx::new(&theme, self.m.workspace());
        let id = self.id("threads").unwrap();
        self.m.panel(&id).unwrap().view(area, &mut buf, &cx);
        take_icons(&mut buf);
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
}

fn kinds(fx: &[Effect]) -> Vec<&'static str> {
    fx.iter()
        .map(|e| match &e.body {
            EffectBody::ThreadsList => "list",
            EffectBody::ThreadsCreate(_) => "create",
            EffectBody::ThreadsRename(_) => "rename",
            EffectBody::ThreadsArchive(_) => "archive",
            EffectBody::ThreadsDelete(_) => "delete",
            EffectBody::ThreadsPin(_) => "pin",
            EffectBody::ThreadsTag(_) => "tag",
            EffectBody::ThreadsUnread(_) => "unread",
            EffectBody::ThreadsRetitle(_) => "retitle",
            EffectBody::ThreadsMarkdown(_) => "markdown",
            EffectBody::ClipboardWrite(_) => "clipboard",
            EffectBody::TerminalAdmit(_) => "admit",
            _ => "other",
        })
        .collect()
}

const PARENT: &str = "r:t:pa:t-parent";
const KID: &str = "r:t:pa:t-kid";
/// A thread with no state of its own: not pinned, not unread, not archived.
const PLAIN: &str = "r:t:pa:t-run";

#[test]
fn the_panel_lists_pinned_projects_and_herdr_with_the_open_thread_selected() {
    let r = Rig::new(&[]);
    r.tree().validate().expect("one valid tree");
    let nodes = r.nodes();
    let headings: Vec<_> = nodes
        .iter()
        .filter(|n| n.role == Role::Heading)
        .map(|n| n.name.clone())
        .collect();
    assert_eq!(headings, vec!["Pinned", "Projects", "Herdr"]);
    for name in [
        "Atlas",
        "Harbor",
        "Pinned one",
        "Parent thread",
        "Needs you thread",
    ] {
        assert!(nodes.iter().any(|n| n.name == name), "{name}");
    }
    // The pinned thread is not also under its project, and the open thread is selected.
    assert!(r.node("r:pin:t-pin").is_some());
    assert!(r.node("r:t:pa:t-pin").is_none());
    assert_eq!(r.selected().unwrap().id.as_str(), PARENT);
}

#[test]
fn a_list_that_arrives_before_the_pane_has_a_height_still_starts_at_its_top() {
    SWITCHED.with(|s| s.borrow_mut().clear());
    let mut m = model(&caps(&[]));
    action(&mut m, "theo.focus");
    action(&mut m, "threads.focus");
    // No room at all, as before the first layout: the list and the open thread arrive now.
    update(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 2),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    let mut r = Rig { m };
    r.host(json!({"type": "threadsChanged", "listing": listing()}));
    update(
        &mut r.m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    let headings: Vec<_> = r
        .nodes()
        .iter()
        .filter(|n| n.role == Role::Heading)
        .map(|n| n.name.clone())
        .collect();
    assert_eq!(headings.first().map(String::as_str), Some("Pinned"));
    assert_eq!(r.selected().unwrap().id.as_str(), PARENT);
}

#[test]
fn a_thread_with_children_shows_a_chevron_and_opens_to_its_children_and_delegations() {
    let mut r = Rig::new(&[]);
    assert_eq!(r.node(PARENT).unwrap().state.expanded, Some(false));
    assert!(r.node(KID).is_none());
    r.select(PARENT);
    r.key(Key::Right);
    assert_eq!(r.node(PARENT).unwrap().state.expanded, Some(true));
    let kid = r.node(KID).expect("the child");
    assert_eq!(kid.level, Some(3));
    let delegation = r.node("r:d:pa:t-parent:d1").expect("the delegation");
    assert_eq!(delegation.name, "Reviewer");
    r.select(KID);
    r.key(Key::Left);
    assert_eq!(r.selected().unwrap().id.as_str(), PARENT);
}

#[test]
fn a_drop_down_is_a_folder_open_or_closed_and_what_is_under_it_is_a_file() {
    let mut r = Rig::new(&[]);
    // Closed: the project is open (its threads show), the parent thread has rows under it and is
    // closed, a thread with nothing under it is a file; headings that do not collapse have none.
    assert_eq!(r.icon_of("Atlas").map(|i| i.0), Some(Icon::FolderFile));
    assert_eq!(
        r.icon_of("Parent thread").map(|i| i.0),
        Some(Icon::FolderEmpty)
    );
    assert_eq!(
        r.icon_of("Running thread").map(|i| i.0),
        Some(Icon::FileText)
    );
    assert_eq!(r.icon_of("Pinned one").map(|i| i.0), Some(Icon::FileText));
    let lines = r.text(60, 40);
    for heading in ["Pinned", "Projects", "Herdr"] {
        let y = lines.iter().position(|l| l.trim() == heading).unwrap() as u16;
        assert!(
            r.icons(60, 40).iter().all(|i| i.y != y),
            "{heading} has no icon"
        );
    }
    // Opened: the same row is the open folder, and what is under it is a file under its name.
    r.select(PARENT);
    r.key(Key::Right);
    assert_eq!(
        r.icon_of("Parent thread").map(|i| i.0),
        Some(Icon::FolderFile)
    );
    let (kid, kid_x) = r.icon_of("Child thread").unwrap();
    assert_eq!(kid, Icon::FileText);
    let (delegation, delegation_x) = r.icon_of("Reviewer").unwrap();
    assert_eq!(delegation, Icon::FileText);
    let (parent, parent_x) = r.icon_of("Parent thread").unwrap();
    assert_eq!(parent, Icon::FolderFile);
    // What is under a folder is drawn one level in from it.
    assert!(kid_x > parent_x, "{kid_x} under {parent_x}");
    assert_eq!(delegation_x, kid_x);
    // Collapsing it is the closed folder again.
    r.key(Key::Left);
    assert_eq!(
        r.icon_of("Parent thread").map(|i| i.0),
        Some(Icon::FolderEmpty)
    );
}

#[test]
fn herdr_machines_are_folders_and_sessions_are_files_and_no_chevron_is_drawn() {
    let r = Rig::new(&[]);
    assert_eq!(r.icon_of("studio").map(|i| i.0), Some(Icon::FolderFile));
    assert_eq!(r.icon_of("build").map(|i| i.0), Some(Icon::FileText));
    // A session not yet in the workbench is the file with a plus.
    assert_eq!(r.icon_of("agent").map(|i| i.0), Some(Icon::FileAdd));
    for line in r.text(60, 40) {
        let row = line.trim_start();
        assert!(
            !row.starts_with("> ") && !row.starts_with("v ") && !row.starts_with("+ "),
            "{line:?}"
        );
    }
}

#[test]
fn a_row_shows_what_state_it_is_in() {
    let r = Rig::new(&[]);
    let screen = r.text(60, 24).join("\n");
    assert!(screen.contains("Approve"), "{screen}");
    assert!(screen.contains("5m") || screen.contains("now"), "{screen}");
    // A pinned row shows its project on a second line.
    assert!(screen.contains("Atlas"), "{screen}");
    let need = r.node("r:t:ph:t-need").unwrap();
    assert!(need.state.description.unwrap().contains("Approve"));
    assert!(r.node("r:t:pa:t-run").unwrap().state.busy);
}

#[test]
fn archived_threads_are_hidden_until_the_toggle() {
    let mut r = Rig::new(&[]);
    assert!(r.node("r:t:ph:t-old").is_none());
    action(&mut r.m, "threads.archived");
    assert!(r.node("r:t:ph:t-old").is_some());
    action(&mut r.m, "threads.archived");
    assert!(r.node("r:t:ph:t-old").is_none());
}

#[test]
fn enter_on_a_thread_goes_back_to_theo_and_asks_it_to_switch() {
    let mut r = Rig::new(&[]);
    r.select("r:t:ph:t-unread");
    r.key(Key::Enter);
    assert_eq!(
        SWITCHED.with(|s| s.borrow().clone()),
        vec![("ph".to_owned(), "t-unread".to_owned())]
    );
    assert_eq!(r.m.focus().panel, r.id("theo"));
}

#[test]
fn rename_by_key_sends_one_update_and_escape_sends_none() {
    let mut r = Rig::new(&[]);
    r.select(PLAIN);
    r.key(Key::F2);
    assert!(r.node("edit").is_some());
    r.key(Key::Esc);
    assert!(r.node("edit").is_none());
    r.key(Key::F2);
    r.mods(Key::Char('a'), Mods::CTRL);
    r.typed("Renamed");
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), vec!["rename"]);
    let EffectBody::ThreadsRename(body) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(
        (body.thread_id.as_str(), body.title.as_str()),
        ("t-run", "Renamed")
    );
}

#[test]
fn delete_asks_first_and_escape_keeps_the_thread() {
    let mut r = Rig::new(&[]);
    r.select(PLAIN);
    let fx = r.key(Key::Delete);
    assert!(fx.is_empty());
    assert!(r.node("confirm").is_some());
    assert!(r.key(Key::Esc).is_empty());
    assert!(r.node("confirm").is_none());
    assert!(r.node(PLAIN).is_some());
    r.key(Key::Delete);
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), vec!["delete"]);
}

#[test]
fn archive_pin_unread_tag_and_retitle_each_send_their_own_effect() {
    let mut r = Rig::new(&[]);
    r.select(PLAIN);
    let mut sent = vec![];
    for (id, kind) in [
        ("threads.archive", "archive"),
        ("threads.pin", "pin"),
        ("threads.unread", "unread"),
        ("threads.retitle", "retitle"),
    ] {
        let fx = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new(id),
                actor: Actor::Human,
            },
        );
        assert_eq!(kinds(&fx), vec![kind], "{id}");
        sent.push(fx);
    }
    // Tags are picked from a menu: the first colour, then Enter.
    action(&mut r.m, "threads.tag");
    let fx = r.key(Key::Enter);
    let EffectBody::ThreadsTag(body) = &fx[0].body else {
        panic!("{fx:?}")
    };
    assert_eq!(body.tag, Some(ThreadTag::Red));
}

/// The listing again, one millisecond newer, after `change` has edited its threads.
fn relisted(change: impl FnOnce(&mut Vec<Value>)) -> Value {
    let mut l = listing();
    l["asOfMs"] = json!(l["asOfMs"].as_i64().unwrap() + 1);
    change(l["threads"].as_array_mut().unwrap());
    json!({"type": "threadsChanged", "listing": l})
}

#[test]
fn the_cursor_follows_a_thread_into_pinned_and_back_to_its_project() {
    let mut r = Rig::new(&[]);
    r.select(PLAIN);
    r.host(relisted(|threads| {
        let t = threads.iter_mut().find(|t| t["id"] == "t-run").unwrap();
        t["pinned"] = json!(true);
    }));
    assert_eq!(r.selected().unwrap().id.as_str(), "r:pin:t-run");
    let mut l = relisted(|_| {});
    l["listing"]["asOfMs"] = json!(l["listing"]["asOfMs"].as_i64().unwrap() + 1);
    r.host(l);
    assert_eq!(r.selected().unwrap().id.as_str(), PLAIN);
}

#[test]
fn a_cursor_whose_thread_is_gone_moves_to_the_row_that_took_its_place() {
    let mut r = Rig::new(&[]);
    r.select("r:t:ph:t-need");
    r.host(relisted(|threads| threads.retain(|t| t["id"] != "t-need")));
    assert_eq!(r.selected().unwrap().id.as_str(), "r:t:ph:t-unread");
}

#[test]
fn copy_title_writes_the_exact_title_to_the_clipboard() {
    let mut r = Rig::new(&[]);
    r.select("r:t:ph:t-bad");
    let fx = r.mods(Key::Char('c'), Mods::CTRL);
    let EffectBody::ClipboardWrite(w) = &fx[0].body else {
        panic!("{fx:?}")
    };
    assert_eq!(w.text, HOSTILE);
}

#[test]
fn a_hostile_title_is_spelled_out_on_the_grid_and_the_node() {
    let mut r = Rig::new(&[]);
    r.select("r:t:ph:t-bad");
    let node = r.selected().unwrap();
    // A joined emoji family is one grapheme the grid keeps whole; the override and the bell are spelled out.
    for bad in ['\u{202E}', '\u{7}'] {
        assert!(!node.name.contains(bad), "{:?}", node.name);
        assert!(!r.text(60, 24).join("").contains(bad));
    }
}

#[test]
fn the_row_menu_lists_only_what_the_host_grants() {
    let mut r = Rig::new(&["threads.rename", "threads.archive", "threads.markdown"]);
    r.select(PLAIN);
    r.key(Key::Menu);
    let items: Vec<String> = r
        .nodes()
        .iter()
        .filter(|n| n.role == Role::MenuItem)
        .map(|n| n.name.clone())
        .collect();
    assert!(items.contains(&"Rename".to_owned()), "{items:?}");
    assert!(items.contains(&"Archive".to_owned()));
    for absent in [
        "Delete",
        "Pin",
        "Tag...",
        "Mark as unread",
        "Regenerate title",
    ] {
        assert!(!items.contains(&absent.to_owned()), "{absent} in {items:?}");
    }
    // The key of a withheld action says nothing and sends nothing.
    r.key(Key::Esc);
    assert!(r.key(Key::Delete).is_empty());
    assert!(r.node("confirm").is_none());
}

#[test]
fn an_open_menu_covers_the_rows_under_it_whole() {
    let mut r = Rig::new(&[]);
    r.select(PLAIN);
    r.key(Key::Menu);
    let items: Vec<String> = r
        .nodes()
        .iter()
        .filter(|n| n.role == Role::MenuItem)
        .map(|n| n.name.clone())
        .collect();
    assert!(items.len() > 3, "{items:?}");
    // The menu is its widest label and four cells wide, one cell in. Inside that box each row
    // reads as its own words alone: nothing of the row it covers shows beside them.
    let wide = items.iter().map(|i| i.chars().count()).max().unwrap() + 4;
    let drawn: Vec<String> = r
        .text(200, 50)
        .iter()
        .map(|line| line.chars().skip(1).take(wide).collect::<String>())
        .collect();
    for item in &items {
        assert!(
            drawn.iter().any(|line| line.trim() == item.as_str()),
            "{item:?} is not alone in its box in {drawn:#?}"
        );
    }
}

#[test]
fn alt_n_makes_a_thread_in_the_focused_project_and_opens_it() {
    let mut r = Rig::new(&[]);
    r.select("r:t:ph:t-need");
    let fx = r.mods(Key::Char('n'), Mods::ALT);
    assert_eq!(kinds(&fx), vec!["create"]);
    let EffectBody::ThreadsCreate(body) = &fx[0].body else {
        unreachable!()
    };
    assert_eq!(body.project_id, "ph");
    r.done(
        &fx[0],
        Outcome::Accepted,
        Some(CompletionPayload::ThreadCreated(ThreadCreated {
            project_id: "ph".into(),
            thread_id: "t-new".into(),
        })),
    );
    assert_eq!(
        SWITCHED.with(|s| s.borrow().clone()),
        vec![("ph".to_owned(), "t-new".to_owned())]
    );
}

#[test]
fn herdr_lists_sessions_by_machine_with_the_programs_own_word() {
    let r = Rig::new(&[]);
    let groups: Vec<_> = r
        .nodes()
        .iter()
        .filter(|n| n.role == Role::Group)
        .map(|n| n.name.clone())
        .collect();
    assert_eq!(groups, vec!["laptop", "studio"]);
    let build = r.node("r:s:h-work").unwrap();
    let said = build.state.description.unwrap();
    assert!(
        said.contains("working") && said.contains("atlas/server"),
        "{said}"
    );
    assert!(
        r.node("r:s:h-block")
            .unwrap()
            .state
            .description
            .unwrap()
            .contains("blocked")
    );
    // A program that has said nothing is not given a word.
    let agent = r.node("r:s:h-agent").unwrap().state.description.unwrap();
    assert!(agent.contains("not in this workspace yet"), "{agent}");
    assert!(!agent.contains("working") && !agent.contains("idle"));
}

#[test]
fn enter_on_an_admitted_session_opens_a_terminal_tab_and_a_thread_goes_back_to_theo() {
    let mut r = Rig::new(&[]);
    r.select("r:s:h-work");
    r.key(Key::Enter);
    let shell = r.id("shell").expect("a terminal tab opened");
    assert_eq!(r.m.focus().panel, Some(shell));
    // Picking a thread goes back to Theo.
    action(&mut r.m, "threads.focus");
    r.select("r:t:ph:t-need");
    r.key(Key::Enter);
    assert_eq!(r.m.focus().panel, r.id("theo"));
}

#[test]
fn enter_on_a_delegation_opens_what_it_changed_and_leaves_the_conversation_alone() {
    let mut r = Rig::new(&[]);
    SWITCHED.with(|s| s.borrow_mut().clear());
    r.select(PARENT);
    r.key(Key::Right);
    r.select("r:d:pa:t-parent:d1");
    r.key(Key::Enter);
    let panel = r.id("delegation").expect("the delegation's changes opened");
    assert_eq!(r.m.focus().panel, Some(panel));
    // The stand-in is named by the delegation it was opened for.
    assert!(
        r.tree().nodes.iter().any(|n| n.name == "d1"),
        "opened for d1"
    );
    assert!(SWITCHED.with(|s| s.borrow().is_empty()));
}

#[test]
fn a_session_not_in_the_workspace_is_admitted_first_and_then_opens() {
    let mut r = Rig::new(&[]);
    r.select("r:s:h-agent");
    let fx = r.key(Key::Enter);
    assert_eq!(kinds(&fx), vec!["admit"]);
    assert!(
        r.id("shell").is_none(),
        "nothing opens before the host accepts"
    );
    r.done(&fx[0], Outcome::Accepted, None);
    let mut rows = sessions();
    rows[2]["admitted"] = json!(true);
    r.host(json!({
        "type": "terminalSessions", "workspace": "w", "profiles": [],
        "sessions": rows, "adoption": {"state": "settled"},
    }));
    assert!(
        r.id("shell").is_some(),
        "the row is an ordinary session and opens"
    );
    assert!(
        !r.node("r:s:h-agent")
            .unwrap()
            .state
            .description
            .unwrap_or_default()
            .contains("not in this workspace")
    );
}

#[test]
fn without_terminal_admit_the_row_offers_no_admission() {
    let mut r = Rig::new(&["threads.rename"]);
    r.select("r:s:h-agent");
    assert!(kinds(&r.key(Key::Enter)).is_empty());
    r.key(Key::Menu);
    assert!(
        !r.nodes()
            .iter()
            .any(|n| n.role == Role::MenuItem && n.name.starts_with("Admit"))
    );
}

#[test]
fn the_first_update_asks_for_the_list_when_the_host_has_none_to_say() {
    SWITCHED.with(|s| s.borrow_mut().clear());
    let mut m = model(&caps(&[]));
    action(&mut m, "threads.focus");
    let fx = update(&mut m, Msg::Tick);
    assert!(kinds(&fx).contains(&"list"), "{fx:?}");
}

#[test]
fn the_cursor_row_is_in_the_mark_colour_while_the_panel_has_focus_and_bright_bold_when_it_loses_it()
{
    const MARK: Color = Color::Rgb(0xe2, 0x81, 0x3f);
    const BRIGHT: Color = Color::Rgb(0xe4, 0xea, 0xee);
    let theme = Theme {
        bg: Style::default().bg(Color::Blue),
        text: Style::default().fg(Color::White),
        focus: Style::default().fg(MARK).add_modifier(Modifier::BOLD),
        selected: Style::default().fg(BRIGHT).add_modifier(Modifier::BOLD),
        ..Theme::plain()
    };
    let r = Rig::new(&[]);
    let rows = |buf: &Buffer, fg: Color| -> Vec<u16> {
        (0..40)
            .filter(|y| (0..60).any(|x| buf[(x, *y)].fg == fg))
            .collect()
    };
    let focused = r.cells(&theme, true, 60, 40);
    let at = rows(&focused, MARK);
    assert_eq!(at.len(), 1, "one accent row: {:?}", r.text(60, 40));
    let y = at[0];
    let x = (0..60).find(|x| focused[(*x, y)].fg == MARK).unwrap();
    assert!(focused[(x, y)].modifier.contains(Modifier::BOLD));
    assert_eq!(
        focused[(x, y)].bg,
        Color::Blue,
        "no band behind the letters"
    );
    let row: String = (0..60)
        .map(|x| focused[(x, y)].symbol().to_owned())
        .collect();
    assert!(row.contains("Parent thread"), "the open thread: {row}");

    let idle = r.cells(&theme, false, 60, 40);
    assert!(rows(&idle, MARK).is_empty(), "no accent without focus");
    assert_eq!(rows(&idle, BRIGHT), vec![y], "the same row, bright");
    assert!(idle[(x, y)].modifier.contains(Modifier::BOLD));
    assert_eq!(idle[(x, y)].bg, Color::Blue);
}
