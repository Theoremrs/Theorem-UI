// The App's sandbox reports DOM measurements; the host validates and evaluates
// them with the same portable evaluator the Design Feedback CLI uses.
import {
  inspectDesign,
  validateObservation,
} from '../../../packages/design-feedback/core.mjs'
import type {
  DesignFinding,
  DesignObservation,
  DesignReport,
} from '../../../packages/design-feedback/core.mjs'

export const APP_DESIGN_MAX_ELEMENTS = 300
export const APP_DESIGN_MAX_NODES = 5000
const MAX_OBSERVATION_BYTES = 512 * 1024
const MAX_REPORT_BYTES = 128 * 1024
/** The most distinct issues a check lists, and the most places it names for one. */
export const APP_DESIGN_MAX_ISSUES = 30
export const APP_DESIGN_MAX_PLACES = 6

/**
 * One problem as the agent reads it: what was measured and expected once,
 * with every place it was measured. Twelve labels in one colour on one
 * background are one issue at twelve places, not twelve findings that crowd
 * the others out.
 */
export interface DesignIssue {
  rule: string
  status: DesignFinding['status']
  authority: DesignFinding['authority']
  message: string
  repair?: string
  measured: unknown
  expected: unknown
  /** How many elements have it. */
  count: number
  /** Where: the source place that made each element when known, else its selector. */
  at: Array<string>
}

/** What a check reports of the design: passes counted, problems grouped. */
export interface AppDesignReport {
  summary: Omit<DesignReport['summary'], 'omitted'>
  issues: Array<DesignIssue>
  /** Distinct issues found and not listed, past the most a check lists. */
  omittedIssues: number
  coverage: DesignReport['coverage']
}

/** DOM-derived feedback, separate from the App's reconstructed picture. */
export type AppDesignFeedback =
  | {
      status: 'measured'
      evidence: 'sandbox-reported-dom'
      capture: Pick<
        DesignObservation['capture'],
        | 'id'
        | 'timestamp'
        | 'viewport'
        | 'document'
        | 'colorScheme'
        | 'reducedMotion'
        | 'fontsStatus'
      >
      report: AppDesignReport
    }
  | { status: 'unavailable'; reason: string }

export const unavailableDesign = (reason: string): AppDesignFeedback => ({
  status: 'unavailable',
  reason: reason.slice(0, 400),
})

/** A frame is untrusted: reject malformed, stale or oversized observations. */
export function appDesignFeedback(
  value: unknown,
  captureId: string,
): AppDesignFeedback {
  try {
    if (value === undefined || value === null)
      return unavailableDesign('The App did not return design measurements.')
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).length > MAX_OBSERVATION_BYTES)
      return unavailableDesign(
        'The App returned too much design measurement data.',
      )
    const observed = validateObservation(value)
    if (
      observed.capture.id !== captureId ||
      observed.capture.evidenceKind !== 'rendered-artifact'
    )
      return unavailableDesign(
        'The App returned measurements for a different capture or evidence kind.',
      )
    if (
      observed.elements.length > APP_DESIGN_MAX_ELEMENTS ||
      observed.coverage.nodesSeen > APP_DESIGN_MAX_NODES
    )
      return unavailableDesign(
        'The App exceeded the design measurement element or scan limit.',
      )
    const report = issuesOf(inspectDesign(observed, { maxFindings: 1000 }))
    const {
      id,
      timestamp,
      viewport,
      document,
      colorScheme,
      reducedMotion,
      fontsStatus,
    } = observed.capture
    const result: AppDesignFeedback = {
      status: 'measured',
      evidence: 'sandbox-reported-dom',
      capture: {
        id,
        timestamp,
        viewport: { width: viewport.width, height: viewport.height, dpr: viewport.dpr },
        document: { width: document.width, height: document.height },
        colorScheme,
        reducedMotion,
        fontsStatus,
      },
      report,
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_REPORT_BYTES)
      return unavailableDesign('The evaluated design response exceeded the response limit.')
    return result
  } catch (error) {
    return unavailableDesign(
      `The App's design measurements could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const STATUS_ORDER = { fail: 0, unknown: 1, review: 2, pass: 3 } as const
const rounded = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === 'number' ? Math.round(v * 100) / 100 : v,
  )
/** Where an element is, as the agent can find it: its source, or a selector without the page's root. */
const placeOf = (finding: DesignFinding) =>
  finding.source ??
  finding.selector?.replace(/^html > body(?::nth-of-type\(1\))? > /, '') ??
  'page'

/** Groups the evaluator's findings into issues: one per rule, status and measurement. */
function issuesOf(report: DesignReport): AppDesignReport {
  const groups = new Map<string, DesignIssue>()
  for (const finding of report.findings) {
    if (finding.status === 'pass') continue
    const key = [
      finding.rule,
      finding.status,
      finding.authority,
      rounded(finding.measured),
      rounded(finding.expected),
    ].join('|')
    const place = placeOf(finding)
    const issue = groups.get(key)
    if (issue) {
      issue.count++
      if (!issue.at.includes(place) && issue.at.length < APP_DESIGN_MAX_PLACES)
        issue.at.push(place)
      continue
    }
    groups.set(key, {
      rule: finding.rule,
      status: finding.status,
      authority: finding.authority,
      message: finding.message,
      ...(finding.repair ? { repair: finding.repair } : {}),
      measured: finding.measured,
      expected: finding.expected,
      count: 1,
      at: [place],
    })
  }
  const issues = [...groups.values()].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.count - a.count,
  )
  const { pass, fail, review, unknown } = report.summary
  return {
    summary: { pass, fail, review, unknown },
    issues: issues.slice(0, APP_DESIGN_MAX_ISSUES),
    omittedIssues: Math.max(0, issues.length - APP_DESIGN_MAX_ISSUES),
    coverage: report.coverage,
  }
}
