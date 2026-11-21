// SOURCING: ./app-host-view (a hidden web App host runs the web's own check, Theorem-UI src/lib/blocks/app-operations.ts answerAppRequest); @theoremharness/sdk chat.runs.command with `client-operation-receipt`, as phone-actions/event-card.tsx answers its requests
//
// The agent asks the page it is talking to to build and check an App
// (`app.check`). On the phone that page is a web App host kept out of sight
// while a conversation is open. Each request is answered once, one at a time.
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { mutate, theorem } from '@/lib/theorem'
import { StatusLabel } from '@/ui/status'
import { Text } from '@/ui/text'
import { AppHostView, type AppHostHandle } from './app-host-view'
import { appCheckProblems, appCheckWords } from './operations'
import type { AppAnswer } from './protocol'

type Check = (operation: string, args: Record<string, unknown>) => Promise<AppAnswer>

const CheckContext = createContext<Check | undefined>(undefined)

/** How long a check may take before it is reported as not made: the page's build, a run of up to 5 s, and the look. */
const CHECK_TIMEOUT_MS = 60_000

/** Holds the hidden App host for the conversation screen and checks Apps in it, one at a time. */
export function AppChecks({ children }: { children: ReactNode }) {
  const host = useRef<AppHostHandle>(null)
  const ready = useRef<{ promise: Promise<void>; resolve: () => void }>(undefined)
  if (!ready.current) {
    let resolve = () => {}
    const promise = new Promise<void>((done) => (resolve = done))
    ready.current = { promise, resolve }
  }
  const waiting = useRef(new Map<string, (answer: AppAnswer) => void>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const check = useCallback<Check>((operation, args) => {
    const run = queue.current.then(async () => {
      await ready.current!.promise
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      return new Promise<AppAnswer>((resolve) => {
        const timer = setTimeout(() => {
          waiting.current.delete(id)
          resolve({ outcome: 'failed', reason: 'The App check on the phone did not finish in time.' })
        }, CHECK_TIMEOUT_MS)
        waiting.current.set(id, (answer) => {
          clearTimeout(timer)
          resolve(answer)
        })
        host.current?.send({ type: 'check', id, operation, args })
      })
    })
    queue.current = run.catch(() => undefined)
    return run
  }, [])

  return (
    <CheckContext.Provider value={check}>
      {children}
      <View
        style={styles.hidden}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <AppHostView
          ref={host}
          style={styles.fill}
          onHostMessage={(message) => {
            if (message.type === 'ready') ready.current!.resolve()
            else if (message.type === 'checked') {
              waiting.current.get(message.id)?.(message.answer)
              waiting.current.delete(message.id)
            }
          }}
        />
      </View>
    </CheckContext.Provider>
  )
}

export type AppRequest = {
  requestRef: string
  operation: string
  state: string
  args: Record<string, unknown>
  expectedRevision: number
}

/** Requests this app session has answered, so a re-render or a reopened screen never answers twice. */
const answered = new Map<string, Promise<void>>()

function answer(check: Check, runId: string, request: AppRequest): Promise<void> {
  const key = `${runId}:${request.requestRef}`
  let sent = answered.get(key)
  if (!sent) {
    sent = check(request.operation, request.args).then((result) =>
      mutate(`receipt:${key}`, (headers) =>
        theorem().chat.runs.command({
          runId,
          command: 'client-operation-receipt',
          requestRef: request.requestRef,
          // A check changes nothing, so its revision is the one the run expects.
          receipt: { ...result, revision: request.expectedRevision },
          ...headers,
        }),
      ).then(() => undefined),
    )
    answered.set(key, sent)
    sent.catch(() => answered.delete(key))
  }
  return sent
}

/** An App check in a reply: answered from here while the run waits, then what it found. */
export function AppCheckRow({
  request,
  data,
  runId,
  running,
}: {
  request: AppRequest
  data: unknown
  runId: string | undefined
  running: boolean
}) {
  const check = useContext(CheckContext)
  useEffect(() => {
    if (check && runId && request.state === 'pending') void answer(check, runId, request)
  }, [check, runId, request])
  const { words, pending, wrong } = appCheckWords(data, running)
  const problems = appCheckProblems(data)
  return (
    <View style={styles.row}>
      <StatusLabel tone={pending ? 'live' : wrong ? 'attention' : 'success'} label={words} />
      {problems.map((line, index) => (
        <Text key={index} variant="code" tone="muted" selectable numberOfLines={3}>
          {line}
        </Text>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // Laid out at a phone's width so the App draws as it would, but not seen.
  hidden: { position: 'absolute', left: -10000, top: 0, width: 390, height: 768, opacity: 0 },
  fill: { flex: 1 },
  row: { gap: 4 },
})
