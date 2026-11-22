// SOURCING: @tanstack/react-query (the run list as an infinite query over the server's cursor,
// polled and refetched on focus, as queries.ts holds the instance's rows), the app's Button, the
// native select styling pages/resource-field.tsx uses, and states.tsx's StatusLine. Every fetch is
// lib/capabilities/api; the words for statuses and triggers are lib/capabilities/rules.
import { useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Icon } from '@/components/icons'
import { fieldControl } from '@/components/pages/resource-field'
import { Button } from '@/components/ui/button'
import {
  listRuns,
  readRun,
  retryRun,
  ruleRefusalMessage,
  runRuleNow,
} from '@/lib/capabilities/api'
import type { DescribeResult, RuleRun } from '@/lib/capabilities/contract'
import {
  canRetry,
  describeRunStatus,
  describeRunTrigger,
  mayRunInBackground,
  rulesOf,
} from '@/lib/capabilities/rules'
import { capabilityKeys } from './queries'
import { StatusLine } from './states'
import type { Status } from './states'

/** How often an open history asks again; the worker steps every 5 s. */
export const RUNS_POLL_MS = 10_000

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Under the instance's key, so a write that refreshes the instance refreshes its
 * runs too.
 */
const runsKey = (instanceId: string, ruleKey: string) =>
  [...capabilityKeys.instance(instanceId), 'runs', ruleKey] as const

function RunDetail({
  instanceId,
  runId,
}: {
  instanceId: string
  runId: string
}) {
  const read = useQuery({
    queryKey: [...capabilityKeys.instance(instanceId), 'run', runId],
    queryFn: () => readRun(instanceId, runId),
    refetchInterval: RUNS_POLL_MS,
  })
  if (read.isError)
    return (
      <p className="text-xs text-error-ink">
        {ruleRefusalMessage(read.error, 'Reading the run')}
      </p>
    )
  const run = read.data
  if (!run) return <p className="text-xs text-ink-faint">Reading the run…</p>
  return (
    <div
      aria-label={`Run ${run.runId} in detail`}
      className="mt-2 flex flex-col gap-1 rounded-md bg-raised p-2 text-xs text-ink-muted"
    >
      <p>
        Runs as {run.runAs} · definition {run.definitionId}
        {run.cause.chain.length > 0 &&
          ` · started by ${run.cause.chain.join(' → ')} (depth ${run.cause.depth})`}
      </p>
      {run.attempts.length ? (
        <ol className="flex flex-col gap-0.5">
          {run.attempts.map((attempt) => (
            <li key={attempt.attempt}>
              Attempt {attempt.attempt} · {attempt.invocationKey} · journal{' '}
              {attempt.journalId} · started {iso(attempt.startedAtMs)}
              {attempt.finishedAtMs === undefined
                ? ' · not finished'
                : ` · finished ${iso(attempt.finishedAtMs)}`}
              {attempt.outcomeCode && ` · ${attempt.outcomeCode}`}
            </li>
          ))}
        </ol>
      ) : (
        <p>No attempt was made.</p>
      )}
    </div>
  )
}

/** The line under a run's status: its trigger, its attempts and their outcomes, and when it was queued, finished or tries next. */
function runSummary(run: RuleRun) {
  const count = run.attempts.length
  const outcomes = run.attempts.flatMap((one) =>
    one.outcomeCode ? [one.outcomeCode] : [],
  )
  return [
    `${describeRunTrigger(run.trigger)} · ${count} ${count === 1 ? 'attempt' : 'attempts'}`,
    outcomes.length > 0 ? ` (${outcomes.join(', ')})` : '',
    ` · Queued ${iso(run.createdAtMs)}`,
    run.finishedAtMs !== undefined
      ? ` · Finished ${iso(run.finishedAtMs)}`
      : '',
    run.status === 'pending' && count > 0
      ? ` · Next attempt ${iso(run.nextAttemptAtMs)}`
      : '',
  ].join('')
}

function RunItem({
  run,
  label,
  inspecting,
  mayRetry,
  busy,
  onInspect,
  onRetry,
  instanceId,
}: {
  run: RuleRun
  label: string
  inspecting: boolean
  mayRetry: boolean
  busy: boolean
  onInspect: () => void
  onRetry: () => void
  instanceId: string
}) {
  return (
    <li aria-label={`Run ${run.runId}`} className="py-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">
            {label} <span className="text-xs text-ink-faint">{run.runId}</span>
          </p>
          <p className="text-xs text-ink-muted">{describeRunStatus(run)}</p>
          <p className="text-xs text-ink-faint">{runSummary(run)}</p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Inspect run ${run.runId}`}
          aria-expanded={inspecting}
          onClick={onInspect}
        >
          <Icon.History className="size-3.5" />
          {inspecting ? 'Hide' : 'Inspect'}
        </Button>
        {mayRetry && canRetry(run) && (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Retry run ${run.runId}`}
            disabled={busy}
            onClick={onRetry}
          >
            <Icon.Refresh className="size-3.5" />
            Retry
          </Button>
        )}
      </div>
      {inspecting && <RunDetail instanceId={instanceId} runId={run.runId} />}
    </li>
  )
}

/**
 * One rule's runs, or every rule's, page by page over the server's cursor:
 * polled while shown and read again on focus.
 */
function useRunPages(instanceId: string, ruleKey: string) {
  const runs = useInfiniteQuery({
    queryKey: runsKey(instanceId, ruleKey),
    queryFn: ({ pageParam }) =>
      listRuns(instanceId, {
        ...(ruleKey ? { ruleKey } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: RUNS_POLL_MS,
    refetchOnWindowFocus: true,
  })
  return { runs, list: runs.data?.pages.flatMap((page) => page.runs) ?? [] }
}

/** The runs read so far, or why there are none, and the way to older ones. */
function RunList({
  runs,
  list,
  rules,
  inspecting,
  mayRetry,
  busy,
  instanceId,
  onInspect,
  onRetry,
}: {
  runs: ReturnType<typeof useRunPages>['runs']
  list: RuleRun[]
  rules: ReturnType<typeof rulesOf>
  inspecting: string | undefined
  mayRetry: boolean
  busy: boolean
  instanceId: string
  onInspect: (runId: string) => void
  onRetry: (runId: string) => void
}) {
  const labelOf = (key: string) =>
    rules.find((rule) => rule.key === key)?.label ?? key
  return (
    <>
      {runs.isError ? (
        <p className="text-sm text-error-ink">
          {ruleRefusalMessage(runs.error, 'Reading the runs')}
        </p>
      ) : runs.isPending ? (
        <p className="text-sm text-ink-faint">Reading the runs…</p>
      ) : list.length ? (
        <ul className="flex flex-col divide-y divide-separator">
          {list.map((run) => (
            <RunItem
              key={run.runId}
              run={run}
              label={labelOf(run.ruleKey)}
              inspecting={inspecting === run.runId}
              mayRetry={mayRetry}
              busy={busy}
              instanceId={instanceId}
              onInspect={() => onInspect(run.runId)}
              onRetry={() => onRetry(run.runId)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">No rule has run yet.</p>
      )}
      {runs.hasNextPage && (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          disabled={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          Older runs
        </Button>
      )}
    </>
  )
}

/**
 * An instance's rule runs as the server records them, newest first. The worker
 * owns every run, so nothing here holds one: the list is polled while open and
 * read again on focus or reopening, and a closed page changes nothing.
 */
export function RunHistory({
  instanceId,
  described,
}: {
  instanceId: string
  described: DescribeResult
}) {
  const { definition, callerGrant: grant } = described
  const rules = rulesOf(definition)
  const background = mayRunInBackground(grant)
  const mayRetry = grant.author || background
  const client = useQueryClient()
  const [ruleKey, setRuleKey] = useState('')
  const [inspecting, setInspecting] = useState<string>()
  const [status, setStatus] = useState<Status>()
  const [busy, setBusy] = useState(false)

  const { runs, list } = useRunPages(instanceId, ruleKey)

  const refresh = () =>
    client.invalidateQueries({
      queryKey: [...capabilityKeys.instance(instanceId), 'runs'],
    })

  const perform = async (what: string, call: () => Promise<RuleRun>) => {
    setBusy(true)
    setStatus({ kind: 'pending', message: `${what}…` })
    try {
      const run = await call()
      await refresh()
      setStatus({ kind: 'saved', message: `${what} · ${run.runId}` })
    } catch (error) {
      setStatus({ kind: 'failed', message: ruleRefusalMessage(error, what) })
    } finally {
      setBusy(false)
    }
  }

  const schedules = rules.filter((rule) => rule.trigger.kind === 'schedule')

  return (
    <div className="flex flex-col gap-2">
      <StatusLine
        status={status}
        onClear={() => setStatus(undefined)}
        onReload={() => void refresh()}
        onCheck={() => {}}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Runs of"
          className={fieldControl}
          value={ruleKey}
          onChange={(event) => {
            setRuleKey(event.target.value)
            setInspecting(undefined)
          }}
        >
          <option value="">Every rule</option>
          {rules.map((rule) => (
            <option key={rule.key} value={rule.key}>
              {rule.label}
            </option>
          ))}
        </select>
        {background &&
          schedules.map((rule) => (
            <Button
              key={rule.key}
              size="xs"
              variant="outline"
              aria-label={`Run ${rule.label} now`}
              disabled={busy}
              onClick={() =>
                void perform('Run started', () =>
                  runRuleNow(instanceId, rule.key),
                )
              }
            >
              <Icon.Play className="size-3.5" />
              Run now: {rule.label}
            </Button>
          ))}
      </div>
      {!background && schedules.length > 0 && (
        <p className="text-xs text-ink-faint">
          Running a rule by hand needs the background permission on your grant.
        </p>
      )}
      <RunList
        runs={runs}
        list={list}
        rules={rules}
        inspecting={inspecting}
        mayRetry={mayRetry}
        busy={busy}
        instanceId={instanceId}
        onInspect={(runId) =>
          setInspecting((open) => (open === runId ? undefined : runId))
        }
        onRetry={(runId) =>
          void perform('Retry queued', () => retryRun(instanceId, runId))
        }
      />
    </div>
  )
}
