# Theorem — Unified Agent Experience

**Specification:** SPEC-UNIFIED-AGENT-EXPERIENCE-1.0  
**Date:** 25 November 2026  
**Status:** Proposed implementation specification; approved product direction, with defaults selected below for implementation.  
**Audience:** Product design, Theorem-UI, Rust workbench, harness/runtime, and artifact maintainers.  
**Delivery:** A coherent first release followed by durable-agent portability and advanced workspace capabilities. No application changes or runtime acceptance tests were performed while writing this specification.

## 1. Product contract

Theorem gives people a stable place to see agents working, enter that work, and continue working with the things those agents create. An agent has a recognizable identity. A run is one assignment being executed. A resource is a conversation, terminal, artifact, browser session, or other thing involved in that work. A view is one way to see or interact with a resource.

The compact agent component, terminal drawer, full agent workspace, and artifact viewer must feel like connected views of the same work. Moving between them must preserve identity, history, and the user's position. The workspace should remain understandable while several agents pursue related or unrelated assignments.

The defining user experience is: see who is doing what; open the relevant work; inspect or intervene deliberately; leave it running; return to the same work later.

### 1.1 Governing decisions

| ID | Required decision |
| --- | --- |
| UX-01 | Use Dockview for major TSX application surfaces and the existing Rust workbench dock for panes within the agent workspace. Each rectangle has one layout owner. |
| UX-02 | Navigation, opening, expanding, and closing a view must not implicitly launch, restart, stop, or duplicate execution. |
| UX-03 | Default to one readable selected surface with a stable overview of other relevant runs. Allow deliberate comparison and additional splitting. |
| UX-04 | Preserve selection, input target, pane order, geometry, and inspected scroll position during unrelated activity. |
| UX-05 | There is no first-class Needs you destination, attention inbox, unresolved-decision counter, blocker-priority lane, or automatic focus takeover. |
| UX-06 | Report waiting, failure, disconnection, and completion truthfully within the affected work. Existing authorization remains effective. |
| UX-07 | Selecting work to look at does not silently change the recipient of a message or the terminal receiving input. |
| UX-08 | Treat names and appearances as editable identity attributes. Use immutable identifiers for execution, resource addressing, and automation. |
| UX-09 | Artifacts remain addressable independently of their originating conversation. Each live runtime instance has exactly one execution owner and explicit presentation attachments. Multiple instances require deliberate creation. |
| UX-10 | Durable agents remain usable outside this UI. Their definition, memory, and capabilities cannot depend on a particular window layout. |

These rules are release requirements, not optional styling preferences. “Required” and “must” indicate acceptance gates. “Default” is the initial behavior and may have an explicit user preference. “Later” identifies work outside the first release.

### 1.2 Scope

The first release covers compact agent activity, drawer and full-workspace continuity, concurrent run navigation, explicit input routing, typed workspace inspection/actions, consistent close semantics, durable artifact references, and one live artifact's movement between presentations. It includes basic persistent names, representations, and configuration references for agents.

The full specification also defines portable agent packages, embedded Rusty Red ownership, interchangeable knowledge providers, and evaluation forks. These are subsequent delivery milestones; they must not delay the first coherent workspace.

Existing browser, editor, terminal, and artifact implementations remain the content providers. This specification does not select a new terminal emulator, rewrite the harness, add another application docking library, or require a new execution framework. Cross-window live-surface transfer, arbitrary simultaneous interactive mirrors, a marketplace, and arbitrary process migration are later capabilities.

## 2. Rex reference and Theorem's adaptation

The reference is **Rex by Superlogical**, specifically its CLI, agent automation, server API, status protocol, and session restore documentation. Evidence here comes from current official documentation; Rex was not executed or audited as a source dependency.

Rex distinguishes persistent sessions, windows, blocks, and connected clients. It gives objects stable IDs separate from names and supports explicit command targeting. These are useful precedents for an agent-addressable workspace. [R1]

Rex's agent examples include creating a test pane, starting a server in a background tab, and inspecting terminal output. Its API exposes discoverable methods and schemas. Theorem adopts that inspect-and-act pattern through its existing command/capability boundaries. [R2], [R3]

| Reference idea | Theorem requirement |
| --- | --- |
| Persistent work independent of a viewing client | Execution is owned above view components; detaching a client does not imply cancellation. |
| Stable identities and editable labels | Commands retain exact IDs after discovery; ambiguous label lookup returns candidates without acting. |
| Inspectable workspace and typed actions | Humans and agents operate on the same resources, using explicit targets and returned receipts. |
| Program-reported activity | Adapters report observed state; the interface chooses a calm presentation. |
| Session restore | Test layout restoration, view reconnection, and supported run continuation independently. |

Rex's status protocol separates reported program state from GUI presentation. Theorem keeps that separation and uses local status without an attention-oriented navigation system. [R4]

Two distinctions are deliberate. Rex documents a block-close operation that ends the program; Theorem's ordinary Close view only detaches a view. Rex also distinguishes restarting a client from restarting a server and resuming a supported program; Theorem must make the same recovery distinctions rather than equate a restored pane with a resumed run. [R3], [R5]

## 3. User-facing surfaces

### 3.1 Compact agent activity

The compact Ratatui/Ratzilla component is a readable preview of real work. Each entry contains the agent's representation and name, a short assignment label, an observed activity or result, and a useful excerpt or preview. Two runs by the same agent share its identity while displaying different assignments.

**CP-01 — Selection.** A single click on an entry header selects that entry and its preview. A separate disclosure expands or collapses an inline preview. Selection does not navigate or submit input.

**CP-02 — Opening.** Double-clicking the entry header reveals its run in the preferred work surface. The initial preference is the drawer. A visible Open work action performs the same operation through pointer, Enter, Space, or touch. Double-clicking selectable code/output retains normal text selection; touch requires no double-tap gesture.

**CP-03 — Continuity.** Opening resolves the existing run and its useful resource, preserving a previously chosen presentation. It focuses workspace chrome, not terminal input. Repeated opening reveals the existing view rather than creating another execution.

**CP-04 — Honest previews.** Previews are observational and never resize a PTY, acquire input control, or create another interactive runtime. Background previews may update more slowly than the selected surface.

Agent representations may be expressive and user-created. Artifact previews may use the requested descriptive terminal pixel-art treatment, with a calm full-fidelity preference. A preview must remain recognizable and have a text label; opening the artifact reveals the actual content. Decorative motion must not imply fabricated progress.

### 3.2 Drawer

**DR-01 — Placement.** The bottom drawer overlays the intended page/sidebar area. It leaves the composer's input and actions visible, reachable, and unobstructed, including when the composer grows or the keyboard appears. It does not reflow the underlying page. A right-side drawer supports the user's docked or overlay preference.

**DR-02 — Default arrangement.** Show the selected run's main surface with a stable list or small previews of other runs. The initial scope is the current project/workspace. An explicit All work scope can include other authorized projects; show project labels where needed to disambiguate.

**DR-03 — Expansion.** Expand opens the full agent workspace with the same selection, view state, and run bindings. Restore returns to the prior drawer placement and size. Responsive compression changes the effective presentation without overwriting the saved arrangement.

**DR-04 — Closing and focus.** Close detaches the drawer view. It restores focus to the originating control when possible. Escape closes only when workspace chrome owns the key; terminal, editor, and nested controls retain their own Escape behavior. Clicking usable conversation content does not implicitly close the drawer.

### 3.3 Full agent workspace

**WS-01 — Composition.** One selected work surface occupies the primary area. A stable overview shows other relevant runs. Pinning a second view enables comparison; users can then split further. Visible pane count never limits the number of executions.

**WS-02 — Order.** Within a chosen grouping, initial order follows insertion. Manual order persists. New work joins predictably; output volume, failure, waiting, and completion do not reorder existing items. A new event cannot change the user's selected run.

**WS-03 — Relationships.** Show delegation, dependency, or handoff relationships only when backed by explicit records. Unrelated runs can share the space without appearing to collaborate. Do not draw a hierarchy merely because several agents are visible.

**WS-04 — Work selection.** The first opening chooses a meaningful available surface: changes, a document, browser, terminal, or another registered representation. Once the user chooses a presentation, retain that choice for the view. Details such as traces and raw tool events are available on request.

**WS-05 — Completion.** Completed work remains in place with its useful result until the user removes it from the current arrangement or changes scope. Completion does not collapse a pane, erase the output, or produce celebratory motion or sound by default.

**WS-06 — Navigation.** Provide discoverable commands for finding work, focusing a view, opening beside, expanding/restoring, moving, renaming, and closing a view. Expose them through existing menus/command infrastructure and keyboard equivalents. Keyboard bindings must respect terminal/editor ownership and existing application shortcuts.

### 3.4 Durable artifact viewer

The artifact viewer occupies a major application panel. It can also have inline and focused presentations. Dockview owns its placement beside conversations, browsers, notes, or other artifacts. The viewer owns local source/preview and revision-comparison layouts.

Canvas Split informs the conversation-and-result composition. Its components accept supplied content and state; Theorem supplies durable resolution, actual persistence, and runtime continuity through its own owners. [D2]

The initial view displays the useful output. It uses one title treatment, a compact presentation selector when useful, accurate revision context, relevant actions, and an overflow menu. Avoid repeating a large artifact title inside an already titled Dockview panel.

Documents use a readable measure. Charts, applications, and spatial scenes can fill their available space. Source, history, data, and execution controls appear according to renderer capabilities. Detailed behavior is specified in Section 9.

## 4. Input, control, and attention

**IN-01 — Explicit recipients.** Looking at an agent does not change the main composer's recipient. Message agent is an explicit action that establishes a visible recipient and preserves drafts per target. A conversation pane with its own input must clearly identify that input's recipient. Drafts are never silently moved between agents.

**IN-02 — Terminal control.** Opening, focusing, or selecting output in an observational terminal view does not acquire input control. Take control is an explicit action; a terminal explicitly started for the human can grant that client control as part of creation. Once control is acknowledged, focusing its input surface routes typing to that terminal. Show the target and current controller. Read-only previews cannot capture keystrokes. Multi-terminal broadcast is an explicit, separately scoped operation and is outside the first release.

**IN-03 — Shared input.** One controller owns a terminal's input and PTY size at a time. Human takeover stops further agent input to that terminal until control is released. This does not claim to undo a command already received by the process. Readers can remain attached without acquiring control. Closing the controlling view releases its control claim without killing the process. Client loss expires the claim under the provider's declared lease policy. The host fences input/resize from old claims; an agent reacquires control through the owner before sending more input. Unsupported arbitration leaves competing attachments observational.

*Gate 0 decision 1 (2026-11-26, the owner): no lease.* There is no view- or client-level control lease, and workbench R28 stands: every view of the person's own may type, paste and resize. Control is arbitrated between the person and agents, not between views. An agent's input to a terminal needs an explicit control claim issued by the owner (API-05). Input from the person stops further agent input to that terminal until the person releases it, and the agent reacquires a claim through the owner before it sends more. An agent's claim ends when its run ends, when the person takes over, or when it releases it; there is no timed expiry. Where this paragraph and IN-02 or IN-03 differ, this paragraph holds. IN-02's rule that opening, focusing or selecting output in a view never sends input is unchanged.

**IN-04 — Agent-created surfaces.** Creating auxiliary work preserves the user's focus and visible geometry by default. Register the work in the background or an existing tab group; an explicit request such as “show tests beside this” can authorize a new visible split. Record the creating run, parent resource, and session so the agent can inspect its resources and manage its own views by identity. User retention/pinning prevents automatic cleanup of a view. Creation grants no authority over unrelated resources. Reveal to the user is a separate action supported by the current instruction context.

**IN-05 — Local truth.** Waiting and failure remain visible in the affected run and its existing activity representation in the originating conversation. Ordinary status transitions update that representation; they do not append fresh assistant turns, notifications, or repeated questions. Requested results can still be delivered normally. A required decision is presented once through the existing interaction or authorization mechanism, referenced by a stable request ID. Other views may link to that same request; they must not create independent copies or bypass it. No default decision counts, badges, sounds, or priority sorting are added.

**IN-06 — Stop semantics.** Stop run is separate from Close view. Display Stop requested until the execution owner acknowledges cancellation or reports the actual outcome. Independent runs continue. The runtime declares whether stopping a parent includes its delegated children; the command names that scope and returns the affected run IDs. Finishing an in-flight atomic operation is distinct from accepting another step.

**IN-07 — Resume and retry.** Resume continues a supported paused/recoverable run through its execution owner. Retry after a terminal outcome creates a new run with lineage. Neither operation is triggered by reopening a panel.

## 5. Source baseline and implementation ownership

This specification extends the existing Theo Workbench design and artifact system. Repository evidence is pinned to Theorem-UI commit `c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd`, rechecked against main on 25 November 2026. Source facts are distinguished from the new requirements throughout.

The following sections define the shared contracts and implementation work. Existing equivalent contracts must be extended rather than duplicated.

### 5.1 Relationship to existing specifications

Adopt this file as a companion in `docs/plans/theo-workbench/`. On implementation, amend the placement statements in the existing workbench specification Sections 0, 2, and 4.1 and in its architecture Sections 1 and 11 item 3. Those statements assume replacement of the entire chat interior, including its Dockview composition. This specification instead gives Dockview ownership of general application composition and treats the Rust workbench as a revealable major surface with its own inner layout. [T1], [T2]

The selected-agent composition in Section 3 is the default when entering from agent activity. Existing Files, Changes, editors, conversation, and tool-picker capabilities remain available as registered workbench presentations and deliberate layouts. Theia retirement and capability-parity obligations remain separate; this amendment does not restore a permanent second IDE or delete those obligations.

Preserve existing resource owners, effect/completion semantics, generated wire types, draft preservation, semantic accessibility, and the Artifact Cabinet's representation contract. Update the existing technical requirements and acceptance ledger with cross-references to this document's IDs. Do not maintain contradictory placement rules in two specifications.

Historical handoffs remain intent/evidence where compatible. The co-browse handoff contributes visible agent participation and explicit control; its CommonPlace frontend paths are historical and are not revived. The procedural-engine handoff contributes portable scene references and provenance. The harness policy's anti-nagging intention is consistent with UX-05; this specification does not adopt its empirical claims as verified evidence. [P1], [P2], [P3]

### 5.2 Current foundations and required changes

| Existing source foundation | Required implementation work |
| --- | --- |
| Dockview shell and Rust `workbench-dock` already own separate layout mechanisms. [T3], [T4] | Establish the amended boundary, consistent reveal commands, and independent saved layout versions. |
| `agent/sessions.ts` already correlates run IDs with terminal/side-chat sessions and deduplicates state-change notices. It is a page-local watch. [T5] | Extend/project those identities and owner events into the project activity view; preserve the owner-recorded association with the last run that acted unless an explicit migration changes that policy. |
| Conversation and terminal ports support separate sessions; specialist runs have resumable event streams. [T6], [T7], [T8] | Present these together, preserving each source's authority, ordering, and availability. |
| Terminal detach and kill are separate; side-chat cleanup currently cancels a running turn. [T9], [T10] | Move side-chat execution ownership above the view lifecycle and verify Close view cannot cancel it. |
| Artifact content is resolved from active-thread messages; the live-App panel refers back to the answer to prevent a second runtime. [T11], [T12] | Add durable resource resolution and one live runtime owner with explicit attachment. Retain the duplicate-execution guard until this works. |
| Artifact contributions already select renderers and declare selection locators. [T13] | Extend those contracts with view modes/actions/lifecycle; do not create a competing registry. |

This is a source baseline, not evidence that the deployed application satisfies the requirements. In particular, page-local correlation is not a durable inventory of all authorized work.

## 6. Identity and ownership contracts

### 6.1 Canonical entities

Use the existing identifiers where they already have these meanings. Add an explicit mapping where an external provider uses another identifier. Display names, labels, tab positions, and short IDs are never authoritative keys.

| Entity | Meaning and required references |
| --- | --- |
| Agent | Durable identity; owner/scope, profile/configuration revision, representation, and capability requirements. |
| Run | One assignment; agent/config revision, origin conversation, workspace, executor, lifecycle, optional parent/dependency links. |
| Work session | A grouping of relevant runs/resources for navigation. It does not imply collaboration, shared memory, or one execution lifetime. Reuse an existing workspace/project scope where sufficient. |
| Resource | A typed conversation, terminal session, document/artifact, browser session, or other owner-backed object; source identity, authority, scope, version/cursor, and supported actions. |
| Artifact revision | A stable committed content state with parent/base revision, author/run provenance, and resolvable payload references. |
| Runtime instance | An execution of an artifact or other interactive resource, with its running revision/configuration, host, and lifecycle capabilities. |
| View instance | One resource presentation; independent selection, presentation mode, history position, local inspection state, and binding generation. |
| Client | A browser/device attachment; local focus, geometry, view preferences, and any input-control claims. |

**ID-01.** A durable agent may have several simultaneous runs. A run may expose several resources. A resource may have several views. A raw terminal is not automatically an agent; an adapter or explicit binding establishes that relationship.

**ID-02.** Copying an agent creates a new agent ID with lineage. Renaming or changing its appearance preserves its ID. Run records retain the profile/config revision under which they started; current display names may be shown alongside historical attribution where useful.

**ID-03.** Durable ownership, authorship, execution responsibility, and current input control are separate. An agent editing a project artifact does not thereby move that artifact into its private memory or gain access to unrelated resources.

### 6.2 Authorities and projections

The harness/execution provider remains authoritative for runs. The terminal host owns PTYs/processes. Conversation and document owners retain their resources. The existing content authority for each artifact type owns accepted revisions; a runtime host owns its execution. Rust and TSX rendering consume projections of these owners.

**OW-01.** The unified activity model is a read model with typed commands back to existing owners. It cannot become another executor or infer authoritative success from UI unmounting, token silence, or a terminal title.

**OW-02.** The run inventory must be retrievable independently of the active thread and current mounts. A client opening after work has begun receives authorized existing work. Old history may be paginated; a narrower partial inventory must identify its scope and completeness.

**OW-03.** Layouts store view/resource references and small presentation settings. Execution journals, artifact content, and large payloads remain with their owners. A saved arrangement is not a run checkpoint.

**OW-04.** Account-synced arrangements retain logical order and bindings that are safe to sync. Device bounds, pointer position, input ownership, and temporary focus remain local. Restoring on another device adapts geometry and resolves capabilities without starting missing processes.

## 7. Activity, streams, and recovery

### 7.1 State representation

Keep three axes separate; adapters map their native states without inventing unavailable detail.

| Axis | Required meaning |
| --- | --- |
| Execution | Queued, starting, running, waiting, paused, succeeded, failed, cancelled, or interrupted, when supported by the owner. Unknown remains representable. |
| Observation | Connecting, current, stale/disconnected, recovering, or unavailable. |
| Viewing | Following current work, inspecting a fixed revision/history position, or detached. |

An agent with no run is available/idle; idle is not an unfinished run. A terminal program exiting successfully does not by itself establish that an agent's assignment succeeded. Show command exit status and run outcome at their respective levels.

**ST-01.** State carries its source, observed timestamp, and applicable generation/cursor. Mark external program reports as reported state. Summaries may explain activity, but they cannot change lifecycle or imply a percentage without an actual progress source.

**ST-02.** A lost stream marks observation stale while retaining the last known execution state and output. Do not animate new work as if observed. On reconnection, fetch current authority before claiming the run continued or ended.

**ST-03.** Waiting carries a reason category and resource/request reference when available. The category informs local wording and available actions; it does not determine list priority or create a separate attention destination.

### 7.2 Event contract

Normalize existing owner events into the activity projection; do not rewrite terminal bytes or model streams as invented global events. The envelope identifies schema version, source/owner, authorized scope/resource, observation time, and payload or payload reference. Include source event ID/cursor, run reference, and source generation/epoch when the source provides them and they apply. Uninstrumented terminals need no fabricated agent run. Record missing sequencing/replay capabilities explicitly; a projection-local ordering token is not an authoritative source cursor. An optional causation/operation ID connects actions to their results.

**EV-01.** Ordering is per source/resource. Do not treat wall-clock time as a total order across independent agents. A combined timeline may group events for reading, retaining source order and explicit causal links.

**EV-02.** Reconnection uses the source's existing cursor/sequence where supported. Deduplication keys include source, resource, applicable epoch/generation, and event/sequence identity, or an equivalent owner-guaranteed unique key. Identical offsets on different terminals or after a reset are not duplicates. A new epoch cannot be merged into the previous byte stream. A cursor gap triggers a canonical snapshot or an explicitly marked unavailable history segment. A source without replay identity must resnapshot or report the gap; it cannot claim lossless event recovery.

**EV-03.** Rendering can coalesce frames and previews, but state transitions and accepted mutations cannot be silently dropped. Use bounded queues and backpressure. Keep history in its owner with paged client access rather than accumulating an unbounded React or WASM collection.

**EV-04.** Late results carry the binding generation and resource identity. A response for a formerly selected resource may update its correctly keyed cache, but cannot overwrite the newly selected view.

### 7.3 Recovery levels

| Event | Required result |
| --- | --- |
| Hide, close, or move a view | Resource/run identity remains; presentation detaches or relocates. |
| Refresh/reconnect a client while host survives | Reattach to existing sessions, reconcile snapshots/cursors, recover saved view state where available. |
| Restore a layout after execution ended | Show the existing result or an honest ended/unavailable state; do not relaunch it. |
| Restart execution host | Recover only through the provider's supported journal/checkpoint or program-resume contract. |
| Transfer to another host | Use an explicit supported migration/import operation, dependency rebinding, and ownership transfer. |

**RC-01.** Each provider declares persistence capability: survives view detach, survives client disconnect, and supports checkpoint/restart continuation. A browser-only runtime cannot promise work will survive closing the browser unless a supported owner/checkpoint exists.

**RC-02.** Session retention, idle suspension, and eviction are execution-owner policies. Keep their outcomes inspectable. Closing a view is never an implicit request to expire a session. A provider may still end work for a recorded policy or host failure.

**RC-03.** Reconcile operations with uncertain outcomes using their existing operation IDs/receipts. Do not resend terminal input or repeat an external effect merely because a response was lost. Mutations that cannot be safely replayed return an explicit uncertain outcome.

## 8. Agent-addressable workspace

The same resources people use must be inspectable and operable by agents through the existing typed capability surface. Reuse `workbench.read`, session correlation, existing effect/owner ports, and registered actions wherever they already represent these operations. The operation names below describe required semantics; they do not authorize a parallel API or new endpoint namespace. [T2], [T5]

### 8.1 Discovery and inspection

**API-01.** Discoverable descriptors contain resource/presentation kind, schema version, supported observations and commands, input/output schemas, availability, required capabilities, and lifecycle meaning. The agent learns the target IDs and supported actions from discovery rather than reconstructing them from pixels or labels.

**API-02.** A workspace snapshot returns its scope/completeness, revision, resources, run bindings, view placements, and relevant control ownership. A resource read returns its identity, source revision/cursor, observation status, and structured content or bounded text/screen representation. Layout structure and resource content are separate reads where that prevents expensive snapshots.

**API-03.** Terminal screen reads include terminal session ID, epoch, dimensions, cursor/selection context where supported, and observation time. Retain a distinction between the current emulated screen and the raw output log. A screen is evidence of what is displayed; it is not a parsed declaration that a task passed.

**API-04.** Expose these operations through the existing code-mode/capability adapter and, when supported, CLI/MCP adapters using the same underlying contracts. The UI is not required to be mounted for headless inspection and execution commands. Client-specific view operations require an identified client; absence returns unavailable, not a new browser or a fabricated view.

### 8.2 Commands and effects

| Command class | Required target and effect |
| --- | --- |
| List / inspect / subscribe | Explicit authorized scope/resource; read-only and bounded/paginated. |
| Reveal / open beside / expand / restore | Existing resource/view and client; placement only, with focus policy stated. |
| Create view / close view | Resource/view ID; attach/detach presentation only. |
| Start assignment / start terminal / run artifact | Explicit resource definition, workspace/provider, configuration, and operation ID; creates execution through its owner. |
| Message agent | Agent/run or conversation ID and message ID; explicit delivery/queue semantics. |
| Take terminal control | Terminal ID, epoch, requesting controller identity, and request ID; the owner grants/returns a fencing claim after authorization and arbitration. |
| Terminal input / resize | Terminal ID, epoch, owner-issued control claim, and operation/input identity; ordered and validated by the host. |
| Release terminal control | Terminal ID, epoch, owner-issued control claim, and request ID; releases that claim without ending the process. |
| Edit / commit artifact | Artifact ID, base revision, mutation ID, and typed edit; resolves through document/artifact authority. |
| Pause / resume / stop | Run/runtime ID and supported scope; asynchronous acknowledgment and actual result. |

**API-05.** The invocation envelope includes caller/run identity, authorized scope, exact target, request/operation ID, applicable base revision or epoch, and any required input-control claim. Capture the caller's default target at dispatch. User focus cannot change a background agent's destination.

An acquisition request does not require an existing control claim. Only the terminal owner issues that claim; a client cannot mint it. Subsequent input, resize, and release use the granted claim, and input is withheld until acquisition is acknowledged.

**API-06.** Names are discovery conveniences. Multiple matches produce a typed ambiguous-target result and candidate IDs without acting. A missing or stale resource never falls back to the currently focused pane or to another project's resource.

**API-07.** Commands return accepted/refused/failed/uncertain outcomes with operation IDs, affected resource IDs, revisions/cursors where applicable, and inspectable receipts. Acceptance of a request is not completion of the requested task. Idempotency is implemented by the owner for supported operations; raw terminal input is never assumed replay-safe.

**API-08.** Preserve the existing Rust-owned wire schema and generated TypeScript declarations at the workbench boundary. Keep schema validation and stale-result handling at that boundary. New actions must be discoverable in the same registration used by menus/shortcuts; rendering performs no domain effects. [T2]

**API-09.** Authorization is applied by the resource owner for every read, write, subscription, and export. Adapter status reports cannot grant capabilities or satisfy an approval. Scope follows the target resource and caller, not the currently displayed project name.

**API-10.** Resource creation, view placement, view selection, keyboard focus, and message recipient are separate effects. Agent-originated operations default to background placement and preserve the latter three. An explicit user navigation instruction such as “show that run” may activate the requested surface and focus its chrome; it never implicitly enters terminal input or changes the composer recipient. The host derives that authority from the user action/instruction context; a model-supplied boolean alone cannot grant it.

### 8.3 External terminal agents

Native Theorem agents use structured owner events. External CLI agents use an explicit session binding plus a compatible adapter or reported program status. Uninstrumented sessions remain ordinary terminals with process/output observations. Do not infer a durable agent's identity from an executable name alone.

An OSC 7501 adapter is an optional interoperability path inspired by Rex's Program Status Protocol. It must bound and validate incoming records, distinguish report provenance, and keep reported state separate from Theorem's authoritative run outcomes. Adopting the protocol does not require adopting Rex's UI or its program-resume mechanism. [R4]

For shared terminals, one controller determines the authoritative PTY size. Other views render the existing screen through their own viewport. A passive thumbnail never triggers resize. Moving the interactive view transfers the size role deliberately; stale controllers lose input/resize authority. Existing host-side terminal providers remain responsible for process lifetime.

## 9. Artifact working surfaces

### 9.1 Resolution and opening

**AR-01.** Resolve a resource by workspace/owner, artifact ID, and revision selector without requiring its originating thread to be selected or mounted. The originating message remains provenance and navigation context. Enforce resource access independently of whether that message is visible.

**AR-02.** Opening a historical message selects the revision referenced by that message. Opening the producing run's current result or a project's current artifact follows the latest committed revision by default. A message without a revision must explicitly be a current reference; the client cannot silently reinterpret a historical link.

**AR-03.** Reveal an existing suitable viewer when possible. Otherwise reuse an unretained preview slot or create a view. Retained panels, fixed historical views, and unsaved edits are never silently replaced. Open beside is the deliberate way to keep another view visible.

### 9.2 Three independent view choices

| Choice | Meaning |
| --- | --- |
| Keep panel open | Prevent this view being reused for another artifact. Does not fix its revision. |
| View revision | Inspect a specific committed revision. Does not automatically retain the panel forever. |
| Follow current work | Follow current committed output and, where supported, clearly identified live drafts. Does not enable automatic scrolling over inspected history. |

These are separate fields in view state. Their controls may be compact, but labels and behavior must not conflate them.

**AR-04.** A fixed revision stays fixed when new output arrives. New revision available is a quiet local action. Scrolling back suspends auto-scroll; returning to live output is explicit. Follow mode and scroll-follow state are independent.

**AR-05.** Each view has a distinct ID and binding generation. Selected revision, mode, camera, scroll, selection, and local expansion belong to that view. Shared edits belong to the artifact controller; shared execution belongs to its runtime owner.

### 9.3 Presentations and actions

Extend the existing contribution registry with supported presentations, actions, semantic selection, minimum sizing, attachment mode, visibility handling, and optional comparison/export/checkpoint behavior. A contribution states what it can actually do. Existing renderers remain responsible for their content. [T13]

Preview/source, chart/data, read/edit, scene/parameters, and notebook/cells are possible presentations rather than a mandatory universal tab set. Show relevant actions such as Export or Run only where supported. An unavailable capability gives a local explanation; it does not replace the artifact with a generic failure dashboard.

**AR-06.** Comparison of two revisions belongs to the artifact viewer. Use text/structural diffs or corresponding visual results as appropriate. An old executable revision opens as a saved output or non-executing inspection unless the user explicitly runs it. Starting that revision creates a distinct runtime with lineage.

**AR-07.** Selecting content and asking for a change carries artifact ID, exact base revision, semantic locator, and a bounded quoted excerpt or referenced evidence as appropriate. The user sees the target context in the composer. If the selection no longer resolves, the owner requests/reports reconciliation rather than editing an unrelated current object.

### 9.4 Live execution and edits

**AR-08.** A live artifact's runtime is owned above inline/docked/expanded components. Views attach to it; they do not execute startup again. Preserve the existing referral guard until the replacement host demonstrates that guarantee. A renderer may initially support only one interactive attachment plus passive previews. [T12]

**AR-09.** A second interactive view may share a runtime only when the renderer declares and implements that contract. Otherwise offer a passive view, move the existing attachment, or explicitly start an independent instance. A React portal or hidden iframe alone is not evidence of safe transfer across hosts.

**AR-10.** Distinguish streaming source draft, committed source revision, and running revision. Keep the last valid interactive output available while a new source draft is incomplete. Apply updates through supported renderer/runtime behavior and preserve supported state. Report restart requirements locally; never label an old running result as the new revision.

**AR-11.** Saved means acknowledged persistence. Content persistence, runtime checkpointing, and saved viewing preferences have separate receipts/state. A renderer's local state does not become durable merely because its surrounding panel layout was saved.

**AR-12.** Close view preserves artifact content and does not issue Stop. Visibility may throttle rendering without stopping computation. Dockview documents special retention needs for iframes and continued work in hidden panels; implement visibility behavior deliberately and verify actual movement between host surfaces. [D1]

**AR-13.** Concurrent agent/user edits name their base revision. The existing document/commit authority rebases, serializes, or rejects conflicts according to its supported model. Never let the last UI arrival overwrite another accepted edit. Run attribution and resulting revision are recorded together.

Large scenes, notebooks, images, and computation results travel by resolvable reference with version/content identity. The viewer can use different renderers for the same portable content. An artifact may refer to compute and storage providers; those dependencies are separate from its current panel placement. [P2]

## 10. Durable agents and user-authored character

### 10.1 Profile model

**AG-01.** Each durable agent has a stable ID and a versioned profile containing its user-chosen name, description, representation/assets, user-authored characteristics, working preferences, instruction/configuration references, and capability/provider requirements. Theo is the default starting representation. Additional agents may use expressive characters, terminal designs, simple marks, or other supported representations.

**AG-02.** Representation and behavior are related but distinct fields. A character's animation cannot silently change authority, capability grants, or memory scope. A user-authored working preference can influence behavior through the ordinary versioned instruction/configuration path. The interface distinguishes the user's description from measured capability or verified execution status.

**AG-03.** Expressions remain extensible and procedural. Do not constrain every character to a closed list of emotions. Supply observed activity/context to the representation adapter while operational status remains independently readable in text. Static and reduced-motion variants retain that meaning.

**AG-04.** Cosmetic changes can appear immediately. Changes to models, instructions, capabilities, tools, and storage bindings apply to new runs by default; running work retains its configuration revision. Applying a supported change to an active run is an explicit owner action with a recorded boundary.

**AG-05.** A reusable specialist identity and a temporary delegated run are separate. A new child run does not automatically become a permanent named agent. A Save as agent operation can create a reusable profile with selected definition and memory; it does not indiscriminately copy all parent/session context.

### 10.2 Configuration experience

The everyday agent surface emphasizes name, representation, short role/description, and current assignments. An agent's configuration page contains behavior, capabilities, memory, and advanced execution/storage settings. Creating an ordinary agent works with defaults and does not require selecting a database.

The live workspace does not display a permanent capability matrix or personality editor. Configuration is reachable from the agent's identity/menu, with clear scope and revision. An agent can be personalized without creating a running assignment, and an assignment can finish without deleting the agent.

## 11. State, storage, and portability

These contracts carry forward the durable-agent architecture brief. This specification defines product behavior and integration boundaries; it does not replace the database or harness specifications. [A1]

### 11.1 Embedded default and ownership

**DB-01.** Embedded Rusty Red is the default. Inside Theorem, an agent may receive an authorized host-owned store/namespace. A standalone deployment can own an embedded database. Agent-owned state is a coherent logical boundary; it does not require every run or panel to open another physical writer.

**DB-02.** Separate logical roles for agent definition/preferences, execution journal/checkpoints, knowledge/retrieval, and large payloads. One provider may implement several roles. Required recovery semantics must not disappear when a knowledge database is changed.

**DB-03.** Resolve an explicit configured provider first, then a compatible host-supplied provider, then the embedded default when neither is configured. An explicit provider failure does not silently create a new empty memory store. Preserve the failed binding and show an actionable local state.

**DB-04.** Concurrent runs use the existing writer/transaction authority for an agent's state. Memory scoping applies to reads, writes, traversal, retrieval, and export. A shared physical database does not imply agents share private knowledge. Project artifacts may remain shared resources independently of agent-private memory.

**DB-05.** Advanced providers declare actual capabilities, including the retrieval, mutation, history, and export features they support. The agent's required features must resolve before a run starts. Changing physical payload storage, changing knowledge/retrieval provider, and changing retrieval strategy are distinct configuration choices.

### 11.2 Portable packages

| Export mode | Required meaning |
| --- | --- |
| Template | Definition, representation, preferences, and dependency requirements; no unselected private memory. |
| Agent with selected memory | Template plus chosen durable state and provenance, with all included payloads or explicit dependencies. |
| Supported checkpoint | Definition/state plus compatible run checkpoint/journal, execution requirements, and an ownership-transfer procedure. |

**PT-01.** A package carries schema/config versions, agent identity and lineage, capability/provider requirements, assets, selected memory, and dependency/content references. Credentials are rebound through receiving-host secret references. Workspace geometry is an optional separate preference, not necessary to use the agent.

**PT-02.** Include referenced payloads or record resolvable external dependencies with content identity and an import check. A metadata-only export with missing required objects cannot be declared complete. Exports use supported logical snapshot/quiescence mechanisms.

**PT-03.** Import as a copy mints a new identity with lineage. A deliberate move can retain identity and transfer the authority to advance any continuing run; the source cannot remain a competing writer/executor for that run. Unsupported live resources remain explicit dependencies or stopped work.

**PT-04.** Database export does not carry process memory, sockets, browser logins, or an arbitrary terminal process. Supported continuation reconstructs admitted state and reconciles uncertain effects. The receiving host checks compatibility and reports missing bindings before claiming readiness.

### 11.3 Experiments

An optional evaluation workflow can fork an agent/configuration and selected state into isolated candidates. Record the base agent revision, source snapshot, provider/version/configuration, model/tool configuration, retrieval strategy, and evaluation workload. Candidate writes do not teach the original agent or another candidate.

Compare correctness/evidence, latency, resource use, and required persistence properties. Hold other variables fixed for a storage-only comparison; if retrieval logic or model changes too, label it a configuration experiment. Experiment results can open as ordinary artifacts. They do not add compulsory decisions or controls to the live workspace.

## 12. Rendering, accessibility, and responsiveness

**UI-01.** Reuse the current theme tokens and Artifact Cabinet appearance policy. This spec selects no replacement palette. Agent accents identify people/agents; semantic state must remain distinguishable independently of accent, color, and motion.

**UI-02.** Ratatui/Ratzilla controls participate in the existing semantic accessibility overlay, with one accessible owner per control, usable focus order, names, states, and keyboard alternatives. Announce meaningful changes in the selected context; do not announce every token or every background event. Text output remains selectable/copyable where the renderer supports it.

**UI-03.** Double-click, drag, hover, and character expression are never the only route to an action or its meaning. Touch targets and text scaling follow the host's accessibility rules. Reduced motion disables decorative loops without hiding activity or connection state.

**UI-04.** Layout responds to the actual container. Respect renderer minimum sizes; collapse the overview or use tabs/focused views before shrinking text to fit. A retained wide arrangement survives temporary narrowing. On narrow/mobile surfaces, show one principal work surface with direct access to run switching, conversation, and Open work; do not squeeze the desktop grid onto the screen.

**UI-05.** Resize the host surface using measured pixels and pass measured cell metrics to the Rust dock. Only the inner owner computes cell geometry. An interactive terminal's PTY resize follows its control owner; decorative previews remain observational.

**UI-06.** Use virtualized/paged history, event-driven redraw, bounded per-source queues, and coalesced preview refresh. Foreground interaction takes priority over offscreen decoration. Do not render every agent at a full animation rate solely to make the workspace look busy.

### 12.1 Initial performance targets

These are proposed validation targets, not measured results. Record browser/version, device, dataset, network conditions, and build in the acceptance evidence. Initial calibration must retain an explicit target; do not silently remove a failing measurement.

| Scenario | Initial target |
| --- | --- |
| Warm switch/reveal of an attached view | p95 local interaction-to-paint at or below 200 ms, excluding a new remote fetch. |
| Keyboard/composer interaction during activity | p95 local input-to-paint at or below 100 ms, excluding network round trips. |
| Background compact previews | Coalesce to at most 2 visual refreshes/second per preview unless selected; lifecycle truth still updates independently. |
| Activity load | Exercise 1, 4, and 12 concurrent runs with one main surface and a retained comparison; 32 runs is a stress case, not a product concurrency limit. |
| Sustained session | Thirty-minute mixed-output scenario; no unbounded client queue/history growth, no lost accepted transition, no target/focus changes. |

For each workload, publish output/event rate and resource complexity so the measurements are reproducible. Use replay for deterministic load and real owners for lifecycle acceptance. Do not substitute a visually impressive replay for proof of live continuity.

## 13. Delivery plan and integration seams

The first coherent release comprises Gates 0–3. Gates 4–5 add portability and provider experiments. Each gate has an independently reviewable outcome. Feature delivery must preserve the existing owner's invariants throughout; do not briefly introduce duplicate execution as a migration shortcut.

### Gate 0 — Reconcile authority and contracts

Record the Section 5.1 placement amendment in the existing spec/architecture/ledger. Inventory the current owner operations for run listing, resource reads, reveal, terminal detach/control, side-chat lifetime, artifact resolution, and artifact runtime attachment. Map the IDs in Section 6 onto existing schemas and document genuine gaps.

Identify the existing durable agent-definition/profile authority and reuse or extend it. If the required durable profile capability is absent, record that gap and select its owner explicitly. The page-local session watch is not that authority. Gate 3 must use the authority established here rather than assume a durable profile service already exists.

Extend existing generated wire types and registrations for the missing semantics. Keep schema versions, source cursors, and capability availability explicit. Do not infer deployed support from TypeScript or Rust types alone.

**Exit:** one reviewed ownership map, an explicit contract mapping, updated acceptance cases, and no contradictory layout authority. Existing Theia parity/retirement work retains its own gates.

### Gate 1 — Establish view-independent work and activity

Build the activity projection over the conversation, terminal, delegation, and session-watch sources. Add the project-level inventory/reconciliation path where absent. Repair side-chat cancellation on view cleanup and retain distinct stop actions. Enforce explicit input targets and provider-backed input arbitration.

Primary seams: `src/lib/workbench/agent/sessions.ts`, `conversation/port.ts`, `conversation/side-chats.tsx`, `terminal/session.ts`, `adapter.ts`, `src/lib/theorem/delegations.ts`, and the corresponding existing owner APIs. These paths are integration starting points, not an instruction to put all new logic into one file.

**Exit:** multiple real runs can be listed, observed, detached, and reattached. Closing a view does not cancel a native side chat or kill a terminal. Reconnect and ambiguous-target cases pass before the UI promises continuity.

### Gate 2 — Deliver compact, drawer, and full-workspace interaction

Connect Open work/reveal operations to the existing shell and workbench. Implement the selected-surface default, stable overview, deliberate comparison, persistent order, local state, and responsive adaptation. Add keyboard/touch equivalents, explicit terminal control, and calm status behavior.

Primary seams: `src/components/shell/chat-shell.tsx`, `src/components/shell/dock.tsx`, `src/components/workbench/workbench.tsx`, its semantic overlay, and the existing `workbench-core`/`workbench-dock` crates. Keep major TSX geometry and inner Rust geometry independent.

**Exit:** the same run moves through compact preview, drawer, and full workspace with stable input, history, and resource identity. The composer remains usable above/beside the drawer, and background events do not alter focus or arrangement.

### Gate 3 — Deliver durable artifacts and basic agent identity

Resolve artifacts independently of the active thread. Introduce per-view revision/presentation state. Establish a live runtime host independent of the answer/panel boundary, then replace the referral-only behavior. Add useful renderer modes, history, targeted selection, and a supported local comparison. Save basic agent names, representation references, and configuration revisions through the authority confirmed at Gate 0.

Primary seams: `src/components/artifacts/artifact-model.ts`, `artifact-view.ts`, `artifact-panel.tsx`, `artifact-referrer.tsx`, `artifact-registry.tsx`, existing document/App owners, and the agent-definition/profile authority confirmed at Gate 0. Preserve the existing renderer catalog and execution boundaries.

**Exit:** one live App survives inline/docked/expanded presentation changes without duplicate startup; a historical view stays fixed; the same artifact reopens from a project after changing chats. A document and a visualization exercise the same viewer contract. The agent identity survives a new run and a client restart.

### Gate 4 — Prove portable agents

Implement definition/template and selected-memory exports, dependency checks, and copy/import identity semantics. Demonstrate both a compatible host-supplied store and standalone embedded Rusty Red ownership. Include or validate required assets/payloads. Checkpointed continuation is a separate capability with its own owner-transfer proof.

**Exit:** a named custom agent preserves selected characteristics, capabilities, and memory across a supported export/import. Missing bindings are explicit. A copied agent has a new identity with lineage; no credentials or unselected private context are silently included.

### Gate 5 — Prove provider interchange and advanced arrangements

Add one materially different knowledge/retrieval provider and isolated evaluation forks from the same baseline. Validate declared capabilities and keep the execution journal's guarantees intact. Extend simultaneous interactive views, remote/client handoff, and cross-window presentation only where their renderer/provider contracts support them.

**Exit:** the comparison records exactly what changed, candidates are isolated, and a provider failure does not silently change memory. Additional layout freedom preserves the same view/execution distinctions proven earlier.

## 14. Acceptance and evidence

Add these cases to the existing workbench acceptance system rather than creating a parallel testing authority. Record each as pass, fail, or not run. Each result includes source revision, build, environment/provider, reproduction steps, observed IDs/cursors, and relevant receipts or captures.

Source inspection proves wiring. Deterministic reducer/replay tests prove ordering, stale-result handling, and layout state. Browser interaction proves accessible behavior and focus. Live owner/provider tests prove persistence, input control, stop semantics, and actual continuation. A gate requiring live evidence remains unproven when only mocks or replay are available.

| Case | Scenario and required evidence | Requirements |
| --- | --- | --- |
| AC-01 | Start two assignments for one named agent and another unrelated assignment. Preserve one agent identity, distinct run IDs, accurate grouping, and no invented collaboration. | ID-01, WS-03, AG-01 |
| AC-02 | Observe a native side chat, a delegated specialist, and an external terminal session together. Each uses its existing owner; instrumented and uninstrumented states remain distinguishable. | OW-01–02, ST-01, API-01–03 |
| AC-03 | Repeatedly open a compact entry using double-click, keyboard, and touch-equivalent controls; expand and restore. Assert unchanged run/resource IDs and no extra launch request. | CP-01–04, DR-03, UX-02 |
| AC-04 | Close and reopen a running side-chat view and a terminal view after more output occurs. Verify work continued. Separately Stop and verify acknowledgment, affected child scope, and final outcome. | IN-06–07, RC-01–02 |
| AC-05 | Type a draft for agent A while viewing B and receiving output from C. Confirm recipient, draft, focus, order, and scroll remain unchanged; subsequent submission reaches A once. | UX-04, IN-01, WS-02 |
| AC-06 | Issue an agent command to an exact terminal while the user changes focus. The target remains fixed. Try a duplicate label and a deleted ID; no input reaches a fallback pane. | API-05–07 |
| AC-07 | Take terminal control, select/copy output, close the controlling view, and disconnect a client. Verify lease release/expiry, stale-controller fencing, explicit reacquisition, and no process kill. *Restated by Gate 0 decision 1 (no lease, see IN-03): recorded as `UAE-AC-07` in the acceptance file.* | IN-02–03, UI-05 |
| AC-08 | Create auxiliary work while the user reads. Preserve visible geometry and focus. An explicit show-beside instruction can place it deliberately; closing agent-created views leaves user-retained views intact. | IN-04, API-10 |
| AC-09 | Deliver duplicate/out-of-order events, equal offsets on different resources/epochs, a cursor gap, and a late view response. Reconcile without losing valid output, duplicating events, applying stale content, or launching work. | EV-01–04, ST-02 |
| AC-10 | Lose the response to an accepted terminal input or external effect. Inspect its receipt/outcome and reconcile; do not blindly resend. | RC-03, API-07 |
| AC-11 | Disconnect the observation channel while the host continues. Mark the display stale, recover current state, and keep stopped/completed/unknown outcomes accurate. | ST-01–03, RC-01 |
| AC-12 | Refresh a client, then separately restart an execution host. Demonstrate which resources reconnect, which resume through supported checkpoints, and which ended. Restored panes never masquerade as resumed runs. | RC-01–03, OW-03–04 |
| AC-13 | Open an artifact from a historical message, a producing run, and a project. Verify exact versus current revision semantics and resolution after switching chats. | AR-01–05 |
| AC-14 | Change a live App parameter; move inline → docked → expanded → restored; inspect source; close/reopen. Count startup executions and verify retained state and runtime identity. | AR-08–12 |
| AC-15 | Commit a new revision while an old view is selected. Keep the old view fixed; distinguish panel retention from revision selection; deliberately compare and follow current work. | AR-03–06 |
| AC-16 | Stream temporarily invalid source into an executable artifact. Retain the last valid result and accurate running revision; update only through the supported runtime operation. | AR-10–11 |
| AC-17 | Send a selected chart entity/text range with its base revision; concurrently edit the artifact. Reconcile or refuse precisely, preserving drafts and accepted edits without overwriting another object. | AR-07, AR-13 |
| AC-18 | Produce ordinary waiting/failure transitions and one genuine decision request. Update local activity; present the one decision once; add no demand queue, extra questions, priority sorting, or focus takeover. | UX-05–06, IN-05 |
| AC-19 | Narrow and widen the container; expand the composer; use keyboard, screen reader semantics, touch, and reduced motion. Preserve arrangement, usable input, readable state, and equivalent actions. | DR-01–04, UI-01–05 |
| AC-20 | Run the documented performance workloads and sustained session. Record input/reveal latency, memory/queue behavior, stream gaps, and preview cadence. | UI-06, Section 12.1 |
| AC-21 | Rename/customize an agent, run it again, and restart the client. Verify durable identity, saved characteristics, unchanged active-run configuration, and accurate attribution. | AG-01–05 |
| AC-22 | Fail an explicitly configured provider and exercise concurrent runs/scoped retrieval. Preserve the binding; do not create empty fallback memory or leak another agent's data. | DB-01–05 |
| AC-23 | Export/import a template and selected memory with external payloads. Check lineage, required bindings, missing-object handling, and independence from window geometry. | PT-01–04 |
| AC-24 | Evaluate two provider configurations from one fixed snapshot. Verify candidate isolation, recorded differences, and unchanged source-agent memory. | Section 11.3 |

AC-01–21 gate the first coherent release as applicable to its supported providers. AC-22–23 gate portable state; AC-24 gates provider experiments. Cross-host continuation requires additional provider-specific failure/ownership-transfer cases before it can be advertised.

### 14.1 First product demonstration

Use three real assignments: a code change, an unrelated research task, and an external terminal task. Give at least one agent a user-created identity. Produce an interactive artifact with a visible parameter and a saved result.

1. Begin in the normal conversation and compact activity component.
2. Open the code run into the drawer; keep the composer usable.
3. Retain another run beside it, then expand the whole agent workspace.
4. Inspect older output while the other assignments continue. Focus and order remain stable.
5. Open the produced artifact beside conversation through Dockview; change its parameter.
6. Move/expand the artifact, inspect its source, and return to the same live instance.
7. Ask for a change using a precise artifact selection; inspect an older revision while the new one arrives.
8. Close the work views; reopen the same runs and artifact without another launch.
9. Disconnect/reconnect observation; show truthful stale and recovered states.
10. Stop one selected run explicitly. Show its acknowledged outcome while independent work continues.

The demonstration is successful when people can identify the agents, their assignments, and the selected result without monitoring every stream or clearing a queue. Record the technical identity/lifecycle evidence separately from the presentation recording.

## 15. Defaults selected and bounded follow-ups

The following choices resolve ordinary design ambiguity for implementation: drawer is the initial Open work destination; project/workspace is the initial scope; order follows insertion; selecting a run is observational; agent-created auxiliary work stays in the background; historical links select historical revisions; panel retention and revision-following are separate; executable artifacts initially support one interactive attachment per runtime unless their renderer proves more.

Remaining work is technical verification rather than a new product approval round: map owner inventory endpoints, establish the terminal provider's arbitration/lease semantics, identify the artifact runtime transfer mechanism, measure reference-device performance, and enumerate which providers support restart continuation. Record each result in Gate 0 or its relevant delivery gate. Do not fill a missing capability with optimistic UI wording.

Optional future capabilities include cross-window handoff, more than one connected interactive artifact view, richer saved arrangements, advanced character authoring, and checkpoint migration across compatible hosts. They inherit the identity, attention, and lifecycle rules in this specification.

## Sources and related design records

Official external documentation was checked on 25 November 2026. Repository links are pinned source evidence. Local project handoffs are intent/history, with their compatibility boundaries stated in Section 5.1.

[R1]: https://www.superlogical.com/rex/docs/automate/cli
[R2]: https://www.superlogical.com/rex/docs/automate/agent-skill
[R3]: https://www.superlogical.com/rex/docs/reference/api
[R4]: https://www.superlogical.com/rex/docs/build/program-status
[R5]: https://www.superlogical.com/rex/docs/features/session-restore
[D1]: https://dockview.dev/docs/core/panels/rendering/
[D2]: https://www.assistant-ui.com/elements/canvas-split
[T1]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/docs/plans/theo-workbench/SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0.md
[T2]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/docs/plans/theo-workbench/ARCHITECTURE.md
[T3]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/components/shell/dock.tsx
[T4]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/terminal/crates/workbench-dock/src/lib.rs
[T5]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/lib/workbench/agent/sessions.ts
[T6]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/lib/workbench/conversation/port.ts
[T7]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/lib/workbench/adapter.ts
[T8]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/lib/theorem/delegations.ts
[T9]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/lib/workbench/terminal/session.ts
[T10]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/lib/workbench/conversation/side-chats.tsx
[T11]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/components/artifacts/artifact-model.ts
[T12]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/components/artifacts/artifact-referrer.tsx
[T13]: https://github.com/Theoremrs/Theorem-UI/blob/c1a0e4b26acb4beb7e6595fcd47b9fc89c20f3cd/src/components/artifacts/artifact-registry.tsx
[P1]: (private handoff held outside this repository; link withheld from the public copy)
[P2]: (private handoff held outside this repository; link withheld from the public copy)
[P3]: (private handoff held outside this repository; link withheld from the public copy)
[A1]: (private handoff held outside this repository; link withheld from the public copy)
