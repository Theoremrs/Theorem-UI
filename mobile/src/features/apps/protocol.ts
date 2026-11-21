// SOURCING: a copy of the message shapes in Theorem-UI src/lib/app-host/native.ts, the App host page's end; change both together

/** The answer to an App request, as the web's answerAppRequest gives it (src/lib/blocks/app-operations.ts AppAnswer). */
export type AppAnswer = {
  outcome: 'applied' | 'rejected' | 'failed'
  reason?: string
  result?: Record<string, unknown>
}

/** What the phone tells the App host page. */
export type ToHost =
  | { type: 'show'; html: string; title: string; documentId: string; position?: string }
  | { type: 'check'; id: string; operation: string; args: Record<string, unknown> }
  | { type: 'reply'; id: string; ok: true; value: string }
  | { type: 'reply'; id: string; ok: false; status?: number; body?: unknown; message: string }

export type HostMethod = 'documents.get' | 'documents.snapshot' | 'documents.revise'

/** What the App host page tells the phone. */
export type FromHost =
  | { type: 'ready' }
  | { type: 'height'; height: number }
  | { type: 'checked'; id: string; answer: AppAnswer }
  | { type: 'call'; id: string; method: HostMethod; args: string }

const METHODS = new Set<unknown>(['documents.get', 'documents.snapshot', 'documents.revise'])

/** A message from the page, or undefined for anything else it posts. */
export function readFromHost(text: string): FromHost | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const message = value as Partial<Record<string, unknown>> | null
  switch (message?.type) {
    case 'ready':
      return { type: 'ready' }
    case 'height':
      return typeof message.height === 'number' && message.height >= 0
        ? { type: 'height', height: message.height }
        : undefined
    case 'checked':
      return typeof message.id === 'string' && message.answer && typeof message.answer === 'object'
        ? { type: 'checked', id: message.id, answer: message.answer as AppAnswer }
        : undefined
    case 'call':
      return typeof message.id === 'string' && METHODS.has(message.method) && typeof message.args === 'string'
        ? { type: 'call', id: message.id, method: message.method as HostMethod, args: message.args }
        : undefined
    default:
      return undefined
  }
}

/** The JavaScript that hands the page one message. JSON is a JavaScript expression, so it is spliced in as it is. */
export const deliverScript = (message: string) =>
  `window.__theoremAppHost && window.__theoremAppHost(${message}); true;`
