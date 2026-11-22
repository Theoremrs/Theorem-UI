// SOURCING: none — a test harness. A vault module's files in test/blocks/memory-workspace, placed as
// a page places one (useInstance under a PageRuntimeProvider, test/workspace's render with a
// QueryClient) and run through VaultModule, with slice2-harness's stand-in for
// /api/capabilities/v1 and the frame's document built with esbuild's Node build. happy-dom loads
// no frame page, so frameOf says ready for the frame as its bridge script does and hands back the
// frame's end of the port the page answers with: calls on it reach the host the module runs with.
import { spyOn } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { act } from 'react'
import { memoryWorkspace } from '../../../test/blocks/memory-workspace'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { install, uninstall } from '@/components/capabilities/slice2-harness'
import { useComposerReferences } from '@/components/chat/composer-references'
import * as hosted from '@/lib/blocks/hosted-app'
import { READY_MESSAGE, rpcOver } from '@/lib/blocks/sandbox/protocol'
import type { Rpc } from '@/lib/blocks/sandbox/protocol'
import { parseManifest } from '@/lib/modules/contract'
import { useModuleGrants } from '@/lib/modules/grants'
import { fromManifest } from '@/lib/modules/registry'
import type { ModuleDefinition } from '@/lib/modules/registry'
import type { WorkspaceClient } from '@/lib/workspace/types'
import {
  InstanceProvider,
  PageRuntimeProvider,
  useInstance,
} from './page-runtime'
import { VaultModule } from './sandboxed-module'

export const FOLDER = 'Modules/focus'

function Placed({
  client,
  definition,
}: {
  client: WorkspaceClient
  definition: ModuleDefinition
}) {
  const view = useInstance(definition, { id: 'focus-1' }, false)
  return (
    <InstanceProvider path={view.path}>
      <VaultModule
        client={client}
        definition={definition}
        folder={FOLDER}
        entry="index.html"
        view={view}
      />
    </InstanceProvider>
  )
}

/** Installs `module.json` and `index.html` in a vault's `Modules/focus` and places the module. */
export async function placeModule(manifestText: string, source: string) {
  const definition = fromManifest(
    parseManifest(`${FOLDER}/module.json`, manifestText),
    `${FOLDER}/module.json`,
  )
  const client = memoryWorkspace({
    [`${FOLDER}/module.json`]: manifestText,
    [`${FOLDER}/index.html`]: source,
  }) as unknown as WorkspaceClient
  const placed = await render(
    <PageRuntimeProvider>
      <Placed client={client} definition={definition} />
    </PageRuntimeProvider>,
  )
  return { ...placed, definition }
}

/**
 * Says ready from the module's frame and returns the frame's end of the port
 * the page answers with.
 */
export async function frameOf(container: HTMLElement): Promise<Rpc> {
  const iframe = await waitFor(() => container.querySelector('iframe'), {
    timeout: 10_000,
  })
  // The frame's window is a stand-in that keeps the port the page sends it.
  let port: MessagePort | undefined
  const target = {
    postMessage: (
      _message: unknown,
      _origin: string,
      transfer?: Transferable[],
    ) => {
      port = transfer?.[0] as MessagePort
    },
  }
  Object.defineProperty(iframe, 'contentWindow', { value: target })
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: target as unknown as Window,
        data: { type: READY_MESSAGE },
      }),
    )
  })
  await waitFor(() => port)
  return rpcOver(port!)
}

const originalHosted = hosted.hostedAppDocument
let building: { mockRestore: () => void } | undefined

export function beginModuleTest() {
  building = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html, _esbuild, options) => originalHosted(html, esbuild, options),
  )
  install()
  useModuleGrants.setState({ grants: {} })
  useComposerReferences.setState({ references: [] })
}

export function endModuleTest() {
  cleanup()
  uninstall()
  building?.mockRestore()
}
