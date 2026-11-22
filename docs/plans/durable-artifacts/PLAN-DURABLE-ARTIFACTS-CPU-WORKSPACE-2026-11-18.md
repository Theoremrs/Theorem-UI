# Durable artifacts and a credible CPU workspace — implementation plan

**Date:** November 18, 2026\
**Status:** Implementation plan; no implementation or runtime validation is claimed by this document.\
**Goal:** Make an artifact an enduring, executable project that can be researched, built, inspected, improved, resumed, and moved between threads and hosts. Prove the system with a more convincing spatial CPU artifact, backed by a real emulator and explanations that reference its actual execution\
**Architecture:** Extend Theorem's document, application, workspace, execution, environment, and evolution owners. Add durable runs and build references around freely authored programs. Use one observation context across the scene, inspector, traces, questions, and feedback.\
**Tech stack:** Existing React/TypeScript host, Three.js spatial implementation, Astryx controls, assistant-ui conversation, ELK logical arrangement, DOM/SVG annotations, Rust document/application/runtime services, C-to-WASM 6502 engine, Rerun as a diagnostic consumer. Additional languages and execution environments remain authorable.\
**Spec:** This operationalizes DESIGN-DURABLE-EVOLVING-ARTIFACTS-2026-11-17.md and the user's current screenshots. It also builds on HANDOFF-ANNOTATIONS-AND-REFERENCE-GEOMETRY-2026-11-17.md, the generalized procedural-engine handoff, and the harness north star. Earlier suggestions that ordinary TypeScript should be the only artifact runtime are superseded.

## 1. Decisions to carry through implementation

1. **Durable artifacts are projects with executable history.** Save source, dependencies, research, build products, engine state, experiments, decisions, evaluations, and reusable results. Thread messages reference the artifact; they do not own its identity.
2. **Agents author programs.** Existing components, scene helpers, evaluation adapters, and UI protocols are optional capabilities. An agent can create new TypeScript, Rust, C/C++, Python, HDL, shaders, or other build targets. No fixed CPU-part catalog or mandatory scene description language becomes the authoring boundary.
3. **Use the existing ownership structure.** Documents own collaborative source and exact source revisions; application lifecycle records can own resolved releases; managed workspaces own execution checkouts; the harness owns work scheduling; EnvWorld and theorem-evolve own evaluation and improvement integration. Do not introduce a second artifact registry, database authority, or general agent loop.
4. **One selected context drives every surface.** Bind the visible source/build, run, recorded moment, selected entity, and observation digest. Never answer a question about the latest document when an older successful build is what is actually running.
5. **The scene is the primary experience.** Chat shows a useful live preview; a larger workspace supplies inspection, questions, history, and optional signals. Full Rerun is a deliberate diagnostic mode.
6. **The first realistic CPU is a named original NMOS 6502.** Retain the four-bit adder as a teaching example and regression fixture. Do not relabel that adder as an instruction-executing CPU.
7. **Physical form and execution have independent evidence.** A package, die layout, logical diagram, and emulator trace are distinct representations with explicit correspondences. Illustrative animation is identified as illustration.
8. **Improvements are evaluated revisions.** User feedback can change layout, parameters, engine code, or learned models. Preserve the baseline, evidence, candidate, result, and rollback. Correctness requirements are hard gates, not terms that can be traded away for a higher aesthetic score.
9. **Cloudflare is a hosting option.** Durable Objects can coordinate work; R2 can hold large immutable artifacts; Workflows can orchestrate retries. Provider resources do not define artifact identity or replace explicit simulator checkpoints.

## 2. Verified starting point

### Source baseline

The active work is ahead of main. The plan is based on these fetched revisions:

| Repository / reference | Revision                                 | Relevance                                                           |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Theorem-UI main        | 2e4f648c07bb56da767f001482e8e662c0132b84 | Main baseline before the current annotation branch                  |
| Theorem-UI PR 128      | 4b2680b90e47feab80e702044975a91ecf6682b5 | Source authoring/dependencies and expansion foundation              |
| Theorem-UI PR 129      | 3a279320b43782a4f536e0aae37ed68ba2f9934c | Spatial engine, annotations, dossier, Rerun, reference geometry     |
| Theorem PR 1099        | ae247da46898297cb31a4bc2a8c81df5564a0c32 | App authoring contract and trace encoding endpoint                  |
| Theorem main           | ed9171d1ca83f02f4705386beb9442743821df51 | Current fetched main; EnvWorld and evolution ownership checked here |

The screenshots closely match committed PR evidence. This is a source audit, not an inspection of Claude's uncommitted changes or a new run of the deployed application. Refresh the branch base before implementation and preserve concurrent work.

### Existing capabilities and the actual gap

| Area                  | Already present                                                                        | What the next work adds                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Authoring             | Custom compute/tick/inside/show functions, optional reusable parts, replaceable chrome | Discoverable declarations and sources, multiple build targets, adapters for engines with independent semantics |
| Rendering             | Three.js meshes, particle sampling, controls, selection, exploded/nested views         | Better sourced geometry/materials and coherent scene framing                                                   |
| Layout                | ELK for unpositioned logical parts/wires; separate projected annotation placement      | Explicit inspection regions, overflow fallback, stable placement and accessible alternatives                   |
| Annotation style      | Angular leaders are already implemented                                                | Refine density, anchors, routing, priority, and interaction; do not reimplement the same feature               |
| UI components         | Astryx controls and assistant-ui dossier conversation                                  | Use them within a unified layout; switching component libraries alone will not solve crowding                  |
| Replay                | CycleTrace restores teaching-model states and reruns later causes after an edit        | Durable run IDs, immutable branches, checkpoint blobs, precise source/engine references                        |
| Rerun                 | Real 0.35.0 web viewer and Rust RRD encoding                                           | Focused Signals presentation, deliberate diagnostic mode, typed trace data and saved recordings                |
| Source history        | Canonical theorem.app documents and exact document revisions                           | References from runs to the exact source/build and corresponding engine state                                  |
| Application lifecycle | Immutable definitions/releases and canonical graph-backed records                      | Reuse their references for packaged artifacts; do not force every simple answer App into a deployment workflow |
| Improvement           | EnvWorld observations/episodes and theorem-evolve candidate lifecycle                  | Artifact evaluators, checkpoint integration, per-artifact scope, concrete feedback-to-candidate experiments    |

The current spatial implementation is Three.js, not entirely LumaGL. Retain useful renderer capabilities; no renderer rewrite is on the critical path.

### Concrete defects and limitations

- The Rerun wrapper deliberately uses a minimum width of 640 CSS pixels and a default height of 300 pixels. The minimum is a workaround for a documented 0.35 collapsed-time-panel issue. Narrow answers consequently scroll a full diagnostic interface sideways.
- The screenshot answer says the final four-bit carry for 7 + 5 is 1 even though its own last stage produces 0. The repository evidence acknowledges this. The live journey checks topic mentions rather than numeric agreement.
- The teaching engine's trace cycle counts start, edit, restore, and step settlements. It is not intrinsically a hardware clock cycle.
- CycleTrace retains at most 5,000 entries in memory. Remembered state reloads as a new restored event; the old history is not recovered.
- The RRD endpoint explicitly stores nothing. Encoding a recording is not durable storage.
- Numeric trace values become JavaScript Number / Rust f64, including bigint conversion. Width, signedness, unknown bits, high impedance, and time domains are absent.
- A failed new build can leave the last good runtime on screen, while dossier Ask reads the latest App document. Source inspection indicates a possible revision mismatch; this has not been reproduced in a new runtime test.
- Dossier references are trimmed to 8,192 bytes by removing large context fields. Exact run/state references should carry authority when excerpts are incomplete.
- The branch evidence says spatial source/declarations are unavailable to the authoring agent, despite use by the browser checker.
- A dossier question during an active build can interrupt the run and be lost, according to the committed evidence.

The 7 + 9 screenshot is internally consistent for a four-bit adder: result 0, final carry 1. Do not mistake it for the 7 + 5 explanation defect. The large black margins in the phone capture are not sufficient evidence of an application layout bug.

## 3. Product experience

### Preview in a conversation

Keep the artifact visibly part of the answer: a live scene, title, concise observed result, and an Open workspace action. Include a few usable controls where the artifact's width allows them. The preview does not instantiate a complete Rerun dashboard by default.

An answer can link to a specific event: Show the carry transition. That link resolves the artifact revision, run, event, entity, and optional camera bookmark. The same artifact can appear in another thread without creating another unrelated project.

### Expanded workspace

The workspace has a large central model, a contextual inspector, and an optional compact Signals drawer. History and full diagnostic traces are available as intentional modes. Do not show scene, source editor, conversation, history, and Rerun simultaneously merely because they exist.

| Surface       | Content and behavior                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Header        | Artifact name, current view, concise execution/replay state, access to revision/run details              |
| Main stage    | Spatial model, small annotations, selection and manipulable parts                                        |
| Inspector     | One selected entity's description, relevant values, editable inputs, evidence and local question         |
| Comparison    | Explicit comparison layout for pinned entities or two runs; no independent stack of large floating cards |
| Signals       | Selected bits/buses, event causes, execution cursor, cycle/instruction controls                          |
| Inspect trace | Full Rerun workspace with sufficient available width and height                                          |
| History       | Decisions, research, candidate changes, evaluations and accepted revisions                               |

Proposed responsive starting points, measured against the artifact container:

| Available width          | Layout                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| About 1,100 px and above | Flexible stage, roughly 300–360 px inspector, optional 160–220 px Signals drawer                     |
| About 768–1,100 px       | Stage with a deliberate inspector drawer or replacement secondary pane                               |
| Below about 768 px       | Full-width stage plus a collapsible bottom sheet; Scene, Signals and Explain are selectable surfaces |

These dimensions are implementation starting points, not standards. Validate the actual 612-pixel surface as well as narrow mobile and expanded desktop layouts. The preview should respond to its own available width even inside a wide browser.

### Annotation and selection behavior

Keep labels small: name plus one or two relevant values. Rich controls and prose belong in the selected inspector. Use straight leaders with consistent 45-degree or right-angle bends, restrained anchors, and readable text.

Measure labels after fonts/content settle. Project stable semantic anchors through the active camera. Place labels against other labels, selected-object bounds, viewport edges, and reserved UI regions. Include movement cost/hysteresis so small camera changes do not reshuffle everything.

Pinned content must have an explicit placement policy. When space is insufficient, dock, stack in a comparison region, or collapse lower-priority labels into an accessible index. A finite overlap penalty cannot guarantee that arbitrary content fits into a finite viewport.

ELK can continue arranging logical parts and connections. It should not move physical CPU features or package pins to make room for cards. Projected annotation placement has a different owner.

Fit the camera to the usable stage after inspector and Signals regions are reserved. Preserve the user's camera during ordinary selection; reframe deliberately when needed. Provide visible alternatives to double-click, dragging, and nested Escape behavior, plus a keyboard-accessible part list.

### Shared execution context

Execution controls name the operation they perform: Step instruction, Step cycle, or Step transition. Replay moves through recorded observations; it does not silently advance the live engine. Editing the past starts a new experiment from a supported checkpoint and preserves the original run.

All displayed values, selected signals, local questions, and feedback reference the same selected context. Opening the inspector must not move the user from a historical observation to the newest state.

A question captures its context when submitted. If the user then changes selection or time, the eventual answer retains its original entity/event and offers Show referenced moment. It must not overwrite the new inspector context or move the camera/cursor back automatically. An unavailable observation is reported as unavailable; it never silently becomes the latest state.

## 4. CPU realism and fidelity

### Select a concrete machine

Use an original NMOS 6502 as the initial executable example, with variant and behavior documented. It connects naturally to the package/die work already explored. Do not mix a historical NMOS die with W65C02 behavior or describe its accumulator and X/Y registers as arbitrary A/B input boxes.

Use the pinned floooh/chips m6502 core as the first candidate. It is a cycle-stepped C implementation with a pin-mask interface and existing WebAssembly examples. Compile it to WASM, execute in a worker, and use the same source for a native runner if needed. Adoption depends on conformance checks; the library name alone does not establish exactness.

Expose engine-owned operations for reset, bounded execution, instruction/cycle stepping, memory/register inspection, input scheduling, observation, and checkpoint/restore. Record the engine revision, compiler/build identity, program/memory image, machine configuration, external inputs and time convention.

The scene reads those observations. It does not recalculate CPU results independently.

Map emulator control bits to physical pin polarity explicitly. The chips pin mask represents logical control conventions, not measured package voltage: for example, its asserted RDY stall convention differs from the physical pin's ready level. Specify which pins/functions the adapter exposes, how asserted/deasserted states map to package signals, and which clock/internal animations are derived illustrations. Instruction correctness alone cannot validate a package pin animation.

### Three linked representations

| Representation | What it should show                                                                          | Evidence requirement                                                                              |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Package        | Credible 40-pin package, leads, die placement, optional cutaway                              | Identify package variant; source dimensions and construction; label reconstructed internals       |
| Architecture   | Accumulator, X/Y, stack pointer, program counter, status, ALU, decode, buses, memory and I/O | Match the selected CPU and implemented behavior; conceptual arrangement can be spatially exploded |
| Execution      | Instructions, bus transactions, register changes, selected flags and timing                  | Derive from a saved engine run with a defined observation phase                                   |

Package, die, logical unit, netlist node and scene object IDs need explicit, potentially many-to-many correspondences. Each mapping carries a source and a classification such as observed, source-derived, reconstructed, or illustrative. A functional component is not automatically a separate physical object.

Use solid surfaces, credible proportions, subdued materials and directional lighting to establish form. Particles can communicate selected activity or an intentional illustration style. Do not use point density as the main substitute for geometry.

The generalized procedural-engine handoff fits here: evidence to parameters with confidence, then reproducible geometry. Existing Manifold/reference work is useful. glTF can carry mesh/material assets without becoming the mandatory format for runtime behavior, UI code, or every artifact.

### Deeper transistor and HDL work

Visual6502 and v6502r are useful reference projects. v6502r demonstrates native/WASM execution, cycle rollback, pin timing and node inspection. However, the netlist_6502.h file bundled by perfect6502 explicitly carries CC BY-NC-SA 3.0, despite a different repository-level code license. Resolve the specific dataset's distribution terms before bundling derived assets; the separately licensed chips engine can proceed.

A fast emulator and a transistor simulator have different state spaces. Do not promise instantaneous conversion from a register snapshot into a correct transistor state. Run deeper models from compatible initial conditions and recorded inputs, then compare observables that both actually expose.

The later HDL path is another authorable build target: Verilator compiles Verilog/SystemVerilog to an executable model; Yosys produces synthesized logic; OpenROAD performs physical design. A newly synthesized implementation has its own layout. It does not reconstruct the historical MOS die merely because it implements compatible instructions.

## 5. Shared runtime and persistence contracts

The following are proposed integration contracts, not a universal language for authoring an artifact.

| Contract          | Required meaning                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ArtifactSourceRef | Existing document/project identity, exact revision position or commit, source digest                                                                                                 |
| RuntimeBinding    | Currently rendered presentation source/build, immutable execution RunRef, and the observation/mapping schema used to interpret that run                                              |
| BuildRef          | Source inputs, build recipe/toolchain/flags, lockfiles, target/ABI, output digests and receipt                                                                                       |
| EngineRef         | Engine kind and version, executable digest, adapter/observation/checkpoint schema versions                                                                                           |
| RunRef            | Artifact source/build/engine, configuration, program/assets/input digests, parent run/checkpoint, reproducibility classification                                                     |
| ObservationRef    | Run ID, event index, time domain, exact state digest, optional checkpoint reference                                                                                                  |
| SignalDescriptor  | Stable semantic ID, value type, bit width/signedness or units, interpolation semantics, observation phase, logical assertion convention and physical polarity mapping where relevant |
| SignalValue       | Exact encoded bits or integer text where needed; analog numbers separately; unknown/high-impedance masks only when the engine supports them                                          |
| CheckpointRef     | Engine and codec identity, complete state blob digest, compatible input history, time and verification receipt                                                                       |
| ViewState         | Camera, selected entity, nested view, inspector/comparison state and cursor; separate from simulator state                                                                           |
| DecisionRecord    | Feedback target, reproduction reference, rationale, evidence links, candidate and evaluation references, accepted scope                                                              |

Use exact integer/bit encodings across JSON. Do not pass 64-bit signals or long counters through floating-point conversion. An event index, hardware cycle, half-cycle, instruction index and physical time are distinct domains.

Presentation provenance and execution provenance are separate. A new inspector-spacing revision can display an existing compatible run. Preserve the run's original execution source/build and record the newer presentation source/build plus its interpretation mapping. Do not relabel old execution as newly computed work or reject valid reuse merely because the UI changed.

Artifacts that do not need an engine remain valid. Engine adapters advertise the capabilities they actually support. Checkpoint/restore is required for the CPU milestone; a general solver can instead declare replay-only or unsupported restore and explain the available action.

For the CPU, a checkpoint includes internal execution phase/latches, pending interrupt state, pin state, memory, devices/input schedule and time—not only programmer-visible registers. Serialize with a versioned codec. A raw C-struct dump without ABI/version compatibility is not a portable checkpoint.

### Proposed operations

- Resolve an exact observation from an ObservationRef.
- Append a bounded trace chunk with an idempotent chunk identity and expected sequence.
- Save a checkpoint and verify its content digest.
- Fork a run from a compatible checkpoint and explicit input change.
- Resolve the actually displayed runtime binding for a question or feedback event.
- Build or evaluate an immutable candidate against explicit inputs.
- Adopt a candidate only if its expected base is still current and required evaluation gates passed.
- Export/import a manifest plus source, dependencies or their resolved references, evidence, builds, traces, checkpoints, mappings and decisions.

RRD remains a derived representation. Store canonical observations and engine checkpoints separately so a viewer version change does not make the artifact's history inaccessible.

### Computation reuse

Treat research, geometry generation, compilation, execution, trace derivation and evaluation as a dependency graph. Each node records its precise inputs, environment and outputs.

| Change                        | Reuse that should remain valid                   | Work that must be reconsidered                                  |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Inspector spacing or colors   | CPU build, execution and checkpoints             | Layout measurements and visual evaluations                      |
| Package material or camera    | CPU execution                                    | Rendering/visual evidence affected by the change                |
| Program input at a past event | Prior compatible checkpoint and unaffected build | Later run suffix and dependent explanations                     |
| CPU source or compiler flags  | Unaffected research/assets                       | Executable, checkpoint compatibility and behavioral evaluations |
| Evaluator changes             | Immutable existing run data                      | Evaluation receipt and promotion decision                       |
| Learned surrogate weights     | Reference solver/evidence                        | Predictions and evaluations produced by those weights           |

Do not key every cache on the whole artifact revision; that would invalidate execution for a color change. Also do not omit engine, input, compiler or model dependencies. Preserve failed experiments as evidence, while treating only successful compatible results as reusable completion.

## 6. File ownership and proposed additions

All paths below are repository-relative. Existing paths were inspected directly or identified in the pinned source audit. New paths are explicitly proposed and should be reconciled with the implementation checkout before creation.

### Theorem-UI

| Responsibility                             | Existing files to extend                                                                                                                                                       | Proposed additions                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Presentation negotiation / mounted runtime | src/components/artifacts/inline-artifact.tsx; src/components/blocks/block-frame.tsx; src/components/blocks/document-app.tsx; src/lib/blocks/sandbox/display.ts and protocol.ts | src/lib/blocks/artifact-runtime/types.ts and session.ts                           |
| Trace / engine binding                     | src/lib/blocks/spatial/trace.ts; engine.ts; view\.ts; timeline.ts                                                                                                              | artifact-runtime/engine-client.ts; spatial/engine-adapter.ts                      |
| Inspector / annotations                    | src/lib/blocks/spatial/chrome.tsx and chrome.css; dossier.tsx; src/lib/blocks/annotate/layer.tsx, place.ts, paths.ts                                                           | Focused Signals and comparison components beside existing chrome                  |
| Grounded questions                         | src/lib/theorem/app-dossier.ts; document-app.tsx                                                                                                                               | Observation-reference binding and fact rendering in existing dossier flow         |
| Agent discovery                            | src/lib/blocks/app-library-sources.ts; app-check-library.ts; app-libraries.ts                                                                                                  | Public runtime declarations/examples using the existing library mechanism         |
| Regression fixtures                        | scripts/e2e/timeline.mjs; timeline-live.mjs; spatial-fixture.mjs                                                                                                               | Focused runtime-binding, workspace-resize, checkpoint and digital-signal fixtures |

### Theorem backend

Paths in this table start beneath rustyredcore_THG/.

| Responsibility                            | Existing owner                                                                                                                                       | Proposed extension                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collaborative source and exact revisions  | crates/theorem-doc-store/src/product.rs, store.rs, snapshot.rs; crates/rustyred-thg-server/src/theorem_agent_stream/conversation_apps.rs             | Reuse canonical document revision and snapshot references                                                                                                           |
| Packaged application and resolved release | crates/theorem-blocks/src/app.rs; crates/theorem-apps/src/definition.rs, store.rs, release.rs, invocation.rs                                         | Add run/build/evidence links without copying source ownership                                                                                                       |
| Run persistence                           | Canonical graph and existing artifact-byte storage                                                                                                   | Proposed theorem-apps/src/run.rs and checkpoint.rs, with persistence through the existing graph adapter; document-backed runs must not require publishing a service |
| Large immutable bytes                     | crates/rustyred-thg-core/src/object_store.rs                                                                                                         | Reuse the verified content-addressed chunk store for compiled modules, checkpoints, trace chunks, evidence and recordings                                           |
| Trace encoding                            | crates/theorem-proto-emit/src/trace.rs; crates/rustyred-thg-server/src/theorem_chat_app_traces.rs                                                    | Typed-signal adapters and derivation from stored run chunks; leave encoding separate from storage authority                                                         |
| Work scheduling                           | crates/theorem-harness-runtime/src/organization_store/durable.rs; crates/rustyred-thg-server/src/theorem_agent_stream/conversation_work/execution.rs | Reuse durable work records and completion receipts for build/evaluate jobs                                                                                          |
| Managed build checkout                    | crates/theorem-agent-workspace/src/lib.rs; crates/api/src/agent_workspace_tools.rs                                                                   | Reproducible polyglot build inputs and retained output references                                                                                                   |
| Evaluation integration                    | crates/theorem-env-core/src/lib.rs and service.rs                                                                                                    | Proposed artifact_world.rs and a capability-aware checkpoint extension                                                                                              |
| Candidate improvement                     | crates/theorem-evolve/src/lifecycle.rs and evaluate.rs                                                                                               | Per-artifact/target scope, concrete artifact evaluator and expected-base adoption                                                                                   |
| Optional Cloudflare hosting               | crates/theorem-apps/src/providers/cloudflare.rs and providers/mod.rs; existing deployment/resource planning                                          | Extend the provider boundary for coordination/storage integration; its existence does not establish a working durable artifact coordinator                          |

The application definition already has an exact DocumentRevision/ProjectRevision reference and a DurableObject state kind. GraphAppsStore borrows the canonical graph. The existing bridge in server theorem_agent_stream/conversation_app_operations.rs resolves an exact published document revision for optional application registration. An ordinary theorem.app document is not automatically an installed application. Keep source and durable runs usable without requiring registration, a manifest installation, or deployment.

The harness work owner already tracks claims, epochs, leases and result receipts. Its current executor is an agent-work scheduler; a typed build/simulation attempt executor is new work. Existing application image-build provisioning is specialized and release-bound, so reuse its patterns or explicit packaging path without requiring every browser artifact to become a deployed service.

## 7. Work packages and acceptance

### W0 — Freeze a compatible implementation base and make authoring inspectable

**Depends on:** none.\
**Consumes:** the active PR branches and current App authoring path.\
**Produces:** a recorded integration base, public runtime/library source and declaration access, and scoped failure fixtures.

- [ ] Refresh PR 128/129 and backend 1099, record the exact compatible heads, and reconcile concurrent changes before editing.
- [ ] Confirm the exact sandbox protocol file and existing test conventions in the checkout.
- [ ] Expose spatial/annotation/runtime declarations and usage examples through the existing agent source-discovery tools. Keep optional libraries optional.
- [ ] Preserve the failing carry answer, narrow Rerun surface, lost mid-build question and failed-new-build/last-good-runtime scenarios as explicit regression cases.
- [ ] Record baseline results separately from pre-existing failures; do not label the branch clean merely because the known failures also occur on main.
- [ ] Commit this discovery/fixture change independently.

**Done when:** an agent can inspect the actual API before authoring a new component, and the next packages have reproducible failures to close.

### W1 — Define runtime identity, observations, time domains and typed signals

**Depends on:** W0.\
**Consumes:** source revision/build references and engine observations.\
**Produces:** ArtifactSourceRef, EngineRef, RunRef, ObservationRef and typed signal interchange.

**Files:** proposed UI artifact-runtime/types.ts and session.ts; existing sandbox protocol; spatial/trace.ts; backend trace types and proposed run/checkpoint modules under existing application ownership.

- [ ] Specify serialization and versioning for the contracts in section 5, including exact wide integers.
- [ ] Introduce a runtime binding containing the presentation source/build actually displayed, immutable execution source/build through RunRef, mapping/schema version, engine session and current ObservationRef.
- [ ] Adapt CycleTrace to label settlement events correctly; add hardware cycle/instruction domains only for adapters that implement them.
- [ ] Separate typed canonical trace data from RRD projection and lightweight Signals projection.
- [ ] Report a teaching graph that reaches its settle limit without convergence as a failed/unsupported observation, rather than silently presenting it as settled truth.
- [ ] Add round-trip checks for 64-bit values, four-state masks when supported, different time domains, schema mismatch, and phase conventions.
- [ ] Commit the interoperable contracts and adapters before downstream UI additions.

**Done when:** the same immutable observation can be consumed by both viewer surfaces without precision loss or ambiguous cycle meaning.

### W2 — Ground explanations in the runtime that is actually visible

**Depends on:** W1; can deliver an initial local binding before the complete persistent store.\
**Consumes:** active runtime binding, selected entity, question and exact observation.\
**Produces:** a retained question/reference and answer facts tied to that observation.

**Files:** document-app.tsx; app-dossier.ts; spatial/dossier.tsx; sandbox protocol; existing conversation scheduling and question/reference path.

- [ ] Pass the displayed runtime binding atomically through Ask. When a new build fails, use the last successful runtime's source/build, not app.getSnapshot() for an unrelated newer revision.
- [ ] Keep an immutable observation reference outside excerpt trimming; query the exact state when more detail is needed. Before persistent storage lands, retain a session-scoped snapshot and mark its lifetime explicitly.
- [ ] Provide deterministic fact rows for selected values and flags. Model prose refers to those facts; counterfactual numerical comparisons execute a branch rather than inventing a table.
- [ ] Preserve questions asked during an active build and route them through the existing conversation/work scheduler without silently dropping them.
- [ ] Keep asynchronous replies bound to their submitted entity/event after the user changes selection; offer Show referenced moment without changing the current context automatically.
- [ ] Report an expired/unavailable observation explicitly. Never fall back to current state while retaining the old question's apparent referent.
- [ ] Check current versus historical state, failed-build fallback, and oversized-context cases.
- [ ] Replace the topic-only carry journey with a test that verifies the selected run values and final carry. Do not claim arbitrary natural-language correctness from a keyword test.
- [ ] Commit grounding separately from presentation changes.

**Done when:** the 7 + 5 example reports final four-bit carry 0, an earlier cycle remains the question's referent, and a failed newer revision cannot change which running program the answer describes.

### W3 — Introduce a coherent preview/workspace presentation

**Depends on:** W0; consumes W1 when available.\
**Consumes:** one mounted artifact session and available container dimensions.\
**Produces:** responsive inline, workspace and diagnostic presentation modes.

**Files:** inline-artifact.tsx; block-frame.tsx; sandbox/display.ts and protocol; spatial/chrome.tsx/chrome.css; view\.ts; timeline.ts; annotate/layer.tsx and place.ts.

- [ ] Negotiate presentation mode and available width/height explicitly across the host boundary. Retain content-size reporting for ordinary Apps.
- [ ] Preserve the same mounted runtime during expansion/collapse; do not create two advancing simulators or reset the iframe.
- [ ] Make the stage primary, selected inspection singular, and pinned comparison deliberate.
- [ ] Reserve inspector/Signals regions for camera fitting and label placement. Add docking/list overflow behavior.
- [ ] Remove full Rerun mounting from the default inline example and authoring guidance; keep it available through Inspect trace.
- [ ] Synchronize theme and reduced-motion preferences across active surfaces.
- [ ] Validate actual 612 px embedding, a narrow mobile viewport, and expanded desktop; include long labels, zoomed text, keyboard selection and repeated expansion.
- [ ] Verify hidden annotations still have a reachable semantic selection list.
- [ ] Commit the presentation change with before/after captures at the same sizes and state.

**Done when:** an inspector cannot accidentally cover another inspector, core controls fit the narrow artifact, expansion preserves execution, and the model remains understandable without opening diagnostic chrome.

### W4 — Save runs, checkpoints, branches and artifact context durably

**Depends on:** W1.\
**Consumes:** canonical App/document references, immutable trace chunks, engine checkpoints and view state.\
**Produces:** durable run history recoverable outside the original thread and browser session.

**Files:** proposed theorem-apps run/checkpoint modules and existing graph store; canonical document/snapshot APIs; spatial/trace.ts and view\.ts remember path; new thin API adapter beside current App routes.

- [ ] Store run records against exact source references. Support document-backed runs without mandatory deployment/release creation.
- [ ] Replace the in-memory history's authority with append-only trace chunks and checkpoint references. Keep a bounded local window as a cache.
- [ ] Define capture/checkpoint/retention policies for long runs. Evict buffered data only after durable acknowledgement or an explicit declared sampling/drop policy; retain required inputs and checkpoints for the advertised replay range.
- [ ] Make chunk append idempotent and sequence-checked; publish data blobs before the durable record that refers to them.
- [ ] Implement restore/fork with explicit engine compatibility and immutable parent lineage. Preserve the old run when editing the past.
- [ ] Persist view state separately so changing a camera or inspector does not alter simulation state.
- [ ] Migrate legacy state to a root checkpoint only when its exact source/engine and resume completeness can be verified. Otherwise preserve an observation/input snapshot and explicitly initialize a new run from recoverable inputs; do not claim the previous execution or missing history was resumed.
- [ ] Verify reload, another thread, duplicate delivery, interruption during upload, incompatible checkpoint and concurrent fork/adoption.
- [ ] Commit durable storage with explicit recovery semantics.

**Done when:** close/reopen recovers the selected run and observation; an edit to a past input creates a retained sibling experiment rather than overwriting history.

### W5 — Add a real polyglot build and 6502 engine adapter

**Depends on:** W1; W4 provides durable resume.\
**Consumes:** pinned C source, adapter source, authored program/memory image and build recipe.\
**Produces:** WASM/native build receipts and exact CPU observations/checkpoints.

**Files:** proposed examples/durable-artifacts/mos6502/ in the chosen artifact project; UI artifact-runtime/engine-client.ts and spatial/engine-adapter.ts; existing managed workspace/build scheduling owners.

- [ ] Pin the chips revision and license notice; compile a small C wrapper to WASM with a recorded compiler/flags/target.
- [ ] Run the engine in a worker with bounded batches and cancellation. Keep ordinary UI work responsive.
- [ ] Implement reset, cycle step, instruction step, run-until/breakpoint, memory/register reads and scheduled inputs.
- [ ] Define the observation boundary relative to tick and bus read/write service; use it consistently in traces and explanations.
- [ ] Encode and test control-polarity conversions, including RDY, IRQ, NMI and reset, against the named CPU/core conventions. Distinguish physical pins, adapter controls and unsupported functions.
- [ ] Implement a complete checkpoint codec, including mid-instruction and interrupt state. Check compatibility explicitly instead of relying on raw struct layout.
- [ ] Load a short authored program using binary mode and explicit carry initialization. Show register, memory and bus changes from actual execution.
- [ ] Run the appropriate NMOS functional, decimal and interrupt test configuration; keep the independent suite's terms/attribution. Add selected bus timing traces for reset, page crossing, branches and read-modify-write.
- [ ] Compare native and WASM runs for identical inputs, plus restore-and-continue against an uninterrupted run.
- [ ] Commit the engine integration with a fidelity statement and test receipts.

**Done when:** the artifact executes a program, produces correct results and flags under its declared variant, and resumes a checkpoint to the same subsequent observable trace.

### W6 — Build the convincing physical/architectural CPU presentation

**Depends on:** W3 and W5; can research assets in parallel.\
**Consumes:** engine semantics, physical references, geometry recipes and mapping evidence.\
**Produces:** Package, Architecture and Execution views of one artifact.

**Files:** the authored CPU artifact project; existing reference/Manifold helpers; spatial renderer and annotation helpers only where general capabilities are missing.

- [ ] Identify the package/revision being depicted and source its outline, pin count, dimensions and relevant die references.
- [ ] Build or import surfaced geometry with consistent units, origins and materials. Preserve reference, measurement and authored-parameter provenance.
- [ ] Introduce stable semantic correspondences between engine entities, logical units and scene geometry. Keep unsupported internal states unclaimed.
- [ ] Make the first view a convincing chip/package, with a clear action to reveal its structure.
- [ ] Provide a deliberately conceptual exploded architecture view linked to the physical view; keep it labeled and reversible.
- [ ] Bind visible activity to recorded observables. Any explanatory internal animation carries its illustration status.
- [ ] Verify package-pin mappings and active levels separately from instruction tests. Mark clock phases or unexposed internals as derived/illustrative when the emulator does not produce them.
- [ ] Check silhouette, framing, annotation legibility and physical pin arrangement at all target sizes.
- [ ] Commit the artifact project and provenance alongside its visual evidence.

**Done when:** a user can move from the package to a meaningful internal explanation and an executed instruction without losing identity, selection or the evidence behind the representation.

### W7 — Add focused digital Signals and retain Rerun for investigation

**Depends on:** W1, W3 and W5.\
**Consumes:** the same typed run data used by the engine/inspector.\
**Produces:** precise compact signal views and a compatible diagnostic recording.

**Files:** new Signals components beside spatial chrome; timeline.ts; theorem-proto-emit/src/trace.rs; current RRD route.

- [ ] Render bits as held states with explicit transitions, buses as exact values over intervals, and event causes separately. Analog quantities retain appropriate interpolation.
- [ ] Use one observation cursor. Avoid feedback loops when programmatic viewer time changes trigger viewer callbacks.
- [ ] Keep Rerun viewer/SDK versions matched. Confirm the exact interpolation/state-timeline API against the pinned 0.35 SDK before using current-documentation examples or proposing an upgrade.
- [ ] Configure supported outer panels and plots deliberately. Do not promise arbitrary per-view chrome removal or entity-selection setters that the pinned API does not expose.
- [ ] Persist canonical trace data and optional derived RRD blobs. Open deep diagnostics at a useful size.
- [ ] Measure startup, ingestion, long tasks, frame time and memory on the observed software-rasterizer path; distinguish browser capability from renderer defects.
- [ ] Commit focused trace presentation with discrete-transition, precision and shared-cursor checks.

**Done when:** the selected instruction/cycle is legible without a full dashboard, and Inspect trace opens the same run at the corresponding time.

### W8 — Turn artifact feedback into measured improvements

**Depends on:** W2, W3 and W4.\
**Consumes:** scoped feedback, a reproduction reference and baseline evaluator.\
**Produces:** candidate revision, evaluations, accepted/rejected decision and rollback.

**Files:** existing feedback/context capture; proposed artifact_world.rs; theorem-evolve/lifecycle.rs and evaluate.rs; application run/evidence records.

- [ ] Capture feedback against entity/view/run/event/source, including layout bounds or relevant physics parameters when applicable.
- [ ] Implement the dossier-overlap case first: replay exact view dimensions, selections, pins and label content; measure overlap and control reachability.
- [ ] Let the agent propose ordinary code/configuration changes. Evaluate on the reproduction and additional representative viewports, text sizes and selection states.
- [ ] Scope evolution to artifact and target capability, rather than one active policy for every artifact in a project. Preserve existing tenant/project isolation.
- [ ] Keep correctness gates independent of style/reward scores. Do not allow a faster CPU candidate to change arithmetic semantics.
- [ ] Record candidate provenance, baseline/candidate evidence and expected current revision. Handle stale candidate adoption without overwriting newer work.
- [ ] Distinguish artifact-local improvements from proposed reusable library or harness improvements; promote reusable changes through the existing capability policy.
- [ ] Commit a complete negative-feedback-to-improvement demonstration.

**Done when:** “these cards overlap” leads to a verified revision with retained evidence and rollback, and the original reproduction no longer overlaps because of a measured policy/layout change.

### W9 — Preserve and reuse expensive computation

**Depends on:** W4 and W5; extends W8.\
**Consumes:** declared build/experiment dependencies and existing durable work records.\
**Produces:** resumable work with reusable outputs and auditable cache decisions.

**Files:** managed workspace/build owners; harness durable work records; application release/build references; evaluator integration.

- [ ] Record build recipes, dependency locks, target ABI, seeds, input assets, engine configuration and output digests.
- [ ] Model dependencies at useful granularity: UI, geometry, engine, execution, evaluation, model weights.
- [ ] Resume incomplete jobs through existing work orchestration with idempotent publication and bounded retries. Treat failed checks as retained evidence, not successful cache entries.
- [ ] Demonstrate that a label/style change reuses the compiled engine and saved CPU run while reevaluating layout.
- [ ] Demonstrate that changing an input forks from a compatible saved checkpoint and recomputes only the affected suffix.
- [ ] Demonstrate that changing engine/toolchain inputs invalidates affected outputs.
- [ ] Commit reuse behavior with measured cold/warm work and recovery receipts.

**Done when:** the second iteration visibly benefits from preserved work, and the system can explain why a result was reused or recomputed.

### W10 — Make the artifact portable

**Depends on:** W4, W5 and W9.\
**Consumes:** an artifact source/run/evidence graph and its referenced blobs.\
**Produces:** a portable manifest/bundle and a standalone runner for the CPU exemplar.

- [ ] Export source, resolved dependencies/builds, program/assets, checkpoints, traces, geometry mappings, explicit decisions and research references.
- [ ] Include required runtime capabilities and which dependencies are bundled, remote, or expected from the destination.
- [ ] Keep derived embeddings/search indexes rebuildable. They are not the sole record of why a design changed.
- [ ] Import without silent identity collision or overwriting an existing artifact. Preserve origin and fork lineage where appropriate.
- [ ] Run the CPU example outside the original Theorem thread and restore a saved event using the compatible WASM runtime.
- [ ] Verify digest agreement and the distinction between a merely viewable recording and a resumable executable artifact.
- [ ] Commit portability with a clean-host demonstration.

**Done when:** source, behavior, useful state, history and evidence survive a move, and the destination clearly reports any unavailable runtime capability.

### W11 — Add a Cloudflare hosting adapter

**Depends on:** W4 and W9; does not block W2/W3/W5.\
**Consumes:** the same application/work/run contracts.\
**Produces:** provider-backed coordination and storage without a second domain model.

- [ ] Extend theorem-apps/src/providers/cloudflare.rs and the existing resource/deployment planning boundary. Verify which operations are currently implemented before adding coordinator/storage capabilities.
- [ ] Assign one coordination authority per artifact: serialize job/adoption operations and use expected-head/fencing checks for canonical publication. Do not maintain competing authoritative heads in a Durable Object and the existing graph.
- [ ] Use Durable Objects for coordination and compact operational state; use R2 for large immutable source/build/trace/checkpoint blobs.
- [ ] Use Workflows for retryable research/build/evaluate stages, dispatching heavy/native execution to appropriate workers or containers.
- [ ] Design idempotency across retries and partial failure. A DO transaction does not make an R2 upload, remote build and graph write one atomic operation.
- [ ] Restore simulator state from explicit checkpoints. DO memory and container filesystem snapshots do not preserve a running simulation automatically.
- [ ] Test eviction/restart, repeated workflow steps, upload-before-publication failure, stale candidate adoption and native/local versus provider-backed portability.
- [ ] Commit provider integration only after the common recovery semantics are demonstrated.

**Done when:** a coordinator restart or worker retry does not lose the accepted revision, duplicate a published result, or falsely claim that process memory was restored.

### W12 — Extend learning to physics and optional graph models

**Depends on:** W8/W9 plus a second domain with a reference engine and useful data.\
**Consumes:** observations, feedback, objective definitions and reference trajectories.\
**Produces:** evaluated parameter/model candidates with retained training/evaluation evidence.

- [ ] Add a second demonstration such as Pong backed by a real physics implementation. Separate a desired arcade feel from physical calibration targets.
- [ ] First use explicit engine parameters or code changes and a measurable trajectory/bounce evaluator.
- [ ] Collect stable domain graphs and reference trajectories only after engine semantics and replay work.
- [ ] Evaluate whether existing Burn/Pairformer primitives suit a candidate ranker, error detector or graph simulator; do not assume an existing graph model is already a trained dynamics model.
- [ ] If training a surrogate, record dataset/weights/normalization/time-step versions and evaluate multi-step stability and out-of-domain behavior against the reference.
- [ ] Preserve reference simulation and expose approximation/fallback boundaries. CPU instruction correctness stays exact.
- [ ] Commit an independently evaluated learning example before generalizing claims about self-improvement.

**Done when:** the artifact demonstrably improves against a defined objective, retains how and why it changed, and can revert or fall back when the learned behavior leaves its validated range.

## 8. Delivery order and parallel work

| Stage                   | Work packages                                       | Reviewable result                                                                        |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Immediate corrections   | W0, W1, W2; W3 in parallel after base alignment     | Authoring discovery, correct state-grounded answer, usable workspace                     |
| First durable CPU       | W4 and W5, then W6/W7                               | Actual 6502 execution, credible physical/architectural views, saved and inspectable runs |
| Compounding iteration   | W8 and W9                                           | Feedback creates an evaluated revision; unchanged computation is reused                  |
| Portability and hosting | W10; W11 can proceed against stable contracts       | Move the artifact and recover it after provider/runtime interruption                     |
| Deeper learning         | W12; transistor/HDL capability as separate projects | Physics calibration or validated learned approximation                                   |

Do not merge every package into one large PR. Keep identity/typed-data changes separate from layout, engine adoption, durable storage, and learning. Parallel workers can own presentation, engine integration, and storage after W1 agrees on contracts. One integration owner resolves cross-boundary changes.

Avoid a calendar estimate until the refreshed checkout establishes current implementation depth and available build environments. Each stage has a concrete acceptance artifact, so progress is observable without optimistic date commitments.

## 9. Acceptance matrix

| Scenario                           | Required result                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Four-bit 7 + 5, carry-in 0         | Low result 12, final carry 0; internal carries named separately                                                                   |
| Four-bit 7 + 9, carry-in 0         | Low result 0, final carry 1                                                                                                       |
| Eight-bit binary 7 + 9, carry-in 0 | Result 16, carry 0; do not transfer four-bit semantics into the 6502                                                              |
| Four-bit exhaustive arithmetic     | All 256 input pairs, or 512 with editable carry-in, agree with independent integer arithmetic                                     |
| 6502 mode/flags                    | Variant, decimal mode, carry input and C/V semantics are explicit and tested                                                      |
| Grounded question                  | Displayed source/build, run, event and numeric facts match the reference carried by Ask                                           |
| Last good build                    | A failed new revision cannot make an answer describe source that is not running                                                   |
| Presentation-only revision         | New spacing UI reuses a compatible old run, preserves its original execution provenance, and passes both identities to Ask        |
| Delayed answer                     | A reply retains the entity/event asked about after selection changes and offers Show referenced moment                            |
| Unavailable observation            | Explicit unavailable state; no silent substitution of the latest run                                                              |
| Rewind and edit                    | Original run survives; new run records checkpoint parent and changed inputs                                                       |
| Mid-instruction restore            | Continued output trace matches uninterrupted execution for the supported engine/codec                                             |
| Narrow display                     | No clipped primary controls or forced full multi-pane diagnostic footer                                                           |
| Crowded labels                     | Selected content remains reachable; explicit docking/index fallback replaces arbitrary card overlap                               |
| Expansion/theme                    | Same running session and cursor survive; active surfaces remain visually coherent                                                 |
| Wide digital values                | No precision loss through Number/f64 conversion                                                                                   |
| Replay mode                        | Scrubbing does not accidentally execute or mutate the live run                                                                    |
| Geometry                           | Pin arrangement and source-derived details match identified references; reconstructed details are declared                        |
| Physical signals                   | Emulator control assertions map correctly to package polarity; unexposed pin/internal behavior is not presented as measured state |
| Saved computation                  | Cosmetic changes reuse engine/run results; semantic changes invalidate the relevant dependency nodes                              |
| Feedback improvement               | Before/after evidence, candidate scope, evaluator and rollback are retained                                                       |
| Portable run                       | Clean compatible host restores source, state, selected event and evidence without the original chat                               |
| Interrupted remote work            | Idempotent completion and canonical head checks prevent duplicate/stale publication                                               |

## 10. Global constraints and review focus

### Global constraints

- Keep arbitrary authoring and extension paths. Standardize references and interoperability, not a complete universe of possible artifacts.
- Preserve existing canonical document/graph/workspace ownership. A renderer, trace encoder, embedding index or Cloudflare resource is not a new source of truth.
- Keep artifact-local iteration separate from broad promotion of shared learned capability.
- Preserve source/runtime compatibility across concurrent changes and branch stacks.
- Treat history, simulator checkpoints and development filesystem snapshots as different objects.
- Keep UI/physics/CPU evaluators meaningful; do not replace correctness tests with assertions that merely mirror implementation or mention expected words.

### Review focus

- Does every question, trace and visual value refer to the runtime actually shown?
- Can a change to a presentation component proceed without recompiling an unchanged engine?
- Is checkpoint state complete enough to resume, and is compatibility explicit?
- Do fallback layouts stay readable and accessible when content does not fit?
- Is the claimed CPU fidelity demonstrated at the level being displayed?
- Are failures, uncertainty and unsupported capabilities represented honestly?
- Does a resumed or repeated job publish at most one accepted result under the existing authority?
- Can a generated component or a new language target be added without changing a central catalog?

## 11. Source map

### Theorem source and committed evidence

- [UI PR 129](https://github.com/Travis-Gilbert/Theorem-UI/pull/129) and [backend PR 1099](https://github.com/Travis-Gilbert/Theorem/pull/1099).
- [Spatial engine](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/spatial/engine.ts), [renderer](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/spatial/view.ts), [trace](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/spatial/trace.ts), [timeline wrapper](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/spatial/timeline.ts).
- [Rerun investigation and acknowledged answer error](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/docs/plans/evidence/rerun-2026-11-18/README.md).
- [Document App / last-good preview / Ask](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/components/blocks/document-app.tsx), [dossier reference fitting](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/theorem/app-dossier.ts).
- [Angular annotation paths](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/annotate/paths.ts), [placement](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/annotate/place.ts), [ELK arrangement](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/src/lib/blocks/spatial/arrange.ts).
- [Reference geometry evidence](https://github.com/Travis-Gilbert/Theorem-UI/blob/3a279320b43782a4f536e0aae37ed68ba2f9934c/docs/plans/evidence/reference-2026-11-17/README.md).
- [RRD endpoint](https://github.com/Travis-Gilbert/Theorem/blob/ae247da46898297cb31a4bc2a8c81df5564a0c32/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_chat_app_traces.rs), [RRD emitter](https://github.com/Travis-Gilbert/Theorem/blob/ae247da46898297cb31a4bc2a8c81df5564a0c32/rustyredcore_THG/crates/theorem-proto-emit/src/trace.rs).
- [Application definition and document revision reference](https://github.com/Travis-Gilbert/Theorem/blob/ae247da46898297cb31a4bc2a8c81df5564a0c32/rustyredcore_THG/crates/theorem-apps/src/definition.rs), [canonical graph store](https://github.com/Travis-Gilbert/Theorem/blob/ae247da46898297cb31a4bc2a8c81df5564a0c32/rustyredcore_THG/crates/theorem-apps/src/store.rs), [resolved releases](https://github.com/Travis-Gilbert/Theorem/blob/ae247da46898297cb31a4bc2a8c81df5564a0c32/rustyredcore_THG/crates/theorem-apps/src/release.rs), [document snapshots](https://github.com/Travis-Gilbert/Theorem/blob/ae247da46898297cb31a4bc2a8c81df5564a0c32/rustyredcore_THG/crates/theorem-doc-store/src/snapshot.rs).
- [EnvWorld and episode contracts](https://github.com/Travis-Gilbert/Theorem/blob/ed9171d1ca83f02f4705386beb9442743821df51/rustyredcore_THG/crates/theorem-env-core/src/lib.rs), [evolution lifecycle](https://github.com/Travis-Gilbert/Theorem/blob/ed9171d1ca83f02f4705386beb9442743821df51/rustyredcore_THG/crates/theorem-evolve/src/lifecycle.rs).

### External primary references

- [chips](https://github.com/floooh/chips), [m6502 implementation/API](https://github.com/floooh/chips/blob/master/chips/m6502.h), [WASM examples](https://floooh.github.io/tiny8bit/).
- [Klaus Dormann functional/decimal/interrupt tests](https://github.com/Klaus2m5/6502_65C02_functional_tests).
- [Visual6502](https://github.com/trebonian/visual6502), [v6502r](https://github.com/floooh/v6502r), [perfect6502 netlist's actual license header](https://github.com/mist64/perfect6502/blob/master/netlist_6502.h).
- [Original MOS MCS6500 Hardware Manual scan](https://electronicsandbooks.com/edt/manual/Electronic%20Component%20Databook%20Datasheet/Brand/MOS%20Technology/Databook/1976%20MOS%20Technology%20MCS6500%20Hardware%20Manual%20197601%20%5B178%5D.pdf). Select the depicted package/revision and corroborating physical references during W6.
- [Rerun 0.35 WebViewer](https://ref.rerun.io/docs/js/0.35.0/web-viewer/classes/WebViewer.html), [supported panels](https://ref.rerun.io/docs/js/0.35.0/web-viewer/types/Panel.html), [current interpolation documentation](https://rerun.io/docs/reference/types/components/interpolation_mode), [state timelines](https://rerun.io/docs/howto/visualization/state-timeline). Current docs are not automatically the pinned 0.35 API.
- [Verilator](https://verilator.org/guide/latest/overview.html), [Yosys](https://yosyshq.readthedocs.io/projects/yosys/en/latest/introduction.html), [OpenROAD](https://openroad.readthedocs.io/en/latest/), [glTF](https://www.khronos.org/gltf/).
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Workflows](https://developers.cloudflare.com/workflows/), [R2](https://developers.cloudflare.com/r2/), [sandbox snapshot scope](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/).
- [Graph Network Simulators](https://proceedings.mlr.press/v119/sanchez-gonzalez20a.html), [MeshGraphNets](https://arxiv.org/abs/2010.03409), [Craft Anything workflow reference](https://github.com/storytold/craft-anything).

## 12. Completion definition

A user opens the CPU artifact from an answer, gets a well-framed spatial model, runs a real program, selects an observed event, and receives an explanation grounded in that exact state. They change an input in the past and compare a retained new run. They report a display problem; the agent produces and evaluates a repair while reusing unaffected computation. The project can then reopen in another thread or compatible host with its source, run, useful state, decisions and evidence intact.

That demonstration establishes durable artifacts as an executable, improving capability. More advanced engines and learned models can extend it without changing the basic ownership or limiting what an agent can author.
