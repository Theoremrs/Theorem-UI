# Artifact cabinet — implementation record

Slice A of SPEC-THEOREM-ARTIFACT-CABINET-1.0 §13: the representation and
ownership boundary as bound in this checkout, the contract fixtures, and the
backend paths that were missing. Later slices append their evidence here.

## Approved reference

`approved/index.html` SHA-256
`9350c5a05aea66662f23819a20934c0d9c68d909235e6cc413fd664be7296008`, verified
against `bundle-manifest.json`. `approved/capture.py` and
`approved/test_prototype.py` are not run; acceptance uses the mounted product.

## Owners, bound

| Spec owner (§8.1)                      | Bound to                                                                                                                                                                    | Notes                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Project / artifact / document services | Theorem `theorem_organize::project_outputs` behind `GET /api/chat/v1/projects/:id/outputs`; thread messages via the SDK; uploads via `GET /api/chat/v1/uploads/:id/content` | Catalog fields and pagination added in Theorem (below)                                                          |
| Contribution registry                  | `src/lib/artifacts/contributions.ts`, `src/components/artifacts/artifact-registry.tsx`                                                                                      | Gallery resolves through `inertRepresentation` (`src/components/cabinet/contract.ts`), never `representationOf` |
| Cabinet controller                     | `src/components/cabinet/`                                                                                                                                                   | Catalog projection, per-view state, preview scheduling, open commands                                           |
| Pure Rust preview module               | `terminal/src/preview/` (`palette`, `raster`, `image`, `recipes`)                                                                                                           | No credentials, no network; exported as `render_preview`                                                        |
| Ratatui cabinet                        | `terminal/src/cabinet.rs` in the existing crate                                                                                                                             | Shares the crate, palette entry point and host bridge with Terminal                                             |
| Browser host                           | the right-hand host (`src/components/terminal/side-terminal.tsx` grown into Cabinet │ Terminal)                                                                             | Canvas preview layer, semantic controls, search input                                                           |
| Theme / preference owners              | `src/lib/appearance.ts` (device-local zustand persist), `src/components/terminal/terminal-theme.ts`                                                                         | `overrides.preview` added; absent means theme default                                                           |
| Artifact / runtime owners              | `src/components/artifacts/artifact-view.ts` (`open(artifactId, revision)`), `artifact-panel.tsx`                                                                            | Opening pins the represented revision                                                                           |

## Contract fixtures

`src/components/cabinet/contract.test.ts` (`bun test src/components/cabinet`):

- **Source identity** — geometry identity covers source digest, revision,
  recipe and version, renderer version and profile; presentation identity adds
  mode, and the palette digest only for pixel art. Recent order is time
  descending with an identity tie-break.
- **Inert-preview eligibility** — an app subject at `preview` or `landmark`
  never resolves a live presentation, with or without its preview renderer
  mounted. The registry's own `preview → thing` walk would reach the live
  `theorem-app`; `inertRepresentation` never offers live presentations, and also
  refuses `theorem-app.preview`, which renders the app's own markup in a frame.
- **Style override** — explicit preference wins; otherwise Expressive → pixel,
  Calm → full fidelity.
- **Stale results** — scope, revision, generation, mode and (for pixel art)
  palette must still match before a result replaces a visible preview.

Raster fixtures live with the converter: `cargo test --lib preview` in
`terminal/`.

## Backend paths that were missing (required work, not fixtures)

`ProjectOutput` named an output's thread and identity but not what a cabinet
card needs (§9.1). Added in Travis-Gilbert/Theorem on branch
`claude/artifact-cabinet`, native (no MCP `tools/call`):

- `mediaType` — an upload's detected media type; an artifact's from its kind
  and language.
- `artifactKind`, `digest` (the upload's content address or the artifact
  revision's content digest), `byteLen` where known.
- `category` (document, image, app, code, diagram, chart, review, other), the
  browsing filter an output falls under.
- `description {text, provenance}` — `derived` from an upload's preview text,
  `metadata` for an image's dimensions, `authored` only from an artifact's own
  description field; omitted otherwise, and the card then states facts
  (kind, format, size) rather than inventing a summary.
- Route parameters `limit` (1–200), `cursor`, `q` and `category` with
  `nextCursor` and an exact `total` of every match, so search and counts are
  not claimed from a partial client cache (§3.3).

An upload's bytes had no read route, so Theorem PR #1077 (fd31326) adds
`GET /api/chat/v1/uploads/:id/content`: owner-checked (another tenant gets
404), 410 when the upload is gone, `nosniff`, a sandbox CSP, and inline
disposition only for images. The existing upload lifecycle test covers it.

The represented revision's content is read through the existing thread
messages and upload content paths, without switching the foreground thread
(§9.3).

## Conflicts surfaced to the owner — decided

1. **Project context (§3.4).** Decided by the owner: project context is a
   15 rem right column beside the project track. The compact disclosure is not
   reintroduced.
2. **Navigation width.** Decided for the spec: the sidebar is 210 px
   (`PANEL_WIDTH` {184, 210, 420}, store version 9). The §4.1 budget starts
   from 210 px navigation and a 680 px project track.
3. **Docked cabinet.** Agreed: the docked cabinet reserves real width. It
   replaces #111's outputs drawer, so there is one collection browser.

## Slice B — host and real reads

- `terminal/src/cabinet.rs`: the Ratatui cabinet (header, preference, search,
  filters, cards, footer). Columns follow §4.2's formula in CSS pixels;
  selection and scroll live here; a geometry epoch (cell size, gallery clip,
  slot rectangles keyed by card and revision, control rectangles) is emitted
  only when it changes.
- `src/components/cabinet/cabinet-view.tsx`: the host. It mounts the cabinet
  with the terminal's wasm module and palette, paints each preview on a canvas
  at its slot (pixel art at a whole device-pixel scale on a black matte), and
  lays real controls over the drawing: one button per card (roving tabindex,
  arrows forwarded to Ratatui), the search input, filter buttons with
  `aria-pressed`, and the preview `select`. The drawn grid is `aria-hidden`.
- `src/components/cabinet/catalog.ts`: Theorem output to card; reads exactly
  the represented revision (an upload's content, or the artifact part with
  that `artifactRevision` from its own thread via `threads.get`), never a
  newer one, and never by switching the foreground thread.
- `src/components/cabinet/previews.ts` and `preview-worker.ts`: three
  conversions at a time in a Web Worker through `render_preview`; results are
  cached under card + revision + mode, so a stale result cannot reach a card
  that moved on.
- Opening shows the represented revision in a dialog over the page (artifact
  through `ArtifactView`, upload image or Markdown in place). The page, its
  composer and draft are untouched, and closing returns focus to the card.

## Slices C–E — previews, theme, acceptance hardening

- The cabinet replaces #111's outputs drawer as the one collection browser.
  The drawer is retired; outputs open from the cabinet tab of the right host.
- Touch and keyboard: every overlaid control grows to 24 px (44 px under a
  coarse pointer) around its drawn cell; the width handle is a keyboard
  separator (arrows ±16, Shift ±64, Home/End) with a 24 px hit area.
- Text scaling: the cabinet font is rem-based, a probe re-measures Ratzilla's
  cells when the root font changes, and the column formula uses
  `max(CARD_MIN_PX, 22 cells)`, so 200 % text drops to one column and filters,
  scope and status wrap instead of clipping.
- State vocabulary: a failed load says the collection is unavailable, never
  empty; a refresh failure keeps the last collection and says so; a failed
  preview names why and that the original still opens.
- Short windows: when the full header would leave the gallery under six
  rows, the header redraws compact (no scope, no spacer rows), so a short
  window at 200 % text still shows a card (`evidence/g14-short-200.png`).
  Stacked controls, wrapped filter rows included, sit a full target apart, so
  grown targets never overlap: filter rows 25 px apart with 25 px targets
  (fine), 50 px apart with 44 px targets (coarse) (`g14-wrap-*.png`,
  `scripts/targets.cjs`).

## Acceptance report (A01–A40)

Measured against the mounted product: `rustyred-thg-server` (Theorem PR #1077
head fd31326, embedded mode, no auth) on :8082 and the Vite dev server on
:3000, with one project ("Headland survey") seeded through the real chat API
by `evidence/scripts/seed.ts`: two sessions, one attaching `field-notes.md`,
one `headland-at-dusk.png`. Browser runs use the preinstalled Playwright
Chromium through `evidence/scripts/*.cjs`; their logs are `evidence/accept.log`
and `evidence/extra.log`. No fixture page or prototype screenshot is counted.

Status key: **PASS** — met in the mounted product (or, where the case is a
contract, by its named test); **PARTIAL** — what was shown is listed and the
missing part is named; **PENDING OWNER** — needs a human judgement.

| Case                                          | Status                            | Evidence                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Approved source custody                   | PASS                              | 28/28 manifest digests match; `approved/` unchanged in the diff; capture/test scripts never run                                                                                                                                                                                                     |
| A02 Mounted Ratatui cabinet                   | PASS                              | `evidence/01-docked.png`: the cabinet is the Ratatui app in the right host, drawn grid `aria-hidden`, real controls overlaid                                                                                                                                                                        |
| A03 Stable artifact identity                  | PASS                              | `contract.test.ts` identity cases (upload, artifact, review keep their own identity); identity is stable across reload in `accept.log`                                                                                                                                                              |
| A04 Cross-session original opening            | PASS                              | `sliceb.cjs`: both uploads, from two different threads, open their represented revision in the dialog; URL unchanged, foreground thread not switched (`02-original-0/1.png`)                                                                                                                        |
| A05 Scoped paginated catalog                  | PARTIAL                           | API: `limit=1` returns `nextCursor`, page 2 completes with `total` 2, `q` and `category` filter correctly, a foreign project returns 404. Not shown: a multi-page collection in the browser and its "N of M" label                                                                                  |
| A06 Real search filters and ordering          | PASS                              | Browser: "field" → 1, Images → 1, Apps → 0 with its empty state (`a06-apps-empty.png`); Recent order stable across reloads                                                                                                                                                                          |
| A07 No live preview fallback                  | PASS (contract)                   | `contract.test.ts`: an app at `preview`/`landmark` never resolves a live presentation, with or without the preview renderer; `theorem-app.preview` refused                                                                                                                                          |
| A08 Browsing has no external effects          | PARTIAL                           | Browsing issues no non-GET request (the one PUT is `_chat.tsx`'s app-wide library sync, present without the cabinet) and creates 0 iframes. Not shown: an app output, since none was produced in the seeded project                                                                                 |
| A09 Preview preference truth table            | PASS                              | `contract.test.ts` "lets an explicit preference win and otherwise follows the preset"; browser: Calm → full fidelity, Expressive → pixel                                                                                                                                                            |
| A10 Saved override and reset                  | PASS                              | Pixel override survives reload and a preset switch; Reset shows "Theme default (pixel)" under Expressive and the stored preset is kept (`accept.log`)                                                                                                                                               |
| A11 Cabinet and terminal lifetimes            | PARTIAL                           | The terminal screen is identical across cabinet visits and tab switches. Not shown: a live agent task running through the switch                                                                                                                                                                    |
| A12 Grounded descriptions                     | PASS                              | Cards show `derived` preview text and image `metadata` (1000 × 625) from the backend; `contract.test.ts` "describes unknown content factually"                                                                                                                                                      |
| A13 Revision race on open                     | PARTIAL                           | Opening pins `artifactRevision` and reads that revision only (`catalog.ts`). Not shown: a newer revision landing between selection and open                                                                                                                                                         |
| A14 Image normalization and fit               | PASS                              | Rust `fit_contains_without_stretch`, `transparent_pixels_take_the_matte_without_halo`; TS JPEG EXIF / thin / huge raster tests; real PNG renders unstretched                                                                                                                                        |
| A15 Pixel-grid and palette bounds             | PASS                              | `pixel_art_keeps_its_grid`, `every_recipe_stays_in_bounds_and_palette`, `thin_pixel_art_keeps_a_row_and_a_column`                                                                                                                                                                                   |
| A16 Source-specific versus generic art        | PASS (unit), owner review pending | `markdown_draws_its_own_blocks_and_no_pdf_badge`, `apps_are_sketched_from_their_markup_not_a_maze`, `pdf_without_structure_is_a_labelled_type_illustration`; generic art says so on the card                                                                                                        |
| A17 Recipe extension without renderer branch  | PASS                              | `a_seventh_recipe_joins_through_the_registry_alone`                                                                                                                                                                                                                                                 |
| A18 Graph topology honesty                    | PASS (unit), owner review pending | `graph_draws_only_source_edges`, `graph_statements_and_labels_do_not_invent_edges`, `dense_graph_says_it_is_partial`                                                                                                                                                                                |
| A19 Chart geometry from data                  | PASS                              | `chart_area_tracks_its_data_within_three_points`, `tiny_category_is_reported_not_enlarged`, `omitted_categories_do_not_swell_the_last_slice`                                                                                                                                                        |
| A20 Bounded malformed and large input         | PARTIAL                           | `rejects_before_allocating`, `an_overflowing_total_falls_back`, `invalid_series_falls_back_with_a_named_reason`, TS "unreadable header … refused". Not shown: fault injection in the browser                                                                                                        |
| A21 Deterministic raster generation           | PASS                              | `deterministic`, `every_recipe_is_repeatable`                                                                                                                                                                                                                                                       |
| A22 Correct cache dependencies                | PASS                              | `contract.test.ts` "keeps geometry across palettes…", "invalidates geometry on revision, digest, recipe version or profile"; cache key `key                                                                                                                                                         | revision | mode` |
| A23 Out-of-order async work                   | PARTIAL                           | `contract.test.ts` "publishes only a result that still matches". Unit level only; no reordered worker responses in the browser                                                                                                                                                                      |
| A24 Whole-terminal theme projection           | PASS                              | `a24-calm.png`, `a24-expressive.png`, `a24-expressive-dark.png`: header, filters, cards, footer and selection all re-theme                                                                                                                                                                          |
| A25 Invalid custom-theme repair               | PARTIAL                           | `appearance.test.ts` "portable documents reject unsupported versions, fields, fonts and role names". Not shown: repairing a bad custom theme in the browser                                                                                                                                         |
| A26 Rendered contrast pairs                   | PARTIAL                           | `appearance.test.ts` "every emitted built-in set satisfies all registered role pairs after quantization", "rejects a candidate that passes on canvas and fails in selected state". Not shown: contrast measured from rendered pixels                                                                |
| A27 Faithful originals stay faithful          | PASS                              | The dialog image is 1000 × 625 natural size with `filter: none`, `mix-blend-mode: normal`, opacity 1 (`02-original-0.png`)                                                                                                                                                                          |
| A28 Preview and frame alignment               | PASS                              | Canvas vs slot offsets [0,0,0,0] at DPR 1, 1.5 and 2, after resize, expanded, and at 200 % text                                                                                                                                                                                                     |
| A29 Keyboard pointer and touch parity         | PASS                              | Arrows move selection with `aria-current`; Enter opens; Escape returns focus to the card; touch tap opens; targets 44 px coarse / 24 px fine; keyboard resize 466 → 546 px, End → 340, restored                                                                                                     |
| A30 Accessible semantic ownership             | PASS                              | `a30-aria.yml`: searchbox, "Preview style" combobox, "Filter artifacts" group with pressed buttons, one button per card in a list; drawn grid hidden                                                                                                                                                |
| A31 Search input and shortcut scope           | PASS                              | "café 日本語 Headland" entered intact; `/` typed in the composer stays in the composer                                                                                                                                                                                                              |
| A32 Draft and task continuity                 | PARTIAL                           | The composer draft survives opening, expanding and closing originals; focus returns. Not shown: undo history, live references, or a running task across the open                                                                                                                                    |
| A33 Layout width conservation                 | PASS                              | 1536: nav 210, main 810, cabinet 454, 2 columns; 1280: docked, nav overlaid by #111's 35 rem rule, main 764; 390/320: overlay, 1 column, no horizontal scroll (`a33-w*.png`)                                                                                                                        |
| A34 Text scaling and long labels              | PASS                              | 200 %: font 25 px, 1 column, filters wrap, title in full (`a34-text200.png`)                                                                                                                                                                                                                        |
| A35 Honest state vocabulary                   | PARTIAL                           | Offline: "unavailable, not empty" (`a35-offline.png`); failed preview names why and that the original opens (`a35-preview-failed.png`). Not shown: the stale-after-refresh branch (coded; the query client did not refetch on visibility)                                                           |
| A36 Visual and recognition acceptance         | PENDING OWNER                     | Screenshots above, plus `03-expanded.png` and `04-overlay.png`, for owner review against the approved reference                                                                                                                                                                                     |
| A37 Permission change and cache privacy       | PARTIAL                           | Backend: cross-tenant outputs 404 and upload content refused (`upload_http_lifecycle_persists_context_and_refuses_cross_tenant_access`). Not shown: losing access while the cabinet is open, and cache eviction                                                                                     |
| A38 Worker and workload measurement           | PARTIAL                           | Cold open to previews ≈ 2.0 s, warm reopen ≈ 1.05 s, JS heap ≈ 364 MB (dev build); conversion runs in the worker in pixel mode; wasm 1.20 MB / 436 KB gzip. Long tasks of 160–470 ms remain, from style/layout of the drawer and Ratzilla's DOM grid, not conversion. Production build not measured |
| A39 Historical revision and editor continuity | PARTIAL                           | Opening reads the represented revision, not the newest (`catalog.ts`). Not shown: an older revision opened while an editor holds a newer one                                                                                                                                                        |
| A40 Complete real product journey             | PARTIAL                           | Real uploads from two sessions: browse, search, filter, preview in both modes, open original, expand, restore, close with draft intact (`sliceb.cjs`). Not shown: an agent-produced artifact in the journey                                                                                         |

Summary: 25 PASS (two with owner review of the art pending), 14 PARTIAL with
the missing step named, 1 pending owner review. No case is marked passed from
a fixture page.

Known baseline failures not introduced here: TS2307 in `terminal-screen.tsx`,
six palette tests, eslint errors in `run-input.ts` and the runtime tests, one
flaky hosted-app test.
