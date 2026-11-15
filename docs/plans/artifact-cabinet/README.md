# Theorem Artifact Cabinet — implementation handoff

This bundle contains the specification for the approved terminal-styled artifact gallery, including a deterministic procedural pixel-art method and its production integration requirements.

## Read in order

1. [Feature specification](SPEC-THEOREM-ARTIFACT-CABINET-1.0.md): approved product behavior, ownership, settings, layout, connectivity, and delivery slices.
2. [Procedural pixel method](procedural-pixel-previews.md): type-aware recipes, image conversion, palette projection, caching, library choices, and quality gates.
3. [Technical requirements](technical-requirements.md): 32 named requirements and verification boundaries.
4. [Acceptance cases](acceptance-cases.json): 40 cases, all marked not run for production.
5. [Initial profiles](preview-profiles.json): proposed raster, palette, worker, preference, and geometry parameters.
6. [Source register](SOURCES.md): what was directly inspected, historical context, and external research.

Open [approved/index.html](approved/index.html) for the exact approved interactive mockup. The HTML and its original evidence files are preserved, not rewritten. The expanded and docked screenshots are the principal visual references.

## Brief for Claude Code

Implement SPEC-THEOREM-ARTIFACT-CABINET-1.0 in the current Theorem-UI checkout. Preserve the approved terminal-styled gallery and use its existing Ratatui/Ratzilla host. Read the main specification, procedural method, technical requirements, and acceptance cases before planning. Reopen the current artifact/catalog/theme/viewer owners and map the actual end-to-end path. Build one connected document-and-image slice first; do not substitute sample artifacts or a second artifact store. Pixel previews must be type-aware, deterministic, revision-bound, and inert; opening must reach the correct original through the existing viewer. Preserve explicit preview preferences and active work across appearance changes. Apply the full Flexoki-derived terminal role contract without a purple/gold bias. Report unimplemented paths and missing evidence instead of calling fixture-only results complete.

## What exists and what does not

The visual mockup exists. This handoff specifies the production feature. Its historical 13 prototype tests are separate from the 40 production acceptance cases. The new package was checked for structural consistency and source-reference integrity; no production build, browser/backend integration, or new pixel renderer was executed for this handoff.

The recommended method uses procedural source-aware drawings for structured artifacts and bounded raster reduction/palette quantization for images or safe app captures. Default browsing requires no image-model service. New dimensions, budgets, and palette selections are explicit initial design defaults to validate, not measurements disguised as facts.
