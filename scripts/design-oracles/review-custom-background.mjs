// Exercise validated palettes whose light/dark surface brightness is reversed.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchReviewBrowser } from './review-browser.mjs'
import { wcagContrast } from 'culori'

const base = process.env.ORACLE_BASE ?? 'http://127.0.0.1:3117'
const out =
  process.env.ORACLE_REVIEW_OUT ??
  'docs/plans/composable-appearance/evidence/custom-background'
await mkdir(out, { recursive: true })
const browser = await launchReviewBrowser()
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
})
const checks = []
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('requestfailed', (request) =>
  errors.push(`${request.url()}: ${request.failure()?.errorText}`),
)
try {
  await page.goto(`${base}/story/shell-compare`)
  await page
    .locator('[data-story-ready]')
    .waitFor({ state: 'attached', timeout: 60_000 })
  await page
    .locator('[data-surface-role="assistant-reading"]')
    .first()
    .waitFor()
  await page.evaluate(async () => {
    const { useAppearance, customPaletteSchema } =
      await import('/src/lib/appearance.ts')
    const { COLOR_ROLES } = await import('/src/lib/appearance-policy.ts')
    const root = document.documentElement
    useAppearance.getState().loadSelection({ preset: 'calm', overrides: {} })
    const colors = (dark) => {
      root.classList.toggle('dark', dark)
      const style = getComputedStyle(root)
      return Object.fromEntries(
        [...new Set(Object.values(COLOR_ROLES))].map((token) => [
          token,
          style.getPropertyValue(`--${token}`).trim(),
        ]),
      )
    }
    const light = colors(true),
      dark = colors(false)
    window.__customBackground = customPaletteSchema.parse({
      name: 'Reversed brightness',
      light,
      dark,
    })
    useAppearance.getState().loadSelection({
      preset: 'expressive',
      overrides: {
        palette: 'custom',
        customPalette: window.__customBackground,
      },
    })
  })
  for (const dark of [false, true, false]) {
    await page.evaluate(async (dark) => {
      document.documentElement.classList.toggle('dark', dark)
      // Reduced motion still allows a short transition. Measure the new
      // foreground and background after the browser has painted the mode.
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )
    }, dark)
    const paint = await page
      .locator('[data-surface-role="assistant-reading"]')
      .first()
      .evaluate((node) => {
        const root = getComputedStyle(document.documentElement)
        const prose = getComputedStyle(
          node.querySelector('[data-appearance-part="prose-track"]'),
        )
        const sheet = getComputedStyle(node.closest('.sheet'))
        const token = (name) => root.getPropertyValue(name).trim()
        return {
          neutral: token('--surface-neutral'),
          from: token('--sheet-from'),
          to: token('--sheet-to'),
          shade: token('--sheet-shade'),
          ink: prose.color,
          secondary: token('--ink-muted'),
          link: token('--redwood-ink'),
          faintTop: token('--ink-faint-top'),
          faintBottom: token('--ink-faint-bottom'),
          sheet: sheet.backgroundColor,
          raised: token('--surface-raised'),
          rail: token('--surface-rail'),
          reply: getComputedStyle(node).backgroundColor,
        }
      })
    assert.equal(
      paint.from,
      paint.neutral,
      'Custom sheet must use its validated surface, not the built-in gradient',
    )
    assert.equal(paint.to, paint.neutral)
    assert.equal(
      paint.shade,
      paint.neutral,
      'Dark mode must not darken a custom light surface behind dark ink',
    )
    assert.equal(paint.reply, 'rgba(0, 0, 0, 0)')
    for (const background of ['sheet', 'raised', 'rail'])
      for (const ink of ['ink', 'secondary', 'link', 'faintTop', 'faintBottom'])
        assert(
          wcagContrast(paint[ink], paint[background]) >= 4.5,
          `${ink} ${paint[ink]} on ${background} ${paint[background]} (${dark ? 'dark' : 'light'})`,
        )
    checks.push({ mode: dark ? 'dark' : 'light', passed: true, paint })
    await page.screenshot({
      path: `${out}/custom-${dark ? 'dark' : 'light'}.png`,
    })
    console.log(
      `PASS custom ${dark ? 'dark' : 'light'}: text follows the actual shared background`,
    )
  }
} catch (error) {
  console.error(error.stack, errors)
  throw error
} finally {
  await writeFile(
    `${out}/custom-background.json`,
    JSON.stringify({ checks }, null, 2) + '\n',
  )
  await browser.close()
}
