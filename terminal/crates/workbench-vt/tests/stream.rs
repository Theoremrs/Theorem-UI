//! Byte-stream fixtures through `Screen`: cells, modes, scrollback, offsets,
//! resize, repaint, selection, search.

use theorem_workbench_vt::{
    CursorShape, MouseProtocolEncoding, MouseProtocolMode, OffsetGap, Pos, SCROLLBACK_LINES,
    Screen, SelectionKind,
};

macro_rules! fx {
    ($name:literal) => {
        include_bytes!(concat!("fixtures/", $name))
    };
}

fn screen_with(rows: u16, cols: u16, bytes: &[u8]) -> Screen {
    let mut s = Screen::new(rows, cols);
    s.feed(bytes);
    s
}

/// The rows on view, one string each (wrapped rows stay separate), without
/// the empty rows at the bottom.
fn lines(s: &Screen) -> Vec<String> {
    let (_, cols) = s.size();
    let mut rows: Vec<String> = s.vt().rows(0, cols).collect();
    while rows.last().is_some_and(String::is_empty) {
        rows.pop();
    }
    rows
}

fn pos(row: usize, col: u16) -> Pos {
    Pos { row, col }
}

// ---- cells ---------------------------------------------------------------

#[test]
fn plain_text_wraps_at_the_right_edge() {
    let s = screen_with(5, 10, fx!("wrap.vt"));
    assert_eq!(lines(&s), ["abcdefghij", "klmnopqrst", "uvwxyz", "short"]);
    assert!(s.vt().row_wrapped(0));
    assert!(s.vt().row_wrapped(1));
    assert!(!s.vt().row_wrapped(2));
    assert_eq!(s.cursor_position(), (4, 0));
}

#[test]
fn sgr_colours_and_attributes_land_on_cells() {
    let s = screen_with(2, 40, fx!("sgr.vt"));
    let cell = |c| s.vt().cell(0, c).unwrap();
    assert_eq!(cell(0).fgcolor(), vt100::Color::Idx(1));
    assert!(cell(4).bold());
    assert_eq!(cell(4).fgcolor(), vt100::Color::Idx(2));
    assert_eq!(cell(9).fgcolor(), vt100::Color::Idx(196));
    assert_eq!(cell(13).fgcolor(), vt100::Color::Rgb(1, 2, 3));
    assert!(cell(17).inverse());
    assert_eq!(cell(21).bgcolor(), vt100::Color::Idx(4));
    assert!(cell(28).dim());
    assert_eq!(cell(3).fgcolor(), vt100::Color::Default);
}

#[test]
fn cursor_movement_erase_insert_and_delete() {
    let s = screen_with(4, 8, fx!("cursor_erase.vt"));
    assert_eq!(lines(&s), ["145", "ab", " q", "   _X"]);
    assert_eq!(s.cursor_position(), (3, 4));
}

#[test]
fn scroll_region_keeps_rows_outside_it() {
    let s = screen_with(6, 10, fx!("scroll_region.vt"));
    assert_eq!(lines(&s), ["TOP", "A", " B", "", "r5", "r6"]);
    assert_eq!(s.scrollback_len(), 0, "a region scroll keeps no history");
}

#[test]
fn full_screen_program_enters_and_leaves_the_alternate_screen() {
    let mut s = screen_with(6, 20, fx!("alt_before.vt"));
    assert!(!s.alternate_screen());
    s.feed(fx!("alt_enter.vt"));
    assert!(s.alternate_screen());
    assert!(!s.cursor_visible());
    assert_eq!(lines(&s), ["FULL SCREEN", "line two"]);
    s.feed(fx!("alt_leave.vt"));
    assert!(!s.alternate_screen());
    assert!(s.cursor_visible());
    assert_eq!(lines(&s), ["prompt$ ls", "file.txt"]);
}

#[test]
fn wide_and_combining_characters_take_the_right_cells() {
    let s = screen_with(4, 10, fx!("wide.vt"));
    assert!(s.vt().cell(0, 1).unwrap().is_wide());
    assert!(s.vt().cell(0, 2).unwrap().is_wide_continuation());
    assert_eq!(s.vt().cell(0, 5).unwrap().contents(), "b");
    assert_eq!(s.vt().cell(1, 0).unwrap().contents(), "e\u{301}");
    assert_eq!(s.vt().cell(1, 1).unwrap().contents(), "x");
    assert_eq!(lines(&s), ["a漢字b", "e\u{301}x", "漢漢漢"]);
}

#[test]
fn modes_title_cursor_shape_and_bell() {
    let mut s = screen_with(4, 20, fx!("modes.vt"));
    assert!(s.application_cursor());
    assert!(s.application_keypad());
    assert!(s.bracketed_paste());
    assert_eq!(s.mouse_mode(), MouseProtocolMode::ButtonMotion);
    assert_eq!(s.mouse_encoding(), MouseProtocolEncoding::Sgr);
    assert!(s.focus_reporting());
    assert_eq!(s.cursor_shape(), CursorShape::BlinkingBar);
    assert_eq!(s.title(), "my title");
    assert_eq!(s.take_bells(), 1, "the OSC terminator is not a bell");
    assert_eq!(s.take_bells(), 0);
    s.feed(b"\x1b[?1l\x1b>\x1b[?2004l\x1b[?1002l\x1b[?1004l\x1b[2 q");
    assert!(!s.application_cursor() && !s.application_keypad() && !s.bracketed_paste());
    assert_eq!(s.mouse_mode(), MouseProtocolMode::None);
    assert!(!s.focus_reporting());
    assert_eq!(s.cursor_shape(), CursorShape::SteadyBlock);
}

#[test]
fn terminal_queries_are_answered() {
    let mut s = screen_with(4, 20, fx!("queries.vt"));
    assert_eq!(
        s.take_replies(),
        b"\x1b[1;4R\x1b[0n\x1b[?62;22c\x1b[>0;0;0c".to_vec()
    );
    assert!(s.take_replies().is_empty());
}

// ---- split sequences (AC-31) -----------------------------------------------

#[test]
fn every_split_point_gives_the_same_screen() {
    let all: [(&str, &[u8]); 7] = [
        ("wrap", fx!("wrap.vt")),
        ("sgr", fx!("sgr.vt")),
        ("cursor_erase", fx!("cursor_erase.vt")),
        ("scroll_region", fx!("scroll_region.vt")),
        ("wide", fx!("wide.vt")),
        ("modes", fx!("modes.vt")),
        ("queries", fx!("queries.vt")),
    ];
    for (name, bytes) in all {
        let whole = screen_with(6, 12, bytes);
        for at in 0..=bytes.len() {
            let mut split = Screen::new(6, 12);
            split.feed(&bytes[..at]);
            split.feed(&bytes[at..]);
            assert_eq!(
                split.vt().state_formatted(),
                whole.vt().state_formatted(),
                "{name} split at {at}"
            );
            assert_eq!(split.title(), whole.title(), "{name} title at {at}");
            assert_eq!(split.focus_reporting(), whole.focus_reporting());
        }
    }
}

// ---- scrollback ------------------------------------------------------------

#[test]
fn scrolling_by_lines_pages_and_ends() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    assert_eq!(s.scrollback_len(), 36);
    assert!(s.is_following());
    s.scroll_up(10);
    assert_eq!(s.scrollback_offset(), 10);
    assert!(lines(&s)[0].starts_with("line026"));
    s.scroll_down(3);
    assert!(lines(&s)[0].starts_with("line029"));
    s.scroll_page_up();
    assert_eq!(s.scrollback_offset(), 11, "a page is rows minus one");
    s.scroll_page_down();
    s.scroll_to_top();
    assert_eq!(s.scrollback_offset(), 36);
    assert!(lines(&s)[0].starts_with("line000"));
    s.scroll_up(100);
    assert_eq!(s.scrollback_offset(), 36, "clamped at the oldest line");
    s.scroll_to_bottom();
    assert!(s.is_following());
}

#[test]
fn new_output_does_not_move_a_scrolled_up_view() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.scroll_up(10);
    let before = lines(&s);
    s.feed(b"more 1\r\nmore 2\r\nmore 3\r\n");
    assert_eq!(lines(&s), before);
    assert_eq!(s.scrollback_offset(), 13, "offset grows with the history");
    assert!(!s.is_following());
    s.scroll_to_bottom();
    s.feed(b"more 4\r\n");
    assert!(s.is_following(), "a following view keeps following");
    assert!(lines(&s).iter().any(|l| l.starts_with("more 4")));
}

#[test]
fn scrollback_is_capped_to_the_host_depth() {
    let mut s = Screen::new(5, 20);
    for i in 0..SCROLLBACK_LINES + 100 {
        s.feed(format!("n{i}\r\n").as_bytes());
    }
    assert_eq!(s.scrollback_len(), SCROLLBACK_LINES);
    s.scroll_to_top();
    // 2100 lines + the cursor line = 2101; 5 stay on screen.
    assert!(lines(&s)[0].starts_with("n96"), "{}", lines(&s)[0]);
}

#[test]
fn alternate_screen_has_no_scrollback() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    assert_eq!(s.scrollback_len(), 36);
    s.feed(fx!("alt_enter.vt"));
    assert_eq!(s.scrollback_len(), 0);
    s.scroll_up(5);
    assert!(s.is_following());
    s.feed(fx!("alt_leave.vt"));
    assert_eq!(s.scrollback_len(), 36);
}

// ---- resize and repaint ----------------------------------------------------

#[test]
fn resize_in_the_middle_keeps_scrollback_and_applies_to_later_output() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.feed(b"tail");
    s.resize(8, 30);
    assert_eq!(s.size(), (8, 30));
    assert_eq!(s.scrollback_len(), 36);
    s.feed(b"-x\r\n0123456789012345678901234567890123456789\r\n");
    let l = lines(&s);
    assert!(l.iter().any(|r| r == "tail-x"), "{l:?}");
    assert!(l.iter().any(|r| r == "012345678901234567890123456789"));
    assert!(
        l.iter().any(|r| r == "0123456789"),
        "long line wrapped at 30"
    );
}

#[test]
fn a_repaint_replaces_state_and_sets_the_offset() {
    let mut host = vt100::Parser::new(6, 30, 2000);
    host.process(fx!("sgr.vt"));
    host.process(b"\x1b[3;5Hcursor here");
    let formatted = host.screen().contents_formatted();

    let mut s = screen_with(6, 30, fx!("lines40.vt"));
    s.search("line");
    s.select(SelectionKind::Cell, pos(2, 0));
    s.feed(fx!("modes.vt"));
    s.reset_with_formatted(&formatted, 4096);

    assert_eq!(s.contents(), host.screen().contents());
    assert_eq!(s.vt().contents_formatted(), formatted);
    assert_eq!(s.cursor_position(), host.screen().cursor_position());
    assert_eq!(s.applied_offset(), 4096);
    assert_eq!(s.scrollback_len(), 0);
    assert!(s.selection().is_none() && s.search_matches().is_empty());
    assert!(!s.application_cursor() && s.title().is_empty());
}

/// Evidence for the gap in the host contract: the host sends
/// `contents_formatted()`, which carries cells and cursor but no modes.
#[test]
fn the_hosts_formatted_repaint_carries_no_input_modes_or_alternate_screen() {
    let mut host = vt100::Parser::new(6, 30, 2000);
    host.process(fx!("alt_before.vt"));
    host.process(fx!("alt_enter.vt"));
    host.process(fx!("modes.vt"));
    assert!(host.screen().alternate_screen() && host.screen().bracketed_paste());

    let mut s = Screen::new(6, 30);
    s.reset_with_formatted(&host.screen().contents_formatted(), 1);
    assert_eq!(s.contents(), host.screen().contents(), "cells do arrive");
    assert!(!s.alternate_screen());
    assert!(!s.bracketed_paste() && !s.application_cursor());
    assert_eq!(s.mouse_mode(), MouseProtocolMode::None);

    // `state_formatted()` would carry the input modes (not the alternate
    // screen flag, the title, the cursor shape or focus reporting).
    s.reset_with_formatted(&host.screen().state_formatted(), 1);
    assert!(s.bracketed_paste() && s.application_cursor() && s.application_keypad());
    assert_eq!(s.mouse_mode(), MouseProtocolMode::ButtonMotion);
    assert!(!s.alternate_screen() && !s.focus_reporting());
}

// ---- offsets ---------------------------------------------------------------

#[test]
fn feed_at_applies_in_order_and_refuses_a_gap() {
    let mut s = Screen::new(3, 20);
    assert_eq!(s.feed_at(0, b"hello "), Ok(6));
    assert_eq!(s.applied_offset(), 6);
    assert_eq!(
        s.feed_at(10, b"zzz"),
        Err(OffsetGap {
            expected: 6,
            got: 10
        })
    );
    assert_eq!(s.contents(), "hello ", "a refused range changes nothing");
    assert_eq!(s.feed_at(6, b"world"), Ok(5));
    assert_eq!(s.contents(), "hello world");
}

#[test]
fn feed_at_ignores_bytes_already_applied() {
    let mut s = Screen::new(3, 20);
    s.feed_at(0, b"abcdef").unwrap();
    assert_eq!(s.feed_at(0, b"abcdef"), Ok(0), "fully repeated");
    assert_eq!(s.feed_at(2, b"cdef"), Ok(0));
    assert_eq!(s.feed_at(3, b"defGH"), Ok(2), "overlap trimmed");
    assert_eq!(s.applied_offset(), 8);
    assert_eq!(s.contents(), "abcdefGH");
}

#[test]
fn offset_after_a_repaint_continues_from_the_repaint() {
    let mut s = Screen::new(3, 20);
    s.reset_with_formatted(b"\x1b[2J\x1b[Hold", 100);
    assert_eq!(
        s.feed_at(90, b"0123456789xy"),
        Ok(2),
        "bytes before 100 are old"
    );
    assert_eq!(s.contents(), "oldxy");
    assert!(s.feed_at(120, b"?").is_err());
}

// ---- selection -------------------------------------------------------------

#[test]
fn selecting_cells_across_a_wrapped_line() {
    let mut s = screen_with(5, 10, fx!("wrap.vt"));
    s.select(SelectionKind::Cell, pos(0, 8));
    s.extend_selection(pos(1, 2));
    assert_eq!(s.selection_text().as_deref(), Some("ijklm"));
    s.select(SelectionKind::Cell, pos(1, 2));
    s.extend_selection(pos(0, 8));
    let span = s.selection().unwrap();
    assert_eq!((span.start, span.end), (pos(0, 8), pos(1, 2)), "ordered");
    assert_eq!(s.selection_text().as_deref(), Some("ijklm"));
    s.select(SelectionKind::Cell, pos(2, 0));
    s.extend_selection(pos(3, 2));
    assert_eq!(s.selection_text().as_deref(), Some("uvwxyz\nsho"));
}

#[test]
fn selecting_words_and_lines() {
    let mut s = screen_with(5, 20, b"foo bar_1 -- x\r\nnext\r\n");
    s.select(SelectionKind::Word, pos(0, 5));
    assert_eq!(s.selection_text().as_deref(), Some("bar_1"));
    s.extend_selection(pos(1, 1));
    assert_eq!(s.selection_text().as_deref(), Some("bar_1 -- x\nnext"));

    let mut s = screen_with(5, 10, fx!("wrap.vt"));
    s.select(SelectionKind::Line, pos(1, 3));
    let span = s.selection().unwrap();
    assert_eq!((span.start, span.end), (pos(0, 0), pos(2, 9)));
    assert_eq!(
        s.selection_text().as_deref(),
        Some("abcdefghijklmnopqrstuvwxyz")
    );
    s.extend_selection(pos(3, 0));
    assert_eq!(
        s.selection_text().as_deref(),
        Some("abcdefghijklmnopqrstuvwxyz\nshort")
    );
}

#[test]
fn selecting_wide_characters_never_splits_them() {
    let mut s = screen_with(4, 10, fx!("wide.vt"));
    // Click on the right half of the first wide character.
    s.select(SelectionKind::Cell, pos(0, 2));
    let span = s.selection().unwrap();
    assert_eq!((span.start.col, span.end.col), (1, 2));
    assert_eq!(s.selection_text().as_deref(), Some("漢"));
    s.extend_selection(pos(0, 5));
    assert_eq!(s.selection_text().as_deref(), Some("漢字b"));
    s.select(SelectionKind::Cell, pos(0, 0));
    s.extend_selection(pos(0, 3));
    assert_eq!(
        s.selection_text().as_deref(),
        Some("a漢字"),
        "an end on the left half takes the whole character"
    );
    s.select(SelectionKind::Word, pos(1, 0));
    assert_eq!(s.selection_text().as_deref(), Some("e\u{301}x"));
}

#[test]
fn selection_reaches_into_scrollback_and_follows_new_output() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.select(SelectionKind::Line, pos(10, 0));
    assert_eq!(s.selection_text().as_deref(), Some("line010"));
    s.feed(b"x\r\ny\r\n");
    assert_eq!(s.selection_text().as_deref(), Some("line010"));
    s.clear_selection();
    assert!(s.selection().is_none() && s.selection_text().is_none());
}

#[test]
fn selection_is_dropped_when_the_alternate_screen_or_a_resize_changes_rows() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.select(SelectionKind::Line, pos(10, 0));
    s.feed(fx!("alt_enter.vt"));
    assert!(s.selection().is_none());
    s.feed(fx!("alt_leave.vt"));
    s.select(SelectionKind::Line, pos(10, 0));
    s.resize(6, 20);
    assert!(s.selection().is_none());
}

#[test]
fn selection_is_dropped_when_a_full_scrollback_evicts_lines() {
    let mut s = Screen::new(5, 20);
    for i in 0..SCROLLBACK_LINES + 10 {
        s.feed(format!("n{i}\r\n").as_bytes());
    }
    s.select(SelectionKind::Line, pos(100, 0));
    assert!(s.selection().is_some());
    s.feed(b"one more\r\n");
    assert!(s.selection().is_none());
}

// ---- search ----------------------------------------------------------------

#[test]
fn search_covers_scrollback_and_the_screen_and_steps_both_ways() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.search("line01");
    assert_eq!(s.search_matches().len(), 10);
    assert_eq!(s.search_current(), None);

    let first = s.search_next().unwrap();
    assert_eq!(first.start, pos(10, 0));
    assert_eq!(first.end, pos(10, 5));
    assert!(!s.is_following(), "the match was scrolled into view");
    assert!(lines(&s).iter().any(|l| l.starts_with("line010")));

    for _ in 0..9 {
        s.search_next();
    }
    assert_eq!(s.search_current(), Some(9));
    assert_eq!(s.search_next().unwrap().start, pos(10, 0), "wraps");
    assert_eq!(s.search_prev().unwrap().start, pos(19, 0), "wraps back");
    assert_eq!(s.search_prev().unwrap().start, pos(18, 0));
}

#[test]
fn search_smart_case_and_a_match_across_a_wrapped_line() {
    let mut s = screen_with(5, 10, b"Hello hello\r\nabcdefghijklmn\r\n");
    s.search("hello");
    assert_eq!(s.search_matches().len(), 2);
    s.search("Hello");
    assert_eq!(s.search_matches().len(), 1);
    s.search("jk");
    let m = s.search_matches()[0];
    assert_eq!((m.start, m.end), (pos(2, 9), pos(3, 0)));
    s.search("nomatch");
    assert!(s.search_matches().is_empty() && s.search_next().is_none());
    s.search("");
    assert!(s.search_matches().is_empty());
}

#[test]
fn search_matches_follow_new_output_and_keep_the_current_one() {
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.search("line03");
    s.search_next();
    let current = s.search_matches()[s.search_current().unwrap()];
    s.feed(b"line03x\r\nz\r\n");
    assert_eq!(s.search_matches().len(), 11);
    assert_eq!(
        s.search_matches()[s.search_current().unwrap()].start,
        current.start
    );
    s.clear_search();
    assert!(s.search_matches().is_empty());
}

#[test]
fn search_finds_wide_characters_by_both_cells() {
    let mut s = screen_with(4, 10, fx!("wide.vt"));
    s.search("漢字");
    let m = s.search_matches()[0];
    assert_eq!((m.start, m.end), (pos(0, 1), pos(0, 4)));
}
