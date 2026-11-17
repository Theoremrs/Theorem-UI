mod common;
use common::*;
use proptest::prelude::*;
use theorem_workbench_dock::*;

fn all_known(_: &PanelKind) -> bool {
    true
}

fn roundtrip(d: &Dock) -> Dock {
    let json = serde_json::to_string(&d.document()).unwrap();
    let doc: DockDocument = serde_json::from_str(&json).unwrap();
    let (back, report) = Dock::restore(doc, DockConfig::default(), all_known).unwrap();
    assert!(report.repairs.is_empty() && report.unavailable.is_empty());
    back
}

#[test]
fn a_document_round_trips_exactly_through_json() {
    let (mut d, r) = default_dock();
    d.open_panel(
        tab("docs"),
        OpenAt::Split {
            group: r.main,
            side: NavDirection::Down,
            role: None,
        },
    )
    .unwrap();
    d.hide_group(r.tools).unwrap();
    d.maximize(r.main).unwrap();
    let mut t = tab("page");
    t.view_state = serde_json::json!({"scroll": 12, "cursor": {"line": 3, "col": 9}});
    d.open_panel(t, OpenAt::Group(r.main)).unwrap();
    d.unmaximize();
    d.maximize(r.main).unwrap();
    let back = roundtrip(&d);
    assert_eq!(back.document(), d.document());
    let a = area(180, 50);
    assert_eq!(back.solve(a, m()), d.solve(a, m()));
    assert_eq!(back.group_ids(), d.group_ids());
    assert_eq!(back.focused(), d.focused());
}

#[test]
fn group_ids_stay_stable_and_are_not_reused_after_restore() {
    let (mut d, r) = default_dock();
    d.close_tab(&pid("shell")).unwrap();
    d.close_tab(&pid("changes")).unwrap();
    assert!(d.group(r.tools).is_none());
    let mut back = roundtrip(&d);
    assert_eq!(back.group_ids(), d.group_ids());
    let n = back.split_empty(r.main, NavDirection::Right, None).unwrap();
    assert_ne!(n, r.tools);
    assert!(!d.group_ids().contains(&n));
}

#[test]
fn the_schema_string_and_version_are_checked() {
    let (d, _) = default_dock();
    let mut doc = d.document();
    assert_eq!((doc.schema.as_str(), doc.version), (SCHEMA, VERSION));
    doc.version = VERSION + 1;
    assert_eq!(
        Dock::restore(doc, DockConfig::default(), all_known).unwrap_err(),
        RestoreError::UnsupportedVersion {
            found: VERSION + 1,
            supported: VERSION
        }
    );
    let mut doc = d.document();
    doc.schema = "something.else".into();
    assert_eq!(
        Dock::restore(doc, DockConfig::default(), all_known).unwrap_err(),
        RestoreError::UnknownSchema("something.else".into())
    );
}

#[test]
fn malformed_documents_are_refused_not_panicked_on() {
    let (d, r) = default_dock();
    let base = d.document();
    let cfg = DockConfig::default;

    // A group entry for a leaf that does not exist.
    let mut doc = base.clone();
    doc.groups
        .insert(GroupId::from_raw(77), doc.groups[&r.main].clone());
    assert_eq!(
        Dock::restore(doc, cfg(), all_known).unwrap_err(),
        RestoreError::OrphanGroup(GroupId::from_raw(77))
    );

    // A leaf with no group entry.
    let mut doc = base.clone();
    doc.groups.remove(&r.tools);
    assert_eq!(
        Dock::restore(doc, cfg(), all_known).unwrap_err(),
        RestoreError::MissingGroup(r.tools)
    );

    // The same panel in two tabs.
    let mut doc = base.clone();
    let dup = doc.groups[&r.main].tabs[0].clone();
    doc.groups.get_mut(&r.tools).unwrap().tabs.push(dup);
    assert_eq!(
        Dock::restore(doc, cfg(), all_known).unwrap_err(),
        RestoreError::DuplicatePanel(pid("theo"))
    );

    // Tree damage surfaces the layout error.
    let mut doc = base.clone();
    doc.layout.focus = GroupId::from_raw(404);
    assert!(matches!(
        Dock::restore(doc, cfg(), all_known).unwrap_err(),
        RestoreError::Layout(theorem_workbench_layout::LayoutError::FocusMissing(_))
    ));
    let mut doc = base.clone();
    if let theorem_workbench_layout::Node::Split { ratio, .. } = &mut doc.layout.root {
        *ratio = 1.5;
    }
    assert!(matches!(
        Dock::restore(doc, cfg(), all_known).unwrap_err(),
        RestoreError::Layout(theorem_workbench_layout::LayoutError::RatioOutOfRange(_))
    ));

    // Garbage JSON is a serde error, never a panic.
    assert!(serde_json::from_str::<DockDocument>(r#"{"schema":1}"#).is_err());
}

#[test]
fn small_inconsistencies_are_repaired_and_reported() {
    let (d, r) = default_dock();
    let mut doc = d.document();
    doc.groups.get_mut(&r.tools).unwrap().active = Some(pid("gone"));
    doc.groups.get_mut(&r.files).unwrap().pinned_px = Some(f32::NAN);
    doc.maximized = Some(GroupId::from_raw(88));
    let (back, report) = Dock::restore(doc, DockConfig::default(), all_known).unwrap();
    assert!(report.repairs.contains(&Repair::ActiveTab(r.tools)));
    assert!(report.repairs.contains(&Repair::PinnedPx(r.files)));
    assert!(
        report
            .repairs
            .contains(&Repair::Maximized(GroupId::from_raw(88)))
    );
    assert_eq!(
        back.group(r.tools).unwrap().active().unwrap().panel,
        pid("changes")
    );
    assert_eq!(back.maximized(), None);

    // Everything hidden is repaired to something visible.
    let mut doc = d.document();
    for g in doc.groups.values_mut() {
        g.hidden = true;
    }
    let (back, report) = Dock::restore(doc, DockConfig::default(), all_known).unwrap();
    assert!(
        report
            .repairs
            .iter()
            .any(|x| matches!(x, Repair::AllHidden(_)))
    );
    assert!(!back.solve(area(160, 40), m()).groups.is_empty());
}

#[test]
fn unknown_kinds_stay_as_unavailable_placeholders() {
    let (mut d, r) = default_dock();
    let mut t = Tab::new("future", PanelKind::new("hologram", 3), "Hologram");
    t.view_state = serde_json::json!({"opaque": [1, 2, 3]});
    d.open_panel(t, OpenAt::Group(r.tools)).unwrap();
    let doc = d.document();
    let known = |k: &PanelKind| k.name != "hologram";
    let (back, report) = Dock::restore(doc.clone(), DockConfig::default(), known).unwrap();
    assert_eq!(report.unavailable, [pid("future")]);
    assert!(report.repairs.is_empty());
    let tab = back
        .group(r.tools)
        .unwrap()
        .tabs()
        .iter()
        .find(|t| t.panel == pid("future"))
        .unwrap();
    assert!(tab.unavailable);
    assert_eq!(tab.kind, PanelKind::new("hologram", 3));
    assert_eq!(tab.view_state, serde_json::json!({"opaque": [1, 2, 3]}));
    // The placeholder is not dropped on the next save.
    assert_eq!(back.document(), doc);
    // And the frame says so.
    let f = back.solve(area(160, 40), m());
    let tools = f.group(r.tools).unwrap();
    assert!(
        tools
            .tabs
            .iter()
            .any(|t| t.panel == pid("future") && t.unavailable)
    );
}

#[derive(Debug, Clone)]
enum Op {
    Open(u8, usize, Option<NavDirection>),
    Close(u8),
    Move(u8, usize, Option<usize>),
    MoveSplit(u8, usize, NavDirection),
    Reorder(u8, usize),
    Hide(usize),
    Show(usize),
    Maximize(usize),
    Restore,
    Focus(u8),
    Resize(usize, i32),
}

fn side() -> impl Strategy<Value = NavDirection> {
    prop_oneof![
        Just(NavDirection::Left),
        Just(NavDirection::Right),
        Just(NavDirection::Up),
        Just(NavDirection::Down)
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u8..10, 0usize..6, proptest::option::of(side())).prop_map(|(p, g, s)| Op::Open(p, g, s)),
        (0u8..10).prop_map(Op::Close),
        (0u8..10, 0usize..6, proptest::option::of(0usize..4))
            .prop_map(|(p, g, i)| Op::Move(p, g, i)),
        (0u8..10, 0usize..6, side()).prop_map(|(p, g, s)| Op::MoveSplit(p, g, s)),
        (0u8..10, 0usize..4).prop_map(|(p, i)| Op::Reorder(p, i)),
        (0usize..6).prop_map(Op::Hide),
        (0usize..6).prop_map(Op::Show),
        (0usize..6).prop_map(Op::Maximize),
        Just(Op::Restore),
        (0u8..10).prop_map(Op::Focus),
        (0usize..4, -30i32..30).prop_map(|(s, d)| Op::Resize(s, d)),
    ]
}

fn apply(d: &mut Dock, op: &Op, a: ratatui::layout::Rect) -> bool {
    let ids = d.group_ids();
    let g = |i: &usize| ids[*i % ids.len()];
    let p = |n: &u8| pid(&format!("p{n}"));
    match op {
        Op::Open(n, i, s) => {
            let at = match s {
                Some(side) => OpenAt::Split {
                    group: g(i),
                    side: *side,
                    role: None,
                },
                None => OpenAt::Group(g(i)),
            };
            d.open_panel(tab(&format!("p{n}")), at).is_ok()
        }
        Op::Close(n) => d.close_tab(&p(n)).is_ok(),
        Op::Move(n, i, idx) => d.move_tab(&p(n), g(i), *idx).is_ok(),
        Op::MoveSplit(n, i, s) => d.move_tab_to_split(&p(n), g(i), *s).is_ok(),
        Op::Reorder(n, i) => d.reorder_tab(&p(n), *i).is_ok(),
        Op::Hide(i) => d.hide_group(g(i)).is_ok(),
        Op::Show(i) => d.show_group(g(i)).is_ok(),
        Op::Maximize(i) => d.maximize(g(i)).is_ok(),
        Op::Restore => d.unmaximize(),
        Op::Focus(n) => d.focus_panel(&p(n)).is_ok(),
        Op::Resize(i, delta) => {
            let f = d.solve(a, m());
            match f.splitters.get(*i) {
                Some(s) => d.resize_split(&s.path.clone(), *delta, a, m()).is_ok(),
                None => false,
            }
        }
    }
}

proptest! {
    #[test]
    fn any_sequence_of_operations_keeps_the_dock_valid(ops in proptest::collection::vec(op(), 1..40), w in 100u16..300) {
        let a = area(w, 40);
        let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Default);
        d.open_panel(tab("p0"), OpenAt::Group(r.main)).unwrap();
        for op in &ops {
            let before = d.clone();
            let ok = apply(&mut d, op, a);
            if !ok {
                // A refusal changes nothing (Restore reports false the same way).
                prop_assert_eq!(&d, &before, "{:?}", op);
            }
            // Invariants after every step.
            let ids = d.group_ids();
            prop_assert!(ids.contains(&d.focused()));
            let mut seen = std::collections::BTreeSet::new();
            for id in &ids {
                for t in d.group(*id).unwrap().tabs() {
                    prop_assert!(seen.insert(t.panel.clone()), "duplicate panel");
                }
            }
            prop_assert!(ids.iter().any(|id| !d.group(*id).unwrap().is_hidden()));
            let f = d.solve(a, m());
            if f.presentation == Presentation::Tiled && f.groups.iter().all(|g| !g.overlay) {
                assert_exact_tiling(&f);
            }
            // The document round-trips exactly.
            let json = serde_json::to_string(&d.document()).unwrap();
            let doc: DockDocument = serde_json::from_str(&json).unwrap();
            let (back, report) = Dock::restore(doc.clone(), DockConfig::default(), |_| true).unwrap();
            prop_assert!(report.repairs.is_empty(), "{:?}", report);
            prop_assert_eq!(back.document(), doc);
        }
    }
}

#[test]
fn a_group_made_empty_on_purpose_stays_kept_through_a_round_trip() {
    let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Default);
    let made = d
        .split_empty(r.main, NavDirection::Right, Some(Role::Tools))
        .unwrap();
    let back = roundtrip(&d);
    assert!(back.group(made).unwrap().keeps_empty());
    assert!(!back.group(r.tools).unwrap().keeps_empty());
}
