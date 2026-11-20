// SOURCING: assistant-ui elements-composer's ComposerVoice (the mic morphs
// the input into a live waveform, then the transcript lands as text), shaped
// to Theorem's ink tokens and driven by the real microphone level
// (lib/speech/dictation's micLevel) instead of a synthetic sine. The runtime
// state decides the phase: running shows the waveform and elapsed time;
// stopped shows the transcribing shimmer until the final transcript commits.
import { useAuiState } from '@assistant-ui/react'
import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import { ShimmerLabel } from '@/components/assistant-ui/elements/surfaces'
import { useMicLevel } from '@/lib/speech/dictation'
import { cn } from '@/lib/utils'

const BARS = Array.from({ length: 14 }, (_, index) => index)

/** Each bar hears the microphone with its own weight, so the wave reads as
 *  one voice across the row rather than fourteen identical meters. */
const WEIGHTS = BARS.map(
  (bar) => 0.35 + 0.65 * Math.abs(Math.sin((bar + 1) * 1.7)),
)

function barHeight(bar: number, level: number, tick: number): number {
  const sway = 0.75 + 0.25 * Math.sin(bar * 1.35 + tick * 0.9)
  return 3 + level * WEIGHTS[bar]! * sway * 17
}

/** Elapsed listening time, ticking while the session runs. */
function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState({ active: false, seconds: 0 })
  useEffect(() => {
    if (!active) return
    const started = Date.now()
    const timer = setInterval(
      () =>
        setElapsed({
          active: true,
          seconds: Math.floor((Date.now() - started) / 1000),
        }),
      250,
    )
    return () => clearInterval(timer)
  }, [active])
  // A fresh session reads zero until its first tick; the reset is derived from
  // `active` rather than a synchronous setState in the effect.
  return active && elapsed.active ? elapsed.seconds : 0
}

export function ComposerVoice({ className, ...props }: ComponentProps<'div'>) {
  const dictation = useAuiState((state) => state.composer.dictation)
  const level = useMicLevel((state) => state.level)
  const recording = dictation?.status.type === 'running'
  const seconds = useElapsed(recording)
  if (dictation == null) return null
  const minutes = Math.floor(seconds / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return (
    <div
      data-slot="composer-voice"
      data-recording={recording || undefined}
      className={cn('flex min-h-11 items-center gap-3 ps-3', className)}
      {...props}
    >
      {recording && (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-focus"
        />
      )}
      <div className="flex h-6 items-center gap-[3px]" aria-hidden>
        {BARS.map((bar) => (
          <span
            key={bar}
            className={cn(
              'w-0.5 rounded-full transition-[height,background-color] duration-150 motion-reduce:transition-none',
              recording ? 'bg-ink/60' : 'bg-ink/25',
            )}
            style={{
              height: recording ? barHeight(bar, level, seconds * 4) : 3,
            }}
          />
        ))}
      </div>
      {recording ? (
        <span className="text-ink-muted text-[13px] tabular-nums">
          {minutes}:{rest}
        </span>
      ) : (
        <ShimmerLabel className="text-ink-muted relative text-[13px]">
          Transcribing
        </ShimmerLabel>
      )}
      <span className="sr-only" role="status">
        {recording ? 'Listening' : 'Transcribing your voice'}
      </span>
    </div>
  )
}
