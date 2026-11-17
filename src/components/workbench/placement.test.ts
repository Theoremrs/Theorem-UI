import { describe, expect, test } from 'bun:test'
import {
  dockPresentation,
  placementOf,
  sheetShown,
  toggledPlacement,
} from './placement'

describe('placementOf', () => {
  test('with no choice, the delivery switch puts the workbench full screen in chat mode only', () => {
    expect(placementOf(undefined, true, 'chat')).toBe('full')
    expect(placementOf(undefined, true, 'notes')).toBeUndefined()
    expect(placementOf(undefined, false, 'chat')).toBeUndefined()
  })

  test('a chosen side or bottom placement holds in every mode, beside that mode', () => {
    expect(placementOf('side', false, 'chat')).toBe('side')
    expect(placementOf('bottom', true, 'chat')).toBe('bottom')
    expect(placementOf('side', false, 'ide')).toBe('side')
  })

  test('full replaces only the conversation: elsewhere it is not drawn', () => {
    expect(placementOf('full', false, 'chat')).toBe('full')
    expect(placementOf('full', false, 'vault')).toBeUndefined()
  })

  test('closed wins over the switch', () => {
    expect(placementOf('closed', true, 'chat')).toBeUndefined()
  })
})

describe('toggledPlacement', () => {
  test('toggling opens the placement last used beside the conversation, and closes it again', () => {
    expect(toggledPlacement(undefined, 'bottom')).toBe('bottom')
    expect(toggledPlacement('bottom', 'bottom')).toBe('closed')
    expect(toggledPlacement('side', 'side')).toBe('closed')
  })

  test('asking for the other placement moves it there instead of closing', () => {
    expect(toggledPlacement('side', 'side', 'bottom')).toBe('bottom')
    expect(toggledPlacement('bottom', 'bottom', 'bottom')).toBe('closed')
  })

  test('from full screen, a toggle brings the conversation back beside it', () => {
    expect(toggledPlacement('full', 'side')).toBe('side')
  })
})

describe('sheetShown', () => {
  test('from full screen, the workbench moves beside the conversation so the sheet behind it shows', () => {
    expect(sheetShown('full', 'bottom')).toBe('bottom')
  })

  test('anywhere else the sheet already shows, so nothing moves', () => {
    expect(sheetShown('side', 'bottom')).toBeUndefined()
    expect(sheetShown('bottom', 'side')).toBeUndefined()
    expect(sheetShown(undefined, 'side')).toBeUndefined()
  })
})

describe('dockPresentation', () => {
  test('a side dock that cannot leave both minimums becomes a bottom dock', () => {
    expect(dockPresentation('side', 390)).toBe('bottom')
    expect(dockPresentation('side', 779)).toBe('bottom')
    expect(dockPresentation('side', 780)).toBe('side')
    expect(dockPresentation('bottom', 390)).toBe('bottom')
    expect(dockPresentation('full', 390)).toBe('full')
    expect(dockPresentation(undefined, 390)).toBeUndefined()
  })
})
