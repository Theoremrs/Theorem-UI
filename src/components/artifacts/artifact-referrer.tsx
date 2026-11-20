// SOURCING: ui/button; focusInlineArtifact (inline-artifact) is the existing
// way to bring an already-mounted live instance forward, and useOpenMode
// (shell/modes) the existing way to reach its conversation from another mode.
//
// A live App belongs to the answer that ran it: that answer mounts exactly
// one runtime (artifact-message.tsx). A panel mounting a second would start
// the App twice and split its local state between two frames. This is the
// panel's body for a live interactive artifact: it names the App, summarizes
// it, and brings the answer's instance forward. Nothing here runs it: no
// frame, no document read — even the App preview is left out, because a
// preview frame re-executes the App's startup.
import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useOpenMode } from '@/components/shell/modes'
import type { TheoremArtifact } from './artifact-model'
import { focusInlineArtifact } from './inline-artifact'

/** How long to wait for the answer to mount after reaching its conversation. */
const ANSWER_FRAMES = 60

export function ArtifactReferrer({ artifact }: { artifact: TheoremArtifact }) {
  const openMode = useOpenMode()
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
      try {
        await openMode('chat')
      } catch {
        // Surfaces without a router (a full-screen phone panel, a fixture)
        // cannot navigate; still try to focus whatever is already mounted.
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
  }, [artifact.partId, openMode])
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
