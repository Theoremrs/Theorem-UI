//! The Diagnostics panel: the findings the language owner returned, grouped by file, with the
//! counts by severity and a filter.
//!
//! The owner answers `languageDiagnostics` for one document at one revision, with each
//! finding as UTF-8 byte offsets into that revision's text. So the panel keeps one snapshot
//! per file, replaced when a newer or equal revision arrives and dropped when an older one
//! does, and it turns a byte offset into a line and column only when it holds the text of the
//! same revision. Without that text the row shows the byte offset and the panel says why,
//! rather than guessing a line. Reads go one document at a time, and the panel is bound to the
//! document being read (or the one under the cursor), which is what lets the root deliver a
//! refusal to it.

use std::collections::{BTreeMap, VecDeque};

use keybinds::{Key, KeyInput};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{Effect, EffectBody, EffectKind};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{
    ActionId, Capability, EffectId, Generation, PanelKind, ResourceRef, Revision, WorkspaceIdentity,
};
use theorem_workbench_core::registry::{ActionDescriptor, ActionIntent};
use theorem_workbench_core::results::{LanguageDiagnostics, Severity};
use theorem_workbench_core::semantics::{Node, NodeAction, Role};
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Button, Ctx, OpenTarget, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, TabLabel,
    ViewCtx,
};

use crate::styles::Styles;
use crate::text;

pub const KIND: &str = "diagnostics";
pub const CAPABILITY: &str = "diagnostics.subscribe";

/// The action ids of the panel, as `descriptors` registers them.
pub mod actions {
    pub const REFRESH: &str = "diagnostics.refresh";
    pub const FILTER_ALL: &str = "diagnostics.filter-all";
    pub const FILTER_ERROR: &str = "diagnostics.filter-error";
    pub const FILTER_WARNING: &str = "diagnostics.filter-warning";
    pub const FILTER_INFO: &str = "diagnostics.filter-info";
    pub const FILTER_HINT: &str = "diagnostics.filter-hint";
    pub const FILTER_NEXT: &str = "diagnostics.filter-next";
    pub const CURSOR_UP: &str = "diagnostics.cursor-up";
    pub const CURSOR_DOWN: &str = "diagnostics.cursor-down";
    pub const OPEN_FINDING: &str = "diagnostics.open-finding";
}

const ORDER: [Severity; 4] = [
    Severity::Error,
    Severity::Warning,
    Severity::Info,
    Severity::Hint,
];

fn word(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
        Severity::Hint => "hint",
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ViewState {
    /// `error`, `warning`, `info` or `hint`; absent shows every severity.
    filter: Option<String>,
    scroll: usize,
    /// The files the panel reads, with the revision last known for each.
    files: Vec<SavedFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SavedFile {
    path: String,
    revision: Option<u64>,
}

/// Registers the panel under the builtin kind `"diagnostics"`.
pub fn register(factories: &mut PanelFactories) {
    factories.register(KIND, |state, _version| {
        Box::new(DiagnosticsPanel::restore(state))
    });
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Finding {
    id: String,
    severity: Severity,
    message: String,
    source: Option<String>,
    start: u64,
    /// Line and column from 1, the column in UTF-16 code units, when the text of the
    /// snapshot's revision is held.
    place: Option<(u32, u32)>,
}

#[derive(Clone, Debug, Default)]
struct FileSet {
    /// The revision the findings are against.
    revision: Option<u64>,
    /// The newest revision of the document the panel has heard of.
    document: Option<u64>,
    /// The findings are a part of the document's set, not the whole of it.
    partial: bool,
    findings: Vec<Finding>,
    /// The document text at a revision, from a resync.
    text: Option<(u64, String)>,
    /// What the owner last said that was not a snapshot, in its words.
    note: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Item {
    Header(usize),
    Finding(usize, usize),
}

/// The counts and filter chips, as wide as the row allows.
fn chips(counts: &[usize; 4], total: usize, width: u16) -> Vec<(String, Option<Severity>)> {
    let long = width >= 52;
    let mut out = vec![(
        if long {
            format!(" All {total} ")
        } else {
            format!(" {total} ")
        },
        None,
    )];
    for (i, severity) in ORDER.iter().enumerate() {
        let label = if long {
            let name = match severity {
                Severity::Error => "Errors",
                Severity::Warning => "Warnings",
                Severity::Info => "Info",
                Severity::Hint => "Hints",
            };
            format!(" {name} {} ", counts[i])
        } else {
            let letter = match severity {
                Severity::Error => 'E',
                Severity::Warning => 'W',
                Severity::Info => 'I',
                Severity::Hint => 'H',
            };
            format!(" {letter}{} ", counts[i])
        };
        out.push((label, Some(*severity)));
    }
    out
}

pub struct DiagnosticsPanel {
    files: BTreeMap<String, FileSet>,
    filter: Option<Severity>,
    flat: Vec<Item>,
    sel: Option<(String, String)>,
    top: usize,
    /// Files waiting for a read, and the one being read.
    queue: VecDeque<String>,
    reading: Option<(EffectId, String)>,
    /// A read of every file is owed: the panel was restored, or the workspace named.
    owed: bool,
    notice: Option<String>,
    /// An open is under way. The root focuses a panel already bound to the document an open
    /// names, so for that moment the panel is bound to the workspace and the editor opens.
    yielding: bool,
    /// Snapshots dropped because the file had a newer one.
    dropped_sets: u32,
    identity: WorkspaceIdentity,
    caps_ok: bool,
    area: Rect,
}

impl DiagnosticsPanel {
    pub fn restore(state: &Value) -> Self {
        let saved: ViewState = serde_json::from_value(state.clone()).unwrap_or_default();
        let filter = saved
            .filter
            .as_deref()
            .and_then(|f| ORDER.iter().copied().find(|s| word(*s) == f));
        let files = saved
            .files
            .into_iter()
            .map(|f| {
                (
                    f.path,
                    FileSet {
                        document: f.revision,
                        ..FileSet::default()
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut panel = Self {
            owed: !files.is_empty(),
            files,
            filter,
            flat: vec![],
            sel: None,
            top: saved.scroll,
            queue: VecDeque::new(),
            reading: None,
            notice: None,
            yielding: false,
            dropped_sets: 0,
            identity: WorkspaceIdentity::default(),
            caps_ok: true,
            area: Rect::default(),
        };
        panel.rebuild();
        panel
    }

    /// Snapshots dropped because the file already had a newer one.
    pub fn dropped_sets(&self) -> u32 {
        self.dropped_sets
    }

    fn counts(&self) -> [usize; 4] {
        let mut counts = [0; 4];
        for file in self.files.values() {
            for f in &file.findings {
                let i = ORDER.iter().position(|s| *s == f.severity).unwrap_or(0);
                counts[i] += 1;
            }
        }
        counts
    }

    fn total(&self) -> usize {
        self.counts().iter().sum()
    }

    /// The layout for `area`, with as many status rows as the status line needs.
    fn lay(&self, area: Rect, caps_ok: bool) -> Layout {
        let words = self.status(caps_ok).0;
        let rows = text::wrap(&words, area.width as usize, STATUS_ROWS)
            .len()
            .max(1);
        layout(area, rows as u16)
    }

    fn list_height(&self) -> usize {
        self.lay(self.area, self.caps_ok).list.height as usize
    }

    fn rebuild(&mut self) {
        self.flat.clear();
        for (g, (_, file)) in self.files.iter().enumerate() {
            let shown: Vec<usize> = file
                .findings
                .iter()
                .enumerate()
                .filter(|(_, f)| self.filter.is_none_or(|s| s == f.severity))
                .map(|(i, _)| i)
                .collect();
            if self.filter.is_some() && shown.is_empty() {
                continue;
            }
            self.flat.push(Item::Header(g));
            self.flat
                .extend(shown.into_iter().map(|i| Item::Finding(g, i)));
        }
        let still = self.sel_index().is_some();
        if !still {
            self.sel = self.flat.iter().find_map(|i| match *i {
                Item::Finding(g, f) => self.key_of(g, f),
                Item::Header(_) => None,
            });
        }
        self.clamp_top();
    }

    fn key_of(&self, g: usize, f: usize) -> Option<(String, String)> {
        let (path, file) = self.files.iter().nth(g)?;
        Some((path.clone(), file.findings.get(f)?.id.clone()))
    }

    fn sel_index(&self) -> Option<usize> {
        let (path, id) = self.sel.as_ref()?;
        self.flat.iter().position(|item| match *item {
            Item::Finding(g, f) => self.files.iter().nth(g).is_some_and(|(p, file)| {
                p == path && file.findings.get(f).is_some_and(|x| &x.id == id)
            }),
            Item::Header(_) => false,
        })
    }

    fn clamp_top(&mut self) {
        let h = self.list_height().max(1);
        self.top = self.top.min(self.flat.len().saturating_sub(h));
    }

    fn reveal(&mut self) {
        let h = self.list_height().max(1);
        if let Some(i) = self.sel_index() {
            if i < self.top {
                self.top = if matches!(self.flat.get(i.wrapping_sub(1)), Some(Item::Header(_))) {
                    i - 1
                } else {
                    i
                };
            } else if i >= self.top + h {
                self.top = i + 1 - h;
            }
        }
        self.clamp_top();
    }

    // ---- what comes in ------------------------------------------------------------------

    fn adopt(&mut self, identity: &WorkspaceIdentity) {
        if self.identity == *identity {
            return;
        }
        let moved = self.identity.is_set()
            && (self.identity.workspace != identity.workspace
                || self.identity.environment != identity.environment);
        if moved {
            self.files.clear();
            self.queue.clear();
            self.reading = None;
            self.notice = None;
            self.flat.clear();
            self.sel = None;
        }
        self.identity = identity.clone();
    }

    /// Takes one document's snapshot. False: the file already had a newer one and this was
    /// dropped.
    fn ingest(
        &mut self,
        path: &str,
        snapshot: LanguageDiagnostics,
        answered_at: Option<u64>,
    ) -> bool {
        let revision = snapshot.revision.or(answered_at);
        let file = self.files.entry(path.to_owned()).or_default();
        if let (Some(have), Some(now)) = (file.revision, revision)
            && now < have
        {
            self.dropped_sets += 1;
            return false;
        }
        let same = file.revision == revision && revision.is_some();
        let mut incoming: Vec<Finding> = snapshot
            .findings
            .into_iter()
            .map(|f| Finding {
                id: f.id,
                severity: f.severity,
                message: f.message,
                source: f.provider,
                start: f.start,
                place: None,
            })
            .collect();
        if snapshot.full || !same {
            file.findings = std::mem::take(&mut incoming);
        } else {
            // A part of the set at the revision already shown: its findings replace the ones
            // with the same id and join the rest.
            for f in incoming {
                match file.findings.iter_mut().find(|x| x.id == f.id) {
                    Some(slot) => *slot = f,
                    None => file.findings.push(f),
                }
            }
        }
        file.findings.sort_by_key(|f| (f.start, f.id.clone()));
        file.partial = !snapshot.full;
        file.revision = revision;
        file.document = file.document.max(revision);
        file.note = None;
        place_all(file);
        true
    }

    fn on_completion(&mut self, completion: Completion, cached: bool) {
        let (path, was_read) = match (&self.reading, &completion.resource) {
            (Some((effect, path)), _) if *effect == completion.effect => (path.clone(), true),
            (
                _,
                ResourceRef::Document {
                    workspace,
                    resource_id,
                },
            ) if cached && *workspace == self.identity.workspace => (resource_id.clone(), false),
            _ => return,
        };
        if was_read {
            self.reading = None;
        }
        let at = match &completion.revision {
            Some(Revision::Seq(n)) => Some(*n),
            _ => None,
        };
        match (completion.outcome, completion.payload) {
            (Outcome::Accepted, Some(CompletionPayload::LanguageDiagnostics(snapshot))) => {
                self.ingest(&path, snapshot, at);
            }
            (Outcome::Accepted, _) => {
                self.note(
                    &path,
                    "The language service accepted the request but sent no findings.",
                );
            }
            (Outcome::Refused { code, reason }, _) => {
                self.note(&path, &format!("Refused ({code}): {reason}"));
            }
            (Outcome::Failed { reason }, _) => {
                self.note(&path, &format!("Failed: {reason}"));
            }
            (Outcome::Uncertain { reason }, _) => {
                self.note(
                    &path,
                    &format!("Unknown whether the findings are current: {reason}"),
                );
            }
        }
        self.rebuild();
    }

    fn note(&mut self, path: &str, note: &str) {
        self.files.entry(path.to_owned()).or_default().note = Some(note.to_owned());
        self.notice = Some(format!("{path}: {note} Not retried."));
    }

    fn on_host(&mut self, message: HostMessage) {
        let workspace = self.identity.workspace.clone();
        let doc = |resource: &ResourceRef| match resource {
            ResourceRef::Document {
                workspace: w,
                resource_id,
            } if *w == workspace => Some(resource_id.clone()),
            _ => None,
        };
        match message {
            HostMessage::DocumentResync {
                resource,
                revision: Revision::Seq(n),
                text,
            } => {
                if let Some(path) = doc(&resource) {
                    let file = self.files.entry(path).or_default();
                    file.document = file.document.max(Some(n));
                    file.text = Some((n, text));
                    place_all(file);
                    self.rebuild();
                }
            }
            HostMessage::DocumentChanged {
                resource,
                revision: Revision::Seq(n),
                ..
            }
            | HostMessage::DocumentSaved {
                resource,
                revision: Revision::Seq(n),
            }
            | HostMessage::DocumentAcknowledged {
                resource,
                revision: Revision::Seq(n),
                ..
            } => {
                if let Some(path) = doc(&resource) {
                    let file = self.files.entry(path.clone()).or_default();
                    file.document = file.document.max(Some(n));
                    if file.text.as_ref().is_some_and(|(at, _)| *at < n) {
                        file.text = None;
                    }
                    // The document moved on, so the findings are for older text: read again.
                    if !self.queue.contains(&path) {
                        self.queue.push_back(path);
                    }
                    self.rebuild();
                }
            }
            HostMessage::DocumentRetired { resource } => {
                if let Some(path) = doc(&resource) {
                    self.files.remove(&path);
                    self.rebuild();
                }
            }
            HostMessage::DocumentMoved { from, to } => {
                if let (Some(old), Some(new)) = (doc(&from), doc(&to))
                    && let Some(file) = self.files.remove(&old)
                {
                    self.files.insert(new, file);
                    self.rebuild();
                }
            }
            _ => {}
        }
    }

    /// Starts the next read, one document at a time: the root judges an answer against the
    /// one document the panel is bound to, so a refusal for it is not lost.
    fn pump(&mut self, cx: &mut Ctx) {
        if !self.caps_ok || !self.identity.is_set() || self.area.width == 0 || self.area.height == 0
        {
            return;
        }
        if self.owed {
            self.owed = false;
            for path in self.files.keys() {
                if !self.queue.contains(path) {
                    self.queue.push_back(path.clone());
                }
            }
        }
        while self.reading.is_none() {
            let Some(path) = self.queue.pop_front() else {
                return;
            };
            let Some(file) = self.files.get(&path) else {
                continue;
            };
            let Some(revision) = file.document.or(file.revision) else {
                self.note(
                    &path,
                    "No revision of this document is known, and the host refuses a language request without one.",
                );
                continue;
            };
            let resource = ResourceRef::Document {
                workspace: self.identity.workspace.clone(),
                resource_id: path.clone(),
            };
            let generation = self.identity.generation;
            match cx.emit(|id| {
                Effect::new(id, resource, EffectBody::LanguageDiagnostics)
                    .with_revision(Revision::Seq(revision))
                    .with_generation(generation)
            }) {
                Ok(id) => self.reading = Some((id, path)),
                Err(error) => {
                    self.notice = Some(format!("Not sent: {error}."));
                    self.queue.push_front(path);
                    return;
                }
            }
        }
    }

    // ---- what the person does -------------------------------------------------------------

    fn refresh(&mut self) {
        self.notice = None;
        if !self.caps_ok {
            self.notice = Some(self.unavailable());
            return;
        }
        if self.files.is_empty() {
            self.notice = Some(NO_FILES.to_owned());
            return;
        }
        self.owed = true;
    }

    fn set_filter(&mut self, filter: Option<Severity>) {
        self.filter = filter;
        self.rebuild();
        self.reveal();
    }

    fn filter_next(&mut self) {
        let next = match self.filter {
            None => Some(ORDER[0]),
            Some(s) => ORDER
                .iter()
                .position(|o| *o == s)
                .and_then(|i| ORDER.get(i + 1).copied()),
        };
        self.set_filter(next);
    }

    fn move_by(&mut self, delta: isize) {
        let rows: Vec<usize> = self
            .flat
            .iter()
            .enumerate()
            .filter(|(_, i)| matches!(i, Item::Finding(..)))
            .map(|(i, _)| i)
            .collect();
        if rows.is_empty() {
            return;
        }
        let at = self
            .sel_index()
            .and_then(|s| rows.iter().position(|r| *r == s))
            .unwrap_or(0) as isize;
        let next = rows[(at + delta).clamp(0, rows.len() as isize - 1) as usize];
        if let Item::Finding(g, f) = self.flat[next] {
            self.sel = self.key_of(g, f);
        }
        self.reveal();
    }

    fn open_finding(&mut self, cx: &mut Ctx) {
        let Some((path, id)) = self.sel.clone() else {
            return;
        };
        let place = self
            .files
            .get(&path)
            .and_then(|f| f.findings.iter().find(|x| x.id == id))
            .and_then(|f| f.place);
        self.open_at(path, place, cx);
    }

    fn open_at(&mut self, path: String, place: Option<(u32, u32)>, cx: &mut Ctx) {
        self.yielding = true;
        let workspace = self.identity.workspace.clone();
        match place {
            Some((line, column)) => cx.open(OpenTarget::FileAt {
                workspace,
                path,
                line,
                column,
            }),
            None => {
                self.notice = Some(format!(
                    "Opened {path} without a position: its text at the findings' revision is not known here, so a byte offset cannot be turned into a line."
                ));
                cx.open(OpenTarget::File { workspace, path });
            }
        }
    }

    fn on_action(&mut self, id: &ActionId, cx: &mut Ctx) {
        match id.as_str() {
            actions::REFRESH => self.refresh(),
            actions::FILTER_ALL => self.set_filter(None),
            actions::FILTER_ERROR => self.set_filter(Some(Severity::Error)),
            actions::FILTER_WARNING => self.set_filter(Some(Severity::Warning)),
            actions::FILTER_INFO => self.set_filter(Some(Severity::Info)),
            actions::FILTER_HINT => self.set_filter(Some(Severity::Hint)),
            actions::FILTER_NEXT => self.filter_next(),
            actions::CURSOR_UP => self.move_by(-1),
            actions::CURSOR_DOWN => self.move_by(1),
            actions::OPEN_FINDING => self.open_finding(cx),
            _ => {}
        }
    }

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        if !key.mods().difference(keybinds::Mods::SHIFT).is_empty() {
            return;
        }
        let page = (self.list_height().max(2) - 1) as isize;
        match key.key() {
            Key::Up => self.move_by(-1),
            Key::Down => self.move_by(1),
            Key::PageUp => self.move_by(-page),
            Key::PageDown => self.move_by(page),
            Key::Home => self.move_by(-1_000_000),
            Key::End => self.move_by(1_000_000),
            Key::Enter => self.open_finding(cx),
            Key::Char('0') => self.set_filter(None),
            Key::Char('1') => self.set_filter(Some(Severity::Error)),
            Key::Char('2') => self.set_filter(Some(Severity::Warning)),
            Key::Char('3') => self.set_filter(Some(Severity::Info)),
            Key::Char('4') => self.set_filter(Some(Severity::Hint)),
            Key::Char('f') => self.filter_next(),
            Key::Char('r') => self.refresh(),
            _ => {}
        }
    }

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let lay = self.lay(self.area, self.caps_ok);
        match p.kind {
            PointerKind::Wheel { dy, .. } => {
                let max = self.flat.len().saturating_sub(self.list_height());
                self.top =
                    (self.top as isize + isize::from(dy) * 3).clamp(0, max as isize) as usize;
            }
            PointerKind::Down(Button::Left) => {
                let (x, y) = (p.x, p.y);
                if y == 0 {
                    let mut at = 0i32;
                    for (label, filter) in chips(&self.counts(), self.total(), self.area.width) {
                        let w = text::width(&label) as i32;
                        if x >= at && x < at + w {
                            return self.set_filter(filter);
                        }
                        at += w + 1;
                    }
                    return;
                }
                let list = lay.list;
                if y >= i32::from(list.y) && y < i32::from(list.y + list.height) {
                    let row = (y - i32::from(list.y)) as usize;
                    match self.flat.get(self.top + row).copied() {
                        Some(Item::Finding(g, f)) => {
                            self.sel = self.key_of(g, f);
                            self.open_finding(cx);
                        }
                        Some(Item::Header(g)) => {
                            if let Some((path, _)) = self.files.iter().nth(g) {
                                let path = path.clone();
                                self.open_at(path, None, cx);
                            }
                        }
                        None => {}
                    }
                }
            }
            _ => {}
        }
    }

    // ---- words ----------------------------------------------------------------------------

    fn unavailable(&self) -> String {
        format!(
            "The language service is unavailable: this host does not report the \"{CAPABILITY}\" capability. No findings are shown because none can be read, not because there are none."
        )
    }

    fn unplaced(&self) -> usize {
        self.files
            .values()
            .flat_map(|f| &f.findings)
            .filter(|f| f.place.is_none())
            .count()
    }

    fn status(&self, caps_ok: bool) -> (String, bool) {
        if !caps_ok {
            return (self.unavailable(), true);
        }
        if let Some(notice) = &self.notice {
            return (notice.clone(), true);
        }
        if self.files.is_empty() {
            return (NO_FILES.to_owned(), false);
        }
        let n = self.total();
        let files = self.files.len();
        let mut text = if n == 0 {
            format!(
                "No findings in {files} {}.",
                if files == 1 { "file" } else { "files" }
            )
        } else {
            format!(
                "{n} {} in {files} {}.",
                if n == 1 { "finding" } else { "findings" },
                if files == 1 { "file" } else { "files" }
            )
        };
        if self.reading.is_some() {
            text.push_str(" Reading\u{2026}");
        }
        let unplaced = self.unplaced();
        if unplaced > 0 {
            text.push_str(&format!(
                " {unplaced} without a line: the text of their revision is not held, so the byte offset is shown."
            ));
        }
        (text, false)
    }

    fn actions_listed(&self, caps_ok: bool) -> Vec<NodeAction> {
        let refresh = if !caps_ok {
            Some(self.unavailable())
        } else if self.files.is_empty() {
            Some(NO_FILES.to_owned())
        } else if !self.identity.is_set() {
            Some("No workspace is open yet.".to_owned())
        } else {
            None
        };
        let moves = (!self.flat.iter().any(|i| matches!(i, Item::Finding(..))))
            .then(|| "There are no findings to select.".to_owned());
        let item = |id: &str, reason: Option<String>| NodeAction {
            id: ActionId::new(id),
            enabled: reason.is_none(),
            reason,
        };
        vec![
            item(actions::REFRESH, refresh),
            item(actions::FILTER_ALL, None),
            item(actions::FILTER_ERROR, None),
            item(actions::FILTER_WARNING, None),
            item(actions::FILTER_INFO, None),
            item(actions::FILTER_HINT, None),
            item(actions::FILTER_NEXT, None),
            item(actions::CURSOR_UP, moves.clone()),
            item(actions::CURSOR_DOWN, moves.clone()),
            item(
                actions::OPEN_FINDING,
                self.sel
                    .is_none()
                    .then(|| "No finding is selected.".to_owned()),
            ),
        ]
    }

    // ---- drawing --------------------------------------------------------------------------

    fn severity_style(s: &Styles, severity: Severity) -> Style {
        match severity {
            Severity::Error => s.finding_error,
            Severity::Warning => s.finding_warning,
            Severity::Info => s.info,
            Severity::Hint => s.hint,
        }
    }

    fn draw(&self, area: Rect, buf: &mut Buffer, focused: bool, caps_ok: bool, s: &Styles) {
        buf.set_style(area, s.text);
        let lay = self.lay(area, caps_ok);
        if area.height == 0 {
            return;
        }
        let mut x = area.x;
        for (label, filter) in chips(&self.counts(), self.total(), area.width) {
            let on = self.filter == filter;
            let w = text::width(&label) as u16;
            if x + w > area.x + area.width {
                break;
            }
            text::put(
                buf,
                x,
                area.y,
                w as usize,
                &label,
                if on { s.on } else { s.muted },
            );
            x += w + 1;
        }
        let (words, problem) = self.status(caps_ok);
        for (i, line) in text::wrap(
            &words,
            lay.status.width as usize,
            lay.status.height as usize,
        )
        .iter()
        .enumerate()
        {
            text::put(
                buf,
                lay.status.x,
                lay.status.y + i as u16,
                lay.status.width as usize,
                line,
                if problem { s.error } else { s.muted },
            );
        }
        let list = lay.list;
        let selected = self.sel_index();
        for y in 0..list.height {
            let index = self.top + y as usize;
            let Some(item) = self.flat.get(index) else {
                break;
            };
            let row = Rect::new(list.x, list.y + y, list.width, 1);
            match *item {
                Item::Header(g) => self.draw_header(g, row, buf, s),
                Item::Finding(g, f) => {
                    let Some((_, file)) = self.files.iter().nth(g) else {
                        continue;
                    };
                    let finding = &file.findings[f];
                    let is_sel = selected == Some(index);
                    let base = if !is_sel {
                        s.text
                    } else if focused {
                        s.cursor
                    } else {
                        s.cursor_idle
                    };
                    if is_sel {
                        buf.set_style(row, base);
                    }
                    let place = match finding.place {
                        Some((l, c)) => format!("{l}:{c}"),
                        None => format!("@{}", finding.start),
                    };
                    let head = format!("  {:<7} {:>8}  ", word(finding.severity), place);
                    let sev_style = if is_sel {
                        base
                    } else {
                        Self::severity_style(s, finding.severity)
                    };
                    let used = text::put(buf, row.x, row.y, row.width as usize, &head, sev_style);
                    let first = finding.message.lines().next().unwrap_or("");
                    let mut message = first.to_owned();
                    if let Some(source) = &finding.source {
                        message.push_str(&format!("  [{source}]"));
                    }
                    let cells = text::cells(&message, &[]);
                    let avail = row.width.saturating_sub(used);
                    let line = text::line(&cells, 0, avail as usize, base, Style::default());
                    buf.set_line(row.x + used, row.y, &line, avail);
                }
            }
        }
    }

    fn draw_header(&self, g: usize, row: Rect, buf: &mut Buffer, s: &Styles) {
        let Some((path, file)) = self.files.iter().nth(g) else {
            return;
        };
        let mut tail = format!(" ({})", file.findings.len());
        if let Some(rev) = file.revision {
            tail.push_str(&format!(" r{rev}"));
        }
        if file.partial {
            tail.push_str(" partial");
        }
        if let (Some(now), Some(rev)) = (file.document, file.revision)
            && now > rev
        {
            tail.push_str(&format!(" stale (document is at r{now})"));
        }
        if let Some(note) = &file.note {
            tail.push_str(&format!(" {note}"));
        }
        if file.findings.is_empty() && file.note.is_none() {
            tail.push_str(" no findings");
        }
        let room =
            (row.width as usize).saturating_sub(text::width(&tail).min(row.width as usize / 2));
        let shown = text::elide_middle(path, room);
        let used = text::put(buf, row.x, row.y, row.width as usize, &shown, s.bold);
        let rest = (row.width - used) as usize;
        text::put(
            buf,
            row.x + used,
            row.y,
            rest,
            &text::fit(&tail, rest),
            if file.note.is_some() {
                s.error
            } else {
                s.muted
            },
        );
    }

    fn nodes(&self, area: Rect, caps_ok: bool, focused: bool) -> Vec<Node> {
        let lay = self.lay(area, caps_ok);
        let mut root = Node::new("diagnostics", Role::Region, "Diagnostics", area);
        let (words, problem) = self.status(caps_ok);
        root.state.description = Some(words.clone());
        root.state.busy = self.reading.is_some();
        root.state.focused = focused;
        root.actions = self.actions_listed(caps_ok);
        let counts = self.counts();
        let mut out = vec![];
        let mut x = area.x;
        for (i, (label, filter)) in chips(&counts, self.total(), area.width)
            .into_iter()
            .enumerate()
        {
            let w = text::width(&label) as u16;
            let name = match filter {
                None => format!("All findings: {}", self.total()),
                Some(sev) => {
                    let n = counts[ORDER.iter().position(|o| *o == sev).unwrap_or(0)];
                    format!("{} findings: {n}", word(sev))
                }
            };
            let mut node = Node::new(
                &format!("filter:{i}"),
                Role::Button,
                &name,
                Rect::new(x, area.y, w.min(area.width), 1),
            );
            node.state.selected = self.filter == filter;
            node.actions = vec![NodeAction {
                id: ActionId::new(match filter {
                    None => actions::FILTER_ALL,
                    Some(Severity::Error) => actions::FILTER_ERROR,
                    Some(Severity::Warning) => actions::FILTER_WARNING,
                    Some(Severity::Info) => actions::FILTER_INFO,
                    Some(Severity::Hint) => actions::FILTER_HINT,
                }),
                enabled: true,
                reason: None,
            }];
            root.children.push(node.id.clone());
            out.push(node);
            x += w + 1;
        }
        let mut status = Node::new("status", Role::Status, &words, lay.status);
        if problem {
            status.role = Role::Alert;
        }
        root.children.push(status.id.clone());
        out.push(status);
        let mut list = Node::new("findings", Role::Tree, "Findings", lay.list);
        list.state.focused = focused;
        let size = self.flat.len().min(u16::MAX as usize) as u16;
        let selected = self.sel_index();
        for (offset, item) in self
            .flat
            .iter()
            .enumerate()
            .skip(self.top)
            .take(lay.list.height as usize)
        {
            let rect = Rect::new(
                lay.list.x,
                lay.list.y + (offset - self.top) as u16,
                lay.list.width,
                1,
            );
            let (name, level) = match *item {
                Item::Header(g) => {
                    let (path, file) = self.files.iter().nth(g).expect("a header names a file");
                    let mut name = format!("{path}: {} findings", file.findings.len());
                    if let Some(note) = &file.note {
                        name.push_str(&format!(", {note}"));
                    }
                    (name, 1)
                }
                Item::Finding(g, f) => {
                    let (path, file) = self.files.iter().nth(g).expect("a finding names a file");
                    let finding = &file.findings[f];
                    let place = match finding.place {
                        Some((l, c)) => format!("line {l} column {c}"),
                        None => format!("byte {}", finding.start),
                    };
                    let source = finding
                        .source
                        .as_ref()
                        .map(|s| format!(" from {s}"))
                        .unwrap_or_default();
                    (
                        format!(
                            "{} in {path} at {place}: {}{source}",
                            word(finding.severity),
                            finding.message
                        ),
                        2,
                    )
                }
            };
            let mut node = Node::new(&format!("finding:{offset}"), Role::TreeItem, &name, rect);
            node.level = Some(level);
            node.pos_in_set = Some((offset + 1).min(size as usize) as u16);
            node.set_size = Some(size);
            node.state.selected = selected == Some(offset);
            if matches!(item, Item::Finding(..)) {
                node.actions = vec![NodeAction {
                    id: ActionId::new(actions::OPEN_FINDING),
                    enabled: true,
                    reason: None,
                }];
            }
            list.children.push(node.id.clone());
            out.push(node);
        }
        root.children.push(list.id.clone());
        let mut all = vec![root];
        all.extend(out);
        all.push(list);
        all
    }
}

const NO_FILES: &str = "No findings have been read yet: nothing has told this panel which documents to ask the language service about.";

struct Layout {
    status: Rect,
    list: Rect,
}

/// The rows the status line may take when it is long.
const STATUS_ROWS: usize = 3;

fn layout(area: Rect, status_rows: u16) -> Layout {
    let status_rows = status_rows.min(area.height.saturating_sub(1));
    let top = (1 + status_rows).min(area.height);
    Layout {
        status: if status_rows > 0 {
            Rect::new(area.x, area.y + 1, area.width, status_rows)
        } else {
            Rect::default()
        },
        list: Rect::new(area.x, area.y + top, area.width, area.height - top),
    }
}

/// Turns each finding's byte offset into a line and column, when the file's text is held at
/// the revision the findings are against. Otherwise the place is unknown.
fn place_all(file: &mut FileSet) {
    let text = match (&file.text, file.revision) {
        (Some((at, text)), Some(rev)) if *at == rev => Some(text.as_str()),
        _ => None,
    };
    for finding in &mut file.findings {
        finding.place = text.and_then(|t| place_of(t, finding.start));
    }
}

fn place_of(text: &str, byte: u64) -> Option<(u32, u32)> {
    let byte = usize::try_from(byte).ok()?;
    if byte > text.len() || !text.is_char_boundary(byte) {
        return None;
    }
    let before = &text[..byte];
    let line = before.matches('\n').count() as u32 + 1;
    let start = before.rfind('\n').map_or(0, |i| i + 1);
    let column = before[start..].encode_utf16().count() as u32 + 1;
    Some((line, column))
}

impl Panel for DiagnosticsPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.yielding = false;
        self.adopt(cx.workspace());
        self.caps_ok = cx.capabilities().has(&Capability::new(CAPABILITY));
        let quiet = matches!(
            msg,
            PanelMsg::Resize { .. } | PanelMsg::Focus(_) | PanelMsg::Workspace(_)
        );
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.area = Rect::new(0, 0, area.width, area.height);
                self.clamp_top();
            }
            PanelMsg::Completion(c) => self.on_completion(c, false),
            // An accepted answer for another document is still true of that document, and this
            // panel shows many.
            PanelMsg::Cached(c) => self.on_completion(c, true),
            PanelMsg::Host(message) => self.on_host(message),
            PanelMsg::Action(id) => self.on_action(&id, cx),
            _ => {}
        }
        if !quiet {
            self.pump(cx);
        }
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        let caps_ok = cx.capabilities().has(&Capability::new(CAPABILITY));
        self.draw(
            area,
            buf,
            cx.focused,
            caps_ok,
            &Styles::from_theme(cx.theme),
        );
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let caps_ok = cx.capabilities().has(&Capability::new(CAPABILITY));
        let mut nodes = self.nodes(area, caps_ok, cx.focused);
        if let (Some(root), Some(b)) = (nodes.first_mut(), self.binding()) {
            root.binding = b.resource;
            root.revision = b.revision;
        }
        nodes
    }

    fn serialize(&self) -> Value {
        serde_json::to_value(ViewState {
            filter: self.filter.map(|s| word(s).to_owned()),
            scroll: self.top,
            files: self
                .files
                .iter()
                .map(|(path, f)| SavedFile {
                    path: path.clone(),
                    revision: f.document.or(f.revision),
                })
                .collect(),
        })
        .unwrap_or(Value::Null)
    }

    fn tab_label(&self) -> Option<TabLabel> {
        let n = self.total();
        (n > 0).then(|| TabLabel {
            title: format!("Diagnostics ({n})"),
            modified: false,
        })
    }

    /// The document being read, else the one under the cursor, else the workspace.
    fn binding(&self) -> Option<Binding> {
        let path = self
            .reading
            .as_ref()
            .map(|(_, p)| p.clone())
            .or_else(|| self.sel.as_ref().map(|(p, _)| p.clone()))
            .filter(|_| !self.yielding);
        let generation = Some(Generation(self.identity.generation.0));
        Some(match path {
            Some(path) => Binding {
                revision: self
                    .files
                    .get(&path)
                    .and_then(|f| f.revision)
                    .map(Revision::Seq),
                resource: ResourceRef::Document {
                    workspace: self.identity.workspace.clone(),
                    resource_id: path,
                },
                generation,
            },
            None => Binding {
                resource: ResourceRef::Workspace {
                    workspace: self.identity.workspace.clone(),
                },
                revision: None,
                generation,
            },
        })
    }
}

pub(crate) fn kind() -> PanelKind {
    PanelKind::new(KIND)
}

/// The registry entries. Reading is a `Start` that names the language read it sends; the
/// filters and movement are local.
pub(crate) fn descriptors() -> Vec<ActionDescriptor> {
    let local = |id: &str, title: &str| ActionDescriptor::local(id, title).requires(CAPABILITY);
    vec![
        ActionDescriptor::new(
            actions::REFRESH,
            "Read the findings again",
            ActionIntent::Start,
        )
        .requires(CAPABILITY)
        .emits(EffectKind::LanguageDiagnostics),
        local(actions::FILTER_ALL, "Show findings of every severity"),
        local(actions::FILTER_ERROR, "Show only errors"),
        local(actions::FILTER_WARNING, "Show only warnings"),
        local(actions::FILTER_INFO, "Show only information"),
        local(actions::FILTER_HINT, "Show only hints"),
        local(actions::FILTER_NEXT, "Show the next severity"),
        local(actions::CURSOR_UP, "Select the previous finding"),
        local(actions::CURSOR_DOWN, "Select the next finding"),
        local(
            actions::OPEN_FINDING,
            "Open the selected finding in the editor",
        ),
    ]
}
