// SOURCING: the CRM's own table and record page (./crm-table, ./record-page); Twenty's empty workspace for the first-run state's shape (what will be added, one button); the schema register's reading (components/records/queries) and what this sign-in may do (lifeContext); the app's Button
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useDataModel } from '@/components/records/queries'
import { Button } from '@/components/ui/button'
import { describeError, isSignedOut, withoutCode } from '@/lib/theorem/client'
import { CrmScopeProvider, useCrmScopeValue } from './context'
import type { CrmScope } from './context'
import { CrmTable } from './crm-table'
import { BUILT_IN, typeBySlug } from './model'
import { useCrmNavigate, useCrmPlace } from './navigation'
import { useInstallLifeContextTypes, useLifeContext } from './queries'
import { crmErrorText } from './record-fields'
import { RecordPage } from './record-page'
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
      className="flex h-full flex-col items-center justify-center gap-2 bg-background px-6 text-center"
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      {children}
    </div>
  )
}

const detail = 'max-w-sm text-xs leading-5 text-ink-muted'

/** CRM mode: one type's table, one record's page, or how to begin. */
export function CrmView() {
  const scope = useCrmScopeValue()
  const model = useDataModel()
  const life = useLifeContext()
  const { slug, recordId } = useCrmPlace()
  const { openType } = useCrmNavigate()
  const type = typeBySlug(scope.types, slug)
  const first = scope.types[0]
  // Some of the built-in types are here, whether or not all of them are.
  const installed = scope.life?.started === true

  // /crm itself is the first listed type's table, once there is one to show.
  const redirect = !slug && installed && first ? first : undefined
  useEffect(() => {
    if (redirect) void openType(redirect, { replace: true })
  }, [redirect, openType])

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

  return (
    <CrmScopeProvider value={scope}>
      {!slug ? (
        installed ? (
          <Centered title="Loading" />
        ) : (
          <FirstRun scope={scope} />
        )
      ) : !type ? (
        <Centered
          title={`There is no record type called “${decodeURIComponent(slug)}”.`}
        >
          <p className={detail}>
            It may have been retired or renamed. Choose a type from the list.
          </p>
        </Centered>
      ) : recordId ? (
        <RecordPage
          key={`${type.object_type_id}:${recordId}`}
          type={type}
          recordId={recordId}
        />
      ) : (
        <CrmTable key={type.object_type_id} type={type} />
      )}
    </CrmScopeProvider>
  )
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
