// SOURCING: hand-rolled. A Content-Security-Policy is a header string; a block
// document carries one directive (plan D9): only the app may frame it. What
// the block itself loads and reaches is its own business.
import { contentSecurityPolicy } from '#/lib/blocks/document'

/** A block document's policy: framed by the app's origin and nothing else. */
export const framePolicy = (appOrigin: string) =>
  contentSecurityPolicy({ 'frame-ancestors': appOrigin })
