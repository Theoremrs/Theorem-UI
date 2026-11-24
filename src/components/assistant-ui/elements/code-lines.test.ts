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

test('header-like removed and added content stays in its hunk', () => {
  const read = diffLines([
    '--- a/headings.txt',
    '+++ b/headings.txt',
    '@@ -1,2 +1,2 @@',
    '--- old heading',
    '+++ new heading',
    ' context',
  ].join('\n'))
  expect(read.path).toBe('headings.txt')
  expect(read.text).toBe('@@ -1,2 +1,2 @@\n-- old heading\n++ new heading\ncontext')
  expect(read.lines).toEqual([
    { change: 'hunk' },
    { change: 'remove' },
    { number: 1, change: 'add' },
    { number: 2 },
  ])
})

test('header-like content is preserved even when the hunk counts are wrong', () => {
  const read = diffLines('@@ -1,20 +1,20 @@\n--- old heading\n+++ new heading\n context')
  expect(read.path).toBeUndefined()
  expect(read.text).toBe('@@ -1,20 +1,20 @@\n-- old heading\n++ new heading\ncontext')
})

test('a multi-file patch keeps every filename and source row as a raw diff', () => {
  const patch = [
    'diff --git a/first.ts b/first.ts',
    '--- a/first.ts',
    '+++ b/first.ts',
    '@@ -1 +1 @@',
    '-const x = 1;',
    '+const x = 2;',
    'diff --git a/last.py b/last.py',
    '--- a/last.py',
    '+++ b/last.py',
    '@@ -1 +1 @@',
    '-x = 1',
    '+x = 2',
    '',
  ].join('\n')
  const read = diffLines(patch)
  expect(read.path).toBeUndefined()
  expect(read.language).toBe('diff')
  expect(read.text).toBe(patch)
  expect(read.lines).toHaveLength(patch.split('\n').length)
})

test('a multi-file unified patch without git preambles also retains its file headers', () => {
  const patch = [
    '--- before.ts',
    '+++ after.ts',
    '@@ -1 +1 @@',
    '-const x = 1;',
    '+const x = 2;',
    '--- before.py',
    '+++ after.py',
    '@@ -1 +1 @@',
    '-x = 1',
    '+x = 2',
  ].join('\n')
  const read = diffLines(patch)
  expect(read.path).toBeUndefined()
  expect(read.language).toBe('diff')
  expect(read.text).toBe(patch)
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
