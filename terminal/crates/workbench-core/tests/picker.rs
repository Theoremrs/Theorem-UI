//! The tool picker through the public API: what it draws, what its keys and
//! pointer mean, what its semantic tree says, and that all of them read the
//! same registration (spec 5, AC-06, AC-07).

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use theorem_workbench_core::builtin;
use theorem_workbench_core::effect::Effect;
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::ids::{ActionId, Actor, PanelKind, ResourceKind};
use theorem_workbench_core::keys::{KeyContext, KeyTable, Overrides, Platform, Shortcut, Unbind};
use theorem_workbench_core::panel::PickerView;
use theorem_workbench_core::panels::PickerPanel;
use theorem_workbench_core::picker::{Picker, PickerMsg, PickerOutcome};
use theorem_workbench_core::picker_layout::Layout;
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent, Availability, BodyKind, Capabilities, CellSize, KeyScope,
    PanelDescriptor, Placement, Registry,
};
use theorem_workbench_core::semantics::{Node, Role, SemanticTree};
use theorem_workbench_core::{
    Button, Model, Msg, Panel, PanelFactories, Pointer, PointerKind, Theme, ViewCtx, semantics,
    update,
};
use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

const ALL: [&str; 18] = [
    "conversation.side",
    "conversation.attach",
    "conversation.model",
    "diagnostics.subscribe",
    "run.start",
    "run.subscribe",
    "search.query",
    "files",
    "documents",
    "scm",
    "language",
    "run",
    "search",
    "environment",
    "artifacts",
    "conversation",
    "terminal.native",
    "terminal.herdr",
];

fn extra_panel() -> PanelDescriptor {
    PanelDescriptor {
        kind: PanelKind::new("probe"),
        version: 1,
        title: "Probe".into(),
        icon: "x".into(),
        body: BodyKind::Drawn,
        binding: ResourceKind::None,
        actions: vec![
            ActionDescriptor::new("probe.open", "Probe", ActionIntent::Open)
                .requires("probing")
                .more()
                .key("Mod+Alt+J", KeyScope::Global),
        ],
        requires: vec![],
        min_size: CellSize { cols: 10, rows: 4 },
        default_placement: Placement::Tools,
        theme_roles: vec![],
        semantic_role: Role::Region,
    }
}

fn registry() -> Registry {
    let mut registry = builtin::registry();
    registry.register(extra_panel()).unwrap();
    registry
}

fn build_keys(registry: &Registry, overrides: &Overrides) -> KeyTable {
    let (keys, issues) = KeyTable::build(registry, Platform::Other, overrides);
    assert!(issues.is_empty(), "{issues:?}");
    keys
}

fn caps(extra: &[&'static str]) -> Capabilities {
    Capabilities::of(ALL.iter().copied().chain(extra.iter().copied()))
}

fn model(caps: Capabilities) -> Model {
    let registry = registry();
    let keys = build_keys(&registry, &Overrides::default());
    let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let mut m = Model::new(registry, PanelFactories::new(), keys, caps, dock);
    update(
        &mut m,
        Msg::Resize {
            area: Rect::new(0, 0, 200, 50),
            metrics: CellMetrics::new(8.0, 16.0),
        },
    );
    m
}

fn picker(m: &mut Model, msg: PickerMsg) -> Vec<Effect> {
    update(m, Msg::Picker(msg))
}

fn key(m: &mut Model, key: Key, mods: Mods) -> Vec<Effect> {
    update(m, Msg::Key(KeyInput::new(key, mods)))
}

fn action(m: &mut Model, id: &str) -> Vec<Effect> {
    update(
        m,
        Msg::Action {
            id: ActionId::new(id),
            actor: Actor::Human,
        },
    )
}

fn picker_nodes(tree: &SemanticTree) -> Vec<&Node> {
    tree.nodes
        .iter()
        .filter(|n| n.id.as_str().contains("/row-"))
        .collect()
}

fn titles(m: &Model) -> Vec<String> {
    let tree = semantics(m);
    picker_nodes(&tree).iter().map(|n| n.name.clone()).collect()
}

// ---- rendering --------------------------------------------------------

/// A standalone picker as the picker panel draws it in `area`'s size, over the
/// builtin registry with its default key bindings.
fn standalone(more: bool, filter: &str) -> PickerView {
    let registry = builtin::registry();
    let keys = build_keys(&registry, &Overrides::default());
    let caps = caps(&[]);
    let mut picker = Picker::default();
    picker.set_shortcuts(
        registry
            .panels()
            .iter()
            .flat_map(|p| &p.actions)
            .filter_map(|a| Some((a.id.clone(), keys.label(&a.id)?)))
            .collect(),
    );
    let pins = Default::default();
    picker.update(PickerMsg::Open, &registry, &caps, &pins);
    if more {
        picker.update(PickerMsg::Select(5), &registry, &caps, &pins);
        picker.update(PickerMsg::Choose, &registry, &caps, &pins);
    }
    if !filter.is_empty() {
        picker.update(PickerMsg::Filter(filter.into()), &registry, &caps, &pins);
    }
    picker.view(&registry, &caps, &pins)
}

fn render(view: &PickerView, width: u16, height: u16) -> String {
    let area = Rect::new(0, 0, width, height);
    let mut buf = Buffer::empty(area);
    let theme = Theme::plain();
    let workspace = Default::default();
    let mut cx = ViewCtx::new(&theme, &workspace);
    cx.picker = Some(view);
    PickerPanel.view(area, &mut buf, &cx);
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buf[(x, y)].symbol().to_owned())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn lines(text: &[&str]) -> String {
    text.join("\n")
}

#[test]
fn the_main_page_renders_at_three_widths() {
    let view = standalone(false, "");
    assert_eq!(
        render(&view, 96, 14),
        lines(&[
            "Tools",
            ">",
            " \u{b1} Changes                          Ctrl+Alt+G    \u{203a} Shell  starts a process          Ctrl+Alt+S",
            "",
            " \u{25a1} Files                            Ctrl+Alt+E    \u{2295} Side chat                        Ctrl+Alt+L",
            "",
            " \u{2261} New page  creates a document     Ctrl+Alt+N    \u{25a6} More tools",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
        ])
    );
    assert_eq!(
        render(&view, 60, 14),
        lines(&[
            "Tools",
            ">",
            " \u{b1} Changes                                       Ctrl+Alt+G",
            "",
            " \u{203a} Shell  starts a process                       Ctrl+Alt+S",
            "",
            " \u{25a1} Files                                         Ctrl+Alt+E",
            "",
            " \u{2295} Side chat                                     Ctrl+Alt+L",
            "",
            " \u{2261} New page  creates a document                  Ctrl+Alt+N",
            "",
            " \u{25a6} More tools",
            "",
        ])
    );
    assert_eq!(
        render(&view, 28, 14),
        lines(&[
            "Tools",
            ">",
            " \u{b1} Changes       Ctrl+Alt+G",
            "",
            " \u{203a} Shell         Ctrl+Alt+S",
            "",
            " \u{25a1} Files         Ctrl+Alt+E",
            "",
            " \u{2295} Side chat     Ctrl+Alt+L",
            "",
            " \u{2261} New page      Ctrl+Alt+N",
            "",
            " \u{25a6} More tools",
            "",
        ])
    );
    // Without the height for the blank lines the rows sit together.
    assert_eq!(
        render(&view, 28, 8),
        lines(&[
            "Tools",
            ">",
            " \u{b1} Changes       Ctrl+Alt+G",
            " \u{203a} Shell         Ctrl+Alt+S",
            " \u{25a1} Files         Ctrl+Alt+E",
            " \u{2295} Side chat     Ctrl+Alt+L",
            " \u{2261} New page      Ctrl+Alt+N",
            " \u{25a6} More tools",
        ])
    );
}

#[test]
fn the_more_tools_page_renders_at_three_widths() {
    let view = standalone(true, "");
    assert_eq!(
        render(&view, 96, 14),
        lines(&[
            "More tools",
            " \u{2039} Back",
            ">",
            " Artifacts                                    \u{25cb}   Diagnostics                                  \u{25cb}",
            "",
            " Run output                                   \u{25cb}   Search                                       \u{25cb}",
            "",
            " History                                      \u{25cb}   Threads                          Ctrl+Alt+H  \u{25cb}",
            "",
            " Layouts                          Ctrl+Alt+W  \u{25cb}",
            "",
            "",
            "",
            "",
        ])
    );
    assert_eq!(
        render(&view, 60, 14),
        lines(&[
            "More tools",
            " \u{2039} Back",
            ">",
            " Artifacts                  \u{25cb}   Diagnostics                \u{25cb}",
            "",
            " Run output                 \u{25cb}   Search                     \u{25cb}",
            "",
            " History                    \u{25cb}   Threads        Ctrl+Alt+H  \u{25cb}",
            "",
            " Layouts        Ctrl+Alt+W  \u{25cb}",
            "",
            "",
            "",
            "",
        ])
    );
    assert_eq!(
        render(&view, 28, 14),
        lines(&[
            "More tools",
            " \u{2039} Back",
            ">",
            " Artifacts                 \u{25cb}",
            " Diagnostics               \u{25cb}",
            " Run output                \u{25cb}",
            " Search                    \u{25cb}",
            " History                   \u{25cb}",
            " Threads       Ctrl+Alt+H  \u{25cb}",
            " Layouts       Ctrl+Alt+W  \u{25cb}",
            "",
            "",
            "",
            "",
        ])
    );
}

// ---- layout, drawing and semantics read one answer ----------------------

#[test]
fn semantic_rects_are_the_drawn_rects_at_every_width() {
    for more in [false, true] {
        for width in [96, 86, 85, 60, 28, 12, 5] {
            let view = standalone(more, "");
            let area = Rect::new(3, 2, width, 14);
            let layout = Layout::compute(&view, area);
            let theme = Theme::plain();
            let workspace = Default::default();
            let mut cx = ViewCtx::new(&theme, &workspace);
            cx.picker = Some(&view);
            let nodes = PickerPanel.semantics(area, &cx);
            let rect = |id: &str| {
                let n = nodes.iter().find(|n| n.id.as_str() == id).unwrap();
                let r = n.rect.expect("a drawn node has a rect");
                Rect::new(r.x, r.y, r.width, r.height)
            };
            assert_eq!(rect("heading"), layout.heading);
            assert_eq!(rect("filter"), layout.filter);
            if let Some(back) = layout.back {
                assert_eq!(rect("back"), back);
            }
            // The glyph column is part of what a row needs, so two columns
            // take 92 cells on the main page.
            if !more {
                assert_eq!(layout.columns, if width >= 92 { 2 } else { 1 }, "{width}");
            }
            for cell in &layout.cells {
                assert_eq!(rect(&format!("row-{}", cell.index)), cell.rect, "{width}");
            }
            // A row with no cell is not drawn and has no height.
            let rows = nodes.iter().filter(|n| n.role == Role::MenuItem).count();
            assert_eq!(rows, view.rows.len());
        }
    }
}

#[test]
fn rows_carry_position_selection_shortcut_qualifier_and_actions() {
    let view = standalone(false, "");
    let area = Rect::new(0, 0, 96, 14);
    let theme = Theme::plain();
    let workspace = Default::default();
    let mut cx = ViewCtx::new(&theme, &workspace);
    cx.picker = Some(&view);
    let nodes = PickerPanel.semantics(area, &cx);
    let menu = &nodes[0];
    assert_eq!((menu.role, menu.name.as_str()), (Role::Menu, "Tools"));
    let rows: Vec<&Node> = nodes.iter().filter(|n| n.role == Role::MenuItem).collect();
    assert_eq!(rows.len(), 6);
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row.pos_in_set, Some(i as u16 + 1));
        assert_eq!(row.set_size, Some(6));
        assert_eq!(row.state.selected, i == 0);
        assert_eq!(row.actions.len(), 1);
    }
    assert_eq!(rows[1].name, "Shell");
    assert_eq!(rows[1].shortcut.as_deref(), Some("Ctrl+Alt+S"));
    assert_eq!(
        rows[1].state.description.as_deref(),
        Some("starts a process")
    );
    assert_eq!(rows[3].shortcut.as_deref(), Some("Ctrl+Alt+L"));
    assert_eq!(rows[3].state.description, None);
    assert_eq!(rows[5].shortcut, None, "no binding, no hint");
    assert_eq!(
        rows[4].state.description.as_deref(),
        Some("creates a document")
    );
}

#[test]
fn the_semantic_order_is_the_reading_order_and_each_row_sits_where_it_reads() {
    let view = standalone(false, "");
    let area = Rect::new(0, 0, 96, 14);
    let theme = Theme::plain();
    let workspace = Default::default();
    let mut cx = ViewCtx::new(&theme, &workspace);
    cx.picker = Some(&view);
    let nodes = PickerPanel.semantics(area, &cx);
    let rows: Vec<&Node> = nodes.iter().filter(|n| n.role == Role::MenuItem).collect();
    assert_eq!(
        rows.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
        [
            "Changes",
            "Shell",
            "Files",
            "Side chat",
            "New page",
            "More tools"
        ]
    );
    assert_eq!(
        rows[0].rect.unwrap().y,
        rows[1].rect.unwrap().y,
        "Changes and Shell share a line"
    );
    assert!(rows[1].rect.unwrap().x > rows[0].rect.unwrap().x);
    assert!(rows[2].rect.unwrap().y > rows[0].rect.unwrap().y);
    assert_eq!(rows[2].rect.unwrap().x, rows[0].rect.unwrap().x);
    assert_eq!(
        rows.iter().map(|n| n.pos_in_set).collect::<Vec<_>>(),
        (1..=6).map(Some).collect::<Vec<_>>()
    );
}

#[test]
fn a_click_on_the_right_column_chooses_the_row_that_reads_there() {
    let view = standalone(false, "");
    let layout = Layout::compute(&view, Rect::new(0, 0, 96, 14));
    for (index, title) in [(1, "Shell"), (3, "Side chat"), (5, "More tools")] {
        let cell = layout.cell(index).unwrap();
        assert_eq!(view.rows[index].title, title);
        assert_eq!(
            layout.hit(cell.rect.x + 2, cell.rect.y),
            Some(theorem_workbench_core::picker_layout::PickerHit::Row(index))
        );
    }
}

// ---- keyboard, columns -------------------------------------------------

fn standalone_picker(width: u16) -> (Picker, Registry, Capabilities) {
    let registry = builtin::registry();
    let caps = caps(&[]);
    let mut picker = Picker::default();
    picker.set_area(Rect::new(0, 0, width, 14));
    picker.update(PickerMsg::Open, &registry, &caps, &Default::default());
    (picker, registry, caps)
}

fn step(p: &mut Picker, r: &Registry, c: &Capabilities, msg: PickerMsg) -> PickerOutcome {
    p.update(msg, r, c, &Default::default())
}

#[test]
fn left_and_right_cross_the_columns_only_when_two_are_drawn() {
    let (mut p, r, c) = standalone_picker(96);
    // Rows read across: Changes Shell / Files Side chat / New page More tools.
    step(&mut p, &r, &c, PickerMsg::Right);
    assert_eq!(p.selected(), 1);
    step(&mut p, &r, &c, PickerMsg::Right);
    assert_eq!(p.selected(), 1, "nothing right of the second column");
    step(&mut p, &r, &c, PickerMsg::Left);
    assert_eq!(p.selected(), 0);
    step(&mut p, &r, &c, PickerMsg::Next);
    assert_eq!(p.selected(), 2, "down stays in the first column");
    step(&mut p, &r, &c, PickerMsg::Right);
    assert_eq!(p.selected(), 3);

    let (mut p, r, c) = standalone_picker(60);
    step(&mut p, &r, &c, PickerMsg::Right);
    step(&mut p, &r, &c, PickerMsg::Left);
    assert_eq!(p.selected(), 0, "one column: Left and Right go nowhere");
    assert!(p.is_open());
}

#[test]
fn down_and_up_follow_the_drawn_grid_with_two_columns_and_wrap_within_a_column() {
    let (mut p, r, c) = standalone_picker(96);
    let mut seen = vec![p.selected()];
    for _ in 0..3 {
        step(&mut p, &r, &c, PickerMsg::Next);
        seen.push(p.selected());
    }
    assert_eq!(seen, [0, 2, 4, 0], "the first column wraps to its top");
    step(&mut p, &r, &c, PickerMsg::Prev);
    assert_eq!(
        p.selected(),
        4,
        "up from the top wraps to the column's bottom"
    );
    step(&mut p, &r, &c, PickerMsg::Right);
    assert_eq!(p.selected(), 5);
    step(&mut p, &r, &c, PickerMsg::Prev);
    assert_eq!(p.selected(), 3);
    step(&mut p, &r, &c, PickerMsg::Next);
    step(&mut p, &r, &c, PickerMsg::Next);
    assert_eq!(p.selected(), 1, "the second column wraps to its top");
}

#[test]
fn down_and_up_step_through_every_row_with_one_column() {
    let (mut p, r, c) = standalone_picker(60);
    let mut seen = vec![p.selected()];
    for _ in 0..6 {
        step(&mut p, &r, &c, PickerMsg::Next);
        seen.push(p.selected());
    }
    assert_eq!(seen, [0, 1, 2, 3, 4, 5, 0]);
    step(&mut p, &r, &c, PickerMsg::Prev);
    assert_eq!(p.selected(), 5);
}

#[test]
fn an_odd_last_line_has_no_right_neighbour_and_down_skips_the_missing_cell() {
    let registry = builtin::registry();
    let caps = caps(&[]);
    let pins: std::collections::BTreeSet<PanelKind> =
        [PanelKind::new("cabinet"), PanelKind::new("diagnostics")].into();
    let mut p = Picker::default();
    p.set_area(Rect::new(0, 0, 200, 20));
    p.update(PickerMsg::Open, &registry, &caps, &pins);
    p.update(PickerMsg::Select(7), &registry, &caps, &pins);
    p.update(PickerMsg::Choose, &registry, &caps, &pins);
    // With Artifacts and Diagnostics pinned, More tools lists five rows in two columns: the last line has one cell.
    let n = p.rows(&registry, &caps, &pins).len();
    assert_eq!(n, 5);
    p.update(PickerMsg::Select(4), &registry, &caps, &pins);
    p.update(PickerMsg::Right, &registry, &caps, &pins);
    assert_eq!(p.selected(), 4);
    p.update(PickerMsg::Next, &registry, &caps, &pins);
    assert_eq!(p.selected(), 0);
    p.update(PickerMsg::Select(3), &registry, &caps, &pins);
    p.update(PickerMsg::Next, &registry, &caps, &pins);
    assert_eq!(
        p.selected(),
        1,
        "below row 3 there is no row 5, so the column wraps"
    );
}

#[test]
fn left_on_more_tools_goes_back_and_so_does_the_back_row() {
    for width in [96, 60] {
        let (mut p, r, c) = standalone_picker(width);
        step(&mut p, &r, &c, PickerMsg::Select(5));
        step(&mut p, &r, &c, PickerMsg::Choose);
        assert_eq!(p.page(), theorem_workbench_core::picker::Page::More);
        step(&mut p, &r, &c, PickerMsg::Left);
        assert_eq!(
            p.page(),
            theorem_workbench_core::picker::Page::Main,
            "{width}"
        );
        assert!(p.is_open());
    }
}

// ---- pins --------------------------------------------------------------

fn open_more(m: &mut Model) {
    picker(m, PickerMsg::Open);
    picker(m, PickerMsg::Select(5));
    picker(m, PickerMsg::Choose);
    assert!(titles(m).contains(&"Artifacts".to_owned()));
}

#[test]
fn pinning_moves_a_tool_after_the_initial_rows_and_before_more_tools() {
    let mut m = model(caps(&["probing"]));
    open_more(&mut m);
    assert_eq!(
        titles(&m),
        [
            "Artifacts",
            "Diagnostics",
            "Run output",
            "Search",
            "History",
            "Threads",
            "Layouts",
            "Probe"
        ]
    );
    // By key.
    picker(&mut m, PickerMsg::Select(1));
    assert!(key(&mut m, Key::Char('p'), Mods::CTRL | Mods::ALT).is_empty());
    assert!(m.pinned().contains(&PanelKind::new("diagnostics")));
    assert!(!titles(&m).contains(&"Diagnostics".to_owned()));
    // By pointer on the pin control of the first row.
    picker(&mut m, PickerMsg::TogglePinAt(0));
    assert!(m.pinned().contains(&PanelKind::new("cabinet")));
    // Back on the main page: initial rows, then the pins, then More tools.
    key(&mut m, Key::Esc, Mods::NONE);
    assert_eq!(
        titles(&m),
        [
            "Changes",
            "Shell",
            "Files",
            "Side chat",
            "New page",
            "Artifacts",
            "Diagnostics",
            "More tools"
        ]
    );
    // A pinned main row can be unpinned where it is.
    for _ in 0..5 {
        picker(&mut m, PickerMsg::Next);
    }
    picker(&mut m, PickerMsg::TogglePin);
    assert!(!m.pinned().contains(&PanelKind::new("cabinet")));
    // A row that is not a More tools entry has no pin.
    picker(&mut m, PickerMsg::Select(0));
    picker(&mut m, PickerMsg::TogglePin);
    assert_eq!(m.pinned().len(), 1);
}

#[test]
fn pins_are_part_of_the_saved_workbench_state() {
    let mut a = model(caps(&[]));
    open_more(&mut a);
    picker(&mut a, PickerMsg::TogglePin);
    picker(&mut a, PickerMsg::Close);
    let saved = serde_json::to_string(&a.document()).unwrap();
    assert!(a.pinned().contains(&PanelKind::new("cabinet")));

    let mut b = model(caps(&[]));
    assert!(b.pinned().is_empty());
    b.restore(serde_json::from_str(&saved).unwrap()).unwrap();
    assert_eq!(b.pinned(), a.pinned());
    picker(&mut b, PickerMsg::Open);
    assert!(titles(&b).contains(&"Artifacts".to_owned()));
    assert_eq!(titles(&b).last().map(String::as_str), Some("More tools"));

    // A document with pins for a tool nobody serves keeps the others.
    let mut doc = a.document();
    doc["pinned"] = serde_json::json!(["cabinet", "nonesuch", "files"]);
    let mut c = model(caps(&[]));
    c.restore(doc).unwrap();
    assert_eq!(c.pinned().len(), 1, "only a More tools entry can be pinned");

    // One saved before pins existed leaves the pins as they are.
    let mut old = a.document();
    old.as_object_mut().unwrap().remove("pinned");
    let mut d = model(caps(&[]));
    d.set_pinned([PanelKind::new("search")].into());
    d.restore(old).unwrap();
    assert!(d.pinned().contains(&PanelKind::new("search")));
}

#[test]
fn the_trees_pin_and_back_actions_work_by_id() {
    let mut m = model(caps(&[]));
    open_more(&mut m);
    let tree = semantics(&m);
    let row = picker_nodes(&tree)
        .into_iter()
        .find(|n| n.name == "Search")
        .unwrap()
        .clone();
    let pin = row
        .actions
        .iter()
        .find(|a| a.id.as_str().starts_with("picker.pin."))
        .unwrap();
    assert_eq!(pin.id.as_str(), "picker.pin.search");
    assert!(action(&mut m, pin.id.as_str()).is_empty());
    assert!(m.pinned().contains(&PanelKind::new("search")));
    let tree = semantics(&m);
    assert!(
        !picker_nodes(&tree).iter().any(|n| n.name == "Search"),
        "pinned: gone from More tools"
    );
    assert!(action(&mut m, "picker.unpin.search").is_empty());
    assert!(m.pinned().is_empty());
    // Back is an action of the back row.
    let tree = semantics(&m);
    let back = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str().ends_with("/back"))
        .unwrap();
    assert_eq!(back.actions[0].id.as_str(), "picker.back");
    assert!(action(&mut m, "picker.back").is_empty());
    assert!(titles(&m).contains(&"More tools".to_owned()));
    assert!(m.picker().is_open());
}

// ---- unavailable rows ---------------------------------------------------

fn reason_node(tree: &SemanticTree) -> Option<&Node> {
    tree.nodes
        .iter()
        .find(|n| n.id.as_str().ends_with("/reason"))
}

#[test]
fn choosing_an_unavailable_row_keeps_the_picker_open_and_shows_why_until_selection_moves() {
    // Everything but "run": Run output is unavailable.
    let mut m = model(Capabilities::of(
        ALL.iter().copied().filter(|c| !c.starts_with("run")),
    ));
    open_more(&mut m);
    picker(&mut m, PickerMsg::Select(2));
    let fx = picker(&mut m, PickerMsg::Choose);
    assert!(fx.is_empty());
    assert!(m.picker().is_open(), "stays open");
    let why = "This host does not report the \"run.start\" capability.";
    assert_eq!(m.picker().reason(), Some(why));

    let tree = semantics(&m);
    tree.validate().unwrap();
    let node = reason_node(&tree).expect("the reason is in the tree");
    assert_eq!((node.role, node.name.as_str()), (Role::Alert, why));
    let row = picker_nodes(&tree)
        .into_iter()
        .find(|n| n.name == "Run output")
        .unwrap();
    assert!(row.state.disabled);
    assert_eq!(row.state.description.as_deref(), Some(why));
    assert_eq!(row.actions[0].reason.as_deref(), Some(why));

    // It is on screen, under the list, in the warning role's line.
    let mut buf = Buffer::empty(Rect::new(0, 0, 200, 50));
    theorem_workbench_core::view(&m, Rect::new(0, 0, 200, 50), &mut buf, &Theme::plain());
    let y = node.rect.unwrap().y;
    let drawn: String = (node.rect.unwrap().x..node.rect.unwrap().x + node.rect.unwrap().width)
        .map(|x| buf[(x, y)].symbol().to_owned())
        .collect();
    assert!(drawn.contains(why), "{drawn:?}");

    // Moving the selection clears it, on screen and in the tree.
    picker(&mut m, PickerMsg::Next);
    assert_eq!(m.picker().reason(), None);
    assert!(reason_node(&semantics(&m)).is_none());
    // Choosing it again by pointer shows it again; hovering the same row keeps it.
    picker(&mut m, PickerMsg::ChooseAt(2));
    assert_eq!(m.picker().reason(), Some(why));
    picker(&mut m, PickerMsg::Select(2));
    assert_eq!(m.picker().reason(), Some(why));
    picker(&mut m, PickerMsg::Select(0));
    assert_eq!(m.picker().reason(), None);
    // And the filter and the page clear it too.
    picker(&mut m, PickerMsg::ChooseAt(2));
    picker(&mut m, PickerMsg::Filter("run".into()));
    assert_eq!(m.picker().reason(), None);
}

// ---- pointer through the same layout --------------------------------------

fn center(n: &Node) -> (u16, u16) {
    (
        n.rect.unwrap().x + n.rect.unwrap().width / 2,
        n.rect.unwrap().y,
    )
}

fn pointer(m: &mut Model, kind: PointerKind, (x, y): (u16, u16)) -> Vec<Effect> {
    update(
        m,
        Msg::Pointer(Pointer {
            kind,
            x,
            y,
            mods: Mods::NONE,
            clicks: 1,
        }),
    )
}

#[test]
fn the_pointer_hits_what_the_tree_says_is_drawn() {
    let mut m = model(caps(&["probing"]));
    open_more(&mut m);
    let tree = semantics(&m);
    let rows: Vec<Node> = picker_nodes(&tree).into_iter().cloned().collect();
    // Hover selects the row under it, whichever it is.
    for (i, row) in rows.iter().enumerate() {
        assert!(
            row.rect.unwrap().height > 0 && row.rect.unwrap().width > 0,
            "{}",
            row.name
        );
        pointer(&mut m, PointerKind::Move, center(row));
        assert_eq!(m.picker().selected(), i, "{}", row.name);
    }
    // A click on a pin control pins; the control is the row's last cell.
    let first = &rows[0];
    let pin = (
        first.rect.unwrap().x + first.rect.unwrap().width - 1,
        first.rect.unwrap().y,
    );
    assert!(pointer(&mut m, PointerKind::Down(Button::Left), pin).is_empty());
    assert!(m.pinned().contains(&PanelKind::new("cabinet")));
    // The back row is on the tree and a click on it goes back.
    let tree = semantics(&m);
    let back = tree
        .nodes
        .iter()
        .find(|n| n.id.as_str().ends_with("/back"))
        .unwrap();
    assert!(pointer(&mut m, PointerKind::Down(Button::Left), center(back)).is_empty());
    assert!(titles(&m).contains(&"More tools".to_owned()));
    // On the main page the same click on a row chooses it, with no effect.
    let tree = semantics(&m);
    let shell = picker_nodes(&tree)
        .into_iter()
        .find(|n| n.name == "Shell")
        .unwrap()
        .clone();
    let fx = pointer(&mut m, PointerKind::Down(Button::Left), center(&shell));
    assert!(fx.is_empty());
    assert!(!m.picker().is_open());
}

// ---- shortcut hints -----------------------------------------------------

#[test]
fn hints_follow_the_active_bindings_and_a_row_with_none_shows_none() {
    let mut m = model(caps(&[]));
    action(&mut m, "picker.open");
    let hint = |m: &Model, title: &str| {
        let tree = semantics(m);
        picker_nodes(&tree)
            .into_iter()
            .find(|n| n.name == title)
            .unwrap()
            .shortcut
            .clone()
    };
    assert_eq!(hint(&m, "Shell").as_deref(), Some("Ctrl+Alt+S"));
    assert_eq!(hint(&m, "Side chat").as_deref(), Some("Ctrl+Alt+L"));
    assert_eq!(hint(&m, "More tools"), None, "no binding, no hint");

    // The person rebinds Shell and unbinds Files; the host hands in the table.
    let registry = registry();
    let overrides = Overrides {
        bind: vec![Shortcut {
            chord: "Mod+Alt+Q".into(),
            context: KeyContext::Global,
            action: ActionId::new("shell.choose"),
        }],
        unbind: vec![
            Unbind {
                chord: "Mod+Alt+S".into(),
                context: KeyContext::Global,
            },
            Unbind {
                chord: "Mod+Alt+E".into(),
                context: KeyContext::Global,
            },
        ],
        ..Overrides::default()
    };
    m.set_keys(build_keys(&registry, &overrides));
    assert_eq!(hint(&m, "Shell").as_deref(), Some("Ctrl+Alt+Q"));
    assert_eq!(hint(&m, "Files"), None);
}

// ---- AC-06, AC-07 ---------------------------------------------------------

#[test]
fn browsing_the_picker_has_no_effects_and_only_an_available_choice_chooses() {
    let scripts: Vec<Vec<PickerMsg>> = vec![
        vec![
            PickerMsg::Open,
            PickerMsg::Right,
            PickerMsg::Left,
            PickerMsg::Right,
        ],
        vec![
            PickerMsg::Open,
            PickerMsg::Prev,
            PickerMsg::Choose,
            PickerMsg::TogglePin,
        ],
        vec![
            PickerMsg::Open,
            PickerMsg::Prev,
            PickerMsg::Choose,
            PickerMsg::TogglePinAt(0),
            PickerMsg::TogglePinAt(0),
            PickerMsg::Select(3),
            PickerMsg::TogglePin,
            PickerMsg::Left,
            PickerMsg::Left,
        ],
        vec![
            PickerMsg::Open,
            PickerMsg::TogglePin,
            PickerMsg::TogglePinAt(99),
        ],
        // Unavailable rows: choose by key, by pointer, then hover away.
        vec![
            PickerMsg::Open,
            PickerMsg::Prev,
            PickerMsg::Choose,
            PickerMsg::Next,
            PickerMsg::Next,
            PickerMsg::Choose,
            PickerMsg::Select(0),
            PickerMsg::ChooseAt(2),
            PickerMsg::Back,
        ],
        vec![
            PickerMsg::Open,
            PickerMsg::Select(2),
            PickerMsg::Select(0),
            PickerMsg::Select(99),
        ],
    ];
    for script in scripts {
        let mut m = model(Capabilities::of(
            ALL.iter().copied().filter(|c| !c.starts_with("run")),
        ));
        for msg in script {
            let fx = picker(&mut m, msg.clone());
            assert!(fx.is_empty(), "{msg:?} returned {fx:?}");
            assert!(m.in_flight().is_empty());
        }
    }

    // Through the state machine: only an available chosen row says Chosen.
    let registry = registry();
    let caps = Capabilities::of(ALL.iter().copied().filter(|c| !c.starts_with("run")));
    let pins = Default::default();
    let mut p = Picker::default();
    p.set_area(Rect::new(0, 0, 96, 14));
    let mut outcomes = vec![];
    for msg in [
        PickerMsg::Open,
        PickerMsg::Right,
        PickerMsg::Left,
        PickerMsg::Select(5),
        PickerMsg::Choose,
        PickerMsg::Select(2),
        PickerMsg::Choose,
        PickerMsg::TogglePin,
        PickerMsg::Select(1),
        PickerMsg::Choose,
    ] {
        outcomes.push(p.update(msg, &registry, &caps, &pins));
    }
    let chosen: Vec<_> = outcomes
        .iter()
        .filter(|o| matches!(o, PickerOutcome::Chosen(_)))
        .collect();
    assert_eq!(chosen.len(), 1, "{outcomes:?}");
    assert!(matches!(&outcomes[6], PickerOutcome::Unavailable { .. }));
    assert!(matches!(
        &outcomes[7],
        PickerOutcome::Pin { pinned: true, .. }
    ));
}

#[test]
fn one_registration_is_what_the_picker_catalog_and_semantics_all_report() {
    let probe = ActionId::new("probe.open");
    let shortcut = |m: &Model| m.keys().label(&probe);
    let mut m = model(caps(&["probing"]));
    action(&mut m, "picker.open");
    picker(&mut m, PickerMsg::Prev);
    picker(&mut m, PickerMsg::Choose);

    let read = |m: &Model| {
        let caps = m.capabilities().clone();
        let registry = m.registry();
        let row = registry
            .more_tools(&caps, m.pinned())
            .into_iter()
            .find(|r| r.action == probe)
            .unwrap();
        let entry = registry
            .agent_catalog(&caps)
            .into_iter()
            .find(|e| e.action == probe)
            .unwrap();
        let tree = semantics(m);
        let node = picker_nodes(&tree)
            .into_iter()
            .find(|n| n.actions.iter().any(|a| a.id == probe))
            .unwrap()
            .clone();
        (row, entry, node)
    };

    let (row, entry, node) = read(&m);
    assert_eq!(
        (row.title.as_str(), entry.title.as_str(), node.name.as_str()),
        ("Probe", "Probe", "Probe")
    );
    assert_eq!(row.availability, Availability::Available);
    assert_eq!(entry.availability, row.availability);
    assert!(node.actions[0].enabled && node.actions[0].reason.is_none());
    assert_eq!(shortcut(&m).as_deref(), Some("Ctrl+Alt+J"));
    assert_eq!(
        node.shortcut,
        shortcut(&m),
        "the picker's hint is the key table's"
    );

    // Set a different shortcut label and disable the capability.
    let overrides = Overrides {
        bind: vec![Shortcut {
            chord: "Mod+Alt+Y".into(),
            context: KeyContext::Global,
            action: probe.clone(),
        }],
        unbind: vec![Unbind {
            chord: "Mod+Alt+J".into(),
            context: KeyContext::Global,
        }],
        ..Overrides::default()
    };
    m.set_keys(build_keys(m.registry(), &overrides));
    update(
        &mut m,
        Msg::Host(HostMessage::CapabilitiesChanged {
            capabilities: caps(&[]),
        }),
    );
    let (row, entry, node) = read(&m);
    let Availability::Unavailable { reason } = &row.availability else {
        panic!("{row:?}")
    };
    assert_eq!(
        reason,
        "This host does not report the \"probing\" capability."
    );
    assert_eq!(entry.availability, row.availability, "catalog: same reason");
    assert!(node.state.disabled);
    assert_eq!(node.actions[0].reason.as_deref(), Some(reason.as_str()));
    assert_eq!(node.state.description.as_deref(), Some(reason.as_str()));
    assert_eq!(shortcut(&m).as_deref(), Some("Ctrl+Alt+Y"));
    assert_eq!(node.shortcut.as_deref(), Some("Ctrl+Alt+Y"));
    assert_eq!(row.title, node.name);

    // Choosing it explains rather than acts, and nothing but the registry's
    // refusal is on screen.
    let fx = picker(&mut m, PickerMsg::ChooseAt(7));
    assert!(fx.is_empty());
    assert_eq!(m.picker().reason(), Some(reason.as_str()));
}

#[test]
fn the_initial_rows_are_the_six_in_order() {
    let mut m = model(caps(&[]));
    action(&mut m, "picker.open");
    assert_eq!(
        titles(&m),
        [
            "Changes",
            "Shell",
            "Files",
            "Side chat",
            "New page",
            "More tools"
        ]
    );
    let tree = semantics(&m);
    let menu = tree.nodes.iter().find(|n| n.role == Role::Menu).unwrap();
    assert_eq!(menu.name, "Tools");
    // Choosing Shell opens a chooser: nothing starts.
    picker(&mut m, PickerMsg::Next);
    assert!(picker(&mut m, PickerMsg::Choose).is_empty());
}

// ---- the reason wraps -------------------------------------------------------

const LONG: &str =
    "This host does not report the \"environment\" capability, so this tool cannot start here.";

/// A picker whose Shell row was chosen and refused with a long reason.
fn refused(_width: u16) -> PickerView {
    let mut view = standalone(false, "");
    view.selected = 1;
    view.reason = Some(LONG.to_owned());
    view
}

fn reason_text(view: &PickerView, width: u16, height: u16) -> (String, Rect) {
    let area = Rect::new(0, 0, width, height);
    let layout = Layout::compute(view, area);
    let rect = layout.reason.expect("the reason has lines");
    let text = render(view, width, height);
    let drawn: Vec<&str> = text
        .lines()
        .skip(usize::from(rect.y))
        .take(usize::from(rect.height))
        .map(str::trim)
        .collect();
    (drawn.join(" "), rect)
}

#[test]
fn a_long_reason_is_whole_at_every_width_and_the_rows_stay_consistent() {
    for width in [24, 28, 40, 96] {
        let view = refused(width);
        let (drawn, rect) = reason_text(&view, width, 14);
        assert_eq!(drawn, LONG, "{width}");
        assert!(rect.height >= 1 && rect.bottom() <= 14);
        if width < 96 {
            assert!(rect.height > 1, "{width} wraps");
        }
        // Every row cell is above the reason, and rows hit-test to themselves.
        let layout = Layout::compute(&view, Rect::new(0, 0, width, 14));
        for cell in &layout.cells {
            assert!(cell.rect.bottom() <= rect.y);
            assert_eq!(
                layout.hit(cell.rect.x, cell.rect.y),
                Some(theorem_workbench_core::picker_layout::PickerHit::Row(
                    cell.index
                ))
            );
        }
        assert_eq!(layout.hit(rect.x, rect.y), None);
        // And the tree's alert node has the same rect and the full text.
        let theme = Theme::plain();
        let workspace = Default::default();
        let mut cx = ViewCtx::new(&theme, &workspace);
        cx.picker = Some(&view);
        let nodes = PickerPanel.semantics(Rect::new(0, 0, width, 14), &cx);
        let alert = nodes.iter().find(|n| n.role == Role::Alert).unwrap();
        assert_eq!(alert.name, LONG);
        assert_eq!(
            Rect::new(
                alert.rect.unwrap().x,
                alert.rect.unwrap().y,
                alert.rect.unwrap().width,
                alert.rect.unwrap().height
            ),
            rect
        );
    }
}

#[test]
fn a_reason_keeps_its_lines_and_the_list_gives_way_in_a_short_area() {
    let mut view = refused(28);
    view.selected = 5;
    // 8 rows is the picker's registered minimum height; below it the reason
    // is cut to what fits and the list keeps one row.
    for height in 8..=14 {
        let (drawn, rect) = reason_text(&view, 28, height);
        assert_eq!(drawn, LONG, "height {height}");
        let layout = Layout::compute(&view, Rect::new(0, 0, 28, height));
        assert!(
            layout.cells.iter().any(|c| c.index == 5),
            "selected row stays, height {height}"
        );
        assert!(layout.cells.iter().all(|c| c.rect.bottom() <= rect.y));
    }
}

#[test]
fn the_real_refusal_wraps_in_a_narrow_picker() {
    let view = {
        let registry = builtin::registry();
        let caps = Capabilities::default();
        let pins = Default::default();
        let mut p = Picker::default();
        p.update(PickerMsg::Open, &registry, &caps, &pins);
        p.update(PickerMsg::Next, &registry, &caps, &pins);
        p.update(PickerMsg::Choose, &registry, &caps, &pins);
        p.view(&registry, &caps, &pins)
    };
    let why = view
        .reason
        .clone()
        .expect("Shell is unavailable without capabilities");
    let (drawn, _) = reason_text(&view, 28, 14);
    assert_eq!(drawn, why);
}

// ---- pin and back are registered actions ----------------------------------

#[test]
fn pin_and_back_are_registered_and_a_remap_moves_the_key_and_the_hint() {
    let mut m = model(caps(&[]));
    for id in ["picker.toggle-pin", "picker.back"] {
        assert!(m.registry().action(&ActionId::new(id)).is_some(), "{id}");
    }
    let pin = ActionId::new("picker.toggle-pin");
    assert_eq!(m.keys().label(&pin).as_deref(), Some("Ctrl+Alt+P"));
    open_more(&mut m);
    assert!(key(&mut m, Key::Char('p'), Mods::CTRL | Mods::ALT).is_empty());
    assert!(m.pinned().contains(&PanelKind::new("cabinet")));
    // A plain Ctrl+P is not bound any more.
    key(&mut m, Key::Char('p'), Mods::CTRL);
    assert_eq!(m.pinned().len(), 1);

    let overrides = Overrides {
        bind: vec![Shortcut {
            chord: "Mod+Alt+U".into(),
            context: KeyContext::Panel {
                kind: PanelKind::new("picker"),
            },
            action: pin.clone(),
        }],
        unbind: vec![Unbind {
            chord: "Mod+Alt+P".into(),
            context: KeyContext::Panel {
                kind: PanelKind::new("picker"),
            },
        }],
        ..Overrides::default()
    };
    m.set_keys(build_keys(m.registry(), &overrides));
    assert_eq!(m.keys().label(&pin).as_deref(), Some("Ctrl+Alt+U"));
    // The old chord does nothing; the new one unpins the selected pinned... row.
    picker(&mut m, PickerMsg::Select(0));
    key(&mut m, Key::Char('p'), Mods::CTRL | Mods::ALT);
    assert_eq!(m.pinned().len(), 1, "the old chord is gone");
    assert!(key(&mut m, Key::Char('u'), Mods::CTRL | Mods::ALT).is_empty());
    assert_eq!(m.pinned().len(), 2, "the new chord pins the selected row");
    // The action by name does the same.
    assert!(action(&mut m, "picker.toggle-pin").is_empty());
    assert_eq!(m.pinned().len(), 3);
}

#[test]
fn the_pin_chord_shows_beside_the_pin_mark_of_the_selected_row_only_if_it_fits() {
    let mut view = standalone(true, "");
    view.pin_shortcut = Some("Ctrl+Alt+P".into());
    let text = render(&view, 60, 14);
    let rows: Vec<&str> = text.lines().skip(3).take(3).collect();
    assert!(rows[0].contains("Ctrl+Alt+P  \u{25cb}"), "{}", rows[0]);
    assert!(!rows[1].contains("Ctrl"), "only the selected row");
    // Too narrow: the label wins, the chord is dropped.
    let text = render(&view, 20, 14);
    let first = text.lines().nth(3).unwrap();
    assert!(
        first.contains("Artifacts") && !first.contains("Ctrl"),
        "{first}"
    );
    // Never at the label's cost, at any width.
    for width in 0..40 {
        let text = render(&view, width, 14);
        let first = text.lines().nth(3).unwrap_or("");
        if first.contains("Ctrl+Alt+P") {
            assert!(first.contains("Artifacts"), "{width}: {first}");
        }
    }
}

#[test]
fn the_long_reason_at_28_columns() {
    assert_eq!(
        render(&refused(28), 28, 14),
        lines(&[
            "Tools",
            ">",
            " \u{b1} Changes       Ctrl+Alt+G",
            " \u{203a} Shell         Ctrl+Alt+S",
            " \u{25a1} Files         Ctrl+Alt+E",
            " \u{2295} Side chat     Ctrl+Alt+L",
            " \u{2261} New page      Ctrl+Alt+N",
            " \u{25a6} More tools",
            " This host does not report",
            " the \"environment\"",
            " capability, so this tool",
            " cannot start here.",
            "",
            "",
        ])
    );
}

// ---- the filter's text, and nodes that are not drawn -------------------

fn nodes_of(view: &PickerView, area: Rect) -> Vec<Node> {
    let theme = Theme::plain();
    let workspace = Default::default();
    let mut cx = ViewCtx::new(&theme, &workspace);
    cx.picker = Some(view);
    PickerPanel.semantics(area, &cx)
}

#[test]
fn the_filter_publishes_what_was_typed_as_its_text_with_the_caret_at_its_end() {
    let area = Rect::new(0, 0, 60, 14);
    for (typed, text, caret) in [
        ("", "", 0u32),
        ("sh", "sh", 2),
        // An astral character counts two UTF-16 units.
        ("a\u{1f600}", "a\u{1f600}", 3),
    ] {
        let nodes = nodes_of(&standalone(false, typed), area);
        let filter = nodes.iter().find(|n| n.id.as_str() == "filter").unwrap();
        assert_eq!(filter.text.as_deref(), Some(text), "{typed:?}");
        let sel = filter.selection.as_ref().expect("a caret");
        assert_eq!((sel.anchor, sel.focus), (caret, caret), "{typed:?}");
        // The typed text is in `text`, not said again in the description.
        if !typed.is_empty() {
            assert_eq!(filter.state.description, None, "{typed:?}");
        }
    }
}

#[test]
fn the_filters_text_is_escaped_and_the_caret_counts_the_escaped_text() {
    let area = Rect::new(0, 0, 60, 14);
    let typed = "a\u{1b}[31m\u{200b}b";
    let nodes = nodes_of(&standalone(false, typed), area);
    let filter = nodes.iter().find(|n| n.id.as_str() == "filter").unwrap();
    let text = filter.text.as_deref().unwrap();
    assert!(
        !text.contains('\u{1b}') && !text.contains('\u{200b}'),
        "{text:?}"
    );
    assert!(text.starts_with('a') && text.ends_with('b') && text.contains("[31m"));
    let sel = filter.selection.as_ref().unwrap();
    let units = u32::try_from(text.encode_utf16().count()).unwrap();
    assert_eq!((sel.anchor, sel.focus), (units, units));
}

#[test]
fn a_row_with_no_cell_is_in_the_tree_with_no_rect_and_a_drawn_row_has_one() {
    // A short area on More tools has fewer cells than rows.
    let view = standalone(true, "");
    let area = Rect::new(3, 2, 28, 6);
    let layout = Layout::compute(&view, area);
    assert!(
        layout.cells.len() < view.rows.len(),
        "the area must clip rows"
    );
    let nodes = nodes_of(&view, area);
    let rows: Vec<&Node> = nodes.iter().filter(|n| n.role == Role::MenuItem).collect();
    assert_eq!(rows.len(), view.rows.len(), "every row is reachable");
    for (i, row) in rows.iter().enumerate() {
        let drawn = layout.cells.iter().any(|c| c.index == i);
        assert_eq!(row.rect.is_some(), drawn, "row {i}");
        // Reachable either way: it still offers its action.
        assert!(!row.actions.is_empty(), "row {i}");
    }
}

#[test]
fn no_node_the_picker_publishes_has_a_rect_with_no_area() {
    for more in [false, true] {
        for (width, height) in [(96, 14), (28, 6), (12, 3), (5, 1)] {
            let view = standalone(more, "e");
            let nodes = nodes_of(&view, Rect::new(0, 0, width, height));
            for n in &nodes {
                if let Some(r) = n.rect {
                    assert!(r.width > 0 && r.height > 0, "{} {r:?}", n.id.as_str());
                }
            }
        }
    }
}
