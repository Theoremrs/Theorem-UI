// SOURCING: none: @theorem/runtime, the references a durable artifact's
// surfaces agree on: what is shown and what a question is about (a source, a
// result or a run moment, with a selection the artifact interprets), the
// artifact's discoverable operations, criteria and the evaluations judged
// against them, and, for artifacts that execute over
// time, runs, observations and exact signal values. An App may import it,
// copy it or ignore it.
export * from './types'
export type { BitsValue } from './values'
export {
  bitsOf,
  bitsValue,
  unresolvedBits,
  integerOf,
  integerText,
  isIntegerText,
  signalText,
  signalValue,
} from './values'
export { CANONICAL_JSON, canonicalJson, digestBytes, digestOf, isDigest } from './digest'
export {
  SessionObservations,
  readObservationRef,
  readSourceRef,
  sameObservation,
  sameSource,
} from './session'
export type { Resolved } from './session'
export {
  ContextSession,
  ENTITY_SELECTOR,
  readContextBinding,
  readResultRef,
  readSelectionRef,
  readSubjectRef,
  resultIdHolds,
  resultRef,
  sameSubject,
  subjectLabel,
} from './context'
export type {
  ContextBinding,
  ResultProvenance,
  ResultRef,
  SelectionRef,
  SubjectRef,
  Versioned,
} from './context'
export { Operations } from './operations'
export type {
  Invocation,
  Operation,
  OperationDescriptor,
  Recovery,
  ReuseChange,
  ReuseVerdict,
} from './operations'
export {
  EVALUATION_REPRESENTATION,
  compareEvaluations,
  criterion,
  criterionIdHolds,
  evaluate,
  evaluationResult,
  matches,
} from './evaluation'
export type {
  CaseOutcome,
  CaseStatus,
  Comparison,
  Criterion,
  CriterionCase,
  EvaluationReceipt,
  Evaluator,
  Tolerance,
} from './evaluation'
