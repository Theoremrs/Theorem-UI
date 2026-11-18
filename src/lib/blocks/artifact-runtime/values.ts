// SOURCING: none: exact signal values (types.ts) from what an engine hands
// over, and back. Nothing passes through a float that a value does not
// already live in: bigints and integer text stay exact at any width.
import type { IntegerText, SignalDescriptor, SignalValue } from './types'

/** A `bits` signal value. */
export type BitsValue = Extract<SignalValue, { type: 'bits' }>

const INTEGER = /^-?(?:0|[1-9]\d*)$/
const NATURAL = /^(?:0|[1-9]\d*)$/
const HEX = /^[0-9a-f]+$/

/** Whether `text` is decimal integer text with no sign. */
export const isIntegerText = (text: unknown): text is IntegerText =>
  typeof text === 'string' && NATURAL.test(text)

/** A count or index as integer text. A number that is not a safe non-negative integer is refused. */
export function integerText(value: number | bigint | string): IntegerText {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${value} is negative`)
    return value.toString()
  }
  if (typeof value === 'string') {
    if (!isIntegerText(value))
      throw new RangeError(`${JSON.stringify(value)} is not integer text`)
    return value
  }
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${value} is not a safe non-negative integer`)
  return String(value)
}

const digits = (width: number) => Math.max(1, Math.ceil(width / 4))

/**
 * A `width`-bit value as bits. A negative value is written in two's
 * complement; a value that does not fit is refused rather than wrapped, so a
 * mistaken width is a visible error.
 */
export function bitsOf(
  value: bigint | number,
  width: number,
  signed = false,
): BitsValue {
  if (!Number.isInteger(width) || width < 1)
    throw new RangeError(`Width ${width} is not a positive integer`)
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError(`${value} is not a safe integer; pass a bigint`)
  const big = BigInt(value)
  const span = 1n << BigInt(width)
  const low = signed ? -(span >> 1n) : 0n
  const high = signed ? (span >> 1n) - 1n : span - 1n
  if (big < low || big > high)
    throw new RangeError(
      `${big} does not fit ${signed ? 'signed' : 'unsigned'} ${width} bits`,
    )
  const raw = big < 0n ? big + span : big
  return {
    type: 'bits',
    width,
    hex: raw.toString(16).padStart(digits(width), '0'),
  }
}

/** The bits' value as a bigint: unsigned, or two's complement when `signed`. */
export function bitsValue(value: BitsValue, signed = false): bigint {
  if (!HEX.test(value.hex))
    throw new RangeError(`${JSON.stringify(value.hex)} is not lowercase hex`)
  const raw = BigInt(`0x${value.hex}`)
  const span = 1n << BigInt(value.width)
  if (raw >= span)
    throw new RangeError(`0x${value.hex} does not fit ${value.width} bits`)
  return signed && raw >= span >> 1n ? raw - span : raw
}

/** An integer of any size, exactly. */
export function integerOf(value: bigint | number | string): SignalValue {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError(
      `${value} is not a safe integer; pass a bigint or text`,
    )
  const text = typeof value === 'string' ? value : BigInt(value).toString()
  if (!INTEGER.test(text))
    throw new RangeError(`${JSON.stringify(text)} is not an integer`)
  return { type: 'integer', text }
}

/**
 * What an engine value is, read with its descriptor when there is one and by
 * its JavaScript type when not. A number that is not an integer is `real`; a
 * bigint is never narrowed to a number.
 */
export function signalValue(
  value: unknown,
  descriptor?: Pick<SignalDescriptor, 'type' | 'width' | 'signed' | 'unit'>,
): SignalValue {
  if (descriptor?.type === 'bits') {
    if (
      typeof value !== 'bigint' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    )
      throw new TypeError(`A bits signal needs an integer, not ${typeof value}`)
    return bitsOf(
      typeof value === 'boolean' ? Number(value) : value,
      descriptor.width ?? 1,
      descriptor.signed,
    )
  }
  if (descriptor?.type === 'integer')
    return integerOf(value as bigint | number | string)
  if (descriptor?.type === 'bool')
    return { type: 'bool', value: Boolean(value) }
  if (descriptor?.type === 'text') return { type: 'text', text: String(value) }
  if (descriptor?.type === 'real')
    return { type: 'real', value: Number(value), unit: descriptor.unit }
  if (typeof value === 'bigint') return integerOf(value)
  if (typeof value === 'boolean') return { type: 'bool', value }
  if (typeof value === 'number')
    return Number.isSafeInteger(value)
      ? integerOf(value)
      : { type: 'real', value }
  if (typeof value === 'string') return { type: 'text', text: value }
  try {
    // JSON.stringify gives undefined for a function, whatever its type says.
    const json: string | undefined = JSON.stringify(value)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return { type: 'text', text: json ?? String(value) }
  } catch {
    return { type: 'text', text: String(value) }
  }
}

/** A value as a person reads it: `0x0c (12)`, `12`, `true`. */
export function signalText(value: SignalValue): string {
  switch (value.type) {
    case 'bits': {
      const unsigned = bitsValue(value)
      return value.width === 1
        ? unsigned.toString()
        : `0x${value.hex} (${unsigned})`
    }
    case 'integer':
      return value.text
    case 'real':
      return value.unit ? `${value.value} ${value.unit}` : String(value.value)
    case 'text':
      return value.text
    case 'bool':
      return String(value.value)
  }
}
