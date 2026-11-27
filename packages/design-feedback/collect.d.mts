import type { DesignObservation } from './core.mjs'

export interface CollectOptions {
  captureId?: string
  evidenceKind?: 'rendered-web' | 'rendered-artifact'
  maxElements?: number
  maxNodes?: number
  maxTextLength?: number
  /** The scheme the document was given, where it is not the browser's preference. */
  colorScheme?: 'light' | 'dark'
  /** A CSS colour the embedding page paints behind a transparent document. */
  canvas?: string
}

/** Run inside the observed document. The function has no outer dependencies. */
export function collectDesignObservations(options?: CollectOptions): DesignObservation
