import { expect, test } from 'bun:test'
import { registerNoteTools, useNoteTools } from './note-tools'
import type { NoteTools } from './note-tools'

const tools = (): NoteTools => ({
  setBlock: () => undefined,
  toggleMark: () => undefined,
  insertTable: () => undefined,
  insertImage: () => undefined,
  openBlocks: () => undefined,
  surface: () => null,
})

const editorOf = (documentId: string) =>
  useNoteTools.getState().tools[documentId]

test('a toolbox finds the editor of its own note', () => {
  const a = tools()
  const b = tools()
  const leaveA = registerNoteTools('doc-a', a)
  const leaveB = registerNoteTools('doc-b', b)
  expect(editorOf('doc-a')).toBe(a)
  expect(editorOf('doc-b')).toBe(b)
  leaveA()
  expect(editorOf('doc-a')).toBeUndefined()
  expect(editorOf('doc-b')).toBe(b)
  leaveB()
})

test('an editor that closes late does not unseat the one that replaced it', () => {
  const first = tools()
  const second = tools()
  const leaveFirst = registerNoteTools('doc-a', first)
  const leaveSecond = registerNoteTools('doc-a', second)
  leaveFirst()
  expect(editorOf('doc-a')).toBe(second)
  leaveSecond()
  expect(editorOf('doc-a')).toBeUndefined()
})
