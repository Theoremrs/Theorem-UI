# Gate 0: donor survey (ELY Markdown, ELY Changes, Codex TUI, candidate crates)

Status: source inspection only. Nothing below was built, run or compiled. "Unverified" means the crate or file does not document `wasm32-unknown-unknown` support and no build was attempted. Surveyed 2026-11-14 (UTC dates below are commit committer dates).

Downloaded source (read only, outside the repo): `/Volumes/SSD Samsung/var-18/theo-workbench-donors/`

| Folder | Content | Commit |
|---|---|---|
| `Ely-GPUI-Components@078bf26` | full clone (history kept, used for blob search) | `078bf26f2d039b3877aef577e37bbd0a1de182bf`, 2026-11-13T21:57:39-05:00 |
| `ELYTerminal@fbb536e` | full clone | `fbb536ec8f6e1466fa8c736967671ebf99a34080`, 2026-11-14T14:21:13-05:00 |
| `codex@b016cd1` | `--depth 1` | `b016cd18472588606c04af565528c4cd6746a41f`, 2026-11-15T03:17:50Z |
| `ratatui-textarea@cf670f9` | `--depth 1` | `cf670f920d407ae70e729c67e5ea9fe2db3f275a`, 2026-10-31 |
| `ratzilla@2f6f7ef` | `--depth 1` | `2f6f7eff05d966b9e9efcbacbca0027991123b5a`, 2026-10-23 |
| `edtui@8074d39` | `--depth 1` | `8074d39bc744825105f3fd71e696c92d090e05f6`, 2026-10-31 |
| `tui-term@f0ffe97` | `--depth 1` | `f0ffe97fb984c96ec9490ba8174fd26a01b994cf`, 2026-10-02 |

## 1. ELY Markdown (`ELY-Open-Source/Ely-GPUI-Components`, `crates/ely-documents`)

### 1.1 Pin, blob, license

| Item | Fact |
|---|---|
| Pinned commit | `078bf26f2d039b3877aef577e37bbd0a1de182bf` (current `main`, 2026-11-13) |
| `src/modes.rs` blob | `2e6bca2e7c297372c7c7374c0d0df313fcb26f86` at `078bf26`: identical to the blob the spec observed. No blob difference to record. |
| Commits containing that blob | `git log --all --find-object=2e6bca2e...` returned `48608a3d622a8547bda43a76159333fdc85f156f` (2026-10-23T13:15:19-04:00, "Optimization C7: rustdoc for chapters 15-27"), which is the last commit that touched `modes.rs`; also unchanged in every commit up to `078bf26`. Use `078bf26` (current main) as the pin; `48608a3` is the earliest commit holding this exact blob. |
| License | MIT, `LICENSE` at repo root and at `crates/ely-documents/LICENSE`; "Copyright (c) 2026 Ely GPUI Component contributors". `Cargo.toml` `license = "MIT"`. |
| NOTICE | none |
| Per-file SPDX / copyright headers | none in `.rs` files (grep for `SPDX`, `Copyright` over `src` hits only the two OFL font license texts under `src/fixtures/`, which must not travel) |
| What must travel | MIT license text and the copyright line, in a `THIRD_PARTY`/provenance file naming repo, commit and the changed behavior (spec R03) |
| Crate stats | `ely-documents` 33,050 lines of Rust; `src/modes.rs` 492 lines; 254 `#[test]` attributes crate-wide |

### 1.2 Module map: toolkit-independent vs GPUI

GPUI count is `grep -c gpui` per file. Lines include inline tests.

| Area | Files (lines) | GPUI refs | Verdict on the area |
|---|---|---|---|
| Markdown syntax tree, byte spans | `src/markdown/mdast.rs` 332, `build.rs` 377, `build/node.rs` 186, `build/text.rs` 102, `flow.rs` 373, `front.rs` 88, `shape.rs` 334, `tex.rs` 268, `autolink.rs` 213 (total 2,273) | 0 | toolkit-free. `shape.rs` and `tex.rs` import `crate::tree::{Style,html}`, so the `tree` area comes with them. |
| Inline/block read tree used by the renderer | `src/tree/{mod 503, blocks 223, emoji 103, html 518, html_block 482, sources 429, stack 197}` (2,455 non-test) | 0 | toolkit-free; `html_block.rs` imports `crate::clock` (test-only `clock.rs`, 24 lines) |
| Block and format edit commands as pure functions `(text, selection) -> Change` | `src/document/block.rs` 475 + `block/{check 145, heading 221, insert 319, list 315, quote 182, split 229}`; `format.rs` 483 + `format/{across 133, clear 85}`; `cells.rs` 346; `parse.rs` 194 | 0 | toolkit-free. `Change = (Vec<(Range<usize>, String)>, Range<usize>)` (`document/format.rs:75`): a list of byte-range replacements plus the next selection. This is the shape R12 wants (minimal edits). |
| Document session, selection, find, tables, point mapping | `src/document/{mod 406, edit 369, point 460, place 307, span 325, tables 501, lists 319, finding 200, visual 495, apart 211, attach 62, look 114}` | 1 to 8 each | GPUI-bound (entities, `cx`, focus). Reference only. |
| Mode switch and Visual block open/commit | `src/modes.rs` 492 | heavy | GPUI-bound. Logic is ~60 lines of pure code (`shifted`, `joint`, `commit` structure); see 1.4. |
| Rendering | `src/render.rs`, `render/*`, `rich.rs`, `toolbar.rs`, `viewer.rs` | heavy | replace with Ratatui |
| Block pages, diagrams, math SVG, print, epub | `blocks/*`, `diagram.rs`, `math.rs`, `print.rs`, `epub.rs`, `picture.rs` | various | out of scope; pull in `mermaid-rs-renderer`, `ratex-*`, `usvg`, `image` |
| Editor buffer under it | `crates/ely-editor/src/buffer.rs` 287 (byte offsets plus line starts), `cursor.rs` 258 (`Selection{anchor,head,goal}` in bytes); `TextInput` is `ely-core/src/forms/text/*` 2,121 lines | 0 for `buffer.rs`, `cursor.rs`; GPUI for `edit.rs`, `moves.rs`, `find.rs`, `line.rs`, `ime.rs`, `keys.rs` | `buffer.rs` and `cursor.rs` are pure but tiny; a library covers this better (section 4). |

### 1.3 Candidate files

Blobs are at `078bf26` (`git ls-tree HEAD`). Dependencies listed are crate-external.

| File | What it does | External deps and wasm | Tests | Blob | Verdict |
|---|---|---|---|---|---|
| `src/markdown/mdast.rs` (332) | mdast-shaped `Node` enum; every node has `position(): Range<usize>` in bytes of the source | none | none inline | `663b0ba322461d3320ef08044b751ee8241fda18` | reuse as is |
| `src/markdown/build.rs` (+`build/node.rs`, `text.rs`) (377+186+102) | `pulldown-cmark` events from `Parser::new_ext(..).into_offset_iter()` (`build.rs:51`) turned into mdast with byte spans; handles BOM (`build.rs:30-40`), CR-only line ends | `pulldown-cmark 0.13` default-features off. Documents `no_std` mode (README); wasm unverified | `build/tests.rs` 139 lines | `982dbcb4c4c12713c66aa7dfadc06ae5f919cb5c` | reuse with adaptation (seam: `crate::tree::{Style,html}` imports in `shape.rs`) |
| `src/markdown/flow.rs`, `front.rs`, `shape.rs`, `autolink.rs` | pre-rewrite of text for the parser, front-matter split (`front::split`), span fix-ups, GFM autolinks | none beyond pulldown | in `build/tests.rs` | `flow` `5a961ee8ae335c284a032c2876d2651b423e8588`, `front` `fdcd70708df627e1723af061873ef2ff6b3192d6`, `shape` `104f560f30162689c433a10ec618fa73369c0692`, `autolink` `a5a955631641be69b28e0152170375803d47a765` | reuse with adaptation (same seam) |
| `src/markdown/tex.rs` (268) | reads `\(..\)` and `\[..\]` as math by swapping control bytes, re-parsing and mending spans | none | `tex/tests.rs` 139 | `718fb28ab5c4621fdf62aa22e867cfe3e210ca0f` | reuse with adaptation, optional (math is not in spec section 8.2's block list) |
| `src/markdown.rs` (333) | `block_ranges(text)` at line 213 (top-level blocks as byte ranges, definitions excluded, trailing newlines trimmed), `marks()` (styled spans plus syntax-char spans for source highlighting), `link_at` | `unicode-segmentation`; imports `gpui::App` and `crate::forms::Highlight` for `markdown_highlights` (line 141) only | 11 `#[test]` at the bottom (e.g. `blocks_are_the_top_level_stretches`, line 315) | `067086687929d780562b242245c959e8d42fb3f1` | reuse with adaptation: drop `markdown_highlights`; keep `block_ranges`, `marks`, `link_at`, `words` |
| `src/tree/*` (3,065 lines with 610 of tests) | block/inline read tree with source spans (`sources.rs` `LineMap`), HTML handling (`html.rs`, `html_block.rs`: sanitizing, not executing) | `jiff` appears via `clock.rs` (tests) | `tree/tests.rs` 610 | `mod.rs` `5f852beb29e99159e30e1bb8e4e5d01d53ebfcc1` | reuse with adaptation; this is the input for a Ratatui renderer |
| `src/document/block.rs` + `block/*` | Typora-style paragraph commands (heading levels, quote, lists, task list, rule, code, math, TOC, front matter, footnote, delete) as edit lists | `crate::markdown`, `crate::tree` only | in `document/tests/block*.rs` (some GPUI-bound; `block_edges.rs` has 0 GPUI refs) | `fc45932b9467af2b3b8048b54cb5de299e904731` | reuse with adaptation (seam: `TargetBlock`, defined in `document/mod.rs`, must be extracted) |
| `src/document/format.rs` + `format/*`, `cells.rs`, `parse.rs` | inline format toggles, table cell moves, `parsed(text) -> Parsed{blocks, headings}` | same | same | `format` `2db3e35886fc9410ae0ea7cc49ce1ebac9c5e73a`, `cells` `d5e42cbaca63a498b15688bd76960359f641d009`, `parse` `07974e88bc40cdbc0255d06d71e3e3dc574e0c6b` | reuse with adaptation (same seam) |
| `src/modes.rs` (492) | `MarkdownMode {Visual, Source, Split, Preview}` (line 25); `Open` block state (56); `shifted` (70); `joint` (82); `commit` (93); `open` (127); `visual()` (282) | `gpui`, `ely_core::{forms,buttons,theme}` | `modes/tests.rs` 150 lines: pure tests at lines 27-45; GPUI tests at 6, 62, 129 | `2e6bca2e7c297372c7c7374c0d0df313fcb26f86` | reference only; port the enum, `shifted`, `joint` verbatim, re-implement `commit` per R11 |

### 1.4 Specific answers

| Question | Answer |
|---|---|
| How are blocks and ranges represented? | Byte offsets: `Range<usize>` into the UTF-8 source. `mdast::Node::position()` (`markdown/mdast.rs`), `block_ranges() -> Vec<Range<usize>>` (`markdown.rs:213`). Lines are not the unit. A block range excludes trailing `\n`/`\r` (`markdown.rs:218-220`); text between blocks (blank lines, definitions) is in no block range and is never touched by a block write-back. |
| Parser | `pulldown-cmark 0.13` with `ENABLE_TABLES, FOOTNOTES, STRIKETHROUGH, TASKLISTS, MATH` (`markdown/build.rs:20-27`), through `into_offset_iter()`, then ELY's own mdast builder (about 2,300 lines) and a `\(..\)` pass. No `markdown`/`comrak` involved. |
| How does Visual map an edited block back? | `open()` (`modes.rs:127`) copies the block's source `document[range]` into a separate multi-line `TextInput` and records `Open{document: full String snapshot, range, append}` (struct at line 56). `commit()` (line 93) reads the field text and, if `document[range] != written`, calls `field.select(range)` then `field.insert(&written)` (lines 116-121): a byte-range replacement in the one shared document. Other block ranges are rebased with `shifted(range, replaced, written)` (line 70). Appending at the end uses `joint()` (line 82) to add `\n\n`. Commit happens on blur (subscription, `modes.rs:154-155`), Escape (`468-470`), mode switch (`246`), the "more" area press (`381`), another block pressed (`356`) and arrow navigation at a block edge (`414`). It is not revision-bound, only string-equality-bound. |
| Where is the code that discards a pending block edit? | `crates/ely-documents/src/modes.rs` lines 104-109, in `commit()` (lines 93-124): `if document != open.document { log::error!("markdown editor: the text changed under block {:?}; its edit is dropped", open.range); return None; }`. `open.document` is the snapshot taken at open time (line 136, 161); `document` is the field text at commit. Any difference (an agent write, a peer write, a replaced text) makes the typed block text vanish; `open.take()` at lines 98-101 has already removed it. Related drop: `modes.rs:350-355`, a press on a rendered block is ignored when the field text no longer equals the text painted (`log::error!("... press dropped")`). Both behaviors are pinned by tests: `modes/tests.rs:6-24` (`an_open_block_of_a_replaced_text_writes_nothing`) and `modes/tests.rs:62` (`a_press_on_a_block_of_a_replaced_text_opens_nothing`). These two tests assert the behavior R11 forbids and must be inverted, not retained. |
| Does the donor offer anything for the reconciliation R11 needs? | No. The only data kept is the open range plus snapshot; there is no three-way merge or conflict state. The replacement is: keep `Open{base_revision, base_text_of_block, range, pending_text}` and rebase `range` through later edits (the `shifted` arithmetic is the right idea but only handles edits entirely before the range, `modes.rs:71-73`; an overlapping edit must become a conflict). |

### 1.5 Risks specific to ELY Markdown

| Risk | Detail |
|---|---|
| Whole-document reparse | `block_ranges`, `file_tree`, `Here::new` all reparse the full text per call (`document/block.rs:run`). R12 forbids reserializing the whole document to apply a small edit; this does not (it patches by range) but parse cost per keystroke is unmeasured on large files. `document/mod.rs` defines `LARGEST_READ`. |
| Heavy crate | `ely-documents/Cargo.toml` pulls `mermaid-rs-renderer`, `ratex-*`, `usvg`, `image`, `jiff`, `entities`, `emojis`, `regex`. Extract files, not the crate. |
| ELY's text editor is not reusable | `TextInput` (`ely-core/src/forms/text/*`, 2,121 lines) is GPUI-bound; `ely-editor` buffer is bytes-only with no graphemes. The "shared text-editing core" (R10) must come from a library (section 4). |
| `crate::` paths | modes and documents use re-exports declared in `lib.rs:6-9` (`use ely_core::{buttons, forms, ...}`), so any extraction must rewrite imports. |

## 2. ELY Changes (`ELY-Open-Source/ELYTerminal`)

### 2.1 Pin, blob, license

| Item | Fact |
|---|---|
| Pinned commit | `fbb536ec8f6e1466fa8c736967671ebf99a34080` (2026-11-14T14:21:13-05:00, "T196: answer #101 and #102"). It is also current `main` HEAD. |
| `src/git/panel.rs` blob | `26133bcffa1a2de18dcb50d169fb55b959be0369` at `fbb536e`, same at HEAD. Matches S09. |
| License | MIT, `LICENSE` at root, "Copyright (c) 2026 ELYTerminal contributors". `LICENSE-GHOSTTY` also present (applies to terminal code, not Git). No NOTICE. No per-file SPDX headers (not searched exhaustively: `src/git/*` checked, none). |
| Hidden dependency on a second repo | `Cargo.toml` pins `ely-gpui-component = { git = ".../Ely-GPUI-Components.git", rev = "294a8323c08a06bd8e7782d16acee43b6bb0c5eb" }` (2026-11-02, "Merge PR #10"). At that rev the repo was a single crate with `src/git/*`; at `078bf26` it is split into `crates/ely-git`. The Changes presentation (list rows, commit box, diff viewer) lives in that other repo, not in ELYTerminal. |

### 2.2 Files

| File | Lines | What it holds | GPUI | Tests | Blob |
|---|---|---|---|---|---|
| `ELYTerminal src/git/panel.rs` | 380 | `GitPanel` state and actions: `State{Reading,Outside,Failed,Read(Repo, Rc<Vec<Commit>>)}` (22), `Diff` (31), `RECENT = 50` (19), `read/store/act/row_action/all/discard/commit/open` | `Entity<TextInput>`, `Task`, `cx.spawn` throughout | none inline | `26133bcffa1a2de18dcb50d169fb55b959be0369` |
| `ELYTerminal src/git/panel/view.rs` | 391 | rendering: sections list, commit input, `ConfirmDialog` for discard, error `Alert` | all | none | not recorded |
| `ELYTerminal src/git.rs` | 487 | the data model and every git call | `ely_gpui_component::{git::{ChangeSection, Commit}, lists::GitStatus}` types only | `git/tests.rs` 447 lines (13 tests, shell out to real git, write temp dirs) | not recorded |
| `ELYTerminal src/git/diff.rs` | 107 | runs `git diff` per section, parses into `Stretch` via ely-git | type imports | `git/tests/diffs.rs` 232 lines (5 tests) | not recorded |
| `ELYTerminal src/git/wsl.rs` | 88 | WSL path splitting | none | in tests | not recorded |
| `Ely-GPUI-Components@294a8323 src/git/changes.rs` | 476 | `Changed{path, status, lines}`, `ChangeAction{Stage,Unstage,Discard,Open}`, `ChangeSection{Conflicted,Staged,Unstaged,Untracked,Ignored}`, `ChangesList`, `CommitInput` (line 349) | 2 refs, widget code | 0 | `9591530a7aadc9f88b726afd97d81a1079ecc795` |
| same, `src/git/commits.rs` | 310 | `Commit{id, parents, subject, author, when, refs}` plus `CommitList` | widget code | 0 | `f25369f9619a37527fbe7bc5de56ecaa4bcf0c86` |
| same, `src/git/diff.rs` | 317 | `LineKind`, `DiffLine{kind, old, new, text, words}`, `Stretch{Hunk{header, lines}, Folded}`, `diff(old,new,context)`, `mark_words` | 1 (`SharedString`) | 6 | `657bb79eddc498eb418061f5c64c49090b32d64c` |
| same, `src/git/viewer.rs` | 445 | `DiffViewer`, `DiffLayout` (unified/split) | 5 | 1 | `e0d32f10a09a129fb57c59e0971118f92d72f1d0` |
| `Ely-GPUI-Components@078bf26 crates/ely-git/src/diff.rs` | 328 | same as above, current | 1 | 6 | `0acff17d2b9f3d6203ba7c054c3c0bfb54f9d75d` |

### 2.3 Specific answers

| Question | Answer |
|---|---|
| What data model does the panel render from? | `Repo{top: PathBuf, branch: Option<String>, commit: Option<String>, conflicted, staged, unstaged, untracked: Vec<Change>}` and `Change{path, from: Option<PathBuf>, status: GitStatus}` (`ELYTerminal src/git.rs:277-297`), `Vec<Commit>` (newest 50), and for an open diff `Diff{change, section, lines: Result<Rc<Vec<Stretch>>, &'static str>}` (`panel.rs:31`). State enum `Reading/Outside/Failed/Read` (`panel.rs:23`). Commit draft is two `TextInput`s (subject, body) plus `amend: bool` (`panel.rs:59-61`); message is `subject` or `subject\n\nbody` (`panel.rs:300-303`). Discard confirmation is `discarding: Option<(Change, ChangeSection)>` (`panel.rs:64`) shown through `ConfirmDialog` in `view.rs`. |
| Which functions shell out or touch the filesystem (the rebinding list)? | All in `ELYTerminal src/git.rs`: private `git()` (line 35, spawns `git --no-optional-locks --literal-pathspecs` with `LC_ALL=C`, `Command` at line 79; on Windows `wsl.exe`, line 72), `run` (103), `path_of`, `parse` (porcelain v2 `-z` records, 144), `changes` (220), `repo` (299, `rev-parse --show-toplevel`, status), `stage` (388), `unstage` (396), `commit` (409, `amend` flag), `discard` (421, differs per section: restore, clean, checkout), `log` (458, `--format=%H%x00%P%x00%s%x00%an%x00%ar%x00%D`), and `git/diff.rs::diff` (9, `git diff --no-color --no-ext-diff --no-textconv` with `--cached -M`, `HEAD`, or `--no-index -- /dev/null` for untracked). `git/tests.rs` writes real repos with `std::fs`. `panel.rs` itself calls these only through `super::{repo,log,stage,unstage,discard,commit,diff}` (lines 150-155, 250-255, 273-288, 305, 347). |
| What carries over unchanged? | The state machine and its rules: serialized actions (`act`, `panel.rs:199`: each waits for the one before), "actions wait while the folder re-reads" (`waits`, line 141), "a draft typed while the commit ran stays" (`panel.rs:307-320`), untracked folder has no lines (`panel.rs:333-345`), binary shows a reason (`Ok(None)`), a stale row yields "no longer in section" (line 244). These match spec section 9 and R17/R18; they are reference for a Rust reducer, not importable code. |
| What is missing against the spec? | ELY has no branch, merge, fetch, push, blame, hunk operations in the panel (the `ely-git` crate has `blame.rs`, `merge.rs`, `refs.rs`, `tags.rs` widgets but ELYTerminal's panel does not use them). Revision-bound stale-diff checks (R18) do not exist: `row_action` finds the change by path string only (`panel.rs:240-242`). |

### 2.4 Verdicts

| Piece | Verdict |
|---|---|
| `GitPanel` state machine and `view.rs` | reference only (re-express as Elm model, messages and effects over Theorem's SCM contract) |
| Data model (`Repo`, `Change`, `Commit`, `ChangeSection`, `ChangeAction`) | reuse with adaptation: these are plain data; replace `PathBuf` with Theorem resource identities and `SharedString` with `String` |
| `git.rs` shell calls | reference only (these are exactly what gets rebound; the porcelain-v2 parser at line 144 is useful if Theorem's SCM returns porcelain text) |
| `Stretch`/`DiffLine`/`diff()`/`mark_words` (`diff.rs`) | reuse with adaptation (only `SharedString`); depends on `similar 3.2` with `wasm32_web_time` feature, which ELY's own `Cargo.toml` already enables for `target_family = "wasm"`. Alternative: take the unified diff from the SCM contract and render it with Codex `diff_render.rs`. |
| ELY list/commit-box/diff widgets (`changes.rs`, `commits.rs`, `viewer.rs`) | reference only (GPUI element code); they define the layout the spec wants (section headers with counts, per-row stage/unstage/discard/open, commit input with amend, recent list) |

## 3. Codex TUI (`openai/codex`, `codex-rs/tui`)

### 3.1 Pin, license, scale

| Item | Fact |
|---|---|
| Pinned commit | `b016cd18472588606c04af565528c4cd6746a41f` (2026-11-15T03:17:50Z, "Enable automatic titles for Cloud conversations (#61600)"), `main` HEAD at survey time |
| License | Apache-2.0, `LICENSE` at root, workspace `license = "Apache-2.0"` (`codex-rs/Cargo.toml:182`) |
| NOTICE | `NOTICE` at root: "OpenAI Codex, Copyright 2025 OpenAI", and states the project includes code derived from Ratatui (MIT, Copyright (c) 2016-2022 Florian Dehau, (c) 2023-2025 The Ratatui Developers). Apache-2.0 section 4 means this NOTICE content, the license text, and a "changed" statement per modified file must travel. |
| Per-file headers | `src/custom_terminal.rs:1-5` (derived from `ratatui::Terminal`, MIT notice) and `src/terminal_palette.rs` carry notices (a Wezterm MIT license is vendored at `third_party/wezterm/LICENSE`, Copyright (c) 2018-Present Wez Furlong); no other `src` file has SPDX/Copyright text. Do not extract `custom_terminal.rs` (it exists to drive a real terminal). |
| Size | `codex-rs/tui/src`: 1,249 `.rs` files, 515,864 lines |
| Ratatui | workspace `ratatui = 0.30.2` (default features off) with `scrolling-regions`, `unstable-backend-writer`, `unstable-rendered-line-info`, `unstable-widget-ref`; the project uses 0.30.1. `line_truncation.rs` uses `ratatui::buffer::CellWidth`; whether that exists in 0.30.1 is unverified. |
| Other third-party | `crossterm` pinned to an OpenAI fork (`Cargo.toml:684`, git rev `ed1cdab3...`); `pulldown-cmark 0.10` (project libraries would be 0.13); `syntect 5` with `regex-onig` and `two-face` with `syntect-onig` (C library, not wasm-friendly); `textwrap 0.16.2`; `diffy 0.4.2`; `unicode-segmentation`, `unicode-width 0.2` |
| Protocol coupling | `codex-protocol`, `codex-app-server-protocol`, `codex-core-plugins`, `codex-features`, `codex-git-utils`, `codex-terminal-detection`, `codex-shell-command`, `codex-ansi-escape` appear in imports of the files below (named per file) |

### 3.2 Candidate files

Blobs at `b016cd1`. "Tests" counts `#[test]`/`#[tokio::test]` in the file itself; sibling `*_tests.rs` files are named separately. Wasm column: nothing in `codex-rs/tui` documents wasm (grep for `wasm` in the tui and workspace `Cargo.toml` found nothing), so every entry is unverified; the notes name the specific blockers.

| Piece | File (lines) | Blob | External deps and blockers | Tests | Verdict |
|---|---|---|---|---|---|
| Composer text area (multiline, wrap, atomic elements, kill buffer, vim) | `bottom_pane/textarea.rs` (4,797) + `textarea/{editing 85, wrapping 225, mouse 189, single_line 47, hyperlinks 98, register 73, vim 336, vim_commands 745, vim_search 251}` | `5955f861790b327ec9fe1014ebeff945f92bcfa5` (`textarea.rs`); `wrapping.rs` `1250ba71bf814881c0828851321d151bfa256606` | `crossterm::event::{KeyEvent,KeyCode,KeyModifiers,KeyEventKind}` (5 import lines in `textarea.rs`, used by `input(KeyEvent)`), `crate::keymap::*` (4,606-line keymap module), `crate::key_hint`, `codex_protocol::user_input::{ByteRange, TextElement}` (131-line file), `ratatui` `StatefulWidgetRef`/`WidgetRef` (unstable-widget-ref), `unicode-segmentation`, `unicode-width` via `width.rs`, `rand` in tests | 104 in `textarea.rs`, plus `wrapping_tests.rs` 416, `editing_tests.rs` 74, `mouse_tests.rs` 200, `vim_commands_tests.rs` 829 | reuse with adaptation (seams: replace `KeyEvent` with the web key bridge type, replace `ByteRange`/`TextElement` with a local 10-line type, drop `keymap` and vim). Gaps: see 3.3. |
| Paste handling | `bottom_pane/paste_burst.rs` (610) | `57c855d0980c311133e3caebe30cb2bdc9ff4316` | only `std::time::{Duration, Instant}`; documented as "a pure state machine: it never mutates the textarea". `Instant::now()` panics on `wasm32-unknown-unknown` unless swapped for `web-time`. Needed only for terminals without bracketed paste; a browser delivers a `paste` event, so this is likely not needed. | in file | reference only |
| Composer controller and paste placeholders | `bottom_pane/chat_composer.rs` (12,822) | `23e499ebb127c0958cb40e1136122dc260682329` | `AppEvent`, `AppEventSender` (tokio mpsc), `codex_protocol`, `codex_features`, slash commands, mentions, images, vim, status footer | extensive | reference only (behavior oracle: Enter/Shift+Enter, atomic paste placeholders, history recall) |
| Composer history (Up/Down, Ctrl+R search) | `bottom_pane/chat_composer_history.rs` (1,628) + `chat_composer_history/search_batch.rs` | `6ec2145e7ecac0fdada13b152847104beccb582f` | `AppEvent`, `codex_message_history::HistoryBatchCursor`, `codex_protocol::ThreadId`, `TextElement`, mention codec; persistent history is fetched through app events | `search_batch_tests.rs` | reference only (local in-session history part is small; persistence belongs to Theorem) |
| Public reusable composer | `public_widgets/composer_input.rs` (149) | not recorded | wraps `ChatComposer` + tokio unbounded channel | none | reference only (shows the intended public surface, still pulls the whole composer) |
| Markdown to Ratatui `Line`s | `markdown_render.rs` (3,353) + `markdown_render/*` | `242f472e101874d250b6024a93cf7b7c05e837d2` | `pulldown-cmark 0.10` (pinned lower than ELY's 0.13), `crate::render::highlight` (syntect + two_face + onig), `crate::terminal_hyperlinks` (1,459 lines), `crate::wrapping`, `crate::style`, `crate::line_truncation`, `markdown_text_merge`, math and mermaid submodules (`codex-mermaid` crate) | 35 in file plus `markdown_render_tests.rs`, `*_tests.rs`, `snapshots/` | reuse with adaptation (seams: syntect backend, hyperlink type, mermaid/math, pulldown version) |
| Markdown entry points and normalization | `markdown.rs` (804) | `97ece6e64f7241924d004dd34c100e4f16ff424c` | `inline_visualization`, `table_detect` (488 lines), `terminal_hyperlinks` | 18 | reuse with adaptation (same seams) |
| Streaming markdown collector (newline-gated) | `markdown_stream.rs` (905) + `streaming/mod.rs` (131) | `9b03f1438f742ae69c2c7bdd256f7e06efa01bff`, `5a51b67b3e2e7b35c7c3e99a004126a38b1ed643` | `crate::markdown`, `std::path`; `Instant` in `streaming/mod.rs` | 24 + 1 | reuse with adaptation (replace `Instant` with `web-time`, drop `Path` link resolution if no local links) |
| Stream pacing policy | `streaming/chunking.rs` (457), `commit_tick.rs` (223) | `9bf43cba52798cc223b75e1cdfb5de17c365068e`, `7d46dcb0ff4d5d123764223472f4c25efedac2fe` | `chunking.rs`: std only (`Duration`, `Instant`); `commit_tick.rs`: `HistoryCell`, `StreamController` | 9 tests inline (`#[cfg(test)]` at line 296) | `chunking.rs`: reuse with adaptation (`Instant` to `web-time`); `commit_tick.rs`: reference only |
| Stream controller (message and plan streams to cells) | `streaming/controller.rs` (2,208) | `39f10f7c683d020ba381739216864164cd797099` | `HistoryCell`, `inline_visualization`, `markdown::render_markdown_agent_with_list_spacing`, `style` | `controller_preview_tests.rs` 510, `render_tests.rs` 565, others | reference only |
| Live transcript cell model | `history_cell/mod.rs` (397), `history_cell/messages.rs` (936: `AgentMessageCell` line 511, `StreamingAgentTailCell` line 797) | `ff152d5d4e755df40797a40e1ce06a5eaf0dbcff`, `84f5a863732c7a4e3dc96f49dc70d05f60a57b64` | trait `HistoryCell` (`mod.rs:205`: `display_lines(width)`, `raw_lines`, `copy_source`, `is_stream_continuation` (348), `transcript_animation_tick` (362)); `ChatWidget.active_cell` is one mutable in-flight cell (`chatwidget.rs` module docs, lines 7-14); `AbsolutePathBuf`, `codex_protocol` | `history_cell/tests.rs`, `messages_tests.rs` | reference only (the shape is the useful part: width-parameterized `display_lines`, one active mutable cell plus immutable committed cells) |
| Tool-output disclosure | `exec_cell/{model 274, render 1411, compact 132, live_output 259}`, `history_cell/exec.rs` (274), `tool_output.rs` (133) | `exec_cell/model.rs` `241e682a494dca3d9478c6201d40badb25197def`, `render.rs` `fe6c327f3e733be25012af616989ac180b007d40`, `tool_output.rs` `4cdfe816bccc9c5b3169e3024d550fa8dca0bbe9` | `codex_protocol::parse_command::ParsedCommand`, `codex_app_server_protocol::CommandExecutionSource`, `codex_shell_command`, `codex_ansi_escape`, `itertools`, `motion` | `render.rs` 14; `live_output_tests.rs`, `transcript_tests.rs` | reference only (disclosure policy such as head/tail truncation and expanded-on-demand is the value; data model is Codex protocol) |
| Diff rendering | `diff_render.rs` (2,745), `diff_model.rs` (21) | `395a8746e9f5e11a1f1f277bbbf14bfa6f35aaf4`, `3b7055ea17802d4a893590e2576599053b138739` | input is `FileChange::{Add{content}, Delete{content}, Update{unified_diff, move_path}}` (a plain string model, so a Theorem SCM diff can feed it); blockers: `codex_git_utils::get_git_repo_root`, `codex_terminal_detection`, `terminal_palette` (queries terminal bg and color level), `render::highlight` (onig), `diffy::Hunk`, `terminal_hyperlinks`, `exec_command::relativize_to_home` | 51 + snapshots | reuse with adaptation (seam: replace terminal color detection with the theme contract, replace syntect backend) |
| Wrapping and width | `wrapping.rs` (2,096), `width.rs` (109), `line_truncation.rs` (114), `live_wrap.rs` (292) | `ae0ce0074dced8d6cf7053c3749b9d4eac5955ae`, `9c9fe3e55d4bf20ddeb1bbbeac6348ced405cf11`, `42248714d951b6d529a629c42f73cd5a92f9eabc`, `a0ad15ba6662f47a2a7314ffd412b8aa9c3c9726` | `textwrap 0.16.2`, `unicode-segmentation`, `unicode-width 0.2`; `line_truncation` needs `ratatui::buffer::CellWidth` | 47, 3, 0, 6 | `width.rs`, `live_wrap.rs`: reuse as is (std plus unicode crates; wasm unverified); `wrapping.rs`: reuse with adaptation (pulls `render::line_utils`); `line_truncation.rs`: reuse with adaptation (Ratatui version check) |
| Syntax highlight backend | `render/highlight.rs` (1,700) | `26c21acabecdd69fe3881fc214ecae78e37b15ba` | `syntect` with `regex-onig`, `two_face` | in `highlight_*_tests.rs` | reference only; replace with syntect `regex-fancy` (section 4) |
| Approval UI | `bottom_pane/approval_overlay.rs` (2,613), `history_cell/approvals.rs` (351) | `a0ba70a7b1a4eaeb4d93831b57b75489c4f160ea`, `b6ba3acb6650a04a91f185b4dfdc76ea3ddf7a6a` | ~15 `codex_app_server_protocol` types (command, file change, network, MCP elicitation, permissions), `ListSelectionView`, `AppEvent`, `crossterm` keys, `keymap::ApprovalKeymap` | 37 | reference only (decision set and summary layout: command, diff preview, scope of grant; rebind to Theorem's approval contract) |

### 3.3 Specific answers

| Question | Answer |
|---|---|
| Files for composer text area, key bindings, paste, history | Text area: `tui/src/bottom_pane/textarea.rs` and `textarea/*`. Key bindings: `tui/src/keymap.rs` (4,606 lines, `EditorKeymap`, `RuntimeKeymap`, vim keymaps) and `key_hint.rs` (493), consumed by `textarea.rs:23-31`. Paste: `bottom_pane/paste_burst.rs` plus paste placeholders in `chat_composer.rs`. History: `bottom_pane/chat_composer_history.rs`. |
| Markdown renderer, diff renderer, streaming cell model, approval UI | Markdown: `markdown_render.rs`, `markdown.rs`. Diff: `diff_render.rs`, `diff_model.rs`. Streaming/live: `streaming/*`, `markdown_stream.rs`, `history_cell/messages.rs`, `history_cell/mod.rs` (`HistoryCell` trait), `chatwidget/streaming.rs`. Approval: `bottom_pane/approval_overlay.rs`, `history_cell/approvals.rs`. |
| Already separable (few intra-crate imports)? | Yes, with caveats. Fewest crate-internal imports: `width.rs` (2 external crates, 0 crate imports), `live_wrap.rs` (1 crate import: `width`), `streaming/chunking.rs` (std only), `diff_model.rs` (serde only), `paste_burst.rs` (std only), `markdown_stream.rs` (imports `crate::markdown` only). Not separable without cutting: `markdown_render.rs` (about 12 crate imports), `diff_render.rs` (about 25), `approval_overlay.rs` (about 40 including protocol), `exec_cell/render.rs` (about 20), `textarea.rs` (keymap, key_hint, protocol). |
| Cursor unit and wide characters in the composer text area | Cursor is a byte offset: `cursor_pos: usize` (`textarea.rs:149`), clamped with `clamp_pos_to_nearest_boundary` (286, 309, 545, 555) and moved by grapheme clusters through `prev_atomic_boundary` (1974) / `next_atomic_boundary` (2000) and `grapheme_indices(true)` (621). "Atomic" also covers placeholder element ranges. Display columns come from `unicode_width` through `width::display_width` (`width.rs:19`), which adds one cell for the halfwidth sound marks U+FF9E/U+FF9F. Tests include random wide and ZWJ graphemes (`textarea.rs:2406` `rand_grapheme`, wide and ZWJ cases to about line 2436). So: bytes as the stored unit, graphemes as the movement unit, terminal cells as the display unit; wide characters are handled. |
| Does it provide selection and undo/redo (spec R09, R21)? | Selection: only mouse selection (`mouse_selection`, `textarea/mouse.rs`). No keyboard selection (no shift-extend; the `selection`/`anchor` greps return nothing). Undo/redo: none in `textarea.rs`; the composer has only Vim-mode undo snapshots (`chat_composer.rs:103`, `chat_composer/vim_history.rs`). The spec requires "real selection and local undo" (R21) and undo/redo plus selection in the source editor (R09). Codex's text area does not supply either. |

### 3.4 Risks specific to Codex

| Risk | Detail |
|---|---|
| Direct reuse of the textarea means keeping a 4,800-line file plus editing the key input seam; selection and undo would still need adding (hand-rolling) when a library already has both (section 4). |
| `std::time::Instant` in `streaming/*` and `paste_burst.rs` panics at runtime on `wasm32-unknown-unknown` unless replaced (the standard fix is `web-time`; `similar` documents the same feature). |
| `syntect` with `regex-onig` links a C library; wasm needs the `regex-fancy` feature set (section 4). |
| Terminal-specific color and hyperlink code (`terminal_palette.rs`, `terminal_hyperlinks.rs`, 1,459 lines) is wired into the Markdown and diff renderers; the web theme contract replaces it. |
| Ratatui 0.30.2 plus unstable features versus the project's 0.30.1: unverified. |

## 4. Candidate crates (checked against crates.io API and repos)

Version is `max_stable_version` from `https://crates.io/api/v1/crates/<name>`. "Ratatui" column shows what the crate itself depends on.

| Need | Crate | Version (released) | License | Ratatui target | wasm32-unknown-unknown | Notes |
|---|---|---|---|---|---|---|
| Browser renderer | `ratzilla` | 0.3.1 (2026-06-08) | MIT OR Apache-2.0 | `ratatui ^0.30.1`, default-features off, `all-widgets`, `layout-cache` | documented (README: add target `wasm32-unknown-unknown`; DOM, Canvas, WebGL2 backends, `beamterm-renderer`) | `src/event.rs` defines only `KeyEvent`, `MouseEvent`, `KeyCode`, `MouseButton`, `MouseEventKind`; no paste, composition or IME event types (grep for `composition`, `paste` in `src` found none). Paste and IME need the "shared web input bridge" the spec names. |
| Layout | `ratatui` | 0.30.2 (2026-06-19); 0.30.1 is the project pin | MIT | n/a; 0.30.1 depends on `ratatui-core ^0.1.1`, `ratatui-widgets ^0.3.1` | via Ratzilla | `ratatui-textarea` and `edtui` use the split crates, so they interoperate with 0.30.x. |
| Text editor widget | `ratatui-textarea` | 0.9.4 (2026-10-31) | MIT | `ratatui-core ^0.1.1`, `ratatui-widgets ^0.3.1`; `crossterm` backend is an optional default feature (`default = ["crossterm"]`; can be disabled) | not documented (no `wasm` string in repo); deps are `ratatui-core`, `ratatui-widgets`, `unicode-segmentation`, `unicode-width`; `portable-atomic` feature exists. Unverified. | Undo/redo (default 50 steps, `set_max_histories`), selection (`start_selection`, `selection_range`), paste (yank), search (feature `search`), wrap modes `None/Glyph/Word/WordOrGlyph` (`wrap.rs`, grapheme-aware, CJK tests), 147 tests. Cursor is `(row, col)` where `col` counts `char`s (`cursor.rs:353` `chars().count()`), lines are `Vec<String>`: movement can stop inside a grapheme cluster (combining marks, ZWJ), and bytes/UTF-16 must be converted at the adapter (R13). Successor of `tui-textarea` (which is stale: 0.7.0, 2024-10-22, ratatui ^0.29). |
| Alternative editor | `edtui` | 0.11.7 (2026-08-16) | MIT | `ratatui-core ^0.1`, `ratatui-widgets ^0.3.0` | hard dependency on `crossterm ^0.29`, default `arboard` clipboard and `syntect` features; wasm undocumented. Unverified, likely blocked by arboard/crossterm. | Vim-modal editor; its model does not match a conventional source editor. Reference only. |
| Rope | `ropey` | 1.6.1 stable (2023-10-18); `2.0.0-beta.1` (2025-08-02) | MIT | n/a | undocumented, no dependencies listed beyond std; unverified | Not needed for Gate 0 scale; `ratatui-textarea` holds `Vec<String>`. Revisit only if large-file editing is measured to need it. |
| Markdown parse with offsets | `pulldown-cmark` | 0.13.6 (2026-10-30) | MIT | n/a | `no_std` documented in README (`--no-default-features`); wasm itself unverified | `into_offset_iter()` yields `(Event, Range)` byte ranges (README lines 63-66); ELY already builds its tree on it (`markdown/build.rs:51`); Codex uses 0.10 (version skew when copying Codex code). |
| Markdown parse alternative | `markdown` (markdown-rs) | 1.0.0 (2025-04-23) | MIT | n/a | `default = []`; wasm undocumented | mdast with `position` carrying line:col and offset (`1:1-1:14 (0-13)`); not used by either donor. |
| Markdown parse alternative | `comrak` | 0.59.0 (2026-10-26) | BSD-2-Clause | n/a | README mentions wasm only through a third-party binding | `sourcepos` is line and column (`--sourcepos-chars` toggles chars versus UTF-8 bytes), not byte offsets. Reference only. |
| Markdown to Ratatui text | `tui-markdown` | 0.3.13 (2026-11-01) | MIT OR Apache-2.0 | `ratatui-core ^0.1`, `pulldown-cmark ^0.13.5` | undocumented; default feature `highlight-code` links `syntect` with `regex-onig` (disable default features to avoid) | README: "experimental Proof of Concept". Table, task-list and streaming coverage unverified. |
| VT parse | `vt100` | 0.18.1 (2026-10-19) | MIT | n/a | `std` feature only (`std = ["vte/std"]`); wasm undocumented. Unverified. | The spec's Ratzilla note says it is not an automatic ANSI emulator; raw terminal bytes would need this. |
| VT widget | `tui-term` | 0.3.4 (2026-04-07) | MIT | `ratatui-core ^0.1.0`, `ratatui-widgets ^0.3.0` | undocumented. Unverified. | Depends on `vt100 ^0.16.2` while latest `vt100` is 0.18.1: version skew; `portable-pty` is optional (feature `unstable`). |
| Syntax highlight | `syntect` | 5.3.0 (2025-09-27) | MIT | n/a | `default-fancy` feature set exists ("Pure Rust `fancy-regex` mode, without `onig`", README line 127); wasm itself unverified | Codex and `tui-markdown` default to `regex-onig`; choose `regex-fancy`. Bundled syntaxes make binary size a measurement item. |
| Syntax highlight alternative | `tree-sitter-highlight` | 0.27.2 (2026-11-07) | MIT | n/a | grammar crates compile C; wasm32-unknown-unknown requires a C-to-wasm toolchain; unverified | Per-language grammar crates add weight. Not recommended for Gate 0. |
| Diff | `similar` | 3.2.1 (2026-10-24) | Apache-2.0 | n/a | `wasm32_web_time` feature documented in `Cargo.toml` (swaps `Instant` for `web-time`); `no_std` mode documented in README | Used by both ELY crates. |
| Diff alternative | `imara-diff` | 0.2.0 (2025-06-14) | Apache-2.0 | n/a | undocumented; no dependencies; unverified | Faster Myers/histogram; no word-level inline helpers. |
| Graphemes | `unicode-segmentation` | 1.13.3 (2026-06-01) | MIT OR Apache-2.0 | n/a | `#![no_std]` documented (README line 30-33); wasm itself unverified | Required by every editor candidate. |
| Display width | `unicode-width` | 0.2.3 (2026-10-28) | MIT OR Apache-2.0 | n/a | `#![no_std]` documented (README line 10) | Ratzilla requires `^0.2.2`. |

## 5. Recommended extraction set

Chosen by the project rule: use a library when one models the concept; extract donor code only where no library does. "Hand-roll" appears only where nothing upstream covers the need.

| Piece needed by the spec | Chosen source | Pin | License | Adaptation seam | Open risk |
|---|---|---|---|---|---|
| Shared text buffer for Source editor, Markdown Source, composer (R09, R10, R21) | `ratatui-textarea` (default features off) | crate 0.9.4; repo `cf670f920d407ae70e729c67e5ea9fe2db3f275a` | MIT | adapter that maps `(row, char col)` to UTF-8 byte offsets, grapheme boundaries and UTF-16 units, carrying revision (R13); key input from the web bridge (feature `crossterm` off) | `char`-indexed cursor can land inside a grapheme cluster; wasm build unverified; draft persistence of `Vec<String>` not specified |
| Composer wrapping with wide chars, atomic placeholder ranges | not extracted by default; Codex `textarea/wrapping.rs` and `width.rs` as reference | codex `b016cd18...`, `wrapping.rs` blob `1250ba71...` | Apache-2.0 | n/a unless `ratatui-textarea` wrapping is insufficient | `ratatui-textarea` has no atomic element ranges (attachments/references need them: R21) |
| Markdown parser with byte spans (R10, R12, R13) | `pulldown-cmark` 0.13.6 `into_offset_iter` via ELY `markdown/{build,build/node,build/text,flow,front,shape,autolink,mdast}.rs` | ELY `078bf26`; `build.rs` blob `982dbcb4...`, `mdast.rs` `663b0ba3...` | MIT (ELY) + MIT (pulldown) | rewrite `crate::tree::{Style,html}` imports; drop `tex.rs` unless math is wanted | wasm unverified; full reparse per call needs a size budget |
| Block ranges for Visual mode (R10) | ELY `src/markdown.rs::block_ranges` (line 213) | ELY `078bf26`, blob `067086687929d780562b242245c959e8d42fb3f1` | MIT | strip `markdown_highlights` and GPUI imports | blocks exclude inter-block text; confirm that matches the "untouched source byte-for-byte" rule |
| Block and inline edit commands as range patches (R12) | ELY `document/{block,block/*,format,format/*,cells,parse}.rs` | ELY `078bf26`; `block.rs` `fc45932b...`, `format.rs` `2db3e358...`, `cells.rs` `d5e42cba...`, `parse.rs` `07974e88...` | MIT | extract `TargetBlock` from `document/mod.rs`; add document revision to every returned `Change` | 254-test crate; the pure subset's 106 inline tests need re-running outside GPUI; some test files are GPUI-bound |
| Visual open/commit, mode enum (R10, R11) | ELY `modes.rs`: port `MarkdownMode` (line 25), `shifted` (70), `joint` (82); re-implement `commit` (93) | ELY `078bf26`, blob `2e6bca2e...` | MIT | pending block draft keyed by `(base revision, range)`; overlapping edit becomes a conflict through the document owner | the donor tests at `modes/tests.rs:6` and `:62` assert the forbidden drop behavior and must be replaced |
| Markdown to Ratatui rendering for Preview, Visual blocks, Theo transcript (section 7, 8) | Codex `markdown_render.rs` + `markdown.rs` (adapted), with ELY `tree/*` as the second option | codex `b016cd18...`; blobs `242f472e...`, `97ece6e6...` | Apache-2.0 (+ Ratatui MIT NOTICE) | replace `render::highlight` (onig) with syntect `regex-fancy`, `terminal_hyperlinks` with the web link type, pulldown 0.10 to 0.13; remove mermaid/math or route to the artifact path (spec 8.2 says diagrams go to the safe artifact path) | 3,353-line file with 35 tests plus snapshots; version skew with ELY's pulldown 0.13; `tui-markdown` (proof of concept) not evaluated for tables |
| Streaming transcript pacing (section 7) | Codex `streaming/chunking.rs`, `streaming/mod.rs`, `markdown_stream.rs` | codex `b016cd18...`; blobs `9bf43cba...`, `5a51b67b...`, `9b03f1438...` | Apache-2.0 | `Instant` to `web-time`; feed from Theorem conversation events, not Codex protocol | policy tuned for terminal scrollback, not a bounded browser queue |
| Live and committed cell model (section 7) | Codex `history_cell/mod.rs` trait shape (`display_lines(width)`, active mutable cell) | codex `b016cd18...`, blob `ff152d5d...` | Apache-2.0 | reference only; implement as the Elm model's transcript view | none beyond reimplementation |
| Tool-output disclosure | Codex `exec_cell/*` and `tool_output.rs` (policy) | codex `b016cd18...` | Apache-2.0 | reference only: model is `ParsedCommand`/app-server protocol | cannot be extracted without protocol crates |
| Diff rendering for agent edits and Changes inspection | Codex `diff_render.rs` (input: unified diff string) | codex `b016cd18...`, blob `395a8746...` | Apache-2.0 | remove `codex_git_utils`, `terminal_detection`, `terminal_palette`; syntect backend; theme tokens | 2,745 lines; 51 tests tied to terminal color levels |
| Diff computation | `similar` 3.2.1 with feature `wasm32_web_time` | crate 3.2.1 | Apache-2.0 | none | none known |
| Changes data model and panel behavior (R17, R18) | ELY `ELYTerminal src/git.rs` model (`Repo`, `Change`), `panel.rs` rules, `Ely-GPUI-Components@294a8323 src/git/{changes,commits,diff}.rs` types | ELYTerminal `fbb536ec...` (`panel.rs` `26133bcf...`); Components `294a8323c08a06bd8e7782d16acee43b6bb0c5eb` | MIT | all `git()` calls replaced by Theorem SCM effects; `PathBuf` becomes workspace resource identity; add revision binding | ELY has no stale-diff or revision binding; branch/merge/fetch/push/blame are not in the panel |
| Approval UI | Codex `approval_overlay.rs` as behavior reference | codex `b016cd18...` | Apache-2.0 | rebind to Theorem approval contract | 2,613 lines of protocol coupling; not extractable |
| Paste handling | browser `paste` event through the web input bridge; Codex `paste_burst.rs` not needed | n/a | n/a | Ratzilla exposes no paste or IME events | input bridge is new code (spec 7.2 already requires it) |
| Syntax highlighting (code fences, source editor) | `syntect` 5.3.0, `default-fancy` | crate 5.3.0 | MIT | n/a | binary size and highlight time in wasm are unmeasured |
| Terminal output (Herdr panes) | `vt100` + `tui-term` | `vt100` 0.18.1 / `tui-term` 0.3.4 | MIT | spec says Ratzilla is not an ANSI emulator; version skew between the two crates | not part of this survey's three donors; wasm unverified |

## 6. Unverified items and biggest risks

| Item | Status |
|---|---|
| Any crate or donor file compiling for `wasm32-unknown-unknown` | unverified; nothing was built. Documented support exists only for Ratzilla (target), `similar` (`wasm32_web_time`), `unicode-width`, `unicode-segmentation` and `pulldown-cmark` (`no_std`), and `syntect` (`fancy-regex` mode). |
| Ratatui 0.30.2 APIs used by Codex (`CellWidth`, unstable features) against the project's 0.30.1 | unverified |
| Hunk-level diff or revision-bound mutation in any donor | absent; R18 is new work |
| ELY parse cost per keystroke on large documents | unmeasured |
| Codex textarea has no keyboard selection and no undo/redo | verified by grep of `textarea.rs` and `textarea/*` |
| ELY data-loss path | `modes.rs:104-109` (and `:350-355`); donor tests at `modes/tests.rs:6` and `:62` pin the behavior |
