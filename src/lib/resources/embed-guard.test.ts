// SOURCING: bun:test over the nested-embed guard (./embed-guard).
import { describe, expect, test } from 'bun:test'
import { enterEmbed, rootEmbedPath } from './embed-guard'

describe('embed guard', () => {
  test('refuses an embed that contains itself', () => {
    const root = rootEmbedPath()
    const a = enterEmbed(root, 'document:a')
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(enterEmbed(a.path, 'document:a')).toEqual({
      ok: false,
      reason: 'cycle',
    })
    expect(enterEmbed(a.path, 'document:b').ok).toBe(true)
  })

  test('stops at the depth limit', () => {
    let path = rootEmbedPath({ maxDepth: 2 })
    for (const key of ['a', 'b']) {
      const entered = enterEmbed(path, key)
      expect(entered.ok).toBe(true)
      if (entered.ok) path = entered.path
    }
    expect(enterEmbed(path, 'c')).toEqual({ ok: false, reason: 'depth' })
  })

  test('shares one budget across siblings', () => {
    const root = rootEmbedPath({ maxCount: 2 })
    expect(enterEmbed(root, 'a').ok).toBe(true)
    expect(enterEmbed(root, 'b').ok).toBe(true)
    expect(enterEmbed(root, 'c')).toEqual({ ok: false, reason: 'budget' })
  })
})
