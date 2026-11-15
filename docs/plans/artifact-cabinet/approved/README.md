# Theorem Artifact Cabinet — interactive design study

Created November 14, 2026.

## Open

Open `index.html` in a modern desktop browser. It is self-contained: no package installation, remote fonts, external JavaScript, network request, or backend is required. The HTML uses system fonts; no font files are bundled.

This is a **visual and interaction mockup implemented in HTML/CSS/JavaScript**, not a compiled Ratatui/Ratzilla application. All six artifacts are purpose-made sample content. The document is a sample cover, not an eight-page downloadable PDF. The Rust example is illustrative code, not a verified SDK implementation. No Theorem project data was read or changed for this mockup.

## What the concept demonstrates

The cabinet uses artifact-specific, terminal-styled representations: a pixel document with a PDF badge, a palette-reduced landscape derived from its sample original, the actual sample maze rendered as pixel art, a miniature graph, code-window artwork, and a pixel donut chart. Titles, artifact kinds, revision metadata, and short descriptions remain readable text beneath the images.

The sample originals are separate from the gallery representations. Opening a card displays its original sample content. The maze demo accepts the arrow keys after Play. Close the viewer or press Escape to return to the selected card.

The gallery is docked beside a deliberately wider project composition: project context becomes a compact disclosure instead of another permanent competing column. Expand the cabinet to view three columns; on a narrow screen the cabinet becomes the primary surface.

## Controls

- **Expressive / Calm:** expressive defaults to pixel previews; calm defaults to original previews.
- **Previews:** Theme default, Pixel art, or Full fidelity. An explicit choice survives changing the preset.
- **Palette:** Neutral, Paper, Slate, Forest. These demonstrate coordinated changes across the entire cabinet and terminal tab, not individual fixed accent overrides.
- **Search and type filters:** search titles/descriptions and narrow by document, image, or application.
- **Arrow keys:** move between gallery cards; Enter opens the original.
- **Expand:** enlarge and restore the cabinet without changing the artifact collection.
- **Cabinet / Terminal:** sibling app views sharing one visual host. The terminal view is explanatory only; no commands execute.
- **Composer:** accepts a local draft so appearance-preservation can be inspected; sending is intentionally not connected.

## Color approach

The neutral reference begins with Flexoki neutral and accent primitives. Theme variations derive all cabinet roles together using OKLab transformations, a mode-specific surface hierarchy, and a foreground contrast adjustment. The prototype's lightness values and small hue shifts are illustrative design choices, not a universal transformation policy for every Theorem theme.

There is no purple/gold branding preference. The palette spans all the accent families according to the sample content. Pixel representations participate in the theme; the opened original sample does not receive a terminal color wash.

The Paper variation deliberately demonstrates a light terminal-style surface. That is an additional visual exploration, not a claim that the production terminal already supports it. The calm preset and the palette are independent settings: Calm changes the default preview representation, not the underlying artifact.

Upstream palette reference: https://github.com/kepano/flexoki/blob/main/css/flexoki.css

## Source references and limits

The directly inspected visual reference was the user's uploaded terminal-style RSS screenshot (`image(20261114-233335).png`). The user's prior Theorem screenshots and detailed description supplied the application context and constraints.

The exact requested Nightlightd GIF, OpenAPI TUI GIF, and Ratatui piechart WebP were attempted but could not be downloaded/visually inspected in this environment. Their animations were not used as observed evidence. This study does not claim to reproduce their behavior or visuals. The images shown here were authored for this mockup; the linked demo assets are not included.

Requested references:
- https://github.com/umutdinceryananer/nightlightd/blob/main/docs/screenshots/nightlight-tui.gif?raw=true
- https://github.com/zaghaghi/openapi-tui/blob/main/static/demo.gif?raw=true
- https://ratatui.rs/_astro/tui-piechart.BUCvPlsw_1e90co.webp

## Production connectivity requirements retained for handoff

This mockup establishes a visual target, not completion of the product feature. A production implementation must:

1. Read the authorized project/session artifact catalog through its existing owner. Do not create a second artifact store or a separate agent session just to browse.
2. Preserve artifact ID and selected revision in every preview/open action. A preview is derived from a particular artifact revision, not an independent object that can silently replace its source.
3. Produce descriptions from actual artifact metadata/content; label generated summaries as derived. Use recognizable artifact-specific previews, not an unrelated generic game for every application.
4. Cache derived representations by artifact revision/content identity, preview renderer version, effective palette, and preview dimensions. Cancel or discard stale work after a revision/theme change. Have explicit loading, unavailable, permission-denied, and failed states.
5. Keep gallery previews inert. Browsing must not start every executable artifact or trigger external effects. Clicking opens the existing authorized full-fidelity renderer and its existing operations.
6. Reuse the right-hand host, sizing/input bridge, and theme delivery where appropriate; keep cabinet and terminal state separate. Move the actual interactive layout/rendering to Ratatui/Ratzilla if that remains the selected implementation.
7. Apply a coordinated complete terminal theme contract. Test readable text on every actual surface and selection state. Do not treat token-pair checks as whole-interface accessibility proof.
8. Preserve editor drafts, undo/history, active runs, revisions, focus/selection, and cabinet scroll through presentation and theme changes.
9. Demonstrate the real end-to-end path: create an artifact through Theorem, see it in the project cabinet, inspect its description and pixel representation, open the correct original, revise it, observe the updated representation, reconnect/reload, and confirm the same identity and accepted revision.

## Files

- `index.html`: self-contained interactive prototype.
- `expressive-workspace.png`: pixel cabinet docked in the project page.
- `expanded-cabinet.png`: larger three-column gallery.
- `calm-workspace.png`: same workspace with original gallery previews.
- `calm-paper-cabinet.png`: full-fidelity preview mode with a light cabinet palette.
- `opened-original.png`: original sample image opened from its pixel representation.
- `preview-modes.png`: side-by-side expressive/calm detail comparison.
- `mobile-cabinet.png`: narrow-viewport treatment.
- `*-preview.png`: smaller inline-friendly versions of the main screenshots.
- `test_prototype.py`: browser interaction checks.
- `verification.json`: observed check results and scope.
- `palette-checks.json`: computed foreground/background token pairs in eight preset/palette combinations; not an accessibility certification.
- `capture.py`: screenshot capture helper.

## Verification boundary

Thirteen interaction checks passed in headless Chromium via Playwright using the actual HTML content. They cover sample artifact rendering, preview defaults, explicit preference preservation, draft preservation, palette changes, search/empty states, filtering, original opening and return, keyboard navigation, expansion, game input, narrow layout overflow, and page errors.

No live Theorem backend, Rust/WASM build, browser-to-Rust action bridge, accessibility tree audit, screen-reader test, native rendering, or deployed application integration was exercised. No production repository was modified.

The screenshots were captured from the same HTML prototype at a 1536 × 1080 CSS-pixel desktop viewport (device scale 2) and a 390 × 844 narrow viewport. They were visually inspected before delivery. Keyboard and navigation checks are not a claim of complete WCAG conformance.
