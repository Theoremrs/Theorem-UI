//! The Review view: every changed file as one scroll of diffs beside a tree of the files.
//!
//! Written for this crate; not translated. The arrangement (a continuous diff under
//! sticky file headers, a compact tree with per-file counts and state letters) follows
//! the owner's reference of another tool (`docs/plans/theo-workbench/LEDGER.md`, L28);
//! nothing of it is copied.
//!
//! The view holds no I/O. It asks for the diffs near the viewport first and then, up to
//! `READ_AHEAD_FILES` changed files, for the rest (`Changes::review_wants`, sent by the
//! panel as the same `scmDiff` effect the Stage view uses), and counts lines only from
//! the diffs that have arrived, so a total is complete once every diff has. It compares the working tree with the last commit: the
//! host answers a staged diff and an unstaged diff per file and no diff of the working
//! tree against HEAD, so a file changed on both sides shows both, one under the other.
//!
//! What a tree row selects is also what the Stage view's chords act on: the file's rows
//! (or every row under a folder) become the model's selection, so stage, unstage, discard,
//! blame and the rest work from here without a second set of commands.

use std::collections::{BTreeMap, BTreeSet};

use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};

use crate::diff::{DiffLine, Hunk, LineKind};
use crate::intent::Intent;
use crate::layout::{Tone, regions};
use crate::model::{Changes, DiffState, DiffView, Mode};
use crate::status::{RowKey, is_folder, letter};

/// The panel width from which the diff sits beside the tree; narrower, the tree is above.
pub const WIDE: u16 = 100;

/// More lines than this in one diff are not drawn: the host reports no size limit of its
/// own, so the panel keeps one, and says so in one row.
pub const MAX_DIFF_LINES: usize = 5_000;

/// Diffs asked for and not yet answered at one time.
const IN_FLIGHT: usize = 3;

/// Up to this many changed files, every diff is read (the viewport's first), so the
/// totals are whole without scrolling. The host has no count of lines per file to ask
/// for instead; past this many files the totals stay open until each diff is reached.
const READ_AHEAD_FILES: usize = 200;

/// Which of the panel's two views is shown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum View {
    /// Every change as one diff beside a tree of files.
    #[default]
    Review,
    /// The groups, the commit box and the log.
    Stage,
}

impl View {
    pub fn label(self) -> &'static str {
        match self {
            Self::Review => "Review",
            Self::Stage => "Stage",
        }
    }
}

/// What the Review compares the working tree with. Only what the host's SCM port can
/// answer is listed: the port diffs the index against HEAD and the working tree against
/// the index, so the one base it can stand on is the last commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base {
    LastCommit,
}

impl Base {
    pub const ALL: &'static [Base] = &[Base::LastCommit];

    pub fn label(self) -> &'static str {
        match self {
            Self::LastCommit => "last commit",
        }
    }
}

/// A row of the tree, by what it stands for rather than where it is drawn.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TreeSel {
    /// A folder, by the path of the deepest folder of its (compacted) chain.
    Dir(String),
    File(String),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ReviewState {
    /// The diffs read for the Review, by row. The Stage view keeps its own.
    pub diffs: BTreeMap<RowKey, DiffView>,
    pub collapsed: BTreeSet<String>,
    pub cursor: Option<TreeSel>,
    pub tree_scroll: usize,
    /// The first row of the diff column the viewport shows.
    pub scroll: usize,
    /// The stacked tree is folded to its header line.
    pub tree_hidden: bool,
    pub base: usize,
}

/// Lines added and removed, from the diffs that have arrived.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Counts {
    pub add: usize,
    pub del: usize,
    /// Every diff behind the numbers has arrived.
    pub complete: bool,
    pub binary: bool,
}

impl Counts {
    fn zero() -> Self {
        Self {
            complete: true,
            ..Self::default()
        }
    }

    fn plus(&mut self, other: Counts) {
        self.add += other.add;
        self.del += other.del;
        self.complete &= other.complete;
    }
}

/// A changed file, whichever sections it is in.
#[derive(Clone, Debug)]
pub(crate) struct FileEntry {
    pub path: String,
    pub letter: char,
    pub keys: Vec<RowKey>,
    pub original: Option<String>,
    pub folder: bool,
    pub counts: Counts,
}

#[derive(Clone, Debug)]
pub(crate) enum TreeKind {
    Dir { path: String, open: bool },
    File { file: usize },
}

#[derive(Clone, Debug)]
pub(crate) struct TreeRow {
    pub depth: u16,
    /// A folder chain with one child each reads as one name: `a/b/c`.
    pub label: String,
    pub kind: TreeKind,
    pub counts: Counts,
}

/// The files in tree order and the rows the tree shows.
#[derive(Clone, Debug, Default)]
pub(crate) struct Tree {
    pub rows: Vec<TreeRow>,
    pub files: Vec<FileEntry>,
    pub totals: Counts,
}

impl Tree {
    pub fn sel_of(&self, row: &TreeRow) -> TreeSel {
        match &row.kind {
            TreeKind::Dir { path, .. } => TreeSel::Dir(path.clone()),
            TreeKind::File { file } => TreeSel::File(self.files[*file].path.clone()),
        }
    }

    pub fn index_of(&self, sel: &TreeSel) -> Option<usize> {
        self.rows.iter().position(|row| &self.sel_of(row) == sel)
    }

    pub fn file_index(&self, path: &str) -> Option<usize> {
        self.files.iter().position(|f| f.path == path)
    }

    /// The files under a folder (all of them, whether the tree shows them or not).
    pub fn under<'a>(&'a self, dir: &str) -> impl Iterator<Item = &'a FileEntry> {
        let prefix = format!("{dir}/");
        self.files
            .iter()
            .filter(move |f| f.path.starts_with(&prefix))
    }
}

#[derive(Default)]
struct Node {
    dirs: BTreeMap<String, Node>,
    files: BTreeMap<String, usize>,
}

/// Where the parts of the Review sit in the list region.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Geometry {
    pub header: Rect,
    /// The stacked tree's heading line; empty when the tree is beside the diff.
    pub tree_head: Rect,
    pub tree: Rect,
    pub diff: Rect,
    /// The rule between the diff and the tree when they sit side by side.
    pub rule: Rect,
    pub wide: bool,
}

pub(crate) fn geometry(list: Rect, tree_rows: usize, hidden: bool) -> Geometry {
    let header = Rect::new(list.x, list.y, list.width, list.height.min(1));
    let body = Rect::new(
        list.x,
        list.y + header.height,
        list.width,
        list.height - header.height,
    );
    let none = Rect::new(body.x, body.y, 0, 0);
    if list.width >= WIDE {
        let tree_w = (list.width / 4).clamp(26, 44);
        let diff_w = list.width.saturating_sub(tree_w + 1);
        return Geometry {
            header,
            tree_head: none,
            tree: Rect::new(body.x + diff_w + 1, body.y, tree_w, body.height),
            diff: Rect::new(body.x, body.y, diff_w, body.height),
            rule: Rect::new(body.x + diff_w, body.y, 1, body.height),
            wide: true,
        };
    }
    // At most a third of the panel, the heading line included.
    let limit = usize::from((list.height / 3).max(2));
    let head = Rect::new(body.x, body.y, body.width, body.height.min(1));
    let shown = if hidden { 0 } else { tree_rows.min(limit - 1) } as u16;
    let shown = shown.min(body.height.saturating_sub(head.height + 1));
    Geometry {
        header,
        tree_head: head,
        tree: Rect::new(body.x, body.y + head.height, body.width, shown),
        diff: Rect::new(
            body.x,
            body.y + head.height + shown,
            body.width,
            body.height.saturating_sub(head.height + shown),
        ),
        rule: none,
        wide: false,
    }
}

/// One file's place in the diff column.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Span {
    pub file: usize,
    pub start: usize,
    pub rows: usize,
}

/// What a row of the diff column holds.
#[derive(Debug)]
pub(crate) enum DiffRow<'a> {
    Header(usize),
    /// Which side of the index a file's lines compare, when it has two.
    Label(&'static str),
    Separator(Option<usize>),
    Line {
        line: &'a DiffLine,
        digits: usize,
    },
    Note(String, Tone),
}

/// The tree, the geometry and the diff column of the Review at one size.
pub(crate) struct Laid {
    pub tree: Tree,
    pub geom: Geometry,
    pub spans: Vec<Span>,
    pub total: usize,
}

impl Laid {
    /// The last row the diff can start at: the end of the column, but never short of the
    /// last file's header, so every file can be brought to the top.
    pub fn max_scroll(&self) -> usize {
        let page = usize::from(self.geom.diff.height).saturating_sub(1);
        let last = self.spans.last().map_or(0, |s| s.start);
        self.total.saturating_sub(page).max(last)
    }

    /// The file the top of the viewport is in.
    pub fn current(&self, scroll: usize) -> Option<usize> {
        let at = self.spans.partition_point(|s| s.start <= scroll);
        at.checked_sub(1)
    }

    pub fn span_of(&self, row: usize) -> Option<&Span> {
        let at = self.spans.partition_point(|s| s.start <= row);
        let span = self.spans.get(at.checked_sub(1)?)?;
        (row < span.start + span.rows).then_some(span)
    }

    /// The column row each screen row of the diff shows. Row 0 is always a file header: the
    /// current file's, stuck. Rows below it carry on from the scroll position.
    pub fn row_at(&self, scroll: usize, screen: usize) -> Option<usize> {
        let sticky = self
            .current(scroll)
            .is_some_and(|c| scroll > self.spans[c].start);
        match (screen, sticky) {
            (0, _) => None,
            (r, true) => Some(scroll + r - 1),
            (r, false) => Some(scroll + r),
        }
    }
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}/{name}")
    }
}

/// The one letter for a file seen in several sections.
fn file_letter(parts: &[char]) -> char {
    for wanted in ['!', 'U', 'D', 'R', 'A', 'M'] {
        if parts.contains(&wanted) {
            return wanted;
        }
    }
    '?'
}

#[allow(clippy::too_many_arguments)]
fn walk(
    node: &Node,
    depth: u16,
    prefix: &str,
    visible: bool,
    collapsed: &BTreeSet<String>,
    entries: &mut [Option<FileEntry>],
    ordered: &mut Vec<FileEntry>,
    rows: &mut Vec<TreeRow>,
) -> Counts {
    let mut sum = Counts::zero();
    for (name, child) in &node.dirs {
        let mut label = name.clone();
        let mut path = join(prefix, name);
        let mut cur = child;
        while cur.files.is_empty() && cur.dirs.len() == 1 {
            let (next, below) = cur.dirs.iter().next().expect("one child");
            label = format!("{label}/{next}");
            path = join(&path, next);
            cur = below;
        }
        let open = !collapsed.contains(&path);
        let at = rows.len();
        if visible {
            rows.push(TreeRow {
                depth,
                label,
                kind: TreeKind::Dir {
                    path: path.clone(),
                    open,
                },
                counts: Counts::zero(),
            });
        }
        let counts = walk(
            cur,
            depth + 1,
            &path,
            visible && open,
            collapsed,
            entries,
            ordered,
            rows,
        );
        if visible {
            rows[at].counts = counts;
        }
        sum.plus(counts);
    }
    for (name, index) in &node.files {
        let Some(entry) = entries[*index].take() else {
            continue;
        };
        sum.plus(entry.counts);
        if visible {
            rows.push(TreeRow {
                depth,
                label: name.clone(),
                kind: TreeKind::File {
                    file: ordered.len(),
                },
                counts: entry.counts,
            });
        }
        ordered.push(entry);
    }
    sum
}

impl Changes {
    pub fn view(&self) -> View {
        self.view
    }

    /// Whether the Review is what the list region shows: its view is chosen, the panel is
    /// on the changes, and there are changes to show. With none (or before the first read)
    /// the list says so the way the Stage view does.
    pub(crate) fn review_active(&self) -> bool {
        self.view == View::Review
            && self.mode == Mode::Changes
            && self.groups().is_some_and(|g| !g.is_empty())
    }

    pub fn base(&self) -> Base {
        Base::ALL[self.review.base.min(Base::ALL.len() - 1)]
    }

    pub fn set_view(&mut self, view: View) {
        if self.view == view {
            return;
        }
        self.view = view;
        if view == View::Review {
            // The file the Stage cursor is on is the one the tree starts on.
            if let Some(key) = self.cursor.clone() {
                let tree = self.review_tree();
                if tree.file_index(&key.path).is_some() {
                    self.review.cursor = Some(TreeSel::File(key.path));
                }
            }
            self.review_after_status();
        }
    }

    pub fn toggle_view(&mut self) {
        self.set_view(match self.view {
            View::Review => View::Stage,
            View::Stage => View::Review,
        });
    }

    /// Takes the next base the port can answer; with one, nothing changes.
    pub fn review_next_base(&mut self) {
        self.review.base = (self.review.base + 1) % Base::ALL.len();
    }

    pub fn review_tree_hidden(&self) -> bool {
        self.review.tree_hidden
    }

    pub fn review_toggle_tree(&mut self) {
        self.review.tree_hidden = !self.review.tree_hidden;
        self.review_clamp();
    }

    // ---- the tree ----------------------------------------------------------

    fn counts_of(&self, keys: &[RowKey]) -> Counts {
        let mut counts = Counts::zero();
        for key in keys {
            match self.review.diffs.get(key).map(|v| &v.state) {
                Some(DiffState::Hunks(hunks)) => {
                    for line in hunks.iter().flat_map(|h| &h.lines) {
                        match line.kind {
                            LineKind::Added => counts.add += 1,
                            LineKind::Removed => counts.del += 1,
                            LineKind::Same => {}
                        }
                    }
                }
                Some(DiffState::Binary) => counts.binary = true,
                Some(DiffState::NoLines | DiffState::Folder | DiffState::NoStatus) => {}
                _ => counts.complete = false,
            }
        }
        counts
    }

    /// The files in tree order and the rows the tree shows.
    pub(crate) fn review_tree(&self) -> Tree {
        let Some(groups) = self.groups() else {
            return Tree::default();
        };
        type Found = (Vec<RowKey>, Vec<char>, Option<String>);
        let mut found: BTreeMap<String, Found> = BTreeMap::new();
        for key in groups.keys() {
            let Some(change) = groups.find(&key) else {
                continue;
            };
            let entry = found.entry(key.path.clone()).or_default();
            entry.1.push(letter(key.section, change));
            if entry.2.is_none() {
                entry.2.clone_from(&change.original_path);
            }
            entry.0.push(key);
        }
        let mut entries: Vec<Option<FileEntry>> = Vec::new();
        let mut root = Node::default();
        for (path, (keys, letters, original)) in found {
            let folder = is_folder(&path);
            let counts = self.counts_of(&keys);
            let index = entries.len();
            let mut parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
            let name = if folder {
                format!("{}/", parts.pop().unwrap_or(""))
            } else {
                parts.pop().unwrap_or("").to_owned()
            };
            let mut node = &mut root;
            for dir in parts {
                node = node.dirs.entry(dir.to_owned()).or_default();
            }
            node.files.insert(name, index);
            entries.push(Some(FileEntry {
                letter: file_letter(&letters),
                path,
                keys,
                original,
                folder,
                counts,
            }));
        }
        let mut ordered = Vec::with_capacity(entries.len());
        let mut rows = Vec::new();
        let totals = walk(
            &root,
            0,
            "",
            true,
            &self.review.collapsed,
            &mut entries,
            &mut ordered,
            &mut rows,
        );
        Tree {
            rows,
            files: ordered,
            totals,
        }
    }

    // ---- the diff column ---------------------------------------------------

    fn unit_view(&self, key: &RowKey) -> Option<&DiffView> {
        self.review.diffs.get(key)
    }

    /// What one section's diff of a file shows in place of lines, if it shows no lines.
    fn unit_note(view: Option<&DiffView>) -> Option<(String, Tone)> {
        let Some(view) = view else {
            return Some(("loading the diff".to_owned(), Tone::Muted));
        };
        Some(match &view.state {
            DiffState::Loading => ("loading the diff".to_owned(), Tone::Muted),
            DiffState::Hunks(hunks) => {
                let lines: usize = hunks.iter().map(|h| h.lines.len()).sum();
                if lines > MAX_DIFF_LINES {
                    (
                        format!("{lines} lines: too large to show here, open the file"),
                        Tone::Muted,
                    )
                } else {
                    return None;
                }
            }
            DiffState::Binary => ("binary file".to_owned(), Tone::Muted),
            DiffState::NoLines => ("no line changes".to_owned(), Tone::Muted),
            DiffState::Folder => (
                "untracked folder: its files are not listed".to_owned(),
                Tone::Muted,
            ),
            DiffState::NoStatus => (
                "no comparison: the host did not report its status".to_owned(),
                Tone::Muted,
            ),
            DiffState::Problem(problem) => (problem.text(), crate::layout::problem_tone(problem)),
            DiffState::Unreadable(why) => (format!("could not be read: {why}"), Tone::Error),
            DiffState::Outdated => (
                "out of date: refresh to read it again".to_owned(),
                Tone::Warning,
            ),
        })
    }

    fn unit_rows(view: Option<&DiffView>) -> usize {
        if Self::unit_note(view).is_some() {
            return 1;
        }
        let hunks = view.map_or(&[][..], DiffView::hunks);
        hunks.iter().map(|h| h.lines.len()).sum::<usize>() + hunks.len().saturating_sub(1)
    }

    fn file_rows(&self, file: &FileEntry) -> usize {
        let labelled = file.keys.len() > 1;
        1 + file
            .keys
            .iter()
            .map(|key| usize::from(labelled) + Self::unit_rows(self.unit_view(key)))
            .sum::<usize>()
    }

    /// The row `offset` of a file's part of the diff column.
    pub(crate) fn file_row<'a>(
        &'a self,
        index: usize,
        file: &'a FileEntry,
        offset: usize,
    ) -> Option<DiffRow<'a>> {
        if offset == 0 {
            return Some(DiffRow::Header(index));
        }
        let mut at = offset - 1;
        let labelled = file.keys.len() > 1;
        for key in &file.keys {
            if labelled {
                if at == 0 {
                    return Some(DiffRow::Label(key.section.title()));
                }
                at -= 1;
            }
            let view = self.unit_view(key);
            if let Some((text, tone)) = Self::unit_note(view) {
                if at == 0 {
                    return Some(DiffRow::Note(text, tone));
                }
                at -= 1;
                continue;
            }
            let hunks = view.map_or(&[][..], DiffView::hunks);
            let digits = digits_of(hunks);
            for (n, hunk) in hunks.iter().enumerate() {
                if n > 0 {
                    if at == 0 {
                        return Some(DiffRow::Separator(gap(&hunks[n - 1], hunk)));
                    }
                    at -= 1;
                }
                if at < hunk.lines.len() {
                    return Some(DiffRow::Line {
                        line: &hunk.lines[at],
                        digits,
                    });
                }
                at -= hunk.lines.len();
            }
        }
        None
    }

    pub(crate) fn review_laid(&self, area: Rect) -> Laid {
        let tree = self.review_tree();
        let list = regions_list(self, area);
        let geom = geometry(list, tree.rows.len(), self.review.tree_hidden);
        let mut spans = Vec::with_capacity(tree.files.len());
        let mut start = 0;
        for (file, entry) in tree.files.iter().enumerate() {
            let rows = self.file_rows(entry);
            spans.push(Span { file, start, rows });
            start += rows;
        }
        Laid {
            tree,
            geom,
            spans,
            total: start,
        }
    }

    fn model_area(&self) -> Rect {
        Rect::new(0, 0, self.width, self.height)
    }

    /// The first row the diff shows, kept inside what there is to show.
    pub(crate) fn review_clamp(&mut self) {
        let laid = self.review_laid(self.model_area());
        self.review.scroll = self.review.scroll.min(laid.max_scroll());
        let rows = laid.tree.rows.len();
        let shown = usize::from(laid.geom.tree.height).max(1);
        self.review.tree_scroll = self.review.tree_scroll.min(rows.saturating_sub(shown));
    }

    // ---- scrolling the diff ------------------------------------------------

    pub fn review_scroll(&self) -> usize {
        self.review.scroll
    }

    pub fn review_scroll_by(&mut self, delta: isize) {
        let max = self.review_laid(self.model_area()).max_scroll();
        self.review.scroll = (self.review.scroll as isize + delta).clamp(0, max as isize) as usize;
    }

    /// A page of the diff, less the header and a row of overlap.
    pub fn review_page(&mut self, direction: isize) {
        let laid = self.review_laid(self.model_area());
        let page = usize::from(laid.geom.diff.height).saturating_sub(2).max(1) as isize;
        self.review_scroll_by(direction * page);
    }

    pub fn review_to_edge(&mut self, bottom: bool) {
        self.review.scroll = if bottom {
            self.review_laid(self.model_area()).max_scroll()
        } else {
            0
        };
    }

    pub fn review_tree_scroll_by(&mut self, delta: isize) {
        let laid = self.review_laid(self.model_area());
        let shown = usize::from(laid.geom.tree.height).max(1);
        let max = laid.tree.rows.len().saturating_sub(shown);
        self.review.tree_scroll =
            (self.review.tree_scroll as isize + delta).clamp(0, max as isize) as usize;
    }

    /// The file under the top of the viewport.
    pub fn review_current(&self) -> Option<String> {
        let laid = self.review_laid(self.model_area());
        let at = laid.current(self.review.scroll)?;
        Some(laid.tree.files[at].path.clone())
    }

    // ---- the tree cursor ---------------------------------------------------

    pub fn review_cursor(&self) -> Option<&TreeSel> {
        self.review.cursor.as_ref()
    }

    /// Makes the tree row the selection of the whole panel: its file's rows, or every row
    /// under the folder, so the chords of the Stage view act on it.
    fn review_sync(&mut self, tree: &Tree) {
        let Some(sel) = self.review.cursor.clone() else {
            return;
        };
        let keys: Vec<RowKey> = match &sel {
            TreeSel::File(path) => tree
                .file_index(path)
                .map(|i| tree.files[i].keys.clone())
                .unwrap_or_default(),
            TreeSel::Dir(dir) => tree.under(dir).flat_map(|f| f.keys.clone()).collect(),
        };
        if keys.is_empty() {
            return;
        }
        self.cursor = Some(keys[0].clone());
        self.anchor = self.cursor.clone();
        self.selected = keys.into_iter().collect();
        self.focus = crate::model::Focus::Files;
    }

    fn review_reveal(&mut self, tree: &Tree, shown: usize) {
        let Some(at) = self.review.cursor.as_ref().and_then(|s| tree.index_of(s)) else {
            return;
        };
        let shown = shown.max(1);
        if at < self.review.tree_scroll {
            self.review.tree_scroll = at;
        } else if at >= self.review.tree_scroll + shown {
            self.review.tree_scroll = at + 1 - shown;
        }
    }

    fn review_place(&mut self, tree: &Tree, sel: TreeSel) {
        self.review.cursor = Some(sel);
        self.review_sync(tree);
        let shown = usize::from(self.review_laid(self.model_area()).geom.tree.height);
        self.review_reveal(tree, shown);
    }

    pub fn review_move(&mut self, delta: isize) {
        let tree = self.review_tree();
        if tree.rows.is_empty() {
            return;
        }
        let now = self.review.cursor.as_ref().and_then(|s| tree.index_of(s));
        let at = match now {
            Some(i) => (i as isize + delta).clamp(0, tree.rows.len() as isize - 1) as usize,
            None if delta >= 0 => 0,
            None => tree.rows.len() - 1,
        };
        let sel = tree.sel_of(&tree.rows[at]);
        self.review_place(&tree, sel);
    }

    fn review_set_open(&mut self, dir: &str, open: bool) {
        if open {
            self.review.collapsed.remove(dir);
        } else {
            self.review.collapsed.insert(dir.to_owned());
            // A cursor inside the folder that closed goes to the folder.
            let prefix = format!("{dir}/");
            let inside = match &self.review.cursor {
                Some(TreeSel::File(p)) | Some(TreeSel::Dir(p)) => p.starts_with(&prefix),
                None => false,
            };
            if inside {
                self.review.cursor = Some(TreeSel::Dir(dir.to_owned()));
            }
        }
        let tree = self.review_tree();
        self.review_sync(&tree);
        self.review_clamp();
    }

    /// Left: closes an open folder, else goes to the folder above.
    pub fn review_left(&mut self) {
        let tree = self.review_tree();
        let Some(at) = self.review.cursor.as_ref().and_then(|s| tree.index_of(s)) else {
            return;
        };
        let row = &tree.rows[at];
        if let TreeKind::Dir { path, open: true } = &row.kind {
            let path = path.clone();
            self.review_set_open(&path, false);
            return;
        }
        if let Some(parent) = tree.rows[..at].iter().rposition(|r| r.depth < row.depth) {
            let sel = tree.sel_of(&tree.rows[parent]);
            self.review_place(&tree, sel);
        }
    }

    /// Right: opens a closed folder, else goes into an open one.
    pub fn review_right(&mut self) {
        let tree = self.review_tree();
        let Some(at) = self.review.cursor.as_ref().and_then(|s| tree.index_of(s)) else {
            return;
        };
        match &tree.rows[at].kind {
            TreeKind::Dir { path, open: false } => {
                let path = path.clone();
                self.review_set_open(&path, true);
            }
            TreeKind::Dir { .. } => {
                if tree
                    .rows
                    .get(at + 1)
                    .is_some_and(|r| r.depth > tree.rows[at].depth)
                {
                    let sel = tree.sel_of(&tree.rows[at + 1]);
                    self.review_place(&tree, sel);
                }
            }
            TreeKind::File { .. } => {}
        }
    }

    /// Enter: a file brings its header to the top of the diff, a folder opens or closes.
    pub fn review_enter(&mut self) {
        let tree = self.review_tree();
        let Some(at) = self.review.cursor.as_ref().and_then(|s| tree.index_of(s)) else {
            return;
        };
        match tree.rows[at].kind.clone() {
            TreeKind::File { file } => self.review_jump(&tree.files[file].path),
            TreeKind::Dir { path, open } => self.review_set_open(&path, !open),
        }
    }

    /// Puts a file's header at the top of the diff (as near as the column's end allows).
    pub fn review_jump(&mut self, path: &str) {
        let laid = self.review_laid(self.model_area());
        let Some(at) = laid.tree.file_index(path) else {
            return;
        };
        self.review.scroll = laid.spans[at].start.min(laid.max_scroll());
    }

    /// A press on a tree row (by its index among the rows shown).
    pub fn review_press_tree(&mut self, index: usize) -> Option<String> {
        let tree = self.review_tree();
        let row = tree.rows.get(index)?;
        let sel = tree.sel_of(row);
        let kind = row.kind.clone();
        self.review_place(&tree, sel);
        match kind {
            TreeKind::File { file } => {
                let path = tree.files[file].path.clone();
                self.review_jump(&path);
                Some(path)
            }
            TreeKind::Dir { path, open } => {
                self.review_set_open(&path, !open);
                None
            }
        }
    }

    /// A press on a file's header or lines in the diff: the tree goes to that file.
    pub fn review_press_file(&mut self, file: usize) {
        let tree = self.review_tree();
        if let Some(entry) = tree.files.get(file) {
            let sel = TreeSel::File(entry.path.clone());
            self.review_place(&tree, sel);
        }
    }

    // ---- reads -------------------------------------------------------------

    /// The diffs to ask for now: the files whose rows are within a half page of the
    /// viewport, nearest the top first, and any shown diff that has gone stale. At most a
    /// few are out at once, so a long list does not all go out when none of it is in view.
    pub fn review_wants(&mut self) -> Vec<Intent> {
        if !self.review_active() {
            return Vec::new();
        }
        let laid = self.review_laid(self.model_area());
        let page = usize::from(laid.geom.diff.height).max(1);
        let low = self.review.scroll.saturating_sub(page / 2);
        let high = self.review.scroll + page + page / 2;
        let near = |s: &&Span| s.start < high && s.start + s.rows > low;
        let ahead = laid.spans.len() <= READ_AHEAD_FILES;
        let mut wanted: Vec<RowKey> = Vec::new();
        for span in laid
            .spans
            .iter()
            .filter(near)
            .chain(laid.spans.iter().filter(|s| ahead && !near(s)))
        {
            for key in &laid.tree.files[span.file].keys {
                match self.review.diffs.get(key) {
                    None => wanted.push(key.clone()),
                    Some(view) if view.stale && view.request.is_none() => wanted.push(key.clone()),
                    Some(_) => {}
                }
            }
        }
        let mut out = Vec::new();
        let mut out_now = self
            .review
            .diffs
            .values()
            .filter(|v| v.request.is_some())
            .count();
        for key in wanted {
            if out_now >= IN_FLIGHT {
                break;
            }
            if let Some(intent) = self.review_open(&key) {
                out.push(intent);
                out_now += 1;
            }
        }
        out
    }

    /// Where the viewport is, by file, so a diff that grows above it does not move it.
    pub(crate) fn review_anchor(&self) -> Option<(String, usize)> {
        let laid = self.review_laid(self.model_area());
        let at = laid.current(self.review.scroll)?;
        Some((
            laid.tree.files[at].path.clone(),
            self.review.scroll - laid.spans[at].start,
        ))
    }

    pub(crate) fn review_restore(&mut self, anchor: Option<(String, usize)>) {
        let Some((path, offset)) = anchor else {
            return;
        };
        let laid = self.review_laid(self.model_area());
        if let Some(at) = laid.tree.file_index(&path) {
            let span = laid.spans[at];
            let row = span.start + offset.min(span.rows.saturating_sub(1));
            self.review.scroll = row.min(laid.max_scroll());
        }
    }

    /// What a new status does to the Review: diffs of rows that are gone are dropped, a
    /// diff whose file changed is marked stale (and asked for again when in view), a
    /// failed one is tried again, and the tree cursor stays on a file that is still there.
    pub(crate) fn review_after_status(&mut self) {
        let keys = self.keys();
        self.review.diffs.retain(|k, _| keys.contains(k));
        if let Some(snapshot) = self.snapshot.as_ref() {
            for (key, view) in &mut self.review.diffs {
                let now = snapshot
                    .groups
                    .find(key)
                    .map(|change| crate::status::Basis {
                        state: snapshot.state.clone(),
                        head: snapshot.oid.clone(),
                        change: change.clone(),
                    });
                if view.basis != now && view.basis.is_some() && view.state != DiffState::Loading {
                    view.stale = true;
                }
            }
        }
        self.review
            .diffs
            .retain(|_, v| !matches!(v.state, DiffState::Problem(_)));
        if self.view != View::Review {
            return;
        }
        let tree = self.review_tree();
        let valid = match &self.review.cursor {
            Some(TreeSel::File(p)) => tree.file_index(p).is_some(),
            Some(TreeSel::Dir(d)) => tree.under(d).next().is_some(),
            None => false,
        };
        if !valid {
            self.review.cursor = tree.files.first().map(|f| TreeSel::File(f.path.clone()));
        }
        self.review_sync(&tree);
        self.review_clamp();
    }
}

/// Digits of the largest line number in a diff, at least two.
pub(crate) fn digits_of(hunks: &[Hunk]) -> usize {
    let most = hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .flat_map(|l| [l.old, l.new])
        .flatten()
        .max()
        .unwrap_or(0);
    most.to_string().len().max(2)
}

/// The lines of the file between two hunks, when both name their place in the old file.
fn gap(before: &Hunk, after: &Hunk) -> Option<usize> {
    let last = before.lines.iter().rev().find_map(|l| l.old)?;
    let first = after.lines.iter().find_map(|l| l.old)?;
    first.checked_sub(last + 1)
}

fn regions_list(model: &Changes, area: Rect) -> Rect {
    regions(model, area).list
}
