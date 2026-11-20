import { expect, test } from 'bun:test'
import {
  citationContextReference,
  citationReferenceKey,
  citationUrl,
  collectCitationSources,
} from './citations'

const part = (data: Record<string, unknown>) => ({
  type: 'data',
  name: 'theorem-citation',
  data,
})

test('later citations enrich one source and retain every distinct exact passage on reload', () => {
  const parts = [
    part({ sourceId: 'source|v1', label: 'Draft title' }),
    part({
      sourceId: 'source|v1',
      sourceKind: 'document',
      label: 'Research paper',
      provenance: {
        url: 'https://example.com/paper',
        excerpt: 'First exact passage.',
        page: 4,
        author: 'Ada',
      },
    }),
    part({
      sourceId: 'source|v1',
      provenance: {
        excerpt: 'First exact passage.',
        publishedAt: '2026-01-01',
      },
    }),
    part({
      sourceId: 'source|v1',
      provenance: { excerpt: 'Second\nexact passage.', page: 8 },
    }),
  ]
  const sources = collectCitationSources(parts)
  expect(sources).toHaveLength(1)
  expect(sources[0]).toMatchObject({
    key: 'id:source|v1',
    label: 'Research paper',
    sourceId: 'source|v1',
    sourceKind: 'document',
    url: 'https://example.com/paper',
    passages: [
      {
        excerpt: 'First exact passage.',
        provenance: { page: 4, author: 'Ada', publishedAt: '2026-01-01' },
      },
      { excerpt: 'Second\nexact passage.', provenance: { page: 8 } },
    ],
  })
  expect(collectCitationSources(JSON.parse(JSON.stringify(parts)))).toEqual(
    sources,
  )
  expect(collectCitationSources(parts.slice(0, 1))[0]?.key).toBe(
    sources[0]?.key,
  )
})

test('explicit identities sharing one URL remain separate; anonymous repeats can gain identity', () => {
  const url = 'https://example.com/source'
  const sources = collectCitationSources([
    part({ label: 'Shared page', provenance: { url } }),
    part({
      sourceId: 'first',
      label: 'First source',
      provenance: { url, excerpt: 'First.' },
    }),
    part({
      sourceId: 'second',
      label: 'Second source',
      provenance: { url, excerpt: 'Second.' },
    }),
  ])
  expect(sources).toHaveLength(2)
  expect(sources.map((source) => source.sourceId)).toEqual(['first', 'second'])
  expect(sources[0]?.key).toBe('url:https://example.com/source')
})

test('citation context uses only supported reference fields and preserves source provenance', () => {
  const [source] = collectCitationSources([
    part({
      sourceId: 'source|v1',
      sourceKind: 'document',
      label: 'Paper',
      provenance: {
        url: 'https://example.com/paper',
        excerpt: 'Exact evidence.',
        page: 4,
      },
    }),
    part({
      sourceId: 'source|v1',
      provenance: { excerpt: 'More exact evidence.', page: 5 },
    }),
  ])
  const reference = citationContextReference(source!, 'thread', 'message')
  expect(Object.keys(reference).sort()).toEqual([
    'excerpt',
    'label',
    'location',
  ])
  expect(reference.location).toEqual({
    resource: { kind: 'message', threadId: 'thread', messageId: 'message' },
  })
  expect(JSON.parse(reference.excerpt!)).toMatchObject({
    schema: 'theorem.citation-context.v1',
    citation: {
      sourceId: 'source|v1',
      sourceKind: 'document',
      label: 'Paper',
      url: 'https://example.com/paper',
      passages: [
        { excerpt: 'Exact evidence.', provenance: { page: 4 } },
        { excerpt: 'More exact evidence.', provenance: { page: 5 } },
      ],
    },
  })
  expect(citationReferenceKey(JSON.parse(JSON.stringify(reference)))).toBe(
    citationReferenceKey(reference),
  )
  expect(
    citationReferenceKey({
      ...reference,
      excerpt: 'Ordinary message context.',
    }),
  ).toBeUndefined()
})

test('source links accept supplied absolute web URLs without guessing or executable schemes', () => {
  expect(citationUrl('https://example.com/path')).toBe(
    'https://example.com/path',
  )
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,bad',
    'file:///etc/passwd',
    '//example.com',
    '/relative',
    'not a URL',
    'example.com',
    undefined,
  ]) {
    expect(citationUrl(url)).toBeUndefined()
  }
})

test('oversized multibyte evidence keeps source identity and explicitly points to exact passages in the message', () => {
  const excerpt = '🧬 "原文"\n'.repeat(2_000)
  const [source] = collectCitationSources([
    part({
      sourceId: 'large-source',
      label: 'Original research',
      provenance: {
        url: 'https://example.com/paper',
        excerpt,
        notes: '证据'.repeat(8_000),
      },
    }),
    part({
      sourceId: 'large-source',
      provenance: { excerpt: 'A second complete passage.' },
    }),
  ])
  const reference = citationContextReference(source!, 'thread', 'message')
  expect(
    new TextEncoder().encode(JSON.stringify(reference)).byteLength,
  ).toBeLessThanOrEqual(8192)
  expect(reference.location.resource).toEqual({
    kind: 'message',
    threadId: 'thread',
    messageId: 'message',
  })
  const citation = JSON.parse(reference.excerpt!).citation
  expect(citation).toMatchObject({
    key: 'id:large-source',
    sourceId: 'large-source',
    url: 'https://example.com/paper',
    omittedEvidence: { passages: 2, provenance: true },
  })
  expect(citation.omittedEvidence.reason).toContain(
    'exact passages in the referenced message',
  )
  expect(citation.passages).toBeUndefined()
  // Omitting evidence from a bounded context envelope does not change what
  // the reader can inspect or copy in the message.
  expect(source!.passages[0]!.excerpt).toBe(excerpt)
})

test('JSON escaping counts toward the entire reference limit and oversized identity is refused locally', () => {
  const [source] = collectCitationSources([
    part({ sourceId: 'quoted', provenance: { excerpt: '"'.repeat(4_000) } }),
  ])
  const reference = citationContextReference(source!, 'thread', 'message')
  expect(
    new TextEncoder().encode(JSON.stringify(reference)).byteLength,
  ).toBeLessThanOrEqual(8192)
  expect(JSON.parse(reference.excerpt!).citation.omittedEvidence).toBeDefined()
  const [unrepresentable] = collectCitationSources([
    part({ sourceId: 'x'.repeat(9_000), provenance: { excerpt: 'Evidence.' } }),
  ])
  expect(() =>
    citationContextReference(unrepresentable!, 'thread', 'message'),
  ).toThrow('too large to add')
})

test('anonymous source identity remains stable when its durable ID arrives later', () => {
  const first = part({
    label: 'Page',
    provenance: { url: 'https://example.com/paper', excerpt: 'Evidence.' },
  })
  const [before] = collectCitationSources([first])
  const [after] = collectCitationSources([
    first,
    part({
      sourceId: 'source-id',
      label: 'Page',
      provenance: { url: 'https://example.com/paper' },
    }),
  ])
  expect(
    citationReferenceKey(
      citationContextReference(before!, 'thread', 'message'),
    ),
  ).toBe(
    citationReferenceKey(citationContextReference(after!, 'thread', 'message')),
  )
})
