//! What every panel over a document says and decides when the document's
//! edits are only on this device, when edits were recovered from it, and when
//! access to the file is gone. The words, the choices, the refusals and the
//! placing of recovered edits live here once so that the source editor and
//! the Markdown panel cannot drift: a person who meets a recovered draft in
//! one must not have to learn it again in the other.

use unicode_width::UnicodeWidthChar;

use crate::{EditSession, OpId, Snap, TextChange, Unit};

/// The headline of a panel that lost access to its file. The owner's reason
/// follows it as the owner said it.
pub const REVOKED: &str = "You no longer have access to this file";

/// The semantic node ids both panels give the local state and the recovered
/// bar.
pub const LOCAL_NODE: &str = "local";
pub const BAR_NODE: &str = "strip";

/// The status line's flag while recovered edits wait: long and short form.
pub const WAITS_FLAG: (&str, &str) = ("recovered edits wait", "recovered");

/// The chords for keeping and discarding recovered edits, in both panels.
pub const KEEP_CHORD: &str = "Alt+J";
pub const DISCARD_CHORD: &str = "Alt+G";

// ---- local state --------------------------------------------------------

/// How far the edits are from being safe, as the host said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kept {
    /// The owner has them.
    Accepted,
    /// Held in this page only.
    Draft,
    /// Written to this device's checkpoint, not to the file.
    Checkpointed,
}

/// The status line's flag for the local state: the long form, the short form
/// a narrow line falls back to, and whether it asks for attention.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalFlag {
    pub long: String,
    pub short: &'static str,
    pub attention: bool,
}

/// Only what is known: a failed keep says the edits are in this page alone,
/// and "kept" is said only when the host says so. Nothing for edits the owner
/// has.
pub fn local_flag(kept: Kept, problem: Option<&str>) -> Option<LocalFlag> {
    match (problem, kept) {
        (Some(reason), _) => Some(LocalFlag {
            long: format!("not kept: {reason}; only in this page"),
            short: "not kept",
            attention: true,
        }),
        (None, Kept::Accepted) => None,
        (None, Kept::Draft) => Some(LocalFlag {
            long: "edits not yet kept on this device".to_owned(),
            short: "not kept yet",
            attention: false,
        }),
        (None, Kept::Checkpointed) => Some(LocalFlag {
            long: "kept on this device, not saved to the file".to_owned(),
            short: "kept, unsaved",
            attention: false,
        }),
    }
}

/// The notice row that keeps a failed keep's whole reason on screen when the
/// flag had to say less.
pub fn local_notice(reason: &str) -> String {
    format!("Not kept on this device: {reason}. The edits are only in this page.")
}

/// The local state for the semantic tree.
pub fn local_description(kept: Kept, problem: Option<(&str, &str)>) -> Option<String> {
    match (problem, kept) {
        (Some((code, reason)), _) => Some(format!(
            "not kept on this device ({code}): {reason}; the edits are only in this page"
        )),
        (None, Kept::Accepted) => None,
        (None, Kept::Draft) => Some("edits not yet kept on this device".to_owned()),
        (None, Kept::Checkpointed) => {
            Some("edits kept on this device, not saved to the file".to_owned())
        }
    }
}

// ---- recovered edits ----------------------------------------------------

/// What the bar over recovered edits says. `from` is what the edits were made
/// against when that is not the text on screen, and the edits are then not
/// placed.
#[derive(Clone, Copy, Debug)]
pub struct Bar<'a> {
    pub from: Option<&'a str>,
    /// The revision the file is at.
    pub current: u64,
    /// The owner's note on the edits, when it sent one.
    pub reason: Option<&'a str>,
    /// What the edits insert.
    pub text: &'a str,
}

/// One line of a snippet of text: line breaks shown, long text cut at `max`
/// cells.
pub fn snip(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in text.chars() {
        let c = if c == '\n' || c == '\r' { '\u{b6}' } else { c };
        let w = c.width().unwrap_or(0);
        if n + w > max {
            out.push('\u{2026}');
            break;
        }
        out.push(c);
        n += w;
    }
    out
}

impl Bar<'_> {
    pub fn placed(&self) -> bool {
        self.from.is_none()
    }

    pub fn text(&self) -> String {
        let why = self.reason.map(|w| format!(" {w}")).unwrap_or_default();
        match self.from {
            Some(from) => format!(
                "Edits recovered from this device were made against {from}; the file is at revision {}, so they are not placed.{why} Recovered: \"{}\"",
                self.current,
                snip(self.text, 24)
            ),
            None => format!(
                "Edits recovered from this device are in the text. Nothing is sent until you choose.{why}"
            ),
        }
    }

    /// The bar for the semantic tree's description of the document.
    pub fn description(&self) -> String {
        match self.from {
            Some(from) => format!(
                "edits recovered from this device were made against {from} and are not placed; choose what to do with them"
            ),
            None => {
                "edits recovered from this device are in the text and wait for a choice".to_owned()
            }
        }
    }
}

/// What the bar offers. A panel maps each to its own action; the ids differ
/// per panel and the titles and the decisions do not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offer {
    Keep,
    Discard,
    Copy,
    TakeTheirs,
    KeepBoth,
    CopyMine,
    KeepMine,
}

pub const KEEP_TITLE: &str = "Keep recovered";
pub const DISCARD_TITLE: &str = "Discard recovered";
pub const COPY_TITLE: &str = "Copy";
pub const TAKE_THEIRS_TITLE: &str = "Take their text";
pub const KEEP_BOTH_TITLE: &str = "Keep both";
pub const COPY_MINE_TITLE: &str = "Copy my text";
pub const KEEP_MINE_TITLE: &str = "Keep my text";

impl Offer {
    pub fn title(self) -> &'static str {
        match self {
            Self::Keep => KEEP_TITLE,
            Self::Discard => DISCARD_TITLE,
            Self::Copy => COPY_TITLE,
            Self::TakeTheirs => TAKE_THEIRS_TITLE,
            Self::KeepBoth => KEEP_BOTH_TITLE,
            Self::CopyMine => COPY_MINE_TITLE,
            Self::KeepMine => KEEP_MINE_TITLE,
        }
    }
}

/// The buttons of the bar, in order. A document that takes no edits cannot be
/// kept into, so keep and keep both are not offered.
pub fn offers(placed: bool, read_only: bool) -> Vec<Offer> {
    let mut offers = if placed {
        vec![Offer::Keep, Offer::Discard, Offer::Copy]
    } else {
        vec![Offer::TakeTheirs, Offer::KeepBoth, Offer::CopyMine]
    };
    if read_only {
        offers.retain(|o| !matches!(o, Offer::Keep | Offer::KeepBoth));
    }
    offers
}

/// Why no edits were recovered, for keep or discard asked for anyway.
pub const NOT_RECOVERED: &str = "No edits were recovered from this device.";

/// Why `offer` cannot be chosen. `placed` is `None` when no recovered edits
/// wait, and says whether they are in the text when some do. `None` back means
/// recovery has no objection (the panel's own conditions still apply).
pub fn refusal(offer: Offer, placed: Option<bool>, read_only: Option<&str>) -> Option<String> {
    let read_only = || read_only.map(|r| format!("Read-only: {r}"));
    match (offer, placed) {
        (Offer::Keep | Offer::Discard, None) => Some(NOT_RECOVERED.to_owned()),
        (_, None) => None,
        (Offer::KeepMine, Some(true)) => {
            Some("Edits recovered from this device are waiting: keep or discard them.".to_owned())
        }
        (Offer::KeepMine, Some(false)) => Some(
            "The recovered edits were made against another revision, so their ranges cannot be placed in this text."
                .to_owned(),
        ),
        (Offer::TakeTheirs | Offer::KeepBoth, Some(true)) => {
            Some("Keep or discard the recovered edits.".to_owned())
        }
        (Offer::Keep | Offer::Discard, Some(false)) => Some(
            "They were made against another revision: take theirs, keep both or copy them."
                .to_owned(),
        ),
        (Offer::Keep, Some(true)) | (Offer::KeepBoth, Some(false)) => read_only(),
        _ => None,
    }
}

/// What the person wrote, as they wrote it, from recovered edits that are not
/// placed.
///
/// `sets` are the restored entries in order, each over the text the one before
/// left, in the coordinates of a base text this crate does not have: a
/// `Restored` carries the ranges and the inserts but not the text they were
/// made against. Replaying them over an empty scratch text would therefore
/// fail for any edit made past the start of a longer base, so the entries are
/// replayed as runs instead, which gives the same text a scratch replay would
/// wherever one is possible. An insert that starts inside the current run
/// (at its end, or in its middle) goes into it, a delete inside the run takes
/// the characters out, and anything else ends the run: a new run starts after
/// a line break. A deletion elsewhere inserts nothing but still ends the run,
/// because it moves the position.
pub fn recovered_text(sets: &[Vec<TextChange>]) -> String {
    let mut done: Vec<String> = vec![];
    // The current run: where it starts and its UTF-16 units.
    let mut run: Option<(usize, Vec<u16>)> = None;
    let mut finish = |run: &mut Option<(usize, Vec<u16>)>| {
        if let Some((_, units)) = run.take() {
            let text = String::from_utf16_lossy(&units);
            if !text.is_empty() {
                done.push(text);
            }
        }
    };
    for set in sets {
        // The ranges of one entry are against the text before it: each change
        // after the first is moved by what the ones before it did.
        let mut shift: isize = 0;
        for c in set {
            let start = c.start.saturating_add_signed(shift);
            let end = c.end.saturating_add_signed(shift);
            let insert: Vec<u16> = c.insert.encode_utf16().collect();
            shift += insert.len() as isize - (c.end - c.start) as isize;
            if let Some((at, units)) = run.as_mut()
                && start >= *at
                && end <= *at + units.len()
            {
                units.splice(start - *at..end - *at, insert);
                continue;
            }
            finish(&mut run);
            if !insert.is_empty() {
                run = Some((start, insert));
            }
        }
    }
    finish(&mut run);
    done.join("\n")
}

/// What "keep both" inserts at the end of the file's text: the recovered text
/// after it, on its own line.
pub fn after_file_text(file: &str, recovered: &str) -> String {
    let lead = if !file.is_empty() && !file.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    format!("{lead}{recovered}")
}

/// Whether `sets` (one set per recovered edit, in order, each over the text
/// the one before left) fit `text`. Nothing is changed.
pub fn fits(text: &str, sets: &[Vec<TextChange>]) -> Result<(), String> {
    let mut trial = EditSession::new(text, 0, crate::SessionConfig::new("recovery-check"));
    match sets.iter().find_map(|c| trial.apply_changes(c).err()) {
        Some(e) => Err(e.to_string()),
        None => Ok(()),
    }
}

/// Put the recovered edits into the session, in order, and leave the caret at
/// the end of the last change. The undo history starts after them. Returns the
/// first edit's operation, so the caller can hold them. Call [`fits`] first:
/// a set that does not fit is skipped.
pub fn place(session: &mut EditSession, sets: &[Vec<TextChange>]) -> Option<OpId> {
    let mut first = None;
    let mut last: Option<&Vec<TextChange>> = None;
    for set in sets {
        if let Ok(Some(edit)) = session.apply_changes(set) {
            first.get_or_insert(edit.op_id);
            last = Some(set);
        }
    }
    if let Some(set) = last {
        caret_after(session, set);
    }
    session.clear_history();
    first
}

/// The caret goes to the end of the last change of `set`, which has just been
/// applied. Positions in the set are against the text before it.
fn caret_after(session: &mut EditSession, set: &[TextChange]) {
    let Some(last) = set.last() else { return };
    let shift: isize = set[..set.len() - 1]
        .iter()
        .map(|c| c.insert.encode_utf16().count() as isize - (c.end - c.start) as isize)
        .sum();
    let at = last.start as isize + shift + last.insert.encode_utf16().count() as isize;
    let Ok(at) = usize::try_from(at) else { return };
    let scalar = session.coords().to_scalar(at, Unit::Utf16, Snap::Backward);
    if let Some(scalar) = scalar {
        session.set_selection(scalar, scalar);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionConfig;

    fn change(start: usize, end: usize, insert: &str) -> TextChange {
        TextChange {
            start,
            end,
            insert: insert.into(),
        }
    }

    #[test]
    fn the_local_flag_says_only_what_is_known() {
        assert_eq!(local_flag(Kept::Accepted, None), None);
        let draft = local_flag(Kept::Draft, None).unwrap();
        assert_eq!(
            (draft.long.as_str(), draft.short, draft.attention),
            ("edits not yet kept on this device", "not kept yet", false)
        );
        let kept = local_flag(Kept::Checkpointed, None).unwrap();
        assert_eq!(kept.long, "kept on this device, not saved to the file");
        assert_eq!(kept.short, "kept, unsaved");
        let bad = local_flag(Kept::Checkpointed, Some("disk full")).unwrap();
        assert_eq!(bad.long, "not kept: disk full; only in this page");
        assert!(bad.attention);
        assert_eq!(
            local_notice("disk full"),
            "Not kept on this device: disk full. The edits are only in this page."
        );
    }

    #[test]
    fn the_bar_offers_what_can_be_done_with_recovered_edits() {
        assert_eq!(
            offers(true, false),
            [Offer::Keep, Offer::Discard, Offer::Copy]
        );
        assert_eq!(
            offers(false, false),
            [Offer::TakeTheirs, Offer::KeepBoth, Offer::CopyMine]
        );
        assert_eq!(offers(true, true), [Offer::Discard, Offer::Copy]);
        assert_eq!(offers(false, true), [Offer::TakeTheirs, Offer::CopyMine]);
        assert!(
            refusal(Offer::KeepMine, Some(false), None)
                .unwrap()
                .contains("ranges cannot be placed")
        );
        assert_eq!(
            refusal(Offer::Keep, None, None).as_deref(),
            Some(NOT_RECOVERED)
        );
        assert_eq!(refusal(Offer::Keep, Some(true), None), None);
        assert_eq!(
            refusal(Offer::Keep, Some(true), Some("locked")).as_deref(),
            Some("Read-only: locked")
        );
    }

    #[test]
    fn recovered_edits_go_in_order_and_the_caret_ends_after_the_last_change() {
        let sets = vec![
            vec![change(0, 0, "ab"), change(3, 3, "Z")],
            vec![change(0, 1, "")],
        ];
        assert!(fits("hello\n", &sets).is_ok());
        let mut s = EditSession::new("hello\n", 1, SessionConfig::new("t"));
        assert!(place(&mut s, &sets).is_some());
        // "abhelZlo\n", then the first character is removed.
        assert_eq!(s.text(), "bhelZlo\n");
        assert!(fits("hi", &[vec![change(5, 5, "x")]]).is_err());
        assert_eq!(recovered_text(&sets), "ab\nZ");
    }

    #[test]
    fn kept_text_follows_the_files_on_its_own_line() {
        assert_eq!(after_file_text("hello\n", "X"), "X");
        assert_eq!(after_file_text("hello", "X"), "\nX");
        assert_eq!(after_file_text("", "X"), "X");
    }

    fn typed(text: &str) -> Vec<Vec<TextChange>> {
        text.chars()
            .enumerate()
            .map(|(i, c)| vec![change(i, i, &c.to_string())])
            .collect()
    }

    #[test]
    fn characters_typed_one_at_a_time_read_as_the_word() {
        assert_eq!(recovered_text(&typed("zzdraft")), "zzdraft");
    }

    #[test]
    fn separate_runs_are_separate_lines() {
        let mut sets = typed("ab");
        sets.extend([vec![change(9, 9, "c")], vec![change(10, 10, "d")]]);
        assert_eq!(recovered_text(&sets), "ab\ncd");
    }

    #[test]
    fn an_insert_in_the_middle_of_a_run_lands_in_the_middle() {
        let mut sets = typed("abcd");
        sets.push(vec![change(2, 2, "X")]);
        assert_eq!(recovered_text(&sets), "abXcd");
    }

    #[test]
    fn a_backspace_inside_a_run_removes_the_character() {
        let mut sets = typed("abc");
        sets.push(vec![change(2, 3, "")]);
        sets.push(vec![change(2, 2, "d")]);
        assert_eq!(recovered_text(&sets), "abd");
    }

    #[test]
    fn a_deletion_elsewhere_ends_the_run_and_adds_nothing() {
        let mut sets = typed("ab");
        sets.push(vec![change(7, 8, "")]);
        sets.push(vec![change(2, 2, "c")]);
        assert_eq!(recovered_text(&sets), "ab\nc");
    }

    #[test]
    fn pastes_keep_their_own_line_breaks() {
        let sets = vec![
            vec![change(0, 0, "one\ntwo\n")],
            vec![change(8, 8, "three")],
        ];
        assert_eq!(recovered_text(&sets), "one\ntwo\nthree");
    }

    #[test]
    fn units_are_utf16() {
        let sets = vec![vec![change(0, 0, "\u{1f600}")], vec![change(2, 2, "x")]];
        assert_eq!(recovered_text(&sets), "\u{1f600}x");
    }
}
