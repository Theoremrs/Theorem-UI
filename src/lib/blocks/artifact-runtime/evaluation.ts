// SOURCING: none: fidelity claims and independent evaluations (the
// general-creation addendum, section 3 and work package G2). A criterion
// fixes its cases and expected outcomes and has its own identity; a candidate
// is a subject; an evaluator is a named, versioned piece of code. A receipt
// binds the three, so feedback can be applied and the candidate judged
// against the same criterion as the original, and an improvement is counted
// only against an unchanged criterion. A changed goal is a criterion
// revision that names the criterion it revises.
import { resultRef } from './context'
import type { ResultRef, SubjectRef, Versioned } from './context'
import { canonicalJson, digestOf } from './digest'
import { ARTIFACT_RUNTIME_SCHEMA } from './types'
import type { ArtifactSourceRef, BuildRef, Digest } from './types'

/** A numeric allowance, declared with the case before any candidate is run. */
export interface Tolerance {
  absolute?: number
  relative?: number
}

/** One check: an input and the outcome the criterion expects for it. */
export interface CriterionCase {
  name: string
  input: unknown
  expected: unknown
  tolerance?: Tolerance
}

/**
 * What a candidate is judged against. `establishes` is what passing every
 * case supports; `doesNotEstablish` is what it does not, however well the
 * candidate does (a solver that matches an analytic case says nothing yet
 * about a real plate). Its id is the digest of the rest, so a criterion with
 * a different expected value is a different criterion.
 */
export interface Criterion {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  id: Digest
  name: string
  version: string
  establishes: Array<string>
  doesNotEstablish: Array<string>
  assumptions: Array<string>
  cases: Array<CriterionCase>
  /** A goal changed on purpose: the criterion this replaces, and why. */
  revises?: { criterion: Digest; reason: string }
}

/** The code that ran the cases: named, versioned, and where it is written. */
export interface Evaluator extends Versioned {
  name: string
  source: ArtifactSourceRef
  build?: BuildRef['id']
}

export type CaseStatus = 'pass' | 'fail' | 'error'

export interface CaseOutcome {
  name: string
  status: CaseStatus
  actual?: unknown
  detail?: string
}

/**
 * One evaluation of one candidate against one criterion by one evaluator.
 * `establishes` is the criterion's only when every case passed; whatever the
 * criterion does not establish is carried in `notEstablished` either way.
 */
export interface EvaluationReceipt {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  id: Digest
  candidate: SubjectRef
  criterion: Digest
  evaluator: Evaluator
  cases: Array<CaseOutcome>
  passed: number
  failed: number
  establishes: Array<string>
  notEstablished: Array<string>
}

/** What a receipt is stored as, when it is kept as a result. */
export const EVALUATION_REPRESENTATION: Versioned = {
  schema: 'theorem.evaluation-receipt',
  version: '1',
}

const withId = async <T extends object>(
  body: T,
): Promise<T & { id: Digest }> => {
  const owned = structuredClone(body)
  return { ...owned, id: await digestOf(owned) }
}

/** A criterion with its id computed from everything it fixes; an `id` or `schema` given is replaced. */
export function criterion(
  given: Omit<Criterion, 'id' | 'schema'> & { id?: unknown; schema?: unknown },
): Promise<Criterion> {
  const { id: _id, schema: _schema, ...body } = given
  const names = new Set<string>()
  for (const item of body.cases) {
    if (names.has(item.name))
      throw new Error(`The case "${item.name}" is named twice`)
    names.add(item.name)
    canonicalJson(item.expected)
  }
  return withId({ schema: ARTIFACT_RUNTIME_SCHEMA, ...body })
}

/** Whether a criterion's id is the digest of the rest of it. */
export async function criterionIdHolds(given: Criterion): Promise<boolean> {
  const { id, ...rest } = given
  return (await digestOf(rest)) === id
}

/** A plain JSON object: compared key by key. Dates, Maps and the like are compared by canonical form. */
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Whether `actual` matches `expected`: numbers within the case's tolerance,
 * arrays and objects element by element with the same keys, anything else by
 * its canonical JSON.
 */
export function matches(
  actual: unknown,
  expected: unknown,
  tolerance: Tolerance = {},
): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (!Number.isFinite(actual)) return false
    const allowed = Math.max(
      tolerance.absolute ?? 0,
      (tolerance.relative ?? 0) * Math.abs(expected),
    )
    return Math.abs(actual - expected) <= allowed
  }
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matches(actual[index], item, tolerance))
    )
  if (plain(expected)) {
    if (!plain(actual)) return false
    const want = Object.keys(expected).sort()
    const have = Object.keys(actual).sort()
    return (
      canonicalJson(want) === canonicalJson(have) &&
      want.every((key) =>
        matches(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
          tolerance,
        ),
      )
    )
  }
  try {
    return canonicalJson(actual) === canonicalJson(expected)
  } catch {
    return false
  }
}

/**
 * Runs every case of `against` on the candidate through `run` and keeps
 * what happened. The expected values are the criterion's: `run` is given a
 * case's input only, so a candidate cannot supply its own expectation.
 */
export async function evaluate(
  givenCriterion: Criterion,
  givenCandidate: SubjectRef,
  givenEvaluator: Evaluator,
  run: (input: unknown, name: string) => unknown,
): Promise<EvaluationReceipt> {
  // Owned copies, taken before the first wait: a caller changing its objects
  // while a case runs changes neither what is checked nor what is named.
  const against = structuredClone(givenCriterion)
  const candidate = structuredClone(givenCandidate)
  const evaluator = structuredClone(givenEvaluator)
  if (!(await criterionIdHolds(against)))
    throw new Error(`The criterion ${against.name} does not match its id`)
  const cases: Array<CaseOutcome> = []
  for (const item of against.cases) {
    try {
      const actual = structuredClone<unknown>(
        await run(structuredClone(item.input), item.name),
      )
      // A value the receipt cannot hold (NaN, Infinity, a function) is an
      // error of this case, not of the whole evaluation.
      canonicalJson(actual)
      const pass = matches(actual, item.expected, item.tolerance)
      cases.push({ name: item.name, status: pass ? 'pass' : 'fail', actual })
    } catch (error) {
      cases.push({
        name: item.name,
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const passed = cases.filter((item) => item.status === 'pass').length
  return withId({
    schema: ARTIFACT_RUNTIME_SCHEMA,
    candidate,
    criterion: against.id,
    evaluator,
    cases,
    passed,
    failed: cases.length - passed,
    establishes: passed === cases.length ? [...against.establishes] : [],
    notEstablished: [...against.doesNotEstablish],
  })
}

/**
 * What changed between an evaluation before feedback and one after. Two
 * receipts are compared only against the same criterion: a candidate judged
 * against a criterion with other expected values has not improved against
 * the original, and an explicit revision is reported as a revision.
 */
export type Comparison =
  | {
      comparable: true
      fixed: Array<string>
      broken: Array<string>
      unchanged: Array<string>
      improved: boolean
    }
  | { comparable: false; reason: 'criterion-changed' }
  | { comparable: false; reason: 'criterion-revised'; why: string }

export function compareEvaluations(
  before: EvaluationReceipt,
  after: EvaluationReceipt,
  revision?: Criterion,
): Comparison {
  if (before.criterion !== after.criterion) {
    if (
      revision?.id === after.criterion &&
      revision.revises?.criterion === before.criterion
    )
      return {
        comparable: false,
        reason: 'criterion-revised',
        why: revision.revises.reason,
      }
    return { comparable: false, reason: 'criterion-changed' }
  }
  const was = new Map(before.cases.map((item) => [item.name, item.status]))
  const fixed: Array<string> = []
  const broken: Array<string> = []
  const unchanged: Array<string> = []
  for (const item of after.cases) {
    const earlier = was.get(item.name)
    if (earlier !== 'pass' && item.status === 'pass') fixed.push(item.name)
    else if (earlier === 'pass' && item.status !== 'pass')
      broken.push(item.name)
    else unchanged.push(item.name)
  }
  return {
    comparable: true,
    fixed,
    broken,
    unchanged,
    improved: broken.length === 0 && fixed.length > 0,
  }
}

/**
 * A receipt as a result, so it is kept and resolved like any other: its
 * content is the receipt, and its provenance names the evaluator, the
 * criterion and the candidate it was computed from.
 */
export async function evaluationResult(
  receipt: EvaluationReceipt,
): Promise<{ result: ResultRef; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(canonicalJson(receipt))
  const result = await resultRef({
    content: await digestOf(receipt),
    bytes: String(bytes.length),
    mediaType: 'application/json',
    representation: EVALUATION_REPRESENTATION,
    provenance: {
      kind: 'computed',
      source: receipt.evaluator.source,
      ...(receipt.evaluator.build && { build: receipt.evaluator.build }),
      operation: {
        name: receipt.evaluator.name,
        schema: receipt.evaluator.schema,
        version: receipt.evaluator.version,
      },
      inputs: {
        criterion: receipt.criterion,
        candidate: await digestOf(receipt.candidate),
      },
    },
    reproducibility: 'recorded',
  })
  return { result, bytes }
}
