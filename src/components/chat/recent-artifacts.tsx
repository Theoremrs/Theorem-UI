// SOURCING: assistant-ui's empty-state element (assistant-ui/elements/empty-state: EmptyState and its staggered rise-in) holding the newest outputs across every project (lib/theorem/organization useRecentOutputs). Each picture is drawn the way a chat attachment's is (chat/attachment-card): the gallery's pixel preview (cabinet/previews requestPreviews in pixel mode), cut to the drawing (chat/attachment-file cropToDrawing) and painted bare on the sheet (cabinet/preview-canvas PreviewCanvas), with the owner's Streamline file mark (Icon.AttachedFile) while there is none. A picture opens its artifact in that project's Gallery (shell-state openInGallery), as a document card in a reply does. No container: the picture stands on the sheet over its title and a caption (owner, 2026-11-24).
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '@/components/assistant-ui/elements/empty-state'
import { toEntry } from '@/components/cabinet/catalog'
import { PreviewCanvas } from '@/components/cabinet/preview-canvas'
import {
  presentationKey,
  requestPreviews,
  usePreviews,
} from '@/components/cabinet/previews'
import { cropToDrawing } from '@/components/chat/attachment-file'
import { Icon } from '@/components/icons'
import { useShell } from '@/components/shell/shell-state'
import { useRecentOutputs } from '@/lib/theorem/organization'
import type { RecentOutput } from '@/lib/theorem/organization'
import type { PreviewState } from '@/components/cabinet/previews'

const SHOWN = 3
/** Attachments are always pixel art, whatever the gallery's preference. */
const MODE = 'pixel'

/** How long ago, as the gallery writes it: 24m, 10h, 2d. */
function age(atMs: number, nowMs: number) {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(days / 7)
  return weeks < 52 ? `${weeks}w ago` : `${Math.round(days / 365)}y ago`
}

/** Under a new chat's composer: the last things made, each a way back in. */
export function RecentArtifacts() {
  const recent = useRecentOutputs(SHOWN)
  const entries = useMemo(
    () => recent.map(({ projectId, output }) => toEntry(projectId, output)),
    [recent],
  )
  useEffect(() => {
    if (entries.length) requestPreviews(entries, MODE)
  }, [entries])
  const states = usePreviews((s) => s.states)
  const [nowMs] = useState(() => Date.now())
  if (recent.length === 0) return null

  return (
    <EmptyState
      data-appearance-recipe="ui.label"
      className="appearance-composer-span max-w-none items-stretch gap-3 px-1 pb-6"
    >
      <section aria-label="Recent artifacts" className="flex flex-col gap-2">
        <div className="flex justify-end px-1">
          <button
            type="button"
            onClick={() => useShell.getState().setSideDrawer('outputs')}
            className="rounded-sm text-sm text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
          >
            View all
          </button>
        </div>
        <ul className="grid grid-cols-3 gap-2">
          {recent.map((item, index) => (
            <li key={item.output.outputId}>
              <Artifact
                item={item}
                index={index}
                state={states[presentationKey(entries[index]!, MODE)]}
                when={age(item.output.updatedAtMs, nowMs)}
              />
            </li>
          ))}
        </ul>
      </section>
    </EmptyState>
  )
}

function Artifact({
  item: { projectId, output },
  index,
  state,
  when,
}: {
  item: RecentOutput
  index: number
  state: PreviewState | undefined
  when: string
}) {
  const navigate = useNavigate()
  const box = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>()
  useEffect(() => {
    const node = box.current
    if (!node) return
    const observer = new ResizeObserver(([seen]) => {
      if (seen)
        setSize({
          width: seen.contentRect.width,
          height: seen.contentRect.height,
        })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const picture = useMemo(
    () => (state?.status === 'ready' ? cropToDrawing(state) : undefined),
    [state],
  )

  const open = () => {
    const shell = useShell.getState()
    shell.setProjectId(projectId)
    if (output.artifactId) shell.openInGallery(output.artifactId)
    else
      void navigate({
        to: '/c/$threadId',
        params: { threadId: output.threadId },
      })
  }

  return (
    <button
      type="button"
      onClick={open}
      style={{ animationDelay: `${120 + index * 70}ms` }}
      className="group fade-in slide-in-from-bottom-2 flex w-full animate-in flex-col items-center gap-1.5 rounded-md text-center outline-none fill-mode-both duration-500 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus motion-reduce:animate-none"
    >
      <span
        ref={box}
        aria-hidden
        className="flex aspect-[4/3] w-full items-center justify-center transition-transform duration-(--duration-snap) ease-snap group-hover:-translate-y-0.5"
      >
        {picture && size ? (
          <PreviewCanvas state={picture} {...size} bare />
        ) : (
          <Icon.AttachedFile className="size-16" />
        )}
      </span>
      <span className="flex w-full min-w-0 flex-col leading-5">
        <span className="truncate text-sm text-ink">{output.title}</span>
        <span className="truncate text-xs text-ink-muted tabular-nums">
          {when}
        </span>
      </span>
    </button>
  )
}
