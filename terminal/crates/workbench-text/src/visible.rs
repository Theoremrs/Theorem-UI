//! Untrusted text made safe to show and to put in a semantic node: what a
//! terminal or a screen reader would act on or hide is spelled out, so a
//! name, a reason or a report reads as what it is.
//!
//! `str::escape_debug` is not used. It does spell out controls, bidirectional
//! controls, zero-width and joiner marks, the soft hyphen, the BOM and
//! U+2028/2029, but it also rewrites printable text the panels must show as
//! it is (`"` and `\` get a backslash, a combining mark and U+00A0 are
//! escaped), and it writes `\n` and `\t` where the panels spell `\u{a}` and
//! `\u{9}`. The list below is the set it would have to be filtered down to.

/// A character a terminal or a reader would act on or hide, beyond the
/// control characters: bidirectional overrides and isolates, zero-width and
/// joiner marks, the soft hyphen, the BOM and the line and paragraph
/// separators. The standard library has no test for the Unicode format
/// category, so the ranges are listed.
pub fn hidden(c: char) -> bool {
    matches!(
        c,
        '\u{ad}'
            | '\u{61c}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
    )
}

/// `text` with every control or hidden character spelled out as `\u{..}`;
/// everything else, quotes and backslashes included, is left as it is.
pub fn visible(text: &str) -> String {
    if !text.chars().any(|c| c.is_control() || hidden(c)) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_control() || hidden(c) {
            out.push_str(&format!("\\u{{{:x}}}", u32::from(c)));
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{hidden, visible};

    #[test]
    fn plain_text_is_unchanged_including_what_escape_debug_would_change() {
        for plain in [
            "https://a.example/é",
            "say \"hi\" \\ there",
            "e\u{301}",
            "a\u{a0}b",
            "日本語",
        ] {
            assert_eq!(visible(plain), plain);
        }
    }

    #[test]
    fn controls_and_hidden_characters_are_spelled_out() {
        assert_eq!(visible("a\u{1b}[31mb"), "a\\u{1b}[31mb");
        assert_eq!(visible("x\u{202e}y\n"), "x\\u{202e}y\\u{a}");
        assert_eq!(visible("\u{85}\u{7f}\t"), "\\u{85}\\u{7f}\\u{9}");
    }

    #[test]
    fn every_hidden_range_is_spelled_out_at_both_ends() {
        for c in [
            '\u{ad}', '\u{61c}', '\u{180e}', '\u{200b}', '\u{200f}', '\u{2028}', '\u{2029}',
            '\u{202a}', '\u{202e}', '\u{2060}', '\u{2066}', '\u{2069}', '\u{206f}', '\u{feff}',
            '\u{fff9}', '\u{fffb}',
        ] {
            assert!(hidden(c), "{c:?}");
            assert_eq!(
                visible(&c.to_string()),
                format!("\\u{{{:x}}}", u32::from(c))
            );
        }
        assert!(!hidden('a') && !hidden('\u{2070}') && !hidden('\u{fffc}'));
    }
}
