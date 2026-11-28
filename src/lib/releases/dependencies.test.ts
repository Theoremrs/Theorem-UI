// SOURCING: bun:test over ./dependencies using the real AppDependencies
// resolver (src/lib/blocks/app-dependencies.ts) with a fake fetch.
import { describe, expect, test } from 'bun:test'
import { AppDependencies } from '@/lib/blocks/app-dependencies'
import {
  DependencyError,
  importedSpecifiers,
  resolveAppDependencies,
} from './dependencies'

const fetchOf = (table: Record<string, { status?: number; body?: string }>) =>
  (async (url: string) => {
    const hit = table[url]
    if (!hit) throw new Error('offline')
    const response = new Response(hit.body ?? '', {
      status: hit.status ?? 200,
      headers: { 'content-type': 'text/javascript' },
    })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }) as unknown as ConstructorParameters<typeof AppDependencies>[1]

describe('release dependencies', () => {
  test('imports are found, local files are not', () => {
    expect(
      importedSpecifiers({
        'main.tsx': `import a from 'lodash-es'\nimport b from './b'\nconst c = await import("https://esm.sh/x@1.0.0")`,
        'b.ts': `export * from 'zod'`,
        'data.json': '{}',
      }),
    ).toEqual(['https://esm.sh/x@1.0.0', 'lodash-es', 'zod'])
  })

  test('a remote module is pinned by exact URL and the digest of what it served', async () => {
    const url = 'https://esm.sh/x@1.0.0'
    const resolver = new AppDependencies(
      {},
      fetchOf({ [url]: { body: 'export default 1' } }),
    )
    const out = await resolveAppDependencies(
      { files: { 'main.ts': `import x from '${url}'` }, entry: 'main.ts' },
      resolver,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ specifier: url, kind: 'url', resolved: url })
    expect(out[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a dependency that cannot be fetched fails with its name, never recorded', async () => {
    const url = 'https://esm.sh/missing@1.0.0'
    const resolver = new AppDependencies(
      {},
      fetchOf({ [url]: { status: 404 } }),
    )
    try {
      await resolveAppDependencies(
        { files: { 'main.ts': `import x from '${url}'` }, entry: 'main.ts' },
        resolver,
      )
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyError)
      expect((error as DependencyError).diagnostics[0]!.message).toContain(
        'missing@1.0.0',
      )
    }
  })
})
