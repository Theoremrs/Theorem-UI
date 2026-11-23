// SOURCING: coss ui Menu over Base UI Menu (the WAI-ARIA menu-button pattern: arrow keys, typeahead, Escape back to the button; MenuCheckboxItem for the modes, so opening the menu changes nothing until an item is chosen; MenuSub, MenuSubTrigger and MenuSubPopup over Base UI's SubmenuRoot for Connectors and Skills, which open on hover or the right arrow; Manage tools is a link to the connections settings); Skills lists Plan and then the skills Theorem serves (lib/theorem/catalog, Theorem's native skill registry), and a pick writes assistant-ui's defaultDirectiveFormatter `:skill[title]{name=id}` into the draft through the editor's insertInComposer, as a / tool pick writes `:tool[name]`, so the runtime sends its id in the turn's structured skill selection and Theorem loads it before execution; the Web, Plan and Code mode state from ./composer-tools and the connections roster from ./composer-connections, which opens anchored to this button; Connectors lists the roster's MCP servers as switches over lib/theorem/tool-selection; Code mode opens the workbench docked beside or under the conversation through the shell store (components/workbench); MenuCheckboxItem's switch variant keeps every row on one start edge; Base UI Toggle for the marks that say a mode is on
import { defaultDirectiveFormatter, useAuiState } from '@assistant-ui/react'
import { Toggle } from '@base-ui/react/toggle'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ComposerConnections,
  connectionsServed,
  useProjectConnections,
} from '@/components/chat/composer-connections'
import { insertInComposer } from '@/components/chat/composer-editor'
import {
  useCodeMode,
  usePlanning,
  useWebSearch,
} from '@/components/chat/composer-tools'
import { Link } from '@tanstack/react-router'
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@/components/coss/menu'
import { MenuGlass } from '@/components/glass/menu-glass'
import { Icon } from '@/components/icons'
import { useShell } from '@/components/shell/shell-state'
import { skillOrigin, useCatalogEntries } from '@/lib/theorem/catalog'
import type { SkillEntry } from '@/lib/theorem/catalog'
import { useConnectionTools } from '@/lib/theorem/connections'
import { useSkillInstallations } from '@/lib/theorem/skill-installations'
import {
  changeSelection,
  connectionsOn,
  reconcile,
  useToolSelections,
} from '@/lib/theorem/tool-selection'

/** The conversation's key: its durable id, or its local id before the first send. */
const useThreadKey = () =>
  useAuiState(
    (state) => state.threadListItem.remoteId ?? state.threadListItem.id,
  )

/**
 * The composer's + button, in the owner's order: Web search, Connectors (the MCP
 * servers this conversation may use, named Connectors at the owner's request,
 * 2026-11-17), Skills (Plan, then Theorem's skills),
 * Code mode, and Manage tools,
 * which opens the MCP and tool settings. The modes that are on show as marks
 * beside it, so nothing on is out of sight.
 */
export function ComposerPlus() {
  const anchor = useRef<HTMLButtonElement>(null)
  // What a chosen item does once the menu has closed, handing focus on.
  const next = useRef<(() => void) | undefined>(undefined)
  const [connections, setConnections] = useState(false)
  const web = useWebSearch((state) => state.on)
  const toggleWeb = useWebSearch((state) => state.toggle)
  const threadKey = useThreadKey()
  const plan = usePlanning((state) => state.byThread[threadKey] === true)
  const setPlan = usePlanning((state) => state.set)
  const code = useCodeMode((state) => state.byThread[threadKey] === true)
  const setCodeMode = useCodeMode((state) => state.set)
  const tools = useConnectionTools()
  const served = connectionsServed(tools)
  const roster = tools.data ?? []
  const stored = useToolSelections((state) => state.byThread[threadKey])
  const saveSelection = useToolSelections((state) => state.set)
  // The conversation starts on its project's connections, as the roster does.
  const { base, baseKnown } = useProjectConnections()
  const selection = reconcile(roster, stored, base, baseKnown)
  const on = connectionsOn(roster, selection ?? base)
  const { skills } = useCatalogEntries()
  const installations = useSkillInstallations(
    skills.some(
      (skill) =>
        skill.source?.kind === 'import' && Boolean(skill.source.installationId),
    ),
  )
  const unavailableSkill = (
    skill: SkillEntry,
  ): { label: string; detail: string } | undefined => {
    const checking = {
      label: 'checking',
      detail: 'Checking the connections this skill can use.',
    }
    if (skill.source?.kind === 'mcp') {
      if (!baseKnown || tools.isPending) return checking
      if (on.has(skill.source.connection)) return undefined
      return {
        label: 'off',
        detail: `Turn on ${skillOrigin(skill)} in Connectors to use this skill.`,
      }
    }
    if (skill.source?.kind !== 'import' || !skill.source.installationId)
      return undefined
    if (installations.isPending) return checking
    const installationId = skill.source.installationId
    const installation = installations.data?.find(
      (item) => item.installationId === installationId,
    )
    if (installations.error || !installation)
      return {
        label: 'unavailable',
        detail: 'Open Plugins and skills to check this installation.',
      }
    if (installation.requirements.some((item) => item.status !== 'ready'))
      return {
        label: 'needs setup',
        detail:
          'Finish the package connection setup in Plugins and skills to use this skill.',
      }
    const required = Object.values(installation.connections)
    if (required.length && !baseKnown) return checking
    // Match the actual send: a stored choice, then the project default, then
    // all usable connections. A resource-only server may have no tools row.
    const effective = stored ?? base
    const off = required.filter(
      (id) => effective && !effective.connections.includes(id),
    )
    if (!off.length) return undefined
    const names = off.map(
      (id) => roster.find((group) => group.connectionId === id)?.label ?? id,
    )
    return {
      label: 'off',
      detail: `Turn on ${names.join(', ')} in Connectors to use this skill.`,
    }
  }

  const setCode = (checked: boolean) => {
    setCodeMode(threadKey, checked)
    // A coding task works beside the workbench, docked where it was last kept
    // (beside or under the conversation, so the composer stays in view); one
    // already open stays put, and turning the mode off leaves it open.
    const shell = useShell.getState()
    if (
      checked &&
      (shell.workbench === undefined || shell.workbench === 'closed')
    )
      shell.setWorkbench(shell.lastCompanion)
  }

  // Base UI decides where focus returns as the popup unmounts, after this
  // runs, so a choice stays recorded until the menu opens again: finalFocus
  // then keeps focus off the + button and the chosen item keeps it.
  const afterClose = (open: boolean) => {
    if (open) next.current = undefined
    else next.current?.()
  }

  return (
    <>
      {/* Its popups are panes of the composer's glass (glass/menu-glass). */}
      <MenuGlass surface="composer">
        <Menu onOpenChangeComplete={afterClose}>
          <MenuTrigger
            ref={anchor}
            aria-label="More options"
            className="flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-100 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink"
          >
            <Icon.Add className="size-4" />
          </MenuTrigger>
          <MenuPopup
            side="bottom"
            align="start"
            className="composer-menu w-42"
            // An item that opens something else hands focus to it, not back here.
            finalFocus={() => next.current === undefined}
          >
            <MenuCheckboxItem
              variant="switch"
              checked={web}
              onCheckedChange={toggleWeb}
            >
              <span className="flex items-center gap-2">
                <Icon.WebSearch />
                Web search
              </span>
            </MenuCheckboxItem>
            <MenuSub>
              <MenuSubTrigger>
                <Icon.Plugins />
                Connectors
              </MenuSubTrigger>
              <MenuSubPopup className="composer-menu w-45">
                <MenuGroup>
                  <MenuGroupLabel>MCP servers</MenuGroupLabel>
                  {served &&
                    roster.map((group) => (
                      <MenuCheckboxItem
                        key={group.connectionId}
                        variant="switch"
                        closeOnClick={false}
                        disabled={!group.enabled}
                        checked={on.has(group.connectionId)}
                        onCheckedChange={(checked) =>
                          saveSelection(
                            threadKey,
                            changeSelection(
                              roster,
                              selection,
                              { connection: group.connectionId, on: checked },
                              base,
                            ),
                          )
                        }
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Icon.Plugin />
                          <span className="min-w-0 break-words">
                            {group.label}
                          </span>
                        </span>
                      </MenuCheckboxItem>
                    ))}
                  {/* A roster that failed to load opens too: the roster says why and retries. */}
                  {served && (roster.length > 0 || tools.error) && (
                    <MenuItem
                      onClick={() =>
                        (next.current = () => setConnections(true))
                      }
                    >
                      <Icon.Search />
                      Choose tools
                    </MenuItem>
                  )}
                  {!(served && roster.length > 0) && (
                    <MenuLinkItem render={<Link to="/settings/connections" />}>
                      <Icon.Settings />
                      Add an MCP server
                    </MenuLinkItem>
                  )}
                </MenuGroup>
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <Icon.SkillControl />
                Skills
              </MenuSubTrigger>
              <MenuSubPopup className="composer-menu max-h-80 w-45 overflow-y-auto">
                <MenuCheckboxItem
                  variant="switch"
                  checked={plan}
                  onCheckedChange={(checked) => setPlan(threadKey, checked)}
                >
                  <span className="flex items-center gap-2">
                    <Icon.Plan />
                    Plan
                  </span>
                </MenuCheckboxItem>
                {skills.length > 0 && (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Available skills</MenuGroupLabel>
                      {skills.map((skill) => {
                        const blocked = unavailableSkill(skill)
                        return (
                          <MenuItem
                            key={skill.id}
                            disabled={Boolean(blocked)}
                            title={blocked?.detail ?? skill.description}
                            // Written once the menu has closed, so the caret lands in the draft.
                            onClick={() =>
                              (next.current = () =>
                                insertInComposer(
                                  anchor.current,
                                  `${defaultDirectiveFormatter.serialize({
                                    id: skill.id,
                                    type: 'skill',
                                    label: skill.name,
                                  })} `,
                                ))
                            }
                          >
                            <Icon.SkillControl />
                            <span className="min-w-0 flex-1 break-words">
                              {skill.name}
                            </span>
                            {skillOrigin(skill) && (
                              <span className="ms-2 shrink-0 truncate text-xs text-ink-muted">
                                {skillOrigin(skill)}
                                {blocked ? ` · ${blocked.label}` : ''}
                              </span>
                            )}
                          </MenuItem>
                        )
                      })}
                    </MenuGroup>
                  </>
                )}
                <MenuSeparator />
                <MenuLinkItem render={<Link to="/settings/plugins" />}>
                  <Icon.Settings />
                  Browse skills
                </MenuLinkItem>
              </MenuSubPopup>
            </MenuSub>
            <MenuItem
              onClick={() =>
                (next.current = () => insertInComposer(anchor.current))
              }
            >
              <Icon.CodeMode />
              Insert code block
            </MenuItem>
            <MenuCheckboxItem
              variant="switch"
              checked={code}
              onCheckedChange={setCode}
            >
              <span className="flex items-center gap-2">
                <Icon.CodeMode />
                Code mode
              </span>
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuLinkItem render={<Link to="/settings/connections" />}>
              <Icon.Settings />
              Manage tools
            </MenuLinkItem>
          </MenuPopup>
        </Menu>
      </MenuGlass>
      {web && (
        <ModeChip
          label="Web"
          icon={<Icon.WebSearch className="size-4" />}
          off={toggleWeb}
          name="web search"
        />
      )}
      {plan && (
        <ModeChip
          label="Plan"
          icon={<Icon.Plan className="size-4" />}
          off={() => setPlan(threadKey, false)}
          name="planning"
        />
      )}
      {code && (
        <ModeChip
          label="Code"
          icon={<Icon.CodeMode className="size-4" />}
          off={() => setCode(false)}
          name="code mode"
        />
      )}
      {served && (
        <ComposerConnections
          key={threadKey}
          tools={tools}
          threadKey={threadKey}
          base={base}
          baseKnown={baseKnown}
          open={connections}
          onOpenChange={setConnections}
          anchor={anchor}
        />
      )}
    </>
  )
}

/**
 * A mode that is on shows as its mark beside the + button, in the accent with
 * nothing around it; pressing the mark turns the mode off (owner, 2026-11-17).
 * Its name is in the label.
 */
function ModeChip({
  label,
  icon,
  name,
  off,
}: {
  label: string
  icon: ReactNode
  name: string
  off: () => void
}) {
  return (
    <Toggle
      pressed
      onPressedChange={off}
      aria-label={`${label} is on. Turn off ${name}`}
      data-composer-chip={label.toLowerCase()}
      className="flex size-8 items-center justify-center rounded-md outline-none focus-visible:outline-2 focus-visible:outline-focus"
    >
      {icon}
    </Toggle>
  )
}
