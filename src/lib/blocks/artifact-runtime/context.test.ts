// The contract cases of the general-creation addendum (G0, G1): a static
// result, a batch result and an ordinary App's data observation are subjects
// with no run, clock, scene or checkpoint; an imported measurement and an
// unversioned external response keep what is known and claim nothing more; a
// selection is carried for the artifact to interpret; an operation that no
// example defined is discovered and invoked through the same path.
import { describe, expect, test } from 'bun:test'
import {
  ARTIFACT_RUNTIME_SCHEMA,
  ContextSession,
  Operations,
  digestOf,
  readContextBinding,
  readResultRef,
  readSelectionRef,
  readSubjectRef,
  resultIdHolds,
  resultRef,
  sameSubject,
  subjectLabel,
} from './index'
import type { ArtifactSourceRef, ContextBinding, ResultRef, SelectionRef } from './index'

const source: ArtifactSourceRef = {
  kind: 'document',
  documentId: 'heat',
  position: '7',
  contentDigest: 'c7',
}
const RUN_FIELDS = ['runId', 'run', 'index', 'time', 'domain', 'checkpoint', 'stateDigest']

const keysOf = (value: unknown): Array<string> =>
  value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)])
    : []

describe('subjects without a run', () => {
  test('a static result: a rendered diagram, from a source, nothing executed', async () => {
    const svg = '<svg viewBox="0 0 10 10"/>'
    const result = await resultRef({
      content: await digestOf(svg),
      mediaType: 'image/svg+xml',
      provenance: { kind: 'computed', source },
      reproducibility: 'deterministic',
    })
    expect(await resultIdHolds(result)).toBe(true)
    expect(readResultRef(JSON.parse(JSON.stringify(result)))).toEqual(result)
    expect(keysOf(result).filter((key) => RUN_FIELDS.includes(key))).toEqual([])
  })

  test('a batch result: a solved temperature field with its inputs and operation', async () => {
    const field = { unit: 'degC', x: [0, 0.5, 1], t: [100, 50, 0] }
    const result = await resultRef({
      content: await digestOf(field),
      mediaType: 'application/json',
      representation: { schema: 'heat.field-1d', version: '1' },
      provenance: {
        kind: 'computed',
        source,
        operation: { name: 'solve', version: '2', schema: 'theorem.operation' },
        inputs: { boundary: await digestOf({ left: 100, right: 0 }) },
      },
      reproducibility: 'deterministic',
    })
    const binding: ContextBinding = {
      schema: ARTIFACT_RUNTIME_SCHEMA,
      presentation: { source: { ...source, position: '9', contentDigest: 'c9' } },
      subject: { kind: 'result', result },
      selection: { schema: 'heat.sample', version: '1', value: { x: 0.5 } },
    }
    const read = readContextBinding(JSON.parse(JSON.stringify(binding)))
    expect(read).toEqual(binding)
    // The presentation is revision 9; the result it shows was computed at 7.
    expect(read?.presentation.source).not.toEqual(
      read?.subject?.kind === 'result' && read.subject.result.provenance.kind === 'computed'
        ? read.subject.result.provenance.source
        : undefined,
    )
    expect(keysOf(binding).filter((key) => RUN_FIELDS.includes(key))).toEqual([])
  })

  test('an ordinary App data observation: the reservations as they were, at a data version', async () => {
    const rows = [{ id: 'r1', resource: 'scope', start: '2026-11-18T09:00:00Z', end: '2026-11-18T10:00:00Z' }]
    const observed = await resultRef({
      content: await digestOf(rows),
      mediaType: 'application/json',
      provenance: {
        kind: 'captured',
        capturedAt: '2026-11-18T19:20:00Z',
        capturer: { source },
        from: { system: 'reservations', version: '412' },
        unknowns: [],
      },
    })
    expect(observed.reproducibility).toBe('unknown')
    expect(subjectLabel({ kind: 'result', result: observed })).toBe(
      'reservations at 412, captured 2026-11-18T19:20:00Z',
    )
    expect(keysOf(observed).filter((key) => RUN_FIELDS.includes(key))).toEqual([])
  })
})

describe('captured results claim only what is known', () => {
  test('an imported measurement keeps its bytes and capture, with no producer build', async () => {
    const csv = 'x_m,t_degC\n0,99.6\n0.5,50.8\n1,0.3\n'
    const measured = await resultRef({
      content: await digestOf(csv),
      bytes: String(csv.length),
      mediaType: 'text/csv',
      provenance: {
        kind: 'captured',
        capturedAt: '2026-11-18T19:21:00+00:00',
        producer: { instrument: 'thermocouple array', operator: 'uploaded by Travis' },
        unknowns: ['instrument-calibration', 'producer-build'],
      },
      // Asked for, but a capture is never reproducible by claim.
      reproducibility: 'deterministic',
    })
    expect(measured.reproducibility).toBe('unknown')
    expect(measured.provenance).not.toHaveProperty('build')
    expect(readResultRef(measured)).toEqual(measured)
    // A reader refuses a capture that says it can be reproduced.
    expect(readResultRef({ ...measured, reproducibility: 'deterministic' })).toBeUndefined()
  })

  test('an unversioned external response says it has no version', async () => {
    const response = { status: 'available', slots: 3 }
    const captured = await resultRef({
      content: await digestOf(response),
      mediaType: 'application/json',
      provenance: {
        kind: 'captured',
        capturedAt: '2026-11-18T19:22:00Z',
        capturer: { source, build: await digestOf('adapter build') },
        from: { system: 'https://booking.example/api/slots', locator: 'GET ?day=2026-11-19' },
        unknowns: ['data-version'],
      },
    })
    const subject = readSubjectRef({ kind: 'result', result: captured })
    expect(subject?.kind).toBe('result')
    expect(subjectLabel(subject!)).toBe(
      'https://booking.example/api/slots, captured 2026-11-18T19:22:00Z',
    )
  })
})

describe('subjects and selections', () => {
  test('a run moment is one kind of subject, not the only one', async () => {
    const moment = readSubjectRef({
      kind: 'moment',
      observation: {
        schema: ARTIFACT_RUNTIME_SCHEMA,
        runId: 'adder:0',
        index: '0',
        domain: 'settlement',
        time: '0',
        stateDigest: await digestOf({}),
      },
    })
    expect(moment?.kind).toBe('moment')
    expect(readSubjectRef({ kind: 'moment', observation: { runId: 'x' } })).toBeUndefined()
    expect(readSubjectRef({ kind: 'scene' })).toBeUndefined()
  })

  test('a selection is carried unread and interpreted by the authored artifact', async () => {
    // An interpreter written for this artifact only: the host never sees it.
    const interpretRow = (selection: SelectionRef, rows: Array<{ id: string }>) =>
      selection.schema === 'reservations.row' && selection.version === '1'
        ? rows.find((row) => row.id === (selection.value as { id: string }).id)
        : undefined
    const selection = readSelectionRef({
      schema: 'reservations.row',
      version: '1',
      value: { id: 'r2' },
      label: 'Scope, 10:00 to 11:00',
    })!
    expect(interpretRow(selection, [{ id: 'r1' }, { id: 'r2' }])).toEqual({ id: 'r2' })
    expect(readSelectionRef({ schema: 'x', version: '1', value: 'y'.repeat(4000) })).toBeUndefined()
    expect(readSelectionRef({ schema: 'x', value: 1 })).toBeUndefined()
  })

  test('a captured context keeps its subject after the person moves on', async () => {
    const first = await resultRef({
      content: await digestOf([1]),
      mediaType: 'application/json',
      provenance: { kind: 'captured', capturedAt: '2026-11-18T19:00:00Z', from: { system: 'reservations', version: '1' }, unknowns: [] },
    })
    const second = await resultRef({
      content: await digestOf([1, 2]),
      mediaType: 'application/json',
      provenance: { kind: 'captured', capturedAt: '2026-11-18T19:05:00Z', from: { system: 'reservations', version: '2' }, unknowns: [] },
    })
    const session = new ContextSession()
    session.set({ schema: ARTIFACT_RUNTIME_SCHEMA, presentation: { source }, subject: { kind: 'result', result: first } })
    session.select({ schema: 'reservations.row', version: '1', value: { id: 'r1' } })
    const asked = session.capture()!
    session.focus({ kind: 'result', result: second })
    expect(sameSubject(asked.subject, { kind: 'result', result: first })).toBe(true)
    expect(asked.selection?.value).toEqual({ id: 'r1' })
    expect(sameSubject(session.current?.subject, asked.subject)).toBe(false)
    // Moving to another subject drops a selection made inside the old one.
    expect(session.current?.selection).toBeUndefined()
  })
})

describe('authored operations', () => {
  const slider = (runsIn: ArtifactSourceRef = source, version = '1') => {
    const operations = new Operations({ source: runsIn })
    let runs = 0
    // An operation none of the seed examples defines: slider-crank kinematics.
    operations.define<{ r: number; l: number; theta: number }, { x: number }>({
      name: 'slider.position',
      version,
      summary: 'Slider position of a slider-crank at crank angle theta (radians).',
      input: { type: 'object', required: ['r', 'l', 'theta'] },
      output: { type: 'object', properties: { x: { type: 'number' } } },
      reproducibility: 'deterministic',
      recovery: ['rerun'],
      examples: [{ input: { r: 1, l: 3, theta: 0 }, output: { x: 4 } }],
      accepts: (input): input is { r: number; l: number; theta: number } =>
        typeof input === 'object' && input !== null && ['r', 'l', 'theta'].every((key) => typeof (input as Record<string, unknown>)[key] === 'number'),
      run: ({ r, l, theta }) => {
        runs += 1
        return { x: r * Math.cos(theta) + Math.sqrt(l * l - r * r * Math.sin(theta) ** 2) }
      },
    })
    return { operations, runs: () => runs }
  }

  test('is discovered with its signature and examples, without its code', () => {
    const { operations } = slider()
    const [listed] = operations.list()
    expect(listed).toMatchObject({ name: 'slider.position', version: '1', recovery: ['rerun'] })
    expect(listed).not.toHaveProperty('run')
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed)
  })

  test('is invoked through the same path, and its result says how it was made', async () => {
    const { operations } = slider()
    const at = async (theta: number) =>
      (await operations.invoke<{ x: number }>('slider.position', { r: 1, l: 3, theta })).output.x
    expect(await at(0)).toBeCloseTo(4, 12)
    expect(await at(Math.PI / 2)).toBeCloseTo(Math.sqrt(8), 12)
    expect(await at(Math.PI)).toBeCloseTo(2, 12)
    const { result } = await operations.invoke('slider.position', { r: 1, l: 3, theta: 1 })
    expect(result.provenance).toMatchObject({ kind: 'computed', operation: { name: 'slider.position', version: '1' } })
    expect(await resultIdHolds(result)).toBe(true)
    await expect(operations.invoke('slider.position', { r: 1 })).rejects.toThrow('does not accept')
    await expect(operations.invoke('step', {})).rejects.toThrow('No operation')
  })

  test('reuses an exact result and recomputes when the input or version changes', async () => {
    const { operations, runs } = slider()
    const input = { r: 1, l: 3, theta: 0.5 }
    const first = await operations.invoke('slider.position', input)
    const again = await operations.invoke('slider.position', { theta: 0.5, l: 3, r: 1 })
    expect(again.reused).toBe(true)
    expect(again.result.id).toBe(first.result.id)
    expect(runs()).toBe(1)
    await operations.invoke('slider.position', { ...input, l: 4 })
    expect(runs()).toBe(2)
    const key = await operations.key('slider.position', input)
    expect(await slider({ ...source, position: '8', contentDigest: 'c8' }).operations.key('slider.position', input)).not.toBe(key)
    expect(await slider(source, '2').operations.key('slider.position', input)).not.toBe(key)
    expect(await slider().operations.key('slider.position', input)).toBe(key)
    expect(await operations.key('slider.position', input)).not.toBe(
      await operations.key('slider.position', { ...input, theta: 0.6 }),
    )
  })
})

// Type-level: a ResultRef never requires run fields.
const _static: Omit<ResultRef, 'id' | 'schema'> = {
  content: 'sha256:00',
  mediaType: 'text/plain',
  provenance: { kind: 'captured', capturedAt: 'x', unknowns: [] },
  reproducibility: 'unknown',
}
void _static
