# The self-organizing Index in Theorem UI

The Index is where Theorem keeps the material it has filed, and where it learns
how that material is used. It organizes the material, watches how it is worked
with, and improves the environment for working with it: not only where things
are filed, but the views they are found, compared and acted on in.

The backend half and the wire contract are in the Theorem repository,
`docs/plans/index-workspace/SPEC-INDEX-WORKSPACE-1.0.md`. This plan is the
frontend half. The checklist is `self-organizing-index.checklist.json`.

## Sources

- The Index handoff idea: precomputation rather than an inbox; filing with
  uncertainty and correction; a working pane that does more than preview.
- Theorem PR 845 (Personal Operations): saved scopes are queries, never copies;
  a custom view is a scope plus operations plus presentation, and changing the
  presentation never changes what an object is; learned behaviour changes only
  rankings, proposals or policies, inspectably.
- `NORTH-STAR-organizing-engine.md`: one engine emits candidate changes with
  confidence and an admission tier; high confidence applies, the rest is a
  stream to glance at, never a backlog.
- `SPEC-SOM-CELL-COLUMN-2.0.md`: the map is a view of the data, never the
  decider of membership; it is frozen per generation; it works without a model.
- OpenUI (`@openuidev/react-lang`): a component library the model composes
  against, declarative programs with reactive state and tool-backed queries, and
  a renderer that runs a stored program with no model in the loop.

## Shape

Index is a fourth mode on the rail, at `/index`.

- **Panel** (beside the rail): search, Everything, the collections, saved views
  (pinned first) and the views Theorem prepared, and the improvement policy.
- **Surface** (the dock's main panel): the active view, rendered from its
  durable definition by the OpenUI renderer, under a header with its title,
  purpose, revision history, pin and edit. Notices of prepared improvements sit
  above it.
- **Inspector** (beside the surface): the selected item, what it is, where it
  was filed and why, how confident the filing was, correction and undo, what it
  is used with, and Ask Theorem.

## Decisions

| Decision            | Choice                                                                                                                                       | Why                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Where views live    | In Theorem, as `IndexView` with revisions (`/api/index/v1/views`)                                                                            | A view must open directly, from any conversation and with any model; the artifact panel is derived from thread messages and cannot own it |
| Presentation        | OpenUI Lang programs over an Index component library in `src/components/index/library.tsx`                                                   | The model composes against the same catalogue a person uses; a stored program re-renders with no model                                    |
| Data in a view      | Named bindings the server executes (`POST /api/index/v1/query`), called from the renderer's `toolProvider`                                   | Bindings are structured, so the server can validate a candidate's coverage; filters and search run without the model                      |
| Default views       | Shipped as programs in code (`default:home`, `default:collection:<id>`, `default:atlas`)                                                     | The Index is useful before anything is learned; "Customize" copies a default into a stored user view                                      |
| Learning signal     | Observations recorded by the surface (`/observations`), separate from explicit preferences (`/preferences`)                                  | Observation, interpretation and adopted preference stay three different things                                                            |
| Improvement         | Theorem's background loop proposes; the UI shows proposals and applied changes with Accept, Dismiss and Revert                               | The work happens while nobody waits; nothing live changes under the person                                                                |
| Validation          | The server checks bindings and lints the program; the UI parses the candidate with the real library before showing it and reports the result | The parser is TypeScript; the server stays declarative                                                                                    |
| Library publication | The UI publishes `library.prompt()`, component and callable names to `/api/index/v1/library` when its digest changes                         | Theorem composes candidates against exactly the components this build renders                                                             |
| Atlas               | A library component over the `map` binding (`AtlasSnapshot` v2)                                                                              | The map is one optional way to see the material, never its identity                                                                       |
| Tests               | `bun test` over the pure modules: bindings, observation batching, default programs parsed by the real parser                                 | No new test runner                                                                                                                        |

## Records in the Index (2026-11-16)

The CRM moved into the Index (see `record-table-data-model.md`): a type's
table, a record page and the records home are built-in views, and an open
record is the Index's item `record:<name>/<id>`. Opening a record page from
anywhere goes through the Index navigator, which records an `item_opened`
observation with the record's id, so record use reaches the same learning
signal as documents.

The owner set the order in which records join the self-organizing loop:

1. **Records in views and used together.** The Index's observations and its
   used-together relation accept record ids; a view binding can list records;
   a prepared view can place records beside the documents they are used with.
   UI side done in source: observations carry record ids; the contract has a
   `records` binding (`{kind:'records', ids}`, 1..50 item ids) with its
   `records` result and an optional `records` list on the used-together result
   (absent from an older server, read as none); `IndexComparison` takes an
   optional fourth argument (the `records` Query) and shows a "Records"
   section of rows (type mark, title or record id) that open the record page,
   and renders an all-record group with no document strip; a record's preview
   and page show "Often opened with" (a used-together binding anchored on the
   record's item id, up to 8 neighbours, hidden while loading, when empty or
   when the read fails). Tests: `index.test.ts` ("the used-together template
   with records parses", "records in the contract"),
   `records-in-views.test.tsx` ("IndexComparison with records") and
   `crm/often-opened-with.test.tsx` ("Often opened with"). The server side is
   in Theorem (`theorem_index_workspace` tests). Nothing here is observed
   against a deployed Theorem yet.
2. **Filing documents to records.** When a document is filed, Theorem also
   links it to up to three saved records it is about, with a receipt (tier,
   confidence, why) for each, and the person corrects or undoes it; the owner
   chose filing with Undo over an approval queue, because a link never changes
   a field of the record. Precedent is an email or phone of exactly one record
   appearing in the document; learned is the record's name as whole words in
   the title or text. A dismissed pair is never linked again, and a record
   dismissed twice by name stops being linked by name. UI side done in
   source: the document inspector's "About" section (`index/record-links.tsx`)
   lists each linked record with why it was linked, opens the record page, and
   offers "Not about <name>", "Change…" (another record of the same type) and
   Undo for the latest correction, read from Theorem so it survives a reload;
   nothing shows when the document is about no record. A record's preview and
   page list "Documents about this" (`crm/documents-about.tsx`) from the
   `record_documents` binding (`{kind:'record_documents', recordItemId}`,
   answered as items), hidden while loading, when empty, or when an older
   Theorem refuses the kind. Tests: `index/record-links.test.tsx` and
   `crm/documents-about.test.tsx`. There is no way yet to link a document to a
   record by hand when Theorem linked it to none; "Change…" offers only
   records of the linked record's type. Nothing here is observed against a
   deployed Theorem yet.
3. **Extraction from filed material.** A filed document can lead to a change
   to a record, made only as a proposal the person approves (the agent's
   record change proposals in Theorem are the model).

Self-describing fields (a field linked to the places it belongs) were
discussed and deferred.
