// SOURCING: assistant-ui's artifact-card element (vendored in
// assistant-ui/elements), the Gallery's project (cabinet-view) and the shell
// state that opens the Gallery on an artifact.
//
// A document in the reply is a card: its title and what it is, or while the
// turn writes it, how far it has got. Opening it shows it in the Gallery,
// selected among the project's other objects. A conversation outside any
// project has no Gallery, so there it opens in the dock's panel.
import { useAuiState } from '@assistant-ui/react'
import { useContext } from 'react'
import type { FC } from 'react'
import { ArtifactCard } from '@/components/assistant-ui/elements/artifact-card'
import { useGalleryProject } from '@/components/cabinet/gallery-project'
import { useOpenMode } from '@/components/shell/modes'
import { useShell } from '@/components/shell/shell-state'
import { OPENS_WHOLE } from '@/lib/face/things'
import { kindLabel, useThreadArtifacts } from './artifact-model'
import type { RendererProps } from './artifact-registry'
import { ArtifactPlacement, useArtifactView } from './artifact-view'

/** Words, not markup: a heading's `#` or a list's `-` is not one. */
const wordsIn = (text: string) =>
  text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0

export const DocumentCard: FC<RendererProps> = ({ artifact, latest }) => {
  const writing = useAuiState((s) => s.message.status?.type === 'running')
  const versions = useThreadArtifacts().get(artifact.artifactId) ?? [artifact]
  const position = versions.findIndex((v) => v.revision === artifact.revision)
  const project = useGalleryProject()
  const inline = useContext(ArtifactPlacement) === 'inline'
  const openMode = useOpenMode()
  const show = () => {
    if (project) return useShell.getState().openInGallery(artifact.artifactId)
    useArtifactView
      .getState()
      .open(artifact.artifactId, latest ? undefined : artifact.revision)
    // The dock is chat's; from a page the larger view is there.
    if (inline) void openMode('chat')
  }
  return (
    <ArtifactCard
      role="button"
      tabIndex={0}
      aria-label={`Open ${artifact.title}`}
      {...OPENS_WHOLE}
      // Theo sits on the artifact the conversation is about.
      data-face-perch="artifact"
      title={artifact.title}
      meta={`${kindLabel(artifact)}${versions.length > 1 ? ` · v${position + 1}` : ''}`}
      generating={writing && latest}
      words={wordsIn(artifact.content)}
      onClick={show}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        show()
      }}
      className="my-3 outline-none focus-visible:outline-2 focus-visible:outline-focus"
    />
  )
}
