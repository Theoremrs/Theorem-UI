#![allow(dead_code)]
use ratatui::layout::Rect;
use theorem_workbench_dock::*;

pub fn m() -> CellMetrics {
    CellMetrics::new(8.0, 16.0)
}

pub fn area(w: u16, h: u16) -> Rect {
    Rect::new(0, 0, w, h)
}

pub fn kind(name: &str) -> PanelKind {
    PanelKind::new(name, 1)
}

pub fn tab(id: &str) -> Tab {
    Tab::new(id, kind(id), id)
}

pub fn pid(id: &str) -> PanelId {
    id.into()
}

/// Default preset with files, theo (main), changes and shell (tools) open.
pub fn default_dock() -> (Dock, Regions) {
    let (mut d, r) = Dock::from_preset(DockConfig::default(), Preset::Default);
    d.open_panel(tab("files"), OpenAt::Group(r.files)).unwrap();
    d.open_panel(tab("theo"), OpenAt::Group(r.main)).unwrap();
    d.open_panel(tab("changes"), OpenAt::Group(r.tools))
        .unwrap();
    d.open_panel(tab("shell"), OpenAt::Group(r.tools)).unwrap();
    d.focus_group(r.main).unwrap();
    (d, r)
}

/// Every cell of `area` belongs to exactly one group or gutter, and nothing
/// lies outside it. Only meaningful for a Tiled frame without an open drawer.
pub fn assert_exact_tiling(frame: &SolvedFrame) {
    let a = frame.area;
    let mut grid = vec![0u8; usize::from(a.width) * usize::from(a.height)];
    let rects = frame
        .groups
        .iter()
        .filter(|g| !g.overlay)
        .map(|g| g.rect)
        .chain(frame.splitters.iter().map(|s| s.rect));
    for r in rects {
        assert!(
            r.x >= a.x && r.y >= a.y && r.right() <= a.right() && r.bottom() <= a.bottom(),
            "{r:?} outside {a:?}"
        );
        for y in r.y..r.bottom() {
            for x in r.x..r.right() {
                grid[usize::from(y - a.y) * usize::from(a.width) + usize::from(x - a.x)] += 1;
            }
        }
    }
    assert!(
        grid.iter().all(|c| *c == 1),
        "area is not tiled exactly once"
    );
}
