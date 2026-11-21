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

## Review follow-up after `e855ee4b`

The [Composer acceptance run for `e855ee4b`](https://github.com/Travis-Gilbert/Theorem-UI/actions/runs/44835621628) passed, including the corrected response story. That result covers the pushed commit and does not include the fixes prompted by [CodeRabbit's full review](https://github.com/Travis-Gilbert/Theorem-UI/pull/146#pullrequestreview-6000753294). The follow-ups below have passed the integrated local verification in the table below. Fresh GitHub verification of the commit containing this record is tracked in [PR #146](https://github.com/Travis-Gilbert/Theorem-UI/pull/146).

The four Major findings are addressed through bounded metadata parsing, rejection of the benchmarking address range, omission of untrusted browser-loaded preview media, and compatible completion of valid legacy palettes. The confirmed Minor findings extend those fixes to related behavior and acceptance gaps:

- **Preview parsing and transport:** metadata scanning has linear worst-case behavior on the bounded response body, handles matching attribute quotes and invalid numeric character references, and preserves usable metadata. Redirects release their discarded bodies promptly and continue under the shared deadline. Concurrent lookups preserve successful cached metadata. IPv4 admission now excludes `198.18.0.0/15`.
- **Sources and viewer privacy:** source cards retain their text, links, exact passages and actions without automatically requesting publisher-controlled images or favicons from the viewer's browser. Sources without IDs or URLs have distinct message-local context identities, including after reload and when their display labels match. The open Sources panel retains every displayed source, including later streaming arrivals, until it closes. If all of its sources resolve while open, Escape restores focus to the relevant preview link when the fallback trigger disappears. Missing preview metadata becomes stale after five minutes; successful metadata retains its longer freshness window.
- **Appearance continuity:** valid legacy palettes gain compatible missing semantic tokens before completed-palette contrast validation. Editor values follow the active preset, and changing palettes invalidates an obsolete draft while unrelated appearance changes preserve it. Reactivating glass after reduced transparency restores the pane's join geometry.
- **Independent color evidence:** the independent oracle includes the action, insight and chart-series contrast edges, and measures code using its actual `attention-ink` role instead of primary ink. The evidence ledger distinguishes the current Theorem SVG chart from its historical upstream renderer and points Ember entries to the named Ember modes.
- **Models behavior and verification:** OR filters initialize from the first active rule, copy feedback follows the displayed model, and clipboard tests assert the resolved contents rather than accepting an unresolved Promise.

The suggestion to associate a fallback with a later durable citation solely by their shared label was not applied. Labels are display text and cannot establish source identity; that inference could combine unrelated evidence. Grouping uses supplied IDs or matching URLs. Entries lacking both retain separate citation identities, with regressions covering same-label documents and later durable records that have no shared identity.

### Additional source identity and parsing cases

The [review of `97b9359e`](https://github.com/Travis-Gilbert/Theorem-UI/pull/146#pullrequestreview-6001107996) identified four narrower cases. Source collection now reserves assigned context keys: a source that gains an ID and changes URL keeps its identity, while a new source at the former URL receives an unused citation key. Regression coverage exercises both collection and real Add-to-context actions. Reload assertions clear the composer first, then verify that the reloaded UI recreates the original references and exact passages.

Metadata scanning uses HTML's ASCII whitespace at lexical boundaries, so a nonbreaking space inside raw text, an attribute or a relation token cannot act as an HTML delimiter. Candidate fields are decoded and trimmed before selection; an empty Open Graph field yields to Twitter or the document title. ASCII-only tag-name normalization also rejects Unicode lookalike tags while accepting real uppercase HTML names. The forward-only scan and the precedence of usable Open Graph metadata are preserved.

### Complete color editing

The [palette-editor review](https://github.com/Travis-Gilbert/Theorem-UI/pull/146#pullrequestreview-6001300983) identified two validated accent state colors without controls. Checking the whole contrast inventory found six further omitted existing roles. The editor now exposes user-message, artifact and hover surfaces; code ink; accent hover and pressed fills; and destructive-action fill and text.

Every foreground and background used by contrast validation has a control in both light and dark mode. A regression starts with a rejected accent/text combination, repairs its hover and pressed fills through the visible controls, and applies the resulting valid custom palette. Palette values, contrast requirements and the validation schema are preserved.

### Ambiguous sources, recovery, and preview extraction

The [review of `a792e846`](https://github.com/Travis-Gilbert/Theorem-UI/pull/146#pullrequestreview-6001469822) prompted six further checks. URL-only evidence stays separate when several explicit source identities share its URL; repeated anonymous passages reuse that separate group. Reload verification now unmounts and remounts the runtime from serialized messages before rebuilding context references. Closing Sources through either Escape or its trigger hands focus to a preview when the trigger disappears, while outside-click focus stays on the selected control.

Model-ID copy failures now appear as an accessible error. A pending write disables the copy control and shows its busy state, then permits retry after settlement. The keyed model boundary isolates feedback from earlier selections.

Preview extraction excludes nested and unclosed template contents while continuing to skip comments and raw text correctly. Server caching and in-flight requests use document URLs without fragments, preserve query strings, and return shared metadata without a caller's anchor. Citation links retain their original anchors.

The parser evaluation favored retaining the bounded forward scan for this change. On the local nested-tag probe at the existing 200,000-character limit, full-tree parse5 construction took about 2,242 ms and the existing scan about 10 ms. This is a workload-specific measurement, not a general parser benchmark; the template fix uses a single nesting counter.

## Verification record

| Gate                                                       | Verified result                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Full repository TypeScript and focused changed-file ESLint | Passed                                                                                      |
| Expanded composer/response suite                           | 1,015 tests, 99 files, 3,457 assertions, zero failures                                        |
| Expanded appearance/settings suite                         | 179 tests, 15 files, 5,451 assertions, zero failures                                        |
| Independent emitted-color audit                            | 119 edges, 10 modes, 2,390 predicates, zero failures                                                   |
| Response-evidence browser oracle                           | 19/19 in Chromium 156.0.8078.4 and WebKit 27.2                                              |
| Appearance editor browser oracle                           | 4/4 in Chromium 156.0.8078.4 and WebKit 27.2                                                                          |
| Narrow light-mode touch probe (390 × 844, baseline)                  | 9/9, including exact values, expansion, viewport fit, Data continuity and no runtime errors |
| Full Workers application Vite build                        | Passed; generated flags contain both strictly-public fetch and Node compatibility           |
| Live local workerd transport probe (baseline)                         | Public metadata succeeds; private-address resolution/refetch is refused                     |

The latest recovery follow-up reran the combined composer and appearance suites, repository typecheck, focused lint and WebKit response story. The Chromium response, appearance-browser, touch and local Workers measurements include recorded earlier evidence. Current GitHub verification is tracked on the PR for the commit containing this record.

The latest WebKit response run passed all 19 checks and reported no JavaScript page errors. It logged six HTTP 503 resource messages. A separate single-load trace identified `/api/chat/v1/dictation/status` returning `theorem_unconfigured` because this isolated preview has no Theorem backend configured. That trace showed no preview or asset failure and is consistent with the one message per scenario in the original run. The test is not recorded as completely free of resource errors.

The touch probe also verified that tapping 8px above the visible switch toggles it: its 44px hit area grows independently of its unchanged 38 × 22px track.

The local Workers build reused generated terminal assets only after all 280 tracked terminal source files matched the producing checkout. No terminal or IDE code changed. The PR's clean Workers build remains a separate CI check.

Machine-readable results are in [interactive-response-completion.json](evidence/interactive-response-completion.json). These are fixture/runtime checks, not a production deployment or a human visual-fidelity seal. The original human review items remain for a person to assess.

### Rendered evidence

[Expanded chart, dark](evidence/renders/response-completion-chart-dark.png) · [Expanded chart, narrow light/touch](evidence/renders/response-completion-chart-touch.png) · [Source fallback and keyboard focus](evidence/renders/response-completion-sources-dark.png)
