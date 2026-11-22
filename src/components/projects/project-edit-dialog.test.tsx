// The project edit dialog against the real edits hook and a stubbed server: it sends only what changed, and never instructions it could not read.
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { ProjectEditDialog } from './project-edit-dialog'

const project = {
  schema: 'theorem.chat.project.v1',
  projectId: 'proj_a',
  tenantId: 't',
  title: 'Research',
  instructions: 'Cite the source.',
  status: 'active',
  revision: 3,
  createdAtMs: 1,
  updatedAtMs: 1,
}

const sent: Record<string, unknown>[] = []
const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
let fetchSpy: ReturnType<typeof spyOn>
beforeAll(() => {
  page.setURL('http://localhost:3000/')
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input,
    init,
  ) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/bootstrap'))
      return Response.json({ csrfToken: 'csrf', tenantId: 't' })
    if (request.method === 'GET') return Response.json({ items: [project] })
    sent.push((await request.json()) as Record<string, unknown>)
    return Response.json({ project: { ...project, revision: 4 } })
  }) as typeof fetch)
})
afterEach(async () => {
  sent.length = 0
  await cleanup()
})
afterAll(() => {
  fetchSpy.mockRestore()
  page.setURL('about:blank')
})

async function open(instructions: string | undefined) {
  const done: boolean[] = []
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectEditDialog
        projectId="proj_a"
        title="Research"
        instructions={instructions}
        open
        onOpenChange={(next) => done.push(!next)}
      />
    </QueryClientProvider>,
  )
  const form = await waitFor(() => document.querySelector('form'))
  return { form, done }
}

async function rename(form: HTMLFormElement, title: string) {
  const input = form.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, title)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a rename sends the title alone, so the instructions keep their stored text', async () => {
  const { form } = await open(project.instructions)
  await rename(form, 'Reading')
  await click(buttonNamed(form, 'Save')!)
  await waitFor(() => sent.length > 0)
  expect(sent[0]).toMatchObject({ title: 'Reading' })
  expect(sent[0]).not.toHaveProperty('instructions')
})

test('instructions that could not be read are locked and never sent', async () => {
  const { form } = await open(undefined)
  expect(form.querySelector('textarea')!.disabled).toBe(true)
  expect(form.textContent).toContain('could not be read')
  await rename(form, 'Reading')
  await click(buttonNamed(form, 'Save')!)
  await waitFor(() => sent.length > 0)
  expect(sent[0]).not.toHaveProperty('instructions')
})

test('saving with nothing changed sends nothing and closes', async () => {
  const { form, done } = await open(project.instructions)
  await click(buttonNamed(form, 'Save')!)
  await waitFor(() => done.length > 0)
  expect(sent).toHaveLength(0)
})
