// Key-to-paint latency for the real ComposerEditor in Chromium, at several
// draft sizes. No Theorem server and no model call: the same in-memory runtime
// the composer contract page uses, so the measured cost is the editor's own.
//
//   node scripts/e2e/composer-latency.mjs
//   node scripts/e2e/composer-latency.mjs --built
//
// Keys are pressed by the browser, not synthesized in the page.
//   handler      synchronous main-thread work from keydown to the editor's
//                input event.
//   toNextFrame  keydown to the next animation-frame callback. That callback
//                runs BEFORE the frame paints, so this is not a paint time.
//   afterPaint   keydown to the callback on the FOLLOWING frame. The first
//                frame has been laid out, drawn and presented by then, so
//                this bounds the key's visible effect from above.
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
    // Meta+A selects all only on macOS. Chromium on Linux and Windows keeps
    // the "First paragraph" fixture and inserts the draft after it; a length
    // check then accepts the oversized text and reports it as this size.
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(draft)
    try {
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="draft"]')?.textContent ===
          expected,
        draft,
      )
    } catch (error) {
      const shown = await page.locator('[data-testid="draft"]').textContent()
      const fixture = shown?.includes('First paragraph')
        ? ' and still contains the fixture'
        : ''
      throw new Error(
        `chars=${size}: draft is ${shown?.length ?? 0} chars${fixture}, expected ${draft.length}`,
        { cause: error },
      )
    }
    await page.keyboard.press('End')
    // Let the paste's own work and Milkdown's debounced listener settle, so
    // the window under test holds only single keystrokes.
    await page.waitForTimeout(400)

    // Measure the synchronous work each key blocks the main thread for, and
    // how long until its effect has been painted. Event Timing coalesces
    // entries, so the cost is read directly around the browser's own
    // dispatch: a window keydown listener records the start, and an input
    // listener that runs after the editor's own handlers records the end.
    await page.evaluate(() => {
      // One set of listeners for the whole run, installed once. Installing
      // them per draft size left every earlier size's listeners attached and
      // writing to the same array, so later sizes recorded several samples
      // per key and the last-KEYS window covered only the final few keys.
      window.__samples = []
      window.__longTasks = []
      if (window.__installed) return
      window.__installed = true
      // Each key owns its own start and handler delta. A shared variable is
      // overwritten by the next key before this key's second frame callback
      // runs, which produced negative and collapsed intervals.
      let current
      // Bubble phase on the window runs after ProseMirror's own handler.
      window.addEventListener('keydown', (event) => {
        if (event.key.length !== 1) return
        const sample = { started: performance.now(), handler: 0 }
        current = sample
        // The frame callback runs before this frame paints. A second
        // callback, requested from inside the first, runs on the following
        // frame, so by then the first frame's paint has been presented.
        requestAnimationFrame(() => {
          const afterCallback = performance.now()
          requestAnimationFrame(() => {
            window.__samples.push({
              handler: sample.handler,
              toNextFrame: afterCallback - sample.started,
              afterPaint: performance.now() - sample.started,
            })
          })
        })
      })
      document.addEventListener('input', (event) => {
        if (!event.target?.closest?.('.ProseMirror') || !current) return
        current.handler = performance.now() - current.started
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
      const samples = window.__samples
      const longTasks = window.__longTasks
      window.__samples = []
      window.__longTasks = []
      return { samples, longTasks }
    })
    if (measured.samples.length !== KEYS)
      throw new Error(
        `chars=${size}: expected ${KEYS} samples, collected ${measured.samples.length}`,
      )
    // Every interval must be positive and ordered; a shared-state race shows
    // up here as a negative or collapsed value rather than a plausible number.
    for (const sample of measured.samples)
      if (
        !(sample.handler >= 0) ||
        !(sample.toNextFrame > 0) ||
        !(sample.afterPaint >= sample.toNextFrame)
      )
        throw new Error(
          `chars=${size}: impossible interval ${JSON.stringify(sample)}`,
        )
    const samples = measured.samples
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
      toNextFrameP50: round(
        percentile(
          samples.map((e) => e.toNextFrame),
          0.5,
        ),
      ),
      afterPaintP50: round(
        percentile(
          samples.map((e) => e.afterPaint),
          0.5,
        ),
      ),
      toNextFrameP95: round(
        percentile(
          samples.map((e) => e.toNextFrame),
          0.95,
        ),
      ),
      afterPaintP95: round(
        percentile(
          samples.map((e) => e.afterPaint),
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
  'handler = sync work per input; toNextFrame = to the frame callback (pre-paint); afterPaint = to the next frame, after that paint',
)
for (const row of rows)
  console.log(
    `chars=${row.chars} keys=${row.keys} handlerP50=${row.handlerP50} handlerP95=${row.handlerP95} toNextFrameP50=${row.toNextFrameP50} afterPaintP50=${row.afterPaintP50} afterPaintP95=${row.afterPaintP95} longTasks=${row.longTasks}`,
  )
