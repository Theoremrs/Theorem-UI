// Donor: ELY-Open-Source/Ely-GPUI-Components @ 078bf26f2d039b3877aef577e37bbd0a1de182bf
// Path: crates/ely-documents/src/document/tests/format.rs
// Blob: c4985478b8b66bd0745c2079f3d755d2972f417c
// License: MIT, Copyright (c) 2026 Ely GPUI Component contributors (LICENSE-ELY)
// MODIFIED: tests that drove the GPUI `MarkdownDocument` entity (open, press, text) are not carried, and the imports and helpers they used are dropped; every pure command test is unchanged.
//! Inline formats toggle as Typora's (R4.6).

use crate::markdown::mdast::Node;

use crate::clock::spent;
use crate::document::format::{toggle, toggle_tree};
use crate::markdown::file_tree;
use crate::{EditRefusal, InlineFormat};

/// `marked` toggled: `‸` is the caret, `⟨…⟩` the selection.
fn toggled(marked: &str, format: InlineFormat) -> Result<String, EditRefusal> {
    let caret = marked.find('‸');
    let text: String = marked.chars().filter(|ch| !"‸⟨⟩".contains(*ch)).collect();
    let selection = match caret {
        Some(at) => at..at,
        None => {
            let start = marked.find('⟨').expect("a selection");
            start..marked.find('⟩').expect("its end") - '⟨'.len_utf8()
        }
    };
    let (edits, selected) = toggle(&text, selection, format)?;
    let mut out = text.clone();
    for (range, with) in edits.into_iter().rev() {
        out.replace_range(range, &with);
    }
    Ok(match selected.is_empty() {
        true => format!("{}‸{}", &out[..selected.start], &out[selected.start..]),
        false => format!(
            "{}⟨{}⟩{}",
            &out[..selected.start],
            &out[selected.clone()],
            &out[selected.end..]
        ),
    })
}

fn ok(marked: &str, format: InlineFormat) -> String {
    toggled(marked, format).expect("toggled")
}

#[test]
fn a_selection_wraps_and_a_styled_one_unwraps() {
    use InlineFormat::*;
    assert_eq!(ok("a ⟨bold⟩ z", Strong), "a **⟨bold⟩** z");
    assert_eq!(
        ok("a ⟨word ⟩z", Strong),
        "a **⟨word⟩** z",
        "end space stays out"
    );
    assert_eq!(ok("a **⟨bold⟩** z", Strong), "a ⟨bold⟩ z");
    assert_eq!(ok("⟨a⟩", Emphasis), "*⟨a⟩*");
    assert_eq!(ok("⟨a⟩", Strike), "~~⟨a⟩~~");
    assert_eq!(ok("⟨a⟩", Underline), "<u>⟨a⟩</u>");
    assert_eq!(ok("x ⟨a`b⟩ y", Code), "x ``⟨a`b⟩`` y");
    assert_eq!(ok("⟨site⟩", Link), "[site](‸)");
    assert_eq!(ok("⟨cat⟩", Image), "![cat](‸)");
}

#[test]
fn a_caret_takes_its_word_or_an_empty_pair() {
    use InlineFormat::*;
    assert_eq!(ok("a wo‸rd z", Strong), "a **⟨word⟩** z");
    assert_eq!(ok("a ‸ z", Strong), "a **‸** z");
    assert_eq!(ok("a\n\n‸", Emphasis), "a\n\n*‸*", "a blank line");
    assert_eq!(ok("a ‸ z", Link), "a [‸]() z");
    assert_eq!(
        ok("x　wo‸rd", Strong),
        "x　**⟨word⟩**",
        "a wide space stops it"
    );
}

#[test]
fn a_caret_in_a_style_takes_it_off() {
    use InlineFormat::*;
    assert_eq!(ok("a **b‸old** z", Strong), "a b‸old z");
    assert_eq!(ok("~~a‸~~", Strike), "a‸");
    assert_eq!(ok("x `co‸de` y", Code), "x co‸de y");
    assert_eq!(ok("<u>a‸b</u>", Underline), "a‸b");
    assert_eq!(ok("[si‸te](https://x)", Link), "si‸te");
    assert_eq!(ok("![c‸at](x.png)", Image), "c‸at");
}

#[test]
fn a_partly_bold_selection_takes_the_bold_in() {
    assert_eq!(ok("a **b** ⟨c⟩", InlineFormat::Strong), "a **b** **⟨c⟩**");
    assert_eq!(ok("a **⟨b** c⟩", InlineFormat::Strong), "a **⟨b c⟩**");
}

#[test]
fn clear_takes_every_mark_off_the_touched_blocks() {
    let cleared = ok(
        "**a** ‸`b` [c](u) <u>d</u> ![e](f.png)",
        InlineFormat::Clear,
    );
    assert_eq!(cleared, "a ‸b c d e");
    assert_eq!(ok("**a‸**\n\n*b*", InlineFormat::Clear), "a‸\n\n*b*");
    assert_eq!(ok("⟨**a**\n\n*b*⟩", InlineFormat::Clear), "⟨a\n\nb⟩");
}

#[test]
fn code_math_html_and_front_matter_refuse() {
    use EditRefusal as Why;
    use InlineFormat::*;
    assert_eq!(toggled("```\nco‸de\n```", Strong), Err(Why::Code));
    assert_eq!(toggled("x `co‸de` y", Strong), Err(Why::Code));
    assert_eq!(toggled("$$\nx‸\n$$", Strong), Err(Why::Math));
    assert_eq!(toggled("a $x‸$ b", Emphasis), Err(Why::Math));
    assert_eq!(toggled("<div>\nx‸\n</div>", Strong), Err(Why::Html));
    assert_eq!(
        toggled("---\nti‸tle: a\n---\n\nbody", Strong),
        Err(Why::FrontMatter)
    );
    assert_eq!(toggled("```\nco‸de\n```", Clear), Err(Why::Code));
}

#[test]
fn a_selection_across_a_link_or_into_its_address_refuses() {
    use InlineFormat::*;
    assert_eq!(toggled("[a ⟨b](u) c⟩", Strong), Err(EditRefusal::Across));
    assert_eq!(toggled("[a](ht‸tp://x)", Strong), Err(EditRefusal::Across));
    assert_eq!(toggled("a\n\n> ‸", Strong), Err(EditRefusal::Outside));
}

#[test]
fn an_end_in_marks_or_an_address_refuses() {
    use InlineFormat::*;
    let across = Err(EditRefusal::Across);
    assert_eq!(toggled("a *‸*bold** z", Strong), across);
    assert_eq!(toggled("[a](ht‸tps://example.com)", Link), across);
    assert_eq!(toggled("a *⟨*b** c⟩", Strong), across);
    assert_eq!(toggled("*a⟨b*⟩", Strong), across);
    assert_eq!(toggled("⟨alpha\n\nbeta⟩", Link), across);
}

#[test]
fn a_format_across_blocks_runs_in_each_as_one_toggle() {
    use InlineFormat::*;
    assert_eq!(ok("⟨alpha\n\nbeta⟩", Strong), "⟨**alpha**\n\n**beta**⟩");
    assert_eq!(
        ok("⟨**alpha**\n\n**beta**⟩", Strong),
        "⟨alpha\n\nbeta⟩",
        "all styled unwrap"
    );
    assert_eq!(
        ok("⟨**alpha**\n\nbeta⟩", Strong),
        "⟨**alpha**\n\n**beta**⟩",
        "the unstyled gain it"
    );
    assert_eq!(ok("al⟨pha\n\n# be⟩ta", Emphasis), "al⟨*pha*\n\n# *be*⟩ta");
    assert_eq!(ok("- ⟨a\n- b⟩", Strike), "- ⟨~~a~~\n- ~~b~~⟩");
    assert_eq!(
        ok("⟨a\n\n```\ncode\n```\n\nb⟩", Code),
        "⟨`a`\n\n```\ncode\n```\n\n`b`⟩",
        "code between is left"
    );
    assert_eq!(ok("⟨a\n\nb⟩", Underline), "⟨<u>a</u>\n\n<u>b</u>⟩");
    assert_eq!(
        ok("⟨<u>a</u>\n\nb⟩", Underline),
        "⟨<u>a</u>\n\n<u>b</u>⟩",
        "an underlined block is left"
    );
    assert_eq!(ok("⟨<u>a</u>\n\n<u>b</u>⟩", Underline), "⟨a\n\nb⟩");
    assert_eq!(
        ok("<u>al⟨pha</u>\n\nbeta⟩", Underline),
        "<u>al⟨pha</u>\n\n<u>beta</u>⟩",
        "begun inside an underline"
    );
    assert_eq!(
        ok("⟨alpha\n\n<u>be⟩ta</u>", Underline),
        "⟨<u>alpha</u>\n\n<u>be⟩ta</u>",
        "ended inside an underline"
    );
    assert_eq!(
        ok("<u>al⟨pha</u>\n\n<u>be⟩ta</u>", Underline),
        "⟨alpha\n\nbeta⟩"
    );
    assert_eq!(ok("**al⟨pha**\n\nbeta⟩", Strong), "**al⟨pha**\n\n**beta**⟩");
    for format in [Strong, Emphasis, Strike, Underline, Code] {
        let twice = ok(&ok("⟨alpha\n\n# beta⟩", format), format);
        assert_eq!(twice, "⟨alpha\n\n# beta⟩", "{format:?} twice");
    }
}

#[test]
fn end_spaces_cells_and_cr_lines_take_a_pair() {
    use InlineFormat::*;
    assert_eq!(ok("alpha ‸", Strong), "alpha **‸**");
    assert_eq!(ok("| h |\n| - |\n| ‸ |", Strong), "| h |\n| - |\n| **‸** |");
    assert_eq!(ok("a\r‸\rb", Strong), "a\r**‸**\rb");
}

#[test]
fn clear_takes_math_footnote_and_escape_marks() {
    use InlineFormat::Clear;
    assert_eq!(ok("**a** $x‸+y$", Clear), "a x‸+y");
    assert_eq!(ok("a‸ [^n]\n\n[^n]: note", Clear), "a‸ n\n\n[^n]: note");
    assert_eq!(ok(r"a‸ \*b\*", Clear), "a‸ *b*");
}

#[test]
fn underline_comes_off_past_other_tags() {
    use InlineFormat::Underline;
    assert_eq!(ok("<u>a <br>b‸c</u>", Underline), "a <br>b‸c");
    assert_eq!(ok("<u>a <em>b‸c</em> d</u>", Underline), "a <em>b‸c</em> d");
}

#[test]
fn an_unwrap_refuses_an_end_in_nested_marks() {
    use InlineFormat::*;
    let across = Err(EditRefusal::Across);
    assert_eq!(toggled("**[a](ht‸tps://x)**", Strong), across);
    assert_eq!(toggled("**~~a~‸~**", Strong), across);
    assert_eq!(toggled("<u>[a](ht‸tps://x)</u>", Underline), across);
    assert_eq!(toggled("**a *b⟨* c⟩**", Strong), across);
}

#[test]
fn clear_keeps_an_autolink_backslash() {
    assert_eq!(
        ok(r"a‸ <https://x/\*>", InlineFormat::Clear),
        r"a‸ https://x/\*"
    );
}

/// The walk past the parse, on `n` then `4n` repeats, the best of five rounds of thread time.
fn linear(unit: &str, run: impl Fn(&str, &Node)) {
    let texts = [unit.repeat(4000), unit.repeat(16000)];
    let roots = texts.each_ref().map(|text| file_tree(text));
    let mut best = [std::time::Duration::MAX; 2];
    for _ in 0..5 {
        for ((text, root), best) in texts.iter().zip(&roots).zip(&mut best) {
            *best = (*best).min(spent(|| run(text, root)));
        }
    }
    let [small, large] = best;
    assert!(large < small * 8, "{small:?} then {large:?}");
}

#[test]
fn many_paragraphs_format_in_linear_time() {
    linear("a\n\n", |text, root| {
        toggle_tree(text, root, 0..1, InlineFormat::Strong).expect("toggled");
    });
    linear("**a**\n\n", |text, root| {
        toggle_tree(text, root, 0..text.len(), InlineFormat::Clear).expect("cleared");
    });
    linear("a\n\n", |text, root| {
        toggle_tree(text, root, 0..text.len(), InlineFormat::Strong).expect("across");
    });
}
