// Product settings navigation and the actual glass renderer, not the dialog harness.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchReviewBrowser, reviewOutput } from './review-browser.mjs'
import { chooseOption } from './browser-controls.mjs'

const base = process.env.ORACLE_BASE ?? 'http://127.0.0.1:3117'
await mkdir(reviewOutput, { recursive: true })
const browser = await launchReviewBrowser()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const checks = []
try {
  await page.goto(`${base}/story/shell-compare`)
  await page
    .locator('[data-story-ready]')
    .waitFor({ state: 'attached', timeout: 60_000 })
  await page.locator('[data-story-appearance-controls]').evaluate((node) => {
    node.hidden = true
  })
  const editor = page
    .getByRole('textbox', { name: 'Message input', exact: true })
    .filter({ visible: true })
    .first()
  await editor.fill('Keep my glass composer draft.')
  await editor.evaluate((node) => {
    window.__glassEditor = node
  })
  await page.evaluate(async () => {
    const { useAppearance } = await import('/src/lib/appearance.ts')
    useAppearance
      .getState()
      .loadSelection({ preset: 'expressive', overrides: { palette: 'stone' } })
  })
  for (const material of ['glass', 'liquid']) {
    await page.evaluate(async (material) => {
      const { useAppearance } = await import('/src/lib/appearance.ts')
      useAppearance
        .getState()
        .setOverrides({ materials: { composer: material } })
    }, material)
    for (const dark of [true, false]) {
      const toggle = page
        .getByRole('button', { name: /Switch to (light|dark) mode/ })
        .filter({ visible: true })
        .first()
      if (
        (await toggle.getAttribute('aria-label')) ===
        `Switch to ${dark ? 'dark' : 'light'} mode`
      )
        await toggle.click()
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains('dark') === dark,
        dark,
      )
      assert.equal(
        await page.getByRole('dialog', { name: 'Appearance settings' }).count(),
        0,
      )
      const shell = page
        .locator('[data-slot="aui_composer-shell"]')
        .filter({ visible: true })
        .first()
      if (material === 'liquid')
        await shell
          .locator('[data-liquid-canvas]')
          .waitFor({ state: 'attached' })
      await page.waitForFunction(() => document.fonts.status === 'loaded')
      const paint = await shell.evaluate((node) => {
        const style = getComputedStyle(node)
        const planes = [
          ...node.querySelectorAll('.appearance-reading-plane'),
        ].map((plane) => ({
          background: getComputedStyle(plane).backgroundColor,
          ink: getComputedStyle(plane).color,
        }))
        const canvas = node.querySelector('[data-liquid-canvas]')
        return {
          material: node.dataset.material,
          live: node.dataset.liquid,
          ink: style.color,
          backdrop: style.backdropFilter,
          planes,
          canvas: canvas && { width: canvas.width, height: canvas.height },
        }
      })
      assert.equal(paint.material, material)
      assert(paint.planes.length >= 5)
      assert(
        paint.planes.every(
          (plane) =>
            plane.background === 'rgba(0, 0, 0, 0)' && plane.ink === paint.ink,
        ),
        JSON.stringify(paint),
      )
      assert.notEqual(paint.backdrop, 'none')
      if (material === 'liquid') {
        assert.equal(paint.live, 'live')
        assert(paint.canvas.width > 0 && paint.canvas.height > 0)
      }
      assert(await editor.evaluate((node) => node === window.__glassEditor))
      assert.equal(await editor.textContent(), 'Keep my glass composer draft.')
      checks.push({ material, dark, paint })
      await shell.screenshot({
        path: `${reviewOutput}/composer-${material}-${dark ? 'dark' : 'light'}.png`,
      })
    }
  }
  await page.emulateMedia({ forcedColors: 'active' })
  assert.notEqual(
    await editor.evaluate(
      (node) =>
        getComputedStyle(node.closest('.appearance-reading-plane'))
          .backgroundColor,
    ),
    'rgba(0, 0, 0, 0)',
  )
  await page.emulateMedia({ forcedColors: 'none' })
  checks.push({ forcedColors: 'opaque reading plane retained' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Switch to dark mode' })
    .filter({ visible: true })
    .first()
    .click()
  await page.waitForFunction(() =>
    document.documentElement.classList.contains('dark'),
  )
  await page
    .getByRole('button', { name: 'Switch to light mode' })
    .filter({ visible: true })
    .first()
    .click()
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('dark'),
  )
  assert.equal(
    await page.getByRole('dialog', { name: 'Appearance settings' }).count(),
    0,
  )
  assert.equal(await editor.textContent(), 'Keep my glass composer draft.')
  checks.push({ phone: 'Header toggles only mode and preserves the draft' })
  await page.setViewportSize({ width: 1440, height: 1000 })

  // Follow the product's account menu and real settings routes.
  await page
    .getByRole('button', { name: /^Account/ })
    .filter({ visible: true })
    .first()
    .click()
  assert.equal(await page.getByRole('menuitemradio').count(), 0)
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.waitForURL('**/settings/ai')
  await page
    .getByRole('link', { name: 'Appearance', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  await page.waitForURL('**/settings/appearance')
  await chooseOption(page, page, 'Composer material', 'Frosted glass')
  await page.waitForFunction(
    () => document.documentElement.dataset.materialComposer === 'glass',
  )
  assert.equal(
    await page.getByRole('dialog', { name: 'Appearance settings' }).count(),
    0,
  )
  assert.equal(
    await page.locator('[data-story-appearance-controls]').count(),
    0,
  )
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.waitForFunction(() =>
    document.documentElement.classList.contains('dark'),
  )
  checks.push({
    settings:
      'Account → Settings → Appearance controls update the real preferences',
  })
  await page.screenshot({
    path: `${reviewOutput}/appearance-dedicated-page.png`,
  })
  console.log(`PASS ${checks.length} theme, glass and settings checks`)
} finally {
  await writeFile(
    `${reviewOutput}/theme-glass.json`,
    JSON.stringify({ checks }, null, 2) + '\n',
  )
  await browser.close()
}
