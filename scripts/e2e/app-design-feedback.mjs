// Exercise the production App bridge through an opaque iframe and its actual
// MessageChannel RPC. The optional dependency directory supports a focused
// checkout without installing the rest of Theorem-UI.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { importMap } from '../../src/lib/blocks/vendor/manifest.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dependencyRoot = process.env.THEOREM_TEST_DEPENDENCIES
const dependencies = createRequire(dependencyRoot
  ? path.join(dependencyRoot, 'package.json') : import.meta.url)
const packageDependencies = createRequire(new URL('../../packages/design-feedback/package.json', import.meta.url))
const { build } = dependencies('esbuild-wasm')
const { chromium } = packageDependencies('playwright-core')
// Use the exact vendored modules the production App gets, including its React
// and JSON-RPC versions, without installing the whole application dependency tree.
const vendorPlugin = {
  name: 'production-vendor-files',
  setup(bundler) {
    bundler.onResolve({ filter: /.*/ }, ({ path: specifier }) => {
      const served = importMap.imports[specifier] ?? specifier
      if (!served.startsWith('/vendor/')) return undefined
      return { path: path.join(root, 'src/lib/blocks/vendor/files', served.slice('/vendor/'.length)) }
    })
  },
}

test('the live App sandbox returns bounded design feedback through its real RPC', { timeout: 30000 }, async () => {
  // Read the production source registry, including its ?raw imports. This
  // catches a missing collector entry in the map the in-page bundler uses.
  const registry = await build({
    entryPoints: [path.join(root, 'src/lib/blocks/runtime-sources.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'raw-sources', setup(bundler) {
      bundler.onResolve({ filter: /\?raw$/ }, ({ path: specifier, importer }) => ({
        path: path.resolve(path.dirname(importer), specifier.slice(0, -4)), namespace: 'raw',
      }))
      bundler.onLoad({ filter: /.*/, namespace: 'raw' }, async ({ path: filename }) => ({
        contents: `export default ${JSON.stringify(await readFile(filename, 'utf8'))}`, loader: 'js',
      }))
    } }],
  })
  const { runtimeSources } = await import(`data:text/javascript;base64,${Buffer.from(registry.outputFiles[0].text).toString('base64')}`)
  const bridge = await build({
    stdin: { contents: 'import "./app-bridge"', resolveDir: root },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    plugins: [{ name: 'sandbox-source-map', setup(bundler) {
      bundler.onResolve({ filter: /^\.\/[\w-]+$/ }, ({ path: specifier, namespace }) =>
        namespace === 'theorem-runtime' || namespace === ''
          ? { path: specifier.slice(2), namespace: 'theorem-runtime' } : undefined)
      bundler.onLoad({ filter: /.*/, namespace: 'theorem-runtime' }, ({ path: name }) => ({
        contents: runtimeSources[name], loader: 'ts', resolveDir: root,
      }))
    } }, vendorPlugin],
  })
  const host = await build({
    stdin: { contents: `
      import { rpcOver, call, serve, READY_MESSAGE, CONNECT_MESSAGE } from './src/lib/blocks/sandbox/protocol.ts';
      import { schemesDesignFeedback } from './src/lib/blocks/app-design.ts';
      // Two looks as the page hands them: each scheme's ink and the background behind the App.
      const looks = {
        light: { scheme: 'light', tokens: { ink: '#24292d', background: '#ffffff' } },
        dark: { scheme: 'dark', tokens: { ink: '#c3c6c8', background: '#1c1d1e' } },
      };
      window.checkDesignFixture = (html) => new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;visibility:hidden;pointer-events:none;border:0';
        let channel;
        const errors = [];
        const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', connected); channel?.port1.close(); frame.remove(); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('App design RPC timed out')); }, 10000);
        const connected = async (event) => {
          if (event.source !== frame.contentWindow || event.data?.type !== READY_MESSAGE) return;
          window.removeEventListener('message', connected);
          channel = new MessageChannel();
          const rpc = rpcOver(channel.port1);
          for (const method of ['frame.resize', 'frame.snapshot', 'frame.selection', 'module.used']) serve(rpc, method, () => null);
          serve(rpc, 'frame.error', (error) => { errors.push(error); return null; });
          frame.contentWindow.postMessage({type: CONNECT_MESSAGE}, '*', [channel.port2]);
          try {
            const measurements = [];
            let observed;
            for (const scheme of ['light', 'dark']) {
              await call(rpc, 'theme.changed', looks[scheme]);
              const captureId = 'sandbox-browser-test-' + scheme;
              const value = await call(rpc, 'frame.design', { captureId, scheme, canvas: looks[scheme].tokens.background });
              observed ??= value;
              measurements.push({ scheme, captureId, value });
            }
            const feedback = schemesDesignFeedback(measurements);
            cleanup(); resolve({ observed, feedback, errors, framesRemaining: document.querySelectorAll('iframe').length });
          } catch (error) { cleanup(); reject(error); }
        };
        window.addEventListener('message', connected);
        frame.srcdoc = html;
        document.body.append(frame);
      });`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'iife', platform: 'browser', plugins: [vendorPlugin],
  })
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM || undefined,
    args: process.env.E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
  })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent('<!doctype html><title>App design feedback test host</title><body></body>')
    await page.addScriptTag({ content: host.outputFiles[0].text })
    // A transparent App, as one in a conversation is: the page's background is behind it.
    const html = `<!doctype html><style>body{margin:24px;font:16px/24px sans-serif}#bad{color:#bbb;width:100px}#gradient{background:linear-gradient(white,black)}
      #themed{color:var(--theorem-ink);transition:color 10s linear}
      #chips{display:flex;flex-wrap:wrap;gap:8px;width:330px}#chips>span{width:100px;color:var(--theorem-ink)}</style>
      <p id="bad" data-theorem-source="main.tsx:8:3">Contrast should fail</p>
      <p id="gradient">Paint requires inspection</p>
      <p id="themed" data-theorem-source="main.tsx:20:3">Ink follows the scheme</p>
      <div id="chips" data-theorem-source="main.tsx:30:3"><span>1 cup</span><span>2 tbsp</span><span>1 tsp</span><span>100 g</span></div>
      <script>document.querySelector('#bad').style.width='321px'</script>
      <script>${bridge.outputFiles[0].text}</script>`
    const result = await page.evaluate((documentHtml) => window.checkDesignFixture(documentHtml), html)
    assert.deepEqual(errors, [])
    assert.deepEqual(result.errors, [])
    assert.equal(result.framesRemaining, 0)
    assert.equal(result.feedback.status, 'measured')
    assert.equal(result.feedback.evidence, 'sandbox-reported-dom')
    assert.equal(result.observed.capture.evidenceKind, 'rendered-artifact')
    assert.equal(result.observed.capture.viewport.width, 1024)
    assert.equal(result.observed.capture.viewport.height, 768)
    assert.equal(result.observed.elements.find((element) => element.id === 'id:bad').rect.width, 321)
    const { issues, summary } = result.feedback.report
    assert.deepEqual(result.feedback.schemes, ['light', 'dark'])
    // Light grey fails on the light page and reads on the dark one.
    const bad = issues.find((issue) => issue.status === 'fail' && issue.at.includes('main.tsx:8:3'))
    assert.deepEqual(bad?.schemes, ['light'])
    // Its ink is the theme's, so each scheme's unresolved paint is its own measurement.
    const gradient = issues.filter((issue) =>
      issue.status === 'unknown' && issue.at.includes('[id="gradient"]'))
    assert.deepEqual(gradient.flatMap((issue) => issue.schemes ?? ['light', 'dark']).sort(), ['dark', 'light'])
    // The ink's transition is ended before measuring, so dark is measured in dark ink.
    assert.ok(!issues.some((issue) => issue.rule === 'color.text-contrast' && issue.at.includes('main.tsx:20:3')))
    assert.ok(summary.light.pass > 0 && summary.dark.pass > 0)
    const lone = issues.find((issue) => issue.rule === 'layout.lone-wrapped-item')
    assert.deepEqual(lone?.measured.rows, [3, 1])
    assert.deepEqual(lone?.at, ['main.tsx:30:3'])
    assert.equal(lone?.schemes, undefined)
  } finally {
    await browser.close()
  }
})
