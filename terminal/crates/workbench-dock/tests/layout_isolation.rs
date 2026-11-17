//! AC-61: the dock replayed with panels that are not terminals (documents, a
//! diff, a file list). Identity, geometry and "views only" are checked against
//! a model kept outside the dock.

mod common;
use common::*;
use proptest::prelude::*;
use ratatui::layout::{Direction, Rect};
use std::collections::BTreeSet;
use theorem_workbench_dock::*;
use theorem_workbench_layout::{PaneInfo, TileLayout};

const AREAS: [(u16, u16); 7] = [
    (1, 1),
    (7, 5),
    (40, 12),
    (100, 30),
    (160, 40),
    (260, 60),
    (400, 120),
];

fn all_known(_: &PanelKind) -> bool {
    true
}

fn panels(d: &Dock) -> BTreeSet<PanelId> {
    d.group_ids()
        .into_iter()
        .flat_map(|g| {
            d.group(g)
                .unwrap()
                .tabs()
                .iter()
                .map(|t| t.panel.clone())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn restored(d: &Dock) -> Dock {
    let json = serde_json::to_string(&d.document()).unwrap();
    let doc: DockDocument = serde_json::from_str(&json).unwrap();
    let (back, report) = Dock::restore(doc, DockConfig::default(), all_known).unwrap();
    assert!(
        report.repairs.is_empty() && report.unavailable.is_empty(),
        "{report:?}"
    );
    back
}

/// At every size: a tiled frame covers each cell once; a collapsed frame shows
/// one group over the whole area; a maximized one shows its group over it.
fn assert_coherent_at_every_size(d: &Dock) {
    for (w, h) in AREAS {
        let a = Rect::new(0, 0, w, h);
        let f = d.solve(a, m());
        match f.presentation {
            Presentation::Tiled if f.groups.iter().all(|g| !g.overlay) => assert_exact_tiling(&f),
            Presentation::Tiled => {}
            Presentation::Principal | Presentation::Maximized => {
                let body: Vec<_> = f.groups.iter().filter(|g| !g.overlay).collect();
                assert_eq!(body.len(), 1, "{:?} at {w}x{h}", f.presentation);
                assert_eq!(body[0].rect, a);
            }
        }
        assert!(f.groups.iter().all(|g| d.group(g.id).is_some()));
        assert_eq!(d.solve(a, m()), f, "solving must be pure");
    }
}

#[test]
fn a_replay_with_document_panels_keeps_every_identity_and_tiles_at_every_step() {
    let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Default);
    d.open_panel(tab("files"), OpenAt::Group(r.files)).unwrap();
    d.open_panel(tab("notes.md"), OpenAt::Group(r.main))
        .unwrap();
    d.open_panel(tab("changes"), OpenAt::Group(r.tools))
        .unwrap();
    let mut expect = panels(&d);

    // Splits in all four directions, then deeper from the newest group.
    let mut last = r.main;
    for (i, side) in [
        NavDirection::Right,
        NavDirection::Down,
        NavDirection::Left,
        NavDirection::Up,
    ]
    .into_iter()
    .cycle()
    .take(10)
    .enumerate()
    {
        let name = format!("doc-{i}");
        last = d
            .open_panel(
                tab(&name),
                OpenAt::Split {
                    group: last,
                    side,
                    role: None,
                },
            )
            .unwrap();
        expect.insert(pid(&name));
        assert_eq!(panels(&d), expect);
        assert_coherent_at_every_size(&d);
    }

    // Moves between groups and into new splits never add or drop a panel.
    let groups = d.group_ids();
    d.move_tab(&pid("doc-3"), groups[0], None).unwrap();
    d.move_tab(&pid("doc-4"), r.tools, Some(0)).unwrap();
    d.move_tab_to_split(&pid("notes.md"), r.tools, NavDirection::Down)
        .unwrap();
    assert_eq!(panels(&d), expect);
    assert_coherent_at_every_size(&d);

    // Focus moves in four directions only ever land on a group that exists.
    let a = Rect::new(0, 0, 400, 120);
    for dir in [
        NavDirection::Left,
        NavDirection::Right,
        NavDirection::Up,
        NavDirection::Down,
    ] {
        if let Ok(g) = d.focus_direction(dir, a, m()) {
            assert_eq!(d.focused(), g);
        }
        assert_eq!(panels(&d), expect);
    }

    // Save, restore: same panels, same group ids, same focus, same frames.
    let groups_before = d.group_ids();
    let back = restored(&d);
    assert_eq!(panels(&back), expect);
    assert_eq!(back.group_ids(), groups_before);
    assert_eq!(back.focused(), d.focused());
    assert_eq!(back.document(), d.document());
    for (w, h) in AREAS {
        let a = Rect::new(0, 0, w, h);
        assert_eq!(back.solve(a, m()), d.solve(a, m()));
    }
    for p in &expect {
        assert_eq!(back.find_panel(p), d.find_panel(p), "{p:?} changed group");
    }
}

#[test]
fn closing_panels_one_by_one_never_leaves_an_unsolvable_dock_and_a_single_group_keeps_its_last_panel()
 {
    let (mut d, r) = default_dock();
    d.open_panel(
        tab("notes.md"),
        OpenAt::Split {
            group: r.main,
            side: NavDirection::Down,
            role: None,
        },
    )
    .unwrap();
    let mut open: BTreeSet<PanelId> = panels(&d);
    for gone in open.clone() {
        let before = d.clone();
        match d.close_tab(&gone) {
            Ok(_) => {
                open.remove(&gone);
            }
            Err(e) => {
                assert!(
                    matches!(e, DockError::LastPanel | DockError::LastVisibleGroup),
                    "{e:?}"
                );
                assert_eq!(d, before, "a refused close must change nothing");
            }
        }
        assert_eq!(
            panels(&d),
            open,
            "closing must drop exactly the closed panel"
        );
        assert!(d.group_ids().contains(&d.focused()));
        assert_coherent_at_every_size(&d);
        for (w, h) in AREAS {
            assert!(
                !d.solve(Rect::new(0, 0, w, h), m()).groups.is_empty(),
                "nothing to draw at {w}x{h}"
            );
        }
    }
    assert_eq!(restored(&d).document(), d.document());

    // One group: its last panel is kept, whatever is asked.
    let (mut one, g) = Dock::new(DockConfig::default(), Role::Main);
    one.open_panel(tab("only.md"), OpenAt::Group(g)).unwrap();
    let before = one.clone();
    assert_eq!(one.close_tab(&pid("only.md")), Err(DockError::LastPanel));
    assert_eq!(one, before);
    assert_coherent_at_every_size(&one);
}

#[test]
fn a_panel_kind_that_no_longer_exists_keeps_its_id_group_and_state_and_the_frame_still_tiles() {
    let (mut d, r) = default_dock();
    let mut gone = Tab::new("legacy-board", PanelKind::new("kanban", 2), "Board");
    gone.view_state = serde_json::json!({"column": 3});
    d.open_panel(
        gone,
        OpenAt::Split {
            group: r.tools,
            side: NavDirection::Down,
            role: None,
        },
    )
    .unwrap();
    let expect = panels(&d);
    let known = |k: &PanelKind| k.name != "kanban";
    let (back, report) = Dock::restore(d.document(), DockConfig::default(), known).unwrap();
    assert_eq!(report.unavailable, [pid("legacy-board")]);
    assert!(report.repairs.is_empty());
    assert_eq!(
        panels(&back),
        expect,
        "an unknown kind must not drop its panel"
    );
    assert_eq!(back.group_ids(), d.group_ids());
    assert_coherent_at_every_size(&back);
    // Nothing was launched or deleted to cope: saving again returns the document as it was.
    assert_eq!(back.document(), d.document());
}

#[test]
fn the_only_visible_panel_being_an_unavailable_kind_cannot_be_closed_and_the_dock_stays_solvable() {
    let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Minimal);
    d.open_panel(
        Tab::new("only", PanelKind::new("kanban", 2), "Board"),
        OpenAt::Group(r.main),
    )
    .unwrap();
    let (mut back, report) =
        Dock::restore(d.document(), DockConfig::default(), |k| k.name != "kanban").unwrap();
    assert_eq!(report.unavailable, [pid("only")]);
    let before = back.clone();
    // The other two groups of the preset are hidden, so this is the last visible one.
    assert_eq!(
        back.close_tab(&pid("only")),
        Err(DockError::LastVisibleGroup)
    );
    assert_eq!(back, before);
    assert_coherent_at_every_size(&back);
}

/// By type: every mutating operation of the dock answers with a group id, a
/// flag, a unit or a refusal. There is no intent type a host could read as
/// "start" or "stop" a process, so a split, move or close cannot request one.
#[test]
fn every_public_dock_operation_answers_with_a_view_change_or_a_refusal() {
    let _: fn(&mut Dock, Tab, OpenAt) -> Result<GroupId, DockError> = Dock::open_panel;
    let _: fn(&mut Dock, GroupId, NavDirection, Option<Role>) -> Result<GroupId, DockError> =
        Dock::split_empty;
    let _: fn(&mut Dock, &PanelId) -> Result<bool, DockError> = Dock::close_tab;
    let _: fn(&mut Dock, &PanelId, GroupId, Option<usize>) -> Result<(), DockError> =
        Dock::move_tab;
    let _: fn(&mut Dock, &PanelId, GroupId, NavDirection) -> Result<GroupId, DockError> =
        Dock::move_tab_to_split;
    let _: fn(&mut Dock, &PanelId) -> Result<GroupId, DockError> = Dock::focus_panel;
    let _: fn(&mut Dock, GroupId) -> Result<(), DockError> = Dock::focus_group;
    let _: fn(&mut Dock, GroupId) -> Result<(), DockError> = Dock::hide_group;
    let _: fn(&mut Dock, GroupId) -> Result<(), DockError> = Dock::maximize;
    let _: fn(&Dock) -> DockDocument = Dock::document;
    let _: fn(&Dock, Rect, CellMetrics) -> SolvedFrame = Dock::solve;
    let (empty, _) = Dock::new(DockConfig::default(), Role::Main);
    let _: Result<(Dock, RestoreReport), RestoreError> =
        Dock::restore(empty.document(), DockConfig::default(), |_| true);
}

#[test]
fn the_dock_source_names_no_process_thread_file_socket_or_unsafe_facility() {
    for (name, src) in [
        ("dock.rs", include_str!("../src/dock.rs")),
        ("doc.rs", include_str!("../src/doc.rs")),
        ("solve.rs", include_str!("../src/solve.rs")),
        ("types.rs", include_str!("../src/types.rs")),
        ("lib.rs", include_str!("../src/lib.rs")),
    ] {
        for word in [
            "std::process",
            "Command::new",
            "std::thread",
            "std::fs",
            "std::net",
            "std::env",
            "std::io",
            "unsafe",
            "extern \"C\"",
            "libc",
            "portable_pty",
            "tokio",
        ] {
            assert!(!src.contains(word), "{name} mentions `{word}`");
        }
    }
}

// --- random replays ---

#[derive(Debug, Clone)]
enum Step {
    Open(u8, usize, Option<u8>),
    Close(u8),
    Move(u8, usize),
    MoveSplit(u8, usize, u8),
    Focus(u8),
    FocusDir(u8),
    Hide(usize),
    Show(usize),
    Maximize(usize),
    Unmaximize,
    SaveRestore,
}

fn side(n: u8) -> NavDirection {
    [
        NavDirection::Left,
        NavDirection::Right,
        NavDirection::Up,
        NavDirection::Down,
    ][usize::from(n % 4)]
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        (0u8..12, 0usize..8, proptest::option::of(0u8..4))
            .prop_map(|(p, g, s)| Step::Open(p, g, s)),
        (0u8..12).prop_map(Step::Close),
        (0u8..12, 0usize..8).prop_map(|(p, g)| Step::Move(p, g)),
        (0u8..12, 0usize..8, 0u8..4).prop_map(|(p, g, s)| Step::MoveSplit(p, g, s)),
        (0u8..12).prop_map(Step::Focus),
        (0u8..4).prop_map(Step::FocusDir),
        (0usize..8).prop_map(Step::Hide),
        (0usize..8).prop_map(Step::Show),
        (0usize..8).prop_map(Step::Maximize),
        Just(Step::Unmaximize),
        Just(Step::SaveRestore),
    ]
}

proptest! {
    /// The set of open panels is whatever the successful opens and closes made
    /// it, and nothing else ever changes it: splits, moves, focus, hide,
    /// maximize and save/restore are views only. Group ids never reappear once
    /// gone, and every refusal changes nothing.
    #[test]
    fn open_panels_change_only_by_open_and_close_and_group_ids_are_never_reused(
        steps in proptest::collection::vec(step(), 1..60),
        w in 100u16..300,
    ) {
        let a = Rect::new(0, 0, w, 40);
        let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Default);
        d.open_panel(tab("p0"), OpenAt::Group(r.main)).unwrap();
        let mut model: BTreeSet<PanelId> = BTreeSet::from([pid("p0")]);
        let mut ever: BTreeSet<GroupId> = d.group_ids().into_iter().collect();
        for s in &steps {
            let before = d.clone();
            let ids = d.group_ids();
            let g = |i: &usize| ids[*i % ids.len()];
            let p = |n: &u8| pid(&format!("p{n}"));
            let ok = match s {
                Step::Open(n, i, sd) => {
                    let at = match sd {
                        Some(x) => OpenAt::Split { group: g(i), side: side(*x), role: None },
                        None => OpenAt::Group(g(i)),
                    };
                    let ok = d.open_panel(tab(&format!("p{n}")), at).is_ok();
                    if ok { model.insert(p(n)); }
                    ok
                }
                Step::Close(n) => {
                    let ok = d.close_tab(&p(n)).is_ok();
                    if ok { model.remove(&p(n)); }
                    ok
                }
                Step::Move(n, i) => d.move_tab(&p(n), g(i), None).is_ok(),
                Step::MoveSplit(n, i, sd) => d.move_tab_to_split(&p(n), g(i), side(*sd)).is_ok(),
                Step::Focus(n) => d.focus_panel(&p(n)).is_ok(),
                Step::FocusDir(x) => d.focus_direction(side(*x), a, m()).is_ok(),
                Step::Hide(i) => d.hide_group(g(i)).is_ok(),
                Step::Show(i) => d.show_group(g(i)).is_ok(),
                Step::Maximize(i) => d.maximize(g(i)).is_ok(),
                Step::Unmaximize => d.unmaximize(),
                Step::SaveRestore => {
                    let back = restored(&d);
                    prop_assert_eq!(back.document(), d.document());
                    d = back;
                    true
                }
            };
            if !ok {
                prop_assert_eq!(&d, &before, "a refusal changed the dock: {:?}", s);
            }
            prop_assert_eq!(panels(&d), model.clone(), "{:?}", s);
            prop_assert!(!d.group_ids().is_empty());
            prop_assert!(!d.solve(a, m()).groups.is_empty(), "nothing to draw");
            // A group id that left the dock is never handed out again.
            let now: BTreeSet<GroupId> = d.group_ids().into_iter().collect();
            let gone: BTreeSet<GroupId> = ever.difference(&now).copied().collect();
            let fresh: Vec<_> = now.difference(&ever).copied().collect();
            prop_assert!(fresh.iter().all(|f| !gone.contains(f)));
            ever.extend(now);
            let f = d.solve(a, m());
            if f.presentation == Presentation::Tiled && f.groups.iter().all(|x| !x.overlay) {
                assert_exact_tiling(&f);
            }
        }
    }

    /// The raw tree, driven with random splits, moves, focus and closes at a
    /// random area: the rectangles always partition the area, the id set follows
    /// the operations exactly, and the last pane never closes.
    #[test]
    fn the_raw_layout_partitions_any_area_through_random_operations(
        ops in proptest::collection::vec((0u8..6, 0usize..16, 0u8..2, 1u8..90), 1..80),
        w in 0u16..300, h in 0u16..100,
    ) {
        let area = Rect::new(2, 1, w, h);
        let (mut l, _) = TileLayout::new();
        let mut model: BTreeSet<_> = l.pane_ids().into_iter().collect();
        for (op, i, dir, ratio) in ops {
            let ids = l.pane_ids();
            let pick = ids[i % ids.len()];
            let dir = if dir == 0 { Direction::Horizontal } else { Direction::Vertical };
            let ratio = f32::from(ratio) / 100.0;
            match op {
                0 | 1 => { let n = l.split_pane(pick, dir, ratio).unwrap(); prop_assert!(model.insert(n)); }
                2 => { l.focus_pane(pick); }
                3 => {
                    let ok = l.close_pane(pick);
                    prop_assert_eq!(ok, model.len() > 1);
                    if ok { model.remove(&pick); }
                }
                4 => {
                    let other = ids[(i + 1) % ids.len()];
                    let moved = l.close_pane(pick)
                        && l.insert_pane_near(other, pick, dir, ratio, false);
                    // A refused move may have closed `pick`; put it back so the model holds.
                    if !moved && !l.pane_ids().contains(&pick) && ids.len() > 1 {
                        let near = l.pane_ids()[0];
                        prop_assert!(l.insert_pane_near(near, pick, dir, ratio, false));
                    }
                }
                _ => { let _ = l.swap_panes(pick, ids[(i + 1) % ids.len()]); }
            }
            prop_assert_eq!(l.pane_ids().into_iter().collect::<BTreeSet<_>>(), model.clone());
            prop_assert!(l.pane_ids().contains(&l.focused()));
            let panes: Vec<PaneInfo> = l.panes(area);
            let mut cells = 0u32;
            for p in &panes {
                let r = p.rect;
                prop_assert!(r.x >= area.x && r.y >= area.y && r.right() <= area.right() && r.bottom() <= area.bottom());
                cells += u32::from(r.width) * u32::from(r.height);
                for q in &panes {
                    if q.id != p.id {
                        prop_assert!(r.intersection(q.rect).area() == 0, "{:?} overlaps {:?}", p.id, q.id);
                    }
                }
            }
            prop_assert_eq!(cells, u32::from(w) * u32::from(h), "gap or overlap");
            let back = TileLayout::restore(l.save()).unwrap();
            prop_assert_eq!(back, l.clone());
        }
    }
}
