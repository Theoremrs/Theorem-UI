# Theo Web workbench: source and license ledger

One row per component. A row is complete when lane, source and pin, author and license, and reference artifact hash are all filled. An incomplete row blocks that component's verify step.

Lanes:

- **verbatim**: source carried over with its tests, changed only at named seams. The row lists every change.
- **translation**: the source's mechanics re-expressed for Ratatui. The row reads "translated from", never "ported from".
- **library**: a published crate or package used as a dependency. No reference capture; the pin is the lockfile.
- **original**: nothing upstream models it. The row says why.

Reference artifacts live under `docs/plans/evidence/refs/` and are named `<component>@<pin>.png`. "pending" means the capture is the first step of that component's work order.

## Donor and original components

| # | Component | Lane | Source and pin | Author, license | Reference artifact (sha256) | Changes from source |
|---|---|---|---|---|---|---|
| L01 | Split tree (`workbench-layout`) | verbatim | `herdrdev/herdr` `src/layout.rs` at `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`, blob `aaa207ae38119e03fb20412759f8b38a6708038e` | Herdr contributors; license text in `terminal/crates/workbench-layout/LICENSE-HERDR` | none: no rendered output (geometry only, covered by the 27 upstream tests) | Extraction commit `287997fc` is byte-identical. Planned in Gate 1: caller-supplied leaf ids replace the process-global counter; serde on the tree; validated restore |
| L02 | Dock (`workbench-dock`) | original | | | none | Tab groups, minimum sizes, px-to-cell quantization, collapse, presets and persistence are not in the donor (`gate-0/herdr-layout-donor.md`, adaptation gaps) |
| L03 | Tool picker | translation | Translated from the supplied Codex desktop picker capture; no extractable source exists (spec 7.1) | Reference image supplied with the spec | `docs/plans/evidence/refs/workbench-picker@spec-1.0.png` (copy of `visual-reference/codex-tool-picker.png`), `e205692bd3f3904ec9aca60a6c314899b866dc861b8400e61b038749ec7e4a53` | Row hierarchy and labels only |
| L04 | Markdown parse and block ranges | verbatim | `ELY-Open-Source/Ely-GPUI-Components` at `078bf26f2d039b3877aef577e37bbd0a1de182bf`: `crates/ely-documents/src/markdown/{mdast,build,build/node,build/text,flow,front,shape,autolink}.rs`, `markdown.rs` (`block_ranges`, `marks`, `link_at`), `tree/*` | Ely GPUI Component contributors, MIT | none: no rendered output | Imports rewritten off `ely_core`; `markdown_highlights` and GPUI imports removed |
| L05 | Markdown edit commands | verbatim | same repo and pin: `document/{block,block/*,format,format/*,cells,parse}.rs` | same, MIT | none | `TargetBlock` extracted from `document/mod.rs`; each returned change carries the document revision |
| L06 | Markdown modes (Visual, Source, Split, Preview) | translation | Translated from `crates/ely-documents/src/modes.rs`, blob `2e6bca2e7c297372c7c7374c0d0df313fcb26f86`, same pin | same, MIT | `evidence/refs/markdown-{visual,source,split,preview}@078bf26.png`, pending | `MarkdownMode`, `shifted`, `joint` carried; `commit` rewritten: a pending block edit is never dropped when the document changed under it (donor lines 104-109 and 350-355). The two donor tests that assert the drop (`modes/tests.rs:6`, `:62`) are inverted |
| L07 | Changes panel | translation | Translated from `ELY-Open-Source/ELYTerminal` at `fbb536ec8f6e1466fa8c736967671ebf99a34080` (`src/git/panel.rs` blob `26133bcffa1a2de18dcb50d169fb55b959be0369`, `panel/view.rs`, `git.rs` model) and `Ely-GPUI-Components` at `294a8323c08a06bd8e7782d16acee43b6bb0c5eb` (`src/git/{changes,commits,diff}.rs`) | ELYTerminal contributors, MIT; Ely GPUI Component contributors, MIT | `evidence/refs/changes@fbb536e.png`, pending | Every `git()` call replaced by a Theorem SCM effect; paths become workspace resources; revision binding added (absent in the donor) |
| L08 | Composer and transcript behavior | translation | Translated from `openai/codex` `codex-rs/tui` at `b016cd18472588606c04af565528c4cd6746a41f` (`bottom_pane/chat_composer.rs`, `textarea.rs`, `streaming/*`, `history_cell/*`, `approval_overlay.rs`) as behavior reference | OpenAI, Apache-2.0; NOTICE names Ratatui (MIT) | `evidence/refs/composer@b016cd1.png`, pending | No Codex file is copied for the composer: its text area has no keyboard selection and no undo (`gate-0/donors.md` 3.3) |
| L09 | Stream pacing | verbatim | `openai/codex` at `b016cd18...`: `streaming/chunking.rs` blob `9bf43cba52798cc223b75e1cdfb5de17c365068e` | OpenAI, Apache-2.0 | none | `Instant` replaced with `web-time`. Adopted only if the existing transcript's pacing fails the Gate 4 cases |
| L10 | Inverse Theo face | translation | Translated from this repository's `src/components/face/*` | Theorem UI | `evidence/refs/theo-face@<commit>.png`, pending | Light outline and dark eyes for the terminal surface; same expression state |
| L11 | Terminal profiles | verbatim | This repository, `ide/theia-extensions/theorem-workspace/src/browser/terminal-profile.ts`, blob `ffee53c225` | Theorem UI contributors, `EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0` (file header) | none | Moved, header kept. Not relabeled |
| L12 | Workspace glue (recovery, host paths, directory listing, line map, search rows, blame hunks) | verbatim | This repository, `ide/theia-extensions/theorem-workspace/src/browser/{workspace-recovery,host-paths,directory-listing,replace-entry,line-map,search-rows,blame-hunks}.ts` | Theorem UI contributors, same SPDX as each file's header | none | Moved with headers kept; Theia imports were already absent |
| L13 | VT screen wrapper | translation | Translated from backend `apps/theorem-ide-host/src/vt_screen.rs` at `828ac52848`, blob `ad53101ea94a20a852883468d78233f01714d032` | Theorem | none | Same `vt100` settings (scrollback 2000) so the browser screen matches the host's repaint |

## Libraries

| # | Need | Package and version | License | Notes |
|---|---|---|---|---|
| B01 | Browser renderer | `ratzilla` 0.3.1 | MIT OR Apache-2.0 | Already in use |
| B02 | Cells and layout | `ratatui` 0.30.1 (lock 0.30.2) | MIT | Already in use |
| B03 | Editing session | `ratatui-textarea` 0.9.4, default features off | MIT | Undo, selection, wrap. Cursor counts `char`s: `workbench-text` converts and snaps to grapheme boundaries. wasm build to be proven |
| B04 | Markdown events with byte offsets | `pulldown-cmark` 0.13.x | MIT | What ELY's builder is written against |
| B05 | Markdown to styled text | `tui-markdown` 0.3.12 | MIT OR Apache-2.0 | Already in use for the transcript. Used for Preview; constructs it cannot draw (tables are the open one) are drawn from the ELY tree |
| B06 | VT interpreter | `vt100` 0.16.x | MIT | Matches the host. wasm build to be proven |
| B07 | VT widget | `tui-term` 0.3.4 | MIT | |
| B08 | Graphemes, display width | `unicode-segmentation`, `unicode-width` 0.2 | MIT OR Apache-2.0 | |
| B09 | Wire types to TypeScript | `ts-rs` | MIT | Dev-time only |
| B10 | Code tokens, diff parsing | `@tanstack/highlight`, `diff` (jsdiff) | per package | Already in use by the terminal |
| B11 | Document sessions, SCM, language, terminals, workbench record | `@theoremharness/sdk` 0.6.0-alpha.5 (vendored) | per package | |
| B12 | Local checkpoints | `@rustyreddb/browser` 0.1.0-beta.2 (vendored) | per package | |

Not adopted, and why: `edtui` (modal editor, hard `crossterm` and clipboard dependencies); `syntect` (a second highlighter beside the one already in use); Codex `markdown_render.rs` and `diff_render.rs` (3,353 and 2,745 lines bound to terminal color detection and an older `pulldown-cmark`, where existing code already draws both); `ropey` (no measured need).
