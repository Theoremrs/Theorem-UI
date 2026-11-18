# Durable artifacts: implementation record

Governing plan: [PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md](PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md).
Item status: [checklist.json](checklist.json).
Review followed: REVIEW-PR130-DURABLE-ARTIFACTS-2026-11-18 (follow-ups A to D
replace the earlier G0/G1-first order). A, B and C are implemented below; D is not.

The plan leans on a CPU, but nothing below is CPU-specific. The references are
for any artifact that executes something (a teaching circuit, an emulator, a
physics solver, a trained model) and an artifact with no engine needs none of
them. The CPU is the first instance that will use every field.

## Base

| Repository | Branch                         | Based on                                                   |
| ---------- | ------------------------------ | ---------------------------------------------------------- |
| Theorem-UI | `claude/project-thread-y6882q` | PR 129 head `3a279320` (stacked on PR 128 `4b2680b9`)      |
| Theorem    | `claude/project-thread-y6882q` | `main` `dda471e5` (PR 1099 is not needed by these records) |

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
that succeeded. A re-run is written after its parent, through the cycle it
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

## Not done yet

Review follow-up C, last item, and D:

- Expose `@theorem/runtime` and `@theorem/spatial` declarations and source to the
  authoring agent through a native capability (also W0 below).
- D: a reservations app and a checked heat model built through the
  normal authoring workflow, feedback with before/after evaluations, cosmetic
  reuse and semantic invalidation, reopen in another thread, transfer.
- Fidelity claims and evaluator records (G2) through the existing evidence owners.

In plan order:

- **W0** the authoring agent still cannot read `@theorem/spatial` or
  `@theorem/runtime` declarations; the App contract is a prompt include in the
  backend (PR 1099). Needs a native capability that serves the generated
  declarations.
- **W3** responsive preview/workspace modes, Signals drawer, Rerun out of the
  default inline view.
- **W4** browser writer that appends trace chunks and checkpoints to the backend
  records, a native route for them, retention policy, legacy state migration.
- **W5** chips m6502 compiled to WASM in a worker with a checkpoint codec; the
  run store already checks codec and engine compatibility for it.
- **W6–W12** CPU presentation, focused Signals, feedback-to-candidate evaluation,
  computation reuse, portability, Cloudflare adapter, learning.
