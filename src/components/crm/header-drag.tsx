// SOURCING: @dnd-kit (core's DndContext and sensors, sortable's horizontal list, modifiers' horizontal axis), following TanStack Table's kitchen-sink example (components/data-table/ui/sortable), whose Sortable sorts a list by dragging; here the column headers are the list and a drop is the table's setColumnOrder. A column header is also the column's menu button, so the pointer drags only after moving a few pixels (a plain click still opens the menu) and the keyboard picks a column up with Alt and Space or Enter (a bare Space or Enter opens the menu)
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type {
  Announcements,
  DragEndEvent,
  KeyboardSensorOptions,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

/** What a header's button takes to be dragged by. */
export type HeaderDrag = {
  attributes: HTMLAttributes<HTMLElement>
  listeners: Record<string, unknown> | undefined
  setActivatorNodeRef: (node: HTMLElement | null) => void
}

/**
 * The order after `activeId` is dropped on `overId`: it takes that column's
 * place and the columns between shift by one. A pinned column neither moves
 * nor is moved onto, and an id the order does not hold changes nothing.
 */
export function reorderColumns(
  order: readonly string[],
  activeId: string,
  overId: string,
  pinned: readonly string[],
): string[] {
  const from = order.indexOf(activeId)
  const to = order.indexOf(overId)
  if (
    from < 0 ||
    to < 0 ||
    from === to ||
    pinned.includes(activeId) ||
    pinned.includes(overId)
  )
    return [...order]
  return arrayMove([...order], from, to)
}

/** Picks a column up on Alt with Space or Enter: the bare keys open the header's menu. */
class AltKeyboardSensor extends KeyboardSensor {
  static override activators = [
    {
      eventName: 'onKeyDown' as const,
      handler: (
        event: React.KeyboardEvent,
        { onActivation }: KeyboardSensorOptions,
        {
          active,
        }: { active: { activatorNode: { current: HTMLElement | null } } },
      ) => {
        const { code, altKey } = event.nativeEvent
        if (!altKey || (code !== 'Space' && code !== 'Enter')) return false
        const activator = active.activatorNode.current
        if (activator && event.target !== activator) return false
        event.preventDefault()
        onActivation?.({ event: event.nativeEvent })
        return true
      },
    },
  ]
}

/**
 * Lets the headers inside be dragged along the row. `movable` are the ids
 * that can be dragged, in the order shown; a drop calls `onMove(activeId,
 * overId)`.
 */
export function HeaderDragContext({
  movable,
  labelOf,
  onMove,
  children,
}: {
  movable: string[]
  labelOf: (id: string) => string
  onMove: (activeId: string, overId: string) => void
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(AltKeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )
  const name = (id: string | number) => labelOf(String(id))
  const place = (index: number | undefined) =>
    `position ${(index ?? 0) + 1} of ${movable.length}`
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up the ${name(active.id)} column. Use the left and right arrow keys to move it, Space to drop it and Escape to cancel.`,
    onDragOver: ({ active, over }) =>
      over
        ? `The ${name(active.id)} column is over ${name(over.id)}.`
        : `The ${name(active.id)} column is not over a column.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `The ${name(active.id)} column was dropped at ${place(movable.indexOf(String(over.id)))}.`
        : `The ${name(active.id)} column was dropped where it was.`,
    onDragCancel: ({ active }) =>
      `Moving the ${name(active.id)} column was cancelled.`,
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id)
      onMove(String(active.id), String(over.id))
  }
  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToHorizontalAxis]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To move this column, press Alt with Space or Enter, then the left and right arrow keys, and Space to drop it. Press Enter or Space on its own to open its menu.',
        },
      }}
    >
      <SortableContext items={movable} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

/**
 * A column header that sits in the sortable row. `children` is drawn with the
 * props the header's button takes to be the thing dragged, or none when the
 * column is pinned and stays where it is.
 */
export function SortableHeader({
  id,
  pinned,
  className,
  style,
  children,
  ...rest
}: {
  id: string
  pinned: boolean
  className?: string
  style?: CSSProperties
  children: (drag: HeaderDrag | undefined) => ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: pinned })
  return (
    <div
      {...rest}
      ref={pinned ? undefined : setNodeRef}
      data-dragging={isDragging ? '' : undefined}
      className={className}
      style={{
        ...style,
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 30 : style?.zIndex,
      }}
    >
      {children(
        pinned ? undefined : { attributes, listeners, setActivatorNodeRef },
      )}
    </div>
  )
}
