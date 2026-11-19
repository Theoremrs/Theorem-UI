# The part dossier, live

This covers step 2 of the owner's ALU study, from
`PLAN-SPATIAL-ANNOTATIONS-AND-GEOMETRY-2026-11-17.md` (checklist items
`dossier` and `glass`). The dossier is a conversation in an expanded part note.
It is an assistant-ui thread inside the App frame, connected to the page's own
Theorem conversation. One assistant follows the selection and can be pinned
with "Keep here". There is no separate conversation per note.

`scripts/e2e/dossier-live.mjs` runs the whole journey, signed in on the local
stack with the real agent:

1. Ask for a processor.
2. Click a part in the scene the agent wrote.
3. Open its note.
4. Ask the study's acceptance question through the dossier: "Why did carry
   turn on here, and what happens if I change register B?"
5. Reload, and open the note again.

## How a question is kept

- `document-app.tsx` sends the question with a dossier reference to the App.
  The reference names the App's revision, the selected part, and the App's own
  account: inputs, outputs, settings, step, actions and interactables.
- The backend stores the located references a turn was sent with on the user
  message (`ChatMessage.contextReferences`), alongside `askedAbout`. Before
  this, the references lived only on the run, so the dossier could not find its
  questions again after a reload.
- `message-history.ts` puts the stored references back on each loaded message.
- `app-dossier.ts` recognises a dossier question by a reference to this App
  whose excerpt carries the dossier's account. A repair, or the conversation's
  own "ask about this App", is not taken for one.

## Checks

Each check is recorded separately.

| Check | Result |
| --- | --- |
| Type check (`bunx tsc --noEmit -p .`) | clean, apart from the existing `terminal-wasm` errors |
| Unit tests (`bun test src/lib/blocks src/lib/theorem`) | 778 pass, 1 skip, 0 fail |
| Bundle (`bun run build`) | built |
| Backend runtime tests (`cargo test -p theorem-harness-runtime --lib theorem_chat`) | 62 pass. The durable-reopen test now also stores and replays a turn's references. |
| Backend server chat tests (`cargo test -p rustyred-thg-server --lib theorem_chat`) | 118 pass, 3 fail: one passes when run alone, and two were already failing before this change. See the note below. |
| Browser runs, local stack (`glass`, `geometry`, `reference`, `app-db`, `app-ts`) | 4/4, 15/15, 26/26, 18/18, 25/25. app-ts first gave 24/25 on the check that fails on and off, then 25/25 on a rerun. |
| Signed-in real-agent journey, dossier (`dossier-live.mjs`) | 10 of 10, run three times. After a reload the dossier showed its questions and replies again (6 messages on the last run). |
| Signed-in real-agent journey, spatial (`spatial-live.mjs`) | 10 of 13. See below. |

### `spatial-live.mjs`

These failures come from what the agent wrote on this run, not from the
dossier change:

- **"the parts that were there are still there".** The overflow revision
  renamed the earlier parts.
- **"the turn ended".** The heart turn did end on the server (its reply
  suggestions are logged at 05:57). The scenario stopped waiting before then,
  while the agent was still fixing its own type errors.
- **"no build, type or runtime problems".** The heart App had type errors in
  its own `parts.ts`. Its `updateWorldMatrix` exception is inside three.js;
  none of our code calls it.

### Server chat tests

`theorem_chat_sessions::tests::an_idle_chat_answers_the_main_chat_in_a_turn_of_its_own`
failed in the full run and passed on its own. The other two,
`turn_admits_and_hashes_the_existing_client_operation_contract` and
`send_shape_reaches_auth_and_json_failures_keep_their_status`, also fail on
the branch without this change, run the same way with the patch set aside.
They were failing before this change.

## Screenshots

These are renders of the live App in the signed-in chat. None of them is a
reference image.

- `dossier-live-1-open.png`: the adder selected, its note opened to the dossier.
- `dossier-live-2-answered.png`: the reply in the dossier.
- `dossier-live-3-note.png`: the note alone. It stays inside the App frame, the
  body scrolls past the frame's height, and the head stays in place.
- `dossier-live-4-reloaded.png`: after a reload, the note opened again with its
  conversation.

## Fixed on the way

- **Enter did not send.** assistant-ui sends on Enter by submitting the
  composer's form, and the App frame's sandbox (`allow-scripts` only) blocks
  form submission. The dossier's input now sends through the composer itself.
- **The open note ran past the App frame.** A note is now capped at the
  layer's height, and its body scrolls.
- **Row values were cut off at the note's right edge.** The expanded note's
  `min-width: 18rem` matched the spatial slot's `max-width: 18rem`, so the
  card's padding pushed its content past the card's clipping edge. The floor
  is now on the note frame.
