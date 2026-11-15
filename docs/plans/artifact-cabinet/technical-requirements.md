# Artifact Cabinet — Technical Requirements and Verification

**Governing spec:** [SPEC-THEOREM-ARTIFACT-CABINET-1.0](SPEC-THEOREM-ARTIFACT-CABINET-1.0.md)  
**Method:** [Procedural Pixel Previews](procedural-pixel-previews.md)  
**Status:** Required behavior; implementation acceptance has not been executed.

## Reading this register

Each requirement has one owner and a named observation. A source-code assertion, a synthetic raster test, a mounted-browser check, and a real-service journey establish different things. Results must state which evidence was obtained. Missing evidence is not a pass. The prototype's historical 13 checks are not evidence for backend, WASM, or deployed behavior.

`Standard` marks an external accessibility requirement in its applicable scope. `Contract` marks an architectural/product obligation. `Target` marks a calibrated design/performance goal. Do not relax a Contract or Standard to improve a screenshot; target changes require a documented design reason and before/after measurements.

## Requirements

| ID | Class | Required behavior and reason | Responsible owner | Acceptance |
|---|---|---|---|---|
| CAB-001 | Contract | Preserve the approved gallery composition and artifact-specific pixel language. Sample data never becomes production data. | Cabinet composition | A01, A02, A36 |
| CAB-002 | Contract | Every card/preview/open operation names the same canonical artifact and represented revision. A thumbnail never creates or replaces a source artifact. | Catalog + artifact owner | A03, A04, A13 |
| CAB-003 | Contract | Project catalog, search, filters, totals, and pagination respect authorization and completeness. Duplicate titles are not identities. | Catalog adapter | A05, A06 |
| CAB-004 | Contract | Resolve originals across sessions without changing the foreground conversation simply to populate a thread-local cache. | Open adapter + viewer | A04, A32 |
| CAB-005 | Contract | Both gallery modes are inert. Reject live-session/effectful fallbacks even if a generic representation resolver selects them. | Representation resolver | A07, A08 |
| CAB-006 | Contract | Explicit preview preference overrides the preset. Theme-default resolves Expressive to pixel and Calm to full fidelity. Light/dark is independent. | Appearance preferences | A09 |
| CAB-007 | Contract | Preview preference persists using the existing personal preference owner; reset-to-default removes the override without losing other state. Actual synchronization scope is declared. | Preferences + hydration | A10 |
| CAB-008 | Contract | Cabinet/Terminal share a host but not an agent-session identity. Browsing starts no model/run; switching views preserves ongoing work. | Host + view controllers | A11, A32 |
| CAB-009 | Contract | Descriptions and metadata have source provenance. Unknown values remain unknown; type illustrations cannot claim source-specific imagery. | Catalog metadata + recipe | A12, A16 |
| CAB-010 | Contract | Recipes use one bounded interface under existing artifact presentation discovery. Adding a kind does not require a new gallery component branch. | Preview registry | A17 |
| CAB-011 | Contract | Images use actual revision-bound source data, correct orientation/normalization, bounded filtering, Oklab quantization, and no smoothing on enlargement. | Pure pixel converter | A14, A15 |
| CAB-012 | Contract | Structured recipes draw the actual relevant structure or a labeled type illustration. No generic maze for every app; no invented graph/chart data. | Type recipes | A16, A18, A19 |
| CAB-013 | Contract | Validate resource bounds before allocation/processing where possible. Unsupported, malformed, and oversized inputs yield a readable named result and preserve browsing. | Input adapter + worker | A20 |
| CAB-014 | Contract | Fixed input and pinned implementation produce stable normalized raster indices/palettes. Cache identity includes every output-changing input. | Converter + cache | A21, A22 |
| CAB-015 | Contract | Out-of-order workers cannot publish a stale source/theme/mode/scope result into the current card. | Scheduler/controller | A23 |
| CAB-016 | Contract | Theme changes apply a coherent complete terminal role contract to Cabinet and Terminal. No purple/gold preference or per-component hardcoded accent patch. | Theme adapter | A24, A25 |
| CAB-017 | Standard | Applicable readable text meets unrounded WCAG contrast thresholds and essential identifying graphics meet applicable nontext contrast. | Theme + rendered controls | A26 |
| CAB-018 | Contract | Pixel art adopts illustration palette changes without changing geometry. Full-fidelity content retains its source appearance, subject only to its explicit existing theme contract. | Palette mapping + viewer | A22, A27 |
| CAB-019 | Contract | One geometry epoch controls frames, thumbnail slots, pointer targets, and accessible controls. Zoom/resize/scroll cannot detach them or double-dispatch actions. | Ratatui/host bridge | A28, A29 |
| CAB-020 | Contract / Standard | One accessible semantic owner exists per action. Keyboard/touch/pointer can browse, open, and return with visible focus and no keyboard trap. | Host semantics + controller | A29, A30 |
| CAB-021 | Contract | Search supports composition, paste, Unicode, and mobile keyboards. Shortcuts never hijack another active editor. | Search input bridge | A31 |
| CAB-022 | Target | Main composer/session width remains useful. Regions obey the width budget; use overlay/reflow rather than shrinking text. | Shell layout | A33 |
| CAB-023 | Contract / Target | Gallery adapts to available width/text scale, including one column. No viewport-wide horizontal overflow or clipped essential captions/actions at required captures. | Gallery layout | A33, A34 |
| CAB-024 | Contract | Loading, refreshing, unsupported, failed, inaccessible, empty, and disconnected states are distinct. A preview failure does not imply the original is absent. | Catalog + preview state | A35 |
| CAB-025 | Contract | Authorization applies to previews, descriptions, hidden metadata, buffers, and caches. Revoked/inaccessible data is removed from active presentation as required by the existing access policy. | Service + cache adapter | A37 |
| CAB-026 | Contract | Conversion and capture are outside frame/render callbacks and off the UI thread. Queue/concurrency are bounded and identical work is deduplicated. | Worker scheduler | A38 |
| CAB-027 | Target | Record performance on the declared workload, including cold/warm view, input latency, long tasks, memory, bundle size, and unsupported outcomes. No unmeasured speed claim. | Verification owner | A38 |
| CAB-028 | Contract | Revision/progress updates preserve anchor and selection. An item shown at revision A opens A even when B arrives during activation. | Catalog/controller | A13, A23 |
| CAB-029 | Contract | Closing, expanding, changing style, and looking at history preserve drafts/undo/attachments/runs according to their existing owners. | Host/viewer | A32, A39 |
| CAB-030 | Contract | Faithful thumbnails do not execute live apps; approved originals use actual viewer/activation permissions. Representation style is independent of distance/liveness. | Registry + original opener | A07, A08, A27 |
| CAB-031 | Contract | Real WASM cabinet, actual measured typography, and six source-kind fixtures are visually compared with the approved reference. Pure converter tests cannot replace this. | Mounted app verification | A02, A36 |
| CAB-032 | Contract | The real create → catalog → preview → original → revise → reconnect/reload journey succeeds using existing owners. No fixture or mock endpoint substitutes for this gate. | Whole vertical slice | A40 |

## Measurement conditions

Reference desktop capture: **1536 × 1080 CSS pixels**, initial device scale **2**, default text scale, application zoom 100%. Also capture a 1280 px desktop, **390 × 844** narrow viewport, device scale 1 and a fractional scale, and text zoom/enlargement. Record actual font face, cell metrics, browser build, renderer build/hash, source revisions, palette revision, and geometry epoch.

At 200% text enlargement, use fewer columns or a full-surface cabinet. Test 320 CSS px reflow where applicable. A gallery does not justify a blanket spatial-content exception for its text controls. Verify the relevant requirements in the current accessibility baseline; this document is not a complete accessibility certification.

For pixel-raster comparison, use immutable normalized inputs. For screenshot comparison, pin capture environment and distinguish font/browser antialiasing differences from changed logical art pixels. Keep region-aware visual review so a good full-screen score cannot hide a failed card.

### Mathematics checks

- Width conservation: measured main width agrees with the allocation equation within **1 CSS px** at the controlled baseline.
- Pixel indices: same source/recipe/profile yields exactly identical normalized index buffers within the pinned execution target.
- Palette: each output index is in range; unique color count is at most the selected profile's declared limit.
- Aspect ratio: fitting follows the declared integer rounding rule; no independent x/y stretch.
- Slot alignment: host preview rectangle and allocated Ratatui rectangle differ by at most **1 CSS px** in the controlled environment.
- Contrast: compare unrounded calculated ratios against the applicable thresholds using actual foreground/background roles.
- View invariance: style/theme/open/close/expand operations cause **zero artifact-content mutations** unless the user separately invokes an authorized edit.

Numerical tolerances above are product contracts for these controlled measurements, not guarantees about every display stack. Changes require explicit rationale and fixtures. Missing measurement data remains unresolved.

## Workload and performance record

Use a generated fixture catalog of **1,000 metadata entries**, a maximum of **24 visible + buffered cards** in the processing window, mixed real-format inputs, and the worker limits in `preview-profiles.json`. This workload is a benchmark fixture, not a claim about current user data.

Report cold and warm time-to-first-usable-cards, p50/p95 keyboard-to-selection paint, main-thread long tasks attributable to conversion, peak accounted preview buffers and observed process/worker memory, failed/deferred jobs, cache hit ratio, source bytes, final WASM bundle delta, and decoder/quantizer versions. Compare against the current host under the same conditions. The release gate requires no synchronous conversion in the render/input path and bounded work, not an invented universal millisecond promise.

CPU/memory behavior of untrusted capture is separately bounded by its execution owner. A browser-worker abstraction is not proof of a strict memory sandbox.

## Evidence packet for completion

Keep an acceptance report with each case's current result, observed evidence class, exact command or interaction, build/source revision, relevant screenshots/log references, and remaining limitation. New commands in the implementation must be copied from the real checkout rather than fabricated here.

Required evidence layers:

1. Pure recipe/image/math tests, including known bad and boundary inputs.
2. Actual WASM build and host/geometry interaction tests.
3. Contract tests against the catalog, authorization, and original-open services.
4. Mounted browser keyboard/IME/pointer/resize tests and accessibility inspection.
5. Real-source integrated acceptance journey and approved-design screenshot comparison.

A production failure does not become resolved by rerunning a synthetic fixture. Conversely, a pure color conversion does not require an expensive end-to-end run for every test. Evidence should match the property being claimed.
