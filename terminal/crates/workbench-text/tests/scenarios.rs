//! Scripted scenarios for the editing session, headless.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use theorem_workbench_text::{
    AtomicError, Deletion, EditError, EditSession, EditorStyles, Motion, Newlines, PasteOptions,
    PendingState, RenderOptions, Resolution, ScalarChange, SessionConfig, SyncError, TextChange,
    ViewSnapshot, render,
};

fn session(text: &str) -> EditSession {
    EditSession::new(text, 10, SessionConfig::new("me"))
}

fn ok(s: &EditSession) {
    assert_eq!(s.invariant_violation(), None);
}

fn type_str(s: &mut EditSession, text: &str) {
    for ch in text.chars() {
        s.insert_text(&ch.to_string()).unwrap();
    }
}

fn end(s: &mut EditSession) {
    s.move_cursor(Motion::DocEnd, false);
}

// ---- owner exchange ----

#[test]
fn type_send_remote_lands_before_the_ack() {
    let mut s = session("hello");
    end(&mut s);
    let edit = s.insert_text(" world").unwrap().unwrap();
    assert_eq!(edit.base_revision, 10);
    assert_eq!(edit.changes, vec![TextChange::new(5, 5, " world")]);

    // The edit goes out as the one in flight.
    let sent = s.take_next_to_send().unwrap();
    assert_eq!(sent.op_id, edit.op_id);
    assert_eq!(sent.changes, edit.changes);
    assert!(
        s.take_next_to_send().is_none(),
        "one edit in flight at a time"
    );

    // Another client wrote at the start first: revision 11.
    let applied = s.apply_remote(&[TextChange::new(0, 0, ">> ")], 11).unwrap();
    assert!(applied.dissolved_atomics.is_empty());
    assert_eq!(s.text(), ">> hello world");
    assert_eq!(s.accepted_text(), ">> hello");
    assert_eq!(
        s.cursor(),
        s.len(),
        "cursor stays after the user's own text"
    );
    let pending = s.pending();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, PendingState::Sent);
    assert_eq!(pending[0].changes, vec![TextChange::new(8, 8, " world")]);
    ok(&s);

    // The owner applied our edit after theirs: revision 12.
    s.acknowledge(&edit.op_id, 12).unwrap();
    assert!(!s.has_pending());
    assert_eq!(s.accepted_revision(), 12);
    assert_eq!(s.accepted_text(), ">> hello world");
    assert_eq!(s.text(), ">> hello world");
    ok(&s);
}

#[test]
fn a_late_ack_does_not_replace_the_newer_draft() {
    let mut s = session("");
    let g7 = s.insert_text("seven").unwrap().unwrap();
    s.take_next_to_send().unwrap();
    // Generation 8 is typed while 7 is in flight.
    s.break_undo_group();
    let g8 = s.insert_text("-eight").unwrap().unwrap();
    assert!(s.take_next_to_send().is_none(), "8 waits for 7");

    s.acknowledge(&g7.op_id, 11).unwrap();
    assert_eq!(s.accepted_text(), "seven");
    assert_eq!(s.text(), "seven-eight");
    assert_eq!(s.pending().len(), 1);
    // A repeat of the old ack, out of order, changes nothing.
    assert_eq!(
        s.acknowledge(&g7.op_id, 11),
        Err(SyncError::UnknownOperation(g7.op_id.clone()))
    );

    let next = s.take_next_to_send().unwrap();
    assert_eq!(next.op_id, g8.op_id);
    assert_eq!(next.base_revision, 11);
    assert_eq!(next.changes, vec![TextChange::new(5, 5, "-eight")]);
    s.acknowledge(&g8.op_id, 12).unwrap();
    assert_eq!(s.accepted_text(), "seven-eight");
    ok(&s);
}

#[test]
fn refusal_keeps_the_text_and_marks_it_conflicting() {
    let mut s = session("abc");
    end(&mut s);
    let edit = s.insert_text("XYZ").unwrap().unwrap();
    s.take_next_to_send().unwrap();
    s.refuse(&edit.op_id, "permission denied").unwrap();

    assert_eq!(s.text(), "abcXYZ", "the typed text is still there");
    assert_eq!(s.accepted_text(), "abc");
    let conflict = s.conflict().unwrap();
    assert_eq!(conflict.reason, "permission denied");
    assert_eq!(conflict.op_ids, vec![edit.op_id.clone()]);
    assert_eq!(conflict.ranges, vec![(3, 6)]);
    assert_eq!(s.pending()[0].state, PendingState::Conflicting);
    assert!(
        s.take_next_to_send().is_none(),
        "held back while in conflict"
    );

    // Typing on is not blocked and joins the held text.
    s.insert_text("!").unwrap();
    assert_eq!(s.text(), "abcXYZ!");
    assert_eq!(s.conflict().unwrap().op_ids.len(), 2);
    assert_eq!(s.conflict().unwrap().ranges, vec![(3, 7)]);
    ok(&s);
}

#[test]
fn conflict_keep_mine_sends_the_held_text_again() {
    let mut s = session("abc");
    end(&mut s);
    let edit = s.insert_text("XYZ").unwrap().unwrap();
    s.take_next_to_send().unwrap();
    s.refuse(&edit.op_id, "stale").unwrap();
    s.insert_text("!").unwrap();
    // The owner moved on meanwhile.
    s.apply_remote(&[TextChange::new(0, 0, "# ")], 11).unwrap();

    assert_eq!(s.resolve_conflict(Resolution::KeepMine).unwrap(), None);
    assert!(!s.has_conflict());
    assert_eq!(s.text(), "# abcXYZ!");
    let resend = s.take_next_to_send().unwrap();
    assert_ne!(resend.op_id, edit.op_id, "a new id for the new attempt");
    assert_eq!(resend.base_revision, 11);
    assert_eq!(resend.changes, vec![TextChange::new(5, 5, "XYZ!")]);
    s.acknowledge(&resend.op_id, 12).unwrap();
    assert_eq!(s.accepted_text(), "# abcXYZ!");
    ok(&s);
}

#[test]
fn conflict_take_theirs_returns_what_it_drops() {
    let mut s = session("abc");
    end(&mut s);
    let edit = s.insert_text("XYZ").unwrap().unwrap();
    s.take_next_to_send().unwrap();
    s.refuse(&edit.op_id, "denied").unwrap();
    let dropped = s.resolve_conflict(Resolution::TakeTheirs).unwrap();
    assert_eq!(dropped.as_deref(), Some("abcXYZ"));
    assert_eq!(s.text(), "abc");
    assert!(!s.has_pending());
    assert!(
        !s.can_undo(),
        "history is rebuilt after the text is replaced"
    );
    ok(&s);
}

#[test]
fn conflict_keep_both_keeps_theirs_and_adds_mine() {
    let mut s = session("The cat sat");
    // Replace "cat" with "dog" locally; the owner refuses.
    s.set_selection(4, 7);
    let edit = s.insert_text("dog").unwrap().unwrap();
    s.take_next_to_send().unwrap();
    s.refuse(&edit.op_id, "stale").unwrap();
    assert_eq!(s.text(), "The dog sat");

    assert_eq!(s.resolve_conflict(Resolution::KeepBoth).unwrap(), None);
    assert_eq!(
        s.text(),
        "The catdog sat",
        "their word stays, mine is added after it"
    );
    let send = s.take_next_to_send().unwrap();
    assert_eq!(send.changes, vec![TextChange::new(7, 7, "dog")]);
    ok(&s);
}

#[test]
fn no_conflict_to_resolve_is_an_error() {
    let mut s = session("a");
    assert_eq!(
        s.resolve_conflict(Resolution::KeepMine),
        Err(SyncError::NoConflict)
    );
}

#[test]
fn revision_gaps_and_stale_revisions_change_nothing() {
    let mut s = session("abc");
    assert_eq!(
        s.apply_remote(&[TextChange::new(0, 0, "x")], 12),
        Err(SyncError::RevisionGap {
            expected: 11,
            got: 12
        })
    );
    assert_eq!(
        s.apply_remote(&[TextChange::new(0, 0, "x")], 10),
        Err(SyncError::StaleRevision {
            accepted: 10,
            got: 10
        })
    );
    assert!(s.apply_remote(&[TextChange::new(0, 99, "x")], 11).is_err());
    assert_eq!(s.text(), "abc");
    assert_eq!(s.accepted_revision(), 10);
    // Wire form in scalars: the emoji is one scalar, two UTF-16 units.
    let mut e = session("a\u{1F600}b");
    e.apply_remote_scalars(&[ScalarChange::new(2, 2, "X")], 11)
        .unwrap();
    assert_eq!(e.text(), "a\u{1F600}Xb");
    assert!(
        e.apply_remote(&[TextChange::new(2, 2, "Y")], 12).is_err(),
        "inside a surrogate pair"
    );
    ok(&e);
}

#[test]
fn requeue_resends_under_the_same_id() {
    let mut s = session("");
    let edit = s.insert_text("a").unwrap().unwrap();
    s.take_next_to_send().unwrap();
    s.requeue(&edit.op_id).unwrap();
    assert_eq!(s.take_next_to_send().unwrap().op_id, edit.op_id);
}

#[test]
fn local_edits_report_utf16_and_scalar_changes() {
    let mut s = session("a\u{1F600}b");
    s.set_selection(2, 3);
    let edit = s.insert_text("XY").unwrap().unwrap();
    assert_eq!(edit.changes, vec![TextChange::new(3, 4, "XY")]);
    assert_eq!(edit.wire, vec![ScalarChange::new(2, 3, "XY")]);
    assert_eq!(s.cursor_utf16(), 5);
}

// ---- undo ----

#[test]
fn typing_groups_into_words_and_undo_steps_back() {
    let mut s = session("");
    type_str(&mut s, "hello world");
    assert_eq!(s.text(), "hello world");
    s.undo().unwrap();
    assert_eq!(s.text(), "hello ", "the last word is one step");
    s.undo().unwrap();
    assert_eq!(s.text(), "hello");
    s.undo().unwrap();
    assert_eq!(s.text(), "");
    assert!(s.undo().unwrap().is_none());
    s.redo().unwrap();
    assert_eq!(s.text(), "hello");
    // A new edit drops the redo history.
    s.insert_text("!").unwrap();
    assert!(!s.can_redo());
    ok(&s);
}

#[test]
fn undo_is_an_edit_for_the_owner() {
    let mut s = session("");
    let typed = s.insert_text("ab").unwrap().unwrap();
    let undone = s.undo().unwrap().unwrap();
    assert_ne!(typed.op_id, undone.op_id);
    assert_eq!(undone.changes, vec![TextChange::new(0, 2, "")]);
    assert_eq!(s.pending().len(), 2);
}

#[test]
fn a_remote_change_is_not_an_undo_step_and_undo_still_applies() {
    let mut s = session("one two");
    end(&mut s);
    type_str(&mut s, "!!!");
    s.apply_remote(&[TextChange::new(0, 0, "ZERO ")], 11)
        .unwrap();
    assert_eq!(s.text(), "ZERO one two!!!");
    s.undo().unwrap();
    assert_eq!(
        s.text(),
        "ZERO one two",
        "undo removed the typing, kept the remote text"
    );
    assert!(!s.can_undo(), "the remote change was never an entry");
    s.redo().unwrap();
    assert_eq!(s.text(), "ZERO one two!!!");
    ok(&s);
}

#[test]
fn undo_survives_a_remote_insert_inside_the_typed_text() {
    let mut s = session("ab");
    end(&mut s);
    type_str(&mut s, "cd");
    s.take_next_to_send().unwrap();
    // The owner applied another client's insert between "a" and "b" first.
    s.apply_remote(&[TextChange::new(1, 1, "XX")], 11).unwrap();
    assert_eq!(s.text(), "aXXbcd");
    s.undo().unwrap();
    assert_eq!(s.text(), "aXXb", "only the typed text is undone");
    ok(&s);
}

#[test]
fn backspace_groups_and_cut_is_one_step() {
    let mut s = session("abcdef");
    end(&mut s);
    for _ in 0..3 {
        s.delete(Deletion::Backward).unwrap();
    }
    assert_eq!(s.text(), "abc");
    s.undo().unwrap();
    assert_eq!(s.text(), "abcdef");
    s.set_selection(1, 3);
    let (text, _) = s.cut().unwrap().unwrap();
    assert_eq!(text, "bc");
    assert_eq!(s.text(), "adef");
    s.undo().unwrap();
    assert_eq!(s.text(), "abcdef");
}

// ---- graphemes ----

#[test]
fn one_backspace_removes_one_cluster() {
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    let text = format!("a{family}e\u{301}\r\nz");
    let mut s = session(&text);
    end(&mut s);
    s.delete(Deletion::Backward).unwrap();
    s.delete(Deletion::Backward).unwrap();
    assert_eq!(
        s.text(),
        format!("a{family}e\u{301}"),
        "z, then the CRLF as one"
    );
    s.delete(Deletion::Backward).unwrap();
    assert_eq!(s.text(), format!("a{family}"), "e and its accent together");
    s.delete(Deletion::Backward).unwrap();
    assert_eq!(s.text(), "a", "the whole ZWJ family");
    ok(&s);
}

#[test]
fn the_cursor_never_rests_inside_a_cluster() {
    let text = "e\u{301}\u{1F468}\u{200D}\u{1F469}x";
    let mut s = session(text);
    let mut seen = vec![s.cursor()];
    while s.move_cursor(Motion::Right, false) {
        seen.push(s.cursor());
    }
    assert_eq!(seen, vec![0, 2, 5, 6]);
    let c = s.coords();
    assert!(seen.iter().all(|&p| c.is_grapheme_boundary(p)));
    while s.move_cursor(Motion::Left, false) {}
    assert_eq!(s.cursor(), 0);
}

#[test]
fn a_remote_combining_mark_at_the_cursor_does_not_strand_it() {
    let mut s = session("abc");
    s.set_selection(1, 1);
    // Insert an accent right after "a": the cursor sits at the old boundary, now inside "a+accent".
    s.apply_remote(&[TextChange::new(1, 1, "\u{301}")], 11)
        .unwrap();
    assert_eq!(s.cursor(), 2);
    ok(&s);
}

#[test]
fn selection_extends_by_keyboard_and_select_all() {
    let mut s = session("hello world");
    s.move_cursor(Motion::WordRight, true);
    assert_eq!(s.selection(), Some((0, 5)));
    s.move_cursor(Motion::Right, true);
    s.move_cursor(Motion::Right, true);
    assert_eq!(s.selected_text().as_deref(), Some("hello w"));
    s.move_cursor(Motion::Left, true);
    assert_eq!(s.selected_text().as_deref(), Some("hello "));
    // Without extending, Left collapses to the start of the selection.
    s.move_cursor(Motion::Left, false);
    assert_eq!((s.cursor(), s.selection()), (0, None));
    s.select_all();
    assert_eq!(s.selection(), Some((0, 11)));
    s.insert_text("x").unwrap();
    assert_eq!(s.text(), "x");
}

#[test]
fn word_and_line_motions_and_deletes() {
    let mut s = session("foo-bar baz\nsecond line");
    s.move_cursor(Motion::WordRight, false);
    assert_eq!(s.cursor(), 3);
    s.move_cursor(Motion::WordRight, false);
    assert_eq!(s.cursor(), 4, "punctuation is its own stop");
    s.move_cursor(Motion::LineEnd, false);
    assert_eq!(s.cursor(), 11);
    s.move_cursor(Motion::WordRight, false);
    assert_eq!(
        s.cursor(),
        12,
        "at a line end the next stop is the next line"
    );
    s.move_cursor(Motion::Down, false);
    s.move_cursor(Motion::LineStart, false);
    assert_eq!(s.cursor(), 12);
    s.delete(Deletion::WordForward).unwrap();
    assert_eq!(s.text(), "foo-bar baz\n line");
    s.delete(Deletion::ToLineEnd).unwrap();
    assert_eq!(s.text(), "foo-bar baz\n");
    s.delete(Deletion::ToLineStart).unwrap();
    assert_eq!(
        s.text(),
        "foo-bar baz",
        "at a line start it joins the line before"
    );
    ok(&s);
}

#[test]
fn vertical_motion_keeps_its_column_through_short_and_wide_lines() {
    let mut s = session("abcdef\n\u{4e2d}\u{6587}\nabcdef");
    s.set_selection(4, 4);
    s.move_cursor(Motion::Down, false);
    assert_eq!(s.cursor(), 7 + 2, "cell 4 is after both wide characters");
    s.move_cursor(Motion::Down, false);
    assert_eq!(s.cursor(), 10 + 4, "the remembered column comes back");
    s.move_cursor(Motion::Up, false);
    s.move_cursor(Motion::Up, false);
    assert_eq!(s.cursor(), 4);
}

#[test]
fn soft_wrap_moves_by_visual_rows() {
    let mut s = session("aaaa bbbb cccc");
    s.set_viewport(5, 10);
    s.move_cursor(Motion::Down, false);
    assert_eq!(s.cursor(), 5, "second row starts after the first space");
    s.move_cursor(Motion::Down, false);
    assert_eq!(s.cursor(), 10);
    s.move_cursor(Motion::Up, false);
    assert_eq!(s.cursor(), 5);
}

// ---- atomic ranges ----

#[test]
fn atomic_ranges_are_skipped_and_deleted_as_one() {
    let mut s = session("hi @alice there");
    let id = s.mark_atomic(3, 9).unwrap();
    s.set_selection(3, 3);
    s.move_cursor(Motion::Right, false);
    assert_eq!(s.cursor(), 9, "one Right crosses the whole chip");
    s.move_cursor(Motion::Left, false);
    assert_eq!(s.cursor(), 3);
    s.set_selection(9, 9);
    s.delete(Deletion::Backward).unwrap();
    assert_eq!(s.text(), "hi  there", "one Backspace removes the chip");
    assert!(s.atomics().is_empty());
    s.undo().unwrap();
    assert_eq!(s.text(), "hi @alice there", "undo brings the text back");
    assert_eq!(
        s.atomics()
            .iter()
            .map(|a| (a.id, a.start, a.end))
            .collect::<Vec<_>>(),
        vec![(id, 3, 9)],
        "undo restores the mark with its id"
    );
    s.redo().unwrap();
    assert_eq!(s.text(), "hi  there");
    assert!(s.atomics().is_empty(), "redo deletes it again");
    s.undo().unwrap();
    assert_eq!(s.atomics()[0].id, id);
    ok(&s);
}

#[test]
fn a_selection_that_clips_an_atomic_range_covers_it() {
    let mut s = session("hi @alice there");
    s.mark_atomic(3, 9).unwrap();
    s.set_selection(1, 5);
    assert_eq!(s.selection(), Some((1, 9)));
    s.set_selection(5, 12);
    assert_eq!(s.selection(), Some((3, 12)));
    ok(&s);
}

#[test]
fn atomic_ranges_move_under_local_and_remote_edits() {
    let mut s = session("hi @alice there");
    let id = s.mark_atomic(3, 9).unwrap();
    s.set_selection(0, 0);
    s.insert_text(">> ").unwrap();
    assert_eq!((s.atomics()[0].start, s.atomics()[0].end), (6, 12));
    s.apply_remote(&[TextChange::new(0, 0, "R")], 11).unwrap();
    assert_eq!((s.atomics()[0].start, s.atomics()[0].end), (7, 13));
    // Text typed right after the chip is outside it.
    s.set_selection(13, 13);
    s.insert_text("!").unwrap();
    assert_eq!((s.atomics()[0].start, s.atomics()[0].end), (7, 13));
    // A remote edit inside the chip dissolves it and says so.
    let applied = s.apply_remote(&[TextChange::new(9, 9, "Q")], 12).unwrap();
    assert_eq!(applied.dissolved_atomics, vec![id]);
    assert!(s.atomics().is_empty());
    ok(&s);
}

#[test]
fn atomic_marks_reject_overlap_and_bad_ranges() {
    let mut s = session("abcdef");
    s.mark_atomic(1, 3).unwrap();
    assert_eq!(s.mark_atomic(2, 4), Err(AtomicError::Overlaps));
    assert_eq!(s.mark_atomic(3, 3), Err(AtomicError::BadRange));
    assert_eq!(s.mark_atomic(2, 99), Err(AtomicError::BadRange));
    assert!(s.mark_atomic(3, 5).is_ok(), "touching is not overlapping");
}

// ---- IME ----

#[test]
fn composition_is_not_in_the_text_or_in_undo_until_it_ends() {
    let mut s = session("ab");
    end(&mut s);
    s.composition_start().unwrap();
    s.composition_update("n");
    s.composition_update("ni");
    assert_eq!(s.text(), "ab", "the preedit is not in the document");
    assert!(!s.has_pending());
    assert!(!s.can_undo());
    let d = s.display();
    assert_eq!(d.rope.to_string(), "abni");
    assert_eq!(d.preedit, Some((2, 4)));
    assert_eq!(d.caret, 4);
    assert_eq!(s.insert_text("x"), Err(EditError::Composing));

    let edit = s.composition_end("\u{4f60}").unwrap().unwrap();
    assert_eq!(s.text(), "ab\u{4f60}");
    assert_eq!(edit.changes, vec![TextChange::new(2, 2, "\u{4f60}")]);
    assert!(s.can_undo());
    assert_eq!(s.cursor(), 3);
    ok(&s);
}

#[test]
fn composition_survives_a_remote_change() {
    let mut s = session("ab");
    end(&mut s);
    s.composition_start().unwrap();
    s.composition_update("ni");
    // A remote insert before the composition point.
    s.apply_remote(&[TextChange::new(0, 0, ">>")], 11).unwrap();
    assert!(s.is_composing());
    assert_eq!(s.text(), ">>ab");
    let d = s.display();
    assert_eq!(d.rope.to_string(), ">>abni");
    assert_eq!(d.preedit, Some((4, 6)));
    // And a remote insert exactly at the composition point lands before it.
    s.apply_remote(&[TextChange::new(4, 4, "R")], 12).unwrap();
    assert_eq!(s.display().rope.to_string(), ">>abRni");
    let edit = s.composition_end("\u{4f60}").unwrap().unwrap();
    assert_eq!(s.text(), ">>abR\u{4f60}");
    assert_eq!(edit.changes, vec![TextChange::new(5, 5, "\u{4f60}")]);
    ok(&s);
}

#[test]
fn a_composition_over_a_selection_replaces_it_and_cancel_changes_nothing() {
    let mut s = session("hello");
    s.set_selection(1, 4);
    s.composition_start().unwrap();
    s.composition_update("a");
    assert_eq!(s.display().rope.to_string(), "hao");
    s.composition_end("").unwrap();
    assert_eq!(s.text(), "hello", "an empty commit is a cancel");
    assert!(!s.is_composing());
    s.set_selection(1, 4);
    s.composition_start().unwrap();
    s.composition_end("ELL").unwrap();
    assert_eq!(s.text(), "hELLo");
}

#[test]
fn remote_deleting_the_composition_anchor_keeps_the_preedit() {
    let mut s = session("abcdef");
    s.set_selection(2, 2);
    s.composition_start().unwrap();
    s.composition_update("zz");
    s.apply_remote(&[TextChange::new(1, 5, "")], 11).unwrap();
    assert_eq!(s.text(), "af");
    assert_eq!(s.display().rope.to_string(), "azzf");
    s.composition_end("ok").unwrap();
    assert_eq!(s.text(), "aokf");
    ok(&s);
}

// ---- paste, modes, snapshot ----

#[test]
fn paste_is_bounded_and_normalizes_only_what_it_is_asked() {
    let mut s = session("");
    let opts = PasteOptions {
        max_bytes: 10,
        newlines: Newlines::Keep,
    };
    assert_eq!(
        s.paste("0123456789ab", &opts),
        Err(EditError::TooLarge {
            bytes: 12,
            limit: 10
        })
    );
    assert_eq!(s.text(), "");
    s.paste("a\r\nb\rc", &opts).unwrap();
    assert_eq!(s.text(), "a\r\nb\rc", "kept as given");
    let mut lf = session("x\ny\n");
    lf.paste(
        "a\r\nb\rc",
        &PasteOptions {
            max_bytes: 100,
            newlines: Newlines::ToDocument,
        },
    )
    .unwrap();
    assert_eq!(lf.text(), "a\nb\ncx\ny\n");
    let mut crlf = session("x\r\ny\r\n");
    assert_eq!(crlf.line_ending(), "\r\n");
    crlf.paste(
        "a\nb",
        &PasteOptions {
            max_bytes: 100,
            newlines: Newlines::ToDocument,
        },
    )
    .unwrap();
    assert_eq!(crlf.text(), "a\r\nbx\r\ny\r\n");
    crlf.insert_newline().unwrap();
    assert!(crlf.text().starts_with("a\r\nb\r\n"));
    let mut one = EditSession::new(
        "",
        0,
        SessionConfig {
            single_line: true,
            ..SessionConfig::new("c")
        },
    );
    one.paste(
        "a\nb",
        &PasteOptions {
            max_bytes: 100,
            newlines: Newlines::ToSpace,
        },
    )
    .unwrap();
    assert_eq!(one.text(), "a b");
}

#[test]
fn single_line_and_read_only_modes() {
    let mut one = EditSession::new(
        "ab",
        0,
        SessionConfig {
            single_line: true,
            ..SessionConfig::new("c")
        },
    );
    assert_eq!(one.insert_newline(), Err(EditError::SingleLine));
    assert_eq!(one.insert_text("x\ny"), Err(EditError::SingleLine));
    one.move_cursor(Motion::Down, false);
    assert_eq!(one.cursor(), 2);
    one.move_cursor(Motion::Up, false);
    assert_eq!(one.cursor(), 0);

    let mut ro = EditSession::new(
        "ab",
        0,
        SessionConfig {
            read_only: true,
            ..SessionConfig::new("c")
        },
    );
    assert_eq!(ro.insert_text("x"), Err(EditError::ReadOnly));
    assert_eq!(ro.delete(Deletion::Forward), Err(EditError::ReadOnly));
    assert_eq!(ro.undo(), Err(EditError::ReadOnly));
    assert_eq!(ro.composition_start(), Err(EditError::ReadOnly));
    // Selection and the owner's changes still work.
    ro.select_all();
    assert_eq!(ro.selected_text().as_deref(), Some("ab"));
    ro.apply_remote(&[TextChange::new(2, 2, "c")], 1).unwrap();
    assert_eq!(ro.text(), "abc");
}

#[test]
fn view_state_snapshots_apart_from_text() {
    let mut s = session("one\ntwo\nthree");
    s.set_selection(2, 9);
    s.set_scroll(theorem_workbench_text::Scroll {
        top_line: 1,
        top_row: 0,
        left_cell: 3,
    });
    let snap = s.view_snapshot();
    let json = serde_json::to_string(&snap).unwrap();
    let back: ViewSnapshot = serde_json::from_str(&json).unwrap();
    assert_eq!(back, snap);

    // Restore onto a shorter text: positions clamp and stay on boundaries.
    let mut t = session("ab");
    t.restore_view(&back);
    assert_eq!(t.selection(), Some((2, 2)).filter(|(a, b)| a != b));
    assert!(t.cursor() <= 2);
    assert_eq!(t.scroll().top_line, 1);
    ok(&t);
    let mut u = session("one\ntwo\nthree");
    u.restore_view(&back);
    assert_eq!(u.selection(), Some((2, 9)));
}

// ---- rendering ----

fn row_text(buf: &Buffer, area: Rect, y: u16) -> String {
    (area.x..area.x + area.width)
        .map(|x| buf[(x, y)].symbol())
        .collect::<String>()
        .trim_end()
        .to_string()
}

#[test]
fn render_wraps_reports_the_caret_and_styles_the_selection() {
    let mut s = session("hello world foo");
    let area = Rect::new(2, 1, 8, 4);
    let mut buf = Buffer::empty(Rect::new(0, 0, 12, 6));
    let styles = EditorStyles {
        selection: Style::default().bg(Color::Blue),
        ..EditorStyles::default()
    };
    s.set_selection(0, 5);
    let out = render(
        &mut s,
        area,
        &mut buf,
        &RenderOptions {
            styles,
            line_numbers: false,
        },
    );
    assert_eq!(row_text(&buf, area, 1), "hello");
    assert_eq!(row_text(&buf, area, 2), "world");
    assert_eq!(row_text(&buf, area, 3), "foo");
    assert_eq!(buf[(2, 1)].bg, Color::Blue);
    assert_eq!(buf[(6, 1)].bg, Color::Blue);
    assert_ne!(buf[(7, 1)].bg, Color::Blue);
    // The head of the selection is after "hello".
    let caret = out.caret.unwrap();
    assert_eq!((caret.x, caret.y), (2 + 5, 1));
}

#[test]
fn render_draws_wide_text_tabs_line_numbers_and_the_caret_cell() {
    let mut s = session("a\tb\n\u{4e2d}x");
    let area = Rect::new(0, 0, 12, 3);
    let mut buf = Buffer::empty(area);
    s.set_selection(5, 5);
    let out = render(
        &mut s,
        area,
        &mut buf,
        &RenderOptions {
            line_numbers: true,
            ..Default::default()
        },
    );
    assert_eq!(out.gutter, 2);
    assert_eq!(row_text(&buf, area, 0), "1 a   b");
    assert_eq!(buf[(2, 1)].symbol(), "\u{4e2d}");
    assert_eq!(buf[(4, 1)].symbol(), "x");
    // Caret after the wide character: gutter 2 + 2 cells; the "x" under it is one cell wide.
    let caret = out.caret.unwrap();
    assert_eq!((caret.x, caret.y, caret.width), (4, 1, 1));
    // On the wide character itself the caret is two cells wide.
    s.set_selection(4, 4);
    let out = render(
        &mut s,
        area,
        &mut buf,
        &RenderOptions {
            line_numbers: true,
            ..Default::default()
        },
    );
    assert_eq!((out.caret.unwrap().x, out.caret.unwrap().width), (2, 2));
}

#[test]
fn render_scrolls_to_keep_the_caret_visible() {
    let text: String = (0..20).map(|i| format!("line{i}\n")).collect();
    let mut s = session(&text);
    let area = Rect::new(0, 0, 10, 4);
    let mut buf = Buffer::empty(area);
    let opts = RenderOptions::default();
    render(&mut s, area, &mut buf, &opts);
    assert_eq!(s.scroll().top_line, 0);
    s.set_selection(text.find("line15").unwrap(), text.find("line15").unwrap());
    let out = render(&mut s, area, &mut buf, &opts);
    assert_eq!(s.scroll().top_line, 12);
    assert_eq!(row_text(&buf, area, 3), "line15");
    assert_eq!(out.caret.unwrap().y, 3);
    // Up again: scroll follows only when the caret leaves the top.
    s.set_selection(text.find("line12").unwrap(), text.find("line12").unwrap());
    render(&mut s, area, &mut buf, &opts);
    assert_eq!(s.scroll().top_line, 12);
    s.set_selection(0, 0);
    render(&mut s, area, &mut buf, &opts);
    assert_eq!(s.scroll().top_line, 0);
}

#[test]
fn render_scrolls_sideways_without_wrap_and_styles_preedit_and_atomics() {
    let mut s = EditSession::new(
        "0123456789abcdef",
        0,
        SessionConfig {
            wrap: false,
            ..SessionConfig::new("c")
        },
    );
    let area = Rect::new(0, 0, 6, 1);
    let mut buf = Buffer::empty(area);
    s.set_selection(16, 16);
    let out = render(&mut s, area, &mut buf, &RenderOptions::default());
    assert_eq!(row_text(&buf, area, 0), "bcdef");
    assert_eq!(out.caret.unwrap().x, 5);

    let mut c = session("hi @bob");
    c.mark_atomic(3, 7).unwrap();
    c.set_selection(2, 2);
    c.composition_start().unwrap();
    c.composition_update("ni");
    let area = Rect::new(0, 0, 12, 1);
    let mut buf = Buffer::empty(area);
    let out = render(&mut c, area, &mut buf, &RenderOptions::default());
    assert_eq!(row_text(&buf, area, 0), "hini @bob");
    assert!(
        buf[(2, 0)].modifier.contains(Modifier::UNDERLINED),
        "preedit is underlined"
    );
    assert!(
        buf[(5, 0)].modifier.contains(Modifier::BOLD),
        "the chip moved right of the preedit"
    );
    assert_eq!(
        out.caret.unwrap().x,
        4,
        "caret is at the end of the preedit"
    );
}

#[test]
fn an_undo_after_owner_changes_restores_the_mark_where_the_text_went() {
    let mut s = session("hi @alice there");
    let id = s.mark_atomic(3, 9).unwrap();
    s.set_selection(9, 9);
    s.delete(Deletion::Backward).unwrap();
    // The owner inserts before the chip's place; the restored chip moves with it.
    s.apply_remote(&[TextChange::new(0, 0, "RR")], 11).unwrap();
    s.undo().unwrap();
    assert_eq!(s.text(), "RRhi @alice there");
    assert_eq!(
        s.atomics()
            .iter()
            .map(|a| (a.id, a.start, a.end))
            .collect::<Vec<_>>(),
        vec![(id, 5, 11)]
    );
    ok(&s);
}

#[test]
fn an_owner_insert_where_the_chip_was_does_not_end_up_inside_the_restored_chip() {
    let mut s = session("hi @alice there");
    let id = s.mark_atomic(3, 9).unwrap();
    s.set_selection(9, 9);
    s.delete(Deletion::Backward).unwrap();
    s.apply_remote(&[TextChange::new(3, 3, "Q")], 11).unwrap();
    s.undo().unwrap();
    let a = s.atomics()[0];
    assert_eq!(a.id, id);
    assert_eq!(
        s.text()
            .chars()
            .skip(a.start)
            .take(a.end - a.start)
            .collect::<String>(),
        "@alice"
    );
    ok(&s);
}

#[test]
fn an_undo_that_edits_inside_a_live_range_dissolves_it_and_restores_the_old_one() {
    let mut s = session("ab @cd ef");
    let id = s.mark_atomic(3, 6).unwrap();
    s.set_selection(6, 6);
    s.delete(Deletion::Backward).unwrap();
    let other = s.mark_atomic(2, 4).unwrap();
    s.undo().unwrap();
    let ids: Vec<_> = s.atomics().iter().map(|a| a.id).collect();
    assert_eq!(
        ids,
        vec![id],
        "{ids:?} (live {other:?} was cut by the undo)"
    );
    ok(&s);
}

// ---- edits kept elsewhere ----

#[test]
fn changes_kept_elsewhere_apply_as_one_pending_edit_and_start_the_history_over() {
    let mut s = session("a\u{1f600}bc");
    // UTF-16: the emoji is two units, so "b" is at 3..4.
    let edit = s
        .apply_changes(&[TextChange {
            start: 3,
            end: 4,
            insert: "XY".into(),
        }])
        .unwrap()
        .expect("an edit");
    assert_eq!(s.text(), "a\u{1f600}XYc");
    assert_eq!(s.pending().len(), 1);
    assert_eq!(s.pending()[0].op_id, edit.op_id);
    s.clear_history();
    assert!(!s.can_undo());
    ok(&s);
}

#[test]
fn changes_that_do_not_fit_the_text_change_nothing() {
    let mut s = session("abc");
    let err = s.apply_changes(&[TextChange {
        start: 2,
        end: 9,
        insert: "x".into(),
    }]);
    assert!(matches!(err, Err(SyncError::BadChange(_))), "{err:?}");
    assert_eq!(s.text(), "abc");
    assert!(!s.has_pending());
    // A split scalar is refused too, not snapped.
    let mut s = session("a\u{1f600}");
    assert!(
        s.apply_changes(&[TextChange {
            start: 2,
            end: 2,
            insert: "x".into(),
        }])
        .is_err()
    );
    assert_eq!(s.apply_changes(&[]).unwrap(), None);
    ok(&s);
}

#[test]
fn a_selection_end_pushed_out_of_an_atomic_range_stays_on_a_cluster_boundary() {
    // The range ends after the CR; a line feed typed there joins it into one CRLF cluster,
    // so the range's own end is no longer a place the selection can stand.
    let mut s = session("\u{200b}\u{200b}\u{200b}a\r");
    s.mark_atomic(1, 5).unwrap();
    end(&mut s);
    s.insert_text("\n").unwrap();
    assert_eq!(s.text(), "\u{200b}\u{200b}\u{200b}a\r\n");
    s.set_selection(0, 2);
    ok(&s);
    assert_eq!(s.selection(), Some((0, 6)));
    s.set_selection(2, 0);
    ok(&s);
    assert_eq!(s.selection(), Some((0, 6)));
}
