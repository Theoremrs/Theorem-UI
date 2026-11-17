// SOURCING: the app's own appearance store and its zod schema (`@/lib/appearance`: Zustand, Zod). The selection is validated by `appearanceSelectionSchema` and applied through the store's public `loadSelection`; no second schema or parser exists here.
import { appearanceSelectionSchema } from '@/lib/appearance'
import type { AppearanceSelection } from '@/lib/appearance'
import type { Of, OwnerPort } from '../port'
import { refusal } from '../port'

/** What this owner needs of the appearance store: `useAppearance` satisfies it. */
export interface AppearanceStore {
  getState: () => AppearanceSelection & {
    loadSelection: (selection: AppearanceSelection) => void
  }
  subscribe: (listener: () => void) => () => void
}

/**
 * The text the core keeps and saves with an arrangement: the person's selection (preset and
 * overrides), the store's own round-trippable value, as JSON. Never the resolved theme.
 */
export function appearanceText(store: AppearanceStore): string {
  const { preset, overrides } = store.getState()
  return JSON.stringify({ preset, overrides })
}

/**
 * Tells the core the person's appearance now and again whenever it changes, so a save always
 * carries the current one. Returns the function that stops the telling.
 */
export function tellAppearance(
  store: AppearanceStore,
  tell: (text: string) => void,
): () => void {
  let told: string | undefined
  const send = () => {
    const text = appearanceText(store)
    if (text === told) return
    told = text
    tell(text)
  }
  send()
  return store.subscribe(send)
}

/** The first thing wrong with a selection, in words a person can read. */
function problem(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): string {
  const [issue] = error.issues
  if (!issue) return 'it is not a valid appearance'
  const where = issue.path.map(String).join('.')
  return where ? `${where}: ${issue.message}` : issue.message
}

/** Applies the theme a saved arrangement carries, through the store's public setter. */
export function createAppearancePort(
  store: AppearanceStore,
): OwnerPort<Of<'appearance'>> {
  return {
    perform(effect) {
      let parsed: unknown
      try {
        parsed = JSON.parse(effect.payload.appearance)
      } catch {
        return Promise.resolve(
          refusal('invalid_appearance', 'the saved theme is not JSON'),
        )
      }
      const selection = appearanceSelectionSchema.safeParse(parsed)
      if (!selection.success) {
        return Promise.resolve(
          refusal('invalid_appearance', problem(selection.error)),
        )
      }
      store.getState().loadSelection(selection.data)
      return Promise.resolve({ outcome: 'accepted' })
    },
  }
}
