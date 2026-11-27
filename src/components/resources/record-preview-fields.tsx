// SOURCING: the Records field renderer (components/records/fields FieldDisplay), reused as the record kind's `preview` contribution so a record's preview shows its values the way the table and the record page do (DATA-01). A registered renderer augments a declared field type; it does not change what the backend accepts, and fields it cannot show are skipped, not removed.
import { FieldDisplay } from '@/components/records/fields'
import type { ObjectType, RecordRow } from '@/components/records/contract'
import { registerContribution } from '@/lib/contributions/registry'
import type { PreviewRendererProps } from './resource-preview'

const MAX_FIELDS = 6

export function RecordPreviewFields({ preview }: PreviewRendererProps) {
  const detail = preview.detail as
    { type?: ObjectType; row?: RecordRow } | undefined
  if (!detail?.type || !detail.row) return null
  const { type, row } = detail
  const shown = type.fields
    .filter(
      (field) =>
        field.key !== type.label_identifier_field &&
        row.values[field.key] !== undefined &&
        row.values[field.key] !== null &&
        row.values[field.key] !== '',
    )
    .slice(0, MAX_FIELDS)
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
      {shown.map((field) => (
        <div key={field.key} className="contents">
          <dt className="text-ink-muted">{field.label ?? field.key}</dt>
          <dd className="min-w-0">
            <FieldDisplay row={row} field={field} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Registers the record preview renderer; returns the function that removes it. */
export const registerRecordPreview = () =>
  registerContribution({
    kind: 'preview',
    id: 'theorem.preview.record',
    label: 'Record fields',
    serves: ['record'],
    Component: RecordPreviewFields,
  })
