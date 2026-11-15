# Projects sidebar, project page and session graph

The sidebar lists sessions, not conversation branches. Projects open to a page
of their own. Each project has a graph that shows how its sessions relate.

The governing spec is `THEOREM-PROJECTS-SIDEBAR-AND-SESSION-GRAPH-SPEC.md`,
which the owner attached in chat on 2026-11-14. It is not in either
repository yet. Section numbers cited in this repository's SOURCING comments
(§2.2, §5, §7, §9 and so on) are the spec's own numbers. The checklist is
`projects-sidebar-and-session-graph.checklist.json`.

This plan is the Theorem UI half, delivered "UI first, backend next":

- What Theorem already serves is drawn from real records.
- What it does not serve is labelled as not served. Nothing is drawn as if it
  worked.
- The relation and pin routes are a separate Theorem backend change that
  follows.

## Sources

- The spec, slices A to C (§16), with acceptance oracles from §15.
- The owner's notes:
  - Drop the activity buckets.
  - Pin by default.
  - Make Search clear and New thread lighter.
  - Give Projects and Chats bolder, larger headings.
  - Increase density.
  - Default icons are files and folders, plus a terminal file for coding and
    a third type for agent tasks, with user types allowed.
  - Replies and regenerations are never subchats.
  - The project home is modelled on Claude's.
  - The graph is a view that changes nothing.
  - Teams can be an org tree, flat or democratic.
  - Sessions can be connected without nesting.
- Mobbin references: the Linear, Claude and Twenty sidebars and Claude's
  project page.
- A graph screenshot the owner shared. They liked the workflow it showed, not
  its look.
- The design-oracles skill for type scale and spacing.
- The ChatGPT and Codex sidebars, from screenshots the owner shared on
  2026-11-14. These supersede the Mobbin sidebars on rhythm. The owner asked
  for their spacing, type weights, icon size and colour relationships, not
  their particular choices about bold headings.
- The owner's Streamline Ultimate file marks, also from 2026-11-14, used for
  session state and type.

## What changed

### Navigation semantics (§2.2, §4.3)

- **Only forks nest.** `nestingSource` in `src/lib/theorem/organization.ts`
  returns a source only for `origin.kind === 'forked'`.
  - A continuation is provenance: it stays at the top level and says
    "Continues …".
  - Edits and regenerations never produce a session row.
  - `parentsIn` breaks a malformed origin cycle at its oldest member, so
    every session stays visible (NAV-07).
- **Opening a session keeps its version.** A session row carries no
  version-branch rows. Opening the current session keeps the conversation
  version selected inside it (NAV-05, `src/components/organize/thread-row.tsx`).

### Sidebar (§5, §6)

`src/components/organize/organized-panel.tsx`

- **Section order:** a search button in the header (it opens the command
  palette; its tooltip shows the shortcut), a lighter New thread, Pinned,
  Projects, Chats, and the Librarian at the foot. Attention Worthy, Running,
  Needs You and Later are gone.
- **The rail's tab** is painted with whatever it joins: the panel's fill
  while the panel is open, otherwise the sheet. The appearance work had
  given the panel its own fill, so the tab had turned white against it.
- **Rhythm** follows the ChatGPT and Codex sidebars. The rules are in
  `src/components/shell/chat-shell.css` and are scoped to the panel.

  | Part | Before | Now | Reference |
  | --- | --- | --- | --- |
  | Row height | 32px, 1px gap | 28px, rows touch | ~27pt |
  | Row marks | 16px | 14px | ~12pt glyph |
  | Section label | 15px/600, full ink | 14px/500 (`ui.section`), muted ink | row size, quieter ink |
  | Space above a section | 16px + the label's 32px | 12–16px + a 28px label | ~13pt + one row |
  | Row's trailing end | relative time, or a Review badge | spinner when running, dot when it needs you, nothing at rest | the same |

  The time a session last moved is now in the row's tooltip. Touch density
  and coarse pointers keep their 44px rows.
- **Headings** keep the appearance recipes rather than a local override
  (TYPE-01). They moved from `ui.group` to `ui.section`.
- **A project row is two controls:**
  - its title links to the project's home;
  - its folder is the disclosure, and turns into a chevron on hover or focus
    (NAV-08).
- **Pins are their own thing** (§5.2), separate from the Librarian's
  placement lock, which is now labelled "Keep in…". Pins live in
  `src/lib/theorem/sidebar-prefs.ts` and are stored per browser, and the
  empty Pinned section says so.
- **Session types** (§5.4) change only how a session looks. The built-ins are:
  - Conversation (Streamline text file);
  - Coding (code file);
  - Agent task (checklist file);
  - Image or design (image file).

  People can add their own from the row menu, and a type grants no
  capability (AUTH-04).
- **Session state outranks type** in a row's mark, strongest first:
  1. the four-pages mark when other sessions were forked from this one;
  2. the doubled page for a continuation;
  3. the empty page for a session with no message yet.

  Every new thread uses the owner's file-with-a-plus mark (2026-11-15): the
  top row, the command palette, the phone header, and each project's row.
  On a project row it stands where the session count was; the count moved
  to the row's tooltip. A project no longer lists a "New thread" row while
  one is being started in it, though it still opens. The edit and second
  double marks are traced but not used. `src/components/organize/glyphs.tsx` holds the
  logic; `glyphs.test.ts` covers the order.

### Project page (§7, §8)

Route `/projects/$projectId`, `src/components/projects/project-home.tsx`.
`ModeView` shows it in place of the conversation, which stays mounted. It is
one page with no tabs (the owner's review on 2026-11-14 removed Overview,
Sessions, Graph and Context as tabs).

The composer and sessions run on one 680px track, the artifact cabinet spec's
(§3.4), with the project's context in a small column (15rem) beside them. When
the page is too narrow for both (a container query at 44rem, where the composer would drop below about 430px, so an open
terminal or panel counts, not only the window), the context moves below the
sessions. The owner chose this on 2026-11-15, after a day with the context
folded into a disclosure above the composer.

- **Header:** folder mark, title, session count, last moved, Pin and Edit.
  Edit sets the title and instructions through `chat.projects.update`,
  sending only what changed; instructions that could not be read are locked.
- **Main column:**
  - the real composer, which files the new session in this project through
    the shell's project;
  - the project's sessions below it (`project-sessions.tsx`), newest first,
    with their provenance and no heading. Each is one 32px line (DESIGN.md's
    two-part structured row): mark, title, then where it came from in muted
    text, with its state and a compact time ("8m", "1d") in fixed,
    right-aligned slots so they line up down the list. The first view shows ten; Show more
    adds 25 at a time, with a count ("10 of 34"), so the context below stays
    in reach when the page is narrow. A Search button opens a fuzzy search,
    and Filter narrows by type, status (Running, Needs you, Idle) and origin
    (Started here, Forked, Continued), with counts. It runs on the app's
    TanStack Table v9 kit (`useAppTable`).
- **Project context**, the small column (`aside`, "Project context"):
  - Instructions and Where it stands, each with Edit;
  - Knowledge and connections: Documents, Repositories, Links, and
    Databases and servers, under one line saying Theorem does not serve
    these per project yet (§8: no working-looking placeholders).

  The owner expects the WASM terminal to hold this context eventually.

- The phone header, the dock tab and the breadcrumb name the project while its
  page is open.
- **Apps and outputs live in the right-hand drawer**, not on the page
  (`src/components/shell/outputs-drawer.tsx`). It is the same Base UI Drawer
  as the side terminal (coss ui's Drawer wraps it), sharing its one slot, so
  one or the other is open. It lies over the page instead of taking its
  width, has no tabs, and shows what the open page made as thumbnails
  (`src/components/artifacts/output-tile.tsx`):
  - in a chat, each artifact's latest revision: an App drawn live at a
    quarter of its size (its poster off screen), a document or code as its
    opening lines;
  - on a project page, the project's outputs. These carry no picture yet
    (`ProjectOutput` has ids, kind and revision counts only), so each tile
    shows its kind's mark until Theorem serves a poster.
  - The apps button in the dock's header opens and closes it; Escape and its
    close button close it; opening an output closes it.
- **Widths:** the sidebar's default is 210px, the artifact cabinet spec's
  navigation width (§3.4; the owner, 2026-11-15), and it can be dragged
  between 184px and 420px. A panel left at an old default (354, 280 or 248)
  takes the new one; a dragged one keeps its width. A chat's composer is
  unchanged: the design oracle holds it to the message column's measure.

### Session graph (§9)

The graph is on the Canvas mode (`/canvas`), beside the programmable graphs,
not on the project page. It is offered only where there is something to draw:
"Open graph" appears in a project's menu when a session filed in it was
forked or continued (or another was from it), and in a session's menu, the
chat header and the sessions panel when that session was.

- **Read:** `src/lib/theorem/sessions.ts`, Theorem's
  `GET /api/chat/v1/session-graph?projectId=|treeId=`
  (Travis-Gilbert/Theorem#1075), mirrored field for field. It returns each fork
  tree rooted at its main, connections (continued and session messages, with
  a count and whether any spoke for the person), artifacts, documents and tool
  use per session, and the facets Theorem does not serve. `?sessions=project:<id>`
  or `?sessions=tree:<any chat of it>` opens a graph; `?view=<id>` opens a
  saved one.
- **Projection:** `src/lib/theorem/session-graph.ts` computes
  P(read, show, titles). It is a pure function and writes nothing (VIEW-01).
  - Forks join each chat to its authority parent, so the tree runs out from
    the main. Making another chat main turns the path between the two around
    and leaves every other edge where it was.
  - Connections draw continued chats (dashed, arrowed) and session messages
    (dotted arcs, labelled "3 messages · for you" when any spoke for the
    person). A chat a connection reaches outside the trees read is drawn
    with a dashed outline.
  - Artifacts, documents and tools hang from the session that made or called
    them.
  - In a project graph, a session nothing joins (no fork, continuation or
    message) is counted in the header ("2 on their own, not drawn") instead
    of drawn. The only chat in its tree carries no Main or Origin mark.
  - A hidden facet is left out, with the edges it carried.
- **Show:** sessions, forks, connections, artifacts, documents and tools, each
  a checkbox in the Show menu. Forks and connections need sessions; a facet
  Theorem does not serve says so.
- **Make main chat:** right-click a session (or the inspector's button). It
  posts `POST /threads/:id/main` with the revision the person saw, so a choice
  made elsewhere meanwhile is refused, not overwritten. The main then messages
  the others on the person's behalf; any session can message any other as
  itself.
- **Saved views:** Save names the view and keeps its facets, where nodes were
  dragged and which way it runs, through `programmable_graph_apply`
  (`save_session_graph`, `delete_session_graph`) with the revision it was
  opened at. The sessions are read fresh each time. Saved views are listed in
  the Canvas sidebar under "Session graphs", with Rename and Delete in the
  view's menu.
- **Layout:** `src/lib/theorem/session-graph-layout.ts`, ELK layered, from
  the fork, continuation, made and called edges, so each runs one column out.
  Messages are drawn over the layout as arcs (a floating edge between the two
  cards) and never pull a fork out of its column. A new view runs left to
  right unless running down fits its panel at least 15% larger; the choice is
  kept, and saved with the view, so showing or hiding a facet does not turn
  it. The projection's node order is kept, so a refresh does not reshuffle it.
- **Layout stability:** a person keeps their mental map of the graph only if
  what is on screen stays put, so `arrange` in the same file decides which
  nodes ELK may move, and ELK only proposes places.
  - ELK runs only when the layout's shape changes: the nodes, their sizes, the
    laid-out edges and each tree's main. A refetch that changes a status, a
    time or a message count gives the same shape and lays nothing out.
  - Nodes already drawn keep their places. A new node goes beside a parent or
    child already on screen, as far from it as ELK put it; a group with
    nothing on screen to hang from goes after everything.
  - Dragged nodes never move, and anything placed later is moved clear of
    them along the cross axis.
  - Every node's last place is remembered, including nodes hidden since, so
    hiding and showing a facet moves nothing, and neither does switching to
    the list and back.
  - Make main chat re-forms only that tree, around the corner it occupied,
    and other trees stay.
  - "Lay the graph out again" (the canvas controls) lays everything out
    fresh, and the dragged nodes join the layout again, which marks a saved
    view unsaved.
  - A re-formed tree glides to its new places on `springs.glide` from
    `lib/motion` (anime.js, no overshoot). A glide that is interrupted turns
    from where each node is drawn. Under reduced motion the new places are
    shown at once.
- **View:** `src/components/sessions/session-graph-canvas.tsx`, React Flow 12.
  - Nodes can be dragged; a moved node marks the view unsaved. Nothing can be
    connected, and Delete does nothing.
  - Selecting a node opens an inspector that lists its relations in words.
  - The graph refits when its panel resizes, until the person pans, zooms or
    drags. Below a readable zoom (0.6) it starts at the main instead of
    shrinking.
  - "Show as list" gives the same graph as text, with no canvas (INPUT-02).
- The earlier read-only view on the project page
  (`src/components/projects/session-graph.tsx`) and its Lineage, Projects,
  Delegation, Team and Related lenses are removed.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Layout engine | ELK (elkjs, bundled, on the main thread as `lib/theorem/plans.ts` does) | Layered, tree and force layouts come from one engine with model-order constraints. dagre has only layered layout, and Graphviz needs WASM for no added layout here. dagre stays in `package.json`, unused by this change. |
| Renderer | React Flow 12 (already a dependency) | Accessible nodes, panning and zooming, and custom edges. gpucanvas would only pay off at node counts a project does not reach. |
| Pins | Per browser, in zustand persist | Theorem has no per-user pin route yet. The UI says pins are kept in this browser. |
| Unserved facets | Present in Show, labelled with Theorem's reason | A facet that draws something made up would break VIEW-03. |
| Lone sessions in a project graph | Counted, not drawn | A graph is of relations; a project of mostly unforked sessions would otherwise be a grid of unconnected cards. |

## Not in this change

These are the backend half. They need Theorem routes, so they are not
fabricated here:

- `related_to`, `directs` and child-session relations: NAV-04 and REL-01 to
  REL-04.
- The session graph routes in the vendored `@theoremharness/sdk`: they are
  reached through `lib/theorem/passthrough` until it carries them.
- Per-user pins (§5.2): NAV-06 holds today only within one browser.
- Project documents, repositories, links and connections (§8.2).
- Graph editing, organization presets and governance (slices D and E).

Follow-up, in the Theorem UI:

- One layout module for the session graph, `lib/theorem/plans.ts` and
  `lib/program/flow.ts`: one interface with a policy per graph. It would also
  draw edges on ELK's routes where neither end has moved (only `plans.ts`
  uses them today), and fix the program canvas's new nodes, which can land on
  saved ones.
- Compare ELK's mrtree with layered on this view's fixture before switching
  lineage to it.
