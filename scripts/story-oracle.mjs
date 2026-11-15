#!/usr/bin/env node
// SOURCING: playwright-core drives the story URLs, pixelmatch and pngjs make the perceptual diff, sharp reads the references and lays out the collage. This is the one driver ui-graph-plans asks for; it never navigates the app or picks selectors of its own.
//
//   node scripts/story-oracle.mjs list
//   node scripts/story-oracle.mjs shot <id|all>
//   node scripts/story-oracle.mjs diff <id|all>      reference, render and heatmap in one collage
//   node scripts/story-oracle.mjs collage <id|all>   the same collage from a render already in renders/,
//                                                    such as one captured in another browser at the story's viewport
//   node scripts/story-oracle.mjs motion <id>        animation names, and two frames 400ms apart
//   node scripts/story-oracle.mjs matrix [ids]    the critical journeys in Chromium, Firefox, WebKit, Chromium at 200% zoom and 390 wide
//   node scripts/story-oracle.mjs interact <id>      real key presses on a fresh story, read back from the page text
//                                                    (and a screenshot after a wait), for the stories with a scenario
//   node scripts/story-oracle.mjs palette capture <surface|all> [profile]
//   node scripts/story-oracle.mjs palette evaluate | sheets | face
//                                                    the workbench palette matrix (see story-oracle-palette.mjs)
//
// STORY_ORIGIN picks the dev server. A collage's number is reported, never a verdict: a person seals it.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { chromium, firefox, webkit } from 'playwright-core'
import { PNG } from 'pngjs'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = join(ROOT, 'docs/plans/evidence')
const ORIGIN = process.env.STORY_ORIGIN ?? 'http://localhost:3102'
/** ORACLE_BROWSER runs a story in another engine (chromium, firefox or webkit). */
const ENGINE = { chromium, firefox, webkit }[process.env.ORACLE_BROWSER ?? 'chromium']
if (!ENGINE) throw new Error(`ORACLE_BROWSER is ${process.env.ORACLE_BROWSER}; use chromium, firefox or webkit`)
/**
 * ORACLE_VIEWPORT=WIDTHxHEIGHT replaces the story's viewport (a narrow or short window), and ORACLE_SCALE its
 * device scale: a page zoomed to 200% is half the CSS viewport at scale 2.
 */
const VIEWPORT = /^(\d+)x(\d+)$/.exec(process.env.ORACLE_VIEWPORT ?? '')
const SCALE = Number(process.env.ORACLE_SCALE) || undefined
/** The engine's own version string, read once the browser is launched; `interact` prints it for `matrix`. */
let engineVersion = ''
/** Pixelmatch's per-pixel threshold, the declared tolerance. */
const THRESHOLD = 0.2

/** The dev server's own floating buttons are not part of any component. */
const DEV_OVERLAYS = 'body > div:not(:has([data-story])):not([data-story]) { display: none !important; }'

const list = async () => {
  const response = await fetch(`${ORIGIN}/stories.json`)
  if (!response.ok) throw new Error(`${ORIGIN}/stories.json answered ${response.status}`)
  return response.json()
}

async function withPage(story, run, { reducedMotion = 'reduce', deviceScaleFactor = 1 } = {}) {
  // Firefox is the stock one installed here, over WebDriver BiDi, as scripts/e2e/lib.mjs launches it.
  const browser = await ENGINE.launch(ENGINE === firefox ? { channel: 'moz-firefox' } : {})
  engineVersion = browser.version()
  try {
    const context = await browser.newContext({
      // Desktop width either way, so responsive classes read as they do in the shell.
      viewport: VIEWPORT
        ? { width: Number(VIEWPORT[1]), height: Number(VIEWPORT[2]) }
        : { width: Math.max(story.viewport.width, 1280), height: story.viewport.height },
      colorScheme: 'dark',
      reducedMotion,
      deviceScaleFactor: SCALE ?? deviceScaleFactor,
    })
    const page = await context.newPage()
    const failures = []
    page.on('pageerror', (error) => failures.push(String(error).slice(0, 400)))
    if (process.env.PAGELOG) page.on('console', (m) => m.type() === 'error' && console.error('PAGE', m.text().slice(0, 300)))
    await page.goto(`${ORIGIN}/story/${story.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-story-ready]', { state: 'attached', timeout: 90_000 })
    await page.addStyleTag({ content: DEV_OVERLAYS })
    // A scripted workbench story is ready when it has left `data-story-pending`; a blank frame (the
    // dev server still re-optimising, a wasm that never drew) is an error, never evidence.
    await page
      .waitForFunction(
        () => {
          const box = document.querySelector('[data-workbench-story]')
          if (!box) return true
          return !box.hasAttribute('data-story-pending') && (box.innerText ?? '').trim().length > 0
        },
        null,
        { timeout: 60_000 },
      )
      .catch(() => {
        throw new Error(`${story.id}: still pending or blank after 60s; not shooting it`)
      })
    // Query data has landed; lazy viewers and media decode on their own time.
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('video, audio')].every((m) => m.readyState >= 2) &&
          ![...document.querySelectorAll('[data-story] *')].some(
            (el) => !el.children.length && el.textContent === 'Loading…',
          ),
        null,
        { timeout: 20_000 },
      )
      .catch(() => console.error(`${story.id}: media or viewers still loading`))
    await page.waitForTimeout(600)
    const result = await run(page)
    if (failures.length) console.error(`${story.id}: page errors\n${failures.join('\n')}`)
    return result
  } finally {
    await browser.close()
  }
}

/** ORACLE_RENDER_DIR sends a run's renders elsewhere (the matrix keeps its own, so committed renders stay as they are). */
const renderPath = (id) => join(process.env.ORACLE_RENDER_DIR ?? join(EVIDENCE, 'renders'), `${id}.png`)

async function shot(story) {
  mkdirSync(join(EVIDENCE, 'renders'), { recursive: true })
  const clip = { x: 0, y: 0, ...story.viewport }
  await withPage(story, (page) => page.screenshot({ path: renderPath(story.id), clip }))
  console.log(`${story.id}: ${renderPath(story.id)}`)
}

const label = (text, width) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24"><rect width="100%" height="100%" fill="#101010"/><text x="8" y="16" font-family="sans-serif" font-size="12" fill="#e6e6e6">${text}</text></svg>`,
  )

async function collage(story) {
  if (!existsSync(renderPath(story.id))) throw new Error(`${story.id}: no render at ${renderPath(story.id)}`)
  const { width, height } = story.viewport
  let reference = sharp(join(EVIDENCE, 'refs', story.reference))
  if (story.region) {
    const [left, top, w, h] = story.region
    reference = reference.extract({ left, top, width: w, height: h })
  }
  const flat = { fit: 'contain', background: '#000000' }
  const asPng = (input) =>
    sharp(input).resize(width, height, flat).ensureAlpha().png().toBuffer()
  const referenceBytes = await asPng(await reference.png().toBuffer())
  const renderBytes = await asPng(renderPath(story.id))
  const a = PNG.sync.read(referenceBytes)
  const b = PNG.sync.read(renderBytes)
  const heat = new PNG({ width, height })
  const threshold = story.tolerance?.threshold ?? THRESHOLD
  const mismatched = pixelmatch(a.data, b.data, heat.data, width, height, { threshold })
  const ratio = mismatched / (width * height)

  const gap = 12
  const image = sharp({
    create: {
      width: width * 3 + gap * 2,
      height: height + 24 + (story.tolerance ? 24 : 0),
      channels: 4,
      background: '#101010',
    },
  }).composite([
    { input: label(`LEFT, REFERENCE: ${story.reference}`, width), left: 0, top: 0 },
    { input: label(`MIDDLE, RENDER: /story/${story.id}`, width), left: width + gap, top: 0 },
    { input: label(`RIGHT, DIFF HEATMAP at ${threshold}: ${(ratio * 100).toFixed(1)}% differs`, width), left: (width + gap) * 2, top: 0 },
    { input: referenceBytes, left: 0, top: 24 },
    { input: renderBytes, left: width + gap, top: 24 },
    { input: PNG.sync.write(heat), left: (width + gap) * 2, top: 24 },
    ...(story.tolerance
      ? [{ input: label(`Tolerance: ${story.tolerance.note}`, width * 3 + gap * 2), left: 0, top: height + 24 }]
      : []),
  ])
  const out = story.evidenceDir
    ? join(EVIDENCE, story.evidenceDir, 'collage.png')
    : join(EVIDENCE, 'collages', `${story.id}.png`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await image.png().toBuffer())
  console.log(`${story.id}: ${(ratio * 100).toFixed(1)}% differs at ${threshold}, ${out}`)
}

async function diff(story) {
  await shot(story)
  await collage(story)
}

async function motion(story) {
  const seen = await withPage(
    story,
    async (page) => {
      const names = await page.evaluate(() =>
        document.getAnimations().map((animation) => animation.animationName ?? animation.id ?? animation.constructor.name),
      )
      const first = await page.screenshot()
      await page.waitForTimeout(400)
      const second = await page.screenshot()
      const a = PNG.sync.read(first)
      const b = PNG.sync.read(second)
      const moved = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.05 })
      return { names, moved }
    },
    { reducedMotion: 'no-preference' },
  )
  console.log(JSON.stringify({ id: story.id, ...seen }))
}

/** The text the story box shows, one string, as the semantic tree would give it. */
// WebKit's innerText gives a space inside a run of cell text as U+00A0; the other engines give U+0020. One space either way.
const pageText = (page) => page.evaluate(() => (document.querySelector('[data-workbench-story]')?.innerText ?? '').replace(/\u00a0/g, ' '))

/** The chord that opens the picker (Alt with Cmd on a Mac, Ctrl elsewhere) and one that names a tool. */
const CHORD = 'Meta+Alt+'
/** The picker's route to a tool in More tools: its chord, the name typed into the filter, Enter. */
const openTool = async (page, name) => {
  await page.keyboard.press(`${CHORD}t`)
  await page.waitForTimeout(400)
  for (const text of ['More tools', name]) {
    await page.keyboard.type(text)
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
  }
}
const has = async (page, needle) => (await pageText(page)).includes(needle)
// Text a pane wraps over several rows: the rows of one column of panes, joined, hold the needle.
const wrappedIncludes = (text, needle) => {
  const rows = text.split('\n').map((line) => line.split('\u2502').map((cell) => cell.trim()))
  const columns = Math.max(...rows.map((cells) => cells.length))
  for (let i = 0; i < columns; i++) {
    const joined = rows.map((cells) => cells[i] ?? '').join(' ').replace(/\s+/g, ' ')
    if (joined.includes(needle)) return true
  }
  return false
}
const hasWrapped = async (page, needle) => wrappedIncludes(await pageText(page), needle)
/** Waits until the page text names `needle`; false after `ms`. */
const sees = async (page, needle, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await has(page, needle)) return true
    await page.waitForTimeout(100)
  }
  return false
}

/** A clip of the first 1280x640 of the page, the size every workbench story is shown at. */
const snap = (page, name, width = 1280, height = 640) => page.screenshot({ path: renderPath(name), clip: { x: 0, y: 0, width, height } })

/**
 * Marks where a scenario starts reading the effect kinds the core asks the host for. The story keeps every
 * kind in order in `window.__workbenchEffects`; its `data-last-effect` alone loses one of two in a tick.
 */
const recordEffects = (page) =>
  page.evaluate(() => {
    window.__effectsFrom = (window.__workbenchEffects ?? []).length
  })
const effectsSince = (page, from = 0) => page.evaluate((n) => (window.__workbenchEffects ?? []).slice((window.__effectsFrom ?? 0) + n), from)

/**
 * The workbench's groups as the tab row draws them: each group's tabs in order, the active tab of each
 * (the tab with the strongest fill in its group) and the focused panel (the one tab with the accent fill).
 * Read from the cell styles of the grid's first row; a group that is not on that row is not seen.
 */
const layoutOf = (page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[id$=_ratzilla_grid]')
    const cells = [...grid.children[0].children].map((c) => ({ ch: c.textContent || ' ', bg: c.style.backgroundColor }))
    const text = cells.map((c) => c.ch).join('')
    const strength = (bg) => {
      const rgb = (bg.match(/\d+/g) ?? []).slice(0, 3).map(Number)
      return Math.max(...rgb) - Math.min(...rgb)
    }
    const groups = []
    let from = 0
    for (const part of text.split('\u2502')) {
      const tabs = []
      const re = /([^\s\u00d7][^\u00d7]*?) \u00d7/g
      let m
      while ((m = re.exec(part))) tabs.push({ name: m[1].trim(), strength: strength(cells[from + m.index].bg) })
      from += part.length + 1
      if (tabs.length) groups.push(tabs)
    }
    const focus = groups.flat().filter((t) => t.strength >= 25)
    const dividers = [...text].flatMap((c, i) => (c === '\u2502' ? [i] : []))
    return {
      dividers,
      groups: groups.map((tabs) => ({ tabs: tabs.map((t) => t.name), active: tabs.reduce((a, b) => (b.strength > a.strength ? b : a)).name })),
      focused: focus.length === 1 ? focus[0].name : focus.map((t) => t.name).join('+') || null,
    }
  })
const describeLayout = (l) => `${l.groups.map((g) => `[${g.tabs.map((t) => (t === g.active ? `${t}*` : t)).join(' ')}]`).join(' ')} focus ${l.focused}`

/** Opens the Shell tool's chooser by its chord and reads the words it shows. */
const openShellChooser = async (page) => {
  await page.waitForTimeout(500)
  await page.keyboard.press(`${CHORD}s`)
  return sees(page, 'Nothing starts until you choose a row', 6000)
}

/**
 * The accessible overlay, read the way assistive technology reads it: the browser's accessibility tree
 * (`ariaSnapshot`, `getByRole`), never the grid's cells. Keyboard-only; the one pointer move is the click that
 * proves the overlay lets the pointer through.
 */
const OVERLAY = '/story/workbench-semantic-overlay'
const overlayBox = (page) => page.locator('[data-workbench-story]')
/** Loads the overlay story with a query into `page` and waits as `withPage` does, then puts focus in the input. */
const loadOverlay = async (page, query = '') => {
  // A dev server busy re-optimising can miss the first load; one more try, then the error stands.
  for (let attempt = 0; ; attempt++) {
    await page.goto(`${ORIGIN}${OVERLAY}${query}`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForSelector('[data-story-ready]', { state: 'attached', timeout: 90_000 })
      break
    } catch (error) {
      if (attempt > 0) throw error
    }
  }
  await page.addStyleTag({ content: DEV_OVERLAYS })
  await page.waitForFunction(() => { const b = document.querySelector('[data-workbench-story]'); return b && !b.hasAttribute('data-story-pending') && (b.innerText ?? '').trim().length > 0 }, null, { timeout: 60_000 })
  await page.waitForTimeout(800)
  await page.locator('textarea').first().focus()
}
/** The element the input names as its active descendant: role, name and the text a reader would speak. */
const activeDescendant = async (page) => {
  // The surface can be between two mounts for a frame on a slow machine; the input is waited for, not assumed.
  await page.waitForSelector('[data-workbench-story] textarea', { timeout: 20_000 })
  return page.evaluate(() => {
    const field = document.querySelector('[data-workbench-story] textarea')
    const el = document.getElementById(field.getAttribute('aria-activedescendant') ?? '')
    return {
      held: document.activeElement === field,
      role: el?.getAttribute('role') ?? null,
      name: el?.getAttribute('aria-label') ?? el?.textContent ?? null,
      node: el?.dataset.node ?? null,
    }
  })
}
/** The words aria-describedby gives an element, by the node id it carries. */
const describedBy = (page, node) =>
  page.evaluate((node) => {
    const el = document.querySelector(`[data-node="${node}"]`)
    return [...(el?.getAttribute('aria-describedby') ?? '').split(' ')].map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
  }, node)
const attr = (page, node, name) => page.evaluate(([node, name]) => document.querySelector(`[data-node="${node}"]`)?.getAttribute(name) ?? null, [node, name])
const treeText = (page) => overlayBox(page).ariaSnapshot()
/** How many accessibility-tree elements carry a name, for the once-in-the-snapshot check. */
const countByRole = (page, role, name) => overlayBox(page).getByRole(role, { name, exact: true }).count()

/** Real key presses per story; each scenario returns named checks, true when the page text agrees. */
const SCENARIOS = {
  'workbench-default': [
    // A fresh workbench rests its picker and focuses the composer: a sentence typed lands in the composer.
    async (page) => {
      const sentence = 'hello there'
      await page.keyboard.type(sentence, { delay: 30 })
      await page.waitForTimeout(500)
      const text = await pageText(page)
      const lines = text.split('\n')
      const composer = lines.find((l) => l.includes('\u276f') && l.includes(sentence)) ?? ''
      const filter = lines.find((l) => l.trim().startsWith('>') && l.includes(sentence))
      return {
        'composer shows the sentence': composer.includes(sentence),
        'picker filter stays empty': !filter && !text.includes('No tools match'),
      }
    },
  ],
  // Search (the story already ran the query): Down into the rows, Enter opens the file in the editor.
  'workbench-search': [
    async (page) => {
      const listed = (await sees(page, 'grid.rs')) && (await has(page, 'guide.md'))
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(600)
      const tabs = (await pageText(page)).split(String.fromCharCode(10)).some((l) => /(grid|guide)\.(rs|md) \u00d7/.test(l))
      return { 'rows from two files': listed, 'Enter opens the file in a tab': tabs }
    },
  ],
  // Run (the story already listed the runs): Down to the finished run, Enter attaches it.
  'workbench-run-list': [
    async (page) => {
      const listed = (await sees(page, 'tests')) && (await has(page, 'build'))
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      return { 'the host list is shown': listed, 'attaching reads the run': await sees(page, 'FAILED') }
    },
  ],
  // The host's run list with exit codes and kinds, at the default (narrow, 46-cell) tools pane and at a wide one.
  // Typing is kept on this device while the host cannot confirm it; after a real reload the file is reopened by keyboard and the owner offers the kept edits back.
  'workbench-recovery-reload': [
    async (page) => {
      const snapNow = (name) => snap(page, `workbench-recovery-reload-${name}`)
      const openNotes = async () => {
        await page.keyboard.press(`${CHORD}e`)
        await page.waitForTimeout(400)
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await sees(page, 'architecture.md', 4000)
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
      }
      await page.waitForTimeout(500)
      await openNotes()
      await sees(page, 'notes.txt', 6000)
      await page.waitForTimeout(500)
      await page.keyboard.type('zzdraft', { delay: 30 })
      const typed = await sees(page, 'zzdraft')
      await page.waitForTimeout(1500)
      // The editor column: the text after the last column rule of every row, wrapped lines joined.
      const editor = async () => (await pageText(page)).split('\n').map((l) => l.split('\u2502').pop().trim()).join(' ')
      const drafts = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('theorem-workbench:draft:')).length)
      const keptBefore = await sees(page, 'kept, unsaved', 6000)
      const heldWords = (await editor()).includes('Unknown whether the owner took an edit')
      await snapNow('typed')
      const storedBefore = await drafts()
      await page.reload()
      await page.waitForFunction(() => { const el = document.querySelector('[data-workbench-story]'); return el && !el.hasAttribute('data-story-pending') }, null, { timeout: 30000 })
      await page.waitForTimeout(800)
      await page.locator('textarea').first().focus()
      const gone = !(await has(page, 'zzdraft'))
      const survived = (await drafts()) === 1
      await openNotes()
      await sees(page, 'notes.txt', 6000)
      await sees(page, 'Keep recovered', 6000)
      await page.waitForTimeout(800)
      await snapNow('offer')
      const offer = await editor()
      const chord = /Keep recovered Alt\+(\w)/.exec(offer)?.[1]
      const bar = offer.includes('Edits recovered from this device are in the text. Nothing is sent until you choose.')
      const reason = offer.includes('Kept on this device before a reload, against revision 1; the document is at revision 1')
      const status = offer.includes('kept, unsaved') && offer.includes('recov')
      const untouched = (await drafts()) === 1
      const firstLine = (await pageText(page)).split('\n').map((l) => l.split('\u2502').pop().trim()).find((l) => /^1 /.test(l)) ?? ''
      if (chord) await page.keyboard.press(`Alt+${chord}`)
      await page.waitForTimeout(1500)
      await snapNow('placed')
      const after = await editor()
      return {
        typed,
        'the held edit is reported as unknown, never as saved': heldWords,
        'status says the typing is kept on this device and unsaved': keptBefore,
        'a device draft record exists before the reload': storedBefore === 1,
        'the reload dropped the typing from the page': gone,
        'the device draft survived the reload': survived,
        'the offer says the edits are in the text and nothing is sent': bar,
        'the offer says where they were kept and against which revision': reason,
        'the offer names its chord and the status says recovered and kept': Boolean(chord) && status,
        'nothing was sent or dropped by merely offering': untouched,
        'the first typed edit is in the text before the choice': /^1 z/.test(firstLine),
        'everything typed is in the text before the choice': /^1 zzdraft/.test(firstLine),
        'the chord says the edits are sent as new edits': after.includes('Kept the recovered edits. They are sent as new edits on the current text.'),
        'once the host takes them the status no longer says kept': !after.includes('kept, unsaved') && (await drafts()) === 0,
        'the placed text is still in the document': /^1 z/.test((await pageText(page)).split('\n').map((l) => l.split('\u2502').pop().trim()).find((l) => /^1 /.test(l)) ?? ''),
      }
    },
  ],
  // A program's own status report in a terminal pane (AC-42, R32): drawn in a band of its own, and nothing else about the pane changes.
  'workbench-terminal-program-report': [
    async (page) => {
      const press = (n) => page.evaluate((x) => document.querySelector(`[data-story-control="${x}"]`)?.click(), n)
      const snapNow = (name) => snap(page, `workbench-terminal-program-report-${name}`)
      // The terminal pane's column of the grid, one string per row (the story's controls are not part of it).
      const pane = () => page.evaluate(() => [...document.querySelector('[id$=_ratzilla_grid]').querySelectorAll('pre')].map((r) => (r.textContent ?? '').split('\u2502').pop().trimEnd()))
      const node = (id) => page.evaluate((i) => window.__semanticTree().nodes.find((n) => n.id.endsWith(`/${i}`)) ?? null, id)
      // The pane's own parts: its tab and header rows and the state line the tree gives, and the footer from the notice down.
      const parts = async () => {
        const rows = await pane()
        const from = rows.findIndex((r) => r.startsWith('Adopted a terminal'))
        return { header: rows.slice(0, 3).join('\n'), footer: from < 0 ? null : rows.slice(from).join('\n'), state: (await node('status'))?.name }
      }
      // The band: the rows from "Program" to the footer, joined.
      const band = async () => {
        const rows = await pane()
        const from = rows.findIndex((r) => /^Program/.test(r))
        const to = rows.findIndex((r) => r.startsWith('Adopted a terminal') || r.startsWith('The program has ended'))
        return from < 0 ? '' : rows.slice(from, to < 0 ? undefined : to).join(' ')
      }
      const checks = {}
      await page.waitForTimeout(800)
      const base = await parts()
      checks['the pane is running before any report'] = /controlling/.test(base.header) && !/exited/.test(base.header)
      checks['unavailable draws nothing and has no node'] = (await band()) === '' && (await node('program-report')) === null
      await snapNow('unavailable')
      await recordEffects(page)
      const unchanged = { header: true, footer: true, state: true }
      const running = {}
      const asked = {}
      const step = async (name, control, words, shot = name) => {
        await press(control)
        await page.waitForTimeout(500)
        const now = await parts()
        unchanged.header &&= now.header === base.header
        unchanged.footer &&= now.footer === base.footer
        unchanged.state &&= now.state === base.state
        running[name] = /controlling/.test(now.header) && !/exited|has ended/.test((await pane()).join('\n'))
        asked[name] = (await effectsSince(page)).length
        await snapNow(shot)
        const said = await band()
        if (words) checks[`${name}: the band says ${words}`] = said.includes(words)
        return said
      }
      await step('never reported', 'report-never', 'Program has not reported a status', 'never')
      await step('working', 'report-working', 'Program reports: working \u00b7 build \u00b7 cc \u00b7 the-title \u00b7 compiling \u00b7 progress 40')
      await step('unknown', 'report-unknown', 'Program reports: its own word "pondering"')
      await step('cleared', 'report-cleared', 'Program withdrew its report')
      const hostile = await step('hostile', 'report-hostile', 'Program reports: blocked')
      const text = await pageText(page)
      checks['hostile: the escape and the right-to-left override are spelled out'] = hostile.includes('\\u{1b}') && hostile.includes('\\u{202e}')
      checks['hostile: no raw control or bidi character reaches the page'] = !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(text)
      checks['hostile: shell.end and approval.allow are only words in the band'] = hostile.includes('shell.end') && hostile.includes('approval.allow') && running.hostile && asked.hostile === 0
      const stale = await step('stale sequence', 'report-stale', undefined, 'stale')
      checks['an older sequence does not replace the newer report'] = stale === hostile && !stale.includes('stale')
      await step('done', 'report-done', 'Program reports: done \u00b7 finished')
      await step('error', 'report-error', 'Program reports: error \u00b7 broke')
      checks['the header and the tab are the same after every report'] = unchanged.header
      checks['the footer is the same after every report'] = unchanged.footer
      checks['the pane state line is the same after every report'] = unchanged.state
      checks['the pane still says running after a done report'] = running.done
      checks['the pane still says running after an error report'] = running.error
      checks['no report asked the host for anything'] = Object.values(asked).every((n) => n === 0) && (await effectsSince(page)).length === 0
      const reportNode = await node('program-report')
      checks['the tree has the program-report node as a status with no actions'] = reportNode?.role === 'status' && reportNode.actions.length === 0 && /reported by the program itself \(not workbench state\)/.test(reportNode.name)
      await press('exit')
      await page.waitForTimeout(600)
      const ended = await band()
      checks["after exit the wording is Program's last report:"] = ended.startsWith("Program's last report: error \u00b7 broke")
      const last = await node('program-report')
      checks['after exit the tree still has the node, named as the last report, with no actions'] = /^Last status reported by the program itself/.test(last?.name ?? '') && last.actions.length === 0
      checks['after exit the pane says the program ended with the host reason'] = (await pane()).join('\n').includes('exited with code 0') && (await pane()).join('\n').includes('Host reason: exited')
      await snapNow('exit')
      return checks
    },
  ],
  'workbench-run-list-exits': [
    async (page) => {
      // The run rows of the tools pane: the text after the last column rule.
      const rows = async () => (await pageText(page)).split('\n').map((l) => l.split('\u2502').pop().trimEnd()).filter((l) => /^exited/.test(l))
      const find = (list, name) => list.find((l) => l.includes(name)) ?? ''
      const listed = await sees(page, 'exited with code 2', 6000)
      const narrow = await rows()
      await snap(page, 'workbench-run-list-exits-narrow')
      // Widen the tools group by dragging its splitter left with the mouse.
      await page.mouse.move(931, 300)
      await page.mouse.down()
      await page.mouse.move(800, 300, { steps: 6 })
      await page.mouse.move(600, 300, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(800)
      const wide = await rows()
      await snap(page, 'workbench-run-list-exits-wide')
      const kinds = (list) => ({
        unit: /unit tests \(all crates\) {2}test( |$)/.test(find(list, 'unit tests')),
        integration: /integration tests \(db\) {2}test( |$)/.test(find(list, 'integration tests')),
        build: /release build \(lto\) {2}build( |$)/.test(find(list, 'release build')),
      })
      const states = (list) =>
        find(list, 'unit tests').startsWith('exited with code 0  ') &&
        find(list, 'integration tests').startsWith('exited with code 2  ') &&
        find(list, 'release build').startsWith('exited (no code given)  ')
      const whole = (list) => ['unit tests (all crates)', 'integration tests (db)', 'release build (lto)'].every((n) => list.join('\n').includes(n))
      const wideKinds = kinds(wide)
      const narrowKinds = kinds(narrow)
      return {
        'the runs are listed': listed,
        'narrow: exited with code 0, exited with code 2 and exited (no code given) are said in full': narrow.length === 3 && states(narrow),
        'narrow: the names are whole': whole(narrow),
        'narrow: the kind label is dropped on every row before a name is cut': !narrowKinds.unit && !narrowKinds.integration && !narrowKinds.build,
        'wide: the same three states': wide.length === 3 && states(wide),
        'wide: the kind label (test, test, build) follows each name': wideKinds.unit && wideKinds.integration && wideKinds.build,
        'wide: the names are whole': whole(wide),
      }
    },
  ],
  // Type in Visual, switch to Source with Alt+2 and see it, undo.
  'workbench-markdown-visual': [
    async (page) => {
      const word = 'zzword'
      await page.keyboard.type(word)
      const typed = await sees(page, word)
      await page.keyboard.press('Alt+2')
      await page.waitForTimeout(500)
      const source = (await sees(page, '[source')) && (await has(page, word))
      await page.keyboard.press('Meta+z')
      await page.waitForTimeout(400)
      return { typed, 'visible in Source': source, undone: !(await has(page, word)) }
    },
  ],
  // The accessible overlay over the grid, read through the accessibility tree with the keyboard alone.
  'workbench-semantic-overlay': [
    // The tab strip and where focus is: names, the selected tab, the grid hidden, each element once, focus following the chord.
    async (page) => {
      const tree = await treeText(page)
      const start = await activeDescendant(page)
      await page.keyboard.press(`${CHORD}e`)
      await page.waitForTimeout(600)
      const files = await activeDescendant(page)
      await page.keyboard.press(`${CHORD}g`)
      await page.waitForTimeout(600)
      const changes = await activeDescendant(page)
      const ids = await page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-workbench-story] [id]')].map((e) => e.id)
        return { all: all.length, unique: new Set(all).size }
      })
      return {
        'the tab strip is a tablist of named tabs': /tablist "Main tabs"/.test(tree) && /tab "Theo" \[selected\]/.test(tree) && /tab "Files" \[selected\]/.test(tree),
        'the grid host stays aria-hidden': await page.evaluate(() => !!document.querySelector('[id$=_ratzilla_grid]')?.closest('[aria-hidden="true"]')),
        'the input names itself and holds focus': start.held && (await attr(page, 'body:p3', 'role')) === 'tabpanel' && (await page.locator('textarea').first().getAttribute('aria-label')) === 'Workbench input',
        'the composer is where focus starts': start.role === 'textbox' && start.name === 'Message to Theo',
        'focus moves to Files with its chord, input still focused': files.held && files.node === 'body:p3' && files.role === 'tabpanel' && files.name === 'Files',
        'focus moves to Changes with its chord': changes.held && changes.role === 'group' && /Cargo\.toml/.test(changes.name ?? ''),
        'the Files tab and the Changes tab each appear once': (await countByRole(page, 'tab', 'Files')) === 1 && (await countByRole(page, 'tab', 'Changes')) === 1 && (await countByRole(page, 'textbox', 'Workbench input')) === 1,
        'no element id is repeated': ids.all === ids.unique,
      }
    },
    // The picker: options with position and set size, the typed filter, Escape back to where focus was.
    async (page) => {
      const list = overlayBox(page).getByRole('listbox', { name: 'Tools' })
      await page.keyboard.press(`${CHORD}e`)
      await overlayBox(page).getByRole('tree', { name: 'Files' }).waitFor({ timeout: 20_000 })
      await page.waitForTimeout(400)
      const before = await activeDescendant(page)
      await page.keyboard.press(`${CHORD}t`)
      await list.waitFor({ timeout: 20_000 })
      await page.waitForTimeout(400)
      const opened = await activeDescendant(page)
      const options = list.getByRole('option')
      const total = await options.count()
      const first = await options.first().evaluate((e) => [e.getAttribute('aria-posinset'), e.getAttribute('aria-setsize')])
      const last = await options.last().evaluate((e) => [e.getAttribute('aria-posinset'), e.getAttribute('aria-setsize')])
      const filterBoxes = await countByRole(page, 'textbox', 'Filter tools')
      await page.keyboard.type('Sh')
      await page.waitForFunction(() => document.querySelectorAll('[role=listbox][aria-label="Tools"] [role=option]').length === 1, null, { timeout: 10_000 }).catch(() => {})
      const filtered = await list.getByRole('option').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
      const typed = await describedBy(page, 'p2/filter')
      await page.keyboard.press('Escape')
      await list.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
      await page.waitForTimeout(400)
      const closed = await activeDescendant(page)
      return {
        'the picker opens with its first row active': opened.held && opened.role === 'option' && opened.name === 'Changes',
        'the rows are options with position and size': total > 1 && first[0] === '1' && first[1] === String(total) && last[0] === String(total) && last[1] === String(total),
        'the filter is a labelled text box': filterBoxes === 1,
        'the typed filter text is exposed': typed === 'Sh',
        'the options narrow to the match': filtered.length === 1 && /Shell/.test(filtered[0]),
        'Escape closes the picker': (await list.count()) === 0,
        'focus returns to where it was': closed.held && closed.node === before.node,
      }
    },
    // The Files tree: levels, and an expanded state that changes.
    async (page) => {
      await page.keyboard.press(`${CHORD}e`)
      await page.waitForTimeout(500)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(400)
      const row = '[data-node="p3/f:.github"]'
      const folded = await page.evaluate((row) => document.querySelector(row)?.getAttribute('aria-expanded'), row)
      const levelsBefore = await overlayBox(page).getByRole('treeitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-level')))
      await page.keyboard.press('Enter')
      await page.waitForTimeout(700)
      const opened = await page.evaluate((row) => document.querySelector(row)?.getAttribute('aria-expanded'), row)
      const tree = await treeText(page)
      const nested = await overlayBox(page).getByRole('treeitem', { name: 'workflows', exact: true }).evaluate((e) => e.getAttribute('aria-level')).catch(() => null)
      return {
        'the rows are tree items at level 1': levelsBefore.length > 3 && levelsBefore.every((l) => l === '1'),
        'a folder starts collapsed': folded === 'false',
        'Enter expands it and the tree says so': opened === 'true' && /treeitem "\.github" \[expanded\]/.test(tree),
        'its children are one level deeper': nested === '2',
      }
    },
    // Changes: the list, a disabled commit with its reason, and a diff control once a file is opened.
    async (page) => {
      await page.keyboard.press(`${CHORD}g`)
      // Changes reads the repository before it lists anything: wait for the list, not for a fixed time.
      await overlayBox(page).getByRole('tree', { name: 'Changes list' }).waitFor({ timeout: 20_000 })
      await page.waitForTimeout(500)
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('ArrowDown')
        await page.waitForTimeout(200)
      }
      await page.keyboard.press('Enter')
      await overlayBox(page).getByRole('document', { name: 'Diff of src/main.rs' }).waitFor({ timeout: 10_000 }).catch(() => {})
      const tree = await treeText(page)
      const commit = overlayBox(page).getByRole('button', { name: /^Commit to/ })
      return {
        'the changes list is a tree of groups': /tree "Changes list"/.test(tree) && /treeitem "Staged \(2\)" \[expanded\]/.test(tree),
        'a file opens a diff the tree names': /document "Diff of src\/main\.rs"/.test(tree),
        'the commit button is disabled': (await commit.getAttribute('aria-disabled')) === 'true',
        'the commit message is a text box': (await countByRole(page, 'textbox', 'Commit message')) === 1,
      }
    },
    // The composer, on the core's own tree (the caret is described) and with a caret added (the text is mirrored).
    async (page) => {
      await page.keyboard.type('hello there')
      await page.waitForTimeout(500)
      const described = await describedBy(page, 'p1/composer:text')
      const shown = await page.evaluate(() => document.querySelector('[data-node="p1/composer:text"]')?.textContent)
      await loadOverlay(page, '?selection=end')
      await page.keyboard.type('hello there')
      await page.waitForTimeout(600)
      const field = await page.locator('textarea').first().evaluate((e) => ({ value: e.value, start: e.selectionStart, end: e.selectionEnd, name: e.getAttribute('aria-label'), active: e.getAttribute('aria-activedescendant') }))
      const tree = await treeText(page)
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(500)
      const afterDelete = await page.locator('textarea').first().inputValue()
      return {
        'typed text is on the composer node': shown === 'hello there',
        'its caret is described in words': /caret at character 11 on line 1/.test(described),
        'with a caret published the input holds the text': field.value === 'hello there' && field.start === 11 && field.end === 11,
        'and wears the composer name': field.name === 'Message to Theo' && field.active === null,
        'the tree shows the text once, in the input': /textbox "Message to Theo": hello there/.test(tree) && (await countByRole(page, 'textbox', 'Message to Theo')) === 1,
        'a delete lands in the input and the core': afterDelete === 'hello ther',
      }
    },
    // The terminal: its status line names the controller; the control button says why it is off.
    async (page) => {
      await page.keyboard.press(`${CHORD}s`)
      await page.waitForTimeout(700)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2500)
      const tree = await treeText(page)
      const request = overlayBox(page).getByRole('button', { name: 'Request control' })
      return {
        'the status names the session and who controls it': /status: sh-1 \| native \| controlling/.test(tree),
        'the terminal is a text box': (await countByRole(page, 'textbox', 'Terminal sh-1')) === 1,
        'Request control is disabled': (await request.getAttribute('aria-disabled')) === 'true',
        'and gives its reason': /already controls the terminal/.test(await describedBy(page, 'p4/request-control')),
        'a notice from the host is an alert': /alert: Adopted a terminal/.test(tree),
      }
    },
    // A notice is announced once: the status region's words are written once per notice, never again on later changes.
    async (page) => {
      await loadOverlay(page, '?device=copy')
      await page.evaluate(() => {
        window.__noticeWrites = []
        const read = () => document.querySelector('[data-node="notice"]')?.textContent ?? ''
        window.__noticeWrites.push(read())
        new MutationObserver(() => {
          const now = read()
          if (now !== window.__noticeWrites.at(-1)) window.__noticeWrites.push(now)
        }).observe(document.querySelector('[data-workbench-story]'), { subtree: true, childList: true, characterData: true })
      })
      await page.keyboard.press(`${CHORD}g`)
      await page.waitForTimeout(500)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(500)
      const quiet = await page.evaluate(() => window.__noticeWrites.filter(Boolean))
      await page.evaluate(() => document.querySelector('[data-story-control="save-mine"]')?.click())
      await page.waitForTimeout(1000)
      const writes = await page.evaluate(() => window.__noticeWrites.filter(Boolean))
      const region = await page.evaluate(() => { const e = document.querySelector('[data-node="notice"]'); return [e?.getAttribute('role'), e?.getAttribute('aria-live')] })
      return {
        'the notice is a polite status region': region[0] === 'status' && region[1] === 'polite',
        'the standing notice is written once, through moves and keys': quiet.length === 1 && /this device/.test(quiet[0]),
        'a refused save is announced once, as its own text': writes.length === 2 && /not saved/.test(writes[1]),
        'the notice appears once in the tree': (await overlayBox(page).getByRole('status').filter({ hasText: 'not saved' }).count()) === 1,
      }
    },
    // The overlay changes no pixel and lets the pointer through to the grid.
    async (page) => {
      // The same moves on the story with and without the overlay; the frames are compared byte for byte.
      const frame = async (query) => {
        await loadOverlay(page, query)
        await page.keyboard.press(`${CHORD}g`)
        // Changes has drawn its branch line: the frame is settled, on a slow machine too.
        await sees(page, 'Branch: main', 20_000)
        await page.waitForTimeout(1200)
        return page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 640 } })
      }
      const withOverlay = await frame('')
      const covering = await page.locator('[data-workbench-story] [data-node]').count()
      // A real mouse press at the middle of the "Add tool" tab's overlay element, after Changes took the front.
      const tab = overlayBox(page).getByRole('tab', { name: 'Add tool' })
      const box = await tab.boundingBox()
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const hit = await page.evaluate(({ x, y }) => {
        const top = document.elementFromPoint(x, y)
        return { overlay: !!top?.closest('[data-node]'), grid: !!top?.closest('[id$=_ratzilla_grid]') }
      }, point)
      const selectedBefore = await tab.getAttribute('aria-selected')
      await page.mouse.click(point.x, point.y)
      await page.waitForTimeout(700)
      const selectedAfter = await tab.getAttribute('aria-selected')
      const without = await frame('?overlay=off')
      return {
        'the overlay has elements covering the grid': covering > 20,
        'the frame is byte for byte the same with and without the overlay': withOverlay.equals(without),
        'the pointer reaches the grid, not an overlay element': hit.grid && !hit.overlay,
        'a real click on the grid switches the tab': selectedBefore === 'false' && selectedAfter === 'true',
      }
    },
  ],
  // Move to a file, open its diff, stage it, see it under Staged.
  'workbench-changes': [
    async (page) => {
      await page.keyboard.press('Escape')
      // The list: Staged first, then Unstaged; step down to the first unstaged file.
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
      const before = await pageText(page)
      await page.keyboard.press('s')
      await page.waitForTimeout(600)
      const after = await pageText(page)
      const stagedAt = (text) => (text.match(/Staged (\d+)/) ?? [])[1]
      return { 'staged count grew': Number(stagedAt(after)) === Number(stagedAt(before)) + 1 }
    },
  ],
  // Shell on a fresh terminal story: type echo hi, Enter, see the echo.
  'workbench-terminal': [
    async (page) => {
      await page.keyboard.type('echo hi')
      await page.keyboard.press('Enter')
      return { 'the shell echoes the line': await sees(page, 'echo hi') }
    },
  ],
  // The Shell chooser, by keyboard, against each state the host's terminal list can be in.
  'workbench-terminal-adoption-pending': [
    async (page) => {
      const opened = await openShellChooser(page)
      const text = await pageText(page)
      await snap(page, 'workbench-terminal-adoption-pending', 1600)
      return {
        'the chooser opens': opened,
        'says the host is still looking and the list may be incomplete': text.includes('The host is still looking for running terminals. This list may be incomplete.'),
        'the heading says none are listed yet': text.includes('No sessions listed yet'),
        'it does not claim there are no sessions': !text.includes('No existing sessions to attach to'),
        'it does not say the host cannot list': !text.includes('cannot list its terminals'),
      }
    },
  ],
  'workbench-terminal-adoption-unavailable': [
    async (page) => {
      const opened = await openShellChooser(page)
      const text = await pageText(page)
      await snap(page, 'workbench-terminal-adoption-unavailable', 1600)
      return {
        'the chooser opens': opened,
        'says the host cannot list its terminals, then the reason': text.includes('The host cannot list its terminals: the Herdr socket is not answering'),
        'the heading says none are listed yet': text.includes('No sessions listed yet'),
        'it does not claim there are no sessions': !text.includes('No existing sessions to attach to'),
        'it does not say the list is merely incomplete': !text.includes('This list may be incomplete'),
      }
    },
  ],
  'workbench-terminal-adoption-settled': [
    async (page) => {
      const opened = await openShellChooser(page)
      const text = await pageText(page)
      await snap(page, 'workbench-terminal-adoption-settled', 1600)
      return {
        'the chooser opens': opened,
        'the heading says there are no existing sessions': text.includes('No existing sessions to attach to'),
        'no incomplete-list note': !text.includes('This list may be incomplete') && !text.includes('cannot list its terminals'),
        'it does not say none are listed yet': !text.includes('No sessions listed yet'),
      }
    },
  ],
  // A conflicted binary file: open it by keyboard, read the words, take a side.
  'workbench-changes-binary-conflict': [
    async (page) => {
      await page.waitForTimeout(500)
      await recordEffects(page)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      const listed = await has(page, 'logo.png')
      await page.keyboard.press('Enter')
      const opened = await sees(page, 'Conflict: assets/logo.png', 6000)
      const text = await pageText(page)
      await snap(page, 'workbench-changes-binary-conflict-open')
      const lines = text.split('\n').map((l) => l.split('\u2502').pop().trim())
      const asked = await effectsSince(page)
      const mark = asked.length
      // `e` (merge by hand) has nothing to open for a binary file.
      await page.keyboard.press('e')
      await page.waitForTimeout(400)
      const afterE = await pageText(page)
      await page.keyboard.press('o')
      const confirming = await sees(page, 'Take ours for assets/logo.png?', 4000)
      const warned = await hasWrapped(page, 'The file becomes our side whole.')
      const lossFull = await hasWrapped(page, "The other side's version of this binary file is lost.")
      await snap(page, 'workbench-changes-binary-conflict-confirm')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(800)
      const sent = await effectsSince(page, mark)
      const after = await pageText(page)
      await snap(page, 'workbench-changes-binary-conflict-taken')
      return {
        'the conflicted file is listed': listed,
        'Enter opens its sides': opened,
        'the core asked the host for the conflict': asked.includes('scmConflict'),
        'says the file is binary and its sides cannot be shown as text': wrappedIncludes(text, 'This file is binary. Its sides cannot be shown as text.'),
        'the hint is o take ours   t take theirs, with no merge by hand': text.includes('o take ours   t take theirs') && !text.includes('merge by hand'),
        'both sides are labelled not shown as text': lines.filter((l) => l === 'Binary: not shown as text.').length === 2,
        'no side text is drawn (no numbered lines, no empty-file or no-file line)': !lines.some((l) => /^\d+ /.test(l)) && !text.includes('The file is empty.') && !text.includes('This side has no file.'),
        'the absent base is not shown': !text.includes('Base (the common ancestor)'),
        'e does nothing for a binary file': afterE.includes('This file is binary.') && !afterE.includes('merge by hand'),
        'o asks first: Take ours, whole side': confirming && warned,
        'the loss warning is shown in full, not cut off at the pane edge': lossFull,
        'confirming sends scmResolve to the host': sent.includes('scmResolve'),
        'the file leaves Conflicted': !after.includes('Conflicted 1') && !after.includes('! logo.png'),
      }
    },
  ],
  // Arrow to a finding, Enter opens the file at its line.
  'workbench-diagnostics': [
    async (page) => {
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      return { 'the editor opens at the finding': await sees(page, 'Ln 7, Col 1') }
    },
  ],

  // Open the Artifacts panel from the picker by keyboard, move the selection, open an artifact, Escape closes it
  // and the keys land where they were before (the composer).
  'workbench-cabinet-picker': [
    async (page) => {
      await openTool(page, 'Artifacts')
      const opened = await sees(page, 'Gallery')
      await page.screenshot({ path: renderPath('workbench-cabinet-open'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      const first = await pageText(page)
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(400)
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(400)
      const moved = (await pageText(page)) !== first
      await page.screenshot({ path: renderPath('workbench-cabinet-moved'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      // The dev server's overlay rule hides portals, and a hidden dialog cannot take focus: lift it first.
      await page.evaluate(() => document.querySelectorAll('style').forEach((el) => el.textContent?.includes(':not([data-story])') && el.remove()))
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)
      const before = await focused()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1000)
      const dialog = () => page.evaluate(() => document.querySelector('[role=dialog]:not([data-state=closed])')?.innerText?.slice(0, 80) ?? null)
      const shown = await dialog()
      await page.screenshot({ path: renderPath('workbench-cabinet-artifact'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await page.keyboard.press('Escape')
      // The dialog leaves with its exit and the focus follows on the next frame: wait for both.
      let closed = false
      let back = ''
      for (let i = 0; i < 30 && !(closed && back === before); i++) {
        await page.waitForTimeout(100)
        closed = (await dialog()) === null
        back = await focused()
      }
      await page.screenshot({ path: renderPath('workbench-cabinet-closed'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      return {
        'the cabinet opens from the picker': opened,
        'the arrows move the selection': moved,
        'Enter opens the artifact in a dialog': shown !== null,
        'Escape closes it': closed,
        'focus returns to the card it came from': before === back && back !== 'BODY',
      }
    },
  ],
  // A draft in the open document, then another account is signed in.
  'workbench-account-switch': [
    async (page) => {
      const control = (name) => page.evaluate((n) => document.querySelector(`[data-story-control="${n}"]`)?.click(), name)
      await page.waitForTimeout(500)
      await page.keyboard.type('zzdraft', { delay: 30 })
      const typed = await sees(page, 'zzdraft')
      await page.waitForTimeout(1500)
      await page.screenshot({ path: renderPath('workbench-account-switch-draft'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await control('switch-grace')
      await page.waitForTimeout(1500)
      const gone = !(await has(page, 'zzdraft'))
      await page.screenshot({ path: renderPath('workbench-account-switch-grace'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await control('switch-ada')
      await page.waitForTimeout(1500)
      // The switch closed the document with the rest of the old account's panels, so on return
      // the layout is the default one: the file is reopened from Files by the keyboard.
      const closed = !(await has(page, 'notes.txt \u00d7'))
      await page.keyboard.press(`${CHORD}e`)
      await page.waitForTimeout(400)
      // The same Files steps the story's own script opens the note with.
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await sees(page, 'architecture.md', 4000)
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      const offered = await sees(page, 'recovered', 6000)
      await page.screenshot({ path: renderPath('workbench-account-switch-ada'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      const notSent = !((await pageText(page)).split('\n').some((l) => /^\d+ zzdraft/.test(l)))
      return { typed, 'old draft gone after the switch': gone, 'the document is not left open across accounts': closed, 'restored edit offered when the file is reopened': offered, 'not applied on its own': notSent }
    },
  ],
  // The account's layout failed to load; the device copy is labelled and a save is refused with the reason.
  'workbench-device-copy': [
    async (page) => {
      const labelled = await sees(page, 'this device', 6000)
      await page.screenshot({ path: renderPath('workbench-device-copy-label'), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await page.evaluate(() => document.querySelector('[data-story-control="save-mine"]')?.click())
      return { 'the device copy is labelled': labelled, 'the save was refused with the reason': await sees(page, 'not saved', 6000) }
    },
  ],
  // A saved layout carries the theme it was saved in; applying it by key restores that theme, a preset does not touch it.
  'workbench-appearance': [
    async (page) => {
      const control = (name) => page.evaluate((n) => document.querySelector(`[data-story-control="${n}"]`)?.click(), name)
      const theme = () => page.evaluate(() => { const d = document.querySelector('[data-workbench-story]')?.dataset ?? {}; return `${d.appearancePreset}/${d.appearancePalette}` })
      const shot = (n) => page.screenshot({ path: renderPath(`workbench-appearance-${n}`), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await page.waitForTimeout(800)
      const start = await theme()
      await control('save-mine')
      await page.waitForTimeout(800)
      await control('theme-other')
      await page.waitForTimeout(600)
      const other = await theme()
      // The Layouts page by key; the filter narrows it to Mine, whose row carries the theme mark.
      await page.keyboard.press(`${CHORD}l`)
      await page.waitForTimeout(500)
      await page.keyboard.type('Mine', { delay: 30 })
      await page.waitForTimeout(500)
      const marked = (await pageText(page)).split('\n').some((l) => l.includes('Mine') && l.includes('theme'))
      await shot('layouts')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1000)
      const restored = await theme()
      await shot('applied')
      // A preset leaves the theme as the person has it now.
      await control('theme-other')
      await page.waitForTimeout(600)
      await page.keyboard.press(`${CHORD}F2`)
      await page.waitForTimeout(800)
      const afterPreset = await theme()
      return {
        'the story starts in one theme and the switch changes it': start !== other,
        'the Mine row shows the theme mark': marked,
        'applying Mine from the Layouts page restores the saved theme': restored === start,
        'a preset apply does not change the theme': afterPreset === other,
      }
    },
  ],
  // Presets by key, a saved name kept across a reload.
  'workbench-arrangements': [
    async (page) => {
      const control = (name) => page.evaluate((n) => document.querySelector(`[data-story-control="${n}"]`)?.click(), name)
      const names = async () => page.evaluate(() => JSON.parse(document.querySelector('[data-workbench-story]')?.dataset.arrangements ?? '[]'))
      const shot = (n) => page.screenshot({ path: renderPath(`workbench-arrangements-${n}`), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await page.waitForTimeout(800)
      const start = await pageText(page)
      await page.keyboard.press('Meta+Alt+F2')
      await page.waitForTimeout(800)
      const editor = await pageText(page)
      await shot('editor')
      await page.keyboard.press('Meta+Alt+F3')
      await page.waitForTimeout(800)
      const agent = await pageText(page)
      await shot('agent')
      await control('save-mine')
      await page.waitForTimeout(800)
      const listed = JSON.stringify(await names())
      await shot('saved')
      await page.reload()
      await page.waitForTimeout(2500)
      const after = JSON.stringify(await names())
      return {
        'editor differs from the start': editor !== start,
        'agent differs from editor': agent !== editor,
        'Mine is listed once saved': listed.includes('Mine'),
        'Mine is still listed after a reload': after.includes('Mine'),
      }
    },
  ],
  // The face rests on the Theo panel's status row; it stays on its cells after the dock is resized and after
  // the panel moves to another group (the status row text is the reference for where it should be).
  'workbench-face': [
    async (page) => {
      const where = () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-face-perch="terminal"]')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        })
      const shot = (n) => page.screenshot({ path: renderPath(`workbench-face-${n}`), clip: { x: 0, y: 0, width: 1280, height: 640 } })
      await sees(page, 'edit_file')
      await page.waitForTimeout(800)
      const start = await where()
      await shot('start')
      // Widen the Files group: the Theo group's left edge, and the face with it, move right.
      await page.keyboard.press('Meta+Alt+ArrowLeft')
      await page.waitForTimeout(400)
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Meta+Alt+]')
        await page.waitForTimeout(300)
      }
      await page.waitForTimeout(900)
      const resized = await where()
      await shot('resized')
      // Back to the Theo group, then the panel moves into the tools group on its right.
      await page.keyboard.press('Meta+Alt+ArrowRight')
      await page.waitForTimeout(400)
      await page.keyboard.press('Meta+Alt+Shift+ArrowRight')
      await page.waitForTimeout(1200)
      const moved = await where()
      await shot('moved')
      const row = (p) => p !== null && p.y > 500
      console.error('face', JSON.stringify({ start, resized, moved }))
      return {
        'the face is on the page': start !== null,
        'it rests on the Theo status row': row(start) && start.x < 300,
        'after a dock resize it moved with the panel and kept its row': row(resized) && resized.x > start.x,
        'after the panel moved it is on the status row of its new group': row(moved),
      }
    },
  ],
  // The picker's Layouts page, by keyboard only: arrange, save as Mine, apply a preset, apply Mine again, rename, delete.
  'workbench-layouts-page': [
    async (page) => {
      const say = async (keys) => {
        for (const k of keys) {
          await page.keyboard.press(k)
          await page.waitForTimeout(350)
        }
        await page.waitForTimeout(500)
      }
      const typed = async (text) => {
        await page.keyboard.type(text, { delay: 40 })
        await page.waitForTimeout(400)
      }
      const notice = async () => (await pageText(page)).split('\n').flatMap((l) => (l.match(/Layout: [^\u2502]*?(?=\s{2,}|$)/) ?? []).map((m) => m.trim())).join(' / ')
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      await page.waitForTimeout(800)
      const start = describeLayout(await layoutOf(page))
      // Arrange: Changes (opens in the tools group, focused), moved left into the Theo group; Shell opens in the
      // tools group; then back to Changes.
      await say([`${CHORD}g`, `${CHORD}Shift+ArrowLeft`, `${CHORD}s`, `${CHORD}ArrowLeft`])
      // Widen the Files group (to its left) and come back to Changes, so the group sizes are not the defaults.
      const defaults = (await layoutOf(page)).dividers
      await say([`${CHORD}ArrowLeft`, `${CHORD}]`, `${CHORD}]`, `${CHORD}]`, `${CHORD}ArrowRight`])
      const arranged = await layoutOf(page)
      await snap(page, 'workbench-layouts-page-arranged')
      // Save it as Mine: Mod+Alt+B opens the name entry, then the name and Enter.
      await say([`${CHORD}b`])
      const asking = await sees(page, 'Save layout as:', 3000)
      await typed('Mine')
      await say(['Enter'])
      const saved = await layoutOf(page)
      const savedNotice = await notice()
      await snap(page, 'workbench-layouts-page-saved')
      // The Editor preset.
      await say([`${CHORD}F2`])
      const editor = await layoutOf(page)
      const editorNotice = await notice()
      await snap(page, 'workbench-layouts-page-editor')
      // The Layouts page by its chord, Mine chosen by typing its name and Enter.
      await say([`${CHORD}w`])
      const page1 = await pageText(page)
      const onPage = page1.includes('Layouts') && page1.includes('Mine') && page1.includes('Save layout as\u2026')
      await snap(page, 'workbench-layouts-page-list')
      await typed('Mine')
      await say(['Enter'])
      const applied = await layoutOf(page)
      const appliedNotice = await notice()
      await snap(page, 'workbench-layouts-page-applied')
      // Rename: the page, Mine highlighted by its name, Mod+Alt+R, the name continued, Enter.
      await say([`${CHORD}w`])
      await typed('Mine')
      await say([`${CHORD}r`])
      const renaming = await sees(page, 'Rename "Mine" to: Mine', 3000)
      await typed(' two')
      await say(['Enter'])
      await sees(page, '\u25a0 Mine two', 4000)
      const afterRename = await pageText(page)
      const renameNotice = await notice()
      const listedTwo = afterRename.includes('Mine two')
      const noOldName = !/\u25a0 Mine(?! two)/.test(afterRename)
      await snap(page, 'workbench-layouts-page-renamed')
      // Delete: Mine two highlighted by its name, Mod+Alt+D asks, Enter deletes.
      await typed('Mine two')
      await sees(page, '> Mine two', 3000)
      await say([`${CHORD}d`])
      const asked = await sees(page, 'Delete "Mine two"?', 3000)
      const askText = await pageText(page)
      await snap(page, 'workbench-layouts-page-delete-ask')
      await say(['Enter'])
      const deleteNotice = await notice()
      for (let i = 0; i < 'Mine two'.length; i++) await page.keyboard.press('Backspace')
      await page.waitForTimeout(500)
      const afterDelete = await pageText(page)
      await snap(page, 'workbench-layouts-page-deleted')
      return {
        'arranged: Changes beside Theo, Shell in its own group, Changes focused': same(arranged.groups.map((g) => g.tabs.join('|')), ['Files', 'Theo|Changes', 'Add tool|Shell']) && arranged.focused === 'Changes',
        'the group sizes were changed from the defaults before saving': !same(arranged.dividers, defaults),
        'Mod+Alt+B asks for a name': asking,
        'saving Mine says so': savedNotice.includes('Layout: Mine saved'),
        'the Editor preset changes the groups': !same(editor.groups, saved.groups),
        'the Layouts page opens by Mod+Alt+W and lists Mine and Save layout as': onPage,
        'applying Mine says so': appliedNotice.includes('Layout: Mine applied'),
        'restored: the same groups': same(applied.groups.map((g) => g.tabs), saved.groups.map((g) => g.tabs)),
        'restored: the same tabs in each group (order too)': same(applied.groups.map((g) => g.tabs.join('|')), saved.groups.map((g) => g.tabs.join('|'))),
        'restored: the same active tab in each group': same(applied.groups.map((g) => g.active), saved.groups.map((g) => g.active)),
        'restored: the groups are the same width (dividers in the same columns)': same(applied.dividers, saved.dividers),
        'restored: the same focused panel': applied.focused === saved.focused && applied.focused !== null,
        'rename: asks with the old name filled in': renaming,
        'rename: the list shows Mine two and no Mine': listedTwo && noOldName,
        'rename: says so': renameNotice.includes('Layout: Mine renamed Mine two'),
        'delete: asks first': asked && askText.includes('Enter deletes it'),
        'delete: says so': deleteNotice.includes('Layout: Mine two deleted'),
        'delete: the list no longer has it': !afterDelete.includes('Mine two') && afterDelete.includes('Editor-centred') && afterDelete.includes('Save layout as\u2026'),
      }
    },
  ],
  // The agent's two operations through the real page path (useWorkbenchRequests over a stand-in thread and a recording stand-in for the SDK's receipt command), against the real wasm workbench.
  'workbench-agent-operations': [
    async (page) => {
      const ask = (run, operation, args = {}) => page.evaluate(([r, o, a]) => window.__agentOps.ask(r, o, a), [run, operation, args])
      const effects = () => page.evaluate(() => window.__agentOps.effects())
      const settle = () => page.waitForTimeout(700)
      const nodeNamed = (receipt, name) => receipt.result.nodes.find((n) => n.role === 'tab' && n.name === name)
      const snapNow = (name) => snap(page, `workbench-agent-operations-${name}`, 1600, 640)
      await page.waitForTimeout(500)
      // a. read the tree
      const tree = await ask('run_a', 'workbench.read')
      await snapNow('read-tree')
      const tabs = tree.result.nodes.filter((n) => n.role === 'tab')
      // b. read the catalogue
      const catalog = await ask('run_a', 'workbench.read', { part: 'catalog' })
      const listed = catalog.result.actions
      await snapNow('read-catalog')
      // c. act on the Files tab, the id taken from the tree just read
      const files = nodeNamed(tree, 'Files')
      const focusId = files?.actions.find((a) => a.id.startsWith('tab.focus.'))?.id
      const before = await layoutOf(page)
      const focused = await ask('run_a', 'workbench.act', { action: focusId })
      await settle()
      const again = await ask('run_a', 'workbench.read')
      const grid = await layoutOf(page)
      await snapNow('act-focus')
      // d. a human-only action
      const textBefore = await pageText(page)
      const layoutBefore = await layoutOf(page)
      const human = await ask('run_a', 'workbench.act', { action: 'approval.allow' })
      await settle()
      const textAfter = await pageText(page)
      const changedLines = textBefore.split('\n').filter((line, i) => line !== textAfter.split('\n')[i])
      const layoutAfter = await layoutOf(page)
      await snapNow('act-human-only')
      // e. a panel that is not open
      const unknown = await ask('run_a', 'workbench.act', { action: 'files.focus', panel: 'p99' })
      await snapNow('act-unknown-panel')
      // f. another run acts: its effect names it; a key the person presses after carries no actor
      const mark = (await effects()).length
      const other = await ask('run_b', 'workbench.act', { action: 'theo.new' })
      await settle()
      const byAgent = (await effects()).slice(mark)
      const mark2 = (await effects()).length
      await ask('run_b', 'workbench.act', { action: 'tab.focus.p1' })
      await settle()
      await page.locator('textarea').first().focus()
      await page.keyboard.type('hello', { delay: 30 })
      await page.keyboard.press('Enter')
      await settle()
      const byPerson = (await effects()).slice(mark2)
      await snapNow('act-actor')
      // h. an over-long read, cut and followed (the real tree repeated, a stand-in: the fixture's own is under the bound)
      await page.evaluate(() => window.__agentOps.inflate(3))
      const first = await ask('run_a', 'workbench.read')
      const second = await ask('run_a', 'workbench.read', { skip: first.result.next })
      const total = first.result.total
      await snapNow('read-cut')
      let walked = first.result.nodes.length
      let last = first
      const ids = new Set(first.result.nodes.map((n) => n.id))
      let overlap = false
      let guard = 0
      while (last.result.next !== undefined && guard++ < 20) {
        last = await ask('run_a', 'workbench.read', { skip: last.result.next })
        for (const n of last.result.nodes) overlap = overlap || ids.has(n.id) || (ids.add(n.id), false)
        walked += last.result.nodes.length
      }
      await page.evaluate(() => window.__agentOps.inflate(0))
      // g. the workbench off the page
      await page.evaluate(() => window.__agentOps.show(false))
      await page.waitForTimeout(600)
      const declared = await page.evaluate(() => window.__agentOps.declared())
      const off = await ask('run_c', 'workbench.read')
      const offAct = await ask('run_c', 'workbench.act', { action: 'theo.new' })
      await snapNow('unmounted')
      return {
        'a: read answers applied with more than the root': tree.outcome === 'applied' && tree.result.total > 1,
        'a: the tree has tab nodes offering tab.focus and tab.close': tabs.length >= 3 && tabs.every((t) => t.actions.some((a) => a.id.startsWith('tab.focus.')) && t.actions.some((a) => a.id.startsWith('tab.close.'))),
        'b: the catalogue lists every action, human-only ones marked': catalog.outcome === 'applied' && listed.length > 100 && listed.find((a) => a.action === 'approval.allow')?.humanOnly === true && listed.find((a) => a.action === 'theo.new')?.humanOnly === false,
        'c: Files was not focused, then act on its tab.focus is applied and accepted': before.focused !== 'Files' && focused.outcome === 'applied' && focused.result.outcome === 'accepted' && Boolean(focusId),
        'c: the next read shows that tab focused': nodeNamed(again, 'Files')?.state.focused === true && nodeNamed(again, 'Theo')?.state.focused === false,
        'c: the grid shows Files focused': grid.focused === 'Files',
        'd: a human-only action is rejected with its code': human.outcome === 'rejected' && human.reason.startsWith('human_only') && human.result.code === 'human_only',
        'd: nothing on screen changed but the notice': JSON.stringify(layoutBefore) === JSON.stringify(layoutAfter) && changedLines.length === 1 && textAfter.includes('"approval.allow" is for a person'),
        'e: a panel that is not open is rejected unknown_panel': unknown.outcome === 'rejected' && unknown.reason.startsWith('unknown_panel') && unknown.result.code === 'unknown_panel',
        'f: the effect of a second run names that run as the agent': other.outcome === 'applied' && byAgent.some((e) => e.actor?.type === 'agent' && e.actor.runId === 'run_b'),
        'f: no effect of the second run names the first': !byAgent.some((e) => e.actor?.runId === 'run_a'),
        'f: what the person typed afterwards has no actor': byPerson.length > 0 && byPerson.every((e) => e.actor === null),
        'h: an over-long read is cut, says so, and gives next': first.result.truncated === true && typeof first.result.next === 'number' && first.result.nodes.length < total && first.result.hint.includes(`skip: ${first.result.next}`),
        'h: following next returns the rest from the right node, no overlap, all of it': second.result.nodes.length > 0 && !overlap && walked === total,
        'g: the operations are no longer declared once the workbench is off': declared.length === 0,
        'g: a pending request is answered "not on screen"': off.outcome === 'rejected' && /not on screen/.test(off.reason) && offAct.outcome === 'rejected' && /not on screen/.test(offAct.reason),
      }
    },
  ],
  // AC-04, resize without clipping. The window is set to 1440x900, 1024x768 and 390x844 in one page; at each size
  // the grid is measured from the DOM (a real cell's box, the grid's columns and rows, the host's own scroll
  // size) and the dock from the semantic tree. The dock area is the tree's `application` node: the cells the
  // grid has, tab rows and status rows included, because each pane's rect holds its own tab row and status
  // row. What is counted as covering it: the visible dock groups (Files, Main, Tools) and the resize separators
  // between them. A group with a zero rect is not visible: the core collapses it (Files to a drawer, the others
  // behind the one principal group) and keeps its tabs in the tree.
  // Collapse rule, from terminal/crates/workbench-dock/src/solve.rs: when the groups' preferred widths (Files 224px
  // or its pin, at least 160; Main 480; Tools 320; in cells by the measured cell) and 4 rows do not fit, Files
  // collapses to a drawer first; if the rest still does not fit, one group is shown (the focused one) and the
  // others are suppressed as collapsed, their tabs kept; the shown group's strip says "N more".
  'workbench-resize': [
    async (page) => {
      const engine = process.env.ORACLE_BROWSER ?? 'chromium'
      const SIZES = [
        [1440, 900],
        [1024, 768],
        [390, 844],
      ]
      const measure = () =>
        page.evaluate(() => {
          const grid = document.querySelector('[id$=_ratzilla_grid]')
          const host = grid.parentElement
          const first = grid.children[0]
          const span = first.children[0]
          const box = (e) => {
            const r = e.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          }
          const tree = window.__resize?.tree()
          const nodes = tree?.nodes ?? []
          const rect = (n) => ({ x: n.rect.x, y: n.rect.y, width: n.rect.width, height: n.rect.height })
          return {
            fontSize: getComputedStyle(grid).fontSize,
            spanFontSize: getComputedStyle(span).fontSize,
            cellWidth: box(span).width,
            // The pitch of the rows (what the grid advances by) and the first cell's own box height.
            rowPitch: box(grid.children[1] ?? first).y - box(first).y || box(first).height,
            cellBoxHeight: box(span).height,
            cols: first.children.length,
            rows: grid.children.length,
            host: { width: box(host).width, height: box(host).height, clientWidth: host.clientWidth, clientHeight: host.clientHeight, scrollWidth: host.scrollWidth, scrollHeight: host.scrollHeight },
            scaleVar: getComputedStyle(document.documentElement).getPropertyValue('--appearance-scale-code').trim(),
            dock: nodes.filter((n) => n.role === 'application').map(rect)[0],
            groups: nodes.filter((n) => n.role === 'group' && ['Files', 'Main', 'Tools'].includes(n.name)).map((n) => ({ name: n.name, ...rect(n) })),
            separators: nodes.filter((n) => n.role === 'separator').map((n) => ({ name: n.name, ...rect(n) })),
            tabs: nodes.filter((n) => n.role === 'tab').map((n) => ({ name: n.name, ...rect(n) })),
          }
        })
      /** Waits until the window, the grid and the tree agree, twice in a row (the surface has redrawn). */
      const settled = async (width, height) => {
        let agreed = 0
        for (let i = 0; i < 60 && agreed < 2; i++) {
          await page.waitForTimeout(150)
          const m = await measure().catch(() => undefined)
          const ok = m?.dock && m.host.clientWidth === width && m.host.clientHeight === height && m.dock.width === m.cols && m.dock.height === m.rows
          agreed = ok ? agreed + 1 : 0
        }
        return measure()
      }
      const visible = (r) => r.width > 0 && r.height > 0
      const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      const area = (r) => r.width * r.height
      const inside = (r, d) => r.x >= d.x && r.y >= d.y && r.x + r.width <= d.x + d.width && r.y + r.height <= d.y + d.height
      const cover = (m) => {
        const shown = [...m.groups, ...m.separators].filter(visible)
        const pairs = shown.flatMap((a, i) => shown.slice(i + 1).map((b) => [a, b]))
        return {
          shown,
          overlapping: pairs.filter(([a, b]) => overlap(a, b)).map(([a, b]) => `${a.name}/${b.name}`),
          sum: shown.reduce((s, r) => s + area(r), 0),
          within: shown.every((r) => inside(r, m.dock)),
        }
      }
      const px = (n) => Number.parseFloat(n)
      const geometry = (m) => ({
        fontSizePx: px(m.fontSize),
        cellWidthPx: m.cellWidth,
        rowPitchPx: m.rowPitch,
        cellBoxHeightPx: m.cellBoxHeight,
        columns: m.cols,
        rows: m.rows,
        host: m.host,
        leftoverWidthPx: m.host.clientWidth - m.cols * m.cellWidth,
        leftoverHeightPx: m.host.clientHeight - m.rows * m.rowPitch,
        dockCells: m.dock,
        paneRects: m.groups.map((g) => ({ ...g, visible: visible(g) })),
        separatorRects: m.separators,
        visiblePanes: m.groups.filter(visible).map((g) => g.name),
        tabs: m.tabs.map((t) => ({ name: t.name, visible: visible(t) })),
      })
      const checks = {}
      const report = {}
      await page.waitForTimeout(500)
      const bySize = {}
      for (const [width, height] of SIZES) {
        const name = `${width}x${height}`
        await page.setViewportSize({ width, height })
        const m = await settled(width, height)
        bySize[name] = m
        const c = cover(m)
        const g = geometry(m)
        report[name] = { ...g, coverage: { shownAreaCells: c.sum, dockAreaCells: area(m.dock), overlapping: c.overlapping } }
        await page.screenshot({ path: renderPath(`workbench-resize-${name}`) })
        checks[`a ${name}: font size, cell width and cell height measured from a real cell`] = g.fontSizePx > 0 && g.cellWidthPx > 0 && g.rowPitchPx > 0
        checks[`b ${name}: columns x cell width fit the host with less than one cell left over`] = g.leftoverWidthPx >= 0 && g.leftoverWidthPx < g.cellWidthPx
        checks[`b ${name}: rows x row height fit the host with less than one row left over`] = g.leftoverHeightPx >= 0 && g.leftoverHeightPx < g.rowPitchPx
        checks[`b ${name}: the host neither overflows nor scrolls (scroll size equals client size)`] = m.host.scrollWidth === m.host.clientWidth && m.host.scrollHeight === m.host.clientHeight
        checks[`b ${name}: the tree's dock area is the grid's columns x rows`] = m.dock.width === m.cols && m.dock.height === m.rows
        checks[`c ${name}: no two visible panes or dividers overlap`] = c.overlapping.length === 0
        checks[`c ${name}: visible panes and dividers add up to the dock area exactly`] = c.sum === area(m.dock)
        checks[`c ${name}: every visible pane and divider lies inside the dock area`] = c.within
      }
      const [wide, mid, narrow] = SIZES.map(([w, h]) => bySize[`${w}x${h}`])
      checks['d: the grid font size is the same at all three viewports'] = new Set(SIZES.map(([w, h]) => bySize[`${w}x${h}`].fontSize)).size === 1
      checks['d: the cell width and row height are the same at all three viewports'] =
        new Set(SIZES.map(([w, h]) => `${bySize[`${w}x${h}`].cellWidth}x${bySize[`${w}x${h}`].rowPitch}`)).size === 1
      // e. the narrow window: fewer panes side by side, said explicitly, nothing dropped.
      const shownWide = wide.groups.filter(visible).length
      const shownMid = mid.groups.filter(visible).length
      const shownNarrow = narrow.groups.filter(visible).length
      report.sideBySide = { '1440x900': shownWide, '1024x768': shownMid, '390x844': shownNarrow }
      checks['e: 390x844 shows fewer panes side by side than 1440x900'] = shownNarrow < shownWide
      checks['e: 1024x768 shows fewer than 1440x900 (Files collapses to a drawer first)'] = shownMid < shownWide && !mid.groups.some((g) => g.name === 'Files' && visible(g))
      await page.setViewportSize({ width: 390, height: 844 })
      await settled(390, 844)
      const top = (await pageText(page)).split('\n')[0] ?? ''
      report.narrowStrip = top
      checks['e: at 390x844 the strip says how many panels are behind the one shown ("N more")'] = /\d+ more|\+\d+/.test(top)
      const namesWide = new Set(wide.tabs.map((t) => t.name))
      const namesNarrow = new Set(narrow.tabs.map((t) => t.name))
      checks['e: every panel open at 1440x900 is still named by a tab in the tree at 390x844'] = [...namesWide].every((n) => namesNarrow.has(n))
      checks['e: the shown group at 390x844 lists its own tabs (the document and the picker)'] = (await has(page, 'notes.txt')) && (await has(page, 'Add tool'))
      // Reachable by keyboard. Files' chord moves focus to Files, which is collapsed to a drawer that nothing opens
      // (no key, control or tree action sends OpenDrawer), so the one group shown falls back to Main (Theo); then
      // Mod+Alt+M maximises the focused group, which shows Files whole.
      await page.keyboard.press(`${CHORD}e`)
      await page.waitForTimeout(700)
      report.filesChordAlone = { filesTreeOnScreen: await has(page, 'README.md'), theoOnScreen: await has(page, 'Enter steers the run') }
      checks['e: Theo is reachable at 390x844 (Files\' chord leaves the Main group shown)'] = report.filesChordAlone.theoOnScreen
      await page.screenshot({ path: renderPath('workbench-resize-390x844-theo') })
      await page.keyboard.press(`${CHORD}m`)
      await page.waitForTimeout(700)
      checks['e: Files is reachable at 390x844 (its chord, then maximise the group)'] = await has(page, 'README.md')
      await page.screenshot({ path: renderPath('workbench-resize-390x844-files') })
      await page.keyboard.press(`${CHORD}m`)
      await page.waitForTimeout(500)
      checks['e: the collapsed Files drawer opens from its chord alone'] = report.filesChordAlone.filesTreeOnScreen
      // f. the person's text size: the Code size scale of Settings > Appearance, through the appearance store.
      await page.setViewportSize({ width: 1440, height: 900 })
      const before = await settled(1440, 900)
      await page.evaluate(() => document.querySelector('[data-story-control="text-larger"]')?.click())
      await page.waitForTimeout(1500)
      const after = await settled(1440, 900)
      const afterCover = cover(after)
      const ag = geometry(after)
      report.textSize = { before: geometry(before), after: ag, scaleVariableAfter: after.scaleVar }
      await page.screenshot({ path: renderPath('workbench-resize-text-larger') })
      checks['f: the larger text size reached the page (--appearance-scale-code is 1.5)'] = after.scaleVar === '1.5'
      checks['f: the grid font size is larger after the increase'] = px(after.fontSize) > px(before.fontSize)
      checks['f: the grid has fewer columns after the increase'] = after.cols < before.cols
      checks['f: the grid has fewer rows after the increase'] = after.rows < before.rows
      checks['f: b holds after the increase (fits the host, no scroll, tree dock equals the grid)'] =
        ag.leftoverWidthPx >= 0 && ag.leftoverWidthPx < ag.cellWidthPx && ag.leftoverHeightPx >= 0 && ag.leftoverHeightPx < ag.rowPitchPx && after.host.scrollWidth === after.host.clientWidth && after.host.scrollHeight === after.host.clientHeight && after.dock.width === after.cols && after.dock.height === after.rows
      checks['f: c holds after the increase (no overlap, exact cover of the dock area)'] = afterCover.overlapping.length === 0 && afterCover.sum === area(after.dock) && afterCover.within
      const file = join(ROOT, 'docs/plans/theo-workbench/evidence/resize-geometry.json')
      mkdirSync(dirname(file), { recursive: true })
      let held = {}
      try {
        held = JSON.parse(readFileSync(file, 'utf8'))
      } catch {}
      held[engine] = { engine, how: 'cell width: the first cell span of the grid (getBoundingClientRect); row pitch: distance between the tops of rows 0 and 1; cell box height: that span\'s own height; dock area: the semantic tree\'s application node, in cells', ...report }
      writeFileSync(file, `${JSON.stringify(held, null, 2)}\n`)
      return checks
    },
  ],
  // Type, undo (Cmd+Z), redo (Cmd+Shift+Z): the text reads back each time.
  'workbench-editor': [
    async (page) => {
      const word = 'zzqq'
      await page.keyboard.type(word)
      await page.waitForTimeout(300)
      const typed = await has(page, word)
      await page.keyboard.press('Meta+z')
      await page.waitForTimeout(300)
      const undone = !(await has(page, word))
      await page.keyboard.press('Meta+Shift+z')
      await page.waitForTimeout(300)
      return { typed, undone, redone: await has(page, word) }
    },
  ],
  // The story's own script has switched to the second branch; Alt+[ goes back to the first, Alt+] forward again.
  'workbench-branches': [
    async (page) => {
      const loaded = (await has(page, 'branch 2 of 2')) && (await has(page, 'On the other branch'))
      await page.keyboard.press('Alt+[')
      await page.waitForTimeout(600)
      const back = (await has(page, 'branch 1 of 2')) && !(await has(page, 'On the other branch'))
      await page.keyboard.press('Alt+]')
      await page.waitForTimeout(600)
      const forward = (await has(page, 'branch 2 of 2')) && (await has(page, 'On the other branch'))
      return { loaded, back, forward }
    },
  ],
}

async function interact(story) {
  const scenarios = SCENARIOS[story.id]
  if (!scenarios) throw new Error(`${story.id}: no interaction scenario`)
  const all = {}
  let index = 0
  for (const scenario of scenarios) {
    index += 1
    // Each scenario starts on a fresh load of the story.
    const checks = await withPage(story, async (page) => {
      await page.locator('textarea').first().focus()
      const result = await scenario(page)
      // The claim is checked against pixels too: a screenshot after the wait.
      mkdirSync(process.env.ORACLE_RENDER_DIR ?? join(EVIDENCE, 'renders'), { recursive: true })
      const view = page.viewportSize() ?? story.viewport
      await page.screenshot({
        path: renderPath(`${story.id}-interact${scenarios.length > 1 ? `-${index}` : ''}`),
        clip: { x: 0, y: 0, width: Math.min(story.viewport.width, view.width), height: Math.min(story.viewport.height, view.height) },
      })
      return result
    })
    Object.assign(all, checks)
  }
  console.log(JSON.stringify({ id: story.id, engine: process.env.ORACLE_BROWSER ?? 'chromium', version: engineVersion, checks: all }))
  if (!Object.values(all).every(Boolean)) process.exitCode = 1
}

/**
 * AC-49, the browser matrix: the critical journeys (the workbench stories whose scenario is a document, input
 * or terminal flow) each run through `interact` in Chromium, Firefox and WebKit, and in Chromium again at 200%
 * zoom (half of 1440x900 at device scale 2) and at a narrow layout (390x844). Each run is a child process, so
 * one failing run cannot stop the rest. No engine gets a flag: `withPage` launches them as `ENGINE.launch({})`
 * (Firefox over the stock `moz-firefox` channel). Left out, and why:
 *   workbench-resize                  sets its own viewports (it is AC-04's)
 *   workbench-run-list, -exits        host run lists, not a document, input or terminal flow
 *   workbench-terminal-adoption-pending, -unavailable   host-state variants of the chooser the settled one walks
 *   workbench-semantic-overlay        the accessibility tree through the browser, its own check
 *   workbench-cabinet-picker, -device-copy, -appearance, -arrangements, -layouts-page, -face, -agent-operations, -branches
 *                                      layout, theme, cabinet, agent and conversation flows
 */
const JOURNEYS = [
  'workbench-default',
  'workbench-editor',
  'workbench-markdown-visual',
  'workbench-recovery-reload',
  'workbench-changes',
  'workbench-changes-binary-conflict',
  'workbench-search',
  'workbench-diagnostics',
  'workbench-account-switch',
  'workbench-terminal',
  'workbench-terminal-adoption-settled',
  'workbench-terminal-program-report',
]
const MATRIX_RUNS = [
  { label: 'chromium', engine: 'chromium' },
  { label: 'firefox', engine: 'firefox' },
  { label: 'webkit', engine: 'webkit' },
  { label: 'chromium 200% zoom', engine: 'chromium', viewport: '720x450', scale: 2 },
  { label: 'chromium 390x844', engine: 'chromium', viewport: '390x844', scale: 1 },
]

const runOne = (story, run) =>
  new Promise((resolve) => {
    const dir = join(EVIDENCE, 'renders/matrix', run.label.replace(/\W+/g, '-'), story)
    mkdirSync(dir, { recursive: true })
    const env = { ...process.env, ORACLE_BROWSER: run.engine, ORACLE_RENDER_DIR: dir }
    delete env.ORACLE_VIEWPORT
    delete env.ORACLE_SCALE
    if (run.viewport) env.ORACLE_VIEWPORT = run.viewport
    if (run.scale) env.ORACLE_SCALE = String(run.scale)
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'interact', story], { env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      const line = out.split('\n').reverse().find((l) => l.startsWith('{"id"'))
      let parsed
      try {
        parsed = line ? JSON.parse(line) : undefined
      } catch {}
      const checks = parsed?.checks ?? {}
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
      const result = {
        story,
        run: run.label,
        engine: run.engine,
        engineVersion: parsed?.version ?? null,
        viewport: run.viewport ?? 'story default',
        scale: run.scale ?? 1,
        exitCode: code,
        checks,
        failed,
        error: parsed ? (err.trim().slice(-600) || null) : (err.trim() || out.trim() || `exit ${code}`).slice(-600),
        renders: failed.length || !parsed ? relative(ROOT, dir) : null,
      }
      // A run that passed keeps no renders; a failing one keeps them as the evidence of its state.
      if (!result.renders) rmSync(dir, { recursive: true, force: true })
      resolve(result)
    })
  })

async function matrix(only) {
  const stories = only ? only.split(',') : JOURNEYS
  const known = new Set(listed.map((s) => s.id))
  for (const id of stories) if (!known.has(id) || !SCENARIOS[id]) throw new Error(`${id}: not a listed story with a scenario`)
  const jobs = stories.flatMap((story) => MATRIX_RUNS.map((run) => ({ story, run })))
  const results = new Array(jobs.length)
  let next = 0
  // One run at a time by default: three at once made typing-after-load checks miss in Firefox and at 390 wide, which pass alone.
  const worker = async () => {
    while (next < jobs.length) {
      const at = next++
      results[at] = await runOne(jobs[at].story, jobs[at].run)
      const r = results[at]
      console.error(`${r.story} / ${r.run}: ${r.error && !Object.keys(r.checks).length ? 'ERROR' : r.failed.length ? `${r.failed.length} failed` : 'pass'}`)
    }
  }
  await Promise.all(Array.from({ length: Number(process.env.MATRIX_JOBS) || 1 }, worker))
  const versions = Object.fromEntries(MATRIX_RUNS.map((run) => [run.label, results.find((r) => r.run === run.label && r.engineVersion)?.engineVersion ?? null]))
  mkdirSync(join(ROOT, 'docs/plans/theo-workbench/evidence'), { recursive: true })
  writeFileSync(
    join(ROOT, 'docs/plans/theo-workbench/evidence/browser-matrix.json'),
    `${JSON.stringify({ origin: ORIGIN, flags: 'none: every engine is launched with ENGINE.launch({}) or, for Firefox, { channel: "moz-firefox" }', versions, journeys: stories, runs: results }, null, 2)}\n`,
  )
  const cell = (r) => (!Object.keys(r.checks).length ? 'ERROR' : `${r.failed.length ? 'FAIL' : 'ok'} ${Object.values(r.checks).filter(Boolean).length}/${Object.keys(r.checks).length}`)
  const width = Math.max(...stories.map((s) => s.length))
  console.log(`${'story'.padEnd(width)}  ${MATRIX_RUNS.map((run) => run.label.padEnd(18)).join(' ')}`)
  for (const story of stories)
    console.log(`${story.padEnd(width)}  ${MATRIX_RUNS.map((run) => cell(results.find((r) => r.story === story && r.run === run.label)).padEnd(18)).join(' ')}`)
  console.log(`versions: ${JSON.stringify(versions)}`)
  for (const r of results.filter((x) => x.failed.length || !Object.keys(x.checks).length))
    console.log(`FAILED ${r.story} / ${r.run}: ${r.failed.length ? r.failed.join(' | ') : r.error} -> ${r.renders}`)
  if (results.some((r) => r.failed.length || !Object.keys(r.checks).length)) process.exitCode = 1
}

const [command = 'list', target] = process.argv.slice(2)
// Every listed story can be shot; only those judged against a committed reference can be diffed or collaged.
const listed = await list()
if (command === 'list') {
  for (const story of listed) console.log(`${story.id}\t${story.lane}\t${story.reference ?? '-'}`)
  process.exit(0)
}
if (command === 'matrix') {
  await matrix(target)
  process.exit(process.exitCode ?? 0)
}
if (command === 'palette') {
  const { paletteCommand } = await import('./story-oracle-palette.mjs')
  await paletteCommand(
    { EVIDENCE, listed, withPage, renderPath },
    process.argv.slice(3),
  )
  process.exit(process.exitCode ?? 0)
}
const needsReference = command === 'diff' || command === 'collage'
const stories = needsReference ? listed.filter((story) => story.reference) : listed
const chosen = target === 'all' ? stories : stories.filter((story) => story.id === target)
if (chosen.length === 0)
  throw new Error(
    `No story named ${target}${needsReference ? ' with a reference' : ''}`,
  )
const run = { shot, diff, collage, motion, interact }[command]
if (!run) throw new Error(`Unknown command ${command}`)
for (const story of chosen) await run(story)
