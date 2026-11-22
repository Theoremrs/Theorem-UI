import { mkdirSync } from 'node:fs'
import path from 'node:path'
// A spatial explanation an App builds with @theorem/spatial, handled in a
// browser: it builds and type-checks, draws with depth, a part pulls forward
// with its wires attached, a part opens into its inside, a changed input
// travels stage by stage, and a revision that adds a part nobody had written
// keeps what the person did and lets them use the new part at once. Its
// labels, notes and controls are @theorem/annotate over the scene: a note stays
// attached to its part while the camera and the part move, labels never cover
// controls, and it works by keyboard, by touch, and at a phone's width.
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
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2, hasTouch: true })
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
const frameWidth = (width) => page.addStyleTag({ content: `iframe { width: ${width}px !important }` })

/**
 * Whether the selected part's note is attached to it, read in one frame: its
 * mark is around the part's screen box, its leader runs from the mark to the
 * card, and the card is off the part and inside the stage. Problems are listed;
 * none means attached.
 * While things move, `slack` allows for the frame the layer places in, and a
 * part dragged into the note's band may go partly under the card's edge
 * (`cover`, a share of the part's box) when the other side would bury other
 * parts; never most of it. Settled, the camera refits and the card is off it.
 */
const MOVING = { slack: 10, cover: 0.35 }
const attachment = (path, { slack = 1, cover = 0.05 } = {}) =>
  frame().evaluate(
    ({ path, slack, cover }) => {
      const gapTo = (point, box) =>
        Math.hypot(Math.max(box.x - point[0], 0, point[0] - box.x - box.width), Math.max(box.y - point[1], 0, point[1] - box.y - box.height))
      const slot = document.querySelector(`.tn-slot.ts-card[data-entity-id="${CSS.escape(path)}"]:not([data-hidden])`)
      if (!slot) return ['no note']
      const box = window.model.inspect().parts.find((p) => p.path === path)?.box
      if (!box) return ['part not drawn']
      const layer = slot.closest('.tn-layer').getBoundingClientRect()
      const rect = slot.getBoundingClientRect()
      const card = { x: rect.left - layer.left, y: rect.top - layer.top, width: rect.width, height: rect.height }
      const group = document.querySelector(`g.tn-annotation[data-anchor="${CSS.escape(slot.dataset.anchor)}"]`)
      const numbers = (group.querySelector('.tn-connector').getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
      const from = numbers.slice(0, 2)
      const to = numbers.slice(-2)
      const mark = group.querySelector('.tn-subject').getBBox()
      // The card, less the slack, over the part's box.
      const covered =
        Math.max(0, Math.min(card.x + card.width - slack, box.x + box.width) - Math.max(card.x + slack, box.x)) *
        Math.max(0, Math.min(card.y + card.height - slack, box.y + box.height) - Math.max(card.y + slack, box.y))
      const problems = []
      if (gapTo([box.x + box.width / 2, box.y + box.height / 2], mark) > slack) problems.push('mark is not around the part')
      if (from.length < 2 || gapTo(from, mark) > 3 + slack) problems.push('leader does not start at the mark')
      if (to.length < 2 || gapTo(to, card) > 3 + slack) problems.push('leader does not reach the card')
      if (covered > cover * box.width * box.height) problems.push(`card covers ${Math.round((100 * covered) / (box.width * box.height))}% of the part`)
      if (card.x < -1 || card.y < -1 || card.x + card.width > layer.width + 1 || card.y + card.height > layer.height + 1)
        problems.push('card leaves the stage')
      return problems
    },
    { path, slack, cover },
  )

/** A point on the stage over no part, for orbiting. */
const emptyPoint = async () => {
  const model = await inspect()
  const [width, height] = await frame().$eval('.ts-stage', (el) => [el.clientWidth, el.clientHeight])
  for (let y = height - 24; y > 24; y -= 16)
    for (let x = 24; x < width - 24; x += 16)
      if (model.parts.every((p) => !p.box || x < p.box.x - 20 || x > p.box.x + p.box.width + 20 || y < p.box.y - 20 || y > p.box.y + p.box.height + 20)) {
        const free = await frame().evaluate(([x, y]) => {
          const stage = document.querySelector('.ts-stage').getBoundingClientRect()
          return document.elementFromPoint(stage.left + x, stage.top + y)?.tagName === 'CANVAS'
        }, [x, y])
        if (free) return [x, y]
      }
  throw new Error('no empty point on the stage')
}

/** Labels and tags over anything the person operates, and anything outside the stage. */
const covered = () =>
  frame().evaluate(() => {
    const box = (el) => el.getBoundingClientRect()
    const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
    const operated = [...document.querySelectorAll('.tn-slot.ts-card:not([data-hidden]), .ts-crumbs, .ts-bar, .ts-dock')]
    const stage = box(document.querySelector('.ts-stage'))
    const problems = []
    for (const slot of document.querySelectorAll('.tn-slot:not([data-hidden]):not(.ts-card)')) {
      const own = box(slot)
      for (const other of operated) if (hit(own, box(other))) problems.push(`${slot.dataset.anchor} over ${other.className}`)
      if (own.left < stage.left - 1 || own.top < stage.top - 1 || own.right > stage.right + 1 || own.bottom > stage.bottom + 1)
        problems.push(`${slot.dataset.anchor} outside the stage`)
    }
    const hint = document.querySelector('.ts-hint')
    for (const button of document.querySelectorAll('.ts-bar button'))
      if (hint && hit(box(hint), box(button))) problems.push(`hint over ${button.textContent}`)
    return problems
  })

/** Parts at the level open now whose screen box leaves the stage. */
const clipped = async () => {
  const size = await frame().$eval('.ts-stage', (el) => [el.clientWidth, el.clientHeight])
  const model = await inspect()
  const depth = model.open ? model.open.split('/').length + 1 : 1
  return model.parts
    .filter((p) => p.path.split('/').length === depth && (!model.open || p.path.startsWith(`${model.open}/`)))
    .filter((p) => !p.box || p.box.x < -1 || p.box.y < -1 || p.box.x + p.box.width > size[0] + 1 || p.box.y + p.box.height > size[1] + 1)
    .map((p) => [p.path, p.box && Object.values(p.box).map(Math.round)])
}
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
    { built: checked.built, typesChecked: checked.typesChecked, problems: checked.problems, text: checked.rendered?.text?.slice(0, 300) },
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
  check('the whole assembly fits the stage', (await clipped()).length === 0, await clipped())
  check('at rest, no label covers a control or leaves the stage', (await covered()).length === 0, await covered())
  const step = await frame().$eval('.ts-bar button', (el) => {
    const style = getComputedStyle(el)
    return { text: el.textContent, background: style.backgroundColor, padding: style.paddingLeft }
  })
  check(
    "Astryx draws its own controls: the host's plain-control defaults do not override them",
    step.text === 'Step' && step.background !== 'rgba(0, 0, 0, 0)' && step.background !== 'transparent',
    step,
  )
  check(
    'none of the library chrome is stamped as the App source',
    (await frame().$$eval('.theorem-spatial [data-theorem-source]', (els) => els.length)) === 0,
  )

  // Keyboard: Tab reaches a label; focused, it explains itself; Enter selects it.
  await frame().focus('.tn-slot[data-anchor="part:b"] .tn-label')
  await page.waitForTimeout(400)
  const focused = await frame().evaluate(() => {
    const label = document.querySelector('.tn-slot[data-anchor="part:b"] .tn-label')
    return { kept: document.activeElement === label, detail: label?.hasAttribute('data-detail'), text: label?.textContent }
  })
  check('a focused label keeps focus and shows its explanation', focused.kept && focused.detail && /bit by bit/.test(focused.text), focused)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  check('Enter on a label selects its part, its note attached', (await inspect()).selected === 'b' && (await attachment('b')).length === 0, await attachment('b'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check('Esc lets it go', (await inspect()).selected === null)

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
  // From when its note appears, it is attached at every step of the pull.
  const whilePulled = []
  let samples = 0
  for (let index = 1; index <= 24; index++) {
    await page.mouse.move(x + index * 4.5, y - index * 3.5)
    const problems = await attachment('alu', MOVING)
    if (samples === 0 && problems.join() === 'no note') continue
    samples++
    whilePulled.push(...problems)
  }
  await page.mouse.up()
  await settle()
  check('the note stays attached while the part is pulled', samples >= 6 && whilePulled.length === 0, { samples, whilePulled })
  check('settled, the note is attached exactly', (await attachment('alu')).length === 0, await attachment('alu'))
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
    hidden: el.hasAttribute('data-hidden'),
    entity: el.getAttribute('data-entity-id'),
    text: el.textContent,
  }))
  check(
    'a selected part has its card beside it, naming it for Ask',
    !card.hidden && card.entity === 'alu' && /ALU/.test(card.text) && /Put back/.test(card.text),
    card,
  )
  const ports = await frame().$$eval('.ts-port', (els) => els.map((el) => [el.textContent.trim(), el.hasAttribute('data-editable')]))
  check(
    "only the input the person can set is marked as settable among the ALU's ports",
    ports.length >= 5 && ports.filter(([, editable]) => editable).map(([text]) => text.split(' ')[0]).join() === 'op',
    ports,
  )
  check('with the note open, no label covers it or the strip', (await covered()).length === 0, await covered())
  // The chrome is liquidGL glass: a lens behind the note and the strip, over a
  // live mirror of the scene, under a veil that leaves most of it in sight.
  const glass = await frame().evaluate(() => {
    const note = document.querySelector('.ts-card .tn-note-frame, .tn-note-frame')
    const veil = note && getComputedStyle(note.querySelector(':scope > :not(.tn-glass)')).backgroundColor
    const mirror = document.querySelector('video.tn-glass-mirror')
    const view = document.querySelector('.theorem-spatial')
    return {
      note: note?.getAttribute('data-glass'),
      bar: document.querySelector('.ts-bar')?.getAttribute('data-glass'),
      lenses: document.querySelectorAll('.tn-glass[data-glass-pane]').length,
      canvas: [...view.querySelectorAll(':scope > canvas')].map((each) => getComputedStyle(each).zIndex),
      veil,
      // `color(srgb r g b / a)` from color-mix, or `rgba(r, g, b, a)`.
      alpha: Number((/\/\s*([\d.]+)\)/.exec(veil ?? '') ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(veil ?? ''))?.[1] ?? 1),
      mirror: mirror && { ready: mirror.readyState, width: mirror.videoWidth, playing: !mirror.paused },
      sceneLeftOut: document.querySelector('.ts-stage > canvas')?.hasAttribute('data-liquid-ignore'),
    }
  })
  check(
    'the note and the strip are liquidGL glass, its canvas under the chrome and over the scene',
    glass.note === 'gl' && glass.bar === 'gl' && glass.lenses >= 2 && glass.canvas.includes('1'),
    glass,
  )
  check(
    'the glass refracts the scene as it redraws: the WebGL canvas plays in a mirror video, left out of the snapshot',
    glass.mirror?.ready >= 2 && glass.mirror.width > 0 && glass.mirror.playing && glass.sceneLeftOut,
    glass.mirror,
  )
  check('the glass is mostly transparent: under half of the surface colour lies over it', glass.alpha > 0.2 && glass.alpha < 0.5, glass.veil)
  await shot('2-alu-pulled-light')

  // Orbit the camera: the note follows its part.
  const [ex, ey] = await onPage(await emptyPoint())
  const before = (await part('alu')).box
  const whileOrbiting = []
  await page.mouse.move(ex, ey)
  await page.mouse.down()
  for (let index = 1; index <= 10; index++) {
    await page.mouse.move(ex + index * 14, ey + index * 3)
    whileOrbiting.push(...(await attachment('alu', MOVING)))
  }
  await page.mouse.up()
  await settle()
  const after = (await part('alu')).box
  const stillSelected = (await inspect()).selected
  check(
    'the note stays attached while the camera moves',
    whileOrbiting.length === 0 && stillSelected === 'alu' && Math.hypot(after.x - before.x, after.y - before.y) > 8 && (await attachment('alu')).length === 0,
    { whileOrbiting: [...new Set(whileOrbiting)], settled: await attachment('alu'), before, after },
  )
  // And back again, the way the person came.
  const [bx, by] = await onPage(await emptyPoint())
  await page.mouse.move(bx, by)
  await page.mouse.down()
  for (let index = 1; index <= 10; index++) await page.mouse.move(bx - index * 14, by - index * 3)
  await page.mouse.up()
  await settle()

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

  // Pin register A's note, then select register B: both notes, apart.
  await frame().click('.ts-card[data-entity-id="a"] button[aria-label="Pin"]')
  await settle()
  const b = await part('b')
  await page.mouse.click(...(await onPage(b.screen)))
  await page.waitForTimeout(800)
  const cards = await frame().$$eval('.tn-slot.ts-card:not([data-hidden])', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { entity: el.dataset.entityId, x: r.left, y: r.top, width: r.width, height: r.height }
    }),
  )
  const apart = cards.length === 2 &&
    (cards[0].x + cards[0].width <= cards[1].x + 1 || cards[1].x + cards[1].width <= cards[0].x + 1 ||
      cards[0].y + cards[0].height <= cards[1].y + 1 || cards[1].y + cards[1].height <= cards[0].y + 1)
  check(
    'a pinned note stays when another part is selected, and the two notes do not overlap',
    apart && cards.map((c) => c.entity).sort().join() === 'a,b' && (await attachment('a')).length === 0 && (await attachment('b')).length === 0,
    { cards, a: await attachment('a'), b: await attachment('b') },
  )
  await shot('2b-pinned-light')

  // Expanded, both notes hold the dossier, but there is one assistant: on the
  // selected part, handed over from the other note, kept where it is put.
  for (const entity of ['a', 'b'])
    await frame().click(`.ts-card[data-entity-id="${entity}"] button[aria-label="Show more"]`)
  await settle()
  const dossiers = () =>
    frame().evaluate(() => ({
      threads: [...document.querySelectorAll('.ts-card .ts-dossier-thread')].map((el) => el.closest('.ts-card')?.dataset.entityId),
      elsewhere: [...document.querySelectorAll('.ts-card .ts-dossier-elsewhere')].map((el) => el.closest('.ts-card')?.dataset.entityId),
      composer: document.querySelector('.ts-dossier-input')?.getAttribute('aria-label'),
      starters: [...document.querySelectorAll('.ts-dossier-starter')].map((el) => el.textContent),
      text: document.querySelector('.ts-dossier-body')?.textContent ?? '',
    }))
  const grown = await frame().$$eval('.tn-slot.ts-card:not([data-hidden])', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { entity: el.dataset.entityId, x: r.left, y: r.top, width: r.width, height: r.height }
    }),
  )
  const clear = (p, q) => p.x + p.width <= q.x + 1 || q.x + q.width <= p.x + 1 || p.y + p.height <= q.y + 1 || q.y + q.height <= p.y + 1
  check(
    'expanded, the two notes grow apart: the one placed second slides clear instead of covering the first',
    grown.length === 2 && clear(grown[0], grown[1]),
    grown,
  )
  const two = await dossiers()
  check(
    'two expanded notes are one conversation: the assistant is on the selected part, the other note hands it over',
    two.threads.join() === 'b' && two.elsewhere.join() === 'a' && /Ask about Register B/.test(two.composer ?? '') && two.starters.length > 0,
    two,
  )
  check(
    'outside a conversation the dossier says where to ask instead of sending nowhere',
    /Open this App in a conversation/.test(two.text),
    two.text,
  )
  await shot('2c-dossier-light')
  await frame().click('.ts-card[data-entity-id="a"] .ts-dossier-elsewhere button')
  await settle()
  const moved = await dossiers()
  check(
    '"Ask here" brings the one assistant to the other part',
    moved.threads.join() === 'a' && (await inspect()).selected === 'a' && /Ask about Register A/.test(moved.composer ?? ''),
    { moved, selected: (await inspect()).selected },
  )
  await frame().click('.ts-card[data-entity-id="a"] .ts-dossier-head button[aria-pressed]')
  await page.mouse.click(...(await onPage((await part('b')).screen)))
  await settle()
  const kept = await dossiers()
  check(
    'kept on a part, the assistant stays there when another part is selected',
    (await inspect()).selected === 'b' && kept.threads.join() === 'a',
    { kept, selected: (await inspect()).selected },
  )
  await frame().click('.ts-card[data-entity-id="a"] .ts-dossier-head button[aria-pressed]')
  await frame().click('.ts-card[data-entity-id="a"] button[aria-label="Show less"]')
  await frame().click('.ts-card[data-entity-id="a"] button[aria-label="Unpin"]')
  await page.waitForTimeout(300)

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
      /A 4-bit processor.*ALU/.test(crumbs),
    { open: model.open, crumbs },
  )
  check("inside the ALU, its parts fit the stage", (await clipped()).length === 0, await clipped())
  check('inside, no label covers the breadcrumb or the strip', (await covered()).length === 0, await covered())
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
  // The frame being replaced still has its model; wait for the revision's.
  const revisedBy = Date.now() + 90_000
  while (Date.now() < revisedBy) {
    const has = await frame()?.evaluate(() => Boolean(window.model?.inspect?.().parts?.some((p) => p.path === 'alu/overflow'))).catch(() => false)
    if (has) break
    await page.waitForTimeout(250)
  }
  await waitModel()
  await page.waitForTimeout(1500)
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
  // Use it at once: select it and move its limit from its own card. The
  // camera reframes to take the new part in, so click where it is now.
  await settle()
  const [nx, ny] = await onPage((await part('alu/overflow')).screen)
  await page.mouse.click(nx, ny)
  await frame()
    .waitForSelector('.ts-card [role=slider]', { timeout: 3000 })
    .catch(async () => console.log('  no card for the new part:', created.screen, (await part('alu/overflow')).screen, (await inspect()).selected))
  const newCard = await frame().$eval('.ts-card', (el) => el.textContent)
  await frame().focus('.ts-card [role=slider]')
  await page.keyboard.press('Home')
  await page.waitForTimeout(200)
  const lowest = (await part('alu/overflow')).state.limit
  await page.keyboard.press('End')
  await settle()
  check(
    'the person operates the new part immediately, from controls the agent gave it, by keyboard',
    /Overflow detector/.test(newCard) && lowest === 3 && (await part('alu/overflow')).state.limit === 15,
    { card: newCard.slice(0, 120), lowest },
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
  await theme('light')

  // A phone's width, by touch: the part in hand's controls go below the scene.
  await frame().evaluate(() => {
    window.model.select(null)
    window.model.open('')
  })
  await frameWidth(380)
  await page.waitForTimeout(2400)
  const ra = await part('a')
  await page.touchscreen.tap(...(await onPage(ra.screen)))
  await page.waitForTimeout(800)
  const dock = await frame().evaluate(() => {
    const dock = document.querySelector('.ts-dock')
    const stage = document.querySelector('.ts-stage').getBoundingClientRect()
    return {
      entity: dock?.dataset.entityId,
      below: dock ? dock.getBoundingClientRect().top >= stage.bottom - 1 : false,
      overScene: document.querySelectorAll('.tn-slot.ts-card:not([data-hidden])').length,
      width: stage.width,
    }
  })
  check(
    'narrow, a tapped part is selected and its controls are docked below the scene, nothing over it',
    (await inspect()).selected === 'a' && dock.entity === 'a' && dock.below && dock.overScene === 0 && dock.width < 560,
    dock,
  )
  const bit = await frame().$eval('.ts-dock button[aria-label="bit 0 of value"]', (el) => {
    const r = el.getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  })
  const iframeBox = await (await page.$('iframe')).boundingBox()
  const valueBefore = (await part('a')).state.value
  await page.touchscreen.tap(iframeBox.x + bit[0], iframeBox.y + bit[1])
  await settle()
  check('a docked control works by touch', (await part('a')).state.value === (valueBefore ^ 1), { before: valueBefore, after: (await part('a')).state.value })
  check('narrow, the assembly fits the stage', (await clipped()).length === 0, await clipped())
  check('narrow, no label covers the dock, the strip or leaves the stage', (await covered()).length === 0, await covered())
  await shot('6-narrow-light')
  await theme('dark')
  await settle()
  await shot('6-narrow-dark')
} finally {
  await browser.close()
  await served.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
