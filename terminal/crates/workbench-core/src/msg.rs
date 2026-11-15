//! The closed set of messages `update` accepts (ARCHITECTURE section 3).

use keybinds::{KeyInput, Mods};
use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};
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

/// Everything the host sends in: the answer to an effect, or an event that has
/// no effect behind it. One tagged type, so the wasm boundary parses one JSON
/// shape: `{"channel": "completion", ...completion}` or
/// `{"channel": "host", "type": "documentChanged", ...}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "channel", rename_all = "camelCase")]
pub enum Inbound {
    Completion(Completion),
    Host(HostMessage),
}

impl From<Completion> for Inbound {
    fn from(completion: Completion) -> Self {
        Self::Completion(completion)
    }
}

impl From<HostMessage> for Inbound {
    fn from(message: HostMessage) -> Self {
        Self::Host(message)
    }
}

impl From<Inbound> for Msg {
    fn from(inbound: Inbound) -> Self {
        match inbound {
            Inbound::Completion(completion) => Msg::Completion(completion),
            Inbound::Host(message) => Msg::Host(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::completion::Outcome;
    use crate::ids::{EffectId, ResourceRef, Revision};
    use serde_json::json;

    #[test]
    fn inbound_is_told_apart_by_its_channel_tag() {
        let completion = Completion::new(EffectId(3), ResourceRef::None, Outcome::Accepted);
        let value = serde_json::to_value(Inbound::from(completion.clone())).unwrap();
        assert_eq!(
            value,
            json!({
                "channel": "completion", "effect": 3,
                "resource": {"type": "none"}, "outcome": {"status": "accepted"}
            })
        );
        assert_eq!(
            serde_json::from_value::<Inbound>(value).unwrap(),
            Inbound::Completion(completion.clone())
        );

        let host = HostMessage::DocumentSaved {
            resource: ResourceRef::None,
            revision: Revision::Seq(1),
        };
        let value = serde_json::to_value(Inbound::from(host.clone())).unwrap();
        assert_eq!(value["channel"], "host");
        assert_eq!(value["type"], "documentSaved");
        let back = serde_json::from_value::<Inbound>(value).unwrap();
        assert_eq!(back, Inbound::Host(host.clone()));

        assert_eq!(Msg::from(back), Msg::Host(host));
        assert_eq!(
            Msg::from(Inbound::Completion(completion.clone())),
            Msg::Completion(completion)
        );
        // Neither channel word is a message by itself.
        assert!(serde_json::from_value::<Inbound>(json!({"type": "documentSaved"})).is_err());
    }
}
