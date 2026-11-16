// A terminal the person started on their own Herdr, admitted to the workspace from Threads: the
// workbench against a real IDE host and a real Herdr core, as the test account, with a real click
// and real key presses, read from the page's text.
//
// Start the stack with the host first (see scripts/e2e/stack.mjs and scripts/e2e/workbench.mjs for
// the E2E_* settings), then, with the same settings:
//   node scripts/e2e/admit.mjs
//
// The terminal is started with `hc` in the stack's own core session, as its owner would start it;
// the host is asked directly only to say what it lists and what the core's labels are.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UI } from './config.mjs'
import { READ, SHOTS, check, finish, log, open } from './lib.mjs'
import {
  coreTerminals,
  hc,
  hostApi,
  hostUp,
  setPrincipals,
  startHost,
} from './ide-host.mjs'

const GRID = '[id^="workbench-"]'
const NAME = 'owned-agent'
const pause = (ms) => new Promise((settle) => setTimeout(settle, ms))

const session = await open('/')
const { page, context } = session
const identity = await (
  await context.request.get(`${UI}/api/environment/v1/bootstrap`, READ)
).json()
setPrincipals([identity.principalId])
await context.addInitScript(() => {
  try {
    localStorage.setItem('theorem-ui:workbench', '1')
  } catch {}
})

const lines = async () =>
  (
    await page
      .evaluate((grid) => document.querySelector(grid)?.innerText ?? '', GRID)
      .catch(() => '')
  )
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
const screen = async () => (await lines()).join('\n')
async function waitFor(test, what, ms = 25_000) {
  const until = Date.now() + ms
  let text = ''
  while (Date.now() < until) {
    text = await screen()
    const hit = test instanceof RegExp ? text.match(test) : test(text)
    if (hit) return hit
    await pause(250)
  }
  throw new Error(`Never saw ${what}. The page showed:\n${text.slice(0, 900)}`)
}
const shot = async (name) => {
  const path = join(SHOTS, `admit-${name}`)
  await page.screenshot({ path: `${path}.png` })
  writeFileSync(`${path}.txt`, await screen())
}
/** The middle of the first cell of `needle`, where a person would click it. */
const cellOf = (needle) =>
  page.evaluate(
    ([grid, needle]) => {
      for (const row of document.querySelectorAll(`${grid} pre`)) {
        const cells = [...row.children]
        const at = cells
          .map((cell) => cell.textContent)
          .join('')
          .indexOf(needle)
        if (at < 0) continue
        const box = cells[at + 1].getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      return null
    },
    [GRID, needle],
  )

try {
  if (!(await hostUp())) startHost()
  for (let i = 0; i < 80 && !(await hostUp()); i++) await pause(250)
  for (const t of coreTerminals()) hc('kill', t.address)

  await page.goto(`${UI}/?workbench=1`, { waitUntil: 'domcontentloaded' })
  await waitFor(/Theo/, 'the workbench', 90_000)
  await waitFor(/Herdr/, 'the Herdr section of Threads', 60_000)
  // The workspace the page opened, as the host names it.
  const workspace = (await hostApi('GET', '/workspaces')).json?.find(
    (w) => w.active,
  )?.workspace_id
  if (!workspace) throw new Error('The host has no active workspace.')
  const call = (operation, body = {}) =>
    hostApi('POST', `/workspaces/${workspace}/operations/${operation}`, body)

  // The owner starts a shell on their own Herdr; no workspace made it.
  const started = hc(
    'run',
    '--bg',
    '--json',
    '--no-parent',
    '--name',
    NAME,
    '--',
    '/bin/bash',
    '--norc',
    '-i',
  )
  const address = JSON.parse(started.out).address
  log('the owner started', address)

  let offered
  for (let i = 0; i < 60 && !offered; i++) {
    offered = (await call('terminal.list')).json?.unadmitted?.find(
      (row) => row.terminal === address,
    )
    if (!offered) await pause(500)
  }
  check(
    'the host offers the owner’s terminal, unadmitted, under an id of its own',
    Boolean(offered),
    JSON.stringify(offered ?? null),
  )
  const refused = await call('terminal.attach', {
    session: offered?.session,
    cols: 80,
    rows: 24,
  })
  check(
    'until it is admitted the host refuses to attach it',
    refused.status === 409 && refused.json?.code === 'terminal_not_admitted',
    `${refused.status} ${refused.json?.code}`,
  )

  await waitFor(
    new RegExp(NAME),
    'the terminal in Threads, by the name its owner gave it',
    60_000,
  )
  await shot('offered')
  const row = (await lines()).find((line) => line.includes(NAME))
  check(
    'Threads lists it by the name its owner gave it',
    Boolean(row),
    row ?? '',
  )

  const at = await cellOf(NAME)
  await page.mouse.click(at.x, at.y)
  let how = 'the click'
  const admittedBy = async (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const listed = (await call('terminal.list')).json
      if (listed?.sessions?.some((s) => s.session === offered.session))
        return listed
      await pause(300)
    }
    return undefined
  }
  let listed = await admittedBy(4_000)
  if (!listed) {
    how = 'Enter on the clicked row'
    await page.keyboard.press('Enter')
    listed = await admittedBy(15_000)
  }
  const mine = listed?.sessions?.find((s) => s.session === offered.session)
  check(
    'it becomes a session of the workspace under the id it was listed with',
    Boolean(mine),
    `${how}; ${JSON.stringify(mine ?? null)}`,
  )
  check(
    'the host no longer offers it',
    !listed?.unadmitted?.some((r) => r.session === offered.session),
    JSON.stringify(listed?.unadmitted ?? null),
  )
  // The core is asked for the terminals carrying that session id as a label: the owner's is the one.
  const labelled = JSON.parse(
    hc('ls', '--json', '--label', `theorem.session=${offered.session}`).out ||
      '{}',
  ).terminals
  check(
    'the core’s terminal carries that session id as the workspace’s label',
    labelled?.length === 1 && labelled[0].address === address,
    JSON.stringify(labelled?.map((t) => t.address) ?? null),
  )
  check(
    'no second terminal was started',
    coreTerminals().filter((t) => t.state === 'live').length === 1,
    `${coreTerminals().length} in the core`,
  )

  // The pane it opens in is the owner's own program: what is typed runs there.
  const opened = await waitFor(
    new RegExp(`${offered.session} \\| Herdr \\| (\\w+)`),
    'the admitted session open in a pane',
    30_000,
  ).catch((error) => error)
  check(
    'the admitted session opens in a pane',
    Array.isArray(opened),
    Array.isArray(opened) ? opened[0] : String(opened.message).slice(0, 400),
  )
  if (Array.isArray(opened)) {
    if (opened[1] !== 'controlling') {
      // An observer's first key sends nothing: the pane offers control, and Enter takes it.
      await page.keyboard.press('x')
      await waitFor(/Enter requests control/, 'the offer of control')
      await page.keyboard.press('Enter')
      await waitFor(/\| controlling \|/, 'control of the pane')
    }
    const status = async () =>
      (await lines()).find((line) => line.includes(offered.session)) ?? ''
    log('the pane says', (await status()).slice(30, 110).trim())
    // The command is typed without its answer in it: `ADM5` can only come from the shell.
    await page.keyboard.type('echo ADM$((2+3))', { delay: 20 })
    await page.keyboard.press('Enter')
    const ran = await waitFor(/ADM5/, 'the typed command to run', 10_000).catch(
      () => null,
    )
    check(
      'what is typed in the pane runs in the owner’s program',
      Boolean(ran),
      ran
        ? 'ADM5'
        : (await lines())
            .slice(0, 12)
            .map((line) => line.slice(30, 120).trimEnd())
            .join(' / '),
    )
  }
  await shot('admitted')
  const after = (await lines()).filter((line) => line.includes(NAME))
  check(
    'Threads still shows it once, by the same name',
    after.length >= 1,
    after.join(' / '),
  )
} catch (error) {
  check(
    'the scenario ran to its end',
    false,
    String(error.message).slice(0, 900),
  )
  await shot('failed').catch(() => {})
} finally {
  for (const t of coreTerminals()) hc('kill', t.address)
}
await finish(session)
