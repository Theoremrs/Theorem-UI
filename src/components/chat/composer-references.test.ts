import { expect, test } from 'bun:test'
import { useComposerReferences } from './composer-references'

test('selecting a newer revision of the same App replaces stale composer context', () => {
  useComposerReferences.setState({ references: [] })
  const location = {
    resource: {
      kind: 'graph-object' as const,
      objectId: 'app-one',
      objectType: 'theorem.app',
    },
  }
  useComposerReferences
    .getState()
    .add({ location: { ...location, revision: 1 }, excerpt: 'old row' })
  useComposerReferences
    .getState()
    .add({ location: { ...location, revision: 2 }, excerpt: 'selected row' })
  const references = useComposerReferences.getState().take()
  expect(references).toHaveLength(1)
  expect(references[0]).toMatchObject({
    location: { revision: 2 },
    excerpt: 'selected row',
  })
  expect(useComposerReferences.getState().references).toHaveLength(0)
})

test('different cited sources from one message coexist and repeated additions update one source', async () => {
  const { citationContextReference, collectCitationSources } =
    await import('@/lib/theorem/citations')
  const part = (sourceId: string, excerpt: string) => ({
    type: 'data',
    name: 'theorem-citation',
    data: {
      sourceId,
      label: sourceId,
      provenance: { url: 'https://example.com/shared', excerpt },
    },
  })
  useComposerReferences.setState({ references: [] })
  const initial = collectCitationSources([
    part('source|one', 'First evidence.'),
    part('source|two', 'Other evidence.'),
  ])
  for (const source of initial) {
    useComposerReferences
      .getState()
      .add(citationContextReference(source, 'thread', 'message'))
  }
  const [updated] = collectCitationSources([
    part('source|one', 'First evidence.'),
    part('source|one', 'Later evidence.'),
  ])
  const update = citationContextReference(updated!, 'thread', 'message')
  useComposerReferences.getState().add(update)
  useComposerReferences.getState().add(update)
  const references = useComposerReferences.getState().take()
  expect(references).toHaveLength(2)
  const citations = references.map(
    (reference) => JSON.parse(reference.excerpt!).citation,
  )
  expect(citations.map((citation) => citation.sourceId)).toEqual([
    'source|one',
    'source|two',
  ])
  expect(
    citations
      .find((citation) => citation.sourceId === 'source|one')
      .passages.map((passage: { excerpt: string }) => passage.excerpt),
  ).toEqual(['First evidence.', 'Later evidence.'])
  expect(useComposerReferences.getState().references).toHaveLength(0)
})
