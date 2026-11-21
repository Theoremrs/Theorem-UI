// SOURCING: none: three lines of arithmetic. JavaScript's bitwise operators
// work on signed 32-bit integers and take shift counts modulo 32, so a 32-bit
// or wider value cannot go through them.

/** The widest number a part computes exactly: a JavaScript number holds 53 bits. */
export const MAX_BITS = 53

/** `bits`, checked: a whole number from 1 to MAX_BITS, or a RangeError naming `part`. */
export function widthOf(bits: number, part: string): number {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_BITS)
    throw new RangeError(`${part}: bits must be a whole number from 1 to ${MAX_BITS}, not ${bits}`)
  return bits
}

/** `value` as an unsigned `bits`-wide number: wrapped, with what is not a number read as 0. */
export function wrap(value: unknown, bits: number): number {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return 0
  const span = 2 ** bits
  // Only a negative remainder is brought back into range with the span: at the
  // widest supported width the span is 2**53, and adding it to an already
  // nonnegative remainder asks for an integer no JavaScript number holds
  // exactly, so odd values come back rounded. `+ 0` turns the minus zero a
  // negative zero leaves into the zero this range starts at.
  const remainder = number % span
  return remainder < 0 ? remainder + span : remainder + 0
}

/** Bit `index` of an unsigned number, 0 or 1. */
export function bitAt(value: number, index: number): number {
  return Math.floor(value / 2 ** index) % 2
}
