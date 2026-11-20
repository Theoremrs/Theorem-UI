// SOURCING: node:dns/promises + node:https/http to dial a resolved, approved
// address directly (Bun's native fetch ignores undici's connect.lookup, so a
// hostname check alone is not enough — a public name can resolve to a
// private IP). The link-preview element is props-only; this resolves Open
// Graph / meta tags for the citation renderer, same-origin, with a bounded
// in-memory cache.
//
// Safety: every hop resolves the host, refuses any non-public address, and
// connects to the exact approved IP (Host header + SNI keep the name), so a
// DNS rebinding between check and connect cannot reach an internal page.
// Redirects are followed manually and re-checked the same way; the body is
// capped; nothing but the extracted fields is returned.
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
  // IPv6 literals (URL hosts keep the brackets off here).
  if (name.includes(':')) {
    const bare = name.replace(/^\[|\]$/g, '')
    if (
      bare === '::1' ||
      bare === '::' ||
      bare.startsWith('fe80') ||
      bare.startsWith('fc') ||
      bare.startsWith('fd') ||
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

/** Resolve a host and return its public addresses; throws if none are public. */
async function approvedAddresses(hostname: string): Promise<string[]> {
  // A literal IP needs no DNS; check it directly.
  if (net.isIP(hostname)) {
    if (!publicAddress(hostname)) throw new Error('address refused')
    return [hostname]
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
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
function fetchPinned(url: URL, address: string): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:'
    const mod = secure ? https : http
    const request = mod.request(
      {
        host: address,
        port: url.port || (secure ? 443 : 80),
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          host: url.host,
          accept: 'text/html,application/xhtml+xml',
          'user-agent':
            'Mozilla/5.0 (compatible; TheoremLinkPreview/1.0; +https://theorem.dev)',
        },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === 'string') headers[name] = value
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes <= MAX_BYTES) chunks.push(chunk)
          if (bytes >= MAX_BYTES) response.destroy()
        })
        const finish = () =>
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
            url: url.href,
          })
        response.on('end', finish)
        response.on('close', finish)
        response.on('error', reject)
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end()
  })
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

/** Fetch one URL, resolving and approving the address at every hop and
 *  connecting to that exact IP. Redirects are followed manually (max
 *  MAX_REDIRECTS) and re-approved the same way. */
async function fetchChecked(url: URL): Promise<PinnedResponse> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const addresses = await approvedAddresses(current.hostname)
    let response: PinnedResponse | undefined
    let lastError: unknown
    for (const address of addresses) {
      try {
        response = await fetchPinned(current, address)
        break
      } catch (error) {
        lastError = error
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
    if (response.status >= 200 && response.status < 300 && type.includes('html')) {
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
