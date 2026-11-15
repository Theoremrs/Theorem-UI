// SOURCING: none — thin mapping from the wire's run effects to ./run (the owner): one owner call per effect, the owner's answer reshaped to the wire's payload and nothing else
import { reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { Runner } from './run'

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
        case 'runList':
          return reply(await runner.list({ requestId }), (runs) => ({
            value: { type: 'runList', runs } as const,
          }))
        case 'runPoll':
          return reply(
            await runner.poll({ requestId, handle: effect.payload.handle }),
            (state) => ({ value: { type: 'runState', ...state } as const }),
          )
      }
    },
  }
}
