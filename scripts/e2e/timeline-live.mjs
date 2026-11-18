// The Rerun timeline with the real agent, signed in on the local stack: ask
// for a processor whose history can be gone back through, set register B so
// the carry turns on, step on, go back with Rerun's own controls to the cycle
// where it turned on, and ask through the dossier why it did and what changing
// register B would do. The App should load Rerun's viewer, the question should
// carry the cycle the person is looking at, and the reply should answer from it.
//
//   E2E_SERVER_BIN=<rustyred-thg-server> bun run e2e:stack     (in another shell)
//   node scripts/e2e/timeline-live.mjs
//
// Real model calls; several minutes. Screenshots go to <data dir>/shots.
import { join } from 'node:path'
import { SHOTS, check, finish, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const ASK =
  'How does a small processor add two numbers? Build me a model of it I can pull apart and open up, with registers I can set, ' +
  'and a timeline of every cycle under it so I can go back to the moment something changed.'
const QUESTION = 'Why did carry turn on here, and what happens if I change register B?'

const reuse = process.env.E2E_THREAD
const session = await open(reuse ? `/c/${encodeURIComponent(reuse)}` : '/')
const { page } = session
const thread = turns(session)

/** The frame of the newest App on the page with a spatial model and a timeline. */
async function timelineFrame() {
  for (let look = 0; look < 60; look++) {
    for (const frame of page.frames().reverse()) {
      const found = await frame.$('.theorem-spatial canvas').catch(() => null)
      if (found && (await frame.$('.theorem-timeline').catch(() => null))) return frame
    }
    await page.waitForTimeout(2_000)
  }
  return undefined
}

/** Problems the App view lists above the App: build, type and runtime. */
async function listedProblems() {
  await page
    .waitForFunction(() => ![...document.querySelectorAll('[data-slot="app-problems"] [role="status"]')].some((el) => /Checking types/.test(el.textContent ?? '')), undefined, { timeout: 120_000 })
    .catch(() => undefined)
  return page.$$eval('[data-slot="app-problems"] li[data-kind]', (items) => items.map((item) => item.textContent?.trim()))
}

/** The cycle the model's playback strip says it shows: [shown, latest], or the latest alone. */
const strip = (frame) =>
  frame.evaluate(() => {
    const text = document.querySelector('.theorem-spatial')?.textContent ?? ''
    const looking = text.match(/cycle (\d+) of (\d+)/)
    return looking ? { shown: Number(looking[1]), latest: Number(looking[2]) } : { shown: null, latest: null }
  })

/** Clicks one of Rerun's time panel buttons, counted from the left: ▷, ▷|, ||, ←, →, loop. */
async function rerunButton(frame, index) {
  const host = await frame.$('.theorem-timeline')
  // A page laid out by its viewport can be taller than its frame; the time panel is at the bottom.
  await host.evaluate((element) => element.scrollIntoView({ block: 'end' }))
  await page.waitForTimeout(300)
  const box = await host.boundingBox()
  await page.mouse.click(box.x + 18 + 27 * index, box.y + box.height - 16)
  await page.waitForTimeout(700)
}

const dossier = (frame) =>
  frame.evaluate(() => ({
    composer: document.querySelector('.ts-dossier-input')?.getAttribute('aria-label') ?? null,
    messages: [...document.querySelectorAll('.ts-dossier-message')].map((el) => ({
      role: el.getAttribute('data-role'),
      text: (el.textContent ?? '').trim(),
    })),
  }))

// 1. The App.
if (!reuse) {
  log('asking for the processor with a timeline')
  await thread.send(ASK, { keys: 'Control+Enter' })
  // Building and checking a processor App can take the agent well over five minutes.
  const first = await thread.ended({ looks: 500 })
  check('the processor turn ended', Boolean(first?.outcome), first?.outcome)
}
log('thread', thread.threadId())
await page.waitForTimeout(4_000)
let frame = await timelineFrame()
check('the answer holds a spatial model with a timeline under it', Boolean(frame))
if (!frame) {
  await page.screenshot({ path: join(SHOTS, 'timeline-live-0-no-timeline.png') })
  await finish(session)
}
const problems = await listedProblems().catch(() => [])
check('no build, type or runtime problems are listed', problems.length === 0, problems.join(' | '))
const policy = await frame.$eval('meta[http-equiv="Content-Security-Policy"]', (meta) => meta.content).catch(() => null)
const sandbox = await (await frame.frameElement()).getAttribute('sandbox')
check(
  'the App runs open, on an origin of its own: no host policy, and no allow-same-origin',
  policy === null && !/allow-same-origin/.test(sandbox ?? '') && /allow-forms/.test(sandbox ?? ''),
  JSON.stringify({ policy, sandbox }),
)
const loaded = await (async () => {
  for (let look = 0; look < 60; look++) {
    const state = await frame.evaluate(() => ({
      canvas: document.querySelectorAll('.theorem-timeline canvas').length,
      error: document.querySelector('.theorem-timeline-error')?.textContent ?? null,
    }))
    if (state.canvas || state.error) return state
    await page.waitForTimeout(2_000)
  }
  return { canvas: 0, error: 'nothing after two minutes' }
})()
check("Rerun's viewer loads in the agent's App", loaded.canvas > 0 && !loaded.error, JSON.stringify(loaded))
await (await frame.frameElement()).scrollIntoViewIfNeeded()
await page.waitForTimeout(3_000)
await page.screenshot({ path: join(SHOTS, 'timeline-live-1-app.png') })

/** Opens a part's card from its label, unless it is open already (a remembered selection). */
async function select(anchor) {
  const entity = anchor.slice('part:'.length)
  if (await frame.$(`.ts-card[data-entity-id="${entity}"]`)) return entity
  // A label gives way to an open card it would overlap; close the card, as a person would.
  if (await frame.$(`.tn-slot[data-anchor="${anchor}"][data-hidden]`))
    for (const close of await frame.$$('.ts-card button[aria-label="Close"]')) {
      await close.click()
      await page.waitForTimeout(600)
    }
  await frame.focus(`.tn-slot[data-anchor="${anchor}"] .tn-label`)
  await frame.press(`.tn-slot[data-anchor="${anchor}"] .tn-label`, 'Enter')
  await page.waitForTimeout(1_200)
  return entity
}

// 2. Register B at its largest value, so the addition carries.
const labels = await frame.$$eval('.tn-slot[data-anchor^="part:"] .tn-label', (els) =>
  els.map((el) => ({ anchor: el.closest('.tn-slot').dataset.anchor, text: (el.textContent ?? '').trim() })),
)
// An open card replaces its part's label, so a part whose card is open is found by its card.
const openCards = await frame.$$eval('.ts-card[data-entity-id]', (els) =>
  els.map((el) => ({ anchor: `part:${el.dataset.entityId}`, text: el.querySelector('h1,h2,h3,[class*="title"]')?.textContent?.trim() ?? '' })),
)
for (const card of openCards) if (!labels.some((each) => each.anchor === card.anchor)) labels.push(card)
const registerB = labels.find((each) => /register\s*b\b|\breg\s*b\b/i.test(each.text)) ?? labels.find((each) => /^part:(b|regb|reg_b|registerb)$/i.test(each.anchor))
check('register B is a part of the model', Boolean(registerB), JSON.stringify(labels.map((each) => each.text.slice(0, 40))))
if (!registerB) await finish(session)
const entity = await select(registerB.anchor)
// The agent decides how B is set: bit toggles, or a number field. Either way,
// to its largest value, so A + B carries.
const bits = await frame.$$(`.ts-card[data-entity-id="${entity}"] .ts-bit`)
for (const bit of bits) if ((await bit.getAttribute('aria-pressed')) !== 'true') {
  await bit.click()
  await page.waitForTimeout(500)
}
const fields = bits.length
  ? []
  : await frame.$$(`.ts-card[data-entity-id="${entity}"] input[role="spinbutton"], .ts-card[data-entity-id="${entity}"] input[type="number"]`)
for (const field of fields) {
  await field.fill('15')
  await field.press('Enter')
  await page.waitForTimeout(600)
}
const afterSet = await strip(frame)
log('after setting B:', JSON.stringify(afterSet), `${bits.length} bits, ${fields.length} number fields`)
check('register B can be set from its card', bits.length > 0 || fields.length > 0, `${bits.length} bits, ${fields.length} number fields`)

// 3. Step on, then go back with Rerun's own step-back button to the cycle where B was set.
const step = await frame.$('.ts-bar button:has-text("Step")')
const stepped = step ? 2 : 0
for (let count = 0; count < stepped; count++) {
  await step.click()
  await page.waitForTimeout(800)
}
for (let count = 0; count < stepped; count++) await rerunButton(frame, 3)
const looking = await strip(frame)
check(
  "Rerun's step-back button takes the model back to the cycle where B was set, and its strip says so",
  stepped === 0 || (looking.shown !== null && looking.latest - looking.shown === stepped),
  JSON.stringify({ stepped, looking }),
)
await page.screenshot({ path: join(SHOTS, 'timeline-live-2-looking-back.png') })

// 4. Ask through the dossier, about the part with the carry.
const carrier =
  labels.find((each) => /\balu\b/i.test(each.text)) ?? labels.find((each) => /add|carry/i.test(each.text)) ?? registerB
const part = await select(carrier.anchor)
for (let press = 1; press <= 2 && !(await frame.$(`.ts-card[data-entity-id="${part}"] .ts-dossier`)); press++) {
  await page.waitForTimeout(1_400)
  await frame.click(`.ts-card[data-entity-id="${part}"] button[aria-label="Show more"]`).catch(() => {})
  await page.waitForTimeout(1_200)
}
const opened = await dossier(frame)
check('the part\'s note opens to the dossier while looking back', Boolean(opened.composer), JSON.stringify({ part, composer: opened.composer }))
const stillBack = await strip(frame)
check('selecting and opening a note keeps the model on the cycle the person went back to', stillBack.shown === looking.shown, JSON.stringify(stillBack))

const before = (await thread.lastRunOf())?.runId
log('asking through the dossier:', QUESTION)
await frame.fill('.ts-dossier-input', QUESTION)
await frame.press('.ts-dossier-input', 'Enter')
let started
for (let look = 0; look < 40 && !started; look++) {
  const run = await thread.lastRunOf().catch(() => undefined)
  if (run?.runId && run.runId !== before) started = run
  else await page.waitForTimeout(3_000)
}
check('the question starts a run in the page\'s own conversation', Boolean(started))
const reply = await thread.ended({ looks: 200 })
check('the dossier turn ended', Boolean(reply?.outcome), reply?.outcome)
await page.waitForTimeout(3_000)

// What went to Theorem: the dossier's account carries the cycle being looked at.
const record = await thread.json(`/threads/${encodeURIComponent(thread.threadId())}`)
const asked = (record?.messages ?? [])
  .filter((message) => message.role === 'user' && message.parts?.some((p) => p.payload?.text?.includes(QUESTION.slice(0, 30))))
  .at(-1)
const reference = asked?.contextReferences?.find((each) => each.location?.resource?.objectType === 'theorem.app')
let excerpt = {}
try {
  excerpt = JSON.parse(reference?.excerpt ?? '{}')
} catch {}
const cycle = excerpt.dossier?.cycle
check(
  'the question carries the cycle the person went back to, with the causes and values before it',
  Boolean(cycle) && (stepped === 0 || (cycle.lookingBack === true && cycle.shown === looking.shown)) && Array.isArray(cycle.recent) && cycle.recent.length > 0,
  JSON.stringify({ part: excerpt.selection?.entityId, cycle: cycle && { ...cycle, recent: cycle.recent?.map((frame) => frame.cause) } }),
)

frame = (await timelineFrame()) ?? frame
const answered = await dossier(frame)
const said = answered.messages.filter((each) => each.role === 'assistant').at(-1)
check(
  'the reply shows in the dossier and speaks to the carry and to register B',
  Boolean(said?.text) && /carr/i.test(said.text) && /\bB\b|register b/i.test(said.text),
  said?.text.slice(0, 200),
)
log('reply:', said?.text.slice(0, 1200))
await page.screenshot({ path: join(SHOTS, 'timeline-live-3-answered.png') })

await finish(session)
