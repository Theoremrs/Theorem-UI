// SOURCING: bun:test over @milkdown/crepe (the editor notes are written in),
// built as lib/theorem/note-markdown.test.ts builds it; createNoteTools with
// an upload held open, so the cursor can move while the image is on its way.
import { afterEach, expect, test } from 'bun:test'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { createNoteTools } from './note-tools'

const open: Array<{ crepe: Crepe; root: HTMLElement }> = []

afterEach(async () => {
  for (const { crepe, root } of open.splice(0)) {
    await crepe.destroy()
    root.remove()
  }
})

async function noteWith(markdown: string) {
  const root = document.createElement('div')
  document.body.append(root)
  const crepe = new Crepe({ root, defaultValue: markdown })
  await crepe.create()
  open.push({ crepe, root })
  const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx))
  return { crepe, root, view }
}

/** The cursor at the start of top-level block `block`, as a click places it. */
const cursorIn = (view: EditorView, root: HTMLElement, block: number) => {
  let pos = 0
  for (let i = 0; i < block; i++) pos += view.state.doc.child(i).nodeSize
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)),
  )
  root.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}

/** An upload that lands only when `land` is called. */
const heldUpload = () => {
  let land!: (src: string) => void
  const upload = () => new Promise<string>((resolve) => (land = resolve))
  return { upload, land: () => land('/api/chat/v1/uploads/u1/content') }
}

const image = new File(['bytes'], 'photo.png', { type: 'image/png' })

const blocksOf = (view: EditorView) => {
  const names: string[] = []
  view.state.doc.forEach((node) => names.push(node.type.name))
  return names
}

const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
}

test('an image lands after the block it was picked at, not where the cursor moved', async () => {
  const { crepe, root, view } = await noteWith(
    'First paragraph.\n\nSecond paragraph.',
  )
  const { upload, land } = heldUpload()
  const tools = createNoteTools({ crepe, root, upload, onImage: () => {} })
  cursorIn(view, root, 0)
  tools.insertImage(image)
  // While it uploads, the person keeps writing in the next paragraph.
  cursorIn(view, root, 1)
  view.dispatch(view.state.tr.insertText('More. ', view.state.selection.from))
  land()
  await settle()
  expect(blocksOf(view)).toEqual(['paragraph', 'image-block', 'paragraph'])
  expect(view.state.doc.child(0).textContent).toBe('First paragraph.')
  expect(view.state.doc.child(2).textContent).toBe('More. Second paragraph.')
})

test('an image picked on an empty line takes that line, even after the cursor moves', async () => {
  const { crepe, root, view } = await noteWith('Before.\n\nAfter.')
  const { upload, land } = heldUpload()
  const tools = createNoteTools({ crepe, root, upload, onImage: () => {} })
  // An empty line between the two paragraphs.
  const paragraph = view.state.doc.child(0).type
  view.dispatch(
    view.state.tr.insert(view.state.doc.child(0).nodeSize, paragraph.create()),
  )
  cursorIn(view, root, 1)
  tools.insertImage(image)
  cursorIn(view, root, 2)
  view.dispatch(view.state.tr.insertText('Typed. ', view.state.selection.from))
  land()
  await settle()
  expect(blocksOf(view)).toEqual(['paragraph', 'image-block', 'paragraph'])
  expect(view.state.doc.child(2).textContent).toBe('Typed. After.')
})

test('with the cursor never placed, the image goes at the end of the note', async () => {
  const { crepe, root, view } = await noteWith('One.\n\nTwo.')
  const { upload, land } = heldUpload()
  const tools = createNoteTools({ crepe, root, upload, onImage: () => {} })
  tools.insertImage(image)
  land()
  await settle()
  expect(blocksOf(view).slice(0, 3)).toEqual([
    'paragraph',
    'paragraph',
    'image-block',
  ])
  expect(view.state.doc.child(0).textContent).toBe('One.')
  expect(view.state.doc.child(1).textContent).toBe('Two.')
  // Crepe keeps an empty line after a block that ends the note, to type into.
  for (let i = 3; i < view.state.doc.childCount; i++)
    expect(view.state.doc.child(i).textContent).toBe('')
})

test('an image whose picked block was deleted meanwhile still lands', async () => {
  const { crepe, root, view } = await noteWith('Goes away.\n\nStays.')
  const { upload, land } = heldUpload()
  const tools = createNoteTools({ crepe, root, upload, onImage: () => {} })
  cursorIn(view, root, 0)
  tools.insertImage(image)
  // The whole first paragraph is deleted while the upload is on its way.
  view.dispatch(view.state.tr.delete(0, view.state.doc.child(0).nodeSize))
  land()
  await settle()
  const names = blocksOf(view)
  expect(names.filter((name) => name === 'image-block')).toHaveLength(1)
  expect(names).toContain('paragraph')
})
