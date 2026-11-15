// Acceptance evidence against the real UI + real Theorem server.
// usage: node accept.cjs <projectId>
const { chromium } = require('playwright')
const fs = require('fs')
const out = __dirname + '/evidence/'
fs.mkdirSync(out, { recursive: true })
const projectId = process.argv[2]
const BASE = process.env.BASE ?? 'http://localhost:3000'
const log = (...a) => console.log(...a)

async function openCabinet(page) {
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
  if (!(await page.locator('[data-artifact-cabinet]').count())) {
    await page.getByRole('button', { name: /^Gallery$/ }).first().click()
  }
  await page.waitForSelector('[data-artifact-cabinet]')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-cabinet-card]').length >= 2,
    null,
    { timeout: 30000 },
  )
  await page.waitForTimeout(1500)
}

const widths = (page) =>
  page.evaluate(() => {
    const r = (el) => el && Math.round(el.getBoundingClientRect().width)
    return {
      viewport: innerWidth,
      layout: document.documentElement.dataset.cabinet,
      rail: r(document.querySelector('[data-appearance-width-role="rail"]')),
      nav: r(document.querySelector('[data-appearance-width-role="navigation"]')),
      main: r(document.querySelector('[data-appearance-width-role="main"]')),
      dock: getComputedStyle(document.documentElement).getPropertyValue('--cabinet-dock'),
      cardFont: getComputedStyle(document.querySelector('[data-artifact-cabinet]')).fontSize,
      cabinet: r(document.querySelector('[data-artifact-cabinet]')),
      columns: (() => {
        const xs = new Set(
          [...document.querySelectorAll('[data-cabinet-card]')].map((b) =>
            Math.round(b.getBoundingClientRect().x),
          ),
        )
        return xs.size
      })(),
      rootFont: getComputedStyle(document.documentElement).fontSize,
      hScroll: document.documentElement.scrollWidth > innerWidth,
    }
  })

// Preview canvas vs its card's frame: the canvas sits one cell inside.
const alignment = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-artifact-cabinet]')
    const cards = [...host.querySelectorAll('li')]
    return cards.map((li) => {
      const b = li.querySelector('button').getBoundingClientRect()
      const c = li.querySelector('canvas')?.getBoundingClientRect()
      const box = li.querySelector('div').getBoundingClientRect()
      return {
        card: li.querySelector('button').dataset.cabinetCard,
        canvasVsSlot: c && [c.x - box.x, c.y - box.y, c.width - box.width, c.height - box.height].map((v) => +v.toFixed(2)),
        slotInsideCard: box.x >= b.x - 0.5 && box.y >= b.y - 0.5 && box.right <= b.right + 0.5,
      }
    })
  })

;(async () => {
  const browser = await chromium.launch()
  const results = {}

  // A33: width budget at four widths.
  for (const [w, h, name] of [
    [1536, 900, 'w1536'],
    [1280, 800, 'w1280'],
    [390, 844, 'w390'],
    [320, 700, 'w320'],
  ]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    try {
      await openCabinet(page)
      results[name] = await widths(page)
      await page.screenshot({ path: out + `a33-${name}.png` })
    } catch (e) {
      results[name] = { error: String(e).slice(0, 200) }
      await page.screenshot({ path: out + `a33-${name}-error.png` })
    }
    log('A33', name, JSON.stringify(results[name]))
    await page.close()
  }

  // A28: alignment at 1×, after resize, at 1.5×, expanded.
  for (const [scale, name] of [
    [1, 'dpr1'],
    [1.5, 'dpr1.5'],
    [2, 'dpr2'],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1536, height: 900 }, deviceScaleFactor: scale })
    const page = await ctx.newPage()
    await openCabinet(page)
    log('A28', name, JSON.stringify(await alignment(page)))
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.waitForTimeout(800)
    log('A28', name, 'resized', JSON.stringify(await alignment(page)))
    await page.getByRole('button', { name: 'Expand' }).click()
    await page.waitForTimeout(800)
    log('A28', name, 'expanded', JSON.stringify(await alignment(page)))
    await ctx.close()
  }

  const ctx = await browser.newContext({ viewport: { width: 1536, height: 900 }, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const mutations = []
  page.on('request', (r) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) mutations.push(`${r.method()} ${r.url()}`)
  })
  await openCabinet(page)
  const browseMutations = mutations.length

  // A29: keyboard selection, Enter, Escape, touch.
  const focused = () => page.evaluate(() => document.activeElement?.dataset?.cabinetCard ?? document.activeElement?.tagName)
  await page.locator('[data-cabinet-card][tabindex="0"]').focus()
  const first = await focused()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  const second = await focused()
  const current = await page.evaluate(() => document.querySelector('[aria-current="true"]')?.dataset.cabinetCard)
  await page.keyboard.press('Enter')
  await page.locator('[data-cabinet-original]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-cabinet-original]').waitFor({ state: 'detached' })
  await page.waitForTimeout(200)
  log('A29 keyboard', JSON.stringify({ first, afterArrow: second, ariaCurrent: current, focusAfterEscape: await focused() }))
  await page.locator(`[data-cabinet-card="${first}"]`).tap()
  const tapped = await page.locator('[data-cabinet-original]').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const targets = await page.evaluate(() =>
    [...document.querySelectorAll('[data-terminal-drawer] [role=tab], [data-terminal-drawer] button[aria-pressed], [data-artifact-cabinet] button, [data-artifact-cabinet] input, [data-artifact-cabinet] select, [role=separator]')]
      .map((e) => [e.getAttribute('aria-label')?.slice(0, 20) ?? e.textContent.trim(), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
      .filter((r) => r[1] && r[2]),
  )
  log('A29 touch opened', tapped, 'target sizes', JSON.stringify(targets))

  // A30: the accessibility tree the cabinet exposes.
  const tree = await page.locator('[data-artifact-cabinet]').ariaSnapshot()
  fs.writeFileSync(out + 'a30-aria.yml', tree)
  log('A30 aria snapshot lines', tree.split('\n').length, '\n' + tree.split('\n').slice(0, 30).join('\n'))

  // A31: composed text and paste in search; '/' in the composer stays there.
  const search = page.locator('[data-cabinet-search]')
  await search.click()
  await page.keyboard.type('café 日本語 ')
  await page.keyboard.insertText('Headland')
  const searchValue = await search.inputValue()
  await page.waitForTimeout(800)
  const matches = await page.locator('[data-cabinet-card]').count()
  await search.fill('')
  const composer = page.locator('[contenteditable="true"], textarea').first()
  await composer.click()
  await page.keyboard.type('a/b')
  const composerText = (await composer.textContent()) || (await composer.inputValue().catch(() => ''))
  const activeIsComposer = await page.evaluate(() => !document.activeElement?.closest('[data-artifact-cabinet]'))
  log('A31', JSON.stringify({ searchValue, matchesForGibberish: matches, composerText, focusStayedInComposer: activeIsComposer }))
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')

  // A10: Pixel chosen under Calm survives reload and a preset switch;
  // reset restores the default and leaves the other preferences alone.
  const KEY = 'theorem-ui:appearance'
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY)
  const prefSel = 'select[aria-label="Preview style"]'
  const before = { value: await page.locator(prefSel).inputValue(), stored: await stored() }
  await page.locator(prefSel).selectOption('pixel')
  await page.waitForTimeout(600)
  await page.reload({ waitUntil: 'networkidle' })
  await openCabinet(page)
  const afterReload = await page.locator(prefSel).inputValue()
  await page.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k))
    const sel = v.state ?? v
    sel.preset = 'expressive'
    localStorage.setItem(k, JSON.stringify(v))
  }, KEY)
  await page.reload({ waitUntil: 'networkidle' })
  await openCabinet(page)
  const afterPreset = await page.locator(prefSel).inputValue()
  await page.locator(prefSel).selectOption('theme')
  await page.waitForTimeout(400)
  const reset = {
    value: await page.locator(prefSel).inputValue(),
    label: await page.locator(prefSel + ' option[value="theme"]').textContent(),
    stored: await stored(),
  }
  log('A10', JSON.stringify({ before, afterReload, afterPreset, reset }))
  // restore the original selection
  await page.evaluate(([k, v]) => (v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k)), [KEY, before.stored])

  // A29: resize by keyboard.
  await page.reload({ waitUntil: 'networkidle' })
  await openCabinet(page)
  const sep = page.getByRole('separator', { name: 'Gallery width' })
  const w0 = await sep.getAttribute('aria-valuenow')
  await sep.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForTimeout(400)
  const w1 = await sep.getAttribute('aria-valuenow')
  const dock1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cabinet-dock'))
  const cab1 = await page.evaluate(() => Math.round(document.querySelector('[data-artifact-cabinet]').getBoundingClientRect().width))
  await page.keyboard.press('End')
  await page.waitForTimeout(400)
  const wEnd = await sep.getAttribute('aria-valuenow')
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  for (let i = 0; i < 100; i++) if (Number(await sep.getAttribute('aria-valuenow')) < Number(w0)) await page.keyboard.press('ArrowLeft'); else break
  log('A29 keyboard resize', JSON.stringify({ w0, afterLeftAndShiftLeft: w1, dock1, cabinetBox: cab1, end: wEnd, restored: await sep.getAttribute('aria-valuenow') }))

  // A34: 200% text.
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'))
  await page.waitForTimeout(1200)
  log('A34', JSON.stringify(await widths(page)), JSON.stringify(await alignment(page)))
  await page.screenshot({ path: out + 'a34-text200.png' })
  await page.evaluate(() => (document.documentElement.style.fontSize = ''))

  // A29: coarse-pointer target sizes.
  const touch = await browser.newContext({ viewport: { width: 1536, height: 900 }, hasTouch: true, isMobile: false })
  const tp = await touch.newPage()
  await openCabinet(tp)
  const cdp = await touch.newCDPSession(tp)
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
  await tp.waitForTimeout(800)
  log('A29 coarse pointer', await tp.evaluate(() => matchMedia('(pointer: coarse)').matches), JSON.stringify(await tp.evaluate(() =>
    [...document.querySelectorAll('[data-terminal-drawer] [role=tab], [data-terminal-drawer] button[aria-pressed], [data-artifact-cabinet] input, [data-artifact-cabinet] select, [data-artifact-cabinet] [role=group] button')]
      .map((e) => [e.getAttribute('aria-label') ?? e.textContent.trim(), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))))
  await touch.close()

  log('A08 non-GET requests while browsing', browseMutations, JSON.stringify(mutations.slice(0, 10)))
  log('iframes in cabinet', await page.locator('[data-artifact-cabinet] iframe').count())
  log('console errors', JSON.stringify(errors.slice(0, 10)))
  fs.writeFileSync(out + 'accept.json', JSON.stringify(results, null, 1))
  await browser.close()
})()
