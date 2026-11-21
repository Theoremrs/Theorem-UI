// Pure metadata/SSRF checks plus deterministic DNS and stream lifecycle tests.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from 'bun:test'
import type { Mock } from 'bun:test'
import type { LookupAddress, LookupAllOptions } from 'node:dns'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import https from 'node:https'
import {
  extractMetadata,
  publicAddress,
  publicHttpUrl,
  resolveLinkMetadata,
} from './link-preview'

describe('publicHttpUrl', () => {
  test('admits public http(s) URLs', () => {
    expect(publicHttpUrl('https://example.com/page')?.href).toBe(
      'https://example.com/page',
    )
    expect(publicHttpUrl('http://react.dev/learn')?.href).toBe(
      'http://react.dev/learn',
    )
  })

  test('refuses script protocols, relative paths and non-URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,bad',
      'file:///etc/passwd',
      '//example.com',
      '/relative',
      'not a URL',
      '',
    ])
      expect(publicHttpUrl(value)).toBeUndefined()
  })

  test('refuses loopback, private and link-local hosts', () => {
    for (const value of [
      'http://localhost:8080/x',
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://172.16.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/x',
      'http://[::1]/x',
      'http://[fe80::1]/x',
      'http://[fe90::1]/x',
      'http://[febf::1]/x',
      'http://[fec0::1]/x',
      'http://[ff02::1]/x',
      'http://[fd00::1]/x',
      'http://metadata.google.internal/x',
      'http://printer.local/x',
    ])
      expect(publicHttpUrl(value)).toBeUndefined()
  })
})

describe('publicAddress', () => {
  test('admits public IPv4 and IPv6', () => {
    expect(publicAddress('93.184.215.14')).toBe(true)
    expect(publicAddress('2606:4700:10::6814:179a')).toBe(true)
  })

  test('refuses loopback, private, link-local and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fe90::1',
      'febf::1',
      'fec0::1',
      'ff02::1',
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:ffff:7f00:1',
      'fc00::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ])
      expect(publicAddress(address)).toBe(false)
  })
})

describe('special-purpose IPv4 addresses', () => {
  test('refuses benchmarking and non-global protocol/documentation ranges as addresses and URLs', () => {
    for (const address of [
      '198.18.0.0',
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.0',
      '192.0.0.8',
      '192.0.0.11',
      '192.0.0.255',
      '192.0.2.0',
      '192.0.2.255',
      '198.51.100.0',
      '198.51.100.255',
      '203.0.113.0',
      '203.0.113.255',
    ]) {
      expect(publicAddress(address)).toBe(false)
      expect(publicHttpUrl(`http://${address}/`)).toBeUndefined()
    }
  })

  test('keeps adjacent public ranges and the public protocol anycast exceptions', () => {
    for (const address of [
      '198.17.255.255',
      '198.20.0.0',
      '192.0.0.9',
      '192.0.0.10',
      '192.0.1.255',
      '192.0.3.0',
      '198.51.99.255',
      '198.51.101.0',
      '203.0.112.255',
      '203.0.114.0',
    ]) {
      expect(publicAddress(address)).toBe(true)
      expect(publicHttpUrl(`https://${address}/`)).toBeDefined()
    }
  })
})

describe('extractMetadata', () => {
  const base = new URL('https://example.com/page')

  test('reads Open Graph fields, resolving relative images and icons', () => {
    const html = `<html><head>
      <meta property="og:title" content="A &amp; B">
      <meta property="og:description" content="About things.">
      <meta property="og:image" content="/img/card.png">
      <meta property="og:site_name" content="Example">
      <link rel="icon" href="/favicon.png">
    </head></html>`
    expect(extractMetadata(html, base)).toEqual({
      href: base.href,
      title: 'A & B',
      description: 'About things.',
      image: 'https://example.com/img/card.png',
      siteName: 'Example',
      favicon: 'https://example.com/favicon.png',
    })
  })

  test('bounds malformed tag scans without repeatedly rescanning the remaining head', () => {
    for (const tag of ['meta', 'link', 'title']) {
      const html = `<${tag} `.repeat(6_000)
      const started = performance.now()
      const metadata = extractMetadata(html, base)
      const elapsed = performance.now() - started
      expect(metadata.title).toBeUndefined()
      // The former repeated regex scan takes about 1.8 seconds for <meta.
      // A generous CPU budget permits slow CI while rejecting quadratic work.
      expect(elapsed).toBeLessThan(750)
    }
  })

  test('preserves matching quote boundaries and metadata priority regardless of attribute order', () => {
    const html = `<title>Fallback title</title>
      <META CONTENT='Twitter "fallback"' NAME="twitter:title">
      <meta content="O'Reilly > books" property='og:title'>
      <meta property="og:title" content="Later duplicate">
      <meta name="description" content='A "quoted" description'>
      <link href="/search?q=it's" rel="shortcut icon">
      <link rel="apple-touch-icon" href="/apple.png">`
    const metadata = extractMetadata(html, base)
    expect(metadata.title).toBe("O'Reilly > books")
    expect(metadata.description).toBe('A "quoted" description')
    expect(metadata.favicon).toBe(new URL("/search?q=it's", base).href)
  })

  test('replaces invalid numeric entities without losing valid metadata', () => {
    const metadata = extractMetadata(
      '<meta property="og:title" content="A &#x110000; &#99999999999999999999999; &#xD800; &#0; &#128512; &#x1F642;">',
      base,
    )
    expect(metadata.title).toBe('A \uFFFD \uFFFD \uFFFD \uFFFD 😀 🙂')
  })

  test('ignores apparent metadata inside comments and raw text', () => {
    const metadata = extractMetadata(
      `<!-- <meta property="og:title" content="Comment"> -->
      <script>const example = '<meta property="og:title" content="Script">'</script>
      <style>/* <meta property="og:title" content="Style"> */</style>
      <title>Literal &lt;meta&gt; title</title>
      <meta name="description" content="Real description">`,
      base,
    )
    expect(metadata.title).toBe('Literal <meta> title')
    expect(metadata.description).toBe('Real description')
  })

  test('ignores nested template metadata and resumes reading the document after it closes', () => {
    const metadata = extractMetadata(
      `<head><template>
        <title>Template title</title>
        <meta property="og:title" content="Template Open Graph title">
        <template>
          <meta name="description" content="Nested template description">
        </template>
        <meta property="og:image" content="/template.png">
        <meta property="og:site_name" content="Template site">
        <link rel="icon" href="/template.ico">
        <script>const example = '</template><meta property="og:title" content="Script title">';</script>
        <!-- </template> -->
        <meta name="description" content="Still inside the template">
      </template>
      <title>Document title</title>
      <meta name="description" content="Document description">
      <link rel="icon" href="/document.ico">
      </head>`,
      base,
    )
    expect(metadata).toEqual({
      href: base.href,
      title: 'Document title',
      description: 'Document description',
      favicon: 'https://example.com/document.ico',
    })
  })

  test('an unclosed template cannot contribute fallback document metadata', () => {
    const metadata = extractMetadata(
      '<template><title>Template title</title><meta name="description" content="Template description">',
      base,
    )
    expect(metadata.title).toBeUndefined()
    expect(metadata.description).toBeUndefined()
  })

  test('limits extraction to the first 200,000 characters', () => {
    const metadata = extractMetadata(
      ' '.repeat(200_000) +
        '<meta property="og:title" content="Beyond the cap">',
      base,
    )
    expect(metadata.title).toBeUndefined()
  })

  test('raw-text closing tags use HTML ASCII whitespace instead of all Unicode whitespace', () => {
    const lookalike = `<script>const example = "</script\u00a0><meta property='og:title' content='From script'>";</script>
      <title>Real page title</title>`
    expect(extractMetadata(lookalike, base).title).toBe('Real page title')

    const realClosingTag = `<script>const example = "<meta property='og:title' content='From script'>";</script \t\n\f\r>
      <title>Real page title</title>`
    expect(extractMetadata(realClosingTag, base).title).toBe('Real page title')
  })

  test('nonbreaking spaces remain part of tag and attribute names', () => {
    for (const tag of [
      '<meta\u00a0 property="og:title" content="Not a meta tag">',
      '<meta property\u00a0="og:title" content="Not the property attribute">',
      '<meta property="og:title"\u00a0content="Not the content attribute">',
    ]) {
      expect(
        extractMetadata(tag + '<title>Document title</title>', base).title,
      ).toBe('Document title')
    }
  })

  test('nonbreaking spaces stay inside unquoted values and rel tokens', () => {
    const metadata = extractMetadata(
      '<meta property=og:title content=Two\u00a0words><link rel="other\u00a0icon" href="/not-an-icon.png">',
      base,
    )
    expect(metadata.title).toBe('Two\u00a0words')
    expect(metadata.favicon).toBe('https://example.com/favicon.ico')
  })

  test('HTML tag names fold ASCII letters without folding Unicode lookalikes', () => {
    expect(
      extractMetadata('<lin\u212a rel="icon" href="/fake.ico">', base).favicon,
    ).toBe('https://example.com/favicon.ico')
    expect(
      extractMetadata('<LINK rel="icon" href="/real.ico">', base).favicon,
    ).toBe('https://example.com/real.ico')
  })

  test('decoded-empty metadata falls through while preserving title precedence', () => {
    for (const [og, twitter, expected] of [
      ['   ', 'Twitter title', 'Twitter title'],
      ['&#32;&#x20;', '  ', 'Document title'],
      ['  Open Graph title  ', 'Twitter title', 'Open Graph title'],
    ]) {
      const metadata = extractMetadata(
        `<meta property="og:title" content="${og}">
        <meta name="twitter:title" content="${twitter}">
        <title>Document title</title>`,
        base,
      )
      expect(metadata.title).toBe(expected)
    }
  })

  test('falls back to the title tag and the default favicon', () => {
    const html = '<html><head><title>Plain page</title></head></html>'
    const meta = extractMetadata(html, base)
    expect(meta.title).toBe('Plain page')
    expect(meta.favicon).toBe('https://example.com/favicon.ico')
    expect(meta.image).toBeUndefined()
  })

  test('a page with nothing to preview extracts no title or description', () => {
    const meta = extractMetadata(
      '<html><head></head><body></body></html>',
      base,
    )
    expect(meta.title).toBeUndefined()
    expect(meta.description).toBeUndefined()
  })

  test('refuses a script-protocol image', () => {
    const html =
      '<meta property="og:title" content="X"><meta property="og:image" content="javascript:alert(1)">'
    expect(extractMetadata(html, base).image).toBeUndefined()
  })
})

// The resolver always uses lookup's all:true overload. Bind its mock to that
// signature instead of TypeScript's last, single-address overload.
type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
) => Promise<LookupAddress[]>

function mockLookupAll(): Mock<LookupAll> {
  return spyOn(dns, 'lookup')
}

// Mock the standard fetch call; Bun also attaches a preconnect property.
type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

function mockPlatformFetch(): Mock<FetchCall> {
  return spyOn(globalThis, 'fetch')
}

class PreviewResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = { 'content-type': 'text/html' }
  destroyed = false

  destroy() {
    this.destroyed = true
    this.emit('close')
    return this
  }
}

class PreviewRequest extends EventEmitter {
  destroyed = false

  end() {
    return this
  }

  destroy() {
    this.destroyed = true
    this.emit('close')
    return this
  }
}

interface PreviewConnection {
  options: https.RequestOptions
  request: PreviewRequest
  response: PreviewResponse
}

// Run promise continuations without advancing the elapsed-time clock.
async function flushPromises() {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve()
}

describe('resolveLinkMetadata request lifecycle', () => {
  let abort: Mock<AbortController['abort']>
  let connections: PreviewConnection[]
  const connection = (index: number): PreviewConnection => {
    const value = connections[index]
    if (!value) throw new Error(`Missing preview connection ${index}`)
    return value
  }
  let initialResponse:
    { statusCode: number; headers: Record<string, string> } | undefined
  let initialResponseDelay = 0
  let serial = 0
  const href = () => `https://preview-${++serial}.example.test/article`

  beforeEach(() => {
    jest.useFakeTimers()
    abort = spyOn(AbortController.prototype, 'abort')
    connections = []
    initialResponse = undefined
    initialResponseDelay = 0
    mockLookupAll().mockResolvedValue([{ address: '93.184.215.14', family: 4 }])
    spyOn(https, 'request').mockImplementation(((
      options: https.RequestOptions,
      receive: (response: IncomingMessage) => void,
    ) => {
      const request = new PreviewRequest()
      const response = new PreviewResponse()
      Object.assign(response, initialResponse)
      initialResponse = undefined
      connections.push({ options, request, response })
      const receiveResponse = () =>
        receive(response as unknown as IncomingMessage)
      const delay = initialResponseDelay
      initialResponseDelay = 0
      if (delay) setTimeout(receiveResponse, delay)
      else queueMicrotask(receiveResponse)
      return request as unknown as ClientRequest
    }) as typeof https.request)
  })

  afterEach(() => {
    // Observe cancellation instead of getTimerCount: Bun counts cleared timer
    // entries until their scheduled time is advanced.
    try {
      const completedAborts = abort.mock.calls.length
      jest.advanceTimersByTime(10_000)
      expect(abort).toHaveBeenCalledTimes(completedAborts)
    } finally {
      mock.restore()
      jest.useRealTimers()
    }
  })

  test('stops a continuously trickling body at the total deadline and destroys the connection', async () => {
    const result = resolveLinkMetadata(href())
    await flushPromises()
    const { request, response } = connection(0)
    for (let second = 0; second < 5; second++) {
      response.emit('data', Buffer.from('<title>Still arriving</title>'))
      jest.advanceTimersByTime(1_000)
      await flushPromises()
    }
    expect(request.destroyed).toBe(false)

    jest.advanceTimersByTime(1_000)
    await flushPromises()
    expect(request.destroyed).toBe(true)
    expect(response.destroyed).toBe(true)
    expect(response.listenerCount('data')).toBe(0)
    expect(await result).toBeNull()
  })

  test('includes DNS in the deadline and discards a late answer without dialing it', async () => {
    let answer!: (records: LookupAddress[]) => void
    mockLookupAll().mockImplementation(
      () =>
        new Promise<LookupAddress[]>((resolve) => {
          answer = resolve
        }),
    )
    let settled = false
    const result = resolveLinkMetadata(href()).then((value) => {
      settled = true
      return value
    })
    jest.advanceTimersByTime(5_999)
    await flushPromises()
    expect(settled).toBe(false)
    jest.advanceTimersByTime(1)
    await flushPromises()
    expect(settled).toBe(true)
    expect(await result).toBeNull()

    answer([{ address: '93.184.215.14', family: 4 }])
    await flushPromises()
    expect(connections).toHaveLength(0)
  })

  test('redirects share the original elapsed-time budget', async () => {
    initialResponse = {
      statusCode: 302,
      headers: { location: 'https://redirect.example.test/final' },
    }
    initialResponseDelay = 4_000
    const result = resolveLinkMetadata(href())
    await flushPromises()
    jest.advanceTimersByTime(4_000)
    await flushPromises()
    expect(connections).toHaveLength(2)

    jest.advanceTimersByTime(1_999)
    expect(connection(1).request.destroyed).toBe(false)
    jest.advanceTimersByTime(1)
    await flushPromises()
    expect(connection(1).request.destroyed).toBe(true)
    expect(connection(1).response.destroyed).toBe(true)
    expect(await result).toBeNull()
  })

  test('releases a redirect connection before reading its body', async () => {
    initialResponse = {
      statusCode: 302,
      headers: {
        location: 'https://immediate-redirect.example.test/?edition=1#results',
      },
    }
    const result = resolveLinkMetadata(href())
    await flushPromises()
    const first = connection(0)
    const startedBeforeBody = connections.length
    const releasedBeforeBody =
      first.request.destroyed && first.response.destroyed
    // Completing the old response keeps a failing regression deterministic.
    first.response.emit('end')
    await flushPromises()
    connection(1).response.emit(
      'data',
      Buffer.from('<title>Destination</title>'),
    )
    connection(1).response.emit('end')

    expect(await result).toMatchObject({
      href: 'https://immediate-redirect.example.test/?edition=1',
      title: 'Destination',
    })
    expect(startedBeforeBody).toBe(2)
    expect(releasedBeforeBody).toBe(true)
    expect(first.response.listenerCount('data')).toBe(0)
  })

  test('coalesces concurrent requests so a late duplicate failure cannot poison a success', async () => {
    const url = href()
    const first = resolveLinkMetadata(url)
    const second = resolveLinkMetadata(url)
    await flushPromises()
    connection(0).response.emit(
      'data',
      Buffer.from('<title>Shared success</title>'),
    )
    connection(0).response.emit('end')
    expect((await first)?.title).toBe('Shared success')
    // The old implementation opens a second connection and caches its failure.
    connections[1]?.request.emit('error', new Error('late duplicate failure'))

    expect((await second)?.title).toBe('Shared success')
    expect((await resolveLinkMetadata(url))?.title).toBe('Shared success')
    expect(connections).toHaveLength(1)
    expect(dns.lookup).toHaveBeenCalledTimes(1)
  })

  test('shares fragment variants in flight and in cache while retaining distinct query strings', async () => {
    const documentUrl = href() + '?edition=1'
    const methodsUrl = documentUrl + '#methods'
    const resultsUrl = documentUrl + '#results'
    const first = resolveLinkMetadata(methodsUrl)
    const second = resolveLinkMetadata(resultsUrl)
    await flushPromises()
    // Finish every connection so the pre-fix duplicate fetch also settles.
    for (const { response } of connections) {
      response.emit('data', Buffer.from('<title>Shared document</title>'))
      response.emit('end')
    }
    const values = await Promise.all([first, second])
    expect(connections).toHaveLength(1)
    expect(dns.lookup).toHaveBeenCalledTimes(1)
    expect(values[0]).toMatchObject({
      href: documentUrl,
      title: 'Shared document',
    })
    expect(values[1]).toBe(values[0])
    expect(await resolveLinkMetadata(documentUrl + '#discussion')).toBe(
      values[0],
    )
    expect(connections).toHaveLength(1)
    const otherEditionUrl = documentUrl.replace('edition=1', 'edition=2')
    const otherEdition = resolveLinkMetadata(otherEditionUrl + '#methods')
    await flushPromises()
    connection(1).response.emit(
      'data',
      Buffer.from('<title>Different edition</title>'),
    )
    connection(1).response.emit('end')
    expect(await otherEdition).toMatchObject({
      href: otherEditionUrl,
      title: 'Different edition',
    })
    expect(connections).toHaveLength(2)
    expect(dns.lookup).toHaveBeenCalledTimes(2)
  })

  test('refuses special-purpose DNS answers before opening a connection', async () => {
    for (const address of [
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
    ]) {
      mockLookupAll().mockResolvedValue([{ address, family: 4 }])
      expect(await resolveLinkMetadata(href())).toBeNull()
    }
    expect(connections).toHaveLength(0)
  })

  test('pins only the public answer when DNS also returns a benchmarking address', async () => {
    mockLookupAll().mockResolvedValue([
      { address: '198.18.0.1', family: 4 },
      { address: '93.184.215.14', family: 4 },
    ])
    const result = resolveLinkMetadata(href())
    await flushPromises()
    expect(connection(0).options.host).toBe('93.184.215.14')
    connection(0).response.emit(
      'data',
      Buffer.from('<title>Public destination</title>'),
    )
    connection(0).response.emit('end')
    expect((await result)?.title).toBe('Public destination')
  })

  test('address retries share the budget and stop retrying when it expires', async () => {
    mockLookupAll().mockResolvedValue([
      { address: '93.184.215.14', family: 4 },
      { address: '93.184.215.15', family: 4 },
      { address: '93.184.215.16', family: 4 },
    ])
    const result = resolveLinkMetadata(href())
    await flushPromises()
    jest.advanceTimersByTime(4_000)
    connection(0).request.emit('error', new Error('connection failed'))
    await flushPromises()
    expect(connections).toHaveLength(2)
    expect(connection(0).request.destroyed).toBe(true)

    jest.advanceTimersByTime(2_000)
    await flushPromises()
    expect(connection(1).request.destroyed).toBe(true)
    expect(connections).toHaveLength(2)
    expect(await result).toBeNull()
  })

  test('successful completion preserves the pinned address and clears the deadline', async () => {
    const url = href()
    const result = resolveLinkMetadata(url)
    await flushPromises()
    const { options, request, response } = connection(0)
    expect(options.host).toBe('93.184.215.14')
    expect(options.servername).toBe(new URL(url).hostname)
    expect(options.headers).toMatchObject({ host: new URL(url).host })
    response.emit('data', Buffer.from('<title>Ready</title>'))
    response.emit('end')

    expect((await result)?.title).toBe('Ready')
    jest.advanceTimersByTime(10_000)
    expect(request.destroyed).toBe(false)
    expect(response.destroyed).toBe(false)
    expect(response.listenerCount('data')).toBe(0)
  })

  test('resolves a useful document preview when higher-priority metadata is blank', async () => {
    const result = resolveLinkMetadata(href())
    await flushPromises()
    connection(0).response.emit(
      'data',
      Buffer.from(
        '<meta property="og:title" content="&#32;"><title>Document preview</title>',
      ),
    )
    connection(0).response.emit('end')
    expect((await result)?.title).toBe('Document preview')
  })

  test('retains the bounded prefix of an oversized chunk and closes the stream', async () => {
    const result = resolveLinkMetadata(href())
    await flushPromises()
    const { request, response } = connection(0)
    response.emit(
      'data',
      Buffer.from('<title>Large page</title>' + 'x'.repeat(600 * 1024)),
    )

    expect((await result)?.title).toBe('Large page')
    expect(request.destroyed).toBe(true)
    expect(response.destroyed).toBe(true)
  })

  test('does not accept a response that closes before the body completes', async () => {
    const result = resolveLinkMetadata(href())
    await flushPromises()
    const { request, response } = connection(0)
    response.emit('data', Buffer.from('<title>Truncated</title>'))
    response.emit('close')

    expect(await result).toBeNull()
    expect(request.destroyed).toBe(true)
    expect(response.destroyed).toBe(true)
  })

  test('rechecks DNS for a redirect and refuses its private address', async () => {
    initialResponse = {
      statusCode: 302,
      headers: { location: 'https://private.example.test/' },
    }
    mockLookupAll()
      .mockResolvedValueOnce([{ address: '93.184.215.14', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const result = resolveLinkMetadata(href())
    await flushPromises()
    connection(0).response.emit('end')

    expect(await result).toBeNull()
    expect(connections).toHaveLength(1)
  })

  test('dials a public IPv6 literal without a second hostname lookup', async () => {
    const result = resolveLinkMetadata('https://[2606:4700:10::6814:179a]/')
    await flushPromises()
    expect(dns.lookup).not.toHaveBeenCalled()
    expect(connection(0).options.host).toBe('2606:4700:10::6814:179a')
    connection(0).response.emit('data', Buffer.from('<title>IPv6</title>'))
    connection(0).response.emit('end')
    expect((await result)?.title).toBe('IPv6')
  })
})

describe('resolveLinkMetadata on Cloudflare Workers', () => {
  let abort: Mock<AbortController['abort']>
  let navigatorDescriptor: PropertyDescriptor | undefined
  let serial = 0
  const href = () => `https://worker-preview-${++serial}.example.test/article`

  beforeEach(() => {
    jest.useFakeTimers()
    abort = spyOn(AbortController.prototype, 'abort')
    navigatorDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'navigator',
    )
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    })
    mockLookupAll().mockResolvedValue([{ address: '93.184.215.14', family: 4 }])
    spyOn(https, 'request').mockImplementation(() => {
      throw new Error('Workers must not use the Node HTTPS shim')
    })
    mockPlatformFetch().mockResolvedValue(
      new Response('<title>Worker preview</title>', {
        headers: { 'content-type': 'text/html' },
      }),
    )
  })

  afterEach(() => {
    // Observe cancellation instead of getTimerCount: Bun counts cleared timer
    // entries until their scheduled time is advanced.
    try {
      const completedAborts = abort.mock.calls.length
      jest.advanceTimersByTime(10_000)
      expect(abort).toHaveBeenCalledTimes(completedAborts)
    } finally {
      mock.restore()
      jest.useRealTimers()
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  test('selects public platform fetch only in Workers and follows redirects manually', async () => {
    const url = href()
    expect((await resolveLinkMetadata(url))?.title).toBe('Worker preview')
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: 'manual', credentials: 'omit' }),
    )
    expect(https.request).not.toHaveBeenCalled()
  })

  test('refuses a hostname resolving only to private addresses before platform fetch', async () => {
    mockLookupAll().mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    expect(await resolveLinkMetadata(href())).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rechecks redirected hostnames and refuses a private DNS result', async () => {
    mockLookupAll()
      .mockResolvedValueOnce([{ address: '93.184.215.14', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }])
    mockPlatformFetch().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { location: 'https://worker-private.example.test/' },
      }),
    )
    expect(await resolveLinkMetadata(href())).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(dns.lookup).toHaveBeenCalledTimes(2)
  })

  test('refuses special-purpose DNS answers before platform fetch', async () => {
    for (const address of [
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
    ]) {
      mockLookupAll().mockResolvedValue([{ address, family: 4 }])
      expect(await resolveLinkMetadata(href())).toBeNull()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  test('cancels a redirect body without waiting for it or its cancellation', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>
    const cancel = mock(() => new Promise<void>(() => {}))
    mockPlatformFetch()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller
            },
            cancel,
          }),
          {
            status: 302,
            headers: {
              location: 'https://worker-immediate-redirect.example.test/',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('<title>Immediate destination</title>', {
          headers: { 'content-type': 'text/html' },
        }),
      )
    const result = resolveLinkMetadata(href())
    await flushPromises()
    await flushPromises()
    const startedBeforeBody = mockPlatformFetch().mock.calls.length
    const cancelledBeforeBody = cancel.mock.calls.length
    // Let the former implementation complete so failure does not hang a test.
    if (startedBeforeBody === 1) body.close()

    expect((await result)?.title).toBe('Immediate destination')
    expect(startedBeforeBody).toBe(2)
    expect(cancelledBeforeBody).toBe(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('cancels a trickling platform body at the shared deadline', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>
    // A slow cancellation must not delay the resolver's timeout response.
    const cancel = mock(() => new Promise<void>(() => {}))
    mockPlatformFetch().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller
          },
          cancel,
        }),
        { headers: { 'content-type': 'text/html' } },
      ),
    )
    let settled = false
    const result = resolveLinkMetadata(href()).then((value) => {
      settled = true
      return value
    })
    await flushPromises()
    for (let second = 0; second < 5; second++) {
      body.enqueue(Buffer.from('<title>Still arriving</title>'))
      jest.advanceTimersByTime(1_000)
      await flushPromises()
    }
    expect(settled).toBe(false)
    jest.advanceTimersByTime(1_000)
    await flushPromises()
    expect(settled).toBe(true)
    expect(await result).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('cancels the platform reader as soon as the body limit is reached', async () => {
    const cancel = mock(() => {})
    mockPlatformFetch().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              Buffer.from('<title>Bounded</title>' + 'x'.repeat(600 * 1024)),
            )
          },
          cancel,
        }),
        { headers: { 'content-type': 'text/html' } },
      ),
    )
    expect((await resolveLinkMetadata(href()))?.title).toBe('Bounded')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('redirects consume the original platform-fetch deadline', async () => {
    const cancel = mock(() => {})
    mockPlatformFetch()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response('', {
                    status: 302,
                    headers: {
                      location: 'https://worker-slow-redirect.example.test/',
                    },
                  }),
                ),
              4_000,
            )
          }),
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { 'content-type': 'text/html' },
        }),
      )
    const result = resolveLinkMetadata(href())
    await flushPromises()
    jest.advanceTimersByTime(4_000)
    await flushPromises()
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(2)
    jest.advanceTimersByTime(2_000)
    await flushPromises()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await result).toBeNull()
  })
})
