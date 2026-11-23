// SOURCING: React context (the page runtime's own pattern for what a page hands its modules) and
// lib/modules/layout's mapLayout, which already walks a layout's slots and zones. A module that is
// used, not arranged, can change one of its own settings in the page's draft: the same draft Puck's
// onChange writes while arranging, saved by the page's existing Save. Nothing here saves on its own.
import { createContext, useContext, useMemo } from 'react'
import type { LayoutData } from '@/lib/modules/contract'
import { mapLayout } from '@/lib/modules/layout'
import type { ModuleViewProps } from '@/lib/modules/registry'

/** Lay these props over the props of the page instance with this id. */
export type WriteInstanceProps = (
  id: string,
  props: Record<string, unknown>,
) => void

const PageSettingsContext = createContext<WriteInstanceProps | undefined>(
  undefined,
)

export const PageSettingsProvider = PageSettingsContext.Provider

/** The layout with one instance's props changed, wherever it sits, and nothing else. */
export function withInstanceProps(
  layout: LayoutData,
  id: string,
  props: Record<string, unknown>,
): LayoutData {
  return mapLayout(layout, (component) =>
    component.props.id === id
      ? { ...component, props: { ...component.props, ...props } }
      : component,
  )
}

/**
 * A writer for this instance's own settings, or undefined where none applies:
 * outside a page that takes changes, while the page is being arranged (Puck
 * holds the working copy then), and inside a composite, whose instances are
 * the composite's definition rather than this page's.
 */
export function useOwnSettings(
  view: Pick<ModuleViewProps, 'instanceId' | 'path' | 'arranging'>,
): ((props: Record<string, unknown>) => void) | undefined {
  const write = useContext(PageSettingsContext)
  const own = !!write && !view.arranging && view.path === view.instanceId
  return useMemo(
    () =>
      own && write
        ? (props: Record<string, unknown>) => write(view.instanceId, props)
        : undefined,
    [own, write, view.instanceId],
  )
}
