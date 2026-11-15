# Herdr layout donor: extraction and proof (Gate 0)

Crate: `terminal/crates/workbench-layout` (package `theorem-workbench-layout`). Spec refs: section 4.3, S19, R05, R06.

## Donor pin

| Item | Value |
| --- | --- |
| Repo | `herdrdev/herdr` |
| Commit | `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` |
| Path | `src/layout.rs` |
| Git blob (verified with `git hash-object` on the fetched bytes) | `aaa207ae38119e03fb20412759f8b38a6708038e`, 45,156 bytes |
| License | Apache-2.0 (`Cargo.toml` `license = "Apache-2.0"`, herdr 0.9.5, edition 2021, ratatui 0.30) |

## License and notices carried

- `LICENSE` at the pinned commit copied byte for byte to `terminal/crates/workbench-layout/LICENSE-HERDR`.
- Herdr has no `NOTICE` file at that commit (the contents API returns 404), so none is carried.
- `src/lib.rs` starts with a header naming repo, commit, path, blob, license, and "MODIFIED".

## Modifications

1. Added the 5-line provenance header (above the donor's first line). The donor text below it is otherwise byte-identical: no donor line was edited, removed, or reordered.
2. Crate wiring only: `Cargo.toml` with `ratatui 0.30.1` (`default-features = false`, as the root crate) and `serde 1` with `derive`.
   - `serde` is needed because the donor derives `Serialize`/`Deserialize` on `PaneId`. It is pure Rust and builds for wasm32. It was kept rather than removed, to avoid editing donor code.
3. No local replacement types were needed: `layout.rs` imports only `std::cmp::Reverse`, `ratatui::layout::{Direction, Rect}` and `ratatui::widgets::Borders`. It does not import other Herdr modules.
4. `terminal/Cargo.toml` gained `[workspace] members = [".", "crates/*"]`. Nothing else in the root package changed. `terminal/Cargo.lock` gained one package entry.

Edition note: the donor is edition 2021 and compiled unchanged under 2024.

## Public API as extracted

Identity: `PaneId(u32)` (Copy, Hash, serde). `PaneId::alloc()` takes the next number from a process-global `static AtomicU32` starting at 1. `raw()` and `from_raw(u32)` read and rebuild it. The tree stores nothing but this numeric handle.

Types:
- `Node` enum: `Pane(PaneId)` or `Split { direction: ratatui Direction, ratio: f32, first: Box<Node>, second: Box<Node> }`. It is public but has no serde derive.
- `PaneInfo { id, rect, inner_rect, scrollbar_rect: Option<Rect>, borders: Borders, is_focused }`.
- `SplitBorder { pos, direction, ratio, area, path: Vec<bool> }`. `path` is root-to-node, false = first child, true = second.
- `NavDirection { Left, Right, Up, Down }`.
- `TileLayout { root, focus, prev_focus }` (fields private).

`TileLayout` methods:
- `new() -> (Self, PaneId)`, `from_saved(root: Node, focus: PaneId)`, `root() -> &Node`.
- `focused()`, `focus_pane(id)` (ignored if absent), `pane_count()`, `pane_ids()` (pre-order).
- `panes(area: Rect) -> Vec<PaneInfo>` and `splits(area) -> Vec<SplitBorder>`. Rects are integer terminal cells, computed on each call by recursive `split_rect` (`round(extent * ratio)` for the first child, the remainder for the second). Nothing is cached.
- `panes_after_split(area, target, direction, ratio)` previews rects and the new pane's index without mutating.
- `split_pane(target, direction, ratio) -> Option<PaneId>`: allocates a new id, does not move focus. `split_focused` and `split_focused_with_ratio` exist only under `#[cfg(test)]`.
- `insert_pane_near(target, moved, direction, ratio, focus) -> bool` places an existing id next to a target. It rejects `target == moved` or a duplicate.
- `close_focused()` and `close_pane(id)`: refuse the last pane. On closing the focused pane, focus returns to `prev_focus` if still open, else the next pane in pre-order (previous if last). The sibling subtree takes the removed leaf's place.
- `swap_panes(a, b)` swaps leaf ids and keeps shape and ratios.
- `set_ratio_at(path, ratio)` clamps to 0.1..0.9. `resize_focused(nav, delta, area)` and `resize_pane(id, nav, delta, area) -> bool` pick the nearest border on the requested edge, else fall back to the opposite edge, and add or subtract `delta` from that split's ratio.
- Free function `find_in_direction(focused: &PaneInfo, nav, panes: &[PaneInfo]) -> Option<PaneId>`: spatial neighbour with overlap tie-break.
- `pub(crate) valid_split_ratio`: non-finite becomes 0.5, otherwise clamped to 0.1..0.9.

Ratios are `f32`, the fraction of the split's extent given to the first child, clamped to 0.1..0.9. Focus is a single pane id plus one step of focus history.

## Tests

27 upstream tests, all kept, none edited (one test module in `lib.rs`). Result on the host: 26 passed, 0 failed, 1 ignored.

The ignored test is `bsp_layout_profile`. Upstream already marks it `#[ignore = "manual BSP allocation and traversal scaling profile"]`, because it is a timing benchmark.

Passing tests: split_paths_preserve_preorder_geometry_and_resize_targets, rejected_splits_and_insertions_preserve_layout_and_focus_history, splitting_a_deep_leaf_preserves_other_branches_and_focus, panes_after_split_predicts_the_real_split_geometry, swap_panes_exchanges_leaf_ids_without_changing_cells, swap_panes_is_noop_for_same_or_missing_pane, insert_existing_pane_near_target_preserves_existing_ids_and_focuses_moved_pane, split_focused_with_ratio_sets_new_split_ratio, resize_pane_preserves_focus_and_reports_change, resize_second_child_toward_split_decreases_ratio, resize_outer_edges_shrink_focused_pane, resize_outer_edge_falls_back_to_horizontal_ancestor_split, resize_outer_edge_falls_back_to_vertical_ancestor_split, resize_uses_split_in_same_branch_when_borders_share_coordinate, find_in_direction_tiebreaks_by_larger_overlap_before_layout_order, close_focused_returns_to_the_pane_focus_came_from, close_focused_returns_to_the_pane_that_opened_a_split, closing_a_background_pane_keeps_the_focused_pane_history, closing_the_remembered_pane_drops_the_focus_history, close_focused_uses_tree_order_without_focus_history, close_focused_does_not_reuse_history_after_it_is_consumed, resize_does_not_disturb_the_close_focus_target, split_pane_leaves_focus_and_history_untouched, split_pane_missing_target_changes_nothing, insert_pane_near_unfocused_keeps_focus_and_history, failed_split_rollback_preserves_focus_history.

## Proof

All commands run in `terminal/` with `CARGO_TARGET_DIR="/Volumes/SSD Samsung/cargo-target-theo-workbench"` (202 GiB free at start).

`cargo test -p theorem-workbench-layout`:
```
running 27 tests
... (26 ok, bsp_layout_profile ignored)
test result: ok. 26 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests theorem_workbench_layout
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

`cargo build -p theorem-workbench-layout --target wasm32-unknown-unknown`:
```
   Compiling ratatui v0.30.2
   Compiling theorem-workbench-layout v0.1.0 (.../terminal/crates/workbench-layout)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 6.18s
```

`cargo test --lib` (root crate):
```
     Running unittests src/lib.rs (.../deps/theorem_terminal-da0bafa00da35293)
test result: ok. 30 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

`sh terminal/build.sh`:
```
   Compiling ratzilla v0.3.1
   Compiling theorem-terminal v0.1.0 (.../terminal)
    Finished `release` profile [optimized] target(s) in 39.16s
```
It then ran `wasm-bindgen` and wrote `src/terminal-wasm/theorem_terminal_bg.wasm` (1,207,595 bytes) plus the JS and `.d.ts` bindings (gitignored output). The root crate is untouched by the workspace conversion and the script's `cargo metadata` target-directory lookup still works.

`cargo tree -p theorem-workbench-layout`: direct dependencies are `ratatui v0.30.2` and `serde v1.0.229`. The transitive tree is ratatui-core/widgets, their text and unicode helpers, and proc-macro crates. A grep for `tokio|pty|ghostty|process|mio|libc` finds nothing.

Note: the lock resolves ratatui to 0.30.2 (the root's requirement `0.30.1` is a caret range, so this is compatible); the added lock entry is the only lockfile change.

## Adaptation gaps (against spec 4.3, R05, R06)

1. **Stable panel-instance ids.** The leaf is `PaneId(u32)` from a process-global atomic counter, restarting at 1 each load. A persisted tree cannot use it as an identity. Needed: a mapping table of durable panel-instance id (and resource id) to the local handle, rebuilt on restore. `from_raw` is the only restore path, and the counter is not advanced by it, so `alloc()` after a restore can collide with restored ids. Needs a reseed, or removal of the global counter in favour of an owner-allocated id.
2. **Tab groups as leaves.** `Node` has only `Pane` and `Split`. There is no tab-group leaf, active-tab index, tab order, or move-into-tab operation. `insert_pane_near` only splits.
3. **Minimum sizes.** None. Ratios clamp to 0.1..0.9 of a split, independent of the cell size. `split_rect` can yield zero-width or zero-height panes in small areas. There are no per-panel minimums and no switch-presentation signal (R06).
4. **Normalized persisted ratios and units.** Ratios are `f32` fractions, clamped but not normalized or quantized. Geometry is integer terminal cells with `round`, so rounding drifts across areas. R06 targets are pixel calibrated (Files = 224px, 2:1). A px-to-cell conversion and a deterministic, quantized ratio form are needed.
5. **Serialization and restore.** `Node` has no serde derive (only `PaneId` does). `from_saved` does not validate: duplicates, an unknown focus id, or a ratio outside the clamp are accepted. `prev_focus` is not saved, and there is no version field. It does not adapt a layout to a different device (spec 4.3).
6. **Keyboard resize and move.** `resize_focused`/`resize_pane` and `find_in_direction` give directional keyboard resize and focus navigation, but they take a caller-chosen `delta` and cell area. There is no keyboard move or relocate of a pane to another edge or into a group, no drag-drop model, and only `swap_panes` and `insert_pane_near`. Pointer drag has only `SplitBorder` plus `set_ratio_at`.
7. **Process coupling.** The module itself spawns and kills nothing (no `std::process`; it uses only `std::sync::atomic`, `std::mem`, `std::cmp`). The coupling is in comments and API shape. `split_pane` allocates the new id and returns it so the caller can create a runtime. The doc on `split_focused` says production splits flow through `Tab` so a failed spawn can roll back. `insert_pane_near` says it avoids spawning a runtime. `close_pane`/`close_focused` only remove the leaf, and ending the process is the caller's job in Herdr. In Theo Web, splitting creates an empty destination or relocates a view, and close is detach-only. The comments should be rewritten, and `split_pane`'s allocate-on-split should become "insert a caller-supplied id". Rollback, if still needed, should be an undo of the tree edit, with no runtime semantics.
8. **Presentation fields.** `PaneInfo.scrollbar_rect`, `inner_rect` and `borders` are terminal-pane chrome. `panes_after_split` also ignores them (it sets `inner_rect = rect`). They are not part of a docked-panel contract.
9. **Hidden/expanded/restored panels.** No concept of hide, expand (maximize), or restore. Closing the last pane is refused (`close_focused` returns false), so an empty dock cannot be represented.
