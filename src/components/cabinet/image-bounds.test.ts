// The decode budget is checked from the header before any pixels exist
// (§9.2; acceptance A14, A20 at the unit level).
import { describe, expect, test } from 'bun:test'
import { MAX_SOURCE_PIXELS, declaredDimensions } from './image-bounds'

const png = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const v = new DataView(b.buffer)
  v.setUint32(8, 13)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  v.setUint32(16, w)
  v.setUint32(20, h)
  return b
}

/** SOI, an optional APP1 Exif with one orientation entry, then SOF0. */
const jpeg = (w: number, h: number, orientation?: number) => {
  const parts: number[] = [0xff, 0xd8]
  if (orientation) {
    // Exif\0\0 + II*\0 + IFD offset 8 + 1 entry (tag 0x0112, SHORT, 1, value)
    // prettier-ignore
    const app = [
      0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0,
      0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
    ]
    parts.push(0xff, 0xe1, 0, app.length + 2, ...app)
  }
  parts.push(0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3)
  parts.push(...new Array(12).fill(0))
  return new Uint8Array(parts)
}

describe('declared image dimensions', () => {
  test('PNG, including thin and huge rasters', () => {
    expect(declaredDimensions(png(640, 480))).toEqual({
      width: 640,
      height: 480,
    })
    expect(declaredDimensions(png(4000, 1))).toEqual({ width: 4000, height: 1 })
    const huge = declaredDimensions(png(30000, 30000))!
    expect(huge.width * huge.height).toBeGreaterThan(MAX_SOURCE_PIXELS)
  })

  test('JPEG walks markers to the frame, and a quarter-turn EXIF swaps edges', () => {
    expect(declaredDimensions(jpeg(1200, 800))).toEqual({
      width: 1200,
      height: 800,
    })
    expect(declaredDimensions(jpeg(1200, 800, 1))).toEqual({
      width: 1200,
      height: 800,
    })
    expect(declaredDimensions(jpeg(1200, 800, 6))).toEqual({
      width: 800,
      height: 1200,
    })
  })

  test('an unreadable header names no size, so the image is refused', () => {
    expect(declaredDimensions(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
    expect(
      declaredDimensions(
        new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBeUndefined()
  })
})
