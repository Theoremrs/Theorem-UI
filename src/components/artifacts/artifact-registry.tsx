// SOURCING: none — the UI's artifact contributions and mount table over the
// projected contribution contract (lib/artifacts/contributions, a projection
// of theorem-surface-contracts' resolve). Shells ask for a distance; this
// module answers which mounted renderer shows it, so no shell branches on a
// kind. Adding a kind is a contribution and a mount entry here.
import type { FC } from 'react'
import {
  contribution,
  live,
  presentation,
  resolve,
  validateAll,
} from '@/lib/artifacts/contributions'
import type {
  ArtifactContribution,
  ArtifactSubject,
  Distance,
  Representation,
} from '@/lib/artifacts/contributions'
import { SCENE_CONTRACT } from '@/components/chat/scene-model'
import { resolvedTheme } from '@/lib/blocks/sandbox/theme'
import { observableSource } from '@/lib/notebooks/observable-document'
import { appDocumentFor } from '@/lib/theorem/apps'
import { fileNameFor } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'

export type RendererProps = {
  artifact: TheoremArtifact
  /** The artifact's newest revision in this thread; older ones show pinned. */
  latest: boolean
}

/** What this build of the UI contributes, in the manifest's wire shape. */
export const UI_CONTRIBUTIONS: ReadonlyArray<ArtifactContribution> = [
  // Notebooks are claimed by their form, ahead of any kind their part also
  // names, and by the contract's kind, so a payload this build cannot read
  // still reaches the renderer that says why.
  contribution('theorem.notebook.observable', 'Observable notebook', {
    provider: 'theorem-ui',
    kinds: ['observable'],
    schemas: ['theorem.notebook.observable'],
    presentations: [
      presentation('artifact_native', 'theorem-observable', [
        'preview',
        'thing',
        'interactive',
      ]),
    ],
    locators: ['notebook_cell', 'entity'],
    followsTheme: true,
  }),
  contribution('theorem.notebook.marimo', 'marimo notebook', {
    provider: 'theorem-ui',
    kinds: ['marimo'],
    schemas: ['theorem.notebook.marimo'],
    presentations: [
      presentation('artifact_native', 'theorem-marimo', [
        'preview',
        'thing',
        'interactive',
      ]),
    ],
    locators: ['notebook_cell', 'entity'],
    followsTheme: true,
  }),
  contribution('theorem.document', 'Document', {
    provider: 'theorem-ui',
    kinds: ['document'],
    media: ['text/markdown'],
    presentations: [
      // In the reply a document is a card that opens it in the Gallery.
      presentation('artifact_native', 'theorem-document.reply', ['preview']),
      presentation('artifact_native', 'theorem-document', [
        'thing',
        'interactive',
      ]),
    ],
    locators: ['text_range'],
    followsTheme: true,
  }),
  contribution('theorem.code', 'Code', {
    provider: 'theorem-ui',
    kinds: ['code'],
    presentations: [
      presentation('artifact_native', 'theorem-code.excerpt', ['preview']),
      presentation('artifact_native', 'theorem-code', ['thing', 'interactive']),
    ],
    locators: ['code_range'],
    followsTheme: true,
  }),
  // The agent picks how a diagram is drawn by its kind: a "diagram" is
  // Mermaid source, drawn as written; a "graph" is a DAG of nodes naming what
  // each depends on, laid out as a flow graph. Either sits bare in the reply.
  contribution('theorem.diagram', 'Diagram', {
    provider: 'theorem-ui',
    kinds: ['diagram'],
    media: ['text/vnd.mermaid'],
    presentations: [
      presentation('artifact_native', 'theorem-diagram.reply', ['preview']),
      presentation('artifact_native', 'theorem-diagram', [
        'thing',
        'interactive',
      ]),
    ],
    followsTheme: true,
  }),
  contribution('theorem.graph', 'Graph', {
    provider: 'theorem-ui',
    kinds: ['graph'],
    presentations: [
      presentation('artifact_native', 'theorem-graph', [
        'preview',
        'thing',
        'interactive',
      ]),
    ],
    followsTheme: true,
  }),
  contribution('theorem.app', 'App', {
    provider: 'theorem-ui',
    kinds: ['app'],
    media: ['text/html'],
    schemas: ['theorem.app'],
    presentations: [
      presentation('artifact_native', 'theorem-app.preview', [
        'landmark',
        'preview',
      ]),
      live(
        presentation('artifact_native', 'theorem-app', [
          'thing',
          'interactive',
        ]),
      ),
    ],
    locators: ['entity', 'table_rows'],
  }),
  // A program in OpenUI Lang against theorem-artifacts: rendered in place at
  // every distance, its controls local, so there is no live session to open.
  contribution('theorem.openui', 'Artifact', {
    provider: 'theorem-ui',
    kinds: ['openui'],
    schemas: ['theorem-artifacts'],
    presentations: [
      presentation('artifact_native', 'theorem-openui', [
        'preview',
        'thing',
        'interactive',
      ]),
    ],
    locators: ['entity', 'table_rows'],
    followsTheme: true,
  }),
  // An interactive scene the agent wrote, on SceneOS. In the reply it is the
  // whole surface, with its own Expand and Ask; in a panel it fills the
  // panel in its full layout. Its code runs only in the scene's sandboxed
  // page, so no presentation holds a live session and none waits behind
  // Interact.
  contribution('theorem.scene', 'Scene', {
    provider: 'theorem-ui',
    kinds: ['scene'],
    schemas: [SCENE_CONTRACT],
    presentations: [
      presentation('artifact_native', 'theorem-scene.reply', ['preview']),
      presentation('artifact_native', 'theorem-scene', [
        'thing',
        'interactive',
      ]),
    ],
    locators: ['entity'],
    followsTheme: true,
  }),
]

const invalid = validateAll(UI_CONTRIBUTIONS)
if (invalid)
  throw new Error(
    `Artifact contribution ${invalid.id} is invalid: ${invalid.code}`,
  )

const MEDIA: Record<string, string> = {
  html: 'text/html',
  markdown: 'text/markdown',
  mermaid: 'text/vnd.mermaid',
}

/**
 * The subject an artifact part presents to the contributions. A notebook is
 * known by its form. A part that states another form ("openui") is that form,
 * whatever its kind, and the library its program was written against is its
 * schema. A kind some contribution names is the whole subject: its language
 * says what its source is written in, not what it is. Only a kind nothing
 * names is recognized by its language.
 */
export function subjectOf(
  artifact: TheoremArtifact,
  contributions: ReadonlyArray<ArtifactContribution> = UI_CONTRIBUTIONS,
): ArtifactSubject {
  if (artifact.notebook)
    return {
      kind: artifact.kind,
      schema: `theorem.notebook.${artifact.notebook.form}`,
    }
  const kind = artifact.form ?? artifact.kind
  const schema = artifact.library && { schema: artifact.library.id }
  if (contributions.some((c) => c.matches.objectKinds.includes(kind)))
    return { kind, ...schema }
  const language = artifact.language?.toLowerCase()
  return {
    kind,
    ...schema,
    ...(language && MEDIA[language] && { mediaType: MEDIA[language] }),
  }
}

let mounted: Readonly<Record<string, FC<RendererProps>>> = {}
let bare: ReadonlySet<string> = new Set()
let cards: ReadonlySet<string> = new Set()
let fills: ReadonlySet<string> = new Set()

/**
 * Mounts the renderers this build ships. Called once, by the module that
 * defines them (artifact-renderers), so availability is what actually loaded.
 *
 * A `bare` renderer draws the whole surface in the reply itself: its own
 * sizing, expansion, loading and failure, and Ask. The conversation adds no
 * card around it (docs/plans/interactive-answer-artifacts.md: no visible
 * chrome, an invisible frame contract). A `card` renderer is the reply's
 * own card for an artifact shown elsewhere: the conversation adds nothing
 * around it, and the working turn's still opens in its panel. A renderer
 * that `fills` takes the whole of a panel's body, with no reading column or
 * padding, and sizes itself to it.
 */
export function mountRenderers(
  table: Record<string, FC<RendererProps>>,
  options: {
    bare?: ReadonlyArray<string>
    cards?: ReadonlyArray<string>
    fills?: ReadonlyArray<string>
  } = {},
) {
  mounted = { ...mounted, ...table }
  bare = new Set([...bare, ...(options.bare ?? [])])
  cards = new Set([...cards, ...(options.cards ?? [])])
  fills = new Set([...fills, ...(options.fills ?? [])])
}

/** Whether the artifact at `distance` takes the whole of a panel's body. */
export function fillsPanel(
  artifact: TheoremArtifact,
  distance: Distance,
): boolean {
  const { renderer } = representationOf(artifact, distance)
  return renderer !== undefined && renderer in mounted && fills.has(renderer)
}

/** Whether the reply shows the artifact bare at `distance`, with no card around it. */
export function isBare(artifact: TheoremArtifact, distance: Distance): boolean {
  const { renderer } = representationOf(artifact, distance)
  return renderer !== undefined && renderer in mounted && bare.has(renderer)
}

/** Whether the artifact's renderer at `distance` draws the reply's card itself. */
export function isCard(artifact: TheoremArtifact, distance: Distance): boolean {
  const { renderer } = representationOf(artifact, distance)
  return renderer !== undefined && renderer in mounted && cards.has(renderer)
}

export function rendererFor(
  representation: Representation,
): FC<RendererProps> | undefined {
  return representation.renderer ? mounted[representation.renderer] : undefined
}

export function representationOf(
  artifact: TheoremArtifact,
  distance: Distance,
  contributions: ReadonlyArray<ArtifactContribution> = UI_CONTRIBUTIONS,
): Representation {
  return resolve(
    subjectOf(artifact, contributions),
    distance,
    contributions,
    (renderer) =>
      renderer in mounted
        ? { mounted: true }
        : { mounted: false, reason: `This build has no ${renderer} renderer` },
  )
}

export type ArtifactSource = {
  /** Names the source in action labels: "App source", or "" for the text itself. */
  noun: string
  mediaType: string
  load: () => Promise<string>
}

const inline = (artifact: TheoremArtifact) => async () => artifact.content

/** Per contribution: what Copy and Download hand over for a revision. */
const SOURCES: Record<
  string,
  (artifact: TheoremArtifact, latest: boolean) => ArtifactSource
> = {
  'theorem.document': (artifact) => ({
    noun: '',
    mediaType: 'text/markdown',
    load: inline(artifact),
  }),
  'theorem.openui': (artifact) => ({
    noun: 'program',
    mediaType: 'text/plain',
    load: inline(artifact),
  }),
  'theorem.scene': (artifact) => ({
    noun: 'Scene package',
    mediaType: 'application/json',
    load: async () =>
      JSON.stringify(artifact.scene?.scenePackage ?? {}, null, 2),
  }),
  'theorem.diagram': (artifact) => ({
    noun: '',
    mediaType: 'text/vnd.mermaid',
    load: inline(artifact),
  }),
  'theorem.graph': (artifact) => ({
    noun: '',
    mediaType: 'application/json',
    load: inline(artifact),
  }),
  // A payload this build cannot read still hands over its content: the
  // publication as canonical JSON.
  'theorem.notebook.observable': (artifact) => {
    const { notebook } = artifact
    return notebook?.form === 'observable'
      ? {
          noun: 'Notebook',
          mediaType: 'text/html',
          load: async () => observableSource(notebook, resolvedTheme()),
        }
      : {
          noun: 'Notebook',
          mediaType: 'application/json',
          load: inline(artifact),
        }
  },
  'theorem.notebook.marimo': (artifact) => ({
    noun: 'Notebook source',
    mediaType: 'text/x-python',
    load: async () =>
      artifact.notebook?.form === 'marimo'
        ? artifact.notebook.source
        : artifact.content,
  }),
  'theorem.app': (artifact, latest) => ({
    noun: 'App source',
    mediaType: 'text/html',
    // The newest revision is the App as saved now, edits included; an older
    // one is exactly the source its message pinned.
    load:
      latest || !artifact.content
        ? async () => {
            if (!artifact.documentId)
              throw new Error('The App has no saved document reference.')
            return (await appDocumentFor(artifact.documentId).load()).html
          }
        : inline(artifact),
  }),
}

export function sourceOf(
  artifact: TheoremArtifact,
  latest: boolean,
): ArtifactSource {
  const id = representationOf(artifact, 'thing').contribution
  const adapter = id ? SOURCES[id] : undefined
  return (
    adapter?.(artifact, latest) ?? {
      noun: '',
      mediaType: 'text/plain',
      load: inline(artifact),
    }
  )
}

/** What Download names the revision: the extension follows the source's media type. */
export const fileNameOf = (artifact: TheoremArtifact, latest: boolean) =>
  fileNameFor(artifact, sourceOf(artifact, latest).mediaType)

/**
 * Whether showing the artifact at a distance holds a live session. A live
 * representation opens only when the person asks for it: Follow the Agent
 * never opens one. The conversation mounts a live representation directly.
 */
export const isLive = (artifact: TheoremArtifact, distance: Distance) =>
  representationOf(artifact, distance).session === 'live'
