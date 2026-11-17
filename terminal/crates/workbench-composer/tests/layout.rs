mod common;

use common::*;
use keybinds::{Key, Mods};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;
use theorem_workbench_composer::{ComposerStatus, Policy};
use theorem_workbench_core::DraftAttachmentState::{Adding, Ready};
use theorem_workbench_core::Theme;
use unicode_width::UnicodeWidthStr;

#[test]
fn cjk_and_emoji_take_two_cells_at_the_caret_and_at_the_wrap() {
    let mut r = rig(20, 6);
    r.type_str("\u{4E2D}\u{6587}\u{1F600}x");
    // prompt 2 + 2 + 2 + 2 + 1
    assert_eq!(r.c.caret(r.now).cell, Some((9, 0)));
    r.press(Key::Left);
    assert_eq!(r.c.caret(r.now).cell, Some((8, 0)));
    r.press(Key::Left);
    assert_eq!(
        r.c.caret(r.now).cell,
        Some((6, 0)),
        "the emoji is one cluster of two cells"
    );
    // Wrap: 18 text columns hold nine wide characters.
    let mut r = rig(20, 6);
    r.type_str(&"\u{4E2D}".repeat(10));
    let dump = r.dump();
    let rows: Vec<&str> = dump.lines().collect();
    assert_eq!(
        rows[0],
        format!("\u{203A} {}", "\u{4E2D}".repeat(9)),
        "{dump}"
    );
    assert_eq!(rows[1], format!("  {}", "\u{4E2D}"), "{dump}");
    assert_eq!(r.c.caret(r.now).cell, Some((4, 1)));
    assert_eq!(r.c.desired_height(20, 8), 3);
}

#[test]
fn a_wide_character_is_never_split_at_the_right_edge() {
    let mut r = rig(6, 4);
    r.type_str("ab\u{4E2D}\u{4E2D}");
    for row in r.dump().lines() {
        assert!(UnicodeWidthStr::width(row) <= 6, "{row:?}");
    }
}

#[test]
fn twenty_columns_clip_without_panicking_in_every_state() {
    let mut r = rig(20, 7);
    r.c.set_attachments(vec![
        attachment("a", "a-rather-long-file-name.txt", Ready),
        attachment("b", "second.bin", Adding),
    ]);
    r.c.set_status(ComposerStatus {
        policy: Policy::Running { can_steer: true },
        model: Some("a very long model label".into()),
        effort: Some("high".into()),
        context_percent: Some(99),
    });
    r.type_str("@abc a long line of text that must wrap \u{4E2D}\u{6587}");
    r.c.files_found(
        r.c.caret_offset() as u64,
        vec!["some/very/long/path/to/a/file.rs".into()],
    );
    r.press(Key::Up);
    r.c.open_models(
        vec![theorem_workbench_core::ModelChoice {
            model_ref: "m".into(),
            label: "A model with a very long label indeed".into(),
            context_tokens: Some(1_000_000),
        }],
        0,
    );
    for w in [1u16, 2, 3, 4, 5, 8, 20] {
        for h in [0u16, 1, 2, 3, 6, 12] {
            let mut buf = ratatui::buffer::Buffer::empty(Rect::new(0, 0, w, h));
            r.c.draw(Rect::new(0, 0, w, h), &mut buf, &Theme::plain());
            r.c.resize(Rect::new(0, 0, w, h));
            let _ = r.c.semantics(Rect::new(0, 0, w, h));
            let _ = r.c.caret(0.0);
        }
    }
    r.resize(20, 12);
    for row in r.dump().lines() {
        assert!(UnicodeWidthStr::width(row) <= 20, "{row:?}");
    }
}

#[test]
fn a_zero_size_area_does_not_panic_and_input_still_works() {
    let mut r = rig(0, 0);
    r.type_str("abc");
    assert_eq!(r.c.text(), "abc");
    r.click(0, 0, 1);
    r.press(Key::Up);
    r.press(Key::Home);
    r.paste("x\ny");
    let _ = r.c.desired_height(0, 0);
    let mut buf = ratatui::buffer::Buffer::empty(Rect::new(0, 0, 0, 0));
    r.c.draw(Rect::new(0, 0, 0, 0), &mut buf, &Theme::plain());
    assert_eq!(r.c.caret(0.0).cell, None);
    let nodes = r.c.semantics(Rect::new(0, 0, 0, 0));
    assert!(!nodes.is_empty());
    r.resize(0, 5);
    r.type_str("d");
    r.resize(5, 0);
    r.type_str("e");
    assert!(r.c.text().contains("de"), "{:?}", r.c.text());
}

#[test]
fn it_draws_through_a_ratatui_test_backend() {
    let mut r = rig(30, 4);
    r.type_str("via backend");
    let mut term = Terminal::new(TestBackend::new(30, 4)).unwrap();
    term.draw(|f| r.c.draw(f.area(), f.buffer_mut(), &Theme::plain()))
        .unwrap();
    let dumped = dump(term.backend().buffer());
    assert!(dumped.starts_with("\u{203A} via backend"), "{dumped}");
}

#[test]
fn the_area_need_not_start_at_the_origin() {
    let mut c = theorem_workbench_composer::Composer::new("c");
    let area = Rect::new(5, 3, 30, 4);
    c.resize(area);
    c.handle(theorem_workbench_composer::Input::Text("hi".into()), 0.0);
    let mut buf = ratatui::buffer::Buffer::empty(Rect::new(0, 0, 40, 10));
    c.draw(area, &mut buf, &Theme::plain());
    assert_eq!(buf[(5, 3)].symbol(), "\u{203A}");
    assert_eq!(buf[(7, 3)].symbol(), "h");
    assert_eq!(c.caret(0.0).cell, Some((9, 3)));
    // A click is in the same space.
    c.handle(
        theorem_workbench_composer::Input::Pointer(theorem_workbench_core::PanelPointer {
            kind: theorem_workbench_core::PointerKind::Down(theorem_workbench_core::Button::Left),
            x: 7,
            y: 3,
            mods: Mods::empty(),
            clicks: 1,
        }),
        1.0,
    );
    assert_eq!(c.caret_offset(), 0);
}

/// Four states at two widths, printed with `--nocapture`: the evidence for the report.
#[test]
fn state_dumps() {
    for width in [80u16, 30] {
        // 1: empty with the placeholder.
        let mut r = rig(width, 3);
        r.c.set_placeholder("Ask Theo anything");
        r.c.set_status(ComposerStatus {
            policy: Policy::Idle,
            model: Some("DeepSeek V4.1 Flash".into()),
            effort: Some("high".into()),
            context_percent: Some(12),
        });
        let h = r.c.desired_height(width, 5);
        r.resize(width, h);
        println!("--- {width}: empty with placeholder\n{}\n", r.dump());
        assert!(r.dump().contains("Ask Theo anything"));

        // 2: multiline with a selection.
        let mut r = rig(width, 5);
        r.type_str("first line");
        r.key(Key::Enter, shift());
        r.type_str("second line of the message");
        r.key(Key::Left, Mods::ALT | Mods::SHIFT);
        r.key(Key::Left, Mods::ALT | Mods::SHIFT);
        let h = r.c.desired_height(width, 5);
        r.resize(width, h);
        println!(
            "--- {width}: multiline, selection {:?}\n{}\n",
            r.c.selection(),
            r.dump()
        );

        // 3: chips plus a reference popup.
        let mut r = rig(width, 8);
        r.c.set_attachments(vec![
            attachment("a", "notes.md", Ready),
            attachment("b", "photo.png", Adding),
        ]);
        let token = type_asking(&mut r, "look at @ma");
        r.c.files_found(
            token,
            vec![
                "src/main.rs".into(),
                "src/mod.rs".into(),
                "docs/map.md".into(),
            ],
        );
        let h = r.c.desired_height(width, 5);
        r.resize(width, h);
        println!("--- {width}: chips and a reference popup\n{}\n", r.dump());
        assert!(r.dump().contains("src/main.rs"));

        // 4: running with the steer footer.
        let mut r = rig(width, 3);
        r.c.set_status(ComposerStatus {
            policy: Policy::Running { can_steer: true },
            model: Some("DeepSeek V4.1 Flash".into()),
            effort: Some("high".into()),
            context_percent: Some(48),
        });
        r.type_str("also check the tests");
        let h = r.c.desired_height(width, 5);
        r.resize(width, h);
        println!("--- {width}: running, steer footer\n{}\n", r.dump());
        assert!(r.dump().contains("Enter steers"));
        if width == 30 {
            assert!(r.dump().contains("Enter steers, Esc stops"), "{}", r.dump());
        }
    }
}

#[test]
fn the_focused_prompt_is_the_glyph_in_the_focus_colour_on_the_surface() {
    use ratatui::style::{Color, Modifier, Style};
    let surface = Color::Rgb(30, 34, 40);
    let accent = Color::Rgb(140, 190, 170);
    let text = Style::default().fg(Color::White).bg(surface);
    let filled = Style::default().fg(Color::Black).bg(accent);
    let reversed = Style::default()
        .fg(accent)
        .add_modifier(Modifier::REVERSED | Modifier::BOLD);
    for focus in [filled, reversed] {
        let theme = Theme::chrome(
            Style::default().bg(surface),
            text,
            Style::default().fg(Color::Gray),
            Style::default().fg(Color::DarkGray),
            focus,
            Style::default(),
        );
        let mut r = rig(30, 4);
        r.type_str("hello there");
        r.c.set_focused(true);
        let mut buf = ratatui::buffer::Buffer::empty(Rect::new(0, 0, 30, 4));
        r.c.draw(Rect::new(0, 0, 30, 4), &mut buf, &theme);
        let cell = &buf[(0, 0)];
        assert_eq!(cell.symbol(), "\u{203A}");
        assert_eq!(cell.bg, surface, "no filled cell behind the prompt");
        assert_eq!(cell.fg, accent, "the glyph carries the focus colour");
        assert!(!cell.modifier.contains(Modifier::REVERSED));
        assert_eq!(buf[(1, 0)].bg, surface);
    }
}

#[test]
fn control_and_hidden_characters_draw_as_stand_ins_and_the_caret_walks_over_them() {
    let text = "a\u{7}\u{1b}\u{0}\u{202e}b";
    let mut r = rig(20, 6);
    r.text(text);
    assert_eq!(r.c.text(), text, "the text is what was put in");
    let dump = r.dump();
    assert_eq!(
        dump.lines().next().unwrap(),
        "\u{203A} a\u{2407}\u{241b}\u{2400}\u{25af}b",
        "{dump}"
    );
    // prompt 2, then one cell per character; a stand-in is muted.
    assert_eq!(r.c.caret(r.now).cell, Some((8, 0)));
    for step in (0..6).rev() {
        r.press(Key::Left);
        assert_eq!(r.c.caret(r.now).cell, Some((2 + step, 0)), "step {step}");
    }
    let buf = r.buffer();
    assert_ne!(
        buf[(3, 0)].style(),
        buf[(2, 0)].style(),
        "the stand-in is muted"
    );
    assert_eq!(r.c.text(), text);
}
