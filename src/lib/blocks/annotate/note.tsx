// SOURCING: Astryx (`@astryxdesign/core`) for every surface and control: Card
// for the note, Text for its words, ToggleButton to pin it, IconButton to
// close it. A note holds any children, so the controls in it are whatever the
// App writes. It is nonmodal: focus moves into it only when the person moves
// it there, and Escape closes it.
import { Card } from '@astryxdesign/core/Card'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Text } from '@astryxdesign/core/Text'
import { ToggleButton } from '@astryxdesign/core/ToggleButton'
import { useState } from 'react'
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react'

const icon = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
// Lucide's pin and x.
const PIN = icon('M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z')
const CLOSE = icon('M18 6 6 18M6 6l12 12')
// Lucide's maximize-2 and minimize-2.
const EXPAND = icon('M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7')
const COLLAPSE = icon('M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7')

export interface LabelProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'children'> {
  name: ReactNode
  /** The values that matter now, each shown after the name. */
  values?: ReadonlyArray<ReactNode>
  /** Quiet recedes; strong is underlined in ink, for the thing in focus. */
  emphasis?: 'quiet' | 'normal' | 'strong'
  /**
   * `'bare'`: text over the scene with a short rule under it, which a leader
   * runs into, kept legible by a halo. `'box'`: on a surface, for a busy
   * scene where a halo is not enough.
   */
  surface?: 'bare' | 'box'
  /**
   * A short explanation under the name: the tier between a label and a note,
   * for hover and focus. The label stays the same button, so focus stays on it.
   */
  detail?: ReactNode
}

/** The resting tier: a name and a few values, a button that opens more. */
export function Label({ name, values = [], emphasis = 'normal', surface = 'bare', detail, className, ...rest }: LabelProps) {
  return (
    <button
      type="button"
      {...rest}
      className={['tn-label', className].filter(Boolean).join(' ')}
      data-emphasis={emphasis}
      data-surface={surface}
      data-detail={detail === undefined ? undefined : ''}
    >
      <span className="tn-label-line">
        <Text size="xsm" weight="medium">{name}</Text>
        {values.map((value, index) => (
          <Text key={index} size="xsm" color="secondary" hasTabularNumbers>{value}</Text>
        ))}
      </span>
      {detail !== undefined && (
        <span className="tn-label-detail">
          <Text size="xsm" color="secondary">{detail}</Text>
        </span>
      )}
    </button>
  )
}

export interface NoteProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  /** A short explanation, shown on hover or focus, or always when `showDetail`. */
  detail?: ReactNode
  showDetail?: boolean
  pinned?: boolean
  /** Given, the note has a pin. */
  onPinnedChange?: (pinned: boolean) => void
  /** Given, the note has a close button and closes on Escape. */
  onClose?: () => void
  /** The tier past the note: given, the note has a button to open it. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  children?: ReactNode
}

/** A note: Astryx's card with a title, a detail and any controls. */
export function Note({ title, detail, showDetail = false, pinned = false, onPinnedChange, onClose, expanded = false, onExpandedChange, children, className, onKeyDown, ...rest }: NoteProps) {
  const [near, setNear] = useState(false)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.key === 'Escape' && onClose && !event.defaultPrevented) {
      event.stopPropagation()
      onClose()
    }
  }
  return (
    <div
      role="group"
      aria-label={typeof title === 'string' ? title : undefined}
      {...rest}
      className={['tn-note-frame', className].filter(Boolean).join(' ')}
      onPointerEnter={() => setNear(true)}
      onPointerLeave={() => setNear(false)}
      onFocus={() => setNear(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNear(false)
      }}
      onKeyDown={keyDown}
    >
      <Card padding={1} elevation="low">
        <div className="tn-note" data-expanded={expanded || undefined}>
          {/* A pinned note is moved by its head (see Annotation). */}
          <div className="tn-note-head" data-drag-handle={pinned || undefined}>
            <Text size="sm" weight="semibold">{title}</Text>
            {onExpandedChange && (
              <ToggleButton label={expanded ? 'Show less' : 'Show more'} icon={expanded ? COLLAPSE : EXPAND} isIconOnly size="sm" isPressed={expanded} onPressedChange={(value) => onExpandedChange(value)} />
            )}
            {onPinnedChange && (
              <ToggleButton label={pinned ? 'Unpin' : 'Pin'} icon={PIN} isIconOnly size="sm" isPressed={pinned} onPressedChange={(value) => onPinnedChange(value)} />
            )}
            {onClose && <IconButton label="Close" icon={CLOSE} variant="ghost" size="sm" onClick={onClose} />}
          </div>
          {detail !== undefined && (showDetail || near) && (
            <Text size="sm" color="secondary">{detail}</Text>
          )}
          {children !== undefined && <div className="tn-note-body">{children}</div>}
        </div>
      </Card>
    </div>
  )
}
