// SOURCING: playwright-core through ./lib and the Chrome DevTools Protocol (CSS.getPlatformFontsForNode for the face a node was really drawn in); the WCAG 2.2 relative-luminance contrast formula; the geometry targets of SPEC-THEOREM-CRM-LIFE-CONTEXT-1.0's design references.
//
// Measures the mounted CRM against the geometry the spec takes from Twenty's
// record screens. Each check is reported on its own as pass, fail, review or
// not_measurable; there is no overall score, and a number that matches is not
// a judgment that the screen looks right. The reference screenshots are
// compared by a person, from the captures this writes.
//
// Needs the stack and the records `crm-context.mjs` saves:
//
//   node scripts/e2e/crm-context.mjs
//   node scripts/e2e/crm-geometry.mjs
//
// Writes <E2E_DATA_DIR>/crm-geometry.json and crm-geometry-*.png beside the
// other shots. Every record it adds is synthetic and is removed at the end.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, UI } from './config.mjs'
import { READ, SHOTS, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const LONG_TABLE = 40
const session = await open('/crm/people')
const { page, context, problems } = session
const { writing } = turns(session)
const report = []

/** One measured relationship. `result` is never averaged with another. */
function record(id, authority, expectation, measured, result, note = '') {
  report.push({ id, authority, expectation, measured, result, note })
  console.log(
    `${result.toUpperCase().padEnd(14)} ${id}  expected ${expectation}; measured ${JSON.stringify(measured)}${note ? `  (${note})` : ''}`,
  )
}
const within = (value, low, high) =>
  value === null || value === undefined
    ? 'not_measurable'
    : value >= low && value <= high
      ? 'pass'
      : 'fail'
/** A fixed size, to the nearest device pixel. */
const exactly = (id, expectation, value, target) =>
  record(
    id,
    'target',
    expectation,
    value,
    within(value, target - 1, target + 1),
  )

async function graphql(query, variables = {}) {
  const response = await context.request.fetch(`${UI}/graphql`, {
    ...READ,
    method: 'POST',
    headers: await writing({ 'Content-Type': 'application/json' }),
    data: { query, variables },
  })
  const body = await response.json().catch(() => ({}))
  if (body.errors?.length || !body.data)
    throw new Error(
      `GraphQL refused: ${JSON.stringify(body.errors ?? response.status())}`,
    )
  return body.data
}
const verb = async (objectTypeId, name, input) => {
  const out = (
    await graphql(
      `
        mutation RecordVerb(
          $objectTypeId: String!
          $verb: String!
          $input: JSON!
        ) {
          invokeRecordVerb(
            objectTypeId: $objectTypeId
            verb: $verb
            input: $input
          )
        }
      `,
      { objectTypeId, verb: name, input },
    )
  ).invokeRecordVerb
  return out?.record ?? out
}

/** Size and place of the first element a selector finds, in CSS pixels. */
const box = (selector) =>
  page.evaluate((query) => {
    const node = document.querySelector(query)
    if (!node) return null
    const { x, y, width, height } = node.getBoundingClientRect()
    const round = (n) => Math.round(n * 100) / 100
    return {
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
    }
  }, selector)

/** Declared type of the first element a selector finds. */
const type = (selector) =>
  page.evaluate((query) => {
    const node = document.querySelector(query)
    if (!node) return null
    const style = getComputedStyle(node)
    return {
      family: style.fontFamily,
      size: Number.parseFloat(style.fontSize),
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
    }
  }, selector)

/** The faces the browser really drew a node's text in, by glyph count. */
const devtools = await context.newCDPSession(page)
async function faces(within) {
  const marked = await page.evaluate((query) => {
    const walk = document.createTreeWalker(
      document.querySelector(query) ?? document.createElement('i'),
      NodeFilter.SHOW_TEXT,
    )
    for (let text = walk.nextNode(); text; text = walk.nextNode())
      if (text.data.trim())
        return text.parentElement.setAttribute('data-face-probe', '') ?? true
    return false
  }, within)
  if (!marked) return null
  const selector = '[data-face-probe]'
  await devtools.send('DOM.enable')
  await devtools.send('CSS.enable')
  const { root } = await devtools.send('DOM.getDocument')
  const { nodeId } = await devtools.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  })
  if (!nodeId) return null
  const { fonts } = await devtools.send('CSS.getPlatformFontsForNode', {
    nodeId,
  })
  await page.evaluate(() =>
    document
      .querySelector('[data-face-probe]')
      ?.removeAttribute('data-face-probe'),
  )
  return fonts.map((font) => ({
    family: font.familyName,
    glyphs: font.glyphCount,
  }))
}

/**
 * WCAG contrast of a node's text against the ground behind it, from computed
 * colors: translucent grounds are laid over the ancestors beneath them. This
 * is the pair the styles declare for this state, not sampled pixels.
 */
const contrast = (selector) =>
  page.evaluate((query) => {
    const node = document.querySelector(query)
    if (!node) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ink = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = (color) => {
      ink.clearRect(0, 0, 1, 1)
      ink.fillStyle = color
      ink.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ink.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (top, under) => [
      ...[0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])),
      1,
    ]
    const layers = []
    for (let at = node; at; at = at.parentElement) {
      const ground = rgba(getComputedStyle(at).backgroundColor)
      if (ground[3] > 0) layers.push(ground)
      if (ground[3] === 1) break
    }
    if (!layers.length || layers.at(-1)[3] !== 1) return null
    const ground = layers.reduceRight((under, top) => over(top, under))
    const text = over(rgba(getComputedStyle(node).color), ground)
    const luminance = ([r, g, b]) => {
      const linear = (c) => {
        const s = c / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
    const [light, dark] = [luminance(text), luminance(ground)].sort(
      (a, b) => b - a,
    )
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
  }, selector)

const shot = async (name) => {
  // Rest the pointer on empty ground, so no tooltip or hover is in the capture.
  const { width, height } = page.viewportSize()
  await page.mouse.move(width / 2, height * 0.7)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `crm-geometry-${name}.png`) })
}
// Screens are reached the way a person reaches them, inside the loaded app.
// A second full page load of the unbundled dev server can crash the browser.
const navigator = page.locator('nav[aria-label="CRM"]')
const visit = async (plural, ready) => {
  await navigator
    .getByRole('button', { name: new RegExp(`^${plural}\\b`) })
    .click()
  await ready().waitFor({ timeout: 60_000 })
}
const overflow = () =>
  page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)

// The long table: synthetic organizations, removed again at the end.
const types = Object.fromEntries(
  (
    await graphql('{ dataModel(includeObserved: false) { objectTypes } }')
  ).dataModel.objectTypes.map((each) => [each.name_singular, each]),
)
const run = randomUUID().slice(0, 8)
// A run that was cut short leaves its organizations behind; clear them first.
for (const stale of (
  await verb(types.Organization.object_type_id, 'find_many', {
    limit: 1000,
    offset: 0,
  })
).records ?? [])
  if (stale.id.startsWith('org:geometry-'))
    await verb(types.Organization.object_type_id, 'delete_one', {
      id: stale.id,
      expected_revision: stale.version,
    })
const FIRST = [
  'Alder',
  'Birch',
  'Cedar',
  'Dune',
  'Ember',
  'Fern',
  'Garnet',
  'Harbor',
]
const SECOND = ['Press', 'Pottery', 'Workshop', 'Bakery', 'Print Room']
const added = []
for (let n = 0; n < LONG_TABLE; n++)
  added.push(
    await verb(types.Organization.object_type_id, 'create_one', {
      id: `org:geometry-${run}-${n}`,
      name: `${FIRST[n % FIRST.length]} ${SECOND[n % SECOND.length]} ${n + 1}`,
    }),
  )
const addedAt = Date.now()
log('added', added.length, 'organizations')

try {
  // 1. People, sparse (reference M03).
  await page
    .getByRole('grid')
    .getByText('Noor', { exact: true })
    .first()
    .waitFor({ timeout: 120_000 })
  const viewport = page.viewportSize()
  const nav = await box('nav[aria-label="CRM"]')
  const main = await box('section[aria-label="People"]')
  record(
    'navigator.width',
    'target',
    '256 px, between 220 and 300',
    nav?.width ?? null,
    within(nav?.width, 220, 300),
    "the shell panel is the person's to resize; this is its width in a fresh profile",
  )
  // Theorem's sheet sits inside the window by a small inset; Twenty's fills it.
  const sheet = await box('.sheet')
  const inset = sheet ? viewport.width - (sheet.x + sheet.width) : null
  record(
    'width.budget',
    'contract',
    'rail + navigator + table + sheet inset = viewport width, with nothing left over',
    nav && main && sheet
      ? {
          rail: nav.x,
          navigator: nav.width,
          table: main.width,
          sheetInset: inset,
          viewport: viewport.width,
        }
      : null,
    nav && main && sheet
      ? Math.abs(nav.x + nav.width + main.width + inset - viewport.width) <= 1
        ? 'pass'
        : 'fail'
      : 'not_measurable',
    "the inset is the shell's, a Theorem adaptation: the sheet floats inside the window",
  )
  exactly(
    'table.page-header.height',
    '44 px',
    (await box('section[aria-label="People"] [data-crm-region="page-header"]'))
      ?.height ?? null,
    44,
  )
  exactly(
    'table.view-bar.height',
    '40 px',
    (await box('section[aria-label="People"] [data-crm-region="view-bar"]'))
      ?.height ?? null,
    40,
  )
  exactly(
    'table.row.height',
    '36 px (dense)',
    (await box('[role="grid"] [role="rowgroup"]:nth-of-type(2) [role="row"]'))
      ?.height ?? null,
    36,
  )
  record(
    'table.header-row.height',
    'diagnostic',
    'no target in the spec; Twenty draws 32 px',
    (await box('[role="grid"] [role="rowgroup"]:first-of-type [role="row"]'))
      ?.height ?? null,
    'review',
  )
  exactly(
    'table.identifier-column.width',
    '220 px',
    (await box('[role="grid"] [role="columnheader"]:nth-of-type(2)'))?.width ??
      null,
    220,
  )

  const cell = '[role="gridcell"][data-r="0"][data-c="0"]'
  const cellType = await type(cell)
  const drawn = await faces(cell)
  record(
    'type.table.face',
    'target',
    'IBM Plex Sans is the face drawn',
    { declared: cellType?.family, drawn },
    !drawn?.length
      ? 'not_measurable'
      : drawn.every((font) => font.family.startsWith('IBM Plex Sans'))
        ? 'pass'
        : 'fail',
    'the drawn face is read from the browser, not from the stylesheet',
  )
  record(
    'type.table.size',
    'target',
    '13 to 14 px',
    cellType?.size ?? null,
    within(cellType?.size, 13, 14),
  )
  const navRow = await type('nav[aria-label="CRM"] button')
  record(
    'type.navigator.size',
    'target',
    '13 to 14 px',
    navRow?.size ?? null,
    within(navRow?.size, 13, 14),
  )
  const count = await type('section[aria-label="People"] footer')
  record(
    'type.metadata.size',
    'target',
    '12 px',
    count?.size ?? null,
    within(count?.size, 12, 12),
  )

  for (const [id, selector] of [
    ['contrast.table.cell', cell],
    [
      'contrast.table.column-header',
      '[role="grid"] [role="columnheader"]:nth-of-type(2)',
    ],
    ['contrast.table.count', 'section[aria-label="People"] footer'],
    [
      'contrast.view-bar.count',
      '[data-crm-region="view-bar"] span:nth-of-type(2)',
    ],
    ['contrast.navigator.row', 'nav[aria-label="CRM"] button'],
  ]) {
    const ratio = await contrast(selector)
    record(
      id,
      'standard',
      'WCAG 2.2 AA, at least 4.5:1',
      ratio,
      ratio === null ? 'not_measurable' : ratio >= 4.5 ? 'pass' : 'fail',
      'dark appearance, resting state, from computed colors',
    )
  }
  await shot('1-people-sparse')

  // The navigator read its counts while the organizations were being added.
  const saved = (
    await verb(types.Organization.object_type_id, 'find_many', {
      limit: 1,
      offset: 0,
    })
  ).count
  const counted = await navigator
    .getByRole('button', { name: /^Organizations\b/ })
    .locator('[aria-label$="records"]')
    .innerText()
    .catch(() => null)
  record(
    'freshness.navigator-count',
    'diagnostic',
    'records added outside the screen are counted',
    {
      shown: counted,
      saved,
      secondsSinceTheyWereAdded: Math.round((Date.now() - addedAt) / 1000),
    },
    'review',
    'a read is kept for 15 s and nothing tells the screen about a write made elsewhere',
  )
  await page.waitForTimeout(Math.max(0, 16_000 - (Date.now() - addedAt)))

  // 2. Organizations, long (reference M01).
  await visit('Organizations', () =>
    page.getByRole('grid').getByText(`Alder Press 1`, { exact: true }).first(),
  )
  await page
    .locator('section[aria-label="Organizations"] footer')
    .filter({ hasText: String(saved) })
    .waitFor({ timeout: 60_000 })
  const heights = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[role="grid"] [role="rowgroup"]:nth-of-type(2) [role="row"]',
      ),
    ].map((row) => Math.round(row.getBoundingClientRect().height * 100) / 100),
  )
  record(
    'table.long.rows-uniform',
    'contract',
    `every row 36 px, at least ${LONG_TABLE} rows`,
    { rows: heights.length, heights: [...new Set(heights)] },
    heights.length >= LONG_TABLE &&
      heights.every((height) => Math.abs(height - 36) <= 1)
      ? 'pass'
      : 'fail',
  )
  const headerBefore = await box(
    '[role="grid"] [role="rowgroup"]:first-of-type',
  )
  await page
    .getByRole('grid')
    .evaluate((grid) => grid.scrollTo(0, grid.scrollHeight))
  const headerAfter = await box('[role="grid"] [role="rowgroup"]:first-of-type')
  const scrolled = await page
    .getByRole('grid')
    .evaluate((grid) => grid.scrollTop)
  record(
    'table.long.header-stays',
    'contract',
    'the column headers stay in place while the rows scroll',
    {
      scrolledBy: scrolled,
      headerTopBefore: headerBefore?.y,
      headerTopAfter: headerAfter?.y,
    },
    scrolled > 0 && headerBefore && headerAfter
      ? Math.abs(headerBefore.y - headerAfter.y) <= 1
        ? 'pass'
        : 'fail'
      : 'not_measurable',
  )
  const said = await page
    .locator('section[aria-label="Organizations"] footer')
    .innerText()
  record(
    'table.long.count-is-the-dataset',
    'contract',
    'the count shown is the number saved, not the number drawn',
    { shown: said, saved },
    saved === undefined
      ? 'not_measurable'
      : said.includes(String(saved))
        ? 'pass'
        : 'fail',
  )
  await shot('2-organizations-long-scrolled')
  await page.getByRole('grid').evaluate((grid) => grid.scrollTo(0, 0))
  await shot('2-organizations-long')

  // 5. Several selected (reference M02).
  for (const name of ['Alder Press 1', 'Birch Pottery 2'])
    await page
      .getByRole('checkbox', { name: `Select ${name}`, exact: true })
      .click()
  const bar = await box(
    'section[aria-label="Organizations"] [data-crm-region="view-bar"]',
  )
  record(
    'selection.bar.height',
    'contract',
    "selecting records does not change the view bar's 40 px",
    bar?.height ?? null,
    within(bar?.height, 39, 41),
  )
  record(
    'selection.bounded-update',
    'target',
    'a bounded update panel for the selected records, as in M02',
    await page.locator('[data-crm-region="view-bar"]').innerText(),
    'fail',
    'only a count and Delete are offered; there is no bulk update',
  )
  await shot('5-selected')
  for (const name of ['Alder Press 1', 'Birch Pottery 2'])
    await page
      .getByRole('checkbox', { name: `Select ${name}`, exact: true })
      .click()

  // 3. People with the preview (reference M04).
  await visit('People', () =>
    page.getByRole('grid').getByText('Noor', { exact: true }).first(),
  )
  await page
    .getByRole('grid')
    .getByText('Noor', { exact: true })
    .first()
    .click()
  await page.locator('aside[aria-label^="Person"]').waitFor()
  const preview = await box('aside[aria-label^="Person"]')
  exactly('preview.width', '420 px', preview?.width ?? null, 420)
  exactly(
    'preview.header.height',
    "44 px, level with the table's",
    (await box('aside[aria-label^="Person"] > header'))?.height ?? null,
    44,
  )
  const beside = await box('section[aria-label="People"]')
  record(
    'preview.width.budget',
    'contract',
    "table + preview reach the sheet's edge, with nothing left over",
    nav && beside && preview
      ? { table: beside.width, preview: preview.width }
      : null,
    nav && beside && preview
      ? Math.abs(
          beside.x + beside.width + preview.width + inset - viewport.width,
        ) <= 1
        ? 'pass'
        : 'fail'
      : 'not_measurable',
  )
  record(
    'preview.no-page-scroll',
    'contract',
    'the page does not scroll sideways',
    await overflow(),
    (await overflow()) <= 0 ? 'pass' : 'fail',
  )
  await shot('3-people-preview')

  // 4. The full record (reference M05).
  await page
    .locator('aside[aria-label^="Person"]')
    .getByRole('button', { name: 'Open', exact: true })
    .first()
    .click()
  await page
    .locator('[data-crm-region="property-column"]')
    .waitFor({ timeout: 60_000 })
  exactly(
    'record.property-column.width',
    '300 px',
    (await box('[data-crm-region="property-column"]'))?.width ?? null,
    300,
  )
  exactly(
    'record.page-header.height',
    '44 px',
    (await box('section[aria-label="Person"] [data-crm-region="page-header"]'))
      ?.height ?? null,
    44,
  )
  exactly(
    'record.tab-bar.height',
    '40 px',
    (await box('section[aria-label="Person"] [data-crm-region="view-bar"]'))
      ?.height ?? null,
    40,
  )
  const title = await type(
    '[data-crm-region="property-column"] button[title^="Rename"], [data-crm-region="property-column"] span.truncate',
  )
  record(
    'type.record-title.size',
    'target',
    '18 to 20 px',
    title?.size ?? null,
    within(title?.size, 18, 20),
  )
  const label =
    '[data-crm-region="property-column"] [role="listitem"] > :first-child'
  const labelRatio = await contrast(label)
  record(
    'contrast.record.property-label',
    'standard',
    'WCAG 2.2 AA, at least 4.5:1',
    labelRatio,
    labelRatio === null
      ? 'not_measurable'
      : labelRatio >= 4.5
        ? 'pass'
        : 'fail',
    'dark appearance, resting state, from computed colors',
  )
  const cut = await page.evaluate(() => {
    const out = { writing: [], names: [] }
    for (const node of document.querySelectorAll(
      '[data-crm-region="property-column"] [role="listitem"] span',
    ))
      if (!node.children.length && node.scrollWidth > node.clientWidth + 1)
        (node.closest('button, a') ? out.names : out.writing).push(
          node.textContent,
        )
    return out
  })
  record(
    'record.writing-shown-whole',
    'contract',
    'no written value on the record page is cut off',
    cut.writing,
    cut.writing.length ? 'fail' : 'pass',
  )
  record(
    'record.related-names-shown-whole',
    'diagnostic',
    'the name of a related record fits beside its label',
    cut.names,
    cut.names.length ? 'review' : 'pass',
    'a name that does not fit is shortened; it opens the record it names',
  )
  await shot('4-person-record')

  // 10. Narrower windows: what can be measured is whether the page spills.
  await page
    .locator('section[aria-label="Person"] [data-crm-region="page-header"]')
    .getByRole('button', { name: 'People' })
    .click()
  await page
    .getByRole('grid')
    .getByText('Noor', { exact: true })
    .first()
    .waitFor({ timeout: 60_000 })
  for (const [name, width, height] of [
    ['1024x768', 1024, 768],
    ['390x844', 390, 844],
  ]) {
    await page.setViewportSize({ width, height })
    await page
      .getByRole('grid')
      .waitFor({ timeout: 30_000 })
      .catch(() => {})
    // The shell folds its panel away with a transition; measure what it settles to.
    await page.waitForTimeout(1_000)
    const spill = await overflow()
    const grid = await box('section[aria-label="People"] [role="grid"]')
    record(
      `responsive.${name}.no-page-scroll`,
      'contract',
      'the page does not scroll sideways',
      spill,
      spill <= 0 ? 'pass' : 'fail',
    )
    record(
      `responsive.${name}.table-usable`,
      'target',
      'the table is on screen and at least 280 px wide',
      grid ? { x: grid.x, width: grid.width } : null,
      !grid
        ? 'not_measurable'
        : grid.width >= 280 && grid.x >= 0 && grid.x < width
          ? 'pass'
          : 'fail',
      'whether this layout is good at this size is for a person to say from the capture',
    )
    await shot(`10-people-${name}`)
  }
  await page.setViewportSize(viewport)

  for (const [id, why] of [
    [
      'matrix.6.data-model',
      'the Data model screen is the existing Index view; it was not compared with M06 and M07',
    ],
    [
      'matrix.7.inline-edit',
      'an inline edit was exercised by crm-context.mjs but not captured against M08',
    ],
    [
      'matrix.9.states',
      'proposal, conflict, stale, disconnected and permission-denied states were not mounted',
    ],
    ['matrix.10.light', 'the light appearance was not captured'],
    ['matrix.10.keyboard-focus', 'focus rings were not captured'],
    ['matrix.10.text-size', 'increased text size was not tried'],
    ['matrix.10.reduced-motion', 'reduced motion was not tried'],
  ])
    record(
      id,
      'target',
      'a mounted capture compared with its reference',
      null,
      'not_measurable',
      why,
    )
} finally {
  let left = 0
  for (const each of added)
    await verb(types.Organization.object_type_id, 'delete_one', {
      id: each.id,
      expected_revision: each.version,
    }).catch(() => left++)
  log(
    left
      ? `${left} of the organizations this run added could not be removed`
      : 'removed the organizations this run added',
  )
}

const tally = Object.groupBy(report, (each) => each.result)
writeFileSync(
  join(DATA_DIR, 'crm-geometry.json'),
  `${JSON.stringify(
    {
      viewport: { width: 1440, height: 900, zoom: '100%' },
      appearance: 'dark',
      browser: session.browser.version(),
      note: 'Each check stands alone. There is no overall score.',
      checks: report,
    },
    null,
    2,
  )}\n`,
)
log(
  'results:',
  Object.entries(tally)
    .map(([result, each]) => `${each.length} ${result}`)
    .join(', '),
)
// A measured failure is a finding to read, not a broken scenario, so this
// ends without the pass-or-fail line the other scenarios print.
if (problems.length) log('page and API errors seen:', [...new Set(problems)])
await session.browser.close()
process.exit(0)
