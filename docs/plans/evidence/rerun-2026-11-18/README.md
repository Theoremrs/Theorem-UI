# Rerun investigation (ALU study, step 3)

A Rerun timeline under a spatial model: A, B, op, result, carry and the cycle plotted against
`cycle`, each cycle's cause in a log. Moving Rerun's time shows that cycle in the model as it was
(observed state); changing an input there runs the model again from it, and the new run opens
beside the old. The viewer is Rerun's own (`@rerun-io/web-viewer` 0.35.0), loaded from
`https://app.rerun.io/version/0.35.0/`; the recording is written by Rerun's Rust SDK behind
`theorem.trace.recording`.

Acceptance question: "Why did carry turn on here, and what happens if I change register B?"

## Checks

Each check is recorded on its own. An unrun check says so.

| Check | Result | How |
| --- | --- | --- |
| Type check | pass, apart from the missing `terminal-wasm` package (pre-existing) | `bun run typecheck` |
| UI suite | 3789 tests: 15 fail, every one in a file that fails at HEAD (palettes 6, responses-section 3, inline-app 5, app-revision 1), and one unhandled error between tests (`@rustyreddb/browser` has no `RustyRedError` export) | `bun test` |
| Bundle | pass; the only warnings are `"use client"` directives inside node_modules | `bun run build` |
| Rust `theorem-proto-emit` | 9/9 | `cargo test -p theorem-proto-emit` |
| Server `conversation_work` | 161/161 | `cargo test -p rustyred-thg-server --lib -- conversation_work` |
| Server `inline_delegation` | 1 pass, 10 fail; the same 10 fail at `b28f13b879` (the fixture front model's HTTP requests fail) | `cargo test -p rustyred-thg-server --lib -- inline_delegation --test-threads=1` |
| `agent` crate | 334 pass, 2 fail; both (`conversation_synthesis`) fail at `b28f13b879` too | `cargo test -p agent`, after `cargo build -p codemode-kernel --bin theorem-js-cell` |
| Runtime observation in a browser | 14/14 at 608 x 220, the width of an App in a reply; 14/14 again after the frame height change | `node scripts/e2e/timeline.mjs` |
| Signed-in real-agent journey | 15/15 on thread `0c1c00ed`, over two runs (below) | `node scripts/e2e/timeline-live.mjs` |

## Browser fixture (`timeline.mjs`)

| Image | What |
| --- | --- |
| `timeline-start.png` | the fixture's processor with the timeline under it, at reply width |
| `timeline-scrubbed-cycle-0.png` | Rerun's time moved back to cycle 0: the model shows that cycle, its strip says so |
| `timeline-mouse-drag.png` | the time slider dragged with the mouse |
| `timeline-after-change.png` | register B changed while looking back: the model runs again from that cycle |
| `timeline-rerun.png` | the new run open beside the old in Rerun |

## Rerun's time panel at reply width

Rerun 0.35 drops its time controls once the viewer is narrower than 600 points and the recording
holds two or more times. In `re_time_panel`'s `collapsed_ui`, when
`ui.max_rect().width() < 600.0 && has_more_than_one_time_point`, the controls are split into two
rows, but the collapsed bar is `exact_size(32.0)`, one row tall, so both rows are clipped. An App
in a reply is about 608 CSS pixels wide, less the App's own padding, so the time panel vanished
as soon as the second cycle was recorded.

What did not help: overriding the panel state at start, `panel_state_overrides` in the start
options (it wants `Hidden`, capitalised, unlike its type), applying the override again after the
recording opened (`recording_open` never fires for a channel recording), and CSS zoom (Rerun
measures the canvas as drawn).

What does: `mountTimeline` gives the viewer a stage at least 640 px wide inside a scroller, so a
narrower reply scrolls it sideways (48 px at 592). The time panel is collapsed by default to one
row of playback controls, the slider and the time; the blueprint and selection panels are hidden.
An App can pass `panels` to choose otherwise.

## Live journeys

Signed in on the local stack as `claude-e2e`, front model `openrouter/minimax/minimax-m3`.

| Thread | What happened |
| --- | --- |
| `beb864` | Interrupted. |
| `d6f98b` | The agent wrote an App, with problems listed above it; the dossier answered. |
| `47a044` | The App sized itself to the viewport and collapsed; Rerun's time panel vanished at reply width. Led to the contract sentence on content height and to the 640 px stage. |
| `569a0f` | No App. The agent sent research off with `start_work` first, and admitting any work took construction from the turn, `write_app` included. Fixed in the server: only a builder, a child granted a write tool, or one revising an App takes construction (`conversation_work::constructs`). The same run found `search_tools` failing inside a program (it returns no typed disposition); fixed in `agent::program_turn`. |
| `0c1c00ed` | Run 1 (fresh): the agent wrote a spatial adder with Rerun under it, with no build, type or runtime problems, and the frame ran open; setting B and Rerun's step back passed. Opening a part's note failed: the frame was 150 px tall, every label hidden. The App sized itself with `62vh` and `38vh` under a caption, so its root never resized as content came and the frame never measured again; and its text showed `â€”` for `—`, the blob document carrying no encoding. Both fixed in the host (below). Run 2 (same thread, after the fixes): 15/15. |

Run 2, check by check: the answer holds a spatial model with a timeline; no problems listed; the
App runs open on an origin of its own (no host policy, no `allow-same-origin`); Rerun's viewer
loads; register B is a part and can be set from its card; Rerun's step-back button takes the model
back to the cycle where B was set and its strip says so (cycle 0 of 2); the part's note opens to
the dossier while looking back; opening it keeps the model on that cycle; the question starts a
run in the page's conversation, which completes; it carries the cycle looked at (`shown 0,
latest 2, lookingBack true, recent [start]`); the reply shows in the dossier and speaks to the
carry and to register B.

| Image | What |
| --- | --- |
| `timeline-live-1-app.png` | Run 1: the agent's App before the host fixes, a 150 px frame |
| `timeline-live-2-looking-back.png` | Run 2: Rerun stepped back to cycle 0, the frame at fill height |
| `timeline-live-3-answered.png` | Run 2: the dossier's answer in the conversation |

The answer is from the cycle looked at (A = 7, B = 5) and walks the four stages correctly, but its
summary and table say carry-out 1 for 7 + 5 = 12 in four bits, where its own walk ends at 0. The
journey checks that the reply speaks to the carry and to B, not that its arithmetic holds.

### Host fixes from run 1

- A page laid out by its viewport has no height of its own. The frame now says so (`fills` on
  `frame.resize`, `observeHeight` in `sandbox/display.ts`) when the page outgrows two frames in a
  row that were sized to it, or loads exactly as tall as the frame it started in, and the page
  gives it `clamp(360px, 70vh, 720px)`. Content changes are measured too, since such a page's root
  and body never resize. A page still taller than that scrolls inside its frame, as it would in
  any window of that height.
- The hosted document says `<meta charset="utf-8">` first, in place of any the App wrote: a blob
  carries no encoding, so the App's text was read as windows-1252.

## What the live runs taught the agent's context

- An App sits in the reply at the height of its content. A page sized to the viewport (`100vh`)
  is sized to its own frame and collapses; the App contract now says so (`app_contract.md`).
- The agent cannot read `@theorem/spatial`'s source or declarations, so it guesses at option
  shapes (`max` on a `bits` control) and writes its own adders that do not split bits.
- The agent can end a turn with problems still listed above its App.
- Run 1 on `0c1c00ed` sized its page with `vh` despite the contract sentence; the host now copes
  rather than relying on the sentence.

## Findings for later

- A label hidden because it yields to an open card cannot be reached by keyboard until the card
  closes.
- A remembered selection persists across loads, so a part's card can be open when the App starts.
- A question asked through the dossier while the build turn is still running stops that turn, and
  the question is not kept.
- Below 640 px the Rerun viewer scrolls sideways.
- An answer can get its own arithmetic wrong (carry-out 1 for 7 + 5 in four bits); nothing checks
  an answer against the model it describes.
- Opaque-origin Apps have no browser storage until Apps get a host of their own.
