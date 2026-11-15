//! Layout, drawing and semantics.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::semantics::{Node, Role};
use theorem_workbench_core::{DraftAttachmentState, Theme};
use theorem_workbench_editor::{EditorStyles, Paint};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::composer::{Composer, PROMPT_WIDTH, Popup};
use crate::types::Policy;

/// A chip's name is cut to this many cells.
const CHIP_NAME: usize = 20;
const CHIP_STATE: usize = 28;

/// Display cells of `s`.
pub(crate) fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// `s` cut to `max` cells, with an ellipsis when it was cut.
pub(crate) fn clip(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_owned();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for g in s.graphemes(true) {
        let w = width(g);
        if used + w + 1 > max {
            break;
        }
        out.push_str(g);
        used += w;
    }
    out.push('\u{2026}');
    out
}

/// `s` cut to `max` cells keeping its end: a path keeps its file name.
fn clip_start(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_owned();
    }
    if max == 0 {
        return String::new();
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0;
    for g in s.graphemes(true).rev() {
        let w = width(g);
        if used + w + 1 > max {
            break;
        }
        kept.push(g);
        used += w;
    }
    kept.reverse();
    format!("\u{2026}{}", kept.concat())
}

/// Where each part of the composer sits in the area.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Layout {
    pub chips: Option<Rect>,
    /// The cells the text is drawn in, after the prompt column.
    pub text: Rect,
    pub popup: Option<Rect>,
    pub footer: Option<Rect>,
}

/// One chip as placed in the chip row.
pub(crate) struct ChipCell {
    pub index: usize,
    pub x: u16,
    pub width: u16,
    pub label: String,
}

impl Composer {
    pub(crate) fn layout(&self, area: Rect) -> Layout {
        let mut rest = area.height.saturating_sub(1);
        let footer = rest >= 1;
        if footer {
            rest -= 1;
        }
        let chips = !self.attachments.is_empty() && rest >= 1;
        if chips {
            rest -= 1;
        }
        let popup = self.popup_height().min(rest);
        let text_h = area.height - u16::from(footer) - u16::from(chips) - popup;
        let mut y = area.y;
        let chips_r = chips.then(|| {
            let r = Rect::new(area.x, y, area.width, 1);
            y += 1;
            r
        });
        let text = Rect::new(
            area.x.saturating_add(PROMPT_WIDTH.min(area.width)),
            y,
            area.width.saturating_sub(PROMPT_WIDTH),
            text_h,
        );
        y += text_h;
        let popup_r = (popup > 0).then(|| {
            let r = Rect::new(area.x, y, area.width, popup);
            y += popup;
            r
        });
        let footer_r = footer.then(|| Rect::new(area.x, y, area.width, 1));
        Layout {
            chips: chips_r,
            text,
            popup: popup_r,
            footer: footer_r,
        }
    }

    fn chip_label(&self, i: usize) -> String {
        let a = &self.attachments[i];
        let state = match a.state {
            DraftAttachmentState::Adding => "adding\u{2026}".to_owned(),
            DraftAttachmentState::Ready => "ready".to_owned(),
            DraftAttachmentState::Refused => {
                format!("refused: {}", a.reason.as_deref().unwrap_or("not accepted"))
            }
        };
        let mark = if self.chip == Some(i) { "\u{25B8}" } else { "" };
        format!(
            "[{mark}{} {}]",
            clip(&a.name, CHIP_NAME),
            clip(&state, CHIP_STATE)
        )
    }

    /// The chips that fit `width` cells, scrolled so the chosen one shows.
    pub(crate) fn chip_cells(&self, width_cells: u16) -> Vec<ChipCell> {
        let labels: Vec<String> = (0..self.attachments.len())
            .map(|i| self.chip_label(i))
            .collect();
        let widths: Vec<usize> = labels.iter().map(|l| width(l)).collect();
        let max = usize::from(width_cells);
        let mut first = 0;
        if let Some(f) = self.chip {
            let f = f.min(labels.len().saturating_sub(1));
            first = f;
            let mut used = widths.get(f).copied().unwrap_or(0);
            while first > 0 && used + 1 + widths[first - 1] <= max {
                used += 1 + widths[first - 1];
                first -= 1;
            }
        }
        let mut out = Vec::new();
        let mut x = 0usize;
        for i in first..labels.len() {
            if x >= max {
                break;
            }
            let w = widths[i].min(max - x);
            out.push(ChipCell {
                index: i,
                x: x as u16,
                width: w as u16,
                label: clip(&labels[i], w),
            });
            x += w + 1;
        }
        out
    }

    /// What Enter and Esc do now, in words: the full wording first and shorter
    /// wordings after it, for narrow widths.
    pub(crate) fn footer_left_options(&self) -> Vec<String> {
        let v = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        if let Some(n) = &self.notice {
            return vec![n.clone()];
        }
        if self.preedit.is_some() {
            return v(&[
                "Composing; Enter commits the text, not the message",
                "Composing",
            ]);
        }
        if self.chip.is_some() {
            return v(&[
                "Left/Right choose, Backspace removes, Down returns to the text",
                "Backspace removes, Down returns",
                "Backspace removes",
            ]);
        }
        match &self.popup {
            Some(Popup::Models { .. }) => {
                return v(&["Up/Down move, Enter chooses, Esc closes", "Enter chooses"]);
            }
            Some(p @ Popup::Files { .. }) if p.len() > 0 => {
                return v(&[
                    "Up/Down move, Enter or Tab insert, Esc keeps the text",
                    "Enter or Tab insert, Esc closes",
                    "Enter inserts",
                ]);
            }
            _ => {}
        }
        if self.editing.is_some() {
            return v(&["Enter sends the edit, Esc cancels", "Enter sends the edit"]);
        }
        match &self.status.policy {
            Policy::Idle => v(&[
                "Enter sends, Shift+Enter new line",
                "Enter sends, Shift+Enter: line",
                "Enter sends",
            ]),
            Policy::Running { can_steer: true } => v(&[
                "Enter steers the run, Esc stops",
                "Enter steers, Esc stops",
                "Enter steers",
            ]),
            Policy::Running { can_steer: false } => v(&["Run working, Esc stops", "Esc stops"]),
            Policy::Blocked { reason } => vec![reason.clone()],
        }
    }

    pub(crate) fn footer_left(&self) -> String {
        self.footer_left_options().remove(0)
    }

    /// Model, effort and context use, when known.
    pub(crate) fn footer_right(&self) -> String {
        let s = &self.status;
        let mut parts: Vec<String> = Vec::new();
        parts.extend(s.model.clone());
        parts.extend(s.effort.clone());
        if let Some(p) = s.context_percent {
            parts.push(format!("{p}% context"));
        }
        parts.join(" \u{00B7} ")
    }

    // ---- drawing ----

    /// Draw into `area`. Colours come from `theme` only.
    pub fn draw(&self, area: Rect, buf: &mut Buffer, theme: &Theme) {
        self.area.set(area);
        let area = area.intersection(buf.area);
        if area.width == 0 || area.height == 0 {
            return;
        }
        buf.set_style(area, theme.text);
        let lay = self.layout(area);

        if let Some(r) = lay.chips {
            for c in self.chip_cells(r.width) {
                let a = &self.attachments[c.index];
                let style = if self.chip == Some(c.index) {
                    theme.popup_selected
                } else {
                    match a.state {
                        DraftAttachmentState::Ready => theme.control,
                        DraftAttachmentState::Adding => theme.control_disabled,
                        DraftAttachmentState::Refused => theme.error,
                    }
                };
                buf.set_stringn(
                    r.x + c.x,
                    r.y,
                    &c.label,
                    usize::from(c.width),
                    theme.text.patch(style),
                );
            }
        }

        self.draw_text(lay.text, area, buf, theme);

        if let Some(r) = lay.popup {
            self.draw_popup(r, buf, theme);
        }
        if let Some(r) = lay.footer {
            self.draw_footer(r, buf, theme);
        }
    }

    fn draw_text(&self, t: Rect, area: Rect, buf: &mut Buffer, theme: &Theme) {
        if t.height > 0 && area.width >= PROMPT_WIDTH {
            let style = if self.focused && self.chip.is_none() {
                theme.text.patch(theme.field_focus)
            } else {
                theme.text.patch(theme.divider)
            };
            let glyph = format!("{} ", self.prompt);
            buf.set_stringn(area.x, t.y, &glyph, usize::from(PROMPT_WIDTH), style);
        }
        if t.width == 0 || t.height == 0 {
            return;
        }
        let mut styles = EditorStyles::from_theme(theme);
        // A chat box has no current-line band.
        styles.current_line = Style::default();
        let mut paint = Paint::new(&styles);
        paint.preedit = self.preedit.as_deref();
        self.view.draw(&self.session, t, buf, &paint);
        let preedit = self.preedit.as_deref().filter(|p| !p.is_empty());
        if self.session.is_empty() && preedit.is_none() {
            buf.set_stringn(
                t.x,
                t.y,
                &self.placeholder,
                usize::from(t.width),
                theme.text.patch(theme.muted),
            );
        }
    }

    fn draw_popup(&self, r: Rect, buf: &mut Buffer, theme: &Theme) {
        let Some(p) = &self.popup else { return };
        let rows = usize::from(r.height);
        let labels = p.labels();
        let first = self.popup_first(rows);
        for i in 0..rows {
            let y = r.y + i as u16;
            buf.set_style(Rect::new(r.x, y, r.width, 1), theme.popup);
            let idx = first + i;
            let (text, chosen) = match labels.get(idx) {
                Some(l) => (l.clone(), idx == p.selected()),
                None if i == 0 => (
                    match p {
                        Popup::Files { rows: None, .. } => "Searching\u{2026}".to_owned(),
                        _ => "No matches".to_owned(),
                    },
                    false,
                ),
                None => continue,
            };
            let style = if chosen {
                theme.popup_selected
            } else {
                theme.popup
            };
            buf.set_style(Rect::new(r.x, y, r.width, 1), style);
            let marker = if chosen { "\u{25B8} " } else { "  " };
            let room = usize::from(r.width).saturating_sub(2);
            let shown = match p {
                Popup::Files { .. } => clip_start(&text, room),
                Popup::Models { .. } => clip(&text, room),
            };
            buf.set_stringn(
                r.x,
                y,
                format!("{marker}{shown}"),
                usize::from(r.width),
                style,
            );
        }
    }

    fn draw_footer(&self, r: Rect, buf: &mut Buffer, theme: &Theme) {
        let blocked = matches!(self.status.policy, Policy::Blocked { .. }) && self.notice.is_none();
        let left_style = if blocked || self.notice.is_some() {
            theme.text.patch(theme.warning)
        } else {
            theme.text.patch(theme.muted)
        };
        let w = usize::from(r.width);
        let options = self.footer_left_options();
        let right = self.footer_right();
        // The policy is what the footer is for: the right side goes first,
        // then the left side is worded shorter, and only then cut.
        let both = !right.is_empty() && width(&options[0]) + 2 + width(&right) <= w;
        let left = if both {
            options[0].clone()
        } else {
            options
                .iter()
                .find(|o| width(o) <= w)
                .cloned()
                .unwrap_or_else(|| clip(&options[options.len() - 1], w))
        };
        buf.set_stringn(r.x, r.y, &left, w, left_style);
        if both {
            let x = r.x + (w - width(&right)) as u16;
            buf.set_stringn(x, r.y, &right, w, theme.text.patch(theme.muted));
        }
    }

    // ---- semantics ----

    /// One textbox for the draft, one node per chip, the popup as a menu, and
    /// the footer as a status. The first node is the root; ids sit under the
    /// prefix given to [`Composer::new`].
    pub fn semantics(&self, area: Rect) -> Vec<Node> {
        let lay = self.layout(area);
        let p = &self.prefix;
        let mut root = Node::new(p, Role::Group, &self.label, area);
        let mut out: Vec<Node> = Vec::new();
        let mut kids = Vec::new();

        if let Some(r) = lay.chips {
            let mut group = Node::new(&format!("{p}:attachments"), Role::Group, "Attachments", r);
            let mut chips = Vec::new();
            let total = self.attachments.len();
            let cells = self.chip_cells(r.width);
            for (i, a) in self.attachments.iter().enumerate() {
                let rect = cells
                    .iter()
                    .find(|c| c.index == i)
                    .map_or(Rect::new(r.x, r.y, 0, 1), |c| {
                        Rect::new(r.x + c.x, r.y, c.width, 1)
                    });
                let mut n = Node::new(&format!("{p}:chip:{}", a.id), Role::Button, &a.name, rect);
                n.state.selected = self.chip == Some(i);
                n.state.focused = self.chip == Some(i);
                n.state.busy = a.state == DraftAttachmentState::Adding;
                n.state.disabled = a.state == DraftAttachmentState::Refused;
                n.state.description = Some(match a.state {
                    DraftAttachmentState::Adding => "adding".to_owned(),
                    DraftAttachmentState::Ready => "ready".to_owned(),
                    DraftAttachmentState::Refused => {
                        format!("refused: {}", a.reason.as_deref().unwrap_or("not accepted"))
                    }
                });
                n.pos_in_set = u16::try_from(i + 1).ok();
                n.set_size = u16::try_from(total).ok();
                chips.push(n);
            }
            group.children = chips.iter().map(|n| n.id.clone()).collect();
            kids.push(group.id.clone());
            out.push(group);
            out.extend(chips);
        }

        let mut text = Node::new(&format!("{p}:text"), Role::TextBox, &self.label, lay.text);
        let value = self.session.text();
        text = text.with_text(&value);
        text.state.focused = self.focused && self.window_focused && self.chip.is_none();
        text.state.busy = self.preedit.is_some();
        text.state.description = Some(if value.is_empty() {
            self.placeholder.clone()
        } else {
            let coords = self.session.coords();
            let c = self.session.cursor();
            let mut d = format!(
                "caret at character {} on line {}",
                coords.grapheme_index(c),
                coords.line_of(c) + 1
            );
            if let Some((a, b)) = self.session.selection() {
                d.push_str(&format!(
                    "; characters {} to {} selected",
                    coords.grapheme_index(a),
                    coords.grapheme_index(b)
                ));
            }
            d
        });
        text.shortcut = Some("Enter".to_owned());
        kids.push(text.id.clone());
        out.push(text);

        if let (Some(r), Some(pop)) = (lay.popup, &self.popup) {
            let mut menu = Node::new(&format!("{p}:popup"), Role::Menu, pop.title(), r);
            let labels = pop.labels();
            let n = labels.len();
            let items: Vec<Node> = labels
                .iter()
                .enumerate()
                .take(100)
                .map(|(i, l)| {
                    let mut item = Node::new(&format!("{p}:popup:{i}"), Role::MenuItem, l, r);
                    item.state.selected = i == pop.selected();
                    item.pos_in_set = u16::try_from(i + 1).ok();
                    item.set_size = u16::try_from(n).ok();
                    item
                })
                .collect();
            menu.children = items.iter().map(|n| n.id.clone()).collect();
            kids.push(menu.id.clone());
            out.push(menu);
            out.extend(items);
        }

        if let Some(r) = lay.footer {
            let right = self.footer_right();
            let name = if right.is_empty() {
                self.footer_left()
            } else {
                format!("{}  {}", self.footer_left(), right)
            };
            let n = Node::new(&format!("{p}:footer"), Role::Status, &name, r);
            kids.push(n.id.clone());
            out.push(n);
        }

        root.children = kids;
        let mut all = vec![root];
        all.extend(out);
        all
    }
}
