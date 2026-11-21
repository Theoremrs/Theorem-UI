import { mkdirSync } from 'node:fs'
import path from 'node:path'
// Procedural geometry in an App: a gear written as a recipe and generated with
// Manifold (WebAssembly) in a Worker, drawn by three.js as a @theorem/spatial
// part's form. It builds and type-checks, the mesh has triangles, a changed
// parameter changes the mesh and the view refits to it, regeneration is timed,
// and input stays responsive while it runs.
//
//   bun run e2e:geometry
//
// The App is in geometry-app.mjs. It is served by the real App view over an
// in-memory App document (scripts/e2e/app-ts/) in headless Chromium with a
// GPU-less WebGL. Screenshots go to docs/plans/evidence/geometry-2026-11-17/.
//
// Every App frame may compile WebAssembly and start a Worker from a blob, and
// runs open: such a worker reaches the network. The probe fetches an address
// served here that answers any origin, so a refusal can only be a policy's;
// a frame the person limited with `net` is refused it.
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { GEAR_APP, probeApp } from './geometry-app.mjs'
import { servePage } from './harness.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/geometry-2026-11-17')
mkdirSync(EVIDENCE, { recursive: true })

const served = await servePage('app-ts')
const reach = createServer((_request, response) => {
  response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
  response.end('reached')
})
await new Promise((resolve) => reach.listen(0, '127.0.0.1', resolve))
const PROBE_APP = probeApp(`http://127.0.0.1:${reach.address().port}/probe`)
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
  const runtime = shipped.problems.filter((p) => p.kind === 'runtime')
  check('it runs under the shipped frame policy with no runtime problem', runtime.length === 0, runtime)

  // 2. What the frame permits: a worker, and WebAssembly.
  await page.evaluate((html) => window.oracle.revise(html), PROBE_APP)
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await waitFor('the probe', () => 'probe' in window)
  const probe = await frame().evaluate(() => window.probe)
  note('shipped frame probe', probe)
  check('a Worker from a blob runs in the frame and reaches the network', probe.worker === 'ran, fetched reached', probe.worker)
  check('WebAssembly compiles in the frame', probe.wasm === 'compiled', probe.wasm)

  // 3. The gear itself, drawn.
  errors.length = 0
  await page.evaluate((html) => window.oracle.revise(html), GEAR_APP)
  await waitFor('the gear', () => Boolean(window.gear && window.model))
  await page.addStyleTag({ content: 'iframe { width: 760px !important }' })
  await settle()
  let history = await generated()
  const first = history.at(-1)
  check(
    'Manifold started from the bundled bytes, in a Worker, and built a gear with triangles',
    first.inWorker && first.triangles > 100 && first.vertices > 100 && first.recipe.teeth === 18,
    { inWorker: first.inWorker, vertices: first.vertices, triangles: first.triangles, size: first.size.map((n) => +n.toFixed(3)) },
  )
  const outline = (await frame().evaluate(() => window.model.inspect())).parts.find((part) => part.path === 'gear')
  check('the gear is a part of the spatial model, placed on screen', Boolean(outline?.screen), outline?.screen)
  const shot = async (name) => (await page.$('iframe')).screenshot({ path: path.join(EVIDENCE, name) })
  await shot('1-gear-18.png')

  // 4. Change a parameter: the mesh follows, and so does the view.
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
  const drawn = (await frame().evaluate(() => window.model.inspect())).parts.find((part) => part.path === 'gear').size
  check(
    'the view refits to the regenerated mesh: the part it reports is the new size',
    Math.abs(drawn[0] - more.size[0]) < 0.01 && Math.abs(drawn[1] - more.size[1]) < 0.01,
    { drawn, mesh: more.size.map((n) => +n.toFixed(3)) },
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
  await shot('2-gear-24.png')

  // 5. Select the gear, so its card (and its sliders) is up.
  const box = await (await page.$('iframe')).boundingBox()
  const at = (await frame().evaluate(() => window.model.inspect())).parts.find((part) => part.path === 'gear').screen
  const root = await frame().$eval('.theorem-spatial', (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  await page.mouse.click(box.x + root.left + at[0], box.y + root.top + at[1])
  await frame().waitForSelector('.ts-card [role=slider]', { timeout: 5000 })

  // 6. Regeneration cost: every other tooth count from 8 to 48, each waited for
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
      `round trip median ${median.toFixed(1)} ms (Manifold in the worker: median ${each.map((run) => run.manifoldMs).sort((a, b) => a - b)[Math.floor(each.length / 2)].toFixed(1)} ms), p90 ${ms[Math.floor(ms.length * 0.9)].toFixed(1)} ms, max ${ms.at(-1).toFixed(1)} ms, ` +
      `${Math.min(...each.map((run) => run.triangles))}..${Math.max(...each.map((run) => run.triangles))} triangles`,
  )
  check('every tooth count produced its own gear', new Set(each.map((run) => run.vertices)).size === each.length, each.map((run) => run.vertices))
  check('regeneration is quick enough for a slider: median under 50 ms', median < 50, median)

  // 7. Whether input is held up while it runs, measured in the frame, idle and
  // then while the teeth slider is driven through its range from the keyboard:
  // how long the page took to handle each key (Event Timing), and how long
  // script held each slow frame and what of it blocked input (Long Animation
  // Frames). Frame gaps are logged too; drawing here is software WebGL, so
  // they are mostly rasterising, not the page's own work.
  const teeth = frame().getByRole('slider', { name: 'teeth' })
  await teeth.focus()
  await teeth.press('Home')
  await settle()
  const watch = () =>
    frame().evaluate(() => {
      const seen = { gaps: [], longTasks: [], keys: [], frames: [], running: true, from: window.gear.generated.length }
      let previous = performance.now()
      const frames = () => {
        const now = performance.now()
        seen.gaps.push(now - previous)
        previous = now
        if (seen.running) requestAnimationFrame(frames)
      }
      requestAnimationFrame(frames)
      const take = {
        longtask: (entry) => seen.longTasks.push(entry.duration),
        event: (entry) => entry.name === 'keydown' && seen.keys.push(entry.processingEnd - entry.processingStart),
        'long-animation-frame': (entry) =>
          seen.frames.push({
            duration: entry.duration,
            blocking: entry.blockingDuration,
            script: entry.scripts.reduce((sum, script) => sum + script.duration, 0),
          }),
      }
      seen.observers = Object.entries(take).map(([type, each]) => {
        const observer = new PerformanceObserver((list) => list.getEntries().forEach(each))
        try {
          observer.observe({ type, buffered: false, durationThreshold: 16 })
        } catch {
          /* not offered */
        }
        return observer
      })
      window.__seen = seen
    })
  const stop = () =>
    frame().evaluate(() => {
      const seen = window.__seen
      seen.running = false
      for (const observer of seen.observers) observer.disconnect()
      return { gaps: seen.gaps.slice(1), longTasks: seen.longTasks, keys: seen.keys, frames: seen.frames, regenerations: window.gear.generated.length - seen.from }
    })
  await watch()
  await page.waitForTimeout(1500)
  const idle = await stop()
  await watch()
  for (let key = 0; key < 40; key++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(600)
  const dragged = await stop()
  const max = (list) => (list.length ? Math.max(...list) : 0)
  const last = (await generated()).at(-1)
  console.log(
    `     frame gaps (software WebGL): idle max ${max(idle.gaps).toFixed(0)} ms, sliding max ${max(dragged.gaps).toFixed(0)} ms; ` +
      `${dragged.regenerations} regenerations for 40 keys; slowest key handler ${max(dragged.keys).toFixed(1)} ms; ` +
      `long tasks (>50 ms) in the frame: ${idle.longTasks.length} idle, ${dragged.longTasks.length} sliding (${dragged.longTasks.map((d) => d.toFixed(0))} ms); ` +
      `slowest frames idle ${[...idle.gaps].sort((a, b) => b - a).slice(0, 5).map((d) => d.toFixed(0))}, sliding ${[...dragged.gaps].sort((a, b) => b - a).slice(0, 8).map((d) => d.toFixed(0))} of ${dragged.gaps.length}`,
  )
  check(
    'a slide never queues work: at most one regeneration per key, ending on the last value',
    dragged.regenerations > 0 && dragged.regenerations <= 40 && last.recipe.teeth === 48,
    { regenerations: dragged.regenerations, last: last.recipe.teeth },
  )
  // Drawing is software WebGL here, so frames are slow with nothing happening;
  // regeneration must not make them slower than that.
  const blocking = max(dragged.frames.map((frame) => frame.blocking))
  const script = max(dragged.frames.map((frame) => frame.script))
  console.log(`     long animation frames while sliding: ${dragged.frames.length}, most script in one ${script.toFixed(1)} ms, most blocking ${blocking.toFixed(1)} ms`)
  check(
    'input is not held up: no key handler over 16 ms, no frame blocks input, and no frame holds 16 ms of script',
    max(dragged.keys) < 16 && blocking === 0 && script < 16,
    { handler: max(dragged.keys), blocking, script, slowFrames: dragged.frames.length },
  )
  await settle()
  await shot('3-gear-48.png')

  check('no console errors in the page', errors.length === 0, errors.slice(0, 3))

  // 8. A frame the person limited with `net` is refused the address the open
  // frame reached: the refusal is the limit's, not the address's.
  await startOracle()
  await page.evaluate((html) => window.oracle.limited(html, []), PROBE_APP)
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await waitFor('the limited probe', () => 'probe' in window && 'wasm' in window.probe)
  const limited = await frame().evaluate(() => window.probe)
  note('limited frame probe', limited)
  check('a frame limited to no hosts runs the Worker, which is refused the network', limited.worker === 'ran, fetch refused', limited.worker)
} finally {
  await browser.close()
  await served.close()
  reach.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
