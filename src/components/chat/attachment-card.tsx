// SOURCING: the gallery's PreviewCanvas (cabinet/cabinet-overlay), which paints a pixel preview's indices in the terminal's illustration roles, inside assistant-ui's attachment tile (elements/attachment.aui); the owner's Streamline office-file-text mark (Icon.AttachedFile) where there is no picture.
import type { FC } from 'react'
import { PreviewCanvas } from '@/components/cabinet/cabinet-overlay'
import { Icon } from '@/components/icons'
import { factLine, useFilePicture } from './attachment-file'
import { isPastedText, pastedTitle } from './pasted-text'

/** The card's picture box, in CSS pixels: three quarters of the card. */
export const PICTURE = { width: 88, height: 80 }

/**
 * An attached file as a page standing up: its picture, drawn the way the
 * gallery draws it, over its name and facts.
 */
export const AttachmentFace: FC<{
  name: string
  type: string
  file: Blob | undefined
  /** The file's words, once read; the facts count its lines. */
  text?: string | undefined
  /** Said in place of the facts, such as why an upload failed. */
  status?: string | undefined
}> = ({ name, type, file, text, status }) => {
  const picture = useFilePicture(file, name, type)
  return (
    <span className="aui-attachment-face flex size-full flex-col">
      <span
        className="aui-attachment-picture relative flex shrink-0 items-center justify-center overflow-hidden"
        style={PICTURE}
      >
        {picture ? (
          <PreviewCanvas state={picture} {...PICTURE} bare />
        ) : (
          <Icon.AttachedFile className="size-9" />
        )}
      </span>
      <span className="aui-attachment-meta flex min-h-0 min-w-0 flex-1 flex-col justify-center px-1.5 text-start leading-4">
        <span className="text-ink truncate text-xs">
          {isPastedText(name, type) ? pastedTitle(name) : name}
        </span>
        <span
          className={
            status
              ? 'text-destructive truncate text-[0.6875rem]'
              : 'text-ink-muted truncate text-[0.6875rem]'
          }
        >
          {status ?? factLine(name, type, file, text)}
        </span>
      </span>
    </span>
  )
}
