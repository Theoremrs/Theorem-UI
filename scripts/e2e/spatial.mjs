import { mkdirSync } from 'node:fs'
import path from 'node:path'
// A spatial explanation an App builds with @theorem/spatial, handled in a
// browser: it builds and type-checks, draws with depth, a part pulls forward
// with its wires attached, a part opens into its inside, a changed input
// travels stage by stage, and a revision that adds a part nobody had written
// keeps what the person did and lets them use the new part at once.
//
//   bun run e2e:spatial            the page as the dev server serves it
//   bun run e2e:spatial --built    the page built as for production
//
// It serves scripts/e2e/app-ts/ (the real App view over an App document held
// in memory) and drives it in headless Chromium with a GPU-less WebGL.
// Screenshots go to docs/plans/evidence/spatial-2026-11-17/.
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'
import { app, PROCESSOR } from './spatial-fixture.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/spatial-2026-11-17')
mkdirSync(EVIDENCE, { recursive: true })

// The follow-up: "show me what happens inside the ALU when the result is too
// large". The agent writes a part no library had (its form, behavior and
// interaction its own) and adds it to the same model.
const OVERFLOW = `
const overflow: Part = {
  id: 'overflow', label: 'Overflow detector', at: [2.8, -1.8, 0],
  about: 'Compares the true sum with what fits in 4 bits; lights when the top carry is lost.',
  form: (three) => new three.TorusKnotGeometry(0.3, 0.09, 96, 12),
  color: '#c0563b',
  ports: { a: 'in', b: 'in', over: 'out', lost: 'out' },
  state: { limit: 15 },
  controls: { limit: { kind: 'range', min: 3, max: 15, step: 1, label: 'largest that fits' } },
  compute: ({ a, b }, { limit }) => {
    const sum = Number(a) + Number(b)
    return { over: sum > Number(limit) ? 1 : 0, lost: Math.max(0, sum - Number(limit)) }
  },
  show: (object, { values, activity }) => {
    object.rotation.z += 0.01 + 0.08 * activity
    object.scale.setScalar(values.over ? 1.25 : 1)
  },
  checks: [
    { inputs: { a: 9, b: 9 }, expect: { over: 1, lost: 3 } },
    { inputs: { a: 3, b: 4 }, expect: { over: 0, lost: 0 } },
  ],
}
`
const REVISED = PROCESSOR.replace('const alu: Part', `${OVERFLOW}\nconst alu: Part`)
  .replace("result: 'out', carry: 'out' }", "result: 'out', carry: 'out', overflow: 'out' }")
  .replace("    m.wire('add.cout', '.carry')", "    m.wire('add.cout', '.carry')\n    m.part(overflow)\n    m.wire('.a', 'overflow.a')\n    m.wire('.b', 'overflow.b')\n    m.wire('overflow.over', '.overflow')")

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
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`  [console] ${message.text()}`)
})

const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame())
const inspect = () => frame().evaluate(() => window.model.inspect())
const waitModel = async () => {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = await frame()?.evaluate(() => Boolean(window.model)).catch(() => false)
    if (ready) return
    await page.waitForTimeout(200)
  }
  throw new Error('the model never mounted')
}
/** A point inside the App's frame, in page coordinates. */
const onPage = async ([x, y]) => {
  const box = await (await page.$('iframe')).boundingBox()
  const root = await frame().$eval('.theorem-spatial', (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  return [box.x + root.left + x, box.y + root.top + y]
}
const part = async (path) => (await inspect()).parts.find((each) => each.path === path)
const settle = () => page.waitForTimeout(1600)
const shot = async (name) => {
  const element = await page.$('iframe')
  await element.screenshot({ path: path.join(EVIDENCE, `${name}.png`) })
}
const theme = (mode) =>
  page.evaluate((dark) => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, mode === 'dark')

try {
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())

  const checked = await page.evaluate((html) => window.oracle.inspect(html), app(PROCESSOR))
  check(
    'a spatial App builds, type-checks clean and runs, its parts in the outline',
    checked.built && checked.typesChecked && checked.problems.length === 0 && /ALU \(alu\)/.test(checked.rendered?.text ?? ''),
    { problems: checked.problems, text: checked.rendered?.text?.slice(0, 300) },
  )
  const wrong = await page.evaluate(
    (html) => window.oracle.inspect(html, { runMs: 0 }),
    app(PROCESSOR.replace("ports: { on: 'in' }", "ports: { on: 'sideways' }")),
  )
  check(
    'a part written wrong is a type problem at its line',
    wrong.problems.some((p) => p.file === 'main.ts' && p.code === 'TS2322'),
    { problems: wrong.problems.map((p) => [p.file, p.line, p.code]) },
  )

  await page.evaluate((html) => window.oracle.revise(html), app(PROCESSOR))
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  // The oracle page has no Tailwind, so the frame's w-full is given here, at the width of a reply.
  await page.addStyleTag({ content: 'iframe { width: 760px !important }' })
  await waitModel()
  await settle()
  let model = await inspect()
  check(
    'the assembly is drawn with depth: parts at different places in three dimensions',
    model.parts.filter((p) => !p.path.includes('/')).length === 5 &&
      new Set(model.parts.map((p) => p.at.join())).size === model.parts.length &&
      model.parts.every((p) => p.screen),
    model.parts.map((p) => [p.path, p.at, p.screen]),
  )
  check(
    'the model computes: 7 + 5 reaches the ALU result',
    (await part('alu')).outputs.result === 12 && (await part('alu')).outputs.carry === 0,
    (await part('alu')).outputs,
  )
  await theme('light')
  await settle()
  await shot('1-assembly-light')
  await theme('dark')
  await settle()
  await shot('1-assembly-dark')
  await theme('light')

  // Pull the ALU out of the assembly with the mouse.
  const alu = await part('alu')
  const [x, y] = await onPage(alu.screen)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let index = 1; index <= 12; index++) await page.mouse.move(x + index * 9, y - index * 7)
  await page.mouse.up()
  await settle()
  const pulled = await part('alu')
  check(
    'dragging a part pulls it forward and out, the rest stays put',
    pulled.pulled &&
      Math.hypot(pulled.at[0] - alu.at[0], pulled.at[1] - alu.at[1], pulled.at[2] - alu.at[2]) > 0.5 &&
      (await part('a')).at.join() !== '' &&
      (await inspect()).selected === 'alu',
    { before: alu.at, after: pulled.at },
  )
  check(
    'pulled out, it still computes',
    pulled.outputs.result === 12,
  )
  const card = await frame().$eval('.ts-card', (el) => ({
    hidden: el.hidden,
    entity: el.getAttribute('data-entity-id'),
    text: el.textContent,
  }))
  check(
    'a selected part has its card beside it, naming it for Ask',
    !card.hidden && card.entity === 'alu' && /ALU/.test(card.text) && /Put back/.test(card.text),
    card,
  )
  await shot('2-alu-pulled-light')

  // Change an input directly: a bit of register A, from its own card.
  await frame().focus('.theorem-spatial canvas')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  check('Esc puts the part back and lets it go', !(await part('alu')).pulled && (await inspect()).selected === null)
  const a = await part('a')
  const [ax, ay] = await onPage(a.screen)
  await page.mouse.click(ax, ay)
  await page.waitForTimeout(300)
  await frame().click('.ts-card button[aria-label="bit 3 of value"]')
  await page.waitForTimeout(120)
  const travelling = await frame().$eval('.ts-bar', (el) => el.textContent)
  await settle()
  check(
    'setting bit 3 of register A makes 15 + 5: the sum wraps and the carry lamp gets it',
    (await part('a')).state.value === 15 &&
      (await part('alu')).outputs.result === 4 &&
      (await part('alu')).outputs.carry === 1 &&
      (await part('lamp')).inputs.on === 1,
    { a: (await part('a')).state, alu: (await part('alu')).outputs },
  )
  check('the change is seen travelling, stage by stage', /stage \d of \d/.test(travelling), travelling)

  // Open the ALU into its inside.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const aluNow = await part('alu')
  const [ox, oy] = await onPage(aluNow.screen)
  await page.mouse.dblclick(ox, oy)
  await page.waitForTimeout(2200)
  model = await inspect()
  const crumbs = await frame().$eval('.ts-crumbs', (el) => el.textContent)
  check(
    'double-clicking the ALU opens it: its adder, AND bank and mux appear inside it, still connected',
    model.open === 'alu' &&
      ['alu/add', 'alu/and', 'alu/pick'].every((p) => model.parts.find((each) => each.path === p)?.screen) &&
      model.parts.find((p) => p.path === 'alu/add').outputs.sum === 4 &&
      /A 4-bit processor\/ALU/.test(crumbs),
    { open: model.open, crumbs },
  )
  await shot('3-alu-open-light')
  await theme('dark')
  await settle()
  await shot('3-alu-open-dark')
  await theme('light')
  // One level further: the adder's full adders, the carry between them.
  await frame().evaluate(() => window.model.open('alu/add'))
  await page.waitForTimeout(2200)
  model = await inspect()
  check(
    'the adder opens into full adders, the carry from each reaching the next',
    model.open === 'alu/add' &&
      model.parts.find((p) => p.path === 'alu/add/fa3')?.outputs.cout === 1,
    model.parts.filter((p) => p.path.startsWith('alu/add/fa')).map((p) => [p.path, p.outputs]),
  )
  await shot('4-adder-open-light')
  await frame().focus('.theorem-spatial canvas')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  check('Esc goes back up one level', (await inspect()).open === 'alu')

  // The follow-up revision adds a part nobody wrote before, inside the ALU.
  await page.evaluate((html) => window.oracle.revise(html), app(REVISED))
  await page.waitForTimeout(1500)
  await waitModel()
  await page.waitForTimeout(2500)
  model = await inspect()
  const created = model.parts.find((p) => p.path === 'alu/overflow')
  check(
    'the revision keeps what the person did: register A is still 15, the ALU still open',
    (await part('a')).state.value === 15 && model.open === 'alu',
    { a: (await part('a')).state, open: model.open },
  )
  check(
    'the new part is in the same model, wired, computing: 15 + 5 is over by 5',
    created?.screen && created.outputs.over === 1 && created.outputs.lost === 5 && (await part('alu')).outputs.overflow === 1,
    created,
  )
  // Use it at once: select it and move its limit from its own card.
  const [nx, ny] = await onPage(created.screen)
  await page.mouse.click(nx, ny)
  await frame()
    .waitForSelector('.ts-card input[type=range]', { timeout: 3000 })
    .catch(async () => console.log('  no card for the new part:', created.screen, (await part('alu/overflow')).screen, (await inspect()).selected))
  const newCard = await frame().$eval('.ts-card', (el) => el.textContent)
  await frame().$eval('.ts-card input[type=range]', (input) => {
    input.value = '15'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
  check(
    'the person operates the new part immediately, from controls the agent gave it',
    /Overflow detector/.test(newCard) && (await part('alu/overflow')).state.limit === 15,
    { card: newCard.slice(0, 120) },
  )
  await frame().evaluate(() => window.model.set('a', 'value', 3))
  await settle()
  check(
    'and it follows the rest of the model: 3 + 5 fits',
    (await part('alu/overflow')).outputs.over === 0 && (await part('alu')).outputs.result === 8,
  )
  await frame().evaluate(() => window.model.set('a', 'value', 15))
  await settle()
  await shot('5-created-part-light')
  await theme('dark')
  await settle()
  await shot('5-created-part-dark')
} finally {
  await browser.close()
  await served.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
