import { describe, expect, test } from 'bun:test'
import {
  ARTIFACT_RUNTIME_SCHEMA,
  ContextSession,
  SessionObservations,
  bitsOf,
  bitsValue,
  canonicalJson,
  digestOf,
  integerOf,
  integerText,
  readObservationRef,
  sameSource,
  signalText,
  signalValue,
} from './index'
import type { ContextBinding, ObservationRef } from './index'

const U64_MAX = 18446744073709551615n

const observation = (
  index: string,
  stateDigest: ObservationRef['stateDigest'],
): ObservationRef => ({
  schema: ARTIFACT_RUNTIME_SCHEMA,
  runId: 'run-1',
  index,
  domain: 'settlement',
  time: index,
  stateDigest,
})

describe('exact values', () => {
  test('a 64-bit value round-trips through JSON without loss', () => {
    const value = bitsOf(U64_MAX, 64)
    expect(value).toEqual({ type: 'bits', width: 64, hex: 'ffffffffffffffff' })
    const back = JSON.parse(JSON.stringify(value)) as typeof value
    expect(bitsValue(back)).toBe(U64_MAX)
    // The same value through a number would not survive.
    expect(BigInt(Number(U64_MAX))).not.toBe(U64_MAX)
  })

  test('signed bits are two’s complement and refuse what does not fit', () => {
    expect(bitsOf(-1, 8, true)).toEqual({ type: 'bits', width: 8, hex: 'ff' })
    expect(bitsValue(bitsOf(-128, 8, true), true)).toBe(-128n)
    expect(() => bitsOf(256, 8)).toThrow('does not fit')
    expect(() => bitsOf(128, 8, true)).toThrow('does not fit')
    expect(() => bitsOf(2 ** 60, 64)).toThrow('pass a bigint')
  })

  test('a 32-bit register value is kept, not masked to zero', () => {
    expect(bitsValue(bitsOf(42, 32))).toBe(42n)
    expect(bitsValue(bitsOf(0xffffffff, 32))).toBe(0xffffffffn)
  })

  test('counters past 2^53 stay integer text', () => {
    expect(integerText(2n ** 64n)).toBe('18446744073709551616')
    expect(() => integerText(2 ** 53)).toThrow('safe')
    expect(() => integerText(-1)).toThrow()
    expect(integerOf(-(2n ** 70n))).toEqual({
      type: 'integer',
      text: '-1180591620717411303424',
    })
  })

  test('values without a descriptor keep their kind', () => {
    expect(signalValue(12)).toEqual({ type: 'integer', text: '12' })
    expect(signalValue(0.5)).toEqual({ type: 'real', value: 0.5 })
    expect(signalValue(U64_MAX)).toEqual({
      type: 'integer',
      text: '18446744073709551615',
    })
    expect(signalValue(true)).toEqual({ type: 'bool', value: true })
    expect(signalText(signalValue(12, { type: 'bits', width: 8 }))).toBe(
      '0x0c (12)',
    )
  })
})

describe('digests', () => {
  test('canonical JSON sorts keys and keeps bigints exact', () => {
    expect(canonicalJson({ b: 1, a: [true, null], c: undefined })).toBe(
      '{"a":[true,null],"b":1}',
    )
    expect(canonicalJson({ n: U64_MAX })).toBe(
      '{"n":{"$bigint":"18446744073709551615"}}',
    )
    expect(() => canonicalJson({ x: Number.NaN })).toThrow()
  })

  test('equal states have equal digests whatever their key order', async () => {
    const a = await digestOf({ x: 1, y: { p: 2, q: 3 } })
    const b = await digestOf({ y: { q: 3, p: 2 }, x: 1 })
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await digestOf({ x: 2, y: { p: 2, q: 3 } })).not.toBe(a)
  })
})

describe('the digest the backend run store checks', () => {
  test('matches the shared vector theorem-apps holds', async () => {
    // The same value and digest are asserted by theorem-apps' artifact_run tests.
    const value = {
      values: { add: { a: 7, b: 5, sum: 12, cout: 0 }, 'add/state': {} },
      pins: { 'add.cin': 0 },
      label: 'Ünïcode "q"\n\u0001',
      list: [1, 'two', null, true, 0.5],
    }
    expect(await digestOf(value)).toBe(
      'sha256:63d4f3deff0b7c66cdabd4cc4b66de75e6ad993229e08706413d2ef116f1a3b2',
    )
  })
})

describe('references', () => {
  test('an observation reference of another schema is not read', async () => {
    const ref = observation('3', await digestOf({ s: 1 }))
    expect(readObservationRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref)
    expect(
      readObservationRef({ ...ref, schema: 'theorem.artifact-runtime/0' }),
    ).toBeUndefined()
    expect(readObservationRef({ ...ref, index: 3 })).toBeUndefined()
  })

  test('source references compare by exact revision', () => {
    const a = {
      kind: 'document' as const,
      documentId: 'd',
      position: '4',
      contentDigest: 'x',
    }
    expect(sameSource(a, { ...a })).toBe(true)
    expect(sameSource(a, { ...a, position: '5' })).toBe(false)
  })
})

describe('session observations', () => {
  test('an evicted or unknown observation is unavailable, never the latest', async () => {
    const kept = new SessionObservations<string>(2)
    const refs = await Promise.all(
      ['0', '1', '2'].map(async (index) =>
        observation(index, await digestOf({ index })),
      ),
    )
    for (const ref of refs) kept.keep(ref, `state ${ref.index}`)
    expect(kept.resolve(refs[0]!)).toEqual({
      status: 'unavailable',
      ref: refs[0]!,
      reason: 'evicted',
    })
    expect(kept.resolve(refs[2]!)).toMatchObject({
      status: 'available',
      value: 'state 2',
      lifetime: 'session',
    })
    expect(kept.resolve(observation('9', refs[0]!.stateDigest))).toMatchObject({
      reason: 'not-kept',
    })
    expect(
      kept.resolve({ ...refs[2]!, stateDigest: refs[1]!.stateDigest }),
    ).toMatchObject({
      reason: 'digest-mismatch',
    })
  })

  test('a captured binding does not follow later changes', async () => {
    const session = new ContextSession()
    const binding: ContextBinding = {
      schema: ARTIFACT_RUNTIME_SCHEMA,
      presentation: {
        source: {
          kind: 'document',
          documentId: 'd',
          position: '1',
          contentDigest: 'a',
        },
      },
      subject: {
        kind: 'moment',
        observation: observation('1', await digestOf(1)),
      },
    }
    session.set(binding)
    const asked = session.capture()
    session.focus({
      kind: 'moment',
      observation: observation('2', await digestOf(2)),
    })
    expect(asked?.subject).toMatchObject({ observation: { index: '1' } })
    expect(session.current?.subject).toMatchObject({
      observation: { index: '2' },
    })
  })
})
