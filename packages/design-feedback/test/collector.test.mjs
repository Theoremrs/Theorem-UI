import assert from 'node:assert/strict'
import test from 'node:test'
import { collectDesignObservations } from '../collect.mjs'
import { inspectDesign, validateObservation } from '../core.mjs'
import { dependency } from '../dependencies.mjs'

const executablePath = process.env.DESIGN_FEEDBACK_TEST_BROWSER

test('real-browser collector retains uncertainty and measures rendered text/geometry', { skip: !executablePath }, async (t) => {
  const loaded = await dependency('playwright-core')
  const { chromium } = loaded.default ?? loaded
  const browser = await chromium.launch({ executablePath, headless: true,
    args: process.env.DESIGN_FEEDBACK_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const prose = 'A useful design measurement reports what was actually rendered and explains which parts it could not measure. '.repeat(5)
  await page.setContent(`<!doctype html><html><head><style>
    html, body { margin: 0; background: #fff; color: #111; font: 16px/24px Arial, sans-serif; }
    main { padding: 20px; width: 400px; }
    p { margin: 0 0 16px; width: 280px; }
    #gradient { background: linear-gradient(90deg, white, black); }
    #pseudo { position: relative; }
    #pseudo::before { content: ''; position: absolute; inset: 0; background: #555; }
    .faded { opacity: .5; }
    button { padding: 0; border: 0; width: 20px; height: 20px; }
    #hidden { visibility: hidden; }
    #transparent { opacity: 0; }
  </style></head><body><main data-theorem-source="src/main.tsx:12:3">
    <p data-design-id="reading">${prose}</p>
    <p id="low" style="color:#aaa">Low contrast text</p>
    <p id="mixed">Mixed inline text <em>emphasized words</em> and other words that wrap across several lines in this small paragraph.</p>
    <p id="gradient">Gradient background</p>
    <p id="pseudo">Generated paint</p>
    <div class="faded"><p id="faded">Opacity on ancestor</p></div>
    <p id="scaled" style="font-size:24px;transform:scale(.5)">Scaled text</p>
    <p id="text-fill" style="-webkit-text-fill-color:#aaa">Different glyph fill</p>
    <div id="hidden"><p id="hidden-child">Not visible</p></div>
    <div id="transparent"><p id="transparent-child">Not visible either</p></div>
    <button id="small" aria-label="Save">+</button>
    <button disabled><span id="disabled-label" style="color:#aaa">Disabled</span></button>
    <input placeholder="Placeholder coverage is separate">
    <span data-design-id="duplicate">First</span><span data-design-id="duplicate">Second</span>
    <div style="height:1000px"></div>
  </main></body></html>`)
  await page.evaluate(() => document.fonts.ready)
  const collected = await page.evaluate(collectDesignObservations, { captureId: 'browser-fixture' })
  const observation = validateObservation(collected)
  const find = (id) => observation.elements.find((element) => element.id === `id:${id}` || element.id === `data-design-id:${id}`)
  const report = inspectDesign(observation, { readingMeasure: { min: 15, max: 70 } })
  const finding = (id, rule = 'color.text-contrast') => report.findings.find((entry) => entry.elementId === find(id)?.id && entry.rule === rule)

  await t.test('long prose has bounded snippet and complete independent line measurement', () => {
    const text = find('reading').text
    assert.equal(text.value.length, 160)
    assert.equal(text.complete, false)
    assert.equal(text.readingMeasureEligible, true)
    assert.ok(text.graphemeCount > 160)
    assert.ok(text.lineCount > 3)
    assert.ok(text.averageGraphemesPerLine > 10 && text.averageGraphemesPerLine < 80)
    assert.equal(find('reading').source, 'src/main.tsx:12:3')
    assert.equal(finding('reading', 'type.reading-measure').status, 'pass')
  })
  await t.test('mixed inline content is not falsely accepted as a complete paragraph measure', () => {
    assert.equal(find('mixed').text.readingMeasureEligible, false)
    assert.equal(find('mixed').text.averageGraphemesPerLine, null)
    assert.equal(finding('mixed', 'type.reading-measure').status, 'unknown')
  })
  await t.test('low contrast fails while unsupported paints remain unknown', () => {
    assert.equal(finding('low').status, 'fail')
    for (const id of ['gradient', 'pseudo', 'faded', 'scaled', 'text-fill']) {
      assert.equal(find(id).text.paintStatus, 'unknown')
      assert.equal(finding(id).status, 'unknown')
    }
    assert.equal(find('hidden-child'), undefined)
    assert.equal(find('transparent-child'), undefined)
    assert.equal(finding('small', 'interaction.target-box').status, 'review')
    assert.equal(find('disabled-label').disabled, true)
    assert.equal(finding('disabled-label'), undefined)
  })
  await t.test('duplicate explicit attributes fall back to distinct valid identities', () => {
    const duplicates = observation.elements.filter((element) => element.tag === 'span' && ['First', 'Second'].includes(element.text?.value))
    assert.equal(duplicates.length, 2)
    assert.equal(duplicates[0].identity, 'selector')
    assert.notEqual(duplicates[0].id, duplicates[1].id)
    assert.equal(new Set(observation.elements.map((element) => element.id)).size, observation.elements.length)
  })
  await t.test('element and scan limits are explicit rather than fake complete coverage', async () => {
    const limited = validateObservation(await page.evaluate(collectDesignObservations, { maxElements: 2 }))
    assert.equal(limited.elements.length, 2)
    assert.ok(limited.coverage.omitted > 0)
    assert.equal(limited.coverage.complete, false)
    const scanned = validateObservation(await page.evaluate(collectDesignObservations, { maxNodes: 2 }))
    assert.equal(scanned.coverage.nodesSeen, 2)
    assert.equal(scanned.coverage.complete, false)
    assert.ok(scanned.coverage.limitations.some((item) => item.includes('lower bound')))
  })
  await t.test('document coordinates stay stable when viewport scrolls', async () => {
    await page.evaluate(() => scrollTo(0, 100))
    const scrolled = validateObservation(await page.evaluate(collectDesignObservations))
    const reading = scrolled.elements.find((element) => element.id === 'data-design-id:reading')
    assert.equal(reading.rect.y, find('reading').rect.y)
    assert.equal(reading.viewportRect.y, find('reading').viewportRect.y - 100)
  })
  await t.test('serialized function works without module closure and marks implicit canvas unknown', async () => {
    await page.setContent('<p id="plain">The canvas background is implicit.</p>')
    const fromSource = await page.evaluate(`(${collectDesignObservations.toString()})({captureId:'source'})`)
    assert.equal(validateObservation(fromSource).capture.id, 'source')
    assert.equal(fromSource.elements.find((element) => element.id === 'id:plain').text.paintStatus, 'unknown')
    assert.ok(fromSource.coverage.limitations.some((item) => item.includes('placeholder')))
  })
})

test('unsupported glyph and background paint cannot produce contrast passes', { skip: !executablePath }, async (t) => {
  const loaded = await dependency('playwright-core')
  const { chromium } = loaded.default ?? loaded
  const browser = await chromium.launch({ executablePath, headless: true,
    args: process.env.DESIGN_FEEDBACK_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`<!doctype html><style>
    html { background: #fff; }
    body { margin: 20px; color: #111; font: 16px/24px Arial, sans-serif; }
    #inset { background: #fff; box-shadow: inset 0 0 0 50px #111; }
    #first-line::first-line { color: #aaa; }
    #first-letter::first-letter { color: #aaa; }
    #pseudo-size { color: #777; font-size: 24px; }
    #pseudo-size::first-line { font-size: 12px; }
    #ancestor::first-line { color: #aaa; }
  </style><body>
    <p id="plain">The ordinary black on white pair remains measurable.</p>
    <p id="inset">Dark glyphs on the inset shadow.</p>
    <p id="first-line">The actual first line is low contrast.</p>
    <p id="first-letter">The actual first letter is low contrast.</p>
    <p id="pseudo-size">The first line does not use the nominal large font.</p>
    <div id="ancestor"><span id="inherited-line">An ancestor styles this line.</span></div>
  </body>`)
  const observation = validateObservation(await page.evaluate(collectDesignObservations))
  const report = inspectDesign(observation)
  const finding = (id) => report.findings.find((entry) => entry.elementId === `id:${id}` && entry.rule === 'color.text-contrast')
  assert.equal(finding('plain').status, 'pass')
  for (const id of ['inset', 'first-line', 'first-letter', 'pseudo-size', 'inherited-line']) {
    assert.equal(finding(id).status, 'unknown', id)
    assert.equal(finding(id).measured.ratio, null, id)
  }
  assert.ok(finding('inset').measured.reasons.some((reason) => reason.includes('inset box shadow')))
  assert.ok(finding('first-line').measured.reasons.some((reason) => reason.includes('first-line')))

  await t.test('an opaque ancestor only supplies paint within its background box', async () => {
    await page.setContent(`<!doctype html><style>
      html { background: #111; }
      body { margin: 0; background: #fff; height: 10px; color: #111; }
      #outside { position: absolute; top: 60px; left: 10px; }
    </style><p id="outside">Dark text lies beyond the short white background.</p>`)
    const current = validateObservation(await page.evaluate(collectDesignObservations))
    const finding = inspectDesign(current).findings.find((entry) => entry.elementId === 'id:outside' && entry.rule === 'color.text-contrast')
    assert.equal(finding.status, 'unknown')
    assert.equal(finding.measured.ratio, null)
    assert.ok(finding.measured.reasons.some((reason) => reason.includes('outside the opaque background box')))
  })

  await t.test('visible display: contents direct text is an explicit coverage omission', async () => {
    await page.setContent(`<!doctype html><style>
      html { background: #fff; }
      body { color: #111; }
      .contents { display: contents; color: #aaa; }
    </style><p id="contents" class="contents">Visible low contrast text without an element box.</p>
    <div hidden><p class="contents">Hidden direct text does not count as omitted.</p></div>
    <div style="opacity:0"><p class="contents">Transparent direct text does not count either.</p></div>`)
    const current = validateObservation(await page.evaluate(collectDesignObservations))
    assert.equal(current.elements.find((element) => element.id === 'id:contents'), undefined)
    assert.equal(current.coverage.omitted, 1)
    assert.equal(current.coverage.complete, false)
    assert.ok(current.coverage.limitations.some((reason) => reason.includes('display: contents')))
    assert.equal(inspectDesign(current).findings.find((entry) => entry.rule === 'coverage').status, 'unknown')
  })
})

test('wrapping rows are counted, and a given canvas and scheme are what is measured against', { skip: !executablePath }, async (t) => {
  const loaded = await dependency('playwright-core')
  const { chromium } = loaded.default ?? loaded
  const browser = await chromium.launch({ executablePath, headless: true,
    args: process.env.DESIGN_FEEDBACK_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`<!doctype html><style>
    body { margin: 0; color: #ddd; font: 16px/24px Arial, sans-serif; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; width: 330px; align-items: center; }
    .chips > span { width: 100px; height: 28px; }
    .chips > span.tall { height: 40px; }
    #grid { display: grid; grid-template-columns: repeat(2, 100px); width: 200px; }
    #grid > i { height: 20px; }
    #single { display: flex; gap: 8px; }
  </style><body>
    <div id="lone" class="chips"><span>1 cup</span><span class="tall">2 tbsp</span><span>1 tsp</span><span>100 g</span><b style="position:absolute">over</b></div>
    <div id="even" class="chips"><span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span></div>
    <div id="grid"><i></i><i></i><i></i></div>
    <div id="single"><span>one row</span><span>only</span></div>
    <p id="plain">Light text on the page behind a transparent document.</p>
  </body>`)
  const observation = validateObservation(await page.evaluate(collectDesignObservations, { canvas: '#1c1d1e', colorScheme: 'dark' }))
  const find = (id) => observation.elements.find((element) => element.id === `id:${id}`)
  assert.equal(observation.capture.colorScheme, 'dark')
  assert.deepEqual(find('lone').wrap, { kind: 'flex', rows: [3, 1] })
  assert.deepEqual(find('even').wrap, { kind: 'flex', rows: [3, 3] })
  assert.deepEqual(find('grid').wrap, { kind: 'grid', rows: [2, 1] })
  assert.equal(find('single').wrap, undefined)
  assert.equal(find('plain').text.background, 'rgb(28, 29, 30)')
  assert.equal(find('plain').text.paintStatus, 'resolved')
  const report = inspectDesign(observation)
  const wrapped = (id) => report.findings.find((entry) => entry.elementId === `id:${id}` && entry.rule === 'layout.lone-wrapped-item')
  assert.equal(wrapped('lone').status, 'review')
  assert.deepEqual(wrapped('lone').measured.rows, [3, 1])
  assert.equal(wrapped('even').status, 'pass')
  assert.equal(wrapped('grid').status, 'review')
  assert.equal(report.findings.find((entry) => entry.elementId === 'id:plain' && entry.rule === 'color.text-contrast').status, 'pass')
})
