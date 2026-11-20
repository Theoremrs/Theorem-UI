// SOURCING: the existing CRM fixture, record-links.test.tsx's receipt contract,
// and the CRM test-harness memory router. Real About UI; synthetic transport only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { createRoot } from 'react-dom/client'
import { createFixtureServer, fixtureFetch } from '@/components/crm/fixture'
import type { ObjectType } from '@/components/records/contract'
import type {
  RecordFilingCorrection,
  RecordFilingHistory,
  RecordFilingReceipt,
} from '@/components/index/contract'
import { RecordLinks } from '@/components/index/record-links'
import '@/styles.css'

const documentId = 'doc:research-source-fixture'
const type: ObjectType = {
  object_type_id: 'objtype:demo:researchquestion',
  tenant_id: 'demo',
  name_singular: 'ResearchQuestion',
  name_plural: 'ResearchQuestions',
  label_singular: 'Research question',
  label_plural: 'Research questions',
  node_label: 'ResearchQuestion',
  label_identifier_field: 'question',
  fields: [
    {
      key: 'question',
      label: 'Question',
      field_type: { kind: 'text' },
      required: true,
      system: false,
    },
  ],
  enforcement: 'warn',
  system: false,
  content_anchor: 'anchor:research-question:1',
}
const target = {
  id: 'question:throughput',
  labels: ['ResearchQuestion'],
  properties: { question: 'When does this method improve throughput?' },
  version: 1,
}
const original: RecordFilingReceipt = {
  schema: 'theorem-document/2',
  documentId,
  receiptId: 'r1',
  recordItemId: 'record:Person/person:noor',
  recordId: 'person:noor',
  nameSingular: 'Person',
  title: 'Noor',
  tier: 'learned',
  attribution: { kind: 'name_mention', where: 'text', tokens: ['noor'] },
  confidence: 0.55,
  actor: { kind: 'engine' },
  lowConfidence: false,
  generation: 1,
}
let history: RecordFilingHistory = {
  schema: 'theorem-document/2',
  documentId,
  receipts: [original],
  links: [original],
  corrections: [],
}
const server = createFixtureServer()
server.state.types.push(type)
server.state.nodes.push(target)
const records = fixtureFetch(server)
const writes: { path: string; body: Record<string, unknown> }[] = []
const reads: { objectTypeId: string; input: unknown }[] = []

// All application fetches are answered in memory. No route falls through to a
// real API. The runner independently blocks requests outside this loopback host.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  ).pathname
  const body = init?.body
    ? (JSON.parse(String(init.body)) as Record<string, unknown>)
    : {}
  if (path.endsWith('/record-filings') && init?.method !== 'POST')
    return Response.json(history)
  if (path === '/api/documents/v2/record-filings/r1/corrections') {
    if (body.recordItemId !== 'record:ResearchQuestion/question:throughput')
      throw new Error('The fixture accepts only its declared research target.')
    writes.push({ path, body })
    const correction: RecordFilingCorrection = {
      schema: 'theorem-document/2',
      correctionId: 'c1',
      receiptId: 'r1',
      documentId,
      fromRecordItemId: original.recordItemId,
      toRecordItemId: String(body.recordItemId),
      actor: { kind: 'human', actorId: 'fixture-person' },
      generation: 2,
      undo: false,
      undone: false,
    }
    const moved: RecordFilingReceipt = {
      ...original,
      receiptId: 'r2',
      recordItemId: String(body.recordItemId),
      recordId: target.id,
      nameSingular: type.name_singular,
      title: target.properties.question,
      tier: 'precedent',
      confidence: 1,
      generation: 2,
      attribution: {
        kind: 'correction',
        actor: { kind: 'human', actorId: 'fixture-person' },
      },
    }
    history = {
      ...history,
      receipts: [original, moved],
      links: [moved],
      corrections: [correction],
    }
    return Response.json({ ...correction, receipt: moved }, { status: 201 })
  }
  if (path === '/api/documents/v2/record-filing-corrections/c1/undo') {
    writes.push({ path, body })
    const undone: RecordFilingCorrection = {
      schema: 'theorem-document/2',
      correctionId: 'c2',
      receiptId: 'r1',
      documentId,
      fromRecordItemId: 'record:ResearchQuestion/question:throughput',
      toRecordItemId: original.recordItemId,
      actor: { kind: 'human', actorId: 'fixture-person' },
      generation: 3,
      undo: true,
      undone: false,
    }
    history = {
      ...history,
      links: [original],
      corrections: [
        ...history.corrections.map((c) => ({ ...c, undone: true })),
        undone,
      ],
    }
    return Response.json(undone, { status: 201 })
  }
  if (path === '/graphql') {
    const raw =
      input instanceof Request
        ? await input.clone().text()
        : String(init?.body ?? '{}')
    const request = JSON.parse(raw)
    if (request.variables?.verb) {
      if (request.variables.verb !== 'find_many')
        throw new Error('Unexpected record write in browser fixture.')
      reads.push({
        objectTypeId: request.variables.objectTypeId,
        input: request.variables.input,
      })
    }
  }
  return records(input, init)
}) as typeof fetch

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle(
  'dark',
  params.get('theme') === 'dark',
)
const DisplayedRecordLinks = params.has('baseline')
  ? (
      await import(
        /* @vite-ignore */ new URL('./baseline.generated.tsx', import.meta.url)
          .href
      )
    ).RecordLinks
  : RecordLinks
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})
function Subject() {
  return (
    <main className="min-h-screen bg-surface-neutral p-10 text-ink">
      <div className="max-w-2xl space-y-6">
        <header className="space-y-2">
          <p className="text-xs text-ink-muted">
            Synthetic fixture · no live service
          </p>
          <h1 className="text-xl font-semibold">Research source</h1>
          <p className="text-sm text-ink-muted">
            Correct the record this document is about.
          </p>
        </header>
        <div className="rounded-xl border border-separator bg-surface p-5">
          <DisplayedRecordLinks documentId={documentId} />
        </div>
      </div>
    </main>
  )
}
const root = createRootRoute({ component: Subject })
const index = createRoute({
  getParentRoute: () => root,
  path: '/index',
  component: () => null,
})
const router = createRouter({
  routeTree: root.addChildren([index]),
  history: createMemoryHistory({ initialEntries: ['/index'] }),
})
await router.load()
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router as never} />
  </QueryClientProvider>,
)
Object.assign(window, {
  recordLinksEvidence: () => ({ writes, reads, history, record: target }),
})
