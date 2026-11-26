// SOURCING: none — the parameters an artifact panel records in the dockview layout, and the view
// choices (artifact-view's ArtifactViewState) they restore.
import type { ArtifactViewState } from '@/components/artifacts/artifact-view'

export type ArtifactPanelParams = {
  artifactId: string
  /** The conversation it came from; absent for a chat not saved when it opened. */
  threadId?: string
  /** 'true' while it stays open across chats. */
  keep?: string
  /** 'false' while it shows a chosen revision instead of following the newest. */
  follow?: string
  /** The revision shown while not following. */
  revision?: string
}

/** The view choices a panel records in its parameters, so a saved layout keeps them. */
export function viewParams(
  view: Pick<ArtifactViewState, 'follow' | 'revision'>,
): Pick<ArtifactPanelParams, 'follow' | 'revision'> {
  return view.follow
    ? { follow: undefined, revision: undefined }
    : { follow: 'false', revision: view.revision }
}

/**
 * The view an artifact panel records about itself in the layout, so a saved layout restores it
 * with the conversation it came from and whether it stays open.
 */
export function panelView(params: ArtifactPanelParams): ArtifactViewState {
  const following = params.follow !== 'false' || params.revision === undefined
  return {
    threadId: params.threadId,
    follow: following,
    revision: following ? undefined : params.revision,
    keep: params.keep === 'true',
  }
}
