// From a Theorem output to a cabinet card: each identity keeps its own way
// of opening, and a picture says what it leaves out.
import { describe, expect, test } from 'bun:test'
import type { ProjectOutput } from '@/lib/theorem/organization'
import { previewNote } from './previews'
import { plainText, toEntry } from './catalog'

const output = (o: Partial<ProjectOutput>): ProjectOutput => ({
  outputId: 'x',
  kind: 'artifact',
  title: 'X',
  threadId: 't',
  revisionCount: 1,
  updatedAtMs: 1,
  ...o,
})

describe('catalog entries', () => {
  test('a review keeps its review identity, not a made-up artifact', () => {
    const entry = toEntry(
      'p',
      output({
        outputId: 'review:r1',
        kind: 'review',
        reviewId: 'r1',
        category: 'review',
      }),
    )
    expect(entry.source).toEqual({
      type: 'review',
      reviewId: 'r1',
      revision: '1',
    })
  })

  test('uploads and artifacts keep theirs', () => {
    expect(
      toEntry('p', output({ uploadId: 'u1', revision: 'sha' })).source,
    ).toEqual({
      type: 'upload',
      uploadId: 'u1',
      revision: 'sha',
    })
    expect(
      toEntry('p', output({ artifactId: 'a1', revision: 3 })).source,
    ).toEqual({
      type: 'artifact',
      artifactId: 'a1',
      revision: '3',
    })
  })
})

describe('preview notes', () => {
  const ready = (
    method: string,
    limitation: { code: string; detail: string } | null,
  ) =>
    ({
      status: 'ready',
      mode: 'pixel',
      indices: new Uint8Array(),
      meta: { method, limitation },
    }) as never

  test('a generic illustration and a partial picture say so', () => {
    expect(previewNote(ready('type_illustration', null))).toContain(
      'type illustration',
    )
    expect(
      previewNote(
        ready('structured_recipe', {
          code: 'partial',
          detail: 'Shows 8 of 9 categories',
        }),
      ),
    ).toContain('Shows 8 of 9 categories')
  })

  test('a straight reduction of the source needs no note', () => {
    expect(previewNote(ready('source_raster', null))).toBeUndefined()
    expect(previewNote({ status: 'loading' })).toBeUndefined()
  })

  test('a failed preview names why and does not claim the original is gone', () => {
    const note = previewNote({
      status: 'unavailable',
      detail: 'the content could not be read',
    })
    expect(note).toContain('the content could not be read')
    expect(note).toContain('original can still be opened')
  })
})

describe('card descriptions', () => {
  test('Markdown markers are dropped and the words kept', () => {
    expect(
      plainText(
        '# Field notes: Headland\n\n- **Tide** at `06:10`\n> calm\n\n| Site | Depth |\n| --- | --- |\n| North | 4 m |\n\nSee [the map](x.png).',
      ),
    ).toBe(
      'Field notes: Headland Tide at 06:10 calm Site · Depth North · 4 m See the map.',
    )
  })

  test('prose passes through unchanged', () => {
    expect(plainText('A survey of the headland at dusk.')).toBe(
      'A survey of the headland at dusk.',
    )
  })
})
