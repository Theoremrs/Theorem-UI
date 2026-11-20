// SOURCING: the parity story's own frame (ParityStory: the real wasm workbench over the fixture host, the Hooks the oracle reads, the ladder gate) and the fixture host's live conversation; this file adds only the blocks fixture.
import { ParityStory } from './workbench-delta-parity-story'
import {
  THEO_BLOCKS_CONVERSATION,
  THEO_BLOCKS_DOCUMENTS,
  THEO_BLOCKS_LIVE,
} from './theo-blocks-fixture'

/**
 * `workbench-theo-blocks`: the Theo panel's transcript blocks over an invented conversation at the reference frame's
 * size, in the colour ladder: a finished turn folded to its summary, a fenced block in an answer, the person's
 * message, and a working turn whose command output, elapsed time and written file move on each second. The layout
 * the person saves survives a reload.
 */
export function WorkbenchTheoBlocksStory() {
  return (
    <ParityStory
      id="workbench-theo-blocks"
      ladder
      conversation={THEO_BLOCKS_CONVERSATION}
      liveConversation={THEO_BLOCKS_LIVE}
      persistLayout
      documents={THEO_BLOCKS_DOCUMENTS}
      fill
    />
  )
}
