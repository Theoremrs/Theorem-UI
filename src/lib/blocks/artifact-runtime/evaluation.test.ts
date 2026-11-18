// SOURCING: bun:test over evaluation.ts and operations.ts, with a real
// steady-conduction solver (finite differences on a rod, solved by the
// tridiagonal algorithm) and a reservation conflict rule, as the two
// acceptance examples of the general-creation addendum use them.
import { describe, expect, test } from 'bun:test'
import {
  Operations,
  compareEvaluations,
  criterion,
  digestBytes,
  digestOf,
  evaluate,
  evaluationResult,
  matches,
  resultIdHolds,
} from './index'
import type { ArtifactSourceRef, Evaluator, SubjectRef } from './index'

const revision = (position: number): ArtifactSourceRef => ({
  kind: 'document',
  documentId: 'heat-plate',
  position: String(position),
  contentDigest: `c${position}`,
})

/** Steady 1-D conduction, no source: interior nodes average their neighbours. */
function solveRod(input: {
  length: number
  nodes: number
  left: number
  right: number
}): Array<{ x: number; t: number }> {
  const { length, nodes, left, right } = input
  const n = nodes - 2
  // -T[i-1] + 2T[i] - T[i+1] = 0, Thomas algorithm.
  const c = new Array<number>(n).fill(0)
  const d = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const rhs = (i === 0 ? left : 0) + (i === n - 1 ? right : 0)
    const denom = 2 + (i === 0 ? 0 : c[i - 1]!)
    c[i] = -1 / denom
    d[i] = (rhs + (i === 0 ? 0 : d[i - 1]!)) / denom
  }
  const interior = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--)
    interior[i] = d[i]! - c[i]! * (i === n - 1 ? 0 : interior[i + 1]!)
  const temperatures = [left, ...interior, right]
  return temperatures.map((t, i) => ({ x: (i * length) / (nodes - 1), t }))
}

const ROD = { length: 1, nodes: 11, left: 100, right: 0 }

const evaluator: Evaluator = {
  name: 'rod-analytic',
  schema: 'theorem.evaluator',
  version: '1',
  source: revision(1),
}

async function rodCriterion() {
  return criterion({
    name: 'steady-rod',
    version: '1',
    establishes: [
      'The solver reproduces T(x) = 100(1 - x/L) °C for a homogeneous rod with fixed ends at its sample positions.',
    ],
    doesNotEstablish: [
      'Temperatures of a real plate: no measured material or boundary data was compared.',
    ],
    assumptions: ['Steady state', 'No internal heat source', 'Insulated sides'],
    cases: [0, 0.3, 0.5, 1].map((x) => ({
      name: `x=${x}`,
      input: { ...ROD, at: x },
      expected: 100 * (1 - x),
      tolerance: { absolute: 1e-9 },
    })),
  })
}

const at =
  (solve: typeof solveRod) =>
  (input: unknown): number => {
    const { at: x, ...rod } = input as typeof ROD & { at: number }
    const point = solve(rod).find((sample) => Math.abs(sample.x - x) < 1e-12)
    if (!point) throw new Error(`No sample at x = ${x}`)
    return point.t
  }

const candidate: SubjectRef = { kind: 'source', source: revision(1) }

describe('an evaluation against a fixed criterion', () => {
  test('a solver that matches the analytic case passes, and still does not establish the physical claim', async () => {
    const against = await rodCriterion()
    const receipt = await evaluate(against, candidate, evaluator, at(solveRod))
    expect(receipt.failed).toBe(0)
    expect(receipt.passed).toBe(4)
    expect(receipt.establishes).toEqual(against.establishes)
    expect(receipt.notEstablished).toEqual(against.doesNotEstablish)
    expect(receipt.criterion).toBe(against.id)
  })

  test('a failing case keeps its actual value and claims nothing', async () => {
    const against = await rodCriterion()
    // A solver whose right edge "cools too quickly": every value 2 °C low.
    const cold = (input: Parameters<typeof solveRod>[0]) =>
      solveRod(input).map(({ x, t }) => ({ x, t: x === 0 ? t : t - 2 }))
    const receipt = await evaluate(against, candidate, evaluator, at(cold))
    const middle = receipt.cases.find((item) => item.name === 'x=0.5')!
    expect(middle.status).toBe('fail')
    expect(middle.actual as number).toBeCloseTo(48, 9)
    expect(receipt.establishes).toEqual([])
    expect(receipt.notEstablished).toEqual(against.doesNotEstablish)
  })

  test('an error in a case is recorded as an error, not a pass', async () => {
    const against = await rodCriterion()
    const receipt = await evaluate(against, candidate, evaluator, () => {
      throw new Error('diverged')
    })
    expect(receipt.cases.every((item) => item.status === 'error')).toBe(true)
    expect(receipt.cases[0]!.detail).toBe('diverged')
  })

  test('a criterion whose expected values were edited no longer matches its id', async () => {
    const against = await rodCriterion()
    against.cases[0]!.expected = 0
    expect(
      evaluate(against, candidate, evaluator, at(solveRod)),
    ).rejects.toThrow('does not match its id')
  })
})

describe('feedback judged before and after', () => {
  test('a fix counts as an improvement only against the unchanged criterion', async () => {
    const against = await rodCriterion()
    const cold = (input: Parameters<typeof solveRod>[0]) =>
      solveRod(input).map(({ x, t }) => ({ x, t: x === 0 ? t : t - 2 }))
    const before = await evaluate(against, candidate, evaluator, at(cold))
    const after = await evaluate(
      against,
      { kind: 'source', source: revision(2) },
      evaluator,
      at(solveRod),
    )
    expect(compareEvaluations(before, after)).toEqual({
      comparable: true,
      fixed: ['x=0.3', 'x=0.5', 'x=1'],
      broken: [],
      unchanged: ['x=0'],
      improved: true,
    })
  })

  test('a candidate that changes its own expected value has not improved against the original', async () => {
    const against = await rodCriterion()
    const cold = (input: Parameters<typeof solveRod>[0]) =>
      solveRod(input).map(({ x, t }) => ({ x, t: x === 0 ? t : t - 2 }))
    const before = await evaluate(against, candidate, evaluator, at(cold))
    // The candidate brings its own criterion, expecting what it produces.
    const own = await criterion({
      ...against,
      cases: against.cases.map((item) => ({
        ...item,
        expected: at(cold)(item.input),
      })),
    })
    const after = await evaluate(own, candidate, evaluator, at(cold))
    expect(after.failed).toBe(0)
    expect(compareEvaluations(before, after)).toEqual({
      comparable: false,
      reason: 'criterion-changed',
    })
  })

  test('a goal the person changed is an explicit revision of the criterion', async () => {
    const against = await rodCriterion()
    const before = await evaluate(against, candidate, evaluator, at(solveRod))
    const hotter = await criterion({
      ...against,
      version: '2',
      cases: against.cases.map((item) => ({
        ...item,
        input: { ...(item.input as object), left: 150 },
        expected: (150 * (item.expected as number)) / 100,
      })),
      revises: {
        criterion: against.id,
        reason: 'The person asked for a 150 °C left end.',
      },
    })
    const after = await evaluate(hotter, candidate, evaluator, at(solveRod))
    expect(after.failed).toBe(0)
    expect(compareEvaluations(before, after, hotter)).toEqual({
      comparable: false,
      reason: 'criterion-revised',
      why: 'The person asked for a 150 °C left end.',
    })
  })

  test('a receipt is kept as a result whose bytes are its canonical JSON', async () => {
    const receipt = await evaluate(
      await rodCriterion(),
      candidate,
      evaluator,
      at(solveRod),
    )
    const { result, bytes } = await evaluationResult(receipt)
    expect(await digestBytes(bytes)).toBe(result.content)
    expect(result.bytes).toBe(String(bytes.length))
    expect(await resultIdHolds(result)).toBe(true)
    expect(result.provenance).toMatchObject({
      kind: 'computed',
      operation: { name: 'rod-analytic', version: '1' },
      inputs: {
        criterion: receipt.criterion,
        candidate: await digestOf(candidate),
      },
    })
  })
})

describe('matching values', () => {
  test('numbers within tolerance, structures by shape, the rest exactly', () => {
    expect(matches(1.0000001, 1, { absolute: 1e-6 })).toBe(true)
    expect(matches(1.01, 1, { relative: 0.001 })).toBe(false)
    expect(matches(Number.NaN, 0, { absolute: 1 })).toBe(false)
    expect(
      matches(
        { ok: false, conflicts: ['r1'] },
        { ok: false, conflicts: ['r1'] },
      ),
    ).toBe(true)
    expect(matches({ ok: false }, { ok: false, conflicts: [] })).toBe(false)
    expect(matches('10:00', '10:00')).toBe(true)
  })
})

describe('reuse across revisions', () => {
  const solver = (implementation?: `sha256:${string}`) => ({
    name: 'solve',
    version: '1',
    summary: 'Steady conduction along a rod',
    input: {},
    output: {},
    reproducibility: 'deterministic' as const,
    recovery: ['rerun' as const],
    ...(implementation && { implementation }),
    run: solveRod,
  })

  test('a presentation-only revision reuses the solved field; a changed boundary does not', async () => {
    const implementation = await digestOf({ 'solver.ts': 'v1' })
    const first = new Operations({ source: revision(1) })
    first.define(solver(implementation))
    const solved = await first.invoke('solve', ROD)

    // Revision 2 changed only the colormap: the solver's fingerprint is the same.
    const second = new Operations({ source: revision(2) })
    second.define(solver(implementation))
    expect(await second.explain('solve', ROD, solved.result)).toEqual({
      reusable: true,
    })
    expect(
      await second.adopt('solve', ROD, solved.output, solved.result),
    ).toEqual({
      reusable: true,
    })
    const again = await second.invoke('solve', ROD)
    expect(again.reused).toBe(true)
    expect(again.result.id).toBe(solved.result.id)

    // A changed boundary condition is a different input.
    expect(
      await second.explain('solve', { ...ROD, right: 20 }, solved.result),
    ).toEqual({ reusable: false, changed: ['input'] })
  })

  test('a changed solver invalidates its results, and says so', async () => {
    const first = new Operations({ source: revision(1) })
    first.define(solver(await digestOf({ 'solver.ts': 'v1' })))
    const solved = await first.invoke('solve', ROD)
    const second = new Operations({ source: revision(2) })
    second.define(solver(await digestOf({ 'solver.ts': 'v2' })))
    expect(await second.explain('solve', ROD, solved.result)).toEqual({
      reusable: false,
      changed: ['implementation'],
    })
    expect(
      await second.adopt('solve', ROD, solved.output, solved.result),
    ).toEqual({
      reusable: false,
      changed: ['implementation'],
    })
    expect((await second.invoke('solve', ROD)).reused).toBe(false)
  })

  test('without a fingerprint, any new revision is a miss', async () => {
    const first = new Operations({ source: revision(1) })
    first.define(solver())
    const solved = await first.invoke('solve', ROD)
    const second = new Operations({ source: revision(2) })
    second.define(solver())
    expect(await second.explain('solve', ROD, solved.result)).toEqual({
      reusable: false,
      changed: ['source'],
    })
  })

  test('a result is adopted only with the content it names', async () => {
    const implementation = await digestOf({ 'solver.ts': 'v1' })
    const first = new Operations({ source: revision(1) })
    first.define(solver(implementation))
    const solved = await first.invoke('solve', ROD)
    const second = new Operations({ source: revision(2) })
    second.define(solver(implementation))
    expect(
      second.adopt('solve', ROD, [{ x: 0, t: 1 }], solved.result),
    ).rejects.toThrow('is not the content')
  })
})
