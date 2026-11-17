import { mkdirSync } from 'node:fs'
import path from 'node:path'
// Procedural geometry in an App: a gear written as a recipe and generated with
// Manifold (WebAssembly), drawn by three.js as a @theorem/spatial part's form.
// It builds and type-checks, the mesh has triangles, a changed parameter changes
// the mesh, regeneration is timed, and input stays responsive while it runs.
//
//   bun run e2e:geometry
//
// The App is in geometry-app.mjs. It is served by the real App view over an
// in-memory App document (scripts/e2e/app-ts/) in headless Chromium with a
// GPU-less WebGL. Screenshots go to docs/plans/evidence/geometry-2026-11-17/.
//
// Manifold's WebAssembly needs 'wasm-unsafe-eval' in the frame's script-src,
// which the App frame's policy (hosted-app.ts) does not grant. The run first
// records what the shipped policy does, then repeats with that one token added
// to the frame's page by this test alone, so the rest of the run is observed.
import { chromium } from 'playwright-core'
import { GEAR_APP, PROBE_APP } from './geometry-app.mjs'
import { servePage } from './harness.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/geometry-2026-11-17')
mkdirSync(EVIDENCE, { recursive: true })

const served = await servePage('app-ts')
const checks = []
const check = (name, pass, detail) => {
  checks.push(pass)
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
}
const note = (name, detail) => console.log(`note ${name}: ${JSON.stringify(detail)}`)

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
// Test only: the page the frame loads gets 'wasm-unsafe-eval' once __wasmCsp is set.
await page.addInitScript(() => {
  const Real = window.Blob
  window.Blob = class extends Real {
    constructor(parts, options) {
      if (window.__wasmCsp && options?.type === 'text/html')
        parts = parts.map((part) =>
          typeof part === 'string'
            ? part.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' 'wasm-unsafe-eval'")
            : part,
        )
      super(parts, options)
    }
  }
})

const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame())
const waitFor = async (what, ready) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await frame()?.evaluate(ready).catch(() => false)) return
    await page.waitForTimeout(200)
  }
  throw new Error(`${what} never appeared`)
}
const generated = () => frame().evaluate(() => window.gear.generated.map((each) => ({ ...each })))
const settle = () => page.waitForTimeout(900)
const startOracle = async () => {
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())
}

try {
  await startOracle()

  // 1. What the App builds and what the checker says, under the shipped policy.
  const shipped = await page.evaluate((html) => window.oracle.inspect(html, { runMs: 6000 }), GEAR_APP)
  const compile = shipped.problems.filter((p) => p.kind === 'build' || p.kind === 'type')
  check('the gear App builds and type-checks with no build or type problems', shipped.built && shipped.typesChecked && compile.length === 0, compile)
  const blocked = shipped.problems.find((p) => p.kind === 'runtime')
  note('as shipped (script-src without wasm-unsafe-eval), running the App', blocked?.message ?? 'no runtime problem')

  // 2. What the frame permits: a worker, and WebAssembly.
  await page.evaluate((html) => window.oracle.revise(html), PROBE_APP)
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await waitFor('the probe', () => 'probe' in window)
  const probe = await frame().evaluate(() => window.probe)
  note('shipped frame probe', probe)
  check('as shipped, a blob Worker does not run', probe.worker !== 'ran', probe.worker)
  check('as shipped, WebAssembly does not compile', probe.wasm !== 'compiled', probe.wasm)

  // 3. The same, with 'wasm-unsafe-eval' added to the frame's page (test only).
  await startOracle()
  await page.evaluate(() => {
    window.__wasmCsp = true
  })
  await page.evaluate((html) => window.oracle.revise(html), PROBE_APP)
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await waitFor('the probe', () => 'probe' in window)
  const granted = await frame().evaluate(() => window.probe)
  note('frame probe with wasm-unsafe-eval added', granted)
  check('with wasm-unsafe-eval, WebAssembly compiles', granted.wasm === 'compiled', granted.wasm)
  check('with wasm-unsafe-eval, a blob Worker still does not run', granted.worker !== 'ran', granted.worker)

  // 4. The gear itself, drawn.
  errors.length = 0
  await page.evaluate((html) => window.oracle.revise(html), GEAR_APP)
  await waitFor('the gear', () => Boolean(window.gear && window.model))
  await page.addStyleTag({ content: 'iframe { width: 760px !important }' })
  await settle()
  let history = await generated()
  const first = history.at(-1)
  check(
    'Manifold started from the bundled bytes and built a gear with triangles',
    first.triangles > 100 && first.vertices > 100 && first.recipe.teeth === 18,
    { vertices: first.vertices, triangles: first.triangles, size: first.size.map((n) => +n.toFixed(3)) },
  )
  const outline = (await frame().evaluate(() => window.model.inspect())).parts.find((part) => part.path === 'gear')
  check('the gear is a part of the spatial model, placed on screen', Boolean(outline?.screen), outline?.screen)
  await page.screenshot({ path: path.join(EVIDENCE, '1-gear-18.png') })

  // 5. Change a parameter: the mesh follows.
  const counted = history.length
  await frame().evaluate(() => window.model.set('gear', 'teeth', 32))
  await settle()
  history = await generated()
  const more = history.at(-1)
  check(
    'raising teeth from 18 to 32 gives a different mesh: more vertices, a different size',
    history.length > counted && more.recipe.teeth === 32 && more.vertices > first.vertices &&
      Math.abs(more.size[0] - first.size[0]) > 0.05,
    { before: [first.vertices, first.size.map((n) => +n.toFixed(2))], after: [more.vertices, more.size.map((n) => +n.toFixed(2))] },
  )
  await frame().evaluate(() => window.model.set('gear', 'thickness', 0.9))
  await settle()
  const thick = (await generated()).at(-1)
  check('thickness changes only the depth', thick.size[2] > more.size[2] + 0.2 && Math.abs(thick.size[0] - more.size[0]) < 0.01, { z: [more.size[2], thick.size[2]] })
  await frame().evaluate(() => window.model.set('gear', 'holes', 0))
  await settle()
  const solid = (await generated()).at(-1)
  check('without lightening holes there are fewer vertices', solid.vertices < thick.vertices, [thick.vertices, solid.vertices])
  await frame().evaluate(() => {
    window.model.set('gear', 'holes', 5)
    window.model.set('gear', 'teeth', 24)
    window.model.set('gear', 'thickness', 0.5)
  })
  await settle()
  await page.screenshot({ path: path.join(EVIDENCE, '2-gear-24.png') })

  // 6. Select the gear, so its card (and its sliders) is up.
  const box = await (await page.$('iframe')).boundingBox()
  const at = (await frame().evaluate(() => window.model.inspect())).parts.find((part) => part.path === 'gear').screen
  const root = await frame().$eval('.theorem-spatial', (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  await page.mouse.click(box.x + root.left + at[0], box.y + root.top + at[1])
  await frame().waitForSelector('.ts-card input[type=range]', { timeout: 5000 })

  // 7. Regeneration cost: every other tooth count from 8 to 48, each waited for
  // before the next, as the App times it around Manifold and the geometry.
  const each = []
  for (let teeth = 8; teeth <= 48; teeth += 2) {
    const count = (await generated()).length
    await frame().evaluate((value) => window.model.set('gear', 'teeth', value), teeth)
    for (let look = 0; look < 100 && (await generated()).length === count; look++) await page.waitForTimeout(50)
    each.push((await generated()).at(-1))
  }
  const ms = each.map((run) => run.ms).sort((a, b) => a - b)
  const median = ms[Math.floor(ms.length / 2)]
  console.log(
    `     regeneration, ${each.length} tooth counts (${each[0].recipe.teeth}..${each.at(-1).recipe.teeth}): ` +
      `median ${median.toFixed(1)} ms, p90 ${ms[Math.floor(ms.length * 0.9)].toFixed(1)} ms, max ${ms.at(-1).toFixed(1)} ms, ` +
      `${Math.min(...each.map((run) => run.triangles))}..${Math.max(...each.map((run) => run.triangles))} triangles`,
  )
  check('every tooth count produced its own gear', new Set(each.map((run) => run.vertices)).size === each.length, each.map((run) => run.vertices))
  check('regeneration is quick enough for a slider: median under 50 ms', median < 50, median)

  // 8. Whether input is held up while it runs. In the frame: the gap between
  // animation frames and every long task, idle and then while the teeth slider
  // is dragged through its range, one input event per ~16 ms.
  const drag = await frame().evaluate(async () => {
    const sliders = [...document.querySelectorAll('.ts-card input[type=range]')]
    const input = sliders.find((each) => /teeth/.test(each.getAttribute('aria-label') ?? '')) ?? sliders[0]
    const longTasks = []
    const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
    try {
      observer.observe({ type: 'longtask', buffered: false })
    } catch {
      /* not offered */
    }
    const watch = async (work) => {
      const gaps = []
      let previous = performance.now()
      let running = true
      const frames = () => {
        const now = performance.now()
        gaps.push(now - previous)
        previous = now
        if (running) requestAnimationFrame(frames)
      }
      requestAnimationFrame(frames)
      const result = await work()
      running = false
      return { gaps: gaps.slice(1), ...result }
    }
    const idle = await watch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return {}
    })
    const idleLong = longTasks.length
    const before = window.gear.generated.length
    const dragged = await watch(async () => {
      const latencies = []
      for (let value = 8; value <= 48; value++) {
        const sent = performance.now()
        input.value = String(value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        latencies.push(performance.now() - sent)
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { latencies }
    })
    observer.disconnect()
    return { idle, idleLong, dragged, longTasks, regenerations: window.gear.generated.length - before }
  })
  const max = (list) => Math.max(...list)
  const handler = max(drag.dragged.latencies)
  console.log(
    `     frame gaps (software WebGL): idle max ${max(drag.idle.gaps).toFixed(0)} ms, dragging max ${max(drag.dragged.gaps).toFixed(0)} ms; ` +
      `${drag.regenerations} regenerations for 41 slider events (one per frame at most); ` +
      `input handler at most ${handler.toFixed(1)} ms; long tasks (>50 ms) in the frame: ${drag.idleLong} idle (${drag.longTasks.slice(0, drag.idleLong).map((d) => d.toFixed(0))} ms), ${drag.longTasks.length - drag.idleLong} dragging (${drag.longTasks.slice(drag.idleLong).map((d) => d.toFixed(0))} ms)`,
  )
  check('a drag is coalesced: fewer regenerations than slider events, each frame at most one', drag.regenerations > 0 && drag.regenerations < 41, drag.regenerations)
  // Drawing is software WebGL here, so frames are slow with nothing happening;
  // regeneration must not make them slower than that.
  check(
    'input is not held up: no input handler over 16 ms, and dragging adds no frame gap beyond the idle ones',
    handler < 16 && max(drag.dragged.gaps) <= max(drag.idle.gaps) * 1.25 + 16,
    { handler, idleMax: max(drag.idle.gaps), draggingMax: max(drag.dragged.gaps) },
  )
  await settle()
  await page.screenshot({ path: path.join(EVIDENCE, '3-gear-48.png') })

  check('no console errors in the page', errors.length === 0, errors.slice(0, 3))
} finally {
  await browser.close()
  await served.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
