// SOURCING: the parity story's own frame (ParityStory: the real wasm workbench over the fixture host, the Hooks the oracle reads, the ladder gate) and the fixture host's conversation owner; this file adds only the composer fixture and the capabilities the footer's model and effort need.
import { ParityStory } from './workbench-delta-parity-story'
import { THREADS_CAPS } from './workbench-feature-stories'
import {
  THEO_COMPOSER_CONVERSATION,
  THEO_COMPOSER_OWNER,
  THEO_COMPOSER_THREADS,
} from './theo-composer-fixture'

/**
 * `workbench-theo-composer`: the Theo panel's composer during a working run, over an invented conversation at the
 * reference frame's size, in the colour ladder: messages sent mid-turn standing over the composer (one held for the
 * run, one that failed, one already taken into the transcript), a waiting approval pinned over the box, the receipt
 * of one already answered, and the footer under the box with the project, branch, diff totals, effort, model and stop.
 */
export function WorkbenchTheoComposerStory() {
  return (
    <ParityStory
      id="workbench-theo-composer"
      ladder
      conversation={THEO_COMPOSER_CONVERSATION}
      owner={THEO_COMPOSER_OWNER}
      threadsSeed={THEO_COMPOSER_THREADS}
      granted={[...THREADS_CAPS, 'conversation.model']}
      fill
    />
  )
}
