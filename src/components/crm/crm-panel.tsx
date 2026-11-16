// SOURCING: Twenty's navigation drawer for the anatomy (the workspace switcher, then one row per record type with its mark, plural label and count); the Index panel's rows for the geometry and states (components/index/index-panel), so the CRM's list reads as the app's other panels do; lucide-react marks
import { useNavigate } from '@tanstack/react-router'
import { Database, EyeOff, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { DATA_MODEL_VIEW_ID } from '@/components/index/programs'
import type { ObjectType } from '@/components/records/contract'
import { recordTitle } from '@/components/records/model'
import { YouBadge } from './cells'
import { CrmScopeProvider, useCrmScope, useCrmScopeValue } from './context'
import { personType, typeBySlug } from './model'
import { useCrmNavigate, useCrmPlace } from './navigation'
import { TypeIcon } from './type-icons'

const ROW =
  'group relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-sm transition-colors duration-100 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus data-active:bg-pill data-active:shadow-pill'
const COUNT = 'shrink-0 text-[11px] text-ink-faint-sheet tabular-nums'
const NUMBER = new Intl.NumberFormat('en-US')

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-7 items-center px-2 pt-3 pb-1">
      <h2 className="min-w-0 flex-1 text-xs text-ink-faint-sheet">
        {children}
      </h2>
    </div>
  )
}

/** The CRM's contextual navigation: who you are, the record types, the data model. */
export function CrmPanel({ switcher }: { switcher: ReactNode }) {
  const scope = useCrmScopeValue()
  return (
    <CrmScopeProvider value={scope}>
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center px-1.5">
          <div className="min-w-0 flex-1">{switcher}</div>
        </div>
        <nav
          aria-label="CRM"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3"
        >
          <Me />
          <Types />
          <span className="min-h-3 flex-1" />
          <DataModelLink />
        </nav>
      </div>
    </CrmScopeProvider>
  )
}

/** The signed-in person's own record, or why there is none yet. */
function Me() {
  const { life, types, selfId, recordById } = useCrmScope()
  const { recordId } = useCrmPlace()
  const { openRecord, openType } = useCrmNavigate()
  const people = personType(types)
  if (!life?.installed || !people) return null
  const self = selfId ? recordById(selfId) : undefined
  const mark = (
    <UserRound aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
  )

  if (selfId)
    return (
      <button
        type="button"
        className={ROW}
        data-active={recordId === selfId || undefined}
        aria-current={recordId === selfId ? 'page' : undefined}
        onClick={() => void openRecord(people, selfId)}
      >
        {mark}
        <span className="min-w-0 flex-1 truncate">
          {self ? recordTitle(people, self) : 'Me'}
        </span>
        <YouBadge />
      </button>
    )
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className={ROW}
        onClick={() => void openType(people)}
      >
        {mark}
        <span className="min-w-0 flex-1 truncate">Me</span>
        <span className={COUNT}>Not set</span>
      </button>
      <p className="px-2 pt-0.5 pb-1 text-xs leading-5 text-ink-faint-sheet">
        {life.self.state === 'unavailable'
          ? 'This sign-in names a workspace but not a person, so no record can be marked as you.'
          : 'Open your own record under People and choose “This is me”, so Theorem knows who is asking.'}
      </p>
    </div>
  )
}

function Types() {
  const { life, types, countOf, statusOf, model } = useCrmScope()
  const { slug } = useCrmPlace()
  const { openType } = useCrmNavigate()
  const current = typeBySlug(types, slug)
  if (!model)
    return (
      <p role="status" className="px-2 py-1 text-sm text-ink-faint-sheet">
        Loading
      </p>
    )
  if (!life?.installed && !types.length) return null
  return (
    <>
      <Heading>Records</Heading>
      {types.map((type) => (
        <TypeRow
          key={type.object_type_id}
          type={type}
          active={current?.object_type_id === type.object_type_id}
          count={countOf(type) ?? type.record_count}
          denied={statusOf(type) === 'denied'}
          onOpen={() => void openType(type)}
        />
      ))}
    </>
  )
}

function TypeRow({
  type,
  active,
  count,
  denied,
  onOpen,
}: {
  type: ObjectType
  active: boolean
  count: number | undefined
  denied: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={ROW}
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
    >
      <TypeIcon type={type} />
      <span className="min-w-0 flex-1 truncate">{type.label_plural}</span>
      {denied ? (
        <span
          className="flex shrink-0 items-center text-ink-muted"
          title="Not available to this sign-in"
        >
          <EyeOff aria-hidden className="size-3.5" />
          <span className="sr-only">Not available to this sign-in</span>
        </span>
      ) : (
        typeof count === 'number' && (
          <span
            className={COUNT}
            aria-label={`${NUMBER.format(count)} records`}
          >
            {NUMBER.format(count)}
          </span>
        )
      )}
    </button>
  )
}

/** Where the types themselves are declared and changed. */
function DataModelLink() {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className={ROW}
      onClick={() =>
        void navigate({ to: '/index', search: { view: DATA_MODEL_VIEW_ID } })
      }
    >
      <Database aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Data model</span>
    </button>
  )
}
