# Models search/sort/layout + Settings density (delegated, ub-mode)

Owner's follow-up (2026-11-19/20), the remaining packages of the
models/settings/charts handoff after the chart vertical. The owner asked to
finish everything via subagents with no check-ins; two agents ran with
disjoint write scopes, managed on the Theorem job board, integrated here.

## Packages

- Models (job-01M7WH7GPG2AJY97R963ZRJR8Y, agent Newton):
  - `models-search.ts` (pure): contiguous case-insensitive trimmed search over
    name/ref/vendor as separate fields (no subsequence fuzzy); natural
    (numeric-aware) name order with vendor/ref tie-breakers; deliberate page
    reset on query/filter change and clamp on catalog refresh; a local
    case-insensitive Model-column text filter (the shared dynamic filter
    compared a raw value against case-folded comparators).
  - `models-table.tsx`: name accessor = display name alone (was name+ref);
    default sort natural Model A-Z (star no longer moves rows; Starred-first
    stays an explicit choice); single-line name opening details; vendor once;
    right-aligned tabular Context/Input/Output with units in headers; Free for
    zero price; compact Inputs with full list via title/aria; plain Yes/No;
    Max output/Source/Added kept via Columns; one horizontal scroll region,
    pinned identity offsets.
  - `model-details.tsx`: right-side sheet — full name, copyable canonical ID,
    vendor, routing provider/source, limits, pricing units, modalities,
    capabilities, description; Escape/close returns focus to trigger;
    inspecting never changes the picked model; duplicate names disambiguated
    by route.
  - Shared CRM data-table engine untouched; star/picked/preference sync
    preserved (theorem-ui:models, /api/chat/v1/preferences).
- Settings density/state (job-01M7WH7Z8788R9PT8VRJ025MHC, agent Averroes):
  - `settings-frame.tsx` + `appearance.css` settings-geometry block: page,
    section, row and nav spacing read the existing density tokens
    (--appearance-gap-group/related/within, --appearance-control-min,
    --appearance-navigation-min) instead of fixed gap-8/px-6/py-8/h-8.
    Comfortable reproduces the old 24/32 inset; compact/touch move it.
  - A section holding a table takes compact steps (MutationObserver so a
    queried table counts on arrival); touch/coarse keep larger targets.
  - Fixed a real focus defect: `outline-none` cleared outline-style so the
    nav's :focus-visible drew no edge; removed it (nav + breadcrumb).
  - No palette value changed; selection/hover/focus use resolved roles.

## Verification (integrated)

- bun test models-search + models-table + settings-frame + settings/ai:
  42 pass, 0 fail. (Newton: 12 search + 19 table; Averroes: 5 frame; ai: 6.)
- bunx tsc --noEmit clean; eslint clean on all changed files.
- Live :3103 /story/settings-ai: "code" -> only "Code model"; nonsense -> 0
  (no fuzzy); details open/copy/Escape focus-return; page spacing role present;
  sections [comfortable, compact]; light/dark + 390px single-scroll, pinned
  offsets 0/60px; no page errors.
- Pre-existing: responses-section.test.tsx has 3 "No QueryClient set" failures,
  byte-identical to HEAD, fail in isolation — out of scope, left alone.

## Evidence

docs/plans/evidence/models-settings/{models-table-dark,models-details-light,models-narrow}.png

## Log

- Read handoff §3-6/9; confirmed defects in source; submitted two jobs to the
  Theorem board; spawned Newton (Models) and Averroes (Settings) with disjoint
  write scopes; noted dispatch on each job.
- Averroes finished first: reviewed diff + 5 tests (pass), closed agent, noted
  job done. Newton finished: reviewed pure search module + table diff + 31
  tests (pass), closed agent, noted job done.
- Integrated: 42 tests pass, tsc/eslint clean, live render verified search /
  details / focus / density / narrow. Removed agents' transient .probe dir.
- Fidelity seals remain HITL/open. Not committed to main.

## Owner review fixes (2026-11-20)

- Switch regression: the settings control-minimum rule forced block-size:auto
  + equal min-width/height on [role='switch'], collapsing the track to a
  circle. Switches are now excluded from that rule and keep their own
  --thumb-size geometry (30x18 track); the row carries the hit area.
- Default colors rolled back: GitHub Sharp is the default again (:root/.dark
  + original CALM_COLORS); Ember stays a named, selectable palette. Editor
  seeding/reset and the settings oracle updated to the restored values.
- Color picker: the swatch was a dead span; it is now a real <input
  type="color"> wired to the same draft edit as the hex field (56 pickers).
- Models page: cut the filler descriptions (page, Default model, In the model
  picker); kept the cached-OpenRouter notice as a small status line. All
  columns centered (headers + cells). Twenty measurements applied: 32px
  header, 36px rows, 13px text, vertical column separators.
- Tests: 497 pass across the changed surfaces; tsc/eslint clean; story oracles
  response-evidence 9/9 and settings-appearance 4/4. terminal-theme test
  selectors updated to the restored :root/.dark GitHub Sharp modes.
- Evidence: models-settings/models-centered-light.png, switch-restored.png;
  refreshed response-evidence/settings-appearance renders.
