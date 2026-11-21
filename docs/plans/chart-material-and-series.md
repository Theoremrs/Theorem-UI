# Chart presentation, glass material, and series colors (ub-mode)

Owner's follow-up (2026-11-19), section 7 of the models/settings/charts
handoff. Scope this turn: the inline chart vertical — presentation, glass
material contract, and complete series-color customization. Models
search/sort and settings density are separate packages, named but not in
this unit. Working copy: this worktree, HEAD 409c436d, uncommitted
interactive-response work preserved (no reset/stash/reformat).

## Findings being fixed (from the audit)

1. Chart uses solid `response-frame` (`var(--popover)`), never enters the
   material resolver → cannot receive glass.
2. Two-series fixture omits the legend; color alone identifies series.
3. Plot area short (6.5rem); scale rounds 320 → 500 (huge headroom).
4. Provenance repeated in header caption and footer.
5. Series slots 2 and 5 use `--teal` / `--graph-agent`, which the custom
   palette schema does not expose → inherited hues survive user edits.

## Units (each: failing test → smallest change → verify)

- U1 chart-data: one pure module owns normalization, a truthful axis policy
  (zero baseline, nice ticks; fixture 320 → 400 bound, 100 ticks), and the
  single normalized series the plot, Data view, and aria description share.
- U2 chart-plot: own the SVG (vocabulary chart math is not exported). Taller
  plot (~200px), legend always for >1 series, dashed alternate series,
  endpoint value labels, one source caption below the plot (link only when a
  URL exists). Data view unchanged values.
- U3 series tokens: five categorical `series-1..5` tokens placed by the
   generator's graph tier, exposed in COLOR_ROLES + settings editor with
   graphic-contrast (3:1) validation; `--chart-N` map to them. No raw
   teal/graph-agent; every slot follows theme + user override.
- U4 material: add `chart` surface role, default glass/liquid in the
   resolver (both presets), explicit override wins; frame wears
   surface-liquid + useLiquidGlass; plotted data/labels on a stable opaque
   reading surface. Opaque/forced-colors/reduced-transparency fallback.
- U5 live reduced-transparency: useLiquidGlass observes the media query and
   removes the live canvas when transparency is reduced while mounted.
- U6 verify: focused unit tests, story oracle (response-evidence), real
   dev server render light/dark + custom theme; record evidence.

## Log

- Read the handoff (§7 chart, §7 series/material contracts) and the audit's
  working-tree locations. Confirmed the five findings in source. Scoped this
  turn to the chart vertical (presentation + glass + series coverage); Models
  search/sort and settings density are separate packages, left untouched.
- U1 chart-data: wrote failing tests (normalization, truthful axis). First
  axis attempt used niceCeil(max) → 500 for 320 (the defect). Reworked to a
  nice tick-step (max÷4) → 400/100 for the fixture, 8/2 for a 7-max. 7 pass.
- U3 series tokens: added five categorical `series-1..5` at the graph tier in
  scripts/palettes.ts; exposed via COLOR_ROLES with 3:1 graphic pairs; mapped
  --chart-N to them (was redwood/teal/insight/action/graph-agent). Stone-light
  failed 3:1 at graph lightness → added series to the contrast-repair loop.
  Added editor rows (Data series 1–5) + a test proving all five follow an
  explicit override. Regenerated palettes.css. 17 palette/appearance pass.
- U4 material: added `chart` surface role; resolver defaults it to glass in
  both presets, explicit override wins, artifact unchanged. Updated the Calm
  manifest test to encode "chart glass, reading flat". Frame wears
  surface-liquid + useLiquidGlass; plot/axes/labels on an opaque reading panel.
- U2 plot: own SVG (vocabulary math not exported). Measured width (no fixed
  desktop viewBox), 200px plot (144 compact <480px), gridlines+ticks from the
  truthful axis, legend always for >1 series, dashed alternate line + dashed
  legend swatch, endpoint value labels, one source caption (link only with a
  safe sourceUrl). Data view reads the same normalized series. 9 chart tests.
  Fixed a real bug: the SVG carried data-aui="chart", so the vocabulary's
  height:3rem rule squashed it to 48px; removed the attribute.
- U5 live reduced-transparency: useLiquidGlass now subscribes to the media
  query and removes the live canvas when transparency is reduced while
  mounted (was activation-only). Failing test → fix. 19 glass tests pass.
- Verified on the real dev server (3103): light glass draws live; CDP
  prefers-reduced-transparency=reduce while mounted drops the canvas, sets
  backdrop none, opaque #272529 fallback. Narrow 390px keeps readable text.
  Settings story: all five series seed from theme, accept edits, --chart-2
  follows the override (coverage defect fixed end-to-end).
- Fixed stale test/oracle selectors (data-aui="chart" → .evidence-chart-plot).
  useIsomorphicLayoutEffect for SSR. Lint + typecheck clean.
- Suites: 216 (assistant-ui/glass/appearance/palettes/terminal/rail) + 239
  (chat/generative/link-preview) pass; story oracle response-evidence 9/9.

## Status: complete (this vertical). Fidelity seals remain HITL/open.

Evidence: docs/plans/evidence/interactive-responses/response-evidence{,-light,-narrow}.png.
Not in this unit (named, separate packages): Models search/sort + Twenty table
layout; settings density/states generalization.
