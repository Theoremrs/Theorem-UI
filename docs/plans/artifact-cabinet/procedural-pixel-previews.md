# Procedural Pixel Previews — method and implementation contract

**Companion to:** [SPEC-THEOREM-ARTIFACT-CABINET-1.0](SPEC-THEOREM-ARTIFACT-CABINET-1.0.md)  
**Version:** 1.0  
**Register:** Normative engineering method, with research and optional extensions labeled  
**Date:** November 14, 2026

## 1. Recommendation

Build a **small deterministic miniature illustrator** with two source-dependent paths:

**Structured artifact → source-aware drawing recipe → indexed pixel image.**

**Existing image or safe app capture → normalized raster → low-resolution sampling → palette quantization → indexed pixel image.**

Both paths produce the same output and receive the same terminal illustration palette. They do not need an image model. The original artifact is opened independently through its real viewer.

This matches how the approved mockup obtains its character: its document, code, graph, and chart are deliberately composed small illustrations; its landscape is reduced from an original; its maze comes from the same maze data as the playable sample. Merely reducing a screenshot of a document to unreadable pixels would not reproduce the approved document icon.

The recommendation is a product-engineering choice, not a claim that these steps produce hand-crafted-quality pixel art for every photograph. Research on *Pixelated Image Abstraction* jointly optimizes spatial features and a small palette and reports improvements over naive reductions. That is useful evidence that “nearest-neighbor shrink” is not a universal high-quality conversion method; it is not a requirement to port that research system in version 1. [R6]

## 2. Three distinguishable result meanings

| Method | Evidence behind the picture | Examples |
|---|---|---|
| `source_raster` | A particular normalized source image/capture | A pixel coast derived from the actual coast image |
| `structured_recipe` / `provider_recipe` | Actual structured content drives the drawing | Graph connections, chart values, game map, document blocks |
| `type_illustration` | Only the verified kind and metadata are known | A generic page or app window when content cannot be previewed |

A type illustration is a valid fallback. It must not invent the source's subject. A chart glyph without data is not a measured chart; a generic app window is not a screenshot. Preserve the method in the result and expose it in preview details.

An optional derived language-model summary is a different artifact of computation. Keep its source revision/provenance separate from the deterministic picture. A change in wording must not needlessly rebuild a pixel raster. No mandatory model inference is on the browse path.

## 3. Recommended tools and execution placement

### 3.1 Rust-first production path

Keep the converter in a pure Rust module that can run outside the render loop, preferably in the existing WASM worker architecture or a bounded worker introduced at that seam. A future native consumer can call the same pure API.

Use **`image`** for bounded supported-format decoding and resampling where needed; **`palette`** for explicit sRGB/linear RGB/Oklab conversions; and **`quantette`** for fixed-palette mapping/indexed output when it compiles cleanly with the application's toolchain. Reuse equivalent existing dependencies rather than duplicate them.

The inspected `image` API offers Nearest, Triangle, CatmullRom, Gaussian, and Lanczos3 filters. Its resizer explicitly assumes premultiplied alpha for varying-alpha inputs and normally expects scene-linear values. Those requirements must be supplied by our normalization step rather than assumed to happen inside a generic resize call. [R3]

The inspected quantette documentation exposes Oklab-based quantization, custom palettes, Wu palette generation, optional k-means, indexed image buffers, and optional parallelism. Its published package metadata declares MIT OR Apache-2.0. These are capability/license observations, **not a verified Theorem WASM integration**. [R4]

For the initial WASM build, disable unnecessary codec and threading features. Do not assume Rayon/native threads, a cross-origin-isolated page, or a shared-memory WASM build exists. The first integration task compiles and runs the converter with the actual Ratzilla toolchain, records dependency versions/features, and measures bundle impact. If quantette is incompatible, a narrow fixed-palette nearest-color mapper is an acceptable equivalent for this bounded path, provided the same raster fixtures pass; it does not justify a new imaging framework or unreported algorithm change.

Python may be used as a test/reference authoring tool. Production browsing must not require a Python service or one remote request per tile. This feature is a renderer, not a new AI capability platform.

### 3.2 Why not copy all the prototype's implementation?

The approved prototype has a 128 × 84 canvas, source-specific handwritten recipes, and a landscape-specific ten-color palette with an RGB-distance approximation. Those establish the design target. They are not a general content decoder, robust color-management system, or safe application-capture protocol.

Generalize the **recipe interface** and **shared indexed-raster output**, not the six sample artifact IDs. Replace the image-specific palette approximation with the documented pipeline below. Keep the old images as visual fixtures, while checking source-derived behavior on additional content.

## 4. A bounded source contract

A conversion receives a source reference and already-authorized data, not arbitrary filesystem/network authority. The input contract identifies:

- artifact and immutable revision or a revisioned source snapshot;
- content/capture digest and visibility scope;
- source kind and media type;
- normalized metadata and optional structured features;
- input color/alpha profile;
- recipe ID and version;
- logical raster profile;
- style/reference-palette ID and version;
- bounded format-specific payload or host-managed buffer reference.

Source normalization and capture have their own identity. A page fetched at a later time is not the same capture merely because its URL is unchanged. A live document's durable revision and its temporary editor draft are different inputs; the default gallery uses the accepted revision. Any deliberate draft preview must be labeled and separately keyed.

The converter returns a success, an honest type illustration, or a named unavailable/error result. Unsupported data never becomes a blank successful preview.

## 5. Raster-to-pixel pipeline

### Step 1 — obtain a safe, bounded raster

For an image, read the actual authorized source or a revision-bound derivative. For an app, use an existing safe snapshot/preview. Do not launch unknown apps, visit arbitrary URLs, fetch remote fonts, or execute artifact scripts from the pixel converter.

Prefer an existing normalized preview no larger than **1024 pixels on its longest side**. This is an initial derivative target, not a claim that larger input is intrinsically unsafe. If only a large original exists, use the existing bounded derivative path or validate decoder limits before conversion.

The initial profile in `preview-profiles.json` sets explicit dimensions/pixel/byte limits and a small worker concurrency. These are tunable release defaults. Some `image` allocation limits are best-effort rather than guaranteed; dimension limits are stricter in the inspected API. Verify decoder support and use worker/resource containment rather than claiming `max_alloc` alone is a memory sandbox. [R3]

Apply EXIF orientation and a known color profile. Normalize into sRGB through the existing decoding/capture boundary. Unknown unsupported profiles must be reported or explicitly converted under a recorded assumption; do not claim color accuracy for unprocessed ICC/P3 data.

### Step 2 — fit composition before choosing pixels

Use **contain** by default. The actual subject is more important than filling the tile. A portrait image must not be silently cropped into a landscape. A user/provider-specified focal crop is supported only when its rectangle and provenance are retained in the cache key and preview details.

The standard artboard is **128 × 84 logical pixels**. The approved landscape uses an inner **96 × 60** area surrounded by a frame; this is the initial image recipe. Images with other aspect ratios fit inside that area and are letterboxed. Other recipes can allocate different content rectangles within the same artboard.

Given source width W and height H and content bounds w and h, set s = min(w/W, h/H). Choose output dimensions rw = max(1, min(w, round(Ws))) and rh = max(1, min(h, round(Hs))). Use a declared rounding rule and center with integer offsets. Keep both source bounds and fitting mode in provenance. Never stretch to manufacture square pixels.

### Step 3 — downsample with filtering

For ordinary photos and screenshots, convert sRGB channels to linear light and premultiply by alpha before filtering. Use **Triangle** as the initial low-cost, low-ringing reduction filter. Return to the declared representation after filtering. [R3, R5]

The resampling operation conceptually computes a weighted average of premultiplied colors and alpha over each output footprint. Do not average gamma-encoded color and assume it is linear. Fully transparent pixels have no meaningful color; do not allow hidden RGB values to create bright/dark edge halos.

For artwork explicitly identified as existing pixel art, preserve the known source pixel grid: use nearest-neighbor/integer sampling and retain existing proportions. Do not guess that all small images are pixel art. An exact provider/user hint takes precedence; otherwise use the ordinary raster path.

The conversion may use a versioned area-filter implementation instead of Triangle when it improves the fixed fixture set. Changing the filter changes recipe identity. Do not silently alternate filters by browser.

### Step 4 — reduce to a small, controlled palette

Version 1 uses the **fixed 32-entry reference illustration palette** in `preview-profiles.json`. It consists of neutral ramps and three values from each of Flexoki's eight chromatic families. This is an authored starting palette, not a promise that every source needs all 32 colors. Recipes normally use a smaller subset.

Map each sampled pixel to its nearest reference color in Oklab:

**index(x,y) = argmin_j [(L − L_j)² + (a − a_j)² + (b − b_j)²].**

Oklab is used for the perceptual comparison; WCAG contrast still uses relative luminance. Resolve equal distances using a fixed palette-index order. Record the conversion/version/precision environment. [R4, R7]

For partial transparency, compose against the declared **reference artboard matte in linear light before mapping**; fully transparent areas can directly use the background role. Store the matte dependency. When presenting on another theme, use the resulting palette roles as described in Section 8. Test transparent logos and outlines explicitly.

If the fixed palette makes a representative photo unrecognizable, do not conceal the failure. The first remedy is a versioned shared palette/recipe calibration using the fixture suite, or an explicit source-preserving full-fidelity view. A future source-adaptive route may use Wu or seeded k-means to build a small image-specific palette, followed by the same controlled theme projection. That route must be separately versioned and tested; it is not a release prerequisite. Quantette offers those palette-generation options, but it is not itself a semantic illustration system. [R4]

### Step 5 — keep dithering restrained

**Default: no dithering.** Flat clusters and recognizable silhouettes are the intended visual language, not photograph-like noise.

A photograph-specific recipe may enable stable ordered dithering if approved fixture comparisons show that it helps gradients without destroying recognition. Use a fixed 4 × 4 Bayer pattern anchored to source logical coordinates and bounded amplitude; record the pattern and amplitude in the recipe/cache key. Scrolling or moving a tile must not change the noise pattern.

The optional Bayer ranks are, by row: 0,8,2,10; 12,4,14,6; 3,11,1,9; 15,7,13,5. A possible normalized offset is ((rank + 0.5)/16 − 0.5) × A applied to Oklab L before nearest-palette mapping, with A initially bounded to 0.025. This amplitude is a tuning target, not a scientific threshold.

No dithering on UI labels, document glyphs, code motifs, chart boundaries, graph lines, or ordinary game sprites. Do not apply a global blur, sharpening filter, or automatic “remove isolated pixels” pass: a one-pixel detail may be an intentional feature.

### Step 6 — emit one indexed raster

Emit logical width/height, an 8-bit palette-index buffer, palette-role mapping, optional coverage information where the chosen renderer supports it, and a method/provenance record. The default output is opaque over its reference matte, simplifying portable rendering.

All pixels lie on the same integer grid. Shapes use integer coordinates, pixel-aligned line algorithms, explicit edge rules, and no antialiasing. Decorative bitmap letters require no font files. External captions are real text rendered separately.

An indexed raster separates **what occupies each pixel** from **which theme color that pixel uses**. Theme changes should ordinarily remap palette values rather than rediscover the image's shapes.

### Step 7 — enlarge, do not smooth

Nearest-neighbor enlargement preserves hard logical pixels. Disable Canvas image smoothing and any host interpolation that blurs the raster. MDN explicitly documents this use for scaled pixel artwork. [R10]

Prefer integer scaling in **device pixels**, not only CSS pixels. If the slot has CSS dimensions Wc,Hc, device scale d, and artboard dimensions wp,hp, the largest contained integer scale is:

**k = floor(min(Wc·d/wp, Hc·d/hp)).**

For k ≥ 1, draw a wp·k by hp·k device-pixel image, centered; unused space is intentional. Its displayed CSS size is divided by d. Do not stretch the final raster independently in x and y. For very small slots where k < 1, use a declared compact raster profile or reflow; do not pretend arbitrary downscaling is pixel-perfect.

Noninteger page zoom may still alter final browser compositing. Record zoom/device scale during acceptance and test both, rather than claiming universal pixel identity from one CSS property.

## 6. Structured recipe contracts

### Documents / PDF

Draw a recognizable page, folded corner, restrained stack/shadow, and format badge. Use source block structure, when available, to compose heading bands, paragraphs, tables, or a small chart motif. A document without known charts must not acquire a chart claiming to depict its content. Unknown structure uses a plain document illustration.

Only show PDF when the media type or source capability establishes it. Do not label Markdown “PDF” because the prototype did. Page counts, title, revision, and summary come from actual metadata outside the drawing. Stack depth is a symbolic motif, not a literal page count; do not imply otherwise.

### Images

Use Section 5. Preserve orientation, subject, and broad spatial composition. Default to no crop. Palette shifts are intentional styling, so these are not color-accurate evidence images. Opening reveals the original. Medical, scientific, or otherwise precision-dependent interpretation must use the original rather than a stylized miniature.

### Applications and games

Preferred sources, in order: a provider's trusted pure preview recipe bound to a revision; an already available safe capture; a truthful type illustration. A provider recipe is a versioned rendering contribution, not arbitrary application code executed by the gallery.

For a maze game, known map cells, player/goal/sprite positions, and corridors produce the miniature. Freeze a declared state. For a task board, render the actual known column/card arrangement or an explicit generic board illustration. For a calculator, render its known display/key structure. Do not infer a game's mechanics from its filename.

Any new capture runs through an existing isolated capture capability with its resource/permission policy. Opening the cabinet must not create capture executions with application write credentials. A blank/unavailable capture falls back honestly.

### Code

Render a small editor/window shape and line strokes derived from the actual bounded excerpt. Preserve the relation between line lengths and token runs where feasible. A syntax parser/highlighter can supply token roles through existing code tooling. The miniature is not executable source and cannot be copied as the artifact.

The real language label and source are outside/behind the miniature. Do not reuse the prototype's illustrative Rust adapter as user content. Redaction/access rules apply before preview derivation; pixelation is not secret removal.

### Graphs and diagrams

Consume the artifact's existing node/edge/layout representation or a safe raster. Preserve the chosen graph lens and existing layout semantics. Do not introduce another authority inference or force every artifact into an organization tree.

Use integer raster lines and sufficiently distinct node silhouettes. When too dense, use an explicitly partial/clustered overview whose members/counts remain traceable. No invented links. A generic network illustration is allowed only as a labeled type illustration.

### Charts and tables

Use actual values/categories when available. For a nonnegative pie/donut series, compute fractions v_i / Σv and integer-grid sector occupancy. Zero total, negative unsupported values, NaN, or missing units produce a named fallback rather than an attractive fictional donut.

For the initial donut fixture, require each displayed category’s occupied-area fraction to differ from its source fraction by at most 0.03 (three percentage points); this is an authored raster-quality target. A category smaller than one representable pixel is identified as below preview resolution rather than enlarged into a false proportion. Preserve exact values in readable detail/original view. Categories retain stable semantic color-role indices across theme changes; labels/shape cues must not rely exclusively on color. Tables use real row/column shape and a declared excerpt, not invented data.

The sample chart's “40 references” and percentages are not product defaults.

## 7. Recipe interface and extension rule

A recipe declares a stable ID/version; accepted source kinds/schema; required normalized inputs; whether it uses a source raster or structured data; safe/cache-only execution; output artboard profile; and available fallback. It returns the common indexed raster and provenance.

Register recipes behind the existing artifact-presentation contribution machinery or a subordinate renderer map. Do not create a competing artifact type registry. Adding another recipe must not require a new branch in the gallery's card component.

The cabinet distinguishes the **representation distance** (gallery preview versus interactive original) from the **style** (pixel versus original). These are separate dimensions. A missing pixel renderer cannot silently select a live application renderer merely because that is a richer fallback.

## 8. Theme projection and appearance oracles

### 8.1 Reference palette and theme palette

Let P⁰ be the stable reference palette used to generate indices. Let T be a complete, versioned terminal theme projection, and Pᵗ = T(P⁰). Display pixel i as Pᵗ[index_i].

Indices are independent of the destination theme. This prevents a palette change from moving the shoreline, rearranging graph geometry, or changing a document's layout. A later source-adaptive palette can retain the same relationship by treating its derived neutral-reference palette as an additional input to T.

Typography, crop, source binding, selection, and revision are not functions of T.

### 8.2 Use whole-profile relationships, not isolated accent replacement

Use separate reference profiles for dark and light terminal surfaces. Derive background, raised/deep surfaces, text, separators, selection, focus, status, syntax, and illustration palettes together from the active workspace's effective tokens. A dark terminal within a light workspace uses the dark terminal profile.

For neutral role offsets, an Oklab transform can begin with the lightness mapping in the main spec and with:

**(a,b)_rᵗ = (a,b)_bgᵗ + κ R_θ[(a,b)_r⁰ − (a,b)_bg⁰].**

Here κ is the profile's chroma scale and R_θ is a declared rotation. Parameters are authored per theme/profile, not inferred from noisy near-neutral hue angles. The approved Neutral/Paper/Slate/Forest studies provide calibration fixtures; the prototype's ±hue shifts are not a universal production algorithm.

For status colors, preserve semantic families and verify distinction instead of blindly rotating error into success. For image illustration colors, keep large hue shifts bounded to the approved profile. Custom theme authors may explicitly override semantic roles, subject to the same legibility and state-distinction checks. There is no purple/gold weighting.

### 8.3 Gamut and contrast

Perform Oklab/Oklch operations with explicit color-space types. Reduce out-of-gamut chroma while maintaining intended lightness/hue where practical, then test the actual sRGB output. Raw RGB channel clipping can change a color's relationships; do not use the prototype's simple clipping as the release color policy. [R5, R7]

For actual rendered foreground F and background B, compute WCAG relative luminance Y from linear sRGB and then:

**CR(F,B) = (max(Y_F,Y_B)+0.05)/(min(Y_F,Y_B)+0.05).**

Ordinary readable text requires CR ≥ 4.5. Essential identifying graphics/state indicators use CR ≥ 3 where applicable. Do not round a near miss into a pass. Check all applicable base/raised/selected/diff-word surfaces, not only one background. Decorative art swatches are not each text and are not subject to a universal 4.5 requirement. [R8]

If preserving a palette proportion conflicts with required contrast, the contrast repair wins and is recorded. If repair cannot produce a coherent palette, use a known valid same-mode fallback. Missing measurements mean not established, never pass.

### 8.4 Full-terminal migration

Replace theme semantics consistently across Cabinet and Terminal: headings, links, prompt, cursor, approvals, error details, syntax tokens, and diff surfaces. Introduce semantic names such as `text.primary`, `state.error`, `syntax.comment`, and `illustration.*`. Map legacy `gold`/`sage` callers through one compatibility adapter until migrated.

Apply one resolved palette revision atomically to sibling views. Existing terminal runs, composition, selection, and output scroll remain intact. Do not overwrite a page-global palette to make one cabinet look right while corrupting unrelated terminal views.

## 9. Cache, determinism, and stale work

Define source geometry identity as H(source digest, source revision, normalization profile, recipe/version, artboard/content rectangle, crop, quantization palette/version, dithering policy, and relevant structured-input digest). H uses the repository's existing content-addressing convention and canonical serialization; do not introduce a competing identity scheme casually.

Define presentation identity as H(geometry identity, effective palette digest, representation mode, output encoding/profile). A theme-only change can reuse the geometry/index buffer. A full-fidelity source thumbnail does not depend on terminal theme.

A stable same-input run under a pinned renderer/runtime must reproduce identical normalized index buffers and palette tables. Do not promise byte-identical PNG files across encoders/platforms unless they are also pinned and tested. Screenshot/capture pixels are a distinct nondeterministic boundary: bind the converter to the actual capture digest.

If native and WASM do not demonstrate equal index buffers for the pinned fixture suite, include the execution-target/build identity in the cache namespace; do not share incompatible cached results. Fixed iteration/order, explicit seeds for any optional stochastic method, deterministic tie-breaking, and pinned library versions are required. Never seed decoration from the clock. A revision change should not randomly redesign a type illustration unless source-dependent visual features changed.

Workers may finish out of order. Publish only when scope, artifact/revision, request generation, mode, and palette binding still match. Coalesce stale theme requests, release orphaned textures/buffers, and keep the last correctly labeled usable result during refresh.

## 10. Rendering choices

### Primary browser rendering

Ratatui allocates and styles the card; the existing host draws the indexed raster in its exact allocated region using a nearest-neighbor bitmap/Canvas path. Full-fidelity thumbnails use the same host region with an inert original preview. There is one geometry authority and one selection/action controller.

This preserves the requested Ratatui application while respecting the difference between terminal cells and the browser's image capabilities. The pixel method is real regardless of whether its final raster is displayed through Canvas or half-block cells.

### Cell-only fallback

A half-block implementation stores a top color and bottom color per terminal cell using a suitable block glyph. If measured cell dimensions are cw × ch, the pixel aspect is cw/(ch/2). It is square only when ch ≈ 2cw. Measure, correct fitting, and test; do not assume all fonts make square half-block pixels.

The fallback consumes the same raster/provenance and can use a compact profile if necessary. It must not label a half-block approximation as full-fidelity original viewing. Ratzilla backend support, glyph coverage, clipping, and text selection still require actual browser validation. [R1, R2]

## 11. Quality gates, not a fictitious beauty score

Require both deterministic checks and human-recognizability review. No single palette error or pixel-distance score proves a good miniature.

The fixture corpus must include the six approved reference kinds plus a portrait photo, transparent logo, dark image, very light image, existing pixel sprite, wide/panoramic image, text-heavy PDF, PDF with chart, non-game app, game with a different scene, dense graph, and chart with a very small category. Include unsupported, malformed, and oversized sources.

Mechanical checks cover source/revision identity, aspect ratio, palette membership/cardinality, bounds, determinism, no smoothing, stable theme-independent indices, stale-result suppression, and chart/topology fidelity where the relevant structure exists.

Human review asks: can the artifact be recognized from its actual original; does the miniature fit the approved visual family; are important subjects cropped or erased; do the description and graphic describe the same work; does theme adaptation preserve useful distinctions; does the original remain easy to reach?

Record failures individually. Do not average an unreadable caption or an invented app preview into a favorable overall score. When the baseline image reduction does not meet the recognition target on an important class, improve that class's recipe or use its honest fallback. A future content-aware pixel abstraction algorithm is a justified extension only after that evidence exists.

## 12. Release recommendation

Ship the **pure type-aware recipes + normalized low-resolution raster + fixed Oklab palette mapping + no-dither default + nearest-neighbor display** first. Use the approved visual fixtures to calibrate it. Keep conversion local/bounded, previews revision-bound, and original opening fully connected.

This yields repeatable miniature art without paying for a model to reinterpret the artifact each time the gallery opens—and without pretending that a photograph filter alone can design a good document, graph, or application icon.
