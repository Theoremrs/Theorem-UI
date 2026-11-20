// The metadata reader's pure parts: URL admission (the SSRF guard) and the
// HTML extraction. The network path is exercised on the dev stack, not here.
import { describe, expect, test } from 'bun:test'
import { extractMetadata, publicAddress, publicHttpUrl } from './link-preview'

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
      'fc00::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ])
      expect(publicAddress(address)).toBe(false)
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
