// SOURCING: @theoremharness/sdk — each call is the generated client.ide.workspace.files* operation
// and file.changed arrives on WorkspaceLive, both through ../environment; the two list shapes are read
// by ./directory-listing and copy-over by ./replace-entry (both copied verbatim from the Theia
// extension). This file only maps the host's answers to the workbench's completion shape.

import type { WorkspaceLiveEvents } from '@theoremharness/sdk'
import type { Environment, OperationHeaders } from '../environment/environment'
import { createRun } from '../environment/run'
import { accepted, refused } from '../environment/result'
import type { Answers, Completion } from '../environment/result'
import { childrenOf } from './directory-listing'
import type { DirectoryListing } from './directory-listing'
import { replaceWithCopy } from './replace-entry'

export interface FileRow {
  name: string
  /** Workspace-relative, `/`-separated. */
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size?: number
  /** Milliseconds since the epoch, when the host gives it. */
  modified?: number
  /** Only what the host says; nothing is guessed from the name. */
  ignored?: boolean
  hidden?: boolean
}

export interface Listing {
  path: string
  rows: FileRow[]
}

export interface FileStat {
  path: string
  /** `missing` is an answer, not a failure. */
  kind: 'file' | 'directory' | 'symlink' | 'missing'
  size?: number
  /** Milliseconds since the epoch, when the host gives it. */
  modified?: number
  readonly?: boolean
}

export interface SearchResult {
  /** Rows whose name matches, with workspace-relative paths, in the host's order. */
  rows: FileRow[]
  /** Never read as exhaustive: the host's whole-tree listing leaves out its excludes, and the page may end before the matches do. */
  partial: boolean
  /** The `offset` of the next page; absent on the last. */
  next?: number
}

export interface TextFile {
  path: string
  text: string
  /** The host's revision, etag or content hash when it sends one. */
  revision?: string
}

export type FilesEvent =
  | ({
      kind: 'changed'
      workspaceId: string
    } & WorkspaceLiveEvents['file.changed'])
  /** Events may have been lost: list again. */
  | { kind: 'resync'; workspaceId: string; reason: string }

interface Request {
  requestId: string
}

export interface Files {
  list: (request: Request & { path: string }) => Promise<Completion<Listing>>
  read: (request: Request & { path: string }) => Promise<Completion<TextFile>>
  /** What a path is now; a path that is not there is an answer (`missing`). */
  stat: (request: Request & { path: string }) => Promise<Completion<FileStat>>
  /**
   * File names containing `query` (case-insensitive), over the host's whole-tree `workspace.files.list`;
   * refused as `missing_capability` naming that operation when the host answers only one directory.
   */
  search: (
    request: Request & { query: string; limit?: number; offset?: number },
  ) => Promise<Completion<SearchResult>>
  create: (
    request: Request & {
      path: string
      kind: 'file' | 'directory'
      text?: string
    },
  ) => Promise<Completion<{ path: string }>>
  /** Rename and move are one host operation. */
  rename: (
    request: Request & { from: string; to: string },
  ) => Promise<Completion<{ from: string; to: string }>>
  delete: (
    request: Request & { path: string },
  ) => Promise<Completion<{ path: string }>>
  /** Only when the host advertises `workspace.files.copy`; otherwise refused with that reason. */
  copy: (
    request: Request & { from: string; to: string; overwrite?: boolean },
  ) => Promise<Completion<{ from: string; to: string }>>
  /** Changes to the direct children of `directory` (`''` is the root). Returns the unsubscribe. */
  watch: (
    directory: string,
    listener: (event: FilesEvent) => void,
  ) => () => void
}

const COPY = 'workspace.files.copy'
/** Names returned per page of a name search. */
const SEARCH_PAGE = 200

interface RawRow {
  name?: unknown
  kind?: unknown
  size?: unknown
  mtime_ms?: unknown
  ignored?: unknown
  hidden?: unknown
}

const number = (value: unknown) =>
  typeof value === 'number' ? value : undefined
const flag = (value: unknown) =>
  typeof value === 'boolean' ? value : undefined

/** The workspace path without a leading `./` or trailing `/`; the root is `''`. */
export function normalizePath(path: string): string {
  return path
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '')
}

/** A path that stays inside the workspace: relative, with no `..` segment. */
function escapes(path: string): boolean {
  return (
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '..')
  )
}

/**
 * One row type for both answers a host gives to `workspace.files.list`: its
 * `entries` for the directory asked about, or the whole tree as `files` and
 * `directories`. Fields beyond name and kind are read where the host gives them.
 */
export function rowsOf(
  listing: DirectoryListing,
  directory: string,
): FileRow[] {
  const known = new Map<string, RawRow>()
  for (const row of [
    ...(listing.directories ?? []),
    ...(listing.files ?? []),
  ]) {
    known.set(row.path, row)
  }
  return childrenOf(listing, directory).map((child) => {
    const path = directory ? `${directory}/${child.name}` : child.name
    const raw: RawRow = { ...known.get(path), ...child }
    return {
      name: child.name,
      path,
      kind:
        raw.kind === 'directory' || raw.kind === 'symlink' ? raw.kind : 'file',
      size: number(raw.size),
      modified: number(raw.mtime_ms),
      ignored: flag(raw.ignored),
      hidden: flag(raw.hidden),
    }
  })
}

function revisionOf(file: Record<string, unknown>): string | undefined {
  for (const field of ['revision', 'etag', 'content_hash', 'hash']) {
    const value = file[field]
    if (typeof value === 'string' || typeof value === 'number')
      return String(value)
  }
  return undefined
}

export function createFiles(env: Environment): Files {
  const { workspaceId } = env
  const files = () => env.client.ide.workspace

  const run = createRun(env)

  const outside = (requestId: string, path: string) =>
    refused(
      { workspaceId, requestId },
      'outside_workspace',
      `${path} is outside the workspace`,
    )

  /** A write's one attempt: the SDK's own retries are off, so the host sees it once. */
  const once = { maxRetries: 0 }

  return {
    async list({ requestId, path }) {
      const directory = normalizePath(path)
      if (escapes(directory)) return outside(requestId, path)
      return run(requestId, 'workspace.files.list', false, async (headers) => {
        const listing = (await files().filesList({
          ...headers,
          body: { path: directory },
        })) as DirectoryListing
        return { path: directory, rows: rowsOf(listing, directory) }
      })
    },

    async stat({ requestId, path }) {
      const target = normalizePath(path)
      if (!target || escapes(target)) return outside(requestId, path)
      const done = await run(
        requestId,
        'workspace.files.stat',
        false,
        async (headers) =>
          (await files().filesStat({
            ...headers,
            body: { path: target },
          })) as Record<string, unknown> | undefined,
        { advertised: true },
      )
      if (done.outcome !== 'accepted') return done
      const raw = done.value ?? {}
      const kind = raw.type ?? raw.kind
      if (
        kind !== 'file' &&
        kind !== 'directory' &&
        kind !== 'symlink' &&
        kind !== 'missing'
      ) {
        return {
          workspaceId,
          requestId,
          outcome: 'failed',
          reason: 'The host answered a stat without saying what the path is',
        }
      }
      return accepted(
        { workspaceId, requestId },
        {
          path: target,
          kind,
          size: number(raw.size),
          modified: number(raw.mtime_ms),
          readonly: flag(raw.readonly),
        },
      )
    },

    async search({ requestId, query, limit = SEARCH_PAGE, offset = 0 }) {
      const needle = query.trim().toLowerCase()
      if (needle === '') {
        return refused(
          { workspaceId, requestId },
          'empty_query',
          'A name search needs something to look for',
        )
      }
      const done = await run(
        requestId,
        'workspace.files.list',
        false,
        (headers) => files().filesList({ ...headers, body: {} }),
      )
      if (done.outcome !== 'accepted') return done
      const answers: Answers = { workspaceId, requestId }
      const listing = (done.value ?? {}) as DirectoryListing
      if (!listing.files && !listing.directories) {
        return refused(
          answers,
          'missing_capability',
          'workspace.files.list: this host lists one directory at a time and has no whole-tree listing to search',
        )
      }
      const rows: FileRow[] = []
      for (const row of [
        ...(listing.directories ?? []),
        ...(listing.files ?? []),
      ] as (RawRow & { path: string; kind: string })[]) {
        const name = row.path.slice(row.path.lastIndexOf('/') + 1)
        if (!name.toLowerCase().includes(needle)) continue
        rows.push({
          name,
          path: row.path,
          kind:
            row.kind === 'directory' || row.kind === 'symlink'
              ? row.kind
              : 'file',
          size: number(row.size),
          modified: number(row.mtime_ms),
          ignored: flag(row.ignored),
          hidden: flag(row.hidden),
        })
      }
      const page = rows.slice(offset, offset + limit)
      const end = offset + page.length
      return accepted(answers, {
        rows: page,
        partial: true,
        ...(end < rows.length ? { next: end } : {}),
      })
    },

    async read({ requestId, path }) {
      const file = normalizePath(path)
      if (!file || escapes(file)) return outside(requestId, path)
      const done = await run(
        requestId,
        'workspace.files.read',
        false,
        async (headers) =>
          (await files().filesRead({
            ...headers,
            body: { path: file },
          })) as Record<string, unknown>,
      )
      if (done.outcome !== 'accepted') return done
      const answers: Answers = { workspaceId, requestId }
      const raw = done.value
      if (raw.encoding === 'base64') {
        return refused(answers, 'binary_file', `${file} is not a text file`)
      }
      return accepted(answers, {
        path: file,
        text: String(raw.contents ?? ''),
        revision: revisionOf(raw),
      })
    },

    async create({ requestId, path, kind, text }) {
      const target = normalizePath(path)
      if (!target || escapes(target)) return outside(requestId, path)
      return run(requestId, 'workspace.files.create', true, async (headers) => {
        await files().filesCreate(
          {
            ...headers,
            body:
              kind === 'directory'
                ? { path: target, directory: true }
                : { path: target, contents: text ?? '' },
          },
          once,
        )
        return { path: target }
      })
    },

    async rename({ requestId, from, to }) {
      const source = normalizePath(from)
      const target = normalizePath(to)
      if (!source || escapes(source)) return outside(requestId, from)
      if (!target || escapes(target)) return outside(requestId, to)
      return run(requestId, 'workspace.files.rename', true, async (headers) => {
        await files().filesRename(
          { ...headers, body: { from: source, to: target } },
          once,
        )
        return { from: source, to: target }
      })
    },

    async delete({ requestId, path }) {
      const target = normalizePath(path)
      if (!target || escapes(target)) return outside(requestId, path)
      return run(requestId, 'workspace.files.delete', true, async (headers) => {
        await files().filesDelete({ ...headers, body: { path: target } }, once)
        return { path: target }
      })
    },

    async copy({ requestId, from, to, overwrite }) {
      const source = normalizePath(from)
      const target = normalizePath(to)
      if (!source || escapes(source)) return outside(requestId, from)
      if (!target || escapes(target)) return outside(requestId, to)
      const answers: Answers = { workspaceId, requestId }
      const filesCopy = files().filesCopy
      await env.settled()
      // Advertised by the host, but this SDK has no typed call for it yet.
      if (!filesCopy && env.has(COPY)) {
        return refused(
          answers,
          'client_cannot_copy',
          'This client has no typed copy call yet',
        )
      }
      // Each host call under one request gets its own idempotency key.
      const step = (name: string, headers: OperationHeaders) => ({
        ...headers,
        'Idempotency-Key': `${requestId}:${name}`,
      })
      return run(
        requestId,
        COPY,
        true,
        async (headers) => {
          const copyTo = async (path: string, name: string) => {
            await filesCopy!(
              { ...step(name, headers), body: { from: source, to: path } },
              once,
            )
          }
          if (!overwrite) {
            await copyTo(target, 'copy')
            return { from: source, to: target }
          }
          await replaceWithCopy(target, {
            copyTo: (path) => copyTo(path, 'copy'),
            rename: async (oldPath, newPath) => {
              await files().filesRename(
                {
                  ...step(`rename:${oldPath}`, headers),
                  body: { from: oldPath, to: newPath },
                },
                once,
              )
            },
            remove: async (path) => {
              await files().filesDelete(
                { ...step(`remove:${path}`, headers), body: { path } },
                once,
              )
            },
          })
          return { from: source, to: target }
        },
        { advertised: true },
      )
    },

    watch(directory, listener) {
      const watched = normalizePath(directory)
      const lease = env.acquireLive()
      lease.on('file.changed', ({ data }) => {
        if (data.path === '.') {
          listener({ kind: 'resync', workspaceId, reason: 'events_lost' })
          return
        }
        const path = normalizePath(data.path)
        const parent = path.includes('/')
          ? path.slice(0, path.lastIndexOf('/'))
          : ''
        if (parent === watched || path === watched) {
          listener({ kind: 'changed', workspaceId, ...data, path })
        }
      })
      lease.onReconnected(({ reason }) =>
        listener({ kind: 'resync', workspaceId, reason }),
      )
      return () => lease.release()
    },
  }
}
