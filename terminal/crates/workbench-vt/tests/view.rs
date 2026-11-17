//! The widget: what lands in the ratatui buffer.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier};
use ratatui::widgets::Widget;
use theorem_workbench_vt::{Palette, Pos, Screen, SelectionKind, TerminalView};

macro_rules! fx {
    ($name:literal) => {
        include_bytes!(concat!("fixtures/", $name))
    };
}

fn render(screen: &Screen, palette: &Palette, w: u16, h: u16) -> Buffer {
    let mut buf = Buffer::empty(Rect::new(0, 0, w, h));
    TerminalView::new(screen, palette).render(buf.area, &mut buf);
    buf
}

fn row_text(buf: &Buffer, y: u16) -> String {
    (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect()
}

fn screen_with(rows: u16, cols: u16, bytes: &[u8]) -> Screen {
    let mut s = Screen::new(rows, cols);
    s.feed(bytes);
    s
}

fn custom() -> Palette {
    let mut ansi = [Color::Reset; 16];
    for (i, c) in ansi.iter_mut().enumerate() {
        *c = Color::Rgb(100 + i as u8, 0, 0);
    }
    Palette {
        fg: Color::Rgb(10, 10, 10),
        bg: Color::Rgb(20, 20, 20),
        ansi,
        ..Palette::default()
    }
}

#[test]
fn text_lands_where_the_screen_has_it() {
    let pal = Palette::default();
    let buf = render(&screen_with(5, 10, fx!("wrap.vt")), &pal, 10, 5);
    assert_eq!(row_text(&buf, 0), "abcdefghij");
    assert_eq!(row_text(&buf, 1), "klmnopqrst");
    assert_eq!(row_text(&buf, 2), "uvwxyz    ");
    assert_eq!(row_text(&buf, 3), "short     ");
}

#[test]
fn drawing_through_a_test_backend_terminal() {
    let screen = screen_with(3, 12, b"hello\r\nworld");
    let pal = Palette::default();
    let mut term = Terminal::new(TestBackend::new(12, 3)).unwrap();
    term.draw(|f| f.render_widget(TerminalView::new(&screen, &pal), f.area()))
        .unwrap();
    let buf = term.backend().buffer();
    assert_eq!(row_text(buf, 0), "hello       ");
    assert_eq!(row_text(buf, 1), "world       ");
}

#[test]
fn ansi_slots_and_defaults_come_from_the_palette() {
    let pal = custom();
    let buf = render(&screen_with(2, 40, fx!("sgr.vt")), &pal, 40, 2);
    // "red" in ANSI 1.
    assert_eq!(buf[(0, 0)].fg, pal.ansi[1]);
    assert_eq!(buf[(0, 0)].bg, pal.bg);
    // Default colours on the space after it.
    assert_eq!(buf[(3, 0)].fg, pal.fg);
    // Bold green: ANSI 2 plus the modifier.
    assert_eq!(buf[(4, 0)].fg, pal.ansi[2]);
    assert!(buf[(4, 0)].modifier.contains(Modifier::BOLD));
    // 256-colour above 15 and truecolor pass through.
    assert_eq!(buf[(9, 0)].fg, Color::Indexed(196));
    assert_eq!(buf[(13, 0)].fg, Color::Rgb(1, 2, 3));
    // Reverse video is resolved to swapped colours.
    assert_eq!(buf[(17, 0)].fg, pal.bg);
    assert_eq!(buf[(17, 0)].bg, pal.fg);
    assert!(!buf[(17, 0)].modifier.contains(Modifier::REVERSED));
    // Background ANSI 4.
    assert_eq!(buf[(21, 0)].bg, pal.ansi[4]);
    assert!(buf[(28, 0)].modifier.contains(Modifier::DIM));
    // Unused area still has the theme background.
    assert_eq!(buf[(39, 1)].bg, pal.bg);
}

#[test]
fn wide_and_combining_cells_render_as_one_symbol() {
    let buf = render(
        &screen_with(4, 10, fx!("wide.vt")),
        &Palette::default(),
        10,
        4,
    );
    assert_eq!(buf[(0, 0)].symbol(), "a");
    assert_eq!(buf[(1, 0)].symbol(), "漢");
    assert_eq!(buf[(3, 0)].symbol(), "字");
    assert_eq!(buf[(5, 0)].symbol(), "b");
    assert_eq!(buf[(0, 1)].symbol(), "e\u{301}");
    assert_eq!(buf[(1, 1)].symbol(), "x");
}

#[test]
fn cursor_is_drawn_in_theme_colours_and_can_be_hidden() {
    let pal = custom();
    let mut s = screen_with(3, 10, b"abc");
    let buf = render(&s, &pal, 10, 3);
    assert_eq!(buf[(3, 0)].bg, pal.fg, "block cursor swaps the colours");
    assert_eq!(buf[(3, 0)].fg, pal.bg);
    assert_eq!(buf[(2, 0)].bg, pal.bg);

    let mut off = Buffer::empty(Rect::new(0, 0, 10, 3));
    TerminalView::new(&s, &pal)
        .show_cursor(false)
        .render(off.area, &mut off);
    assert_eq!(off[(3, 0)].bg, pal.bg, "caller hid it");

    s.feed(b"\x1b[?25l");
    assert_eq!(render(&s, &pal, 10, 3)[(3, 0)].bg, pal.bg, "program hid it");

    s.feed(b"\x1b[?25h\x1b[4 q");
    let buf = render(&s, &pal, 10, 3);
    assert!(buf[(3, 0)].modifier.contains(Modifier::UNDERLINED));
    assert_eq!(buf[(3, 0)].bg, pal.bg);

    s.feed(b"\x1b[6 q");
    assert_eq!(render(&s, &pal, 10, 3)[(3, 0)].symbol(), "\u{258f}");
}

#[test]
fn cursor_sits_on_a_character_by_reversing_it() {
    let pal = Palette::default();
    let buf = render(&screen_with(2, 10, b"abc\x1b[1D"), &pal, 10, 2);
    assert_eq!(buf[(2, 0)].symbol(), "c");
    assert_eq!(buf[(2, 0)].bg, pal.fg);
}

#[test]
fn scrolled_view_shows_scrollback_and_hides_an_off_view_cursor() {
    let pal = Palette::default();
    let mut s = screen_with(5, 20, fx!("lines40.vt"));
    s.scroll_up(10);
    let buf = render(&s, &pal, 20, 5);
    assert_eq!(row_text(&buf, 0).trim_end(), "line026");
    assert_eq!(row_text(&buf, 4).trim_end(), "line030");
    for y in 0..5 {
        for x in 0..20 {
            assert_eq!(buf[(x, y)].bg, pal.bg, "no cursor at ({x},{y})");
        }
    }
    s.scroll_to_bottom();
    let buf = render(&s, &pal, 20, 5);
    assert_eq!(buf[(0, 4)].bg, pal.fg, "cursor back on the live screen");
}

#[test]
fn selection_and_search_are_laid_over_the_cells() {
    let pal = Palette::default();
    let mut s = screen_with(5, 10, fx!("wrap.vt"));
    s.select(SelectionKind::Cell, Pos { row: 0, col: 8 });
    s.extend_selection(Pos { row: 1, col: 2 });
    let buf = render(&s, &pal, 10, 5);
    let selected = |x, y| buf[(x, y)].bg == pal.selection.bg.unwrap();
    assert!(!selected(7, 0) && selected(8, 0) && selected(9, 0));
    assert!(selected(0, 1) && selected(2, 1) && !selected(3, 1));
    assert_eq!(buf[(8, 0)].symbol(), "i", "text is still there");

    s.clear_selection();
    s.search("o");
    s.search_next();
    let buf = render(&s, &pal, 10, 5);
    assert_eq!(
        buf[(4, 1)].bg,
        pal.search_current.bg.unwrap(),
        "current match"
    );
    assert_eq!(buf[(2, 3)].bg, pal.search_match.bg.unwrap(), "other match");
    assert_eq!(buf[(3, 3)].bg, pal.bg);
}
