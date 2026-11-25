import { expect, test } from 'bun:test'
import type { PreviewState } from '@/components/cabinet/previews'
import { cropToDrawing, factLine } from './attachment-file'

const board = (w: number, h: number, drawn: Array<[number, number]>) => {
  const indices = new Uint8Array(w * h)
  for (const [x, y] of drawn) indices[y * w + x] = 7
  return {
    status: 'ready',
    mode: 'pixel',
    meta: { width: w, height: h },
    indices,
  } as unknown as PreviewState
}

test('the card keeps the drawing and cuts the empty matte around it', () => {
  const cropped = cropToDrawing(
    board(20, 10, [
      [8, 4],
      [11, 6],
    ]),
  )
  if (cropped.status !== 'ready' || cropped.mode !== 'pixel') throw new Error()
  // Two pixels of matte stay on each side of the drawing.
  expect([cropped.meta.width, cropped.meta.height]).toEqual([8, 7])
  expect(cropped.indices[2 * 8 + 2]).toBe(7)
  expect(cropped.indices[4 * 8 + 5]).toBe(7)
  expect([...cropped.indices].filter(Boolean)).toHaveLength(2)
  // A board with nothing drawn is left whole.
  const blank = board(4, 4, [])
  expect(cropToDrawing(blank)).toBe(blank)
})

test("a card's facts are its format, then lines for words or its size", () => {
  expect(factLine('Pasted text.txt', 'text/plain', undefined, 'a\nb')).toBe(
    'TXT · 2 lines',
  )
  expect(
    factLine(
      'shot.png',
      'image/png',
      new Blob([new Uint8Array(2048)]),
      undefined,
    ),
  ).toBe('PNG · 2 KB')
  expect(factLine('brief.docx', '', undefined, undefined)).toBe('DOCX')
})
