// SOURCING: lib/releases (the module's release record and its active
// release's stored files) over lib/modules/store's vault read. What runs is
// the active release (OWN-02): after a rollback the record points at an
// earlier release while the vault folder still holds the newer files, and the
// earlier release's own copy of them is what must run.
import { useEffect, useState } from 'react'
import { parseManifest } from '@/lib/modules/contract'
import { moduleDigest } from '@/lib/modules/grants'
import { MANIFEST_NAME } from '@/lib/modules/store'
import type { ModuleFiles } from '@/lib/modules/store'
import { activeRelease } from '@/lib/releases/state'
import { useReleases } from '@/lib/releases/store'
import type { ReleaseFiles } from '@/lib/releases/types'

/** The manifest and entry text the active release holds, or none. */
export function activeReleaseText(
  files: ReleaseFiles | undefined,
  folder: string,
  entry: string,
): { manifest: string; source: string } | undefined {
  const manifest = files?.[`${folder}/${MANIFEST_NAME}`]
  const source = files?.[`${folder}/${entry}`]
  return manifest !== undefined && source !== undefined
    ? { manifest, source }
    : undefined
}

/**
 * The files to run: the active release's when it holds a manifest and entry
 * that differ from the vault's, else the vault's own. With no release record
 * yet (tracking has not run, or the module is not tracked), the vault's.
 */
export function useRunningModuleFiles(
  identity: string,
  folder: string,
  entry: string,
  vault: ModuleFiles | undefined,
): ModuleFiles | undefined {
  // Two strings, not one object: a selector must return the same value for
  // the same state, or the hook renders without end.
  const text = (state: ReturnType<typeof useReleases.getState>) => {
    const record = state.modules[identity]
    return record
      ? activeReleaseText(activeRelease(record)?.files, folder, entry)
      : undefined
  }
  const manifestText = useReleases((state) => text(state)?.manifest)
  const sourceText = useReleases((state) => text(state)?.source)
  // The parsed release, with the text it was parsed from, so a stale one
  // (the record moved on before its digest came back) is never used.
  const [parsed, setParsed] = useState<{
    manifestText: string
    files: ModuleFiles | undefined
  }>()
  useEffect(() => {
    if (manifestText === undefined || sourceText === undefined) return
    let cancelled = false
    void moduleDigest(manifestText, sourceText).then((digest) => {
      if (cancelled) return
      let files: ModuleFiles | undefined
      try {
        files = {
          manifest: parseManifest(`${folder}/${MANIFEST_NAME}`, manifestText),
          source: sourceText,
          digest,
        }
      } catch {
        // A stored release that no longer parses runs nothing of its own.
        files = undefined
      }
      setParsed({ manifestText, files })
    })
    return () => {
      cancelled = true
    }
  }, [manifestText, sourceText, folder])
  const pinned =
    parsed &&
    parsed.manifestText === manifestText &&
    parsed.files?.source === sourceText
      ? parsed.files
      : undefined
  if (!vault) return undefined
  if (!pinned || pinned.digest === vault.digest) return vault
  return pinned
}
