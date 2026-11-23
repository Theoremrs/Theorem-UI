// SOURCING: the Base UI dialog (components/ui/dialog) that assistant-ui's attachment element previews with; the workspace PDF viewer (handlers/pdf PdfAttachment, react-pdf), loaded with the first PDF opened; the platform's video and audio elements. An attachment's preview when it is neither an image nor words.
import { lazy, Suspense } from 'react'
import type { FC, ReactElement, ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useFileSrc } from '@/hooks/use-attachment-src'
import { factLine } from './attachment-file'
import type { FileKind } from '@/lib/theorem/attachment-kinds'

const PdfAttachment = lazy(() =>
  import('@/components/handlers/pdf/pdf-handler').then((m) => ({
    default: m.PdfAttachment,
  })),
)

/** The kinds this dialog opens. */
export const opensAsMedia = (kind: FileKind) =>
  kind === 'pdf' || kind === 'video' || kind === 'audio'

const Media: FC<{ kind: FileKind; file: Blob }> = ({ kind, file }) => {
  const src = useFileSrc(kind === 'pdf' ? undefined : file)
  if (kind === 'pdf')
    return (
      <div className="h-[75dvh] min-h-0">
        <Suspense fallback={null}>
          <PdfAttachment file={file} />
        </Suspense>
      </div>
    )
  if (!src) return null
  return kind === 'video' ? (
    <video
      src={src}
      controls
      playsInline
      className="max-h-[75dvh] w-full rounded-md bg-black"
    />
  ) : (
    <audio src={src} controls className="w-full" />
  )
}

/** A PDF, video or audio attachment, opened whole. */
export const FilePreviewDialog: FC<{
  name: string
  type: string
  kind: FileKind
  /** The file, once it is here. */
  file: Blob | undefined
  /** The whole file's size, known before the file is. */
  size?: number | undefined
  /** Shown in place of the file until it is here, such as a failed read. */
  status?: ReactNode
  /** The control that opens it; without one, `open` and `onOpenChange` do. */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
}> = ({
  name,
  type,
  kind,
  file,
  size,
  status,
  trigger,
  open,
  onOpenChange,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {trigger && <DialogTrigger nativeButton={false} render={trigger} />}
    <DialogContent className="aui-file-preview-dialog flex max-h-[90dvh] flex-col sm:max-w-3xl">
      <DialogTitle className="truncate pe-8">{name}</DialogTitle>
      <DialogDescription>
        {factLine(name, type, file, undefined, size ?? file?.size)}
      </DialogDescription>
      {/* Mounted only while open, so a closed dialog holds no player. */}
      {file ? <Media kind={kind} file={file} /> : status}
    </DialogContent>
  </Dialog>
)
