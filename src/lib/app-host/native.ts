// SOURCING: react-native-webview's page bridge (window.ReactNativeWebView.postMessage
// out, the native side's injectJavaScript calling window.__theoremAppHost in);
// TheoremError from @theoremharness/sdk so a refused native call reads like a
// refused web call (client.ts hasStatus).
//
// The App host page (routes/app-host.tsx) inside a native app's WebView. It has
// no session of its own: the native app holds the person's sign-in, so each
// Theorem call the page needs is asked of the native side, which makes it.
import { TheoremError } from '@theoremharness/sdk'
import type { AppDocuments } from '@/lib/theorem/apps'
import type { MutationHeaders } from '@/lib/theorem/client'
import type { AppAnswer } from '@/lib/blocks/app-operations'

/** What the native app tells the page. The phone keeps a copy of these shapes (mobile/src/features/apps/protocol.ts). */
export type FromNative =
  | {
      type: 'show'
      /** The revision's HTML, as its message part carries it. */
      html: string
      title: string
      documentId: string
      /** The revision's position in its document, when the part names one. */
      position?: string
    }
  | { type: 'check'; id: string; operation: string; args: Record<string, unknown> }
  | { type: 'reply'; id: string; ok: true; value: string }
  | { type: 'reply'; id: string; ok: false; status?: number; body?: unknown; message: string }

/** What the page tells the native app. */
export type ToNative =
  | { type: 'ready' }
  | { type: 'height'; height: number }
  | { type: 'checked'; id: string; answer: AppAnswer }
  | { type: 'call'; id: string; method: NativeMethod; args: string }

export type NativeMethod = 'documents.get' | 'documents.snapshot' | 'documents.revise'

interface NativeWindow {
  ReactNativeWebView?: { postMessage: (message: string) => void }
  __theoremAppHost?: (message: FromNative) => void
}
const native = () => window as unknown as NativeWindow

export const inNativeApp = () => typeof window !== 'undefined' && Boolean(native().ReactNativeWebView)

export function tellNative(message: ToNative) {
  native().ReactNativeWebView?.postMessage(JSON.stringify(message))
}

const waiting = new Map<string, { resolve: (value: string) => void; reject: (error: unknown) => void }>()

/** Listens for the native app; replies to calls are settled here, everything else goes to `listener`. */
export function listenToNative(listener: (message: Exclude<FromNative, { type: 'reply' }>) => void) {
  native().__theoremAppHost = (message) => {
    if (message.type !== 'reply') return listener(message)
    const call = waiting.get(message.id)
    if (!call) return
    waiting.delete(message.id)
    if (message.ok) call.resolve(message.value)
    else call.reject(new TheoremError({ message: message.message, statusCode: message.status, body: message.body }))
  }
  return () => {
    native().__theoremAppHost = undefined
  }
}

/** Arguments and results cross as JSON text; the native side keeps integers beyond the safe range exact. */
function callNative<T>(method: NativeMethod, args: unknown): Promise<T> {
  const id = crypto.randomUUID()
  return new Promise<string>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    tellNative({ type: 'call', id, method, args: JSON.stringify(args) })
  }).then((value) => JSON.parse(value) as T)
}

/** The Documents API, made by the native app as the person it signed in. */
export const nativeDocuments: AppDocuments = {
  get: (request) => callNative('documents.get', request),
  snapshot: (request) => callNative('documents.snapshot', request),
  revise: (request) => callNative('documents.revise', request),
}

/**
 * A write keyed once, as the web's mutate keys it. The CSRF token belongs to
 * the native app's session, so it fills it in; the key is kept.
 */
export function nativeChange<T>(run: (headers: MutationHeaders) => Promise<T>): Promise<T> {
  return run({ 'X-CSRF-Token': '', 'Idempotency-Key': crypto.randomUUID() })
}
