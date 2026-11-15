# SPEC-THEOREM-ARTIFACT-CABINET-1.0

**Title:** Connected Artifact Cabinet with Procedural Pixel Representations  
**Version:** 1.0  
**Date:** November 14, 2026  
**Status:** Implementation specification; visual direction approved in conversation; production implementation and acceptance remain outstanding  
**Primary product:** Theorem-UI / theorem.rs  
**Related runtime:** Theorem's existing artifact, document, application, and project owners  
**Implementation surface:** Ratatui on Ratzilla, hosted in the existing web workspace

## 0. Authority, evidence, and reading order

This specification turns the approved **Theorem Artifact Cabinet** interactive mockup into a production feature. It does not authorize another redesign of that concept.

Read this file, [technical requirements](technical-requirements.md), and the normative [procedural-preview method](procedural-pixel-previews.md) together. [Acceptance cases](acceptance-cases.json) are the machine-readable verification checklist. [Sources](SOURCES.md) distinguish inspected prototype behavior, inspected repository contracts, and external research.

The visual and interaction reference is [approved/index.html](approved/index.html), SHA-256 **9350c5a05aea66662f23819a20934c0d9c68d909235e6cc413fd664be7296008**. The copy in this bundle is byte-identical to the user-approved HTML. Its README, captures, and historical verification record travel with it unchanged.

The approved mockup is HTML/CSS/Canvas with six purpose-made sample artifacts. It is not a Ratatui build, not connected to Theorem, and not a source of genuine document page counts, project data, SDK examples, or production performance claims. The prior verification record reports 13 prototype interaction checks; this specification does not reinterpret them as product acceptance.

Explicit user decisions govern conflicts with earlier advice: **pixel representations participate in terminal styling; original presentations are available on opening; Expressive defaults to pixel; Calm defaults to full fidelity; a user can override either; the entire terminal theme must adapt coherently; there is no purple/gold preference; full connectivity is required.**

The earlier suggestion to keep all gallery artwork full fidelity is superseded. The gallery is an interpretive representation, not the original artifact.

### Visual reference states

- [Expressive workspace](approved/expressive-workspace-preview.png): slim navigation, useful project center, two-column docked cabinet.
- [Expanded cabinet](approved/expanded-cabinet-preview.png): three-column collection with recognizable pixel representations.
- [Preview-mode comparison](approved/preview-modes.png): same artifacts, pixel and original presentations.
- [Calm workspace](approved/calm-workspace-preview.png): original thumbnails without changing object identity.
- [Opened original](approved/opened-original-preview.png): full-fidelity content reached from a pixel card.
- [Narrow cabinet](approved/mobile-cabinet.png): cabinet becomes the primary surface.

The requested Nightlightd, OpenAPI TUI, and piechart links remain inspiration, not normative evidence: the prototype README records that their exact visual assets were not inspected. Do not invent fidelity requirements from their filenames.

## 1. Product outcome

The person opens a project and browses the actual things made there through a terminal-styled cabinet. A document looks like a small pixel document; an image becomes a recognizable low-resolution interpretation of that image; an application resembles the application or game actually made. A short readable description explains each item. Opening a card reaches the correct original and revision through its existing viewer.

The cabinet is a useful collection of work, not a second agent chat, a decorative image board, or a disconnected sample gallery.

**Core invariant:** one artifact identity and revision, multiple derived representations, one authorized operation path.

## 2. Scope and exclusions

### Required release scope

Deliver the shared right-hand host with Cabinet and Terminal views; a connected project artifact catalog; pixel and full-fidelity gallery presentations; original opening and return; coordinated theme adaptation; persisted preview preference; accessible browsing; revision-correct generation/caching; and the end-to-end acceptance journey.

Initial pixel recipes cover document/PDF, image, application/game, graph/diagram, code, and chart/table. A type is not complete merely because its card exists. Each supported recipe must consume an actual representation of its source. Missing or unsupported content uses a labeled fallback.

The right-hand cabinet is the default collection browser. Existing inline artifact appearances, documents, apps, histories, permissions, and full-size viewers remain with their current owners.

### Not required

Do not add a second artifact database, agent runtime, universal thumbnail service, new graph engine, or generic image-generation service. Do not rebuild the whole sidebar or project/session graph. Do not replace Ratzilla's rendering backend solely for this feature. Native terminal or GPUI consumers may reuse the pure preview logic later but are not release gates here.

Version 1 does not require animated thumbnails, generative illustrations, arbitrary HTML execution for capture, a new storage service, or automatic conversion of every existing artifact format. Progressive capability coverage must be explicit.

## 3. What is preserved from the approved design

### 3.1 Shared surface, distinct applications

Cabinet and Terminal are sibling views in one right-hand host. Reuse host sizing, mounting, input, and appearance integration where appropriate. Cabinet browsing never creates an agent session or requires a model credential. A terminal run continues according to its existing lifetime when Cabinet is selected.

The cabinet remembers its selection, search/filter, anchor, and expansion state independently of terminal tabs. A cabinet failure must not corrupt or terminate terminal work.

### 3.2 Preview-led cards

Each card contains, in order: a type-appropriate visual; title; factual kind/revision metadata; a short readable description. The visual is the dominant identifying element. A small selection marker and border distinguish the selected card. Do not add large decorative containers around every text field.

Only the representation is pixel art. Titles, captions, search, menus, and status text remain legible, normally rendered typography. A decorative PDF badge can use pixel lettering because the actual type is repeated in accessible text.

Descriptions should usually occupy two or three lines. Longer descriptions are available in details. Truncation must not erase the artifact's identity or hide a failure state. Do not use the old multi-line fading mask on readable captions.

### 3.3 Cabinet controls

Retain the title/scope, search, kind filters, Recent ordering, preview-mode selector, expansion/restore, and compact footer. Implement each exposed control or make its unavailable state explicit; no inert controls copied from the design study.

The initial filters retain **All, Docs, Images, Apps**. Graphs, code, and charts remain visible under All; additional filters may be contributed through the existing type vocabulary rather than hardcoded in two registries.

Search is scoped to the authorized collection. Do not present results from a partial client cache as an exhaustive project search. Use the catalog's query/pagination contract or explicitly indicate loaded-only results. Counts must distinguish exact totals, loaded counts, and unknown totals.

Sort by accepted modification time descending with a stable identity tie-break. Progress, focus, and incidental redraws must not reshuffle the grid. Incoming changes preserve the current anchor; newly available items may be announced without moving the item under the pointer.

### 3.4 The project center remains useful

Project instructions/context are a compact disclosure, not a permanent column competing with the composer and cabinet. The composer and recent sessions share a useful central track. The cabinet is not allowed to make those primary functions progressively narrower until unusable.

The approved base mockup uses a **46 px rail, 210 px navigation, 466 px docked cabinet**, with a **680 px maximum project content track**. These are baseline visual targets, not universal fixed dimensions or accessibility standards. Preserve the slim-navigation relationship, not obsolete wider-sidebar values from earlier discussion.

## 4. Layout and interaction contracts

### 4.1 Width allocation

Let V be the usable viewport content width; R the application rail; N visible navigation; C the docked cabinet; G intervening separators/gaps; and P the sum of horizontal main-region padding. Then:

**W_project = V − R − N − C − G − P.**

Use one measured box model; borders and scrollbars are counted exactly once. The initial target minimum for the project content track is **480 CSS px** at normal text scale. This is a product tuning target, not a theorem. If all visible regions cannot fit, adapt navigation or present Cabinet as an overlay/full surface. Do not shrink fonts to solve the width budget.

A persistent dock reserves actual width in the shell. A temporary overlay intentionally covers the workspace and is dismissible. Do not style the current absolutely positioned terminal drawer as if it were a width-reserving dock.

### 4.2 Gallery columns

For inner available gallery width W, gap g, minimum acceptable card width m, and view-specific cap n_max:

**n = max(1, min(n_max, floor((W + g) / (m + g)))).**

Initial targets: docked n_max = 2; expanded n_max = 3; horizontal padding 20 px per side; gap 14 px docked and 22 px expanded; m = 178 px at normal text scale. Increase m when text/controls need more space. With C = 466 px, the resulting two cards are approximately 206 px wide. A 340 px cabinet falls to one column. Never shrink caption text just to retain two columns.

A one-column cabinet remains a gallery. At a narrow phone viewport the cabinet occupies the primary surface, with a clear return action; the underlying project draft remains owned by its existing editor/controller.

The mockup's 9–11 px small-screen metadata and captions are **not** normative accessibility targets. Production starts with cabinet labels around 13–14 px, descriptions 12–13 px, line height around 18–20 px, and supports the user's text scaling. Reflow or reduce columns first. This is an explicit production hardening of the visual reference, not permission to redesign its composition.

### 4.3 Expansion and return

Expand uses the available workspace while retaining object identities, selected revision, filters, and stable focus. Restore returns to the previous dock/overlay width and anchor. The mockup's dimmed background may be retained, but choose consistent modal or nonmodal behavior: dimmed/inactive regions cannot remain misleadingly keyboard-interactive.

Open is separate from selection. Single pointer activation or Enter opens the original. Arrow navigation selects/moves focus among cards without activating applications. Escape closes the topmost applicable transient surface and restores focus to the originating card. If that card no longer exists, focus its nearest surviving neighbor or the collection heading, with an announcement.

## 5. Preview settings and original behavior

### 5.1 Independent preference dimensions

Maintain these separately:

| Preference | Meaning |
|---|---|
| Appearance preset | Expressive, Calm, or another registered preset |
| Preview preference | `theme_default`, `pixel`, or `full_fidelity` |
| Terminal palette/profile | Coherent theme projection shared with Terminal |
| Cabinet layout | Docked/expanded/overlay, width, selection, anchor |

Resolve effective preview mode as follows: an explicit preview preference wins; otherwise use the selected preset's registered default. Ship Expressive → pixel and Calm → full_fidelity. The light/dark mode does not itself choose pixel versus full fidelity. Calm may have a dark cabinet; an expressive preset may have a light Paper cabinet.

Persist the user's explicit preference through reload and theme changes using the existing personal appearance-preference owner. Do not introduce a new settings authority. If that owner is device-local today, keep the scope explicit; do not claim cross-device synchronization that does not exist. A missing saved value means `theme_default`, not an inferred permanent choice.

Provide **Use theme default** to clear the override. No transient flash of the wrong representation after preference hydration. Per-artifact styling overrides are outside version 1 unless already supported by the current owner.

### 5.2 Full fidelity has two contexts

**Full-fidelity gallery preview** means a faithful, inert preview at thumbnail size, not the complete application running inside every card. No palette reduction or terminal color wash is applied to original image/screenshot content.

**Open original** resolves the explicit artifact and selected revision through its existing authorized renderer. Pixel mode never changes what opens. PDF originals open the real PDF, not a decorative page icon. Applications keep their existing activation and permission semantics; gallery browsing never grants their execution permission.

Ordinary project cards represent the latest accepted revision. If a new revision arrives between display and activation, open the revision actually represented by the card, with an update notice when relevant; never silently substitute a different version. Existing explicit historical-revision views continue to work.

## 6. Procedural pixel methodology — required approach

Use a **deterministic, type-aware miniature renderer**, not one universal screenshot filter and not an image-model call per thumbnail.

The normative algorithms, palette rules, caching boundaries, library recommendation, and quality fixtures are specified in [procedural-pixel-previews.md](procedural-pixel-previews.md). The compact decision is:

| Source | Required method |
|---|---|
| Document/PDF | Small procedural document illustration driven by verified document properties; a page stack, text bands, and a chart/table motif only when source evidence supports them |
| Image | Actual image → orientation/color normalization → bounded downsampling → limited palette → nearest-neighbor presentation |
| Application/game | Registered inert source preview or safe capture, then pixel reduction; an optional provider recipe can render a miniature of actual structured app/game state |
| Code | Source-derived token/line composition in a pixel code window, with real language metadata outside the artwork |
| Graph/diagram | Existing topology/layout snapshot rendered onto a low-resolution grid; reduced/clustered representations explicitly identify their limited scope |
| Chart/table | Data-driven low-resolution geometry preserving category/value relationships; a type illustration when the data is unavailable, never invented values |

For a non-game application, do not show the sample maze just because it is attractive. A spreadsheet should resemble its actual rows or a truthful spreadsheet illustration. A game should use a capture or structured state of that game, not a generic Pac-Man clone.

The default artboard is **128 × 84 logical pixels**, matching the approved mockup. Detail is generated at this scale and enlarged without smoothing. The document, landscape, maze, graph, code, and chart samples are **visual fixtures**, not hardcoded product IDs.

A generic illustration remains available when source-specific conversion cannot run. It must identify itself as **type illustration**, not a depiction of the missing content. The interface can explain the representation method in details without adding a distracting badge to every successful card.

## 7. Complete terminal theme adaptation

### 7.1 Scope

This work includes a coherent Flexoki-derived theme projection for the **whole terminal surface**, not just colored cabinet captions. Cover Cabinet and Terminal tabs, surfaces, ordinary text, metadata, prompt/cursor, selection/focus, search controls, errors, warnings, success, links, code syntax, diff rows/words, approvals, and disabled states.

There is **no purple-and-gold preference**. A role may resolve to purple or yellow where appropriate, but those families are not privileged product branding. Do not retain `gold` as the universal heading color merely because the current terminal contract uses that name.

Keep the existing theme-responsive terminal behavior. Preserve dark terminal surfaces within light workspaces when that is the active profile. The approved Paper study establishes an optional explicit light cabinet/terminal profile, not an instruction to flip every terminal to light automatically.

### 7.2 One projection, semantic roles

The workspace appearance owner supplies an effective theme snapshot. A versioned terminal theme adapter produces the complete resolved terminal palette, which both sibling views consume. Old color-key consumers can use a temporary compatibility adapter; there must not be two independent color algorithms.

Separate **chrome roles**, **semantic status roles**, **syntax roles**, and the **illustration palette**. Status semantics survive theme adaptation. Image colors do not become error states merely because a photograph contains red.

Chrome has one theme revision. Each preview identifies the effective palette revision it uses. Pixel artwork changes with that palette; its spatial arrangement and source binding do not. The original artifact remains unmodified.

### 7.3 Proportional transformation

Use a neutral Flexoki-derived reference and mode-specific target anchors. In Oklab, let reference background and foreground lightness be L_bg⁰ and L_fg⁰. For a reference role r, compute t_r = (L_r⁰ − L_bg⁰)/(L_fg⁰ − L_bg⁰), then propose L_rᵗ = L_bgᵗ + t_r(L_fgᵗ − L_bgᵗ).

Use a profile-declared chroma scale and small, explicit tint transform rather than adding an arbitrary constant to every RGB channel. Separate light and dark reference profiles avoid treating inversion as a universal theme rule. The complete practical procedure is in the preview-method document. These are authored design policies, not claims of universal perceptual correctness.

After projection, gamut-map and verify actual rendered foreground/background pairs. Preserve approximate hue/lightness ordering where possible, but readability and semantic distinction take precedence over exact proportionality. A mapped palette that fails its required pairs must be repaired or replaced by the known valid mode-specific fallback, with a diagnostic—not silently accepted.

Readable normal-size cabinet text must satisfy 4.5:1 against every surface on which it appears. Essential nontext state/control indicators use the applicable 3:1 requirement; decorative separators do not automatically need that contrast. Art pixels do not each need text contrast; essential labels and descriptions remain separate readable text. Use the existing Design Oracles approach without claiming that token checks alone certify the whole UI. [R7–R9]

## 8. Ownership and rendering architecture

### 8.1 Owners

| Owner | Responsibility |
|---|---|
| Existing project/artifact/document services | Durable identity, accepted revisions, authorization, source content, actual operations |
| Existing artifact contribution registry | Representation discovery and full-viewer resolution |
| Cabinet controller | Authorized catalog projection, per-view selection/filter/anchor, preview scheduling, host actions |
| Pure Rust preview module | Bounded source-to-indexed-raster conversion and type recipes |
| Ratatui/Ratzilla cabinet | Layout, terminal chrome, browsing interaction, representation regions |
| Browser host | Existing auth/data adapters; inert rich-preview surfaces; semantic accessibility controls; opening originals |
| Existing theme/preference owners | Theme resolution, explicit preferences, persistence |
| Existing artifact/runtime owners | Live edits, undo, applications, runs, full-fidelity views |

These are responsibilities, not a demand for new crates or services per row. Prefer focused modules adjacent to existing owners.

### 8.2 Browser-rich surfaces are necessary but bounded

Use the existing Ratzilla/Ratatui host; do not confuse a browser-hosted TUI with a shell process. Ratzilla's DOM/Canvas/WebGL2 backends draw cells. That alone does not supply arbitrary PDF/image/app rendering inside a cell. [R1]

Ratatui owns the cabinet's card arrangement and allocates preview rectangles. The browser host displays an inert bitmap/Canvas preview in those rectangles, using actual measured cell metrics, clipping, and scroll state. This is the production browser path for both crisp pixel artwork and faithful thumbnails. It must preserve the terminal appearance of the approved concept rather than become a second independently laid-out HTML card grid.

A cell-only renderer using foreground/background half-blocks can be a capability fallback. It is not allowed to masquerade as full fidelity, and exact browser geometry must be verified before using it to approximate the approved pixel cards. Terminal graphics protocols such as Kitty/Sixel are not assumed to work in Ratzilla. [R2]

### 8.3 One geometry and interaction contract

Each frame/geometry update identifies its host, layout epoch, viewport clip, and visible slots. A slot includes card identity, source revision, preview rectangle, card action rectangle, representation mode, palette revision, and a texture/preview handle. Host coordinates are relative to a specified container. The browser maps cells to CSS pixels using measured cell size and container offsets, then CSS to device pixels using actual device scale.

Emit geometry updates only when layout or visible slots change, not every idle frame. Do not reserialize full images or artifact content at frame rate. Transfer/cache preview buffers once and refer to them by handle.

The same controller owns pointer selection, keyboard selection, and original-open commands. Host preview layers cannot independently dispatch a second open or swallow a drag/scroll intended for the cabinet. A stale frame epoch cannot target a newly positioned different card.

Theme changes, resize, page zoom, fractional device scale, and font loading must not detach thumbnails from their frames. Retain the existing workaround for container-versus-window viewport sizing until the replacement is tested in the mounted host.

### 8.4 Accessibility and text input

Expose actual accessible card actions, names, descriptions, selected state, controls, and relationships—not a screenful of unrelated character spans. Use one semantic owner per control. Either the host's semantic controls or a proven Ratzilla semantic projection owns it, never both. Hide duplicate decorative cell content from assistive technology.

Use a real browser text-input path or the existing tested input bridge for search, including paste, Unicode, composition, and mobile keyboard behavior. Its geometry/style belongs to the same cabinet view. Typing `/` inside another editor must not steal focus. The cabinet shortcut applies only in an eligible cabinet context; do not replace the application's global command palette.

No keyboard traps; tab order follows visible reading order. Support arrow navigation, Enter, Escape, and pointer/touch parity. Touch targets meet the applicable 24 CSS px minimum or documented exception; the product target for primary touch controls is 44 px. Resize has a keyboard-operable equivalent. [R9]

## 9. Canonical data and host contracts

These semantic contracts may reuse existing types. They are not declarations that matching HTTP endpoints already exist. Bind them to the current SDK/service owner and document that binding before UI integration is considered complete.

### 9.1 Catalog entry

Every entry has a scope/project reference, artifact identity, immutable revision reference or explicitly versioned snapshot, source kind/media type, title, authorized factual metadata, source locator/digest, available representation capabilities, and accepted update position/time. Originating session is a reference, not an instruction to navigate away from the current session.

Description includes text, provenance (`authored`, `metadata`, or `derived`), source revision, and optional derivation reference. If no content summary is available, show a factual description such as “PDF document; preview unavailable.” Unknown page counts are omitted. Never invent a summary to make a card look complete.

Deduplicate project cards by artifact identity, not title. Revisions belong to the same card. Existing source ownership/authorization determines whether two cross-project references expose the same artifact. Personal cabinet layout does not change project membership.

### 9.2 Preview source and result

A preview source identifies the source revision, normalized source digest, recipe/kind, visibility scope, input representation/capture reference, and source-specific data. Large inputs use the existing authorized content path, not JSON copies in every UI event.

A preview result identifies the artifact/revision, renderer and recipe versions, normalization profile, source digest, logical dimensions, palette policy/version, result digest, representation method, and any limitation. It returns an indexed raster plus palette or an inert original-preview reference. A rendering result is not a new artifact revision.

### 9.3 Original-open command

An open request carries explicit artifact and revision identity plus origin focus/anchor context. Resolve authorization again through the existing owner. Open the correct registered viewer without first switching the foreground conversation merely to populate `useThreadArtifacts()`.

If the revision is unavailable, report it honestly. Do not substitute the newest revision silently. Preserve the conversation draft, attachments, active runs, and relevant artifact editing state.

### 9.4 Subscription and recovery

Use the existing catalog query/event path. Where a source revision or catalog cursor is available, retain it. Reconnect either resumes the supported stream or refetches a coherent current projection; do not invent replay guarantees. A disconnected cabinet distinguishes stale usable results from an authoritative empty project.

Resolve pending generation after reconnect against current authorization and revision, not against an old optimistic ID. A revoked source invalidates display of its cached preview/description in the active view according to the owner’s access policy.

## 10. Preview lifecycle and resource discipline

Catalog state and per-card preview state are distinct. Supported states include loading, ready, refreshing, unsupported, unavailable, failed, and inaccessible/redacted according to access policy. The original may still open while its optional stylized preview is unavailable.

The generation cache is derived and evictable. It must never become the only copy of source content. Cache identity includes source identity/digest, revision, recipe/version, normalization/color profile, logical raster profile, and representation parameters. Theme-dependent output additionally includes the effective palette digest. Full-fidelity source-preview identity does not depend on the terminal palette.

A geometry/index cache can survive palette changes; only the mapped colors need updating. A source change invalidates source-dependent geometry. Titles/descriptions derived separately follow their own dependency identity. Do not invalidate pixel buffers solely because a relative-time label changed.

Schedule visible cards first and a small adjacent buffer second. Deduplicate work for identical keys; do not eagerly decode every artifact in a large project. Run conversion outside the UI render loop. Use a bounded worker queue; a Promise without a worker does not establish off-main-thread execution.

Check scope, source revision, request generation, palette revision, and representation mode before publishing an async result. A stale result can populate a correctly keyed cache but cannot replace a newer card's visible presentation.

Default safety/tuning parameters are in [preview-profiles.json](preview-profiles.json). They are initial product limits, not measured speed claims. Larger originals can be handled through the existing bounded derivative path. Decode limits, memory budgets, unsupported formats, and resource exhaustion have named outcomes. Do not disable limits merely to make a fixture pass.

## 11. Security, fidelity, and truthful representations

Gallery previews are inert in both modes. Do not mount a live artifact as a fallback when the representation registry walks from preview to `thing`. Request only presentations with no live session/effects; otherwise use a safe generic fallback. The inspected registry has both distance fallback and `session`/`cost` metadata, which makes this a concrete integration obligation, not a theoretical concern. [C3]

Safe capture uses an already existing authorized snapshot or a deliberately isolated capture path with no write credentials, restricted network, bounded resources, and a recorded revision. Merely hiding an iframe or calling it read-only is not isolation. No arbitrary app capture pipeline is required for release: use an honest app-type illustration when a safe source preview does not exist.

Original artifacts remain untouched. Pixel conversion is not redaction and must not be used to claim removal of secrets. The same access rules apply to thumbnails, extracted descriptions, hidden metadata, and caches. Normalize malformed SVG/HTML through safe existing renderers; never embed untrusted markup as cabinet chrome.

No automatic external image-model calls. Optional future generated illustrations require an explicit product decision, budget/privacy policy, and method labeling; they are not the baseline for this specification.

Graph/diagram simplification may omit detail but must not invent authoritative edges. Chart pixelation preserves data relationships within stated sampling error. A small illustrative page stack does not claim to show every page. Details expose whether the visual is a source reduction, source-derived illustration, or generic type illustration.

## 12. Repository integration map

The source inspection for this specification establishes the following seams, not production completion:

| Area | Existing location / responsibility | Required integration |
|---|---|---|
| Browser TUI | `terminal/Cargo.toml`, `terminal/src/lib.rs` | Add focused cabinet rendering/state modules; preserve existing agent terminal behavior |
| Host | `src/components/terminal/side-terminal.tsx`, `terminal-screen.tsx` | Share host/input/size bridge without creating a terminal agent for Cabinet |
| Appearance | `src/components/terminal/terminal-theme.ts` and current appearance owner | Resolve complete Flexoki-derived role contract; adapt old consumers once |
| Artifact identity | `src/components/artifacts/artifact-model.ts` | Resolve project-wide entries explicitly; do not depend solely on selected thread messages |
| Presentation registry | `src/lib/artifacts/contributions.ts`, artifact registry/renderers | Reuse discovery; add safe preview/style eligibility; retain original viewers |
| Full viewer | `src/components/artifacts/artifact-panel.tsx`, artifact view state | Open explicit revisions while preserving existing live-view/editor continuity |
| Project outputs | Existing project outputs/catalog owner | Expose authorized entries and updates through the actual SDK path |

The manifest currently declares Ratzilla 0.3.1, Ratatui 0.30.1, and an exactly pinned wasm-bindgen 0.2.127. The file was inspected, not compiled here. Preserve compatible versions initially; dependency upgrades are separate, justified changes. [C1]

The artifact model currently collects revisions from the selected conversation's assistant data parts. That is not a complete cross-session catalog. Implement the missing resolution/adapter through its existing owner rather than silently navigating to another thread. [C2]

Do not add a dependency solely because the prototype mentions it. Recommended quantization libraries remain subject to the actual WASM/toolchain verification in the method document.

## 13. Delivery sequence

### Slice A — freeze the representation and ownership boundary

Pin the approved visual reference; map catalog, revision resolution, viewer, preference, and theme owners in the actual checkout. Add contract fixtures for source identity, inert-preview eligibility, and style override. Record missing backend paths as required work, not fixture substitutions.

### Slice B — connect a real vertical slice

Render the actual Ratatui cabinet in the shared host with one real document and one real image from different sessions in the same project. Show titles/descriptions, source-specific pixel views, and original opening by explicit revision. Return without losing the project draft. This slice must already reach real services.

### Slice C — generalize the procedural renderer

Implement the bounded image pipeline and six recipe kinds through one registry/interface. Add type-illustration fallback, source-level caching, deterministic raster fixtures, and WASM/native reference comparisons where relevant. The pure converter must not own application credentials or network access.

### Slice D — complete the theme and both gallery modes

Apply the complete terminal semantic palette, not only Cabinet. Implement persisted preview preference, light/dark adaptation, original thumbnails, and style/palette switching without resets. Verify syntax, diff, prompt, and approval states in Terminal for regressions.

### Slice E — complete responsive interaction and recovery

Finish resize/dock/expand/return, narrow layout, real search/filter/order, keyboard/IME/accessibility, async cancellation/stale handling, unavailable states, authorization changes, and reopen/reconnect behavior.

### Slice F — accept the mounted product

Run all acceptance cases on the actual integration. Capture the same content in Expressive and Calm, docked and expanded, across the named palettes. Preserve source IDs/revisions in evidence. Do not close this feature with only HTML prototype screenshots or pure-converter tests.

These slices are sequencing guidance. They do not create an alternate feature store or require a broad application refactor before the first connected result.

## 14. Integrated acceptance journey

Start with a real project, two sessions, an active draft, and a terminal task. Through Theorem's actual creation paths produce a document, image, code result, graph or chart, and an app with a safe preview. Verify they appear as the same objects in Cabinet, including artifacts from the nonselected session.

Select Expressive with Theme default. Inspect the pixel representations and grounded descriptions. Select a card using keyboard navigation, open the original, inspect the represented revision, and return. Confirm selection and reading position are restored.

Choose Full fidelity explicitly, switch to Calm and another palette, reload, and verify the explicit preference remains. Clear the override and verify each preset's default. While a pixel conversion is pending, publish a new source revision and change theme; reject late results for the previous binding.

Switch Cabinet/Terminal and expand/restore. Confirm draft, attachment selection, terminal run, and artifact editor state remain intact. Exercise a missing preview, a disconnected catalog, an unsupported format, and a permission revocation. Reconnect and verify that the authorized accepted collection converges without duplicate cards or manufactured empty-state claims.

This journey, the visual comparison, and the technical acceptance cases together establish completion. No one category of evidence substitutes for the others.

## 15. Completion statement

The feature is complete when the approved terminal-styled cabinet works on actual project artifacts; its pixel representations are generated from the correct sources; full-fidelity views open through the existing owners; theme and preview preferences behave independently; and normal failures do not disconnect the person from their work.

**Pixel art is a presentation of the work. It is never a replacement for the work.**
