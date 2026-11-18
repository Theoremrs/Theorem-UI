// SOURCING: assistant-ui (`@assistant-ui/react`): an ExternalStoreRuntime
// whose store is the page's conversation, reached through
// `window.theorem.dossier`, and its Thread, Message and Composer primitives;
// its experimental Interactables, so what the part's settings are now is
// stamped on each question. Astryx draws the buttons. What is ours is what a
// question says about where the person is: the part, its inputs and outputs,
// the step, what can be done there.
//
// There is one conversation, the page's. The dossier follows the part the
// person selects unless they keep it on one; other notes hand it over.
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { ToggleButton } from '@astryxdesign/core/ToggleButton'
import {
  AssistantRuntimeProvider,
  AuiConfig,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_getInteractableSnapshots,
  unstable_Interactables,
  unstable_useInteractable,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChromeSnapshot, PartSnapshot } from './chrome'

/** One message of the App's part of the page's conversation. */
export interface DossierMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'running' | 'complete' | 'incomplete'
}

/** The questions asked from this App and their replies; not `available` outside a conversation. */
export interface DossierState {
  available: boolean
  running: boolean
  messages: Array<DossierMessage>
}

/** `window.theorem.dossier`, as the App frame gives it. */
interface DossierBridge {
  ask: (text: string, context: Record<string, unknown>) => Promise<void>
  watch: (listener: (state: DossierState) => void) => () => void
  source: (name: string) => Promise<boolean>
}

const bridge = (): DossierBridge | undefined =>
  (globalThis as { theorem?: { dossier?: DossierBridge } }).theorem?.dossier

const CLOSED: DossierState = { available: false, running: false, messages: [] }

/** The App's part of the page's conversation, kept current. */
export function useDossier(): DossierState {
  const [state, setState] = useState(CLOSED)
  useEffect(() => bridge()?.watch(setState), [])
  return state
}

/** A value as JSON carries it, or its text where JSON cannot. */
const plain = (value: unknown, text: string): unknown => {
  try {
    const carried = JSON.stringify(value)
    return carried === undefined ? text : (JSON.parse(carried) as unknown)
  } catch {
    return text
  }
}

/**
 * What a question asked about `part` says about where the person is: the
 * part, the inputs a person sets and the outputs the model computes, its
 * settings, the step a change has reached, and what can be done there.
 */
export function dossierContext(
  part: PartSnapshot,
  snapshot: ChromeSnapshot,
  interactables?: ReadonlyArray<unknown>,
): Record<string, unknown> {
  const inputs = part.ports.filter((port) => port.dir === 'in')
  const outputs = part.ports.filter((port) => port.dir === 'out')
  const settable = [
    ...inputs.filter((port) => port.editable).map((port) => port.name),
    ...part.state.filter((setting) => setting.control).map((setting) => setting.name),
  ]
  return {
    model: snapshot.title,
    selected: { id: part.path, label: part.label },
    about: part.about,
    inside: snapshot.trail.map((step) => step.label),
    inputs: inputs.map((port) => ({
      name: port.name,
      label: port.label,
      value: plain(port.value, port.text),
      text: port.text,
      editable: port.editable,
    })),
    outputs: outputs.map((port) => ({
      name: port.name,
      label: port.label,
      value: plain(port.value, port.text),
      text: port.text,
    })),
    settings: part.state.map((setting) => ({
      name: setting.name,
      value: plain(setting.value, setting.text),
      text: setting.text,
      editable: Boolean(setting.control),
    })),
    step: {
      replaying: snapshot.replay.active,
      stage: snapshot.replay.stage,
      of: snapshot.replay.end,
      paused: snapshot.replay.paused,
      running: snapshot.running,
      clocked: snapshot.ticking,
    },
    actions: [
      ...settable.map((name) => `set ${name}`),
      ...(snapshot.ticking ? ['step the clock', 'run'] : []),
      ...(part.openable ? ['open it'] : []),
      'pull it out',
      'revise the App',
    ],
    ...(interactables?.length ? { interactables } : {}),
  }
}

/** Questions a person can start from, about any part. */
const STARTERS = (part: PartSnapshot) => [
  `Why is ${part.label} showing ${part.summary[0] ?? 'this'}?`,
  `Show me how ${part.label} works`,
]

const convert = (message: DossierMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role,
  content: [{ type: 'text', text: message.text }],
  status:
    message.role === 'user'
      ? undefined
      : message.status === 'running'
        ? { type: 'running' }
        : message.status === 'incomplete'
          ? { type: 'incomplete', reason: 'error' }
          : { type: 'complete', reason: 'stop' },
})

/**
 * The part's settings as an interactable: assistant-ui stamps their current
 * values on each question sent while it is registered.
 */
function PartSettings({ part }: { part: PartSnapshot }) {
  const values = useMemo(
    () =>
      Object.fromEntries([
        ...part.ports.filter((port) => port.dir === 'in').map((port) => [port.name, plain(port.value, port.text)]),
        ...part.state.map((setting) => [setting.name, plain(setting.value, setting.text)]),
      ]),
    [part],
  )
  const [, { setState }] = unstable_useInteractable('part', {
    id: part.path,
    description: `The inputs and settings of ${part.label} (${part.path}) as they are now.`,
    stateSchema: { type: 'object', additionalProperties: true },
    initialState: values,
  })
  useEffect(() => setState(values), [values, setState])
  return null
}

function DossierMessageRow() {
  const role = useAuiState((s) => s.message.role)
  return (
    <MessagePrimitive.Root className="ts-dossier-message" data-role={role}>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

/**
 * The question box. assistant-ui sends on Enter by submitting the composer's
 * form, and an App frame's sandbox (scripts only) blocks form submission, so
 * Enter sends through the composer itself; Shift+Enter still breaks the line.
 */
function DossierInput({ label }: { label: string }) {
  const aui = useAui()
  return (
    <ComposerPrimitive.Input
      className="ts-dossier-input"
      placeholder={`Ask about ${label}`}
      aria-label={`Ask about ${label}`}
      rows={1}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
        event.preventDefault()
        if (aui.composer.getState().canSend) aui.composer.send()
      }}
    />
  )
}

function Thread({ part, state, ask }: { part: PartSnapshot; state: DossierState; ask: (message: AppendMessage) => Promise<void> }) {
  const runtime = useExternalStoreRuntime<DossierMessage>({
    messages: state.messages,
    isRunning: state.running,
    isDisabled: !state.available,
    convertMessage: convert,
    onNew: ask,
  })
  const config = useMemo(() => AuiConfig({ unstable_interactables: unstable_Interactables() }), [])
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <PartSettings part={part} />
      <ThreadPrimitive.Root className="ts-dossier-thread">
        <ThreadPrimitive.Viewport className="ts-dossier-messages" autoScroll>
          <ThreadPrimitive.Messages>{() => <DossierMessageRow />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.Empty>
          <div className="ts-dossier-starters">
            {STARTERS(part).map((prompt) => (
              <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send={false} asChild>
                <button type="button" className="ts-dossier-starter">{prompt}</button>
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
        </ThreadPrimitive.Empty>
        <ComposerPrimitive.Root className="ts-dossier-composer">
          <DossierInput label={part.label} />
          <ComposerPrimitive.Send asChild>
            <Button label="Ask" size="sm" variant="secondary" />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

/**
 * The conversation in a part's expanded note. `follows` says whether the one
 * assistant is on this part; a note it is not on offers to bring it over.
 */
export function Dossier({ part, snapshot, follows, held, hold, bring }: {
  part: PartSnapshot
  snapshot: ChromeSnapshot
  /** The assistant is on this part. */
  follows: boolean
  /** The assistant stays on the part it is on when the selection moves. */
  held: boolean
  hold: (held: boolean) => void
  /** Brings the assistant to this part. */
  bring: () => void
}) {
  const state = useDossier()
  const [problem, setProblem] = useState<string>()
  const [found, setFound] = useState<boolean>()
  // Read when a question is sent, so it says where the person is then.
  const now = useRef({ part, snapshot })
  useEffect(() => {
    now.current = { part, snapshot }
  })
  if (!bridge()) return null
  if (!follows)
    return (
      <div className="ts-dossier-elsewhere">
        <Text size="sm" color="secondary">The assistant is on another part.</Text>
        <Button label="Ask here" size="sm" variant="ghost" onClick={bring} />
      </div>
    )
  const ask = async (message: AppendMessage) => {
    setProblem(undefined)
    const text = message.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')
    try {
      await bridge()!.ask(text, dossierContext(now.current.part, now.current.snapshot, unstable_getInteractableSnapshots(message)))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <section className="ts-dossier-body" aria-label={`Conversation about ${part.label}`}>
      <div className="ts-dossier-head">
        <Text size="sm" weight="semibold">Ask</Text>
        <ToggleButton label={held ? `Kept on ${part.label}` : 'Keep here'} size="sm" isPressed={held} onPressedChange={hold} />
        <Button
          label="Source"
          size="sm"
          variant="ghost"
          onClick={() => {
            void bridge()!.source(part.path.split('/').at(-1)!).then(setFound)
          }}
        />
      </div>
      {found === false && <Text size="sm" color="secondary">{`${part.label} is not named in this App's own files.`}</Text>}
      {!state.available && <Text size="sm" color="secondary">Open this App in a conversation to ask about it.</Text>}
      <Thread part={part} state={state} ask={ask} />
      {problem && <p className="ts-dossier-problem" role="alert">{problem}</p>}
    </section>
  )
}
