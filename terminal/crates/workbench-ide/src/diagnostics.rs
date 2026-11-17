//! The Diagnostics panel: the findings of the documents open in the workbench, grouped by
//! file, with the counts by severity and a filter.
//!
//! The core feeds it: `DiagnosticsSet` carries every finding of one open document at one
//! revision, already placed by line and column, and `DiagnosticsCleared` says the document
//! closed. The core keeps the latest set per path, drops an older revision and replays to a
//! panel that mounts late, so this panel holds no read loop of its own. What it shows is what
//! the backend reports per open document; nothing scans the workspace, and the status says so.

use std::collections::BTreeMap;

use keybinds::{Key, KeyInput};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{
    ActionId, Capability, Generation, PanelKind, ResourceRef, Revision, WorkspaceIdentity,
};
use theorem_workbench_core::registry::ActionDescriptor;
use theorem_workbench_core::results::{FindingAt, Severity};
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
}

/// Registers the panel under the builtin kind `"diagnostics"`.
pub fn register(factories: &mut PanelFactories) {
    factories.register(KIND, |state, _version| {
        Box::new(DiagnosticsPanel::restore(state))
    });
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Finding {
    severity: Severity,
    message: String,
    source: Option<String>,
    code: Option<String>,
    /// From 0, as the feed places it.
    line: u32,
    character: u32,
}

impl Finding {
    fn key(&self) -> (u32, u32, String) {
        (self.line, self.character, self.message.clone())
    }
}

#[derive(Clone, Debug, Default)]
struct FileSet {
    /// The revision the findings are against, as the owner names it.
    revision: Option<String>,
    findings: Vec<Finding>,
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
    sel: Option<(String, (u32, u32, String))>,
    top: usize,
    identity: WorkspaceIdentity,
    caps_ok: bool,
    area: Rect,
}

impl DiagnosticsPanel {
    /// Only the filter and scroll are saved: the findings come back from the feed, which the
    /// core replays to a panel that mounts.
    pub fn restore(state: &Value) -> Self {
        let saved: ViewState = serde_json::from_value(state.clone()).unwrap_or_default();
        let filter = saved
            .filter
            .as_deref()
            .and_then(|f| ORDER.iter().copied().find(|s| word(*s) == f));
        Self {
            files: BTreeMap::new(),
            filter,
            flat: vec![],
            sel: None,
            top: saved.scroll,
            identity: WorkspaceIdentity::default(),
            caps_ok: true,
            area: Rect::default(),
        }
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
        if self.sel_index().is_none() {
            self.sel = self.flat.iter().find_map(|i| match *i {
                Item::Finding(g, f) => self.key_of(g, f),
                Item::Header(_) => None,
            });
        }
        self.clamp_top();
    }

    fn key_of(&self, g: usize, f: usize) -> Option<(String, (u32, u32, String))> {
        let (path, file) = self.files.iter().nth(g)?;
        Some((path.clone(), file.findings.get(f)?.key()))
    }

    fn sel_index(&self) -> Option<usize> {
        let (path, key) = self.sel.as_ref()?;
        self.flat.iter().position(|item| match *item {
            Item::Finding(g, f) => self.files.iter().nth(g).is_some_and(|(p, file)| {
                p == path && file.findings.get(f).is_some_and(|x| &x.key() == key)
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
            // Another workspace's findings are not this one's.
            self.files.clear();
            self.flat.clear();
            self.sel = None;
        }
        self.identity = identity.clone();
    }

    /// Takes the latest set of one document. The core has already dropped an older revision.
    fn take(&mut self, path: String, revision: Revision, findings: Vec<FindingAt>) {
        let mut findings: Vec<Finding> = findings
            .into_iter()
            .map(|f| Finding {
                severity: f.severity,
                message: f.message,
                source: f.source,
                code: f.code,
                line: f.range.start.line,
                character: f.range.start.character,
            })
            .collect();
        findings.sort_by_key(Finding::key);
        let revision = Some(match revision {
            Revision::Seq(n) => n.to_string(),
            Revision::Opaque(s) => s,
        });
        self.files.insert(path, FileSet { revision, findings });
        self.rebuild();
    }

    fn on_host(&mut self, message: HostMessage) {
        match message {
            HostMessage::DiagnosticsSet {
                path,
                revision,
                findings,
                ..
            } => self.take(path, revision, findings),
            HostMessage::DiagnosticsCleared { path } => {
                self.files.remove(&path);
                self.rebuild();
            }
            _ => {}
        }
    }

    // ---- what the person does -------------------------------------------------------------

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
        let Some((path, key)) = self.sel.clone() else {
            return;
        };
        self.open_at(path, Some((key.0, key.1)), cx);
    }

    /// The feed counts the column in the unit it states, and `FileAt` counts UTF-16 code
    /// units from 1; the two agree for every line the backend reports in UTF-16 and for
    /// any line whose text before the finding is ASCII.
    fn open_at(&mut self, path: String, place: Option<(u32, u32)>, cx: &mut Ctx) {
        let workspace = self.identity.workspace.clone();
        match place {
            Some((line, character)) => cx.open(OpenTarget::FileAt {
                workspace,
                path,
                line: line + 1,
                column: character + 1,
            }),
            None => cx.open(OpenTarget::File { workspace, path }),
        }
    }

    fn on_action(&mut self, id: &ActionId, cx: &mut Ctx) {
        match id.as_str() {
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
            "The host cannot report findings: it does not report the \"{CAPABILITY}\" capability. None are shown because none can be read, not because there are none."
        )
    }

    fn status(&self, caps_ok: bool) -> (String, bool) {
        if !caps_ok {
            return (self.unavailable(), true);
        }
        if self.files.is_empty() {
            return (NO_DOCUMENTS.to_owned(), false);
        }
        let n = self.total();
        let files = self.files.len();
        let open = if files == 1 {
            "1 open document".to_owned()
        } else {
            format!("{files} open documents")
        };
        let text = if n == 0 {
            format!("No findings in {open}. {SCOPE}")
        } else {
            format!(
                "{n} {} in {open}. {SCOPE}",
                if n == 1 { "finding" } else { "findings" },
            )
        };
        (text, false)
    }

    fn actions_listed(&self) -> Vec<NodeAction> {
        let moves = (!self.flat.iter().any(|i| matches!(i, Item::Finding(..))))
            .then(|| "There are no findings to select.".to_owned());
        let item = |id: &str, reason: Option<String>| NodeAction {
            id: ActionId::new(id),
            enabled: reason.is_none(),
            reason,
            title: None,
        };
        vec![
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
                    let place = format!("{}:{}", finding.line + 1, finding.character + 1);
                    let head = format!("  {:<7} {:>8}  ", word(finding.severity), place);
                    let sev_style = if is_sel {
                        base
                    } else {
                        Self::severity_style(s, finding.severity)
                    };
                    let used = text::put(buf, row.x, row.y, row.width as usize, &head, sev_style);
                    let first = finding.message.lines().next().unwrap_or("");
                    let mut message = first.to_owned();
                    match (&finding.source, &finding.code) {
                        (Some(source), Some(code)) => {
                            message.push_str(&format!("  [{source} {code}]"));
                        }
                        (Some(tag), None) | (None, Some(tag)) => {
                            message.push_str(&format!("  [{tag}]"));
                        }
                        (None, None) => {}
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
        if let Some(rev) = &file.revision {
            tail.push_str(&format!(" r{rev}"));
        }
        if file.findings.is_empty() {
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
            s.muted,
        );
    }

    fn nodes(&self, area: Rect, caps_ok: bool, focused: bool) -> Vec<Node> {
        let lay = self.lay(area, caps_ok);
        let mut root = Node::new("diagnostics", Role::Region, "Diagnostics", area);
        let (words, problem) = self.status(caps_ok);
        root.state.description = Some(words.clone());
        root.state.focused = focused;
        root.actions = self.actions_listed();
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
                title: None,
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
                    (format!("{path}: {} findings", file.findings.len()), 1)
                }
                Item::Finding(g, f) => {
                    let (path, file) = self.files.iter().nth(g).expect("a finding names a file");
                    let finding = &file.findings[f];
                    let place =
                        format!("line {} column {}", finding.line + 1, finding.character + 1);
                    let source = finding
                        .source
                        .as_ref()
                        .map(|s| format!(" from {s}"))
                        .unwrap_or_default();
                    let code = finding
                        .code
                        .as_ref()
                        .map(|c| format!(" code {c}"))
                        .unwrap_or_default();
                    (
                        format!(
                            "{} in {path} at {place}: {}{source}{code}",
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
                    title: None,
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

const NO_DOCUMENTS: &str = "No documents are open in the workbench. Findings cover open documents only: the backend reports diagnostics per open document and does not scan the workspace.";
const SCOPE: &str = "Open documents only; the workspace is not scanned.";

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

impl Panel for DiagnosticsPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        self.adopt(cx.workspace());
        self.caps_ok = cx.capabilities().has(&Capability::new(CAPABILITY));
        match msg {
            PanelMsg::Key(key) => self.on_key(key, cx),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Resize { area, .. } => {
                self.area = Rect::new(0, 0, area.width, area.height);
                self.clamp_top();
            }
            PanelMsg::Host(message) => self.on_host(message),
            PanelMsg::Action(id) => self.on_action(&id, cx),
            _ => {}
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
        })
        .unwrap_or(Value::Null)
    }

    /// The panel reads the feed of open documents' findings.
    fn wants_diagnostics(&self) -> bool {
        true
    }

    fn tab_label(&self) -> Option<TabLabel> {
        let n = self.total();
        (n > 0).then(|| TabLabel {
            title: format!("Diagnostics ({n})"),
            modified: false,
        })
    }

    /// The workspace: the panel shows findings of many documents and is bound to none, so
    /// opening one of them reaches the editor.
    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: ResourceRef::Workspace {
                workspace: self.identity.workspace.clone(),
            },
            revision: None,
            generation: Some(Generation(self.identity.generation.0)),
        })
    }
}

pub(crate) fn kind() -> PanelKind {
    PanelKind::new(KIND)
}

/// The registry entries. Everything is local: the feed needs no request.
pub(crate) fn descriptors() -> Vec<ActionDescriptor> {
    let local = |id: &str, title: &str| ActionDescriptor::local(id, title).requires(CAPABILITY);
    vec![
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
