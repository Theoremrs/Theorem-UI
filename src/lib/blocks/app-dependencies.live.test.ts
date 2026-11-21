// Opt-in real CDN integration, separate from deterministic unit tests:
// THEOREM_TEST_REMOTE_DEPS=1 bun test src/lib/blocks/app-dependencies.live.test.ts
// Actual sandboxed GPU rendering is checked by scripts/e2e/app-luma.mjs.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as esbuild from 'esbuild-wasm'
import { tsc } from '@tsrs/wasm'
import { checkLibraryFromDisk } from '../../../test/blocks/check-library'
import { appDependencies } from './app-dependencies'
import { dependencyDeclarations } from './app-dependency-types'
import { checkAppSources } from './app-check'
import { appSourcesOf } from './app-source'
import { bundleAppSources } from './export'

test.skipIf(process.env.THEOREM_TEST_REMOTE_DEPS !== '1')(
  'pinned Luma core, WebGL adapter and Model share a typed CDN dependency graph',
  async () => {
    const html = readFileSync(
      new URL('../../../test/fixtures/app-luma.html', import.meta.url),
      'utf8',
    )
    const sources = appSourcesOf(html)!
    expect(sources).not.toBeNull()
    const resolver = appDependencies(sources)
    let modules: Array<string> = []
    const build: typeof esbuild.build = async (options) => {
      options.metafile = true
      const result = await esbuild.build(options)
      modules = Object.keys(result.metafile?.inputs ?? {})
      return result
    }
    const bundle = await bundleAppSources(sources, { build }, resolver)
    // Read the actual esbuild module graph: the product source map keeps only
    // authored App files. Several CDN wrappers must share one implementation.
    const coreModules = modules.filter((path) =>
      /\/@luma\.gl\/core@9\.4\.2\/(?:X-[^/]+\/)?es2022\/core\.mjs(?:[?#].*)?$/.test(
        path,
      ),
    )
    expect(coreModules).toHaveLength(1)
    expect(bundle.code).toContain('artifact-luma-smoke')
    const declarations = await dependencyDeclarations(sources, resolver)
    expect(declarations.problems).toEqual([])
    const result = await checkAppSources(
      sources,
      tsc,
      checkLibraryFromDisk(),
      {},
      declarations,
    )
    // Device crosses core -> webgl adapter -> engine Model; RenderPass also
    // crosses the package boundary. Private-class incompatibilities must fail.
    expect(result.problems).toEqual([])
  },
  180_000,
)
