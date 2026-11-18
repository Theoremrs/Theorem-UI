# assistant-ui enrichment

Replace hand-rolled interaction surfaces with assistant-ui's library where the
library is the better mechanism, and keep Theorem's own where it is richer.
The owner's ask (2026-11-17): the hand-rolled MCP element first, then the
library's richness for agent responses and the general interaction model,
shaped to the existing design. References: Claude Code and ChatGPT on Mobbin;
Devin through the committed refs in `evidence/ledger.md` (Devin is not on
Mobbin).

Work happens on `Travis-Gilbert/assistant-ui-enrichment`, branched from
`origin/main` (2e4f648c). The shared `feat/motion` checkout is dirty and 163
commits behind; it is not touched.

## What the app already has (verified against the guides)

- Runtime: `useRemoteThreadListRuntime` + `useLocalRuntime` over the Theorem
  SDK. Theorem owns history, execution and approvals; this is not an AI SDK
  route, so `guides/mcp` (the `@ai-sdk/mcp` server path) does not apply.
- Speech: a custom `SpeechSynthesisAdapter` (in-page phonon voice through the
  page's sound graph) with `ActionBarPrimitive.Speak`/`StopSpeaking` — the
  guide's step, satisfied with a better provider. No change.
- Slash popover: the vendored `composer-trigger-popover` element with a
  hand-written `TriggerAdapter` (Theorem tools + two output commands).
- Dictation: composer mic buttons gated on `thread.capabilities.dictation`,
  but no dictation adapter registered — the mic never appears.
- Markdown: `MarkdownTextPrimitive` + remark-gfm; no math.
- MCP: hand-rolled settings (`src/components/connections/*`) over Theorem's
  server-side Connections API. The browser never speaks MCP; Theorem holds
  credentials. This is the product's own model and stays the source of truth.
- Already richer than the catalog equivalents, kept: the plan graph (React
  Flow + ELK over Theorem plans), citation/source parts, the run footer's
  timing rows, the usage popover.

## Decisions

1. **Frontend tools ride Theorem client operations.** A send declares up to
   16 operations (Kit + App + face + workbench use 15 when all are mounted);
   a call streams a `theorem-client_operation` part; the page answers with a
   `client-operation-receipt` command. `present` (generative UI) is declared
   as one `presentation` operation whose schema is `buildPresentParameters`
   of the styled vocabulary, and whose receipt renders the tree through the
   installed `generative-ui` element. Browser MCP tools use the same channel
   within the remaining budget; over-budget servers are reported, never
   silently dropped.
2. **MCP settings keep Theorem's server-side API as the data source.** The
   hand-rolled rows/dialogs are rebuilt on the `mcp-config` element's
   primitives and state helpers where they fit the settings frame, so there
   is one design system.

   **Finding (verified against the code):** `@assistant-ui/react-mcp`'s
   manager is a *browser-direct* MCP client — it opens Streamable HTTP from
   the page, holds tokens in browser storage, and registers each tool as a
   *frontend* tool that the chat route must forward to the model and resume
   (`sendAutomaticallyWhen`). Theorem's model is the opposite and deliberate:
   Theorem speaks MCP server-side, holds the credentials, executes the tools
   in the run, and the browser never sees a secret (`connections.ts`: "the
   browser never sends a request to /mcp"). The Theorem send contract
   (`SendMessage`) carries no frontend-tool channel, and the SDK adapter
   accepts text turns only. So the manager cannot back Theorem's connections
   without either (a) moving credentials into the browser and adding a
   frontend-tool resume path Theorem does not have, or (b) a server-side
   storage bridge that still leaves the browser holding auth state.

   **Decision:** do not mount the browser-direct manager against Theorem's
   server-side connections — it would duplicate state and weaken the
   credential model. Reuse the library where it is the better mechanism: the
   `mcp-config` element's server-card / status / add-form *presentation*
   rebuilt over Theorem's own queries and mutations, so the settings page and
   the composer share one MCP design language. The element
   (`mcp-config.aui.tsx`) and `@assistant-ui/react-mcp` stay installed for a
   future browser-direct surface; mounting it is a named product decision
   (credential storage + frontend-tool resume), not a silent default.
3. **Dictation** is `WebSpeechDictationAdapter`, registered only where
   `isSupported()`; the existing composer UI lights up unchanged.
4. **LaTeX**: remark-math + rehype-katex + KaTeX CSS, with
   `normalizeMathDelimiters` composed over `escapeCurrencyDollars`.
5. **Slash commands**: `unstable_useSlashCommandAdapter` (unstable API,
   accepted) supplies real actions inside the existing `/` popover; the
   Crepe editor's selection override learns the `action` behavior so a
   command strips its trigger text in the editor, not behind its back.
6. **Quote**: the `quote` element adds select-to-quote into the composer —
   the one clearly missing response interaction.

## Obligations (ui-graph-plans)

Every touched surface lands a story at `/story/<id>` over committed fixtures,
a ledger row (lane, source, author/license, reference), and an oracle collage
under `docs/plans/evidence/`. Lanes here are `translation` (registry elements
restyled to the app's tokens) or `original`. Static oracle: story screenshot
diffed against the committed reference with a declared tolerance. Interaction
oracle: scripted states for the slash menu, dictation button states, quote
toolbar, and the MCP dialog. Motion is claimed only where the element ships
it. Fidelity seals are hitl: the collage is opened by a person.

## Steps

1. [x] LaTeX plugins + preprocessing + KaTeX CSS (`markdown-text.tsx`,
   `styles.css`). Story `assistant-math`; render verified.
2. [x] Dictation adapter on the runtime (`runtime.tsx`).
3. [x] Slash action commands through the unstable adapter (`/new`, `/web`,
   `/plan`, `/code`, `/read-aloud`, `/connections`), merged into the existing
   `/` popover; the editor's directive path strips the trigger text. Tests
   updated and extended (25 pass).
4. [x] Generative UI: `present` client operation (`ui.present`), schema
   compacted to 7.5 KB (under the 8 KB cap), styled vocabulary, receipt
   bridge, part rendering. Story `assistant-present`; render verified.
5. [x] MCP: decision recorded above — the browser-direct manager is not
   mounted against Theorem's server-side connections; the element and
   `@assistant-ui/react-mcp` stay installed for a future browser-direct
   surface. The existing settings already share the app's design system.
6. [x] Quote element wired: selection toolbar in the thread, preview in the
   composer, quote block on user messages. Interaction verified end-to-end.
7. [x] Stories, ledger rows, evidence renders; `bun test` (175 pass in
   chat + generative), typecheck clean, lint clean on changed files; dev
   server preview at http://localhost:3102.

## Verification (2026-11-17)

- `bunx tsc --noEmit`: clean.
- `bun test src/components/chat src/lib/generative`: 175 pass, 0 fail.
- `bun test src/components/assistant-ui src/lib/theorem/runtime.test.ts`:
  36 pass.
- ESLint on changed files: clean (one pre-existing `no-shadow` warning in
  `runtime.tsx` left as-is).
- Story renders captured in headless Chromium: `assistant-math`,
  `assistant-present`, `design-oracle-empty`; quote interaction scripted and
  captured. Evidence under `docs/plans/evidence/assistant-ui-enrichment/`.
- Fidelity seals are hitl and remain open: the renders are committed for a
  person to open; no agent has sealed them.

## Dependency alignment

The CLI's `add` bumped `@assistant-ui/react` to 0.15.36 and pulled nested
copies of `core`/`assistant-stream`. Pinned `@assistant-ui/core` 0.3.36 and
`assistant-stream` 0.3.57 to match, removed the stray `cn` package the CLI
added, and force-relinked so the tree is flat (one copy of each).

## Blockers / follow-ups

- Production MCP auth storage (HTTP-only cookie backed `McpCustomStorage`)
  needs a server route decision; development uses `McpLocalStorage`.
- The 16-operation server cap is shared with Kit/App/face/workbench; the
  bridge admits MCP tools only into the free slots and says which servers
  did not fit.

## Selection as context (2026-11-17, owner's ask)

The owner wants the common AI-app move: select text in a reply, then add it
to the composer as context for the next response — or open a side chat /
task from it. assistant-ui ships Quote (select → composer quote), but not
"add as a durable context reference" or "open a side chat from selection".

**Finding:** Theorem already has the right foundation, richer than pasting
text: `askAbout` (`composer-references.tsx`) puts a typed
`TheoremContextReference` (location + excerpt + label) in the composer, and
the front role reads the referenced passage. `TheoremResource` has a
`message` kind (threadId + messageId); `TheoremLocation` carries an optional
range and revision. Scene parts and delegation changes already use it.
Plannotator's `AnnotationToolbar` (backnotprop/plannotator, MIT) is the
reference for the *interaction*: a portal above the selection, copy /
comment / quick-label, type-to-comment, dismiss on outside/Escape. We take
the interaction pattern, not its editor, theme, or persistence — per the
owner's attached guidance ("Theorem-owned experience, selective upstream
reuse").

**Decision:** extend the installed assistant-ui `SelectionToolbar` (already
in the thread root) with an "Add to context" action beside Quote. It reads
the same selection info the Quote button reads (`messageId` + text), builds
a `message`-kind context reference with the selected text as excerpt, and
hands it to `askAbout`. The selection toolbar's `useSelectionToolbarInfo`
is not publicly exported, so the action is composed inside the element's
`SelectionToolbar.Root` using a small local selection read (the same
`data-message-id` scoping the library uses), keeping one toolbar.

Side chat from selection is a follow-up: the workbench already has
`conversationSideChat` (port.ts), but wiring a selection into a new side
chat needs the workbench's conversation port and is a larger surface; it is
named, not silently shipped.

### Side chat research (subagent, 2026-11-17)

Side chats are UI-owned, not SDK: `Conversation.sideChat`
(`src/lib/workbench/conversation/conversation.ts:326`, impl `:1633`) opens a
second `useLocalRuntime` over the same `runTurn`. Scope is
`fresh | continued | forked`; continued/forked need a durable main thread.
Mounting requires the workbench's `<sideChats.Hosts/>`
(`side-chats.tsx:73` throws without it), and the only user-facing opener is
the wasm workbench's "New side chat" picker — no React-visible handle.
`send.references` is workspace-file-only (`SourceReference`), not
message-kind; the composer's message refs live in the global
`useComposerReferences`, shared across chats.

**Blockers for selection → side chat:** (1) no shell-level side-chat opener
(workbench-only, lazily mounted); (2) references are not scoped per chat;
(3) no initial-message param — seeding needs a follow-up send. This is a
workbench-architecture task, not a toolbar button; it is named here as the
next increment, not shipped.
