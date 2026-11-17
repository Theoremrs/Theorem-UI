// SOURCING: Twenty's record side panel for the anatomy (a 420 px panel beside the table: the record's mark and editable name, its properties as label and value rows, actions underneath); the pieces shared with the record page (./record-fields); the app's Button; lucide-react marks
import { ArrowUpRight, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ObjectType } from '@/components/records/contract'
import { recordTitle } from '@/components/records/model'
import { Button } from '@/components/ui/button'
import type { CrmRecord } from './api'
import { DocumentsAbout } from './documents-about'
import { OftenOpenedWith } from './often-opened-with'
import { useCrmNavigate } from './navigation'
import type { CrmWrites } from './queries'
import {
  AskTheoremButton,
  DeleteControl,
  PrivateToggle,
  PropertyList,
  ReadOnlyNote,
  RecordHeading,
  RevisionLine,
  SelfControl,
  UnsavedEdits,
} from './record-fields'

/** Spec width of the record preview beside a table. */
export const PREVIEW_WIDTH = 420

/** One record beside its view: read it, change it, or open it in full. */
export function RecordPreview({
  type,
  record,
  writes,
  writable,
  onClose,
  onOpenRelated,
  fill = false,
}: {
  type: ObjectType
  record: CrmRecord
  writes: CrmWrites
  writable: boolean
  onClose: () => void
  /** Where a related record opens; its full page unless said otherwise. */
  onOpenRelated?: (type: ObjectType, recordId: string) => void
  /** Fill the pane it is in (the Index's working pane) instead of 420 px. */
  fill?: boolean
}) {
  const { openRecord } = useCrmNavigate()
  const openRelated = onOpenRelated ?? openRecord
  const panel = useRef<HTMLElement>(null)
  const title = recordTitle(type, record)

  // Escape closes the preview, unless an editor inside it took the key.
  useEffect(() => {
    const node = panel.current
    if (!node) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]'))
        return
      onClose()
    }
    node.addEventListener('keydown', onKey)
    return () => node.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      ref={panel}
      aria-label={`${type.label_singular}: ${title}`}
      className={
        fill
          ? 'flex h-full w-full flex-col bg-background'
          : 'flex h-full shrink-0 flex-col border-s border-separator bg-background'
      }
      style={fill ? undefined : { width: PREVIEW_WIDTH }}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-separator ps-3 pe-2">
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
          {type.label_singular}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void openRecord(type, record.id)}
        >
          <ArrowUpRight aria-hidden />
          Open
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          // The phone Index moves focus here when the preview opens.
          data-index-close
          aria-label="Close preview"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-col gap-1 px-4 pt-4 pb-3">
          <RecordHeading
            type={type}
            record={record}
            writes={writes}
            writable={writable}
            size="preview"
          />
          <RevisionLine record={record} />
          {!writable && <ReadOnlyNote type={type} />}
        </div>

        <UnsavedEdits
          type={type}
          recordId={record.id}
          recordOf={(id) => (id === record.id ? record : undefined)}
          writes={writes}
        />

        <div className="px-2 pb-2">
          <PropertyList
            type={type}
            record={record}
            writes={writes}
            writable={writable}
            onOpenRelated={(target, id) => void openRelated(target, id)}
          />
        </div>

        <DocumentsAbout type={type} recordId={record.id} />
        <OftenOpenedWith type={type} recordId={record.id} />

        <div className="flex flex-col gap-4 border-t border-separator px-4 py-4">
          <PrivateToggle
            type={type}
            record={record}
            writes={writes}
            writable={writable}
          />
          <SelfControl type={type} record={record} />
        </div>
      </div>

      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-separator px-3">
        <AskTheoremButton type={type} record={record} />
        <span className="flex-1" />
        <DeleteControl
          type={type}
          record={record}
          writes={writes}
          writable={writable}
          onDeleted={onClose}
        />
      </footer>
    </aside>
  )
}
