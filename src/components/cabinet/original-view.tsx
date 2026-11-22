// SOURCING: ui/dialog (Base UI Dialog) shows an original; components/artifacts'
// ArtifactView renders an artifact revision. Moved out of cabinet-view.tsx so
// the mounted cabinet and the workbench's Artifacts panel open originals the
// same way.
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { TheoremArtifact } from '@/components/artifacts/artifact-model'
import { ArtifactReferrer } from '@/components/artifacts/artifact-referrer'
import { isLive } from '@/components/artifacts/artifact-registry'
import { OpenLatestContext } from '@/components/artifacts/app-history'
import { ArtifactView } from '@/components/artifacts/artifact-renderers'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { describeError } from '@/lib/theorem/client'
import { readUpload, uploadContentPath } from '@/lib/theorem/uploads'
import { readArtifactRevision, readLatestArtifact } from './catalog'
import type { CatalogEntry } from './contract'

/** An object URL for `blob` that lives exactly as long as its user. */
function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>()
  // The URL is an external resource whose life is this effect's: it is made
  // and revoked here, so state follows it rather than render creating it
  // (which StrictMode's re-run would revoke under the image).
  useEffect(() => {
    const u = blob && URL.createObjectURL(blob)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u)
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [blob])
  return url
}

/** Opening reveals the original: the exact revision the card stands for. */
export function OriginalView({
  entry,
  onClose,
}: {
  entry: CatalogEntry | undefined
  onClose: () => void
}) {
  // "Open latest" inside a saved App revision switches this view to the
  // newest revision its session holds; a new card starts at its own revision.
  const [latest, setLatest] = useState<string>()
  const showLatest = latest !== undefined && latest === entry?.key
  const original = useQuery({
    queryKey: [
      'cabinet',
      'original',
      entry?.key,
      showLatest ? 'latest' : entry?.source.revision,
    ] as const,
    enabled: entry !== undefined,
    staleTime: Infinity,
    queryFn: async (): Promise<
      | { type: 'artifact'; artifact: TheoremArtifact }
      | { type: 'image'; blob: Blob }
      | { type: 'text'; text: string; markdown: boolean }
      | { type: 'file'; blob: Blob }
    > => {
      const e = entry!
      if (e.source.type === 'artifact') {
        const artifact = showLatest
          ? await readLatestArtifact(e.threadId, e.source.artifactId)
          : await readArtifactRevision(
              e.threadId,
              e.source.artifactId,
              e.source.revision,
            )
        if (!artifact)
          throw new Error('That revision is no longer in its session.')
        return { type: 'artifact', artifact }
      }
      if (e.source.type === 'review')
        throw new Error('A review opens in its own pane.')
      const blob = await readUpload(uploadContentPath(e.source.uploadId))
      const media = e.mediaType || blob.type
      if (media.startsWith('image/')) return { type: 'image', blob }
      if (media.startsWith('text/') || /json|markdown|xml/.test(media))
        return {
          type: 'text',
          text: await blob.text(),
          markdown: /markdown/.test(media),
        }
      return { type: 'file', blob }
    },
  })
  const data = original.data
  // The dialog owns the blob's URL and releases it when it stops showing it.
  const url = useObjectUrl(
    data?.type === 'image' || data?.type === 'file' ? data.blob : undefined,
  )
  return (
    <Dialog
      open={entry !== undefined}
      onOpenChange={(o) => {
        if (o) return
        // Each opening starts at the revision its card shows.
        setLatest(undefined)
        onClose()
      }}
    >
      <DialogContent
        data-cabinet-original=""
        className="flex max-h-[88vh] w-[min(960px,94vw)] max-w-none flex-col gap-3 overflow-hidden"
      >
        <DialogTitle>{entry?.title}</DialogTitle>
        <DialogDescription>
          {entry &&
            (showLatest && data?.type === 'artifact'
              ? `Latest revision ${String(data.artifact.revision).slice(0, 12)} · the card shows ${entry.source.revision.slice(0, 12)}`
              : `Revision ${entry.source.revision.slice(0, 12)} · opened from the gallery`)}
        </DialogDescription>
        <div className="min-h-0 flex-1 overflow-auto">
          {original.error ? (
            <p className="text-sm text-error-ink">
              {describeError(original.error)}
            </p>
          ) : !data ? (
            <p className="text-sm text-ink-muted">Opening…</p>
          ) : data.type === 'artifact' ? (
            // Review §4.2 (cabinet entry point): a live App runs once, in the
            // answer that wrote it. "Open latest" on a live interactive
            // artifact must refer to that single runtime, not mount a second
            // DocumentApp beside it. The default view (the pinned revision,
            // showLatest false) and any non-live artifact keep the interactive
            // ArtifactView below.
            isLive(data.artifact, 'interactive') && showLatest ? (
              <ArtifactReferrer artifact={data.artifact} />
            ) : (
              <OpenLatestContext.Provider
                value={showLatest ? undefined : () => setLatest(entry?.key)}
              >
                <ArtifactView
                  artifact={data.artifact}
                  distance="interactive"
                  latest={showLatest}
                />
              </OpenLatestContext.Provider>
            )
          ) : data.type === 'image' ? (
            <img
              src={url}
              alt={entry?.title ?? ''}
              className="mx-auto max-h-[70vh] object-contain"
            />
          ) : data.type === 'text' ? (
            data.markdown && entry ? (
              <ArtifactView
                artifact={markdownArtifact(entry, data.text)}
                distance="interactive"
                latest={false}
              />
            ) : (
              <pre className="text-xs whitespace-pre-wrap">{data.text}</pre>
            )
          ) : (
            <a href={url} download={entry?.title} className="underline">
              Download {entry?.title}
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** An uploaded Markdown file, shown through the document renderer. */
function markdownArtifact(entry: CatalogEntry, text: string): TheoremArtifact {
  return {
    partId: entry.key,
    artifactId: entry.key,
    revision: entry.source.revision,
    kind: 'document',
    rendererId: 'theorem.document',
    contractVersion: 'theorem-artifact-v1',
    lifecycle: 'ready',
    patchSequence: 0,
    title: entry.title,
    content: text,
    language: 'markdown',
    fallbackText: entry.title,
    payloadRef: undefined,
    runId: undefined,
    sourceTool: undefined,
    notebook: undefined,
  }
}
