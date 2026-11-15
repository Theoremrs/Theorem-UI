// Product settings navigation and the actual glass renderer, not the dialog harness.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { PNG } from 'pngjs'
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
  // Clearly named controls keep accessible names without hover popups.
  for (const name of [/Switch to (light|dark) mode/, 'Agent terminal']) {
    const control = page
      .getByRole('button', { name })
      .filter({ visible: true })
      .first()
    await control.hover()
    await page.waitForTimeout(1100)
    assert.equal(await page.getByRole('tooltip').count(), 0)
  }
  await page.mouse.move(0, 0)
  checks.push({ tooltips: 'theme and terminal have no hover popup' })

  await page.evaluate(async () => {
    const { useLifeControls } = await import('/src/lib/life/store.ts')
    const { onLifeFrame } = await import('/src/components/life/frames.ts')
    useLifeControls.setState({ companion: false, shown: true })
    window.__glassFieldFrames = 0
    window.__stopGlassFieldFrames = onLifeFrame(
      () => window.__glassFieldFrames++,
    )
  })
  await page.waitForFunction(() => window.__glassFieldFrames >= 2)
  await page.evaluate(() => window.__stopGlassFieldFrames())
  checks.push({ field: 'glass receives frames with the companion off' })
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
      await shell.locator('[data-liquid-canvas]').waitFor({ state: 'attached' })
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
      assert.equal(paint.live, 'live')
      assert(paint.canvas.width > 0 && paint.canvas.height > 0)

      // A canvas alone does not establish transparency. Put two known colors
      // behind the actual pane and require the rendered interior to change.
      await shell.evaluate((node) => {
        const backdrop = document.createElement('div')
        backdrop.dataset.glassProbe = ''
        Object.assign(backdrop.style, {
          position: 'absolute',
          inset: '0',
          background: '#ff0000',
          pointerEvents: 'none',
        })
        node.before(backdrop)
      })
      const red = PNG.sync.read(await shell.screenshot())
      await page.locator('[data-glass-probe]').evaluate((node) => {
        node.style.background = '#0000ff'
      })
      const blue = PNG.sync.read(await shell.screenshot())
      const pixel = (png) => {
        const offset =
          (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) *
          4
        return [...png.data.slice(offset, offset + 3)]
      }
      const redPixel = pixel(red)
      const bluePixel = pixel(blue)
      assert(
        redPixel[0] > bluePixel[0] + 30,
        JSON.stringify({ redPixel, bluePixel }),
      )
      assert(
        bluePixel[2] > redPixel[2] + 30,
        JSON.stringify({ redPixel, bluePixel }),
      )
      await page.locator('[data-glass-probe]').evaluate((node) => node.remove())
      paint.transmittedBackdrop = { redPixel, bluePixel }
      assert(await editor.evaluate((node) => node === window.__glassEditor))
      assert.equal(await editor.textContent(), 'Keep my glass composer draft.')
      checks.push({ material, dark, paint })
      await shell.screenshot({
        path: `${reviewOutput}/composer-${material}-${dark ? 'dark' : 'light'}.png`,
      })
      const message = page
        .locator('[data-slot="aui_user-message-root"]')
        .first()
      await message.hover()
      await message.locator('.aui-user-action-edit').click()
      const edit = page.locator('.aui-edit-composer-root')
      await edit.locator('[data-liquid-canvas]').waitFor({ state: 'attached' })
      await page.waitForFunction(
        () =>
          document.querySelector('.aui-edit-composer-root')?.dataset.liquid ===
          'live',
      )
      paint.editComposer = await edit.evaluate((node) => ({
        material: node.dataset.material,
        live: node.dataset.liquid,
        planes: [...node.querySelectorAll('.appearance-reading-plane')].map(
          (plane) => getComputedStyle(plane).backgroundColor,
        ),
      }))
      assert.equal(paint.editComposer.material, material)
      assert.equal(paint.editComposer.live, 'live')
      assert.equal(paint.editComposer.planes.length, 2)
      assert(
        paint.editComposer.planes.every(
          (color) => color === 'rgba(0, 0, 0, 0)',
        ),
      )
      await edit.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert(await editor.evaluate((node) => node === window.__glassEditor))
      assert.equal(await editor.textContent(), 'Keep my glass composer draft.')
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
