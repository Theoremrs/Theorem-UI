// SOURCING: none — thin mapping from the wire's delegation effects to ./delegations (the owner): one owner call per effect; the change words pass through as the owner says them (add, modify, delete), since the wire's `change` is a free string
import { refusal, reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { Delegations } from './delegations'

export function createDelegationsPort(
  delegations: Pick<Delegations, 'changes' | 'content'>,
): OwnerPort<Of<'delegation'>> {
  return {
    async perform(effect, requestId) {
      const { resource, payload } = effect
      if (
        resource.type !== 'delegation' ||
        resource.runId !== payload.runId ||
        resource.delegationId !== payload.delegationId
      )
        return refusal(
          'wrong_resource',
          'A delegation effect names the delegation its resource is bound to',
        )
      switch (effect.kind) {
        case 'delegationChanges':
          return reply(
            await delegations.changes(payload, { requestId }),
            (changes) => ({ value: { type: 'delegationChanges', changes } }),
          )
        case 'delegationContent':
          return reply(
            await delegations.content(effect.payload, { requestId }),
            ({ text }) => ({ value: { type: 'delegationText', text } }),
          )
      }
    },
  }
}
