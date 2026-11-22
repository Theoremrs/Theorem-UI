// SOURCING: bun:test
import { describe, expect, test } from 'bun:test'
import { citationOf, SILENT_PARTS } from './parts'

describe('citations', () => {
  test('results a web search or page read retrieved draw nothing', () => {
    expect(citationOf({ sourceKind: 'web_search', provenance: { url: 'https://a.example/x' } })).toBeUndefined()
    expect(citationOf({ sourceKind: 'web_read', provenance: { url: 'https://a.example/x' } })).toBeUndefined()
  })

  test('any other source is a tag named by its label, else its host', () => {
    expect(citationOf({ label: 'Spec', provenance: { url: 'https://a.example/x' } })).toEqual({
      label: 'Spec',
      url: 'https://a.example/x',
    })
    expect(citationOf({ provenance: { url: 'https://docs.example/page' } })).toEqual({
      label: 'docs.example',
      url: 'https://docs.example/page',
    })
  })

  test('a destination that is not an absolute web URL is not linked', () => {
    expect(citationOf({ label: 'Notes', provenance: { url: 'tel:123' } })).toEqual({ label: 'Notes', url: undefined })
    expect(citationOf({ provenance: { url: 'not a url' } })).toEqual({ label: 'Source', url: undefined })
  })

  test('progress and usage parts are silent', () => {
    expect(SILENT_PARTS.has('theorem-progress')).toBe(true)
    expect(SILENT_PARTS.has('theorem-citation')).toBe(false)
  })
})
