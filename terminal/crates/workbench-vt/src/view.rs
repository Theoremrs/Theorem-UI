//! The ratatui widget for a `Screen`: `tui-term` draws the cells, then this
//! maps colours through the app's palette and lays the cursor, search
//! matches and selection over them.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::Widget;
use tui_term::widget::{Cursor, CursorShape, PseudoTerminal};

use crate::buffer::Span;
use crate::screen::Screen;

/// The colours the app supplies from its theme. The 16 ANSI slots and the
/// default foreground and background are replaced; 256-colour and truecolor
/// cells pass through unchanged.
#[derive(Clone, Debug)]
pub struct Palette {
    pub fg: Color,
    pub bg: Color,
    pub ansi: [Color; 16],
    /// Laid over selected cells.
    pub selection: Style,
    /// Laid over search matches.
    pub search_match: Style,
    /// Laid over the match last stepped to.
    pub search_current: Style,
}

/// A test default (xterm colours); apps supply their own from theme roles.
impl Default for Palette {
    fn default() -> Self {
        let rgb = |r, g, b| Color::Rgb(r, g, b);
        Self {
            fg: rgb(0xe5, 0xe5, 0xe5),
            bg: rgb(0x00, 0x00, 0x00),
            ansi: [
                rgb(0x00, 0x00, 0x00),
                rgb(0xcd, 0x00, 0x00),
                rgb(0x00, 0xcd, 0x00),
                rgb(0xcd, 0xcd, 0x00),
                rgb(0x00, 0x00, 0xee),
                rgb(0xcd, 0x00, 0xcd),
                rgb(0x00, 0xcd, 0xcd),
                rgb(0xe5, 0xe5, 0xe5),
                rgb(0x7f, 0x7f, 0x7f),
                rgb(0xff, 0x00, 0x00),
                rgb(0x00, 0xff, 0x00),
                rgb(0xff, 0xff, 0x00),
                rgb(0x5c, 0x5c, 0xff),
                rgb(0xff, 0x00, 0xff),
                rgb(0x00, 0xff, 0xff),
                rgb(0xff, 0xff, 0xff),
            ],
            selection: Style::new().bg(rgb(0x33, 0x55, 0x99)),
            search_match: Style::new().bg(rgb(0x66, 0x55, 0x00)),
            search_current: Style::new().bg(rgb(0xcc, 0x88, 0x00)),
        }
    }
}

impl Palette {
    fn color(&self, c: Color, default: Color) -> Color {
        match c {
            Color::Reset => default,
            Color::Indexed(i) if i < 16 => self.ansi[usize::from(i)],
            other => other,
        }
    }
}

/// Draws the rows on view (so scrolling shows scrollback), the cursor when
/// `show_cursor` is set and the program has not hidden it, the search matches
/// and the selection.
pub struct TerminalView<'a> {
    screen: &'a Screen,
    palette: &'a Palette,
    show_cursor: bool,
}

impl<'a> TerminalView<'a> {
    pub fn new(screen: &'a Screen, palette: &'a Palette) -> Self {
        Self {
            screen,
            palette,
            show_cursor: true,
        }
    }

    /// Hide the cursor, for example while the pane is not focused.
    pub fn show_cursor(mut self, show: bool) -> Self {
        self.show_cursor = show;
        self
    }
}

impl Widget for TerminalView<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let pal = self.palette;
        // tui-term fills the cells; its cursor is off because the shape and
        // the theme colours are applied below.
        PseudoTerminal::new(self.screen.vt())
            .cursor(Cursor::default().visibility(false))
            .render(area, buf);

        // Palette and reverse video: reverse is resolved into swapped colours
        // so the result does not depend on the backend honouring it.
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                let cell = &mut buf[(x, y)];
                let mut fg = pal.color(cell.fg, pal.fg);
                let mut bg = pal.color(cell.bg, pal.bg);
                if cell.modifier.contains(Modifier::REVERSED) {
                    std::mem::swap(&mut fg, &mut bg);
                    cell.modifier.remove(Modifier::REVERSED);
                }
                cell.fg = fg;
                cell.bg = bg;
            }
        }

        let (_, cols) = self.screen.size();
        let cols = cols.min(area.width);
        let top = self.screen.view_top();
        let rows = area.height;
        let overlay = |span: &Span, style: Style, buf: &mut Buffer| {
            for view_row in 0..rows {
                if let Some((a, b)) = span.cols_on(top + usize::from(view_row), cols) {
                    for col in a..=b {
                        buf[(area.x + col, area.y + view_row)].set_style(style);
                    }
                }
            }
        };
        let current = self.screen.search_current();
        for (i, m) in self.screen.search_matches().iter().enumerate() {
            let style = if Some(i) == current {
                pal.search_current
            } else {
                pal.search_match
            };
            overlay(m, style, buf);
        }
        if let Some(sel) = self.screen.selection() {
            overlay(&sel, pal.selection, buf);
        }

        if self.show_cursor && self.screen.cursor_visible() {
            let (row, col) = self.screen.cursor_position();
            let row = row + u16::try_from(self.screen.scrollback_offset()).unwrap_or(u16::MAX);
            if row < rows && col < cols {
                let cell = &mut buf[(area.x + col, area.y + row)];
                match self.screen.cursor_shape() {
                    CursorShape::BlinkingUnderline | CursorShape::SteadyUnderline => {
                        cell.modifier.insert(Modifier::UNDERLINED);
                    }
                    CursorShape::BlinkingBar | CursorShape::SteadyBar if cell.symbol() == " " => {
                        cell.set_symbol("\u{258f}");
                    }
                    _ => {
                        let (fg, bg) = (cell.fg, cell.bg);
                        cell.fg = bg;
                        cell.bg = fg;
                    }
                }
            }
        }
    }
}
