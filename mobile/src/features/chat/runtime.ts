// SOURCING: @assistant-ui/react-native useExternalStoreRuntime over @theoremharness/sdk HeadlessConversation + projectThreadView (the external-store binding the web client can share)
//
// The Phase 0 binding choice: assistant-ui reads the headless session's
// projection and dispatches commands to it. It never runs its own agent loop
// and never owns a second copy of the conversation.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import * as Crypto from 'expo-crypto'
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react-native'
import { HeadlessConversation, type ConversationState } from '@theoremharness/sdk'
import { projectThreadView } from '@theoremharness/sdk/assistant-ui'
import { signIn } from '@/lib/auth'
import { config } from '@/lib/config'
import { onDraftChanged, readDraft, setCurrentThread, writeDraft } from '@/lib/drafts'
import { clearAccountData, db } from '@/lib/local-db'
import { SignInError } from '@/lib/oauth'
import { createJournalStore } from '@/lib/journal-store'
import { theorem } from '@/lib/theorem'
import { phoneTurnOptions } from '../phone-actions/calendar'
// intake/queue imports conversations() from this module; the two touch each other
// only inside functions, so the cycle resolves at call time rather than at load.
import { intake } from '../intake/queue'
import { ConversationBinding, type Lease } from './binding'
import { Outbox } from './outbox'
import { createOutboxStore } from './outbox-store'
import type { QueuedMessage, QueueState } from './queue'
import type { Recovery } from './recovery'

let shared: ConversationBinding | undefined

/** The app's one binding: one session per thread, however many views show it. */
export function conversations(): ConversationBinding {
  if (!shared) {
    const store = createJournalStore(db())
    shared = new ConversationBinding({
      create: (threadId) =>
        new HeadlessConversation({ client: theorem(), authority: config.authority, threadId, store }),
      newId: () => Crypto.randomUUID(),
    })
    // Leaving the foreground ends observation only; runs continue on the host.
    AppState.addEventListener('change', (status) => {
      if (status === 'active') shared?.resume()
      else if (status === 'background') shared?.suspend()
    })
  }
  return shared
}

let outgoing: Outbox | undefined

/** Bumped by resetConversations: every session was thrown away, so mounted views
 * must drop their stale leases and retain again for the account now on the device. */
let generation = 0
const generationListeners = new Set<() => void>()

/** The app's one outbox: messages wait here during a run and go when the conversation is free. */
export function outbox(): Outbox {
  outgoing ??= new Outbox({
    binding: conversations(),
    newId: () => Crypto.randomUUID(),
    extras: phoneTurnOptions,
    store: createOutboxStore(db()),
  })
  return outgoing
}

export function resetConversations() {
  outgoing?.reset()
  shared?.reset()
  generation += 1
  for (const listener of generationListeners) listener()
}

/** Who the current bearer is, per Theorem's own session; undefined when it cannot be
 * established (a token the authority has already refused). */
async function currentPrincipal(): Promise<string | undefined> {
  try {
    return (await theorem().session.bootstrap()).principalId
  } catch {
    return undefined
  }
}

const textOf = (message: AppendMessage) =>
  message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim()

export type ConversationView = {
  runtime: AssistantRuntime
  state: ConversationState
  runId: string | undefined
  /** A send the authority refused; its text is back in the composer. */
  sendError: unknown
  /** A Stop whose pause this device could not keep. */
  stopError: unknown
  /** Messages sent during a run, waiting to go. Each can be taken back until it goes. */
  queued: QueuedMessage[]
  /** Stop was pressed: queued messages wait until the person sends again. */
  paused: boolean
  /** Takes a queued message out of the queue. */
  removeQueued: (id: string) => void
  /** Takes a queued message back into the composer to change it. */
  editQueued: (id: string) => void
  /** The one action a notice offered. Resolves; a failed sign-in is reported in `recoveryError`. */
  recover: (recovery: Recovery) => Promise<void>
  recoveryError: unknown
}

export function useConversation(threadId: string): ConversationView {
  const [lease, setLease] = useState<Lease>()
  const [state, setState] = useState<ConversationState>({ phase: 'detached' })
  const [sendError, setSendError] = useState<unknown>()
  const [stopError, setStopError] = useState<unknown>()
  const [recoveryError, setRecoveryError] = useState<unknown>()

  // A reset (sign-out, or an in-place sign-in that changed the account) leaves this
  // view holding a stale lease for the old session; hearing the new generation runs
  // the retain effect again and the view attaches under the current account.
  const gen = useSyncExternalStore(
    useCallback((listener) => {
      generationListeners.add(listener)
      return () => generationListeners.delete(listener)
    }, []),
    () => generation,
  )

  useEffect(() => {
    const next = conversations().retain(threadId)
    setLease(next)
    const unsubscribe = next.conversation.subscribe(setState)
    // Unmounting releases the view. It never stops the run.
    return () => {
      unsubscribe()
      next.release()
    }
  }, [threadId, gen])

  const queue: QueueState = useSyncExternalStore(
    useCallback((listener) => outbox().subscribe(threadId, listener), [threadId]),
    () => outbox().snapshot(threadId),
  )

  const view = useMemo(() => projectThreadView(state), [state])
  const runtimeRef = useRef<AssistantRuntime>(undefined)
  const ready = !['detached', 'connecting', 'failed', 'authentication-required'].includes(state.phase)

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: view.messages,
    convertMessage: (message) => message,
    isRunning: view.isRunning,
    isDisabled: !lease,
    // A run in progress does not disable Send: the message is queued and goes when the run ends.
    isSendDisabled: !ready,
    onNew: async (message) => {
      const text = textOf(message)
      if (!text) return
      setSendError(undefined)
      // The queued message owns the words from here. submit() saves them durably
      // before it returns, so the draft is cleared only once they are kept; a
      // definite refusal gives them back (see below).
      outbox().submit(threadId, text)
      writeDraft(threadId, '')
    },
    // The only path to cancellation: the person pressed Stop.
    onCancel: async () => {
      // The run is stopped and the queue paused whatever its save says; a pause
      // this device could not keep is reported rather than swallowed, because only
      // then could a restart send what the person stopped.
      setStopError(undefined)
      try {
        await outbox().stop(threadId)
      } catch (error) {
        setStopError(error)
      }
    },
  })
  runtimeRef.current = runtime

  // Restore and keep the draft for this thread. Declared before the refusal
  // effect below so it runs first on mount: a refusal that arrived while the
  // screen was closed prepends to the saved draft instead of overwriting it.
  useEffect(() => {
    const composer = runtime.thread.composer
    const saved = readDraft(threadId)
    if (saved && !composer.getState().text) composer.setText(saved)
    setCurrentThread(threadId)
    const unsubscribe = composer.subscribe(() => writeDraft(threadId, composer.getState().text))
    const unlisten = onDraftChanged((key) => {
      if (key === threadId) composer.setText(readDraft(threadId))
    })
    return () => {
      unsubscribe()
      unlisten()
    }
  }, [runtime, threadId])

  // A refused send is dropped from the journal; give the words back.
  useEffect(() => {
    const [refusal] = queue.refused
    if (!refusal) return
    const composer = runtimeRef.current?.thread.composer
    const current = composer?.getState().text ?? ''
    const text = current ? `${refusal.message.text}\n\n${current}` : refusal.message.text
    setSendError(refusal.error)
    composer?.setText(text)
    writeDraft(threadId, text)
    outbox().acknowledge(threadId, refusal.message.id)
  }, [queue.refused, threadId])

  const removeQueued = useCallback((id: string) => void outbox().remove(threadId, id), [threadId])
  const editQueued = useCallback(
    (id: string) => {
      const item = outbox().snapshot(threadId).items.find((entry) => entry.id === id)
      // Only a message that was still waiting can come back; one that already went
      // is a real message. An uncertain send keeps its command id: editing it into
      // the composer would let it go again under a fresh id, which could duplicate
      // a message the authority already admitted.
      if (!item || item.uncertain || !outbox().remove(threadId, id)) return
      const composer = runtimeRef.current?.thread.composer
      const current = composer?.getState().text ?? ''
      composer?.setText(current ? `${item.text}\n\n${current}` : item.text)
    },
    [threadId],
  )

  const recover = useCallback(
    async (recovery: Recovery) => {
      setRecoveryError(undefined)
      try {
        if (recovery === 'sign-in') {
          // Signing in again replaces the tokens in place, without a signed-out
          // transition, so the account-change cleanup in _layout does not run.
          // Nothing the old account queued, drafted or journaled may carry over
          // or go out under the new credentials: clear it exactly as a sign-out
          // does, unless both bearers are proved to be the same person. When an
          // identity cannot be established — the old token already refused, or a
          // transient failure on either lookup — the clear is the safe answer:
          // it costs the person's own leftovers at worst, while skipping it could
          // send one account's queue under another. No reconnect follows an
          // unproven identity: reconnecting without a verified account is what
          // would dispatch the queue under it.
          const before = await currentPrincipal()
          await signIn()
          const after = await currentPrincipal()
          if (!before || !after || before !== after) {
            resetConversations()
            clearAccountData()
            intake.reset()
            return
          }
        }
        conversations().reconnect(threadId)
      } catch (error) {
        if (error instanceof SignInError && error.code === 'cancelled') return
        setRecoveryError(error)
      }
    },
    [threadId],
  )

  return {
    runtime,
    state,
    runId: view.runId,
    sendError,
    stopError,
    queued: queue.items,
    paused: queue.paused,
    removeQueued,
    editQueued,
    recover,
    recoveryError,
  }
}
