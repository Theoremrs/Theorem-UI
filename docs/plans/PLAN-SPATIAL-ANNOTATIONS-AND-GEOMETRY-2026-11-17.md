# Annotations, chrome and geometry for authored artifacts

**Theorem UI · 2026-11-17 · builds on PR #128 (freely authored live Apps)**

The authority is the owner's corrected direction and plan of 2026-11-17
(`DIRECTION-SPATIAL-GENERATIVE-ARTIFACTS-2026-11-17.md`,
`PLAN-THEOREM-INTERACTIVE-ANSWER-ARTIFACTS-2026-11-17.md`, both in this folder) and the
follow-up handoff on annotations and reference geometry. In short: the agent writes
ordinary TypeScript/TSX; libraries are capabilities it may choose, never a catalog it
must fit; the spatial library and the annotation components are conveniences an App
imports and can edit or ignore.

## Decisions

| Concern | Choice | Why |
| --- | --- | --- |
| Dependency resolver | PR #128's `app-dependencies.ts` | The owner chose it over the duplicate resolver on `claude/agitated-allen-ccf645` (kept, unpushed). |
| Annotation language | d3-annotation's subject, connector and note, rebuilt as React/SVG | d3-annotation is SVG and D3 v4 and last changed 2020; `@hpcc-js/d3-annotation` only bumped a build dependency. Theorem needs camera projection, live controls, touch and scene selection. |
| Controls and surfaces in notes | Astryx (`@astryxdesign/core`, prebuilt CSS, no StyleX build) | Owner's choice. Apps run React 19.3.1, which Astryx needs. |
| Positioning a note at a projected point | Floating UI's virtual element (`@floating-ui/react-dom`) | Astryx's popover anchors with CSS anchor positioning, which needs a real element, and its focus trap would interrupt manipulation. One positioning owner and one focus owner per note. |
| Several notes colliding | A small placement routine | Try candidate positions, score overlap with other notes, the reserved control strip and the subject, plus connector length, and prefer the previous position so notes stay still. |
| A subject hidden behind geometry | The renderer's raycast | Floating UI's `hide` covers clipping, not occlusion. |
| 3D | three.js 0.187.0 (already pinned) | Projection, raycasting, sampling and labels in one library. |
| Arrangement | ELK layered with ports | Datapath order, port sides and fewer crossings as a starting arrangement; computed once per structure, never on value changes, and never over a part the person moved. |
| Procedural geometry | Manifold (`manifold-3d` 3.5.5) | CrossSection extrude, revolve, offset and booleans; manifold output; the wasm bytes can be passed in (`wasmBinary`), so the App needs no network at run time. |
| Tracing a reference | VTracer agent-side; `imagetracerjs` (Unlicense) in an App | VTracer's npm build targets Node. `esm-potrace-wasm` is GPL-2.0, so it is left out of anything shipped by default. |

## What the current chrome gets wrong

From the processor screenshots of 2026-11-17:

- The accumulator is clipped at the right edge while vertical space goes unused: the
  camera frames the model, not the region left after controls and notes.
- Part labels sit over the inspector card.
- The instruction line overlaps Step, Run and Slow.
- Every port label has the same weight, so nothing says which values matter now.
- The detail card covers the part it describes.

What a person sees should depend on what they are doing: names and a few key values at
rest, a short explanation on hover or focus, controls on click. On a narrow frame the
controls move to a region below the scene.

## Reference to geometry

The agent's workflow when a subject needs recognisable form:

1. Gather references for a stated purpose (structure, proportion, material,
   presentation). Keep the image, its URL and the crop used.
2. Extract the features that matter: outline, proportions, the parts and how they join.
3. Choose: trace an outline (VTracer, imagetracerjs), or construct procedurally when the
   form is regular (Manifold cross-sections, extrusions, revolutions, booleans).
4. Generate the geometry from code with named parameters, never as an opaque mesh.
5. Add behaviour in the same source: parts, ports, computation, controls.
6. Render at the sizes the person will see (inline and expanded, narrow and wide),
   compare against the references, revise.
7. Keep the recipe (references, crops, parameters, generating code) with the App, so a
   follow-up can change the form by changing the recipe.

## Slices and acceptance

1. **Annotation layer and local chrome.** `@theorem/annotate` exports composable pieces:
   a projected-anchor hook, subjects (point, circle, rect, bracket, outline), connectors
   (line, elbow, curve), a note that holds any React children with Astryx surfaces, and
   the placement routine. The spatial view's card, breadcrumb, playback bar and hint are
   rebuilt on it: a compact note attached to the selected part with the controls that
   matter now, pinnable; a restrained breadcrumb; a playback strip in a reserved region;
   hints that appear in context. Accepted when the note stays attached while camera and
   part move, labels never cover controls, narrow and wide widths both work, keyboard and
   touch can inspect, and an agent can write a new annotation or control in TSX with no
   change to Theorem's registries.
2. **Framing and arrangement.** The camera fits the region left after the control strip
   and open notes. Labels at rest show names and the values that matter for the current
   step or selection, not every port. Depth means something (containment, stages, a part
   pulled out). ELK gives an initial arrangement, compared against an authored one.
3. **Procedural geometry.** One App initialises Manifold from bytes, builds a
   parameterised shape off the main thread, regenerates it when the person moves a
   parameter without blocking interaction, and keeps the recipe in source.
4. **Reference extraction.** The agent gathers references for a stated purpose
   (structure, proportion, material, presentation), traces or writes outlines, turns them
   into geometry through the same recipe path, renders, compares and revises. Shown on the
   CPU and on an unrelated subject.

Each check is recorded separately: type check, bundle, runtime observation in a browser,
and the signed-in real-agent journey. An unrun check is listed as unrun.
