// SOURCING: none — a keyed map mirrored to sessionStorage; the page owns what a checkpoint means (scene-os-web embed.ts), this only keeps the last one per scene revision.
//
// Where the reader had got to in each scene, so a scene that is suspended,
// left by navigating away, or reloaded in the same tab opens where it was.
// One checkpoint per scene revision; the oldest are dropped past a bound.
import { readCheckpoint } from './scene-model'
import type { Scene, SceneCheckpoint } from './scene-model'

const STORAGE_KEY = 'theorem-scene-checkpoints'
const KEPT = 40

const kept = new Map<string, SceneCheckpoint>()
let loaded = false

/** One revision of one scene: its id and the package it drew. */
export const checkpointKey = (scene: Scene) =>
  `${scene.sceneId}#${scene.packageHash ?? ''}`

function load() {
  if (loaded) return
  loaded = true
  try {
    const stored: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? '[]',
    )
    if (!Array.isArray(stored)) return
    for (const entry of stored) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const checkpoint = readCheckpoint(entry[1])
      if (checkpoint) kept.set(entry[0], checkpoint)
    }
  } catch {
    // Storage that cannot be read starts empty; the scene opens fresh.
  }
}

function save() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...kept]))
  } catch {
    // Full or blocked storage keeps checkpoints for this page's life only.
  }
}

export function checkpointFor(key: string): SceneCheckpoint | undefined {
  load()
  return kept.get(key)
}

export function keepCheckpoint(key: string, checkpoint: SceneCheckpoint) {
  load()
  // Newest last, so the first entries are the ones to drop.
  kept.delete(key)
  kept.set(key, checkpoint)
  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT) break
    kept.delete(oldest)
  }
  save()
}

/** Forgets a checkpoint the page could not use, so the next mount starts fresh. */
export function dropCheckpoint(key: string) {
  load()
  if (kept.delete(key)) save()
}
