// SOURCING: bun:test over the mention encoding and Markdown serialization (./mention).
import { describe, expect, test } from 'bun:test'
import {
  MENTION_EFFECTS,
  MENTION_NODE_SPEC,
  decodeIdentity,
  encodeIdentity,
  mentionMarkdown,
  mentionNodeMarkdown,
  parseMentions,
  serializeMentions,
} from './mention'
import type { ResourceIdentity } from './types'

const SAMPLES: ResourceIdentity[] = [
  { kind: 'file', workspaceId: 'theorem:v', path: 'notes/a b|c:d.md' },
  { kind: 'record', objectType: 'company', objectId: 'rec 1' },
  { kind: 'document', documentId: 'doc:1' },
  { kind: 'work-item', itemId: 'w1' },
  { kind: 'thread', threadId: 't1' },
  { kind: 'message', threadId: 't1', messageId: 'm1' },
  { kind: 'run', runId: 'r1' },
  { kind: 'extension', extensionKind: 'acme.ticket', id: '42' },
]

describe('mentions', () => {
  test('every identity round-trips through its token', () => {
    for (const resource of SAMPLES) {
      const decoded = decodeIdentity(encodeIdentity(resource))
      expect(decoded).toEqual({ known: true, resource })
    }
  })

  test('a mention in Markdown carries identity, with the label only a hint', () => {
    const md = `See ${mentionMarkdown(SAMPLES[1]!, 'Kiln [Co]')} now.`
    const [one] = parseMentions(md)
    expect(one!.label).toBe('Kiln [Co]')
    expect(one!.decoded).toEqual({ known: true, resource: SAMPLES[1]! })
    expect(serializeMentions(md)).toBe(md)
  })

  test('an unknown kind is kept verbatim on save, never dropped', () => {
    const md =
      'Look at [Widget](theorem-resource:hologram|a%2Fb|c) and [Doc](theorem-resource:document|d1).'
    const parsed = parseMentions(md)
    expect(parsed[0]!.decoded).toEqual({
      known: false,
      kind: 'hologram',
      token: 'hologram|a%2Fb|c',
    })
    expect(serializeMentions(md)).toBe(md)
  })

  test('a malformed token is kept as an unknown mention', () => {
    const md = '[Bad](theorem-resource:record|%E0%A4%A|x)'
    expect(parseMentions(md)[0]!.decoded.known).toBe(false)
    expect(serializeMentions(md)).toBe(md)
  })

  test('an unavailable resource is still a mention: identity does not depend on state', () => {
    const md = mentionMarkdown(
      { kind: 'extension', extensionKind: 'acme.ticket', id: '9' },
      'Gone ticket',
    )
    expect(serializeMentions(md)).toBe(md)
  })

  test('the node spec holds the token and writes the same link', () => {
    const token = encodeIdentity(SAMPLES[2]!)
    expect(MENTION_NODE_SPEC.atom).toBe(true)
    expect(
      MENTION_NODE_SPEC.toDOM({ attrs: { token, label: 'Doc' } })[1][
        'data-resource-mention'
      ],
    ).toBe(token)
    expect(mentionNodeMarkdown({ token, label: 'Doc' })).toBe(
      mentionMarkdown(SAMPLES[2]!, 'Doc'),
    )
  })

  test('inserting a mention changes content only', () => {
    expect(MENTION_EFFECTS).toEqual({
      changesContent: true,
      grantsAccess: false,
      notifies: false,
      startsAgent: false,
    })
  })
})
