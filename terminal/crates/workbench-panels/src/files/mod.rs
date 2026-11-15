//! The Files panel: a lazily loaded workspace tree over the `files*` effects.
//!
//! A directory is listed when it is first made visible and expanded, and again
//! only when the host says it changed. Each listing is one `filesList` effect;
//! its completion replaces that directory alone. Writes (create, rename, move,
//! delete) show a pending state on their row and settle on the owner's answer;
//! an unknown answer stays unknown until a person refreshes.

mod draw;
mod tree;
mod visible;

use std::collections::BTreeMap;

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};
use theorem_workbench_core::completion::{Completion, CompletionPayload, FileKind, Outcome};
use theorem_workbench_core::effect::{
    Effect, EffectBody, FilesCopy, FilesCreate, FilesPath, FilesRename,
};
use theorem_workbench_core::host::{ConnectionState, HostMessage};
use theorem_workbench_core::ids::{Capability, EffectId, ResourceRef, WorkspaceIdentity};
use theorem_workbench_core::semantics::Node;
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Button, Ctx, EmitError, OpenTarget, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind,
    ViewCtx,
};
use tui_input::{Input, InputRequest};

use tree::{Entry, Note, NoteState, Overlay, Problem, Row, Tone, Tree, join, name_of, parent};

/// Frames of silence after which type-ahead starts a new search.
const TYPE_AHEAD_TICKS: u32 = 90;

pub(crate) fn register(factories: &mut PanelFactories) {
    factories.register("files", |state, _version| {
        Box::new(FilesPanel::restore(state))
    });
}

enum Op {
    Create { path: String, directory: bool },
    Rename { from: String, to: String },
    Copy { from: String, to: String },
    Delete { path: String },
}

impl Op {
    /// The row the operation is shown on.
    fn row(&self) -> &str {
        match self {
            Self::Create { path, .. } | Self::Delete { path } => path,
            Self::Rename { from, .. } | Self::Copy { from, .. } => from,
        }
    }
}

enum EditKind {
    Rename { path: String },
    New { dir: String, directory: bool },
}

struct Edit {
    input: Input,
    kind: EditKind,
    error: Option<String>,
}

/// A question waiting for a yes.
enum Question {
    Delete(String),
    /// A copy would replace what is already at `to`.
    Replace {
        from: String,
        to: String,
    },
}

enum Mode {
    Browse,
    Edit(Edit),
    Confirm(Question),
}

struct Clip {
    path: String,
    cut: bool,
}

pub struct FilesPanel {
    /// The workspace the host last named: what every effect is stamped with
    /// and what the root judges its answers against.
    identity: WorkspaceIdentity,
    tree: Tree,
    lists: BTreeMap<EffectId, String>,
    ops: BTreeMap<EffectId, Op>,
    selected: Option<String>,
    scroll: usize,
    body: Rect,
    mode: Mode,
    clip: Option<Clip>,
    ahead: String,
    ahead_idle: u32,
    connection: Option<ConnectionState>,
    files_ok: bool,
}

fn plain_char(key: &KeyInput) -> Option<char> {
    match key.key() {
        Key::Char(c) if key.mods().difference(Mods::SHIFT).is_empty() => Some(c),
        _ => None,
    }
}

fn normalize(path: &str) -> &str {
    path.trim_start_matches("./").trim_end_matches('/')
}

impl FilesPanel {
    fn restore(state: &Value) -> Self {
        let mut tree = Tree::new();
        if let Some(paths) = state["expanded"].as_array() {
            for path in paths.iter().filter_map(Value::as_str) {
                tree.set_expanded(path, true);
            }
        }
        Self {
            identity: WorkspaceIdentity::default(),
            tree,
            lists: BTreeMap::new(),
            ops: BTreeMap::new(),
            selected: state["selected"].as_str().map(str::to_owned),
            scroll: state["scroll"].as_u64().unwrap_or(0) as usize,
            body: Rect::default(),
            mode: Mode::Browse,
            clip: None,
            ahead: String::new(),
            ahead_idle: 0,
            connection: None,
            files_ok: true,
        }
    }

    fn ready(&self) -> bool {
        self.files_ok && self.identity.is_set()
    }

    /// Take the workspace the root names. The first one the panel sees is the
    /// one its saved view state was for; a different one after that means
    /// everything it knew is about another tree.
    fn adopt(&mut self, identity: &WorkspaceIdentity) {
        if self.identity == *identity {
            return;
        }
        if self.identity.is_set() {
            self.tree = Tree::new();
            self.lists.clear();
            self.ops.clear();
            self.selected = None;
            self.scroll = 0;
            self.mode = Mode::Browse;
            self.clip = None;
            self.ahead.clear();
            self.connection = None;
        }
        self.identity = identity.clone();
    }

    fn overlay(&self) -> Overlay<'_> {
        let mut o = Overlay {
            clip: self.clip.as_ref().map(|c| (c.path.as_str(), c.cut)),
            ..Overlay::default()
        };
        match &self.mode {
            Mode::Browse => {}
            Mode::Edit(Edit {
                kind: EditKind::Rename { path },
                ..
            }) => o.rename = Some(path),
            Mode::Edit(Edit {
                kind: EditKind::New { dir, directory },
                ..
            }) => o.new_in = Some((dir, *directory)),
            Mode::Confirm(Question::Delete(path)) => {
                let and = match self.tree.kind_of(path) {
                    Some(FileKind::Directory) => " and everything in it",
                    _ => "",
                };
                let text = format!(
                    "Delete {}{and}? Enter deletes, Escape cancels",
                    name_of(path)
                );
                o.confirm = Some((path, text));
            }
            Mode::Confirm(Question::Replace { to, .. }) => {
                let and = match self.tree.kind_of(to) {
                    Some(FileKind::Directory) => " and everything in it",
                    _ => "",
                };
                let text = format!(
                    "Replace {}{and}? Enter replaces, Escape cancels",
                    name_of(to)
                );
                o.confirm = Some((to, text));
            }
        }
        o
    }

    fn rows(&self) -> Vec<Row> {
        if !self.files_ok {
            return vec![Row::Status {
                depth: 0,
                text: "the files service is unavailable".to_owned(),
                tone: Tone::Error,
            }];
        }
        if !self.identity.is_set() {
            return vec![Row::Status {
                depth: 0,
                text: "no workspace connected".to_owned(),
                tone: Tone::Plain,
            }];
        }
        self.tree.rows(&self.overlay())
    }

    /// A line above the rows when the live connection is not open.
    fn banner(&self) -> Option<&'static str> {
        match self.connection? {
            ConnectionState::Open => None,
            ConnectionState::Connecting => Some("connecting; the listing may be out of date"),
            ConnectionState::Reconnecting => Some("reconnecting; the listing may be out of date"),
            ConnectionState::Resyncing => Some("resyncing"),
            ConnectionState::Closed => Some("disconnected; the listing may be out of date"),
        }
    }

    fn header(&self) -> usize {
        usize::from(self.banner().is_some())
    }

    fn viewport_rows(&self) -> usize {
        usize::from(self.body.height).saturating_sub(self.header())
    }

    fn resource(&self) -> ResourceRef {
        ResourceRef::Workspace {
            workspace: self.identity.workspace.clone(),
        }
    }

    fn emit(&mut self, cx: &mut Ctx, body: EffectBody) -> Result<EffectId, EmitError> {
        let resource = self.resource();
        let generation = self.identity.generation;
        cx.emit(|id| Effect::new(id, resource, body).with_generation(generation))
    }

    // ---- listing ----------------------------------------------------------

    /// Start the listings that are owed. On a silent call nothing starts and
    /// the need stays recorded for the next one.
    fn pump(&mut self, cx: &mut Ctx) {
        if !self.ready() {
            return;
        }
        let owed: Vec<String> = self
            .tree
            .dirs()
            .filter(|(p, d)| {
                d.wanted && d.listing.is_none() && self.tree.is_expanded(p) && self.tree.visible(p)
            })
            .map(|(p, _)| p.clone())
            .collect();
        for path in owed {
            let body = EffectBody::FilesList(FilesPath { path: path.clone() });
            match self.emit(cx, body) {
                Ok(id) => {
                    self.lists.insert(id, path.clone());
                    if let Some(dir) = self.tree.dir_mut(&path) {
                        dir.listing = Some(id);
                        dir.wanted = false;
                    }
                }
                Err(_) => break,
            }
        }
    }

    fn on_listing(&mut self, dir: String, c: Completion) {
        let Some(d) = self.tree.dir_mut(&dir) else {
            return;
        };
        if d.listing != Some(c.effect) {
            return;
        }
        d.listing = None;
        match (&c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::Files(listing))) => {
                self.tree.ingest(&dir, listing);
            }
            (Outcome::Accepted, _) => {
                d.problem = Some(Problem::Failed {
                    reason: "the host sent no listing".to_owned(),
                });
            }
            (outcome, _) => d.problem = Problem::of(outcome),
        }
        self.keep_selection_real();
    }

    /// A selection whose directory is loaded and no longer lists it falls back
    /// to the nearest directory that does.
    fn keep_selection_real(&mut self) {
        let Some(sel) = self.selected.clone() else {
            return;
        };
        let mut path = sel.as_str();
        loop {
            let dir = parent(path);
            let loaded = self.tree.dir(dir).is_some_and(|d| d.loaded);
            if loaded && self.tree.kind_of(path).is_none() {
                self.selected = (!dir.is_empty()).then(|| dir.to_owned());
                return;
            }
            if dir.is_empty() {
                return;
            }
            path = dir;
        }
    }

    fn resync(&mut self) {
        self.lists.clear();
        let paths: Vec<String> = self.tree.dirs().map(|(p, _)| p.clone()).collect();
        for path in paths {
            if let Some(d) = self.tree.dir_mut(&path) {
                d.listing = None;
                d.wanted = true;
            }
        }
    }

    fn on_host(&mut self, message: HostMessage) {
        let workspace = self.identity.workspace.clone();
        match message {
            HostMessage::FileChanged { workspace: w, path } if w == workspace => {
                let path = normalize(&path);
                if path == "." {
                    self.resync();
                } else if self.tree.dir(parent(path)).is_some_and(|d| d.loaded) {
                    self.tree.want(parent(path));
                }
            }
            HostMessage::Resync { workspace: w, .. } if w == workspace => self.resync(),
            HostMessage::ConnectionChanged {
                workspace: w,
                state,
            } if w == workspace => self.connection = Some(state),
            HostMessage::CapabilitiesChanged { capabilities } => {
                let ok = capabilities.has(&Capability::new("files"));
                if ok && !self.files_ok {
                    self.resync();
                }
                self.files_ok = ok;
            }
            // Another resource's, or the root's own: it tells this panel about
            // a new workspace as `PanelMsg::Workspace`, the theme arrives in
            // `ViewCtx`, and documents, terminals and conversations are other
            // panels'. A file changed in another workspace is not listed here.
            HostMessage::FileChanged { .. }
            | HostMessage::Resync { .. }
            | HostMessage::ConnectionChanged { .. }
            | HostMessage::DocumentChanged { .. }
            | HostMessage::DocumentAcknowledged { .. }
            | HostMessage::DocumentResync { .. }
            | HostMessage::DocumentConflict { .. }
            | HostMessage::DocumentSaved { .. }
            | HostMessage::DocumentMoved { .. }
            | HostMessage::DocumentRetired { .. }
            | HostMessage::TerminalOutput { .. }
            | HostMessage::TerminalReset { .. }
            | HostMessage::TerminalResized { .. }
            | HostMessage::TerminalOpened { .. }
            | HostMessage::TerminalExited { .. }
            | HostMessage::TerminalControl { .. }
            | HostMessage::TerminalSessions { .. }
            | HostMessage::ConversationSnapshot { .. }
            | HostMessage::ThemeChanged { .. }
            | HostMessage::WorkspaceChanged { .. } => {}
            _ => {}
        }
    }

    // ---- selection and scrolling -------------------------------------------

    fn cursor_path(&self, rows: &[Row]) -> Option<String> {
        if let Mode::Edit(Edit {
            kind: EditKind::New { .. },
            ..
        }) = &self.mode
        {
            return rows.iter().find_map(|r| match r {
                Row::Edit {
                    path,
                    rename: false,
                    ..
                } => Some(path.clone()),
                _ => None,
            });
        }
        self.selected.clone()
    }

    fn ensure_visible(&mut self) {
        let h = self.viewport_rows();
        if h == 0 {
            return;
        }
        let rows = self.rows();
        let Some(path) = self.cursor_path(&rows) else {
            return;
        };
        let Some(i) = rows.iter().position(|r| r.path() == Some(path.as_str())) else {
            return;
        };
        if i < self.scroll {
            self.scroll = i;
        } else if i >= self.scroll + h {
            self.scroll = i + 1 - h;
        }
    }

    fn clamp_scroll(&mut self) {
        let rows = self.rows().len();
        let h = self.viewport_rows();
        self.scroll = self.scroll.min(rows.saturating_sub(h.max(1)));
    }

    fn select(&mut self, path: Option<String>) {
        self.selected = path;
        self.ensure_visible();
    }

    /// Move the cursor among the rows it can rest on; `to` receives the
    /// current index (if any) and the count.
    fn step(&mut self, to: impl FnOnce(Option<usize>, usize) -> usize) {
        let rows = self.rows();
        let stops: Vec<&str> = rows.iter().filter_map(Row::path).collect();
        if stops.is_empty() {
            return;
        }
        let at = self
            .selected
            .as_deref()
            .and_then(|s| stops.iter().position(|p| *p == s));
        let next = to(at, stops.len()).min(stops.len() - 1);
        let path = stops[next].to_owned();
        self.select(Some(path));
    }

    fn selected_kind(&self) -> Option<FileKind> {
        self.selected.as_deref().and_then(|p| self.tree.kind_of(p))
    }

    /// Where a new or pasted entry goes: into the selected directory, beside
    /// the selected file, or at the root.
    fn target_dir(&self) -> String {
        match (&self.selected, self.selected_kind()) {
            (Some(p), Some(FileKind::Directory)) => p.clone(),
            (Some(p), _) => parent(p).to_owned(),
            _ => String::new(),
        }
    }

    fn busy(&self, path: &str) -> bool {
        matches!(
            self.tree.notes.get(path),
            Some(Note {
                state: NoteState::Pending(_),
                ..
            })
        )
    }

    fn toggle(&mut self, path: &str, on: bool) {
        self.tree.set_expanded(path, on);
        self.clamp_scroll();
    }

    /// A directory opens and closes; a file is shown by the root, which
    /// focuses the panel already showing it or opens one.
    fn open(&mut self, path: &str, cx: &mut Ctx) {
        match self.tree.kind_of(path) {
            Some(FileKind::Directory) => {
                let on = !self.tree.is_expanded(path);
                self.toggle(path, on);
            }
            Some(_) => cx.open(OpenTarget::File {
                workspace: self.identity.workspace.clone(),
                path: path.to_owned(),
            }),
            None => {}
        }
    }

    fn type_ahead(&mut self, c: char) {
        self.ahead.push(c);
        self.ahead_idle = 0;
        let needle = self.ahead.to_lowercase();
        let rows = self.rows();
        let names: Vec<(&str, String)> = rows
            .iter()
            .filter_map(|r| match r {
                Row::Entry { path, name, .. } => Some((path.as_str(), name.to_lowercase())),
                _ => None,
            })
            .collect();
        let at = self
            .selected
            .as_deref()
            .and_then(|s| names.iter().position(|(p, _)| *p == s));
        // One character moves on from the current row; more refine it.
        let start = match at {
            Some(i) if self.ahead.chars().count() == 1 => i + 1,
            Some(i) => i,
            None => 0,
        };
        let n = names.len();
        let hit = (0..n)
            .map(|k| (start + k) % n.max(1))
            .find(|i| names[*i].1.starts_with(&needle));
        if let Some(i) = hit {
            let path = names[i].0.to_owned();
            self.select(Some(path));
        }
    }

    // ---- input --------------------------------------------------------------

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        match &self.mode {
            Mode::Edit(_) => return self.edit_key(key, cx),
            Mode::Confirm(_) => return self.confirm_key(key, cx),
            Mode::Browse => {}
        }
        let mods = key.mods();
        let command = mods.intersects(Mods::CTRL | Mods::CMD);
        if let Some(c) = plain_char(&key) {
            return self.type_ahead(c);
        }
        self.ahead.clear();
        if let Some(directory) = self.new_chord(&key) {
            return self.begin_new(directory);
        }
        let page = self.viewport_rows().saturating_sub(1).max(1);
        match key.key() {
            Key::Up => self.step(|at, n| at.map_or(n - 1, |i| i.saturating_sub(1))),
            Key::Down => self.step(|at, _| at.map_or(0, |i| i + 1)),
            Key::Home => self.step(|_, _| 0),
            Key::End => self.step(|_, n| n - 1),
            Key::PageUp => self.step(|at, _| at.unwrap_or(0).saturating_sub(page)),
            Key::PageDown => self.step(|at, _| at.unwrap_or(0) + page),
            Key::Right => self.expand_or_descend(),
            Key::Left => self.collapse_or_ascend(),
            Key::Enter => {
                if let Some(p) = self.selected.clone() {
                    self.open(&p, cx);
                }
            }
            Key::F2 => self.begin_rename(),
            Key::F5 => self.refresh(),
            Key::Esc => self.dismiss(),
            Key::Delete => self.begin_delete(),
            Key::Backspace if command => self.begin_delete(),
            Key::Cut => self.mark(true),
            Key::Copy => self.mark(false),
            Key::Paste => self.paste(cx),
            Key::Char(c) if command => match c.to_ascii_lowercase() {
                'x' => self.mark(true),
                'c' => self.mark(false),
                'v' => self.paste(cx),
                _ => {}
            },
            _ => {}
        }
    }

    /// Alt+N starts a new file and Alt+Shift+N a new folder, only where the
    /// tree is browsed and listed: while a name or a question is open, or
    /// before the listing, the key is not a command. `Some(true)` is a folder.
    fn new_chord(&self, key: &KeyInput) -> Option<bool> {
        let mods = key.mods();
        match key.key() {
            Key::Char(c)
                if matches!(self.mode, Mode::Browse)
                    && self.ready()
                    && mods.contains(Mods::ALT)
                    && !mods.intersects(Mods::CTRL | Mods::CMD)
                    && c.eq_ignore_ascii_case(&'n') =>
            {
                Some(c.is_uppercase())
            }
            _ => None,
        }
    }

    fn expand_or_descend(&mut self) {
        let Some(path) = self.selected.clone() else {
            return;
        };
        if self.selected_kind() != Some(FileKind::Directory) {
            return;
        }
        if !self.tree.is_expanded(&path) {
            self.toggle(&path, true);
            return;
        }
        let rows = self.rows();
        let child = rows
            .iter()
            .position(|r| r.path() == Some(path.as_str()))
            .and_then(|i| rows.get(i + 1))
            .filter(|r| {
                r.depth()
                    > rows
                        .iter()
                        .find(|x| x.path() == Some(path.as_str()))
                        .map_or(0, Row::depth)
            })
            .and_then(|r| r.path().map(str::to_owned));
        if let Some(child) = child {
            self.select(Some(child));
        }
    }

    fn collapse_or_ascend(&mut self) {
        let Some(path) = self.selected.clone() else {
            return;
        };
        if self.selected_kind() == Some(FileKind::Directory) && self.tree.is_expanded(&path) {
            self.toggle(&path, false);
        } else if !parent(&path).is_empty() {
            let up = parent(&path).to_owned();
            self.select(Some(up));
        }
    }

    /// Escape: forget what the selected row is showing and any type-ahead.
    fn dismiss(&mut self) {
        if let Some(p) = &self.selected
            && let Some(note) = self.tree.notes.get(p)
            && !matches!(note.state, NoteState::Pending(_))
        {
            self.tree.notes.remove(p);
        }
        self.clip = None;
    }

    fn refresh(&mut self) {
        let dir = self.target_dir();
        if let Some(d) = self.tree.dir_mut(&dir) {
            d.wanted = true;
            d.manual = true;
        }
    }

    fn row_at(&self, y: i32) -> Option<Row> {
        let i = y - self.header() as i32;
        if i < 0 {
            return None;
        }
        self.rows().into_iter().nth(self.scroll + i as usize)
    }

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        match p.kind {
            PointerKind::Wheel { dy, .. } => {
                let rows = self.rows().len();
                let max = rows.saturating_sub(self.viewport_rows().max(1));
                self.scroll = (self.scroll as i64 + i64::from(dy)).clamp(0, max as i64) as usize;
            }
            PointerKind::Down(Button::Left) => {
                if !matches!(self.mode, Mode::Browse) {
                    self.mode = Mode::Browse;
                }
                self.ahead.clear();
                let Some(Row::Entry {
                    path, kind, depth, ..
                }) = self.row_at(p.y)
                else {
                    return;
                };
                let on_mark = kind == FileKind::Directory
                    && p.x >= (depth * 2) as i32
                    && p.x < (depth * 2 + 2) as i32;
                self.selected = Some(path.clone());
                if on_mark {
                    // The press that begins a double click already toggled it.
                    if p.clicks <= 1 {
                        let on = !self.tree.is_expanded(&path);
                        self.toggle(&path, on);
                    }
                } else if p.clicks >= 2 {
                    self.open(&path, cx);
                }
            }
            _ => {}
        }
    }

    // ---- writes ---------------------------------------------------------------

    fn begin_rename(&mut self) {
        let Some(path) = self.selected.clone() else {
            return;
        };
        if self.busy(&path) || self.tree.kind_of(&path).is_none() {
            return;
        }
        self.mode = Mode::Edit(Edit {
            input: Input::new(name_of(&path).to_owned()),
            kind: EditKind::Rename { path },
            error: None,
        });
        self.ensure_visible();
    }

    fn begin_new(&mut self, directory: bool) {
        if !self.ready() {
            return;
        }
        let dir = self.target_dir();
        self.toggle(&dir, true);
        self.mode = Mode::Edit(Edit {
            input: Input::default(),
            kind: EditKind::New { dir, directory },
            error: None,
        });
        self.ensure_visible();
    }

    fn begin_delete(&mut self) {
        if let Some(path) = self.selected.clone()
            && !self.busy(&path)
            && self.tree.kind_of(&path).is_some()
        {
            self.mode = Mode::Confirm(Question::Delete(path));
        }
    }

    fn mark(&mut self, cut: bool) {
        if let Some(path) = self.selected.clone()
            && self.tree.kind_of(&path).is_some()
        {
            self.clip = Some(Clip { path, cut });
        }
    }

    fn note(&mut self, path: &str, state: NoteState, ghost: Option<Entry>) {
        self.tree
            .notes
            .insert(path.to_owned(), Note { state, ghost });
    }

    fn refuse_here(&mut self, path: &str, code: &str, reason: &str) {
        self.note(
            path,
            NoteState::Problem(Problem::Refused {
                code: code.to_owned(),
                reason: reason.to_owned(),
            }),
            None,
        );
    }

    fn paste(&mut self, cx: &mut Ctx) {
        let Some(clip) = self.clip.as_ref().map(|c| (c.path.clone(), c.cut)) else {
            return;
        };
        let (src, cut) = clip;
        if self.busy(&src) {
            return;
        }
        let target = self.target_dir();
        let dest = join(&target, name_of(&src));
        if target == src || target.starts_with(&format!("{src}/")) {
            self.refuse_here(&src, "into_itself", "a folder cannot go into itself");
            return;
        }
        if parent(&src) == target {
            self.refuse_here(&src, "same_directory", "already in that folder");
            return;
        }
        let taken =
            self.tree.dir(&target).is_some_and(|d| d.loaded) && self.tree.entry_of(&dest).is_some();
        match (cut, taken) {
            (true, false) => self.start_rename(cx, src, dest),
            (true, true) => self.refuse_here(
                &src,
                "name_taken",
                "something with that name is already in that folder",
            ),
            (false, false) => self.start_copy(cx, src, dest, false),
            // The host would refuse a copy over what exists; replacing it is
            // for a person to say.
            (false, true) => {
                self.mode = Mode::Confirm(Question::Replace {
                    from: src,
                    to: dest,
                })
            }
        }
    }

    fn start_copy(&mut self, cx: &mut Ctx, from: String, to: String, overwrite: bool) {
        let body = EffectBody::FilesCopy(FilesCopy {
            from: from.clone(),
            to: to.clone(),
            overwrite,
        });
        match self.emit(cx, body) {
            Ok(id) => {
                self.note(
                    &from,
                    NoteState::Pending(format!("copying to {to}...")),
                    None,
                );
                self.ops.insert(id, Op::Copy { from, to });
            }
            Err(e) => self.refuse_here(&from, "not_sent", &e.to_string()),
        }
    }

    fn start_rename(&mut self, cx: &mut Ctx, from: String, to: String) {
        let body = EffectBody::FilesRename(FilesRename {
            from: from.clone(),
            to: to.clone(),
        });
        match self.emit(cx, body) {
            Ok(id) => {
                self.note(
                    &from,
                    NoteState::Pending(format!("moving to {to}...")),
                    None,
                );
                self.ops.insert(id, Op::Rename { from, to });
            }
            Err(e) => self.refuse_here(&from, "not_sent", &e.to_string()),
        }
    }

    fn edit_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let word = key.mods().intersects(Mods::ALT | Mods::CTRL);
        let request = match key.key() {
            Key::Esc => {
                self.mode = Mode::Browse;
                return;
            }
            Key::Enter => return self.commit_edit(cx),
            Key::Left if word => InputRequest::GoToPrevWord,
            Key::Right if word => InputRequest::GoToNextWord,
            Key::Left => InputRequest::GoToPrevChar,
            Key::Right => InputRequest::GoToNextChar,
            Key::Home => InputRequest::GoToStart,
            Key::End => InputRequest::GoToEnd,
            Key::Backspace if word => InputRequest::DeletePrevWord,
            Key::Backspace => InputRequest::DeletePrevChar,
            Key::Delete => InputRequest::DeleteNextChar,
            Key::Char(c) if key.mods().intersects(Mods::CTRL | Mods::CMD) => match c {
                'a' => InputRequest::GoToStart,
                'e' => InputRequest::GoToEnd,
                'u' => InputRequest::DeleteFromStart,
                'k' => InputRequest::DeleteTillEnd,
                _ => return,
            },
            Key::Char(c) if key.mods().difference(Mods::SHIFT).is_empty() => {
                InputRequest::InsertChar(c)
            }
            _ => return,
        };
        if let Mode::Edit(edit) = &mut self.mode {
            edit.input.handle(request);
            edit.error = None;
        }
    }

    fn insert_text(&mut self, text: &str) {
        match &mut self.mode {
            Mode::Edit(edit) => {
                for c in text.chars().filter(|c| !c.is_control()) {
                    edit.input.handle(InputRequest::InsertChar(c));
                }
                edit.error = None;
            }
            Mode::Browse => {
                for c in text.chars().filter(|c| !c.is_control()) {
                    self.type_ahead(c);
                }
            }
            Mode::Confirm(_) => {}
        }
    }

    fn commit_edit(&mut self, cx: &mut Ctx) {
        let Mode::Edit(mut edit) = std::mem::replace(&mut self.mode, Mode::Browse) else {
            return;
        };
        let name = edit.input.value().to_owned();
        let (dir, own) = match &edit.kind {
            EditKind::Rename { path } => (parent(path).to_owned(), Some(name_of(path).to_owned())),
            EditKind::New { dir, .. } => (dir.clone(), None),
        };
        if own.as_deref() == Some(name.as_str()) {
            return;
        }
        let siblings = self.tree.dir(&dir).filter(|d| d.loaded && !d.partial);
        let invalid = if name.trim().is_empty() {
            Some("a name is required")
        } else if name.contains('/') || name.contains('\0') || name == "." || name == ".." {
            Some("that is not a valid name")
        } else if siblings.is_some() && self.tree.children(&dir).iter().any(|e| e.name == name) {
            Some("that name is taken")
        } else {
            None
        };
        if let Some(why) = invalid {
            edit.error = Some(why.to_owned());
            self.mode = Mode::Edit(edit);
            return;
        }
        let to = join(&dir, &name);
        match edit.kind {
            EditKind::Rename { path } => {
                let from = path;
                let body = EffectBody::FilesRename(FilesRename {
                    from: from.clone(),
                    to: to.clone(),
                });
                match self.emit(cx, body) {
                    Ok(id) => {
                        self.note(
                            &from,
                            NoteState::Pending(format!("renaming to {name}...")),
                            None,
                        );
                        self.ops.insert(id, Op::Rename { from, to });
                    }
                    Err(e) => self.refuse_here(&from, "not_sent", &e.to_string()),
                }
            }
            EditKind::New { directory, .. } => {
                let body = EffectBody::FilesCreate(FilesCreate {
                    path: to.clone(),
                    directory,
                });
                let kind = if directory {
                    FileKind::Directory
                } else {
                    FileKind::File
                };
                let ghost = Entry::new(name, kind);
                match self.emit(cx, body) {
                    Ok(id) => {
                        self.note(
                            &to,
                            NoteState::Pending("creating...".to_owned()),
                            Some(ghost),
                        );
                        self.ops.insert(
                            id,
                            Op::Create {
                                path: to.clone(),
                                directory,
                            },
                        );
                    }
                    Err(e) => self.note(
                        &to,
                        NoteState::Problem(Problem::Refused {
                            code: "not_sent".to_owned(),
                            reason: e.to_string(),
                        }),
                        Some(ghost),
                    ),
                }
                self.selected = Some(to);
            }
        }
        self.ensure_visible();
    }

    fn confirm_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let yes = matches!(key.key(), Key::Enter) || plain_char(&key) == Some('y');
        let no = matches!(key.key(), Key::Esc) || plain_char(&key) == Some('n');
        if !yes && !no {
            return;
        }
        let Mode::Confirm(question) = std::mem::replace(&mut self.mode, Mode::Browse) else {
            return;
        };
        if !yes {
            return;
        }
        match question {
            Question::Delete(path) => {
                let body = EffectBody::FilesDelete(FilesPath { path: path.clone() });
                match self.emit(cx, body) {
                    Ok(id) => {
                        self.note(&path, NoteState::Pending("deleting...".to_owned()), None);
                        self.ops.insert(id, Op::Delete { path });
                    }
                    Err(e) => self.refuse_here(&path, "not_sent", &e.to_string()),
                }
            }
            Question::Replace { from, to } => self.start_copy(cx, from, to, true),
        }
    }

    // ---- answers to writes ---------------------------------------------------

    fn on_write(&mut self, op: Op, c: Completion) {
        let row = op.row().to_owned();
        let ghost = match &op {
            Op::Create { path, directory } => Some(Entry::new(
                name_of(path),
                if *directory {
                    FileKind::Directory
                } else {
                    FileKind::File
                },
            )),
            Op::Rename { .. } | Op::Copy { .. } | Op::Delete { .. } => None,
        };
        let Some(problem) = Problem::of(&c.outcome) else {
            return self.write_accepted(op);
        };
        self.note(&row, NoteState::Problem(problem), ghost);
    }

    fn write_accepted(&mut self, op: Op) {
        match op {
            Op::Create { path, directory } => {
                self.tree.notes.remove(&path);
                let kind = if directory {
                    FileKind::Directory
                } else {
                    FileKind::File
                };
                self.tree
                    .insert_entry(parent(&path), Entry::new(name_of(&path), kind));
                self.tree.want(parent(&path));
            }
            Op::Copy { from, to } => {
                self.tree.notes.remove(&from);
                let kind = self.tree.kind_of(&from).unwrap_or(FileKind::File);
                self.tree
                    .insert_entry(parent(&to), Entry::new(name_of(&to), kind));
                self.tree.want(parent(&to));
            }
            Op::Rename { from, to } => {
                let moved = Entry {
                    name: name_of(&to).to_owned(),
                    ..self
                        .tree
                        .entry_of(&from)
                        .unwrap_or_else(|| Entry::new(name_of(&to), FileKind::File))
                };
                self.tree.move_subtree(&from, &to);
                self.tree.remove_entry(&from);
                self.tree.insert_entry(parent(&to), moved);
                if let Some(sel) = &self.selected
                    && let Some(rest) = sel.strip_prefix(from.as_str())
                    && (rest.is_empty() || rest.starts_with('/'))
                {
                    self.selected = Some(format!("{to}{rest}"));
                }
                if self.clip.as_ref().is_some_and(|c| c.path == from) {
                    self.clip = None;
                }
                self.tree.want(parent(&from));
                self.tree.want(parent(&to));
            }
            Op::Delete { path } => {
                let rows = self.rows();
                let stops: Vec<&str> = rows.iter().filter_map(Row::path).collect();
                let outside = |p: &&str| *p != path && !p.starts_with(&format!("{path}/"));
                let at = stops.iter().position(|p| *p == path);
                let neighbor = at.and_then(|i| {
                    stops[i..]
                        .iter()
                        .find(|p| outside(p))
                        .or_else(|| stops[..i].iter().rev().find(|p| outside(p)))
                        .map(|p| (*p).to_owned())
                });
                let was_selected = self
                    .selected
                    .as_deref()
                    .is_some_and(|s| s == path || s.starts_with(&format!("{path}/")));
                self.tree.forget(&path);
                if was_selected {
                    self.selected = neighbor;
                }
                if self.clip.as_ref().is_some_and(|c| c.path == path) {
                    self.clip = None;
                }
                self.tree.want(parent(&path));
            }
        }
        self.keep_selection_real();
    }
}

impl Panel for FilesPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        // The root's identity is the truth, whichever message carries it.
        self.adopt(cx.workspace());
        // The environment cannot start work, and a cached answer is not ours
        // to show: neither is followed by a pump.
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
            PanelMsg::Completion(c) => {
                if let Some(dir) = self.lists.remove(&c.effect) {
                    self.on_listing(dir, c);
                } else if let Some(op) = self.ops.remove(&c.effect) {
                    self.on_write(op, c);
                }
            }
            PanelMsg::Host(h) => self.on_host(h),
            PanelMsg::Workspace(identity) => self.adopt(&identity),
            PanelMsg::Tick => {
                self.ahead_idle += 1;
                if self.ahead_idle > TYPE_AHEAD_TICKS {
                    self.ahead.clear();
                }
                cx.invalidate();
            }
            // Focus changes the drawing (the root passes it in `ViewCtx`), not
            // the state. An answer for a workspace this panel left is not
            // shown as the current tree.
            PanelMsg::Focus(_) | PanelMsg::Cached(_) => {}
            // The panel registers no action that asks it for a payload.
            PanelMsg::Action(_) => {}
            // The panel is bound to no terminal session.
            PanelMsg::TerminalOutput { .. }
            | PanelMsg::TerminalReset { .. }
            | PanelMsg::TerminalResetRequest { .. } => {}
            // A message added to the core after this panel was written.
            _ => {}
        }
        if !quiet {
            self.pump(cx);
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
            "expanded": self.tree.expanded_paths(),
            "selected": self.selected,
            "scroll": self.scroll,
        })
    }

    /// Bound to the workspace the root named, at that identity's generation,
    /// from the moment of construction (generation 0 until the root says).
    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: None,
            generation: Some(self.identity.generation),
        })
    }

    fn text_entry(&self) -> bool {
        matches!(self.mode, Mode::Edit(_))
    }

    fn takes_chord(&self, key: &KeyInput) -> bool {
        self.new_chord(key).is_some()
    }
}
