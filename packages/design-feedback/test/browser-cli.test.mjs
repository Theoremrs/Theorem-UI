import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureURL, capturePage, launchCaptureBrowser, openCapturePage } from '../capture.mjs'
import { compareCaptures } from '../compare.mjs'
import { probeURL } from '../probe.mjs'

const executablePath = process.env.DESIGN_FEEDBACK_TEST_BROWSER

test('real browser captures localize repairs, compare pixels, preserve finite entrance content, reject stale evidence, and run probes', { skip: !executablePath, timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'design-feedback-browser-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const url = new URL('./fixtures/design.html', import.meta.url).href
  const base = { executablePath, noSandbox: process.env.DESIGN_FEEDBACK_TEST_NO_SANDBOX === '1', width: 480, height: 640, settleMs: 0 }
  const before = await captureURL(url, { ...base, out: join(directory, 'before') })
  const after = await captureURL(`${url}?variant=fixed`, { ...base, out: join(directory, 'after') })
  assert.ok(before.result.summary.fail > after.result.summary.fail, 'repair reduces measured contrast failures')
  assert.ok(after.observation.elements.some((element) => element.text?.value.includes('Finite entrance animations finish')), 'entrance content remains measured after finite animations finish')
  assert.equal(after.capture.readiness.layoutStableDuringScreenshot, true)
  const compared = await compareCaptures(join(directory, 'before'), join(directory, 'after'), { out: join(directory, 'compare') })
  assert.equal(compared.compatibility.compatible, true, JSON.stringify(compared.compatibility.reasons))
  assert.ok(compared.pixels.perceptualChangedPixels > 0)
  assert.ok(compared.geometry.changed > 0)
  assert.ok((await readFile(join(directory, 'compare', 'heatmap.png'))).length > 100)
  const same = await compareCaptures(join(directory, 'after'), join(directory, 'after'), { out: join(directory, 'same') })
  assert.equal(same.pixels.exactChangedPixels, 0)
  const stale = JSON.parse(await readFile(join(directory, 'after', 'observations.json'), 'utf8'))
  stale.capture.id = 'stale'
  await writeFile(join(directory, 'after', 'observations.json'), JSON.stringify(stale))
  const rejected = await compareCaptures(join(directory, 'before'), join(directory, 'after'), { out: join(directory, 'rejected') })
  assert.equal(rejected.compatibility.compatible, false)
  assert.ok(rejected.compatibility.reasons.some((reason) => reason.includes('hash')))
  assert.equal(rejected.images, undefined)
  const replaced = await compareCaptures(join(directory, 'before'), join(directory, 'after'), { out: join(directory, 'compare'), overwrite: true })
  assert.equal(replaced.compatibility.compatible, false)
  await assert.rejects(readFile(join(directory, 'compare', 'heatmap.png')), { code: 'ENOENT' }, 'an incompatible rerun must not leave an old heatmap')
  const probes = await probeURL(`${url}?variant=fixed`, { ...base, out: join(directory, 'probe') })
  assert.deepEqual(probes.runs.map((run) => run.name), ['baseline', 'narrow', 'text-spacing', 'reduced-motion'])
  assert.equal(probes.coverage.complete, false)
  assert.equal(probes.findings.length, 3)
})

test('animations created by finish handlers are settled before comparison evidence is emitted', { skip: !executablePath, timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'design-feedback-followup-animation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { browser, options } = await launchCaptureBrowser({ executablePath, noSandbox: process.env.DESIGN_FEEDBACK_TEST_NO_SANDBOX === '1', width: 480, height: 640, settleMs: 0 })
  try {
    const { page } = await openCapturePage(browser, options)
    await page.setContent(`<!doctype html><style>html,body{background:#fff;color:#111}#intro{animation:enter 60s linear}@keyframes enter{from{opacity:.2}to{opacity:1}}</style><p id="intro">An entrance starts a background animation.</p><script>document.getElementById('intro').addEventListener('animationend',()=>document.body.animate([{backgroundColor:'#fff'},{backgroundColor:'#111'}],{duration:1000,iterations:Infinity}),{once:true})</script>`)
    const captured = await capturePage(page, browser, { ...options, out: directory })
    assert.ok(captured.capture.motionBeforeFreeze.animationsSeen >= 2)
    assert.equal(captured.capture.motionBeforeFreeze.unsettled, 0)
    assert.equal(captured.capture.motionBeforeFreeze.activeAfterScreenshot, 0)
    assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length), 0)
  } finally { await browser.close() }
})
