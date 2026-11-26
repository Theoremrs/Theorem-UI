// The App's sandbox reports DOM measurements; the host validates and evaluates
// them with the same portable evaluator the Design Feedback CLI uses.
import {
  inspectDesign,
  validateObservation,
} from '../../../packages/design-feedback/core.mjs'
import type {
  DesignObservation,
  DesignReport,
} from '../../../packages/design-feedback/core.mjs'

export const APP_DESIGN_MAX_ELEMENTS = 300
export const APP_DESIGN_MAX_NODES = 5000
const MAX_OBSERVATION_BYTES = 512 * 1024
const MAX_REPORT_BYTES = 128 * 1024

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
      report: DesignReport
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
    const report = inspectDesign(observed, { maxFindings: 40 })
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
