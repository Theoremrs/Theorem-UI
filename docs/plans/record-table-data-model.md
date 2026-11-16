# Record tables and the data model in the Index

Twenty's record table and data model settings, rebuilt over Theorem's schema
register and placed in the Index as two library components a view program
composes like any other. The checklist is `record-table-data-model.checklist.json`.

## Replaced by the CRM table (2026-11-16)

The owner decided that the CRM's table replaces this plan's generic records
table everywhere, and that the CRM lives in the Index rather than at its own
`/crm` route. `src/components/records/record-table.tsx` and
`record-inspector.tsx` were removed. The data model and the work tracker
still use this plan's other modules (`aggregate.ts`, `view-state.ts`,
`layout.ts`, `fields.tsx`, `data-model.tsx`).

- `RecordTable("<name>")` in a view program and the built-in
  `default:records:<name>` draw `src/components/crm/crm-table.tsx`.
- A record page is the built-in view `default:record:<name>/<id>`
  (`src/components/crm/record-page.tsx`), and `default:records` is the records
  home (first run, then the first listed type).
- The open item `record:<name>/<id>` is shown by the CRM's record preview in
  the Index inspector, on the desktop Index page and on the phone.
- The Index panel's Records section is the CRM's list ("Me", each type with
  its count, and installing missing built-in types).
- Pages' records module (`theorem.records.table`) draws the CRM table and
  opens record pages in the Index.

What the generic table had that the CRM table does not, so a person loses it
with the replacement (the checklist rows say which):

- the per-column menu (filter, sort, move, hide) and the "+" column for
  showing hidden fields and customizing them;
- the Calculate footer (the CRM footer is the dataset count);
- search of any field and and/or filter rules (the CRM filters on the
  identifier field), multi-sort, field order, reset and CSV export;
- shift-range selection and export of the selection;
- column resize by drag and virtualized rows;
- Tab across cells and Backspace to clear;
- the arrangement kept per view in localStorage (the CRM keeps filter, sort
  and the open record in the address, and nothing per view).

The CRM table brings revision-checked writes with visible stale refusals,
bounded update of marked records, the record page with history, and the
measurements of Theorem's CRM spec. Which of the losses to bring back is the
owner's call; none was ported in this change.

## Sources

- Twenty (fork `Travis-Gilbert/twenty` at `ffca6cee`): `packages/twenty-front`
  record-table, record-field, record-show, views and settings/data-model,
  including the React Flow overview. Behaviour was read from source; no code was
  copied.
- Mobbin, Twenty on web: [Updating records](https://mobbin.com/flows/5970df17-fd43-4b05-8031-b11b1db98089),
  [Updating table view](https://mobbin.com/flows/e387b8ef-0285-4d3a-9826-4cce421bff81),
  [Notes](https://mobbin.com/flows/cd249207-eaed-4d2b-89f2-f3770ee646ad),
  [Data model](https://mobbin.com/flows/fe5330e0-eeb0-4040-9436-89d8eb159d3a),
  [Creating an object](https://mobbin.com/flows/01925060-804e-4039-8bc2-fc6ecba5d3be).
- Theorem: `rustyred-thg-schema` (declared `ObjectType`/`FieldSpec`, observed
  shapes, conformance, the SR6 record verbs) and `rustyred-thg-mcp`'s GraphQL
  (`dataModel`, `dataRecords`, `dataRecord`, `declareSchema`, `pinObserved`,
  `unpinDeclared`).

## Shape

- **`RecordTable("<object>")`**: one declared type's records. Index panel:
  Records lists every declared object; each opens `default:records:<name>`.
- **`DataModel()` / `DataModel("<object>")`**: the objects page with a diagram
  preview and Visualize, an object's fields and relations, and what records carry
  that is not declared yet. Opens at `default:data-model[:<name>]`.
- **Expanded record**: the Index working pane. A record item is
  `record:<name_singular>/<id>`; documents keep bare ids.

Both components read Theorem themselves rather than through a view binding, so
an agent-composed view can place a table beside an Atlas or a list.

## Decisions

| Decision                 | Choice                                                                                                                               | Why                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Object model             | The schema register over `/graphql`, not Commonplace's `/rest/metadata`                                                              | The register is the flexible model: Observe/Warn/Reject enforcement, observed shapes, divergences and promotion. Commonplace mirrors Twenty's fixed metadata |
| Writes to records        | `invokeRecordVerb(objectTypeId, verb, input)`, the SR6 verbs at the register's owner                                                 | GraphQL has no record mutation yet and a Theorem client must not call `/mcp`; until the mutation exists the UI says so and keeps nothing it could not save   |
| Schema edits             | Whole re-declaration through `declareSchema` with `expected_content_anchor`                                                          | The register owns the anchor; a stale edit comes back as a conflict instead of overwriting another person's change                                           |
| Twenty's composite types | Display hints in the type's `extensions["theorem.ui"]` (email, link, phone, currency, percent, rating) over the register's few types | The register stays small; the hint travels with the declaration                                                                                              |
| Table                    | TanStack Table v9 through the app's kit hook, TanStack Virtual for rows                                                              | The kit's filter, sort and view-options lists come with it; row selection was re-added to the shared features                                                |
| Diagram                  | `@xyflow/react` 12, laid out by a small layered layout in `records/layout.ts`                                                        | elkjs is only a transitive dependency; the layout is deterministic and tested                                                                                |
| View arrangement         | localStorage per view (sorts, filters, order, widths, visibility, footer)                                                            | Until record view state lives in Theorem (`upsertDataView`); see the checklist                                                                               |
| Menus, popovers          | coss ui `menu`, `popover`, `checkbox`, vendored as the other coss components are                                                     | The app's component choice for these                                                                                                                         |
| Tests                    | `bun test` over the pure modules: aggregates, schema edits, layout, record decoding, built-in programs parsed by OpenUI              | No new runner                                                                                                                                                |
