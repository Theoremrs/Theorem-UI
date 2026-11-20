// SOURCING: the Index's used-together binding (components/index/queries useBinding over POST /api/index/v1/query, anchored on the record's item id), the Index inspector's "Used with" list for the row anatomy; the CRM's type marks (./type-icons) and navigation (./navigation). Evidence only: nothing is shown while it loads, when it fails, or when nothing was opened alongside
import { useBinding } from '@/components/index/queries'
import type { Binding } from '@/components/index/contract'
import type { ObjectType } from '@/components/records/contract'
import { recordItemId } from '@/components/records/model'
import { useOpenDocumentHandler } from './context'
import { useCrmNavigate } from './navigation'
import { NamedTypeIcon } from './type-icons'

/** How many neighbours the section lists. */
export const OFTEN_OPENED_LIMIT = 8

const row =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] outline-none hover:bg-hover/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus'

/** Records and documents opened in the same sessions as this record. */
export function OftenOpenedWith({
  type,
  recordId,
}: {
  type: ObjectType
  recordId: string
}) {
  const navigation = useCrmNavigate()
  const { openRecordNamed } = navigation
  // A document opens where the surrounding inspector opens its other items.
  const openDocument = useOpenDocumentHandler() ?? navigation.openDocument
  const binding: Binding = {
    kind: 'used_together',
    anchorIds: [recordItemId(type, recordId)],
    limit: OFTEN_OPENED_LIMIT,
  }
  const used = useBinding(binding)
  if (used.data?.kind !== 'used_together') return null
  const records = (used.data.records ?? []).slice(0, OFTEN_OPENED_LIMIT)
  const documents = used.data.items.slice(
    0,
    Math.max(0, OFTEN_OPENED_LIMIT - records.length),
  )
  if (!records.length && !documents.length) return null
  return (
    <section
      aria-label="Often opened with"
      className="flex flex-col gap-1 border-t border-separator px-2 py-3"
    >
      <h3 className="px-2 pb-1 text-xs font-medium text-ink-muted">
        Often opened with
      </h3>
      <ul className="flex flex-col">
        {records.map((record) => (
          <li key={record.itemId}>
            <button
              type="button"
              className={row}
              onClick={() =>
                openRecordNamed(record.nameSingular, record.recordId)
              }
            >
              <NamedTypeIcon
                nameSingular={record.nameSingular}
                className="size-3.5 text-ink-muted"
              />
              <span className="min-w-0 flex-1 truncate">
                {record.title || record.recordId}
              </span>
              <span className="shrink-0 text-[11px] text-ink-faint">
                {record.nameSingular}
              </span>
            </button>
          </li>
        ))}
        {documents.map((item) => (
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
    </section>
  )
}
