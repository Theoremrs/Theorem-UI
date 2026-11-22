// SOURCING: @assistant-ui/react useAui (the runtime the chat already mounts)
import { useAui } from '@assistant-ui/react'
import { useMemo } from 'react'
import type { ConversationRuntime } from './conversation'
import { conversationRuntimeOf } from './runtime'

/** The conversation runtime of the chat this component sits in. */
export function useConversationRuntime(): ConversationRuntime {
  const aui = useAui()
  return useMemo(() => conversationRuntimeOf(aui), [aui])
}
