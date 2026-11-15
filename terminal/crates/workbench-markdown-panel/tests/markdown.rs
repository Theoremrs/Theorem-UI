//! The Markdown panel driven through a real root, as the Files panel does: the
//! panel is opened by the Files panel, keys go in as `Msg`, the owner's answers
//! go in as completions and host messages, and effects, cells and semantic
//! nodes come out.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use std::cell::RefCell;
use std::rc::Rc;
use theorem_workbench_core::OpenTarget;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    Completion, CompletionPayload, DocumentConflicted, DocumentCurrent, DocumentEdited,
    DocumentOpened, DocumentSaved, FileEntry, FileKind, FileListing, Outcome, PendingEdit,
    PendingState,
};
use theorem_workbench_core::draft::SourceReference;
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
    Ctx, DockMsg, LocalProblem, LocalState, LocalStatus, Model, Msg, Panel, PanelFactories,
    PanelMsg, Theme, ViewCtx, semantics, update,
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

/// What a conversation panel was handed, in order.
type Refs = Rc<RefCell<Vec<SourceReference>>>;

/// A conversation panel that keeps the references it is handed.
struct Recorder(Refs);

impl Panel for Recorder {
    fn update(&mut self, msg: PanelMsg, _cx: &mut Ctx) {
        if let PanelMsg::Reference(r) = msg {
            self.0.borrow_mut().push(r);
        }
    }
    fn view(&self, _area: Rect, _buf: &mut Buffer, _cx: &ViewCtx) {}
    fn semantics(
        &self,
        _area: Rect,
        _cx: &ViewCtx,
    ) -> Vec<theorem_workbench_core::semantics::Node> {
        vec![]
    }
    fn serialize(&self) -> serde_json::Value {
        serde_json::Value::Null
    }
}

fn model(caps: &[&'static str], drafts: &Drafts, width: u16, refs: Option<Refs>) -> Model {
    let mut factories = PanelFactories::new();
    theorem_workbench_panels::register(&mut factories);
    if let Some(refs) = refs {
        factories.register("theo", move |_, _| Box::new(Recorder(refs.clone())));
    }
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

/// The checkpoints among `fx`, and everything else.
fn split_keeps(fx: Vec<Effect>) -> (Vec<Effect>, Vec<Effect>) {
    fx.into_iter()
        .partition(|e| e.kind() == EffectKind::DocumentKeep)
}

/// What each checkpoint holds: the text each of its edits inserts, in order.
fn kept_inserts(keeps: &[Effect]) -> Vec<Vec<String>> {
    keeps
        .iter()
        .map(|e| {
            let EffectBody::DocumentKeep(k) = &e.body else {
                panic!("not a keep: {e:?}");
            };
            k.edits
                .iter()
                .flat_map(|k| k.edits.iter().map(|c| c.insert.clone()))
                .collect()
        })
        .collect()
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
        Self::start_with(path, drafts, width, None)
    }

    fn start_with(path: &str, drafts: &Drafts, width: u16, refs: Option<Refs>) -> Self {
        let mut m = model(&CAPS, drafts, width, refs);
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
        self.answer_open_with(text, revision, vec![])
    }

    fn answer_open_with(
        &mut self,
        text: &str,
        revision: u64,
        pending: Vec<PendingEdit>,
    ) -> Vec<Effect> {
        let open = self.open.take().expect("an open is waiting");
        let c = Completion::new(open.id, open.resource.clone(), Outcome::Accepted).with_payload(
            CompletionPayload::DocumentOpened(DocumentOpened {
                text: text.into(),
                revision: seq(revision),
                saved_revision: None,
                dirty: false,
                read_only: None,
                pending,
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
            pending: vec![],
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
                pending: vec![],
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

// ---- 11: local state, edits recovered from this device, revoked access ----------

fn local(status: LocalStatus, problem: Option<(&str, &str)>) -> HostMessage {
    HostMessage::DocumentLocal {
        resource: doc(),
        local: LocalState {
            status,
            problem: problem.map(|(code, reason)| LocalProblem {
                code: code.into(),
                reason: reason.into(),
            }),
        },
    }
}

fn restored(op: &str, base: u64, start: u32, end: u32, insert: &str) -> PendingEdit {
    PendingEdit {
        operation_id: op.into(),
        base_revision: seq(base),
        edits: vec![CoreChange {
            start,
            end,
            insert: insert.into(),
        }],
        state: PendingState::Restored,
        reason: None,
    }
}

fn settles(fx: &[Effect]) -> Vec<String> {
    of_kind(fx, EffectKind::DocumentSettle)
        .iter()
        .map(|e| match &e.body {
            EffectBody::DocumentSettle(s) => s.operation_id.clone(),
            other => panic!("{other:?}"),
        })
        .collect()
}

/// The rows of the whole body at `width`, joined into one line of words.
fn words_on_screen(rig: &Rig, width: u16) -> String {
    rig.rows(width, 24)
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn local_state_is_in_the_status_line_in_every_mode_at_80_and_40_columns_and_in_the_tree() {
    // The words at 80 columns and at 40, and words that must not be there.
    let states = [
        (LocalStatus::Accepted, None, "", "", "device"),
        (
            LocalStatus::Draft,
            None,
            "edits not yet kept on this device",
            "not kept yet",
            "kept on this device,",
        ),
        (
            LocalStatus::Checkpointed {
                saved_at_ms: 1,
                recovered: false,
            },
            None,
            "kept on this device, not saved to the file",
            "kept, unsaved",
            "not kept",
        ),
        (
            LocalStatus::Draft,
            Some(("quota", "the browser store is full")),
            "not kept: the browser store is full; only in this page",
            "not kept",
            "kept on this device,",
        ),
    ];
    for (status, problem, wide, narrow, absent) in states {
        for (width, words) in [(80u16, wide), (40, narrow)] {
            for mode in ['1', '2', '3', '4'] {
                let mut rig = Rig::opened("hello\n");
                rig.alt(mode);
                rig.host(local(status.clone(), problem));
                let bottom = rig.rows(width, 24)[23].clone();
                if words.is_empty() {
                    assert!(!bottom.contains(absent), "{bottom}");
                    assert!(!rig.has_node("local"));
                } else {
                    assert!(
                        bottom.contains(words),
                        "{width} columns, mode {mode}: {bottom:?}"
                    );
                    assert!(!bottom.contains(absent), "{bottom}");
                    let name = rig.node("local").name;
                    assert!(name.contains("device") || name.contains("page"), "{name}");
                }
                if problem.is_some() {
                    // The whole reason stays on screen at any width: in the
                    // flag when it fits, in a notice row when the flag said less.
                    let screen = words_on_screen(&rig, width);
                    assert!(
                        screen.contains("the browser store is full"),
                        "{width} columns, mode {mode}: {screen}"
                    );
                    if width == 40 {
                        assert!(
                            screen.contains(
                                "Not kept on this device: the browser store is full. The edits are only in this page."
                            ),
                            "{screen}"
                        );
                    }
                }
                rig.tree_ok();
            }
        }
    }
    // Edits the owner has say nothing extra, whatever came before.
    let mut rig = Rig::opened("hello\n");
    rig.host(local(
        LocalStatus::Draft,
        Some(("quota", "the browser store is full")),
    ));
    rig.host(local(LocalStatus::Accepted, None));
    assert!(!rig.screen().contains("device"), "{}", rig.screen());
}

#[test]
fn recovered_edits_are_shown_and_nothing_is_sent_before_the_person_chooses() {
    let mut rig = Rig::start();
    let mut fx = rig.answer_open_with(
        "hello\n",
        1,
        vec![restored("r1", 1, 0, 0, "X"), restored("r2", 1, 1, 1, "Y")],
    );
    rig.alt('2');
    assert!(rig.text().starts_with("XYhello"), "{}", rig.text());
    let screen = rig.screen();
    assert!(screen.contains("recovered from this device"), "{screen}");
    for title in ["Keep recovered", "Discard recovered", "Copy"] {
        assert!(screen.contains(title), "{title}: {screen}");
    }
    assert!(rig.status().contains("recovered"), "{}", rig.status());
    assert!(rig.has_node("strip"));
    rig.tree_ok();
    fx.extend(rig.tick());
    fx.extend(rig.typed("Q"));
    fx.extend(rig.tick());
    // The caret is at the end of the last recovered change: Q lands after XY.
    assert!(
        rig.text().starts_with("XYQhello"),
        "the caret follows the recovery: {}",
        rig.text()
    );
    fx.extend(rig.act("markdown.save"));
    // Only the checkpoint of what was typed behind the recovered edits goes
    // out: the recovered ones are the owner's already, under their own ids.
    let (keeps, rest) = split_keeps(fx);
    assert!(
        rest.is_empty(),
        "nothing is sent before a choice: {rest:#?}"
    );
    assert_eq!(kept_inserts(&keeps), [vec!["Q".to_owned()]], "{keeps:#?}");
}

#[test]
fn keeping_recovered_edits_settles_each_and_then_sends_the_text() {
    let mut rig = Rig::start();
    rig.answer_open_with(
        "hello\n",
        1,
        vec![restored("r1", 1, 0, 0, "X"), restored("r2", 1, 1, 1, "Y")],
    );
    let fx = rig.alt('j');
    assert_eq!(settles(&fx), vec!["r1".to_owned(), "r2".to_owned()]);
    none_of(&fx, EffectKind::DocumentEdit);
    let sent = of_kind(&fx, EffectKind::DocumentSettle)
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    // The owner has not yet let go: nothing is sent behind it.
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    let first = rig.answer(&sent[0], Outcome::Accepted, None);
    none_of(&first, EffectKind::DocumentEdit);
    let mut fx = rig.answer(&sent[1], Outcome::Accepted, None);
    fx.extend(rig.tick());
    // One in flight at a time, in order, each against the revision before:
    // together they are the recovered text, once.
    let mut text = "hello\n".to_owned();
    let mut revision = 1;
    let mut count = 0;
    while let Some(e) = edits(&fx).into_iter().next() {
        assert_eq!(
            e.revision,
            Some(seq(revision)),
            "against the current revision"
        );
        let EffectBody::DocumentEdit(body) = &e.body else {
            panic!()
        };
        assert!(
            !["r1", "r2"].contains(&body.operation_id.as_str()),
            "a new id"
        );
        text = applied(&text, &e);
        revision += 1;
        count += 1;
        assert!(count < 5, "sent too often");
        fx = rig.accept(&e, revision);
        fx.extend(rig.tick());
    }
    assert_eq!(text, "XYhello\n");
    assert!(!rig.has_node("strip"), "the bar is gone");
}

#[test]
fn discarding_recovered_edits_only_settles_and_drops_the_text() {
    let mut rig = Rig::start();
    rig.answer_open_with("hello\n", 1, vec![restored("r1", 1, 0, 0, "X")]);
    rig.alt('2');
    let fx = rig.alt('g');
    assert_eq!(settles(&fx), vec!["r1".to_owned()]);
    none_of(&fx, EffectKind::DocumentEdit);
    assert_eq!(rig.text(), "hello");
    let sent = of_kind(&fx, EffectKind::DocumentSettle)[0].clone();
    let mut after = rig.answer(&sent, Outcome::Accepted, None);
    after.extend(rig.tick());
    assert!(after.is_empty(), "discarding sends no edit: {after:#?}");
    assert!(!rig.has_node("strip"), "the bar is gone");
    // Editing works again, as ordinary edits.
    let edit = the_edit(&rig.key(Key::Char('Z')));
    assert_eq!(applied("hello\n", &edit), "Zhello\n");
}

#[test]
fn the_old_chords_do_not_keep_or_discard_and_alt_j_and_alt_g_do() {
    let mut rig = Rig::start();
    rig.answer_open_with("hello\n", 1, vec![restored("r1", 1, 0, 0, "X")]);
    for old in ['e', 'w'] {
        assert!(settles(&rig.alt(old)).is_empty());
    }
    assert_eq!(settles(&rig.alt('j')), vec!["r1".to_owned()]);
}

#[test]
fn copy_sends_the_recovered_text_to_the_clipboard() {
    for id in ["markdown.recovered.copy", "markdown.resolve.copyMine"] {
        let mut rig = Rig::start();
        rig.answer_open_with("hello\n", 1, vec![restored("r1", 1, 0, 0, "X")]);
        let fx = rig.act(id);
        let writes = of_kind(&fx, EffectKind::ClipboardWrite);
        assert_eq!(writes.len(), 1, "{id}: {fx:#?}");
        let EffectBody::ClipboardWrite(w) = &writes[0].body else {
            unreachable!()
        };
        assert_eq!(w.text, "X");
    }
}

#[test]
fn recovered_edits_made_against_another_revision_are_not_placed_and_are_chosen_about_as_a_conflict()
{
    let ids = |rig: &Rig| -> Vec<String> {
        let tree = semantics(&rig.m);
        rig.node("strip")
            .children
            .iter()
            .map(|id| tree.node(id).expect("a button").name.clone())
            .collect()
    };
    let moved = || {
        let mut rig = Rig::start();
        let mut fx = rig.answer_open_with("hello\n", 5, vec![restored("r1", 2, 0, 0, "LOST")]);
        rig.alt('2');
        fx.extend(rig.tick());
        assert!(fx.is_empty(), "{fx:#?}");
        rig
    };
    let mut rig = moved();
    assert_eq!(
        rig.text().lines().next(),
        Some("hello"),
        "the text is the owner's"
    );
    let screen = rig.screen();
    assert!(screen.contains("not placed"), "{screen}");
    assert!(screen.contains("revision 2"), "{screen}");
    assert_eq!(ids(&rig), ["Take their text", "Keep both", "Copy my text"]);
    // Typing sends nothing while they wait.
    let fx = rig.typed("Q");
    assert!(fx.is_empty(), "{fx:#?}");
    // The keep that would place them is refused with its reason.
    let mut rig = moved();
    let fx = rig.act("markdown.resolve.keepMine");
    assert!(fx.is_empty());
    let said = rig.node("status").state.description.unwrap_or_default();
    assert!(
        said.contains("their ranges cannot be placed in this text"),
        "{said}"
    );
    // Take their text drops them, as a settle.
    let mut rig = moved();
    let fx = rig.act("markdown.resolve.takeTheirs");
    assert_eq!(settles(&fx), vec!["r1".to_owned()]);
    let sent = of_kind(&fx, EffectKind::DocumentSettle)[0].clone();
    let mut after = rig.answer(&sent, Outcome::Accepted, None);
    after.extend(rig.tick());
    assert!(after.is_empty(), "{after:#?}");
    assert_eq!(rig.text(), "hello");
    // Keep both adds the recovered text after the file's, then sends it once.
    let mut rig = moved();
    let fx = rig.act("markdown.resolve.keepBoth");
    assert_eq!(settles(&fx), vec!["r1".to_owned()]);
    none_of(&fx, EffectKind::DocumentEdit);
    let sent = of_kind(&fx, EffectKind::DocumentSettle)[0].clone();
    let mut after = rig.answer(&sent, Outcome::Accepted, None);
    after.extend(rig.tick());
    let edit = the_edit(&after);
    assert_eq!(applied("hello\n", &edit), "hello\nLOST");
    assert_eq!(edit.revision, Some(seq(5)));
}

#[test]
fn the_words_and_choices_for_local_state_and_recovered_edits_are_the_source_editors() {
    let shared = |rig: &mut Rig, message: HostMessage| -> Vec<String> {
        rig.host(message);
        let node = rig.node("local");
        vec![
            format!("local.name = {}", node.name),
            format!(
                "local.description = {}",
                node.state.description.unwrap_or_default()
            ),
        ]
    };
    let bar = |rig: &Rig| -> Vec<String> {
        let tree = semantics(&rig.m);
        let strip = rig.node("strip");
        let buttons: Vec<String> = strip
            .children
            .iter()
            .map(|id| {
                let b = tree.node(id).expect("a button");
                format!("{} [{}]", b.name, b.shortcut.clone().unwrap_or_default())
            })
            .collect();
        vec![
            format!("bar.name = {}", strip.name),
            format!(
                "bar.description = {}",
                strip.state.description.unwrap_or_default()
            ),
            format!("bar.buttons = {}", buttons.join(" | ")),
        ]
    };
    let mut got = vec![];
    for (status, problem) in [
        (LocalStatus::Draft, None),
        (
            LocalStatus::Checkpointed {
                saved_at_ms: 1,
                recovered: false,
            },
            None,
        ),
        (LocalStatus::Draft, Some(("quota", "storage is full"))),
    ] {
        let mut rig = Rig::opened("hello\n");
        got.extend(shared(&mut rig, local(status, problem)));
    }
    let mut rig = Rig::start();
    rig.answer_open_with("hello\n", 1, vec![restored("r1", 1, 0, 0, "X")]);
    got.extend(bar(&rig));
    let mut rig = Rig::start();
    rig.answer_open_with("hello\n", 5, vec![restored("r1", 2, 0, 0, "X")]);
    got.extend(bar(&rig));
    let want = [
        "local.name = edits not yet kept on this device",
        "local.description = edits not yet kept on this device",
        "local.name = kept on this device, not saved to the file",
        "local.description = edits kept on this device, not saved to the file",
        "local.name = not kept: storage is full; only in this page",
        "local.description = not kept on this device (quota): storage is full; the edits are only in this page",
        "bar.name = Edits recovered from this device are in the text. Nothing is sent until you choose.",
        "bar.description = edits recovered from this device are in the text and wait for a choice",
        "bar.buttons = Keep recovered [Alt+J] | Discard recovered [Alt+G] | Copy []",
        "bar.name = Edits recovered from this device were made against revision 2; the file is at revision 5, so they are not placed. Recovered: \"X\"",
        "bar.description = edits recovered from this device were made against revision 2 and are not placed; choose what to do with them",
        "bar.buttons = Take their text [Alt+T] | Keep both [Alt+B] | Copy my text [Alt+Y]",
    ];
    assert_eq!(got, want);
}

#[test]
fn revoked_access_clears_the_document_and_stops_sending() {
    let mut rig = Rig::source("secret text\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    let fx = rig.answer(
        &e,
        Outcome::Refused {
            code: "access_revoked".into(),
            reason: "You were removed from this workspace.".into(),
        },
        None,
    );
    assert!(fx.is_empty());
    let screen = rig.screen();
    assert!(
        screen.contains("You no longer have access to this file"),
        "{screen}"
    );
    assert!(
        screen.contains("You were removed from this workspace."),
        "{screen}"
    );
    assert!(!screen.contains("secret"), "the text is gone: {screen}");
    let tree = format!("{:?}", semantics(&rig.m));
    assert!(!tree.contains("secret"), "{tree}");
    rig.tree_ok();
    let mut fx = rig.key(Key::Char('Y'));
    fx.extend(rig.tick());
    fx.extend(rig.act("markdown.save"));
    fx.extend(rig.host(remote_insert(2, 0, "z")));
    assert!(edits(&fx).is_empty() && of_kind(&fx, EffectKind::DocumentSave).is_empty());
    // A refusal that is not about access leaves the text where it is.
    let mut rig = Rig::source("kept text\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "invalid".into(),
            reason: "no".into(),
        },
        None,
    );
    assert!(rig.text().contains("kept text"));
}

// ---- recovered edits in every mode ------------------------------------------

fn recovered_in(mode: char, base: u64, opened: u64) -> Rig {
    let mut rig = Rig::start();
    rig.answer_open_with(
        "hello\n",
        opened,
        vec![
            restored("r1", base, 0, 0, "X"),
            restored("r2", base, 1, 1, "Y"),
        ],
    );
    rig.alt(mode);
    rig
}

fn bar_titles(rig: &Rig) -> Vec<String> {
    let tree = semantics(&rig.m);
    rig.node("strip")
        .children
        .iter()
        .map(|id| tree.node(id).expect("a button").name.clone())
        .collect()
}

#[test]
fn recovered_edits_are_shown_held_and_chosen_about_in_visual_split_and_preview() {
    for (mode, name) in [('1', "visual"), ('3', "split"), ('4', "preview")] {
        // Placed: the recovered text is what the mode shows, with the bar.
        let mut rig = recovered_in(mode, 1, 1);
        let screen = words_on_screen(&rig, 80);
        assert!(screen.contains("XYhello"), "{name}: {screen}");
        assert!(
            screen.contains("recovered from this device"),
            "{name}: {screen}"
        );
        assert_eq!(
            bar_titles(&rig),
            ["Keep recovered", "Discard recovered", "Copy"],
            "{name}"
        );
        rig.tree_ok();
        // Nothing is sent by typing (where the mode takes it), a tick or a save.
        let mut fx = rig.typed("Q");
        fx.extend(rig.tick());
        fx.extend(rig.act("markdown.save"));
        let (_, rest) = split_keeps(fx);
        assert!(rest.is_empty(), "{name}: {rest:#?}");
        // Switching modes loses neither the held text nor the bar.
        for other in ['2', '1', '3', '4', mode] {
            rig.alt(other);
            assert!(rig.has_node("strip"), "{name} via {other}");
            let screen = words_on_screen(&rig, 80);
            assert!(
                screen.contains("XYhello") || screen.contains("XYQhello"),
                "{name} via {other}: {screen}"
            );
        }
        // Alt+G discards: only the settles go out, the text is the file's.
        let mut rig = recovered_in(mode, 1, 1);
        let fx = rig.alt('g');
        assert_eq!(
            settles(&fx),
            vec!["r1".to_owned(), "r2".to_owned()],
            "{name}"
        );
        none_of(&fx, EffectKind::DocumentEdit);
        assert!(!rig.has_node("strip"), "{name}");
        let screen = words_on_screen(&rig, 80);
        assert!(
            screen.contains("hello") && !screen.contains("XYhello"),
            "{name}: {screen}"
        );
        // Alt+J keeps: the settles first, then the text, once.
        let mut rig = recovered_in(mode, 1, 1);
        let fx = rig.alt('j');
        assert_eq!(
            settles(&fx),
            vec!["r1".to_owned(), "r2".to_owned()],
            "{name}"
        );
        none_of(&fx, EffectKind::DocumentEdit);
        let sent: Vec<Effect> = of_kind(&fx, EffectKind::DocumentSettle)
            .into_iter()
            .cloned()
            .collect();
        for s in &sent[..1] {
            none_of(
                &rig.answer(s, Outcome::Accepted, None),
                EffectKind::DocumentEdit,
            );
        }
        let mut fx = rig.answer(&sent[1], Outcome::Accepted, None);
        fx.extend(rig.tick());
        let mut text = "hello\n".to_owned();
        let mut revision = 1;
        while let Some(e) = edits(&fx).into_iter().next() {
            text = applied(&text, &e);
            revision += 1;
            fx = rig.accept(&e, revision);
            fx.extend(rig.tick());
            assert!(revision < 6, "{name}: sent too often");
        }
        assert_eq!(text, "XYhello\n", "{name}");

        // Not placed: the file's text, the bar with its three choices.
        let mut rig = recovered_in(mode, 2, 5);
        let screen = words_on_screen(&rig, 80);
        assert!(
            screen.contains("hello") && !screen.contains("XYhello"),
            "{name}: {screen}"
        );
        assert!(screen.contains("not placed"), "{name}: {screen}");
        assert_eq!(
            bar_titles(&rig),
            ["Take their text", "Keep both", "Copy my text"],
            "{name}"
        );
        let mut fx = rig.typed("Q");
        fx.extend(rig.tick());
        // Only the typed text is checkpointed (where the mode takes typing):
        // nothing is sent.
        let (keeps, rest) = split_keeps(fx);
        assert!(rest.is_empty(), "{name}: {rest:#?}");
        let typed: Vec<Vec<String>> = if mode == '3' {
            vec![vec!["Q".to_owned()]]
        } else {
            vec![]
        };
        assert_eq!(kept_inserts(&keeps), typed, "{name}");
        for other in ['2', '1', '3', '4', mode] {
            rig.alt(other);
            assert!(rig.has_node("strip"), "{name} via {other}");
        }
        // Unplaced, keep and discard are the conflict's words: Alt+J and Alt+G
        // are refused, Alt+T drops them and Alt+B adds them after the text.
        let mut rig = recovered_in(mode, 2, 5);
        assert!(rig.alt('j').is_empty() && rig.alt('g').is_empty(), "{name}");
        assert!(rig.has_node("strip"), "{name}");
        let fx = rig.alt('t');
        assert_eq!(settles(&fx).len(), 2, "{name}");
        assert!(!rig.has_node("strip"), "{name}");
        let mut rig = recovered_in(mode, 2, 5);
        let fx = rig.alt('b');
        assert_eq!(settles(&fx).len(), 2, "{name}");
        none_of(&fx, EffectKind::DocumentEdit);
    }
}

#[test]
fn the_caret_after_recovery_is_after_the_last_change_in_every_mode_that_has_one() {
    // Source and Split take typing at the source caret.
    for mode in ['2', '3'] {
        let mut rig = recovered_in(mode, 1, 1);
        rig.typed("Q");
        let screen = words_on_screen(&rig, 80);
        assert!(screen.contains("XYQhello"), "mode {mode}: {screen}");
    }
    // Visual has the block the caret is in open, and its caret is there too.
    let mut rig = recovered_in('1', 1, 1);
    let mut fx = rig.typed("Q");
    fx.extend(rig.tick());
    assert!(
        fx.is_empty(),
        "nothing is sent while the edits wait: {fx:#?}"
    );
    let screen = words_on_screen(&rig, 80);
    assert!(screen.contains("XYQhello"), "visual: {screen}");
    assert!(rig.has_node("strip"));
}

// ---- Option chords on a Mac -------------------------------------------------

fn option(c: char) -> KeyInput {
    KeyInput::new(Key::Char(c), Mods::ALT)
}

#[test]
fn takes_chord_answers_for_the_mode_chords_except_the_mode_already_shown() {
    let mut rig = Rig::opened("hello\n");
    assert!(!rig.m.takes_chord(&option('1')), "Visual is shown");
    for c in ['2', '3', '4'] {
        assert!(rig.m.takes_chord(&option(c)), "{c}");
    }
    rig.alt('2');
    assert!(rig.m.takes_chord(&option('1')));
    assert!(!rig.m.takes_chord(&option('2')), "Source is shown");
}

#[test]
fn takes_chord_answers_for_the_checkbox_chord_only_where_it_acts() {
    let mut rig = Rig::opened("- [ ] a\n");
    assert!(rig.m.takes_chord(&option('x')));
    rig.alt('4');
    assert!(!rig.m.takes_chord(&option('x')), "Preview does not edit");
}

#[test]
fn takes_chord_answers_for_conflict_chords_only_while_text_is_held() {
    let mut rig = Rig::source("hello\n");
    for c in ['m', 't', 'b', 'y'] {
        assert!(!rig.m.takes_chord(&option(c)), "{c}: nothing is held");
    }
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "conflict".into(),
            reason: "the document moved on".into(),
        },
        Some(conflict_payload(&e, "hello!\n", 2)),
    );
    for c in ['m', 't', 'b', 'y'] {
        assert!(rig.m.takes_chord(&option(c)), "{c}: text is held");
    }
}

#[test]
fn takes_chord_answers_for_recovered_edit_chords_only_while_they_wait() {
    let rig = recovered_in('2', 1, 1);
    for c in ['j', 'g'] {
        assert!(rig.m.takes_chord(&option(c)), "{c}: an offer is showing");
    }
    let rig = Rig::source("hello\n");
    for c in ['j', 'g'] {
        assert!(!rig.m.takes_chord(&option(c)), "{c}: no offer");
    }
}

#[test]
fn takes_chord_answers_for_resend_only_while_an_edit_is_unknown() {
    let mut rig = Rig::source("hello\n");
    assert!(!rig.m.takes_chord(&option('r')));
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Uncertain {
            reason: "no answer in time".into(),
        },
        None,
    );
    assert!(rig.m.takes_chord(&option('r')));
}

#[test]
fn takes_chord_leaves_a_plain_option_character_to_be_typed() {
    let rig = Rig::source("hello\n");
    for c in ['e', 'n', 'z', '5', '[', 'c'] {
        assert!(!rig.m.takes_chord(&option(c)), "{c}");
    }
}

// ---- AC-51: unsafe content and readable errors --------------------------------

/// A character a terminal or a reader would act on or hide.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{ad}' | '\u{61c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}' | '\u{feff}'
        )
}

/// Every string the panel puts in the semantic tree for this panel.
fn semantic_strings(rig: &Rig) -> Vec<String> {
    let prefix = format!("{}/", rig.id.as_str());
    let tree = semantics(&rig.m);
    let mut out = vec![];
    for n in tree
        .nodes
        .iter()
        .filter(|n| n.id.as_str().starts_with(&prefix))
    {
        out.push(n.name.clone());
        out.extend(n.state.description.clone());
        for a in &n.actions {
            out.extend(a.reason.clone());
        }
    }
    out
}

fn assert_nothing_unsafe(rig: &Rig, what: &str) {
    let screen = rig.screen();
    assert!(
        !screen.chars().any(|c| unsafe_char(c) && c != '\n'),
        "{what}: a cell holds an unsafe character in\n{screen:?}"
    );
    for s in semantic_strings(rig) {
        assert!(
            !s.chars().any(unsafe_char),
            "{what}: a semantic string holds an unsafe character: {s:?}"
        );
    }
}

const HOSTILE_LINKS: &str = "# Links\n\n\
    [one](javascript:alert(1)) \
    [two](data:text/html;base64,PHNjcmlwdD4=) \
    [https://good.example/](https://evil.example/\u{202e}gnp.exe) \
    [four](https://a.example/%1b%5b31m) \
    [five](vbscript:x) [six](file:///etc/passwd) [seven](//evil.example/x)\n";

#[test]
fn going_through_every_hostile_link_and_opening_each_sends_nothing_and_opens_nothing() {
    let mut rig = Rig::start();
    let mut all = rig.answer_open(HOSTILE_LINKS, 1);
    all.extend(rig.alt('4'));
    let panels = rig.m.panel_ids().count();
    for _ in 0..8 {
        all.extend(rig.key(Key::Tab));
        all.extend(rig.mods(Key::Enter, Mods::ALT));
        all.extend(rig.tick());
        assert_nothing_unsafe(&rig, "a hostile link");
    }
    assert!(all.is_empty(), "nothing was sent: {all:#?}");
    assert_eq!(rig.m.panel_ids().count(), panels, "nothing was opened");
}

#[test]
fn the_strip_shows_the_real_target_of_a_link_whose_text_says_another_address() {
    let mut rig = Rig::opened(HOSTILE_LINKS);
    rig.alt('4');
    let mut targets = vec![];
    for _ in 0..8 {
        rig.key(Key::Tab);
        targets.push(rig.node("strip").name);
    }
    let shown = targets.join("\n");
    assert!(shown.contains("javascript:alert(1)"), "{shown}");
    assert!(
        shown.contains("data:text/html;base64,PHNjcmlwdD4="),
        "{shown}"
    );
    assert!(
        shown.contains("https://evil.example/\\u{202e}gnp.exe"),
        "the target, not the text, with the override spelled out: {shown}"
    );
    assert!(!shown.contains("https://good.example/ ("), "{shown}");
    assert!(shown.contains("file:///etc/passwd"), "{shown}");
    assert!(
        shown.matches("is not opened or fetched").count() >= 5,
        "every remote target says so: {shown}"
    );
}

#[test]
fn opening_a_remote_link_says_nothing_was_opened_and_spells_out_hidden_characters() {
    let mut rig = Rig::opened("[x](https://evil.example/\u{202e}gnp.exe)\n");
    rig.alt('4');
    rig.key(Key::Tab);
    let fx = rig.mods(Key::Enter, Mods::ALT);
    assert!(fx.is_empty(), "{fx:#?}");
    let note = rig.node("status").state.description.unwrap_or_default();
    assert!(
        note.contains("nothing is opened or fetched"),
        "the notice is in the status node: {note}"
    );
    assert!(note.contains("\\u{202e}"), "{note}");
    assert_nothing_unsafe(&rig, "the open notice");
}

#[test]
fn text_imitating_an_approval_prompt_makes_no_button_alert_or_dialog() {
    let fake = "# Approval required\n\n**Allow this agent to run `rm -rf /`?**\n\n\
        [Allow] [Deny]  Press Enter to approve.\n\n> Notice: the workspace was saved\n";
    let rig = Rig::opened(fake);
    let tree = semantics(&rig.m);
    let prefix = format!("{}/", rig.id.as_str());
    let roles: Vec<_> = tree
        .nodes
        .iter()
        .filter(|n| n.id.as_str().starts_with(&prefix))
        .map(|n| format!("{:?}", n.role))
        .collect();
    for role in ["Button", "Alert", "Dialog"] {
        assert!(
            !roles.iter().any(|r| r == role),
            "document text made a {role}: {roles:?}"
        );
    }
    let mut rig = rig;
    rig.alt('4');
    let fx = rig.key(Key::Enter);
    assert!(fx.is_empty(), "Enter on the text sent {fx:#?}");
}

#[test]
fn hostile_text_in_a_document_puts_no_unsafe_character_in_a_cell_or_a_semantic_string() {
    let text = "# Head\u{202e}ing\n\nbody \u{1b}[31mred\u{7} \u{202d}rtl\u{2066}\n\n\
        `code\u{1b}]52;c;ZXZpbA==\u{7}`\n\n```\nline\u{1b}[2J\u{9b}x\n```\n";
    let mut rig = Rig::opened(text);
    for mode in ['4', '3', '1', '2'] {
        rig.alt(mode);
        assert_nothing_unsafe(&rig, &format!("mode {mode}"));
    }
}

#[test]
fn a_refused_failed_or_uncertain_open_reads_as_text_in_the_panel_and_its_node() {
    let cases = [
        (
            Outcome::Refused {
                code: "unreadable".into(),
                reason: "you may not read this file".into(),
            },
            [
                "refused to open",
                "you may not read this file",
                "unreadable",
            ],
        ),
        (
            Outcome::Failed {
                reason: "the disk went away".into(),
            },
            ["could not be opened", "the disk went away", ""],
        ),
        (
            Outcome::Uncertain {
                reason: "the owner stopped answering".into(),
            },
            ["Unknown", "the owner stopped answering", ""],
        ),
    ];
    for (outcome, words) in cases {
        let mut rig = Rig::start();
        let open = rig.open.take().unwrap();
        rig.answer(&open, outcome, None);
        rig.tree_ok();
        let screen = rig.screen();
        let name = rig.node("state").name;
        for w in words {
            assert!(screen.contains(w), "{w:?} in the drawn text:\n{screen}");
            assert!(name.contains(w), "{w:?} in the node: {name}");
        }
        for debug in ["Refused {", "Failed {", "Uncertain {", "reason:"] {
            assert!(!screen.contains(debug), "{debug} in\n{screen}");
            assert!(!name.contains(debug), "{debug} in {name}");
        }
        assert!(
            rig.screen().contains(PATH),
            "scoped to the file it is about"
        );
    }
}

#[test]
fn a_hostile_reason_from_the_owner_is_shown_without_its_escapes() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Refused {
            code: "x\u{1b}[31m".into(),
            reason: "Approve? \u{202e}yes\nAllow\u{1b}[2J".into(),
        },
        None,
    );
    assert_nothing_unsafe(&rig, "an owner's reason");
    assert!(rig.node("state").name.contains("Approve?"));
}

#[test]
fn an_unavailable_document_is_told_apart_from_an_empty_one_in_the_text_and_the_node() {
    let empty = Rig::opened("");
    let mut gone = Rig::start();
    let open = gone.open.take().unwrap();
    gone.answer(
        &open,
        Outcome::Failed {
            reason: "the disk went away".into(),
        },
        None,
    );
    empty.tree_ok();
    gone.tree_ok();

    assert!(
        !empty.has_node("state"),
        "an empty document is a document, with no problem node"
    );
    assert_eq!(
        empty
            .node("markdown")
            .state
            .description
            .as_deref()
            .map(|d| d.contains("saved")),
        Some(true)
    );
    assert!(!empty.screen().contains("the disk went away"));
    assert!(!empty.screen().contains("could not be opened"));

    assert!(
        !gone.has_node("markdown"),
        "no document node for an unavailable file"
    );
    let node = gone.node("state");
    assert_eq!(format!("{:?}", node.role), "Alert");
    assert!(node.name.contains("the disk went away"), "{}", node.name);
    assert!(gone.screen().contains("the disk went away"));
}

// ---- the edits held behind an unsettled one are checkpointed ----------------

/// The text each held edit of a keep inserts, in order, with its changes.
/// Each held edit of a keep: its operation and its changes.
type Held = Vec<(String, Vec<(u32, u32, String)>)>;

fn kept_changes(e: &Effect) -> Held {
    let EffectBody::DocumentKeep(keep) = &e.body else {
        panic!("not a keep: {e:?}");
    };
    keep.edits
        .iter()
        .map(|k| {
            (
                k.operation_id.clone(),
                k.edits
                    .iter()
                    .map(|c| (c.start, c.end, c.insert.clone()))
                    .collect(),
            )
        })
        .collect()
}

fn kept_text(e: &Effect) -> Vec<String> {
    kept_changes(e)
        .into_iter()
        .map(|(_, c)| c[0].2.clone())
        .collect()
}

fn unknown_first(rig: &mut Rig, ch: char) -> Effect {
    let e = the_edit(&rig.key(Key::Char(ch)));
    rig.answer(
        &e,
        Outcome::Uncertain {
            reason: "no answer in time".into(),
        },
        None,
    );
    e
}

#[test]
fn three_edits_typed_behind_an_uncertain_first_are_kept_once_in_order_and_the_list_shrinks_as_they_go()
 {
    let mut rig = Rig::source("hello\n");
    let first = unknown_first(&mut rig, 'a');
    none_of(&rig.tick(), EffectKind::DocumentKeep);
    let mut typed = rig.typed("bcd");
    none_of(&typed, EffectKind::DocumentKeep);
    typed.extend(rig.tick());
    let keep = one(&typed, EffectKind::DocumentKeep);
    assert_eq!(keep.revision, None);
    let list = kept_changes(&keep);
    assert_eq!(
        list.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>(),
        [
            vec![(1, 1, "b".to_owned())],
            vec![(2, 2, "c".to_owned())],
            vec![(3, 3, "d".to_owned())],
        ]
    );
    assert_eq!(
        serde_json::to_value(&keep.body).unwrap()["payload"]["edits"][0]["baseRevision"],
        serde_json::json!({"scheme": "seq", "value": 1})
    );
    // Typing between ticks and an unanswered keep: one more, once answered.
    rig.typed("e");
    none_of(&rig.tick(), EffectKind::DocumentKeep);
    let answered = rig.answer(&keep, Outcome::Accepted, None);
    none_of(&answered, EffectKind::DocumentKeep);
    let whole = one(&rig.tick(), EffectKind::DocumentKeep);
    assert_eq!(kept_text(&whole), ["b", "c", "d", "e"]);
    rig.answer(&whole, Outcome::Accepted, None);
    none_of(&rig.tick(), EffectKind::DocumentKeep);
    // The owner had the first: each one goes out, the keep follows the rest.
    let resend = the_edit(&rig.alt('r'));
    assert_eq!(op_id(&resend), op_id(&first));
    let b = the_edit(&rig.accept(&resend, 2));
    let rest = one(&rig.tick(), EffectKind::DocumentKeep);
    assert_eq!(kept_text(&rest), ["c", "d", "e"]);
    rig.answer(&rest, Outcome::Accepted, None);
    let c = the_edit(&rig.accept(&b, 3));
    let d = the_edit(&rig.accept(&c, 4));
    let e = the_edit(&rig.accept(&d, 5));
    rig.accept(&e, 6);
    let cleared = one(&rig.tick(), EffectKind::DocumentKeep);
    assert!(kept_changes(&cleared).is_empty());
    assert_eq!(
        serde_json::to_value(&cleared.body).unwrap(),
        serde_json::json!({"kind": "documentKeep", "payload": {"edits": []}})
    );
    rig.answer(&cleared, Outcome::Accepted, None);
    none_of(&rig.tick(), EffectKind::DocumentKeep);
}

#[test]
fn a_refused_first_gives_a_keep_of_what_the_pane_now_holds() {
    let mut rig = Rig::source("hello\n");
    let a = the_edit(&rig.key(Key::Char('a')));
    rig.typed("bc");
    let before = one(&rig.tick(), EffectKind::DocumentKeep);
    assert_eq!(kept_text(&before), ["b", "c"]);
    rig.answer(&before, Outcome::Accepted, None);
    rig.answer(
        &a,
        Outcome::Refused {
            code: "invalid".into(),
            reason: "the file is locked".into(),
        },
        None,
    );
    let after = one(&rig.tick(), EffectKind::DocumentKeep);
    assert_eq!(kept_text(&after), ["a", "b", "c"]);
    assert_eq!(kept_changes(&after)[0].0, op_id(&a));
}

#[test]
fn a_keep_that_is_refused_failed_or_unknown_says_the_edits_are_not_checkpointed_without_their_content()
 {
    const SECRET: &str = "sk-live-4eC39HqLyjWDarjtT1zdp7dcX9mQ2wZ8";
    for (name, outcome) in [
        (
            "refused",
            Outcome::Refused {
                code: "quota".into(),
                reason: "the device store is full".into(),
            },
        ),
        (
            "failed",
            Outcome::Failed {
                reason: "the device store is full".into(),
            },
        ),
        (
            "unknown",
            Outcome::Uncertain {
                reason: "the device store is full".into(),
            },
        ),
    ] {
        let mut rig = Rig::source("hello\n");
        unknown_first(&mut rig, 'a');
        rig.typed(SECRET);
        let keep = one(&rig.tick(), EffectKind::DocumentKeep);
        rig.answer(&keep, outcome, None);
        let screen = rig
            .screen()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            screen.contains("not checkpointed")
                || screen.contains("if held edits are checkpointed"),
            "{name}: {screen}"
        );
        // The same list is not asked again; the next change asks.
        none_of(&rig.tick(), EffectKind::DocumentKeep);
        rig.typed("z");
        one(&rig.tick(), EffectKind::DocumentKeep);
        rig.tree_ok();
    }
}

#[test]
fn nothing_is_kept_before_an_edit_is_held_or_for_a_list_that_did_not_change() {
    let mut rig = Rig::source("hello\n");
    let e = the_edit(&rig.key(Key::Char('a')));
    none_of(&rig.tick(), EffectKind::DocumentKeep);
    rig.accept(&e, 2);
    none_of(&rig.tick(), EffectKind::DocumentKeep);
    unknown_first(&mut rig, 'b');
    rig.typed("c");
    let keep = one(&rig.tick(), EffectKind::DocumentKeep);
    rig.answer(&keep, Outcome::Accepted, None);
    for _ in 0..3 {
        none_of(&rig.tick(), EffectKind::DocumentKeep);
    }
}

#[test]
fn recovered_edits_are_placed_in_order_before_the_choice_and_kept_edits_are_not_kept_again() {
    let mut rig = Rig::start();
    // The first edit and the two held behind it, as the owner got them back.
    rig.answer_open_with(
        "hello\n",
        1,
        vec![
            restored("r1", 1, 0, 0, "X"),
            restored("r2", 1, 1, 1, "Y"),
            restored("r3", 1, 2, 2, "Z"),
        ],
    );
    rig.alt('2');
    assert!(
        rig.text().starts_with("XYZhello"),
        "everything typed is in the text before the choice: {}",
        rig.text()
    );
    assert!(rig.screen().contains("Keep recovered"), "{}", rig.screen());
    none_of(&rig.tick(), EffectKind::DocumentKeep);
    rig.typed("Q");
    let keep = one(&rig.tick(), EffectKind::DocumentKeep);
    assert_eq!(kept_changes(&keep)[0].1, vec![(3, 3, "Q".to_owned())]);
    assert_eq!(kept_text(&keep), ["Q"]);
    rig.answer(&keep, Outcome::Accepted, None);
    let fx = rig.alt('g');
    assert_eq!(settles(&fx), ["r1", "r2", "r3"]);
    let cleared = one(&rig.tick(), EffectKind::DocumentKeep);
    assert!(kept_changes(&cleared).is_empty());
}

// ---- add selection to chat ----------------------------------------------------

/// A source-mode document with a conversation panel that records references.
fn with_chat(text: &str) -> (Rig, Refs) {
    let refs = Refs::default();
    let mut rig = Rig::start_with(PATH, &Drafts::new(), 500, Some(refs.clone()));
    rig.answer_open(text, 1);
    rig.alt('2');
    (rig, refs)
}

fn pos_of(r: &SourceReference) -> ((u32, u32), (u32, u32)) {
    let range = r.range.as_ref().expect("a range");
    (
        (range.start.line, range.start.character),
        (range.end.line, range.end.character),
    )
}

#[test]
fn add_selection_names_the_path_the_range_and_the_text_without_moving_anything() {
    let (mut rig, refs) = with_chat("hello\nworld\n");
    rig.key(Key::Right);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.mods(Key::Right, Mods::SHIFT);
    let (focus, state) = (rig.m.focus(), rig.state());
    let fx = rig.alt('q');
    assert!(fx.is_empty(), "no effect: {fx:#?}");
    let got = refs.borrow().clone();
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].path, PATH);
    assert_eq!(pos_of(&got[0]), ((0, 1), (0, 3)));
    assert_eq!(got[0].excerpt.as_deref(), Some("el"));
    assert_eq!(got[0].label.as_deref(), Some("a.md:1"));
    assert_eq!(rig.m.focus(), focus, "the keyboard did not move");
    assert_eq!(rig.state(), state, "caret and selection are as they were");
}

#[test]
fn add_selection_counts_columns_in_utf16_units_for_multibyte_and_astral_text() {
    let (mut rig, refs) = with_chat("a\u{e9}\u{1F600}b\n\nx\u{1F600}yz\n");
    rig.key(Key::Right);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.alt('q');
    rig.key(Key::Down);
    rig.key(Key::Down);
    rig.key(Key::Home);
    rig.key(Key::Right);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.alt('q');
    let got = refs.borrow().clone();
    assert_eq!(got.len(), 2);
    assert_eq!(pos_of(&got[0]), ((0, 1), (0, 4)), "e-acute then the emoji");
    assert_eq!(got[0].excerpt.as_deref(), Some("\u{e9}\u{1F600}"));
    assert_eq!(pos_of(&got[1]), ((2, 1), (2, 4)), "the emoji then y");
    assert_eq!(got[1].excerpt.as_deref(), Some("\u{1F600}y"));
}

#[test]
fn add_selection_with_nothing_selected_refers_the_carets_line() {
    let (mut rig, refs) = with_chat("one\ntwo\nthree\n");
    rig.key(Key::Down);
    rig.key(Key::Right);
    rig.alt('q');
    let got = refs.borrow().clone();
    assert_eq!(got.len(), 1);
    assert_eq!(pos_of(&got[0]), ((1, 0), (1, 3)));
    assert_eq!(got[0].excerpt.as_deref(), Some("two"));
}

#[test]
fn add_selection_in_visual_mode_refers_the_line_without_an_open_block() {
    let refs = Refs::default();
    let mut rig = Rig::start_with(PATH, &Drafts::new(), 500, Some(refs.clone()));
    rig.answer_open("one\n\ntwo\n", 1);
    assert_eq!(rig.mode(), "visual");
    let fx = rig.alt('q');
    assert!(fx.is_empty(), "{fx:#?}");
    let got = refs.borrow().clone();
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].path, PATH);
    assert!(got[0].range.is_some());
}

#[test]
fn add_selection_is_disabled_with_its_reason_with_no_document_and_an_agent_may_use_it() {
    let refs = Refs::default();
    let mut rig = Rig::start_with(PATH, &Drafts::new(), 500, Some(refs.clone()));
    let node = rig.node("state");
    let a = node
        .actions
        .iter()
        .find(|a| a.id.as_str() == "markdown.addSelection")
        .expect("listed even with no document");
    assert!(!a.enabled && a.reason.is_some(), "{a:?}");
    rig.alt('q');
    assert!(refs.borrow().is_empty());

    rig.answer_open("hello\n", 1);
    let fx = rig.send(Msg::Action {
        id: ActionId::new("markdown.addSelection"),
        actor: Actor::Agent {
            run_id: "r1".into(),
        },
    });
    assert!(fx.is_empty());
    assert_eq!(refs.borrow().len(), 1, "an agent's action refers too");
}

// ---- follow the agent ---------------------------------------------------------

/// `n` one-line paragraphs, `"Lxxx\n\n"` (6 scalars) each.
fn paragraphs(n: usize) -> String {
    (0..n).map(|i| format!("L{i:03}\n\n")).collect()
}

impl Rig {
    /// Give the keyboard to the Files panel and follow run `r1`.
    fn follow(&mut self) {
        self.send(Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        });
        self.send(Msg::Host(HostMessage::FollowedRuns {
            runs: vec!["r1".into()],
        }));
        self.send(Msg::Action {
            id: ActionId::new("follow.resume"),
            actor: Actor::Human,
        });
    }

    /// The agent inserts "x" at `at` (in `unit`) in what is revision `rev`.
    fn agent_edit(&mut self, rev: u64, at: u32, unit: CoordinateUnit) -> Vec<Effect> {
        self.host(HostMessage::DocumentChanged {
            resource: doc(),
            revision: seq(rev),
            actor: "theorem:run:r1".into(),
            operation_id: None,
            unit,
            edits: vec![CoreChange {
                start: at,
                end: at,
                insert: "x".into(),
            }],
        })
    }
}

#[test]
fn a_followed_edit_scrolls_the_source_to_it_and_leaves_caret_and_selection_alone() {
    let mut rig = Rig::source(&paragraphs(300));
    rig.key(Key::Right);
    rig.mods(Key::Right, Mods::SHIFT);
    rig.follow();
    let before = rig.state()["view"].clone();
    assert!(rig.screen().contains("L000"));
    let fx = rig.agent_edit(2, 6 * 100, CoordinateUnit::Utf16);
    assert!(fx.is_empty(), "no effect: {fx:#?}");
    let s = rig.screen();
    assert!(s.contains("L100"), "{s}");
    assert!(!s.contains("L000"), "{s}");
    let after = rig.state()["view"].clone();
    for k in ["anchor", "head"] {
        assert_eq!(before["selection"][k], after["selection"][k], "{k}");
    }
    assert!(
        rig.m.focus().panel.as_ref() != Some(&rig.id),
        "the keyboard is elsewhere"
    );
}

#[test]
fn a_followed_edit_scrolls_a_reading_view_to_its_block() {
    let mut rig = Rig::opened(&paragraphs(300));
    rig.alt('4');
    rig.follow();
    assert!(rig.screen().contains("L000"));
    let fx = rig.agent_edit(2, 6 * 150, CoordinateUnit::Utf16);
    assert!(fx.is_empty(), "no effect: {fx:#?}");
    let s = rig.screen();
    assert!(s.contains("L150"), "{s}");
    assert!(!s.contains("L000"), "{s}");
}

#[test]
fn a_followed_edit_keeps_the_block_being_typed_in_visual_and_its_typing() {
    let mut rig = Rig::opened(&paragraphs(300));
    rig.typed("Z");
    let before = rig.state()["view"].clone();
    rig.follow();
    let fx = rig.agent_edit(2, 6 * 150, CoordinateUnit::Utf16);
    assert!(fx.is_empty(), "no effect: {fx:#?}");
    assert_eq!(rig.state()["view"]["open"], before["open"], "unsent typing");
    assert_eq!(rig.state()["view"]["selection"], before["selection"]);
    assert!(rig.screen().contains("Z"), "the block being typed in stays");
}

#[test]
fn a_followed_offset_past_the_end_goes_to_the_end() {
    let mut rig = Rig::source(&paragraphs(300));
    rig.follow();
    rig.agent_edit(2, 1_000_000, CoordinateUnit::Utf16);
    assert!(rig.screen().contains("L299"), "{}", rig.screen());
}

#[test]
fn a_followed_offset_in_utf16_units_and_bytes_lands_on_the_right_line_in_multibyte_text() {
    // Each paragraph is 7 UTF-16 units (an emoji is two), 6 scalars, 9 bytes.
    let text: String = (0..300).map(|i| format!("\u{1F600}{i:03}\n\n")).collect();
    let mut rig = Rig::source(&text);
    rig.follow();
    rig.agent_edit(2, 7 * 200, CoordinateUnit::Utf16);
    let s = rig.screen();
    assert!(s.contains("200"), "{s}");
    assert!(!s.contains("233"), "scalars would have gone here: {s}");
    let mut rig = Rig::source(&text);
    rig.follow();
    rig.agent_edit(2, 9 * 100, CoordinateUnit::Utf8Bytes);
    let s = rig.screen();
    assert!(s.contains("100"), "{s}");
}

#[test]
fn a_followed_offset_that_arrives_before_the_document_waits_and_a_later_one_replaces_it() {
    // A panel that comes back from a saved layout in Source, still asking the
    // owner for its text.
    let mut first = Rig::source("short\n");
    first.alt('2');
    let layout = first.m.document();
    let mut rig = Rig::start_file("b.txt", &Drafts::new(), 500);
    let _ = rig.m.restore(layout);
    rig.id = rig
        .m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "markdown")
        .map(|(id, _)| id.clone())
        .expect("the restored panel");
    rig.kind = "markdown".into();
    let fx = rig.tick();
    rig.open = of_kind(&fx, EffectKind::DocumentOpen)
        .into_iter()
        .find(|e| e.resource == doc())
        .cloned();
    rig.follow();
    rig.agent_edit(2, 6 * 250, CoordinateUnit::Utf16);
    rig.agent_edit(2, 6 * 100, CoordinateUnit::Utf16);
    rig.answer_open(&paragraphs(300), 1);
    let s = rig.screen();
    assert!(s.contains("L100"), "{s}");
    assert!(!s.contains("L250"), "{s}");
}
