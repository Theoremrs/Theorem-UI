// SOURCING: the parity story's own frame (ParityStory: the real wasm workbench over the fixture host, the Hooks the oracle reads, the ladder gate); this file adds only the Review fixture and the page hook that hands the oracle the fixture's per-file counts.
import { useEffect } from 'react'
import { ParityStory } from './workbench-delta-parity-story'
import { REVIEW_CHANGES, REVIEW_COUNTS, reviewDiff } from './review-fixture'

declare global {
  interface Window {
    /** The lines each fixture file adds and removes: what the Review's counts must add up to. */
    __reviewCounts?: Record<string, { add: number; del: number }>
  }
}

function CountsHook() {
  useEffect(() => {
    window.__reviewCounts = REVIEW_COUNTS
    return () => {
      window.__reviewCounts = undefined
    }
  }, [])
  return null
}

/**
 * `workbench-changes-review`: the Changes panel's Review over twelve invented files in five folders, at the
 * reference frame's size and in the colour ladder.
 */
export function WorkbenchChangesReviewStory() {
  return (
    <ParityStory
      id="workbench-changes-review"
      ladder
      repository={{ changes: REVIEW_CHANGES, diff: reviewDiff }}
      hooks={<CountsHook />}
      fill
    />
  )
}
