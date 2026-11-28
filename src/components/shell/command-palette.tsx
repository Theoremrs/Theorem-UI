// SOURCING: lib/commands (the shared command registry and its one key listener, so a row here, a chord and an agent run the same command), assistant-ui's command-palette element (assistant-ui/elements/command-palette) in coss ui's command dialog backdrop and viewport over a Base UI Dialog, Base UI's glass for menus (glass/menu-glass), @tanstack/react-router (navigation), lib/theorem/models (catalog and pick), lib/theorem/catalog (plugins and skills), lib/theorem/organization (threads across every project)
import { Dialog } from '@base-ui/react/dialog'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
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
import { useCommandKeybindings } from '@/lib/commands/keybindings'
import {
  applies,
  executeCommand,
  registerCommands,
  useCommandRegistry,
} from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/registry'
import { useCatalogEntries } from '@/lib/theorem/catalog'
import {
  modelCatalogIssue,
  useModelCatalog,
  usePickedModels,
} from '@/lib/theorem/models'
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

/** Commands the palette runs itself rather than listing under Commands. */
const SHELL_COMMANDS = new Set([
  'theorem.palette.toggle',
  'theorem.chat.new',
  'theorem.settings.open',
])

/**
 * The shell's own commands, registered while the palette is mounted, and the
 * one key listener that runs any registered command's chord. ⌘K or Ctrl+K
 * anywhere still opens the palette, now as `theorem.palette.toggle`.
 */
function useShellCommands() {
  const navigate = useNavigate()
  const router = useRouter()
  useEffect(
    () =>
      registerCommands([
        {
          id: 'theorem.palette.toggle',
          label: 'Command palette',
          group: 'Go to',
          effect: 'presentation',
          target: 'host',
          keys: ['mod+k', 'ctrl+k'],
          palette: false,
          run: () => {
            const { open, setOpen } = useCommandPalette.getState()
            setOpen(!open)
          },
        },
        {
          id: 'theorem.chat.new',
          label: 'New chat',
          group: 'Go to',
          effect: 'navigate',
          target: 'host',
          run: () => navigate({ to: '/' }),
        },
        {
          id: 'theorem.recovery.open',
          label: 'Open recovery',
          group: 'Go to',
          description:
            'Safe mode, restore the shipped shell, reset layout or handlers, and the failure record.',
          keywords: ['safe mode', 'reset', 'repair', 'broken', 'restore'],
          effect: 'navigate',
          target: 'host',
          keys: ['mod+alt+shift+r'],
          run: () => navigate({ to: '/recovery' }),
        },
        {
          id: 'theorem.settings.open',
          label: 'Open settings',
          group: 'Go to',
          effect: 'navigate',
          target: 'host',
          args: z.object({ path: z.string().startsWith('/settings') }),
          palette: false,
          run: ({ path }) => navigate({ to: path }),
        },
      ]),
    [navigate],
  )
  const path = useCallback(() => router.state.location.pathname, [router])
  useCommandKeybindings(path)
  return path
}

function useGroups(close: () => void, currentPath: () => string): Group[] {
  const navigate = useNavigate()
  const registered = useCommandRegistry((s) => s.commands)
  const { data: catalog = [], list } = useModelCatalog()
  const defaultName = catalog.find((m) => m.ref === list?.defaultRef)?.name
  const { starred, selected, select } = usePickedModels()
  const { plugins, skills } = useCatalogEntries()
  const { data: organization } = useOrganization()

  return useMemo(() => {
    const context: CommandContext = { focus: 'dialog', path: currentPath() }
    const run = (id: string, args?: unknown) => () => {
      close()
      void executeCommand(id, args, context, 'palette')
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
          {
            id: 'new-chat',
            label: 'New chat',
            Mark: Icon.NewChat,
            run: run('theorem.chat.new'),
          },
          ...SETTINGS_GROUPS.flatMap(({ sections }) =>
            sections.map(({ path, label, Mark }) => ({
              id: path,
              label: `Settings: ${label}`,
              Mark,
              run: run('theorem.settings.open', { path }),
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
          run: run('theorem.settings.open', { path: '/settings/plugins' }),
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
          run: run('theorem.settings.open', { path: '/settings/plugins' }),
        })),
      },
      {
        // Every other registered command a row can run as it is: a module's,
        // an extension's, or one of the host's own.
        label: 'Commands',
        items: [...registered.values()]
          .filter(
            (command) =>
              !SHELL_COMMANDS.has(command.id) &&
              command.palette !== false &&
              !command.args &&
              applies(command, context),
          )
          .map((command) => ({
            id: `command:${command.id}`,
            label: command.label,
            hint: command.keys?.[0],
            keywords: [
              command.group,
              command.description,
              ...(command.keywords ?? []),
            ]
              .filter(Boolean)
              .join(' '),
            Mark: Icon.Plugin,
            run: run(command.id),
          })),
      },
    ]
    return groups.filter((group) => group.items.length)
  }, [
    catalog,
    defaultName,
    starred,
    selected,
    select,
    plugins,
    skills,
    organization,
    registered,
    navigate,
    close,
    currentPath,
  ])
}

/** The ⌘K palette: places, models, plugins and skills, filtered as the person types. */
export function CommandPalette() {
  const path = useShellCommands()
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
            {open && <Palette close={() => setOpen(false)} path={path} />}
          </Dialog.Popup>
        </CommandDialogViewport>
      </CommandDialogPortal>
    </CommandDialog>
  )
}

/** The palette's contents, mounted while it is open so each opening starts empty. */
function Palette({ close, path }: { close: () => void; path: () => string }) {
  const { list, error } = useModelCatalog()
  const issue = modelCatalogIssue(list, error)
  const groups = useGroups(close, path)
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
        className={cn(
          'max-w-none',
          glass.className && 'bg-transparent dark:bg-transparent',
        )}
      />
      {issue && (
        <p role="alert" className="px-3.5 pb-3 text-xs text-ink-muted">
          {issue}
        </p>
      )}
    </div>
  )
}
