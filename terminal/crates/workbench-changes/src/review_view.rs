//! Drawing, hit testing and the semantic nodes of the Review view.
//!
//! Written for this crate; not translated. Every colour is a role of [`ChangesStyles`]
//! (the workbench theme's), so the view reads the same under today's palette and under
//! the proposal's ladder.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::semantics::{Node, NodeAction, Role};
use theorem_workbench_core::{ActionId, Icon, put_icon};

use crate::layout::Tone;
use crate::model::{Changes, Focus};
use crate::review::{Counts, DiffRow, FileEntry, Laid, Tree, TreeKind};
use crate::semantics::actions;
use crate::status::shown;
use crate::styles::ChangesStyles;
use crate::text::{elide_middle, fit, paint, printable, put, width};
use theorem_workbench_text::visible::visible;

/// What lies under a cell of the Review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReviewHit {
    Nothing,
    /// The base the changes are read since.
    Base,
    Refresh,
    /// The stacked tree's heading line.
    TreeHead,
    /// A row of the tree, by its index among the rows.
    Tree(usize),
    /// A file's header in the diff.
    Header(usize),
    /// A line of a file's diff.
    Diff(usize),
}

const REFRESH: &str = "[refresh]";

/// The header line's parts, as columns of the line.
struct HeaderCells {
    base: (u16, u16),
    refresh: Option<(u16, u16)>,
}

fn files_words(count: usize) -> String {
    format!("{count} file{}", if count == 1 { "" } else { "s" })
}

fn counts_text(counts: &Counts) -> (String, String) {
    (
        format!("+{}", counts.add),
        format!("\u{2212}{}", counts.del),
    )
}

impl Changes {
    fn since_text(&self) -> String {
        format!("Since {}", self.base().label())
    }

    fn header_cells(&self, width_cells: u16) -> HeaderCells {
        let base_w = width(&self.since_text()) as u16;
        let refresh_w = width(REFRESH) as u16;
        let refresh = (width_cells > base_w + refresh_w + 24)
            .then(|| (width_cells - refresh_w - 1, refresh_w));
        HeaderCells {
            base: (1, base_w.min(width_cells.saturating_sub(1))),
            refresh,
        }
    }

    /// What the Review shows at `area`, which is where a press lands.
    pub(crate) fn review_hit(&self, area: Rect, x: u16, y: u16) -> ReviewHit {
        let laid = self.review_laid(area);
        let inside = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        let g = laid.geom;
        if inside(g.header) {
            let cells = self.header_cells(g.header.width);
            let col = x - g.header.x;
            if let Some((at, w)) = cells.refresh
                && col >= at
                && col < at + w
            {
                return ReviewHit::Refresh;
            }
            let (at, w) = cells.base;
            return if col >= at && col < at + w {
                ReviewHit::Base
            } else {
                ReviewHit::Nothing
            };
        }
        if inside(g.tree_head) {
            return ReviewHit::TreeHead;
        }
        if inside(g.tree) {
            let at = self.review.tree_scroll + usize::from(y - g.tree.y);
            return if at < laid.tree.rows.len() {
                ReviewHit::Tree(at)
            } else {
                ReviewHit::Nothing
            };
        }
        if inside(g.diff) {
            let screen = usize::from(y - g.diff.y);
            let scroll = self.review.scroll;
            let (file, header) = if screen == 0 {
                (laid.current(scroll), true)
            } else {
                let Some(row) = laid.row_at(scroll, screen) else {
                    return ReviewHit::Nothing;
                };
                match laid.span_of(row) {
                    Some(span) => (Some(span.file), row == span.start),
                    None => (None, false),
                }
            };
            return match file {
                Some(file) if header => ReviewHit::Header(file),
                Some(file) => ReviewHit::Diff(file),
                None => ReviewHit::Nothing,
            };
        }
        ReviewHit::Nothing
    }

    /// Whether a cell is over the tree (a wheel there scrolls the tree).
    pub(crate) fn review_over_tree(&self, area: Rect, x: u16, y: u16) -> bool {
        let g = self.review_laid(area).geom;
        let inside = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        inside(g.tree) || inside(g.tree_head)
    }

    // ---- drawing -----------------------------------------------------------

    pub(crate) fn draw_review(&self, area: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        let laid = self.review_laid(area);
        let g = laid.geom;
        paint(
            buf,
            Rect::new(area.x, g.header.y, area.width, area.height),
            styles.text,
        );
        self.draw_review_header(&laid, buf, styles);
        self.draw_review_tree(&laid, buf, styles);
        self.draw_review_diff(&laid, buf, styles);
        for y in g.rule.y..g.rule.y + g.rule.height {
            put(buf, g.rule.x, y, 1, "\u{2502}", styles.line);
        }
    }

    fn draw_review_header(&self, laid: &Laid, buf: &mut Buffer, styles: &ChangesStyles) {
        let r = laid.geom.header;
        if r.height == 0 || r.width == 0 {
            return;
        }
        let cells = self.header_cells(r.width);
        let limit = cells
            .refresh
            .map_or(r.width, |(at, _)| at.saturating_sub(1));
        let since = self.since_text();
        let mut x = put(
            buf,
            r.x + cells.base.0,
            r.y,
            cells.base.1 as usize,
            &since,
            styles.heading,
        ) as u16
            + cells.base.0;
        let put_part = |text: &str, style: Style, buf: &mut Buffer, x: &mut u16| {
            if *x < limit {
                let used = put(buf, r.x + *x, r.y, usize::from(limit - *x), text, style);
                *x += used as u16;
            }
        };
        x += 2;
        let totals = laid.tree.totals;
        let (add, del) = counts_text(&totals);
        put_part(&add, styles.letter_added, buf, &mut x);
        x += 1;
        put_part(&del, styles.letter_deleted, buf, &mut x);
        if !totals.complete {
            put_part("\u{2026}", styles.muted, buf, &mut x);
        }
        x += 2;
        // Whole or not at all: the tree's heading says the count too, and a cut word
        // would run into the control beside it.
        let files = format!("\u{00b7} {}", files_words(laid.tree.files.len()));
        if usize::from(x) + width(&files) <= usize::from(limit) {
            put_part(&files, styles.muted, buf, &mut x);
        }
        if let Some((at, w)) = cells.refresh {
            put(buf, r.x + at, r.y, usize::from(w), REFRESH, styles.button);
        }
    }

    fn put_counts(
        &self,
        buf: &mut Buffer,
        rect: Rect,
        counts: &Counts,
        row_style: Style,
        styles: &ChangesStyles,
    ) -> usize {
        let (add, del) = counts_text(counts);
        let known = counts.add + counts.del > 0 || counts.complete;
        let text_w = if counts.binary && counts.add + counts.del == 0 {
            3
        } else if known {
            width(&add) + 1 + width(&del) + usize::from(!counts.complete)
        } else {
            0
        };
        if text_w == 0 || usize::from(rect.width) < text_w + 6 {
            return 0;
        }
        let mut x = rect.right() - 1 - text_w as u16;
        if counts.binary && counts.add + counts.del == 0 {
            put(buf, x, rect.y, 3, "bin", row_style.patch(styles.muted));
            return text_w + 1;
        }
        x += put(
            buf,
            x,
            rect.y,
            width(&add),
            &add,
            row_style.patch(styles.letter_added),
        ) as u16
            + 1;
        x += put(
            buf,
            x,
            rect.y,
            width(&del),
            &del,
            row_style.patch(styles.letter_deleted),
        ) as u16;
        if !counts.complete {
            put(buf, x, rect.y, 1, "\u{2026}", row_style.patch(styles.muted));
        }
        text_w + 1
    }

    fn draw_review_tree(&self, laid: &Laid, buf: &mut Buffer, styles: &ChangesStyles) {
        let g = laid.geom;
        if g.tree_head.height > 0 && g.tree_head.width > 0 {
            let r = g.tree_head;
            paint(buf, r, styles.hunk_header);
            let icon = if self.review.tree_hidden {
                Icon::FolderEmpty
            } else {
                Icon::FolderFile
            };
            put_icon(buf, r.x + 1, r.y, r.right(), icon, styles.hunk_header);
            let title = format!("Files {}", laid.tree.files.len());
            put(
                buf,
                r.x + 4,
                r.y,
                usize::from(r.width.saturating_sub(5)),
                &title,
                styles.hunk_header.patch(styles.heading),
            );
            self.put_counts(buf, r, &laid.tree.totals, styles.hunk_header, styles);
        }
        if g.tree.height == 0 || g.tree.width == 0 {
            return;
        }
        let current = laid.current(self.review.scroll);
        let focused = self.focus == Focus::Files;
        for screen in 0..usize::from(g.tree.height) {
            let Some(row) = laid.tree.rows.get(self.review.tree_scroll + screen) else {
                break;
            };
            let rect = Rect::new(g.tree.x, g.tree.y + screen as u16, g.tree.width, 1);
            let sel = laid.tree.sel_of(row);
            let cursor = self.review.cursor.as_ref() == Some(&sel);
            let file = match &row.kind {
                TreeKind::File { file } => Some(&laid.tree.files[*file]),
                TreeKind::Dir { .. } => None,
            };
            let picked = file.is_some_and(|f| f.keys.iter().all(|k| self.selected.contains(k)));
            let row_style = match (cursor, picked) {
                (true, _) if focused => styles.cursor,
                (true, _) => styles.cursor_idle,
                (false, true) => styles.selected,
                (false, false) => styles.text,
            };
            paint(buf, rect, row_style);
            let is_current =
                file.is_some_and(|f| current.is_some_and(|c| laid.tree.files[c].path == f.path));
            if is_current {
                put(
                    buf,
                    rect.x,
                    rect.y,
                    1,
                    "\u{258d}",
                    row_style.patch(styles.heading),
                );
            }
            let x = rect.x + 1 + row.depth * 2;
            let icon = match &row.kind {
                TreeKind::Dir { open: true, .. } => Icon::FolderFile,
                TreeKind::Dir { .. } => Icon::FolderEmpty,
                TreeKind::File { .. } => match file.map_or('M', |f| f.letter) {
                    _ if file.is_some_and(|f| f.folder) => Icon::FolderEdit,
                    'A' | 'U' | '?' => Icon::FileAdd,
                    'M' => Icon::FileEdit,
                    _ => Icon::FileEmpty,
                },
            };
            let mut at = put_icon(buf, x, rect.y, rect.right(), icon, row_style);
            let mut name_style = row_style;
            if let Some(f) = file {
                let style = crate::draw::file_letter_style(styles, f.letter);
                put(
                    buf,
                    at,
                    rect.y,
                    1,
                    &f.letter.to_string(),
                    row_style.patch(style),
                );
                at += 2;
                if f.letter == 'D' {
                    name_style = row_style.patch(styles.removed_line);
                }
            }
            if is_current {
                name_style = name_style.patch(styles.heading);
            }
            let taken = self.put_counts(buf, rect, &row.counts, row_style, styles);
            let room = usize::from(rect.right().saturating_sub(at)).saturating_sub(taken);
            let label = elide_middle(&printable(&row.label), room);
            put(buf, at, rect.y, room, &label, name_style);
        }
    }

    fn draw_review_diff(&self, laid: &Laid, buf: &mut Buffer, styles: &ChangesStyles) {
        let r = laid.geom.diff;
        if r.height == 0 || r.width == 0 {
            return;
        }
        let scroll = self.review.scroll;
        let current = laid.current(scroll);
        for screen in 0..usize::from(r.height) {
            let line = Rect::new(r.x, r.y + screen as u16, r.width, 1);
            let row = if screen == 0 {
                current.map(DiffRow::Header)
            } else {
                laid.row_at(scroll, screen).and_then(|row| {
                    let span = laid.span_of(row)?;
                    self.file_row(span.file, &laid.tree.files[span.file], row - span.start)
                })
            };
            if let Some(row) = row {
                self.draw_diff_row(row, line, &laid.tree, buf, styles);
            }
        }
    }

    fn draw_diff_row(
        &self,
        row: DiffRow<'_>,
        rect: Rect,
        tree: &Tree,
        buf: &mut Buffer,
        styles: &ChangesStyles,
    ) {
        let w = usize::from(rect.width);
        match row {
            DiffRow::Header(file) => {
                let f: &FileEntry = &tree.files[file];
                paint(buf, rect, styles.hunk_header);
                let style = styles.hunk_header;
                put(
                    buf,
                    rect.x + 1,
                    rect.y,
                    1,
                    &f.letter.to_string(),
                    style.patch(crate::draw::file_letter_style(styles, f.letter)),
                );
                let taken = self.put_counts(buf, rect, &f.counts, style, styles);
                let room = w.saturating_sub(4 + taken);
                let mut path = shown(&f.path);
                if let Some(original) = &f.original {
                    path = format!("{} \u{2190} {}", path, shown(original));
                }
                put(
                    buf,
                    rect.x + 3,
                    rect.y,
                    room,
                    &elide_middle(&printable(&path), room),
                    style.patch(styles.heading),
                );
            }
            DiffRow::Label(title) => {
                let text = title.to_string();
                put(
                    buf,
                    rect.x + 2,
                    rect.y,
                    w.saturating_sub(2),
                    &fit(&text, w.saturating_sub(2)),
                    styles.muted,
                );
            }
            DiffRow::Separator(gap) => {
                let text = match gap {
                    Some(1) => "\u{00b7}\u{00b7}\u{00b7} 1 unchanged line".to_owned(),
                    Some(n) => format!("\u{00b7}\u{00b7}\u{00b7} {n} unchanged lines"),
                    None => "\u{00b7}\u{00b7}\u{00b7}".to_owned(),
                };
                put(
                    buf,
                    rect.x + 2,
                    rect.y,
                    w.saturating_sub(2),
                    &text,
                    styles.muted,
                );
            }
            DiffRow::Line { line, digits } => {
                self.draw_unified(line, digits, rect, buf, styles, "\u{2212}");
            }
            DiffRow::Note(text, tone) => {
                let style = match tone {
                    Tone::Error => styles.error,
                    Tone::Warning => styles.warning,
                    _ => styles.muted,
                };
                put(
                    buf,
                    rect.x + 4,
                    rect.y,
                    w.saturating_sub(4),
                    &fit(&printable(&text), w.saturating_sub(4)),
                    style,
                );
            }
        }
    }

    // ---- semantics ---------------------------------------------------------

    fn review_file_actions(&self, file: &FileEntry, block: Option<String>) -> Vec<NodeAction> {
        let mut out: Vec<NodeAction> = Vec::new();
        for key in &file.keys {
            for action in self.file_actions(key, block.clone()) {
                if !out.iter().any(|a| a.id == action.id) {
                    out.push(action);
                }
            }
        }
        out
    }

    fn counts_words(counts: &Counts) -> String {
        let mut text = if counts.binary && counts.add + counts.del == 0 {
            "binary".to_owned()
        } else {
            format!("+{} \u{2212}{}", counts.add, counts.del)
        };
        if !counts.complete {
            text.push_str(" so far");
        }
        text
    }

    /// The Review's nodes: the header, the tree and the diff.
    pub(crate) fn review_nodes(
        &self,
        id: &str,
        area: Rect,
        root: &mut Node,
        nodes: &mut Vec<Node>,
        block: Option<String>,
    ) {
        let laid = self.review_laid(area);
        let g = laid.geom;
        let totals = laid.tree.totals;
        let mut summary = Node::new(
            &format!("{id}/review/summary"),
            Role::Status,
            &format!(
                "Since {}: {}, {}",
                self.base().label(),
                Self::counts_words(&totals),
                files_words(laid.tree.files.len())
            ),
            g.header,
        );
        summary.state.busy = !totals.complete;
        root.children.push(summary.id.clone());
        nodes.push(summary);
        let cells = self.header_cells(g.header.width);
        let mut base = Node::new(
            &format!("{id}/review/base"),
            Role::Button,
            &format!("Base: {}", self.base().label()),
            Rect::new(g.header.x + cells.base.0, g.header.y, cells.base.1, 1),
        );
        base.state.description =
            Some("The changes are the working tree compared with the last commit".to_owned());
        root.children.push(base.id.clone());
        nodes.push(base);
        if let Some((at, w)) = cells.refresh {
            let mut refresh = Node::new(
                &format!("{id}/review/refresh"),
                Role::Button,
                "Refresh changes",
                Rect::new(g.header.x + at, g.header.y, w, 1),
            );
            refresh.actions = vec![NodeAction {
                id: ActionId::new(actions::REFRESH),
                enabled: true,
                reason: None,
                title: None,
            }];
            root.children.push(refresh.id.clone());
            nodes.push(refresh);
        }

        let mut tree = Node::new(&format!("{id}/list"), Role::Tree, "Changed files", {
            if g.tree.height > 0 {
                g.tree
            } else {
                g.tree_head
            }
        });
        let current = laid.current(self.review.scroll);
        let focused = self.focus == Focus::Files;
        let mut kids = Vec::new();
        for (at, row) in laid.tree.rows.iter().enumerate() {
            let shown_at = at.checked_sub(self.review.tree_scroll);
            let rect = match shown_at {
                Some(i) if i < usize::from(g.tree.height) => {
                    Rect::new(g.tree.x, g.tree.y + i as u16, g.tree.width, 1)
                }
                _ => Rect::new(g.tree.x, g.tree.y, g.tree.width, 0),
            };
            let sel = laid.tree.sel_of(row);
            let cursor = self.review.cursor.as_ref() == Some(&sel);
            let words = Self::counts_words(&row.counts);
            let mut node = match &row.kind {
                TreeKind::Dir { path, open } => {
                    let mut n = Node::new(
                        &format!("{id}/dir/{path}"),
                        Role::TreeItem,
                        &visible(&format!("{} {words}", row.label)),
                        rect,
                    );
                    n.state.expanded = Some(*open);
                    n
                }
                TreeKind::File { file } => {
                    let f = &laid.tree.files[*file];
                    let mut n = Node::new(
                        &format!("{id}/rfile/{}", f.path),
                        Role::TreeItem,
                        &visible(&format!("{} {} {words}", f.letter, shown(&f.path))),
                        rect,
                    );
                    n.actions = self.review_file_actions(f, block.clone());
                    let mut said = Vec::new();
                    if let Some(original) = &f.original {
                        said.push(format!("renamed from {}", shown(original)));
                    }
                    if current == Some(*file) {
                        said.push("the file the diff is showing".to_owned());
                    }
                    if let Some(doc) = self.unsaved(&f.path) {
                        said.push(format!(
                            "unsaved draft in the editor{}",
                            doc.saved_revision
                                .map(|r| format!(", saved file is revision {r}"))
                                .unwrap_or_default()
                        ));
                    }
                    if !said.is_empty() {
                        n.state.description = Some(visible(&said.join("; ")));
                    }
                    n
                }
            };
            node.level = Some(row.depth + 1);
            node.state.selected = cursor;
            node.state.focused = cursor && focused;
            kids.push(node);
        }
        for kid in &kids {
            tree.children.push(kid.id.clone());
        }
        root.children.push(tree.id.clone());
        nodes.push(tree);
        nodes.extend(kids);

        let loaded = laid
            .tree
            .files
            .iter()
            .filter(|f| {
                f.keys.iter().all(|k| {
                    self.review
                        .diffs
                        .get(k)
                        .is_some_and(|v| v.state != crate::model::DiffState::Loading)
                })
            })
            .count();
        let mut diff = Node::new(
            &format!("{id}/diff"),
            Role::Document,
            "Diff of all changes",
            g.diff,
        );
        diff.state.description = Some(format!("{loaded} of {} diffs read", laid.tree.files.len()));
        let mut headers: Vec<Node> = laid
            .tree
            .files
            .iter()
            .enumerate()
            .map(|(at, f)| {
                let mut n = Node::new(
                    &format!("{id}/header/{}", f.path),
                    Role::Heading,
                    &visible(&format!(
                        "{} {}",
                        shown(&f.path),
                        Self::counts_words(&f.counts)
                    )),
                    Rect::new(g.diff.x, g.diff.y, g.diff.width, 0),
                );
                n.state.selected = current == Some(at);
                n
            })
            .collect();
        let scroll = self.review.scroll;
        for screen in 0..usize::from(g.diff.height) {
            let file = if screen == 0 {
                current
            } else {
                laid.row_at(scroll, screen).and_then(|row| {
                    let span = laid.span_of(row)?;
                    (row == span.start).then_some(span.file)
                })
            };
            if let Some(file) = file {
                headers[file].rect = Some(theorem_workbench_core::semantics::CellRect::of(
                    Rect::new(g.diff.x, g.diff.y + screen as u16, g.diff.width, 1),
                ));
            }
        }
        for header in &headers {
            diff.children.push(header.id.clone());
        }
        root.children.push(diff.id.clone());
        nodes.push(diff);
        nodes.extend(headers);
    }

    /// The view switch: a tab list on the branch line.
    pub(crate) fn view_tabs(&self, id: &str, branch: Rect) -> Option<Vec<Node>> {
        use crate::layout::{Control, branch_controls};
        use crate::review::View;
        let controls = branch_controls(self, branch.width);
        let tab = |control: Control| {
            controls
                .iter()
                .find(|(c, ..)| *c == control)
                .map(|(_, at, w)| Rect::new(branch.x + at, branch.y, *w, 1))
        };
        let (review, stage) = (tab(Control::ViewReview)?, tab(Control::ViewStage)?);
        let mut list = Node::new(
            &format!("{id}/view"),
            Role::TabList,
            "Changes view",
            Rect::new(review.x, review.y, stage.right() - review.x, 1),
        );
        let mut out = Vec::new();
        for (view, rect) in [(View::Review, review), (View::Stage, stage)] {
            let mut node = Node::new(
                &format!("{id}/view/{}", view.label().to_lowercase()),
                Role::Tab,
                view.label(),
                rect,
            );
            node.state.selected = self.view == view;
            list.children.push(node.id.clone());
            out.push(node);
        }
        out.insert(0, list);
        Some(out)
    }
}
