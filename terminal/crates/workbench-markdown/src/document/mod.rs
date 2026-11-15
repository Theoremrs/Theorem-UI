//! The donor's document layer, pure part: block and inline commands as
//! functions from text and selection to a change, table commands, table
//! cell moves, and the block and heading read of a text.
//!
//! The donor's `document/mod.rs` is the GPUI `MarkdownDocument` entity and is
//! not carried; this file only declares the carried modules.

mod block;
pub mod cells;
mod edit;
mod format;
pub(crate) mod parse;
mod tables;
mod target;
#[cfg(test)]
mod tests;

pub use crate::tree::DocumentHeading;
pub use block::BlockCommand;
pub use edit::{Edit, block_command, drop_image, inline_format, table_edit};
pub use format::{EditRefusal, InlineFormat};
pub use tables::{TableEdit, TableRefusal};
pub use target::{CellAt, TargetBlock};

/// Texts this long are never read: source alone.
pub const LARGEST_READ: usize = 2 << 20;
