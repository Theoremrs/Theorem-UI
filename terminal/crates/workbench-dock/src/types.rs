//! Identities, configuration and errors shared by the dock.

use serde::{Deserialize, Serialize};

/// A layout leaf: one tab group. Allocated by the dock's own layout instance and
/// stable across save and restore.
pub use theorem_workbench_layout::PaneId as GroupId;
pub use theorem_workbench_layout::{LayoutError, NavDirection};

/// Identity of one open panel instance. Opaque and caller-supplied: the dock
/// never invents or interprets it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PanelId(pub String);

impl From<&str> for PanelId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// The registry kind a panel was opened as, with its descriptor version.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PanelKind {
    pub name: String,
    pub version: u32,
}

impl PanelKind {
    pub fn new(name: &str, version: u32) -> Self {
        Self {
            name: name.to_owned(),
            version,
        }
    }
}

/// One tab. `view_state` is opaque to the dock and is stored as given.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tab {
    pub panel: PanelId,
    pub kind: PanelKind,
    pub title: String,
    #[serde(default)]
    pub view_state: serde_json::Value,
    /// Set on restore when the caller does not know `kind`. Never saved: the
    /// tab keeps its kind and state so a later build that knows it can use them.
    #[serde(skip)]
    pub unavailable: bool,
}

impl Tab {
    pub fn new(panel: &str, kind: PanelKind, title: &str) -> Self {
        Self {
            panel: panel.into(),
            kind,
            title: title.to_owned(),
            view_state: serde_json::Value::Null,
            unavailable: false,
        }
    }
}

/// What a group is for. Roles carry the width targets and minimums.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Files,
    Main,
    Tools,
}

/// Pixel targets from the spec (4.2) and the cell metric of the mounted grid.
/// Device-local: it is not part of the saved document.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DockConfig {
    pub files_px: f32,
    pub files_min_px: f32,
    pub main_min_px: f32,
    pub tools_min_px: f32,
    pub splitter_hit_px: f32,
    /// Main to tools share of the remainder in the default preset (2.0 means 2:1).
    pub main_to_tools: f32,
    /// Fewest rows a group needs (tab strip plus a little body).
    pub min_rows: u16,
    /// Longest a tab label may be, in cells, close button included.
    pub max_tab_cells: u16,
}

impl Default for DockConfig {
    fn default() -> Self {
        Self {
            files_px: 224.0,
            files_min_px: 160.0,
            main_min_px: 480.0,
            tools_min_px: 320.0,
            splitter_hit_px: 8.0,
            main_to_tools: 2.0,
            min_rows: 4,
            max_tab_cells: 24,
        }
    }
}

/// Size of one terminal cell in CSS pixels. Fractional values are fine.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellMetrics {
    pub width_px: f32,
    pub height_px: f32,
}

impl CellMetrics {
    pub fn new(width_px: f32, height_px: f32) -> Self {
        Self {
            width_px,
            height_px,
        }
    }

    /// Non-positive or non-finite metrics are replaced so geometry stays total.
    pub(crate) fn sane(self) -> Self {
        let fix = |v: f32| if v.is_finite() && v > 0.0 { v } else { 1.0 };
        Self::new(fix(self.width_px), fix(self.height_px))
    }

    /// Whole cells nearest to `px` across, at least one.
    pub(crate) fn cols_round(self, px: f32) -> u16 {
        ((px / self.width_px).round().max(1.0)).min(f32::from(u16::MAX)) as u16
    }

    /// Whole cells covering `px` across, at least one.
    pub(crate) fn cols_ceil(self, px: f32) -> u16 {
        ((px / self.width_px).ceil().max(1.0)).min(f32::from(u16::MAX)) as u16
    }

    pub(crate) fn rows_ceil(self, px: f32) -> u16 {
        ((px / self.height_px).ceil().max(1.0)).min(f32::from(u16::MAX)) as u16
    }
}

/// Where `open_panel` puts a tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAt {
    /// A new tab in an existing group (shown again if it was hidden).
    Group(GroupId),
    /// A new group beside `group`. `role` defaults to the role of `group`.
    Split {
        group: GroupId,
        side: NavDirection,
        role: Option<Role>,
    },
}

/// Why an operation was refused. The dock is left unchanged.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DockError {
    #[error("no such group {0:?}")]
    UnknownGroup(GroupId),
    #[error("no such panel {0:?}")]
    UnknownPanel(PanelId),
    #[error("panel {0:?} is already open")]
    DuplicatePanel(PanelId),
    #[error("the last panel cannot be closed")]
    LastPanel,
    #[error("the last visible group cannot be hidden")]
    LastVisibleGroup,
    #[error("group {0:?} is hidden")]
    GroupHidden(GroupId),
    #[error("a tab cannot be moved onto its own group's only tab")]
    InvalidMove,
    #[error("tab index {index} is out of range for {len} tabs")]
    IndexOutOfRange { index: usize, len: usize },
    #[error("no split at that path in the current arrangement")]
    UnknownSplit,
    #[error("no splitter on the {0:?} edge of the group")]
    NoSplitter(NavDirection),
    #[error("no group lies {0:?} of the focused group")]
    NoNeighbour(NavDirection),
    /// The move would take a side below its minimum. `allowed` is the largest
    /// delta, in cells and with the same sign, that would be accepted.
    #[error("resize would go below a minimum size; at most {allowed} cells are allowed")]
    BelowMinimum { allowed: i32 },
}

/// Why a saved document was refused.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RestoreError {
    #[error("unknown schema {0:?}")]
    UnknownSchema(String),
    #[error("schema version {found} is not supported (this build reads {supported})")]
    UnsupportedVersion { found: u32, supported: u32 },
    #[error("layout tree is malformed: {0}")]
    Layout(#[from] LayoutError),
    #[error("leaf {0:?} has no group entry")]
    MissingGroup(GroupId),
    #[error("group entry {0:?} is not a leaf of the tree")]
    OrphanGroup(GroupId),
    #[error("panel {0:?} appears in more than one tab")]
    DuplicatePanel(PanelId),
}
