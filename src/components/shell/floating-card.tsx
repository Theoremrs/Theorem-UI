// SOURCING: the navigation card moved out of chat-shell so the settings nav wears the same one: glass/liquid-glass (useLiquidGlass, curved on the three edges off the rail from the card's own radius), the appearance policy's material and surface pair, and the panel-lift shadow in styles.css; glass/menu-glass so the menus it opens wear its glass; the shape is the docked column the owner picked on 2026-11-16 (docs/plans/evidence/studies/c-docked-glass-study.png). No library models a card that switches between these materials, so this is the app's own.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useLiquidGlass } from '@/components/glass/liquid-glass/use-liquid-glass'
import { MenuGlass } from '@/components/glass/menu-glass'
import type { LiquidEdges } from '@/components/glass/liquid-glass/use-liquid-glass'
import { useSurfaceMaterial } from '@/lib/appearance'
import { appearancePair } from '@/lib/appearance-policy'
import { cn } from '@/lib/utils'

/** The card's gap from the conversation and its radius, set on whatever holds it. */
export const FLOATING_CARD_VARS = '[--panel-float:8px] [--panel-radius:15px]'

/** The card meets the rail, so its rail side runs on and does not curve. */
const EDGES: LiquidEdges = { top: true, right: true, bottom: true, left: false }

/**
 * Navigation as a docked column: it fills the sheet's start column top to
 * bottom, its start corners are the sheet's own, and only the side facing the
 * conversation floats, with a gap, rounded corners and a shadow. As frosted
 * glass whatever runs under the page shows through it, blurred; under liquid
 * glass it is a liquid pane.
 */
export function FloatingCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const material = useSurfaceMaterial('navigation')
  // Both glass choices run the liquid renderer, as the composer's do.
  const liquid = material === 'liquid' || material === 'glass'
  useLiquidGlass(ref, liquid, EDGES)
  return (
    <div data-panel-float="" className="h-full pe-(--panel-float)">
      <div className="panel-lift h-full rounded-e-(--panel-radius)">
        <div
          ref={ref}
          data-appearance-part="navigation"
          data-appearance-width-role="navigation"
          data-surface-role="navigation"
          data-material={material}
          {...appearancePair('primary', 'navigation')}
          className={cn(
            'appearance-surface h-full overflow-hidden rounded-e-(--panel-radius)',
            // The composer's glass (styles.css), so the two read as one material.
            liquid && 'surface-liquid',
          )}
        >
          {/* Its menus are panes of its glass (glass/menu-glass). */}
          <MenuGlass surface="navigation">
            <div className="appearance-reading-plane h-full">{children}</div>
          </MenuGlass>
        </div>
      </div>
    </div>
  )
}
