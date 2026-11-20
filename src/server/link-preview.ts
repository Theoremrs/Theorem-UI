// SOURCING: Bun/Node resolve and dial an approved IP via node:http(s),
// preserving Host and SNI. Bun's fetch ignores undici's connect.lookup, so
// hostname checks alone cannot prevent DNS rebinding into a private network.
// Workers instead use their strictly public platform egress boundary; their
// node:http(s) shim cannot dial IP URLs with a separate SNI name.
//
// Every redirect is manually re-approved, and DNS/connect/body work shares a
// bounded deadline. Only bounded, extracted Open Graph fields are returned
// to the citation renderer, with a bounded in-memory cache.
import dns from 'node:dns/promises'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'

export interface LinkMetadata {
  href: string
  title?: string
  description?: string
  image?: string
  siteName?: string
  favicon?: string
}

const CACHE_MS = 30 * 60_000
const FAILURE_MS = 5 * 60_000
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 6_000
const MAX_REDIRECTS = 3
const MAX_ADDRESSES = 8

const cache = new Map<string, { at: number; value: LinkMetadata | null }>()

/** A hostname this server refuses to dial: loopback, private, link-local. */
function blockedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name === 'metadata.google.internal'
  )
    return true
  // IPv4 literals in the private/loopback/link-local ranges.
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
      return true
  }
  if (name.includes(':')) {
    // Normalize expanded/mapped IPv6 and cover the whole link-local prefix,
    // not just addresses whose first hextet happens to be exactly fe80.
    let bare: string
    try {
      bare = new URL(
        `http://[${name.replace(/^\[|\]$/g, '')}]/`,
      ).hostname.replace(/^\[|\]$/g, '')
    } catch {
      return true
    }
    const first = parseInt(bare.split(':')[0] || '0', 16)
    if (
      bare === '::1' ||
      bare === '::' ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0 ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xff00) === 0xff00 ||
      bare.startsWith('::ffff:')
    )
      return true
  }
  return false
}

export function publicHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (blockedHost(url.hostname)) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Whether one resolved address is public (not loopback/private/link-local). */
export function publicAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 0) return false
  // Reuse the literal guard by feeding the address as a URL host.
  const host = family === 6 ? `[${address}]` : address
  return !blockedHost(host)
}

/** Stop waiting for DNS at the shared deadline. Native lookup cannot be
 *  cancelled, so discard any late answer without opening a connection. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

/** Resolve a host and return its public addresses; throws if none are public. */
async function approvedAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted()
  // URL.hostname includes brackets around IPv6 literals; DNS does not.
  const name = hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(name)) {
    if (!publicAddress(name)) throw new Error('address refused')
    return [name]
  }
  const records = await abortable(
    dns.lookup(name, { all: true, verbatim: true }),
    signal,
  )
  const addresses = records
    .map((record) => record.address)
    .filter(publicAddress)
    .slice(0, MAX_ADDRESSES)
  if (addresses.length === 0) throw new Error('no public address')
  return addresses
}

interface PinnedResponse {
  status: number
  headers: Record<string, string>
  body: string
  url: string
}

/** GET one URL by connecting to an approved IP, with the name kept for Host
 *  and SNI. Reads at most MAX_BYTES. Redirects are not followed here. */
function fetchPinned(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const secure = url.protocol === 'https:'
    const mod = secure ? https : http
    let request: http.ClientRequest | undefined
    let response: http.IncomingMessage | undefined
    let settled = false
    let releaseResponseListeners: (() => void) | undefined
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      releaseResponseListeners?.()
      releaseResponseListeners = undefined
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
      // A deadline rejects the promise AND releases its active connection.
      // Keep error handlers attached for errors emitted during destruction.
      response?.destroy()
      request?.destroy()
    }
    const abort = () => fail(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      request = mod.request(
        {
          host: address,
          port: url.port || (secure ? 443 : 80),
          servername: net.isIP(url.hostname.replace(/^\[|\]$/g, ''))
            ? undefined
            : url.hostname,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            host: url.host,
            accept: 'text/html,application/xhtml+xml',
            'user-agent':
              'Mozilla/5.0 (compatible; TheoremLinkPreview/1.0; +https://theorem.dev)',
          },
        },
        (incoming) => {
          response = incoming
          incoming.on('error', fail)
          if (settled) {
            incoming.destroy()
            return
          }
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(incoming.headers))
            if (typeof value === 'string') headers[name] = value
          const chunks: Buffer[] = []
          let bytes = 0
          const finish = () => {
            if (settled) return
            settled = true
            cleanup()
            resolve({
              status: incoming.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              url: url.href,
            })
          }
          const data = (chunk: Buffer) => {
            const bounded = chunk.subarray(0, MAX_BYTES - bytes)
            chunks.push(bounded)
            bytes += bounded.byteLength
            if (bytes >= MAX_BYTES) {
              finish()
              incoming.destroy()
              request?.destroy()
            }
          }
          const close = () =>
            fail(new Error('response closed before completion'))
          releaseResponseListeners = () => {
            incoming.off('data', data)
            incoming.off('end', finish)
            incoming.off('close', close)
          }
          incoming.on('data', data)
          incoming.on('end', finish)
          incoming.on('close', close)
        },
      )
      request.on('error', fail)
      request.end()
    } catch (error) {
      fail(error)
    }
  })
}

/** Workers cannot dial arbitrary IP URLs through node:http(s), and their
 *  HTTPS shim does not support a separate SNI name. Use the platform's public
 *  egress boundary instead: vite.config.ts enables global_fetch_strictly_public.
 *  This is selected only by the documented Workers runtime identity, never as
 *  a fallback when a pinned Bun/Node connection fails.
 *
 *  https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
 *  https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-navigator
 */
function workersRuntime(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.userAgent === 'Cloudflare-Workers'
  )
}

async function fetchPublicWorker(
  url: URL,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  signal.throwIfAborted()
  const response = await fetch(url.href, {
    redirect: 'manual',
    credentials: 'omit',
    signal,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent':
        'Mozilla/5.0 (compatible; TheoremLinkPreview/1.0; +https://theorem.dev)',
    },
  })
  const reader = response.body?.getReader()
  const cancel = () => {
    // Cancelling a reader also releases the platform's active fetch connection.
    // Do not let a slow cancellation extend the request deadline.
    void reader?.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) {
      while (bytes < MAX_BYTES) {
        const { done, value } = await abortable(reader.read(), signal)
        signal.throwIfAborted()
        if (done) break
        const bounded = value.subarray(0, MAX_BYTES - bytes)
        chunks.push(bounded)
        bytes += bounded.byteLength
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.concat(chunks).toString('utf8'),
      url: url.href,
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader?.releaseLock()
  }
}

const entity = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .trim()

/** One meta tag's content, by property or name, from the head's HTML. */
function metaOf(html: string, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`,
      'i',
    )
    const tag = html.match(pattern)?.[0]
    if (!tag) continue
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1]
    if (content) return entity(content)
  }
  return undefined
}

function linkHref(html: string, rel: string): string | undefined {
  const tags = html.match(/<link[^>]+>/gi) ?? []
  for (const tag of tags) {
    const rels = tag.match(/rel\s*=\s*["']([^"']*)["']/i)?.[1] ?? ''
    if (!rels.toLowerCase().split(/\s+/).includes(rel)) continue
    const href = tag.match(/href\s*=\s*["']([^"']*)["']/i)?.[1]
    if (href) return entity(href)
  }
  return undefined
}

const absolute = (base: URL, value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    const url = new URL(value, base)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

/** The metadata one HTML document carries, against the URL it came from. */
export function extractMetadata(html: string, base: URL): LinkMetadata {
  const head = html.slice(0, 200_000)
  const title =
    metaOf(head, 'og:title', 'twitter:title') ??
    (entity(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') ||
      undefined)
  const description =
    metaOf(head, 'og:description', 'twitter:description', 'description') ??
    undefined
  const image = absolute(
    base,
    metaOf(head, 'og:image:secure_url', 'og:image', 'twitter:image'),
  )
  const siteName = metaOf(head, 'og:site_name', 'application-name') ?? undefined
  const favicon =
    absolute(
      base,
      linkHref(head, 'icon') ??
        linkHref(head, 'shortcut') ??
        linkHref(head, 'apple-touch-icon'),
    ) ?? absolute(base, '/favicon.ico')
  return {
    href: base.href,
    ...(title && { title: title.slice(0, 300) }),
    ...(description && { description: description.slice(0, 500) }),
    ...(image && { image }),
    ...(siteName && { siteName: siteName.slice(0, 120) }),
    ...(favicon && { favicon }),
  }
}

/** Re-approve every redirect. Bun/Node pin each dial to an approved address;
 *  Workers enforce public-only egress at the platform network boundary. */
async function fetchChecked(url: URL): Promise<PinnedResponse> {
  const controller = new AbortController()
  // One elapsed-time budget includes DNS, address retries, every redirect,
  // TLS connection and body. A socket idle timeout alone permits slow drips.
  const deadline = setTimeout(
    () => controller.abort(new Error('link preview timed out')),
    TIMEOUT_MS,
  )
  const { signal } = controller
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await approvedAddresses(current.hostname, signal)
      let response: PinnedResponse | undefined
      let lastError: unknown
      if (workersRuntime()) {
        response = await fetchPublicWorker(current, signal)
      } else {
        for (const address of addresses) {
          try {
            response = await fetchPinned(current, address, signal)
            break
          } catch (error) {
            signal.throwIfAborted()
            lastError = error
          }
        }
      }
      if (!response) throw lastError ?? new Error('connect failed')
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.location
      ) {
        const next = publicHttpUrl(
          new URL(response.headers.location, current).href,
        )
        if (!next) throw new Error('redirect refused')
        current = next
        continue
      }
      return response
    }
    throw new Error('too many redirects')
  } finally {
    clearTimeout(deadline)
  }
}

/** Resolve one URL's preview metadata; null when it cannot be read. */
export async function resolveLinkMetadata(
  href: string,
): Promise<LinkMetadata | null> {
  const url = publicHttpUrl(href)
  if (!url) return null
  const cached = cache.get(url.href)
  if (cached && Date.now() - cached.at < (cached.value ? CACHE_MS : FAILURE_MS))
    return cached.value
  let value: LinkMetadata | null = null
  try {
    const response = await fetchChecked(url)
    const type = response.headers['content-type'] ?? ''
    if (
      response.status >= 200 &&
      response.status < 300 &&
      type.includes('html')
    ) {
      const finalUrl = publicHttpUrl(response.url) ?? url
      const meta = extractMetadata(response.body, finalUrl)
      // A page with no title at all is not a preview worth drawing.
      if (meta.title || meta.description || meta.image) value = meta
    }
  } catch {
    value = null
  }
  cache.set(url.href, { at: Date.now(), value })
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  return value
}

/** GET /api/link-preview/v1?url=… — metadata, or 404 with a plain reason. */
export async function linkPreviewHandler({
  request,
}: {
  request: Request
}): Promise<Response> {
  const href = new URL(request.url).searchParams.get('url')
  if (!href || !publicHttpUrl(href))
    return Response.json(
      { error: 'A public http(s) url query parameter is required.' },
      { status: 400 },
    )
  const metadata = await resolveLinkMetadata(href)
  if (!metadata)
    return Response.json(
      { error: 'No preview metadata could be read for this URL.' },
      { status: 404 },
    )
  return Response.json(metadata, {
    headers: { 'cache-control': 'private, max-age=1800' },
  })
}
