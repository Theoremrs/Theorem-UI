// SOURCING: Theorem's client operations (theorem-surface-contracts
// client_operation: a page declares operations in `clientOperations` on its
// send, each becomes a tool of the turn, a call streams a `client_operation`
// part in state `pending`, and the page answers with a
// `client-operation-receipt` command through @theoremharness/sdk's
// chat.runs.command), as the face's and Kit's operations use them;
// @assistant-ui/generative-ui's buildPresentParameters over the styled
// vocabulary for the model-facing schema, compacted to the server's 8 KB
// cap; @tanstack/react-query's MutationObserver retries a receipt that
// failed to post. The tree the model composes, or the A2UI surfaces it
// writes (a2ui.ts), is rendered by the installed generative-ui element, so
// the reply carries an interface, not just prose.
import type { ThreadMessage } from '@assistant-ui/react'
import { buildPresentParameters } from '@assistant-ui/generative-ui/react'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { styledGenerativeUILibrary } from '@/components/assistant-ui/elements/generative-ui'
import { hasStatus, mutate, theorem } from '@/lib/theorem/client'
import { presentation } from './a2ui'

/** The operation that paints a composed interface into the reply. */
export const PRESENT = 'ui.present'

/**
 * The model-facing schema, compacted to the server's 8 KB cap: the full
 * buildPresentParameters repeats every component's properties for nested
 * children (~39 KB). Here the vocabulary and each prop's shape are kept,
 * per-component guidance is a short hint on `_type`, and children recurse
 * as plain objects the renderer validates against the same vocabulary.
 */
function presentSchema(): Record<string, unknown> {
  const full = buildPresentParameters(styledGenerativeUILibrary) as {
    properties: Record<string, unknown>
  }
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'description' || key === 'title' || key === 'default') continue
        out[key] = strip(entry)
      }
      return out
    }
    return value
  }
  const typeProp = full.properties._type as { enum: string[] }
  const hints = typeProp.enum
    .map((name) => {
      const description =
        styledGenerativeUILibrary[name]?.description ?? ''
      return `${name}: ${(description.split('.')[0] ?? '').slice(0, 34)}`
    })
    .join(';')
  const properties = strip(full.properties) as Record<string, unknown>
  properties._type = { type: 'string', enum: typeProp.enum, description: hints }
  properties.children = {
    anyOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'object' } },
      { type: 'object' },
    ],
  }
  properties.a2ui = {
    type: 'array',
    items: { type: 'object' },
    description:
      'Each {"version":"v0.9", createSurface|updateComponents|updateDataModel}; components [{"id","component":"Type",...props}]',
  }
  return {
    type: 'object',
    properties,
    additionalProperties: true,
  }
}

const PRESENT_SCHEMA = presentSchema()

/**
 * What a turn declares so the agent can compose an interface in its reply.
 * One presentation operation; the tree is drawn by the generative-ui
 * element from the styled vocabulary.
 */
export const GENERATIVE_OPERATIONS = [
  {
    name: PRESENT,
    description:
      'Paints an interface into your reply. Pass a tree whose root `_type` names a component (headings, text, facts, cards, rows, columns, tables, lists, steps, timelines, charts, alerts, tabs, forms, inputs, buttons, images, diagrams, markdown, views) with its properties; `children` nests components or a string. Or pass `a2ui`: A2UI messages in any catalog; unknown components are drawn from their properties. Use it when a layout says more than prose. For an answer to explore, use `View`: `cells` are Observable JavaScript cells, sandboxed with no network, with d3, Plot, Inputs, `data` and `invalidation`. What the reader selects in `views` becomes context for their next question: `views.linked(rows, {x, y, id})`, `views.graph({nodes, links})`, `views.tree(root)`, `views.timeline(events, {start, end})`, `const k = view(views.param(Inputs.range([0, 1]), "k"))`. Add a `caption` when it helps; credit data and adapted notebooks in `source`; release WebGL in `invalidation`. Nothing outside the reply is changed.',
    effect: 'presentation',
    inputSchema: PRESENT_SCHEMA,
  },
] as const

export const generativeTurnOptions = () => ({
  clientOperations: [...GENERATIVE_OPERATIONS],
})

/** One present request a run made, read off a message. */
export interface PresentRequest {
  readonly runId: string
  readonly requestRef: string
  readonly args: Record<string, unknown>
  readonly expectedRevision: number
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * The present requests pending in the conversation's live turn. A reopened
 * conversation has no running turn, so nothing in history is painted again.
 */
export function presentRequestsOf(
  messages: readonly ThreadMessage[],
  running: boolean,
): Array<PresentRequest> {
  const last = messages.at(-1)
  if (!running || last?.role !== 'assistant') return []
  const runId = record(last.metadata.custom).theoremRunId
  if (typeof runId !== 'string') return []
  return last.content.flatMap((part) => {
    if (part.type !== 'data' || part.name !== 'theorem-client_operation')
      return []
    const data = record(part.data)
    const { requestRef, expectedRevision } = data
    if (
      (data.state ?? 'pending') !== 'pending' ||
      typeof requestRef !== 'string' ||
      data.operation !== PRESENT
    )
      return []
    return [
      {
        runId,
        requestRef,
        args: record(data.args),
        expectedRevision:
          typeof expectedRevision === 'number' ? expectedRevision : 0,
      },
    ]
  })
}

/** Whether the vocabulary draws a component itself. */
export const inVocabulary = (type: string) => Object.hasOwn(styledGenerativeUILibrary, type)

export interface PresentReceipt {
  readonly outcome: 'applied' | 'rejected' | 'failed'
  readonly reason?: string
  readonly result?: unknown
  readonly revision: number
}

function postReceipt(request: PresentRequest, receipt: PresentReceipt) {
  return mutate((headers) =>
    theorem().chat.runs.command({
      runId: request.runId,
      command: 'client-operation-receipt',
      requestRef: request.requestRef,
      receipt: { ...receipt },
      ...headers,
    }),
  )
}

const RECEIPT_RETRIES = 6
const receiptDelay = (failures: number) => Math.min(500 * 2 ** failures, 8_000)
const receipts = new QueryClient()
receipts.mount()
const served = new Set<string>()

/**
 * Answers each present request once: the tree is drawn by the part renderer
 * from the same args, so the receipt only says whether it could be painted.
 * A receipt that fails to post is sent again; the tree is not drawn twice.
 */
export function servePresentRequests(
  requests: ReadonlyArray<PresentRequest>,
  post: (
    request: PresentRequest,
    receipt: PresentReceipt,
  ) => Promise<unknown> = postReceipt,
  retryDelay: (failures: number) => number = receiptDelay,
): Promise<void> {
  const answered: Array<Promise<void>> = []
  for (const request of requests) {
    if (served.has(request.requestRef)) continue
    served.add(request.requestRef)
    answered.push(
      (async () => {
        // Anything the agent wrote is painted; what it is told back only
        // helps it fix its own output. Only a call with nothing to paint is
        // refused, with the reducer's warnings when it sent A2UI.
        const { painted, warnings } = presentation(request.args, inVocabulary)
        const receipt: PresentReceipt = painted.length
          ? {
              outcome: 'applied',
              result: {
                painted: painted.length === 1 ? painted[0] : painted,
                ...(warnings.length && { warnings }),
              },
              revision: request.expectedRevision,
            }
          : {
              outcome: 'rejected',
              reason: [
                'Pass a tree whose root `_type` names a component, or `a2ui` messages that create a surface with a root component.',
                ...warnings,
              ].join(' '),
              revision: request.expectedRevision,
            }
        await new MutationObserver(receipts, {
          mutationFn: (value: PresentReceipt) => post(request, value),
          retry: (failures, error) =>
            failures < RECEIPT_RETRIES && !hasStatus(error, 400, 404, 409, 422),
          retryDelay,
        })
          .mutate(receipt)
          .catch((error: unknown) => {
            console.warn('The page could not answer its present run', error)
          })
      })(),
    )
  }
  return Promise.all(answered).then(() => undefined)
}

/** For tests: forget which requests were served. */
export function resetPresentRequests() {
  served.clear()
}

/** The part of an assistant-ui thread runtime the present bridge reads. */
interface ThreadSource {
  readonly thread: {
    getState: () => {
      readonly messages: readonly ThreadMessage[]
      readonly isRunning: boolean
    }
    subscribe: (callback: () => void) => () => void
  }
}

/** Serves present requests from one conversation until unmounted. */
export function usePresentRequests(runtime: ThreadSource) {
  useEffect(() => {
    const serve = () => {
      const { messages, isRunning } = runtime.thread.getState()
      void servePresentRequests(presentRequestsOf(messages, isRunning))
    }
    serve()
    return runtime.thread.subscribe(serve)
  }, [runtime])
}
