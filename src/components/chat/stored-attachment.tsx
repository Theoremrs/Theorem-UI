// SOURCING: assistant-ui's attachment element (elements/attachment.aui: its tile and its preview dialog) over the bytes of a Theorem upload (lib/theorem/uploads useUploadHead for the card, useUploadBlob once opened, both @tanstack/react-query); a stored theorem-attachment part has no attachment scope of its own, so the tile is given the file the scope would have held.
import { useState } from 'react'
import type { FC } from 'react'
import {
  ATTACHMENT_TILE,
  AttachmentPreviewDialog,
} from '@/components/assistant-ui/elements/attachment.aui'
import { TEXT_LIMIT } from '@/components/cabinet/catalog'
import { Button } from '@/components/ui/button'
import { useFileSrc } from '@/hooks/use-attachment-src'
import { fileKind, isTextual } from '@/lib/theorem/attachment-kinds'
import type { FileKind } from '@/lib/theorem/attachment-kinds'
import { useUploadBlob, useUploadHead } from '@/lib/theorem/uploads'
import { cn } from '@/lib/utils'
import { AttachmentFace } from './attachment-card'
import { FilePreviewDialog, opensAsMedia } from './file-preview-dialog'
import { PastedTextDialog, useFileText } from './pasted-text-dialog'

/** The most a PDF's or a video's card fetches to draw it; a larger one shows its mark. */
const CARD_BYTES = 4 * 1024 * 1024

/**
 * How much of a file its card fetches: an image whole, since the card is the
 * image; the beginning of words, which is all the card draws; a PDF or video
 * whole only when small; nothing of audio or a document it cannot draw, whose
 * size comes with the answer's headers.
 */
function cardBytes(kind: FileKind): number {
  if (kind === 'image') return Number.POSITIVE_INFINITY
  if (isTextual(kind)) return TEXT_LIMIT
  if (kind === 'pdf' || kind === 'video') return CARD_BYTES
  return 0
}

/** Where the file would be, while it comes or after it failed to. */
const Pending: FC<{ error: Error | null; onRetry: () => void }> = ({
  error,
  onRetry,
}) =>
  error ? (
    <div
      role="alert"
      className="flex min-h-24 flex-col items-center justify-center gap-3 text-sm"
    >
      <span className="text-destructive">{error.message}</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  ) : (
    <div
      role="status"
      className="text-ink-muted flex min-h-24 items-center justify-center text-sm"
    >
      Loading
    </div>
  )

/** A file a sent message carries, shown as the composer showed it. */
export const StoredAttachment: FC<{
  uploadId: string
  name: string
  mediaType: string | undefined
}> = ({ uploadId, name, mediaType }) => {
  const kind = fileKind(name, mediaType ?? '')
  const textual = isTextual(kind)
  const [open, setOpen] = useState(false)
  const card = useUploadHead(uploadId, cardBytes(kind))
  const whole = card.data?.whole ? card.data.head : undefined
  // The whole file is fetched only once it is opened, and only when the card
  // did not already fetch all of it.
  const opened = useUploadBlob(uploadId, open && card.data?.whole === false)
  const file = whole ?? opened.data
  const type = mediaType ?? card.data?.head.type ?? ''
  const text = useFileText(textual ? file : undefined)
  const src = useFileSrc(kind === 'image' ? file : undefined)
  // A card draws from the beginning of words; anything else needs all of it.
  const drawn = textual ? card.data?.head : whole
  const previewable = src !== undefined || textual || opensAsMedia(kind)
  const pending = (
    <Pending
      error={opened.error ?? card.error}
      onRetry={() => {
        if (card.error) void card.refetch()
        if (opened.error) void opened.refetch()
      }}
    />
  )
  const tile = (
    <span
      className={cn(
        ATTACHMENT_TILE,
        previewable ? 'cursor-zoom-in' : 'cursor-default',
      )}
      role={previewable ? 'button' : 'group'}
      tabIndex={0}
      aria-label={previewable ? `Preview ${name}` : name}
    >
      <AttachmentFace
        name={name}
        type={type}
        file={drawn}
        text={text}
        size={card.data?.size}
        status={card.error?.message}
      />
    </span>
  )
  return (
    <span className="me-1.5 mt-2 inline-block align-top whitespace-normal">
      {textual ? (
        <PastedTextDialog
          name={name}
          text={text}
          trigger={tile}
          open={open}
          onOpenChange={setOpen}
          status={pending}
        />
      ) : opensAsMedia(kind) ? (
        <FilePreviewDialog
          name={name}
          type={type}
          kind={kind}
          file={file}
          size={card.data?.size}
          trigger={tile}
          open={open}
          onOpenChange={setOpen}
          status={pending}
        />
      ) : (
        <AttachmentPreviewDialog
          src={src}
          name={name}
          type={type}
          kind={kind}
          file={file}
        >
          {tile}
        </AttachmentPreviewDialog>
      )}
    </span>
  )
}
