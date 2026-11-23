// SOURCING: assistant-ui's attachment element (elements/attachment.aui: its tile and its preview dialog) over the bytes of a Theorem upload (lib/theorem/uploads useUploadBlob); a stored theorem-attachment part has no attachment scope of its own, so the tile is given the file the scope would have held.
import type { FC } from 'react'
import {
  ATTACHMENT_TILE,
  AttachmentPreviewDialog,
} from '@/components/assistant-ui/elements/attachment.aui'
import { useFileSrc } from '@/hooks/use-attachment-src'
import { fileKind, isTextual } from '@/lib/theorem/attachment-kinds'
import { useUploadBlob } from '@/lib/theorem/uploads'
import { cn } from '@/lib/utils'
import { AttachmentFace } from './attachment-card'
import { opensAsMedia } from './file-preview-dialog'
import { useFileText } from './pasted-text-dialog'

/** A file a sent message carries, shown as the composer showed it. */
export const StoredAttachment: FC<{
  uploadId: string
  name: string
  mediaType: string | undefined
}> = ({ uploadId, name, mediaType }) => {
  const file = useUploadBlob(uploadId)
  const type = mediaType ?? file?.type ?? ''
  const kind = fileKind(name, type)
  const text = useFileText(isTextual(kind) ? file : undefined)
  const src = useFileSrc(kind === 'image' ? file : undefined)
  const previewable =
    src !== undefined ||
    text !== undefined ||
    (file !== undefined && opensAsMedia(kind))
  return (
    <span className="me-1.5 mt-2 inline-block align-top whitespace-normal">
      <AttachmentPreviewDialog
        src={src}
        name={name}
        type={type}
        kind={kind}
        file={file}
        text={text}
      >
        <span
          className={cn(
            ATTACHMENT_TILE,
            previewable ? 'cursor-zoom-in' : 'cursor-default',
          )}
          role={previewable ? 'button' : 'group'}
          tabIndex={0}
          aria-label={previewable ? `Preview ${name}` : name}
        >
          <AttachmentFace name={name} type={type} file={file} text={text} />
        </span>
      </AttachmentPreviewDialog>
    </span>
  )
}
