// SOURCING: the real clients each first-slice provider wraps (see ./providers): lib/workspace (workspaceClient, getTheoremVault), components/crm/api (findRecord, searchRecords, readLifeContext) with components/records (readDataModel, recordTitle), components/index/api (runBinding), components/work/api, the chat SDK through lib/theorem/client, and lib/theorem/organization (readOrganization). The only file that imports those clients for the resource layer; tests supply fakes to the provider factories instead.
import { accessFor } from '@/components/crm/model'
import {
  findRecord,
  readLifeContext,
  searchRecords,
} from '@/components/crm/api'
import * as indexApi from '@/components/index/api'
import { readDataModel } from '@/components/records/api'
import { identifierField, recordTitle } from '@/components/records/model'
import * as workApi from '@/components/work/api'
import { theorem } from '@/lib/theorem/client'
import { readOrganization } from '@/lib/theorem/organization'
import { workspaceClient } from '@/lib/workspace/workspaces'
import {
  getTheoremVault,
  THEOREM_WORKSPACE_PREFIX,
} from '@/lib/workspace/theorem-client'
import {
  artifactsProvider,
  documentsProvider,
  filesProvider,
  recordsProvider,
  runsProvider,
  threadsProvider,
  workProvider,
} from './providers'
import { registerBuiltInOpenHandlers } from './open'
import { registerProvider } from './registry'
import type { ResourceProvider } from './provider'

/** The first slice's providers over the real clients (REF-03). */
export function builtInProviders(): ResourceProvider[] {
  return [
    filesProvider({
      client: (workspaceId) =>
        workspaceId.startsWith(THEOREM_WORKSPACE_PREFIX)
          ? workspaceClient({
              id: workspaceId,
              name: 'Theorem',
              path: '',
              trusted: false,
              policy: 'ConnectedLive',
            })
          : undefined,
      defaultWorkspaceId: async () => {
        const vault = await getTheoremVault()
        return typeof vault === 'object' ? vault.id : undefined
      },
    }),
    documentsProvider({
      items: async ({ q, ids, limit }) => {
        const result = await indexApi.runBinding({
          kind: 'items',
          query: {
            ...(q ? { q } : { sort: 'updated' as const }),
            ...(ids && { ids }),
            limit,
          },
        })
        if (result.kind !== 'items')
          throw new Error('The Index answered another shape.')
        return { items: result.items, total: result.total }
      },
    }),
    recordsProvider({
      types: async () => (await readDataModel(true)).objectTypes,
      find: (typeId, id) => findRecord(typeId, id),
      search: (type, query, limit) =>
        searchRecords(
          type.object_type_id,
          identifierField(type)?.key,
          query,
          limit,
        ),
      canRead: async (type) =>
        accessFor(await readLifeContext().catch(() => undefined), type).read,
      title: recordTitle,
    }),
    workProvider({
      item: workApi.readItem,
      project: workApi.readProject,
      query: workApi.queryItems,
    }),
    threadsProvider({
      thread: async (threadId) => {
        const { thread, messages } = await theorem().chat.threads.get({
          threadId,
        })
        return {
          title: thread.title,
          deletedAtMs: thread.deletedAtMs,
          revision: thread.revision,
          messages: messages.map((m) => ({
            messageId: m.messageId,
            role: m.role,
            text:
              m.parts
                .map((part) =>
                  part.type === 'text'
                    ? (part.payload as { text?: unknown } | undefined)?.text
                    : undefined,
                )
                .filter((t): t is string => typeof t === 'string')
                .join('\n') || undefined,
          })),
        }
      },
      list: async () => {
        const organization = await readOrganization()
        return {
          threads: organization.threads.map((t) => ({
            threadId: t.threadId,
            title: t.title,
          })),
          complete: organization.complete,
        }
      },
    }),
    runsProvider({ run: (runId) => theorem().chat.runs.get({ runId }) }),
    // An artifact found by id alone resolves and previews through the served
    // Resources routes (ART-02); this provider opens one whose thread is known.
    artifactsProvider({}),
  ]
}

/** Registers the shipped providers and open handlers; returns the function that removes them. */
export function registerBuiltIns(): () => void {
  const removes = [
    ...builtInProviders().map(registerProvider),
    registerBuiltInOpenHandlers(),
  ]
  return () => removes.forEach((remove) => remove())
}
