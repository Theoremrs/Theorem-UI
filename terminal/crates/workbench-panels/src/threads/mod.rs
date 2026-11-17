//! The Threads panel: the account's threads by project, and the Herdr
//! sessions of the person's machines.
//!
//! The panel lists, selects and asks. The owner (`threads*` effects) lists and
//! writes, and says what changed by `ThreadsChanged`; the panel never changes a
//! row on a guess. A thread row asks Theo to open the thread (`Ctx::switch_conversation`);
//! a Herdr row opens its session as a terminal tab in the main region
//! (`OpenTarget::Terminal`), or first asks the host to admit it (`terminalAdmit`)
//! when the session is on the person's Herdr and not yet in this workspace.
//!
//! Every action is offered only where its capability is granted: the menu lists
//! only what the host allows, so a gap is an absent row and not a note.

mod draw;
mod rows;

use std::collections::{BTreeMap, BTreeSet};

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{
    ClipboardWrite, Effect, EffectBody, TerminalAdmit, ThreadRef, ThreadsArchive, ThreadsCreate,
    ThreadsPin, ThreadsRename, ThreadsTag, ThreadsUnread,
};
use theorem_workbench_core::host::{HostMessage, TerminalSessionInfo};
use theorem_workbench_core::ids::{Capability, EffectId, ResourceRef};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::threads::{ThreadItem, ThreadListing, ThreadTag};
use theorem_workbench_core::{
    Button, Ctx, OpenTarget, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, ViewCtx,
};
use theorem_workbench_text::field::{Field, Keyed};
use theorem_workbench_text::visible::visible;

use crate::clip::{FieldClip, Settled, finish_cut, not_done};
use rows::{Open, Row, herdr, threads};

pub(crate) fn register(factories: &mut PanelFactories) {
    factories.register("threads", |state, _version| {
        Box::new(ThreadsPanel::restore(state))
    });
}

/// What a request the panel sent is for.
#[derive(Clone, Debug)]
enum Pending {
    List,
    Create,
    Markdown,
    /// A write, by the verb a refusal names ("rename").
    Write(&'static str),
    Clip,
    Admit(String),
}

impl Pending {
    fn verb(&self) -> &'static str {
        match self {
            Self::List => "list threads",
            Self::Create => "start a thread",
            Self::Markdown => "copy",
            Self::Write(verb) => verb,
            Self::Clip => "copy",
            Self::Admit(_) => "admit the session",
        }
    }
}

struct Edit {
    thread: String,
    input: Field,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Choice {
    Action(&'static str),
    Tag(Option<ThreadTag>),
}

struct Menu {
    items: Vec<(Choice, String)>,
    at: usize,
}

enum Mode {
    Browse,
    Edit(Edit),
    /// Delete this thread (its id)?
    Confirm(String),
    Menu(Menu),
    Details(String),
}

pub struct ThreadsPanel {
    listing: Option<ThreadListing>,
    sessions: Vec<TerminalSessionInfo>,
    /// Keys whose open state is not the default.
    toggled: BTreeSet<String>,
    selected: Option<String>,
    show_archived: bool,
    scroll: usize,
    body: Rect,
    mode: Mode,
    pending: BTreeMap<EffectId, Pending>,
    field_clip: FieldClip<()>,
    asked: bool,
    /// The thread the owner last said is open; the cursor follows a change of it.
    open_thread: Option<(String, String)>,
    /// Sessions asked to be admitted that open once they are.
    admitting: BTreeSet<String>,
    banner: Option<String>,
    focused: bool,
    /// Where the cursor last stood: its row's index and, on a thread's row, the thread. A cursor
    /// whose row is gone goes to the same thread's other row, or else to the nearest row.
    stood: (usize, Option<String>),
}

/// The capability an action needs: what the registry says too.
fn needs(action: &str) -> &'static str {
    match action {
        "threads.new" => "threads.create",
        "threads.rename" => "threads.rename",
        "threads.archive" | "threads.unarchive" => "threads.archive",
        "threads.delete" => "threads.delete",
        "threads.copy-markdown" => "threads.markdown",
        "threads.pin" | "threads.unpin" => "threads.pin",
        "threads.tag" | "threads.untag" => "threads.tags",
        "threads.unread" | "threads.read" => "threads.unread",
        "threads.retitle" => "threads.retitle",
        "threads.admit" => "terminal.admit",
        _ => "threads",
    }
}

fn tag_label(tag: ThreadTag) -> String {
    let name = tag.name();
    let mut c = name.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

impl ThreadsPanel {
    fn restore(state: &Value) -> Self {
        Self {
            listing: None,
            sessions: vec![],
            toggled: state["toggled"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            selected: state["selected"].as_str().map(str::to_owned),
            show_archived: state["archived"].as_bool().unwrap_or(false),
            scroll: 0,
            body: Rect::default(),
            mode: Mode::Browse,
            pending: BTreeMap::new(),
            field_clip: FieldClip::default(),
            asked: false,
            open_thread: None,
            admitting: BTreeSet::new(),
            banner: None,
            focused: false,
            stood: (0, None),
        }
    }

    // ---- rows ------------------------------------------------------------------

    fn open_state(&self) -> Open<'_> {
        Open {
            toggled: &self.toggled,
            archived: self.show_archived,
        }
    }

    /// Every row, with the rename field and the delete question in place.
    fn rows(&self) -> Vec<Row> {
        let mut rows = match &self.listing {
            Some(l) => threads(l, &self.open_state()),
            None => vec![
                Row::Label {
                    id: "projects",
                    text: "Projects",
                },
                Row::Status {
                    id: "loading".into(),
                    text: "Loading threads".into(),
                },
            ],
        };
        rows.extend(herdr(&self.sessions));
        match &self.mode {
            Mode::Edit(edit) => {
                if let Some(at) = rows.iter().position(|r| self.is_thread(r, &edit.thread)) {
                    let depth = rows[at].depth();
                    rows[at] = Row::Edit { depth };
                }
            }
            Mode::Confirm(id) => {
                if let Some(at) = rows.iter().position(|r| self.is_thread(r, id)) {
                    let title = self.thread_by_id(id).map_or("", |t| t.title.as_str());
                    rows.insert(
                        at + 1,
                        Row::Confirm {
                            text: format!(
                                "Delete \"{}\"? Enter deletes, Esc keeps",
                                visible(title)
                            ),
                        },
                    );
                }
            }
            _ => {}
        }
        rows
    }

    /// Whether `row` is the first thread row of thread `id`.
    fn is_thread(&self, row: &Row, id: &str) -> bool {
        let Some(l) = &self.listing else {
            return false;
        };
        matches!(row, Row::Thread { idx, key, .. }
            if l.threads[*idx].id == id && self.selected.as_deref() == Some(key.as_str()))
    }

    fn thread_by_id(&self, id: &str) -> Option<&ThreadItem> {
        self.listing.as_ref()?.threads.iter().find(|t| t.id == id)
    }

    fn cursor(&self, rows: &[Row]) -> Option<usize> {
        let key = self.selected.as_deref()?;
        rows.iter().position(|r| r.key() == Some(key))
    }

    fn cursor_row(&self) -> Option<Row> {
        let rows = self.rows();
        self.cursor(&rows).map(|i| rows[i].clone())
    }

    /// The thread under the cursor and the project it is under.
    fn cursor_thread(&self) -> Option<(ThreadItem, String)> {
        let l = self.listing.as_ref()?;
        match self.cursor_row()? {
            Row::Thread { idx, project, .. } | Row::Delegation { idx, project, .. } => {
                Some((l.threads[idx].clone(), project))
            }
            _ => None,
        }
    }

    fn viewport(&self) -> usize {
        usize::from(self.body.height).saturating_sub(usize::from(self.banner.is_some()))
    }

    fn header(&self) -> usize {
        usize::from(self.banner.is_some())
    }

    fn selectable(rows: &[Row]) -> Vec<usize> {
        (0..rows.len())
            .filter(|&i| rows[i].key().is_some())
            .collect()
    }

    // ---- cursor and scroll -----------------------------------------------------

    fn step(&mut self, to: impl FnOnce(Option<usize>, usize) -> usize) {
        let rows = self.rows();
        let keys = Self::selectable(&rows);
        if keys.is_empty() {
            return;
        }
        let at = self
            .cursor(&rows)
            .and_then(|r| keys.iter().position(|&k| k == r));
        let next = to(at, keys.len()).min(keys.len() - 1);
        self.selected = rows[keys[next]].key().map(str::to_owned);
        self.ensure_visible();
    }

    /// Keeps the cursor's row on screen and never leaves the pane's foot empty while rows above
    /// it are cut off. A pane that has not been given a height yet has nothing to scroll in.
    fn ensure_visible(&mut self) {
        let rows = self.rows();
        if let Some(at) = self.cursor(&rows) {
            let thread = match (&rows[at], &self.listing) {
                (Row::Thread { idx, .. }, Some(l)) => Some(l.threads[*idx].id.clone()),
                _ => None,
            };
            self.stood = (at, thread);
        }
        let room = self.viewport();
        if room == 0 {
            self.scroll = 0;
            return;
        }
        self.scroll = self.scroll.min(rows.len().saturating_sub(1));
        if let Some(at) = self.cursor(&rows) {
            if at < self.scroll {
                self.scroll = at;
            }
            // Scroll down until the cursor row (all its lines) fits.
            while self.scroll < at {
                let used: usize = rows[self.scroll..=at].iter().map(Row::height).sum();
                if used <= room {
                    break;
                }
                self.scroll += 1;
            }
        }
        while self.scroll > 0 {
            let used: usize = rows[self.scroll - 1..].iter().map(Row::height).sum();
            if used > room {
                break;
            }
            self.scroll -= 1;
        }
    }

    fn clamp_scroll(&mut self) {
        let rows = self.rows();
        self.scroll = self.scroll.min(rows.len().saturating_sub(1));
    }

    /// The row at body row `y`, with the row index and its first body row.
    fn row_at(&self, y: i32) -> Option<(usize, Row)> {
        let rows = self.rows();
        let mut top = self.header() as i32;
        for (i, row) in rows.iter().enumerate().skip(self.scroll) {
            let h = row.height() as i32;
            if y >= top && y < top + h {
                return Some((i, row.clone()));
            }
            top += h;
        }
        None
    }

    // ---- state from the host ---------------------------------------------------

    fn on_listing(&mut self, listing: ThreadListing) {
        if let Some(held) = &self.listing
            && listing.as_of_ms < held.as_of_ms
        {
            return;
        }
        let opened = listing
            .open
            .as_ref()
            .map(|o| (o.project_id.clone(), o.thread_id.clone()));
        let changed_open = opened != self.open_thread;
        self.listing = Some(listing);
        if changed_open {
            self.open_thread = opened.clone();
            if let Some((project, thread)) = opened {
                self.select_thread(&project, &thread);
            }
        }
        self.keep_cursor();
        self.ensure_visible();
    }

    /// Put the cursor on `thread`'s row, under `project` when it has one there.
    fn select_thread(&mut self, project: &str, thread: &str) {
        let rows = self.rows();
        let Some(l) = &self.listing else { return };
        let found = rows.iter().find(|r| {
            matches!(r, Row::Thread { idx, project: p, key, .. }
                if l.threads[*idx].id == thread && p == project && !key.starts_with("pin:"))
        });
        let found = found.or_else(|| {
            rows.iter()
                .find(|r| matches!(r, Row::Thread { idx, .. } if l.threads[*idx].id == thread))
        });
        if let Some(key) = found.and_then(Row::key) {
            self.selected = Some(key.to_owned());
        }
    }

    /// A cursor on a row that is gone follows its thread to the row the thread has now (a pinned
    /// thread leaves its project for Pinned, and back), or else moves to the nearest row.
    fn keep_cursor(&mut self) {
        let rows = self.rows();
        let keys = Self::selectable(&rows);
        if keys.is_empty() {
            self.selected = None;
            return;
        }
        if self.cursor(&rows).is_none() {
            let (was, thread) = &self.stood;
            let same = thread.as_ref().and_then(|id| {
                let l = self.listing.as_ref()?;
                keys.iter().copied().find(
                    |&i| matches!(&rows[i], Row::Thread { idx, .. } if &l.threads[*idx].id == id),
                )
            });
            let near = keys.iter().copied().find(|&i| i >= *was);
            let at = same.or(near).unwrap_or(keys[keys.len() - 1]);
            self.selected = rows[at].key().map(str::to_owned);
        }
        self.clamp_scroll();
    }

    fn on_host(&mut self, message: HostMessage, cx: &mut Ctx) {
        match message {
            HostMessage::ThreadsChanged { listing } => self.on_listing(listing),
            HostMessage::TerminalSessions { sessions, .. } => {
                self.sessions = sessions;
                self.keep_cursor();
                self.ensure_visible();
                let ready: Vec<TerminalSessionInfo> = self
                    .sessions
                    .iter()
                    .filter(|s| s.admitted && self.admitting.contains(&s.session))
                    .cloned()
                    .collect();
                for s in ready {
                    self.admitting.remove(&s.session);
                    self.open_session(&s, cx);
                }
            }
            _ => {}
        }
    }

    // ---- sending ---------------------------------------------------------------

    fn granted(&self, cx: &Ctx, capability: &str) -> bool {
        cx.capabilities().has(&Capability::new(capability))
    }

    fn send(&mut self, cx: &mut Ctx, body: EffectBody, pending: Pending) {
        let verb = pending.verb();
        match cx.emit(|id| Effect::new(id, ResourceRef::None, body)) {
            Ok(id) => {
                self.pending.insert(id, pending);
            }
            // The environment cannot start work: the need stays and a later call asks.
            Err(theorem_workbench_core::EmitError::Silent) => {}
            Err(error) => self.banner = Some(format!("Could not {verb}: {error}")),
        }
    }

    /// The first listing, when the owner has not pushed one.
    fn request_listing(&mut self, cx: &mut Ctx) {
        if self.listing.is_some() || self.asked || !self.granted(cx, "threads") {
            return;
        }
        let before = self.pending.len();
        self.send(cx, EffectBody::ThreadsList, Pending::List);
        self.asked = self.pending.len() > before;
    }

    fn on_completion(&mut self, c: Completion, cx: &mut Ctx) {
        if let Some(settled) = self.field_clip.settle(&c) {
            return self.on_field_clip(settled);
        }
        let Some(pending) = self.pending.remove(&c.effect) else {
            return;
        };
        match (&c.outcome, &pending) {
            (Outcome::Accepted, Pending::List) => {
                if let Some(CompletionPayload::Threads(l)) = c.payload {
                    self.on_listing(l);
                }
            }
            (Outcome::Accepted, Pending::Create) => {
                if let Some(CompletionPayload::ThreadCreated(made)) = c.payload {
                    cx.switch_conversation(&made.project_id, &made.thread_id);
                }
            }
            (Outcome::Accepted, Pending::Markdown) => {
                if let Some(CompletionPayload::ThreadMarkdown(md)) = c.payload {
                    self.send(
                        cx,
                        EffectBody::ClipboardWrite(ClipboardWrite { text: md.text }),
                        Pending::Clip,
                    );
                }
            }
            (Outcome::Accepted, Pending::Admit(session)) => {
                let session = session.clone();
                match self.sessions.iter().find(|s| s.session == session).cloned() {
                    Some(s) if s.admitted => self.open_session(&s, cx),
                    // The host's next session list says it is admitted; it opens then.
                    _ => {
                        self.admitting.insert(session);
                    }
                }
            }
            (Outcome::Accepted, _) => {}
            (outcome, pending) => {
                let reason = match outcome {
                    Outcome::Refused { reason, .. }
                    | Outcome::Failed { reason }
                    | Outcome::Uncertain { reason } => reason.as_str(),
                    Outcome::Accepted => "",
                };
                self.banner = Some(format!("Could not {}: {}", pending.verb(), visible(reason)));
                if let Pending::Admit(session) = pending {
                    self.admitting.remove(session);
                }
            }
        }
    }

    fn on_field_clip(&mut self, settled: Settled<()>) {
        let Mode::Edit(edit) = &mut self.mode else {
            return;
        };
        match settled {
            Settled::Copied => {}
            Settled::Cut((), text) => {
                if finish_cut(&mut edit.input, &text) {
                    edit.error = None;
                }
            }
            Settled::Not { cut, outcome } => edit.error = Some(not_done(cut, &outcome)),
        }
    }

    // ---- acting ----------------------------------------------------------------

    fn open_session(&mut self, s: &TerminalSessionInfo, cx: &mut Ctx) {
        cx.open(OpenTarget::Terminal {
            workspace: s.workspace.clone(),
            session: s.session.clone(),
            backend: s.backend,
        });
    }

    /// Enter on the row under the cursor.
    fn activate(&mut self, cx: &mut Ctx) {
        let Some(row) = self.cursor_row() else { return };
        match row {
            Row::Project { key, open, .. } => self.toggle(&key, !open, true),
            Row::Thread { idx, project, .. } => {
                let id = self.listing.as_ref().map(|l| l.threads[idx].id.clone());
                if let Some(id) = id {
                    cx.switch_conversation(&project, &id);
                }
            }
            // What the delegation changed, in the panel a run's own card opens.
            Row::Delegation {
                delegation, run, ..
            } => cx.open(OpenTarget::Delegation {
                run_id: run,
                delegation_id: delegation,
                path: String::new(),
            }),
            Row::Session { idx, .. } => {
                let Some(s) = self.sessions.get(idx).cloned() else {
                    return;
                };
                if s.admitted {
                    self.open_session(&s, cx);
                } else if self.granted(cx, "terminal.admit") {
                    self.send(
                        cx,
                        EffectBody::TerminalAdmit(TerminalAdmit {
                            session: s.session.clone(),
                        }),
                        Pending::Admit(s.session),
                    );
                } else {
                    self.banner = Some("This session is not in this workspace".into());
                }
            }
            _ => {}
        }
    }

    fn toggle(&mut self, key: &str, open: bool, default_open: bool) {
        // Stored as a difference from the default, so a project (open by default)
        // and a thread (closed by default) share one set.
        if open == default_open {
            self.toggled.remove(key);
        } else {
            self.toggled.insert(key.to_owned());
        }
        self.keep_cursor();
        self.ensure_visible();
    }

    fn set_open(&mut self, row: &Row, open: bool) {
        match row {
            Row::Project { key, .. } => self.toggle(key, open, true),
            Row::Thread {
                key, open: Some(_), ..
            } => self.toggle(key, open, false),
            _ => {}
        }
    }

    fn expand_or_descend(&mut self) {
        let rows = self.rows();
        let Some(at) = self.cursor(&rows) else { return };
        match &rows[at] {
            Row::Project { open: false, .. }
            | Row::Thread {
                open: Some(false), ..
            } => {
                let row = rows[at].clone();
                self.set_open(&row, true);
            }
            Row::Project { open: true, .. }
            | Row::Thread {
                open: Some(true), ..
            } => {
                if let Some(next) = rows.get(at + 1).filter(|r| r.key().is_some()) {
                    self.selected = next.key().map(str::to_owned);
                    self.ensure_visible();
                }
            }
            _ => {}
        }
    }

    fn collapse_or_ascend(&mut self) {
        let rows = self.rows();
        let Some(at) = self.cursor(&rows) else { return };
        match &rows[at] {
            Row::Project { open: true, .. }
            | Row::Thread {
                open: Some(true), ..
            } => {
                let row = rows[at].clone();
                self.set_open(&row, false);
            }
            row => {
                let depth = row.depth();
                let parent = rows[..at].iter().rev().find(|r| {
                    r.key().is_some() && (r.depth() < depth || matches!(r, Row::Project { .. }))
                });
                let parent = parent.filter(|r| {
                    matches!(
                        row,
                        Row::Thread { .. } | Row::Delegation { .. } | Row::Session { .. }
                    ) && !matches!(
                        row,
                        Row::Thread {
                            second: Some(_),
                            ..
                        }
                    ) && r.key() != row.key()
                });
                if let Some(key) = parent.and_then(Row::key) {
                    self.selected = Some(key.to_owned());
                    self.ensure_visible();
                }
            }
        }
    }

    /// The actions the host allows on `row`, in menu order.
    fn menu_for(&self, cx: &Ctx, row: &Row) -> Vec<(Choice, String)> {
        let mut items: Vec<(Choice, String)> = vec![];
        let mut add = |this: &Self, action: &'static str, label: &str| {
            if this.granted(cx, needs(action)) {
                items.push((Choice::Action(action), label.to_owned()));
            }
        };
        match row {
            Row::Project { open, .. } => {
                add(self, "threads.new", "New thread");
                add(
                    self,
                    "threads.archived",
                    if self.show_archived {
                        "Hide archived threads"
                    } else {
                        "Show archived threads"
                    },
                );
                let _ = open;
            }
            Row::Thread { .. } | Row::Delegation { .. } => {
                let thread = self.cursor_thread().map(|(t, _)| t);
                let t = thread.as_ref();
                add(self, "threads.open", "Open");
                add(self, "threads.new", "New thread");
                if let Some(t) = t
                    && matches!(row, Row::Thread { .. })
                {
                    add(
                        self,
                        if t.pinned {
                            "threads.unpin"
                        } else {
                            "threads.pin"
                        },
                        if t.pinned { "Unpin" } else { "Pin" },
                    );
                    add(self, "threads.rename", "Rename");
                    add(self, "threads.tag", "Tag...");
                    if t.tag.is_some() {
                        add(self, "threads.untag", "Remove tag");
                    }
                    add(
                        self,
                        if t.unread {
                            "threads.read"
                        } else {
                            "threads.unread"
                        },
                        if t.unread {
                            "Mark as read"
                        } else {
                            "Mark as unread"
                        },
                    );
                    add(self, "threads.retitle", "Regenerate title");
                    add(
                        self,
                        if t.archived {
                            "threads.unarchive"
                        } else {
                            "threads.archive"
                        },
                        if t.archived { "Restore" } else { "Archive" },
                    );
                    add(self, "threads.copy-title", "Copy title");
                    add(self, "threads.copy-id", "Copy id");
                    add(self, "threads.copy-markdown", "Copy as Markdown");
                    add(self, "threads.details", "View details");
                    add(self, "threads.delete", "Delete");
                }
            }
            Row::Session { idx, .. } => {
                let admitted = self.sessions.get(*idx).is_none_or(|s| s.admitted);
                if admitted {
                    add(self, "threads.open", "Open in a tab");
                } else {
                    add(self, "threads.admit", "Admit to this workspace");
                }
            }
            _ => {}
        }
        items
    }

    fn open_menu(&mut self, cx: &Ctx) {
        let Some(row) = self.cursor_row() else { return };
        let items = self.menu_for(cx, &row);
        if items.is_empty() {
            return;
        }
        self.mode = Mode::Menu(Menu { items, at: 0 });
    }

    fn open_tag_menu(&mut self) {
        let mut items: Vec<(Choice, String)> = ThreadTag::ALL
            .iter()
            .map(|&t| (Choice::Tag(Some(t)), tag_label(t)))
            .collect();
        items.push((Choice::Tag(None), "No tag".into()));
        let at = self
            .cursor_thread()
            .and_then(|(t, _)| t.tag)
            .and_then(|tag| ThreadTag::ALL.iter().position(|&x| x == tag))
            .unwrap_or(0);
        self.mode = Mode::Menu(Menu { items, at });
    }

    fn choose(&mut self, choice: Choice, cx: &mut Ctx) {
        self.mode = Mode::Browse;
        match choice {
            Choice::Action(action) => self.run(action, cx),
            Choice::Tag(tag) => {
                let Some((t, _)) = self.cursor_thread() else {
                    return;
                };
                if self.granted(cx, "threads.tags") {
                    self.send(
                        cx,
                        EffectBody::ThreadsTag(ThreadsTag {
                            thread_id: t.id,
                            tag,
                        }),
                        Pending::Write("tag the thread"),
                    );
                }
            }
        }
    }

    /// An action by registry id: from the menu, a key or the palette.
    fn run(&mut self, action: &str, cx: &mut Ctx) {
        if !self.granted(cx, needs(action)) {
            self.banner = Some("Not available here".into());
            return;
        }
        self.banner = None;
        let thread = self.cursor_thread();
        let id = thread.as_ref().map(|(t, _)| t.id.clone());
        match (action, thread) {
            ("threads.open", _) => self.activate(cx),
            ("threads.menu", _) => self.open_menu(cx),
            ("threads.archived", _) => {
                self.show_archived = !self.show_archived;
                self.keep_cursor();
            }
            ("threads.new", t) => {
                let project = match self.cursor_row() {
                    Some(Row::Project { id, .. }) => Some(id),
                    _ => t.map(|(_, p)| p),
                }
                .or_else(|| {
                    self.listing
                        .as_ref()
                        .and_then(|l| l.open.as_ref().map(|o| o.project_id.clone()))
                })
                .or_else(|| {
                    self.listing
                        .as_ref()
                        .and_then(|l| l.projects.first().map(|p| p.id.clone()))
                });
                match project {
                    Some(project_id) => self.send(
                        cx,
                        EffectBody::ThreadsCreate(ThreadsCreate { project_id }),
                        Pending::Create,
                    ),
                    None => self.banner = Some("No project to start a thread in".into()),
                }
            }
            ("threads.details", Some((t, _))) => self.mode = Mode::Details(t.id),
            ("threads.rename", Some((t, _))) => {
                self.mode = Mode::Edit(Edit {
                    thread: t.id,
                    input: Field::new(&t.title),
                    error: None,
                });
            }
            ("threads.delete", Some((t, _))) => self.mode = Mode::Confirm(t.id),
            ("threads.tag", Some(_)) => self.open_tag_menu(),
            ("threads.untag", Some((t, _))) => self.send(
                cx,
                EffectBody::ThreadsTag(ThreadsTag {
                    thread_id: t.id,
                    tag: None,
                }),
                Pending::Write("remove the tag"),
            ),
            ("threads.archive" | "threads.unarchive", Some((t, _))) => {
                let archived = action == "threads.archive";
                self.send(
                    cx,
                    EffectBody::ThreadsArchive(ThreadsArchive {
                        thread_id: t.id,
                        archived,
                    }),
                    Pending::Write(if archived { "archive" } else { "restore" }),
                );
            }
            ("threads.pin" | "threads.unpin", Some((t, _))) => {
                let pinned = action == "threads.pin";
                self.send(
                    cx,
                    EffectBody::ThreadsPin(ThreadsPin {
                        thread_id: t.id,
                        pinned,
                    }),
                    Pending::Write(if pinned { "pin" } else { "unpin" }),
                );
            }
            ("threads.unread" | "threads.read", Some((t, _))) => {
                let unread = action == "threads.unread";
                self.send(
                    cx,
                    EffectBody::ThreadsUnread(ThreadsUnread {
                        thread_id: t.id,
                        unread,
                    }),
                    Pending::Write("change the unread mark"),
                );
            }
            ("threads.retitle", Some((t, _))) => self.send(
                cx,
                EffectBody::ThreadsRetitle(ThreadRef { thread_id: t.id }),
                Pending::Write("regenerate the title"),
            ),
            ("threads.copy-title", Some((t, _))) => self.send(
                cx,
                EffectBody::ClipboardWrite(ClipboardWrite { text: t.title }),
                Pending::Clip,
            ),
            ("threads.copy-id", Some((t, _))) => self.send(
                cx,
                EffectBody::ClipboardWrite(ClipboardWrite { text: t.id }),
                Pending::Clip,
            ),
            ("threads.copy-markdown", Some((t, _))) => self.send(
                cx,
                EffectBody::ThreadsMarkdown(ThreadRef { thread_id: t.id }),
                Pending::Markdown,
            ),
            ("threads.admit", _) => self.activate(cx),
            _ => {
                let _ = id;
            }
        }
    }

    // ---- keys ------------------------------------------------------------------

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        self.banner = None;
        match &self.mode {
            Mode::Edit(_) => return self.edit_key(key, cx),
            Mode::Confirm(_) => return self.confirm_key(key, cx),
            Mode::Menu(_) => return self.menu_key(key, cx),
            Mode::Details(_) => {
                if matches!(key.key(), Key::Esc | Key::Enter) {
                    self.mode = Mode::Browse;
                }
                return;
            }
            Mode::Browse => {}
        }
        let mods = key.mods();
        let command = mods.intersects(Mods::CTRL | Mods::CMD);
        if mods.contains(Mods::ALT)
            && matches!(key.key(), Key::Char(c) if c.eq_ignore_ascii_case(&'n'))
        {
            return self.run("threads.new", cx);
        }
        let page = self.viewport().saturating_sub(1).max(1);
        match key.key() {
            Key::Up => self.step(|at, n| at.map_or(n - 1, |i| i.saturating_sub(1))),
            Key::Down => self.step(|at, _| at.map_or(0, |i| i + 1)),
            Key::Home => self.step(|_, _| 0),
            Key::End => self.step(|_, n| n - 1),
            Key::PageUp => self.step(|at, _| at.unwrap_or(0).saturating_sub(page)),
            Key::PageDown => self.step(|at, _| at.unwrap_or(0) + page),
            Key::Right => self.expand_or_descend(),
            Key::Left => self.collapse_or_ascend(),
            Key::Enter => self.activate(cx),
            Key::F2 => self.run("threads.rename", cx),
            Key::Delete => self.run("threads.delete", cx),
            Key::Backspace if command => self.run("threads.delete", cx),
            Key::Menu => self.open_menu(cx),
            Key::F10 if mods.contains(Mods::SHIFT) => self.open_menu(cx),
            Key::Copy => self.run("threads.copy-title", cx),
            Key::Char(c) if command && c.eq_ignore_ascii_case(&'c') => {
                self.run("threads.copy-title", cx);
            }
            _ => {}
        }
    }

    fn menu_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let Mode::Menu(menu) = &mut self.mode else {
            return;
        };
        let last = menu.items.len().saturating_sub(1);
        match key.key() {
            Key::Esc => self.mode = Mode::Browse,
            Key::Up => menu.at = menu.at.saturating_sub(1),
            Key::Down => menu.at = (menu.at + 1).min(last),
            Key::Home => menu.at = 0,
            Key::End => menu.at = last,
            Key::Enter => {
                if let Some((choice, _)) = menu.items.get(menu.at).cloned() {
                    self.choose(choice, cx);
                }
            }
            _ => {}
        }
    }

    fn confirm_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let Mode::Confirm(id) = &self.mode else {
            return;
        };
        let id = id.clone();
        match key.key() {
            Key::Enter | Key::Char('y') => {
                self.mode = Mode::Browse;
                self.send(
                    cx,
                    EffectBody::ThreadsDelete(ThreadRef { thread_id: id }),
                    Pending::Write("delete the thread"),
                );
            }
            Key::Esc | Key::Char('n') => self.mode = Mode::Browse,
            _ => {}
        }
    }

    fn edit_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match key.key() {
            Key::Esc => self.mode = Mode::Browse,
            Key::Enter => self.commit_rename(cx),
            _ => {
                let Mode::Edit(edit) = &mut self.mode else {
                    return;
                };
                match edit.input.key(&key) {
                    Keyed::Handled => edit.error = None,
                    keyed @ (Keyed::Copy | Keyed::Cut) => {
                        let input = edit.input.clone();
                        if let Some(note) = self.field_clip.ask(cx, (), keyed, &input)
                            && let Mode::Edit(edit) = &mut self.mode
                        {
                            edit.error = Some(note);
                        }
                    }
                    Keyed::Paste | Keyed::Ignored => {}
                }
            }
        }
    }

    fn commit_rename(&mut self, cx: &mut Ctx) {
        let Mode::Edit(edit) = &mut self.mode else {
            return;
        };
        let title = edit.input.value().trim().to_owned();
        if title.is_empty() {
            edit.error = Some("A title is required".into());
            return;
        }
        let id = edit.thread.clone();
        let unchanged = self.thread_by_id(&id).is_some_and(|t| t.title == title);
        self.mode = Mode::Browse;
        if !unchanged {
            self.send(
                cx,
                EffectBody::ThreadsRename(ThreadsRename {
                    thread_id: id,
                    title,
                }),
                Pending::Write("rename the thread"),
            );
        }
    }

    fn insert_text(&mut self, text: &str) {
        if let Mode::Edit(edit) = &mut self.mode {
            let text: String = text.chars().filter(|c| !c.is_control()).collect();
            edit.input.insert(&text);
            edit.error = None;
        }
    }

    // ---- pointer ---------------------------------------------------------------

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        match p.kind {
            PointerKind::Wheel { dy, .. } => {
                let rows = self.rows().len();
                let max = rows.saturating_sub(self.viewport().max(1));
                self.scroll = (self.scroll as i64 + i64::from(dy)).clamp(0, max as i64) as usize;
            }
            PointerKind::Down(button @ (Button::Left | Button::Right)) => {
                if let Mode::Menu(menu) = &self.mode {
                    let rect = draw::menu_rect(self, menu);
                    let inside = p.x >= i32::from(rect.x)
                        && p.x < i32::from(rect.x + rect.width)
                        && p.y >= i32::from(rect.y)
                        && p.y < i32::from(rect.y + rect.height);
                    if inside && button == Button::Left {
                        let at = (p.y - i32::from(rect.y)) as usize + draw::menu_first(menu, rect);
                        if let Some((choice, _)) = menu.items.get(at).cloned() {
                            return self.choose(choice, cx);
                        }
                    }
                    self.mode = Mode::Browse;
                    return;
                }
                if !matches!(self.mode, Mode::Browse) {
                    self.mode = Mode::Browse;
                }
                self.banner = None;
                let Some((_, row)) = self.row_at(p.y) else {
                    return;
                };
                let Some(key) = row.key().map(str::to_owned) else {
                    return;
                };
                self.selected = Some(key);
                if button == Button::Right {
                    return self.open_menu(cx);
                }
                let mark_end = (row.depth() * 2 + 1 + 2) as i32;
                let on_mark = p.x >= (row.depth() * 2 + 1) as i32 && p.x < mark_end;
                match &row {
                    Row::Project { open, key, .. } => self.toggle(key, !open, true),
                    Row::Thread {
                        open: Some(open),
                        key,
                        ..
                    } if on_mark => self.toggle(key, !open, false),
                    _ => self.activate(cx),
                }
            }
            _ => {}
        }
    }
}

impl Panel for ThreadsPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        let quiet = matches!(
            msg,
            PanelMsg::Resize { .. }
                | PanelMsg::Focus(_)
                | PanelMsg::Cached(_)
                | PanelMsg::Workspace(_)
        );
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Text(text) | PanelMsg::Paste(text) => self.insert_text(&text),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.body = area;
                self.ensure_visible();
                self.clamp_scroll();
            }
            PanelMsg::Completion(c) => self.on_completion(c, cx),
            PanelMsg::Host(h) => self.on_host(h, cx),
            PanelMsg::Action(action) => self.run(action.as_str(), cx),
            PanelMsg::Focus(on) => self.focused = on,
            PanelMsg::Tick => cx.invalidate(),
            _ => {}
        }
        if !quiet {
            self.request_listing(cx);
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        draw::view(self, area, buf, cx);
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        draw::semantics(self, area, cx)
    }

    fn serialize(&self) -> Value {
        json!({
            "toggled": self.toggled,
            "selected": self.selected,
            "archived": self.show_archived,
        })
    }

    fn text_entry(&self) -> bool {
        matches!(self.mode, Mode::Edit(_))
    }

    fn takes_chord(&self, key: &KeyInput) -> bool {
        key.mods().contains(Mods::ALT)
            && matches!(key.key(), Key::Char(c) if c.eq_ignore_ascii_case(&'n'))
    }
}
