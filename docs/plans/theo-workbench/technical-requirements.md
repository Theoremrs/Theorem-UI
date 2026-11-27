# Technical requirements — Theo Web Terminal Workbench 1.0

**Scope:** Web Theo only. These requirements are the canonical engineering obligations of the [feature specification](SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0.md). Native Theo/Platinum are deferred.

**Status:** Proposed implementation contract; no production acceptance cases have been run for this deliverable. Requirements use MUST for binding behavior. Geometry values identified as calibration targets may be adjusted with recorded rationale and visual acceptance; correctness/security obligations may not be weakened to make a test pass.

Each requirement identifies its responsible boundary and corresponding [acceptance cases](acceptance-cases.json). A checklist is not a proof: the evidence class of the case determines what must actually be measured. No aggregate quality score can compensate for data loss, incorrect authority, broken connectivity, or an unverified required path.

## R01 — Web-only delivery

**Owner:** Route/build owners  
**Acceptance:** AC-01, AC-60

The release MUST deliver the web Theo workbench as a major surface of the web application (amended 2026-11-26 by [SPEC-UNIFIED-AGENT-EXPERIENCE-1.0](SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md) Section 5.1; this previously read "replace the web Theo interior"). Native Theo, Platinum, native docking and native packaging MUST NOT become implementation tasks or acceptance dependencies. Required host repairs serving the web client remain in scope.

## R02 — One operation and resource owner

**Owner:** SDK and service adapters  
**Acceptance:** AC-02

Panels MUST use the existing Theorem workspace/document/run/SCM/terminal capability boundaries. Reuse MUST NOT create a second accepted document writer, agent harness, terminal supervisor or project store.

## R03 — Source reuse with provenance

**Owner:** Component port owners  
**Acceptance:** AC-02, AC-61

ELY Markdown and the initial ELY-derived Changes presentation MUST be ported to Ratatui. Suitable Codex code MAY be reused; the original Herdr TUI layout module MUST be evaluated/extracted as the selected starting layout donor, independently of Herdr Core execution. Every extraction MUST pin donor source, preserve applicable notices and tests, record modifications, and exclude donor runtime ownership. OpenIDEA adoption MUST identify a concrete capability gap.

## R04 — Whole workbench and navigation continuity

**Owner:** Web shell  
**Acceptance:** AC-01, AC-03, AC-55

The workbench MUST be reachable from the chat route as a revealable major surface (full, side or bottom) while retaining outer application navigation, the conversation sheet and access to projects/conversations. Dockview owns that composition; the workbench's own dock owns its panes (amended 2026-11-26 by [SPEC-UNIFIED-AGENT-EXPERIENCE-1.0](SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md) Section 5.1 and UX-01; this previously required the workbench to occupy the Theo route interior). The replacement MUST NOT require a second permanent Theia surface.

## R05 — One dock and panel registry

**Owner:** Workbench layout/registry  
**Acceptance:** AC-05, AC-07, AC-59, AC-61

One versioned registry MUST supply picker, shortcuts, agent actions and panel factories. One layout tree MUST own split/tab geometry, starting with adapted Herdr TileLayout mechanics rather than a duplicate tiler. Donor-local handles MUST map to stable panel/tab identities; splitting MUST not launch processes. A panel MUST have stable instance and resource identities, independently of region or tab index.

## R06 — Adaptive geometry

**Owner:** Layout and appearance  
**Acceptance:** AC-04, AC-36

Docked allocations MUST conserve usable width, avoid overlapping interactive regions, and honor panel minimums or explicitly switch presentation. The initial Files=224px and main:tools=2:1 settings are calibration targets, not reasons to shrink text. Split Markdown/diffs MUST expand or adapt when too narrow.

## R07 — Picker has no hidden effects

**Owner:** Tool picker and dispatch  
**Acceptance:** AC-06, AC-07, AC-09, AC-47

Opening/browsing the picker MUST create no document, conversation, process or model request. Each selected entry MUST distinguish focus/open from explicit create/start and use live keybindings and real availability.

## R08 — Files operate on the real workspace

**Owner:** Files controller  
**Acceptance:** AC-08

Listing, search, open, reveal, create/rename/delete where available MUST resolve the current authorized environment/workspace. Partial cache results MUST NOT claim exhaustive search. Binary, missing, excluded, symlink and refused resources MUST have honest handling.

## R09 — Source editor is functional

**Owner:** Editor controller  
**Acceptance:** AC-09, AC-10

The source pane MUST support local cursor/selection, Unicode multiline edits, find, undo/redo, save, dirty/conflict state and revision-aware responses. A read-only excerpt or placeholder editor MUST NOT be called completion.

## R10 — ELY Markdown mode parity

**Owner:** Markdown port  
**Acceptance:** AC-11

Visual, Source, Split and Preview MUST use one document session and shared text-editing core. Mode changes MUST preserve draft, undo, selection, pending operations and logical scroll anchor. Visual blocks MUST map edits to verified source ranges.

## R11 — No dropped concurrent block edits

**Owner:** Document reconciliation  
**Acceptance:** AC-12

An agent/peer change during a visual block edit MUST preserve the local edit. Reconcile through the document owner or expose a resolvable conflict; never retain the donor behavior that drops the pending block edit.

## R12 — Markdown source preservation

**Owner:** Markdown parser/patcher  
**Acceptance:** AC-13

A bounded visual edit MUST NOT normalize unrelated source or discard unsupported constructs. Untouched spans MUST remain equivalent under the existing document normalization contract; front matter, comments, fenced code and unknown syntax MUST have round-trip coverage.

## R13 — Explicit text coordinate systems

**Owner:** Editor/protocol adapters  
**Acceptance:** AC-14, AC-22

UTF-8 bytes, UTF-16 units, scalars, grapheme boundaries and rendered cell positions MUST be explicitly converted and revision-bound. Wrapped display lines and tabs MUST NOT be mistaken for source offsets.

## R14 — Local input, versioned acknowledgement

**Owner:** Document and composer controllers  
**Acceptance:** AC-10, AC-12, AC-15, AC-52

Typing, selection and preview updates MUST render without awaiting network/DB completion. An acknowledgement for submission n MUST advance only its accepted baseline and MUST NOT overwrite draft n+1. No remote request is required merely to echo input.

## R15 — Meaningful persistence claims

**Owner:** RustyRed/document owner  
**Acceptance:** AC-16, AC-17, AC-50

In-memory draft, successful local checkpoint and remote acceptance MUST remain distinguishable. Checkpoint failure, quota/storage denial and owner unavailability MUST not report durable save. Existing history/undo semantics MUST be retained; app-data no-history settings MUST not be reused blindly.

## R16 — Shared database access

**Owner:** RustyRed web adapter  
**Acceptance:** AC-18

The workbench MUST use the established database owner/worker/client model for each scope. New panes or tabs MUST NOT independently become competing writers. Separately compiled WASM modules MUST communicate through explicit data/message boundaries, not raw shared-pointer assumptions.

## R17 — Functional Changes panel

**Owner:** SCM controller  
**Acceptance:** AC-19, AC-54

Staged, unstaged, untracked and conflicted groups, real diffs, commit/amend and history MUST connect to Theorem SCM. Existing branch/merge/fetch/push/blame paths MUST be preserved through the parity register or explicitly approved for deprecation; no fake controls.

## R18 — Revision-correct Git mutations

**Owner:** SCM/document boundary  
**Acceptance:** AC-20, AC-21

Stage/discard/commit/merge operations MUST target the selected repository and correct source/index version. Unsaved buffers MUST not be silently treated as committed working-tree changes. Newer commit text MUST survive an earlier acknowledgement; uncertain mutations MUST be reconciled before retry.

## R19 — Language and run parity

**Owner:** IDE provider adapters  
**Acceptance:** AC-22, AC-23, AC-54

Language navigation, diagnostics, format/rename/code actions, search, history and run results MUST be bound to the source revision/environment they concern. Older results MUST not replace current ones. Missing providers MUST return truthful unavailable states rather than simulated answers.

## R20 — Structured Theo stays separate

**Owner:** Agent/runtime adapter  
**Acceptance:** AC-03, AC-24, AC-26

The foreground Theo pane MUST consume Theorem conversation/run state. External CLI terminals MUST remain distinct resource bindings. One submission MUST target exactly its selected interaction path; opening a provider profile MUST not silently migrate an existing conversation.

## R21 — Composer caret and input quality

**Owner:** Composer/web input bridge  
**Acceptance:** AC-14, AC-25, AC-26, AC-48

The composer MUST support multiline text, references/attachments, real selection and local undo. The hollow caret MUST track insertion state without entering the document. IME, paste and shortcut routing MUST work without duplicate input; reduced motion MUST suppress decorative blink.

## R22 — Inverse Theo is presentation

**Owner:** Theo appearance adapter  
**Acceptance:** AC-27

The inverse terminal face MUST reuse Theo expression/activity state and adapt readable foreground/eye roles to the actual surface. Appearance MUST NOT create another agent instance or set the workspace header height.

## R23 — Complete coordinated theme

**Owner:** Appearance owner  
**Acceptance:** AC-27, AC-28, AC-46

Workbench, Markdown, Changes, composer, picker and cabinet MUST use the shared terminal semantic palette and relational adaptation. No purple/gold preference or fixed donor palette may be silently reintroduced. Theme changes MUST preserve interaction state; external explicit truecolor is not indiscriminately recolored.

## R24 — Herdr through existing boundary

**Owner:** Host terminal adapter  
**Acceptance:** AC-02, AC-24, AC-29, AC-62

Herdr MUST remain a host-side provider behind Theorem SDK/terminal registry. The web implementation MUST NOT introduce a raw public core bridge, adopt the Herdr desktop shell, or compile a Ghostty frontend into the browser. Record host dependency/protocol versions; the original TUI/Remux protocol MUST NOT be substituted for the current Core protocol by name similarity.

## R25 — Truthful profile availability

**Owner:** Profile picker and SDK  
**Acceptance:** AC-29, AC-62

Native and Herdr profiles MUST retain explicit backend identity, availability and persistence semantics. Herdr readiness requires positive host capability evidence; old/missing capabilities MUST NOT cause native fallback. Provider argv and environment MUST be validated by the existing authority.

## R26 — Terminal rendering is real

**Owner:** VT interpreter/Ratatui pane  
**Acceptance:** AC-30, AC-31

Process output MUST pass through a tested terminal interpreter, not Markdown/escape stripping. Screen modes, cursor, colors, Unicode, split sequences, resize, selection/copy and negotiated input replies MUST work for supported real CLI profiles. Existing VT machinery is a reuse candidate subject to WASM/interop verification.

## R27 — Stable terminal bindings and epochs

**Owner:** Terminal registry/channel  
**Acceptance:** AC-31, AC-32, AC-33, AC-34, AC-38, AC-57, AC-62

Attach/replay/reset MUST bind environment, terminal session, backend and generation. New binding/host epochs MUST invalidate old offsets/screen projections. Reattached and replacement-process origins MUST remain distinct. No stale output may repaint a newly bound pane.

## R28 — Any view types and resizes

**Owner:** Host authorization/input  
**Acceptance:** AC-26, AC-35, AC-36

Any view attached to a terminal MAY type, paste and resize it; the latest resize wins. There are no observers, no takeover and no lease generation: the owner removed exclusive control on 2026-11-16 because one person's several views of a terminal must never lock each other out (a stale attachment left by a reloaded page held the lease and locked the live page out). Input aimed at a terminal the host has since rebound MUST be refused `stale_epoch`, and the view MUST re-attach. Renderer replies to terminal queries are discarded on Herdr terminals, where Herdr Core answers queries itself; on a native PTY only the view that last typed or resized answers. Browser focus alone MUST NOT grant remote execution rights.

*Settled 2026-11-26 (Gate 0 decision 1):* the unified agent experience companion asked for a control lease (IN-02, IN-03). The owner chose no lease, so this requirement stands as written. The companion's remaining rule is between the person and agents: an agent's input needs an owner-issued claim, and the person's input stops further agent input until the person releases it. See the [Gate 0 ownership map](gate-0/unified-agent-ownership-map.md), section 7, item 1.

## R29 — Detach is not terminate

**Owner:** Resource lifecycle  
**Acceptance:** AC-32, AC-33, AC-34, AC-56, AC-58, AC-61

Closing/hiding/moving a pane, changing theme/layout or refreshing MUST NOT call process kill/workspace close/core stop. Explicit interrupt, end-process and new-process operations MUST be separate and scoped. Recovery MUST never rerun a command on a guess.

## R30 — Bounded live terminal adoption

**Owner:** Host live subscriptions  
**Acceptance:** AC-37, AC-38, AC-39, AC-40

Opening adoption MUST end at the opening snapshot boundary; ongoing arrivals MUST not block workspace opening. Reconnect/missed events/relabeling/replacement MUST reconcile without duplicate or cross-scope records. A closing scope MUST not receive late adoptions.

## R31 — Execution trust boundary

**Owner:** Gateway and environment owner  
**Acceptance:** AC-39, AC-41, AC-50

Core access, labels and templates MUST NOT be described as a sandbox or authorization mechanism. The gateway MUST authorize account/environment/workspace/resource/control, protect credentials, and use actual OS/container boundaries for untrusted execution. A widget permission cannot constrain an already privileged shell by itself.

## R32 — Status does not invent authority

**Owner:** Process/task projections  
**Acceptance:** AC-42

Program-reported status, attachment state, process liveness, approval and task state MUST be separate. No report means unknown. Herdr parenthood MUST NOT automatically create session lineage, task authority or permission inheritance; printed output MUST not become trusted commands.

## R33 — Elm update/effect discipline

**Owner:** Workbench core  
**Acceptance:** AC-43

View/render MUST be side-effect-free. Updates MUST emit typed effect descriptions; completions MUST carry identities/generations. Large buffers stay with bounded resource controllers rather than being copied into a monolithic root model.

## R34 — Semantic actions with actor identity

**Owner:** Command/inspection adapters  
**Acceptance:** AC-41, AC-44

Panels MUST expose stable semantic state and actions through the existing inspection system. Human/agent actions MUST converge on operation semantics without erasing actor identity. Model-generated action messages MUST not manufacture human approval.

## R35 — Account-level meaningful customization

**Owner:** Configuration/dock owner  
**Acceptance:** AC-45, AC-56, AC-59

Users MUST be able to save substantially different layouts, themes and tool choices. Account configuration MUST use the real persistence path; browser-only fallback MUST be labeled. Device geometry remains local; restore MUST adapt and must not implicitly launch resources.

## R36 — Lifetimes independent of views

**Owner:** Resource controllers  
**Acceptance:** AC-05, AC-09, AC-11, AC-16, AC-45

Drafts, undo, selected artifact revisions, running processes and active runs MUST remain coherent through split/tab moves, expansion, visibility, route changes and renderer remounts. Closing a view MUST follow its explicit resource policy, not generic component teardown.

## R37 — Approved artifact cabinet integration

**Owner:** Artifact owners and panel  
**Acceptance:** AC-28, AC-46

The cabinet MUST reuse its companion spec and actual artifact registry/catalog/viewers. It MUST preserve source/revision-correct pixel/full-fidelity modes, explicit overrides and original opening. Integrating it MUST not create another artifact store or agent session.

## R38 — Keyboard and accessible semantics

**Owner:** Web input/accessibility  
**Acceptance:** AC-25, AC-44, AC-47, AC-48, AC-51

All essential controls and panel operations MUST be keyboard-operable with visible focus and deterministic return focus. Use one accessible owner per semantic node. Screen-reader names/state/order, clipboard and IME MUST be verified in the mounted browser, not inferred from character output.

## R39 — Responsive and legible web

**Owner:** Layout/accessibility  
**Acceptance:** AC-04, AC-49

The supported web browser matrix MUST be pinned in evidence. Zoom, text scaling, narrow viewports, pointer/touch and reduced motion MUST remain usable. No native app requirement is introduced by testing a narrow web viewport.

## R40 — Recovery and content boundaries

**Owner:** State/security adapters  
**Acceptance:** AC-08, AC-17, AC-23, AC-40, AC-50, AC-51

Network/permission/account transitions MUST revalidate subscriptions, drafts and pending effects. Untrusted Markdown/output/file names MUST not execute markup, steal permissions or spoof approval controls. Unknown errors MUST render as readable scoped failures, never [object Object].

## R41 — Bounded resource use

**Owner:** Rendering/effect runners  
**Acceptance:** AC-10, AC-18, AC-52

Output queues, retained history, subscriptions, decoding and preview generation MUST have finite configured bounds and observable overload behavior. One busy stream MUST not block editing/control. Performance reports MUST record workload, browser/device and candidate revision.

## R42 — Observable outcomes without secret dumps

**Owner:** Diagnostics/receipts  
**Acceptance:** AC-53

Important effects MUST be correlated by request/operation, actor, environment/resource and revision/epoch as applicable. Reports MUST distinguish requested/accepted/failed/uncertain and redact credentials/content by policy. Successful local fixtures MUST not be labeled live connectivity.

## R43 — Theia migration gate

**Owner:** Migration owner  
**Acceptance:** AC-54, AC-60

Before retirement, every required existing capability MUST have a real replacement consumer and acceptance result in a parity register. The migration MUST preserve identities/preferences/drafts and active terminal bindings. Yazi deletion elsewhere is not implicitly authorized.

## R44 — Completed retirement and deploy compatibility

**Owner:** Build/deployment owner  
**Acceptance:** AC-01, AC-55, AC-56, AC-60

After parity, remove obsolete Theia frontend packages/builds/assets/routes/iframe glue while preserving shared services. Old resource links MUST resolve or offer recovery. Match SDK/frontend/host capability versions; rollback MUST preserve work and must not kill Herdr processes.

## R45 — End-to-end acceptance

**Owner:** Release verifier  
**Acceptance:** AC-60

Completion MUST include the actual mounted web journey on real service data, ELY-derived editing, SCM mutations in an isolated repo, Herdr detach/reconnect, cabinet originals, and account restoration. All unrun/blocked tests MUST remain explicit; spec validation is not product validation.

## R46 — No automatic host migration

**Owner:** Execution environment UI  
**Acceptance:** AC-03, AC-34, AC-57

The workbench MUST display the actual execution host. Closing a browser can detach; sleeping/shutting down that host cannot be presented as continued execution elsewhere. Cross-host migration and native-client continuity are deferred unless separately specified and verified.

## R47 — Bounded retry and idempotency

**Owner:** SDK effect adapters  
**Acceptance:** AC-15, AC-21, AC-43, AC-53, AC-58

Logical launches/mutations MUST have stable identities where the protocol supports them. Retry MUST respect the actual deduplication window. Uncertain byte input, destructive mutations and agent launches MUST not be replayed blindly; no universal exactly-once claim is permitted.

## R48 — Extensibility without new unsafe runtime

**Owner:** Panel/plugin owner  
**Acceptance:** AC-02, AC-07, AC-41, AC-45, AC-59, AC-61

Alternate panel presentations MUST use versioned descriptors, explicit capabilities and existing extension/runtime policies. The workbench MUST not introduce arbitrary eval, another plugin VM, or raw SDK credentials to achieve customization. Unknown panel versions MUST fail safely and preserve bindings for recovery.

## Cross-references to the unified agent experience companion

[SPEC-UNIFIED-AGENT-EXPERIENCE-1.0](SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md) extends this workbench; it does not replace any requirement here. Where both apply, the companion's requirement is added to the R-ID below, and its acceptance cases are recorded in [acceptance-cases.json](acceptance-cases.json) as `UAE-AC-01` to `UAE-AC-24`. The [Gate 0 ownership map](gate-0/unified-agent-ownership-map.md) holds the source evidence.

| Requirement | Companion IDs it now carries | Note |
|---|---|---|
| R01, R04 | UX-01, DR-01 to DR-04 | Placement amended: the workbench is a revealable major surface; Dockview composes the application |
| R02 | OW-01, OW-02, ID-03 | The activity model is a read model over these owners, never another executor |
| R05 | UX-01, WS-06, API-01, API-08 | One workbench registry; no second registry for agent-visible actions |
| R07 | UX-02, CP-01, CP-03 | Opening and selecting have no execution effect |
| R14, R15 | AR-11, RC-03 | Saved means acknowledged; uncertain outcomes stay uncertain |
| R20, R21 | IN-01 | Explicit message recipient, drafts per target |
| R24, R25, R31 | 8.3 (external terminal agents), RC-01 | Execution profiles are not agents (ID-01) |
| R27, R28 | IN-02, IN-03, API-05, UI-05 | Settled: no lease, R28 stands for the person's views; agents need an owner-issued claim that the person's input overrides (ownership map section 7, item 1) |
| R29, R36 | UX-02, IN-06, RC-02, AR-12 | Close view detaches; Stop is separate. Side-chat `Host` unmount still cancels (ownership map 2.5) |
| R30 | OW-02, EV-02 | Inventory and cursor reconciliation |
| R32 | ST-01, 8.3 | Program reports stay reported state |
| R33 | EV-03, EV-04 | Bounded queues; late results keyed by binding generation |
| R34 | API-05, API-09, API-10 | Actor identity on every effect; the companion adds client identity |
| R35 | OW-04 | Account-synced arrangements; local geometry and input stay local |
| R37 | AR-01 to AR-13, UI-01 | Durable artifact resolution builds on the durable-artifacts plan, not a new registry |
| R38, R39 | UI-02 to UI-04 | |
| R41 | UI-06, 12.1 | |
| R47 | API-07, RC-03 | |

## Release evidence rules

Run source/unit checks against the actual candidate revision, then contract/integration checks across the actual producer and consumer. Mounted UI, live-process and accessibility cases require those observations. Mockups, copied terminal transcripts, a passing parser test, or an upstream README cannot satisfy them.

Every test records pass, fail, blocked or not_run, with raw evidence and the inspected version combination. A non-applicable result must name the approved scope decision. Never change a test to match a known defect without recording the changed product requirement.

Use isolated test repositories, accounts and Herdr sessions. Capture their identities; do not terminate unrelated user processes, mutate the live Git index, or stop the user’s shared Herdr core to run a fault test. Cleanup is limited to explicitly created test resources.
