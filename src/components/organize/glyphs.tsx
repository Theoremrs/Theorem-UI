// SOURCING: the owner's Streamline Ultimate file marks (components/icons, traced by scripts/rail-icons.mjs) for session types and the states that outrank them, lucide-react file marks (FileTerminal, FileCog) for the two types Streamline was not given, components/icons for the folder and the rest of the owned set. The owner's review on 2026-11-14: the Streamline marks are used by state, the four pages in a square when others were forked from a session. A row's icon says what kind of thing it is, and the person decides that: a project is a folder; a session wears its chosen type (lib/theorem/sidebar-prefs), a Conversation until one is chosen. The Librarian's topic glyph is no longer drawn as the icon; it stays in the organization record as metadata.
import { FileCog, FileTerminal } from 'lucide-react'
import type { ComponentProps, ComponentType } from 'react'
import { Icon } from '@/components/icons'
import { useOrganizedViews } from '@/lib/theorem/organization'
import type { OrganizedViews, ThreadEntry } from '@/lib/theorem/organization'
import { useSessionType } from '@/lib/theorem/sidebar-prefs'
import type { TypeMark } from '@/lib/theorem/sidebar-prefs'
import { cn } from '@/lib/utils'

type Mark = ComponentType<ComponentProps<'svg'>>

/** A lucide mark drawn at the stroke the type marks share. */
const stroked =
  (Lucide: Mark): Mark =>
  (props) => <Lucide strokeWidth={1.75} {...props} />

export const TYPE_MARK: Readonly<Record<TypeMark, Mark>> = {
  document: Icon.SessionText,
  'terminal-file': stroked(FileTerminal),
  'checklist-file': Icon.SessionCheck,
  'code-file': Icon.SessionCode,
  'cog-file': stroked(FileCog),
  'image-file': Icon.SessionImage,
  chat: Icon.Thread,
  graph: Icon.Graph,
  research: Icon.Skill,
}

export const TYPE_MARK_LABEL: Readonly<Record<TypeMark, string>> = {
  document: 'Document',
  'terminal-file': 'File with terminal',
  'checklist-file': 'File with checklist',
  'code-file': 'Code file',
  'cog-file': 'File with gear',
  'image-file': 'Image file',
  chat: 'Chat bubble',
  graph: 'Graph',
  research: 'Research',
}

type MarkProps = ComponentProps<'svg'>

/** A mark by name, for type pickers and graph nodes. */
export function TypeMarkIcon({
  mark,
  className,
  ...props
}: MarkProps & { mark: TypeMark }) {
  const Mark = TYPE_MARK[mark]
  return (
    <Mark aria-hidden {...props} className={cn('size-4 shrink-0', className)} />
  )
}

/** The states a session's mark can show over its type, strongest first. */
export type SessionState = 'forked-from' | 'continues' | 'not-started'

const STATE_MARK: Readonly<Record<SessionState, Mark>> = {
  'forked-from': Icon.SessionForked,
  continues: Icon.SessionContinued,
  'not-started': Icon.SessionEmpty,
}

export const SESSION_STATE_LABEL: Readonly<Record<SessionState, string>> = {
  'forked-from': 'Others were forked from it',
  continues: 'Continues another session',
  'not-started': 'Not started',
}

/**
 * What a session's mark says over its type: others were forked from it,
 * it continues another, or nothing has been said in it yet.
 */
export function sessionState(
  thread: ThreadEntry | undefined,
  views: Pick<OrganizedViews, 'forkedFrom'>,
): SessionState | undefined {
  if (!thread) return undefined
  if (views.forkedFrom.has(thread.threadId)) return 'forked-from'
  if (thread.origin?.kind === 'continued') return 'continues'
  if (thread.lastMessageAtMs === undefined) return 'not-started'
  return undefined
}

/**
 * A session's mark: the four pages when others were forked from it, the
 * pair when it continues another, the empty page before it starts, and
 * otherwise its chosen type's (a document until one is chosen).
 */
export function SessionGlyph({
  threadId,
  className,
  ...props
}: MarkProps & { threadId: string }) {
  const type = useSessionType(threadId)
  const views = useOrganizedViews()
  const state = sessionState(views.byId.get(threadId), views)
  if (!state)
    return <TypeMarkIcon mark={type.mark} className={className} {...props} />
  const Mark = STATE_MARK[state]
  return (
    <Mark aria-hidden {...props} className={cn('size-4 shrink-0', className)} />
  )
}

/** A project's mark: always the folder files are listed with. */
export function ProjectGlyph(props: MarkProps) {
  return <Icon.Folder {...props} />
}
