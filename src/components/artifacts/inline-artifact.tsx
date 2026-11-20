// SOURCING: SceneCard's native dialog expansion. The authored App stays in
// the same DOM subtree, so enlarging an answer keeps its running frame,
// component state, selections, and pointer interactions.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useComposerReferences } from '@/components/chat/composer-references'
import { OPENS_WHOLE, thingProps } from '@/lib/face/things'
import { cn } from '@/lib/utils'

/** Bring an existing live revision into view; never mount a second App. */
export function focusInlineArtifact(partId: string): boolean {
  const target = [...document.querySelectorAll<HTMLDialogElement>('[data-slot="inline-artifact"]')]
    .find((node) => node.dataset.partId === partId && node.dataset.current === 'true')
  // Reuse the dialog's synchronous Escape/collapse handler before focusing
  // another part of the conversation, which is inert while it is modal.
  for (const node of document.querySelectorAll<HTMLDialogElement>('[data-slot="inline-artifact"]'))
    if (node !== target && node.dataset.layout === 'full')
      node.dispatchEvent(new Event('cancel', { cancelable: true }))
  if (!target) return false
  target.scrollIntoView({ block: 'center' })
  target.focus({ preventScroll: true })
  return true
}

export function InlineArtifact({
  title,
  actions,
  children,
  artifactId,
  partId,
  current,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  artifactId?: string
  partId?: string
  current?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const expanded = useRef(false)
  const switching = useRef(false)
  const [full, setFull] = useState(false)

  const place = useCallback((next: boolean) => {
    const node = dialog.current
    if (!node) return
    switching.current = true
    try {
      if (node.open) node.close()
      if (next) node.showModal()
      else node.setAttribute('open', '')
      expanded.current = next
      setFull(next)
    } finally {
      switching.current = false
    }
    toggle.current?.focus()
  }, [])

  // An arriving answer must not take focus away from the composer.
  useLayoutEffect(() => {
    dialog.current?.setAttribute('open', '')
  }, [])

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    const cancel = (event: Event) => {
      event.preventDefault()
      if (expanded.current) place(false)
    }
    const close = () => {
      // Ignore close events from our close/reopen transition, including
      // events that the browser queued until after it reopened.
      if (switching.current || node.open) return
      node.setAttribute('open', '')
      expanded.current = false
      setFull(false)
      toggle.current?.focus()
    }
    node.addEventListener('cancel', cancel)
    node.addEventListener('close', close)
    return () => {
      node.removeEventListener('cancel', cancel)
      node.removeEventListener('close', close)
    }
  }, [place])

  useEffect(() => useComposerReferences.subscribe((next, previous) => {
    if (expanded.current && next.references.some((ref) => !previous.references.includes(ref)))
      place(false)
    // askAbout adds the reference synchronously, then focuses the composer.
    // Closing here makes that composer available before focus is attempted.
  }), [place])

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      tabIndex={-1}
      data-slot="inline-artifact"
      data-artifact-id={artifactId}
      data-part-id={partId}
      data-current={current || undefined}
      data-face-perch="artifact"
      {...(artifactId && thingProps('artifact', artifactId, { label: title, whole: full }))}
      data-layout={full ? 'full' : 'inline'}
      className={cn(
        'relative m-0 my-3 w-full max-w-none flex-col border-0 bg-transparent p-0 text-ink open:flex',
        '[&:modal]:fixed [&:modal]:inset-2 [&:modal]:m-0 [&:modal]:size-auto [&:modal]:max-h-none [&:modal]:rounded-artifact [&:modal]:bg-artifact [&:modal]:p-3 sm:[&:modal]:inset-6',
        'backdrop:bg-black/40 supports-backdrop-filter:backdrop:backdrop-blur-xs',
      )}
    >
      <div className="flex shrink-0 items-center justify-end gap-1 pb-1">
        {actions}
        <Button
          ref={toggle}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={full}
          {...OPENS_WHOLE}
          onClick={() => place(!full)}
          className="text-ink-muted hover:text-ink pointer-coarse:size-11"
        >
          {full ? <Icon.Close aria-hidden /> : <Icon.Expand aria-hidden />}
          <span className="sr-only">{full ? 'Collapse' : 'Expand'}</span>
        </Button>
      </div>
      <div className={cn('min-h-0 w-full', full && 'flex-1 overflow-auto')}>
        {children}
      </div>
    </dialog>
  )
}
