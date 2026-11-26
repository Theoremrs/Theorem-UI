export type EvidenceKind = 'rendered-web' | 'rendered-artifact' | 'fixture'
export type FindingStatus = 'pass' | 'fail' | 'review' | 'unknown'
export interface Rect { x: number; y: number; width: number; height: number }
export interface DesignElement {
  id: string
  selector: string
  identity: 'explicit' | 'selector'
  tag: string
  role?: string
  name?: string
  source?: string
  rect: Rect
  viewportRect: Rect
  interactive: boolean
  disabled: boolean
  text?: {
    value: string
    complete: boolean
    fontSize: number
    fontWeight: number
    fontFamily: string
    lineHeight: number | null
    color: string
    background: string | null
    paintStatus: 'resolved' | 'unknown'
    paintReasons: string[]
    lineCount: number
    graphemeCount: number
    readingMeasureEligible?: boolean
    averageGraphemesPerLine: number | null
  }
  overflow?: {
    x: boolean
    y: boolean
    scrollableX: boolean
    scrollableY: boolean
    clientWidth: number
    clientHeight: number
    scrollWidth: number
    scrollHeight: number
  }
  /** Items per row of a wrapping flex row or a grid, top row first. */
  wrap?: { kind: 'flex' | 'grid'; rows: number[] }
}
export interface DesignCoverage {
  nodesSeen: number
  elementsMeasured: number
  omitted: number
  complete: boolean
  limitations: string[]
}
export interface DesignObservation {
  schemaVersion: 'design-feedback/v1'
  capture: {
    id: string
    url: string
    timestamp: string
    evidenceKind: EvidenceKind
    viewport: { width: number; height: number; dpr: number }
    scroll: { x: number; y: number }
    document: { width: number; height: number }
    colorScheme: 'light' | 'dark'
    reducedMotion: boolean
    fontsStatus: 'loaded' | 'loading' | 'unavailable'
    [key: string]: unknown
  }
  elements: DesignElement[]
  coverage: DesignCoverage
}
export interface DesignPolicy {
  maxFindings?: number
  /** Configurable target, not a complete WCAG target-size assessment. */
  minTargetSize?: number
  /** Opt-in typography targets: no universal readability pass is claimed. */
  lineHeight?: { min: number; max: number }
  readingMeasure?: { min: number; max: number }
}
export interface DesignFinding {
  id: string
  rule: string
  elementId?: string
  selector?: string
  source?: string
  authority: 'standard' | 'contract' | 'target' | 'diagnostic'
  status: FindingStatus
  severity: 'error' | 'warning' | 'info'
  evidence: { kind: EvidenceKind; captureId: string }
  measured: unknown
  expected: unknown
  message: string
  repair?: string
}
export interface DesignReport {
  schemaVersion: 'design-feedback/v1'
  captureId: string
  findings: DesignFinding[]
  summary: Record<FindingStatus, number> & { omitted: number }
  coverage: DesignCoverage
}
export interface GeometryChange {
  elementId: string
  selector: string
  position: { dx: number; dy: number }
  size: { dw: number; dh: number }
  kind: 'position' | 'size' | 'position-and-size'
}
export interface GeometryComparison {
  matched: number
  added: number
  removed: number
  changed: number
  unchanged: number
  omitted: number
  changes: GeometryChange[]
  globalTranslation: { dx: number; dy: number; matchedFraction: number } | null
  coverage: { complete: boolean; contextChanged: string[]; limitations: string[] }
}

/** Validates bounded JSON from an untrusted observation producer. Throws TypeError. */
export function validateObservation(input: unknown): DesignObservation
export function inspectDesign(observation: unknown, policy?: DesignPolicy): DesignReport
export function compareGeometry(before: unknown, after: unknown, options?: {
  tolerance?: number
  maxChanges?: number
}): GeometryComparison
/** Opaque sRGB only. Unsupported CSS paints return null rather than a guessed ratio. */
export function contrastRatio(foreground: string, background: string): number | null
