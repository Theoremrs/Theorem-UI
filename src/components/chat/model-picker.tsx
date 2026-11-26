import { appearancePair } from '@/lib/appearance-policy'
// SOURCING: coss ui Combobox over Base UI Combobox (input inside the popup, as coss's "With Input Inside Popup" example, drawn as coss's CommandInput draws a search on a menu; `multiple`, so a row is pressed into the room and pressed out of it again by pointer or by keyboard), ./model-mark (Lobe Icons' provider marks), ./effort-picker in the popup's footer, lib/theorem/models (catalog, stars, pick), lib/theorem/roster (the conversation's participants)
import { useEffect, useMemo } from 'react'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  ComboboxCollection,
} from '@/components/coss/combobox'
import { menuSearch } from '@/components/assistant-ui/elements/surfaces'
import { useMenuGlass } from '@/components/glass/menu-glass'
import { EffortPicker } from '@/components/chat/effort-picker'
import { ModelMark } from '@/components/chat/model-mark'
import { Icon } from '@/components/icons'
import {
  formatContext,
  modelStub,
  modelCatalogIssue,
  useEffectiveRef,
  useModelCatalog,
  usePickedModels,
} from '@/lib/theorem/models'
import type { ModelOption } from '@/lib/theorem/models'
import { refOf, useConversationRoster } from '@/lib/theorem/roster'
import { cn } from '@/lib/utils'

/** Theorem's configured choice unless the person picks another. */
const DEFAULT_ITEM: ModelOption = modelStub('', 'Default model')

/** How many marks the button draws before the rest are counted rather than shown. */
const MAX_MARKS = 3

type Group = { label: string; items: ModelOption[] }

function pickerGroups(
  starred: readonly string[],
  byRef: ReadonlyMap<string, ModelOption>,
  catalog: readonly ModelOption[],
): Group[] {
  // A star can outlive its catalog row, and a row that's gone can't run.
  const picks = starred.flatMap((ref) => byRef.get(ref) ?? [])
  const listed = picks.length
    ? { label: 'Starred', items: picks }
    : { label: 'Models', items: [...catalog] }
  return [
    { label: 'Default', items: [DEFAULT_ITEM] },
    ...(listed.items.length ? [listed] : []),
  ]
}

/**
 * The model's full name, saying "(default)" when Theorem chose it.
 * A room of two or more is named by its models and nothing else, so every
 * participant is said in the order it was seated.
 */
function pickerLabel(
  shown: readonly ModelOption[],
  defaultName: string | undefined,
) {
  if (shown.length > 1) return shown.map((model) => model.name).join(', ')
  const selected = shown[0]
  if (selected?.ref) return selected.name
  if (!defaultName) return selected?.name ?? 'Model'
  return `${defaultName} (default)`
}

function PickerOption({
  model,
  defaultName,
  seated,
}: {
  model: ModelOption
  defaultName?: string
  /** Whether this model is what a turn runs on right now. */
  seated: boolean
}) {
  return (
    // The row is the room's door, opened the same way by keyboard as by pointer:
    // pressing a row that is checked gives its seat up, so removal needs no
    // second control inside the option. `aria-checked` says membership in those
    // terms, which a listbox's own selection state does not.
    <ComboboxItem value={model} aria-checked={seated}>
      <div className="flex items-center gap-2">
        <ModelMark vendor={model.vendor} className="text-ink-muted" />
        {/* The model the default stands for goes under its name, so the
            name keeps the row's width and neither breaks inside a word. */}
        <span className="flex min-w-0 flex-1 flex-col break-words">
          {model.name}
          {!model.ref && defaultName && (
            <span className="text-xs text-ink-muted">{defaultName}</span>
          )}
        </span>
        {model.contextLength && (
          <span className="shrink-0 text-xs text-ink-muted tabular-nums">
            {formatContext(model.contextLength)}
          </span>
        )}
      </div>
    </ComboboxItem>
  )
}
/**
 * The composer's room. It lists the models the person starred in Settings, or
 * every model Theorem can run until they star some, plus Theorem's default, and
 * a checked row means its model holds a seat in this conversation: picking one
 * adds that agent, picking it again gives the seat up. Two or more checked
 * models make a conversation of peers, each bound to one model, which the next
 * turn runs with.
 *
 * The effort footer stays where it was, for one participant: it belongs to the
 * lead — the seat the last pick acted on — which is what `useEffectiveRef`
 * answers for. One menu for one model in charge is the single decision; a room
 * of peers would need one footer per seat, and that is the next slice's call.
 */
export function ModelPicker() {
  const { data: catalog = [], list, error } = useModelCatalog()
  const issue = modelCatalogIssue(list, error)
  const starred = usePickedModels((s) => s.starred)
  const select = usePickedModels((s) => s.select)
  const glass = useMenuGlass('composer')
  // What a turn runs on: a seated model when the room has one, else this
  // browser's pick, else nothing at all.
  const picked = useEffectiveRef()
  const {
    participants,
    error: rosterIssue,
    addModel,
    removeParticipant,
    setRoster,
  } = useConversationRoster()

  const byRef = useMemo(
    () => new Map(catalog.map((model) => [model.ref, model])),
    [catalog],
  )
  const groups = useMemo(
    () => pickerGroups(starred, byRef, catalog),
    [starred, byRef, catalog],
  )
  const seats = useMemo(
    () => participants.map((participant) => refOf(participant.model)),
    [participants],
  )
  // A model this Theorem can no longer run cannot hold a seat: the room gives
  // it up rather than refusing every turn that follows.
  useEffect(() => {
    if (!list || !seats.length) return
    const running = seats.filter((ref) => byRef.has(ref))
    if (running.length !== seats.length) setRoster(running)
  }, [list, seats, byRef, setRoster])
  // A browser-wide pick this Theorem can no longer run would refuse every turn,
  // as it did before there were rooms.
  useEffect(() => {
    if (list && !seats.length && picked && !byRef.has(picked)) select(undefined)
  }, [list, seats.length, picked, byRef, select])
  // The rows the button marks, and the list checks: the seated models, or what
  // an unseated conversation runs on — this browser's pick, then Theorem's
  // default.
  const shown = useMemo(() => {
    if (seats.length)
      return seats.map((ref) => byRef.get(ref) ?? modelStub(ref))
    if (picked) return [byRef.get(picked) ?? modelStub(picked)]
    return [DEFAULT_ITEM]
  }, [seats, picked, byRef])
  // What Theorem's choice resolves to, so the person knows what an unpinned turn runs on.
  const defaultModel = list?.defaultRef ? byRef.get(list.defaultRef) : undefined
  const defaultName = defaultModel?.name
  const label = pickerLabel(shown, defaultName)
  const name = shown.length > 1 ? `Models: ${label}` : `Model: ${label}`
  // The mark of each model in charge; the default takes the mark of what
  // Theorem's choice resolves to. A long room draws its first seats and counts
  // the rest, so the button stays the size it was.
  const marks = shown.map((model) =>
    model.ref ? model.vendor : (defaultModel?.vendor ?? ''),
  )
  const extra = Math.max(0, marks.length - MAX_MARKS)

  /**
   * One press acts on one row, and a multi-select combobox reports the whole
   * selection, so the row is the one that moved.
   */
  const toggle = (models: readonly ModelOption[]) => {
    const refs = models.map((model) => model.ref)
    const marked = shown.map((model) => model.ref)
    const pressed =
      refs.find((ref) => !marked.includes(ref)) ??
      marked.find((ref) => !refs.includes(ref))
    // The default row stands for an empty room: no seat, so a turn runs on
    // Theorem's own default.
    if (!pressed) return setRoster([])
    // A room of its own takes the pressed model as its first seat, replacing
    // what the button was showing — a browser-wide pick is not a seat.
    if (!seats.length) return setRoster([pressed])
    if (!refs.includes(pressed)) {
      const seat = participants.find((part) => refOf(part.model) === pressed)
      if (seat) removeParticipant(seat.participantId)
      return
    }
    addModel(pressed, byRef.get(pressed)?.name)
  }

  return (
    <Combobox<ModelOption, true>
      multiple
      items={groups}
      value={shown}
      onValueChange={toggle}
      itemToStringLabel={(model) => model.name}
      itemToStringValue={(model) => `${model.name} ${model.ref}`}
      isItemEqualToValue={(a, b) => a.ref === b.ref}
    >
      {/* The makers' marks alone; the full names are the button's name. */}
      <ComboboxTrigger
        aria-label={name}
        data-model-picker-trigger=""
        {...appearancePair('secondary', 'composer')}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-100 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink"
      >
        <span
          className={cn('flex items-center', marks.length > 1 && '-space-x-1')}
        >
          {marks.slice(0, MAX_MARKS).map((vendor, at) =>
            extra && at === MAX_MARKS - 1 ? (
              <span
                key="extra"
                aria-hidden="true"
                className="shrink-0 text-xs tabular-nums"
              >
                +{extra}
              </span>
            ) : (
              <ModelMark key={shown[at]?.ref || at} vendor={vendor} />
            ),
          )}
        </span>
        <span className="sr-only">{label}</span>
      </ComboboxTrigger>
      <ComboboxPopup
        side="bottom"
        align="end"
        surfaceRef={glass.attach}
        className={cn('w-56 appearance-model-popup', glass.className)}
      >
        <div className="border-b border-separator p-1">
          <ComboboxInput
            size="sm"
            showTrigger={false}
            placeholder="Find a model"
            className={menuSearch}
            data-appearance-recipe="ui.label"
            {...appearancePair('secondary', 'popover')}
            startAddon={<Icon.Search className="size-3.5" />}
          />
        </div>
        {issue && (
          <p role="alert" className="px-3 py-2 text-sm text-ink-muted">
            {issue}
          </p>
        )}
        <ComboboxEmpty className="px-3 py-4 text-sm text-ink-muted not-empty:block hidden">
          No model matches.
        </ComboboxEmpty>
        <ComboboxList className="overflow-y-auto p-1">
          {(group: Group) => (
            <ComboboxGroup key={group.label} items={group.items}>
              <ComboboxGroupLabel
                data-appearance-recipe="metadata"
                {...appearancePair('secondary', 'popover')}
                className="px-2 pt-1 pb-0.5 text-xs text-ink-muted"
              >
                {group.label}
              </ComboboxGroupLabel>
              <ComboboxCollection>
                {(model: ModelOption) => (
                  <PickerOption
                    key={model.ref}
                    model={model}
                    defaultName={defaultName}
                    seated={shown.some((row) => row.ref === model.ref)}
                  />
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {/* A room the person changed somewhere else, or could not change here. */}
        {rosterIssue && (
          <p role="alert" className="px-3 py-2 text-sm text-ink-muted">
            {rosterIssue}
          </p>
        )}
        {/* Only a model that takes an effort level has a footer. */}
        <div className="flex items-center border-t border-separator p-1 empty:hidden">
          <EffortPicker />
        </div>
      </ComboboxPopup>
    </Combobox>
  )
}
