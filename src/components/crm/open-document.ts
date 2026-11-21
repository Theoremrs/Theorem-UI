// SOURCING: React context: where a document opens from inside an inspector
import { createContext, useContext } from 'react'

/**
 * Opens a document where the surrounding inspector opens its other linked
 * items. Unset, a document opens beside the Index's view.
 */
const OpenDocumentContext = createContext<
  ((documentId: string) => void) | null
>(null)
export const OpenDocumentProvider = OpenDocumentContext.Provider
export const useOpenDocumentHandler = () => useContext(OpenDocumentContext)
