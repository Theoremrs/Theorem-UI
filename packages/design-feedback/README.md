# Design Feedback

Executable feedback for an agent improving a rendered interface. The package collects bounded observations, evaluates them, compares captures, and runs controlled layout probes. Findings identify the element, source location when available, measurement, expectation, authority, and evidence. There is no aggregate beauty score.

The core is dependency-free ESM. The browser adapter can run in Playwright or in Theorem's sandboxed App frame. The CLI uses `playwright-core`, `pngjs`, and `pixelmatch`; it does not need Theorem's application server. The existing `scripts/design-oracles/` checks remain the application-specific policy and regression suite.

## Run

From this directory, run `npm ci --ignore-scripts` to install the three CLI dependencies, then `node cli.mjs capabilities`. Browser capture needs a browser executable; use `--executable /path/to/chromium`, or a browser installed for the configured Playwright version. The launcher also accepts already-installed dependencies from the calling project and `DESIGN_FEEDBACK_NODE_MODULES` or the host's `CODEX_PRIMARY_RUNTIME_NODE_MODULES`.

```sh
node cli.mjs capture http://localhost:3000/story/reading --out evidence/before
node cli.mjs capture http://localhost:3000/story/reading --out evidence/after
node cli.mjs compare evidence/before evidence/after --out evidence/compare
node cli.mjs inspect evidence/after/observations.json --out evidence/inspection
node cli.mjs probe http://localhost:3000/story/reading --out evidence/probes
```

Use `node cli.mjs --help` for exact options. Each capture includes a screenshot, observation JSON, finding JSON, capture metadata, and a local HTML report. A compatible comparison includes a thresholded heatmap, an exact pixel difference map, before/after images, a three-panel collage, and JSON geometry deltas. Output directories are protected against accidental replacement unless overwrite is explicitly requested.

Captures operate on the actual browser viewport. Keep viewport, scroll position, DPR, engine, theme, and fixture state controlled. Prefer a deterministic local story or fixture and assign stable `data-design-id` values to important elements. A DOM snapshot reconstructed through SVG is a different evidence kind; do not treat it as a browser screenshot.

## What the measurements mean

| Result | Interpretation |
| --- | --- |
| Text contrast | WCAG contrast calculation for the opaque sRGB foreground/background pair the collector could resolve. Applicability and whole-page conformance still require review. |
| Target size | Configurable design target. The rectangle alone does not adjudicate WCAG spacing, inline, equivalent-control, or other exceptions. |
| Typography | Opt-in line-height and approximate reading-measure targets. Defaults do not impose a universal font scale or preferred reading width. |
| Overflow | A localized geometry diagnostic. Some overflow is intentional; inspect the associated evidence before changing it. |
| Lone wrapped item | A wrapping flex row or a grid whose last row holds one item under rows of several. A review diagnostic for the measured width, not a rule that every row must be full. |
| Geometry changes | Matched element position and size changes, with shared displacement distinguished from local resizing. |
| Pixel differences | Exact changed pixels and a thresholded pixelmatch diagnostic. Changed pixels are not counted as design regressions. |
| Probes | Evidence from controlled text-spacing, viewport, and reduced-motion variations, with their coverage stated explicitly. |

`pass`, `fail`, `review`, and `unknown` are separate outcomes. A report can have passing measured pairs and unresolved paint in the same capture. Coverage records scan/measurement caps and omitted findings. Gradients, background images, filters, blending, and unsupported paint are not assigned invented contrast ratios. The requested CSS font family does not prove which face rendered each glyph.

The first adapter covers ordinary DOM text and boxes. Canvas/image content, nested frames, shadow-root content, and semantic user-task completion need other evidence. Native adapters and specialist vision models can later contribute observations, but are not implemented by this package. The portable JSON interface lets a model consume measurements without needing to interpret an image; a vision-capable model can additionally inspect the screenshot and localized evidence.

## Artifact inspection

Theorem's existing `app.check` operation accepts `design: true` to request measurements from the running App sandbox before it is disposed. The shared evaluator returns these as `design` feedback. This is opt-in and preserves the normal build/type/runtime inspection path.

The artifact path measures the live iframe DOM, in the page's light theme and again in its dark one: the page's look for the scheme it is not showing is read from its own stylesheets in a hidden document, handed to the App as a theme change, and transitions are ended before measuring. Text with no opaque background of its own is measured against the page's background in that scheme. An issue found in only one scheme names it. Its optional `picture` is still an approximate reconstruction and is labeled accordingly. `runMs: 0`, a connection timeout, a malformed response, or a failed design measurement produces an explicit unavailable result. This integration adds no new Rust service or vision model. A deployed client must include this change before an agent using that client can request it.

## Maintain

`npm test` runs the portable toolkit tests. Set `DESIGN_FEEDBACK_TEST_BROWSER` to exercise the real-browser tests; absent prerequisites are reported as skipped, not passed. Set `DESIGN_FEEDBACK_TEST_NO_SANDBOX=1` only when the test environment requires it. Root `test:design-feedback` also runs the App adapter tests, which need Node's TypeScript stripping support (tested on Node 24). The separate `e2e:design-feedback` gate bundles the production sandbox source registry and exercises the real iframe RPC; see its prerequisites in `scripts/e2e/app-design-feedback.mjs`.

The installable `design-feedback` skill is a thin instruction layer with an `INDEX.md` routing table and a bundled copy of these executable modules. To export the current source into an existing skill, run `node scripts/export-design-feedback-skill.mjs /absolute/path/to/skill` from the repository root. The generated manifest records file hashes, source revision, and whether the source had uncommitted changes. Export from a committed source revision for release; do not maintain a separate implementation in the skill bundle.

## Sources and design choices

The two-level index pattern is inspired by [skill.color-expert](https://github.com/meodai/skill.color-expert/tree/5bf7c7704d56bccc6aeea38c36bcf449abe56a6c/references). Its contents are not copied here.

The measurements distinguish standards from chosen targets using [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [text-spacing adaptability](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html), and [target-size exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Text-spacing settings are a test override, not a required default design. Visual comparisons use [pixelmatch](https://github.com/mapbox/pixelmatch) and [Playwright](https://playwright.dev/docs/screenshots).
