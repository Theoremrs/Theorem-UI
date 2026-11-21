// Real CDN packages through the product App builder/checker and sandbox.
// Uses the existing in-memory document harness; no Theorem server is needed.
//   node scripts/e2e/app-luma.mjs
//   node scripts/e2e/app-luma.mjs --built
// E2E_CHROMIUM and E2E_PICTURE have the same meaning as in app-ts.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'

const html = readFileSync(
  new URL('../../test/fixtures/app-luma.html', import.meta.url),
  'utf8',
)
const served = await servePage('app-ts')
let browser
try {
  browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM || undefined,
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(180_000)
  const duplicateInitializations = []
  page.on('console', (message) => {
    if (
      /luma\.gl.*(?:already been initialized|multiple versions detected)/.test(
        message.text(),
      )
    )
      duplicateInitializations.push(message.text())
  })
  page.on('pageerror', (error) => console.log('[page error]', error.message))
  await page.goto(served.url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())

  const receipt = await page.evaluate(
    (source) => window.oracle.inspect(source, { runMs: 2500 }),
    html,
  )
  assert.equal(receipt.built, true, JSON.stringify(receipt))
  assert.equal(receipt.typesChecked, true, JSON.stringify(receipt))
  assert.deepEqual(receipt.problems, [], JSON.stringify(receipt.problems))
  assert.match(receipt.rendered?.text ?? '', /"drawn":true/)
  console.log(
    'ok   app.check builds, type-checks and runs all three pinned Luma packages',
  )

  await page.evaluate(async (source) => {
    await window.oracle.revise(source)
    window.oracle.show()
  }, html)
  const output = page
    .frameLocator('iframe')
    .locator('output[data-luma-smoke="ok"]')
  await output.waitFor({ state: 'visible' })
  const result = JSON.parse(await output.textContent())
  assert.equal(result.drawn, true)
  assert.ok(
    result.pixel[1] >= 200 && result.pixel[0] <= 50 && result.pixel[2] <= 50,
  )
  assert.equal(result.pixel[3], 255)
  assert.deepEqual(duplicateInitializations, [])
  console.log(
    'ok   visible sandbox Model draws an actual green center pixel',
    JSON.stringify(result),
  )

  if (process.env.E2E_PICTURE)
    await page.screenshot({ path: process.env.E2E_PICTURE, fullPage: true })
  console.log(
    served.built
      ? 'PASS production App GPU smoke'
      : 'PASS development App GPU smoke',
  )
} finally {
  await browser?.close()
  await served.close()
}
