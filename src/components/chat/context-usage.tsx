// SOURCING: the installed assistant-ui context-display element (standalone,
// props-driven) fed by Theorem's own usage part (`theorem-usage`, which
// carries contextTokens and contextWindow from the last provider request),
// read off the conversation's messages the way lib/face/operations reads it.
// The element draws the ring, the bar and the hover breakdown; this file only
// finds the newest usage the run reported and hands it over.
import { useAuiState } from '@assistant-ui/react'
import type { AssistantState } from '@assistant-ui/react'
import { useMemo } from 'react'
import { ContextDisplay } from '@/components/assistant-ui/elements/context-display'
import type { TokenUsage } from '@/components/assistant-ui/utils/context-usage'

/** The newest usage the conversation's runs reported, as one stable string
 *  ("tokens:window") so the selector hands back the same value until it
 *  changes; deriving an object inside the selector would loop the subscription. */
function latestUsage(state: AssistantState): string | undefined {
  const { messages } = state.thread
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]
    if (message?.role !== 'assistant') continue
    const content = message.content
    for (let index = content.length - 1; index >= 0; index--) {
      const part = content[index]
      if (part?.type !== 'data' || part.name !== 'theorem-usage') continue
      const data = part.data as
        | { contextTokens?: unknown; contextWindow?: unknown }
        | null
        | undefined
      const tokens = data?.contextTokens
      const window = data?.contextWindow
      if (typeof tokens !== 'number' || !Number.isFinite(tokens)) continue
      if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0)
        continue
      return `${tokens}:${window}`
    }
  }
  return undefined
}

/**
 * How full the conversation is, as the assistant-ui context ring beside the
 * composer's actions. Draws nothing until a run has reported its usage.
 */
export function ComposerContextUsage() {
  const reported = useAuiState(latestUsage)
  const threadId = useAuiState((s) => s.threadListItem.id)
  const [tokens = 0, window = 0] = reported
    ? reported.split(':').map(Number)
    : []
  const tokenUsage = useMemo<TokenUsage>(
    () => ({ totalTokens: tokens }),
    [tokens],
  )
  if (!reported) return null
  return (
    <ContextDisplay.Ring
      modelContextWindow={window}
      usage={tokenUsage}
      resetKey={threadId}
      side="top"
      className="aui-composer-context-usage"
    />
  )
}
