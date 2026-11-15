//! The Search panel: a query with regex, case and whole-word switches and include and
//! exclude globs, and the results the search owner reads out page by page.
//!
//! The panel is a view over what the owner says. `searchQuery` answers with an id once the
//! host has accepted the query; the pages follow as `HostMessage::SearchPage`, which the root
//! routes here by that id and which this panel checks against the id it is showing, so a page
//! of a search it has left is dropped. A refusal, a failure and an uncertain answer are put on
//! screen as the owner worded them and are never sent again without the person asking. The
//! owner stops delivering for an id the moment it is cancelled, so a cancel is shown as
//! cancelled at once and the answer to it only adds what the owner said about it.

use std::collections::{BTreeMap, BTreeSet};

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{Effect, EffectBody, EffectKind, SearchCancel, SearchQuery};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{
    ActionId, Capability, EffectId, Generation, PanelKind, ResourceRef, WorkspaceIdentity,
};
use theorem_workbench_core::registry::{ActionDescriptor, ActionIntent};
use theorem_workbench_core::results::{
    SearchEnd, SearchEndOutcome, SearchRow, SearchState, SpanEncoding,
};
use theorem_workbench_core::semantics::{Node, NodeAction, Role};
use theorem_workbench_core::stale::Binding;
use theorem_workbench_core::{
    Button, Ctx, OpenTarget, Panel, PanelFactories, PanelMsg, PanelPointer, PointerKind, TabLabel,
    ViewCtx,
};
use theorem_workbench_text::visible::visible;

use crate::field::{Field, Look};
use crate::replace::{self, Group, Plan, Row, Run, Scope, Summary};
use crate::styles::Styles;
use crate::text;

pub const KIND: &str = "search";
pub const CAPABILITY: &str = "search.query";
/// What the replace writes through: the documents owner.
const DOCUMENTS: &str = "documents";

/// The action ids of the panel, as `descriptors` registers them.
pub mod actions {
    pub const RUN: &str = "search.run";
    pub const CANCEL: &str = "search.cancel";
    pub const TOGGLE_REGEX: &str = "search.toggle-regex";
    pub const TOGGLE_CASE: &str = "search.toggle-case";
    pub const TOGGLE_WORD: &str = "search.toggle-word";
    pub const NEXT_FIELD: &str = "search.next-field";
    pub const CURSOR_UP: &str = "search.cursor-up";
    pub const CURSOR_DOWN: &str = "search.cursor-down";
    pub const OPEN_RESULT: &str = "search.open-result";
    pub const CLEAR: &str = "search.clear";
    /// Ask to replace every match of the finished search. The person only.
    pub const REPLACE_ALL: &str = "search.replaceAll";
    /// Ask to replace the matches in the selected result's file. The person only.
    pub const REPLACE_IN_FILE: &str = "search.replaceInFile";
    /// Answer yes to the question the two above ask. The person only.
    pub const REPLACE_CONFIRM: &str = "search.replaceConfirm";
    /// Stop after the file in hand, or call off the question.
    pub const REPLACE_STOP: &str = "search.replaceStop";
    /// Put the summary of a finished replace away.
    pub const REPLACE_DISMISS: &str = "search.replaceDismiss";
}

/// Files the host scans per call. The owner pages through the rest on its own.
const LIMIT: u32 = 200;
/// Rows kept. A search that reads more is shown as cut here and says so.
const MAX_ROWS: usize = 5_000;
const LABEL: u16 = 8;
const PAGE: isize = 10;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ViewState {
    query: String,
    replacement: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: Vec<String>,
    exclude: Vec<String>,
    scroll: usize,
}

/// Registers the panel under the builtin kind `"search"`.
pub fn register(factories: &mut PanelFactories) {
    factories.register(KIND, |state, _version| {
        Box::new(SearchPanel::restore(state))
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Focus {
    Query,
    Replace,
    Include,
    Exclude,
    Results,
}

/// What a search was asked, for telling whether the results shown still answer the fields.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Spec {
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: Vec<String>,
    exclude: Vec<String>,
}

/// An owner's refusal, failure or uncertain answer, in its words.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Told {
    outcome: SearchEndOutcome,
    code: Option<String>,
    reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Status {
    /// Nothing asked yet, or the fields were restored from a saved layout.
    Idle,
    /// The query is sent and the owner has not answered.
    Starting(EffectId),
    /// The owner is reading; pages carry this id.
    Reading(String),
    Complete,
    Cancelled,
    /// The search did not run, or ended early, as the owner said.
    Told(Told),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Item {
    Header(usize),
    Row(usize, usize),
}

/// Where each part of the panel is, for drawing and for the pointer.
struct Layout {
    query: Rect,
    chips: [Rect; 3],
    replace: Rect,
    /// `[All]` and `[File]` at the end of the replace row.
    replace_chips: [Rect; 2],
    include: Rect,
    exclude: Rect,
    status: Rect,
    chip: Rect,
    list: Rect,
}

const CHIPS: [(&str, &str); 3] = [
    ("[.*]", "Regular expression"),
    ("[Aa]", "Match case"),
    ("[W]", "Whole word"),
];
const CHIP_WIDTH: u16 = 8;
const REPLACE_CHIPS: [(&str, &str); 2] = [
    ("[All]", "Replace all matches"),
    ("[File]", "Replace in the selected file"),
];

/// The rows the status line may take when it is long.
const STATUS_ROWS: usize = 3;
/// And while a replace is asked, running or summarised: its words are the ones to read.
const STATUS_ROWS_REPLACE: usize = 5;
/// Columns of one line of a replace preview before it wraps onto an indented line.
const WRAP_INDENT: &str = "    ";
/// The most characters of one line a preview shows.
const PREVIEW_CHARS: usize = 1_000;

fn layout(area: Rect, status_rows: u16) -> Layout {
    let at = |row: u16, x: u16, w: u16| {
        if row < area.height && w > 0 {
            Rect::new(
                area.x + x,
                area.y + row,
                w.min(area.width.saturating_sub(x)),
                1,
            )
        } else {
            Rect::default()
        }
    };
    let label = LABEL.min(area.width);
    let chips_w: u16 = CHIPS.iter().map(|c| c.0.len() as u16).sum::<u16>() + 1;
    let query_w = area.width.saturating_sub(label + chips_w).max(1);
    let mut chips = [Rect::default(); 3];
    let mut x = label + query_w + 1;
    for (i, (glyph, _)) in CHIPS.iter().enumerate() {
        chips[i] = at(0, x, glyph.len() as u16);
        x += glyph.len() as u16;
    }
    let list_top = (4 + status_rows).min(area.height);
    let rest = area.width.saturating_sub(label);
    let rchips_w: u16 = REPLACE_CHIPS.iter().map(|c| c.0.len() as u16).sum::<u16>() + 1;
    let replace_w = rest.saturating_sub(rchips_w).max(1);
    let mut replace_chips = [Rect::default(); 2];
    let mut rx = label + replace_w + 1;
    for (i, (glyph, _)) in REPLACE_CHIPS.iter().enumerate() {
        replace_chips[i] = at(1, rx, glyph.len() as u16);
        rx += glyph.len() as u16;
    }
    Layout {
        query: at(0, label, query_w),
        chips,
        replace: at(1, label, replace_w),
        replace_chips,
        include: at(2, label, rest),
        exclude: at(3, label, rest),
        status: {
            let w = area.width.saturating_sub(CHIP_WIDTH + 1);
            let mut r = at(4, 0, w);
            r.height = status_rows
                .min(area.height.saturating_sub(4))
                .max(u16::from(r.width > 0));
            r
        },
        chip: at(4, area.width.saturating_sub(CHIP_WIDTH), CHIP_WIDTH),
        list: Rect::new(
            area.x,
            area.y + list_top,
            area.width,
            area.height - list_top,
        ),
    }
}

/// Where a replace stands.
enum Job {
    Idle,
    /// The question: how many matches in how many files, and the preview.
    Confirm(Plan),
    Running(Box<Run>),
    /// How it ended. Stays until dismissed.
    Done(Summary),
}

impl Job {
    /// The keys belong to the question or the run, not to the fields.
    fn modal(&self) -> bool {
        matches!(self, Job::Confirm(_) | Job::Running(_))
    }
}

pub struct SearchPanel {
    query: Field,
    replacement: Field,
    job: Job,
    /// The first logical line of the replace preview, progress or summary on screen.
    job_top: usize,
    docs_ok: bool,
    runs: u64,
    include: Field,
    exclude: Field,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    focus: Focus,
    status: Status,
    /// What the results on screen were asked.
    shown: Option<Spec>,
    groups: Vec<Group>,
    flat: Vec<Item>,
    sel: Option<(usize, usize)>,
    top: usize,
    skipped: u32,
    truncated: bool,
    max_line: u32,
    /// Pages of a search the panel had already left, dropped.
    dropped_pages: u32,
    notice: Option<String>,
    identity: WorkspaceIdentity,
    caps_ok: bool,
    area: Rect,
    /// Query effects whose answers belong to a search the person has moved on from: when one
    /// is accepted its id is cancelled at once.
    retired: BTreeSet<EffectId>,
    /// Searches to cancel on the next message that may start work (the one that left them
    /// could not).
    owed: Vec<String>,
    /// The cancels in flight, by effect, with the search each is for.
    cancels: BTreeMap<EffectId, String>,
}

impl SearchPanel {
    pub fn restore(state: &Value) -> Self {
        let saved: ViewState = serde_json::from_value(state.clone()).unwrap_or_default();
        let mut panel = Self {
            query: Field::new(&saved.query),
            replacement: Field::new(&saved.replacement),
            job: Job::Idle,
            job_top: 0,
            docs_ok: true,
            runs: 0,
            include: Field::new(&saved.include.join(", ")),
            exclude: Field::new(&saved.exclude.join(", ")),
            regex: saved.regex,
            case_sensitive: saved.case_sensitive,
            whole_word: saved.whole_word,
            focus: Focus::Query,
            status: Status::Idle,
            shown: None,
            groups: vec![],
            flat: vec![],
            sel: None,
            top: saved.scroll,
            skipped: 0,
            truncated: false,
            max_line: 0,
            dropped_pages: 0,
            notice: None,
            identity: WorkspaceIdentity::default(),
            caps_ok: true,
            area: Rect::default(),
            retired: BTreeSet::new(),
            owed: vec![],
            cancels: BTreeMap::new(),
        };
        panel.clamp_top();
        panel
    }

    // ---- state read by tests and the host ------------------------------------------

    /// Pages dropped because they were for a search the panel had left.
    pub fn dropped_pages(&self) -> u32 {
        self.dropped_pages
    }

    /// Matches read so far, counting each marked range once and a row with none once.
    pub fn match_count(&self) -> usize {
        self.groups
            .iter()
            .flat_map(|g| &g.rows)
            .map(|r| r.matches.len().max(1))
            .sum()
    }

    /// The layout for `area`, with as many status rows as the status line needs.
    fn lay(&self, area: Rect, caps_ok: bool) -> Layout {
        let width = area.width.saturating_sub(CHIP_WIDTH + 1) as usize;
        let words = self.status_text(caps_ok).0;
        let cap = if matches!(self.job, Job::Idle) {
            STATUS_ROWS
        } else {
            STATUS_ROWS_REPLACE
        };
        let rows = text::wrap(&words, width, cap).len().max(1);
        layout(area, rows as u16)
    }

    fn list_height(&self) -> usize {
        self.lay(self.area, self.caps_ok).list.height as usize
    }

    fn spec(&self) -> Spec {
        Spec {
            query: self.query.value().to_owned(),
            regex: self.regex,
            case_sensitive: self.case_sensitive,
            whole_word: self.whole_word,
            include: globs(self.include.value()),
            exclude: globs(self.exclude.value()),
        }
    }

    fn running(&self) -> bool {
        matches!(self.status, Status::Starting(_) | Status::Reading(_))
    }

    fn rebuild(&mut self) {
        self.flat.clear();
        for (g, group) in self.groups.iter().enumerate() {
            self.flat.push(Item::Header(g));
            for r in 0..group.rows.len() {
                self.flat.push(Item::Row(g, r));
            }
        }
        if self.sel.is_none() {
            self.sel = self
                .groups
                .iter()
                .enumerate()
                .find_map(|(g, grp)| (!grp.rows.is_empty()).then_some((g, 0)));
        }
        self.clamp_top();
    }

    fn sel_index(&self) -> Option<usize> {
        let (g, r) = self.sel?;
        self.flat.iter().position(|i| *i == Item::Row(g, r))
    }

    fn clamp_top(&mut self) {
        let h = self.list_height().max(1);
        self.top = self.top.min(self.flat.len().saturating_sub(h));
    }

    fn reveal_selection(&mut self) {
        let h = self.list_height().max(1);
        if let Some(i) = self.sel_index() {
            if i < self.top {
                // Show the file's header with its first row.
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

    fn clear_results(&mut self) {
        self.groups.clear();
        self.flat.clear();
        self.sel = None;
        self.top = 0;
        self.skipped = 0;
        self.truncated = false;
        self.max_line = 0;
    }

    // ---- sending ---------------------------------------------------------------------

    fn emit(&mut self, cx: &mut Ctx, body: EffectBody) -> Option<EffectId> {
        let resource = ResourceRef::Workspace {
            workspace: self.identity.workspace.clone(),
        };
        let generation = self.identity.generation;
        match cx.emit(|id| Effect::new(id, resource, body).with_generation(generation)) {
            Ok(id) => Some(id),
            Err(error) => {
                self.notice = Some(format!("Not sent: {error}."));
                None
            }
        }
    }

    fn send_cancel(&mut self, cx: &mut Ctx, id: String) {
        if let Some(effect) = self.emit(
            cx,
            EffectBody::SearchCancel(SearchCancel { id: id.clone() }),
        ) {
            self.cancels.insert(effect, id);
        }
    }

    /// Cancels the searches an earlier silent message could not.
    fn flush(&mut self, cx: &mut Ctx) {
        for id in std::mem::take(&mut self.owed) {
            self.send_cancel(cx, id);
        }
    }

    /// Lets go of the search on screen: a cancel for what is reading, and the answer to
    /// what is starting is to be cancelled when it arrives.
    fn leave_search(&mut self, cx: Option<&mut Ctx>) {
        match std::mem::replace(&mut self.status, Status::Idle) {
            Status::Starting(effect) => {
                self.retired.insert(effect);
            }
            Status::Reading(id) => match cx {
                Some(cx) => self.send_cancel(cx, id),
                None => self.owed.push(id),
            },
            other => self.status = other,
        }
    }

    fn adopt(&mut self, identity: &WorkspaceIdentity) {
        if self.identity == *identity {
            return;
        }
        let moved = self.identity.is_set()
            && (self.identity.workspace != identity.workspace
                || self.identity.environment != identity.environment);
        if moved {
            // Results of another workspace are not this one's, and its search is not ours to
            // keep reading.
            self.leave_search(None);
            self.clear_results();
            self.shown = None;
            self.status = Status::Idle;
            self.notice = None;
            match &mut self.job {
                // The run keeps the workspace it began in; what is in flight is answered.
                Job::Running(run) => run.stop("The workspace changed, so the run stopped."),
                Job::Confirm(_) => self.job = Job::Idle,
                _ => {}
            }
        }
        self.identity = identity.clone();
    }

    fn unavailable(&self) -> String {
        format!("Search is unavailable: this host does not report the \"{CAPABILITY}\" capability.")
    }

    fn run(&mut self, cx: &mut Ctx) {
        self.notice = None;
        if !matches!(self.job, Job::Idle) {
            self.notice = Some(
                "A replace is open: answer it or dismiss it (Esc) before searching again."
                    .to_owned(),
            );
            return;
        }
        if !self.caps_ok {
            self.notice = Some(self.unavailable());
            return;
        }
        if self.query.is_empty() {
            self.notice = Some("Type what to find first.".to_owned());
            return;
        }
        if !self.identity.is_set() {
            self.notice = Some("No workspace is open yet.".to_owned());
            return;
        }
        let spec = self.spec();
        let query = SearchQuery {
            query: spec.query.clone(),
            regex: spec.regex,
            case_sensitive: spec.case_sensitive,
            whole_word: spec.whole_word,
            include: (!spec.include.is_empty()).then(|| spec.include.clone()),
            exclude: (!spec.exclude.is_empty()).then(|| spec.exclude.clone()),
            limit: LIMIT,
        };
        // A new query cancels the old one before it is sent.
        self.leave_search(Some(cx));
        self.clear_results();
        self.shown = Some(spec);
        match self.emit(cx, EffectBody::SearchQuery(query)) {
            Some(effect) => self.status = Status::Starting(effect),
            None => self.status = Status::Idle,
        }
    }

    fn cancel(&mut self, cx: &mut Ctx) {
        match self.status.clone() {
            Status::Starting(effect) => {
                self.retired.insert(effect);
                self.status = Status::Cancelled;
            }
            Status::Reading(id) => {
                self.send_cancel(cx, id);
                self.status = Status::Cancelled;
            }
            _ => self.notice = Some("No search is running.".to_owned()),
        }
    }

    // ---- what comes back ---------------------------------------------------------------

    fn on_completion(&mut self, completion: Completion) {
        if let Job::Running(run) = &mut self.job
            && run.on_completion(&completion)
        {
            return;
        }
        if let Some(id) = self.cancels.remove(&completion.effect) {
            self.notice = match completion.outcome {
                Outcome::Accepted => None,
                Outcome::Refused { code, reason } => Some(format!(
                    "Cancelling was refused ({code}): {reason} The search \"{id}\" may still be running; its pages are no longer shown."
                )),
                Outcome::Failed { reason } => Some(format!(
                    "Cancelling failed: {reason} The search \"{id}\" may still be running; its pages are no longer shown."
                )),
                Outcome::Uncertain { reason } => Some(format!(
                    "Unknown whether the search was cancelled: {reason} Its pages are no longer shown."
                )),
            };
            return;
        }
        let retired = self.retired.remove(&completion.effect);
        if !retired && self.status != Status::Starting(completion.effect) {
            return;
        }
        match (completion.outcome, completion.payload) {
            (Outcome::Accepted, Some(CompletionPayload::SearchStarted(started))) => {
                if retired {
                    self.owed.push(started.id);
                } else {
                    self.status = Status::Reading(started.id);
                }
            }
            (Outcome::Accepted, _) if !retired => {
                self.status = Status::Told(Told {
                    outcome: SearchEndOutcome::Uncertain,
                    code: None,
                    reason: "The host accepted the search but gave no id, so its pages cannot be told apart."
                        .to_owned(),
                });
            }
            (Outcome::Refused { code, reason }, _) if !retired => {
                self.status = Status::Told(Told {
                    outcome: SearchEndOutcome::Refused,
                    code: Some(code),
                    reason,
                });
            }
            (Outcome::Failed { reason }, _) if !retired => {
                self.status = Status::Told(Told {
                    outcome: SearchEndOutcome::Failed,
                    code: None,
                    reason,
                });
            }
            (Outcome::Uncertain { reason }, _) if !retired => {
                self.status = Status::Told(Told {
                    outcome: SearchEndOutcome::Uncertain,
                    code: None,
                    reason,
                });
            }
            _ => {}
        }
    }

    fn on_page(
        &mut self,
        id: &str,
        rows: Vec<SearchRow>,
        skipped: u32,
        state: SearchState,
        end: Option<SearchEnd>,
        encoding: SpanEncoding,
    ) {
        match &self.status {
            Status::Reading(active) if active == id => {}
            _ => {
                self.dropped_pages += 1;
                return;
            }
        }
        self.skipped += skipped;
        for row in rows {
            if self.groups.iter().map(|g| g.rows.len()).sum::<usize>() >= MAX_ROWS {
                self.truncated = true;
                break;
            }
            self.max_line = self.max_line.max(row.line);
            // The highlight and the opened column are placed in UTF-16 whatever unit the page
            // counted in, so the two stay one number.
            let matches = row
                .matches
                .iter()
                .map(|m| text::to_utf16(&row.text, (m.start, m.end), encoding))
                .collect();
            let item = Row {
                line: row.line,
                text: row.text,
                matches,
                text_offset: row.text_offset.unwrap_or(0),
            };
            match self.groups.iter_mut().find(|g| g.path == row.path) {
                Some(group) => group.rows.push(item),
                None => self.groups.push(Group {
                    path: row.path,
                    rows: vec![item],
                }),
            }
        }
        self.rebuild();
        match state {
            SearchState::More => {}
            SearchState::Complete => self.status = Status::Complete,
            SearchState::Cancelled => self.status = Status::Cancelled,
            SearchState::Ended => {
                let told = match end {
                    Some(end) => Told {
                        outcome: end.outcome,
                        code: end.code,
                        reason: end.reason,
                    },
                    None => Told {
                        outcome: SearchEndOutcome::Uncertain,
                        code: None,
                        reason: "The search ended early and the host gave no reason.".to_owned(),
                    },
                };
                self.status = Status::Told(told);
            }
        }
    }

    // ---- what the person does ------------------------------------------------------------

    fn open(&mut self, cx: &mut Ctx) {
        let Some((g, r)) = self.sel else {
            return;
        };
        let (Some(group), true) = (self.groups.get(g), self.identity.is_set()) else {
            return;
        };
        let Some(row) = group.rows.get(r) else {
            return;
        };
        let start = row.matches.iter().map(|m| m.0).min().unwrap_or(0);
        cx.open(OpenTarget::FileAt {
            workspace: self.identity.workspace.clone(),
            path: group.path.clone(),
            line: row.line,
            column: row.text_offset + start + 1,
        });
    }

    fn open_file(&mut self, group: usize, cx: &mut Ctx) {
        if let Some(group) = self.groups.get(group) {
            cx.open(OpenTarget::File {
                workspace: self.identity.workspace.clone(),
                path: group.path.clone(),
            });
        }
    }

    fn move_by(&mut self, delta: isize) {
        let rows: Vec<(usize, usize)> = self
            .flat
            .iter()
            .filter_map(|i| match i {
                Item::Row(g, r) => Some((*g, *r)),
                Item::Header(_) => None,
            })
            .collect();
        if rows.is_empty() {
            return;
        }
        let at = self
            .sel
            .and_then(|s| rows.iter().position(|r| *r == s))
            .unwrap_or(0) as isize;
        let next = (at + delta).clamp(0, rows.len() as isize - 1) as usize;
        self.sel = Some(rows[next]);
        self.reveal_selection();
    }

    fn toggle(&mut self, which: usize) {
        match which {
            0 => self.regex = !self.regex,
            1 => self.case_sensitive = !self.case_sensitive,
            _ => self.whole_word = !self.whole_word,
        }
    }

    fn next_focus(&mut self, back: bool) {
        let order = [
            Focus::Query,
            Focus::Replace,
            Focus::Include,
            Focus::Exclude,
            Focus::Results,
        ];
        let at = order.iter().position(|f| *f == self.focus).unwrap_or(0);
        let next = if back {
            (at + order.len() - 1) % order.len()
        } else {
            (at + 1) % order.len()
        };
        self.focus = order[next];
    }

    fn field_mut(&mut self) -> Option<&mut Field> {
        if self.job.modal() {
            return None;
        }
        match self.focus {
            Focus::Query => Some(&mut self.query),
            Focus::Replace => Some(&mut self.replacement),
            Focus::Include => Some(&mut self.include),
            Focus::Exclude => Some(&mut self.exclude),
            Focus::Results => None,
        }
    }

    fn on_action(&mut self, id: &ActionId, cx: &mut Ctx) {
        match id.as_str() {
            actions::RUN => self.run(cx),
            actions::CANCEL => self.cancel(cx),
            actions::TOGGLE_REGEX => self.toggle(0),
            actions::TOGGLE_CASE => self.toggle(1),
            actions::TOGGLE_WORD => self.toggle(2),
            actions::NEXT_FIELD => self.next_focus(false),
            actions::CURSOR_UP => {
                self.focus = Focus::Results;
                self.move_by(-1)
            }
            actions::CURSOR_DOWN => {
                self.focus = Focus::Results;
                self.move_by(1)
            }
            actions::OPEN_RESULT => self.open(cx),
            actions::REPLACE_ALL => self.ask(false),
            actions::REPLACE_IN_FILE => self.ask(true),
            actions::REPLACE_CONFIRM => self.confirm(),
            actions::REPLACE_STOP => self.stop_job(),
            actions::REPLACE_DISMISS => self.dismiss(),
            actions::CLEAR => {
                self.leave_search(Some(cx));
                self.clear_results();
                self.shown = None;
                self.status = Status::Idle;
                self.notice = None;
            }
            _ => {}
        }
    }

    fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let mods = key.mods();
        if self.job.modal() {
            return self.on_job_key(&key);
        }
        if replace_in_file_chord(&key) {
            return self.ask(true);
        }
        if let Some(which) = toggle_chord(&key) {
            return self.toggle(which);
        }
        match key.key() {
            Key::Tab => return self.next_focus(mods.contains(Mods::SHIFT)),
            Key::Enter if matches!(self.job, Job::Done(_)) && self.focus == Focus::Results => {
                return self.dismiss();
            }
            Key::Enter if self.focus == Focus::Results => return self.open(cx),
            Key::Enter if self.focus == Focus::Replace => return self.ask(false),
            Key::Enter => return self.run(cx),
            Key::Esc if matches!(self.job, Job::Done(_)) => return self.dismiss(),
            Key::Esc => {
                if self.running() {
                    return self.cancel(cx);
                }
                self.focus = if self.focus == Focus::Results {
                    Focus::Query
                } else if self.flat.is_empty() {
                    return;
                } else {
                    Focus::Results
                };
                return;
            }
            _ => {}
        }
        if self.focus == Focus::Results {
            if !matches!(self.job, Job::Idle) {
                return self.scroll_job(&key);
            }
            let page = (self.list_height().max(2) - 1) as isize;
            match key.key() {
                Key::Up => self.move_by(-1),
                Key::Down => self.move_by(1),
                Key::PageUp => self.move_by(-page.min(PAGE * 10)),
                Key::PageDown => self.move_by(page.min(PAGE * 10)),
                Key::Home => self.move_by(-1_000_000),
                Key::End => self.move_by(1_000_000),
                Key::Char('/') if mods.is_empty() => self.focus = Focus::Query,
                // Typing in the list goes to the query, as it does in a file tree's filter.
                Key::Char(c) if mods.difference(Mods::SHIFT).is_empty() => {
                    self.focus = Focus::Query;
                    self.query.insert(&c.to_string());
                }
                _ => {}
            }
            return;
        }
        if key.key() == Key::Down && !self.flat.is_empty() {
            self.focus = Focus::Results;
            return;
        }
        if let Some(field) = self.field_mut() {
            field.key(&key);
        }
    }

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let lay = self.lay(self.area, self.caps_ok);
        let (x, y) = (p.x, p.y);
        let inside = |r: Rect| {
            r.width > 0
                && x >= i32::from(r.x - self.area.x)
                && x < i32::from(r.x - self.area.x + r.width)
                && y == i32::from(r.y - self.area.y)
        };
        match p.kind {
            PointerKind::Wheel { dy, .. } if !matches!(self.job, Job::Idle) => {
                let max = self.overlay().len().saturating_sub(1) as isize;
                self.job_top = (self.job_top as isize + isize::from(dy) * 3).clamp(0, max) as usize;
            }
            PointerKind::Wheel { dy, .. } => {
                let h = self.list_height();
                let max = self.flat.len().saturating_sub(h);
                let next = (self.top as isize + isize::from(dy) * 3).clamp(0, max as isize);
                self.top = next as usize;
            }
            PointerKind::Down(Button::Left) => {
                if self.job.modal() {
                    return;
                }
                for (i, chip) in lay.replace_chips.iter().enumerate() {
                    if inside(*chip) {
                        return self.ask(i == 1);
                    }
                }
                for (focus, rect) in [
                    (Focus::Query, lay.query),
                    (Focus::Replace, lay.replace),
                    (Focus::Include, lay.include),
                    (Focus::Exclude, lay.exclude),
                ] {
                    if inside(rect) {
                        self.focus = focus;
                        let column = (x - i32::from(rect.x - self.area.x)) as usize;
                        let shown = rect.width as usize;
                        if let Some(field) = self.field_mut() {
                            field.click(column, shown);
                        }
                        return;
                    }
                }
                for (i, chip) in lay.chips.iter().enumerate() {
                    if inside(*chip) {
                        return self.toggle(i);
                    }
                }
                if inside(lay.chip) {
                    return if self.running() {
                        self.cancel(cx)
                    } else {
                        self.run(cx)
                    };
                }
                let list = lay.list;
                if !matches!(self.job, Job::Idle) {
                    return;
                }
                if list.height > 0
                    && y >= i32::from(list.y - self.area.y)
                    && y < i32::from(list.y - self.area.y + list.height)
                {
                    let row = (y - i32::from(list.y - self.area.y)) as usize;
                    match self.flat.get(self.top + row).copied() {
                        Some(Item::Row(g, r)) => {
                            self.sel = Some((g, r));
                            self.focus = Focus::Results;
                            self.open(cx);
                        }
                        Some(Item::Header(g)) => {
                            self.focus = Focus::Results;
                            self.open_file(g, cx);
                        }
                        None => {}
                    }
                }
            }
            _ => {}
        }
    }

    // ---- replace --------------------------------------------------------------------------

    /// Why a replace cannot be asked for now, in words.
    fn replace_blocker(&self, in_file: bool) -> Option<String> {
        if !self.docs_ok {
            return Some(
                "Replace is unavailable: this host does not report the \"documents\" capability."
                    .to_owned(),
            );
        }
        match &self.job {
            Job::Idle => {}
            Job::Confirm(_) => return Some("A replace is waiting for your answer.".to_owned()),
            Job::Running(_) => return Some("A replace is already running.".to_owned()),
            Job::Done(_) => {
                return Some("Dismiss the summary of the last replace first (Esc).".to_owned());
            }
        }
        if !self.identity.is_set() {
            return Some("No workspace is open yet.".to_owned());
        }
        match &self.status {
            Status::Complete => {}
            Status::Idle => {
                return Some("Search first: replace works on a finished search.".to_owned());
            }
            Status::Starting(_) | Status::Reading(_) => {
                return Some(
                    "The search is still running. Replace waits for it to finish.".to_owned(),
                );
            }
            Status::Cancelled | Status::Told(_) => {
                return Some(
                    "The search did not finish, so its matches are partial. Search again first."
                        .to_owned(),
                );
            }
        }
        if self.truncated {
            return Some(format!(
                "Only the first {MAX_ROWS} rows of the search are kept, so replacing all would miss matches. Narrow the search."
            ));
        }
        if self
            .shown
            .as_ref()
            .is_some_and(|shown| *shown != self.spec())
        {
            return Some(
                "The query or its options changed since the search. Press Enter in Find to search again."
                    .to_owned(),
            );
        }
        if self.groups.is_empty() {
            return Some("There are no results to replace.".to_owned());
        }
        if in_file && self.sel.is_none() {
            return Some("Select a result first.".to_owned());
        }
        None
    }

    /// Asks the question: how many matches in how many files, with the preview.
    fn ask(&mut self, in_file: bool) {
        self.notice = None;
        if let Some(why) = self.replace_blocker(in_file) {
            self.notice = Some(why);
            return;
        }
        let scope = match (in_file, self.sel) {
            (true, Some((g, _))) => Scope::File(self.groups[g].path.clone()),
            _ => Scope::All,
        };
        let plan = Plan::new(&self.groups, scope, self.replacement.value());
        if plan.matches == 0 {
            self.notice =
                Some("There is nothing to replace: no result has a marked match.".to_owned());
            return;
        }
        self.job = Job::Confirm(plan);
        self.job_top = 0;
    }

    fn confirm(&mut self) {
        if !matches!(self.job, Job::Confirm(_)) {
            self.notice = Some("There is nothing to confirm.".to_owned());
            return;
        }
        let Job::Confirm(plan) = std::mem::replace(&mut self.job, Job::Idle) else {
            return;
        };
        self.runs += 1;
        self.job = Job::Running(Box::new(Run::new(
            plan,
            &self.identity.workspace,
            self.identity.generation,
            self.runs,
        )));
        self.job_top = 0;
    }

    /// Stops after the file in hand, calls off the question, or puts a summary away.
    fn stop_job(&mut self) {
        match &mut self.job {
            Job::Running(run) => run.stop("Stopped by you; what was done stays done."),
            Job::Confirm(_) => self.job = Job::Idle,
            Job::Done(_) => self.job = Job::Idle,
            Job::Idle => self.notice = Some("No replace is running.".to_owned()),
        }
        self.settle_job();
    }

    fn dismiss(&mut self) {
        match self.job {
            Job::Confirm(_) | Job::Done(_) => {
                self.job = Job::Idle;
                self.job_top = 0;
            }
            Job::Running(_) => self.notice = Some("A replace is running; Esc stops it.".to_owned()),
            Job::Idle => self.notice = Some("There is no replace summary to dismiss.".to_owned()),
        }
    }

    /// A run that has nothing left to do becomes its summary.
    fn settle_job(&mut self) {
        if matches!(&self.job, Job::Running(run) if run.finished())
            && let Job::Running(run) = std::mem::replace(&mut self.job, Job::Idle)
        {
            self.job = Job::Done((*run).summary());
            self.job_top = 0;
        }
    }

    /// Sends what the run owes. Every message that may start work comes here.
    fn drive(&mut self, cx: &mut Ctx, tick: bool) {
        if let Job::Running(run) = &mut self.job {
            if tick {
                run.tick();
            }
            run.pump(cx);
        }
        self.settle_job();
    }

    fn on_job_key(&mut self, key: &KeyInput) {
        match key.key() {
            Key::Enter => {
                if matches!(self.job, Job::Confirm(_)) {
                    self.confirm();
                }
            }
            Key::Esc => self.stop_job(),
            _ => self.scroll_job(key),
        }
    }

    fn scroll_job(&mut self, key: &KeyInput) {
        let h = self.list_height().max(2) as isize;
        let delta = match key.key() {
            Key::Up => -1,
            Key::Down => 1,
            Key::PageUp => -(h - 1),
            Key::PageDown => h - 1,
            Key::Home => -1_000_000,
            Key::End => 1_000_000,
            _ => return,
        };
        let max = self.overlay().len().saturating_sub(1) as isize;
        self.job_top = (self.job_top as isize + delta).clamp(0, max) as usize;
    }

    /// The preview, the progress or the summary, as lines to wrap and draw.
    fn overlay(&self) -> Vec<(Tone, String)> {
        let mut out = vec![];
        match &self.job {
            Job::Idle => {}
            Job::Confirm(plan) => {
                let gutter = (self.max_line.max(100).ilog10() + 1) as usize;
                for file in &plan.files {
                    let n: usize = file.rows.iter().map(|r| r.matches.len()).sum();
                    out.push((
                        Tone::Bold,
                        format!(
                            "{} ({n} {})",
                            visible(&file.path),
                            replace::plural(n, "match", "matches")
                        ),
                    ));
                    for row in &file.rows {
                        let cut = if row.text_offset > 0 { "\u{2026}" } else { "" };
                        let before = preview_line(&row.text);
                        let after = preview_line(&replace::replaced(row, &plan.replacement));
                        out.push((
                            Tone::Before,
                            format!("{:>gutter$} - {cut}{before}", row.line),
                        ));
                        out.push((Tone::After, format!("{:>gutter$} + {cut}{after}", "")));
                    }
                }
            }
            Job::Running(run) => {
                for e in run.entries() {
                    out.push((Tone::of(&e.result), e.words()));
                }
                if let Some(g) = run.current() {
                    let (k, m) = run.position();
                    out.push((
                        Tone::Bold,
                        format!("Now, file {k} of {m}: {}", visible(&g.path)),
                    ));
                    let after = m.saturating_sub(k);
                    if after > 0 {
                        out.push((
                            Tone::Muted,
                            format!(
                                "{after} more {} waiting.",
                                replace::plural(after, "file", "files")
                            ),
                        ));
                    }
                }
            }
            Job::Done(sum) => {
                let section =
                    |out: &mut Vec<(Tone, String)>, title: &str, es: Vec<&replace::Entry>, tone| {
                        if es.is_empty() {
                            return;
                        }
                        out.push((Tone::Bold, format!("{title} {}:", es.len())));
                        for e in es {
                            out.push((tone, format!("  {}", e.words())));
                        }
                    };
                section(&mut out, "Changed", sum.changed(), Tone::Good);
                section(&mut out, "Skipped", sum.skipped(), Tone::Plain);
                section(&mut out, "Failed", sum.failed(), Tone::Problem);
                section(
                    &mut out,
                    "Unknown (may have changed; nothing was retried)",
                    sum.unknown(),
                    Tone::Problem,
                );
                if !sum.not_started.is_empty() {
                    out.push((
                        Tone::Bold,
                        format!("Not started {}:", sum.not_started.len()),
                    ));
                    for p in &sum.not_started {
                        out.push((Tone::Muted, format!("  {}", visible(p))));
                    }
                }
                if out.is_empty() {
                    out.push((Tone::Plain, "Nothing was changed.".to_owned()));
                }
            }
        }
        out
    }

    fn overlay_title(&self) -> &'static str {
        match self.job {
            Job::Idle => "",
            Job::Confirm(_) => "Replace preview",
            Job::Running(_) => "Replace progress",
            Job::Done(_) => "Replace summary",
        }
    }

    /// The status line while a replace is asked, running or summarised.
    fn job_status(&self) -> Option<(String, StatusTone)> {
        let locked =
            "Find and Replace are locked until it ends, so the matches stay as you confirmed.";
        Some(match &self.job {
            Job::Idle => return None,
            Job::Confirm(plan) => {
                let mut s = plan.question();
                if self.regex && plan.replacement.contains(['$', '\\']) {
                    s.push_str(" The replacement is inserted as typed: capture references such as $1 are not expanded.");
                }
                if plan.unmarked > 0 {
                    s.push_str(&format!(
                        " {} {} with no marked match {} left alone.",
                        plan.unmarked,
                        replace::plural(plan.unmarked, "row", "rows"),
                        replace::plural(plan.unmarked, "is", "are"),
                    ));
                }
                (s, StatusTone::Quiet)
            }
            Job::Running(run) => {
                let (k, m) = run.position();
                let mut s = if run.stopping {
                    format!("Stopping after file {k} of {m}; what was done stays done. {locked}")
                } else {
                    format!("Replacing, file {k} of {m}. Esc stops after this file. {locked}")
                };
                if let Some(n) = &run.notice {
                    s.push(' ');
                    s.push_str(n);
                }
                (s, StatusTone::Quiet)
            }
            Job::Done(sum) => (sum.headline(), StatusTone::Quiet),
        })
    }

    // ---- words --------------------------------------------------------------------------

    fn totals(&self) -> (usize, usize) {
        (self.match_count(), self.groups.len())
    }

    fn counted(&self) -> String {
        let (n, files) = self.totals();
        format!(
            "{n} {} in {files} {}",
            plural(n, "match", "matches"),
            plural(files, "file", "files")
        )
    }

    /// The status line, and whether it is an error.
    fn status_text(&self, caps_ok: bool) -> (String, StatusTone) {
        if !caps_ok {
            return (self.unavailable(), StatusTone::Problem);
        }
        if let Some(notice) = &self.notice {
            return (notice.clone(), StatusTone::Problem);
        }
        if let Some(words) = self.job_status() {
            return words;
        }
        let changed = self
            .shown
            .as_ref()
            .is_some_and(|shown| *shown != self.spec());
        let mut text = match &self.status {
            Status::Idle if self.query.is_empty() => {
                return (
                    "Type what to find, then press Enter.".to_owned(),
                    StatusTone::Quiet,
                );
            }
            Status::Idle => return ("Press Enter to search.".to_owned(), StatusTone::Quiet),
            Status::Starting(_) => {
                return ("Starting the search\u{2026}".to_owned(), StatusTone::Quiet);
            }
            Status::Reading(_) => {
                format!("Searching\u{2026} {} so far (partial).", self.counted())
            }
            Status::Complete if self.groups.is_empty() => {
                let query = self.shown.as_ref().map_or("", |s| s.query.as_str());
                format!("No matches for \"{query}\".")
            }
            Status::Complete => format!("{}.", self.counted()),
            Status::Cancelled => format!(
                "Cancelled. {} read before it stopped (partial).",
                self.counted()
            ),
            Status::Told(told) => {
                let word = match told.outcome {
                    SearchEndOutcome::Refused => "Refused",
                    SearchEndOutcome::Failed => "Failed",
                    SearchEndOutcome::Uncertain => "Unknown",
                };
                let code = told
                    .code
                    .as_ref()
                    .map(|c| format!(" ({c})"))
                    .unwrap_or_default();
                let tail = if self.groups.is_empty() {
                    String::new()
                } else {
                    format!(" {} read before it ended (partial).", self.counted())
                };
                return (
                    format!("{word}{code}: {} Not retried.{tail}", told.reason),
                    StatusTone::Problem,
                );
            }
        };
        if self.skipped > 0 {
            text.push_str(&format!(" {} non-text rows skipped.", self.skipped));
        }
        if self.truncated {
            text.push_str(&format!(
                " Only the first {MAX_ROWS} rows are kept (partial)."
            ));
        }
        if changed {
            text.push_str(" These are for the earlier query; press Enter to search again.");
        }
        (text, StatusTone::Quiet)
    }

    fn actions_listed(&self, caps_ok: bool) -> Vec<NodeAction> {
        let run = if !caps_ok {
            Some(self.unavailable())
        } else if self.query.is_empty() {
            Some("Type what to find first.".to_owned())
        } else if !self.identity.is_set() {
            Some("No workspace is open yet.".to_owned())
        } else {
            None
        };
        let cancel = (!self.running()).then(|| "No search is running.".to_owned());
        let open = self
            .sel
            .is_none()
            .then(|| "No result is selected.".to_owned());
        let moves = self
            .flat
            .is_empty()
            .then(|| "There are no results.".to_owned());
        let item = |id: &str, reason: Option<String>| NodeAction {
            id: ActionId::new(id),
            enabled: reason.is_none(),
            reason,
        };
        let mut all = vec![
            item(actions::RUN, run),
            item(actions::CANCEL, cancel),
            item(actions::TOGGLE_REGEX, None),
            item(actions::TOGGLE_CASE, None),
            item(actions::TOGGLE_WORD, None),
            item(actions::NEXT_FIELD, None),
            item(actions::CURSOR_UP, moves.clone()),
            item(actions::CURSOR_DOWN, moves),
            item(actions::OPEN_RESULT, open),
            item(
                actions::CLEAR,
                (self.flat.is_empty() && !self.running())
                    .then(|| "There is nothing to clear.".to_owned()),
            ),
            item(actions::REPLACE_ALL, self.replace_blocker(false)),
            item(actions::REPLACE_IN_FILE, self.replace_blocker(true)),
        ];
        all.extend(self.job_actions());
        all
    }

    /// The actions that answer a question, stop a run or put a summary away.
    fn job_actions(&self) -> Vec<NodeAction> {
        let item = |id: &str, reason: Option<&str>| NodeAction {
            id: ActionId::new(id),
            enabled: reason.is_none(),
            reason: reason.map(str::to_owned),
        };
        vec![
            item(
                actions::REPLACE_CONFIRM,
                (!matches!(self.job, Job::Confirm(_))).then_some("There is nothing to confirm."),
            ),
            item(
                actions::REPLACE_STOP,
                matches!(self.job, Job::Idle | Job::Done(_))
                    .then_some("No replace is running or waiting."),
            ),
            item(
                actions::REPLACE_DISMISS,
                matches!(self.job, Job::Idle | Job::Running(_))
                    .then_some("There is no summary to dismiss."),
            ),
        ]
    }

    fn draw(&self, area: Rect, buf: &mut Buffer, focused: bool, caps_ok: bool, s: &Styles) {
        let lay = self.lay(area, caps_ok);
        buf.set_style(area, s.text);
        let locked = self.job.modal();
        let rows = [
            ("Find", Focus::Query, lay.query),
            ("Replace", Focus::Replace, lay.replace),
            ("Include", Focus::Include, lay.include),
            ("Exclude", Focus::Exclude, lay.exclude),
        ];
        for (i, (name, focus, rect)) in rows.iter().enumerate() {
            if (i as u16) < area.height {
                text::put(
                    buf,
                    area.x,
                    area.y + i as u16,
                    (LABEL as usize).saturating_sub(1),
                    name,
                    s.muted,
                );
            }
            let field = match focus {
                Focus::Query => &self.query,
                Focus::Replace => &self.replacement,
                Focus::Include => &self.include,
                _ => &self.exclude,
            };
            let placeholder = match focus {
                Focus::Query => "",
                Focus::Replace => "replacement, inserted as typed",
                Focus::Include => "all files, e.g. src/**/*.rs",
                _ => "none, e.g. **/target/**",
            };
            // Find and Replace do not take keys while a replace is asked or running.
            let held = locked && matches!(focus, Focus::Query | Focus::Replace);
            field.draw(
                buf,
                *rect,
                Look {
                    text: if held { s.muted } else { s.text },
                    caret: s.cursor,
                    hint: s.muted,
                },
                focused && self.focus == *focus && !locked,
                placeholder,
            );
        }
        for (i, rect) in lay.chips.iter().enumerate() {
            let on = [self.regex, self.case_sensitive, self.whole_word][i];
            text::put(
                buf,
                rect.x,
                rect.y,
                rect.width as usize,
                CHIPS[i].0,
                if on { s.on } else { s.muted },
            );
        }
        for (i, rect) in lay.replace_chips.iter().enumerate() {
            text::put(
                buf,
                rect.x,
                rect.y,
                rect.width as usize,
                REPLACE_CHIPS[i].0,
                if self.replace_blocker(i == 1).is_none() {
                    s.on
                } else {
                    s.muted
                },
            );
        }
        // The status line and the one control that starts or stops.
        let (words, tone) = self.status_text(caps_ok);
        let style = match tone {
            StatusTone::Problem => s.error,
            StatusTone::Quiet => s.muted,
        };
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
                style,
            );
        }
        if lay.chip.width > 0 {
            let name = if self.running() {
                "[Cancel]"
            } else {
                "[Search]"
            };
            text::put(
                buf,
                lay.chip.x,
                lay.chip.y,
                lay.chip.width as usize,
                name,
                if self.running() || !self.query.is_empty() {
                    s.on
                } else {
                    s.muted
                },
            );
        }
        if matches!(self.job, Job::Idle) {
            self.draw_list(lay.list, buf, focused, s);
        } else {
            self.draw_overlay(lay.list, buf, s);
        }
    }

    /// The preview, the progress or the summary: whole lines, wrapped, never clipped.
    fn draw_overlay(&self, list: Rect, buf: &mut Buffer, s: &Styles) {
        let width = list.width as usize;
        if width == 0 || list.height == 0 {
            return;
        }
        let mut y = 0u16;
        for (tone, line) in self.overlay().iter().skip(self.job_top) {
            let opts = textwrap::Options::new(width).subsequent_indent(WRAP_INDENT);
            for row in textwrap::wrap(line, opts) {
                if y >= list.height {
                    return;
                }
                text::put(buf, list.x, list.y + y, width, &row, tone.style(s));
                y += 1;
            }
        }
    }

    fn draw_list(&self, list: Rect, buf: &mut Buffer, focused: bool, s: &Styles) {
        if list.height == 0 || list.width == 0 {
            return;
        }
        let gutter = (self.max_line.max(100).ilog10() + 1) as usize;
        let prefix = 2 + gutter + 2;
        let selected = self.sel_index();
        for y in 0..list.height {
            let index = self.top + y as usize;
            let Some(item) = self.flat.get(index) else {
                break;
            };
            let row_rect = Rect::new(list.x, list.y + y, list.width, 1);
            match *item {
                Item::Header(g) => {
                    let group = &self.groups[g];
                    let count = format!(" ({})", group.rows.len());
                    let room = (list.width as usize).saturating_sub(text::width(&count));
                    let path = text::elide_middle(&group.path, room);
                    let used =
                        text::put(buf, list.x, list.y + y, list.width as usize, &path, s.bold);
                    text::put(
                        buf,
                        list.x + used,
                        list.y + y,
                        (list.width - used) as usize,
                        &count,
                        s.muted,
                    );
                }
                Item::Row(g, r) => {
                    let row = &self.groups[g].rows[r];
                    let is_sel = selected == Some(index);
                    let base = if !is_sel {
                        s.text
                    } else if focused && self.focus == Focus::Results {
                        s.cursor
                    } else {
                        s.cursor_idle
                    };
                    if is_sel {
                        buf.set_style(row_rect, base);
                    }
                    let number = format!("  {:>gutter$}  ", row.line);
                    let gutter_style: Style = if is_sel { base } else { s.muted };
                    text::put(
                        buf,
                        list.x,
                        list.y + y,
                        list.width as usize,
                        &number,
                        gutter_style,
                    );
                    let avail = (list.width as usize).saturating_sub(prefix);
                    let cells = text::cells(&row.text, &row.matches);
                    // Slide the line so the first match is on screen, with a mark for the cut.
                    let first = text::first_hit(&cells).unwrap_or(0);
                    let from = if first + 1 > avail {
                        first.saturating_sub(avail / 3)
                    } else {
                        0
                    };
                    let x = list.x + prefix as u16;
                    if avail > 0 {
                        if from > 0 {
                            text::put(buf, x, list.y + y, 1, "\u{2026}", gutter_style);
                            let line = text::line(&cells, from + 1, avail - 1, base, s.hit);
                            buf.set_line(x + 1, list.y + y, &line, (avail - 1) as u16);
                        } else {
                            let line = text::line(&cells, 0, avail, base, s.hit);
                            buf.set_line(x, list.y + y, &line, avail as u16);
                        }
                    }
                }
            }
        }
    }

    fn nodes(&self, area: Rect, caps_ok: bool, focused: bool) -> Vec<Node> {
        let lay = self.lay(area, caps_ok);
        let mut root = Node::new("search", Role::Region, "Search", area);
        let (words, tone) = self.status_text(caps_ok);
        root.state.description = Some(words.clone());
        root.state.busy = self.running();
        root.state.focused = focused;
        root.actions = self.actions_listed(caps_ok);
        let mut out = vec![];
        let child = |root: &mut Node, node: Node, out: &mut Vec<Node>| {
            root.children.push(node.id.clone());
            out.push(node);
        };
        for (id, name, focus, rect, field) in [
            (
                "query",
                "Search query",
                Focus::Query,
                lay.query,
                &self.query,
            ),
            (
                "replacement",
                "Replacement text",
                Focus::Replace,
                lay.replace,
                &self.replacement,
            ),
            (
                "include",
                "Files to include",
                Focus::Include,
                lay.include,
                &self.include,
            ),
            (
                "exclude",
                "Files to exclude",
                Focus::Exclude,
                lay.exclude,
                &self.exclude,
            ),
        ] {
            let mut node = Node::new(id, Role::TextBox, name, rect).with_text(field.value());
            node.state.focused = focused && self.focus == focus;
            if self.job.modal() && matches!(focus, Focus::Query | Focus::Replace) {
                node.state.disabled = true;
                node.state.description = Some(
                    "Locked while a replace is asked or running, so the matches stay as confirmed."
                        .to_owned(),
                );
            }
            child(&mut root, node, &mut out);
        }
        for (i, (id, action)) in [
            ("regex", actions::TOGGLE_REGEX),
            ("case", actions::TOGGLE_CASE),
            ("word", actions::TOGGLE_WORD),
        ]
        .into_iter()
        .enumerate()
        {
            let mut node = Node::new(id, Role::Button, CHIPS[i].1, lay.chips[i]);
            node.state.selected = [self.regex, self.case_sensitive, self.whole_word][i];
            node.actions = vec![NodeAction {
                id: ActionId::new(action),
                enabled: true,
                reason: None,
            }];
            child(&mut root, node, &mut out);
        }
        for (i, (id, action)) in [
            ("replace-all", actions::REPLACE_ALL),
            ("replace-file", actions::REPLACE_IN_FILE),
        ]
        .into_iter()
        .enumerate()
        {
            let reason = self.replace_blocker(i == 1);
            let mut node = Node::new(id, Role::Button, REPLACE_CHIPS[i].1, lay.replace_chips[i]);
            node.state.disabled = reason.is_some();
            node.actions = vec![NodeAction {
                id: ActionId::new(action),
                enabled: reason.is_none(),
                reason,
            }];
            child(&mut root, node, &mut out);
        }
        let mut status = Node::new("status", Role::Status, &words, lay.status);
        status.state.busy = self.running();
        if tone == StatusTone::Problem {
            status.role = Role::Alert;
        }
        child(&mut root, status, &mut out);

        if !matches!(self.job, Job::Idle) {
            let lines = self.overlay();
            let mut node = Node::new("replace-lines", Role::List, self.overlay_title(), lay.list);
            node.state.description = Some(words.clone());
            node.state.busy = matches!(self.job, Job::Running(_));
            node.actions = self.job_actions();
            let size = lines.len().min(u16::MAX as usize) as u16;
            let mut all = vec![];
            for (i, (_, line)) in lines
                .iter()
                .enumerate()
                .skip(self.job_top)
                .take(lay.list.height as usize)
            {
                let rect = Rect::new(
                    lay.list.x,
                    lay.list.y + (i - self.job_top) as u16,
                    lay.list.width,
                    1,
                );
                let mut item = Node::new(&format!("replace-line:{i}"), Role::ListItem, line, rect);
                item.pos_in_set = Some((i + 1).min(size as usize) as u16);
                item.set_size = Some(size);
                node.children.push(item.id.clone());
                all.push(item);
            }
            root.children.push(node.id.clone());
            let mut every = vec![root];
            every.extend(out);
            every.push(node);
            every.extend(all);
            return every;
        }
        let mut results = Node::new("results", Role::Tree, "Search results", lay.list);
        results.state.description = Some(self.counted());
        results.state.focused = focused && self.focus == Focus::Results;
        let height = lay.list.height as usize;
        let size = self.flat.len().min(u16::MAX as usize) as u16;
        let selected = self.sel_index();
        for (offset, item) in self.flat.iter().enumerate().skip(self.top).take(height) {
            let y = lay.list.y + (offset - self.top) as u16;
            let rect = Rect::new(lay.list.x, y, lay.list.width, 1);
            let (name, level) = match *item {
                Item::Header(g) => (self.groups[g].path.clone(), 1),
                Item::Row(g, r) => {
                    let row = &self.groups[g].rows[r];
                    (
                        format!("{}:{} {}", self.groups[g].path, row.line, row.text),
                        2,
                    )
                }
            };
            let mut node = Node::new(&format!("result:{offset}"), Role::TreeItem, &name, rect);
            node.level = Some(level);
            node.pos_in_set = Some((offset + 1).min(size as usize) as u16);
            node.set_size = Some(size);
            node.state.selected = selected == Some(offset);
            if matches!(item, Item::Row(..)) {
                node.actions = vec![NodeAction {
                    id: ActionId::new(actions::OPEN_RESULT),
                    enabled: true,
                    reason: None,
                }];
            }
            results.children.push(node.id.clone());
            out.push(node);
        }
        root.children.push(results.id.clone());
        let mut all = vec![root];
        all.extend(out);
        all.push(results);
        all
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusTone {
    Quiet,
    Problem,
}

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// How a line looks in the preview: tabs are four spaces, controls are spelled out, and a
/// very long line is cut and says so.
fn preview_line(line: &str) -> String {
    let kept: String = line
        .replace('\t', "    ")
        .chars()
        .take(PREVIEW_CHARS)
        .collect();
    let lost = line.chars().count().saturating_sub(PREVIEW_CHARS);
    let mut out = visible(&kept);
    if lost > 0 {
        out.push_str(&format!(" [{lost} more characters not shown]"));
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tone {
    Plain,
    Bold,
    Muted,
    Before,
    After,
    Good,
    Problem,
}

impl Tone {
    fn of(result: &replace::Done) -> Self {
        match result {
            replace::Done::Changed(_) => Tone::Good,
            replace::Done::Skipped(_) => Tone::Plain,
            _ => Tone::Problem,
        }
    }

    fn style(self, s: &Styles) -> Style {
        match self {
            Tone::Plain => s.text,
            Tone::Bold => s.bold,
            Tone::Muted => s.muted,
            Tone::Before => s.error,
            Tone::After | Tone::Good => s.success,
            Tone::Problem => s.error,
        }
    }
}

/// Alt+Enter asks to replace in the selected result's file.
fn replace_in_file_chord(key: &KeyInput) -> bool {
    key.key() == Key::Enter && key.mods().contains(Mods::ALT)
}

/// The globs of a field: comma separated, each trimmed, none empty.
fn globs(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Alt+R, Alt+C and Alt+W flip regex, case and whole word, in any field and
/// state: the index of the toggle, for `on_key` to flip and `takes_chord` to ask.
fn toggle_chord(key: &KeyInput) -> Option<usize> {
    match key.key() {
        Key::Char(c) if key.mods().contains(Mods::ALT) => ['r', 'c', 'w']
            .iter()
            .position(|&t| t == c.to_ascii_lowercase()),
        _ => None,
    }
}

impl Panel for SearchPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.adopt(cx.workspace());
        self.caps_ok = cx.capabilities().has(&Capability::new(CAPABILITY));
        self.docs_ok = cx.capabilities().has(&Capability::new("documents"));
        let tick = matches!(msg, PanelMsg::Tick);
        let quiet = matches!(
            msg,
            PanelMsg::Resize { .. }
                | PanelMsg::Focus(_)
                | PanelMsg::Cached(_)
                | PanelMsg::Workspace(_)
        );
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Text(text) | PanelMsg::Paste(text) => {
                if let Some(field) = self.field_mut() {
                    field.insert(&text);
                }
            }
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.area = Rect::new(0, 0, area.width, area.height);
                self.clamp_top();
            }
            PanelMsg::Completion(completion) => self.on_completion(completion),
            PanelMsg::Host(HostMessage::SearchPage {
                id,
                rows,
                skipped,
                state,
                end,
                encoding,
                ..
            }) => self.on_page(&id, rows, skipped, state, end, encoding),
            PanelMsg::Action(id) => self.on_action(&id, cx),
            // Other host events are for other panels; a message added to the core later is
            // not this panel's until it is read here.
            _ => {}
        }
        if !quiet {
            self.flush(cx);
            self.drive(cx, tick);
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
        let resource = self.resource();
        if let Some(root) = nodes.first_mut() {
            root.binding = resource;
        }
        nodes
    }

    fn serialize(&self) -> Value {
        let spec = self.spec();
        serde_json::to_value(ViewState {
            query: spec.query,
            replacement: self.replacement.value().to_owned(),
            regex: spec.regex,
            case_sensitive: spec.case_sensitive,
            whole_word: spec.whole_word,
            include: spec.include,
            exclude: spec.exclude,
            scroll: self.top,
        })
        .unwrap_or(Value::Null)
    }

    fn tab_label(&self) -> Option<TabLabel> {
        let title = match (&self.status, self.groups.is_empty()) {
            (Status::Starting(_) | Status::Reading(_), _) => "Search \u{2026}".to_owned(),
            (_, true) => return None,
            _ => format!("Search ({})", self.match_count()),
        };
        Some(TabLabel {
            title,
            modified: false,
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: None,
            generation: Some(Generation(self.identity.generation.0)),
        })
    }

    fn text_entry(&self) -> bool {
        self.focus != Focus::Results && !self.job.modal()
    }

    /// Escape also calls off a question, stops a run and puts a summary away.
    fn holds_escape(&self) -> bool {
        self.text_entry() || !matches!(self.job, Job::Idle)
    }

    fn takes_chord(&self, key: &KeyInput) -> bool {
        toggle_chord(key).is_some() || replace_in_file_chord(key)
    }
}

impl SearchPanel {
    fn resource(&self) -> ResourceRef {
        ResourceRef::Workspace {
            workspace: self.identity.workspace.clone(),
        }
    }
}

pub(crate) fn kind() -> PanelKind {
    PanelKind::new(KIND)
}

/// The registry entries of the panel. Reading and moving are local; a query is a `Start` and
/// a cancel is a `Destroy`, the intent the core gives stopping what is running.
pub(crate) fn descriptors() -> Vec<ActionDescriptor> {
    let local = |id: &str, title: &str| ActionDescriptor::local(id, title).requires(CAPABILITY);
    vec![
        ActionDescriptor::new(actions::RUN, "Search", ActionIntent::Start)
            .requires(CAPABILITY)
            .emits(EffectKind::SearchQuery),
        ActionDescriptor::new(actions::CANCEL, "Cancel the search", ActionIntent::Destroy)
            .requires(CAPABILITY)
            .emits(EffectKind::SearchCancel),
        local(actions::TOGGLE_REGEX, "Turn regular expressions on or off"),
        local(actions::TOGGLE_CASE, "Turn case matching on or off"),
        local(actions::TOGGLE_WORD, "Turn whole-word matching on or off"),
        local(actions::NEXT_FIELD, "Move to the next field or the results"),
        local(actions::CURSOR_UP, "Select the previous result"),
        local(actions::CURSOR_DOWN, "Select the next result"),
        local(
            actions::OPEN_RESULT,
            "Open the selected result in the editor",
        ),
        local(actions::CLEAR, "Clear the results"),
        // The two that ask only show the question and the preview; the person's answer is the
        // one that sends. All three are the person's: an agent's request is refused.
        local(
            actions::REPLACE_ALL,
            "Replace every match of the search (asks first)",
        )
        .requires(DOCUMENTS)
        .human_only(),
        local(
            actions::REPLACE_IN_FILE,
            "Replace the matches in the selected file (asks first)",
        )
        .requires(DOCUMENTS)
        .human_only(),
        ActionDescriptor::new(
            actions::REPLACE_CONFIRM,
            "Confirm the replace",
            ActionIntent::Start,
        )
        .requires(CAPABILITY)
        .requires(DOCUMENTS)
        .emits(EffectKind::DocumentOpen)
        .emits(EffectKind::DocumentEdit)
        .emits(EffectKind::DocumentSave)
        .emits(EffectKind::DocumentClose)
        .emits(EffectKind::DocumentSettle)
        .human_only(),
        local(
            actions::REPLACE_STOP,
            "Stop the replace after the file in hand",
        ),
        local(actions::REPLACE_DISMISS, "Put the replace summary away"),
    ]
}
