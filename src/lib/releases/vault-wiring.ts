// SOURCING: the WorkspaceClient (src/lib/workspace/types.ts: write with
// expectedHash, tree, readText), the module catalog (src/lib/modules/registry.ts
// useModuleCatalog) and ./activation. Thin wiring: it reads each installed
// module's folder, runs the activation sequence when its files change, and
// puts a release's files back for a rollback. It writes only inside the
// module's own folder and always with the hash it last read.
import { useEffect, useRef } from 'react'
import { guardedWrite } from '@/lib/modules/contract'
import { useModuleCatalog } from '@/lib/modules/registry'
import {
  grantKey,
  useModuleGrants,
  useRevisionPolicies,
} from '@/lib/modules/grants'
import { WorkspaceConflictError } from '@/lib/workspace/types'
import type { WorkspaceClient } from '@/lib/workspace/types'
import { activateCandidate } from './activation'
import type { ActivationOutcome, ActivationPorts } from './activation'
import { appBundle } from './bundle'
import type { AppBundle } from './bundle'
import { setReleaseWriter } from './recovery'
import type { ReleaseWriter } from './recovery'
import { releaseRecords } from './store'
import { staticPreview, structuralChecks, vaultResolver } from './vault-ports'
import type { Release } from './types'

const FOLDER_OF = (path: string) => path.slice(0, path.lastIndexOf('/'))

/** Every file under `folder`, as text, by path. */
export async function readModuleFolder(
  client: WorkspaceClient,
  folder: string,
): Promise<Record<string, string>> {
  const entries = (await client.tree()).filter(
    (e) => e.kind === 'file' && e.path.startsWith(`${folder}/`),
  )
  const files: Record<string, string> = {}
  await Promise.all(
    entries.map(async (e) => {
      files[e.path] = (await client.readText(e.path)).text
    }),
  )
  return files
}

/** The activation ports for a vault: read-only grants from the host store, static preview by default. */
export function vaultPorts(
  client: WorkspaceClient,
  overrides: Partial<ActivationPorts> = {},
): ActivationPorts {
  return {
    resolve: vaultResolver(),
    compile: structuralChecks,
    preview: staticPreview,
    authority: (identity) => {
      const key = grantKey(client.workspace.id, identity)
      return {
        grant: useModuleGrants.getState().grants[key],
        policy: useRevisionPolicies.getState().policies[key],
      }
    },
    ...overrides,
  }
}

/** A release's files written back into the vault, each guarded by the hash just read. */
export function vaultWriter(client: WorkspaceClient): ReleaseWriter {
  return {
    async restore(_identity, release: Release) {
      for (const [path, text] of Object.entries(release.files)) {
        let expected: string | null = null
        let stored: string | undefined
        try {
          const read = await client.readText(path)
          expected = read.hash
          stored = read.text
        } catch {
          expected = null
        }
        try {
          await client.write(path, guardedWrite(path, stored, text), {
            expectedHash: expected,
          })
        } catch (error) {
          if (error instanceof WorkspaceConflictError)
            throw new Error(
              `${path} changed while switching back; nothing further was written. Try again.`,
            )
          throw error
        }
      }
    },
  }
}

/**
 * Keeps release records in step with the vault. When an installed module's
 * files change it runs the activation sequence over them; the release that
 * was active stays recorded as active unless the candidate passes. Also
 * registers the rollback writer while mounted.
 */
export function useReleaseTracking(client: WorkspaceClient | undefined) {
  const installed = useModuleCatalog((s) => s.installed)
  const running = useRef(new Set<string>())
  useEffect(() => {
    if (!client) return
    const writer = vaultWriter(client)
    setReleaseWriter(writer)
    return () => setReleaseWriter(undefined)
  }, [client])
  useEffect(() => {
    if (!client) return
    const state = { cancelled: false }
    for (const module of installed) {
      if (!module.path || module.origin !== 'vault') continue
      const folder = FOLDER_OF(module.path)
      if (running.current.has(module.id)) continue
      if (releaseRecords.get(module.id)?.disabled) continue
      running.current.add(module.id)
      void (async () => {
        try {
          const files = await readModuleFolder(client, folder)
          if (state.cancelled) return
          await activateCandidate(
            { identity: module.id, files },
            vaultPorts(client),
            releaseRecords,
          )
        } catch {
          // A read that failed leaves the records as they were; the next change tries again.
        } finally {
          running.current.delete(module.id)
        }
      })()
    }
    return () => {
      state.cancelled = true
    }
  }, [client, installed])
}

export type ImportMode = 'new' | 'new-release' | 'install-as-copy'

/** Slug for a folder name. */
const slug = (id: string) =>
  id
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()

/**
 * Writes an imported bundle's files into the vault, then lets tracking run the
 * activation sequence over them. A copy gets a new id and a new folder, so it
 * never overwrites or shadows the original. Nothing is activated here.
 */
export async function writeImport(
  client: WorkspaceClient,
  bundle: AppBundle,
  mode: ImportMode,
  copyIdentity?: string,
): Promise<{ identity: string; folder: string; written: string[] }> {
  const parsed = appBundle.parse(bundle)
  const oldFolder = FOLDER_OF(parsed.manifestPath)
  let identity = parsed.identity
  let folder = oldFolder
  const files = { ...parsed.files }
  if (mode === 'install-as-copy') {
    identity = copyIdentity ?? `${identity}-copy`
    const taken = new Set((await client.tree()).map((e) => e.path))
    const parent = oldFolder.slice(0, oldFolder.lastIndexOf('/'))
    folder = `${parent}/${slug(identity)}`
    for (let n = 2; [...taken].some((p) => p.startsWith(`${folder}/`)); n++)
      folder = `${parent}/${slug(identity)}-${n}`
    for (const path of Object.keys(files)) {
      const moved = `${folder}${path.slice(oldFolder.length)}`
      files[moved] = files[path]!
      delete files[path]
    }
    const manifestPath = `${folder}${parsed.manifestPath.slice(oldFolder.length)}`
    files[manifestPath] = JSON.stringify(
      { ...JSON.parse(files[manifestPath]!), id: identity },
      null,
      2,
    )
  }
  const written: string[] = []
  // The manifest goes last: the catalog never lists a module whose page is not there yet.
  const ordered = Object.keys(files).sort(
    (a, b) =>
      Number(a.endsWith('module.json')) - Number(b.endsWith('module.json')),
  )
  for (const path of ordered) {
    let expected: string | null = null
    let stored: string | undefined
    try {
      const read = await client.readText(path)
      expected = read.hash
      stored = read.text
    } catch {
      expected = null
    }
    await client.write(path, guardedWrite(path, stored, files[path]!), {
      expectedHash: expected,
    })
    written.push(path)
  }
  return { identity, folder, written }
}

export type { ActivationOutcome }
