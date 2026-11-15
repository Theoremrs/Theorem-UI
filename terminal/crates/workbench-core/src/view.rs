//! `view`: draws the dock chrome and each visible panel's body. No I/O and no
//! state change; every color comes from the [`Theme`] it is given.

use ratatui::buffer::Buffer;
use ratatui::layout::{Direction, Rect};
use theorem_workbench_dock::{GroupFrame, SolvedFrame, TabFrame};

use crate::ids::PanelInstanceId;
use crate::model::Model;
use crate::panel::ViewCtx;
use crate::theme::Theme;

const CLOSE: &str = "\u{00d7}";

pub fn view(model: &Model, area: Rect, buf: &mut Buffer, theme: &Theme) {
    let area = area.intersection(buf.area);
    buf.set_style(area, theme.bg);
    let Some(vp) = model.viewport() else {
        return;
    };
    let solved;
    let frame = match model.frame() {
        Some(f) if f.area == area => f,
        _ => {
            solved = model.dock().solve(area, vp.metrics);
            &solved
        }
    };
    let picker = model.picker_view();
    let window = model.focus().window;

    // A drawer is drawn over the content, so it goes last.
    for overlay in [false, true] {
        for group in frame.groups.iter().filter(|g| g.overlay == overlay) {
            draw_group(model, group, buf, theme, picker.as_ref(), window);
        }
    }
    draw_gutters(model, frame, buf, theme);
}

fn draw_group(
    model: &Model,
    group: &GroupFrame,
    buf: &mut Buffer,
    theme: &Theme,
    picker: Option<&crate::panel::PickerView>,
    window: bool,
) {
    let tabs = model
        .dock()
        .group(group.id)
        .map(|g| g.tabs())
        .unwrap_or(&[]);
    for tab in &group.tabs {
        let title = tabs
            .iter()
            .find(|t| t.panel == tab.panel)
            .map_or("", |t| t.title.as_str());
        draw_tab(tab, title, group.focused && window, buf, theme);
    }

    let active = group
        .active
        .as_ref()
        .map(|p| PanelInstanceId::new(p.0.clone()))
        .and_then(|id| model.panels.get(&id));
    match active {
        Some(entry) => entry.panel.view(
            group.body,
            buf,
            &ViewCtx {
                theme,
                focused: group.focused && window,
                picker,
            },
        ),
        None if !group.body.is_empty() => {
            buf.set_stringn(
                group.body.x,
                group.body.y,
                "No panels",
                usize::from(group.body.width),
                theme.muted,
            );
        }
        None => {}
    }
}

fn draw_tab(tab: &TabFrame, title: &str, group_focused: bool, buf: &mut Buffer, theme: &Theme) {
    if tab.rect.is_empty() {
        return;
    }
    let style = match (tab.unavailable, tab.active, group_focused) {
        (true, _, _) => theme.muted,
        (false, true, true) => theme.focus,
        (false, true, false) => theme.selected,
        (false, false, _) => theme.text,
    };
    let close = u16::from(!tab.close.is_empty());
    let label = format!(" {title}");
    buf.set_style(tab.rect, style);
    buf.set_stringn(
        tab.rect.x,
        tab.rect.y,
        label,
        usize::from(tab.rect.width.saturating_sub(close)),
        style,
    );
    if close == 1 {
        buf.set_stringn(tab.close.x, tab.close.y, CLOSE, 1, style);
    }
}

fn draw_gutters(model: &Model, frame: &SolvedFrame, buf: &mut Buffer, theme: &Theme) {
    for splitter in &frame.splitters {
        let dragging = model.drag.as_ref().is_some_and(|d| d.path == splitter.path);
        let style = if dragging { theme.focus } else { theme.line };
        let glyph = match splitter.direction {
            Direction::Horizontal => "\u{2502}",
            Direction::Vertical => "\u{2500}",
        };
        for y in splitter.rect.top()..splitter.rect.bottom() {
            for x in splitter.rect.left()..splitter.rect.right() {
                if let Some(cell) = buf.cell_mut((x, y)) {
                    cell.set_symbol(glyph).set_style(style);
                }
            }
        }
    }
}
