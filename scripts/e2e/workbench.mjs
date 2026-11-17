// The Theo workbench's process pane against a real IDE host and a real Herdr core, as the test
// account, with real key presses and reads of the page's text. Cases AC-29, 30, 32 to 37 and 40
// of docs/plans/theo-workbench/acceptance-cases.json, and the part of AC-57 the host-restart case
// shows.
//
// Start the stack with the host first (see scripts/e2e/stack.mjs):
//   E2E_SERVER_BIN=... E2E_IDE_HOST_BIN=... E2E_HERDR_HC=... E2E_UI_PORT=3122 \
//   E2E_API_PORT=8412 E2E_IDENTITY_PORT=8418 E2E_IDE_HOST_PORT=8810 \
//   E2E_DATA_DIR=~/.theorem/e2e-workbench node scripts/e2e/stack.mjs
// then the same E2E_* ports and data directory here:
//   node scripts/e2e/workbench.mjs           run every case
//   node scripts/e2e/workbench.mjs --list    print the cases and their checks; starts nothing
//
// Everything is read from the page's text (the grid the workbench draws is real DOM) and from the
// computed colour of its cells; the page's internals are never called. Where the scenario has to
// make a session another way (the host's own API, `hc`), the check's observation says so.
//
// Each case sets itself up and tears itself down, and one case's failure does not stop the next.
// A case is reported as passed, failed (with what the page showed) or not run (with the reason).
// The report is one JSON document, <data dir>/workbench-report.json, written even when the run
// aborts. The core must be 0.1.17, the version the host image pins; any other stops the run.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, UI } from './config.mjs'
import { READ, SHOTS, check as tally, finish, log, open } from './lib.mjs'
import {
  HOST_ROOT,
  coreTerminals,
  coreVersion,
  hc,
  hostApi,
  hostUp,
  killHost,
  setPrincipals,
  startCore,
  startHost,
} from './ide-host.mjs'

const PINNED_CORE = '0.1.17'
const REPORT = join(DATA_DIR, 'workbench-report.json')
// The host brings an opening pass to a close after this many notices (apps/theorem-ide-host/src/session.rs).
const OPENING_NOTICES = 64

/** Every case and the checks that are evidence for it; a check is filed under the case whose text it shows. */
const CASES = {
  'AC-29': {
    title: 'Herdr readiness and explicit profiles',
    checks: [
      'the chooser offers "Start Shell"',
      'the chooser offers "Start Herdr shell"',
      'the chooser offers "Start Claude Code (Herdr)"',
      'the chooser offers "Start Codex (Herdr)"',
      'Herdr shell is shown as ready, not unavailable (and how long that took)',
      'Shell is shown as native, a different choice from the Herdr shell',
      'the host itself reports Herdr ready',
      'with the core unavailable the Herdr row names the failure and starting it leaves no shell of any kind',
      'older host with missing capability fields, and a malformed profile or program',
    ],
  },
  'AC-30': {
    title: 'Real terminal rendering interoperability',
    checks: [
      '"Start Herdr shell" starts a Herdr shell from the pane',
      'what is typed in the pane reaches the program',
      '16-colour SGR red is drawn in the page\'s own themed red',
      '256-colour SGR (index 208) is drawn exactly',
      'truecolor SGR is drawn exactly',
      'wide characters are drawn and what follows them is not shifted',
      'a full-screen program (a pager) replaces the screen and gives it back',
      'vim is drawn on the alternate screen and gives the shell screen back',
      'Claude Code (Herdr) profile: starts and draws its own screen',
      'Codex (Herdr) profile: starts and draws its own screen',
      'paste and resize reach the program',
    ],
  },
  'AC-32': {
    title: 'Herdr detach/refresh identity',
    checks: [
      'the pane is bound to the same session after a reload',
      'earlier output is still on the screen',
      'a new command runs in the same shell process (no second launch)',
      'the core holds one live terminal for it',
    ],
  },
  'AC-33': {
    title: 'Workspace-host restart with surviving core',
    checks: [
      'the host process is gone while the core and its terminal stay',
      'the same terminal is re-adopted under a new binding epoch',
      'the program is the same live process (variable and pid survived)',
      'the pane says the same program continues under the new epoch',
      'bytes from the old epoch are not repainted onto the new binding',
    ],
  },
  'AC-34': {
    title: 'Process loss and replacement',
    checks: [
      'the pane says the process ended',
      'no replacement was started silently',
      'starting a new one is its own action and is said to be a different process',
      'a new Herdr shell started from the chooser has a different identity from the lost one',
      'a terminal the core ended is shown as ended too',
      'a kept terminal\'s replacement is announced as a replacement that did not resume the work',
      'the replacement is a different process',
      'an explicit kill of the replacement stays final',
    ],
  },
  'AC-35': {
    title: 'Every view types',
    checks: [
      'the second browser sees the first browser\'s output',
      'the second browser\'s typing reaches the program and shows in both',
      'the first browser\'s typing still reaches the program and shows in both',
    ],
  },
  'AC-36': {
    title: 'Every view resizes',
    checks: [
      'the second browser attaches to the same session and its pane accepts keys',
      'resizing the second browser changes the program\'s grid',
      'resizing the first browser changes the program\'s grid again',
    ],
  },
  'AC-37': {
    title: 'Bounded opening adoption',
    checks: [
      'enough terminals were made to exceed the opening snapshot',
      'the host reported adoption as pending while it was still adopting',
      'the pane showed the first listing as incomplete',
      'opening completed without waiting for the terminals created while it was opening',
      'later arrivals were adopted asynchronously until every terminal is listed',
      'restarting the host is not blocked by the queue',
    ],
  },
  'AC-40': {
    title: 'Failed Herdr subscription recovery',
    checks: [
      'with the core unavailable at open, the chooser names the failure and a next step',
      'once the core is available the same terminal is listed again, with no second launch',
      'subscribe reply timeout',
      'a core that closes its subscription: the host says so (timeline)',
      'a core that closes its subscription: the pane says so (timeline)',
      'a later listing recovers when the core can be reached again, without a duplicate launch',
    ],
  },
  'AC-57': {
    title: 'Host loss is not migration',
    checks: [
      'while the host is away the pane says in plain words that it is gone',
      'while the host is away the pane makes no claim that the program continues or moved',
    ],
  },
  'AC-24': {
    title: 'Theo and external CLI are different bindings',
    checks: ['no check in this scenario is evidence for this case'],
  },
}

if (process.argv.includes('--list')) {
  for (const [id, one] of Object.entries(CASES)) {
    console.log(`${id}  ${one.title}`)
    for (const name of one.checks) console.log(`    - ${name}`)
  }
  console.log('harness  (checks of the scenario itself, filed as harness and never as an AC)')
  process.exit(0)
}

// ---- the report ------------------------------------------------------------------------------

const started = Date.now()
const records = []
const versions = { node: process.version, core: undefined, host: undefined, chromium: undefined }
let aborted
let lastShot
let caseId = 'harness'
let reportWritten = false

function writeReport() {
  if (reportWritten) return
  reportWritten = true
  const cases = {}
  for (const [id, one] of Object.entries(CASES)) {
    const mine = records.filter((r) => r.ac === id)
    const failed = mine.filter((r) => r.verdict === 'fail')
    const passed = mine.filter((r) => r.verdict === 'pass')
    cases[id] = {
      title: one.title,
      verdict: failed.length ? 'failed' : passed.length ? 'passed' : 'not run',
      passed: passed.length,
      failed: failed.length,
      notRun: mine.filter((r) => r.verdict === 'not-run').length,
    }
  }
  const finished = Date.now()
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        versions,
        aborted: aborted ?? null,
        cases,
        checks: records,
      },
      null,
      2,
    ),
  )
}
process.on('exit', writeReport)

/** One check: the case it is evidence for, what was observed, and the verdict. A fail also keeps a screenshot. */
function chk(ac, name, ok, observation = '', page) {
  const listed = ac === 'harness' || CASES[ac]?.checks.includes(name)
  const record = { ac, name, verdict: ok ? 'pass' : 'fail', observation: String(observation ?? '').slice(0, 1500), screenshot: lastShot ?? null }
  if (!listed) record.unlisted = true
  records.push(record)
  tally(`${ac}: ${name}`, ok, String(observation ?? '').slice(0, 300))
  if (!ok && page) {
    const path = join(SHOTS, `workbench-fail-${records.length}.png`)
    page.screenshot({ path }).then(() => (record.screenshot = path)).catch(() => {})
  }
}
/** A check that could not be made: neither a pass nor a fail, and it says why. */
function skip(ac, name, reason) {
  records.push({ ac, name, verdict: 'not-run', observation: `not run: ${reason}`, screenshot: null })
  console.log(`NOTRUN ${ac}: ${name}  ${reason}`)
}
const harness = (name, ok, observation, page) => chk('harness', name, ok, observation, page)

class NotRun extends Error {}

function abort(reason) {
  aborted = reason
  console.error(`ABORTED: ${reason}`)
  process.exit(2)
}

// ---- the core must be the pinned one --------------------------------------------------------

versions.core = coreVersion()
if (!versions.core.includes(PINNED_CORE))
  abort(`The Herdr core here is "${versions.core}", but the host image pins ${PINNED_CORE}. Point E2E_HERDR_HC at a ${PINNED_CORE} core and start the stack again; nothing was run.`)

// ---- the page --------------------------------------------------------------------------------

const GRID = '[id^="workbench-"]'
/** A bound Herdr pane: its session, what it says when it is not simply running, and its binding epoch. */
const STATUS = /(hc-[0-9a-f-]{36}) \| Herdr \| (?:([^|\n]+?) \| )?epoch (\d+)/
const VIEWPORT = { width: 1440, height: 900 }
const pause = (ms) => new Promise((settle) => setTimeout(settle, ms))

const session = await open('/')
const { page: a, context, browser } = session
versions.chromium = browser.version()
const identity = await (await context.request.get(`${UI}/api/environment/v1/bootstrap`, READ)).json()
setPrincipals([identity.principalId])
await context.addInitScript(() => { try { localStorage.setItem('theorem-ui:workbench', '1') } catch {} })

const lines = async (page) =>
  (await page.evaluate((grid) => document.querySelector(grid)?.innerText ?? '', GRID).catch(() => ''))
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
const screen = async (page) => (await lines(page)).join('\n')

async function waitFor(page, test, what, ms = 25_000) {
  const re = test instanceof RegExp ? test : undefined
  const until = Date.now() + ms
  let text = ''
  while (Date.now() < until) {
    text = await screen(page)
    const hit = re ? text.match(re) : test(text)
    if (hit) return hit
    await pause(250)
  }
  throw new Error(`Never saw ${what}. The page showed:\n${text.slice(0, 700)}`)
}

const shot = async (page, name) => {
  const path = join(SHOTS, `workbench-${name}`)
  await page.screenshot({ path: `${path}.png` })
  writeFileSync(`${path}.txt`, await screen(page))
  lastShot = `${path}.png`
}

const status = async (page) => {
  const m = (await screen(page)).match(STATUS)
  return m && { id: m[1], what: m[2], epoch: Number(m[3]) }
}

async function openChooser(page) {
  // The shortcut does nothing until the host has named a workspace, so ask again until it opens.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.keyboard.press('Meta+Alt+s')
    const opened = await waitFor(page, /Shell on |Shell \|/, 'the Shell chooser', 8_000).catch(() => null)
    if (opened) break
    if (attempt === 4) throw new Error(`The Shell chooser did not open:\n${(await screen(page)).slice(0, 600)}`)
  }
  if (!/maximized/.test(await screen(page))) await page.keyboard.press('Meta+Alt+m')
  await waitFor(page, /maximized/, 'the pane to be maximised')
}

async function ensureChooser(page) {
  if (!/Start a new process/.test(await screen(page))) await openChooser(page)
}

/** Moves the chooser's selection to the row whose title matches, then presses `key` (Enter chooses or attaches). */
async function choose(page, re, key = 'Enter') {
  await page.keyboard.press('Home')
  await pause(250)
  for (let i = 0; i < 400; i++) {
    const selected = (await lines(page)).find((line) => line.startsWith('> '))
    if (selected && re.test(selected)) return void (await page.keyboard.press(key))
    await page.keyboard.press('ArrowDown')
    await pause(120)
  }
  throw new Error(`No chooser row matched ${re}:\n${(await screen(page)).slice(0, 500)}`)
}

/** The colour of the first cell of `needle` in a row that does not hold `notIn`. */
const cellColour = (page, needle, notIn) =>
  page.evaluate(
    ([grid, needle, notIn]) => {
      for (const row of document.querySelectorAll(`${grid} pre`)) {
        const cells = [...row.children]
        const text = cells.map((cell) => cell.textContent).join('')
        if (text.includes(notIn)) continue
        const at = text.indexOf(needle)
        if (at >= 0) return getComputedStyle(cells[at]).color
      }
      return null
    },
    [GRID, needle, notIn],
  )

/** A CSS custom property of the page, resolved by the browser to rgb(). Empty when the page does not define it. */
const pageColour = (page, property) =>
  page.evaluate((property) => {
    if (!getComputedStyle(document.documentElement).getPropertyValue(property).trim()) return null
    const probe = document.createElement('span')
    probe.hidden = true
    probe.style.color = `var(${property})`
    document.documentElement.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  }, property)

const say = async (page, command) => {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

// ---- the host, as a second client sees it ----------------------------------------------------

let workspace
const listCall = () => hostApi('POST', `/workspaces/${workspace}/operations/terminal.list`, {})
const terminalsOf = async () => (await listCall()).json
async function hostShell(name) {
  const r = await hostApi('POST', `/workspaces/${workspace}/operations/terminal.open`, { backend: 'herdr', name, cols: 120, rows: 30 })
  if (r.status !== 200) throw new Error(`terminal.open ${r.status} ${r.text.slice(0, 200)}`)
  return r.json
}
const liveCount = () => coreTerminals().filter((t) => t.state === 'live').length
const killAll = async () => {
  for (const t of coreTerminals()) hc('kill', t.address)
  await pause(500)
}
async function ensureHost(extraEnv) {
  if (extraEnv || !(await hostUp())) {
    killHost('SIGKILL')
    for (let i = 0; i < 40 && (await hostUp()); i++) await pause(250)
    startHost(extraEnv)
  }
  for (let i = 0; i < 80 && !(await hostUp()); i++) await pause(250)
}
async function reloaded(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(page, /Theo|Shell/, 'the workbench after a reload', 90_000)
}

/** A new session made through the host and attached from the chooser. */
async function attachFresh(page, name) {
  const made = await hostShell(name)
  await ensureChooser(page)
  await waitFor(page, new RegExp(made.session), 'the new session in the chooser', 40_000)
  await choose(page, new RegExp(made.session))
  await waitFor(page, new RegExp(`${made.session} \\| Herdr \\| epoch \\d+`), 'the attached session')
  return made
}

/** What typed text does: the program's answer, or the pane's refusal as the reason this case cannot go on. */
async function inputWorks(page) {
  await page.keyboard.type('echo RDY$((1+1))')
  await page.keyboard.press('Enter')
  const ok = await waitFor(page, (t) => t.split('\n').some((l) => l.trim().endsWith('RDY2')), 'the typed command to run', 8_000).catch(() => null)
  if (!ok) {
    const why = (await screen(page)).split('\n').find((l) => /Input (failed|refused)/.test(l)) ?? 'no answer from the program'
    throw new NotRun(`the pane's typed input did not reach the program (${why})`)
  }
}

const extra = []
async function secondBrowser() {
  const context2 = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark', storageState: await context.storageState() })
  await context2.addInitScript(() => { try { localStorage.setItem('theorem-ui:workbench', '1') } catch {} })
  extra.push(context2)
  const page = await context2.newPage()
  page.setDefaultTimeout(30_000)
  return page
}

/** One case, with its own setup and teardown. Whatever happens in it, the next case starts clean. */
async function ac(id, run) {
  log(`--- ${id}`)
  caseId = id
  lastShot = undefined
  try {
    await ensureHost()
    await killAll()
    await a.setViewportSize(VIEWPORT)
    await a.goto(`${UI}/?workbench=1`, { waitUntil: 'domcontentloaded' })
    await waitFor(a, /Theo/, 'the workbench', 90_000)
    await run()
  } catch (error) {
    if (error instanceof NotRun) {
      skip(id, 'the rest of the case', error.message)
    } else {
      chk(id, 'the case ran to its end', false, String(error.message).slice(0, 700), a)
      await shot(a, `${id}-failed`).catch(() => {})
    }
  } finally {
    for (const other of extra.splice(0)) await other.close().catch(() => {})
    await killAll().catch(() => {})
    await ensureHost().catch(() => {})
  }
  caseId = 'harness'
}

// ---- find the workspace ----------------------------------------------------------------------

mkdirSync(HOST_ROOT, { recursive: true })
await ensureHost()
await killAll()
await a.goto(`${UI}/?workbench=1`, { waitUntil: 'domcontentloaded' })
await waitFor(a, /Theo/, 'the workbench', 90_000).catch(() => abort('The workbench never drew; the stack is not serving the UI.'))
await openChooser(a).catch((error) => abort(`No Shell chooser: ${error.message.slice(0, 200)}`))
await waitFor(a, /workspace chatproj_/, 'the host to name a workspace').catch(() => abort('The host named no workspace to the pane.'))
workspace = (await screen(a)).match(/workspace (chatproj_[A-Za-z0-9_-]+)/)[1]
mkdirSync(join(HOST_ROOT, workspace, 'checkout'), { recursive: true })
writeFileSync(join(HOST_ROOT, workspace, 'checkout', 'notes.txt'), 'one\ntwo\nthree\n')
const caps0 = await hostApi('GET', `/workspaces/${workspace}/capabilities`)
versions.host = caps0.json?.version ?? caps0.json?.host?.version ?? caps0.json?.backends?.herdr?.version ?? 'not reported by the host'
harness('the host reports the pinned core', String(caps0.json?.backends?.herdr?.version ?? '').includes(PINNED_CORE), `host says core ${caps0.json?.backends?.herdr?.version}; hc says ${versions.core}`)

// ---- AC-29: readiness and explicit profiles --------------------------------------------------

await ac('AC-29', async () => {
  await openChooser(a)
  await waitFor(a, /workspace chatproj_/, 'the host to name a workspace')
  const detail = (text, title) => {
    const at = text.indexOf(title)
    return at < 0 ? '' : text.slice(at, text.indexOf('\n', text.indexOf('\n', at) + 1))
  }
  const text = await screen(a)
  await shot(a, 'ac29-chooser')
  for (const label of ['Start Shell', 'Start Herdr shell', 'Start Claude Code (Herdr)', 'Start Codex (Herdr)'])
    chk('AC-29', `the chooser offers "${label}"`, text.includes(label), '', a)
  // The row is judged by what it says once the host has had time to answer, and the wait is the observation.
  const begin = Date.now()
  let row = detail(text, 'Start Herdr shell')
  while (/unavailable|not ready/.test(row) && Date.now() - begin < 15_000) {
    await pause(500)
    row = detail(await screen(a), 'Start Herdr shell')
  }
  const waited = Date.now() - begin
  chk('AC-29', 'Herdr shell is shown as ready, not unavailable (and how long that took)', /Herdr \| survives pane close/.test(row) && !/unavailable|not ready/.test(row), `${row.split('\n')[1]?.trim()} (after ${waited} ms)`, a)
  chk('AC-29', 'Shell is shown as native, a different choice from the Herdr shell', /native \| not kept by Herdr/.test(detail(text, 'Start Shell')), detail(text, 'Start Shell').split('\n')[1]?.trim(), a)
  const caps = await hostApi('GET', `/workspaces/${workspace}/capabilities`)
  chk('AC-29', 'the host itself reports Herdr ready', caps.json?.backends?.herdr?.ready === true, `core ${caps.json?.backends?.herdr?.version}`, a)
  skip('AC-29', 'older host with missing capability fields, and a malformed profile or program', 'needs a host build that omits capability fields and a way to inject a malformed profile; this scenario has only the one built host')
})

// ---- AC-30: rendering ------------------------------------------------------------------------

/** Whether a program can be looked for and started: on this machine's PATH, which is the host's PATH. */
const installed = (program) => spawnSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' }).stdout.trim()

async function profile(label, program, name) {
  const where = installed(program)
  if (!where) return skip('AC-30', `${label} profile: starts and draws its own screen`, `${program} is not installed on this machine`)
  await ensureChooser(a)
  const before = coreTerminals().length
  await choose(a, new RegExp(`Start ${label.replace(/[()]/g, '\\$&')}`))
  const bound = await waitFor(a, STATUS, `${label} to be bound`, 25_000).catch(() => null)
  const text = await screen(a)
  await shot(a, `ac30-${name}`)
  if (!bound) {
    chk('AC-30', `${label} profile: starts and draws its own screen`, false, `it did not start from the pane: ${text.split('\n').slice(1, 5).join(' / ')}`, a)
    return
  }
  if (/log ?in|sign ?in|authenticate|api key|not logged|choose a (theme|login)|welcome to/i.test(text) && !/Start (a new process|Shell)/.test(text.split('\n').slice(0, 2).join('')))
    return skip('AC-30', `${label} profile: starts and draws its own screen`, `${program} is installed but is asking to sign in or set up; sign it in on this machine first`)
  const drawn = text.split('\n').filter((l) => l.trim() && !STATUS.test(l)).length
  chk('AC-30', `${label} profile: starts and draws its own screen`, drawn > 2 && coreTerminals().length > before, `${drawn} lines drawn under ${bound[0]}; core ${before} -> ${coreTerminals().length}`, a)
  const id = bound[1]
  await hostApi('POST', `/workspaces/${workspace}/operations/terminal.kill`, { session: id }).catch(() => {})
  await pause(800)
}

await ac('AC-30', async () => {
  await openChooser(a)
  await choose(a, /Start Herdr shell/)
  const started = await waitFor(a, STATUS, 'a bound Herdr shell', 20_000).then(() => true, () => false)
  const text = await screen(a)
  await shot(a, 'ac30-started')
  chk('AC-30', '"Start Herdr shell" starts a Herdr shell from the pane', started, started ? '' : text.split('\n').slice(1, 5).join(' / '), a)
  if (!started) {
    // The rest of this case does not depend on how the shell was started: attach one made through the host.
    log('fallback: a session made through the host API, attached from the chooser')
    await attachFresh(a, 'wb-shell')
  }
  await waitFor(a, /\$ $|\$ \n|\$\s*$/m, 'a prompt', 20_000).catch(() => {})
  await a.keyboard.type('echo PROBE$((1+1))')
  await a.keyboard.press('Enter')
  const typed = await waitFor(a, (t) => t.split('\n').some((l) => l.trim().endsWith('PROBE2')), 'the typed command to run', 6_000).catch(() => null)
  const refusal = (await screen(a)).split('\n').find((l) => /Input (failed|refused)/.test(l))
  chk('AC-30', 'what is typed in the pane reaches the program', Boolean(typed), refusal ?? '', a)
  if (!typed) throw new NotRun(`the pane's typed input did not reach the program, so the colour, wide-character, pager and vim exercises cannot be driven (${refusal ?? 'no answer'})`)

  await say(a, "printf '\\033[31mRED16\\033[0m \\033[38;5;208mORANGE256\\033[0m \\033[38;2;12;200;99mTRUE24\\033[0m\\n'")
  await waitFor(a, (t) => t.split('\n').some((l) => l.includes('RED16 ORANGE256 TRUE24') && !l.includes('printf')), 'the colour line')
  const [red, orange, truecolor] = [await cellColour(a, 'RED16', 'printf'), await cellColour(a, 'ORANGE256', 'printf'), await cellColour(a, 'TRUE24', 'printf')]
  // The sixteen colours are the page's own palette (the active theme), so what is expected is read from the page.
  const themedRed = await pageColour(a, '--term-error')
  if (!themedRed) skip('AC-30', '16-colour SGR red is drawn in the page\'s own themed red', 'the page defines no --term-error to read the themed red from')
  else chk('AC-30', '16-colour SGR red is drawn in the page\'s own themed red', red === themedRed, `cell ${red}; the page's --term-error resolves to ${themedRed} (only slot 1, red, is compared)`, a)
  chk('AC-30', '256-colour SGR (index 208) is drawn exactly', orange === 'rgb(255, 135, 0)', orange ?? 'no cell found', a)
  chk('AC-30', 'truecolor SGR is drawn exactly', truecolor === 'rgb(12, 200, 99)', truecolor ?? 'no cell found', a)

  await say(a, "printf '日本語|WIDE|ｱｲｳ|end\\n'")
  const wide = await waitFor(a, (t) => t.split('\n').find((l) => /日\s?本\s?語\s?\|WIDE\|/.test(l) && !l.includes('printf')), 'the wide-character line', 10_000).catch(() => null)
  chk('AC-30', 'wide characters are drawn and what follows them is not shifted', Boolean(wide) && /\|WIDE\|.*end/.test((await screen(a)).split('\n').find((l) => /\|WIDE\|/.test(l) && !l.includes('printf')) ?? ''), wide ? '' : 'the line never drew', a)
  await shot(a, 'ac30-colour-wide')

  await say(a, "seq 1 300 | sed 's/^/LESSLINE/' | less")
  await waitFor(a, /LESSLINE1\b/, 'the pager')
  const inPager = !(await screen(a)).includes('RED16 ORANGE256')
  await shot(a, 'ac30-pager')
  await a.keyboard.type('q')
  const back = await waitFor(a, (t) => !/LESSLINE1\b/.test(t) && t.includes('RED16 ORANGE256'), 'the shell screen back', 10_000).then(() => true, () => false)
  chk('AC-30', 'a full-screen program (a pager) replaces the screen and gives it back', inPager && back, `screen replaced: ${inPager}; shell screen restored: ${back}`, a)

  await say(a, "vim -u NONE -c 'call setline(1, \"VIMTEXT\")'")
  const inVim = await waitFor(a, /VIMTEXT/, 'vim', 10_000).then(() => true, () => false)
  const shellGone = !(await screen(a)).includes('RED16 ORANGE256')
  await a.keyboard.type(':q!')
  await a.keyboard.press('Enter')
  const vimBack = await waitFor(a, (t) => !/VIMTEXT/.test(t) && t.includes('RED16 ORANGE256'), 'the shell after vim', 10_000).then(() => true, () => false)
  chk('AC-30', 'vim is drawn on the alternate screen and gives the shell screen back', inVim && shellGone && vimBack, `drawn ${inVim}; shell hidden ${shellGone}; restored ${vimBack}`, a)
  await shot(a, 'ac30-after-vim')
  skip('AC-30', 'paste and resize reach the program', 'paste into the DOM-backed grid is not driven here; resize ownership is the subject of AC-36')

  // The supported CLI profiles, when they are there to run.
  await profile('Claude Code (Herdr)', 'claude', 'claude')
  await profile('Codex (Herdr)', 'codex', 'codex')
})

// ---- AC-32: reload ---------------------------------------------------------------------------

await ac('AC-32', async () => {
  const mine = await attachFresh(a, 'wb-reload')
  await inputWorks(a)
  await say(a, 'echo WBPID=$$=')
  const pid = (await waitFor(a, /\nWBPID=(\d+)=/, 'the shell pid'))[1]
  const was = await status(a)
  await reloaded(a)
  await waitFor(a, STATUS, 'the pane to be bound again after the reload', 60_000)
  const now = await status(a)
  chk('AC-32', 'the pane is bound to the same session after a reload', now.id === was.id, `${was.id} -> ${now.id}`, a)
  chk('AC-32', 'earlier output is still on the screen', (await screen(a)).includes('WBPID='), '', a)
  await shot(a, 'ac32-reloaded')
  await say(a, 'echo WBPID2=$$=')
  const after = await waitFor(a, /\nWBPID2=(\d+)=/, 'a new command to run')
  chk('AC-32', 'a new command runs in the same shell process (no second launch)', after[1] === pid, `${pid} / ${after[1]}`, a)
  chk('AC-32', 'the core holds one live terminal for it', liveCount() === 1 && mine.session === now.id, `${liveCount()} live`, a)
})

// ---- AC-36 then AC-35: a second browser of the same account ----------------------------------

const freshSize = async (page) => {
  const before = [...(await screen(page)).matchAll(/\nSZ(\d+x\d+)Z/g)].length
  await say(page, 'echo SZ$(stty size | tr " " x)Z')
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    const all = [...(await screen(page)).matchAll(/\nSZ(\d+x\d+)Z/g)]
    if (all.length > before) return all.at(-1)[1]
    await pause(250)
  }
}

/** A second browser of the same account, attached to `mine` from its chooser. */
async function secondView(mine) {
  const b = await secondBrowser()
  await b.goto(`${UI}/?workbench=1`, { waitUntil: 'domcontentloaded' })
  await waitFor(b, /Theo/, 'the second workbench', 90_000)
  await openChooser(b)
  await waitFor(b, new RegExp(mine.session), 'the session in the second chooser', 40_000)
  await choose(b, new RegExp(mine.session))
  await waitFor(b, new RegExp(`${mine.session} \\| Herdr \\| epoch \\d+`), 'the second view attached')
  return b
}

await ac('AC-36', async () => {
  const mine = await attachFresh(a, 'wb-resize')
  await inputWorks(a)
  const b = await secondView(mine)
  await say(b, 'echo BKEYS$((2+2))')
  const keys = await waitFor(a, (t) => t.split('\n').some((l) => l.trim().endsWith('BKEYS4')), 'the second view\'s keys in A', 15_000).then(() => true, () => false)
  chk('AC-36', 'the second browser attaches to the same session and its pane accepts keys', keys, '', b)
  await b.setViewportSize({ width: 1300, height: 800 })
  await pause(800)
  const s0 = await freshSize(b)
  await b.setViewportSize({ width: 900, height: 600 })
  await pause(800)
  const s1 = await freshSize(b)
  chk('AC-36', 'resizing the second browser changes the program\'s grid', Boolean(s0) && Boolean(s1) && s0 !== s1, `${s0} -> ${s1}`, b)
  await a.setViewportSize({ width: 1200, height: 760 })
  await pause(800)
  const s2 = await freshSize(a)
  chk('AC-36', 'resizing the first browser changes the program\'s grid again', Boolean(s2) && s2 !== s1, `${s1} -> ${s2}`, a)
  await a.setViewportSize(VIEWPORT)
  await shot(a, 'ac36-first')
  await shot(b, 'ac36-second')
})

await ac('AC-35', async () => {
  const mine = await attachFresh(a, 'wb-shared')
  await inputWorks(a)
  const b = await secondView(mine)
  const inBoth = (page, end, what) =>
    waitFor(page, (t) => t.split('\n').some((l) => l.trim().endsWith(end)), what, 15_000).then(() => true, () => false)
  await say(a, 'echo SEEN$((1+2))')
  chk('AC-35', 'the second browser sees the first browser\'s output', await inBoth(b, 'SEEN3', 'A\'s output in B'), '', b)
  await say(b, 'echo BWRITES$((5+5))')
  const bw = (await inBoth(a, 'BWRITES10', 'B\'s output in A')) && (await inBoth(b, 'BWRITES10', 'B\'s output in B'))
  chk('AC-35', 'the second browser\'s typing reaches the program and shows in both', bw, '', a)
  await say(a, 'echo AWRITES$((3+4))')
  const aw = (await inBoth(a, 'AWRITES7', 'A\'s output in A')) && (await inBoth(b, 'AWRITES7', 'A\'s output in B'))
  chk('AC-35', 'the first browser\'s typing still reaches the program and shows in both', aw, '', b)
  await shot(a, 'ac35-first')
  await shot(b, 'ac35-second')
})

// ---- AC-33 and AC-57: the host restarts, the core stays ---------------------------------------

await ac('AC-33', async () => {
  await attachFresh(a, 'wb-restart')
  await inputWorks(a)
  await say(a, 'export WBVAR=alive$((100+23)); echo WBPID3=$$=')
  const p3 = (await waitFor(a, /\nWBPID3=(\d+)=/, 'the pid'))[1]
  const was = await status(a)
  const coreBefore = coreTerminals().map((t) => t.address).join()
  killHost('SIGKILL')
  for (let i = 0; i < 40 && (await hostUp()); i++) await pause(250)
  chk('AC-33', 'the host process is gone while the core and its terminal stay', !(await hostUp()) && coreTerminals().map((t) => t.address).join() === coreBefore && coreBefore !== '', `core terminals: ${coreBefore}`, a)
  // What the pane says while the host is away, in its own words (a key press makes it try).
  await a.keyboard.type('x')
  await pause(6000)
  const away = await screen(a)
  writeFileSync(join(SHOTS, 'workbench-ac33-host-away.txt'), away)
  await shot(a, 'ac33-host-away')
  const said = away.split('\n').filter((l) => /host|connect|reconnect|unavailable|gone|lost|offline/i.test(l)).slice(0, 4).join(' / ')
  chk('AC-57', 'while the host is away the pane says in plain words that it is gone', /host.*(gone|away|unreachable|unavailable|not answering|reconnect)|reconnect|cannot reach|unavailable|lost/i.test(away), said || '(nothing said; the pane shows the status line only)', a)
  chk('AC-57', 'while the host is away the pane makes no claim that the program continues or moved', !/continues under|Program replaced|resumed|moved to/i.test(away), away.split('\n').find((l) => /continues under|Program replaced|resumed|moved to/i.test(l)) ?? '', a)
  startHost()
  for (let i = 0; i < 80 && !(await hostUp()); i++) await pause(250)
  const readopted = await waitFor(a, (t) => {
    const m = t.match(STATUS)
    return m && Number(m[3]) > was.epoch
  }, 'the pane to re-adopt the terminal under a new epoch', 90_000).then(() => true, () => false)
  const now = await status(a)
  chk('AC-33', 'the same terminal is re-adopted under a new binding epoch', readopted && now?.id === was.id && now.epoch > was.epoch, `${was.id} epoch ${was.epoch} -> ${now?.id} epoch ${now?.epoch}`, a)
  await shot(a, 'ac33-readopted')
  const prov = (await screen(a)).split('\n').filter((l) => /continues under binding epoch|repainted|Re-attached/.test(l))
  chk('AC-33', 'the pane says the same program continues under the new epoch', prov.length > 0, prov[0] ?? 'no such line', a)
  const text = await screen(a)
  chk('AC-33', 'bytes from the old epoch are not repainted onto the new binding', (text.match(/WBPID3=/g) ?? []).length <= 2, `${(text.match(/WBPID3=/g) ?? []).length} copies of the old command's echo on screen`, a)
  if (!now || now.epoch <= was.epoch) return
  await say(a, 'echo WBBACK=$WBVAR=$$=')
  const back = await waitFor(a, /\nWBBACK=(\w+)=(\d+)=/, 'the program\'s answer after the restart', 20_000).catch(() => null)
  chk('AC-33', 'the program is the same live process (variable and pid survived)', Boolean(back) && back[1] === 'alive123' && back[2] === p3, back ? `${back[1]} ${back[2]} vs ${p3}` : 'no answer from the program after the restart', a)
})

// ---- AC-34: loss and replacement -------------------------------------------------------------

await ac('AC-34', async () => {
  const lost = await attachFresh(a, 'wb-lose')
  await inputWorks(a)
  const liveBefore = liveCount()
  await say(a, 'kill -9 $$')
  const ended = await waitFor(a, /The program (has ended|is lost)\./, 'the pane saying the program ended', 30_000).then(() => true, () => false)
  await shot(a, 'ac34-killed')
  chk('AC-34', 'the pane says the process ended', ended, (await screen(a)).match(STATUS)?.[0] ?? '', a)
  await pause(3000)
  chk('AC-34', 'no replacement was started silently', (await status(a))?.id === lost.session && liveCount() < liveBefore, `live ${liveBefore} -> ${liveCount()}`, a)
  await a.keyboard.press('n')
  await pause(1500)
  const note = (await screen(a)).split('\n').find((l) => /not running|different process|does not continue/.test(l))
  chk('AC-34', 'starting a new one is its own action and is said to be a different process', Boolean(note), note ?? 'no such line', a)
  await shot(a, 'ac34-new-is-explicit')
  await choose(a, /Start Herdr shell/).catch(() => {})
  await pause(2500)
  const startedId = (await status(a))?.id
  chk('AC-34', 'a new Herdr shell started from the chooser has a different identity from the lost one', Boolean(startedId) && startedId !== lost.session, startedId ?? 'the pane could not start one', a)

  // The core's terminal ended from outside.
  const outer = await attachFresh(a, 'wb-core-kill')
  const address = (await terminalsOf()).sessions.find((s) => s.session === outer.session)?.binding?.terminal
  hc('kill', address)
  const coreEnded = await waitFor(a, /The program (has ended|is lost)\./, 'the pane noticing the core ended the terminal', 30_000).then(() => true, () => false)
  chk('AC-34', 'a terminal the core ended is shown as ended too', coreEnded, address, a)
  await shot(a, 'ac34-core-killed')

  // A kept terminal: the core's own recovery puts a shell where the program was; the pane must not call it the same work.
  const kept = await attachFresh(a, 'wb-kept')
  const keptAddress = (await terminalsOf()).sessions.find((s) => s.session === kept.session)?.binding?.terminal
  hc('keep', keptAddress)
  await say(a, 'echo KEPTPID=$$=')
  const keptPid = (await waitFor(a, /\nKEPTPID=(\d+)=/, 'the kept shell pid'))[1]
  await say(a, 'kill -9 $$')
  const replaced = await waitFor(a, /Program replaced: the original is gone and program (\d+) took its place|The program (has ended|is lost)\./, 'the pane after a kept terminal lost its program', 40_000).catch(() => null)
  await shot(a, 'ac34-kept-replaced')
  chk('AC-34', 'a kept terminal\'s replacement is announced as a replacement that did not resume the work', Boolean(replaced) && /Program replaced/.test(replaced[0]), replaced?.[0]?.slice(0, 120) ?? 'the pane said neither', a)
  if (replaced && /Program replaced/.test(replaced[0])) {
    await say(a, 'echo NEWPID=$$=')
    const fresh = (await waitFor(a, /\nNEWPID=(\d+)=/, 'the replacement shell'))[1]
    chk('AC-34', 'the replacement is a different process', fresh !== keptPid, `${keptPid} -> ${fresh}`, a)
    const k = await hostApi('POST', `/workspaces/${workspace}/operations/terminal.kill`, { session: kept.session })
    await pause(4000)
    const live = coreTerminals().find((t) => t.address === keptAddress)
    chk('AC-34', 'an explicit kill of the replacement stays final', k.status === 200 && (!live || live.state !== 'live') && /has ended|is lost/.test(await screen(a)), `kill ${k.status}; core ${live?.state ?? 'gone'}`, a)
    await shot(a, 'ac34-explicit-kill')
  } else {
    skip('AC-34', 'the replacement is a different process', 'no replacement appeared to compare with')
    skip('AC-34', 'an explicit kill of the replacement stays final', 'no replacement appeared to kill')
  }
})

// ---- AC-37: more terminals than the opening snapshot holds ------------------------------------

await ac('AC-37', async () => {
  const before = Math.floor(OPENING_NOTICES * 2) + 4 // exceeds the opening snapshot twice over
  const during = 24 // arriving while the workspace is opening
  const made = []
  const open1 = async (i) => {
    const t = await hostShell(`wb-many-${i}`).catch((error) => ({ error: String(error) }))
    if (t.session) made.push(t.session)
  }
  const batch = async (from, to) => {
    for (let i = from; i < to; i += 8) await Promise.all(Array.from({ length: Math.min(8, to - i) }, (_, k) => open1(i + k)))
  }
  const deadline = Date.now() + 150_000
  await batch(0, before)
  chk('AC-37', 'enough terminals were made to exceed the opening snapshot', made.length > OPENING_NOTICES, `${made.length} made before opening; the host's opening pass takes ${OPENING_NOTICES}`)
  if (made.length <= OPENING_NOTICES) throw new NotRun(`only ${made.length} terminals could be made; the opening snapshot (${OPENING_NOTICES}) is not exceeded`)
  killHost('SIGKILL')
  for (let i = 0; i < 40 && (await hostUp()); i++) await pause(250)
  startHost()
  for (let i = 0; i < 80 && !(await hostUp()); i++) await pause(100)
  const states = []
  const sample = async () => {
    const r = await listCall().catch(() => undefined)
    states.push(r?.json?.adoption ? `${Date.now() - t0}ms ${r.json.adoption.state}:${r.json.sessions?.length ?? 0}` : `${Date.now() - t0}ms http${r?.status ?? 'none'}`)
  }
  const t0 = Date.now()
  // Terminals keep arriving from another client while the workspace is opening.
  const arriving = Date.now() < deadline ? batch(before, before + during) : Promise.resolve()
  const reload = reloaded(a)
  const seen = new Set()
  let settledAt
  let opened
  const until = Date.now() + 90_000
  while (Date.now() < until && !(settledAt && opened)) {
    await sample()
    const text = await screen(a)
    if (/may be incomplete/.test(text)) seen.add('pane-incomplete')
    if (!opened && /Theo|Shell/.test(text)) opened = Date.now() - t0
    const last = states.at(-1) ?? ''
    if (!settledAt && /settled:(\d+)/.test(last) && Number(last.match(/settled:(\d+)/)[1]) >= made.length + during) settledAt = Date.now() - t0
    await pause(100)
  }
  await reload.catch(() => {})
  await arriving
  await sample()
  await openChooser(a).catch(() => {})
  writeFileSync(join(SHOTS, 'workbench-ac37-states.txt'), states.join('\n'))
  await shot(a, 'ac37-settled')
  const total = made.length
  const firstPending = states.findIndex((s) => / pending:/.test(s))
  chk('AC-37', 'the host reported adoption as pending while it was still adopting', firstPending >= 0, [...new Set(states.map((s) => s.replace(/^\d+ms /, '')))].slice(0, 10).join(' '), a)
  chk('AC-37', 'the pane showed the first listing as incomplete', seen.has('pane-incomplete'), seen.size ? 'the incomplete note appeared' : 'the incomplete note never appeared (sampled every ~100 ms)', a)
  chk('AC-37', 'opening completed without waiting for the terminals created while it was opening', Boolean(opened) && (!settledAt || opened <= settledAt), `workspace drawn at ${opened ?? 'never'} ms; fully listed at ${settledAt ?? 'never'} ms`, a)
  chk('AC-37', 'later arrivals were adopted asynchronously until every terminal is listed', Boolean(settledAt), `${total} made in all (${before} before, ${total - before} during); last state ${states.at(-1)}`, a)
  const t1 = Date.now()
  killHost('SIGTERM')
  let gone = false
  for (let i = 0; i < 40; i++) if (!(await hostUp())) { gone = true; break } else await pause(250)
  chk('AC-37', 'restarting the host is not blocked by the queue', gone, `the host stopped ${gone ? `after ${Date.now() - t1} ms` : 'not within 10 s of SIGTERM'}`, a)
})

// ---- AC-40: failed subscription --------------------------------------------------------------

await ac('AC-40', async () => {
  const kept = await hostShell('wb-recover')
  const before = coreTerminals().length
  // The core is unavailable when the host opens the workspace: a host whose core binary is missing.
  await ensureHost({ THEOREM_HERDR_HC: join(HOST_ROOT, 'no-such-core') })
  await reloaded(a)
  await openChooser(a).catch(() => {})
  await pause(4000)
  const down = await screen(a)
  await shot(a, 'ac40-core-unavailable')
  const note = down.split('\n').find((l) => /cannot list|unavailable|could not/i.test(l))
  const row = down.split('\n').slice(down.split('\n').findIndex((l) => /Start Herdr shell/.test(l))).slice(0, 2).join(' / ')
  chk('AC-40', 'with the core unavailable at open, the chooser names the failure and a next step', Boolean(note) && /Esc|Enter|retry|try again|again/i.test(down), note ?? 'no failure named', a)
  // And the explicit Herdr profile does not turn into some other shell.
  const terminalsBefore = coreTerminals().length
  await choose(a, /Start Herdr shell/).catch(() => {})
  await pause(3000)
  const afterStart = await screen(a)
  chk('AC-29', 'with the core unavailable the Herdr row names the failure and starting it leaves no shell of any kind', !/\| Herdr \| epoch \d+/.test(afterStart) && coreTerminals().length === terminalsBefore, `row: ${row}; core ${terminalsBefore} -> ${coreTerminals().length}`, a)
  skip('AC-40', 'subscribe reply timeout', 'needs a core that accepts the subscribe and never answers; this scenario has only the real core and may not edit the backend')
  // Availability returns: the host comes back with its core.
  await ensureHost({})
  await reloaded(a)
  await openChooser(a).catch(() => {})
  await waitFor(a, new RegExp(kept.session), 'the surviving terminal listed again', 60_000)
  chk('AC-40', 'once the core is available the same terminal is listed again, with no second launch', coreTerminals().length === before, `${before} -> ${coreTerminals().length}`, a)
  await shot(a, 'ac40-recovered')

  // The core closes the subscription under a running host: what each side says, and how soon.
  const baseline = new Set((await lines(a)))
  const t0 = Date.now()
  hc('server', 'stop')
  const timeline = []
  let hostSaid
  let paneSaid
  while (Date.now() - t0 < 45_000 && !(hostSaid !== undefined && paneSaid !== undefined)) {
    const r = await listCall().catch(() => undefined)
    const adoption = r?.json?.adoption
    const hostView = r ? `http ${r.status} ${JSON.stringify(adoption ?? r.json?.code ?? r.json?.message ?? null)} sessions ${r.json?.sessions?.length ?? '-'}` : 'no answer'
    const spoke = r ? r.status !== 200 || (adoption && adoption.state !== 'settled') || Boolean(adoption?.reason || adoption?.error) : true
    const lineNew = (await lines(a)).find((l) => !baseline.has(l) && /cannot|unavailable|lost|ended|closed|not connected|failed/i.test(l))
    const at = Date.now() - t0
    if (!timeline.length || timeline.at(-1).host !== hostView || timeline.at(-1).pane !== (lineNew ?? ''))
      timeline.push({ ms: at, host: hostView, pane: lineNew ?? '' })
    if (spoke && hostSaid === undefined) hostSaid = at
    if (lineNew && paneSaid === undefined) paneSaid = at
    await pause(400)
  }
  await shot(a, 'ac40-core-closed')
  writeFileSync(join(SHOTS, 'workbench-ac40-timeline.json'), JSON.stringify(timeline, null, 2))
  const story = JSON.stringify(timeline.slice(0, 8))
  chk('AC-40', 'a core that closes its subscription: the host says so (timeline)', hostSaid !== undefined, hostSaid !== undefined ? `the host said so after ${hostSaid} ms; ${story}` : `the host never left "settled" in 45 s; ${story}`, a)
  chk('AC-40', 'a core that closes its subscription: the pane says so (timeline)', paneSaid !== undefined, paneSaid !== undefined ? `the pane said so after ${paneSaid} ms; ${story}` : `no new line naming a failure appeared in 45 s; ${story}`, a)

  // Availability returns to the running host.
  const back = await startCore()
  if (!back) return skip('AC-40', 'a later listing recovers when the core can be reached again, without a duplicate launch', 'the core could not be started again with `hc serve`')
  const t1 = Date.now()
  const countAtBack = coreTerminals().length
  let recovered
  while (Date.now() - t1 < 60_000 && recovered === undefined) {
    const r = await listCall().catch(() => undefined)
    if (r?.status === 200 && r.json?.adoption?.state === 'settled') recovered = Date.now() - t1
    else await pause(500)
  }
  chk('AC-40', 'a later listing recovers when the core can be reached again, without a duplicate launch', recovered !== undefined && coreTerminals().length === countAtBack, recovered !== undefined ? `the host listed again ${recovered} ms after the core came back; core terminals ${countAtBack} -> ${coreTerminals().length}` : 'the host never listed again within 60 s of the core coming back', a)
})

// ---- the end ---------------------------------------------------------------------------------

await killAll()
writeReport()
await finish(session)
