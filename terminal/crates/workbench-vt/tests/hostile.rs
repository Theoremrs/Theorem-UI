//! Escape sequences a program can print to reach beyond its own cells: links,
//! clipboard, titles, window and grid changes. The interpreter is `vt100`;
//! these pin what this crate does with what it leaves unhandled.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::widgets::Widget;
use theorem_workbench_vt::{Palette, Screen, TerminalView};

fn screen_with(rows: u16, cols: u16, bytes: &[u8]) -> Screen {
    let mut s = Screen::new(rows, cols);
    s.feed(bytes);
    s
}

#[test]
fn a_hyperlink_leaves_only_its_visible_text_whatever_its_target() {
    let long = format!("https://x.example/{}", "a".repeat(100_000));
    let targets = [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "https://evil.example/phish",
        long.as_str(),
        "https://x.example/\x01\x02\x7f\u{9b}2J",
    ];
    for target in targets {
        for terminator in ["\x07", "\x1b\\"] {
            let mut s = Screen::new(3, 40);
            let what = &target[..target.len().min(24)];
            // While the link is open, before the closing sequence clears it.
            s.feed(format!("\x1b]8;;{target}{terminator}https://good.example/").as_bytes());
            assert_eq!(s.title(), "", "{what:?} reached the title");
            s.feed(format!("\x1b]8;;{terminator}\r\nafter").as_bytes());
            assert_eq!(
                s.contents(),
                "https://good.example/\nafter",
                "target {what:?} changed the screen"
            );
            assert_eq!(s.cursor_position(), (1, 5), "{what:?}");
            assert!(
                s.take_replies().is_empty(),
                "{what:?} made the terminal answer"
            );
            assert_eq!(s.title(), "", "{what:?} reached the title");
            assert_eq!(s.take_bells(), 0, "{what:?}");
        }
    }
}

#[test]
fn clipboard_write_and_read_requests_change_nothing_and_get_no_answer() {
    let mut s = screen_with(3, 20, b"keep");
    let before = s.contents();
    for osc in [
        &b"\x1b]52;c;aGVsbG8=\x07"[..],
        b"\x1b]52;p;aGVsbG8=\x1b\\",
        b"\x1b]52;c;?\x07",
        b"\x1b]52;;?\x1b\\",
    ] {
        s.feed(osc);
    }
    assert_eq!(s.contents(), before);
    assert_eq!(s.cursor_position(), (0, 4));
    assert!(
        s.take_replies().is_empty(),
        "a program read the clipboard through the terminal's answers"
    );
}

#[test]
fn title_and_icon_sequences_are_data_and_never_cells_or_cursor_moves() {
    let sentence = "Approve this task: y allow \u{b7} n deny";
    let mut s = screen_with(3, 20, b"ab");
    for osc in [
        format!("\x1b]0;{sentence}\x07"),
        format!("\x1b]1;{sentence}\x07"),
        format!("\x1b]2;{sentence}\x1b\\"),
        "\x1b]2;one\r\ntwo\x08\x08\x08\x07".to_owned(),
    ] {
        s.feed(osc.as_bytes());
    }
    assert_eq!(s.contents(), "ab");
    assert_eq!(s.cursor_position(), (0, 2));
    assert!(s.take_replies().is_empty());
}

#[test]
fn a_program_cannot_resize_the_grid_or_scroll_it_off_through_window_reports() {
    let mut s = screen_with(4, 10, b"x");
    // XTWINOPS resize, DECCOLM, and a cursor sent far past both edges.
    s.feed(b"\x1b[8;50;200t\x1b[?3h\x1b[999;999H\x1b[5000C\x1b[5000B");
    assert_eq!(s.size(), (4, 10));
    let (row, col) = s.cursor_position();
    assert!(row < 4 && col < 10, "cursor left the grid: {row},{col}");
    assert!(s.take_replies().is_empty());
}

#[test]
fn drawing_stays_inside_the_rect_it_was_given_whatever_the_stream_did() {
    let mut s = Screen::new(5, 12);
    s.feed(b"\x1b]0;title\x07\x1b]8;;javascript:x\x07link\x1b]8;;\x07");
    s.feed("\x1b[5;12H\u{4e2d}\u{4e2d}\x1b[999;999Hz\x1b[8;40;120t".as_bytes());
    let pal = Palette::default();
    // The view's rect sits inside a larger buffer; every cell outside it must
    // stay as the buffer had it, whether the rect is larger or smaller than
    // the screen.
    for inner in [
        Rect::new(3, 2, 12, 5),
        Rect::new(3, 2, 6, 3),
        Rect::new(3, 2, 30, 20),
    ] {
        let mut buf = Buffer::empty(Rect::new(0, 0, 40, 25));
        buf.set_string(0, 0, "#", ratatui::style::Style::new());
        let before = buf.clone();
        TerminalView::new(&s, &pal).render(inner, &mut buf);
        for y in 0..25 {
            for x in 0..40 {
                let inside = inner.contains((x, y).into());
                if !inside {
                    assert_eq!(
                        buf[(x, y)],
                        before[(x, y)],
                        "{inner:?} wrote outside at {x},{y}"
                    );
                }
            }
        }
    }
}
