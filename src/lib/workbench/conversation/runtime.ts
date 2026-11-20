// SOURCING: @assistant-ui/react (the useAui client is the runtime the conversation owner drives, its thread composer holds the draft attachments); sendApprovalDecision, sendRunInput, useComposerReferences, usePickedModels, useGenerationOverrides and the model catalog are the chat's own, reused so an approval, input, reference, model or effort from the workbench takes the same path as the composer's; the thread read behind `runInput` is `bindRunInput`'s own authoritative read (chat.threads.get for the run standing and the input a thread holds, chat.runs.events for a closed run's receipts, settled on a terminal event), mirrored here for the workbench owner, which drives a ConversationRuntime and has no live-run store
import type { AssistantClient } from '@assistant-ui/react'
import {
  useComposerReferences,
  referenceKey,
} from '@/components/chat/composer-references'
import { useShell } from '@/components/shell/shell-state'
import { sendApprovalDecision } from '@/lib/theorem/approval'
import { theorem, TERMINAL_RUN_EVENTS } from '@/lib/theorem/client'
import { inputReceipt, runInputReceipt } from '@/lib/theorem/run-input'
import type { InputReceipt } from '@/lib/theorem/run-input'
import {
  DRAFT,
  EFFORT_LEVELS,
  requestedEffort,
  useGenerationDefaults,
  useGenerationOverrides,
} from '@/lib/theorem/generation'
import { parseModelList, usePickedModels } from '@/lib/theorem/models'
import { theoremJson } from '@/lib/theorem/passthrough'
import { sendRunInput } from '@/lib/theorem/run-input-runtime'
import { loadThreadTree, selectBranch } from '@/lib/theorem/thread-origin'
import type {
  ConversationRuntime,
  ConversationServices,
  ModelServices,
  RunInputThread,
} from './conversation'

/**
 * The conversation owner's view of the assistant-ui client. Every member reads the
 * client when it is called, so the view never goes stale when the thread changes.
 * The client lacks `subscribe` on the thread and `mainItem` on the list; both come
 * from the client's own state and its single subscription.
 */
export function conversationRuntimeOf(
  aui: AssistantClient,
): ConversationRuntime {
  return {
    thread: {
      getState: () => aui.thread().getState(),
      subscribe: (listener) => aui.subscribe(listener),
      append: (message) => aui.thread().append(message),
      startRun: (config) => aui.thread().startRun(config),
      cancelRun: () => aui.thread().cancelRun(),
    },
    threads: {
      getState: () => aui.threads().getState(),
      subscribe: (listener) => aui.subscribe(listener),
      mainItem: { getState: () => aui.threads().item('main').getState() },
      switchToThread: async (threadId) => {
        await aui.threads().switchToThread(threadId)
      },
      reloadMainThread: async () => {
        await aui.threads().reloadMainThread()
      },
      switchToNewThread: async () => {
        await aui.threads().switchToNewThread()
      },
    },
    composer: {
      getState: () => aui.thread().composer().getState(),
      setText: (text) => aui.thread().composer().setText(text),
      addAttachment: (file) => aui.thread().composer().addAttachment(file),
      removeAttachment: (id) =>
        aui.thread().composer().attachment({ id }).remove(),
      send: () => aui.thread().composer().send(),
    },
  }
}

/** The browser's file chooser. Resolves to nothing when it is cancelled, and never rejects. */
function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = accept
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), {
      once: true,
    })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

/** Theorem's model list, read as the composer's picker reads it and kept as long as it keeps it. */
let listed:
  { at: number; read: ReturnType<ModelServices['catalog']> } | undefined
const CATALOG_FRESH_MS = 5 * 60_000

const modelServices: ModelServices = {
  catalog() {
    if (!listed || Date.now() - listed.at > CATALOG_FRESH_MS) {
      const read = theoremJson('/api/chat/v1/models').then((raw) => {
        const list = parseModelList(raw)
        return {
          models: list.models.map((model) => ({
            ref: model.ref,
            label: model.name,
            ...(model.contextLength !== undefined
              ? { contextTokens: model.contextLength }
              : {}),
            effortLevels: model.effortLevels,
          })),
          ...(list.defaultRef ? { defaultRef: list.defaultRef } : {}),
        }
      })
      listed = { at: Date.now(), read }
      // A failed read is not kept.
      read.catch(() => {
        if (listed?.read === read) listed = undefined
      })
    }
    return listed.read
  },
  selected: () => usePickedModels.getState().selected,
  select: (ref) => usePickedModels.getState().select(ref),
  effort: (thread) => requestedEffort(thread ?? DRAFT),
  setEffort: (thread, level) =>
    useGenerationOverrides
      .getState()
      .change(thread ?? DRAFT, { effort: level }),
  levels: EFFORT_LEVELS,
  subscribe: (listener) => {
    const stops = [
      usePickedModels.subscribe(listener),
      useGenerationOverrides.subscribe(listener),
      useGenerationDefaults.subscribe(listener),
    ]
    return () => {
      for (const stop of stops) stop()
    }
  },
}

/**
 * What Theorem stores about words sent to a run, as the queue reads it: the run
 * standing of a thread and the input it holds, with the user text already on it.
 */
async function readRunInputThread(threadId: string): Promise<RunInputThread> {
  const snapshot = await theorem().chat.threads.get({ threadId })
  return {
    active: Boolean(
      snapshot.liveRun ||
      snapshot.thread.activeRunId ||
      snapshot.thread.pendingTurn,
    ),
    ...(snapshot.liveRun?.runId ? { runId: snapshot.liveRun.runId } : {}),
    inputs: snapshot.messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        const receipt =
          part.type === 'user_input' ? inputReceipt(part.payload) : undefined
        return receipt ? [receipt] : []
      }),
    ),
    userTexts: snapshot.messages.flatMap((message) =>
      message.role === 'user'
        ? message.parts.flatMap((part) => {
            const text =
              part.type === 'text' &&
              part.payload &&
              typeof part.payload === 'object' &&
              'text' in part.payload
                ? part.payload.text
                : undefined
            return typeof text === 'string' ? [text] : []
          })
        : [],
    ),
  }
}

/**
 * A closed run's own input receipts. Absence of a delivered event is not a
 * refusal: the read is only an answer once the run has finished recording them.
 */
async function readRunInputReceipts(
  runId: string,
): Promise<readonly InputReceipt[]> {
  const receipts = new Map<string, InputReceipt>()
  const events = await theorem().chat.runs.events(
    { runId, after_seq: 0 },
    { abortSignal: AbortSignal.timeout(10_000) },
  )
  let terminal = false
  for await (const event of events) {
    if (TERMINAL_RUN_EVENTS.has(event.sourceEventType)) terminal = true
    if (event.sourceEventType !== 'CHAT.MESSAGE.PART') continue
    const receipt = runInputReceipt(event)
    if (receipt)
      receipts.set(receipt.inputId, {
        ...receipt,
        requestKey:
          receipt.requestKey ?? receipts.get(receipt.inputId)?.requestKey,
      })
  }
  if (!terminal)
    throw new Error(
      'The response has not finished recording its input receipts',
    )
  return [...receipts.values()]
}

/** What the conversation sends to Theorem that the runtime does not carry. */
export const conversationServices: ConversationServices = {
  answerApproval: async ({ runId, approvalId, toolCallId, choice }) => {
    await sendApprovalDecision(runId, { approvalId, toolCallId }, choice)
  },
  // The same send as the composer's: the words go to the run under the key that
  // names the message, and Theorem's confirmation of that request comes back.
  sendInput: ({ runId, inputId, text }) => sendRunInput(runId, text, inputId),
  openUnder: (threadId, projectId) =>
    useShell
      .getState()
      .askProject(projectId ? { threadId, projectId } : undefined),
  history: loadThreadTree,
  runInput: { thread: readRunInputThread, receipts: readRunInputReceipts },
  selectBranch,
  references: {
    add: (references) => {
      const store = useComposerReferences.getState()
      const held = new Set(store.references.map(referenceKey))
      const fresh = references.filter((r) => !held.has(referenceKey(r)))
      for (const reference of references) store.add(reference)
      return fresh
    },
    remove: (references) => {
      const store = useComposerReferences.getState()
      for (const reference of references) store.remove(referenceKey(reference))
    },
  },
  pickFiles,
  models: modelServices,
}
