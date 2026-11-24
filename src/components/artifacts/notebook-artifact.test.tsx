import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as esbuild from 'esbuild-wasm'
import { LoroDoc } from 'loro-crdt/base64'
import { act } from 'react'
import type { ReactNode } from 'react'
import * as bundles from '@/lib/blocks/export'
import { BLOCK_SANDBOX } from '@/lib/blocks/executor'
import * as hosted from '@/lib/blocks/hosted-app'
import { fromBase64 } from '@/lib/blocks/state'
import { call } from '@/lib/blocks/sandbox/protocol'
import type { PageMethods } from '@/lib/blocks/sandbox/protocol'
import type { NotebookForm, RetainedOutputs } from '@/lib/notebooks/forms'
import { BROWSER_RUN_HOSTS } from '@/lib/notebooks/marimo'
import { encodeNote } from '@/lib/theorem/note-canonical'
import {
  editNote,
  noteKey,
  settleNote,
  useNoteStatus,
} from '@/lib/theorem/notes'
import type { Note } from '@/lib/theorem/notes'
import type { ExecuteEnvironment } from '@/lib/theorem/artifact-host'
import { installFakeTheorem } from '@/stories/fake-theorem'
import {
  artifactHost,
  notebookPart,
  outputsAnswer,
} from '@/stories/fixtures/notebook-parts'
import {
  appDocumentFixture,
  documentRoutes,
  savedArtifactBody,
} from '../../../test/blocks/app-documents'
import { connectAppFrame } from '../../../test/blocks/app-frame'
import {
  buttonNamed,
  cleanup,
  click,
  render as mount,
  waitFor,
} from '../../../test/blocks/render'
import { readArtifact } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'
import {
  fileNameOf,
  isLive,
  representationOf,
  sourceOf,
} from './artifact-registry'
import { ArtifactView } from './artifact-renderers'
import { NotePanel } from '../notes/note-panel'

const MARIMO_SOURCE = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md("# Timings")
    return
`

const SOURCE_REVISION = 'sha256:5e1f'

const RUN: RetainedOutputs = {
  revision: SOURCE_REVISION,
  inputs: { run: true },
  cells: [
    { id: 'Hbol', outputs: [] },
    { id: 'MJUe', outputs: [{ mime: 'text/html', data: '<h1>Recorded timings</h1>' }] },
  ],
  execution: {
    host: 'gpu-host-1',
    device: 'NVIDIA L4',
    startedAtMs: Date.UTC(2026, 10, 9),
    finishedAtMs: Date.UTC(2026, 10, 9, 0, 1),
  },
}

// The SDK resolves routes against the page's origin, which a bare happy-dom
// page does not have.
const happyDOM = (window as unknown as { happyDOM: { setURL: (url: string) => void } })
  .happyDOM
beforeAll(() => happyDOM.setURL('http://localhost:3000/'))
afterAll(() => happyDOM.setURL('about:blank'))

/**
 * A Theorem whose marimo notebooks execute at `execute`, and whose one
 * notebook document has recorded `runs`. Answers are held until `release`
 * when `held`, so a test can see what shows while they load.
 */
function fakeTheorem({
  execute = 'browser',
  runs = [],
  held = false,
  documents = [],
}: {
  execute?: ExecuteEnvironment
  runs?: Array<RetainedOutputs>
  held?: boolean
  /** Saved documents parts name, answered as the Documents API does. */
  documents?: Parameters<typeof documentRoutes>[0]
} = {}) {
  let release = () => {}
  const gate = held ? new Promise<void>((resolve) => (release = resolve)) : undefined
  const reads: Array<string> = []
  const restore = installFakeTheorem({
    ...documentRoutes(documents),
    'GET /api/artifacts/v1/host': () => artifactHost(execute),
    'GET /api/artifacts/v1/documents/:documentId/outputs': async (_params, request) => {
      reads.push(new URL(request.url).search)
      await gate
      return outputsAnswer(SOURCE_REVISION, runs, request)
    },
  })
  return { reads, release, restore }
}

let theorem: ReturnType<typeof fakeTheorem>
/** Swaps in a fake Theorem for this test. */
const serve = (options: Parameters<typeof fakeTheorem>[0]) => {
  theorem.restore()
  theorem = fakeTheorem(options)
}
beforeEach(() => {
  theorem = fakeTheorem()
})
afterEach(() => theorem.restore())

const render = (node: ReactNode) =>
  mount(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  )

const part = (documentId: string, notebook: NotebookForm, sourceRevision?: string) =>
  readArtifact(notebookPart(documentId, notebook, { position: 3, sourceRevision }))!

const observable = (position = 3) =>
  readArtifact(
    notebookPart(
      'crossover',
      {
        form: 'observable',
        title: 'GPU crossover',
        cells: [
          { id: 'title', kind: 'md', source: '# Crossover' },
          { id: 'half', kind: 'js', source: 'data.n / 2' },
        ],
        data: { n: 8 },
      },
      { position },
    ),
  )!

/** A stored marimo part: it names where its outputs are and carries none. */
const marimo = (extra: Partial<Extract<NotebookForm, { form: 'marimo' }>> = {}) =>
  part(
    'timings',
    {
      form: 'marimo',
      title: 'GPU timings',
      source: MARIMO_SOURCE,
      runtime: 'pyodide',
      ...extra,
    },
    SOURCE_REVISION,
  )

const gpu = { runtime: 'native', needs: { gpu: true } } as const

/** Every hosted document the renderers build, built with Bun's esbuild. */
function captureDocuments() {
  const originalHosted = hosted.hostedAppDocument
  const originalRuntime = bundles.bundleNotebookRuntime
  const documents: string[] = []
  const page = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    async (html, _esbuild, options) => {
      const document = await originalHosted(html, esbuild, options)
      documents.push(document)
      return document
    },
  )
  const runtime = spyOn(bundles, 'bundleNotebookRuntime').mockImplementation(() =>
    originalRuntime(esbuild),
  )
  return {
    documents,
    restore: () => {
      page.mockRestore()
      runtime.mockRestore()
    },
  }
}

afterEach(cleanup)

const status = (container: HTMLElement) =>
  container.querySelector('[role="status"]')!.textContent

test('notebooks resolve by their form to the contract renderers, at every distance, with no live session', () => {
  for (const distance of ['preview', 'thing', 'interactive'] as const) {
    expect(representationOf(observable(), distance).renderer).toBe('theorem-observable')
    expect(representationOf(marimo(), distance).renderer).toBe('theorem-marimo')
    expect(isLive(marimo(), distance)).toBe(false)
  }
  expect(representationOf(marimo(), 'thing').locators).toContain('notebook_cell')
  expect(marimo().kind).toBe('marimo')
  expect(marimo().documentId).toBe('timings')
})

test('a notebook in a newer form version reaches its renderer, which says it cannot read it', async () => {
  const stored = notebookPart('later', {
    form: 'observable',
    title: 'Later',
    cells: [],
  })
  const newer = readArtifact({ ...stored, payload: { ...stored.payload, formVersion: 2 } })!
  expect(newer.notebook).toBeUndefined()
  expect(representationOf(newer, 'thing').renderer).toBe('theorem-observable')
  const { container } = await render(
    <ArtifactView artifact={newer} distance="thing" latest />,
  )
  expect(container.textContent).toContain('form version 2')
  expect(container.querySelector('iframe')).toBeNull()
})

test('Download hands over a Notebook Kit file and a marimo .py', async () => {
  expect(fileNameOf(observable(), true)).toBe('gpu-crossover.html')
  const kit = await sourceOf(observable(), false).load()
  expect(kit).toContain('<notebook')
  expect(kit).toContain('const data =')
  expect(kit).toContain('const theme =')
  expect(kit).toContain('data.n / 2')
  expect(fileNameOf(marimo(), true)).toBe('gpu-timings.py')
  expect(await sourceOf(marimo(), false).load()).toBe(MARIMO_SOURCE)
})

/** The rents notebook as its message carried it, revision 3 of document `rents`. */
const RENTS = {
  form: 'observable',
  title: 'Rents',
  cells: [
    { id: 'rent', kind: 'js', source: 'views.param(Inputs.range([500, 4000], { value: 1200 }), "rent")' },
    { id: 'share', kind: 'js', source: 'rent / 3000' },
  ],
  data: {},
} as const

/** The same notebook as revised since, in another thread: the document's head. */
const RENTS_HEAD = {
  ...RENTS,
  cells: [...RENTS.cells, { id: 'yearly', kind: 'js', source: 'rent * 12' }],
} as const

const rents = (documentId: string) =>
  part(documentId, RENTS as unknown as NotebookForm)

/** The document a part names, saved at `position` with `state` in its collections. */
async function savedHead(
  documentId: string,
  publication: { form: string; title: string },
  { position = 5, state = {} }: { position?: number; state?: Record<string, Record<string, unknown>> } = {},
) {
  const doc = LoroDoc.fromSnapshot(savedArtifactBody(publication))
  for (const [name, records] of Object.entries(state))
    for (const [id, value] of Object.entries(records))
      doc.getMap(`app-state:${name}`).set(id, value as never)
  doc.commit()
  return appDocumentFixture({
    documentId,
    position,
    canonical: doc.export({ mode: 'snapshot' }),
    markdownProjection: `# ${publication.title}`,
  })
}

/** A state collection of the document as it is saved now. */
function savedState(head: Awaited<ReturnType<typeof savedHead>>, name: string) {
  const { canonical } = head.saved()
  if (canonical.placement !== 'inline') throw new Error('fixture must be inline')
  return LoroDoc.fromSnapshot(fromBase64(canonical.bytesBase64))
    .getMap(`app-state:${name}`)
    .toJSON() as Record<string, unknown>
}

test('Copy and Download read the newest revision from its document, and an older one from its message', async () => {
  const head = await savedHead('rents-download', RENTS_HEAD)
  serve({ documents: [head] })
  const message = rents('rents-download')
  expect(await sourceOf(message, true).load()).toContain('rent * 12')
  const pinned = await sourceOf(message, false).load()
  expect(pinned).toContain('rent / 3000')
  expect(pinned).not.toContain('rent * 12')
})

test('the newest revision runs its document\'s head, starts from where its views were left, and saves where they are left', async () => {
  const head = await savedHead('rents-head', RENTS_HEAD, {
    state: { notebook: { saved: { params: { rent: 1800 } } } },
  })
  serve({ documents: [head] })
  const capture = captureDocuments()
  let close = () => {}
  try {
    const { container } = await render(
      <ArtifactView artifact={rents('rents-head')} distance="thing" latest />,
    )
    const frame = await connectAppFrame(container)
    close = frame.close
    const built = capture.documents.at(-1)!
    // The head, revised in another thread, not the revision the message carried.
    expect(built).toContain('rent * 12')
    expect(built).toContain('"params":{"rent":1800}')

    // Cells reach the document's own state collections.
    await act(() =>
      call<PageMethods, 'state.set'>(frame.rpc, 'state.set', {
        name: 'picks',
        key: 'austin',
        value: { rent: 1800 },
      }),
    )
    await waitFor(() => savedState(head, 'picks').austin)
    expect(savedState(head, 'picks')).toEqual({ austin: { rent: 1800 } })

    // A moved parameter is saved once the views rest.
    const writes = head.writes.length
    for (const rent of [1900, 2000, 2100])
      await act(() =>
        call<PageMethods, 'frame.selection'>(frame.rpc, 'frame.selection', {
          text: '',
          label: 'Parameters',
          state: { params: { rent } },
        } as never),
      )
    await waitFor(
      () => (savedState(head, 'notebook').saved as { params?: { rent?: number } } | undefined)?.params?.rent === 2100,
      3000,
    )
    expect(head.writes.length).toBe(writes + 1)

    // A click that moves nothing saves nothing.
    await act(() =>
      call<PageMethods, 'frame.selection'>(frame.rpc, 'frame.selection', {
        text: '',
        cellId: 'share',
        state: { params: { rent: 2100 } },
      }),
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
    expect(head.writes.length).toBe(writes + 1)
  } finally {
    close()
  }
  await cleanup()

  // A view opened later starts from where the last one left its views.
  try {
    await render(<ArtifactView artifact={rents('rents-head')} distance="thing" latest />)
    await waitFor(() => capture.documents.at(-1)!.includes('"params":{"rent":2100}'), 10_000)
  } finally {
    capture.restore()
  }
}, 30_000)

test('an older revision runs as its message pinned it, and keeps what changes in its frame', async () => {
  const head = await savedHead('rents-pinned', RENTS_HEAD, {
    state: { notebook: { saved: { params: { rent: 1800 } } } },
  })
  serve({ documents: [head] })
  const capture = captureDocuments()
  let close = () => {}
  try {
    const { container } = await render(
      <ArtifactView artifact={rents('rents-pinned')} distance="thing" latest={false} />,
    )
    const frame = await connectAppFrame(container)
    close = frame.close
    const built = capture.documents.at(-1)!
    expect(built).toContain('rent / 3000')
    expect(built).not.toContain('rent * 12')
    // Revision 3 is not the document's current one, so its views start where the message left them.
    expect(built).not.toContain('"rent":1800')
    expect(status(container)).toContain('Saved revision 3. Changes you make here are not saved.')
    expect(buttonNamed(container, 'Open latest')).toBeDefined()

    await act(() =>
      call<PageMethods, 'state.set'>(frame.rpc, 'state.set', { name: 'picks', key: 'austin', value: 1 }),
    )
    await act(() =>
      call<PageMethods, 'frame.selection'>(frame.rpc, 'frame.selection', {
        text: '',
        state: { params: { rent: 2500 } },
      }),
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
    expect(head.writes).toHaveLength(0)
  } finally {
    close()
    capture.restore()
  }
}, 20_000)

test('an Observable notebook runs in an App frame with no policy of the host\'s', async () => {
  const capture = captureDocuments()
  try {
    const { container } = await render(
      <ArtifactView artifact={observable()} distance="thing" latest />,
    )
    const frame = await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(frame.getAttribute('sandbox')).toBe(BLOCK_SANDBOX)
    expect(capture.documents[0]).not.toContain('Content-Security-Policy')
    expect(buttonNamed(container, 'Ask about this')).toBeDefined()
  } finally {
    capture.restore()
  }
}, 20_000)

test('a selection belongs to the revision it was made in', async () => {
  const capture = captureDocuments()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (artifact: TheoremArtifact) => (
    <QueryClientProvider client={client}>
      <ArtifactView artifact={artifact} distance="thing" latest />
    </QueryClientProvider>
  )
  let close = () => {}
  try {
    const { container, rerender } = await mount(view(observable(3)))
    const frame = await connectAppFrame(container)
    close = frame.close
    await act(() =>
      call<PageMethods, 'frame.selection'>(frame.rpc, 'frame.selection', {
        text: '4',
        cellId: 'half',
      }),
    )
    expect(buttonNamed(container, 'Ask about selection')).toBeDefined()
    await rerender(view(observable(4)))
    expect(buttonNamed(container, 'Ask about selection')).toBeUndefined()
    expect(buttonNamed(container, 'Ask about this')).toBeDefined()
  } finally {
    close()
    capture.restore()
  }
}, 20_000)

test('a GPU notebook reads its recorded outputs from the href its part names, names the host, and never claims a live run', async () => {
  serve({ runs: [RUN], held: true })
  const capture = captureDocuments()
  try {
    const { container } = await render(
      <ArtifactView artifact={marimo(gpu)} distance="thing" latest />,
    )
    await waitFor(() => status(container).includes('Opening the recorded outputs'))
    theorem.release()
    await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(theorem.reads).toEqual([`?revision=${SOURCE_REVISION}`])
    const line = status(container)
    expect(line).toContain('From a recorded run on gpu-host-1, NVIDIA L4')
    expect(line).toContain('needs a GPU host; none is connected')
    expect(line).not.toContain('Running in this page')
    expect(line).not.toMatch(/\blive\b/i)
    expect(buttonNamed(container, 'Run notebook')).toBeUndefined()
    expect(capture.documents).toHaveLength(1)
    expect(capture.documents[0]).toContain('<h1>Recorded timings</h1>')
    expect(capture.documents[0]).not.toContain('marimo-team/islands')
  } finally {
    capture.restore()
  }
}, 20_000)

test('a GPU host is connected only when the host executes marimo on a GPU', async () => {
  for (const [execute, connected] of [
    ['native', false],
    ['native-gpu', true],
  ] as const) {
    serve({ execute, runs: [RUN] })
    const { container } = await render(
      <ArtifactView artifact={marimo(gpu)} distance="thing" latest />,
    )
    await waitFor(() => status(container).includes('From a recorded run'), 10_000)
    await waitFor(() => !connected || !status(container).includes('none is connected'))
    expect(status(container).includes('none is connected')).toBe(!connected)
    // "Run on host" has no route to start a host run yet, so it is not drawn.
    expect(buttonNamed(container, 'Run on host')).toBeUndefined()
    await cleanup()
  }
}, 20_000)

test('a GPU notebook that has not run says it is awaiting a GPU host and shows nothing as output', async () => {
  const capture = captureDocuments()
  try {
    const { container } = await render(
      <ArtifactView artifact={marimo(gpu)} distance="thing" latest />,
    )
    await waitFor(() => status(container).includes('Awaiting a GPU host'), 10_000)
    // The exact revision has no run, and neither has the document.
    expect(theorem.reads).toEqual([`?revision=${SOURCE_REVISION}`, ''])
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed(container, 'Run notebook')).toBeUndefined()
    expect(capture.documents).toHaveLength(0)
  } finally {
    capture.restore()
  }
}, 20_000)

test('a run of an earlier source shows as that, not as the result of this source', async () => {
  serve({ runs: [{ ...RUN, revision: 'sha256:0ld' }] })
  const capture = captureDocuments()
  try {
    const { container } = await render(
      <ArtifactView artifact={marimo(gpu)} distance="thing" latest />,
    )
    await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(status(container)).toContain(
      'From a recorded run of a different version of this notebook on gpu-host-1',
    )
    expect(capture.documents[0]).toContain('<h1>Recorded timings</h1>')
  } finally {
    capture.restore()
  }
}, 20_000)

test('a browser notebook starts its runtime only after Run notebook, keeping its recorded outputs', async () => {
  serve({ runs: [RUN] })
  const capture = captureDocuments()
  try {
    const { container } = await render(
      <ArtifactView artifact={marimo()} distance="thing" latest />,
    )
    await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(capture.documents[0]).not.toContain('marimo-team/islands')
    const run = await waitFor(() => buttonNamed(container, 'Run notebook'))
    expect(run.title).toContain('no CUDA')
    await click(run)
    await waitFor(() => capture.documents.length === 2, 10_000)
    const live = capture.documents[1]!
    expect(live).toContain(`https://${BROWSER_RUN_HOSTS[0]}/`)
    expect(live).toContain('marimo-team/islands@0.23.16/dist/main.js')
    expect(live).toContain('Recorded timings')
    expect(status(container)).toContain('Running in this page on Pyodide')
    expect(buttonNamed(container, 'View result')).toBeDefined()
  } finally {
    capture.restore()
  }
}, 20_000)

test('Source shows the notebook file on request; code is hidden by default', async () => {
  serve({ runs: [RUN] })
  const capture = captureDocuments()
  try {
    const { container } = await render(
      <ArtifactView artifact={marimo()} distance="thing" latest />,
    )
    expect(container.textContent).not.toContain('marimo.App()')
    await click(buttonNamed(container, 'Source')!)
    await waitFor(() => container.textContent.includes('marimo.App()'), 10_000)
  } finally {
    capture.restore()
  }
}, 20_000)

test('a part that names no App document offers no reference to it', async () => {
  const unnamed = readArtifact({
    ...notebookPart('x', { form: 'observable', title: 'Loose', cells: [] }),
    payload: { form: 'observable', title: 'Loose', cells: [] },
  })!
  const { container } = await render(
    <ArtifactView artifact={unnamed} distance="thing" latest />,
  )
  expect(buttonNamed(container, 'Ask about this')).toBeUndefined()
})

test('a notebook opened from Notes runs as its form from its document\'s head, never in the Markdown editor', async () => {
  const head = await savedHead('rents-note', RENTS_HEAD, {
    state: { notebook: { saved: { params: { rent: 1600 } } } },
  })
  serve({ documents: [head] })
  const capture = captureDocuments()
  let close = () => {}
  try {
    const { container } = await render(<NotePanel documentId="rents-note" />)
    const frame = await connectAppFrame(container)
    close = frame.close
    const built = capture.documents.at(-1)!
    expect(built).toContain('rent * 12')
    expect(built).toContain('"params":{"rent":1600}')
    expect(container.querySelector('.ProseMirror')).toBeNull()
    expect(head.writes.length).toBe(0)
  } finally {
    close()
    capture.restore()
  }
}, 30_000)

test('a note save that meets a revision saved as an App stops instead of filing it as a note', async () => {
  // The note as it was cached, and the same document since saved as a
  // notebook: one history, so Loro would merge the two.
  const typed = encodeNote('Rents')
  const doc = LoroDoc.fromSnapshot(typed)
  const [block] = doc.getTree('blocks').getNodes().filter(
    (node) => doc.getMap(`attrs:${node.id}`).get('kind') === 'paragraph',
  )
  doc.getMap(`attrs:${block!.id}`).set('artifactForm', 'observable')
  doc.getText(`text:${block!.id}`).update(JSON.stringify(RENTS_HEAD))
  doc.commit()
  const head = await appDocumentFixture({
    documentId: 'rents-retagged',
    position: 2,
    canonical: doc.export({ mode: 'snapshot' }),
  })
  serve({ documents: [head] })
  const note: Note = {
    documentId: 'rents-retagged',
    title: 'Rents',
    markdown: 'Rents',
    savedMarkdown: 'Rents',
    revision: { position: 1, contentDigest: 'earlier' },
    canonical: typed,
    documentKind: 'authored',
    editable: true,
    origin: { kind: 'user_authored', actorId: 'person:test', originSurface: 'test' },
    retired: false,
  }
  const queryClient = new QueryClient()
  queryClient.setQueryData(noteKey(note.documentId), note)
  editNote(queryClient, note.documentId, 'Rents, revised')
  await settleNote(queryClient, note.documentId).catch(() => undefined)
  expect(useNoteStatus.getState().status[note.documentId]).toBe('conflict')
  expect(head.writes.length).toBe(0)
  expect(head.saved().summary.documentKind).toBe('theorem.app')
})
