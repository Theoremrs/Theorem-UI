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

const editorOf = (key: string) => useNoteTools.getState().tools[key]

test('a toolbox finds the editor of its own pane', () => {
  const a = tools()
  const b = tools()
  const leaveA = registerNoteTools('note:doc-a', a)
  const leaveB = registerNoteTools('note:doc-b', b)
  expect(editorOf('note:doc-a')).toBe(a)
  expect(editorOf('note:doc-b')).toBe(b)
  leaveA()
  expect(editorOf('note:doc-a')).toBeUndefined()
  expect(editorOf('note:doc-b')).toBe(b)
  leaveB()
})

test('an editor that closes late does not unseat the one that replaced it', () => {
  const first = tools()
  const second = tools()
  const leaveFirst = registerNoteTools('note:doc-a', first)
  const leaveSecond = registerNoteTools('note:doc-a', second)
  leaveFirst()
  expect(editorOf('note:doc-a')).toBe(second)
  leaveSecond()
  expect(editorOf('note:doc-a')).toBeUndefined()
})
