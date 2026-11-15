//! The artifact cabinet: the collection browser that shares the right-hand
//! host with the agent terminal. React owns the catalog (the project's
//! outputs, filtered and searched by the authority) and the preview
//! preference; this view draws the cabinet's chrome and cards, owns selection
//! and scroll, and allocates the rectangles the host fills: each card's
//! preview (an inert canvas) and each control (a real, labelled browser
//! control laid exactly over its drawing).
//!
//! The host hears a geometry epoch only when the layout or the visible slots
//! change, never every frame, and refers to previews by card identity and
//! revision so a stale epoch cannot paint a card that has moved.

use std::{cell::RefCell, rc::Rc};

use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
};
use ratzilla::{
    event::{KeyCode, KeyEvent},
    web_sys::KeyboardEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use unicode_width::UnicodeWidthStr;
use wasm_bindgen::prelude::*;

use crate::{Drawn, Screen, palette, run_frames};

/// §4.2's targets, in CSS pixels: padding per side, gaps, minimum card width.
const PAD_PX: f32 = 20.0;
const GAP_DOCKED_PX: f32 = 14.0;
const GAP_EXPANDED_PX: f32 = 22.0;
const CARD_MIN_PX: f32 = 178.0;
const COLUMNS_DOCKED: usize = 2;
const COLUMNS_EXPANDED: usize = 3;
/// The preview artboard's aspect: 128 × 84.
const ART_W: f32 = 128.0;
const ART_H: f32 = 84.0;
const DESCRIPTION_LINES: usize = 3;

/// One card as the controller projects it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Entry {
    key: String,
    revision: String,
    title: String,
    /// "Image · 1000 × 625" and the like: facts only.
    meta: String,
    description: String,
    /// loading | ready | refreshing | unsupported | unavailable | failed | inaccessible
    state: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Filter {
    id: String,
    label: String,
}

/// Everything the controller decides; the view only draws it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct View {
    title: String,
    scope: String,
    /// "06 objects", "24 of 80 loaded", "loaded only": the controller words
    /// exact, loaded and unknown counts.
    count: String,
    /// "pixel interpretations" | "original thumbnails"
    mode_label: String,
    /// The preference control's text: "Theme default", "Pixel", "Original".
    preference_label: String,
    filters: Vec<Filter>,
    filter: String,
    query: String,
    expanded: bool,
    /// A line under the filters when the collection is stale, offline or empty.
    status: String,
    footer_note: String,
    entries: Vec<Entry>,
    /// The card to select when the view arrives, if the controller has one.
    selected: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
struct Area {
    x: i32,
    y: i32,
    w: u16,
    h: u16,
}

impl From<Rect> for Area {
    fn from(r: Rect) -> Self {
        Area {
            x: r.x.into(),
            y: r.y.into(),
            w: r.width,
            h: r.height,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Slot {
    key: String,
    revision: String,
    index: usize,
    /// The preview's inner rectangle in cells, unclipped.
    preview: Area,
    /// The whole card in cells, unclipped: the open target.
    card: Area,
    selected: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Control {
    id: String,
    area: Area,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Geometry {
    /// Cell size in CSS pixels, as the backend measured it.
    cell: (f32, f32),
    cols: u16,
    rows: u16,
    columns: usize,
    /// The gallery's visible area: previews are clipped to it.
    clip: Area,
    slots: Vec<Slot>,
    controls: Vec<Control>,
    selected: Option<String>,
}

/// A card's column, signed top row (above the gallery when scrolled) and width.
#[derive(Clone, Copy)]
struct CardBox {
    x: u16,
    y: i32,
    width: u16,
}

pub(crate) struct Cabinet {
    view: View,
    cell: (f32, f32),
    selected: Option<String>,
    /// First gallery row shown, in rows of the card layout.
    scroll: u16,
    columns: usize,
    /// Card height in rows, the last layout's.
    card_rows: u16,
    gallery_rows: u16,
    geometry: Option<Geometry>,
    epoch: u64,
    sent_epoch: u64,
    on_geometry: js_sys::Function,
}

/// §4.2: n = max(1, min(n_max, floor((W + g) / (m + g)))).
pub(crate) fn columns_for(width_px: f32, gap_px: f32, min_px: f32, max: usize) -> usize {
    (((width_px + gap_px) / (min_px + gap_px)).floor() as usize).clamp(1, max)
}

/// Words into lines no wider than `width` columns, at most `max` lines; a
/// cut last line ends in an ellipsis.
fn wrap(text: &str, width: usize, max: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    let mut cut = false;
    for word in text.split_whitespace() {
        let fits = line.is_empty() || line.width() + 1 + word.width() <= width;
        if !fits {
            if lines.len() + 1 == max {
                cut = true;
                break;
            }
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        // A single word wider than the card is broken, not overflowed.
        if word.width() > width {
            for c in word.chars() {
                if line.width() + 1 > width {
                    if lines.len() + 1 == max {
                        cut = true;
                        break;
                    }
                    lines.push(std::mem::take(&mut line));
                }
                line.push(c);
            }
        } else {
            line.push_str(word);
        }
        if cut {
            break;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    if cut && let Some(last) = lines.last_mut() {
        while last.width() + 1 > width && last.pop().is_some() {}
        last.push('…');
    }
    lines
}

fn clip_text(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    for c in text.chars() {
        if out.width() + 2 > width {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

impl Cabinet {
    fn new(on_geometry: js_sys::Function) -> Self {
        Self {
            view: View::default(),
            cell: (0.0, 0.0),
            selected: None,
            scroll: 0,
            columns: 1,
            card_rows: 1,
            gallery_rows: 1,
            geometry: None,
            epoch: 0,
            sent_epoch: 0,
            on_geometry,
        }
    }

    fn set_view(&mut self, json: &str) -> Result<(), serde_json::Error> {
        let view: View = serde_json::from_str(json)?;
        if let Some(selected) = &view.selected {
            self.selected = Some(selected.clone());
        }
        // A selection whose card left the collection falls to its neighbour.
        if let Some(key) = &self.selected
            && !view.entries.iter().any(|e| &e.key == key)
        {
            let old = self
                .view
                .entries
                .iter()
                .position(|e| &e.key == key)
                .unwrap_or(0);
            self.selected = view
                .entries
                .get(old.min(view.entries.len().saturating_sub(1)))
                .map(|e| e.key.clone());
        }
        self.view = view;
        Ok(())
    }

    fn index_of_selected(&self) -> Option<usize> {
        let key = self.selected.as_ref()?;
        self.view.entries.iter().position(|e| &e.key == key)
    }

    fn select(&mut self, index: usize) -> Option<String> {
        let key = self.view.entries.get(index)?.key.clone();
        self.selected = Some(key.clone());
        self.reveal(index);
        Some(key)
    }

    /// Scrolls so the card at `index` is wholly in view.
    fn reveal(&mut self, index: usize) {
        let row = (index / self.columns.max(1)) as u16;
        let top = row * self.card_rows;
        let bottom = top + self.card_rows;
        if top < self.scroll {
            self.scroll = top;
        } else if bottom > self.scroll + self.gallery_rows {
            self.scroll = bottom.saturating_sub(self.gallery_rows);
        }
    }

    /// A key while a card has focus. Arrows select; Enter opens; neither
    /// activates an application.
    fn key(&mut self, event: KeyEvent) -> (bool, Option<serde_json::Value>) {
        let count = self.view.entries.len();
        if count == 0 {
            return (false, None);
        }
        let cols = self.columns.max(1);
        let current = self.index_of_selected();
        let at = current.unwrap_or(0);
        let page = (self.gallery_rows / self.card_rows.max(1)).max(1) as usize * cols;
        let target = match event.code {
            KeyCode::Right => Some((at + 1).min(count - 1)),
            KeyCode::Left => Some(at.saturating_sub(1)),
            KeyCode::Down => Some(if at + cols < count { at + cols } else { at }),
            KeyCode::Up => Some(at.checked_sub(cols).unwrap_or(at)),
            KeyCode::Home => Some(0),
            KeyCode::End => Some(count - 1),
            KeyCode::PageDown => Some((at + page).min(count - 1)),
            KeyCode::PageUp => Some(at.saturating_sub(page)),
            KeyCode::Enter => {
                let entry = &self.view.entries[at];
                return (
                    true,
                    Some(json!({"type": "open", "key": entry.key, "revision": entry.revision})),
                );
            }
            _ => None,
        };
        match target {
            Some(index) if current.is_none() || Some(index) != current => {
                let key = self.select(index);
                (true, key.map(|key| json!({"type": "select", "key": key})))
            }
            Some(_) => (true, None),
            None => (false, None),
        }
    }

    fn scroll_by(&mut self, rows: i32) {
        let rows_total =
            self.view.entries.len().div_ceil(self.columns.max(1)) as u16 * self.card_rows;
        let max = rows_total.saturating_sub(self.gallery_rows);
        self.scroll = (i32::from(self.scroll) + rows).clamp(0, i32::from(max)) as u16;
    }

    fn draw_header(&self, frame: &mut Frame, area: Rect, controls: &mut Vec<Control>) -> u16 {
        let p = palette();
        let (x, w) = (area.x, area.width);
        let mut y = area.y + 1;
        let line = |frame: &mut Frame, y: u16, left: Line, right: Line| {
            let rw = right.width() as u16;
            frame.render_widget(
                Paragraph::new(left),
                Rect::new(x, y, w.saturating_sub(rw + 1), 1),
            );
            if rw > 0 && rw < w {
                frame.render_widget(Paragraph::new(right), Rect::new(x + w - rw, y, rw, 1));
            }
        };
        line(
            frame,
            y,
            Line::from(vec![
                Span::styled("■ ", Style::new().fg(p.sage)),
                Span::styled(
                    self.view.title.clone(),
                    Style::new().fg(p.bright).add_modifier(Modifier::BOLD),
                ),
            ]),
            Line::styled(self.view.count.clone(), Style::new().fg(p.muted)),
        );
        y += 1;
        line(
            frame,
            y,
            Line::styled(self.view.scope.clone(), Style::new().fg(p.muted)),
            Line::default(),
        );
        y += 2;
        // The preference control: drawn here, operated by the host's select.
        let pref = format!(" {} ▾ ", self.view.preference_label);
        let pref_w = pref.width() as u16;
        line(
            frame,
            y,
            Line::from(vec![
                Span::styled("■ ", Style::new().fg(p.sage)),
                Span::styled(self.view.mode_label.clone(), Style::new().fg(p.muted)),
            ]),
            Line::from(vec![
                Span::styled("Previews ", Style::new().fg(p.muted)),
                Span::styled(pref, Style::new().fg(p.ink).bg(p.raised)),
            ]),
        );
        if pref_w < w {
            controls.push(Control {
                id: "preference".into(),
                area: Area {
                    x: (x + w - pref_w).into(),
                    y: y.into(),
                    w: pref_w,
                    h: 1,
                },
            });
        }
        y += 1;
        // Search: a bordered field; the host's input sits in its inner row.
        let search = Rect::new(x, y, w, 3);
        frame.render_widget(
            Block::new()
                .borders(Borders::ALL)
                .border_type(BorderType::Plain)
                .border_style(Style::new().fg(p.line)),
            search,
        );
        frame.render_widget(
            Paragraph::new(Span::styled("⌕", Style::new().fg(p.muted))),
            Rect::new(x + 2, y + 1, 1, 1),
        );
        if w > 8 {
            frame.render_widget(
                Paragraph::new(Span::styled("/", Style::new().fg(p.muted))),
                Rect::new(x + w - 3, y + 1, 1, 1),
            );
            controls.push(Control {
                id: "search".into(),
                area: Area {
                    x: (x + 4).into(),
                    y: (y + 1).into(),
                    w: w.saturating_sub(8),
                    h: 1,
                },
            });
        }
        y += 4;
        // Filters, then the one ordering this collection has.
        let mut cx = x;
        for filter in &self.view.filters {
            let active = filter.id == self.view.filter;
            let label = if active {
                format!("[{}]", filter.label)
            } else {
                filter.label.clone()
            };
            let lw = label.width() as u16;
            if cx + lw >= x + w.saturating_sub(10) {
                break;
            }
            frame.render_widget(
                Paragraph::new(Span::styled(
                    label,
                    if active {
                        Style::new().fg(p.sage)
                    } else {
                        Style::new().fg(p.muted)
                    },
                )),
                Rect::new(cx, y, lw, 1),
            );
            controls.push(Control {
                id: format!("filter:{}", filter.id),
                area: Area {
                    x: cx.into(),
                    y: y.into(),
                    w: lw,
                    h: 1,
                },
            });
            cx += lw + 2;
        }
        let order = "Recent ↓";
        let ow = order.width() as u16;
        if ow < w {
            frame.render_widget(
                Paragraph::new(Span::styled(order, Style::new().fg(p.muted))),
                Rect::new(x + w - ow, y, ow, 1),
            );
        }
        y += 1;
        if !self.view.status.is_empty() {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    clip_text(&self.view.status, w as usize),
                    Style::new().fg(p.gold),
                )),
                Rect::new(x, y, w, 1),
            );
        }
        y += 1;
        y - area.y
    }

    fn draw_footer(&self, frame: &mut Frame, area: Rect) {
        let p = palette();
        frame.render_widget(
            Block::new()
                .borders(Borders::TOP)
                .border_style(Style::new().fg(p.line)),
            Rect::new(0, area.y, frame.area().width, 1),
        );
        let hint = "↑↓←→ browse  ↵ open original";
        let shown = format!("{} artifacts", self.view.entries.len());
        let row = Rect::new(area.x, area.y + 1, area.width, 1);
        frame.render_widget(
            Paragraph::new(Span::styled(
                clip_text(hint, row.width as usize),
                Style::new().fg(p.muted),
            )),
            row,
        );
        let sw = shown.width() as u16;
        if sw + hint.width() as u16 + 2 <= row.width {
            frame.render_widget(
                Paragraph::new(Span::styled(shown, Style::new().fg(p.muted))),
                Rect::new(row.x + row.width - sw, row.y, sw, 1),
            );
        }
        if area.height > 2 {
            frame.render_widget(
                Paragraph::new(Span::styled(
                    clip_text(&self.view.footer_note, area.width as usize),
                    Style::new().fg(p.muted),
                )),
                Rect::new(area.x, area.y + 2, area.width, 1),
            );
        }
    }

    /// Draws one card at `card` (unclipped, in gallery-local rows already
    /// shifted by scroll), clipped to `clip`.
    #[allow(clippy::too_many_arguments)]
    fn draw_card(
        &self,
        frame: &mut Frame,
        entry: &Entry,
        index: usize,
        (x, top, width): (u16, i32, u16),
        preview_rows: u16,
        clip: Rect,
    ) {
        let p = palette();
        let selected = self.selected.as_deref() == Some(entry.key.as_str());
        let card = CardBox { x, y: top, width };
        let put = |frame: &mut Frame, y: i32, line: Line<'static>| {
            if y >= i32::from(clip.y) && y < i32::from(clip.y + clip.height) {
                frame.render_widget(
                    Paragraph::new(line),
                    Rect::new(card.x, y as u16, card.width, 1),
                );
            }
        };
        // Preview border, drawn row by row so a partly scrolled card clips.
        let border = Style::new().fg(if selected { p.sage } else { p.line });
        let w = card.width as usize;
        let number = format!("{:02}", index + 1);
        let top_left = if selected { "┌▸" } else { "┌─" };
        let fill = w.saturating_sub(top_left.width() + number.width() + 3);
        put(
            frame,
            card.y,
            Line::from(vec![
                Span::styled(top_left, border),
                Span::styled("─".repeat(fill), border),
                Span::styled(number, Style::new().fg(p.muted)),
                Span::styled("─┐", border),
            ]),
        );
        let state_text = match entry.state.as_str() {
            "loading" | "" => "loading preview…",
            "unsupported" => "preview unsupported",
            "unavailable" => "preview unavailable",
            "failed" => "preview failed",
            "inaccessible" => "no access",
            _ => "",
        };
        for r in 1..preview_rows.saturating_sub(1) {
            let mid = r == preview_rows / 2 && !state_text.is_empty();
            let inner = if mid {
                let t = clip_text(state_text, w.saturating_sub(4));
                let pad = w.saturating_sub(2 + t.width());
                let left = pad / 2;
                Span::styled(
                    format!("{}{}{}", " ".repeat(left), t, " ".repeat(pad - left)),
                    Style::new().fg(p.muted),
                )
            } else {
                Span::raw(" ".repeat(w.saturating_sub(2)))
            };
            put(
                frame,
                card.y + i32::from(r),
                Line::from(vec![
                    Span::styled("│", border),
                    inner,
                    Span::styled("│", border),
                ]),
            );
        }
        put(
            frame,
            card.y + i32::from(preview_rows) - 1,
            Line::styled(format!("└{}┘", "─".repeat(w.saturating_sub(2))), border),
        );
        let mut y = card.y + i32::from(preview_rows);
        let title_style = if selected {
            Style::new().fg(p.sage).add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(p.bright)
        };
        put(
            frame,
            y,
            Line::styled(clip_text(&entry.title, w), title_style),
        );
        y += 1;
        put(
            frame,
            y,
            Line::styled(clip_text(&entry.meta, w), Style::new().fg(p.muted)),
        );
        y += 1;
        for text in wrap(&entry.description, w, DESCRIPTION_LINES) {
            put(frame, y, Line::styled(text, Style::new().fg(p.ink)));
            y += 1;
        }
    }

    fn layout_and_draw(&mut self, frame: &mut Frame) -> Geometry {
        let p = palette();
        let area = frame.area();
        frame.render_widget(Block::new().style(Style::new().bg(p.bg).fg(p.ink)), area);
        let (cw, ch) = (self.cell.0.max(1.0), self.cell.1.max(1.0));
        let pad = ((PAD_PX / cw).round() as u16).max(1);
        let inner = Rect::new(pad, 0, area.width.saturating_sub(pad * 2), area.height);
        let mut controls = Vec::new();
        let header_rows = self.draw_header(frame, inner, &mut controls);
        let footer_rows = if area.height > 24 { 3 } else { 2 };
        let gallery = Rect::new(
            inner.x,
            header_rows,
            inner.width,
            area.height.saturating_sub(header_rows + footer_rows),
        );
        self.draw_footer(
            frame,
            Rect::new(
                inner.x,
                area.height.saturating_sub(footer_rows),
                inner.width,
                footer_rows,
            ),
        );

        let (gap_px, max) = if self.view.expanded {
            (GAP_EXPANDED_PX, COLUMNS_EXPANDED)
        } else {
            (GAP_DOCKED_PX, COLUMNS_DOCKED)
        };
        let width_px = f32::from(gallery.width) * cw;
        let columns = columns_for(width_px, gap_px, CARD_MIN_PX, max);
        let gap = ((gap_px / cw).round() as u16).max(1);
        let card_w = (gallery.width.saturating_sub(gap * (columns as u16 - 1))) / columns as u16;
        // The preview keeps the artboard's aspect in pixels, then rounds to rows.
        let preview_rows =
            ((f32::from(card_w.saturating_sub(2)) * cw * ART_H / ART_W) / ch).round() as u16 + 2;
        let card_rows = preview_rows + 2 + DESCRIPTION_LINES as u16 + 1;
        self.columns = columns;
        self.card_rows = card_rows;
        self.gallery_rows = gallery.height.max(1);
        // Keep the selection in view across a resize.
        if let Some(index) = self.index_of_selected() {
            self.reveal(index);
        }
        self.scroll_by(0);

        let mut slots = Vec::new();
        if self.view.entries.is_empty() && gallery.height > 0 {
            let text = if self.view.query.is_empty() {
                "Nothing in this collection yet."
            } else {
                "No artifact matches this search."
            };
            frame.render_widget(
                Paragraph::new(Span::styled(text, Style::new().fg(p.muted))),
                Rect::new(gallery.x, gallery.y + 1, gallery.width, 1),
            );
        }
        let entries = self.view.entries.clone();
        for (index, entry) in entries.iter().enumerate() {
            let (r, c) = ((index / columns) as u16, (index % columns) as u16);
            let top = i32::from(r * card_rows) - i32::from(self.scroll);
            let bottom = top + i32::from(card_rows);
            if bottom <= 0 || top >= i32::from(gallery.height) {
                continue;
            }
            let y = i32::from(gallery.y) + top;
            let x = gallery.x + c * (card_w + gap);
            self.draw_card(frame, entry, index, (x, y, card_w), preview_rows, gallery);
            slots.push(Slot {
                key: entry.key.clone(),
                revision: entry.revision.clone(),
                index,
                preview: Area {
                    x: i32::from(x) + 1,
                    y: y + 1,
                    w: card_w.saturating_sub(2),
                    h: preview_rows.saturating_sub(2),
                },
                card: Area {
                    x: x.into(),
                    y,
                    w: card_w,
                    h: card_rows - 1,
                },
                selected: self.selected.as_deref() == Some(entry.key.as_str()),
            });
        }
        Geometry {
            cell: (cw, ch),
            cols: area.width,
            rows: area.height,
            columns,
            clip: gallery.into(),
            slots,
            controls,
            selected: self.selected.clone(),
        }
    }
}

impl Drawn for Cabinet {
    fn set_cell(&mut self, cell: (f32, f32)) {
        self.cell = cell;
    }

    fn draw(&mut self, frame: &mut Frame) {
        let geometry = self.layout_and_draw(frame);
        if self.geometry.as_ref() != Some(&geometry) {
            self.geometry = Some(geometry);
            self.epoch += 1;
        }
    }

    fn drawn(&mut self) {
        if self.sent_epoch == self.epoch {
            return;
        }
        self.sent_epoch = self.epoch;
        if let Some(geometry) = &self.geometry {
            let json = json!({"epoch": self.epoch, "geometry": geometry}).to_string();
            let _ = self
                .on_geometry
                .call1(&JsValue::NULL, &JsValue::from_str(&json));
        }
    }
}

/// The mounted cabinet. React calls these from its own event handlers.
#[wasm_bindgen]
pub struct CabinetHandle {
    cabinet: Rc<RefCell<Cabinet>>,
    on_action: js_sys::Function,
}

#[wasm_bindgen]
impl CabinetHandle {
    fn emit(&self, action: Option<serde_json::Value>) {
        if let Some(action) = action {
            let _ = self
                .on_action
                .call1(&JsValue::NULL, &JsValue::from_str(&action.to_string()));
        }
    }

    /// Replaces the view (JSON of the controller's `CabinetView`).
    pub fn set_view(&self, json: &str) -> Result<(), JsValue> {
        self.cabinet
            .borrow_mut()
            .set_view(json)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// A key while a card has focus; true when the cabinet used it.
    pub fn key(&self, event: KeyboardEvent) -> bool {
        let (handled, action) = self.cabinet.borrow_mut().key(event.into());
        self.emit(action);
        handled
    }

    /// Selects a card the host focused or pressed, scrolling it into view.
    pub fn select(&self, key: &str) {
        let mut cabinet = self.cabinet.borrow_mut();
        if let Some(index) = cabinet.view.entries.iter().position(|e| e.key == key) {
            cabinet.select(index);
        }
    }

    /// Scrolls the gallery by rows (wheel, touch).
    pub fn scroll(&self, rows: i32) {
        self.cabinet.borrow_mut().scroll_by(rows);
    }

    /// The selected card's key, if any.
    pub fn selected(&self) -> Option<String> {
        self.cabinet.borrow().selected.clone()
    }
}

/// Mounts the cabinet into the element with `parent_id`. `on_action` hears
/// `{type: "select" | "open", key, revision?}`; `on_geometry` hears each new
/// geometry epoch. Frames run until the element leaves the page.
#[wasm_bindgen]
pub fn mount_cabinet(
    parent_id: &str,
    on_action: js_sys::Function,
    on_geometry: js_sys::Function,
) -> Result<CabinetHandle, JsValue> {
    let screen = Screen::new(parent_id)?;
    let cabinet = Rc::new(RefCell::new(Cabinet::new(on_geometry)));
    run_frames(screen, cabinet.clone());
    Ok(CabinetHandle { cabinet, on_action })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_follow_the_formula() {
        // 466 − 2×20 = 426 px docked: two cards of about 206 px.
        assert_eq!(columns_for(426.0, 14.0, 178.0, 2), 2);
        // A 340 px cabinet: one column.
        assert_eq!(columns_for(300.0, 14.0, 178.0, 2), 1);
        // Expanded caps at three.
        assert_eq!(columns_for(1400.0, 22.0, 178.0, 3), 3);
        assert_eq!(columns_for(10.0, 14.0, 178.0, 2), 1);
    }

    #[test]
    fn wrapping_keeps_words_and_marks_a_cut() {
        assert_eq!(
            wrap("a pale sky and a distant headland", 12, 3),
            ["a pale sky", "and a", "distant…"]
        );
        assert_eq!(wrap("short", 12, 3), ["short"]);
        assert_eq!(wrap("abcdefghijklmnop", 5, 2), ["abcde", "fghi…"]);
    }
}
