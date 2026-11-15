// Slice B journey against the real UI + real Theorem server.
// usage: node sliceb.cjs <projectId>
const { chromium } = require('playwright')
const out = __dirname + '/evidence/'
require('fs').mkdirSync(out, { recursive: true })
const projectId = process.argv[2]
const BASE = process.env.BASE ?? 'http://localhost:3000'
const log = (...a) => console.log(...a)

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const net = []
  page.on('response', (r) => {
    const u = r.url()
    if (/\/outputs|\/uploads\/.*content|\/threads\/[^/]+(\?|$)/.test(u))
      net.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`)
  })
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: out + '00-project.png' })

  // A draft in the project composer that must survive the round trip.
  const DRAFT = 'Draft that must survive opening originals'
  const composer = page.locator('[contenteditable="true"], textarea').first()
  await composer.click()
  await page.keyboard.type(DRAFT)

  // Open the cabinet through the UI.
  const toggle = page.getByRole('button', { name: /^Gallery$/ }).first()
  await toggle.click()
  await page.waitForSelector('[data-artifact-cabinet]')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-cabinet-card]').length >= 2,
    null,
    { timeout: 30000 },
  )
  await page.waitForTimeout(2500) // worker conversions
  const layout = await page.evaluate(() => ({
    layout: document.documentElement.dataset.cabinet,
    dock: getComputedStyle(document.documentElement).getPropertyValue('--cabinet-dock'),
    cards: [...document.querySelectorAll('[data-cabinet-card]')].map((b) => ({
      key: b.dataset.cabinetCard,
      revision: b.dataset.revision,
      label: b.getAttribute('aria-label'),
    })),
    canvas: document.querySelector('[data-palette-revision]')?.dataset.paletteRevision,
  }))
  log('cabinet', JSON.stringify(layout, null, 1))
  await page.screenshot({ path: out + '01-docked.png' })

  for (const [i, card] of layout.cards.entries()) {
    await page.locator(`[data-cabinet-card="${card.key}"]`).click()
    const dialog = page.locator('[data-cabinet-original]')
    await dialog.waitFor()
    await page.waitForFunction(
      () => !document.querySelector('[data-cabinet-original]')?.textContent?.includes('Opening…'),
      null,
      { timeout: 15000 },
    )
    await page.waitForTimeout(500)
    log('opened', card.key, (await dialog.locator('p').first().textContent())?.slice(0, 120))
    log('  img', await dialog.locator('img').count(), 'text chars', (await dialog.textContent()).length)
    await page.screenshot({ path: out + `02-original-${i}.png` })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    const focused = await page.evaluate(() => document.activeElement?.dataset?.cabinetCard)
    log('  focus returned to', focused)
  }
  const draft = await composer.textContent().catch(() => null) ?? (await composer.inputValue())
  log('draft intact:', draft?.includes(DRAFT), JSON.stringify(draft))
  log('url', page.url())

  await page.getByRole('button', { name: 'Expand' }).click()
  await page.waitForTimeout(600)
  log('expanded', await page.evaluate(() => document.documentElement.dataset.cabinet))
  await page.screenshot({ path: out + '03-expanded.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  log('after esc', await page.evaluate(() => document.documentElement.dataset.cabinet))

  await page.setViewportSize({ width: 1024, height: 800 })
  await page.waitForTimeout(800)
  log('narrow', await page.evaluate(() => document.documentElement.dataset.cabinet))
  await page.screenshot({ path: out + '04-overlay.png' })

  log('network', net.join('\n'))
  log('console errors', errors.slice(0, 10))
  await browser.close()
})()
