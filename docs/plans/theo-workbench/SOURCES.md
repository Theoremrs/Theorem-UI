# Source evidence and limits

**Inspection date:** November 14, 2026. This is a source/documentation review, not a local machine inspection, build, live browser test, SDK publication check, or deployment acceptance.

## Evidence discipline

User decisions in the conversation govern product direction. Existing source establishes code/contracts at the named snapshot, not whether a deployed flow works. Upstream documentation establishes advertised behavior, not compatibility with Theorem's deployed binary. New requirements and suggested geometry are authored design choices, not claims recovered from these sources.

The inspected default/indexed Theorem snapshot and the newer Herdr PR snapshot differ. PR #1046 is reported merged **into its stacked base `feat/herdr-lifecycle`**; that alone does not establish presence on main or in deployment. Gate 0 must reconcile the chosen host, frontend, SDK, and Herdr release. Do not use this bundle's historical source observations to overwrite newer implementation work.

## User-supplied references

The tool-picker image was opened directly from the supplied file and copied unchanged to [visual-reference/codex-tool-picker.png](visual-reference/codex-tool-picker.png). It shows six labeled activity choices with shortcut hints. It is not source code, a whole-workbench mockup, or evidence of keyboard/runtime behavior.

The prior artifact cabinet bundle was reopened and included unchanged under [../artifact-cabinet/](../artifact-cabinet/README.md). Its product requirements remain in force; its HTML prototype and old test records are not evidence of this workbench's implementation. The parent ZIP's digest is recorded in bundle-provenance.json.

<a id="s01"></a>

## S01 — Existing Theia integration

[Theorem-UI ide/README.md at 2a479ca](https://github.com/Travis-Gilbert/Theorem-UI/blob/2a479ca30dcef39517b0f8fa149d3c5447bc18cf/ide/README.md). Git blob: `e2bd65b2318433d1015c5f49a38a49bb4f6fb322`.

Inspected lines 1–90. Documents the browser-only Theia surface and its bindings to SDK DocumentSession, TerminalChannel, language, diagnostics, SCM/history, search, run, and parent-frame integration. The migration must preserve the underlying capabilities while replacing their frontend consumers. The README itself names missing/dependent work; do not grade it as live proof.

<a id="s02"></a>

## S02 — Existing terminal profiles and readiness

[terminal-profile.ts at 2a479ca](https://github.com/Travis-Gilbert/Theorem-UI/blob/2a479ca30dcef39517b0f8fa149d3c5447bc18cf/ide/theia-extensions/theorem-workspace/src/browser/terminal-profile.ts). Git blob: `ffee53c225a0cdd27094f8585b11042ad8f2957e`.

Inspected file. Contains native/Herdr profiles, explicit argv for external agents, readiness gating, and terminal.open body construction. It carries its own SPDX declaration; do not assume it has Codex's license.

<a id="s03"></a>

## S03 — Existing terminal frontend consumer

[theorem-terminal.ts at 2a479ca](https://github.com/Travis-Gilbert/Theorem-UI/blob/2a479ca30dcef39517b0f8fa149d3c5447bc18cf/ide/theia-extensions/theorem-workspace/src/browser/theorem-terminal.ts). Git blob: `f2eeb726b658cd87c95d5593887c2ce5d0965c13`.

Inspected file. Uses TerminalChannel, distinguishes detach from explicit terminal.kill, restores session identity, handles resets, and rebinds Herdr on host epoch changes. It also documents a vendored SDK gap for backend/program launch fields. Reuse the semantics, not Theia's renderer. Its old consumer behavior is a migration baseline, not a complete new lease/adoption implementation.

<a id="s04"></a>

## S04 — Later host terminal registry

[terminal.rs at PR #1046 head 3a4293c](https://github.com/Travis-Gilbert/Theorem/blob/3a4293c75afa918e1196554fb59f619473d8da41/apps/theorem-ide-host/src/terminal.rs). Git blob: `51db90d94cc2c9187c5c21aadf3cad796665743c`.

Inspected lines 1–260. Establishes the existing two-backend registry, binding epoch, bounded byte log, process-origin vocabulary, input ledger, and the host's input-claim design (its control lease was removed by the owner on 2026-11-16). Native and Herdr backends have different process lifetimes. This source is newer than the indexed default-host pty.rs inspected separately.

<a id="s05"></a>

## S05 — Existing VT parser wrapper

[vt_screen.rs at 3a4293c](https://github.com/Travis-Gilbert/Theorem/blob/3a4293c75afa918e1196554fb59f619473d8da41/apps/theorem-ide-host/src/vt_screen.rs). Git blob: `ad53101ea94a20a852883468d78233f01714d032`.

Inspected lines 1–150. Uses vt100 for visible terminal state, formatted reset data, copy, scrollback, and bracketed paste. This makes it a reuse candidate, not proof of complete Codex/Claude terminal compatibility or wasm32 compilation. Unicode coordinate handling and feature coverage must be evaluated in the real consumer.

<a id="s06"></a>

## S06 — Herdr live-adoption change and review record

[Theorem PR #1046](https://github.com/Travis-Gilbert/Theorem/pull/1046). Head `3a4293c75afa918e1196554fb59f619473d8da41`; base `feat/herdr-lifecycle`; reported merge commit `4ea31c116be6e09591cd831dea770d3d12017a7b`.

Read PR metadata/body and changed filenames. It describes live events.subscribe adoption, terminal.opened origin, and reset/reconnect handling, reports tests against hc 0.1.17, and lists deferred cases. The review flags opening that drains an unbounded live queue instead of stopping at the opening snapshot. Tests reported in the PR were not rerun here; historical findings must be rechecked on the implementation baseline. Include relevant failures in the new acceptance matrix rather than assuming their current status.

<a id="s07"></a>

## S07 — RustyRed browser owner

[app-db.ts at 2a479ca](https://github.com/Travis-Gilbert/Theorem-UI/blob/2a479ca30dcef39517b0f8fa149d3c5447bc18cf/src/lib/blocks/app-db.ts). Git blob: `9414956b458836f1d3b91423aba48266311ebc4e`.

Inspected lines 1–85. Demonstrates the browser package, worker, shared access, OPFS-oriented owner, and app-specific no-history settings. Does not prove local-first document editing, replication, durable editor undo, or the user's latest implementation status. Integrate with the actual completed document/storage contract.

<a id="s08"></a>

## S08 — ELY Markdown donor

[ELY modes.rs](https://github.com/ELY-Open-Source/Ely-GPUI-Components/blob/main/crates/ely-documents/src/modes.rs). Observed blob `2e6bca2e7c297372c7c7374c0d0df313fcb26f86`; no full repository commit is asserted for this default-branch read.

Inspected lines 1–150. Defines Visual/Source/Split/Preview, GPUI state/input objects, and a commit path that drops a pending block edit when its document differs. The experience is selected by the user; that data-loss behavior is expressly excluded from the port. Pin the full donor commit before extraction.

<a id="s09"></a>

## S09 — ELY Changes donor

[ELYTerminal GitPanel at fbb536e](https://github.com/ELY-Open-Source/ELYTerminal/blob/fbb536ec8f6e1466fa8c736967671ebf99a34080/src/git/panel.rs). Git blob `26133bcffa1a2de18dcb50d169fb55b959be0369`.

Reopened lines 1–100; full implementation appeared in the preceding source review. The directly reopened portion establishes GPUI coupling, change groups, commit draft, amend, diff layout, recent-history intent, and serialized action state. Selection as presentation donor does not establish Theorem API parity or permit adoption of its direct process operations unchanged.

<a id="s10"></a>

## S10 — OpenIDEA selected reuse boundary

[ide-host at 6ae167e](https://github.com/l0ng-ai/openidea/blob/6ae167efc9ac0e9a0422ba8b4e7ecd97fdd05685/crates/ide-host/src/lib.rs) and [MarkdownEditor.tsx](https://github.com/l0ng-ai/openidea/blob/6ae167efc9ac0e9a0422ba8b4e7ecd97fdd05685/src/features/viewers/markdown/MarkdownEditor.tsx).

These source excerpts were inspected earlier in this conversation and remain visible in the supplied context: the host is UI-toolkit-independent, while the Markdown wrapper/preview is React/DOM-based. This spec chooses ELY Markdown and does not claim a newly extracted OpenIDEA component or prescribe an unexamined provider. Any OpenIDEA adoption reopens and pins its precise source before implementation; the donor record names the gap and ownership adapter.

<a id="s11"></a>

## S11 — Codex code and integration distinction

[Codex LICENSE](https://github.com/openai/codex/blob/main/LICENSE) was checked: Apache-2.0. [OpenAI app-server documentation](https://developers.openai.com/codex/app-server) was consulted to keep structured external-agent integrations distinct from using the TUI as a visual reference. No current desktop UI source availability is inferred from the CLI repository license.

The user authorizes suitable direct source reuse in the implementation direction. Record source revision, per-file notices, changes, dependency impact, and retained tests before importing. This bundle contains no extracted Codex implementation.

<a id="s12"></a>

## S12 — ELY license

[ELY component license](https://github.com/ELY-Open-Source/Ely-GPUI-Components/blob/main/LICENSE) was checked: MIT. This is a repository observation, not a blanket license assertion for every transitive dependency or bundled asset. Preserve actual notices at extraction time.

<a id="s13"></a>

## S13 — Ratatui application architecture

[The Elm Architecture in Ratatui](https://ratatui.rs/concepts/application-patterns/the-elm-architecture/). Supports model/update/view separation and expressly allows mutable Rust updates. The explicit asynchronous effect runner, bounded queues, resource-controller lifetimes, and version checks are this spec's application design, not guarantees supplied by the article.

<a id="s14"></a>

## S14 — Ratzilla presentation boundary

[Ratzilla documentation](https://docs.rs/ratzilla/latest/ratzilla/) describes Rust/WASM Ratatui-based web presentation. That alone does not provide a PTY, arbitrary process execution, a complete VT parser, accessible editing, or a headless document service. Those are separate responsibilities in this spec.

<a id="s15"></a>

## S15 — Herdr public interface

[Herdr Core README](https://github.com/herdrdev/herdr-core/blob/master/README.md), [product description](https://herdr.dev/core/), and [API documentation](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md) were opened.

The documentation describes a headless terminal runtime, an introspectable request API, attach streams, source-reported status, and snapshot/event recovery. The application-specific scope, identity, and UI requirements in the spec are not claims that Herdr alone implements Theorem's policy. These are moving upstream references; record the actually deployed hc version and schema digest at Gate 0. The prior Remux generation-one protocol is not assumed compatible.

<a id="s16"></a>

## S16 — Herdr trust and machine limits

[Security](https://github.com/herdrdev/herdr-core/blob/master/docs/security.md) and [Machines](https://github.com/herdrdev/herdr-core/blob/master/docs/machines.md) were opened. Core is not a sandbox/per-client permission broker; programs have the account's access. Remote execution belongs to the remote machine. These support the spec's prohibition on a raw public browser-to-core proxy and its distinction between attachment continuity and survival/migration across host loss.

<a id="s17"></a>

## S17 — Ghostty dependency boundary

[Herdr .gitmodules](https://github.com/herdrdev/herdr-core/blob/master/.gitmodules) contains vendor/ghostty; the README names Zig in its source build prerequisites. No Ghostty web frontend is adopted. The host-side dependency is acknowledged instead of claiming a Ghostty-free Herdr core.

<a id="s18"></a>

## S18 — Approved artifact cabinet work

The user-supplied `theorem-artifact-cabinet-spec-v1.0.zip` was reopened locally. Its feature spec, technical requirements, procedural-preview methodology, and approved sample assets are included unchanged. The approved HTML's hash is preserved; the new workbench is not represented by that HTML. The prior spec's own source/verification limits remain in its documentation.

<a id="s19"></a>

## S19 — Original Herdr TUI layout donor

[Herdr src/layout.rs at ee5bfb5](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/layout.rs). Git blob `aaa207ae38119e03fb20412759f8b38a6708038e`. Inspected lines 1–270. It defines `TileLayout`, split-tree nodes, rectangles, focus, split boundaries and pane insertion/removal. This is the selected starting source for layout mechanics, not proof of complete web dock support or standalone WASM compilation.

[Herdr manifest](https://github.com/herdrdev/herdr/blob/master/Cargo.toml) was opened: the application uses Ratatui alongside native/process and Ghostty-related dependencies. The whole application is not imported. Extract only the bounded layout behavior and tests, with adapted stable identities and no automatic spawn/kill coupling. Current Core protocol and original TUI transport must not be conflated.

<a id="s20"></a>

## S20 — Herdr desktop lifecycle contrast

[Herdr App README](https://github.com/herdrdev/herdr-app/blob/master/README.md) was opened through the repository page. It distinguishes closing the window from closing a pane/tab; the latter is documented as ending its terminals. Theo Web deliberately uses a different Close view contract: detach without termination. This is an explicit adaptation, not an assumption that all Herdr UI behavior can be copied.

## What has not been verified

No source was changed in the user's repositories. No local Desktop Commander connection was attempted in this turn. No provider credentials, running terminal, Git repository state, or process were changed. No Rust/WASM build, terminal protocol interoperability, browser accessibility, storage recovery, agent operation, or live end-to-end test was run for this workbench.

Bundle validation checks document/JSON consistency and file integrity only. Production acceptance starts with every new case marked `not_run`.
