// SOURCING: none — reads the `scene` part of the theorem-scene-v1 contract and the scene page's frame messages; plain value checks, no library fits
//
// A reply's interactive scene. Theorem's `show_scene` writes the validated
// scene package to the reply as a `scene` part (rustyred-thg-server's
// `conversation_scene`); it arrives here as the `theorem-scene` data part.
// The page that draws it is served by the authority at SCENE_HOST_PATH and
// runs in a sandboxed frame. The host posts it the package, the theme, whether
// it takes questions about a part, and the layout, and reads back only the
// shapes below (scene-os-web's `web/src/embed.ts`).

export const SCENE_PART = 'theorem-scene'
export const SCENE_CONTRACT = 'theorem-scene-v1'

/** Proxied to the authority's frame page (src/routes/api/scene/v1/$.ts). */
export const SCENE_HOST_PATH = '/api/scene/v1/host'

/**
 * Scripts only: the page runs in an opaque origin, so it cannot read this
 * site's storage or cookies, and its own policy forbids any network.
 */
export const SCENE_SANDBOX = 'allow-scripts'

export type Scene = {
  sceneId: string
  title?: string
  fallbackText: string
  packageHash?: string
  scenePackage: Record<string, unknown>
}

type Json = Record<string, unknown>

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined
}

/**
 * The scene a part carries, or undefined when it is not one this client can
 * draw. A streamed part carries its own `type`; a stored one does not.
 */
export function readScene(data: unknown): Scene | undefined {
  const part = object(data)
  if (!part) return undefined
  if (part.contractVersion !== SCENE_CONTRACT) return undefined
  const sceneId = text(part.sceneId)
  const scenePackage = object(part.scenePackage)
  if (!sceneId || !scenePackage) return undefined
  return {
    sceneId,
    title: text(part.title),
    fallbackText: text(part.fallbackText) ?? '',
    packageHash: text(part.packageHash),
    scenePackage,
  }
}

export type SceneLayout = 'inline' | 'full'

/**
 * The conversation's colours and type, which an immersive artifact draws
 * with so it matches the reply around it (scene-os-web's `web/src/theme.ts`).
 * A token the browser could not resolve is left out; the page fills it in.
 */
export type SceneTheme = Partial<{
  colorScheme: 'light' | 'dark'
  background: string
  surface: string
  foreground: string
  muted: string
  border: string
  accent: string
  accentForeground: string
  success: string
  warning: string
  danger: string
  fontFamily: string
  monoFamily: string
}>

/** Where the agent's code failed, as the page reports it, for the model to fix. */
export type ModuleError = {
  stage: 'load' | 'mount' | 'first-frame' | 'runtime'
  message: string
  line?: number
  column?: number
}

/** What the reader picked in a scene, with the values it showed then. */
export type SceneEntity = {
  id: string
  label?: string
  kind?: string
  detail?: string
  values?: Record<string, string | number | boolean>
  phase?: number | string
}

/**
 * Where the reader had got to in a scene, as the page reports it: the
 * reader's operations to replay against a fresh mount of the same package,
 * and the step, pick and camera on top. Kept opaque here beyond what decides
 * whether it applies (the page says on mount whether it restored it).
 */
export type SceneCheckpoint = {
  version: number
  packageDigest: string
} & Record<string, unknown>

/** How a mount took the checkpoint it was given. */
export type SceneRestore = 'restored' | 'none' | 'stale' | 'incompatible'

/** The most a checkpoint may weigh, as JSON, before the card stops keeping it. */
export const CHECKPOINT_LIMIT = 256 * 1024

/** The most a still poster may weigh, as a data URL. */
const POSTER_LIMIT = 1024 * 1024

export type HostMessage =
  | {
      type: 'sceneos:mount'
      package: Record<string, unknown>
      theme: SceneTheme
      /**
       * The host takes questions about a part: the page puts an Ask action
       * on the callout it draws on the picked part.
       */
      ask: boolean
      /** Where the reader had got to, for the page to restore after it mounts. */
      checkpoint?: SceneCheckpoint
    }
  | { type: 'sceneos:layout'; layout: SceneLayout }
  /** A new palette or mode for the mounted scene, without restarting its model. */
  | { type: 'sceneos:theme'; theme: SceneTheme }
  /** Asks for a still of what the stage shows, before the frame is unloaded. */
  | { type: 'sceneos:poster-request' }

export type FrameMessage =
  | { type: 'sceneos:host-ready' }
  | {
      type: 'sceneos:mounted'
      ok: boolean
      error?: ModuleError
      /** Present on pages that take checkpoints and live theme changes. */
      restore?: SceneRestore
    }
  | { type: 'sceneos:state'; checkpoint: SceneCheckpoint }
  | { type: 'sceneos:poster'; image: string }
  | { type: 'sceneos:error'; error: ModuleError }
  | { type: 'sceneos:select'; entity: SceneEntity | null }
  | { type: 'sceneos:ask'; entity: SceneEntity }
  | { type: 'sceneos:dismiss' }

const STAGES: readonly ModuleError['stage'][] = [
  'load',
  'mount',
  'first-frame',
  'runtime',
]

function place(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined
}

function readError(value: unknown): ModuleError | undefined {
  const error = object(value)
  const stage = STAGES.find((s) => s === error?.stage)
  const message = text(error?.message)
  if (!error || !stage || !message) return undefined
  const line = place(error.line)
  const column = place(error.column)
  return {
    stage,
    message,
    ...(line !== undefined && { line }),
    ...(column !== undefined && { column }),
  }
}

const RESTORES: readonly SceneRestore[] = [
  'restored',
  'none',
  'stale',
  'incompatible',
]

/** At most 32 values, each a number, a boolean or up to 200 characters. */
function readValues(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  const raw = object(value)
  if (!raw) return undefined
  const values: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(raw).slice(0, 32)) {
    if (typeof entry === 'string')
      values[key.slice(0, 100)] = entry.slice(0, 200)
    else if (typeof entry === 'boolean' || Number.isFinite(entry))
      values[key.slice(0, 100)] = entry as number | boolean
  }
  return Object.keys(values).length > 0 ? values : undefined
}

function readEntity(value: unknown): SceneEntity | undefined {
  const entity = object(value)
  const id = text(entity?.id)
  if (!entity || !id) return undefined
  const label = text(entity.label)
  const kind = text(entity.kind)
  const detail = text(entity.detail)
  const values = readValues(entity.values)
  const phase =
    typeof entity.phase === 'string' || Number.isFinite(entity.phase)
      ? (entity.phase as string | number)
      : undefined
  return {
    id,
    ...(label && { label }),
    ...(kind && { kind }),
    ...(detail && { detail }),
    ...(values && { values }),
    ...(phase !== undefined && { phase }),
  }
}

/** A checkpoint the card can keep: versioned, tied to a package, and not too large. */
export function readCheckpoint(value: unknown): SceneCheckpoint | undefined {
  const checkpoint = object(value)
  if (
    !checkpoint ||
    !Number.isInteger(checkpoint.version) ||
    !text(checkpoint.packageDigest)
  )
    return undefined
  try {
    if (JSON.stringify(checkpoint).length > CHECKPOINT_LIMIT) return undefined
  } catch {
    return undefined
  }
  return checkpoint as SceneCheckpoint
}

/** A message from the scene page, or undefined for anything else. */
export function readFrameMessage(data: unknown): FrameMessage | undefined {
  const message = object(data)
  if (!message) return undefined
  switch (message.type) {
    case 'sceneos:host-ready':
    case 'sceneos:dismiss':
      return { type: message.type }
    case 'sceneos:mounted': {
      const ok = message.ok === true
      const error = ok ? undefined : readError(message.error)
      const restore = RESTORES.find((r) => r === message.restore)
      return {
        type: 'sceneos:mounted',
        ok,
        ...(error && { error }),
        ...(restore && { restore }),
      }
    }
    case 'sceneos:state': {
      const checkpoint = readCheckpoint(message.checkpoint)
      return checkpoint && { type: 'sceneos:state', checkpoint }
    }
    case 'sceneos:poster': {
      // Only a still image the card can draw, never another kind of URL.
      const image =
        typeof message.image === 'string' &&
        /^data:image\/(webp|png|jpeg);base64,/.test(message.image) &&
        message.image.length <= POSTER_LIMIT
          ? message.image
          : ''
      return { type: 'sceneos:poster', image }
    }
    case 'sceneos:error': {
      const error = readError(message.error)
      return error && { type: 'sceneos:error', error }
    }
    case 'sceneos:select': {
      if (message.entity === null)
        return { type: 'sceneos:select', entity: null }
      const entity = readEntity(message.entity)
      return entity && { type: 'sceneos:select', entity }
    }
    case 'sceneos:ask': {
      const entity = readEntity(message.entity)
      return entity && { type: 'sceneos:ask', entity }
    }
    default:
      return undefined
  }
}

/** One line: stage, place, message, as the page shows it. */
export function errorLine(error: ModuleError): string {
  const where =
    error.line === undefined
      ? ''
      : ` at line ${error.line}${error.column === undefined ? '' : `, column ${error.column}`}`
  return `${error.stage}${where}: ${error.message}`
}

/** The message Fix sends: the agent wrote the code, so it is asked to mend it. */
export function repairRequest(
  title: string | undefined,
  error: ModuleError,
): string {
  const name = title ? ` "${title}"` : ''
  return `The immersive artifact${name} failed: ${errorLine(error)}. Fix its code and show it again.`
}
