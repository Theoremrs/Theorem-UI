// SOURCING: Base UI Menu's popup, glass/menu-glass (the pane of the navigation panel's liquid glass the composer's and sidebar's menus already wear)
import { Menu } from '@base-ui/react/menu'
import type { ComponentProps } from 'react'
import { useMenuGlass } from '@/components/glass/menu-glass'
import { cn } from '@/lib/utils'

export const menuItem =
  'appearance-menu-item flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-highlighted:bg-hover'

export const menuPopup =
  'origin-(--transform-origin) rounded-lg border border-separator bg-popover p-1 text-popover-foreground shadow-popover outline-none transition-[opacity,scale] duration-(--duration-snap) ease-snap data-ending-style:duration-(--duration-exit) data-ending-style:ease-exit data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0'

/**
 * The chrome's menus wear the theme's glass, as the composer's and the
 * sidebar's do, instead of the flat popover fill: under a glass preset that
 * fill is a darker, greyer step than every other menu in the app. Without
 * glass (Calm, a custom palette) they keep the palette's popover. Pass `attach`
 * as the ref of the element that paints the popup's box and add `className` to it.
 */
export function useChromeMenuGlass() {
  const { attach, className } = useMenuGlass('navigation')
  return { attach, className: cn(menuPopup, className) }
}

/** A Base UI menu popup in the chrome's menu style, on the theme's glass. */
export function ChromeMenuPopup({
  className,
  ...props
}: Omit<ComponentProps<typeof Menu.Popup>, 'className' | 'ref'> & {
  className?: string
}) {
  const { attach: attachGlass, className: glassClass } = useChromeMenuGlass()
  return (
    <Menu.Popup
      data-appearance-part="popover"
      {...props}
      ref={attachGlass}
      className={cn(glassClass, className)}
    />
  )
}
