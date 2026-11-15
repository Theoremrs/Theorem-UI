//! The closed set of messages `update` accepts (ARCHITECTURE section 3).

use keybinds::{KeyInput, Mods};
use ratatui::layout::Rect;
use theorem_workbench_dock::{CellMetrics, GroupId, NavDirection};

use crate::completion::Completion;
use crate::host::HostMessage;
use crate::ids::{ActionId, Actor, PanelInstanceId};
use crate::panel::PointerKind;
use crate::picker::PickerMsg;

/// A pointer event in whole cells from the grid's top left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pointer {
    pub kind: PointerKind,
    pub x: u16,
    pub y: u16,
    pub mods: Mods,
}

/// Dock operations a person or an adapter can ask for directly. Each is the
/// dock's own operation; none touches a panel's resource.
#[derive(Clone, Debug, PartialEq)]
pub enum DockMsg {
    FocusGroup(GroupId),
    FocusDirection(NavDirection),
    FocusPanel(PanelInstanceId),
    /// Close a view. Never destroys what it showed.
    ClosePanel(PanelInstanceId),
    MoveTab {
        panel: PanelInstanceId,
        to: GroupId,
        index: Option<usize>,
    },
    ReorderTab {
        panel: PanelInstanceId,
        index: usize,
    },
    Maximize(GroupId),
    Unmaximize,
    HideGroup(GroupId),
    ShowGroup(GroupId),
    OpenDrawer(GroupId),
    CloseDrawer,
    /// Move the splitter at `path` by `delta` cells (positive grows the first child).
    ResizeSplit {
        path: Vec<bool>,
        delta: i32,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Msg {
    Key(KeyInput),
    Pointer(Pointer),
    Text(String),
    Paste(String),
    Resize {
        area: Rect,
        metrics: CellMetrics,
    },
    /// The window gained or lost focus.
    Focus(bool),
    Host(HostMessage),
    Completion(Completion),
    Action {
        id: ActionId,
        actor: Actor,
    },
    Picker(PickerMsg),
    Dock(DockMsg),
    Tick,
}
