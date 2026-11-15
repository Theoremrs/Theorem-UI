//! The text and caret a text-edit node publishes (SPEC section "semantic tree";
//! `Node::selection` counts UTF-16 units into `Node::text`).
//!
//! Every panel that takes typing builds its text node here, so the three
//! things that make a caret wrong are decided once:
//!
//! * the node's text is the *escaped* text (control and hidden characters
//!   spelled out by `visible`, newline and tab kept as they are), and the
//!   offsets count into the escaped text, not the typed text;
//! * the offsets are UTF-16 code units, so an astral character counts 2 and a
//!   combining mark counts 1;
//! * the text stays under [`MAX_NODE_TEXT`]: past it, a window of whole text
//!   around the caret is published instead, and the caller says so in the
//!   node's description (see [`CaretText::windowed`]).

use crate::semantics::{MAX_NODE_TEXT, Node, TextSelection};
use theorem_workbench_text::visible::{hidden, visible};

/// What a text node carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaretText {
    /// The escaped text, or the window of it that holds the caret.
    pub text: String,
    /// Anchor and focus inside `text`, in UTF-16 units.
    pub selection: TextSelection,
    /// Whether `text` leaves out some of the escaped text at the start.
    pub cut_before: bool,
    /// Whether `text` leaves out some of the escaped text at the end.
    pub cut_after: bool,
    /// The lines of the escaped text before the window (0 when not cut).
    pub lines_before: usize,
}

impl CaretText {
    /// Whether this is a window of a longer text.
    pub fn windowed(&self) -> bool {
        self.cut_before || self.cut_after
    }

    /// Set this as the node's text and selection.
    pub fn put(self, node: &mut Node) {
        node.text = Some(self.text);
        node.selection = Some(self.selection);
    }
}

/// Escape one character: the text is shown as typed except what a terminal or
/// reader would act on or hide. Newline and tab keep their shape.
fn push_escaped(out: &mut String, c: char) {
    if c != '\n' && c != '\t' && (c.is_control() || hidden(c)) {
        out.push_str(&visible(c.encode_utf8(&mut [0; 4])));
    } else {
        out.push(c);
    }
}

/// The text node content for `raw` with the selection from scalar offset
/// `anchor` to `focus` (the caret). Offsets past the end are clamped to it.
pub fn caret_text(raw: &str, anchor: usize, focus: usize) -> CaretText {
    caret_text_within(raw, anchor, focus, MAX_NODE_TEXT)
}

/// [`caret_text`] with a smaller bound, for tests and for callers that want a
/// shorter window.
pub fn caret_text_within(raw: &str, anchor: usize, focus: usize, max_bytes: usize) -> CaretText {
    let mut escaped = String::with_capacity(raw.len());
    // Byte offset in `escaped` of the scalar at each of anchor and focus.
    let (mut anchor_at, mut focus_at) = (None, None);
    for (i, c) in raw.chars().enumerate() {
        if i == anchor {
            anchor_at = Some(escaped.len());
        }
        if i == focus {
            focus_at = Some(escaped.len());
        }
        push_escaped(&mut escaped, c);
    }
    let anchor_at = anchor_at.unwrap_or(escaped.len());
    let focus_at = focus_at.unwrap_or(escaped.len());

    let (start, end) = if escaped.len() <= max_bytes {
        (0, escaped.len())
    } else {
        window(&escaped, focus_at, max_bytes)
    };
    let clamp = |at: usize| at.clamp(start, end);
    let units = |at: usize| escaped[start..clamp(at)].encode_utf16().count() as u32;
    CaretText {
        selection: TextSelection {
            anchor: units(anchor_at),
            focus: units(focus_at),
        },
        cut_before: start > 0,
        cut_after: end < escaped.len(),
        lines_before: escaped[..start].matches('\n').count(),
        text: escaped[start..end].to_owned(),
    }
}

/// A byte range of at most `max` bytes holding `at`, on character boundaries,
/// starting after a line break when one is near enough to keep the window on
/// whole lines.
fn window(text: &str, at: usize, max: usize) -> (usize, usize) {
    let mut start = at.saturating_sub(max / 2);
    let mut end = (start + max).min(text.len());
    start = end.saturating_sub(max).min(start);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    // Begin on a line start when that costs less than a quarter of the window.
    if start > 0
        && let Some(nl) = text[start..at].find('\n')
        && nl < max / 4
    {
        start += nl + 1;
    }
    (start, end.max(at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(c: &CaretText) -> (u32, u32) {
        (c.selection.anchor, c.selection.focus)
    }

    /// The core's own rule for a selection: on a character boundary of the
    /// node's text.
    fn valid(c: &CaretText) -> bool {
        let mut at = vec![0u32];
        let mut n = 0u32;
        for ch in c.text.chars() {
            n += ch.len_utf16() as u32;
            at.push(n);
        }
        at.contains(&c.selection.anchor) && at.contains(&c.selection.focus)
    }

    #[test]
    fn ascii_caret_is_its_scalar_offset() {
        let c = caret_text("hello", 2, 2);
        assert_eq!(c.text, "hello");
        assert_eq!(sel(&c), (2, 2));
        assert!(!c.windowed());
    }

    #[test]
    fn astral_characters_count_two_units() {
        // U+1F600 is 4 UTF-8 bytes, 2 UTF-16 units, 1 scalar.
        let c = caret_text("a\u{1F600}b", 2, 3);
        assert_eq!(sel(&c), (3, 4));
        assert!(valid(&c));
    }

    #[test]
    fn multibyte_characters_count_one_unit() {
        let c = caret_text("日本語", 1, 3);
        assert_eq!(sel(&c), (1, 3));
    }

    #[test]
    fn combining_marks_count_one_unit_each() {
        // e + U+0301: two scalars, two units, one grapheme.
        let c = caret_text("e\u{301}x", 2, 2);
        assert_eq!(sel(&c), (2, 2));
        assert!(valid(&c));
    }

    #[test]
    fn offsets_count_into_the_escaped_text() {
        // ESC becomes `\u{1b}` (6 units) and a right-to-left override
        // `\u{202e}` (8 units); the caret after both is 14 + 1 units in.
        let c = caret_text("\u{1b}\u{202e}x", 3, 3);
        assert_eq!(c.text, "\\u{1b}\\u{202e}x");
        assert_eq!(sel(&c), (15, 15));
        assert!(valid(&c));
        // A caret between the two escapes lands between them.
        let c = caret_text("\u{1b}\u{202e}x", 1, 1);
        assert_eq!(sel(&c), (6, 6));
    }

    #[test]
    fn newline_and_tab_are_kept() {
        let c = caret_text("a\n\tb", 4, 4);
        assert_eq!(c.text, "a\n\tb");
        assert_eq!(sel(&c), (4, 4));
    }

    #[test]
    fn anchor_and_focus_keep_their_order() {
        let c = caret_text("abcdef", 4, 1);
        assert_eq!(sel(&c), (4, 1));
    }

    #[test]
    fn offsets_past_the_end_are_clamped() {
        let c = caret_text("ab", 9, 9);
        assert_eq!(sel(&c), (2, 2));
    }

    #[test]
    fn a_long_text_publishes_a_window_that_holds_the_caret() {
        let raw: String = (0..2000)
            .map(|i| format!("row {i:04} \u{1F600} \u{e9}\n"))
            .collect();
        // The caret is three characters into line 1000.
        let caret = raw
            .find("row 1000")
            .map(|b| raw[..b].chars().count())
            .unwrap()
            + 3;
        let c = caret_text_within(&raw, caret, caret, 1000);
        assert!(c.text.len() <= 1000);
        assert!(c.cut_before && c.cut_after && c.windowed());
        assert!(valid(&c));
        // The text before the focus ends with what the caret follows in the
        // document, and the window begins on a whole line.
        let upto: String = {
            let mut units = 0;
            c.text
                .chars()
                .take_while(|ch| {
                    let hit = units < c.selection.focus;
                    units += ch.len_utf16() as u32;
                    hit
                })
                .collect()
        };
        assert!(upto.ends_with("row"), "{upto:?}");
        assert!(c.text.starts_with("row "), "{:?}", &c.text[..12]);
        let first: usize = c.text[4..8].parse().unwrap();
        assert_eq!(c.lines_before, first);
    }

    #[test]
    fn a_window_over_one_enormous_line_still_holds_the_caret() {
        let raw = "\u{1F600}".repeat(10_000);
        let c = caret_text_within(&raw, 9_000, 9_000, 800);
        assert!(c.text.len() <= 800);
        assert!(valid(&c));
        assert!(
            c.selection.focus > 0 && (c.selection.focus as usize) < c.text.encode_utf16().count()
        );
    }

    #[test]
    fn a_selection_larger_than_the_window_is_clamped_into_it() {
        let raw = "x".repeat(5_000);
        let c = caret_text_within(&raw, 0, 4_900, 1000);
        assert!(valid(&c));
        assert!(c.selection.focus as usize <= c.text.len());
        assert!(c.selection.anchor <= c.selection.focus);
    }

    #[test]
    fn hostile_text_never_reaches_the_node_unescaped() {
        let raw = "a\u{1b}[2Jb\u{202e}c\u{0}d\u{7}";
        let c = caret_text(raw, raw.chars().count(), raw.chars().count());
        assert!(
            !c.text
                .chars()
                .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
        );
        assert!(!c.text.chars().any(hidden));
        assert!(valid(&c));
        assert_eq!(c.selection.focus as usize, c.text.encode_utf16().count());
    }

    #[test]
    fn put_sets_text_and_selection_that_pass_the_trees_own_check() {
        use crate::semantics::{Role, SemanticTree};
        use ratatui::layout::Rect;
        let mut n = Node::new("t", Role::TextBox, "T", Rect::new(0, 0, 10, 1));
        caret_text("x\u{1F600}\u{301}\u{1b}y", 3, 5).put(&mut n);
        let tree = SemanticTree {
            root: n.id.clone(),
            nodes: vec![n],
        };
        assert_eq!(tree.validate(), Ok(()));
    }
}
