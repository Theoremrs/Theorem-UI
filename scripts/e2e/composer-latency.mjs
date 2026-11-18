// Key-to-paint latency for the real ComposerEditor in Chromium, at several
// draft sizes. No Theorem server and no model call: the same in-memory runtime
// the composer contract page uses, so the measured cost is the editor's own.
//
//   node scripts/e2e/composer-latency.mjs
//   node scripts/e2e/composer-latency.mjs --built
//
// Keys are pressed by the browser, not synthesized in the page. `handler` is
// the synchronous main-thread work between the keydown and the editor's input
// event; `toPaint` is that keydown to the next presented animation frame.
// Long tasks are collected separately so a stall is a number, not an impression.
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'

const SIZES = [200, 20000, 100000, 300000]
const KEYS = 30

const percentile = (values, fraction) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]
}
const round = (value) => +value.toFixed(2)

const served = await servePage('composer')
let browser
const rows = []
try {
  browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM || undefined,
  })
  const page = await browser.newPage()
  await page.goto(served.url)
  const input = page.getByRole('textbox', { name: 'Message input' })
  await input.waitFor()

  for (const size of SIZES) {
    const draft = 'lorem ipsum dolor sit amet '
      .repeat(Math.ceil(size / 27))
      .slice(0, size)
    await page.getByRole('button', { name: 'Load Plain', exact: true }).click()
    await input.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.insertText(draft)
    await page.waitForFunction(
      (length) =>
        (document.querySelector('[data-testid="draft"]')?.textContent?.length ??
          0) >= length,
      size,
    )
    await page.keyboard.press('End')
    // Let the paste's own work and Milkdown's debounced listener settle, so
    // the window under test holds only single keystrokes.
    await page.waitForTimeout(400)

    // Measure the synchronous work each key blocks the main thread for, and
    // the delay from that key to the next presented frame. Event Timing
    // coalesces entries, so the handler cost is read directly around the
    // browser's own dispatch: a keydown listener records the start, and a
    // capture-phase listener that runs after the editor's own handlers records
    // the end. The paint is the next requestAnimationFrame timestamp.
    await page.evaluate(() => {
      window.__samples = []
      window.__longTasks = []
      const target = document.querySelector('.ProseMirror')
      let started = 0
      // Bubble phase on the window runs after ProseMirror's own handler.
      window.addEventListener('keydown', (event) => {
        if (event.key.length !== 1) return
        started = performance.now()
        requestAnimationFrame((timestamp) => {
          window.__samples.push({
            handler: window.__handler ?? 0,
            toPaint: Math.max(timestamp, performance.now()) - started,
          })
        })
      })
      target.addEventListener('input', () => {
        window.__handler = performance.now() - started
      })
      window.__tasks_observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__longTasks.push(Math.round(entry.duration))
      })
      window.__tasks_observer.observe({ entryTypes: ['longtask'] })
    })

    for (let index = 0; index < KEYS; index++) {
      await page.keyboard.press('x')
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(200)

    const measured = await page.evaluate(() => {
      window.__tasks_observer.disconnect()
      return { samples: window.__samples, longTasks: window.__longTasks }
    })
    const samples = measured.samples.slice(-KEYS)
    rows.push({
      chars: size,
      keys: samples.length,
      handlerP50: round(
        percentile(
          samples.map((e) => e.handler),
          0.5,
        ),
      ),
      handlerP95: round(
        percentile(
          samples.map((e) => e.handler),
          0.95,
        ),
      ),
      toPaintP50: round(
        percentile(
          samples.map((e) => e.toPaint),
          0.5,
        ),
      ),
      toPaintP95: round(
        percentile(
          samples.map((e) => e.toPaint),
          0.95,
        ),
      ),
      longTasks: measured.longTasks.length,
    })
  }
} finally {
  await browser?.close()
  await served.close()
}

console.log('real Chromium, idle machine')
console.log(
  'handler = synchronous main-thread work per input; toPaint = keydown to presented frame',
)
for (const row of rows)
  console.log(
    `chars=${row.chars} keys=${row.keys} handlerP50=${row.handlerP50} handlerP95=${row.handlerP95} toPaintP50=${row.toPaintP50} toPaintP95=${row.toPaintP95} longTasks=${row.longTasks}`,
  )
