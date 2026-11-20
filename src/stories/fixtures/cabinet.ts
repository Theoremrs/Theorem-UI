// SOURCING: none: the stored artifact parts behind the cabinet story's outputs, in the SDK's own message shape. The cabinet reads a card's source by asking its thread for the part with the output's artifact id and revision (components/cabinet/catalog readArtifactRevision), so each output the route map lists has its part here.
import type { Theorem } from '@/lib/theorem/client'

type CabinetArtifact = {
  /** The output this part stands behind. */
  outputId: string
  threadId: string
  kind: 'app' | 'document' | 'diagram'
  title: string
  language: string
  content: string
}

/** The revision every cabinet output names, and its part carries. */
export const cabinetRevision = (outputId: string) => `rev-${outputId}`

const APP = `<!doctype html><title>Gallery prototype</title><meta name="description" content="Two ways to browse the apps built so far."><main><h1>Gallery</h1><button>Grid</button> <button>List</button></main>`

export const CABINET_ARTIFACTS: readonly CabinetArtifact[] = [
  { outputId: 'output-1', threadId: 'thread-app-gallery', kind: 'app', title: 'Gallery prototype', language: 'html', content: APP },
  {
    outputId: 'output-2',
    threadId: 'thread-python-sdk',
    kind: 'document',
    title: 'SDK surface',
    language: 'markdown',
    content:
      '# SDK surface\n\nThe Python client mirrors the TypeScript one, one method per route.\n\n## Calls\n\n- `threads.get` reads a thread and its stored parts\n- `outputs.list` pages a project\'s outputs\n- `uploads.content` streams an upload\n\nEvery call returns the typed record the server sent.\n',
  },
  {
    outputId: 'output-4',
    threadId: 'thread-python-sdk',
    kind: 'document',
    title: 'Survey notes',
    language: 'markdown',
    content:
      '# Survey notes\n\nThree readers tried the client against a fresh project.\n\n1. Install took one command.\n2. The first call needed a token, and the error said so.\n3. Paging was the part they asked about.\n',
  },
  {
    outputId: 'output-5',
    threadId: 'thread-app-gallery',
    kind: 'diagram',
    title: 'Headland map',
    language: 'mermaid',
    content: 'flowchart LR\n  harbor --> headland\n  headland --> lighthouse\n  headland --> cove\n',
  },
  {
    outputId: 'output-6',
    threadId: 'thread-python-sdk',
    kind: 'document',
    title: 'Release checklist',
    language: 'markdown',
    content:
      '# Release checklist\n\n- [x] Changelog written\n- [x] Version bumped\n- [ ] Wheels built for every platform\n- [ ] Tag pushed\n',
  },
]

/** The card line Theorem's cabinet catalog sends with each output (a ProjectOutput description). */
export const CABINET_DESCRIPTIONS: Readonly<Record<string, { text: string; provenance: 'authored' | 'metadata' | 'derived' }>> = {
  'output-1': { text: 'A prototype that browses the apps built so far as a grid or a list.', provenance: 'derived' },
  'output-2': { text: 'The Python client mirrors the TypeScript one, one method per route.', provenance: 'derived' },
  'output-3': { text: 'Two gallery layouts offered for a choice.', provenance: 'derived' },
  'output-4': { text: 'Three readers tried the client against a fresh project.', provenance: 'derived' },
  'output-5': { text: 'A route from the harbor past the headland to the lighthouse and the cove.', provenance: 'derived' },
  'output-6': { text: 'Release steps, two of four done.', provenance: 'derived' },
}

const RENDERER = { app: 'theorem-app', document: 'theorem-document', diagram: 'theorem-diagram' } as const

const part = (a: CabinetArtifact): Theorem.StoredPart => ({
  partId: `part-${a.outputId}`,
  type: 'artifact',
  payload: {
    artifactId: a.outputId,
    artifactRevision: cabinetRevision(a.outputId),
    artifactKind: a.kind,
    rendererId: RENDERER[a.kind],
    contractVersion: 'theorem-artifact-v1',
    lifecycle: 'ready',
    patchSequence: 1,
    fallbackText: a.title,
    payload: {
      documentId: `doc-${a.outputId}`,
      revision: { position: 1 },
      title: a.title,
      content: a.content,
      language: a.language,
    },
  },
})

/** The assistant message in a thread that holds its cabinet artifacts, or none. */
export function cabinetMessages(threadId: string, now: number): Theorem.Message[] {
  const parts = CABINET_ARTIFACTS.filter((a) => a.threadId === threadId).map(part)
  return parts.length === 0
    ? []
    : [
        {
          schema: 'theorem.chat.message.v1',
          messageId: `message-cabinet-${threadId}`,
          tenantId: 'story',
          threadId,
          originBranchId: 'branch-main',
          role: 'assistant',
          parts,
          createdAtMs: now - 6 * 60 * 60_000,
        },
      ]
}
