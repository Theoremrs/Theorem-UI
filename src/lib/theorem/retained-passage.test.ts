import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  openRetainedPassage,
  retainedPassageFailureMessage,
} from './retained-passage'
import type {
  RetainedPassage,
  RetainedPassageFailure,
} from './retained-passage'
import { theorem } from './client'

const durable = {
  threadId: 'thread-1',
  messageId: 'assistant-1',
  partId: 'cite-2',
}
const passageBody: RetainedPassage = {
  source: {
    handle: 'source:first',
    version: 'blake3:aaa',
    extractionVersion: 'extractor/2',
    textBasis: 'utf8-extracted-text',
    textBytes: 4096,
    coverage: { status: 'complete' },
  },
  span: { startByte: 210, endByte: 280 },
  excerpt: 'The exact retained passage.',
}

// The SDK client builds request URLs from the page origin, as every other
// chat call does; happy-dom starts at about:blank, so name an origin.
const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

/** Replace the SDK transport for one assertion pass; restores after. */
async function withTransport(
  respond: (url: string, init: RequestInit | undefined) => Response,
  check: (calls: Array<{ url: string }>) => Promise<void>,
): Promise<void> {
  const calls: Array<{ url: string }> = []
  const original = window.fetch
  // The SDK client captures window.fetch, so the spy replaces that binding.
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url })
    return Promise.resolve(respond(url, init))
  }) as typeof fetch
  try {
    await check(calls)
  } finally {
    window.fetch = original
  }
}

describe('openRetainedPassage', () => {
  test('names the durable chat route through the SDK transport, once per click', async () => {
    await withTransport(
      () => Response.json(passageBody),
      async (calls) => {
        const result = await openRetainedPassage(durable)
        expect(result).toEqual({ ok: true, passage: passageBody })
        expect(calls).toHaveLength(1)
        const url = new URL(calls[0]!.url)
        expect(url.pathname).toBe(
          '/api/chat/v1/threads/thread-1/messages/assistant-1/citations/cite-2',
        )
        // The same origin as every other chat call: the server-side proxy
        // attaches the token. No object-store URL exists anywhere.
        expect(url.origin).toBe('http://localhost:3000')
      },
    )
  })

  test.each([
    ['a live reply', { ...durable, messageId: 'run:run-9' }],
    ['a missing message id', { ...durable, messageId: undefined }],
    ['a missing part id', { ...durable, partId: undefined }],
    ['a missing thread id', { ...durable, threadId: undefined }],
  ])('refuses %s locally and issues no request', async (_label, names) => {
    await withTransport(
      () => Response.json(passageBody),
      async (calls) => {
        const result = await openRetainedPassage(names)
        expect(result).toEqual({
          ok: false,
          failure: { kind: 'notDurable' },
        })
        expect(calls).toHaveLength(0)
      },
    )
  })

  test.each<[number, RetainedPassageFailure['kind'], string]>([
    [404, 'missing', 'not available to open'],
    [410, 'unavailable', 'no longer available'],
    [503, 'store', 'could not be opened right now'],
  ])(
    'maps status %i to the typed %s outcome and says so honestly',
    async (status, kind, phrase) => {
      await withTransport(
        () =>
          Response.json(
            {
              type: `/problems/cited_passage_${kind}`,
              title: 'Problem',
              status,
              code: `cited_passage_${kind}`,
              correlationId: 'corr-1',
            },
            { status },
          ),
        async () => {
          const result = await openRetainedPassage(durable)
          if (result.ok) throw new Error('unexpected success')
          expect(result.failure.kind).toBe(kind)
          expect(retainedPassageFailureMessage(result.failure)).toContain(
            phrase,
          )
        },
      )
    },
  )

  test('a 200 that is not the declared passage is refused, never shown as empty evidence', async () => {
    for (const body of [
      {},
      { source: passageBody.source, span: passageBody.span },
      { ...passageBody, span: { startByte: 'x', endByte: 280 } },
      { ...passageBody, span: { startByte: 210, endByte: 5000 } },
      {
        ...passageBody,
        source: {
          ...passageBody.source,
          coverage: { status: 'partial_rehydration', fetchedBytes: 50 },
        },
      },
      'not an object',
    ]) {
      await withTransport(
        () => Response.json(body),
        async () => {
          expect(await openRetainedPassage(durable)).toEqual({
            ok: false,
            failure: { kind: 'malformed' },
          })
        },
      )
    }
  })

  test('a transport failure is a store outcome, not a fabricated absence', async () => {
    await withTransport(
      () => {
        throw new TypeError('network down')
      },
      async () => {
        expect(await openRetainedPassage(durable)).toEqual({
          ok: false,
          failure: { kind: 'store' },
        })
      },
    )
  })

  test('ids are escaped into their own path segments', async () => {
    await withTransport(
      () => Response.json(passageBody),
      async (calls) => {
        await openRetainedPassage({
          threadId: 'thread/1',
          messageId: 'assistant 1',
          partId: 'cite?2#x',
        })
        expect(new URL(calls[0]!.url).pathname).toBe(
          '/api/chat/v1/threads/thread%2F1/messages/assistant%201/citations/cite%3F2%23x',
        )
      },
    )
  })

  test('the app keeps its own durable-id rule for the message it opens', async () => {
    // Regression guard for the SDK's live-run synthetic id: only saved
    // history may be opened, so the caller's durable id must survive the
    // projection exactly as stored.
    expect(theorem).toBeTypeOf('function')
    const result = await openRetainedPassage({
      threadId: 'thread-1',
      messageId: 'run:',
      partId: 'cite-2',
    })
    expect(result).toEqual({ ok: false, failure: { kind: 'notDurable' } })
  })
})
