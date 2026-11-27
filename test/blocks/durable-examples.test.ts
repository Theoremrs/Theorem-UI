// SOURCING: bun:test over the two acceptance examples of the general-creation
// addendum (section 7): an equipment-reservation App and a heat plate App.
// Each is checked and built the way an authored App is (app-check.ts with the
// App declarations, export.ts with esbuild), its domain code is judged
// against fixed criteria (@theorem/runtime evaluation.ts), its feedback
// revision is compared with the revision before it under the same criterion,
// and its results are shown to be reused across a presentation revision and
// invalidated by a semantic one.
//
// These Apps were written by a coding agent working in this repository, not
// by Theorem's own authoring agent through a conversation; see test/fixtures/durable-artifacts/README.md.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tsc } from '@tsrs/wasm'
import * as esbuild from 'esbuild-wasm'
import { checkLibraryFromDisk } from './check-library'
import { typescriptApp } from './typescript-app'
import { checkAppSources } from '../../src/lib/blocks/app-check'
import { appSourcesOf } from '../../src/lib/blocks/app-source'
import { bundleAppSources } from '../../src/lib/blocks/export'
import {
  Operations,
  compareEvaluations,
  criterion,
  digestOf,
  evaluate,
} from '../../src/lib/blocks/artifact-runtime'
import type {
  ArtifactSourceRef,
  Evaluator,
} from '../../src/lib/blocks/artifact-runtime'
import {
  History,
  RULES,
  apply,
} from '../fixtures/durable-artifacts/reservations/rules'
import type { Reservation } from '../fixtures/durable-artifacts/reservations/rules'
import * as refusalNow from '../fixtures/durable-artifacts/reservations/refusal'
import * as refusalBefore from '../fixtures/durable-artifacts/reservations/revisions/1/refusal'
import * as solverNow from '../fixtures/durable-artifacts/heat-plate/solver'
import * as solverBefore from '../fixtures/durable-artifacts/heat-plate/revisions/1/solver'
import { colorAt } from '../fixtures/durable-artifacts/heat-plate/colormap'

const here = join(import.meta.dir, '../fixtures/durable-artifacts')
const filesOf = (folder: string, names: Array<string>) =>
  Object.fromEntries(
    names.map((name) => [name, readFileSync(join(here, folder, name), 'utf8')]),
  )

const revision = (documentId: string, position: number): ArtifactSourceRef => ({
  kind: 'document',
  documentId,
  position: String(position),
  contentDigest: `${documentId}-${position}`,
})

const evaluatorOf = (name: string, documentId: string): Evaluator => ({
  name,
  schema: 'theorem.evaluator',
  version: '1',
  source: revision(`${documentId}-acceptance`, 1),
})

const library = checkLibraryFromDisk()

async function authoredApp(folder: string, names: Array<string>, uses: string) {
  const sources = appSourcesOf(typescriptApp(filesOf(folder, names), { uses }))!
  const checked = await checkAppSources(sources, tsc, library)
  const bundle = await bundleAppSources(sources, esbuild)
  return { problems: checked.problems, bundle }
}

/**
 * What the build hands the App for `import digest from './solver.ts?implementation'`
 * (export.ts): the digest of the solver file's code and what it imports, read
 * from the file as written in that revision.
 */
async function implementationOf(file: string): Promise<`sha256:${string}`> {
  const bundle = await bundleAppSources(
    {
      entry: 'entry.ts',
      files: {
        'entry.ts':
          'import digest from "./solver.ts?implementation"\nexport default digest',
        'solver.ts': readFileSync(join(here, file), 'utf8'),
      },
    },
    esbuild,
  )
  return /"(sha256:[0-9a-f]{64})"/.exec(bundle.code)![1] as `sha256:${string}`
}

const booking = (
  id: string,
  resource: string,
  start: string,
  end: string,
): Reservation => ({
  id,
  resource,
  start,
  end,
  holder: id,
})

describe('the equipment-reservation App', () => {
  const b1 = booking(
    'b1',
    'Microscope A',
    '2026-11-19T09:00:00Z',
    '2026-11-19T10:00:00Z',
  )

  async function rulesCriterion() {
    const ok = (ids: Array<string>) => ({ ok: true, ids })
    const refused = (reason: string) => ({ ok: false, reason })
    return criterion({
      name: 'reservation-rules',
      version: '1',
      establishes: [
        'Bookings follow half-open interval rules per resource, compared as instants.',
      ],
      doesNotEstablish: [
        'Keyboard and screen-reader use in a browser: not exercised here.',
      ],
      assumptions: [
        'Instants carry explicit offsets',
        'One resource per booking',
      ],
      cases: [
        {
          name: 'back-to-back is allowed',
          input: [
            b1,
            booking(
              'b2',
              'Microscope A',
              '2026-11-19T10:00:00Z',
              '2026-11-19T11:00:00Z',
            ),
          ],
          expected: ok(['b1', 'b2']),
        },
        {
          name: 'overlap is refused',
          input: [
            b1,
            booking(
              'b3',
              'Microscope A',
              '2026-11-19T09:30:00Z',
              '2026-11-19T10:30:00Z',
            ),
          ],
          expected: refused('conflict'),
        },
        {
          name: 'another resource is independent',
          input: [
            b1,
            booking(
              'b4',
              'Microscope B',
              '2026-11-19T09:30:00Z',
              '2026-11-19T10:30:00Z',
            ),
          ],
          expected: ok(['b1', 'b4']),
        },
        {
          name: 'offsets are compared as instants',
          input: [
            b1,
            booking(
              'b5',
              'Microscope A',
              '2026-11-19T04:30:00-05:00',
              '2026-11-19T05:30:00-05:00',
            ),
          ],
          expected: refused('conflict'),
        },
        {
          name: 'a time without an offset is refused',
          input: [
            b1,
            booking(
              'b6',
              'Microscope A',
              '2026-11-19T12:00',
              '2026-11-19T13:00',
            ),
          ],
          expected: refused('invalid'),
        },
        {
          name: 'an end before the start is refused',
          input: [
            b1,
            booking(
              'b7',
              'Microscope A',
              '2026-11-19T13:00:00Z',
              '2026-11-19T12:00:00Z',
            ),
          ],
          expected: refused('invalid'),
        },
      ],
    })
  }

  /** Books each in turn; answers the bookings held, or the last refusal. */
  const runRules = (input: unknown) => {
    let held: Array<Reservation> = []
    for (const item of input as Array<Reservation>) {
      const outcome = apply(held, { kind: 'create', reservation: item })
      if (!outcome.ok) return { ok: false, reason: outcome.refusal.reason }
      held = outcome.reservations
    }
    return { ok: true, ids: held.map((item) => item.id) }
  }

  test('its rules meet the reference interval cases', async () => {
    const receipt = await evaluate(
      await rulesCriterion(),
      { kind: 'source', source: revision('reservations', 2) },
      evaluatorOf('reservation-rules', 'reservations'),
      runRules,
    )
    expect(receipt.cases.filter((item) => item.status !== 'pass')).toEqual([])
    expect(receipt.notEstablished).toEqual([
      'Keyboard and screen-reader use in a browser: not exercised here.',
    ])
  })

  test('an edit does not conflict with itself; undo and redo follow accepted changes only', () => {
    const history = new History()
    expect(history.run({ kind: 'create', reservation: b1 }).ok).toBe(true)
    const later = {
      ...b1,
      start: '2026-11-19T09:30:00Z',
      end: '2026-11-19T10:30:00Z',
    }
    expect(history.run({ kind: 'edit', reservation: later }).ok).toBe(true)
    const clash = booking(
      'b2',
      'Microscope A',
      '2026-11-19T10:00:00Z',
      '2026-11-19T11:00:00Z',
    )
    expect(history.run({ kind: 'create', reservation: clash }).ok).toBe(false)
    expect(history.current.map((item) => item.start)).toEqual([
      '2026-11-19T09:30:00.000Z',
    ])
    expect(history.undo()).toBe(true)
    expect(history.current[0]!.start).toBe('2026-11-19T09:00:00.000Z')
    expect(history.redo()).toBe(true)
    expect(history.run({ kind: 'cancel', id: 'b1' }).ok).toBe(true)
    expect(history.current).toEqual([])
    expect(history.canRedo).toBe(false)
  })

  test('bookings kept as JSON come back unchanged after a reload', () => {
    const history = new History()
    history.run({ kind: 'create', reservation: b1 })
    const stored = JSON.parse(
      JSON.stringify(history.current),
    ) as Array<Reservation>
    expect(new History(stored).current).toEqual(history.current)
  })

  test('the feedback "I cannot see why this booking conflicts" is fixed against an unchanged criterion', async () => {
    const candidate = booking(
      'b3',
      'Microscope A',
      '2026-11-19T09:30:00Z',
      '2026-11-19T10:30:00Z',
    )
    const explains = await criterion({
      name: 'conflict-explained',
      version: '1',
      establishes: [
        'A refused booking names each booking in the way, who holds it, and the shared window.',
      ],
      doesNotEstablish: [
        'That a person reading it understands it: no person was asked.',
      ],
      assumptions: ['The refusal is shown as text in an alert'],
      cases: [
        {
          name: 'names the booking and the window',
          input: { held: [b1], candidate },
          expected: [
            {
              id: 'b1',
              holder: 'b1',
              resource: 'Microscope A',
              from: '2026-11-19T09:30:00.000Z',
              to: '2026-11-19T10:00:00.000Z',
            },
          ],
        },
      ],
    })
    const runWith =
      (explain: typeof refusalNow.explain) => (input: unknown) => {
        const { held, candidate: wanted } = input as {
          held: Array<Reservation>
          candidate: Reservation
        }
        let bookings: Array<Reservation> = []
        for (const item of held) {
          const placed = apply(bookings, { kind: 'create', reservation: item })
          if (!placed.ok) throw new Error(`${item.id} could not be booked.`)
          bookings = placed.reservations
        }
        const outcome = apply(bookings, { kind: 'create', reservation: wanted })
        if (outcome.ok) throw new Error('The booking was not refused.')
        return explain(outcome.refusal, wanted).clashes
      }
    const evaluator = evaluatorOf('conflict-explained', 'reservations')
    const before = await evaluate(
      explains,
      { kind: 'source', source: revision('reservations', 1) },
      evaluator,
      runWith(refusalBefore.explain),
    )
    const after = await evaluate(
      explains,
      { kind: 'source', source: revision('reservations', 2) },
      evaluator,
      runWith(refusalNow.explain),
    )
    expect(before.failed).toBe(1)
    expect(after.failed).toBe(0)
    expect(compareEvaluations(before, after)).toMatchObject({
      comparable: true,
      improved: true,
      broken: [],
    })
    // The rules did not change between the two revisions, so their evidence still stands.
    const rules = await rulesCriterion()
    const rulesBefore = await evaluate(
      rules,
      { kind: 'source', source: revision('reservations', 1) },
      evaluatorOf('reservation-rules', 'reservations'),
      runRules,
    )
    const rulesAfter = await evaluate(
      rules,
      { kind: 'source', source: revision('reservations', 2) },
      evaluatorOf('reservation-rules', 'reservations'),
      runRules,
    )
    expect(compareEvaluations(rulesBefore, rulesAfter)).toMatchObject({
      comparable: true,
      broken: [],
      fixed: [],
    })
  })

  test('a presentation revision keeps operation evidence; a rule change requires it again', async () => {
    const define = async (
      operations: Operations,
      rules: { name: string; version: string },
    ) =>
      operations.define({
        name: 'apply',
        version: rules.version,
        summary: 'Apply one booking command',
        input: {},
        output: {},
        reproducibility: 'deterministic',
        recovery: ['rerun'],
        implementation: await digestOf(rules),
        run: ({
          bookings,
          command,
        }: {
          bookings: Array<Reservation>
          command: Parameters<typeof apply>[1]
        }) => apply(bookings, command),
      })
    const input = { bookings: [], command: { kind: 'create', reservation: b1 } }
    const first = new Operations({ source: revision('reservations', 1) })
    await define(first, RULES)
    const done = await first.invoke('apply', input)
    const restyled = new Operations({ source: revision('reservations', 2) })
    await define(restyled, RULES)
    expect(await restyled.explain('apply', input, done.result)).toEqual({
      reusable: true,
    })
    const ruleChange = new Operations({ source: revision('reservations', 3) })
    await define(ruleChange, { ...RULES, version: '2' })
    expect(await ruleChange.explain('apply', input, done.result)).toEqual({
      reusable: false,
      changed: ['version', 'implementation'],
    })
  })

  test('it checks and builds as an authored App', async () => {
    const { problems, bundle } = await authoredApp(
      'reservations',
      ['main.tsx', 'rules.ts', 'refusal.ts', 'look.css'],
      'state("reservations")',
    )
    expect(problems).toEqual([])
    expect(bundle.code).toContain('Equipment bookings')
    expect(bundle.css).toContain('.refused')
  }, 180_000)
})

describe('the heat plate App', () => {
  const ROD: solverNow.RodInput = {
    length: 1,
    nodes: 11,
    conductivity: 50,
    left: { kind: 'fixed', temperature: 100 },
    right: { kind: 'fixed', temperature: 0 },
  }
  const COOLED: solverNow.RodInput = {
    ...ROD,
    right: { kind: 'convective', h: 25, ambient: 20 },
  }
  /** T(x) for a fixed left end T0 and a convective right end (Newton cooling to Ta). */
  const cooledExact = (x: number) => {
    const { h, ambient } = COOLED.right as { h: number; ambient: number }
    const bi = (h * COOLED.length) / COOLED.conductivity
    return 100 - ((100 - ambient) * (bi * x)) / (COOLED.length * (1 + bi))
  }
  const positions = [0, 0.3, 0.5, 1]

  const rodCriterion = (
    name: string,
    rod: solverNow.RodInput,
    exact: (x: number) => number,
  ) =>
    criterion({
      name,
      version: '1',
      establishes: [
        `The solver reproduces the analytic steady profile of ${name} at its sample positions.`,
      ],
      doesNotEstablish: [
        'Temperatures of a real plate: no measured material or boundary data was compared.',
      ],
      assumptions: [
        'Steady state',
        'No internal heat source',
        'Insulated sides',
        `Units: ${JSON.stringify(solverNow.UNITS)}`,
      ],
      cases: positions.map((x) => ({
        name: `x=${x}`,
        input: { rod, x },
        expected: exact(x),
        tolerance: { absolute: 1e-9 },
      })),
    })

  const sampleRod =
    (solve: typeof solverNow.solveRod) =>
    (input: unknown): number => {
      const { rod, x } = input as { rod: solverNow.RodInput; x: number }
      const found = solve(rod).find((sample) => Math.abs(sample.x - x) < 1e-12)
      if (!found) throw new Error(`No sample at x = ${x}`)
      return found.t
    }

  test('the rod reference case: T(x) = 100(1 - x/L) °C', async () => {
    const receipt = await evaluate(
      await rodCriterion('a rod with fixed ends', ROD, (x) => 100 * (1 - x)),
      { kind: 'source', source: revision('heat-plate', 2) },
      evaluatorOf('rod-analytic', 'heat-plate'),
      sampleRod(solverNow.solveRod),
    )
    expect(receipt.failed).toBe(0)
    expect(receipt.notEstablished[0]).toContain('real plate')
  })

  test('"The edge cools too quickly": the boundary discretization, not the colors, was wrong', async () => {
    const cooled = await rodCriterion(
      'a rod cooled by air at one end',
      COOLED,
      cooledExact,
    )
    const evaluator = evaluatorOf('rod-analytic', 'heat-plate')
    const before = await evaluate(
      cooled,
      { kind: 'source', source: revision('heat-plate', 1) },
      evaluator,
      sampleRod(solverBefore.solveRod),
    )
    const after = await evaluate(
      cooled,
      { kind: 'source', source: revision('heat-plate', 2) },
      evaluator,
      sampleRod(solverNow.solveRod),
    )
    // Revision 1's edge was colder than the physics allows.
    const edge = before.cases.find((item) => item.name === 'x=1')!
    expect(edge.status).toBe('fail')
    expect(edge.actual as number).toBeLessThan(cooledExact(1))
    expect(after.failed).toBe(0)
    expect(compareEvaluations(before, after)).toMatchObject({
      comparable: true,
      improved: true,
      broken: [],
    })
    // The fixed-end case did not depend on the change, and still passes on both.
    const fixed = await rodCriterion(
      'a rod with fixed ends',
      ROD,
      (x) => 100 * (1 - x),
    )
    expect(
      (
        await evaluate(
          fixed,
          { kind: 'source', source: revision('heat-plate', 1) },
          evaluator,
          sampleRod(solverBefore.solveRod),
        )
      ).failed,
    ).toBe(0)
  })

  const plate = (
    n: number,
    sides: Partial<solverNow.PlateInput>,
  ): solverNow.PlateInput => ({
    width: 1,
    height: 1,
    nx: n,
    ny: n,
    conductivity: 50,
    left: { kind: 'fixed', temperature: 0 },
    right: { kind: 'fixed', temperature: 0 },
    bottom: { kind: 'fixed', temperature: 0 },
    top: { kind: 'fixed', temperature: 0 },
    tolerance: 1e-11,
    ...sides,
  })

  test('the plate with insulated top and bottom is the rod in two dimensions', () => {
    const field = solverNow.solvePlate(
      plate(11, {
        width: 1,
        height: 0.5,
        ny: 6,
        left: { kind: 'fixed', temperature: 100 },
        bottom: { kind: 'insulated' },
        top: { kind: 'insulated' },
      }),
    )
    expect(field.converged).toBe(true)
    for (const row of field.t)
      row.forEach((t, i) =>
        expect(Math.abs(t - 100 * (1 - i / 10))).toBeLessThan(1e-8),
      )
  })

  test('refining the grid converges on the series solution at second order', () => {
    // A unit square, top edge at 100 °C, the rest at 0 °C.
    const series = (x: number, y: number) => {
      let sum = 0
      for (let n = 1; n < 400; n += 2)
        sum +=
          ((400 / (n * Math.PI)) *
            Math.sin(n * Math.PI * x) *
            (Math.exp(n * Math.PI * (y - 1)) *
              (1 - Math.exp(-2 * n * Math.PI * y)))) /
          (1 - Math.exp(-2 * n * Math.PI))
      return sum
    }
    const errors = [9, 17, 33].map((n) => {
      const field = solverNow.solvePlate(
        plate(n, { top: { kind: 'fixed', temperature: 100 } }),
      )
      expect(field.converged).toBe(true)
      // By symmetry the centre is exactly a quarter of the hot edge.
      expect(Math.abs(solverNow.sampleAt(field, 0.5, 0.5) - 25)).toBeLessThan(
        1e-8,
      )
      return Math.abs(
        solverNow.sampleAt(field, 0.25, 0.75) - series(0.25, 0.75),
      )
    })
    expect(errors[1]!).toBeLessThan(errors[0]!)
    expect(errors[2]!).toBeLessThan(errors[1]!)
    const order = Math.log2(errors[1]! / errors[2]!)
    expect(order).toBeGreaterThan(1.7)
    expect(order).toBeLessThan(2.3)
  }, 60_000)

  /**
   * T(x) of a body held at `held` at one end and cooled to `ambient` at the
   * other: linear, because steady one-dimensional conduction with no source
   * has no curvature for the ghost-node boundary to disagree with.
   */
  const linearCooling =
    (
      length: number,
      conductivity: number,
      h: number,
      ambient: number,
      held: number,
    ) =>
    (x: number) => {
      const bi = (h * length) / conductivity
      return held - ((held - ambient) * (bi * x)) / (length * (1 + bi))
    }

  /** The App's default plate size and grid: 0.005 m spacing, sides insulated. */
  const cooledPlate = (conductivity: number, h: number): solverNow.PlateInput =>
    plate(41, {
      width: 0.2,
      height: 0.1,
      ny: 21,
      conductivity,
      left: { kind: 'fixed', temperature: 100 },
      right: { kind: 'convective', h, ambient: 20 },
      bottom: { kind: 'insulated' },
      top: { kind: 'insulated' },
    })

  test('a mildly cooled edge keeps the fixed point the old sweep already had', () => {
    // The App's default: steel (k = 50) cooled by air at h = 25, so Bi =
    // 0.0025. The old sweep converged here, so this is the answer it reached;
    // correcting the boundary may change how the iteration arrives, not where.
    const input = cooledPlate(50, 25)
    const field = solverNow.solvePlate(input)
    expect(field.converged).toBe(true)
    const profile = linearCooling(0.2, 50, 25, 20, 100)
    for (const row of field.t)
      row.forEach((t, i) =>
        expect(Math.abs(t - profile(i * field.dx))).toBeLessThan(1e-8),
      )
  })

  test('"glass cooled hard on one edge": the convective sweep stays finite', () => {
    // The App's h input has a minimum of 0 and no maximum (main.tsx), and
    // glass is offered at k = 1 W/(m·K). At the default 0.005 m spacing,
    // h = 200 W/(m²·K) is Bi = 1: the cooling slope at that face is as large
    // as the node's own conductance. The old sweep carried that slope in the
    // numerator alone, so every pass multiplied the error by
    // 1 - omega (1 + Bi / 2) ~ -1.8 and the edge ran off to NaN.
    const input = cooledPlate(1, 200)
    expect(
      solverNow.cellBiot(200, input.width / (input.nx - 1), input.conductivity),
    ).toBe(1)
    const field = solverNow.solvePlate(input)
    expect(field.converged).toBe(true)
    const values = field.t.flat()
    expect(values.filter((t) => !Number.isFinite(t)).length).toBe(0)
    // With the sides insulated, every node is on the cooled rod's line, and
    // the plate's boundary equation must agree with the rod's endRow.
    const profile = linearCooling(0.2, 1, 200, 20, 100)
    for (const row of field.t)
      row.forEach((t, i) =>
        expect(Math.abs(t - profile(i * field.dx))).toBeLessThan(1e-6),
      )
    // No node runs hotter than the held edge or colder than the air.
    expect(Math.max(...values)).toBeLessThanOrEqual(100)
    expect(Math.min(...values)).toBeGreaterThanOrEqual(20)
  })

  test('Operations keeps the field of a strongly cooled glass plate', async () => {
    // The symptom seen through the operation: a diverged field has numbers
    // JSON cannot hold, so invoking `solve` refused the result outright.
    const operations = new Operations({ source: revision('heat-plate', 2) })
    operations.define({
      name: 'solve',
      version: solverNow.SOLVER.version,
      summary: 'Steady field of a plate',
      input: {},
      output: {},
      reproducibility: 'deterministic',
      recovery: ['rerun', 'reopen'],
      implementation: await implementationOf('heat-plate/solver.ts'),
      run: (given: solverNow.PlateInput) => solverNow.solvePlate(given),
    })
    const done = await operations.invoke<solverNow.PlateField>(
      'solve',
      cooledPlate(1, 200),
    )
    expect(done.output.converged).toBe(true)
    expect(done.output.t.flat().every(Number.isFinite)).toBe(true)
    expect(done.reused).toBe(false)
  })

  test('a colormap revision reuses the solved field; a boundary or solver change does not', async () => {
    // The implementation is the solver file's code, as the App's build reads
    // it, not a version someone has to remember to bump.
    const now = await implementationOf('heat-plate/solver.ts')
    const before = await implementationOf('heat-plate/revisions/1/solver.ts')
    expect(before).not.toBe(now)
    const define = async (operations: Operations, solver: typeof solverNow) =>
      operations.define({
        name: 'solve',
        version: solver.SOLVER.version,
        summary: 'Steady field of a plate',
        input: {},
        output: {},
        reproducibility: 'deterministic',
        recovery: ['rerun', 'reopen'],
        implementation: solver === solverNow ? now : before,
        run: (input: solverNow.PlateInput) => solver.solvePlate(input),
      })
    const input = plate(9, { top: { kind: 'fixed', temperature: 100 } })
    const first = new Operations({ source: revision('heat-plate', 2) })
    await define(first, solverNow)
    const solved = await first.invoke('solve', input)
    // Revision 3 changed the colormap only.
    expect(colorAt(0)).toEqual([0, 0, 4])
    const restyled = new Operations({ source: revision('heat-plate', 3) })
    await define(restyled, solverNow)
    expect(
      await restyled.adopt('solve', input, solved.output, solved.result),
    ).toEqual({ reusable: true })
    expect((await restyled.invoke('solve', input)).reused).toBe(true)
    const warmer = {
      ...input,
      right: { kind: 'convective' as const, h: 10, ambient: 20 },
    }
    expect(await restyled.explain('solve', warmer, solved.result)).toEqual({
      reusable: false,
      changed: ['input'],
    })
    const older = new Operations({ source: revision('heat-plate', 1) })
    await define(older, solverBefore as unknown as typeof solverNow)
    expect(await older.explain('solve', input, solved.result)).toEqual({
      reusable: false,
      changed: ['version', 'implementation'],
    })
  })

  describe('the field is checked against its physics, not only its sweep', () => {
    const cooled = (
      n: number,
      top: solverNow.Boundary,
    ): solverNow.PlateInput => ({
      width: 0.2,
      height: 0.1,
      nx: 2 * n + 1,
      ny: n + 1,
      conductivity: 50,
      left: { kind: 'fixed', temperature: 100 },
      right: { kind: 'convective', h: 25, ambient: 20 },
      bottom: { kind: 'insulated' },
      top,
      tolerance: 1e-12,
    })

    test('heat through a plate with insulated sides is the series resistance, edge for edge', () => {
      const input = cooled(10, { kind: 'insulated' })
      const check = solverNow.checkPlate(input, solverNow.solvePlate(input))
      // q = (100 - 20) / (L / k + 1 / h) W/m², over the 0.1 m edge.
      const exact = (80 / (0.2 / 50 + 1 / 25)) * 0.1
      expect(Math.abs(check.edges.left - exact)).toBeLessThan(1e-6)
      expect(Math.abs(check.edges.right + exact)).toBeLessThan(1e-6)
      expect(check.edges.top).toBe(0)
      expect(check.relativeImbalance).toBeLessThan(1e-9)
      expect(check.residual).toBeLessThan(1e-9)
    })

    test('a cooled top edge: the heat balance closes at second order as the grid is refined', () => {
      const top = { kind: 'convective', h: 200, ambient: 20 } as const
      const ratios = [10, 20, 40].map((n) => {
        const input = cooled(n, top)
        const field = solverNow.solvePlate(input)
        expect(field.converged).toBe(true)
        const check = solverNow.checkPlate(input, field)
        expect(check.residual).toBeLessThan(1e-9)
        // Heat enters only at the held edge and leaves through both cooled ones.
        expect(check.edges.left).toBeGreaterThan(0)
        expect(check.edges.right).toBeLessThan(0)
        expect(check.edges.top).toBeLessThan(0)
        return check.relativeImbalance
      })
      expect(ratios[1]!).toBeLessThan(1e-3)
      // Halving the spacing cuts the imbalance by close to four.
      expect(ratios[0]! / ratios[1]!).toBeGreaterThan(3)
      expect(ratios[1]! / ratios[2]!).toBeGreaterThan(3)
    })

    test('a sweep stopped early says so, and the check shows how far off it is', () => {
      const input = {
        ...cooled(20, { kind: 'convective', h: 200, ambient: 20 } as const),
        maxSweeps: 5,
      }
      const field = solverNow.solvePlate(input)
      expect(field.converged).toBe(false)
      const check = solverNow.checkPlate(input, field)
      expect(check.residual).toBeGreaterThan(1)
      expect(check.relativeImbalance).toBeGreaterThan(0.5)
    })

    test('controls out of range are refused by name, never clamped into a field', () => {
      const input: solverNow.PlateInput = {
        ...cooled(10, { kind: 'insulated' }),
        nx: 2.5,
        ny: solverNow.MAX_NODES + 1,
        conductivity: 0,
        right: { kind: 'convective', h: -1, ambient: Number.NaN },
        left: { kind: 'fixed', temperature: -300 },
        tolerance: 0,
      }
      expect(solverNow.plateProblems(input).map((p) => p.field)).toEqual([
        'conductivity',
        'nx',
        'ny',
        'left.temperature',
        'right.h',
        'right.ambient',
        'tolerance',
      ])
      expect(() => solverNow.solvePlate(input)).toThrow(solverNow.PlateRefused)
      expect(
        solverNow.plateProblems(cooled(10, { kind: 'insulated' })),
      ).toEqual([])
    })
  })

  test('it checks and builds as an authored App', async () => {
    const { problems, bundle } = await authoredApp(
      'heat-plate',
      ['main.tsx', 'solver.ts', 'colormap.ts', 'look.css'],
      'state("plate")',
    )
    expect(problems).toEqual([])
    expect(bundle.code).toContain('Heat through a plate')
  }, 180_000)
})
