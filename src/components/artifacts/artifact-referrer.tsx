// SOURCING: ui/button; focusInlineArtifact (inline-artifact) is the existing
// way to bring an already-mounted live instance forward, and TanStack Router's
// useRouter({ warn: false }) (as save-as-page.tsx reads it) the way to reach its
// conversation, absent on a surface with no router.
//
// A live App belongs to the answer that ran it: that answer mounts exactly
// one runtime (artifact-message.tsx). A panel mounting a second would start
// the App twice and split its local state between two frames. This is the
// panel's body for a live interactive artifact: it names the App, summarizes
// it, and brings the answer's instance forward. Nothing here runs it: no
// frame, no document read — even the App preview is left out, because a
// preview frame re-executes the App's startup.
import { useRouter } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useShell } from '@/components/shell/shell-state'
import type { TheoremArtifact } from './artifact-model'
import { focusInlineArtifact } from './inline-artifact'

/** How long to wait for the answer to mount after reaching its conversation. */
const ANSWER_FRAMES = 60

export function ArtifactReferrer({
  artifact,
  threadId,
}: {
  artifact: TheoremArtifact
  /** The conversation the App ran in, when the panel was kept open from another chat. */
  threadId?: string
}) {
  // Absent outside a router: a full-screen phone panel or a fixture.
  const router = useRouter({ warn: false }) as
    ReturnType<typeof useRouter> | undefined
  const [away, setAway] = useState(false)
  const going = useRef(false)
  const reveal = useCallback(async () => {
    if (going.current) return
    going.current = true
    try {
      if (focusInlineArtifact(artifact.partId)) {
        setAway(false)
        return
      }
      // The conversation is not on screen — a note embed opened the panel
      // from another page, another mode has it behind, or the dock restored
      // it. Go to the conversation first, then focus once its live instance
      // is mounted; never start the App here.
      // The App's own conversation when the panel was kept from another chat,
      // else the conversation chat mode shows.
      const target = threadId ?? useShell.getState().chatThreadId
      // Surfaces without a router cannot navigate; still try to focus
      // whatever is already mounted.
      try {
        if (router)
          await (target
            ? router.navigate({
                to: '/c/$threadId',
                params: { threadId: target },
              })
            : router.navigate({ to: '/' }))
      } catch {
        // A navigation that fails still leaves the focus attempt below.
      }
      for (let frame = 0; frame < ANSWER_FRAMES; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        )
        if (focusInlineArtifact(artifact.partId)) {
          setAway(false)
          return
        }
      }
      setAway(true)
    } finally {
      going.current = false
    }
  }, [artifact.partId, router, threadId])
  return (
    <section
      data-slot="artifact-referrer"
      aria-label={`${artifact.title} runs in its answer`}
      className="flex flex-col items-start gap-3 rounded-artifact border border-separator bg-raised p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="truncate font-heading text-sm font-semibold">
          {artifact.title}
        </h3>
        <p className="text-xs text-ink-muted">
          Running in the answer. A second copy here would restart the App and
          diverge from the one you are using.
        </p>
      </div>
      {artifact.fallbackText && artifact.fallbackText !== artifact.title && (
        <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-ink-muted">
          {artifact.fallbackText}
        </p>
      )}
      <Button size="sm" variant="secondary" onClick={() => void reveal()}>
        Open in answer
      </Button>
      {away && (
        <p role="status" className="text-xs text-ink-muted">
          This App's answer isn't on screen right now.
        </p>
      )}
    </section>
  )
}
