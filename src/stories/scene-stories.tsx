// SOURCING: the real Thread and its part renderers over an assistant-ui external-store runtime, as the registry's thread stories do; the scene card is scene-part.tsx drawing Theorem's committed SceneOS page (fixtures/scenes.ts) through its SceneHost context.
//
// A reply with an interactive scene, as the conversation draws it: the
// person's question, then the reply's words around the scene part. The story
// is not ready for a capture until the card has stopped loading, and an
// expanded story expands the card the way a person does, with its button.
import { useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ReadonlyJSONObject } from 'assistant-stream/utils'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { useArtifactView } from '@/components/artifacts/artifact-view'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import { SCENE_CONTRACT, SCENE_PART } from '@/components/chat/scene-model'
import { SceneHost } from '@/components/chat/scene-part'
import { SCENE_STORIES, STORY_SCENE_HOST } from './fixtures/scenes'
import type { SceneFixture, SceneStory } from './fixtures/scenes'
import cpu from './fixtures/scene/cpu.json?raw'
import adder from './fixtures/scene/adder.json?raw'
import adderThrows from './fixtures/scene/adder-throws.json?raw'
import adderLoadFails from './fixtures/scene/adder-load-fails.json?raw'

// Read as text: the packages are served data, not modules to type-check.
const PACKAGES: Record<SceneFixture, ReadonlyJSONObject> = {
  cpu: JSON.parse(cpu),
  adder: JSON.parse(adder),
  'adder-throws': JSON.parse(adderThrows),
  'adder-load-fails': JSON.parse(adderLoadFails),
}

/** The stored `scene` part's payload, as conversation_scene writes it. */
function scenePart(story: SceneStory): ReadonlyJSONObject {
  const scenePackage = PACKAGES[story.fixture]
  return {
    contractVersion: SCENE_CONTRACT,
    sceneId: String(scenePackage.id),
    title: story.question,
    fallbackText: story.before,
    packageHash: `fixture-${story.fixture}`,
    scenePackage,
  }
}

const STORY_THREAD = 'story-scene-thread'

function messages(story: SceneStory): ThreadMessageLike[] {
  return [
    {
      id: `${story.id}-question`,
      role: 'user',
      content: [{ type: 'text', text: story.question }],
    },
    {
      id: `${story.id}-reply`,
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [
        { type: 'text', text: story.before },
        { type: 'data', name: SCENE_PART, data: scenePart(story) },
        { type: 'text', text: story.after },
      ],
    },
  ]
}

/** Holds the capture back while any card loads; expands the reply's once it has drawn, when asked. */
function SceneSettled({ expand }: { expand: boolean }) {
  const [phase, setPhase] = useState('loading')
  useEffect(() => {
    let expanded = false
    const read = () => {
      const cards = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="theorem-scene-card"]',
        ),
      ]
      const card = cards[0]
      const next =
        cards.length === 0 || cards.some((c) => c.dataset.phase === 'loading')
          ? 'loading'
          : (card?.dataset.phase ?? 'loading')
      setPhase(next)
      if (expand && !expanded && next === 'ready') {
        expanded = true
        card
          ?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
          ?.click()
      }
    }
    const observer = new MutationObserver(read)
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-phase'],
      childList: true,
    })
    read()
    return () => observer.disconnect()
  }, [expand])
  return phase === 'loading' ? <span hidden data-story-pending /> : null
}

/** The workspace panel beside the conversation, opened to the reply's scene as Open does. */
function ScenePanel({ sceneId }: { sceneId: string }) {
  const openId = useArtifactView((s) => s.openId)
  useEffect(() => {
    useArtifactView.getState().open(`scene:${sceneId}`)
  }, [sceneId])
  return openId ? (
    <ArtifactPanel
      artifactId={openId}
      onClose={() => useArtifactView.getState().closed(openId)}
      className="w-[46%] shrink-0 border-s border-separator"
    />
  ) : null
}

function sceneStory(story: SceneStory): ComponentType {
  return function SceneThreadStory() {
    const thread = useMemo(() => messages(story), [])
    const host = useMemo(
      () =>
        story.unreachable
          ? { path: '/story-assets/no-scene-page', mountTimeoutMs: 3_000 }
          : {
              path: STORY_SCENE_HOST,
              mountTimeoutMs: 20_000,
            },
      [],
    )
    const runtime = useExternalStoreRuntime({
      messages: thread,
      isRunning: false,
      onNew: async () => {},
      convertMessage: (message: ThreadMessageLike) => message,
      // A saved thread, so a picked part offers Ask as it does in a real conversation.
      adapters: {
        threadList: {
          threadId: STORY_THREAD,
          threads: [{ status: 'regular', id: STORY_THREAD, remoteId: STORY_THREAD }],
        },
      },
    })
    return (
      <SceneHost value={host}>
        <AssistantRuntimeProvider runtime={runtime}>
          <TheoremPartRenderers />
          <div className="flex h-dvh">
            <div className="min-w-0 flex-1">
              <Thread autoFocus={false} />
            </div>
            {story.panel && (
              <ScenePanel sceneId={String(PACKAGES[story.fixture].id)} />
            )}
          </div>
          <SceneSettled expand={story.expanded === true} />
        </AssistantRuntimeProvider>
      </SceneHost>
    )
  }
}

export const SCENE_STORY_RENDERS: Readonly<Record<string, ComponentType>> =
  Object.fromEntries(SCENE_STORIES.map((story) => [story.id, sceneStory(story)]))
