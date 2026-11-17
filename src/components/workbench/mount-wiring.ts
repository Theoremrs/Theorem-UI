// SOURCING: none — the two connections the chat-mode mount makes to the workbench handle and the owners, kept here so a test can hold them
import { watchReducedMotion } from '@/lib/workbench/reduced-motion'
import type { DocumentsView } from '@/lib/workbench/documents/port'
import { createLanguagePort } from '@/lib/workbench/language/port'
import type { Language } from '@/lib/workbench/language/language'

/** Delivers the reduced-motion preference to the handle now and on each change. Returns its stop. */
export function deliverReducedMotion(
  handle: { set_reduced_motion: (reduced: boolean) => void },
  query?: MediaQueryList | null,
): () => void {
  return watchReducedMotion((reduced) => handle.set_reduced_motion(reduced), query)
}

/** The language port over the documents port's view, so the diagnostics feed runs for the open documents. */
export function languagePortFor(language: Language, documents: { view: DocumentsView }) {
  return createLanguagePort(language, { documents: documents.view })
}
