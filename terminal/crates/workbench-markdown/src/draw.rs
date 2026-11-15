//! Drawing the four modes into a Ratatui buffer.
//!
//! Source and the block being typed in are drawn by `theorem-workbench-text`.
//! The rest of the document is drawn by `tui-markdown`, one block at a time so
//! that every block's first row is known, which is what Split's scroll sync,
//! and the anchor a scroll or a mode switch keeps, are counted in. Every
//! color comes from the caller's [`MarkdownStyles`].
//!
//! This draws; it has not been compared against a reference rendering.

use std::collections::HashMap;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use theorem_workbench_text::coords::with_stand_ins;
use theorem_workbench_text::{Caret, EditSession, RenderOptions, layout::line_rows, render};
use tui_markdown::{Options, from_str_with_options};

use crate::doc::{Anchor, MarkdownDoc};
use crate::modes::MarkdownMode;
use crate::styles::MarkdownStyles;

/// Width of the bar beside the block being typed in.
const BAR: u16 = 1;

/// Rendered blocks, kept while their text, width and styles are the same.
#[derive(Default)]
pub(crate) struct Cache {
    styles: Option<MarkdownStyles>,
    drawn: HashMap<(String, u16), Drawn>,
    /// Rows each block took at the last draw, for scrolling by rows.
    pub heights: Vec<usize>,
}

#[derive(Clone)]
struct Drawn {
    text: Text<'static>,
    rows: usize,
}

impl Cache {
    fn block(&mut self, styles: &MarkdownStyles, source: &str, width: u16) -> Drawn {
        if self.styles.as_ref() != Some(styles) {
            self.drawn.clear();
            self.styles = Some(styles.clone());
        }
        if self.drawn.len() > 4096 {
            self.drawn.clear();
        }
        self.drawn
            .entry((source.to_string(), width))
            .or_insert_with(|| {
                let options = Options::new(styles.clone()).table_width(width);
                // A control or hidden character is parsed and drawn as its one-cell stand-in.
                let source = with_stand_ins(source);
                let text = owned(from_str_with_options(&source, &options));
                let rows = Paragraph::new(text.clone())
                    .wrap(Wrap { trim: false })
                    .line_count(width.max(1))
                    .max(1);
                Drawn { text, rows }
            })
            .clone()
    }
}

fn owned(text: Text<'_>) -> Text<'static> {
    let lines = text.lines.into_iter().map(|line| {
        let spans = line
            .spans
            .into_iter()
            .map(|span| Span::styled(span.content.into_owned(), span.style));
        Line::from(spans.collect::<Vec<_>>())
            .style(line.style)
            .alignment_opt(line.alignment)
    });
    Text::from(lines.collect::<Vec<_>>()).style(text.style)
}

trait AlignmentOpt {
    fn alignment_opt(self, alignment: Option<ratatui::layout::Alignment>) -> Self;
}

impl AlignmentOpt for Line<'static> {
    fn alignment_opt(self, alignment: Option<ratatui::layout::Alignment>) -> Self {
        match alignment {
            Some(alignment) => self.alignment(alignment),
            None => self,
        }
    }
}

/// What a draw leaves for the host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    /// The caret as a cell of the buffer; none in Preview and while no
    /// block is open in Visual.
    pub caret: Option<Caret>,
    /// The mode that was drawn: Source when the text is too long to read.
    pub mode: Option<MarkdownMode>,
}

/// Rows `session`'s text takes at `width` cells.
fn edit_rows(session: &EditSession, width: usize) -> usize {
    let rope = session.rope();
    let tab = session.config().tab_width;
    let lines = session.coords().line_count();
    (0..lines)
        .map(|line| line_rows(rope, line, width, tab).len())
        .sum::<usize>()
        .max(1)
}

impl MarkdownDoc {
    /// Draw the document in its mode into `area` of `buf`.
    pub fn draw(&mut self, area: Rect, buf: &mut Buffer, styles: &MarkdownStyles) -> Frame {
        let mode = if self.too_long() {
            MarkdownMode::Source
        } else {
            self.mode
        };
        let caret = match mode {
            MarkdownMode::Source => self.draw_source(area, buf, styles),
            MarkdownMode::Preview => {
                self.draw_blocks(area, buf, styles, self.anchor, false);
                None
            }
            MarkdownMode::Visual => {
                self.anchor = self.keep_open_in_view(area, styles);
                self.draw_blocks(area, buf, styles, self.anchor, true)
            }
            MarkdownMode::Split => self.draw_split(area, buf, styles),
        };
        Frame {
            caret,
            mode: Some(mode),
        }
    }

    fn draw_source(
        &mut self,
        area: Rect,
        buf: &mut Buffer,
        styles: &MarkdownStyles,
    ) -> Option<Caret> {
        let options = RenderOptions {
            styles: styles.editor(),
            line_numbers: true,
        };
        render(&mut self.session, area, buf, &options).caret
    }

    fn draw_split(
        &mut self,
        area: Rect,
        buf: &mut Buffer,
        styles: &MarkdownStyles,
    ) -> Option<Caret> {
        let left = area.width.saturating_sub(1) / 2;
        let source = Rect {
            width: left,
            ..area
        };
        let divider = Rect {
            x: area.x + left,
            width: 1.min(area.width - left),
            ..area
        };
        let right = Rect {
            x: area.x + left + divider.width,
            width: area.width - left - divider.width,
            ..area
        };
        let caret = self.draw_source(source, buf, styles);
        for y in divider.y..divider.y + divider.height {
            for x in divider.x..divider.x + divider.width {
                buf[(x, y)].set_symbol("\u{2502}").set_style(styles.divider);
            }
        }
        // The document follows the block the source is scrolled to.
        let anchor = self.anchor_from_source();
        self.anchor = anchor;
        self.draw_blocks(right, buf, styles, anchor, false);
        caret
    }

    /// The index of the block the open block is, if it is a block of the text.
    fn open_index(&mut self) -> Option<usize> {
        let at = self.open.as_ref().filter(|open| !open.append)?.range.start;
        self.parsed()
            .blocks
            .iter()
            .position(|block| block.range.start == at)
    }

    /// The anchor that keeps the open block, and its caret, on screen.
    fn keep_open_in_view(&mut self, area: Rect, styles: &MarkdownStyles) -> Anchor {
        let mut anchor = self.anchor;
        let Some(index) = self.open_index() else {
            return anchor;
        };
        let heights = self.heights(area.width, styles, Some(index));
        if anchor.block > index {
            return Anchor {
                block: index,
                row: 0,
            };
        }
        let room = usize::from(area.height);
        while anchor.block < index {
            let taken: usize = heights[anchor.block..=index]
                .iter()
                .map(|h| h + 1)
                .sum::<usize>()
                - 1
                - anchor.row.min(heights[anchor.block]);
            if taken <= room {
                break;
            }
            anchor = Anchor {
                block: anchor.block + 1,
                row: 0,
            };
        }
        anchor
    }

    /// Rows of each block at `width`; the open one by what is typed in it.
    fn heights(&mut self, width: u16, styles: &MarkdownStyles, open: Option<usize>) -> Vec<usize> {
        let sources = self.block_sources();
        let typed = match (open, self.open.as_ref()) {
            (Some(_), Some(open)) => Some(edit_rows(
                &open.session,
                usize::from(width.saturating_sub(BAR)),
            )),
            _ => None,
        };
        let heights: Vec<usize> = sources
            .iter()
            .enumerate()
            .map(|(index, source)| match (open == Some(index), typed) {
                (true, Some(rows)) => rows,
                _ => self.cache.block(styles, source, width).rows,
            })
            .collect();
        self.cache.heights = heights.clone();
        heights
    }

    fn block_sources(&mut self) -> Vec<String> {
        let ranges: Vec<_> = self
            .parsed()
            .blocks
            .iter()
            .map(|b| b.range.clone())
            .collect();
        let text = self.session.text();
        ranges
            .into_iter()
            .map(|range| text[range].to_string())
            .collect()
    }

    /// Draw the blocks from `anchor` down. With `visual`, the open block is
    /// its source in a text session, with a bar beside it.
    fn draw_blocks(
        &mut self,
        area: Rect,
        buf: &mut Buffer,
        styles: &MarkdownStyles,
        anchor: Anchor,
        visual: bool,
    ) -> Option<Caret> {
        if area.width == 0 || area.height == 0 {
            return None;
        }
        buf.set_style(area, styles.text);
        let open = if visual { self.open_index() } else { None };
        let sources = self.block_sources();
        let heights = self.heights(area.width, styles, open);
        let mut caret = None;
        let mut y = 0usize;
        let first = anchor.block.min(sources.len().saturating_sub(1));
        for index in first..sources.len() {
            let room = usize::from(area.height).saturating_sub(y);
            if room == 0 {
                break;
            }
            let skip = match index == first {
                true => anchor.row.min(heights[index].saturating_sub(1)),
                false => 0,
            };
            let rows = (heights[index] - skip).min(room);
            let rect = Rect {
                y: area.y + y as u16,
                height: rows as u16,
                ..area
            };
            if open == Some(index) && visual {
                caret = self.draw_open(rect, buf, styles);
            } else {
                let drawn = self.cache.block(styles, &sources[index], area.width);
                Paragraph::new(drawn.text)
                    .wrap(Wrap { trim: false })
                    .scroll((skip as u16, 0))
                    .render(rect, buf);
            }
            y += rows + 1;
        }
        let append = visual && self.open.as_ref().is_some_and(|open| open.append);
        let room = usize::from(area.height).saturating_sub(y);
        if append && room > 0 {
            let rect = Rect {
                y: area.y + y as u16,
                height: room as u16,
                ..area
            };
            caret = self.draw_open(rect, buf, styles);
        }
        caret
    }

    /// The open block, as source, in `rect`, with the bar beside it.
    fn draw_open(
        &mut self,
        rect: Rect,
        buf: &mut Buffer,
        styles: &MarkdownStyles,
    ) -> Option<Caret> {
        let open = self.open.as_mut()?;
        let bar = match open.held {
            true => styles.held,
            false => styles.editing,
        };
        for y in rect.y..rect.y + rect.height {
            buf[(rect.x, y)].set_symbol("\u{258f}").set_style(bar);
        }
        let inner = Rect {
            x: rect.x + BAR.min(rect.width),
            width: rect.width.saturating_sub(BAR),
            ..rect
        };
        let options = RenderOptions {
            styles: styles.editor(),
            line_numbers: false,
        };
        render(&mut open.session, inner, buf, &options).caret
    }
}
