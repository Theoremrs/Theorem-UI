// SOURCING: none — interaction scenarios for the interactive-responses stories (src/stories/fixtures/responses.ts), in the same shape story-oracle-features.mjs uses: the shared oracle hands over its helpers, page.keyboard does every press, and page.evaluate only reads. The claims are the plan's O4: the citation inspector opens the exact passage by keyboard, Add to context puts a durable reference in the composer, and the chart's Data view shows the same values as its plot.

export function scenarios(h) {
  const { snap } = h
  /** The whole document's text (these stories are the app thread, not a workbench grid). */
  const text = (page) => page.evaluate(() => document.body.innerText)
  const sees = async (page, needle, ms = 4000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if ((await text(page)).includes(needle)) return true
      await page.waitForTimeout(100)
    }
    return false
  }
  return {
    'settings-appearance': [
      // The per-role editors seed from the active palette, refuse a failing
      // contrast pair, and apply a valid edit as the custom palette.
      async (page) => {
        await page.waitForTimeout(800)
        const seeded = await page.evaluate(() => {
          const value = (label) =>
            document.querySelector(`input[aria-label="${label}"]`)?.value
          return (
            value('Canvas, light') === '#ffffff' &&
            value('Action, light') === '#8e454f' &&
            value('Insight, dark') !== ''
          )
        })
        await page.locator('input[aria-label="Action, light"]').fill('#f0f0f0')
        await page.locator('button:has-text("Apply colors")').click()
        await page.waitForTimeout(400)
        const refused = await page.evaluate(() =>
          (
            document.querySelector('[role="alert"]')?.textContent ?? ''
          ).includes('4.5:1'),
        )
        const stillDefault = await page.evaluate(
          () => document.documentElement.dataset.palette !== 'custom',
        )
        await page.locator('input[aria-label="Action, light"]').fill('#8e454f')
        await page.locator('button:has-text("Apply colors")').click()
        await page.waitForTimeout(400)
        const applied = await page.evaluate(
          () => document.documentElement.dataset.palette === 'custom',
        )
        await snap(page, 'settings-appearance-colors', 1024, 900)
        return {
          'editors seed from the active palette in both modes': seeded,
          'a failing contrast pair is refused with its reason': refused,
          'a refused edit paints nothing': stillDefault,
          'a valid edit applies as the custom palette': applied,
        }
      },
    ],
    'response-evidence': [
      // The resolved source draws a full link preview; the failed one stays
      // in the Sources row, whose dropdown opens by keyboard with the exact
      // passage and the source's actions.
      async (page) => {
        await page.waitForTimeout(600)
        const preview = page.locator('[data-slot="link-preview"]')
        const onePreview = (await preview.count()) === 1
        const previewTitle = await preview.first().textContent()
        const trigger = page.locator('button[aria-label="List sources"]')
        await trigger.focus()
        await page.keyboard.press('Enter')
        await page.waitForTimeout(500)
        // The failed source's own excerpt is in the dropdown; the resolved
        // source's passage lives on its preview card.
        const passage = await sees(
          page,
          'Week 46 summary: both retrieval paths improved',
        )
        const actions =
          (await sees(page, 'Open source')) &&
          (await sees(page, 'Add to context'))
        const link = await page.evaluate(() => {
          const a = [...document.querySelectorAll('a[href]')].find((x) =>
            x.textContent.includes('Open source'),
          )
          return a?.getAttribute('href')
        })
        await snap(page, 'response-evidence-sources', 1024, 900)
        return {
          'one source cited twice draws one preview': onePreview,
          'the preview names the source': (previewTitle ?? '').includes(
            'Retrieval latency notes',
          ),
          'keyboard opens the Sources dropdown with the exact passage': passage,
          'the dropdown offers Open source and Add to context': actions,
          'Open source goes to the source itself':
            link === 'https://reports.example.com/weekly/46',
        }
      },
      // Add to context from the dropdown: the passage becomes a composer
      // reference on the durable message, not pasted text.
      async (page) => {
        await page.waitForTimeout(600)
        await page.locator('button[aria-label="List sources"]').click()
        await page.waitForTimeout(500)
        // The dropdown's source entry carries the actions as buttons.
        await page
          .locator(
            '[data-slot="source-entry"] button:has-text("Add to context")',
          )
          .click()
        await page.waitForTimeout(400)
        const reference = await page.evaluate(() => {
          const list = document.querySelector('ul[aria-label="Context"]')
          return list?.textContent ?? ''
        })
        await snap(page, 'response-evidence-context', 1024, 900)
        return {
          'the composer carries the source as a reference': reference.includes(
            'Weekly performance report',
          ),
        }
      },
      // Exact passage inspection works on the successful preview path as well
      // as fallback. Keyboard dismissal returns to the invoking control.
      async (page) => {
        const trigger = page
          .getByRole('button', {
            name: /Read the supporting passage of Retrieval latency notes/,
          })
          .first()
        await trigger.focus()
        await page.keyboard.press('Enter')
        const passage = page
          .locator('blockquote')
          .filter({ hasText: 'Search p50 fell from 320ms' })
        await passage.waitFor({ state: 'visible' })
        const exact =
          (await passage.textContent()) ===
          'Search p50 fell from 320ms to 210ms between Tue and Mon; Read p50 fell from 180ms to 120ms over the same window. Ranking accounts for most of the difference.'
        await page.keyboard.press('Escape')
        await passage.waitFor({ state: 'hidden' })
        return {
          'a resolved preview retains its exact supporting passage': exact,
          'Escape returns passage focus to its trigger': await trigger.evaluate(
            (el) => el === document.activeElement,
          ),
        }
      },
      // Two sources from one assistant message are independent references.
      async (page) => {
        await page
          .getByRole('button', { name: 'Add to context', exact: true })
          .click()
        await page
          .getByRole('button', { name: 'List sources', exact: true })
          .click()
        await page
          .locator('[data-slot="source-entry"]')
          .getByRole('button', { name: 'Add to context', exact: true })
          .click()
        await page.keyboard.press('Escape')
        const context = page.locator('ul[aria-label="Context"]')
        await context.waitFor({ state: 'visible' })
        const before = await context.innerText()
        await page
          .getByRole('button', { name: 'Add to context', exact: true })
          .click()
        const after = await context.innerText()
        return {
          'distinct sources in one message both reach the composer':
            before.includes('Retrieval latency notes') &&
            before.includes('Weekly performance report'),
          'adding the same source again is idempotent': before === after,
        }
      },
      // Inspect, expand, change views and close using the same data and
      // selection. The dialog owns focus and restores the Expand trigger.
      async (page) => {
        // Rendering an earlier turn must not replace an estimated height
        // while the user moves from the composer to a response control.
        const prompt = page
          .locator('[data-slot="aui_user-message-root"]')
          .first()
        const promptHeight = await prompt.evaluate(
          (el) => el.getBoundingClientRect().height,
        )
        const chart = page.locator('[data-slot="evidence-chart"]').first()
        const inspector = chart.locator('[data-slot="chart-inspector"]')
        await inspector.focus()
        await page.keyboard.press('Home')
        await page.keyboard.press('ArrowRight')
        const selected = await chart
          .locator('[data-slot="chart-readout"]')
          .innerText()
        const expand = chart.getByRole('button', {
          name: 'Expand chart',
          exact: true,
        })
        await expand.click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor({ state: 'visible' })
        const expanded = await dialog
          .locator('[data-slot="chart-readout"]')
          .innerText()
        await dialog.getByRole('button', { name: 'Data', exact: true }).click()
        const data = await dialog
          .locator('[data-slot="evidence-chart-table"]')
          .innerText()
        const units = (await dialog.innerText()).includes('ms')
        const provenance = (await dialog.innerText()).includes(
          'Illustrative fixture data',
        )
        const viewport = page.viewportSize() ?? { width: 1024, height: 900 }
        await snap(
          page,
          'response-evidence-expanded',
          viewport.width,
          viewport.height,
        )
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        const restoredFocus = await expand.evaluate(
          (el) => el === document.activeElement,
        )
        const retainedView = await chart
          .locator('[data-slot="evidence-chart-table"]')
          .isVisible()
        await chart.getByRole('button', { name: 'Chart', exact: true }).click()
        const returned = await chart
          .locator('[data-slot="chart-readout"]')
          .innerText()
        const finalPromptHeight = await prompt.evaluate(
          (el) => el.getBoundingClientRect().height,
        )
        return {
          'chart navigation preserves the preceding message geometry':
            promptHeight > 0 && Math.abs(finalPromptHeight - promptHeight) < 1,
          'keyboard inspection reaches exact values with units':
            selected.includes('Search, Wed: 290 ms') &&
            selected.includes('Read, Wed: 170 ms'),
          'expansion retains the selected values': expanded === selected,
          'expanded Data retains original values and provenance':
            data.includes('290') && data.includes('170') && units && provenance,
          'closing preserves Data mode and restores focus':
            retainedView && restoredFocus,
          'returning to Chart retains point selection': returned === selected,
        }
      },
      // The chart's Data view: the same series as the plot, with units and provenance kept.
      async (page) => {
        await page.waitForTimeout(600)
        const plotted = await page.evaluate(
          () => !!document.querySelector('svg.evidence-chart-plot'),
        )
        await page
          .locator('[data-slot="evidence-chart"] button:has-text("Data")')
          .click()
        await page.waitForTimeout(400)
        const table = await page.evaluate(() => {
          const t = document.querySelector('[data-slot="evidence-chart-table"]')
          if (!t) return null
          return [...t.querySelectorAll('tbody tr')].map((row) =>
            [...row.querySelectorAll('td')].map((cell) => cell.textContent),
          )
        })
        const provenance = await sees(page, 'Illustrative fixture data')
        await snap(page, 'response-evidence-data', 1024, 900)
        const expected = [
          ['Tue', '320', '180'],
          ['Wed', '290', '170'],
          ['Thu', '305', '165'],
          ['Fri', '260', '150'],
          ['Sat', '240', '140'],
          ['Sun', '225', '135'],
          ['Mon', '210', '120'],
        ]
        return {
          'the chart plots first': plotted,
          "the Data view shows the plot's own values":
            JSON.stringify(table) === JSON.stringify(expected),
          'units and provenance stay visible': provenance,
        }
      },
    ],
  }
}
