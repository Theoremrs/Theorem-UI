// SOURCING: Twenty UI's Chip primitive (packages/twenty-ui/src/primitives/data-display/Chip, MIT), ported: its props (size, variant, shape, weight, colour, start and end elements, truncation), its box (20 px or 24 px high, 4 px gap and padding, 4 px radius, 8 px inline padding when outlined) and its hover and pressed steps, re-expressed with Tailwind classes over Theorem's tokens instead of Twenty's SCSS module and theme variables. Base UI's useRender is replaced by a plain span or button.
//
// Ported from twenty-ui at commit 26fa97ebc8a5773e842ba0d2f01e0b24bed6e7d0.
// Copyright (c) 2023-present Twenty.com, PBC. MIT License; the full text is
// in ./LICENSE-twenty.md.
import type { MouseEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type ChipProps = {
  children?: ReactNode
  /** 20 px high, or 24 px. */
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'plain' | 'soft' | 'solid' | 'outline'
  shape?: 'square' | 'round'
  weight?: 'regular' | 'medium'
  color?: 'primary' | 'secondary'
  startElement?: ReactNode
  endElement?: ReactNode
  /** Makes the chip a button. The click does not reach the row behind it. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  title?: string
  className?: string
  /** -1 keeps a chip inside a grid cell out of the tab order. */
  tabIndex?: number
  'aria-label'?: string
}

const VARIANT: Record<NonNullable<ChipProps['variant']>, string> = {
  ghost: '',
  plain: 'ps-0 bg-transparent',
  soft: 'bg-ink/4',
  solid: 'bg-ink/8',
  outline: 'border border-control bg-ink/2 px-2',
}

/** Twenty steps a clickable chip one tone up on hover and one more when pressed. */
const CLICKABLE: Record<NonNullable<ChipProps['variant']>, string> = {
  ghost: 'hover:bg-ink/4 active:bg-ink/8',
  plain: 'hover:bg-ink/4 active:bg-ink/8',
  soft: 'hover:bg-ink/8 active:bg-ink/16',
  solid: 'hover:bg-ink/16 active:bg-ink/20',
  outline: 'hover:bg-ink/4 active:bg-ink/8',
}

export function Chip({
  children,
  size = 'sm',
  variant = 'ghost',
  shape = 'square',
  weight = 'regular',
  color = 'primary',
  startElement,
  endElement,
  onClick,
  title,
  className,
  tabIndex,
  'aria-label': ariaLabel,
}: ChipProps) {
  const classes = cn(
    'box-border inline-flex max-w-full shrink-0 items-center gap-1 p-1 text-[13px] leading-none select-none',
    size === 'md' ? 'h-6' : 'h-5',
    shape === 'round' ? 'rounded-full' : 'rounded-sm',
    weight === 'medium' && 'font-medium',
    color === 'secondary' ? 'text-ink-muted' : 'text-ink',
    VARIANT[variant],
    onClick &&
      cn(
        'cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        CLICKABLE[variant],
      ),
    className,
  )
  const content = (
    <>
      {startElement}
      {children !== undefined && children !== null && children !== '' && (
        <span className="min-w-0 truncate">{children}</span>
      )}
      {endElement}
    </>
  )
  return onClick ? (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onClick={(event) => {
        event.stopPropagation()
        onClick(event)
      }}
      className={classes}
    >
      {content}
    </button>
  ) : (
    <span title={title} aria-label={ariaLabel} className={classes}>
      {content}
    </span>
  )
}
