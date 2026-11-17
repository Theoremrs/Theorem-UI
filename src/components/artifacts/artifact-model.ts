// SOURCING: none — a typed reader for the theorem-artifact-v1 part contract (apps/theoremweb/contracts/theorem-chat-v1.json); no library models Theorem's artifact parts
import { useAuiState } from '@assistant-ui/react'
import type { ThreadMessage } from '@assistant-ui/react'
import { useMemo } from 'react'
import {
  readScene,
  SCENE_CONTRACT,
  SCENE_PART,
} from '@/components/chat/scene-model'
import type { Scene } from '@/components/chat/scene-model'
import { parseNotebookForm } from '@/lib/notebooks/forms'
import type { NotebookForm } from '@/lib/notebooks/forms'
import { humanize } from '@/lib/utils'

/** One revision of an agent-produced artifact, read from a `theorem-artifact` data part. */
export type TheoremArtifact = {
  partId: string
  artifactId: string
  revision: string
  kind: string
  rendererId: string
  contractVersion: string
  lifecycle: string
  patchSequence: number
  title: string
  content: string
  language: string | undefined
  fallbackText: string
  payloadRef: string | undefined
  runId: string | undefined
  sourceTool: string | undefined
  documentId?: string
  documentPosition?: string | number
  /** How the content is written, when the part says: "openui" for a program. */
  form?: string
  /** The component library an "openui" program was written against. */
  library?: { id: string; version: string }
  /** An Observable or marimo notebook, when the payload is one of the notebook forms. */
  notebook?: NotebookForm
  /** The version of its form the payload was written in, when it names one. */
  formVersion?: number
  /**
   * An interactive scene: an artifact of kind "scene" carries the
   * theorem-scene-v1 payload a `theorem-scene` part carries.
   */
  scene?: Scene
}

export const ARTIFACT_PART = 'theorem-artifact'

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Live run events carry the whole part as `data`; history carries the stored
 * part payload. Accept either and return the artifact part itself.
 */
export function readArtifact(data: unknown): TheoremArtifact | undefined {
  const outer = object(data)
  const part = text(outer.artifactId) ? outer : object(outer.payload)
  const artifactId = text(part.artifactId)
  if (!artifactId) return undefined
  const payload = object(part.payload)
  const form = text(payload.form) ?? text(part.form)
  const library = object(payload.library ?? part.library)
  const version =
    typeof library.version === 'number'
      ? String(library.version)
      : text(library.version)
  const title =
    text(payload.title) ?? text(part.fallbackText) ?? 'Untitled artifact'
  return {
    partId: text(part.partId) ?? artifactId,
    artifactId,
    revision: text(part.artifactRevision) ?? artifactId,
    kind: text(part.artifactKind) ?? form ?? 'unknown',
    rendererId: text(part.rendererId) ?? 'unknown',
    contractVersion: text(part.contractVersion) ?? 'unknown',
    lifecycle: text(part.lifecycle) ?? 'ready',
    patchSequence:
      typeof part.patchSequence === 'number' ? part.patchSequence : 0,
    title,
    // An "openui" part carries its program where other parts carry content.
    content:
      text(payload.content) ??
      text(payload.program) ??
      text(part.program) ??
      '',
    language: text(payload.language),
    fallbackText: text(part.fallbackText) ?? title,
    payloadRef: text(part.payloadRef),
    runId: text(part.runId),
    sourceTool: text(part.sourceTool),
    documentId: text(payload.documentId),
    documentPosition:
      typeof object(payload.revision).position === 'number'
        ? (object(payload.revision).position as number)
        : text(object(payload.revision).position),
    ...(form && { form }),
    ...(text(library.id) &&
      version && { library: { id: text(library.id) as string, version } }),
    notebook: parseNotebookForm(payload),
    formVersion:
      typeof payload.formVersion === 'number' ? payload.formVersion : undefined,
    ...(part.artifactKind === 'scene' && { scene: readScene(payload) }),
  }
}

/**
 * A saved `theorem-scene` part, read as the artifact it is: one identity per
 * scene, one revision per package. Conversations saved before scenes were
 * artifacts list their scenes through this.
 */
export function readSceneArtifact(data: unknown): TheoremArtifact | undefined {
  const scene = readScene(data)
  if (!scene) return undefined
  const artifactId = `scene:${scene.sceneId}`
  const title = scene.title ?? 'Interactive scene'
  return {
    partId: artifactId,
    artifactId,
    revision: scene.packageHash ?? artifactId,
    kind: 'scene',
    rendererId: 'theorem-scene',
    contractVersion: SCENE_CONTRACT,
    lifecycle: 'ready',
    patchSequence: 0,
    title,
    content: '',
    language: undefined,
    fallbackText: scene.fallbackText || title,
    payloadRef: undefined,
    runId: undefined,
    sourceTool: undefined,
    scene,
  }
}

/** Every artifact in `messages`, each with its revisions in patch order. */
export function threadArtifacts(
  messages: readonly ThreadMessage[],
): ReadonlyMap<string, readonly TheoremArtifact[]> {
  const parts = messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.filter((part) => part.type === 'data')
      : [],
  )
  const read = parts.flatMap((part) => {
    const artifact =
      part.name === ARTIFACT_PART
        ? readArtifact(part.data)
        : part.name === SCENE_PART
          ? readSceneArtifact(part.data)
          : undefined
    return artifact ? [{ artifact, saved: part.name === SCENE_PART }] : []
  })
  // A scene the artifact contract carries is not listed again for a scene
  // part with the same package.
  const carried = new Set(
    read.flatMap(({ artifact, saved }) =>
      !saved && artifact.scene?.packageHash ? [artifact.scene.packageHash] : [],
    ),
  )
  const byId = new Map<string, TheoremArtifact[]>()
  for (const { artifact, saved } of read) {
    const hash = artifact.scene?.packageHash
    if (saved && hash && carried.has(hash)) continue
    const versions = byId.get(artifact.artifactId) ?? []
    if (!versions.some((v) => v.revision === artifact.revision))
      versions.push(artifact)
    byId.set(artifact.artifactId, versions)
  }
  for (const versions of byId.values())
    versions.sort((a, b) => a.patchSequence - b.patchSequence)
  return byId
}

/** Every artifact on the selected branch, each with its revisions in patch order. */
export function useThreadArtifacts(): ReadonlyMap<
  string,
  readonly TheoremArtifact[]
> {
  const messages = useAuiState((s) => s.thread.messages)
  return useMemo(() => threadArtifacts(messages), [messages])
}

const EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  python: 'py',
  rust: 'rs',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  ruby: 'rb',
  shell: 'sh',
  bash: 'sh',
  sql: 'sql',
  html: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  markdown: 'md',
}

/** A short label for the artifact kind, used on cards and the panel header. */
export function kindLabel(artifact: TheoremArtifact): string {
  switch (artifact.kind) {
    case 'app':
      return 'App'
    case 'document':
      return 'Document'
    case 'code':
      return artifact.language ? `Code · ${artifact.language}` : 'Code'
    case 'diagram':
      return 'Diagram'
    case 'observable':
      return 'Notebook · Observable'
    case 'marimo':
      return 'Notebook · marimo'
    case 'openui':
      return 'Interface'
    case 'scene':
      return 'Scene'
    default:
      return humanize(artifact.kind)
  }
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  'text/html': 'html',
  'text/markdown': 'md',
  'text/vnd.mermaid': 'mmd',
  'text/x-python': 'py',
  'application/json': 'json',
}

/** Download file name for an artifact revision whose source has `mediaType`. */
export function fileNameFor(
  artifact: TheoremArtifact,
  mediaType: string,
): string {
  const base =
    artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'artifact'
  const ext =
    MEDIA_EXTENSIONS[mediaType] ??
    (artifact.language
      ? (EXTENSIONS[artifact.language.toLowerCase()] ?? artifact.language)
      : 'txt')
  return `${base}.${ext}`
}
