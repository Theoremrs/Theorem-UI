import { expect, test } from 'bun:test'
import { drawsOwnHeader } from './index-surface'

test('only the built-in record views give up the header and its Customize', () => {
  const builtIn = (viewId: string) => ({ origin: 'default' as const, viewId })
  expect(drawsOwnHeader(builtIn('default:records'))).toBe(true)
  expect(drawsOwnHeader(builtIn('default:records:person'))).toBe(true)
  expect(drawsOwnHeader(builtIn('default:record:Person/person:noor'))).toBe(
    true,
  )
  // Everything, Atlas and the data model keep Customize.
  expect(drawsOwnHeader(builtIn('default:everything'))).toBe(false)
  expect(drawsOwnHeader(builtIn('default:atlas'))).toBe(false)
  expect(drawsOwnHeader(builtIn('default:data-model'))).toBe(false)
  // A saved view always keeps Edit, History, Pin and Archive.
  expect(
    drawsOwnHeader({ origin: 'user', viewId: 'default:records:person' }),
  ).toBe(false)
})
