# Theo Web workbench: architecture

Decisions taken at the end of Gate 0, from the five inventories in `gate-0/`. Each decision names the evidence it rests on. Where the spec and the checkout disagree, the disagreement is listed in section 11 rather than settled silently.

## 1. What is being replaced, and where it mounts

No route is named Theo. The page the spec calls "the web Theo route" is chat mode: `/`, `/c/$threadId` and `/projects/$projectId`, drawn by `ChatLayout` (`src/routes/_chat.tsx`) and `ChatShell` (`src/components/shell/chat-shell.tsx`). `/ide` is the Theia page that Gate 6 retires. (`gate-0/versions-and-owners.md` section 2.)

| Kept as is | Replaced in chat mode |
|---|---|
| TanStack routes, the sign-in gate, `TheoremRuntimeProvider` (`_chat.tsx:62-93`) | `<SheetSplit>` (`chat-shell.tsx:417`): the conversation sidebar (`GlassPanel` -> `ContextPanel`) and the dockview dock |
| The outer rail (`chat-shell.tsx:399`) and the sheet frame | The React thread and composer as the drawn surface (their runtime stays, see section 6) |
| Notes, Pages, Vault, Spaces and Canvas modes, which keep `SheetSplit` and dockview | |
| `ProjectHome` at `/projects/$projectId` | |

The workbench mounts as one React component, `Workbench`, in place of `SheetSplit` when the mode is chat. It fills the sheet; there is no card inside a page.

Until the Theo pane reaches parity (end of Gate 4) the workbench is opt-in per browser: `localStorage['theorem-ui:workbench'] = '1'` or `?workbench=1`. The existing shell, its e2e scenarios and its oracles keep running unchanged meanwhile. The switch flips to default at the Gate 4 exit and is deleted, with the classic chat interior, at Gate 6. It is a delivery switch, not a product setting.

Project and conversation navigation, which the sidebar carried, moves to the workbench header: a workspace/project switcher and a conversation switcher, both listed in the command palette as well (spec 4.1).

## 2. Crates

`terminal/` is a Cargo workspace (toolchain 1.96.1, `wasm32-unknown-unknown`). The root package `theorem-terminal` stays the one `cdylib`; everything else is an `rlib` it links, testable headless on the host target.

| Crate | Owns | Depends on |
|---|---|---|
| `workbench-layout` | Herdr's `TileLayout` binary split tree (donor, see LEDGER L01). Adapted in place from Gate 1: caller-supplied leaf ids, serde, no process-global counter | `ratatui` (layout types) |
| `workbench-dock` | The one layout owner: tab groups over layout leaves, stable panel-instance ids, minimum sizes, CSS-px to cell quantization, collapse rules, hide/expand/restore, presets, the persisted layout document | `workbench-layout` |
| `workbench-core` | Elm root: `Msg`, `Model`, `update`, `Effect`, the panel registry, focus and key routing, the command and keybinding table, the semantic tree | `workbench-dock` |
| `workbench-panels` | Header chrome, tool picker, Files, More tools, unavailable/empty states | `workbench-core` |
| `workbench-text` | Coordinate conversions (bytes, UTF-16, scalars, graphemes, cells) and the shared editing session over `ratatui-textarea` | |
| `workbench-vt` | VT byte-to-screen interpreter and input encoder for process panes | `vt100`, `tui-term` |
| `workbench-markdown` | ELY-derived parse/block/edit logic and the four modes | `workbench-text`, `pulldown-cmark` |
| `workbench-changes` | Changes panel model and view over Theorem SCM | `workbench-core` |
| `theorem-terminal` (root) | wasm-bindgen exports, `DomBackend` screen, frame loop, the Theo transcript session (existing `Session`), cabinet | all of the above, `ratzilla` |

No crate other than the root depends on `ratzilla`, `wasm-bindgen` or `web-sys`. Every crate below the root runs its tests with plain `cargo test`.

## 3. The interaction core

Elm discipline (spec 6, R33): `Msg -> update(&mut Model, Msg) -> Vec<Effect>`, later a completion `Msg`, then `view(&Model, &mut Frame)`. `view` performs no I/O. Child panels have their own `Msg`/`update`; the root routes by panel-instance id and coordinates cross-panel actions.

Every effect and every completion carries the same envelope:

```
Effect      { id: EffectId, kind, resource: ResourceRef, revision?: Revision, generation?: u64, payload }
Completion  { effect: EffectId, resource: ResourceRef, revision?: Revision, generation?: u64,
              outcome: Accepted | Refused { code, reason } | Uncertain { reason } | Failed { reason }, payload }
```

`update` drops a completion whose `resource` no longer matches the pane's binding or whose revision/generation is older than the pane's; it may still fill a cache keyed by that resource (spec 6). `Uncertain` is a first-class outcome: a write whose result is unknown is shown as unknown, never as done and never retried blind (R47).

Queues are separate and bounded per source: model stream, PTY output, document events, editor input. Redraw is coalesced to one frame per animation frame; semantic updates are never dropped to do so.

## 4. The Rust and TypeScript boundary

One wasm export mounts the workbench, in the same style as the existing `mount` and `mount_cabinet`:

```
mount_workbench(parent_id, on_effect: Function, on_semantics: Function) -> WorkbenchHandle
WorkbenchHandle: dispatch(json) | key(KeyboardEvent) -> bool | pointer(json) | text_input(json)
               | paste(text) | resize() | set_focused(bool) | semantics() -> json
```

- `on_effect(json)` hands an `Effect` to the adapter. The adapter performs it through an existing owner (section 5) and answers with `dispatch(Completion)`.
- Host events (live document events, terminal output, conversation snapshots, theme changes) arrive through `dispatch` as host messages.
- The wire types are Rust `serde` types. Their TypeScript declarations are generated from the Rust source (`ts-rs`), committed under `src/lib/workbench/wire/`, with a test that fails when they drift. No hand-kept mirror.

TypeScript side:

| Path | Role |
|---|---|
| `src/components/workbench/workbench.tsx` | Mounts the wasm, owns the host element, forwards input, renders the semantic overlay |
| `src/components/workbench/semantic-overlay.tsx` | The one accessible owner per control (section 8) |
| `src/lib/workbench/adapter.ts` | Effect dispatcher: routes each effect kind to an owner module |
| `src/lib/workbench/{files,documents,scm,terminal,conversation,layout}/` | One thin module per owner; no endpoint is called from two places |
| `src/lib/workbench/wire/` | Generated wire types |

## 5. Owners (R02)

Each capability has exactly one owner, and the adapter is its only caller from the workbench.

| Capability | Owner | Evidence | Gap to close |
|---|---|---|---|
| Environment/workspace identity | `TheoremConnection` logic (workspace id from project, `operations`, `capabilities`, recovery), extracted from the Theia extension into `src/lib/workbench/environment` | `gate-0/owners-documents-and-persistence.md` 2 | No typed "unavailable" result; the adapter defines one from HTTP status and capability absence |
| Files | `client.ide.workspace.files*` on the workspace host, `file.changed` on `WorkspaceLive` | same, 3 | Two list shapes by host version: normalized in the adapter |
| Documents | SDK `DocumentSession` (OT, revisions, conflict/reconcile) | same, 4 | `reset` drops unaccepted local edits on an unrecognised refusal: the workbench keeps its own pending text and re-offers it as a conflict instead of trusting `reset` |
| SCM | SDK `WorkspaceScm` plus `operate('scm.*')` for diff, hunks, blame, log, merge | same, 5 | Typed SDK has no hunk or base token; hunk controls are shown only when the host advertises the operation and the diff is revalidated first (R18) |
| Language, diagnostics, run, search | SDK `WorkspaceLanguage`, `operate('run.*')`, `ide.search` | same, 6 | Run and search are not revision-bound; results are labeled with the revision they were read at |
| Conversation and runs | The existing assistant-ui runtime (`src/lib/theorem/runtime.tsx`); React pushes snapshots, Rust returns actions, as `terminal-screen.tsx` does today | `gate-0/versions-and-owners.md` 4.3 | None for Gate 1; `HeadlessConversation` is not adopted (unused, needs a store) |
| Terminals | SDK `TerminalChannel` and `ide.terminal.*` behind the workspace host | `gate-0/terminal-path.md` | Section 7 |
| Artifacts | The cabinet's catalog and preview worker (`src/components/cabinet/*`) | `owners...` 8 | Registered as a panel, not re-implemented |
| Layouts and named compositions | `client.workbench.get/save` (`/api/workbench/v1/:workspace_id`, revisioned with `If-Match`, opaque `current` and `namedLayouts`, tenant-scoped; present on backend `origin/main`) | SDK `WorkbenchRecord`; `rustyred-thg-server/src/theorem_workbench.rs` | Not yet consumed anywhere in the UI. Appearance and keybindings have no account owner (section 11, item 4) |
| Local checkpoints | `@rustyreddb/browser` through one shared client per scope | `owners...` 9 | No typed durability outcome; mapped and tested in Gate 5 |
| Code highlighting and diff parsing | The existing terminal path: `@tanstack/highlight` tokens and jsdiff `parsePatch` in `terminal-code.ts`, drawn by `terminal/src/lib.rs` | `terminal-code.ts` header | Reused for the editor, Markdown fences and Changes; no second highlighter |
| Theme | `TerminalRoles` (`terminal-roles.ts`), pushed through `set_palette` | `versions-and-owners.md` 5 | Extended with roles for dock chrome, editor and Changes in Gate 4; no palette inside a donor widget |
| Agent-visible actions | Per-send `clientOperations` (16 a send, 13 used) | `versions-and-owners.md` 3 | Two operations cover the workbench: `workbench.read` (semantic snapshot) and `workbench.act` (run a registered action by id). Actor identity stays with the run |

## 6. Panels and the registry

One registry (R05). The picker, command palette, shortcuts, context actions and the agent's `workbench.act` all resolve the same `PanelDescriptor`:

```
PanelDescriptor {
  kind, version,
  title, icon,
  body: Drawn | Hosted,            // Ratatui cells, or a DOM region placed on Rust-reported geometry
  binding: None | Workspace | Document | Repository | Terminal | Conversation | Project,
  actions: [ActionDescriptor { id, title, intent: Focus | Open | Create | Start | Destroy, requires: [capability], default_key? }],
  availability(&Capabilities) -> Available | Unavailable { reason },
  min_size: { cols, rows },
  default_placement: Left | Main | Tools,
  serialize / restore,             // view state only; never the resource
  theme_roles, semantic_role,
}
```

`intent` is what makes "opening a picker has zero domain effects" checkable (R07): only `Create`, `Start` and `Destroy` actions emit a domain effect, and only when the entry is chosen.

`Hosted` bodies exist because several working owners are React components (artifact viewer, review, delegation, cabinet previews). The dock still owns their rectangle, tab and focus; React paints inside it. This is the cabinet's existing pattern (`cabinet-view.tsx`), extended, and it keeps one layout owner.

Initial registrations: `files`, `theo`, `picker`, `changes`, `shell`, `side-chat`, `document` (source and Markdown), `cabinet`, `diagnostics`, `run-output`, `search`, `history`. Picker rows: Changes, Shell, Files, Side chat, New page, More tools.

A panel's resource controller (editor session, terminal binding, conversation) lives outside the pane. Closing the last view runs that resource's own lifetime rule: a document keeps its draft, a terminal detaches (R29, R36).

## 7. Terminal path

The workbench talks to the workspace host through the SDK; it never opens a Herdr endpoint (R24).

| Decision | Reason |
|---|---|
| Interpreter is `vt100` 0.16.x in wasm, drawn through `tui-term` | It is the same interpreter the host uses for the `formatted` repaint (`vt_screen.rs`, `vt100 = "0.16.2"`), and `tui-term` 0.3.4 targets `vt100 ^0.16.2`. A newer `vt100` would diverge from the host's snapshot semantics |
| Profile table and `openBody` come from `terminal-profile.ts`, moved out of the Theia extension unchanged | Theia-free, already tested (`terminal-profile.test.ts`) |
| Launch goes through one typed adapter function until the frontend vendors an SDK that types `backend`, `argv`, `name` | Vendored alpha.5 `TerminalChannel.open` sends size only (`terminal-path.md` 4) |
| The four versions stay four fields: live-stream epoch, binding epoch, program generation, lease generation | `terminal-path.md` 2.2 |
| No replacement shell is opened on a guess; a lost program is shown as lost, and a new shell is a separate, labeled action that keeps the profile | Theia's `replaceLostShell` drops the profile (`terminal-path.md` 5.2) |

Backend dependency: the Herdr path is not on backend `main`. See section 11, item 2.

## 8. Input, semantics and accessibility

- Keys, pointer, wheel and paste are forwarded by React from the host element, as the existing terminal does; Ratzilla's own listeners are not used (the DOM backend rebuilds its grid on resize).
- Text entry uses one real, visually hidden `<textarea>` as the host-input service: it receives IME composition, clipboard and assistive-technology input and forwards `text_input` messages. The drawn caret is presentation (R21).
- Rust emits a semantic tree on change: `{ id, role, name, state, rect, actions, binding, revision }` per control. `semantic-overlay.tsx` renders one accessible DOM element per node over the `aria-hidden` cell grid. Exactly one accessible owner per control (spec 13).
- The same tree is what `workbench.read` returns to the agent, so human, assistive and agent views cannot disagree.

## 9. Geometry

CSS pixels and cells are separate (spec 4.2). The dock is solved in cells; pixel targets are converted with the measured cell metrics from the mounted grid.

| Target | Value | Where it lives |
|---|---|---|
| Files width | 224 px | `workbench-dock` config |
| Main minimum | 480 px | same |
| Tools minimum | 320 px | same |
| Splitter hit region | 8 px | same |
| Main to tools | 2:1 preset | same |

`F + M + T + G = W` holds in cells after quantization; the remainder goes to the boundary, never into stretched cells or a smaller font. When the regions do not fit: Files collapses to a drawer first, then one principal panel shows at a time with tabs preserved.

## 10. Stories, references and evidence

Every component lands with a story at `/story/<id>`, listed in `/stories.json`, rendering the real wasm on a committed fixture (the `TERMINAL_STORIES` mechanism in `src/routes/story.$id.tsx`, extended with `WORKBENCH_STORIES`).

| Story id | Component | Oracle classes |
|---|---|---|
| `workbench-default` | Default three-region layout | static, interaction (resize, collapse) |
| `workbench-picker` | Tool picker | static against `visual-reference/codex-tool-picker.png`, interaction |
| `workbench-files` | Files panel | static, interaction |
| `workbench-terminal` | Process pane on a recorded byte stream | static, interaction |
| `workbench-editor` | Source editor | interaction (typed keys) |
| `workbench-markdown-visual`, `-source`, `-split`, `-preview` | Markdown modes | static against the ELY reference, interaction |
| `workbench-changes` | Changes panel | static against the ELY reference, interaction |
| `workbench-theo-face` | Inverse Theo | static, motion |
| `workbench-cabinet` | Cabinet as a panel | static |

References are committed first as `evidence/refs/<component>@<pin>.png`, captured from the donor at its pin. Each oracle writes a collage (reference, render, diff heatmap) under `evidence/`. A string or snapshot golden is a drift-lock only and never discharges a visual claim. Typed-in surfaces (composer, editor, Markdown, shell) are accepted only by real key presses in the mounted app.

## 11. Disagreements between the spec and the checkout

1. **"Theo route" is chat mode.** Inferred from spec 4.1 and 15; recorded here because nothing in the source is named Theo.
2. **The Herdr terminal path is not on backend `main`.** It exists on `feat/herdr-live-adoption` (`828ac52848`), 31 commits ahead of and 323 behind `main`; the only PR to `main` (#1021) is open, conflicting and carries only the first slice. Nothing documents a deployed host built from it. Gate 2's local proof can run against a host built from that branch; AC cases that need a deployed Herdr host wait on the stack landing and a deploy, both outside this repository.
3. **The shell already has a layout owner.** dockview-react 8.6.1 owns the dock in every mode. The spec is explicit that the workbench starts from Herdr's layout, so inside chat mode the Rust dock replaces dockview; other modes keep it. Openers that today target dockview panels (`useArtifactView`, `useNoteView`, `useWorkspaceFileView`, `useFileDock`, `useDelegationDock`, `useReviewDock`) are routed to workbench panels while the workbench is mounted.
4. **Account customization is partly present.** Layouts and named compositions have an account owner (`/api/workbench/v1`). Appearance and keybindings do not: appearance is `localStorage`, and no keybinding registry exists. R35 needs either those fields in the workbench record's opaque payload (no backend change, since the payload is opaque) or a preferences extension. The first is chosen: appearance choices and keybindings that are safe to sync travel in the workbench record.
5. **Residual live-adoption defects on the Herdr branch** (unbounded opening drain, no subscription when the core is unavailable at open, closed subscription not renewed, relabel-out not released, minted-id write failure ignored) are backend work; R30 is not met by the branch as it stands (`terminal-path.md` 7).
6. **The frontend vendors two SDK versions** (alpha.5 for the app, alpha.3 plus a terminal patch for Theia). The workbench uses alpha.5 and one typed adapter for the terminal fields it lacks; the alpha.3 patch goes away with Theia.
