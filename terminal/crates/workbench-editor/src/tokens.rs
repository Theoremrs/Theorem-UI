//! Syntax colour the host computed, kept in step with a text that moves.
//!
//! The host sends spans for one revision of the owner's text. A panel's text
//! is that revision plus whatever the person has typed since, so the colour is
//! not always for the text on screen. [`TokenState`] holds the rule:
//!
//! * Spans for the revision the session has accepted are laid out at once.
//! * Spans for a later revision wait until that revision is accepted.
//! * Spans for an earlier revision are not applied.
//! * While the text has moved on from the spans' text (an edit is pending or
//!   the person typed), lines that did not change at the start and the end
//!   keep their colour and the lines between are plain until new spans
//!   arrive. A span across a line that did not survive is dropped.
//! * A span that is not a place in the text, or that overlaps the one before,
//!   is dropped rather than drawn on the wrong words.
//!
//! How a panel uses it:
//!
//! 1. On `HostMessage::DocumentTokens` for its resource, call
//!    [`TokenState::offer`] with the message's revision, encoding and spans.
//! 2. After every message that can change the text or the accepted revision,
//!    call [`TokenState::refresh`] with the session and a `version` that
//!    changes whenever the text does (a counter the panel bumps on each edit).
//! 3. When drawing, call [`TokenState::marks`] with the same session and
//!    version and the styles, and pass the result to the paint as its tokens.
//!    Colour laid out for another text or version is not returned.

use theorem_workbench_core::host::TokenSpan;
use theorem_workbench_core::results::{Span, SpanEncoding};
use theorem_workbench_text::EditSession;

use crate::panel::span_offsets;
use crate::{EditorStyles, Mark};

type Spans = Vec<(usize, usize, String)>;

/// The host's spans for the revision they were computed at, as scalar ranges
/// of that revision's text, and the same spans as they lie on the text now.
#[derive(Debug)]
struct Laid {
    revision: u64,
    text: String,
    spans: Spans,
    shown: Spans,
    shown_key: Option<(u64, u64, bool)>,
}

/// Spans for a revision the panel has not reached yet.
#[derive(Debug)]
struct Waiting {
    revision: u64,
    encoding: SpanEncoding,
    spans: Vec<TokenSpan>,
}

#[derive(Debug, Default)]
pub struct TokenState {
    laid: Option<Laid>,
    waiting: Option<Waiting>,
}

impl TokenState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The host's spans for `revision`. Laid out now when the session has
    /// accepted that revision, held when it is ahead, dropped when it is
    /// behind.
    pub fn offer(
        &mut self,
        session: &EditSession,
        revision: u64,
        encoding: SpanEncoding,
        spans: &[TokenSpan],
    ) {
        let accepted = session.accepted_revision();
        if revision == accepted {
            self.lay(session, revision, encoding, spans);
            self.waiting = None;
        } else if revision > accepted {
            self.waiting = Some(Waiting {
                revision,
                encoding,
                spans: spans.to_vec(),
            });
        }
    }

    /// Take waiting spans whose revision has arrived and lay the colour out
    /// for the text as it is now. Cheap when nothing changed.
    pub fn refresh(&mut self, session: &EditSession, version: u64) {
        let accepted = session.accepted_revision();
        if let Some(w) = self.waiting.take() {
            if w.revision == accepted {
                self.lay(session, w.revision, w.encoding, &w.spans);
            } else if w.revision > accepted {
                self.waiting = Some(w);
            }
        }
        let key = (version, accepted, session.has_pending());
        let Some(t) = &mut self.laid else { return };
        if t.shown_key == Some(key) {
            return;
        }
        t.shown = if t.revision == accepted && !key.2 {
            t.spans.clone()
        } else {
            carry(&t.text, &session.text(), &t.spans)
        };
        t.shown_key = Some(key);
    }

    /// The colour to draw, as marks over scalar offsets of the session's text.
    pub fn marks(&self, session: &EditSession, version: u64, styles: &EditorStyles) -> Vec<Mark> {
        let Some(t) = &self.laid else {
            return Vec::new();
        };
        // Colour laid out for other text would be colour on the wrong words.
        let key = (version, session.accepted_revision(), session.has_pending());
        if t.shown_key != Some(key) {
            return Vec::new();
        }
        t.shown
            .iter()
            .map(|(start, end, class)| Mark {
                start: *start,
                end: *end,
                style: styles.class(class),
            })
            .collect()
    }

    fn lay(
        &mut self,
        session: &EditSession,
        revision: u64,
        encoding: SpanEncoding,
        spans: &[TokenSpan],
    ) {
        let text = session.accepted_text();
        let mut out = Vec::with_capacity(spans.len());
        let mut last = 0;
        for s in spans {
            let span = Span {
                start: s.start,
                end: s.end,
                encoding,
            };
            if let Some((start, end)) = span_offsets(&text, &span)
                && start >= last
                && start < end
            {
                out.push((start, end, s.class.clone()));
                last = end;
            }
        }
        self.laid = Some(Laid {
            revision,
            text,
            spans: out,
            shown: Vec::new(),
            shown_key: None,
        });
    }
}

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, ch) in text.chars().enumerate() {
        if ch == '\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// Where the old spans lie in the new text. Lines that are the same at the
/// start and at the end of both texts keep their colour; the lines between
/// are plain until the host's next spans arrive. A span that crosses a line
/// that did not survive is dropped.
fn carry(old: &str, new: &str, spans: &[(usize, usize, String)]) -> Spans {
    let (ol, nl): (Vec<&str>, Vec<&str>) = (old.split('\n').collect(), new.split('\n').collect());
    let prefix = ol.iter().zip(&nl).take_while(|(a, b)| a == b).count();
    let suffix = ol
        .iter()
        .rev()
        .zip(nl.iter().rev())
        .take(ol.len().min(nl.len()) - prefix)
        .take_while(|(a, b)| a == b)
        .count();
    let (os, ns) = (line_starts(old), line_starts(new));
    let map = |line: usize| -> Option<usize> {
        if line < prefix {
            Some(line)
        } else if line >= ol.len() - suffix {
            Some(nl.len() - (ol.len() - line))
        } else {
            None
        }
    };
    let line_of = |at: usize| os.partition_point(|s| *s <= at) - 1;
    let delta = |line: usize| Some(ns[map(line)?] as isize - os[line] as isize);
    spans
        .iter()
        .filter_map(|(start, end, class)| {
            let (first, last) = (line_of(*start), line_of(end.saturating_sub(1).max(*start)));
            let d = delta(first)?;
            // A span over several lines needs every one of them to have moved
            // by the same distance.
            if (first + 1..=last).any(|l| delta(l) != Some(d)) {
                return None;
            }
            Some((
                usize::try_from(*start as isize + d).ok()?,
                usize::try_from(*end as isize + d).ok()?,
                class.clone(),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_stays_on_lines_that_did_not_change_and_leaves_the_rest_plain() {
        let old = "let a\nlet b\nlet c";
        let spans = vec![
            (0, 3, "keyword".to_owned()),
            (6, 9, "keyword".to_owned()),
            (12, 15, "keyword".to_owned()),
        ];
        // A line is inserted in the middle and the last one is untouched.
        let new = "let a\nlet b!\nnew\nlet c";
        let kept = carry(old, new, &spans);
        let starts: Vec<usize> = kept.iter().map(|s| s.0).collect();
        assert_eq!(
            starts,
            vec![0, 17],
            "first and last lines keep their colour"
        );
        assert!(carry(old, old, &spans).len() == 3);
    }
}
