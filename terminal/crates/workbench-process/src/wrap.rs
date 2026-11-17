//! Word wrap for the pane's own text, by display cells, on the same rule the
//! editors use (`theorem_workbench_text::layout`): a row ends after the last
//! space that fits, and only a word wider than the pane is cut.

use ropey::Rope;
use theorem_workbench_text::layout::line_rows;

/// `text` as rows no wider than `width` cells. Never empty; width 0 gives one
/// row per line, unwrapped.
pub(crate) fn wrap(text: &str, width: u16) -> Vec<String> {
    let rope = Rope::from_str(text);
    let mut out = vec![];
    for line in 0..rope.len_lines().max(1) {
        for row in line_rows(&rope, line, usize::from(width), 4) {
            let row = rope.slice(row.start..row.end).to_string();
            out.push(row.trim_end().to_owned());
        }
    }
    out
}

/// Like [`wrap`] with a different width for the first row, which shares its
/// line with something else (a header's End process control).
pub(crate) fn wrap_first(text: &str, first: u16, rest: u16) -> Vec<String> {
    let head = wrap(text, first).swap_remove(0);
    let used = head.chars().count();
    let tail: String = text.chars().skip(used).collect();
    let tail = tail.trim_start();
    let mut out = vec![head];
    if !tail.is_empty() {
        out.extend(wrap(tail, rest));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{wrap, wrap_first};

    #[test]
    fn rows_break_on_spaces_and_only_a_too_wide_word_is_cut() {
        assert_eq!(wrap("one two three", 8), ["one two", "three"]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(wrap("", 5), [""]);
    }

    #[test]
    fn the_first_row_may_be_narrower_than_the_rest() {
        assert_eq!(wrap_first("aaa bbb ccc ddd", 8, 20), ["aaa bbb", "ccc ddd"]);
        assert_eq!(wrap_first("short", 20, 20), ["short"]);
    }
}
