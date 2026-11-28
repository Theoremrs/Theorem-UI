// SOURCING: bun:test over the composer's registry-driven mentions (./composer-mentions resourceMention, mentionReference, MENTION_FORMATTER) and the mention encoding (lib/resources/mention): a pick keeps its identity through the directive, a kind with no context wire form adds no reference, and an unknown kind is never dropped from the text.
import { describe, expect, test } from 'bun:test'
import { decodeIdentity } from '@/lib/resources/mention'
import type { SearchHit } from '@/lib/resources/provider'
import {
  MENTION_FORMATTER,
  mentionReference,
  resourceMention,
} from './composer-mentions'

const hit = (
  resource: SearchHit['ref']['resource'],
  title: string,
): SearchHit => ({
  ref: { resource },
  title,
  typeLabel: 'Thing',
})

describe('composer mentions from the registry', () => {
  test('the directive carries the identity, whatever the label says', () => {
    const item = resourceMention(
      hit({ kind: 'work-item', itemId: 'w 1' }, 'Fix [the] kiln'),
    )
    const text = MENTION_FORMATTER.serialize(item)
    const segments = MENTION_FORMATTER.parse(text)
    const mention = segments.find((s) => s.kind === 'mention')
    expect(mention).toBeDefined()
    if (mention?.kind !== 'mention') return
    const decoded = decodeIdentity(mention.id)
    expect(decoded).toEqual({
      known: true,
      resource: { kind: 'work-item', itemId: 'w 1' },
    })
  })

  test('a kind the chat request has no form for adds no context reference', () => {
    expect(
      mentionReference(
        resourceMention(hit({ kind: 'work-item', itemId: 'w1' }, 'W')),
      ),
    ).toBeUndefined()
    expect(
      mentionReference(
        resourceMention(
          hit(
            { kind: 'extension', extensionKind: 'acme.ticket', id: '1' },
            'T',
          ),
        ),
      ),
    ).toBeUndefined()
  })

  test('kinds with a wire form add the reference the request already takes', () => {
    const run = mentionReference(
      resourceMention(hit({ kind: 'run', runId: 'r1' }, 'Run')),
    )
    expect(run?.location.resource).toEqual({ kind: 'run', runId: 'r1' })
    const record = mentionReference(
      resourceMention(
        hit(
          { kind: 'record', objectType: 'company', objectId: 'c1' },
          'Kiln Co',
        ),
      ),
    )
    expect(record?.location.resource).toEqual({
      kind: 'record',
      objectType: 'company',
      objectId: 'c1',
    })
  })

  test('an unrecognized token adds nothing but is still decodable as unknown', () => {
    const item = {
      ...resourceMention(hit({ kind: 'run', runId: 'r1' }, 'X')),
      metadata: {
        cite: 'resource',
        token: 'hologram|a',
        objectType: 'x',
        objectId: 'y',
        icon: 'record',
        kind: 'K',
      },
    }
    expect(mentionReference(item)).toBeUndefined()
    expect(decodeIdentity('hologram|a').known).toBe(false)
  })
})
