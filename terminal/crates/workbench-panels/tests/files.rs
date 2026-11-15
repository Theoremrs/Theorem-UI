//! The Files panel driven through a real root: keys, pointer, completions and
//! host messages go in as `Msg`, effects and cells come out.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, FileEntry, FileKind, FileListing, Outcome,
};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::{ConnectionState, HostMessage};
use theorem_workbench_core::ids::{ActionId, Actor, EffectId, PanelInstanceId, ResourceRef};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::semantics::{NodeId, Role, SemanticTree};
use theorem_workbench_core::stale::Stale;
use theorem_workbench_core::{
    Button, Model, Msg, PanelFactories, Pointer, PointerKind, Theme, ViewCtx, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use theorem_workbench_panels::{FilesHandle, OpenRequest, register};

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

struct Rig {
    m: Model,
    handle: FilesHandle,
    id: PanelInstanceId,
}

fn model(handle_workspace: &str) -> (Model, FilesHandle) {
    let mut factories = PanelFactories::new();
    let handle = register(&mut factories);
    handle.set_workspace(handle_workspace);
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
    (m, handle)
}

fn rig() -> Rig {
    let (mut m, handle) = model("w");
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        },
    );
    let id = m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "files")
        .map(|(id, _)| id.clone())
        .expect("a files panel is open");
    Rig { m, handle, id }
}

fn ws() -> ResourceRef {
    ResourceRef::Workspace {
        workspace: "w".into(),
    }
}

fn listing(entries: &[(&str, FileKind)]) -> CompletionPayload {
    CompletionPayload::Files(FileListing {
        entries: entries
            .iter()
            .map(|(name, kind)| FileEntry {
                name: (*name).into(),
                kind: *kind,
            })
            .collect(),
        partial: false,
    })
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

    fn text(&self, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let cx = ViewCtx {
            theme: &theme,
            focused: true,
            picker: None,
        };
        self.m.panel(&self.id).unwrap().view(area, &mut buf, &cx);
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
        let area = Rect::new(0, 0, 40, 20);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let cx = ViewCtx {
            theme: &theme,
            focused: true,
            picker: None,
        };
        self.m.panel(&self.id).unwrap().view(area, &mut buf, &cx);
        (0..20).find_map(|y| {
            buf[(0, y)]
                .modifier
                .contains(ratatui::style::Modifier::REVERSED)
                .then(|| self.text(40, 20)[usize::from(y)].clone())
        })
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

    fn click(&mut self, x: u16, y: u16) -> Vec<Effect> {
        let b = self.body();
        let mut fx = vec![];
        for kind in [
            PointerKind::Down(Button::Left),
            PointerKind::Up(Button::Left),
        ] {
            fx.extend(self.send(Msg::Pointer(Pointer {
                kind,
                x: b.x + x,
                y: b.y + y,
                mods: Mods::NONE,
            })));
        }
        fx
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

// ---- lazy loading (R08, AC-08) -----------------------------------------

#[test]
fn opening_and_focusing_start_nothing_and_the_first_tick_lists_the_root() {
    let (mut m, _h) = model("w");
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
            entries: vec![FileEntry {
                name: "a".into(),
                kind: F,
            }],
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
    r.handle.set_workspace("w2");
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
    r.handle.set_workspace("w2");
    r.handle.set_workspace("w");
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
    let (mut m, _h) = model("");
    update(
        &mut m,
        Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        },
    );
    assert!(update(&mut m, Msg::Tick).is_empty());
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
fn enter_on_a_file_makes_an_open_request_and_on_a_directory_toggles() {
    let mut r = rig();
    r.open_root();
    r.typed("a.t");
    r.key(Key::Enter);
    assert_eq!(
        r.handle.take_opens(),
        vec![OpenRequest {
            workspace: "w".into(),
            path: "a.txt".into()
        }]
    );
    assert!(r.handle.take_opens().is_empty());
    r.key(Key::Home);
    let fx = r.key(Key::Enter);
    assert_eq!(paths(&fx), vec!["docs"]);
    assert!(r.handle.take_opens().is_empty());
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
fn cut_and_paste_moves_and_copy_says_it_is_not_offered() {
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

    r.typed("rea");
    r.mods(Key::Char('c'), Mods::CTRL);
    r.key(Key::Home);
    let fx = r.mods(Key::Char('v'), Mods::CTRL);
    assert!(
        fx.iter()
            .all(|e| !matches!(e.body, EffectBody::FilesRename(_)))
    );
    assert!(r.screen().contains("copy_unavailable"));
}

// ---- pointer ----------------------------------------------------------------

#[test]
fn click_selects_the_disclosure_toggles_double_click_opens_and_the_wheel_scrolls() {
    let mut r = rig();
    r.open_root();
    r.click(6, 4);
    assert!(r.selected_line().unwrap().contains("README.md"));
    r.click(6, 4);
    assert_eq!(r.handle.take_opens().len(), 1, "double click opens");

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
    }));
    assert_eq!(r.text(40, 20)[0], "  f05", "scrolled five rows");
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

    let (mut m2, _h2) = model("w");
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
    let (mut m, _h) = model("w");
    m.restore(serde_json::from_str(&text).unwrap())
        .expect("restores");
    let fx = update(&mut m, Msg::Tick);
    assert_eq!(paths(&fx), vec![""]);
}

// ---- semantics and cells ------------------------------------------------------------

fn tree_of(r: &Rig, height: u16) -> SemanticTree {
    let area = Rect::new(0, 0, 40, height);
    let theme = Theme::plain();
    let cx = ViewCtx {
        theme: &theme,
        focused: true,
        picker: None,
    };
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
        docs.state.description.as_deref(),
        Some("level 1, 1 of 5; folder")
    );
    let x = tree.node(&NodeId::new("f:docs/x.rs")).unwrap();
    assert!(x.state.selected && x.state.focused);
    assert_eq!(x.state.description.as_deref(), Some("level 2, 1 of 1"));
    let src = tree.node(&NodeId::new("f:src")).unwrap();
    assert_eq!(src.state.expanded, Some(false));
    assert_eq!(
        tree.node(&NodeId::new("f:link"))
            .unwrap()
            .state
            .description
            .as_deref(),
        Some("level 1, 4 of 5; symlink")
    );
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
