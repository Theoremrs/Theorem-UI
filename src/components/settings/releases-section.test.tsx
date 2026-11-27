// SOURCING: bun:test rendering ReleasesSection with React into happy-dom (test/blocks/render), over an in-memory WorkspaceClient stub; the release records are the real store.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '../../../test/blocks/render'
import { useModuleCatalog } from '@/lib/modules/registry'
import { emptyRecord, useReleases } from '@/lib/releases'
import type { ModuleRecord } from '@/lib/releases'
import { ReleasesSection } from './releases-section'

// The catalog is shared with every other test file: keep the built-ins that
// registered at import, and put them back after each test.
const shipped = useModuleCatalog.getState()
afterEach(() => {
  cleanup()
  useModuleCatalog.setState(shipped, true)
})
beforeEach(() => {
  useReleases.setState({ modules: {} })
  useModuleCatalog.setState({ builtins: [], installed: [], problems: [] })
})

const client = {
  workspace: {
    id: 'ws_1',
    name: 'v',
    path: '',
    trusted: true,
    policy: 'ConnectedLive',
  },
  tree: async () => [],
  subscribe: () => () => {},
  readText: async () => ({ text: '', hash: 'h' }),
  write: async () => ({ hash: 'h' }),
} as never

const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ReleasesSection client={client} />
    </QueryClientProvider>,
  )

const record = (over: Partial<ModuleRecord>): ModuleRecord => ({
  ...emptyRecord('vault.notes'),
  ...over,
})

test('shows a failed candidate with its diagnostics and says the working release keeps running', async () => {
  useReleases.setState({
    modules: {
      'vault.notes': record({
        candidate: {
          stage: 'resolve',
          at: 1,
          diagnostics: [
            {
              stage: 'resolve',
              severity: 'error',
              message: 'schema: expected theorem.module/1',
              hint: 'Fix the manifest.',
            },
          ],
        },
      }),
    },
  })
  const view = await show()
  expect(view.container.textContent).toContain('Candidate failed')
  expect(view.container.textContent).toContain(
    'schema: expected theorem.module/1',
  )
  expect(view.container.textContent).toContain('Fix the manifest.')
  expect(view.container.textContent).toContain('keeps running')
})

test('an uninstalled module stays listed, with its history and an Enable action', async () => {
  useReleases.setState({
    modules: { 'vault.notes': record({ disabled: true, uninstalled: true }) },
  })
  const view = await show()
  expect(view.container.textContent).toContain('Uninstalled')
  expect(view.container.textContent).toContain('Enable')
  expect(view.container.textContent).toContain('Code history')
  expect(view.container.textContent).toContain('Data history')
})

test('with nothing installed it says so', async () => {
  const view = await show()
  expect(view.container.textContent).toContain('No module or app is installed')
})
