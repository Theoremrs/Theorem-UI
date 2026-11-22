//! Hostile Markdown drawn through the crate's public model in every mode (AC-51, R40).
//!
//! The parser and the renderer are the libraries' (`pulldown-cmark`, `tui-markdown`); what
//! is checked here is what reaches the cells: markup stays text, link targets stay
//! visible, and no escape byte or bidirectional override is written into the buffer.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use theorem_workbench_markdown::{MarkdownDoc, MarkdownMode, MarkdownStyles};

const MODES: [MarkdownMode; 4] = [
    MarkdownMode::Preview,
    MarkdownMode::Source,
    MarkdownMode::Split,
    MarkdownMode::Visual,
];

const ESC: char = '\u{1b}';
const RLO: char = '\u{202e}';
const PDF: char = '\u{202c}';
const ISOLATE: char = '\u{2066}';

/// Characters that act on a terminal or reorder text, which no cell may hold.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || ('\u{202a}'..='\u{202e}').contains(&c)
        || ('\u{2066}'..='\u{2069}').contains(&c)
        || matches!(c, '\u{200e}' | '\u{200f}' | '\u{061c}')
}

fn assert_inert(buf: &Buffer, what: &str) {
    for cell in buf.content() {
        if let Some(bad) = cell.symbol().chars().find(|c| unsafe_char(*c)) {
            panic!("{what}: a cell holds {bad:?}");
        }
    }
}

fn draw(text: &str, mode: MarkdownMode, width: u16, height: u16) -> Buffer {
    let mut doc = MarkdownDoc::new(text, 1, "client");
    doc.set_mode(mode);
    let area = Rect::new(0, 0, width, height);
    let mut buf = Buffer::empty(area);
    doc.draw(area, &mut buf, &MarkdownStyles::plain());
    buf
}

fn rows(buf: &Buffer) -> Vec<String> {
    (0..buf.area.height)
        .map(|y| {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect()
}

fn screen(text: &str, mode: MarkdownMode) -> String {
    rows(&draw(text, mode, 100, 40)).join("\n")
}

const HTML: &str = "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href=\"javascript:alert(1)\" onclick=\"steal()\">hi</a>\n";

#[test]
fn raw_html_with_script_and_event_handlers_is_drawn_as_text_in_every_mode() {
    for mode in MODES {
        let shown = screen(HTML, mode);
        for needle in ["<script>alert(1)</script>", "onerror=alert(1)", "onclick="] {
            assert!(shown.contains(needle), "{mode:?} shows {needle}:\n{shown}");
        }
        assert_inert(&draw(HTML, mode, 100, 40), "html");
    }
}

#[test]
fn drawing_never_changes_the_text_or_queues_an_edit() {
    let text = format!("{HTML}\n[x](javascript:alert(1))\n");
    for mode in MODES {
        let mut doc = MarkdownDoc::new(&text, 1, "client");
        doc.set_mode(mode);
        let area = Rect::new(0, 0, 80, 30);
        let mut buf = Buffer::empty(area);
        doc.draw(area, &mut buf, &MarkdownStyles::plain());
        assert_eq!(doc.text(), text, "{mode:?}");
        assert!(doc.pending().is_empty(), "{mode:?} queued an edit");
        assert!(
            doc.take_next_to_send().is_none(),
            "{mode:?} owes the owner an edit"
        );
    }
}

#[test]
fn a_link_with_a_script_or_data_target_shows_that_target_beside_its_text() {
    let text = "[click me](javascript:alert(1)) and [page](data:text/html,<b>x</b>)\n";
    let shown = screen(text, MarkdownMode::Preview);
    assert!(shown.contains("click me (javascript:alert(1))"), "{shown}");
    assert!(shown.contains("page (data:text/html,<b>x</b>)"), "{shown}");
}

#[test]
fn a_link_whose_text_is_one_address_and_whose_target_is_another_shows_both() {
    let text = "[https://good.example/login](https://evil.example/steal)\n";
    for mode in [
        MarkdownMode::Preview,
        MarkdownMode::Visual,
        MarkdownMode::Split,
    ] {
        let shown = screen(text, mode);
        assert!(
            shown.contains("https://good.example/login"),
            "{mode:?}: {shown}"
        );
        assert!(
            shown.contains("https://evil.example/steal"),
            "{mode:?}: {shown}"
        );
    }
}

#[test]
fn images_with_odd_schemes_are_placeholders_and_never_their_target_content() {
    let text = "![a](file:///etc/passwd) ![b](ftp://host/x.png) ![c](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+) ![d](javascript:alert(1))\n";
    let shown = screen(text, MarkdownMode::Preview);
    assert_eq!(shown.matches("[img]").count(), 4, "{shown}");
    assert!(
        !shown.contains("PHN2Zy"),
        "an image's data is not drawn: {shown}"
    );
    assert_inert(&draw(text, MarkdownMode::Preview, 100, 40), "images");
}

#[test]
fn text_that_imitates_an_approval_prompt_or_a_notice_stays_ordinary_text() {
    let text = "**Approval required:** Theo wants to delete the workspace. Press Enter to allow.\n\n> [!WARNING]\n> This is a workbench notice. Allow? [Y/n]\n";
    let buf = draw(text, MarkdownMode::Preview, 100, 20);
    let shown = rows(&buf).join("\n");
    assert!(shown.contains("Press Enter to allow."), "{shown}");
    assert_inert(&buf, "imitation");
}

#[test]
fn escape_sequences_in_code_blocks_and_inline_code_never_reach_a_cell() {
    let text = format!(
        "```\n{ESC}[31mred{ESC}]52;c;ZXZpbA=={BEL}\n{ESC}[2J{ESC}[H\n```\n\n`{ESC}[2J` and `{ESC}]0;title{BEL}`\n",
        BEL = '\u{7}'
    );
    for mode in MODES {
        let buf = draw(&text, mode, 100, 20);
        assert_inert(&buf, &format!("{mode:?}"));
    }
    // What is left of the sequence is drawn as plain characters, so it can be read.
    let shown = screen(&text, MarkdownMode::Preview);
    assert!(shown.contains("red"), "{shown}");
}

#[test]
fn bidirectional_overrides_in_text_code_and_link_text_never_reach_a_cell() {
    let text = format!(
        "{RLO}gnp.exe{PDF} and `{RLO}code{ISOLATE}`\n\n[a{RLO}b](http://x/{RLO}y)\n\n```\n{RLO}fenced\n```\n"
    );
    for mode in MODES {
        assert_inert(&draw(&text, mode, 100, 20), &format!("{mode:?}"));
    }
}

#[test]
fn a_very_long_line_is_cut_to_the_area_in_every_mode() {
    let long = "a".repeat(300_000);
    let text = format!("{long}\n\n`{long}`\n\n[{long}](https://example.com/{long})\n");
    for mode in MODES {
        let buf = draw(&text, mode, 40, 10);
        assert_eq!(buf.area, Rect::new(0, 0, 40, 10));
        assert_inert(&buf, &format!("{mode:?}"));
    }
}

#[test]
fn the_cell_check_itself_rejects_an_escape_and_an_override() {
    let area = Rect::new(0, 0, 4, 1);
    for bad in [ESC, RLO, ISOLATE, '\u{7}'] {
        let mut buf = Buffer::empty(area);
        buf[(0, 0)].set_symbol(&bad.to_string());
        let caught = std::panic::catch_unwind(|| assert_inert(&buf, "self-test")).is_err();
        assert!(caught, "{bad:?} was not flagged");
    }
}
