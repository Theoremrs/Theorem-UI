# Review fixes (2026-11-20): five validated issues

Each issue was checked against the code, reproduced, and fixed test-first
(ub-mode). All five were valid.

## Issue 1 — SSRF via DNS resolution (valid, fixed)

`publicHttpUrl` checked hostname text only; a public name resolving to a
private/loopback IP was fetched. Confirmed Bun's native fetch ignores undici's
`connect.lookup` (blackhole-pin test returned 200), so a hostname check alone
cannot pin the connection.

Fix: `src/server/link-preview.ts` now resolves every hop with `node:dns`,
filters to public addresses (`publicAddress`, reusing the literal guard), and
connects to the exact approved IP via `node:https`/`http` with `host` = IP,
`servername`/`Host` = name (SNI + virtual host kept). Redirects re-resolve and
re-approve. Body capped at MAX_BYTES.

Proof: `publicAddress` unit tests (public v4/v6 admitted; loopback/private/
link-local/mapped refused). Live: `localtest.me` (resolves to ::1) returns null
/ 404; example.com and react.dev still resolve real metadata. Blackhole-pin
probe proved node:https honors the pinned IP in both Bun and Node.

## Issue 2 — saved custom palettes dropped on load (valid, fixed)

`customColors` was `z.record(enum, hex)` (all keys required). Adding
action/insight/series tokens made older saved palettes fail
`appearanceSelectionSchema`, and the persist `merge` fell back to initial,
dropping all appearance choices. Reproduced with a synthetic missing-key parse.

Fix: `customColors` is now `z.partialRecord` (new tokens optional on read;
contrast gate already checks only present pairs). `resolveAppearance` fills
missing tokens from the default palette (`completeCustomPalette`) so the custom
surface stays complete. The editor seeds missing tokens from the built-in.

Proof: new test — an older palette missing the nine tokens loads, fills
series/action from the default, preserves the person's own colours and name.
13 appearance tests pass.

## Issue 3 — switch hit area too small (valid, fixed)

Excluding switches from the control-minimum rule left only the 30x18 track
clickable; SettingsRow is a plain div, so tapping the title/padding did nothing.

Fix: a transparent `::after` on the switch grows the hit area to
`--appearance-control-min` (32px comfortable, 44px touch) centered on the track,
without changing the drawn geometry.

Proof: live touch-density click 8px above the track toggled the switch
(false→true); computed ::after is 44px on touch, 32px comfortable; track stays
30x18.

## Issue 4 — resolved preview hid passage + actions (valid, fixed)

A resolved source left the dropdown, and LinkPreview had no passage inspector
or actions; the page description also replaced source.passage on the card.

Fix: extracted `SourceActions` (passage popover + Add to context + Copy
passage), rendered beside every resolved preview and reused in the dropdown
entry (one decision in one place). The card keeps the page description; the
passage and actions stay reachable below it.

Proof: new test — a resolved preview with a page description still exposes the
passage, Add to context, Copy passage. Live render confirms. 14 citation tests
pass; story oracle response-evidence 9/9 (dropdown selector updated to the
shared actions).

## Issue 5 — editors seeded stale custom colors (valid, fixed)

`seedColors` preferred `overrides.customPalette` even when a built-in was
selected, so choosing another palette after creating a custom theme refilled
the editors with the old custom colors; applying restored that theme.

Fix: use saved custom colors only when `overrides.palette === 'custom'`
(the reviewer's exact suggestion).

Proof: live — create custom (accent #0000ff), choose Stone → editors show
Stone's accent #85474f, not #0000ff.

## Verification

- 71 tests (link-preview, appearance, palettes, settings-frame, models, ai) +
  206 (citation, chart, glass, terminal, rail) pass; tsc + eslint clean.
- Story oracles: response-evidence 9/9, settings-appearance 4/4.
- Live SSRF, hit-area, preview-actions, and seed checks above.

## Log

- Read all five locations; confirmed each against source/runtime (Bun fetch
  lookup probe, Zod record probe, live switch/seed/preview renders).
- Fixed 1 (DNS-pinned fetch), 2 (partialRecord + complete-on-resolve), 5
  (custom-only seed), 4 (shared SourceActions), 3 (::after hit area), each with
  a failing test or live reproduction first.
- Updated the response-evidence oracle's dropdown selector to the shared
  actions; refreshed evidence renders.


## Follow-up completion

The [PR #146 completion record](interactive-responses-completion.md) supersedes the transport and partial-palette validation details above: Workers now use verified public-only platform egress, all request stages share one elapsed deadline, and contrast validation completes missing colors before checking. It also records chart/source interaction fixes and current acceptance results.
