//! The Markdown panel driven through a real root, as the Files panel does: the
//! panel is opened by the Files panel, keys go in as `Msg`, the owner's answers
//! go in as completions and host messages, and effects, cells and semantic
//! nodes come out.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::OpenTarget;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, DocumentConflicted, DocumentCurrent, DocumentEdited,
    DocumentOpened, DocumentSaved, FileEntry, FileKind, FileListing, Outcome, PendingEdit,
    PendingState,
};
use theorem_workbench_core::effect::{
    CoordinateUnit, Effect, EffectBody, EffectKind, TextChange as CoreChange,
};
use theorem_workbench_core::host::{HostMessage, TokenSpan};
use theorem_workbench_core::ids::{ActionId, Actor, PanelInstanceId, ResourceRef, Revision};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::panel::Composition;
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::results::SpanEncoding;
use theorem_workbench_core::semantics::NodeId;
use theorem_workbench_core::{
    DockMsg, Model, Msg, PanelFactories, Theme, ViewCtx, semantics, update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset, Role};
use theorem_workbench_markdown::MarkdownStyles;
use theorem_workbench_markdown_panel::{
    Drafts, MarkdownPanelStyles, extend_registry, register_with,
};
use unicode_width::UnicodeWidthStr;

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

const PATH: &str = "a.md";

fn ws() -> ResourceRef {
    ResourceRef::Workspace {
        workspace: "w".into(),
    }
}

fn doc_of(path: &str) -> ResourceRef {
    ResourceRef::Document {
        workspace: "w".into(),
        resource_id: path.into(),
    }
}

fn doc() -> ResourceRef {
    doc_of(PATH)
}

fn seq(n: u64) -> Revision {
    Revision::Seq(n)
}

struct Rig {
    m: Model,
    id: PanelInstanceId,
    kind: String,
    open: Option<Effect>,
}

fn model(caps: &[&'static str], drafts: &Drafts, width: u16) -> Model {
    let mut factories = PanelFactories::new();
    theorem_workbench_panels::register(&mut factories);
    // The first kind that claims a target opens it: Markdown goes ahead of the
    // plain editor, which claims every file.
    register_with(&mut factories, drafts.clone());
    theorem_workbench_editor::register(&mut factories);
    let mut registry = builtin::registry();
    theorem_workbench_editor::extend_registry(&mut registry).expect("editor actions");
    extend_registry(&mut registry).expect("the Markdown actions register beside the editor's");
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
            area: Rect::new(0, 0, width, 50),
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

fn of_kind(effects: &[Effect], kind: EffectKind) -> Vec<&Effect> {
    effects.iter().filter(|e| e.kind() == kind).collect()
}

fn edits(fx: &[Effect]) -> Vec<Effect> {
    of_kind(fx, EffectKind::DocumentEdit)
        .into_iter()
        .cloned()
        .collect()
}

fn the_edit(fx: &[Effect]) -> Effect {
    let mut all = edits(fx);
    assert_eq!(all.len(), 1, "one edit expected in {fx:#?}");
    all.remove(0)
}

fn one(fx: &[Effect], kind: EffectKind) -> Effect {
    let all = of_kind(fx, kind);
    assert_eq!(all.len(), 1, "one {kind:?} expected in {fx:#?}");
    all[0].clone()
}

fn none_of(fx: &[Effect], kind: EffectKind) {
    assert!(
        of_kind(fx, kind).is_empty(),
        "no {kind:?} expected in {fx:#?}"
    );
}

fn changes(e: &Effect) -> Vec<(u32, u32, String)> {
    let EffectBody::DocumentEdit(edit) = &e.body else {
        panic!("not an edit: {e:?}");
    };
    edit.edits
        .iter()
        .map(|c| (c.start, c.end, c.insert.clone()))
        .collect()
}

fn op_id(e: &Effect) -> String {
    let EffectBody::DocumentEdit(edit) = &e.body else {
        panic!("not an edit: {e:?}");
    };
    edit.operation_id.clone()
}

/// `text` with the edit's changes applied, counted in UTF-16 units as the
/// owner counts them.
fn applied(text: &str, e: &Effect) -> String {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    let mut all = changes(e);
    all.sort_by_key(|c| std::cmp::Reverse(c.0));
    for (start, end, insert) in all {
        units.splice(
            start as usize..end as usize,
            insert.encode_utf16().collect::<Vec<_>>(),
        );
    }
    String::from_utf16(&units).expect("valid text")
}

fn utf16_at(text: &str, needle: &str) -> u32 {
    let byte = text.find(needle).expect("the needle is in the text");
    text[..byte].encode_utf16().count() as u32
}

impl Rig {
    fn start() -> Self {
        Self::start_file(PATH, &Drafts::new(), 500)
    }

    /// The Files panel opens `path`; the panel the root chose asks the owner.
    fn start_file(path: &str, drafts: &Drafts, width: u16) -> Self {
        let mut m = model(&CAPS, drafts, width);
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("files.focus"),
                actor: Actor::Human,
            },
        );
        let fx = update(&mut m, Msg::Tick);
        let list = of_kind(&fx, EffectKind::FilesList)[0].id;
        let mut c = Completion::new(list, ws(), Outcome::Accepted);
        c.payload = Some(CompletionPayload::Files(FileListing {
            entries: vec![
                FileEntry::new("a.md", FileKind::File),
                FileEntry::new("b.txt", FileKind::File),
                FileEntry::new("c.MDX", FileKind::File),
                FileEntry::new("notes.md", FileKind::File),
            ],
            partial: false,
        }));
        update(&mut m, Msg::Completion(c));
        for ch in path.chars() {
            update(&mut m, Msg::Key(KeyInput::new(Key::Char(ch), Mods::NONE)));
        }
        update(&mut m, Msg::Key(KeyInput::new(Key::Enter, Mods::NONE)));
        let (id, kind) = m
            .panel_ids()
            .find(|(_, k)| matches!(k.as_str(), "markdown" | "document"))
            .map(|(id, k)| (id.clone(), k.as_str().to_owned()))
            .expect("the Files panel opened a panel");
        let mut rig = Self {
            m,
            id,
            kind,
            open: None,
        };
        let fx = rig.tick();
        rig.open = of_kind(&fx, EffectKind::DocumentOpen)
            .first()
            .map(|e| (*e).clone());
        rig
    }

    fn opened(text: &str) -> Self {
        let mut rig = Self::start();
        rig.answer_open(text, 1);
        rig
    }

    /// Opened and switched to Source, where the text is typed.
    fn source(text: &str) -> Self {
        let mut rig = Self::opened(text);
        rig.alt('2');
        rig
    }

    fn answer_open(&mut self, text: &str, revision: u64) -> Vec<Effect> {
        let open = self.open.take().expect("an open is waiting");
        let c = Completion::new(open.id, open.resource.clone(), Outcome::Accepted).with_payload(
            CompletionPayload::DocumentOpened(DocumentOpened {
                text: text.into(),
                revision: seq(revision),
                saved_revision: None,
                dirty: false,
                read_only: None,
            }),
        );
        self.send(Msg::Completion(c))
    }

    fn send(&mut self, msg: Msg) -> Vec<Effect> {
        update(&mut self.m, msg)
    }

    fn tick(&mut self) -> Vec<Effect> {
        self.send(Msg::Tick)
    }

    fn key(&mut self, key: Key) -> Vec<Effect> {
        self.mods(key, Mods::NONE)
    }

    fn mods(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
        self.send(Msg::Key(KeyInput::new(key, mods)))
    }

    fn alt(&mut self, c: char) -> Vec<Effect> {
        self.mods(Key::Char(c), Mods::ALT)
    }

    fn typed(&mut self, text: &str) -> Vec<Effect> {
        let mut out = vec![];
        for c in text.chars() {
            out.extend(match c {
                '\n' => self.key(Key::Enter),
                c => self.key(Key::Char(c)),
            });
        }
        out
    }

    fn answer(
        &mut self,
        effect: &Effect,
        outcome: Outcome,
        payload: Option<CompletionPayload>,
    ) -> Vec<Effect> {
        let mut c = Completion::new(effect.id, effect.resource.clone(), outcome);
        c.payload = payload;
        self.send(Msg::Completion(c))
    }

    fn accept(&mut self, effect: &Effect, revision: u64) -> Vec<Effect> {
        let EffectBody::DocumentEdit(e) = &effect.body else {
            panic!("not an edit: {effect:?}");
        };
        let payload = CompletionPayload::DocumentEdited(DocumentEdited {
            operation_id: e.operation_id.clone(),
            revision: seq(revision),
        });
        self.answer(effect, Outcome::Accepted, Some(payload))
    }

    fn host(&mut self, message: HostMessage) -> Vec<Effect> {
        self.send(Msg::Host(message))
    }

    fn act(&mut self, id: &str) -> Vec<Effect> {
        self.send(Msg::Action {
            id: ActionId::new(id),
            actor: Actor::Human,
        })
    }

    fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the panel's group")
            .body
    }

    fn draw(&self, width: u16, height: u16) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        let theme = Theme::plain();
        let mut cx = ViewCtx::new(&theme, self.m.workspace());
        cx.focused = true;
        self.m.panel(&self.id).unwrap().view(area, &mut buf, &cx);
        buf
    }

    fn rows(&self, width: u16, height: u16) -> Vec<String> {
        let buf = self.draw(width, height);
        (0..height)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < width {
                    let symbol = buf[(x, y)].symbol();
                    row.push_str(symbol);
                    x += (symbol.width() as u16).max(1);
                }
                row.trim_end().to_owned()
            })
            .collect()
    }

    fn screen(&self) -> String {
        let b = self.body();
        self.rows(b.width, b.height).join("\n")
    }

    /// The status line is the last row of the body.
    fn status(&self) -> String {
        let b = self.body();
        self.rows(b.width, b.height).pop().unwrap()
    }

    /// The text rows of Source mode without the line numbers.
    fn text(&self) -> String {
        let b = self.body();
        let rows = self.rows(b.width, b.height);
        let mut lines: Vec<String> = rows[1..rows.len() - 1]
            .iter()
            .map(|r| {
                r.trim_start_matches(|c: char| c.is_ascii_digit())
                    .trim_start()
                    .to_owned()
            })
            .collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }

    fn node(&self, local: &str) -> theorem_workbench_core::semantics::Node {
        let tree = semantics(&self.m);
        tree.node(&NodeId::new(format!("{}/{local}", self.id.as_str())))
            .unwrap_or_else(|| panic!("no node {local}"))
            .clone()
    }

    fn has_node(&self, local: &str) -> bool {
        semantics(&self.m)
            .node(&NodeId::new(format!("{}/{local}", self.id.as_str())))
            .is_some()
    }

    fn binding(&self) -> theorem_workbench_core::stale::Binding {
        self.m.panel(&self.id).unwrap().binding().unwrap()
    }

    fn state(&self) -> serde_json::Value {
        self.m
            .panel(&self.id)
            .map(|p| p.serialize())
            .unwrap_or_default()
    }

    fn tree_ok(&self) {
        semantics(&self.m)
            .validate()
            .expect("the semantic tree is valid");
    }

    fn mode(&self) -> String {
        self.state()["mode"].as_str().unwrap_or("").to_lowercase()
    }
}

fn remote_insert(revision: u64, at: u32, text: &str) -> HostMessage {
    HostMessage::DocumentChanged {
        resource: doc(),
        revision: seq(revision),
        actor: "other".into(),
        operation_id: None,
        unit: CoordinateUnit::Utf16,
        edits: vec![CoreChange {
            start: at,
            end: at,
            insert: text.into(),
        }],
    }
}

fn remote_replace(revision: u64, start: u32, end: u32, text: &str) -> HostMessage {
    HostMessage::DocumentChanged {
        resource: doc(),
        revision: seq(revision),
        actor: "other".into(),
        operation_id: None,
        unit: CoordinateUnit::Utf16,
        edits: vec![CoreChange {
            start,
            end,
            insert: text.into(),
        }],
    }
}

/// Both sides change the same word of the heading: mine types after "# ",
/// theirs replaces "Head" from the same place.
fn collide(rig: &mut Rig) {
    rig.mods(Key::Down, Mods::ALT);
    rig.mods(Key::Down, Mods::ALT);
    rig.key(Key::Home);
    rig.key(Key::Right);
    rig.key(Key::Right);
    rig.typed("MINE");
    let at = utf16_at(MIXED, "# Head") + 2;
    rig.host(remote_replace(2, at, at + 4, "THEIRS"));
}

/// The owner's text after the collision's remote change.
fn owner_after_collision() -> String {
    let at = utf16_at(MIXED, "# Head") + 2;
    let mut units: Vec<u16> = MIXED.encode_utf16().collect();
    units.splice(at as usize..at as usize + 4, "THEIRS".encode_utf16());
    String::from_utf16(&units).unwrap()
}

// ---- 1: the opener --------------------------------------------------------

#[test]
fn markdown_files_open_in_the_markdown_panel_ahead_of_the_plain_editor() {
    for path in ["a.md", "c.MDX"] {
        let rig = Rig::start_file(path, &Drafts::new(), 200);
        assert_eq!(rig.kind, "markdown", "{path}");
        assert!(rig.open.is_some(), "the panel asked the owner for {path}");
    }
    let rig = Rig::start_file("b.txt", &Drafts::new(), 200);
    assert_eq!(rig.kind, "document", "a plain file is the editor's");
}

#[test]
fn the_markdown_panel_asks_for_the_document_and_shows_it_in_visual_mode() {
    let mut rig = Rig::start();
    let open = rig.open.clone().expect("an open");
    assert_eq!(open.resource, doc());
    assert!(rig.screen().contains("Opening"), "{}", rig.screen());
    rig.tree_ok();
    rig.answer_open("# Title\n\nSome *words*.\n", 1);
    assert_eq!(rig.mode(), "visual");
    assert!(rig.screen().contains("Title"), "{}", rig.screen());
    assert!(rig.status().contains("a.md"), "{}", rig.status());
}

// ---- 2: one session in four modes -----------------------------------------

#[test]
fn switching_modes_keeps_the_selection_the_undo_history_and_the_pending_edit() {
    let mut rig = Rig::source("alpha\n\nbeta\n\ngamma\n");
    // An edit the owner has not answered, then a selection after it.
    let e = the_edit(&rig.typed("Z"));
    rig.key(Key::Right);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.mods(Key::Right, Mods::SHIFT);
    let before = rig.state();
    for mode in ['4', '1', '3', '2'] {
        rig.alt(mode);
    }
    assert_eq!(rig.mode(), "source");
    let after = rig.state();
    assert_eq!(
        before["view"]["selection"], after["view"]["selection"],
        "the selection is the same after a tour of the modes"
    );
    // The edit in flight is still the one in flight: nothing is sent twice.
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    rig.accept(&e, 2);
    assert!(rig.status().contains("modified"), "{}", rig.status());
    // Undo goes through the whole tour: the typed Z is undone from Source.
    let fx = rig.mods(Key::Char('z'), Mods::CTRL);
    assert!(rig.text().starts_with("alpha"), "{}", rig.text());
    let undo = the_edit(&fx);
    assert_eq!(changes(&undo)[0].2, "", "undo is an edit like any other");
}

#[test]
fn the_preview_is_derived_from_the_local_draft_not_from_the_owner() {
    let mut rig = Rig::source("# One\n");
    rig.key(Key::End);
    rig.typed(" two");
    rig.alt('4');
    let screen = rig.screen();
    assert!(screen.contains("One two"), "{screen}");
    // Nothing was accepted; the draft is what is shown.
    assert!(rig.status().contains("modified"));
}

#[test]
fn the_scroll_anchor_is_kept_across_modes() {
    let text: String = (0..60).map(|i| format!("Paragraph {i}\n\n")).collect();
    let mut rig = Rig::opened(&text);
    rig.alt('4');
    for _ in 0..4 {
        rig.key(Key::PageDown);
    }
    let anchor = rig.state()["view"]["anchor"].clone();
    assert_ne!(anchor["block"], 0, "the preview scrolled: {anchor}");
    rig.alt('2');
    rig.alt('4');
    assert_eq!(rig.state()["view"]["anchor"], anchor);
}

// ---- 3: block editing -------------------------------------------------------

const MIXED: &str = "---\ntitle: x\n---\n\n<!-- a comment -->\n\n# Head   \n\nPara one  \nstill one\n\n```rust\nfn  main( ) {}\n```\n\n<div>raw</div>\n\n[^1]: note\n\ntrailing   \n";

#[test]
fn opening_a_block_edits_its_source_and_writes_back_only_that_block() {
    let mut rig = Rig::opened(MIXED);
    // Down to the heading: the front matter and the comment come first.
    rig.mods(Key::Down, Mods::ALT);
    rig.mods(Key::Down, Mods::ALT);
    assert!(
        rig.node("block").name.contains("heading 1"),
        "{}",
        rig.node("block").name
    );
    assert!(
        rig.node("block")
            .state
            .description
            .unwrap()
            .contains("open for editing")
    );
    rig.key(Key::End);
    rig.typed("!");
    let fx = rig.key(Key::Esc);
    let e = the_edit(&fx);
    assert_eq!(e.revision, Some(seq(1)));
    let heading = utf16_at(MIXED, "# Head");
    let (start, end, _) = changes(&e)[0].clone();
    assert!(
        start >= heading && end <= heading + 9,
        "the edit stays inside the heading: {:?}",
        changes(&e)
    );
    let now = applied(MIXED, &e);
    assert_eq!(
        now.replacen("Head   !", "Head   ", 1),
        MIXED,
        "everything but the typed character is byte for byte what it was"
    );
}

#[test]
fn a_block_that_was_not_changed_sends_nothing() {
    let mut rig = Rig::opened(MIXED);
    rig.mods(Key::Down, Mods::ALT);
    let fx = rig.key(Key::Esc);
    none_of(&fx, EffectKind::DocumentEdit);
    assert!(!rig.status().contains("modified"), "{}", rig.status());
}

#[test]
fn front_matter_comments_html_footnotes_and_fences_open_as_their_own_source() {
    let mut rig = Rig::opened(MIXED);
    let mut names = vec![];
    for _ in 0..8 {
        names.push(rig.node("block").name);
        rig.mods(Key::Down, Mods::ALT);
    }
    let all = names.join("\n");
    for kind in [
        "front matter",
        "HTML",
        "heading 1",
        "paragraph",
        "fenced code",
        "footnote",
    ] {
        assert!(all.contains(kind), "{kind} in\n{all}");
    }
    assert!(all.contains("source fallback"), "{all}");
    // Editing a fence writes back the fence and nothing around it.
    let mut rig = Rig::opened(MIXED);
    for _ in 0..4 {
        rig.mods(Key::Down, Mods::ALT);
    }
    assert!(
        rig.node("block").name.contains("fenced code"),
        "{}",
        rig.node("block").name
    );
    rig.mods(Key::Down, Mods::NONE);
    rig.key(Key::End);
    rig.typed("//");
    let e = the_edit(&rig.key(Key::Esc));
    assert_eq!(applied(MIXED, &e).replacen("//", "", 1), MIXED);
}

// ---- 4: a block held under a change ----------------------------------------

#[test]
fn a_block_edit_is_never_lost_when_the_source_changed_under_it() {
    let mut rig = Rig::opened(MIXED);
    collide(&mut rig);
    let screen = rig.screen();
    assert!(screen.contains("Both changed this block"), "{screen}");
    assert!(screen.contains("MINE"), "{screen}");
    assert!(
        screen.contains("THEIRS"),
        "both revisions are shown: {screen}"
    );
    for button in ["[Keep my text", "[Take their text", "[Keep both"] {
        assert!(screen.contains(button), "{button} in\n{screen}");
    }
    assert!(rig.node("conflict").name.contains("MINE"));
    rig.tree_ok();
    // Closing the block, switching mode and time do not choose.
    for fx in [rig.key(Key::Esc), rig.alt('2'), rig.tick()] {
        none_of(&fx, EffectKind::DocumentEdit);
    }
    assert!(rig.screen().contains("[Keep my text"), "{}", rig.screen());
    // Keep mine: my block replaces theirs and goes to the owner.
    let fx = rig.act("markdown.resolve.keepMine");
    let e = the_edit(&fx);
    assert!(applied(&owner_after_collision(), &e).contains("MINE"));
    assert!(!rig.screen().contains("[Keep my text"));
}

#[test]
fn taking_theirs_keeps_my_text_to_copy_and_keep_both_adds_it_as_its_own_block() {
    let mut rig = Rig::opened(MIXED);
    collide(&mut rig);
    let fx = rig.act("markdown.resolve.takeTheirs");
    none_of(&fx, EffectKind::DocumentEdit);
    assert!(
        rig.screen().contains("Your text is kept"),
        "{}",
        rig.screen()
    );
    let clip = one(
        &rig.act("markdown.resolve.copyMine"),
        EffectKind::ClipboardWrite,
    );
    let EffectBody::ClipboardWrite(w) = &clip.body else {
        unreachable!()
    };
    assert!(w.text.contains("MINE"), "{}", w.text);

    let mut rig = Rig::opened(MIXED);
    collide(&mut rig);
    let e = the_edit(&rig.act("markdown.resolve.keepBoth"));
    let after = applied(&owner_after_collision(), &e);
    assert!(
        after.contains("THEIRS") && after.contains("MINE"),
        "{after}"
    );
}

/// `text` as the owner has it after a remote insert of `insert` at `at`.
fn applied_base(text: &str, _len: usize, insert: &str, at: u32) -> String {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.splice(at as usize..at as usize, insert.encode_utf16());
    String::from_utf16(&units).unwrap()
}

#[test]
fn a_change_elsewhere_is_merged_under_the_open_block_without_a_conflict() {
    let mut rig = Rig::opened(MIXED);
    rig.mods(Key::Down, Mods::ALT);
    rig.mods(Key::Down, Mods::ALT);
    rig.key(Key::End);
    rig.typed("!");
    rig.host(remote_insert(2, utf16_at(MIXED, "trailing"), "far "));
    assert!(!rig.screen().contains("Both changed"), "{}", rig.screen());
    let e = the_edit(&rig.key(Key::Esc));
    assert_eq!(e.revision, Some(seq(2)), "written on top of their revision");
    let owner = applied_base(MIXED, 0, "far ", utf16_at(MIXED, "trailing"));
    assert_eq!(
        applied(&owner, &e).replacen("Head   !", "Head   ", 1),
        owner
    );
}

// ---- 5: the owner's answers ---------------------------------------------------

#[test]
fn edits_leave_one_at_a_time_in_order_with_the_base_revision_and_an_operation_id() {
    let mut rig = Rig::source("hello\n");
    let first = the_edit(&rig.key(Key::Char('a')));
    assert_eq!(first.revision, Some(seq(1)));
    assert_eq!(changes(&first), vec![(0, 0, "a".to_owned())]);
    let EffectBody::DocumentEdit(body) = &first.body else {
        unreachable!()
    };
    assert_eq!(body.unit, CoordinateUnit::Utf16);
    assert!(rig.status().contains("sending"), "{}", rig.status());
    none_of(&rig.key(Key::Char('b')), EffectKind::DocumentEdit);
    let next = the_edit(&rig.accept(&first, 2));
    assert_eq!(next.revision, Some(seq(2)));
    assert_eq!(changes(&next), vec![(1, 1, "b".to_owned())]);
    assert_ne!(op_id(&first), op_id(&next));
    none_of(&rig.accept(&next, 3), EffectKind::DocumentEdit);
    assert_eq!(rig.binding().revision, Some(seq(3)));
}

#[test]
fn a_refused_edit_keeps_the_text_shows_the_reason_and_is_not_sent_again_by_itself() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    let fx = rig.answer(
        &e,
        Outcome::Refused {
            code: "invalid".into(),
            reason: "that edit is not allowed here".into(),
        },
        None,
    );
    none_of(&fx, EffectKind::DocumentEdit);
    let screen = rig.screen();
    assert!(screen.contains("that edit is not allowed here"), "{screen}");
    assert!(screen.contains("[Keep my text Alt+M]"), "{screen}");
    assert!(rig.text().starts_with("Xhello"), "{}", rig.text());
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    none_of(&rig.key(Key::Char('Y')), EffectKind::DocumentEdit);
    rig.tree_ok();
    // Keeping mine is the person's choice and sends it under a new id.
    let again = the_edit(&rig.alt('m'));
    assert_ne!(op_id(&again), op_id(&e));
}

#[test]
fn a_failed_edit_is_shown_and_not_retried() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    let fx = rig.answer(
        &e,
        Outcome::Failed {
            reason: "the owner broke".into(),
        },
        None,
    );
    none_of(&fx, EffectKind::DocumentEdit);
    assert!(rig.screen().contains("the owner broke"), "{}", rig.screen());
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    assert!(rig.text().starts_with("Xhello"));
}

#[test]
fn an_uncertain_edit_is_unknown_blocks_what_follows_and_is_sent_again_only_when_asked() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Uncertain {
            reason: "no answer in time".into(),
        },
        None,
    );
    assert!(rig.status().contains("edit unknown"), "{}", rig.status());
    assert!(rig.screen().contains("Unknown whether"), "{}", rig.screen());
    none_of(&rig.key(Key::Char('Y')), EffectKind::DocumentEdit);
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    let again = the_edit(&rig.alt('r'));
    assert_eq!(op_id(&again), op_id(&e), "the same operation id");
    assert_eq!(changes(&again), vec![(0, 0, "X".to_owned())]);
}

#[test]
fn a_remote_change_is_rebased_under_an_edit_in_flight() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.host(remote_insert(2, 5, "!"));
    assert_eq!(rig.text(), "Xhello!");
    rig.accept(&e, 3);
    assert_eq!(rig.text(), "Xhello!");
    assert_eq!(rig.binding().revision, Some(seq(3)));
}

fn conflict_payload(e: &Effect, current: &str, revision: u64) -> CompletionPayload {
    CompletionPayload::DocumentConflicted(DocumentConflicted {
        operation_id: op_id(e),
        base_revision: seq(1),
        current: DocumentCurrent {
            revision: seq(revision),
            text: current.into(),
        },
        pending: vec![PendingEdit {
            operation_id: op_id(e),
            base_revision: seq(1),
            edits: vec![CoreChange {
                start: 0,
                end: 0,
                insert: "X".into(),
            }],
            state: PendingState::Conflicted,
            reason: None,
        }],
    })
}

#[test]
fn an_owner_conflict_shows_both_sides_and_is_resolved_only_by_a_choice() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "conflict".into(),
            reason: "the document moved on".into(),
        },
        Some(conflict_payload(&e, "hello!\n", 2)),
    );
    let screen = rig.screen();
    assert!(screen.contains("Mine: \"X\""), "{screen}");
    assert!(screen.contains("Theirs: \"!\""), "{screen}");
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    assert!(
        rig.node("conflict")
            .actions
            .iter()
            .any(|a| a.id.as_str() == "markdown.resolve.keepMine")
    );
    rig.tree_ok();
    let fx = rig.alt('m');
    let again = the_edit(&fx);
    assert_eq!(again.revision, Some(seq(2)));
    one(&fx, EffectKind::DocumentSettle);
}

// ---- 6: save, modified, disk, read-only ----------------------------------------

#[test]
fn saving_sends_the_accepted_revision_and_clears_modified_when_the_owner_says_so() {
    let mut rig = Rig::source("hello\n");
    let nothing = rig.mods(Key::Char('s'), Mods::CTRL);
    none_of(&nothing, EffectKind::DocumentSave);
    assert!(rig.status().contains("nothing to save"), "{}", rig.status());
    let e = the_edit(&rig.key(Key::Char('X')));
    let wait = rig.mods(Key::Char('s'), Mods::CTRL);
    none_of(&wait, EffectKind::DocumentSave);
    assert!(rig.status().contains("save waits"), "{}", rig.status());
    let fx = rig.accept(&e, 2);
    let save = one(&fx, EffectKind::DocumentSave);
    assert_eq!(save.revision, Some(seq(2)));
    assert!(rig.m.panel(&rig.id).unwrap().tab_label().unwrap().modified);
    rig.answer(
        &save,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentSaved(DocumentSaved {
            revision: seq(2),
        })),
    );
    assert!(!rig.status().contains("modified"), "{}", rig.status());
    let label = rig.m.panel(&rig.id).unwrap().tab_label().unwrap();
    assert_eq!((label.title.as_str(), label.modified), ("a.md", false));
}

#[test]
fn a_refused_or_uncertain_save_keeps_the_modified_mark_and_says_which() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    let save = one(
        &rig.mods(Key::Char('s'), Mods::CTRL),
        EffectKind::DocumentSave,
    );
    rig.answer(
        &save,
        Outcome::Refused {
            code: "disk_full".into(),
            reason: "the disk is full".into(),
        },
        None,
    );
    assert!(rig.status().contains("modified"));
    assert!(
        rig.status().contains("the disk is full"),
        "{}",
        rig.status()
    );
    let save = one(
        &rig.mods(Key::Char('s'), Mods::CTRL),
        EffectKind::DocumentSave,
    );
    rig.answer(
        &save,
        Outcome::Uncertain {
            reason: "no answer".into(),
        },
        None,
    );
    assert!(rig.status().contains("save unknown"), "{}", rig.status());
    assert!(rig.status().contains("modified"));
    one(
        &rig.mods(Key::Char('s'), Mods::CTRL),
        EffectKind::DocumentSave,
    );
}

#[test]
fn a_file_changed_on_disk_offers_both_ways_and_reconciles_through_the_owner() {
    let mut rig = Rig::source("hello\n");
    rig.host(HostMessage::DocumentConflict {
        resource: doc(),
        revision: seq(2),
        disk_deleted: false,
    });
    assert!(
        rig.screen().contains("The file changed on disk"),
        "{}",
        rig.screen()
    );
    let rec = one(&rig.alt('d'), EffectKind::DocumentReconcile);
    rig.answer(
        &rec,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentReconciled(
            theorem_workbench_core::completion::DocumentReconciled {
                revision: seq(3),
                text: "from disk\n".into(),
            },
        )),
    );
    assert_eq!(rig.text(), "from disk");
    assert!(!rig.screen().contains("changed on disk"));
}

#[test]
fn a_document_the_owner_opened_read_only_takes_no_edits_and_says_why() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentOpened(DocumentOpened {
            text: "hello\n".into(),
            revision: seq(1),
            saved_revision: None,
            dirty: false,
            read_only: Some(theorem_workbench_core::completion::ReadOnly {
                reason: "a generated file".into(),
            }),
        })),
    );
    rig.alt('2');
    none_of(&rig.typed("x"), EffectKind::DocumentEdit);
    assert_eq!(rig.text(), "hello");
    assert!(
        rig.screen().contains("a generated file"),
        "{}",
        rig.screen()
    );
    // The block cannot be opened for editing either.
    rig.alt('1');
    rig.key(Key::Enter);
    assert!(
        !rig.node("block")
            .state
            .description
            .unwrap_or_default()
            .contains("open for editing")
    );
}

// ---- 7: split --------------------------------------------------------------

#[test]
fn split_shows_source_and_preview_side_by_side_and_keeps_scroll_in_step_by_block() {
    let text: String = (0..40)
        .map(|i| format!("# Heading {i}\n\nBody {i}\n\n"))
        .collect();
    let mut rig = Rig::opened(&text);
    rig.alt('3');
    let screen = rig.screen();
    assert!(screen.contains('\u{2502}'), "a divider: {screen}");
    assert!(screen.contains("# Heading 0"), "{screen}");
    assert!(screen.contains("Heading 0"), "{screen}");
    for _ in 0..3 {
        rig.key(Key::PageDown);
    }
    let anchor = rig.state()["view"]["anchor"]["block"].as_u64().unwrap();
    assert!(anchor > 0, "scrolled");
    let screen = rig.screen();
    let first_source = screen
        .lines()
        .nth(1)
        .unwrap()
        .split('\u{2502}')
        .next()
        .unwrap()
        .to_owned();
    assert!(
        first_source.contains(&format!("Heading {}", anchor / 2))
            || first_source.contains(&format!("Body {}", anchor / 2)),
        "the source pane is at the preview's block {anchor}: {first_source}\n{screen}"
    );
}

#[test]
fn split_below_its_minimum_width_falls_back_to_the_source_and_says_so() {
    let mut rig = Rig::start_file(PATH, &Drafts::new(), 50);
    rig.answer_open("# Title\n\nText\n", 1);
    assert!(rig.body().width < 60, "{:?}", rig.body());
    rig.alt('3');
    assert_eq!(rig.mode(), "split", "the person's choice is kept");
    let screen = rig.screen();
    assert!(screen.contains("Split needs 60 columns"), "{screen}");
    assert!(!screen.contains('\u{2502}'), "{screen}");
    assert!(
        rig.node("markdown")
            .state
            .description
            .unwrap()
            .contains("split needs 60")
    );
}

// ---- 8: constructs ----------------------------------------------------------

const CONSTRUCTS: &str = "# Heading\n\nA paragraph with a [site](https://example.com/x) and a [note](notes/b.md).\n\n- [ ] first\n- [x] second\n\n> a quotation\n\n```rust\nlet x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n![remote](https://example.com/i.png)\n";

#[test]
fn every_construct_is_drawn_and_html_and_remote_media_are_inert() {
    let mut rig = Rig::opened(CONSTRUCTS);
    rig.alt('4');
    let screen = rig.screen();
    for needle in [
        "Heading",
        "A paragraph",
        "site",
        "first",
        "second",
        "a quotation",
        "let x = 1;",
        "1",
    ] {
        assert!(screen.contains(needle), "{needle} in\n{screen}");
    }
    assert!(
        screen.contains("https://example.com/x"),
        "a link is shown with its target: {screen}"
    );
    let fx = rig.tick();
    assert!(
        fx.iter().all(|e| !matches!(
            e.kind(),
            EffectKind::DocumentEdit | EffectKind::DocumentSave
        )),
        "{fx:#?}"
    );
}

#[test]
fn a_checkbox_is_toggled_through_one_ordinary_edit() {
    let mut rig = Rig::opened(CONSTRUCTS);
    let at = utf16_at(CONSTRUCTS, "- [ ] first");
    // The caret goes to the list by block navigation.
    for _ in 0..2 {
        rig.mods(Key::Down, Mods::ALT);
    }
    let e = the_edit(&rig.alt('x'));
    assert_eq!(changes(&e), vec![(at + 3, at + 4, "x".to_owned())]);
    let toggle = rig
        .node("block")
        .actions
        .into_iter()
        .find(|a| a.id.as_str() == "markdown.checkbox.toggle")
        .unwrap();
    assert!(toggle.enabled);
    rig.accept(&e, 2);
    let now = applied(CONSTRUCTS, &e);
    assert!(now.contains("- [x] first\n- [x] second"));
}

#[test]
fn a_workspace_link_opens_through_the_core_and_a_remote_one_opens_nothing() {
    let mut rig = Rig::opened(CONSTRUCTS);
    // Where nothing takes text, Tab selects links in order; the first is remote.
    rig.alt('4');
    rig.key(Key::Tab);
    assert!(
        rig.screen().contains("https://example.com/x"),
        "{}",
        rig.screen()
    );
    assert!(
        rig.screen().contains("not opened or fetched"),
        "{}",
        rig.screen()
    );
    let before = rig.m.panel_ids().count();
    let fx = rig.mods(Key::Enter, Mods::ALT);
    assert_eq!(rig.m.panel_ids().count(), before, "nothing opened");
    assert!(
        fx.iter().all(|e| e.kind() != EffectKind::DocumentOpen),
        "{fx:#?}"
    );
    // The second is a workspace path.
    rig.key(Key::Tab);
    assert!(
        rig.screen().contains("opens notes/b.md"),
        "{}",
        rig.screen()
    );
    let fx = rig.mods(Key::Enter, Mods::ALT);
    let tick = rig.tick();
    let opened = fx
        .iter()
        .chain(tick.iter())
        .any(|e| e.kind() == EffectKind::DocumentOpen && e.resource == doc_of("notes/b.md"));
    assert!(opened, "the core opened notes/b.md: {fx:#?} {tick:#?}");
}

// ---- 9: actions --------------------------------------------------------------

#[test]
fn the_markdown_actions_are_registered_once_and_reach_the_panel() {
    let mut registry = builtin::registry();
    extend_registry(&mut registry).unwrap();
    for id in [
        "markdown.mode.visual",
        "markdown.mode.source",
        "markdown.mode.split",
        "markdown.mode.preview",
        "markdown.checkbox.toggle",
        "markdown.block.open",
        "markdown.resolve.keepMine",
        "markdown.resolve.takeTheirs",
        "markdown.save",
    ] {
        assert!(registry.action(&ActionId::new(id)).is_some(), "{id}");
    }
    assert!(extend_registry(&mut registry).is_err(), "not twice");

    let mut rig = Rig::opened("hello\n");
    rig.act("markdown.mode.source");
    assert_eq!(rig.mode(), "source");
    rig.act("markdown.mode.preview");
    assert_eq!(rig.mode(), "preview");
    rig.act("markdown.mode.split");
    assert_eq!(rig.mode(), "split");
    rig.act("markdown.mode.visual");
    assert_eq!(rig.mode(), "visual");
    rig.alt('2');
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    let fx = rig.act("markdown.save");
    one(&fx, EffectKind::DocumentSave);
}

#[test]
fn modes_are_reached_from_the_keyboard_and_the_default_keys_do_not_clash() {
    let mut rig = Rig::opened("hello\n");
    for (c, mode) in [
        ('2', "source"),
        ('3', "split"),
        ('4', "preview"),
        ('1', "visual"),
    ] {
        rig.alt(c);
        assert_eq!(rig.mode(), mode, "Alt+{c}");
    }
}

// ---- 10: reveal --------------------------------------------------------------

impl Rig {
    /// The Files panel opens another file; the new panel takes the keyboard.
    /// The owner's answer to its open is given when `text` is.
    fn open_more(&mut self, path: &str, text: &str) -> PanelInstanceId {
        let known: Vec<_> = self.m.panel_ids().map(|(id, _)| id.clone()).collect();
        self.send(Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        });
        let fx = self.tick();
        if let Some(list) = of_kind(&fx, EffectKind::FilesList).first() {
            let mut c = Completion::new(list.id, ws(), Outcome::Accepted);
            c.payload = Some(CompletionPayload::Files(FileListing {
                entries: vec![
                    FileEntry::new("a.md", FileKind::File),
                    FileEntry::new("b.txt", FileKind::File),
                ],
                partial: false,
            }));
            self.send(Msg::Completion(c));
        }
        for ch in path.chars() {
            self.key(Key::Char(ch));
        }
        self.key(Key::Enter);
        let id =
            self.m
                .panel_ids()
                .map(|(id, _)| id.clone())
                .find(|id| {
                    !known.contains(id)
                        && self.m.panel(id).is_some_and(|p| {
                            p.binding().is_some_and(|b| b.resource == doc_of(path))
                        })
                })
                .expect("the new panel");
        let fx = self.tick();
        let open = of_kind(&fx, EffectKind::DocumentOpen)
            .into_iter()
            .find(|e| e.resource == doc_of(path))
            .cloned()
            .expect("the new panel asked the owner");
        let c = Completion::new(open.id, open.resource.clone(), Outcome::Accepted).with_payload(
            CompletionPayload::DocumentOpened(DocumentOpened {
                text: text.into(),
                revision: seq(1),
                saved_revision: None,
                dirty: false,
                read_only: None,
            }),
        );
        self.send(Msg::Completion(c));
        id
    }
}

#[test]
fn reveal_moves_to_the_source_position_in_every_mode() {
    use theorem_workbench_core::results::{LanguageLocations, LocationRow, Position, Range};
    let text = "first\n\nsecond \u{1F600} line\n\nthird\n";
    for mode in ['1', '2', '3', '4'] {
        let mut rig = Rig::opened(text);
        rig.alt(mode);
        let markdown = rig.id.clone();
        // The editor of another file asks for a definition that is in this one;
        // choosing it makes the root focus this panel and send `Reveal`.
        let editor = rig.open_more("b.txt", "x\n");
        rig.id = editor.clone();
        for (character, scalar) in [(1u32, 8u64), (9, 15)] {
            rig.send(Msg::Dock(DockMsg::FocusPanel(editor.clone())));
            let ask = one(&rig.key(Key::F12), EffectKind::LanguageNavigate);
            rig.answer(
                &ask,
                Outcome::Accepted,
                Some(CompletionPayload::LanguageLocations(LanguageLocations {
                    locations: vec![LocationRow {
                        resource_id: Some(PATH.into()),
                        uri: None,
                        range: Some(Range {
                            start: Position { line: 2, character },
                            end: Position { line: 2, character },
                        }),
                        span: None,
                        revision: None,
                    }],
                })),
            );
            rig.key(Key::Enter);
            rig.tick();
            // Line 3 of the text, past the emoji at UTF-16 column 9: scalars
            // "first\n\n" (7) and "second " (7) and the emoji (1).
            let view = {
                let saved = std::mem::replace(&mut rig.id, markdown.clone());
                let v = rig.state()["view"].clone();
                rig.id = saved;
                v
            };
            // Source scalar of line 3: offset 7, so column 2 is 8 and the
            // column after the emoji is 15.
            assert_eq!(view["selection"]["head"], scalar, "mode {mode}: {view}");
        }
    }
}

// ---- 11: semantics -----------------------------------------------------------

#[test]
fn the_semantic_tree_names_the_mode_the_path_the_state_the_block_and_any_conflict() {
    let mut rig = Rig::opened("# Title\n\nbody\n");
    rig.tree_ok();
    let root = rig.node("markdown");
    assert_eq!(root.name, PATH);
    assert_eq!(root.binding, doc());
    assert_eq!(root.revision, Some(seq(1)));
    assert!(!root.state.modified);
    let d = root.state.description.unwrap();
    assert!(d.contains("mode: visual") && d.contains("saved"), "{d}");
    assert!(rig.node("block").name.contains("heading 1"));
    let selected: Vec<_> = ["mode:visual", "mode:source", "mode:split", "mode:preview"]
        .into_iter()
        .map(|id| rig.node(id).state.selected)
        .collect();
    assert_eq!(selected, vec![true, false, false, false]);
    rig.alt('2');
    let e = the_edit(&rig.key(Key::Char('X')));
    assert!(rig.node("markdown").state.modified);
    assert!(!rig.has_node("conflict"));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "conflict".into(),
            reason: "moved".into(),
        },
        Some(conflict_payload(&e, "# Title!\n\nbody\n", 2)),
    );
    assert!(rig.has_node("conflict"));
    rig.tree_ok();
}

#[test]
fn the_semantic_tree_is_valid_before_the_document_exists_and_when_the_owner_refuses_it() {
    let mut rig = Rig::start();
    rig.tree_ok();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Refused {
            code: "binary".into(),
            reason: "this file is binary".into(),
        },
        None,
    );
    rig.tree_ok();
    assert!(
        rig.screen().contains("this file is binary"),
        "{}",
        rig.screen()
    );
    for mode in ['1', '2', '3', '4'] {
        let mut rig = Rig::opened("# a\n\n- [ ] b\n");
        rig.alt(mode);
        rig.tree_ok();
    }
}

// ---- 12: serialize and restore -----------------------------------------------

#[test]
fn the_view_state_survives_a_save_and_restore_of_the_layout() {
    let mut rig = Rig::source("hello world\n\nsecond line\n\nthird\n");
    rig.key(Key::Down);
    rig.key(Key::Right);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.alt('3');
    let state = rig.state();
    assert_eq!(state["path"], PATH);
    assert_eq!(state["workspace"], "w");
    assert_eq!(state["mode"].as_str().unwrap().to_lowercase(), "split");
    assert_eq!(state["unit"], "scalar");
    let layout = rig.m.document();

    let mut other = Rig::start_file("b.txt", &Drafts::new(), 200);
    let _ = other.m.restore(layout);
    let id = other
        .m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "markdown")
        .map(|(id, _)| id.clone())
        .expect("the restored panel");
    other.id = id;
    other.kind = "markdown".into();
    let fx = other.tick();
    other.open = of_kind(&fx, EffectKind::DocumentOpen)
        .into_iter()
        .find(|e| e.resource == doc())
        .cloned();
    other.answer_open("hello world\n\nsecond line\n\nthird\n", 1);
    let restored = other.state();
    assert_eq!(restored["mode"].as_str().unwrap().to_lowercase(), "split");
    assert_eq!(restored["view"]["selection"], state["view"]["selection"]);
}

// ---- the drafts ------------------------------------------------------------------

#[test]
fn closing_the_panel_keeps_unsent_text_and_the_open_block_as_a_draft() {
    let drafts = Drafts::new();
    let mut rig = Rig::start_file(PATH, &drafts, 200);
    rig.answer_open("# Title\n\nbody\n", 1);
    rig.key(Key::Enter);
    rig.typed("typed");
    let id = rig.id.clone();
    let fx = rig.send(Msg::Dock(DockMsg::ClosePanel(id)));
    one(&fx, EffectKind::DocumentClose);
    assert!(drafts.holds(&doc()), "the typed text is kept");
}

// ---- the units ---------------------------------------------------------------------

const UNITS: &str = "# Title\n\n\ttab\there \u{65e5}\u{672c}\u{8a9e} e\u{301} \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} end\r\nsecond line with CRLF before it, long enough to wrap in a narrow pane because it keeps going and going\n";

#[test]
fn edits_after_tabs_cjk_combining_marks_zwj_emoji_and_crlf_leave_in_utf16() {
    let mut rig = Rig::source(UNITS);
    // Put the caret at the very end of the family emoji by going there.
    let at = utf16_at(UNITS, " end");
    let line_start = utf16_at(UNITS, "\ttab");
    let _ = (at, line_start);
    rig.mods(Key::Down, Mods::NONE);
    rig.mods(Key::Down, Mods::NONE);
    rig.key(Key::Home);
    let e = the_edit(&rig.key(Key::Char('Q')));
    let after = applied(UNITS, &e);
    assert!(after.contains("Q\ttab"), "{after:?}");
    rig.accept(&e, 2);
    rig.key(Key::End);
    let e2 = the_edit(&rig.key(Key::Char('R')));
    let after2 = applied(&after, &e2);
    assert!(after2.contains("endR\r\n"), "{after2:?}");
    assert_eq!(
        changes(&e2)[0].0,
        utf16_at(&after, "\r\n"),
        "the offset counts the tab, the CJK, the combining mark and the ZWJ emoji in UTF-16 units"
    );
    assert_eq!(after2.replacen('R', "", 1).replacen('Q', "", 1), UNITS);
    assert!(rig.status().contains("Ln 3"), "{}", rig.status());
}

// ---- the four modes at 80 by 24 ---------------------------------------------------

const SHOWCASE: &str = "# Notes\n\nA paragraph with a [link](notes/b.md) and `code`.\n\n- [ ] write\n- [x] test\n\n> quoted\n\n```rust\nfn main() {}\n```\n";

#[test]
fn the_four_modes_at_eighty_by_twenty_four() {
    let mut out = String::new();
    for (mode, name) in [
        ('1', "visual"),
        ('2', "source"),
        ('3', "split"),
        ('4', "preview"),
    ] {
        let mut rig = Rig::start_file(PATH, &Drafts::new(), 200);
        rig.answer_open(SHOWCASE, 1);
        rig.alt(mode);
        let rows = rig.rows(80, 24);
        out.push_str(&format!("--- {name} (80x24) ---\n{}\n", rows.join("\n")));
        assert!(
            rows[0].contains("Visual") && rows[0].contains("Preview"),
            "{name}: {}",
            rows[0]
        );
        assert!(rows.iter().any(|r| r.contains("Notes")), "{name}");
        assert!(rows[23].contains(PATH), "{name}: {}", rows[23]);
    }
    println!("{out}");
}

// ---- syntax colour ------------------------------------------------------------

fn tokens(revision: u64, encoding: SpanEncoding, spans: &[(u64, u64, &str)]) -> HostMessage {
    HostMessage::DocumentTokens {
        resource: doc(),
        revision: seq(revision),
        encoding,
        spans: spans
            .iter()
            .map(|(start, end, class)| TokenSpan {
                start: *start,
                end: *end,
                class: (*class).to_owned(),
            })
            .collect(),
    }
}

impl Rig {
    /// The style of the first cell of `needle` on the first row that has it,
    /// counting the cells before it as one each (the rows here are ASCII before
    /// the needle), left of `before` when given so a Split pane can be chosen.
    fn style_of(&self, needle: &str, pane: std::ops::Range<u16>) -> Style {
        let b = self.body();
        let buf = self.draw(b.width, b.height);
        let rows = self.rows(b.width, b.height);
        for (y, row) in rows.iter().enumerate() {
            let chars: Vec<char> = row.chars().collect();
            let want: Vec<char> = needle.chars().collect();
            for x in pane.start as usize..(pane.end as usize).min(chars.len()) {
                if chars[x..].starts_with(&want) {
                    return buf[(x as u16, y as u16)].style();
                }
            }
        }
        panic!("{needle:?} is not drawn in {pane:?}:\n{}", rows.join("\n"));
    }

    fn style(&self, needle: &str) -> Style {
        self.style_of(needle, 0..u16::MAX)
    }
}

const CODE: &str = "fn main() {}\nplain words\n";

/// Source mode with the caret on the empty last line, so no word is drawn
/// under it.
fn source_at_end(text: &str) -> Rig {
    let mut rig = Rig::source(text);
    rig.mods(Key::End, Mods::CTRL);
    rig
}

#[test]
fn source_is_coloured_by_the_hosts_spans_for_the_revision_it_holds() {
    let mut rig = source_at_end(CODE);
    let plain = rig.style("plain");
    assert_eq!(rig.style("fn"), plain, "no spans yet: no colour");
    rig.host(tokens(
        1,
        SpanEncoding::Utf8Bytes,
        &[(0, 2, "keyword"), (3, 7, "comment")],
    ));
    assert_ne!(rig.style("fn"), plain, "fn is a keyword");
    assert_ne!(rig.style("main"), plain);
    assert_ne!(
        rig.style("fn"),
        rig.style("main"),
        "two classes, two styles"
    );
    assert_eq!(rig.style("plain"), plain, "words with no span stay plain");
}

#[test]
fn spans_are_read_in_the_encoding_they_name() {
    // "\u{e9}" is two bytes and one scalar; the keyword starts after it.
    let text = "\u{e9} fn x\n\n";
    for (encoding, start, end) in [
        (SpanEncoding::Utf8Bytes, 3, 5),
        (SpanEncoding::Utf16CodeUnits, 2, 4),
        (SpanEncoding::UnicodeScalars, 2, 4),
    ] {
        let mut rig = source_at_end(text);
        let plain = rig.style("x");
        rig.host(tokens(1, encoding, &[(start, end, "keyword")]));
        assert_ne!(rig.style("fn"), plain, "{encoding:?}");
        assert_eq!(rig.style("x"), plain, "{encoding:?}: only fn");
    }
    // A span inside a scalar is not a place in the text: it is dropped.
    let mut rig = source_at_end(text);
    let plain = rig.style("fn");
    rig.host(tokens(1, SpanEncoding::Utf8Bytes, &[(1, 5, "keyword")]));
    assert_eq!(rig.style("fn"), plain);
}

#[test]
fn spans_for_another_revision_are_not_applied_and_a_later_one_waits() {
    let mut rig = source_at_end(CODE);
    let plain = rig.style("plain");
    // An older revision: other text, never applied.
    rig.host(tokens(0, SpanEncoding::Utf8Bytes, &[(0, 2, "keyword")]));
    assert_eq!(rig.style("fn"), plain);
    // A later one waits until the text has caught up with it.
    rig.host(tokens(2, SpanEncoding::Utf8Bytes, &[(0, 2, "keyword")]));
    assert_eq!(rig.style("fn"), plain, "revision 2 is not held yet");
    rig.host(remote_insert(2, 12, "!"));
    assert_ne!(rig.style("fn"), plain, "now it is");
}

#[test]
fn unchanged_lines_keep_their_colour_until_new_spans_arrive() {
    let mut rig = source_at_end(CODE);
    let plain = rig.style("plain");
    rig.host(tokens(
        1,
        SpanEncoding::Utf8Bytes,
        &[(0, 2, "keyword"), (13, 24, "comment")],
    ));
    let (kw, cm) = (rig.style("fn"), rig.style("words"));
    assert_ne!(kw, plain);
    assert_ne!(cm, plain, "the second line has a comment span");
    // An edit on the second line, not yet accepted: the first keeps its colour,
    // the line that changed is plain.
    rig.key(Key::Up);
    rig.key(Key::Home);
    let fx = rig.key(Key::Char('Z'));
    assert_eq!(rig.style("fn"), kw);
    assert_eq!(rig.style("words"), plain, "the changed line has no colour");
    // The host's spans for the new revision colour it again.
    let e = the_edit(&fx);
    rig.accept(&e, 2);
    rig.host(tokens(
        2,
        SpanEncoding::Utf8Bytes,
        &[(0, 2, "keyword"), (13, 25, "comment")],
    ));
    assert_eq!(rig.style("words"), cm);
}

#[test]
fn spans_for_the_accepted_revision_show_at_once_with_an_edit_pending() {
    let mut rig = source_at_end("fn a\nmid line\nfn z\n");
    let plain = rig.style("mid");
    // Change the middle line and leave the edit unanswered.
    rig.key(Key::Up);
    rig.key(Key::Up);
    rig.key(Key::Home);
    rig.key(Key::Char('Q'));
    // The host's spans are for the accepted revision, which is not the text on
    // screen: both outer lines keep their colour, the changed one is plain.
    rig.host(tokens(
        1,
        SpanEncoding::Utf8Bytes,
        &[(0, 2, "keyword"), (5, 8, "comment"), (14, 16, "keyword")],
    ));
    let keyword = rig.style("fn a");
    assert_ne!(keyword, plain, "the leading line is coloured at once");
    assert_eq!(rig.style("fn z"), keyword, "so is the trailing one");
    assert_eq!(rig.style("Qmid"), plain, "the line between is plain");
}

#[test]
fn split_colours_the_source_side_and_not_the_rendered_side() {
    let mut rig = source_at_end("# Title\n\nfn main\n\n");
    rig.alt('3');
    let width = rig.body().width;
    let left = 0..width / 2;
    let right = width / 2 + 1..width;
    let rendered = rig.style_of("Title", right.clone());
    let source_plain = rig.style_of("main", left.clone());
    rig.host(tokens(1, SpanEncoding::Utf8Bytes, &[(0, 7, "keyword")]));
    assert_ne!(
        rig.style_of("# Title", left),
        source_plain,
        "the source side is coloured"
    );
    assert_eq!(
        rig.style_of("Title", right),
        rendered,
        "the rendered side is drawn by the Markdown model, not by the spans"
    );
}

// ---- 8: nothing remote is fetched or opened ---------------------------------------

#[test]
fn a_remote_image_and_a_remote_link_emit_nothing_on_open_preview_or_tab() {
    let text =
        "# Page\n\nSee [site](https://example.com/x) and ![pic](https://example.com/i.png).\n";
    let mut rig = Rig::start();
    let mut all = rig.answer_open(text, 1);
    for mode in ['4', '3', '1', '4'] {
        all.extend(rig.alt(mode));
        all.extend(rig.tick());
    }
    all.extend(rig.key(Key::Tab));
    all.extend(rig.mods(Key::Tab, Mods::SHIFT));
    all.extend(rig.key(Key::Tab));
    assert!(
        rig.screen().contains("not opened or fetched"),
        "{}",
        rig.screen()
    );
    all.extend(rig.mods(Key::Enter, Mods::ALT));
    assert!(all.is_empty(), "nothing was sent: {all:#?}");
    assert!(!rig.m.panel_ids().any(|(_, k)| k.as_str() == "browser"));
}

// ---- 9: a chord for the mode already shown ----------------------------------------

#[test]
fn the_chord_for_the_mode_already_shown_does_nothing() {
    let mut rig = Rig::opened("# Title\n");
    assert_eq!(rig.mode(), "visual");
    let before = rig.screen();
    let fx = rig.alt('1');
    assert!(fx.is_empty(), "{fx:#?}");
    assert!(!rig.screen().contains("Already"), "{}", rig.screen());
    assert_eq!(rig.screen(), before);
    let fx = rig.act("markdown.mode.visual");
    assert!(fx.is_empty());
    assert!(!rig.screen().contains("Already"), "{}", rig.screen());
}

// ---- 10: opener precedence, placement, theme roles, composition, tab label ---------

fn file(path: &str) -> OpenTarget {
    OpenTarget::File {
        workspace: "w".into(),
        path: path.into(),
    }
}

#[test]
fn markdown_wins_the_opener_whichever_registers_first() {
    for markdown_first in [true, false] {
        let mut factories = PanelFactories::new();
        if markdown_first {
            register_with(&mut factories, Drafts::new());
            theorem_workbench_editor::register(&mut factories);
        } else {
            theorem_workbench_editor::register(&mut factories);
            register_with(&mut factories, Drafts::new());
        }
        for path in ["a.md", "a.markdown", "a.mdx", "dir/A.MD"] {
            let kind = factories.opener_of(&file(path)).map(|k| k.as_str());
            assert_eq!(
                kind,
                Some("markdown"),
                "{path}, markdown first: {markdown_first}"
            );
        }
        let kind = factories.opener_of(&file("a.rs")).map(|k| k.as_str());
        assert_eq!(kind, Some("document"), "markdown first: {markdown_first}");
    }
}

#[test]
fn a_markdown_file_opened_from_files_lands_in_the_tool_group() {
    let rig = Rig::start_file("notes.md", &Drafts::new(), 200);
    assert_eq!(rig.kind, "markdown");
    let frame = rig.m.frame().expect("solved");
    let group = frame
        .groups
        .iter()
        .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(rig.id.as_str()))
        .expect("the panel's group");
    assert_eq!(group.role, Role::Tools);
}

/// The derivation `from_theme` had before the core theme had prose roles: the
/// Markdown model's modifiers, with six chrome roles laid over them.
fn derived_before(theme: &Theme) -> MarkdownStyles {
    let mut markdown = MarkdownStyles::plain();
    markdown.text = theme.text;
    markdown.selection = theme.selected;
    markdown.conflict = theme.error;
    markdown.line_number = theme.muted;
    markdown.editing = theme.focus;
    markdown.held = theme.error;
    markdown.divider = theme.line;
    markdown.code = theme.muted;
    markdown.quote = theme.muted;
    markdown.table_border = theme.muted;
    markdown
}

#[test]
fn the_default_themes_give_the_styles_the_panel_had_before_the_prose_roles() {
    use ratatui::style::Color;
    let chrome = Theme::chrome(
        Style::new().bg(Color::Rgb(10, 10, 10)),
        Style::new().fg(Color::Rgb(220, 220, 220)),
        Style::new().fg(Color::Rgb(130, 130, 130)),
        Style::new().fg(Color::Rgb(60, 60, 60)),
        Style::new().fg(Color::Rgb(90, 160, 250)),
        Style::new().bg(Color::Rgb(40, 40, 60)),
    );
    for (name, theme) in [("plain", Theme::plain()), ("chrome", chrome)] {
        let now = MarkdownPanelStyles::from_theme(&theme).markdown;
        assert_eq!(now, derived_before(&theme), "{name}");
    }
}

#[test]
fn a_change_to_a_theme_role_changes_what_the_panel_draws() {
    use ratatui::style::Color;
    let rig = Rig::opened("body\n\n# Head\n");
    let heading_in = |theme: &Theme| {
        let b = rig.body();
        let area = Rect::new(0, 0, b.width, b.height);
        let mut buf = Buffer::empty(area);
        let mut cx = ViewCtx::new(theme, rig.m.workspace());
        cx.focused = false;
        rig.m.panel(&rig.id).unwrap().view(area, &mut buf, &cx);
        let rows: Vec<String> = (0..b.height)
            .map(|y| {
                (0..b.width)
                    .map(|x| buf[(x, y)].symbol().to_owned())
                    .collect()
            })
            .collect();
        let (y, row) = rows
            .iter()
            .enumerate()
            .find(|(_, r)| r.contains("Head"))
            .expect("the heading is drawn");
        buf[(row.find("Head").unwrap() as u16, y as u16)].style()
    };
    let plain = Theme::plain();
    let mut changed = plain.clone();
    changed.heading[0] = Style::new().fg(Color::Rgb(255, 0, 255));
    assert_ne!(heading_in(&plain), heading_in(&changed));
    assert_eq!(heading_in(&changed).fg, Some(Color::Rgb(255, 0, 255)));
}

#[test]
fn composition_is_drawn_at_the_caret_and_only_its_end_enters_the_document() {
    let mut rig = Rig::source("ab\n");
    rig.key(Key::End);
    rig.send(Msg::Composition(Composition::Start));
    rig.send(Msg::Composition(Composition::Update { text: "ni".into() }));
    assert!(rig.text().starts_with("abni"), "{}", rig.text());
    assert!(
        edits(&rig.tick()).is_empty(),
        "the preedit is not the document"
    );
    rig.send(Msg::Composition(Composition::Update {
        text: "ni h".into(),
    }));
    assert!(rig.text().starts_with("abni h"), "{}", rig.text());
    assert!(edits(&rig.tick()).is_empty());
    let mut fx = rig.send(Msg::Composition(Composition::End {
        text: "\u{4f60}".into(),
    }));
    fx.extend(rig.tick());
    let edit = the_edit(&fx);
    assert_eq!(applied("ab\n", &edit), "ab\u{4f60}\n");
    assert!(rig.text().starts_with("ab\u{4f60}"), "{}", rig.text());
    assert!(!rig.text().contains("ni h"));
}

#[test]
fn composition_in_an_open_block_stays_in_the_block_until_it_ends_and_the_block_closes() {
    let mut rig = Rig::opened("# Title\n\npara\n");
    assert_eq!(rig.mode(), "visual");
    assert!(
        rig.node("block")
            .state
            .description
            .unwrap_or_default()
            .contains("open for editing")
    );
    rig.send(Msg::Composition(Composition::Start));
    rig.send(Msg::Composition(Composition::Update { text: "ni".into() }));
    assert!(rig.screen().contains("ni"), "{}", rig.screen());
    assert!(edits(&rig.tick()).is_empty(), "the preedit reaches nobody");
    let mut fx = rig.send(Msg::Composition(Composition::End { text: "x".into() }));
    fx.extend(rig.tick());
    assert!(edits(&fx).is_empty(), "the block holds it until it closes");
    assert!(rig.screen().contains('x'), "{}", rig.screen());
    let mut fx = rig.key(Key::Esc);
    fx.extend(rig.tick());
    assert!(!applied("# Title\n\npara\n", &the_edit(&fx)).contains("ni"));
    assert!(applied("# Title\n\npara\n", &the_edit(&fx)).contains('x'));
}

#[test]
fn the_tab_label_is_the_file_name_and_the_modified_mark_and_follows_a_move() {
    let mut rig = Rig::source("hello\n");
    let label = |rig: &Rig| rig.m.tab_label(&rig.id, "Markdown");
    let first = label(&rig);
    assert_eq!((first.title.as_str(), first.modified), ("a.md", false));
    rig.typed("x");
    assert!(label(&rig).modified, "an unsaved edit marks the tab");
    rig.host(HostMessage::DocumentMoved {
        from: doc(),
        to: doc_of("docs/renamed.md"),
    });
    let moved = label(&rig);
    assert_eq!(moved.title, "renamed.md");
    assert!(moved.modified);
}
