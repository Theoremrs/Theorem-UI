//! ELY Markdown for the Theo Web terminal workbench: parse tree, block
//! ranges, edit commands, and the four document modes (Visual, Source,
//! Split, Preview) as a headless model with Ratatui drawing.
//!
//! The parse tree, builder, read tree and edit commands are carried from the
//! ELY GPUI components (see `LICENSE-ELY` and the header of each file); the
//! mode model is a translation; the text session underneath is
//! `theorem-workbench-text`.

#[cfg(test)]
mod clock;
mod doc;
// The carried layers keep their donor items whole; the ones this crate's own
// modes do not call are the donor's API, not dead code to cut.
#[allow(dead_code)]
mod document;
mod draw;
#[allow(dead_code)]
mod markdown;
mod modes;
mod styles;
#[allow(dead_code)]
mod tree;

#[cfg(test)]
mod spec;

pub use document::{
    BlockCommand, CellAt, DocumentHeading, Edit, EditRefusal, InlineFormat, LARGEST_READ,
    TableEdit, TableRefusal, TargetBlock, block_command, cells, drop_image, inline_format,
    table_edit,
};
pub use markdown::mdast::{self, AlignKind};
pub use markdown::{
    Mark, block_ranges, file_tree as markdown_tree, link_at, marks, reading_minutes, words,
};
pub use tree::{AlertKind, Inline, Node as MarkdownBlock, Style};
pub use tree::{Reader as MarkdownReader, alert, is_toc, parse as markdown_blocks};

pub use doc::{
    Anchor, Applied, BlockConflict, BlockInfo, BlockResolution, CommandError, CommitOutcome,
    MarkdownDoc, MarkdownViewState, OpenState,
};
pub use draw::Frame;
pub use modes::MarkdownMode;
pub use styles::MarkdownStyles;
pub use theorem_workbench_text::{Caret, TextChange};
