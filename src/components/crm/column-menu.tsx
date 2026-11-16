// SOURCING: the generic record table's HeaderMenu and AddFieldMenu (Twenty's column menu, opened by clicking the header: Search, Sort, Move left and right, Hide; and the "+" column that lists the hidden fields and "Customize fields"), over coss ui Menu; the schema register's field icons (components/records/fields)
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  EyeOff,
  Plus,
  Search,
  Settings2,
} from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
import type { FieldSpec } from '@/components/records/contract'
import { FieldTypeIcon } from '@/components/records/fields'
import type { HeaderDrag } from './header-drag'

/**
 * A column's menu. The column's header is its trigger, as in Twenty: a click
 * anywhere on the label opens it, and Enter or Space does from the keyboard.
 * The identifier column offers Search and Sort only; it is pinned and always
 * shown. `drag` makes the same button the column's drag handle.
 */
export function HeaderMenu({
  field,
  isIdentifier,
  canMoveLeft,
  canMoveRight,
  drag,
  onSort,
  onSearch,
  onMove,
  onHide,
  children,
}: {
  field: FieldSpec
  isIdentifier: boolean
  canMoveLeft: boolean
  canMoveRight: boolean
  drag?: HeaderDrag
  onSort: (descending: boolean) => void
  onSearch: () => void
  onMove: (delta: -1 | 1) => void
  onHide: () => void
  /** What the header shows: the field's icon and name, and its sort arrow. */
  children: ReactNode
}) {
  // Search puts the cursor in the search field; the menu must not take it back.
  const searching = useRef(false)
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onOpenChange={(next, details) => {
        // A press on the header neither opens nor closes the menu: it may be
        // the start of a drag. The click that follows it, which a drag never
        // makes, does.
        if (
          details.reason === 'trigger-press' &&
          details.event.type !== 'click'
        )
          return
        if (next) searching.current = false
        setOpen(next)
      }}
    >
      <MenuTrigger
        render={
          <button
            type="button"
            title={field.description}
            aria-label={`${field.label} column menu`}
            {...drag?.attributes}
            {...drag?.listeners}
            ref={drag?.setActivatorNodeRef}
            // A mouse click, as the press that began it opened nothing.
            onClick={(event) => {
              if (event.detail > 0) setOpen((was) => !was)
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-start text-xs text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink"
          />
        }
      >
        {children}
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="w-44"
        finalFocus={() => !searching.current}
      >
        <MenuItem
          onClick={() => {
            searching.current = true
            onSearch()
          }}
        >
          <Search aria-hidden /> Search
        </MenuItem>
        <MenuItem onClick={() => onSort(false)}>
          <ArrowUp aria-hidden /> Sort ascending
        </MenuItem>
        <MenuItem onClick={() => onSort(true)}>
          <ArrowDown aria-hidden /> Sort descending
        </MenuItem>
        {!isIdentifier && (
          <>
            <MenuSeparator />
            {canMoveLeft && (
              <MenuItem onClick={() => onMove(-1)}>
                <ArrowLeft aria-hidden /> Move left
              </MenuItem>
            )}
            {canMoveRight && (
              <MenuItem onClick={() => onMove(1)}>
                <ArrowRight aria-hidden /> Move right
              </MenuItem>
            )}
            <MenuItem onClick={onHide}>
              <EyeOff aria-hidden /> Hide
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  )
}

/** The "+" column: the fields this view hides, to show again, and the way to change the fields themselves. */
export function AddFieldMenu({
  hidden,
  onShow,
  onCustomize,
}: {
  hidden: FieldSpec[]
  onShow: (key: string) => void
  onCustomize: () => void
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Show a field"
            className="flex h-full w-full items-center justify-center text-ink-faint hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus data-popup-open:bg-hover"
          />
        }
      >
        <Plus aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-60">
        <MenuGroup>
          <MenuGroupLabel>Hidden fields</MenuGroupLabel>
          {hidden.length ? (
            hidden.map((field) => (
              <MenuItem key={field.key} onClick={() => onShow(field.key)}>
                <FieldTypeIcon kind={field.field_type.kind} />
                {field.label}
              </MenuItem>
            ))
          ) : (
            <p className="px-2 py-1.5 text-sm text-ink-muted">
              All fields are shown
            </p>
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={onCustomize}>
          <Settings2 aria-hidden /> Customize fields
        </MenuItem>
      </MenuPopup>
    </Menu>
  )
}
