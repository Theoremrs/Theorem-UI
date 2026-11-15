//! Text from a document or from outside the workbench, made safe to show and
//! to put in a semantic node: what a terminal or a screen reader would act on
//! or hide is spelled out, so a link or a name reads as what it is.

/// `text` with every control character and every invisible formatting
/// character (bidirectional overrides, zero-width and joiner marks, the BOM)
/// written as `\u{..}`. The standard library has no test for the Unicode
/// format category, so the ranges are listed.
pub(crate) fn visible(text: &str) -> String {
    if !text.chars().any(hidden) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if hidden(c) {
            out.push_str(&format!("\\u{{{:x}}}", u32::from(c)));
        } else {
            out.push(c);
        }
    }
    out
}

fn hidden(c: char) -> bool {
    c.is_control()
        || matches!(
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

#[cfg(test)]
mod tests {
    use super::visible;

    #[test]
    fn plain_text_is_unchanged_and_hidden_characters_are_spelled_out() {
        assert_eq!(visible("https://a.example/é"), "https://a.example/é");
        assert_eq!(visible("a\u{1b}[31mb"), "a\\u{1b}[31mb");
        assert_eq!(visible("x\u{202e}y\n"), "x\\u{202e}y\\u{a}");
    }
}
