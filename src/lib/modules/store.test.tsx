// SOURCING: bun:test over the module store's hooks, rendered with React into
// happy-dom (test/workspace's render, which supplies a QueryClient) against
// test/workspace's fake vault, which answers the SDK Files contract and
// sends its events.
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import {
  cleanup,
  fakeWorkspace,
  render,
  waitFor,
} from '../../../test/workspace'
import { stubPageOwner } from '../../../test/page-owner'
import { WorkspaceConflictError } from '@/lib/workspace/types'
import type { WorkspaceClient } from '@/lib/workspace/types'
import { pageText, parsePage } from './contract'
import type { PageDocument } from './contract'
import { newPage } from './layout'
import { useModuleCatalog } from './registry'
import {
  newModuleFiles,
  useCreatePage,
  useInstalledModules,
  useModePage,
  usePage,
  usePageHistory,
  usePages,
  useResetModePage,
  useRestorePage,
  useSavePage,
  useVaultTemplates,
} from './store'
import type { ModePageSource } from './store'
import { CODING_TEMPLATE, modeTemplatePage } from './templates'

afterEach(cleanup)

// The browser check found an open page swapped for its loading state, and
// what was being arranged lost, when a module was saved from it: the
// catalog went back to pending while the new manifest was read.
test('a module arriving later does not make the catalog pending again', async () => {
  const fake = fakeWorkspace({
    'Modules/first/module.json': newModuleFiles('vault.first', 'First')
      .manifest,
  })
  const seen: boolean[] = []
  function Probe({ client }: { client: WorkspaceClient }) {
    seen.push(useInstalledModules(client).isPending)
    return null
  }
  await render(<Probe client={fake.client} />)
  await waitFor(() => seen.at(-1) === false)
  const ready = seen.length

  await fake.external(
    'Modules/second/module.json',
    newModuleFiles('vault.second', 'Second').manifest,
  )
  await waitFor(() =>
    useModuleCatalog.getState().installed.some((m) => m.id === 'vault.second'),
  )
  expect(seen.slice(ready - 1)).not.toContain(true)
})

test("a mode's page is its template until the vault has one, and the template again for a file that does not parse", async () => {
  const fake = fakeWorkspace({})
  let seen: ModePageSource | undefined
  function Probe({ client }: { client: WorkspaceClient }) {
    seen = useModePage(client, 'ide').data
    return null
  }
  await render(<Probe client={fake.client} />)
  await waitFor(() => seen)
  expect(seen).toMatchObject({ template: true, hash: null })
  expect(seen!.page).toEqual(modeTemplatePage('ide'))

  const mine = { ...newPage('IDE mode'), title: 'IDE mode' }
  await fake.external('Modes/ide.page.json', pageText(mine))
  await waitFor(() => seen && !seen.template)
  expect(seen!.page).toEqual(mine)
  expect(seen!.hash).toEqual(expect.any(String))

  await fake.external('Modes/ide.page.json', '{"schema": "theorem.page/1"')
  await waitFor(() => seen?.problem)
  expect(seen).toMatchObject({ template: true })
  expect(seen!.problem).toContain('Modes/ide.page.json')
  // A save then replaces that revision of the file, and only that one.
  expect(seen!.hash).toEqual(expect.any(String))
})

// The browser check found the first save of a mode's arrangement ending
// Arrange: the new file was read again, the mode went back to loading, and
// the editor over it was replaced. A mode's file can also go and come back
// at the same path, and what comes back is what shows.
test("a mode's page stays on hand while its file comes and goes, and shows each file as it is", async () => {
  const path = 'Modes/index.page.json'
  const fake = fakeWorkspace({})
  const seen: (ModePageSource | undefined)[] = []
  let save: ReturnType<typeof useSavePage> | undefined
  let reset: ReturnType<typeof useResetModePage> | undefined
  function Probe({ client }: { client: WorkspaceClient }) {
    seen.push(useModePage(client, 'index').data)
    save = useSavePage(client)
    reset = useResetModePage(client)
    return null
  }
  const titled = (title: string) => ({ ...newPage(title), title })
  const shown = () => seen.at(-1)?.page.title
  await render(<Probe client={fake.client} />)
  await waitFor(() => seen.at(-1))
  const ready = seen.length

  // Written elsewhere: the template stays on hand while it is read.
  await fake.external(path, pageText(titled('Theirs')))
  await waitFor(() => shown() === 'Theirs')

  // Reset, then the first save from here: what was read of theirs never
  // comes back, and the save shows without waiting on a read.
  await act(() => reset!.mutateAsync('index'))
  await waitFor(() => seen.at(-1)?.template)
  const saving = seen.length
  await act(() => save!.mutateAsync({ path, page: titled('Mine'), hash: null }))
  await waitFor(() => shown() === 'Mine')
  expect(
    seen.slice(saving).map((s) => (s!.template ? 'template' : s!.page.title)),
  ).not.toContain('Theirs')

  // Gone and back from elsewhere: the new file is read, not the old one kept.
  await act(() => fake.client.remove(path))
  await waitFor(() => seen.at(-1)?.template)
  await fake.external(path, pageText(titled('Again')))
  await waitFor(() => shown() === 'Again')

  // Reset, then written elsewhere: the old file does not show meanwhile.
  await act(() => reset!.mutateAsync('index'))
  await waitFor(() => seen.at(-1)?.template)
  const resetAt = seen.length
  await fake.external(path, pageText(titled('Last')))
  await waitFor(() => shown() === 'Last')
  expect(
    seen.slice(resetAt).map((s) => (s!.template ? 'template' : s!.page.title)),
  ).not.toContain('Again')

  expect(seen.slice(ready - 1)).not.toContain(undefined)
})

// Review found an open page swapped for its loading state by a rename, and
// for an error by a revision that does not parse; either replaced the editor
// and lost what was being arranged.
test('an open page stays on hand through a rename and a revision that does not parse', async () => {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText(newPage('Desk')),
  })
  const [entry] = (await fake.client.tree()).filter(
    (e) => e.path === 'Pages/Desk.page.json',
  )
  const seen: ReturnType<typeof usePage>[] = []
  function Probe({ client }: { client: WorkspaceClient }) {
    seen.push(usePage(client, entry!.id))
    return null
  }
  await render(<Probe client={fake.client} />)
  await waitFor(() => seen.at(-1)?.data)
  const ready = seen.length
  const opened = seen.at(-1)!.data!.hash

  await act(() =>
    fake.client.rename('Pages/Desk.page.json', 'Pages/Study.page.json'),
  )
  await waitFor(() => seen.at(-1)?.data?.path === 'Pages/Study.page.json')
  // A save from here goes to where the file is now, over the same revision.
  expect(seen.at(-1)!.data).toMatchObject({
    path: 'Pages/Study.page.json',
    hash: opened,
  })

  await fake.external('Pages/Study.page.json', 'not json')
  await waitFor(() => seen.at(-1)?.error)
  expect(seen.at(-1)!.data).toMatchObject({
    path: 'Pages/Study.page.json',
    hash: opened,
  })
  expect(seen.at(-1)!.data!.page.title).toBe('Desk')
  expect(seen.slice(ready).map((s) => s.data)).not.toContain(undefined)
})

// Review found that a rename left what was read at each path in place, so a
// file renamed onto a path read before showed the old file's page there.
test('pages that swap paths each read as the file now at their path', async () => {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText(newPage('Desk')),
    'Pages/Study.page.json': pageText(newPage('Study')),
  })
  let titles: Record<string, string | undefined> = {}
  function Probe({ client }: { client: WorkspaceClient }) {
    const { pages } = usePages(client)
    titles = Object.fromEntries(
      pages.map(({ entry, page }) => [entry.path, page?.title]),
    )
    return null
  }
  await render(<Probe client={fake.client} />)
  await waitFor(() => titles['Pages/Study.page.json'] === 'Study')
  expect(titles['Pages/Desk.page.json']).toBe('Desk')

  await act(async () => {
    await fake.client.rename('Pages/Desk.page.json', 'Pages/Swap.page.json')
    await fake.client.rename('Pages/Study.page.json', 'Pages/Desk.page.json')
    await fake.client.rename('Pages/Swap.page.json', 'Pages/Study.page.json')
  })
  await waitFor(
    () =>
      titles['Pages/Desk.page.json'] === 'Study' &&
      titles['Pages/Study.page.json'] === 'Desk',
  )
  expect(Object.keys(titles).sort()).toEqual([
    'Pages/Desk.page.json',
    'Pages/Study.page.json',
  ])
})

test('a save from no file only creates one; a save without a hash overwrites', async () => {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText(newPage('Desk')),
  })
  let save: ReturnType<typeof useSavePage> | undefined
  function Probe({ client }: { client: WorkspaceClient }) {
    save = useSavePage(client)
    return null
  }
  await render(<Probe client={fake.client} />)
  const page = newPage('Desk again')
  await act(() =>
    expect(
      save!.mutateAsync({ path: 'Pages/Desk.page.json', page, hash: null }),
    ).rejects.toBeInstanceOf(WorkspaceConflictError),
  )
  expect(
    parsePage('Pages/Desk.page.json', fake.text('Pages/Desk.page.json')!).title,
  ).toBe('Desk')

  await act(() =>
    save!.mutateAsync({ path: 'Modes/index.page.json', page, hash: null }),
  )
  await act(() => save!.mutateAsync({ path: 'Pages/Desk.page.json', page }))
  expect(fake.writes.map((w) => w.expectedHash)).toEqual([
    null,
    null,
    undefined,
  ])
  expect(
    parsePage('Pages/Desk.page.json', fake.text('Pages/Desk.page.json')!).title,
  ).toBe('Desk again')
})

test("a page made from a template starts as the template's layout; saved templates are listed", async () => {
  const saved = { ...newPage('Reading desk'), layout: CODING_TEMPLATE.layout }
  const fake = fakeWorkspace({
    'Templates/Reading desk.page.json': pageText(saved),
    'Templates/broken.page.json': 'not json',
  })
  let create: ReturnType<typeof useCreatePage> | undefined
  let listed: ReturnType<typeof useVaultTemplates> | undefined
  function Probe({ client }: { client: WorkspaceClient }) {
    create = useCreatePage(client)
    listed = useVaultTemplates(client)
    return null
  }
  await render(<Probe client={fake.client} />)
  await waitFor(() => listed?.templates.length)
  // The file that does not parse is left out rather than offered.
  expect(listed!.templates.map((t) => [t.id, t.title, t.origin])).toEqual([
    ['Templates/Reading desk.page.json', 'Reading desk', 'vault'],
  ])

  await act(() =>
    create!.mutateAsync({ title: 'Code', template: listed!.templates[0] }),
  )
  const made = parsePage(
    'Pages/Code.page.json',
    fake.text('Pages/Code.page.json')!,
  )
  expect(made.title).toBe('Code')
  expect(made.layout).toEqual(CODING_TEMPLATE.layout)
})

// ── Through Theorem's page owner ────────────────────────────────────────────

const happy = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM

/** The fake vault as the Theorem vault, whose page writes go to /api/pages/v1. */
function ownedVault(files: Record<string, string>) {
  happy.setURL('http://localhost:3000/')
  const fake = fakeWorkspace(files)
  const owner = stubPageOwner(fake)
  stops.push(() => {
    owner.restore()
    happy.setURL('about:blank')
  })
  return { fake, owner }
}
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

const desk = (): PageDocument => ({
  schema: 'theorem.page/1',
  title: 'Desk',
  pinned: false,
  layout: {
    root: { props: {} },
    content: [
      { type: 'theorem.text', props: { id: 'note', text: 'Hello' } },
      {
        type: 'theorem.capability.table',
        props: { id: 'tasks', instanceId: 'tracker/main', viewKey: 'next' },
      },
    ],
  },
})

test('in the Theorem vault one component edited is a patch by its id, a structural edit a whole save, and a stale revision a conflict', async () => {
  const path = 'Pages/Desk.page.json'
  const { fake, owner } = ownedVault({ [path]: pageText(desk()) })
  let save: ReturnType<typeof useSavePage> | undefined
  function Probe({ client }: { client: WorkspaceClient }) {
    save = useSavePage(client)
    return null
  }
  await render(<Probe client={owner.client} />)
  const opened = (await fake.client.readText(path)).hash

  const edited = desk()
  edited.layout.content[1]!.props.viewKey = 'done'
  const patched = await act(() =>
    save!.mutateAsync({ path, page: edited, hash: opened, base: desk() }),
  )
  expect(owner.calls.at(-1)).toEqual({
    route: '/patch',
    body: {
      path,
      expectedRevision: opened,
      ops: [
        { op: 'set_props', componentId: 'tasks', props: { viewKey: 'done' } },
      ],
    },
  })
  expect(patched.hash).toBe((await fake.client.readText(path)).hash)
  expect(parsePage(path, fake.text(path)!)).toEqual(edited)

  const grown = structuredClone(edited)
  grown.layout.content.push({ type: 'theorem.text', props: { id: 'more' } })
  const saved = await act(() =>
    save!.mutateAsync({ path, page: grown, hash: patched.hash, base: edited }),
  )
  expect(owner.calls.at(-1)!.route).toBe('/save')
  expect(owner.calls.at(-1)!.body).toMatchObject({
    path,
    expectedRevision: patched.hash,
  })

  // The revision it opened at is gone: Keep mine / Use the vault's, as before.
  const stale = await act(() =>
    save!
      .mutateAsync({ path, page: desk(), hash: opened, base: desk() })
      .catch((error: unknown) => error),
  )
  expect(stale).toBeInstanceOf(WorkspaceConflictError)
  expect((stale as WorkspaceConflictError).currentHash).toBe(saved.hash)

  // Create-only over a page that is there is a conflict too, and writes nothing.
  const exists = await act(() =>
    save!
      .mutateAsync({ path, page: desk(), hash: null })
      .catch((error: unknown) => error),
  )
  expect(exists).toBeInstanceOf(WorkspaceConflictError)
  expect(parsePage(path, fake.text(path)!)).toEqual(grown)
})

test('a restore through the owner writes the old layout as a new revision and lists it in history', async () => {
  const path = 'Pages/Desk.page.json'
  const { fake, owner } = ownedVault({})
  let save: ReturnType<typeof useSavePage> | undefined
  let restore: ReturnType<typeof useRestorePage> | undefined
  let history: ReturnType<typeof usePageHistory> | undefined
  function Probe({ client }: { client: WorkspaceClient }) {
    save = useSavePage(client)
    restore = useRestorePage(client)
    history = usePageHistory(client, path)
    return null
  }
  await render(<Probe client={owner.client} />)
  const first = await act(() =>
    save!.mutateAsync({ path, page: desk(), hash: null }),
  )
  const edited = { ...desk(), title: 'Study' }
  const second = await act(() =>
    save!.mutateAsync({ path, page: edited, hash: first.hash, base: desk() }),
  )
  await waitFor(() => history?.revisions.length === 2)

  const restored = await act(() =>
    restore!.mutateAsync({
      path,
      revision: first.hash,
      expectedRevision: second.hash,
    }),
  )
  expect(restored.page).toEqual(desk())
  expect(parsePage(path, fake.text(path)!)).toEqual(desk())
  await waitFor(() => history?.revisions.length === 3)
  expect(history!.revisions.map((r) => [r.seq, r.reason])).toEqual([
    [3, 'restored'],
    [2, 'patched'],
    [1, 'saved'],
  ])
})
