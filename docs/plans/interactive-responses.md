# Interactive responses: the evidence slice

Owner's ask (2026-11-19): implement the attached
`Theorem-Interactive-Responses-Plan.md` (snapshot `e8293c78`, registry
`9b6c12d9`) and pull up a dev server. The plan's Phase 1 — response design
and evidence — is the first vertical slice it names; this record charts and
executes that slice. Colors: the spec's oxblood/gold/teal/violet candidates
become a **default palette**, and every accent stays user-customizable in
Settings → Appearance (owner's note, 2026-11-19).

Work happens in the managed worktree
`~/.codex/worktrees/interactive-responses/Theorem ui`, branched from
`origin/main` (`409c436d`). The shared `feat/motion` checkout is dirty and
1264 commits behind the spec's snapshot; it is not touched. Dev server:
`http://localhost:3103` (terminal wasm reused from the enrichment worktree,
whose `terminal/` sources are identical to this base).

## Board (portable binding; the harness plan surface is absent in this session)

Destination: ordinary responses expose their evidence in place — compact
citations that open an inspector with the supporting passage, link previews
that survive metadata failure, a chart whose table view agrees with its
plot — drawn in the app's design language on a warm default palette whose
accents (violet brand, oxblood action, gold insight, teal success) the
person can change in Settings. Fixpoint: every obligation below discharged
with its named evidence; fidelity collages committed for a person to seal.

| Node | Lane | Work | Verify sibling / oracle |
| --- | --- | --- | --- |
| N1 palette | original (spec's candidate colors) | New `ember` palette in `scripts/palettes.ts` (warm neutral hue, violet redwood, oxblood action family, gold insight family, teal success), default in `resolveAppearance`; `action`/`insight` color roles + pairs; series tokens `--chart-1..5` placed from the families | unit: `scripts/palettes.test.ts`, `src/lib/appearance.test.ts` (contrast pairs, tier agreement, defaults); static: palette-matrix story renders |
| N2 settings colors | original | Settings → Appearance: per-role color editors (light+dark) over the existing `customPalette` schema, seeded from the active palette; contrast validation surfaced per role | unit: appearance schema tests; interaction: settings story scenario (edit a color, invalid contrast refused) |
| N3 response recipes | translation (registry generative-ui style → app tokens) | Compact response frame recipe (~6px radius, 12px padding, 30–32px controls) in `appearance.css` + `surfaces.tsx`; citation/link/chart chrome restyled through tokens, never hardcoded hues | static: story renders in both modes; motion: none claimed beyond existing tokens |
| N4 citation inspector | translation (inline-citation interaction idea; Theorem source identity) | `theorem-citation` chip opens a popover inspector: title, site, supporting passage, Open source / Add to context / Copy passage; retrieved-source suppression policy kept and documented | unit: `citation-parts.test.tsx` extended (inspector content, unsafe URLs, dedupe); interaction: evidence story scenario (keyboard open, add to context) |
| N5 link preview | translation (link-preview element idea) | Compact preview card for citations with URL metadata already in the part; plain link fallback when metadata absent/failed; no second fetch stack | unit: preview fallback tests; static: evidence story (preview + failed-preview states) |
| N6 chart + table | translation (generative Chart vocabulary kept) | `Chart` override in `styledGenerativeUILibrary`: same SVG marks, plus units/provenance caption and a Data toggle rendering the same series as a table; series colors from N1 tokens | unit: chart/table agreement test (same normalized series); interaction: evidence story scenario (toggle to data) |
| N7 stories + ledger | original | Stories `response-evidence`, `response-coding`, `response-writing` over committed fixtures; ledger rows; oracle collages under `docs/plans/evidence/interactive-responses/` | static oracle: `story-oracle.mjs shot` + collage; interaction oracle: `interact` scenarios; fidelity seal: HITL, left open |

Dependencies: N3–N6 depend on N1 (tokens) and N3 (recipes); N7 depends on
N4–N6. N2 depends on N1. Scopes are disjoint per node except
`appearance-policy.ts` / `palettes.ts`, owned by N1 alone (contract seam).

Out of this slice (named by the spec, not silently dropped): Phases 2–5
(action round trips/reviewable diffs, shared graph host + inline terminal,
writing evidence annotations, secondary surfaces). The chart's Data toggle
and citation inspector are local-view/context actions, which Phase 1 owns;
no domain mutation is claimed.

## Obligations

- O1 (unit): every palette keeps its registered contrast pairs; ember's
  defaults pass the same `COLOR_PAIRS` as the built-ins. Proof:
  `bun test scripts/palettes.test.ts src/lib/appearance.test.ts`.
- O2 (unit): the present schema stays under the 8 KB cap with the chart
  additions. Proof: `bun test src/lib/generative`.
- O3 (unit): citation inspector shows the exact passage; unsafe URLs stay
  unlinked; one source cited twice draws one chip. Proof:
  `bun test src/components/chat`.
- O4 (interaction, oracle class named): evidence story scenario — keyboard
  opens the citation inspector, Add to context puts a reference in the
  composer, chart Data toggle shows the same values. Proof:
  `node scripts/story-oracle.mjs interact response-evidence`.
- O5 (static, oracle class named): story renders captured in headless
  Chromium at the story viewport, both modes; collages committed. Proof:
  `node scripts/story-oracle.mjs shot` + committed files under
  `docs/plans/evidence/interactive-responses/`.
- O6 (HITL): fidelity seals stay open for the owner; no agent seal.
- O7 (unit): settings color editor round-trips a custom palette and refuses
  a failing pair. Proof: appearance schema tests + settings story scenario.

## Decisions

- The spec's candidate colors are illustrative; the generator places them
  by hue/chroma rules like every palette (owner: "good matching hue/chroma").
  Ember keeps the spec's hues — warm neutral canvas, violet brand, oxblood
  action, gold insight, teal success — at the tier lightness/chroma the
  generator already enforces, so contrast is held by construction.
- `redwood` stays the accent role name (the generator's own contract);
  ember gives it the violet hue. New semantic roles `action` (oxblood) and
  `insight` (gold) join `COLOR_ROLES` so components name meanings, not hues.
- Retrieved-source suppression (`web_search`/`web_read` draw no chip) is
  kept: the spec asks to review it explicitly, and the crowding it fixed
  (eight tags per search) is the failure the spec's dedupe rule names.
  Inspector affordances go on the chips that do draw; the tool call keeps
  every retrieved result.
- No new metadata fetch stack: the preview renders provenance the part
  already carries (label/url/excerpt); a failed or absent preview leaves
  the plain working link (spec §6).

## Status

- [x] N1 palette + roles
- [x] N2 settings color editors
- [x] N3 response recipes
- [x] N4 citation inspector
- [x] N5 link preview fallback
- [x] N6 chart data view
- [x] N7 stories, ledger, renders; checks green (fidelity seals open)

## Evidence

All renders in `docs/plans/evidence/interactive-responses/`, captured in
headless Chromium 156.0.8078.4 at the story viewport (1024x900), dark via
the oracle's own context and light via `colorScheme: 'light'`, reduced
motion on. Hashes are in the ledger's rows.

- `response-evidence.png` / `-light.png`: the research reply — two source
  chips (the twice-cited source draws one), the failed-preview source as a
  plain chip, the chart frame with units and provenance, the comparison
  table.
- `response-evidence-inspector.png`: the keyboard-opened inspector with the
  exact passage, Open source, Add to context, Copy passage.
- `response-evidence-context.png`: the composer carrying the source as a
  durable message reference.
- `response-evidence-data.png`: the chart's Data view, the plot's own
  values.
- `response-coding.png` / `-light.png`: the failed step kept beside the fix
  (folded in the activity line's Details), the source chip.
- `response-writing.png` / `-light.png`: the draft with source-backed and
  inferred claim chips.
- `settings-appearance.png` / `settings-appearance-colors.png`: the
  per-role editors seeded from Ember in both modes; a valid edit applied.

### Verification (2026-11-19)

- `bun test src/components/chat src/lib/generative
  src/components/assistant-ui/elements/evidence-chart.test.tsx
  src/lib/appearance.test.ts scripts/palettes.test.ts`: 252 pass, 0 fail.
- `bun test scripts/ src/lib/appearance.test.ts src/components/terminal`:
  177 pass, 0 fail (palette, rail, terminal theme/ladder/roles suites).
- `bunx tsc --noEmit`: clean. ESLint on changed files: clean.
- Present schema: 7632 bytes, under the 8 KB cap (was 7558).
- `node scripts/story-oracle.mjs interact response-evidence` (Chromium):
  all 8 checks true — one chip per source, keyboard opens the exact
  passage, Open source goes to the source itself, Add to context lands a
  message reference, the Data view equals the plot's series, provenance
  stays visible.
- `node scripts/story-oracle.mjs interact settings-appearance`: all 4
  checks true — editors seed from the active palette, a failing contrast
  pair is refused with its reason and paints nothing, a valid edit applies
  as the custom palette.
- Fidelity seals are HITL and remain open: the renders are committed for
  the owner to open; no agent has sealed them.

### Notes for the next slice

- The oracle's dev-overlay suppression now keeps portal containers
  (popovers/dialogs/menus) visible; without that, any popover interaction
  scenario would read a hidden popup.
- `scripts/palettes.test.ts` now parses full selector lines and checks the
  palette modes' own blocks (not the Calm fallbacks or the custom
  passthroughs); the ink-tier check gathers the largest lightness group,
  since the contrast repair legitimately moves individual inks (Stone's
  link and response accents).
- The chart's `title`/`units`/`source` props are optional extensions of
  the vocabulary's Chart schema; historical trees without them render
  unchanged. `source` merges with Citation's prop of the same name in the
  flat present schema (the framework's own combining rule).
- Retrieved-source suppression is unchanged and documented above; the
  inspector goes on the chips that draw.
- Phases 2–5 of the spec remain: action round trips/reviewable diffs,
  shared graph host + inline terminal, writing evidence annotations,
  secondary surfaces. The writing story shows the evidence vocabulary as
  chips, not editor marks; claim-level anchors are Phase 4.

## Link previews (2026-11-19, owner's follow-up)

The owner's direction: links never appear as tags — full web previews are
preferred; the fallback is a hyperlink with a dropdown labelled **Sources**
(the attached Edit-row pattern). Installed via
`npx assistant-ui@latest setup --products elements/link-preview` (the
guided setup stream; plan approved in conversation, steps s1–s5).

- `elements/link-preview.tsx` installed with the shadcn CLI; the app's
  translated `surfaces.tsx` was kept (overwrite declined), the duplicate
  `tw-shimmer` import removed, `bun.lock` restored. The card is restyled
  onto the response-frame radius/separator tokens.
- `src/server/link-preview.ts` + `GET /api/link-preview/v1?url=…`:
  server-side OG/meta resolution with SSRF guards (public http(s) hosts
  only, manual redirect re-checks, 512 KB body cap, 6 s timeout), a 30 min
  success / 5 min failure cache. The element stays props-only.
- `src/components/chat/citation-sources.tsx`: drawn once per assistant
  message after its parts. Each distinct source owns one metadata query
  (`SourceSlot`); resolved sources draw compact `LinkPreview` cards; the
  rest fold into one "Sources (n)" hyperlink + chevron dropdown (coss Menu)
  with the passage, Open source, Add to context, Copy passage. The row
  reads the shared query cache through `useSyncExternalStore`, so a source
  arriving mid-stream never changes a hook set (the first attempt crashed
  with "Rendered more hooks than during the previous render" — fixed).
- Retrieved sources (`web_search`/`web_read`) now draw as previews too:
  the old chip-crowding suppression is retired with the chips (owner's
  direction supersedes the earlier policy; one card per distinct source).
- `theorem-citation`'s part renderer claims the part and draws nothing;
  the chips, the popover inspector and their tests are replaced.

### Verification (link previews)

- `bun test src/components/chat src/lib/generative
  src/server/link-preview.test.ts
  src/components/assistant-ui/elements/evidence-chart.test.tsx`:
  242 pass, 0 fail. `bunx tsc --noEmit` clean; ESLint clean on changed files.
- Story oracle `interact response-evidence`: all 9 checks true (one
  preview per source, keyboard opens the Sources dropdown with the exact
  passage, Open source/Add to context work, chart Data view agrees).
- **Real model responses** on a local Theorem stack (own ports 3104/8492/
  8498, data dir `~/.theorem/e2e-interactive`, real OpenRouter calls through
  `~/.theorem/provider-keys.env`): a turn reading react.dev and iana.org
  drew two full previews with OG images/favicons
  (`live-model-previews.png`); with the metadata route forced to fail, the
  same turn drew the Sources (1) row and its dropdown
  (`live-model-sources-row.png`). No page errors. The other session's e2e
  stack on 3102/8392/8398 was left untouched.
- Fidelity seals remain HITL and open.
