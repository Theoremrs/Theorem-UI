// SOURCING: the browser's own navigator.clipboard (clipboard port); lib/theorem/passthrough's theoremJson over the project's outputs route (the route useCabinetOutputs pages through, which has no non-hook client) and components/cabinet/catalog's readLatestArtifact (the cabinet's own read of an artifact in its session) for the artifacts port
import { readLatestArtifact } from '@/components/cabinet/catalog'
import { theoremJson } from '@/lib/theorem/passthrough'
import type { ProjectOutputPage } from '@/lib/theorem/organization'
import type { ArtifactsPort, ClipboardPort } from '@/lib/workbench/adapter'
import { refusal } from '@/lib/workbench/port'

/** The browser clipboard. A browser that refuses (no permission, no focus) is a failed effect with its reason. */
export function createClipboardPort(): ClipboardPort {
  return {
    async perform(effect) {
      if (!('clipboard' in navigator))
        return refusal('owner_unavailable', 'This browser has no clipboard')
      try {
        if (effect.kind === 'clipboardWrite') {
          await navigator.clipboard.writeText(effect.payload.text)
          return { outcome: 'accepted' }
        }
        const text = await navigator.clipboard.readText()
        return {
          outcome: 'accepted',
          value: { type: 'clipboard', text },
        }
      } catch (error) {
        return {
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/** An artifact is named on the wire by its session and its id: `<threadId>/<artifactId>`. */
const artifactKey = (threadId: string, artifactId: string) =>
  `${threadId}/${artifactId}`

/** The project's artifact cabinet: the outputs Theorem lists (searched and filtered by Theorem), and an artifact's newest content from its session. */
export function createArtifactsPort(projectId: string): ArtifactsPort {
  return {
    async perform(effect) {
      try {
        if (effect.kind === 'artifactsList') {
          const { query, category, cursor } = effect.payload
          const params = new URLSearchParams({ limit: '48' })
          if (cursor) params.set('cursor', cursor)
          if (query) params.set('q', query)
          if (category) params.set('category', category)
          const page = await theoremJson<ProjectOutputPage>(
            `/api/chat/v1/projects/${encodeURIComponent(projectId)}/outputs?${params}`,
          )
          return {
            outcome: 'accepted',
            value: {
              type: 'artifacts',
              entries: page.items.flatMap((item) =>
                item.artifactId
                  ? [
                      {
                        key: artifactKey(item.threadId, item.artifactId),
                        ...(item.category ? { category: item.category } : {}),
                      },
                    ]
                  : [],
              ),
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            },
          }
        }
        const [threadId, artifactId] = effect.payload.key.split('/')
        const artifact =
          threadId && artifactId
            ? await readLatestArtifact(threadId, artifactId)
            : undefined
        if (!artifact)
          return refusal('not_found', 'That artifact is not in its session')
        return {
          outcome: 'accepted',
          value: {
            type: 'artifactContent',
            key: effect.payload.key,
            text: artifact.content,
          },
        }
      } catch (error) {
        return {
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
