// SOURCING: bun:test
import { describe, expect, test } from 'bun:test'
import { appCheckProblems, appCheckWords, appRevisionOf, APP_CHECK, APP_OPERATIONS } from './operations'
import { deliverScript, readFromHost } from './protocol'

describe('readFromHost', () => {
  test('reads each message the page sends', () => {
    expect(readFromHost('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(readFromHost('{"type":"height","height":412}')).toEqual({ type: 'height', height: 412 })
    expect(readFromHost('{"type":"checked","id":"a","answer":{"outcome":"applied"}}')).toEqual({
      type: 'checked',
      id: 'a',
      answer: { outcome: 'applied' },
    })
    expect(readFromHost('{"type":"call","id":"b","method":"documents.get","args":"{}"}')).toEqual({
      type: 'call',
      id: 'b',
      method: 'documents.get',
      args: '{}',
    })
  })

  test('ignores anything else', () => {
    expect(readFromHost('not json')).toBeUndefined()
    expect(readFromHost('{"type":"call","id":"b","method":"sessions.delete","args":"{}"}')).toBeUndefined()
    expect(readFromHost('{"type":"call","id":"b","method":"documents.get","args":{}}')).toBeUndefined()
    expect(readFromHost('{"type":"height","height":-1}')).toBeUndefined()
    expect(readFromHost('null')).toBeUndefined()
  })

  test('delivers a message as a call to the page', () => {
    expect(deliverScript('{"type":"ready"}')).toBe(
      'window.__theoremAppHost && window.__theoremAppHost({"type":"ready"}); true;',
    )
  })
})

describe('App parts', () => {
  const part = {
    artifactId: 'art-1',
    artifactKind: 'app',
    artifactRevision: 'rev-2',
    payload: { content: '<h1>Hi</h1>', title: 'Counter', documentId: 'doc-1', revision: { position: 3 } },
  }

  test('reads an App revision, bare or wrapped', () => {
    const expected = {
      artifactId: 'art-1',
      documentId: 'doc-1',
      title: 'Counter',
      html: '<h1>Hi</h1>',
      position: '3',
      revision: 'rev-2',
    }
    expect(appRevisionOf(part)).toEqual(expected)
    expect(appRevisionOf({ payload: part })).toEqual(expected)
  })

  test('leaves other artifacts and empty Apps alone', () => {
    expect(appRevisionOf({ ...part, artifactKind: 'document' })).toBeUndefined()
    expect(appRevisionOf({ ...part, payload: { ...part.payload, content: '' } })).toBeUndefined()
  })

  test('declares app.check as the web does', () => {
    expect(APP_OPERATIONS.map((operation) => operation.name)).toEqual([APP_CHECK])
    expect(APP_OPERATIONS[0]!.effect).toBe('read')
    expect(new TextEncoder().encode(APP_OPERATIONS[0]!.description).length).toBeLessThanOrEqual(1024)
  })
})

describe('App check words', () => {
  test('says a check is under way only while the run waits', () => {
    expect(appCheckWords({ state: 'pending' }, true)).toEqual({
      words: 'Checking the App',
      pending: true,
      wrong: false,
    })
    expect(appCheckWords({ state: 'pending' }, false).words).toBe('The App was not checked')
  })

  test('counts what a check found', () => {
    const found = {
      state: 'answered',
      receipt: {
        outcome: 'applied',
        result: {
          built: true,
          problems: [{ file: 'app.tsx', line: 4, column: 2, message: 'x is not defined' }],
        },
      },
    }
    expect(appCheckWords(found, false)).toEqual({
      words: 'Checked the App: 1 problem',
      pending: false,
      wrong: true,
    })
    expect(appCheckProblems(found)).toEqual(['app.tsx:4:2  x is not defined'])
    expect(
      appCheckWords(
        { state: 'answered', receipt: { outcome: 'applied', result: { built: true, problems: [] } } },
        false,
      ),
    ).toEqual({ words: 'Checked the App: no problems', pending: false, wrong: false })
  })
})
