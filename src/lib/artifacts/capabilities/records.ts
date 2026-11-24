// SOURCING: zod 4's toJSONSchema for each vocabulary component's properties
// (the schemas the renderer validates against); the vocabulary itself is
// @assistant-ui/generative-ui's default library with this app's overrides
// (elements/generative-ui.tsx); @assistant-ui/generative-ui's A2UI converter
// decides which basic-catalog names map onto it. The records are this app's
// own description of what it renders, so they are written here.
//
// What this interface renders, as capability records Theorem indexes for the
// agent's search and describe. A record never gates what the agent writes: it
// makes a format, library or component findable and gives its contract. Every
// example here runs through the checks of the host that draws it
// (records.test.ts).
import { z } from 'zod'
import { styledGenerativeUILibrary } from '@/components/assistant-ui/elements/generative-ui'
import { APP_LIBRARIES } from '@/lib/blocks/app-libraries'
import { importMap } from '@/lib/blocks/vendor/manifest'
import { FRAME_BUILTINS } from '@/lib/notebooks/cells'
import type { CapabilityExample, CapabilityRecord, DocSection } from './contract'

export const OBSERVABLE = 'format:observable'
export const GENERATIVE_UI = 'format:generative-ui'
export const A2UI = 'format:a2ui'

/** Formats the server holds records for, which this page also displays. */
const SERVER_FORMATS = ['format:html-app', 'format:openui', 'format:marimo'] as const

const PRESENT = 'ui.present'
const VIEW = 'ui.view'

/** The version the import map pins for a module, read from its path. */
const pinned = (specifier: string) =>
  /@(\d+\.\d+\.\d+)/.exec((importMap.imports as Record<string, string>)[specifier] ?? '')?.[1] ?? 'unknown'

/** @assistant-ui/generative-ui's version; records.test.ts pins it to the installed package. */
export const RENDERER_VERSION = '0.0.11'

// ── Observable ──────────────────────────────────────────────────────────────

const histogramView = {
  _type: 'View',
  id: 'delivery-times',
  title: 'Delivery times',
  cells: [
    "const bins = view(Inputs.range([5, 40], {label: 'Bins', step: 1, value: 15}))",
    "Plot.plot({marks: [Plot.rectY(data, Plot.binX({y: 'count'}, {x: 'minutes', thresholds: bins, tip: true})), Plot.ruleY([0])]})",
  ],
  data: [
    { minutes: 18 }, { minutes: 22 }, { minutes: 25 }, { minutes: 31 }, { minutes: 19 },
    { minutes: 42 }, { minutes: 27 }, { minutes: 24 }, { minutes: 35 }, { minutes: 21 },
  ],
  caption: 'Most deliveries land between 20 and 30 minutes.',
}

const linkedView = {
  _type: 'View',
  id: 'listings',
  cells: [
    "views.linked(data, {x: 'area', y: 'price', id: 'address', fill: 'district', noun: 'listings'})",
  ],
  data: [
    { address: '12 Elm St', area: 82, price: 410, district: 'North' },
    { address: '4 Bay Rd', area: 64, price: 355, district: 'Harbor' },
    { address: '9 Hill Ave', area: 120, price: 620, district: 'North' },
    { address: '31 Mill Ln', area: 95, price: 450, district: 'Harbor' },
  ],
}

const graphView = {
  _type: 'View',
  id: 'service-map',
  cells: ["views.graph(data, {group: 'team'})"],
  data: {
    nodes: [
      { id: 'checkout', label: 'Checkout', team: 'payments' },
      { id: 'ledger', label: 'Ledger', team: 'payments' },
      { id: 'catalog', label: 'Catalog', team: 'store' },
      { id: 'search', label: 'Search', team: 'store' },
    ],
    links: [
      { source: 'checkout', target: 'ledger' },
      { source: 'checkout', target: 'catalog' },
      { source: 'search', target: 'catalog' },
    ],
  },
}

const timelineView = {
  _type: 'View',
  id: 'release-plan',
  cells: ["views.timeline(data, {lane: 'team', label: 'name'})"],
  data: [
    { name: 'Design review', team: 'Product', start: '2026-03-02', end: '2026-03-06' },
    { name: 'Beta', team: 'Engineering', start: '2026-03-09', end: '2026-03-27' },
    { name: 'Launch', team: 'Marketing', start: '2026-03-30' },
  ],
}

const treeView = {
  _type: 'View',
  id: 'budget',
  cells: ['views.tree(data)'],
  data: {
    name: 'Budget',
    children: [
      { name: 'Staff', value: 540 },
      { name: 'Operations', children: [{ name: 'Rent', value: 120 }, { name: 'Travel', value: 40 }] },
    ],
  },
}

const paramView = {
  _type: 'View',
  id: 'loan',
  cells: [
    "const rate = view(views.param(Inputs.range([1, 10], {label: 'Rate %', step: 0.25, value: 5}), 'rate'))",
    'const payment = (200000 * (rate / 1200)) / (1 - (1 + rate / 1200) ** -360)',
    'md`Monthly payment: **${payment.toFixed(0)}**`',
  ],
}

/** The Observable examples, by what they show; records.test.ts checks every one. */
export const OBSERVABLE_EXAMPLES = {
  histogramView,
  linkedView,
  graphView,
  timelineView,
  treeView,
  paramView,
}

const observableSections: Array<DocSection> = [
  {
    id: 'cells',
    title: 'Writing cells',
    body: [
      'Each string in `cells` is one cell. A cell is an expression (its value is displayed), a block `{ ... }`, or declarations such as `const total = d3.sum(data, (d) => d.value)`; names a cell declares are read by the cells that use them, in any order, and a cell reruns when a name it reads changes.',
      '',
      'The older Observable dialect also compiles: `total = d3.sum(...)`, `viewof k = Inputs.range(...)`, `mutable count = 0`.',
      '',
      '- One cell defines each name. To change a value from another cell, declare it `mutable x = ...` and assign `mutable x = ...` where it changes.',
      '- An input is read by value with `view(Inputs.range(...))` or `viewof k = Inputs.range(...)`. Without either, cells that read it get the element.',
      '- `display(value)` shows more than one value from a cell; `width` is the frame width; `invalidation` is a promise that resolves when the cell reruns or the view closes, so release timers, observers and WebGL contexts there.',
      '- `md`, `html`, `svg` and `tex` are tagged templates for text, markup and math.',
    ].join('\n'),
  },
  {
    id: 'data',
    title: 'Data in, state out',
    body: [
      '`data` is any JSON passed beside `cells`; cells read it as `data`. Keep it to what the view needs: rows of records, `{nodes, links}`, a nested tree.',
      '',
      'What the reader selects in a `views` helper, and every input wrapped in `views.param`, becomes context for their next message, with the records chosen. A view saved with `ui.view` keeps that state and reopens where it was left: `saved` is what it was saved with.',
      '',
      'Notebook Kit\'s sample datasets (`penguins`, `cars`, `weather`, `olympians`, `aapl`, `miserables` and others) and `FileAttachment` load from the network when a cell reads them.',
    ].join('\n'),
  },
  {
    id: 'imports',
    title: 'Libraries and imports',
    body: [
      'd3, Plot, Inputs and htl are read by name, the versions the frame vendors. `import` with a bare specifier resolves through the frame\'s import map (`d3`, `@observablehq/plot`, `@observablehq/inputs`, `htl`); any other module is a URL the frame imports, as a page would, such as `import confetti from "https://esm.sh/canvas-confetti@1"`.',
      '',
      'Notebook Kit also defines `duckdb`, `aq` (Arquero), `Arrow`, `echarts`, `L` (Leaflet), `mapboxgl`, `vl` (Vega-Lite), `topojson`, `mermaid`, `dot`, `React` and `ReactDOM`; each loads from the network the first time a cell reads it.',
    ].join('\n'),
  },
  {
    id: 'lifecycle',
    title: 'Present, receive, repair, save',
    body: [
      '`ui.present` with a `View` node shows it inline. Give the view an `id`: presenting it again in the same reply with that `id` draws the new revision where the view first appeared and nowhere else, so a repair leaves no broken copy behind. Presented alone, the View is revised inside the paint it stood in; presented in a fuller paint, that paint replaces the earlier one whole. In a later reply the new revision is drawn there.',
      '',
      'The receipt comes once each view has settled, or after 15 seconds. `views` gives, for each, `id` (the revision when it has none), `revision` and `stage`: `accepted` (no page started it), `compiled` (its cells built into a page the frame had not started), `mounted` (cells still running when the wait ended), `ready` (every cell shows its first value), `partial` (some cells failed) or `failed` (every cell failed, or the page did not build). Then `displayed`, `failed` and `pending` list cell ids (`c1` is the first cell), `shows` says what each displayed cell shows (its value as the inspector shows it collapsed, each name it defines with its value, or an element\'s labelled parts with their mark counts, such as `line ×0`), `errors` holds what the page raised, `waiting` says when pending cells wait on a page the reader is not looking at (a background tab or hidden window), which is no fault in them, and on a page that draws `blocking` names each pending cell the others wait on, with the cells waiting on it: the cell to read when a view stays `mounted`. `warnings` names cells that will not run as written (a parse error, a name two cells define, a name nothing defines) before they run.',
      '',
      '`ui.view` with `{id, action: "inspect"}` answers the same for the view as it is now, with `selection`: the reader\'s words for what they picked, its record `ids` and the `state` they set (moved `params`, brushes, focused nodes). `{id, action: "save"}` saves the view as an App that opens with that state, and answers its `documentId`.',
    ].join('\n'),
  },
]

const present = (title: string, view: Record<string, unknown>): CapabilityExample => ({
  title,
  operation: PRESENT,
  arguments: view,
})

const observable: CapabilityRecord = {
  id: OBSERVABLE,
  kind: 'format',
  version: `notebook-kit ${pinned('@observablehq/notebook-kit/runtime')}`,
  title: 'Observable view',
  summary:
    'Observable JavaScript cells that run live in the reply, each in a frame of its own: the reader moves inputs, brushes ranges and picks records without a model turn, and what they select comes back as context. Cells read `data`, d3, Plot, Inputs and the `views` helpers.',
  affordances: [
    'interactive chart', 'exploratory analysis', 'live data exploration', 'reactive cells',
    'sliders and inputs', 'what-if parameters', 'filter and drill down', 'brush selection',
    'linked views', 'selection as context', 'custom visualization', 'animation', 'simulation',
    'notebook', 'save a view with its state',
  ],
  related: ['library:plot', 'library:d3', 'library:inputs', 'library:htl', 'component:View',
    'component:views.linked', 'component:views.graph', 'component:views.tree', 'component:views.timeline',
    'component:views.param'],
  accepts:
    '`ui.present` with a `View` node: `{_type: "View", id, cells: string[], data?, title?, caption?, source?, sourceUrl?}`, at the root or nested in a composed tree.',
  language:
    'Observable JavaScript as Notebook Kit compiles it; the older Observable dialect (`viewof`, `mutable`, `x = ...`) also compiles.',
  runsIn:
    'A frame of its own in the reply, sandboxed with allow-scripts, on the reader\'s page; @observablehq/runtime runs the cells.',
  provides: [...FRAME_BUILTINS].filter((name) => !name.startsWith('@')),
  imports:
    'Bare specifiers resolve through the frame\'s import map (d3, @observablehq/plot, @observablehq/inputs, htl); any other module is imported by URL.',
  dataIn: '`data` beside `cells`, read by the cells as `data`; `saved` holds the state a saved view reopens with.',
  resultsOut:
    'The receipt reports each view\'s id, revision and stage, which cells displayed, failed or are pending, what each displayed cell shows, and the errors the page raised, once the view settles; `ui.view` inspect reads the same later with the reader\'s selection, which also arrives as context with their next message.',
  lifecycle: [
    { action: 'present', operation: PRESENT },
    { action: 'revise', operation: PRESENT },
    { action: 'inspect', operation: VIEW },
    { action: 'retain', operation: VIEW },
  ],
  requires: { executor: 'browser' },
  retains: ['selection', 'brush extents and chosen records', 'parameters the reader moved'],
  sections: observableSections,
  examples: [
    present('A histogram with a bin-count input', histogramView),
    present('A scatter linked to a table of what the brush holds', linkedView),
    present('A rate the reader moves, and what follows from it', paramView),
  ],
}

// ── Libraries ───────────────────────────────────────────────────────────────

const plot: CapabilityRecord = {
  id: 'library:plot',
  kind: 'library',
  version: pinned('@observablehq/plot'),
  title: 'Observable Plot',
  summary:
    'Concise charts from marks and data: dots, lines, areas, bars, cells, ticks, rules, text and geographic shapes, with binning, grouping, stacking, faceting, tooltips and scales chosen from the data.',
  affordances: [
    'histogram', 'bar chart', 'line chart', 'scatter plot', 'area chart', 'heatmap', 'box plot',
    'small multiples', 'faceting', 'distribution', 'binning', 'grouping', 'stacked bars',
    'regression line', 'density', 'tooltip', 'choropleth map', 'time series',
  ],
  related: [OBSERVABLE, 'library:d3'],
  import: 'Plot',
  formats: [OBSERVABLE],
  reference: 'https://observablehq.com/plot/api',
  examples: [present('Binned counts with a tooltip', histogramView)],
}

const d3: CapabilityRecord = {
  id: 'library:d3',
  kind: 'library',
  version: pinned('d3'),
  title: 'D3',
  summary:
    'The full d3 library: scales, axes, shapes, hierarchies, force simulations, geographic projections, color schemes, brushing, zooming, transitions, and parsing and formatting of numbers, dates and CSV.',
  affordances: [
    'custom visualization', 'force-directed layout', 'hierarchy layout', 'treemap', 'sunburst',
    'geographic projection', 'zoom and pan', 'brushing', 'transitions', 'color scale', 'csv parsing',
    'date formatting', 'statistics', 'svg drawing',
  ],
  related: [OBSERVABLE, 'library:plot'],
  import: 'd3',
  formats: [OBSERVABLE],
  reference: 'https://d3js.org/api',
}

const inputs: CapabilityRecord = {
  id: 'library:inputs',
  kind: 'library',
  version: pinned('@observablehq/inputs'),
  title: 'Observable Inputs',
  summary:
    'Form controls a cell reads by value: range sliders, number and text fields, search, select menus, radios, checkboxes, toggles, buttons, date and color pickers, and a table whose selected rows are its value.',
  affordances: [
    'slider', 'dropdown', 'checkbox', 'radio buttons', 'toggle', 'text field', 'search box',
    'date picker', 'color picker', 'button', 'selectable table', 'form',
  ],
  related: [OBSERVABLE, 'component:views.param'],
  import: 'Inputs',
  formats: [OBSERVABLE],
  reference: 'https://observablehq.com/framework/inputs',
}

const htl: CapabilityRecord = {
  id: 'library:htl',
  kind: 'library',
  version: pinned('htl'),
  title: 'Hypertext Literal',
  summary: 'Tagged templates that build DOM: `html` and `svg` interpolate values, elements and event handlers safely.',
  affordances: ['custom markup', 'svg markup', 'event handlers', 'layout of cell output'],
  related: [OBSERVABLE],
  import: 'htl',
  formats: [OBSERVABLE],
  reference: 'https://github.com/observablehq/htl',
}

const ASTRYX = APP_LIBRARIES['@theorem/ui']!.dependencies['@astryxdesign/core']!

const ui: CapabilityRecord = {
  id: 'library:@theorem/ui',
  kind: 'library',
  version: ASTRYX,
  title: 'Theorem UI',
  summary:
    "Astryx's controls in Theorem's theme for an App or a notebook cell: slider, number, switch, checkbox, toggle, button, segmented control, selector and text input, plus a Stage for the picture and a Dock that floats its controls over it. A control given `control` can be read and moved by the agent while the App runs.",
  affordances: [
    'slider', 'number input', 'switch', 'checkbox', 'toggle button', 'button', 'segmented control',
    'dropdown', 'text field', 'parameter panel', 'controls over a canvas', 'play and pause',
    'reset', 'agent-operable controls', 'theme tokens', 'responsive layout',
  ],
  related: ['format:html-app', OBSERVABLE],
  import: '@theorem/ui',
  formats: ['format:html-app', OBSERVABLE],
  reference: 'https://astryx.atmeta.com/components',
  sections: [
    {
      id: 'controls',
      title: 'Controls, and the agent reaching them',
      body: [
        "`Slider`, `NumberInput`, `Switch`, `CheckboxInput`, `ToggleButton`, `Button`, `SegmentedControl`, `Selector` and `TextInput` take Astryx's props unchanged (https://astryx.atmeta.com/components/<Name>).",
        '',
        "Each also takes `control`, a name. While the App runs, `app.control` lists its named controls with their values and ranges, sets one (a number is clamped to its range and step) or presses a button, and answers with the value read back.",
        '',
        "A control the kit does not have registers itself the same way: `useControl(name, { label, kind, read, set, invoke, min, max, step, options })` in React, or `theorem.controls.register(spec)`, which returns what unregisters it. `kind` is `number`, `boolean`, `choice`, `text` or `action`.",
      ].join('\n'),
    },
    {
      id: 'stage',
      title: 'Stage and Dock',
      body: [
        "`<Stage aspect=\"16 / 9\" narrowAspect=\"1\">` is the picture: full width, its height from its aspect, so a resize never changes what it is drawing. A canvas, video or image inside it fills it.",
        '',
        "`<Dock panel={...}>` floats over the Stage: its children are the few controls that are always there (a primary action first), and Parameters opens `panel`. `DockRow` spans the panel for presets or secondary actions.",
        '',
        '```tsx',
        "import { Button, Dock, Slider, Stage, mount } from '@theorem/ui'",
        '',
        'mount(document.getElementById(\'root\')!, (',
        '  <Stage>',
        '    <canvas ref={draw} />',
        '    <Dock panel={<Slider label="Feed" value={feed} min={0.01} max={0.09} step={0.0001} control="feed" onChange={setFeed} />}>',
        '      <Button label={running ? \'Pause\' : \'Play\'} control="pause" onClick={toggle} />',
        '    </Dock>',
        '  </Stage>',
        '))',
        '```',
      ].join('\n'),
    },
    {
      id: 'notebook',
      title: 'In a notebook cell',
      body: [
        "A cell imports it as any module: `const ui = await import('@theorem/ui')`. `ui.mount(element, node)` renders React into an element in Theorem's theme and returns what unmounts it; pass that to `invalidation` so a re-run leaves nothing registered. As a view, the element's `value` is what other cells read:",
        '',
        '```js',
        "const ui = await import('@theorem/ui')",
        "const { createElement: h, useState } = await import('react')",
        "const root = Object.assign(document.createElement('div'), { value: 3 })",
        'function K() {',
        '  const [k, setK] = useState(3)',
        "  const moved = (v) => { setK(v); root.value = v; root.dispatchEvent(new Event('input')) }",
        "  return h(ui.Slider, { label: 'k', value: k, min: 0, max: 10, control: 'k', onChange: moved })",
        '}',
        'invalidation.then(ui.mount(root, h(K)))',
        'const k = view(root)',
        '```',
      ].join('\n'),
    },
    {
      id: 'presentation',
      title: 'Where it is shown',
      body: [
        "`theorem.presentation.now()` is `{ mode, width, height }`: `mode` is `inline` in a reply, `panel` beside the conversation or `expanded`, and `height` is the room it has. `theorem.presentation.onChange(listener)` hears each change and returns what stops it. The frame also sets `data-theorem-presentation` on the root element and `--theorem-available-width` and `--theorem-available-height`. Moving between them does not reload the App.",
      ].join('\n'),
    },
  ],
}

// ── Theorem's views helpers ─────────────────────────────────────────────────

const accessor = { description: 'A field name, or a function of (row, index).' }
const select = ['select']
const viewProps = (properties: Record<string, unknown>, required: Array<string> = []) => ({
  type: 'object',
  properties: { ...properties, key: { type: 'string', description: 'The name its state is saved under.' }, height: { type: 'number' } },
  ...(required.length && { required }),
})

const viewsComponents: Array<CapabilityRecord> = [
  {
    id: 'component:views.linked',
    kind: 'component',
    version: '1',
    title: 'Linked scatter and table',
    summary:
      'A Plot of records with a brush, linked to a table of what the brush holds: `views.linked(rows, {x, y, id, fill, label, mark})`. The brushed records become context for the reader\'s next message.',
    affordances: ['brush selection', 'linked table', 'scatter plot', 'compare records', 'select records', 'outliers'],
    related: [OBSERVABLE, 'library:plot'],
    formats: [OBSERVABLE],
    props: viewProps(
      {
        x: accessor, y: accessor, id: accessor, label: accessor, fill: accessor,
        r: { description: 'Radius: a number or an accessor.' },
        columns: { type: 'array', items: { type: 'string' } },
        noun: { type: 'string', description: 'What a record is called, in the caption.' },
        mark: { enum: ['dot', 'line'] },
      },
      ['x', 'y'],
    ),
    events: select,
    implemented: true,
    retains: ['brush extent', 'selected records'],
    examples: [present('Listings by area and price', linkedView)],
  },
  {
    id: 'component:views.graph',
    kind: 'component',
    version: '1',
    title: 'Force-directed graph',
    summary:
      'Nodes and links laid out by force: `views.graph({nodes, links}, {id, label, group})`, where a link\'s `source` and `target` name node ids. Choosing a node selects it with its neighbours.',
    affordances: ['network graph', 'relationships between entities', 'dependencies', 'neighbours', 'clusters', 'node link diagram'],
    related: [OBSERVABLE, 'library:d3', 'component:Graph'],
    formats: [OBSERVABLE],
    props: viewProps({ id: { type: 'string' }, label: { type: 'string' }, group: { type: 'string' } }),
    events: select,
    implemented: true,
    retains: ['chosen node'],
    examples: [present('Services and what they call', graphView)],
  },
  {
    id: 'component:views.tree',
    kind: 'component',
    version: '1',
    title: 'Zoomable hierarchy',
    summary:
      'A hierarchy as a zoomable icicle: `views.tree(root, {name, children, value})`. Leaves are sized by `value`; choosing a cell zooms to it and selects it.',
    affordances: ['hierarchy', 'breakdown', 'part of a whole', 'drill down', 'icicle', 'budget breakdown', 'file sizes'],
    related: [OBSERVABLE, 'library:d3'],
    formats: [OBSERVABLE],
    props: viewProps({ name: { type: 'string' }, children: { type: 'string' }, value: { type: 'string' } }),
    events: select,
    implemented: true,
    retains: ['zoomed cell'],
    examples: [present('A budget, by line', treeView)],
  },
  {
    id: 'component:views.timeline',
    kind: 'component',
    version: '1',
    title: 'Timeline with a brush',
    summary:
      'Events on lanes in time order: `views.timeline(events, {start, end, lane, label, id})`. Brushing along time selects the events the range overlaps.',
    affordances: ['timeline', 'schedule', 'gantt', 'events over time', 'select a time range', 'lanes'],
    related: [OBSERVABLE, 'component:Timeline'],
    formats: [OBSERVABLE],
    props: viewProps({
      start: { type: 'string' }, end: { type: 'string' }, lane: { type: 'string' },
      label: { type: 'string' }, id: { type: 'string' },
    }),
    events: select,
    implemented: true,
    retains: ['brushed range'],
    examples: [present('A release plan by team', timelineView)],
  },
  {
    id: 'component:views.param',
    kind: 'component',
    version: '1',
    title: 'Parameter the reply assumed',
    summary:
      'Wraps an input the prose was written for: `view(views.param(Inputs.range(...), name))`. When the reader moves it off the value the reply assumed, the view says so, and its value travels with their next message.',
    affordances: ['what-if parameter', 'assumption the reader can change', 'sensitivity', 'slider'],
    related: [OBSERVABLE, 'library:inputs'],
    formats: [OBSERVABLE],
    props: {
      type: 'object',
      properties: { input: { description: 'An Inputs element.' }, name: { type: 'string' } },
      required: ['input'],
    },
    events: ['input'],
    implemented: true,
    retains: ['value'],
    examples: [present('A loan rate the reader moves', paramView)],
  },
]

// ── The composed-interface vocabulary ───────────────────────────────────────

/**
 * The A2UI basic-catalog names @assistant-ui/generative-ui's converter maps
 * onto the vocabulary, by the vocabulary name they become.
 */
const A2UI_NAMES: Record<string, Array<string>> = {
  Text: ['Text'], Image: ['Image'], Icon: ['Icon'], Row: ['Row', 'List (horizontal)'], Col: ['Column'],
  ListView: ['List'], Card: ['Card'], Divider: ['Divider'], Button: ['Button'], Input: ['TextField'],
  Checkbox: ['CheckBox'], Select: ['ChoicePicker'], RadioGroup: ['ChoicePicker'],
  CheckboxGroup: ['ChoicePicker'], DatePicker: ['DateTimeInput'], Slider: ['Slider'], Tabs: ['Tabs'],
}

/** Basic-catalog names the converter keeps but no renderer here draws as themselves. */
const A2UI_UNDRAWN: Record<string, string> = {
  Video: 'A video player.',
  AudioPlayer: 'An audio player.',
  Modal: 'A dialog opened by a trigger component, holding a content component.',
}

const FROM_PROPS =
  'drawn from what it carries: its label and value as one fact (or, when it fires an action, a live button), each other plain property as a fact, then its children'

const ACTION_COMPONENTS = new Set([
  'Button', 'Select', 'Input', 'DatePicker', 'Checkbox', 'Slider', 'RadioGroup', 'CheckboxGroup', 'Form',
  'ListViewItem',
])

const schemaOf = (properties: unknown) => {
  try {
    return z.toJSONSchema(properties as z.ZodType, { unrepresentable: 'any' })
  } catch {
    return {}
  }
}

const vocabularyExamples: Record<string, Record<string, unknown>> = {
  Chart: {
    _type: 'Chart', variant: 'bar', title: 'Orders by weekday',
    data: [{ label: 'Mon', value: 42 }, { label: 'Tue', value: 51 }, { label: 'Wed', value: 47 }],
  },
  Table: {
    _type: 'Table',
    columns: [{ label: 'Plan' }, { label: 'Seats', align: 'end' }, { label: 'Price', align: 'end', format: { kind: 'currency', currency: 'USD' } }],
    rows: [['Team', 10, 120], ['Business', 50, 540]],
  },
  Timeline: {
    _type: 'Timeline',
    items: [{ time: '09:00', title: 'Doors open' }, { time: '10:30', title: 'Keynote' }],
  },
  Graph: {
    _type: 'Graph',
    nodes: [{ id: 'draft', label: 'Draft' }, { id: 'review', label: 'Review', dependsOn: ['draft'] }],
  },
  Card: {
    _type: 'Card', title: 'Option B',
    children: [{ _type: 'Fact', label: 'Cost', value: '$1,240' }, { _type: 'Fact', label: 'Lead time', value: '3 weeks' }],
  },
  View: histogramView,
}

/** The vocabulary components' examples; records.test.ts checks each against its schema. */
export const VOCABULARY_EXAMPLES = vocabularyExamples

const vocabulary: Array<CapabilityRecord> = Object.entries(styledGenerativeUILibrary).map(([name, definition]) => {
  const a2ui = A2UI_NAMES[name]
  const description = definition.description.trim() || name
  const example = vocabularyExamples[name]
  return {
    id: `component:${name}`,
    kind: 'component',
    version: RENDERER_VERSION,
    title: name,
    summary: description.length > 560 ? `${description.slice(0, 557)}...` : description,
    affordances: a2ui ? a2ui.map((alias) => `A2UI ${alias}`) : [],
    related: name === 'View' ? [GENERATIVE_UI, OBSERVABLE] : [GENERATIVE_UI, ...(a2ui ? [A2UI] : [])],
    formats: a2ui ? [GENERATIVE_UI, A2UI] : [GENERATIVE_UI],
    props: schemaOf(definition.properties),
    events: ACTION_COMPONENTS.has(name) ? ['action'] : [],
    implemented: true,
    ...(name === 'View' && { requires: { executor: 'browser' as const } }),
    ...(example && { examples: [present(`A ${name}`, example)] }),
  }
})

const undrawn: Array<CapabilityRecord> = Object.entries(A2UI_UNDRAWN).map(([name, summary]) => ({
  id: `component:a2ui.${name}`,
  kind: 'component',
  version: '0.9',
  title: `A2UI ${name}`,
  summary: `${summary} The A2UI basic catalog names it; no renderer here draws it as itself.`,
  affordances: [`A2UI ${name}`],
  related: [A2UI],
  formats: [A2UI],
  props: { type: 'object' },
  implemented: false,
  fallback: FROM_PROPS,
}))

// ── Composed interfaces and A2UI ────────────────────────────────────────────

const decision = {
  _type: 'Col',
  gap: 3,
  children: [
    { _type: 'Header', text: 'Two ways to ship' },
    {
      _type: 'Row', gap: 3,
      children: [
        { _type: 'Card', title: 'Ship Friday', children: [{ _type: 'Fact', label: 'Risk', value: 'Medium' }] },
        { _type: 'Card', title: 'Ship Monday', children: [{ _type: 'Fact', label: 'Risk', value: 'Low' }] },
      ],
    },
    {
      _type: 'Button', label: 'Go with Monday',
      _action: { type: 'a2ui:action', name: 'choose', userMessage: 'Go with Monday.' },
    },
  ],
}

const a2uiSurface = {
  a2ui: [
    { version: 'v0.9', createSurface: { surfaceId: 'rsvp', catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json' } },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'rsvp',
        components: [
          { id: 'root', component: 'Column', children: ['title', 'confirm'] },
          { id: 'title', component: 'Text', text: 'Dinner on Thursday at 7?' },
          { id: 'confirm', component: 'Button', child: 'confirm-label', action: { event: { name: 'rsvp', context: { answer: 'yes' } } } },
          { id: 'confirm-label', component: 'Text', text: 'I will be there' },
        ],
      },
    },
  ],
}

/** The tree and A2UI examples; records.test.ts paints each. */
export const PRESENT_EXAMPLES = { decision, a2uiSurface }

const actionsOut =
  'An `_action` of `{type: "a2ui:action", name, userMessage?, context?}` sends the reader\'s choice as their next message; `{type: "a2ui:functionCall", call: "openUrl", args: {url}}` opens a web address.'

const generativeUi: CapabilityRecord = {
  id: GENERATIVE_UI,
  kind: 'format',
  version: RENDERER_VERSION,
  title: 'Composed interface',
  summary:
    'A tree of components the reply draws: headings, text, facts, cards, rows and columns, tables, lists, steps, timelines, charts, maps, diagrams, tabs, forms and inputs whose choices come back to the agent, and live Observable views.',
  affordances: [
    'layout', 'comparison of options', 'summary card', 'dashboard', 'form', 'checklist', 'table', 'steps',
    'timeline', 'chart', 'map', 'diagram', 'tabs', 'buttons the reader clicks',
  ],
  related: [A2UI, OBSERVABLE],
  accepts:
    '`ui.present` with a tree: the root\'s `_type` names a component, its properties sit beside it, and `children` holds nodes or a string.',
  language: 'JSON nodes `{_type, ...properties, children?, _action?}`.',
  runsIn: 'The reader\'s page, drawn by @assistant-ui/generative-ui over Theorem\'s vocabulary; a View node runs its cells in a frame of its own.',
  imports: 'None: a tree names components. A View node carries Observable cells (format:observable).',
  dataIn: 'Inline, in each component\'s properties.',
  resultsOut: `The receipt names what was painted and warns of any component drawn from its properties rather than as itself. ${actionsOut}`,
  lifecycle: [{ action: 'present', operation: PRESENT }],
  sections: [
    {
      id: 'components',
      title: 'Components',
      body: vocabulary.map((record) => `- \`${record.title}\`: ${record.summary.split('. ')[0]}.`).join('\n')
        + '\n\nA name the vocabulary does not hold is still drawn, from what it carries. `describe` a component (`component:<Name>`) for its properties.',
    },
    { id: 'actions', title: 'Actions', body: actionsOut },
  ],
  examples: [present('Two options and a choice', decision)],
}

const a2ui: CapabilityRecord = {
  id: A2UI,
  kind: 'format',
  version: 'v0.9, v0.9.1, v1.0',
  title: 'A2UI surface',
  summary:
    'A2UI messages in any catalog, reduced into surfaces the reply draws. The basic catalog maps onto Theorem\'s vocabulary; a component the vocabulary does not hold is drawn from what it carries, and its actions stay live.',
  affordances: ['A2UI', 'agent to UI protocol', 'surface', 'data model binding', 'custom catalog', 'form with bound fields'],
  related: [GENERATIVE_UI, ...undrawn.map((record) => record.id)],
  accepts:
    '`ui.present` with `a2ui`: messages, each stamped `"version"` and holding one of createSurface, updateComponents, updateDataModel or deleteSurface.',
  language:
    'A2UI JSON. A component is a flat object `{id, component: "Type", ...properties}`; a parent names its children by id; one component has the id `root`.',
  runsIn: 'The reader\'s page: @assistant-ui/generative-ui reduces the messages and converts each surface to a tree.',
  imports: 'None. `catalogId` names the catalog; components of any catalog are accepted.',
  dataIn: 'updateDataModel sets values that components bind to by path.',
  resultsOut:
    'The receipt names each painted surface, the reducer\'s warnings, and every component drawn from its properties rather than as itself. An action the reader fires comes back as their next message with its context; openUrl opens a web address.',
  lifecycle: [{ action: 'present', operation: PRESENT }],
  sections: [
    {
      id: 'basic-catalog',
      title: 'How the basic catalog is drawn',
      body: [
        ...Object.entries(A2UI_NAMES).map(([to, from]) => `- ${from.join(', ')} draws as \`${to}\``),
        ...Object.keys(A2UI_UNDRAWN).map((name) => `- ${name} is ${FROM_PROPS}`),
        '',
        `Any other component, in any catalog, is ${FROM_PROPS}.`,
      ].join('\n'),
    },
  ],
  examples: [present('An RSVP with a live button', a2uiSurface)],
}

/** Every record this interface publishes. */
export const INTERFACE_RECORDS: ReadonlyArray<CapabilityRecord> = [
  observable, generativeUi, a2ui,
  plot, d3, inputs, htl, ui,
  ...viewsComponents, ...vocabulary, ...undrawn,
]

/**
 * The record ids this page displays, for each send's clientSurface: its own
 * formats and components, and the formats the server holds records for that
 * the page shows as artifacts. A library has nothing of its own to show.
 */
export const DISPLAYED_CAPABILITIES: ReadonlyArray<string> = [
  ...INTERFACE_RECORDS.filter((record) => record.kind !== 'library').map((record) => record.id),
  ...SERVER_FORMATS,
]
