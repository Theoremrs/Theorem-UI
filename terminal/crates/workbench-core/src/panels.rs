//! The two panels the root itself provides: the placeholder for a kind it
//! cannot build, and the tool picker's body.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use serde_json::Value;

use crate::ids::ActionId;
use crate::panel::{Ctx, Panel, PanelMsg, PickerView, ViewCtx};
use crate::picker_layout::{
    BACK, HEADING_MAIN, HEADING_MORE, Layout, NO_MATCH, PAD, PINNED, UNPINNED, row_text_in,
};
use crate::registry::Availability;
use crate::semantics::{Node, NodeAction, Role};

pub const PICKER_KIND: &str = "picker";
/// The kind the workbench's own actions belong to (focus and move panels,
/// resize, maximise, apply a layout). It is never opened as a panel.
pub const WORKBENCH_KIND: &str = "workbench";

/// The semantic action of the More tools page's back row.
pub const ACTION_BACK: &str = "picker.back";
/// Pin or unpin the selected tool. Registered with a default binding, so a
/// remap changes the key and the hint beside the pin mark.
pub const ACTION_TOGGLE_PIN: &str = "picker.toggle-pin";
/// Prefixes of a tab's focus and close semantic actions; the panel instance id
/// follows (`tab.focus.panel-3`).
pub const ACTION_TAB_FOCUS: &str = "tab.focus.";
pub const ACTION_TAB_CLOSE: &str = "tab.close.";

/// Prefixes of a row's pin and unpin semantic actions; the tool's panel kind
/// follows (`picker.pin.cabinet`).
pub const ACTION_PIN: &str = "picker.pin.";
pub const ACTION_UNPIN: &str = "picker.unpin.";

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
/// modal layer for keys); this panel only draws what it is given, where
/// [`Layout`] puts it, and names it in the semantic tree from the same layout.
pub struct PickerPanel;

fn heading(view: &PickerView) -> &str {
    match (&view.heading, view.more) {
        (Some(heading), _) => heading,
        (None, true) => HEADING_MORE,
        (None, false) => HEADING_MAIN,
    }
}

impl Panel for PickerPanel {
    fn update(&mut self, _msg: PanelMsg, _cx: &mut Ctx) {}

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        if area.is_empty() {
            return;
        }
        let Some(view) = cx.picker else {
            buf.set_stringn(
                area.x,
                area.y,
                "Choose a tool",
                usize::from(area.width),
                cx.theme.muted,
            );
            return;
        };
        let layout = Layout::compute(view, area);
        let text = cx.theme.text.add_modifier(Modifier::BOLD);
        draw(buf, layout.heading, 0, heading(view), text);
        if let Some(back) = layout.back {
            draw(buf, back, PAD, BACK, cx.theme.muted);
        }
        let prompt = match &view.entry {
            Some(label) => format!("{label}: {}", view.filter),
            None => format!("> {}", view.filter),
        };
        draw(buf, layout.filter, 0, &prompt, cx.theme.text);
        if let Some(empty) = layout.empty {
            draw(buf, empty, PAD, NO_MATCH, cx.theme.muted);
        }
        for cell in &layout.cells {
            let row = &view.rows[cell.index];
            let selected = cell.index == view.selected;
            let label = match (&row.availability, selected) {
                (_, true) => cx.theme.selected,
                (Availability::Available, false) => cx.theme.text,
                (Availability::Unavailable { .. }, false) => cx.theme.muted,
            };
            let quiet = if selected {
                cx.theme.selected
            } else {
                cx.theme.muted
            };
            if selected {
                buf.set_style(cell.rect, cx.theme.selected);
            }
            let pin_hint = selected.then_some(view.pin_shortcut.as_deref()).flatten();
            let t = row_text_in(
                row,
                cell.rect.width,
                cell.pin.is_some(),
                pin_hint,
                layout.glyph_w,
            );
            if let Some(g) = &t.glyph {
                draw(buf, cell.rect, t.glyph_at, g, quiet);
            }
            draw(buf, cell.rect, t.label_at, &t.label, label);
            if let Some(q) = &t.qualifier {
                draw(buf, cell.rect, t.qualifier_at, q, quiet);
            }
            if let Some(h) = &t.hint {
                draw(buf, cell.rect, t.hint_at, h, quiet);
            }
            if let Some(h) = &t.pin_hint {
                draw(buf, cell.rect, t.pin_hint_at, h, quiet);
            }
            if let Some(pin) = cell.pin {
                let glyph = if row.pinned { PINNED } else { UNPINNED };
                draw(buf, pin, 0, glyph, quiet);
            }
        }
        if let (Some(rect), Some(reason)) = (layout.reason, &view.reason) {
            // The reason wraps; the layout reserved the lines it needs.
            let at = Rect::new(
                rect.x + PAD.min(rect.width),
                rect.y,
                rect.width.saturating_sub(PAD),
                rect.height,
            );
            Paragraph::new(reason.as_str())
                .style(cx.theme.warning)
                .wrap(Wrap { trim: true })
                .render(at, buf);
        }
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let Some(view) = cx.picker else {
            return vec![Node::new("picker", Role::Menu, "Tools", area)];
        };
        let layout = Layout::compute(view, area);
        let mut root = Node::new("picker", Role::Menu, heading(view), area);
        let mut nodes = vec![];
        let mut add = |root: &mut Node, node: Node| {
            root.children.push(node.id.clone());
            nodes.push(node);
        };
        add(
            &mut root,
            Node::new("heading", Role::Heading, heading(view), layout.heading),
        );
        if let Some(back) = layout.back {
            let mut node = Node::new("back", Role::Button, "Back", back);
            node.actions.push(NodeAction {
                id: ActionId::new(ACTION_BACK),
                enabled: true,
                reason: None,
            });
            add(&mut root, node);
        }
        let label = view.entry.as_deref().unwrap_or("Filter tools");
        let mut filter = Node::new("filter", Role::TextBox, label, layout.filter);
        filter.state.description = Some(view.filter.clone());
        add(&mut root, filter);
        if let Some(empty) = layout.empty {
            add(&mut root, Node::new("empty", Role::Status, NO_MATCH, empty));
        }
        let n = view.rows.len();
        for (i, row) in view.rows.iter().enumerate() {
            let rect = layout
                .cell(i)
                .map_or(Rect::new(area.x, area.bottom(), area.width, 0), |c| c.rect);
            let mut node = Node::new(&format!("row-{i}"), Role::MenuItem, &row.title, rect);
            node.state.selected = i == view.selected;
            node.state.focused = node.state.selected && cx.focused;
            node.pos_in_set = u16::try_from(i + 1).ok();
            node.set_size = u16::try_from(n).ok();
            // A layout row's hint is not a chord: it says applying the row
            // changes the theme, and the node says so in words.
            let themed = row.shortcut.as_deref() == Some(crate::picker::THEME_MARK)
                && row.action.as_str().starts_with(crate::picker::LAYOUT_APPLY);
            node.shortcut = if themed { None } else { row.shortcut.clone() };
            let (enabled, reason) = match &row.availability {
                Availability::Available => (true, None),
                Availability::Unavailable { reason } => (false, Some(reason.clone())),
            };
            node.state.disabled = !enabled;
            node.state.description = reason.clone().or_else(|| {
                if themed {
                    Some("Also applies its saved theme".to_owned())
                } else {
                    row.chooses.qualifier()
                }
            });
            node.actions.push(NodeAction {
                id: row.action.clone(),
                enabled,
                reason,
            });
            if row.pinnable {
                let verb = if row.pinned { ACTION_UNPIN } else { ACTION_PIN };
                node.actions.push(NodeAction {
                    id: ActionId::new(format!("{verb}{}", row.panel.as_str())),
                    enabled: true,
                    reason: None,
                });
            }
            add(&mut root, node);
        }
        if let (Some(rect), Some(reason)) = (layout.reason, &view.reason) {
            add(&mut root, Node::new("reason", Role::Alert, reason, rect));
        }
        nodes.insert(0, root);
        nodes
    }

    fn serialize(&self) -> Value {
        Value::Null
    }
}

/// Write `text` on `rect`'s line starting `at` cells in, cut at the line's end.
fn draw(buf: &mut Buffer, rect: Rect, at: u16, text: &str, style: Style) {
    if rect.is_empty() || at >= rect.width {
        return;
    }
    buf.set_stringn(
        rect.x + at,
        rect.y,
        text,
        usize::from(rect.width - at),
        style,
    );
}
