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

async function withPage(story, run, { reducedMotion = 'reduce' } = {}) {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      // Desktop width either way, so responsive classes read as they do in the shell.
      viewport: { width: Math.max(story.viewport.width, 1280), height: story.viewport.height },
      colorScheme: 'dark',
      reducedMotion,
      deviceScaleFactor: 1,
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
  // Arrow to a finding, Enter opens the file at its line.
  'workbench-diagnostics': [
    async (page) => {
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      return { 'the editor opens at the finding': await sees(page, 'Ln 7, Col 1') }
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
