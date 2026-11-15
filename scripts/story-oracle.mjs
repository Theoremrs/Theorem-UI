#!/usr/bin/env node
// SOURCING: playwright-core drives the story URLs, pixelmatch and pngjs make the perceptual diff, sharp reads the references and lays out the collage. This is the one driver ui-graph-plans asks for; it never navigates the app or picks selectors of its own.
//
//   node scripts/story-oracle.mjs list
//   node scripts/story-oracle.mjs shot <id|all>
//   node scripts/story-oracle.mjs diff <id|all>      reference, render and heatmap in one collage
//   node scripts/story-oracle.mjs collage <id|all>   the same collage from a render already in renders/,
//                                                    such as one captured in another browser at the story's viewport
//   node scripts/story-oracle.mjs motion <id>        animation names, and two frames 400ms apart
//   node scripts/story-oracle.mjs interact <id>      real key presses on a fresh story, read back from the page text
//                                                    (and a screenshot after a wait), for the stories with a scenario
//   node scripts/story-oracle.mjs palette capture <surface|all> [profile]
//   node scripts/story-oracle.mjs palette evaluate | sheets | face
//                                                    the workbench palette matrix (see story-oracle-palette.mjs)
//
// STORY_ORIGIN picks the dev server. A collage's number is reported, never a verdict: a person seals it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = join(ROOT, 'docs/plans/evidence')
const ORIGIN = process.env.STORY_ORIGIN ?? 'http://localhost:3102'
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
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      // Desktop width either way, so responsive classes read as they do in the shell.
      viewport: { width: Math.max(story.viewport.width, 1280), height: story.viewport.height },
      colorScheme: 'dark',
      reducedMotion,
      deviceScaleFactor,
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

const renderPath = (id) => join(EVIDENCE, 'renders', `${id}.png`)

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
const pageText = (page) => page.evaluate(() => document.querySelector('[data-workbench-story]')?.innerText ?? '')

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
 * Records every effect kind the core asks the host for (the story box's `data-last-effect`, changed),
 * in order, into `window.__effects`: the last effect alone is overwritten by the refresh that follows.
 */
const recordEffects = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('[data-workbench-story]')
    window.__effects = []
    new MutationObserver(() => window.__effects.push(box.dataset.lastEffect)).observe(box, { attributes: true, attributeFilter: ['data-last-effect'] })
  })
const effectsSince = (page, from = 0) => page.evaluate((n) => window.__effects.slice(n), from)

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
      const warned = await has(page, 'The file becomes our side whole.')
      const lossFull = await has(page, 'The lines only the other side has are lost.')
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
        'says the file is binary and its sides cannot be shown as text': text.includes('This file is binary. Its sides cannot be shown as text.'),
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
      mkdirSync(join(EVIDENCE, 'renders'), { recursive: true })
      await page.screenshot({
        path: renderPath(`${story.id}-interact${scenarios.length > 1 ? `-${index}` : ''}`),
        clip: { x: 0, y: 0, ...story.viewport },
      })
      return result
    })
    Object.assign(all, checks)
  }
  console.log(JSON.stringify({ id: story.id, checks: all }))
  if (!Object.values(all).every(Boolean)) process.exitCode = 1
}

const [command = 'list', target] = process.argv.slice(2)
// Every listed story can be shot; only those judged against a committed reference can be diffed or collaged.
const listed = await list()
if (command === 'list') {
  for (const story of listed) console.log(`${story.id}\t${story.lane}\t${story.reference ?? '-'}`)
  process.exit(0)
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
