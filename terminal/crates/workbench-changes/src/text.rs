//! Cell-width helpers: eliding, fitting and drawing text by display width.
//!
//! Written for this crate; not translated. Width is the terminal's: wide characters
//! count two cells and combining marks none (`unicode-width`).

use std::ops::Range;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_text::visible::hidden;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub(crate) fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// Stands in a `Debug` for text that is a file's content or a person's message: how much
/// there is, never what it says.
pub(crate) struct Withheld(pub usize);

impl std::fmt::Debug for Withheld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<{} bytes withheld>", self.0)
    }
}

/// A text a cell can hold: tabs become spaces, other control characters a mark.
pub(crate) fn printable(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\t' => out.push_str("    "),
            c if c.is_control() || hidden(c) => out.push('?'),
            c => out.push(c),
        }
    }
    out
}

/// The longest start of `text` that fits `max` cells.
pub(crate) fn clip(text: &str, max: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > max {
            return &text[..at];
        }
        used += w;
    }
    text
}

/// The longest end of `text` that fits `max` cells.
fn clip_end(text: &str, max: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices().rev() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > max {
            return &text[at + c.len_utf8()..];
        }
        used += w;
    }
    text
}

/// `text` in `max` cells, cut at the end with an ellipsis.
/// `text` broken into rows of at most `max` cells, at spaces where it can; a word wider
/// than a row is broken inside, the only case in which a word is not whole. Always at
/// least one row.
pub(crate) fn wrap(text: &str, max: usize) -> Vec<String> {
    let rows: Vec<String> = textwrap::wrap(text, max.max(1))
        .into_iter()
        .map(std::borrow::Cow::into_owned)
        .collect();
    if rows.is_empty() {
        vec![String::new()]
    } else {
        rows
    }
}

pub(crate) fn fit(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    if max == 0 {
        return String::new();
    }
    format!("{}…", clip(text, max - 1))
}

/// `text` in `max` cells, with the middle replaced by an ellipsis so that the start and
/// the end both show.
pub(crate) fn elide_middle(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    match max {
        0 => String::new(),
        1 => "…".to_owned(),
        _ => {
            let keep = max - 1;
            let head = keep.div_ceil(2);
            let tail = keep - head;
            format!("{}…{}", clip(text, head), clip_end(text, tail))
        }
    }
}

/// Draws `text` at `(x, y)` within `max` cells and returns the cells used.
pub(crate) fn put(buf: &mut Buffer, x: u16, y: u16, max: usize, text: &str, style: Style) -> usize {
    if max == 0 {
        return 0;
    }
    let (end, _) = buf.set_stringn(x, y, text, max, style);
    (end - x) as usize
}

/// Fills a row with a style.
pub(crate) fn paint(buf: &mut Buffer, rect: Rect, style: Style) {
    if rect.width > 0 && rect.height > 0 {
        buf.set_style(rect, style);
    }
}

/// `text` as pieces in order, each marked by whether it lies in a word range. Tabs and
/// control characters are made printable as the pieces are cut.
pub(crate) fn pieces(text: &str, words: &[Range<usize>]) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    for (at, c) in text.char_indices() {
        let marked = words.iter().any(|r| r.contains(&at));
        let mut one = String::new();
        one.push(c);
        let one = printable(&one);
        match out.last_mut() {
            Some((last, mark)) if *mark == marked => last.push_str(&one),
            _ => out.push((one, marked)),
        }
    }
    out
}

/// Draws a diff line's text with its changed words in `word` over `base`; `styles` is
/// `(base, word)`.
pub(crate) fn put_marked(
    buf: &mut Buffer,
    x: u16,
    y: u16,
    max: usize,
    text: &str,
    words: &[Range<usize>],
    (base, word): (Style, Style),
) {
    let mut at = x;
    let mut left = max;
    for (piece, marked) in pieces(text, words) {
        if left == 0 {
            break;
        }
        let style = if marked { base.patch(word) } else { base };
        let used = put(buf, at, y, left, &piece, style);
        at += used as u16;
        left -= used;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elides_in_the_middle_keeping_both_ends() {
        assert_eq!(elide_middle("src/deep/folder/file.rs", 12), "src/de…le.rs");
        assert_eq!(elide_middle("short.rs", 12), "short.rs");
        assert_eq!(elide_middle("abcdef", 1), "…");
        assert_eq!(elide_middle("abcdef", 0), "");
        assert!(width(&elide_middle("src/deep/folder/file.rs", 12)) <= 12);
    }

    #[test]
    fn wide_characters_are_counted_by_display_width() {
        let wide = "日本語のファイル.rs";
        assert_eq!(width("日本"), 4);
        for max in 0..width(wide) + 2 {
            assert!(width(&elide_middle(wide, max)) <= max);
            assert!(width(&fit(wide, max)) <= max);
        }
        // A wide character is never split to fit an odd count.
        assert_eq!(clip("日本", 3), "日");
    }

    #[test]
    fn pieces_mark_the_words_and_keep_tabs_in_the_row() {
        let got = pieces("a\tb c", &[Range { start: 2, end: 3 }]);
        assert_eq!(
            got,
            vec![
                ("a    ".to_owned(), false),
                ("b".to_owned(), true),
                (" c".to_owned(), false)
            ]
        );
    }
}
