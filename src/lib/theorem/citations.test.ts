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

test('explicit IDs sharing a URL do not absorb a preceding anonymous record', () => {
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
  expect(sources).toHaveLength(3)
  expect(sources.map((source) => source.sourceId)).toEqual([
    undefined,
    'first',
    'second',
  ])
  expect(sources[0]?.key).toBe('url:https://example.com/source')
})

test('URL-only evidence merges with one matching source but stays independent when explicit IDs share the URL', () => {
  const url = 'https://example.com/shared?edition=1#evidence'
  const identified = [
    part({
      sourceId: 'first-document',
      label: 'First document',
      provenance: { url, excerpt: 'First identified evidence.' },
    }),
    part({
      sourceId: 'second-document',
      label: 'Second document',
      provenance: { url, excerpt: 'Second identified evidence.' },
    }),
  ]
  const anonymous = part({
    label: 'Unattributed document',
    provenance: { url, excerpt: 'Unattributed evidence.' },
  })
  const unambiguous = collectCitationSources([identified[0]!, anonymous])
  expect(unambiguous).toHaveLength(1)
  expect(unambiguous[0]).toMatchObject({
    sourceId: 'first-document',
    passages: [
      { excerpt: 'First identified evidence.' },
      { excerpt: 'Unattributed evidence.' },
    ],
  })
  for (const order of [identified, [...identified].reverse()]) {
    const initial = [...order, anonymous]
    const anonymousKey = collectCitationSources(initial)[2]!.key
    const parts = [
      ...initial,
      part({
        label: 'Unattributed document',
        provenance: { url, excerpt: 'More unattributed evidence.' },
      }),
    ]
    const sources = collectCitationSources(parts)
    expect(sources).toHaveLength(3)
    expect(sources[2]!.key).toBe(anonymousKey)
    expect(sources.slice(0, 2).map((source) => source.passages.length)).toEqual(
      [1, 1],
    )
    expect(sources[2]).toMatchObject({
      url,
      passages: [
        { excerpt: 'Unattributed evidence.' },
        { excerpt: 'More unattributed evidence.' },
      ],
    })
    expect(sources[2]!.sourceId).toBeUndefined()
    const references = sources.map((source) =>
      citationContextReference(source, 'thread', 'message'),
    )
    expect(new Set(references.map(citationReferenceKey)).size).toBe(3)
    expect(
      JSON.parse(references[2]!.excerpt!).citation.sourceId,
    ).toBeUndefined()
    expect(collectCitationSources(JSON.parse(JSON.stringify(parts)))).toEqual(
      sources,
    )
  }
})

test('an ambiguous anonymous group cannot acquire a new third ID', () => {
  const url = 'https://example.com/shared?edition=1#evidence'
  const initial = [
    part({
      sourceId: 'first',
      provenance: { url, excerpt: 'First identified evidence.' },
    }),
    part({
      sourceId: 'second',
      provenance: { url, excerpt: 'Second identified evidence.' },
    }),
    part({ provenance: { url, excerpt: 'Unattributed evidence.' } }),
    part({ provenance: { url, excerpt: 'More unattributed evidence.' } }),
  ]
  const anonymousKey = collectCitationSources(initial)[2]!.key
  const parts = [
    ...initial,
    part({
      sourceId: 'third',
      provenance: { url, excerpt: 'Third identified evidence.' },
    }),
  ]
  const sources = collectCitationSources(parts)
  expect(sources).toHaveLength(4)
  expect(sources.map((source) => source.sourceId)).toEqual([
    'first',
    'second',
    undefined,
    'third',
  ])
  expect(sources[2]).toMatchObject({
    key: anonymousKey,
    passages: [
      { excerpt: 'Unattributed evidence.' },
      { excerpt: 'More unattributed evidence.' },
    ],
  })
  expect(sources[3]!.passages.map((passage) => passage.excerpt)).toEqual([
    'Third identified evidence.',
  ])
  const references = sources.map((source) =>
    citationContextReference(source, 'thread', 'message'),
  )
  expect(new Set(references.map(citationReferenceKey)).size).toBe(4)
  expect(JSON.parse(references[2]!.excerpt!).citation.sourceId).toBeUndefined()
  expect(collectCitationSources(JSON.parse(JSON.stringify(parts)))).toEqual(
    sources,
  )
})

for (const anonymousFirst of [false, true]) {
  test(`URL ambiguity appears later with anonymous evidence ${anonymousFirst ? 'before' : 'after'} the first ID`, () => {
    const url = 'https://example.com/shared?edition=1#evidence'
    const explicit = part({
      sourceId: 'first',
      provenance: { url, excerpt: 'First identified evidence.' },
    })
    const anonymous = part({
      provenance: { url, excerpt: 'Unattributed evidence.' },
    })
    const initial = anonymousFirst
      ? [anonymous, explicit]
      : [explicit, anonymous]
    const before = collectCitationSources(initial)
    expect(before).toHaveLength(1)
    expect(before[0]!.sourceId).toBe('first')
    expect(before[0]!.key).toBe(anonymousFirst ? `url:${url}` : 'id:first')
    const parts = [
      ...initial,
      part({
        sourceId: 'second',
        provenance: { url, excerpt: 'Second identified evidence.' },
      }),
      part({ provenance: { url, excerpt: 'More unattributed evidence.' } }),
    ]
    const sources = collectCitationSources(parts)
    expect(sources).toHaveLength(3)
    const first = sources.find((source) => source.sourceId === 'first')!
    const unattributed = sources.find((source) => !source.sourceId)!
    expect(first.key).toBe('id:first')
    expect(first.passages.map((passage) => passage.excerpt)).toEqual([
      'First identified evidence.',
    ])
    expect(unattributed).toMatchObject({
      key: `url:${url}`,
      url,
      passages: [
        { excerpt: 'Unattributed evidence.' },
        { excerpt: 'More unattributed evidence.' },
      ],
    })
    const references = sources.map((source) =>
      citationContextReference(source, 'thread', 'message'),
    )
    expect(new Set(references.map(citationReferenceKey)).size).toBe(3)
    expect(
      JSON.parse(
        citationContextReference(unattributed, 'thread', 'message').excerpt!,
      ).citation.sourceId,
    ).toBeUndefined()
    expect(collectCitationSources(JSON.parse(JSON.stringify(parts)))).toEqual(
      sources,
    )
  })
}

test('a reused URL cannot claim the key of an enriched source that moved', () => {
  const originalUrl = 'https://example.com/original'
  const updatedUrl = 'https://example.com/updated'
  const parts = [
    part({
      label: 'Original source',
      provenance: { url: originalUrl, excerpt: 'Initial evidence.' },
    }),
    part({
      sourceId: 'moving-source',
      provenance: { url: originalUrl },
    }),
    part({
      sourceId: 'moving-source',
      provenance: { url: updatedUrl, excerpt: 'Updated evidence.' },
    }),
    part({
      label: 'New source at the original URL',
      provenance: { url: originalUrl, excerpt: 'Independent evidence.' },
    }),
  ]
  const originalKey = collectCitationSources(parts.slice(0, 1))[0]!.key
  const sources = collectCitationSources(parts)
  expect(sources).toHaveLength(2)
  expect(sources[0]!.key).toBe(originalKey)
  expect(collectCitationSources(parts.slice(0, 3))[0]!.key).toBe(originalKey)
  expect(new Set(sources.map((source) => source.key)).size).toBe(2)
  expect(sources).toMatchObject([
    {
      sourceId: 'moving-source',
      url: updatedUrl,
      passages: [
        { excerpt: 'Initial evidence.' },
        { excerpt: 'Updated evidence.' },
      ],
    },
    {
      url: originalUrl,
      passages: [{ excerpt: 'Independent evidence.' }],
    },
  ])
  const keys = sources.map((source) =>
    citationReferenceKey(citationContextReference(source, 'thread', 'message')),
  )
  expect(new Set(keys).size).toBe(2)
  const reloaded = collectCitationSources(JSON.parse(JSON.stringify(parts)))
  expect(reloaded).toEqual(sources)
  expect(
    reloaded.map((source) =>
      citationReferenceKey(
        citationContextReference(source, 'thread', 'message'),
      ),
    ),
  ).toEqual(keys)
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

test('anonymous sources have distinct context identities that survive non-citation updates and reload', () => {
  const first = part({ provenance: { excerpt: 'First anonymous passage.' } })
  const second = part({ provenance: { excerpt: 'Second anonymous passage.' } })
  const sources = collectCitationSources([first, second])
  expect(sources).toHaveLength(2)
  expect(new Set(sources.map((source) => source.key)).size).toBe(2)
  const keys = sources.map((source) =>
    citationReferenceKey(citationContextReference(source, 'thread', 'message')),
  )
  expect(new Set(keys).size).toBe(2)
  const reloaded = collectCitationSources(
    JSON.parse(
      JSON.stringify([
        { type: 'text', text: 'A growing answer.' },
        first,
        { type: 'data', name: 'theorem-activity', data: {} },
        second,
        part({ provenance: { excerpt: 'Third anonymous passage.' } }),
      ]),
    ),
  )
  expect(reloaded.slice(0, 2).map((source) => source.key)).toEqual(
    sources.map((source) => source.key),
  )
  expect(new Set(reloaded.map((source) => source.key)).size).toBe(3)
})

test('a shared label does not identify a fallback as a later URL-bearing source', () => {
  const sources = collectCitationSources([
    part({
      label: 'Research notes',
      provenance: { excerpt: 'Unlinked evidence.' },
    }),
    part({
      sourceId: 'durable-paper',
      label: 'Research notes',
      provenance: {
        url: 'https://example.com/paper',
        excerpt: 'Linked evidence.',
      },
    }),
  ])
  expect(sources).toHaveLength(2)
  expect(sources[0]).toMatchObject({
    key: 'part:0',
    passages: [{ excerpt: 'Unlinked evidence.' }],
  })
  expect(sources[0]?.url).toBeUndefined()
  expect(sources[1]).toMatchObject({
    key: 'id:durable-paper',
    url: 'https://example.com/paper',
    passages: [{ excerpt: 'Linked evidence.' }],
  })
})

test('same-label sources without IDs or URLs stay distinct from each other and a later durable source', () => {
  const parts = [
    part({
      label: 'Research notes',
      provenance: { excerpt: 'First document.' },
    }),
    part({
      label: 'Research notes',
      provenance: { excerpt: 'Second document.' },
    }),
    part({
      sourceId: 'third-document',
      label: 'Research notes',
      provenance: { excerpt: 'Third document.' },
    }),
  ]
  const sources = collectCitationSources(parts)
  expect(sources).toHaveLength(3)
  expect(new Set(sources.map((source) => source.key)).size).toBe(3)
  expect(
    sources.map((source) => source.passages.map((passage) => passage.excerpt)),
  ).toEqual([['First document.'], ['Second document.'], ['Third document.']])
  expect(
    new Set(
      sources.map((source) =>
        citationReferenceKey(
          citationContextReference(source, 'thread', 'message'),
        ),
      ),
    ).size,
  ).toBe(3)
  expect(collectCitationSources(JSON.parse(JSON.stringify(parts)))).toEqual(
    sources,
  )
})
