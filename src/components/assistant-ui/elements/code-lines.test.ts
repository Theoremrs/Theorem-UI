import { expect, test } from 'bun:test'
import { diffLines, fenceTitle, plainLines } from './code-lines'

test('plain code numbers every row from one', () => {
  expect(plainLines('a\nb\n\n')).toEqual({
    text: 'a\nb',
    lines: [{ number: 1 }, { number: 2 }],
  })
})

test('a unified diff reads as the new file, numbered as it numbers', () => {
  const read = diffLines(
    [
      'diff --git a/terminal/src/command.rs b/terminal/src/command.rs',
      'index 1111111..2222222 100644',
      '--- a/terminal/src/command.rs',
      '+++ b/terminal/src/command.rs',
      '@@ -10,3 +10,3 @@ impl Command {',
      '     let a = 1;',
      '-    let b = 2;',
      '+    let b = 3;',
      '     a + b',
    ].join('\n'),
  )
  expect(read.path).toBe('terminal/src/command.rs')
  expect(read.language).toBe('rs')
  expect(read.text.split('\n')).toEqual([
    '@@ -10,3 +10,3 @@ impl Command {',
    '    let a = 1;',
    '    let b = 2;',
    '    let b = 3;',
    '    a + b',
  ])
  expect(read.lines).toEqual([
    { change: 'hunk' },
    { number: 10 },
    { change: 'remove' },
    { number: 11, change: 'add' },
    { number: 12 },
  ])
})

test('a hunk whose counts disagree with its header still reads', () => {
  const read = diffLines('@@ -1,9 +5,9 @@\n a\n-b\n+c')
  expect(read.lines).toEqual([
    { change: 'hunk' },
    { number: 5 },
    { change: 'remove' },
    { number: 6, change: 'add' },
  ])
})

test('bare added and removed lines number from one', () => {
  const read = diffLines('-old\n+new\n same')
  expect(read.path).toBeUndefined()
  expect(read.text).toBe('old\nnew\nsame')
  expect(read.lines).toEqual([
    { change: 'remove' },
    { number: 1, change: 'add' },
    { number: 2 },
  ])
})

test('a fence names its file by attribute or by a path-like word', () => {
  expect(fenceTitle('title="src/a.ts"')).toBe('src/a.ts')
  expect(fenceTitle("file='b.rs' {1,3}")).toBe('b.rs')
  expect(fenceTitle('src/lib/c.ts')).toBe('src/lib/c.ts')
  expect(fenceTitle('{1-3}')).toBeUndefined()
  expect(fenceTitle(undefined)).toBeUndefined()
})
