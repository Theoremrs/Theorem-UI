import { afterEach, describe, expect, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import type { FrameConnection } from './executor'
import { followTheme, hostedAppDocument } from './hosted-app'
import { rpcOver, serve } from './sandbox/protocol'
import type { SandboxMethods } from './sandbox/protocol'
import { applyAppTheme } from './sandbox/theme'
import type { AppTheme } from './sandbox/theme'

test('a hosted App carries the real bridge and no policy of the host\'s, without a desktop listener', async () => {
  const input =
    '<!doctype html><html><head><title>Comparison</title></head><body><table><tr><td contenteditable>Category</td></tr></table><script>window.appLoaded = true</script></body></html>'
  const html = await hostedAppDocument(input, esbuild)
  const page = new DOMParser().parseFromString(html, 'text/html')
  // It may reach the network, load remote scripts and submit forms like any page.
  expect(page.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeNull()
  expect(page.querySelector('td')?.textContent).toBe('Category')
  expect(page.querySelector('td')?.hasAttribute('contenteditable')).toBe(true)
  const bridge = page.querySelector(
    'script[data-theorem-app-bridge]',
  )?.textContent
  expect(bridge).toContain('theorem')
  expect(bridge).toContain('theorem:block-ready')
  expect(html).not.toContain('/desktop/')
  expect(html).not.toContain('127.0.0.1')
}, 30_000)

test('a hosted App says its encoding before anything else, so its text is read as UTF-8', async () => {
  const html = await hostedAppDocument('<p>7 + 15 — carry</p>', esbuild)
  const page = new DOMParser().parseFromString(html, 'text/html')
  expect(page.head.firstElementChild?.outerHTML).toBe('<meta charset="utf-8">')
  expect(html.indexOf('<meta charset="utf-8">')).toBeLessThan(1024)
  expect(page.querySelector('p')?.textContent).toBe('7 + 15 — carry')
}, 30_000)

test('a declared host is no limit: the page keeps only the policy it wrote itself', async () => {
  const html = await hostedAppDocument(
    `<html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src *">
    <meta name="theorem:uses" content='net("example.com")'>
    </head><body>App</body></html>`,
    esbuild,
  )
  const page = new DOMParser().parseFromString(html, 'text/html')
  const policies = [
    ...page.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
  ].map((meta) => meta.getAttribute('content'))
  expect(policies).toEqual(['default-src *'])
})

test('a page module reaches only the hosts the person allowed it, whatever its page declares', async () => {
  const html = await hostedAppDocument(
    `<html><head>
    <meta name="theorem:uses" content='net("example.com")'>
    </head><body>Module</body></html>`,
    esbuild,
    { net: ['api.allowed.example'] },
  )
  const page = new DOMParser().parseFromString(html, 'text/html')
  // The person's limit comes right after the document's encoding, ahead of anything the App wrote.
  const policy = page.head.children[1]
  expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  const content = policy?.getAttribute('content') ?? ''
  expect(content).toContain("default-src 'none'")
  expect(content).toContain('connect-src https://api.allowed.example')
  expect(content).not.toContain('example.com;')
  expect(content).toContain("form-action 'none'")
})

const STONE: AppTheme = {
  scheme: 'light',
  tokens: {
    ink: '#32302e',
    surface: '#c2bebb',
    hover: '#bbb7b3',
    border: '#9d9995',
    'border-control': '#514e4b',
    radius: '6px',
  },
}

test('the host stylesheet comes before every piece of the App’s own content', async () => {
  const html = await hostedAppDocument(
    `<html><head><meta charset="utf-8"><style>button { background: #fafaf9 }</style></head>
    <body><button>Next step</button><style>p { color: red }</style></body></html>`,
    esbuild,
    { theme: STONE },
  )
  const page = new DOMParser().parseFromString(html, 'text/html')
  const host = page.querySelector('style[data-theorem-theme]')!
  // The document's encoding comes first (in place of the App's own), then the host stylesheet.
  expect(page.head.firstElementChild?.getAttribute('charset')).toBe('utf-8')
  expect(page.querySelectorAll('meta[charset]')).toHaveLength(1)
  expect(host).toBe(page.head.children[1]!)
  expect(host.textContent).toContain('--theorem-ink: #32302e;')
  expect(host.textContent).toContain('color-scheme: light;')
  const authored = page.querySelectorAll(
    'style:not([data-theorem-theme]), button',
  )
  expect(authored).toHaveLength(3)
  for (const node of authored)
    expect(
      host.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  // The App's own stylesheet is left exactly as it wrote it.
  expect(
    page.querySelector('head style:not([data-theorem-theme])')?.textContent,
  ).toBe('button { background: #fafaf9 }')
})

describe('in a live document', () => {
  afterEach(() => {
    document.head.replaceChildren()
    document.body.replaceChildren()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-palette')
  })

  function style(css: string, at: 'start' | 'end' = 'end') {
    const element = document.createElement('style')
    element.textContent = css
    if (at === 'start') document.head.prepend(element)
    else document.head.append(element)
  }

  // happy-dom does not apply cascade layers, so how the defaults resolve
  // against an App's own rules, layered or not, is checked in Chromium by
  // scripts/e2e/app-ts.mjs. Here: where the defaults stand.
  test('the defaults sit in the first cascade layer, ahead of everything the App wrote', () => {
    style('button.own { background-color: #fafaf9 }')
    style('@layer astryx-base { button { background-color: red } }')
    applyAppTheme(STONE)
    const host = document.head.firstElementChild!
    expect(host.hasAttribute('data-theorem-theme')).toBe(true)
    const css = host.textContent ?? ''
    // Variables outside the layer, every element default inside it.
    const layer = css.indexOf('@layer theorem-defaults {')
    expect(layer).toBeGreaterThan(css.indexOf('--theorem-'))
    for (const rule of [':where(body)', ':where(a)', ':where(button'])
      expect(css.indexOf(rule)).toBeGreaterThan(layer)
  })

  test('the frame’s variables follow the page’s palette and mode', async () => {
    style(`:root { --ink: #24292d; --line-separator: #e1e4e8 }
      [data-palette='stone'] { --ink: #32302e; --line-separator: #9d9995 }
      .dark[data-palette='stone'] { --ink: #dedad6 }`)
    const frame = new DOMParser().parseFromString(
      await hostedAppDocument('<p>App</p>', esbuild),
      'text/html',
    )
    const variables = () =>
      frame.querySelector('style[data-theorem-theme]')?.textContent ?? ''
    expect(variables()).toContain('--theorem-ink: #24292d;')

    const channel = new MessageChannel()
    serve<SandboxMethods, 'theme.changed'>(
      rpcOver(channel.port2),
      'theme.changed',
      (theme) => {
        if ('scheme' in theme) applyAppTheme(theme, frame)
        return null
      },
    )
    const connection = {
      connected: Promise.resolve(rpcOver(channel.port1)),
    } as unknown as FrameConnection
    const stop = followTheme(connection)
    try {
      document.documentElement.setAttribute('data-palette', 'stone')
      await until(() => variables().includes('--theorem-ink: #32302e;'))
      expect(variables()).toContain('--theorem-border: #9d9995;')
      expect(variables()).toContain('color-scheme: light;')

      document.documentElement.classList.add('dark')
      await until(() => variables().includes('--theorem-ink: #dedad6;'))
      expect(variables()).toContain('color-scheme: dark;')
      expect(frame.querySelectorAll('style[data-theorem-theme]')).toHaveLength(
        1,
      )
    } finally {
      stop()
      channel.port1.close()
    }
  })
})

async function until(condition: () => boolean) {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 100) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a check’s page asks every WebGL context to keep its drawn frame, and an App on screen keeps the default', async () => {
  const checked = new DOMParser().parseFromString(
    await hostedAppDocument('<canvas></canvas>', esbuild, { keepDrawnFrames: true }),
    'text/html',
  )
  const shown = await hostedAppDocument('<canvas></canvas>', esbuild)
  expect(shown).not.toContain('preserveDrawingBuffer')
  // It runs ahead of the App's own scripts: in the head, before the body.
  const keep = [...checked.head.querySelectorAll('script')].find((script) =>
    script.textContent?.includes('preserveDrawingBuffer'),
  )
  expect(keep).toBeDefined()
  const original = HTMLCanvasElement.prototype.getContext
  const asked: Array<[string, unknown]> = []
  HTMLCanvasElement.prototype.getContext = function (type: string, options?: unknown) {
    asked.push([type, options])
    return null
  } as typeof original
  try {
    new Function(keep!.textContent!)()
    const canvas = document.createElement('canvas')
    canvas.getContext('webgl2', { alpha: false })
    canvas.getContext('webgl')
    canvas.getContext('2d', { alpha: false })
    expect(asked).toEqual([
      ['webgl2', { alpha: false, preserveDrawingBuffer: true }],
      ['webgl', { preserveDrawingBuffer: true }],
      ['2d', { alpha: false }],
    ])
  } finally {
    HTMLCanvasElement.prototype.getContext = original
  }
}, 30_000)
