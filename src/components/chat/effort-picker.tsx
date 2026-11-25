// SOURCING: coss ui Menu over Base UI Menu (MenuRadioGroup / MenuRadioItem for the one choice), lib/theorem/models (the catalog's effort levels, the picked model), lib/theorem/generation (the effort a send carries, in the conversation's override over the account default)
import { useMemo } from 'react'
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
import { Icon } from '@/components/icons'
import { effortLabel, useGenerationDefaults } from '@/lib/theorem/generation'
import { useModelCatalog, usePickedModels } from '@/lib/theorem/models'
import type { ModelOption } from '@/lib/theorem/models'
import { useConversationGeneration, useLatestRunFacts } from '@/lib/theorem/use-generation'

/** The radio value of "no level": the model runs at its own default. */
const DEFAULT = ''

/**
 * The model the next turn runs on, as the catalog lists it: the picked one,
 * or Theorem's default when nothing is picked. Undefined until the catalog
 * says.
 */
export function useEffectiveModel(): { model: ModelOption | undefined } {
  const { data: catalog, list } = useModelCatalog()
  const selected = usePickedModels((s) => s.selected)
  const ref = selected ?? list?.defaultRef
  const model = useMemo(
    () => (ref ? catalog?.find((option) => option.ref === ref) : undefined),
    [catalog, ref],
  )
  return { model }
}

/**
 * The composer's reasoning effort menu, beside the model picker. It lists the
 * levels Theorem says the model's route sends and is absent for a model that
 * takes none. The level is the conversation's, over the account's default; it
 * goes out whatever the model, and Theorem maps one the model does not list.
 * When the last run was mapped, the menu names the level it ran at.
 *
 * A conversation can still hold response limits of its own, set before the
 * composer dropped its length control or raised from a stopped run's footer.
 * While it does, the menu offers to drop them for the account's.
 */
export function EffortPicker() {
  const { model } = useEffectiveModel()
  const { override, change } = useConversationGeneration()
  const accountEffort = useGenerationDefaults((s) => s.defaults.effort)
  const mapped = useLatestRunFacts()?.limits?.effort
  const levels = model?.effortLevels ?? []
  if (!levels.length) return null
  const chosen = override.effort ?? DEFAULT
  const requested = override.effort ?? accountEffort
  const ranAt = mapped?.requested === requested ? mapped?.effective : undefined
  const shown = ranAt ?? requested
  const standing = accountEffort ?? model?.effortDefault
  // A level kept from another model stays in the list so the choice shows.
  const listed = chosen && !levels.includes(chosen) ? [...levels, chosen] : levels
  const ownLimits =
    override.responseDetail !== undefined ||
    override.maxOutputTokens !== undefined ||
    override.runBudget !== undefined
  return (
    <Menu>
      <MenuTrigger
        aria-label="Reasoning effort"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-ink-muted transition-colors duration-100 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink"
      >
        <span>{shown ? effortLabel(shown) : 'Effort'}</span>
        <Icon.UpDown className="size-3.5 shrink-0" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end" className="w-36">
        <MenuGroup>
          <MenuGroupLabel>Reasoning effort</MenuGroupLabel>
          <MenuRadioGroup
            value={chosen}
            onValueChange={(value: string) => change({ effort: value || undefined })}
          >
            <MenuRadioItem value={DEFAULT}>
              <span className="flex items-baseline justify-between gap-3">
                Default
                {standing && (
                  <span className="text-xs text-ink-faint">{effortLabel(standing)}</span>
                )}
              </span>
            </MenuRadioItem>
            {listed.map((level) => (
              <MenuRadioItem key={level} value={level}>
                {effortLabel(level)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {ownLimits && (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                change({ responseDetail: undefined, maxOutputTokens: undefined, runBudget: undefined })
              }
            >
              Use account response limits
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  )
}
