//! The two panels the root itself provides: the placeholder for a kind it
//! cannot build, and the tool picker's body.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::Value;

use crate::panel::{Ctx, Panel, PanelMsg, ViewCtx};
use crate::registry::Availability;
use crate::semantics::{Node, NodeAction, Role};

pub const PICKER_KIND: &str = "picker";

/// Stands in for a panel this build cannot serve: unknown kind, a version
/// newer than this build's, or no constructor. It draws the reason and keeps
/// the saved state byte for byte, so a later build that serves the kind can use
/// it.
pub struct Unavailable {
    kind: String,
    reason: String,
    state: Value,
}

impl Unavailable {
    pub fn new(kind: &str, reason: String, state: Value) -> Self {
        Self {
            kind: kind.to_owned(),
            reason,
            state,
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl Panel for Unavailable {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        if area.is_empty() {
            return;
        }
        let w = usize::from(area.width);
        buf.set_stringn(
            area.x,
            area.y,
            format!("{} is unavailable", self.kind),
            w,
            cx.theme.text,
        );
        if area.height > 1 {
            buf.set_stringn(area.x, area.y + 1, &self.reason, w, cx.theme.muted);
        }
    }

    fn semantics(&self, area: Rect, _cx: &ViewCtx) -> Vec<Node> {
        let mut node = Node::new(
            "unavailable",
            Role::Status,
            &format!("{} is unavailable", self.kind),
            area,
        );
        node.state.disabled = true;
        node.state.description = Some(self.reason.clone());
        vec![node]
    }

    fn serialize(&self) -> Value {
        self.state.clone()
    }
}

/// The picker's body. The picker's state lives in the root's model (it is the
/// modal layer for keys); this panel only draws the rows it is given and names
/// them in the semantic tree.
pub struct PickerPanel;

impl Panel for PickerPanel {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        if area.is_empty() {
            return;
        }
        let w = usize::from(area.width);
        let Some(picker) = cx.picker else {
            buf.set_stringn(area.x, area.y, "Choose a tool", w, cx.theme.muted);
            return;
        };
        buf.set_stringn(
            area.x,
            area.y,
            format!("> {}", picker.filter),
            w,
            cx.theme.text,
        );
        for (i, row) in picker.rows.iter().enumerate() {
            let Some(y) = u16::try_from(i + 1)
                .ok()
                .and_then(|o| area.y.checked_add(o))
                .filter(|y| *y < area.bottom())
            else {
                break;
            };
            let style = match (&row.availability, i == picker.selected) {
                (_, true) => cx.theme.selected,
                (Availability::Available, false) => cx.theme.text,
                (Availability::Unavailable { .. }, false) => cx.theme.muted,
            };
            buf.set_stringn(area.x, y, &row.title, w, style);
        }
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let mut root = Node::new("picker", Role::Menu, "Add tool", area);
        let mut nodes = vec![];
        if let Some(picker) = cx.picker {
            for (i, row) in picker.rows.iter().enumerate() {
                let y = area
                    .y
                    .saturating_add(u16::try_from(i + 1).unwrap_or(u16::MAX));
                let rect = Rect::new(area.x, y, area.width, u16::from(y < area.bottom()));
                let mut node = Node::new(&format!("row-{i}"), Role::MenuItem, &row.title, rect);
                node.state.selected = i == picker.selected;
                let (enabled, reason) = match &row.availability {
                    Availability::Available => (true, None),
                    Availability::Unavailable { reason } => (false, Some(reason.clone())),
                };
                node.state.disabled = !enabled;
                node.actions.push(NodeAction {
                    id: row.action.clone(),
                    enabled,
                    reason,
                });
                root.children.push(node.id.clone());
                nodes.push(node);
            }
        }
        nodes.insert(0, root);
        nodes
    }

    fn serialize(&self) -> Value {
        Value::Null
    }
}
