# Closing the gap: interactive particle artifacts in Theorem answers

> Superseded in part on 2026-11-17: agents no longer draw answers through SceneOS, whose catalog bound them to fixed parts. They write their own App in TypeScript (see "Direction change" in `interactive-answer-artifacts.md`). The SceneOS-specific packages below are kept as history.

**Execution plan · November 17, 2026 · Planning deliverable; no product implementation or deployment performed**

## 1. Decision

Finish the existing SceneOS explanation path and connect it to Theorem’s common artifact lifecycle. Current main already contains LumaGL cell rendering, executable agent-authored models, normal conversation tool registration, durable scene message parts, and a live chromeless inline viewer. The remaining work is to make that capability observable, revisioned, resumable, available to subsequent agent turns, and verified in the running product.

Begin by establishing which frontend and backend versions are actually running. The inspected local Theorem checkout does not contain the scene-authoring integration present on current main. This is a concrete version discrepancy, but it is not yet an established explanation for the deployed product’s behavior.

The first completion test is an ordinary conversation in which the agent creates an interactive explanation, the person changes it, the agent answers about that exact state, a revision changes the same artifact, and the person returns later with the declared state restored. The CPU example is the first fixture. A different subject must pass through the same authoring and lifecycle path.

## 2. Intent recovered from prior conversations

These are summaries retrieved from prior conversation context, not verbatim transcripts. Stable links to the original conversations were not returned. Earlier assistant suggestions are distinguished from the user’s requirements.

| Conversation | Requirement to preserve | Design interpretation |
| --- | --- | --- |
| September 30 | Discoveries can become explorable “experiments”; creation and play matter; distinguish observed, inferred, and assumed content. | Keep model assumptions visible and preserve provenance. |
| November 7, afternoon | Web first, Platinum later; use LumaGL particles/cells to explain a question such as “How does a CPU work?” through SceneOS and the procedural engine. | A meaningful executable explanation appears within the answer. |
| November 7, evening | Attractive inline artifacts, including code, images, simulations, and notebooks. | The earlier assistant proposed a common artifact runtime, renderer contributions, and multiple presentations of one artifact. |
| November 8 | Particles are useful for some subjects; ordinary/OpenUI artifacts remain useful. Inline apps should avoid unnecessary titles, chrome, and an “Interact” gate. | Preserve the existing chromeless SceneCard when integrating it with the artifact system. Do not make every artifact a particle scene. |
| November 13 | Meaningful objects and behavior should compose and retain continuity; native Rust GPU rendering is acceptable. | LumaGL is a web implementation choice, not a required native dependency. |
| November 14 | Theo’s larger programmable environment and React-compatible web surface remain in scope; delivery milestones must not shrink that ambition. | Deliver the web lifecycle first while preserving portable identities, state, and operations for native consumers. |

The November 10 expressive-presence handoff also documented a real SceneOS Luma 9.4.2 renderer and identified the difference between admission and browser execution. The avatar/presence work is related infrastructure; it does not itself provide the answer-artifact lifecycle. [H1]

### Product acceptance

A completed explanation capability must let a person:

1. Ask a normal question and receive prose with a useful live explanation in the same answer.
2. Select meaningful objects, change inputs, step or otherwise operate the model, and see behavior that follows its declared semantics.
3. Ask about the selected object and the exact state currently visible.
4. Have the agent inspect and revise the same artifact with revision checks.
5. Expand and return without resetting it.
6. Change theme, navigate away, reload, and deliberately reopen with the declared saved state.
7. Understand its assumptions, supported behavior, and any failed checks.
8. Use a useful fallback when GPU execution is unavailable.
9. Receive the appropriate ordinary UI, chart, notebook, or particle presentation for the subject.

A reusable capability must also handle a second subject through the same path. Passing only a manually authored CPU demonstration does not satisfy this acceptance.

## 3. Audit baseline and evidence

### Revisions

| Repository/surface | Revision inspected | What it establishes |
| --- | --- | --- |
| Theorem remote main | `a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704` | Matched read-only `git ls-remote` during this audit; commit dated November 17, 09:38 ET. |
| Theorem-UI remote main | `5ee9b58822454cc26fa163baff78f1dd0794ec8e` | Matched read-only `git ls-remote`; commit dated November 17, 09:22 ET. |
| Theorem local checkout | `8ae25c2c14ee4c1b97cd555935b9ff0e0ed010fb`, branch `cursor/native-e2e-verification-fc4c` | Dirty shared checkout. Its HEAD and working files lack the main-branch scene operation, authoring guide, conversation installation, and scene-host route. |
| Theorem-UI local checkout | `a869ad8b3843525098d46ae1cdd490a646a77d04`, branch `feat/motion` | Dirty older checkout; main was inspected separately using Git object reads. |
| Platinum remote main | `4724f7deec972b29f47febf39117655ddbfce0e9` | Current remote commit verified and selected files read through the GitHub API. The locally cached main, `4ba51e3c6350dab0130037d5a91d8873acf76c8a`, was stale. |
| Deployed signed-in frontend/backend | Not established | A public GET of `https://theorem.rs/api/scene/v1/host` returned 401. This is an authentication result, not evidence of a broken scene host. |

Repository reads were pinned to the revisions above. No checkout, pull, reset, stash, source edit, or service restart was performed.

### Checks executed

A temporary copy of the pinned Theorem SceneOS web tree was used, with its lockfile dependencies and sibling scene-contract fixtures.

| Check | Result | Limit |
| --- | --- | --- |
| Headless smoke/projection tests | Passed | Does not draw GPU pixels. |
| Headless explanation/runtime tests | Passed; 198 reported checks | Includes authored model and behavior checks; does not establish live model authoring or browser execution. |
| Headless cells tests | Passed | Verifies geometry, motion, picking logic, identity, budgets, and labels outside a real GPU. |
| Headless embed protocol tests | Passed | Protocol checks, not a deployed iframe round trip. |
| Headless callout tests | Passed | Layout calculations, not visual inspection on every browser. |
| `npm run typecheck` | Passed | Type correctness only. |
| `npm run build` | Passed; rebuilt bundle exactly matches committed bytes | Confirms the audited committed asset is synchronized with its sources and locked build. |
| Signed-in real-agent/browser/GPU journey | Not run | Required before product completion. |
| Rust suites and UI component suites | Not run in this audit | Source and test inventory were inspected. |

The first aggregate headless run lacked sibling contract fixtures in the temporary extraction. The missing fixture directory was copied from the same pinned revision; the explanation group then passed. This was an audit setup issue, not a demonstrated source regression. Other groups had already passed and were not repeated.

Bundle SHA-256, both committed and rebuilt:

`26ceaabb5451f26a0727ed3b73f4ee192e2963cebbed1c304a5d3f853fe174ca`

## 4. Current implementation and remaining gaps

### 4.1 The agent creation path exists

On normal owner conversation turns, `conversation_scene::install` installs `show_scene` in the native operation catalog. The conversation prompt includes `scene.md` when that capability is available. The operation compiles and validates the model, appends a durable scene part, and returns a compact receipt. The single-agent narrowed catalog and foreground work handoff retain the capability. Public visitor and several non-conversation job types are intentionally excluded. [B1] [B2] [B3]

Main supports authored model source rather than only a CPU lookup. The integration test authors a two-bit adder and verifies that its source survives into the stored scene; it explicitly avoids steering the model toward the RV32I catalog. That proves transport behavior using a scripted provider, not the reliability of an actual model writing arbitrary explanations. [B4]

**Gap:** availability and behavior in the running deployment remain unverified. Existing prompt/tool registration should be preserved and measured before changing routing policy.

### 4.2 SceneOS already has substantial rendering and behavior machinery

The web renderer uses Luma 9.4.2, WebGL2 instanced quads, D3 geometry/motion helpers, semantic picking, cell identity across expansion, reduced motion, GPU readback backpressure, and a Canvas2D fallback. It includes a CPU model, authored executor support, walkthroughs, inputs, checks, and live presentation patches. [R1] [R2] [R3]

The current explanation contract is broader than a CPU template but still constrained: state is integer/bit-width oriented, operations are step/finish/reset, connections use data/address/control/carry, and some shape/layout rules are circuit-oriented. Continuous scientific models and an unrestricted visual grammar are not already established by the presence of JavaScript source. [R4]

**Gap:** prove broad authoring through the existing contract and deliberately extend semantics when a new domain requires them. A renderer rewrite is not the starting task.

### 4.3 Live inline display exists

The UI recognizes `theorem-scene-v1`, mounts the scene-host iframe immediately, provides a wide chromeless scene, handles failures, and offers entity-level Ask. Expansion promotes an existing dialog to the top layer without recreating the iframe. Streaming more text does not restart the scene. [U1] [U2] [U3]

**Gap:** changing theme or Ask capability remounts the package. There is no checkpoint/restore protocol. The initial timeout is not rearmed for those later remounts. Expansion continuity is already implemented; navigation/reload and remount continuity are not.

### 4.4 Authored packages are durable; exploration state is not

The complete scene package and source are stored with `CHAT.MESSAGE.PART`. The scene flow test reloads the completed conversation and verifies this. Calling scenes “unpersisted” would be inaccurate. [B2] [B4]

However, scenes are emitted as their own message-part family. The UI’s artifact registry has contributions for Apps, OpenUI, Observable, marimo, documents, code, and diagrams, but none for SceneOS. `useThreadArtifacts` enumerates `theorem-artifact` parts. The scene’s standalone model does not carry the common artifact revision, producing run, lifecycle, or checkpoint identity. [U4] [U5]

**Gap:** integrate the existing durable scene definition with canonical artifact identity, revisions, enumeration, workspace opening, and source/export behavior. Preserve historical scene messages.

### 4.5 The agent does not receive browser execution evidence

`shown: true` is returned after server-side validation/admission. The authoring guide explicitly states that model-code failures and failed checks appear to the person and are not returned in the receipt. The UI handles local mount/runtime messages but does not upload them through an authority-side execution receipt in this path. [B1] [B3] [U2]

The normal App authoring path already demonstrates the desired pattern: revisioned writes, standard artifact parts, a client `app__check`, and explicit `notChecked` when no page can observe execution. [B5]

**Gap:** reuse this client-operation/receipt infrastructure and distinguish acceptance from observed execution. Do not add a second general receipt bus.

### 4.6 Conversational continuation loses the relevant model state

Ask currently carries scene ID/title, an entity description, and a message reference. It omits exact artifact/model revision, package hash, runtime instance, step/cursor, selected values, and checkpoint/state digest. Default conversation history projections include text parts rather than scene semantics. [U3] [B6]

`render_scene_patch` and `ScenePatchV1` already validate presentation operations. There is no corresponding normal conversation route that targets an existing scene instance, resolves its revision, delivers the patch, and returns its application result. `show_scene` remains a creation operation. [B1] [B7]

**Gap:** a bounded reference plus read/update operations must connect the visible experiment to the next turn.

### 4.7 Execution and rendering need a lifecycle suitable for long chats

The view skips drawing when its document is hidden and destroys its resources on teardown. It does not know that its card is below the visible conversation. The UI App preview already offers IntersectionObserver/poster machinery that can inform scene suspension. [R5] [U6]

Authored executors are prepared on the iframe’s main thread; formatting helpers can also execute there. `RuntimeClient` has an initialization timeout, then falls back to the page thread. Regular worker calls have no deadline or worker-error completion path in the inspected client. Exceptions are caught, but a synchronous infinite loop is a different failure mode. [R6] [R7]

The runtime also returns the full growing trace in snapshots. Long-running interaction needs explicit trace retention/checkpoint policy. These are source-level responsiveness risks; this audit did not measure them as causes of the previously reported composer lag.

**Gap:** bounded execution, instance suspension, and bounded history are part of making generated explanations dependable.

### 4.8 Native and historical particle work are useful but separate

On current Platinum main, transcript artifacts render as fallback text plus an Open action. Theo’s particle face updates Rust arrays and paints grains through GPUI; it is presence rendering. The native `src/scene.rs` is a Servo texture bridge. These do not establish an inline native SceneOS explanation consumer. [N1] [N2] [N3]

The old `Codex/agpui-particle-field-1.0` and `Codex/particle-test-linear` heads are not ancestors of current Theorem main. Their scope is expressive presence and a separate CPU particle fixture with unfulfilled compositor/artifact obligations. Reviving their retired `apps/theoremweb` packaging would contradict current frontend ownership. The active SceneOS web root already supplies the relevant renderer.

## 5. Architecture to preserve

Use existing owners and add the missing connections.

| Layer | Authority | Required behavior |
| --- | --- | --- |
| Artifact definition | Existing artifact/revision owner | Immutable definition revision, model source, package, checks, assumptions, provenance, content hash, producing run. |
| Semantic model | SceneOS/scene-contract and the appropriate model provider | Meaningful components, relations, state, inputs, operations, explanations, and validation independent of GPU objects. |
| Runtime instance | SceneOS execution host plus canonical checkpoint storage | State, phase/latches, controlled clock, input history, selection and disclosure; restore only against a compatible definition. |
| Conversation context | Existing turn-context admission | Bounded exact references and relevant state; full model fetched when needed. |
| Presentation | SceneOS renderer contribution and UI shell | Inline, expanded, and workspace views of the same identity; renderer resources can be discarded and recreated. |
| Execution feedback | Existing client-operation/receipt path | Accepted, mounted, running, checks, failed, interrupted, unobserved outcomes with instance/generation correlation. |

Do not persist particle buffers or every rendered frame as application state. Preserve meaningful state and a deterministic restoration policy.

Keep the dependency boundary explicit: SceneOS is pinned to Luma 9.4.2; the current UI face uses 9.3.6 because of its Cosmos constraint. Share renderer-independent semantics or field primitives where useful. A blanket Luma upgrade or a forced single rendering package is not part of closing this gap. [R3] [U8]

### Definition versus instance

The definition must name artifact ID/revision, package hash, model ID/version, model/checkpoint schema, source dependencies, assumptions, and producing run.

The instance must name its definition revision, instance ID, monotonically increasing checkpoint sequence, semantic state digest, declared model state, phase cursor, latches, and restore-required internal state. It should also retain relevant selection, opened subcomponents, fidelity, and optional camera position.

The existing `RuntimeSnapshot` is a useful starting point, but it is not a complete restore contract. The runtime privately stores the start-of-instruction snapshot and trace boundaries used to recompute mid-instruction edits. Restoring only displayed register values can produce a different next step. Define an explicit versioned serialization/restore interface or a bounded deterministic input-log replay that reconstructs all required state. Authored executors must not rely on unsaved hidden mutable closures if they claim resumability.

Checkpoint on committed user operations and meaningful lifecycle boundaries, with debounce/coalescing where needed. Persist model-definition changes as artifact revisions; model stepping updates the runtime checkpoint. Opening an old revision must be deliberate and must not silently overwrite the current definition.

## 6. Work packages

All packages below are **planned**, not implemented by this audit. Owner names refer to existing components.

### W0 — Establish the running baseline

**Priority:** first. **Dependencies:** none.

**Owners/files:** deployment manifests and provenance, `theorem_scene_host.rs`, Theorem-UI `src/routes/api/scene/v1/$.ts`, `src/server/theorem-proxy.ts`.

Tasks:

- Record the intended active frontend and backend source revisions, actual running build identifiers, and SceneOS bundle hash.
- Determine whether the local branch divergence affects the service used by theorem.rs or only another checkout.
- Use a safe dedicated build/checkout arrangement if synchronization is needed; preserve the dirty shared working trees.
- Verify that the signed-in ordinary owner conversation receives `show_scene`.
- Send the initial CPU question through that conversation and observe the actual host route, first frame, runtime, and controls.
- Record explicit outcomes for tool absent, route/auth error, package refusal, worker failure, renderer fallback, and success.
- Confirm the UI and authority protocol versions are compatible.

**Accepted when:** a fresh real conversation creates and operates a scene on identified running versions; the evidence includes the real tool call, persisted part, browser observation, and computed state change. A fixture page alone does not satisfy this row.

### W1 — Return execution results and make authored models interruptible

**Priority:** critical. **Dependencies:** W0 for deployed proof; implementation may proceed alongside W2.

**Owners/files:** `agent/src/operations/scene.rs`, `scene.md`, server `conversation_scene.rs`, existing client operations, UI `scene-model.ts` and `scene-part.tsx`, SceneOS `embed.ts`, `explain/client.ts`, `host.ts`, `source.ts`, `view.ts`.

Tasks:

- Change the semantic receipt to distinguish persisted/admitted from mounted/running. Preserve wire compatibility explicitly if keeping the existing `shown` field during transition.
- Reuse the App path’s client-check transport. Return renderer/runtime versions, supported mode, first-frame result, model check outcomes, and useful fault locations.
- Attach artifact revision, instance ID, invocation ID, and mount generation to each relevant message/receipt. Ignore stale replies.
- Rearm mount watchdogs for every actual mount and settle outstanding calls on worker error, timeout, termination, or supersession.
- Execute generated model factories, phases, and generated formatting computations in a terminable worker. Return validated display values to the trusted view.
- Keep Canvas2D as a rendering fallback. If generated execution cannot be isolated, show an inert explanation with a clear status instead of moving arbitrary computation onto the UI thread.
- Enforce operation deadlines and bounded input, declared state, output, and trace sizes; retain useful errors and a last valid checkpoint. A terminable Worker does not provide a hard memory quota for arbitrary JavaScript allocations. Any stronger memory-isolation guarantee requires an appropriate execution boundary and its own evidence.
- Give the agent the actual failure result and support a bounded repair attempt through the revision path. Do not automatically run an unbounded repair loop.
- Treat passing self-authored checks as model-check results, not independent proof of scientific correctness.

**Accepted when:** a valid authored model runs; a syntax error, thrown phase, failed check, startup loop, and phase loop produce distinct bounded outcomes; the chat stays responsive; the agent receives the relevant failure; a repair targets the same artifact and succeeds on a new revision. When no browser is connected, return an explicit unobserved result.

### W2 — Make scenes first-class artifacts

**Priority:** critical. **Dependencies:** W0; coordinate envelope with W1.

**Owners/files:** current artifact storage/revision owner, `conversation_scene.rs`, App publication pattern in `conversation_app_turn.rs`, UI `artifact-registry.tsx`, `artifact-renderers.tsx`, `artifact-model.ts`, and `theorem-parts.tsx`.

Tasks:

- Emit a canonical artifact envelope carrying identity, revision, renderer contribution, lifecycle, producing run, payload reference/hash, and ordering fields.
- Keep `ScenePackageV2` and the semantic model under their existing owners.
- Register a SceneOS contribution that delegates rendering to the current SceneCard/runtime.
- Make scene artifacts appear in the same thread enumeration, revision selection, workspace-opening, source/export, and provenance paths as appropriate existing artifacts.
- Preserve the chromeless, immediately interactive presentation as contribution policy. Do not wrap SceneCard in a generic passive preview that requires an extra Interact click.
- Add an explicit compatibility reader for saved `theorem-scene-v1` parts. Resolve each historical part to a stable identity; do not generate a new artifact on every render or duplicate it on stream replay.
- Use existing idempotency and ordering patterns to handle retransmitted/replayed message parts.

**Accepted when:** one artifact identity is discoverable from its answer and artifact/workspace views; revisions resolve to exact definitions; historical conversations still render; reconnect/replay produces no duplicates; ordinary artifact kinds continue through their current contributions.

### W3 — Preserve state through presentation and lifecycle changes

**Priority:** critical. **Dependencies:** W2 and W1 correlation/worker lifecycle.

**Owners/files:** SceneOS `runtime.ts`, `host.ts`, `client.ts`, `entry.ts`, `embed.ts`, `view.ts`; UI `scene-model.ts`, `scene-part.tsx`; canonical checkpoint persistence.

Tasks:

- Implement the versioned checkpoint/restore interface described above.
- Add theme/capability updates that do not recreate the semantic runtime.
- Preserve the same instance during inline/expanded transitions; the existing same-iframe dialog behavior is the starting point.
- Restore exact model state after navigation/reload. Keep definition revision compatibility explicit.
- Save selection, disclosure/fidelity, and other declared meaningful view state.
- Define handling for simultaneous tabs/devices using instance ownership and expected checkpoint sequence; reject stale overwrites.
- Define what happens when an updated model is incompatible with the old instance: migrate only through a declared migration, otherwise preserve the prior instance and offer a deliberate restart.
- Keep simulation time separate from rendering time. Reopening should not advance a teaching model by elapsed wall-clock time unless that behavior was declared.

**Accepted when:** a mid-instruction edited CPU resumes with the same next-step result; changing theme preserves state; expansion/return preserves identity and selection; reload restores a checkpoint; an incompatible revision and concurrent stale checkpoint are handled explicitly.

### W4 — Let the agent inspect, explain, and revise the live experiment

**Priority:** critical. **Dependencies:** W1–W3.

**Owners/files:** `agent/src/operations/scene.rs`, `agent/src/scene.rs`, `scene.md`, conversation history/context admission, `conversation_scene.rs`, UI entity Ask/reference bridge, SceneOS patch host.

Tasks:

- Add conversation-facing operations to read a scene definition/revision, read a bounded runtime state summary, and revise/apply allowed presentation operations to a named target.
- Reuse `ScenePatchV1` and the current presentation patch validator. Structural/model changes produce a new compiled definition revision.
- Require the expected definition revision and, where needed, checkpoint sequence; return a conflict instead of silently changing a later state.
- Deliver accepted operations to the correct instance and return an applied receipt after execution.
- Extend Ask with exact artifact/model revision, checkpoint/state digest, semantic entity, relevant current values, and a bounded recent trace.
- Pass references through the existing context-admission budget. Retrieve larger source/model content on demand.
- Retain real entity/operation IDs across compatible revisions. Explain identity changes when structure is replaced.
- Allow a source repair or a presentation-only change without creating an unrelated duplicate artifact.

**Accepted when:** after editing a register or input, “Why did this change?” answers from the edited state; “show the overflow path” changes the existing scene and returns an execution receipt; a stale revision is rejected; a source correction preserves artifact identity with a new revision.

### W5 — Make inline scenes behave well in long conversations

**Priority:** release requirement. **Dependencies:** W3 lifecycle; can be developed alongside W4.

**Owners/files:** UI `scene-part.tsx`, existing App preview visibility/poster conventions, SceneOS `view.ts`, `cells/luma.ts`, runtime trace/checkpoint handling.

Tasks:

- Observe card visibility and suspend inactive render loops while retaining meaningful state.
- Preserve the existing hidden-document draw guard and teardown; add explicit suspend/resume rather than relying only on browser throttling.
- Bound concurrently active GPU contexts/runtimes at the conversation level. Select the actual budget from measurements on the target devices.
- Retain a still preview and accessible explanation when a scene is suspended.
- Bound trace retention; use checkpoints plus incremental entries rather than repeatedly copying an indefinitely growing trace.
- Recover or offer a useful fallback after context loss; discard resources and listeners deterministically.
- Ensure reduced motion changes visual movement without changing the model’s numerical result.
- Measure composer input and sidebar interaction with zero, one, and multiple historical scenes. This checks a relevant risk without assuming scenes caused earlier latency.

**Proposed measurable targets:** warm visible control response p95 below 100 ms on the reference machine; no draws for fully offscreen paused cards; no accumulating worker/context count after repeated open/close; no sustained main-thread task over 50 ms attributable to generated execution. First-frame budgets should be set from a recorded cold/warm baseline.

**Accepted when:** the benchmark records reference device/browser, scene sizes, active-instance counts, and latency; offscreen scenes suspend and restore correctly; the tested startup-loop, phase-loop, oversized-output, and worker-failure cases terminate within declared limits while the composer remains responsive; memory/resources return to a stable baseline for the tested workload.

### W6 — Prove and extend expressive generality

**Priority:** required before claiming a reusable answer capability. **Dependencies:** W2–W4.

**Owners/files:** `scene.md`, scene-contract, procedural/model providers, SceneOS geometry/material/projection interfaces, relevant fixtures.

Tasks:

- Keep the CPU example as the established integration fixture.
- Add a second agent-authored subject through the same API and lifecycle. Recommended first candidate: a producer/consumer queue showing arrivals, service, backlog, and throughput, with semantic jobs/queues/workers and adjustable inputs.
- Require the agent to create or adapt source, structure, checks, and narration from the request; do not route by a hidden hardcoded demo lookup.
- Improve reusable component/material/path primitives where the second subject currently inherits circuit-specific appearance.
- Keep geometry, procedural layout, simulation behavior, and visual material separate. Meaningful picking resolves jobs/components/relations, not transient particle indices.
- Expose assumptions and distinguish illustrative, inferred, and measured values.
- Evaluate continuous models explicitly. If the intended next subject requires real-valued physical state, add a versioned typed-state/time/units contract or a suitable simulation-provider adapter. Do not pretend the current integer/bit-width contract already covers that requirement.
- Preserve the existing OpenUI, Observable, marimo, and ordinary artifact routes. Their contributions are present in code; their complete execution paths need their own evidence when claimed.
- Keep the generalized procedural engine’s glTF path available for structured 3D outputs. A mandatory glTF round trip is unnecessary for every 2D answer scene.

**Accepted when:** a real model generates a useful non-CPU explanation using the common operation, renderer contribution, state, revision, repair, and reopening paths. A human can interpret its behavior and assumptions. The second fixture demonstrates reuse; it does not limit the future authoring vocabulary to two subjects.

### W7 — Verify the complete product path and release it coherently

**Priority:** final web completion gate. **Dependencies:** W0–W6.

**Owners/files:** existing UI end-to-end harness, Rust scene transport/host tests, SceneOS browser journeys, build/deployment manifests and implementation records.

Tasks:

- Add a real-agent, authenticated browser journey using the actual UI proxy and scene-host response.
- Verify both authored-model creation and a controlled fixture, keeping their evidence distinct.
- Exercise selection, stateful Ask, revision, failed-check repair, expansion, theme, navigation, reload, and offscreen suspension.
- Run Chromium for diagnosis and Firefox on the primary Mac workflow; include an appropriate mobile/touch pass and the supported Safari/WebKit path before claiming that support.
- Verify Canvas2D/inert-model fallbacks and context/worker failure outcomes.
- Check keyboard access, focus return, readable labels, zoom/narrow layout, reduced motion, and text alternatives. Existing HTML controls and tests are reusable.
- Confirm the deployed backend embeds the expected SceneOS bundle and the UI understands its protocol.
- Record exact model/provider, revisions, browser/device, outcome, latency, and failure/repair traces.
- Document evidence honestly: scripted transport tests, headless model tests, actual GPU execution, and real model authoring establish different properties.

**Accepted when:** the acceptance journey below passes on the intended deployed environment, the artifact can be reopened, both subjects work, and there are no silently substituted fixtures in the real-agent evidence.

### W8 — Carry the same artifact into native Theo/Platinum

**Priority:** subsequent native milestone; retained product scope. **Dependencies:** shared W2–W4 contracts and a verified current native baseline.

**Owners/files:** Platinum transcript artifact handling, native artifact host/operation bridge, scene-contract consumers, supported webview/GPUI renderer adapter.

Tasks:

- Make native transcript/workspace projections resolve the same artifact IDs, revisions, and checkpoints.
- Add a native semantic action/context bridge with the same read/update/receipt semantics.
- Choose and verify the supported first presentation adapter: a web surface can reuse the web runtime where its capabilities actually work; a Rust GPU adapter can consume the portable semantics.
- Keep native particle-presence code separate from simulation correctness.
- Avoid requiring a literal LumaGL port into GPUI.
- Preserve same-artifact continuity across a note, an agent response, and the native expanded view.
- Do not infer SceneOS support merely from the existence of a Servo texture bridge or GPUI-painted face particles.

**Accepted when:** the same artifact revision opens and operates in native Theo, selection/context survives a presentation change, and reopening restores its declared checkpoint. Web and native need semantic/result agreement; pixel-identical output is not required.

## 7. Delivery order and oracle ledger

Recommended order: W0 first; W1 and W2 can proceed together; W3 follows their shared identity/lifecycle contract; W4 and W5 follow; W6 proves generality; W7 gates the web release. W8 follows the shared lifecycle and has its own native gate.

No additional general-purpose artifact store, event bus, renderer framework, or retired frontend is required by this plan.

The following fields follow the repository’s oracle checklist convention. All rows are planned; `evidence_class` is `not_run` for the new work, even where the audit verified existing underlying code. Every row has `substitution_allowed=false` and `live_oracle_required=true`.

| ID | oracle_class | implementation_mode | evidence_class | substitution_allowed | live_oracle_required | Live scenario |
| --- | --- | --- | --- | --- | --- | --- |
| W0 | production | deployed_runtime | not_run | false | true | baseline |
| W1 | integration | network_client | not_run | false | true | receipts-and-bounds |
| W2 | substrate | substrate_backed | not_run | false | true | artifact-identity |
| W3 | integration | db_backed | not_run | false | true | restore |
| W4 | integration | network_client | not_run | false | true | followup-and-revision |
| W5 | integration | local_process | not_run | false | true | lifecycle-and-performance |
| W6 | integration | local_process | not_run | false | true | generality |
| W7 | production | deployed_runtime | not_run | false | true | release |
| W8 | integration | local_process | not_run | false | true | native-continuity |

**Proposed test entry points to implement, not commands claimed to exist today:**

- W0–W7: `THEOREM_RUN_INTERACTIVE_ANSWERS=1 node scripts/e2e/interactive-answers.mjs --case <scenario> --base-url "$THEOREM_E2E_BASE_URL"`, in Theorem-UI, with each scenario above substituted literally in its execution checklist.
- W8: `THEOREM_RUN_NATIVE_INTERACTIVE_ANSWERS=1 scripts/test-native-interactive-answers.sh --case native-continuity`, in Platinum.

The implemented runner must use the existing authentication/test configuration. With the opt-in gate enabled, absent credentials, missing endpoints, unsupported hardware, and missing browser dependencies must fail or report blocked explicitly. They must never return a successful acceptance result. When these rows enter a repository checklist, expand the scenario into an exact `live_test_command` on each row.

Existing useful commands, run from the correct active SceneOS web tree:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm test` with sibling scene-contract fixtures present
- `npm run typecheck`
- `npm run build`

Existing browser journeys under `web/test/` include `explain-browser.mjs`, `written-browser.mjs`, and `embed-browser.mjs`. Inspect their arguments and prerequisites at the implementation revision. They complement, rather than replace, the new ordinary-chat journey. Rust tests remain under the owning `rustyredcore_THG` manifest and must follow the current pooled build-slot conventions.

## 8. End-to-end acceptance journey

Run from a fresh signed-in ordinary conversation on recorded versions.

1. Ask how a CPU adds two numbers.
2. Observe the real agent author a scene and the same reply mount it.
3. Confirm the receipt distinguishes admission from the observed first frame and model-check outcome.
4. Step the model and inspect expected register/state changes.
5. Change an input, select the relevant component, and ask why its value changed.
6. Verify the next agent turn uses the exact definition and checkpoint associated with that question.
7. Ask for a change in emphasis or an overflow explanation; apply it to the same artifact and observe an applied receipt.
8. Introduce a controlled model fault, receive its execution evidence, and repair it through a new revision.
9. Expand, collapse, change theme, navigate away, reload, and restore. Confirm the next model step matches uninterrupted execution.
10. Scroll the scene out of view, create additional scenes, and verify suspension and input responsiveness.
11. Exercise GPU/worker unavailable paths and retain an understandable fallback.
12. Create the queue explanation through the same ordinary path and repeat the critical identity/state/follow-up checks.
13. Verify that a suitable non-particle answer still selects its ordinary artifact renderer.
14. Reopen an older saved scene message and verify compatibility.
15. Record all results with the proper evidence class; leave blocked or unexecuted scenarios open.

## 9. What to start with

The first implementation assignment should combine the running-version investigation with one normal-chat browser proof. It will establish whether the immediate problem is missing deployed integration, poor model selection/authoring, or a failure after scene admission.

Then deliver artifact identity and real execution receipts, followed by checkpoint/restore and state-aware continuation. Those connections turn the existing renderer and model machinery into a dependable part of an agent’s answer.

The broader visual vocabulary and native adapter should build on that lifecycle. They remain explicit work in this plan, while the first release has a concrete, reviewable definition of completion.

## 10. Source index

All GitHub source links below are pinned to the audited revisions. Prior handoffs are design evidence, not proof of current deployment.

### Backend

- [B1 — Scene operation, request shape, durable payload, and receipt](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/operations/scene.rs). Key areas: request fields 25–39; payload 61–83; creation and receipt 154–230.
- [B2 — Normal conversation installation and durable observer](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_scene.rs). Key area: 18–51.
- [B3 — Agent scene authoring guidance](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/scene.md). Model authoring and receipt limitation: 4–22.
- [B4 — Authored scene flow and persistence tests](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/scene_flow_tests.rs). Key area: 55–102.
- [B5 — Existing App revision/publication/client-check pattern](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_app_turn.rs). Key areas: 79–160 and 177–207.
- [B6 — Conversation history projection](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_context.rs). Text projection: 116–160.
- [B7 — Scene compilation and patch capability](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/scene.rs). Patch validation 94–143 and 286–305.
- [B8 — Authenticated scene host](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_scene_host.rs).
- [B9 — Main repository instructions](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/AGENTS.md).

### Renderer and model

- [R1 — SceneOS implementation record](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/CRATE.md).
- [R2 — Luma cell renderer](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/cells/luma.ts).
- [R3 — SceneOS package and pinned dependencies](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/package.json).
- [R4 — Behavior contract mirror](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/contract.ts). State/operation types: 32–165; integer validation: 216–229.
- [R5 — Explanation view and lifecycle](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/view.ts). Main-thread preparation: 308–323; startup/teardown: 354–455; frame loop: 1356–1377.
- [R6 — Runtime client and worker fallback](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/client.ts).
- [R7 — Authored model loading](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/source.ts).
- [R8 — Model state and snapshot implementation](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/runtime.ts). Public snapshot 114–130; private restore-relevant state 215–234; snapshot method 278–290.
- [R9 — Embedded host protocol](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/embed.ts).
- [R10 — Browser CPU journey](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/test/explain-browser.mjs).

### Web UI

- [U1 — Scene payload and protocol parser](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-model.ts).
- [U2 — Inline SceneCard, expansion, remount, and timeout](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-part.tsx). Lifecycle: 105–227.
- [U3 — Scene message rendering and Ask context](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/theorem-parts.tsx). Key area: 927–963.
- [U4 — Artifact contribution registry](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/artifacts/artifact-registry.tsx).
- [U5 — Thread artifact enumeration](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/artifacts/artifact-model.ts). Key area: 102–125.
- [U6 — Existing App preview visibility lifecycle](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/artifacts/app-revision-frame.tsx). Key area: 179–205.
- [U7 — SceneCard component tests and stand-in iframe scope](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-part.test.tsx).
- [U8 — Theo face plan and Luma dependency separation](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/docs/plans/theo-face.md). SceneOS 9.4.2 and UI 9.3.6 separation: approximately line 84.

### Native and prior design

- [N1 — Platinum transcript artifact handling](https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/src/theorem/transcript.rs). Artifact fallback/Open: 997–1025.
- [N2 — Theo particle field](https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/crates/theo/src/particles.rs).
- [N3 — Native grain painting](https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/src/theo_desk/body.rs). Grain painting: 201–231.
- [H1 — Earlier expressive-presence handoff](https://chatgpt.com/library?file_id=libfile_fde3_f-e6456b2768608191a39110d0798b0586_6878dc7caa4481919060e74e27ae75e5&account_id=personal).
- [H2 — Generalized procedural-engine handoff](https://chatgpt.com/library?file_id=libfile_1135d3399d548191a12879a3ba431277&account_id=personal). Domain-neutral procedural/inverse-procedural loop and portable 3D IR are useful broader constraints, not a prerequisite for every 2D scene.

[B1]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/operations/scene.rs
[B2]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_scene.rs
[B3]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/scene.md
[B4]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/scene_flow_tests.rs
[B5]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_app_turn.rs
[B6]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_context.rs
[B7]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/scene.rs
[B8]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_scene_host.rs
[B9]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/AGENTS.md
[R1]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/CRATE.md
[R2]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/cells/luma.ts
[R3]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/package.json
[R4]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/contract.ts
[R5]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/view.ts
[R6]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/client.ts
[R7]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/source.ts
[R8]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/runtime.ts
[R9]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/embed.ts
[R10]: https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/test/explain-browser.mjs
[U1]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-model.ts
[U2]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-part.tsx
[U3]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/theorem-parts.tsx
[U4]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/artifacts/artifact-registry.tsx
[U5]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/artifacts/artifact-model.ts
[U6]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/artifacts/app-revision-frame.tsx
[U7]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-part.test.tsx
[U8]: https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/docs/plans/theo-face.md
[N1]: https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/src/theorem/transcript.rs
[N2]: https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/crates/theo/src/particles.rs
[N3]: https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/src/theo_desk/body.rs
[H1]: https://chatgpt.com/library?file_id=libfile_fde3_f-e6456b2768608191a39110d0798b0586_6878dc7caa4481919060e74e27ae75e5&account_id=personal
[H2]: https://chatgpt.com/library?file_id=libfile_1135d3399d548191a12879a3ba431277&account_id=personal

