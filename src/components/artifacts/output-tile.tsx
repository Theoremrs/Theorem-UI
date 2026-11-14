// SOURCING: the artifact model and its inline AppPreview (a passive live frame, or its poster off screen), drawn at a quarter of its size for a thumbnail; the owned output marks from components/icons. The owner's review on 2026-11-14 asked for the right drawer to be a collection of thumbnails, not a list.
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { AppPreview } from './app-revision-frame'
import { kindLabel } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'
import { cn } from '@/lib/utils'

/** The first stretch of a document or source, as the thumbnail shows it. */
const PREVIEW_CHARACTERS = 900

/** Markdown's own marks, which read as noise at thumbnail size. */
const stripMarks = (text: string) =>
  text.replace(/^#{1,6}\s+/gm, '').replace(/[*_`]{1,3}/g, '')

/**
 * What an artifact looks like, small: an App drawn at a quarter of its size,
 * anything else as the opening of its text.
 */
export function ArtifactThumbnail({ artifact }: { artifact: TheoremArtifact }) {
  if (artifact.kind === 'app' && artifact.content)
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25"
      >
        <AppPreview artifact={artifact} />
      </div>
    )
  const code = artifact.kind === 'code'
  const text = (artifact.content || artifact.fallbackText).slice(
    0,
    PREVIEW_CHARACTERS,
  )
  return (
    <p
      aria-hidden
      className={cn(
        'absolute inset-0 overflow-hidden p-2.5 text-[8px] leading-[11px] text-ink-muted',
        '[mask-image:linear-gradient(to_bottom,black_70%,transparent)]',
        code ? 'font-mono whitespace-pre' : 'whitespace-pre-wrap',
      )}
    >
      {code ? text : stripMarks(text)}
    </p>
  )
}

/** One output in the drawer's collection: its picture, its name, what it is. */
export function OutputTile({
  title,
  detail,
  mark: Mark,
  onOpen,
  children,
}: {
  title: string
  detail: string
  mark: ComponentType<SVGProps<SVGSVGElement>>
  onOpen: () => void
  /** The thumbnail; without one the tile shows the output's mark. */
  children?: ReactNode
}) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        title={title}
        onClick={onOpen}
        className="group flex w-full flex-col gap-1.5 rounded-lg text-start outline-none focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-sheet ring-1 ring-separator transition-shadow group-hover:ring-ink-faint">
          {children ?? (
            <span className="absolute inset-0 flex items-center justify-center bg-hover">
              <Mark aria-hidden className="size-7 text-ink-faint" />
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-col px-0.5">
          <span data-appearance-recipe="ui.label" className="truncate text-sm">
            {title}
          </span>
          <span className="truncate text-xs text-ink-muted">{detail}</span>
        </span>
      </button>
    </li>
  )
}

/** A conversation artifact's tile: its latest revision's picture. */
export function ArtifactTile({
  versions,
  mark,
  onOpen,
}: {
  versions: readonly TheoremArtifact[]
  mark: ComponentType<SVGProps<SVGSVGElement>>
  onOpen: (artifactId: string) => void
}) {
  const latest = versions.at(-1)
  if (!latest) return null
  return (
    <OutputTile
      title={latest.title}
      detail={
        versions.length > 1
          ? `${kindLabel(latest)} · ${versions.length} revisions`
          : kindLabel(latest)
      }
      mark={mark}
      onOpen={() => onOpen(latest.artifactId)}
    >
      <ArtifactThumbnail artifact={latest} />
    </OutputTile>
  )
}
