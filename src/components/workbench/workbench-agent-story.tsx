// SOURCING: none — the story for the agent's two workbench operations: the real wasm workbench (FixtureStory over the fixture host) and the real page path (useWorkbenchRequests reading pending `client_operation` parts off a thread, answering through serveWorkbenchRequests); only the thread (a fake source holding messages the scenario sets) and the SDK's receipt command (a recorder) are stood in. Messages are built the way lib/workbench/agent/operations.test.ts builds them, with @theoremharness/sdk's toAssistantMessages.
import type { ThreadMessage } from '@assistant-ui/react'
import type { Theorem } from '@theoremharness/sdk'
import { toAssistantMessages } from '@theoremharness/sdk/assistant-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  workbenchTurnOptions,
  useWorkbenchRequests,
} from '@/lib/workbench/agent/operations'
import type {
  WorkbenchReceipt,
  WorkbenchRequest,
} from '@/lib/workbench/agent/operations'
import { setWorkbenchHandle, useWorkbenchAgent } from '@/lib/workbench/agent/store'
import type { Effect, SemanticTree } from '@/lib/workbench/wire'
import { EVERY_TOOL, FixtureStory } from './workbench-story'

/** What the scenario reads and drives, on `window.__agentOps`. */
interface AgentOps {
  /** Puts one pending request on a message of `runId` and resolves with the receipt the page posted for it. */
  ask: (
    runId: string,
    operation: string,
    args: Record<string, unknown>,
  ) => Promise<WorkbenchReceipt>
  /** The operations a send would declare right now. */
  declared: () => string[]
  /** Takes the workbench off the page, or puts it back. */
  show: (shown: boolean) => void
  /**
   * Story stand-in, only for the over-long read: the real tree repeated `copies` times under new ids, so it
   * outgrows the bound (the fixture workbench's own tree is about 20 KB, the bound 40 KB). 0 puts the real handle back.
   */
  inflate: (copies: number) => void
  /** Every effect the core asked the host for, with who it was for. */
  effects: () => Array<{ kind: string; actor: unknown }>
}

declare global {
  interface Window {
    __agentOps?: AgentOps
  }
}

const message = (
  runId: string,
  requestRef: string,
  operation: string,
  args: Record<string, unknown>,
): ThreadMessage => {
  const [mapped] = toAssistantMessages([
    {
      messageId: `live_${requestRef}`,
      role: 'assistant',
      createdAtMs: 0,
      parts: [
        {
          partId: `part_${requestRef}`,
          type: 'client_operation',
          payload: {
            type: 'client_operation',
            partId: `part_${requestRef}`,
            requestRef,
            operation,
            args,
            expectedRevision: 0,
            state: 'pending',
          },
        },
      ],
    } as unknown as Theorem.Message,
  ])
  return {
    ...mapped,
    metadata: { custom: { theoremRunId: runId } },
  } as unknown as ThreadMessage
}

/** `JSON.stringify` cut to a line the panel can show. */
const brief = (value: unknown, max = 150) => {
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

interface Line {
  request: WorkbenchRequest
  receipt?: WorkbenchReceipt
}

/**
 * `workbench-agent-operations`: the ordinary fixture workbench with a panel beside it that lists the
 * requests the agent's operations were asked and the receipts they got. A scenario drives the page path
 * through `window.__agentOps`.
 */
export function WorkbenchAgentOperationsStory() {
  const [shown, setShown] = useState(true)
  const [lines, setLines] = useState<Line[]>([])
  const messages = useRef<ThreadMessage[]>([])
  const listeners = useRef(new Set<() => void>())
  const waiting = useRef(new Map<string, (receipt: WorkbenchReceipt) => void>())
  const effects = useRef<Array<{ kind: string; actor: unknown }>>([])
  const count = useRef(0)
  const realHandle = useRef<ReturnType<typeof useWorkbenchAgent.getState>['handle']>(undefined)

  const source = useMemo(
    () => ({
      thread: {
        getState: () => ({ messages: messages.current, isRunning: true }),
        subscribe: (callback: () => void) => {
          listeners.current.add(callback)
          return () => listeners.current.delete(callback)
        },
      },
    }),
    [],
  )
  // The SDK's receipt command stands in as this recorder.
  const post = useCallback(
    (request: WorkbenchRequest, receipt: WorkbenchReceipt) => {
      setLines((held) =>
        held.map((line) =>
          line.request.requestRef === request.requestRef
            ? { ...line, receipt }
            : line,
        ),
      )
      waiting.current.get(request.requestRef)?.(receipt)
      return Promise.resolve()
    },
    [],
  )
  useWorkbenchRequests(source, post)

  useEffect(() => {
    window.__agentOps = {
      ask: (runId, operation, args) => {
        const requestRef = `req_${(count.current += 1)}`
        setLines((held) => [
          ...held,
          {
            request: {
              runId,
              requestRef,
              operation,
              args,
              expectedRevision: 0,
            },
          },
        ])
        return new Promise<WorkbenchReceipt>((resolve) => {
          waiting.current.set(requestRef, resolve)
          messages.current = [message(runId, requestRef, operation, args)]
          for (const listener of listeners.current) listener()
        })
      },
      declared: () =>
        workbenchTurnOptions().clientOperations.map((operation) => operation.name),
      show: setShown,
      inflate: (copies) => {
        const real = realHandle.current ?? useWorkbenchAgent.getState().handle
        if (!real) return
        realHandle.current = real
        if (copies === 0) return setWorkbenchHandle(real)
        setWorkbenchHandle({
          semantics: () => {
            const tree = JSON.parse(real.semantics()) as SemanticTree
            const nodes = [...tree.nodes]
            for (let copy = 1; copy <= copies; copy++)
              for (const node of tree.nodes)
                nodes.push({ ...node, id: `${node.id}#${copy}` })
            return JSON.stringify({ ...tree, nodes })
          },
          agent_catalog: () => real.agent_catalog?.() ?? '[]',
          agent_act: (action, runId, panel) =>
            real.agent_act?.(action, runId, panel) ?? '',
        })
      },
      effects: () => effects.current,
    }
    return () => {
      window.__agentOps = undefined
    }
  }, [])

  const record = useCallback((effect: Effect) => {
    effects.current.push({ kind: effect.kind, actor: effect.actor ?? null })
  }, [])

  return (
    <div className="flex">
      {shown ? (
        <FixtureStory
          id="workbench-agent-operations"
          width={1280}
          height={640}
          options={{ granted: EVERY_TOOL, transcript: true }}
          script={[]}
          wait={['README.md']}
          onEffect={record}
        />
      ) : (
        <div className="h-[640px] w-[1280px] bg-term" />
      )}
      <div
        data-agent-panel=""
        className="h-[640px] w-[320px] overflow-hidden border-s border-term-line bg-term p-3 font-mono text-[0.78125rem] text-term-ink"
      >
        <p className="text-term-muted">
          workbench on screen: {shown ? 'yes' : 'no'}
        </p>
        {lines.slice(-6).map((line) => (
          <div key={line.request.requestRef} className="mt-2">
            <p>
              {line.request.runId} {line.request.operation}
            </p>
            <p className="text-term-muted">{brief(line.request.args, 70)}</p>
            <p>
              {line.receipt
                ? `${line.receipt.outcome}: ${line.receipt.reason ?? brief(line.receipt.result, 90)}`
                : 'waiting'}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
