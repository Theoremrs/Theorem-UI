# Theo Web Terminal Workbench — implementation handoff

**Scope:** the web-based Theo interface in Theorem-UI. Native Theo, Platinum, native docking and packaging, and mobile-native clients are later work. Host/service changes necessary to support the browser are in scope.

**Status:** specification and acceptance design, with a recorded verification pass at candidate build `a9e9dd8878563cf560fda5f12825a1ec6e00f1ae` (2026-11-17, Linux cloud runner). Of the 62 acceptance cases, 36 are recorded `pass` at the source, pure-test, property, simulated-fault, protocol-replay, story-fixture or design-oracle tier, and 26 remain `not_run` with a named blocker; none is recorded `fail`. No production implementation, deployment, live end-to-end journey or native build is claimed by this handoff, and a recorded pass at a lower tier does not satisfy a live-only case.

## What to read

1. [Main specification](SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0.md): product, UI, ownership, selected source reuse, migration and delivery gates.
2. [Herdr integration](herdr-integration.md): layout extraction, Core execution, identity, input from any view, detach, recovery, compatibility and safety.
3. [Technical requirements](technical-requirements.md): 48 individually identified obligations, each with an owner and acceptance references.
4. [Acceptance cases](acceptance-cases.json): 62 acceptance procedures with required observations, now carrying an execution record per case (build identity, platform, actual commands, tier, observations, limitations, or the named blocker). Each case names the tier its evidence belongs to; this file is still not an executable test suite, and it is not a passing report for the live-only cases.
5. [Theia migration parity register](migration-parity-register.json): existing user capabilities that must remain reachable after the old frontend is removed. Reconciled against the candidate build at the pure and simulated tiers: P03 and P04 are recorded `pass`, the other thirteen rows stay `not_run` with the blocker named. `current_consumer` is still the seed — the Theia path is mounted and was not traced as a running baseline here.
6. [Source ledger](SOURCES.md): inspected sources and their limitations. Start by reconciling them against the actual implementation checkout and deployed versions.

The [Codex tool-picker screenshot](visual-reference/codex-tool-picker.png) is supplied unchanged. The previous [Artifact Cabinet handoff](../artifact-cabinet/README.md), including its mockup and screenshots, also travels unchanged. Its visual reference applies to the cabinet, not to the full new workbench.

## Architecture in one paragraph

Replace Theo Web's interior with a modular Ratatui/Ratzilla workbench, retaining TanStack routing, authentication and outer application navigation. An Elm-style Rust update/effect core talks through the existing Theorem SDK and resource owners. Adapt the original Herdr TUI's Ratatui layout module for pane geometry, focus and resize; preserve Herdr Core as the host-side process provider already represented in Theorem's terminal path. Port ELY's Markdown interaction and initial Changes presentation, reuse suitable Codex presentation code with attribution, and use OpenIDEA implementations selectively beneath the existing capability contract. RustyRed's browser integration supports local capability and persistence without creating another document authority.

## Decisions that are not open implementation choices

- The release is **web-only**, not a native workbench project.
- Theia is retired after real parity, not retained as a permanent second IDE.
- Files, Theo, and tools are default placements in one customizable workspace; they are not fixed component identities.
- The tool picker has no process or data effects until an explicit action is chosen.
- ELY's Markdown experience is a Ratatui port, not a GPUI dependency hidden inside the web build.
- Closing a view detaches. Ending a process is a separate authorized operation.
- A core/host reconnect, a surviving process, and a replacement shell must remain distinguishable.
- Herdr's original TUI and Herdr Core do not imply wire-protocol compatibility. Pin the actual provider/schema.
- A pane move, theme change, or appearance replacement preserves the underlying draft, session, operation and permission scope.
- The agent composer and a raw shell have different input semantics. A message is never dispatched to both.
- The cabinet retains its approved pixel/full-fidelity defaults and original-open behavior. The terminal uses a coordinated theme contract, with no purple/gold preference.
- Yazi is not required. Do not remove unrelated existing integrations or user data as a side effect.

## Begin with Gate 0

Record the exact frontend, backend, SDK, RustyRed browser, Ratzilla/Ratatui and Herdr versions. The inspected Theorem default-branch snapshot and the inspected Herdr integration PR are not the same revision. A PR marked merged into a feature branch is not proof of main-branch inclusion, SDK publication or deployment.

Locate the existing web Theo route and actual capability owners before changing code. Do not guess a route, introduce a second registry, or build new process supervision because a frontend adapter lives under `ide/`.

Extract/adapt the useful Herdr layout code and tests, then prove it builds headlessly and for the browser target without the native TUI runtime. Stable account layout IDs must not be replaced by process-local numeric handles. This extraction is an implementation requirement, not an already-verified dependency.

Populate the parity register from the current mounted application and actual SDK, including direct routes, user actions, refusals and recovery. Test one real Herdr shell and one available supported external-agent profile before claiming the terminal path is ready.

## First complete proof

Open the real web workspace, edit a Markdown document, ask Theo to change it, inspect and correct the result, start a Herdr process on the chosen host, close/reopen its view, rearrange the tools, change theme, refresh, and continue with the same draft/document/process identity where the provider contract promises continuity. Then prove the correct behavior for lost/replaced processes and unavailable providers.

A dock screenshot, a Rust unit test, a browser fixture, or a statement that a crate compiled cannot alone establish that flow.

## Prompt for the implementing agent

> Implement SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0 for the web-based Theo interface only. Read START-HERE.md, the main specification, Herdr integration, technical requirements, and acceptance cases before editing. Reconcile the actual checkout and service/SDK versions at Gate 0. Reuse Herdr's Ratatui layout mechanics without importing its full runtime, preserve the existing Herdr Core terminal path through Theorem, port ELY Markdown and the chosen Changes presentation, and retain Theorem's document and capability owners. Deliver connected vertical slices and record evidence against each requirement. Retire Theia only after the new mounted web interface covers its required real workflows. Do not implement native Theo or Platinum, do not silently substitute fixtures for live acceptance, and do not claim process resumption when a fresh process was created.

## How to record completion

Use the 48 requirement IDs and 62 acceptance IDs as references. Record candidate build identities, actual commands, receipts, observations, screenshots where useful, result, and limitations. Preserve the distinction between source inspection, pure tests, simulated faults and live end-to-end evidence. An unavailable tool/provider is a named blocker, not a pass. Update status only after running the relevant case.

The companion cabinet bundle contains historical mockup evidence. It does not establish that the new workbench has passed any case. The included `handoff-validation.json` concerns this document package only, not production behavior.
