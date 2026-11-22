import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { useEffect, useRef, useState } from 'react'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { useResponseDetails } from '@/components/chat/response-style-details'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import { ResponseStylesPage } from '@/components/settings/styles/response-styles-page'
import { seedResponseStylesSettings } from './fixtures/response-styles-settings'

const MESSAGE_ID = 'message-response-details'
const detailMessages: ThreadMessageLike[] = [
  {
    id: MESSAGE_ID,
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: [
      {
        type: 'data',
        name: 'theorem-response_style',
        data: {
          style: {
            id: 'theorem.style.concise',
            name: 'Concise',
            revision: 0,
            revisionId: 'shipped-concise',
            source: 'account',
          },
          frameworks: [
            {
              id: 'theorem.framework.explanation',
              name: 'Understanding through explanation',
              revision: 0,
              revisionId: 'shipped-explanation',
              references: ['references/source-notes.md'],
            },
          ],
          suggestions: {
            state: 'suggested',
            model: 'openrouter/typesafe/jev-1.14',
            items: [
              {
                id: 'theorem.framework.related-questions',
                category: 'framework',
                name: 'Related questions',
                relevance: 0.82,
              },
              {
                id: 'web_search',
                category: 'tool',
                name: 'Web search',
                relevance: 0.71,
              },
            ],
          },
        },
      },
      { type: 'text', text: 'Denver gets about 300 days of sun a year.' },
    ],
  },
]

function useStoryRuntime(messages: readonly ThreadMessageLike[]) {
  return useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
}

export function ResponseStylePickerStory() {
  const runtime = useStoryRuntime([])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="mx-auto flex h-[320px] w-full max-w-(--spacing-reading) flex-col">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

export function ResponseDetailsStory() {
  const runtime = useStoryRuntime(detailMessages)
  useEffect(() => {
    useResponseDetails.getState().show(MESSAGE_ID)
    return () => useResponseDetails.getState().show(undefined)
  }, [])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="mx-auto h-[620px] w-full max-w-(--spacing-reading)">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

export function ResponseStylesSettingsStory() {
  const [ready, setReady] = useState(false)
  const seed = useRef<Promise<void> | undefined>(undefined)
  useEffect(() => {
    seed.current ??= seedResponseStylesSettings()
    let active = true
    void seed.current.then(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [])
  return (
    <div className="mx-auto flex max-w-[680px] flex-col gap-6 bg-sheet px-6 py-8">
      {ready && <ResponseStylesPage />}
    </div>
  )
}
