mod common;
use common::*;
use theorem_workbench_dock::*;

fn panels(d: &Dock, g: GroupId) -> Vec<String> {
    d.group(g)
        .unwrap()
        .tabs()
        .iter()
        .map(|t| t.panel.0.clone())
        .collect()
}

fn active(d: &Dock, g: GroupId) -> Option<String> {
    d.group(g).unwrap().active().map(|t| t.panel.0.clone())
}

#[test]
fn open_in_a_group_activates_and_focuses() {
    let (mut d, r) = default_dock();
    assert_eq!(panels(&d, r.tools), ["changes", "shell"]);
    assert_eq!(active(&d, r.tools).as_deref(), Some("shell"));
    assert_eq!(d.focused(), r.main);
    d.open_panel(tab("third"), OpenAt::Group(r.tools)).unwrap();
    assert_eq!(d.focused(), r.tools);
    assert_eq!(
        d.open_panel(tab("shell"), OpenAt::Group(r.main)),
        Err(DockError::DuplicatePanel(pid("shell")))
    );
    assert_eq!(
        d.open_panel(tab("x"), OpenAt::Group(GroupId::from_raw(99))),
        Err(DockError::UnknownGroup(GroupId::from_raw(99)))
    );
}

#[test]
fn open_as_a_new_split_in_every_direction() {
    for side in [
        NavDirection::Left,
        NavDirection::Right,
        NavDirection::Up,
        NavDirection::Down,
    ] {
        let (mut d, r) = default_dock();
        let n = d
            .open_panel(
                tab("docs"),
                OpenAt::Split {
                    group: r.main,
                    side,
                    role: None,
                },
            )
            .unwrap();
        assert_eq!(d.group(n).unwrap().role(), Role::Main);
        assert_eq!(d.focused(), n);
        let f = d.solve(area(260, 60), m());
        let (a, b) = (f.group(n).unwrap().rect, f.group(r.main).unwrap().rect);
        let ordered = match side {
            NavDirection::Left => a.x < b.x,
            NavDirection::Right => b.x < a.x,
            NavDirection::Up => a.y < b.y,
            NavDirection::Down => b.y < a.y,
        };
        assert!(ordered, "{side:?}");
        assert_exact_tiling(&f);
    }
}

#[test]
fn a_split_opens_no_process_it_only_adds_an_empty_destination() {
    let (mut d, r) = default_dock();
    let n = d.split_empty(r.tools, NavDirection::Down, None).unwrap();
    assert!(d.group(n).unwrap().tabs().is_empty());
    assert_eq!(d.group_ids().len(), 4);
    // An empty group still tiles and has a tab strip with no tabs.
    let f = d.solve(area(200, 50), m());
    assert!(f.group(n).unwrap().tabs.is_empty());
    assert_exact_tiling(&f);
}

#[test]
fn files_split_gets_a_pixel_target() {
    let (mut d, r) = default_dock();
    let g = d
        .split_empty(r.main, NavDirection::Left, Some(Role::Files))
        .unwrap();
    assert_eq!(d.group(g).unwrap().pinned_px(), Some(224.0));
}

#[test]
fn focus_and_activate() {
    let (mut d, r) = default_dock();
    assert_eq!(d.focus_panel(&pid("changes")), Ok(r.tools));
    assert_eq!(active(&d, r.tools).as_deref(), Some("changes"));
    assert_eq!(
        d.focus_panel(&pid("nope")),
        Err(DockError::UnknownPanel(pid("nope")))
    );
    d.focus_group(r.files).unwrap();
    assert_eq!(d.focused(), r.files);
    assert_eq!(
        d.focus_group(GroupId::from_raw(50)),
        Err(DockError::UnknownGroup(GroupId::from_raw(50)))
    );
}

#[test]
fn closing_a_tab_picks_a_neighbour_and_the_last_tab_collapses_the_leaf() {
    let (mut d, r) = default_dock();
    d.open_panel(tab("third"), OpenAt::Group(r.tools)).unwrap();
    d.focus_panel(&pid("shell")).unwrap();
    assert_eq!(d.close_tab(&pid("shell")), Ok(false));
    assert_eq!(active(&d, r.tools).as_deref(), Some("third"));
    d.close_tab(&pid("third")).unwrap();
    assert_eq!(active(&d, r.tools).as_deref(), Some("changes"));
    assert_eq!(d.close_tab(&pid("changes")), Ok(true));
    assert!(d.group(r.tools).is_none());
    assert_eq!(d.group_ids().len(), 2);
    assert!(d.group_ids().contains(&d.focused()));
    assert_exact_tiling(&d.solve(area(160, 40), m()));
}

#[test]
fn the_last_panel_cannot_be_closed() {
    let (mut d, g) = Dock::new(DockConfig::default(), Role::Main);
    d.open_panel(tab("only"), OpenAt::Group(g)).unwrap();
    let before = d.clone();
    assert_eq!(d.close_tab(&pid("only")), Err(DockError::LastPanel));
    assert_eq!(d, before);
    assert_eq!(
        d.close_tab(&pid("ghost")),
        Err(DockError::UnknownPanel(pid("ghost")))
    );
}

#[test]
fn move_a_tab_between_groups_and_remove_the_emptied_group() {
    let (mut d, r) = default_dock();
    d.move_tab(&pid("shell"), r.main, Some(0)).unwrap();
    assert_eq!(panels(&d, r.main), ["shell", "theo"]);
    assert_eq!(active(&d, r.main).as_deref(), Some("shell"));
    assert_eq!(panels(&d, r.tools), ["changes"]);
    assert_eq!(d.focused(), r.main);
    d.move_tab(&pid("changes"), r.main, None).unwrap();
    assert!(d.group(r.tools).is_none());
    assert_eq!(panels(&d, r.main), ["shell", "theo", "changes"]);
    assert_eq!(
        d.move_tab(&pid("theo"), r.main, Some(9)),
        Err(DockError::IndexOutOfRange { index: 9, len: 3 })
    );
}

#[test]
fn move_a_tab_to_a_new_split() {
    let (mut d, r) = default_dock();
    let n = d
        .move_tab_to_split(&pid("shell"), r.main, NavDirection::Down)
        .unwrap();
    assert_eq!(panels(&d, n), ["shell"]);
    assert_eq!(panels(&d, r.tools), ["changes"]);
    let f = d.solve(area(200, 60), m());
    assert!(f.group(n).unwrap().rect.y > f.group(r.main).unwrap().rect.y);
    // Splitting a group off itself works when it keeps another tab.
    let m2 = d.move_tab_to_split(&pid("changes"), r.tools, NavDirection::Left);
    assert_eq!(m2, Err(DockError::InvalidMove));
    d.open_panel(tab("extra"), OpenAt::Group(r.tools)).unwrap();
    let ok = d
        .move_tab_to_split(&pid("extra"), r.tools, NavDirection::Left)
        .unwrap();
    assert_eq!(panels(&d, ok), ["extra"]);
    // A source left empty is removed.
    let before = d.group_ids().len();
    d.move_tab_to_split(&pid("changes"), n, NavDirection::Right)
        .unwrap();
    assert_eq!(d.group_ids().len(), before);
    assert!(d.group(r.tools).is_none());
}

#[test]
fn reorder_keeps_the_active_tab_active() {
    let (mut d, r) = default_dock();
    d.open_panel(tab("c"), OpenAt::Group(r.tools)).unwrap();
    d.focus_panel(&pid("changes")).unwrap();
    d.reorder_tab(&pid("changes"), 2).unwrap();
    assert_eq!(panels(&d, r.tools), ["shell", "c", "changes"]);
    assert_eq!(active(&d, r.tools).as_deref(), Some("changes"));
    assert_eq!(
        d.reorder_tab(&pid("c"), 3),
        Err(DockError::IndexOutOfRange { index: 3, len: 3 })
    );
}

#[test]
fn resize_by_cells_moves_the_splitter_and_clears_the_pixel_target() {
    let (mut d, r) = default_dock();
    let a = area(200, 40);
    let f = d.solve(a, m());
    let tools_before = f.group(r.tools).unwrap().rect.width;
    let main_path = f
        .splitters
        .iter()
        .find(|s| s.rect.x > 40)
        .unwrap()
        .path
        .clone();
    d.resize_split(&main_path, -5, a, m()).unwrap();
    let f2 = d.solve(a, m());
    assert_eq!(f2.group(r.tools).unwrap().rect.width, tools_before + 5);
    assert_exact_tiling(&f2);
    // Grow Files from its right edge: the target becomes a ratio.
    d.resize_group_edge(r.files, NavDirection::Right, 10, a, m())
        .unwrap();
    assert_eq!(d.group(r.files).unwrap().pinned_px(), None);
    assert_eq!(d.solve(a, m()).group(r.files).unwrap().rect.width, 38);
    // Same ratio at another width scales rather than snapping back to 224 px.
    assert!(
        d.solve(area(300, 40), m())
            .group(r.files)
            .unwrap()
            .rect
            .width
            > 38
    );
}

#[test]
fn resize_refuses_below_a_minimum_and_says_how_far_it_may_go() {
    let (mut d, r) = default_dock();
    let a = area(200, 40);
    let f = d.solve(a, m());
    let s = f.splitters.iter().find(|s| s.rect.x > 40).unwrap();
    let path = s.path.clone();
    let tools = f.group(r.tools).unwrap().rect.width;
    let before = d.clone();
    // Shrinking tools below its 40-cell minimum is refused.
    let err = d
        .resize_split(&path, i32::from(tools) - 30, a, m())
        .unwrap_err();
    let DockError::BelowMinimum { allowed } = err else {
        panic!("{err:?}")
    };
    assert_eq!(allowed, i32::from(tools) - 40);
    assert_eq!(d, before);
    d.resize_split(&path, allowed, a, m()).unwrap();
    assert_eq!(d.solve(a, m()).group(r.tools).unwrap().rect.width, 40);
    // Pixel-pinned Files cannot go under 160 px (20 cells) either.
    let err = d
        .resize_group_edge(r.files, NavDirection::Right, -20, a, m())
        .unwrap_err();
    assert_eq!(err, DockError::BelowMinimum { allowed: -8 });
    assert_eq!(
        d.resize_split(&[true, true], 1, a, m()),
        Err(DockError::UnknownSplit)
    );
    assert_eq!(
        d.resize_group_edge(r.files, NavDirection::Left, 1, a, m()),
        Err(DockError::NoSplitter(NavDirection::Left))
    );
}

#[test]
fn maximize_and_restore_one_group() {
    let (mut d, r) = default_dock();
    let a = area(160, 40);
    let tiled = d.solve(a, m());
    d.maximize(r.tools).unwrap();
    let f = d.solve(a, m());
    assert_eq!(f.presentation, Presentation::Maximized);
    assert_eq!(f.groups.len(), 1);
    assert_eq!(f.groups[0].rect, a);
    assert!(f.suppressed.contains(&(r.files, Suppressed::Maximized)));
    assert!(d.unmaximize());
    assert!(!d.unmaximize());
    assert_eq!(d.solve(a, m()), tiled_with_focus(&d, tiled));
    // Focusing another group leaves maximize.
    d.maximize(r.tools).unwrap();
    d.focus_group(r.main).unwrap();
    assert_eq!(d.maximized(), None);
}

/// Focus moved to tools by maximize; the arrangement itself is unchanged.
fn tiled_with_focus(d: &Dock, mut tiled: SolvedFrame) -> SolvedFrame {
    for g in &mut tiled.groups {
        g.focused = g.id == d.focused();
    }
    tiled.focused = Some(d.focused());
    tiled
}

#[test]
fn hide_and_show_a_region() {
    let (mut d, r) = default_dock();
    let a = area(160, 40);
    d.hide_group(r.tools).unwrap();
    let f = d.solve(a, m());
    assert!(f.group(r.tools).is_none());
    assert!(f.suppressed.contains(&(r.tools, Suppressed::Hidden)));
    assert_eq!(f.group(r.main).unwrap().rect.width, 160 - 28 - GUTTER);
    assert_exact_tiling(&f);
    d.show_group(r.tools).unwrap();
    assert!(d.solve(a, m()).group(r.tools).is_some());
    // Hiding the focused group moves focus to a visible one.
    d.focus_group(r.main).unwrap();
    d.hide_group(r.main).unwrap();
    assert_ne!(d.focused(), r.main);
    assert_eq!(d.focus_group(r.main), Err(DockError::GroupHidden(r.main)));
}

#[test]
fn the_last_visible_group_cannot_be_hidden() {
    let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Minimal);
    let before = d.clone();
    assert_eq!(d.hide_group(r.main), Err(DockError::LastVisibleGroup));
    assert_eq!(d, before);
    d.open_panel(tab("a"), OpenAt::Group(r.main)).unwrap();
    // Closing a tab whose group is the only visible one would hide everything.
    d.open_panel(tab("t"), OpenAt::Group(r.tools)).unwrap();
    d.hide_group(r.tools).unwrap();
    d.close_tab(&pid("a")).unwrap_err();
}

#[test]
fn keyboard_focus_moves_by_direction() {
    let (mut d, r) = default_dock();
    let a = area(160, 40);
    assert_eq!(d.focus_direction(NavDirection::Right, a, m()), Ok(r.tools));
    assert_eq!(
        d.focus_direction(NavDirection::Right, a, m()),
        Err(DockError::NoNeighbour(NavDirection::Right))
    );
    assert_eq!(d.focus_direction(NavDirection::Left, a, m()), Ok(r.main));
    assert_eq!(d.focus_direction(NavDirection::Left, a, m()), Ok(r.files));
    assert_eq!(d.focused(), r.files);
}

#[test]
fn hit_testing_finds_tabs_close_buttons_splitters_and_bodies() {
    let (d, r) = default_dock();
    let f = d.solve(area(160, 40), m());
    let tools = f.group(r.tools).unwrap();
    let t = &tools.tabs[0];
    assert_eq!(
        f.hit_test(t.rect.x + 1, t.rect.y),
        Hit::Tab {
            group: r.tools,
            panel: pid("changes")
        }
    );
    assert_eq!(
        f.hit_test(t.close.x, t.close.y),
        Hit::TabClose {
            group: r.tools,
            panel: pid("changes")
        }
    );
    let end = tools.tabs.last().unwrap().rect.right();
    assert_eq!(
        f.hit_test(end, tools.tab_strip.y),
        Hit::TabStrip { group: r.tools }
    );
    assert_eq!(
        f.hit_test(tools.body.x + 1, tools.body.y + 3),
        Hit::Body { group: r.tools }
    );
    let s = &f.splitters[0];
    assert_eq!(
        f.hit_test(s.rect.x, 7),
        Hit::Splitter {
            path: s.path.clone()
        }
    );
    assert_eq!(f.hit_test(500, 500), Hit::Outside);
}

#[test]
fn presets_arrange_the_three_regions() {
    let a = area(200, 40);
    for (preset, visible) in [
        (Preset::Default, 3),
        (Preset::EditorCentered, 2),
        (Preset::AgentCentered, 2),
        (Preset::Minimal, 1),
    ] {
        let (d, r) = Dock::from_preset(DockConfig::default(), preset);
        let f = d.solve(a, m());
        assert_eq!(f.groups.len(), visible, "{preset:?}");
        assert_exact_tiling(&f);
        assert!(f.group(r.main).is_some());
    }
    let (d, r) = Dock::from_preset(DockConfig::default(), Preset::AgentCentered);
    let f = d.solve(a, m());
    // 3:1 of a 199-cell remainder, less the gutter.
    assert_eq!(f.group(r.main).unwrap().rect.width, 149);
    assert_eq!(f.group(r.tools).unwrap().rect.width, 50);
}
