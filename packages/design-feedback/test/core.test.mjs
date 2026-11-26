import assert from 'node:assert/strict'
import test from 'node:test'
import { compareGeometry, contrastRatio, inspectDesign, validateObservation } from '../core.mjs'

const element = (id = 'paragraph', overrides = {}) => ({
  id, selector: `#${id}`, identity: 'explicit', tag: 'p',
  rect: { x: 20, y: 40, width: 300, height: 48 },
  viewportRect: { x: 20, y: 40, width: 300, height: 48 },
  interactive: false, disabled: false,
  text: {
    value: 'Readable paragraph', complete: true,
    fontSize: 16, fontWeight: 400, fontFamily: 'system-ui', lineHeight: 24,
    color: '#000000', background: '#ffffff', paintStatus: 'resolved', paintReasons: [],
    lineCount: 2, graphemeCount: 18, averageGraphemesPerLine: 9, readingMeasureEligible: true,
  },
  ...overrides,
})
const observation = (elements = [element()]) => ({
  schemaVersion: 'design-feedback/v1',
  capture: {
    id: 'test', url: 'https://example.test/', timestamp: '2026-01-01T00:00:00Z', evidenceKind: 'fixture',
    viewport: { width: 800, height: 600, dpr: 1 }, scroll: { x: 0, y: 0 },
    document: { width: 800, height: 800 }, colorScheme: 'light', reducedMotion: false, fontsStatus: 'loaded',
  },
  elements,
  coverage: { nodesSeen: elements.length, elementsMeasured: elements.length, omitted: 0, complete: true, limitations: [] },
})
const rule = (report, name) => report.findings.find((finding) => finding.rule === name)

test('opaque sRGB contrast uses real luminance and rejects unsupported paint', () => {
  assert.equal(contrastRatio('#000', '#fff'), 21)
  assert.equal(contrastRatio('rgb(0 0 0)', 'rgb(100% 100% 100%)'), 21)
  assert.equal(contrastRatio('rgba(0, 0, 0, 1)', '#ffffff'), 21)
  assert.equal(contrastRatio('rgba(0, 0, 0, .5)', '#ffffff'), null)
  assert.equal(contrastRatio('color(display-p3 0 0 0)', '#ffffff'), null)
  assert.equal(contrastRatio('rgb(0 invalid 0)', '#fff'), null)
  assert.equal(contrastRatio('rgb(256 0 0)', '#fff'), null)
})

test('text contrast applies unrounded minimums and exact CSS large-text boundaries', () => {
  const fixture = observation()
  fixture.elements[0].text.color = '#777777'
  const normal = rule(inspectDesign(fixture), 'color.text-contrast')
  assert.equal(normal.status, 'fail')
  assert.ok(normal.measured.ratio > 4.47 && normal.measured.ratio < 4.5)
  fixture.elements[0].text.fontSize = 24
  assert.equal(rule(inspectDesign(fixture), 'color.text-contrast').status, 'pass')
  fixture.elements[0].text.fontSize = 23.999
  assert.equal(rule(inspectDesign(fixture), 'color.text-contrast').status, 'fail')
  fixture.elements[0].text.fontSize = 56 / 3
  fixture.elements[0].text.fontWeight = 700
  assert.equal(rule(inspectDesign(fixture), 'color.text-contrast').expected.minimumRatio, 3)
  fixture.elements[0].text.fontSize -= 0.0001
  assert.equal(rule(inspectDesign(fixture), 'color.text-contrast').expected.minimumRatio, 4.5)
})

test('unknown paint is not converted into a pass even with favorable color strings', () => {
  const fixture = observation()
  fixture.elements[0].text.paintStatus = 'unknown'
  fixture.elements[0].text.paintReasons = ['Gradient behind text.']
  assert.equal(rule(inspectDesign(fixture), 'color.text-contrast').status, 'unknown')
  fixture.elements[0].text.paintStatus = 'resolved'
  assert.equal(rule(inspectDesign(fixture), 'color.text-contrast').status, 'unknown')
})

test('targets and diagnostics do not claim standard conformance', () => {
  const fixture = observation([element('small', { interactive: true, rect: { x: 0, y: 0, width: 12, height: 14 } })])
  fixture.capture.document.width = 950
  fixture.elements[0].text.lineHeight = 16
  const report = inspectDesign(fixture, { lineHeight: { min: 1.4, max: 1.8 }, readingMeasure: { min: 45, max: 80 } })
  for (const name of ['interaction.target-box', 'type.line-height', 'type.reading-measure']) {
    assert.equal(rule(report, name).authority, 'target')
    assert.equal(rule(report, name).status, 'review')
  }
  assert.equal(rule(report, 'layout.document-width').authority, 'diagnostic')
  assert.equal(rule(report, 'layout.document-width').status, 'review')
})

test('mixed inline text is an unknown reading measure, not a target pass', () => {
  const fixture = observation()
  fixture.elements[0].text.readingMeasureEligible = false
  const report = inspectDesign(fixture, { readingMeasure: { min: 1, max: 100 } })
  assert.equal(rule(report, 'type.reading-measure').status, 'unknown')
})

test('coverage omissions and unloaded fonts are explicit and bad findings retain priority', () => {
  const fixture = observation([element('good'), element('bad')])
  fixture.coverage.omitted = 50
  fixture.coverage.complete = false
  fixture.capture.fontsStatus = 'loading'
  fixture.elements[1].text.color = '#aaaaaa'
  const report = inspectDesign(fixture, { maxFindings: 1 })
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].status, 'fail')
  assert.equal(report.summary.fail, 1)
  assert.equal(report.summary.unknown, 2)
  assert.equal(report.summary.omitted, 4)
  assert.equal(report.coverage.complete, false)
  assert.equal(report.coverage.omitted, 50)
})

test('untrusted observation validation rejects inconsistent, unbounded and malformed data', () => {
  assert.throws(() => validateObservation(null), TypeError)
  assert.throws(() => validateObservation({}), TypeError)
  const duplicate = observation([element('same'), element('same')])
  assert.throws(() => validateObservation(duplicate), /unique/)
  const invalidGeometry = observation()
  invalidGeometry.elements[0].rect.width = NaN
  assert.throws(() => validateObservation(invalidGeometry), /finite/)
  const invalidCount = observation()
  invalidCount.coverage.elementsMeasured = 2
  assert.throws(() => validateObservation(invalidCount), /elements.length/)
  const huge = observation()
  huge.elements[0].text.value = 'x'.repeat(2001)
  assert.throws(() => validateObservation(huge), /2000/)
  const emptyClaim = observation()
  emptyClaim.coverage.omitted = 1
  assert.throws(() => validateObservation(emptyClaim), /cannot be complete/)
  assert.throws(() => inspectDesign(observation(), { minTargetSize: Infinity }), /finite/)
  assert.throws(() => inspectDesign(observation(), { maxFindings: 0 }), /positive/)
  assert.throws(() => inspectDesign(observation(), { lineHeight: { min: 2, max: 1 } }), /finite/)
  assert.throws(() => inspectDesign(observation(), { minTargetSzie: 24 }), /unsupported policy option/)
  assert.throws(() => inspectDesign(observation(), { lineHeight: { min: 1, max: 2, injected: 'no' } }), /only min and max/)
})

test('report fields do not forward unknown payload keys', () => {
  const fixture = observation()
  fixture.elements[0].overflow = { x: true, y: false, scrollableX: false, scrollableY: false, clientWidth: 50, clientHeight: 50, scrollWidth: 100, scrollHeight: 50, injected: { nested: 'not report data' } }
  const report = inspectDesign(fixture, { lineHeight: { min: 1, max: 2 } })
  assert.equal(rule(report, 'layout.content-overflow').measured.injected, undefined)
  assert.equal(rule(report, 'type.line-height').expected.injected, undefined)
})

test('geometry separates document movement, size, added/removed identity, and unchanged', () => {
  const before = observation([element('moved'), element('resized'), element('removed'), element('steady')])
  const after = structuredClone(before)
  after.elements = after.elements.filter((item) => item.id !== 'removed')
  after.elements.push(element('added'))
  after.elements[0].rect.y += 12
  after.elements[1].rect.width += 24
  const result = compareGeometry(before, after)
  assert.equal(result.matched, 3)
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.unchanged, 1)
  assert.equal(result.changed, 2)
  assert.equal(result.changes[0].kind, 'position')
  assert.deepEqual(result.changes[0].position, { dx: 0, dy: 12 })
  assert.equal(result.changes[1].kind, 'size')
})

test('geometry no-op is clean, shared translation is separate, mismatched context is recorded', () => {
  const before = observation([element('a'), element('b'), element('c'), element('d')])
  assert.equal(compareGeometry(before, structuredClone(before)).changed, 0)
  const after = structuredClone(before)
  after.elements.forEach((item) => { item.rect.y += 30 })
  after.capture.viewport.width = 600
  const result = compareGeometry(before, after, { maxChanges: 2 })
  assert.equal(result.globalTranslation.dy, 30)
  assert.equal(result.globalTranslation.matchedFraction, 1)
  assert.equal(result.changed, 4)
  assert.equal(result.omitted, 2)
  assert.deepEqual(result.coverage.contextChanged, ['viewport.width'])
})
