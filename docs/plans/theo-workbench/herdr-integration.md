# Herdr integration — lifecycle and migration contract

**Part of:** [Theo Web Terminal Workbench 1.0](SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0.md)  
**Register:** Normative integration design. Existing-source observations are labeled; production verification remains outstanding.  
**Scope:** Web Theo, its SDK adapter, and the existing host-side terminal integration. Not the Herdr desktop app, Platinum, or a new native client.

## 1. Why Herdr changes the migration

The proposed workbench already needs terminal persistence, multiple viewers, external-agent profiles, reconnection, and operation identity. Herdr belongs to that execution layer. It does not compete with the ELY Markdown port. Separately, the original Herdr TUI has a Ratatui layout module selected as a source donor for the workbench. These two uses must not pull in the original runtime or its legacy transport. [S19]

There is concrete integration to preserve. The inspected Theorem-UI profile code names native Shell, Herdr shell, Claude Code (Herdr), and Codex (Herdr), and gates Herdr availability on host capabilities. The inspected Theorem terminal registry separates native and Herdr process mechanics behind one boundary, keeps binding epochs, and contains control-lease behavior. Theia's frontend is currently one consumer of that path. [S02–S04 in SOURCES.md]

Therefore **removing Theia must not remove Herdr discovery, attachment, or recovery**. Extract/rebind existing consumers; do not install another browser-facing Herdr supervisor or independently launch processes from widgets.

The source evidence contains different revisions: an older indexed/default-host path and the later Herdr PR head. A merged stacked PR is not evidence that a particular deployment or SDK package contains it. Gate 0 reconciles the exact checkout and published/deployed versions before implementation claims are made.

### Distinguish the three Herdr projects

- **herdr-core:** the execution/API provider already represented in Theorem’s terminal integration.
- **herdr (original TUI):** selected layout-code donor; its whole application is not a browser dependency.
- **herdr-app:** desktop reference only, not a release deliverable or source of required web lifecycle semantics.

The original TUI manifest includes Ratatui but also native PTY, Ghostty, OS and process dependencies. Extracting its small layout module is different from compiling the whole application for WASM. The current Core framed/JSON-RPC API is not the older Herdr/Remux binary protocol; matching product names or a “generation 1” label does not establish wire compatibility. Pin and test the actual protocol. [S19]

In particular, do not copy Herdr App’s documented pane-close-ends-terminal policy into Theo’s Close view action. The user’s modular workbench preserves work independently of placement. [S20]

## 2. Ownership and identities

| Concept | Owner |
|---|---|
| Project/session/task meaning, tool grants, accepted document revisions | Theorem |
| Backend binding, browser-facing stream/reset contract, authorized attachments/control | Existing Theorem terminal registry and SDK |
| Program, PTY, host-side Herdr terminal state and process survival | Herdr Core and its holder on the selected environment |
| Screen projection, copy/search, focus, terminal-pane layout | Browser workbench and its terminal interpreter |
| Account layout preferences | Existing Theorem account configuration owner |
| Local checkpoints/cache | Existing RustyRed/document persistence boundary |

Bind a process pane using the authenticated account/tenant scope, environment/workspace, Theorem terminal session identity, backend, and current binding epoch. Retain core identity/terminal address in the host adapter where needed. A title, array position, process executable, or bare `t7` is not sufficient identity.

Keep at least four independent version concepts:

1. Host/live-stream epoch: scopes host event sequence numbers and reconnect state.
2. Terminal binding epoch: scopes a byte log and its terminal screen.
3. Process incarnation/origin: distinguishes a surviving program from a replacement shell.
4. Control-lease generation: determines which attachment may write or resize.

None is the resource revision of an edited document. Do not combine them into one generic `version` field whose meaning changes by call site.

## 3. Route through the existing connection

Browser Ratatui state emits typed effects. The TypeScript/browser adapter calls the Theorem SDK. The authenticated Theorem gateway/host uses its existing terminal backend adapter to reach Herdr.

The current inspected frontend sometimes uses a typed host operation because the vendored TerminalChannel open helper omits backend/program fields. Repair the SDK once and publish/adopt a compatible version, or retain one documented typed adapter during migration. Do not scatter untyped fetches through tool-picker, dock, and terminal widgets. [S03]

A browser does not receive the core's raw socket, SSH credentials, deployment token, or unrestricted machine selector. A user-visible environment picker chooses only configured authorized environments. Unknown capabilities are unavailable, not permission to attempt the old fallback.

Profile policy for this release: preserve explicit native Shell and explicit persistent Herdr profiles. An account can select an available preferred profile. Migrated existing terminals retain their actual backend; changing the preferred profile does not convert them. Native behavior remains an explicitly different choice, not a hidden substitution when Herdr fails.

## 4. Connection and process states

Do not make one enum answer both “is my browser attached?” and “is the program alive?”

| Presentation event | Required interpretation |
|---|---|
| User hides or closes a pane | Release that view/attachment; do not terminate the program |
| Network disconnect | Outcome/connection becomes unknown or reconnecting; do not mark the program exited |
| Host reconnect, same binding | Resume from supported offset/cursor, or request authoritative reset |
| Binding epoch changes | Clear the old byte-log cursor/screen projection and attach to the current binding |
| Herdr reattachment to surviving process | Same continuing process, new attachment/binding as the contract says |
| Lost process replaced with a shell | New process incarnation; retain historical record and state clearly that original work did not resume |
| Explicit program exit | Show actual exit reason/code; output remains available under the retained-output contract |
| Explicit kill | End that process through the authorized kill action; do not kill the workspace or shared core |
| Host/machine shutdown | Report actual liveness and recovery; do not promise survival across hardware loss |

A normal pane cleanup must not call kill, workspace close, core stop, or rerun. Separate commands have separate labels: Close view, Interrupt, End process, and Restart/new process. Interruption is delivered only to the currently authorized bound program.

Herdr's keep/recovery option is not arbitrary job checkpointing. A replacement shell must not be reported as successful continuation of a build or agent task. Never rerun a possibly destructive command merely to restore a panel.

## 5. Stream correctness and bounded recovery

The browser's screen must correspond to an ordered byte stream within one binding epoch. Preserve byte boundaries until the decoder/parser owns them; UTF-8 and escape sequences may span transport messages.

A reset consists of a coherent screen state plus its stream boundary. Apply it before subsequent bytes. Discard bytes known to precede the installed boundary; reject mismatched epochs. Output growth cannot force unbounded memory or freeze other panels. Use the existing bounded-log/reset machinery rather than pretending that a partial old log is a full screen.

The current host already has a VT screen wrapper and bounded log; its comments describe screen/log/event ordering. Preserve that invariant in the new consumer. Extracting a parser for WASM must retain ordering, cursor, color, modes, and reset behavior—not just matching plain text. [S04–S05]

The actual terminal interpreter is a release gate. Test alternate-screen programs, cursor addressing, erase/insert/delete operations, scroll regions, wide/combining characters, split escape sequences, bracketed paste, resize, input mode, OSC-8 policy, and full repaint. Supported external-agent CLI versions must render and accept input correctly on real sessions. Do not advertise unsupported graphics, clipboard, keyboard, or query capabilities.

Automatic terminal query replies are tagged/handled according to the negotiated provider path; observers must not generate duplicate input. The browser must not treat a terminal query as a human command or let output take ownership of its surrounding workbench.

## 6. Control and multi-viewer semantics

Use the existing host's control-lease mechanism as the browser-facing authority. An observer may view, select/copy, and search locally. It cannot type, paste, resize the actual program, or answer input-generating queries as the controller.

A takeover increments the lease generation. Late input carrying the previous generation is refused. Resizing a hidden/observing panel changes its local viewport but not the actual PTY. The active controller's dimensions determine the program grid according to the agreed host contract.

Herdr's own active-viewer rule and Theorem's browser-client lease are distinct. The inspected host multiplexes browser clients through its core attachment. Preserve that design instead of allowing each browser to attach directly and compete for size control. [S04]

Input deduplication is bounded by the actual host ledger. Do not advertise universal exactly-once delivery. On uncertain input outcome, reconcile within the supported identity/ledger window or show uncertainty; never resend arbitrary bytes automatically after that window. Likewise, an uncertain launch is queried/reconciled before any second launch attempt.

## 7. Adoption and live discovery

Adopt only terminal records admitted to the authenticated workspace through the host's binding rules. Core labels can help discover a candidate; a mutable label alone does not authorize a user or agent to access it.

Initial discovery and subsequent updates need one coherent snapshot/stream boundary. Opening a workspace must finish after processing its fixed opening snapshot, even while another client keeps creating terminals. Later events are handled by the ongoing subscription. A list-then-watch gap cannot silently lose a program.

Reconnection takes the provider's new sequence epoch/snapshot. Missed-event recovery replaces the appropriate projection without duplicating records. Repeated created/rebound notices are idempotent by identity and generation. A terminal launched by this registry must not be announced a second time as a newly adopted session.

Changing labels out of scope, closing/restarting the workspace, or revoking access releases visibility/input and the relevant subscription; it does not necessarily kill the underlying process. A terminal discovered while a scope is closing cannot be rebound into a newly opened unrelated scope.

The inspected live-adoption PR explicitly lists residual cases: initially unavailable core, closed subscription, missing subscribe response, unavailable reattach, relabel-out, and failed persistence of minted identity. These are historical review obligations to recheck on the chosen baseline, not claims they remain bugs in today's deployment. Any case needed for the shipped web workflow must be fixed or explicitly fail with a recoverable, truthful state. Do not silently inherit a known gap. [S06]

## 8. Status and coordination

Keep process liveness, attachment connectivity, program-reported activity, Theorem task state, and approval state separate. A program can report activity through its supported status protocol. Absence of a report is unknown, not idle or working. A status string does not grant authority. [S15]

Theorem remains the owner of task assignment, permissions, project/session relationships, and results. Herdr process parenthood/lifecycle is not automatically a session fork, a project authority edge, or permission inheritance. Closing a parent *view* never ends its child processes. Explicitly ending a parent *process* follows the configured and disclosed provider lifecycle.

External coding agents receive existing authorized Theorem tools/context through their supported integration. Do not inject the entire project/account into a terminal or interpret arbitrary printed instructions as SDK commands. Launching a second worker requires an explicit authorized action, not a status transition.

## 9. Security and dependency boundary

Herdr's own documentation says it is not a sandbox or per-client permission broker. Its API and same-account processes have broad machine access. Theorem must preserve authenticated environment admission and appropriately scoped OS/container isolation. Workspace labels, templates, and UI-only tool flags do not enforce isolation against a process with shell authority. [S16]

Keep Herdr on the execution host. No raw-core public proxy, no browser-supplied arbitrary socket path, and no automatic machine install/update from layout restoration. A machine's trust and availability come from the existing environment connection owner. Host dependency updates are controlled deployment work.

Do not adopt Ghostty as Theo Web's renderer or compile it into the browser for this feature. Herdr Core's inspected repository vendors Ghostty; that remains a host-side dependency and must be disclosed in its build/provenance record. “No Ghostty frontend” does not mean “Herdr has no Ghostty dependency.” [S17]

An open web view cannot keep a sleeping laptop's process running. Remote execution stays on its chosen host. Cross-host migration/resumption is a separate capability and is not part of this release.

## 10. Required first real demonstration

On an isolated test environment with the final matched SDK/host/Herdr versions:

1. Start one uniquely identified process from Theo Web using an explicit Herdr profile.
2. Read output and type/paste through the actual input path.
3. Open an observer and demonstrate that it cannot resize/type until a deliberate takeover succeeds.
4. Close the original panel, refresh the browser, and reattach to the same continuing process.
5. Restart only the Theorem workspace host while keeping the Herdr provider running; observe the new binding epoch, authoritative repaint, and subsequent output.
6. Start an eligible terminal from another authorized client; verify one adopted record appears without blocking workspace opening.
7. Test process loss/replacement separately; never report it as the original command continuing.
8. Explicitly terminate the isolated test process and verify no unintended restart; clean up only resources created by this test.

These are production acceptance cases, not claims about tests run while authoring this document. Native-only profiles have their own disclosed host-lifetime behavior and must not be graded as Herdr persistence.


<!-- Evidence references -->
[S01]: SOURCES.md#s01
[S02]: SOURCES.md#s02
[S03]: SOURCES.md#s03
[S04]: SOURCES.md#s04
[S05]: SOURCES.md#s05
[S06]: SOURCES.md#s06
[S07]: SOURCES.md#s07
[S08]: SOURCES.md#s08
[S09]: SOURCES.md#s09
[S10]: SOURCES.md#s10
[S11]: SOURCES.md#s11
[S12]: SOURCES.md#s12
[S13]: SOURCES.md#s13
[S14]: SOURCES.md#s14
[S15]: SOURCES.md#s15
[S16]: SOURCES.md#s16
[S17]: SOURCES.md#s17
[S18]: SOURCES.md#s18

[S19]: SOURCES.md#s19
[S20]: SOURCES.md#s20
