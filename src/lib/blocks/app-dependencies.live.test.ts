// Opt-in network integration, separate from deterministic unit tests:
// THEOREM_TEST_REMOTE_DEPS=1 bun test src/lib/blocks/app-dependencies.live.test.ts
import { expect, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { tsc } from '@tsrs/wasm'
import { checkLibraryFromDisk } from '../../../test/blocks/check-library'
import { dependencyDeclarations } from './app-dependency-types'
import { checkAppSources } from './app-check'
import { bundleAppSources } from './export'

test.skipIf(process.env.THEOREM_TEST_REMOTE_DEPS !== '1')(
  'a custom TSX component imports pinned LumaGL through real CDN resolution and compiles',
  async () => {
    const sources = { entry: 'main.tsx', files: {
      'package.json': JSON.stringify({ dependencies: { '@luma.gl/core': '9.2.3' } }),
      'main.tsx': 'import { createRoot } from "react-dom/client"; import { ParticleWorkbench } from "./ParticleWorkbench.tsx"; createRoot(document.getElementById("root")!).render(<ParticleWorkbench count={2000} />)',
      'ParticleWorkbench.tsx': 'import * as Luma from "@luma.gl/core"; export function ParticleWorkbench({count}: {count: number}) { return <section><canvas data-particles={count}/><output>{Object.keys(Luma).length}</output></section> }',
    } }
    const bundle = await bundleAppSources(sources, esbuild)
    expect(bundle.code).toContain('ParticleWorkbench')
    expect(bundle.code).toContain('9.2.3')
    expect(bundle.code).not.toContain('from "@luma.gl/core"')
    const declarations = await dependencyDeclarations(sources)
    expect(declarations.problems).toEqual([])
    const result = await checkAppSources(sources, tsc, checkLibraryFromDisk(), {}, declarations)
    expect(result.problems).toEqual([])
  },
  180_000,
)
