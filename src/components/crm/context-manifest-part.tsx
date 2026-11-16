// SOURCING: assistant-ui data part renderer for Theorem's `context_manifest` part (see ./manifest for the decoding and the words); coss ui Collapsible for the closed line that opens into the list; @tanstack/react-router Link to each record's page in the CRM; the CRM's type marks; lucide-react marks
import type { DataMessagePartComponent } from '@assistant-ui/react'
import { Link } from '@tanstack/react-router'
import { ChevronRight, CircleAlert, EyeOff, Layers } from 'lucide-react'
import { useState } from 'react'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@/components/coss/collapsible'
import type { ObjectType } from '@/components/records/contract'
import { useDataModel } from '@/components/records/queries'
import { cn } from '@/lib/utils'
import {
  decodeManifestPart,
  degradedWords,
  fieldNotes,
  manifestSaysSomething,
  manifestSummary,
  tokenWords,
  whyWords,
  withheldWords,
} from './manifest'
import type { ContextManifest } from './manifest'
import { typeSlug } from './model'
import { TypeIcon } from './type-icons'

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'An' : 'A')

const LINK =
  'rounded-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus'

/** A link to a record's page; the type's own slug where the type is known. */
function RecordLink({
  type,
  typeName,
  recordId,
  children,
  className,
}: {
  type: ObjectType | undefined
  typeName: string | undefined
  recordId: string
  children: string
  className?: string
}) {
  const slug = type ? typeSlug(type) : typeName?.toLowerCase()
  if (!slug) return <span className={className}>{children}</span>
  return (
    <Link
      to="/crm/$objectType/$recordId"
      params={{ objectType: slug, recordId }}
      className={cn(LINK, className)}
    >
      {children}
    </Link>
  )
}

/** The saved records a reply was given, and what was held back from it. */
export function ContextManifestView({
  manifest,
}: {
  manifest: ContextManifest
}) {
  const [open, setOpen] = useState(false)
  const model = useDataModel().data
  const typeOfName = (id: string | undefined, name: string | undefined) =>
    model?.objectTypes.find(
      (type) =>
        (id && type.object_type_id === id) ||
        (name && type.name_singular.toLowerCase() === name.toLowerCase()),
    )
  const included = new Map(
    manifest.included.map((record) => [record.recordId, record]),
  )
  const labelOf = (recordId: string) => included.get(recordId)?.label
  const typeOf = (recordId: string) => {
    const record = included.get(recordId)
    return record
      ? typeOfName(record.objectTypeId, record.objectType)
      : undefined
  }
  const tokens = tokenWords(manifest)
  const attention =
    manifest.degraded.length > 0 || manifest.ambiguous.length > 0

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-2 rounded-md border border-separator bg-raised text-[13px]"
      data-part="theorem-context_manifest"
    >
      <CollapsibleTrigger className="group/used flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
        <Layers aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {manifestSummary(manifest)}
        </span>
        {attention && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-ochre-ink">
            <CircleAlert aria-hidden className="size-3.5" />
            Incomplete
          </span>
        )}
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open/used:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 border-t border-separator px-2.5 py-2.5">
          <h4 className="text-xs font-medium text-ink">
            {manifest.lookUp
              ? 'Looked up while answering'
              : 'Used in this response'}
          </h4>

          {manifest.included.length > 0 && (
            <ul
              aria-label="Saved records used"
              className="flex flex-col gap-2.5"
            >
              {manifest.included.map((record) => {
                const type = typeOfName(record.objectTypeId, record.objectType)
                const why = whyWords(
                  record,
                  labelOf,
                  type,
                  typeOf,
                  manifest.lookUp !== undefined,
                )
                return (
                  <li key={record.recordId} className="flex gap-2">
                    <TypeIcon
                      type={type}
                      className="mt-0.5 size-3.5 text-ink-muted"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="leading-5">
                        <RecordLink
                          type={type}
                          typeName={record.objectType}
                          recordId={record.recordId}
                        >
                          {record.label}
                        </RecordLink>
                        <span className="text-ink-muted tabular-nums">
                          {' · '}
                          {type?.label_singular ?? record.objectType}
                          {' · '}
                          revision {record.revision}
                        </span>
                      </p>
                      {why && (
                        <p className="text-xs leading-5 text-ink-muted">
                          {why}
                        </p>
                      )}
                      {fieldNotes(record, type).map((note) => (
                        <p
                          key={note}
                          className="text-xs leading-5 text-ink-muted"
                        >
                          {note}
                        </p>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {manifest.withheld.length > 0 && (
            <section aria-label="Held back" className="flex flex-col gap-1">
              <h5 className="flex items-center gap-1.5 text-xs font-medium text-ink">
                <EyeOff aria-hidden className="size-3.5 text-ink-muted" />
                Held back
              </h5>
              <ul className="flex flex-col gap-1">
                {manifest.withheld.map((record) => {
                  const type = typeOfName(undefined, record.objectType)
                  const name = (
                    type?.label_singular ??
                    record.objectType ??
                    'record'
                  ).toLowerCase()
                  const gone =
                    record.reason === 'record_deleted' ||
                    record.reason === 'not_found'
                  return (
                    <li
                      key={`${record.recordId}:${record.reason}`}
                      className="text-xs leading-5 text-ink-muted"
                    >
                      {article(name)} {name}: {withheldWords(record.reason)}.{' '}
                      {!gone && (
                        <RecordLink
                          type={type}
                          typeName={record.objectType}
                          recordId={record.recordId}
                          className="font-normal"
                        >
                          Open it
                        </RecordLink>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {manifest.overBudget > 0 && (
            <p className="text-xs leading-5 text-ink-muted">
              {manifest.overBudget === 1
                ? '1 more record bears on this and was left out to keep the request short.'
                : `${manifest.overBudget} more records bear on this and were left out to keep the request short.`}
            </p>
          )}

          {manifest.ambiguous.length > 0 && (
            <section
              aria-label="Names that match more than one record"
              className="flex flex-col gap-1"
            >
              {manifest.ambiguous.map((mention) => (
                <p key={mention.phrase} className="text-xs leading-5 text-ink">
                  “{mention.phrase}” matches{' '}
                  {mention.recordIds.length || 'more than one'} saved records,
                  so Theorem could not tell which you meant
                  {mention.recordIds.length > 0 && ': '}
                  {mention.recordIds.map((id, index) => (
                    <span key={id}>
                      {index > 0 && ', '}
                      <RecordLink
                        type={typeOf(id)}
                        typeName={included.get(id)?.objectType}
                        recordId={id}
                        className="font-normal"
                      >
                        {labelOf(id) ?? id}
                      </RecordLink>
                    </span>
                  ))}
                  .
                </p>
              ))}
            </section>
          )}

          {manifest.degraded.length > 0 && (
            <ul
              aria-label="What could not be read"
              className="flex flex-col gap-1"
            >
              {manifest.degraded.map((code) => (
                <li
                  key={code}
                  className="flex gap-1.5 text-xs leading-5 text-ink"
                >
                  <CircleAlert
                    aria-hidden
                    className="mt-1 size-3 shrink-0 text-ochre-ink"
                  />
                  {degradedWords(code)}
                </li>
              ))}
            </ul>
          )}

          {manifest.included.length > 0 && manifest.you.state === 'unbound' && (
            <p className="text-xs leading-5 text-ink-muted">
              No person record is marked as you, so “I” and “me” were not tied
              to a record.
            </p>
          )}
          {manifest.you.state === 'withheld' && (
            <p className="text-xs leading-5 text-ink-muted">
              Your own record is held back, so Theorem was not told who is
              asking.
            </p>
          )}

          {manifest.modelTypes.length > 0 && (
            <p className="text-xs leading-5 text-ink-muted">
              Theorem was also told how your records are organised:{' '}
              {manifest.modelTypes.join(', ')}.
            </p>
          )}

          {tokens && manifest.included.length > 0 && (
            <p className="text-xs leading-5 text-ink-faint tabular-nums">
              {tokens}
            </p>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

/** The `context_manifest` part: drawn only when it has something to say. */
export const ContextManifestPart: DataMessagePartComponent = ({ data }) => {
  const manifest = decodeManifestPart(data)
  return manifest && manifestSaysSomething(manifest) ? (
    <ContextManifestView manifest={manifest} />
  ) : null
}
