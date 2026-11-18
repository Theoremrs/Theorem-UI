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
    this.energy = 0
    this.counted = 0
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
    // between; the position carries its fraction into the next block.
    while (this.position < input.length - 1) {
      const whole = Math.floor(this.position)
      const fraction = this.position - whole
      const from = input[whole] ?? 0
      const to = input[whole + 1] ?? from
      this.pending[this.held++] = from + (to - from) * fraction
      if (this.held === CHUNK) this.flush()
      this.position += ratio
    }
    this.position -= input.length
    return true
  }

  flush() {
    const level = this.counted ? Math.sqrt(this.energy / this.counted) : 0
    this.port.postMessage({ pcm: this.pending, level }, [this.pending.buffer])
    this.pending = new Float32Array(CHUNK)
    this.held = 0
    this.energy = 0
    this.counted = 0
  }
}

registerProcessor('theorem-mic', MicProcessor)
