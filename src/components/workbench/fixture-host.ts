// SOURCING: none — the stories' fixture host: an Adapter whose answers are committed constants and whose documents, repository and terminal keep a little state, so the real wasm workbench draws and reacts with no network and no clock. It uses the wire types; nothing else applies.
import type { Adapter } from '@/lib/workbench/adapter'
import { snapshotMessage } from '@/lib/workbench/conversation/conversation'
import type {
  Completion,
  CompletionPayload,
  Effect,
  HostMessage,
  Outcome,
  ResourceRef,
  Revision,
  TextChange,
} from '@/lib/workbench/wire'
import { STORY_CONVERSATION } from './conversation-fixture'
import {
  BRANCH,
  CHANGES,
  DOCUMENTS,
  HEAD,
  LOG,
  NOTES_ON_DISK,
  TERMINAL_AFTER_RESIZE,
  TERMINAL_BEFORE_RESIZE,
  TERMINAL_RESIZED,
  TERMINAL_SESSION,
  TREE,
  WORKSPACE,
  diffOf,
  treeKey,
} from './fixtures'
import type { Listing } from './fixtures'
import type { Dispatch } from './workbench'

export interface FixtureOptions {
  granted: string[]
  tree?: Record<string, Listing>
  /** The conversation owner has a transcript to show. */
  transcript?: boolean
  /** The terminal owner offers a recorded session. */
  terminal?: boolean
  /** The documents owner reports this path's disk as changed under the open document. */
  conflict?: string
  /** Called with the kind of each effect the core asked the host for. */
  performed?: (kind: string) => void
}

/** What a story can still do to the host once it is running: say something the host would say. */
export interface FixtureHost extends Adapter {
  send: (message: HostMessage) => void
  /** The terminal's recorded chunks after the resize, and the resize itself, in order. */
  resizeTerminal: () => void
}

const seq = (value: number): Revision => ({ scheme: 'seq', value })

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Applies one change set to a text. Offsets are UTF-16 units, JavaScript's own, against the text before the set. */
function applyEdits(text: string, edits: TextChange[]) {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.insert + out.slice(edit.end)
  return out
}

type Held = { text: string; revision: number; saved: number; disk: string }

export function createFixtureHost(
  dispatch: Dispatch,
  options: FixtureOptions,
): FixtureHost {
  let live = true
  const tree = options.tree ?? TREE
  const documents = new Map<string, Held>()
  let offset = 0
  const epoch = 1
  /** The terminal's attachment, once something has attached. */
  let terminal: { resource: ResourceRef; cols: number; rows: number } | undefined

  const later = (task: () => void) =>
    queueMicrotask(() => {
      if (live) task()
    })
  const send = (message: HostMessage) =>
    later(() => dispatch({ channel: 'host', ...message }))
  const complete = (
    effect: Effect,
    outcome: Outcome,
    payload?: CompletionPayload,
  ) => {
    const completion: Completion = {
      effect: effect.id,
      resource: effect.resource,
      outcome,
      ...(payload ? { payload } : {}),
    }
    later(() => dispatch({ channel: 'completion', ...completion }))
  }
  const accept = (effect: Effect, payload?: CompletionPayload) =>
    complete(effect, { status: 'accepted' }, payload)
  const refuse = (effect: Effect, reason: string, code = 'owner_unavailable') =>
    complete(effect, { status: 'refused', code, reason })

  /** The terminal's host messages are ordered: each frame's offset is where the last one ended. */
  const frame = (resource: ResourceRef, text: string) => {
    const data = base64(text)
    send({ type: 'terminalOutput', resource, epoch, offset, data })
    offset += new TextEncoder().encode(text).length
  }

  later(() => {
    dispatch({
      channel: 'host',
      type: 'workspaceChanged',
      workspace: WORKSPACE,
      environment: 'story',
    })
    dispatch({
      channel: 'host',
      type: 'capabilitiesChanged',
      capabilities: { granted: options.granted },
    })
    if (options.terminal)
      dispatch({
        channel: 'host',
        type: 'terminalSessions',
        workspace: WORKSPACE,
        profiles: [
          { id: 'shell', label: 'Shell', backend: 'native', available: true },
        ],
        sessions: [
          {
            session: TERMINAL_SESSION,
            profile: 'Shell',
            backend: 'native',
            workspace: WORKSPACE,
            program: 1,
            state: 'running',
            controlledElsewhere: false,
          },
        ],
      })
    // The conversation owner's first snapshot, as its port sends one at connect.
    if (options.transcript)
      dispatch({
        channel: 'host',
        ...snapshotMessage('story-project', STORY_CONVERSATION),
      })
  })

  function document(effect: Effect): [string, Held] | undefined {
    if (effect.resource.type !== 'document') return undefined
    const path = effect.resource.resourceId
    const held = documents.get(path)
    return held ? [path, held] : undefined
  }

  function perform(effect: Effect) {
    options.performed?.(effect.kind)
    switch (effect.kind) {
      case 'filesList': {
        const listing = tree[treeKey(effect.payload.path)]
        if (!listing) return refuse(effect, 'This story has no such directory')
        return accept(effect, {
          type: 'files',
          entries: listing.entries,
          partial: listing.partial ?? false,
        })
      }
      case 'documentOpen': {
        if (effect.resource.type !== 'document') return refuse(effect, 'Not a document')
        const path = effect.resource.resourceId
        const text = DOCUMENTS[path] ?? effect.payload.seedText ?? ''
        const held = documents.get(path) ?? {
          text,
          revision: 1,
          saved: 1,
          disk: text,
        }
        documents.set(path, held)
        accept(effect, {
          type: 'documentOpened',
          text: held.text,
          revision: seq(held.revision),
          savedRevision: seq(held.saved),
          dirty: held.revision !== held.saved,
        })
        // The disk changed under the open document: the owner says so on its live stream.
        if (options.conflict === path) {
          held.disk = NOTES_ON_DISK
          send({
            type: 'documentConflict',
            resource: effect.resource,
            revision: seq(held.revision),
            diskDeleted: false,
          })
        }
        return
      }
      case 'documentEdit': {
        const found = document(effect)
        if (!found) return refuse(effect, 'This document is not open')
        const [, held] = found
        held.text = applyEdits(held.text, effect.payload.edits)
        held.revision += 1
        return accept(effect, {
          type: 'documentEdited',
          operationId: effect.payload.operationId,
          revision: seq(held.revision),
        })
      }
      case 'documentSave': {
        const found = document(effect)
        if (!found) return refuse(effect, 'This document is not open')
        const [, held] = found
        held.saved = held.revision
        held.disk = held.text
        return accept(effect, {
          type: 'documentSaved',
          revision: seq(held.revision),
        })
      }
      case 'documentReconcile': {
        const found = document(effect)
        if (!found) return refuse(effect, 'This document is not open')
        const [, held] = found
        if (effect.payload.keep === 'disk') held.text = held.disk
        held.revision += 1
        held.saved = held.revision
        return accept(effect, {
          type: 'documentReconciled',
          revision: seq(held.revision),
          text: held.text,
        })
      }
      case 'documentClose':
      case 'documentSettle':
      case 'documentRevert':
        return accept(effect)
      case 'scmStatus':
        return accept(effect, {
          type: 'scm',
          branch: BRANCH,
          head: HEAD,
          changes: CHANGES,
          state: { head: HEAD, branch: BRANCH },
        })
      case 'scmDiff':
        return accept(effect, {
          type: 'scmDiff',
          ...diffOf(effect.payload.path ?? '', effect.payload.staged),
        })
      case 'scmLog':
        return accept(effect, {
          type: 'scmLog',
          commits: LOG,
          state: { head: HEAD, branch: BRANCH },
        })
      case 'scmBranches':
        return accept(effect, {
          type: 'scmBranches',
          branches: [
            { name: 'main', remote: false, current: true },
            { name: 'feat/theo-workbench', remote: false, current: false },
            {
              name: 'origin/main',
              remote: true,
              current: false,
            },
          ],
        })
      case 'terminalOpen':
      case 'terminalAttach': {
        if (effect.resource.type !== 'terminal' && effect.kind === 'terminalAttach')
          return refuse(effect, 'Not a terminal')
        const attachment =
          effect.kind === 'terminalOpen'
            ? (effect.payload.attachment ?? 'story')
            : effect.payload.attachment
        const resource: ResourceRef = {
          type: 'terminal',
          workspace: WORKSPACE,
          session: TERMINAL_SESSION,
        }
        terminal = { resource, cols: 100, rows: 24 }
        accept(effect, {
          type: 'terminal',
          session: TERMINAL_SESSION,
          cols: 100,
          rows: 24,
          backend: 'native',
          epoch,
          program: 1,
          origin: 'adopted',
          leaseGeneration: 1,
          attachment,
          controlling: true,
          controlled: true,
        })
        later(() => {
          for (const chunk of TERMINAL_BEFORE_RESIZE) frame(resource, chunk)
        })
        return
      }
      case 'languageDiagnostics':
        return accept(effect, {
          type: 'languageDiagnostics',
          full: true,
          findings: [],
        })
      case 'terminalResize':
        return accept(effect)
      case 'terminalInput':
      case 'terminalInputBytes':
      case 'terminalDetach':
        return accept(effect)
      default:
        return refuse(effect, 'This story has no owner for that')
    }
  }

  return {
    perform,
    send,
    resizeTerminal() {
      if (!terminal) return
      const { resource } = terminal
      terminal = { ...terminal, ...TERMINAL_RESIZED }
      send({ type: 'terminalResized', resource, ...TERMINAL_RESIZED })
      later(() => {
        for (const chunk of TERMINAL_AFTER_RESIZE) frame(resource, chunk)
      })
    },
    dispose() {
      live = false
    },
  }
}
