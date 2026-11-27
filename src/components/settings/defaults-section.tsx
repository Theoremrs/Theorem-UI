// SOURCING: the settings frame (SettingsSection, SettingsBox, SettingsRow),
// coss ui Select over Base UI Select and Badge, ui Button, and lib/shell/defaults
// (the rows over resolveHandler's EXT-03 order). A handler is chosen only by
// the person pressing a control here; nothing installed is selected for them.
import { useMemo } from 'react'
import { Badge } from '@/components/coss/badge'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/coss/select'
import {
  SettingsBox,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { Button } from '@/components/ui/button'
import '@/components/shell/builtin-chrome'
import {
  useContributions,
  useHandlerPreferences,
  sourceLabel,
} from '@/lib/contributions/registry'
import {
  REASON_TEXT,
  chooseHandler,
  defaultsRows,
  hideableBuiltins,
  restoreDefault,
  setBuiltinHidden,
} from '@/lib/shell/defaults'
import type { DefaultsRow } from '@/lib/shell/defaults'
import { useSafeMode } from '@/lib/shell/safe-mode'

const NO_CHOICE = ''

const KIND_LABEL: Record<string, string> = {
  shell: 'Workspace shell',
  'open-handler': 'Opens',
  application: 'Application',
  preview: 'Preview',
  'artifact-viewer': 'Artifact viewer',
  'collection-view': 'Collection view',
  'mention-presentation': 'Mention',
  'reference-row': 'Reference row',
  'property-cell': 'Property cell',
}

function statusNote(row: DefaultsRow) {
  switch (row.status) {
    case 'ambiguous':
      return `${row.ambiguous.length} handlers could serve this and nothing breaks the tie. The shipped one serves until you choose.`
    case 'missing':
      return `Your choice, ${row.missingPreference}, is not installed. The shipped default serves; restore it or choose another.`
    case 'orphaned':
      return `You chose ${row.missingPreference}, but nothing serves this now. Your choice is kept in case it returns.`
    default:
      return row.reason ? REASON_TEXT[row.reason] : 'Nothing serves this yet.'
  }
}

function DefaultRow({ row }: { row: DefaultsRow }) {
  const items = [
    {
      value: NO_CHOICE,
      label:
        row.hasPreference || row.status === 'ambiguous'
          ? 'Choose…'
          : 'Shipped default',
    },
    ...row.candidates.map((one) => ({
      value: one.id,
      label: `${one.label} (${sourceLabel(one.source)})`,
    })),
  ]
  const chosen =
    row.status === 'chosen' ? (row.current ?? NO_CHOICE) : NO_CHOICE
  const title = `${KIND_LABEL[row.kind] ?? row.kind}${row.kind === 'shell' ? '' : `: ${row.serves}`}`
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-2">
          {title}
          {row.status === 'ambiguous' && (
            <Badge variant="warning">Needs a choice</Badge>
          )}
          {(row.status === 'missing' || row.status === 'orphaned') && (
            <Badge variant="error">Not installed</Badge>
          )}
        </span>
      }
      description={statusNote(row)}
    >
      <div className="flex items-center gap-2">
        {row.candidates.length > 0 && (
          <Select
            items={items}
            value={chosen}
            onValueChange={(next) => {
              if (typeof next === 'string' && next !== NO_CHOICE)
                chooseHandler(row, next)
            }}
          >
            <SelectTrigger
              aria-label={`Handler for ${title}`}
              size="sm"
              className="w-56 min-w-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {items
                .filter((item) => item.value !== NO_CHOICE)
                .map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        )}
        {row.hasPreference && (
          <Button size="sm" variant="ghost" onClick={() => restoreDefault(row)}>
            Restore
          </Button>
        )}
      </div>
    </SettingsRow>
  )
}

/**
 * Which handler serves each application role and resource kind, why, and
 * where a decision is waiting. The shipped handler serves until the person
 * chooses; hiding a built-in or restoring a default never touches data.
 */
export function DefaultsSection() {
  const registry = useContributions((state) => state.contributions)
  const preferences = useHandlerPreferences()
  const safe = useSafeMode((state) => state.active)
  const rows = useMemo(
    () => defaultsRows(registry, preferences, safe),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store's data fields are the inputs
    [
      registry,
      preferences.byResource,
      preferences.byServes,
      preferences.workspace,
      preferences.hidden,
      preferences.shell,
      safe,
    ],
  )
  const navigation = useMemo(
    () => hideableBuiltins(registry, preferences.hidden),
    [registry, preferences.hidden],
  )
  const waiting = rows.filter(
    (row) => row.status === 'ambiguous' || row.status === 'missing',
  ).length
  return (
    <>
      <SettingsSection
        title="Default handlers"
        description={
          safe
            ? 'Safe mode is on: only the shipped handlers are shown, and your choices are kept untouched.'
            : waiting
              ? `${waiting} ${waiting === 1 ? 'choice is' : 'choices are'} waiting for you. Installing something never changes what serves.`
              : 'What opens each kind of resource and serves each application. Installing something never changes these.'
        }
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useHandlerPreferences.getState().resetAll()}
          >
            Restore all
          </Button>
        }
      >
        <SettingsBox>
          {rows.map((row) => (
            <DefaultRow key={row.key} row={row} />
          ))}
        </SettingsBox>
      </SettingsSection>
      <SettingsSection
        title="Built-in navigation"
        description="Hide a shipped destination you do not use. It stays installed and can be restored; Home cannot be hidden."
      >
        <SettingsBox>
          {navigation.map((entry) => (
            <SettingsRow
              key={entry.id}
              title={entry.label}
              description={
                entry.hidden ? 'Hidden from the rail' : 'Shown on the rail'
              }
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setBuiltinHidden(entry.id, !entry.hidden)}
              >
                {entry.hidden ? 'Restore' : 'Hide'}
              </Button>
            </SettingsRow>
          ))}
        </SettingsBox>
      </SettingsSection>
    </>
  )
}
