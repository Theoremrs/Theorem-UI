// SOURCING: none — thin mapping from the wire's search effects to ./search (the owner): one owner call per effect, and the owner's pages pushed to the adapter as host messages
import { reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { Search } from './search'

export function createSearchPort(search: Search): OwnerPort<Of<'search'>> {
  return {
    async perform(effect, requestId) {
      switch (effect.kind) {
        case 'searchQuery':
          return reply(
            await search.query({ requestId, ...effect.payload }),
            ({ id }) => ({ value: { type: 'searchStarted', id } as const }),
          )
        case 'searchCancel':
          return reply(
            await search.cancel({ requestId, id: effect.payload.id }),
          )
      }
    },
    subscribe: (listener) =>
      search.onPage((page) => listener({ type: 'searchPage', ...page })),
  }
}
