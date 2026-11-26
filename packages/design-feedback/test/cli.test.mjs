import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArguments, runCLI } from '../cli.mjs'
import { normalizeCaptureOptions, validateCaptureURL, redactURL } from '../capture.mjs'
import { escapeHTML } from '../report.mjs'
import { probeIssueDelta } from '../probe.mjs'

test('CLI rejects typos, missing values, and options that a command cannot use', () => {
  assert.throws(() => parseArguments(['captuer', 'http://localhost', '--out', 'x']), /Unknown command/)
  assert.throws(() => parseArguments(['capture', 'http://localhost', '--out']), /Missing value/)
  assert.throws(() => parseArguments(['capture', 'http://localhost', '--out', 'x', '--widht', '320']), /Unknown option/)
  assert.throws(() => parseArguments(['compare', 'a', 'b', '--out', 'c', '--width', '320']), /not supported/)
  assert.throws(() => parseArguments(['inspect', 'a', '--threshold', '0.1']), /only valid/)
})

test('capture validation bounds resource use and rejects credential-bearing URLs', () => {
  assert.throws(() => normalizeCaptureOptions({ width: -1 }), /width/)
  assert.throws(() => normalizeCaptureOptions({ width: 8192, height: 8192, dpr: 3 }), /20 million/)
  assert.throws(() => normalizeCaptureOptions({ maxElements: 5001 }), /max-elements/)
  assert.throws(() => normalizeCaptureOptions({ colorScheme: 'auto' }), /scheme/)
  assert.throws(() => validateCaptureURL('javascript:alert(1)'), /only http/)
  assert.throws(() => validateCaptureURL('https://user:secret@example.com'), /credentials/)
  const redacted = redactURL('https://user:secret@example.com/path?token=secret&x=1#private')
  assert.ok(!redacted.includes('secret'))
  assert.ok(!redacted.includes('private'))
  assert.ok(!redacted.includes('user'))
})

test('HTML findings and labels are escaped', () => {
  assert.equal(escapeHTML('<script a="b">&\'</script>'), '&lt;script a=&quot;b&quot;&gt;&amp;&#39;&lt;/script&gt;')
})

test('capabilities describes evidence limits without opening a browser', async () => {
  let output
  assert.equal(await runCLI(['capabilities'], (value) => { output = value }), 0)
  assert.equal(output.schemaVersion, 'design-feedback/v1')
  assert.ok(output.limitations.some((line) => line.includes('aesthetic score')))
})

test('inspect writes a JSON result and protects an existing output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'design-feedback-inspect-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const observation = {
    schemaVersion: 'design-feedback/v1', capture: { id: 'test', url: 'fixture:', timestamp: '2026-01-01T00:00:00Z', evidenceKind: 'fixture', viewport: { width: 800, height: 600, dpr: 1 }, scroll: { x: 0, y: 0 }, document: { width: 900, height: 600 }, colorScheme: 'light', reducedMotion: true, fontsStatus: 'loaded' },
    elements: [], coverage: { nodesSeen: 0, elementsMeasured: 0, omitted: 0, complete: true, limitations: [] },
  }
  const file = join(directory, 'input.json')
  await writeFile(file, JSON.stringify(observation))
  const out = join(directory, 'result')
  let output
  assert.equal(await runCLI(['inspect', file, '--out', out], (value) => { output = value }), 0)
  assert.equal(JSON.parse(await readFile(join(out, 'findings.json'), 'utf8')).captureId, 'test')
  assert.ok(output.findings.some((finding) => finding.status === 'review'))
  await assert.rejects(runCLI(['inspect', file, '--out', out], () => {}), /already contains/)
})

test('a probe does not call a previously omitted finding a new defect', () => {
  const baseline = { summary: { omitted: 1 }, coverage: { complete: true }, findings: [{ rule: 'color.text-contrast', elementId: 'first', status: 'fail' }] }
  const current = { summary: { omitted: 0 }, coverage: { complete: true }, findings: [{ rule: 'color.text-contrast', elementId: 'second', status: 'fail' }] }
  const delta = probeIssueDelta(baseline, current)
  assert.equal(delta.status, 'unknown')
  assert.equal(delta.comparisonCoverage.complete, false)
  assert.deepEqual(delta.newIssues, [])
})
