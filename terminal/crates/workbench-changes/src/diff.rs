//! A unified diff as hunks of lines with the changed words marked, and the side-by-side
//! pairing of a hunk's lines.
//!
//! Translated from ELY-Open-Source/ELYTerminal at fbb536ec8f6e1466fa8c736967671ebf99a34080
//! (MIT, see `LICENSE-ELY`): `src/git/diff.rs` (blob bc1087ba8383e3f004352096ccf63cd0c968dfcc),
//! `starts` and `hunks`.
//!
//! Translated from ELY-Open-Source/Ely-GPUI-Components at 294a8323c08a06bd8e7782d16acee43b6bb0c5eb
//! (MIT): `src/git/diff.rs` (blob 657bb79eddc498eb418061f5c64c49090b32d64c), `LineKind`,
//! `DiffLine`, `pair_places`, `pairs`, `mark_words`, `side_numbers`.
//!
//! Changed: the donor runs `git diff` and reads its text; here the text is the owner's
//! `ScmDiffResult.text`, the same git output. The donor's `Stretch::Folded` (unchanged
//! lines between hunks) and its `diff(old, new)` / `stat` (a diff made from two texts)
//! are not carried: the wire gives the diff, not the two texts, so there are no folded
//! stretches to show. A line is an owned `String`, not a `SharedString`. A malformed line
//! is a typed error the panel shows, not an `anyhow` bail.

use std::ops::Range;

use similar::{ChangeTag, TextDiff};

/// Whether a diff line stayed, came in, or went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    Same,
    Added,
    Removed,
}

/// A diff line: kind, numbers from one, text, changed words (byte ranges into `text`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old: Option<usize>,
    pub new: Option<usize>,
    pub text: String,
    pub words: Vec<Range<usize>>,
}

/// A hunk: its `@@ -old +new @@` line and the lines under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// What a diff text holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parsed {
    /// Git said the files differ and printed no lines.
    Binary,
    /// No hunk at all: the files do not differ in any line.
    NoLines,
    Hunks(Vec<Hunk>),
}

/// A diff the panel could not read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    Header(String),
    Line(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Header(line) => write!(f, "hunk header {line:?} is malformed"),
            Self::Line(line) => write!(f, "diff line {line:?} is malformed"),
        }
    }
}

/// A hunk header's first old and new line numbers.
fn starts(header: &str) -> Option<(usize, usize)> {
    let mut ranges = header.strip_prefix("@@ -")?.split(' ');
    let first = |range: &str| range.split(',').next()?.parse().ok();
    let old = first(ranges.next()?)?;
    let new = first(ranges.next()?.strip_prefix('+')?)?;
    Some((old, new))
}

/// Git's unified diff as hunks, changed words marked (donor `hunks`).
pub fn parse(text: &str) -> Result<Parsed, ParseError> {
    let (mut hunks, mut at, mut inside): (Vec<Hunk>, (usize, usize), bool) =
        (Vec::new(), (0, 0), false);
    for line in text.lines() {
        if line.starts_with("diff ") {
            inside = false;
        } else if line.starts_with("@@") {
            at = starts(line).ok_or_else(|| ParseError::Header(line.to_owned()))?;
            hunks.push(Hunk {
                header: line.to_owned(),
                lines: Vec::new(),
            });
            inside = true;
        } else if !inside {
            if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                return Ok(Parsed::Binary);
            }
        } else if let Some(hunk) = hunks.last_mut() {
            let (kind, body) = match line.as_bytes().first() {
                // `diff.suppressBlankEmpty` drops a blank line's space.
                None => (LineKind::Same, ""),
                Some(b' ') => (LineKind::Same, &line[1..]),
                Some(b'-') => (LineKind::Removed, &line[1..]),
                Some(b'+') => (LineKind::Added, &line[1..]),
                Some(b'\\') => continue,
                Some(_) => return Err(ParseError::Line(line.to_owned())),
            };
            let old = (kind != LineKind::Added).then_some(at.0);
            let new = (kind != LineKind::Removed).then_some(at.1);
            at = (
                at.0 + usize::from(old.is_some()),
                at.1 + usize::from(new.is_some()),
            );
            hunk.lines.push(DiffLine {
                kind,
                old,
                new,
                text: body.to_owned(),
                words: Vec::new(),
            });
        }
    }
    if hunks.is_empty() {
        return Ok(Parsed::NoLines);
    }
    for hunk in &mut hunks {
        mark_words(&mut hunk.lines);
    }
    Ok(Parsed::Hunks(hunks))
}

/// A hunk's rows side by side, as places in `lines`.
pub fn pair_places(lines: &[DiffLine]) -> Vec<(Option<usize>, Option<usize>)> {
    let mut out = Vec::new();
    let mut ix = 0;
    while ix < lines.len() {
        if lines[ix].kind == LineKind::Same {
            out.push((Some(ix), Some(ix)));
            ix += 1;
            continue;
        }
        let run = |from: usize, kind| {
            from..from
                + lines[from..]
                    .iter()
                    .take_while(|line| line.kind == kind)
                    .count()
        };
        let removed = run(ix, LineKind::Removed);
        let added = run(removed.end, LineKind::Added);
        ix = added.end;
        for row in 0..removed.len().max(added.len()) {
            let at = |range: &Range<usize>| (row < range.len()).then(|| range.start + row);
            out.push((at(&removed), at(&added)));
        }
    }
    out
}

/// A hunk's lines side by side: removals beside following additions.
pub fn pairs(lines: &[DiffLine]) -> Vec<(Option<&DiffLine>, Option<&DiffLine>)> {
    pair_places(lines)
        .into_iter()
        .map(|(left, right)| (left.map(|ix| &lines[ix]), right.map(|ix| &lines[ix])))
        .collect()
}

/// Marks words changed between each removal and its addition.
pub fn mark_words(lines: &mut [DiffLine]) {
    for (left, right) in pair_places(lines) {
        let (Some(left), Some(right)) = (left, right) else {
            continue;
        };
        if left == right {
            continue;
        }
        let (old, new) = (lines[left].text.clone(), lines[right].text.clone());
        let diff = TextDiff::from_unicode_words(old.as_str(), new.as_str());
        let (mut at, mut words, mut kept) = ((0, 0), (Vec::new(), Vec::new()), false);
        for change in diff.iter_all_changes() {
            let (value, len) = (change.value(), change.value().len());
            let real = !value.trim().is_empty();
            match change.tag() {
                ChangeTag::Equal => {
                    kept |= real;
                    at = (at.0 + len, at.1 + len);
                }
                ChangeTag::Delete => {
                    words.0.extend(real.then(|| at.0..at.0 + len));
                    at.0 += len;
                }
                ChangeTag::Insert => {
                    words.1.extend(real.then(|| at.1..at.1 + len));
                    at.1 += len;
                }
            }
        }
        // Lines with nothing in common mark no words.
        if kept {
            (lines[left].words, lines[right].words) = words;
        }
    }
}

/// A side-by-side row's numbers: old left, new right.
pub fn side_numbers(
    left: Option<&DiffLine>,
    right: Option<&DiffLine>,
) -> (Option<usize>, Option<usize>) {
    (
        left.and_then(|line| line.old),
        right.and_then(|line| line.new),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old: None,
            new: None,
            text: text.to_owned(),
            words: Vec::new(),
        }
    }

    fn hunks(text: &str) -> Vec<Hunk> {
        match parse(text).expect("parses") {
            Parsed::Hunks(hunks) => hunks,
            other => panic!("hunks, not {other:?}"),
        }
    }

    #[test]
    fn a_change_shows_its_words_and_numbers() {
        let text = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n a\n-let x = 1;\n+let x = 2;\n c\n+d\n";
        let hunks = hunks(text);
        let [Hunk { header, lines }] = hunks.as_slice() else {
            panic!("one hunk, not {hunks:?}");
        };
        assert_eq!(header, "@@ -1,3 +1,4 @@");
        let kinds: Vec<LineKind> = lines.iter().map(|line| line.kind).collect();
        use LineKind::*;
        assert_eq!(kinds, [Same, Removed, Added, Same, Added]);
        assert_eq!(&lines[1].text[lines[1].words[0].clone()], "1");
        assert_eq!((lines[2].old, lines[2].new), (None, Some(2)));
        assert_eq!((lines[4].old, lines[4].new), (None, Some(4)));
    }

    #[test]
    fn removals_sit_beside_the_additions_after_them() {
        let lines = vec![
            line(LineKind::Same, "a"),
            line(LineKind::Removed, "b"),
            line(LineKind::Removed, "c"),
            line(LineKind::Added, "B"),
            line(LineKind::Added, "C"),
            line(LineKind::Added, "D"),
        ];
        let sides: Vec<(bool, bool)> = pairs(&lines)
            .iter()
            .map(|(left, right)| (left.is_some(), right.is_some()))
            .collect();
        assert_eq!(
            sides,
            [(true, true), (true, true), (true, true), (false, true)]
        );
    }

    #[test]
    fn words_are_marked_on_lines_built_elsewhere() {
        let mut lines = vec![
            line(LineKind::Removed, "let x = 1;"),
            line(LineKind::Removed, "abc"),
            line(LineKind::Added, "let x = 2;"),
            line(LineKind::Added, "xyz"),
        ];
        mark_words(&mut lines);
        assert_eq!(&lines[0].text[lines[0].words[0].clone()], "1");
        assert_eq!(&lines[2].text[lines[2].words[0].clone()], "2");
        assert!(
            lines[1].words.is_empty() && lines[3].words.is_empty(),
            "nothing shared"
        );
    }

    #[test]
    fn each_side_numbers_its_own_file() {
        let hunks = hunks("@@ -1,2 +1,3 @@\n+x\n a\n b\n");
        let numbers: Vec<_> = pairs(&hunks[0].lines)
            .into_iter()
            .map(|(left, right)| side_numbers(left, right))
            .collect();
        assert_eq!(
            numbers,
            [(None, Some(1)), (Some(1), Some(2)), (Some(2), Some(3))]
        );
    }

    #[test]
    fn an_empty_side_starts_before_its_range() {
        let hunks = hunks("@@ -0,0 +1 @@\n+a\n");
        assert_eq!(hunks[0].header, "@@ -0,0 +1 @@");
        assert_eq!(hunks[0].lines[0].new, Some(1));
        assert_eq!(hunks[0].lines[0].old, None);
    }

    #[test]
    fn a_binary_file_has_no_lines_and_a_clean_one_none_to_show() {
        assert_eq!(
            parse("diff --git a/x b/x\nBinary files a/x and b/x differ\n"),
            Ok(Parsed::Binary)
        );
        assert_eq!(parse(""), Ok(Parsed::NoLines));
    }

    #[test]
    fn a_blank_context_line_and_a_missing_newline_note_are_read() {
        let hunks = hunks("@@ -1,2 +1,2 @@\n\n-a\n+b\n\\ No newline at end of file\n");
        let kinds: Vec<_> = hunks[0].lines.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, [LineKind::Same, LineKind::Removed, LineKind::Added]);
    }

    #[test]
    fn a_malformed_diff_is_an_error_not_a_guess() {
        assert!(matches!(parse("@@ nonsense\n"), Err(ParseError::Header(_))));
        assert!(matches!(
            parse("@@ -1 +1 @@\n?what\n"),
            Err(ParseError::Line(_))
        ));
    }
}
