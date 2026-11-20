// SOURCING: none — a small server-side metadata reader over the platform
// fetch/Response APIs. The link-preview element is props-only (it renders
// metadata, it does not fetch), so this resolves Open Graph / meta tags for
// the citation renderer, same-origin, with a bounded in-memory cache.
//
// Safety: only http(s) URLs with a public host are fetched (no localhost,
// loopback, link-local or private ranges — this route must not become an
// SSRF probe), redirects are followed manually and re-checked, the body is
// capped, and nothing but the extracted fields is returned.

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

async function fetchChecked(url: URL): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent':
          'Mozilla/5.0 (compatible; TheoremLinkPreview/1.0; +https://theorem.dev)',
      },
    })
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      const next = publicHttpUrl(
        new URL(response.headers.get('location')!, current).href,
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
    const type = response.headers.get('content-type') ?? ''
    if (response.ok && type.includes('html')) {
      const reader = response.body?.getReader()
      let text = ''
      if (reader) {
        const decoder = new TextDecoder()
        let bytes = 0
        for (;;) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          bytes += chunk.byteLength
          text += decoder.decode(chunk, { stream: true })
          if (bytes >= MAX_BYTES) break
        }
        await reader.cancel().catch(() => {})
      }
      const finalUrl = publicHttpUrl(response.url || url.href) ?? url
      const meta = extractMetadata(text, finalUrl)
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
