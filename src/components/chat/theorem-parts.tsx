// SOURCING: @assistant-ui/react data renderers (useAssistantDataUI + dataRenderers.setFallbackDataUI), terminal/command-terminal (the agent terminal's Ratzilla view) for a call that runs a command, in the reply where it ran, @tanstack/react-router CatchBoundary per part, coss ui Collapsible (base-ui) for the activity line's details, shadcn Trace (ReUI, Base UI build) for the reply's tool calls folded into one summary row, and the installed ToolFallback / ApprovalCard / ThinkingIndicator / Reasoning elements, ui/button for the artifact card actions, the terminal's openOf/pathOf and Follow's useRevealFile for the file a tool card opens in the IDE, scene-part.tsx for the theorem-scene part, the CRM's context-manifest-part.tsx for the theorem-context_manifest part (the saved records a reply was given) and record-change-proposal-part.tsx for proposed record changes and their outcomes
//
// Theorem message parts that are not text or tool calls arrive as data parts
// named `theorem-<type>` (see @theoremharness/sdk/assistant-ui). This file
// renders them per the theorem-chat-v1 contract, renders Theorem's tool
// approvals (decided through runs.command, since Theorem owns approvals), and
// gives the artifact tools a pending card while they run. Delegated work has
// its own cards in delegation-parts.
import { useAui, useAuiState, useAssistantDataUI } from '@assistant-ui/react'
import { renderGenerativeUI } from '@assistant-ui/generative-ui/react'
import { styledGenerativeUILibrary } from '@/components/assistant-ui/elements/generative-ui'
import { a2uiActionMessage, openUrlOf, presentation } from '@/lib/generative/a2ui'
import type { GenerativeUIAction } from '@assistant-ui/generative-ui/react'
import { inVocabulary, PRESENT } from '@/lib/generative/operations'
import { CatchBoundary } from '@tanstack/react-router'
import type {
  AssistantState,
  DataMessagePartComponent,
  ToolCallMessagePartComponent,
} from '@assistant-ui/react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { FC, ReactNode } from 'react'
import { ApprovalCard } from '@/components/assistant-ui/elements/approval-card'
import type { ApprovalState } from '@/components/assistant-ui/elements/approval-card'
import { GlassCodeBlock } from '@/components/assistant-ui/elements/glass-code-block'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@/components/coss/collapsible'
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/assistant-ui/elements/reasoning'
import { ThinkingIndicator } from '@/components/assistant-ui/elements/thinking-indicator'
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui'
import { thingProps, toolState } from '@/lib/face/things'
import {
  ARTIFACT_PART,
  readArtifact,
} from '@/components/artifacts/artifact-model'
import { ArtifactMessage } from '@/components/artifacts/artifact-message'
import { DELEGATION_RENDERERS } from '@/components/chat/delegation-parts'
import { ContextManifestPart } from '@/components/crm/context-manifest-part'
import { SkillLoadPart } from '@/components/chat/skill-load-part'
import {
  RecordChangeOutcomePart,
  RecordChangeProposalPart,
} from '@/components/crm/record-change-proposal-part'
import { ProgramPart } from '@/components/chat/program-part'
import { CompletionFooter } from '@/components/chat/run-footer'
import { UserMarkdown } from '@/components/chat/user-markdown'
import { ReviewAnswerCard } from '@/components/review/review-card'
import { PlanToolCall } from '@/components/chat/plan-graph'
import { useRevealFile } from '@/components/ide/follow'
import { openOf, pathOf } from '@/components/terminal/terminal-code'
import {
  CommandTerminal,
  readCommand,
  readHostCommand,
} from '@/components/terminal/command-terminal'
import type { Open } from '@/components/terminal/terminal-code'
import { readScene, SCENE_PART } from '@/components/chat/scene-model'
import { SceneInReply } from '@/components/chat/scene-part'
import { Icon } from '@/components/icons'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { getToolCategoryIcon } from '@/components/ui/tool-calls-section-utils/tool-icons'
import { describeError, describeRunFailure } from '@/lib/theorem/client'
import {
  approvalChoice,
  approvalOutcome,
  readApproval,
  sendApprovalDecision,
} from '@/lib/theorem/approval'
import type {
  ApprovalChoice,
  ApprovalOutcome,
  TheoremApproval,
} from '@/lib/theorem/approval'
import { StoredAttachment } from '@/components/chat/stored-attachment'
import { DRAFT_PLAN } from '@/lib/theorem/plans'
import { cn, humanize } from '@/lib/utils'
import { appearancePair } from '@/lib/appearance-policy'

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/* ------------------------------------------------------------------ artifacts */

const ArtifactPart: DataMessagePartComponent = ({ data }) => {
  const artifact = readArtifact(data)
  return artifact ? (
    <ArtifactMessage
      key={`${artifact.artifactId}:${artifact.rendererId}:${artifact.documentId ?? ''}`}
      artifact={artifact}
    />
  ) : (
    <PartNotice name="theorem-artifact" />
  )
}

/** Stand-in card while an artifact tool runs; the artifact part replaces it. */
const ArtifactPendingCard: FC<{
  toolName: string
  title?: string
}> = ({ toolName, title }) => (
  <div className="my-3 flex w-full max-w-md items-center gap-3 rounded-artifact border border-separator bg-artifact p-4">
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-muted">
      <Icon.Artifact className="size-5 animate-float motion-reduce:animate-none" />
    </span>
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-medium">
        {title ?? 'Untitled artifact'}
      </span>
      <span className="shimmer text-xs text-ink-faint motion-reduce:animate-none">
        {toolName === 'update_artifact' ? 'Revising' : 'Writing'}
      </span>
    </span>
  </div>
)

const ArtifactToolFailed: FC<{ toolName: string }> = ({ toolName }) => (
  <p className="my-2 text-sm text-error-ink">
    {toolName === 'update_artifact' ? 'Updating' : 'Creating'} the artifact
    failed.
  </p>
)

/** create_artifact / update_artifact as tool-call parts. */
const ArtifactToolCall: ToolCallMessagePartComponent<{
  title?: string
  kind?: string
}> = ({ toolName, args, result, isError, status }) => {
  if (isError) return <ArtifactToolFailed toolName={toolName} />
  if (result !== undefined || status.type !== 'running') return null
  return <ArtifactPendingCard toolName={toolName} title={str(args.title)} />
}

const ARTIFACT_TOOLS = new Set(['create_artifact', 'update_artifact'])

/* -------------------------------------------------------------- tool calls */

/** A host call's state as its row says it: `HostCallState` in theorem-surface-contracts, read against the run. */
export type CallState =
  'running' | 'done' | 'failed' | 'interrupted' | 'awaiting'

/** One row of a reply's tool trace. */
export interface ToolCallEntry {
  tool_name: string
  /** The icon category the row wears. */
  tool_category: string
  /** What the call did, in words that follow its state. */
  message: string
  show_category?: boolean
  /** What the row opens to, when the call has something to show. */
  output?: string
  /** Trace's status: absent once the call is done. */
  status?: 'running' | 'error'
}

const TRACE_STATUS: Record<CallState, ToolCallEntry['status']> = {
  running: 'running',
  awaiting: 'running',
  failed: 'error',
  interrupted: 'error',
  done: undefined,
}

/**
 * `pending` and `awaiting_approval` are live only while the run is: a call
 * still in either once the run has stopped never finished, and is not done.
 */
export function hostCallState(
  state: string | undefined,
  running: boolean,
): CallState {
  if (state === 'resolved') return 'done'
  if (state === 'failed') return 'failed'
  if (!running) return 'interrupted'
  return state === 'awaiting_approval' ? 'awaiting' : 'running'
}

/** A verb while the call runs, once it has, and after "Could not". */
const VERBS = {
  search: ['Searching', 'Searched', 'search'],
  read: ['Reading', 'Read', 'read'],
} as const

/**
 * The agent's own functions in words (the verb, then what it acts on) and
 * the icon category their row wears. The catalog is open (a connector brings
 * its own tools), so a name outside this table keeps its own name and its row
 * says the state beside it.
 */
const CALLS: Record<
  string,
  readonly [keyof typeof VERBS, string, string] | undefined
> = {
  search_memory: ['search', 'memory', 'memory'],
  search_history: ['search', 'conversation history', 'history'],
  search_library: ['search', 'the Library', 'documents'],
  search_web: ['search', 'the web', 'web'],
  read_document: ['read', 'a document', 'documents'],
  read_file: ['read', 'a file', 'documents'],
}

const STATE_NOTE = {
  failed: 'failed',
  interrupted: 'did not finish',
  awaiting: 'waiting for your approval',
} as const

/** Memory's functions that keep their own names in a row and still wear memory's mark. */
const MEMORY_CALLS = new Set(['recall', 'encode'])

/** Kit's own moves. The fox on the stage shows them, so one that misses is a detail and never the run's news. */
const isKitCall = (name: string) => /^kit[._]/.test(name)

/** What a call's row says: "Searching memory…", "Searched memory", "Could not search memory". */
export function callWords(name: string, state: CallState): string {
  const known = CALLS[name]
  if (!known) {
    const own = humanize(name)
    if (state === 'done') return own
    return state === 'running' ? `${own}…` : `${own} · ${STATE_NOTE[state]}`
  }
  const [doing, did, bare] = VERBS[known[0]]
  const what = known[1]
  if (state === 'done') return `${did} ${what}`
  if (state === 'failed') return `Could not ${bare} ${what}`
  if (state === 'running') return `${doing} ${what}…`
  return `${doing} ${what} · ${STATE_NOTE[state]}`
}

/** The icon category a call's row wears. */
function callCategory(name: string): string {
  const known = CALLS[name]
  if (known) return known[2]
  if (isKitCall(name)) return 'kit'
  return MEMORY_CALLS.has(name) ? 'memory' : 'unknown'
}

type DataPartLike = { type: string; name?: string; data?: unknown }

/** The reply's host calls, less the artifact calls and the commands: their card and their terminal are the reply's. */
function hostCalls(
  content: readonly DataPartLike[],
  running: boolean,
): Array<{ name: string; state: CallState }> {
  return content.flatMap((part) => {
    if (part.type !== 'data' || part.name !== 'theorem-host_call') return []
    const call = object(part.data)
    const name = str(call.name) ?? 'host call'
    if (ARTIFACT_TOOLS.has(name) || readHostCommand(call)) return []
    return [{ name, state: hostCallState(str(call.state), running) }]
  })
}

/**
 * A reply's routine work as the tool-calls section lists it: each host call
 * in words that follow its state, and each check of an App with the problems
 * it found as the row's output.
 */
export function toolCallEntries(
  content: readonly DataPartLike[],
  running: boolean,
): ToolCallEntry[] {
  return content.flatMap((part): ToolCallEntry[] => {
    if (part.type !== 'data') return []
    if (part.name === 'theorem-host_call')
      return hostCalls([part], running).map(({ name, state }) => ({
        tool_name: name,
        tool_category: callCategory(name),
        message: callWords(name, state),
        show_category: false,
        ...(TRACE_STATUS[state] && { status: TRACE_STATUS[state] }),
      }))
    if (part.name !== 'theorem-client_operation') return []
    const check = appCheckSummary(part.data, running)
    if (!check) return []
    // Why the check fell short, then what it found.
    const output = [check.reason, appCheckProblems(part.data)]
      .filter(Boolean)
      .join('\n')
    return [
      {
        tool_name: 'app.check',
        tool_category: 'development',
        message: check.words,
        show_category: false,
        ...(output && { output }),
      },
    ]
  })
}

/**
 * A host function called by the native agent's program. An artifact call is
 * drawn here, by the artifact card that carries its result, and a command in
 * its terminal, printing as it runs; every other call is a row of the
 * tool-calls section under the activity line.
 */
const HostCallPart: DataMessagePartComponent = ({ data }) => {
  const call = object(data)
  const name = str(call.name) ?? 'host call'
  const running = useAuiState((s) => s.message.status?.type === 'running')
  // The agent retries a failed artifact call; once one lands, the miss is noise.
  const produced = useAuiState((s) =>
    s.message.content.some(
      (part) => part.type === 'data' && part.name === ARTIFACT_PART,
    ),
  )
  const state = hostCallState(str(call.state), running)
  const command = readHostCommand(call)
  if (command) return <CommandTerminal {...command} state={state} />
  if (!ARTIFACT_TOOLS.has(name)) return null
  if (state === 'running') return <ArtifactPendingCard toolName={name} />
  if (state === 'failed' && !produced)
    return <ArtifactToolFailed toolName={name} />
  return null
}

/**
 * What the row for an `app.check` request says, or null for any other
 * operation. `wrong` is anything short of a check that was made and found
 * nothing: a type check that could not be made found nothing either, and says
 * so with its `reason`.
 */
export function appCheckSummary(
  data: unknown,
  running: boolean,
): { words: string; pending: boolean; wrong: boolean; reason?: string } | null {
  const call = object(data)
  if (str(call.operation) !== 'app.check') return null
  const state = str(call.state) ?? 'pending'
  const receipt = object(call.receipt)
  const result = object(receipt.result)
  const problems = Array.isArray(result.problems) ? result.problems.length : 0
  const found =
    problems + (typeof result.omitted === 'number' ? result.omitted : 0)
  const pending = state === 'pending' && running
  const checked = state === 'answered' && str(receipt.outcome) === 'applied'
  const reason = checked ? str(result.typeCheckError) : undefined
  const wrong = !pending && (!checked || found > 0 || reason !== undefined)
  const words = pending
    ? 'Checking the App'
    : !checked
      ? 'The App was not checked'
      : result.built === false
        ? 'The App does not build'
        : found > 0
          ? `Checked the App: ${found === 1 ? '1 problem' : `${found} problems`}`
          : reason !== undefined
            ? 'Checked the App: its types could not be checked'
            : 'Checked the App: no problems'
  return { words, pending, wrong, reason }
}

/** The problems an App check listed, one to a line, each after where it is when the check says. */
export function appCheckProblems(data: unknown): string | undefined {
  const { problems } = object(object(object(data).receipt).result)
  if (!Array.isArray(problems)) return undefined
  const lines = problems.flatMap((entry) => {
    const problem = object(entry)
    const message = str(problem.message)
    if (!message) return []
    const file = str(problem.file)
    const line = typeof problem.line === 'number' ? `:${problem.line}` : ''
    return [file ? `${file}${line}  ${message}` : message]
  })
  return lines.length > 0 ? lines.join('\n') : undefined
}

/**
 * Something the agent asked this page to do. Nothing draws here: a check of
 * an App is a row of the tool-calls section, and the fox on the stage shows
 * what Kit's operations did. A `ui.present` call is the exception: the tree
 * or A2UI surfaces it carries are the reply's interface, drawn from the
 * styled vocabulary, with any component it does not name drawn from its
 * properties.
 */
const ClientOperationPart: DataMessagePartComponent = ({ data }) => {
  const call = object(data)
  const args = object(call.args)
  const aui = useAui()
  const running = useAuiState((s) => s.message.status?.type === 'running')
  const trees = useMemo(() => presentation(args, inVocabulary).trees, [args])
  if (str(call.operation) !== PRESENT) return null
  const state = str(call.state) ?? 'pending'
  // While the call streams, the tree is partial; the renderer tolerates that.
  const status = state === 'pending' && running ? 'streaming' : 'done'
  // An A2UI surface's actions go to the agent that wrote it; `openUrl` opens
  // a web address.
  const dispatch = (action: GenerativeUIAction) => {
    const url = openUrlOf(action)
    if (url) return void window.open(url, '_blank', 'noopener,noreferrer')
    const message = a2uiActionMessage(action)
    if (message && !aui.thread.getState().isRunning) aui.thread.append(message)
  }
  return (
    <div data-slot="theorem-present" className="aui-p-present my-2 flex flex-col gap-3">
      {trees.map(({ key, tree }) => (
        <Fragment key={key}>
          {renderGenerativeUI(tree, styledGenerativeUILibrary, { status, dispatch })}
        </Fragment>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ approvals */

// The reading of an approval lives in lib/theorem/approval; these are re-exported for the files that import it from here.
export { approvalChoice, approvalOutcome, readApproval, sendApprovalDecision }
export type { ApprovalOutcome, TheoremApproval }

/** The tool, and its risk when Theorem marks it above low. */
function approvalSubtitle({ toolName, risk }: TheoremApproval) {
  const elevated = risk === 'medium' || risk === 'high'
  return elevated ? `${humanize(toolName)} · ${risk} risk` : humanize(toolName)
}

/** Pending Theorem approvals, artifacts, plans and commands render standalone so they are never folded into a tool group. */
export function isStandaloneToolCall(part: {
  type: string
  toolName?: string
  artifact?: unknown
  args?: unknown
  result?: unknown
}) {
  if (part.type !== 'tool-call') return false
  if (
    part.toolName &&
    (ARTIFACT_TOOLS.has(part.toolName) || part.toolName === DRAFT_PLAN)
  )
    return true
  if (readCommand(part.args, part.result)) return true
  const approval = readApproval(part)
  return approval !== undefined && approvalOutcome(approval) === 'awaiting'
}

const TheoremApprovalCard: FC<{
  approval: TheoremApproval
  argsText: string
}> = ({ approval, argsText }) => {
  const runId = useAuiState((s) => {
    const custom = object(s.message.metadata.custom)
    return str(custom.theoremRunId)
  })
  const [state, setState] = useState<ApprovalState>(
    approval.approved === undefined
      ? 'request'
      : approval.approved
        ? 'done'
        : 'denied',
  )
  const [error, setError] = useState<string>()
  // The part can settle while the card is open; a request nobody answered
  // offers no buttons, and the host's reason says why.
  const outcome = approvalOutcome(approval)
  const unanswered = outcome === 'unanswered' || outcome === 'failed'

  const decide = async (choice: ApprovalChoice, granted: boolean) => {
    if (!runId) {
      setError('This approval belongs to a run that is no longer live.')
      return
    }
    setError(undefined)
    setState(granted ? 'running' : 'denied')
    try {
      await sendApprovalDecision(runId, approval, choice)
    } catch (failure) {
      setState('request')
      setError(describeError(failure))
    }
  }

  const byKind = (kind: string) => approval.options.find((o) => o.kind === kind)
  const allowOnce = byKind('allow_once')
  const allowAlways = byKind('allow_always')
  const reject = byKind('reject_once') ?? byKind('reject_always')
  const allow = approvalChoice(approval.options, true)
  const deny = approvalChoice(approval.options, false)

  return (
    <div className="my-3 flex flex-col gap-2">
      <ApprovalCard
        state={unanswered ? 'denied' : state}
        statusLabel={
          unanswered
            ? (approval.reason ??
              (outcome === 'failed' ? 'The request failed' : 'Not answered'))
            : undefined
        }
        title={approval.summary}
        subtitle={approvalSubtitle(approval)}
        command={argsText || undefined}
        variant={approval.risk === 'high' ? 'destructive' : 'default'}
        icon={<Icon.Approval aria-hidden />}
        className="max-w-md"
        onAllowOnce={allow && (() => decide(allow, true))}
        allowOnceLabel={allowOnce?.name ?? 'Allow once'}
        onAlwaysAllow={
          allowAlways
            ? () => decide({ optionId: allowAlways.optionId }, true)
            : undefined
        }
        alwaysAllowLabel={allowAlways?.name ?? 'Always allow'}
        onDeny={deny && (() => decide(deny, false))}
        denyLabel={reject?.name ?? 'Deny'}
      />
      {error && (
        <p role="alert" className="text-sm text-error-ink">
          {error}
        </p>
      )}
    </div>
  )
}

/** A small bordered tag in the conversation: a source, a file. */
const CHIP =
  'inline-flex max-w-64 items-center gap-1.5 rounded-md border border-separator bg-raised px-2 py-1 text-xs text-ink-muted'

/**
 * The file a tool worked on, which opens in the IDE as its own tab with the
 * lines it touched selected; from chat it takes the person to the IDE.
 */
function OpenInIde({ open }: { open: Open }) {
  const reveal = useRevealFile()
  const name = open.path.split('/').pop() || open.path
  const lines =
    open.start === undefined
      ? ''
      : open.end !== undefined && open.end !== open.start
        ? `:${open.start}–${open.end}`
        : `:${open.start}`
  return (
    <button
      type="button"
      title={`Open ${open.path} in the IDE`}
      onClick={() => reveal(open.path, open.start, open.end)}
      className={cn(CHIP, 'min-w-0 py-0.5 hover:bg-hover hover:text-ink')}
    >
      <Icon.File className="size-3 shrink-0" />
      <span className="truncate font-mono">
        {name}
        {lines}
      </span>
    </button>
  )
}

/** A tool call's state in the chat's words, as the tool card reads it. */
const CALL_STATES = {
  running: 'running',
  waiting: 'awaiting',
  cancelled: 'interrupted',
  failed: 'failed',
  done: 'done',
} as const satisfies Record<
  NonNullable<ReturnType<typeof toolState>>,
  CallState
>

export const toolCallState = (
  status: Parameters<typeof toolState>[0],
  isError?: boolean,
): CallState => CALL_STATES[toolState(status, isError) ?? 'running']

/** ToolFallback slot: artifact tools, plans, Theorem approvals, commands, then the generic tool card. */
export const TheoremToolCall: ToolCallMessagePartComponent = (props) => {
  if (ARTIFACT_TOOLS.has(props.toolName)) return <ArtifactToolCall {...props} />
  if (props.toolName === DRAFT_PLAN) return <PlanToolCall {...props} />
  const approval = readApproval(props)
  if (approval && props.result === undefined)
    return <TheoremApprovalCard approval={approval} argsText={props.argsText} />
  const command = readCommand(props.args, props.result)
  if (command)
    return (
      <CommandTerminal
        {...command}
        state={toolCallState(props.status, props.isError)}
      />
    )
  const open = openOf(pathOf(props.args), props.args, props.result)
  return <ToolFallback {...props} aside={open && <OpenInIde open={open} />} />
}

/* ---------------------------------------------------------------- activity */

/** What a call returned, as the reply's own code block: its glass, copy and palette. */
const ToolOutput: FC<{ text: string }> = ({ text }) => (
  <GlassCodeBlock
    code={text}
    language="text"
    title="output"
    lineNumbers={false}
    frameClassName="my-0"
    className="aui-code-wrap [&_pre]:max-h-60 [&_pre]:overflow-y-auto [&_pre]:break-words [&_pre]:whitespace-pre-wrap"
  />
)

const LIVE_STATUSES = new Set([
  'running',
  'active',
  'pending',
  'started',
  'in_progress',
])

const DONE_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'succeeded',
  'success',
])

function progressLabels(
  content: readonly { type: string; name?: string; data?: unknown }[],
) {
  return content.flatMap((part) => {
    if (part.type !== 'data' || part.name !== 'theorem-progress') return []
    const label = str(object(part.data).label)
    return label ? [label] : []
  })
}

/** How long the person waited for this reply: from their message to its arrival. */
const waitedSeconds = (s: AssistantState) => {
  const { messages } = s.thread
  const at = messages.findIndex((message) => message.id === s.message.id)
  const asked = messages
    .slice(0, Math.max(at, 0))
    .findLast((message) => message.role === 'user')
  const replied = messages[at]
  if (!asked || !replied) return undefined
  // A live reply is stamped when its run begins; its timing says when it settled.
  const timing =
    replied.role === 'assistant' ? replied.metadata.timing : undefined
  const settled =
    timing?.totalStreamTime === undefined
      ? replied.createdAt.getTime()
      : timing.streamStartTime + timing.totalStreamTime
  return Math.round((settled - asked.createdAt.getTime()) / 1000)
}

const spokenSeconds = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`

const ACTIVITY_CONTROL =
  '-mx-1 cursor-pointer rounded-sm px-1 outline-offset-2 outline-focus transition-colors duration-(--duration-snap) ease-snap hover:bg-hover hover:text-ink focus-visible:outline-2 data-panel-open:bg-hover data-panel-open:text-ink'

/**
 * What the agent is doing, then what it did, as one unboxed line by its name:
 * the live step while it works ("Theorem · Checking the examples"), and once
 * it settles how long the reply took and a Details control ("Theorem · 42s ·
 * Details"). Theorem publishes answer text at turn end, so the live step is
 * the running turn's visible state. Either opens the steps, the reasoning and
 * the tool calls on a small sheet of paper; until then the work takes no room
 * of its own. A run that stopped or did not finish says so on the line, and an
 * approval still to give keeps its card in the reply.
 */
export const Activity: FC<{
  /** Whose line this is. A specialist's run in a delegation panel has no name to sit by. */
  speaker?: string | undefined
  /** The reply's reasoning and tool calls as the thread draws them, when it has any. */
  work?: ReactNode
}> = ({ speaker, work }) => {
  const running = useAuiState((s) => s.message.status?.type === 'running')
  // Select the store's own content array; deriving inside the selector would
  // hand back a fresh array on every read and loop the subscription.
  const content = useAuiState((s) => s.message.content)
  const calls = useMemo(() => hostCalls(content, running), [content, running])
  const toolCalls = useMemo(
    () => toolCallEntries(content, running),
    [content, running],
  )
  const awaiting =
    useAuiState((s) =>
      s.message.content.some((part) => {
        if (part.type !== 'tool-call' || part.result !== undefined) return false
        const approval = readApproval(part)
        return (
          approval !== undefined && approvalOutcome(approval) === 'awaiting'
        )
      }),
    ) || calls.some(({ state }) => state === 'awaiting')
  // What the agent's program is doing now, when no progress event says more.
  const calling = calls.findLast(
    ({ name, state }) => state === 'running' && !isKitCall(name),
  )
  const labels = useMemo(() => progressLabels(content), [content])
  const progress = useMemo(() => {
    const last = content.findLast(
      (part) => part.type === 'data' && part.name === 'theorem-progress',
    )
    return last?.type === 'data' ? object(last.data) : {}
  }, [content])
  const status = str(progress.status)
  // Labels are what the run was doing while live ("Working"), even on the
  // step that completes, so the line names the outcome from the statuses: the
  // message's, then the last step's.
  const outcome = useAuiState((s) =>
    s.message.status?.type === 'complete'
      ? 'Done'
      : s.message.status?.type === 'incomplete'
        ? s.message.status.reason === 'cancelled'
          ? 'Stopped'
          : 'Did not finish'
        : undefined,
  )
  const seconds = useAuiState(waitedSeconds)
  const [open, setOpen] = useState(false)
  // The tool calls folded away here, as one string so the selector hands back
  // the same value until one of them changes.
  const folded = useAuiState((s) =>
    s.message.parts
      .flatMap((part) =>
        part.type === 'tool-call' && !isStandaloneToolCall(part)
          ? [
              [
                part.toolCallId,
                part.toolName,
                toolState(part.status, part.isError) ?? '',
              ].join('\t'),
            ]
          : [],
      )
      .join('\n'),
  )

  const steps = labels.length > 1
  const openable = steps || Boolean(work)
  const notes: ReactNode[] = []
  if (running) {
    const doing = (
      <ThinkingIndicator
        label={
          awaiting
            ? 'Waiting for your approval'
            : ((LIVE_STATUSES.has(status ?? '')
                ? str(progress.label)
                : undefined) ??
              (calling ? callWords(calling.name, 'running') : 'Thinking'))
        }
        orb={awaiting ? 'breathing' : 'working'}
      />
    )
    notes.push(
      openable ? (
        <CollapsibleTrigger
          nativeButton={false}
          render={doing}
          className={ACTIVITY_CONTROL}
        />
      ) : (
        doing
      ),
    )
  } else if (labels.length > 0 || work) {
    const result =
      outcome ??
      (DONE_STATUSES.has(status ?? 'complete') ? 'Done' : 'Did not finish')
    if (result !== 'Done') notes.push(result)
    if (seconds)
      notes.push(<span className="tabular-nums">{spokenSeconds(seconds)}</span>)
    if (openable)
      notes.push(
        <CollapsibleTrigger className={ACTIVITY_CONTROL}>
          Details
        </CollapsibleTrigger>,
      )
  }
  const tools = <ToolTrace calls={toolCalls} />
  if (!speaker && notes.length === 0) return tools

  return (
    <Collapsible
      data-slot="activity"
      // Theo points here for a tool call that is folded away inside.
      data-face-holder=""
      className="mb-1.5"
      open={open}
      onOpenChange={setOpen}
    >
      {!open && folded !== '' && (
        // Closed, the calls are not drawn: these stand for them by name.
        <span hidden>
          {folded.split('\n').map((call) => {
            const [id = '', name = '', state] = call.split('\t')
            return (
              <span
                key={id}
                {...thingProps('tool', id, { label: humanize(name), state })}
              />
            )
          })}
        </span>
      )}
      <div className="flex min-h-6 flex-wrap items-center gap-x-2">
        {speaker && (
          <span
            data-appearance-recipe="ui.section"
            {...appearancePair('primary', 'assistant-reading')}
            className="text-ink"
          >
            {speaker}
          </span>
        )}
        {notes.length > 0 && (
          <span
            data-slot="activity-line"
            data-appearance-recipe="metadata"
            {...appearancePair('secondary', 'assistant-reading')}
            className="flex min-w-0 items-center gap-x-2 text-sm text-ink-muted"
          >
            {notes.map((note, index) => (
              <Fragment key={index}>
                {(speaker || index > 0) && (
                  <span aria-hidden className="text-ink-faint">
                    ·
                  </span>
                )}
                {note}
              </Fragment>
            ))}
          </span>
        )}
      </div>
      {openable && (
        <CollapsiblePanel>
          {/* Room for the sheet's shadow inside the panel's clip. */}
          <div className="px-2 pt-2 pb-3">
            <div
              data-slot="activity-details"
              className="surface-paper-subtle rounded-xl px-3 py-2 text-sm"
            >
              {steps && (
                <ol className="ms-5 list-decimal py-1 leading-6 text-ink-muted">
                  {labels.map((label, index) => (
                    <li key={index}>{label}</li>
                  ))}
                </ol>
              )}
              {work}
            </div>
          </div>
        </CollapsiblePanel>
      )}
      {tools}
    </Collapsible>
  )
}

/** A call's own row: it opens to its output when it has one. */
const ToolTraceRow: FC<{ call: ToolCallEntry }> = ({ call }) => {
  const line = (
    <TraceLine status={call.status}>
      <TraceIcon>
        {getToolCategoryIcon(call.tool_category, {
          showBackground: false,
          size: 14,
          width: 16,
          height: 16,
        }) ?? <Icon.ToolDone />}
      </TraceIcon>
      <TraceTitle>{call.message}</TraceTitle>
    </TraceLine>
  )
  if (!call.output) return <div>{line}</div>
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <ToolOutput text={call.output} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/**
 * The reply's tool calls folded into one Trace row above the answer ("Used 3
 * tools"), opening to a row per call. The summary says in words when a call
 * is still running or did not finish, since Trace marks those by colour and
 * motion alone.
 */
const ToolTrace: FC<{ calls: ToolCallEntry[] }> = ({ calls }) => {
  const [choice, setChoice] = useState<boolean>()
  if (calls.length === 0) return null
  const count = `${calls.length} tool${calls.length === 1 ? '' : 's'}`
  const running = calls.some(({ status }) => status === 'running')
  const failed = calls.filter(({ status }) => status === 'error').length
  const summary = running
    ? `Using ${count}…`
    : failed
      ? `Used ${count}, ${failed} did not finish`
      : `Used ${count}`
  return (
    <Trace data-slot="tool-trace" className="my-1">
      <TraceCollapsible open={choice ?? false} onOpenChange={setChoice}>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={running ? 'running' : failed ? 'error' : undefined}
          >
            <TraceIcon>
              {running ? <Icon.ToolRunning /> : <Icon.ToolDone />}
            </TraceIcon>
            <TraceTitle>{summary}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {calls.map((call, index) => (
              <ToolTraceRow key={call.tool_name + index} call={call} />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/* ------------------------------------------------------------- other parts */

const ReasoningSummaryPart: DataMessagePartComponent = ({ data }) => {
  const text = str(object(data).text)
  const running = useAuiState((s) => s.message.status?.type === 'running')
  if (!text) return null
  return (
    <ReasoningRoot streaming={running} variant="ghost" className="mb-1">
      <ReasoningTrigger active={running} />
      <ReasoningContent>
        <ReasoningText>
          <p className="whitespace-pre-wrap">{text}</p>
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  )
}

/**
 * Citations draw nothing in the part flow: the message's sources are drawn
 * once after its parts (CitationSources in the thread) — full link previews
 * where metadata resolved, one Sources hyperlink row with a dropdown for
 * the rest. The part renderer stays registered so the data part is claimed.
 */
const CitationPart: DataMessagePartComponent = () => null

const ErrorPart: DataMessagePartComponent = ({ data }) => {
  const part = object(data)
  return (
    <div
      role="alert"
      className="my-3 max-w-md rounded-lg bg-error-container px-4 py-3 text-sm text-error-ink"
    >
      <p className="font-medium">{describeRunFailure(part)}</p>
    </div>
  )
}

/** Upload states worth a word; a ready attachment needs none. */
const ATTACHMENT_STATES: Partial<Record<string, string>> = {
  pending: 'uploading',
  uploading: 'uploading',
  failed: 'failed',
  refused: 'refused',
}

const AttachmentPart: DataMessagePartComponent = ({ data }) => {
  const part = object(data)
  const uploadId = str(part.uploadId)
  if (uploadId && !ATTACHMENT_STATES[str(part.state) ?? 'ready'])
    return (
      <StoredAttachment
        uploadId={uploadId}
        name={str(part.name) ?? 'Attachment'}
        mediaType={str(part.mediaType)}
      />
    )
  return (
    <span className="me-1.5 mt-2 inline-flex items-center gap-1.5 rounded-md border border-separator bg-raised px-2 py-1 text-xs text-ink-muted">
      <Icon.Attachment className="size-3" />
      {str(part.name) ?? 'Attachment'}
      {ATTACHMENT_STATES[str(part.state) ?? 'ready'] &&
        ` · ${ATTACHMENT_STATES[str(part.state) ?? 'ready']}`}
    </span>
  )
}

/** Where a run did not take what the person sent while it worked. */
const INPUT_REFUSALS: Record<string, string> = {
  run_ended: 'the run ended first',
  run_cancelled: 'the run was stopped',
  run_input_unsupported: 'this run takes no input',
  answer_final: 'its answer was already final',
  report_captured: 'its answer was already final',
}

/**
 * What the person sent while the run worked, drawn where the run took it in;
 * dim with its state until it did.
 */
const UserInputPart: DataMessagePartComponent = ({ data }) => {
  const part = object(data)
  const text = str(part.text)
  if (!text) return null
  const status = str(part.status)
  const reason = str(part.reason)
  const note =
    status === 'delivered'
      ? undefined
      : status === 'not_delivered'
        ? `not delivered${reason && INPUT_REFUSALS[reason] ? `: ${INPUT_REFUSALS[reason]}` : ''}`
        : 'queued for its next step'
  return (
    <div
      data-slot="theorem-user-input"
      data-status={status}
      className={`my-2 border-s-2 border-separator ps-3 text-sm ${status === 'delivered' ? 'text-ink' : 'text-ink-muted'}`}
    >
      <UserMarkdown text={text} />
      {note && <span className="ms-2 text-xs text-ink-faint">· {note}</span>}
    </div>
  )
}

/* --------------------------------------------------------------------- scenes */

/** A reply's interactive scene (scene-part.tsx), drawn above its text. */
const ScenePart: DataMessagePartComponent = ({ data }) => {
  const scene = readScene(data)
  if (!scene) return <PartNotice name={SCENE_PART} />
  return <SceneInReply scene={scene} />
}

/** Inspector-only or figure-only parts: retained inert, never drawn in the transcript. */
const Inert: DataMessagePartComponent = () => null

/** Placeholder for a part this client cannot draw; the part's name stays in the DOM for debugging. */
const PartNotice: FC<{ name: string }> = ({ name }) => (
  <p
    data-part={name}
    className="my-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-separator px-2 py-1 text-xs text-ink-faint"
  >
    This content can't be shown here.
  </p>
)

// New runtime metadata is not a failed piece of user content. Keep its name
// inspectable without adding a bubble to every streaming reply. Known content
// renderers still use PartNotice for malformed payloads and render failures.
const FallbackPart: DataMessagePartComponent = ({ name }) => (
  <span hidden data-part={name} />
)

/** Keeps a part that throws inside its own slot instead of unmounting the chat. */
function guarded(
  name: string,
  Render: DataMessagePartComponent,
): DataMessagePartComponent {
  const errorComponent = () => <PartNotice name={name} />
  return (props) => (
    <CatchBoundary
      getResetKey={() => props.data}
      errorComponent={errorComponent}
    >
      <Render {...props} />
    </CatchBoundary>
  )
}

/** The answer's message carries which review it answered, so its card can reopen it. */
const ReviewAnswerPart: DataMessagePartComponent = ({ data }) => {
  const reviewId = str(object(data).reviewId)
  return reviewId ? <ReviewAnswerCard reviewId={reviewId} /> : null
}

const RENDERERS = (
  [
    [ARTIFACT_PART, ArtifactPart],
    [SCENE_PART, ScenePart],
    ['theorem-review_answer', ReviewAnswerPart],
    ['theorem-reasoning_summary', ReasoningSummaryPart],
    ['theorem-citation', CitationPart],
    ['theorem-error', ErrorPart],
    ['theorem-attachment', AttachmentPart],
    ['theorem-host_call', HostCallPart],
    ['theorem-user_input', UserInputPart],
    // A run's completion: why it stopped, and the way back up when a limit stopped it.
    ['theorem-completion', CompletionFooter],
    // The saved records a reply was given, each at its saved revision, and what was held back.
    ['theorem-context_manifest', ContextManifestPart],
    ['theorem-skill_load', SkillLoadPart],
    // A change the assistant proposes to a saved record: nothing is saved until the person approves.
    ['theorem-record_change_proposal', RecordChangeProposalPart],
    ['theorem-record_change_outcome', RecordChangeOutcomePart],
    ...DELEGATION_RENDERERS,
  ] satisfies Array<[string, DataMessagePartComponent]>
)
  .map(([name, render]): [string, DataMessagePartComponent] => [
    name,
    guarded(name, render),
  ])
  .concat([
    // The run's steps are drawn once per message by Activity.
    ['theorem-progress', Inert],
    ['theorem-usage', Inert],
    ['theorem-expression', Inert],
    ['theorem-expression_refused', Inert],
    // The page's client operations: a check of an App shows as a chip.
    // A ui.present tree is model-supplied; a render failure stays in its slot.
    ['theorem-client_operation', guarded('theorem-client_operation', ClientOperationPart)],
    // A TypeScript program the agent wrote is shown as one, closed, with its
    // source inside. What it did shows up as its calls and their artifacts.
    ['theorem-program', ProgramPart],
    // Response style, frameworks, and suggestions are available in the
    // reply's More menu rather than the transcript.
    ['theorem-response_style', Inert],
  ])

function DataRenderer({
  name,
  render,
}: {
  name: string
  render: DataMessagePartComponent
}) {
  useAssistantDataUI({ name, render })
  return null
}

/** Mount once inside the runtime provider. */
export function TheoremPartRenderers() {
  const aui = useAui()
  useEffect(() => aui.dataRenderers.setFallbackDataUI(FallbackPart), [aui])
  return (
    <>
      {RENDERERS.map(([name, render]) => (
        <DataRenderer key={name} name={name} render={render} />
      ))}
    </>
  )
}
