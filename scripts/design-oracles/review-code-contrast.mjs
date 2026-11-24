// Actual Shiki and Crepe/CodeMirror paint in the Vite story routes.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { blend, formatHex8, wcagContrast } from 'culori'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import typescript from 'shiki/langs/typescript.mjs'
import vitesseDark from 'shiki/themes/vitesse-dark.mjs'
import vitesseLight from 'shiki/themes/vitesse-light.mjs'
import { launchReviewBrowser, reviewOutput } from './review-browser.mjs'

const origin = process.env.ORACLE_BASE ?? 'http://127.0.0.1:3117'
const engine = process.env.ORACLE_ENGINE ?? 'chromium'
const out =
  process.env.ORACLE_CODE_OUT ?? `${reviewOutput}/${engine}-code-contrast.json`
const browser = await launchReviewBrowser(engine)
const results = []
const minimum = 4.5
let referenceHighlighter

function contrast(foreground, layers) {
  const background = blend(layers, 'normal', 'rgb')
  const text = blend([background, foreground], 'normal', 'rgb')
  return wcagContrast(text, background)
}

/**
 * F04's first fence is TypeScript. Compare its actual text paint with a fresh
 * Shiki pass over the bundled Vitesse theme, without the application's theme
 * adapter. This checks the authored colors and alpha character by character;
 * merging adjacent DOM spans cannot make a different tokenization pass.
 */
async function vitesseFidelity(observed) {
  const theme = observed.dark ? vitesseDark : vitesseLight
  referenceHighlighter ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine({ target: 'ES2018' }),
    langs: [typescript],
    themes: [vitesseLight, vitesseDark],
  })
  const highlighter = await referenceHighlighter
  const reference = highlighter.codeToTokens(observed.base.text, {
    lang: 'typescript',
    theme: theme.name,
  })
  const expected = reference.tokens.flatMap((line, index) => [
    ...(index ? [{ text: '\n', foreground: reference.fg }] : []),
    ...line.map((token) => ({
      text: token.content,
      foreground: token.color ?? reference.fg,
    })),
  ])
  const characters = (runs) =>
    runs.flatMap(({ text, foreground }) =>
      [...text].map((character) => ({
        character,
        color: formatHex8(foreground),
      })),
    )
  const actualCharacters = characters(observed.paintRuns)
  const expectedCharacters = characters(expected)
  const mismatches = []
  for (
    let offset = 0;
    offset < Math.max(actualCharacters.length, expectedCharacters.length);
    offset++
  ) {
    const actual = actualCharacters[offset]
    const authored = expectedCharacters[offset]
    // Whitespace paints no ink, and the app's pass (codeToTokensBase in
    // lib/code-classes.ts, mergeWhitespaces by default) gives a lone space
    // the next token's colour. Compare colour on glyphs only.
    if (
      actual?.character !== authored?.character ||
      (!/\s/.test(authored?.character ?? '') &&
        actual?.color !== authored?.color)
    )
      mismatches.push({ offset, actual, authored })
  }
  const expectedGround = formatHex8(theme.colors['editor.background'])
  const actualGround = formatHex8(
    blend(observed.base.background, 'normal', 'rgb'),
  )
  const expectedForeground = formatHex8(theme.colors['editor.foreground'])
  const actualForeground = formatHex8(observed.base.foreground)
  return {
    source: `Shiki bundled ${theme.name}`,
    language: 'typescript',
    expectedGround,
    actualGround,
    expectedForeground,
    actualForeground,
    comparedCharacters: expectedCharacters.length,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 20),
    passed:
      expectedCharacters.length > 0 &&
      actualGround === expectedGround &&
      actualForeground === expectedForeground &&
      mismatches.length === 0,
  }
}

async function customProfile() {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/story/design-oracle-content`)
    await page.locator('[data-appearance-fixture="F04"]').waitFor()
    return await page.evaluate(async () => {
      const { COLOR_ROLES } = await import('/src/lib/appearance-policy.ts')
      const { customPaletteSchema } = await import('/src/lib/appearance.ts')
      const root = document.documentElement
      const colors = Object.fromEntries(
        ['light', 'dark'].map((mode) => {
          root.classList.toggle('dark', mode === 'dark')
          const style = getComputedStyle(root)
          return [
            mode,
            Object.fromEntries(
              [...new Set(Object.values(COLOR_ROLES))].map((token) => [
                token,
                style.getPropertyValue(`--${token}`).trim(),
              ]),
            ),
          ]
        }),
      )
      colors.light.popover = '#e4f4ff'
      colors.dark.popover = '#26394a'
      return customPaletteSchema.parse({
        name: 'Blue paper and ink',
        ...colors,
      })
    })
  } finally {
    await page.close()
  }
}

async function measure(page, fixture, root, leaf, inline) {
  await page.goto(`${origin}/story/design-oracle-${fixture}`)
  const block = page.locator(root).first()
  await block.waitFor()
  await page.locator(`${root} ${leaf}`).first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  if (fixture === 'draft') {
    await block.click()
    await page.keyboard.press('ControlOrMeta+a')
    await block
      .locator('..')
      .locator('.cm-selectionBackground')
      .first()
      .waitFor({
        state: 'attached',
      })
  }
  const observed = await page.evaluate(
    ({ root, leaf, inline }) => {
      const first = document.querySelector(root)
      const appearance = document.documentElement
      const background = (element) => {
        const colors = []
        for (let node = element; node; node = node.parentElement) {
          const value = getComputedStyle(node).backgroundColor
          if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)')
            colors.push(value)
          // Any colour syntax can be translucent (rgba, or oklab/oklch/color
          // with "/ alpha"); keep walking until an opaque layer is found.
          const alpha = value.match(/\/\s*([\d.]+%?)\s*\)$/)?.[1]
          const translucent =
            value.startsWith('rgba(') ||
            (alpha !== undefined &&
              (alpha.endsWith('%')
                ? parseFloat(alpha) < 100
                : parseFloat(alpha) < 1))
          if (!translucent && value !== 'transparent') break
        }
        return colors.reverse()
      }
      const paint = (node) => ({
        text: node.textContent,
        foreground: getComputedStyle(node).color,
        background: background(node),
      })
      const editor = first.closest('.cm-editor')
      const selection = editor?.querySelector('.cm-selectionBackground')
      const cursor = editor?.querySelector('.cm-cursor')
      const token = first.querySelector(leaf)
      const nativeSelection = getComputedStyle(token, '::selection')
      const inlineCode = document.querySelector(inline)
      const paintRuns = []
      if (!editor) {
        const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          paintRuns.push({
            text: node.textContent,
            foreground: getComputedStyle(node.parentElement).color,
          })
        }
      }
      return {
        palette: appearance.dataset.palette,
        dark: appearance.classList.contains('dark'),
        base: paint(first),
        tokens: [...first.querySelectorAll(leaf)].map(paint),
        paintRuns,
        inline: inlineCode && paint(inlineCode),
        selection: editor
          ? {
              background:
                selection && getComputedStyle(selection).backgroundColor,
            }
          : {
              background: nativeSelection.backgroundColor,
              foreground: nativeSelection.color,
            },
        caret: cursor && getComputedStyle(cursor).borderLeftColor,
      }
    },
    { root, leaf, inline },
  )
  const blockPaint = [observed.base, ...observed.tokens]
  const items = [...blockPaint, observed.inline].filter(Boolean)
  for (const item of items)
    item.ratio = contrast(item.foreground, item.background)
  const selected = observed.selection.background
  const selectionColors = observed.selection.foreground
    ? [observed.selection.foreground]
    : blockPaint.map(({ foreground }) => foreground)
  observed.selection.minimumRatio = selected
    ? Math.min(...selectionColors.map((color) => contrast(color, [selected])))
    : null
  observed.caretRatio = observed.caret
    ? contrast(observed.caret, observed.base.background)
    : null
  observed.minimumRatio = Math.min(...items.map(({ ratio }) => ratio))
  observed.distinctTokenColors = new Set(
    observed.tokens.map(({ foreground }) => foreground),
  ).size
  if (fixture === 'content' && observed.palette === 'vitesse') {
    // The owner requested the original Vitesse hierarchy on its native ground.
    // Keep all measured ratios as diagnostics; source fidelity is the syntax
    // contract here. Base text, inline code and selection still require 4.5:1.
    observed.syntaxContract = 'authored Vitesse on its native ground'
    observed.sourceFidelity = await vitesseFidelity(observed)
  } else {
    observed.syntaxContract = 'calibrated contrast'
  }
  return observed
}

try {
  const customPalette = await customProfile()
  const profiles = [
    ['calm', 'github-sharp'],
    ['expressive', 'github-sharp'],
    ['calm', 'stone'],
    ['calm', 'vitesse'],
    ['calm', 'custom', customPalette],
    [
      'expressive',
      'custom',
      {
        name: 'Reversed mode surfaces',
        light: customPalette.dark,
        dark: customPalette.light,
      },
    ],
  ]
  for (const [preset, palette, custom] of profiles) {
    for (const mode of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      })
      page.setDefaultTimeout(45_000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript(
        ({ mode, preset, palette, custom }) => {
          // Init scripts run in every frame, and a sandboxed app frame has no storage.
          try {
            localStorage.setItem('theorem-ui-theme', mode)
            localStorage.setItem(
              'theorem-ui:appearance',
              JSON.stringify({
                version: 1,
                state: {
                  preset,
                  overrides: {
                    palette,
                    ...(custom && { customPalette: custom }),
                  },
                },
              }),
            )
          } catch {}
        },
        { mode, preset, palette, custom },
      )
      try {
        const transcript = await measure(
          page,
          'content',
          '.aui-shiki pre',
          '.line > span',
          '.aui-md-inline-code',
        )
        const editor = await measure(
          page,
          'draft',
          '.theorem-composer .cm-content',
          '.cm-line > span',
          '.ProseMirror p code',
        )
        const passed =
          errors.length === 0 &&
          [transcript, editor].every(
            (surface) =>
              surface.palette === palette &&
              surface.dark === (mode === 'dark') &&
              surface.inline &&
              surface.distinctTokenColors >= 2 &&
              surface.base.ratio >= minimum &&
              surface.inline.ratio >= minimum &&
              (surface.sourceFidelity
                ? surface.sourceFidelity.passed
                : surface.minimumRatio >= minimum) &&
              surface.selection.minimumRatio >= minimum,
          ) &&
          editor.caretRatio >= 3
        results.push({
          preset,
          palette,
          mode,
          passed,
          errors,
          transcript,
          editor,
        })
        console.log(
          `${passed ? 'PASS' : 'FAIL'} ${preset}/${palette}/${mode} ${transcript.minimumRatio.toFixed(2)} / ${editor.minimumRatio.toFixed(2)}`,
        )
      } catch (error) {
        results.push({
          preset,
          palette,
          mode,
          passed: false,
          errors,
          error: String(error),
        })
        console.log(`FAIL ${preset}/${palette}/${mode} ${error}`)
      } finally {
        await page.close()
      }
    }
  }
} finally {
  const version = browser.version()
  if (referenceHighlighter) (await referenceHighlighter).dispose()
  await browser.close()
  await mkdir(dirname(out), { recursive: true })
  await writeFile(
    out,
    JSON.stringify({ engine, version, minimum, results }, null, 2) + '\n',
  )
}

if (!results.length || results.some(({ passed }) => !passed))
  process.exitCode = 1
