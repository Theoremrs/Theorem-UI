//! The four document modes and the block that Visual mode holds open.
//!
//! Translated from `crates/ely-documents/src/modes.rs` (blob
//! `2e6bca2e7c297372c7c7374c0d0df313fcb26f86` at ELY-Open-Source/Ely-GPUI-Components
//! `078bf26f2d039b3877aef577e37bbd0a1de182bf`, MIT, see `LICENSE-ELY`). The donor
//! is a GPUI element; this is the same model without a toolkit.
//!
//! Carried: [`MarkdownMode`] and its four names, `shifted`, `joint`, and the
//! shape of the open block (its range, its text, whether it appends).
//!
//! Changed on purpose: the donor's `commit` drops a block's edit when the
//! document differs from the text the block opened on ("the text changed
//! under block, its edit is dropped"), and ignores a press on a block when the
//! document moved. Here a pending block edit is never dropped. The open block
//! keeps its range current as the document changes around it; a change that
//! does not touch what the user typed is merged into the block through the
//! text session's operational transform; a change that does touch it holds the
//! block as a conflict with the user's text kept, until it is resolved.

use std::ops::Range;

use serde::{Deserialize, Serialize};
use theorem_workbench_text::{EditSession, Revision, SessionConfig, TextChange};

/// How a markdown editor shows its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MarkdownMode {
    /// The document as read; the block at the cursor is open as source.
    Visual,
    /// The markdown, styled as it is typed.
    Source,
    /// The source beside the document it makes.
    Split,
    /// The document alone, read only.
    Preview,
}

impl MarkdownMode {
    /// Every mode with its name, in the order the donor's switch lists them.
    pub const ALL: [(Self, &'static str); 4] = [
        (Self::Visual, "Visual"),
        (Self::Source, "Source"),
        (Self::Split, "Split"),
        (Self::Preview, "Preview"),
    ];

    /// The mode's name.
    pub fn name(self) -> &'static str {
        Self::ALL
            .iter()
            .find(|(mode, _)| *mode == self)
            .map(|(_, name)| *name)
            .expect("every mode is named")
    }

    /// The mode named `name`.
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .find(|(_, named)| *named == name)
            .map(|(mode, _)| *mode)
    }

    /// Whether the mode takes edits.
    pub fn editable(self) -> bool {
        self != Self::Preview
    }
}

/// `range` shifted by `written` bytes written over `replaced`.
pub(crate) fn shifted(
    range: Range<usize>,
    replaced: &Range<usize>,
    written: usize,
) -> Range<usize> {
    if range.start < replaced.end {
        return range;
    }
    let (start, end) = (
        range.start - replaced.len() + written,
        range.end - replaced.len() + written,
    );
    start..end
}

/// What joins an appended block to the text before.
pub(crate) fn joint(document: &str) -> &'static str {
    if document.is_empty() || document.ends_with("\n\n") {
        ""
    } else if document.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

/// The bytes that differ between `old` and `new`: what is left of each after
/// their common start and common end are taken off.
pub(crate) fn changed_region(old: &str, new: &str) -> Option<(Range<usize>, Range<usize>)> {
    if old == new {
        return None;
    }
    let mut start = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !(old.is_char_boundary(start) && new.is_char_boundary(start)) {
        start -= 1;
    }
    let room = old.len().min(new.len()) - start;
    let mut end = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    while !(old.is_char_boundary(old.len() - end) && new.is_char_boundary(new.len() - end)) {
        end -= 1;
    }
    Some((start..old.len() - end, start..new.len() - end))
}

/// UTF-16 code units in `text[..byte]`.
pub(crate) fn utf16_at(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}

/// The open block: where it sits in the document, what is typed in it, and
/// whether it is held.
pub(crate) struct OpenBlock {
    /// Its bytes in the document now. Kept current as the document changes.
    /// Unused while `append`, which writes at the end of whatever the document is.
    pub range: Range<usize>,
    /// What the block read when it opened, kept to show the user what moved.
    pub base: String,
    /// The user's text. Its accepted text is the document's text of the block.
    pub session: EditSession,
    /// A block started past the last one: written after the document's end.
    pub append: bool,
    /// The document changed where the user typed: nothing is written until
    /// the user resolves it.
    pub held: bool,
    /// Revision counter of `session`'s owner, which is the document.
    revision: Revision,
}

/// What a change of the document did to the open block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rebased {
    /// The change lay outside the block, or inside it and merged into the text.
    Kept,
    /// The change touched what the user typed; the block is now held.
    Held,
    /// The change removed the block's text and the user had typed nothing.
    Gone,
}

/// The text session a block is typed in.
fn block_session(text: &str) -> EditSession {
    EditSession::new(text, 0, SessionConfig::new("block"))
}

impl OpenBlock {
    /// `source`, the document's text at `range`, open to type in; `at_start`
    /// puts the caret at the block's start, otherwise at its end.
    pub fn new(range: Range<usize>, source: &str, append: bool, at_start: bool) -> Self {
        let mut session = block_session(source);
        let at = if at_start { 0 } else { session.len() };
        session.set_selection(at, at);
        Self {
            range,
            base: source.to_string(),
            session,
            append,
            held: false,
            revision: 0,
        }
    }

    /// A block restored with what was typed in it. `theirs` is the document's
    /// text at `range` now; `held` when that is not what the block opened on.
    pub fn restored(
        range: Range<usize>,
        base: String,
        theirs: &str,
        typed: &str,
        append: bool,
        mut held: bool,
    ) -> Self {
        let mut session = block_session(theirs);
        if typed != theirs {
            match session.replace_all(typed) {
                Ok(_) => {}
                Err(_) => held = true,
            }
        }
        let end = session.len();
        session.set_selection(end, end);
        held |= !append && base != theirs && typed != theirs;
        Self {
            range,
            base,
            session,
            append,
            held,
            revision: 0,
        }
    }

    /// What the user has in the block.
    pub fn typed(&self) -> String {
        self.session.text()
    }

    /// The document's text of the block, as far as the block knows it.
    pub fn theirs(&self) -> String {
        self.session.accepted_text()
    }

    /// Whether the user has typed anything the document does not have.
    pub fn dirty(&self) -> bool {
        self.session.text() != self.session.accepted_text()
    }

    /// The document replaced `[a, b)` of its text with `inserted`. Keep the
    /// block's range current and bring the change into the block's text.
    pub fn rebase(&mut self, a: usize, b: usize, inserted: &str) -> Rebased {
        if self.append {
            return Rebased::Kept;
        }
        let (start, end) = (self.range.start, self.range.end);
        let n = inserted.len();
        let moved = |at: usize| at + n - (b - a);
        // Before the block, or an insertion at its first byte.
        if b <= start {
            self.range = moved(start)..moved(end);
            return Rebased::Kept;
        }
        // After the block, or an insertion at its last byte.
        if a >= end {
            return Rebased::Kept;
        }
        // The change starts inside the block, or reaches into it from before.
        let starts_inside = a >= start;
        let (lo, hi) = (a.max(start), b.min(end));
        let first = if starts_inside { start } else { a + n };
        let last = match (b >= end, starts_inside) {
            (false, _) => moved(end),
            (true, true) => a + n,
            (true, false) => first,
        };
        self.range = first..last;
        // Text that came with a change that began before the block stays outside it.
        let kept = if starts_inside { inserted } else { "" };
        if lo == hi && kept.is_empty() {
            return Rebased::Kept;
        }
        if self.held {
            return Rebased::Kept;
        }
        if !starts_inside && b >= end && !self.dirty() {
            return Rebased::Gone;
        }
        let accepted = self.session.accepted_text();
        let mine = self.session.text();
        let (from, to) = (lo - start, hi - start);
        if let Some((typed, _)) = changed_region(&accepted, &mine)
            && from <= typed.end
            && to >= typed.start
        {
            self.held = true;
            return Rebased::Held;
        }
        let change = TextChange::new(utf16_at(&accepted, from), utf16_at(&accepted, to), kept);
        self.revision += 1;
        if self.session.apply_remote(&[change], self.revision).is_err() {
            self.held = true;
            return Rebased::Held;
        }
        Rebased::Kept
    }

    /// What closing the block writes into `document`.
    pub fn close(&self, document: &str) -> Close {
        if self.held {
            return Close::Held;
        }
        let typed = self.typed();
        if self.append {
            return match typed.is_empty() {
                true => Close::Unchanged,
                false => Close::Write {
                    range: document.len()..document.len(),
                    text: format!("{}{typed}", joint(document)),
                },
            };
        }
        if typed == self.session.accepted_text() {
            return Close::Unchanged;
        }
        Close::Write {
            range: self.range.clone(),
            text: typed,
        }
    }
}

/// What closing the open block comes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Close {
    /// The block is what the document has; nothing to write.
    Unchanged,
    /// Replace `range` of the document with `text`.
    Write { range: Range<usize>, text: String },
    /// The block is held: nothing is written and the block stays open.
    Held,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_blocks_move_by_what_an_edit_wrote() {
        assert_eq!(shifted(10..14, &(2..6), 9), 15..19);
        assert_eq!(
            shifted(0..2, &(2..6), 9),
            0..2,
            "a block before the edit stays"
        );
    }

    #[test]
    fn a_block_at_the_end_starts_a_paragraph() {
        assert_eq!(
            (joint(""), joint("a"), joint("a\n"), joint("a\n\n")),
            ("", "\n\n", "\n", "")
        );
    }

    #[test]
    fn the_four_modes_are_named_and_found_by_name() {
        for (mode, name) in MarkdownMode::ALL {
            assert_eq!(mode.name(), name);
            assert_eq!(MarkdownMode::named(name), Some(mode));
        }
        assert_eq!(MarkdownMode::named("Nope"), None);
        assert!(!MarkdownMode::Preview.editable());
    }

    #[test]
    fn the_changed_region_is_what_lies_between_the_common_ends() {
        assert_eq!(changed_region("abc", "abc"), None);
        assert_eq!(changed_region("one two", "one 2"), Some((4..7, 4..5)));
        // A boundary inside a character moves out to the character's start.
        assert_eq!(changed_region("a\u{e9}", "a\u{e8}"), Some((1..3, 1..3)));
    }
}
