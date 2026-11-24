# Chromeless artifacts and the Theorem UI kit

An artifact in a reply should read as part of the reply. What the model drew
(a simulation, a chart, a control nobody wrote before) is the subject; the
labels, fields, buttons and spacing around it follow Theorem. Host operations
(source, stop, expand, revisions, ask) are there when you reach for them and
out of the way when you do not. Nothing here limits what the agent may write:
the kit is a shared vocabulary it can find, not a form it is held to.

The checklist in `chromeless-artifacts.checklist.json` tracks this spec item by
item, with what was built, what was checked, and what was not.

## Sources

- The owner's request of 2026-11-24: "let's improve the look of these", with
  the handoff `Theorem_Chromeless_Artifact_UI_Handoff_2026-11-24.md` (reviewed
  at `8a0d0874`; sha256 in the ledger). Its first slice (§8) is the scope of
  this plan.
- The Gray–Scott App Qwen4 Max wrote in the e2e chat on 2026-11-24, kept
  byte for byte as the story fixture `src/stories/fixtures/gray-scott.html`
  (sha256 `f67fbe96…` without its trailing newline).
- What is already here and is reused, not rebuilt:
  - Astryx 0.7.16 (`@astryxdesign/core`, `theme-neutral`) with Theorem's token
    adapter `src/lib/blocks/annotate/theme.tsx` + `theme.css`, and the
    controls `src/lib/blocks/spatial/chrome.tsx` already composes from it.
  - The App library registry `src/lib/blocks/app-libraries.ts` +
    `app-library-sources.ts` (`@theorem/annotate`, `@theorem/runtime`,
    `@theorem/spatial`), the TSRS checker worker and esbuild-wasm builder.
  - The sandbox bridge and its theme handshake (`sandbox/theme.ts`,
    `hosted.followTheme`), notebook theme injection (`notebooks/page.ts`).
  - Page-declared client operations (`kit/operations.ts`,
    `blocks/app-operations.ts`): a page declares operations, each becomes a
    tool of the turn, the call streams a `client_operation` part, the page
    answers with a receipt. `face.*` and `app.check` already travel this way.
  - The story oracle `scripts/story-oracle.mjs`, now with `ORACLE_SCHEME` and
    `ORACLE_PALETTE` so a story is shot in every palette and mode.

## What stands in the way today

Seen in the before references (`evidence/chromeless-artifacts/before/`):

- Two rows of host chrome above every healthy App: an icon row (attach,
  download, expand) and a text row (Stop App, Edit source, Ask about this
  App, Reload). The handoff also names the notebook surface's pinned
  status/action row (`notebook-artifact.tsx` ~603–655); the notebook story
  has failed since `8a0d0874` (see the checklist), so that row is not in the
  references yet.
- The App paints its own page inside the reply: a `#0b0e14` panel, an h1, a
  bordered stage, a boxed control panel. In every light palette it is a dark
  slab in a light reply. Its controls are native inputs styled by hand, so
  they match neither palette nor density.
- At 390 wide the panel's four sliders and nine preset pills wrap into a tall
  block the reply has to scroll past. The canvas's height comes from the
  frame (`60vh`), so the App depends on the size the host first gives it.

## Decisions

Made here:

- **No prompt text steers the agent to the kit.** The handoff's §7 "small
  default instruction" is not added: the kit is found the way every other
  capability is, by code-mode search over its docs (owner's rule, 2026-11-23).
  The kit's docs say it sits inside a host surface; that is context the agent
  reads when it looks, not a rule it is given.
- **One owner per control's behaviour.** Astryx owns the controls the kit
  exports. The agent-facing adapter calls the same functions the visible
  control calls; it never carries a second implementation.
- **The simulation keeps its own palette.** Only the surroundings follow the
  host.

Waiting on the owner:

1. **Study pick** (HITL). Two or three inline presentation directions for the
   Gray–Scott reply, each a story in every palette and mode and at 390 wide,
   reference and render labelled. Nothing past the study spreads until one is
   picked.
2. **Agent-action owner.** Theorem's page-declared operations (receipts,
   permissions, accepted/started/pending/completed already exist) versus the
   UI SDK bridge (`snapshot`/`query`/`act`). Recommendation: page-declared
   operations, because they already carry Theorem's receipt and permission
   path; add UI SDK only where a control needs a behaviour Astryx lacks.

## Work orders

One component per order. Each visual obligation names its oracle class.
Static diffs use the oracle's perceptual threshold 0.2 against the committed
reference, captured in the same container.

| Order | Obligation | Oracle |
| --- | --- | --- |
| ref-before | Gray–Scott inline and the CPU/GPU notebook in four palettes × two modes and at 390 wide, committed under `evidence/chromeless-artifacts/before/` with hashes in the ledger | static |
| ref-astryx | Astryx 0.7.16 Slider, NumberInput, Button, Selector, Switch, SegmentedControl from the upstream docs at the pin, under `evidence/refs/astryx-<control>@0.7.16.png`; ledger lane "verbatim (package bound, not ported)" | static reference |
| study | Two or three inline directions as stories, labelled reference vs render, every palette/mode and 390 wide; the owner picks | HITL |
| host-chrome | A healthy artifact shows no persistent action row. Open, Expand, Ask, Source, Stop and revision actions appear on hover, on focus-within and on touch; a failure stays visible without them; every action has an aria-label and no tooltip | static per state + interaction (hover, Tab into the frame, tap) |
| presentation | The App receives its presentation (inline, panel, expanded) and available size through the existing bridge; one scroll owner; a resize or theme change does not restart it (a frame-counter story keeps counting) | interaction + static |
| ui-kit | `@theorem/ui` in the registry and library sources, re-exporting Astryx inside Theorem's `Theme`; annotate and spatial import from it; its declarations reach TSRS | static per control (collage against ref-astryx) + type check |
| kit-discovery | A code-mode search for controls, sliders or theme finds the kit's docs and examples, with no prompt text | behaviour (search result) |
| gray-scott-kit | Gray–Scott recomposed on the kit in the picked direction: same shader, same palette, same ranges and step precision (feed 0.0001) | static (collage against the pick) + interaction (slider moves the running simulation) |
| notebook-adapter | The same controls in an Observable notebook through an explicit mount with cleanup and one React identity | static + interaction |
| agent-actions | Read Feed rate, change it, pause, reset, through the same functions the visible controls call; the receipt reports the observed value | interaction |
| custom-control | A control the kit does not have, authored as source, checked by TSRS and built by esbuild-wasm, with no new host enum or schema | static story |
| verify-live | Real chat on the e2e stack: varied questions and models; desktop and narrow, light and dark, keyboard and touch to host actions, expand, reopen a saved revision, unmount cleanup | owner opens the collages |

## The study

Three stories, each the fixture's script unchanged under a new layout on the
App's `--theorem-*` variables, with the host actions moved by CSS over the
existing rows (a study, not the implementation):

- **A, `chromeless-study-strip`**: the picture, a one-line caption, one strip
  of controls; presets scroll in one line. Host actions over the frame's
  top-right corner.
- **B, `chromeless-study-inspector`**: an inspector column beside the picture,
  below it when narrow. Host actions in a bar beneath, as a message's own
  actions are.
- **C, `chromeless-study-overlay`**: the picture alone; Pause, Reset and
  Parameters float over it, and Parameters opens the rest. Host actions over
  the corner.

In all three the host actions show on hover and focus within, and always on a
touch screen. Each is shot at rest and revealed (`ORACLE_HOVER`, and for C
`ORACLE_FRAME_CLICK=#toggle-params`), in every palette and mode and 390 wide.
The controls are still native inputs on host tokens; the kit replaces them.

## Opening segment

ref-before, then the study. Everything after waits on the pick.
