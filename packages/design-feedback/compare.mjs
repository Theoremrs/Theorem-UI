import { readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compareGeometry } from './core.mjs'
import { prepareOutput } from './capture.mjs'
import { writeJSON, writeComparisonReport } from './report.mjs'
import { dependency } from './dependencies.mjs'
import { createHash } from 'node:crypto'

const ENVIRONMENT_KEYS = ['engine', 'engineVersion', 'platform', 'arch', 'locale', 'timezone', 'animationPolicy', 'screenshotScope', 'colorScheme', 'reducedMotion']

export function compareCaptureConditions(before, after) {
  const reasons = []
  for (const key of ENVIRONMENT_KEYS) {
    if (before?.[key] === undefined || after?.[key] === undefined) reasons.push(`Missing capture condition: ${key}`)
    else if (before[key] !== after[key]) reasons.push(`${key} differs: ${before[key]} → ${after[key]}`)
  }
  for (const key of ['width', 'height', 'dpr']) {
    if (!Number.isFinite(before?.viewport?.[key]) || !Number.isFinite(after?.viewport?.[key])) reasons.push(`Missing viewport condition: ${key}`)
    else if (before.viewport[key] !== after.viewport[key]) reasons.push(`Viewport ${key} differs: ${before.viewport[key]} → ${after.viewport[key]}`)
  }
  for (const key of ['x', 'y']) {
    if (!Number.isFinite(before?.scroll?.[key]) || !Number.isFinite(after?.scroll?.[key])) reasons.push(`Missing scroll condition: ${key}`)
    else if (before.scroll[key] !== after.scroll[key]) reasons.push(`Scroll ${key} differs: ${before.scroll[key]} → ${after.scroll[key]}`)
  }
  for (const [label, capture] of [['Before', before], ['After', after]]) {
    if (!capture?.readiness?.fontsReady) reasons.push(`${label} font loading was not confirmed complete`)
    if (capture?.readiness?.layoutStableDuringScreenshot !== true) reasons.push(`${label} DOM stability during the screenshot was not confirmed`)
    if (capture?.motionBeforeFreeze?.unsettled) reasons.push(`${label} animations could not be settled`)
    if (capture?.readiness?.pendingImages || capture?.readiness?.failedImages) reasons.push(`${label} images were pending or failed during capture`)
  }
  return { compatible: reasons.length === 0, reasons }
}

/** Compare PNG buffers without resampling, registration, or hiding displacement. */
export async function comparePNGs(beforeBuffer, afterBuffer, options = {}) {
  for (const buffer of [beforeBuffer, afterBuffer]) {
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Comparison requires PNG images')
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
    if (width === 0 || height === 0 || width * height > 20000000) throw new Error('Comparison exceeds the 20 million pixel limit or has invalid dimensions')
  }
  const { PNG } = await dependency('pngjs')
  const { default: pixelmatch } = await dependency('pixelmatch')
  const before = PNG.sync.read(beforeBuffer)
  const after = PNG.sync.read(afterBuffer)
  const threshold = options.threshold === undefined ? 0.1 : Number(options.threshold)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Pixel threshold must be from 0 to 1')
  const dimensions = { before: { width: before.width, height: before.height }, after: { width: after.width, height: after.height } }
  if (before.width !== after.width || before.height !== after.height) return { compatible: false, reason: 'PNG dimensions differ; images were not resized or aligned.', dimensions }
  const { width, height } = before
  if (width * height > 20000000) throw new Error('Comparison exceeds the 20 million pixel limit')
  const mask = new PNG({ width, height })
  const heatmap = new PNG({ width, height })
  const rawDiff = new PNG({ width, height })
  const changedPixels = pixelmatch(before.data, after.data, mask.data, width, height, { threshold, includeAA: false, diffMask: true, diffColor: [220, 0, 140] })
  let exactChangedPixels = 0
  for (let offset = 0; offset < before.data.length; offset += 4) {
    const exact = before.data[offset] !== after.data[offset] || before.data[offset + 1] !== after.data[offset + 1] || before.data[offset + 2] !== after.data[offset + 2] || before.data[offset + 3] !== after.data[offset + 3]
    if (exact) exactChangedPixels++
    const shade = Math.round(205 + (after.data[offset] * 0.2126 + after.data[offset + 1] * 0.7152 + after.data[offset + 2] * 0.0722) * 0.196)
    heatmap.data[offset] = mask.data[offset + 3] ? 220 : shade
    heatmap.data[offset + 1] = mask.data[offset + 3] ? 0 : shade
    heatmap.data[offset + 2] = mask.data[offset + 3] ? 140 : shade
    heatmap.data[offset + 3] = 255
    rawDiff.data[offset] = exact ? 220 : shade
    rawDiff.data[offset + 1] = exact ? 0 : shade
    rawDiff.data[offset + 2] = exact ? 140 : shade
    rawDiff.data[offset + 3] = 255
  }
  const gap = 8
  const collage = new PNG({ width: width * 3 + gap * 2, height })
  collage.data.fill(255)
  for (const [index, source] of [before, after, heatmap].entries()) {
    for (let y = 0; y < height; y++) source.data.copy(collage.data, ((y * collage.width) + index * (width + gap)) * 4, y * width * 4, (y + 1) * width * 4)
  }
  return {
    compatible: true, dimensions,
    metrics: { width, height, totalPixels: width * height, exactChangedPixels, exactChangedFraction: exactChangedPixels / (width * height), perceptualChangedPixels: changedPixels, perceptualChangedFraction: changedPixels / (width * height), threshold, algorithm: 'pixelmatch', antialiasDifferencesIncluded: false, interpretation: 'Thresholded pixel differences, not a regression count or design-quality score.' },
    heatmap: PNG.sync.write(heatmap), rawDiff: PNG.sync.write(rawDiff), collage: PNG.sync.write(collage),
  }
}

export async function compareCaptures(beforeDirectory, afterDirectory, options = {}) {
  if (options.out && [resolve(beforeDirectory), resolve(afterDirectory)].includes(resolve(options.out))) throw new Error('Comparison output must be separate from both capture directories')
  await prepareOutput(options.out, 'comparison.json', options.overwrite)
  if (options.overwrite) for (const file of ['before.png', 'after.png', 'heatmap.png', 'raw-diff.png', 'collage.png']) await rm(join(options.out, file), { force: true })
  const [beforeCapture, afterCapture, beforeObservationJSON, afterObservationJSON, beforeImage, afterImage] = await Promise.all([
    readFile(join(beforeDirectory, 'capture.json'), 'utf8').then(JSON.parse), readFile(join(afterDirectory, 'capture.json'), 'utf8').then(JSON.parse),
    readFile(join(beforeDirectory, 'observations.json'), 'utf8'), readFile(join(afterDirectory, 'observations.json'), 'utf8'),
    readFile(join(beforeDirectory, 'screenshot.png')), readFile(join(afterDirectory, 'screenshot.png')),
  ])
  const beforeObservation = JSON.parse(beforeObservationJSON)
  const afterObservation = JSON.parse(afterObservationJSON)
  const compatibility = compareCaptureConditions(beforeCapture, afterCapture)
  for (const [label, capture, observation, observationJSON, screenshot] of [['Before', beforeCapture, beforeObservation, beforeObservationJSON, beforeImage], ['After', afterCapture, afterObservation, afterObservationJSON, afterImage]]) {
    if (capture.schemaVersion !== 'design-feedback/v1' || capture.id !== observation.capture?.id) compatibility.reasons.push(`${label} capture metadata does not match its observation identity`)
    for (const key of [...ENVIRONMENT_KEYS, 'viewport', 'scroll']) {
      if (JSON.stringify(capture[key]) !== JSON.stringify(observation.capture?.[key])) compatibility.reasons.push(`${label} ${key} metadata differs from its observations`)
    }
    if (capture.observationsSHA256 !== createHash('sha256').update(observationJSON).digest('hex')) compatibility.reasons.push(`${label} observation hash does not match its capture metadata`)
    if (capture.screenshotSHA256 !== createHash('sha256').update(screenshot).digest('hex')) compatibility.reasons.push(`${label} screenshot hash does not match its capture metadata`)
    if (screenshot.length < 24 || screenshot.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') compatibility.reasons.push(`${label} screenshot is not a PNG`)
    else {
      const width = screenshot.readUInt32BE(16), height = screenshot.readUInt32BE(20)
      if (width !== capture.screenshotDimensions?.width || height !== capture.screenshotDimensions?.height) compatibility.reasons.push(`${label} PNG dimensions do not match its metadata`)
      if (Math.abs(width - (capture.viewport?.width * capture.viewport?.dpr)) > 1 || Math.abs(height - (capture.viewport?.height * capture.viewport?.dpr)) > 1) compatibility.reasons.push(`${label} PNG dimensions do not match viewport and DPR`)
    }
  }
  compatibility.compatible = compatibility.reasons.length === 0
  const geometry = compareGeometry(beforeObservation, afterObservation)
  const result = {
    schemaVersion: 'design-feedback/v1', kind: 'comparison', beforeCaptureId: beforeCapture.id, afterCaptureId: afterCapture.id,
    compatibility, geometry, pixels: null,
    coverage: { before: beforeObservation.coverage, after: afterObservation.coverage, limitations: ['Only viewport pixels are compared.', 'Selector-based identities may change after DOM reordering; explicit data-design-id values improve matching.', 'Font-loading completion does not prove identical font files or rasterization across hosts.', 'No interaction or visual-quality verdict is inferred from a difference.'] },
  }
  if (compatibility.compatible) {
    const compared = await comparePNGs(beforeImage, afterImage, options)
    if (compared.compatible) {
      result.pixels = compared.metrics
      result.images = { before: 'before.png', after: 'after.png', heatmap: 'heatmap.png', rawDiff: 'raw-diff.png', collage: 'collage.png' }
      await writeFile(join(options.out, 'before.png'), beforeImage)
      await writeFile(join(options.out, 'after.png'), afterImage)
      await writeFile(join(options.out, 'heatmap.png'), compared.heatmap)
      await writeFile(join(options.out, 'raw-diff.png'), compared.rawDiff)
      await writeFile(join(options.out, 'collage.png'), compared.collage)
    } else {
      compatibility.compatible = false
      compatibility.reasons.push(compared.reason)
      result.pixels = { dimensions: compared.dimensions }
    }
  }
  await writeJSON(join(options.out, 'comparison.json'), result)
  await writeComparisonReport(options.out, result)
  return result
}
