//! The donor's pure edit commands behind one revision-carrying surface.
//!
//! Each command reads a text at a document revision and answers with an
//! [`Edit`]: byte-range replacements against that text, the selection after
//! them, and the revision they were read at. The donor's commands answer with
//! the same list and selection (`document::format::Change`) and no revision;
//! the document that owns the text applies the edit only while its revision is
//! still the one the edit names.

use std::ops::Range;

use theorem_workbench_text::Revision;

use super::{
    BlockCommand, EditRefusal, InlineFormat, TableEdit, TableRefusal, block, format, tables,
};

/// What a command changes: replacements in ascending, non-overlapping byte
/// ranges of the text it was read from, and where the selection goes after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    /// The document revision the command read.
    pub revision: Revision,
    /// `(range in the text read, replacement)`, ascending.
    pub edits: Vec<(Range<usize>, String)>,
    /// The selection after the edits, in the new text.
    pub selection: Range<usize>,
}

impl Edit {
    fn new(revision: Revision, (edits, selection): format::Change) -> Self {
        Self {
            revision,
            edits,
            selection,
        }
    }

    /// `text` with the edits applied.
    pub fn apply_to(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (range, with) in self.edits.iter().rev() {
            out.replace_range(range.clone(), with);
        }
        out
    }
}

/// `command` at `selection` in `text` (read at `revision`), or why not.
pub fn block_command(
    text: &str,
    revision: Revision,
    selection: Range<usize>,
    command: BlockCommand,
) -> Result<Edit, EditRefusal> {
    block::run(text, selection, command).map(|change| Edit::new(revision, change))
}

/// `format` toggled at `selection` in `text` (read at `revision`), or why not.
pub fn inline_format(
    text: &str,
    revision: Revision,
    selection: Range<usize>,
    inline: InlineFormat,
) -> Result<Edit, EditRefusal> {
    format::toggle(text, selection, inline).map(|change| Edit::new(revision, change))
}

/// The picture at byte `at` removed, or why not.
pub fn drop_image(text: &str, revision: Revision, at: usize) -> Result<Edit, EditRefusal> {
    format::drop_image(text, at).map(|change| Edit::new(revision, change))
}

/// The table around byte `at` after `edit`, or why not.
pub fn table_edit(
    text: &str,
    revision: Revision,
    at: usize,
    edit: TableEdit,
) -> Result<Edit, TableRefusal> {
    tables::edit_table(text, at, edit).map(|change| Edit::new(revision, change))
}
