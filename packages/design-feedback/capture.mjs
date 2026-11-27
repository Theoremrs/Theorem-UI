import { randomUUID, createHash } from 'node:crypto'
import { mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { collectDesignObservations } from './collect.mjs'
import { inspectDesign } from './core.mjs'
import { writeJSON, writeCaptureReport } from './report.mjs'
import { dependency } from './dependencies.mjs'

export function redactURL(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]')
    url.hash = ''
    return url.href
  } catch { return '[unavailable URL]' }
}

function boundedNumber(value, fallback, name, min, max, integer = false) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`)
  return number
}

export function normalizeCaptureOptions(options = {}) {
  const engine = options.engine ?? 'chromium'
  const colorScheme = options.colorScheme ?? 'light'
  const reducedMotion = options.reducedMotion ?? 'reduce'
  if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('engine must be chromium, firefox, or webkit')
  if (!['light', 'dark'].includes(colorScheme)) throw new Error('color scheme must be light or dark')
  if (!['reduce', 'no-preference'].includes(reducedMotion)) throw new Error('reduced motion must be reduce or no-preference')
  const normalized = {
    ...options, engine, colorScheme, reducedMotion,
    width: boundedNumber(options.width, 1440, 'width', 240, 8192, true),
    height: boundedNumber(options.height, 900, 'height', 240, 8192, true),
    dpr: boundedNumber(options.dpr, 1, 'dpr', 0.5, 3),
    timeout: boundedNumber(options.timeout, 15000, 'timeout', 1000, 120000, true),
    settleMs: boundedNumber(options.settleMs, 100, 'settle-ms', 0, 5000, true),
    maxElements: boundedNumber(options.maxElements, 1000, 'max-elements', 1, 5000, true),
    noSandbox: options.noSandbox === true,
  }
  if (normalized.width * normalized.height * normalized.dpr ** 2 > 20000000) throw new Error('Capture exceeds the 20 million pixel limit')
  return normalized
}

export function validateCaptureURL(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Capture requires an absolute http:, https:, or file: URL') }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('Capture supports only http:, https:, and file: URLs')
  if (url.username || url.password) throw new Error('Do not put credentials in capture URLs')
  return url.href
}

export async function prepareOutput(out, marker = 'capture.json', overwrite = false) {
  if (!out) throw new Error('An output directory is required')
  if (!overwrite) {
    const protectedFiles = {
      'capture.json': ['capture.json', 'observations.json', 'findings.json', 'screenshot.png', 'report.html'],
      'comparison.json': ['comparison.json', 'before.png', 'after.png', 'heatmap.png', 'raw-diff.png', 'collage.png', 'report.html'],
      'probes.json': ['probes.json', 'report.html', 'baseline', 'narrow', 'text-spacing', 'reduced-motion'],
    }[marker] ?? [marker]
    for (const file of protectedFiles) {
      try { await access(join(out, file)); throw new Error(`Output already contains ${file}; choose a new directory or pass --overwrite`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  await mkdir(out, { recursive: true })
}

export async function launchCaptureBrowser(input = {}) {
  const options = normalizeCaptureOptions(input)
  const loaded = await dependency('playwright-core')
  const playwright = loaded.chromium ? loaded : loaded.default
  const launchOptions = { headless: true, ...(options.executablePath ? { executablePath: options.executablePath } : {}) }
  if (options.engine === 'chromium') launchOptions.chromiumSandbox = !options.noSandbox
  if (options.noSandbox && options.engine !== 'chromium') throw new Error('--no-sandbox is supported only for Chromium')
  const browser = await playwright[options.engine].launch(launchOptions)
  return { browser, options }
}

export async function openCapturePage(browser, input = {}) {
  const options = normalizeCaptureOptions(input)
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: options.dpr, colorScheme: options.colorScheme, reducedMotion: options.reducedMotion, locale: 'en-US', timezoneId: 'UTC' })
  const page = await context.newPage()
  page.setDefaultTimeout(options.timeout)
  page.setDefaultNavigationTimeout(options.timeout)
  return { context, page }
}

export async function settlePage(page, options) {
  if (options.readySelector) await page.locator(options.readySelector).first().waitFor({ state: 'visible', timeout: options.timeout })
  if (options.settleMs) await page.waitForTimeout(options.settleMs)
  const readiness = await page.evaluate(async (timeout) => {
    let timer
    const fontsReady = await Promise.race([document.fonts.ready.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout) })])
    clearTimeout(timer)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { fontsReady, fontsStatus: document.fonts.status, pendingImages: [...document.images].filter((image) => !image.complete).length, failedImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length }
  }, Math.min(options.timeout, 5000))
  return readiness
}

/** Capture the actual browser viewport. The caller owns page/context lifetime. */
export async function capturePage(page, browser, input = {}) {
  const options = normalizeCaptureOptions(input)
  await prepareOutput(options.out, 'capture.json', options.overwrite)
  const readiness = await settlePage(page, options)
  await page.addStyleTag({ content: '*,*::before,*::after{caret-color:transparent!important}' })
  const motionBeforeFreeze = await page.evaluate(async () => {
    const initial = document.getAnimations()
    const seen = new Set()
    const failed = new Set()
    let settlementPasses = 0
    const active = (animation) => animation.pending || animation.playState === 'running'
    const initialRunning = initial.filter(active).length
    for (; settlementPasses < 8; settlementPasses++) {
      for (const animation of document.getAnimations()) {
        if (!active(animation) && (seen.has(animation) || animation.playState === 'finished' || animation.playState === 'idle')) continue
        seen.add(animation)
        try {
          const end = animation.effect?.getComputedTiming().endTime
          if (typeof end === 'number' && Number.isFinite(end)) animation.finish()
          else { animation.pause(); animation.currentTime = 0 }
        } catch { failed.add(animation) }
      }
      // Finishing an animation queues events; their handlers may create more.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!document.getAnimations().some(active)) { settlementPasses++; break }
    }
    return {
      animations: initial.length,
      running: initialRunning,
      animationsSeen: seen.size,
      settlementPasses,
      unsettled: failed.size + document.getAnimations().filter(active).length,
    }
  })
  const id = randomUUID()
  const observation = await page.evaluate(collectDesignObservations, { captureId: id, evidenceKind: 'rendered-web', maxElements: options.maxElements })
  const policy = options.policy ?? {}
  observation.capture = {
    ...observation.capture, id, url: redactURL(page.url()),
    engine: options.engine, engineVersion: browser.version(), platform: process.platform, arch: process.arch,
    locale: 'en-US', timezone: 'UTC', animationPolicy: 'finish-finite-pause-infinite-at-zero',
    readiness, motionBeforeFreeze, screenshotScope: 'viewport',
    label: options.label ?? null, sourceRevision: options.sourceRevision ?? null,
    policySHA256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  }
  if (!readiness.fontsReady) observation.coverage.limitations.push('Font loading did not finish within the capture deadline.')
  if (readiness.pendingImages || readiness.failedImages) observation.coverage.limitations.push(`Images pending: ${readiness.pendingImages}; failed: ${readiness.failedImages}.`)
  observation.coverage.limitations.push('Finite animations were finished and infinite animations paused at time zero for a static viewport capture; motion behavior was not validated.')
  if (motionBeforeFreeze.unsettled) observation.coverage.limitations.push(`${motionBeforeFreeze.unsettled} animations could not be settled.`)
  const screenshot = await page.screenshot({ path: join(options.out, 'screenshot.png'), fullPage: false, animations: 'allow', caret: 'hide', scale: 'device' })
  const afterScreenshot = await page.evaluate(collectDesignObservations, { captureId: id, evidenceKind: 'rendered-web', maxElements: options.maxElements })
  motionBeforeFreeze.activeAfterScreenshot = await page.evaluate(() => document.getAnimations().filter((animation) => animation.pending || animation.playState === 'running').length)
  if (motionBeforeFreeze.activeAfterScreenshot) {
    motionBeforeFreeze.unsettled = Math.max(motionBeforeFreeze.unsettled, motionBeforeFreeze.activeAfterScreenshot)
    observation.coverage.limitations.push('Animations were active after the screenshot; capture conditions are not stable for a pixel comparison.')
  }
  const signature = (value) => JSON.stringify({
    viewport: value.capture.viewport, scroll: value.capture.scroll, document: value.capture.document,
    elements: value.elements.map(({ id: elementId, rect, text }) => ({ id: elementId, rect, text })),
  })
  readiness.layoutStableDuringScreenshot = signature(observation) === signature(afterScreenshot)
  if (!readiness.layoutStableDuringScreenshot) observation.coverage.limitations.push('Measured DOM properties changed during the screenshot; repeat with an explicit settled state before comparing.')
  observation.capture.screenshotSHA256 = createHash('sha256').update(screenshot).digest('hex')
  observation.capture.screenshotDimensions = { width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) }
  observation.coverage.limitations.push('DOM collection and screenshot capture are sequential, not atomic; canvas and video pixels can change without a DOM geometry change.')
  const result = inspectDesign(observation, policy)
  const observationsSHA256 = createHash('sha256').update(`${JSON.stringify(observation, null, 2)}\n`).digest('hex')
  const capture = { schemaVersion: 'design-feedback/v1', ...observation.capture, observationsSHA256, files: { screenshot: 'screenshot.png', observations: 'observations.json', findings: 'findings.json', report: 'report.html' } }
  await writeJSON(join(options.out, 'observations.json'), observation)
  await writeJSON(join(options.out, 'findings.json'), result)
  await writeJSON(join(options.out, 'capture.json'), capture)
  await writeCaptureReport(options.out, observation, result)
  return { capture, observation, result }
}

export async function captureURL(url, input = {}) {
  const target = validateCaptureURL(url)
  const options = normalizeCaptureOptions(input)
  await prepareOutput(options.out, 'capture.json', options.overwrite)
  const { browser } = await launchCaptureBrowser(options)
  try {
    const { page } = await openCapturePage(browser, options)
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    return await capturePage(page, browser, options)
  } finally { await browser.close() }
}
