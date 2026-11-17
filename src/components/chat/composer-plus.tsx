// SOURCING: coss ui Menu over Base UI Menu (the WAI-ARIA menu-button pattern: arrow keys, typeahead, Escape back to the button; MenuCheckboxItem for the modes, so opening the menu changes nothing until an item is chosen; MenuSub, MenuSubTrigger and MenuSubPopup over Base UI's SubmenuRoot for Connectors and Skills, which open on hover or the right arrow; Manage tools is a link to the connections settings); Skills lists Plan and then the skills Theorem serves (lib/theorem/catalog, Theorem's native skill registry), and a pick writes assistant-ui's defaultDirectiveFormatter `:skill[title]{name=id}` into the draft through the editor's insertInComposer, as a / tool pick writes `:tool[name]`, so the turn's model reads which skill was asked for and loads it with skill_get, ui/tooltip over Base UI Tooltip; the Web, Plan and Code mode state from ./composer-tools and the connections roster from ./composer-connections, which opens anchored to this button; Connectors lists the roster's MCP servers as switches over lib/theorem/tool-selection; Code mode opens the right-hand terminal through the shell store; MenuCheckboxItem's switch variant keeps every row on one start edge; Base UI Toggle for the marks that say a mode is on
import { defaultDirectiveFormatter, useAuiState } from '@assistant-ui/react'
import { Toggle } from '@base-ui/react/toggle'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ComposerConnections,
  connectionsServed,
} from '@/components/chat/composer-connections'
import { insertInComposer } from '@/components/chat/composer-editor'
import {
  COMPOSER_TOOLTIP_DELAY,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useCatalogEntries } from '@/lib/theorem/catalog'
import { useConnectionTools } from '@/lib/theorem/connections'
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
  const selection = reconcile(roster, stored)
  const on = connectionsOn(roster, selection)
  const { skills } = useCatalogEntries()

  const setCode = (checked: boolean) => {
    setCodeMode(threadKey, checked)
    // A coding task works beside the terminal; turning the mode off leaves it open.
    if (checked) useShell.getState().setSideDrawer('terminal')
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
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                delay={COMPOSER_TOOLTIP_DELAY}
                render={
                  <MenuTrigger
                    ref={anchor}
                    aria-label="More options"
                    className="flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-100 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink"
                  />
                }
              >
                <Icon.Add className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="top">
                Web search, connectors, skills and code mode
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <MenuPopup
            side="top"
            align="start"
            className="composer-menu w-60"
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
              <MenuSubPopup className="composer-menu w-64">
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
                            changeSelection(roster, selection, {
                              connection: group.connectionId,
                              on: checked,
                            }),
                          )
                        }
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Icon.Plugin />
                          <span className="truncate">{group.label}</span>
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
              <MenuSubPopup className="composer-menu max-h-80 w-64 overflow-y-auto">
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
                      <MenuGroupLabel>From Theorem</MenuGroupLabel>
                      {skills.map((skill) => (
                        <MenuItem
                          key={skill.id}
                          title={skill.description}
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
                          <span className="min-w-0 flex-1 truncate">
                            {skill.name}
                          </span>
                          {skill.plugin && (
                            <span className="ms-2 shrink-0 truncate text-xs text-ink-muted">
                              {skill.plugin}
                            </span>
                          )}
                        </MenuItem>
                      ))}
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
 * Its name is in the tooltip and the label.
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
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          delay={COMPOSER_TOOLTIP_DELAY}
          render={
            <Toggle
              pressed
              onPressedChange={off}
              aria-label={`${label} is on. Turn off ${name}`}
              data-composer-chip={label.toLowerCase()}
              className="flex size-8 items-center justify-center rounded-md outline-none focus-visible:outline-2 focus-visible:outline-focus"
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent side="top">{`${label} is on. Press to turn it off`}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
