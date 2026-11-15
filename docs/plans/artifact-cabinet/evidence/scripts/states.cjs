const { chromium } = require('playwright')
const out = __dirname + '/evidence/'
;(async () => {
  const b = await chromium.launch()
  const text = (p) => p.evaluate(() => document.querySelector('[data-artifact-cabinet]')?.innerText.replace(/\s+/g, ' ').slice(0, 400))
  const live = (p) => p.evaluate(() => document.querySelector('[data-artifact-cabinet] [aria-live]')?.textContent)
  const open = async (p) => { await p.goto('http://localhost:3000/projects/' + process.argv[2], { waitUntil: 'networkidle' }); if (!(await p.locator('[data-artifact-cabinet]').count())) await p.getByRole('button', { name: /^Cabinet$/ }).first().click(); await p.waitForSelector('[data-artifact-cabinet]'); await p.waitForTimeout(3000) }
  // 1. catalog unreachable from the start
  let p = await b.newPage({ viewport: { width: 1536, height: 900 } })
  await p.route('**/outputs*', (r) => r.abort('internetdisconnected'))
  await open(p); await p.waitForTimeout(4000)
  console.log('offline-first:', await live(p), '|', await text(p)); await p.screenshot({ path: out + 'a35-offline.png' }); await p.close()
  // 2. loaded, then the catalog refetch fails: stale, not empty
  p = await b.newPage({ viewport: { width: 1536, height: 900 } })
  await open(p)
  await p.route('**/outputs*', (r) => r.fulfill({ status: 503, body: '{}' }))
  // Leave and return to the tab: TanStack Query refetches on visibility.
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await p.waitForTimeout(300)
  await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
  await p.waitForTimeout(5000)
  console.log('stale:', await live(p), '| cards', await p.locator('[data-cabinet-card]').count(), '|', (await text(p)).slice(0, 200)); await p.screenshot({ path: out + 'a35-stale.png' }); await p.close()
  // 3. preview bytes fail; the original still exists
  p = await b.newPage({ viewport: { width: 1536, height: 900 } })
  await p.route('**/uploads/**/content', (r) => r.fulfill({ status: 500, body: '' }))
  await open(p); await p.waitForTimeout(3000)
  const desc = await p.$$eval('[data-cabinet-card]', (bs) => bs.map((x) => x.getAttribute('aria-description')))
  console.log('preview-failed:', JSON.stringify(desc), '|', (await text(p)).slice(0, 300)); await p.screenshot({ path: out + 'a35-preview-failed.png' }); await p.close()
  await b.close()
})()
