// SOURCING: the Work owner's agent assignments (./source assignAgent and listAgents, POST /api/work/v1/items/:id/agent-assignments) and the run owner's snapshot and cancel (@theoremharness/sdk chat.runs.get and chat.runs.cancel through lib/theorem/client); the picker is ./pickers' OptionPicker. A run is only ever started by the person's choice here, and the Work owner deduplicates it
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { describeError, hasStatus, mutate, theorem } from '@/lib/theorem/client'
import type { AssignAgentInput, WorkItem } from './contract'
import { ThreadLink } from './marks'
import { OptionPicker } from './pickers'
import { useAssignAgent, useWorkAgents } from './queries'
import { useWorkSource } from './source'

/** What a run is doing, from its owner's snapshot. */
export function runPhase(snapshot: { status: string; terminal: boolean }) {
  if (!snapshot.terminal) return 'Working'
  if (snapshot.status === 'cancelled') return 'Stopped'
  if (snapshot.status === 'failed') return 'Failed'
  return 'Finished'
}

/** The refusal that means an agent is still working on the item. */
const stillRunning = (error: unknown) =>
  hasStatus(error, 409) &&
  (error as { body?: { code?: unknown } }).body?.code === 'work_agent_running'

function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: ['theorem', 'chat', 'run', runId],
    queryFn: () => theorem().chat.runs.get({ runId: runId!, limit: 1 }),
    enabled: !!runId,
    // A live run is read again until it ends; reading never starts or stops it.
    refetchInterval: (query) =>
      query.state.data?.terminal === false ? 3000 : false,
  })
}

/**
 * The agent working on an item: the linked run's state with a Stop the run
 * owner honours, and an assignment that starts one. Leaving the item never
 * stops the run (AGENT-03); a second assignment while one works says so and
 * stops it only when the person asks (AGENT-02).
 */
export function AgentRow({ item }: { item: WorkItem }) {
  const source = useWorkSource()
  const agents = useWorkAgents()
  const assign = useAssignAgent(item.id)
  const run = useRun(item.runId)
  const [anchor, setAnchor] = useState<Element | null>(null)
  const [blocked, setBlocked] = useState<AssignAgentInput>()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()

  const canAssign = !!source.assignAgent && !!source.listAgents
  if (!item.runId && !canAssign) return null
  const live = run.data?.terminal === false

  const send = (input: AssignAgentInput) => {
    setError(undefined)
    setBlocked(undefined)
    assign.mutate(
      { input, revision: item.revision },
      {
        onError: (failure) =>
          stillRunning(failure)
            ? setBlocked(input)
            : setError(describeError(failure)),
      },
    )
  }

  const stop = async () => {
    if (!item.runId) return
    setStopping(true)
    setError(undefined)
    try {
      await mutate((headers) =>
        theorem().chat.runs.cancel({
          runId: item.runId!,
          ...headers,
          reason: 'Stopped from its Work item',
        }),
      )
      await run.refetch()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setStopping(false)
    }
  }

  const available = (agents.data ?? []).filter((agent) => agent.available)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {item.runId && (
          <span className="inline-flex items-center gap-1 px-1.5 text-sm text-ink-muted">
            {run.data ? runPhase(run.data) : run.isError ? 'Unknown' : '…'}
          </span>
        )}
        {item.threadId && (
          <ThreadLink
            threadId={item.threadId}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-link hover:bg-hover"
          >
            <Icon.Conversation className="size-3.5 shrink-0" />
            <span>Open</span>
          </ThreadLink>
        )}
        {live && (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            onClick={() => void stop()}
          >
            Stop
          </Button>
        )}
        {canAssign && (
          <Button
            size="sm"
            variant="ghost"
            disabled={assign.isPending || !available.length}
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            {item.runId ? 'Assign again' : 'Assign agent'}
          </Button>
        )}
      </div>
      {blocked && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-1 px-1.5 text-sm text-ink-muted"
        >
          <span>An agent is still working on this.</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => send({ ...blocked, replaceRunning: true })}
          >
            Stop it and assign
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setBlocked(undefined)}
          >
            Keep it
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-1.5 text-sm text-error-ink">
          {error}
        </p>
      )}
      <OptionPicker
        anchor={anchor}
        onClose={() => setAnchor(null)}
        options={available.map((agent) => ({
          value: agent.id,
          label: agent.label,
        }))}
        chosen={[]}
        placeholder="Assign an agent..."
        onChoose={(agentId) => {
          setAnchor(null)
          if (agentId) send({ agentId })
        }}
      />
    </div>
  )
}
