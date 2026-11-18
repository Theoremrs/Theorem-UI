# Durable artifacts: implementation record

Governing plan: [PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md](PLAN-DURABLE-ARTIFACTS-CPU-WORKSPACE-2026-11-18.md).
Item status: [checklist.json](checklist.json).

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
    types.ts                  ArtifactSourceRef BuildRef EngineRef RunRef ObservationRef CheckpointRef
                              SignalDescriptor SignalValue ViewState RuntimeBinding DecisionRecord ObservedFact
    values.ts                 exact bits/integers (bigint, integer text); never Number for wide values
    digest.ts                 canonical JSON + SHA-256 (shared vector with theorem-apps)
    session.ts                RuntimeSession (capture() for a question), SessionObservations (evicted != latest)
  @theorem/spatial
    engine.ts                 Settled.unsettled: loop parts still changing when the settle gave up
    trace.ts                  TRACE_DOMAIN = 'settlement'; observation(cycle); runRef(); rerun records parent
    view.ts / chrome.tsx      snapshot.trace.{runId, ground()}; SpatialTrace.ground(cycle?)
    dossier.tsx               groundedContext: run, exact moment, fact rows; Show referenced moment
  host
    document-app.tsx          Ask names the revision running (last good build), holds mid-turn questions
    app-dossier.ts            dossierBinding / questionBinding; moment kept whole when trimmed

Theorem (rustyredcore_THG/crates/theorem-apps)
  artifact_run.rs             the same records in Rust; canonical_json; IntegerText; Digest
  store/artifact_runs.rs      immutable runs, ordered idempotent chunks, checkpoints, forks, exact resolve
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

## Evidence (this change)

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
| theorem-apps unit tests                                                                               | see the Theorem PR                                                                                                                                          |

Not run: the browser fixtures (`scripts/e2e/timeline*.mjs`), the signed-in live
journey, and any deployed environment. The arithmetic acceptance here checks the
facts handed to the model; it does not make the model's prose correct, only
gives it the exact values to refer to.

## Not done yet, in plan order

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
