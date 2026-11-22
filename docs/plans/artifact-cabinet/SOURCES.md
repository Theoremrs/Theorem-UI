# Sources, provenance, and boundaries

**Compiled:** November 14, 2026. Public documentation describes the retrieved versions; implementation must pin versions compatible with the actual checkout.

## P — Approved visual/interaction source (directly inspected)

**P1.** [Approved HTML](approved/index.html), SHA-256 `9350c5a05aea66662f23819a20934c0d9c68d909235e6cc413fd664be7296008`. Reopened from the actual uploaded HTML and compared byte-for-byte with the copy in the uploaded ZIP. The document includes `state`, `effectivePreview`, `applyPalette`, `renderGallery`, `drawPixel`, and `openArtifact` implementations.

Supported observations: six illustrative kinds; 128 × 84 pixel canvases; a 96 × 60 landscape reduction; separate sample originals; preset/default/override behavior; keyboard navigation; search/type filtering; expanded/narrow gallery; terminal theme variations. Those are prototype behaviors, not production capabilities.

**P2.** [Prototype README](approved/README.md). Inspected in full. Explicitly identifies sample content, no backend connection, non-Ratatui rendering, and unavailable external inspiration GIFs.

**P3.** [Historical prototype verification](approved/verification.json) and [test source](approved/test_prototype.py). The uploaded record reports 13 passing checks. These checks were **not rerun while writing this specification** and do not establish live service, WASM, accessibility, or deployment acceptance.

**P4.** [Expanded screenshot](approved/expanded-cabinet-preview.png) and [docked screenshot](approved/expressive-workspace-preview.png). Opened visually in this task. Remaining captures are carried as approved source material, not represented as newly captured production screens.

## C — Repository evidence

Reopened through the connected GitHub tool in this task:

**C1. Terminal manifest:** [terminal/Cargo.toml](https://github.com/Travis-Gilbert/Theorem-UI/blob/main/terminal/Cargo.toml), inspected blob SHA `62f9b14e68e43f73e6bb65c7dc20c3a805789e05`. Declares Ratzilla 0.3.1, Ratatui 0.30.1, exact wasm-bindgen 0.2.127, and a WASM cdylib. No compilation was run.

**C2. Artifact model:** [artifact-model.ts](https://github.com/Travis-Gilbert/Theorem-UI/blob/main/src/components/artifacts/artifact-model.ts), inspected blob SHA `f78508de91a5fb8fba782576733518b45b9541c4`. `TheoremArtifact` carries identity/revision and renderer/source fields. `useThreadArtifacts` gathers artifacts from the selected conversation's assistant data parts. This is evidence of that consumer's scope, not proof that no broader catalog exists elsewhere.

**C3. Presentation contribution contract:** [contributions.ts](https://github.com/Travis-Gilbert/Theorem-UI/blob/main/src/lib/artifacts/contributions.ts), inspected blob SHA `5ccc200fb5195b58824d0ead8b46e02905616bdc`. Defines representation distance, rung, session need, cost, and fallback. `preview` can fall back to `thing`, so gallery safety must explicitly constrain the selected presentation's liveness/effects.

**C4. Previously inspected integration locations:** the earlier conversation supplied the contents of `terminal/src/lib.rs`, `src/components/terminal/terminal-screen.tsx`, `side-terminal.tsx`, `terminal-theme.ts`, and `src/components/artifacts/artifact-panel.tsx` / `artifact-renderers.tsx` at revision `2a479ca30dcef39517b0f8fa149d3c5447bc18cf`. Those locate the shared terminal host, palette delivery, and original renderer path. They are **historical implementation context**, not a fresh audit of every current file. Reopen the actual working branch before editing and resolve moved ownership without introducing parallel stores.

This specification does not claim current deployment equivalence, feature completion, or a newly inspected full backend graph.

## R — Primary external research and documentation

**R1. Ratzilla backends:** [official crate documentation](https://docs.rs/ratzilla/0.3.1/ratzilla/backend/index.html). Inspected version 0.3.1 documents DOM, Canvas, and WebGL2 backends with different capabilities. This supports keeping renderer capability explicit; it does not prove the proposed hybrid thumbnail host already exists.

**R2. Ratatui graphics:** [official Canvas example](https://ratatui.rs/examples/widgets/canvas/) and [ratatui-image maintained repository](https://github.com/ratatui/ratatui-image). These supply primitives/protocol context, including character-cell/half-block approaches. Terminal image protocols are not automatically Ratzilla browser capabilities. No new backend was compiled or benchmarked here.

**R3. Rust image crate:** [sampling filters](https://docs.rs/image/0.25.10/image/imageops/enum.FilterType.html), [resize](https://docs.rs/image/0.25.10/image/imageops/fn.resize.html), and [decoder limits](https://docs.rs/image/0.25.10/image/struct.Limits.html). Inspected 0.25.10 documentation. The resize assumptions about linear light/premultiplied alpha and the distinction between strict dimensions and best-effort allocation limits informed explicit normalization/resource requirements. Historical timing tables in its docs were not used as product speed claims.

**R4. Quantette:** [crate documentation](https://docs.rs/quantette/0.6.0/quantette/), [Pipeline](https://docs.rs/quantette/0.6.0/quantette/struct.Pipeline.html), [QuantizeMethod](https://docs.rs/quantette/0.6.0/quantette/enum.QuantizeMethod.html), and [maintainer Cargo manifest](https://github.com/IanManske/quantette/blob/main/quantette/Cargo.toml). Inspected version 0.6.0; custom palette, Oklab, indexed buffers, Wu, optional k-means/threading, and MIT OR Apache-2.0 metadata. Recommended as a candidate implementation component, not a verified WASM dependency or a semantic pixel-art generator.

**R5. Palette:** [official crate documentation](https://docs.rs/palette/0.7.7/palette/). Documents explicit color spaces, linear calculations, and conversions. The source project's existing color infrastructure may be preferable where compatible; this reference is not permission to duplicate it.

**R6. Pixelated Image Abstraction:** [authors' 2012 project and abstract](https://cragl.cs.gmu.edu/pixelate/) and [2013 extension](https://cragl.cs.gmu.edu/pixelate/journal.html). The 2012 abstract describes jointly solving spatial features and a reduced palette and comparing with naive methods and artist examples. This task used the project/abstract, **not a full paper or code audit**. It supports a future content-aware quality option, not an implemented algorithm or benchmark result for Theorem.

**R7. Color references:** [CSS Color 4 — Oklab](https://www.w3.org/TR/css-color-4/#ok-lab), [Flexoki author explanation](https://stephango.com/flexoki), [upstream CSS palette](https://github.com/kepano/flexoki/blob/main/css/flexoki.css), and [Flexoki license](https://github.com/kepano/flexoki/blob/main/LICENSE). The profile's 32 colors are selected from the published primitive palette. The proportional theme projection is **our proposed design policy**, not an algorithm claimed by Flexoki. The reference palette's license notice is retained in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

**R8. Accessibility contrast:** [WCAG 2.2 Understanding 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Applies to relevant readable text and identifying information/states, with scope/exceptions; not a blanket contrast demand on every art pixel or decorative separator.

**R9. Pointer targets:** [WCAG 2.2 Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). The 24 CSS px requirement has defined exceptions. Our 44 px primary-touch goal is an explicit product target, not an assertion that AA universally demands 44 px.

**R10. Pixel enlargement:** [MDN Canvas `imageSmoothingEnabled`](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled). Documents disabling smoothing for scaled pixel artwork. It does not guarantee all browser zoom/device-scale combinations are visually identical.

## Claim limits

New documents and configuration here are a proposed implementation contract. No application code was changed, no live artifact was generated, no new Rust dependency was compiled, no new browser interaction acceptance was performed, and nothing was installed or deployed. The package validation report checks document/package integrity and specification consistency only.
