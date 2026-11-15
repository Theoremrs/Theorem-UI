// SOURCING: none — tests for workbench-switch.
import { describe, expect, test } from 'bun:test'
import { workbenchEnabled } from './workbench-switch'

const storage = (value: string | null) => ({ getItem: () => value })

describe('workbenchEnabled', () => {
  test('is off with neither the query nor the stored flag', () => {
    expect(workbenchEnabled('', storage(null))).toBe(false)
    expect(workbenchEnabled('?a=1', undefined)).toBe(false)
  })

  test('the query turns it on', () => {
    expect(workbenchEnabled('?workbench=1', storage(null))).toBe(true)
    expect(workbenchEnabled('?x=2&workbench=1', undefined)).toBe(true)
  })

  test('the stored flag turns it on, and only the value 1', () => {
    expect(workbenchEnabled('', storage('1'))).toBe(true)
    expect(workbenchEnabled('', storage('true'))).toBe(false)
    expect(workbenchEnabled('?workbench=0', storage('0'))).toBe(false)
  })

  test('a storage that throws is off', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(workbenchEnabled('', blocked)).toBe(false)
    expect(workbenchEnabled('?workbench=1', blocked)).toBe(true)
  })
})
