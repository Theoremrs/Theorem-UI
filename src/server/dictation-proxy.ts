// SOURCING: crossws's createWebSocketProxy (the same library nitro's Bun
// adapter uses) and h3's defineWebSocketHandler, over the same OAuth session
// the fetch proxy reads. The browser opens a same-origin WebSocket; this
// upgrades it and dials Theorem's dictation endpoint with the person's bearer
// added here, never reaching the browser. Audio chunks and transcript events
// pass through untouched in both directions.
import { createWebSocketProxy } from 'crossws'
import { defineWebSocketHandler } from 'nitro/h3'
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

/** Read a cookie from the upgrade request's header. iron-session only needs
 *  a name→value reader; the sealed session cookie rides the same origin. */
function cookieReader(request: Request) {
  const header = request.headers.get('cookie') ?? ''
  const jar = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    jar.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()))
  }
  return {
    read: (name: string) => jar.get(name),
    write: () => {},
  }
}

/** The bearer for this connection, read from the sealed session cookie the
 *  upgrade request carries. Undefined when nobody is signed in. */
async function connectionBearer(request: Request): Promise<string | undefined> {
  if (!oauthConfigured()) return process.env.THEOREM_API_TOKEN || undefined
  return personBearer(cookieReader(request))
}

const proxy = createWebSocketProxy({
  // The target resolver may be async: resolve the bearer here (it can refresh
  // the session) and stash it for the sync headers resolver below.
  target: async (peer) => {
    const target = upstreamTarget()
    if (!target) throw new Error('Theorem backend is not configured')
    const token = await connectionBearer(peer.request)
    if (!token) throw new Error('Sign in to Theorem to dictate')
    peer.context.bearer = token
    return target
  },
  headers: (peer) => ({
    authorization: `Bearer ${peer.context.bearer as string}`,
  }),
  // Dictation can pause between phrases; do not close an idle-but-live socket.
  clientIdleTimeout: 0,
})

export default defineWebSocketHandler(proxy)
