//! Syntax colour for Source and the source side of Split: the host's spans for
//! one revision, drawn through the editor's `Paint`.
//!
//! The rule is the editor's. Spans for the revision the panel holds are
//! drawn as they come. Spans for a later revision wait until that revision is
//! accepted; spans for an earlier one are not applied. While the text has moved
//! on from the spans' text (an edit is pending), the lines that did not change
//! keep their colour and the lines between are plain until new spans arrive.

use theorem_workbench_core::host::TokenSpan;
use theorem_workbench_core::results::SpanEncoding;
use theorem_workbench_editor::{EditorStyles, Mark};
use theorem_workbench_text::{Snap, Unit};

use super::Doc;

type Spans = Vec<(usize, usize, String)>;

/// Colour the host computed: classes over scalar ranges of `text`, the
/// owner's text at `revision`.
#[derive(Debug)]
pub(crate) struct Tokens {
    revision: u64,
    text: String,
    spans: Spans,
    /// The spans as they lie on the text now, and what that text was.
    shown: Spans,
    shown_for: Option<(u64, bool, String)>,
}

/// Spans for a revision the panel has not reached yet.
#[derive(Debug)]
pub(crate) struct Waiting {
    pub revision: u64,
    pub encoding: SpanEncoding,
    pub spans: Vec<TokenSpan>,
}

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(
        text.chars()
            .enumerate()
            .filter(|(_, c)| *c == '\n')
            .map(|(i, _)| i + 1),
    );
    starts
}

/// Where the old spans lie in the new text: lines that are the same at the
/// start and at the end of both texts keep their colour, and a span across a
/// line that did not survive is dropped.
fn carry(old: &str, new: &str, spans: &Spans) -> Spans {
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

fn unit_of(encoding: SpanEncoding) -> Unit {
    match encoding {
        SpanEncoding::Utf8Bytes => Unit::Utf8,
        SpanEncoding::Utf16CodeUnits => Unit::Utf16,
        SpanEncoding::UnicodeScalars => Unit::Scalar,
    }
}

impl Doc {
    /// The host's spans for `revision`, which is the accepted one and has no
    /// edit on top of it (so the session's text is its text), as scalar ranges. A span that is not a place in the text or that
    /// overlaps the one before is dropped rather than drawn on the wrong words.
    pub fn take_tokens(&mut self, revision: u64, encoding: SpanEncoding, spans: &[TokenSpan]) {
        let md = self.md.get_mut();
        let text = md.session().accepted_text();
        let coords = md.session().coords();
        let unit = unit_of(encoding);
        let scalar_at = |at: u64| -> Option<usize> {
            let at = usize::try_from(at).ok()?;
            let scalar = coords.to_scalar(at, unit, Snap::Backward)?;
            (coords.from_scalar(scalar, unit) == Some(at)).then_some(scalar)
        };
        let mut out = Vec::with_capacity(spans.len());
        let mut last = 0;
        for s in spans {
            if let (Some(start), Some(end)) = (scalar_at(s.start), scalar_at(s.end))
                && start >= last
                && start < end
            {
                out.push((start, end, s.class.clone()));
                last = end;
            }
        }
        self.tokens = Some(Tokens {
            revision,
            text,
            spans: out,
            shown: Vec::new(),
            shown_for: None,
        });
    }

    /// Take waiting spans whose revision has arrived and lay the colour out
    /// for the text as it is now.
    pub fn refresh_tokens(&mut self) {
        let accepted = self.md.get_mut().revision();
        if let Some(w) = self.waiting.take() {
            let pending = self.md.get_mut().session().has_pending();
            if w.revision == accepted && !pending {
                self.take_tokens(w.revision, w.encoding, &w.spans);
            } else if w.revision >= accepted {
                self.waiting = Some(w);
            }
        }
        let md = self.md.get_mut();
        let pending = md.session().has_pending();
        let Some(t) = &mut self.tokens else { return };
        let text = md.session().text();
        let key = (accepted, pending, text);
        if t.shown_for.as_ref() == Some(&key) {
            return;
        }
        t.shown = if t.revision == accepted && !pending && key.2 == t.text {
            t.spans.clone()
        } else {
            carry(&t.text, &key.2, &t.spans)
        };
        t.shown_for = Some(key);
    }

    /// The colour to draw. Colour laid out for other text is not drawn.
    pub fn token_marks(&self, styles: &EditorStyles) -> Vec<Mark> {
        let Some(t) = &self.tokens else {
            return Vec::new();
        };
        let md = self.md.borrow();
        let now = (
            md.revision(),
            md.session().has_pending(),
            md.session().text(),
        );
        if t.shown_for.as_ref() != Some(&now) {
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
}
