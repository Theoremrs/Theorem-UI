// SOURCING: Twenty's navigation drawer for the anatomy (one row per record type with its mark, plural label and count), drawn inside the Index panel (components/index/index-panel) with its rows' geometry and states; lucide-react marks
import { useNavigate, useSearch } from '@tanstack/react-router'
import { EyeOff, Plus, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { useIndexNavigate } from '@/components/index/navigation'
import { RECORDS_HOME_VIEW_ID } from '@/components/index/programs'
import type { ObjectType } from '@/components/records/contract'
import { recordTitle } from '@/components/records/model'
import { Button } from '@/components/ui/button'
import { YouBadge } from './cells'
import { CrmNavigationBoundary, useCrmScope } from './context'
import { accessFor, personType, typeByName } from './model'
import { useCrmNavigate, useCrmPlace } from './navigation'
import { useCrmRecord, useInstallLifeContextTypes } from './queries'
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

/**
 * The records part of the Index panel: who you are, each record type with its
 * count, and adding the built-in types. Each opens in the Index.
 */
export function RecordsSection() {
  return (
    <CrmNavigationBoundary>
      <Me />
      <Types />
    </CrmNavigationBoundary>
  )
}

/** The signed-in person's own record, or why there is none yet. */
function Me() {
  const { life, types, selfId, recordById } = useCrmScope()
  const { recordId } = useCrmPlace()
  const { openRecord } = useCrmNavigate()
  const navigate = useNavigate()
  const people = personType(types)
  // Only the signed-in person's own record is read here, not every person.
  const read = useCrmRecord(
    selfId && accessFor(life, people).read ? people : undefined,
    selfId ?? '',
  )
  if (!life?.started || !people) return null
  const self = (selfId ? recordById(selfId) : undefined) ?? read.data
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
        onClick={() => void navigate({ to: '/settings/profile' })}
      >
        {mark}
        <span className="min-w-0 flex-1 truncate">Me</span>
        <span className={COUNT}>Not set</span>
      </button>
      <p className="px-2 pt-0.5 pb-1 text-xs leading-5 text-ink-faint-sheet">
        {life.self.state === 'unavailable'
          ? 'This sign-in names a workspace but not a person, so no record can be marked as you.'
          : 'Say which person you are in Settings, under Profile, so Theorem knows who is asking.'}
      </p>
    </div>
  )
}

function Types() {
  const { life, types, countOf, statusOf, model, modelRead } = useCrmScope()
  const { nameSingular, recordId } = useCrmPlace()
  const { openType } = useCrmNavigate()
  const navigate = useIndexNavigate()
  const atHome = useSearch({ strict: false }).view === RECORDS_HOME_VIEW_ID
  // A type's row is current at its table, not at one of its records' pages.
  const current = recordId ? undefined : typeByName(types, nameSingular)
  if (!model && modelRead.failed)
    return (
      <div role="alert" className="flex flex-col items-start gap-1 px-2 py-1">
        <p className="text-sm text-ink">Your records could not be read.</p>
        <Button size="xs" variant="ghost" onClick={modelRead.retry}>
          Try again
        </Button>
      </div>
    )
  if (!model)
    return (
      <p role="status" className="px-2 py-1 text-sm text-ink-faint-sheet">
        Loading
      </p>
    )
  if (!life?.started && !types.length)
    return (
      <>
        <Heading>Records</Heading>
        <button
          type="button"
          className={ROW}
          data-active={atHome || undefined}
          aria-current={atHome ? 'page' : undefined}
          onClick={() =>
            void navigate.openView(RECORDS_HOME_VIEW_ID, { kind: 'home' })
          }
        >
          <Plus aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            People, organizations, commitments…
          </span>
        </button>
      </>
    )
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
      {life?.started && life.missing.length > 0 && (
        <AddMissing missing={life.missing} />
      )}
    </>
  )
}

/**
 * A workspace set up before a built-in type existed does not have it. Adding
 * declares only what is absent and leaves every existing type as it is.
 */
function AddMissing({ missing }: { missing: string[] }) {
  const install = useInstallLifeContextTypes()
  const what =
    missing.length === 1
      ? `Add the ${missing[0]} type`
      : `Add ${missing.length} new record types`
  return (
    <>
      <button
        type="button"
        className={ROW}
        disabled={install.isPending}
        title={missing.join(', ')}
        onClick={() => install.mutate()}
      >
        <Plus aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {install.isPending ? 'Adding' : what}
        </span>
      </button>
      {install.error && (
        <p role="alert" className="px-2 py-1 text-xs leading-4 text-ink">
          It could not be added. Try again.
        </p>
      )}
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
