//! `view`: draws the dock chrome and each visible panel's body. No I/O and no
//! state change; every color comes from the [`Theme`] it is given.

use ratatui::buffer::Buffer;
use ratatui::layout::{Direction, Rect};
use theorem_workbench_dock::{GroupFrame, Presentation, SolvedFrame, Suppressed, TabFrame};

use crate::ids::PanelInstanceId;
use crate::model::Model;
use crate::panel::ViewCtx;
use crate::theme::Theme;

const CLOSE: &str = "\u{00d7}";
/// Tabs are scrolled out of the strip on this side.
const MORE_BEFORE: &str = "\u{2039}";
const MORE_AFTER: &str = "\u{203a}";
/// The group shown is maximized.
const MAXIMIZED: &str = "\u{25a3}";

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
            draw_group(model, frame, group, buf, theme, picker.as_ref(), window);
        }
    }
    draw_gutters(model, frame, buf, theme);
}

fn draw_group(
    model: &Model,
    frame: &SolvedFrame,
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
    draw_strip_marks(group, frame, buf, theme);

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
                workspace: &model.workspace,
                focused: group.focused && window,
                picker,
                capabilities: &model.caps,
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

/// What the strip says besides its tabs: that tabs are scrolled out of it on
/// either side, and that the group is shown alone (maximized, or the only one
/// the window has room for). The left mark replaces the first tab's leading
/// space; the right marks sit in the free cells after the last tab and its own
/// trailing space, in the longest form that fits, so they never cover a title
/// or a close control.
fn draw_strip_marks(group: &GroupFrame, frame: &SolvedFrame, buf: &mut Buffer, theme: &Theme) {
    let strip = group.tab_strip;
    if strip.is_empty() || group.overlay {
        return;
    }
    if group.tabs_before > 0
        && let Some(cell) = buf.cell_mut((strip.x, strip.y))
    {
        cell.set_symbol(MORE_BEFORE);
    }

    let hidden = frame
        .suppressed
        .iter()
        .filter(|(_, why)| *why == Suppressed::Collapsed)
        .count();
    // Longest first; the last of each is as short as it gets.
    let presentation: Vec<String> = match frame.presentation {
        Presentation::Tiled => vec![],
        Presentation::Maximized => vec!["maximized".into(), "max".into(), MAXIMIZED.into()],
        Presentation::Principal => vec![format!("{hidden} more"), format!("+{hidden}")],
    };
    let overflow: Vec<String> = if group.tabs_after > 0 {
        vec![
            format!("{MORE_AFTER}{}", group.tabs_after),
            MORE_AFTER.to_owned(),
        ]
    } else {
        vec![]
    };
    if presentation.is_empty() && overflow.is_empty() {
        return;
    }
    // The cells after the last tab, plus that tab's trailing space.
    let used = group.tabs.last().map_or(strip.x, |t| t.rect.right());
    let room =
        usize::from(strip.right().saturating_sub(used)) + usize::from(!group.tabs.is_empty());
    let width = |s: &String| s.chars().count();
    let pick = |list: &[String], level: usize| -> String {
        list.get(level.min(list.len().saturating_sub(1)))
            .cloned()
            .unwrap_or_default()
    };
    let levels = presentation.len().max(overflow.len());
    let mut chosen = None;
    for level in 0..levels {
        let (p, o) = (pick(&presentation, level), pick(&overflow, level));
        let gap = usize::from(!p.is_empty() && !o.is_empty());
        if width(&p) + gap + width(&o) <= room {
            chosen = Some((p, o, gap));
            break;
        }
    }
    // Too narrow for both: the overflow mark, else the presentation's shortest.
    let (p, o, gap) = chosen.unwrap_or_else(|| match overflow.last() {
        Some(o) if width(o) <= room => (String::new(), o.clone(), 0),
        _ => (pick(&presentation, usize::MAX), String::new(), 0),
    });
    let total = width(&p) + gap + width(&o);
    let Some(start) = (usize::from(strip.right())).checked_sub(total) else {
        return;
    };
    let mut x = u16::try_from(start).unwrap_or(strip.x).max(strip.x);
    if !o.is_empty() {
        buf.set_stringn(x, strip.y, &o, width(&o), theme.muted);
        x += u16::try_from(width(&o) + gap).unwrap_or(0);
    }
    if !p.is_empty() {
        buf.set_stringn(x, strip.y, &p, width(&p), theme.selected);
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
