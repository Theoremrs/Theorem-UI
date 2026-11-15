// SOURCING: none — committed constants for the workbench stories: a file tree, document texts, a repository's status, diffs and log, and a recorded terminal byte stream. Nothing here is read from a host or a clock, so a story draws the same every time.
import type {
  FileListing,
  LogEntry,
  ScmChange,
  ScmDiffResult,
} from '@/lib/workbench/wire'

type Entries = FileListing['entries']

export const WORKSPACE = 'story-workspace'

/** One directory's listing: its entries, and whether the host returned only a subset of them. */
export type Listing = { entries: Entries; partial?: boolean }

/**
 * The Files story's tree, by directory path: a symlink, an ignored directory, a hidden entry, and
 * `docs`, a listing the host cut short so it is never read as complete.
 */
export const FILES_TREE: Record<string, Listing> = {
  '': {
    entries: [
      { name: 'src', kind: 'directory' },
      { name: 'docs', kind: 'directory' },
      { name: 'target', kind: 'directory', ignored: true },
      { name: '.github', kind: 'directory', hidden: true },
      { name: '.env', kind: 'file', hidden: true, ignored: true },
      { name: 'latest', kind: 'symlink' },
      { name: 'Cargo.toml', kind: 'file' },
      { name: 'README.md', kind: 'file' },
      { name: 'package.json', kind: 'file' },
    ],
  },
  src: {
    entries: [
      { name: 'components', kind: 'directory' },
      { name: 'lib.rs', kind: 'file' },
      { name: 'main.rs', kind: 'file' },
    ],
  },
  'src/components': {
    entries: [
      { name: 'button.rs', kind: 'file' },
      { name: 'panel.rs', kind: 'file' },
    ],
  },
  docs: {
    entries: [
      { name: 'architecture.md', kind: 'file' },
      { name: 'guide.md', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
      { name: 'roadmap.md', kind: 'file' },
    ],
    partial: true,
  },
  target: { entries: [{ name: 'debug', kind: 'directory', ignored: true }] },
  '.github': {
    entries: [{ name: 'workflows', kind: 'directory', hidden: true }],
  },
}

/** The tree the other workbench stories share: the same shape without the partial listing. */
export const TREE: Record<string, Listing> = {
  ...FILES_TREE,
  docs: {
    entries: [
      { name: 'architecture.md', kind: 'file' },
      { name: 'guide.md', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
    ],
  },
}

/** A path as the tree keys it: no leading `./` or `/`, no trailing `/`. */
export const treeKey = (path: string) =>
  path.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')

/** A woman technologist: three scalars joined by a zero-width joiner, one cell pair on screen. */
const TECHNOLOGIST = '\u{1F469}‍\u{1F4BB}'
/** A family: four scalars and three joiners. */
const FAMILY = '\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}'

const LONG_LINE =
  'This single line is deliberately far longer than any pane the workbench draws it in, so the editor has to wrap it onto several rows and keep one caret, one selection and one gutter number for all of them: ' +
  'wrapping is a view of the line, never a change to the text, and it must break at word boundaries rather than in the middle of a word.'

/** The editor story's file (plain text, so it opens in the editor and not in Markdown): tabs, CJK, a ZWJ emoji and a long line to wrap. */
export const NOTES_TEXT = [
  '# Notes',
  '',
  'Name\tRole\tCity',
  'Ada\tEngineer\tLondon',
  'Grace\tAdmiral\tNew York',
  '',
  '日本語の行: 全角の文字は二つのセルを使い、半角のカナｶﾀｶﾅは一つを使う。',
  `Family ${FAMILY} and the technologist ${TECHNOLOGIST} ship it.`,
  '',
  LONG_LINE,
  '',
  'The end.',
  '',
].join('\n')

export const README_TEXT = [
  '# Story workspace',
  '',
  'A fixture project for the workbench stories.',
  '',
  '- Files lists the tree.',
  '- Changes lists the repository.',
  '- Shell attaches to a recorded session.',
  '',
].join('\n')

/** The Markdown stories' document: front matter, a heading, a link, a checklist, a quotation, fenced code and a table. */
export const GUIDE_TEXT = [
  '---',
  'title: Workbench guide',
  'status: draft',
  '---',
  '',
  '# Workbench guide',
  '',
  'The workbench draws panels in a grid of cells. Read the [architecture notes](docs/architecture.md) before you change a panel.',
  '',
  '- [x] Open a file from Files',
  '- [ ] Switch the mode with Alt+1 to Alt+4',
  '- [ ] Save with Mod+S',
  '',
  '> A panel is a view of one owner, never a copy of its state.',
  '',
  '```rust',
  'fn main() {',
  '    println!("hello");',
  '}',
  '```',
  '',
  '| Mode | Shows |',
  '| --- | --- |',
  '| Visual | the page, edited block by block |',
  '| Source | the text |',
  '',
].join('\n')

/** The search story's second file: a CJK comment before the first match of `cell`. */
export const GRID_TEXT =
  '// 全角の文字 cell width\npub fn cell_width(wide: bool) -> u16 {\n    if wide { 2 } else { 1 }\n}\n'

/** The texts the documents owner holds, by workspace path. */
export const DOCUMENTS: Record<string, string> = {
  'docs/notes.txt': NOTES_TEXT,
  'docs/guide.md': GUIDE_TEXT,
  'README.md': README_TEXT,
  'src/main.rs': 'fn main() {\n    println!("hello");\n}\n',
  'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n',
  'src/grid.rs': GRID_TEXT,
}

/**
 * The findings the language owner reports for the open documents, by path: every severity, placed
 * by zero-based line and UTF-16 column.
 */
export const FINDINGS: Record<
  string,
  {
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    severity: 'error' | 'warning' | 'info' | 'hint'
    message: string
    source?: string
    code?: string
  }[]
> = {
  'docs/notes.txt': [
    {
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } },
      severity: 'error',
      message: 'Unknown name "Ada".',
      source: 'spell',
      code: 'S1',
    },
    {
      range: { start: { line: 6, character: 0 }, end: { line: 6, character: 4 } },
      severity: 'warning',
      message: 'Mixed scripts on one line.',
      source: 'prose',
    },
  ],
  'docs/guide.md': [
    {
      range: { start: { line: 8, character: 4 }, end: { line: 8, character: 10 } },
      severity: 'info',
      message: 'Prefer "cells" to "grid of cells".',
      source: 'prose',
    },
    {
      range: { start: { line: 14, character: 0 }, end: { line: 14, character: 3 } },
      severity: 'hint',
      message: 'Add the date this was drafted.',
      source: 'prose',
    },
  ],
}

/** The runs the host lists, and the output of the one the run story attaches to: finished, with colour in it. */
export const RUNS = [
  {
    handle: 'h1',
    name: 'tests',
    command: ['cargo', 'test', '--workspace'],
    state: 'exited',
    startedAtMs: 1_700_000_000_000,
  },
  {
    handle: 'h2',
    name: 'build',
    command: ['cargo', 'build', '--release'],
    state: 'running',
    startedAtMs: 1_700_000_100_000,
  },
]
export const RUN_OUTPUT =
  'running 2 tests\ntest add ... \u001b[32mok\u001b[0m\ntest sub ... \u001b[1;31mFAILED\u001b[0m\n\ntest result: \u001b[1;31mFAILED\u001b[0m. 1 passed; 1 failed\n'
export const RUN_ERRORS =
  '\u001b[1;33mwarning\u001b[0m: unused variable: `x`\n \u001b[1;34m-->\u001b[0m src/lib.rs:2:9\n'

/** The text the disk holds for the conflict state: the same file, changed by someone else. */
export const NOTES_ON_DISK = NOTES_TEXT.replace(
  'Ada\tEngineer\tLondon',
  'Ada\tPrincipal\tLondon',
)

// --- the repository -----------------------------------------------------------------------

export const BRANCH = 'main'
export const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** Staged, unstaged, untracked and conflicted rows, as git's two porcelain letters say them. */
export const CHANGES: ScmChange[] = [
  { path: 'src/lib.rs', index: 'M', worktree: ' ', conflict: false },
  { path: 'docs/roadmap.md', index: 'A', worktree: ' ', conflict: false },
  { path: 'src/main.rs', index: ' ', worktree: 'M', conflict: false },
  { path: 'README.md', index: ' ', worktree: 'D', conflict: false },
  { path: 'scratch.txt', index: '?', worktree: '?', conflict: false },
  { path: 'notes/ideas.md', index: '?', worktree: '?', conflict: false },
  { path: 'Cargo.toml', index: 'U', worktree: 'U', conflict: true },
]

const MAIN_PATCH = [
  '@@ -1,3 +1,5 @@',
  ' fn main() {',
  '-    println!("hello");',
  '+    let name = std::env::args().nth(1).unwrap_or_default();',
  '+    println!("hello, {name}");',
  ' }',
].join('\n')

const LIB_PATCH = [
  '@@ -1,3 +1,6 @@',
  ' pub fn add(a: i32, b: i32) -> i32 {',
  '     a + b',
  ' }',
  '+',
  '+pub fn sub(a: i32, b: i32) -> i32 {',
  '+    a - b',
  '+}',
].join('\n')

/** A file's diff: the working tree against the index, or (staged) the index against HEAD. */
export function diffOf(path: string, staged: boolean): ScmDiffResult {
  const patch = path === 'src/lib.rs' ? LIB_PATCH : MAIN_PATCH
  const header = path === 'src/lib.rs' ? '@@ -1,3 +1,6 @@' : '@@ -1,3 +1,5 @@'
  return {
    path,
    staged,
    text: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}\n`,
    hunks: [
      {
        path,
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: path === 'src/lib.rs' ? 6 : 5,
        header,
        patch,
      },
    ],
  }
}

export const LOG: LogEntry[] = [
  {
    commit: HEAD,
    author: 'Ada Lovelace',
    timestamp: '1731340800',
    subject: 'feat(files): list a partial directory without calling it whole',
  },
  {
    commit: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
    author: 'Grace Hopper',
    timestamp: '1731254400',
    subject: 'fix(editor): wrap a long line at word boundaries',
  },
  {
    commit: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
    author: 'Ada Lovelace',
    timestamp: '1731168000',
    subject: 'chore(build): pin the wasm-bindgen CLI',
  },
]

// --- the terminal -------------------------------------------------------------------------

export const TERMINAL_SESSION = 'sh-1'

const ESC = '\u001b'
const CSI = `${ESC}[`

/**
 * A recorded session, chunk by chunk as the host sent it: a prompt, `ls` in colour, a pager that
 * takes the alternate screen and gives it back, then a full-screen program that stays on it. The
 * resize the story sends arrives between the last two chunks.
 */
export const TERMINAL_BEFORE_RESIZE: string[] = [
  `${CSI}1;32mada@story${CSI}0m:${CSI}1;34m~/project${CSI}0m$ ls\r\n`,
  `${CSI}1;34mdocs${CSI}0m  ${CSI}1;34msrc${CSI}0m  ${CSI}36mlatest${CSI}0m  Cargo.toml  README.md\r\n`,
  `${CSI}1;32mada@story${CSI}0m:${CSI}1;34m~/project${CSI}0m$ git log --oneline | less\r\n`,
  // The pager: alternate screen on, its lines, a status line, then off again.
  `${CSI}?1049h${CSI}2J${CSI}H`,
  'a1b2c3d feat(files): list a partial directory without calling it whole\r\n',
  'b2c3d4e fix(editor): wrap a long line at word boundaries\r\n',
  'c3d4e5f chore(build): pin the wasm-bindgen CLI\r\n',
  `${CSI}24;1H${CSI}7m(END)${CSI}0m`,
  `${CSI}?1049l`,
  `${CSI}1;32mada@story${CSI}0m:${CSI}1;34m~/project${CSI}0m$ top\r\n`,
  // A full-screen program that stays up: the alternate screen again, a header and a table.
  `${CSI}?1049h${CSI}2J${CSI}H`,
  `${CSI}1mtop${CSI}0m - 12:00:00 up 3 days, load average: 0.42, 0.40, 0.38\r\n`,
  `${CSI}7m  PID USER      %CPU %MEM COMMAND         ${CSI}0m\r\n`,
  '    1 root       0.0  0.1 init\r\n',
  ` 4242 ada       ${CSI}31m12.5${CSI}0m  2.3 cargo\r\n`,
  ' 4243 ada        3.1  1.2 rustc\r\n',
]

/** What the program draws once the terminal is smaller: it repaints from the top. */
export const TERMINAL_AFTER_RESIZE: string[] = [
  `${CSI}2J${CSI}H`,
  `${CSI}1mtop${CSI}0m - resized to fit\r\n`,
  `${CSI}7m  PID USER      %CPU COMMAND  ${CSI}0m\r\n`,
  ` 4242 ada       ${CSI}31m12.5${CSI}0m cargo\r\n`,
]

/** The size the story resizes the terminal to. */
export const TERMINAL_RESIZED = { cols: 64, rows: 14 }
