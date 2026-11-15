//! Places in a document, for the panels that show one: the reference a
//! person adds to the conversation, and the offset the agent's edit names.
//!
//! Both are conversions out of and into the session's own offsets (Unicode
//! scalars), so the editor and the Markdown panel share them.

use theorem_workbench_core::draft::SourceReference;
use theorem_workbench_core::effect::CoordinateUnit;
use theorem_workbench_core::results::{Position, Range};
use theorem_workbench_text::{EditSession, Snap, Unit};

/// The most scalars of text a reference carries as its excerpt. The range
/// still names the whole selection; the excerpt is only what the turn says
/// the person saw, and `excerpt_cut` says when it is shorter than that.
pub use theorem_workbench_core::draft::EXCERPT_LIMIT;

/// The reference for what is selected in `session`, or for the caret's line
/// when nothing is. `path` is the file, relative to the workspace root.
pub fn reference(path: &str, session: &EditSession) -> SourceReference {
    match session.selection() {
        Some((start, end)) => reference_of(path, session, start, end),
        None => {
            let at = session.cursor();
            let coords = session.coords();
            let line = coords.line_of(at);
            let (start, end) = coords.line_range(line).unwrap_or((at, at));
            reference_of(path, session, start, end)
        }
    }
}

/// The reference for the scalar range `[start, end)` of `session`'s text,
/// whole lines or not. An empty range is the line it is in.
pub fn reference_of(
    path: &str,
    session: &EditSession,
    start: usize,
    end: usize,
) -> SourceReference {
    let rope = session.rope();
    let coords = session.coords();
    let len = rope.len_chars();
    let (start, end) = (start.min(end).min(len), start.max(end).min(len));
    let (start, end) = if start == end {
        coords
            .line_range(coords.line_of(start))
            .unwrap_or((start, end))
    } else {
        (start, end)
    };
    // The column counts UTF-16 units from the line start; `at` is a scalar.
    let position = |at: usize| {
        let line = coords.line_of(at);
        let (from, _) = coords.line_range(line).unwrap_or((0, 0));
        let units = |scalar| coords.from_scalar(scalar, Unit::Utf16).unwrap_or(0);
        Position {
            line: line as u32,
            character: (units(at) - units(from)) as u32,
        }
    };
    let first = coords.line_of(start);
    // A selection that ends at the start of a line ends on the line before it.
    let last = if end > start {
        coords.line_of(end - 1)
    } else {
        first
    };
    let label = if first == last {
        format!("{path}:{}", first + 1)
    } else {
        format!("{path}:{}-{}", first + 1, last + 1)
    };
    let excerpt: String = rope.slice(start..end).chars().take(EXCERPT_LIMIT).collect();
    let excerpt_cut = end - start > EXCERPT_LIMIT;
    SourceReference {
        path: path.to_owned(),
        range: Some(Range {
            start: position(start),
            end: position(end),
        }),
        label: Some(label),
        excerpt: (!excerpt.is_empty()).then_some(excerpt),
        excerpt_cut,
    }
}

/// The scalar offset of `start` counted in `unit` from the start of `session`'s
/// text, clamped to its end and moved to the character it falls in.
pub fn follow_offset(session: &EditSession, start: u32, unit: CoordinateUnit) -> usize {
    let unit = match unit {
        CoordinateUnit::Utf16 => Unit::Utf16,
        CoordinateUnit::Scalar => Unit::Scalar,
        CoordinateUnit::Utf8Bytes => Unit::Utf8,
    };
    session
        .coords()
        .to_scalar(start as usize, unit, Snap::Backward)
        .unwrap_or_else(|| session.len())
}
