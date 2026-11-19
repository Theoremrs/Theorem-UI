# Reference to geometry: a guitar and the 6502

Slice 4 of `PLAN-SPATIAL-ANNOTATIONS-AND-GEOMETRY-2026-11-17.md`. The agent
collects references for a stated purpose. It traces them, turns the trace into
geometry through a recipe, renders the result, compares it with the reference
and revises. The slice is shown on the CPU and on an unrelated subject, a
classical guitar.

The work is done twice:

- `scripts/e2e/reference/trace.py` stands for the agent's own shell. It fetches
  each reference, crops it, traces it with VTracer and measures it. It writes
  `guitar.json` and `cpu.json`, which go into the Apps as data.
- `scripts/e2e/reference-apps.mjs` contains the two Apps the agent writes. Each
  is a recipe plus a Manifold worker plus `@theorem/spatial` parts. The guitar
  can also trace a drawing itself: a person hands it an image, imagetracerjs
  traces it in a worker, and the body is rebuilt through the same recipe.
- `scripts/e2e/reference.mjs` builds, type-checks and runs both Apps in a
  browser. It checks them and takes the screenshots in this folder.
  `scripts/e2e/reference/compare.py` places each reference beside its render.

## Sources

| Reference | Purpose | Licence |
| --- | --- | --- |
| [Guitar by Joseph Benedid, MET 1992.1.2, drawing by D. Wheeldon](https://commons.wikimedia.org/wiki/File:Guitar_MET_Benedid_1992.1.2_front.jpg) | structure and proportion: outline, sound hole and bracing, with a centimetre ruler | CC0 |
| [Guitar by Francisco de Frías, MET 1992.279, drawing by D. Wheeldon](https://commons.wikimedia.org/wiki/File:Guitar_MET_1992.279_Front.jpg) | the drawing a person hands the App (`frias-front.png`, a reduced copy) | CC0 |
| [MOS 6502D die, John McMaster](https://commons.wikimedia.org/wiki/File:Die_-_MOS_6502D_-_John_McMaster.jpg) | structure: the datapath, control and decode regions, and the ring of bonding pads | CC BY 4.0 |
| [MOS 6502 package top, John McMaster](https://commons.wikimedia.org/wiki/File:Pack_top_-_MOS_6502D_-_John_McMaster.jpg) | proportion: the body's length to width, and the pins along one side | CC BY 4.0 |

Each App's `recipe.ts` states the credit, URL, licence, purpose and crop. Each
part's `about` text says which numbers were measured and which were written.

## Measured and written

Guitar (from the Benedid drawing, at 118 px per cm on its ruler):

- Measured: the outline (length 46.3 cm, width 28.0 cm); the sound hole (radius
  4.32 cm, centre 15.25 cm from the top); ten braces, sorted by angle and
  position into 2 transverse bars, 2 X-brace arms, 4 side bars and 2 struts; the
  bridge; and the neck joint, 5.81 cm wide.
- Written, because a front drawing does not show them: body depth 9.5 cm, top
  0.25 cm, ribs 0.2 cm, brace section 1.1 by 0.6 cm, scale length 65 cm, nut
  width 5.2 cm, head size, and wood colours.
- Physics, written as a check: f = sqrt(T/mu) / 2L. The strings part checks
  that open E4, E5 and D3 sound at their pitches. It also checks that a whole
  tone up needs the tension multiplied by 2^(1/3).

6502 (from McMaster's photographs):

- Measured: the die's aspect, 1.0936; the extent of the three blocks; 37 bonding
  pads, matching the 37 bonded pins (40 minus the unconnected pins 5, 35 and
  36); the package at 53.19 by 12.19 mm, with 20 pins a side, assuming a
  2.54 mm pitch; and the colours of the body, pins and die.
- Written: body depth 4 mm, die size 4.3 mm, the shapes of the shoulders, legs
  and lead fingers, and the pinout (from the datasheet, not from the photo).
- Known error: the photo gives a body width of 12.19 mm, but a real 600 mil
  DIP-40 measures about 13.7 mm across. The photo is not square to the camera.
  The model shows the measured number, and this README records the difference.

## Revise loop

The loop is the point of the slice, so each revision is listed here:

1. **Trace tolerance** (VTracer on the Benedid outline). IoU is measured
   against the filled silhouette:

   | Tolerance | Points | IoU | Kept |
   | --- | --- | --- | --- |
   | 0.02 | 118 | 0.9991 | |
   | 0.05 | 71 | 0.9982 | |
   | 0.1 | 51 | 0.9963 | kept: fewest points above 0.995 |
   | 0.2 | 38 | 0.9937 | |
   | 0.4 | 26 | 0.9839 | |
   | 0.8 | 17 | 0.968 | |

2. **The App's own trace picked the wrong shape.** The first in-App trace of
   the de Frías drawing returned the bridge ornament, with a length-to-width
   ratio of 4.6. Dense ink outweighed the 1 px outline. The fix keeps the
   connected ink with the largest extent, excludes the drawing's frame, and
   does not downscale below 1600 rows. It now traces a ratio of 0.613 in 86
   points, in about 140 ms, in the worker.
3. **Whole-tone check.** The first version of the check used 2^(1/6), and the
   spatial check failed on it. The correct factor is 2^(1/3), and the check now
   passes.
4. **Render compared with reference, and the library fixed where the renders
   were wrong** (in `src/lib/blocks/spatial/view.ts` and
   `src/lib/blocks/annotate/`):
   - The 6502's near pins showed through the body. Opaque materials now write
     depth, so solid forms hide what is behind them.
   - The opened die level was framed on the package's shell, so the die was
     drawn small. Framing an opened part now covers its inside level.
   - The body did not refit after a rebuild if the soundboard had been opened
     once, because the closing ease never reached exactly 0. The ease now lands
     on its end.
   - The Back label covered the Ribs and Soundboard labels. Label placement
     now weights covering another part's note above covering another part.
     There is a unit test: "covers another part before it covers another note".
   - The lead fingers were too wide for the die and hid the pads. Their width
     was reduced to 0.22 and their gap and length rewritten.
   - About half the runs failed to refit the soundboard after the swap. The
     view read only the first entry of each IntersectionObserver batch, and a
     root laid out in the frame it was observed reports "not intersecting"
     then "intersecting" in one batch. The view stayed paused while fully on
     screen. It now reads the last entry. Before the fix, 2 of 3 runs failed
     after a 10.7 s wait. After it, 5 of 5 runs passed, refitting in 2-9 ms.
     The blank `guitar-1` screenshot from earlier runs had the same cause.
   - The opened soundboard showed the top plate from outside, so the plate hid
     the bracing glued under it, and only the labels showed. The App now turns
     the inner level about its length so the inside faces the camera. This
     exposed a library fault: the cells and edges ignored a transform on the
     root of a part's form, so they were drawn where the part had been. The
     view now draws them in the space of the body beside the shell.

## Images

The `compare-*.png` images are pairs. In each pair the grey-banded left half is
the **reference** and the rust-banded right half is the **render**. Each band
says which half it is.

- `trace-guitar.png`, `trace-cpu-die.png`, `trace-cpu-package.png`: what
  trace.py found, drawn over the reference.
- `guitar-1..7`, `cpu-1..6`: the e2e's screenshots at inline and expanded
  sizes, and at wide and 380 px narrow widths.
- `compare-guitar.png`, `compare-guitar-traced.png`, `compare-cpu-die.png`,
  `compare-cpu-package.png`: each reference beside its render.

## Checks

Each check is recorded separately. A check listed as unrun was not run.

| Check | Result |
| --- | --- |
| Type check, repository (`tsc --noEmit`) | Clean apart from 10 errors in `terminal-wasm`, which predate this work. |
| Type check, each App against its packages' declarations | Run inside the e2e. Both reference Apps type-check clean, including `imagetracerjs.d.ts`, which the App writes itself. |
| Bundle (esbuild-wasm in the browser, npm packages from esm.sh) | Run inside the e2e. Both Apps bundle; manifold-3d runs in a `?worker` import and loads its `.wasm`. |
| Runtime, observed in a browser (`node scripts/e2e/reference.mjs`) | 26 of 26 checks, in 6 runs after the visibility fix. |
| Neighbouring e2es after the library changes | spatial 36/36, geometry 15/15, app-ts 25/25, arrangement 6/6. |
| Unit tests (`bun test src/lib/blocks`) | 230 pass, 1 skipped, 0 fail. |
| Signed-in real-agent journey (a live agent writes these Apps in the chat) | **Unrun.** The earlier attempts on the local stack stopped at 404s from `/api/artifacts/v1/libraries/theorem-artifacts`. |
