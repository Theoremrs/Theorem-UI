# Arrangement: stages against ELK (slice 2)

The processor fixture of `scripts/e2e/spatial.mjs` with every part's `at` removed, so the library
arranges it. Light theme, headless Chromium (software WebGL). Each image carries its arrangement
and width in the label at its top right, and in its filename.

| Image | What |
| --- | --- |
| `stages-760px-assembly.png`, `elk-760px-assembly.png` | top level at 760 px |
| `stages-400px-assembly.png`, `elk-400px-assembly.png` | top level at 400 px |
| `stages-760px-alu-open.png`, `elk-760px-alu-open.png` | the ALU opened, 760 px |
| `stages-400px-alu-open.png`, `elk-400px-alu-open.png` | the ALU opened, 400 px |
| `elk-authored-760px-*.png` | the processor as the fixture authors it (every `at` given), asked for ELK: drawn exactly where authored |
| `*-parts.json` | part positions the live view reported, per run |

Reproduce: `node scripts/e2e/arrangement.mjs` (screenshots, 5 checks) and
`bun scripts/e2e/arrangement-metrics.ts` (the numbers below).

## Numbers

Wires are the curves the view draws between ports (a cubic Bezier leaving each port along its side),
flattened to the model's plane. A crossing is a pair of wires, not sharing an endpoint, that cross.
"Through parts" counts wire and part pairs where a wire passes through a part it does not join.
"Backwards" counts wires that run right to left. Wires to the level's own ports are left out of
both (the stage arrangement ignores them too). Lengths are in model units.

| Level | Arrangement | Wires | Crossings | Through parts | Total length | Width x height | Backwards |
| --- | --- | --: | --: | --: | --: | --- | --: |
| top level | stages | 4 | 0 | 0 | 12.18 | 7.32 x 4.10 | 1 |
| top level | elk | 4 | 0 | 0 | 6.73 | 7.70 x 2.65 | 0 |
| inside the ALU | stages | 2 | 0 | 0 | 4.22 | 4.27 x 3.50 | 0 |
| inside the ALU | elk | 2 | 0 | 0 | 4.58 | 4.27 x 3.50 | 0 |
| inside a 4-bit adder (no places) | stages | 15 | 13 | 11 | 79.34 | 14.00 x 5.26 | 0 |
| inside a 4-bit adder (no places) | elk | 15 | 15 | 3 | 84.83 | 14.00 x 5.44 | 0 |
| inside a full adder (no places) | stages | 4 | 1 | 0 | 9.80 | 5.60 x 2.50 | 0 |
| inside a full adder (no places) | elk | 4 | 0 | 0 | 9.42 | 5.60 x 4.20 | 0 |

## What the pictures show

- Top level: by stage, the accumulator (a register, so stage 0) lands in the first column, left of
  the ALU that feeds it, and its wire runs back across the ALU. ELK treats that wire as feedback and
  puts the accumulator right of the ALU with the carry lamp, so every wire runs left to right and the
  total length is 45 percent shorter. This is the one visible difference at both widths.
- At 400 px both fit. ELK's top level is wider and flatter (aspect 2.9 against 1.8), so it is drawn
  slightly smaller at 400 px; nothing is clipped or crowded.
- Inside the ALU: the two arrangements agree (adder and AND bank in a column, mux to the right);
  the ELK picture has no wire crossing a part, the stage one has the accumulator wire cutting through
  the open ALU. That wire belongs to the level above, so it is a consequence of the top-level result.
- Wire crossings are a wash on the 4-bit adder (13 against 15, both counted on the drawn curves).
  ELK is optimising orthogonal routes with ports it may not reorder (the view fixes the port
  order), so it has little room to untangle a splitter feeding four adders. It does stop wires from
  running through parts (3 against 11).

## Recommendation

Default to `arrange: 'elk'`. It never loses on anything visible: feedback loops (registers fed by
what they feed) are the common case in agent-written models and the stage arrangement draws them
backwards; it keeps wires from crossing parts; and it keeps inputs left of outputs along every
wire, which stages only does for acyclic flow. It is not better on raw crossing count for a wide
fan-out, so `arrange: 'stages'` stays as the option for an App that wants the older columns, and a
part's own `at` beats both.

ELK is computed once per level when the model is mounted (nested levels at the same time), never on a
value change. The canvas waits for it: with the default, a model whose top level has parts without
`at` is hidden until ELK resolves and is then shown already arranged. The check in
`scripts/e2e/arrangement.mjs` samples every animation frame and finds no visible frame showing the
stage arrangement first (158 frames, 2 hidden, 156 shown, all at the ELK positions).

## Not done

- ELK's orthogonal routes are returned by `arrangeElk` (`routes`) but the view still draws its
  Bezier wires; using them would change the wire look the owner has not asked to retune.
- A level opened (through `model.open`) before ELK resolves is built by stage and not rearranged.
  A person cannot open a part before the canvas is shown.
