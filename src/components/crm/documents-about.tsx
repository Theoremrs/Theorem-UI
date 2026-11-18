// SOURCING: the Index's record_documents binding (components/index/queries useBinding over POST /api/index/v1/query), which lists the documents Theorem filed to this record through the document owner; row anatomy from ./often-opened-with; the CRM's navigation opens a document beside the view as the Index does. Nothing shows while it loads, when there are none, or when the binding is refused (a Theorem that predates record filing refuses the kind)
import { useBinding } from '@/components/index/queries'
import type { Binding } from '@/components/index/contract'
import type { ObjectType } from '@/components/records/contract'
import { recordItemId } from '@/components/records/model'
import { useCrmNavigate } from './navigation'

/** How many documents the section lists before "and N more". */
export const DOCUMENTS_ABOUT_LIMIT = 12

const row =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] outline-none hover:bg-hover/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus'

/** The documents Theorem filed to this record. Filing never changed the record. */
export function DocumentsAbout({
  type,
  recordId,
}: {
  type: ObjectType
  recordId: string
}) {
  const { openDocument } = useCrmNavigate()
  const binding: Binding = {
    kind: 'record_documents',
    recordItemId: recordItemId(type, recordId),
  }
  const about = useBinding(binding)
  if (about.data?.kind !== 'items' || !about.data.items.length) return null
  const shown = about.data.items.slice(0, DOCUMENTS_ABOUT_LIMIT)
  const more = Math.max(about.data.total, about.data.items.length) - shown.length
  return (
    <section
      aria-label="Documents about this"
      className="flex flex-col gap-1 border-t border-separator px-2 py-3"
    >
      <h3 className="px-2 pb-1 text-xs font-medium text-ink-muted">
        Documents about this
      </h3>
      <ul className="flex flex-col">
        {shown.map((item) => (
          <li key={item.documentId}>
            <button
              type="button"
              className={row}
              onClick={() => openDocument(item.documentId)}
            >
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-[11px] text-ink-faint">
                {item.documentKind || 'Document'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="px-2 text-[11px] text-ink-faint">and {more} more</p>
      )}
    </section>
  )
}
