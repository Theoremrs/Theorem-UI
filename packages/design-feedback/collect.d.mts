import type { DesignObservation } from './core.mjs'

export interface CollectOptions {
  captureId?: string
  evidenceKind?: 'rendered-web' | 'rendered-artifact'
  maxElements?: number
  maxNodes?: number
  maxTextLength?: number
}

/** Run inside the observed document. The function has no outer dependencies. */
export function collectDesignObservations(options?: CollectOptions): DesignObservation
