// SOURCING: assistant-ui's CodeBlock (https://www.assistant-ui.com/design/components/code-block, copied into components/ui as its docs direct; the owner's choice, 2026-11-23). Kept: the figure with a title header and a copy button that floats on hover without one, the focusable code region, the copy guard against a write settling after unmount, and maxCollapsedLines with its measured height and "Show all" toggle. Changed to the owner's editor screenshot: an opaque panel on the palette's code ground (--surface-code: Vitesse's own editor colours under Vitesse) with no outline, at the field radius rather than the composer's, as wide as its longest row; the header and the number gutter a tint of that ground rather than ruled off; the title as a compact path breadcrumb in sans type, its folders faint and its file muted; the app's copy marks; the line gutter and diff bar come from the highlighter's data-line rows (appearance.css), so the source's CSS counter and lineNumbers prop give way to it.
'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Icon } from '@/components/icons'
import { cn } from '@/lib/utils'

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

export interface CodeBlockProps extends Omit<
  ComponentProps<'figure'>,
  'title'
> {
  /** Label in the header, usually the file's path; a string path reads as a breadcrumb. */
  title?: ReactNode
  /** Classes for the scrollable code region, e.g. a max height. */
  viewportClassName?: string
  /** Text for the copy button; defaults to the rendered code's text. */
  copyText?: string
  /** Called after the copy button writes the clipboard. */
  onCopied?: () => void
  maxCollapsedLines?: number | undefined
}

function CopyButton({
  getText,
  onCopied,
  className,
}: {
  getText: () => string
  onCopied?: (() => void) | undefined
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const unmounted = useRef(false)

  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
      clearTimeout(copyTimer.current)
      setCopied(false)
    }
  }, [])

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText())
        } catch {
          return
        }
        onCopied?.()
        // The write can settle after the button is gone, and a confirmation
        // started then would outlive the cleanup that was meant to cancel it.
        if (unmounted.current) return
        setCopied(true)
        clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 1500)
      }}
      className={cn(
        'text-ink-muted hover:text-ink grid size-6 shrink-0 place-items-center rounded-(--appearance-radius-field) transition-colors',
        className,
      )}
    >
      {copied ? (
        <Icon.Copied className="animate-in fade-in zoom-in-30 -spin-in-20 ease-lift size-3 duration-(--duration-lift)" />
      ) : (
        <Icon.Copy className="animate-in fade-in zoom-in-75 size-3" />
      )}
    </button>
  )
}

/**
 * A path as the editor's header shows it: the folders faint, each slash set
 * close between them, the file a step darker. Folders give way first; an
 * exceptionally long filename can truncate too, keeping the copy button visible.
 * POSIX and Windows separators both divide the parts; the header shows slashes.
 */
function Breadcrumb({ path }: { path: string }) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  const file = parts.pop()
  return (
    <span className="flex min-w-0" title={path}>
      {parts.length > 0 && (
        <span className="text-ink-faint min-w-0 truncate">
          {parts.map((part, index) => (
            <span key={index}>
              {part}
              <span className="mx-[0.2em] opacity-70">/</span>
            </span>
          ))}
        </span>
      )}
      <span className="text-ink-muted max-w-full min-w-0 shrink-0 truncate">
        {file}
      </span>
    </span>
  )
}

/**
 * Chrome for highlighted code: an opaque panel with an optional title header
 * and a copy button. Children carry the `pre`.
 */
export function CodeBlock({
  title,
  viewportClassName,
  copyText,
  onCopied,
  maxCollapsedLines,
  className,
  children,
  ...props
}: CodeBlockProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const viewportId = useId()
  const [lineCount, setLineCount] = useState(0)
  const [collapsedHeight, setCollapsedHeight] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const getText = () =>
    copyText ?? viewportRef.current?.querySelector('pre')?.textContent ?? ''
  const collapsedLines = Math.floor(maxCollapsedLines ?? 0)
  const isCollapsible = collapsedLines > 0 && lineCount > collapsedLines
  const isCollapsed = isCollapsible && !expanded

  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || collapsedLines <= 0) {
      setLineCount(0)
      setCollapsedHeight(undefined)
      return
    }

    let observedPre: HTMLPreElement | null = null
    let resizeObserver: ResizeObserver | undefined
    const measure = () => {
      const pre = viewport.querySelector('pre')
      if (pre !== observedPre) {
        if (observedPre) resizeObserver?.unobserve(observedPre)
        observedPre = pre
        if (pre) resizeObserver?.observe(pre)
      }
      if (!pre) {
        setLineCount(0)
        setCollapsedHeight(undefined)
        return
      }
      const lines = pre.querySelectorAll('.line')
      const nextLineCount =
        lines.length ||
        pre.textContent?.replace(/\n$/, '').split('\n').length ||
        0
      const line = lines[0]
      const lineHeight =
        Number.parseFloat(getComputedStyle(line ?? pre).lineHeight) ||
        Number.parseFloat(getComputedStyle(viewport).lineHeight)
      const lastVisibleLine = lines[Math.min(collapsedLines, lines.length) - 1]
      // A source line can occupy several visual rows. Measure the first N
      // logical lines together instead of multiplying the first line's height.
      const visibleHeight =
        line && lastVisibleLine
          ? lastVisibleLine.getBoundingClientRect().bottom -
            line.getBoundingClientRect().top
          : 0
      // The pre carries the block's vertical padding, so its gutter tint
      // runs to the panel's edges.
      const verticalPadding = [viewport, pre]
        .map((element) => getComputedStyle(element))
        .reduce(
          (sum, style) =>
            sum +
            (Number.parseFloat(style.paddingBlockStart) || 0) +
            (Number.parseFloat(style.paddingBlockEnd) || 0),
          0,
        )

      setLineCount(nextLineCount)
      setCollapsedHeight(
        visibleHeight > 0
          ? `${visibleHeight + verticalPadding}px`
          : Number.isFinite(lineHeight) && lineHeight > 0
            ? `${lineHeight * collapsedLines + verticalPadding}px`
            : `calc(${collapsedLines}lh + ${verticalPadding || 0}px)`,
      )
    }

    // Observe the full pre, not the clipped viewport: wrapping, font loading,
    // and code-scale changes alter its dimensions without changing its text.
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(measure)
    }
    measure()
    const observer = new MutationObserver(measure)
    observer.observe(viewport, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    return () => {
      observer.disconnect()
      resizeObserver?.disconnect()
    }
  }, [children, collapsedLines])

  return (
    <figure
      data-code-block=""
      className={cn(
        'aui-code-block not-prose group/code bg-code relative my-3 flex w-fit max-w-full min-w-0 flex-col overflow-hidden rounded-(--appearance-radius-field)',
        className,
      )}
      {...props}
    >
      {title ? (
        <figcaption className="bg-code-gutter text-ink-faint flex min-h-7 shrink-0 items-center justify-between gap-2 py-0.5 ps-3 pe-0.5 text-xs leading-4">
          {typeof title === 'string' ? <Breadcrumb path={title} /> : title}
          <CopyButton getText={getText} onCopied={onCopied} />
        </figcaption>
      ) : (
        <CopyButton
          getText={getText}
          onCopied={onCopied}
          className="bg-code/80 absolute end-1 top-1 z-10 opacity-0 backdrop-blur-sm transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
        />
      )}
      <div className="relative min-w-0">
        <div
          ref={viewportRef}
          id={isCollapsible ? viewportId : undefined}
          role="region"
          aria-label="Code"
          tabIndex={0}
          style={isCollapsed ? { maxHeight: collapsedHeight } : undefined}
          className={cn(
            'aui-code-viewport focus-visible:outline-separator overflow-x-auto focus-visible:outline-1 focus-visible:-outline-offset-1',
            // The block is as wide as its longest row, so without a header the
            // floating copy button needs room of its own at the row's end.
            !title && 'pe-5',
            isCollapsed && 'overflow-y-hidden',
            viewportClassName,
          )}
        >
          {children}
        </div>
        {isCollapsed && (
          <div
            aria-hidden="true"
            className="from-code pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t to-transparent"
          />
        )}
      </div>
      {isCollapsible && (
        <button
          type="button"
          aria-controls={viewportId}
          aria-expanded={!isCollapsed}
          onClick={() => setExpanded((value) => !value)}
          className="text-ink-muted hover:text-ink self-start px-3.5 py-2 text-xs transition-colors motion-reduce:transition-none"
        >
          {isCollapsed ? `Show all ${lineCount} lines` : 'Show less'}
        </button>
      )}
    </figure>
  )
}
