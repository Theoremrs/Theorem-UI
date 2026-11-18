import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
// The processor with no part given a place, arranged by stage and by ELK, at
// 760 px and 400 px wide, light theme: the top level and the ALU opened. Also
// checks that ELK's arrangement is in place before anything is drawn (no
// frame shows the stage arrangement and then the ELK one), that its wires run
// left to right, and that a part's `at` still wins.
//
//   node scripts/e2e/arrangement.mjs
//
// Screenshots, labelled on the image and in the filename, and the part
// positions go to docs/plans/evidence/arrangement-2026-11-17/.
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'
import { app, PROCESSOR, UNPLACED_PROCESSOR } from './spatial-fixture.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/arrangement-2026-11-17')
mkdirSync(EVIDENCE, { recursive: true })

const served = await servePage('app-ts')
const checks = []
const check = (name, pass, detail) => {
  checks.push(pass)
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
}
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

/** Records, every animation frame in every frame of the page, whether the model (its canvas and the names over it) is visible and where part `a` is. */
const recorder = () => {
  const frames = []
  window.__frames = frames
  const tick = () => {
    const view = document.querySelector('.theorem-spatial')
    if (window.model && view?.querySelector('canvas')) {
      const a = window.model.inspect().parts.find((part) => part.path === 'a')
      frames.push({ shown: getComputedStyle(view).opacity !== '0', at: a?.at })
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const run = async (mode, width, source, name) => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 })
  page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`))
  await page.addInitScript(recorder)
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())
  await page.evaluate((html) => window.oracle.revise(html), app(source))
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await page.addStyleTag({ content: `iframe { width: ${width}px !important }` })
  const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame())
  const deadline = Date.now() + 90_000
  while (!(await frame()?.evaluate(() => Boolean(window.model)).catch(() => false))) {
    if (Date.now() > deadline) throw new Error('the model never mounted')
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(1800)
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.style.colorScheme = 'light'
  })
  const label = async (text) => {
    await page.evaluate((words) => {
      document.getElementById('arrangement-label')?.remove()
      const box = document.querySelector('iframe').getBoundingClientRect()
      const tag = document.createElement('div')
      tag.id = 'arrangement-label'
      tag.textContent = words
      tag.style.cssText = `position:fixed;right:${innerWidth - box.right + 8}px;top:${box.top + 6}px;padding:3px 8px;border-radius:4px;background:#1c1b1a;color:#fff;font:600 12px ui-monospace,monospace;z-index:9`
      document.body.append(tag)
    }, text)
  }
  const shot = async (suffix, words) => {
    await label(words)
    await (await page.$('iframe')).screenshot({ path: path.join(EVIDENCE, `${name}-${width}px-${suffix}.png`) })
  }
  const inspect = () => frame().evaluate(() => window.model.inspect())
  const top = await inspect()
  await shot('assembly', `${mode} - ${width}px - top level`)
  // Selecting the accumulator, which ELK puts at the right where the note opens:
  // the camera makes room for the note, so the card does not cover the part.
  const offset = await page.$eval('iframe', (el) => el.getBoundingClientRect())
  const accBox = top.parts.find((part) => part.path === 'acc').box
  await page.mouse.click(offset.x + accBox.x + accBox.width / 2, offset.y + accBox.y + accBox.height / 2)
  await page.waitForTimeout(1600)
  const selection = await frame().evaluate(() => {
    const box = window.model.inspect().parts.find((part) => part.path === 'acc').box
    const card = document.querySelector('.ts-card')?.getBoundingClientRect()
    const dock = Boolean(document.querySelector('.ts-dock'))
    if (!card || !box) return { dock, cover: null }
    const w = Math.max(0, Math.min(card.right, box.x + box.width) - Math.max(card.left, box.x))
    const h = Math.max(0, Math.min(card.bottom, box.y + box.height) - Math.max(card.top, box.y))
    return { dock, cover: (w * h) / (box.width * box.height) }
  })
  await shot('acc-selected', `${mode} - ${width}px - accumulator selected`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  await frame().evaluate(() => window.model.open('alu'))
  await page.waitForTimeout(2400)
  const inside = await inspect()
  await shot('alu-open', `${mode} - ${width}px - ALU open`)
  const frames = await frame().evaluate(() => window.__frames)
  writeFileSync(path.join(EVIDENCE, `${name}-${width}px-parts.json`), JSON.stringify({ top: top.parts, inside: inside.parts.filter((p) => p.path.startsWith('alu/')) }, null, 1))
  await page.close()
  return { top, inside, frames, selection }
}

try {
  const results = {}
  for (const width of [760, 400])
    for (const mode of ['stages', 'elk']) results[`${mode}-${width}`] = await run(mode, width, UNPLACED_PROCESSOR(mode), mode)

  const elk = results['elk-760']
  const x = (model, path) => model.top.parts.find((part) => part.path === path).at[0]
  check(
    'with ELK, the top level reads left to right along its wires: registers, ALU, then accumulator and lamp',
    x(elk, 'a') < x(elk, 'alu') && x(elk, 'b') < x(elk, 'alu') && x(elk, 'alu') < x(elk, 'acc') && x(elk, 'alu') < x(elk, 'lamp'),
    elk.top.parts.map((part) => [part.path, part.at]),
  )
  const stages = results['stages-760']
  check(
    'by stage, the accumulator (a register, stage 0) sits left of the ALU that feeds it',
    x(stages, 'acc') < x(stages, 'alu'),
    stages.top.parts.map((part) => [part.path, part.at]),
  )
  const shown = elk.frames.filter((frame) => frame.shown)
  const settledAt = shown.at(-1)?.at
  check(
    'ELK is in place before the canvas is shown: no frame draws the stage arrangement first',
    elk.frames.length > 0 && shown.length > 0 && shown.every((frame) => frame.at.join() === settledAt.join()),
    { frames: elk.frames.length, hidden: elk.frames.length - shown.length, shown: shown.length },
  )
  check(
    'with ELK, a selected part keeps clear of its note: the card at 760 px, the dock at 400 px',
    elk.selection.cover !== null && elk.selection.cover < 0.05 && results['elk-400'].selection.dock,
    { 760: elk.selection, 400: results['elk-400'].selection },
  )
  const inside = (model, path) => model.inside.parts.find((part) => part.path === path)
  check(
    'inside the ALU the adder and the AND bank feed the mux, which sits to their right',
    inside(elk, 'alu/add').screen && inside(elk, 'alu/pick').screen,
    elk.inside.parts.filter((part) => part.path.split('/').length === 2).map((part) => [part.path, part.screen]),
  )

  // An authored `at` still wins over ELK: the processor as written, asked for ELK.
  const kept = await run('elk', 760, PROCESSOR.replace("remember: 'model' }", "remember: 'model', arrange: 'elk' }"), 'elk-authored')
  const authored = new Map(kept.top.parts.map((part) => [part.path, part.at.join()]))
  check(
    'a model that gives every part an `at` is drawn exactly there, asked for ELK or not',
    authored.get('a') === '-3.4,1,0' && authored.get('lamp') === '3.2,-1.3,0' && authored.get('acc') === '3.2,0.8,0',
    [...authored],
  )
} finally {
  await browser.close()
  await served.close()
}
const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
