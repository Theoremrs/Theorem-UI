// The spatial dossier with the real agent, signed in on the local stack: ask
// for a processor, select a part in the App the agent wrote, open its note,
// and ask through the dossier. The question should go to the page's own
// conversation with the App and the part as its reference, the reply should
// show in the dossier, the chrome should be liquidGL glass, and the dossier's
// conversation should still be there after a reload.
//
//   E2E_SERVER_BIN=<rustyred-thg-server> bun run e2e:stack     (in another shell)
//   node scripts/e2e/dossier-live.mjs
//
// Real model calls; several minutes. Screenshots go to <data dir>/shots.
import { join } from 'node:path'
import { SHOTS, check, finish, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const QUESTION = 'Why did carry turn on here, and what happens if I change register B?'

// E2E_THREAD reopens a thread that already has the processor, to skip asking for it.
const reuse = process.env.E2E_THREAD
const session = await open(reuse ? `/c/${encodeURIComponent(reuse)}` : '/')
const { page } = session
const thread = turns(session)

/** The frame of the newest App on the page that has a spatial model in it. */
async function spatialFrame() {
  for (let look = 0; look < 60; look++) {
    for (const frame of page.frames().reverse()) {
      const found = await frame.$('.theorem-spatial canvas').catch(() => null)
      if (found) return frame
    }
    await page.waitForTimeout(2_000)
  }
  return undefined
}

const visibleCards = (frame) =>
  frame.$$eval('.tn-slot.ts-card:not([data-hidden])', (els) =>
    els.map((el) => ({ entity: el.dataset.entityId, text: (el.textContent ?? '').slice(0, 80) })),
  )

/**
 * Selects a part the way a person does, by clicking it: clicks across the
 * scene until a part's note shows, preferring the adder.
 */
async function selectPart(frame) {
  // The scene's own canvas: the glass draws in another one beside it.
  const canvas = await frame.$('.ts-stage > canvas')
  await (await frame.frameElement()).scrollIntoViewIfNeeded()
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(600)
  const box = await canvas.boundingBox()
  const seen = []
  for (let row = 1; row < 8; row++)
    for (let column = 1; column < 10; column++) {
      await page.mouse.click(box.x + (box.width * column) / 10, box.y + (box.height * row) / 8)
      await page.waitForTimeout(250)
      const [card] = await visibleCards(frame)
      if (!card) continue
      seen.push({ ...card, at: [column, row] })
      if (/alu|add|carry|overflow/i.test(`${card.entity} ${card.text}`)) return { card, seen }
    }
  const first = seen[0]
  if (first) {
    await page.mouse.click(box.x + (box.width * first.at[0]) / 10, box.y + (box.height * first.at[1]) / 8)
    await page.waitForTimeout(400)
  }
  return { card: first, seen }
}

/** Opens a part's note to its dossier; says how many presses it took. */
async function expand(frame, entity) {
  for (let press = 1; press <= 2; press++) {
    await page.waitForTimeout(1_600)
    await frame.click(`.ts-card[data-entity-id="${entity}"] button[aria-label="Show more"]`)
    await page.waitForTimeout(1_200)
    if (await frame.$(`.ts-card[data-entity-id="${entity}"] .ts-dossier`)) return press
  }
  return 0
}

const dossier = (frame) =>
  frame.evaluate(() => ({
    composer: document.querySelector('.ts-dossier-input')?.getAttribute('aria-label') ?? null,
    text: document.querySelector('.ts-dossier-body')?.textContent ?? '',
    messages: [...document.querySelectorAll('.ts-dossier-message')].map((el) => ({
      role: el.getAttribute('data-role'),
      text: (el.textContent ?? '').trim(),
    })),
  }))

// 1. The App.
if (!reuse) {
  log('asking for the processor')
  await thread.send('How does a small processor add two numbers? Build me a model of it I can pull apart and open up, with registers I can set.', { keys: 'Control+Enter' })
  const first = await thread.ended()
  check('the processor turn ended', Boolean(first?.outcome), first?.outcome)
}
log('thread', thread.threadId())
await page.waitForTimeout(4_000)
let frame = await spatialFrame()
check('the answer holds a spatial model', Boolean(frame))
if (!frame) await finish(session)

// 2. The chrome is glass in the real chat.
await page.waitForTimeout(3_000)
const glass = await frame.evaluate(() =>
  [...document.querySelectorAll('[data-glass]')].map((el) => `${el.className.split(' ')[0]}:${el.getAttribute('data-glass')}`),
)
check('the App\'s chrome is liquidGL glass in the conversation', glass.some((each) => each.endsWith(':gl')), glass.join(', '))

// 3. A part, its note, the dossier.
const { card, seen } = await selectPart(frame)
check('clicking a part in the scene selects it and shows its note', Boolean(card), JSON.stringify(seen.slice(0, 4)))
if (!card) {
  await page.screenshot({ path: join(SHOTS, 'dossier-live-0-no-part.png') })
  await finish(session)
}
const presses = await expand(frame, card.entity)
const opened = await dossier(frame)
check(
  'expanded, the note holds the dossier, connected to the conversation',
  Boolean(opened.composer) && !/Open this App in a conversation/.test(opened.text),
  JSON.stringify({ part: card.entity, composer: opened.composer, presses }),
)
await page.screenshot({ path: join(SHOTS, 'dossier-live-1-open.png') })

// 4. Ask through the dossier.
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
const reply = await thread.ended()
check('the dossier turn ended', Boolean(reply?.outcome), reply?.outcome)
await page.waitForTimeout(3_000)

// What went to Theorem: the question, stored with the dossier's reference to
// the App, which names the selected part and carries the App's account.
const record = await thread.json(`/threads/${encodeURIComponent(thread.threadId())}`)
const asked = (record?.messages ?? []).filter(
  (message) => message.role === 'user' && message.parts?.some((part) => part.payload?.text?.includes(QUESTION.slice(0, 30))),
).at(-1)
const reference = asked?.contextReferences?.find((each) => each.location?.resource?.objectType === 'theorem.app')
let excerpt = {}
try { excerpt = JSON.parse(reference?.excerpt ?? '{}') } catch {}
check(
  'the question is stored with the App reference, the selected part and the dossier\'s account',
  Boolean(reference) && excerpt.selection?.entityId === card.entity && Boolean(excerpt.dossier),
  JSON.stringify({ stored: Boolean(asked), reference: Boolean(reference), part: excerpt.selection?.entityId, dossier: Object.keys(excerpt.dossier ?? {}) }),
)

frame = (await spatialFrame()) ?? frame
const answered = await dossier(frame)
const said = answered.messages.find((each) => each.role === 'assistant')
check(
  'the reply shows in the dossier, after the question',
  answered.messages.some((each) => each.role === 'user' && each.text.includes('carry')) && Boolean(said?.text),
  JSON.stringify(answered.messages.map((each) => ({ role: each.role, text: each.text.slice(0, 160) }))),
)
log('reply:', said?.text.slice(0, 600))
await page.screenshot({ path: join(SHOTS, 'dossier-live-2-answered.png') })
// The open note stays inside the App's frame; past its height the note scrolls.
const note = await frame.$(`.ts-card[data-entity-id="${card.entity}"]`)
const fit = note && (await note.evaluate((element) => {
  const box = element.getBoundingClientRect()
  const layer = element.closest('.tn-notes')?.getBoundingClientRect()
  // Nothing in the note runs past its right edge, where the card would clip it.
  const cut = [...element.querySelectorAll('.ts-row-value, .ts-dossier')].some((each) => each.getBoundingClientRect().right > box.right - 2)
  return layer && { inside: box.top >= layer.top - 1 && box.bottom <= layer.bottom + 1, cut, note: Math.round(box.height), layer: Math.round(layer.height) }
}))
check('the open note fits inside the App, scrolling past its height, and nothing in it is cut off', Boolean(fit?.inside) && !fit.cut, JSON.stringify(fit))
// The layer places notes every frame, so the note never reads as still for an
// element screenshot: clip the page to the note's box, within the viewport.
if (note) {
  await note.evaluate((element) => element.scrollIntoView({ block: 'nearest' }))
  const box = await note.boundingBox()
  const view = page.viewportSize()
  const x = Math.max(0, box?.x ?? 0), y = Math.max(0, box?.y ?? 0)
  const clip = box && view && { x, y, width: Math.min(box.x + box.width, view.width) - x, height: Math.min(box.y + box.height, view.height) - y }
  if (clip && clip.width > 0 && clip.height > 0) await page.screenshot({ path: join(SHOTS, 'dossier-live-3-note.png'), clip })
}

// 5. After a reload the dossier still has its conversation.
await page.reload({ waitUntil: 'domcontentloaded' })
frame = await spatialFrame()
await page.waitForTimeout(3_000)
let kept = { messages: [] }
if (frame) {
  const again = await selectPart(frame)
  if (again.card) {
    await expand(frame, again.card.entity)
    kept = await dossier(frame)
  }
}
check(
  'after a reload the dossier shows the question and its reply again',
  kept.messages.some((each) => each.role === 'user' && each.text.includes('carry')) && kept.messages.some((each) => each.role === 'assistant' && each.text),
  `${kept.messages.length} messages`,
)
await page.screenshot({ path: join(SHOTS, 'dossier-live-4-reloaded.png') })

await finish(session)
