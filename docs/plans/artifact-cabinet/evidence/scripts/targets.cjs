// Greptile round 14: short window at 200% text keeps cards; wrapped filter targets do not overlap.
const { chromium } = require('playwright')
const projectId = process.argv[2]
const BASE = 'http://localhost:3000'
const out = __dirname + '/evidence/'
async function openCabinet(page) {
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
  if (!(await page.locator('[data-artifact-cabinet]').count()))
    await page.getByRole('button', { name: /^Gallery$/ }).first().click()
  await page.waitForSelector('[data-artifact-cabinet]')
  await page.waitForFunction(() => document.querySelectorAll('[data-cabinet-card]').length >= 1, null, { timeout: 30000 })
  await page.waitForTimeout(1500)
}
const filters = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-label="Filter artifacts"] button')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, x: r.x, y: r.y, w: r.width, h: r.height } }))
const overlaps = (fs) => { const o = []; for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) { const a = fs[i], b = fs[j]; if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) o.push(a.t + '/' + b.t) } return o }
;(async () => {
  const browser = await chromium.launch()
  // 1. Short window, 200% text.
  const page = await browser.newPage({ viewport: { width: 1536, height: 560 } })
  await openCabinet(page)
  await page.addStyleTag({ content: 'html{font-size:200% !important}' })
  await page.waitForTimeout(2000)
  const s = await page.evaluate(() => ({ cards: document.querySelectorAll('[data-cabinet-card]').length, font: getComputedStyle(document.querySelector('[data-artifact-cabinet]')).fontSize, visible: [...document.querySelectorAll('[data-cabinet-card]')].filter((c) => c.getBoundingClientRect().height > 0).length }))
  console.log('short 200%', s, 'filter overlaps', overlaps(await filters(page)))
  await page.screenshot({ path: out + 'g14-short-200.png' })
  // 2. Narrow overlay where filters wrap, fine and coarse.
  for (const coarse of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: coarse, isMobile: coarse })
    const p = await ctx.newPage()
    await openCabinet(p)
    await p.addStyleTag({ content: 'html{font-size:150% !important}' })
    await p.waitForTimeout(2000)
    const fs = await filters(p)
    console.log(coarse ? 'coarse' : 'fine', 'rows', [...new Set(fs.map((f) => Math.round(f.y)))].length, fs.map((f) => `${f.t}@${Math.round(f.y)}h${Math.round(f.h)}`).join(' '), 'overlaps', overlaps(fs))
    await p.screenshot({ path: out + `g14-wrap-${coarse ? 'coarse' : 'fine'}.png` })
    await ctx.close()
  }
  await browser.close()
})()
