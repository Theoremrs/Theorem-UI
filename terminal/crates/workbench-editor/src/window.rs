//! The slice of an open document a text node carries: all of it when small,
//! else whole lines around the caret (the tree stays bounded).

use theorem_workbench_panels::caret::{CaretText, caret_text};
use theorem_workbench_text::EditSession;

/// The most of the document the text node carries: whole lines around the
/// caret, within this many bytes (the escaped text can grow past it, and
/// `caret_text` cuts that to the node's own bound).
const WINDOW_BYTES: usize = 8 * 1024;

/// What the editor's text node shows of the document.
pub struct Shown {
    pub caret: CaretText,
    /// Said in the node's description when the text is a window.
    pub note: Option<String>,
}

/// The document's text for the node: all of it when small, else the whole
/// lines around the caret, with the caret and selection counted into that text
/// in UTF-16 units. A selection that starts or ends outside the window is
/// clamped to its edge.
pub fn text_window(session: &EditSession) -> Shown {
    let rope = session.rope();
    let lines = rope.len_lines();
    let (mut lo, mut hi) = (0, lines);
    if rope.len_bytes() > WINDOW_BYTES {
        let here = rope.char_to_line(session.cursor().min(rope.len_chars()));
        (lo, hi) = (here, here + 1);
        let size = |lo: usize, hi: usize| rope.line_to_byte(hi) - rope.line_to_byte(lo);
        loop {
            let before = lo > 0 && size(lo - 1, hi) <= WINDOW_BYTES;
            if before {
                lo -= 1;
            }
            let after = hi < lines && size(lo, hi + 1) <= WINDOW_BYTES;
            if after {
                hi += 1;
            }
            if !before && !after {
                break;
            }
        }
    }
    let (from, to) = (rope.line_to_char(lo), rope.line_to_char(hi));
    let within = |at: usize| at.clamp(from, to) - from;
    let raw = rope.slice(from..to).to_string();
    let caret = caret_text(&raw, within(session.anchor()), within(session.cursor()));
    let first = lo + caret.lines_before;
    let last = first + caret.text.matches('\n').count();
    let note = (lo > 0 || hi < lines || caret.windowed()).then(|| {
        format!(
            "the text holds only lines {} to {} of {}, around the caret",
            first + 1,
            last + 1,
            lines
        )
    });
    Shown { caret, note }
}
