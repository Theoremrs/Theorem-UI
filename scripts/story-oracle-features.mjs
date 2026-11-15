// SOURCING: none — scenarios for the feature stories in components/workbench/workbench-feature-stories.tsx, kept in a module of their own so the shared oracle takes one line instead of six long scenarios. They run through `node scripts/story-oracle.mjs interact <id>` exactly as the others do: the oracle hands over its helpers (`scenarios(h)`), `page.keyboard` does every press, and `page.evaluate` only reads (the semantic tree, the whole effects the story keeps on `window`).
//
// Requirement and acceptance ids are from docs/plans/theo-workbench: R43 (Theia migration gate) with AC-54 and AC-60 and
// parity row P12 (Follow agent and selection-to-chat); R19 and AC-22 with P08 (history and source references); R48 and
// AC-59 (registered alternate presentation); R17 and AC-19 (delegation changes are Changes' read-only cousin); R19 with
// AC-54 and P02/P05 (search and replace); R34 (actions carry actor identity), R38 (keyboard), R40 (content boundaries).

/** The characters that must never reach the page raw: controls (but not the new line) and the bidirectional controls. */
export const RAW_HOSTILE = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/

export function scenarios(h) {
  const { pageText, has, sees, hasWrapped, recordEffects, effectsSince, snap, layoutOf, CHORD } = h

  /** The core's semantic tree nodes, read off the mounted handle. */
  const nodes = (page) => page.evaluate(() => window.__workbenchTree().nodes)
  const node = async (page, suffix) => (await nodes(page)).find((n) => n.id === suffix || n.id.endsWith(`/${suffix}`) || n.id.endsWith(suffix))
  /** Every effect the core has asked the host for, whole. */
  const effects = (page) => page.evaluate(() => window.__workbenchEffectLog.map((e) => ({ kind: e.kind, payload: e.payload, actor: e.actor ?? null, path: e.resource?.resourceId ?? null })))
  const composer = async (page) => (await node(page, 'p1/composer:text'))?.text ?? null
  const status = async (page, id) => (await node(page, `${id}/status`))?.name ?? ''
  /** Real key presses with a short rest after each. */
  const keys = async (page, ...names) => {
    for (const name of names) {
      await page.keyboard.press(name)
      await page.waitForTimeout(120)
    }
  }
  /** Files by its chord, then its tree by keys: docs is opened, then `downs` rows down from it and Enter opens that file. */
  const openFromDocs = async (page, downs, tab) => {
    await page.keyboard.press(`${CHORD}e`)
    await page.waitForTimeout(700)
    // Files lands on its first row when it takes focus: docs is one row down.
    await keys(page, 'ArrowDown', 'Enter')
    await sees(page, 'guide.md', 6000)
    await page.waitForTimeout(300)
    for (let i = 0; i < downs; i++) await keys(page, 'ArrowDown')
    await keys(page, 'Enter')
    await sees(page, `${tab} ×`, 6000)
    await page.waitForTimeout(500)
  }
  /** The Theo group's composer takes the keyboard (Focus the group to the left), the words are typed and Enter sends. */
  const sendFromComposer = async (page, words) => {
    await page.keyboard.press(`${CHORD}ArrowLeft`)
    await page.waitForTimeout(300)
    await page.keyboard.type(words, { delay: 15 })
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
  }
  const control = (page, name) => page.evaluate((n) => document.querySelector(`[data-story-control="${n}"]`)?.click(), name)
  /** The follow status node of the semantic tree: its words, the actions it enables and why a disabled one is. */
  const followNode = async (page) => {
    const n = await node(page, 'follow')
    return {
      name: n?.name ?? null,
      enabled: (n?.actions ?? []).filter((a) => a.enabled).map((a) => a.id),
      reasonOfPause: (n?.actions ?? []).find((a) => a.id === 'follow.pause' && !a.enabled)?.reason ?? null,
    }
  }
  /** The text of the right-most pane read down its rows and joined (a line it wraps is one again), whatever the panes to its left draw. */
  const rightPane = async (page) =>
    (await pageText(page))
      .split('\n')
      .map((l) => l.split('\u2502').pop().trim())
      .join(' ')
      .replace(/\s+/g, ' ')
  const hasRight = async (page, needle) => (await rightPane(page)).includes(needle)
  /** A real mouse press on a tab of the first row of the grid, found by its words (the tab row is drawn as cells). */
  const clickTab = async (page, name) => {
    const point = await page.evaluate((n) => {
      const cells = [...document.querySelector('[id$=_ratzilla_grid]').children[0].children]
      const at = cells.map((c) => c.textContent || ' ').join('').indexOf(n)
      const box = cells[at + 1].getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }, name)
    await page.mouse.click(point.x, point.y)
    await page.waitForTimeout(500)
  }
  /** A node of the Search panel by its name in the panel (`status`, `query`, `replacement`, `replace-lines`, ...). */
  const searchNode = async (page, name) => {
    const region = await node(page, 'search')
    const id = `${region.id.split('/')[0]}/${name}`
    return (await nodes(page)).find((n) => n.id === id)
  }
  /** Types the query in Search's Find field and presses Enter; the status line it ends on. */
  const searchFor = async (page, query) => {
    await page.waitForTimeout(500)
    await sees(page, 'Replace', 8000)
    await page.keyboard.type(query, { delay: 20 })
    await page.keyboard.press('Enter')
    await sees(page, 'matches in', 8000)
    await page.waitForTimeout(400)
    return (await searchNode(page, 'status'))?.name
  }
  const sends = async (page) => (await effects(page)).filter((e) => e.kind === 'conversationSend')

  // The same texts the story holds (workbench-feature-stories.tsx), to compare an excerpt with the file it came from.
  const LONG = `${Array.from({ length: 3 }, (_, i) => `${i + 1} ${'word '.repeat(400)}`.trimEnd()).join('\n')}\n`
  const HOSTILE_LINE = 'esc \u001b[31m red ‮ gnp.txt ⁦ isolate ⁩ end'

  return {
    // Add Selection to chat: R43 / AC-54 / AC-60 (parity P12 "selection-to-chat"), R40 for hostile text.
    'workbench-add-selection': [
      // The editor: no selection, a selection by keyboard, a reference token showing the start line, the send.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 3, 'lines.txt')
        await recordEffects(page)
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(500)
        const noSelectionNotice = await has(page, 'added docs/lines.txt:1 to the message')
        const noSelectionText = await composer(page)
        const quiet = (await effectsSince(page)).length === 0
        const stayed = (await layoutOf(page)).focused === 'lines.txt'
        await snap(page, 'workbench-add-selection-no-selection')
        // Down twice to line 3, then three lines selected with Shift+Down.
        await keys(page, 'ArrowDown', 'ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowDown')
        const selected = (await status(page, 'p4')).includes('72 selected')
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(500)
        const notice = await has(page, 'added docs/lines.txt:3-5 to the message')
        const text = await composer(page)
        const stillQuiet = (await effectsSince(page)).length === 0
        await snap(page, 'workbench-add-selection-editor')
        await sendFromComposer(page, 'explain these')
        const sent = await sends(page)
        const [first, second] = sent[0]?.payload.references ?? []
        await snap(page, 'workbench-add-selection-sent')
        return {
          'editor, no selection: Alt+Q says the caret line was added, "added docs/lines.txt:1 to the message"': noSelectionNotice,
          'editor, no selection: the composer holds the token @docs/lines.txt:1': noSelectionText === '@docs/lines.txt:1 ',
          'editor: Alt+Q asks the host for nothing and sends nothing': quiet,
          'editor: the keyboard stays in the editor tab after Alt+Q': stayed,
          'editor: three lines selected by Shift+Down (72 selected in the status)': selected,
          'editor, selection: Alt+Q says "added docs/lines.txt:3-5 to the message"': notice,
          'editor, selection: the token shows the start line only, @docs/lines.txt:3, after the first token': text === '@docs/lines.txt:1 @docs/lines.txt:3 ',
          'editor: a second Alt+Q still asks the host for nothing': stillQuiet,
          'send: exactly one conversationSend, carrying two references': sent.length === 1 && sent[0].payload.references?.length === 2,
          'send: the text is the two tokens and the typed words': sent[0]?.payload.text === '@docs/lines.txt:1 @docs/lines.txt:3 explain these',
          'send: the first reference has the file, the caret line as range and the label docs/lines.txt:1': first?.path === 'docs/lines.txt' && first.range?.start.line === 0 && first.label === 'docs/lines.txt:1' && first.excerpt?.startsWith('Line 1: a fixture line.'),
          'send: the second names path, 0-based range 2:0 to 5:0, the label 3-5 and the selected text': second?.path === 'docs/lines.txt' && JSON.stringify(second.range) === JSON.stringify({ start: { line: 2, character: 0 }, end: { line: 5, character: 0 } }) && second.label === 'docs/lines.txt:3-5' && second.excerpt === 'Line 3: a fixture line.\nLine 4: a fixture line.\nLine 5: a fixture line.\n',
          'send: the composer is empty afterwards': (await composer(page)) === '',
        }
      },
      // A selection over the 4096-character excerpt limit: the range names all of it, the excerpt is the first 4096.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 4, 'long.txt')
        await keys(page, `${CHORD.replace('+Alt+', '')}+a`)
        const selected = (await status(page, 'p4')).includes('6006 selected')
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(600)
        const notice = await has(page, 'added the first 4096 characters of docs/long.txt:1-3')
        await snap(page, 'workbench-add-selection-over-limit')
        await sendFromComposer(page, 'x')
        const ref = (await sends(page))[0]?.payload.references?.[0]
        return {
          'over the limit: the whole file is selected (6006 selected)': selected,
          'over the limit: Alt+Q says the first 4096 characters of docs/long.txt:1-3 were added': notice,
          'over the limit: the range still names the whole selection, 0:0 to 3:0': JSON.stringify(ref?.range) === JSON.stringify({ start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }),
          'over the limit: the excerpt is cut to 4096 characters': ref?.excerpt?.length === 4096,
          'over the limit: the excerpt is the first 4096 characters of the file, unchanged': ref?.excerpt === LONG.slice(0, 4096),
        }
      },
      // Hostile text in the selection: nothing raw reaches the page; the wire keeps the text as it is.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 2, 'hostile.txt')
        await keys(page, 'ArrowDown', 'Home', 'Shift+End')
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(600)
        const text = await pageText(page)
        const row = text.split('\n').map((l) => l.split('│').pop().trim()).find((l) => /^2 esc/.test(l)) ?? ''
        await snap(page, 'workbench-add-selection-hostile')
        const composerText = await composer(page)
        const rawInTree = (await nodes(page)).some((n) => [n.name, n.text].some((v) => RAW_HOSTILE.test(v ?? '')))
        await sendFromComposer(page, 'x')
        const ref = (await sends(page))[0]?.payload.references?.[0]
        return {
          'hostile text: the line is shown with a stand-in for each hidden character and the selection added (token @docs/hostile.txt:2)': row === '2 esc \u241b[31m red \u25af gnp.txt \u25af isolate \u25af end' && composerText === '@docs/hostile.txt:2 ',
          'hostile text: no raw control or bidirectional character is in the page text': !RAW_HOSTILE.test(text),
          'hostile text: no node name or text in the semantic tree has one either': !rawInTree,
          'hostile text: the send carries the selected line exactly as it is, escape and overrides included': ref?.excerpt === HOSTILE_LINE && ref.label === 'docs/hostile.txt:2',
        }
      },
      // A file whose own name has a right-to-left override: the Files tree spells it; the editor tab, the notice and the composer must too.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 5, 'trickytxt.cod')
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(600)
        const text = await pageText(page)
        await snap(page, 'workbench-add-selection-hostile-name')
        const list = await nodes(page)
        const raw = (s) => RAW_HOSTILE.test(s ?? '')
        const rawNode = (n) => raw(n.name) || raw(n.text)
        return {
          'hostile name: the Files row spells the override, tricky\\u{202e}txt.cod': text.includes('tricky\\u{202e}txt.cod'),
          'hostile name: the composer token has no raw override': !raw(await composer(page)),
          'hostile name: the "added ... to the message" notice has no raw override': !raw(text),
          'hostile name: no node name or text in the semantic tree has a raw override': !list.some(rawNode),
        }
      },
      // The Markdown panel: markdown.addSelection from Source mode (a selection) and Visual mode (the open block's caret).
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 1, 'guide.md')
        await recordEffects(page)
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(600)
        const visualNotice = await has(page, 'added docs/guide.md:4 to the message')
        const visualText = await composer(page)
        await snap(page, 'workbench-add-selection-markdown-visual')
        await keys(page, 'Alt+2')
        await page.waitForTimeout(400)
        await keys(page, 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowDown')
        await page.keyboard.press('Alt+q')
        await page.waitForTimeout(600)
        const notice = await has(page, 'added docs/guide.md:6-7 to the message')
        const text = await composer(page)
        const quiet = (await effectsSince(page)).length === 0
        await snap(page, 'workbench-add-selection-markdown-source')
        await sendFromComposer(page, 'about this')
        const refs = (await sends(page))[0]?.payload.references ?? []
        return {
          'markdown, Visual: Alt+Q adds the open block (front matter) at its caret line, "added docs/guide.md:4 to the message"': visualNotice && visualText === '@docs/guide.md:4 ',
          'markdown, Source: two lines selected with Shift+Down, Alt+Q says "added docs/guide.md:6-7 to the message"': notice,
          'markdown, Source: the token shows the start line, @docs/guide.md:6': text === '@docs/guide.md:4 @docs/guide.md:6 ',
          'markdown: Alt+Q asks the host for nothing': quiet,
          'markdown send: the references are the two, in order, with path docs/guide.md': refs.length === 2 && refs.every((r) => r.path === 'docs/guide.md'),
          'markdown send: the Source one has range 5:0 to 7:0, the label 6-7 and the selected text': JSON.stringify(refs[1]?.range) === JSON.stringify({ start: { line: 5, character: 0 }, end: { line: 7, character: 0 } }) && refs[1]?.label === 'docs/guide.md:6-7' && refs[1]?.excerpt === '# Workbench guide\n\n',
        }
      },
    ],
    // Follow the agent: R34 (the actor on an action), R43 / AC-54 (parity P12 "Follow agent"), AC-60 (reveal without focus).
    'workbench-follow': [
      // The person's navigation pauses follow; resume turns it on; a run's edit is shown in a panel the person is not in.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 5, 'trace.txt')
        await page.keyboard.press(`${CHORD}ArrowLeft`)
        await page.waitForTimeout(400)
        const focusedTheo = (await layoutOf(page)).focused === 'Theo'
        await control(page, 'follow-r1')
        await page.waitForTimeout(300)
        const paused = await followNode(page)
        await recordEffects(page)
        await control(page, 'r1-edits-trace')
        await page.waitForTimeout(800)
        const pausedText = await pageText(page)
        const pausedKinds = await effectsSince(page)
        await snap(page, 'workbench-follow-paused')
        await page.keyboard.press(`${CHORD}F6`)
        await page.waitForTimeout(400)
        const resumed = await followNode(page)
        await recordEffects(page)
        await control(page, 'r1-edits-trace-end')
        await page.waitForTimeout(1000)
        const shown = await pageText(page)
        const rows = shown.split('\n').map((l) => l.split('│').pop().trim())
        await snap(page, 'workbench-follow-revealed')
        const stillTheo = (await layoutOf(page)).focused === 'Theo'
        await page.keyboard.type('still here', { delay: 15 })
        await page.waitForTimeout(300)
        const typed = await composer(page)
        const layout = await layoutOf(page)
        const shownKinds = await effectsSince(page)
        // A run nobody follows moves nothing: the view does not go back to the top for its edit at line 3.
        await control(page, 'r2-edits-trace-top')
        await page.waitForTimeout(800)
        const other = await pageText(page)
        return {
          'the person is in the Theo group (the keyboard is in the composer)': focusedTheo,
          'moving there paused follow: "Follow paused" with follow.resume enabled and follow.pause disabled': paused.name === 'Follow paused' && paused.enabled.join() === 'follow.resume' && paused.reasonOfPause === 'Already in that state',
          'a followed run named while paused shows nothing: no row of Trace 45 on the page': !/^45 /m.test(pausedText.split('\n').map((l) => l.split('│').pop().trim()).join('\n')) && !pausedText.includes('AGENT Trace 45'),
          'a paused follow opens and closes nothing: the only effect of the edit is the language owner asking for its diagnostics': pausedKinds.length > 0 && pausedKinds.every((k) => k === 'languageDiagnostics'),
          'follow.resume by its chord says "Following 1 run" with follow.pause enabled': resumed.name === 'Following 1 run' && resumed.enabled.join() === 'follow.pause',
          'the followed run edit is shown without moving the keyboard: line 52 reads "AGENT Trace 52" in the editor': rows.includes('52 AGENT Trace 52: a line of the work.'),
          'the edit made while follow was paused was heard all the same: line 45 reads "AGENT Trace 45" now the view is there': rows.includes('45 AGENT Trace 45: a line of the work.'),
          'the editor tab is still trace.txt and the Theo group still has the keyboard': stillTheo && layout.groups.some((g) => g.tabs.includes('trace.txt')),
          'typing lands in the composer, the keyboard never left it': typed === 'still here',
          'showing the edit opens and closes nothing: only the diagnostics ask': shownKinds.length > 0 && shownKinds.every((k) => k === 'languageDiagnostics'),
          'an edit of a run nobody follows moves nothing: the view is still on the end and line 3 is not shown': other.includes('52 AGENT Trace 52') && !other.includes('3 AGENT Trace 3'),
        }
      },
      // A file with no panel gets one, unfocused; the next replaces it; the focused panel's own file is not moved.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 5, 'trace.txt')
        await page.keyboard.press(`${CHORD}ArrowLeft`)
        await page.waitForTimeout(400)
        await control(page, 'follow-r1')
        await page.keyboard.press(`${CHORD}F6`)
        await page.waitForTimeout(400)
        await recordEffects(page)
        await control(page, 'r1-edits-other')
        await page.waitForTimeout(1200)
        const first = await layoutOf(page)
        const firstText = await pageText(page)
        const firstKinds = (await effectsSince(page)).filter((k) => k.startsWith('document'))
        await snap(page, 'workbench-follow-opened')
        await recordEffects(page)
        await control(page, 'r1-edits-extra')
        await page.waitForTimeout(1200)
        const second = await layoutOf(page)
        const secondKinds = (await effectsSince(page)).filter((k) => k.startsWith('document'))
        const secondText = await pageText(page)
        await snap(page, 'workbench-follow-replaced')
        await page.keyboard.type('hello', { delay: 15 })
        await page.waitForTimeout(300)
        const typed = await composer(page)
        const tabs = (l) => l.groups.flatMap((g) => g.tabs)
        return {
          'a followed file with no panel opens one: other.txt is a tab and its edited line 52 is on the page': tabs(first).includes('other.txt') && /52 AGENT Other 52/.test(firstText),
          'the keyboard stayed in the Theo group when it opened': first.focused === 'Theo',
          'opening it asked the document owner to open it, once': firstKinds.join() === 'documentOpen',
          'the next followed file replaces that preview: extra.txt is a tab, other.txt is not, trace.txt (the person own) stays': tabs(second).includes('extra.txt') && !tabs(second).includes('other.txt') && tabs(second).includes('trace.txt'),
          'the replaced preview was closed through the owner before the new one opened: documentClose, documentOpen': secondKinds.join() === 'documentClose,documentOpen',
          'the new preview shows its edit, line 48 reads "AGENT Extra 48"': /48 AGENT Extra 48/.test(secondText),
          'the keyboard is still in the composer: typing lands there': second.focused === 'Theo' && typed === 'hello',
        }
      },
      // The focused panel is never given the reveal; pause by chord; the agent's tab focus does not pause (stated in Rust, not driven here).
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 5, 'trace.txt')
        await control(page, 'follow-r1')
        await page.waitForTimeout(300)
        const pausedByOpening = await followNode(page)
        await page.keyboard.press(`${CHORD}F6`)
        await page.waitForTimeout(400)
        const on = await followNode(page)
        await control(page, 'r1-edits-trace')
        await page.waitForTimeout(900)
        const text = await pageText(page)
        const top = text.split('\n').map((l) => l.split('│').pop().trim())
        await snap(page, 'workbench-follow-focused')
        // The edit reached the buffer, though the view did not move: walk the caret down to it.
        for (let i = 0; i < 44; i++) await page.keyboard.press('ArrowDown')
        await page.waitForTimeout(700)
        const walked = (await pageText(page)).split('\n').map((l) => l.split('│').pop().trim())
        const stillOn = await followNode(page)
        await page.keyboard.press(`${CHORD}F5`)
        await page.waitForTimeout(400)
        const off = await followNode(page)
        return {
          'opening a file with the keys is navigation: follow is paused until it is resumed': pausedByOpening.name === 'Follow paused',
          'follow.resume by chord turns it on while the editor holds the keyboard': on.name === 'Following 1 run',
          'the focused editor was not moved: its first row is still line 1': top.includes('1 Trace 1: a line of the work.') && !top.includes('45 AGENT Trace 45: a line of the work.'),
          'it still heard the edit: walking the caret to line 45 shows "45 AGENT Trace 45"': walked.includes('45 AGENT Trace 45: a line of the work.'),
          'typing keys in the focused panel does not pause follow': stillOn.name === 'Following 1 run',
          'follow.pause by chord says "Follow paused" and enables follow.resume': off.name === 'Follow paused' && off.enabled.join() === 'follow.resume',
        }
      },
    ],
    // Document history: R19 / AC-22 (parity P08). Alt+V, the points listed and previewed, a restore asked first, refused when it must be.
    'workbench-document-history': [
      // The whole path by keys: list, preview, ask, back out at each stage, restore.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 3, 'lines.txt')
        const mark = async () => (await effects(page)).length
        const since = async (from) => (await effects(page)).slice(from).filter((e) => e.kind !== 'languageDiagnostics')
        let from = await mark()
        await page.keyboard.press('Alt+v')
        await sees(page, 'History of docs/lines.txt', 6000)
        await sees(page, 'A later draft', 6000)
        await page.waitForTimeout(300)
        const opened = await since(from)
        const previewOfLater = (await hasRight(page, 'Past version, revision 2')) && (await hasRight(page, 'A later draft'))
        const text = await pageText(page)
        await snap(page, 'workbench-document-history-open')
        from = await mark()
        await keys(page, 'ArrowDown')
        await page.waitForTimeout(400)
        const down = await since(from)
        const older = await pageText(page)
        await snap(page, 'workbench-document-history-preview')
        from = await mark()
        await keys(page, 'Enter')
        await page.waitForTimeout(500)
        const asked = await since(from)
        const question = await hasRight(page, 'Restore the document to revision 1? The text in the editor is replaced by that version.')
        const buttons = await has(page, '[Restore Enter] [Dismiss Esc]')
        await snap(page, 'workbench-document-history-ask')
        from = await mark()
        await keys(page, 'Escape')
        await page.waitForTimeout(400)
        const backedOut = await since(from)
        const stillOpen = await has(page, 'History of docs/lines.txt')
        const questionGone = !(await hasRight(page, 'Restore the document to revision 1?'))
        await keys(page, 'Escape')
        await page.waitForTimeout(400)
        const closed = !(await has(page, 'History of docs/lines.txt'))
        const closedKinds = await since(from)
        // Again, and this time Enter twice.
        await page.keyboard.press('Alt+v')
        await sees(page, 'History of docs/lines.txt', 6000)
        await page.waitForTimeout(500)
        await keys(page, 'ArrowDown')
        await page.waitForTimeout(400)
        from = await mark()
        await keys(page, 'Enter')
        await page.waitForTimeout(400)
        const askedAgain = await since(from)
        await keys(page, 'Enter')
        await page.waitForTimeout(1200)
        const restored = await since(from)
        const after = await pageText(page)
        await snap(page, 'workbench-document-history-restored')
        const kinds = (list) => list.map((e) => e.kind).join()
        return {
          'Alt+V opens the drawer and asks the owner for the list and then the newest point: documentHistoryList, documentHistoryPreview h2': kinds(opened) === 'documentHistoryList,documentHistoryPreview' && opened[1].payload.point === 'h2',
          'the drawer lists "Revision 2" selected and "Revision 1 (this text\'s revision)"': /> Revision 2/.test(text) && text.includes('Revision 1 (this text\'s revision)'),
          'the preview says it is a past version, read-only, and shows "A later draft"': previewOfLater,
          'Down chooses the older point and asks for its preview only: documentHistoryPreview h1': kinds(down) === 'documentHistoryPreview' && down[0].payload.point === 'h1' && older.includes('An earlier draft'),
          'Enter asks first, with the exact question and its two buttons, and sends nothing': question && buttons && asked.length === 0,
          'Esc backs out of the question and nothing is sent': backedOut.length === 0 && stillOpen && questionGone,
          'Esc again closes the drawer, still nothing sent': closed && closedKinds.length === 0,
          'asking again sends nothing': askedAgain.length === 0,
          'Enter on the question restores: one documentHistoryRestore for h1 and no other effect': kinds(restored) === 'documentHistoryRestore' && restored[0].payload.point === 'h1',
          'the editor shows the restored text, "An earlier draft", and the drawer is gone': after.includes('An earlier draft') && !after.includes('History of docs/lines.txt'),
        }
      },
      // Refused while typing is unaccepted: the owner has not answered an edit, so nothing is restored.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 3, 'lines.txt')
        await page.keyboard.type('Z', { delay: 20 })
        await page.waitForTimeout(900)
        const from = (await effects(page)).length
        await page.keyboard.press('Alt+v')
        await sees(page, 'History of docs/lines.txt', 6000)
        await page.waitForTimeout(500)
        await keys(page, 'ArrowDown')
        await page.waitForTimeout(400)
        await keys(page, 'Enter')
        await page.waitForTimeout(700)
        const refused = await hasRight(page, 'Restore this version: There is typing the owner has not accepted (sent, held, unknown or recovered); it has to be sent, saved or discarded first, so nothing is restored.')
        const asked = await hasRight(page, 'Restore the document to revision 1?')
        const sent = (await effects(page)).slice(from).filter((e) => e.kind === 'documentHistoryRestore')
        await snap(page, 'workbench-document-history-refused')
        await keys(page, 'Escape')
        await page.waitForTimeout(400)
        const closed = !(await has(page, 'History of docs/lines.txt'))
        return {
          'a character typed and not accepted: Enter on a point says "Restore this version: There is typing the owner has not accepted ..." in full': refused,
          'no question is asked': !asked,
          'no documentHistoryRestore is sent': sent.length === 0,
          'Esc closes the drawer': closed,
        }
      },
      // An agent asking for the restore through the agent entry is refused as human-only; the drawer does not move.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 3, 'lines.txt')
        await page.keyboard.press('Alt+v')
        await sees(page, 'History of docs/lines.txt', 6000)
        await page.waitForTimeout(500)
        await keys(page, 'ArrowDown')
        await page.waitForTimeout(400)
        const panel = (await nodes(page)).find((n) => n.id.endsWith('/history'))?.id.split('/')[0]
        const from = (await effects(page)).length
        const restore = JSON.parse(await page.evaluate((p) => window.__workbenchAgentAct('document.restore', 'r1', p), panel))
        const confirm = JSON.parse(await page.evaluate((p) => window.__workbenchAgentAct('document.restoreConfirm', 'r1', p), panel))
        await page.waitForTimeout(600)
        const sent = (await effects(page)).slice(from).filter((e) => e.kind !== 'languageDiagnostics')
        const asked = await hasRight(page, 'Restore the document to revision 1?')
        const said = await hasRight(page, 'is for a person to do. Agent run r1 asked for it.')
        await snap(page, 'workbench-document-history-agent')
        const still = await has(page, 'History of docs/lines.txt')
        return {
          'document.restore by an agent is refused with code human_only': restore.outcome === 'refused' && restore.code === 'human_only',
          'its reason says it is for a person to do and names the run': restore.reason === '"document.restore" is for a person to do. Agent run r1 asked for it.',
          'document.restoreConfirm by an agent is refused with code human_only': confirm.outcome === 'refused' && confirm.code === 'human_only',
          'the refusal is on the page for the person to read': said,
          'no restore is asked and none is sent: no question on the page, no effect': !asked && sent.length === 0,
          'the drawer is still open on the person\'s choice': still,
        }
      },
    ],
    // Registered alternate presentations: R48 / AC-59 (a panel kind that can show a resource, chosen and swapped in place).
    'workbench-presentation': [
      // The Show as chooser and the next presentation, both ways, in place.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 3, 'lines.txt')
        // The guide is opened after it, so its tab has a neighbour on its left to keep its place by.
        await page.keyboard.press(`${CHORD}e`)
        await page.waitForTimeout(500)
        await keys(page, 'ArrowUp', 'Enter')
        await sees(page, 'guide.md \u00d7', 6000)
        await page.waitForTimeout(500)
        const tab = async () => (await nodes(page)).find((n) => n.role === 'tab' && n.name === 'guide.md')
        const where = async () => {
          const l = await layoutOf(page)
          const group = l.groups.findIndex((g) => g.tabs.includes('guide.md'))
          const tabs = (l.groups[group]?.tabs ?? []).filter((t) => t !== 'Add tool')
          return { group, at: tabs.indexOf('guide.md'), tabs: tabs.join(), focused: l.focused }
        }
        const kindsSince = async (from) => (await effects(page)).slice(from).map((e) => e.kind).filter((k) => k !== 'languageDiagnostics')
        const initial = await tab()
        const startedAt = await where()
        let from = (await effects(page)).length
        await page.keyboard.press(`${CHORD}F7`)
        await sees(page, 'Show as', 6000)
        await page.waitForTimeout(400)
        const chooser = await rightPane(page)
        await snap(page, 'workbench-presentation-chooser')
        await keys(page, 'Escape')
        await page.waitForTimeout(400)
        const closedChooser = !(await has(page, 'Show as')) && (await kindsSince(from)).length === 0
        // Choose the editor: Down to "Page", Enter.
        await page.keyboard.press(`${CHORD}F7`)
        await sees(page, 'Show as', 6000)
        const rowsBefore = (await nodes(page)).filter((n) => n.role === 'menuItem' && /\/row-/.test(n.id))
        await keys(page, 'ArrowLeft', 'Enter')
        await sees(page, '2 title: Workbench guide', 6000)
        await page.waitForTimeout(400)
        const toEditor = await tab()
        const editorAt = await where()
        const editorKinds = await kindsSince(from)
        const editorText = await rightPane(page)
        const editorBound = (await nodes(page)).some((n) => n.id.endsWith('/text') && n.name === 'docs/guide.md')
        await snap(page, 'workbench-presentation-editor')
        // The chooser again: the mark is on Page now. Down twice to Markdown.
        from = (await effects(page)).length
        await page.keyboard.press(`${CHORD}F7`)
        await sees(page, 'Show as', 6000)
        await page.waitForTimeout(400)
        const marked = await rightPane(page)
        const rowsAfter = (await nodes(page)).filter((n) => n.role === 'menuItem' && /\/row-/.test(n.id))
        await keys(page, 'ArrowRight', 'Enter')
        await sees(page, '[Visual] [Source] [Split] [Preview]', 6000)
        await page.waitForTimeout(400)
        const toMarkdown = await tab()
        const markdownAt = await where()
        const markdownKinds = await kindsSince(from)
        await snap(page, 'workbench-presentation-markdown')
        // The next presentation, there and back.
        from = (await effects(page)).length
        await page.keyboard.press(`${CHORD}F8`)
        await sees(page, '2 title: Workbench guide', 6000)
        await page.waitForTimeout(400)
        const nextOne = await tab()
        const nextAt = await where()
        await page.keyboard.press(`${CHORD}F8`)
        await sees(page, '[Visual] [Source] [Split] [Preview]', 6000)
        await page.waitForTimeout(400)
        const nextTwo = await tab()
        const nextKinds = await kindsSince(from)
        const usable = (n, id) => n.actions.find((a) => a.id === id)
        return {
          'a Markdown document opens in the Markdown panel: its tab says "Shown as Markdown (version 1)"': initial.state.description === 'Shown as Markdown (version 1)',
          'its tab offers panel.presentation, panel.presentation.next and use:document, and use:markdown is disabled as already shown': !!usable(initial, 'panel.presentation')?.enabled && !!usable(initial, 'panel.presentation.next')?.enabled && !!usable(initial, 'panel.presentation.use:document')?.enabled && usable(initial, 'panel.presentation.use:markdown')?.enabled === false && usable(initial, 'panel.presentation.use:markdown')?.reason === 'Already shown this way.',
          'the chooser is headed "Show as" and lists Page and Markdown with the mark on Markdown': chooser.includes('Show as') && chooser.includes('Page ● Markdown'),
          'Esc leaves the chooser and nothing is sent': closedChooser,
          'the chooser opens with the cursor on the one showing now, Markdown (the selected row)': rowsBefore.map((r) => `${r.name}:${r.state.selected}`).join() === 'Page:false,Markdown:true',
          'Left to Page and Enter swaps to the editor: the document shows its numbered source': /1 --- 2 title: Workbench guide/.test(editorText),
          'the swap is in place: the same tab in the same group at the same position, the keyboard still on it': editorAt.group === startedAt.group && editorAt.at === startedAt.at && startedAt.tabs === 'lines.txt,guide.md' && editorAt.tabs === startedAt.tabs && editorAt.focused === 'guide.md' && startedAt.focused === 'guide.md',
          'the tab now says "Shown as Page (version 1)" and the editor is bound to docs/guide.md': toEditor.state.description === 'Shown as Page (version 1)' && editorBound,
          'the effects of the swap are a close then an open and nothing else': editorKinds.join() === 'documentClose,documentOpen',
          'the chooser now opens on Page, and marks it, with Markdown listed unmarked': marked.includes('● Page') && !marked.includes('● Markdown') && marked.includes('Markdown') && rowsAfter.map((r) => `${r.name}:${r.state.selected}`).join() === 'Page:true,Markdown:false',
          'choosing Markdown swaps back in place, again a close then an open': markdownAt.group === startedAt.group && markdownAt.at === startedAt.at && markdownAt.focused === 'guide.md' && toMarkdown.state.description === 'Shown as Markdown (version 1)' && markdownKinds.join() === 'documentClose,documentOpen',
          'panel.presentation.next swaps to the editor and again to Markdown, in place': nextOne.state.description === 'Shown as Page (version 1)' && nextAt.group === startedAt.group && nextAt.at === startedAt.at && nextTwo.state.description === 'Shown as Markdown (version 1)',
          'the two swaps made two closes and two opens, in order': nextKinds.join() === 'documentClose,documentOpen,documentClose,documentOpen',
        }
      },
      // Unsaved changes: the swap is refused with its reason and nothing is sent.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 2, 'guide.md')
        await page.keyboard.press(`${CHORD}F8`)
        await sees(page, '2 title: Workbench guide', 6000)
        await page.waitForTimeout(400)
        await page.keyboard.type('Z', { delay: 20 })
        await page.waitForTimeout(800)
        const modified = (await layoutOf(page)).groups.flatMap((g) => g.tabs).some((t) => t.includes('guide.md'))
        const tabBefore = (await nodes(page)).find((n) => n.role === 'tab' && n.name === 'guide.md')
        const from = (await effects(page)).length
        await page.keyboard.press(`${CHORD}F8`)
        await page.waitForTimeout(700)
        const notice = (await node(page, 'notice'))?.name ?? ''
        const kinds = (await effects(page)).slice(from).map((e) => e.kind)
        const text = await rightPane(page)
        const tabAfter = (await nodes(page)).find((n) => n.role === 'tab' && n.name === 'guide.md')
        await snap(page, 'workbench-presentation-refused')
        return {
          'a character typed in the editor presentation leaves the tab modified': modified && tabBefore.state.modified === true,
          'panel.presentation.next is refused with its reason: "This panel has changes that are not saved. Save or discard them before showing the document another way."': notice === 'This panel has changes that are not saved. Save or discard them before showing the document another way.',
          'the refusal asks the host for nothing: no close, no open': !kinds.includes('documentClose') && !kinds.includes('documentOpen'),
          'the document is still shown as the editor with its typed character': tabAfter.state.description === 'Shown as Page (version 1)' && /1 ZTitle|1 Z---|1 Z/.test(text),
        }
      },
      // A document that only the editor can show lists only the editor.
      async (page) => {
        await page.waitForTimeout(500)
        await openFromDocs(page, 3, 'lines.txt')
        const tab = (await nodes(page)).find((n) => n.role === 'tab' && n.name === 'lines.txt')
        await page.keyboard.press(`${CHORD}F7`)
        await sees(page, 'Show as', 6000)
        await page.waitForTimeout(400)
        const chooser = await rightPane(page)
        const chooserRows = (await nodes(page)).filter((n) => n.role === 'menuItem' && /\/row-/.test(n.id))
        await snap(page, 'workbench-presentation-only-editor')
        await keys(page, 'Escape')
        await page.waitForTimeout(300)
        const from = (await effects(page)).length
        await page.keyboard.press(`${CHORD}F8`)
        await page.waitForTimeout(600)
        const notice = (await node(page, 'notice'))?.name ?? ''
        const kinds = (await effects(page)).slice(from).map((e) => e.kind)
        return {
          'a text file\'s tab says "Shown as Page (version 1)"': tab.state.description === 'Shown as Page (version 1)',
          'the chooser lists the editor, marked, and no Markdown row': chooser.includes('Show as') && chooser.includes('● Page') && !chooser.includes('Markdown') && chooserRows.map((r) => r.name).join() === 'Page',
          'its tab disables panel.presentation.next with "No other presentation can show this document."': tab.actions.find((a) => a.id === 'panel.presentation.next')?.reason === 'No other presentation can show this document.' && tab.actions.find((a) => a.id === 'panel.presentation.next')?.enabled === false,
          'panel.presentation.next by its chord says so in a notice and sends nothing': notice === 'No other presentation can show this document.' && kinds.length === 0,
        }
      },
    ],
    // Delegation changes panel: R17 (a read-only panel bound to a delegation resource), AC-19 (the changes are Changes' read-only cousin),
    // R40 for hostile path text. The panel comes back on screen from a saved layout (the compiled Theo panel has no delegation list yet).
    // The first way in (R17): Theo lists the conversation's delegations; Alt+D, the arrows and Enter open one.
    'workbench-delegation-from-chat': [
      async (page) => {
        await page.waitForTimeout(500)
        await sees(page, 'Delegations (2)', 8000)
        const rows = async () => (await nodes(page)).filter((n) => n.role === 'listItem' && /\/d:d[12]$/.test(n.id))
        const before = await rows()
        const list = (await nodes(page)).find((n) => n.role === 'list' && n.name === 'Delegations')
        const mark = (await effects(page)).length
        await page.keyboard.press('Alt+d')
        await page.waitForTimeout(250)
        const entered = await rows()
        await keys(page, 'ArrowDown')
        const down = await rows()
        await keys(page, 'ArrowUp')
        const up = await rows()
        const quiet = (await effects(page)).slice(mark).map((e) => e.kind)
        await snap(page, 'workbench-delegation-from-chat-list')
        await keys(page, 'Enter')
        await sees(page, 'files changed', 8000)
        await page.waitForTimeout(300)
        const all = await nodes(page)
        const tab = all.find((n) => n.role === 'tab' && n.binding?.type === 'delegation')
        const region = all.find((n) => n.role === 'region' && n.name === 'Delegation changes')
        const reads = (await effects(page)).slice(mark).filter((e) => e.kind === 'delegationChanges')
        await snap(page, 'workbench-delegation-from-chat-open')
        return {
          'Theo lists the two delegations as a list named "Delegations", each bound to its run and delegation': list?.state?.description?.includes('Alt+D') === true && before.length === 2 && before[0].binding.delegationId === 'd1' && before[0].binding.runId === 'run-1' && before[1].binding.delegationId === 'd2' && before[1].setSize === 2,
          'before Alt+D no row is selected': before.every((n) => !n.state.selected),
          'Alt+D takes the keys into the list: the first row is selected and focused': entered[0].state.selected === true && entered[0].state.focused === true && !entered[1].state.selected,
          'Down chooses the second, Up the first again': down[1].state.selected === true && !down[0].state.selected && up[0].state.selected === true,
          'choosing asks the host for nothing': quiet.every((k) => k === 'layoutSave'),
          'Enter opens a tab of kind delegation bound to run-1 and d1, with the keyboard': tab?.binding?.runId === 'run-1' && tab.binding.delegationId === 'd1' && tab.state.focused === true && tab.state.selected === true,
          'the panel is the read-only changes region and lists the changed files': region?.binding?.delegationId === 'd1' && (await hasRight(page, 'files changed. Enter shows a file')),
          'opening asked the host for that delegation\'s changes once, with the two ids': reads.length === 1 && reads[0].payload.runId === 'run-1' && reads[0].payload.delegationId === 'd1',
        }
      },
    ],
    'workbench-delegation': [
      // The panel, its list, and what it offers.
      async (page) => {
        await page.waitForTimeout(500)
        await sees(page, 'Changes by delegation', 8000)
        await sees(page, 'files changed', 8000)
        await page.waitForTimeout(300)
        const before = (await effects(page)).map((e) => e.kind)
        await clickTab(page, 'Changes by delegation')
        const tab = (await nodes(page)).find((n) => n.role === 'tab' && n.name === 'Changes by delegation')
        const region = await node(page, 'delegation')
        const all = await nodes(page)
        const panelId = region.id.split('/')[0]
        const mine = all.filter((n) => n.id.startsWith(`${panelId}/`))
        const items = mine.filter((n) => n.role === 'listItem')
        const text = await rightPane(page)
        const catalogue = (await page.evaluate(() => window.__workbenchCatalog())).filter((a) => a.panel === 'delegation')
        const offered = [...new Set(mine.flatMap((n) => n.actions.map((a) => a.id)))].sort()
        const kinds = (await effects(page)).map((e) => e.kind)
        const reads = (await effects(page)).filter((e) => e.kind === 'delegationChanges')
        await snap(page, 'workbench-delegation-list')
        return {
          'the panel is a tab of kind delegation bound to run-1 and d1, read from the saved layout': tab?.binding?.type === 'delegation' && tab.binding.runId === 'run-1' && tab.binding.delegationId === 'd1' && region.binding.delegationId === 'd1' && before.includes('layoutLoad'),
          'the panel is a region named "Delegation changes" and has the keyboard after a click on its tab': region?.name === 'Delegation changes' && tab.state.focused === true && tab.state.selected === true,
          'the list names every changed file with its letter: M, A, D, M (binary), M, A, M, A': ['M src/lib.ts', 'A src/new.ts', 'D src/old.ts', 'M assets/logo.png (binary)', 'M src/gone.ts', 'A src/long.ts'].every((row) => text.includes(row)),
          'the status says "8 files changed. Enter shows a file\'s before and after."': text.includes("8 files changed. Enter shows a file's before and after."),
          'the tree has eight list items with the words "modified", "added", "deleted" and "binary", the first selected': items.length === 8 && items[0].name === 'src/lib.ts, modified' && items[0].state.selected === true && items[1].name === 'src/new.ts, added' && items[2].name === 'src/old.ts, deleted' && /binary/.test(items[3].name) && items.slice(1).every((n) => !n.state.selected) && items[0].setSize === 8 && items[7].posInSet === 8,
          'the list asked the host for the delegation\'s changes once, with the two ids': reads.length === 1 && reads[0].payload.runId === 'run-1' && reads[0].payload.delegationId === 'd1',
          'no other effect than the layout read, the file list and that one read so far': kinds.every((k) => ['layoutLoad', 'filesList', 'delegationChanges', 'layoutSave'].includes(k)),
          'its catalogue is the five actions refresh, open, back, next and previous, none human-only': catalogue.map((a) => a.action).sort().join() === 'delegation.back,delegation.next,delegation.open,delegation.previous,delegation.refresh' && catalogue.every((a) => a.humanOnly === false),
          'no catalogue entry or node action in the panel can change anything: only intents "start" (a read) and "local"': catalogue.every((a) => ['start', 'local'].includes(a.intent)) && offered.every((id) => ['delegation.open', 'delegation.refresh', 'delegation.back'].includes(id)) && !catalogue.some((a) => /save|edit|delete|discard|restore|apply|commit|stage|revert|accept|write|send/.test(a.action)),
        }
      },
      // Enter shows the before and after, Esc goes back, and the next and previous actions move.
      async (page) => {
        await page.waitForTimeout(500)
        await sees(page, 'files changed', 8000)
        await clickTab(page, 'Changes by delegation')
        const selected = async () => (await nodes(page)).filter((n) => n.role === 'listItem' && n.state.selected).map((n) => n.name)
        const first = await selected()
        await keys(page, 'ArrowDown')
        const down = await selected()
        await keys(page, 'ArrowUp')
        const up = await selected()
        await keys(page, 'j', 'j')
        const j = await selected()
        await keys(page, 'k')
        const k = await selected()
        await keys(page, 'ArrowUp')
        await recordEffects(page)
        await keys(page, 'Enter')
        await sees(page, '-export const answer = 41', 6000)
        await page.waitForTimeout(300)
        const diff = await rightPane(page)
        const diffNode = await node(page, 'delegation/diff')
        const reads = (await effectsSince(page)).slice()
        const full = (await effects(page)).filter((e) => e.kind === 'delegationContent')
        await snap(page, 'workbench-delegation-diff')
        await keys(page, 'Escape')
        await page.waitForTimeout(300)
        const back = await rightPane(page)
        const afterBack = await selected()
        // The agent entry: the same two moves by action id, and the panel's own id to aim them.
        const panelId = (await node(page, 'delegation')).id.split('/')[0]
        const act = (action) => page.evaluate(([a, p]) => JSON.parse(window.__workbenchAgentAct(a, 'run-agent', p)), [action, panelId])
        const nextOutcome = await act('delegation.next')
        await page.waitForTimeout(250)
        const agentNext = await selected()
        const previousOutcome = await act('delegation.previous')
        await page.waitForTimeout(250)
        const agentPrevious = await selected()
        return {
          'the cursor starts on the first file': first.join() === 'src/lib.ts, modified',
          'Down moves it to the next file, Up back': down.join() === 'src/new.ts, added' && up.join() === 'src/lib.ts, modified',
          'j and k move it too: j j lands on the third, k on the second': j.join() === 'src/old.ts, deleted' && k.join() === 'src/new.ts, added',
          'Enter on src/lib.ts shows the file with its before and after, as a diff': diff.includes('src/lib.ts') && diff.includes('@@ -1 +1 @@') && diff.includes('-export const answer = 41') && diff.includes('+export const answer = 42'),
          'the diff is a document node named for the file': diffNode?.role === 'document' && diffNode.name === 'Before and after of src/lib.ts',
          'Enter asked the host for the file\'s before and after, in that order, and nothing else': reads.join() === 'delegationContent,delegationContent' && full.slice(-2).map((e) => e.payload.side).join() === 'before,after' && full.slice(-2).every((e) => e.payload.path === 'src/lib.ts' && e.payload.runId === 'run-1' && e.payload.delegationId === 'd1'),
          'Esc goes back to the list of changed files, the cursor on the file just left': back.includes("8 files changed. Enter shows a file's before and after.") && !back.includes('-export const answer = 41') && afterBack.join() === 'src/lib.ts, modified',
          'delegation.next by the agent entry moves to the next file, with no effect': nextOutcome.outcome === 'accepted' && nextOutcome.effects === 0 && agentNext.join() === 'src/new.ts, added',
          'delegation.previous by the agent entry moves back': previousOutcome.outcome === 'accepted' && previousOutcome.effects === 0 && agentPrevious.join() === 'src/lib.ts, modified',
        }
      },
      // A missing side is said in words; a binary file is not shown.
      async (page) => {
        await page.waitForTimeout(500)
        await sees(page, 'files changed', 8000)
        await clickTab(page, 'Changes by delegation')
        const open = async (downs) => {
          for (let i = 0; i < downs; i++) await keys(page, 'ArrowDown')
          const from = (await effects(page)).length
          await keys(page, 'Enter')
          await page.waitForTimeout(700)
          const text = await rightPane(page)
          const sides = (await effects(page)).slice(from).filter((e) => e.kind === 'delegationContent').map((e) => e.payload.side)
          await keys(page, 'Escape')
          await page.waitForTimeout(250)
          return { text, sides }
        }
        // The cursor is on src/lib.ts; each open leaves it where it was.
        const added = await open(1)
        const deleted = await open(1)
        await snap(page, 'workbench-delegation-deleted')
        const binary = await open(1)
        const gone = await open(1)
        await snap(page, 'workbench-delegation-no-such-side')
        return {
          'an added file says "There is no before: the file did not exist, so every line is new." and shows the after': added.text.includes('src/new.ts') && added.text.includes('There is no before: the file did not exist, so every line is new.') && added.text.includes('+export const added = true'),
          'an added file asked the host for its after only': added.sides.join() === 'after',
          'a deleted file says "There is no after: the file was removed, so every line is gone." and shows the before': deleted.text.includes('src/old.ts') && deleted.text.includes('There is no after: the file was removed, so every line is gone.') && deleted.text.includes('-export const removed = true'),
          'a deleted file asked the host for its before only': deleted.sides.join() === 'before',
          'a binary file says "This file is binary: not shown as text." and asked the host for nothing': binary.text.includes('assets/logo.png') && binary.text.includes('This file is binary: not shown as text.') && binary.sides.length === 0,
          'a side the owner refuses says so: "Before: The file has no such side." with the code, and still shows the after': gone.text.includes('src/gone.ts') && gone.text.includes('Before: The file has no such side. (no_such_side: No before content)') && gone.text.includes('After: 1 lines') && gone.text.includes('export const kept = 1'),
          'a file the owner can answer for on both sides asked for both, before first': gone.sides.join() === 'before,after',
        }
      },
      // A long diff is scrolled by the keys; hostile path text is escaped; a long path wraps.
      async (page) => {
        await page.waitForTimeout(500)
        await sees(page, 'files changed', 8000)
        await clickTab(page, 'Changes by delegation')
        const compact = async () => (await rightPane(page)).replace(/\s+/g, '')
        // The hostile path and the long path, from the list.
        const listText = await rightPane(page)
        const listCompact = await compact()
        const itemNames = (await nodes(page)).filter((n) => n.role === 'listItem').map((n) => n.name)
        const wholeText = await pageText(page)
        const rawInList = RAW_HOSTILE.test(wholeText)
        // src/long.ts (index 5): scroll with the keys.
        for (let i = 0; i < 5; i++) await keys(page, 'ArrowDown')
        await keys(page, 'Enter')
        await sees(page, 'export const line1 = 1', 6000)
        const top = await rightPane(page)
        await keys(page, 'ArrowDown', 'ArrowDown', 'j')
        const three = await rightPane(page)
        await keys(page, 'PageDown')
        const paged = await rightPane(page)
        await keys(page, 'End')
        const end = await rightPane(page)
        await keys(page, 'Home')
        const home = await rightPane(page)
        await keys(page, 'Escape')
        // The hostile one (index 6): its diff carries hostile text on both sides.
        await keys(page, 'ArrowDown')
        await keys(page, 'Enter')
        await sees(page, 'before \\u{202e} text', 6000)
        const hostile = await rightPane(page)
        const hostileCompact = await compact()
        const hostileTree = (await nodes(page)).filter((n) => n.id.includes('/delegation'))
        const hostilePage = await pageText(page)
        await snap(page, 'workbench-delegation-hostile')
        await keys(page, 'Escape')
        // The long path (index 7), its diff.
        await keys(page, 'ArrowDown')
        await keys(page, 'Enter')
        await sees(page, 'export const deep = 1', 6000)
        const longDiff = await compact()
        await snap(page, 'workbench-delegation-long-path')
        const path = `src/${'deeply-nested-directory/'.repeat(6)}file.ts`
        return {
          'the list spells the right-to-left override and the escape as text: src/evil\\u{202e}txt.ts\\u{1b}[31m': listText.includes('src/evil\\u{202e}txt.ts\\u{1b}[31m'),
          'no control or bidirectional character reaches the page from the list': !rawInList,
          'the tree names the hostile file with the escapes spelled out and no raw character': itemNames.some((n) => n === 'src/evil\\u{202e}txt.ts\\u{1b}[31m, modified') && !itemNames.some((n) => RAW_HOSTILE.test(n)),
          'a path longer than the pane wraps in the list and is all there: no character lost': listCompact.includes(path.replace(/\s+/g, '')),
          'long.ts opens at its first line, 80 lines of it': top.includes('@@ -0,0 +1,80 @@') && top.includes('export const line1 = 1') && !top.includes('line60 = 60'),
          'two Downs and a j scroll the diff by three lines: the title and the words are gone, the hunk heading is at the top': !three.includes('src/long.ts') && three.includes('@@ -0,0 +1,80 @@') && three.includes('export const line1 = 1'),
          'PageDown scrolls a page: the hunk heading is gone and later lines show': !paged.includes('@@ -0,0 +1,80 @@') && paged.includes('export const line10 = 10'),
          'End shows the last line of the file': end.includes('export const line80 = 80'),
          'Home shows the first line again': home.includes('export const line1 = 1'),
          'the hostile file\'s diff spells both sides: "before \\u{202e} text" and "after \\u{1b}[31m text"': hostile.includes('before \\u{202e} text') && hostile.includes('after \\u{1b}[31m text'),
          'the hostile file\'s title in the diff is escaped and no raw character reaches the page': hostileCompact.includes('src/evil\\u{202e}txt.ts\\u{1b}[31m') && !RAW_HOSTILE.test(hostilePage) && !hostileTree.some((n) => RAW_HOSTILE.test(`${n.name} ${n.text ?? ''}`)),
          'the long path wraps in the diff title and is all there, with its text after it': longDiff.includes(path.replace(/\s+/g, '')) && longDiff.includes('exportconstdeep=1'),
        }
      },
      // Nothing in the panel changes anything: keys that would, in an editor or in Changes, do nothing; the only effects are the two reads.
      async (page) => {
        await page.waitForTimeout(500)
        await sees(page, 'files changed', 8000)
        await clickTab(page, 'Changes by delegation')
        await recordEffects(page)
        // The notice the saved layout left on the status row fades by itself; it is not the panel.
        const body = async () => (await rightPane(page)).replace('Layout: The saved layout applied', '').trim()
        const textBefore = await body()
        await keys(page, 's', 'd', 'a', 'x', 'u', 'Delete', 'Backspace', 'Meta+s', 'Control+s', 'Alt+Enter')
        const typed = await body()
        const quietList = await effectsSince(page)
        await keys(page, 'Enter')
        await page.waitForTimeout(500)
        const inFile = (await effectsSince(page)).filter((k) => k !== 'delegationContent')
        const diffBefore = await body()
        await keys(page, 's', 'd', 'a', 'x', 'u', 'Delete', 'Backspace', 'Meta+s', 'Control+s', 'Alt+Enter')
        const diffAfter = await body()
        await keys(page, 'Escape')
        // r reads the changes again: one more delegationChanges.
        const beforeR = (await effectsSince(page)).filter((k) => k === 'delegationChanges').length
        await keys(page, 'r')
        await page.waitForTimeout(500)
        const afterR = (await effectsSince(page)).filter((k) => k === 'delegationChanges').length
        const panelId = (await node(page, 'delegation')).id.split('/')[0]
        const refresh = await page.evaluate((p) => JSON.parse(window.__workbenchAgentAct('delegation.refresh', 'run-agent', p)), panelId)
        await page.waitForTimeout(400)
        const kinds = await effectsSince(page)
        const all = (await effects(page)).map((e) => e.kind)
        const composerAfter = await composer(page)
        await snap(page, 'workbench-delegation-read-only')
        return {
          'in the list, keys that would save, stage, delete, discard or undo do nothing: the panel is unchanged': typed === textBefore,
          'in the list they ask the host for nothing': quietList.length === 0,
          'Enter then asks only for the two reads of the file': inFile.length === 0 && (await effects(page)).filter((e) => e.kind === 'delegationContent').length === 2,
          'in the diff the same keys change nothing and ask nothing': diffAfter === diffBefore,
          'r reads the delegation\'s changes again: one more delegationChanges and nothing else': afterR === beforeR + 1,
          'delegation.refresh by the agent entry is accepted and is the same read': refresh.outcome === 'accepted' && refresh.effects === 1,
          'across the whole scenario the only effects after the panel opened are delegationChanges and delegationContent': kinds.every((k) => k === 'delegationChanges' || k === 'delegationContent') && kinds.length >= 4,
          'the whole run never asked for a document, a save, a file change, a terminal or a send': !all.some((k) => /^(document|scm|files(Create|Rename|Copy|Delete)|terminal|conversationSend|run)/.test(k)),
          'nothing was typed into the composer': (composerAfter ?? '') === '',
        }
      },
    ],
    // Replace across the workspace in Search: R19 (search and replace), parity P05 and P07; the question, the one-file-at-a-time run,
    // the skip of a dirty file, the stop between files and the human-only refusal are the requirement's own words.
    'workbench-replace': [
      // Ask: count, preview and the exact question; Esc cancels with nothing sent; Enter asks again and Enter confirms; the run's effects in order.
      async (page) => {
        const found = await searchFor(page, 'zorp')
        await recordEffects(page)
        await page.keyboard.press('Tab')
        await page.keyboard.type('ZED', { delay: 20 })
        const typed = (await searchNode(page, 'replacement'))?.text
        await page.keyboard.press('Enter')
        await sees(page, 'Enter replaces and saves each file', 6000)
        await page.waitForTimeout(300)
        const question = (await searchNode(page, 'status'))?.name
        const preview = (await nodes(page)).filter((n) => /\/replace-line:\d+$/.test(n.id)).map((n) => n.name)
        const list = await searchNode(page, 'replace-lines')
        const lockedQuery = await searchNode(page, 'query')
        const replaceAll = await searchNode(page, 'replace-all')
        const asked = await effectsSince(page)
        await snap(page, 'workbench-replace-question')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
        const cancelled = (await searchNode(page, 'status'))?.name
        const afterCancel = await effectsSince(page)
        await snap(page, 'workbench-replace-cancelled')
        // Enter in the Replace field asks again; Enter answers the question.
        await page.keyboard.press('Enter')
        await sees(page, 'Enter replaces and saves each file', 6000)
        await page.keyboard.press('Enter')
        await sees(page, 'files changed', 10_000)
        await page.waitForTimeout(500)
        const all = (await effects(page)).filter((e) => /^document/.test(e.kind))
        const order = all.map((e) => `${e.kind}:${e.path}`)
        const alphaEdit = all.find((e) => e.kind === 'documentEdit' && e.path === 'docs/alpha.txt')
        const summary = (await searchNode(page, 'status'))?.name
        const lines = (await nodes(page)).filter((n) => /\/replace-line:\d+$/.test(n.id)).map((n) => n.name)
        await snap(page, 'workbench-replace-summary')
        // The summary stays until dismissed.
        await page.waitForTimeout(1500)
        const stays = (await searchNode(page, 'status'))?.name === summary
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
        const dismissed = (await searchNode(page, 'status'))?.name
        // The owner's text changed: searching for the replacement finds it in the three files that were written, not the dirty one.
        await keys(page, 'Shift+Tab', 'End', 'Backspace', 'Backspace', 'Backspace', 'Backspace')
        await page.keyboard.type('zed', { delay: 20 })
        await page.keyboard.press('Enter')
        await sees(page, 'in 3 files', 6000)
        const again = (await searchNode(page, 'status'))?.name
        return {
          'the search found 7 matches in 4 files': found === '7 matches in 4 files.',
          'Tab then typing puts ZED in the Replacement field': typed === 'ZED',
          'Enter asks the exact question with the counts and the replacement: Replace 7 matches in 4 files with "ZED"? Enter replaces and saves each file, one at a time. Esc cancels.': question === 'Replace 7 matches in 4 files with "ZED"? Enter replaces and saves each file, one at a time. Esc cancels.',
          'the preview is a list "Replace preview" with each file, its matches, the line before (-) and after (+)': list?.name === 'Replace preview' && preview[0] === 'docs/alpha.txt (3 matches)' && preview[1] === '  1 - Zorp one and zorp two share a line.' && preview[2] === '    + ZED one and ZED two share a line.' && preview.includes('docs/gamma.txt (2 matches)') && preview.includes('    + last ZED'),
          'while asked, Find and Replace are locked and replace-all says so': lockedQuery?.state.disabled === true && /Locked while a replace/.test(lockedQuery.state.description) && replaceAll.actions.some((a) => a.id === 'search.replaceAll' && !a.enabled && a.reason === 'A replace is waiting for your answer.'),
          'asking sends nothing to the host': asked.length === 0,
          'Esc cancels: the results line is back and nothing was sent': cancelled === '7 matches in 4 files.' && afterCancel.length === 0,
          'Enter asks again and Enter confirms: a summary of 3 files changed (6 matches), 1 skipped': summary === '3 files changed (6 matches), 1 skipped, 0 failed, 0 unknown. Enter or Esc dismisses this.',
          'the files are opened, edited, saved and closed one at a time, in the order of the results; the dirty file is opened and closed, never edited': order.join() === 'documentOpen:docs/alpha.txt,documentEdit:docs/alpha.txt,documentSave:docs/alpha.txt,documentClose:docs/alpha.txt,documentOpen:docs/beta.txt,documentEdit:docs/beta.txt,documentSave:docs/beta.txt,documentClose:docs/beta.txt,documentOpen:docs/dirty.txt,documentClose:docs/dirty.txt,documentOpen:docs/gamma.txt,documentEdit:docs/gamma.txt,documentSave:docs/gamma.txt,documentClose:docs/gamma.txt',
          'one edit per file carries all of its changes, in UTF-16 units, at the right offsets': alphaEdit?.payload.unit === 'utf16' && JSON.stringify(alphaEdit.payload.edits) === JSON.stringify([{ start: 0, end: 4, insert: 'ZED' }, { start: 13, end: 17, insert: 'ZED' }, { start: 57, end: 61, insert: 'ZED' }]),
          'the summary lists what changed and the dirty file skipped with the owner\'s words': lines.join('|') === 'Changed 3:|  docs/alpha.txt: 3 matches replaced and saved|  docs/beta.txt: 1 match replaced and saved|  docs/gamma.txt: 2 matches replaced and saved|Skipped 1:|  docs/dirty.txt: it has unsaved changes (the owner reports it dirty)',
          'the summary stays on screen until it is dismissed': stays,
          'Esc dismisses the summary': dismissed !== summary && !/files changed/.test(dismissed ?? ''),
          'searching for ZED afterwards finds 6 matches in 3 files: the owner\'s text was changed, the dirty file was not': again === '6 matches in 3 files.',
        }
      },
      // Locked while it runs; Esc stops between files; the summary says what did not start.
      async (page) => {
        await control(page, 'slow-saves')
        await searchFor(page, 'zorp')
        await page.keyboard.press('Tab')
        await page.keyboard.type('ZED', { delay: 20 })
        await page.keyboard.press('Enter')
        await sees(page, 'Enter replaces and saves each file', 6000)
        await page.keyboard.press('Enter')
        await sees(page, 'Replacing, file 1 of 4', 6000)
        await page.waitForTimeout(500)
        const running = (await searchNode(page, 'status'))?.name
        const progress = (await nodes(page)).filter((n) => /\/replace-line:\d+$/.test(n.id)).map((n) => n.name)
        const listName = (await searchNode(page, 'replace-lines'))?.name
        await snap(page, 'workbench-replace-running')
        await page.keyboard.type('QQ', { delay: 20 })
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Tab')
        await page.waitForTimeout(300)
        const query = (await searchNode(page, 'query'))
        const replacement = (await searchNode(page, 'replacement'))
        const stillRunning = (await searchNode(page, 'status'))?.name
        const midway = (await effects(page)).filter((e) => /^document/.test(e.kind)).map((e) => `${e.kind}:${e.path}`)
        await page.keyboard.press('Escape')
        await sees(page, 'not started', 10_000)
        await page.waitForTimeout(500)
        const summary = (await searchNode(page, 'status'))?.name
        const lines = (await nodes(page)).filter((n) => /\/replace-line:\d+$/.test(n.id)).map((n) => n.name)
        const order = (await effects(page)).filter((e) => /^document/.test(e.kind)).map((e) => `${e.kind}:${e.path}`)
        await snap(page, 'workbench-replace-stopped')
        await page.waitForTimeout(1500)
        const stays = (await searchNode(page, 'status'))?.name === summary
        await page.keyboard.press('Enter')
        await page.waitForTimeout(400)
        const dismissed = (await searchNode(page, 'status'))?.name
        await control(page, 'fast-saves')
        return {
          'while it runs the status says "Replacing, file 1 of 4. Esc stops after this file. Find and Replace are locked until it ends, so the matches stay as you confirmed."': running === 'Replacing, file 1 of 4. Esc stops after this file. Find and Replace are locked until it ends, so the matches stay as you confirmed.',
          'the progress list names the file in hand and how many wait': listName === 'Replace progress' && progress.includes('Now, file 1 of 4: docs/alpha.txt') && progress.includes('3 more files waiting.'),
          'the first file is open and being saved when the person presses keys: opened and edited, the save answer is slow': midway.join() === 'documentOpen:docs/alpha.txt,documentEdit:docs/alpha.txt,documentSave:docs/alpha.txt',
          'typing, Backspace and Tab while it runs change neither field: the Find field still says zorp and the Replacement ZED': query?.text === 'zorp' && replacement?.text === 'ZED' && query.state.disabled === true && replacement.state.disabled === true,
          'and the run is still running': stillRunning === running,
          'Esc stops it after the file in hand: 1 file changed (3 matches), 3 not started, "Stopped by you; what was done stays done."': summary === '1 file changed (3 matches), 0 skipped, 0 failed, 0 unknown, 3 not started. Stopped by you; what was done stays done. Enter or Esc dismisses this.',
          'the summary lists the unstarted files: beta, dirty and gamma': lines.join('|') === 'Changed 1:|  docs/alpha.txt: 3 matches replaced and saved|Not started 3:|  docs/beta.txt|  docs/dirty.txt|  docs/gamma.txt',
          'only the file in hand was worked on: open, edit, save, close for alpha, nothing for the others': order.join() === 'documentOpen:docs/alpha.txt,documentEdit:docs/alpha.txt,documentSave:docs/alpha.txt,documentClose:docs/alpha.txt',
          'the summary stays until dismissed, and Enter dismisses it': stays && !/files? changed/.test(dismissed ?? ''),
        }
      },
      // Alt+Enter replaces in the selected file only.
      async (page) => {
        await searchFor(page, 'zorp')
        await page.keyboard.press('Tab')
        await page.keyboard.type('ZED', { delay: 20 })
        // Replace, Include, Exclude, then the results; Down six times lands in docs/gamma.txt.
        await keys(page, 'Tab', 'Tab', 'Tab', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown')
        await recordEffects(page)
        await page.keyboard.press('Alt+Enter')
        await sees(page, 'Enter replaces and saves each file', 6000)
        await page.waitForTimeout(300)
        const question = (await searchNode(page, 'status'))?.name
        const preview = (await nodes(page)).filter((n) => /\/replace-line:\d+$/.test(n.id)).map((n) => n.name)
        const asked = await effectsSince(page)
        await snap(page, 'workbench-replace-in-file')
        await page.keyboard.press('Enter')
        await sees(page, 'file changed', 10_000)
        await page.waitForTimeout(400)
        const summary = (await searchNode(page, 'status'))?.name
        const order = (await effects(page)).filter((e) => /^document/.test(e.kind)).map((e) => `${e.kind}:${e.path}`)
        return {
          'Alt+Enter asks about the selected result\'s file only: Replace 2 matches in 1 file (docs/gamma.txt) with "ZED"? Enter replaces and saves each file, one at a time. Esc cancels.': question === 'Replace 2 matches in 1 file (docs/gamma.txt) with "ZED"? Enter replaces and saves each file, one at a time. Esc cancels.',
          'the preview shows that file only': preview.join('|') === 'docs/gamma.txt (2 matches)|  1 - gamma: zorp|    + gamma: ZED|  2 - last zorp|    + last ZED',
          'asking sends nothing': asked.length === 0,
          'Enter replaces: "1 file changed (2 matches)"': summary === '1 file changed (2 matches), 0 skipped, 0 failed, 0 unknown. Enter or Esc dismisses this.',
          'only gamma was opened, edited, saved and closed': order.join() === 'documentOpen:docs/gamma.txt,documentEdit:docs/gamma.txt,documentSave:docs/gamma.txt,documentClose:docs/gamma.txt',
        }
      },
      // An agent asking for the replace is refused: it is for the person to do.
      async (page) => {
        await searchFor(page, 'zorp')
        await page.keyboard.press('Tab')
        await page.keyboard.type('ZED', { delay: 20 })
        const panelId = (await node(page, 'search')).id.split('/')[0]
        const act = (action) => page.evaluate(([a, p]) => JSON.parse(window.__workbenchAgentAct(a, 'run-agent', p)), [action, panelId])
        const catalogue = (await page.evaluate(() => window.__workbenchCatalog())).filter((a) => a.action.startsWith('search.'))
        const humanOnly = catalogue.filter((a) => a.humanOnly).map((a) => a.action).sort().join()
        await recordEffects(page)
        const statusBefore = (await searchNode(page, 'status'))?.name
        const all = await act('search.replaceAll')
        const inFile = await act('search.replaceInFile')
        await page.waitForTimeout(400)
        const statusAfter = (await searchNode(page, 'status'))?.name
        // The question is open (by the person); the agent cannot confirm it.
        await page.keyboard.press('Enter')
        await sees(page, 'Enter replaces and saves each file', 6000)
        const confirm = await act('search.replaceConfirm')
        await page.waitForTimeout(500)
        const stillAsked = (await searchNode(page, 'status'))?.name
        const sent = await effectsSince(page)
        await snap(page, 'workbench-replace-agent-refused')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
        return {
          'the catalogue marks replaceAll, replaceInFile and replaceConfirm human-only': humanOnly === 'search.replaceAll,search.replaceConfirm,search.replaceInFile',
          'an agent asking search.replaceAll is refused human_only': all.outcome === 'refused' && all.code === 'human_only' && all.reason === '"search.replaceAll" is for a person to do. Agent run run-agent asked for it.',
          'an agent asking search.replaceInFile is refused human_only': inFile.outcome === 'refused' && inFile.code === 'human_only',
          'the refusals changed nothing: no question appeared': statusBefore === statusAfter && !/Replace \d/.test(statusAfter ?? ''),
          'an agent asking search.replaceConfirm while the person\'s question is open is refused human_only': confirm.outcome === 'refused' && confirm.code === 'human_only' && confirm.reason === '"search.replaceConfirm" is for a person to do. Agent run run-agent asked for it.',
          'the question is still waiting and nothing was sent to the host': /^Replace 7 matches/.test(stillAsked ?? '') && sent.length === 0,
        }
      },
      // With regex on and $1 in the replacement, the question says it is inserted as typed.
      async (page) => {
        await page.waitForTimeout(500)
        await page.keyboard.press('Alt+r')
        const found = await searchFor(page, 'zorp')
        const regex = (await searchNode(page, 'regex'))?.state.selected
        await page.keyboard.press('Tab')
        await page.keyboard.type('$1', { delay: 20 })
        await page.keyboard.press('Enter')
        await sees(page, 'Enter replaces and saves each file', 6000)
        await page.waitForTimeout(300)
        const question = (await searchNode(page, 'status'))?.name
        const preview = (await nodes(page)).filter((n) => /\/replace-line:\d+$/.test(n.id)).map((n) => n.name)
        await snap(page, 'workbench-replace-regex-note')
        await page.keyboard.press('Enter')
        await sees(page, 'files changed', 10_000)
        const edit = (await effects(page)).find((e) => e.kind === 'documentEdit' && e.path === 'docs/beta.txt')
        await page.waitForTimeout(300)
        await page.keyboard.press('Escape')
        return {
          'regex is on and the search found 7 matches': regex === true && found === '7 matches in 4 files.',
          'the question carries the note: "The replacement is inserted as typed: capture references such as $1 are not expanded."': question === 'Replace 7 matches in 4 files with "$1"? Enter replaces and saves each file, one at a time. Esc cancels. The replacement is inserted as typed: capture references such as $1 are not expanded.',
          'the preview shows $1 literally': preview.includes('    + $1 one and $1 two share a line.'),
          'the edit sent inserts the three characters $1': edit?.payload.edits.length === 1 && edit.payload.edits[0].insert === '$1',
        }
      },
    ],
  }
}
