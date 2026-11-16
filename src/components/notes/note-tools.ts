// SOURCING: @milkdown/kit commands (the same ones Crepe's slash menu and selection toolbar call), Crepe's slash menu through its menuAPICtx slice, zustand (which editor answers for which note)
import type { Crepe } from '@milkdown/crepe'
import { imageBlockSchema } from '@milkdown/kit/component/image-block'
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  toggleEmphasisCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark'
import { createTable } from '@milkdown/kit/preset/gfm'
import type { Attrs, Node, NodeType } from '@milkdown/kit/prose/model'
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { create } from 'zustand'

export type NoteBlock =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'code'

export type NoteMark = 'bold' | 'italic' | 'link'

/** What a note's toolbox can ask of its editor. Each acts at the cursor. */
export type NoteTools = {
  /** Turns the block at the cursor into `block`. */
  setBlock: (block: NoteBlock) => void
  /** Bold and italic toggle on the selection; link opens the link field for it. */
  toggleMark: (mark: NoteMark) => void
  /** A 3 by 3 table after the block at the cursor. */
  insertTable: () => void
  /** Uploads `file` and sets it as an image after the block at the cursor. */
  insertImage: (file: File) => void
  /** Opens the block menu, the one `/` opens, on a new line after the cursor. */
  openBlocks: () => void
  /** The element that takes the keyboard, for a menu to hand focus back to. */
  surface: () => HTMLElement | null
}

/** The editors that are open, by the note each one edits. */
export const useNoteTools = create<{ tools: Record<string, NoteTools> }>(() => ({
  tools: {},
}))

/** Names `tools` as the editor of `documentId`; the return takes it back. */
export function registerNoteTools(documentId: string, tools: NoteTools) {
  useNoteTools.setState((state) => ({
    tools: { ...state.tools, [documentId]: tools },
  }))
  return () =>
    useNoteTools.setState((state) => {
      if (state.tools[documentId] !== tools) return state
      const { [documentId]: _, ...rest } = state.tools
      return { tools: rest }
    })
}

/** Crepe's slash menu; Crepe keeps the slice but does not export its key. */
type BlockMenu = { show: (pos: number) => void }

// A command's key exists once its editor is built, so it is read when called.
const MARKS = {
  bold: () => toggleStrongCommand.key,
  italic: () => toggleEmphasisCommand.key,
  link: () => toggleLinkCommand.key,
} as const

/** Where the block holding the cursor ends, at the top level of the note. */
const afterBlock = (view: EditorView) => {
  const { $from, to } = view.state.selection
  return $from.depth ? $from.after(1) : to
}

/** Whether the cursor is alone on an empty line at the top level. */
const onEmptyLine = (view: EditorView) => {
  const { $from, empty } = view.state.selection
  return (
    empty &&
    $from.depth === 1 &&
    $from.parent.type.name === 'paragraph' &&
    $from.parent.content.size === 0
  )
}

/**
 * Sets `node` as a block of its own: in place of an empty line, otherwise
 * after the block at the cursor. Returns where it starts.
 */
const placeBlock = (view: EditorView, node: Node) => {
  const { state } = view
  if (onEmptyLine(view)) {
    const { $from } = state.selection
    const from = $from.before(1)
    view.dispatch(state.tr.replaceWith(from, $from.after(1), node))
    return from
  }
  const from = afterBlock(view)
  view.dispatch(state.tr.insert(from, node))
  return from
}

/**
 * The toolbox's handle on one Crepe editor. `root` is the editor's element:
 * until a person has put the cursor somewhere in it, a tool acts at the end
 * of the note, not at its first character.
 */
export function createNoteTools({
  crepe,
  root,
  upload,
  onImage,
}: {
  crepe: Crepe
  root: HTMLElement
  /** Stores an image and returns the address the note keeps for it. */
  upload: (file: File) => Promise<string>
  /** The state of an image on its way in, for the editor to say. */
  onImage: (state: { uploading?: string; error?: string }) => void
}): NoteTools {
  let placed = false
  root.addEventListener('focusin', () => (placed = true), { once: true })

  const act = (run: (ctx: Ctx, view: EditorView) => void) =>
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      if (!view.editable) return
      if (!placed)
        view.dispatch(
          view.state.tr.setSelection(Selection.atEnd(view.state.doc)),
        )
      view.focus()
      run(ctx, view)
    })

  const select = (view: EditorView, pos: number) =>
    view.dispatch(
      view.state.tr
        .setSelection(
          TextSelection.near(
            view.state.doc.resolve(
              Math.min(pos, view.state.doc.content.size),
            ),
          ),
        )
        .scrollIntoView(),
    )

  return {
    setBlock: (block) =>
      act((ctx) => {
        const commands = ctx.get(commandsCtx)
        const set = (nodeType: NodeType, attrs?: Attrs) =>
          commands.call(setBlockTypeCommand.key, { nodeType, attrs })
        const wrap = (nodeType: NodeType, attrs?: Attrs) =>
          commands.call(wrapInBlockTypeCommand.key, { nodeType, attrs })
        switch (block) {
          case 'text':
            return set(paragraphSchema.type(ctx))
          case 'h1':
            return set(headingSchema.type(ctx), { level: 1 })
          case 'h2':
            return set(headingSchema.type(ctx), { level: 2 })
          case 'h3':
            return set(headingSchema.type(ctx), { level: 3 })
          case 'code':
            return set(codeBlockSchema.type(ctx))
          case 'quote':
            return wrap(blockquoteSchema.type(ctx))
          case 'bullet':
            return wrap(bulletListSchema.type(ctx))
          case 'ordered':
            return wrap(orderedListSchema.type(ctx))
          case 'task':
            return wrap(listItemSchema.type(ctx), { checked: false })
        }
      }),
    toggleMark: (mark) =>
      act((ctx, view) => {
        const { empty, from } = view.state.selection
        // A link needs words to carry it; with none selected it brings its own.
        if (mark === 'link' && empty) {
          const tr = view.state.tr.insertText('link', from)
          view.dispatch(
            tr.setSelection(TextSelection.create(tr.doc, from, from + 4)),
          )
        }
        ctx.get(commandsCtx).call(MARKS[mark]())
      }),
    insertTable: () =>
      act((ctx, view) => {
        const from = placeBlock(view, createTable(ctx, 3, 3))
        // Into the first cell, ready to type.
        select(view, from + 1)
      }),
    insertImage: (file) => {
      onImage({ uploading: file.name })
      upload(file).then(
        (src) => {
          onImage({})
          act((ctx, view) => {
            const image = imageBlockSchema.type(ctx).create({ src })
            const from = placeBlock(view, image)
            select(view, from + image.nodeSize)
          })
        },
        (error: unknown) =>
          onImage({
            error:
              error instanceof Error
                ? error.message
                : 'That image could not be added.',
          }),
      )
    },
    surface: () => root.querySelector<HTMLElement>('.ProseMirror'),
    openBlocks: () =>
      act((ctx, view) => {
        if (!onEmptyLine(view)) {
          const pos = afterBlock(view)
          view.dispatch(
            view.state.tr.insert(pos, paragraphSchema.type(ctx).create()),
          )
          select(view, pos + 1)
        }
        ctx
          .get<BlockMenu, 'menuAPICtx'>('menuAPICtx')
          .show(view.state.selection.from)
      }),
  }
}
