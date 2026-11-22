// SOURCING: @tanstack/react-router Link (each section is a route), ui/icon-tile for row marks; the layout follows Twenty's settings (nav replaces the app panel, breadcrumb over a raised sheet, sections of bordered rows)
import { Link, useMatches } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { useIsomorphicLayoutEffect } from '@/components/assistant-ui/utils/useIsomorphicLayoutEffect'
import { Icon } from '@/components/icons'
import { PANEL_WIDTH } from '@/components/shell/shell-state'
import { IconTile } from '@/components/ui/icon-tile'
import { cn } from '@/lib/utils'
import { SETTINGS_GROUPS, settingsSection } from './sections'

const navItem =
  'flex items-center rounded-md text-sm text-ink-muted transition-colors duration-100 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus data-[status=active]:bg-selected data-[status=active]:text-ink'

/** The settings nav: a way back to the conversation, then the sections by group. */
function SettingsNav() {
  return (
    <nav
      aria-label="Settings"
      data-appearance-part="settings-nav"
      style={{ width: PANEL_WIDTH.default }}
      className="flex shrink-0 flex-col overflow-y-auto"
    >
      <Link to="/" data-appearance-part="navigation-row" className={navItem}>
        <Icon.X className="size-4" />
        Exit settings
      </Link>
      {SETTINGS_GROUPS.map(({ label, sections }) => (
        <div key={label} className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-xs text-ink-faint">{label}</p>
          {sections.map(({ path, label: name, Mark }) => (
            <Link
              key={path}
              to={path}
              data-appearance-part="navigation-row"
              className={navItem}
            >
              <Mark className="size-4" />
              {name}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}

/** Which section the router is on, for the breadcrumb. */
function useCurrentSection() {
  return useMatches({
    select: (matches) => settingsSection(matches.at(-1)?.fullPath ?? ''),
  })
}

/** Settings' own shell: the nav where the app's panel was, and the open section on a raised sheet. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const current = useCurrentSection()
  return (
    <div className="flex h-dvh flex-col bg-rail text-ink md:flex-row">
      <div className="hidden md:contents">
        <SettingsNav />
      </div>
      <details className="max-h-[40dvh] shrink-0 overflow-auto border-b border-separator px-3 py-2 md:hidden">
        <summary className="cursor-pointer">Settings sections</summary>
        <SettingsNav />
      </details>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col pe-1.5 pb-1.5">
        <header className="flex h-11 shrink-0 items-center gap-1.5 px-2 text-sm">
          {current && (
            <>
              <span className="text-ink-faint">{current.group}</span>
              <span className="text-ink-faint">/</span>
              {current.within ? (
                <Link
                  to={current.path}
                  // The page open is one under this section, not the section.
                  activeOptions={{ exact: true }}
                  className="rounded-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {current.label}
                </Link>
              ) : (
                <span>{current.label}</span>
              )}
            </>
          )}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-sheet shadow-sheet">
          <div
            data-appearance-spacing-role="settings-page"
            className="mx-auto flex w-full flex-col"
            style={{ maxWidth: current?.width ?? 680 }}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

export function SettingsPage({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  /** Set level with the title, as a section's action is with its own. */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 data-appearance-recipe="heading.medium">{title}</h1>
          {description && (
            <p data-appearance-recipe="ui.label" className="text-ink-muted">
              {description}
            </p>
          )}
        </div>
        {action && (
          <div className="flex shrink-0 items-center gap-3">{action}</div>
        )}
      </div>
      {children}
    </>
  )
}

/** A titled block of a settings page. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const [tabled, setTabled] = useState(false)
  // A section that holds a table is data management: it takes the compact
  // steps, while a page of fields keeps its comfortable spacing. The table
  // can arrive with its data, so the section watches for one.
  useIsomorphicLayoutEffect(() => {
    const section = ref.current
    if (!section) return
    const read = () => setTabled(section.querySelector('table') !== null)
    read()
    const observer = new MutationObserver(read)
    observer.observe(section, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return (
    <section
      ref={ref}
      data-appearance-spacing-role="settings-section"
      data-density={tabled ? 'compact' : undefined}
      className="flex flex-col"
    >
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 data-appearance-recipe="ui.section">{title}</h2>
          {description && (
            <p data-appearance-recipe="ui.label" className="text-ink-muted">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** The bordered box a section's rows sit in. */
export function SettingsBox({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'divide-y divide-separator overflow-hidden rounded-lg border border-separator',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** One setting: its mark, what it is, and its control on the right. */
export function SettingsRow({
  Mark,
  title,
  description,
  children,
}: {
  Mark?: ComponentType<SVGProps<SVGSVGElement>>
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      data-appearance-part="settings-row"
      className="flex flex-wrap items-center"
    >
      {Mark && (
        <IconTile size="lg" data-appearance-part="settings-mark">
          <Mark className="size-4 text-ink-muted" />
        </IconTile>
      )}
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        <span data-appearance-recipe="ui.label" className="wrap-break-word">
          {title}
        </span>
        {description && (
          <span data-appearance-recipe="metadata" className="text-ink-muted">
            {description}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
