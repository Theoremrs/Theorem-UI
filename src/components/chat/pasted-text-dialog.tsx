// SOURCING: the Base UI dialog (components/ui/dialog) that assistant-ui's attachment element (elements/attachment.aui) previews with; this is that preview's text form, for a pasted text or any file of words, opened from the element's tile in the composer and in a sent message (chat/stored-attachment).
import { useEffect, useRef, useState } from 'react'
import type { FC, ReactElement, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { count, pastedTitle, textSize } from './pasted-text'

/** The dialog lays out no more of a pasted text than this at once. */
const SHOWN_CHARS = 100_000

/** A file's words, read once it is there. */
export function useFileText(file: Blob | undefined) {
  const [read, setRead] = useState<{ file: Blob; text: string }>()
  useEffect(() => {
    if (!file) return
    let live = true
    void file.text().then((text) => {
      if (live) setRead({ file, text })
    })
    return () => {
      live = false
    }
  }, [file])
  return read !== undefined && read.file === file ? read.text : undefined
}

/**
 * A file's words, whole. A pasted text in a draft can go back in the draft,
 * where the paste would have gone.
 */
export const PastedTextDialog: FC<{
  name: string
  /** The text, once it has been read. */
  text: string | undefined
  /** The control that opens it; without one, `open` and `onOpenChange` do. */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * Puts the text back in the draft once the dialog has closed. Answers with
   * the element that takes the cursor once the dialog has let go of the page.
   */
  onPasteInline?: ((text: string) => HTMLElement | null) | undefined
  /** Shown in place of the text until it has been read, such as a failed read. */
  status?: ReactNode
}> = ({ name, text, trigger, open, onOpenChange, onPasteInline, status }) => {
  // Set while the dialog closes for the text to go back in the draft.
  const inlining = useRef(false)
  // The draft's editor once the text is back in it, focused as the dialog unmounts.
  const inlined = useRef<HTMLElement | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen || !inlining.current) return
        inlining.current = false
        if (text !== undefined) inlined.current = onPasteInline?.(text) ?? null
      }}
    >
      {trigger && <DialogTrigger nativeButton={false} render={trigger} />}
      <DialogContent
        className="aui-pasted-text-dialog flex max-h-[85dvh] flex-col sm:max-w-2xl"
        // Base UI asks as the popup unmounts, after the text went back in
        // the draft, and focuses once the page is no longer inert.
        finalFocus={() => {
          const editor = inlined.current
          inlined.current = null
          return editor ?? true
        }}
      >
        <DialogTitle className="pe-8">{pastedTitle(name)}</DialogTitle>
        {text !== undefined && (
          <DialogDescription>{textSize(text)}</DialogDescription>
        )}
        {text === undefined && status}
        <pre
          hidden={text === undefined && status !== undefined}
          className="aui-pasted-text-body bg-muted text-ink min-h-0 flex-1 overflow-auto rounded-md p-3 font-mono text-xs leading-5 wrap-break-word whitespace-pre-wrap"
        >
          {text?.slice(0, SHOWN_CHARS)}
          {text !== undefined && text.length > SHOWN_CHARS && (
            <span className="text-ink-faint">
              {`\n… ${count(text.length - SHOWN_CHARS, 'more character')}`}
            </span>
          )}
        </pre>
        {onPasteInline && text !== undefined && (
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" />}
              onClick={() => {
                inlining.current = true
              }}
            >
              Paste inline
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
