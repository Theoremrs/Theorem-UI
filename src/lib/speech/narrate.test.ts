// SOURCING: bun:test over lib/speech/narrate's chunker and narrator, with a provider and a player the test supplies: no model is fetched and nothing is played.
import { describe, expect, test } from 'bun:test'
import type { Playback, PlaybackEnding, Stream } from '@/lib/sound/graph'
import { narrate, sentences } from './narrate'
import type { SpeechProvider } from './provider'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('sentences', () => {
  test('takes only complete sentences and says where to look next', () => {
    const text = 'The table is contained now. The composer sits below it and'
    const { pieces, next } = sentences(text, 0)
    expect(pieces).toEqual(['The table is contained now.'])
    expect(text.slice(next)).toBe(' The composer sits below it and')
  })

  test('keeps short sentences together until they are worth speaking', () => {
    const { pieces } = sentences('Yes. It works. And the rest of this follows on. ', 0)
    expect(pieces).toEqual(['Yes. It works. And the rest of this follows on.'])
  })

  test('waits for an open code fence to close', () => {
    const open = 'Here is the change below.\n```ts\nconst a = 1.\n'
    expect(sentences(open, 0).pieces).toEqual(['Here is the change below.'])
    const closed = open + '```\nThat was all of it, nothing more.\n'
    const { pieces } = sentences(closed, sentences(open, 0).next)
    expect(pieces.join('')).toContain('```ts')
    expect(pieces.join('')).toContain('That was all of it')
  })
})

describe('narrate', () => {
  test('speaks each sentence as it arrives, in order, as one stream', async () => {
    const asked: string[] = []
    const speaker: SpeechProvider = {
      id: 'test',
      name: 'test',
      keyed: false,
      speak: async (text) => {
        asked.push(text)
        const n = asked.length
        async function* blocks() {
          yield new Float32Array(4).fill(n)
        }
        return { sampleRate: 24_000, blocks: blocks() }
      },
    }
    const heard: number[] = []
    let plays = 0
    const sound = {
      play: (stream: Stream): Playback => {
        plays++
        let settle: (ending: PlaybackEnding) => void = () => {}
        const done = new Promise<PlaybackEnding>((resolve) => (settle = resolve))
        void (async () => {
          for await (const block of stream.blocks) heard.push(block[0] ?? 0)
          settle('finished')
        })()
        return { done, started: () => true, cancel: () => settle('cancelled') }
      },
    }
    const narration = narrate(() => speaker, sound)
    narration.feed('The first sentence of the reply is here.')
    await tick()
    narration.feed(
      'The first sentence of the reply is here. A second one follows it now. And a tail',
    )
    await tick()
    narration.finish()
    for (let i = 0; i < 10; i++) await tick()
    expect(asked).toEqual([
      'The first sentence of the reply is here.',
      'A second one follows it now.',
      'And a tail',
    ])
    expect(plays).toBe(1)
    expect(heard).toEqual([1, 2, 3])
  })

  test('stopping ends it and nothing more is asked for', async () => {
    const asked: string[] = []
    const speaker: SpeechProvider = {
      id: 'test',
      name: 'test',
      keyed: false,
      speak: async (text) => {
        asked.push(text)
        async function* blocks() {
          yield new Float32Array(1)
        }
        return { sampleRate: 24_000, blocks: blocks() }
      },
    }
    const sound = {
      play: (): Playback => ({
        done: new Promise(() => {}),
        started: () => true,
        cancel: () => {},
      }),
    }
    const narration = narrate(() => speaker, sound)
    narration.stop()
    narration.feed('This sentence comes after the stop was pressed.')
    await tick()
    expect(asked).toEqual([])
  })
})
