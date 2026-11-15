mod common;

use common::*;
use keybinds::Key;
use theorem_workbench_composer::{ComposerStatus, Policy};
use theorem_workbench_core::DraftAttachmentState::{Adding, Ready};
use theorem_workbench_core::ModelChoice;
use theorem_workbench_core::semantics::{Node, Role};

fn find<'a>(nodes: &'a [Node], id: &str) -> &'a Node {
    nodes
        .iter()
        .find(|n| n.id.as_str() == id)
        .unwrap_or_else(|| panic!("no {id}: {nodes:#?}"))
}

#[test]
fn one_textbox_with_value_caret_selection_and_focus() {
    let mut r = rig(60, 6);
    r.type_str("hello world");
    r.key(Key::Left, shift());
    r.key(Key::Left, shift());
    let nodes = r.c.semantics(r.area);
    let boxes: Vec<_> = nodes.iter().filter(|n| n.role == Role::TextBox).collect();
    assert_eq!(boxes.len(), 1);
    let t = boxes[0];
    assert_eq!(t.id.as_str(), "composer:text");
    assert_eq!(t.text.as_deref(), Some("hello world"));
    assert!(t.state.focused);
    let d = t.state.description.as_deref().unwrap();
    assert!(d.contains("caret at character 9"), "{d}");
    assert!(d.contains("characters 9 to 11 selected"), "{d}");
}

#[test]
fn the_placeholder_is_the_description_while_empty() {
    let mut r = rig(60, 6);
    r.c.set_placeholder("Ask Theo anything");
    let nodes = r.c.semantics(r.area);
    let t = find(&nodes, "composer:text");
    assert_eq!(t.state.description.as_deref(), Some("Ask Theo anything"));
    assert_eq!(t.text.as_deref(), Some(""));
    assert!(r.dump().contains("Ask Theo anything"));
    r.c.set_focused(false);
    assert!(!find(&r.c.semantics(r.area), "composer:text").state.focused);
}

#[test]
fn one_node_per_chip_with_name_and_state() {
    let mut r = rig(80, 6);
    r.c.set_attachments(vec![
        attachment("a", "n.md", Ready),
        attachment("b", "p.png", Adding),
    ]);
    r.press(Key::Up);
    let nodes = r.c.semantics(r.area);
    let a = find(&nodes, "composer:chip:a");
    assert_eq!(
        (a.name.as_str(), a.state.description.as_deref()),
        ("n.md", Some("ready"))
    );
    assert!(a.state.selected);
    let b = find(&nodes, "composer:chip:b");
    assert!(b.state.busy);
    assert_eq!((b.pos_in_set, b.set_size), (Some(2), Some(2)));
    assert!(
        !find(&nodes, "composer:text").state.focused,
        "the keyboard is on a chip"
    );
}

#[test]
fn the_popup_is_a_menu_with_its_options_and_the_active_one() {
    let mut r = rig(60, 8);
    r.press(Key::Char('@'));
    let t = r.now;
    let _ = t;
    r.c.files_found(1, vec!["a.rs".into(), "b.rs".into()]);
    r.press(Key::Down);
    let nodes = r.c.semantics(r.area);
    let menu = find(&nodes, "composer:popup");
    assert_eq!(menu.role, Role::Menu);
    assert_eq!(menu.children.len(), 2);
    assert!(!find(&nodes, "composer:popup:0").state.selected);
    assert!(find(&nodes, "composer:popup:1").state.selected);
    assert_eq!(find(&nodes, "composer:popup:1").name, "b.rs");
    r.c.open_models(
        vec![ModelChoice {
            model_ref: "m".into(),
            label: "Model".into(),
            context_tokens: None,
        }],
        0,
    );
    assert_eq!(
        find(&r.c.semantics(r.area), "composer:popup").name,
        "Models"
    );
}

#[test]
fn the_footer_is_a_status_node() {
    let mut r = rig(80, 4);
    r.c.set_status(ComposerStatus {
        policy: Policy::Running { can_steer: true },
        model: Some("M".into()),
        effort: None,
        context_percent: None,
    });
    let nodes = r.c.semantics(r.area);
    let f = find(&nodes, "composer:footer");
    assert_eq!(f.role, Role::Status);
    assert!(f.name.contains("Enter steers the run, Esc stops"));
    assert!(f.name.contains('M'));
}

#[test]
fn the_tree_is_valid_and_the_draft_text_is_exposed_once() {
    let mut r = rig(80, 6);
    r.c.set_attachments(vec![attachment("a", "n.md", Ready)]);
    r.type_str("distinctive draft words");
    let nodes = r.c.semantics(r.area);
    let tree = theorem_workbench_core::semantics::SemanticTree {
        root: nodes[0].id.clone(),
        nodes: nodes.clone(),
    };
    assert_eq!(tree.validate(), Ok(()));
    let exposing = nodes
        .iter()
        .filter(|n| {
            n.text.as_deref().is_some_and(|t| t.contains("distinctive"))
                || n.name.contains("distinctive")
                || n.state
                    .description
                    .as_deref()
                    .is_some_and(|d| d.contains("distinctive"))
        })
        .count();
    assert_eq!(
        exposing, 1,
        "the cells and the nodes never both expose the text as controls"
    );
}

#[test]
fn ids_sit_under_the_panels_prefix() {
    let mut c = theorem_workbench_composer::Composer::new("theo:main:composer");
    let area = ratatui::layout::Rect::new(0, 0, 40, 4);
    c.resize(area);
    let nodes = c.semantics(area);
    assert!(
        nodes
            .iter()
            .all(|n| n.id.as_str().starts_with("theo:main:composer"))
    );
    assert_eq!(nodes[0].id.as_str(), "theo:main:composer");
}

// ---- the caret the text node publishes (selection in UTF-16 units of the node's text) ----

fn text_node(r: &Rig) -> Node {
    let nodes = r.c.semantics(r.area);
    let tree = theorem_workbench_core::semantics::SemanticTree {
        root: nodes[0].id.clone(),
        nodes: nodes.clone(),
    };
    assert_eq!(tree.validate(), Ok(()), "the tree passes its own check");
    find(&nodes, "composer:text").clone()
}

fn caret(n: &Node) -> (u32, u32) {
    let s = n.selection.expect("a text box publishes its selection");
    (s.anchor, s.focus)
}

#[test]
fn the_text_node_publishes_the_caret_and_the_selection() {
    let mut r = rig(60, 6);
    r.type_str("hello world");
    assert_eq!(caret(&text_node(&r)), (11, 11));
    r.key(Key::Left, shift());
    r.key(Key::Left, shift());
    assert_eq!(
        caret(&text_node(&r)),
        (11, 9),
        "anchor where it began, focus the caret"
    );
    r.press(Key::Home);
    assert_eq!(caret(&text_node(&r)), (0, 0));
}

#[test]
fn offsets_count_utf16_units_for_multibyte_astral_and_combining_text() {
    let mut r = rig(60, 6);
    // 'a', U+1F600 (2 units), 'e' + U+0301 (2 units, one grapheme), U+65E5 (1 unit).
    r.type_str("a\u{1F600}e\u{301}\u{65e5}");
    let n = text_node(&r);
    assert_eq!(n.text.as_deref(), Some("a\u{1F600}e\u{301}\u{65e5}"));
    assert_eq!(caret(&n), (6, 6));
    r.press(Key::Left);
    assert_eq!(
        caret(&text_node(&r)),
        (5, 5),
        "the caret steps over the one character"
    );
    r.press(Key::Left);
    // The caret moves a grapheme: past 'e' and its mark together.
    assert_eq!(caret(&text_node(&r)), (3, 3));
    r.press(Key::Left);
    assert_eq!(
        caret(&text_node(&r)),
        (1, 1),
        "past the astral character in one step"
    );
}

#[test]
fn offsets_are_into_the_escaped_text_when_the_draft_holds_control_characters() {
    let mut r = rig(60, 6);
    r.paste("x\u{1b}[2J\u{202e}y");
    let n = text_node(&r);
    let text = n.text.as_deref().unwrap();
    assert!(
        !text.contains('\u{1b}') && !text.contains('\u{202e}'),
        "{text:?}"
    );
    assert!(
        text.contains("\\u{1b}") && text.contains("\\u{202e}"),
        "{text:?}"
    );
    assert_eq!(
        caret(&n).1 as usize,
        text.encode_utf16().count(),
        "the caret at the end"
    );
    r.press(Key::Home);
    assert_eq!(caret(&text_node(&r)), (0, 0));
    r.press(Key::Right);
    r.press(Key::Right);
    // After 'x' and the escape character: 1 + the six units of `\u{1b}`.
    assert_eq!(caret(&text_node(&r)).1, 7);
}

#[test]
fn a_large_draft_publishes_a_bounded_window_around_the_caret_and_says_so() {
    let mut r = rig(60, 6);
    let draft: String = (0..4000)
        .map(|i| format!("line {i:04} \u{1F600}\n"))
        .collect();
    r.paste(&draft);
    let n = text_node(&r);
    let text = n.text.as_deref().unwrap();
    assert!(text.len() <= theorem_workbench_core::semantics::MAX_NODE_TEXT);
    assert!(text.len() < draft.len());
    let d = n.state.description.as_deref().unwrap();
    assert!(d.contains("holds only lines"), "{d}");
    // The caret is at the end of the draft: inside the window, after its last line break.
    assert_eq!(caret(&n).1 as usize, text.encode_utf16().count());
}

#[test]
fn a_refusal_in_the_footer_is_an_alert_and_a_hint_is_a_status() {
    let mut r = rig(60, 4);
    assert_eq!(
        find(&r.c.semantics(r.area), "composer:footer").role,
        Role::Status
    );
    r.type_str("keep me");
    r.key(Key::Char('a'), ctrl_or_cmd());
    r.key(Key::Char('x'), ctrl_or_cmd());
    r.c.cut_finished(false);
    assert_eq!(r.c.notice(), Some("Not cut"));
    let nodes = r.c.semantics(r.area);
    let f = find(&nodes, "composer:footer");
    assert_eq!(f.role, Role::Alert);
    assert!(f.name.contains("Not cut"));
    // The next input clears the notice and the footer is a status again.
    r.press(Key::Right);
    assert_eq!(
        find(&r.c.semantics(r.area), "composer:footer").role,
        Role::Status
    );
}

fn ctrl_or_cmd() -> keybinds::Mods {
    keybinds::Mods::CMD
}

#[test]
fn each_popup_item_has_the_row_it_is_drawn_on_and_a_scrolled_out_one_has_no_height() {
    let mut r = rig(60, 8);
    r.press(Key::Char('@'));
    r.c.files_found(1, (0..20).map(|i| format!("f{i}.rs")).collect());
    for _ in 0..15 {
        r.press(Key::Down);
    }
    let nodes = r.c.semantics(r.area);
    let menu = find(&nodes, "composer:popup")
        .rect
        .expect("the menu is drawn");
    let sel = find(&nodes, "composer:popup:15");
    assert!(sel.state.selected);
    let at = sel.rect.expect("the chosen item is on screen");
    assert_eq!(at.height, 1, "the chosen item is on screen");
    assert!(at.y >= menu.y && at.y < menu.y + menu.height);
    assert_eq!(
        find(&nodes, "composer:popup:0").rect,
        None,
        "scrolled out: in the tree, with no rect"
    );
    let drawn: Vec<u16> = nodes
        .iter()
        .filter(|n| n.id.as_str().starts_with("composer:popup:"))
        .filter_map(|n| n.rect.map(|r| r.y))
        .collect();
    let mut unique = drawn.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), drawn.len(), "no two items on one row");
    assert_eq!(drawn.len(), usize::from(menu.height));
}
