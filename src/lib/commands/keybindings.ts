// SOURCING: zustand with its persist middleware (the person's own bindings
// outlive a reload and a product update, OWN-01), as shell-state is. Chord
// parsing, focus scoping and conflict resolution are this file's own; the
// rule they follow is the spec's EXT-03/EXT-04: no installation silently
// seizes a binding, and a bare key typed into a field stays text.
import { useEffect } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { applies, executeCommand, useCommandRegistry } from './registry'
import type {
  CommandContext,
  CommandSource,
  RegisteredCommand,
} from './registry'

const MODIFIERS = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const
type Modifier = (typeof MODIFIERS)[number]

const KEY_NAMES: Record<string, string> = {
  ' ': 'space',
  esc: 'escape',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
}

/**
 * A chord in one spelling: modifiers in a fixed order, then the key, all
 * lowercase. On a Mac `meta` is `mod`; elsewhere `ctrl` is. So `Ctrl+K` and
 * `ctrl+k` and, off a Mac, `mod+k` are one chord.
 */
export function normalizeChord(chord: string, mac: boolean): string {
  const parts = chord
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  // `mod++` names the plus key.
  const key = chord.endsWith('++') ? '+' : (parts.at(-1) ?? '')
  const held = new Set<Modifier>()
  for (const part of parts.slice(0, chord.endsWith('++') ? -2 : -1)) {
    const name =
      part === 'cmd' || part === 'command'
        ? 'meta'
        : part === 'control'
          ? 'ctrl'
          : part === 'option'
            ? 'alt'
            : part
    if (!(MODIFIERS as ReadonlyArray<string>).includes(name))
      throw new Error(`${chord}: ${part} is not a modifier`)
    held.add(name as Modifier)
  }
  if (held.has('mod')) {
    held.delete('mod')
    held.add(mac ? 'meta' : 'ctrl')
  }
  const platformMod = mac ? 'meta' : 'ctrl'
  const out = MODIFIERS.filter((one) => one !== 'mod' && held.has(one)).map(
    (one) => (one === platformMod ? 'mod' : one),
  )
  return [...out, KEY_NAMES[key] ?? key].join('+')
}

/** The chord a key press makes, in normalizeChord's spelling. */
export function chordOfEvent(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
  mac: boolean,
): string {
  const held = {
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  }
  const platformMod = mac ? 'meta' : 'ctrl'
  const modifiers = (['ctrl', 'meta', 'alt', 'shift'] as const)
    .filter((one) => held[one])
    .map((one) => (one === platformMod ? 'mod' : one))
  const key = event.key.toLowerCase()
  return [...modifiers, KEY_NAMES[key] ?? key].join('+')
}

/** A chord with no modifier but shift, which a text field takes as typing. */
export const isTypingChord = (chord: string) =>
  !/(^|\+)(mod|ctrl|meta|alt)\+/.test(chord)

/** Which element is focused, as the command layer cares about it. */
export function focusOf(element: Element | null): CommandContext['focus'] {
  if (!element || element === element.ownerDocument.body) return 'none'
  if (element.closest('.xterm, [data-terminal]')) return 'terminal'
  if (
    element.closest(
      '.cm-editor, .ProseMirror, [contenteditable=""], [contenteditable="true"]',
    )
  )
    return 'editor'
  if (element.matches('input, textarea, select')) return 'input'
  if (element.closest('[role="dialog"], [role="alertdialog"]')) return 'dialog'
  return 'none'
}

export const KEYBINDINGS_SCHEMA = 'theorem.keybindings/1'

/**
 * The person's own bindings, kept apart from every default: a chord they
 * point at a command, or at null to leave it unbound.
 */
interface UserBindings {
  bindings: Record<string, string | null>
  bind: (chord: string, commandId: string | null) => void
  reset: (chord: string) => void
}

export const useUserKeybindings = create<UserBindings>()(
  persist(
    (set) => ({
      bindings: {},
      bind: (chord, commandId) =>
        set((state) => ({
          bindings: { ...state.bindings, [chord]: commandId },
        })),
      reset: (chord) =>
        set((state) => {
          const { [chord]: _, ...rest } = state.bindings
          return { bindings: rest }
        }),
    }),
    {
      name: KEYBINDINGS_SCHEMA,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ bindings: state.bindings }),
    },
  ),
)

export interface BindingConflict {
  chord: string
  /** The command that keeps the chord. */
  holder: string
  /** The command whose default was not bound. */
  refused: string
}

export interface ResolvedBindings {
  byChord: ReadonlyMap<string, string>
  conflicts: ReadonlyArray<BindingConflict>
}

const rank = (source: CommandSource) => (source.kind === 'builtin' ? 0 : 1)

/**
 * Which command each chord runs. The person's own bindings come first; then
 * built-in defaults; then module and extension defaults in the order they
 * registered. A default that finds its chord taken is not bound and is
 * reported, so an installation cannot quietly take a key (EXT-03).
 */
export function resolveBindings(
  commands: Iterable<RegisteredCommand>,
  user: Record<string, string | null>,
  mac: boolean,
): ResolvedBindings {
  const byChord = new Map<string, string>()
  const claimed = new Set<string>()
  const conflicts: BindingConflict[] = []
  const known = new Map([...commands].map((one) => [one.id, one]))
  for (const [chord, id] of Object.entries(user)) {
    const key = normalizeChord(chord, mac)
    claimed.add(key)
    if (id !== null && known.has(id)) byChord.set(key, id)
  }
  const ordered = [...known.values()]
    .map((command, at) => ({ command, at }))
    .toSorted(
      (a, b) => rank(a.command.source) - rank(b.command.source) || a.at - b.at,
    )
  for (const { command } of ordered)
    for (const chord of command.keys ?? []) {
      const key = normalizeChord(chord, mac)
      const holder = byChord.get(key)
      if (holder === command.id) continue
      if (holder) conflicts.push({ chord: key, holder, refused: command.id })
      else if (!claimed.has(key)) byChord.set(key, command.id)
    }
  return { byChord, conflicts }
}

export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * The one window key listener for commands. A chord that maps to a command
 * which applies runs it through executeCommand; anything else passes through
 * untouched. A bare key typed into a field, editor or terminal stays text.
 */
export function useCommandKeybindings(path: () => string) {
  useEffect(() => {
    const mac = isMacPlatform()
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (['control', 'meta', 'alt', 'shift'].includes(event.key.toLowerCase()))
        return
      const chord = chordOfEvent(event, mac)
      const focus = focusOf(document.activeElement)
      if (focus !== 'none' && focus !== 'dialog' && isTypingChord(chord)) return
      const { commands } = useCommandRegistry.getState()
      const { byChord } = resolveBindings(
        commands.values(),
        useUserKeybindings.getState().bindings,
        mac,
      )
      const id = byChord.get(chord)
      const command = id ? commands.get(id) : undefined
      const context: CommandContext = { focus, path: path() }
      if (!command || !applies(command, context)) return
      event.preventDefault()
      void executeCommand(command.id, undefined, context, 'keybinding')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path])
}
