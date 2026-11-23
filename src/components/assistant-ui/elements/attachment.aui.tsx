// SOURCING: assistant-ui's attachment element (r.assistant-ui.com registry, copied and adapted) over AttachmentPrimitive, ComposerPrimitive and MessagePrimitive; its tile shows the file as the gallery draws it (chat/attachment-card), and its preview dialog also opens words (chat/pasted-text-dialog) and a PDF, video or audio file (chat/file-preview-dialog).
'use client'

import { useEffect, useRef, useState, isValidElement } from 'react'
import type { PropsWithChildren, FC } from 'react'
import { Icon } from '@/components/icons'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from '@assistant-ui/react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { pasteInComposer } from '@/components/chat/composer-editor'
import { isPastedText } from '@/components/chat/pasted-text'
import { AttachmentFace } from '@/components/chat/attachment-card'
import { fileKind, isTextual } from '@/lib/theorem/attachment-kinds'
import type { FileKind } from '@/lib/theorem/attachment-kinds'
import {
  FilePreviewDialog,
  opensAsMedia,
} from '@/components/chat/file-preview-dialog'
import {
  PastedTextDialog,
  useFileText,
} from '@/components/chat/pasted-text-dialog'
import { useIsomorphicLayoutEffect } from '@/components/assistant-ui/utils/useIsomorphicLayoutEffect'
import { useAttachmentSrc } from '@/hooks/use-attachment-src'
import { popIn } from '@/lib/motion'
import { cn } from '@/lib/utils'

type AttachmentPreviewProps = {
  src: string
  name: string
}

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src, name }) => {
  const [isLoaded, setIsLoaded] = useState(false)
  return (
    <img
      src={src}
      alt={`Preview of ${name}`}
      className={cn(
        'block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-opacity duration-300 motion-reduce:transition-none',
        isLoaded
          ? 'aui-attachment-preview-image-loaded opacity-100'
          : 'aui-attachment-preview-image-loading opacity-0',
      )}
      onLoad={() => setIsLoaded(true)}
    />
  )
}

type AttachmentPreviewDialogProps = PropsWithChildren<{
  src: string | undefined
  name: string
  type: string
  kind: FileKind
  file: Blob | undefined
  /** A file's words, previewed when there is no image. */
  text?: string | undefined
  /** Puts a pasted text back in the draft; see PastedTextDialog. */
  onPasteInline?: ((text: string) => HTMLElement | null) | undefined
}>

export const AttachmentPreviewDialog: FC<AttachmentPreviewDialogProps> = ({
  children,
  src,
  name,
  type,
  kind,
  file,
  text,
  onPasteInline,
}) => {
  const trigger = isValidElement(children) ? (
    children
  ) : (
    <button type="button">{children}</button>
  )
  if (!src) {
    if (text !== undefined)
      return (
        <PastedTextDialog
          name={name}
          text={text}
          trigger={trigger}
          onPasteInline={onPasteInline}
        />
      )
    if (file && opensAsMedia(kind))
      return (
        <FilePreviewDialog
          name={name}
          type={type}
          kind={kind}
          file={file}
          trigger={trigger}
        />
      )
    return children
  }

  return (
    <Dialog>
      <DialogTrigger
        nativeButton={false}
        className="aui-attachment-preview-trigger cursor-zoom-in"
        render={trigger}
      />
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&>button]:hover:bg-foreground/80 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Preview {name}
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm">
          <AttachmentPreview src={src} name={name} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The tile a file stands in, in the composer and in a sent message. */
export const ATTACHMENT_TILE =
  'aui-attachment-tile bg-muted hover:after:bg-foreground/10 focus-visible:ring-ring/50 relative block h-28 w-22 overflow-hidden rounded-[calc(var(--composer-radius,1rem)-var(--composer-padding,8px))] transition-transform outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset focus-visible:ring-1 motion-reduce:transition-none dark:after:ring-white/10'

const AttachmentUI: FC = () => {
  const aui = useAui()
  const isComposer = aui.attachment.source !== 'message'
  const src = useAttachmentSrc()
  const root = useRef<HTMLDivElement>(null)
  const name = useAuiState((s) => s.attachment.name)
  const file = useAuiState((s) => s.attachment.file)
  const type = useAuiState(
    (s) => s.attachment.contentType ?? s.attachment.file?.type ?? '',
  )
  const kind = fileKind(name, type)
  // A file of words, a long paste among them, previews as its text.
  const text = useFileText(isTextual(kind) ? file : undefined)
  const previewable =
    src !== undefined ||
    text !== undefined ||
    (file !== undefined && opensAsMedia(kind))

  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type
    switch (type) {
      case 'image':
        return 'Image'
      case 'document':
        return 'Document'
      case 'file':
        return 'File'
      default:
        return type
    }
  })

  // An attachment on a submission is still being prepared, whether or not the
  // adapter reports progress while it uploads.
  const uploadState = useAuiState((s) =>
    s.attachment.status.type === 'incomplete' &&
    s.attachment.status.reason === 'error'
      ? 'error'
      : s.attachment.status.type === 'running' ||
          (s.optional.message?.submission !== undefined &&
            s.attachment.status.type !== 'complete')
        ? 'uploading'
        : undefined,
  )
  const isUploading = uploadState === 'uploading'
  const isError = uploadState === 'error'

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === 'incomplete' &&
    s.attachment.status.reason === 'error'
      ? (s.attachment.status.message ?? 'Upload failed')
      : undefined,
  )

  return (
    <AttachmentPrimitive.Root
      ref={root}
      className={cn(
        'aui-attachment-root group/attachment relative shrink-0',
        isComposer &&
          'animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none',
      )}
    >
      <AttachmentPreviewDialog
        src={src}
        name={name}
        type={type}
        kind={kind}
        file={file}
        text={text}
        onPasteInline={
          isComposer && isPastedText(name, type)
            ? (pasted) => {
                const editor = pasteInComposer(root.current, pasted)
                if (editor) void aui.attachment.remove()
                return editor
              }
            : undefined
        }
      >
        <div
          className={cn(
            ATTACHMENT_TILE,
            previewable ? 'cursor-zoom-in' : 'cursor-default',
            isError &&
              'after:ring-destructive/60 dark:after:ring-destructive/60',
          )}
          role={previewable ? 'button' : 'group'}
          tabIndex={0}
          aria-label={`${previewable ? `Preview ${name}` : `${typeLabel} attachment ${name}`}${
            isError ? ', upload failed' : isUploading ? ', uploading' : ''
          }`}
        >
          <AttachmentFace
            name={name}
            type={type}
            file={file}
            text={text}
            status={errorMessage}
          />
          {isUploading && (
            <div
              aria-hidden="true"
              className="aui-attachment-tile-uploading bg-background/60 animate-in fade-in-0 absolute inset-0 flex items-center justify-center backdrop-blur-[2px] motion-reduce:animate-none"
            >
              <Icon.Refresh className="text-muted-foreground size-4 animate-spin" />
            </div>
          )}
          {isError && (
            <div
              aria-hidden="true"
              className="aui-attachment-tile-error bg-background/70 animate-in fade-in-0 absolute inset-0 flex items-center justify-center backdrop-blur-[2px] motion-reduce:animate-none"
            >
              <Icon.Close className="text-destructive size-4" />
            </div>
          )}
        </div>
      </AttachmentPreviewDialog>
      {isComposer && <AttachmentRemove name={name} />}
    </AttachmentPrimitive.Root>
  )
}

// Upstream widens the button's target by 6px, which on its 56px tile reached
// the center: a click meant to open the tile removed it. 2px keeps a 24px target.
// It shows while the pointer is over the tile or it has focus; a touch screen,
// with no hover, always shows it.
const AttachmentRemove: FC<{ name: string }> = ({ name }) => {
  return (
    <AttachmentPrimitive.Remove
      render={
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${name}`}
          className="aui-attachment-tile-remove absolute end-1 top-1 size-5 rounded-full bg-black/50! p-0 text-white transition-opacity group-focus-within/attachment:opacity-100 group-hover/attachment:opacity-100 after:absolute after:-inset-0.5 hover:bg-black/70! hover:text-white! motion-reduce:transition-none [@media(hover:hover)]:opacity-0"
        />
      }
    >
      <Icon.Close className="aui-attachment-remove-icon size-3.5" />
    </AttachmentPrimitive.Remove>
  )
}

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments flex w-full flex-row justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  )
}

export const ComposerAttachments: FC = () => {
  const empty = useAuiState((s) => s.composer.attachments.length === 0)
  if (empty) return null
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  )
}

/** The folder lifts as the file picker comes up and settles when it goes. */
const AttachMark: FC<{ open: boolean }> = ({ open }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(open)
  useIsomorphicLayoutEffect(() => {
    const mark = ref.current
    if (!mark || shown.current === open) return
    shown.current = open
    popIn(mark, { from: 0.7, rotate: open ? -10 : 8, ease: 'lift' })
  }, [open])
  return (
    <span ref={ref} className="flex">
      <Icon.AttachFolder />
    </span>
  )
}

export const ComposerAddAttachment: FC = () => {
  const [picking, setPicking] = useState(false)
  // The window loses focus to the file picker and gets it back when the
  // picker closes, whether a file was chosen or not.
  useEffect(() => {
    if (!picking) return
    const closed = () => setPicking(false)
    window.addEventListener('focus', closed, { once: true })
    return () => window.removeEventListener('focus', closed)
  }, [picking])
  return (
    <ComposerPrimitive.AddAttachment
      onClick={() => setPicking(true)}
      render={
        <Button
          variant="ghost"
          size="icon"
          className="aui-composer-add-attachment text-ink-muted hover:bg-hover hover:text-ink size-8 rounded-md p-2 motion-reduce:transition-none"
          aria-label="Add Attachment"
        />
      }
    >
      <AttachMark open={picking} />
    </ComposerPrimitive.AddAttachment>
  )
}
