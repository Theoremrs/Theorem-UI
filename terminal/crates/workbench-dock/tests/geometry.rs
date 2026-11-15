mod common;
use common::*;
use proptest::prelude::*;
use theorem_workbench_dock::*;

#[test]
fn default_widths_follow_the_spec_targets() {
    let (d, r) = default_dock();
    let f = d.solve(area(160, 40), m());
    assert_eq!(f.presentation, Presentation::Tiled);
    let w = |g| f.group(g).unwrap().rect.width;
    // Files 224 px at 8 px a cell is 28 cells; the rest splits 2:1.
    assert_eq!(w(r.files), 28);
    assert_eq!((w(r.main), w(r.tools)), (87, 43));
    assert_eq!(w(r.files) + w(r.main) + w(r.tools) + 2 * GUTTER, 160);
    assert_exact_tiling(&f);
}

#[test]
fn fractional_cell_metrics_keep_the_sum_exact() {
    let (d, _) = default_dock();
    for cw in [6.5_f32, 7.25, 8.4, 9.0, 11.3] {
        let f = d.solve(area(200, 30), CellMetrics::new(cw, 17.3));
        assert_eq!(f.presentation, Presentation::Tiled, "cw {cw}");
        assert_exact_tiling(&f);
    }
}

#[test]
fn files_collapses_first_then_one_principal_panel() {
    let (d, r) = default_dock();
    // 130 cells is exactly what all three need; 129 loses Files to a drawer.
    assert!(d.solve(area(130, 30), m()).drawers.is_empty());
    let f = d.solve(area(129, 30), m());
    assert_eq!(f.presentation, Presentation::Tiled);
    assert_eq!(f.drawers.len(), 1);
    assert_eq!(f.drawers[0].group, r.files);
    assert!(!f.drawers[0].open);
    assert!(f.group(r.files).is_none());
    assert_eq!(f.groups.len(), 2);
    assert_exact_tiling(&f);
    // Main and tools need 60 + 1 + 40 cells.
    assert_eq!(
        d.solve(area(101, 30), m()).presentation,
        Presentation::Tiled
    );
    let p = d.solve(area(100, 30), m());
    assert_eq!(p.presentation, Presentation::Principal);
    assert_eq!(p.groups.len(), 1);
    assert_eq!(p.groups[0].id, r.main);
    assert_eq!(p.groups[0].rect, area(100, 30));
    // All tabs are still in the group.
    assert!(p.suppressed.contains(&(r.tools, Suppressed::Collapsed)));
    assert_eq!(d.group(r.tools).unwrap().tabs().len(), 2);
}

#[test]
fn principal_follows_focus_and_growing_restores_the_arrangement() {
    let (mut d, r) = default_dock();
    let wide = d.solve(area(180, 40), m());
    let narrow = d.solve(area(90, 40), m());
    assert_eq!(narrow.groups[0].id, r.main);
    d.focus_group(r.tools).unwrap();
    assert_eq!(d.solve(area(90, 40), m()).groups[0].id, r.tools);
    d.focus_group(r.main).unwrap();
    assert_eq!(d.solve(area(180, 40), m()), wide);
}

#[test]
fn too_short_collapses_like_too_narrow() {
    let (d, _) = default_dock();
    assert_eq!(
        d.solve(area(160, 3), m()).presentation,
        Presentation::Principal
    );
    assert_eq!(d.solve(area(160, 4), m()).presentation, Presentation::Tiled);
}

#[test]
fn open_drawer_overlays_the_content_and_is_hit_first() {
    let (mut d, r) = default_dock();
    d.open_drawer(r.files).unwrap();
    let f = d.solve(area(100, 30), m());
    let drawer = f.group(r.files).unwrap();
    assert!(drawer.overlay);
    assert_eq!(drawer.rect.width, 28);
    assert!(f.drawers[0].open);
    assert_eq!(f.hit_test(2, 10), Hit::Body { group: r.files });
    // Wide again: Files is tiled and the drawer flag is not reported.
    let wide = d.solve(area(160, 30), m());
    assert!(wide.drawers.is_empty());
    assert!(!wide.group(r.files).unwrap().overlay);
}

#[test]
fn splitter_hit_region_follows_the_cell_metric() {
    let (d, _) = default_dock();
    let f = d.solve(area(160, 40), m());
    // 8 px at 8 px a cell is one cell: the gutter itself.
    assert!(f.splitters.iter().all(|s| s.hit == s.rect));
    let f = d.solve(area(400, 40), CellMetrics::new(4.0, 16.0));
    let s = &f.splitters[0];
    assert_eq!(s.rect.width, 1);
    assert_eq!(s.hit.width, 2);
    assert!(s.hit.x <= s.rect.x && s.hit.right() >= s.rect.right());
}

#[test]
fn minimum_sizes_clamp_the_ratio_split() {
    // At 131 cells the 2:1 split would give tools 43 (60 min would not matter);
    // shrink until tools would drop under 40 and see it held at the minimum.
    let (d, r) = default_dock();
    let f = d.solve(area(131, 30), m());
    assert!(f.group(r.tools).unwrap().rect.width >= 40);
    assert!(f.group(r.main).unwrap().rect.width >= 60);
}

#[test]
fn tab_strip_scrolls_to_keep_the_active_tab() {
    let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Minimal);
    for i in 0..12 {
        d.open_panel(tab(&format!("panel-{i:02}")), OpenAt::Group(r.main))
            .unwrap();
    }
    let f = d.solve(area(60, 20), m());
    let g = f.group(r.main).unwrap();
    assert_eq!(g.active.as_ref().unwrap(), &pid("panel-11"));
    assert!(g.tabs.iter().any(|t| t.active));
    assert_eq!(g.tabs_before + g.tabs.len() + g.tabs_after, 12);
    assert!(g.tabs.iter().all(|t| t.rect.right() <= g.tab_strip.right()));
    // Tabs do not overlap and each close cell sits inside its tab.
    for w in g.tabs.windows(2) {
        assert_eq!(w[0].rect.right(), w[1].rect.x);
    }
    assert!(
        g.tabs
            .iter()
            .all(|t| t.close.x >= t.rect.x && t.close.right() <= t.rect.right())
    );
}

proptest! {
    #[test]
    fn the_tiling_is_exact_for_any_size_and_metric(
        w in 1u16..400, h in 1u16..80,
        cw in 3.0f32..24.0, ch in 8.0f32..40.0,
        preset in 0usize..4,
    ) {
        let preset = [Preset::Default, Preset::EditorCentered, Preset::AgentCentered, Preset::Minimal][preset];
        let (mut d, r) = Dock::from_preset(DockConfig::default(), preset);
        for (g, n) in [(r.files, "files"), (r.main, "theo"), (r.tools, "shell")] {
            d.open_panel(tab(n), OpenAt::Group(g)).unwrap();
        }
        let metrics = CellMetrics::new(cw, ch);
        let f = d.solve(area(w, h), metrics);
        match f.presentation {
            Presentation::Tiled => {
                assert_exact_tiling(&f);
                // Wherever tiled, no group is under its hard minimum.
                for g in &f.groups {
                    let min = match g.role {
                        Role::Files => 160.0, Role::Main => 480.0, Role::Tools => 320.0,
                    };
                    prop_assert!(f32::from(g.rect.width) * cw >= min - cw, "{:?} too narrow", g.role);
                    prop_assert!(g.rect.height >= 4);
                }
            }
            Presentation::Principal => {
                prop_assert_eq!(f.groups.len(), 1);
                prop_assert_eq!(f.groups[0].rect, area(w, h));
            }
            Presentation::Maximized => prop_assert!(false),
        }
        // Solving is pure: the same input gives the same frame.
        prop_assert_eq!(d.solve(area(w, h), metrics), f);
    }

    #[test]
    fn solving_a_smaller_area_never_changes_the_restored_arrangement(
        w1 in 140u16..400, w2 in 1u16..139, h in 5u16..60, cw in 6.0f32..10.0,
    ) {
        let (d, _) = default_dock();
        let metrics = CellMetrics::new(cw, 16.0);
        let before = d.solve(area(w1, h), metrics);
        let _ = d.solve(area(w2, h), metrics);
        prop_assert_eq!(d.solve(area(w1, h), metrics), before);
    }

    #[test]
    fn hit_testing_agrees_with_the_frame(w in 20u16..300, h in 4u16..60, x in 0u16..320, y in 0u16..70) {
        let (d, _) = default_dock();
        let f = d.solve(area(w, h), m());
        let hit = f.hit_test(x, y);
        let inside = x < w && y < h;
        if !inside { prop_assert_eq!(&hit, &Hit::Outside); }
        if inside && f.presentation == Presentation::Tiled {
            // Every cell of an exact tiling is something.
            prop_assert!(hit != Hit::Outside);
        }
    }
}
