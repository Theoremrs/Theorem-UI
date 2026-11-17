// SOURCING: glass/liquid-glass (useLiquidGlass, the renderer the composer and the navigation panel run), the surface materials from lib/appearance, and a React context so the menus a surface opens follow it through their portals; a callback ref because Base UI and Floating UI mount a popup only while it is open, after the menu's own component has mounted.
import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useLiquidGlass } from '@/components/glass/liquid-glass/use-liquid-glass'
import { useSurfaceMaterial } from '@/lib/appearance'

/** The surfaces whose menus wear their glass. */
export type MenuGlassSurface = 'composer' | 'navigation'

const MenuGlassContext = createContext<MenuGlassSurface | undefined>(undefined)

/**
 * The menus opened from inside `children` (coss MenuPopup reads this) wear
 * `surface`'s glass while that surface is glass.
 */
export function MenuGlass({
  surface,
  children,
}: {
  surface: MenuGlassSurface
  children: ReactNode
}) {
  return <MenuGlassContext value={surface}>{children}</MenuGlassContext>
}

/**
 * A menu a surface opens wears that surface's glass: while the surface is
 * glass, the popup is a liquid pane in the shared glass tone, with what lies
 * behind showing through its thinned body as it does through the surface's
 * (styles.css glass-menu). Without `surface` it follows the nearest
 * MenuGlass, and stays as it is outside one. Pass `attach` as the ref of the
 * element that paints the popup's box and add `className` to it.
 */
export function useMenuGlass(surface?: MenuGlassSurface) {
  const nearest = useContext(MenuGlassContext)
  const owner = surface ?? nearest
  // Every role has a material; an unowned menu asks for one it then ignores.
  const material = useSurfaceMaterial(owner ?? 'popover')
  const liquid =
    owner !== undefined && (material === 'liquid' || material === 'glass')
  const [node, setNode] = useState<HTMLElement | null>(null)
  const ref = useMemo(() => ({ current: node }), [node])
  useLiquidGlass(ref, liquid)
  return {
    attach: setNode,
    className: liquid ? 'surface-liquid glass-menu' : undefined,
  }
}
