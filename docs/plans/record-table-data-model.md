# Record tables and the data model in the Index

Twenty's record table and data model settings, rebuilt over Theorem's schema
register and placed in the Index as two library components a view program
composes like any other. The checklist is `record-table-data-model.checklist.json`.

## Replaced by the CRM table (2026-11-16)

The owner decided that the CRM's table replaces this plan's generic records
table everywhere, and that the CRM lives in the Index rather than at its own
`/crm` route. `src/components/records/record-table.tsx` and
`record-inspector.tsx` were removed. The CRM table, the data model and the work
tracker use this plan's other modules (`aggregate.ts`, `view-state.ts`,
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

What the generic table had that the CRM table did not, and what was brought
back into the CRM table afterwards (2026-11-16; the checklist rows say where
each lives and which test covers it):

- Restored: the per-column menu (Search, Sort, Move left and right, Hide; the
  identifier column only Search and Sort) and the "+" column that shows hidden
  fields again and opens the data model to customize them. As in Twenty, the
  menu opens when the column's header is clicked (Enter or Space from the
  keyboard); a click no longer sorts. Search on any column opens the view
  bar's search.
- Restored and extended (2026-11-16): the view bar's Search reads every shown
  field of a record (its name, its other fields as they show, the titles of
  records it points to), case-insensitively, through TanStack's global filter;
  `q` stays in the address. Sort is a list of rules (field, direction, remove;
  Add sort, Clear sorts) and rows sort by the first rule, then the next. The
  address keeps the first rule in `sort` and `desc` as before and the rest in
  `then`, as `key1:desc,key2`. The header menu's Sort replaces the whole list
  with its one rule.
- Restored: a column header is dragged to a new place among the movable
  columns (not the checkbox column or the pinned identifier) with @dnd-kit. A
  pointer drag starts after 4 px, so a click still opens the menu; the
  keyboard picks a column up with Alt and Space or Enter, as bare Space and
  Enter open the menu. The drop is `table.setColumnOrder`, which the saved
  arrangement keeps. Move left and Move right remain.
- Restored, behind a setting: the Calculate row (Count, Percent, Date, More
  options, saved per view). It shows only when Settings, Appearance,
  "Calculations under record tables" is on (off by default, kept per browser);
  off, the footer is the dataset count.
- Restored: shift-click range marking, CSV export of the marked rows (else the
  rows the filter leaves, the columns shown in order, named `<plural>.csv`)
  from the marked-row actions and from Options (a text cell a spreadsheet
  would run as a formula is written with a leading apostrophe), column resizing by the header
  edge, Tab and Shift+Tab across cells, and Backspace or Delete to empty a
  cell through the same revision-checked write the editor makes.
- Each view's column order, widths, hidden fields and calculations follow
  the person: they are kept in this browser (`useRecordLayouts`, localStorage
  `theorem-ui:record-layouts`; the earlier `theorem.crm.view:<key>` entries are
  read once) and synced to the person's Theorem preferences
  (`/api/chat/v1/preferences`, key `recordLayouts`, the 50 most recently
  changed within 32 KB; every write carries the keys it does not own back
  unchanged). Reset arrangement in Options forgets a view's layout. Search,
  sort and the previewed record stay in the address.

Still absent from the CRM table: and/or filter rules, putting fields in order
from a list (a column moves by drag or with Move left and Move right),
virtualized rows, and rectangle drag-select. Two browsers changing layouts
at the same moment: the later write wins for the whole map.

The CRM table brings revision-checked writes with visible stale refusals,
bounded update of marked records, the record page with history, and the
measurements of Theorem's CRM spec.

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
| View arrangement         | localStorage per view (sorts, filters, order, widths, visibility, footer)                                                            | Synced to the person's Theorem preferences as `recordLayouts`; search and sort stay in the address; see the checklist                                        |
| Menus, popovers          | coss ui `menu`, `popover`, `checkbox`, vendored as the other coss components are                                                     | The app's component choice for these                                                                                                                         |
| Tests                    | `bun test` over the pure modules: aggregates, schema edits, layout, record decoding, built-in programs parsed by OpenUI              | No new runner                                                                                                                                                |
