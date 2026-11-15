// SOURCING: playwright-core and sharp as story-oracle.mjs uses them (this module is that driver's `palette` subcommand, handed its page launcher), culori for WCAG contrast and alpha blending, pngjs to read pixels back from a screenshot, and the design-oracles skill's evaluate.py for every verdict. Nothing here decides pass or fail: it captures what the rendered workbench painted and hands it to the evaluator.
//
//   node scripts/story-oracle.mjs palette capture <surface|all> [profile]   observations from the rendered stories
//   node scripts/story-oracle.mjs palette evaluate                          cross-profile observations, the evaluator, reports
//   node scripts/story-oracle.mjs palette sheets                            one contact sheet per surface
//   node scripts/story-oracle.mjs palette face                              AC-27's theme half: the face over each profile
//
// The workbench draws into Ratzilla's DOM backend: a <pre> per row, a <span> per cell with its resolved
// colour and background-color. Each role is read from the span of a cell that paints it (found by the text
// it shows), so the evidence is what the page painted, not a token. A handful of solid fills are read back
// from the screenshot's pixels to confirm the DOM's colours are the ones on screen.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { converter, formatHex, interpolate, wcagContrast } from 'culori'
import { PNG } from 'pngjs'
import sharp from 'sharp'

const rgb = converter('rgb')
const EVALUATOR = join(homedir(), '.claude/skills/design-oracles/scripts/evaluate.py')
const SURFACES = ['chat', 'markdown', 'changes', 'cabinet', 'terminal', 'face']
const idOf = (surface, profile) => `workbench-palette-${surface}-${profile}`
const STORY_ID = /^workbench-palette-(chat|markdown|changes|cabinet|terminal|face)-(.+)$/

// --- roles ---------------------------------------------------------------------------------------
//
// A role is found by the text of a cell that paints it. `x` is a cell column range of the match's start
// (Files is columns 0 to 29, the Theo page 31 to 123, the tools group from 125 at the default layout); `y`
// a row range; `nth` which match; `offset` the cell within the match. `expect` names the palette fields
// (terminal-roles.ts wasmPalette) the cell should be painted in, so a mis-anchored cell shows.
const FILES = { xmax: 29 }
const TOOLS = { xmin: 125 }

const text = (id, per, expect) => ({ id, kind: 'text', per, expect })

export const ROLES = [
  text('ink', {
    chat: { text: 'I read the log first' },
    markdown: { text: 'The workbench draws' },
    changes: { text: 'lib.rs', ...TOOLS },
    cabinet: { text: 'File; preview unavailable' },
    terminal: { text: 'running 4 tests' },
  }, { fg: ['ink'], bg: ['bg'] }),
  text('muted', {
    chat: { text: 'Enter steers the run' },
    markdown: { text: 'A panel is a view' },
    changes: { text: 'Staged 2' },
    cabinet: { text: 'Theorem · every session' },
    terminal: { text: 'Message Theo', ymin: 30 },
  }, { fg: ['muted'], bg: ['bg'] }),
  text('selection', {
    chat: { text: 'Changes', ...TOOLS, ymin: 2, ymax: 4 },
    markdown: { text: 'guide.md', ...FILES, ymin: 2 },
  }, { fg: ['bright'], bg: ['selection', 'raised'] }),
  text('focused-row', {
    changes: { text: 'main.rs', ...TOOLS, ymin: 6, ymax: 10 },
  }, { fg: ['bg'], bg: ['focus', 'accent'] }),
  text('tab-active', {
    chat: { text: 'Theo', ymax: 0 },
    markdown: { text: 'guide.md', ymax: 0 },
    changes: { text: 'Changes', ymax: 0 },
    cabinet: { text: 'Artifacts', ymax: 0 },
    terminal: { text: 'Shell', ymax: 0 },
  }, { fg: ['bg'], bg: ['focus', 'accent'] }),
  text('tab-inactive', {
    chat: { text: 'Files', ymax: 0 },
    markdown: { text: 'Files', ymax: 0 },
    changes: { text: 'Files', ymax: 0 },
    cabinet: { text: 'Files', ymax: 0 },
    terminal: { text: 'Files', ymax: 0 },
  }, { fg: ['bright'], bg: ['raised', 'selection'] }),
  text('warning', {
    chat: { text: '? edit_file' },
    markdown: { text: 'connecting to the conversation' },
    changes: { text: 'connecting to the conversation' },
    cabinet: { text: '? edit_file' },
    terminal: { text: 'connecting to the conversation' },
  }, { fg: ['warning', 'approval', 'gold'], bg: ['bg', 'raised'] }),
  text('success', {
    chat: { text: '✓ read_file' },
    changes: { text: 'A roadmap.md' },
    terminal: { text: '... ok', offset: 4 },
  }, { fg: ['success', 'ansi:2'], bg: ['bg', 'raised'] }),
  text('error', {
    changes: { text: 'D README.md', ...TOOLS },
    terminal: { text: 'error[E0308]' },
  }, { fg: ['error', 'ansi:1'], bg: ['bg', 'removedLine'] }),
  text('link', {
    chat: { text: '@build.log' },
    cabinet: { text: '@build.log' },
  }, { fg: ['link'], bg: ['bg'] }),
  text('heading', {
    chat: { text: 'read_file' },
    cabinet: { text: 'Gallery' },
    markdown: { text: 'Preview Alt+4' },
  }, { fg: ['bright', 'heading'], bg: ['raised', 'selection', 'bg'] }),
  text('code', {
    chat: { text: 'let width = self.area.width', nth: 2 },
    cabinet: { text: 'let width = self.area.width', nth: 2 },
  }, { fg: ['accent', 'sage', 'focus'], bg: ['raised', 'selection'] }),
  text('accent-text', {
    cabinet: { text: '[All]' },
  }, { fg: ['accent', 'sage', 'focus'], bg: ['bg'] }),
  text('warning-on-focus', {
    changes: { text: 'M', xmin: 128, xmax: 128, ymin: 8, ymax: 8 },
  }, { fg: ['warning', 'gold', 'approval'], bg: ['accent', 'sage', 'focus'] }),
  text('muted-on-focus', {
    changes: { text: 'diff  stage  discard' },
  }, { fg: ['muted'], bg: ['accent', 'sage', 'focus'] }),
  text('notice', {
    cabinet: { text: 'Reduced thumbnails' },
    terminal: { text: 'Adopted a terminal' },
  }, { fg: ['muted'], bg: ['bg'] }),
  text('diff-added', {
    chat: { text: 'let width = self.area.width', nth: 1 },
    changes: { text: 'hello, {name}' },
  }, { fg: ['ink'], bg: ['addedLine'] }),
  text('diff-removed', {
    chat: { text: 'let width = self.area.width', nth: 0 },
    changes: { text: '"hello");', offset: 8 },
  }, { fg: ['ink'], bg: ['removedLine', 'removedWords'] }),
  text('diff-added-words', {
    chat: { text: 'width;', offset: 5 },
  }, { fg: ['ink', 'commentOnWords'], bg: ['addedWords'] }),
  text('diff-added-words-changes', {
    changes: { text: 'std::env::args' },
  }, { fg: ['ink', 'commentOnWords'], bg: ['addedWords'] }),
  text('diff-removed-words', {
    changes: { text: 'println!', ...TOOLS },
  }, { fg: ['ink', 'commentOnWords'], bg: ['removedWords'] }),
]

/** Non-text pieces of the interface: a glyph's colour against its ground, or one fill against another. */
const ui = (id, per, expect, vs) => ({ id, kind: 'ui', per, expect, vs })
export const UI_ROLES = [
  ui('focus-indicator', {
    chat: { text: '╭─', ymin: 30 },
  }, { fg: ['focus', 'accent'], bg: ['bg'] }),
  ui('selection-fill', {
    chat: { text: 'Changes', ...TOOLS, ymin: 2, ymax: 4 },
    markdown: { text: 'guide.md', ...FILES, ymin: 2 },
  }, { bg: ['selection', 'raised'] }, { what: 'pane-bg' }),
  ui('tab-fill', {
    chat: { text: 'Theo', ymax: 0 },
    markdown: { text: 'guide.md', ymax: 0 },
    changes: { text: 'Changes', ymax: 0 },
    cabinet: { text: 'Artifacts', ymax: 0 },
    terminal: { text: 'Shell', ymax: 0 },
  }, { bg: ['focus', 'accent'] }, { what: 'inactive-tab-fill' }),
  ui('separator', {
    chat: { text: '│', ymin: 2, ymax: 2 },
    markdown: { text: '│', ymin: 2, ymax: 2 },
    changes: { text: '│', ymin: 2, ymax: 2 },
    cabinet: { text: '│', ymin: 2, ymax: 2 },
    terminal: { text: '│', ymin: 2, ymax: 2 },
  }, { fg: ['line'], bg: ['bg'] }),
  ui('composer-border', {
    markdown: { text: '╭─', ymin: 30 },
    changes: { text: '╭─', ymin: 30 },
    cabinet: { text: '╭─', ymin: 30 },
    terminal: { text: '╭─', ymin: 30 },
  }, { fg: ['line'], bg: ['bg'] }),
  ui('diff-added-fill', {
    chat: { text: 'let width = self.area.width', nth: 1 },
    changes: { text: 'hello, {name}' },
  }, { bg: ['addedLine'] }, { what: 'pane-bg' }),
  ui('diff-removed-fill', {
    chat: { text: 'let width = self.area.width', nth: 0 },
    changes: { text: '"hello");', offset: 8 },
  }, { bg: ['removedLine', 'removedWords'] }, { what: 'pane-bg' }),
]

/** The ANSI slot's role in the palette (terminal/src/workbench.rs ansi_of), for the expected colour. */
const ANSI_OF = [
  'deep', 'error', 'success', 'warning', 'link', 'syntaxKeyword', 'accent', 'ink',
  'muted', 'error', 'success', 'warning', 'link', 'syntaxKeyword', 'accent', 'bright',
]
/** The syntax roles a surface paints, and the cell that shows each: the diff's hunk header and its two markers. */
const SYNTAX_PAINTED = {
  comment: { text: '@@ -1,3 +1,3 @@' },
  keyword: { text: '-', xmin: 36, xmax: 36, ymin: 10, ymax: 12 },
  tag: { text: '+', xmin: 36, xmax: 36, ymin: 11, ymax: 13 },
}
const SYNTAX = ['Keyword', 'String', 'Number', 'Function', 'Variable', 'Type', 'Tag', 'Comment']
/** xterm's colour cube levels, for the 256-colour pass-through. */
const LEVELS = [0, 95, 135, 175, 215, 255]
const xterm = (n) => {
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return [v, v, v]
  }
  const m = n - 16
  return [LEVELS[Math.floor(m / 36)], LEVELS[Math.floor(m / 6) % 6], LEVELS[m % 6]]
}
const hexOf = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
const SAMPLES_256 = [16, 21, 46, 196, 231, 232, 255]
const SAMPLES_TRUE = [0, 15, 31, 47, 63]

// --- the page ---------------------------------------------------------------------------------------

const cssHex = (css) => {
  const c = rgb(css)
  return formatHex({ mode: 'rgb', r: c.r, g: c.g, b: c.b })
}

/** One read of the page: the grid's cells with their resolved style, and the palette the page handed the wasm. */
async function readPage(page) {
  return page.evaluate(async () => {
    const grid = document.querySelector('[id$=_ratzilla_grid]')
    const rows = [...grid.querySelectorAll(':scope > pre')].map((pre) =>
      [...pre.children].map((span) => {
        const style = getComputedStyle(span)
        return [
          span.textContent,
          style.color,
          style.backgroundColor,
          (Number(style.fontWeight) >= 600 ? 'b' : '') +
            (style.fontStyle === 'italic' ? 'i' : '') +
            (style.textDecorationLine !== 'none' ? 'u' : ''),
          Number(style.opacity),
        ]
      }),
    )
    const { useTerminalTheme } = await import('/src/components/terminal/live-terminal-theme.ts')
    const { wasmPalette } = await import('/src/components/terminal/terminal-roles.ts')
    const { truecolorAt } = await import('/src/components/workbench/workbench-palette-stories.tsx')
    const root = document.documentElement
    return {
      rows,
      palette: wasmPalette(useTerminalTheme.getState().roles),
      diagnostics: useTerminalTheme.getState().roles.diagnostics,
      truecolor: Array.from({ length: 64 }, (_, i) => truecolorAt(i)),
      page: {
        palette: root.dataset.palette,
        dark: root.classList.contains('dark'),
        preset: root.dataset.appearancePreset,
        dpr: window.devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        userAgent: navigator.userAgent,
        language: document.documentElement.lang,
        direction: getComputedStyle(root).direction,
      },
    }
  })
}

function locate(grid, spec) {
  let hits = 0
  for (let y = 0; y < grid.rows.length; y++) {
    if ((spec.ymin !== undefined && y < spec.ymin) || (spec.ymax !== undefined && y > spec.ymax)) continue
    const row = grid.rows[y]
    const starts = []
    let joined = ''
    for (const cell of row) {
      starts.push(joined.length)
      joined += cell[0]
    }
    for (let from = 0; ; ) {
      const at = joined.indexOf(spec.text, from)
      if (at < 0) break
      from = at + 1
      let x = starts.findLastIndex((s) => s <= at + (spec.offset ?? 0))
      if (x < 0) x = 0
      const start = starts.findLastIndex((s) => s <= at)
      if ((spec.xmin !== undefined && start < spec.xmin) || (spec.xmax !== undefined && start > spec.xmax)) continue
      if (hits++ === (spec.nth ?? 0)) return { y, x, cell: row[x] }
    }
  }
  return undefined
}

/** A cell's colours as opaque hex, a dimmed cell (opacity under 1) blended over its own background. */
function colours(cell) {
  const [, fg, bg, , opacity] = cell
  const background = cssHex(bg)
  const foreground = opacity < 1 ? formatHex(interpolate([bg, fg], 'rgb')(opacity)) : cssHex(fg)
  return { foreground, background, dimmed: opacity < 1 ? opacity : undefined, rawForeground: cssHex(fg) }
}

/** The key of `palette` a colour is painted in, or undefined. */
const paletteKeys = (palette, hex) => Object.entries(palette).filter(([, v]) => v === hex).map(([k]) => k)

const meta = (story, grid, extra) => ({
  story: story.id,
  method: 'Ratzilla DomBackend cell span, getComputedStyle color and background-color',
  ...extra,
})

function gitState() {
  const run = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  try {
    return { head: run('rev-parse', 'HEAD'), dirty: run('status', '--porcelain', '--', 'src', 'scripts', 'terminal/src').length > 0 }
  } catch {
    return { head: 'unknown', dirty: true }
  }
}

// --- capture ----------------------------------------------------------------------------------------

async function captureStory(ctx, story) {
  const [, surface, profile] = story.id.match(STORY_ID)
  return ctx.withPage(story, async (page) => {
    await page.waitForTimeout(500)
    const grid = await readPage(page)
    const png = await page.screenshot({ path: ctx.renderPath(story.id), clip: { x: 0, y: 0, ...story.viewport } })
    const observations = {}
    const roles = []
    const notes = []
    const palette = grid.palette

    const read = (role, spec) => {
      const found = locate(grid, spec)
      if (!found) return notes.push(`${role.id}: no cell shows ${JSON.stringify(spec.text)}`) && undefined
      return { ...found, ...colours(found.cell) }
    }
    const binds = (role, found) => {
      const fgKeys = paletteKeys(palette, found.rawForeground)
      const bgKeys = paletteKeys(palette, found.background)
      const ok = (want, keys) => !want || want.some((k) => keys.includes(k) || (k.startsWith('ansi:') && keys.includes(ANSI_OF[Number(k.slice(5))])))
      return { fg: fgKeys, bg: bgKeys, matches: ok(role.expect.fg, fgKeys) && ok(role.expect.bg, bgKeys) }
    }

    for (const role of ROLES) {
      const spec = role.per[surface]
      if (!spec) continue
      const found = read(role, spec)
      if (!found) continue
      const bound = binds(role, found)
      roles.push({ role: role.id, y: found.y, x: found.x, text: spec.text, ...bound })
      observations[role.id] = {
        kind: 'rendered_web',
        foreground: found.foreground,
        background: found.background,
        provenance: meta(story, grid, {
          cell: { row: found.y, column: found.x, text: found.cell[0] },
          dimmed_opacity: found.dimmed,
          raw_foreground: found.rawForeground,
          palette_fields: bound,
          bound_to_expected_palette_fields: bound.matches,
        }),
      }
    }

    // Fills and glyphs that are not text.
    const paneBg = (() => {
      const f = locate(grid, { text: 'The build fails' }) ?? locate(grid, { text: 'Cargo.toml', xmax: 29 })
      return f ? cssHex(f.cell[2]) : undefined
    })()
    const inactiveFill = (() => {
      const f = locate(grid, { text: 'Files', ymax: 0 })
      return f ? cssHex(f.cell[2]) : undefined
    })()
    for (const role of UI_ROLES) {
      const spec = role.per[surface]
      if (!spec) continue
      const found = read(role, spec)
      if (!found) continue
      const bound = binds(role, found)
      const info = { cell: { row: found.y, column: found.x, text: found.cell[0] }, palette_fields: bound, bound_to_expected_palette_fields: bound.matches }
      if (role.vs) {
        const second = role.vs.what === 'pane-bg' ? paneBg : inactiveFill
        if (!second) {
          notes.push(`${role.id}: no ${role.vs.what}`)
          continue
        }
        observations[role.id] = {
          kind: 'rendered_web',
          foreground: found.background,
          background: second,
          provenance: meta(story, grid, { ...info, against: role.vs.what }),
        }
      } else {
        observations[role.id] = {
          kind: 'rendered_web',
          foreground: found.rawForeground,
          background: found.background,
          provenance: meta(story, grid, info),
        }
      }
      roles.push({ role: role.id, y: found.y, x: found.x, text: spec.text, ...bound })
    }

    if (surface === 'chat') {
      // The syntax roles are handed to the wasm and no surface of the fixture workbench paints them: the
      // evidence is the palette in use, a token pair, and the evaluator will say so.
      for (const name of SYNTAX)
        observations[`syntax-${name.toLowerCase()}`] = {
          kind: 'tokens',
          foreground: palette[`syntax${name}`],
          background: palette.bg,
          provenance: meta(story, grid, { method: 'palette in use: the set_palette argument (wasmPalette of the live roles); no rendered cell paints this role' }),
        }
    }

    // Three syntax roles are painted: the hunk header (comment), the removed line's marker (keyword), the added line's (tag).
    if (surface === 'chat') {
      for (const [name, spec] of Object.entries(SYNTAX_PAINTED)) {
        const found = read({ id: `syntax-${name}` }, spec)
        if (!found) continue
        observations[`syntax-${name}`] = {
          kind: 'rendered_web',
          foreground: found.rawForeground,
          background: found.background,
          provenance: meta(story, grid, { cell: { row: found.y, column: found.x, text: found.cell[0] }, palette_fields: { fg: paletteKeys(palette, found.rawForeground), bg: paletteKeys(palette, found.background) } }),
        }
      }
    }

    let truecolor
    if (surface === 'terminal') {
      // A labelled row of the test output: the row and the column its label starts at (the pane is offset).
      const at = (label) => {
        const found = locate(grid, { text: label, xmin: 90 })
        return found ? { y: found.y, x: found.x } : undefined
      }
      const fgRow = at('fg:')
      const bgRow = at('bg:')
      const ansi = []
      if (fgRow && bgRow) {
        const surfaceBg = cssHex(grid.rows[fgRow.y][fgRow.x][2])
        for (let n = 0; n < 16; n++) {
          const col = fgRow.x + 3 + 3 * n + 1
          const cell = grid.rows[fgRow.y][col]
          const slotBg = grid.rows[bgRow.y][bgRow.x + 3 + 4 * n + 1]
          const fgHex = cssHex(cell[1])
          const expected = palette[ANSI_OF[n]]
          ansi.push({ slot: n, fg: fgHex, bgSlot: cssHex(slotBg[2]), expected, equals_palette_role: fgHex === expected })
          observations[`ansi-${two(n)}`] = {
            kind: 'rendered_web',
            foreground: fgHex,
            background: surfaceBg,
            provenance: meta(story, grid, { cell: { row: fgRow.y, column: col, text: cell[0] }, palette_role: ANSI_OF[n], equals_palette_role: fgHex === expected, background_slot_painted: cssHex(slotBg[2]) }),
          }
        }
        observations['ansi-bright-distinct'] = {
          kind: 'rendered_web',
          first: ansi[1].fg,
          second: ansi[9].fg,
          provenance: meta(story, grid, { what: 'ANSI red against bright red, as painted' }),
        }
        observations['ansi-red-magenta'] = {
          kind: 'rendered_web',
          first: ansi[1].fg,
          second: ansi[5].fg,
          provenance: meta(story, grid, { what: 'ANSI red against ANSI magenta, as painted' }),
        }
        // Colour pass-through: the bytes' colour against the colour painted.
        const bytes = {}
        const painted = {}
        const c6 = at('c6:')
        const gr = at('gr:')
        const tc = at('tc:')
        const bgOf = (r, x) => (r ? cssHex(grid.rows[r.y][r.x + x][2]) : 'missing')
        for (const n of SAMPLES_256) {
          bytes[`c${n}`] = hexOf(xterm(n))
          painted[`c${n}`] =
            n >= 232
              ? bgOf(gr, 3 + (n - 232))
              : c6
                ? cssHex(grid.rows[c6.y + Math.floor((n - 16) / 36)][c6.x + 3 + ((n - 16) % 36)][2])
                : 'missing'
        }
        for (const i of SAMPLES_TRUE) {
          bytes[`t${i}`] = hexOf(grid.truecolor[i])
          painted[`t${i}`] = bgOf(tc, 3 + i)
        }
        const ink = locate(grid, { text: 'truecolor ink' })
        bytes.ink = '#ff8000'
        painted.ink = ink ? cssHex(ink.cell[1]) : 'missing'
        const ink256 = locate(grid, { text: '256 ink' })
        bytes.ink256 = hexOf(xterm(208))
        painted.ink256 = ink256 ? cssHex(ink256.cell[1]) : 'missing'
        observations.passthrough = {
          kind: 'rendered_web',
          before: bytes,
          after: painted,
          provenance: meta(story, grid, { what: 'colour bytes the fixture host sent, and the cell colour painted: 256-colour cube and grey ramp samples, truecolor gradient cells, truecolor and 256 foregrounds' }),
        }
        truecolor = { bytes, painted }
      } else notes.push('terminal: the test output is not on the grid')
    }

    // Solid fills read back from the pixels of the screenshot.
    const pixel = await confirmPixels(page, png, grid, roles.length ? roles : [], story, surface)

    const git = gitState()
    return {
      source_revision: `${git.head}${git.dirty ? '+worktree' : ''}`,
      fixture: story.id,
      environment: {
        story: story.id,
        surface,
        profile,
        route: `/story/${story.id}`,
        viewport_css_px: story.viewport,
        device_pixel_ratio: grid.page.dpr,
        zoom: 1,
        renderer: await page.evaluate(() => navigator.userAgent),
        os: process.platform,
        language: grid.page.language || 'en',
        direction: grid.page.direction,
        palette: grid.page.palette,
        mode: grid.page.dark ? 'dark' : 'light',
        appearance_preset: grid.page.preset,
        font: 'the grid mono face from the app (computed font-family not asserted)',
        date: new Date().toISOString().slice(0, 10),
      },
      observations,
      palette_in_use: palette,
      palette_diagnostics: grid.diagnostics,
      roles,
      pixel_confirmation: pixel,
      passthrough: truecolor,
      notes,
    }
  })
}

const two = (n) => String(n).padStart(2, '0')

/** For a few cells that are solid fills, the DOM's background against the screenshot's pixel. */
async function confirmPixels(page, png, grid, roles, story, surface) {
  const image = PNG.sync.read(png)
  const targets = []
  const wanted = [
    ['pane background', { text: 'Cargo.toml', xmax: 29 }],
    ['active tab fill', { text: surface === 'chat' ? 'Theo' : surface === 'markdown' ? 'guide.md' : surface === 'changes' ? 'Changes' : surface === 'cabinet' ? 'Artifacts' : 'Shell', ymax: 0 }],
    ['inactive tab fill', { text: 'Files', ymax: 0 }],
  ]
  if (surface === 'chat') wanted.push(['added line fill', { text: 'let width = self.area.width', nth: 1 }], ['removed line fill', { text: 'let width = self.area.width', nth: 0 }], ['added words fill', { text: 'width;', offset: 5 }], ['selected row fill', { text: 'Changes', xmin: 125, ymin: 2, ymax: 4 }])
  if (surface === 'changes') wanted.push(['removed words fill', { text: 'println!', xmin: 125 }], ['focused row fill', { text: 'main.rs', xmin: 125, ymin: 6, ymax: 10 }])
  if (surface === 'terminal') {
    const find = (label) => locate(grid, { text: label, xmin: 90 })
    const bgRow = find('bg:')
    if (bgRow) for (const n of [0, 1, 4, 8, 15]) targets.push({ label: `ANSI background ${n}`, y: bgRow.y, x: bgRow.x + 3 + 4 * n })
    const tc = find('tc:')
    if (tc) for (const i of [0, 31, 63]) targets.push({ label: `truecolor cell ${i}`, y: tc.y, x: tc.x + 3 + i })
  }
  for (const [label, spec] of wanted) {
    const found = locate(grid, spec)
    if (found) targets.push({ label, y: found.y, x: found.x, nearBlank: true })
  }
  const out = []
  for (const target of targets) {
    if (target.y < 0) continue
    // A cell to sample whose glyph is a space (a solid fill), in the target's row beside it with the same background.
    const row = grid.rows[target.y]
    const want = cssHex(row[target.x][2])
    let x = target.x
    if (target.nearBlank && row[x][0] !== ' ') {
      const near = [x + 1, x - 1, x + 2, x - 2, x + 3, x - 3].find((i) => row[i] && row[i][0] === ' ' && cssHex(row[i][2]) === want)
      if (near !== undefined) x = near
    }
    const rect = await page.evaluate(
      ([y, i]) => {
        const grid = document.querySelector('[id$=_ratzilla_grid]')
        const span = grid.querySelectorAll(':scope > pre')[y]?.children[i]
        const r = span?.getBoundingClientRect()
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
      },
      [target.y, x],
    )
    if (!rect) continue
    const px = Math.min(image.width - 1, Math.round(rect.x + rect.w / 2))
    const py = Math.min(image.height - 1, Math.round(rect.y + rect.h / 2))
    const at = (py * image.width + px) * 4
    const pixel = hexOf([image.data[at], image.data[at + 1], image.data[at + 2]])
    out.push({ label: target.label, row: target.y, column: x, glyph: row[x][0], dom: cssHex(row[x][2]), pixel, equal: pixel === cssHex(row[x][2]) })
  }
  return out
}

export function storiesOf(listed) {
  return listed.filter((s) => STORY_ID.test(s.id))
}

const capturedDir = (ctx) => join(ctx.EVIDENCE, 'oracles/captured')

async function pool(items, size, run) {
  const queue = [...items]
  const failures = []
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        for (let attempt = 1; ; attempt++) {
          try {
            await run(item)
            break
          } catch (error) {
            if (attempt >= 2) {
              failures.push(`${item.id}: ${String(error).slice(0, 200)}`)
              break
            }
          }
        }
      }
    }),
  )
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  }
}

async function capture(ctx, surface, profile) {
  mkdirSync(capturedDir(ctx), { recursive: true })
  const listed = storiesOf(ctx.listed).filter((s) => {
    const [, su, pr] = s.id.match(STORY_ID)
    return su !== 'face' && (surface === 'all' || su === surface) && (!profile || profile === 'all' || pr === profile)
  })
  if (!listed.length) throw new Error(`no palette story for ${surface} ${profile ?? ''}`)
  await pool(listed, 3, async (story) => {
    const result = await captureStory(ctx, story)
    writeFileSync(join(capturedDir(ctx), `${story.id}.json`), JSON.stringify(result, null, 2) + '\n')
    const pixels = result.pixel_confirmation
    console.log(`${story.id}: ${Object.keys(result.observations).length} observations, pixels ${pixels.filter((p) => p.equal).length}/${pixels.length}${result.notes.length ? `, notes: ${result.notes.join('; ')}` : ''}`)
  })
}

// --- evaluate ---------------------------------------------------------------------------------------

/** The roles whose rendered colour must follow the profile, and where it is read from. */
const DERIVED = {
  bg: (o) => o.ink?.background,
  raised: (o) => o['tab-inactive']?.background,
  line: (o) => o.separator?.foreground,
  ink: (o) => o.ink?.foreground,
  muted: (o) => o.muted?.foreground,
  selection: (o) => o.selection?.background,
}
/** Colours kept across profiles by design (declared in the policy's fixed_roles). */
const FIXED = {
  success: (o) => o.success?.foreground,
  warning: (o) => o.warning?.foreground,
  link: (o) => o.link?.foreground,
  error: (o) => o.error?.foreground,
  accent: (o) => o['tab-active']?.background,
}

function profileOrder(files) {
  const profiles = []
  for (const f of files) {
    const p = f.environment.profile
    if (!profiles.includes(p)) profiles.push(p)
  }
  return profiles
}

/** The same-mode profile of the next palette, round the cycle: every pair of palettes is met once. */
function partnerOf(profile, profiles) {
  const mode = profile.endsWith('-dark') ? 'dark' : 'light'
  const same = profiles.filter((p) => p.endsWith(`-${mode}`))
  return same[(same.indexOf(profile) + 1) % same.length]
}

function runEvaluator(policyPath, observationsPath, outPath) {
  let status = 0
  try {
    execFileSync('python3', [EVALUATOR, '--policy', policyPath, '--observations', observationsPath, '--out', outPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    status = error.status ?? 99
    if (status > 2) throw new Error(`evaluator: ${String(error.stderr).slice(0, 300)}`)
  }
  return { status, report: JSON.parse(readFileSync(outPath, 'utf8')) }
}

async function evaluate(ctx) {
  const dir = capturedDir(ctx)
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('workbench-palette-') && f.endsWith('.json') && !f.includes('face'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const policy = JSON.parse(readFileSync(join(ctx.EVIDENCE, 'oracles/workbench-palette.policy.json'), 'utf8'))
  const profiles = profileOrder(files.sort((a, b) => a.environment.story.localeCompare(b.environment.story)))
  const order = (ctx.listed ?? []).filter((s) => STORY_ID.test(s.id)).map((s) => s.id.match(STORY_ID)[2])
  const ordered = [...new Set(order)].length ? [...new Set(order)] : profiles
  const bySurface = new Map(files.map((f) => [`${f.environment.surface}/${f.environment.profile}`, f]))
  const effectiveDir = join(ctx.EVIDENCE, 'oracles/effective')
  mkdirSync(effectiveDir, { recursive: true })
  const summary = []
  const unchanged = {}
  for (const file of files) {
    const { surface, profile } = file.environment
    const partner = bySurface.get(`${surface}/${partnerOf(profile, ordered)}`)
    const observations = { ...file.observations }
    for (const [role, read] of Object.entries(DERIVED)) {
      const here = read(file.observations)
      const there = partner && read(partner.observations)
      if (here && there)
        observations[`derived-${role}`] = {
          kind: 'rendered_web',
          first: here,
          second: there,
          provenance: { story: file.fixture, against: partner.fixture, method: 'the role colour painted here and in the same mode of the next palette' },
        }
    }
    for (const [role, read] of Object.entries(FIXED)) {
      const here = read(file.observations)
      const there = partner && read(partner.observations)
      if (here && there) {
        observations[`fixed-${role}`] = {
          kind: 'rendered_web',
          first: here,
          second: there,
          provenance: { story: file.fixture, against: partner.fixture, method: 'the role colour painted here and in the same mode of the next palette' },
        }
        if (here === there) (unchanged[role] ??= new Set()).add(`${profile} = ${partner.environment.profile}`)
      }
    }
    // Only the checks that name this surface are evaluated; a surface that does not draw a role is not scored on it.
    const effective = { ...policy, name: `${policy.name}:${surface}`, checks: policy.checks.filter((c) => c.surfaces?.includes(surface)) }
    const base = `${file.fixture}`
    const policyPath = join(effectiveDir, `${base}.policy.json`)
    writeFileSync(policyPath, JSON.stringify(effective, null, 2) + '\n')
    const evidencePath = join(effectiveDir, `${base}.observations.json`)
    writeFileSync(evidencePath, JSON.stringify({ ...file, observations }, null, 2) + '\n')
    const outPath = join(ctx.EVIDENCE, 'oracles', `${base}.report.json`)
    const { status, report } = runEvaluator(policyPath, evidencePath, outPath)
    summary.push({ surface, profile, story: base, exit: status, counts: report.counts, results: report.results.map((r) => ({ id: r.id, class: r.class, status: r.status, observation: r.observation, evidence_kind: r.evidence_kind, detail: r.detail, provenance: r.provenance?.cell ?? r.provenance?.what })) })
    console.log(`${base}: ${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }
  const out = join(ctx.EVIDENCE, 'oracles/workbench-palette-summary.json')
  writeFileSync(out, JSON.stringify({ profiles: ordered, evaluator: 'design-oracles evaluate.py', policy: 'docs/plans/evidence/oracles/workbench-palette.policy.json', unchanged_with_profile: Object.fromEntries(Object.entries(unchanged).map(([k, v]) => [k, [...v]])), runs: summary }, null, 2) + '\n')
  console.log(`summary: ${out}`)
}

// --- contact sheets ---------------------------------------------------------------------------------

const labelSvg = (label, width) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22"><rect width="100%" height="100%" fill="#111"/><text x="8" y="15" font-family="monospace" font-size="12" fill="#eee">${label}</text></svg>`,
  )

async function sheets(ctx) {
  const dir = join(ctx.EVIDENCE, 'workbench-palette')
  mkdirSync(dir, { recursive: true })
  const stories = storiesOf(ctx.listed)
  for (const surface of SURFACES) {
    const mine = stories.filter((s) => s.id.match(STORY_ID)[1] === surface)
    if (!mine.length) continue
    const { width, height } = mine[0].viewport
    const cellW = 640
    const cellH = Math.round((height * cellW) / width)
    const columns = 2
    const gap = 8
    const rows = Math.ceil(mine.length / columns)
    const composite = []
    for (const [i, story] of mine.entries()) {
      const file = ctx.renderPath(story.id)
      if (!existsSync(file)) continue
      const left = (i % columns) * (cellW + gap)
      const top = Math.floor(i / columns) * (cellH + 22 + gap)
      composite.push({ input: labelSvg(`${story.id.match(STORY_ID)[2]}  (/story/${story.id})`, cellW), left, top })
      composite.push({ input: await sharp(file).resize(cellW, cellH).png().toBuffer(), left, top: top + 22 })
    }
    const out = join(dir, `${surface}.png`)
    await sharp({ create: { width: columns * cellW + (columns - 1) * gap, height: rows * (cellH + 22 + gap), channels: 4, background: '#000' } })
      .composite(composite)
      .png()
      .toFile(out)
    console.log(`${surface}: ${out}`)
  }
}

// --- the face (AC-27's theme half) ------------------------------------------------------------------

/** The Theo panel's status row and the face's perch, in CSS pixels, with what the face is doing. */
const faceGeometry = (page) =>
  page.evaluate(async () => {
    const perch = document.querySelector('[data-face-perch="terminal"]')
    const r = perch?.getBoundingClientRect()
    const grid = document.querySelector('[id$=_ratzilla_grid]')
    const pres = [...grid.querySelectorAll(':scope > pre')]
    const row = r ? pres.find((p) => { const b = p.getBoundingClientRect(); return b.top <= r.top + 1 && b.bottom >= r.bottom - 1 }) : undefined
    const b = row?.getBoundingClientRect()
    const { theFace } = await import('/src/lib/face/store.ts')
    const state = theFace().state()
    const cells = row ? [...row.children].map((s) => s.textContent).join('').trim() : null
    return {
      perch: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      row: b ? { y: b.y, height: b.height, x: b.x, width: b.width } : null,
      rowText: cells,
      surface: perch?.dataset.faceSurface ?? null,
      ink: perch?.dataset.faceInk ?? null,
      face: { liveness: state.liveness, asleep: state.asleep, doing: state.doing, form: state.form?.name ?? null, working: theFace().working },
    }
  })

/** The plate and the eyes as painted: the face's pixels at a high device scale, the plate the commonest colour that is not the surface. */
async function eyesOnPlate(ctx, story, geometry, png) {
  const image = PNG.sync.read(png)
  const dpr = image.width / story.viewport.width
  const p = geometry.perch
  const counts = new Map()
  const x0 = Math.floor(p.x * dpr)
  const y0 = Math.floor(p.y * dpr)
  for (let y = y0; y < Math.min(image.height, Math.ceil((p.y + p.height) * dpr)); y++)
    for (let x = x0; x < Math.min(image.width, Math.ceil((p.x + p.width) * dpr)); x++) {
      const at = (y * image.width + x) * 4
      const hex = hexOf([image.data[at], image.data[at + 1], image.data[at + 2]])
      counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
  const surface = geometry.surface
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const plate = sorted.find(([hex]) => hex !== surface && wcagContrast(hex, surface) > 2)?.[0]
  if (!plate) return { plate: undefined, eyes: undefined, histogram: sorted.slice(0, 6) }
  // The eyes: the commonest colour on the plate that is dark against it (anti-aliased edge pixels are rarer than the fill).
  const eyes = sorted.find(([hex, n]) => n >= 20 && hex !== surface && wcagContrast(hex, plate) > 3)?.[0]
  return { plate, eyes, histogram: sorted.slice(0, 8) }
}

async function face(ctx) {
  const stories = storiesOf(ctx.listed).filter((s) => s.id.match(STORY_ID)[1] === 'face')
  const profiles = stories.map((s) => s.id.match(STORY_ID)[2])
  const observations = {}
  const records = []
  mkdirSync(capturedDir(ctx), { recursive: true })
  // Per profile: the face on its plate, eyes against plate; one page session then switches through every other profile live.
  for (const story of stories) {
    const profile = story.id.match(STORY_ID)[2]
    await ctx.withPage(story, async (page) => {
      await page.waitForTimeout(800)
      const before = await faceGeometry(page)
      if (!before.face.working) throw new Error(`${story.id}: Theo is not working before the switch (${before.face.liveness}); the measurement would be vacuous`)
      const png = await page.screenshot({ path: ctx.renderPath(story.id), clip: { x: 0, y: 0, ...story.viewport } })
      const eyes = await eyesOnPlate(ctx, story, before, png)
      const model = await page.evaluate(async ([surface, ink]) => {
        const { terminalFace } = await import('/src/components/face/terminal-face.ts')
        return terminalFace(surface, ink)
      }, [before.surface, before.ink])
      records.push({ profile, story: story.id, geometry: before, eyes, model })
      const git = gitState()
      if (eyes.plate && eyes.eyes) {
        observations[`eyes-${profile}`] = {
          kind: 'rendered_web',
          foreground: eyes.eyes,
          background: eyes.plate,
          provenance: { story: story.id, method: "the face's perch cells in the screenshot: plate the commonest non-surface colour, eyes the most contrasting solid colour on it", surface: before.surface, plate_expected_ink: before.ink, model_eyes_on_body: model.eyesOnBody, model_body_on_surface: model.bodyOnSurface },
        }
      }
      // The live switch: this one page session goes through every other profile with Theo working.
      const steps = []
      let current = await faceGeometry(page)
      for (const next of profiles.filter((p) => p !== profile)) {
        await page.evaluate((id) => window.__setPaletteProfile(id), next)
        await page.waitForTimeout(700)
        const after = await faceGeometry(page)
        steps.push({ from: records.at(-1).profile, to: next, before: current, after })
        current = after
      }
      records.at(-1).switches = steps
      void git
    }, { deviceScaleFactor: 3 })
  }
  // The switch observations: before and after of every step, as the evaluator's state_invariant reads them.
  const geometry = (g) => ({ row: g.row, perch: g.perch })
  const faceState = (g) => ({ liveness: g.face.liveness, asleep: g.face.asleep, working: g.face.working, form: g.face.form })
  const switched = records.flatMap((r) => (r.switches ?? []).map((s) => ({ profile: r.profile, ...s })))
  const worst = (key, pick) => {
    const first = switched[0]
    return first && pick(first)
  }
  void worst
  switched.forEach((s, i) => {
    observations[`switch-geometry-${i}`] = {
      kind: 'interaction',
      before: geometry(s.before),
      after: geometry(s.after),
      provenance: { page_session: s.profile, from: s.from, to: s.to, method: 'perch and status row rects before and after window.__setPaletteProfile, one page session, Theo working' },
    }
    observations[`switch-state-${i}`] = {
      kind: 'interaction',
      before: faceState(s.before),
      after: faceState(s.after),
      provenance: { page_session: s.profile, from: s.from, to: s.to, method: "theFace().state() before and after the switch" },
    }
  })
  const policy = JSON.parse(readFileSync(join(ctx.EVIDENCE, 'oracles/workbench-palette.policy.json'), 'utf8'))
  const checks = []
  for (const profile of profiles)
    checks.push({ ...policy.checks.find((c) => c.id === 'WB-FACE-01.eyes-on-plate'), id: `WB-FACE-01.eyes-on-plate.${profile}`, observation: `eyes-${profile}` })
  switched.forEach((_, i) => {
    checks.push({ ...policy.checks.find((c) => c.id === 'WB-FACE-02.status-row-geometry'), id: `WB-FACE-02.status-row-geometry.${i}`, observation: `switch-geometry-${i}` })
    checks.push({ ...policy.checks.find((c) => c.id === 'WB-FACE-03.expression-kept'), id: `WB-FACE-03.expression-kept.${i}`, observation: `switch-state-${i}` })
  })
  const effective = { ...policy, name: `${policy.name}:face`, checks }
  const dir = join(ctx.EVIDENCE, 'oracles/effective')
  mkdirSync(dir, { recursive: true })
  const git = gitState()
  const evidence = { source_revision: `${git.head}${git.dirty ? '+worktree' : ''}`, fixture: 'workbench-palette-face-*', environment: { surface: 'face', profiles, date: new Date().toISOString().slice(0, 10), viewport_css_px: stories[0].viewport }, observations }
  const policyPath = join(dir, 'workbench-palette-face.policy.json')
  const evidencePath = join(dir, 'workbench-palette-face.observations.json')
  writeFileSync(policyPath, JSON.stringify(effective, null, 2) + '\n')
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, records }, null, 2) + '\n')
  writeFileSync(join(capturedDir(ctx), 'workbench-palette-face.json'), JSON.stringify({ ...evidence, records }, null, 2) + '\n')
  const out = join(ctx.EVIDENCE, 'oracles/workbench-palette-face.report.json')
  const { report } = runEvaluator(policyPath, evidencePath, out)
  console.log(`face: ${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const r of report.results.filter((x) => x.status !== 'pass')) console.log(`  ${r.status} ${r.id} ${JSON.stringify(r.detail)}`)
}

export async function paletteCommand(ctx, [sub, ...rest]) {
  if (sub === 'capture') return capture(ctx, rest[0] ?? 'all', rest[1])
  if (sub === 'evaluate') return evaluate(ctx)
  if (sub === 'sheets') return sheets(ctx)
  if (sub === 'face') return face(ctx)
  throw new Error('palette: capture <surface|all> [profile] | evaluate | sheets | face')
}
