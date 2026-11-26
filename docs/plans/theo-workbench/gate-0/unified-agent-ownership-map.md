# Unified Agent Experience: Gate 0 ownership map and contract mapping

**Companion to:** [SPEC-UNIFIED-AGENT-EXPERIENCE-1.0](../SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md), Section 13, Gate 0.
**Source read:** Theorem-UI `main` at `c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd` (the commit the spec pins). `origin/main` was still that commit on 2026-11-26, so there is no drift between the pinned baseline and current main.
**SDK read:** `vendor/theoremharness-sdk-0.6.0-alpha.10.tgz` (its `.d.ts` files and `package/fern/openapi.json`), the version `package.json` installs.
**Not read:** the Theorem backend repository, any deployed host, and any running application. Every statement below is source inspection of this repository and the vendored SDK. A row that says "exists" means the code path exists; it does not mean the deployed product behaves that way (spec Section 5.2, last paragraph).
**Inferred** marks a statement taken from the absence of a code path or from a comment rather than from code that was read.

This file is the Gate 0 deliverable. Its four parts answer the Gate 0 exit: one ownership map (section 2), an explicit contract mapping (sections 3 and 4), the agent-profile authority (section 5), and the gaps that the later gates must close (section 6). The acceptance cases are in [`acceptance-cases.json`](../acceptance-cases.json) as `UAE-AC-01` to `UAE-AC-24`. The placement amendment is recorded in the [workbench specification](../SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0.md) (Sections 0, 2 and 4.1) and in [ARCHITECTURE.md](../ARCHITECTURE.md) (Sections 1 and 11, item 3).

## 1. Layout authority after the amendment

| Rectangle | Layout owner | Source |
|---|---|---|
| Application composition: the sheet, its conversation, side panels for artifacts, notes, files, delegations and reviews | Dockview (`dockview-react`) through `DockShell` | `src/components/shell/dock.tsx:770-843` (openers installed), `:544-560` (restore), `:769-781` (save) |
| Where the workbench sits relative to the sheet: closed, full, side (drawer or docked) or bottom | `placement.ts` rules, drawn by `WorkbenchDock` | `src/components/workbench/placement.ts:5-45`, `src/components/workbench/workbench-dock.tsx:462-500`, `src/components/shell/chat-shell.tsx:458-535` |
| Panes inside the workbench | Rust `workbench-dock` over `workbench-layout` | `terminal/crates/workbench-dock/src/doc.rs:11-25`, `terminal/crates/workbench-core/src/model.rs:891-914` |

What the checkout already does: the workbench is a sibling of the Dockview sheet in the same flex row, never a replacement of the chat interior inside Dockview (`chat-shell.tsx:458-462`, `:516-535`). In full placement the sheet is hidden but stays mounted (`chat-shell.tsx:474`, `:380-381`); in side and bottom placement the core hides the workbench's own Theo group because the sheet beside it shows the conversation (`model.rs:715-752`). So ARCHITECTURE Section 1 ("mounts as one React component, `Workbench`, in place of `SheetSplit`") and Section 11 item 3 ("inside chat mode the Rust dock replaces dockview") had already stopped describing the code before this spec. The amendment brings the documents to what the code does and makes it the rule.

The two saved layouts are already independent and separately versioned, which UX-01 and OW-03 need:

- Workbench: account record `WorkbenchRecord{workspaceId, revision, schema, current?, namedLayouts?}` at `/api/workbench/v1/{workspaceId}`, saved with `If-Match` and no last-write-wins (`src/lib/workbench/layout/layout.ts:137-230`). Nested versions: record schema `theoremweb.workspace/1` (`layout.ts:22-23`), `theorem.workbench` v1 (`model.rs:33-34`), `theorem.workbench.dock` v1 (`doc.rs:11-25`), arrangements v1 (`terminal/crates/workbench-core/src/arrangement.rs:28-29`). A device checkpoint in `@rustyreddb/browser` serves only when the account record is unreachable (`layout.ts:94-167`).
- Dockview: local only, inside the zustand store `theorem-ui:shell` at store version 10 (`src/components/shell/shell-state.ts:306`, `:323-347`). The Dockview JSON has no schema field of its own, and most migrations drop saved layouts (`shell-state.ts:367-387`).
- Terminal bindings are kept apart from both, per browser tab in `sessionStorage` (`src/components/workbench/workbench.tsx:622-680`), which already matches OW-04's "input ownership and temporary focus remain local".

Gap for Gate 2: the Dockview layout has no versioned schema or account copy, so "independent saved layout versions" (spec 5.2, first row) holds only for the workbench half.

## 2. Owner operations inventory

Each row names the operation Gate 0 asked about, its current owner, what exists, and what the later gates must add. Spec IDs are the requirements the gap blocks.

### 2.1 Run listing

| | |
|---|---|
| Owner today | Theorem chat runs, reached through the SDK. No owner lists runs. |
| What exists | Per-run reads only: `GET /api/chat/v1/runs/{runId}`, `/events`, `/cancel`, `/delegations`, `/delegations/{id}/content` (openapi paths). `RunSnapshot{runId, threadId, status (string, no enum), terminal, actor, events, nextAfterSeq, hasMore, ...}` (openapi `RunSnapshot`). Per thread, `Thread.activeRunId`, `activeRunCursor` and `lastRun` on `GET /api/chat/v1/projects/{projectId}/threads` (openapi `Thread`), used at `src/lib/workbench/threads/threads.ts:124`. The session graph (`src/lib/theorem/sessions.ts:105-124`) gives `activeRunId` per node by polling. Delegations: polled with `chat.runs.delegations({runId: parentRunId})` every 2 s while live (`src/lib/theorem/delegations.ts:166-187`). |
| Page-local correlation | `createSessionWatch` keeps a `Map<session, {runId, what, last}>` in memory (`src/lib/workbench/agent/sessions.ts:29-47`). A later run that acts on the same session overwrites `runId` (`sessions.ts:42-47`). It is cleared when the adapter retires (`src/lib/workbench/adapter.ts:1425-1426`, `:1588-1589`). `useLiveRuns` is another in-memory thread-to-run map (`src/lib/theorem/runtime.tsx:154-159`). |
| Not a run | `RunHandle`, `RunSummary` and `IdeRunList` are host program runs (`run.list`), not agent runs (SDK `src/run.d.ts:8-31`). The word "run" is overloaded; Gate 1 should name them apart. |
| Gap | No project- or workspace-scoped run inventory exists in SDK alpha.10. One run per thread is visible; delegation child runs, side-chat runs and terminal sessions are not. **Blocks OW-02, AC listing in UAE-AC-01 and UAE-AC-02.** The inventory endpoint belongs to the Theorem backend; this repository can only consume it. |

### 2.2 Resource reads

| | |
|---|---|
| Owner today | Each resource's owner, through the adapter (`ARCHITECTURE.md` Section 5); the agent reads the workbench through `workbench.read`. |
| What exists | `workbench.read` returns the semantic tree (`SemanticTree{root, nodes}`, `terminal/crates/workbench-core/src/semantics.rs:152-265`; `src/lib/workbench/wire/Node.ts`) or the action catalog, bounded to 40,000 bytes with paging (`src/lib/workbench/agent/operations.ts:19`, `:223-287`). Each node carries `binding: ResourceRef` and `revision?`. A terminal node carries the last 60 screen rows as text and the cursor cell in its description (`terminal/crates/workbench-process/src/semantics.rs:1-9`, `:169`, `:225-245`). Results carry `ReadAt{workspaceId, version?, epoch?, generation}` (`terminal/crates/workbench-core/src/results.rs:53-63`). |
| Gap | Layout structure and resource content are one read (the tree), which API-02 asks to separate where snapshots get expensive. The terminal read has no distinction between emulated screen and raw output log (API-03), and no observation time. `workbench.read` needs the mounted workbench: when it is closed the answer is `{shown:false, hint}` (`operations.ts:385-394`), so headless inspection (API-04) is absent. |

### 2.3 Reveal and open beside

| | |
|---|---|
| Owner today | Two separate mechanisms, one per layout owner. |
| What exists | Dockview side: six opener stores, each with its own id prefix and helper, all installed by `DockShell` (`dock.tsx:85-106`, `:568-589`, `:770-843`): `useArtifactView`, `useNoteView`, `useWorkspaceFileView`/`openWorkspaceFile`, `useFileDock`, `useDelegationDock`, `useReviewDock`. None reaches the Rust workbench. Workbench side: focus-intent actions (`files.focus`, `theo.focus`, `changes.open`, `cabinet.open`, and others, `terminal/crates/workbench-core/src/builtin.rs:89-340`), layout actions (`workbench.focus.*`, `workbench.move.*`, `workbench.maximize`, `workbench.layout.*`, `builtin.rs:450-527`), the page's `workbench.open` with `placement: side | bottom | full` (`operations.ts:97-109`, `:397-410`), and follow-the-agent, which shows edited documents for followed runs without taking the keyboard (`terminal/crates/workbench-core/src/update.rs:1854-1890`). |
| Gap | No typed reveal command takes a resource reference and a client. `workbench.act` takes an action id and a panel node id (`terminal/crates/workbench-core/src/agent.rs:31-42`); the actor carries only `run_id` (`terminal/crates/workbench-core/src/ids.rs:269-275`). **Blocks CP-02, CP-03, API-10, UAE-AC-03 and UAE-AC-08.** The six Dockview openers and the workbench focus actions should resolve through one reveal entry point; Gate 2 owns that. |

### 2.4 Terminal detach, kill and control

| | |
|---|---|
| Owner today | The workspace host's terminal provider (Herdr Core or native), through SDK `TerminalChannel` and `ide.terminal.*` (`ARCHITECTURE.md` Section 7). |
| What exists | `open` with an `operation_id` reused on retry (`src/lib/workbench/terminal/session.ts:291-373`), `attach` (`:379-397`), `input`/`inputBytes` with a 256-entry input-id ledger (`:24-25`, `:409-455`), `resize` (`:498-520`), `detach`, which closes the view's attachment and leaves the program running (`:540-555`), and `kill`, refused unless the host advertises `terminal.kill` (`:557-584`). Closing a process pane emits `TerminalDetach`, never a kill (`terminal/crates/workbench-process/src/panel.rs:1314-1323`); ending is `shell.end`, and its confirmation is human-only (`terminal/crates/workbench-process/src/lib.rs:77-79`). Three version fields are kept apart: stream epoch, binding epoch and program generation (`session.ts:30-47`; `src/lib/workbench/wire/TerminalOpened.ts`). |
| Control today | No input-control claim. The lease was removed on 2026-11-16 (`ARCHITECTURE.md` Section 7): "Every view may type, paste and resize, so no role is asked for" (`src/lib/workbench/terminal/host.ts:80-85`). Fencing that remains: binding epoch, attachment-name supersession (`session.ts:611-634`, `:907-921`) and input-id dedupe. A host refusal other than `stale_epoch` is flattened to `failed` (`src/lib/workbench/terminal/wire.ts:257-268`). PTY size follows the most recently focused view (`terminal/crates/workbench-process/src/panel.rs:1185-1195`; `bound.rs:596-625`). |
| SDK still has the lease | `IdeTerminalAttach.role` (`controller | observer`) with `generation`, `IdeTerminalControl{role: controller | observer | unleased, generation, epoch}`, and `IdeTerminalListRow.controlled` (SDK `IdeTerminalAttach.d.ts:15-33`, `IdeTerminalControl.d.ts:1-16`, `src/terminal.d.ts:13-50`). Inferred: the UI acts as an unleased client. |
| Gap | IN-02, IN-03 and API-05 need exactly the controller claim with fencing that was removed nine days earlier. This conflicted with R28. **Decided 2026-11-26 (section 7, decision 1): no lease.** R28 stands for the person's own views; the claim that remains to build is the agent's, arbitrated against the person's input. The SDK's controller role may carry that agent claim (inferred from the SDK types; the host was not read). Also: the adapter ignores the claim payload on `terminalDetach` (`adapter.ts:1042-1043`). |

### 2.5 Side-chat lifetime

| | |
|---|---|
| Owner today | A second assistant-ui runtime per side chat, mounted as a React `Host` inside the workbench's `Hosts` (`src/lib/workbench/conversation/side-chats.tsx:19-50`). |
| What exists | The runtime lives above the panel, in `Hosts`, not in the pane. Closing the side-chat panel in the core does not touch the run: the Theo panel has no `teardown` (`terminal/crates/workbench-core/src/panel.rs:825` is the default no-op), and `ConversationSideClose` is declared (`terminal/crates/workbench-core/src/effect.rs:291`) but no panel emits it outside tests (inferred from the search). The core's own rule is that stopping a run is destroying and closing a view must never do it (`builtin.rs:131-133`). |
| Where cancel happens | Unmounting the `Host` cancels a running turn: `return () => { if (runtime.thread.getState().isRunning) runtime.thread.cancelRun() }` (`side-chats.tsx:45-50`). That fires on `SideChat.close` through the port's `conversationSideClose` (`src/lib/workbench/conversation/port.ts:168-178`, `conversation.ts:1674-1681`), on `Conversation.dispose` (`conversation.ts:1840`), on a project change (`workbench.tsx:507-517`, `:783-790`), and when `Workbench` re-keys on `route.projectId` (`chat-shell.tsx:526-531`). Hiding the workbench does not unmount it (`chat-shell.tsx:430-436`). |
| Identifiers | `SideChatInfo{conversationId, scope, from?, threadId?}` (`conversation.ts:406-413`). A fresh side chat starts as a local `side-<uuid>` until its first turn (`side-chats.tsx:102-109`). The list is session-local and empty after reload (`conversation.ts:329-334`). Streaming resumes by re-reading from `after_seq: 0` (`runtime.tsx:262-283`); only delegations resume after the last seen sequence (`delegations.ts:194-223`). |
| Gap | The spec's 5.2 row ("side-chat cleanup currently cancels a running turn") is correct for the `Host` unmount, and the Close-view path is safe only because it is never wired. Two defects follow: a project switch cancels running side chats (violates UX-02, IN-06), and a closed side-chat panel leaves a running chat with nothing to reopen it after reload (violates OW-02). **Gate 1 fix:** move the side-chat run under an owner that survives `Hosts` (the harness run itself, reached by run id), make the `Host` cleanup detach instead of cancel, and keep `theo.stop` as the only cancel. |

### 2.6 Artifact resolution

| | |
|---|---|
| Owner today | The mounted thread's messages. |
| What exists | `TheoremArtifact{partId, artifactId, revision, patchSequence, lifecycle, runId?, sourceTool?, payloadRef?, documentId?, documentPosition?}` (`src/components/artifacts/artifact-model.ts:16-107`). Content comes from `useAuiState(s => s.thread.messages)` (`artifact-model.ts:191-231`); the panel returns nothing without it (`artifact-panel.tsx:49`, `:67-68`) and the dock removes every artifact panel when the thread changes (`dock.tsx:846-861`). The cabinet fetches one named thread and scans its parts (`src/components/cabinet/catalog.ts:158-187`). The project outputs index `GET /api/chat/v1/projects/{projectId}/outputs` returns `ChatProjectOutput{outputId, kind, threadId (required), artifactId?, revision (untyped), revisionCount, ...}` (openapi; `src/lib/theorem/organization.ts:159-181`, `:870-906`). An App's source is a document resolvable by `documentId` without a thread (`src/lib/theorem/apps.ts:37-148`, `:221-228`). |
| Existing plan that owns this | [PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18](../../durable-artifacts/PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md), decision 1: "Thread messages reference the artifact; they do not own its identity", and decision 3: "Do not introduce a second artifact registry". Its checklist items `rd-reuse-reopen-transfer` and `r19-single-owner` are `partial` (`../../durable-artifacts/checklist.json`). AR-01 and AR-02 should be delivered as that plan's items, not as a new mechanism. |
| Gap | No `(workspace or project, artifactId, revision selector)` to content read exists in the UI or SDK. The outputs index has an untyped `revision` and requires a thread. No parent revision, and the per-part `runId`/`sourceTool` provenance is read but unused (inferred from the search). **Blocks AR-01 to AR-03, UAE-AC-13.** Backend work. |

### 2.7 Artifact runtime attachment

| | |
|---|---|
| Owner today | The assistant message's React subtree. |
| What exists | The live App runs in the answer: `ArtifactMessage` to `InlineArtifact` (a `<dialog>` that becomes modal for expansion without remounting, `src/components/artifacts/inline-artifact.tsx:48-111`) to `DocumentApp` to a `BlockFrame` iframe (`src/components/blocks/document-app.tsx:211-345`, `:541-556`; `src/components/blocks/block-frame.tsx:152`). The docked panel refers back rather than starting a second runtime (`artifact-panel.tsx:75-77`, `:131-135`, guard from PR #128); `ArtifactReferrer` focuses the inline dialog by DOM query or switches to chat and polls for it (`src/components/artifacts/artifact-referrer.tsx:19-56`). The cabinet's Open latest uses the same guard (`src/components/cabinet/original-view.tsx:134-135`). |
| Other frames | A pinned older revision runs its own `PinnedAppFrame` by design (`artifact-panel.tsx:137-145`); the landmark preview mounts one non-interactive (`app-revision-frame.tsx:202-230`), and the referrer's own comment says a preview frame re-runs App startup (`artifact-referrer.tsx:10-11`); scenes mount a sandbox in the reply and another in the panel, and declare no live session, so the guard does not cover them (inferred, `artifact-renderers.tsx:181-210`, `artifact-registry.tsx:154-158`). |
| Gap | No runtime owner with attach and detach. The dock cannot host the live App, only refer to it. **Blocks AR-08 to AR-12, UAE-AC-14.** Keep the referral guard until a runtime host above the message exists (spec 5.2, fifth row). |

## 3. Contract mapping: Section 6 entities

| Spec entity | Existing identifier | Where | Status |
|---|---|---|---|
| Agent | None in the UI. Server-side candidates not consumed by the UI: `Organization{organization_id, agent_id, revision, front_role, content_hash, roles[]}` at `GET /v1/theorem/organization`; `OrganizationRole{role_id, purpose, capabilities, lifecycle, model, ...}`; `AcpAgent{agentId, label, available}`; `DelegationRecord.role_id` and `organization_revision` | openapi schemas; nothing in `src/` calls them (inferred from the search) | **Gap.** See section 5 |
| Run | `runId` string: `Actor.agent.runId` (`ids.rs:262-275`), message metadata `theoremRunId` (`operations.ts:133-145`), `DelegationPart.childRunId`/`parentRunId` | wire `Actor.ts`; SDK `DelegationPart.d.ts` | Partial. No agent or configuration revision on a run in the UI's wire; no lifecycle enum (`RunSnapshot.status` is a string); `RunEnding` = `completed | failed | stopped | ended` and `DelegationState` (nine values) are the only enums |
| Work session | No unified type. Fragments: `ResourceRef.project`, terminal `session`, side-chat `conversationId`, `SessionNotice{runId, session}` (client only), server `AcpSession{agentId, sessionId, projectId, workspaceId, threadId, activeRunId}` (unused) | `ids.rs:84-145`; `sessions.ts:12-21` | Reuse the project/workspace scope, as the spec allows. No new type needed for the first release |
| Resource | `ResourceRef`, 12 variants: none, workspace, document, repository, terminal, conversation, project, directory, commit, revision, untitled, delegation | `terminal/crates/workbench-core/src/ids.rs:84-164`; `src/lib/workbench/wire/ResourceRef.ts` | Mostly present. **Missing: an artifact variant.** A document is keyed by path (`ids.rs:90`), so a move changes the reference. `delegation` carries no workspace |
| Artifact revision | `TheoremArtifact.revision` and `patchSequence` (UI only); `Revision::Opaque` is reserved for it (`ids.rs:204-223`); App source `DocumentRevision{position, contentDigest}` (`apps.ts`); reviews carry `{artifactId, artifactRevision}` (`src/lib/theorem/reviews.ts:20`) | as listed | Partial. The workbench's artifact wire types `ArtifactEntry{key}`, `ArtifactRead{key}`, `ArtifactContent{key, text}` carry no revision (`terminal/crates/workbench-core/src/completion.rs:955`). No parent revision or author provenance |
| Runtime instance | Terminal: `program` incarnation plus `streamEpoch` and binding `epoch` (`TerminalOpened.ts`). Host: `ReadAt` and `WorkspaceIdentity.generation` (`ids.rs:244-251`). Artifact: none | as listed | Present for terminals only. **Gap for artifacts** |
| View instance | `PanelInstanceId` (`p{n}`, minted by the core and never reused, `model.rs:801-812`); dock `PanelId` and `GroupId` (`workbench-dock/src/types.rs:7-14`); pane rebinding `Generation` (`ids.rs:225-237`) | as listed | Present in the workbench. `PanelInstanceId` has no generated TS type; it reaches TS only as `AgentOutcome.panel?: string`. Dockview panel ids are string prefixes with no generation. The comment at `ids.rs:37-38` says the dock mints it; the code shows the core does |
| Client | None. Nearest: the terminal attachment name `{load_nonce}.{panelInstanceId}.{binds}.a` (`workbench-process/src/panel.rs:230-245`; `catalog.rs:41-50`), `LayoutSource 'device'`, the per-tab `sessionStorage` key | as listed | **Gap.** API-04 and API-10 need a client identity on requests and effects |

### 3.1 Section 8.2 command classes

| Command class | Existing command | Gap |
|---|---|---|
| List / inspect / subscribe | `workbench.read` (tree, catalog); terminal `list` gated on `canList` (`host.ts:117-122`) | No run list; no subscription for agents |
| Reveal / open beside / expand / restore | Focus actions, `workbench.maximize`, `workbench.open {placement}` | No resource-targeted reveal, no client target |
| Create view / close view | Panel open and close in the core; close detaches for terminals (R29) | Close of a side chat is unwired (2.5) |
| Start assignment / start terminal / run artifact | `terminalOpen` with `operation` (`effect.rs:855`); `code.start` with `theorem`, `claude`, `codex` (`terminal/crates/workbench-core/src/panels.rs:36-52`) | No artifact run command; no operation id on assignment start in this repo |
| Message agent | `ConversationSend.clientMessageId` | Recipient is the conversation, not an agent; no visible per-target draft store beyond the conversation's own (IN-01) |
| Take / release terminal control | None (lease removed) | Agent claim only, no view lease (decision 1) |
| Terminal input / resize | `terminalInput`, `terminalResize` with epoch and attachment | No owner-issued claim |
| Edit / commit artifact | App `saveSource` through the document with a revision guard (`apps.ts`) | Apps only |
| Pause / resume / stop | `theo.stop` emits `ConversationCancel` (`builtin.rs:131-133`); `chat.runs.cancel` | No declared child scope, no list of affected run ids (IN-06) |
| Envelope (API-05, API-07) | `Effect{id, kind, resource, revision?, generation?, payload}` and `Completion{..., outcome: Accepted | Refused | Uncertain | Failed}` (`ARCHITECTURE.md` Section 3); refusal codes `unknown_action | human_only | unavailable | unknown_panel | empty_run | invalid_args` (`agent.rs:17-27`) | Closest match in the repo. Add client identity and an `ambiguous_target` outcome with candidates (API-06) |

## 4. Registries

There are two registries today and the spec forbids a third (spec 9.3, durable-artifacts decision 3):

- **Artifact contribution registry** (TypeScript, a projection of `theorem-surface-contracts`' `artifact.rs`): `ArtifactContribution{id, provider, label, matches, presentations[], locators[], caption, followsTheme}`, presentations by distance with `session` and `cost` (`src/lib/artifacts/contributions.ts:11-74`). Actions, minimum size and lifecycle live in side tables: renderer flags (`artifact-registry.tsx:216-267`), `SOURCES` (`:301-384`), a hard-coded check in `save-as-page.tsx:80-81`, and the dock's `minimumWidth: 400` (`dock.tsx:582`). `readContribution` exists but nothing calls it (`contributions.ts:302-307`).
- **Workbench panel registry** (Rust): `PanelDescriptor{kind, version, title, icon, body, binding, actions[], requires, min_size, default_placement, theme_roles, semantic_role}` and `Presentation{kind, shows, extensions, default}` with "Show as" (`terminal/crates/workbench-core/src/registry.rs:323-401`, `presentation.rs:1-200`). Only editor and Markdown presentations are declared, both for documents (`terminal/src/workbench.rs:92-108`), and a revision-pinned document is excluded (`presentation.rs:44-46`).

Recommended direction for Gate 3: extend the contribution registry with actions, minimum size, attachment mode and lifecycle (spec 9.3), and let the workbench's `Presentation` declare an artifact resource kind that resolves through it. The workbench registry stays the placement and action owner; the contribution registry stays the renderer owner. Neither is duplicated.

## 5. Durable agent definition and profile authority

**Finding: no durable agent profile authority exists in this repository, and none is consumed from the SDK.** Gate 3 cannot assume one.

What exists, by kind:

- Durable server records with an API, none used by the UI: `Organization` (revisioned and hashed roles under one `agent_id`, no name, description, representation or instructions), `AcpAgent` (an external-agent catalogue entry with a label), and the life agent's `{agent_name, user_display_name}` (`src/components/program/life-panel.tsx:49`, `:195-204`).
- Client-side settings: the Theo face is a code constant (`src/lib/face/identity.ts:5-32`) with performances in `localStorage` (`src/lib/face/book.ts:734-908`); model picks are per person, synced to account preferences (`src/lib/theorem/models.ts:238-305`).
- Run-scoped labels: a specialist's name is `DelegationPart.roleLabel`, shown as text and never used as a key; `roleId` exists on the wire and the UI ignores it (`delegations.ts:35`; `src/components/shell/dock.tsx:232-234`; `src/lib/workbench/threads/threads.ts:129`). Terminal execution profiles key on a display title (`src/lib/workbench/terminal/terminal-profile.ts:16-36`) and are not agents (ID-01).
- The page-local session watch (`sessions.ts`) is not an authority, as the spec says.

**Proposed owner:** the Theorem backend's organization service, by extending the existing `Organization` record rather than adding a parallel registry. It already has the properties AG-01 and ID-02 need at the record level: a durable `agent_id`, a `revision` and `content_hash`, and roles with capabilities and model bindings, and `DelegationRecord` already pins runs to `role_id` and `organization_revision`, which is ID-02's "run records retain the profile/config revision under which they started". What it lacks is the profile itself (name, description, representation reference, user-authored characteristics, working preferences, instruction references), a per-agent identity for more than one agent per organization, and copy with lineage. Storage follows DB-01 and DB-02: the definition role in the host's Rusty Red store, separate from the execution journal. This repository's part is a typed client and a profile read, never an owner of the record. The face constant and the `localStorage` book stay presentation; a representation reference in the profile points at them.

**Decided 2026-11-26 (section 7, decision 2): extend `Organization`.** The backend was not read, so whether the record can carry more than one agent per organization is the first thing Gate 3 checks; if it cannot, that is a backend change to the record, not a separate agents resource.

## 6. Top gaps, in the order the gates meet them

1. **No project-level run inventory** (2.1). Backend endpoint needed before OW-02 or any "All work" scope. Gate 1.
2. **Input-control claim removed** (2.4). Conflicts with IN-02, IN-03 and API-05. Gate 1; decision 1 settled it as an agent claim with no lease.
3. **Side-chat cancel on `Host` unmount; closed side chats orphaned** (2.5). UI-only fix. Gate 1.
4. **No client identity and no resource-targeted reveal** (2.3, 3). Gate 2.
5. **Artifacts resolve only from a thread; no runtime owner** (2.6, 2.7). Backend read plus a UI runtime host; tracked by the durable-artifacts plan. Gate 3.
6. **No durable agent profile** (5). Backend. Gate 3, on the extended `Organization` record (decision 2).
7. **Dockview layout unversioned and device-only** (1). Gate 2.
8. **Acceptance ID collision.** The workbench already uses `AC-01` to `AC-62` and `R01` to `R48`. The companion's cases are recorded as `UAE-AC-01` to `UAE-AC-24`; the companion's own requirement IDs (UX-, CP-, DR-, WS-, IN-, ID-, OW-, ST-, EV-, RC-, API-, AR-, AG-, DB-, PT-, UI-) do not collide and are kept.

Smaller source inconsistencies found on the way, left for the owning gate: `session.ts:1161-1165` says the host has no list or adopt operation, which `host.ts:117-122` and `adapter.ts:572-650` contradict; `ids.rs:37-38` says the dock mints `PanelInstanceId`, which `model.rs:801-812` contradicts; test fixtures still use the removed `role: 'controller'` (`src/lib/workbench/terminal/fixtures/herdr-wire.ts:48-51`).

## 7. Decisions (settled 2026-11-26 by the owner)

The question each decision answered is kept so later readers see what was weighed.

1. **Terminal control: no lease.** The question was whether to restore the controller lease the workbench removed on 2026-11-16, or amend the companion. The owner chose no lease because leases have caused too many problems. R28 stands; the companion's IN-02 and IN-03 are amended (spec Section 4, the decision paragraph after IN-03) so that control is arbitrated between the person and agents, with an owner-issued agent claim and no timed expiry. `UAE-AC-07` is restated to match.
2. **Agent profile owner: extend `Organization`.** The alternative was a separate agents resource in the backend. Gate 3 first confirms the record can hold more than one agent per organization.
3. **Acceptance IDs: keep the `UAE-` prefix.** The alternative was renumbering as `AC-63` onward.

## 7a. Gate 1 status (2026-11-26)

| Gap | What Gate 1 built | Still open |
| --- | --- | --- |
| 2.4 input control | `workbench-process/src/control.rs`: one agent claim per terminal (`code.claim`, `code.release`), granted to the run that `code.start`s it; the person's key or paste stops agent input until `shell.hand_back` (human only); a rebind fences old claims by epoch; a claim ends when its run leaves the page's working runs. No lease, no timed expiry (decision 1). Agent actions that name no panel are refused as `AmbiguousTarget` when more than one panel fits, and Create, Start and Destroy honour `on`. | Only one browser client is modelled: claims live in the page, not with the terminal host, so a second client does not see them. Host-side claims need the terminal host. |
| 2.5 side-chat lifetime | Close, a project switch and a `Hosts` unmount detach (stop reading, never cancel). Only the side chat's own Stop cancels. A closed side chat with a stored thread is kept in session storage and listed as detached; the picker reopens it on its own thread (`SideChatOpen.reopen`), resuming a live run through history. | The record is per browser tab session. A thread-level "side chat of" mark in Theorem would let any client list them. |
| 2.1 run inventory | `src/lib/workbench/activity/`: a read model with per-resource ordering, dedupe by source, resource, epoch and seq, gap handling that waits for a snapshot, stale observation, and view generations against late results; an inventory from the organization read, terminal listings, side chats and delegations that always states its gaps. | Theorem has no project-wide run list (backend). Nothing mounts the activity view yet; Gate 2's drawer is its first surface. |

## 7b. Gate 2 status (2026-11-26)

| Gap | What Gate 2 built | Still open |
| --- | --- | --- |
| 2.3 reveal and surfaces | `src/components/activity/activity-view.tsx`: one arrangement shown as a compact preview above the composer, a bottom or right drawer, and an expanded full view, opened from the command palette (Agent activity). Open work navigates to an existing thread or shows the workspace; it never launches. The view sits inside the sheet frame, ends above the measured composer, goes inert with the sheet, and returns focus to its opener on close. | The compact entry is TSX, not the spec's Ratatui component. Expand shows the view's own full layout, not the Rust workbench with the same selection. No agent-initiated reveal, pinning or comparison split yet. |
| 2.1 run inventory, mounted | `use-activity.ts` reads the organization always and, while the view is open, the workspace's own terminal listing and side-chat record, lent through `sources.ts` while the workbench is mounted. `arrangement.ts` keeps insertion order, saved manual order and removals per project and scope, leaves finished work in place marked as no longer listed, and never moves the selection on an owner event. | Delegated runs are not listed (they are read per run). Without the workbench mounted, terminals and side chats are absent, and the view says so. |

## 7c. Gate 3 status (2026-11-26)

| Gap | What Gate 3 built | Still open |
| --- | --- | --- |
| 5 profile authority | Theorem (Theoremrs/Theorem#1176): `OrganizationDefinition` gains an optional `profile` (name, representation, description, characteristics, working preferences, instruction references), validated and bounded, saved through `PUT /v1/theorem/organization/profile` with an expected revision and a 409 on a stale save. Changing it bumps the organization revision and leaves roles and models alone, so running work keeps the version it started with (AG-04). Here: `src/lib/theorem/agent-profile.ts` reads and saves it, `agent-profile-dialog.tsx` edits it (command palette, and the agent's name in the activity drawer). | The record still holds one agent per organization; more than one, and copying with lineage, are not modelled. Runs do not read working preferences yet. |
| 2.6 artifact view state | `artifact-view.ts` records each panel's view as separate choices: follow the newest, the revision shown when not following, and keep open across chats. A chosen revision stays fixed while newer ones arrive, with a quiet "Newer version" action. | One view per artifact (the panel id is the artifact id); two views of the same artifact side by side are not possible. |
| 2.6 reopen after changing chats | A kept panel survives a chat change and a saved layout, records its origin conversation on the panel, and reads revisions from it (`readArtifactVersions`). A live App there refers to its answer and goes to that chat. | The runtime host (AR-08 to AR-12) is not built: a live App still runs only in its answer, as the referral guard requires. |

## 8. Overlap note

A separate local working session titled "Extensible connected workspace spec" may cover some of the same ground. It was not readable from here; compare before Gate 1 starts.
