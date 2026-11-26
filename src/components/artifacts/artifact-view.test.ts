// SOURCING: none — bun:test over ./artifact-view's store, with no dock attached
import { beforeEach, describe, expect, test } from 'bun:test'
import { shownRevision, useArtifactView, viewOf } from './artifact-view'

const store = () => useArtifactView.getState()
const view = (artifactId: string) => viewOf(store().views, artifactId)

beforeEach(() => {
  useArtifactView.setState({ threadId: undefined, dock: undefined })
  store().reset()
})

describe('artifact view state', () => {
  test('an unopened artifact follows the newest revision, and reads the same each time', () => {
    expect(view('a')).toBe(view('a'))
    expect(view('a').follow).toBe(true)
    expect(shownRevision(view('a'))).toBeUndefined()
  })

  test('following, the chosen revision and keeping open are separate choices', () => {
    useArtifactView.setState({ threadId: 't1' })
    store().open('a')
    expect(view('a')).toEqual({
      threadId: 't1',
      follow: true,
      revision: undefined,
      keep: false,
    })
    store().select('a', 'r1')
    expect(view('a').follow).toBe(false)
    expect(shownRevision(view('a'))).toBe('r1')
    store().keep('a', true)
    expect(shownRevision(view('a'))).toBe('r1')
    store().select('a', undefined)
    expect(view('a')).toMatchObject({ follow: true, keep: true })
  })

  test('a view keeps the conversation it opened in', () => {
    useArtifactView.setState({ threadId: 't1' })
    store().open('a')
    useArtifactView.setState({ threadId: 't2' })
    store().select('a', 'r2')
    expect(view('a').threadId).toBe('t1')
  })

  test('changing chats keeps only the views kept open', () => {
    useArtifactView.setState({ threadId: 't1' })
    store().open('a')
    store().open('b')
    store().keep('b', true)
    store().changedChat('t2')
    expect(store().views.a).toBeUndefined()
    expect(store().views.b).toMatchObject({ threadId: 't1', keep: true })
    expect(store().openId).toBe('b')
    expect(store().threadId).toBe('t2')
  })

  test('closing a panel forgets its view', () => {
    store().open('a', 'r1')
    store().closed('a')
    expect(store().views.a).toBeUndefined()
    expect(store().openId).toBeUndefined()
  })

  test('keeping open is recorded on the dock panel too', () => {
    const kept: [string, boolean][] = []
    useArtifactView.setState({
      dock: {
        open: () => {},
        expand: () => {},
        close: () => {},
        kept: (artifactId, keep) => kept.push([artifactId, keep]),
      },
    })
    store().keep('a', true)
    expect(kept).toEqual([['a', true]])
  })
})
