// SOURCING: zustand + zustand/middleware persist for the preference (as lib/figures keeps Theo's); the provider seam (./provider) and the page's one sound graph (lib/sound/graph), whose gapless scheduling plays every sentence as one stream, so the meter hears one sound and Theo holds the boombox form from the first sentence to the last. Splitting at sentence ends while text streams is the usual streaming-TTS shape (ElevenLabs' and OpenAI's realtime guides both chunk by sentence); the chunker is this app's, a few rules over the text, with ./speakable doing the reading.
import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Playback, Stream } from '@/lib/sound/graph'
import { claimVoice, pageSound, useVoice } from './adapter'
import type { Sound } from './adapter'
import type { SpeechProvider } from './provider'
import { speakable } from './speakable'

/** Whether Theo narrates a reply while it streams in. Off unless the person turns it on. */
export const useNarration = create<{
  live: boolean
  setLive: (live: boolean) => void
}>()(
  persist(
    (set) => ({ live: false, setLive: (live) => set({ live }) }),
    { name: 'theorem-ui:narration' },
  ),
)

/** The fewest characters a piece is cut at; shorter sentences wait for the next. */
const LEAST = 24

/**
 * The complete sentences in `text` after `from`: the pieces ready to be
 * spoken, and where the next look should start. A sentence ends at `.`, `!`
 * or `?` before a space, or at a line break. Nothing inside a code fence
 * that is still open is taken, since its end has not arrived.
 */
export function sentences(
  text: string,
  from: number,
): { pieces: string[]; next: number } {
  const pieces: string[] = []
  let start = from
  const fenced = (end: number) =>
    (text.slice(0, end).match(/^(```|~~~)/gm)?.length ?? 0) % 2 === 1
  const ends = /([.!?]["')\]]?)(?=\s)|\n/g
  ends.lastIndex = from
  for (let match = ends.exec(text); match; match = ends.exec(text)) {
    const end = match.index + match[0].length
    if (fenced(end)) continue
    const piece = text.slice(start, end)
    if (piece.trim().length < LEAST && match[0] !== '\n') continue
    if (piece.trim() !== '') pieces.push(piece)
    start = end
  }
  return { pieces, next: start }
}

/** Something narrating one reply. */
export interface Narration {
  /** The reply's text so far; what is new and complete is spoken. */
  feed: (text: string) => void
  /** The reply is complete: speak what is left, then stop. */
  finish: () => void
  /** Stop now. */
  stop: () => void
}

/**
 * Narrates a reply as it arrives. Sentences are turned to speech one after
 * another (the next is made while the one before plays) and played as one
 * stream through the page's sound graph.
 */
export function narrate(
  provider: () => SpeechProvider = () => useVoice.getState().provider,
  sound: Sound = pageSound,
): Narration {
  const abort = new AbortController()
  const queue: string[] = []
  let cursor = 0
  let latest = ''
  let finished = false
  let wake = () => {}
  let playback: Playback | undefined
  const release = claimVoice(() => stop())

  const make = (piece: string): Promise<Stream> | undefined => {
    const words = speakable(piece)
    if (words === '') return undefined
    return provider().speak(words, {
      signal: abort.signal,
      onFetching: (fetching) => useVoice.setState({ fetching }),
    })
  }

  /** The next piece's speech, waiting for text when there is none yet. */
  const nextStream = async (): Promise<Stream | undefined> => {
    for (;;) {
      if (abort.signal.aborted) return undefined
      const piece = queue.shift()
      if (piece !== undefined) {
        const made = make(piece)
        if (made) return made
        continue
      }
      if (finished) return undefined
      await new Promise<void>((resolve) => (wake = resolve))
    }
  }

  // Read through a call: the signal can abort between awaits, which a
  // narrowed property read would not see.
  const stopped = () => abort.signal.aborted

  async function* blocks(first: Stream): AsyncGenerator<Float32Array> {
    let current: Stream | undefined = first
    let coming = nextStream()
    while (current && !stopped()) {
      for await (const block of current.blocks) {
        if (stopped()) return
        yield block
      }
      current = await coming
      if (current) coming = nextStream()
    }
  }

  const begin = async () => {
    try {
      const first = await nextStream()
      if (!first || abort.signal.aborted) return
      playback = sound.play(
        { sampleRate: first.sampleRate, blocks: blocks(first) },
        { signal: abort.signal },
      )
      await playback.done
    } catch (error) {
      if (!abort.signal.aborted)
        console.warn('The reply could not be narrated.', error)
    } finally {
      useVoice.setState({ fetching: undefined })
      release()
    }
  }

  const take = () => {
    const { pieces, next } = sentences(latest, cursor)
    cursor = next
    if (pieces.length) {
      queue.push(...pieces)
      wake()
    }
  }

  function stop() {
    if (abort.signal.aborted) return
    abort.abort()
    playback?.cancel()
    wake()
    release()
  }

  void begin()
  return {
    feed(text) {
      if (finished || abort.signal.aborted) return
      latest = text
      take()
    },
    finish() {
      if (finished) return
      take()
      const rest = latest.slice(cursor)
      if (rest.trim()) queue.push(rest)
      cursor = latest.length
      finished = true
      wake()
    },
    stop,
  }
}

/** What narration reads of a thread: its messages and whether a run is going. */
interface NarratedThread {
  thread: {
    getState: () => {
      messages: ReadonlyArray<{
        id: string
        role: string
        content: ReadonlyArray<{ type: string; text?: string }>
      }>
      isRunning: boolean
    }
    subscribe: (listener: () => void) => () => void
  }
}

/**
 * Narrates the reply streaming into a thread while the person has live
 * narration on and the thread is the one on screen. Turning it off, moving
 * to another thread or leaving stops it at once.
 */
export function useNarrateReplies(
  runtime: NarratedThread,
  onScreen: () => boolean,
  subscribe: (listener: () => void) => () => void,
) {
  useEffect(
    () => narrateReplies(runtime, onScreen, subscribe),
    [runtime, onScreen, subscribe],
  )
}

/**
 * What useNarrateReplies runs: follows the thread and returns what ends it.
 * A finished reply keeps its narration, since finishing only queues the rest
 * of its speech: turning narration off, moving away or leaving still stops
 * what is playing.
 */
export function narrateReplies(
  runtime: NarratedThread,
  onScreen: () => boolean,
  subscribe: (listener: () => void) => () => void,
  start: () => Narration = narrate,
): () => void {
  let current: { id: string; narration: Narration } | undefined
  const check = () => {
    const { messages, isRunning } = runtime.thread.getState()
    const last = messages.at(-1)
    if (!useNarration.getState().live || !onScreen()) {
      current?.narration.stop()
      current = undefined
      return
    }
    if (last?.role !== 'assistant') return
    const text = last.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n\n')
    if (isRunning) {
      if (current?.id !== last.id) {
        current?.narration.stop()
        current = { id: last.id, narration: start() }
      }
      current.narration.feed(text)
    } else if (current?.id === last.id) {
      // Both are no-ops once the narration has finished.
      current.narration.feed(text)
      current.narration.finish()
    }
  }
  const stops = [
    runtime.thread.subscribe(check),
    useNarration.subscribe(check),
    subscribe(check),
  ]
  return () => {
    for (const stop of stops) stop()
    current?.narration.stop()
  }
}
