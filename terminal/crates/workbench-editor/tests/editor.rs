//! The editor panel driven through a real root, as the Files panel is: the
//! panel is opened by the Files panel, keys and pointer go in as `Msg`, the
//! owner's answers go in as completions and host messages, and effects and
//! cells come out.

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use theorem_workbench_core::Composition;
use theorem_workbench_core::builtin;
use theorem_workbench_core::completion::{
    ClipboardText, Completion, CompletionPayload, DocumentConflicted, DocumentCurrent,
    DocumentEdited, DocumentOpened, DocumentSaved, FileEntry, FileKind, FileListing, LanguagePlan,
    Outcome, PendingEdit, PendingState,
};
use theorem_workbench_core::effect::{
    CoordinateUnit, Effect, EffectBody, EffectKind, TextChange as CoreChange,
};
use theorem_workbench_core::host::{HostMessage, TokenSpan};
use theorem_workbench_core::ids::{ActionId, Actor, PanelInstanceId, ResourceRef, Revision};
use theorem_workbench_core::keys::{KeyTable, Overrides, Platform};
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::results::{
    CompletionItem, Finding, LanguageCompletions, LanguageDiagnostics, LanguageHover,
    LanguageLocations, LocationRow, Position, Range, Severity, SpanEncoding,
};
use theorem_workbench_core::semantics::NodeId;
use theorem_workbench_core::{
    Button, DockMsg, Model, Msg, PanelFactories, Pointer, PointerKind, Theme, ViewCtx, semantics,
    update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};
use theorem_workbench_editor::{Drafts, register_with};
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

const PATH: &str = "a.txt";

fn ws() -> ResourceRef {
    ResourceRef::Workspace {
        workspace: "w".into(),
    }
}

fn doc() -> ResourceRef {
    ResourceRef::Document {
        workspace: "w".into(),
        resource_id: PATH.into(),
    }
}

fn seq(n: u64) -> Revision {
    Revision::Seq(n)
}

struct Rig {
    m: Model,
    drafts: Drafts,
    id: PanelInstanceId,
    /// The effect that asked for the document, until it is answered.
    open: Option<Effect>,
}

fn model(caps: &[&'static str], drafts: &Drafts) -> Model {
    let mut factories = PanelFactories::new();
    theorem_workbench_panels::register(&mut factories);
    register_with(&mut factories, drafts.clone());
    let mut registry = builtin::registry();
    theorem_workbench_editor::extend_registry(&mut registry)
        .expect("the editor's actions register beside the built-in ones");
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
            area: Rect::new(0, 0, 400, 50),
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

impl Rig {
    /// The Files panel opens `a.txt`; the editor asks the owner for it.
    fn start() -> Self {
        Self::start_with(&CAPS, &Drafts::new())
    }

    fn start_with(caps: &[&'static str], drafts: &Drafts) -> Self {
        let mut m = model(caps, drafts);
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
                FileEntry::new("src", FileKind::Directory),
                FileEntry::new(PATH, FileKind::File),
            ],
            partial: false,
        }));
        update(&mut m, Msg::Completion(c));
        for ch in PATH.chars() {
            update(&mut m, Msg::Key(KeyInput::new(Key::Char(ch), Mods::NONE)));
        }
        update(&mut m, Msg::Key(KeyInput::new(Key::Enter, Mods::NONE)));
        let id = m
            .panel_ids()
            .find(|(_, k)| k.as_str() == "document")
            .map(|(id, _)| id.clone())
            .expect("the Files panel opened a document panel");
        let mut rig = Self {
            m,
            drafts: drafts.clone(),
            id,
            open: None,
        };
        let fx = rig.tick();
        rig.open = of_kind(&fx, EffectKind::DocumentOpen)
            .first()
            .map(|e| (*e).clone());
        rig
    }

    /// The owner opens the document at revision 1 with `text`.
    fn opened(text: &str) -> Self {
        let mut rig = Self::start();
        rig.answer_open(text, 1, true);
        rig
    }

    fn answer_open(&mut self, text: &str, revision: u64, clean: bool) -> Vec<Effect> {
        let open = self.open.take().expect("an open is waiting");
        let c = Completion::new(open.id, doc(), Outcome::Accepted).with_payload(
            CompletionPayload::DocumentOpened(DocumentOpened {
                text: text.into(),
                revision: seq(revision),
                saved_revision: None,
                dirty: !clean,
                read_only: None,
                pending: vec![],
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

    /// Type each character as its own key.
    fn typed(&mut self, text: &str) -> Vec<Effect> {
        let mut out = vec![];
        for c in text.chars() {
            out.extend(match c {
                '\n' => self.key(Key::Enter),
                '\t' => self.key(Key::Tab),
                c => self.key(Key::Char(c)),
            });
        }
        out
    }

    fn chord(&mut self, c: char) -> Vec<Effect> {
        self.mods(Key::Char(c), Mods::CTRL)
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

    /// The owner accepts an edit as `revision`.
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

    fn body(&self) -> Rect {
        let frame = self.m.frame().expect("solved");
        frame
            .groups
            .iter()
            .find(|g| g.active.as_ref().map(|a| a.0.as_str()) == Some(self.id.as_str()))
            .expect("the editor's group")
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

    /// The rows as text, a wide glyph once and not again for the cell it covers.
    fn rows(&self, width: u16, height: u16) -> Vec<String> {
        let buf = self.draw(width, height);
        (0..height)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < width {
                    let symbol = buf[(x, y)].symbol();
                    row.push_str(symbol);
                    x += unicode_width(symbol).max(1);
                }
                row.trim_end().to_owned()
            })
            .collect()
    }

    fn screen(&self) -> String {
        let b = self.body();
        self.rows(b.width, b.height).join("\n")
    }

    /// The status line is the last row of the body; a notice that does not
    /// fit beside it wraps onto up to three rows above it.
    fn status(&self) -> String {
        let b = self.body();
        let mut rows = self.rows(b.width, b.height);
        let last = rows.pop().unwrap();
        let tree = semantics(&self.m);
        match tree.node(&NodeId::new(format!("{}/notice", self.id.as_str()))) {
            Some(n) => {
                let (y, h) = (
                    usize::from(n.rect.y.saturating_sub(b.y)),
                    usize::from(n.rect.height),
                );
                let above = rows[y..y + h].join(" ");
                format!("{last} {above}")
            }
            None => last,
        }
    }

    fn state(&self) -> serde_json::Value {
        self.m
            .panel(&self.id)
            .map(|p| p.serialize())
            .unwrap_or_default()
    }

    fn click(&mut self, x: u16, y: u16, clicks: u8) -> Vec<Effect> {
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

    fn tree_ok(&self) {
        let tree = semantics(&self.m);
        tree.validate().expect("the semantic tree is valid");
    }
}

fn unicode_width(s: &str) -> u16 {
    s.width() as u16
}

#[test]
fn the_files_panel_opens_the_editor_and_the_editor_asks_the_owner_for_the_document() {
    let rig = Rig::start();
    let open = rig.open.as_ref().expect("a document open was emitted");
    assert_eq!(open.resource, doc());
    assert!(matches!(open.body, EffectBody::DocumentOpen(_)));
    assert!(rig.screen().contains("Opening"), "{}", rig.screen());
    rig.tree_ok();
}

// ---- helpers for reading what came out -----------------------------------

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

fn utf16(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

impl Rig {
    /// The text of the first nine lines as drawn, without the gutter.
    fn text(&self) -> String {
        let tree = semantics(&self.m);
        let node = tree
            .node(&NodeId::new(format!("{}/text", self.id.as_str())))
            .expect("the text node");
        let b = self.body();
        let rows = self.rows(b.width, b.height);
        let mut lines: Vec<String> = rows
            .iter()
            .take(usize::from(node.rect.height))
            .map(|r| r.get(2..).unwrap_or("").to_owned())
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

    fn binding(&self) -> theorem_workbench_core::stale::Binding {
        self.m.panel(&self.id).unwrap().binding().unwrap()
    }

    fn selection_marked(&self, width: u16, height: u16) -> Vec<String> {
        let buf = self.draw(width, height);
        (0..height)
            .map(|y| {
                let mut row = String::new();
                let mut open = false;
                let mut x = 0;
                while x < width {
                    let cell = &buf[(x, y)];
                    let m = cell.modifier;
                    let selected = m.contains(Modifier::UNDERLINED);
                    if selected && !open {
                        row.push('{');
                        open = true;
                    } else if !selected && open {
                        row.push('}');
                        open = false;
                    }
                    row.push_str(cell.symbol());
                    x += unicode_width(cell.symbol()).max(1);
                }
                if open {
                    row.push('}');
                }
                row.trim_end().to_owned()
            })
            .collect()
    }
}

// ---- open ----------------------------------------------------------------

#[test]
fn the_owners_text_is_shown_with_line_numbers_and_a_status_line() {
    let rig = Rig::opened("hello\nworld\n");
    let rows = rig.rows(rig.body().width, rig.body().height);
    assert_eq!(rows[0], "1 hello");
    assert_eq!(rows[1], "2 world");
    let status = rig.status();
    assert!(status.starts_with("a.txt"), "{status}");
    assert!(status.contains("Ln 1, Col 1 (graphemes)"), "{status}");
    assert!(status.contains("r1"), "{status}");
    assert!(!status.contains("modified"), "{status}");
    rig.tree_ok();
}

#[test]
fn a_binary_file_shows_the_owners_reason_and_only_the_actions_that_apply() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Refused {
            code: "binary".into(),
            reason: "a.txt looks like a binary file".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(
        screen.contains("a.txt looks like a binary file"),
        "{screen}"
    );
    assert!(screen.contains("[Close"), "{screen}");
    assert!(!screen.contains("[Try again"), "{screen}");
    rig.tree_ok();
    let alert = rig.node("state");
    assert!(
        alert
            .actions
            .iter()
            .any(|a| a.id.as_str() == "document.close" && a.enabled)
    );
    let retry = alert
        .actions
        .iter()
        .find(|a| a.id.as_str() == "document.retry");
    assert!(retry.is_none(), "a binary file has no retry");
}

#[test]
fn a_refusal_that_may_pass_offers_a_retry_that_asks_again() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Refused {
            code: "permission_denied".into(),
            reason: "you may not read a.txt".into(),
        },
        None,
    );
    assert!(rig.screen().contains("[Try again"), "{}", rig.screen());
    let fx = rig.key(Key::Enter);
    let again = one(&fx, EffectKind::DocumentOpen);
    assert_eq!(again.resource, doc());
    assert!(rig.screen().contains("Opening"));
}

#[test]
fn an_uncertain_open_is_shown_as_unknown_and_never_asked_again() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Uncertain {
            reason: "the connection dropped".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(screen.contains("Unknown"), "{screen}");
    assert!(screen.contains("the connection dropped"), "{screen}");
    assert!(!screen.contains("[Try again"), "{screen}");
    let fx = rig.key(Key::Enter);
    none_of(&fx, EffectKind::DocumentOpen);
    let fx = rig.tick();
    none_of(&fx, EffectKind::DocumentOpen);
    rig.tree_ok();
}

#[test]
fn a_failed_open_can_be_retried_and_the_second_answer_shows_the_text() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Failed {
            reason: "the host is busy".into(),
        },
        None,
    );
    assert!(rig.screen().contains("the host is busy"));
    let fx = rig.key(Key::Enter);
    rig.open = Some(one(&fx, EffectKind::DocumentOpen));
    rig.answer_open("fine\n", 1, true);
    assert!(rig.screen().starts_with("1 fine"), "{}", rig.screen());
}

// ---- sending edits ---------------------------------------------------------

#[test]
fn typing_sends_one_edit_at_a_time_in_order_with_the_base_revision_and_an_operation_id() {
    let mut rig = Rig::opened("hello\n");
    let first = the_edit(&rig.key(Key::Char('a')));
    assert_eq!(first.revision, Some(seq(1)));
    assert_eq!(changes(&first), vec![(0, 0, "a".to_owned())]);
    let EffectBody::DocumentEdit(body) = &first.body else {
        unreachable!()
    };
    assert_eq!(body.unit, CoordinateUnit::Utf16);
    assert!(rig.status().contains("sending"), "{}", rig.status());

    let held = rig.key(Key::Char('b'));
    none_of(&held, EffectKind::DocumentEdit);

    let next = the_edit(&rig.accept(&first, 2));
    assert_eq!(next.revision, Some(seq(2)));
    assert_eq!(changes(&next), vec![(1, 1, "b".to_owned())]);
    assert_ne!(op_id(&first), op_id(&next));

    let end = rig.accept(&next, 3);
    none_of(&end, EffectKind::DocumentEdit);
    assert!(!rig.status().contains("sending"));
    assert!(rig.status().contains("modified"));
    assert_eq!(rig.binding().revision, Some(seq(3)));
}

#[test]
fn an_acknowledgement_on_the_host_stream_advances_like_the_completion() {
    let mut rig = Rig::opened("hello\n");
    let first = the_edit(&rig.key(Key::Char('a')));
    rig.key(Key::Char('b'));
    let fx = rig.host(HostMessage::DocumentAcknowledged {
        resource: doc(),
        revision: seq(2),
        operation_id: op_id(&first),
    });
    let next = the_edit(&fx);
    assert_eq!(next.revision, Some(seq(2)));
    // The completion for the same edit then arrives: nothing is sent twice.
    let fx = rig.accept(&first, 2);
    none_of(&fx, EffectKind::DocumentEdit);
}

#[test]
fn a_refused_edit_keeps_the_text_shows_the_reason_and_waits_for_a_choice() {
    let mut rig = Rig::opened("hello\n");
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
    assert!(rig.status().contains("modified"));
    // Typing on does not send behind the held edit.
    let fx = rig.key(Key::Char('Y'));
    none_of(&fx, EffectKind::DocumentEdit);
    rig.tree_ok();
}

#[test]
fn keeping_my_text_after_a_refusal_sends_it_again_and_settles_the_held_one() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "invalid".into(),
            reason: "try later".into(),
        },
        None,
    );
    let fx = rig.mods(Key::Char('m'), Mods::ALT);
    let again = the_edit(&fx);
    assert_eq!(changes(&again), vec![(0, 0, "X".to_owned())]);
    assert_ne!(op_id(&again), op_id(&e), "a new operation id");
    let settle = one(&fx, EffectKind::DocumentSettle);
    let EffectBody::DocumentSettle(s) = &settle.body else {
        unreachable!()
    };
    assert_eq!(s.operation_id, op_id(&e));
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

fn conflicted(rig: &mut Rig) -> Effect {
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "conflict".into(),
            reason: "the document moved on".into(),
        },
        Some(conflict_payload(&e, "hello!\n", 2)),
    );
    e
}

#[test]
fn a_conflict_shows_both_sides_and_is_never_resolved_by_itself() {
    let mut rig = Rig::opened("hello\n");
    let e = conflicted(&mut rig);
    let screen = rig.screen();
    assert!(screen.contains("Mine: \"X\""), "{screen}");
    assert!(screen.contains("Theirs: \"!\""), "{screen}");
    for button in [
        "[Keep my text Alt+M]",
        "[Take their text Alt+T]",
        "[Keep both Alt+B]",
    ] {
        assert!(screen.contains(button), "{button} in\n{screen}");
    }
    // Both are in the text: theirs, with mine on top.
    assert!(rig.text().starts_with("Xhello!"), "{}", rig.text());
    // Time passing does not choose.
    let fx = rig.tick();
    none_of(&fx, EffectKind::DocumentEdit);
    none_of(&fx, EffectKind::DocumentSettle);
    assert!(rig.screen().contains("[Keep my text"));
    let alert = rig.node("strip");
    let ids: Vec<_> = alert
        .actions
        .iter()
        .map(|a| a.id.as_str().to_owned())
        .collect();
    assert!(ids.contains(&"document.keepMine".to_owned()), "{ids:?}");
    assert!(ids.contains(&"document.takeTheirs".to_owned()), "{ids:?}");
    assert!(ids.contains(&"document.keepBoth".to_owned()), "{ids:?}");
    rig.tree_ok();
    let _ = e;
}

#[test]
fn keeping_mine_in_a_conflict_sends_it_on_top_of_their_revision() {
    let mut rig = Rig::opened("hello\n");
    let e = conflicted(&mut rig);
    let fx = rig.mods(Key::Char('m'), Mods::ALT);
    let again = the_edit(&fx);
    assert_eq!(again.revision, Some(seq(2)));
    assert_eq!(changes(&again), vec![(0, 0, "X".to_owned())]);
    let settle = one(&fx, EffectKind::DocumentSettle);
    let EffectBody::DocumentSettle(s) = &settle.body else {
        unreachable!()
    };
    assert_eq!(s.operation_id, op_id(&e));
    assert!(!rig.screen().contains("[Keep my text"));
}

#[test]
fn taking_theirs_drops_my_edit_and_keeps_my_text_to_copy() {
    let mut rig = Rig::opened("hello\n");
    conflicted(&mut rig);
    let fx = rig.mods(Key::Char('t'), Mods::ALT);
    none_of(&fx, EffectKind::DocumentEdit);
    one(&fx, EffectKind::DocumentSettle);
    assert_eq!(rig.text(), "hello!");
    let screen = rig.screen();
    assert!(screen.contains("Your text is kept"), "{screen}");
    let fx = rig.mods(Key::Char('y'), Mods::ALT);
    let write = one(&fx, EffectKind::ClipboardWrite);
    let EffectBody::ClipboardWrite(w) = &write.body else {
        unreachable!()
    };
    assert_eq!(w.text, "Xhello!\n", "the whole text from before");
}

#[test]
fn keeping_both_puts_my_text_next_to_theirs() {
    let mut rig = Rig::opened("hello\n");
    conflicted(&mut rig);
    let fx = rig.mods(Key::Char('b'), Mods::ALT);
    one(&fx, EffectKind::DocumentSettle);
    let sent = the_edit(&fx);
    assert_eq!(sent.revision, Some(seq(2)));
    assert!(
        rig.text().contains('X') && rig.text().contains("hello!"),
        "{}",
        rig.text()
    );
}

#[test]
fn an_uncertain_edit_blocks_what_follows_and_is_resent_only_when_asked() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Uncertain {
            reason: "the connection dropped".into(),
        },
        None,
    );
    assert!(
        rig.screen()
            .contains("Unknown whether the owner took an edit")
    );
    assert!(rig.status().contains("edit unknown"), "{}", rig.status());
    let fx = rig.key(Key::Char('Y'));
    none_of(&fx, EffectKind::DocumentEdit);
    let fx = rig.tick();
    none_of(&fx, EffectKind::DocumentEdit);
    let fx = rig.mods(Key::Char('r'), Mods::ALT);
    let again = the_edit(&fx);
    assert_eq!(
        op_id(&again),
        op_id(&e),
        "the same id, so the owner takes it once"
    );
    // The owner says it had it: the held edit after it goes out next.
    let next = the_edit(&rig.accept(&again, 2));
    assert_eq!(changes(&next), vec![(1, 1, "Y".to_owned())]);
}

// ---- remote changes and undo -----------------------------------------------

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

#[test]
fn a_remote_change_is_rebased_under_an_edit_in_flight() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.host(remote_insert(2, 5, "!"));
    assert_eq!(rig.text(), "Xhello!");
    assert_eq!(rig.binding().revision, Some(seq(2)));
    // The owner took mine on top of theirs.
    rig.accept(&e, 3);
    assert_eq!(rig.text(), "Xhello!");
    assert_eq!(rig.binding().revision, Some(seq(3)));
}

#[test]
fn undo_and_redo_survive_a_remote_change() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    rig.host(remote_insert(3, 0, ">> "));
    assert_eq!(rig.text(), ">> Xhello");
    let undo = the_edit(&rig.chord('z'));
    assert_eq!(
        changes(&undo),
        vec![(3, 4, String::new())],
        "X, where it moved to"
    );
    assert_eq!(rig.text(), ">> hello");
    rig.accept(&undo, 4);
    rig.host(remote_insert(5, 0, "# "));
    let redo = the_edit(&rig.mods(Key::Char('Z'), Mods::CTRL));
    assert_eq!(changes(&redo), vec![(5, 5, "X".to_owned())]);
    assert_eq!(rig.text(), "# >> Xhello");
}

#[test]
fn a_resync_replaces_the_text_under_pending_edits() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.host(HostMessage::DocumentResync {
        resource: doc(),
        revision: seq(4),
        text: "hello there\n".into(),
    });
    assert_eq!(rig.text(), "Xhello there");
    assert_eq!(rig.binding().revision, Some(seq(4)));
    rig.accept(&e, 5);
    assert_eq!(rig.binding().revision, Some(seq(5)));
}

#[test]
fn a_gap_in_the_stream_holds_edits_until_the_owner_resyncs() {
    let mut rig = Rig::opened("hello\n");
    rig.host(remote_insert(4, 0, "x"));
    assert!(rig.status().contains("out of sync"), "{}", rig.status());
    let fx = rig.key(Key::Char('Z'));
    none_of(&fx, EffectKind::DocumentEdit);
    let fx = rig.host(HostMessage::DocumentResync {
        resource: doc(),
        revision: seq(4),
        text: "xhello\n".into(),
    });
    let e = the_edit(&fx);
    assert_eq!(e.revision, Some(seq(4)));
    assert!(!rig.status().contains("out of sync"));
}

// ---- save ------------------------------------------------------------------

#[test]
fn a_clean_document_has_nothing_to_save_and_says_so() {
    let mut rig = Rig::opened("hello\n");
    let fx = rig.chord('s');
    none_of(&fx, EffectKind::DocumentSave);
    assert!(rig.status().contains("nothing to save"), "{}", rig.status());
    let save = rig
        .node("text")
        .actions
        .into_iter()
        .find(|a| a.id.as_str() == "document.save")
        .unwrap();
    assert!(!save.enabled);
    assert!(save.reason.unwrap().contains("nothing to save"));
}

#[test]
fn saving_sends_the_accepted_revision_and_clears_the_modified_flag_when_the_owner_says_so() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    assert!(rig.status().contains("modified"));
    let save = one(&rig.chord('s'), EffectKind::DocumentSave);
    assert_eq!(save.revision, Some(seq(2)));
    assert!(rig.status().contains("saving"), "{}", rig.status());
    rig.answer(
        &save,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentSaved(DocumentSaved {
            revision: seq(2),
        })),
    );
    assert!(!rig.status().contains("modified"), "{}", rig.status());
    assert!(!rig.status().contains("saving"));
}

#[test]
fn saving_while_an_edit_is_in_flight_waits_for_it_and_says_so() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    let fx = rig.chord('s');
    none_of(&fx, EffectKind::DocumentSave);
    assert!(rig.status().contains("save waits"), "{}", rig.status());
    let fx = rig.accept(&e, 2);
    let save = one(&fx, EffectKind::DocumentSave);
    assert_eq!(
        save.revision,
        Some(seq(2)),
        "the save is of what the owner accepted"
    );
}

#[test]
fn a_save_of_revision_n_does_not_clear_the_dirt_of_edits_typed_after_it() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    let save = one(&rig.chord('s'), EffectKind::DocumentSave);
    let y = the_edit(&rig.key(Key::Char('Y')));
    rig.answer(
        &save,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentSaved(DocumentSaved {
            revision: seq(2),
        })),
    );
    assert!(
        rig.status().contains("modified"),
        "Y is not saved: {}",
        rig.status()
    );
    rig.accept(&y, 3);
    assert!(rig.status().contains("modified"), "{}", rig.status());
    let node = rig.node("text");
    assert!(node.state.description.unwrap().contains("modified"));
}

#[test]
fn a_refused_save_keeps_the_modified_flag_and_shows_the_reason() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    let save = one(&rig.chord('s'), EffectKind::DocumentSave);
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
}

#[test]
fn an_uncertain_save_is_shown_as_unknown_and_the_document_stays_modified() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    let save = one(&rig.chord('s'), EffectKind::DocumentSave);
    rig.answer(
        &save,
        Outcome::Uncertain {
            reason: "no answer".into(),
        },
        None,
    );
    assert!(rig.status().contains("save unknown"), "{}", rig.status());
    assert!(rig.status().contains("modified"));
    // Asking again is the person's call.
    one(&rig.chord('s'), EffectKind::DocumentSave);
}

#[test]
fn the_owner_saying_it_saved_on_the_stream_clears_the_flag() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    rig.host(HostMessage::DocumentSaved {
        resource: doc(),
        revision: seq(2),
    });
    assert!(!rig.status().contains("modified"), "{}", rig.status());
}

#[test]
fn a_file_changed_on_disk_offers_both_ways_and_reconciles_through_the_owner() {
    let mut rig = Rig::opened("hello\n");
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
    let fx = rig.mods(Key::Char('d'), Mods::ALT);
    let rec = one(&fx, EffectKind::DocumentReconcile);
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
    assert!(
        !rig.status().contains("modified"),
        "the disk is what is saved"
    );
    assert!(!rig.screen().contains("changed on disk"));
}

// ---- search ----------------------------------------------------------------

#[test]
fn search_counts_matches_steps_both_ways_and_toggles_case() {
    let mut rig = Rig::opened("alpha beta alpha\nALPHA\n");
    rig.chord('f');
    rig.typed("alpha");
    let bar = rig.screen().lines().next().unwrap().to_owned();
    assert!(bar.starts_with("Find alpha"), "{bar}");
    assert!(bar.contains("1 of 3"), "{bar}");
    rig.key(Key::F3);
    assert!(rig.screen().lines().next().unwrap().contains("2 of 3"));
    rig.key(Key::F3);
    rig.key(Key::F3);
    assert!(
        rig.screen().lines().next().unwrap().contains("1 of 3"),
        "wraps"
    );
    rig.mods(Key::F3, Mods::SHIFT);
    assert!(
        rig.screen().lines().next().unwrap().contains("3 of 3"),
        "wraps back"
    );
    rig.mods(Key::Char('c'), Mods::ALT);
    assert!(rig.screen().lines().next().unwrap().contains("(case)"));
    assert!(
        rig.screen().lines().next().unwrap().contains("2 matches"),
        "{}",
        rig.screen()
    );
    rig.key(Key::Esc);
    assert!(!rig.screen().contains("Find"));
    rig.tree_ok();
}

#[test]
fn search_matches_are_found_again_when_the_revision_changes() {
    let mut rig = Rig::opened("alpha\n");
    rig.chord('f');
    rig.typed("alpha");
    assert!(rig.screen().lines().next().unwrap().contains("1 of 1"));
    rig.host(remote_insert(2, 0, "alpha "));
    let bar = rig.screen().lines().next().unwrap().to_owned();
    assert!(bar.contains("of 2"), "{bar}");
    rig.typed("z");
    assert!(rig.screen().lines().next().unwrap().contains("no matches"));
}

// ---- clipboard -------------------------------------------------------------

#[test]
fn copy_goes_through_the_clipboard_effect_and_says_so_when_accepted() {
    let mut rig = Rig::opened("hello\n");
    rig.chord('a');
    let write = one(&rig.chord('c'), EffectKind::ClipboardWrite);
    let EffectBody::ClipboardWrite(w) = &write.body else {
        unreachable!()
    };
    assert_eq!(w.text, "hello\n");
    assert_eq!(write.resource, ResourceRef::None);
    rig.answer(&write, Outcome::Accepted, None);
    assert!(rig.status().contains("Copied."), "{}", rig.status());
}

#[test]
fn cut_deletes_only_after_the_clipboard_took_the_text() {
    let mut rig = Rig::opened("hello\n");
    rig.mods(Key::Char('a'), Mods::CTRL);
    let write = one(&rig.chord('x'), EffectKind::ClipboardWrite);
    assert_eq!(
        rig.text(),
        "hello",
        "still there until the write is accepted"
    );
    // A host-only answer reaches the panel in the turn it arrives, so the
    // delete goes out with it.
    let fx = rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.text(), "");
    let cut = the_edit(&fx);
    assert_eq!(changes(&cut), vec![(0, 6, String::new())]);
    assert_eq!(rig.text(), "");
}

#[test]
fn a_refused_cut_leaves_the_text_alone() {
    let mut rig = Rig::opened("hello\n");
    rig.chord('a');
    let write = one(&rig.chord('x'), EffectKind::ClipboardWrite);
    let fx = rig.answer(
        &write,
        Outcome::Refused {
            code: "denied".into(),
            reason: "the browser would not allow it".into(),
        },
        None,
    );
    none_of(&fx, EffectKind::DocumentEdit);
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    assert_eq!(rig.text(), "hello");
    let status = rig.status();
    assert!(
        status.contains("Not cut") && status.contains("the browser would not allow it"),
        "{status}"
    );
}

#[test]
fn paste_reads_the_clipboard_through_an_effect_and_inserts_the_answer() {
    let mut rig = Rig::opened("hello\n");
    let read = one(&rig.chord('v'), EffectKind::ClipboardRead);
    let fx = rig.answer(
        &read,
        Outcome::Accepted,
        Some(CompletionPayload::Clipboard(ClipboardText {
            text: "one\r\ntwo".into(),
        })),
    );
    let e = the_edit(&fx);
    assert_eq!(
        changes(&e),
        vec![(0, 0, "one\ntwo".to_owned())],
        "line breaks are the document's"
    );
    assert_eq!(rig.text(), "one\ntwohello");
}

#[test]
fn text_pasted_by_the_host_is_inserted_like_the_clipboard_answer() {
    let mut rig = Rig::opened("hello\n");
    let fx = rig.send(Msg::Paste("pasted".into()));
    let e = the_edit(&fx);
    assert_eq!(changes(&e), vec![(0, 0, "pasted".to_owned())]);
}

// ---- pointer ---------------------------------------------------------------

#[test]
fn a_click_places_the_caret_and_the_status_line_follows() {
    let mut rig = Rig::opened("hello world\nsecond line\n");
    rig.click(2 + 6, 1, 1);
    let status = rig.status();
    assert!(status.contains("Ln 2, Col 7"), "{status}");
}

#[test]
fn a_double_click_selects_a_word_and_a_triple_click_selects_the_line() {
    let mut rig = Rig::opened("hello world\nsecond line\n");
    rig.click(2 + 7, 0, 2);
    assert!(rig.status().contains("5 selected"), "{}", rig.status());
    rig.click(2 + 7, 0, 3);
    assert!(rig.status().contains("12 selected"), "{}", rig.status());
}

#[test]
fn dragging_selects_and_the_wheel_scrolls_without_moving_the_caret() {
    let mut rig = Rig::opened("hello world\nsecond line\n");
    let b = rig.body();
    let at = |kind, x: u16| {
        Msg::Pointer(Pointer {
            kind,
            x: b.x + x,
            y: b.y,
            mods: Mods::NONE,
            clicks: 1,
        })
    };
    rig.send(at(PointerKind::Down(Button::Left), 3));
    rig.send(at(PointerKind::Move, 6));
    rig.send(at(PointerKind::Up(Button::Left), 6));
    assert!(rig.status().contains("3 selected"), "{}", rig.status());

    let long: String = (1..=80).map(|n| format!("line {n}\n")).collect();
    let mut rig = Rig::opened(&long);
    rig.send(Msg::Pointer(Pointer {
        kind: PointerKind::Wheel { dx: 0, dy: 6 },
        x: rig.body().x + 4,
        y: rig.body().y + 3,
        mods: Mods::NONE,
        clicks: 1,
    }));
    let rows = rig.rows(rig.body().width, rig.body().height);
    assert!(rows[0].starts_with(" 7 line 7"), "{:?}", rows[0]);
    assert!(
        rig.status().contains("Ln 1, Col 1"),
        "the caret did not move: {}",
        rig.status()
    );
}

// ---- positions -------------------------------------------------------------

#[test]
fn edits_leave_in_utf16_units_and_the_status_line_counts_graphemes() {
    let mut rig = Rig::opened("\n");
    let first = the_edit(&rig.key(Key::Char('\u{1F600}')));
    assert_eq!(changes(&first), vec![(0, 0, "\u{1F600}".to_owned())]);
    rig.accept(&first, 2);
    let second = the_edit(&rig.key(Key::Char('x')));
    assert_eq!(
        changes(&second),
        vec![(2, 2, "x".to_owned())],
        "the emoji is two units"
    );
    assert!(rig.status().contains("Col 3"), "{}", rig.status());
}

// ---- lifetime --------------------------------------------------------------

#[test]
fn the_binding_names_the_document_its_revision_and_the_workspace_generation() {
    let rig = Rig::opened("hello\n");
    let b = rig.binding();
    assert_eq!(b.resource, doc());
    assert_eq!(b.revision, Some(seq(1)));
    assert!(b.generation.is_some());
}

#[test]
fn closing_the_panel_releases_the_document_and_keeps_the_unsent_text_as_a_draft() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.key(Key::Char('Y'));
    let id = rig.id.clone();
    let fx = rig.send(Msg::Dock(DockMsg::ClosePanel(id)));
    let close = one(&fx, EffectKind::DocumentClose);
    assert_eq!(close.resource, doc());
    none_of(&fx, EffectKind::DocumentRevert);
    assert!(
        rig.drafts.holds(&doc()),
        "the draft stays with its owner's next editor"
    );

    // Open the file again: the draft comes back and the edit that may not have
    // arrived is sent again under its own id.
    rig.send(Msg::Action {
        id: ActionId::new("files.focus"),
        actor: Actor::Human,
    });
    for c in PATH.chars() {
        rig.key(Key::Char(c));
    }
    rig.key(Key::Enter);
    let id = rig
        .m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "document")
        .map(|(id, _)| id.clone())
        .expect("a new editor");
    rig.id = id;
    let fx = rig.tick();
    rig.open = Some(one(&fx, EffectKind::DocumentOpen));
    let fx = rig.answer_open("hello\n", 1, true);
    assert_eq!(rig.text(), "XYhello");
    let again = the_edit(&fx);
    assert_eq!(op_id(&again), op_id(&e));
    assert!(!rig.drafts.holds(&doc()));
}

#[test]
fn a_workspace_change_rebinds_the_editor_and_gives_back_the_old_document() {
    let mut rig = Rig::opened("hello\n");
    rig.host(HostMessage::WorkspaceChanged {
        workspace: "w2".into(),
        environment: None,
    });
    let fx = rig.tick();
    let close = one(&fx, EffectKind::DocumentClose);
    assert_eq!(close.resource, doc());
    let open = one(&fx, EffectKind::DocumentOpen);
    assert_eq!(
        open.resource,
        ResourceRef::Document {
            workspace: "w2".into(),
            resource_id: PATH.into()
        }
    );
    assert_eq!(rig.binding().resource, open.resource);
    assert!(rig.screen().contains("Opening"));
}

#[test]
fn the_view_state_survives_a_save_and_restore_of_the_layout() {
    let mut rig = Rig::opened("hello world\nsecond line\nthird\n");
    rig.click(2 + 3, 1, 1);
    let state = rig.state();
    assert_eq!(state["path"], PATH);
    assert_eq!(state["workspace"], "w");
    assert_eq!(state["unit"], "scalar");
    assert_eq!(state["revision"], 1);
    let layout = rig.m.document();

    let mut other = Rig::start_with(&CAPS, &Drafts::new());
    let _ = other.m.restore(layout);
    let id = other
        .m
        .panel_ids()
        .find(|(_, k)| k.as_str() == "document")
        .map(|(id, _)| id.clone())
        .expect("the restored editor");
    other.id = id;
    let fx = other.tick();
    if let Some(open) = of_kind(&fx, EffectKind::DocumentOpen).first() {
        other.open = Some((*open).clone());
    }
    other.answer_open("hello world\nsecond line\nthird\n", 1, true);
    assert!(other.status().contains("Ln 2, Col 4"), "{}", other.status());
}

// ---- read only -------------------------------------------------------------

#[test]
fn a_document_the_owner_will_not_let_me_edit_shows_read_only_and_refuses_input_with_the_reason() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "read_only".into(),
            reason: "this file is read-only".into(),
        },
        None,
    );
    rig.mods(Key::Char('t'), Mods::ALT);
    assert_eq!(rig.text(), "hello");
    assert!(
        rig.status().contains("read-only: this file is read-only"),
        "{}",
        rig.status()
    );
    let fx = rig.key(Key::Char('Z'));
    none_of(&fx, EffectKind::DocumentEdit);
    assert_eq!(rig.text(), "hello");
    assert!(
        rig.status().contains("Read-only: this file is read-only"),
        "{}",
        rig.status()
    );
    let node = rig.node("text");
    assert!(node.state.description.unwrap().contains("read-only"));
    let undo = node
        .actions
        .iter()
        .find(|a| a.id.as_str() == "document.undo")
        .unwrap();
    assert!(!undo.enabled);
}

// ---- language --------------------------------------------------------------

#[test]
fn rename_asks_the_language_service_for_a_plan_and_applies_it_on_request() {
    let mut rig = Rig::opened("hello world\n");
    rig.key(Key::F2);
    assert!(rig.screen().contains("Rename to"), "{}", rig.screen());
    for _ in 0..5 {
        rig.key(Key::Backspace);
    }
    rig.typed("greeting");
    let fx = rig.key(Key::Enter);
    let rename = one(&fx, EffectKind::LanguageRename);
    let EffectBody::LanguageRename(r) = &rename.body else {
        unreachable!()
    };
    assert_eq!(r.new_name, "greeting");
    assert_eq!((r.position.line, r.position.character), (0, 0));
    assert_eq!(rename.revision, Some(seq(1)));
    rig.answer(
        &rename,
        Outcome::Accepted,
        Some(CompletionPayload::LanguagePlan(LanguagePlan {
            plan_id: "plan-1".into(),
        })),
    );
    assert!(rig.screen().contains("Rename planned against revision 1"));
    let fx = rig.mods(Key::Char('a'), Mods::ALT);
    let apply = one(&fx, EffectKind::LanguageApplyPlan);
    let EffectBody::LanguageApplyPlan(a) = &apply.body else {
        unreachable!()
    };
    assert_eq!(a.plan_id, "plan-1");
}

#[test]
fn a_rename_plan_for_an_older_revision_is_not_applied() {
    let mut rig = Rig::opened("hello world\n");
    // The name is seeded with the word under the caret; asking with it as it
    // is still asks.
    rig.key(Key::F2);
    let rename = one(&rig.key(Key::Enter), EffectKind::LanguageRename);
    rig.answer(
        &rename,
        Outcome::Accepted,
        Some(CompletionPayload::LanguagePlan(LanguagePlan {
            plan_id: "plan-1".into(),
        })),
    );
    rig.host(remote_insert(2, 0, "x"));
    let fx = rig.mods(Key::Char('a'), Mods::ALT);
    none_of(&fx, EffectKind::LanguageApplyPlan);
    assert!(
        rig.status().contains("planned for revision 1"),
        "{}",
        rig.status()
    );
}

#[test]
fn format_is_sent_for_the_accepted_revision() {
    let mut rig = Rig::opened("hello\n");
    let fx = rig.mods(Key::Char('F'), Mods::ALT);
    let format = one(&fx, EffectKind::LanguageFormat);
    assert_eq!(format.revision, Some(seq(1)));
    rig.answer(&format, Outcome::Accepted, None);
    assert!(
        rig.status().contains("Formatting accepted"),
        "{}",
        rig.status()
    );
}

#[test]
fn language_actions_are_unavailable_without_the_capability_and_say_why() {
    let mut rig = Rig::opened("hello\n");
    rig.host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["files", "documents"]),
    });
    let fx = rig.key(Key::F2);
    none_of(&fx, EffectKind::LanguageRename);
    assert!(
        rig.status().contains("No language service"),
        "{}",
        rig.status()
    );
    let rename = rig
        .node("text")
        .actions
        .into_iter()
        .find(|a| a.id.as_str() == "document.rename")
        .unwrap();
    assert!(!rename.enabled);
    assert!(rename.reason.unwrap().contains("No language service"));
}

// ---- semantics -------------------------------------------------------------

#[test]
fn the_semantic_nodes_name_the_path_the_state_the_caret_and_the_status_line() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    rig.tree_ok();
    let text = rig.node("text");
    assert_eq!(text.name, PATH);
    assert_eq!(text.binding, doc());
    assert_eq!(text.revision, Some(seq(2)));
    let d = text.state.description.unwrap();
    assert!(d.contains("modified"), "{d}");
    assert!(d.contains("line 1, column 2 in graphemes"), "{d}");
    assert!(rig.node("status").name.contains("Ln 1, Col 2"));
    assert!(
        rig.node("caret")
            .state
            .description
            .unwrap()
            .contains("column 2")
    );
    let save = text
        .actions
        .iter()
        .find(|a| a.id.as_str() == "document.save")
        .unwrap();
    assert!(save.enabled);
}

#[test]
fn the_semantic_tree_stays_valid_in_every_state_the_panel_can_be_in() {
    let mut rig = Rig::opened("hello\n");
    rig.tree_ok();
    rig.chord('f');
    rig.typed("hel");
    rig.tree_ok();
    rig.key(Key::Esc);
    conflicted(&mut rig);
    rig.tree_ok();
    rig.mods(Key::Char('t'), Mods::ALT);
    rig.tree_ok();
    rig.key(Key::F2);
    rig.tree_ok();
}

// ---- the long session --------------------------------------------------------

#[test]
fn a_paragraph_of_mixed_scripts_typed_key_by_key_edited_in_the_middle_undone_rebased_and_saved() {
    let paragraph = "Hello, w\u{f6}rld! \u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30ad}\u{30b9}\u{30c8} e\u{301}clair \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} end";
    let mut rig = Rig::opened("");
    let mut rev = 1u64;
    let mut sent: Vec<Effect> = vec![];
    let mut units = 0u32;

    // Every key goes out as its own edit, one at a time, at the next
    // revision, at the UTF-16 offset of everything typed before it.
    for c in paragraph.chars() {
        let fx = rig.key(Key::Char(c));
        let e = the_edit(&fx);
        assert_eq!(e.revision, Some(seq(rev)), "base revision for {c:?}");
        assert_eq!(changes(&e), vec![(units, units, c.to_string())], "{c:?}");
        units += utf16(&c.to_string());
        let after = rig.accept(&e, rev + 1);
        none_of(&after, EffectKind::DocumentEdit);
        rev += 1;
        sent.push(e);
    }
    assert_eq!(rig.text(), paragraph);
    let ops: std::collections::BTreeSet<_> = sent.iter().map(op_id).collect();
    assert_eq!(ops.len(), sent.len(), "every edit has its own operation id");

    // The cells: the Japanese is two cells a character, the family is one
    // cluster in two cells, the combining accent stays on its letter.
    let gutter = 2u16;
    let buf = rig.draw(rig.body().width, rig.body().height);
    let before_jp = "Hello, w\u{f6}rld! ";
    let x = gutter + unicode_width(before_jp);
    assert_eq!(buf[(x, 0)].symbol(), "\u{65e5}");
    assert_eq!(buf[(x + 2, 0)].symbol(), "\u{672c}");
    let before_family = "Hello, w\u{f6}rld! \u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30ad}\u{30b9}\u{30c8} e\u{301}clair ";
    let x = gutter + unicode_width(before_family);
    assert_eq!(
        buf[(x, 0)].symbol(),
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
    );
    let before_accent =
        "Hello, w\u{f6}rld! \u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30ad}\u{30b9}\u{30c8} ";
    let x = gutter + unicode_width(before_accent);
    assert_eq!(buf[(x, 0)].symbol(), "e\u{301}");
    // The caret is at the end: after the last character, in grapheme units.
    let graphemes = {
        use unicode_segmentation::UnicodeSegmentation;
        paragraph.graphemes(true).count()
    };
    assert!(
        rig.status().contains(&format!("Col {}", graphemes + 1)),
        "{}",
        rig.status()
    );

    // An edit in the middle: Home, seven rights, one letter.
    rig.key(Key::Home);
    for _ in 0..7 {
        rig.key(Key::Right);
    }
    let fx = rig.key(Key::Char('Q'));
    let q = the_edit(&fx);
    assert_eq!(changes(&q), vec![(7, 7, "Q".to_owned())]);
    rig.accept(&q, rev + 1);
    rev += 1;
    assert!(
        rig.text().starts_with("Hello, Qw\u{f6}rld!"),
        "{}",
        rig.text()
    );

    // Undo it: the owner is told to remove exactly that letter.
    let undo = the_edit(&rig.chord('z'));
    assert_eq!(changes(&undo), vec![(7, 8, String::new())]);
    rig.accept(&undo, rev + 1);
    rev += 1;
    assert_eq!(rig.text(), paragraph);

    // Someone else types at the start; the redo lands three units later.
    rig.host(remote_insert(rev + 1, 0, ">> "));
    rev += 1;
    assert_eq!(rig.text(), format!(">> {paragraph}"));
    let redo = the_edit(&rig.mods(Key::Char('Z'), Mods::CTRL));
    assert_eq!(changes(&redo), vec![(10, 10, "Q".to_owned())]);
    assert_eq!(redo.revision, Some(seq(rev)));
    rig.accept(&redo, rev + 1);
    rev += 1;
    assert!(
        rig.text().starts_with(">> Hello, Qw\u{f6}rld!"),
        "{}",
        rig.text()
    );

    // Save: the accepted revision, and the flag clears when the owner says so.
    assert!(rig.status().contains("modified"));
    let save = one(&rig.chord('s'), EffectKind::DocumentSave);
    assert_eq!(save.revision, Some(seq(rev)));
    rig.answer(
        &save,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentSaved(DocumentSaved {
            revision: seq(rev),
        })),
    );
    assert!(!rig.status().contains("modified"), "{}", rig.status());
    assert_eq!(rig.binding().revision, Some(seq(rev)));
    rig.tree_ok();
}

// ---- the 80 by 20 picture ----------------------------------------------------

#[test]
fn an_eighty_by_twenty_view_wraps_a_long_line_and_marks_the_selection() {
    let long = "A long line of prose that does not fit in eighty columns and so wraps onto a second row, where the wrapped part carries on.";
    let mut rig = Rig::opened(&format!(
        "fn main() {{\n    println!(\"hi\");\n}}\n\n{long}\nlast line\n"
    ));
    rig.click(2 + 8, 1, 2);
    let rows = rig.selection_marked(80, 20);
    let picture = rows.join("\n");
    println!("{picture}");
    assert!(rows[4].starts_with("5 A long line"), "{picture}");
    assert!(
        rows[5].starts_with("  ") && rows[5].contains("wrapped part"),
        "{picture}"
    );
    assert!(rows[6].starts_with("6 last line"), "{picture}");
    assert!(picture.contains("{println}"), "{picture}");
    assert!(rows[19].contains("Ln 2, Col 12"), "{picture}");
}

// ---- registry --------------------------------------------------------------

#[test]
fn a_registered_editor_action_reaches_the_editor_and_sends_its_effect() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.typed("x"));
    rig.accept(&e, 2);
    let fx = rig.send(Msg::Action {
        id: ActionId::new("document.save"),
        actor: Actor::Human,
    });
    one(&fx, EffectKind::DocumentSave);
}

#[test]
fn the_editor_actions_are_listed_for_agents_and_cannot_be_registered_twice() {
    let mut registry = builtin::registry();
    theorem_workbench_editor::extend_registry(&mut registry).unwrap();
    let ids: Vec<_> = registry
        .agent_catalog(&Capabilities::of(CAPS))
        .into_iter()
        .map(|e| e.action.as_str().to_owned())
        .collect();
    assert!(ids.iter().any(|i| i == "document.save"), "{ids:?}");
    assert!(
        theorem_workbench_editor::extend_registry(&mut registry).is_err(),
        "a second registration is refused, not merged"
    );
}

// ---- language results ------------------------------------------------------

fn pos(line: u32, character: u32) -> Position {
    Position { line, character }
}

fn range(l: u32, a: u32, b: u32) -> Range {
    Range {
        start: pos(l, a),
        end: pos(l, b),
    }
}

fn ask(rig: &mut Rig, key: Key, mods: Mods, kind: EffectKind) -> Effect {
    one(&rig.mods(key, mods), kind)
}

#[test]
fn a_hover_is_a_popup_at_the_caret_and_escape_closes_it() {
    let mut rig = Rig::opened("hello world\n");
    let hover = ask(
        &mut rig,
        Key::Char('h'),
        Mods::ALT,
        EffectKind::LanguageHover,
    );
    assert_eq!(hover.revision, Some(seq(1)));
    rig.answer(
        &hover,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageHover(LanguageHover {
            contents: "**greeting**: a word".into(),
            range: None,
            span: None,
        })),
    );
    assert!(rig.screen().contains("greeting"), "{}", rig.screen());
    rig.key(Key::Esc);
    assert!(!rig.screen().contains("a word"), "{}", rig.screen());
}

#[test]
fn a_hover_for_an_older_revision_is_not_shown_and_the_status_says_so() {
    let mut rig = Rig::opened("hello\n");
    let hover = ask(
        &mut rig,
        Key::Char('h'),
        Mods::ALT,
        EffectKind::LanguageHover,
    );
    rig.host(remote_insert(2, 0, "x"));
    rig.answer(
        &hover,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageHover(LanguageHover {
            contents: "stale words".into(),
            range: None,
            span: None,
        })),
    );
    assert!(!rig.screen().contains("stale words"), "{}", rig.screen());
    assert!(rig.status().contains("not shown"), "{}", rig.status());
}

#[test]
fn a_completion_is_inserted_through_the_edit_path_and_undoes_in_one_step() {
    let mut rig = Rig::opened("hel\n");
    rig.mods(Key::End, Mods::NONE);
    let ask = ask(
        &mut rig,
        Key::Char(' '),
        Mods::CTRL,
        EffectKind::LanguageComplete,
    );
    rig.answer(
        &ask,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageCompletions(
            LanguageCompletions {
                items: vec![
                    CompletionItem {
                        label: "hello".into(),
                        kind: None,
                        detail: None,
                        documentation: None,
                        insert_text: Some("hello".into()),
                        range: Some(theorem_workbench_core::results::CompletionRange::One(
                            range(0, 0, 3),
                        )),
                        item_id: None,
                    },
                    CompletionItem {
                        label: "help".into(),
                        kind: None,
                        detail: None,
                        documentation: None,
                        insert_text: Some("help".into()),
                        range: None,
                        item_id: None,
                    },
                ],
            },
        )),
    );
    assert!(rig.screen().contains("help"), "{}", rig.screen());
    let fx = rig.key(Key::Enter);
    let e = the_edit(&fx);
    assert_eq!(changes(&e), vec![(0, 3, "hello".to_owned())]);
    assert_eq!(rig.text(), "hello");
    rig.chord('z');
    assert_eq!(rig.text(), "hel", "one undo takes the whole insertion back");
}

#[test]
fn definitions_in_this_file_move_the_caret_and_in_another_open_it_there() {
    let mut rig = Rig::opened("one\ntwo\nthree\n");
    let ask1 = ask(&mut rig, Key::F12, Mods::NONE, EffectKind::LanguageNavigate);
    rig.answer(
        &ask1,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageLocations(LanguageLocations {
            locations: vec![LocationRow {
                resource_id: Some(PATH.into()),
                uri: None,
                range: Some(range(2, 1, 1)),
                span: None,
                revision: None,
            }],
        })),
    );
    let fx = rig.key(Key::Enter);
    none_of(&fx, EffectKind::DocumentOpen);
    assert!(rig.status().contains("Ln 3, Col 2"), "{}", rig.status());

    let ask2 = ask(
        &mut rig,
        Key::F12,
        Mods::SHIFT,
        EffectKind::LanguageReferences,
    );
    rig.answer(
        &ask2,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageLocations(LanguageLocations {
            locations: vec![LocationRow {
                resource_id: Some("src/b.rs".into()),
                uri: None,
                range: Some(range(4, 2, 2)),
                span: None,
                revision: None,
            }],
        })),
    );
    assert!(rig.screen().contains("src/b.rs"), "{}", rig.screen());
    // The file opens in an editor of its own; the root asks the owner for it.
    let mut fx = rig.key(Key::Enter);
    fx.extend(rig.tick());

    let open = of_kind(&fx, EffectKind::DocumentOpen);
    assert!(
        open.iter().any(|e| matches!(
            &e.resource,
            ResourceRef::Document { resource_id, .. } if resource_id == "src/b.rs"
        )),
        "{:?}",
        fx.iter()
            .map(|e| (e.kind(), e.resource.clone()))
            .collect::<Vec<_>>()
    );
}

fn finding(start: u64, end: u64, severity: Severity, message: &str) -> Finding {
    Finding {
        id: format!("f{start}"),
        start,
        end,
        severity,
        message: message.into(),
        provider: None,
        fix_handle: None,
    }
}

fn diagnostics(rig: &mut Rig, revision: u64, findings: Vec<Finding>) {
    let fx = rig.tick();
    let check = one(&fx, EffectKind::LanguageDiagnostics);
    rig.answer(
        &check,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageDiagnostics(
            LanguageDiagnostics {
                revision: Some(revision),
                session_epoch: None,
                content_hash: None,
                full: true,
                findings,
            },
        )),
    );
}

#[test]
fn diagnostics_mark_the_gutter_and_the_caret_lines_message_is_in_the_status() {
    let mut rig = Rig::opened("ok\nbad \u{1F600}x\n");
    // The second line starts at byte 3; the finding covers "x" after the emoji.
    diagnostics(
        &mut rig,
        1,
        vec![finding(
            3 + 4 + 4,
            3 + 4 + 5,
            Severity::Error,
            "x is undefined",
        )],
    );
    let rows = rig.rows(rig.body().width, rig.body().height);
    assert!(rows[1].contains('!'), "gutter glyph on line 2: {rows:#?}");
    assert!(!rows[0].contains('!'), "{rows:#?}");
    assert!(!rig.status().contains("x is undefined"));
    rig.key(Key::Down);
    assert!(
        rig.status().contains("error: x is undefined"),
        "{}",
        rig.status()
    );
    let buf = rig.draw(rig.body().width, rig.body().height);
    let b = rig.body();
    let underlined = (0..b.width).any(|x| buf[(x, 1)].modifier.contains(Modifier::UNDERLINED));
    assert!(underlined, "the finding's text is marked");
}

#[test]
fn diagnostics_for_another_revision_are_not_applied_and_are_asked_for_again() {
    let mut rig = Rig::opened("ok\n");
    let fx = rig.tick();
    let check = one(&fx, EffectKind::LanguageDiagnostics);
    rig.host(remote_insert(2, 0, "x"));
    rig.answer(
        &check,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageDiagnostics(
            LanguageDiagnostics {
                revision: Some(1),
                session_epoch: None,
                content_hash: None,
                full: true,
                findings: vec![finding(0, 1, Severity::Warning, "old")],
            },
        )),
    );
    let rows = rig.rows(rig.body().width, rig.body().height);
    assert!(!rows[0].contains('?'), "{rows:#?}");
    assert!(rig.status().contains("no findings"), "{}", rig.status());
    one(&rig.tick(), EffectKind::LanguageDiagnostics);
}

// ---- page.create -----------------------------------------------------------

fn new_page(rig: &mut Rig) -> PanelInstanceId {
    let fx = rig.send(Msg::Action {
        id: ActionId::new("page.new"),
        actor: Actor::Human,
    });
    let _ = fx;
    rig.m
        .panel_ids()
        .find(|(id, k)| k.as_str() == "document" && **id != rig.id)
        .map(|(id, _)| id.clone())
        .expect("an editor with no file opened")
}

#[test]
fn a_new_page_asks_for_a_name_and_creates_it_through_the_owner() {
    let mut rig = Rig::opened("hello\n");
    let fresh = new_page(&mut rig);
    rig.id = fresh;
    assert!(rig.screen().contains("Name"), "{}", rig.screen());
    rig.typed("notes/new.md");
    let fx = rig.key(Key::Enter);
    let create = one(&fx, EffectKind::DocumentCreate);
    let EffectBody::DocumentCreate(c) = &create.body else {
        unreachable!()
    };
    assert_eq!(c.path, "notes/new.md");
    rig.answer(
        &create,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentOpened(DocumentOpened {
            text: String::new(),
            revision: seq(1),
            saved_revision: None,
            dirty: false,
            read_only: None,
            pending: vec![],
        })),
    );
    assert!(rig.state()["path"] == "notes/new.md", "{}", rig.state());
    assert!(!rig.screen().contains("Name the page"), "{}", rig.screen());
}

#[test]
fn a_refused_create_shows_the_reason_and_the_name_can_be_changed() {
    let mut rig = Rig::opened("hello\n");
    rig.id = new_page(&mut rig);
    rig.typed("a.txt");
    let create = one(&rig.key(Key::Enter), EffectKind::DocumentCreate);
    rig.answer(
        &create,
        Outcome::Refused {
            code: "exists".into(),
            reason: "that page already exists".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(
        screen.contains("that page already exists") && screen.contains("exists"),
        "{screen}"
    );
    rig.key(Key::Backspace);
    let again = one(&rig.key(Key::Enter), EffectKind::DocumentCreate);
    let EffectBody::DocumentCreate(c) = &again.body else {
        unreachable!()
    };
    assert_eq!(c.path, "a.tx");
}

// ---- replace ---------------------------------------------------------------

#[test]
fn replace_one_and_replace_all_are_ordinary_edits_each_undone_in_one_step() {
    let mut rig = Rig::opened("cat cat cat\n");
    rig.chord('h');
    rig.typed("cat");
    rig.key(Key::Tab);
    rig.typed("dog");
    let first = the_edit(&rig.key(Key::Enter));
    assert_eq!(changes(&first).len(), 1);
    rig.accept(&first, 2);
    let all = the_edit(&rig.mods(Key::Enter, Mods::ALT));
    assert_eq!(changes(&all).len(), 1, "one edit spanning the matches");
    rig.key(Key::Esc);
    assert_eq!(rig.text(), "dog dog dog");
    rig.chord('z');
    assert_eq!(rig.text(), "dog cat cat", "replace all is one undo step");
    rig.chord('z');
    assert_eq!(rig.text(), "cat cat cat");
}

// ---- batch four ------------------------------------------------------------

#[test]
fn the_tab_names_the_file_and_marks_unsaved_changes() {
    let mut rig = Rig::opened("hello\n");
    let label = rig.m.panel(&rig.id).unwrap().tab_label().unwrap();
    assert_eq!((label.title.as_str(), label.modified), ("a.txt", false));
    rig.typed("x");
    assert!(rig.m.panel(&rig.id).unwrap().tab_label().unwrap().modified);
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
    let fx = rig.typed("x");
    none_of(&fx, EffectKind::DocumentEdit);
    assert_eq!(rig.text(), "hello");
    assert!(
        rig.screen().contains("a generated file"),
        "{}",
        rig.screen()
    );
}

#[test]
fn a_save_of_an_older_revision_keeps_the_modified_mark_when_the_text_moved_on() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    rig.host(HostMessage::DocumentSaved {
        resource: doc(),
        revision: seq(1),
    });
    assert!(rig.m.panel(&rig.id).unwrap().tab_label().unwrap().modified);
    rig.host(HostMessage::DocumentSaved {
        resource: doc(),
        revision: seq(2),
    });
    assert!(!rig.m.panel(&rig.id).unwrap().tab_label().unwrap().modified);
}

#[test]
fn a_composition_is_drawn_underlined_at_the_caret_and_enters_the_text_once_committed() {
    let mut rig = Rig::opened("ab\n");
    rig.send(Msg::Composition(Composition::Start));
    rig.send(Msg::Composition(Composition::Update { text: "ni".into() }));
    assert!(rig.screen().contains("ni"), "{}", rig.screen());
    none_of(&rig.tick(), EffectKind::DocumentEdit);
    let b = rig.body();
    let buf = rig.draw(b.width, b.height);
    let underlined = (0..b.width).any(|x| buf[(x, 0)].modifier.contains(Modifier::UNDERLINED));
    assert!(underlined);
    let fx = rig.send(Msg::Composition(Composition::End {
        text: "\u{4f60}".into(),
    }));
    let e = the_edit(&fx);
    assert_eq!(changes(&e), vec![(0, 0, "\u{4f60}".to_owned())]);
    assert_eq!(rig.text(), "\u{4f60}ab");
}

#[test]
fn token_spans_colour_the_text_for_their_revision_and_not_for_another() {
    let mut rig = Rig::opened("let x\n");
    let spans = |rev: u64, start, end| HostMessage::DocumentTokens {
        resource: doc(),
        revision: seq(rev),
        encoding: SpanEncoding::Utf8Bytes,
        spans: vec![TokenSpan {
            start,
            end,
            class: "keyword".into(),
        }],
    };
    let bold_cols = |rig: &Rig| -> Vec<u16> {
        let b = rig.body();
        let buf = rig.draw(b.width, b.height);
        (0..b.width)
            .filter(|x| buf[(*x, 0)].modifier.contains(Modifier::BOLD))
            .collect()
    };
    let before = bold_cols(&rig);
    rig.host(spans(1, 0, 3));
    let after = bold_cols(&rig);
    assert!(
        after.contains(&3) && after.contains(&4),
        "{before:?} {after:?}"
    );
    assert!(!before.contains(&3) && !before.contains(&4), "{before:?}");
    // A second line typed below keeps the first line's colour until new
    // spans arrive.
    rig.mods(Key::End, Mods::CTRL);
    rig.typed("more");
    let kept = bold_cols(&rig);
    assert!(kept.contains(&3) && kept.contains(&4), "{kept:?}");
}

// ---- panel-local actions and popup pointer ---------------------------------

fn act(rig: &mut Rig, id: &str) -> Vec<Effect> {
    rig.send(Msg::Action {
        id: ActionId::new(id),
        actor: Actor::Human,
    })
}

#[test]
fn the_panels_own_actions_are_registered_and_reach_it_as_actions() {
    let mut registry = builtin::registry();
    theorem_workbench_editor::extend_registry(&mut registry).unwrap();
    for id in [
        "document.undo",
        "document.redo",
        "document.find",
        "document.findNext",
        "document.findPrevious",
        "document.findReplace",
        "document.replace",
        "document.replaceAll",
        "document.dismiss",
        "document.retry",
        "document.close",
    ] {
        assert!(registry.action(&ActionId::new(id)).is_some(), "{id}");
    }
    let mut rig = Rig::opened("cat cat\n");
    let e = the_edit(&rig.typed("x"));
    rig.accept(&e, 2);
    act(&mut rig, "document.undo");
    assert_eq!(rig.text(), "cat cat");
    act(&mut rig, "document.redo");
    assert_eq!(rig.text(), "xcat cat");
    act(&mut rig, "document.findReplace");
    assert!(rig.screen().contains("Replace"), "{}", rig.screen());
    act(&mut rig, "document.dismiss");
    assert!(!rig.screen().contains("Replace "), "{}", rig.screen());
    act(&mut rig, "document.find");
    rig.typed("cat");
    act(&mut rig, "document.findNext");
    act(&mut rig, "document.findPrevious");
    assert!(rig.screen().contains("of 2"), "{}", rig.screen());
}

#[test]
fn replace_and_replace_all_are_reached_by_their_action_ids() {
    let mut rig = Rig::opened("cat cat\n");
    act(&mut rig, "document.findReplace");
    rig.typed("cat");
    rig.key(Key::Tab);
    rig.typed("dog");
    let one_edit = the_edit(&act(&mut rig, "document.replace"));
    rig.accept(&one_edit, 2);
    let all = the_edit(&act(&mut rig, "document.replaceAll"));
    assert_eq!(changes(&all).len(), 1);
    act(&mut rig, "document.dismiss");
    assert_eq!(rig.text(), "dog dog");
}

#[test]
fn the_default_keys_come_from_the_registry_without_conflicts() {
    let mut registry = builtin::registry();
    theorem_workbench_editor::extend_registry(&mut registry).unwrap();
    let (table, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
    assert!(issues.is_empty(), "{issues:?}");
    let _ = table;
    let keyed: Vec<_> = registry
        .default_shortcuts()
        .into_iter()
        .filter(|s| s.action.as_str().starts_with("document."))
        .map(|s| s.action.as_str().to_owned())
        .collect();
    for id in [
        "document.undo",
        "document.find",
        "document.findNext",
        "document.findReplace",
    ] {
        assert!(keyed.iter().any(|k| k == id), "{id} in {keyed:?}");
    }
}

fn completions(rig: &mut Rig, n: usize) {
    let ask = ask(
        rig,
        Key::Char(' '),
        Mods::CTRL,
        EffectKind::LanguageComplete,
    );
    let items = (0..n)
        .map(|i| CompletionItem {
            label: format!("item{i:02}"),
            kind: None,
            detail: None,
            documentation: None,
            insert_text: Some(format!("item{i:02}")),
            range: None,
            item_id: None,
        })
        .collect();
    rig.answer(
        &ask,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageCompletions(
            LanguageCompletions { items },
        )),
    );
}

fn row_of(rig: &Rig, needle: &str) -> Option<(u16, u16)> {
    let b = rig.body();
    rig.rows(b.width, b.height)
        .iter()
        .enumerate()
        .find_map(|(y, r)| r.find(needle).map(|x| (x as u16, y as u16)))
}

fn wheel(rig: &mut Rig, x: u16, y: u16, dy: i16) {
    let b = rig.body();
    rig.send(Msg::Pointer(Pointer {
        kind: PointerKind::Wheel { dx: 0, dy },
        x: b.x + x,
        y: b.y + y,
        mods: Mods::NONE,
        clicks: 1,
    }));
}

#[test]
fn a_click_on_a_completion_row_chooses_it() {
    let mut rig = Rig::opened("\n");
    completions(&mut rig, 5);
    let (x, y) = row_of(&rig, "item03").expect("the row is drawn");
    let mut fx = rig.click(x, y, 1);
    fx.extend(rig.tick());
    let e = the_edit(&fx);
    assert_eq!(changes(&e), vec![(0, 0, "item03".to_owned())]);
    assert!(row_of(&rig, "item04").is_none(), "the popup is gone");
}

#[test]
fn the_wheel_scrolls_a_long_list_without_changing_the_choice() {
    let mut rig = Rig::opened("\n");
    completions(&mut rig, 20);
    assert!(row_of(&rig, "item00").is_some());
    assert!(row_of(&rig, "item09").is_none(), "only eight rows show");
    let (x, y) = row_of(&rig, "item00").unwrap();
    wheel(&mut rig, x, y, 1);
    assert!(row_of(&rig, "item00").is_none(), "{}", rig.screen());
    assert!(row_of(&rig, "item09").is_some(), "{}", rig.screen());
    // Enter still takes the row the keys were on.
    let e = the_edit(&rig.key(Key::Enter));
    assert_eq!(changes(&e), vec![(0, 0, "item00".to_owned())]);
}

#[test]
fn a_press_outside_a_popup_puts_it_away() {
    let mut rig = Rig::opened("hello\n");
    completions(&mut rig, 3);
    assert!(row_of(&rig, "item01").is_some());
    let b = rig.body();
    rig.click(b.width - 1, 0, 1);
    assert!(row_of(&rig, "item01").is_none(), "{}", rig.screen());
}

#[test]
fn a_click_on_a_location_row_goes_there() {
    let mut rig = Rig::opened("one\ntwo\nthree\n");
    let ask1 = ask(
        &mut rig,
        Key::F12,
        Mods::SHIFT,
        EffectKind::LanguageReferences,
    );
    let loc = |l: u32| LocationRow {
        resource_id: Some(PATH.into()),
        uri: None,
        range: Some(range(l, 0, 0)),
        span: None,
        revision: None,
    };
    rig.answer(
        &ask1,
        Outcome::Accepted,
        Some(CompletionPayload::LanguageLocations(LanguageLocations {
            locations: vec![loc(0), loc(2)],
        })),
    );
    let rows = rig.rows(rig.body().width, rig.body().height);
    let second = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.contains("a.txt"))
        .nth(1)
        .map(|(y, r)| (r.find("a.txt").unwrap() as u16, y as u16))
        .expect("two rows");
    rig.click(second.0, second.1, 1);
    assert!(rig.status().contains("Ln 3"), "{}", rig.status());
}

// ---- redo, however the shifted letter arrives ------------------------------

fn undone() -> Rig {
    let mut rig = Rig::opened("ab\n");
    rig.typed("x");
    rig.chord('z');
    assert_eq!(rig.text(), "ab");
    rig
}

#[test]
fn redo_by_an_upper_case_letter_with_the_command_key() {
    let mut rig = undone();
    rig.mods(Key::Char('Z'), Mods::CTRL);
    assert_eq!(rig.text(), "xab");
}

#[test]
fn redo_by_an_upper_case_letter_with_shift_held() {
    let mut rig = undone();
    rig.mods(Key::Char('Z'), Mods::CTRL | Mods::SHIFT);
    assert_eq!(rig.text(), "xab");
}

#[test]
fn redo_by_ctrl_y() {
    let mut rig = undone();
    rig.chord('y');
    assert_eq!(rig.text(), "xab");
}

// ---- the save message, and undo grouping -----------------------------------

#[test]
fn the_saved_message_goes_away_with_the_next_edit() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.typed("x"));
    rig.accept(&e, 2);
    let save = one(&rig.chord('s'), EffectKind::DocumentSave);
    rig.answer(
        &save,
        Outcome::Accepted,
        Some(CompletionPayload::DocumentSaved(DocumentSaved {
            revision: seq(2),
        })),
    );
    assert!(
        rig.status().contains("Saved revision 2"),
        "{}",
        rig.status()
    );
    rig.typed("y");
    assert!(!rig.status().contains("Saved revision"), "{}", rig.status());
    assert!(rig.status().contains("modified"), "{}", rig.status());
}

#[test]
fn typing_is_undone_a_run_of_one_kind_of_character_at_a_time() {
    // The rule is workbench-text's: consecutive inserts that touch and are of
    // one class (word characters, white space, anything else) are one step.
    // A pause does not end a run; a newline always does. The rendered rows
    // trim trailing spaces, so the steps are read from the caret's column
    // on the semantic node, which counts the space.
    let mut rig = Rig::opened("\n");
    rig.typed("ab cd");
    let column = |rig: &Rig| -> String {
        let d = rig.node("caret").state.description.unwrap();
        d.split("column ")
            .nth(1)
            .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
            .unwrap()
            .to_owned()
    };
    let mut seen = vec![column(&rig)];
    for _ in 0..3 {
        rig.chord('z');
        seen.push(column(&rig));
    }
    // "ab cd", then "ab " (the word went), then "ab" (the space), then "".
    assert_eq!(seen, ["6", "4", "3", "1"], "{seen:?}");
}

#[test]
fn opening_a_file_from_files_lands_the_editor_in_the_tool_group() {
    use theorem_workbench_dock::Role;
    let rig = Rig::start();
    let dock = rig.m.dock();
    let role = dock
        .group_ids()
        .into_iter()
        .find(|g| {
            dock.group(*g)
                .is_some_and(|g| g.tabs().iter().any(|t| t.panel.0 == rig.id.as_str()))
        })
        .and_then(|g| dock.group(g).map(|g| g.role()))
        .expect("the editor sits in a group");
    assert_eq!(role, Role::Tools);
}

#[test]
fn the_themes_syntax_roles_set_the_colour_the_panel_draws() {
    use ratatui::style::{Color, Style};
    let mut rig = Rig::opened("let x\n");
    rig.host(HostMessage::DocumentTokens {
        resource: doc(),
        revision: seq(1),
        encoding: SpanEncoding::Utf8Bytes,
        spans: vec![TokenSpan {
            start: 0,
            end: 3,
            class: "keyword".into(),
        }],
    });
    let fg_at = |rig: &Rig, theme: &Theme, x: u16| {
        let b = rig.body();
        let area = Rect::new(0, 0, b.width, b.height);
        let mut buf = Buffer::empty(area);
        let mut cx = ViewCtx::new(theme, rig.m.workspace());
        cx.focused = true;
        rig.m.panel(&rig.id).unwrap().view(area, &mut buf, &cx);
        buf[(x, 0)].fg
    };
    let plain = Theme::plain();
    let teal = Style::default().fg(Color::Rgb(1, 2, 3));
    let themed = Theme::plain().with_syntax(teal, teal, teal, teal, teal, teal);
    // The line number takes two columns; the keyword begins at column 2.
    assert_eq!(fg_at(&rig, &plain, 3), Color::Reset);
    assert_eq!(fg_at(&rig, &themed, 3), Color::Rgb(1, 2, 3));
}

#[test]
fn the_themes_preedit_role_styles_the_composition_text() {
    use ratatui::style::{Color, Style};
    let mut rig = Rig::opened("ab\n");
    rig.send(Msg::Composition(Composition::Start));
    rig.send(Msg::Composition(Composition::Update { text: "zz".into() }));
    let bg_of = |theme: &Theme| {
        let b = rig.body();
        let area = Rect::new(0, 0, b.width, b.height);
        let mut buf = Buffer::empty(area);
        let mut cx = ViewCtx::new(theme, rig.m.workspace());
        cx.focused = true;
        rig.m.panel(&rig.id).unwrap().view(area, &mut buf, &cx);
        (0..b.width)
            .find(|x| buf[(*x, 0)].symbol() == "z")
            .map(|x| buf[(x, 0)].bg)
    };
    let plain = Theme::plain();
    let mut themed = Theme::plain();
    themed.preedit = Style::default().bg(Color::Rgb(7, 8, 9));
    assert_eq!(bg_of(&plain), Some(Color::Reset));
    assert_eq!(bg_of(&themed), Some(Color::Rgb(7, 8, 9)));
}

// ---- narrow panels ---------------------------------------------------------

const WIDTHS: [u16; 3] = [80, 43, 24];

impl Rig {
    /// The panel body made `width` cells wide (a lone group takes the area).
    fn at(mut self, width: u16) -> Self {
        self.send(Msg::Resize {
            area: Rect::new(0, 0, width, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        });
        assert_eq!(self.body().width, width);
        self
    }

    /// The buttons of a group node (`strip:` or `find:`), with where each is
    /// and the cells drawn there.
    fn buttons(&self, prefix: &str) -> Vec<(String, Rect, String)> {
        let b = self.body();
        let rows = self.rows(b.width, b.height);
        let tree = semantics(&self.m);
        let want = format!("{}/{prefix}", self.id.as_str());
        tree.nodes
            .iter()
            .filter(|n| n.id.as_str().starts_with(&want))
            .map(|n| {
                let row = &rows[usize::from(n.rect.y - b.y)];
                let drawn: String = row
                    .chars()
                    .skip(usize::from(n.rect.x - b.x))
                    .take(usize::from(n.rect.width))
                    .collect();
                let r = n.rect;
                (
                    n.actions[0].id.as_str().to_owned(),
                    Rect::new(r.x, r.y, r.width, r.height),
                    drawn,
                )
            })
            .collect()
    }
}

fn kinds(fx: &[Effect]) -> Vec<EffectKind> {
    fx.iter().map(Effect::kind).collect()
}

/// Every button is inside the body, drawn whole in brackets, and clear of the
/// others; a click on it does what the action does.
fn check_buttons(make: &dyn Fn(u16) -> Rig, prefix: &str, width: u16) {
    let rig = make(width);
    let b = rig.body();
    let all = rig.buttons(prefix);
    assert!(!all.is_empty(), "{prefix} at {width}");
    for (i, (action, rect, drawn)) in all.iter().enumerate() {
        assert!(
            rect.x >= b.x && rect.x + rect.width <= b.x + b.width,
            "{action} at {width}: {rect:?} outside {b:?}"
        );
        assert!(
            drawn.starts_with('[') && drawn.ends_with(']'),
            "{action} at {width} is cut: {drawn:?}"
        );
        for (other, r2, _) in &all[i + 1..] {
            let apart = rect.y != r2.y || rect.x + rect.width < r2.x || r2.x + r2.width < rect.x;
            assert!(apart, "{action} and {other} overlap at {width}");
        }
        let mut clicked = make(width);
        let fx = clicked.click(rect.x - b.x + rect.width / 2, rect.y - b.y, 1);
        let mut chorded = make(width);
        let expected = act(&mut chorded, action);
        assert_eq!(kinds(&fx), kinds(&expected), "{action} at {width}");
        assert_eq!(clicked.screen(), chorded.screen(), "{action} at {width}");
    }
}

fn held(width: u16) -> Rig {
    let mut rig = Rig::opened("hello\n").at(width);
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "invalid".into(),
            reason: "that edit is not allowed here at all".into(),
        },
        None,
    );
    rig
}

#[test]
fn every_control_of_the_held_bar_is_whole_and_works_at_any_width() {
    for w in WIDTHS {
        check_buttons(&held, "strip:", w);
        // All four choices are there, whatever the width.
        assert_eq!(held(w).buttons("strip:").len(), 4, "{w}");
    }
}

#[test]
fn the_held_bar_keeps_the_key_hint_while_the_label_fits_with_it() {
    let at80 = held(80).buttons("strip:");
    assert!(at80.iter().all(|(_, _, d)| d.contains(" Alt+")), "{at80:?}");
    // At 24 columns "[Keep my text Alt+M]" still fits; a long one loses its
    // hint before its label.
    let disk = |w| {
        let mut rig = Rig::opened("hello\n").at(w);
        rig.host(HostMessage::DocumentConflict {
            resource: doc(),
            revision: seq(2),
            disk_deleted: false,
        });
        rig
    };
    let drawn: Vec<String> = disk(24)
        .buttons("strip:")
        .into_iter()
        .map(|b| b.2)
        .collect();
    assert!(
        drawn.iter().any(|d| d == "[Take the file on disk]"),
        "{drawn:?}"
    );
    for w in WIDTHS {
        check_buttons(&disk, "strip:", w);
    }
}

fn dirty_at(width: u16) -> Rig {
    let mut rig = Rig::opened("hello\n").at(width);
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.accept(&e, 2);
    rig
}

#[test]
fn the_status_line_keeps_position_and_state_and_shortens_the_path() {
    for w in WIDTHS {
        let rig = dirty_at(w);
        let b = rig.body();
        let rows = rig.rows(b.width, b.height);
        let line = rows.last().unwrap();
        assert!(line.contains("Ln 1, Col 2"), "{w}: {line:?}");
        assert!(line.contains("[modified]"), "{w}: {line:?}");
        assert!(line.width() <= usize::from(w), "{w}: {line:?}");
        if w >= 43 {
            assert!(line.contains("a.txt"), "{w}: {line:?}");
        } else {
            // No room for the name beside the rest: one cell remains for it.
            assert!(line.starts_with('\u{2026}'), "{w}: {line:?}");
        }
    }
}

#[test]
fn a_notice_that_does_not_fit_beside_the_status_wraps_above_it() {
    for w in WIDTHS {
        let mut rig = dirty_at(w);
        let save = one(&rig.chord('s'), EffectKind::DocumentSave);
        rig.answer(
            &save,
            Outcome::Refused {
                code: "disk_full".into(),
                reason: "the disk is full on the machine that holds this file".into(),
            },
            None,
        );
        let status = rig.status();
        assert!(
            status.contains("Not saved: the disk is full on the machine that holds this file"),
            "{w}: {status}"
        );
        assert!(status.contains("[modified]"), "{w}: {status}");
        rig.tree_ok();
    }
}

#[test]
fn the_read_only_reason_is_not_cut_at_any_width() {
    for w in WIDTHS {
        let mut rig = Rig::start().at(w);
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
                    reason: "a generated file that the build owns".into(),
                }),
            })),
        );
        rig.typed("x");
        let status = rig.status();
        assert!(status.contains("read-only"), "{w}: {status}");
        assert!(
            status.contains("a generated file that the build owns"),
            "{w}: {status}"
        );
    }
}

#[test]
fn the_find_bar_keeps_room_for_the_query_and_its_replace_buttons_whole() {
    let make = |w: u16| {
        let mut rig = Rig::opened("cat cat\n").at(w);
        rig.chord('h');
        rig.typed("cat");
        rig
    };
    for w in WIDTHS {
        let rig = make(w);
        let b = rig.body();
        let rows = rig.rows(b.width, b.height);
        assert!(rows[0].starts_with("Find cat"), "{w}: {:?}", rows[0]);
        assert!(rows[0].contains(" of 2"), "{w}: {:?}", rows[0]);
        check_buttons(&make, "find:", w);
    }
}

// ---- local state, recovered edits, revoked access --------------------------

use theorem_workbench_core::host::{LocalProblem, LocalState, LocalStatus};

fn recovered_edit(id: &str, base: u64, at: u32, insert: &str) -> PendingEdit {
    PendingEdit {
        operation_id: id.into(),
        base_revision: seq(base),
        edits: vec![CoreChange {
            start: at,
            end: at,
            insert: insert.into(),
        }],
        state: PendingState::Restored,
        reason: None,
    }
}

/// The owner opens the document with `pending` it got back from the device.
fn open_with(rig: &mut Rig, text: &str, revision: u64, pending: Vec<PendingEdit>) -> Vec<Effect> {
    let open = rig.open.take().expect("an open is waiting");
    let c = Completion::new(open.id, doc(), Outcome::Accepted).with_payload(
        CompletionPayload::DocumentOpened(DocumentOpened {
            text: text.into(),
            revision: seq(revision),
            saved_revision: None,
            dirty: true,
            read_only: None,
            pending,
        }),
    );
    rig.send(Msg::Completion(c))
}

fn settles(fx: &[Effect]) -> Vec<String> {
    of_kind(fx, EffectKind::DocumentSettle)
        .into_iter()
        .map(|e| match &e.body {
            EffectBody::DocumentSettle(s) => s.operation_id.clone(),
            _ => unreachable!(),
        })
        .collect()
}

fn answer_all(rig: &mut Rig, fx: &[Effect]) -> Vec<Effect> {
    let mut out = vec![];
    for e in fx {
        out.extend(rig.answer(e, Outcome::Accepted, None));
    }
    out
}

fn recovered_rig(width: u16) -> Rig {
    let mut rig = Rig::start().at(width);
    let fx = open_with(
        &mut rig,
        "hello\n",
        1,
        vec![recovered_edit("r1", 1, 0, "X")],
    );
    assert!(edits(&fx).is_empty() && settles(&fx).is_empty(), "{fx:#?}");
    rig
}

#[test]
fn a_recovered_edit_on_the_same_revision_is_shown_and_nothing_is_sent_before_a_choice() {
    let mut rig = recovered_rig(80);
    assert!(rig.screen().contains("Xhello"), "{}", rig.screen());
    let ids: Vec<String> = rig
        .buttons("strip:")
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    assert_eq!(
        ids,
        [
            "document.keepRecovered",
            "document.discardRecovered",
            "document.copyRecovered"
        ]
    );
    assert!(rig.status().contains("recovered"), "{}", rig.status());
    let bar = rig.screen();
    assert!(bar.contains("recovered from this device"), "{bar}");
    assert!(bar.contains("Keep recovered"), "{bar}");
    assert!(bar.contains("Discard recovered"), "{bar}");
    // Ticks, typing and a save send nothing: the owner refuses edits until
    // each recovered one is settled.
    let mut fx = rig.tick();
    fx.extend(rig.typed("Q"));
    fx.extend(rig.chord('s'));
    assert!(edits(&fx).is_empty(), "{fx:#?}");
    none_of(&fx, EffectKind::DocumentSave);
    none_of(&fx, EffectKind::DocumentSettle);
    // The undo history starts after the recovery: it cannot take the text back.
    rig.chord('z');
    rig.chord('z');
    assert!(rig.screen().contains("Xhello"), "{}", rig.screen());
    rig.tree_ok();
}

#[test]
fn keeping_recovered_edits_settles_each_then_sends_the_text_once() {
    let mut rig = recovered_rig(80);
    let fx = act(&mut rig, "document.keepRecovered");
    assert_eq!(settles(&fx), ["r1"], "{fx:#?}");
    assert!(
        edits(&fx).is_empty(),
        "the edit waits for the settle: {fx:#?}"
    );
    let mut sent = rig.tick();
    assert!(edits(&sent).is_empty());
    sent.extend(answer_all(&mut rig, &fx));
    let e = the_edit(&sent);
    let EffectBody::DocumentEdit(body) = &e.body else {
        unreachable!()
    };
    assert_eq!(body.edits.len(), 1);
    assert_eq!(
        (
            body.edits[0].start,
            body.edits[0].end,
            body.edits[0].insert.as_str()
        ),
        (0, 0, "X")
    );
    assert_eq!(e.revision, Some(seq(1)));
    // Accepted, and nothing more goes out.
    let after = rig.accept(&e, 2);
    let more = rig.tick();
    assert!(edits(&after).is_empty() && edits(&more).is_empty());
    assert!(rig.screen().contains("Xhello"));
}

#[test]
fn discarding_recovered_edits_sends_only_the_settles_and_drops_the_text() {
    let mut rig = recovered_rig(80);
    let fx = act(&mut rig, "document.discardRecovered");
    assert_eq!(settles(&fx), ["r1"]);
    assert!(edits(&fx).is_empty());
    let rest = answer_all(&mut rig, &fx);
    assert!(edits(&rest).is_empty(), "{rest:#?}");
    assert!(edits(&rig.tick()).is_empty());
    let screen = rig.screen();
    assert!(
        screen.contains("hello") && !screen.contains("Xhello"),
        "{screen}"
    );
    assert!(
        rig.buttons("strip:")
            .iter()
            .all(|(id, _, _)| id != "document.keepRecovered")
    );
    // Typing works as before, from the file's text.
    let e = the_edit(&rig.typed("Q"));
    let EffectBody::DocumentEdit(body) = &e.body else {
        unreachable!()
    };
    assert_eq!(body.edits[0].insert, "Q");
}

fn moved_rig(width: u16) -> Rig {
    let mut rig = Rig::start().at(width);
    let fx = open_with(
        &mut rig,
        "hello\n",
        5,
        vec![recovered_edit("r1", 2, 0, "X")],
    );
    assert!(edits(&fx).is_empty() && settles(&fx).is_empty(), "{fx:#?}");
    rig
}

#[test]
fn recovered_edits_from_another_revision_are_not_applied_blindly() {
    let mut rig = moved_rig(80);
    let screen = rig.screen();
    assert!(
        screen.contains("hello") && !screen.contains("Xhello"),
        "{screen}"
    );
    assert!(screen.contains("revision 2"), "{screen}");
    let ids: Vec<String> = rig
        .buttons("strip:")
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    assert_eq!(
        ids,
        [
            "document.takeTheirs",
            "document.keepBoth",
            "document.copyMine"
        ]
    );
    // Nothing is sent, typing included.
    let mut fx = rig.tick();
    fx.extend(rig.typed("Q"));
    assert!(edits(&fx).is_empty() && settles(&fx).is_empty(), "{fx:#?}");
    // The keep action that would place them is refused with its reason.
    let fx = act(&mut rig, "document.keepMine");
    assert!(edits(&fx).is_empty() && settles(&fx).is_empty());
    assert!(
        rig.status().contains("another revision"),
        "{}",
        rig.status()
    );
}

#[test]
fn unplaced_recovered_edits_are_discarded_or_added_after_the_text() {
    let mut rig = moved_rig(80);
    let fx = act(&mut rig, "document.takeTheirs");
    assert_eq!(settles(&fx), ["r1"]);
    assert!(edits(&answer_all(&mut rig, &fx)).is_empty());
    assert!(!rig.screen().contains('X'), "{}", rig.screen());

    let mut rig = moved_rig(80);
    let fx = act(&mut rig, "document.keepBoth");
    assert_eq!(settles(&fx), ["r1"]);
    assert!(edits(&fx).is_empty());
    let sent = answer_all(&mut rig, &fx);
    let e = the_edit(&sent);
    let EffectBody::DocumentEdit(body) = &e.body else {
        unreachable!()
    };
    assert_eq!(body.edits[0].insert, "X");
    assert_eq!(e.revision, Some(seq(5)));
    assert!(rig.screen().contains("hello"), "{}", rig.screen());
}

#[test]
fn the_caret_sits_at_the_end_of_the_last_recovered_change() {
    let mut rig = Rig::start().at(80);
    let two = PendingEdit {
        edits: vec![
            CoreChange {
                start: 0,
                end: 0,
                insert: "ab".into(),
            },
            CoreChange {
                start: 3,
                end: 3,
                insert: "Z".into(),
            },
        ],
        ..recovered_edit("r1", 1, 0, "")
    };
    open_with(&mut rig, "hello\n", 1, vec![two]);
    assert!(rig.screen().contains("abhelZlo"), "{}", rig.screen());
    // The caret is after the Z: what is typed next lands there.
    rig.typed("Q");
    assert!(rig.screen().contains("abhelZQlo"), "{}", rig.screen());
}

#[test]
fn keep_and_discard_recovered_answer_alt_j_and_alt_g() {
    let mut rig = recovered_rig(80);
    let fx = rig.mods(Key::Char('j'), Mods::ALT);
    assert_eq!(settles(&fx), ["r1"], "{fx:#?}");
    let mut rig = recovered_rig(80);
    let fx = rig.mods(Key::Char('g'), Mods::ALT);
    assert_eq!(settles(&fx), ["r1"], "{fx:#?}");
    // The old chords are not bound.
    let mut rig = recovered_rig(80);
    let fx = rig.mods(Key::Char('e'), Mods::ALT);
    assert!(settles(&fx).is_empty(), "{fx:#?}");
}

#[test]
fn copy_sends_the_recovered_text_to_the_clipboard() {
    for id in ["document.copyRecovered", "document.copyMine"] {
        let mut rig = recovered_rig(80);
        let fx = act(&mut rig, id);
        let writes = of_kind(&fx, EffectKind::ClipboardWrite);
        assert_eq!(writes.len(), 1, "{id}: {fx:#?}");
        let EffectBody::ClipboardWrite(w) = &writes[0].body else {
            unreachable!()
        };
        assert_eq!(w.text, "X");
    }
}

/// What a person sees and a reader of the tree hears for the local state and
/// the recovered bar, as lines. The Markdown panel's test builds the same lines
/// from the same input and compares them with the same list.
fn shared_words(rig: &mut Rig, local: HostMessage) -> Vec<String> {
    rig.host(local);
    let node = rig.node("local");
    vec![
        format!("local.name = {}", node.name),
        format!(
            "local.description = {}",
            node.state.description.unwrap_or_default()
        ),
    ]
}

fn bar_words(rig: &Rig) -> Vec<String> {
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
}

#[test]
fn the_words_and_choices_for_local_state_and_recovered_edits_are_the_markdown_panels() {
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
        let mut rig = Rig::opened("hello\n").at(80);
        got.extend(shared_words(&mut rig, local(status, problem)));
    }
    got.extend(bar_words(&recovered_rig(80)));
    got.extend(bar_words(&moved_rig(80)));
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

fn message_has_problem(m: &HostMessage) -> bool {
    matches!(m, HostMessage::DocumentLocal { local, .. } if local.problem.is_some())
}

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

#[test]
fn the_local_state_is_said_in_plain_words_at_80_and_40_columns() {
    let checkpointed = LocalStatus::Checkpointed {
        saved_at_ms: 1,
        recovered: false,
    };
    // (state, words at 80, words at 40, what must not be claimed)
    let cases: [(HostMessage, &str, &str, &[&str]); 4] = [
        (
            local(LocalStatus::Accepted, None),
            "",
            "",
            &["kept", "not kept"],
        ),
        (
            local(LocalStatus::Draft, None),
            "edits not yet kept on this device",
            "not kept yet",
            &["kept on this device,"],
        ),
        (
            local(checkpointed.clone(), None),
            "kept on this device, not saved to the file",
            "kept, unsaved",
            &["not kept"],
        ),
        (
            local(checkpointed, Some(("quota", "storage is full"))),
            "not kept: storage is full; only in this page",
            "not kept",
            &["kept on this device,"],
        ),
    ];
    for (message, at80, at40, never) in cases {
        for (width, words) in [(80, at80), (40, at40)] {
            // At 40 columns typing makes it modified and sending: the fullest
            // line, where the flags must say less and the words still hold.
            let mut rig = Rig::opened("hello\n").at(width);
            if width == 40 {
                rig.typed("x");
            }
            rig.host(message.clone());
            let status = rig.status();
            assert!(
                status.contains(words),
                "{width}: {words:?} not in {status:?}"
            );
            if message_has_problem(&message) {
                // The reason stays in view at any width.
                assert!(status.contains("storage is full"), "{width}: {status:?}");
            }
            for no in never {
                assert!(!status.contains(no), "{width}: {no:?} in {status:?}");
            }
            // The semantic tree says it too, in full.
            let tree = semantics(&rig.m);
            let node = tree
                .node(&NodeId::new(format!("{}/text", rig.id.as_str())))
                .expect("the text node");
            let description = node.state.description.clone().unwrap_or_default();
            let full = match &message {
                HostMessage::DocumentLocal { local, .. } => match (&local.problem, &local.status) {
                    (Some(p), _) => p.reason.clone(),
                    (None, LocalStatus::Draft) => "not yet kept on this device".into(),
                    (None, LocalStatus::Checkpointed { .. }) => {
                        "kept on this device, not saved to the file".into()
                    }
                    _ => String::new(),
                },
                _ => unreachable!(),
            };
            assert!(description.contains(&full), "{width}: {description:?}");
            rig.tree_ok();
        }
    }
}

#[test]
fn a_local_state_for_another_document_is_not_shown() {
    let mut rig = Rig::opened("hello\n").at(80);
    rig.host(HostMessage::DocumentLocal {
        resource: ResourceRef::Document {
            workspace: "w".into(),
            resource_id: "other.txt".into(),
        },
        local: LocalState {
            status: LocalStatus::Draft,
            problem: None,
        },
    });
    assert!(!rig.status().contains("kept"), "{}", rig.status());
}

#[test]
fn revoked_access_clears_the_text_and_held_edits_and_nothing_more_is_sent() {
    for code in [
        "forbidden",
        "unauthorized",
        "signed_out",
        "account_changed",
        "access_revoked",
    ] {
        let drafts = Drafts::new();
        let mut rig = Rig::start_with(&CAPS, &drafts);
        rig.answer_open("secret text\n", 1, true);
        let first = the_edit(&rig.typed("A"));
        // A second edit waits behind the first.
        rig.typed("B");
        rig.answer(
            &first,
            Outcome::Refused {
                code: code.into(),
                reason: "your access to this file ended".into(),
            },
            None,
        );
        let screen = rig.screen();
        assert!(!screen.contains("secret"), "{code}: {screen}");
        assert!(!screen.contains("AB"), "{code}: {screen}");
        assert!(screen.contains("no longer have access"), "{code}: {screen}");
        assert!(
            screen.contains("your access to this file ended"),
            "{code}: {screen}"
        );
        assert!(drafts.is_empty(), "{code}: nothing is kept in memory");
        // A following key, a chord and a tick send nothing at all.
        let mut fx = rig.typed("Z");
        fx.extend(rig.chord('s'));
        fx.extend(rig.tick());
        assert!(
            fx.iter().all(|e| !matches!(
                e.kind(),
                EffectKind::DocumentEdit | EffectKind::DocumentSave | EffectKind::DocumentSettle
            )),
            "{code}: {fx:#?}"
        );
        rig.tree_ok();
    }
}

#[test]
fn other_refusals_keep_the_text_as_before() {
    let mut rig = Rig::opened("hello\n");
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Refused {
            code: "invalid".into(),
            reason: "that edit is not allowed".into(),
        },
        None,
    );
    assert!(rig.screen().contains("Xhello"), "{}", rig.screen());
}

#[test]
fn a_revoked_open_shows_the_reason_and_cannot_be_retried() {
    let mut rig = Rig::start();
    let open = rig.open.take().unwrap();
    rig.answer(
        &open,
        Outcome::Refused {
            code: "signed_out".into(),
            reason: "you were signed out".into(),
        },
        None,
    );
    let screen = rig.screen();
    assert!(screen.contains("you were signed out"), "{screen}");
    assert!(screen.contains("no longer have access"), "{screen}");
    let fx = rig.key(Key::Enter);
    assert!(of_kind(&fx, EffectKind::DocumentOpen).is_empty(), "{fx:#?}");
}

#[test]
fn the_recovered_bars_are_whole_and_work_at_any_width() {
    for w in WIDTHS {
        check_buttons(&recovered_rig, "strip:", w);
        assert_eq!(recovered_rig(w).buttons("strip:").len(), 3, "{w}");
        check_buttons(&moved_rig, "strip:", w);
        assert_eq!(moved_rig(w).buttons("strip:").len(), 3, "{w}");
    }
}

// ---- Option chords on a Mac -------------------------------------------------

fn option(c: char) -> KeyInput {
    KeyInput::new(Key::Char(c), Mods::ALT)
}

#[test]
fn takes_chord_answers_for_conflict_chords_only_while_text_is_held() {
    let mut rig = Rig::opened("hello\n");
    for c in ['m', 't', 'b', 'y'] {
        assert!(!rig.m.takes_chord(&option(c)), "{c}: nothing is held");
    }
    conflicted(&mut rig);
    for c in ['m', 't', 'b', 'y'] {
        assert!(rig.m.takes_chord(&option(c)), "{c}: text is held");
    }
}

#[test]
fn takes_chord_answers_for_recovered_edit_chords_only_while_they_wait() {
    let rig = recovered_rig(80);
    for c in ['j', 'g'] {
        assert!(rig.m.takes_chord(&option(c)), "{c}: an offer is showing");
    }
    let rig = Rig::opened("hello\n");
    for c in ['j', 'g'] {
        assert!(!rig.m.takes_chord(&option(c)), "{c}: no offer");
    }
}

#[test]
fn takes_chord_answers_for_resend_only_while_an_edit_is_unknown() {
    let mut rig = Rig::opened("hello\n");
    assert!(!rig.m.takes_chord(&option('r')));
    let e = the_edit(&rig.key(Key::Char('X')));
    rig.answer(
        &e,
        Outcome::Uncertain {
            reason: "the connection dropped".into(),
        },
        None,
    );
    assert!(rig.m.takes_chord(&option('r')));
}

#[test]
fn takes_chord_answers_for_find_case_only_while_find_is_open() {
    let mut rig = Rig::opened("alpha\n");
    assert!(!rig.m.takes_chord(&option('c')));
    rig.chord('f');
    assert!(rig.m.takes_chord(&option('c')));
    assert!(rig.m.takes_chord(&option('C')));
    rig.key(Key::Esc);
    assert!(!rig.m.takes_chord(&option('c')));
}

#[test]
fn takes_chord_answers_for_shifted_format_and_leaves_a_plain_option_letter_to_type() {
    let rig = Rig::opened("hello\n");
    // KeyInput drops Shift from a character key; Shift is the capital letter.
    assert!(rig.m.takes_chord(&option('F')));
    assert!(!rig.m.takes_chord(&option('f')), "format needs Shift");
    for c in ['q', 'e', 'n', 'z', '1', '['] {
        assert!(!rig.m.takes_chord(&option(c)), "{c}");
    }
}

#[test]
fn takes_chord_is_false_while_the_rename_name_is_typed() {
    let mut rig = Rig::opened("hello\n");
    assert!(rig.m.takes_chord(&option('h')), "hover, before the rename");
    rig.key(Key::F2);
    assert!(!rig.m.takes_chord(&option('h')), "the name takes every key");
}
