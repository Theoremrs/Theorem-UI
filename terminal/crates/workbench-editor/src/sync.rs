//! Bringing the owner's text into a session without losing what the person
//! typed: the one operation `EditSession` has no method for.
//!
//! The session takes the owner's changes one revision at a time
//! ([`EditSession::apply_remote`]). A full text at a later revision (the owner's
//! `documentResync`, a conflict's current text, a reconcile) is the sum of
//! revisions this panel never saw, so it is applied as the difference between
//! the accepted text and the new one, at the new revision, after the revisions
//! in between are stepped over as empty changes. The session then transforms
//! its pending edits and its undo history past that difference, the same way
//! it does for any remote change.
//!
//! An `EditSession::resync(text, revision)` in `workbench-text` would do this
//! in one step and without the stepping; see the report of this crate.

use theorem_workbench_core::effect::CoordinateUnit;
use theorem_workbench_text::{
    ChangeError, EditSession, Revision, ScalarChange, SyncError, TextChange,
};

/// The most revisions one resync steps over. A gap larger than this is a
/// different document, not a catch-up.
const LARGEST_GAP: u64 = 1_000_000;

/// What a resync changed in the accepted text: the characters the owner's text
/// no longer has, and the ones it has instead.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Changed {
    pub removed: String,
    pub inserted: String,
}

impl std::fmt::Debug for Changed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Changed")
            .field("removed", &crate::owner::Withheld(self.removed.len()))
            .field("inserted", &crate::owner::Withheld(self.inserted.len()))
            .finish()
    }
}

/// Make `text` at `revision` the session's accepted text. Pending edits and
/// the undo history are carried over it; the cursor stays on the same
/// characters where it can.
///
/// The same revision with the same text is a no-op. The same revision with
/// different text, or an older revision, is refused: revisions only go up, so
/// there is nothing to put the text at.
pub fn resync(
    session: &mut EditSession,
    text: &str,
    revision: Revision,
) -> Result<Changed, SyncError> {
    let accepted = session.accepted_revision();
    let old = session.accepted_text();
    if revision < accepted || (revision == accepted && old != text) {
        return Err(SyncError::StaleRevision {
            accepted,
            got: revision,
        });
    }
    if revision == accepted {
        return Ok(Changed::default());
    }
    if revision - accepted > LARGEST_GAP {
        return Err(SyncError::RevisionGap {
            expected: accepted + 1,
            got: revision,
        });
    }
    let (change, changed) = difference(&old, text);
    step_before(session, revision)?;
    match change {
        Some(change) => session.apply_remote(&[change], revision)?,
        None => session.apply_remote(&[], revision)?,
    };
    Ok(changed)
}

/// Step over the revisions between the accepted one and `revision` as empty
/// changes, so a change (or an acknowledgement) at `revision` is the next one
/// the session expects. What the skipped revisions changed is not known here;
/// the caller either follows with the difference ([`resync`]) or holds its
/// edits until the owner's full text arrives.
pub fn step_before(session: &mut EditSession, revision: Revision) -> Result<(), SyncError> {
    for step in session.accepted_revision() + 1..revision {
        session.apply_remote(&[], step)?;
    }
    Ok(())
}

/// The one replacement that turns `old` into `new`, in UTF-16 units against
/// `old`: everything outside the common prefix and suffix.
fn difference(old: &str, new: &str) -> (Option<TextChange>, Changed) {
    if old == new {
        return (None, Changed::default());
    }
    let prefix = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let old_chars: Vec<char> = old.chars().collect();
    let new_chars: Vec<char> = new.chars().collect();
    let room = old_chars.len().min(new_chars.len()) - prefix;
    let suffix = old_chars
        .iter()
        .rev()
        .zip(new_chars.iter().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    let removed: String = old_chars[prefix..old_chars.len() - suffix].iter().collect();
    let inserted: String = new_chars[prefix..new_chars.len() - suffix].iter().collect();
    let start: usize = old_chars[..prefix].iter().map(|c| c.len_utf16()).sum();
    let end = start + removed.encode_utf16().count();
    let change = TextChange {
        start,
        end,
        insert: inserted.clone(),
    };
    (Some(change), Changed { removed, inserted })
}

/// Apply the owner's change, counted in `unit`, at `revision`. The text
/// session counts UTF-16 and scalars itself; byte offsets are converted
/// against the accepted text first.
pub fn apply_owner_change(
    session: &mut EditSession,
    unit: CoordinateUnit,
    edits: &[theorem_workbench_core::effect::TextChange],
    revision: Revision,
) -> Result<(), SyncError> {
    match unit {
        CoordinateUnit::Utf16 => {
            let changes: Vec<TextChange> = edits.iter().map(utf16).collect();
            session.apply_remote(&changes, revision)?;
        }
        CoordinateUnit::Scalar => {
            let changes: Vec<ScalarChange> = edits
                .iter()
                .map(|c| ScalarChange {
                    start: c.start as usize,
                    end: c.end as usize,
                    insert: c.insert.clone(),
                })
                .collect();
            session.apply_remote_scalars(&changes, revision)?;
        }
        CoordinateUnit::Utf8Bytes => {
            let text = session.accepted_text();
            let convert = |at: u32| {
                text.get(..at as usize)
                    .map(|head| head.encode_utf16().count())
            };
            let mut changes = Vec::with_capacity(edits.len());
            for (index, c) in edits.iter().enumerate() {
                let (Some(start), Some(end)) = (convert(c.start), convert(c.end)) else {
                    return Err(SyncError::BadChange(ChangeError::SplitScalar { index }));
                };
                changes.push(TextChange {
                    start,
                    end,
                    insert: c.insert.clone(),
                });
            }
            session.apply_remote(&changes, revision)?;
        }
    }
    Ok(())
}

fn utf16(c: &theorem_workbench_core::effect::TextChange) -> TextChange {
    TextChange {
        start: c.start as usize,
        end: c.end as usize,
        insert: c.insert.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use theorem_workbench_text::SessionConfig;

    fn session(text: &str, revision: Revision) -> EditSession {
        EditSession::new(text, revision, SessionConfig::new("t"))
    }

    #[test]
    fn the_difference_is_in_utf16_units_and_leaves_the_common_ends_alone() {
        let (change, changed) = difference("a\u{1f600}bcd", "a\u{1f600}XYd");
        let change = change.unwrap();
        assert_eq!((change.start, change.end), (3, 5));
        assert_eq!(change.insert, "XY");
        assert_eq!(changed.removed, "bc");
        assert_eq!(difference("same", "same").0, None);
        // Nothing in common at the ends, and one text a prefix of the other.
        assert_eq!(difference("abc", "abcdef").0.unwrap().start, 3);
        assert_eq!(difference("abcdef", "abc").0.unwrap().end, 6);
    }

    #[test]
    fn a_resync_across_a_gap_lands_at_the_new_revision_under_pending_edits() {
        let mut s = session("hello world", 4);
        s.set_selection(11, 11);
        s.insert_text("!").unwrap();
        resync(&mut s, "hello brave world", 9).unwrap();
        assert_eq!(s.accepted_revision(), 9);
        assert_eq!(s.accepted_text(), "hello brave world");
        assert_eq!(s.text(), "hello brave world!");
        assert!(s.has_pending());
        assert!(s.invariant_violation().is_none());
    }

    #[test]
    fn an_older_revision_or_a_different_text_at_the_same_revision_is_refused() {
        let mut s = session("abc", 5);
        assert!(resync(&mut s, "abc", 5).is_ok());
        assert!(matches!(
            resync(&mut s, "abd", 5),
            Err(SyncError::StaleRevision { .. })
        ));
        assert!(matches!(
            resync(&mut s, "abc", 4),
            Err(SyncError::StaleRevision { .. })
        ));
    }
}
