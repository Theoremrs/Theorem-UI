// Real composer, slash picker and settings controls over the story API fixture.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { launchReviewBrowser } from './review-browser.mjs'

const base = process.env.ORACLE_BASE ?? 'http://127.0.0.1:3117'
const out = process.env.ORACLE_REVIEW_OUT ?? '/tmp/theorem-output-settings'
await mkdir(out, { recursive: true })
const browser = await launchReviewBrowser()
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/story/shell-compare`)
    const editor = page.getByRole('textbox', { name: 'Message input', exact: true }).first()
    await editor.waitFor()
    assert.equal(await page.getByRole('button', { name: 'Response length and detail', exact: true }).count(), 0)
    await editor.fill('Keep my draft /output-settings')
    await editor.press('End')
    await page.getByRole('option', { name: /output-settings/ }).click()
    const settings = page.getByRole('dialog', { name: 'Output settings', exact: true })
    await settings.waitFor()
    await settings.getByRole('button', { name: 'Concise', exact: true }).click()
    assert.equal(await settings.getByRole('button', { name: 'Concise', exact: true }).getAttribute('aria-pressed'), 'true')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal((await editor.innerText()).trim(), 'Keep my draft')
    await editor.fill('Keep my draft /output-style')
    await editor.press('End')
    await page.getByRole('option', { name: /output-style/ }).click()
    const style = page.getByRole('dialog', { name: 'Output style', exact: true })
    await style.waitFor()
    await style.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Explanatory', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [role="combobox"]')?.textContent === 'Explanatory')
    const bounds = await style.boundingBox()
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width)
    await page.screenshot({ path: `${out}/output-style-${width}.png` })
    await style.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal((await editor.innerText()).trim(), 'Keep my draft')
    await page.screenshot({ path: `${out}/composer-${width}.png` })
    await page.goto(`${base}/story/settings-ai`)
    await page.getByRole('heading', { name: 'Output styles and settings' }).waitFor()
    await page.getByRole('combobox', { name: 'Default output style', exact: true }).click()
    await page.getByRole('option', { name: 'Explanatory', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Default output style"]')?.textContent === 'Explanatory')
    await page.screenshot({ path: `${out}/settings-${width}.png` })
    assert.deepEqual(errors, [])
    console.log(`PASS ${width}px: no Length button; both slash dialogs; retained draft; native style selection; Settings controls`)
    await page.close()
  }
} finally { await browser.close() }
