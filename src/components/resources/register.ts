// SOURCING: lib/resources/builtin (the first-slice providers over the real clients and the shipped open handlers) and ./record-preview-fields (the record preview renderer). One call at startup wires the whole resource layer; the shell's opener is added separately with registerOpenHost.
import { registerBuiltIns } from '@/lib/resources/builtin'
import { registerRecordPreview } from './record-preview-fields'

let removeAll: (() => void) | undefined

/**
 * Registers the shipped providers, open handlers and record preview once.
 * Calling it again is a no-op; the function it returns removes everything it
 * added, and the next call registers again.
 */
export function registerResourceLayer(): () => void {
  if (!removeAll) {
    const removes = [registerBuiltIns(), registerRecordPreview()]
    removeAll = () => {
      removes.forEach((remove) => remove())
      removeAll = undefined
    }
  }
  return removeAll
}
