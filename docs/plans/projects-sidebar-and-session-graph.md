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

- **Header:** folder mark, title, session count, last moved, Pin and Edit.
  Edit sets the title and instructions through `chat.projects.update`.
- **Left column:**
  - the real composer near the top, which files the new session in this
    project through the shell's project;
  - the project's sessions below it (`project-sessions.tsx`), all of them,
    newest first, with their provenance and no heading. A Search button
    opens a fuzzy search, and Filter narrows by type, status (Running, Needs
    you, Idle) and origin (Started here, Forked, Continued), with counts.
    It runs on the app's TanStack Table v9 kit (`useAppTable`).
- **Right column, the project's context:**
  - Instructions and Where it stands, each with Edit;
  - Knowledge and connections: Documents, Repositories, Links, and
    Databases and servers, each labelled "Not served yet" (§8: no
    working-looking placeholders).
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
- **Widths:** the sidebar's default is 248px (from 280; a panel left at an
  old default takes the new one, a dragged one keeps its width). The project
  page lays its context column beside the composer only when the page itself
  is at least 54rem wide (a container query), so a column open beside the
  page stacks the context beneath instead of squeezing the composer. A
  chat's composer is unchanged: the design oracle holds it to the message
  column's measure.

### Session graph (§9)

The graph no longer sits on the project page. It moves to the Canvas mode
(the programmable graph surface), opened from a project's or a session's
menu; that change follows. What is described below is the projection and
layout it reuses.

- **Projection:** `src/lib/theorem/session-graph.ts` computes P(records, lens,
  scope). It is a pure function and writes nothing (VIEW-01).
  - **Lineage** draws forks as solid arrows and continuations as dashed
    arrows labelled "continues". A source outside the project is drawn with a
    dashed outline. A missing source is not invented.
  - **Projects** draws every project a session is filed in. A kept placement
    is labelled "kept".
  - **Delegation, Team and Related** say why they are not served, and draw
    nothing.
- **Layout:** `src/lib/theorem/session-graph-layout.ts` uses ELK:
  - layered for lineage and membership;
  - mrtree for a team's one-way tree;
  - stress for related sessions.

  It keeps the projection's node order, so a refresh does not reshuffle the
  graph.
- **View:** `src/components/projects/session-graph.tsx` uses React Flow 12.
  - Nodes cannot be dragged or connected, and Delete does nothing.
  - Selecting a node opens an inspector that lists its relations in words.
  - The graph refits when its panel resizes, until the person pans or zooms.
  - Below a readable zoom it starts at the top instead of shrinking.
  - "Show as list" gives the same graph as text, with no canvas (INPUT-02).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Layout engine | ELK (elkjs, bundled, on the main thread as `lib/theorem/plans.ts` does) | Layered, tree and force layouts come from one engine with model-order constraints. dagre has only layered layout, and Graphviz needs WASM for no added layout here. dagre stays in `package.json`, unused by this change. |
| Renderer | React Flow 12 (already a dependency) | Accessible nodes, panning and zooming, and custom edges. gpucanvas would only pay off at node counts a project does not reach. |
| Pins | Per browser, in zustand persist | Theorem has no per-user pin route yet. The UI says pins are kept in this browser. |
| Unserved lenses | Present, and labelled with the reason | A lens that draws something made up would break VIEW-03. |

## Not in this change

These are the backend half. They need Theorem routes, so they are not
fabricated here:

- `related_to`, `directs` and child-session relations: the Related and Team
  lenses, NAV-04, and REL-01 to REL-04.
- A project-wide delegation index: the Delegation lens.
- Per-user pins (§5.2): NAV-06 holds today only within one browser.
- Project documents, repositories, links and connections (§8.2).
- Graph editing, organization presets and governance (slices D and E).
