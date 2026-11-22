import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import path from 'node:path'
// Rerun's viewer under a spatial model, in a browser: the App records every
// cycle, Theorem's server writes the recording with Rerun's Rust SDK, the
// viewer loads from Rerun's hosting and shows it, moving the viewer's time
// shows that cycle in the model as it was, and changing an input there runs
// the model again from it as a new recording beside the old.
//
//   E2E_UI_PORT=3112 node scripts/e2e/timeline.mjs
//
// The App is served by scripts/e2e/app-ts/ (the real App view over an App
// document held in memory). Its recording requests go to the local stack
// (scripts/e2e/stack.mjs) as the signed-in test account, so the recording is
// the server's own. Screenshots go to docs/plans/evidence/rerun-2026-11-18/.
import { chromium } from 'playwright-core'
import { DATA_DIR, UI } from './config.mjs'
import { servePage } from './harness.mjs'
import { open } from './lib.mjs'
import { MOUNT, PARTS } from './spatial-fixture.mjs'

const EVIDENCE = path.resolve(import.meta.dirname, '../../docs/plans/evidence/rerun-2026-11-18')
mkdirSync(EVIDENCE, { recursive: true })
const ROUTE = '/api/chat/v1/apps/traces/rrd'

const MAIN = PARTS.replace(
  "import { mount, parts, type Part, type Vec3 } from '@theorem/spatial'",
  "import { mount, mountTimeline, parts, type Part, type Vec3 } from '@theorem/spatial'",
).concat(
  MOUNT.replace(
    'Object.assign(window, { model })',
    `const timeline = mountTimeline(document.getElementById('root')!, model, {
  // Short, as an agent chose in a live run: Rerun hides its time panel in a short viewer unless told not to.
  height: 220,
  plots: [
    { title: 'Register B', values: ['b.value'] },
    { title: 'ALU result and carry', values: ['alu.result', 'alu.carry'] },
  ],
})
Object.assign(window, { model, timeline })`,
  ),
)
const APP = `<!doctype html>
<meta name="theorem:uses" content='state("model")'>
<div id="root"></div>
<script type="text/theorem-source" data-path="main.ts">${MAIN}</script>`

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
}

// Signed in once through the real sign-in page; the cookies are reused below.
const signedIn = await open('/')
await signedIn.browser.close()
const STATE = join(DATA_DIR, 'browser-state.json')
if (!existsSync(STATE)) throw new Error('no signed-in browser state')

const served = await servePage('app-ts')
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({
  viewport: { width: 1180, height: 1000 },
  deviceScaleFactor: 1,
  storageState: STATE,
})
const page = await context.newPage()
page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`  [console] ${message.text().slice(0, 300)}`)
})

// The App's recording requests, answered by the stack's server as the test account.
const recordings = []
await page.route(`**${ROUTE}`, async (route) => {
  const body = route.request().postData() ?? ''
  const response = await context.request.post(UI + ROUTE, {
    data: body,
    headers: { 'content-type': 'application/json' },
    timeout: 120_000,
  })
  const bytes = await response.body()
  const sent = JSON.parse(body)
  recordings.push({
    status: response.status(),
    media: response.headers()['content-type'],
    magic: bytes.subarray(0, 4).toString('latin1'),
    size: bytes.length,
    recordingId: sent.recordingId,
    cycles: sent.frames.map((frame) => frame.cycle),
    causes: sent.frames.map((frame) => frame.cause),
    layout: sent.layout,
  })
  await route.fulfill({ response })
})

const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame())
const inApp = (fn, arg) => frame().evaluate(fn, arg)
const until = async (what, test, ms = 60_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await test().catch(() => undefined)
    if (value) return value
    await page.waitForTimeout(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const state = () =>
  inApp(() => ({
    cycle: window.model.trace.cycle(),
    viewing: window.model.trace.viewing(),
    recordingId: window.model.trace.recordingId(),
    shown: window.timeline.recordingId(),
    b: window.model.value('b', 'value'),
    result: window.model.inspect().parts.find((p) => p.path === 'alu')?.outputs.result,
    carry: window.model.inspect().parts.find((p) => p.path === 'alu')?.outputs.carry,
  }))
const shot = async (name) => {
  await (await page.$('iframe')).screenshot({ path: path.join(EVIDENCE, `${name}.png`) })
}

try {
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())

  const checked = await page.evaluate((html) => window.oracle.inspect(html, { runMs: 0 }), APP)
  check('the App with a timeline builds and type-checks clean', checked.built && checked.typesChecked && checked.problems.length === 0, {
    built: checked.built,
    typesChecked: checked.typesChecked,
    problems: checked.problems,
  })

  await page.evaluate((html) => window.oracle.revise(html), APP)
  await page.evaluate(() => window.oracle.show())
  await page.waitForSelector('iframe', { timeout: 60_000 })
  // As wide as an App in the conversation (608px in a live run), where Rerun hides its time panel unless told not to.
  await page.addStyleTag({ content: 'iframe { width: 608px !important; height: 940px !important }' })
  await until('the model', () => frame()?.evaluate(() => Boolean(window.model && window.timeline)), 90_000)

  // The viewer's wasm is tens of megabytes from app.rerun.io.
  const started = Date.now()
  const ready = await inApp(() =>
    window.timeline.ready.then(
      () => 'ready',
      (error) => `rejected: ${String(error)}`,
    ),
  )
  check("Rerun's viewer loads from app.rerun.io inside the App's frame", ready === 'ready', { ready, ms: Date.now() - started })
  check(
    'the viewer draws into a canvas in the timeline',
    (await inApp(() => document.querySelectorAll('.theorem-timeline canvas').length)) > 0,
  )

  await until('the first recording', async () => recordings.length > 0 && (await state()).shown)
  const first = recordings[0]
  check(
    "the server writes the trace as a Rerun recording (the App's own frames, Rerun's file magic)",
    first.status === 200 && first.media === 'application/vnd.rerun.rrd' && first.magic === 'RRF2' && first.cycles[0] === 0,
    first,
  )
  check(
    "the recording opens with the App's plots, each value resolved to a port or a state key",
    JSON.stringify(first.layout) ===
      JSON.stringify({
        plots: [
          { title: 'Register B', ports: [{ part: 'b/state', port: 'value' }] },
          { title: 'ALU result and carry', ports: [{ part: 'alu', port: 'result' }, { part: 'alu', port: 'carry' }] },
        ],
      }),
    first.layout,
  )
  let now = await state()
  check('the viewer shows the recording the model is writing', now.shown === now.recordingId, now)
  await page.waitForTimeout(2500)
  await shot('timeline-start')

  // A change at the latest cycle is a new cycle, sent on its own.
  const before = recordings.length
  await inApp(() => window.model.set('b', 'value', 9))
  await until('the change recorded', async () => recordings.length > before)
  now = await state()
  const appended = recordings.at(-1)
  check(
    'setting register B adds a cycle and only that cycle is sent, with no layout to undo the viewer',
    now.cycle === 1 && appended.recordingId === now.recordingId && appended.cycles.join() === '1' && appended.causes[0] === 'b.value = 9' &&
      appended.layout === undefined,
    { now, appended },
  )
  check('7 + 9 carries out of the top bit', now.result === 0 && now.carry === 1, now)
  for (let count = 0; count < 3; count++) await inApp(() => window.model.step())
  await until('the steps recorded', async () => recordings.at(-1).cycles.at(-1) === 4)
  await page.waitForTimeout(2000)
  await shot('timeline-after-change')

  // Moving Rerun's time shows that cycle in the model as it was.
  const recordingId = (await state()).recordingId
  await inApp((id) => window.timeline.viewer.set_current_time(id, 'cycle', 0), recordingId)
  const scrubbed = await until('the viewer time to reach the model', async () => {
    const value = await state()
    return value.viewing === 0 ? value : undefined
  }, 15_000).catch(() => undefined)
  check(
    "moving the viewer's time shows cycle 0 in the model: B back at 5, no carry",
    scrubbed?.viewing === 0 && scrubbed.b === 5 && scrubbed.result === 12 && scrubbed.carry === 0,
    scrubbed ?? (await state()),
  )
  await page.waitForTimeout(1500)
  await shot('timeline-scrubbed-cycle-0')

  // The model's own playback strip follows the other way.
  await inApp(() => window.model.trace.scrub(1))
  await page.waitForTimeout(1500)
  const followed = await inApp(() => ({
    viewing: window.model.trace.viewing(),
    strip: document.querySelector('.theorem-spatial')?.textContent?.match(/cycle \d+ of \d+/)?.[0],
  }))
  check('the model can be scrubbed from its own controls, and says which cycle it shows', followed.viewing === 1 && followed.strip === 'cycle 1 of 4', followed)

  // A mouse drag along the bottom of Rerun's time panel, where its time cursor is.
  await inApp(() => window.model.trace.scrub(null))
  await page.waitForTimeout(800)
  const panel = await inApp(() => {
    const r = document.querySelector('.theorem-timeline').getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  const box = await (await page.$('iframe')).boundingBox()
  // The slider is the bottom row of Rerun's time panel, between its controls and the time field.
  const y = box.y + panel.top + panel.height - 16
  const x0 = box.x + panel.left + panel.width * 0.8
  const x1 = box.x + panel.left + panel.width * 0.45
  await page.mouse.move(x0, y)
  await page.mouse.down()
  await page.mouse.move(x1, y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(1200)
  const dragged = await state()
  check("a mouse drag on Rerun's time panel moves the model to an earlier cycle", dragged.viewing !== null && dragged.viewing < 4, dragged)
  await shot('timeline-mouse-drag')

  // A change made while looking back runs the model again from that cycle.
  await inApp(() => window.model.trace.scrub(0))
  await page.waitForTimeout(500)
  const old = (await state()).recordingId
  await inApp(() => {
    window.events = []
    window.timeline.viewer.on('time_update', (event) => window.events.push([event.recording_id, event.time]))
    window.model.set('b', 'value', 3)
  })
  const rerun = await until('the new run shown', async () => {
    const value = await state()
    return value.shown !== old && value.shown === value.recordingId ? value : undefined
  }, 30_000).catch(() => undefined)
  await page.waitForTimeout(1500)
  // The new run is sent whole from its first cycle; later cycles may follow on their own.
  const sentAgain = recordings.filter((recording) => recording.recordingId === rerun?.recordingId)
  const causes = sentAgain.flatMap((recording) => recording.causes)
  const after = await state()
  check(
    'changing B while looking back at cycle 0 runs the model again as a new recording, which the viewer shows',
    Boolean(rerun) && rerun.recordingId !== old && sentAgain[0]?.cycles[0] === 0 &&
      causes.includes('b.value = 3') && !causes.includes('b.value = 9'),
    { rerun: rerun ?? after, sent: sentAgain.map(({ cycles, causes }) => ({ cycles, causes })) },
  )
  check(
    'the model shows the change itself, cycle 1 of the new run, and the viewer is there too',
    after.viewing === 1 && after.b === 3 && after.carry === 0,
    { after, events: await inApp(() => window.events.slice(0, 20)) },
  )
  await inApp(() => window.model.trace.scrub(null))
  await page.waitForTimeout(800)
  const latest = await state()
  check('the new run carries no more: 7 + 3 fits in four bits', latest.b === 3 && latest.carry === 0, latest)
  await page.waitForTimeout(2000)
  await shot('timeline-rerun')
} finally {
  await browser.close()
  await served.close()
}

const failed = results.filter((result) => !result.pass)
console.log(failed.length ? `FAILED: ${failed.map((result) => result.name).join('; ')}` : 'All checks passed')
process.exit(failed.length ? 1 : 0)
