// SOURCING: bun:test over Save as page, rendered with test/workspace's render into happy-dom, with
// test/page-owner's stand-in for /api/pages/v1 over the fake vault. What is proven: the page made is
// pinned and holds one App module bound to the artifact's document by id; what carries over is said
// from the App's own declarations, and state kept only in its frame is said not to; an App with no
// saved document offers no binding.
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { stubPageOwner } from '../../../test/page-owner'
import {
  cleanup,
  fakeWorkspace,
  render,
  waitFor,
} from '../../../test/workspace'
import { parsePage } from '@/lib/modules/contract'
import type { TheoremArtifact } from './artifact-model'
import { SaveAsPage, SaveAsPageDialog } from './save-as-page'
// The build's renderers: an artifact is an App only where the App renderer loaded.
import './artifact-renderers'

const happyDom = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  cleanup()
})

const app = (documentId?: string): TheoremArtifact => ({
  partId: 'part-1',
  artifactId: 'artifact-1',
  revision: 'r1',
  kind: 'app',
  rendererId: 'theorem-app',
  contractVersion: '1',
  lifecycle: 'complete',
  patchSequence: 0,
  title: 'Habits',
  content: '<p>Habits</p>',
  language: 'html',
  fallbackText: '',
  payloadRef: undefined,
  runId: undefined,
  sourceTool: undefined,
  ...(documentId && { documentId }),
})

function vault() {
  happyDom.setURL('http://localhost:3000/')
  const fake = fakeWorkspace({})
  const owner = stubPageOwner(fake)
  stops.push(() => {
    owner.restore()
    happyDom.setURL('about:blank')
  })
  return { fake, owner }
}

const buttonIn = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name,
  )

test('an App that keeps state only in its frame becomes a pinned page bound to its document, and says the state stays behind', async () => {
  const { fake, owner } = vault()
  let saved: { entryId: string; title: string } | undefined
  await render(
    <SaveAsPageDialog
      client={owner.client}
      artifact={app('doc-1')}
      documentId="doc-1"
      latest
      loadSource={async () => '<!doctype html><p>Habits</p>'}
      onClose={() => {}}
      onSaved={(page) => (saved = page)}
    />,
  )
  const body = document.body
  await waitFor(() => body.textContent.includes('not carried over'))
  expect(body.textContent).toContain(
    'This App keeps its state only in its running frame. That state is not carried over',
  )

  act(() => buttonIn(body, 'Save as page')!.click())
  await waitFor(() => saved)
  const path = 'Pages/Habits.page.json'
  const page = parsePage(path, fake.text(path)!)
  expect(page.title).toBe('Habits')
  expect(page.pinned).toBe(true)
  expect(page.layout.content).toEqual([
    {
      type: 'theorem.app',
      props: { id: expect.stringMatching(/^theorem\.app-/), app: 'doc-1' },
    },
  ])
  // Made through the page owner, create-only.
  const write = owner.calls.find((call) => call.route === '/save')!
  expect(write.body!.expectedRevision).toBeUndefined()
  // The route names the vault entry, which a rename keeps.
  const entry = (await fake.client.tree()).find((e) => e.path === path)!
  expect(saved).toEqual({ entryId: entry.id, title: 'Habits' })
})

test('state kept in the App document comes along, and an earlier revision says its frame does not', async () => {
  const { owner } = vault()
  await render(
    <SaveAsPageDialog
      client={owner.client}
      artifact={app('doc-1')}
      documentId="doc-1"
      latest={false}
      loadSource={async () =>
        '<meta name="theorem:uses" content=\'state("habits")\'><p>Habits</p>'
      }
      onClose={() => {}}
      onSaved={() => {}}
    />,
  )
  const body = document.body
  await waitFor(() => body.textContent.includes('Its saved state'))
  expect(body.textContent).toContain(
    'Its saved state (habits) is kept in its document',
  )
  expect(body.textContent).not.toContain('only in its running frame')
  expect(body.textContent).toContain('This is an earlier revision')
})

test('an App with no saved document offers no binding, and other artifacts no button', async () => {
  const { container } = await render(
    <>
      <SaveAsPage artifact={app()} latest />
      <SaveAsPage artifact={{ ...app('doc-1'), kind: 'document' }} latest />
    </>,
  )
  const buttons = container.querySelectorAll(
    'button[aria-label="Save as page"]',
  )
  expect(buttons.length).toBe(1)
  const only = buttons[0] as HTMLButtonElement
  expect(only.disabled).toBe(true)
  expect(only.title).toContain('no saved document')
})
