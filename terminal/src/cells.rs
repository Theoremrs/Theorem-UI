//! The cells an interactive view runs, shown as a terminal shows a command and
//! edited in place. Under the prompt's line, which names the view, the cells
//! are the editor's own text: the workbench editor's `SourceView` over an
//! `EditSession`, with its selection, undo and soft wrap but no line numbers
//! (a command's lines have none), coloured by the tokens the page's
//! highlighter gives for the text on screen. The page keeps the cells apart
//! in the text with Jupytext's percent markers (`// %%`), so a person splits
//! or joins cells by editing the lines.
//!
//! Keys reach the editor from the page's keydown; typed text, an IME's
//! committed text and a paste come through a hidden textarea the screen keeps
//! at the caret, as the workbench's does. Mod+Enter runs the cells as they
//! read; the row's end says while the view rebuilds, when it failed, and when
//! the text differs from what runs.

use std::{cell::RefCell, rc::Rc};

use keybinds::{Key, KeyInput, Mods};
use ratatui::{
    Frame,
    layout::{Margin, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph, Widget, Wrap},
};
use ratzilla::web_sys::KeyboardEvent;
use serde::Deserialize;
use theorem_workbench_core::{Button, PanelPointer, PointerKind, keys::Platform};
use theorem_workbench_editor::{Clipboard, EditorStyles, Mark, Paint, SourceView};
use theorem_workbench_text::{EditSession, SessionConfig, layout::line_rows, render::Caret};
use unicode_width::UnicodeWidthStr;
use wasm_bindgen::prelude::*;

use crate::{
    BLINK_MS, CaretStyle, Drawn, FrameLoop, PROMPT, Palette, Screen, Token, clipboard_write, now,
    palette, run_frames, spinner,
    workbench::{Modifiers, is_bare_printable, key_inputs, platform_of, theme_of},
};

/// Rows of cells shown before the editor scrolls within them.
const FOLD: u16 = 16;
/// The label of the hidden textarea the page puts beside the grid.
pub const FIELD_LABEL: &str = "View cells input";

/// What React pushes in besides the text: what the row says and whether the cells show.
#[derive(Deserialize, Default, PartialEq, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Head {
    title: String,
    /// `running` while the view rebuilds, `error` when it failed; anything else is at rest.
    status: String,
    /// Why the view failed, shown under the cells.
    error: String,
    open: bool,
    still: bool,
}

/// What a key, a paste or typed text did, for the handle to tell the page once the view is free.
#[derive(Debug, Default, PartialEq, Eq)]
struct Done {
    consumed: bool,
    edited: bool,
    run: bool,
}

/// A pointer event in CSS pixels from the grid's top left.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PointerInput {
    #[serde(rename = "type")]
    kind: String,
    x: f64,
    y: f64,
    #[serde(default)]
    shift_key: bool,
    #[serde(default)]
    detail: u8,
}

/// The highlighter's tokens as marks on `text`, in scalar offsets, when they
/// were made for exactly that text; none for any other.
fn marks_of(lines: &[Vec<Token>], text: &str, styles: &EditorStyles) -> Vec<Mark> {
    let mut marks = Vec::new();
    let mut seen = String::with_capacity(text.len());
    let mut at = 0;
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            seen.push('\n');
            at += 1;
        }
        for token in line {
            let len = token.t.chars().count();
            if let Some(class) = token.c.as_deref() {
                marks.push(Mark {
                    start: at,
                    end: at + len,
                    style: styles.class(class),
                });
            }
            seen.push_str(&token.t);
            at += len;
        }
    }
    if seen == text { marks } else { Vec::new() }
}

/// The ending of the prompt's line: the spinner while the view rebuilds, a
/// cross when it failed, a dot while the text differs from what runs.
fn ending(head: &Head, edited: bool, p: &Palette) -> Vec<Span<'static>> {
    let mut end = Vec::new();
    if edited {
        end.push(Span::styled("●", Style::new().fg(p.muted)));
    }
    match head.status.as_str() {
        "running" => end.push(Span::styled(spinner(), Style::new().fg(p.accent))),
        "error" => end.push(Span::styled("✗", Style::new().fg(p.error))),
        _ => {}
    }
    if end.len() == 2 {
        end.insert(1, Span::raw(" "));
    }
    end
}

/// One view's cells, editable.
struct CellsView {
    head: Head,
    session: EditSession,
    view: SourceView,
    /// The text the view runs: the agent's, or the person's once they ran it.
    ran: String,
    /// Settled edits, so the session's own queue stays empty.
    revision: u64,
    tokens: Vec<Vec<Token>>,
    styles: EditorStyles,
    styled_by: Option<Palette>,
    focused: bool,
    typed_at: f64,
    cell: (f32, f32),
    caret: Option<Caret>,
    /// What the last frame drew from; a frame that matches it is skipped.
    drawn_for: Option<(Rect, Palette)>,
    /// Something drawn changed since the last frame.
    changed: bool,
    reported: u16,
    on_rows: Option<js_sys::Function>,
}

fn session_of(text: &str) -> EditSession {
    EditSession::new(text, 0, SessionConfig::new("cells"))
}

impl CellsView {
    fn new(on_rows: Option<js_sys::Function>) -> Self {
        let mut view = SourceView::new();
        view.set_gutter(false);
        Self {
            head: Head::default(),
            session: session_of(""),
            view,
            ran: String::new(),
            revision: 0,
            tokens: Vec::new(),
            styles: EditorStyles::plain(),
            styled_by: None,
            focused: false,
            typed_at: 0.0,
            cell: (0.0, 0.0),
            caret: None,
            drawn_for: None,
            changed: true,
            reported: 0,
            on_rows,
        }
    }

    fn set_state(&mut self, json: &str) -> Result<(), serde_json::Error> {
        let head: Head = serde_json::from_str(json)?;
        if head != self.head {
            self.head = head;
            self.changed = true;
        }
        Ok(())
    }

    /// The cells as the agent wrote them: the editor starts over on them, and they are what runs.
    fn set_source(&mut self, text: &str) {
        if text == self.ran && text == self.session.text() {
            return;
        }
        self.session = session_of(text);
        self.ran = text.to_owned();
        self.changed = true;
    }

    fn set_tokens(&mut self, json: &str) -> Result<(), serde_json::Error> {
        self.tokens = serde_json::from_str(json)?;
        self.changed = true;
        Ok(())
    }

    fn edited(&self) -> bool {
        self.session.text() != self.ran
    }

    /// Hands the session's edits back as accepted: nothing else owns this text.
    fn settle(&mut self) {
        while let Some(edit) = self.session.take_next_to_send() {
            self.revision += 1;
            let _ = self.session.acknowledge(&edit.op_id, self.revision);
        }
    }

    fn after(&mut self, edited: bool, moved: bool) {
        if edited {
            self.settle();
        }
        if edited || moved {
            self.typed_at = now();
            self.changed = true;
        }
    }

    /// A keydown. Bare characters are left to the textarea, so a layout's or an IME's text
    /// arrives as typed; Mod+Enter runs the cells; a paste is left to the page's paste event.
    fn press(&mut self, reported: Option<KeyInput>, positional: Option<KeyInput>) -> Done {
        let Some(input) = reported else {
            return Done::default();
        };
        let mods = input.mods();
        if matches!(input.key(), Key::Enter) && mods.intersects(Mods::CMD | Mods::CTRL) {
            self.ran = self.session.text();
            self.changed = true;
            return Done {
                consumed: true,
                run: true,
                ..Done::default()
            };
        }
        if is_bare_printable(&input) || matches!(input.key(), Key::Tab | Key::Esc) {
            return Done::default();
        }
        let mut reaction = self.view.key(&mut self.session, &input);
        if !reaction.handled
            && let Some(positional) = positional
        {
            reaction = self.view.key(&mut self.session, &positional);
        }
        match reaction.clipboard {
            Some(Clipboard::Paste) => return Done::default(),
            Some(Clipboard::Copy) => {
                if let Some(text) = self.session.selected_text() {
                    let _ = clipboard_write(&text);
                }
            }
            Some(Clipboard::Cut) => {
                if let Some(text) = self.session.selected_text()
                    && clipboard_write(&text).is_ok()
                    && self.session.cut().is_ok()
                {
                    reaction.edited = true;
                }
            }
            None => {}
        }
        self.after(reaction.edited, reaction.moved);
        Done {
            consumed: reaction.handled,
            edited: reaction.edited,
            run: false,
        }
    }

    fn type_text(&mut self, text: &str) -> Done {
        let reaction = self.view.text(&mut self.session, text);
        self.after(reaction.edited, reaction.moved);
        Done {
            consumed: true,
            edited: reaction.edited,
            run: false,
        }
    }

    fn paste(&mut self, text: &str) -> Done {
        let reaction = self.view.paste(&mut self.session, text);
        self.after(reaction.edited, reaction.moved);
        Done {
            consumed: true,
            edited: reaction.edited,
            run: false,
        }
    }

    /// A pointer event over the grid. The prompt's row is the page's (it opens and closes
    /// the cells); under it the editor places the caret, selects and scrolls.
    fn pointer(&mut self, input: &PointerInput) {
        let (width, height) = self.cell;
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        let col = (input.x / f64::from(width)).floor() as i32;
        let row = (input.y / f64::from(height)).floor() as i32;
        let kind = match input.kind.as_str() {
            "down" => PointerKind::Down(Button::Left),
            "up" => PointerKind::Up(Button::Left),
            "move" => PointerKind::Move,
            _ => return,
        };
        if matches!(kind, PointerKind::Down(_)) && row < 1 {
            return;
        }
        let mods = if input.shift_key {
            Mods::SHIFT
        } else {
            Mods::NONE
        };
        let reaction = self.view.pointer(
            &mut self.session,
            PanelPointer {
                kind,
                // The margin's column and the prompt's row come before the editor's cells.
                x: col - 1,
                y: row - 1,
                mods,
                clicks: input.detail.max(1),
            },
        );
        self.after(false, reaction.moved);
    }

    /// Scrolls the cells; positive is down. True when they moved.
    fn scroll(&mut self, lines: i32) -> bool {
        let before = self.session.scroll();
        self.view.scroll_by(&mut self.session, lines);
        let moved = self.session.scroll() != before;
        self.changed |= moved;
        moved
    }

    /// The rows the cells take wrapped at `width` columns of the grid.
    fn text_rows(&self, width: u16) -> u16 {
        let content = width
            .saturating_sub(2)
            .saturating_sub(self.view.gutter(&self.session));
        let tab = self.session.config().tab_width;
        let rope = self.session.rope();
        let rows: usize = (0..self.session.coords().line_count())
            .map(|line| line_rows(rope, line, usize::from(content), tab).len())
            .sum();
        u16::try_from(rows.max(1)).unwrap_or(u16::MAX)
    }

    fn error_lines(&self, width: u16) -> Vec<Line<'static>> {
        let error = self.head.error.trim();
        if error.is_empty() || width == 0 {
            return Vec::new();
        }
        let p = palette();
        let text = format!("✗ {error}");
        let width = usize::from(width);
        let mut lines = Vec::new();
        let mut row = String::new();
        for c in text.chars() {
            if c == '\n' || row.width() + unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) > width {
                lines.push(Line::styled(std::mem::take(&mut row), Style::new().fg(p.error)));
                if c == '\n' {
                    continue;
                }
            }
            row.push(c);
        }
        if !row.is_empty() {
            lines.push(Line::styled(row, Style::new().fg(p.error)));
        }
        lines
    }

    /// The rows the view wants at `width`: its line, and while open its cells up to the
    /// fold and why it failed.
    fn wanted(&self, width: u16) -> u16 {
        if !self.head.open {
            return 1;
        }
        let inner = width.saturating_sub(2);
        let errors = u16::try_from(self.error_lines(inner).len()).unwrap_or(u16::MAX);
        1 + self.text_rows(width).min(FOLD) + errors
    }

    fn report(&mut self, width: u16) {
        let wanted = self.wanted(width);
        if wanted != self.reported {
            self.reported = wanted;
            if let Some(on_rows) = &self.on_rows {
                let _ = on_rows.call1(&JsValue::NULL, &JsValue::from(wanted));
            }
        }
    }

    fn head_line(&self, width: u16) -> Line<'static> {
        let p = palette();
        let end = ending(&self.head, self.edited(), &p);
        let end_cols: usize = end.iter().map(|span| span.content.width()).sum();
        let room = usize::from(width).saturating_sub(PROMPT.width() + end_cols + 1);
        let mut title: String = String::new();
        for c in self.head.title.replace('\n', " ").chars() {
            if title.width() + unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) > room {
                title.pop();
                title.push('…');
                break;
            }
            title.push(c);
        }
        let fill = usize::from(width).saturating_sub(PROMPT.width() + title.width() + end_cols);
        let mut spans = vec![
            Span::styled(PROMPT, Style::new().fg(p.accent)),
            Span::styled(title, Style::new().fg(p.bright).add_modifier(Modifier::BOLD)),
            Span::raw(" ".repeat(fill)),
        ];
        spans.extend(end);
        Line::from(spans)
    }

    fn draw(&mut self, frame: &mut Frame) {
        let p = palette();
        if self.styled_by != Some(p) {
            self.styles = EditorStyles::from_theme(&theme_of(&p));
            self.styled_by = Some(p);
        }
        let area = frame.area();
        // The cells sit on the canvas the agent terminal's conversation sits on.
        frame.render_widget(
            Block::new().style(Style::new().bg(p.canvas()).fg(p.ink)),
            area,
        );
        let inner = area.inner(Margin::new(1, 0));
        frame.render_widget(self.head_line(inner.width), Rect { height: 1, ..inner });
        self.caret = None;
        if self.head.open && inner.height > 1 {
            let errors = self.error_lines(inner.width);
            let error_rows = u16::try_from(errors.len()).unwrap_or(u16::MAX);
            let rows = (inner.height - 1).saturating_sub(error_rows).max(1);
            let code = Rect {
                y: inner.y + 1,
                height: rows.min(self.text_rows(area.width).min(FOLD)).max(1),
                ..inner
            };
            self.view.resize(&mut self.session, code.width, code.height);
            let text = self.session.text();
            let marks = marks_of(&self.tokens, &text, &self.styles);
            // The caret is the screen's bar over the grid (`text_caret`), which blinks without
            // drawing the grid again; the editor's own block at the caret would be a second one.
            let mut paint = Paint::new(&self.styles);
            paint.tokens = &marks;
            self.caret = self
                .view
                .draw(&self.session, code, frame.buffer_mut(), &paint);
            if !errors.is_empty() {
                let below = Rect {
                    y: code.bottom(),
                    height: inner.bottom().saturating_sub(code.bottom()),
                    ..inner
                };
                Paragraph::new(errors)
                    .wrap(Wrap { trim: false })
                    .render(below, frame.buffer_mut());
            }
        }
        self.drawn_for = Some((area, p));
        self.changed = false;
        self.report(area.width);
    }
}

impl Drawn for CellsView {
    fn set_cell(&mut self, cell: (f32, f32)) {
        self.cell = cell;
    }

    fn draw(&mut self, frame: &mut Frame) {
        CellsView::draw(self, frame);
    }

    /// A bar at the caret while the cells have the keyboard, blinking unless the person asked
    /// for less motion; the hidden textarea sits on the same cell, so an IME opens there.
    fn text_caret(&self, now: f64) -> Option<CaretStyle> {
        let caret = self.caret.filter(|_| self.focused)?;
        let lit = self.head.still || (((now - self.typed_at) / BLINK_MS) as u64).is_multiple_of(2);
        let ink = if lit {
            palette().accent.to_string()
        } else {
            "transparent".to_owned()
        };
        let (width, height) = self.cell;
        let (left, top) = (f32::from(caret.x) * width, f32::from(caret.y) * height);
        Some(CaretStyle {
            overlay: format!(
                "position:absolute;pointer-events:none;box-sizing:border-box;background:{ink};\
                 width:2px;left:{left}px;top:{top}px;height:{height}px"
            ),
            field: format!("left:{left}px;top:{top}px;width:{width}px;height:{height}px"),
        })
    }

    /// Draws again only when the cells, what the row says, the size or the colours change,
    /// and each frame while the view rebuilds, for its spinner.
    fn wants_frame(&mut self, area: Rect) -> bool {
        self.changed
            || self.head.status == "running"
            || self.drawn_for != Some((area, palette()))
    }

    fn repaint(&mut self) {
        self.drawn_for = None;
    }
}

/// The mounted cells. React calls these from its own effects and handlers.
#[wasm_bindgen]
pub struct CellsHandle {
    _frames: Rc<FrameLoop>,
    view: Rc<RefCell<CellsView>>,
    platform: Platform,
    on_edit: js_sys::Function,
    on_run: js_sys::Function,
}

impl CellsHandle {
    /// Tells the page what changed, after the view is free again, so its handlers may call in.
    fn told(&self, done: Done) -> bool {
        if done.run || done.edited {
            let text = JsValue::from_str(&self.view.borrow().session.text());
            let callback = if done.run { &self.on_run } else { &self.on_edit };
            let _ = callback.call1(&JsValue::NULL, &text);
        }
        done.consumed
    }
}

#[wasm_bindgen]
impl CellsHandle {
    /// What the row says (JSON: `title`, `status`, `error`, `open`, `still`).
    pub fn set_state(&self, json: &str) -> Result<(), JsValue> {
        self.view
            .borrow_mut()
            .set_state(json)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// The cells as the agent wrote them, which the editor starts over on.
    pub fn set_source(&self, text: &str) {
        self.view.borrow_mut().set_source(text);
    }

    /// The highlighter's lines of `{t, c}` tokens for the text the page last heard.
    pub fn set_tokens(&self, json: &str) -> Result<(), JsValue> {
        self.view
            .borrow_mut()
            .set_tokens(json)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// A keydown on the hidden textarea; true when the cells took it and the page should
    /// `preventDefault`.
    pub fn key(&self, event: KeyboardEvent) -> bool {
        let mods = Modifiers::of(&event).mods(self.platform);
        let (reported, positional) = key_inputs(&event.key(), &event.code(), mods, self.platform);
        let done = self.view.borrow_mut().press(reported, positional);
        self.told(done)
    }

    /// Text the textarea took: typed characters or an IME's committed text.
    pub fn text(&self, text: &str) {
        let done = self.view.borrow_mut().type_text(text);
        self.told(done);
    }

    pub fn paste(&self, text: &str) {
        let done = self.view.borrow_mut().paste(text);
        self.told(done);
    }

    /// A pointer event (JSON `{type: "down" | "move" | "up", x, y, shiftKey?, detail?}`, in
    /// CSS pixels from the grid's top left).
    pub fn pointer(&self, json: &str) -> Result<(), JsValue> {
        let input: PointerInput =
            serde_json::from_str(json).map_err(|error| JsValue::from_str(&error.to_string()))?;
        self.view.borrow_mut().pointer(&input);
        Ok(())
    }

    /// Scrolls the cells; positive is down. True when they moved, so the page keeps the wheel
    /// only then.
    pub fn scroll(&self, lines: i32) -> bool {
        self.view.borrow_mut().scroll(lines)
    }

    pub fn set_focused(&self, focused: bool) {
        let mut view = self.view.borrow_mut();
        view.focused = focused;
        view.typed_at = now();
    }

    /// The cells as they read now.
    pub fn text_now(&self) -> String {
        self.view.borrow().session.text()
    }
}

/// Mounts one view's cells into the element with `parent_id`, which it fills;
/// the textarea labelled `FIELD_LABEL` beside it takes the typing. `on_rows`
/// hears how many rows the cells want whenever that changes, from the frame,
/// so it must not call back in. `on_edit` hears the text after each edit and
/// `on_run` the text the person ran, after the cells are free again.
#[wasm_bindgen]
pub fn mount_cells(
    parent_id: &str,
    on_rows: js_sys::Function,
    on_edit: js_sys::Function,
    on_run: js_sys::Function,
) -> Result<CellsHandle, JsValue> {
    let screen = Screen::with_field(parent_id, FIELD_LABEL)?;
    let platform = platform_of(&screen.window);
    let view = Rc::new(RefCell::new(CellsView::new(Some(on_rows))));
    let frames = run_frames(screen, view.clone());
    Ok(CellsHandle {
        _frames: frames,
        view,
        platform,
        on_edit,
        on_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer, style::Color};

    fn cells(source: &str, open: bool) -> CellsView {
        let mut view = CellsView::new(None);
        view.set_source(source);
        view.set_state(
            &serde_json::json!({ "title": "Sales by region", "open": open, "still": true })
                .to_string(),
        )
        .unwrap();
        view
    }

    fn drawn(view: &mut CellsView, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn rows(buf: &Buffer) -> Vec<String> {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol().to_owned())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    fn key(view: &mut CellsView, key: Key, mods: Mods) -> Done {
        view.press(Some(KeyInput::new(key, mods)), None)
    }

    #[test]
    fn the_line_names_the_view_and_the_cells_show_under_it() {
        let mut view = cells("// %%\nconst x = 1\n\n// %%\nx * 2", true);
        let shown = rows(&drawn(&mut view, 40, 7));
        // The prompt is the line's one pointer (the page turns it down while open).
        assert_eq!(shown[0], " ❯ Sales by region", "{shown:?}");
        assert!(shown[1].contains("// %%"), "{shown:?}");
        assert!(shown[2].contains("const x = 1"), "{shown:?}");
        assert!(shown[5].contains("x * 2"), "{shown:?}");
    }

    #[test]
    fn closed_it_wants_its_line_and_open_its_cells_up_to_the_fold() {
        let mut view = cells("a\nb\nc", false);
        assert_eq!(view.wanted(40), 1);
        view.set_state(&serde_json::json!({ "open": true }).to_string()).unwrap();
        assert_eq!(view.wanted(40), 4);
        let long = (0..40).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        view.set_source(&long);
        assert_eq!(view.wanted(40), 1 + FOLD);
    }

    #[test]
    fn typing_edits_the_cells_and_marks_them_unrun_until_run() {
        let mut view = cells("x", true);
        assert!(!view.edited());
        // A bare character is the textarea's, so it arrives as text.
        assert_eq!(key(&mut view, Key::Char('y'), Mods::NONE), Done::default());
        let typed = view.type_text("y");
        assert!(typed.edited);
        assert_eq!(view.session.text(), "yx");
        assert!(view.edited());
        let shown = rows(&drawn(&mut view, 40, 2));
        assert!(shown[0].contains('●'), "{shown:?}");
        let ran = key(&mut view, Key::Enter, Mods::CMD);
        assert!(ran.run && ran.consumed);
        assert!(!view.edited());
        let shown = rows(&drawn(&mut view, 40, 2));
        assert!(!shown[0].contains('●'), "{shown:?}");
    }

    #[test]
    fn editing_keys_go_to_the_editor_and_undo_takes_them_back() {
        let mut view = cells("abc", true);
        assert!(key(&mut view, Key::End, Mods::NONE).consumed);
        let done = key(&mut view, Key::Backspace, Mods::NONE);
        assert!(done.consumed && done.edited);
        assert_eq!(view.session.text(), "ab");
        assert!(key(&mut view, Key::Char('z'), Mods::CMD).edited);
        assert_eq!(view.session.text(), "abc");
        let enter = key(&mut view, Key::Enter, Mods::NONE);
        assert!(enter.edited);
        assert!(view.session.text().contains('\n'));
    }

    #[test]
    fn tab_escape_and_paste_are_left_to_the_page() {
        let mut view = cells("abc", true);
        assert!(!key(&mut view, Key::Tab, Mods::NONE).consumed);
        assert!(!key(&mut view, Key::Esc, Mods::NONE).consumed);
        assert!(!key(&mut view, Key::Char('v'), Mods::CMD).consumed);
        assert_eq!(view.session.text(), "abc");
        view.paste("z");
        assert_eq!(view.session.text(), "zabc");
    }

    #[test]
    fn new_cells_from_the_agent_start_the_editor_over() {
        let mut view = cells("old", true);
        view.type_text("edit ");
        view.set_source("new");
        assert_eq!(view.session.text(), "new");
        assert!(!view.edited());
    }

    #[test]
    fn tokens_colour_only_the_text_they_were_made_for() {
        let styles = EditorStyles::plain();
        let lines: Vec<Vec<Token>> = serde_json::from_value(serde_json::json!([
            [{ "t": "const", "c": "keyword" }, { "t": " x" }],
            [{ "t": "1", "c": "number" }]
        ]))
        .unwrap();
        let marks = marks_of(&lines, "const x\n1", &styles);
        assert_eq!(marks.len(), 2);
        assert_eq!((marks[0].start, marks[0].end), (0, 5));
        assert_eq!((marks[1].start, marks[1].end), (8, 9));
        assert!(marks_of(&lines, "const y\n1", &styles).is_empty());
    }

    #[test]
    fn the_row_says_when_the_view_rebuilds_or_failed_and_why() {
        let mut view = cells("x", true);
        view.set_state(
            &serde_json::json!({ "title": "T", "open": true, "status": "error", "error": "x is not defined" })
                .to_string(),
        )
        .unwrap();
        assert_eq!(view.wanted(40), 3);
        let shown = rows(&drawn(&mut view, 40, 3));
        assert!(shown[0].ends_with('✗'), "{shown:?}");
        assert!(shown[2].contains("✗ x is not defined"), "{shown:?}");
    }

    #[test]
    fn a_click_under_the_line_places_the_caret() {
        let mut view = cells("abc\ndef", true);
        view.cell = (8.0, 16.0);
        drawn(&mut view, 40, 3);
        let gutter = f64::from(view.view.gutter(&view.session));
        // Row 2 is the second line; the margin and the gutter come before its text.
        view.pointer(&PointerInput {
            kind: "down".into(),
            x: (1.0 + gutter + 2.0) * 8.0 + 1.0,
            y: 2.0 * 16.0 + 1.0,
            shift_key: false,
            detail: 1,
        });
        assert_eq!(view.session.cursor(), 6);
    }

    #[test]
    fn a_long_title_is_cut_before_the_ending() {
        let mut view = cells("x", false);
        view.set_state(&serde_json::json!({ "title": "a".repeat(80) }).to_string())
            .unwrap();
        let shown = rows(&drawn(&mut view, 30, 1));
        assert!(shown[0].ends_with('…'), "{shown:?}");
    }
    #[test]
    fn the_cells_sit_on_the_agent_terminals_canvas() {
        let canvas = Color::Rgb(0x12, 0x12, 0x12);
        let mut laddered = palette();
        laddered.canvas = Some(canvas);
        crate::PALETTE.set(laddered);
        let buf = drawn(&mut cells("const x = 1", true), 24, 3);
        assert_eq!(buf[(0, 0)].bg, canvas, "the prompt's line");
        assert_eq!(buf[(23, 2)].bg, canvas, "under the cells");
    }
}
