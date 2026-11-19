// SOURCING: crossws's createWebSocketProxy (the same library nitro's Bun
// adapter uses) and h3's defineWebSocketHandler, over the same OAuth session
// the fetch proxy reads. The browser opens a same-origin WebSocket; this
// upgrades it and dials Theorem's dictation endpoint with the person's bearer
// added here, never reaching the browser. Audio chunks and transcript events
// pass through untouched in both directions.
import { createWebSocketProxy } from 'crossws'
import { defineWebSocketHandler } from 'nitro/h3'
import type { CookieSerializeOptions } from 'cookie-es'
import { oauthConfigured, personBearer } from './theorem-auth'

/** The Theorem authority's dictation WebSocket, from the same base the fetch
 *  proxy uses, with the scheme switched to ws(s). */
function upstreamTarget(): string | undefined {
  const base = process.env.THEOREM_API_URL
  if (!base) return undefined
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api/chat/v1/dictation'
  url.search = ''
  return url.toString()
}

/** Read a cookie from the upgrade request's header, and keep any replacement
 *  iron-session writes (a refresh rotates the sealed cookie). The writes are
 *  collected so the upgrade response can carry them back to the browser; a
 *  reader that discards them would lose the rotated refresh token. */
function cookieJar(request: Request) {
  const header = request.headers.get('cookie') ?? ''
  const jar = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    jar.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()))
  }
  const writes: Array<{ name: string; value: string; options?: CookieSerializeOptions }> = []
  return {
    jar: {
      read: (name: string) => jar.get(name),
      write: (name: string, value: string, options?: CookieSerializeOptions) => {
        writes.push({ name, value, options })
      },
    },
    writes,
  }
}

/** Serialize a collected cookie write as a Set-Cookie header value. */
function setCookieValue(write: { name: string; value: string; options?: CookieSerializeOptions }): string {
  const opts = write.options ?? {}
  const parts = [`${write.name}=${encodeURIComponent(write.value)}`]
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(Number(opts.maxAge))}`)
  if (opts.expires instanceof Date) parts.push(`Expires=${opts.expires.toUTCString()}`)
  parts.push(`Path=${typeof opts.path === 'string' ? opts.path : '/'}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  if (opts.sameSite) parts.push(`SameSite=${String(opts.sameSite)}`)
  return parts.join('; ')
}

/** The bearer for this connection, read from the sealed session cookie the
 *  upgrade request carries, plus any rotated cookie to send back. Undefined
 *  when nobody is signed in. */
async function connectionBearer(request: Request): Promise<{
  token: string | undefined
  setCookie: string[]
}> {
  if (!oauthConfigured())
    return { token: process.env.THEOREM_API_TOKEN || undefined, setCookie: [] }
  const { jar, writes } = cookieJar(request)
  const token = await personBearer(jar)
  return { token, setCookie: writes.map(setCookieValue) }
}

const proxy = createWebSocketProxy({
  target: () => {
    const target = upstreamTarget()
    if (!target) throw new Error('Theorem backend is not configured')
    return target
  },
  headers: (peer) => ({
    authorization: `Bearer ${peer.context.bearer as string}`,
  }),
  // Dictation can pause between phrases; do not close an idle-but-live socket.
  clientIdleTimeout: 0,
})

// Resolve the bearer during the upgrade so a refreshed session's rotated
// cookie rides the 101 response back to the browser; the proxy's headers
// resolver reads the bearer from the peer context this sets.
export default defineWebSocketHandler({
  ...proxy,
  upgrade: async (request) => {
    const { token, setCookie } = await connectionBearer(request)
    const headers = new Headers()
    for (const value of setCookie) headers.append('set-cookie', value)
    if (!token) {
      return new Response('Sign in to Theorem to dictate', { status: 401, headers })
    }
    const proxied = await proxy.upgrade?.(request)
    if (proxied instanceof Response) return proxied
    const merged = new Headers(proxied?.headers)
    for (const [name, value] of headers) merged.append(name, value)
    return {
      ...proxied,
      headers: merged,
      context: { ...proxied?.context, bearer: token },
    }
  },
})
