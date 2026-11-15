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
