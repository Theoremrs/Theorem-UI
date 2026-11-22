// Hosted documents use the same frame and bridge as desktop HTML Apps. They
// also take the page's look (sandbox/theme.ts): a host stylesheet ahead of the
// App's own content, kept current over the bridge by followTheme. The
// platform's MutationObserver watches the root's class, data-palette and style,
// as the IDE frame's and the terminal's colours follow them.
import type * as Esbuild from 'esbuild-wasm'
import { readAppSources, removeAppSources } from './app-source'
import { connectSources, contentSecurityPolicy } from './document'
import type { FrameConnection } from './executor'
import { bundleAppBridge, bundleAppSources } from './export'
import { call } from './sandbox/protocol'
import type { SandboxMethods } from './sandbox/protocol'
import { THEME_STYLE, readAppTheme, themeCss } from './sandbox/theme'
import type { AppTheme } from './sandbox/theme'

let bridgeScript: Promise<string> | undefined

/**
 * A hosted page reaches whatever a page can: the network, remote scripts,
 * images and fonts. `net` is a limit the person set (a sandboxed module):
 * given, the page runs only what it carries and reaches only those hosts.
 * `theme` is the look the frame starts with; the page's own by default.
 */
export interface HostedAppOptions {
  net?: Array<string>
  theme?: AppTheme
}

/** What tracing a failure in a built App back to its source needs. */
export interface HostedBuild {
  /** The bundle's source map: the App's own files, by their paths. */
  map: string
  /**
   * The line of the page the bundle's script tag is on. The bundle's first
   * line is the one after it, at column zero.
   */
  scriptLine: number
}

/** A hosted page, and how it was built when it carries TypeScript source. */
export interface HostedApp {
  page: string
  build?: HostedBuild
}

/** The attribute on the script that holds a built App's bundle, and on its map. */
const BUNDLE = 'data-theorem-app-bundle'
const MAP = 'data-theorem-app-map'
const BUNDLE_TAG = `<script type="module" ${BUNDLE}`
const MAP_TAG = `<script type="application/json" ${MAP}="">`

/**
 * How a hosted page was built, read from the page: a built App carries its
 * own map, so a failure in it can be traced with nothing but the page.
 */
export function hostedBuild(page: string): HostedBuild | undefined {
  const tag = page.lastIndexOf(BUNDLE_TAG)
  const start = page.lastIndexOf(MAP_TAG, tag)
  if (tag < 0 || start < 0) return undefined
  const from = start + MAP_TAG.length
  return {
    map: page.slice(from, page.indexOf('</script>', from)),
    scriptLine: page.slice(0, tag).split('\n').length,
  }
}

/** The hosted page alone. See {@link hostedApp}. */
export async function hostedAppDocument(
  html: string,
  esbuild?: Pick<typeof Esbuild, 'build'>,
  options: HostedAppOptions = {},
): Promise<string> {
  return (await hostedApp(html, esbuild, options)).page
}

/**
 * The document an App's frame loads: the App's own page, with the bridge
 * first (and the person's limit, when they set one). A page that carries TypeScript source
 * (app-source.ts) is built here: its source scripts are replaced by one
 * module, after everything else in the body. A source that does not build is
 * an `AppBuildError`.
 */
export async function hostedApp(
  html: string,
  esbuild?: Pick<typeof Esbuild, 'build'>,
  options: HostedAppOptions = {},
): Promise<HostedApp> {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const appSources = readAppSources(page)
  const bundle = appSources && (await bundleAppSources(appSources, esbuild))
  const limit = options.net && page.createElement('meta')
  if (limit) {
    limit.httpEquiv = 'Content-Security-Policy'
    // A blob Worker keeps this policy, so it reaches only what connect-src grants.
    limit.content = contentSecurityPolicy({
      'default-src': "'none'",
      'script-src': "'unsafe-inline' 'wasm-unsafe-eval'",
      'worker-src': 'blob:',
      'style-src': "'unsafe-inline'",
      'img-src': 'data: blob:',
      'font-src': 'data:',
      'media-src': 'data: blob:',
      'connect-src': connectSources(options.net!),
      'form-action': "'none'",
      'base-uri': "'none'",
    })
  }
  const theme = page.createElement('style')
  theme.setAttribute(THEME_STYLE, '')
  theme.textContent = themeCss(options.theme ?? readAppTheme())
  const bridge = page.createElement('script')
  bridge.dataset.theoremAppBridge = ''
  bridge.textContent = esbuild
    ? await bundleAppBridge(esbuild)
    : await (bridgeScript ??= bundleAppBridge().catch((error) => {
        bridgeScript = undefined
        throw error
      }))
  // The person's limit goes before any author content, and the host
  // stylesheet too, so every rule the App writes comes after it. The classic
  // IIFE exposes theorem.ready before the App's own scripts can execute.
  // A blob says no encoding, so the document says it first: without it the
  // App's text is read as windows-1252 ("—" shows as "â€”"). It replaces
  // any the App wrote: the page is a string, and the blob holds it as UTF-8.
  for (const declared of page.querySelectorAll('meta[charset]')) declared.remove()
  const charset = page.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  page.head.prepend(charset, ...(limit ? [limit] : []), theme, bridge)
  if (!appSources || !bundle)
    return { page: `<!doctype html>\n${page.documentElement.outerHTML}` }
  removeAppSources(page)
  if (bundle.css) {
    const style = page.createElement('style')
    style.textContent = bundle.css
    page.head.append(style)
  }
  const map = page.createElement('script')
  map.type = 'application/json'
  map.setAttribute(MAP, '')
  // JSON, with nothing in it that could end the element early.
  map.textContent = bundle.map.replaceAll('<', '\\u003c')
  const script = page.createElement('script')
  script.type = 'module'
  script.setAttribute(BUNDLE, '')
  // On a line of its own, so a failure's line and column are the bundle's.
  script.textContent = `\n${bundle.code}`
  page.body.append(map, script)
  const text = `<!doctype html>\n${page.documentElement.outerHTML}`
  return { page: text, build: hostedBuild(text) }
}

/**
 * Sends a hosted App's frame the page's look once it connects and again
 * whenever it changes. Made to be a BlockFrame's `onConnection`; returns what
 * stops it.
 */
export function followTheme(connection: FrameConnection): () => void {
  let stop: (() => void) | undefined
  let active = true
  void connection.connected.then(
    (rpc) => {
      if (!active) return
      let sent = ''
      const send = () => {
        const theme = readAppTheme()
        const key = JSON.stringify(theme)
        if (key === sent) return
        sent = key
        void call<SandboxMethods, 'theme.changed'>(
          rpc,
          'theme.changed',
          theme,
        ).catch(() => {})
      }
      // The look may have changed while the frame loaded.
      send()
      const observer = new MutationObserver(send)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-palette', 'style'],
      })
      stop = () => observer.disconnect()
    },
    () => {},
  )
  return () => {
    active = false
    stop?.()
  }
}
