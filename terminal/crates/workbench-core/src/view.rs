//! `view`: draws the dock chrome and each visible panel's body. No I/O and no
//! state change; every color comes from the [`Theme`] it is given.

use ratatui::buffer::Buffer;
use ratatui::layout::{Direction, Rect};
use theorem_workbench_dock::{GroupFrame, Presentation, SolvedFrame, Suppressed, TabFrame};

use crate::icons::{PlacedIcon, take_icons};
use crate::ids::PanelInstanceId;
use crate::model::Model;
use crate::panel::ViewCtx;
use crate::theme::Theme;
use theorem_workbench_text::visible::{hidden, joins_emoji};

const CLOSE: &str = "\u{00d7}";
/// Tabs are scrolled out of the strip on this side.
const MORE_BEFORE: &str = "\u{2039}";
const MORE_AFTER: &str = "\u{203a}";
/// The group shown is maximized.
const MAXIMIZED: &str = "\u{25a3}";

/// Draws the whole frame and returns the icons it carries: the last thing it
/// does is the icon pass ([`take_icons`]), once everything that can cover an
/// icon has been drawn, so no icon sentinel is left in `buf`.
pub fn view(model: &Model, area: Rect, buf: &mut Buffer, theme: &Theme) -> Vec<PlacedIcon> {
    draw_frame(model, area, buf, theme);
    take_icons(buf)
}

fn draw_frame(model: &Model, area: Rect, buf: &mut Buffer, theme: &Theme) {
    let area = area.intersection(buf.area);
    buf.set_style(area, theme.bg);
    let Some(vp) = model.viewport() else {
        return;
    };
    let dock_area = model.dock_area_in(area);
    let solved;
    let frame = match model.frame() {
        Some(f) if f.area == dock_area => f,
        _ => {
            solved = model.dock().solve(dock_area, vp.metrics);
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
    draw_notice(model, area, buf, theme);
    strip_unsafe(buf);
}

/// The last thing a frame does: no cell holds a control or hidden character
/// (a bidi override, a zero-width mark), whichever panel wrote it. `Buffer`
/// drops controls from a string itself, but a zero-width joiner or non-joiner
/// is appended to the previous cell's symbol, and `set_symbol` and `set_char`
/// take anything. What is left of a symbol keeps its combining marks and
/// variation selectors; a symbol with nothing left is a blank cell. The one
/// hidden character that stays is the joiner inside an emoji sequence: without
/// it a family or a flag would fall apart into several glyphs in one cell.
fn strip_unsafe(buf: &mut Buffer) {
    let unsafe_char = |c: char| c.is_control() || hidden(c);
    for cell in &mut buf.content {
        if cell.symbol().chars().any(unsafe_char) {
            let chars: Vec<char> = cell.symbol().chars().collect();
            let kept: String = (0..chars.len())
                .filter(|&i| !unsafe_char(chars[i]) || joins_emoji(&chars, i))
                .map(|i| chars[i])
                .collect();
            cell.set_symbol(if kept.is_empty() { " " } else { &kept });
        }
    }
}

/// The notice line: the persistent row under the dock, or a transient notice
/// over the right end of the bottom row, which the next frame redraws under.
fn draw_notice(model: &Model, area: Rect, buf: &mut Buffer, theme: &Theme) {
    let (Some(rect), Some(line)) = (model.notice_rect(area), model.notice_line()) else {
        return;
    };
    let style = line.severity.style(theme);
    buf.set_style(rect, style);
    let mut text = format!(" {} ", line.text);
    let room = usize::from(rect.width);
    if text.chars().count() > room {
        text = text.chars().take(room.saturating_sub(2)).collect();
        text.push('\u{2026}');
        text.push(' ');
    }
    buf.set_stringn(rect.x, rect.y, text, room, style);
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
        let registered = tabs
            .iter()
            .find(|t| t.panel == tab.panel)
            .map_or("", |t| t.title.as_str());
        let label = model.tab_label(&PanelInstanceId::new(tab.panel.0.clone()), registered);
        draw_tab(tab, &label, group.focused && window, buf, theme);
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

fn draw_tab(
    tab: &TabFrame,
    label: &crate::panel::TabLabel,
    group_focused: bool,
    buf: &mut Buffer,
    theme: &Theme,
) {
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
    // The mark takes the tab's leading space, so a title that fits the width
    // the dock measured still fits with it.
    let lead = if label.modified { MODIFIED } else { " " };
    let label = format!("{lead}{}", label.title);
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

/// Stands where a modified tab's leading space is.
const MODIFIED: &str = "\u{25cf}";

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
