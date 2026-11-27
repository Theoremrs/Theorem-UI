// SOURCING: assistant-ui's command-palette element (assistant-ui/elements/command-palette) in coss ui's command dialog backdrop and viewport over a Base UI Dialog, Base UI's glass for menus (glass/menu-glass), @tanstack/react-router (navigation), lib/theorem/models (catalog and pick), lib/theorem/catalog (plugins and skills), lib/theorem/organization (threads across every project)
import { Dialog } from '@base-ui/react/dialog'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { ComponentType, SVGProps } from 'react'
import { create } from 'zustand'
import {
  CommandPalette as PaletteSurface,
  paletteMatches,
} from '@/components/assistant-ui/elements/command-palette'
import type { PaletteCommand } from '@/components/assistant-ui/elements/command-palette'
import {
  CommandDialog,
  CommandDialogBackdrop,
  CommandDialogPortal,
  CommandDialogViewport,
} from '@/components/coss/command'
import { useMenuGlass } from '@/components/glass/menu-glass'
import { Icon } from '@/components/icons'
import { SETTINGS_GROUPS } from '@/components/settings/sections'
import { useCatalogEntries } from '@/lib/theorem/catalog'
import { modelCatalogIssue, useModelCatalog, usePickedModels } from '@/lib/theorem/models'
import {
  attentionLabel,
  primaryProjectId,
  useOrganization,
} from '@/lib/theorem/organization'
import { cn } from '@/lib/utils'
import { useShell } from './shell-state'

type Entry = {
  id: string
  label: string
  /** Shown faint after the label: a model's vendor, a skill's plugin. */
  hint?: string
  /** Extra words the search matches but the row does not show. */
  keywords?: string
  Mark: ComponentType<SVGProps<SVGSVGElement>>
  /** A check after the label, for the picked model. */
  active?: boolean
  run: () => void
}

type Group = { label: string; items: Entry[] }

export const useCommandPalette = create<{
  open: boolean
  setOpen: (open: boolean) => void
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }))

/** ⌘K or Ctrl+K anywhere opens the palette. */
function useHotkey() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        const { open, setOpen } = useCommandPalette.getState()
        setOpen(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function useGroups(close: () => void): Group[] {
  const navigate = useNavigate()
  const { data: catalog = [], list } = useModelCatalog()
  const defaultName = catalog.find((m) => m.ref === list?.defaultRef)?.name
  const { starred, selected, select } = usePickedModels()
  const { plugins, skills } = useCatalogEntries()
  const { data: organization } = useOrganization()

  return useMemo(() => {
    const go = (to: string) => () => {
      close()
      void navigate({ to })
    }
    const pick = (ref: string | undefined) => () => {
      select(ref)
      close()
    }
    // Starred models first, then every other model Theorem serves.
    const starredSet = new Set(starred)
    const models = [
      ...starred.flatMap((ref) => catalog.filter((m) => m.ref === ref)),
      ...catalog.filter((m) => !starredSet.has(m.ref)),
    ]
    const projectTitle = new Map(
      organization?.projects.map((p) => [p.projectId, p.title]),
    )
    const threads = [...(organization?.threads ?? [])].sort(
      (a, b) =>
        (b.lastMessageAtMs ?? b.createdAtMs) -
        (a.lastMessageAtMs ?? a.createdAtMs),
    )
    const groups: Group[] = [
      {
        label: 'Threads',
        items: threads.map((thread) => {
          const home = primaryProjectId(thread)
          const [reason] = thread.attention.reasons
          return {
            id: `thread:${thread.threadId}`,
            label: thread.title || 'New chat',
            hint: projectTitle.get(home),
            keywords: [
              thread.summary?.text,
              thread.attention.running && 'running',
              reason && `attention ${attentionLabel(reason)}`,
              thread.later && 'later',
            ]
              .filter(Boolean)
              .join(' '),
            Mark: Icon.Conversation,
            run: () => {
              close()
              useShell.getState().setProjectId(home)
              void navigate({
                to: '/c/$threadId',
                params: { threadId: thread.threadId },
              })
            },
          }
        }),
      },
      {
        label: 'Go to',
        items: [
          { id: 'new-chat', label: 'New chat', Mark: Icon.NewChat, run: go('/') },
          ...SETTINGS_GROUPS.flatMap(({ sections }) =>
            sections.map(({ path, label, Mark }) => ({
              id: path,
              label: `Settings: ${label}`,
              Mark,
              run: go(path),
            })),
          ),
        ],
      },
      {
        label: 'Models',
        items: [
          {
            id: 'model:default',
            label: 'Default model',
            hint: defaultName,
            keywords: 'default model',
            Mark: Icon.Model,
            active: !selected,
            run: pick(undefined),
          },
          ...models.map((model) => ({
            id: `model:${model.ref}`,
            label: model.name,
            hint: model.vendor,
            keywords: model.ref,
            Mark: starredSet.has(model.ref) ? Icon.Star : Icon.Model,
            active: selected === model.ref,
            run: pick(model.ref),
          })),
        ],
      },
      {
        label: 'Plugins',
        items: plugins.map((plugin) => ({
          id: `plugin:${plugin.id}`,
          label: plugin.name,
          hint: plugin.description,
          Mark: Icon.Plugin,
          run: go('/settings/plugins'),
        })),
      },
      {
        label: 'Skills',
        items: skills.map((skill) => ({
          id: `skill:${skill.id}`,
          label: skill.name,
          hint: skill.plugin,
          keywords: skill.description,
          Mark: Icon.Article,
          run: go('/settings/plugins'),
        })),
      },
    ]
    return groups.filter((group) => group.items.length)
  }, [catalog, defaultName, starred, selected, select, plugins, skills, organization, navigate, close])
}

/** The ⌘K palette: places, models, plugins and skills, filtered as the person types. */
export function CommandPalette() {
  useHotkey()
  const open = useCommandPalette((s) => s.open)
  const setOpen = useCommandPalette((s) => s.setOpen)
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPortal>
        <CommandDialogBackdrop />
        <CommandDialogViewport>
          <Dialog.Popup
            aria-label="Command palette"
            className="w-full max-w-xl outline-none transition-[scale,opacity] duration-(--duration-snap) ease-snap data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0"
          >
            {open && <Palette close={() => setOpen(false)} />}
          </Dialog.Popup>
        </CommandDialogViewport>
      </CommandDialogPortal>
    </CommandDialog>
  )
}

/** The palette's contents, mounted while it is open so each opening starts empty. */
function Palette({ close }: { close: () => void }) {
  const { list, error } = useModelCatalog()
  const issue = modelCatalogIssue(list, error)
  const groups = useGroups(close)
  const glass = useMenuGlass('navigation')
  const { commands, runs } = useMemo(() => {
    const runs = new Map<string, () => void>()
    const commands: PaletteCommand[] = groups.flatMap((group) =>
      group.items.map((entry) => {
        runs.set(entry.id, entry.run)
        return {
          id: entry.id,
          label: entry.label,
          group: group.label,
          hint: entry.hint,
          keywords: entry.keywords,
          active: entry.active,
          icon: <entry.Mark className="size-4 shrink-0 text-ink-muted" />,
        }
      }),
    )
    return { commands, runs }
  }, [groups])
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState('')
  // The first command the query keeps is the one Enter runs until the arrows move.
  const shown = paletteMatches(commands, query)
  const active = shown.some((c) => c.id === activeId)
    ? activeId
    : (shown[0]?.id ?? '')

  return (
    <div ref={glass.attach} className={cn('rounded-[20px]', glass.className)}>
      <PaletteSurface
        commands={commands}
        query={query}
        activeId={active}
        onQueryChange={(next) => {
          setQuery(next)
          setActiveId('')
        }}
        onActiveChange={setActiveId}
        onRun={(id) => runs.get(id)?.()}
        placeholder="Search threads, models, plugins, skills and settings"
        className={cn('max-w-none', glass.className && 'bg-transparent dark:bg-transparent')}
      />
      {issue && (
        <p role="alert" className="px-3.5 pb-3 text-xs text-ink-muted">
          {issue}
        </p>
      )}
    </div>
  )
}
