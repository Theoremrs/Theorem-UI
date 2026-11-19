import { mkdirSync } from 'node:fs'
import path from 'node:path'
// Reference extraction, shown on two subjects: a guitar generated from a
// measured drawing, and the 6502 from its die and package photos. The
// references were traced agent-side (scripts/e2e/reference/trace.py, the
// VTracer CLI) into the recipes the Apps carry; the guitar App also traces a
// drawing it is handed, in the App, with imagetracerjs.
//
//   bun run e2e:reference
//
// Each App builds and type-checks; Manifold builds its geometry in a Worker;
// the parts are the sizes the references measured; the behaviour's checks
// pass; a drawing handed to the guitar is traced and the body rebuilt from it;
// input is not held up while that runs. Screenshots, inline and expanded,
// wide and narrow, go to docs/plans/evidence/reference-2026-11-17/;
// scripts/e2e/reference/compare.py then sets them beside the references.
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'
import { CPU_APP, GUITAR_APP } from './reference-apps.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/reference-2026-11-17')
const FIXTURE = path.join(import.meta.dirname, 'reference', 'frias-front.png')
mkdirSync(EVIDENCE, { recursive: true })

const served = await servePage('app-ts')
const checks = []
const check = (name, pass, detail) => {
  checks.push(pass)
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
}
const note = (name, detail) => console.log(`note ${name}: ${JSON.stringify(detail)}`)
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance * Math.abs(b)

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 })
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
const settle = (ms = 1200) => page.waitForTimeout(ms)
const frameWidth = (width) => page.addStyleTag({ content: `iframe { width: ${width}px !important }` })
const inspect = () => frame().evaluate(() => window.model.inspect())
const partOf = async (path) => (await inspect()).parts.find((part) => part.path === path)
const shot = async (name) => (await page.$('iframe')).screenshot({ path: path.join(EVIDENCE, `${name}.png`) })
const shotPage = (name) => page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) })

/** Long animation frames and key handling in the frame while `during` runs. */
async function watching(during) {
  await frame().evaluate(() => {
    const seen = { keys: [], frames: [] }
    const take = {
      event: (entry) => entry.name === 'keydown' && seen.keys.push(entry.processingEnd - entry.processingStart),
      'long-animation-frame': (entry) =>
        seen.frames.push({ duration: entry.duration, blocking: entry.blockingDuration, script: entry.scripts.reduce((sum, script) => sum + script.duration, 0) }),
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
  await during()
  return frame().evaluate(() => {
    const seen = window.__seen
    for (const observer of seen.observers) observer.disconnect()
    return { keys: seen.keys, frames: seen.frames }
  })
}
const max = (list) => (list.length ? Math.max(...list) : 0)

/** Expanded: the inline artifact's own Expand, the whole page shot, then collapsed again. */
async function expanded(name) {
  await page.getByRole('button', { name: 'Expand' }).click()
  await settle(1800)
  await shotPage(name)
  await page.getByRole('button', { name: 'Collapse' }).click()
  await settle(1200)
}

try {
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())

  // 1. Both Apps build, type-check against their packages, and run clean
  // (a failing spatial check is reported as a runtime problem).
  for (const [name, html] of [['guitar', GUITAR_APP], ['6502', CPU_APP]]) {
    const result = await page.evaluate((source) => window.oracle.inspect(source, { runMs: 8000 }), html)
    const compile = result.problems.filter((p) => p.kind === 'build' || p.kind === 'type')
    check(`the ${name} App builds and type-checks`, result.built && result.typesChecked && compile.length === 0, compile.slice(0, 6))
    const runtime = result.problems.filter((p) => p.kind === 'runtime')
    check(`the ${name} App runs with no runtime problem, its checks included`, runtime.length === 0, runtime.slice(0, 6))
  }

  // 2. The guitar.
  await page.evaluate((html) => window.oracle.revise(html), GUITAR_APP)
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await waitFor('the guitar', () => Boolean(window.guitar && window.model))
  await frameWidth(760)
  await settle(2000)
  const first = await frame().evaluate(() => window.guitar.history[0])
  check('Manifold built the guitar in a Worker from the recipe', first.inWorker && first.outline === 'recipe' && first.triangles > 1000, first)
  let model = await inspect()
  check('the guitar\'s own checks pass', model.failures.length === 0, model.failures)
  const top = await partOf('top')
  // The drawing measured 28.0 cm across and 46.3 cm long; one unit is 10 cm.
  check('the soundboard is the size the drawing measured: 28.0 by 46.3 cm', near(top.size[0], 2.8, 0.01) && near(top.size[1], 4.63, 0.01), top.size)
  const strings = await partOf('strings')
  check('the strings start on E4 at 329.6 Hz', strings.outputs.note === 'E4' && strings.outputs.hz === 329.63, strings.outputs)
  await shot('guitar-1-inline-wide')
  await expanded('guitar-2-expanded')

  for (const [state, expect] of [
    [{ fret: 12 }, 'E5'],
    [{ string: 'A2', fret: 5 }, 'D3'],
    [{ string: 'D3', fret: 0, tension: 70 }, 'D3'],
  ]) {
    await frame().evaluate((values) => Object.entries(values).forEach(([key, value]) => window.model.set('strings', key, value)), state)
    await settle(300)
    const sounding = (await partOf('strings')).outputs
    check(`strings, ${JSON.stringify(state)}: ${expect}`, sounding.note === expect, sounding)
  }
  await frame().evaluate(() => {
    window.model.set('strings', 'string', 'G3')
    window.model.set('strings', 'fret', 7)
    window.model.set('strings', 'tension', 70)
    window.model.select('strings')
  })
  await settle()
  await shot('guitar-3-strings')

  await frame().evaluate(() => window.model.open('top'))
  await settle(2200)
  model = await inspect()
  const inside = model.parts.filter((part) => part.path.startsWith('top/')).map((part) => part.label)
  check('opening the soundboard shows the plate and the four kinds of bracing traced', inside.length === 5, inside)
  await shot('guitar-4-bracing')
  await frame().evaluate(() => {
    window.model.open('')
    window.model.select(null)
  })
  // Closing takes about two seconds; a rebuilt part refits once it is closed.
  await settle(2600)

  // 3. Hand the guitar a different drawing: it traces it in its worker and
  // rebuilds the body from the outline, through the same recipe.
  const before = (await partOf('top')).size
  const traced = await watching(async () => {
    await frame().setInputFiles('input[type=file]', FIXTURE)
    await waitFor('the trace', () => window.guitar.traces.length > 0)
    await settle(1500)
  })
  const trace = await frame().evaluate(() => window.guitar.traces[0])
  note('in-App trace', trace)
  check('the drawing was traced in the worker by imagetracerjs', trace.inWorker && trace.points > 30, { points: trace.points, ms: Math.round(trace.ms) })
  const rebuilt = await frame().evaluate(() => window.guitar.history.at(-1))
  check('the body was rebuilt from the traced outline', rebuilt.outline === 'traced' && rebuilt.inWorker, rebuilt)
  // The part refits to its new mesh on a frame after the swap.
  const swapped = Date.now()
  for (let look = 0; look < 100 && (await partOf('top')).size[0] === before[0]; look++) await page.waitForTimeout(100)
  note('the soundboard refitted after', `${Date.now() - swapped} ms`)
  const after = (await partOf('top')).size
  check(
    'the soundboard is now the traced outline: the recipe\'s length, its own width',
    near(after[1], 4.63, 0.01) && Math.abs(after[0] - before[0]) > 0.02 && near(after[0] / after[1], trace.ratio, 0.02),
    { before, after, tracedRatio: +trace.ratio.toFixed(3) },
  )
  const observed = await frame().evaluate(() => PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))
  check('long animation frames are observed in this browser, so the next check means something', observed)
  const blocking = max(traced.frames.map((each) => each.blocking))
  const script = max(traced.frames.map((each) => each.script))
  note('long animation frames while tracing and rebuilding', { count: traced.frames.length, blocking, script: +script.toFixed(1) })
  check('tracing and rebuilding do not block input: no frame blocks it', blocking === 0, { blocking, script: +script.toFixed(1) })
  await shot('guitar-5-traced-wide')
  model = await inspect()
  check('the checks still pass after the rebuild', model.failures.length === 0, model.failures)

  await frameWidth(380)
  await settle(2400)
  await shot('guitar-6-traced-narrow')
  await frame().evaluate(() => document.querySelector('button')?.click())
  await waitFor('the measured outline', () => window.guitar.history.at(-1).outline === 'recipe')
  await settle(1500)
  const restored = (await partOf('top')).size
  check('going back restores the measured outline', near(restored[0], 2.8, 0.01), restored)
  await shot('guitar-7-narrow')

  // 4. The 6502.
  errors.length = 0
  await page.evaluate((html) => window.oracle.revise(html), CPU_APP)
  await waitFor('the 6502', () => Boolean(window.cpu && window.model))
  await frameWidth(760)
  await settle(2000)
  const built = await frame().evaluate(() => window.cpu.built)
  check('Manifold built the package and die in a Worker', built.inWorker, built)
  model = await inspect()
  check('the 6502\'s own checks pass', model.failures.length === 0, model.failures)
  const body = await partOf('package')
  check('the package is the size measured from its photo: 53.19 by 12.19 mm', near(body.size[0], 5.319, 0.01) && near(body.size[1], 1.219, 0.01), body.size)
  const pins = await partOf('pins')
  check('forty pins span the body\'s length at the measured pitch: 19 pitches plus a shoulder', near(pins.size[0], (19 * 2.54 + 1.5) / 10, 0.01), pins.size)
  await shot('cpu-1-inline-wide')
  await expanded('cpu-2-expanded')

  await frame().evaluate(() => {
    window.model.set('pins', 'address', 0x8001)
    window.model.set('pins', 'data', 0xff)
    window.model.set('pins', 'read', false)
  })
  await settle(400)
  const driven = (await partOf('pins')).outputs
  check('address $8001, data $ff, writing: A0, A15 and all eight data pins high', JSON.stringify(driven.high) === JSON.stringify([9, 25, 26, 27, 28, 29, 30, 31, 32, 33]), driven)
  await frame().evaluate(() => window.model.select('pins'))
  await settle()
  await shot('cpu-3-bus')
  await frame().evaluate(() => {
    window.model.select(null)
    window.model.open('package')
  })
  await settle(2400)
  model = await inspect()
  const die = model.parts.filter((part) => part.path.startsWith('package/')).map((part) => part.label)
  check('opening the package shows the die, its three blocks, pads, bond wires and lead fingers', die.length === 7, die)
  await shot('cpu-4-die')
  await frameWidth(380)
  await settle(2400)
  await shot('cpu-5-die-narrow')
  await frame().evaluate(() => window.model.open(''))
  await settle(2000)
  await shot('cpu-6-narrow')

  check('no console errors in the page', errors.length === 0, errors.slice(0, 3))
} finally {
  await browser.close()
  await served.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
