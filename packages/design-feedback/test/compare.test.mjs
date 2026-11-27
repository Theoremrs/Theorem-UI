import test from 'node:test'
import assert from 'node:assert/strict'
import { comparePNGs, compareCaptureConditions } from '../compare.mjs'
import { dependency } from '../dependencies.mjs'

async function image(width = 8, height = 6, change) {
  const { PNG } = await dependency('pngjs')
  const png = new PNG({ width, height })
  png.data.fill(255)
  change?.(png)
  return PNG.sync.write(png)
}

test('identical PNGs report no exact or perceptual changes', async () => {
  const png = await image()
  const result = await comparePNGs(png, png)
  assert.equal(result.compatible, true)
  assert.equal(result.metrics.exactChangedPixels, 0)
  assert.equal(result.metrics.perceptualChangedPixels, 0)
  const { PNG } = await dependency('pngjs')
  const collage = PNG.sync.read(result.collage)
  assert.deepEqual([collage.width, collage.height], [40, 6])
})

test('solid changed region is counted and localized without resizing', async () => {
  const before = await image()
  const after = await image(8, 6, (png) => {
    for (let y = 1; y < 5; y++) for (let x = 2; x < 6; x++) {
      const offset = (y * png.width + x) * 4
      png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = 0
    }
  })
  const result = await comparePNGs(before, after, { threshold: 0.1 })
  assert.equal(result.metrics.exactChangedPixels, 16)
  assert.equal(result.metrics.perceptualChangedPixels, 16)
  const { PNG } = await dependency('pngjs')
  const heatmap = PNG.sync.read(result.heatmap)
  assert.deepEqual([...heatmap.data.subarray((2 * 8 + 3) * 4, (2 * 8 + 3) * 4 + 4)], [220, 0, 140, 255])
  const rawDiff = PNG.sync.read(result.rawDiff)
  assert.deepEqual([...rawDiff.data.subarray((2 * 8 + 3) * 4, (2 * 8 + 3) * 4 + 4)], [220, 0, 140, 255])
})

test('different image sizes are incompatible and produce no map', async () => {
  const result = await comparePNGs(await image(8, 6), await image(9, 6))
  assert.equal(result.compatible, false)
  assert.equal(result.heatmap, undefined)
  assert.match(result.reason, /not resized/)
})

test('perceptual threshold is bounded', async () => {
  const png = await image()
  await assert.rejects(comparePNGs(png, png, { threshold: NaN }), /threshold/)
  await assert.rejects(comparePNGs(png, png, { threshold: 1.01 }), /threshold/)
})

function capture() {
  return { engine: 'chromium', engineVersion: '1', platform: 'linux', arch: 'x64', locale: 'en-US', timezone: 'UTC', animationPolicy: 'finish-finite-pause-infinite-at-zero', screenshotScope: 'viewport', colorScheme: 'light', reducedMotion: true, viewport: { width: 800, height: 600, dpr: 1 }, scroll: { x: 0, y: 0 }, readiness: { fontsReady: true, layoutStableDuringScreenshot: true, pendingImages: 0, failedImages: 0 }, motionBeforeFreeze: { unsettled: 0 } }
}

test('capture conditions reject mismatched DPR, unready fonts, or dynamic DOM', () => {
  const before = capture()
  assert.equal(compareCaptureConditions(before, capture()).compatible, true)
  const after = capture()
  after.viewport.dpr = 2
  after.readiness.fontsReady = false
  after.readiness.layoutStableDuringScreenshot = false
  const compared = compareCaptureConditions(before, after)
  assert.equal(compared.compatible, false)
  assert.equal(compared.reasons.length, 3)
})

test('missing environment metadata is not treated as a compatible baseline', () => {
  const compared = compareCaptureConditions({}, {})
  assert.equal(compared.compatible, false)
  assert.ok(compared.reasons.length >= 10)
})

test('viewport screenshots at different scroll positions cannot share a pixel baseline', () => {
  const after = capture()
  after.scroll.y = 400
  const result = compareCaptureConditions(capture(), after)
  assert.equal(result.compatible, false)
  assert.ok(result.reasons.some((reason) => reason.includes('Scroll y')))
})

test('the exact map preserves small changes suppressed by the perceptual threshold', async () => {
  const before = await image()
  const after = await image(8, 6, (png) => { png.data[0] = 254 })
  const compared = await comparePNGs(before, after)
  assert.equal(compared.metrics.exactChangedPixels, 1)
  assert.equal(compared.metrics.perceptualChangedPixels, 0)
  const { PNG } = await dependency('pngjs')
  assert.deepEqual([...PNG.sync.read(compared.rawDiff).data.subarray(0, 4)], [220, 0, 140, 255])
})
