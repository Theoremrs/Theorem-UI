// SOURCING: none — thin mapping from the wire's language effects to ./language (the owner): one owner call per effect, the effect's resource and revision handed over as the document the answer is bound to
import { reply, refusal } from '../port'
import type { Of, OwnerPort, OwnerReply } from '../port'
import type { Revision } from '../wire'
import type { DocumentsView } from '../documents/port'
import { startDiagnosticsFeed } from './feed'
import type { DiagnosticsFeedOptions } from './feed'
import type { Language } from './language'

export interface LanguagePortOptions {
  /** The documents open here. With it the port sends diagnostics for each one; without it, none. */
  documents?: Pick<DocumentsView, 'list' | 'on'>
  feed?: Pick<
    DiagnosticsFeedOptions,
    'debounceMs' | 'partialMs' | 'partialRetries' | 'timer'
  >
}

export function createLanguagePort(
  language: Language,
  options: LanguagePortOptions = {},
): OwnerPort<Of<'language'>> {
  return {
    subscribe: (listener) =>
      options.documents
        ? startDiagnosticsFeed({
            language,
            documents: options.documents,
            emit: listener,
            ...options.feed,
          })
        : () => {},
    async perform(effect, requestId): Promise<OwnerReply> {
      if (effect.kind === 'languageApplyPlan') {
        return reply(
          await language.applyPlan({
            requestId,
            planId: effect.payload.planId,
          }),
        )
      }
      if (
        effect.resource.type !== 'document' ||
        effect.resource.workspace !== language.workspaceId
      ) {
        return refusal(
          'wrong_resource',
          'A language effect needs a document of this workspace',
        )
      }
      const { resourceId } = effect.resource
      const bound = effect.revision
      if (bound?.scheme !== 'seq') {
        return refusal(
          'no_revision',
          'A language effect needs the numbered document revision it asks about',
        )
      }
      const document = { requestId, resourceId, revision: bound.value }

      switch (effect.kind) {
        case 'languageHover':
          return reply(
            await language.hover({ ...document, ...effect.payload }),
            (hover) => ({
              value: { type: 'languageHover', ...hover } as const,
            }),
          )
        case 'languageComplete':
          return reply(
            await language.complete({ ...document, ...effect.payload }),
            (items) => ({
              value: { type: 'languageCompletions', items } as const,
            }),
          )
        case 'languageNavigate':
          return reply(
            await language.navigate({
              ...document,
              ...effect.payload.position,
              kind: effect.payload.kind,
            }),
            (locations) => ({
              value: { type: 'languageLocations', locations } as const,
            }),
          )
        case 'languageReferences':
          return reply(
            await language.references({ ...document, ...effect.payload }),
            (locations) => ({
              value: { type: 'languageLocations', locations } as const,
            }),
          )
        case 'languageDiagnostics':
          return reply(await language.diagnostics(document), (snapshot) => ({
            value: { type: 'languageDiagnostics', ...snapshot } as const,
            ...(snapshot.revision !== undefined
              ? {
                  revision: {
                    scheme: 'seq',
                    value: snapshot.revision,
                  } satisfies Revision,
                }
              : {}),
          }))
        case 'languageFormat':
          return reply(await language.format(document), planReply)
        case 'languageRename':
          return reply(
            await language.rename({
              ...document,
              ...effect.payload.position,
              newName: effect.payload.newName,
            }),
            planReply,
          )
      }
    },
  }
}

const planReply = ({ planId }: { planId?: string }) =>
  planId ? { value: { type: 'languagePlan', planId } as const } : {}
