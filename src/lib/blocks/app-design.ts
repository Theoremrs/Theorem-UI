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

/** A colour scheme an App is measured in. */
export type DesignScheme = 'light' | 'dark'

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
  /** The schemes it was found in, where that is not every scheme measured. */
  schemes?: Array<DesignScheme>
}

type Counts = Omit<DesignReport['summary'], 'omitted'>

/** What a check reports of the design: passes counted, problems grouped. */
export interface AppDesignReport {
  /** Each scheme measured, with its pass and problem counts. */
  summary: Partial<Record<DesignScheme, Counts>>
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
        | 'reducedMotion'
        | 'fontsStatus'
      >
      /** The schemes measured, in the order they were. */
      schemes: Array<DesignScheme>
      /** A scheme that could not be measured, and why. */
      unmeasured?: { scheme: DesignScheme; reason: string }
      report: AppDesignReport
    }
  | { status: 'unavailable'; reason: string }

export const unavailableDesign = (reason: string): AppDesignFeedback => ({
  status: 'unavailable',
  reason: reason.slice(0, 400),
})

/** What one scheme's measurement came back as: the frame's value, or why there is none. */
export type SchemeMeasurement =
  | { scheme: DesignScheme; captureId: string; value: unknown }
  | { scheme: DesignScheme; reason: string }

/** One scheme's measurement, validated and evaluated. */
interface Measured {
  scheme: DesignScheme
  capture: DesignObservation['capture']
  report: DesignReport
}

/** A frame is untrusted: reject malformed, stale or oversized observations. */
function measuredOf(
  measurement: SchemeMeasurement,
): Measured | { scheme: DesignScheme; reason: string } {
  const { scheme } = measurement
  if ('reason' in measurement) return measurement
  const { value, captureId } = measurement
  try {
    if (value === undefined || value === null)
      return { scheme, reason: 'The App did not return design measurements.' }
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).length > MAX_OBSERVATION_BYTES)
      return {
        scheme,
        reason: 'The App returned too much design measurement data.',
      }
    const observed = validateObservation(value)
    if (
      observed.capture.id !== captureId ||
      observed.capture.evidenceKind !== 'rendered-artifact' ||
      observed.capture.colorScheme !== scheme
    )
      return {
        scheme,
        reason:
          'The App returned measurements for a different capture, evidence kind or scheme.',
      }
    if (
      observed.elements.length > APP_DESIGN_MAX_ELEMENTS ||
      observed.coverage.nodesSeen > APP_DESIGN_MAX_NODES
    )
      return {
        scheme,
        reason:
          'The App exceeded the design measurement element or scan limit.',
      }
    return {
      scheme,
      capture: observed.capture,
      report: inspectDesign(observed, { maxFindings: 1000 }),
    }
  } catch (error) {
    return {
      scheme,
      reason: `The App's design measurements could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** One measurement's feedback, in the scheme its capture names. */
export function appDesignFeedback(
  value: unknown,
  captureId: string,
): AppDesignFeedback {
  const scheme =
    (value as { capture?: { colorScheme?: unknown } } | null)?.capture
      ?.colorScheme === 'dark'
      ? 'dark'
      : 'light'
  return schemesDesignFeedback([{ scheme, captureId, value }])
}

/**
 * The feedback of an App measured in each scheme: an issue found the same in
 * every scheme is listed once, and one found in only some names them.
 */
export function schemesDesignFeedback(
  measurements: Array<SchemeMeasurement>,
): AppDesignFeedback {
  const results = measurements.map(measuredOf)
  const measured = results.filter(
    (result): result is Measured => 'report' in result,
  )
  const failed = results.filter(
    (result): result is { scheme: DesignScheme; reason: string } =>
      'reason' in result,
  )
  const [head] = measured
  if (!head)
    return unavailableDesign(failed.map(({ reason }) => reason).join(' '))
  const schemes = measured.map(({ scheme }) => scheme)
  const issues = issuesOf(measured)
  const { id, timestamp, viewport, document, reducedMotion, fontsStatus } =
    head.capture
  const limitations = [
    ...new Set(measured.flatMap(({ report }) => report.coverage.limitations)),
    ...(measured.length > 1
      ? [
          'Each scheme after the first was applied to the running App’s stylesheet; anything its script drew from the first scheme (a canvas, colours read once) was not redrawn.',
        ]
      : []),
  ]
  const result: AppDesignFeedback = {
    status: 'measured',
    evidence: 'sandbox-reported-dom',
    capture: {
      id,
      timestamp,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        dpr: viewport.dpr,
      },
      document: { width: document.width, height: document.height },
      reducedMotion,
      fontsStatus,
    },
    schemes,
    ...(failed[0] ? { unmeasured: failed[0] } : {}),
    report: {
      summary: Object.fromEntries(
        measured.map(({ scheme, report }) => {
          const { pass, fail, review, unknown } = report.summary
          return [scheme, { pass, fail, review, unknown }]
        }),
      ),
      issues: issues.slice(0, APP_DESIGN_MAX_ISSUES),
      omittedIssues: Math.max(0, issues.length - APP_DESIGN_MAX_ISSUES),
      coverage: {
        ...head.report.coverage,
        complete: measured.every(({ report }) => report.coverage.complete),
        limitations,
      },
    },
  }
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > MAX_REPORT_BYTES
  )
    return unavailableDesign(
      'The evaluated design response exceeded the response limit.',
    )
  return result
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

/**
 * Groups the evaluator's findings into issues, one per rule, status and
 * measurement, across every scheme measured.
 */
function issuesOf(measured: Array<Measured>): Array<DesignIssue> {
  const groups = new Map<
    string,
    DesignIssue & { found: Set<DesignScheme>; elements: Set<string> }
  >()
  for (const { scheme, report } of measured)
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
      const element = finding.elementId ?? 'document'
      let issue = groups.get(key)
      if (!issue) {
        issue = {
          rule: finding.rule,
          status: finding.status,
          authority: finding.authority,
          message: finding.message,
          ...(finding.repair ? { repair: finding.repair } : {}),
          measured: finding.measured,
          expected: finding.expected,
          count: 0,
          at: [],
          found: new Set(),
          elements: new Set(),
        }
        groups.set(key, issue)
      }
      issue.found.add(scheme)
      // The same element found in two schemes is one element.
      if (!issue.elements.has(element)) {
        issue.elements.add(element)
        issue.count++
      }
      if (!issue.at.includes(place) && issue.at.length < APP_DESIGN_MAX_PLACES)
        issue.at.push(place)
    }
  return [...groups.values()]
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.count - a.count,
    )
    .map(({ found, elements: _elements, ...issue }) =>
      found.size < measured.length ? { ...issue, schemes: [...found] } : issue,
    )
}
