// SOURCING: the CRM's own table, record page and preview (./crm-table, ./record-page, ./record-preview), drawn as the Index's record views: a type's table is `default:records:<name>`, a record's page `default:record:<name>/<id>`, and a record opened beside a view is the Index's item. Twenty's empty workspace for the records home's first-run shape (what will be added, one button); the schema register's reading (components/records/queries) and what this sign-in may do (lifeContext); the app's Button
import type { ReactNode } from 'react'
import type { ObjectType } from '@/components/records/contract'
import { useDataModel } from '@/components/records/queries'
import { Button } from '@/components/ui/button'
import { describeError, isSignedOut, withoutCode } from '@/lib/theorem/client'
import { CrmBoundary, useCrmScope } from './context'
import type { CrmScope } from './context'
import { CrmTable } from './crm-table'
import { BUILT_IN, accessFor, typeByName } from './model'
import { useCrmNavigate } from './navigation'
import {
  useCrmRecord,
  useCrmWrites,
  useInstallLifeContextTypes,
  useLifeContext,
} from './queries'
import { RecordAccessError, RecordMissingError } from './api'
import { crmErrorText } from './record-fields'
import { RecordPage } from './record-page'
import { RecordPreview } from './record-preview'
import { BuiltInIcon } from './type-icons'

function Centered({
  title,
  children,
  role = 'status',
}: {
  title: string
  children?: ReactNode
  role?: 'status' | 'alert'
}) {
  return (
    <div
      role={role}
      className="flex h-full min-h-40 flex-col items-center justify-center gap-2 bg-background px-6 text-center"
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      {children}
    </div>
  )
}

const detail = 'max-w-sm text-xs leading-5 text-ink-muted'

/**
 * The CRM's reading, ready: the types and what this sign-in may do have been
 * read, or the reason they could not be is said instead of `children`.
 */
function Ready({ children }: { children: (scope: CrmScope) => ReactNode }) {
  return (
    <CrmBoundary>
      <ReadyInside>{children}</ReadyInside>
    </CrmBoundary>
  )
}

function ReadyInside({
  children,
}: {
  children: (scope: CrmScope) => ReactNode
}) {
  const scope = useCrmScope()
  const model = useDataModel()
  const life = useLifeContext()
  const failed = model.error ?? life.error
  if (failed)
    return isSignedOut(failed) ? (
      <Centered title="Sign in to see your records" />
    ) : (
      <Centered title="Your records could not be read" role="alert">
        <p className={detail}>{withoutCode(describeError(failed))}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void model.refetch()
            void life.refetch()
          }}
        >
          Try again
        </Button>
      </Centered>
    )
  if (!scope.model || !scope.life) return <Centered title="Loading" />
  return <>{children(scope)}</>
}

/** The type a view names, or why there is none. */
function WithType({
  name,
  children,
}: {
  name: string
  children: (type: ObjectType) => ReactNode
}) {
  return (
    <Ready>
      {(scope) => {
        const type = typeByName(scope.types, name)
        return type ? (
          children(type)
        ) : (
          <Centered title={`There is no record type called “${name}”.`}>
            <p className={detail}>
              It may have been retired or renamed. Choose a type from the list.
            </p>
          </Centered>
        )
      }}
    </Ready>
  )
}

/** One type's records as the CRM's table. */
export function CrmTableView({
  object,
  fields,
}: {
  object: string
  fields?: string[]
}) {
  return (
    <WithType name={object}>
      {(type) => (
        <CrmTable key={type.object_type_id} type={type} fieldKeys={fields} />
      )}
    </WithType>
  )
}

/** One record's page. */
export function CrmRecordPageView({
  object,
  recordId,
}: {
  object: string
  recordId: string
}) {
  return (
    <WithType name={object}>
      {(type) => (
        <RecordPage
          key={`${type.object_type_id}:${recordId}`}
          type={type}
          recordId={recordId}
        />
      )}
    </WithType>
  )
}

/**
 * Records begin here: before any built-in type is declared, what will be
 * added and one button; after, the first listed type's table.
 */
export function RecordsHome() {
  return (
    <Ready>
      {(scope) =>
        scope.life?.started && scope.types[0] ? (
          <CrmTable
            key={scope.types[0].object_type_id}
            type={scope.types[0]}
          />
        ) : (
          <FirstRun scope={scope} />
        )
      }
    </Ready>
  )
}

/**
 * A record opened beside an Index view: the CRM's preview, filling the
 * working pane. A related record opens in its place.
 */
export function CrmRecordInspector({
  nameSingular,
  recordId,
  onOpenRelated,
  onClose,
  className,
}: {
  nameSingular: string
  recordId: string
  onOpenRelated: (type: ObjectType, recordId: string) => void
  onClose: () => void
  className?: string
}) {
  return (
    <div className={className}>
      <WithType name={nameSingular}>
        {(type) => (
          <InspectedRecord
            key={`${type.object_type_id}:${recordId}`}
            type={type}
            recordId={recordId}
            onOpenRelated={onOpenRelated}
            onClose={onClose}
          />
        )}
      </WithType>
    </div>
  )
}

function InspectedRecord({
  type,
  recordId,
  onOpenRelated,
  onClose,
}: {
  type: ObjectType
  recordId: string
  onOpenRelated: (type: ObjectType, recordId: string) => void
  onClose: () => void
}) {
  const { life } = useCrmScope()
  const access = accessFor(life, type)
  const query = useCrmRecord(access.read ? type : undefined, recordId)
  const writes = useCrmWrites(type)
  const noun = type.label_singular.toLowerCase()
  const state = (title: string, text?: string, retry = false) => (
    <Centered title={title} role={retry ? 'alert' : 'status'}>
      {text && <p className={detail}>{text}</p>}
      <div className="flex gap-2">
        {retry && (
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </Centered>
  )
  if (!access.read || query.error instanceof RecordAccessError)
    return state(
      `${type.label_plural} are not available to this sign-in.`,
      'This record may exist; this sign-in is not allowed to read it.',
    )
  if (query.data)
    return (
      <RecordPreview
        type={type}
        record={query.data}
        writes={writes}
        writable={access.write}
        onClose={onClose}
        onOpenRelated={onOpenRelated}
        fill
      />
    )
  if (query.error instanceof RecordMissingError)
    return state(
      `This ${noun} is not here.`,
      'It may have been deleted, or the link may be to a record in another workspace.',
    )
  if (query.isError)
    return state(
      `This ${noun} could not be loaded.`,
      crmErrorText(query.error, type),
      true,
    )
  return state(`Loading ${noun}`)
}

const FIRST_RUN_LABEL: Record<(typeof BUILT_IN)[number], [string, string]> = {
  person: ['People', 'Who you know, and how to reach them.'],
  organization: ['Organizations', 'Where people work and who you deal with.'],
  relationship: [
    'Relationships',
    'How people and organizations are related, to you and to each other.',
  ],
  activity: ['Activities', 'Projects, trips and events under way.'],
  commitment: ['Commitments', 'What is owed, by whom, and when.'],
  interaction: ['Interactions', 'Meetings, calls and messages that happened.'],
  goal: ['Goals', 'What someone is trying to reach.'],
  constraint: [
    'Constraints',
    'Limits to respect: availability, budget, preferences.',
  ],
}

/** Nothing is declared yet: say what will be added, and add it on request. */
function FirstRun({ scope }: { scope: CrmScope }) {
  const install = useInstallLifeContextTypes()
  const { openType } = useCrmNavigate()
  const others = scope.types
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto bg-background px-6 py-10">
      <div className="flex w-full max-w-md flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-[20px] leading-7 font-medium text-ink">
            Keep track of the people and promises in your life
          </h1>
          <p className="text-[13px] leading-5 text-ink-muted">
            Theorem can hold these as records you edit here. When you ask it
            something, it reads the saved records that bear on the question and
            shows you which ones it used. Any record can be kept private.
          </p>
        </div>
        <ul className="flex flex-col rounded-md border border-separator">
          {BUILT_IN.map((name) => (
            <li
              key={name}
              className="flex items-center gap-2.5 border-b border-separator px-3 py-2 last:border-b-0"
            >
              <BuiltInIcon name={name} className="text-ink-muted" />
              <span className="w-28 shrink-0 text-[13px] font-medium text-ink">
                {FIRST_RUN_LABEL[name][0]}
              </span>
              <span className="min-w-0 flex-1 text-xs leading-5 text-ink-muted">
                {FIRST_RUN_LABEL[name][1]}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2">
          <Button
            className="self-start"
            disabled={install.isPending}
            onClick={() => install.mutate()}
          >
            {install.isPending
              ? 'Adding'
              : 'Add people, organizations, commitments…'}
          </Button>
          {install.isError && (
            <p role="alert" className="text-xs leading-5 text-error-ink">
              Nothing was added. {crmErrorText(install.error, undefined)}
            </p>
          )}
          {others.length > 0 && (
            <p className="text-xs leading-5 text-ink-muted">
              Or open a type you already have:{' '}
              {others.map((type, index) => (
                <span key={type.object_type_id}>
                  {index > 0 && ', '}
                  <button
                    type="button"
                    className="rounded-sm text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
                    onClick={() => void openType(type)}
                  >
                    {type.label_plural}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
