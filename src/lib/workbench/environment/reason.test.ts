// SOURCING: none — bun:test over ./workspace-recovery's reason and ./redact, with the SDK's own error classes; AC-51 (R40) and AC-53 (R42) at the owners' shared error reading
import { describe, expect, test } from 'bun:test'
import { TheoremError, TheoremTimeoutError } from '@theoremharness/sdk'
import { readable, REASON_LIMIT, redact } from './redact'
import { reason } from './workspace-recovery'

const KEY = 'sk-live-Zx9Qw8Er7Ty6Ui5Op4As3Df2'
const BEARER = 'Bearer 9f8e7d6c5b4a39281706deadbeefcafe'
const FILE = `API_KEY=${KEY}\nAuthorization: ${BEARER}\nFILE-BODY-LINE-ONE`

describe('reason reads an error as one short readable sentence', () => {
  test('a structured object with a code, a status and a nested body is its nested words, never [object Object]', () => {
    const structured = {
      code: 'host_operation_failed',
      status: 500,
      body: { error: { code: 'x', message: 'The checkout is locked' } },
    }
    expect(reason(structured)).toBe('The checkout is locked')
  })

  test('an object with no words of its own is its status and code', () => {
    expect(reason({ code: 'host_operation_failed', status: 502 })).toBe(
      'The host answered 502 (host_operation_failed)',
    )
    expect(reason({ statusCode: 409, body: { code: 'stale_revision' } })).toBe(
      'The host answered 409 (stale_revision)',
    )
    expect(reason({})).toBe('The request failed')
  })

  test('nothing a person would see is the text of an object, a stack or nothing', () => {
    const samples: unknown[] = [
      {},
      { a: { b: { c: { d: { e: 1 } } } } },
      [],
      null,
      undefined,
      42,
      Symbol('s'),
      new Error('boom'),
      new TheoremError({ statusCode: 500, body: { code: 'x' } }),
      new TheoremTimeoutError('Timeout exceeded when calling GET /x'),
    ]
    for (const sample of samples) {
      const text = reason(sample)
      expect(text, String(Object.prototype.toString.call(sample))).not.toBe('')
      expect(text).not.toContain('[object')
      expect(text).not.toMatch(/\n\s+at /)
      expect(text).not.toContain('undefined')
    }
  })

  test('an SDK error is its own words, not the raw status and body its message dumps', () => {
    const error = new TheoremError({
      message: 'The host refused the edit',
      statusCode: 422,
      body: { echo: FILE },
    })
    expect(error.message).toContain('FILE-BODY-LINE-ONE')
    expect(reason(error)).toBe('The host refused the edit')
    const bare = new TheoremError({ statusCode: 500, body: { echo: FILE } })
    expect(reason(bare)).toBe('The host answered 500')
  })

  test('a timeout keeps its own message', () => {
    expect(
      reason(new TheoremTimeoutError('Timeout exceeded when calling GET /x')),
    ).toBe('Timeout exceeded when calling GET /x')
  })

  test('a body that echoes content or a credential is masked and cut', () => {
    const detail = `invalid text: ${FILE}${' padding'.repeat(80)}`
    const text = reason(
      new TheoremError({ statusCode: 422, body: { code: 'bad', detail } }),
    )
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('9f8e7d6c5b4a39281706deadbeefcafe')
    expect(text.length).toBeLessThanOrEqual(REASON_LIMIT + 3)
  })

  test('a string body is a raw page, never words to show', () => {
    const error = Object.assign(new Error('Bad gateway'), {
      statusCode: 502,
      body: `<html>${FILE}</html>`,
    })
    expect(reason(error)).toBe('Bad gateway')
  })
})

describe('redact masks credential-shaped text and leaves ordinary words', () => {
  test('API keys, bearer tokens, JWTs, key=value pairs and long unlabelled keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlMTIzNDU2'
    const text = [
      KEY,
      BEARER,
      jwt,
      'password=hunter2hunter2',
      '"token":"abcd1234efgh"',
      'ghp_abcdefghijklmnop1234',
      'AKIAABCDEFGHIJKLMNOP',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
    ].join(' ')
    const out = redact(text)
    for (const secret of [
      KEY,
      '9f8e7d6c5b4a39281706deadbeefcafe',
      jwt,
      'hunter2hunter2',
      'abcd1234efgh',
      'ghp_abcdefghijklmnop1234',
      'AKIAABCDEFGHIJKLMNOP',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
    ])
      expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })

  test('paths, ids, branch names and sentences survive', () => {
    const plain =
      'src/skills-directory/pkg-manager.ts at revision 12 for hc-3f2a9c1e-77aa-4b1c-9d3e-0123456789ab on branch feat/task-runner'
    expect(redact(plain)).toBe(plain)
    expect(readable('  one\n  line  ')).toBe('one line')
  })
})
