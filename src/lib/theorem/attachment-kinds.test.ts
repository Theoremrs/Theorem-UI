import { expect, test } from 'bun:test'
import {
  ATTACHMENT_ACCEPT,
  DOCX,
  asUpload,
  fileKind,
  formatLabel,
  uploadType,
} from './attachment-kinds'

test('a file is known by its type, or by its name when the type says little', () => {
  expect(fileKind('shot.png', 'image/png')).toBe('image')
  expect(fileKind('clip.mov', 'video/quicktime')).toBe('video')
  expect(fileKind('take.m4a', 'audio/mp4')).toBe('audio')
  expect(fileKind('paper.pdf', '')).toBe('pdf')
  expect(fileKind('brief.docx', DOCX)).toBe('docx')
  expect(fileKind('notes.md', '')).toBe('markdown')
  expect(fileKind('rows.csv', 'text/csv')).toBe('table')
  expect(fileKind('page.html', 'text/html')).toBe('html')
  expect(fileKind('data.json', 'application/json')).toBe('code')
  // Browsers type a .ts file as an MPEG transport stream; its name wins.
  expect(fileKind('main.ts', 'video/mp2t')).toBe('code')
  expect(fileKind('main.rs', '')).toBe('code')
  expect(fileKind('Pasted text.txt', 'text/plain')).toBe('text')
  // Theorem refuses SVG, so it is not taken as an image.
  expect(fileKind('mark.svg', 'image/svg+xml')).toBe('other')
})

test('a file goes up as a type Theorem takes', async () => {
  expect(uploadType('main.rs', '')).toBe('text/plain')
  expect(uploadType('notes.md', '')).toBe('text/markdown')
  expect(uploadType('rows.csv', 'application/vnd.ms-excel')).toBe('text/csv')
  expect(uploadType('data.json', '')).toBe('application/json')
  expect(uploadType('shot.png', 'image/png')).toBe('image/png')
  const retyped = asUpload(new File(['fn main() {}'], 'main.rs'))
  expect(retyped.type.split(';', 1)[0]).toBe('text/plain')
  expect(await retyped.text()).toBe('fn main() {}')
  const png = new File(['x'], 'shot.png', { type: 'image/png' })
  expect(asUpload(png)).toBe(png)
})

test('the picker offers what Theorem takes, and no name Theorem refuses', () => {
  const offered = ATTACHMENT_ACCEPT.split(',')
  for (const type of [
    'image/png',
    'application/pdf',
    DOCX,
    'text/csv',
    '.md',
    '.rs',
  ])
    expect(offered).toContain(type)
  for (const refused of ['.js', '.mjs', '.svg', '.zip', '.exe'])
    expect(offered).not.toContain(refused)
})

test('a format reads as its extension', () => {
  expect(formatLabel('Pasted text.txt', 'text/plain')).toBe('TXT')
  expect(formatLabel('paper.pdf')).toBe('PDF')
  expect(formatLabel('clip', 'video/x-matroska')).toBe('MATROSKA')
  expect(formatLabel('blob')).toBe('FILE')
})
