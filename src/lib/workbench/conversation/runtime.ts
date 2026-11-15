// SOURCING: @assistant-ui/react (the useAui client is the runtime the conversation owner drives, its thread composer holds the draft attachments); sendApprovalDecision, sendRunInput, useComposerReferences, usePickedModels, useGenerationOverrides and the model catalog are the chat's own, reused so an approval, input, reference, model or effort from the workbench takes the same path as the composer's
import type { AssistantClient } from '@assistant-ui/react'
import {
  useComposerReferences,
  referenceKey,
} from '@/components/chat/composer-references'
import { sendApprovalDecision } from '@/lib/theorem/approval'
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

/** What the conversation sends to Theorem that the runtime does not carry. */
export const conversationServices: ConversationServices = {
  answerApproval: async ({ runId, approvalId, toolCallId, choice }) => {
    await sendApprovalDecision(runId, { approvalId, toolCallId }, choice)
  },
  sendInput: async ({ runId, inputId, text }) => {
    await sendRunInput(runId, text, inputId)
  },
  history: loadThreadTree,
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
