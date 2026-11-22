// SOURCING: Twenty UI's Avatar primitive (packages/twenty-ui/src/primitives/data-display/Avatar, MIT), ported: its sizes (12, 14, 16, 24, 32 and 40 px with 8, 10, 12, 13, 16 and 16 px letters), its shapes (square, rounded square, circle), the initial as the fallback, an icon in place of the initial, and a colour chosen from the name so a record keeps its colour. Twenty picks from its own P3 palette; here the tones are Theorem's container tokens. No image loading: the CRM has no pictures of records.
//
// Ported from twenty-ui at commit 26fa97ebc8a5773e842ba0d2f01e0b24bed6e7d0.
// Copyright (c) 2023-present Twenty.com, PBC. MIT License; the full text is
// in ./LICENSE-twenty.md.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'

const SIZE: Record<AvatarSize, string> = {
  xs: 'size-3 text-[8px]',
  sm: 'size-3.5 text-[10px]',
  md: 'size-4 text-[12px]',
  lg: 'size-6 text-[13px]',
  xl: 'size-8 text-[16px]',
  xxl: 'size-10 text-[16px]',
}

const SHAPE = {
  square: 'rounded-[2px]',
  'rounded-square': 'rounded-sm',
  circle: 'rounded-full',
} as const

/** Theorem's tinted containers; each carries its own legible ink in light and dark. */
const TONES = [
  'bg-teal-container text-teal-ink',
  'bg-ochre-container text-ochre-ink',
  'bg-redwood-container text-redwood-ink',
  'bg-selected text-ink',
  'bg-error-container text-error-ink',
]

/** The same seed always lands on the same tone. */
export function avatarTone(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return TONES[hash % TONES.length]!
}

/** Twenty's getAvatarInitial: the first letter, upper-cased. */
export const avatarInitial = (name?: string | null) =>
  (name ?? '').trim().charAt(0).toUpperCase()

export function Avatar({
  name,
  colorSeed = name,
  size = 'md',
  shape = 'square',
  icon,
  className,
}: {
  name?: string | null
  /** What the colour is chosen from; a record's id outlives a rename. */
  colorSeed?: string | null
  size?: AvatarSize
  shape?: keyof typeof SHAPE
  /** Drawn in place of the initial, without a tinted ground. */
  icon?: ReactNode
  className?: string
}) {
  const initial = avatarInitial(name)
  return (
    <span
      aria-hidden
      className={cn(
        'relative box-border inline-flex shrink-0 items-center justify-center overflow-hidden leading-none font-medium select-none',
        SIZE[size],
        SHAPE[shape],
        icon
          ? 'text-ink-muted'
          : initial
            ? avatarTone(colorSeed ?? '')
            : 'bg-ink/4 text-ink-faint',
        className,
      )}
    >
      {icon ?? (initial || '-')}
    </span>
  )
}
