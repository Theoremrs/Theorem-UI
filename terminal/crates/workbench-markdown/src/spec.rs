//! What the requirements ask of the document model, as tests.
//!
//! R10 (AC-11): modes share one session. R11 (AC-12): no dropped block edit.
//! R12 (AC-13): untouched source stays as written. R13 (AC-14, AC-22):
//! coordinates are named. R14 (AC-15, AC-52): input is local, an
//! acknowledgement moves only its own baseline. Drawing and view state at the end.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use theorem_workbench_text::{Snap, TextChange, Unit};

use crate::{
    BlockCommand, BlockResolution, CommitOutcome, InlineFormat, MarkdownDoc, MarkdownMode,
    MarkdownStyles, MarkdownViewState,
};

const DOC: &str = "# Title\n\nalpha beta gamma\n\n- one\n- two\n\nlast block\n";

fn doc(text: &str) -> MarkdownDoc {
    MarkdownDoc::new(text, 1, "me")
}

fn at(text: &str, needle: &str) -> usize {
    text.find(needle).expect("in the text")
}

/// Put the caret at byte `byte` of the document.
fn caret(doc: &mut MarkdownDoc, byte: usize) {
    let scalar = doc
        .session()
        .coords()
        .to_scalar(byte, Unit::Utf8, Snap::Backward)
        .expect("inside the text");
    doc.apply_local(|s| s.set_selection(scalar, scalar));
}

/// A change from the document's owner, replacing bytes `a..b` of the accepted text.
fn peer(doc: &mut MarkdownDoc, a: usize, b: usize, with: &str) {
    let text = doc.session().accepted_text();
    let utf16 = |byte: usize| text[..byte].encode_utf16().count();
    let rev = doc.revision() + 1;
    doc.apply_remote(&[TextChange::new(utf16(a), utf16(b), with)], rev)
        .expect("remote change");
}

fn type_in_block(doc: &mut MarkdownDoc, text: &str) {
    doc.block_session()
        .expect("a block is open")
        .insert_text(text)
        .expect("typed");
}

/// Open "alpha beta gamma" in Visual with " mine" typed at its end.
fn typed_at_the_end() -> MarkdownDoc {
    let mut d = doc(DOC);
    caret(&mut d, at(DOC, "beta"));
    d.set_mode(MarkdownMode::Visual);
    let session = d.block_session().expect("open");
    let end = session.len();
    session.set_selection(end, end);
    type_in_block(&mut d, " mine");
    d
}

fn rows(buf: &Buffer) -> Vec<String> {
    let area = buf.area;
    (area.y..area.y + area.height)
        .map(|y| {
            (area.x..area.x + area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

fn drawn(doc: &mut MarkdownDoc, width: u16, height: u16) -> Vec<String> {
    let area = Rect::new(0, 0, width, height);
    let mut buf = Buffer::empty(area);
    doc.draw(area, &mut buf, &MarkdownStyles::plain());
    rows(&buf)
}

fn has(rows: &[String], needle: &str) -> bool {
    rows.iter().any(|row| row.contains(needle))
}

// ---- R10, AC-11: one session across four modes ----

#[test]
fn modes_keep_the_text_the_selection_the_history_and_the_pending_edit() {
    let mut d = doc(DOC);
    caret(&mut d, at(DOC, "beta"));
    d.apply_local(|s| s.insert_text("X").unwrap());
    let (text, cursor, pending) = (d.text(), d.session().cursor(), d.pending().len());
    for mode in [
        MarkdownMode::Split,
        MarkdownMode::Preview,
        MarkdownMode::Source,
        MarkdownMode::Visual,
        MarkdownMode::Source,
    ] {
        d.set_mode(mode);
        assert_eq!(d.mode(), mode);
        assert_eq!(d.text(), text, "{mode:?}");
        assert_eq!(d.session().cursor(), cursor, "{mode:?}");
        assert_eq!(d.pending().len(), pending, "{mode:?}");
    }
    assert!(
        d.session().can_undo(),
        "history survives the round of modes"
    );
}

#[test]
fn a_mode_switch_keeps_the_scroll_anchor_by_block() {
    let text: String = (0..40).map(|n| format!("paragraph {n}\n\n")).collect();
    let mut d = doc(&text);
    drawn(&mut d, 40, 6);
    d.scroll_by(30);
    let block = d.view_state().anchor.block;
    assert!(block > 10, "scrolled down to block {block}");
    for mode in [
        MarkdownMode::Preview,
        MarkdownMode::Split,
        MarkdownMode::Source,
    ] {
        d.set_mode(mode);
        assert_eq!(d.view_state().anchor.block, block, "{mode:?}");
    }
}

#[test]
fn preview_refuses_edits_and_commands() {
    let mut d = doc(DOC);
    d.set_mode(MarkdownMode::Preview);
    assert!(d.apply_local(|s| s.insert_text("x")).is_err());
    assert!(d.inline_format(InlineFormat::Strong).is_err());
    assert_eq!(d.text(), DOC);
}

#[test]
fn visual_opens_the_block_at_the_caret_and_writes_only_its_range() {
    let mut d = doc(DOC);
    caret(&mut d, at(DOC, "beta"));
    d.set_mode(MarkdownMode::Visual);
    let range = d.open_range().expect("opened");
    assert_eq!(&DOC[range.clone()], "alpha beta gamma");
    let session = d.block_session().unwrap();
    let end = session.len();
    session.set_selection(end, end);
    type_in_block(&mut d, "!");
    assert_eq!(d.text(), DOC, "nothing is written while the block is open");
    let CommitOutcome::Written { range: written, .. } = d.commit_block() else {
        panic!("written");
    };
    assert_eq!(written, range);
    assert_eq!(d.text(), DOC.replace("gamma", "gamma!"));
}

#[test]
fn a_command_in_visual_runs_in_the_open_block() {
    let mut d = doc(DOC);
    caret(&mut d, at(DOC, "alpha"));
    d.set_mode(MarkdownMode::Visual);
    d.block_command(BlockCommand::Heading(2)).expect("heading");
    d.commit_block();
    assert!(d.text().contains("## alpha beta gamma"), "{}", d.text());
}

// ---- R11, AC-12: a peer's change never drops a block edit ----
//
// The donor's `commit` dropped the edit when the document differed from the
// text the block opened on, and ignored a press on a block when the document
// had moved. The tests below that carry "donor" in their names are those two
// donor tests, inverted.

#[test]
fn donor_drop_inverted_a_change_before_the_block_keeps_the_typed_text() {
    let mut d = typed_at_the_end();
    peer(&mut d, 0, 0, "intro line\n\n");
    assert!(matches!(d.commit_block(), CommitOutcome::Written { .. }));
    let text = d.text();
    assert!(text.starts_with("intro line\n\n# Title"), "{text}");
    assert!(text.contains("alpha beta gamma mine"), "{text}");
}

#[test]
fn donor_drop_inverted_a_change_after_the_block_keeps_the_typed_text() {
    let mut d = typed_at_the_end();
    peer(&mut d, at(DOC, "last"), at(DOC, "last") + 4, "final");
    d.commit_block();
    let text = d.text();
    assert!(text.contains("alpha beta gamma mine"), "{text}");
    assert!(text.contains("final block"), "{text}");
}

#[test]
fn a_change_in_the_same_block_away_from_the_typed_text_merges_both() {
    let mut d = doc(DOC);
    caret(&mut d, at(DOC, "alpha"));
    d.set_mode(MarkdownMode::Visual);
    d.block_session().unwrap().set_selection(0, 0);
    type_in_block(&mut d, ">> ");
    peer(&mut d, at(DOC, "gamma"), at(DOC, "gamma") + 5, "delta");
    assert!(!d.is_held());
    let CommitOutcome::Written { merged, .. } = d.commit_block() else {
        panic!("written");
    };
    assert!(merged);
    assert!(d.text().contains(">> alpha beta delta"), "{}", d.text());
}

#[test]
fn a_change_where_the_user_typed_holds_the_block_with_the_users_text_kept() {
    let mut d = typed_at_the_end();
    peer(&mut d, at(DOC, "gamma"), at(DOC, "gamma") + 5, "theirs");
    assert!(d.is_held());
    let conflict = d.block_conflict().expect("held");
    assert_eq!(conflict.mine, "alpha beta gamma mine");
    assert_eq!(conflict.theirs, "alpha beta theirs");
    assert_eq!(conflict.base, "alpha beta gamma");
    assert_eq!(d.commit_block(), CommitOutcome::Held);
    assert!(
        d.text().contains("alpha beta theirs"),
        "theirs is untouched"
    );
}

#[test]
fn a_held_block_resolves_each_way_without_losing_either_text() {
    let held = || {
        let mut d = typed_at_the_end();
        peer(&mut d, at(DOC, "gamma"), at(DOC, "gamma") + 5, "theirs");
        d
    };
    let mut d = held();
    let replaced = d.resolve_block_conflict(BlockResolution::KeepMine).unwrap();
    assert_eq!(replaced.as_deref(), Some("alpha beta theirs"));
    assert!(d.text().contains("alpha beta gamma mine"));

    let mut d = held();
    let dropped = d
        .resolve_block_conflict(BlockResolution::TakeTheirs)
        .unwrap();
    assert_eq!(dropped.as_deref(), Some("alpha beta gamma mine"));
    assert!(d.text().contains("alpha beta theirs"));
    assert!(d.open_range().is_none());

    let mut d = held();
    d.resolve_block_conflict(BlockResolution::KeepBoth).unwrap();
    let text = d.text();
    assert!(
        text.contains("alpha beta theirs\n\nalpha beta gamma mine"),
        "{text}"
    );
}

#[test]
fn a_change_that_removes_the_block_keeps_what_the_user_typed() {
    let mut d = typed_at_the_end();
    let start = at(DOC, "alpha");
    peer(&mut d, start, start + "alpha beta gamma".len(), "");
    assert!(d.is_held(), "the typed text is held, not dropped");
    assert_eq!(d.block_conflict().unwrap().mine, "alpha beta gamma mine");
}

#[test]
fn donor_press_ignored_inverted_a_block_opens_after_the_document_moved() {
    let mut d = doc(DOC);
    d.set_mode(MarkdownMode::Visual);
    peer(&mut d, 0, 0, "new first\n\n");
    let text = d.text();
    let index = d
        .blocks()
        .iter()
        .position(|b| &text[b.range.clone()] == "last block")
        .expect("the block");
    d.open_block(index);
    let range = d.open_range().expect("opened");
    assert_eq!(&text[range], "last block");
}

#[test]
fn an_append_block_writes_at_the_end_of_the_current_text() {
    let mut d = doc("one\n");
    d.set_mode(MarkdownMode::Visual);
    d.open_end();
    type_in_block(&mut d, "two");
    peer(&mut d, 0, 0, "zero\n\n");
    d.commit_block();
    assert_eq!(d.text(), "zero\n\none\n\ntwo");
}

// ---- R12, AC-13: untouched source stays as written ----

const AWKWARD: &str = "---\ntitle: x\ntags: [a,  b]\n---\n\n<!-- a comment  -->\n\nfirst   paragraph  with  spaces\n\n```rust\nfn  main( ) {}\n```\n\n:::unknown thing\n  keep   this\n:::\n\n* odd\n*   bullets\n\nlast\n";

#[test]
fn a_visual_edit_leaves_every_other_byte_as_written() {
    let mut d = doc(AWKWARD);
    caret(&mut d, at(AWKWARD, "paragraph"));
    d.set_mode(MarkdownMode::Visual);
    let range = d.open_range().unwrap();
    type_in_block(&mut d, "X");
    d.commit_block();
    let after = d.text();
    assert_eq!(after[..range.start], AWKWARD[..range.start]);
    let tail = AWKWARD.len() - range.end;
    assert_eq!(after[after.len() - tail..], AWKWARD[range.end..]);
    assert_ne!(after, AWKWARD);
}

#[test]
fn opening_and_closing_every_block_without_typing_changes_nothing() {
    let mut d = doc(AWKWARD);
    d.set_mode(MarkdownMode::Visual);
    for index in 0..d.blocks().len() {
        d.open_block(index);
    }
    d.commit_block();
    assert_eq!(d.text(), AWKWARD);
    assert!(d.pending().is_empty(), "no edit was made");
}

#[test]
fn front_matter_comments_fences_and_unknown_syntax_have_block_ranges() {
    let mut d = doc(AWKWARD);
    let text = d.text();
    let blocks = d.blocks();
    let parts: Vec<&str> = blocks.iter().map(|b| &text[b.range.clone()]).collect();
    assert!(parts.iter().any(|p| p.starts_with("---\ntitle: x")));
    assert!(parts.iter().any(|p| p.starts_with("<!-- a comment")));
    assert!(parts.iter().any(|p| p.starts_with("```rust")));
    assert!(parts.iter().any(|p| p.contains(":::unknown thing")));
}

// ---- R13, AC-14, AC-22: named coordinates ----

#[test]
fn local_edits_leave_as_utf16_against_the_accepted_text() {
    let mut d = doc("\u{1F600} a\n");
    caret(&mut d, "\u{1F600} a".len());
    let edit = d
        .apply_local(|s| s.insert_text("b").unwrap())
        .expect("an edit");
    let next = d.take_next_to_send().expect("queued");
    assert_eq!(next.op_id, edit.op_id);
    assert_eq!(next.base_revision, 1);
    assert_eq!(next.changes, vec![TextChange::new(4, 4, "b")]);
}

#[test]
fn remote_changes_arrive_as_utf16() {
    let mut d = doc("\u{1F600} a\n");
    peer(&mut d, "\u{1F600} ".len(), "\u{1F600} a".len(), "z");
    assert_eq!(d.text(), "\u{1F600} z\n");
}

#[test]
fn a_wrapped_view_does_not_move_source_offsets() {
    let mut d = doc("a long line of text that wraps in a narrow view\n");
    caret(&mut d, 30);
    let before = d.cursor_byte();
    drawn(&mut d, 12, 6);
    assert_eq!(d.cursor_byte(), before);
}

// ---- R14, AC-15, AC-52: input is local, an acknowledgement moves its baseline ----

#[test]
fn an_acknowledgement_does_not_overwrite_later_typing() {
    let mut d = doc("a\n");
    caret(&mut d, 1);
    d.apply_local(|s| s.insert_text("1").unwrap());
    let first = d.take_next_to_send().expect("first");
    d.apply_local(|s| s.insert_text("2").unwrap());
    d.acknowledge(&first.op_id, 2).expect("acknowledged");
    assert_eq!(d.text(), "a12\n");
    assert_eq!(d.revision(), 2);
    assert_eq!(d.pending().len(), 1, "the second edit is still waiting");
}

// ---- drawing: draws, not yet compared against a reference ----

#[test]
fn source_draws_numbered_lines() {
    let mut d = doc(DOC);
    let rows = drawn(&mut d, 30, 10);
    assert!(
        rows[0].starts_with("1 ") && rows[0].contains("# Title"),
        "{rows:?}"
    );
    assert!(
        rows[2].starts_with("3 ") && rows[2].contains("alpha beta gamma"),
        "{rows:?}"
    );
}

#[test]
fn preview_draws_the_document_without_its_marks() {
    let mut d = doc("# Title\n\nsome **bold** text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    d.set_mode(MarkdownMode::Preview);
    let rows = drawn(&mut d, 40, 14);
    assert!(has(&rows, "Title"), "{rows:?}");
    assert!(has(&rows, "some bold text"), "{rows:?}");
    assert!(!has(&rows, "**"), "{rows:?}");
    assert!(
        rows.iter()
            .any(|r| r.contains('a') && r.contains('b') && r.contains('\u{2502}')),
        "a table: {rows:?}"
    );
}

#[test]
fn visual_shows_the_block_under_the_cursor_as_source() {
    let text = "first **one**\n\nsecond **two**\n";
    let mut d = doc(text);
    caret(&mut d, at(text, "second"));
    d.set_mode(MarkdownMode::Visual);
    let rows = drawn(&mut d, 40, 8);
    assert!(has(&rows, "first one"), "rendered: {rows:?}");
    assert!(has(&rows, "second **two**"), "source: {rows:?}");
    assert!(!has(&rows, "first **one**"), "{rows:?}");
}

#[test]
fn visual_reports_the_caret_inside_the_open_block() {
    let mut d = doc("one\n\ntwo\n");
    caret(&mut d, 5);
    d.set_mode(MarkdownMode::Visual);
    let area = Rect::new(0, 0, 20, 6);
    let mut buf = Buffer::empty(area);
    let frame = d.draw(area, &mut buf, &MarkdownStyles::plain());
    let caret = frame.caret.expect("a caret");
    assert!(caret.y >= 1, "below the first block: {caret:?}");
}

#[test]
fn split_draws_source_and_document_and_follows_the_source_by_block() {
    let text: String = (0..30)
        .map(|n| format!("## Part {n}\n\ntext **{n}**\n\n"))
        .collect();
    let mut d = doc(&text);
    d.set_mode(MarkdownMode::Split);
    let first = drawn(&mut d, 60, 8);
    assert!(
        first
            .iter()
            .any(|r| r.contains("## Part 0") && r.contains('\u{2502}')),
        "{first:?}"
    );
    assert!(first.iter().any(|r| r.contains("text 0")), "{first:?}");
    d.scroll_by(40);
    let later = drawn(&mut d, 60, 8);
    let part: usize = later
        .iter()
        .find_map(|r| r.split('\u{2502}').next()?.split("Part ").nth(1))
        .and_then(|n| n.split_whitespace().next()?.parse().ok())
        .expect("a part on the left");
    assert!(part > 5, "scrolled: {later:?}");
    let right = later.iter().any(|r| {
        r.split('\u{2502}')
            .nth(1)
            .is_some_and(|c| c.contains(&format!("Part {part}")))
    });
    assert!(right, "the document is at the same block: {later:?}");
}

#[test]
fn colors_come_only_from_the_callers_styles() {
    let mut d = doc("# Title\n\ntext\n");
    d.set_mode(MarkdownMode::Preview);
    let area = Rect::new(0, 0, 20, 4);
    let mut plain = Buffer::empty(area);
    d.draw(area, &mut plain, &MarkdownStyles::plain());
    assert!(
        plain
            .content()
            .iter()
            .all(|c| c.fg == Color::Reset && c.bg == Color::Reset),
        "plain styles carry no palette"
    );
    let mut styles = MarkdownStyles::plain();
    styles.heading[0] = Style::new().fg(Color::Rgb(1, 2, 3));
    let mut colored = Buffer::empty(area);
    d.draw(area, &mut colored, &styles);
    assert_eq!(colored[(2, 0)].fg, Color::Rgb(1, 2, 3));
}

#[test]
fn a_zero_sized_area_draws_nothing_and_does_not_panic() {
    let mut d = doc(DOC);
    for (mode, _) in MarkdownMode::ALL {
        d.set_mode(mode);
        let area = Rect::new(0, 0, 0, 0);
        d.draw(area, &mut Buffer::empty(area), &MarkdownStyles::plain());
    }
}

// ---- view state ----

#[test]
fn the_view_serializes_and_restores_with_its_pending_block() {
    let mut d = typed_at_the_end();
    let json = d.view_state().to_json();
    let state = MarkdownViewState::from_json(&json).expect("reads back");
    let mut fresh = doc(DOC);
    fresh.restore_view(&state);
    assert_eq!(fresh.mode(), MarkdownMode::Visual);
    assert_eq!(fresh.session().cursor(), d.session().cursor());
    assert_eq!(
        fresh.block_session().unwrap().text(),
        d.block_session().unwrap().text()
    );
    fresh.commit_block();
    assert!(
        fresh.text().contains("alpha beta gamma mine"),
        "{}",
        fresh.text()
    );
}

#[test]
fn a_restored_block_over_text_that_moved_is_held_not_dropped() {
    let state = typed_at_the_end().view_state();
    let mut fresh = doc(&DOC.replace("gamma", "delta"));
    fresh.restore_view(&state);
    assert!(fresh.is_held());
    assert_eq!(
        fresh.block_conflict().unwrap().mine,
        "alpha beta gamma mine"
    );
}
