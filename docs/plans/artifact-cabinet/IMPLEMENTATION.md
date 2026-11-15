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

The represented revision's content is read through the existing thread
messages and upload content paths, without switching the foreground thread
(§9.3).

## Conflicts surfaced to the owner

1. **Project context column (§3.4).** The spec makes project instructions a
   compact disclosure; the owner-approved project home has a context column.
   Not changed silently.
2. **Navigation width.** The owner's sidebar is 248 px, the spec's baseline
   210 px. The 248 px sidebar is kept; the §4.1 budget is met by adapting
   (collapsing navigation or overlaying the cabinet) when the project track
   would fall under 480 px.
3. **Docked cabinet.** Per the spec, a persistent dock reserves real width;
   #111's outputs drawer was an overlay. The cabinet replaces that drawer, so
   there is one collection browser.

## Slice B — host and real reads

- `terminal/src/cabinet.rs`: the Ratatui cabinet (header, preference, search,
  filters, cards, footer). Columns follow §4.2's formula in CSS pixels;
  selection and scroll live here; a geometry epoch (cell size, gallery clip,
  slot rectangles keyed by card and revision, control rectangles) is emitted
  only when it changes.
- `src/components/cabinet/cabinet-drawer.tsx`: the host. It mounts the cabinet
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
