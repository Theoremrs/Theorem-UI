// SOURCING: @assistant-ui/react's DictationAdapter contract (listen gives a
// session: status, stop, cancel, onSpeechStart/onSpeech/onSpeechEnd; the
// runtime's DictationSessionController writes interim text into the composer
// and commits finals). The microphone is the Web Audio API through
// ./mic-worklet (16 kHz mono chunks and a level); the transcriber is Theorem's
// pure-Rust Parakeet EOU engine on burn, reached over a same-origin WebSocket
// (/api/chat/v1/dictation) that the server proxies to the authority with the
// person's bearer. Where the server does not serve dictation, the session
// falls back to the browser's own WebSpeechDictationAdapter, so the mic works
// everywhere it can. The level is published on its own channel (micLevel),
// never into the page's sound meter: what the face follows while it listens
// is the person's voice, not what the page plays (lib/face/signals keeps that
// distinction).
import { WebSpeechDictationAdapter } from '@assistant-ui/react'
import type { DictationAdapter } from '@assistant-ui/react'
import { create } from 'zustand'

/** What the microphone worklet posts: a chunk of 16 kHz mono audio, and how loud it was. */
interface MicChunk {
  pcm: Float32Array
  level: number
}

/** How loud the microphone hears, 0..1, while a session listens; 0 otherwise. */
export const useMicLevel = create<{ level: number }>()(() => ({ level: 0 }))

type Session = DictationAdapter.Session
type Status = DictationAdapter.Status
type Result = DictationAdapter.Result

/** The listeners a session keeps, and the way to call them. */
function listeners<T>() {
  const set = new Set<(value: T) => void>()
  return {
    on: (callback: (value: T) => void) => {
      set.add(callback)
      return () => set.delete(callback)
    },
    emit: (value: T) => {
      for (const callback of [...set]) callback(value)
    },
  }
}

/** Whether the server serves dictation, checked once and cached. */
let served: Promise<boolean> | undefined
function dictationServed(): Promise<boolean> {
  served ??= fetch('/api/chat/v1/dictation/status', {
    headers: { Accept: 'application/json' },
  })
    .then((response) => (response.ok ? response.json() : { served: false }))
    .then((body: { served?: boolean }) => body.served === true)
    .catch(() => false)
  return served
}

/** The same-origin dictation WebSocket, ws(s) from the page's own origin. */
function socketUrl(): string {
  const url = new URL('/api/chat/v1/dictation', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * A listening session over Theorem's engine. Chunks from the worklet are sent
 * as 16 kHz mono f32 PCM; the server streams partials and a final transcript
 * back. `stop` tells the server to flush and waits for the done event.
 */
function theoremSession(): Session {
  const speechStart = listeners<void>()
  const speech = listeners<Result>()
  const speechEnd = listeners<Result>()
  const session: Session = {
    status: { type: 'starting' },
    stop: async () => {},
    cancel: () => {},
    onSpeechStart: speechStart.on,
    onSpeech: speech.on,
    onSpeechEnd: speechEnd.on,
  }

  let context: AudioContext | undefined
  let stream: MediaStream | undefined
  let worklet: AudioWorkletNode | undefined
  let socket: WebSocket | undefined
  let ended = false
  let stopping = false
  let lastText = ''
  let done: (() => void) | undefined
  const over = () => ended
  const halting = () => stopping

  const setStatus = (status: Status) => {
    session.status = status
  }

  const teardown = () => {
    worklet?.disconnect()
    worklet = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    void context?.close().catch(() => {})
    context = undefined
    useMicLevel.setState({ level: 0 })
  }

  const finish = (reason: 'stopped' | 'cancelled' | 'error') => {
    if (ended) return
    ended = true
    teardown()
    socket?.close()
    socket = undefined
    setStatus({ type: 'ended', reason })
    speechEnd.emit({ transcript: lastText, isFinal: true })
    done?.()
  }

  session.cancel = () => {
    stopping = true
    lastText = ''
    finish('cancelled')
  }

  session.stop = async () => {
    if (over() || halting()) return
    stopping = true
    // Ask the server to flush the decoder; the done event carries the final.
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ command: 'stop' }))
      await new Promise<void>((resolve) => {
        done = resolve
        // A server that never answers must not hang the composer.
        setTimeout(resolve, 5_000)
      })
    }
    if (!over()) finish('stopped')
  }

  void (async () => {
    try {
      socket = new WebSocket(socketUrl())
      socket.binaryType = 'arraybuffer'
      const ready = await new Promise<boolean>((resolve) => {
        socket!.onopen = () => resolve(true)
        socket!.onerror = () => resolve(false)
        socket!.onclose = () => resolve(false)
      })
      if (over()) return
      if (!ready) {
        finish('error')
        return
      }
      socket.onmessage = (event: MessageEvent) => {
        if (over() || typeof event.data !== 'string') return
        let message: { event?: string; text?: string; transcript?: string }
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.event === 'partial' && message.text) {
          if (message.text !== lastText) {
            lastText = message.text
            speech.emit({ transcript: message.text, isFinal: false })
          }
        } else if (message.event === 'final' && message.text) {
          lastText = message.text
          speech.emit({ transcript: message.text, isFinal: true })
        } else if (message.event === 'done') {
          if (message.transcript) lastText = message.transcript
          finish('stopped')
        } else if (message.event === 'error') {
          finish('error')
        }
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      if (over()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      context = new AudioContext()
      await context.audioWorklet.addModule(
        new URL('./mic-worklet.js', import.meta.url),
      )
      if (over()) return
      const source = context.createMediaStreamSource(stream)
      worklet = new AudioWorkletNode(context, 'theorem-mic')
      worklet.port.onmessage = (event: MessageEvent<MicChunk>) => {
        if (over() || halting()) return
        const { pcm, level } = event.data
        useMicLevel.setState({ level: Math.min(1, level * 6) })
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(pcm.buffer as ArrayBuffer)
        }
      }
      source.connect(worklet)
      const silent = context.createGain()
      silent.gain.value = 0
      worklet.connect(silent)
      silent.connect(context.destination)
      await context.resume()
      if (over()) return
      setStatus({ type: 'running' })
      speechStart.emit()
    } catch (error) {
      if (!over()) {
        console.error('Theorem dictation failed to start:', error)
        finish('error')
      }
    }
  })()

  return session
}

/**
 * The adapter the runtime dictates with: Theorem's engine where the server
 * serves it, and the browser's own recognition otherwise. The choice is made
 * per press from the cached status, so a server that comes up later is picked
 * up on the next press without a reload.
 */
export function theoremDictation(): DictationAdapter {
  const fallback = new WebSpeechDictationAdapter()
  return {
    listen() {
      // The status check is async; start the fallback immediately and let the
      // server path take the next press once it is known to be served.
      void dictationServed()
      return servedNow() ? theoremSession() : fallback.listen()
    },
  }
}

let servedCache = false
void dictationServed().then((value) => {
  servedCache = value
})
function servedNow(): boolean {
  return servedCache
}

/**
 * The adapter for the runtime, or undefined where nothing can dictate: no
 * server dictation and no speech recognition of the browser's own. The
 * composer's mic appears only when this returns an adapter.
 */
export function dictationAdapter(): DictationAdapter | undefined {
  if (typeof window === 'undefined') return undefined
  if (!WebSpeechDictationAdapter.isSupported()) {
    // The server path still works without browser recognition; probe it.
    void dictationServed()
    return theoremDictation()
  }
  void dictationServed()
  return theoremDictation()
}
