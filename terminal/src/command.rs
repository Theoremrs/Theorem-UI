//! One command an agent ran, shown as a terminal shows it: the command on the
//! prompt's line with how it ended, and under it what it printed, read by the
//! VT interpreter the workbench's process panes use, so a program's own
//! colours and line rewrites show as they would in a shell. Nothing here takes
//! typing: the command ran, or is running, elsewhere.
//!
//! While it runs it reads as assistant-ui's Reasoning element reads while it
//! thinks: a band of light crosses the command, the time it has taken counts
//! up beside its spinner, and the output holds to its newest line unless the
//! reader scrolls back, its edges fading where more is out of view. The page
//! opens and closes the output and turns the prompt down while it shows.

use std::{cell::RefCell, rc::Rc};

use ratatui::{
    Frame,
    buffer::{Buffer, Cell},
    layout::{Constraint, Layout, Margin, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Widget},
};
use serde::Deserialize;
use theorem_workbench_core::caret::escaped;
use theorem_workbench_vt::{Palette as VtPalette, Screen as VtScreen, TerminalView};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
use wasm_bindgen::prelude::*;

use crate::{
    Drawn, FrameLoop, PROMPT, Palette, Screen, now, palette, run_frames, spinner,
    workbench::ansi_of,
};

/// Output rows shown before the older ones scroll back; the newest stay in view.
const FOLD: u16 = 6;
/// Frames the view holds its last frame while its output wants rows the page
/// has not given it yet; past them it draws at the size it has.
const HOLD_FRAMES: u8 = 3;
/// Rows the measuring screen has; output past them is past the fold anyway.
const MEASURE_ROWS: u16 = 256;
/// The band of light's crossing and the rest before the next, as the Reasoning
/// element's label shimmers (surfaces.tsx: 1800 ms, then 600).
const SWEEP_MS: f64 = 1800.0;
const REST_MS: f64 = 600.0;
/// Columns either side of the band's middle that it lights.
const BAND: f64 = 4.0;
/// How far an edge row's text goes toward the ground where output is out of view.
const FADE: f32 = 0.55;
/// How far a program's faint text goes toward its ground, as half opacity took it.
const FAINT: f32 = 0.5;

/// What React pushes in: one command and what it printed.
#[derive(Deserialize, Default, PartialEq, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Run {
    command: String,
    stdout: String,
    stderr: String,
    /// running, awaiting, complete, error or interrupted.
    status: String,
    exit_code: Option<i32>,
    /// Whether the page shows what is under the command's line: the rest of a
    /// command too long for it, and the output.
    open: bool,
    /// The person asked for less motion: the command holds still while it runs.
    still: bool,
}

impl Run {
    fn running(&self) -> bool {
        matches!(self.status.as_str(), "running" | "awaiting")
    }

    /// The bytes a terminal would have read: standard output, then standard
    /// error in the error colour, each line ended as a terminal ends one.
    /// Nothing follows standard error, so the colour is left on, and more of
    /// either stream, while nothing printed after it, only adds bytes.
    fn bytes(&self) -> Vec<u8> {
        let crlf = |text: &str| {
            text.replace("\r\n", "\n")
                .trim_end_matches('\n')
                .replace('\n', "\r\n")
        };
        let mut out = crlf(&self.stdout);
        let stderr = crlf(&self.stderr);
        if !stderr.is_empty() {
            if !out.is_empty() {
                out.push_str("\r\n");
            }
            out.push_str("\x1b[31m");
            out.push_str(&stderr);
        }
        out.into_bytes()
    }
}

/// The last row on view with anything on it, or the cursor's row when that is
/// lower: a program that moved the cursor back up still printed the rows under it.
fn last_row(screen: &VtScreen) -> u16 {
    let written = screen
        .vt()
        .rows(0, screen.size().1)
        .enumerate()
        .filter(|(_, text)| !text.trim_end().is_empty())
        .last()
        .map_or(0, |(row, _)| u16::try_from(row).unwrap_or(u16::MAX));
    screen.cursor_position().0.max(written)
}

/// `text` in rows, the first `first` columns wide and the rest `rest`.
fn wrap(text: &str, first: usize, rest: usize) -> Vec<String> {
    let mut rows = vec![String::new()];
    let mut used = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        let room = if rows.len() == 1 { first } else { rest };
        if used > 0 && used + w > room {
            rows.push(String::new());
            used = 0;
        }
        rows.last_mut().expect("one row at least").push(c);
        used += w;
    }
    rows
}

/// The process panes' colours (workbench.rs) on the canvas the agent terminal's
/// conversation sits on.
fn vt_palette(p: &Palette) -> VtPalette {
    VtPalette {
        fg: p.ink,
        bg: p.canvas(),
        ansi: ansi_of(p),
        selection: Style::new().bg(p.selection),
        search_match: Style::new(),
        search_current: Style::new(),
    }
}

/// `text` cut to `room` columns, an ellipsis marking the cut.
fn fit(text: &str, room: usize) -> String {
    if text.width() <= room {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        if used + w + 1 > room {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('…');
    out
}

/// `from` taken `t` of the way to `to`. Colours that are not RGB switch halfway.
fn mix(from: Color, to: Color, t: f32) -> Color {
    match (from, to) {
        (Color::Rgb(r, g, b), Color::Rgb(r2, g2, b2)) => {
            let at = |a: u8, b: u8| {
                (f32::from(a) + (f32::from(b) - f32::from(a)) * t.clamp(0.0, 1.0)).round() as u8
            };
            Color::Rgb(at(r, r2), at(g, g2), at(b, b2))
        }
        _ if t < 0.5 => from,
        _ => to,
    }
}

/// How lit column `col` of a label `cols` wide is at `at` ms: 1 under the
/// band's middle, falling to 0 at its edges and while it rests.
fn shimmer(col: usize, cols: usize, at: f64) -> f32 {
    let t = at.rem_euclid(SWEEP_MS + REST_MS);
    if t >= SWEEP_MS {
        return 0.0;
    }
    let middle = -BAND + (cols as f64 + 2.0 * BAND) * t / SWEEP_MS;
    let off = (col as f64 + 0.5 - middle).abs();
    if off >= BAND {
        return 0.0;
    }
    (0.5 * (1.0 + (std::f64::consts::PI * off / BAND).cos())) as f32
}

/// A time as the row says it: under a second, seconds, minutes, hours.
fn said(ms: f64) -> String {
    match (ms.max(0.0) / 1000.0) as u64 {
        0 => "<1s".to_owned(),
        s @ 1..60 => format!("{s}s"),
        s @ 60..3600 => format!("{}m {}s", s / 60, s % 60),
        s => format!("{}h {}m", s / 3600, s % 3600 / 60),
    }
}

/// The command as the row shows it: bright once it has ended; while it runs,
/// muted with the band of light crossing it, or held muted where the person
/// asked for less motion.
fn command_spans(text: String, run: &Run, p: &Palette, at: f64) -> Vec<Span<'static>> {
    if !run.running() {
        return vec![Span::styled(text, Style::new().fg(p.bright))];
    }
    if run.still {
        return vec![Span::styled(text, Style::new().fg(p.muted))];
    }
    let cols = text.width();
    let mut col = 0;
    text.chars()
        .map(|c| {
            let lit = shimmer(col, cols, at);
            col += c.width().unwrap_or(0);
            Span::styled(c.to_string(), Style::new().fg(mix(p.muted, p.bright, lit)))
        })
        .collect()
}

/// `cell`'s text taken `t` of the way toward its ground.
fn toward_ground(cell: &mut Cell, p: &Palette, t: f32) {
    let ground = if cell.bg == Color::Reset {
        p.canvas()
    } else {
        cell.bg
    };
    let ink = if cell.fg == Color::Reset {
        p.ink
    } else {
        cell.fg
    };
    cell.fg = mix(ink, ground, t);
}

/// Row `y` of `area`, its text taken toward its ground as a fade's end would be.
fn fade(buf: &mut Buffer, area: Rect, y: u16, p: &Palette) {
    for x in area.x..area.right() {
        toward_ground(&mut buf[(x, y)], p, FADE);
    }
}

/// What a program printed faint, muted in its colour. The terminal type draws
/// DIM at full opacity in a lighter weight (cell-grid.css), since the agent's
/// own secondary text is muted already; a program's is not, so its colour goes
/// half way to its ground, as half opacity drew it, and the ground stays whole.
/// A colour that is not RGB keeps its letters and the lighter weight.
fn faint(cell: &mut Cell, p: &Palette) {
    if cell.modifier.contains(Modifier::DIM)
        && matches!(cell.fg, Color::Rgb(..) | Color::Reset)
        && matches!(cell.bg, Color::Rgb(..) | Color::Reset)
    {
        toward_ground(cell, p, FAINT);
    }
}

/// The row's end: the spinner while it runs, then how it ended, the exit
/// code named only when it is not zero.
fn ending(run: &Run, p: &Palette) -> Vec<Span<'static>> {
    if run.running() {
        return vec![Span::styled(spinner(), Style::new().fg(p.accent))];
    }
    if run.status == "interrupted" {
        return vec![Span::styled("⊘", Style::new().fg(p.warning))];
    }
    match run.exit_code.filter(|&code| code != 0) {
        Some(code) => vec![
            Span::styled("✗", Style::new().fg(p.error)),
            Span::styled(format!(" exit {code}"), Style::new().fg(p.muted)),
        ],
        None if run.status == "error" => vec![Span::styled("✗", Style::new().fg(p.error))],
        None => vec![Span::styled("✓", Style::new().fg(p.success))],
    }
}

/// One command's terminal.
struct CommandView {
    run: Run,
    /// The run's output as a terminal reads it (`Run::bytes`), as the screens have it.
    bytes: Vec<u8>,
    /// The output read at the size it was last drawn at.
    screen: Option<((u16, u16), VtScreen)>,
    /// What the last frame drew from; a frame that matches it is skipped.
    drawn_for: Option<(Rect, Palette)>,
    /// The rows the page last heard the command wants, and whether its command
    /// is longer than its line.
    reported: (u16, bool),
    on_rows: Option<js_sys::Function>,
    /// The output changed other than by adding to it, so the screen reads it again.
    stale: bool,
    /// The output grew since the last frame.
    grew: bool,
    /// The output read at a width on a screen tall enough to count its rows.
    measure: Option<(u16, VtScreen)>,
    /// The rows the output takes at a width, kept until the output changes.
    measured: Option<(u16, u16)>,
    /// When this view first saw the command run, and how long it ran once it
    /// ended: results do not say.
    began: Option<f64>,
    took: Option<f64>,
    /// The rows the view is waiting for the page to give it, and the frames it has waited.
    waiting: Option<(u16, u8)>,
    /// The output's size at the last frame, and the row at its top, counted
    /// from the first row it printed.
    top: Option<((u16, u16), usize)>,
    /// Rows new output scrolled the view by in the last frame, which the page
    /// slides in; none when the reader had scrolled back or the size changed.
    scrolled: u16,
    on_scrolled: Option<js_sys::Function>,
}

impl CommandView {
    fn new(on_rows: Option<js_sys::Function>, on_scrolled: Option<js_sys::Function>) -> Self {
        Self {
            run: Run::default(),
            bytes: Vec::new(),
            screen: None,
            drawn_for: None,
            reported: (0, false),
            on_rows,
            stale: false,
            grew: false,
            measure: None,
            measured: None,
            began: None,
            took: None,
            waiting: None,
            top: None,
            scrolled: 0,
            on_scrolled,
        }
    }

    fn set_state(&mut self, json: &str) -> Result<(), serde_json::Error> {
        let run: Run = serde_json::from_str(json)?;
        self.time(&run, now());
        if run != self.run {
            if run.stdout != self.run.stdout || run.stderr != self.run.stderr {
                self.take_output(run.bytes());
            }
            self.run = run;
            self.drawn_for = None;
        }
        Ok(())
    }

    /// Takes the output's new bytes. Where they only add to what the screens
    /// read, the screens read on with what they add, which keeps a reader
    /// scrolled back on their lines however much old scrollback drops off;
    /// otherwise the screens read the output again from its start.
    fn take_output(&mut self, bytes: Vec<u8>) {
        match bytes.strip_prefix(self.bytes.as_slice()) {
            Some(added) if !self.stale => {
                if let Some((_, screen)) = &mut self.screen {
                    screen.feed(added);
                }
                if let Some((_, screen)) = &mut self.measure {
                    screen.feed(added);
                }
            }
            _ => {
                self.stale = true;
                self.measure = None;
            }
        }
        self.measured = None;
        self.bytes = bytes;
        self.grew = true;
    }

    /// Times the run from the first state that says it is running to the
    /// first that says it ended. Waiting for approval is not running.
    fn time(&mut self, run: &Run, at: f64) {
        if run.status == "running" {
            self.began.get_or_insert(at);
        } else if let (false, Some(began)) = (run.running(), self.began) {
            self.took.get_or_insert(at - began);
        }
    }

    /// How long it has run, or ran, as far as this view saw it run.
    fn elapsed(&self, at: f64) -> Option<f64> {
        if self.run.running() {
            return self.began.map(|began| at - began);
        }
        self.took
    }

    /// The rows the command wants at `width` columns, and whether its command
    /// is longer than its line: its own rows (one, or all the command takes
    /// while what is under it shows), and its output up to the fold. The page
    /// shows the output or not; its rows are the same either way, so opening
    /// reveals what is already drawn.
    fn wanted(&mut self, width: u16) -> (u16, bool) {
        let inner = width.saturating_sub(2);
        let (head, _, cut) = self.command_layout(inner, now());
        let head = u16::try_from(head.len()).unwrap_or(u16::MAX);
        (head.saturating_add(self.output_rows(inner).min(FOLD)), cut)
    }

    /// The rows the output takes at `cols` columns, wrapped lines counted.
    fn output_rows(&mut self, cols: u16) -> u16 {
        if self.bytes.is_empty() || cols == 0 {
            return 0;
        }
        if let Some((at, rows)) = self.measured
            && at == cols
        {
            return rows;
        }
        if self.measure.as_ref().is_none_or(|(at, _)| *at != cols) {
            let mut screen = VtScreen::new(MEASURE_ROWS, cols);
            screen.feed(&self.bytes);
            self.measure = Some((cols, screen));
        }
        let rows = last_row(&self.measure.as_ref().expect("read above").1) + 1;
        self.measured = Some((cols, rows));
        rows
    }

    /// The output read at `size`, kept until the output or the size changes. A
    /// new reading keeps how far back the person had scrolled, and a person
    /// scrolled back keeps reading the lines they were on as new ones arrive.
    fn screen_at(&mut self, size: (u16, u16)) -> &VtScreen {
        if self.stale || self.screen.as_ref().is_none_or(|(at, _)| *at != size) {
            let mut screen = VtScreen::new(size.0, size.1);
            screen.feed(&self.bytes);
            if let Some((at, before)) = self.screen.take() {
                let mut back = before.scrollback_offset();
                if back > 0 && at == size {
                    back += screen
                        .scrollback_len()
                        .saturating_sub(before.scrollback_len());
                }
                screen.scroll_up(back);
            }
            self.screen = Some((size, screen));
            self.stale = false;
        }
        &self.screen.as_ref().expect("read above").1
    }

    /// The command's rows at `width`, the line's end (the time it has taken,
    /// and how it ended),
    /// and whether the command is longer than its line has room for. Cut, it
    /// ends in an ellipsis; while what is under it shows, it goes on in rows of
    /// its own under where it starts, so the whole command can be read.
    fn command_layout(&self, width: u16, at: f64) -> (Vec<String>, Vec<Span<'static>>, bool) {
        let p = palette();
        let run = &self.run;
        let mut end = Vec::new();
        if let Some(ms) = self.elapsed(at) {
            end.push(Span::styled(
                format!("{} ", said(ms)),
                Style::new().fg(p.muted),
            ));
        }
        end.extend(ending(run, &p));
        let width = usize::from(width);
        let room = |end: &[Span]| {
            let end_cols: usize = end.iter().map(|span| span.content.width()).sum();
            width.saturating_sub(PROMPT.width() + end_cols + 1)
        };
        let command = escaped(&run.command.replace('\n', " "));
        let room = room(&end);
        let cut = command.width() > room;
        let rows = match (cut, run.open) {
            (false, _) => vec![command],
            (true, true) => wrap(&command, room, width.saturating_sub(PROMPT.width())),
            (true, false) => vec![fit(&command, room)],
        };
        (rows, end, cut)
    }

    /// The command on the prompt's line with the line's end at the right, and
    /// the rest of a command too long for it on the rows under it.
    fn command_rows(&self, width: u16, at: f64) -> Vec<Line<'static>> {
        let p = palette();
        let (rows, end, _) = self.command_layout(width, at);
        let end_cols: usize = end.iter().map(|span| span.content.width()).sum();
        let mut rows = rows.into_iter();
        let command = rows.next().unwrap_or_default();
        let fill = usize::from(width).saturating_sub(PROMPT.width() + command.width() + end_cols);
        let mut line = vec![Span::styled(PROMPT, Style::new().fg(p.accent))];
        line.extend(command_spans(command, &self.run, &p, at));
        line.push(Span::raw(" ".repeat(fill)));
        line.extend(end);
        let under = rows.map(|row| {
            let mut spans = vec![Span::raw(" ".repeat(PROMPT.width()))];
            spans.extend(command_spans(row, &self.run, &p, at));
            Line::from(spans)
        });
        std::iter::once(Line::from(line)).chain(under).collect()
    }

    /// Scrolls the output; positive is towards newer. True when it moved.
    fn scroll(&mut self, lines: i32) -> bool {
        let Some((_, screen)) = &mut self.screen else {
            return false;
        };
        let before = screen.scrollback_offset();
        if lines < 0 {
            screen.scroll_up(lines.unsigned_abs() as usize);
        } else {
            screen.scroll_down(lines as usize);
        }
        let moved = screen.scrollback_offset() != before;
        if moved {
            self.drawn_for = None;
        }
        moved
    }

    /// Whether the output can scroll `lines`' way (positive is towards newer):
    /// back while older rows are above the view, on while newer are below it.
    fn can_scroll(&self, lines: i32) -> bool {
        self.screen
            .as_ref()
            .is_some_and(|(_, screen)| match lines.signum() {
                -1 => screen.scrollback_offset() < screen.scrollback_len(),
                1 => screen.scrollback_offset() > 0,
                _ => false,
            })
    }

    fn draw(&mut self, frame: &mut Frame) {
        self.draw_at(frame, now());
    }

    fn draw_at(&mut self, frame: &mut Frame, at: f64) {
        let p = palette();
        let area = frame.area();
        frame.render_widget(
            Block::new().style(Style::new().bg(p.canvas()).fg(p.ink)),
            area,
        );
        let inner = area.inner(Margin::new(1, 0));
        let command = self.command_rows(inner.width, at);
        let command_rows = u16::try_from(command.len()).unwrap_or(u16::MAX);
        let [head, body] =
            Layout::vertical([Constraint::Length(command_rows), Constraint::Fill(1)]).areas(inner);
        frame.render_widget(Text::from(command), head);
        if body.width > 0 && body.height > 0 {
            // vt100 0.16 panics when a line wraps on a one-row screen, so the output is read
            // on two rows at least, and the rows shown end at the last one it wrote.
            let rows = body.height.max(2);
            let colours = vt_palette(&p);
            let grew = std::mem::take(&mut self.grew);
            let screen = self.screen_at((rows, body.width));
            let start = last_row(screen).min(rows - body.height);
            // Older output is out of view above, or newer below once the reader scrolled back.
            let above = start > 0 || screen.scrollback_len() > screen.scrollback_offset();
            let below = screen.scrollback_offset() > 0;
            let top = screen.scrollback_len() - screen.scrollback_offset() + usize::from(start);
            let mut read = Buffer::empty(Rect::new(0, 0, body.width, rows));
            TerminalView::new(screen, &colours)
                .show_cursor(false)
                .render(read.area, &mut read);
            let buf = frame.buffer_mut();
            for y in 0..body.height {
                for x in 0..body.width {
                    let mut cell = read[(x, start + y)].clone();
                    faint(&mut cell, &p);
                    buf[(body.x + x, body.y + y)] = cell;
                }
            }
            // A single row of output is left whole, and the newest row stays whole with one
            // above it, so a fade never takes the only line there is to read.
            if above && body.height >= 2 {
                fade(buf, body, body.y, &p);
            }
            if below && body.height >= 3 {
                fade(buf, body, body.bottom() - 1, &p);
            }
            // New lines that moved the newest output up, fewer than it shows, slide in.
            let size = (body.width, body.height);
            self.scrolled = match self.top {
                Some((was, before)) if grew && !below && was == size && top > before => {
                    u16::try_from(top - before)
                        .map_or(0, |by| if by < body.height { by } else { 0 })
                }
                _ => 0,
            };
            self.top = Some((size, top));
            if self.scrolled > 0
                && let Some(on_scrolled) = &self.on_scrolled
            {
                let _ = on_scrolled.call1(&JsValue::NULL, &JsValue::from(self.scrolled));
            }
        }
        self.drawn_for = Some((area, p));
        self.report(area.width);
    }

    /// The rows the command wants at `width`, told to the page with whether its
    /// command is longer than its line when either changes.
    fn report(&mut self, width: u16) -> u16 {
        let wanted = self.wanted(width);
        if wanted != self.reported {
            self.reported = wanted;
            if let Some(on_rows) = &self.on_rows {
                let _ = on_rows.call2(
                    &JsValue::NULL,
                    &JsValue::from(wanted.0),
                    &JsValue::from(wanted.1),
                );
            }
        }
        wanted.0
    }

    /// Whether to hold the last frame while the output wants more rows than
    /// the element has: a new line under the fold waits for the page to give it
    /// its row, so the lines above never scroll up for a frame and back down.
    fn holding(&mut self, area: Rect) -> bool {
        let wanted = self.report(area.width);
        if wanted <= area.height {
            self.waiting = None;
            return false;
        }
        let waited = match self.waiting {
            Some((rows, waited)) if rows == wanted => waited,
            _ => 0,
        };
        self.waiting = Some((wanted, waited.saturating_add(1)));
        waited < HOLD_FRAMES
    }
}

impl Drawn for CommandView {
    fn set_cell(&mut self, _cell: (f32, f32)) {}

    fn draw(&mut self, frame: &mut Frame) {
        CommandView::draw(self, frame);
    }

    /// A finished command draws again only when it, its size or the colours change; a running
    /// one draws each frame for its spinner, its clock and the light crossing it.
    fn wants_frame(&mut self, area: Rect) -> bool {
        !self.holding(area) && (self.run.running() || self.drawn_for != Some((area, palette())))
    }

    fn repaint(&mut self) {
        self.drawn_for = None;
    }
}

/// The mounted command terminal. React calls these from its own effects and handlers.
#[wasm_bindgen]
pub struct CommandHandle {
    _frames: Rc<FrameLoop>,
    view: Rc<RefCell<CommandView>>,
}

#[wasm_bindgen]
impl CommandHandle {
    /// Replaces the command with React's latest (JSON: `command`, `stdout`, `stderr`,
    /// `status`, `exitCode`, `open`, `still`).
    pub fn set_state(&self, json: &str) -> Result<(), JsValue> {
        self.view
            .borrow_mut()
            .set_state(json)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Scrolls the output; positive is towards newer. True when it moved, so
    /// the page keeps the wheel only then.
    pub fn scroll(&self, lines: i32) -> bool {
        self.view.borrow_mut().scroll(lines)
    }

    /// Whether the output can scroll `lines`' way (positive is towards newer),
    /// so the page keeps a drag over it, before it has moved a row, only then.
    pub fn can_scroll(&self, lines: i32) -> bool {
        self.view.borrow().can_scroll(lines)
    }
}

/// Mounts one command's terminal into the element with `parent_id`, which it
/// fills. `on_rows` hears how many rows the command wants (its line, and its
/// output up to the fold) and whether the command is longer than its line,
/// whenever either changes, so the page can size the element and let the
/// reader open a cut command to read all of it. `on_scrolled` hears how many rows new output moved the newest
/// output up, in the frame that draws it, so the page can slide them in. Both
/// are called from the frame, so they must not call back in. Frames run while
/// the handle lives and the element is on the page, so the page keeps the
/// handle; mount once per element.
#[wasm_bindgen]
pub fn mount_command(
    parent_id: &str,
    on_rows: js_sys::Function,
    on_scrolled: js_sys::Function,
) -> Result<CommandHandle, JsValue> {
    let screen = Screen::new(parent_id)?;
    let view = Rc::new(RefCell::new(CommandView::new(
        Some(on_rows),
        Some(on_scrolled),
    )));
    let frames = run_frames(screen, view.clone());
    Ok(CommandHandle {
        _frames: frames,
        view,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(json: serde_json::Value) -> CommandView {
        let mut view = CommandView::new(None, None);
        view.set_state(&json.to_string()).unwrap();
        view
    }

    fn drawn(view: &mut CommandView, width: u16, height: u16) -> ratatui::buffer::Buffer {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| view.draw(frame)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn draw_at(view: &mut CommandView, width: u16, height: u16, at: f64) -> Buffer {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| view.draw_at(frame, at)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn row_at(view: &mut CommandView, width: u16, at: f64) -> String {
        rows(&draw_at(view, width, 1, at)).remove(0)
    }

    fn rows(buf: &ratatui::buffer::Buffer) -> Vec<String> {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn output_reads_as_a_terminal_reads_it() {
        let view = run(serde_json::json!({
            "command": "bun test",
            "stdout": "one\r\ntwo\n",
            "stderr": "bad\n",
            "status": "error",
            "exitCode": 1,
        }));
        assert_eq!(
            view.run.bytes(),
            b"one\r\ntwo\r\n\x1b[31mbad".to_vec()
        );
    }

    #[test]
    fn the_command_wants_its_line_and_its_output_up_to_the_fold() {
        let mut none = run(serde_json::json!({"command": "true", "status": "complete"}));
        assert_eq!(none.wanted(40).0, 1);
        let mut two =
            run(serde_json::json!({"command": "ls", "stdout": "a\nb", "status": "complete"}));
        assert_eq!(two.wanted(40).0, 3);
        // Twelve columns inside a margin of one each side: a 15-letter line takes two rows.
        let mut wrapped = run(
            serde_json::json!({"command": "x", "stdout": "abcdefghijklmno", "status": "complete"}),
        );
        assert_eq!(wrapped.wanted(14).0, 3);
        let mut long = run(serde_json::json!({
            "command": "seq 20",
            "stdout": (1..=20).map(|n| n.to_string()).collect::<Vec<_>>().join("\n"),
            "status": "complete",
        }));
        assert_eq!(long.wanted(40).0, 1 + FOLD);
    }

    #[test]
    fn a_finished_command_says_how_it_ended() {
        let mut ok = run(serde_json::json!({
            "command": "bun test src/tiles",
            "stdout": "14 pass, 0 fail",
            "status": "complete",
            "exitCode": 0,
        }));
        let shown = rows(&drawn(&mut ok, 40, 2));
        assert_eq!(
            shown[0],
            format!(" {PROMPT}bun test src/tiles{}✓", " ".repeat(17))
        );
        assert_eq!(shown[1], " 14 pass, 0 fail");

        let mut failed = run(serde_json::json!({
            "command": "bun test",
            "stderr": "1 fail",
            "status": "error",
            "exitCode": 1,
        }));
        let buf = drawn(&mut failed, 40, 2);
        assert!(rows(&buf)[0].ends_with("✗ exit 1"));
        assert_eq!(buf[(1, 1)].symbol(), "1");
        assert_eq!(
            buf[(1, 1)].fg,
            palette().error,
            "standard error is the error colour"
        );
    }

    #[test]
    fn a_long_command_is_cut_before_its_ending() {
        let mut view = run(serde_json::json!({
            "command": "cargo test --workspace --all-features -- --nocapture",
            "status": "complete",
        }));
        let row = rows(&drawn(&mut view, 24, 1)).remove(0);
        assert!(row.contains('…'), "{row}");
        assert!(row.ends_with('✓'), "{row}");
        assert_eq!(row.width(), 23);
        assert_eq!(view.wanted(24), (1, true));
    }

    #[test]
    fn a_long_command_shows_whole_while_what_is_under_it_shows() {
        // 52 columns of command; 22 inside the margins, the prompt's 2 and " ✓" leave 18.
        let mut view = run(serde_json::json!({
            "command": "cargo test --workspace --all-features -- --nocapture",
            "status": "complete",
            "open": true,
        }));
        assert_eq!(view.wanted(24), (3, true));
        assert_eq!(
            rows(&drawn(&mut view, 24, 3)),
            [
                format!(" {PROMPT}cargo test --works ✓"),
                "   pace --all-features".to_owned(),
                "   -- --nocapture".to_owned(),
            ]
        );

        let mut printed = run(serde_json::json!({
            "command": "cargo test --workspace --all-features -- --nocapture",
            "stdout": "ok",
            "status": "complete",
            "open": true,
        }));
        assert_eq!(printed.wanted(24), (4, true));
        assert_eq!(rows(&drawn(&mut printed, 24, 4))[3], " ok", "the output follows the command");
    }

    #[test]
    fn rows_a_program_wrote_under_its_cursor_still_count() {
        // The cursor goes home after the second line, and back up after "result".
        let mut home = run(serde_json::json!({
            "command": "x",
            "stdout": "one\ntwo\x1b[H",
            "status": "complete",
        }));
        assert_eq!(home.wanted(40).0, 3);
        let mut up = run(serde_json::json!({
            "command": "x",
            "stdout": "header\nresult\x1b[A",
            "status": "complete",
        }));
        assert_eq!(
            rows(&drawn(&mut up, 20, 2))[1],
            " result",
            "one row of output shows the last it wrote"
        );
    }

    #[test]
    fn new_output_is_read_on_where_it_only_adds() {
        let state = |stdout: &str, stderr: &str| {
            serde_json::json!({
                "command": "cargo build",
                "stdout": stdout,
                "stderr": stderr,
                "status": "running",
            })
            .to_string()
        };
        let mut view = CommandView::new(None, None);
        view.set_state(&state("", "Compiling a")).unwrap();
        drawn(&mut view, 30, 4);
        view.set_state(&state("", "Compiling a\nCompiling b")).unwrap();
        assert!(!view.stale, "more standard error reads on");
        assert_eq!(
            &rows(&drawn(&mut view, 30, 4))[1..3],
            [" Compiling a", " Compiling b"]
        );
        view.set_state(&state("done", "Compiling a\nCompiling b")).unwrap();
        assert!(
            view.stale,
            "standard output ahead of standard error is read again"
        );
        assert_eq!(
            &rows(&drawn(&mut view, 30, 4))[1..4],
            [" done", " Compiling a", " Compiling b"]
        );
    }

    #[test]
    fn a_reader_scrolled_back_keeps_their_lines_once_the_scrollback_is_full() {
        let state = |to| {
            serde_json::json!({"command": "seq", "stdout": seq(to), "status": "running"})
                .to_string()
        };
        let mut view = CommandView::new(None, None);
        view.set_state(&state(2100)).unwrap();
        assert_eq!(&rows(&drawn(&mut view, 20, 4))[1..], [" 2098", " 2099", " 2100"]);
        view.scroll(-2);
        assert_eq!(&rows(&drawn(&mut view, 20, 4))[1..], [" 2096", " 2097", " 2098"]);
        view.set_state(&state(2105)).unwrap();
        assert_eq!(
            &rows(&drawn(&mut view, 20, 4))[1..],
            [" 2096", " 2097", " 2098"],
            "old lines dropping off the scrollback do not move the reader"
        );
    }

    #[test]
    fn older_output_scrolls_back_and_the_newest_shows() {
        let mut view = run(serde_json::json!({
            "command": "seq 10",
            "stdout": (1..=10).map(|n| n.to_string()).collect::<Vec<_>>().join("\n"),
            "status": "complete",
        }));
        let shown = rows(&drawn(&mut view, 20, 4));
        assert_eq!(&shown[1..], [" 8", " 9", " 10"]);
        assert!(view.can_scroll(-1) && !view.can_scroll(1));
        assert!(view.scroll(-2));
        let shown = rows(&drawn(&mut view, 20, 4));
        assert_eq!(&shown[1..], [" 6", " 7", " 8"]);
        assert!(view.can_scroll(1));
        assert!(view.scroll(5));
        assert!(!view.scroll(1), "the newest output is the end");
        view.scroll(-100);
        assert!(!view.can_scroll(-1), "the first line is the start");
    }

    #[test]
    fn one_row_of_output_shows_the_newest_even_when_a_line_wraps() {
        // Eighteen columns inside the margins: standard error wraps after "expected ze".
        let mut view = run(serde_json::json!({
            "command": "bun test",
            "stdout": "ok",
            "stderr": "error: expected zero, got three",
            "status": "error",
            "exitCode": 1,
        }));
        let shown = rows(&drawn(&mut view, 20, 2));
        assert_eq!(shown[0], format!(" {PROMPT}bun te… ✗ exit 1"));
        assert_eq!(shown[1], " ro, got three");
    }

    fn seq(to: u32) -> String {
        (1..=to)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_band_of_light_crosses_a_running_command() {
        // Ten columns: halfway through its crossing the band's middle is over the fifth.
        assert_eq!(shimmer(0, 10, 0.0), 0.0, "it starts off the label");
        assert!(shimmer(4, 10, SWEEP_MS / 2.0) > 0.9);
        assert_eq!(shimmer(0, 10, SWEEP_MS / 2.0), 0.0);
        assert_eq!(
            shimmer(4, 10, SWEEP_MS + 1.0),
            0.0,
            "and rests before the next"
        );
        assert!(shimmer(4, 10, SWEEP_MS + REST_MS + SWEEP_MS / 2.0) > 0.9);

        let p = palette();
        let mut view = run(serde_json::json!({"command": "sleep 3 && ls", "status": "running"}));
        let buf = draw_at(&mut view, 30, 1, SWEEP_MS / 2.0);
        // The command starts after the margin and the prompt, at column 3.
        let lit = buf[(3 + 6, 0)].fg;
        assert_ne!(lit, p.muted, "under the band the command is lit");
        assert_eq!(buf[(3, 0)].fg, p.muted, "away from it the command is muted");
        assert_eq!(
            draw_at(&mut view, 30, 1, SWEEP_MS + 1.0)[(3 + 6, 0)].fg,
            p.muted
        );

        let mut still = run(serde_json::json!({
            "command": "sleep 3 && ls",
            "status": "running",
            "still": true,
        }));
        let buf = draw_at(&mut still, 30, 1, SWEEP_MS / 2.0);
        assert_eq!(buf[(3 + 6, 0)].fg, p.muted, "less motion holds it still");

        let mut ended = run(serde_json::json!({"command": "sleep 3 && ls", "status": "complete"}));
        let buf = draw_at(&mut ended, 30, 1, SWEEP_MS / 2.0);
        assert_eq!(buf[(3 + 6, 0)].fg, p.bright, "an ended command is bright");
    }

    #[test]
    fn the_row_counts_the_time_the_command_takes() {
        assert_eq!(said(400.0), "<1s");
        assert_eq!(said(59_900.0), "59s");
        assert_eq!(said(60_000.0), "1m 0s");
        assert_eq!(said(3_660_000.0), "1h 1m");

        let running = Run {
            command: "sleep 3".into(),
            status: "running".into(),
            ..Run::default()
        };
        let mut view = CommandView::new(None, None);
        view.time(&running, 1_000.0);
        view.run = running.clone();
        assert!(row_at(&mut view, 30, 13_500.0).contains(" 12s "));

        let done = Run {
            status: "complete".into(),
            exit_code: Some(0),
            ..running.clone()
        };
        view.time(&done, 4_200.0);
        view.run = done;
        assert!(row_at(&mut view, 30, 99_000.0).ends_with(" 3s ✓"));

        // A command that had ended before this view saw it says no time.
        let mut history = run(serde_json::json!({"command": "ls", "status": "complete"}));
        let row = row_at(&mut history, 30, 99_000.0);
        assert_eq!(row.trim_end_matches('✓').trim_end(), format!(" {PROMPT}ls"));

        let mut waiting = CommandView::new(None, None);
        waiting.time(
            &Run {
                status: "awaiting".into(),
                ..running
            },
            1_000.0,
        );
        assert_eq!(waiting.began, None, "waiting for approval is not running");
    }

    #[test]
    fn the_line_ends_in_how_it_ended_open_or_closed() {
        let mut open = run(serde_json::json!({
            "command": "ls",
            "stdout": "a",
            "status": "complete",
            "open": true,
        }));
        // The prompt is the line's one pointer; the page turns it down while the output shows.
        assert!(rows(&drawn(&mut open, 20, 2))[0].ends_with('✓'));
        let mut closed =
            run(serde_json::json!({"command": "ls", "stdout": "a", "status": "complete"}));
        assert!(rows(&drawn(&mut closed, 20, 2))[0].ends_with('✓'));
        let mut empty =
            run(serde_json::json!({"command": "true", "stdout": "\n", "status": "complete"}));
        assert!(
            rows(&drawn(&mut empty, 20, 1))[0].ends_with('✓'),
            "no output, nothing to open"
        );
    }

    #[test]
    fn the_edges_fade_where_output_is_out_of_view() {
        let p = palette();
        let mut view =
            run(serde_json::json!({"command": "seq 10", "stdout": seq(10), "status": "complete"}));
        let buf = drawn(&mut view, 20, 4);
        let ink = buf[(1, 3)].fg;
        let ink = if ink == Color::Reset { p.ink } else { ink };
        let faded = mix(ink, p.canvas(), FADE);
        assert_eq!(buf[(1, 1)].fg, faded, "older lines are above");
        assert_eq!(buf[(1, 3)].fg, ink, "the newest line is whole");

        view.scroll(-2);
        let buf = drawn(&mut view, 20, 4);
        assert_eq!(buf[(1, 1)].fg, faded);
        assert_eq!(buf[(1, 3)].fg, faded, "newer lines are below");

        view.scroll(-100);
        let buf = drawn(&mut view, 20, 4);
        assert_eq!(rows(&buf)[1], " 1");
        assert_eq!(buf[(1, 1)].fg, ink, "the first line has nothing above it");
        assert_eq!(buf[(1, 3)].fg, faded);
    }

    #[test]
    fn a_reader_scrolled_back_keeps_their_lines_as_new_ones_arrive() {
        let mut view =
            run(serde_json::json!({"command": "seq", "stdout": seq(10), "status": "running"}));
        assert_eq!(&rows(&drawn(&mut view, 20, 4))[1..], [" 8", " 9", " 10"]);
        view.scroll(-2);
        assert_eq!(&rows(&drawn(&mut view, 20, 4))[1..], [" 6", " 7", " 8"]);
        view.set_state(
            &serde_json::json!({"command": "seq", "stdout": seq(12), "status": "running"})
                .to_string(),
        )
        .unwrap();
        assert_eq!(&rows(&drawn(&mut view, 20, 4))[1..], [" 6", " 7", " 8"]);

        view.scroll(100);
        view.set_state(
            &serde_json::json!({"command": "seq", "stdout": seq(14), "status": "running"})
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            &rows(&drawn(&mut view, 20, 4))[1..],
            [" 12", " 13", " 14"],
            "at the newest, it follows"
        );
    }

    #[test]
    fn a_new_line_past_the_fold_slides_in_by_its_row() {
        let state = |to| {
            serde_json::json!({"command": "seq", "stdout": seq(to), "status": "running"})
                .to_string()
        };
        let mut view =
            run(serde_json::json!({"command": "seq", "stdout": seq(10), "status": "running"}));
        drawn(&mut view, 20, 4);
        assert_eq!(
            view.scrolled, 0,
            "the first frame has nothing to slide from"
        );

        view.set_state(&state(11)).unwrap();
        assert_eq!(&rows(&drawn(&mut view, 20, 4))[1..], [" 9", " 10", " 11"]);
        assert_eq!(view.scrolled, 1, "one new line moved the rows up one");
        drawn(&mut view, 20, 4);
        assert_eq!(view.scrolled, 0, "a frame with nothing new slides nothing");

        view.set_state(&state(14)).unwrap();
        drawn(&mut view, 20, 4);
        assert_eq!(
            view.scrolled, 0,
            "a whole view of new lines replaces it rather than sliding"
        );

        view.scroll(-2);
        view.set_state(&state(15)).unwrap();
        drawn(&mut view, 20, 4);
        assert_eq!(
            view.scrolled, 0,
            "a reader scrolled back keeps their lines still"
        );
    }

    #[test]
    fn a_new_line_under_the_fold_waits_for_its_row() {
        let mut view =
            run(serde_json::json!({"command": "seq", "stdout": seq(2), "status": "running"}));
        let three = Rect::new(0, 0, 20, 3);
        assert!(view.wants_frame(three));
        view.set_state(
            &serde_json::json!({"command": "seq", "stdout": seq(3), "status": "running"})
                .to_string(),
        )
        .unwrap();
        for _ in 0..HOLD_FRAMES {
            assert!(
                !view.wants_frame(three),
                "it holds its frame for the page to grow it"
            );
        }
        assert!(
            view.wants_frame(three),
            "and draws at the size it has when the page does not"
        );
        assert!(
            view.wants_frame(Rect::new(0, 0, 20, 4)),
            "a grown element draws at once"
        );
    }
    #[test]
    fn a_command_sits_on_the_agent_terminals_canvas() {
        let canvas = Color::Rgb(0x12, 0x12, 0x12);
        let mut laddered = palette();
        laddered.canvas = Some(canvas);
        crate::PALETTE.set(laddered);
        let mut view = run(
            serde_json::json!({"command": "ls", "stdout": "a", "status": "complete", "open": true}),
        );
        let buf = drawn(&mut view, 20, 3);
        assert_eq!(buf[(0, 0)].bg, canvas, "the prompt's line");
        assert_eq!(buf[(1, 1)].bg, canvas, "what it printed");
        assert_eq!(buf[(19, 2)].bg, canvas, "the rows it left empty");
    }

    #[test]
    fn faint_output_is_muted_in_its_colour_and_keeps_its_lighter_weight() {
        let p = palette();
        let mut view = run(serde_json::json!({
            "command": "test",
            "stdout": "\u{1b}[2mfaint\u{1b}[0m plain",
            "status": "complete",
            "open": true,
        }));
        let buf = drawn(&mut view, 30, 2);
        assert_eq!(rows(&buf)[1], " faint plain");
        let faint = &buf[(1, 1)];
        assert!(faint.modifier.contains(Modifier::DIM));
        assert_eq!(faint.fg, mix(p.ink, p.canvas(), FAINT));
        assert_eq!(faint.bg, p.canvas(), "its ground stays whole");
        let plain = &buf[(7, 1)];
        assert!(!plain.modifier.contains(Modifier::DIM));
        assert!(plain.fg == p.ink || plain.fg == Color::Reset);
    }
}
