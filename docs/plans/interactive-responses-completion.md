# Interactive evidence responses: completion of PR #146

## Scope and design lineage

This completes the first evidence-response slice described by the original **Theorem: interactive responses and component adoption** plan and implemented in [interactive-responses.md](interactive-responses.md). That plan deliberately separates evidence components from action round trips, shared graph/terminal hosts, and revision-aware writing assessments. This change does not claim those later slices are complete.

The owner's follow-up decisions remain authoritative: full source previews with a Sources-link fallback, user-controlled colors, GitHub Sharp as the default, bounded glass around an opaque reading surface, and the existing Models/settings behavior. The latest main integration is preserved, including both Palette Colors and Workspace settings.

## Closed behavior gaps

### Sources remain evidence objects through every view

`collectCitationSources` rebuilds source groups from the stored message. Later citations enrich a source's metadata without dropping distinct exact passages. Explicit source identities remain separate even when they share a URL. Loading/failed previews stay in the Sources fallback, including IDs containing delimiter characters.

Sources uses the existing Popover because the panel contains text and several ordinary controls. Tab reaches its passage, Open, Copy and Add actions; Escape restores focus. If metadata resolves while a person is inspecting a fallback source, that entry remains mounted until the panel closes.

Add to context uses the SDK's supported real message location plus a versioned citation excerpt. Composer identity includes the source, so adding two sources from the same message retains both; repeated Add updates the same reference. Normal evidence retains its exact passages and provenance. The whole serialized reference is bounded to the existing 8,192 UTF-8 bytes. Larger evidence explicitly points back to its complete message instead of silently cutting a quote; an identity that cannot fit produces a local error.

### Charts preserve their declared contract and their data

The chart honors `stacked` for bar/area, `showAxis`, `showLegend`, the declared named color tokens, and compact sparkline behavior. Positive and negative stacked values accumulate separately; Data continues to show the original values rather than cumulative coordinates. User palette slots remain the default.

A single keyboard focus stop inspects points with Left/Right and Home/End. Pointer and touch inspection use the same values. The expanded dialog shares the normalized dataset, selected point and Chart/Data mode with the inline view. Expansion does not repeat a presentation operation or request another dataset.

Small-valued measurements retain a scale that contains the data and distinct nonzero tick labels. Exact values remain available in the inspector and Data. Units and provenance remain present in both placements; absent provenance is explicit, and the model-facing source guidance asks for illustrative data to be labeled.

### Transcript geometry stays stable while controls receive input

User messages retain their actual layout height. The former offscreen 200px estimate became a real 72px prompt during a chart click, moving Expand by 128px between pointerdown and pointerup. Removing that estimate preserves real click targets while retaining the launch animation. The response oracle checks the preceding message's height before inspection and after returning from the expanded view.

### Palette validation checks the colors that actually render

Sparse custom palettes are completed with the same default tokens used by the renderer before contrast validation. Foreground-only and background-only imports can no longer pass validation and become unreadable after completion. Legacy palettes and the user's existing appearance choices remain supported.

### Link previews work in both supported runtimes

One six-second elapsed deadline spans DNS, address retries, redirects, connection and body reads. Trickle responses cannot reset it. Timeouts destroy active connections; the existing 512 KiB body cap closes the stream after retaining its usable prefix; truncated responses fail.

Bun/Node continue to resolve public addresses and pin connections to an approved IP with the original Host and TLS name. Workers use native fetch with the platform's public-egress boundary, while retaining per-hop URL/DNS checks and manual redirects. `global_fetch_strictly_public` is required alongside Node compatibility; the full Workers build verifies both in generated Wrangler configuration. IPv6 admission normalizes literal forms and refuses the full nonpublic ranges covered by the guard.

A local workerd probe reproduced the old pinned-transport failure for example.com, then verified successful metadata for example.com and react.dev with the new transport. The same runtime refused a hostname resolving to loopback. This is runtime verification, not a production deployment claim.

## Acceptance gates

The existing Composer gate now includes the server preview regressions. Its existing directories already cover chart, citation, composer-reference and source-helper tests. The appearance gate includes the PR's palette, glass, terminal-theme, Models, settings-frame and settings-route tests.

Both independent color inventories now include all ten emitted palette modes, including Ember light/dark. The generated color evidence is refreshed without changing contrast thresholds or removing adversarial assertions.

The previous GitHub run completed the last touch-rhythm checks immediately before the job's 25-minute cap. GitHub explicitly annotated a maximum-execution-time cancellation. The bounded job budget is now 35 minutes; all existing checks remain, with the evidence-response and appearance story interactions added to the same running browser server.

The first clean remote run passed all twelve existing appearance browser oracles, then exposed an ambiguous global Add-to-context selector in the new response story. The closing source popover still exposed its valid action during its exit animation. The story now targets each source's stable identity and waits for the fallback to become hidden before repeating the resolved source's action. The two-source and idempotence assertions remain intact.

## Verification record

| Gate                                                       | Verified result                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Full repository TypeScript and focused changed-file ESLint | Passed                                                                                      |
| Expanded composer/response suite                           | 975 tests, 98 files, 3,213 assertions, zero failures                                        |
| Expanded appearance/settings suite                         | 152 tests, 14 files, 4,871 assertions, zero failures                                        |
| Independent emitted-color audit                            | 10 modes, 1,090 predicates, zero failures                                                   |
| Response-evidence browser oracle                           | 19/19 in Chromium 156.0.8078.4 and WebKit 27.2                                              |
| Appearance editor browser oracle                           | 4/4 in Chromium 156.0.8078.4 and WebKit 27.2                                                                          |
| Narrow light-mode touch probe (390 × 844)                  | 9/9, including exact values, expansion, viewport fit, Data continuity and no runtime errors |
| Full Workers application Vite build                        | Passed; generated flags contain both strictly-public fetch and Node compatibility           |
| Live local workerd transport probe                         | Public metadata succeeds; private-address resolution/refetch is refused                     |

The touch probe also verified that tapping 8px above the visible switch toggles it: its 44px hit area grows independently of its unchanged 38 × 22px track.

The local Workers build reused generated terminal assets only after all 280 tracked terminal source files matched the producing checkout. No terminal or IDE code changed. The PR's clean Workers build remains a separate CI check.

Machine-readable results are in [interactive-response-completion.json](evidence/interactive-response-completion.json). These are fixture/runtime checks, not a production deployment or a human visual-fidelity seal. The original human review items remain for a person to assess.

### Rendered evidence

[Expanded chart, dark](evidence/renders/response-completion-chart-dark.png) · [Expanded chart, narrow light/touch](evidence/renders/response-completion-chart-touch.png) · [Source fallback and keyboard focus](evidence/renders/response-completion-sources-dark.png)
