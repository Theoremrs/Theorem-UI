import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appDesignFeedback,
  APP_DESIGN_MAX_ELEMENTS,
  APP_DESIGN_MAX_NODES,
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
  assert.ok(result.report.findings.some((finding) =>
    finding.status === 'fail' && finding.authority === 'standard' &&
    finding.source === 'main.tsx:12:3' && finding.evidence.kind === 'rendered-artifact'))
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

test('bounded reports retain omission counts and uncertainty', () => {
  const many = observation()
  many.elements = Array.from({ length: 100 }, (_, i) => ({
    ...many.elements[0], id: `id:p${i}`, selector: `#p${i}`,
  }))
  many.coverage.nodesSeen = many.coverage.elementsMeasured = many.elements.length
  many.coverage.complete = false
  many.coverage.omitted = 20
  many.coverage.limitations = ['The element limit was reached.']
  const result = appDesignFeedback(many, 'artifact-check')
  assert.equal(result.status, 'measured')
  assert.ok(result.report.findings.length <= 40)
  assert.ok(result.report.summary.omitted > 0)
  assert.equal(result.report.coverage.complete, false)
  assert.equal(result.report.coverage.omitted, 20)
  assert.ok(result.report.summary.fail >= 100)
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
