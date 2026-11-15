const { chromium } = require('playwright')
const fs = require('fs')
const out = __dirname + '/evidence/'
const projectId = process.argv[2]
const BASE = 'http://localhost:3000'
const log = (...a) => console.log(...a)
async function openCabinet(page) {
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
  if (!(await page.locator('[data-artifact-cabinet]').count())) await page.getByRole('button', { name: /^Gallery$/ }).first().click()
  await page.waitForSelector('[data-artifact-cabinet]')
  await page.waitForFunction(() => document.querySelectorAll('[data-cabinet-card]').length >= 1, null, { timeout: 30000 })
  await page.waitForTimeout(1500)
}
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1536, height: 900 } })
  // A38: long tasks on the main thread while the cabinet loads and converts.
  await page.addInitScript(() => {
    window.__long = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true })
  })
  const workers = []
  page.on('worker', (w) => workers.push(w.url().replace(BASE, '')))
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
  const t0 = await page.evaluate(() => performance.now())
  await page.evaluate(() => (window.__long = []))
  await page.getByRole('button', { name: /^Gallery$/ }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-artifact-cabinet] canvas').length >= 2)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-artifact-cabinet] canvas')].every((c) => c.width > 0))
  const t1 = await page.evaluate(() => performance.now())
  await page.waitForTimeout(1000)
  log('A38 cold open→previews ms', Math.round(t1 - t0), 'long tasks after open', JSON.stringify(await page.evaluate(() => window.__long)), 'workers', JSON.stringify(workers))
  // warm: close and reopen
  await page.getByRole('tab', { name: 'Terminal' }).click()
  await page.waitForTimeout(500)
  const w0 = await page.evaluate(() => performance.now())
  await page.getByRole('tab', { name: 'Gallery' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-artifact-cabinet] canvas')].length >= 2 && [...document.querySelectorAll('[data-artifact-cabinet] canvas')].every((c) => c.width > 0))
  log('A38 warm reopen ms', Math.round((await page.evaluate(() => performance.now())) - w0))
  const mem = await page.evaluate(() => performance.memory && Math.round(performance.memory.usedJSHeapSize / 1e6))
  log('A38 JS heap MB', mem)

  // A06: search and filters in the browser.
  const search = page.locator('[data-cabinet-search]')
  const count = () => page.locator('[data-cabinet-card]').count()
  await search.fill('field'); await page.waitForTimeout(1200); const s1 = await count()
  const s1t = await page.locator('[data-cabinet-card]').first().getAttribute('data-cabinet-card')
  await search.fill(''); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Images' }).click({ force: true }); await page.waitForTimeout(1200); const f1 = await count()
  await page.getByRole('button', { name: 'Apps' }).click({ force: true }); await page.waitForTimeout(1200); const f2 = await count()
  const emptyText = await page.locator('[data-artifact-cabinet]').innerText()
  await page.getByRole('button', { name: 'All' }).click({ force: true }); await page.waitForTimeout(1200)
  const order = await page.$$eval('[data-cabinet-card]', (b) => b.map((x) => x.dataset.cabinetCard.slice(-6)))
  log('A06', JSON.stringify({ searchField: s1, first: s1t?.slice(-8), images: f1, apps: f2, appsPressed: true, allOrder: order }))
  await page.screenshot({ path: out + 'a06-apps-empty.png' })

  // A11: the terminal keeps its screen and identity across cabinet visits.
  await page.getByRole('tab', { name: 'Terminal' }).click()
  await page.waitForTimeout(1500)
  const term = () => page.evaluate(() => {
    const host = document.querySelector('[data-terminal-drawer] [data-hidden], [data-terminal-drawer] .absolute.inset-0')
    return (document.querySelector('[data-terminal-drawer][data-swipe-direction="right"]')?.innerText ?? '').slice(0, 300)
  })
  const termBefore = await term()
  const sessionsBefore = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /threads$|sessions|\/runs/.test(r.name) && r.initiatorType === 'fetch').length)
  await page.getByRole('tab', { name: 'Gallery' }).click(); await page.waitForTimeout(1200)
  await page.getByRole('tab', { name: 'Terminal' }).click(); await page.waitForTimeout(800)
  const termAfter = await term()
  log('A11', JSON.stringify({ sameScreen: termBefore === termAfter, sample: termBefore.slice(0, 120) }))

  // A27: the original image in the dialog is the source bytes, unwashed.
  await page.getByRole('tab', { name: 'Gallery' }).click(); await page.waitForTimeout(1200)
  await page.locator('[data-cabinet-card*="8fb305"]').click()
  await page.locator('[data-cabinet-original] img').waitFor()
  const px = await page.evaluate(async () => {
    const img = document.querySelector('[data-cabinet-original] img')
    await img.decode()
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight); const x = c.getContext('2d'); x.drawImage(img, 0, 0)
    const d = x.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data
    let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0
    return { w: img.naturalWidth, h: img.naturalHeight, hash: h, filter: getComputedStyle(img).filter, mix: getComputedStyle(img).mixBlendMode, opacity: getComputedStyle(img).opacity }
  })
  log('A27 dialog image', JSON.stringify(px))
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  // A24: switch preset (and dark mode), whole terminal re-themes.
  const shot = async (name) => page.locator('[data-terminal-drawer][data-swipe-direction="right"]').screenshot({ path: out + name })
  await shot('a24-calm.png')
  const roles = () => page.evaluate(() => { const s = getComputedStyle(document.querySelector('[data-terminal-drawer][data-swipe-direction="right"]')); return ['--color-term', '--color-term-ink', '--color-term-sage', '--color-term-muted'].map((k) => s.getPropertyValue(k).trim()) })
  const r0 = await roles()
  await page.evaluate(() => { localStorage.setItem('theorem-ui:appearance', JSON.stringify({ state: { preset: 'expressive', overrides: {} }, version: 1 })) })
  await page.reload({ waitUntil: 'networkidle' }); await openCabinet(page)
  await shot('a24-expressive.png')
  const r1 = await roles()
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(800)
  await shot('a24-expressive-dark.png')
  const r2 = await roles()
  log('A24 roles calm/expressive/dark', JSON.stringify([r0, r1, r2]))
  await page.evaluate(() => localStorage.removeItem('theorem-ui:appearance'))

  await browser.close()
})()
