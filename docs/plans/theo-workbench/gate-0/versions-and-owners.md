# Gate 0: versions and owners

Recorded 2026-11-14 from a read-only inspection. Nothing was built, started, deployed or changed. Paths are relative to the Theorem-UI worktree unless prefixed `backend:` (the Theorem repo, read through `git show` / `git ls-tree` after `git fetch`). "Not verified" marks anything inferred from source only.

## 1. Version pins

### 1.1 Frontend and SDK

| Item | Value | Evidence |
|---|---|---|
| Theorem-UI worktree HEAD | `4240360b6f9adb970e7b35ad46209386e8a1f289` on `feat/theo-workbench` | `git rev-parse HEAD` |
| Base chain | `origin/main` 2a479ca30dcef39517b0f8fa149d3c5447bc18cf and PR #111 head `d4e60c5e` are ancestors of HEAD; HEAD sits on `origin/claude/artifact-cabinet` (PR #112, `ff2f1cdf`) plus one docs commit | `git merge-base --is-ancestor`, both true |
| SDK package | `@theoremharness/sdk` `file:vendor/theoremharness-sdk-0.6.0-alpha.5.tgz` | `package.json:120`; `bun.lock:1233`; tgz `package/package.json` version `0.6.0-alpha.5` |
| SDK patch | `patches/@theoremharness%2Fsdk@vendor%2Ftheoremharness-sdk-0.6.0-alpha.5.tgz.patch` (patches `dist/assistant-ui.cjs`: run-release wait, background send retry, text-part purpose/segment meta, approval statuses) | `package.json:273` (patchedDependencies); patch file head |
| Other vendored SDK | `vendor/theoremharness-sdk-0.6.0-alpha.3.tgz` is present; `package.json` does not reference it (whether anything else does was not checked) | `ls vendor` |
| SDK terminal surface | `ide.terminal` client: `open`, `input`, `resize`, `attach`, `copy`, `paste`, `search`, `close`. `open` takes opaque `NativeArguments`, so `backend`/`argv`/`name` are not typed. `TerminalChannel` is exported from `dist/index.js` (`dist/types/src/terminal.d.ts`). | tgz contents (`.../ide/resources/terminal/client/Client.d.ts:39-232`, `requests/OpenTerminalRequest.d.ts`); consumer `ide/theia-extensions/theorem-workspace/src/browser/theorem-terminal.ts:20,50,78` |
| RustyRed browser package | `@rustyreddb/browser` `file:vendor/rustyreddb-browser-0.1.0-beta.2.tgz` (version `0.1.0-beta.2`); Node binding `@rustyreddb/node` `0.1.0-beta.2` | `package.json:106-107`; `bun.lock:1061,1063`; tgz `package/package.json` |
| RustyRed browser consumer | `src/lib/blocks/app-db.ts:1-4` (Apps' databases; no document-persistence consumer found) | file head |
| TanStack | `@tanstack/react-router` 1.170.45, `@tanstack/react-start` 1.169.3, `@tanstack/react-hotkeys` 0.16.0 | `package.json:112,115,117` |
| Dock library | `dockview-react` 8.6.1 | `package.json:146` |
| Package manager | `bun@1.4.3` | `package.json:5` |

### 1.2 Terminal crate (Ratzilla/Ratatui)

| Crate | `terminal/Cargo.toml` | `terminal/Cargo.lock` resolved |
|---|---|---|
| `ratzilla` | `"0.3.1"` (`:13`) | 0.3.1 (`:513-514`) |
| `ratatui` | `0.30.1`, `default-features = false`, `unstable-rendered-line-info` (`:14`) | **0.30.2** (`:463`) |
| `tui-markdown` | `0.3.12`, no default features (`:15`) | 0.3.12 (`:768`) |
| `tui-input` | `0.15.5`, no default features (`:16`) | 0.15.5 (`:758`) |
| `wasm-bindgen` | `=0.2.127` (`:18`) | 0.2.127 (`:824`) |
| crate | `theorem-terminal` 0.1.0, edition 2024, `crate-type = ["cdylib", "rlib"]` (`:1-9`); release profile `opt-level = "s"`, `lto = true` (`:30-33`) | |
| Toolchain | `channel = "1.96.1"`, `profile = "minimal"`, `targets = ["wasm32-unknown-unknown"]` (`terminal/rust-toolchain.toml:2-4`) | |

Local machine: default `rustc`/`cargo` 1.97.1; `1.96.1-aarch64-apple-darwin` is installed (the pin applies inside `terminal/`); `wasm-bindgen` CLI 0.2.127 (matches). CI installs 1.96.1 and `wasm-bindgen-cli 0.2.127` (`.github/workflows/composer.yml`, steps "Install the terminal Rust toolchain" and "Install the matching WebAssembly bindings generator").

The lock's ratatui 0.30.2 is newer than the manifest's 0.30.1; that is a semver-compatible resolution, not a mismatch.

### 1.3 Herdr Core CLI (local)

| Item | Value |
|---|---|
| Binary | `~/.local/bin/hc`, a symlink to `herdr-core` |
| `hc --version` | `hc 0.1.17` (matches the version PR #1046 reports testing against) |
| `hc schema` (JSON Schema/OpenRPC document) | `info.title` `herdr-core`, `info.version` `0.1.17`, description "JSON-RPC 2.0, one message per line on the hc socket (or framed after `hello`)... Protocol generation 1"; license Apache-2.0; 34 component schemas; stdout SHA-256 `9bc36202da4a5a12877b619c376b173fa3682ff9aedd4d410d1fab0dae13ff83` |
| Server state | `~/.config/herdr-core` does not exist on this machine. `hc server status` was not run. Whether `hc schema` contacted a running core was not verified. |

### 1.4 Backend (Theorem repo)

| Item | Value | Evidence |
|---|---|---|
| `origin/main` | `65efa3ad4f4f6deedda04dfd7095be79b9047c32` (2026-11-14 11:23 -05:00, "Merge pull request #1068 from Travis-Gilbert/Travis-Gilbert/theorem-surface-rollout") | `git rev-parse origin/main` after `git fetch` |
| PR #1046 merge commit `4ea31c116be6e09591cd831dea770d3d12017a7b` is an ancestor of `origin/main` | **No** (`git merge-base --is-ancestor` fails) | |
| PR #1046 head `3a4293c75afa918e1196554fb59f619473d8da41` is an ancestor of `origin/main` | No | |
| Where #1046 landed | `4ea31c11` is the tip of `origin/feat/herdr-lifecycle` (PR #1046's base; 22 commits ahead of and 323 behind `origin/main`; merge-base `f5db08a2f3`, 2026-11-10). `gh pr view 1046`: merged 2026-11-12T17:35:28Z into `feat/herdr-lifecycle`. | `git rev-list --count` |
| Stack | #1046 -> `feat/herdr-lifecycle`; #1045 (`feat/herdr-lifecycle` into `feat/herdr-control-leases`, merged 2026-11-12T13:44Z); #1042 (`feat/herdr-control-leases` into `feat/herdr-terminal-backend`, merged 2026-11-12T13:43Z); root #1021 `feat/herdr-terminal-backend` -> `main` is **OPEN**. None of the three branch tips is in `origin/main`. | `gh pr list --head`, `git merge-base --is-ancestor` |
| `apps/theorem-ide-host/src/terminal.rs` on `origin/main` | **Absent** | `git ls-tree origin/main apps/theorem-ide-host/src/` |
| `apps/theorem-ide-host/src/vt_screen.rs` on `origin/main` | **Present**, blob `0b891eeefda001385966a8756b92234aa54d440f` (last touched `b9df3009b2`). The spec's S05 blob `ad53101ea94a20a852883468d78233f01714d032` is the `feat/herdr-lifecycle` blob (a 2-line difference). | `git ls-tree`, `git hash-object` |
| Terminal modules on `origin/main` | `pty.rs` (blob `70c122d9288ea8a8cf44a7dfb93f281dfea3a68f`); no `herdr/` directory in `src/`. `git grep herdr origin/main -- apps/theorem-ide-host/src` returns nothing. | |
| On `origin/feat/herdr-lifecycle` | `terminal.rs` blob `51db90d94cc2c9187c5c21aadf3cad796665743c` (equals SOURCES.md S04), `herdr/{client,codec,mod}.rs`; `pty.rs` removed | `git ls-tree`, `git diff --stat origin/main origin/feat/herdr-lifecycle` |
| Deployed backend | Not verified. Memory notes say the IDE host runs on a Fly Sprite since 2026-11-09; which commit is deployed was not checked. | |

## 2. The web Theo route

No route, component or file is named for a Theo page. `Theo` in `src/` is the agent's animated face (`src/components/face/*`, `src/lib/face/*`) and a name used in comments. The page the spec calls "the web Theo route" is, by structure, chat mode: `/`, `/c/$threadId` and `/projects/$projectId`. The IDE (`/ide`) is the other candidate and is where Theia lives (see section 8, item 1).

| Concern | Owner | Lines |
|---|---|---|
| Pathless layout for every shell route; owns the auth gate, runtime provider, palette, preference sync | `src/routes/_chat.tsx` `ChatLayout` | route `22-26`; sign-in gate `62-71`; unreachable `72-78`; provider + `ChatShell` + `<Outlet/>` `81-93` |
| Chat routes (render `null`; the layout draws everything) | `src/routes/_chat/index.tsx`, `[index].tsx`, `c.$threadId.tsx`, `projects.$projectId.tsx` | each is `component: () => null` |
| Other modes | `_chat/{notes,notes.$documentId,pages,pages.$pageId,vault,spaces,canvas,ide}.tsx` | |
| Mode from route | `useShellMode()` reads router matches | `src/components/shell/modes.tsx:77-94`; `MODES` `:33-44`; `useOpenMode` `:97-115` |
| Shell | `ChatShell` | `src/components/shell/chat-shell.tsx:450-466`: `DesktopShell`, `AgentComposer` (canvas composer), `WorkspaceCommands`, `TerminalDrawer`, `SideTerminal` |
| **Outer rail** | `<Rail collapsible />` in `.appearance-docked-rail` | `chat-shell.tsx:398-400` (component `src/components/shell/rail.tsx`); overlay copy in `NavigationDrawer` `:98` |
| Sheet (rounded surface beside the rail) | `DesktopShell` | `chat-shell.tsx:378-448`; `.sheet` `:410`; `LifeSheet` `:416`; `SheetSplit` `:417` |
| Two-column split (panel + dock), dockview `SplitviewReact` | `SheetSplit` | `chat-shell.tsx:213-366`; panels registered `:268-288` |
| **Conversation sidebar** (the part the spec replaces with Files) | `GlassPanel` -> `ContextPanel` -> `OrganizedPanel` (+ `Explorer` footer) | `GlassPanel` `chat-shell.tsx:177-201` (`<ContextPanel/>` at `:197`); `src/components/shell/sidebar.tsx:175-229` (chat branch `:185-187`); `ProjectSwitcher` `sidebar.tsx:48-138`; files tree `FoldersSection` `sidebar.tsx:221-223` |
| **Dock hosting the thread** | `DockView` -> `DockShell` (dockview) | `chat-shell.tsx:135-161` (`DockShell` at `:145`); `src/components/shell/dock.tsx:699-855` |
| Conversation panel in the dock | `ThreadPanel` -> `ModeView docked` | `dock.tsx:118-153` (`<ModeView docked/>` at `:150`) |
| **Thread mount** | `ModeView` renders `<Thread covered=.../>` inside `LifeBackdrop`; `ProjectHome` replaces it at `/projects/$projectId` | `modes.tsx:123-147` (`Thread` `:135`, `ProjectHome` `:132`) |
| **Composer mount** | `Thread` mounts `<Composer .../>` | `src/components/assistant-ui/elements/thread.aui.tsx:226` (`Thread`), `:329` (`Composer`); `Composer` in `src/components/chat/composer.tsx`, editor in `composer-editor.tsx` |
| Runtime/thread context | `TheoremRuntimeProvider projectId threadId` | `_chat.tsx:82-86`; `src/lib/theorem/runtime.tsx` |
| Terminal drawers (Ratzilla, not a PTY) | `TerminalDrawer` (bottom), `SideTerminal` (right; also hosts the cabinet) | `chat-shell.tsx:462-463`; `src/components/terminal/terminal-drawer.tsx`, `side-terminal.tsx` |
| IDE page (Theia iframe) | `DockView` keeps `ModePage mode="ide"` over the dock in IDE mode; `IdeFrame` in `ModeView` on phones | `chat-shell.tsx:147-158`; `modes.tsx:138`; `src/components/ide/ide-frame.tsx`; Theia served at `/theia` (`src/routes/theia/$.ts`; Nitro `publicAssets` per its header) |

### Component boundary for a workbench interior

Two candidate mount points, both inside the existing rail, routing and auth:

- `chat-shell.tsx:417-420`, `<SheetSplit .../>`: the whole sheet interior to the right of the rail. Replacing it replaces both the conversation sidebar (`GlassPanel`/`ContextPanel`) and the dock.
- `chat-shell.tsx:145`, `<DockShell/>` inside `DockView` (`:135-161`): the interior to the right of the sidebar. `GlassPanel` stays, so the sidebar would be swapped for Files separately at `chat-shell.tsx:197` / `sidebar.tsx:185-187`.

Everything above these (rail `:399`, sheet frame `:403-410`, `_chat.tsx` auth and provider) is untouched by either. `<TheoremRuntimeProvider>` (`_chat.tsx:82`) already supplies the thread and project identity a workbench panel would bind.

### What PR #111 changed here (all in HEAD)

Source: `git diff --stat origin/main...origin/claude/friendly-darwin-ervg9r` (145 files).

- Sessions-only sidebar at 210px (`PANEL_WIDTH.default` 210, `shell-state.ts:28`); pin and session-type prefs in `src/lib/theorem/sidebar-prefs.ts` (zustand persist, key `theorem-sidebar-prefs`, per browser, `:171,216`).
- Project home: `src/components/projects/project-home.tsx` (rendered by `ModeView` at `/projects/$projectId`), `project-sessions.tsx`, `project-outputs.tsx`, `project-edit-dialog.tsx`; route `src/routes/_chat/projects.$projectId.tsx`.
- Session graph on Canvas: `src/components/sessions/session-graph-canvas.tsx`, `src/lib/theorem/session-graph*.ts`, `sessions.ts`; `program-surface.tsx`, `programs-panel.tsx` and `src/routes/_chat/canvas.tsx` changed.
- `modes.tsx`, `dock.tsx` (30 lines), `chat-shell.tsx` (6 lines), `shell-state.ts` (20 lines), `projects.ts`, `rail.tsx` edited. `outputs-drawer.tsx` was added by #111 and is absent in HEAD (the #112 cabinet replaced it).

## 3. Existing registries and layout owners

None of these is a general panel registry with the descriptor the spec asks for (kind/version, factory, resource binding, actions, availability, minimum size, default placement, serializer, theme and semantic roles).

| Owner | What it owns | Persisted shape and where | Could it supply the picker, shortcuts, agent actions or panel factories |
|---|---|---|---|
| `src/components/shell/dock.tsx` | The dockview instance for the thread, artifacts, files, notes, delegations, reviews and inspector panels. Panel id prefixes `artifact:`, `note-panel:`, `file:`, `delegation:`, `review:` (`:81-96`). Per-kind opener stores (`useArtifactView`, `useNoteView`, `useWorkspaceFileView`, `useFileDock`, `useDelegationDock`, `useReviewDock`) are wired in `DockShell`'s effect (`:741-772`). `PanelsMenu` `:409`. | `SerializedDockview` per project in `useShell.layouts[projectId]`, saved on every `onDidLayoutChange` (`dock.tsx:723-740,789`). **Browser-local** (zustand persist `theorem-ui:shell`). | Panel factories and open actions: yes for these kinds, as imperative per-kind openers rather than a descriptor catalog. Picker, shortcuts, agent actions: no. |
| `src/components/shell/arrangements.ts` | Three arrangements `focus`/`together`/`explore` (`ARRANGEMENTS` `:23-27`), `arrange` `:133`, `addInspector` `:75`, `followFront` `:162`, `THREAD = 'thread'` `:37`. Moves panels, never closes them. | Not persisted by itself; the resulting dock JSON is (via `layouts`). | Named compositions: partly (three fixed, in code). |
| `src/components/shell/responsive-dock.ts` | `adaptDock(api, host)` `:108` floats groups that violate the 35rem reading-space policy and restores them; `layoutForSave()` `:292` returns the un-adapted layout. | Feeds `layouts` through `layoutForSave`. | Part of spec 4.2's collapse rule already exists (policy: theorem-appearance-v1). |
| `src/components/shell/modes.tsx` | `MODES` (rail destinations), `ShellMode`, `ModeView`, `useShellMode`, `useOpenMode`. A mode is a route. | `railOrder`, `panelCollapsed` in `useShell` (browser-local). | Navigation destinations only. |
| `src/components/shell/shell-state.ts` | zustand store `useShell` (`:133`); name `theorem-ui:shell`, `version: 9` (`:258,273`). `partialize` (`:274-`) persists `projectId, layouts, panelWidth, panelCollapsed, railOrder, explorerOpen, ideFilesOpen, organizeOpen, ideFilesHeight, projectOrder, terminalHeight, sideWidth, cabinetWidth, terminalThreads, terminalThreadIds, terminalTabs, noteOrder`. Not persisted: `filesShown`, `chatThreadId`, `terminalOpen`, `sideDrawer`, `cabinetExpanded`. Migration chain from `:311`. | Browser `localStorage`. | Local-only layout state; nothing syncs to the account. |
| `src/components/shell/command-palette.tsx` | `CommandDialog`; `useCommandPalette` store; Mod+K handler (`useHotkey`, a raw `keydown` listener); groups `Threads`, `Go to` (new chat, Settings sections), `Models`, `Plugins`, `Skills` assembled in `useGroups` from live queries; `Entry` type `{id, label, hint?, keywords?, Mark, active?, run}`. | Not persisted. | Palette entries: the `Entry` shape is usable. There is no shared registry; entries are built inside one hook. |
| `src/components/shell/open-beside.ts` | `openBeside(api, panel, besidePanelId, share, room)`: a column beside the thread, else a tab in a side group (44 lines). | None. | Placement rule for tool panels. |
| `src/components/shell/sidebar.tsx`, `explorer.tsx`, `file-panel.tsx`, `projects.ts` | Sidebar, file tree, project hooks (`useProjects`, `useActiveProject`, `useTenant`). | `useShell.projectId`. | Files panel contents: `FoldersSection` (`src/components/workspace/folders`) and `Explorer`. |
| `src/lib/composition.ts` | **Not a layout registry.** A vendored TanStack Table utility: `composeEventHandlers`, `composeRefs`, `useComposedRefs` (91 lines). | None. | No. |
| `src/lib/surfaces.ts` | **Composer material only**: `COMPOSER_SURFACES` flat/paper/glass/liquid, `useComposerSurface`, a compatibility shim over `useAppearance` (26 lines). | None here. | No. |
| `src/lib/handlers/` (`registry.ts`, `types.ts`, `actions.ts`, `builtins.ts`, `file-sync.ts`) | `useHandlerRegistry`: file handlers matched by entry, extension and MIME, each with `Panel`, `Card`, optional `create`; extra CodeMirror and Markdown extensions (`registry.ts:20-37`). `register()` replaces by id and returns an unregister function. | In-memory zustand; nothing persisted. | The "open this file" resolver for Files and document panels: yes. |
| `src/lib/modules/` (`registry.ts`, `contract.ts`, `store.ts`, `layout.ts`, `sandbox.ts`) | Pages and modules (Puck data): `ModuleManifest`, ports, bindings, routes, actions; `ModuleDefinition` runtimes `builtin`, `sandboxed-html`, `composite` (`registry.ts:30-60`). | Theorem vault files, revisioned with `If-Match` (`store.ts:1-6`): account-side. | The nearest thing to an account-persisted module catalog with declared actions, but for user-arranged Pages, not the dock. |
| Keybindings | No keybinding registry. `@tanstack/react-hotkeys` `useHotkey` is called per feature: `workspace-commands.tsx:16-17` (`Mod+O`, `Mod+Shift+F`); Mod+K in `command-palette.tsx`; the composer and trees handle keys locally. | None. | No. Remappable, rendered shortcuts would be new. |
| Agent-visible action catalog | "Client operations" declared per send: `src/lib/theorem/client-surface.ts` merges `kitTurnOptions()`, `appTurnOptions()` and `faceTurnOptions()` into `clientOperations` plus a `clientSurface.revision`. Server limits: 16 operations a send, 1024-byte description, 8 KB schema (`src/lib/face/operations.ts:1`). Receipts return through `chat.runs.command`. Names: `face.read/perform/define` (`operations.ts:15-17`). | Not persisted; recomputed per turn from what is mounted. | The only agent-callable action mechanism. Workbench actions would share its 16-operation budget (its own comment counts thirteen used with Kit and the face on screen). |
| Account preferences | `/api/chat/v1/preferences` (`usePreferencesSync`, `src/lib/theorem/models.ts:293-400`) carries `starredModels`, `defaultModel` and `generation` defaults, revisioned with `If-Match`. | Account-side. | A pattern for an account-side layout/appearance/keybinding document; it has no such fields today. |

## 4. How the existing Ratzilla terminal is mounted

Framing: the existing Ratzilla terminal is an **agent transcript terminal**. React owns the agent (an assistant-ui runtime on its own Theorem thread) and pushes snapshots in; the crate draws and hands actions back (`terminal/src/lib.rs:1-4`). It is not a PTY or VT surface. The Herdr/PTY path exists only in the Theia extension and the backend.

### 4.1 Crate (`terminal/`)

| Item | Detail |
|---|---|
| Source | `terminal/src/lib.rs` (1961 lines), `terminal/src/cabinet.rs` (954), `terminal/src/preview/` |
| Wasm exports | `set_palette(json)` `lib.rs:215-216`; `mount(parent_id, tabbed, on_action) -> TerminalHandle` `:1917-1929`; `TerminalHandle` methods `set_tabs`, `set_state(tab, json)`, `key(KeyboardEvent) -> bool`, `click(x, y)`, `cursor(x, y) -> String`, `paste`, `scroll(lines)`, `set_focused` (`:1665-1745`); `render_preview(source_json, rgba, w, h)` `:1934`; `preview_palette()` `:1950`; `mount_cabinet(parent_id, on_action, on_geometry) -> CabinetHandle` `cabinet.rs:898`; `CabinetHandle` methods `set_view(json)`, `key`, `select`, `scroll`, `selected` (`cabinet.rs:861-889`) |
| Input design | Keys, paste and wheel arrive through the handle from a container React keeps, not Ratzilla's own listener, because the DOM backend rebuilds its grid on resize (`lib.rs:6-9`). The crate runs its own `requestAnimationFrame` loop instead of `draw_web`, and fixes the viewport to the grid actually built (`:11-14`). |
| Backend | `ratzilla::DomBackend` with `CellSized`; Ratatui `Terminal<DomBackend>` (`lib.rs:25-36`, struct `Screen` near `:1750`) |
| Actions out (JSON strings) | `{type: "submit"\|"input", tab, text}`, `{type: "approve", tab, allow}`, `{type: "open", tab, path, start?, end?}`, `{type: cancel\|close\|new\|newTab\|closeTab\|selectTab\|unreference, tab}` (`lib.rs:411-446`; TS union `terminal-screen.tsx:167-179`) |
| Cabinet actions out | `{type: "select"\|"open", key, revision?}`; geometry callback `{geometry}` (`cabinet.rs:895-896`; `cabinet-view.tsx:444-449`) |
| Rust tests | A `#[cfg(test)]` module exists in `cabinet.rs:910`. No Rust test script is in `package.json`; `cargo test` was not run. |

### 4.2 Build and output

- `terminal/build.sh:1-10`: `cargo build --locked --release --target wasm32-unknown-unknown`, then `wasm-bindgen --target web --out-dir ../src/terminal-wasm .../theorem_terminal.wasm`.
- Output: `src/terminal-wasm/` (module `theorem_terminal`), **gitignored** (`.gitignore:23`); it does not exist in this worktree until built.
- Run by `bun run build:terminal`, by `bun run dev` (`sh terminal/build.sh && bun --bun vite dev --port 3000`), and by `scripts/build.sh` (`sh terminal/build.sh`, then `bun --bun vite build`; `WORKERS_CI=1` switches to `scripts/build-cloudflare.sh`).
- Imports: `import('@/terminal-wasm/theorem_terminal')` (`terminal-screen.tsx:435`), type imports `:25,28`; the cabinet's worker `src/components/cabinet/preview-worker.ts:5` imports `init, { render_preview }`.

### 4.3 React hosts

| File | Role |
|---|---|
| `src/components/terminal/terminal-screen.tsx` (634 lines) | `loadWasm()` `:431-447` initialises the module once, subscribes `useTerminalTheme` and calls `wasm.set_palette(JSON.stringify(wasmPalette(roles)))`. `mountTerminal(host, tabbed, onAction)` `:454-467` keeps one mount per host element in a `WeakMap` and calls `wasm.mount(host.id, tabbed, json => onAction(JSON.parse(json)))`. `pushSnapshots` `:470` calls `handle.set_state(id, snapshot)`. `TerminalScreen` `:479` forwards keys, paste, wheel and clicks and calls `set_tabs` and `set_focused`. `runSessionAction` `:199` runs submit, input, cancel and approve against the session's assistant-ui runtime. |
| `src/components/terminal/terminal-drawer.tsx` | Bottom drawer, one session (`TerminalScreen` at `:100`). |
| `src/components/terminal/side-terminal.tsx` (453 lines) | Right drawer; `TerminalScreen hostId tabbed` at `:432-434`; also hosts `CabinetView` (import `:12`), the cabinet's dock/overlay/expanded logic (`useDockFits`, `useCabinetExpanded` `:249`, `--cabinet-dock` `:137-140`). |
| `src/components/cabinet/cabinet-view.tsx` (791 lines) | `loadWasm()` then `wasm.mount_cabinet(HOST_ID, onAction, onGeometry)` `:444-449` (one mount per host element). `handle.set_view(JSON.stringify({title, scope, count, modeLabel, preferenceLabel, filters, filter, query, expanded, status, targetPx, footerNote, entries: [{key, revision, title, meta, description, state}]}))` `:483-510` on every render. Rust returns geometry (rectangles); React lays **real DOM controls over the drawn ones**: a search input (`aria-label` `:635`), a preview-style select (`:653`), filter buttons in a `role="group"` (`:676-684`), card buttons with full accessible names and `aria-current` (`:724-735`), an `aria-live` status (`:751`); the drawn layers are `aria-hidden` (`:205,623,629`). Previews are painted with canvas 2D from `render_preview` output computed in `preview-worker.ts`. |
| Stories | The same `TerminalScreen` is the target of terminal stories (`src/routes/story.$id.tsx:2-12`; fixtures in `terminal-stories.ts`). |

### 4.4 Theme path into Rust

1. `src/components/terminal/terminal-theme.ts`: `WORKSPACE_TOKENS`, 15 CSS custom properties (`surface-neutral`, `surface-sidebar`, `surface-frame`, `surface-raised`, `surface-hover`, `surface-composer`, `surface-artifact`, `surface-rail`, `sheet-from`, `sheet-to`, `ink`, `ink-muted`, `ink-faint`, `line-control`, `line-separator`; `:53-71`); `terminalTheme(workspace)` `:342`; `terminalCss` `:418`; `SLATE` fallback.
2. `live-terminal-theme.ts`: `useTerminalTheme` zustand store `{theme, roles}` `:25-31`; `readWorkspace()` resolves tokens through a probe element `:34-46`; `follow()` `:51-73`; a `MutationObserver` on `<html>` attributes `class`, `data-palette`, `style` `:79-82`. Browser only.
3. `terminal-roles.ts`: `terminalRoles(workspace)` `:314`, `wasmPalette(roles)` `:345`, `FALLBACK_ROLES` `:307`, `ROLES_VERSION = 1` `:29`.
4. `terminal-screen.tsx:441-444`: the subscribed store pushes `wasm.set_palette(...)`. Rust `Palette` (serde camelCase, missing roles default to the slate) `lib.rs:59`.

### 4.5 Dock and layout in Rust

There is no layout or dock code in `terminal/`; Ratatui `Layout` constraints appear only inside the transcript and cabinet drawers. A workbench would add the Herdr layout donor to this crate or a sibling crate.

## 5. Appearance owner

| Item | Detail |
|---|---|
| Store | `useAppearance`, zustand + `persist`, key `theorem-ui:appearance`, `APPEARANCE_VERSION = 1` (`src/lib/appearance.ts:16-17,247-297`). `partialize` keeps `{preset, overrides}` (`:282`). **Browser `localStorage` only**; no account sync found. A migrator reads legacy `theorem-ui:palette`, `theorem-ui:surfaces`, `theorem-ui:life` (`:186-235`). An inline `appearanceScript` applies the saved selection before first paint (`:368-`). |
| Presets | `'calm' \| 'expressive'` (`:20`). `DEFAULT_APPEARANCE = {preset: 'calm', overrides: {}}` (`:162-165`). `presetDefaults` `:147-160`: Calm = every surface material flat, life off; Expressive = `canvas: paper`, `navigation: glass`, `composer: paper`, `user-message: paper`, life on. |
| Overrides (`appearanceOptionsSchema`, `:92-111`) | `palette` (a `PALETTES` value or `custom`), `customPalette` (validated), `density` compact/comfortable/touch, `reading` comfortable/wide, `layout` conversation/sidecar, `motion` system/reduced, `preview` `pixel \| full_fidelity` (the cabinet's preference; absent means the theme default: expressive -> pixel, calm -> full_fidelity, comment `:28-29`), `scales {content, ui, code}`, `materials` (partial record per surface role), `font`. Light/dark mode is next-themes (`palette.ts:1`); the document form adds `mode` and `life` (`:125-135`). |
| Policy | `src/lib/appearance-policy.ts` (261 lines): `PALETTES` github-sharp, stone, vitesse (`:2-19`); `SURFACE_ROLES` `:22`; `MATERIALS` flat/paper/glass/liquid `:33`; `TEXT_RECIPES` `:37`; `CALM_COLORS` `:122`; `COLOR_ROLES` `:159`; `COLOR_PAIRS` `:210`; `appearancePair()` `:245`; `PLEX_READING_MEASURE` `:254`. Source tag theorem-appearance-v1. |
| `src/lib/palette.ts` (21 lines) | Thin wrapper: `setPalette`, `usePalette`, `useCodeThemes` over `useAppearance`. |
| Import/export | Settings page only: `src/routes/settings/appearance.tsx:449,465` (`appearanceDocumentSchema` parse, `loadSelection`). |
| **Terminal role contract** | `TerminalRoles` (`terminal-roles.ts:65-146`): `version`, `revision`, `mode` dark/light; `chrome {bg, raised, deep, line, text, bright, muted, heading, accent, focus, selection, disabled, idle}`; `state {error, warning, success, link, approval}`; `syntax` (GitHub Dark token colours, `SYNTAX_SOURCE`); `diff {removedLine, addedLine, removedWords, addedWords, commentOnWords}`; `illustration[]` (the cabinet's pixel palette, projected from the reference palette `ILLUSTRATION_REFERENCE` `:41-`); `diagnostics[]`. Contrast gates `TEXT_RATIO` 4.5 and `INDICATOR_RATIO` 3 (`:32-33`); `requiredPairs`/`failingPairs` `:185,223` verify and repair pairs, falling back to a known dark profile with a diagnostic. Rust keeps its own copy of the reference palette (`terminal/src/preview/palette.rs` `REFERENCE`; `terminal-roles.test.ts` holds the two equal). The comment in `readable()` says the terminal surfaces `terminalTheme` places are dark in every workspace. "No role privileges a hue" (`terminal-roles.ts:17`). |

## 6. Stories and oracle harness

| Item | Detail |
|---|---|
| Story route | `src/routes/story.$id.tsx`: route `/story/$id`, `ssr: false` (`:27-31`). Loader: a `TERMINAL_STORIES` match renders the real WASM `TerminalScreen` on a committed fixture and keeps the last emitted action on `data-action`; otherwise `findStory(id)` from `src/stories/index.ts` and `REGISTRY[id]` from `src/stories/registry.tsx`, **both dev only** (`import.meta.env.DEV`, `:14-24,43-45`). Non-terminal stories render over `installFakeTheorem()` (`src/stories/fake-theorem.ts`). |
| Listing | `src/routes/stories[.]json.ts`: `GET /stories.json` returns `TERMINAL_STORIES` always, plus `STORIES` in dev. |
| Registering a story | Terminal: add an entry to `src/components/terminal/terminal-stories.ts` (11 `id:` entries by grep; fixtures built through `snapshotOf`). Component: add `StoryMeta` (`id, title, lane 'translation'\|'original', reference?, viewport, region?, threadId?`) to `STORIES` in `src/stories/index.ts` (46 `id:` matches by grep) and a render in `src/stories/registry.tsx`; route helper `src/stories/routes.ts`; fixtures in `src/stories/fixtures/`. |
| Story oracle | `scripts/story-oracle.mjs`: `list`, `shot <id\|all>`, `diff <id\|all>` (reference, render and heatmap collage via pixelmatch, threshold 0.2), `collage`, `motion <id>`; playwright-core; origin `STORY_ORIGIN` (default `http://localhost:3102`); evidence under `docs/plans/evidence/` (`:1-31`). Reports a number, never a verdict. |
| `scripts/stories/` | `shoot.cjs` screenshots every story from `/stories.json`, presses declared keys, records the emitted action and a two-frame motion check into `oracle.json`; `collage.cjs` makes a collage per story for the human seal. |
| Design oracles | `scripts/design-oracles/`: `run.mjs`; `registry.mjs` (an independent policy copy `theorem-appearance-v1` with `ORACLES`, `FIXTURES`, `EXECUTION_MATRIX`); `check-colors.mjs`, `colors.mjs`, `focus.mjs`, `measure-reading.mjs`, `metamorphic.mjs`, `portals.mjs`, `corpus.mjs`, `matrix.mjs`, `aggregate.mjs`; `review-*.mjs` for interactions, continuity, navigation-export, reflow, runtime, composition, code-contrast, color-states and touch-rhythm. Fixtures are stories (`design-oracle-*` F01-F06, `shell-compare`). |
| E2E | `scripts/e2e/`: `stack.mjs` starts a whole Theorem on this machine (UI, proxy, Theorem's OAuth issuer, a local OpenID provider, store, agent, Librarian; real model calls through Theorem's catalog using `~/.theorem/provider-keys.env`); requires `E2E_SERVER_BIN=<path to rustyred-thg-server>` (`stack.mjs:1-15`); ports in `config.mjs` (UI 3102, API 8392, identity 8398, stand-in 8399); `E2E_IDENTITY=neon` selects the Neon-style sign-in with `neon-standin.mjs`. Scenarios (`package.json` `e2e:*`): `review`, `models`, `keys`, `notes`, `composer`, `plan-graph`, `sidebar`, `app-db`, `app-ts`. `harness.mjs` serves one page from `scripts/e2e/` through Vite, optionally `--built` (a production build), for scenarios that need the app's modules but no Theorem server. Support files: `identity.mjs`, `lib.mjs`, `provider-standin.mjs`, `turns.mjs`, `start-storage.ts`. No scenario touches a Herdr terminal. |

## 7. Test and lint commands

From `package.json` scripts:

| Command | What it runs |
|---|---|
| `bun test` | Unit and component tests (`bunfig.toml` preloads `test/happy-dom.ts` and `test/vite-imports.ts`; ignores `mobile/**`) |
| `bun run test:composer` | `bun test src/components/chat src/components/assistant-ui src/components/notes src/lib/theorem src/stories` |
| `bun run test:appearance` | `bun test tests/design-oracles src/lib/appearance.test.ts src/lib/code-contrast.test.ts` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `eslint` |
| `bun run check` | `prettier --check .` |
| `bun run format` | `prettier --write . && eslint --fix` |
| `bun run build`, `build:terminal`, `build:cloudflare` | `scripts/build.sh`, `sh terminal/build.sh`, `scripts/build-cloudflare.sh` |
| `bun run oracle:*` | `colors`, `rendered`, `interactions`, `continuity`, `navigation-export`, `reflow`, `runtime`, `composition`, `code`, `states`, `touch`, `matrix` |
| `bun run e2e:*` | see section 6 |
| Rust | No Rust test or clippy script in `package.json`. |

Workflows: only `.github/workflows/composer.yml` ("Composer acceptance", job **Composer contract**, 25-minute timeout, ubuntu-latest, bun 1.4.3). It runs on pull requests touching, among others, `src/components/shell/**`, `src/components/terminal/**`, `src/routes/_chat*`, `src/routes/_chat/**`, `src/lib/theorem/**`, `src/stories/**`, `src/lib/appearance*`, `scripts/design-oracles/**`, `scripts/e2e/**`, `terminal/**`, `vendor/theoremharness-sdk-*.tgz`, `package.json`, `bun.lock`. Steps in order: `bun install --frozen-lockfile`; Rust 1.96.1 and `wasm-bindgen-cli 0.2.127`; `bun run build:terminal`; `bun run typecheck`; `bun run test:composer`; Playwright Chromium install; `bun run e2e:composer --built`; `bun run test:appearance`, `bun run oracle:colors`, `bun test src/components/shell/responsive-dock.test.ts`; then a Vite dev server on port 3117 (readiness poll on `/story/shell-compare`) followed by `oracle:interactions`, `continuity`, `navigation-export`, `reflow`, `runtime`, `composition`, `code`, `states` (`ORACLE_ENGINE=chromium`) and `touch`. The workflow header references `docs/development/composer-contract.md`; that file was not opened.

### The failing "Composer contract" check on PR #112

- Run `43674727056`, job conclusion `failure`. Only step 13, **"Check appearance changes through the real controls"**, failed. Steps 1-12 (install, Rust and wasm build, typecheck, `test:composer`, composer e2e, appearance tests, `oracle:colors`, `responsive-dock.test.ts`) succeeded.
- In that step the readiness poll on `http://127.0.0.1:3117/story/shell-compare` got connection refused, then one HTTP 500; later `oracle:interactions` (`scripts/design-oracles/review-interactions.mjs`) printed `FAIL Review runner completed` and exited 1 (`error: script "oracle:interactions" exited with code 1`) after about 50 seconds. The later oracles did not run.
- The cause of the review-runner failure is **not determined**: the retrieved log carries no assertion detail. Separately, step 9's passing output contains `error: --surface-neutral is not a colour:` (an empty token value reaching `terminal-theme.ts` under the test DOM); that step still passed, and whether the two are related was not verified.
- Other checks on #112: Greptile Review and GitGuardian succeeded, Workers Builds succeeded, CodeRabbit skipped.

## 8. Open questions and contradictions

1. **Which page is "the web Theo route"?** No page is named Theo in `src/`. The conversation sidebar, thread and composer the spec describes are chat mode (`/`, `/c/$threadId`, `/projects/$projectId`), mounted by `_chat.tsx` and `chat-shell.tsx`. Theia lives on `/ide` (mode `ide`), which has its own sessions sidebar (`sidebar.tsx:188-192`) and a separate in-IDE conversation. Spec 4.1 and 15 read as if the workbench takes over chat mode and retires `/ide`; that needs one confirmation. Chat mode is also not a single route: `/projects/$projectId` swaps the thread for `ProjectHome` (`modes.tsx:127-132`), and the dock's `ThreadPanel` also hosts the Index, Notes, Pages, Spaces and Canvas views (`dock.tsx:118-153`, `modes.tsx:123-147`).
2. **The shell already has a layout owner.** Spec 4.3 says "one layout tree ... start from Herdr `layout.rs`, not a new tiling engine". The current dock is `dockview-react` 8.6.1 with saved per-project JSON (`dock.tsx`, `shell-state.ts` `layouts`), floating groups, maximize, tabs and a width-adaptation policy (`responsive-dock.ts`). Replacing it with a Rust layout tree removes dockview's panel owners (artifacts, files, notes, delegations, reviews, inspector). Which other consumers depend on the `useArtifactView`, `useNoteView`, `useWorkspaceFileView`, `useFileDock`, `useDelegationDock` and `useReviewDock` openers (set only while `DockShell` is mounted, `dock.tsx:741-772`) was not enumerated.
3. **"Extend existing registries" has little to extend.** There is no panel descriptor registry, no keybinding registry and no shared action catalog (section 3). The nearest are `useHandlerRegistry` (files), the modules registry (vault pages), the palette `Entry` shape and per-send client operations. `src/lib/composition.ts` and `src/lib/surfaces.ts` do not concern layout despite their names.
4. **No account persistence for layouts, appearance or keybindings.** Spec 4.3 has account preferences storing named compositions, panel order, appearance and keybindings. Today layouts, appearance and sidebar prefs are browser `localStorage` (`theorem-ui:shell`, `theorem-ui:appearance`, `theorem-sidebar-prefs`); the only account document found is `/api/chat/v1/preferences` (models and generation defaults). No server contract or SDK method for the larger document was found.
5. **Client-operation budget.** Theorem admits 16 operations per send and 13 are used when Kit and Theo are on screen (`client-surface.ts` comment). An agent-visible workbench action catalog has three left unless the server limit changes or operations are consolidated.
6. **The existing Ratzilla terminal is not a terminal emulator.** It renders agent transcripts from React-pushed snapshots; there is no VT/PTY rendering, no resize-to-host and no input-claim code on the web side. The only consumer of the host terminal API is the Theia extension (`ide/theia-extensions/theorem-workspace/src/browser/theorem-terminal.ts`, `terminal-profile.ts`), which Gate 6 deletes. In the vendored SDK (alpha.5) `terminal.open` is typed as opaque `NativeArguments`, and `theorem-terminal.ts:50` says the vendored `TerminalChannel.open` sends only the size, so launch with backend and program goes around it. Whether a later SDK types those fields was not checked.
7. **Backend not on main.** The Herdr stack (#1021, #1042, #1045, #1046) is not in `origin/main` (`65efa3ad`); the root PR #1021 is open. `terminal.rs` and `herdr/` are absent from main, which still has `pty.rs`. `vt_screen.rs` is on main but as a different blob from the one the spec cites. Acceptance cases that need Herdr terminals cannot run against a host built from main. The deployed host's commit was not verified.
8. **Local Herdr state.** `hc 0.1.17` is installed and `hc schema` reports protocol generation 1 and version 0.1.17, but `~/.config/herdr-core` does not exist, so no core has run under this account. The Herdr review gap the spec asks to recheck (an unbounded live queue at open) was not rechecked.
9. **Rust pin versus the machine default.** `terminal/rust-toolchain.toml` pins 1.96.1; the machine default is 1.97.1. The pin is installed and applies inside `terminal/`; a new crate outside `terminal/` would use 1.97.1 unless it gets its own toolchain file or the pin moves up. CI hard-codes `1.96.1` and `0.2.127` in its workflow (a comment there says to keep them in sync).
10. **Appearance coupling.** The cabinet and terminal read one role contract whose surfaces are always dark; the spec's "shared semantic appearance boundary for composer, Markdown, Changes" would extend `TerminalRoles` or add roles. Calm and Expressive differ in the preview preference and surface materials only (`appearance.ts:147-160`); there is no per-preset terminal palette. Spec 12's "no fixed purple/gold priority" agrees with `terminal-roles.ts:17`.
11. **Interior mount versus `LifeSheet` and glass.** `SheetSplit` sits inside `LifeSheet` (the Life field under the sheet) and the navigation panel is a frosted or liquid `GlassPanel` (`chat-shell.tsx:177-201,416`). Replacing the panel with a Files panel decides whether that glass treatment moves with it; not decided here.
12. **CI scope.** The failing step loads `/story/shell-compare`, a story of the current shell, and any workbench change under `src/components/shell/**` or `terminal/**` triggers the same job. Whether the failure on #112 is independent of this branch was not verified.
