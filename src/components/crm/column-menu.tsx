// SOURCING: the generic record table's HeaderMenu and AddFieldMenu (Twenty's column menu: Filter, Sort, Move left and right, Hide; and the "+" column that lists the hidden fields and "Customize fields"), over coss ui Menu; the schema register's field icons (components/records/fields)
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  EyeOff,
  ListFilter,
  Plus,
  Settings2,
} from 'lucide-react'
import { useRef } from 'react'
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

/**
 * A column's menu: the arrow beside its name. The identifier column offers
 * Filter and Sort only; it is pinned and always shown.
 */
export function HeaderMenu({
  field,
  isIdentifier,
  canMoveLeft,
  canMoveRight,
  onSort,
  onFilter,
  onMove,
  onHide,
}: {
  field: FieldSpec
  isIdentifier: boolean
  canMoveLeft: boolean
  canMoveRight: boolean
  onSort: (descending: boolean) => void
  onFilter: () => void
  onMove: (delta: -1 | 1) => void
  onHide: () => void
}) {
  // Filter puts the cursor in the filter field; the menu must not take it back.
  const filtering = useRef(false)
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) filtering.current = false
      }}
    >
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`${field.label} column menu`}
            className="mx-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-faint opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus group-hover/header:opacity-100 data-popup-open:bg-hover data-popup-open:opacity-100"
          />
        }
      >
        <ChevronDown aria-hidden className="size-3" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="w-44"
        finalFocus={() => !filtering.current}
      >
        <MenuItem
          onClick={() => {
            filtering.current = true
            onFilter()
          }}
        >
          <ListFilter aria-hidden /> Filter
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
