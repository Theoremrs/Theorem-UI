# Durable artifacts: implementation record

Governing plan: [PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md](PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md).
Item status: [checklist.json](checklist.json).
Review followed: REVIEW-PR130-DURABLE-ARTIFACTS-2026-11-18 (follow-ups A to D
replace the earlier G0/G1-first order). A, B and C are implemented below; D is not.
Updated by the 2026-11-19 artifact review (Travis-Gilbert, provided in thread):
PRs #128/#129/#139 are merged to Theorem-UI `main`; the review's Section 4
runtime/state corrections are fixed; the remaining work is re-ordered below.

The plan leans on a CPU, but nothing below is CPU-specific. The references are
for any artifact that executes something (a teaching circuit, an emulator, a
physics solver, a trained model) and an artifact with no engine needs none of
them. The CPU is the first instance that will use every field.

## Base

| Repository | Branch | Based on |
| ---------- | ------ | -------- |
| Theorem-UI | `main` `17d103b8` | PRs #128 (`4b2680b9`), #129 (`8d84c688`) and #139 (`351ce552`) merged (`211a745c`); review follow-ups #142 (cabinet single owner, writer transport recovery, this tracker) merged. #129 was the content superset; #139's history was tied in so all three marked merged. |
| Theorem    | `main` `95ace474` | Backend reconciled in #1110: #1102 (durable runs/results/subjects) + #1099 (free authoring, Rerun traces, construction-only handoff) merged; #1096 ported (conversation authoring guidance + single-source contract) and closed. Network policy open-by-default with user-set limits, matching the UI sandbox. |

## What exists now

```text
Theorem-UI
  @theorem/runtime            src/lib/blocks/artifact-runtime/   optional App library, no dependencies
    types.ts                  ArtifactSourceRef BuildRef EngineRef RunRef(axes) ObservationRef CheckpointRef
                              SignalDescriptor SignalValue DecisionRecord ObservedFact TimeAxis
    context.ts                ResultRef SubjectRef SelectionRef ContextBinding ContextSession (any artifact)
    operations.ts             Operations: authored, discoverable operations, recovery kinds, exact-key reuse
    values.ts                 exact bits/integers (bigint, integer text); X/Z shown, never decoded as numbers
    digest.ts                 theorem.canonical-json/1 + SHA-256 (shared vectors with theorem-apps)
    session.ts                SessionObservations (owned copies; evicted != latest; identity-mismatch)
  @theorem/spatial
    engine.ts                 Settled.unsettled from each nested network's final evaluation; bigint-safe values
    trace.ts                  TRACE_DOMAIN = 'settlement'; capture(cycle) atomic; holds(); reproducibility 'recorded'
    view.ts / chrome.tsx      groundAt captures synchronously; reveal(observation) navigates exactly
    dossier.tsx               groundedContext checks agreement; unavailable carries no values; referenced moment status
    durable.ts                DurableTrace: writes a run from index 0 through an asked moment (parent first for a fork)
  host
    artifact-store.ts         typed client for /api/apps/v1/artifacts (bytes first, CSRF retry), RunWriter
    app-artifacts.ts          window.theorem.artifacts for an App: record / result / resolve; names the running revision
    bridge.ts / app-bridge.ts artifacts.record, artifacts.result, artifacts.resolve (zod-checked)
    document-app.tsx          Ask names the running revision; queued questions keep failures (undelivered)
    app-dossier.ts            ContextBinding (explicit run source kept); operations discovered; envelope never cut

Theorem (rustyredcore_THG/crates/theorem-apps)
  artifact_run.rs             the run records in Rust; canonical_json (JS numbers); x- capabilities; TimeAxis
  artifact_result.rs          ResultRef SubjectRef SelectionRef ContextBinding, ids checked against the browser
  store/artifact_runs.rs      immutable runs, ordered idempotent chunks, checkpoints, forks, exact resolve
  store/artifact_results.rs   immutable results after their bytes; resolve_artifact_subject
  store/artifact_blobs.rs     artifact bytes as immutable graph records by digest (1 MiB), stored_* writers
  service/artifacts.rs        AppService methods for the routes
Theorem (rustyredcore_THG/crates/rustyred-thg-server)
  theorem_apps_artifacts_api.rs  /api/apps/v1/artifacts/{blobs,runs,chunks,checkpoints,results,resolve}
```

### Decisions taken while implementing

- The contracts are an App library (`@theorem/runtime`), so an App's own code and
  the host read the same types, and an agent can import, copy or ignore it. This
  added a `tsconfig.json` path alias next to the existing `@theorem/annotate` one.
- A spatial model's run is computed inside the presentation, so its execution
  source is the revision running. A presentation-only revision that reuses an
  older run (plan section 5) needs an engine that runs apart from the
  presentation; the binding already keeps `presentation` and `run.source` apart.
- The running revision is the last one whose page built. A state-only save
  bumps the document revision without changing the page; then the newest
  revision is the one named, since it is the same page.
- Fact rows are read from the recorded frame of the moment asked about, not from
  the live part. When a reference must be cut to fit 8,192 bytes, the moment and
  run are never cut, other keys go largest first, and facts are halved from the
  end with `factsOmitted` saying how many went.
- A question asked while the conversation is answering is held in the host and
  sent when the turn ends. It is shown in the dossier at once, marked `queued`.
- A re-run's parent moment refers to the replaced run. Once a run is replaced,
  a question about one of its moments reports the moment as no longer held
  rather than reading the same index from the new run.

- (Review C) The question binding is general: `ContextBinding` (which replaced
  `RuntimeBinding`) names a subject (a source, a result or a run moment) and
  an optional selection the artifact interprets. `ViewState` was removed; a
  view is the artifact's own business.
- (Review B) A spatial run says `recorded`, not `deterministic`: its parts may
  read time, data or randomness, so only its saved observations reproduce it.
- (Review B) Canonical JSON is versioned (`theorem.canonical-json/1`); values
  JSON has no form for are written explicitly (`$bigint`, `$bytes`, `$date`) or
  refused, never silently changed. The backend writes numbers as JavaScript does.
- (Review A) An unavailable moment sends no values, recent changes or settled
  claims. Show referenced moment navigates to the exact observation or says it
  was evicted or replaced; it never scrubs to the same index of another run.
- (Review C) A capture never claims a producer build or reproducibility; what is
  not known is listed in `unknowns`.

## Evidence (review follow-up D, persistence)

A question about a spatial moment now writes the run through that moment
before it is sent: the App's `DurableTrace` hands its observations to the page
(`artifacts.record`), the page's `RunWriter` stores each chunk's bytes and then
the chunk, and the question says `observationLifetime: 'durable'` only when
that succeeded. Each moment is written with its state (the canonical JSON its
digest is of: values, part states, inputs set), checked against the digest
before it is stored, so the moment can be read back after the App closes. The
store answers the revision the stored run names, and the question names that
same revision instead of working one out separately. A re-run is written after its parent, through the cycle it
forked from, because the store refuses a fork whose parent never recorded that
moment; the trace keeps up to 16 replaced runs for this. A run whose early
cycles were dropped (more than 5000 settles before the first question) is not
written and stays `session`: the store takes runs only from index 0, and this
does not invent a partial run.

| Check | Result |
| --- | --- |
| `bun test` artifact-store, app-artifacts, spatial (durable), bridge, app-check, app-dependencies, theorem, artifact-runtime | pass except one test that needs esm.sh through the proxy |
| new guard: every module a library's files import is registered | red with `durable.ts` unregistered, green with it |
| `tsc --noEmit` | clean except the pre-existing terminal-wasm module |
| theorem-apps | blob store and `stored_*` writers: reopen, tenant isolation, size bounds |

## Evidence (review follow-ups A to C)

| Check                                             | Result                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test src/lib`                                | 2424 pass, 3 fail; the failures need network (esm.sh through the proxy) or are the pre-existing palette case                                        |
| `bun test` artifact-runtime, spatial, app-dossier | pass, including shared digest, float and result-id vectors, atomic capture, exact reveal, nested convergence (red on the old engine)                |
| `tsc --noEmit`                                    | clean except the pre-existing terminal-wasm module                                                                                                  |
| theorem-apps (Theorem `0f424048`)                 | `cargo test -p theorem-apps --locked --lib`: 256 pass, 1 ignored (pre-existing); clippy `--lib --tests --no-deps` clean for theorem-apps; fmt clean |

Not run: a browser exercise of delayed Ask, rerun, eviction, failed build and
queued-send failure (review A7). These are covered by unit tests only.

## Evidence (first implementation)

| Check                                                                                                 | Result                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test src/lib/blocks/artifact-runtime src/lib/blocks/spatial src/lib/theorem/app-dossier.test.ts` | pass (runtime 12, spatial incl. grounding 25+, dossier 11)                                                                                                  |
| Acceptance: 4-bit 7+5, cin 0                                                                          | sum 12, final carry 0, stage carries 1,1,1,0 (grounding.test.ts)                                                                                            |
| Acceptance: 4-bit 7+9, cin 0                                                                          | sum 0, final carry 1                                                                                                                                        |
| Acceptance: 4-bit exhaustive                                                                          | all 512 inputs (with carry-in) equal integer arithmetic                                                                                                     |
| Acceptance: last good build                                                                           | `questionBinding` names the running revision and `latest.status: failed`                                                                                    |
| Acceptance: unavailable observation                                                                   | `observation: null`, `unavailable`, no facts                                                                                                                |
| Acceptance: delayed answer                                                                            | reply keeps its question's moment; `referencedMoment` offers it, never applies it                                                                           |
| Acceptance: wide digital values                                                                       | 64-bit round trip through JSON; 32-bit register value 42 kept                                                                                               |
| `tsc --noEmit`                                                                                        | clean except the pre-existing terminal-wasm module                                                                                                          |
| Full `bun test`                                                                                       | 3798 pass, 17 fail; the failures are in files this change does not touch (palettes, settings, App card previews) or need network (esm.sh through the proxy) |
| theorem-apps (Theorem `4728836b`)                                                                     | `cargo test -p theorem-apps --locked --lib`: 243 pass (12 new for artifact runs), `--test it` 3 pass; clippy `--no-deps` clean for the new files            |

Not run: the browser fixtures (`scripts/e2e/timeline*.mjs`), the signed-in live
journey, and any deployed environment. The arithmetic acceptance here checks the
facts handed to the model; it does not make the model's prose correct, only
gives it the exact values to refer to.

## 2026-11-19 review: what the merge closed

The review's Section 4 ("corrections before treating the integration as ready")
was the immediate delivery gate. These are fixed on `main` (evidence class:
source-implemented + unit/component-tested + fixture-browser-tested; **not**
signed-in product acceptance, which the review keeps separate throughout):

- **§4.3 React family** — one React/ReactDOM/JSX choice per App from explicit
  import pins; conflicting pins refused at build (`app-dependencies.ts`).
- **§4.2 one live owner (dock)** — the panel renders `ArtifactReferrer`
  ("Open in answer", focus-first then navigate) instead of a second iframe;
  older/non-live bodies unchanged (`artifact-panel.tsx`, `artifact-referrer.tsx`).
- **§4.4 writer retry (core)** — identical observation repeats are a no-op;
  conflicting repeats refused as `artifact_chunk_conflict` without stopping;
  only a true gap stops (`artifact-store.ts`).
- **§4.5 reveal race** — `reveal` rechecks `recordingId` after the async
  `holds`, before moving (`view.ts`).
- **§4.6 stale values** — `groundedContext` drops the displayed `interactables`
  stamp; all values come from the recorded observation (`dossier.tsx`).
- **§4.7 heat solver (core)** — convective cooling slope on the diagonal; fixed
  point preserved (<1e-11); glass h=200 converges (`heat-plate/solver.ts`).
- **Held questions** — conversation+document-scoped `dossier-queue.ts` survives
  the revision flip; send-time read prevents double-send (`document-app.tsx`).
- **Replay readings** — kept cycles store their settle; `scrubTarget` shows
  recorded readings, recomputing only on a new run (`trace.ts`, `view.ts`).

Validation on the merged tree: `bun run typecheck` 0; artifact-CI set 57/57;
`test:composer` 905/905; `src/lib/blocks src/lib/theorem src/components/artifacts
src/components/blocks` 1093 pass / 1 skip / 0 fail; live-CDN Luma 1/1; browser
`e2e:app-ts --built` 25/25, `e2e:spatial` 44/44, `e2e:glass` 4/4 (Chromium; Node
22 for rolldown). Six stale `inline-app`/`app-revision` tests (removed
"Interact" card flow) were re-grounded without weakening protected properties.

## Not done yet (dependency-ordered, per the 2026-11-19 review)

The review's packages 1–12 map onto W0–W12; this is the delivery order, not a
second tracker. Status lives in [checklist.json](checklist.json).

**Tier A — finish the baseline gate (packages 1–3 leftovers):**

- **Backend reconciliation (W0, package 1) — done.** Theorem #1110 (main
  `95ace474`) reconciled #1102 + #1099 and ported #1096's complementary authoring
  pieces (the shared source contract is single-sourced in the agent crate as
  `operations::conversation_app::AUTHORING_CONTRACT`; `write_app` guidance fires
  on admission; `read_app`/`write_app` survive a construction handoff). Network
  policy is open-by-default with user-set limits, matching the UI. Validated:
  cargo check 3 crates; theorem-apps 260; server app_turn_flow 6, artifact 8,
  conversation_work 161; clippy disallowed_methods 0; check-test-attributes 0.
  Remaining for product-live: a signed-in real-agent journey (package 6).
- **Cabinet runtime ownership (package 2 gap) — fixed.** The cabinet's
  "Open latest" on a live interactive App now renders `ArtifactReferrer`
  (`original-view.tsx`), the same single-owner pattern as the dock; the pinned
  read-only `AppRevision` default and non-live bodies are unchanged. Remaining:
  the cross-surface startup-once acceptance in a signed-in browser (package 6).
- **Writer transport recovery (package 3 gap, §4.4) — fixed.** A retryable
  failure (transport death, 5xx/408/429) rolls the writer back to stored progress
  and re-ensures the run instead of stopping it; lost acknowledgements reconcile
  by re-sending against the store's sequence-idempotent chunks; a permanent 4xx
  refusal still stops (`artifact-store.ts`).
- **Evidence hygiene (package 1).** Rewrite #139's template body with actual
  behavior/verification/gaps; classify the broader Composer mobile-nav timeout
  from evidence (do not assume unrelated).

**Tier B — general usable artifact workflow (packages 4–6; 8 in parallel):**

- **W0 / package 4 — inspectable libraries + callable operations.** Serve
  versioned declarations/source/examples through existing discovery (on-demand,
  not a growing prompt); connect authored operations to the client-operation /
  installed-App invocation path (UI registers only `app.check` today). Return
  operation version + input/result/source identity + receipt; honest
  browser-local lifecycle.
- **W4 / package 5 — saved-run reopen/recovery.** Wire `openRun` to surfaces;
  recording lifecycle flushing before eviction; recover acknowledged writers;
  engine checkpoints vs observation replay; cross-thread reopen with fork
  lineage; large-asset path beyond the 1 MiB blob bound.
- **Package 6 — prove the improvement workflow.** Two signed-in real-agent
  journeys (reservation + heat): create → interact → negative feedback →
  candidate → evaluate against preserved independent criteria → adopt with
  expected-revision check → reopen. Fixtures stay criteria, not substitutes.
- **W3/W7 / package 8 — preview/workspace (parallel).** Deliberate expanded
  inspection, one selection/run cursor, keyboard-accessible entity index,
  Rerun's 640px min not dictating narrow layout; Firefox + WebKit lanes.

**Tier C — compounding computation (W9 / package 7, into 5–6):**
source/dependency-derived fingerprints (the heat fixture still hashes a manual
`SOLVER` name/version), persisted transitive lock, operation-key→result lookup
via existing result owners, conservative invalidation, cold/reused measurement.

**Tier D — deeper fidelity (W5/W6 / packages 9–10, parallel once contracts
stable):** NMOS 6502 engine adapter (versioned checkpoint codec, conformance,
restore-vs-uninterrupted); procedural reconstruction→artifact (real produced
bytes not empty-hash manifests, glTF/GLB by reference, two different geometry
domains through the existing `ReconstructionDomain`).

**Tier E — portability + scale (W10–W12 / packages 11–12):** export/import
manifest with locked deps + lineage; Platinum/SceneOS native consumption of the
same protocol; bridge operations to `theorem-apps` definitions/releases/
discovery; feed verified improvements into the harness/evolution (generalize the
counter-specific evaluator first), on-demand hosting.

Minimum useful product milestone (review §8): a signed-in conversation creates a
useful App beyond a fixed catalog; it runs once, interacts, expands without
losing the session; a question/answer keeps exact source/result/run context
through a failed build or delayed reply; close and reopen the same state in
another thread; negative feedback yields a candidate checked against preserved
independent expectations; a presentation change reuses unaffected computation
and an execution change invalidates it — for both a conventional App and a
numerical model. The CPU then demonstrates deeper fidelity without defining the
platform.
