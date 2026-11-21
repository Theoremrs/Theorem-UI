// SOURCING: the Web Audio API's AudioWorkletProcessor (MDN): the microphone's
// blocks are resampled to the 16 kHz mono the model reads, gathered into
// chunks of about a fifth of a second, and posted to the page with how loud
// the block was. The resampling is a linear interpolation between the samples
// the block gives, which is enough for speech; the level is the block's RMS.
// Nothing here leaves the page: the chunks go to the transcriber in the page.
//
// Plain JavaScript, not TypeScript: Vite hands audioWorklet.addModule the
// file's own text as a data URL, and the worklet's global scope parses no
// types. The shape of what it posts is MicChunk in ./dictation.

const RATE = 16000
// About a fifth of a second a chunk: long enough to hold a syllable, short
// enough to feel live.
const CHUNK = 3200

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pending = new Float32Array(CHUNK)
    this.held = 0
    // Where the next output sample sits among the input samples, carried
    // across blocks.
    this.position = 0
    // The last input sample of the previous block: the first output sample
    // of this block may fall between it and this block's first sample.
    this.previous = 0
    this.primed = false
    this.energy = 0
    this.counted = 0
    this.port.onmessage = (event) => {
      if (event.data && event.data.command === 'flush') this.flush(true)
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true
    const ratio = sampleRate / RATE
    for (const sample of input) {
      this.energy += sample * sample
      this.counted++
    }
    // Each output sample is drawn between the two input samples it falls
    // between. `position` is measured from this block's first sample and
    // carries its fraction across blocks (it can be negative at the seam).
    // The sample just before index 0 is the previous block's last sample,
    // so the seam interpolates real audio instead of a false zero.
    while (this.position < input.length - 1) {
      const whole = Math.floor(this.position)
      const fraction = this.position - whole
      const from = whole < 0 ? this.previous : input[whole]
      const to = input[whole + 1]
      this.pending[this.held++] = from + (to - from) * fraction
      if (this.held === CHUNK) this.flush()
      this.position += ratio
    }
    this.position -= input.length
    this.previous = input[input.length - 1]
    this.primed = true
    return true
  }

  flush(final = false) {
    if (final && this.held === 0) return
    const level = this.counted ? Math.sqrt(this.energy / this.counted) : 0
    const pcm = final ? this.pending.slice(0, this.held) : this.pending
    this.port.postMessage({ pcm, level, final }, [pcm.buffer])
    this.pending = new Float32Array(CHUNK)
    this.held = 0
    this.energy = 0
    this.counted = 0
  }
}

registerProcessor('theorem-mic', MicProcessor)
