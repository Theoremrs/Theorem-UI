import { describe, expect, it } from 'bun:test'
import { UI_CONTRIBUTIONS } from '@/components/artifacts/artifact-registry'
import {
  byRecent,
  effectivePreviewMode,
  factualDescription,
  geometryId,
  inertRepresentation,
  mayPublish,
  presentationId,
} from './contract'
import type { CatalogEntry, GeometryKey, PublishGuard } from './contract'

const mountedAll = () => ({ mounted: true }) as const
const missing = (gone: string) => (r: string) =>
  r === gone
    ? ({ mounted: false, reason: 'gone' } as const)
    : ({ mounted: true } as const)

describe('style override (A09, A10)', () => {
  it('lets an explicit preference win and otherwise follows the preset', () => {
    expect(effectivePreviewMode('expressive', undefined)).toBe('pixel')
    expect(effectivePreviewMode('calm', undefined)).toBe('full_fidelity')
    expect(effectivePreviewMode('expressive', 'full_fidelity')).toBe(
      'full_fidelity',
    )
    expect(effectivePreviewMode('calm', 'pixel')).toBe('pixel')
  })
})

describe('inert-preview eligibility (A07)', () => {
  it('never resolves a live app presentation, even with the preview renderer missing', () => {
    for (const distance of ['preview', 'landmark'] as const) {
      for (const available of [mountedAll, missing('theorem-app.preview')]) {
        const r = inertRepresentation(
          { kind: 'app', mediaType: 'text/html' },
          distance,
          UI_CONTRIBUTIONS,
          available,
        )
        expect(r.session).toBe('none')
        expect(r.renderer).not.toBe('theorem-app')
        expect(r.renderer).not.toBe('theorem-app.preview')
      }
    }
  })

  it('still resolves an inert document card', () => {
    const r = inertRepresentation(
      { kind: 'document' },
      'preview',
      UI_CONTRIBUTIONS,
      mountedAll,
    )
    expect(r.renderer).toBe('theorem-document.reply')
  })
})

describe('source identity (A03, A22)', () => {
  const g: GeometryKey = {
    sourceDigest: 'sha256:aa',
    revision: 'r1',
    recipe: 'document',
    recipeVersion: 1,
    rendererVersion: 1,
    profile: 'artboard-128x84',
  }

  it('keeps geometry across palettes and moves presentation only for pixel art', () => {
    expect(presentationId(g, 'pixel', 'p1')).not.toBe(
      presentationId(g, 'pixel', 'p2'),
    )
    expect(presentationId(g, 'full_fidelity', 'p1')).toBe(
      presentationId(g, 'full_fidelity', 'p2'),
    )
    expect(geometryId(g)).toBe(geometryId({ ...g }))
  })

  it('invalidates geometry on revision, digest, recipe version or profile', () => {
    for (const change of [
      { revision: 'r2' },
      { sourceDigest: 'sha256:bb' },
      { recipeVersion: 2 },
      { profile: 'x' },
    ])
      expect(geometryId({ ...g, ...change })).not.toBe(geometryId(g))
  })

  it('orders by accepted time with a stable identity tie-break', () => {
    const e = (key: string, t: number) =>
      ({ key, updatedAtMs: t }) as CatalogEntry
    expect(
      [e('b', 1), e('a', 1), e('c', 2)].sort(byRecent).map((x) => x.key),
    ).toEqual(['c', 'a', 'b'])
  })

  it('describes unknown content factually', () => {
    expect(factualDescription('document', 'application/pdf')).toBe(
      'PDF document; preview unavailable.',
    )
  })
})

describe('stale async results (A23)', () => {
  const now: PublishGuard = {
    scope: 'p1',
    revision: 'r2',
    generation: 3,
    mode: 'pixel',
    paletteDigest: 'd1',
  }
  it('publishes only a result that still matches', () => {
    expect(mayPublish(now, now)).toBe(true)
    for (const change of [
      { scope: 'p2' },
      { revision: 'r1' },
      { generation: 2 },
      { mode: 'full_fidelity' as const },
      { paletteDigest: 'd0' },
    ])
      expect(mayPublish({ ...now, ...change }, now)).toBe(false)
    const ff = { ...now, mode: 'full_fidelity' as const }
    expect(mayPublish({ ...ff, paletteDigest: 'other' }, ff)).toBe(true)
  })
})
