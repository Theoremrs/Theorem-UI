# SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0

**Title:** Theo Web — Modular Terminal Workbench, Connected Editors, and Persistent Herdr Terminals  
**Version:** 1.0  
**Date:** November 14, 2026 (America/Detroit)  
**Status:** Implementation specification derived from the agreed direction; implementation and product acceptance are not complete  
**Primary product/repository:** Web-based Theo in Theorem-UI / theorem.rs  
**Supporting repository:** Theorem, only for existing service integration and required capability/SDK repairs  
**Explicitly deferred:** Native Theo, Platinum UI, native docking, native packaging, and mobile-native clients

## 0. Reading order and authority

This specification delivers the web Theo/IDE workbench as a modular Ratatui application rendered through Ratzilla, shown as a revealable major surface of the web application with its own inner layout. It is **not a native Platinum project**. Host-side work required to make the web client function is in scope; building a desktop client is not.

Read this specification with [technical requirements](technical-requirements.md), [Herdr integration and lifecycle](herdr-integration.md), and [acceptance cases](acceptance-cases.json). [Source evidence](SOURCES.md) distinguishes user decisions, inspected code, upstream documentation, and unverified integration assumptions. [Handoff instructions](START-HERE.md) describe the first implementation gate.

The previous [Artifact Cabinet specification](../artifact-cabinet/SPEC-THEOREM-ARTIFACT-CABINET-1.0.md) and its procedural-preview methodology are included unchanged. This work changes the cabinet's placement/host: it becomes a registered workbench panel. Its representation, revision, connectivity, and theme requirements remain binding. The cabinet mockup is not an approved whole-workbench mockup.

The supplied [Codex tool-picker screenshot](visual-reference/codex-tool-picker.png) is an interaction and hierarchy reference. It establishes visible named choices and shortcut hints, not a required copy of Codex's exact colors, metrics, shortcuts, or branding.

The user's settled choices take precedence over earlier exploratory suggestions. The list below records those choices; the specific Herdr layout extraction is this specification's supporting architectural selection:

- Deliver a terminal-native workbench as a major surface the web application reveals beside, under or over the conversation sheet; retain Theorem's outer application navigation and its Dockview composition (amended, see below).
- Retire Theia for this work, after migrating its real capability consumers; no permanent second IDE.
- Port ELY's Markdown experience to Ratatui. Use ELY's simpler Changes/Git interaction model as the initial presentation, supplemented by existing Theorem operations.
- Use useful OpenIDEA implementations selectively beneath Theorem's SDK; do not import another full application/authority.
- Use Codex as a behavioral reference, and reuse suitable licensed code directly when this reduces work without importing its runtime ownership.
- Use the existing Herdr Core integration for persistent shell/external-agent execution; do not forget it during Theia removal. Use the original Herdr TUI’s Ratatui layout module as the starting donor for split/focus/resize mechanics, without importing its full runtime.
- Preserve immediate local editing and use the existing RustyRed WASM initiative rather than creating another local database system.
- Default to files at left, Theo and its composer centrally, tools at right; make the entire composition customizable.
- Use a real composer with a hollow terminal-style caret and an inverse Theo appearance.
- Preserve theme-responsive terminal styling and the cabinet's coordinated Flexoki-derived policy. No purple/gold preference.
- Yazi is not a dependency of this workbench. This spec does not authorize deleting unrelated Yazi integrations or user data.

The technical-requirement IDs are the canonical acceptance obligations. Narrative examples explain them; they do not create a second implementation or substitute for tests.

**Placement amendment (2026-11-26).** [SPEC-UNIFIED-AGENT-EXPERIENCE-1.0](SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md) Section 5.1 changes where the workbench sits; it does not change what the workbench is or any requirement below. Dockview owns general application composition: the sheet, the conversation and the panels it places beside them. The Rust workbench is one major surface that Dockview's shell reveals, and the Rust `workbench-dock` owns every pane inside that surface. Each rectangle has one layout owner (UX-01). This replaces the earlier statements in Sections 0, 2 and 4.1 that the workbench replaces the chat interior, including its Dockview composition. The checkout already drew it this way when the amendment was recorded (`src/components/workbench/placement.ts`, `src/components/shell/chat-shell.tsx`; see [the Gate 0 ownership map](gate-0/unified-agent-ownership-map.md) section 1). Entering from agent activity opens the selected-agent composition of the companion's Section 3 by default; Files, Changes, editors, conversation and the tool picker remain registered workbench presentations and deliberate layouts. Theia retirement and its parity obligations (Section 15, R43, R44) are unchanged: this does not restore a permanent second IDE.

## 1. Product outcome

A person opens Theo in the browser and works in a coherent terminal-native environment. They can converse with the agent, browse the actual workspace, inspect or edit Markdown/code, review Git changes, run a shell or external coding agent, and browse artifacts. They can rearrange those capabilities without losing documents, drafts, running programs, or context.

The experience is agent-first, not agent-only. A person can intervene directly, select source text, make a correction, inspect results, and continue talking. The workbench remains useful without requiring an IDE's full menu and panel inventory to stay visible.

**Core invariant: durable work and accepted operations outlive their views.**

A browser pane, an editor session, a conversation, a task/run, and a Herdr process are distinct identities. The UI never treats creating or closing one as implicit permission to create, kill, or recreate another.

## 2. Scope boundary

### In this release

Deliver the web workbench, composable panel registry and dock, tool picker, file browser, source editor and ELY-derived Markdown modes, Changes panel, agent composer/transcript, terminal viewing/control over the existing host, Herdr profile/adoption/reconnect behavior, artifact cabinet integration, local draft continuity, semantic inspection, theme/accessibility behavior, and Theia retirement.

The existing TanStack application still owns routing, login, application navigation, and browser integration, and Dockview owns the composition of the application's major surfaces (amended, Section 0). Ratzilla renders the workbench surface and its inner panes. A thin JavaScript/TypeScript adapter connects browser APIs and the existing Theorem SDK to the Rust workbench. Do not rebuild the surrounding website or authentication in Rust.

### Not in this release

Native GPUI/Platinum views, a new desktop app, a native dock, a new model harness, a universal terminal emulator, a full OpenIDEA deployment, another document/database authority, automatic laptop-to-cloud process migration, an arbitrary plugin marketplace, all VS Code extensions, and a fresh Yazi integration.

Preserve future reuse through renderer-independent messages and models where natural. Do not turn future portability into a prerequisite to delivering the web client.

The complete web workbench is the outcome. It is not an extra drawer permanently mounted beside Theia, a static mockup, or an agent transcript with nonfunctional IDE controls. Being revealable as a drawer, side panel or full surface of the application (Section 0, amendment) is how it is placed, not a reduction of that outcome.

## 3. Roles of the reused systems

| System | Selected responsibility | What it must not become |
|---|---|---|
| Theorem services and SDK | Workspace/document identities, accepted edits, capabilities, conversations, runs, SCM, language/run operations, authorization | A second set of endpoints invented independently in each panel |
| Ratatui + Ratzilla | Workbench rendering and interaction presentation in the browser | A process supervisor or automatic ANSI emulator |
| RustyRed browser integration | Local persistence/query capabilities through the established owner and document contract | An independent writer to the same files or one database per panel |
| Herdr Core | Host-side persistent terminal/process provider reached through Theorem | Another desktop UI, browser shell server, project store, or authorization broker |
| Original Herdr TUI layout module | Source donor for Ratatui split geometry, focus and resize boundaries | An imported full TUI/runtime, legacy transport, or process-spawning dock |
| ELY | Markdown and initial Changes interaction/source donor | A GPUI runtime imported into the web workbench |
| OpenIDEA | Selected capability implementation donor where a gap is demonstrated | An independently authoritative project/document/terminal host alongside Theorem |
| Codex | Agent interaction oracle and suitable component-code donor; an external execution profile when already supported | Mandatory auth, persistence, or execution ownership for the whole workbench |
| OpenAI model access | Existing configured Theorem provider path | A reason to route every message through a Codex terminal |

These are different layers, not several competing IDEs. Herdr's execution role does not replace ELY's editor or Ratzilla's rendering. Theia's removal does not remove the backend operations its frontend currently consumes. Inspected source supports these existing boundaries; deployed parity remains a release test. See [the inspected source ledger](SOURCES.md), S01–S10.

## 4. Default workspace and adaptation

### 4.1 One interior workbench

Retain the outer Theorem application rail and route/navigation contract. *Amended 2026-11-26 ([SPEC-UNIFIED-AGENT-EXPERIENCE-1.0](SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md) Section 5.1): the workbench no longer replaces the conversation sheet or its sidebar. It is revealed beside it (side, docked or drawer), under it (bottom) or over it (full), and the regions below describe the workbench's own inner layout in whichever placement it has.* Within the workbench, the workspace Files panel takes the place the conversation-oriented sidebar has in the sheet. Keep a visible way to change workspace/project and open an existing conversation; those destinations must not disappear with the sidebar replacement.

Initial layout:

| Region | Default contents |
|---|---|
| Compact header | Workspace name, execution environment, connection state, Add tool, layout controls |
| Left panel | Workspace files, quick file search, open-document indicators |
| Main panel | Theo transcript, meaningful execution activity, composer |
| Right panel group | Tool picker initially; Markdown/document, Changes, or Artifacts when opened |

A workspace with no execution environment can still show permitted local documents/conversation state. Shell/build controls explain why execution is unavailable. Never imply that a browser's local database is the remote checkout.

The initial 2:1 main/tool split is a **preset**, not an immutable geometry rule. The workbench surface is filled by the workbench in each placement. No large white page remains around an embedded terminal card.

### 4.2 Width allocation

Use measured container space after the existing outer rail and application padding. Let W be this usable width; F the Files width; M the main width; T the tool width; and G all splitters/gaps counted once. Require F + M + T + G = W for visible docked regions, within rounding tolerance.

Initial calibration targets are Files 224 CSS px, main minimum 480 CSS px, tools minimum 320 CSS px, and 8 CSS px pointer hit regions for vertical splitters. These are new product targets, not measured Codex constants; expose them in configuration and document any accepted adjustment.

When all regions fit, reserve Files and allocate the remainder approximately 2:1 to main/tools, clamped to each panel's minimum. When they do not fit, collapse Files first into an explicit drawer/tab, then show one principal panel at a time with preserved tabs rather than squeezing editors. A side-by-side diff or split Markdown editor expands or occupies the principal region when its own minimum is not met. Do not shrink typography to fit more panes.

When no tool is requested, the main pane uses the remaining space. Opening the tool picker can temporarily create an empty tool destination; simply closing it restores the previous composition. Project instructions/context remain available as a compact disclosure or tool rather than another mandatory column.

CSS-pixel layout and terminal-cell layout are distinct. Derive cell counts from actual measured cell metrics; quantize the last allocation deterministically. Preserve remainder space at the boundary rather than stretching individual cells or changing font size.

### 4.3 Dock and panel behavior

The web workbench owns one layout tree for its panes: split groups, tab groups, stable panel instances, active tabs, and normalized split ratios. **Start from the original Herdr TUI’s `src/layout.rs` (`TileLayout`), not a new tiling engine.** The inspected module already supplies a binary split tree, pane rectangles, split-border geometry, focus and insertion/removal operations. Extract/adapt the useful layout code and tests under its license into the workbench; do not import Herdr’s full Cargo dependency graph. [S19]

This is source reuse, not a claim that the module is already a packaged WASM dock. Rebind leaf identities to Theorem panel instances or tab-group containers; keep a clear mapping from any process-local numeric handles to durable account layout IDs. Adapt grouping, minimum sizes, browser pointer/keyboard events, and restore semantics to this spec. Ratatui Layout and the reused geometry are subordinate to one saved layout owner, not two independent trees.

The original TUI’s comments tie some production splitting to terminal spawning. In Theo Web, a split creates an empty panel destination or relocates an existing view. It does not spawn a process. Herdr’s desktop app also documents pane-close behavior that ends terminals; this specification deliberately uses detach-only Close view instead. Retain the geometry, not those lifecycle assumptions. [S19], [S20]

Panels can be moved, split, tabbed, expanded, restored, and hidden. All drag interactions have keyboard/menu alternatives. Modal popovers do not mutate the saved layout. A panel's resource controller survives view movement and remounting. Closing the last view must follow that resource's explicit lifetime contract, not a generic Drop/cleanup cascade.

Account preferences store named compositions, panel order, bindings that are safe to sync, appearance choices, and keybindings. Exact window sizes, transient focus, pointer positions, and physical-device adaptations remain local. Restoring an account layout on another device revalidates capabilities and adapts geometry; it does not launch referenced programs or recreate missing documents.

## 5. Tool picker and registry

Use the supplied tool-picker's labeled row hierarchy. Initial entries are Changes, Shell, Files, Side chat, New page, and More tools. Two columns appear only when labels, shortcut hints, and hit targets fit; otherwise one column. Artifacts, diagnostics, run output, and other registered panels appear in More tools and can be pinned by the user.

The picker, command palette, shortcuts, contextual open actions, and agent-visible action catalog resolve the same registrations. A descriptor names panel kind/version, factory, supported resource binding, supported actions, availability, minimum size, default placement, state serializer, theme roles, semantic roles, and required capabilities. Extend existing registries rather than introduce an unrelated catalog.

Opening a picker has zero domain effects. Entries distinguish focus/open-existing from create/start:

- Files focuses or opens the workspace browser.
- Changes opens the selected repository's actual state.
- New page explicitly creates a document through its owner, then opens it; cancelled creation leaves no orphan.
- Shell offers eligible profiles and existing sessions before starting a process. Show workspace, host, profile, and persistence meaning.
- Side chat explicitly selects or creates its conversation and context scope.
- Artifacts opens the project's authorized cabinet without a model call or terminal process.

Shortcuts are rendered from active keybindings, including remaps and platform differences. Unavailable entries give actionable reasons. Opening Shell must not silently fall back from Herdr to a native process.

## 6. Interaction architecture

Use an Elm-style Rust interaction core: **message → update → effects → completion message → view**. Modular child updates own panel-local interactions; the workspace update coordinates cross-panel actions. Mutable Rust state is permitted; copying full documents/terminal histories on every message is not required. [S13]

View rendering performs no networking, file writes, subprocess launch, document commit, or model call. Effects call the existing SDK/owner through the web host adapter. Every async result carries the resource identity, request identity, and relevant revision/generation. Stale presentation results may populate correctly keyed caches but cannot overwrite a newly bound pane.

Keep these stores distinct in meaning:

| State | Owner/lifetime |
|---|---|
| Focus, selection, panel rectangle, temporary menus | Workbench/view state |
| Draft, undo, composition, pending edits | Document/conversation controller, independent of pane |
| Last accepted document/resource snapshot | Existing resource owner and its client projection |
| Database checkpoints and permitted offline state | Existing local RustyRed/document persistence boundary |
| Remote execution, accepted Git changes, terminal bindings and the input ledger | Workspace host/services |
| Herdr process and its terminal lifetime | Herdr Core/holder on the chosen host |

Messages request actions; they are not authorization. Human and agent entry points converge on the same operation semantics while retaining authenticated actor identity. A model-generated message cannot synthesize human approval merely by naming an approval action.

The root model contains references and bounded summaries. Specialized controllers hold editor buffers, terminal screens, and histories. Coalesce redraw notifications without discarding semantic updates. Model streaming, PTY output, DB subscriptions, and editor input have separate bounded queues; none can monopolize the browser event loop.

## 7. Theo conversation and composer

### 7.1 A real agent surface

The central Theo pane displays structured Theorem conversation/run information, not a scraped external-agent terminal. Retain actual conversation history, selected conversation versions, tool results, attachments/references, approvals, cancellation, retry/recovery, and honest execution states through their existing owners.

Use Codex's interaction quality as a reference for composer behavior, streaming, tool-output disclosure, diff inspection, and approvals. Capture reference behavior before adapting code, translate it into cases, and retain upstream tests that remain meaningful. Do not assume the Codex desktop tool picker exists as an extractable open-source widget. [S11]

The foreground model choice remains a provider setting. A Codex process launched in Herdr is a separate bound external-agent session. Never send one user submission to both paths.

### 7.2 Composer

Provide multiline text, selection, clipboard, undo/redo, attachments, typed source references, visible model/context controls where applicable, and an unambiguous send/stop/steer policy. Typing and pointer interactions complete locally without waiting for HTTP or a database commit.

The hollow block caret follows the true insertion point; it is not a character inserted into the draft. It is steady during text composition/typing, blinks only while focused when motion preferences allow, and is hidden when another control owns input. Native browser IME/composition support is a host-input service, not a second editor UI. Preserve browser text selection/copy and assistive-technology access.

A shell pane accepts terminal input. The agent composer accepts a conversation message. Focus, labels, and shortcut routing make the distinction apparent; pasting a command into chat cannot execute it as shell input.

Use a terminal-appropriate inverse Theo: light outline/body treatment and dark eyes on the dark surface, adapted to effective theme contrast. Reuse Theo's behavior and expression state. Do not create another agent instance, enlarge headers to fit artwork, or apply a blind global color-inversion filter.

## 8. Files, source editing, and ELY Markdown port

### 8.1 Files and source editor

Files is a Ratatui view over the existing workspace file/search services, not Yazi. List/open/search/reveal operations resolve stable workspace/resource identities. Lazy loading, binary handling, symlinks, excluded directories, and permission refusals retain the owner's semantics. Partial cached results are labeled as partial.

A new code/source editing surface is required: reading a file alone is insufficient. At minimum preserve current workflow capabilities for cursor/selection, Unicode text input, multiline edits, search, undo/redo, saving, dirty-state display, revisions/conflicts, and the connected language actions in the parity register. Source edit state is reusable by Markdown Source mode; do not create a second text buffer implementation just for Markdown.

Source positions use explicit units. Terminal display columns, grapheme boundaries, UTF-8 byte offsets, Unicode scalars, and UTF-16 code units are not interchangeable. Convert at named boundaries and carry document revision with every semantic range. Use tests with tabs, CJK, combining marks, emoji/ZWJ sequences, CRLF, and wrapped lines.

### 8.2 Port, not wrap, ELY

Use ELY's Visual, Source, Split, and Preview experience as the selected Markdown donor. Extract reusable parsing/block/range logic where suitable; replace GPUI-specific entities, subscriptions, focus, input, and rendering with Ratatui and the shared web input bridge. Record the donor revision and changed behavior. Importing a GPUI widget unchanged is not completion. [S08]

All four modes operate on one document session. Preview derives from the current local draft so it stays immediate. Switching modes preserves source selection, undo history, scroll anchor, pending edits, and composition. Visual mode opens a selected rendered block as source for editing and maps accepted edits back to that block's document range.

Do not parse and reserialize the whole document to apply a small visual edit. Preserve untouched source, front matter, comments, whitespace, unsupported syntax, and code fences byte-for-byte where the document's normalization rules allow. Unknown constructs remain editable in Source mode; a named fallback is better than dropped content.

The inspected ELY path discards an open block edit when its source has changed. **Do not port that behavior.** Retain the user's pending text; reconcile through the document owner or show a resolvable conflict with both revisions. A local edit cannot vanish because a model or another pane wrote first. [S08]

Support ordinary headings, paragraphs, lists, checkboxes, links, quotations, fenced code, tables, and source fallback. Rich diagrams/images can use the existing safe artifact/full-view path rather than requiring pixel-perfect graphical reproduction inside a character grid. No unsafe raw HTML execution or automatic remote media fetch is introduced by Markdown preview.

## 9. Changes/Git and IDE capabilities

Port ELY's compact Changes presentation into Ratatui: repository and branch context, staged/unstaged/untracked/conflicted groups, file/diff inspection, commit draft, amend, recent history, and explicit destructive-action confirmation. Its operations are rebound to Theorem's SCM contract rather than ELY's filesystem/process functions. [S09]

Preserve Theorem's already exposed branch, merge, fetch/push, blame, history, and conflict workflows through panels/commands appropriate to their frequency. Do not erase existing capability coverage simply because the first ELY view is smaller. Hunk-level controls may be exposed only when the backend actually supports revision-correct hunk operations.

Git mutations are bound to the selected environment/repository and a relevant base/index snapshot. A stale diff triggers refresh/revalidation, not applying the same visual line numbers to new content. Stage/commit operates on saved working-tree/index content; an unsaved editor buffer is not silently included. Provide an explicit save/apply step when needed. A successful commit must not clear a newer message draft or edits typed while it ran.

OpenIDEA is a selective backend/logic donor, not the chosen Markdown frontend. For each adopted capability, record the demonstrated gap, existing owner, reused implementation, adaptation seam, and validation. Language services, search, build, debugging, and SCM must not independently start duplicate document histories, LSP servers, Git state machines, or terminal supervisors. Use the existing provider abstraction and availability reporting. [S10]

No named operation may be presented as working merely because the SDK has a type for it. Real replies, refusals, and events must reach the mounted consumer.

## 10. Herdr is a preserved execution foundation

Herdr has two deliberately separate reuse roles: the original TUI supplies selected Ratatui layout code, while **Herdr Core** supplies execution through the existing integration. Neither means adopting the Herdr desktop application. Keep Herdr Core behind the existing Theorem terminal registry and SDK. The web application talks to the authorized Theorem gateway/host, not a raw public Herdr endpoint. The inspected integration already has native/Herdr profile distinctions and code for bindings, epochs, attach/detach, input control, and live adoption. This spec migrates those consumers and closes relevant gaps; it does not ask for another supervisor. [S02–S05]

The detailed normative boundary is in [herdr-integration.md](herdr-integration.md). Its key obligations are:

- Closing a panel, navigating, or refreshing detaches the viewer. It does not kill a Herdr process.
- Reconnecting attaches to the existing terminal identity and correct generation. It never reruns a launch on a guess.
- Program replacement, process continuation, browser attachment, and host-log reset remain distinguishable.
- Any view of a terminal may type, paste and resize; the latest resize wins. There are no observers, no takeover and no control lease (removed by the owner on 2026-11-16: one person's several views of a terminal must never lock each other out). Input aimed at a terminal the host has since rebound is refused `stale_epoch` and the view re-attaches.
- Keep process status separate from accepted Theorem task state. No guessed status from terminal text.
- Preserve or repair live discovery through the existing authenticated workspace event path; bound initial adoption to its opening snapshot.
- Unsupported/unavailable backends fail explicitly. Native shell remains an explicit supported profile, not a silent fallback.
- Do not adopt Herdr's desktop UI or put Ghostty in the browser bundle. Herdr Core's own host dependency graph is recorded separately; its repository does vendor Ghostty. [S17]

Ratatui is not a VT emulator. The process pane requires a tested VT byte-to-screen interpreter and input encoder in front of the Ratatui cell renderer. Start from the existing host's `vt100` screen machinery as the reuse candidate and prove browser/WASM compatibility and required terminal features. Do not render escape-coded output as Markdown or strip controls into a plain log. Unsupported protocol features are negotiated/reported, never advertised falsely. [S05, S14]

Herdr does not keep a powered-off machine running or migrate a live process between machines. Remote continuity requires execution on a host that stays available. A new recovery shell is not continuation of the lost task. Browser-local RustyRed does not change these facts. [S15–S16]

## 11. RustyRed WASM and immediate interaction

Reuse the existing browser database/document initiative and its worker/ownership protocol. The inspected app database integration establishes a worker-backed OPFS path and shared clients; it does not establish editor history or full server synchronization, and its app-data settings disable history for that particular use. Do not copy those settings into the document lifecycle. [S07]

Use three explicit meanings:

| State | Meaning |
|---|---|
| Draft in the editor | Immediately visible local work; not yet a durability claim |
| Locally checkpointed | Persisted through the actual local owner with a successful durability outcome |
| Accepted/synchronized | Accepted by the relevant document/workspace authority, with its revision |

Typing applies to the local editing session immediately. Checkpoint and send changes asynchronously in ordered/versioned batches according to the document protocol. An acknowledgement for draft generation n advances its baseline but cannot replace generation n+1. Network delay is not an input lock.

Connected workspace files continue to use the existing document authority. A genuinely local document may use the existing local-authority path if supported. Neither mode creates two independent accepted writers to one resource. Do not invent a sync protocol around a new local store.

Shared access means one owner per database scope, not one database handle opened independently by every pane/tab. Do not share raw pointers across separately compiled WASM memories. Use the established message/client boundary. DB migration, blocked storage, quota exhaustion, crash recovery, and offline limitations have explicit UI states; do not report durable save from an in-memory acknowledgement.

Account switching revokes old subscriptions, scope bindings, pending credentials, and caches as required by the owner. Remote effects queued offline are revalidated for identity, revision, and permission before replay. Shell input and uncertain launches are never blind offline replay queues.

## 12. Artifact cabinet and complete theme

Register the approved cabinet as a tool panel using the same project/artifact owners, settings, preview generation, and revision identity defined in its companion spec. It may be docked, expanded, tabbed, or placed elsewhere. Do not create another artifact list or restart a terminal conversation merely to browse the cabinet.

Expressive defaults to procedural pixel representations; Calm defaults to full-fidelity thumbnails; an explicit user choice survives theme/layout changes. Opening reaches the correct original. Generated preview imagery remains source/revision-bound, inert, and separately cached. [S18]

The existing terminal theme pipeline becomes the shared semantic appearance boundary for workbench chrome, composer, Markdown, Changes, diagnostics, tool picker, and cabinet. Use a neutral/Flexoki-derived reference and measured relational adaptation, with no fixed purple/gold priority. Do not add independent fixed palettes inside donor widgets.

Distinguish application styling from external-program output. Map ANSI palette slots and host-controlled chrome through the terminal theme. Preserve explicit truecolor content emitted by programs unless the user chooses an identified accessibility/color transformation. Theme matching does not justify corrupting a color-sensitive image, diff, or terminal program.

Theme/layout changes preserve draft, IME state, undo, selected artifact revision, scroll anchors, terminal bindings, and pending operations. Enlarging text adapts the dock/cell count; it does not clip controls or force the page to fit at a smaller font.

## 13. Semantic inspection, accessibility, and customizability

Every panel exposes stable semantic identity, resource binding/revision, title, meaningful state, available actions, selected object/range, and reasons for refusal. User controls and agent tools invoke the same operation semantics, but permissions remain actor-scoped.

Expose the semantic contract through existing inspection/command mechanisms and the browser's accessible representation. Rendered character cells alone do not establish usable accessibility. Exactly one accessible owner exists for each control/text-edit surface; do not duplicate both terminal-cell text and a semantic mirror indiscriminately.

Provide keyboard access to tool selection, file navigation, panel movement/resizing, Markdown modes, diff navigation, approvals, and return focus. Support touch/pointer without requiring hover. Preserve IME, browser zoom, screen readers, clipboard permission, and reduced motion. Escape closes the current transient UI before it affects work. An explicit Kill command remains separate from closing a pane.

Users can save materially different arrangements and appearances in their account, including editor-centered, agent-centered, and minimal single-pane presets. Panel content is not hardcoded to left/center/right. Extensibility uses the existing capability/plugin mechanism with versioned descriptors and allowed actions. This release does not create an unbounded script-evaluation API or a second plugin runtime to satisfy customization.

Application/plugin data, terminal output, filenames, Markdown, and tool results are untrusted content. They cannot impersonate workbench controls, silently change keybindings, execute markup, or grant themselves more tools. Approval UI records the exact operation, actor, scope, and revision approved.

## 14. Failure, observability, and resource behavior

Represent loading, ready, pending, unavailable, disconnected, conflicted, and failed states at the relevant scope. A backend outage must not turn a file list into a fabricated empty project. Optional-provider failure must not blank the entire workbench. Errors are readable; never show `[object Object]` as the explanation.

Record request/operation identity, actor, environment/workspace, resource revision, terminal epoch where relevant, and accepted/refused/uncertain outcome. Do not indiscriminately log message text, terminal secrets, credentials, or file contents. Receipts point to appropriate authorized evidence.

Use bounded buffers for output, retained histories, local result sets, outstanding effects, and redraw work. An overloaded terminal triggers flow control or the protocol's reset/resnapshot path rather than dropping bytes silently. Visible panes are prioritized without cancelling background work. Async APIs alone do not prove off-main-thread execution.

Measure the actual mounted web build on a recorded browser/device/viewport. Keep performance targets separate from hard correctness: no overlap, no lost edits, no stale acceptance, no unbounded queues, and no dependence on a network round trip to show typed text are mandatory. Benchmark claims require a pinned workload and comparison, not theoretical gains from using Rust.

## 15. Theia retirement and compatibility

Inventory every current Theia consumer before deleting it. The inspected integration includes shared document sessions, terminals, language providers, diagnostics, SCM/history, search, run commands, and the Follow/Add Selection bridge. That list is a starting register, not proof that every current path is still identical. Reopen source at the implementation commit. [S01]

Extract/rebind frontend-independent SDK glue first. Some existing Theia adapter files carry their own SPDX declarations: do not relabel them Apache merely because Codex is Apache. Preserve provenance, licenses, modifications, and notices for each reused file. [S02, S11–S12]

For each reachable current capability, the parity register must identify its new consumer, real operation, states/refusals, and verification. Remove Theia only after every required workflow reaches the replacement or a separately approved deprecation exists. A hidden nonfunctional button is not migrated capability.

When the cutover is accepted, remove Theia frontend packages, assets, iframe/webview integration, no-longer-used plugin downloads, routing, and build paths. Preserve shared backend/provider code used elsewhere. Old bookmarks route to an appropriate workbench resource or a recovery screen, not a missing page or duplicate session. Existing preferences/data are migrated or preserved for recovery before obsolete storage is cleaned up.

A rollback during deployment must preserve documents, pending drafts, terminal identities, and customization records. It must not terminate Herdr processes. There is no permanent feature flag making two full IDEs the final state.

## 16. Implementation sequence and gates

### Gate 0 — reconcile the actual checkout and owners

Pin Theorem-UI, Theorem host, SDK package, RustyRed browser package, Ratzilla/Ratatui, and Herdr binary/schema. Reconcile the older indexed default-branch evidence against the newer Herdr PR source. Find the current web Theo route and existing registries; do not assume a new `/theo` route. Pin/extract the Herdr layout donor and prove its headless/WASM compile before building new split/focus logic. The original Herdr/Remux wire format is not interchangeable with the current Core protocol. Populate the [Theia migration parity register](migration-parity-register.json) and inventory existing terminal recovery tests. Record which current Herdr review gaps are still present.

### Gate 1 — connected workbench skeleton

Mount the Rust workbench on the actual web route. Adapt the selected Herdr layout code into one layout owner, then implement registered panels, picker, browser input/semantic bridge, and local state preservation. Bind real workspace/project identities. Demonstrate that adding/moving a tool does not start a process or lose a conversation draft.

### Gate 2 — prove the process path before polishing it

Through the existing SDK, open or attach to a real Herdr shell and one supported external agent. Interpret terminal output, handle input/paste/resize from more than one view, detach, refresh, reconnect, restart the workspace host, and preserve process identity where promised. Exercise an unavailable backend and a replaced/lost program. No snapshot fixture substitutes for this gate.

### Gate 3 — real editing and Git

Connect the Files view, shared source editor, and ELY-derived Markdown modes to actual document sessions. Edit while an agent changes another block, resolve a same-block conflict without loss, save, inspect the real diff, stage and commit. Add the remaining existing IDE operations through the parity register; use OpenIDEA only where a specific gap remains.

### Gate 4 — interaction quality and appearance

Adapt selected Codex code, finish composer/streaming/approval interactions, inverse Theo, the shared terminal palette, complete dock keyboard/pointer behavior, and artifact cabinet integration. Verify both Expressive and Calm without changing data or operation identities.

### Gate 5 — persistence, failure, and account customization

Prove local checkpoint/reload, storage-failure states, resynchronization, account scoping, saved alternative layouts, terminal adoption, stale responses, and accessibility. Avoid replacing the real dataset with prettier mock artifacts.

### Gate 6 — parity, deployed verification, retirement

Run the full acceptance suite against one matched frontend/host/SDK deployment, record source/build identities, capture the actual screens, finish migration and rollback checks, then remove the obsolete Theia surface. Native delivery is not part of this gate.

These are connected delivery slices, not standalone speculative frameworks. Each slice leaves a real consumer path and evidence. The first useful release proof is not a dock screenshot; it is a person editing and supervising the same work through the new mounted web interface.

## 17. Integrated acceptance journey

Open a real project in web Theo. Verify the environment, browse files, and open a Markdown document in the right tool panel. Type a local draft while the network is delayed. Ask Theo through its normal composer to propose an edit; inspect the resulting source revision and change list without losing the draft.

Open Add tool. Verify no effect occurs until selecting an action. Start a Herdr-backed shell or supported coding-agent profile on the selected host, run a uniquely identifiable process, and detach its pane. Move Markdown into the center and Theo to the right, switch the theme, and reopen the process pane. It must be the same process and correct screen, not a rerun with a similar title.

Exercise a second browser typing and resizing the same terminal, stale input refusal, host epoch change, and resnapshot. Kill/loss/replacement must be visibly different from detach/rebind. Make a manual Markdown correction, save, inspect the actual diff, stage/commit through Theorem, and view a generated artifact through the integrated cabinet and original viewer.

Save the alternate layout to the account, reload, and restore it on a narrow viewport. Confirm drafts, references, editing history, artifact selection, process binding, and task state remain coherent. Reconnect after a resource change, test a permission refusal and storage failure, and verify no data from another account leaks.

Then verify the deployment no longer uses Theia for this workflow. Collect real service receipts, terminal identity/generation observations, document revisions, keyboard/accessibility observations, and mounted screenshots. Mark incomplete cases as incomplete rather than substituting a prototype or declaring a helper test equivalent.

## 18. Final invariant

**Theo Web is the customizable working surface. Theorem owns the work and permissions. RustyRed supports local capability and persistence through its existing contract. Herdr Core owns the selected external terminal processes; the original Herdr TUI contributes reusable pane-layout mechanics. ELY and Codex contribute interaction code and behavior; OpenIDEA contributes selected IDE machinery.**

No layout, appearance, provider, or view-lifetime change is allowed to quietly replace the underlying work.


<!-- Evidence references -->
[S01]: SOURCES.md#s01
[S02]: SOURCES.md#s02
[S03]: SOURCES.md#s03
[S04]: SOURCES.md#s04
[S05]: SOURCES.md#s05
[S06]: SOURCES.md#s06
[S07]: SOURCES.md#s07
[S08]: SOURCES.md#s08
[S09]: SOURCES.md#s09
[S10]: SOURCES.md#s10
[S11]: SOURCES.md#s11
[S12]: SOURCES.md#s12
[S13]: SOURCES.md#s13
[S14]: SOURCES.md#s14
[S15]: SOURCES.md#s15
[S16]: SOURCES.md#s16
[S17]: SOURCES.md#s17
[S18]: SOURCES.md#s18

[S19]: SOURCES.md#s19
[S20]: SOURCES.md#s20
