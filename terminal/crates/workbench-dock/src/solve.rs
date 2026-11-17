//! Geometry: the dock solved in terminal cells, and hit testing on the result.
//!
//! `Dock::solve` is a pure function of the dock, the area and the cell metrics.
//! Collapsing never edits the dock, so growing the area back restores the
//! arrangement exactly.

use std::collections::BTreeSet;

use ratatui::layout::{Direction, Rect};
use unicode_width::UnicodeWidthStr;

use crate::dock::Dock;
use crate::types::{CellMetrics, GroupId, PanelId, Role};
use theorem_workbench_layout::Node;

/// Thickness of a splitter gutter, in cells, along its split's axis.
pub const GUTTER: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presentation {
    /// Every visible group has its own rectangle.
    Tiled,
    /// The regions do not fit: one group is shown, all tabs preserved.
    Principal,
    /// One group is maximized.
    Maximized,
}

/// Why a group has no rectangle in this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suppressed {
    Hidden,
    /// Behind the principal group because the regions do not fit.
    Collapsed,
    /// Behind the maximized group.
    Maximized,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TabFrame {
    pub panel: PanelId,
    pub rect: Rect,
    /// The close control, a single cell inside `rect` (empty when no room).
    pub close: Rect,
    pub active: bool,
    pub unavailable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupFrame {
    pub id: GroupId,
    pub role: Role,
    pub rect: Rect,
    pub tab_strip: Rect,
    pub body: Rect,
    /// Tabs that fit in the strip, in order. The active tab is always listed.
    pub tabs: Vec<TabFrame>,
    pub tabs_before: usize,
    pub tabs_after: usize,
    pub active: Option<PanelId>,
    pub focused: bool,
    /// A drawer drawn over the content; hit tests reach it first.
    pub overlay: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SplitterFrame {
    /// Root-to-node path: false is the first child, true the second.
    pub path: Vec<bool>,
    /// Direction of the split (Horizontal puts the children side by side).
    pub direction: Direction,
    /// The gutter itself.
    pub rect: Rect,
    /// The pointer target: the gutter widened to the configured hit size.
    pub hit: Rect,
    /// Area of the whole split node.
    pub area: Rect,
    pub first_len: u16,
    /// Cells shared by the two children (area extent minus the gutter).
    pub available: u16,
    pub min_first: u16,
    pub min_second: u16,
}

/// A Files group that has collapsed. `rect` is where it draws when `open`.
#[derive(Debug, Clone, PartialEq)]
pub struct DrawerFrame {
    pub group: GroupId,
    pub rect: Rect,
    pub open: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolvedFrame {
    pub area: Rect,
    pub presentation: Presentation,
    pub groups: Vec<GroupFrame>,
    pub splitters: Vec<SplitterFrame>,
    pub drawers: Vec<DrawerFrame>,
    pub suppressed: Vec<(GroupId, Suppressed)>,
    pub focused: Option<GroupId>,
}

/// What lies under a cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hit {
    TabClose { group: GroupId, panel: PanelId },
    Tab { group: GroupId, panel: PanelId },
    TabStrip { group: GroupId },
    Body { group: GroupId },
    Splitter { path: Vec<bool> },
    Outside,
}

impl SolvedFrame {
    pub fn group(&self, id: GroupId) -> Option<&GroupFrame> {
        self.groups.iter().find(|g| g.id == id)
    }

    /// What is at column `x`, row `y`. An open drawer is on top, then the
    /// gutters, then group contents, then the wider splitter hit regions.
    pub fn hit_test(&self, x: u16, y: u16) -> Hit {
        if let Some(g) = self
            .groups
            .iter()
            .rev()
            .find(|g| g.overlay && has(g.rect, x, y))
        {
            return hit_group(g, x, y);
        }
        if let Some(s) = self.splitters.iter().find(|s| has(s.rect, x, y)) {
            return Hit::Splitter {
                path: s.path.clone(),
            };
        }
        if let Some(g) = self.groups.iter().rev().find(|g| has(g.rect, x, y)) {
            return hit_group(g, x, y);
        }
        if let Some(s) = self.splitters.iter().find(|s| has(s.hit, x, y)) {
            return Hit::Splitter {
                path: s.path.clone(),
            };
        }
        Hit::Outside
    }
}

fn has(r: Rect, x: u16, y: u16) -> bool {
    x >= r.x && y >= r.y && x < r.right() && y < r.bottom()
}

fn hit_group(g: &GroupFrame, x: u16, y: u16) -> Hit {
    if has(g.tab_strip, x, y) {
        for t in &g.tabs {
            if has(t.close, x, y) {
                return Hit::TabClose {
                    group: g.id,
                    panel: t.panel.clone(),
                };
            }
            if has(t.rect, x, y) {
                return Hit::Tab {
                    group: g.id,
                    panel: t.panel.clone(),
                };
            }
        }
        return Hit::TabStrip { group: g.id };
    }
    Hit::Body { group: g.id }
}

impl Dock {
    /// Solve the dock into `area` (terminal cells) using `metrics` to turn the
    /// configured pixel targets into cells.
    pub fn solve(&self, area: Rect, metrics: CellMetrics) -> SolvedFrame {
        let m = metrics.sane();
        let mut frame = SolvedFrame {
            area,
            presentation: Presentation::Tiled,
            groups: Vec::new(),
            splitters: Vec::new(),
            drawers: Vec::new(),
            suppressed: Vec::new(),
            focused: None,
        };
        let focus = self.layout.focused();
        let hidden: BTreeSet<GroupId> = self
            .groups
            .iter()
            .filter(|(_, g)| g.hidden)
            .map(|(id, _)| *id)
            .collect();

        // Maximized: one group takes everything.
        if let Some(max) = self.maximized.filter(|g| !hidden.contains(g)) {
            frame.presentation = Presentation::Maximized;
            frame.groups.push(self.group_frame(max, area, focus, false));
            for id in self.layout.pane_ids() {
                if id != max {
                    let why = if hidden.contains(&id) {
                        Suppressed::Hidden
                    } else {
                        Suppressed::Maximized
                    };
                    frame.suppressed.push((id, why));
                }
            }
            frame.focused = (max == focus).then_some(max);
            return frame;
        }

        // A tool group with no tabs that nobody asked for takes no room: the
        // main pane keeps the width. Only when something else is left to show.
        let unasked: Vec<GroupId> = self
            .groups
            .iter()
            .filter(|(id, g)| {
                g.role == Role::Tools && g.tabs.is_empty() && !g.keep_empty && !hidden.contains(id)
            })
            .map(|(id, _)| *id)
            .collect();
        let others_shown = self
            .groups
            .keys()
            .any(|id| !hidden.contains(id) && !unasked.contains(id));
        let mut excluded = hidden.clone();
        if others_shown {
            excluded.extend(unasked.iter().copied());
        }
        let mut ctx = Ctx {
            dock: self,
            m,
            excluded,
        };
        let mut collapsed_files: Vec<GroupId> = Vec::new();
        if !ctx.fits(area) {
            // Files collapses first, if anything else is left to show.
            let files: Vec<GroupId> = self
                .layout
                .pane_ids()
                .into_iter()
                .filter(|id| ctx.visible(*id) && self.groups[id].role == Role::Files)
                .collect();
            let others = self
                .layout
                .pane_ids()
                .into_iter()
                .any(|id| ctx.visible(id) && self.groups[&id].role != Role::Files);
            if !files.is_empty() && others {
                for id in &files {
                    ctx.excluded.insert(*id);
                }
                collapsed_files = files;
            }
        }

        if ctx.fits(area) {
            let mut placed = Vec::new();
            ctx.place(
                self.layout.root(),
                area,
                &mut Vec::new(),
                &mut placed,
                &mut frame.splitters,
            );
            for (id, rect) in placed {
                frame.groups.push(self.group_frame(id, rect, focus, false));
            }
        } else {
            // One principal panel at a time; the others keep their tabs.
            frame.presentation = Presentation::Principal;
            let order = self.layout.pane_ids();
            let live: Vec<GroupId> = order
                .iter()
                .copied()
                .filter(|id| ctx.visible(*id))
                .collect();
            let shown = if live.contains(&focus) {
                Some(focus)
            } else {
                live.iter()
                    .copied()
                    .find(|id| self.groups[id].role == Role::Main)
                    .or_else(|| live.first().copied())
            };
            if let Some(id) = shown {
                frame.groups.push(self.group_frame(id, area, focus, false));
            }
            for id in live {
                if Some(id) != shown {
                    frame.suppressed.push((id, Suppressed::Collapsed));
                }
            }
        }

        for id in self.layout.pane_ids() {
            if hidden.contains(&id) || (others_shown && unasked.contains(&id)) {
                frame.suppressed.push((id, Suppressed::Hidden));
            }
        }

        for id in collapsed_files {
            let width = m.cols_round(self.groups[&id].pinned_px.unwrap_or(self.cfg.files_px));
            let rect = Rect::new(area.x, area.y, width.min(area.width), area.height);
            let open = self.drawer == Some(id);
            frame.drawers.push(DrawerFrame {
                group: id,
                rect,
                open,
            });
            if open {
                frame.groups.push(self.group_frame(id, rect, focus, true));
            }
        }

        frame.focused = frame
            .groups
            .iter()
            .rev()
            .find(|g| g.id == focus)
            .map(|g| g.id);
        frame
    }

    fn group_frame(&self, id: GroupId, rect: Rect, focus: GroupId, overlay: bool) -> GroupFrame {
        let group = &self.groups[&id];
        let strip_h = rect.height.min(1);
        let tab_strip = Rect::new(rect.x, rect.y, rect.width, strip_h);
        let body = Rect::new(rect.x, rect.y + strip_h, rect.width, rect.height - strip_h);
        let (tabs, before, after) = layout_tabs(group, tab_strip, self.cfg.max_tab_cells);
        GroupFrame {
            id,
            role: group.role,
            rect,
            tab_strip,
            body,
            tabs,
            tabs_before: before,
            tabs_after: after,
            active: group.active.map(|i| group.tabs[i].panel.clone()),
            focused: id == focus,
            overlay,
        }
    }
}

/// Lay tabs left to right in the strip. Each tab is a space, the title, a
/// space, a close cell and a space. When they do not all fit, the window slides
/// so the active tab is shown.
fn layout_tabs(
    group: &crate::dock::Group,
    strip: Rect,
    max_cells: u16,
) -> (Vec<TabFrame>, usize, usize) {
    if strip.width == 0 || strip.height == 0 || group.tabs.is_empty() {
        return (Vec::new(), 0, group.tabs.len());
    }
    let widths: Vec<u16> = group
        .tabs
        .iter()
        .map(|t| {
            let w = UnicodeWidthStr::width(t.title.as_str()).saturating_add(4);
            u16::try_from(w).unwrap_or(u16::MAX).min(max_cells.max(4))
        })
        .collect();
    let active = group.active.unwrap_or(0);
    let mut start = 0;
    while start < active
        && widths[start..=active]
            .iter()
            .map(|w| u32::from(*w))
            .sum::<u32>()
            > u32::from(strip.width)
    {
        start += 1;
    }
    let mut tabs = Vec::new();
    let mut x = strip.x;
    let mut end = start;
    for (i, tab) in group.tabs.iter().enumerate().skip(start) {
        let room = strip.right() - x;
        let w = widths[i];
        let w = if i == active && w > room { room } else { w };
        if w > room || w == 0 {
            break;
        }
        let close = if w >= 3 {
            Rect::new(x + w - 2, strip.y, 1, 1)
        } else {
            Rect::ZERO
        };
        tabs.push(TabFrame {
            panel: tab.panel.clone(),
            rect: Rect::new(x, strip.y, w, 1),
            close,
            active: Some(i) == group.active,
            unavailable: tab.unavailable,
        });
        x += w;
        end = i + 1;
    }
    (tabs, start, group.tabs.len() - end)
}

struct Ctx<'a> {
    dock: &'a Dock,
    m: CellMetrics,
    /// Groups that take no part in tiling (hidden, or collapsed to a drawer).
    excluded: BTreeSet<GroupId>,
}

impl Ctx<'_> {
    fn visible(&self, id: GroupId) -> bool {
        self.dock.groups.contains_key(&id) && !self.excluded.contains(&id)
    }

    fn any_visible(&self, node: &Node) -> bool {
        match node {
            Node::Pane(id) => self.visible(*id),
            Node::Split { first, second, .. } => {
                self.any_visible(first) || self.any_visible(second)
            }
        }
    }

    /// Smallest width of a group, in cells. `fit` asks what the group needs
    /// to be shown at its preferred size; otherwise it is the hard minimum
    /// enforced when resizing.
    fn min_width(&self, id: GroupId, fit: bool) -> u16 {
        let cfg = &self.dock.cfg;
        let g = &self.dock.groups[&id];
        let px = match g.role {
            Role::Files if fit => g
                .pinned_px
                .map_or(cfg.files_min_px, |p| p.max(cfg.files_min_px)),
            Role::Files => cfg.files_min_px,
            Role::Main => cfg.main_min_px,
            Role::Tools => cfg.tools_min_px,
        };
        self.m.cols_ceil(px)
    }

    fn min_extent(&self, node: &Node, horizontal: bool, fit: bool) -> u32 {
        match node {
            Node::Pane(id) if self.visible(*id) => {
                if horizontal {
                    u32::from(self.min_width(*id, fit))
                } else {
                    u32::from(self.dock.cfg.min_rows)
                }
            }
            Node::Pane(_) => 0,
            Node::Split {
                direction,
                first,
                second,
                ..
            } => {
                let (vf, vs) = (self.any_visible(first), self.any_visible(second));
                let a = self.min_extent(first, horizontal, fit);
                let b = self.min_extent(second, horizontal, fit);
                match (vf, vs) {
                    (true, true) if (*direction == Direction::Horizontal) == horizontal => {
                        a + u32::from(GUTTER) + b
                    }
                    (true, true) => a.max(b),
                    (true, false) => a,
                    (false, true) => b,
                    (false, false) => 0,
                }
            }
        }
    }

    fn fits(&self, area: Rect) -> bool {
        let root = self.dock.layout.root();
        self.any_visible(root)
            && self.min_extent(root, true, true) <= u32::from(area.width)
            && self.min_extent(root, false, true) <= u32::from(area.height)
    }

    /// Share `area` among the visible leaves of `node`. Children of a split
    /// get their cells and a gutter; the sum is exactly the area.
    fn place(
        &self,
        node: &Node,
        area: Rect,
        path: &mut Vec<bool>,
        groups: &mut Vec<(GroupId, Rect)>,
        splitters: &mut Vec<SplitterFrame>,
    ) {
        match node {
            Node::Pane(id) => {
                if self.visible(*id) {
                    groups.push((*id, area));
                }
            }
            Node::Split {
                direction,
                ratio,
                first,
                second,
            } => {
                let (vf, vs) = (self.any_visible(first), self.any_visible(second));
                if !(vf && vs) {
                    let only = if vf { first } else { second };
                    if vf || vs {
                        path.push(!vf);
                        self.place(only, area, path, groups, splitters);
                        path.pop();
                    }
                    return;
                }
                let horizontal = *direction == Direction::Horizontal;
                let total = if horizontal { area.width } else { area.height };
                let avail = total.saturating_sub(GUTTER);
                let min_first = self
                    .min_extent(first, horizontal, false)
                    .min(u32::from(u16::MAX)) as u16;
                let min_second = self
                    .min_extent(second, horizontal, false)
                    .min(u32::from(u16::MAX)) as u16;
                let ratio_len = (f32::from(avail) * ratio).round() as u16;
                let want = if horizontal {
                    match (self.pin(first), self.pin(second)) {
                        (Some(px), _) => self.m.cols_round(px),
                        (None, Some(px)) => avail.saturating_sub(self.m.cols_round(px)),
                        (None, None) => ratio_len,
                    }
                } else {
                    ratio_len
                };
                let lo = min_first.min(avail);
                let hi = avail.saturating_sub(min_second).max(lo);
                let first_len = want.clamp(lo, hi);
                let second_len = avail - first_len;
                let (a, gutter, b) = if horizontal {
                    (
                        Rect::new(area.x, area.y, first_len, area.height),
                        Rect::new(area.x + first_len, area.y, GUTTER.min(total), area.height),
                        Rect::new(area.x + first_len + GUTTER, area.y, second_len, area.height),
                    )
                } else {
                    (
                        Rect::new(area.x, area.y, area.width, first_len),
                        Rect::new(area.x, area.y + first_len, area.width, GUTTER.min(total)),
                        Rect::new(area.x, area.y + first_len + GUTTER, area.width, second_len),
                    )
                };
                splitters.push(SplitterFrame {
                    path: path.clone(),
                    direction: *direction,
                    rect: gutter,
                    hit: self.hit_rect(gutter, area, horizontal),
                    area,
                    first_len,
                    available: avail,
                    min_first,
                    min_second,
                });
                path.push(false);
                self.place(first, a, path, groups, splitters);
                path.pop();
                path.push(true);
                self.place(second, b, path, groups, splitters);
                path.pop();
            }
        }
    }

    /// Preferred width of a visible leaf that has a pixel target.
    fn pin(&self, node: &Node) -> Option<f32> {
        match node {
            Node::Pane(id) if self.visible(*id) => self.dock.groups[id].pinned_px,
            _ => None,
        }
    }

    /// The gutter widened (about its centre) to the configured hit size.
    fn hit_rect(&self, gutter: Rect, area: Rect, horizontal: bool) -> Rect {
        let cfg = &self.dock.cfg;
        let want = if horizontal {
            self.m.cols_ceil(cfg.splitter_hit_px)
        } else {
            self.m.rows_ceil(cfg.splitter_hit_px)
        };
        let extra = want.saturating_sub(GUTTER);
        let before = extra / 2;
        let wide = if horizontal {
            let x = gutter.x.saturating_sub(before);
            Rect::new(x, gutter.y, GUTTER + extra, gutter.height)
        } else {
            let y = gutter.y.saturating_sub(before);
            Rect::new(gutter.x, y, gutter.width, GUTTER + extra)
        };
        wide.intersection(area)
    }
}
