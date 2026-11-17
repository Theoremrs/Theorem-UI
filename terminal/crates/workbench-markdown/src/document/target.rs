// Donor: ELY-Open-Source/Ely-GPUI-Components @ 078bf26f2d039b3877aef577e37bbd0a1de182bf
// Path: crates/ely-documents/src/document/point.rs (the `TargetBlock` enum and `TargetBlock::of`, lines 19-76)
//       crates/ely-documents/src/render/table.rs (the `CellAt` struct, lines 14-20)
// Blob: 5bcb9c5872e970cb71d6697e94fbd061f39cef2d (point.rs), f66e28a2de8896727520a35eb372b0817bec2fec (table.rs)
// License: MIT, Copyright (c) 2026 Ely GPUI Component contributors (LICENSE-ELY)
// MODIFIED: extracted from two GPUI-bound donor files so the pure commands can name them.
//   The two items are copied unchanged; `CellAt` is `pub` instead of `pub(crate)`.
//   Nothing else of `point.rs` or `table.rs` is carried.

use crate::markdown::mdast;
use crate::tree::{alert, is_toc};

/// A top-level block's kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetBlock {
    /// A paragraph.
    Paragraph,
    /// A heading of this level.
    Heading(u8),
    /// A quote.
    Quote,
    /// A GitHub alert.
    Alert,
    /// A list.
    List,
    /// A code block.
    Code,
    /// A math block.
    Math,
    /// A table.
    Table,
    /// A rule.
    Rule,
    /// An HTML block.
    Html,
    /// A footnote definition.
    Footnote,
    /// A link definition.
    Definition,
    /// Front matter.
    FrontMatter,
    /// A table of contents.
    Toc,
}

impl TargetBlock {
    /// `node`'s kind, read from `source`.
    pub(super) fn of(node: &mdast::Node, source: &str) -> Self {
        match node {
            mdast::Node::Paragraph(_) if is_toc(node, source) => Self::Toc,
            mdast::Node::Paragraph(_) => Self::Paragraph,
            mdast::Node::Heading(heading) => Self::Heading(heading.depth),
            mdast::Node::Blockquote(quote) if alert(quote).is_some() => Self::Alert,
            mdast::Node::Blockquote(_) => Self::Quote,
            mdast::Node::List(_) => Self::List,
            mdast::Node::Code(_) => Self::Code,
            mdast::Node::Math(_) => Self::Math,
            mdast::Node::Table(_) => Self::Table,
            mdast::Node::ThematicBreak(_) => Self::Rule,
            mdast::Node::Html(_) => Self::Html,
            mdast::Node::FootnoteDefinition(_) => Self::Footnote,
            mdast::Node::Definition(_) => Self::Definition,
            mdast::Node::Yaml(_) | mdast::Node::Toml(_) => Self::FrontMatter,
            other => unreachable!("{other:?} is no block outside MDX"),
        }
    }
}

/// A cell: table in drawing order, row, column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellAt {
    pub table: usize,
    pub row: usize,
    pub column: usize,
}
