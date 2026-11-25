// Markdown typography oracle (chat typography brief, 2026-11-24) over F12,
// the Markdown inventory story. Each check names its authority: a contract
// the renderer must keep, or a target the rhythm was tuned to. Writes the
// measurements and a render per case; `--capture <dir>` also saves renders
// there under <case>.png (the reference and candidate halves of a collage).
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchReviewBrowser, reviewOutput } from './review-browser.mjs'

const base = process.env.ORACLE_BASE ?? 'http://127.0.0.1:3117'
const captureAt = process.argv.indexOf('--capture')
const capture = captureAt > 0 ? resolve(process.argv[captureAt + 1]) : null
await mkdir(reviewOutput, { recursive: true })
if (capture) await mkdir(capture, { recursive: true })

const CASES = [
  { id: 'light-1440', width: 1440, theme: 'light', overrides: {} },
  { id: 'dark-1440', width: 1440, theme: 'dark', overrides: {} },
  {
    id: 'light-1440-content-125',
    width: 1440,
    theme: 'light',
    overrides: { scales: { content: 1.25 } },
  },
  {
    id: 'light-1440-wide',
    width: 1440,
    theme: 'light',
    overrides: { reading: 'wide' },
  },
  { id: 'light-390', width: 390, theme: 'light', overrides: {} },
]

// Fractions of the assistant line (H) between blocks: the brief's §4 table.
const RHYTHM = {
  paragraph: 0.75,
  beforeSection: 1.25,
  afterSection: 0.4,
  beforeSubsection: 1,
  afterSubsection: 0.3,
  listItem: 0.25,
  block: 0.75,
}

const browser = await launchReviewBrowser()
const results = []
try {
  for (const c of CASES) {
    const page = await browser.newPage({
      viewport: { width: c.width, height: 6000 },
      reducedMotion: 'reduce',
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(({ theme, overrides }) => {
      try {
        localStorage.setItem('theorem-ui-theme', theme)
        localStorage.setItem(
          'theorem-ui:appearance',
          JSON.stringify({ version: 1, state: { preset: 'calm', overrides } }),
        )
      } catch {}
    }, c)
    await page.goto(`${base}/story/design-oracle-markdown`)
    await page
      .locator('[data-appearance-fixture="F12"] .aui-md-table')
      .first()
      .waitFor()
    await page
      .locator('[data-appearance-fixture="F12"] .aui-shiki')
      .first()
      .waitFor()
    await page
      .locator('[data-appearance-fixture="F12"] [data-aui-mermaid-svg] svg')
      .first()
      .waitFor()
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })

    const measured = await page.evaluate((RHYTHM) => {
      const px = (value) => parseFloat(value)
      const style = (node) => getComputedStyle(node)
      const font = (node) => {
        const s = style(node)
        return {
          text: node.textContent.trim().slice(0, 40),
          family: s.fontFamily.split(',')[0].replaceAll('"', '').trim(),
          size: px(s.fontSize),
          lineHeight: px(s.lineHeight),
          weight: Number(s.fontWeight),
        }
      }
      const root = getComputedStyle(document.documentElement)
      const H =
        px(root.getPropertyValue('--appearance-prose-line-height')) ||
        px(style(document.querySelector('.aui-md-p')).lineHeight)

      // Human voice: every text block of the person's turn keeps Manrope.
      const human = document.querySelector('.aui-user-markdown')
      const humanBlocks = [
        ...human.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6'),
      ].map((node) => ({ tag: node.tagName, ...font(node) }))
      const humanVoice = humanBlocks.filter(
        (b) => b.tag !== 'BLOCKQUOTE' || true,
      )
      const humanMath = Boolean(human.querySelector('.katex'))
      const humanPrice = human.textContent.includes('$20')

      // The long answer is the last assistant message.
      const answers = [...document.querySelectorAll('.aui-md')]
      const long = answers.at(-1)
      const short = answers[0]
      const gap = (a, b) =>
        b.getBoundingClientRect().top - a.getBoundingClientRect().bottom
      const kids = [...long.children]
      const isHeading = (n) => /^H[1-6]$/.test(n.tagName)
      const isSection = (n) => n.tagName === 'H1' || n.tagName === 'H2'
      const isProse = (n) => n.matches('.aui-md-p')
      const isBlock = (n) =>
        n.matches(
          '.aui-md-table-wrapper, .aui-code-block, .aui-md-pre, .katex-display, .aui-mermaid-zoom-wrap',
        )
      const transitions = []
      for (let i = 1; i < kids.length; i++) {
        const [a, b] = [kids[i - 1], kids[i]]
        let kind
        if (isHeading(b))
          kind = isSection(b) ? 'beforeSection' : 'beforeSubsection'
        else if (isHeading(a))
          kind = isSection(a) ? 'afterSection' : 'afterSubsection'
        else if (isProse(a) && isProse(b)) kind = 'paragraph'
        else if (isBlock(a) || isBlock(b)) kind = 'block'
        if (!kind) continue
        transitions.push({
          kind,
          from:
            a.tagName +
            (a.className ? '.' + String(a.className).split(' ')[0] : ''),
          to:
            b.tagName +
            (b.className ? '.' + String(b.className).split(' ')[0] : ''),
          gap: gap(a, b),
          expected: RHYTHM[kind] * H,
        })
      }
      const tight = long.querySelector('ul')
      const tightItems = [...tight.children]
      const listGaps = tightItems
        .slice(1)
        .map((li, i) => gap(tightItems[i], li))
      const nested = tight.querySelector('ul')
      const nestedItems = nested ? [...nested.children] : []
      const nestedGaps = nestedItems
        .slice(1)
        .map((li, i) => gap(nestedItems[i], li))
      const loose = long.querySelector('ol')
      const looseInner = loose.querySelector('li > p + p')
      const looseInnerGap = looseInner
        ? gap(looseInner.previousElementSibling, looseInner)
        : null
      const firstShift = [short.firstElementChild, long.firstElementChild].map(
        (n) => px(style(n).marginBlockStart),
      )

      // Prose table.
      const table = long.querySelector('.aui-md-table')
      const td = table.querySelector('td')
      const th = table.querySelector('th')
      const thLink = th.parentElement.querySelector('a')
      const tables = [...long.querySelectorAll('.aui-md-table-wrapper')].map(
        (wrapper) => {
          const container =
            wrapper.querySelector('[data-slot="table-container"]') ?? wrapper
          return {
            scrollWidth: container.scrollWidth,
            clientWidth: container.clientWidth,
            wrapperWidth: wrapper.getBoundingClientRect().width,
            columnWidth: long.getBoundingClientRect().width,
            background: style(wrapper).backgroundColor,
            overflowX: style(container).overflowX,
          }
        },
      )
      const longCell = [...table.querySelectorAll('td')].find((n) =>
        n.textContent.includes('longer description'),
      )
      const numeric = [...table.querySelectorAll('td')].find((n) =>
        n.textContent.includes('$180'),
      )

      // Inline code.
      const codes = [...document.querySelectorAll('.aui-md code:not(pre code)')]
      const identifier = codes.find((n) =>
        n.textContent.startsWith('src/components/assistant-ui'),
      )
      const inEmphasis = long.querySelector('em code')
      const lineOf = (node) => px(style(node.closest('p, li')).lineHeight)
      const inline = codes.map((node) => {
        const s = style(node)
        const rects = [...node.getClientRects()]
        return {
          text: node.textContent.slice(0, 40),
          display: s.display,
          weight: Number(s.fontWeight),
          color: s.color,
          parentColor: style(node.parentElement).color,
          background: s.backgroundColor,
          diagnostic: node.hasAttribute('data-diagnostic'),
          tallest: Math.max(...rects.map((r) => r.height)),
          line: lineOf(node),
          lines: rects.length,
        }
      })
      const scrollWidth = document.documentElement.scrollWidth
      return {
        H,
        humanBlocks: humanVoice,
        humanMath,
        humanPrice,
        transitions,
        listGaps,
        nestedGaps,
        looseInnerGap,
        firstShift,
        table: {
          td: font(td),
          th: font(th),
          thLink: thLink
            ? {
                color: style(thLink).color,
                pair: thLink.getAttribute('data-appearance-pair'),
              }
            : null,
          tdWhiteSpace: style(td).whiteSpace,
          longCellLines: longCell
            ? Math.round(
                longCell.getBoundingClientRect().height /
                  px(style(longCell).lineHeight),
              )
            : 0,
          numericVariant: numeric ? style(numeric).fontVariantNumeric : '',
          numericAlign: numeric ? style(numeric).textAlign : '',
          rowBackground: style(table.querySelector('tbody tr')).backgroundColor,
        },
        tables,
        inline,
        identifier: identifier
          ? {
              text: identifier.textContent,
              diagnostic: identifier.hasAttribute('data-diagnostic'),
              display: style(identifier).display,
            }
          : null,
        inEmphasis: inEmphasis
          ? {
              weight: Number(style(inEmphasis).fontWeight),
              style: style(inEmphasis).fontStyle,
            }
          : null,
        math: {
          inline: long.querySelectorAll('.katex').length,
          display: long.querySelectorAll('.katex-display').length,
          mathml: long.querySelectorAll('.katex-mathml math').length,
        },
        mermaid: Boolean(long.querySelector('[data-aui-mermaid-svg] svg')),
        scrollWidth,
        innerWidth,
      }
    }, RHYTHM)

    // A static reading table does not light up under the pointer.
    const row = page
      .locator('[data-appearance-fixture="F12"] .aui-md-table tbody tr')
      .first()
    await row.hover()
    const hovered = await row.evaluate(
      (n) => getComputedStyle(n).backgroundColor,
    )

    const scale = c.overrides.scales?.content ?? 1
    const near = (a, b, t = 0.75) => Math.abs(a - b) <= t
    const checks = [
      {
        id: 'human-voice',
        authority: 'contract',
        passed:
          measured.humanBlocks.length > 0 &&
          measured.humanBlocks.every(
            (b) =>
              b.family.startsWith('Manrope') &&
              (/^H/.test(b.tag) ||
                (near(b.size, 16 * scale, 0.25) &&
                  near(b.lineHeight, 26 * scale, 0.5))),
          ),
      },
      {
        id: 'human-math',
        authority: 'contract',
        passed: measured.humanMath && measured.humanPrice,
      },
      {
        id: 'prose-table-recipe',
        authority: 'contract',
        passed:
          near(measured.table.td.size, 16 * scale, 0.3) &&
          near(measured.table.td.lineHeight, 24 * scale, 0.75) &&
          measured.table.th.weight === 500 &&
          near(measured.table.th.size, 16 * scale, 0.3),
      },
      {
        id: 'prose-table-wraps',
        authority: 'contract',
        passed:
          measured.table.tdWhiteSpace === 'normal' &&
          measured.table.longCellLines >= 2,
      },
      {
        id: 'prose-table-numeric',
        authority: 'contract',
        passed:
          measured.table.numericVariant.includes('tabular-nums') &&
          ['right', 'end'].includes(measured.table.numericAlign),
      },
      {
        id: 'prose-table-no-hover',
        authority: 'contract',
        passed: hovered === measured.table.rowBackground,
      },
      {
        id: 'prose-table-opaque',
        authority: 'contract',
        passed: measured.tables.every(
          (t) => !/rgba\(.*, 0\)|transparent/.test(t.background),
        ),
      },
      {
        id: 'wide-table-local-scroll',
        authority: 'contract',
        passed:
          measured.tables.every(
            (t) =>
              t.wrapperWidth <= t.columnWidth + 1 &&
              (t.scrollWidth <= t.clientWidth ||
                /auto|scroll/.test(t.overflowX)),
          ) && measured.scrollWidth <= measured.innerWidth,
      },
      {
        id: 'rhythm',
        authority: 'target',
        passed:
          measured.transitions.length >= 8 &&
          measured.transitions.every((t) => near(t.gap, t.expected, 1)),
      },
      {
        id: 'rhythm-lists',
        authority: 'target',
        passed:
          measured.listGaps.every((g) =>
            near(g, RHYTHM.listItem * measured.H, 1),
          ) &&
          measured.nestedGaps.every(
            (g) => g <= RHYTHM.listItem * measured.H + 1,
          ) &&
          measured.looseInnerGap !== null &&
          near(measured.looseInnerGap, RHYTHM.paragraph * measured.H, 1),
      },
      {
        id: 'rhythm-first-block',
        authority: 'contract',
        passed: measured.firstShift.every((m) => m === 0),
      },
      {
        id: 'inline-code-quiet',
        authority: 'contract',
        passed:
          measured.inline.length > 0 &&
          measured.inline.every(
            (n) =>
              n.weight === 400 &&
              n.display === 'inline' &&
              n.tallest <= n.line + 0.5,
          ),
      },
      {
        id: 'inline-code-long-stays-inline',
        authority: 'contract',
        passed:
          Boolean(measured.identifier) &&
          !measured.identifier.diagnostic &&
          measured.identifier.display === 'inline' &&
          measured.identifier.text ===
            'src/components/assistant-ui/elements/markdown-text.tsx:defaultComponents.code.isCodeBlock.fallback',
      },
      {
        id: 'math',
        authority: 'contract',
        passed:
          measured.math.inline >= 2 &&
          measured.math.display === 1 &&
          measured.math.mathml >= 2,
      },
      { id: 'mermaid', authority: 'contract', passed: measured.mermaid },
    ]
    if (capture)
      await page
        .locator(
          '[data-appearance-fixture="F12"] .aui-thread-viewport, [data-appearance-fixture="F12"]',
        )
        .first()
        .screenshot({ path: resolve(capture, `${c.id}.png`) })
    results.push({
      case: c,
      errors,
      passed: errors.length === 0 && checks.every((k) => k.passed),
      checks,
      hovered,
      ...measured,
    })
    await page.close()
  }
  await writeFile(
    resolve(reviewOutput, 'chromium-markdown-typography.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        engine: browser.version(),
        results,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify(
      results.map((r) => ({
        case: r.case.id,
        errors: r.errors,
        failed: r.checks.filter((k) => !k.passed).map((k) => k.id),
      })),
      null,
      2,
    ),
  )
  if (results.some((r) => !r.passed)) process.exitCode = 1
} finally {
  await browser.close()
}
