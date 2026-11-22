import { mkdirSync } from 'node:fs'
import path from 'node:path'
// The spatial chrome's glass (liquidGL, annotate/glass.tsx), seen in a browser:
// a pinned note dragged over the scene refracts the scene behind it, in light
// and in dark, and the glass draws under the note and nowhere else.
//
//   node scripts/e2e/glass.mjs
//
// It serves scripts/e2e/app-ts/ and drives the processor App of
// spatial-fixture.mjs in headless Chromium with a GPU-less WebGL. Screenshots
// go to docs/plans/evidence/spatial-2026-11-17/.
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'
import { app, PROCESSOR } from './spatial-fixture.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/spatial-2026-11-17')
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
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 })
page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`))

const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame())
const inspect = () => frame().evaluate(() => window.model.inspect())
const part = async (id) => (await inspect()).parts.find((each) => each.path === id)
const settle = () => page.waitForTimeout(1600)
/** A rectangle in the frame's viewport, in page coordinates. */
const inPage = async (rect) => {
  const box = await (await page.$('iframe')).boundingBox()
  return { x: box.x + rect.x, y: box.y + rect.y, width: rect.width, height: rect.height }
}
/** A point on the stage, from the view's own coordinates, in page coordinates. */
const onStage = async ([x, y]) => {
  const root = await frame().$eval('.theorem-spatial', (el) => el.getBoundingClientRect().toJSON())
  const { x: px, y: py } = await inPage({ x: root.left + x, y: root.top + y, width: 0, height: 0 })
  return [px, py]
}
const rectOf = (selector) => frame().$eval(selector, (el) => el.getBoundingClientRect().toJSON())
const theme = (mode) =>
  page.evaluate((dark) => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, mode === 'dark')

/** The share of a picture's pixels unlike its commonest colour: 0 for a blank one. */
const busy = (png) =>
  page.evaluate(async (data) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const { data: pixels } = context.getImageData(0, 0, image.width, image.height)
    const counts = new Map()
    for (let i = 0; i < pixels.length; i += 4) {
      const key = (pixels[i] >> 4) << 8 | (pixels[i + 1] >> 4) << 4 | pixels[i + 2] >> 4
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const commonest = Math.max(...counts.values())
    return 1 - commonest / (pixels.length / 4)
  }, png.toString('base64'))

/** Only what liquidGL draws: the scene, the labels, notes and strip hidden. */
const glassOnly = async (clip) => {
  const style = await frame().addStyleTag({
    content: '.tn-layer, .ts-chrome, .ts-stage > canvas { visibility: hidden !important }',
  })
  await page.waitForTimeout(300)
  const png = await page.screenshot({ clip })
  await style.evaluate((element) => element.remove())
  return png
}

try {
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())
  await page.evaluate((html) => window.oracle.revise(html), app(PROCESSOR))
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  await page.addStyleTag({ content: 'iframe { width: 760px !important }' })
  await frame().waitForFunction(() => window.model?.inspect, null, { timeout: 90_000 })
  await settle()

  // Select the ALU, pin its note, and drag the note by its head over the scene.
  await page.mouse.click(...(await onStage((await part('alu')).screen)))
  await page.waitForTimeout(800)
  await frame().click('.ts-card[data-entity-id="alu"] button[aria-label="Pin"]')
  await settle()
  const head = await inPage(await rectOf('.ts-card[data-entity-id="alu"] .tn-note-head'))
  const alu = (await part('alu')).box
  const [toX, toY] = await onStage([alu.x + alu.width * 0.25, alu.y + alu.height * 0.2])
  const from = [head.x + 24, head.y + head.height / 2]
  await page.mouse.move(...from)
  await page.mouse.down()
  for (let step = 1; step <= 12; step++)
    await page.mouse.move(from[0] + ((toX - from[0]) * step) / 12, from[1] + ((toY - from[1]) * step) / 12)
  await page.mouse.up()
  await settle()

  const note = await inPage(await rectOf('.ts-card[data-entity-id="alu"] .tn-note-frame'))
  const stage = await inPage(await rectOf('.ts-stage'))
  const over = (await part('alu')).box
  const covering = await onStage([over.x + over.width / 2, over.y + over.height / 2])
  check(
    'the pinned note is dragged over the scene, the ALU behind it',
    covering[0] > note.x && covering[0] < note.x + note.width && covering[1] > note.y && covering[1] < note.y + note.height,
    { note, alu: covering },
  )
  const lens = await frame().evaluate(() => document.querySelector('.ts-card[data-entity-id="alu"] .tn-note-frame')?.getAttribute('data-glass'))
  check('the note is a liquidGL lens', lens === 'gl', lens)

  // A stretch of stage with no lens over it, beside the note: the glass leaves it bare.
  const bare = { x: stage.x + 8, y: stage.y + stage.height - 90, width: 120, height: 60 }
  for (const mode of ['light', 'dark']) {
    await theme(mode)
    await settle()
    const clip = { x: note.x - 24, y: note.y - 24, width: note.width + 48, height: note.height + 48 }
    await page.screenshot({ clip, path: path.join(EVIDENCE, `6-glass-over-scene-${mode}.png`) })
    const behind = await busy(await glassOnly({ x: note.x + 4, y: note.y + 4, width: note.width - 8, height: note.height - 8 }))
    const elsewhere = await busy(await glassOnly(bare))
    check(
      `${mode}: under the note the glass draws the scene behind it, and beside it nothing`,
      behind > 0.05 && elsewhere < 0.01,
      { behind: Number(behind.toFixed(3)), elsewhere: Number(elsewhere.toFixed(3)) },
    )
  }
  await theme('light')
} catch (error) {
  check('the run finished', false, String(error?.stack ?? error))
} finally {
  await browser.close()
  await served.close?.()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
