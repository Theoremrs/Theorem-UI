// SOURCING: none: @theorem/runtime, the references a durable artifact's
// surfaces agree on (what is shown, what ran, which moment) and exact signal
// values. An App may import it, copy it or ignore it; an artifact with no
// engine needs none of it.
export * from './types'
export type { BitsValue } from './values'
export {
  bitsOf,
  bitsValue,
  integerOf,
  integerText,
  isIntegerText,
  signalText,
  signalValue,
} from './values'
export { canonicalJson, digestBytes, digestOf, isDigest } from './digest'
export {
  RuntimeSession,
  SessionObservations,
  readObservationRef,
  readSourceRef,
  sameObservation,
  sameSource,
} from './session'
export type { Resolved } from './session'
