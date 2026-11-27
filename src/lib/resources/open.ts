// SOURCING: the app's existing routes (/c/$threadId, /notes/$documentId, /index with its view and item search params, /vault), as components/index/navigation and components/work/route name them; the contribution registry's `open-handler` kind (lib/contributions/registry), through which a handler for a resource kind is chosen in EXT-03's order. The default opener moves the browser history the router already listens to; the shell replaces it with `registerOpenHost`.
import { registerContributions } from '@/lib/contributions/registry'
import type { Contribution } from '@/lib/contributions/registry'
import { setDefaultOpener } from './registry'
import type { OpenRequest } from './registry'
import type { ResourceIdentity, ResourceRef } from './types'

const q = encodeURIComponent

/**
 * Where a resource opens by route, or nothing when the client does not know
 * (an extension kind, a run or artifact without the thread that holds it).
 * A destination is a route, never an identity.
 */
export function hrefFor(ref: ResourceRef): string | undefined {
  const { resource } = ref
  const thread = ref.provenance?.threadId
  switch (resource.kind) {
    case 'file':
      return `/vault?file=${q(resource.path)}&workspace=${q(resource.workspaceId)}`
    case 'document':
      return `/notes/${q(resource.documentId)}`
    case 'graph-object':
      return `/index?item=${q(resource.objectId)}`
    case 'record':
      return `/index?view=${q(`default:record:${resource.objectType}/${resource.objectId}`)}`
    case 'work-item':
      return `/index?item=${q(`work:${resource.itemId}`)}`
    case 'work-project':
      return `/index?view=${q(`default:work:project/${resource.projectId}`)}`
    case 'thread':
      return `/c/${q(resource.threadId)}`
    case 'message':
      return `/c/${q(resource.threadId)}#message-${q(resource.messageId)}`
    case 'run':
      return thread ? `/c/${q(thread)}#run-${q(resource.runId)}` : undefined
    case 'artifact':
      return thread
        ? `/c/${q(thread)}#artifact-${q(resource.artifactId)}`
        : undefined
    case 'extension':
      return undefined
  }
}

/** Opens by moving the history the router listens to; a same-origin route only. */
export function navigateByRoute(request: OpenRequest): void {
  const href = hrefFor(request.ref)
  if (!href) throw new Error('No route is known for this resource.')
  if (typeof window === 'undefined') throw new Error('No window.')
  window.history.pushState({}, '', href)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

setDefaultOpener(navigateByRoute)

const handler = (
  id: string,
  label: string,
  serves: string[],
): Contribution => ({
  kind: 'open-handler',
  id,
  label,
  serves,
  priority: 0,
  meta: { builtin: true, route: true },
})

/** The shipped open handlers for the first slice; an installed one never displaces them on its own (EXT-03). */
export const BUILT_IN_OPEN_HANDLERS: Contribution[] = [
  handler('theorem.open.file', 'Open file', ['file']),
  handler('theorem.open.document', 'Open document', [
    'document',
    'graph-object',
  ]),
  handler('theorem.open.record', 'Open record', ['record']),
  handler('theorem.open.work', 'Open work item', ['work-item', 'work-project']),
  handler('theorem.open.thread', 'Open conversation', ['thread', 'message']),
  handler('theorem.open.run', 'Open run', ['run']),
  handler('theorem.open.artifact', 'Open artifact', ['artifact']),
]

export const registerBuiltInOpenHandlers = () =>
  registerContributions(BUILT_IN_OPEN_HANDLERS)

export type { ResourceIdentity }
