// SOURCING: none — thin mapping from the wire's language effects to ./language (the owner): one owner call per effect, the effect's resource and revision handed over as the document the answer is bound to
import { reply, refusal } from '../port'
import type { Of, OwnerPort, OwnerReply } from '../port'
import type { CompletionPayload, Revision } from '../wire'
import type {
  CompletionItem,
  DiagnosticsResult,
  HoverResult,
  Language,
  LocationRow,
} from './language'

/**
 * Result payloads the wire does not carry yet (`languagePlan` is the only language variant it
 * has). They follow the wire's convention, a `type` tag beside the struct's own fields, so the
 * Rust side can add structs of exactly these shapes; until it does the tag is not one of
 * `CompletionPayload`'s, which is why the cast sits in one place.
 */
export type LanguageHoverPayload = { type: 'languageHover' } & HoverResult
export type LanguageCompletionsPayload = {
  type: 'languageCompletions'
  items: CompletionItem[]
}
export type LanguageLocationsPayload = {
  type: 'languageLocations'
  locations: LocationRow[]
}
export type LanguageDiagnosticsPayload = {
  type: 'languageDiagnostics'
} & DiagnosticsResult

const proposed = <T extends { type: string }>(payload: T) =>
  payload as unknown as CompletionPayload

export function createLanguagePort(
  language: Language,
): OwnerPort<Of<'language'>> {
  return {
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
              value: proposed({ type: 'languageHover', ...hover }),
            }),
          )
        case 'languageComplete':
          return reply(
            await language.complete({ ...document, ...effect.payload }),
            (items) => ({
              value: proposed({ type: 'languageCompletions', items }),
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
              value: proposed({ type: 'languageLocations', locations }),
            }),
          )
        case 'languageReferences':
          return reply(
            await language.references({ ...document, ...effect.payload }),
            (locations) => ({
              value: proposed({ type: 'languageLocations', locations }),
            }),
          )
        case 'languageDiagnostics':
          return reply(await language.diagnostics(document), (snapshot) => ({
            value: proposed({ type: 'languageDiagnostics', ...snapshot }),
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
