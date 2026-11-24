// SOURCING: assistant-ui registry element composer-trigger-popover (https://r.assistant-ui.com/styles/base-nova/composer-trigger-popover.json) over ComposerPrimitive.TriggerPopover, vendored with five changes: the coss popup surface and item states, placement by Floating UI against the element that holds it (the primitive's absolute bottom-full placement is clipped by the thread's scroll area when the composer sits mid-screen), a list four rows tall that keeps the highlighted row in view (the primitive moves the highlight but does not scroll), two-line rows (an icon column centred on the row, the name and its description in one text column that wraps at a fixed width, a hairline where the item type changes, a translucent ink highlight, the list scrolling without a bar), an optional note under the list for state the rows cannot show, a per-item tag, and a surfaceRef, composed with the placement's, for a surface drawn over the popover's box
'use client'

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ComponentPropsWithoutRef, FC, ReactNode, Ref, RefObject } from 'react'
import {
  ComposerPrimitive,
  defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
} from '@assistant-ui/react'
import type { DirectiveFormatter, TriggerItem } from '@assistant-ui/react'
import {
  autoUpdate,
  flip,
  offset,
  size,
  useFloating,
} from '@floating-ui/react-dom'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useComposedRefs } from '@/lib/composition'
import { cn } from '@/lib/utils'

type IconComponent = FC<{ className?: string }>

type DirectiveBehaviorProps = {
  /** Formatter used to serialize the selected item into composer text. */
  formatter?: DirectiveFormatter | undefined
  /** Called after the directive text has been inserted into the composer. */
  onInserted?: ((item: TriggerItem) => void) | undefined
}

type ActionBehaviorProps = {
  /** Formatter used to serialize the audit-trail chip (when `removeOnExecute` is false). */
  formatter?: DirectiveFormatter | undefined
  /** Invoked with the selected item at the moment of selection. */
  onExecute: (item: TriggerItem) => void
  /** If `true`, strip the trigger text from the composer after executing. @default false */
  removeOnExecute?: boolean | undefined
}

type ComposerTriggerPopoverBaseProps = Omit<
  ComponentPropsWithoutRef<typeof ComposerPrimitive.TriggerPopover>,
  'children'
> & {
  /**
   * Maps icon keys to components. Items look up via `item.metadata?.icon`
   * (string); categories look up via their `id`.
   */
  iconMap?: Record<string, IconComponent>
  /** Icon when no entry in `iconMap` matches; without one such rows have no icon. */
  fallbackIcon?: IconComponent
  /**
   * State the rows cannot show, such as a source that failed to load, under
   * the list. It renders with the items, only while the popover is open, and
   * takes no room when it renders nothing.
   */
  note?: ReactNode
  /** A short trailing note for an item, such as what it changes. */
  itemTag?: (item: TriggerItem) => ReactNode
  /** Label shown on the back button. @default "Back" */
  backLabel?: string
  /** Label shown when no categories are available. @default "No items available" */
  emptyCategoriesLabel?: string
  /** Label shown when no items match. @default "No matching items" */
  emptyItemsLabel?: string
  /** Label shown while an async adapter is resolving items. @default "Loading…" */
  loadingLabel?: string
  /** The popover's own element, for a surface drawn over its box. */
  surfaceRef?: Ref<HTMLDivElement>
}

type ComposerTriggerPopoverProps = ComposerTriggerPopoverBaseProps &
  (
    | {
        /** Insert-directive behavior. */
        directive: DirectiveBehaviorProps
        action?: never
      }
    | {
        /** Action behavior. */
        action: ActionBehaviorProps
        directive?: never
      }
  )

function resolveIcon(
  iconKey: string | undefined,
  iconMap: Record<string, IconComponent> | undefined,
  fallback: IconComponent | undefined,
): IconComponent | undefined {
  return (iconKey ? iconMap?.[iconKey] : undefined) ?? fallback
}

/**
 * A row's box and its highlight: ink at 7% over whatever the menu is (a solid
 * fill or the glass), with the text keeping its own colours.
 */
const ROW =
  'w-full cursor-default rounded-sm px-2 py-1 text-start text-foreground outline-none select-none data-highlighted:bg-ink/7'

/** The icon column and the text column every item row shares. */
const COLUMNS = 'grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5'

/** A hairline across the list, inset from its edges. */
const HAIRLINE = 'bg-separator mx-1 my-1 h-px'

type CategoriesProps = {
  iconMap: Record<string, IconComponent> | undefined
  fallbackIcon: IconComponent | undefined
  emptyLabel: string
}

const Categories: FC<CategoriesProps> = ({
  iconMap,
  fallbackIcon,
  emptyLabel,
}) => (
  <ComposerPrimitive.TriggerPopoverCategories>
    {(categories) => (
      <div
        data-slot="composer-trigger-popover-categories"
        className="flex flex-col p-1"
      >
        {categories.map((cat) => {
          const Icon = resolveIcon(cat.id, iconMap, fallbackIcon)
          return (
            <ComposerPrimitive.TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
              className={cn(ROW, 'flex items-center justify-between gap-2.5')}
            >
              <span className="flex items-center gap-2.5 text-sm font-semibold">
                {Icon && <Icon className="text-ink-muted size-4" />}
                {cat.label}
              </span>
              <ChevronRightIcon className="text-ink-muted size-4" />
            </ComposerPrimitive.TriggerPopoverCategoryItem>
          )
        })}
        {categories.length === 0 && (
          <div className="text-ink-muted px-2 py-1.5 text-sm">{emptyLabel}</div>
        )}
      </div>
    )}
  </ComposerPrimitive.TriggerPopoverCategories>
)

/** Keeps the highlighted row visible as the arrow keys move it through a list longer than the popover. */
function useHighlightInView(list: RefObject<HTMLDivElement | null>) {
  const { highlightedIndex } = unstable_useTriggerPopoverScopeContext()
  useEffect(() => {
    list.current
      ?.querySelector('[data-highlighted]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [list, highlightedIndex])
}

/** The rows the list shows at once; the rest scroll. */
const VISIBLE_ROWS = 4

/**
 * Holds the list to its first VISIBLE_ROWS rows, however tall each is: the
 * list ends where the next row starts. Rows differ in height, since a name
 * and a description wrap, so the height is measured, not a constant, and
 * measured again whenever the list's width changes where they wrap.
 */
function useVisibleRows(
  list: RefObject<HTMLDivElement | null>,
  items: readonly TriggerItem[],
) {
  const [maxHeight, setMaxHeight] = useState<number>()
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const next = element.querySelectorAll<HTMLElement>(
        '[data-slot="composer-trigger-popover-item"]',
      )[VISIBLE_ROWS]
      setMaxHeight(next?.offsetTop || undefined)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [list, items])
  return maxHeight
}

/** The least height worth keeping the popover above for: three of its rows. */
const MIN_HEIGHT = 160

/**
 * Places the popover over the element that holds it, no taller or wider than
 * the space its scroll container leaves, and below only when less than
 * MIN_HEIGHT is left above (Floating UI's size-before-flip arrangement).
 */
function usePlacement() {
  const { refs, floatingStyles } = useFloating({
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(MIN_HEIGHT, availableHeight)}px`,
            maxWidth: `${rects.reference.width}px`,
          })
        },
      }),
      flip({ padding: 8, fallbackStrategy: 'initialPlacement' }),
    ],
  })
  const ref = useCallback(
    (popover: HTMLDivElement | null) => {
      refs.setReference(popover?.parentElement ?? null)
      refs.setFloating(popover)
    },
    [refs],
  )
  return { ref, style: floatingStyles }
}

type ItemsProps = {
  iconMap: Record<string, IconComponent> | undefined
  fallbackIcon: IconComponent | undefined
  itemTag: ((item: TriggerItem) => ReactNode) | undefined
  note: ReactNode
  backLabel: string
  emptyLabel: string
  loadingLabel: string
  isLoading: boolean
}

const Items: FC<ItemsProps> = ({ note, backLabel, ...rows }) => (
  <ComposerPrimitive.TriggerPopoverItems className="flex min-h-0 flex-col">
    {(items) => (
      <div
        data-slot="composer-trigger-popover-items"
        className="flex min-h-0 flex-col"
      >
        <ComposerPrimitive.TriggerPopoverBack className="text-ink-muted hover:bg-hover border-separator flex items-center gap-1.5 border-b px-3 py-2 text-xs transition-colors">
          <ChevronLeftIcon className="size-3.5" />
          {backLabel}
        </ComposerPrimitive.TriggerPopoverBack>
        <Rows items={items} {...rows} />
        {note !== undefined && (
          <div className="text-ink-muted border-separator mx-2 mb-1 border-t py-1 pr-2 pl-[30px] text-xs leading-4 empty:hidden">
            {note}
          </div>
        )}
      </div>
    )}
  </ComposerPrimitive.TriggerPopoverItems>
)

type RowsProps = Omit<ItemsProps, 'note' | 'backLabel'> & {
  items: readonly TriggerItem[]
}

const Rows: FC<RowsProps> = ({
  items,
  iconMap,
  fallbackIcon,
  itemTag,
  emptyLabel,
  loadingLabel,
  isLoading,
}) => {
  const list = useRef<HTMLDivElement>(null)
  useHighlightInView(list)
  const maxHeight = useVisibleRows(list, items)
  return (
    <div
      ref={list}
      style={{ maxHeight }}
      className="relative [scrollbar-width:none] overflow-y-auto overscroll-contain p-1 [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item, index) => {
        const iconKey =
          typeof item.metadata?.icon === 'string' ? item.metadata.icon : undefined
        const Icon = resolveIcon(iconKey, iconMap, fallbackIcon)
        const tag = itemTag?.(item)
        // A hairline where one kind of item gives way to the next, so
        // the order says what the list holds without a heading.
        const kindChanges = index > 0 && items[index - 1]!.type !== item.type
        return (
          <Fragment key={item.id}>
            {kindChanges && <div aria-hidden className={HAIRLINE} />}
            <ComposerPrimitive.TriggerPopoverItem
              item={item}
              index={index}
              data-slot="composer-trigger-popover-item"
              className={cn(ROW, COLUMNS)}
            >
              {/* The column stays when there is no icon, so every name starts in one place,
                  and the icon sits at the middle of the row's name and description.
                  The painted icons keep the 14px they shipped at. */}
              <span
                className={cn(
                  'flex min-h-5 items-center',
                  item.description && 'row-span-2',
                )}
              >
                {Icon && <Icon className="text-ink-muted size-3.5" />}
              </span>
              <span className="flex min-w-0 items-baseline gap-2">
                {/* 14/20 with Carbon's +0.16px for Plex at 14px: the name a step above the app's 13px chrome, as the picked study drew it. */}
                <span className="min-w-0 flex-1 text-[14px]/5 font-semibold tracking-[0.16px] break-words">
                  {item.label}
                </span>
                {tag && (
                  <span className="text-ink-muted shrink-0 text-xs">{tag}</span>
                )}
              </span>
              {item.description && (
                <span className="text-ink-muted col-start-2 line-clamp-2 text-xs leading-4">
                  {item.description}
                </span>
              )}
            </ComposerPrimitive.TriggerPopoverItem>
          </Fragment>
        )
      })}
      {items.length === 0 && (
        <div className="text-ink-muted px-2 py-1 text-sm">
          {isLoading ? loadingLabel : emptyLabel}
        </div>
      )}
    </div>
  )
}

/**
 * Pre-built popover UI for a trigger-driven picker (mentions, slash commands, etc).
 * Pass exactly one of `directive` (inserts a chip) or `action` (fires a handler).
 */
const ComposerTriggerPopoverImpl: FC<ComposerTriggerPopoverProps> = ({
  iconMap,
  fallbackIcon,
  note,
  itemTag,
  backLabel = 'Back',
  emptyCategoriesLabel = 'No items available',
  emptyItemsLabel = 'No matching items',
  loadingLabel = 'Loading…',
  isLoading = false,
  className,
  directive,
  action,
  surfaceRef,
  ...props
}) => {
  const placement = usePlacement()
  const ref = useComposedRefs(placement.ref, surfaceRef)
  const warnedRef = useRef(false)
  if (
    import.meta.env.DEV &&
    !warnedRef.current &&
    Boolean(directive) === Boolean(action)
  ) {
    warnedRef.current = true
    console.warn(
      '[assistant-ui] ComposerTriggerPopover requires exactly one of `directive` or `action` props.',
    )
  }

  return (
    <ComposerPrimitive.TriggerPopover
      data-slot="composer-trigger-popover"
      ref={ref}
      style={placement.style}
      className={cn(
        // A fixed width: a long name or description wraps rather than
        // widening the list.
        'aui-composer-trigger-popover bg-popover text-popover-foreground z-50 flex w-78 flex-col overflow-hidden rounded-lg border shadow-lg/5',
        className,
      )}
      isLoading={isLoading}
      {...props}
    >
      {directive ? (
        <ComposerPrimitive.TriggerPopover.Directive
          formatter={directive.formatter ?? defaultDirectiveFormatter}
          onInserted={directive.onInserted}
        />
      ) : action ? (
        <ComposerPrimitive.TriggerPopover.Action
          formatter={action.formatter ?? defaultDirectiveFormatter}
          onExecute={action.onExecute}
          removeOnExecute={action.removeOnExecute}
        />
      ) : null}
      <Categories
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        emptyLabel={emptyCategoriesLabel}
      />
      <Items
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        itemTag={itemTag}
        note={note}
        backLabel={backLabel}
        emptyLabel={emptyItemsLabel}
        loadingLabel={loadingLabel}
        isLoading={isLoading}
      />
    </ComposerPrimitive.TriggerPopover>
  )
}
ComposerTriggerPopoverImpl.displayName = 'ComposerTriggerPopover'

export const ComposerTriggerPopover = memo(
  ComposerTriggerPopoverImpl,
) as FC<ComposerTriggerPopoverProps>
