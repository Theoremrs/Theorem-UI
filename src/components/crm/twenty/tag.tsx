// SOURCING: Twenty UI's Tag primitive (packages/twenty-ui/src/primitives/data-display/Tag, MIT), ported: its box (20 px high, 0 8 px padding, 4 px radius, 4 px gap), its soft, outline, ghost and solid variants, the start icon and truncation, re-expressed with Tailwind classes. Twenty's named tag colours become Theorem's tones, picked by the caller.
//
// Ported from twenty-ui at commit 26fa97ebc8a5773e842ba0d2f01e0b24bed6e7d0.
// Copyright (c) 2023-present Twenty.com, PBC. MIT License; the full text is
// in ./LICENSE-twenty.md.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type TagTone = 'teal' | 'ochre' | 'redwood' | 'neutral' | 'error' | 'plain'

const SOFT: Record<TagTone, string> = {
  teal: 'bg-teal-container text-teal-ink',
  ochre: 'bg-ochre-container text-ochre-ink',
  redwood: 'bg-redwood-container text-redwood-ink',
  neutral: 'bg-selected text-ink',
  error: 'bg-error-container text-error-ink',
  plain: 'bg-ink/4 text-ink-muted',
}

/** The order an enum's options take their tones in. */
export const TAG_TONES: TagTone[] = [
  'teal',
  'ochre',
  'redwood',
  'neutral',
  'error',
  'plain',
]

/** An option keeps its tone as long as it keeps its place among the options. */
export const tagToneAt = (index: number): TagTone =>
  TAG_TONES[(index < 0 ? TAG_TONES.length - 1 : index) % TAG_TONES.length]!

export function Tag({
  children,
  tone = 'plain',
  variant = 'soft',
  weight = 'regular',
  startIcon,
  title,
  className,
}: {
  children: ReactNode
  tone?: TagTone
  variant?: 'soft' | 'outline' | 'ghost'
  weight?: 'regular' | 'medium'
  startIcon?: ReactNode
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 max-w-full min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-sm px-2 text-[13px] leading-none',
        weight === 'medium' && 'font-medium',
        variant === 'ghost'
          ? 'bg-transparent text-ink-muted'
          : variant === 'outline'
            ? 'border border-control text-ink-muted'
            : SOFT[tone],
        className,
      )}
    >
      {startIcon && (
        <span aria-hidden className="flex shrink-0 [&>svg]:size-3.5">
          {startIcon}
        </span>
      )}
      <span className="min-w-0 truncate whitespace-nowrap">{children}</span>
    </span>
  )
}
