// SOURCING: none — thin mapping from the wire's search effects to ./search (the owner): one owner call per effect, and the owner's pages pushed to the adapter as host messages
import { reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { HostMessage } from '../wire'
import type { Search, SearchPage } from './search'

/**
 * A page of results, which the wire's `HostMessage` does not carry yet (a search's only wire
 * answer is `searchStarted {id}`): the `type` tag beside the page's own fields, so the Rust side
 * can add a variant of exactly this shape. Until it does the tag is not one of `HostMessage`'s,
 * which is why the cast sits here.
 */
export type SearchPageMessage = { type: 'searchPage' } & SearchPage

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
      search.onPage((page) =>
        listener({ type: 'searchPage', ...page } as unknown as HostMessage),
      ),
  }
}
