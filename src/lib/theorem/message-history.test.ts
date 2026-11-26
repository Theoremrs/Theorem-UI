import { expect, test } from 'bun:test'
import { AUTHOR_METADATA, CONTEXT_REFERENCES_METADATA, toHistoryMessages, hasTheoremError } from './message-history'
import type { Theorem } from './client'

function assistant(id: string, parts: Theorem.StoredPart[]): Theorem.Message {
  return {
    schema: 'theorem.chat.message.v1', messageId: id, tenantId: 'tenant',
    threadId: 'thread', originBranchId: 'branch', role: 'assistant',
    runId: `run-${id}`, parts, createdAtMs: 1,
  }
}
const failure = {
  partId: 'error-1', type: 'error', payload: {
    code: 'agent_iteration_limit', message: 'The agent reached its step limit.',
    correlationId: 'chatreq-regression', recoverable: true,
  },
}

test('reload restores an earlier failed turn even after a subsequent successful turn', () => {
  const messages = toHistoryMessages([
    assistant('failed', [failure]),
    assistant('completed', [{ partId: 'text-2', type: 'text', payload: { text: 'Done.' } }]),
  ])
  expect(messages[0]?.status).toEqual({
    type: 'incomplete', reason: 'error',
    error: 'The agent reached its step limit. Reference: chatreq-regression',
  })
  expect(messages[1]?.status).toEqual({ type: 'complete', reason: 'unknown' })
  expect(hasTheoremError(messages[0]!.content)).toBe(true)
  expect(hasTheoremError(messages[1]!.content)).toBe(false)
})

test('tool failures alone do not mark a recovered response as failed', () => {
  const [message] = toHistoryMessages([assistant('recovered', [
    { partId: 'tool', type: 'tool_result', payload: { toolCallId: 'call', status: 'failed', safeOutput: { error: 'unavailable' } } },
    { partId: 'text', type: 'text', payload: { text: 'Here is an alternative.' } },
  ])])
  expect(message?.status?.type).toBe('complete')
  expect(hasTheoremError(message!.content)).toBe(false)
})

test('plain runtime errors retain their standard error renderer', () => {
  expect(hasTheoremError([{ type: 'text', text: 'partial response' }])).toBe(false)
  expect(hasTheoremError('partial response')).toBe(false)
})

test('a stored user message brings back the references it was sent with, on its metadata', () => {
  const reference = { label: 'App', location: { resource: { kind: 'graph-object', objectId: 'doc', objectType: 'theorem.app' } }, excerpt: '{}' }
  const asked = {
    schema: 'theorem.chat.message.v1', messageId: 'asked', tenantId: 'tenant', threadId: 'thread',
    originBranchId: 'branch', role: 'user', parts: [{ partId: 'p', type: 'text', payload: { text: 'Why?' } }],
    createdAtMs: 1, contextReferences: [reference],
  } as unknown as Theorem.Message
  const plain = { ...asked, messageId: 'plain', contextReferences: undefined } as unknown as Theorem.Message
  const [withReferences, without] = toHistoryMessages([asked, plain])
  expect(withReferences?.metadata?.custom?.[CONTEXT_REFERENCES_METADATA]).toEqual([reference])
  expect(without?.metadata?.custom?.[CONTEXT_REFERENCES_METADATA]).toBeUndefined()
})

const said = (text: string) => [
  { partId: 'text', type: 'text', payload: { text } },
]
/** A reply as a room stores it: the participant that wrote it is in its routing. */
const byParticipant = (
  id: string,
  participantId: string,
  label: string,
  text: string,
) =>
  ({
    ...assistant(id, said(text)),
    routing: {
      author: {
        kind: 'participant',
        participantId,
        actorId: `agent:${participantId}`,
        model: { provider: 'p', model: label },
        label,
      },
      audience: { kind: 'everyone' },
      delivery: 'passive',
      rosterRevision: 3,
    },
  }) as Theorem.Message

test('each stored reply of a room keeps the participant that wrote it, and none is merged', () => {
  const messages = toHistoryMessages([
    byParticipant('a', 'ptc_a', 'Alpha', 'The cache is stale.'),
    byParticipant('b', 'ptc_b', 'Beta', 'The index is wrong.'),
  ])
  expect(messages).toHaveLength(2)
  expect(
    messages.map(
      (m) =>
        (m.metadata?.custom as Record<string, { label: string }>)[
          AUTHOR_METADATA
        ]?.label,
    ),
  ).toEqual(['Alpha', 'Beta'])
  expect(messages.map((m) => m.id)).toEqual(['a', 'b'])
})

test("a reply with no participant author, or a person's message, is not given one", () => {
  const [plain, person] = toHistoryMessages([
    assistant('plain', said('Hi.')),
    {
      ...assistant('person', said('Hello')),
      role: 'user',
      routing: {
        author: { kind: 'person' },
        audience: { kind: 'everyone' },
        delivery: 'wake',
        rosterRevision: 3,
      },
    } as unknown as Theorem.Message,
  ])
  expect(
    (plain!.metadata?.custom as Record<string, unknown>)?.[AUTHOR_METADATA],
  ).toBeUndefined()
  expect(
    (person!.metadata?.custom as Record<string, unknown>)?.[AUTHOR_METADATA],
  ).toBeUndefined()
})
