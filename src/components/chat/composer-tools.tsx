// SOURCING: assistant-ui ComposerPrimitive.TriggerPopover through the vendored registry element ComposerTriggerPopover, with its TriggerAdapter and TriggerMatcher seams; unstable_useSlashCommandAdapter (experimental) for the action commands, merged into the same "/" list as the tools; the default directive formatter writes the pick into the message; the native tool catalog from lib/theorem/tools; zustand (the Web and per-conversation Plan and Code mode state the composer's + menu and the runtime share); the SDK's webResearch option requests research without narrowing the turn's tools; planning independently requests a durable plan through draft_plan
import {
  defaultDirectiveFormatter,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from '@assistant-ui/react'
import type {
  TriggerAdapter,
  TriggerItem,
  TriggerMatcher,
  Unstable_SlashCommand,
} from '@assistant-ui/react'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { create } from 'zustand'
import { ComposerTriggerPopover } from '@/components/assistant-ui/elements/composer-trigger-popover.aui'
import { useMenuGlass } from '@/components/glass/menu-glass'
import { OutputSettingsDialog } from '@/components/chat/response-control'
import { Icon } from '@/components/icons'
import { useShell } from '@/components/shell/shell-state'
import { searchTools, useToolCatalog } from '@/lib/theorem/tools'
import type { NativeTool, ToolCatalogState } from '@/lib/theorem/tools'

/** The composer's buttons are passed on the way to typing, so their tooltips wait for a resting pointer. */
export const COMPOSER_TOOLTIP_DELAY = 700

type WebSearchState = { on: boolean; toggle: () => void }

/**
 * Whether the next turn searches the web. It stays on across sends until the
 * person turns it off, as a mode of the conversation rather than of one
 * message.
 */
export const useWebSearch = create<WebSearchState>()((set) => ({
  on: false,
  toggle: () => set((state) => ({ on: !state.on })),
}))

/**
 * Request research at send time while retaining the turn's other admitted
 * tools. Explicit capability scopes remain an independent server restriction.
 */
export const webTurnOptions = (): { webResearch?: true } =>
  useWebSearch.getState().on ? { webResearch: true } : {}

type ThreadModeState = {
  /** The conversations with the mode on, by the composer's thread key. */
  byThread: Readonly<Record<string, true>>
  set: (thread: string, on: boolean) => void
  /** A new conversation's mode moves to its durable id once it has one. */
  adopt: (from: string, to: string) => void
}

const without = (map: Readonly<Record<string, true>>, key: string) => {
  const { [key]: _dropped, ...rest } = map
  return rest
}

/**
 * A mode of one conversation, keyed like its connection choice: the thread's
 * durable id, or its local id before the first send. Each conversation starts
 * with it off.
 */
const threadMode = () =>
  create<ThreadModeState>()((set) => ({
    byThread: {},
    set: (thread, on) =>
      set(({ byThread }) => ({
        byThread: on
          ? { ...byThread, [thread]: true }
          : without(byThread, thread),
      })),
    adopt: (from, to) =>
      set(({ byThread }) =>
        byThread[from]
          ? { byThread: { ...without(byThread, from), [to]: true } }
          : {},
      ),
  }))

/** Whether the mode is on for the conversation sending, read at send time. */
const modeOn = (
  store: ReturnType<typeof threadMode>,
  localId: string,
  remoteId: string | undefined,
) => {
  // A conversation that was new when the mode was turned on has its durable
  // id by the time it sends, so the mode moves there first.
  if (remoteId && remoteId !== localId) store.getState().adopt(localId, remoteId)
  return store.getState().byThread[remoteId ?? localId] === true
}

/**
 * Whether a conversation's next turn plans. It stays on until a plan is
 * drafted, so a turn where the model first asks a question is followed by
 * another planning turn, and then turns itself off: the conversation after a
 * plan is about it.
 */
export const usePlanning = threadMode()

/**
 * The turn option Plan adds for the conversation sending. Theorem gives a
 * planning turn its `draft_plan` operation and tells the model to write the
 * request as one durable plan.
 */
export function planningTurnOptions(
  localId: string,
  remoteId: string | undefined,
): { planning?: true } {
  return modeOn(usePlanning, localId, remoteId) ? { planning: true } : {}
}

/**
 * Whether a conversation is a coding task. Turning it on opens the terminal
 * beside the chat; it stays on across sends until the person turns it off.
 */
export const useCodeMode = threadMode()

/**
 * The turn option Code mode adds: the coding execution mode the agent
 * terminal runs every turn in, so Theorem treats the request as a coding task.
 */
export function codingTurnOptions(
  localId: string,
  remoteId: string | undefined,
): { executionMode?: 'coding' } {
  return modeOn(useCodeMode, localId, remoteId)
    ? { executionMode: 'coding' }
    : {}
}

/** A chip beside the + button that says a mode is on; pressing it turns the mode off or opens it. */
export const COMPOSER_CHIP =
  'flex h-7 items-center gap-1 rounded-full bg-redwood/12 ps-2 pe-1.5 text-xs font-medium text-redwood transition-colors duration-100 outline-none hover:bg-redwood/20 focus-visible:outline-2 focus-visible:outline-focus'

const toItem = (tool: NativeTool): TriggerItem => ({
  id: tool.name,
  type: 'tool',
  label: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  metadata: { effect: tool.effect },
})

const TAGS: Readonly<Record<string, string>> = {
  write: 'writes',
  destructive: 'destructive',
}

const tagOf = (item: TriggerItem) =>
  typeof item.metadata?.effect === 'string'
    ? TAGS[item.metadata.effect]
    : undefined

/** Why the list holds no tools, when Theorem could not list them. */
const CATALOG_NOTE: Partial<Record<ToolCatalogState['status'], string>> = {
  'not-served': 'This Theorem does not list its tools yet.',
  failed: 'Tools could not be loaded.',
}

const NO_TOOLS = 'No matching tools'

const NO_COMMANDS = 'No matching commands'

/** Local commands open settings; native tool picks retain their directive in the message. */
const OUTPUT_COMMANDS: TriggerItem[] = [
  {
    id: 'output-style', type: 'command', label: 'output-style',
    description: 'Choose how Theorem writes its replies.',
  },
  {
    id: 'output-settings', type: 'command', label: 'output-settings',
    description: 'Response detail and optional limits for this conversation.',
  },
]
const outputCommands = (query: string) =>
  OUTPUT_COMMANDS.filter((item) => item.id.startsWith(query.toLowerCase()))

/** The conversation's key: its durable id, or its local id before the first send. */
const useThreadKey = () =>
  useAuiState(
    (state) => state.threadListItem.remoteId ?? state.threadListItem.id,
  )

const COMMAND_ICONS = {
  NewChat: Icon.NewChat,
  WebSearch: Icon.WebSearch,
  Plan: Icon.Plan,
  // The painted Streamline coded page, as the + menu draws Code mode.
  Code: Icon.CodeMode,
  ReadAloud: Icon.ReadAloudControl,
  Plugins: Icon.Plugins,
} as const

/**
 * The "/" list's action commands, beside the tools and the output dialogs.
 * Each does what the + menu or the header does, from the keyboard; the
 * trigger text is stripped, so a command leaves no chip in the message.
 */
function useActionCommands(): readonly Unstable_SlashCommand[] {
  const aui = useAui()
  const navigate = useNavigate()
  const threadKey = useThreadKey()
  return useMemo(
    () => [
      {
        id: 'new',
        label: 'new',
        description: 'Start a new chat.',
        icon: 'NewChat',
        execute: () => void aui.threads.switchToNewThread(),
      },
      {
        id: 'web',
        label: 'web',
        description: 'Toggle web search for this conversation.',
        icon: 'WebSearch',
        execute: () => useWebSearch.getState().toggle(),
      },
      {
        id: 'plan',
        label: 'plan',
        description: 'Toggle Plan mode for this conversation.',
        icon: 'Plan',
        execute: () => {
          const planning = usePlanning.getState()
          planning.set(threadKey, planning.byThread[threadKey] !== true)
        },
      },
      {
        id: 'code',
        label: 'code',
        description: 'Toggle Code mode and the workbench.',
        icon: 'Code',
        execute: () => {
          const modes = useCodeMode.getState()
          const on = modes.byThread[threadKey] !== true
          modes.set(threadKey, on)
          const shell = useShell.getState()
          if (on && (shell.workbench === undefined || shell.workbench === 'closed'))
            shell.setWorkbench(shell.lastCompanion)
        },
      },
      {
        id: 'read-aloud',
        label: 'read-aloud',
        description: 'Read the latest reply aloud, or stop reading.',
        icon: 'ReadAloud',
        execute: () => {
          const { messages } = aui.thread.getState()
          const last = messages.at(-1)
          if (last?.role !== 'assistant') return
          const message = aui.thread.message({ id: last.id })
          if (message.getState().speech) message.stopSpeaking()
          else message.speak()
        },
      },
      {
        id: 'connections',
        label: 'connections',
        description: 'Open the connections settings.',
        icon: 'Plugins',
        execute: () => void navigate({ to: '/settings/connections' }),
      },
    ],
    [aui, navigate, threadKey],
  )
}

/** A slash that starts the text or follows a space, up to the caret. */
const SLASH = /(?:^|\s)\/(\S*)$/u

/**
 * Opens on a slash the way the default detection does, and closes again once
 * the typed name matches no tool, so a path such as /usr/bin stays text and
 * Enter sends it.
 */
function slashMatcher(
  status: ToolCatalogState['status'],
  tools: readonly NativeTool[],
  commands: readonly TriggerItem[],
): TriggerMatcher {
  return (text, _char, cursor) => {
    const query = SLASH.exec(text.slice(0, cursor))?.[1]
    if (query === undefined) return null
    if (query && status !== 'loading' &&
      !outputCommands(query).length && !searchTools(tools, query).length &&
      !commands.some((item) => item.id.startsWith(query.toLowerCase())))
      return null
    return { query, offset: cursor - query.length - 1, endOffset: cursor }
  }
}

/**
 * The "/" list in a composer: Theorem's native tools, filtered as the person
 * types, plus local output commands. A tool pick writes `:tool[name]` into
 * the message, so the turn and the
 * transcript both say which tool was asked for. It names intent and leaves
 * the turn's capability scope alone, which would otherwise shut out the other
 * tools the turn may need.
 */
export function ComposerToolTrigger() {
  const { status, tools } = useToolCatalog()
  const [outputDialog, setOutputDialog] = useState<string>()
  const glass = useMenuGlass('composer')
  const commands = useActionCommands()
  const slash = unstable_useSlashCommandAdapter({
    commands,
    removeOnExecute: true,
    iconMap: COMMAND_ICONS,
  })
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query) => [
        ...(slash.adapter.search?.(query) ?? []),
        ...searchTools(tools, query).map(toItem),
        ...outputCommands(query),
      ],
    }),
    [tools, slash.adapter],
  )
  const commandItems = useMemo(
    () => slash.adapter.search?.('') ?? [],
    [slash.adapter],
  )
  const matcher = useMemo(
    () => slashMatcher(status, tools, commandItems),
    [status, tools, commandItems],
  )
  return (
    <>
      <ComposerTriggerPopover
        char="/"
        adapter={adapter}
        matcher={matcher}
        isLoading={status === 'loading'}
        iconMap={COMMAND_ICONS}
        directive={{
          formatter: {
            ...defaultDirectiveFormatter,
            // A command writes nothing: the typed "/name" is replaced by the
            // empty string, so the command leaves no chip in the message.
            serialize: (item) => item.type === 'command'
              ? '' : defaultDirectiveFormatter.serialize(item),
          },
          onInserted: (item) => {
            if (item.type !== 'command') return
            const command = commands.find((entry) => entry.id === item.id)
            if (command) command.execute()
            else setOutputDialog(item.id)
          },
        }}
        // When Theorem cannot list its tools the note says why, so the
        // list's own line answers only for the commands. While they load
        // the commands show alone.
        note={CATALOG_NOTE[status]}
        itemTag={tagOf}
        emptyItemsLabel={status === 'ready' ? NO_TOOLS : NO_COMMANDS}
        loadingLabel={NO_COMMANDS}
        surfaceRef={glass.attach}
        className={glass.className}
      />
      {outputDialog && (
        <OutputSettingsDialog
          open
          onOpenChange={(open) => { if (!open) setOutputDialog(undefined) }}
          stylesOnly={outputDialog === 'output-style'}
        />
      )}
    </>
  )
}
