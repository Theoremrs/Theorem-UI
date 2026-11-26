import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appDesignFeedback,
  APP_DESIGN_MAX_ELEMENTS,
  APP_DESIGN_MAX_ISSUES,
  APP_DESIGN_MAX_NODES,
  APP_DESIGN_MAX_PLACES,
  schemesDesignFeedback,
  unavailableDesign,
} from '../../src/lib/blocks/app-design.ts'

const observation = () => ({
  schemaVersion: 'design-feedback/v1',
  capture: {
    id: 'artifact-check', url: 'about:blank', timestamp: '2026-01-01T00:00:00.000Z',
    evidenceKind: 'rendered-artifact', viewport: { width: 1024, height: 768, dpr: 1 },
    scroll: { x: 0, y: 0 }, document: { width: 1024, height: 768 },
    colorScheme: 'light', reducedMotion: false, fontsStatus: 'loaded',
  },
  elements: [{
    id: 'id:title', selector: '#title', identity: 'explicit', tag: 'p',
    source: 'main.tsx:12:3', rect: { x: 24, y: 24, width: 400, height: 24 },
    viewportRect: { x: 24, y: 24, width: 400, height: 24 }, interactive: false, disabled: false,
    text: {
      value: 'This text has insufficient contrast.', complete: true,
      fontSize: 16, fontWeight: 400, fontFamily: 'sans-serif', lineHeight: 24,
      color: 'rgb(190, 190, 190)', background: 'rgb(255, 255, 255)',
      paintStatus: 'resolved', paintReasons: [], lineCount: 1,
      graphemeCount: 36, averageGraphemesPerLine: 36,
    },
  }],
  coverage: { nodesSeen: 1, elementsMeasured: 1, omitted: 0, complete: true, limitations: [] },
})

test('sandbox DOM observations produce localized evaluated feedback', () => {
  const result = appDesignFeedback(observation(), 'artifact-check')
  assert.equal(result.status, 'measured')
  assert.equal(result.evidence, 'sandbox-reported-dom')
  assert.deepEqual(result.capture.viewport, { width: 1024, height: 768, dpr: 1 })
  assert.ok(result.report.issues.some((issue) =>
    issue.status === 'fail' && issue.authority === 'standard' &&
    issue.rule === 'color.text-contrast' && issue.at.includes('main.tsx:12:3')))
  assert.ok(result.report.issues.every((issue) => issue.status !== 'pass'))
  assert.deepEqual(result.schemes, ['light'])
  assert.ok(result.report.summary.light.pass > 0)
})

test('a missing, stale or wrong-kind capture never becomes a clean report', () => {
  assert.equal(appDesignFeedback(null, 'artifact-check').status, 'unavailable')
  assert.equal(appDesignFeedback(observation(), 'another-check').status, 'unavailable')
  const wrongKind = observation()
  wrongKind.capture.evidenceKind = 'rendered-web'
  assert.equal(appDesignFeedback(wrongKind, 'artifact-check').status, 'unavailable')
})

test('malformed and oversized sandbox replies are rejected before reporting', () => {
  assert.equal(appDesignFeedback({ elements: 'wrong' }, 'artifact-check').status, 'unavailable')
  const nonfinite = observation()
  nonfinite.elements[0].rect.width = NaN
  assert.equal(appDesignFeedback(nonfinite, 'artifact-check').status, 'unavailable')
  const oversized = { ...observation(), padding: '\u{1f440}'.repeat(150000) }
  assert.equal(appDesignFeedback(oversized, 'artifact-check').status, 'unavailable')
  const tooMany = observation()
  tooMany.elements = Array.from({ length: APP_DESIGN_MAX_ELEMENTS + 1 }, (_, i) => ({
    ...tooMany.elements[0], id: `id:p${i}`, selector: `#p${i}`,
  }))
  tooMany.coverage.nodesSeen = tooMany.coverage.elementsMeasured = tooMany.elements.length
  assert.equal(appDesignFeedback(tooMany, 'artifact-check').status, 'unavailable')
  const excessiveScan = observation()
  excessiveScan.coverage.nodesSeen = APP_DESIGN_MAX_NODES + 1
  assert.equal(appDesignFeedback(excessiveScan, 'artifact-check').status, 'unavailable')
})

test('repeated problems are one issue at many places, so distinct ones are not crowded out', () => {
  const many = observation()
  many.elements = Array.from({ length: 100 }, (_, i) => ({
    ...many.elements[0], id: `id:p${i}`, selector: `html > body:nth-of-type(1) > div > p:nth-of-type(${i + 1})`,
    source: i < 3 ? `main.tsx:${12 + i}:3` : undefined,
  }))
  many.elements.push({
    ...observation().elements[0], id: 'id:faint', selector: '#faint', source: 'main.tsx:40:5',
    text: { ...observation().elements[0].text, color: 'rgb(230, 230, 230)' },
  })
  many.coverage.nodesSeen = many.coverage.elementsMeasured = many.elements.length
  const result = appDesignFeedback(many, 'artifact-check')
  assert.equal(result.status, 'measured')
  const contrast = result.report.issues.filter((issue) => issue.rule === 'color.text-contrast')
  assert.equal(contrast.length, 2)
  const repeated = contrast.find((issue) => issue.count === 100)
  assert.ok(repeated)
  assert.equal(repeated.at.length, APP_DESIGN_MAX_PLACES)
  assert.deepEqual(repeated.at.slice(0, 4), ['main.tsx:12:3', 'main.tsx:13:3', 'main.tsx:14:3', 'div > p:nth-of-type(4)'])
  assert.ok(contrast.some((issue) => issue.count === 1 && issue.at[0] === 'main.tsx:40:5'))
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 8 * 1024)
})

test('bounded reports retain omission counts and uncertainty', () => {
  const many = observation()
  many.elements = Array.from({ length: 100 }, (_, i) => ({
    ...many.elements[0], id: `id:p${i}`, selector: `#p${i}`,
    text: { ...many.elements[0].text, color: `rgb(${150 + i}, ${150 + i}, ${150 + i})` },
  }))
  many.coverage.nodesSeen = many.coverage.elementsMeasured = many.elements.length
  many.coverage.complete = false
  many.coverage.omitted = 20
  many.coverage.limitations = ['The element limit was reached.']
  const result = appDesignFeedback(many, 'artifact-check')
  assert.equal(result.status, 'measured')
  assert.equal(result.report.issues.length, APP_DESIGN_MAX_ISSUES)
  assert.ok(result.report.omittedIssues > 0)
  assert.equal(result.report.coverage.complete, false)
  assert.equal(result.report.coverage.omitted, 20)
  assert.ok(result.report.summary.light.fail >= 100)
})

test('unavailability is explicit and bounded', () => {
  assert.deepEqual(unavailableDesign('The App was not run.'), {
    status: 'unavailable', reason: 'The App was not run.',
  })
  assert.equal(unavailableDesign('x'.repeat(1000)).reason.length, 400)
})

test('sandbox capture metadata is copied by field rather than forwarding hidden payloads', () => {
  const input = observation()
  input.capture.viewport.unknown = 'x'.repeat(400000)
  input.capture.document.nested = { instruction: 'untrusted metadata' }
  const result = appDesignFeedback(input, 'artifact-check')
  assert.equal(result.status, 'measured')
  assert.deepEqual(result.capture.viewport, { width: 1024, height: 768, dpr: 1 })
  assert.deepEqual(result.capture.document, { width: 1024, height: 768 })
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 128 * 1024)
})

test('an App measured in both schemes lists a shared issue once and names the scheme of one found in only one', () => {
  const light = observation()
  light.elements.push({
    id: 'id:chips', selector: '#chips', identity: 'explicit', tag: 'div', source: 'main.tsx:30:5',
    rect: { x: 24, y: 60, width: 330, height: 64 }, viewportRect: { x: 24, y: 60, width: 330, height: 64 },
    interactive: false, disabled: false, wrap: { kind: 'flex', rows: [3, 1] },
  })
  light.coverage.nodesSeen = light.coverage.elementsMeasured = light.elements.length
  const dark = structuredClone(light)
  dark.capture.id = 'artifact-check-dark'
  dark.capture.colorScheme = 'dark'
  // Readable in dark: light grey on near black.
  dark.elements[0].text.background = 'rgb(28, 29, 30)'
  const result = schemesDesignFeedback([
    { scheme: 'light', captureId: 'artifact-check', value: light },
    { scheme: 'dark', captureId: 'artifact-check-dark', value: dark },
  ])
  assert.equal(result.status, 'measured')
  assert.deepEqual(result.schemes, ['light', 'dark'])
  assert.equal(result.unmeasured, undefined)
  assert.ok(result.report.summary.light.fail > 0)
  assert.equal(result.report.summary.dark.fail, 0)
  const contrast = result.report.issues.find((issue) => issue.rule === 'color.text-contrast')
  assert.deepEqual(contrast.schemes, ['light'])
  const lone = result.report.issues.filter((issue) => issue.rule === 'layout.lone-wrapped-item')
  assert.equal(lone.length, 1)
  assert.equal(lone[0].schemes, undefined)
  assert.equal(lone[0].count, 1)
  assert.deepEqual(lone[0].at, ['main.tsx:30:5'])
  assert.ok(result.report.coverage.limitations.some((item) => item.includes('script')))
})

test('a scheme that was not measured is named with its reason, and a capture in the wrong scheme is refused', () => {
  const partial = schemesDesignFeedback([
    { scheme: 'light', captureId: 'artifact-check', value: observation() },
    { scheme: 'dark', reason: 'The App did not answer the dark design measurement within 5 s.' },
  ])
  assert.equal(partial.status, 'measured')
  assert.deepEqual(partial.schemes, ['light'])
  assert.equal(partial.unmeasured.scheme, 'dark')
  assert.ok(partial.report.issues.every((issue) => issue.schemes === undefined))
  const mislabelled = schemesDesignFeedback([
    { scheme: 'dark', captureId: 'artifact-check', value: observation() },
  ])
  assert.equal(mislabelled.status, 'unavailable')
  assert.match(mislabelled.reason, /scheme/)
})
