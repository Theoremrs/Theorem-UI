//! AC-61: the layout boundary replayed through its public API only, with no
//! panel kind anywhere (a pane is just an id). Every test checks the tiling of
//! the solved rectangles cell by cell rather than trusting the arithmetic.

use ratatui::layout::{Direction, Rect};
use std::collections::BTreeSet;
use theorem_workbench_layout::{
    LayoutError, NavDirection, Node, PaneId, PaneInfo, SavedLayout, TileLayout, find_in_direction,
};

const AREAS: [(u16, u16); 9] = [
    (0, 0),
    (1, 1),
    (3, 2),
    (7, 5),
    (20, 10),
    (80, 24),
    (160, 40),
    (257, 101),
    (400, 200),
];

fn pane(n: u32) -> PaneId {
    PaneId::from_raw(n)
}

/// Every cell of `area` is covered by exactly one pane rectangle, nothing lies
/// outside it, and the rectangles belong to exactly the panes the layout lists.
fn assert_exact_partition(layout: &TileLayout, area: Rect) {
    let panes = layout.panes(area);
    let listed: Vec<PaneId> = panes.iter().map(|p| p.id).collect();
    assert_eq!(listed, layout.pane_ids(), "panes() and pane_ids() disagree");
    assert_eq!(panes.len(), layout.pane_count());
    let mut grid = vec![0u8; usize::from(area.width) * usize::from(area.height)];
    for p in &panes {
        let r = p.rect;
        assert!(
            r.x >= area.x
                && r.y >= area.y
                && r.right() <= area.right()
                && r.bottom() <= area.bottom(),
            "{:?} lies outside {area:?}",
            r
        );
        for y in r.y..r.bottom() {
            for x in r.x..r.right() {
                grid[usize::from(y - area.y) * usize::from(area.width)
                    + usize::from(x - area.x)] += 1;
            }
        }
    }
    assert!(
        grid.iter().all(|c| *c == 1),
        "cells are uncovered or covered twice in {area:?}"
    );
}

fn assert_tiles_at_every_area(layout: &TileLayout) {
    for (w, h) in AREAS {
        assert_exact_partition(layout, Rect::new(0, 0, w, h));
        // And away from the origin, since offsets are where tiling code slips.
        assert_exact_partition(layout, Rect::new(5, 3, w, h));
    }
}

fn id_set(layout: &TileLayout) -> BTreeSet<PaneId> {
    layout.pane_ids().into_iter().collect()
}

/// Always splits the newest pane, alternating direction: the deepest chain.
fn deep_chain(depth: u32) -> TileLayout {
    let (mut l, mut last) = TileLayout::new();
    for i in 0..depth {
        let dir = if i % 2 == 0 {
            Direction::Horizontal
        } else {
            Direction::Vertical
        };
        last = l.split_pane(last, dir, 0.5).unwrap();
        l.focus_pane(last);
    }
    l
}

/// Splits every leaf in turn, alternating by level: a balanced tree.
fn balanced(levels: u32) -> TileLayout {
    let (mut l, _) = TileLayout::new();
    for level in 0..levels {
        let dir = if level % 2 == 0 {
            Direction::Horizontal
        } else {
            Direction::Vertical
        };
        for id in l.pane_ids() {
            l.split_pane(id, dir, 0.5).unwrap();
        }
    }
    l
}

#[test]
fn splits_in_both_directions_to_depth_tile_every_area_exactly() {
    let mut l = deep_chain(10);
    assert_eq!(l.pane_count(), 11);
    assert_tiles_at_every_area(&l);
    // Uneven ratios and the clamped extremes too.
    let ids = l.pane_ids();
    l.split_pane(ids[3], Direction::Vertical, 0.1).unwrap();
    l.split_pane(ids[5], Direction::Horizontal, 0.9).unwrap();
    l.split_pane(ids[7], Direction::Horizontal, 7.0).unwrap();
    assert_eq!(l.pane_count(), 14);
    assert_tiles_at_every_area(&l);
    assert_tiles_at_every_area(&balanced(5));
}

#[test]
fn a_big_enough_area_gives_every_pane_cells_and_a_tiny_one_only_empty_panes() {
    // The layout promises exact tiling, not a minimum size: the dock owns the
    // minimums. So a pane may be empty when the area is smaller than the tree.
    let l = balanced(4);
    for p in l.panes(Rect::new(0, 0, 160, 40)) {
        assert!(
            p.rect.width > 0 && p.rect.height > 0,
            "{:?} is empty at 160x40",
            p.id
        );
    }
    let tiny = l.panes(Rect::new(0, 0, 3, 2));
    assert_eq!(tiny.len(), 16);
    assert!(tiny.iter().any(|p| p.rect.width == 0 || p.rect.height == 0));
    assert_exact_partition(&l, Rect::new(0, 0, 3, 2));
}

#[test]
fn splitting_keeps_every_existing_id_and_adds_exactly_one() {
    let (mut l, root) = TileLayout::new();
    let mut expect = BTreeSet::from([root]);
    let mut target = root;
    for i in 0..12 {
        let dir = if i % 3 == 0 {
            Direction::Vertical
        } else {
            Direction::Horizontal
        };
        let before = id_set(&l);
        let new = l.split_pane(target, dir, 0.5).unwrap();
        assert!(!before.contains(&new), "a live id was handed out again");
        expect.insert(new);
        assert_eq!(id_set(&l), expect);
        target = new;
    }
}

#[test]
fn moving_a_pane_beside_another_keeps_its_id_and_the_tiling() {
    let mut l = deep_chain(5);
    let ids = l.pane_ids();
    let (moved, target) = (ids[1], ids[4]);
    let before = id_set(&l);
    assert!(l.close_pane(moved));
    assert!(l.insert_pane_near(target, moved, Direction::Vertical, 0.4, true));
    assert_eq!(id_set(&l), before, "a move must not add or drop an id");
    assert_eq!(l.focused(), moved);
    assert_tiles_at_every_area(&l);

    // A swap exchanges positions and nothing else.
    let ids = l.pane_ids();
    assert!(l.swap_panes(ids[0], ids[3]));
    assert_eq!(id_set(&l), before);
    assert_tiles_at_every_area(&l);
}

#[test]
fn a_refused_move_changes_nothing() {
    let mut l = deep_chain(3);
    let ids = l.pane_ids();
    let before = l.clone();
    assert!(!l.insert_pane_near(ids[0], ids[1], Direction::Horizontal, 0.5, true)); // already in the tree
    assert!(!l.insert_pane_near(ids[0], ids[0], Direction::Horizontal, 0.5, true));
    assert!(!l.insert_pane_near(pane(99), pane(98), Direction::Horizontal, 0.5, true)); // no such target
    assert!(!l.swap_panes(ids[0], pane(99)));
    assert_eq!(l, before);
}

#[test]
fn focus_moves_in_all_four_directions_follow_the_rectangles() {
    // Left column split top and bottom, right column split top and bottom:
    //   a | b
    //   c | d
    let (mut l, a) = TileLayout::new();
    let b = l.split_pane(a, Direction::Horizontal, 0.5).unwrap();
    let c = l.split_pane(a, Direction::Vertical, 0.5).unwrap();
    let d = l.split_pane(b, Direction::Vertical, 0.5).unwrap();
    let panes = l.panes(Rect::new(0, 0, 80, 24));
    let info = |id: PaneId| -> &PaneInfo { panes.iter().find(|p| p.id == id).unwrap() };
    let go = |from: PaneId, dir| find_in_direction(info(from), dir, &panes);
    assert_eq!(go(a, NavDirection::Right), Some(b));
    assert_eq!(go(a, NavDirection::Down), Some(c));
    assert_eq!(go(d, NavDirection::Left), Some(c));
    assert_eq!(go(d, NavDirection::Up), Some(b));
    assert_eq!(go(c, NavDirection::Right), Some(d));
    assert_eq!(go(b, NavDirection::Down), Some(d));
    assert_eq!(go(c, NavDirection::Up), Some(a));
    assert_eq!(go(b, NavDirection::Left), Some(a));
    // Nothing lies beyond the edges, and the answer is never the pane itself.
    for (from, dir) in [
        (a, NavDirection::Left),
        (a, NavDirection::Up),
        (b, NavDirection::Right),
        (b, NavDirection::Up),
        (c, NavDirection::Left),
        (c, NavDirection::Down),
        (d, NavDirection::Right),
        (d, NavDirection::Down),
    ] {
        assert_eq!(go(from, dir), None, "{from:?} {dir:?}");
    }
    // Moving focus with focus_pane changes focus only, never the id set or the tiling.
    let ids = id_set(&l);
    l.focus_pane(d);
    assert_eq!((l.focused(), id_set(&l)), (d, ids));
    assert_tiles_at_every_area(&l);
}

#[test]
fn a_restored_layout_keeps_every_id_focus_and_rectangle() {
    let mut l = balanced(3);
    let ids = l.pane_ids();
    l.focus_pane(ids[5]);
    l.focus_pane(ids[2]);
    let fresh = l.split_pane(ids[0], Direction::Vertical, 0.3).unwrap();
    l.close_pane(ids[6]);
    let json = serde_json::to_string(&l.save()).unwrap();
    let saved: SavedLayout = serde_json::from_str(&json).unwrap();
    let mut back = TileLayout::restore(saved).unwrap();
    assert_eq!(back, l);
    assert_eq!(back.pane_ids(), l.pane_ids());
    assert_eq!(
        (back.focused(), back.prev_focused()),
        (l.focused(), l.prev_focused())
    );
    for (w, h) in AREAS {
        let a = Rect::new(0, 0, w, h);
        let rects = |x: &TileLayout| {
            x.panes(a)
                .iter()
                .map(|p| (p.id, p.rect))
                .collect::<Vec<_>>()
        };
        assert_eq!(rects(&back), rects(&l));
    }
    assert_tiles_at_every_area(&back);
    // The closed id and the live ones are not handed out again after a restore.
    let next = back.split_pane(fresh, Direction::Horizontal, 0.5).unwrap();
    assert!(!ids.contains(&next) && next != fresh);
}

#[test]
fn closing_down_to_the_last_pane_then_the_last_one_leaves_one_whole_pane() {
    let mut l = balanced(3);
    let area = Rect::new(0, 0, 80, 24);
    let mut left = l.pane_count();
    while left > 1 {
        let closed = l.focused();
        let before = id_set(&l);
        assert!(l.close_focused());
        left -= 1;
        let mut expect = before;
        expect.remove(&closed);
        assert_eq!(
            id_set(&l),
            expect,
            "closing must drop exactly the closed pane"
        );
        assert!(
            l.pane_ids().contains(&l.focused()),
            "focus must name a live pane"
        );
        assert_exact_partition(&l, area);
    }
    let only = l.focused();
    assert_eq!(l.panes(area)[0].rect, area);
    let before = l.clone();
    assert!(!l.close_focused(), "the last pane must not close");
    assert!(
        !l.close_pane(only),
        "the last pane must not close by id either"
    );
    assert_eq!(l, before);
    assert_eq!(l.panes(area)[0].rect, area);
}

#[test]
fn a_closed_pane_and_an_unknown_pane_are_refused_the_same_way() {
    let mut l = deep_chain(2);
    let ids = l.pane_ids();
    assert!(l.close_pane(ids[1]));
    let before = l.clone();
    assert!(!l.close_pane(ids[1]));
    assert!(!l.close_pane(pane(500)));
    assert_eq!(l, before);
}

#[test]
fn restore_refuses_a_tree_that_names_a_pane_it_does_not_contain() {
    // Layout has no panel kinds, so the nearest thing to a kind that no longer
    // exists is an id that no longer exists. It must be an error, not a panic.
    let l = deep_chain(2);
    let mut s = l.save();
    s.focus = pane(404);
    assert_eq!(
        TileLayout::restore(s),
        Err(LayoutError::FocusMissing(pane(404)))
    );
    let s = SavedLayout {
        root: Node::Pane(pane(1)),
        focus: pane(1),
        prev_focus: Some(pane(2)),
        next_id: 0,
    };
    assert_eq!(
        TileLayout::restore(s),
        Err(LayoutError::PreviousFocusMissing(pane(2)))
    );
}

/// By type: every public operation of the layout answers with a view change or
/// a refusal (`bool`, an id, a rectangle list), never with an intent a host
/// could act on. A new return type, or a new public item, breaks this test and
/// has to be looked at.
#[test]
fn every_public_operation_answers_with_view_data_only() {
    let _: fn(&mut TileLayout, PaneId, Direction, f32) -> Option<PaneId> = TileLayout::split_pane;
    let _: fn(&mut TileLayout, PaneId, PaneId, Direction, f32) -> bool =
        TileLayout::split_pane_with;
    let _: fn(&mut TileLayout, PaneId, PaneId, Direction, f32, bool) -> bool =
        TileLayout::insert_pane_near;
    let _: fn(&mut TileLayout) -> bool = TileLayout::close_focused;
    let _: fn(&mut TileLayout, PaneId) -> bool = TileLayout::close_pane;
    let _: fn(&mut TileLayout, PaneId) = TileLayout::focus_pane;
    let _: fn(&mut TileLayout, PaneId, PaneId) -> bool = TileLayout::swap_panes;
    let _: fn(&mut TileLayout, &[bool], f32) -> bool = TileLayout::set_ratio_at;
    let _: fn(&mut TileLayout, NavDirection, f32, Rect) = TileLayout::resize_focused;
    let _: fn(&TileLayout, Rect) -> Vec<PaneInfo> = TileLayout::panes;
    let _: fn(SavedLayout) -> Result<TileLayout, LayoutError> = TileLayout::restore;
    let _: fn(&TileLayout) -> SavedLayout = TileLayout::save;
}

/// By source: the crate names no process, thread, file, socket, environment or
/// `unsafe` facility. (The dependency side is checked by
/// `scripts/check-layout-isolation.mjs`.)
#[test]
fn the_layout_source_names_no_process_thread_file_socket_or_unsafe_facility() {
    let src = include_str!("../src/lib.rs");
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
        assert!(!src.contains(word), "layout source mentions `{word}`");
    }
}
