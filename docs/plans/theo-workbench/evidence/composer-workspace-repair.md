# Composer, workspace, and performance repair

November 21, 2026 · America/Detroit

Implemented the behavioral work from *Theorem Composer, Workspace, and Performance Repair Plan* on Theorem UI main at `610f4059`. The existing appearance supplies the controls, status, and focus indicators.

- Ordinary Enter sends through the existing form and active-run inbox. The editor handles IME, suggestion selection, Shift+Enter, and code editing before sending. The plus menu inserts an undoable code block. Clipboard code preserves its language and text through send and reopen.
- Full, Right, Bottom, Back to chat, and Close workspace operate on one mounted host. The rail follows the visible surface. The bottom drawer spans the sidebar and conversation and clears the measured composer. The right-side docking preference survives a temporary bottom placement. New inspector widths are bounded, and existing saved widths still load.
- The layout adapter distinguishes restore, save, device fallback, and first use. Account writes still use revision checks. A missing route remains an error. The status exposes bounded response metadata and a recovery action. A lost write remains uncertain. Its recovery action restores the confirmed account layout.
- The thread list returns metadata before bounded title recovery. One timer owns refresh for the visible conversation. Unchanged transcript revisions skip reconciliation, and changed histories use indexed message and run identities. Hidden workbench rendering pauses. The chat shell, workspace, terminal story, and native App host load at their feature boundaries.

## Verification

The composer contract passed 19 checks in Playwright Firefox. The local signed-in Firefox scenario passed typing, send, edit, reopen, placement, draft continuity, first-use layout, save/reload, stale revision, and recovery from a simulated generic 404. It used the real Theorem server and IDE host with a disposable account and scripted model. The layout save and stale revision were real server responses. A separate Herdr probe kept the same live session, PID, and scrollback through Full, Right, Bottom, Close, and reopen. Run `node scripts/e2e/composer-workspace.mjs` against the stack configured in that script. The native App host still emitted its WebView ready message, and the terminal story rendered on demand in the release build.

`bun run test:composer` passed 1,034 tests. The Rust dock and workbench-core suites passed 479 tests, and the native terminal library passed 235. The terminal WebAssembly and local release build succeeded. The Firefox run surfaced fixture 404s for optional dictation, connection, artifact library, project context, and review routes. The separate AC-32 full browser reload check remains open. The baseline reattached the same process but did not show the earlier output on its first check. The modified development build did not rebind the saved pane during that check, and the release-build rerun stopped while discovering the workspace. The placement and close/reopen probe verified continuity during the lifetime of a mounted workspace.

## Measurements

Local release builds on Firefox at 1440 × 900. JavaScript transfer comes from Resource Timing. Each timing is one cold or warm navigation, so it does not establish a latency distribution.

| Signed-out startup | Before | After |
| --- | ---: | ---: |
| Cold JavaScript transfer | 18,688,658 B | 7,816,776 B |
| JavaScript requests | 200 | 132 |
| Module preloads | 198 | 130 |
| Cold sign-in control visible | 1,088 ms | 877 ms |
| Warm sign-in control visible | 744 ms | 425 ms |

In a signed-in sample at the same viewport, cold JavaScript transfer to the chat fell from 22,388,035 to 18,502,542 bytes. JavaScript requests rose from 208 to 244. Timing was mixed across cold and warm loads.

The closed workspace made zero grid geometry reads in the 500 ms Firefox sample. The Chromium prose benchmark used 30 key presses per size. At 300,000 characters the synchronous handler p95 was 17.5 ms before and 17.9 ms after. Steady typing did not show a speedup at that size. The editor removes the redundant paused-edit serialization and skips the suggestion-caret conversion in code.

## Production status

The signed-out frontend request to `theorem.rs/api/workbench/v1/home` returned 401 problem JSON with `theorem_signed_out`. Its configured personal Fly authority returned an empty 404 for that route and a structured 401 for `/api/chat/v1/projects`. The active Fly release was v40. Backend source includes the layout route, and the local server returned the expected typed first-use 404 and accepted a revisioned save. The deployed backend commit and the authenticated production layout response remain unverified. Verify the deployed backend build and the authenticated layout route before closing production persistence.
