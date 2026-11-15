# Workbench reference evidence (L06, L07, L08)

Gathered 2026-11-15 from the public repositories at the pinned shas. Nothing here is redrawn or approximated.

## Committed files

| File | Source URL (full sha) | Path in repo | sha256 | State shown | License / author at the pin |
|---|---|---|---|---|---|
| `composer@b016cd1/*.snap` (294 files; per-file sha256 in `composer@b016cd1/SHA256SUMS`) | https://github.com/openai/codex/tree/b016cd18472588606c04af565528c4cd6746a41f/codex-rs/tui/src (file names kept, raw at `https://raw.githubusercontent.com/openai/codex/b016cd18472588606c04af565528c4cd6746a41f/<path>`) | `codex-rs/tui/src/{bottom_pane/snapshots, bottom_pane/chat_composer/snapshots, bottom_pane/textarea/snapshots, history_cell/snapshots, exec_cell/snapshots, streaming/snapshots, status_indicator_widget/snapshots}/*.snap` | see SHA256SUMS | `insta` cell text of rendered Ratatui states, grouped below | Apache-2.0 (`LICENSE`, `codex-rs/Cargo.toml` `license = "Apache-2.0"`); `NOTICE`: "OpenAI Codex, Copyright 2025 OpenAI", derived-from Ratatui (MIT) credit |

Rendered states in `composer@b016cd1/` (file name prefix `codex_tui__`; counts approximate by prefix):

- Composer, empty / small / large / draft / voice: `bottom_pane__chat_composer__tests__{empty,small,large}`, `...snapshot_tests__{draft_composer,voice_composer}`, `light_terminal_palette_composer`.
- Pastes and placeholders: `tests__{multiple_pastes,backspace_after_pastes,blockquote_paste,blockquote_paste_embedded_answer,image_placeholder_single,image_placeholder_multiple,remote_image_rows*}`, `paste_tests__paste_burst_tab_indentation`, `history_search__paste_tests__*`.
- Popups: slash (`slash_popup_mo_clipped`, `status_surface__tests__slash_popup_footer_wide`), file/mention/skill/plugin/task popups (`tests__*_popup*`, `mentions_layout_tests__*`).
- Footer states: `footer__tests__*` (shortcuts, esc hint, ctrl-c quit, mode indicator, status line, context tokens), `tests__footer_collapse_*`, `tests__footer_mode_*`, `status_surface__tests__*`, `effort_tests__*`.
- Vim mode in the composer: `tests__vim_*`.
- Textarea (wrap, cursor row, tabs, unicode, mouse selection, hyperlinks): `bottom_pane__textarea__*` (24 files).
- Approval overlay: `approval_overlay__tests__{approval_header_wrapped_url,approval_overlay_additional_permissions_prompt,approval_overlay_cross_thread_prompt,approval_overlay_patch_destination_unavailable,approval_overlay_permissions_prompt,network_exec_prompt}`, plus `mcp_server_elicitation__tests__*approval_form*`.
- Transcript cells (`history_cell__*`): user prompt cells (wrap, gutter, urls, images), exec/command cells (single line, wrapped, multiline, stderr tail, ran cell), tool calls (MCP active, success, error, images, multiple outputs, `mcp__computer_activity__*`), patches, plan update, web search, errors, session header, update notices.
- Streaming: `streaming__render__tests__{incremental_render_representative_stream,incremental_file_citations,...}`, `streaming__controller__tests__completed_table_*`, `streaming__controller__math_tests__*`, `streaming__mermaid_tests__*`.
- Exec output: `exec_cell__render__tests__truncated_live_output_preview_and_transcript`, `exec_cell__transcript__tests__*`.
- Status indicator: `status_indicator_widget__effects_tests__*`.

Not downloaded (exist at the pin, other surfaces): `chatwidget/snapshots` (340), `app/snapshots` (107), `transcript_view/snapshots` (50), `onboarding`, `markdown_render` (27). They can be added on request.

## Wanted files not obtained

| Wanted | Why |
|---|---|
| `markdown-visual@078bf26.png`, `markdown-source@078bf26.png`, `markdown-split@078bf26.png`, `markdown-preview@078bf26.png` | no source rendering found. Ely-GPUI-Components at 078bf26 commits only `frontend/public/shots/*.jpg` (38 gallery shots: files, forms, media, navigation, shell, terminal, theme; none of Markdown) plus `logo.png`, `og.png`, and sample photos under `crates/ely-gallery/assets`. The same holds at the repo's default-branch tip (39 shots, none Markdown or changes); not used as a reference. |
| `changes@fbb536e.png` | no source rendering found. ELYTerminal at fbb536e commits no raster beyond app icons (`assets/icons/*.svg`, `.ico`, `website/public/ely.svg`). Ely-GPUI-Components at 294a832 has `frontend/public/shots` (same 38 gallery shots, none of changes/commits/diff). |
| `composer@b016cd1.png` | no source rendering found. Codex commits no composer screenshot at the pin; the `.snap` set above is the reference instead. |

## Gallery / story findings

- Ely-GPUI-Components at 078bf26 has a runnable gallery: `crates/ely-gallery` (`cargo run -p ely-gallery`; `-- --page documents`; `-- --capture <dir>` writes PNGs of every page, light and dark, plus scripted states on macOS). `crates/ely-gallery/src/pages/documents/mod.rs` scripts `Step::Shot("split")`, `("open-block")`, `("changes")` etc. over `MarkdownEditor` + `MarkdownMode` (`pages/documents/editing.rs`, `keep("doc-mode", || MarkdownMode::Visual, ...)`), so a capture would give Visual and Split at least; Source and Preview would need a scripted mode switch or `--story` selection. The Changes panel has `pages/agent/changes.rs` (agent MultiFileDiffReview, not the git Changes panel); the git panel (`src/git/changes.rs`) at 294a832 has no gallery page I found.
- One build attempt made: `cd <clone at 078bf26> && CARGO_TARGET_DIR="/Volumes/SSD Samsung/cargo-target-theo-workbench-refs" cargo build --release -p ely-gallery --ignore-rust-version` on the default `stable` toolchain (1.97.1). It failed in `gpui-pre-macos 0.3.12` (`window.rs:896,957,1068`): `E0658 result_option_map_or_default` is unstable on 1.97.1. The workspace declares `rust-version = "1.98"`; `rustup toolchain list` shows 1.98.1 and 1.99.1 installed, so the command to run next is the same with `cargo +1.98.1 build ...` then `"$CARGO_TARGET_DIR/release/gallery" --capture <dir>`. I did not make a second attempt, per the one-attempt limit. Clone left at `/private/tmp/claude-501/-Users-travisgilbert-Theorem-ui/e1a82c1d-76c9-4f39-a4ab-6e3a96cc6a4a/scratchpad/ely-src` (detached at 078bf26, outside the worktree).
- Capture needs a real macOS window (the harness reads the window via raw-window-handle and posts NSEvents); this shell has no confirmed window/screen-recording permission, so a headless capture is not known to work from here. Not tried.
- ELYTerminal has `examples/shot` (macOS: plays keys on the app's window and photographs it), not run.
- Codex has no gallery; its `insta` snapshots are the rendering record, `cargo test -p codex-tui` regenerates them, not run.

## License and author vs ledger

- L06 and L07: LICENSE at 078bf26, 294a832 and ELYTerminal fbb536e is MIT; copyright lines "Ely GPUI Component contributors" and "ELYTerminal contributors" (2026), Cargo `license = "MIT"`, no `authors` field. Matches the ledger. Blob ids confirmed at the pin: `crates/ely-documents/src/modes.rs` is `2e6bca2e7c297372c7c7374c0d0df313fcb26f86`, `src/git/panel.rs` (ELYTerminal) is `26133bcffa1a2de18dcb50d169fb55b959be0369`.
- One difference to note for L07: at 294a832 the workspace `repository` in `Cargo.toml` is `https://git.zacharyzhang.com/ZacharyZhang-NY/Ely-GPUI-Components`, while at 078bf26 it is `https://github.com/ELY-Open-Source/Ely-GPUI-Components`. The pin resolves on GitHub, but the source repository URL it self-reports differs. The ledger's `src/git/{changes,commits,diff}.rs` path exists at 294a832 (the tree has `src/git/` with blame, changes, commits, diff, graph, history, merge, merging, badges); at 078bf26 the git code is a separate `crates/ely-git`, so the two pins are different layouts.
- L08: Apache-2.0, OpenAI, NOTICE names Ratatui (MIT): matches the ledger. NOTICE says "Copyright 2025 OpenAI".
