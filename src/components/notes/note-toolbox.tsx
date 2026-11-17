// SOURCING: Base UI Menu through coss ui (the text menu), lucide-react (the block and mark glyphs), the note's tools (note-tools.ts: Milkdown commands and Crepe's own block menu)
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  TextQuote,
  Type,
} from 'lucide-react'
import { useRef } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
import { Icon } from '@/components/icons'
import { useNoteTools } from './note-tools'
import type { NoteBlock, NoteMark } from './note-tools'

const BLOCKS: ReadonlyArray<{
  block: NoteBlock
  label: string
  Mark: ComponentType<{ 'aria-hidden'?: boolean }>
}> = [
  { block: 'text', label: 'Text', Mark: Pilcrow },
  { block: 'h1', label: 'Heading 1', Mark: Heading1 },
  { block: 'h2', label: 'Heading 2', Mark: Heading2 },
  { block: 'h3', label: 'Heading 3', Mark: Heading3 },
  { block: 'quote', label: 'Quote', Mark: TextQuote },
  { block: 'bullet', label: 'Bullet list', Mark: List },
  { block: 'ordered', label: 'Numbered list', Mark: ListOrdered },
  { block: 'task', label: 'Task list', Mark: ListChecks },
  { block: 'code', label: 'Code block', Mark: Icon.Code },
]

const MARKS: ReadonlyArray<{
  mark: NoteMark
  label: string
  Mark: ComponentType<{ 'aria-hidden'?: boolean }>
}> = [
  { mark: 'bold', label: 'Bold', Mark: Bold },
  { mark: 'italic', label: 'Italic', Mark: Italic },
  { mark: 'link', label: 'Link', Mark: Icon.Link },
]

const tool =
  'flex size-6 shrink-0 items-center justify-center rounded-full text-ink-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink [&_svg]:size-4'

/** A tool that acts at the cursor: pressing it leaves the cursor where it is. */
function Tool({
  label,
  onRun,
  children,
}: {
  label: string
  onRun: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
      className={tool}
    >
      {children}
    </button>
  )
}

/**
 * The pill of tools beside a note's title in the notes workspace: the text
 * menu (what the block at the cursor is, and bold, italic and link on the
 * selection), an image, a table, and the block menu `/` opens. Each acts at
 * the cursor of that pane's note. `toolsKey` names the pane whose editor it
 * acts in. A note that can't be edited has no tools.
 */
export function NoteToolbox({ toolsKey }: { toolsKey: string }) {
  const tools = useNoteTools((state) => state.tools[toolsKey])
  const file = useRef<HTMLInputElement>(null)
  /** A tool was picked from the text menu, so the note takes the keyboard back. */
  const picked = useRef(false)
  if (!tools) return null
  return (
    <div
      data-note-toolbox=""
      role="toolbar"
      aria-label="Note tools"
      className="notes-pill flex h-8 items-center gap-0.5 px-1"
    >
      <Menu onOpenChange={(open) => open && (picked.current = false)}>
        <MenuTrigger aria-label="Text" className={tool}>
          <Type aria-hidden />
        </MenuTrigger>
        <MenuPopup
          side="bottom"
          align="start"
          className="min-w-44"
          finalFocus={() => (picked.current ? tools.surface() : true)}
        >
          {BLOCKS.map(({ block, label, Mark }) => (
            <MenuItem
              key={block}
              onClick={() => {
                picked.current = true
                tools.setBlock(block)
              }}
            >
              <Mark aria-hidden />
              {label}
            </MenuItem>
          ))}
          <MenuSeparator />
          {MARKS.map(({ mark, label, Mark }) => (
            <MenuItem
              key={mark}
              onClick={() => {
                picked.current = true
                tools.toggleMark(mark)
              }}
            >
              <Mark aria-hidden />
              {label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Tool label="Add an image" onRun={() => file.current?.click()}>
        <Icon.Image aria-hidden />
      </Tool>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const image = event.target.files?.[0]
          event.target.value = ''
          if (image) tools.insertImage(image)
        }}
      />
      <Tool label="Add a table" onRun={tools.insertTable}>
        <Icon.Table aria-hidden />
      </Tool>
      <Tool label="Add a block" onRun={tools.openBlocks}>
        <Icon.Add aria-hidden />
      </Tool>
    </div>
  )
}
