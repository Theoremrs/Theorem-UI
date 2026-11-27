import { join } from 'node:path'
import { capturePage, launchCaptureBrowser, openCapturePage, prepareOutput, validateCaptureURL } from './capture.mjs'
import { compareGeometry } from './core.mjs'
import { writeJSON, writeProbeReport } from './report.mjs'

const TEXT_SPACING_CSS = `* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-block-end: 2em !important; }`

export function probeIssueDelta(baseline, current) {
  const complete = baseline.summary.omitted === 0 && current.summary.omitted === 0 && baseline.coverage.complete && current.coverage.complete
  if (!complete) return {
    authority: 'diagnostic', status: 'unknown', newIssues: [],
    message: 'Findings or DOM observations were omitted; new issues cannot be determined from these partial reports.',
    comparisonCoverage: { complete: false, baselineOmittedFindings: baseline.summary.omitted, currentOmittedFindings: current.summary.omitted },
  }
  const baselineIssues = new Set(baseline.findings.filter((finding) => finding.status === 'fail' || finding.status === 'review').map((finding) => `${finding.rule}:${finding.elementId ?? 'document'}`))
  const newIssues = current.findings.filter((finding) => (finding.status === 'fail' || finding.status === 'review') && !baselineIssues.has(`${finding.rule}:${finding.elementId ?? 'document'}`))
  return {
    authority: 'diagnostic', status: newIssues.length ? 'review' : 'unknown', newIssues,
    message: newIssues.length ? `${newIssues.length} new measured issues appeared under this condition.` : 'No new measured issues were found; this experiment does not prove preservation of all content or functionality.',
    comparisonCoverage: { complete: true, baselineOmittedFindings: 0, currentOmittedFindings: 0 },
  }
}

/** Controlled, fresh-context experiments; no arbitrary click or evaluation program. */
export async function probeURL(url, input = {}) {
  const target = validateCaptureURL(url)
  await prepareOutput(input.out, 'probes.json', input.overwrite)
  const { browser, options } = await launchCaptureBrowser(input)
  const runs = []
  const captured = new Map()
  const scenarios = [
    { name: 'baseline', description: 'Requested viewport with no reduced-motion preference.', reducedMotion: 'no-preference' },
    { name: 'narrow', description: '320 CSS pixel viewport; inspect horizontal overflow and lost content.', width: 320, reducedMotion: 'no-preference' },
    { name: 'text-spacing', description: 'Line height 1.5, paragraph spacing 2em, letter spacing .12em, and word spacing .16em.', reducedMotion: 'no-preference', style: TEXT_SPACING_CSS },
    { name: 'reduced-motion', description: 'Same viewport with prefers-reduced-motion: reduce.', reducedMotion: 'reduce' },
  ]
  try {
    for (const scenario of scenarios) {
      const scenarioOptions = { ...options, ...scenario, out: join(options.out, scenario.name), label: scenario.name }
      const { context, page } = await openCapturePage(browser, scenarioOptions)
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded' })
        if (scenario.style) await page.addStyleTag({ content: scenario.style })
        const run = await capturePage(page, browser, scenarioOptions)
        captured.set(scenario.name, run)
        runs.push({ name: scenario.name, description: scenario.description, directory: scenario.name, captureId: run.capture.id, summary: run.result.summary, coverage: run.result.coverage })
      } finally { await context.close() }
    }
  } finally { await browser.close() }
  const baseline = captured.get('baseline')
  const findings = []
  for (const name of ['narrow', 'text-spacing', 'reduced-motion']) {
    const current = captured.get(name)
    findings.push({ probe: name, ...probeIssueDelta(baseline.result, current.result), geometry: compareGeometry(baseline.observation, current.observation), motionBeforeFreeze: current.capture.motionBeforeFreeze })
  }
  const result = {
    schemaVersion: 'design-feedback/v1', kind: 'probes', runs, findings,
    coverage: { complete: false, limitations: ['Each probe uses a fresh browser context; dynamic data and random content can confound comparisons.', 'No input activation, keyboard focus traversal, screen-reader operation, or motion safety evaluation is performed.', 'Text spacing is one CSS override experiment; script-specific spacing applicability and actual loss of content require review.', 'Animations are counted before finite animations finish and infinite animations pause at time zero; counts do not reveal vestibular risk or animation correctness.'] },
  }
  await writeJSON(join(input.out, 'probes.json'), result)
  await writeProbeReport(input.out, result)
  return result
}
