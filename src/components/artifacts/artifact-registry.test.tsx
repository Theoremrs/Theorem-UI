import { afterEach, expect, spyOn, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { contribution, presentation } from '@/lib/artifacts/contributions'
import { BLOCK_SANDBOX } from '@/lib/blocks/executor'
import * as hosted from '@/lib/blocks/hosted-app'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { readArtifact } from './artifact-model'
import { PinnedAppFrame } from './app-revision-frame'
import {
  fileNameOf,
  isLive,
  representationOf,
  sourceOf,
  UI_CONTRIBUTIONS,
} from './artifact-registry'
import './artifact-renderers'

const PINNED =
  '<!doctype html><title>CPU vs GPU</title><meta name="description" content="Compares CPU cores and GPU lanes."><button data-entity-id="lane-1">Lane 1</button>'

function app(content = PINNED) {
  return readArtifact({
    artifactId: 'cpu-gpu',
    artifactRevision: '1',
    artifactKind: 'app',
    rendererId: 'theorem-app',
    lifecycle: 'ready',
    patchSequence: 1,
    payload: {
      documentId: 'cpu-gpu-doc',
      title: 'CPU vs GPU',
      revision: { position: 1, contentDigest: 'd1' },
      content,
      language: 'html',
    },
  })!
}

afterEach(cleanup)

test('an App has a passive thumbnail and a live representation for answers and workspaces', () => {
  expect(representationOf(app(), 'preview').renderer).toBe(
    'theorem-app.preview',
  )
  expect(isLive(app(), 'preview')).toBe(false)
  expect(representationOf(app(), 'interactive').renderer).toBe('theorem-app')
  expect(isLive(app(), 'interactive')).toBe(true)
})

test('a contribution whose renderer this build lacks falls to the Theorem card and says why', () => {
  const notebook = contribution('marimo.notebook', 'Notebook', {
    kinds: ['app'],
    presentations: [
      presentation('provider_native', 'marimo-notebook', ['thing']),
    ],
  })
  const shown = representationOf(app(), 'thing', [notebook])
  expect(shown.rung).toBe('theorem_card')
  expect(shown.passed[0]?.reason).toContain('no marimo-notebook renderer')
  // The UI's own contributions are valid and claim the App by kind.
  expect(UI_CONTRIBUTIONS.some((c) => c.id === 'theorem.app')).toBe(true)
})

test('an older revision hands over exactly the source its message pinned, without a document read', async () => {
  const fetch = spyOn(window, 'fetch')
  try {
    const source = sourceOf(app(), false)
    expect(source.noun).toBe('App source')
    expect(source.mediaType).toBe('text/html')
    expect(await source.load()).toBe(PINNED)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
})

test('the pinned frame runs the pinned source in the App sandbox and is inert as a preview', async () => {
  const originalHosted = hosted.hostedAppDocument
  const pages: string[] = []
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html, _esbuild, options) => {
      pages.push(html)
      return originalHosted(html, esbuild, options)
    },
  )
  const fetch = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () => Response.json({ detail: 'offline' }, { status: 503 }),
      { preconnect: window.fetch.preconnect },
    ),
  )
  try {
    const { container } = await render(
      <PinnedAppFrame artifact={app()} interactive={false} />,
    )
    const frame = await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(frame.getAttribute('sandbox')).toBe(BLOCK_SANDBOX)
    expect(frame.closest('[inert]')).not.toBeNull()
    // The document could not be read; the pinned source still renders.
    expect(pages).toEqual([PINNED])
  } finally {
    fetch.mockRestore()
    compile.mockRestore()
  }
}, 20_000)

const NETWORKED = `<!doctype html><title>Feed</title><meta name="theorem:uses" content='net("api.example.com")'><p>Feed</p>`

async function frameOf(interactive: boolean) {
  const originalHosted = hosted.hostedAppDocument
  const documents: string[] = []
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    async (html, _esbuild, options) => {
      const document = await originalHosted(html, esbuild, options)
      documents.push(document)
      return document
    },
  )
  const fetch = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () => Response.json({ detail: 'offline' }, { status: 503 }),
      { preconnect: window.fetch.preconnect },
    ),
  )
  try {
    const { container } = await render(
      <PinnedAppFrame artifact={app(NETWORKED)} interactive={interactive} />,
    )
    const frame = await waitFor(() => container.querySelector('iframe'), 10_000)
    const page = new DOMParser().parseFromString(documents[0]!, 'text/html')
    return {
      policy: page.querySelector('meta[http-equiv="Content-Security-Policy"]'),
      sandbox: frame.getAttribute('sandbox')?.split(' ') ?? [],
      allow: frame.getAttribute('allow') ?? '',
    }
  } finally {
    await cleanup()
    fetch.mockRestore()
    compile.mockRestore()
  }
}

test('a preview and the live frame both run the App open, on an origin of its own', async () => {
  for (const interactive of [false, true]) {
    const { policy, sandbox, allow } = await frameOf(interactive)
    expect(policy).toBeNull()
    expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-forms', 'allow-popups']))
    expect(sandbox).not.toContain('allow-same-origin')
    expect(allow).toContain('camera')
  }
}, 30_000)

function part(kind: string, language: string, title: string) {
  return readArtifact({
    artifactId: `${kind}-1`,
    artifactRevision: '1',
    artifactKind: kind,
    rendererId: `theorem-${kind}`,
    lifecycle: 'ready',
    patchSequence: 1,
    payload: { title, content: 'x', language },
  })!
}

test('a named kind keeps its own presentation whatever language its source is in', () => {
  // Markdown source shown as code stays code; the language is not a second kind.
  expect(
    representationOf(part('code', 'markdown', 'Notes'), 'thing').contribution,
  ).toBe('theorem.code')
  expect(
    representationOf(part('code', 'html', 'Page'), 'thing').contribution,
  ).toBe('theorem.code')
  // A part whose kind nothing claims is still recognized by its language.
  expect(
    representationOf(part('artifact', 'markdown', 'Notes'), 'thing')
      .contribution,
  ).toBe('theorem.document')
})

test('a download is named for the media type its contribution hands over', () => {
  expect(fileNameOf(app(), true)).toBe('cpu-vs-gpu.html')
  expect(fileNameOf(part('diagram', 'mermaid', 'Warp flow'), true)).toBe(
    'warp-flow.mmd',
  )
  expect(fileNameOf(part('document', 'markdown', 'Notes'), true)).toBe(
    'notes.md',
  )
  expect(fileNameOf(part('code', 'typescript', 'Lane sim'), true)).toBe(
    'lane-sim.ts',
  )
  expect(
    sourceOf(part('diagram', 'mermaid', 'Warp flow'), true).mediaType,
  ).toBe('text/vnd.mermaid')
})
