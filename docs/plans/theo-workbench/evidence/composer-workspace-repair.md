# Composer, workspace, and performance repair

November 21, 2026 · America/Detroit

Implemented the behavioral work from *Theorem Composer, Workspace, and Performance Repair Plan* on Theorem UI main at `610f4059`. The existing appearance supplies the controls, status, and focus indicators.

- Ordinary Enter sends through the existing form and active-run inbox. The editor handles IME, suggestion selection, Shift+Enter, and code editing before sending. The plus menu inserts an undoable code block. Clipboard code preserves its language and text through send and reopen.
- Full, Right, Bottom, Back to chat, and Close workspace operate on one mounted host. The rail follows the visible surface. The bottom drawer spans the sidebar and conversation and clears the measured composer. The right-side docking preference survives a temporary bottom placement. New inspector widths are bounded, and existing saved widths still load.
- The layout adapter distinguishes restore, save, device fallback, and first use. Account writes still use revision checks. A missing route remains an error. The status exposes bounded response metadata and a recovery action. A lost write remains uncertain. Its recovery action restores the confirmed account layout.
- The thread list returns metadata before bounded title recovery. One timer owns refresh for the visible conversation. Unchanged transcript revisions skip reconciliation, and changed histories use indexed message and run identities. The hidden workbench pauses drawing and geometry reads. Its core ticks on close and when an outstanding request finishes, so held edits can keep checkpointing while the workspace is closed. The chat shell, workspace, terminal story, and native App host load at their feature boundaries.

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

The initial signed-out frontend request to `theorem.rs/api/workbench/v1/home` returned 401 problem JSON with `theorem_signed_out`. Its configured personal Fly authority returned an empty 404 for that route and a structured 401 for `/api/chat/v1/projects`. The active Fly release was v40. The local server returned the expected typed first-use 404 and accepted a revisioned save.

## Fly layout and browser reload follow-up

The v40 image was built from Theorem `2421231c8f`. The private production store answered the layout request with `401 authentication_required`, while the public Fly ingress returned an empty 404. Theorem `d88d47d96c` adds GET and PUT for the workspace layout to the existing product relay, which passes the caller's authentication and request headers to the owning store.

Theorem UI `1fbbf432` keeps terminal view references in session storage scoped to the signed-in account, workspace, and browser tab. It recreates the views after the initial account layout response and uses the existing terminal attach operation. It retains the focused terminal and its maximized state. The snapshot holds session bindings and dock placement. The host supplies the terminal output on reattach. Commit `ada77b85` checks for account retirement before restoring a snapshot. Commit `bf0732d0` consumes restored snapshots so later workspace navigation cannot reopen a pane the person closed.

AC-32 passed against the local server and IDE host in Chromium for both Herdr 0.1.17 and a native shell. A full reload rebound the same session, replayed its earlier output, and accepted a new command in the same PID. The host terminal count stayed constant. The signed-in Firefox scenario passed initial layout load, save, reload and stale revision protection against the local backend. The focused TypeScript suites passed 255 tests. The broader checks hit the existing cross-tab store test failure and two process tests that also failed at the pre-fix revision. Full typecheck reported the existing mismatch between the IDE and app SDK versions. The local relay test build stopped when its pooled Cargo volume ran out of space.

Cloudflare published Worker `2e071e4f-f677-4624-9519-353a46a901c4` to `theorem.rs`. In the signed-in production `test` project, a disposable native shell reattached to the same terminal session after a full browser reload. The browser replayed the pre-reload output and printed PID 91 for both the before and after commands.

Fly updated the ingress machine to `sha256:ad96f6de5b1c2d346570454ac71988a1c360cf58020fe6a1c6059c9ef169abca`. The image reuses v40 and replaces its ingress binary with the build of `d88d47d96c`. The machine health check passed and `/healthz` returned 200. Direct signed-out GET and PUT requests both returned `401 authentication_required`. In the signed-in `test` project, Retry restore loaded the default layout, the account accepted `Production layout route check`, and a full browser reload listed that saved layout. The verification shell exited successfully after the terminal check.

The PR review reproduced a held-edit checkpoint lost while the workspace was hidden. The native workbench regression test failed before the visibility change and passed afterward. The terminal library passed all 236 tests with the change.

The dock component tests now exercise Bottom overlay and Right docking in the same mounted shell. A restored focused terminal applies its saved maximize state after the account layout loads. Layout requests from retired accounts can no longer update the status shown by the active workspace. Searching the chat sidebar matches recovered titles as soon as the rows display them.

The Composer contract's contrast check tabbed into the draft's code block, where Tab indents. It now uses Escape then Tab to leave the block and measures the same keyboard-focused Send button.

The custom-palette test also sampled the new canvas with the previous mode's text color during a mode switch. A browser trace reproduced the mismatch and showed that the intended colors had resolved by the next paint. The test waits for the mode to paint before checking the same contrast thresholds.
