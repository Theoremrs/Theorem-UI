// SOURCING: none — thin mapping from the wire's run effects to ./run (the owner): one owner call per effect, the owner's answer reshaped to the wire's payload and nothing else
import { reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { CompletionPayload } from '../wire'
import type { RunState, Runner } from './run'

/**
 * A poll's answer, which the wire does not carry yet (`runStarted` is its only run variant): the
 * `type` tag beside the struct's own fields, so the Rust side can add a struct of exactly this
 * shape. Until it does the tag is not one of `CompletionPayload`'s, which is why the cast sits here.
 */
export type RunStatePayload = { type: 'runState' } & RunState

export function createRunPort(runner: Runner): OwnerPort<Of<'run'>> {
  return {
    async perform(effect, requestId) {
      switch (effect.kind) {
        case 'runConfigure':
          return reply(await runner.configure({ requestId, ...effect.payload }))
        case 'runStart':
          return reply(
            await runner.start({ requestId, name: effect.payload.name }),
            ({ handle }) => ({
              value: { type: 'runStarted', handle } as const,
            }),
          )
        case 'runStop':
          return reply(
            await runner.stop({ requestId, handle: effect.payload.handle }),
          )
        case 'runPoll':
          return reply(
            await runner.poll({ requestId, handle: effect.payload.handle }),
            (state) => ({
              value: {
                type: 'runState',
                ...state,
              } as unknown as CompletionPayload,
            }),
          )
      }
    },
  }
}
