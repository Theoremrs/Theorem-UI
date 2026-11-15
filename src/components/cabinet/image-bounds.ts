// SOURCING: the PNG (IHDR), GIF (logical screen), JPEG (SOFn) and WebP
// (VP8/VP8L/VP8X) headers as their specifications lay them out, and
// createImageBitmap's resize options. Shared by the page and the preview
// worker so neither decodes an image whose pixels would not fit the budget.
//
// A small, highly compressed file can still declare a huge raster: the byte
// limit alone does not bound decode memory (§9.2). The declared size is read
// from the header first; an image over the pixel budget, or one whose size
// cannot be read, is refused before decoding.

/** Decoded pixels allowed for one preview source (about 160 MB of RGBA). */
export const MAX_SOURCE_PIXELS = 40_000_000
/** The longest edge a kept bitmap has, in either preview mode. */
export const THUMBNAIL_EDGE = 512
/** Headers live in the first bytes; JPEG's SOF can sit after EXIF. */
const HEADER_BYTES = 256 * 1024

export type Dimensions = { width: number; height: number }

/** The raster size an image header declares, or undefined if unreadable. */
export function declaredDimensions(b: Uint8Array): Dimensions | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const at = (i: number, ...bytes: number[]) =>
    bytes.every((x, k) => b[i + k] === x)
  // PNG: signature, then IHDR width and height, big-endian.
  if (b.length >= 24 && at(0, 0x89, 0x50, 0x4e, 0x47))
    return { width: v.getUint32(16), height: v.getUint32(20) }
  // GIF: logical screen size, little-endian.
  if (b.length >= 10 && at(0, 0x47, 0x49, 0x46))
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) }
  // WebP: RIFF....WEBP then one of three chunk kinds.
  if (
    b.length >= 30 &&
    at(0, 0x52, 0x49, 0x46, 0x46) &&
    at(8, 0x57, 0x45, 0x42, 0x50)
  ) {
    if (at(12, 0x56, 0x50, 0x38, 0x20))
      return {
        width: v.getUint16(26, true) & 0x3fff,
        height: v.getUint16(28, true) & 0x3fff,
      }
    if (at(12, 0x56, 0x50, 0x38, 0x4c)) {
      const bits = v.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (at(12, 0x56, 0x50, 0x38, 0x58))
      return {
        width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
        height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
      }
    return undefined
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (b.length >= 4 && at(0, 0xff, 0xd8)) {
    let quarterTurn = false
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined
      const marker = b[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      const sof =
        marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (sof) {
        const height = v.getUint16(i + 5)
        const width = v.getUint16(i + 7)
        // EXIF orientations 5–8 turn the picture a quarter: the decoded
        // bitmap's width is the header's height.
        return quarterTurn
          ? { width: height, height: width }
          : { width, height }
      }
      if (marker === 0xe1) quarterTurn ||= exifQuarterTurn(v, i + 4)
      i += 2 + v.getUint16(i + 2)
    }
  }
  return undefined
}

/** Whether an APP1 Exif segment at `start` sets orientation 5, 6, 7 or 8. */
function exifQuarterTurn(v: DataView, start: number): boolean {
  try {
    // "Exif\0\0", then a TIFF header naming its byte order.
    if (v.getUint32(start) !== 0x45786966) return false
    const tiff = start + 6
    const little = v.getUint16(tiff) === 0x4949
    const ifd = tiff + v.getUint32(tiff + 4, little)
    const count = v.getUint16(ifd, little)
    for (let k = 0; k < count; k++) {
      const entry = ifd + 2 + k * 12
      if (v.getUint16(entry, little) === 0x0112)
        return v.getUint16(entry + 8, little) >= 5
    }
  } catch {
    // A truncated segment names no orientation.
  }
  return false
}

/**
 * Decodes an image only if its declared raster fits the budget, and keeps it
 * no larger than THUMBNAIL_EDGE on its longest edge.
 */
export async function boundedBitmap(
  blob: Blob,
  edge = THUMBNAIL_EDGE,
): Promise<ImageBitmap> {
  const head = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer())
  const size = declaredDimensions(head)
  if (!size || !size.width || !size.height)
    throw new Error(
      'unsupported: the image size could not be read before decoding',
    )
  if (size.width * size.height > MAX_SOURCE_PIXELS)
    throw new Error(
      `too_large: ${size.width}×${size.height} is over the preview decode budget`,
    )
  const scale = Math.min(1, edge / Math.max(size.width, size.height))
  return createImageBitmap(blob, {
    resizeWidth: Math.max(1, Math.round(size.width * scale)),
    resizeHeight: Math.max(1, Math.round(size.height * scale)),
    resizeQuality: 'high',
    imageOrientation: 'from-image',
  })
}
