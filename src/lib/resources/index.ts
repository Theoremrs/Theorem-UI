// SOURCING: none. The public surface of the shared resource layer (REF-01..REF-04, LINK-04, DATA-02); the components are in components/resources.
import './open'
export * from './types'
export * from './state'
export * from './relationships'
export * from './provider'
export {
  canonicalKey,
  coverageOf,
  groupComplete,
  listProviders,
  open,
  preview,
  providerFor,
  references,
  registerOpenHost,
  registerProvider,
  resolve,
  sameResource,
  search,
  searchMore,
  supports,
  useResourceProviders,
} from './registry'
export type {
  Coverage,
  GroupStatus,
  OpenHost,
  OpenIntent,
  OpenRequest,
  OpenResult,
  SearchGroup,
  SearchOptions,
  SearchResult,
  Unsupported,
} from './registry'
export { installBackend } from './backend'
export type { BackendRoutes } from './backend'
export { hrefFor, registerBuiltInOpenHandlers } from './open'
