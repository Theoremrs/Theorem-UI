// SOURCING: theorem-compute-serve's HTTP contract (POST /v1/call, GET
// /healthz, bearer credential; its CORS answer admits this page), read with the
// browser's fetch and AbortSignal.timeout; the pairing is kept in this
// browser's localStorage and shared through React's useSyncExternalStore.
// The server runs on the person's own machine, so only this browser can reach
// it: the pairing never goes to Theorem.
import { useSyncExternalStore } from 'react'

/** Where this browser reaches theorem-compute-serve on the person's machine. */
export interface MachinePairing {
  readonly url: string
  readonly token: string
}

const KEY = 'theorem.machine-compute'
const listeners = new Set<() => void>()
let cached: { raw: string | null; pairing: MachinePairing | undefined } = {
  raw: null,
  pairing: undefined,
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

const isPairing = (value: unknown): value is MachinePairing =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as MachinePairing).url === 'string' &&
  typeof (value as MachinePairing).token === 'string'

/** The pairing this browser keeps, if any. */
export function machinePairing(): MachinePairing | undefined {
  const raw = storage()?.getItem(KEY) ?? null
  if (raw === cached.raw) return cached.pairing
  let pairing: MachinePairing | undefined
  try {
    const value: unknown = raw ? JSON.parse(raw) : undefined
    pairing = isPairing(value) ? value : undefined
  } catch {
    pairing = undefined
  }
  cached = { raw, pairing }
  return pairing
}

/** A server address as fetch takes it: http(s), no trailing slash. */
export function normalUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return undefined
    return parsed.origin + parsed.pathname.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/** Keeps (or with `undefined`, forgets) the pairing, and tells every view. */
export function setMachinePairing(pairing: MachinePairing | undefined) {
  const store = storage()
  if (pairing) store?.setItem(KEY, JSON.stringify(pairing))
  else store?.removeItem(KEY)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  const other = (event: StorageEvent) => {
    if (event.key === KEY) listener()
  }
  window.addEventListener('storage', other)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', other)
  }
}

export function useMachinePairing(): MachinePairing | undefined {
  return useSyncExternalStore(subscribe, machinePairing, () => undefined)
}

/**
 * The pairing a link from theorem-compute-serve carries in the address's
 * fragment (`#machine=<url>&token=<token>`), which never reaches a server.
 */
export function pairingFromHash(hash: string): MachinePairing | undefined {
  const fields = new URLSearchParams(hash.replace(/^#/, ''))
  const url = normalUrl(fields.get('machine') ?? '')
  const token = fields.get('token') ?? ''
  return url && token.length >= 32 ? { url, token } : undefined
}

/** An answer the machine's server gave with an HTTP error, or no answer. */
export class MachineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** One call of the computation interface on the person's machine. */
export async function callMachine(
  pairing: MachinePairing,
  call: Record<string, unknown>,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(`${pairing.url}/v1/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new MachineError(
      `theorem-compute-serve at ${pairing.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON: the text itself is the answer.
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String(body.message)
        : text
    throw new MachineError(
      message || `HTTP ${response.status}`,
      response.status,
    )
  }
  return body
}
