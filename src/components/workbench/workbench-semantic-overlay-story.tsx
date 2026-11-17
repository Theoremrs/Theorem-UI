// SOURCING: none — the stories' scripted fixture workbench (workbench-story.tsx FixtureStory) with the accessible overlay mounted over it, the way the app mounts it. The URL decides what is on: `?overlay=off` leaves the overlay out (the pixel comparison's baseline), `?selection=end` adds the caret the core does not publish yet to text fields (see `withCaretAtEnd`), `?device=copy` shows the account's layout as the browser's copy, which gives the core a standing notice and a refused save to announce.
import { useEffect } from 'react'
import { SemanticOverlay } from './semantic-overlay'
import { parseUpdate } from './semantic-overlay/tree'
import { FixtureStory, EVERY_TOOL } from './workbench-story'
import type { SemanticsFeed, SurfaceParts } from './workbench'

declare global {
  interface Window {
    /** Every message the semantic feed delivered, in order: what a scenario counts and a fixture is cut from. */
    __semanticFeed?: string[]
    /** The core's own tree as it is now (`handle.semantics()`), for the oracle to hold the overlay against. */
    __semanticTruth?: () => string | undefined
  }
}

const search = () => new URLSearchParams(window.location.search)

/**
 * The feed with `selection` added to every text box that has `text` and none: the caret at the end of
 * the text. The Rust composer and editor publish `text` but not yet `selection` (their caret is in
 * `description`), and the overlay mirrors a field's text and caret into the input only when both are
 * published; this lets a story show that path against the real core. A story's device, never the app's.
 */
export function withCaretAtEnd(feed: SemanticsFeed): SemanticsFeed {
  const mark = (json: string) => {
    const update = parseUpdate(json)
    if (!update) return json
    const fix = <TNode extends { role: string; text?: string; selection?: unknown }>(node: TNode): TNode =>
      node.role === 'textBox' && node.text !== undefined && node.selection === undefined
        ? { ...node, selection: { anchor: node.text.length, focus: node.text.length } }
        : node
    return JSON.stringify(
      update.type === 'full'
        ? { type: 'full', tree: { ...update.tree, nodes: update.tree.nodes.map(fix) } }
        : {
            type: 'diff',
            diff: {
              ...update.diff,
              added: update.diff.added.map(fix),
              changed: update.diff.changed.map(fix),
            },
          },
    )
  }
  return {
    get latest() {
      return feed.latest === undefined ? undefined : mark(feed.latest)
    },
    subscribe: (listener) => feed.subscribe((update) => listener(mark(update))),
  }
}

function FeedRecorder({ feed, parts }: { feed: SemanticsFeed; parts: SurfaceParts }) {
  const { handle } = parts
  useEffect(() => {
    window.__semanticFeed = feed.latest === undefined ? [] : [feed.latest]
    window.__semanticTruth = () => handle?.semantics()
    return feed.subscribe((update) => window.__semanticFeed?.push(update))
  }, [feed, handle])
  return null
}

/**
 * `workbench-semantic-overlay`: the workbench with every tool live, a transcript and a recorded
 * terminal, and the accessible overlay over the grid. The overlay is invisible; the oracle reads the
 * browser's accessibility tree and drives the keyboard.
 */
export function WorkbenchSemanticOverlayStory() {
  const on = search().get('overlay') !== 'off'
  const caret = search().get('selection') === 'end'
  const device = search().get('device') === 'copy'
  return (
    <FixtureStory
      id="workbench-semantic-overlay"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, transcript: true, terminal: true, deviceLayout: device }}
      arrangements={device}
      controls={device ? { 'save-mine': (_, surface) => surface.arrangement({ type: 'save', name: 'Mine' }) } : undefined}
      script={[]}
      wait={['README.md', 'More tools']}
      overlay={(feed, parts) => (
        <>
          <FeedRecorder feed={feed} parts={parts} />
          {on ? (
            <SemanticOverlay feed={caret ? withCaretAtEnd(feed) : feed} parts={parts} settleMs={150} />
          ) : null}
        </>
      )}
    />
  )
}
