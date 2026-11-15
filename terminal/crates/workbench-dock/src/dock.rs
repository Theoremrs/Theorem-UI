//! The dock model: tab groups over a split tree, and every operation on them.
//!
//! Each layout leaf is a group (a tab strip over a body). Operations return a
//! typed result and leave the dock untouched when they refuse.

use std::collections::BTreeMap;

use ratatui::layout::{Direction, Rect};
use theorem_workbench_layout::{MAX_RATIO, MIN_RATIO, PaneInfo, TileLayout, find_in_direction};

use crate::types::*;

/// One tab group.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub(crate) role: Role,
    pub(crate) tabs: Vec<Tab>,
    pub(crate) active: Option<usize>,
    pub(crate) hidden: bool,
    /// Made empty on purpose (`split_empty`): it is shown with no tabs. Any
    /// other empty tool group is not shown at all.
    pub(crate) keep_empty: bool,
    /// Preferred width in CSS px while the group is a direct child of a
    /// horizontal split. Dragging its splitter turns it into a plain ratio.
    pub(crate) pinned_px: Option<f32>,
}

impl Group {
    pub(crate) fn new(role: Role, pinned_px: Option<f32>) -> Self {
        Self {
            role,
            tabs: Vec::new(),
            active: None,
            hidden: false,
            keep_empty: false,
            pinned_px,
        }
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn active(&self) -> Option<&Tab> {
        self.active.map(|i| &self.tabs[i])
    }

    pub fn is_hidden(&self) -> bool {
        self.hidden
    }

    /// Whether it was made empty on purpose, and so is shown with no tabs.
    pub fn keeps_empty(&self) -> bool {
        self.keep_empty
    }

    pub fn pinned_px(&self) -> Option<f32> {
        self.pinned_px
    }
}

/// Starting arrangements. All three regions always exist, so panels stay put
/// and hiding or showing a region is a flag, not a rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    /// Files | main | tools, main to tools 2:1.
    Default,
    /// Files and a wide main; tools hidden.
    EditorCentered,
    /// A wide main (3:1) with tools beside it; Files hidden.
    AgentCentered,
    /// Main alone.
    Minimal,
}

/// The groups a preset created, by role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Regions {
    pub files: GroupId,
    pub main: GroupId,
    pub tools: GroupId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Dock {
    pub(crate) cfg: DockConfig,
    pub(crate) layout: TileLayout,
    pub(crate) groups: BTreeMap<GroupId, Group>,
    pub(crate) maximized: Option<GroupId>,
    pub(crate) drawer: Option<GroupId>,
}

impl Dock {
    /// A dock with one empty group.
    pub fn new(cfg: DockConfig, role: Role) -> (Self, GroupId) {
        let (layout, id) = TileLayout::new();
        let mut groups = BTreeMap::new();
        groups.insert(id, Group::new(role, None));
        let dock = Self {
            cfg,
            layout,
            groups,
            maximized: None,
            drawer: None,
        };
        (dock, id)
    }

    /// A dock arranged as `preset`, with empty groups.
    pub fn from_preset(cfg: DockConfig, preset: Preset) -> (Self, Regions) {
        let main_share = match preset {
            Preset::AgentCentered => 3.0,
            _ => cfg.main_to_tools,
        };
        let (mut layout, files) = TileLayout::new();
        // Files | (main | tools). The Files ratio only applies once its pixel
        // target is dropped by a drag.
        let main = layout
            .split_pane(files, Direction::Horizontal, 0.2)
            .expect("root exists");
        let tools = layout
            .split_pane(main, Direction::Horizontal, main_share / (1.0 + main_share))
            .expect("main exists");
        layout.focus_pane(main);
        let mut groups = BTreeMap::new();
        groups.insert(files, Group::new(Role::Files, Some(cfg.files_px)));
        groups.insert(main, Group::new(Role::Main, None));
        groups.insert(tools, Group::new(Role::Tools, None));
        match preset {
            Preset::Default => {}
            Preset::EditorCentered => groups.get_mut(&tools).expect("tools").hidden = true,
            Preset::AgentCentered => groups.get_mut(&files).expect("files").hidden = true,
            Preset::Minimal => {
                groups.get_mut(&files).expect("files").hidden = true;
                groups.get_mut(&tools).expect("tools").hidden = true;
            }
        }
        let dock = Self {
            cfg,
            layout,
            groups,
            maximized: None,
            drawer: None,
        };
        (dock, Regions { files, main, tools })
    }

    pub fn config(&self) -> &DockConfig {
        &self.cfg
    }

    pub fn group(&self, id: GroupId) -> Option<&Group> {
        self.groups.get(&id)
    }

    /// Group ids in tree order (left to right, top to bottom).
    pub fn group_ids(&self) -> Vec<GroupId> {
        self.layout.pane_ids()
    }

    pub fn focused(&self) -> GroupId {
        self.layout.focused()
    }

    pub fn maximized(&self) -> Option<GroupId> {
        self.maximized
    }

    pub fn drawer(&self) -> Option<GroupId> {
        self.drawer
    }

    pub fn find_panel(&self, panel: &PanelId) -> Option<GroupId> {
        self.groups
            .iter()
            .find(|(_, g)| g.tabs.iter().any(|t| &t.panel == panel))
            .map(|(id, _)| *id)
    }

    // --- opening, closing, moving tabs ---

    /// Open a tab in an existing group or in a new split. The tab becomes
    /// active, its group is shown and focused. Opening starts nothing: the
    /// dock only holds the panel's identity.
    pub fn open_panel(&mut self, tab: Tab, at: OpenAt) -> Result<GroupId, DockError> {
        if self.find_panel(&tab.panel).is_some() {
            return Err(DockError::DuplicatePanel(tab.panel));
        }
        let group = match at {
            OpenAt::Group(g) => {
                self.group_ref(g)?;
                g
            }
            OpenAt::Split { group, side, role } => self.split_group(group, side, role)?,
        };
        self.insert_tab(group, tab, None);
        self.reveal(group);
        Ok(group)
    }

    /// An empty group beside `group`, kept on show while it has no tabs: a
    /// destination someone asked for.
    pub fn split_empty(
        &mut self,
        group: GroupId,
        side: NavDirection,
        role: Option<Role>,
    ) -> Result<GroupId, DockError> {
        let id = self.split_group(group, side, role)?;
        if let Some(g) = self.groups.get_mut(&id) {
            g.keep_empty = true;
        }
        Ok(id)
    }

    /// Rename a tab. The strip measures tabs from their titles, so the next
    /// solve lays this one out at the new width and the tabs after it move
    /// with it; whatever no longer fits overflows as it always does. Returns
    /// whether the title changed (false for an unknown panel or the same title).
    pub fn set_tab_title(&mut self, panel: &PanelId, title: &str) -> bool {
        let Some(tab) = self
            .groups
            .values_mut()
            .flat_map(|g| g.tabs.iter_mut())
            .find(|t| &t.panel == panel)
        else {
            return false;
        };
        if tab.title == title {
            return false;
        }
        title.clone_into(&mut tab.title);
        true
    }

    /// Give `panel`'s tab another kind (and title), keeping its place, group
    /// and focus: a panel shown another way. It is no longer marked
    /// unavailable. Returns false for an unknown panel.
    pub fn set_tab_kind(&mut self, panel: &PanelId, kind: PanelKind, title: &str) -> bool {
        let Some(tab) = self
            .groups
            .values_mut()
            .flat_map(|g| g.tabs.iter_mut())
            .find(|t| &t.panel == panel)
        else {
            return false;
        };
        tab.kind = kind;
        title.clone_into(&mut tab.title);
        tab.unavailable = false;
        true
    }

    /// Focus the group holding `panel` and make it the active tab.
    pub fn focus_panel(&mut self, panel: &PanelId) -> Result<GroupId, DockError> {
        let g = self
            .find_panel(panel)
            .ok_or_else(|| DockError::UnknownPanel(panel.clone()))?;
        let grp = self.groups.get_mut(&g).expect("found");
        grp.active = grp.tabs.iter().position(|t| &t.panel == panel);
        self.reveal(g);
        Ok(g)
    }

    /// Focus a visible group. Leaves maximize if another group was maximized.
    pub fn focus_group(&mut self, group: GroupId) -> Result<(), DockError> {
        if self.group_ref(group)?.hidden {
            return Err(DockError::GroupHidden(group));
        }
        self.layout.focus_pane(group);
        if self.maximized.is_some_and(|m| m != group) {
            self.maximized = None;
        }
        Ok(())
    }

    /// Close a tab. Closing the last tab of a group removes the group, unless
    /// it is the dock's only group (then `LastPanel`). Returns whether the
    /// group was removed.
    pub fn close_tab(&mut self, panel: &PanelId) -> Result<bool, DockError> {
        let g = self
            .find_panel(panel)
            .ok_or_else(|| DockError::UnknownPanel(panel.clone()))?;
        let only_tab = self.groups[&g].tabs.len() == 1;
        if only_tab && self.groups.len() == 1 {
            return Err(DockError::LastPanel);
        }
        let others_visible = self.groups.iter().any(|(id, grp)| *id != g && !grp.hidden);
        if only_tab && !others_visible {
            return Err(DockError::LastVisibleGroup);
        }
        self.take_tab(panel);
        if only_tab {
            self.remove_group(g);
        }
        Ok(only_tab)
    }

    /// Move a tab to `to`, at `index` (or the end). Moving within a group
    /// reorders. A group left empty is removed.
    pub fn move_tab(
        &mut self,
        panel: &PanelId,
        to: GroupId,
        index: Option<usize>,
    ) -> Result<(), DockError> {
        let from = self
            .find_panel(panel)
            .ok_or_else(|| DockError::UnknownPanel(panel.clone()))?;
        self.group_ref(to)?;
        if from == to {
            let target = index.unwrap_or(self.groups[&to].tabs.len() - 1);
            return self.reorder_tab(panel, target);
        }
        if let Some(i) = index {
            let len = self.groups[&to].tabs.len();
            if i > len {
                return Err(DockError::IndexOutOfRange { index: i, len });
            }
        }
        let tab = self.take_tab(panel);
        self.insert_tab(to, tab, index);
        if self.groups[&from].tabs.is_empty() {
            self.remove_group(from);
        }
        self.reveal(to);
        Ok(())
    }

    /// Move a tab into a new group beside `target`. Returns the new group.
    pub fn move_tab_to_split(
        &mut self,
        panel: &PanelId,
        target: GroupId,
        side: NavDirection,
    ) -> Result<GroupId, DockError> {
        let from = self
            .find_panel(panel)
            .ok_or_else(|| DockError::UnknownPanel(panel.clone()))?;
        self.group_ref(target)?;
        if from == target && self.groups[&from].tabs.len() == 1 {
            return Err(DockError::InvalidMove);
        }
        let new = self.split_group(target, side, None)?;
        let tab = self.take_tab(panel);
        self.insert_tab(new, tab, None);
        if self.groups[&from].tabs.is_empty() {
            self.remove_group(from);
        }
        self.reveal(new);
        Ok(new)
    }

    /// Put a tab at `index` within its own group.
    pub fn reorder_tab(&mut self, panel: &PanelId, index: usize) -> Result<(), DockError> {
        let g = self
            .find_panel(panel)
            .ok_or_else(|| DockError::UnknownPanel(panel.clone()))?;
        let grp = self.groups.get_mut(&g).expect("found");
        let len = grp.tabs.len();
        if index >= len {
            return Err(DockError::IndexOutOfRange { index, len });
        }
        let active = grp.active.map(|i| grp.tabs[i].panel.clone());
        let from = grp
            .tabs
            .iter()
            .position(|t| &t.panel == panel)
            .expect("found");
        let tab = grp.tabs.remove(from);
        grp.tabs.insert(index, tab);
        grp.active = active.and_then(|p| grp.tabs.iter().position(|t| t.panel == p));
        Ok(())
    }

    // --- visibility ---

    pub fn maximize(&mut self, group: GroupId) -> Result<(), DockError> {
        if self.group_ref(group)?.hidden {
            return Err(DockError::GroupHidden(group));
        }
        self.maximized = Some(group);
        self.layout.focus_pane(group);
        Ok(())
    }

    /// Leave maximize. Returns whether a group was maximized.
    pub fn unmaximize(&mut self) -> bool {
        self.maximized.take().is_some()
    }

    pub fn hide_group(&mut self, group: GroupId) -> Result<(), DockError> {
        if self.group_ref(group)?.hidden {
            return Ok(());
        }
        if self.groups.values().filter(|g| !g.hidden).count() == 1 {
            return Err(DockError::LastVisibleGroup);
        }
        self.groups.get_mut(&group).expect("checked").hidden = true;
        self.prune();
        Ok(())
    }

    pub fn show_group(&mut self, group: GroupId) -> Result<(), DockError> {
        self.group_mut(group)?.hidden = false;
        Ok(())
    }

    /// Open a collapsed group (normally Files) as a drawer over the content.
    /// It only draws while the dock has collapsed that group.
    pub fn open_drawer(&mut self, group: GroupId) -> Result<(), DockError> {
        if self.group_ref(group)?.hidden {
            return Err(DockError::GroupHidden(group));
        }
        self.drawer = Some(group);
        self.layout.focus_pane(group);
        Ok(())
    }

    pub fn close_drawer(&mut self) {
        self.drawer = None;
    }

    // --- focus and resize, which need geometry ---

    /// Move focus to the nearest visible group in `dir` as drawn in `area`.
    pub fn focus_direction(
        &mut self,
        dir: NavDirection,
        area: Rect,
        metrics: CellMetrics,
    ) -> Result<GroupId, DockError> {
        let frame = self.solve(area, metrics);
        let panes: Vec<PaneInfo> = frame
            .groups
            .iter()
            .map(|g| PaneInfo {
                id: g.id,
                rect: g.rect,
                inner_rect: g.rect,
                scrollbar_rect: None,
                borders: ratatui::widgets::Borders::NONE,
                is_focused: g.focused,
            })
            .collect();
        let from = panes
            .iter()
            .find(|p| p.is_focused)
            .ok_or(DockError::NoNeighbour(dir))?;
        let to = find_in_direction(from, dir, &panes).ok_or(DockError::NoNeighbour(dir))?;
        self.layout.focus_pane(to);
        Ok(to)
    }

    /// Move a splitter by `delta` cells (positive grows the first child).
    /// `path` names the split, as in `SplitterFrame::path`. Refuses a move that
    /// would take either side below its minimum.
    pub fn resize_split(
        &mut self,
        path: &[bool],
        delta: i32,
        area: Rect,
        metrics: CellMetrics,
    ) -> Result<(), DockError> {
        let frame = self.solve(area, metrics);
        let s = frame
            .splitters
            .iter()
            .find(|s| s.path == path)
            .ok_or(DockError::UnknownSplit)?;
        let avail = i32::from(s.available);
        let cur = i32::from(s.first_len);
        let lo =
            i32::from(s.min_first.min(s.available)).max((avail as f32 * MIN_RATIO).ceil() as i32);
        let hi = (avail - i32::from(s.min_second))
            .min((avail as f32 * MAX_RATIO).floor() as i32)
            .max(lo);
        let target = cur + delta;
        if target < lo || target > hi {
            let allowed = if delta > 0 { hi - cur } else { lo - cur };
            return Err(DockError::BelowMinimum { allowed });
        }
        let ratio = target as f32 / avail as f32;
        self.layout.set_ratio_at(path, ratio);
        // The user has chosen a size: drop the pixel targets on this split.
        for step in [false, true] {
            let mut p = path.to_vec();
            p.push(step);
            if let Some(id) = self.leaf_at(&p) {
                self.groups.get_mut(&id).expect("leaf").pinned_px = None;
            }
        }
        Ok(())
    }

    /// Grow `group` by `grow` cells on its `edge` (negative shrinks), by moving
    /// the splitter on that edge.
    pub fn resize_group_edge(
        &mut self,
        group: GroupId,
        edge: NavDirection,
        grow: i32,
        area: Rect,
        metrics: CellMetrics,
    ) -> Result<(), DockError> {
        let frame = self.solve(area, metrics);
        let g = frame
            .group(group)
            .ok_or(DockError::UnknownGroup(group))?
            .rect;
        let s = frame
            .splitters
            .iter()
            .find(|s| {
                let r = s.rect;
                match edge {
                    NavDirection::Right => {
                        r.x == g.right() && overlaps(r.y, r.bottom(), g.y, g.bottom())
                    }
                    NavDirection::Left => {
                        r.right() == g.x && overlaps(r.y, r.bottom(), g.y, g.bottom())
                    }
                    NavDirection::Down => {
                        r.y == g.bottom() && overlaps(r.x, r.right(), g.x, g.right())
                    }
                    NavDirection::Up => {
                        r.bottom() == g.y && overlaps(r.x, r.right(), g.x, g.right())
                    }
                }
            })
            .ok_or(DockError::NoSplitter(edge))?;
        let delta = match edge {
            NavDirection::Right | NavDirection::Down => grow,
            NavDirection::Left | NavDirection::Up => -grow,
        };
        let path = s.path.clone();
        match self.resize_split(&path, delta, area, metrics) {
            Err(DockError::BelowMinimum { allowed }) => Err(DockError::BelowMinimum {
                allowed: match edge {
                    NavDirection::Right | NavDirection::Down => allowed,
                    NavDirection::Left | NavDirection::Up => -allowed,
                },
            }),
            other => other,
        }
    }

    // --- internals ---

    fn group_ref(&self, id: GroupId) -> Result<&Group, DockError> {
        self.groups.get(&id).ok_or(DockError::UnknownGroup(id))
    }

    fn group_mut(&mut self, id: GroupId) -> Result<&mut Group, DockError> {
        self.groups.get_mut(&id).ok_or(DockError::UnknownGroup(id))
    }

    /// Show a group, make it focused, and leave maximize for another group.
    fn reveal(&mut self, group: GroupId) {
        self.groups.get_mut(&group).expect("group exists").hidden = false;
        self.layout.focus_pane(group);
        if self.maximized.is_some_and(|m| m != group) {
            self.maximized = None;
        }
    }

    fn insert_tab(&mut self, group: GroupId, tab: Tab, index: Option<usize>) {
        let grp = self.groups.get_mut(&group).expect("group exists");
        let at = index.unwrap_or(grp.tabs.len()).min(grp.tabs.len());
        grp.tabs.insert(at, tab);
        grp.active = Some(at);
    }

    /// Remove a tab from its group (which may be left empty) and fix `active`.
    fn take_tab(&mut self, panel: &PanelId) -> Tab {
        let g = self.find_panel(panel).expect("panel exists");
        let grp = self.groups.get_mut(&g).expect("found");
        let i = grp
            .tabs
            .iter()
            .position(|t| &t.panel == panel)
            .expect("found");
        let tab = grp.tabs.remove(i);
        grp.active = match grp.active {
            _ if grp.tabs.is_empty() => None,
            Some(a) if a == i => Some(i.min(grp.tabs.len() - 1)),
            Some(a) if a > i => Some(a - 1),
            other => other,
        };
        tab
    }

    /// Remove a (normally empty) group from the tree. The caller has checked
    /// that another group remains.
    fn remove_group(&mut self, group: GroupId) {
        self.layout.close_pane(group);
        self.groups.remove(&group);
        self.prune();
    }

    /// Drop references to groups that are gone or hidden, and keep focus on a
    /// visible group.
    fn prune(&mut self) {
        let visible = |d: &Self, id: GroupId| d.groups.get(&id).is_some_and(|g| !g.hidden);
        if self.maximized.is_some_and(|m| !visible(self, m)) {
            self.maximized = None;
        }
        if self.drawer.is_some_and(|d| !visible(self, d)) {
            self.drawer = None;
        }
        if !visible(self, self.layout.focused())
            && let Some(v) = self
                .layout
                .pane_ids()
                .into_iter()
                .find(|id| visible(self, *id))
        {
            self.layout.focus_pane(v);
        }
    }

    /// Split `target` and create the new group on `side` of it.
    fn split_group(
        &mut self,
        target: GroupId,
        side: NavDirection,
        role: Option<Role>,
    ) -> Result<GroupId, DockError> {
        let role = role.unwrap_or(self.group_ref(target)?.role);
        let horizontal = matches!(side, NavDirection::Left | NavDirection::Right);
        let direction = if horizontal {
            Direction::Horizontal
        } else {
            Direction::Vertical
        };
        let new = self
            .layout
            .split_pane(target, direction, 0.5)
            .ok_or(DockError::UnknownGroup(target))?;
        if matches!(side, NavDirection::Left | NavDirection::Up) {
            self.layout.swap_panes(target, new);
        }
        let pin = (role == Role::Files && horizontal).then_some(self.cfg.files_px);
        self.groups.insert(new, Group::new(role, pin));
        Ok(new)
    }

    /// The group at a tree path, if that node is a leaf.
    fn leaf_at(&self, path: &[bool]) -> Option<GroupId> {
        let mut node = self.layout.root();
        for step in path {
            match node {
                theorem_workbench_layout::Node::Split { first, second, .. } => {
                    node = if *step { second } else { first };
                }
                theorem_workbench_layout::Node::Pane(_) => return None,
            }
        }
        match node {
            theorem_workbench_layout::Node::Pane(id) => Some(*id),
            _ => None,
        }
    }
}

fn overlaps(a0: u16, a1: u16, b0: u16, b1: u16) -> bool {
    a0 < b1 && b0 < a1
}
