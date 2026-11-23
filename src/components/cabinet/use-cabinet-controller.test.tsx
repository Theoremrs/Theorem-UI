import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useShell } from '@/components/shell/shell-state'
import { bootstrap } from '@/lib/theorem/client'
import type { ProjectOutput } from '@/lib/theorem/organization'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { useCabinetController } from './use-cabinet-controller'
import type { CabinetSurface } from './use-cabinet-controller'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000'))
afterAll(() => page.setURL('about:blank'))
let restore = () => {}
afterEach(async () => {
  await cleanup()
  restore()
  useShell.setState({ sideDrawer: undefined, galleryArtifact: undefined })
})

const output = (n: number): ProjectOutput => ({
  outputId: `output-${n}`,
  artifactId: `artifact-${n}`,
  kind: 'artifact',
  category: 'document',
  title: `Object ${n}`,
  threadId: 't',
  revisionCount: 1,
  updatedAtMs: 100 - n,
})

/** Two pages of outputs, the second only behind the first's cursor. */
async function mount() {
  const cursors: Array<string | null> = []
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({ csrfToken: 'csrf', tenantId: 't' }),
    'GET /api/chat/v1/projects/p/outputs': (_, request) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      return cursor === 'next'
        ? { items: [output(3)], total: 3 }
        : { items: [output(1), output(2)], total: 3, nextCursor: 'next' }
    },
  })
  await bootstrap(true)
  const selected: string[] = []
  const surface: CabinetSurface = {
    set_view: () => {},
    key: () => false,
    select: (key) => selected.push(key),
    scroll: () => {},
  }
  function Probe() {
    useCabinetController({
      projectId: 'p',
      projectTitle: 'P',
      expanded: false,
      surface,
      geometry: undefined,
    })
    return null
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  await waitFor(() => cursors.length > 0)
  return { cursors, selected }
}

test('a card in the conversation opens the Gallery with its artifact selected, paging until it is loaded', async () => {
  const { cursors, selected } = await mount()
  await act(async () => useShell.getState().openInGallery('artifact-3'))
  expect(useShell.getState().sideDrawer).toBe('outputs')
  await waitFor(() => selected.length > 0)
  expect(selected).toEqual(['output-3'])
  expect(cursors).toContain('next')
  // Answered: a later page or render does not select it again.
  expect(useShell.getState().galleryArtifact).toBeUndefined()
})

test('an artifact the project does not hold leaves the Gallery open with nothing selected', async () => {
  const { cursors, selected } = await mount()
  await act(async () => useShell.getState().openInGallery('elsewhere'))
  await waitFor(() => useShell.getState().galleryArtifact === undefined)
  expect(cursors).toContain('next')
  expect(selected).toEqual([])
  expect(useShell.getState().sideDrawer).toBe('outputs')
})
