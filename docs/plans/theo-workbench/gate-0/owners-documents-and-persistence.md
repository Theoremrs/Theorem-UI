# Gate 0: owners of documents, files, SCM, conversation and persistence

Read-only inventory. Facts only; "UNVERIFIED" marks anything not confirmed in source.

Path shorthands:
- `SDK/` = `@theoremharness/sdk` 0.6.0-alpha.5 unpacked under `/private/tmp` (never executed). `SDK/index.js` = `dist/index.js`; `SDK/t/` = `dist/types/src/`; `SDK/g/` = `dist/types/generated/api/`.
- `EXT/` = `ide/theia-extensions/theorem-workspace/src/browser/`.
- `BE/` = `/Users/travisgilbert/Tech Dev Local/Creative/Theorem/rustyredcore_THG/crates/theorem-ide-runtime/src/` (read-only; checked-out branch `cursor/native-e2e-verification-fc4c`, so possibly not the deployed version).

## 1. SDK package

| Fact | Source |
|---|---|
| Package `@theoremharness/sdk` 0.6.0-alpha.5, tgz `vendor/theoremharness-sdk-0.6.0-alpha.5.tgz` | `package.json:120` |
| Patch registered for the vendored tgz | `package.json:273` |
| `vendor/` also holds an alpha.3 tgz (not referenced by the dependency line) | `vendor/` listing |
| Exports: `.`, `./assistant-ui`, `./headless-node`, `./claude` | SDK `package.json` exports |
| Layer split: Fern-generated clients plus hand-written `src/*.d.ts` | `SDK/g/`, `SDK/t/` |

Generated clients (SDK/g/Client.d.ts): `files`, `documentSessions`, `ide.{workspace,scm,search,run,language,diagnostics,terminal,history,navigation,refactor,workbench}`, `remoteWorkspaces`, `environment.bootstrap`, `capabilities.{list,describe}`, `workbench.{get,save}`, `chat.{projects,threads,messages,runs,intents,organization}`.

Hand-written layer (SDK/t/): `DocumentSession` (`document-session.d.ts`), `WorkspaceLive` (`live.d.ts`), `TerminalChannel` (`terminal.d.ts`), `WorkspaceScm` (`scm.d.ts`), `WorkspaceLanguage` (`language.d.ts`), `HeadlessConversation` (`headless.d.ts`), `TheoremResource/Location/Range` (`reference.d.ts`), offsets helpers (`offsets.d.ts`).

Transport: every `src/routes/api/*/v1/$.ts` is a 7-line proxy to `src/server/theorem-proxy.ts`; the server injects the bearer and drops cookie and authorization headers. Mutations carry `X-CSRF-Token` and `Idempotency-Key` from `bootstrap()`/`mutate()` (`src/lib/theorem/client.ts:97-131`); `mutate` re-bootstraps once on 403; `mutateThread` sends `If-Match` with the thread revision.

## 2. Workspace and environment identity

Two distinct "workspace" worlds. The adapter must name which one a panel talks to.

| World | Owner | Surface |
|---|---|---|
| A. Vault files | `WorkspaceClient`, `src/lib/workspace/theorem-client.ts`, `workspaces.ts` | `/api/files/v1`, `client.files.*` |
| B. IDE workspace host | `TheoremConnection`, `EXT/theorem-connection.ts` | `/api/environment/v1/workspaces/:id/...`, `client.remoteWorkspaces`, `client.ide.*`, `DocumentSession`, `WorkspaceLive`, `TerminalChannel` |

| Identity fact | Source |
|---|---|
| Workspace id = `projectId.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,80)` | `src/components/ide/follow.ts:57` |
| Active project: `useActiveProject()`; persisted `useShell.projectId`, falls back to inbox | `src/components/shell/projects.ts:49` |
| IDE frame URL `/theia/?workspace=<id>&name=<title>[&layout=embedded]` | `src/components/ide/ide-frame.tsx:120-127` |
| Tenant/principal from `environment.bootstrap`: `{schema, tenantId, principalId\|null, csrfToken, canDelegate?}` | `SDK/g/EnvironmentBootstrap.d.ts` |
| `RemoteWorkspace {workspace_id, active, durable}` | `SDK/g/RemoteWorkspace.d.ts` |

Host capabilities:

| Call | Shape | Source |
|---|---|---|
| `GET api/environment/v1/operations` | `connection.offers(name)` | `EXT/theorem-connection.ts:169` |
| `GET api/environment/v1/workspaces/:id/capabilities` | `WorkspaceCapabilities {schema:'theorem-workspace-capabilities/1', workspace_id, version, epoch, cursor, granted_by, operations: WorkspaceOperationCapability[]}` | `EXT/theorem-connection.ts:182`; `SDK/g/WorkspaceCapabilities.d.ts` |
| `remoteWorkspaces.capabilities()` | same type | `SDK/g/Client.d.ts` |
| Live event `workspace.capabilities` | via `WorkspaceLive` | `SDK/index.js:36605` |
| `backends.herdr.ready`; older host reports no backends, absence means not ready | | `EXT/terminal-profile.ts:39-45` |

What "unavailable environment" looks like: no dedicated type exists. It is inferred from:
- `IdeConnection {workspace:'opening'|'open'|'failed', live:'connecting'|'open'|'reconnecting'|'resyncing'|'closed', error?, retryInMs?}` (`ide/theia-extensions/theorem-workspace/src/common/ide-bridge.ts:90`).
- `ide-frame.tsx` 45 s `START_WAIT_MS`, then an `ErrorState` with retry.
- Status bar text "Workspace unavailable, Retry" (`EXT/theorem-ide-bridge.ts:380`).
- HTTP 404 with code `workspace_not_open` triggers reopen (`EXT/workspace-recovery.ts`).
- Vault world absence reasons: `signed-out` (401), `forbidden` (403), `unsupported` (404/501), `unconfigured` (503 `theorem_unconfigured`) (`src/lib/workspace/theorem-client.ts`).
- Generic error union `EnvironmentProblem = NativeHostProblem | Problem` (`SDK/g/EnvironmentProblem.d.ts`).

## 3. Files

| Operation | World B (IDE host) via `EXT/theorem-file-system-provider.ts` | World A (vault) |
|---|---|---|
| stat | `ide.workspace.filesStat` -> `{type:'file'\|'directory'\|'missing', size, mtime_ms, readonly}` | entries with `backing:'agentfs'\|'document'\|'plan'`, `readOnly`, `placed` |
| list | `filesList {path}` -> `entries[{name,kind}]` (per directory) or `files`/`directories` (whole tree, minus `.git`, `node_modules`, `target`, `dist`); `directory-listing.ts` accepts both, so lazy listing depends on host version | `files.entries` |
| search (names) | `ide.workspace.filesList({body:{}})` -> `files:[{path, ignored?}]`, cached until create/delete event or resync | `files.search` |
| open/read | `filesRead` -> `{encoding:'utf8'\|'base64', contents}`; text opens go through `DocumentSession` | `files.read` with `expectedHash` |
| create | `filesCreate {path, directory? \| contents, encoding:'base64'}` | `files.write`, `files.mkdir` |
| rename | `filesRename {from,to}` | `files.move` |
| delete | `filesDelete` | `files.remove` |
| copy | `workspace.files.copy` via `connection.operate`, gated by `offers(...)` | n/a |
| write existing text | `lease.session.edit([replacement]); save()`; binary via `filesCreate` base64 | `files.write` with `expectedHash` |
| events | `file.changed` on `WorkspaceLive`; path `.` means events were lost | `files.events({after, waitMs})` with `resync` flag |

Error mapping (EXT file system provider): 404 or `not_found` -> FileNotFound; 409 `already_exists` -> FileExists; 403 -> NoPermissions; else Unknown. `kind:'symlink'` -> SymbolicLink. No explicit refused-path or excluded-path error code found (UNVERIFIED in backend).

## 4. Document session contract

Owner: `DocumentSession` (`SDK/index.js:37237-37590`, `SDK/t/document-session.d.ts`); wire via `client.documentSessions.*` (open, subscribe, edit, undo, redo, save, close, setEncoding, exportUpdates, openFromExport, importRemote, transaction, undoTransaction, head, history, list, reconcile). One session per path, refcounted, in `TheoremConnection.acquire` (`EXT/theorem-connection.ts`).

| Concern | Contract |
|---|---|
| open/attach | `DocumentSession.open(options)` -> `documentSessions.open {resource_id, text?}` (seed text optional) |
| edit | `TextChange {start,end,insert}`, UTF-16 offsets against text before the change set; sent as `{operation_id, base_revision, edits, provenance}`; `operation_id` doubles as `Idempotency-Key` |
| model | OT (`ot-text-unicode`): one in-flight op, a buffer, undo stack transformed past remote ops |
| ack / revision | `document.changed` live event matched by `operation_id`, or the response if `head.revision === base + 1` |
| gap | `catchUp` via `documentSessions.history` |
| remote change | `document.changed` (`IdeRevisionRecord` with `actor`, `provenance`, `operation_id`, `edits`); transformed, then `onRemoteChange(changes, text)` in UTF-16 |
| agent edit | same path; actor `theorem:run:<runId>` (`EXT/theorem-ide-bridge.ts:122-123`); chat provenance is the run or `delegation:<id>` |
| conflict | `document.conflict {document_id, resource_id, revision, content_hash, disk_hash, disk_deleted, resolve_with:'documents.reconcile'}`; `resolveConflict('disk'\|'authority')` -> `documentSessions.reconcile {resource_id, keep, expected_revision}` |
| save | `save()` calls `flushed()`, then `documentSessions.save {resource_id, revision}` |
| dirty | `pending \|\| savedRevision !== serverRevision` |
| undo | local, per session |
| refusal handling | `stale_revision` / `revision_conflict`: new operation id plus catch-up. `duplicate_operation` or unknown code: catch-up. Any other code: `reset`, which DROPS unaccepted local edits and clears undo, then `onError`. 409 `stale_revision` with `current < base`: edit dropped (`EXT/workspace-recovery.ts`) |

Position units:

| Surface | Unit |
|---|---|
| `DocumentSession.edit`, `onRemoteChange` | UTF-16 code units |
| `documentSessions.edit` `edits`, `IdeStoredEdit`, `document.changed` wire | Unicode scalar offsets (`utf16ToScalar`, `scalarToUtf16`) |
| `LanguagePosition.character` | UTF-16 code units (LSP) |
| `WorkspaceDiagnostic.start/end` | UTF-8 byte offsets (`positionAt(text, offset)`) |
| `DocumentSpan.coordinate_encoding` | one of `utf8_bytes`, `utf16_code_units`, `unicode_scalars` |
| `TheoremRange.unit` | `utf16`, `scalar`, `utf8` |
| Helpers | `utf16ToScalar`, `scalarToUtf16`, `utf16ToUtf8`, `utf8ToUtf16` (`SDK/t/offsets.d.ts`) |

`WorkspaceLive` (`SDK/index.js:36605`, `SDK/t/live.d.ts`): events `document.changed|moved|retired|conflict|saved`, `file.changed`, `terminal.*`, `workspace.capabilities`; cursor; states `connecting|open|reconnecting|resyncing|closed`; `onResync(reason: malformed_cursor|epoch_changed|cursor_ahead|cursor_expired)` means listeners re-read state.

`TerminalChannel` (`SDK/index.js:37591`): `open`, `reconnect` by session id, absolute byte offsets, `onData`, `onReset(screen)`, `onExit`, `attach`, `input` (with ids so a retried keystroke is written once), `resize`, `close`.

## 5. SCM

Owner: SDK `WorkspaceScm` (`SDK/index.js:37936`, `SDK/t/scm.d.ts`); Theia consumer `EXT/theorem-scm.ts`, `theorem-blame.ts`, `blame-hunks.ts`.

| Operation | Typed `WorkspaceScm` | Notes |
|---|---|---|
| status | `status()` -> `ScmStatus {changes: ScmChange[], branch\|null, head}`; `ScmChange {path, index, worktree, original_path, conflict}` | BE returns `{path, status, conflict}` (`BE/scm.rs`); which one is deployed UNVERIFIED |
| show | `show(path, ref='HEAD'\|'index')` | Theia builds diffs from two `show()` calls (index vs HEAD, working tree vs index) |
| branches | `branches()` | |
| stage / unstage | `stage(paths)`, `unstage(paths)` | whole-path in the typed API |
| discard / restore | `discard(path)` -> `{restore_id}`, `restore(id)` | BE writes `.git/theorem/rejected/<id>.patch` |
| commit | `commit(message)` | no amend in BE |
| branch | `branch(name, create)` | |
| fetch / push | `fetch(remote?)`, `push(remote?, ref?)` | |
| untyped extras | `client.ide.scm`: diff, checkout, merge, conflict, resolve, blame, log (bodies are `NativeArguments`); Theia calls `connection.operate('scm.blame'\|'scm.merge'\|'scm.resolve'\|'scm.log'\|...)`, a POST to `api/environment/v1/workspaces/:id/operations/:name` | |

Diff format and hunks (BE, branch above, UNVERIFIED for deployment):
- `scm.diff {path?, staged?}` -> `{diff: unified text, hunks:[{path, old_start, old_count, new_start, new_count, header, patch}]}`; untracked files get a synthesized diff.
- Hunk-level operations exist: `scm.stage`, `scm.unstage`, `scm.discard` accept `hunk` (`BE/scm.rs:109`, `:156`, `:213`; `apply_hunk` `:795`; `hunk_patch` `:806`), located by `old_start`+`new_start` or inline `patch`.
- `scm.merge` uses `--no-commit --no-ff` -> `{state:'merged'|'conflict', conflicts[]}`.
- `scm.blame` -> hunks `{author, commit, line_count, start_line, summary, timestamp}`; `scm.log {path?, max_count}`.
- No mutation carries a base, index or revision token. Every operation is refused without a live host.

## 6. Language, diagnostics, run, search

| Area | Contract | Revision binding | Unavailable provider |
|---|---|---|---|
| Language (`SDK/t/language.d.ts`, `SDK/index.js:37783`) | `hover`, `complete`, `resolveCompletion`, `signatureHelp`, `navigate(kind)`, `references`, `symbols`, `documentHighlights`, `foldingRanges`, `selectionRanges`, `codeActions`, `runCodeAction`, `format`, `prepareRename`, `rename`, `applyPlan(planId)`, `diagnostics` | every call takes `DocumentRef {resourceId, language?, revision}`; host refuses without revision; edits return as plans applied by the authority | SDK doc says `hover.contents` is empty when no provider answered; Theia swallows failures with `logger.debug`; no typed unavailable result found |
| Diagnostics (`EXT/theorem-diagnostics.ts:96-117`) | `DiagnosticsSnapshot {session_epoch, revision, content_hash, full, diagnostics[]}`; `DocumentVersion {session_epoch, revision, content_hash}` | flush session, read `session.revision`; discard snapshot if `snapshot.revision !== session.revision` or `session.pending` | none found |
| Run (`EXT/theorem-run.ts`) | `run.configure {name, argv}`, `run.list`, `run.start {name, wait:false}` -> `{handle}`, `run.stop {handle}`, `run.subscribe {handle}` polled every 400 ms -> `{state, exit_code, stdout, stderr}` | none | gated by `offers('run.*')` |
| Search (`EXT/theorem-search.ts`) | `ide.search.query {query, view:'text', regex, case_sensitive, whole_word, include, exclude, limit:200}` -> `{id, results, complete, cancelled}`; follow-up `{id, limit}` pages; `ide.search.cancel {id}` | none (results not tied to a document revision) | none found |

## 7. Conversation and runs

| Fact | Source |
|---|---|
| Web chat: assistant-ui `useLocalRuntime` + `useRemoteThreadListRuntime` with SDK `createTheoremChatAdapter` | `src/lib/theorem/runtime.tsx` (`chatAdapterFor`) |
| Identity: durable `threadId` (`chat.threads.*`, `revision` for `If-Match`) inside a project (`chat.projects.*`) | `src/lib/theorem/client.ts` |
| Send/edit/retry: `chat.messages.send/edit/retry {threadId, branchId, If-Match, text, uploadIds, parentMessageId, spaceContext, regime, capabilityScope, plan, contextReferences, acpBinding, model, executionMode, workspaceId, leaseId, clientOperations, clientSurface}` | `src/lib/theorem/runtime.tsx` |
| Run stream `chat.runs.events({runId, after_seq})`; `runs.cancel`; `runs.command {runId, command:'approval'\|'input'\|..., approvalId, toolCallId, decision, optionId, text, receipt}`; `runs.get/delegations/delegationContent` | `src/lib/theorem/client.ts` |
| Approvals sent by `sendApprovalDecision` | `src/components/chat/theorem-parts.tsx:450` |
| Mid-run steer = `command:'input'` | `src/lib/theorem/run-input-runtime.ts:66` |
| Terminal run events `RUN.CLOSED\|FAILED\|CANCELLED` | `src/lib/theorem/client.ts:88` |
| Send recovery in sessionStorage; transcript refreshed by polling `threads.get` every 3 s | `src/lib/theorem/send-recovery.ts` |
| `ChatContextReference` kinds: `upload\|record_view\|graph_document\|record\|space_reference\|graph_selection\|history` plus delegation (no file or range kind) | `src/lib/theorem/` |
| SDK `TheoremContextReference` (file, artifact, message, run, delegation, graph-object) used by in-memory zustand store | `src/components/chat/composer-references.tsx` |
| Composer draft: no per-thread persisted draft found | UNVERIFIED (grep) |

Smallest stable non-React interface candidate: SDK `HeadlessConversation` (`SDK/t/headless.d.ts`, `SDK/index.js:36815`).
- Constructor `{client, authority, threadId, store: ConversationStore, expectedIdentity?}`.
- Methods `connect`, `send(id, request)`, `edit`, `retry`, `command`, `stop(id, reason)`, `resumePending`, `observe`, `detach`, `subscribe(listener)`, `state`.
- State `{phase, snapshot, journal, error, projection}`; projection `{phase, terminal, parts[], approvals[]}`.
- `ConversationStore.load/save` is host-supplied and must not persist tokens.
- Errors `ConversationGap`, `ConversationProtocolError`, `ConversationIdentityChanged`.
- Not used anywhere in this repo (grep). Alternative: direct `client.chat.*`, as `runtime.tsx` does.

## 8. Artifacts and cabinet

| Fact | Source |
|---|---|
| Catalog: `GET /api/chat/v1/projects/:id/outputs?limit&cursor&q&category` via `theoremJson` passthrough (not SDK-typed) -> `ProjectOutputPage {items, total, nextCursor}` | `src/components/cabinet/organization.ts:874` (`useCabinetOutputs`) |
| `CatalogEntry` source `artifact\|upload\|review`; `revisionText` | `src/components/cabinet/catalog.ts:48`, `:34` |
| `readSource`: uploads via `readUpload(uploadContentPath(id))`; artifacts via `threads.get` stored parts through `readArtifactRevision` | `catalog.ts:122` |
| Preview cache key `${entry.key}\|${entry.source.revision}\|${mode}`; zustand `usePreviews`; concurrency 3, cache 160; `mayPublish`/`PublishGuard` guard stale results | `previews.ts:59`; `contract.ts:105,115` |
| Previews rendered by existing Rust WASM `render_preview` in `preview-worker.ts` (`@/terminal-wasm/theorem_terminal`, built from `terminal/` by `terminal/build.sh`) | `src/components/cabinet/preview-worker.ts` |
| Open original: `open(entry)`; review -> `openReview`; else `ArtifactView` at card revision or `readLatestArtifact` | `cabinet-view.tsx:409` |
| Preview preference `useAppearance.overrides.preview` (`'pixel'\|'full_fidelity'\|undefined`), localStorage `theorem-ui:appearance`; `effectivePreviewMode(preset, preference)`; `PRESET_PREVIEW` expressive->pixel, calm->full_fidelity | `src/lib/appearance.ts:12,248` |

## 9. RustyRed browser DB

| Fact | Source |
|---|---|
| `@rustyreddb/browser` 0.1.0-beta.2 (tgz in `vendor/`); `@rustyreddb/node` 0.1.0-beta.2 server-side | `package.json:106`; `src/server/desktop/workspace/index-db.ts` |
| Open: `open(directory, {controlEvents:false, keepHistory:false, shared:true, wasm, worker})` | `src/lib/blocks/app-db.ts:31-48` |
| Directory `theorem-app.<documentId>.<name>`; shared client per directory via `held` map, `users` refcount, 5 s `LINGER_MS`; Web Lock holder owns the file, other tabs reach it over BroadcastChannel; `inMemory()` for hidden runs | `app-db.ts:88` |
| API: `inspect`, `verify`, `mutate(batch)` -> `Commit {txnId, graphVersion}`, `getNode`, `getEdge`, `queryNodes`, `neighbors`, `query(cypher, params, rowCap)`, `subscribe(read, next, error)`, `owner`, `close` | package `index.d.ts` |
| Errors are `RustyRedError.code`: `database_closed`, `worker_failure`, `invalid_subscription`, `unknown_method`; wasm strings `chunk_store_browser_storage`, `chunk_store_browser_commit_state_unknown`, `chunk_store_browser_payload_too_large`, `chunk_store_journal_poisoned`, a "quota exceeded" string | package `src/*.js`, `pkg/*.wasm` strings |
| Typed durability outcome (success / quota / blocked / unavailable): none exposed. Mapping UNVERIFIED | |
| No document or local-authority use of the browser DB found in `src/lib/documents`, `src/lib/vault`, `src/lib/notebooks`; no account-switch clear found | grep |

## 10. Account preferences vs browser-local

| Preference | Scope | Source |
|---|---|---|
| `starredModels`, `defaultModel`, `generation?` | account (`GET/PUT /api/chat/v1/preferences`, `If-Match`, `revision`) | `src/lib/theorem/models.ts:274-396` |
| Layouts, `panelWidth`, `panelCollapsed`, `railOrder`, `explorerOpen`, `ideFilesOpen`, `terminalTabs`, `cabinetWidth`, active `projectId` | browser (`theorem-ui:shell`, version 9) | `src/components/shell/shell-state.ts` |
| Appearance and overrides | browser (`theorem-ui:appearance`) | `src/lib/appearance.ts:12,248` |
| Sidebar pins and session types | browser (file says per-browser until Theorem serves a route) | `sidebar-prefs.ts` |
| Arrangement presets `focus\|together\|explore` | place dockview panels; layout stored in `shell-state.layouts` | `src/components/shell/arrangements.ts` |
| Keybindings | no account-level store in the web app (Theia has its own) | grep |

## 11. Semantic inspection and agent-visible actions

| Fact | Source |
|---|---|
| Only agent-invokable UI mechanism: `clientOperations` + `clientSurface {revision}` declared on each send | `src/lib/theorem/client-surface.ts` |
| Sources: Kit (9), App check, Face (3); server limit 16 per send, description <= 1024 bytes, schema <= 8 KB; about 13 used | same |
| Reply is a `client-operation-receipt` through `runs.command` | `src/lib/theorem/client.ts` |
| `/api/observe/v1`, `/scene/v1` are proxies; `observe.ts` reads run observation, not UI state | `src/lib/theorem/observe.ts` |
| Command palette is a human cmd-K UI (models, skills, settings, threads), not agent-visible | `command-palette.tsx` |
| IDE bridge `IdeFrameMethods` (`reveal`, `openChanges`, `setFollowedRuns`) and `IdeHostMethods` over penpal | `ide-bridge.ts` |

## 12. Gap table

| # | Gap | Evidence | Spec pressure |
|---|---|---|---|
| G1 | `DocumentSession.reset` drops unaccepted local edits on an unrecognised refusal | `SDK/index.js:37237-37590` | spec: a local edit cannot vanish (R-series) |
| G2 | Two workspace identities (vault vs IDE host); only `workspaceIdOf(projectId)` ties project to host | `follow.ts:57`, `theorem-client.ts` | one environment owner needed |
| G3 | No typed unavailable-environment or unavailable-provider result; inferred from `IdeConnection`, error text, empty hover | `ide-bridge.ts:90`, `language.d.ts` | panels must show honest unavailable states |
| G4 | SDK `WorkspaceScm` has no hunk, no amend, no base/index token; hunk ops exist only in raw `scm.*` bodies (BE, deployment UNVERIFIED) | `scm.d.ts`, `BE/scm.rs:109,156,213` | hunk-level SCM needs raw `operate` or SDK change |
| G5 | `scm.status` shape differs between SDK type and BE | `scm.d.ts` vs `BE/scm.rs` | UNVERIFIED which is deployed |
| G6 | `HeadlessConversation` unused in repo; no `ConversationStore` implementation | `headless.d.ts`; grep | adapter must supply the store |
| G7 | Lazy file listing depends on host version (two response shapes) | `directory-listing.ts` | adapter normalises |
| G8 | No explicit refused/excluded/binary error code for files | `theorem-file-system-provider.ts` | UNVERIFIED in backend |
| G9 | RustyRed browser package has no typed durability outcome; no document or local-authority path; no account-switch clear | `app-db.ts`, package | quota/blocked mapping to be built or verified |
| G10 | Layouts, appearance, cabinet preview preference are browser-local; only model prefs are account-level; no account keybinding store | section 10 | cross-device state absent |
| G11 | Agent-visible UI limited to `clientOperations` (16 per send, about 13 used) | `client-surface.ts` | semantic inspection needs a contract or shares that budget |
| G12 | Composer draft not persisted; `ChatContextReference` has no file or range kind | section 7 | file/range context needs the SDK reference type |
| G13 | File system provider, SCM groups, blame, timeline, search and run polling exist only inside the Theia extension, not as reusable SDK clients | `EXT/` | adapter reimplements or extracts |
| G14 | Cabinet catalog call is untyped passthrough, not SDK | `organization.ts:874` | contract not enforced by types |
