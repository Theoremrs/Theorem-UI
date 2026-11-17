// SOURCING: bun:test over lib/theorem/project-context's pure helpers, against the bounds in Theorem's docs/plans/project-context/CONTRACT.md (http/https only, 2048-byte URLs, 200-byte titles counted in UTF-8 bytes), and TheoremError as passthrough throws it
import { describe, expect, test } from 'bun:test'
import { TheoremError } from '@theoremharness/sdk'
import {
  CONTEXT_LIMITS,
  contextUnavailable,
  documentHref,
  documentTitle,
  keptLink,
  linkLabel,
  linkProblem,
  repositoryUrl,
  sameReference,
} from './project-context'

const bytes = (text: string) => new TextEncoder().encode(text).length

describe('links', () => {
  test('an http or https address can be kept', () => {
    expect(linkProblem('https://example.com/spec', '')).toBeUndefined()
    expect(linkProblem('  http://example.com  ', 'Spec')).toBeUndefined()
  })

  test('anything else is refused with the reason', () => {
    expect(linkProblem('', '')).toBe('Enter an address.')
    expect(linkProblem('example.com', '')).toBe(
      'Enter a full address, starting with https://.',
    )
    expect(linkProblem('ftp://example.com/file', '')).toBe(
      'Only http and https addresses can be kept.',
    )
    expect(linkProblem('javascript:alert(1)', '')).toBe(
      'Only http and https addresses can be kept.',
    )
  })

  test('the bounds are counted in bytes, as Theorem counts them', () => {
    const long = `https://example.com/${'a'.repeat(CONTEXT_LIMITS.urlBytes)}`
    expect(linkProblem(long, '')).toBe('That address is too long.')
    // 67 three-byte characters are 201 bytes, though only 67 characters.
    expect(linkProblem('https://example.com', '語'.repeat(67))).toBe(
      'That title is too long.',
    )
    expect(linkProblem('https://example.com', '語'.repeat(66))).toBeUndefined()
  })

  test('a kept link is trimmed and has no empty title', () => {
    expect(keptLink(' https://example.com/a ', '  ')).toEqual({
      url: 'https://example.com/a',
    })
    expect(keptLink('https://example.com/a', ' Spec ')).toEqual({
      url: 'https://example.com/a',
      title: 'Spec',
    })
  })

  test('a link reads as its title, or its address without the scheme', () => {
    expect(linkLabel({ url: 'https://example.com/a', title: 'Spec' })).toBe(
      'Spec',
    )
    expect(linkLabel({ url: 'https://example.com/' })).toBe('example.com')
    expect(linkLabel({ url: 'https://example.com/notes/a?b=1' })).toBe(
      'example.com/notes/a?b=1',
    )
  })
})

describe('documents', () => {
  test('a title is trimmed and kept within 200 bytes', () => {
    expect(documentTitle('  Design notes ')).toBe('Design notes')
    expect(documentTitle('   ')).toBe('Untitled')
    const cut = documentTitle('語'.repeat(100))
    expect(bytes(cut)).toBeLessThanOrEqual(CONTEXT_LIMITS.titleBytes)
    expect(cut.endsWith('…')).toBe(true)
  })

  test('a document opens where its kind has a page', () => {
    expect(documentHref({ kind: 'graph_document', id: 'note:a b' })).toBe(
      '/notes/note%3Aa%20b',
    )
    expect(documentHref({ kind: 'upload', id: 'upload-1' })).toBe(
      '/api/chat/v1/uploads/upload-1/content',
    )
    expect(documentHref({ kind: 'record_view', id: 'view-1' })).toBeUndefined()
    expect(documentHref({ kind: 'record', id: 'record-1' })).toBeUndefined()
  })

  test('a reference is the same only with the same kind and id', () => {
    expect(
      sameReference({ kind: 'upload', id: 'a' }, { kind: 'upload', id: 'a' }),
    ).toBe(true)
    expect(
      sameReference({ kind: 'upload', id: 'a' }, { kind: 'record', id: 'a' }),
    ).toBe(false)
  })
})

test('a repository opens on GitHub', () => {
  expect(repositoryUrl('owner/name')).toBe('https://github.com/owner/name')
})

describe('why context could not be read', () => {
  const refusal = (statusCode: number, body?: unknown) =>
    new TheoremError({ message: 'refused', statusCode, body })

  test('a bare 404 or a 405 is a Theorem without the routes', () => {
    expect(contextUnavailable(refusal(404))).toBe('not-served')
    expect(contextUnavailable(refusal(405))).toBe('not-served')
  })

  test("Theorem's own not-found is a project it does not have", () => {
    expect(
      contextUnavailable(refusal(404, { code: 'chat_resource_not_found' })),
    ).toBe('no-project')
  })

  test('anything else is a failure to show and retry', () => {
    expect(contextUnavailable(refusal(503))).toBeUndefined()
    expect(contextUnavailable(new Error('offline'))).toBeUndefined()
  })
})
