# Gate 0: terminal path inventory

Read-only inventory of the existing Herdr terminal integration. Nothing was run except `git`/`gh` reads, `hc --version`, and tar extraction of vendored SDK tarballs into the session scratchpad. No tests were executed, no server, core or terminal was started, no deployed host was called. Anything not verified is marked **unverified**.

Refs: backend repo `Travis-Gilbert/Theorem` read via `git show <ref>:<path>` after `git fetch origin` (fetched 2026-11-14; `origin/main` = `65efa3ad4f`). Backend paths below are relative to `apps/theorem-ide-host/` and cited as `file:line @ref`. Frontend paths are relative to the worktree (`feat/theo-workbench`, contains `2a479ca3`).

## 1. Backend baseline

**Result: the full Herdr terminal path is not on `origin/main`. It exists only on unmerged stacked branches.**

| Fact | Evidence |
|---|---|
| `origin/main` has no `src/terminal.rs`, no `src/herdr/`; the only terminal-related host sources are `src/pty.rs` and `src/vt_screen.rs` | `git ls-tree -r origin/main apps/theorem-ide-host/src` |
| `origin/main` Dockerfile and README contain no Herdr/`hc` text; `sdk-operations.json` on main lacks `terminal.kill` (present at the baseline, line 145) | `git show origin/main:...` |
| `origin/main` SDK `packages/theorem-sdk` is `0.6.0-alpha.1`; its `terminal.ts` has zero `backend`/`epoch`/`kill` matches | `git show origin/main:packages/theorem-sdk/...` |
| `3a4293c75afa918e1196554fb59f619473d8da41` is NOT an ancestor of `origin/main` | `git merge-base --is-ancestor` |
| `4ea31c116be6e09591cd831dea770d3d12017a7b` is NOT an ancestor of `origin/main` | same |
| Remote branches containing `3a4293c`: `feat/herdr-fault-matrix`, `feat/herdr-fly-supervision`, `feat/herdr-lifecycle`, `feat/herdr-live-adoption`, `feat/herdr-runtime-profile` | `git branch -r --contains` |
| Remote branches containing `4ea31c1` (merge of #1046): `feat/herdr-lifecycle` only | same |

Why merged PRs prove nothing about main: every PR in the stack merged into its stack base, not into main.

| PR | State | Base | Head | Merge commit |
|---|---|---|---|---|
| #1021 Herdr Core as a second terminal backend | OPEN, `CONFLICTING` with main | `main` | `feat/herdr-terminal-backend` `46a10e692b` | none |
| #1042 control leases | MERGED | `feat/herdr-terminal-backend` | `3440ade7d4` | `46a10e692b` |
| #1045 lifecycle | MERGED | `feat/herdr-control-leases` | `d8ff0c9a53` | `4d94065042` |
| #1046 live adoption | MERGED | `feat/herdr-lifecycle` | `3a4293c75a` | `4ea31c116b` |
| #1047 fault matrix | MERGED | `feat/herdr-live-adoption` | `3da9e8cb61` | `828ac52848` |
| #1048 fly supervision | MERGED | `feat/herdr-fault-matrix` | `32f3f2a110` | `3da9e8cb61` |
| #1049 runtime profile (tests, doc) | OPEN | `feat/herdr-fly-supervision` | `65cdeacdc7` | none |

Merge order means #1042 and #1045 landed into branches that were already merged onward, so the branch tips are not nested: `feat/herdr-terminal-backend` (`46a10e692b`) lacks #1045 to #1049; `feat/herdr-lifecycle` (`4ea31c116b`) lacks #1047/#1048/#1049; `feat/herdr-live-adoption` (`828ac52848`) contains the heads of #1042, #1045, #1046, #1047, #1048 but not #1049. Ancestry matrix (tip contains PR head): `828ac52848` yes to 1042/1045/1046/1047/1048, no to 1049. `65cdeacdc7` yes to 1042/1045/1046/1048/1049, no to 1047.

`gh pr list --search herdr`: no open PR carries the stack to main. #1021 is the only main-based Herdr PR; its head contains only #1042's work and it conflicts with main.

**Candidate baseline: `origin/feat/herdr-live-adoption` @ `828ac52848` (2026-11-12), 31 commits ahead and 323 behind `origin/main`. Not on main.** It is the newest ref containing every merged piece (the since-removed control lease, lifecycle, live adoption, fault matrix, Fly supervision). `origin/feat/herdr-runtime-profile` @ `65cdeacdc7` differs by one test file and one record only (`git diff --stat`: `tests/herdr_backend.rs`, `docs/records/2026-11-10-unified-agent-workspaces-g0-g1.md`; source identical in `src/`), but lacks #1047's merge. Everything below is read from `828ac52848` unless stated.

Blob identity for the spec's sources: `terminal.rs` blob is `51db90d94c` at `3a4293c` and `4ea31c1`, but `b3e14d3862` at `828ac52848`. So the spec's S04 (`3a4293c`) predates program-generation work (commits `0250b25349`, `b83ef84f49`). `vt_screen.rs` blob `ad53101ea9` is identical at all refs including S05.

## 2. Host terminal contract at `828ac52848`

### 2.1 Wire operations

Dispatch `session.rs:570-581`. HTTP: `POST /api/environment/v1/workspaces/:id/operations/:operation`; live: `GET .../workspaces/:id/live` (SSE) `http.rs:327-331, 455-487`. Listed operations: `terminal.{open,input,resize,attach,copy,paste,search,kill,close}` (`rustyredcore_THG/crates/theorem-ide-runtime/src/sdk-operations.json:138-146`). There is **no** `terminal.list`, `terminal.adopt` or `terminal.detach` operation: detach is `terminal.close`; adoption is automatic inside the host (section 2.7).

| Operation | Request fields | Reply fields | Source |
|---|---|---|---|
| `terminal.open` | `backend` (`native` default, `herdr`), `cols`, `rows` (default 80x24), `argv` (string[], Herdr only; absent = machine shell), `name`. No `cwd`, `env`, `program`, `labels` accepted: cwd = workspace checkout, env fixed (`TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=theorem`), labels host-set (`theorem.workspace`, `theorem.tenant`) | `session` (`pty-<uuid>` or `hc-<uuid>`), `cols`, `rows`, `backend`, `binding {backend, epoch, core_id, terminal, program}`, `process_owned_by` (`host` or `herdr-core`) | `session.rs:693-755`, `terminal.rs:226-257` |
| `terminal.attach` | `session`, `from_offset`, `attachment` | `session, attached, attachment, resync, backend, epoch, binding, screen (plain), formatted (escape-coded), transcript, links, offset_start, offset_end, data (base64), truncated` | `session.rs:814-865` |
| `terminal.input` | `session`, `bytes` (string), `kind` (`human`/`reply`), `input_id`, claim `epoch` | `session, accepted, duplicate, discarded` | `session.rs:757-799` |
| `terminal.resize` | `session`, `cols`, `rows`, claim `epoch` | `session, cols, rows` | `session.rs:802-812` |
| `terminal.paste` | `session`, `text` (or `bytes`), claim `epoch`; wraps bracketed paste when the grid enabled it | `session, accepted` | `session.rs:927-938`, `vt_screen.rs:83-92` |
| `terminal.copy` / `terminal.search` | cell range / `query` | `text` / `hits[{row,col,text}]` (first hit per line only) | `session.rs:890-948`, `vt_screen.rs:96-111` |
| `terminal.close` | `session`, `attachment` | `attachment_closed, process_killed:false, session_live` | `session.rs:950-961` |
| `terminal.kill` | `session` | `process_killed, backend, session_live` | `session.rs:876-888`, `terminal.rs:1761-` |
| capabilities | `GET .../workspaces/:id/capabilities` | includes `backends.{native,herdr}.{ready, generation, version, core_id, session, binary, binary_present, reason}` | record `docs/records/2026-11-10-unified-agent-workspaces-g0-g1.md:210-233` |

Errors: unknown session 404 `terminal_session_not_found`; unavailable backend 503 `terminal_backend_unavailable` `{backend, cause}` (never falls back to native, `terminal.rs:312-322`); stale-epoch refusal 409 `terminal_control_refused` with `reason: stale_epoch`; zero size 409 `host_operation_failed` text `invalid pty size WxH`.

### 2.2 The three version concepts

| Concept (herdr-integration.md section 2) | Field(s) | Where carried | Source |
|---|---|---|---|
| 1. Host/live-stream epoch | `LiveLog.epoch` (hex nanos at workspace open); cursor `{epoch}:{seq}`; SSE `hello.epoch`, `resync{reason: epoch_changed, epoch, cursor}`; resumed via `Last-Event-ID` | live stream only; not on terminal replies | `live.rs:47-51, 125-150`, `http.rs:497-523` |
| 2. Terminal binding epoch | `binding.epoch` / `epoch`; `INITIAL_EPOCH=1`; +1 on every rebind and on each host-life adoption (continues from core label `theorem.epoch`) | `open`/`attach` replies, `terminal.opened/output/resized/exited` events, claim `epoch` on input/paste/resize | `terminal.rs:76, 226-257, 982-1017, 1307-1312`, `client.rs:55` |
| 3. Process incarnation / origin | `binding.program` (generation, 1 = original, +1 when a different process takes its place); event `origin`; process identity `<pid>@<start-seconds>` kept in core label `theorem.process` | `binding`, `terminal.opened {session, epoch, program, backend, origin, cols, rows}` | `terminal.rs:148-162, 263-299, 1050-1066`, `client.rs:60-117` |

Process-origin vocabulary: `launched`, `adopted`, `replacement`, `reattached` (`terminal.rs:148-174`). Replacement vs surviving decided by process id + start time; same process = same program (`Prior::continued`, `terminal.rs:289-299`; `rebind`, `terminal.rs:982-1017`).

### 2.3 Byte log, reset and resnapshot

| Item | Behavior | Source |
|---|---|---|
| Byte log | per terminal, absolute offsets, `OUTPUT_RETAINED` = 1 MiB; excess drained from the front; `start` advances | `terminal.rs:71, 621-650` |
| Ordering invariant | screen update, byte-log append, `terminal.output` event all under the screen lock | `terminal.rs:944-960` |
| Catch-up | `attach` with `from_offset`; `truncated: true` when `from < log.start`; bytes `offset_start..offset_end` plus `formatted` repaint taken at `offset_end` in one lock | `terminal.rs:1596-1616`, `session.rs:826-864` |
| Reset on rebind | no dedicated reset frame. `rebind` increments epoch, clears the log (`reset()` to offset 0), replaces the screen with an empty one of the same size, clears the input ledger, then publishes `terminal.opened` with the new epoch before any new-epoch output. The client must notice the epoch change (live event or attach reply) and re-attach for the authoritative repaint | `terminal.rs:982-1017` |
| Host-life reset | a new `LiveLog.epoch` makes old cursors resync with `epoch_changed`; ring is 8192 events / 16 MiB | `live.rs:17-18, 140-141` |
| Lag reset | cursor older than retained window gives `cursor_expired`; client re-reads state | `live.rs:146-148, 157-163` |
| Core stream | credit returned only after the sink consumed the DATA; frame payload max 16 MiB | `client.rs:1598-1601`, `codec.rs:20-25` |

### 2.4 Input ledger / dedup

`InputLedger`: per record, `INPUTS_REMEMBERED` = 256 `input_id`s, FIFO eviction (`terminal.rs:73, 734-773`). Lock held across the backend write, so concurrent same-id sends write once; an id is remembered only after a successful write, so failed or discarded sends stay retryable; the ledger is consulted before the epoch check (an input written before a rebind and retried after is acknowledged `duplicate`, not refused); cleared on rebind (`terminal.rs:984`). Dedup window = last 256 ids of the current binding epoch. `Idempotency-Key` HTTP header is a separate gateway concern (**unverified** what the gateway does with it).

### 2.5 Input and resize from any view

Exclusive control (the control lease, with controller and observer roles, takeover and a lease generation) was removed by the owner on 2026-11-16, because one person's several views of a terminal must never lock each other out: a stale attachment left by a reloaded page held the lease and locked the live page out. The baseline inspected above still carried it; its host code and tests for it are not a requirement.

| Rule | Behavior |
|---|---|
| Who may write | any attachment of a terminal may type, paste and resize; there are no roles, no takeover and no lease generation |
| Resize | the latest resize from any view sets the program grid |
| Refusal | input, paste or resize carrying a binding epoch the host has since replaced is refused `stale_epoch`; the view re-attaches and repaints |
| Query replies | Herdr Core answers terminal queries itself, so client replies (`kind: reply`) are discarded on Herdr terminals (`accepted:false, discarded:true`, not an error); on a native PTY only the view that last typed or resized answers |
| Herdr viewer | host is the core's one viewer (`observe:false` in `attach_params`, `client.rs:1298-1300`); browser views are multiplexed by the host, not by Herdr |
| Scope | application-layer only; a same-account `hc` user is outside it (record section 3, `g0g1.md:59-85`) |

### 2.6 `vt_screen.rs` (what the browser interpreter must match)

`vt100 = "0.16.2"` (`Cargo.toml`, `Cargo.lock` same). `TerminalScreen` wraps `vt100::Parser::new(rows, cols, SCROLLBACK=2000)` plus a 64 KiB raw byte ring (`vt_screen.rs:11-45`). Reset payload `formatted` = `Screen::contents_formatted()` (escape-coded visible grid only) (`vt_screen.rs:58-62`); attach also returns plain `screen`, and `transcript` (last 64 KiB raw bytes, lossy UTF-8) used for OSC-8/link detection (`session.rs:838-846`). Resize keeps scrollback (`vt_screen.rs:47-50`). Search covers scrollback+screen, first hit per row, byte-column not cell-column (`vt_screen.rs:96-111`). `formatted` carries no scrollback and, as read, does not carry input-mode state beyond what `contents_formatted` emits (**unverified** against vt100 docs). The file has no SPDX header. wasm32 compilation of this file or of `vt100` is **unverified**.

### 2.7 Live adoption and events

Events on the SSE log: `terminal.opened`, `terminal.output {session, epoch, offset, data b64}`, `terminal.resized`, `terminal.exited {session, epoch, exit_code, signal, reason}` (reasons `exited|killed|lost` or the core's word) (`terminal.rs:108-116, 951-959, 1011-1014, 1035-1044, 1642-1650`). Adoption: one `events.subscribe {labels}` per workspace gives snapshot plus events; `Created`/`Relabeled` adopt as `adopted`, `Restarted` as `replacement`, `Listed` after reconnect/missed (`client.rs:380-448`, `session.rs:111-163, 212-249`). Adoption gate `adoptable` (`terminal.rs:1478-1485`): live, no pending restart, no live record, not launched by this registry (unless replacement), address not already streamed. Minted `hc-<uuid>` ids and `theorem.epoch/program/process` written back to core labels (`terminal.rs:1295-1333`). `AdoptionFence` stops adoption on close/restart (`session.rs:251-282`).

## 3. Herdr Core version and protocol

| Item | Value | Source |
|---|---|---|
| Core pin | `herdr-core` 0.1.17, commit `ce87721557176f6cddaac1c7aefbf76929923263` | `codec.rs:3`, `client.rs:3`, record `g0g1.md:37` |
| Protocol generation | `GENERATION = 1`; handshake `hello {generation:1, framed:true}`; required features `framed`, `attach` | `client.rs:50, 143` |
| Frame format | `[channel u32 LE][kind u8][len u32 LE][payload]`, payload max 16 MiB; kinds DATA 0, CREDIT 1, CLOSE 2, RESIZE 3, FOCUS 4, FACTS 5; channel 0 = JSON-RPC; unknown kinds tolerated | `codec.rs:1-38` |
| How the host reaches the core | spawns `hc connect [--session <name>]` as a child, stdio pipes (not a socket path the host opens); plain-mode hello line then framed | `client.rs:1302-1315, 1321-1339` |
| Enablement | opt-in: `THEOREM_HERDR_HC` (binary) and/or `THEOREM_HERDR_SESSION` (dedicated session); neither set = no Herdr backend | `client.rs:606-654`, `README.md:217-228` |
| Image pin | Dockerfile downloads 0.1.17 with checksum, asserts `hc --version` = `hc 0.1.17` | `Dockerfile:16-39` |
| Local binary | `~/.local/bin/hc` -> symlink to `herdr-core`; `hc --version` prints `hc 0.1.17` (matches the host pin). No other `hc` subcommand run | local |
| Schema digest | not recorded in source; spec S15 asks Gate 0 to record it. **unverified** (upstream `schema/hc.openrpc.json` not fetched) | |

## 4. SDK surface (`@theoremharness/sdk`)

Pins in the frontend: web app `vendor/theoremharness-sdk-0.6.0-alpha.5.tgz` (`package.json:120`, patched by `patches/@theoremharness%2Fsdk@vendor%2F...alpha.5.tgz.patch`, chat-only: no terminal hunks); Theia extension `vendor/theoremharness-sdk-0.6.0-alpha.3.tgz` (`ide/theia-extensions/theorem-workspace/package.json:26`, patched by `ide/patches/@theoremharness%2Fsdk@..%2F..%2F..%2Fvendor%2F...alpha.3.tgz.patch`, which adds terminal exit reasons). Unpacked to `/private/tmp` scratchpad; nothing run. `TerminalChannel` implementation is byte-identical between alpha.3 and alpha.5 (dist/index.js 48855-48980 vs 37591-37716); `terminal.d.ts` identical.

| Capability | Vendored alpha.3/alpha.5 | Backend source at baseline (`packages/theorem-sdk`, version `0.6.0-alpha.7`) |
|---|---|---|
| `TerminalChannel.open({client, live, workspaceId, csrfToken, cols, rows})` | sends only `{cols, rows}` (`index.js:37623`) | adds `backend`, `argv`, `name`, `role` (`src/terminal.ts:239-258`) |
| `reconnect({session})` | yes | yes, with optional binding |
| `onData`, `onExit(code)`, `hasExited` | yes | adds exit reason and signal |
| `onReset(screen: string)` | fired only when an attach reply says `truncated`; passes `reply.formatted` (`index.js:37698-37701`) | fired on epoch change too |
| Epoch tracking | none: ignores `epoch` on replies and `terminal.opened` events; after a core-side rebind new-epoch output at low offsets is dropped as already seen (`output()` returns when `end <= offset`, `index.js:37705-37707`) (derived by reading, **not tested**) | tracks `bindingEpoch`, drops stale-epoch frames, resets to repaint |
| Program generation / origin | none | `program` getter |
| Epoch claim on input/paste/resize, `reply()` | none; `input` sends `{session, bytes, input_id}` | present (`src/terminal.ts:27-50, 286-318`); its lease calls (`takeControl`, `observe`, `onControl`) go with the lease |
| `kill()` | none (and generated client has no `kill` request type; baseline adds `KillTerminalRequest.ts`) | present (`terminal.ts:374-`) |
| Exit reason (`exited`/`lost`) | alpha.5: none. alpha.3: via the Theia patch only (`finish(code, reason)`, 404 `terminal_session_not_found` becomes `lost`) | `TerminalExitReason` |
| Generated `client.ide.terminal.*` | `open/input/resize/attach/copy/paste/search/close`; `open` and `resize`/`close` bodies are `Record<string, unknown>` so any host field passes; `input`/`attach` are flat typed (`session, bytes, input_id` / `session, from_offset`) and spread unknown properties at runtime (`__input`, `index.js:25086-`) | adds kill and lease fields |
| Published/adopted status of alpha.6/alpha.7 | frontend vendors alpha.3 and alpha.5 only. Whether alpha.7 is published to a registry: **unverified** (no registry call made) | main's SDK is alpha.1 |

**Host fields the vendored SDK cannot express (typed or via `TerminalChannel`):**
- Launch: `backend`, `argv`, `name` (only reachable by hand-built `operate`/`client.fetch`, as Theia does, or by passing `body` to the generated `open`).
- Attach: `attachment`, `role`; reading `control`, `binding`, `epoch`, `backend`, `formatted` as typed fields.
- Writes: claim `epoch`; `kind: 'reply'`; reading `duplicate`/`discarded`.
- `terminal.kill`.
- Events: `terminal.opened` (`origin`, `program`, `epoch`), `terminal.resized`, `terminal.exited` `reason`/`signal`.
- Capabilities: `GET .../capabilities` (`backends.herdr.ready`) has no SDK method; Theia fetches it directly.

## 5. Current frontend consumers

### 5.1 Files

| File | Lines | SPDX / header |
|---|---|---|
| `ide/theia-extensions/theorem-workspace/src/browser/terminal-profile.ts` | 72 | `// SOURCING: none` then `Copyright (C) 2026 Theorem UI contributors.` `SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0` (lines 1-8). Blob `ffee53c225` (matches S02) |
| `.../theorem-terminal.ts` | 301 | Same SPDX (line 8); SOURCING names `@theia/terminal` TerminalWidgetImpl/TerminalFrontendContribution reused whole. Blob `f2eeb726b6` (matches S03) |
| `.../terminal-profile.test.ts` | 51 | no header (bun test) |
| `src/components/terminal/*` | 15 files, 4257 lines | no PTY (section 5.3) |

### 5.2 Theia-independent logic vs Theia glue

| Logic | Where | Theia-free? | Rebindable as-is? |
|---|---|---|---|
| Profile table: Shell (native), Herdr shell, Claude Code (Herdr) `argv ['claude']`, Codex (Herdr) `argv ['codex']`; default `Shell` | `terminal-profile.ts:28-35` | yes | yes |
| `herdrReady(capabilities)`: true only for `backends.herdr.ready === true`; missing backends = not ready (no native fallback) | `terminal-profile.ts:42-45` | yes | yes (matches R25) |
| `partitionProfiles`, `profileById` | `:48-56` | yes | yes |
| `openBody(profile, cols, rows)`: native sends `{cols, rows}` only; Herdr adds `backend` and optional `argv` copy | `:62-72` | yes | yes |
| `terminal.open` via `connection.operate('terminal.open', openBody(...))` (SDK gap workaround) then `TerminalChannel.reconnect` | `theorem-terminal.ts:47-69` | partly: `connection.operate` is `TheoremConnection` (`theorem-connection.ts:149-166`, plain `client.fetch` POST to `.../operations/<name>`) | the operate/offers/capabilities helpers are Theia-free in substance; they sit in a Theia-bound class |
| Session identity restore: `storeState` adds `theoremSession`, `restoreState` reads it, start reconnects instead of opening | `:200-208, 52` | logic yes; hooks are Theia `storeState/restoreState` | rebind needs a new persistence owner (spec: account layout owner) |
| Detach vs kill: `dispose()` calls `channel.close()` (detach only); `endProcess()` is a separate `terminal.kill`, gated on `offers('terminal.kill')` | `:210-228` | logic yes | yes |
| Rebind on host epoch change: `live.onResync` with `reason === 'epoch_changed'` makes a new `TerminalChannel.reconnect` for the same session, `term.reset()`, attach | `:81-100` (Herdr profiles only) | logic yes | yes, but only covers host-life epoch (concept 1). It does not observe `terminal.opened` binding epochs, so an in-life core reconnect is unhandled (derived by reading, **not tested**) |
| Reset handling: `onReset(screen)` -> `term.reset(); write(screen)` | `:123-126` | needs a VT surface | adapter only |
| Lost-shell handling: `exit reason 'lost'` prints a notice, Enter opens a replacement shell via `TerminalChannel.open` (native-shaped open, drops the profile's backend/argv: `:156`) | `:127-172` | logic yes | reason only exists with the Theia alpha.3 patch; replacement ignores the profile (defect to avoid) |
| Input forwarding with device-status filtering (`deviceStatusCodes`) | `:117` | uses xterm/Theia field | Theia glue |
| Widget, menus, command registration, profile registry, `TerminalWidgetImpl`, inversify | `:11-49, 229-301` | no | Theia renderer glue, not reusable |
| Not implemented in any consumer | | | epoch claims on input, `terminal.opened` origin handling, adopted-terminal discovery UI, `kill` confirmation semantics beyond one command |

### 5.3 `src/components/terminal/*`

It is the agent transcript drawer, not a PTY client. `side-terminal.tsx` / `terminal-drawer.tsx` mount `TerminalScreen`/`TerminalAgent` from `terminal-screen.tsx`, whose SOURCING line says Ratzilla draws the terminal and tab bar and "assistant-ui useLocalRuntime runs each session's turns through the same Theorem SDK adapter" (chat). `git grep` finds no `TerminalChannel`, `ide.terminal`, `terminal.attach`, `xterm` or `/live` use under `src/`. `terminal-theme.ts`, `terminal-roles.ts`, `terminal-transcript.ts`, `terminal-code.ts` are theming/transcript code. No real PTY is wired in the web app today.

## 6. Existing tests

### Backend (baseline `828ac52848`; not rerun)

| File | Tests (name: what it asserts) |
|---|---|
| `src/terminal.rs` unit | `input_composed_for_a_replaced_epoch_is_refused` (2222); `an_input_written_before_a_rebind_is_acknowledged_when_retried_after_it` (2247); `an_input_whose_write_failed_stays_retryable` (2354); `the_oldest_input_id_is_forgotten_past_the_bound` (2385); `a_rebind_to_the_same_process_continues_the_program_and_any_other_replaces_it` (2416); `a_program_is_continued_only_by_the_process_its_labels_recorded` (2481); `a_snapshot_after_a_reattach_names_the_new_epoch_and_none_of_the_old_bytes` (2593); `a_kill_the_core_never_received_keeps_the_terminal_live_and_unmarked` (2621); `an_exit_is_published_once_however_many_closes_arrive` (2664); `a_second_record_under_a_tracked_id_is_refused_and_the_first_kept` (2683); `only_a_running_terminal_this_registry_neither_started_nor_streams_is_adoptable` (2745); `a_terminal_a_restarted_workspace_reattached_survives_the_old_registry_letting_go` (2812); `detaching_a_client_does_not_kill_the_shell` (1920) |
| `src/vt_screen.rs` unit | erase, copy, bracketed paste, scrollback search, resize (lines 157-218). Not asserted: alternate screen, wide/combining glyphs, split escapes, scroll regions |
| `src/herdr/client.rs` unit | handshake, generation refusal, watch sequence filter (heartbeat, labels with/without record, `restarted`, repeated seq, `missed`), line split across frames, re-establish after reconnect (lines 2119-3000) |
| `tests/herdr_backend.rs` (real `hc`, `--run-ignored`) | `a_new_host_life_adopts_the_same_session_under_a_new_epoch` (1000); `a_terminal_another_client_starts_after_open_is_adopted_live` (1351); `a_terminal_relabeled_into_the_workspace_is_adopted_live` (1434); `a_kept_terminal_that_is_lost_is_adopted_again_as_its_replacement` (1487); `the_watch_is_renewed_after_a_core_restart` (1618); `a_restarted_or_closed_workspace_adopts_only_through_its_open_session` (1665); `a_core_restart_is_survived_and_the_terminal_keeps_running` (1739); `the_control_lease_decides_whose_size_and_keys_reach_a_core_terminal` (2294); `input_is_written_once_per_input_id_and_resize_reaches_the_core` (866); `detaching_keeps_the_core_process_alive_and_killing_ends_it` (943); `a_program_exit_is_reported_with_its_reason` (1820); `a_terminal_that_finished_before_the_host_attached_...` (1960); `a_core_unreachable_past_the_backoff_is_reattached_when_it_returns` (2504); `a_lost_holder_ends_an_unkept_terminal_and_replaces_a_kept_one` (2750); `an_update_during_a_live_stream_reattaches_the_same_program` (2819); `a_kept_terminal_replaced_while_no_host_watched_is_adopted_as_a_new_program` (2937); `a_cold_restore_adopts_a_kept_terminal_only_once_its_new_shell_starts` (2983); `a_cold_restart_under_a_running_host_ends_each_program_and_replaces_the_kept_one` (3044); `a_crash_of_the_whole_core_under_a_running_host_...` (3141); `a_launched_program_replaced_while_no_host_watched_is_a_new_program_to_the_next_life` (3276); `adoption_is_label_scoped_and_never_touches_a_foreign_terminal` (1119); `an_unavailable_backend_is_refused_and_starts_no_native_shell` (479); `terminal_kill_is_advertised_by_the_production_router` (634) |
| `tests/environment_http.rs` | `two_attachments_share_one_terminal` (297); `unknown_terminal_sessions_return_typed_not_found` (11) |
| `tests/restart_host.rs`, `live_session.rs` | host restart and live-cursor resume for documents; no terminal assertions found by grep |
| `packages/theorem-sdk/tests/terminal-channel.test.ts` | lost-session handling; ordered output with gap re-attach and truncation reset (177); `open forwards the backend request` (311); no-epoch host behaves as one log (377); re-adopted terminal resets to new epoch repaint (421); stale-epoch event dropped (519, 585, 628); `kill` once (659); backend exit reason (736); program generation (792) |
| `packages/theorem-sdk/tests/terminal-control.test.ts` | epoch-stale keys refused (422); legacy client sends nothing new (390); reply routing (369). The lease tests in this file (takeover, catch-up never moves the lease, retake rules) are retired with the lease |

### Frontend

Only `terminal-profile.test.ts` (51 lines): native body is size only; Herdr shell names backend; agent profiles send argv; body does not alias the profile table; `herdrReady` truth table (missing backends = false); native listed apart from Herdr; ids unique and default exists. There is **no** test of `theorem-terminal.ts` (rebind, reset, detach/kill, restore). No test covers leases, adoption or epochs in the frontend repo. The spec's `docs/plans/theo-workbench` bundle aside, `git grep` finds no other terminal test.

## 7. PR #1046 residual cases, status at `828ac52848`

Source: `gh pr view 1046` body ("Not in this PR") and the Greptile review at head `3a4293c` (P1). Changes between `3a4293c` and the baseline in `src/session.rs`: 14 lines, only in `adopt()` (origin before `adoptable`); `src/herdr/client.rs`: +367 lines (program generation/fault work).

| Case | Status | Evidence |
|---|---|---|
| Opening drains an unbounded live queue (review P1) | **Still present** | `session.rs:136-144`: `while let Ok(..) = notices.try_recv()` over the same channel the stream thread keeps filling; the `LiveAdoption` thread starts only after the loop (`:146-155`). No snapshot boundary. Deterministic test absent (**not run**) |
| Initially unavailable core | **Still present** | `session.rs:118-120`: `let Ok(client) = self.link.client() else { return 0; }` (no watch, no retry). `HerdrLink::client` may later succeed on a request, but the adoption subscription is never created for this open |
| Closed subscription | **Still present** | `client.rs:1615-1622`: CLOSE on the watch channel sets `channel = None` and waits for the next reconnect |
| Missing subscribe response (reply never arrives while connected) | **Still present** | `client.rs:888-919`: timeout/lost returns `Ok(watching)` "established at the next reconnect" (doc comment `:886-887`) |
| Unavailable reattach (`unavailable` on re-attach loses its later `restarted`) | **Appears fixed in source; not run** | `client.rs:1936-1948`: parked terminal's attachment removed and `sink.closed` publishes the pending reason, so the record retires and the later `restarted` notice passes `adoptable` (`terminal.rs:1478-1485`). Tests `a_cold_restore_adopts_a_kept_terminal_only_once_its_new_shell_starts` (2983) and `a_cold_restart_under_a_running_host_...` (3044). Landed via #1047 (`0250b25349`) |
| Relabel-out (terminal relabeled out of view not released) | **Still present** | `client.rs:431-444`: `labels` event without a `record` yields nothing; no code path releases a record whose labels no longer match |
| Failed persistence of minted identity | **Still present** | `terminal.rs:1322-1331`: `let _ = client.label(...)`; comment at `:1325-1326` says a failed minted id is minted afresh next life |
| Fence window between host route check and session drop (PR's L4 gap) | **Undetermined**; no test found for it | PR body "L4 passed, real gap" |

Related spec obligation (R30): "Opening adoption MUST end at the opening snapshot boundary" is not met by the baseline.

## 8. Deployment reality (source and docs only; no host called)

| Question | Answer | Source |
|---|---|---|
| Branch the deployed host is documented as built from | none named. Both recipes build `git archive HEAD` of whatever checkout runs the command | `README.md:19-25` (Fly), `:64-72` (Sprite) @`828ac52848`; same text on main |
| Does `origin/main` contain the Herdr path | no (section 1) | |
| Is the Herdr-capable image documented as deployed | no. Record: "the image has not been deployed to Fly, so `backends.herdr.ready` has not been observed there" and "not done here: deploying the image that ships `hc`". README: Herdr bullets "measured on 2026-11-12 ... under podman ... not yet observed on Fly"; Sprite bullet "Not rerun on this Sprite" | `docs/records/2026-11-10-unified-agent-workspaces-g0-g1.md:1194-1197, 1235-1236`; `README.md:50-55, 106-108` |
| Which host the store points at | main carries two binding files: `infra/fly/personal-core/store/environment-hosts.json` (Fly `travis-theorem-ide-host.fly.dev`) and `environment-hosts.sprite.json` (Sprite `travis-theorem-ide-host-bthwy.sprites.app`); which one the live store mounts is not decidable from source. Owner memory notes the store pointed at the Sprite from 2026-11-09 19:49 UTC; that is **unverified** here, and the binary revision running there is **unverified** | main `infra/fly/personal-core/store/` |
| CI | `.github/workflows/sdk-contract.yml` triggers on `apps/theorem-ide-host/**`; no host deploy workflow found in `.github` | `git grep` on `origin/main` |

Conclusion from source: nothing documents a deployed host built from a branch containing the Herdr path. Gate 0 cannot treat Herdr as deployed; confirming needs `describe_capabilities` readout from the real environment host (not done).

## 9. Gap table

| # | Need (herdr-integration.md / requirement) | Present where | Missing where | Repo that must change |
|---|---|---|---|---|
| 1 | Herdr path reachable from main and a deployed host (R24, AC-02) | `feat/herdr-live-adoption` `828ac52848` | not on `origin/main`; #1021 conflicting and covers only #1042's content; no PR carries the tip; deployment of the image unobserved | backend (land stack as one PR onto main; deploy) |
| 2 | Typed launch: `backend`, `argv`, `name` (R25) | backend SDK source alpha.7 `terminal.ts:239-258`; Theia hand-built `operate('terminal.open')` | vendored alpha.3/alpha.5 `TerminalChannel.open` sends size only | SDK (publish alpha.7+), frontend (re-vendor or one typed adapter) |
| 3 | Truthful availability: `backends.herdr.ready` (R25) | host capabilities (record section 5); `herdrReady()` in `terminal-profile.ts:42-45` | no SDK method for `capabilities`; Theia fetches it directly | SDK or one frontend adapter |
| 4 | Binding epoch and reset on `terminal.opened`/attach epoch (R27) | host events and replies (section 2.2-2.3); backend SDK alpha.7 | vendored SDK ignores epoch and `terminal.opened`; Theia only rebinds on host `epoch_changed` | SDK/frontend; browser VT consumer must implement |
| 5 | Process origin / program generation surfaced (R27) | `terminal.opened.origin`, `binding.program` | no vendored SDK or frontend consumer reads them; Theia's `lost` notice relies on the alpha.3 patch only | SDK, frontend |
| 6 | Any view types and resizes; epoch claim; reply routing (R28) | host `terminal.rs`; backend SDK `terminal-control.test.ts` | vendored SDK has no epoch claim; no frontend consumer | SDK, frontend |
| 7 | Detach is not terminate; separate End process (R29) | host `terminal.close` vs `terminal.kill`; Theia `dispose` vs `endProcess` | vendored SDK/generated client has no `kill`; Theia uses `operate`; main host does not advertise `terminal.kill`. Interrupt and new-process operations are not host operations | backend (main), SDK, frontend |
| 8 | Bounded opening adoption (R30) | live adoption host code | `session.rs:136-144` unbounded drain; unavailable-core-at-open, closed subscription, missing subscribe reply, relabel-out, minted-id persistence still present | backend |
| 9 | Adoption visibility in the UI (AC-37 to AC-40) | host emits `terminal.opened origin adopted` | no `terminal.list` operation; no frontend consumer of adopted terminals; SDK ignores the event | backend (list op if needed), SDK, frontend |
| 10 | Real VT interpreter in browser (R26, AC-30/31) | host `vt100` 0.16.2 wrapper (`vt_screen.rs`); `formatted` repaint payload | no browser/WASM interpreter; wasm32 build of `vt100` **unverified**; `vt_screen` tests cover only erase/copy/paste/search/resize; `formatted` omits scrollback; no alt-screen, wide-char, split-escape tests; no SPDX in file | frontend/terminal crate; backend tests for parity |
| 11 | Input dedup window honesty (R47) | 256-id FIFO per binding, cleared on rebind (`terminal.rs:73, 984`) | vendored SDK sends fresh `input_id` per call and does not retry; no reconcile-or-show-uncertain logic; `Idempotency-Key` gateway behavior **unverified** | SDK, frontend |
| 12 | Core protocol pin and schema digest (R24) | 0.1.17 gen 1, framed JSON-RPC, `hc connect` child; local `hc` matches | schema digest not recorded; docs say pin was "behaviour verified against the installed binary" | backend (record digest) |
| 13 | Frontend tests for terminal behavior | `terminal-profile.test.ts` | no test of attach/reset/rebind/kill logic; logic is bound to a Theia widget | frontend |
| 14 | Persist session identity under account layout owner | Theia `storeState/restoreState` | no equivalent in the workbench; spec names the account layout owner | frontend |
| 15 | Replacement shell must keep profile | host (`terminal.open` with same body) | Theia `replaceLostShell` reopens with `TerminalChannel.open` (size only), dropping `backend`/`argv` (`theorem-terminal.ts:156`) | frontend (do not copy) |
| 16 | Execution trust boundary (R31) | host trust profile text; only `/api/environment/v1/...` forwarded | argv has no host-side allow list ("Launch trust profile" says no mediation); same-account `hc` peers outside the application layer | backend/deployment |

## 10. Candidate-baseline decision record

- Read terminal contract from `origin/feat/herdr-live-adoption` @ `828ac52848`; re-read when the stack moves.
- Spec sources S04/S06 cite `3a4293c`: valid for 1-260 of an older `terminal.rs` blob; the program-generation fields (`binding.program`, `origin`, `theorem.process` label) are post-`3a4293c`.
- Frontend SDK pin differs between the web app (alpha.5) and the Theia extension (alpha.3 plus a terminal patch); the workbench must choose one and drop the other patch dependency.
- Not verified: wasm32 build of `vt100`; alpha.6/alpha.7 registry publication; the running revision on any deployed host; `Idempotency-Key` handling in the gateway; schema digest of herdr-core 0.1.17; `hc` help text (not run).
