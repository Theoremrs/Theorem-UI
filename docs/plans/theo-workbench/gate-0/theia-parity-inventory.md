# Theia parity inventory (Gate 0)

Read-only inventory of what the Theia frontend does today. Facts only. Source: worktree `theo-workbench` at `287997fc` (`ide/`, `src/`, `scripts/`, `vite.config.ts` are identical to `4240360b`; the commit between them touches only `terminal/`). Host facts come from the backend repo `origin/main` (`65efa3ad4f4f`) and, where named, `origin/feat/herdr-live-adoption`.

## Conventions

- Paths are relative to the worktree. `TWS` = `ide/theia-extensions/theorem-workspace/src/browser`. `TWC` = `ide/theia-extensions/theorem-workspace/src/common`. `ZL` = `ide/theia-extensions/zed-look/src/browser`. `UI` = `src/components/ide`.
- Line numbers appear only where they were read. A bare file name means the whole file implements the row.
- License `E` = `SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0` with `Copyright (C) 2026 Theorem UI contributors` (lines 5-9 of every `.ts`/`.tsx` under `TWS`, `TWC`, and `ZL`). `-` = no SPDX header (parent app `src/`, which carries only `// SOURCING:` comments; test files; the two CSS files). `ide/package.json` is `Apache-2.0`. Vendored themes carry their own LICENSE files (see Theme).
- "Host op" lists the operation name the frame sends. Operations reached through typed SDK methods (`client.ide.*`, `DocumentSession`, `WorkspaceLanguage`, `WorkspaceScm`, `TerminalChannel`) are named by the SDK method; their wire operation names were not read from the SDK source (the vendored tarballs were not unpacked).
- "Host has" = whether the name is in `advertised_operations()` (`rustyredcore_THG/crates/theorem-ide-runtime/src/services.rs:5001`, 188 names) on `origin/main`. `Y` = advertised, `N` = not advertised, `?` = SDK method whose wire name was not read.
- "Refusals" are what the frame does on error, empty answer, or an unavailable operation.

## Host contract facts (origin/main)

- `GET /api/environment/v1/operations` returns `{operations: advertised_operations()}` (`apps/theorem-ide-host/src/http.rs:310`).
- `GET /api/environment/v1/workspaces/{id}/capabilities` returns `{schema: "theorem-workspace-capabilities/1", workspace_id, version, epoch, cursor, granted_by, operations: [{operation, implemented, ready, granted, reason}]}` (`apps/theorem-ide-host/src/session.rs:745`). `ready` is false with a reason for: `scm.*` without a git checkout; `terminal.open`, `run.*`, `tests.*`, `workspace.files.*`, `search.*` without a bound checkout; `debug.*` without an adapter or node worker. There is no `backends` key.
- `POST .../operations/{name}` dispatch for terminals (`session.rs:289-296`): `terminal.open/input/resize/attach/copy/paste/search/close` only.
- Routes (`http.rs:198-240`): workspaces list/open, `workspaces/{id}`, `attachments`, `workers`, `checkout`, `debug-adapter`, `workers/{kind}/crash`, `restart`, `operations/{op}`, `live` (SSE), `capabilities`, plus `GET operations`.
- NOT advertised on origin/main: `workspace.files.copy`, `terminal.kill`, `language.diagnostics`, `language.rename`. `backends.herdr` is absent from the capabilities body on origin/main.
- On `origin/feat/herdr-live-adoption` (not main): `terminal.kill` dispatch (`session.rs:580`, `terminal_kill` at 876), `backends.herdr` in capabilities (`apps/theorem-ide-host/CRATE.md:77`; `README.md:240` states `backends.herdr.ready`), `src/herdr/client.rs`. `workspace.files.copy` was not found on that branch either (search was limited to `apps/theorem-ide-host` and `theorem-ide-runtime`).

## 1. Files

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Routes/commands/keys | Lic | Notes |
|---|---|---|---|---|---|---|---|---|
| F1 | stat, readdir, read | `TWS/theorem-file-system-provider.ts:102,128,184` | `ide.workspace.filesStat/filesList/filesRead` | ? (list/read/stat Y by name) | 404 or `not_found` -> FileNotFound; 403 -> NoPermissions (`providerError` :39); `childrenOf` accepts two list shapes (`directory-listing.ts`) | Theia explorer, Open File | E | `host-paths.ts` maps host paths to workspace paths |
| F2 | create dir, create file, delete, rename | same, :141,147,153,200-222 | `filesCreate/filesDelete/filesRename` | ? | 409 `already_exists` -> FileExists | Explorer New/Delete/Rename | E | new-file write bypasses DocumentSession |
| F3 | copy and move | same :163-182 | `operate('workspace.files.copy')`; move = rename+delete | copy N | `requireFileServices` (:244) refuses copy and binary writes when `offers('workspace.files.copy')` is false (Unavailable + warning); copy onto an existing target uses `replaceWithCopy` (`replace-entry.ts`) | Explorer Copy/Paste, drag | E | copy is unavailable on current main host |
| F4 | write to existing file | same :200 | `DocumentSession` edit + save | Y (documents.*) | goes through the session, so conflicts surface as in E-rows | Save | E | see Editing |
| F5 | live file changes | same :86-96 | live event `file.changed` | live | drives `onDidChangeFile` | - | E | |
| F6 | Quick Open file list | `TWS/theorem-search.ts:138` (`TheoremFileSearchService`) | `ide.workspace.filesList({})` | ? | cached until create/delete/resync; honors `ignored` | Quick Open | E | |
| F7 | Parent file tree: list, create, move, delete, reveal | `UI/ide-file-tree.tsx` (518 lines) via frame methods `listFiles/createFile/moveFile/deleteFiles/reveal` (`TWS/theorem-ide-bridge.ts:116-134`) | frame bridge -> file provider | - | F2 rename; delete AlertDialog; F2 context menu | F2 key rename; row context menu | - | consumed in `src/components/organize/sessions-panel.tsx:423,474`; test `ide-file-tree.test.tsx` |
| F8 | `filesChanged` mirror to parent | `TWS/theorem-ide-bridge.ts` -> `UI/ide-frame.tsx:149-203` | bridge call `filesChanged` | - | - | - | E / - | feeds F7 |

## 2. Editing and document sessions

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Routes/commands/keys | Lic | Notes |
|---|---|---|---|---|---|---|---|---|
| E1 | one DocumentSession per path, refcounted | `TWS/theorem-connection.ts:250` (`acquire`) | `DocumentSession` (documents.open/subscribe/close) | Y | model factory falls back to a plain model if acquire fails (`theorem-editor-model.ts:184-208`) | open editor | E | scheme `file` only |
| E2 | typed edits merge, remote edits apply | `TWS/theorem-editor-model.ts` (208) | documents.edit; `onRemoteChange`, `onStateChange` | Y | merge window 1000 ms (:26); "edits were refused and dropped" on `onError` | typing | E | |
| E3 | per-client undo/redo | same :121-129 | `session.undo/redo`, `canUndo/canRedo` | Y | - | undo/redo | E | |
| E4 | save | `theorem-editor-model.ts`, `theorem-file-system-provider.ts` | documents.save | Y | conflict dialog (:168-179): "Keep the open text", "Take the file on disk", "Accept the deletion" -> `resolveConflict('authority'/'disk')`; `stale_revision` where current < base reseats the session, otherwise `authority_behind` (`workspace-recovery.ts`) | Save | E | README names dependency on branch `claude/ide-save-unchanged` (not verified) |
| E5 | line-ending and offset mapping | `TWS/line-map.ts` (48) | - | - | - | - | E | frontend-independent |
| E6 | Markdown reading/editing | `applications/browser/package.json` `theiaPlugins` (vscode.markdown, vscode.markdown-language-features vsix 1.108.2); `/theia/webview` public asset | none (Theia plugin host) | - | `ide/plugins` not present in the checkout (gitignored; not downloaded) | Markdown preview | plugin license per vsix | not verified at runtime |
| E7 | read-only diff/before-after documents for delegations | `TWS/theorem-delegations.ts` | see Chat | - | writes refused (read-only) | - | E | |

## 3. Language

All rows: consumer `TWS/theorem-language-features.ts` (421) unless noted; license E. Common behavior: pending edits are flushed first (`session.flushed()`) and the revision is sent; LSP ContentModified (-32801) is retried 5 times at 1000 ms; locations outside the workspace are dropped; a failed request reads as no answer except the user actions format, rename, code action, which show an error message.

| ID | Capability | Host/SDK op | Host has | Notes |
|---|---|---|---|---|
| L1 | completion + resolve (triggers `. : < / " ' @`) | `api.complete`, `resolveCompletion` | Y/Y | |
| L2 | hover | `api.hover` | Y | |
| L3 | signature help | `api.signatureHelp` | Y | |
| L4 | go to definition/declaration/type/implementation | `api.navigate(kind)` | Y x4 | |
| L5 | find references | `api.references` | Y | |
| L6 | document symbols | `api.symbols` | Y | |
| L7 | document highlights | `api.documentHighlights` | Y | |
| L8 | folding ranges | `foldingRanges` (host 0-based) | Y | |
| L9 | selection ranges | `selectionRanges` | Y | |
| L10 | code actions + apply | `api.codeActions`, command `theorem.applyCodeAction`, `applyPlan`/`runCodeAction` | Y (`language.codeAction`, `applyCodeAction`) | |
| L11 | format document | `api.format` then `applyPlan` | Y | |
| L12 | rename (prepare + rename) | `prepareRename`, `rename`, `applyPlan` | prepare Y; `language.rename` N | message "The language host proposed no rename."; the SDK method's wire name was not read |
| L13 | inlay hints | `operate('language.inlayHints')` (:224) | Y | |
| L14 | code lens (labels only; commands not run) | `operate('language.codeLenses')` (:243) | Y | |
| L15 | document links | `operate('language.documentLinks')` (:254) | Y | |
| L16 | linked editing | `operate('language.linkedEditing')` (:265) | Y | |
| L17 | call hierarchy incoming/outgoing | `TWS/theorem-call-hierarchy.ts:78` `operate('navigation.hierarchy',{kind:'call',direction})` | Y | out-of-workspace symbols dropped; Theia `@theia/typehierarchy` has no binding |
| L18 | syntax grammars (TextMate, 29 language ids) | `TWS/theorem-grammars.ts` (88) | none (frame-local; tm-grammars, linguist-languages) | - | Theia-local |

## 4. Diagnostics

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Lic | Notes |
|---|---|---|---|---|---|---|---|
| D1 | Problems markers per open document | `TWS/theorem-diagnostics.ts` (124) | `language().diagnostics({resourceId, language, revision})` | `language.diagnostics` N; `diagnostics.subscribe` Y (mapping unverified) | debounce 400 ms; re-read on `file.changed` and resync; a snapshot is dropped if `snapshot.revision !== session.revision` or edits pending; ProblemManager owner `theorem`; severities error/warning/info/hint | E | |

## 5. Search and replace

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Routes | Lic | Notes |
|---|---|---|---|---|---|---|---|---|
| S1 | search in files (text, regex, case, whole word, include/exclude) | `TWS/theorem-search.ts` (167), `search-rows.ts` (69, uses SDK `scalarToUtf16`) | `ide.search.query` {query, view:'text', regex, case_sensitive, whole_word, include, exclude, limit:200} | `search.query` Y | continuation by `{id, limit}` | Search view | E | |
| S2 | cancel search | same | `ide.search.cancel {id}` | Y | local cancel between calls | - | E | |
| S3 | file search (Quick Open) | see F6 | filesList | - | - | Quick Open | E | |
| S4 | replace in files | none | none called | `search.replacePreview` Y | Theia's replace UI is present (`@theia/search-in-workspace`); the frame binds no replace path | Search view replace | - | list (b) |

## 6. Source control

All rows: consumer `TWS/theorem-scm.ts` (522) unless noted; license E. Provider id `theorem-scm`; refresh debounce 300 ms; refreshes on `file.changed`, `document.saved`, resync; groups merge / index / workingTree; status letters M T A C R D U !; a workspace without git shows no repository.

| ID | Capability | Host/SDK op | Host has | States and refusals | Command / menu |
|---|---|---|---|---|---|
| G1 | status and groups | `scm.status()` | Y | | `theorem.scm.refresh` |
| G2 | stage / unstage / stage all / unstage all | `scm.stage`, `scm.unstage` | Y | | `theorem.scm.stage`, `unstage`, `stageAll`, `unstageAll` |
| G3 | discard with undo | `scm.discard` (returns `restore_id`), `scm.restore` | Y | Undo notification | `theorem.scm.discard` |
| G4 | commit | `scm.commit` | Y | "Write a commit message first."; "There are no changes to commit."; nothing staged offers "Stage All and Commit" | `theorem.scm.commit` |
| G5 | create / switch branch | `scm.branch(name, create?)`, `scm.branches()` | Y | | `createBranch`, `switchBranch` |
| G6 | fetch / push | `scm.fetch()`, `scm.push()` | Y | | `fetch`, `push` |
| G7 | merge and conflict resolution | `operate('scm.merge',{ref})` (:504), `operate('scm.resolve',{path,take})` (:518) | Y/Y | merge-conflict message; conflicts open the file | `merge`, `keepOurs`, `keepTheirs` |
| G8 | diff targets | `scm.show(path, ref||'index')`; resource scheme `theorem-scm` (`TheoremScmResourceResolver`) | Y | working tree vs index, index vs HEAD | SCM view |
| G9 | decorations and menus | `gitDecoration.*` colors (:376); menus (:343-361); toolbar (:363) | - | - | |

Not present in the frame: amend, stash, tag, rebase, per-hunk stage, pull, repository selection, `scm.diff`, `scm.checkout` (advertised on host, not called by the frame; branch switch goes through `scm.branch(name)`). Commit/amend and "newer commit text survives an earlier acknowledgement" (R18) are not addressed by the frame source.

## 7. Blame, history, timeline

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Command | Lic |
|---|---|---|---|---|---|---|---|
| H1 | line blame | `TWS/theorem-blame.ts:123` (131), `blame-hunks.ts` | `operate('scm.blame',{path})` | Y | hidden while the editor is dirty; invalidated on `document.saved`, `file.changed`, resync; storage key `theorem.lineBlame` | `theorem.scm.toggleLineBlame` ("Toggle Line Blame") | E |
| H2 | File History (journal) list | `TWS/theorem-timeline.ts:124` | `operate('history.list',{resource_id})` | Y | empty list for a file unknown to journal and git | Timeline view | E |
| H3 | git log entries | same :152 | `operate('scm.log',{path, limit:100})` (local cap 50) | Y | | `theorem.timeline.openCommit` | E |
| H4 | open a revision | same :51 | `operate('history.preview',{point, resource_id})`; scheme `theorem-history` | Y | | `theorem.timeline.openRevision` | E |
| H5 | restore a revision | same :196 | `operate('history.restore',{point, resource_id, workspace_id})` | Y | | `theorem.timeline.restoreRevision` ("Restore This Revision", `TIMELINE_ITEM_CONTEXT_MENU`) | E |

## 8. Terminal and profiles

All rows: consumer `TWS/theorem-terminal.ts` (301) and `TWS/terminal-profile.ts` (72); license E.

| ID | Capability | Host/SDK op | Host has | States and refusals | Commands / routes |
|---|---|---|---|---|---|
| T1 | open native shell | `operate('terminal.open', {cols, rows})` (:52) then `TerminalChannel.reconnect` | Y | start failure fires `onDidOpenFailure` and throws | profile "Shell"; Terminal > New |
| T2 | attach, input, resize, output, reset | `TerminalChannel.attach/input/resize/onData/onReset` | Y (`terminal.attach/input/resize`) | writes ignored once the channel `hasExited` | - |
| T3 | exit and lost shell | `onExit(code, 'exited'\|'lost')` | - | lost: message "This shell ended when the workspace host restarted. Press Enter for a new shell."; Enter calls `replaceLostShell` (:148) using `TerminalChannel.open`; failed replace says "A new shell could not start (...). Press Enter to try again." | - |
| T4 | detach on close | `TerminalChannel.close` (`dispose` :223) | Y (`terminal.close`) | closing the widget never kills the host shell | - |
| T5 | restore after reload | `storeState/restoreState` (:200-208) key `theoremSession` | Y | - | - |
| T6 | Herdr profiles | `terminal-profile.ts:28-33`: "Herdr shell", "Claude Code (Herdr)" (argv `['claude']`), "Codex (Herdr)" (argv `['codex']`); `openBody` sends `{cols, rows[, backend, argv]}` | `backend`/`argv` handling in the host not found on origin/main | profile registered only if `herdrReady(capabilities)` = `capabilities.backends.herdr.ready === true` (:42; contribution :248) | profile picker |
| T7 | Herdr host-restart rebind | `followHostRestarts` (:81) on live `resync.reason === 'epoch_changed'`, then `rebind` with `term.reset()` | live | Herdr profiles only | - |
| T8 | end terminal process | `operate('terminal.kill',{session})` (:218), gated by `offers('terminal.kill')` | N (on `feat/herdr-live-adoption` only) | `canEndProcess` false when not offered, so the menu entry does nothing | command `theorem.terminal.endProcess` ("End Terminal Process", :32); menu `TERMINAL_CONTEXT_MENU/_4` (:281) |
| T9 | no autostart; default profiles | `initializeLayout` no-op (:238); `getDefaultShell` '' | - | - | - |
| T10 | Theia terminal UI reused whole | `@theia/terminal` (xterm, search, links, theming, `TERMINAL_CONTEXT_MENU`) | `terminal.search/copy/paste` host ops not called | Theia-local search | Terminal menus |
| T11 | status-bar terminal toggle | `ZL/zed-dock-buttons.ts` (`TerminalCommands.TOGGLE_TERMINAL`) | - | - | dock button |

Parent side: `src/components/terminal/terminal-screen.tsx:14,164,189` (`useTerminalRuns`, `useRevealFile`) is a separate terminal-runs surface, not the Theia terminal; its Theia link is the reveal call (see Follow).

## 9. Run

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Command | Lic |
|---|---|---|---|---|---|---|---|
| R1 | add run configuration | `TWS/theorem-run.ts:74` (134) | `operate('run.configure',{name, argv:['sh','-c',line]})` | Y | "Run: ... failed" | `theorem.run.add` ("Add Configuration...") | E |
| R2 | start | :80-92 | `run.list`, `run.start {name, wait:false}` | Y/Y | "There are no run configurations yet..."; one process at a time | `theorem.run.start` ("Start...") | E |
| R3 | stop | :102 | `run.stop {handle}` | Y | - | `theorem.run.stop` ("Stop") | E |
| R4 | output | :113 | `run.subscribe {handle}` polled every 400 ms; Output panel channel "Run" | Y | "[lost the run: ...]" | Output view | E |

Theia `@theia/task`, `@theia/debug`, `@theia/test` are installed (dependencies) with no frame binding to `tests.*` or `debug.*` (list b). The status bar run item is mirrored by `runStatusBarItem` (bridge :116-134).

## 10. Chat and delegations in the frame

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Lic |
|---|---|---|---|---|---|---|
| C1 | `Theorem` chat agent mirroring the parent conversation | `TWS/theorem-chat.ts` (480), `THEOREM_AGENT_ID`; parent `UI/chat-mirror.ts` (134), `UI/ide-frame.tsx` `useChatMirror` | bridge host methods `send`, `cancel`, `openThread`, `openArtifact`; frame method `setThread`, `closeChatView` | - | "This is not the conversation open in Theorem. Open it there first."; "This IDE is not linked to Theorem." | E / - |
| C2 | approvals | same; `UI/ide-frame.tsx` `sendApprovalDecision` | bridge `decideApproval` | - | `settled` state; "The decision did not reach Theorem. Decide it in the conversation instead." | E |
| C3 | message parts | same | parts text, reasoning, tool-call, data (`theorem-delegation`, `theorem-review`, `theorem-intent`, `theorem-artifact`) | - | - | E |
| C4 | change-set elements and admission states | same | pending, admitted, direct, conflict, refused, out_of_scope | - | - | E |
| C5 | delegation before/after documents | `TWS/theorem-delegations.ts` (157) | `client.chat.runs.delegations({runId})`, `client.chat.runs.delegationContent({runId, delegationId, ref})` | not in environment host (chat API) | 404 -> "this change is no longer stored"; writes refused as read-only; binary changes skipped | E |
| C6 | open changes from the parent | frame method `openChanges` (bridge); parent `UI/follow.ts` `useOpenChanges`; `src/components/chat/delegation-parts.tsx:24,223,311,462,653` ("Open in IDE") | `DiffUris` per change | - | - | E / - |
| C7 | artifact open / follow | bridge `openArtifact`; `UI/follow.ts` `followArtifact`; `src/components/artifacts/artifact-message.tsx:24,227`; `src/components/chat/theorem-parts.tsx:48,571` (`OpenInIde`) | - | - | - | - |

## 11. Follow and Add Selection bridge

| ID | Capability | Current consumer | Message / op | States and refusals | Command / key | Lic |
|---|---|---|---|---|---|---|
| B1 | Add Selection to Chat | `TWS/theorem-ide-bridge.ts:44` | host method `addToChat`; payload `{location, excerpt, label}`; `label` = `path:line` or `path:a-b`; `location` = `{resource:{kind:'file', workspaceId, path}, range:{start,end,unit:'utf16'}}`, range omitted when the selection is empty | visible only when `host !== undefined` | `theorem.addToChat`; `ctrlcmd+alt+l` when `editorFocus` (:190); `EditorContextMenu.NAVIGATION` order '0' (:186) | E |
| B2 | reveal a location | frame method `reveal` (:116-134); parent `UI/follow.ts` `useRevealFile` (utf16 range, `reveal(..., {preview:true})`, navigates to `/ide`) | returns false unless `resource.kind === 'file'` and `workspaceId` matches; ranges converted from scalar/utf8/utf16 | E / - |
| B3 | Follow the agent | bridge: live `document.changed` events where `data.actor` is in followed actors (`theorem:run:<runId>`); `showEdit` opens a preview editor in `reveal` mode at `scalarToUtf16(min(edit.start))` | parent `useFollowRuns`, `workingRuns`, `useChatRuns` (`UI/follow.ts`) | pauses on `navigated` | status bar `theorem.follow` ("Following the agent"/"Follow the agent") | E / - |
| B4 | follow toggle state | `UI/follow.ts` `useFollow` (default true); frame methods `setFollowing`, `setFollowedRuns`; host methods `setFollowing`, `navigated`; `src/components/shell/dock.tsx:358` `FollowToggle` | - | - | - | - |
| B5 | frame to parent state | host methods `connectionChanged`, `filesChanged`, `statusBarChanged`, `sidebarChanged`; parent `UI/ide-status-bar.tsx` (101), mounted at `src/components/shell/chat-shell.tsx:387,423` | - | - | - | - |
| B6 | transport | penpal 8.0.1 `WindowMessenger`; bridge initializes only when `window.parent !== window`; contract `TWC/ide-bridge.ts` (198; `IdeFrameMethods` 137-167, `IdeHostMethods` 170-198) | - | 45 s start-wait in `UI/ide-frame.tsx`; "The workspace did not open" / "The IDE has not started" | - | E |

## 12. Workspace environment, recovery, connection

| ID | Capability | Current consumer | Host/SDK op | Host has | States and refusals | Lic |
|---|---|---|---|---|---|---|
| W1 | workspace identity from URL | `TWS/theorem-connection.ts:63-82`; `UI/follow.ts` `workspaceIdOf` (`projectId.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,80)`) | query `workspace` (default `local`), `name`, `layout=embedded`; root `file:///<name>` | - | - | E / - |
| W2 | attach | :106-114 | `client.environment.bootstrap`, `client.remoteWorkspaces.open` with CSRF and Idempotency-Key | workspaces route Y | `IdeConnection` status: workspace opening/open/failed; live connecting/open/reconnecting/resyncing/closed | E |
| W3 | operate / offers / capabilities | :149, :169, :182 | `POST operations/{name}`, `GET operations`, `GET workspaces/{id}/capabilities` | Y | operate throws `TheoremError` | E |
| W4 | recovery | `TWS/workspace-recovery.ts` (158) | `recoveringSend`, `isolateResyncListeners`, `openUntilReady`, `RETRY_DELAYS` 1,2,4,8,15,30 s | - | `workspace_not_open` 404 then reopen (:117,124); stale_revision handling | E |
| W5 | live events | `WorkspaceLive` (SSE) | `file.changed`, `document.saved`, `document.changed`, `onResync` | live | reason `epoch_changed` triggers Herdr rebind | E |
| W6 | host-path to workspace-path | :234 `fromHostUri`; `host-paths.ts` | `operate('workspace.describe',{resource_id})` | Y | roots cached | E |
| W7 | retry connection | bridge frame method `retryConnection`; status bar `theorem.connection` | - | - | - | E |
| W8 | user settings | `TWS/theorem-workspace-environment.ts` (74): `theia-user:` scheme over browser OPFS, `theoremEnvVariablesServer`, `TheoremWorkspaceServer` | none | Theia settings stay in the browser | E |

## 13. Theme

| ID | Capability | Current consumer | Notes | Lic |
|---|---|---|---|---|
| M1 | parent token sync | `UI/ide-theme.ts` (77): reads `IDE_TOKENS` (`TWC/ide-theme.ts:14-21`) with computed style + culori; MutationObserver on class, `data-palette`, style; frame method `setTheme` | | - / E |
| M2 | Stone theme following parent | `TWS/theorem-stone-theme.ts` (101), `TWC/ide-theme.ts` (329; `ideThemeJson` :295), `UI_THEME='theorem-ui'`, colors `theoremSheet.top/bottom/editorBackground` | default theme `theorem-stone-light/dark` | E |
| M3 | bundled themes | `ide/theia-extensions/theorem-workspace/src/browser/themes/{stone,vitesse,github}`; `ZL/zed-theme-converter.ts` (443), `zed-theme-contribution.ts` | LICENSE: GitHub Primer, Anthony Fu Vitesse (MIT), Zed One/Ayu/Gruvbox (MIT) | E + vendored |
| M4 | fonts | `ZL/style` (IBM Plex Sans, Lilex, OFL license files) | `editor.fontFamily` `'Zed Mono', Lilex, Menlo, monospace`, size 15 | OFL |
| M5 | frame chrome | `ZL/zed-look-frontend-module.ts` (rebinds ApplicationShell, SidePanelHandler, StatusBarImpl, BrowserMenuBarContribution, ScmContribution), `zed-title-bar.tsx/-contribution.ts`, `zed-status-bar.ts`, `zed-application-shell.ts`, `zed-side-panel-handler.ts`, `zed-dock-buttons.ts`, `zed-explorer.ts` | `zed-embedded.ts` reads `?layout=embedded` | E |
| M6 | preference defaults | `ide/applications/browser/package.json` `theia.frontend.config.preferences` (e.g. `files.enableTrash:false`, `security.workspace.trust.enabled:false`, `editor.minimap.enabled:false`, `ai-features.chat.defaultChatAgent:"Theorem"`, `ai-features.chat.persistedSessionLimit:0`) | | Apache-2.0 (package) |
| M7 | sidebar state to the parent | frame/host methods `setSidebar`, `sidebarChanged`; `src/components/shell/shell-state.ts:59-64,105-107,144,176-179,269-314` (`ideFilesOpen`, `ideFilesHeight`, v6 migration) | | - |

## 14. Build, deploy, routes

| ID | Capability | Current consumer | Notes |
|---|---|---|---|
| X1 | `/ide` route and shell modes | `src/routes/_chat/ide.tsx` (6 lines, component null); `src/components/shell/modes.tsx:5,30,43,89,107,138` (`<IdeFrame/>`); `routeTree.gen.ts`; `src/components/shell/sidebar.tsx:178,188`; `src/components/shell/dock.tsx:68-69,320,525`; `src/components/pages/builtins.tsx:24-25,384,397-433,463,629-655` (`theorem.ide` module with `chat` setting own/conversation/terminal/page, event `added`, focus selector `iframe[title="IDE"]`); `src/components/organize/sessions-panel.tsx:50-51,807` (`togglePanel('ide')`) | |
| X2 | `/theia/*` static origin | `vite.config.ts:108-150` Nitro publicAssets `/theia/webview` from `ide/applications/browser/lib/webview/pre` and `/theia` from `lib/frontend`; Cloudflare config ignores `*.map`, `*.map.gz`; `patches/nitro@3.0.260903-beta.patch` (brotli dev fix for Theia's bundle) | |
| X3 | fallback when not built | `src/routes/theia/$.ts` (27): 503 "The IDE is not built on this server..." for `/theia/` and `index.html`, otherwise 404 | |
| X4 | build | `scripts/build-cloudflare.sh:3,31,33,34` (`bun install --cwd ide --frozen-lockfile`, `build:extensions`, `applications/browser build:prod`); `scripts/build.sh` delegates to it when `WORKERS_CI=1`, else runs `terminal/build.sh` and `vite build` (no Theia build on that path) | |
| X5 | Theia build config | `ide/package.json` (bun workspaces; scripts build, build:extensions, build:browser, download:plugins, start; `patchedDependencies`), `ide/applications/browser/package.json` (target browser-only; ~40 `@theia/*` deps; `theiaPlugins` markdown vsix), `esbuild.mjs`, `ide/configs/base.tsconfig.json` | |
| X6 | patches | `ide/patches/` (1548 lines): @theia core, navigator, plugin-ext-vscode, plugin-ext, plugin-utils, terminal 1.76.0; vendored sdk 0.6.0-alpha.3 tgz (348 lines); drivelist 12.0.2; node-pty 1.2.0-beta.12 | |
| X7 | tooling exclusions | `eslint.config.js:42` ignores `ide/**`; `.prettierignore:5`; `tsconfig.json` excludes `ide`; `README.md:49,91`; `.github/workflows/composer.yml` path filters (no Theia build step seen) | |
| X8 | parent dependencies | `package.json`: `penpal` 8.0.1, `@headless-tree/*`, `@vscode/codicons` 0.0.45, `culori` 4.0.2, vendored `@theoremharness/sdk` alpha.5 (ide/ vendors alpha.3) | `@headless-tree` used by `ide-file-tree.tsx`; others not checked for other consumers |
| X9 | API proxy | `src/routes/api/environment/v1/$.ts` -> `src/server/theorem-proxy.ts` (adds bearer server-side) | also serves non-IDE `/api/environment/v1/tools`; not Theia-only |

## Counts per area

Files 8; Editing/document sessions 7; Language 18; Diagnostics 1; Search/replace 4; SCM 9; Blame/history/timeline 5; Terminal and profiles 11; Run 4; Chat/delegations 7; Follow/Add Selection 6; Workspace environment/recovery 8; Theme 7; Build/deploy/routes 9. Total 104 rows.

## List (a): in Theia with no host operation behind them (Theia-local)

- Monaco editor features in `@theia/monaco`/`@theia/editor` that never leave the browser: in-file find and replace, multi-cursor, bracket matching, snippets, minimap (disabled by preference), word-based suggestions.
- TextMate syntax highlighting (`theorem-grammars.ts`, 29 languages).
- Markdown preview and Markdown language features (vsix plugins; not verified at runtime).
- Command palette, keybinding editor (`@theia/keymaps`), preferences UI (`@theia/preferences`), notifications (`@theia/messages`), output panel (`@theia/output`), outline view (`@theia/outline-view`), editor preview, secondary window, mini-browser, bulk-edit, console, variable resolver. Names come from `applications/browser/package.json` dependencies; none was exercised.
- Theia terminal search, links, theming (xterm), although the host advertises `terminal.search/copy/paste`.
- Settings storage (`theia-user:` over OPFS), layout restore, theme conversion, fonts.
- Plugin host (`@theia/plugin-ext`, `plugin-ext-vscode`, `vsx-registry`): the frame has no `extensions.*` or `customEditors.*` consumer; behavior is local to the browser-only app. Not verified.

## List (b): reachable in the UI, host operation missing, unavailable, or unbound

- Copy/paste of files in the explorer: `workspace.files.copy` is not advertised on origin/main; `requireFileServices` refuses with Unavailable.
- Binary file writes: refused when `workspace.files.copy` is not offered (same guard).
- End Terminal Process: `terminal.kill` is advertised only on `feat/herdr-live-adoption`; on main the command resolves to no action.
- Herdr terminal profiles: appear only when `capabilities.backends.herdr.ready === true`. origin/main's capabilities body has no `backends` key, so on main the profiles never register. `backend`/`argv` handling in `terminal.open` was not found on main either (no `"backend"` or `"argv"` hit in `apps/theorem-ide-host/src` except a test at `session.rs:1207`).
- Herdr restart rebind (T7): depends on the Herdr profiles above.
- Replace in Search view (S4): Theia UI present, no replace path bound; `search.replacePreview` is advertised and not called.
- Debug, Test, Task, Notebook views (`@theia/debug`, `test`, `task`, `notebook` are dependencies): the host advertises `debug.*` and `tests.*` and has a `debug-adapter` route; the frame binds none of them.
- Type hierarchy (`@theia/typehierarchy`): only the call hierarchy is bound.
- Code lens commands: labels render, commands are not executed.
- Rename: the frame calls `rename` through the SDK; `language.rename` is not in the advertised list (wire name not verified).
- Diagnostics: the frame calls `language().diagnostics`; `language.diagnostics` is not advertised; `diagnostics.subscribe` is (mapping not verified).
- SCM amend, stash, pull, per-hunk staging: not present in the frame's SCM provider although Theia's SCM view is installed.
- Extensions, custom editors, workbench views (`extensions.*`, `customEditors.*`, `workbench.*` advertised): no frame consumer.

## List (c): frontend-independent SDK glue that could be rebound rather than rewritten

No import from `@theia/*` or `inversify`; unit tests present unless noted. All under `TWS` unless noted.

- `workspace-recovery.ts` (158): recoveringSend, isolateResyncListeners, openUntilReady, retry schedule. Test: `workspace-recovery.test.ts`.
- `terminal-profile.ts` (72): profiles, `herdrReady`, `openBody`, partition/lookup. Test: `terminal-profile.test.ts`.
- `host-paths.ts` (31): `workspacePathOf`.
- `directory-listing.ts` (39): `childrenOf` for both `workspace.files.list` shapes.
- `replace-entry.ts` (39): copy-beside-and-swap helper.
- `line-map.ts` (48): line-ending/offset mapping.
- `search-rows.ts` (69): search answer to rows (uses SDK `scalarToUtf16`).
- `blame-hunks.ts` (43): blame hunks to lines.
- `TWC/ide-bridge.ts` (198): bridge message contract (types only; Theia-free apart from SDK types).
- `TWC/ide-theme.ts` (329): theme token list and theme JSON builder (frontend-independent; consumed by both the frame and `UI/ide-theme.ts`).
- Parent: `src/components/ide/follow.ts` (143, zustand + routing), `chat-mirror.ts` (134), `ide-page.ts` (31), `ide-theme.ts` (77) depend on the app, not on Theia, but are bound to the `IdeHostMethods` contract above.
- Logic embedded in Theia classes but SDK-only in substance (would need extraction, not rebinding): the session acquire/refcount in `theorem-connection.ts`, conflict resolution in `theorem-editor-model.ts`, the SCM command bodies in `theorem-scm.ts`, the Run poll loop in `theorem-run.ts`, the language request/retry wrappers in `theorem-language-features.ts`.

## Not verified

- The vendored SDK sources (`@theoremharness/sdk` 0.6.0-alpha.3 under `ide/`, alpha.5 at the repo root) were not unpacked; the wire operation names behind typed SDK methods are inferred, not read. The `diagnostics()`, `rename`, `filesStat/List/Create/Delete/Rename/Read`, and `documents.*` mappings are such cases.
- No code was run: no build, no unit test, no browser session, no Theia runtime. Nothing here says the frame works end to end today.
- Whether Theia is deployed anywhere, or which host build production points at. Host contract facts are from `origin/main` of the backend repo (a snapshot at inspection time); the host actually serving the frame was not queried.
- The host dispatcher's argument handling for `terminal.open` (`backend`, `argv`) and the actual response shape of `GET /operations` against a live host.
- `ide/plugins` is absent from the checkout (gitignored), so the markdown plugin contents were not seen; the root `ide/package.json` `theiaPlugins` (whole vscode-builtin-extensions tarball, with exclusions) is not read by the browser app per its config, not confirmed by running the build.
- README claims about branches `claude/pm-ide-files` (commits 3cc1cfe15b, 7ad870b944) and `claude/ide-save-unchanged`: both remote branches exist in the backend repo; their merge state into main was not checked.
- Theia built-in behaviors listed in (a) are named from package dependencies, not from exercising them.
- Docs under `docs/plans/` that mention Theia (theia-theorem-integration.md, ide-agent-workspace.md, delegations-change-sets-and-ide.md and others) were not read.
- Acceptance reference ids for entries added to the register were not assigned (the source does not map them).
