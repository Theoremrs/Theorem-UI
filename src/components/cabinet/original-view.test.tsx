// SOURCING: test/blocks/render (React under happy-dom), @tanstack/react-query,
// and the artifacts fixtures' shape for a live interactive App. The cabinet's
// catalog reads (readArtifactRevision/readLatestArtifact) are mocked, so a card
// drives OriginalView without a live thread.
//
// Review §4.2 (cabinet entry point): "Open latest" inside a saved App revision
// mounted a SECOND live DocumentApp beside the conversation's own — the App
// started twice and its local state split across two frames. The cabinet must
// refer to the answer's single runtime (ArtifactReferrer) on the live-latest
// path, while the default view keeps running the PINNED revision read-only, and
// a non-live artifact keeps its normal interactive body.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as hosted from '@/lib/blocks/hosted-app'
import type { TheoremArtifact } from '@/components/artifacts/artifact-model'
import { isLive } from '@/components/artifacts/artifact-registry'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import type { CatalogEntry } from './contract'

// A card reads its revision from its session. Drive OriginalView through the
// catalog directly instead of standing up a live thread.
const readArtifactRevision = mock(
  async (): Promise<TheoremArtifact | undefined> => undefined,
)
const readLatestArtifact = mock(
  async (): Promise<TheoremArtifact | undefined> => undefined,
)
// Load the real catalog first, then override only the two reads. OriginalView's
// referrer pulls the shell, whose workbench ports still expect the catalog's
// other exports (readSource, toEntry, …); replacing the module wholesale would
// strand them.
const catalog = await import('./catalog')
void mock.module('./catalog', () => ({
  ...catalog,
  readArtifactRevision,
  readLatestArtifact,
}))
const { OriginalView } = await import('./original-view')

// A live interactive App: kind 'app' with the mounted 'theorem-app' renderer is
// what makes its interactive representation live (isLive); a saved document
// reference is what would let a mount start a runtime of its own.
const APP_HTML = '<!doctype html><title>Totals</title><p>Totals</p>'
function appArtifact(revision: string): TheoremArtifact {
  return {
    partId: `part-${revision}`,
    artifactId: 'cabinet-app',
    revision,
    kind: 'app',
    rendererId: 'theorem-app',
    contractVersion: 'theorem-artifact-v1',
    lifecycle: 'ready',
    patchSequence: 1,
    title: 'Totals',
    content: APP_HTML,
    language: 'html',
    fallbackText: 'A saved App.',
    payloadRef: undefined,
    runId: undefined,
    sourceTool: undefined,
    documentId: 'cabinet-app-document',
    documentPosition: 3,
  }
}
const APP_ENTRY: CatalogEntry = {
  key: 'output_cabinet_app',
  projectId: 'proj',
  source: { type: 'artifact', artifactId: 'cabinet-app', revision: 'rev-1' },
  threadId: 'thread-1',
  kind: 'app',
  mediaType: 'text/html',
  title: 'Totals',
  description: { text: 'A saved App.', provenance: 'metadata' },
  revisionCount: 2,
  updatedAtMs: 1,
}

// A document is passive at every distance: never live, and with no "Open
// latest" affordance, so it is never referred and keeps its normal body.
function documentArtifact(): TheoremArtifact {
  return {
    partId: 'part-doc',
    artifactId: 'cabinet-doc',
    revision: 'rev-1',
    kind: 'document',
    rendererId: 'theorem-document',
    contractVersion: 'theorem-artifact-v1',
    lifecycle: 'ready',
    patchSequence: 1,
    title: 'Field notes',
    content: '# Document',
    language: 'markdown',
    fallbackText: 'Field notes',
    payloadRef: undefined,
    runId: undefined,
    sourceTool: undefined,
  }
}
const DOC_ENTRY: CatalogEntry = {
  key: 'output_cabinet_doc',
  projectId: 'proj',
  source: { type: 'artifact', artifactId: 'cabinet-doc', revision: 'rev-1' },
  threadId: 'thread-1',
  kind: 'document',
  mediaType: 'text/markdown',
  title: 'Field notes',
  description: { text: 'Field notes', provenance: 'metadata' },
  revisionCount: 1,
  updatedAtMs: 1,
}

const happyDOM = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM

let fetchSpy: ReturnType<typeof spyOn>
let compile: ReturnType<typeof spyOn<typeof hosted, 'hostedAppDocument'>>
beforeAll(() => {
  happyDOM.setURL('http://localhost:3000/')
  // A live DocumentApp reads its saved document on mount. Answer that read the
  // way it fails offline, so any accidental second runtime cannot start (the
  // same guard the artifacts tests use).
  const preconnect = window.fetch.preconnect
  fetchSpy = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () => Response.json({ detail: 'offline' }, { status: 503 }),
      { preconnect },
    ),
  )
  // The pinned App frame builds its source with esbuild. This is a DOM-only
  // test: refuse the build so the frame reports its handled offline state
  // rather than mounting a blob iframe happy-dom will not load. The pinned
  // revision's AppRevision section, which the test asserts on, renders either
  // way; what the frame inside it builds is another module's concern.
  compile = spyOn(hosted, 'hostedAppDocument').mockRejectedValue(
    new Error('no App compiler in this DOM-only test'),
  )
})
afterAll(() => {
  fetchSpy.mockRestore()
  compile.mockRestore()
  happyDOM.setURL('about:blank')
})

beforeEach(() => {
  readArtifactRevision.mockReset().mockResolvedValue(undefined)
  readLatestArtifact.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await cleanup()
})

/** The open cabinet dialog, wherever the Base UI portal placed it. */
const box = () =>
  document.querySelector<HTMLElement>('[data-cabinet-original]')!

const mount = (entry: CatalogEntry) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OriginalView entry={entry} onClose={() => {}} />
    </QueryClientProvider>,
  )

test('the cabinet opens a saved App revision pinned and read-only by default', async () => {
  readArtifactRevision.mockResolvedValue(appArtifact('rev-1'))
  readLatestArtifact.mockResolvedValue(appArtifact('rev-2'))
  // The fixture really is a live interactive App; otherwise the next tests
  // would prove nothing.
  expect(isLive(appArtifact('rev-1'), 'interactive')).toBe(true)
  await mount(APP_ENTRY)
  const dialog = await waitFor(() => box())
  const revision = await waitFor(() =>
    dialog.querySelector<HTMLElement>('[data-slot="app-revision"]'),
  )
  // The default view runs the pinned historical revision — a legitimate
  // reference the review preserves, not a second live session, and not referred
  // away.
  expect(revision.textContent).toContain('not saved')
  expect(buttonNamed(dialog, 'Open latest')).toBeDefined()
  expect(dialog.querySelector('[data-slot="artifact-referrer"]')).toBeNull()
}, 20_000)

test('"Open latest" refers to the answer\'s live App instead of mounting a second runtime', async () => {
  const pinned = appArtifact('rev-1')
  const latest = appArtifact('rev-2')
  readArtifactRevision.mockResolvedValue(pinned)
  readLatestArtifact.mockResolvedValue(latest)
  // The finding: "Open latest" switches to the same live interactive App the
  // conversation already runs inline.
  expect(isLive(pinned, 'interactive')).toBe(true)
  expect(isLive(latest, 'interactive')).toBe(true)
  await mount(APP_ENTRY)
  const dialog = await waitFor(() => box())
  await waitFor(() => dialog.querySelector('[data-slot="app-revision"]'))
  await click(buttonNamed(dialog, 'Open latest')!)
  // The discriminating assertion: after "Open latest" the cabinet holds the
  // answer's referrer, not a live DocumentApp of its own. Without the fix this
  // is what fails — the pinned frame is replaced by a second live runtime.
  const referrer = await waitFor(
    () => dialog.querySelector<HTMLElement>('[data-slot="artifact-referrer"]'),
    5_000,
  )
  expect(referrer.textContent).toContain('Open in answer')
  // Nothing live is mounted here: the pinned frame is gone and no App runtime,
  // its iframe, or its "Stop App" toolbar appears.
  expect(dialog.querySelector('[data-slot="app-revision"]')).toBeNull()
  expect(dialog.querySelector('iframe')).toBeNull()
  expect(buttonNamed(dialog, 'Stop App')).toBeUndefined()
  // The referrer still read the newest revision to recognize it as live, then
  // brought the answer forward rather than starting a runtime.
  expect(readLatestArtifact).toHaveBeenCalled()
}, 20_000)

test('a non-live artifact keeps its normal interactive body in the cabinet', async () => {
  readArtifactRevision.mockResolvedValue(documentArtifact())
  readLatestArtifact.mockResolvedValue(documentArtifact())
  expect(isLive(documentArtifact(), 'interactive')).toBe(false)
  await mount(DOC_ENTRY)
  const dialog = await waitFor(() => box())
  const heading = await waitFor(() => dialog.querySelector('h1'))
  expect(heading.textContent).toBe('Document')
  // A document has no "Open latest" affordance, so it never enters the
  // live-latest branch the fix added; keying that branch on isLive is what
  // keeps a non-live artifact on its normal path.
  expect(buttonNamed(dialog, 'Open latest')).toBeUndefined()
  expect(dialog.querySelector('[data-slot="artifact-referrer"]')).toBeNull()
  expect(dialog.querySelector('[data-slot="app-revision"]')).toBeNull()
}, 20_000)
