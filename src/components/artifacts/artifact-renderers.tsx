// SOURCING: react-markdown + remark-gfm + @tailwindcss/typography (documents), the TanStack Highlight SyntaxHighlighter (code), the installed beautiful-mermaid MermaidDiagram (diagrams), assistant-ui's flow-graph element (graphs), notebook-artifact (Observable and marimo notebooks in the hosted frame), OpenUI's Renderer over theorem-artifacts (openui/renderer)
//
// The renderers this build mounts. Which one shows an artifact at a distance
// is the registry's answer (artifact-registry: contributions + resolve); a
// representation with no mounted renderer gets the Theorem card, which says
// what the artifact is and shows its fallbackText.
import { createElement, isValidElement, useMemo } from 'react'
import type { FC, ReactElement, ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  DependencyGraph,
  readGraph,
} from '@/components/assistant-ui/elements/dependency-graph'
import { MermaidDiagram } from '@/components/assistant-ui/elements/mermaid-diagram'
import { SyntaxHighlighter } from '@/components/assistant-ui/elements/code-highlighter'
import { DocumentApp } from '@/components/blocks/document-app'
import { cn } from '@/lib/utils'
import type { Distance } from '@/lib/artifacts/contributions'
import { useArtifactMessageId } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'
import { AppPreview } from './app-revision-frame'
import { DocumentCard } from './document-card'
import { AppRevision } from './app-history'
import { NotebookArtifact } from './notebook-artifact'
import { OpenUIArtifact } from './openui/renderer'
import { SceneInConversation, SceneInReply } from '@/components/chat/scene-part'
import {
  mountRenderers,
  rendererFor,
  representationOf,
} from './artifact-registry'
import type { RendererProps } from './artifact-registry'

const codeSurface =
  '[&_pre]:rounded-lg! [&_pre]:border! [&_pre]:border-separator! [&_pre]:bg-raised!'

/** A fenced block inside a document: the child of <pre> is <code class="language-x">. */
function fencedCode(
  children: ReactNode,
): { language: string; code: string } | undefined {
  if (!isValidElement(children)) return undefined
  const props = (
    children as ReactElement<{ className?: string; children?: ReactNode }>
  ).props
  const language =
    /language-([\w-]+)/.exec(props.className ?? '')?.[1] ?? 'text'
  const code = typeof props.children === 'string' ? props.children : undefined
  return code === undefined ? undefined : { language, code }
}

const documentComponents: Components = {
  pre({ children }) {
    const block = fencedCode(children)
    if (!block) return <pre>{children}</pre>
    if (block.language === 'mermaid')
      return (
        <div className="not-prose my-4">
          <MermaidDiagram code={block.code} className="rounded-lg" />
        </div>
      )
    return (
      <SyntaxHighlighter
        className={cn('not-prose my-4', codeSurface)}
        language={block.language}
        code={block.code}
      />
    )
  },
}

/** Markdown as Theorem documents read, in artifacts and the Index alike. */
export const MarkdownDocument: FC<{ content: string; className?: string }> = ({
  content,
  className,
}) => (
  <article
    className={cn(
      'prose prose-theorem max-w-none text-base leading-6',
      className,
    )}
  >
    <Markdown remarkPlugins={[remarkGfm]} components={documentComponents}>
      {content}
    </Markdown>
  </article>
)

const DocumentArtifact: FC<RendererProps> = ({ artifact }) => (
  <MarkdownDocument content={artifact.content} />
)

const CodeArtifact: FC<RendererProps> = ({ artifact }) => (
  <SyntaxHighlighter
    className={cn('[&_pre]:text-[13px]', codeSurface)}
    language={artifact.language ?? 'text'}
    code={artifact.content}
  />
)

const DiagramArtifact: FC<RendererProps> = ({ artifact }) => (
  <MermaidDiagram code={artifact.content} className="rounded-lg bg-raised" />
)

/**
 * In the reply a diagram is the drawing alone, on the conversation's own
 * ground and in line with its text: no card, title or fill around it.
 */
const DiagramReply: FC<RendererProps> = ({ artifact }) => (
  <MermaidDiagram
    code={artifact.content}
    className="my-3 rounded-none bg-transparent p-0 [&_svg]:mx-0"
  />
)

/** A DAG the agent wrote as nodes, drawn as it is, with nothing around it. */
const GraphArtifact: FC<RendererProps> = ({ artifact }) => {
  const graph = useMemo(() => readGraph(artifact.content), [artifact.content])
  return graph ? (
    <DependencyGraph
      aria-label={artifact.title}
      graph={graph}
      className="my-3"
    />
  ) : (
    <TheoremCard artifact={artifact} reason="The graph could not be read" />
  )
}

/** A short opening of a long document, for the conversation. */
const CodeExcerpt: FC<RendererProps> = ({ artifact }) => (
  <div className="max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
    <CodeArtifact artifact={artifact} latest />
  </div>
)

/** The App's workspace body: the live App for its newest revision, the pinned source for an older one. */
const AppArtifact: FC<RendererProps> = ({ artifact, latest }) =>
  !latest ? (
    <AppRevision artifact={artifact} />
  ) : artifact.documentId ? (
    <DocumentApp
      key={artifact.documentId}
      documentId={artifact.documentId}
      pinnedPosition={artifact.documentPosition}
      initiallyRunning
    />
  ) : (
    <p role="alert">This App couldn't be opened.</p>
  )

const AppPreviewArtifact: FC<RendererProps> = ({ artifact }) => (
  <AppPreview artifact={artifact} />
)

/** A notebook: its document's head for the newest revision, the pinned one for an older. */
const ObservableArtifact: FC<RendererProps> = (props) => (
  <NotebookArtifact {...props} form="observable" />
)

const MarimoArtifact: FC<RendererProps> = (props) => (
  <NotebookArtifact {...props} form="marimo" />
)

/** A scene in its reply: the whole surface, wired to the conversation. */
const SceneReplyArtifact: FC<RendererProps> = ({ artifact }) =>
  artifact.scene ? (
    <SceneInReply scene={artifact.scene} />
  ) : (
    <TheoremCard
      artifact={artifact}
      reason="The scene payload could not be read"
    />
  )

/**
 * A scene filling a panel, in its full layout, wired to the same
 * conversation as its reply: Ask refers to the reply that carries this
 * revision, and Fix asks the agent in this thread.
 */
const SceneArtifact: FC<RendererProps> = ({ artifact }) => {
  const messageId = useArtifactMessageId(artifact)
  return artifact.scene ? (
    <SceneInConversation
      scene={artifact.scene}
      messageId={messageId}
      placement="panel"
    />
  ) : (
    <TheoremCard
      artifact={artifact}
      reason="The scene payload could not be read"
    />
  )
}

mountRenderers(
  {
    'theorem-document.reply': DocumentCard,
    'theorem-document': DocumentArtifact,
    'theorem-code.excerpt': CodeExcerpt,
    'theorem-code': CodeArtifact,
    'theorem-diagram.reply': DiagramReply,
    'theorem-diagram': DiagramArtifact,
    'theorem-graph': GraphArtifact,
    'theorem-app.preview': AppPreviewArtifact,
    'theorem-app': AppArtifact,
    'theorem-observable': ObservableArtifact,
    'theorem-marimo': MarimoArtifact,
    'theorem-openui': OpenUIArtifact,
    'theorem-scene.reply': SceneReplyArtifact,
    'theorem-scene': SceneArtifact,
  },
  {
    bare: ['theorem-scene.reply', 'theorem-diagram.reply', 'theorem-graph'],
    cards: ['theorem-document.reply'],
    fills: ['theorem-scene'],
  },
)

/** The Theorem card: what the artifact is, its summary, and why no renderer showed it. */
const TheoremCard: FC<{ artifact: TheoremArtifact; reason?: string }> = ({
  artifact,
  reason,
}) => (
  <div
    data-renderer={artifact.rendererId}
    data-contract={artifact.contractVersion}
    data-reason={reason}
    className="flex flex-col gap-3"
  >
    <p className="text-sm text-ink-muted">
      A preview isn't available for this result. Showing its summary.
    </p>
    <p className="whitespace-pre-wrap rounded-lg border border-separator bg-raised p-4 text-sm leading-6">
      {artifact.fallbackText}
    </p>
  </div>
)

/** Shows an artifact at a distance through whichever renderer the registry resolves. */
export const ArtifactView: FC<RendererProps & { distance: Distance }> = ({
  artifact,
  distance,
  latest,
}) => {
  const representation = representationOf(artifact, distance)
  const Renderer = rendererFor(representation)
  if (!Renderer)
    return (
      <TheoremCard
        artifact={artifact}
        reason={representation.passed.map((p) => p.reason).join('; ')}
      />
    )
  // The mount table is fixed at module load; the renderer is looked up, not made here.
  return createElement(Renderer, { artifact, latest })
}
