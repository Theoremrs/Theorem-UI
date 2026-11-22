//! Search in the file: the query, the matches, and which one the caret is on.
//!
//! A match is a range of scalars at one revision of the text. The text moves
//! under pending edits as well as under the owner's revisions, so the stamp is
//! the accepted revision and a counter of local changes; when either differs
//! from the one the ranges were found at, they are found again before they are
//! shown or stepped to.
//!
//! The search itself is `str::match_indices` over a copy of the text with each
//! character folded to one character (so scalar offsets survive the fold) and
//! the hits kept only where they begin and end between grapheme clusters, so a
//! search for `e` does not select half of `e` plus a combining accent.

use theorem_workbench_text::EditSession;

use crate::field::Field;

/// Most matches kept. More are counted as "10000+" rather than stored.
pub const MAX_MATCHES: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    revision: u64,
    version: u64,
    query: String,
    case_sensitive: bool,
}

#[derive(Debug, Default)]
pub struct Find {
    open: bool,
    pub field: Field,
    /// What a replace puts where the match was. Taken literally.
    pub replacement: Field,
    /// The replace row is shown.
    replacing: bool,
    case_sensitive: bool,
    stamp: Option<Stamp>,
    ranges: Vec<(usize, usize)>,
    truncated: bool,
}

/// The one-to-one fold: a character whose lowercase is more than one
/// character stays as it is, so the folded text has the original's length.
fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

impl Find {
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn open(&mut self, seed: Option<String>) {
        self.open = true;
        if let Some(seed) = seed.filter(|s| !s.is_empty() && !s.contains('\n')) {
            self.field = Field::new(&seed);
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.replacing = false;
    }

    /// Open with the replace row, which is the find bar's second row.
    pub fn open_replacing(&mut self, seed: Option<String>) {
        self.open(seed);
        self.replacing = true;
    }

    pub fn is_replacing(&self) -> bool {
        self.open && self.replacing
    }

    /// The rows the bar takes.
    pub fn rows(&self) -> u16 {
        if !self.open {
            0
        } else if self.replacing {
            2
        } else {
            1
        }
    }

    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }

    pub fn toggle_case(&mut self) {
        self.case_sensitive = !self.case_sensitive;
    }

    pub fn query(&self) -> &str {
        self.field.value()
    }

    /// The matches found at the stamp last refreshed.
    pub fn ranges(&self) -> &[(usize, usize)] {
        if self.open { &self.ranges } else { &[] }
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// The revision the ranges were found at, for a range that leaves the crate.
    pub fn revision(&self) -> Option<u64> {
        self.stamp.as_ref().map(|s| s.revision)
    }

    /// Find again when the text, the revision, the query or the case switch
    /// changed since the last time.
    pub fn refresh(&mut self, session: &EditSession, version: u64) {
        if !self.open {
            return;
        }
        let stamp = Stamp {
            revision: session.accepted_revision(),
            version,
            query: self.field.value().to_owned(),
            case_sensitive: self.case_sensitive,
        };
        if self.stamp.as_ref() == Some(&stamp) {
            return;
        }
        (self.ranges, self.truncated) = if stamp.query.is_empty() {
            (Vec::new(), false)
        } else {
            search(session, &stamp.query, stamp.case_sensitive)
        };
        self.stamp = Some(stamp);
    }

    /// The match the selection is exactly on.
    pub fn current(&self, session: &EditSession) -> Option<usize> {
        let sel = session.selection()?;
        self.ranges()
            .binary_search_by(|r| r.0.cmp(&sel.0))
            .ok()
            .filter(|&i| self.ranges[i] == sel)
    }

    /// The first match that starts at or after `offset`, wrapping to the first:
    /// where a search lands while the query is still being typed.
    pub fn first_from(&self, offset: usize) -> Option<(usize, usize)> {
        self.ranges
            .iter()
            .find(|r| r.0 >= offset)
            .or(self.ranges.first())
            .copied()
    }

    /// The match after the caret (or before it), wrapping around the ends.
    pub fn step(&self, session: &EditSession, forward: bool) -> Option<(usize, usize)> {
        let ranges = self.ranges();
        if ranges.is_empty() {
            return None;
        }
        let (lo, hi) = session
            .selection()
            .unwrap_or((session.cursor(), session.cursor()));
        let found = if forward {
            ranges
                .iter()
                .find(|r| r.0 >= hi && (r.0 > lo || r.1 > hi || lo == hi))
        } else {
            ranges.iter().rev().find(|r| r.1 <= lo && r.0 < lo)
        };
        found
            .or(if forward {
                ranges.first()
            } else {
                ranges.last()
            })
            .copied()
    }

    /// "3 of 12", "12 matches", "no matches", or nothing for an empty query.
    pub fn summary(&self, session: &EditSession) -> String {
        if self.field.is_empty() {
            return String::new();
        }
        let n = self.ranges.len();
        let plus = if self.truncated { "+" } else { "" };
        match (n, self.current(session)) {
            (0, _) => "no matches".to_owned(),
            (_, Some(i)) => format!("{} of {n}{plus}", i + 1),
            (1, None) => "1 match".to_owned(),
            _ => format!("{n}{plus} matches"),
        }
    }
}

fn search(session: &EditSession, query: &str, case_sensitive: bool) -> (Vec<(usize, usize)>, bool) {
    let text = session.text();
    let (hay, needle): (String, String) = if case_sensitive {
        (text, query.to_owned())
    } else {
        (
            text.chars().map(fold).collect(),
            query.chars().map(fold).collect(),
        )
    };
    let coords = session.coords();
    let qlen = needle.chars().count();
    let (mut out, mut truncated) = (Vec::new(), false);
    // Byte offsets into the folded text become scalar offsets by counting
    // forward from the previous hit, so the whole pass is linear.
    let (mut byte, mut scalar) = (0usize, 0usize);
    for (at, _) in hay.match_indices(&needle) {
        scalar += hay[byte..at].chars().count();
        byte = at;
        if coords.is_grapheme_boundary(scalar) && coords.is_grapheme_boundary(scalar + qlen) {
            if out.len() == MAX_MATCHES {
                truncated = true;
                break;
            }
            out.push((scalar, scalar + qlen));
        }
    }
    (out, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use theorem_workbench_text::SessionConfig;

    fn found(text: &str, query: &str, case: bool) -> Vec<(usize, usize)> {
        let s = EditSession::new(text, 1, SessionConfig::new("t"));
        let mut f = Find::default();
        f.open(Some(query.into()));
        if case {
            f.toggle_case();
        }
        f.refresh(&s, 0);
        f.ranges().to_vec()
    }

    #[test]
    fn a_search_ignores_case_unless_asked_and_counts_in_scalars() {
        assert_eq!(
            found("Abc abc ABC", "abc", false),
            vec![(0, 3), (4, 7), (8, 11)]
        );
        assert_eq!(found("Abc abc ABC", "abc", true), vec![(4, 7)]);
        // Two scalars before the hit: the offsets are scalars, not bytes.
        assert_eq!(found("\u{4e2d}\u{6587}x", "x", false), vec![(2, 3)]);
    }

    #[test]
    fn a_hit_inside_a_grapheme_cluster_is_not_a_match() {
        // e + combining acute is one cluster: "e" alone is not a match in it.
        assert_eq!(found("e\u{301} e", "e", false), vec![(3, 4)]);
    }

    #[test]
    fn stepping_wraps_around_both_ends() {
        let s = EditSession::new("ab ab ab", 1, SessionConfig::new("t"));
        let mut f = Find::default();
        f.open(Some("ab".into()));
        f.refresh(&s, 0);
        assert_eq!(f.step(&s, true), Some((0, 2)));
        assert_eq!(f.step(&s, false), Some((6, 8)));
    }
}
