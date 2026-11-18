// The spatial direction with the real agent, signed in on the local stack:
// ask for an explanation of a processor, ask for a part it does not have yet,
// then ask about an unrelated subject in a new thread. Each answer should be an
// App that builds a model with @theorem/spatial, with no build, type or runtime
// problems, and the follow-up should add its part to the same model.
//
//   E2E_SERVER_BIN=<rustyred-thg-server> bun run e2e:stack     (in another shell)
//   node scripts/e2e/spatial-live.mjs
//
// Real model calls; several minutes. Screenshots go to <data dir>/shots.
import { join } from 'node:path'
import { SHOTS, check, finish, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const session = await open('/')
const { page } = session
const thread = turns(session)

/** The frame of the newest App in the reply that has a spatial model in it. */
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

/** The parts the model lists for the receipt and for Ask: the level in view, each with what it contains. */
const outline = (frame) => frame.$$eval('.ts-outline > *', (items) => items.map((item) => item.textContent ?? ''))
const names = (parts) => parts.map((part) => part.split('\n')[0])

/** Problems the App view lists above the App: build, type and runtime. */
async function listedProblems() {
  // The type check finishes after the App runs.
  await page
    .waitForFunction(() => ![...document.querySelectorAll('[data-slot="app-problems"] [role="status"]')].some((el) => /Checking types/.test(el.textContent ?? '')), undefined, { timeout: 120_000 })
    .catch(() => undefined)
  return page.$$eval('[data-slot="app-problems"] li[data-kind]', (items) => items.map((item) => item.textContent?.trim()))
}

async function ask(text, name) {
  log('asking:', text)
  await thread.send(text, { keys: 'Control+Enter' })
  const run = await thread.ended()
  check(`${name}: the turn ended`, Boolean(run?.outcome), run?.outcome)
  await page.waitForTimeout(4_000)
  const frame = await spatialFrame()
  check(`${name}: the answer holds a spatial model`, Boolean(frame))
  const problems = await listedProblems().catch(() => [])
  check(`${name}: no build, type or runtime problems are listed`, problems.length === 0, problems.join(' | '))
  const parts = frame ? await outline(frame) : []
  log(`${name} parts:`, names(parts).join('; '))
  await page.screenshot({ path: join(SHOTS, `spatial-live-${name}.png`) })
  return { frame, parts }
}

const cpu = await ask(
  'How does a small processor add two numbers? Build me a model of it I can pull apart and open up, with registers I can set.',
  'cpu',
)
check('cpu: the model has parts', cpu.parts.length >= 3, String(cpu.parts.length))

const revised = await ask(
  'Add a part to that model that detects when the sum overflows four bits, with a threshold I can change on it. Keep everything else as it is.',
  'cpu-overflow',
)
check(
  'cpu-overflow: the new part is in the model',
  revised.parts.some((part) => /overflow/i.test(part)),
  names(revised.parts).join('; '),
)
check(
  'cpu-overflow: the parts that were there are still there',
  names(cpu.parts).every((part) => names(revised.parts).includes(part)),
)

await page.goto(new URL('/', page.url()).href, { waitUntil: 'domcontentloaded' })
const heart = await ask(
  'How does the human heart move blood through the body? Build a model of it I can pull apart and open up, with a heart rate I can change.',
  'heart',
)
check('heart: the model has parts', heart.parts.length >= 3, String(heart.parts.length))

await finish(session)
