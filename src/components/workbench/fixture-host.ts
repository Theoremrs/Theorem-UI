// SOURCING: none — the stories' fixture host: an Adapter whose answers are committed constants and whose documents, repository and terminal keep a little state, so the real wasm workbench draws and reacts with no network and no clock. It uses the wire types; nothing else applies.
import type { Adapter } from '@/lib/workbench/adapter'
import {
  attachmentsMessage,
  modelsMessage,
  snapshotMessage,
} from '@/lib/workbench/conversation/conversation'
import type { ConversationSnapshot } from '@/lib/workbench/conversation/conversation'
import type {
  Completion,
  CompletionPayload,
  DraftAttachment,
  Effect,
  HostMessage,
  Outcome,
  PendingEdit,
  ResourceRef,
  Revision,
  RunSummary,
  ScmChange,
  TerminalAdoption,
  TerminalModes,
  TextChange,
} from '@/lib/workbench/wire'
import { STORY_CONVERSATION } from './conversation-fixture'
import {
  BRANCH,
  CHANGES,
  DOCUMENTS,
  FINDINGS,
  HEAD,
  LOG,
  NOTES_ON_DISK,
  RUNS,
  RUN_ERRORS,
  RUN_OUTPUT,
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
  /** The thread has a second branch of the reply: switching between them re-sends the snapshot. */
  branches?: boolean
  /** The language owner reports the findings the fixtures hold for each document as it opens. */
  diagnostics?: boolean
  /** The terminal owner offers a recorded session. */
  terminal?: boolean
  /**
   * What the host says about its terminal inventory in `terminal.list` (`terminalSessions.adoption`).
   * Absent is an older host that does not say: the list is never settled.
   */
  terminalAdoption?: TerminalAdoption
  /** The host lists no session at all (an empty inventory), whatever its adoption state. */
  terminalEmpty?: boolean
  /** The modes the host reports for the listed session (`TerminalSessionInfo.modes`); absent when the host does not report them. */
  terminalModes?: TerminalModes
  /** The chunks the recorded session sends on attach, in place of the default session. */
  terminalOutput?: string[]
  /**
   * `run.list` answers runs that carry how they ended (`RunSummary.exitCode`) and the configuration's
   * kind (`RunSummary.kind`): one exited 0, one exited 2 and one exited with no code given.
   */
  runExits?: boolean
  /**
   * The repository's one conflicted file is binary (`scm.conflict` with `binary: true`): a present
   * side is sent as `""` and the absent base is left out, as the SCM owner sends them.
   */
  binaryConflict?: boolean
  /**
   * The host answers edits `uncertain` (it may or may not have applied them) until a document is reopened with
   * a kept draft to offer (the host is back after a reload), so the documents owner holds each edit as pending,
   * checkpoints it on the device (`documentLocal`) and offers it back, `restored`, when the document is opened
   * after a reload. From then on the host takes edits as it does by default. The device copy lives in local storage, where the real owner's
   * `DraftStore` (`documents/local.ts`) keeps a record under `theorem-workbench:draft:<workspace>:<path>`.
   */
  holdEdits?: boolean
  /** The documents owner reports this path's disk as changed under the open document. */
  conflict?: string
  /** The signed-in account the story starts as. */
  account?: string
  /** The account's layout record survives a reload of the story (local storage stands in for the server). */
  persistLayout?: boolean
  /** The account's layout cannot be read: the host answers with this browser's copy, labelled `device`. */
  deviceLayout?: boolean
  /** Called with the kind of each effect the core asked the host for. */
  performed?: (kind: string, effect: Effect) => void
}

/** What a story can still do to the host once it is running: say something the host would say. */
export interface FixtureHost extends Adapter {
  send: (message: HostMessage) => void
  /** The terminal's recorded chunks after the resize, and the resize itself, in order. */
  resizeTerminal: () => void
  /**
   * The signed-in account changes, as the real adapter reports it: the host says so once, lets go of
   * everything of the old account and serves the new one. The mount then asks the core to load.
   */
  switchAccount: (next: string) => void
}

/** A conflicted binary file: both branches changed an image. */
const BINARY_CONFLICT: ScmChange = {
  path: 'assets/logo.png',
  index: 'U',
  worktree: 'U',
  conflict: true,
}

/** The run list of a host that reports exit codes and kinds, as the run owner reads `run.list`'s rows into `RunSummary`. */
const RUNS_WITH_EXITS: RunSummary[] = [
  {
    handle: 'h1',
    name: 'unit tests (all crates)',
    command: ['cargo', 'test', '--lib'],
    state: 'exited',
    startedAtMs: 1_700_000_000_000,
    exitCode: 0,
    kind: 'test',
  },
  {
    handle: 'h2',
    name: 'integration tests (db)',
    command: ['cargo', 'test', '--tests'],
    state: 'exited',
    startedAtMs: 1_700_000_050_000,
    exitCode: 2,
    kind: 'test',
  },
  {
    handle: 'h3',
    name: 'release build (lto)',
    command: ['cargo', 'build', '--release'],
    state: 'exited',
    startedAtMs: 1_700_000_100_000,
    kind: 'build',
  },
]

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

/** The shell's echo of typed input: printable text as it is, Enter as a new line and prompt, Backspace as an erase. */
const echo = (typed: string) =>
  typed
    .replace(
      /\r\n?|\n/g,
      '\r\n\u001b[1;32mada@story\u001b[0m:\u001b[1;34m~/project\u001b[0m$ ',
    )
    .replace(/\u007f/g, '\b \b')

/** The key and record the documents owner's `DraftStore` writes for a path (`documents/local.ts`, `nodeId` and `write`). */
const draftKey = (path: string) =>
  `theorem-workbench:draft:${WORKSPACE}:${path}`
const DRAFT_SAVED_AT_MS = 1

type Held = {
  text: string
  revision: number
  saved: number
  disk: string
  /** Edits made since the last save, kept as the device would checkpoint them. */
  pending: PendingEdit[]
  /** The edits the editor holds behind an unanswered one (`documentKeep`): kept on the device with the rest, never applied here. */
  behind?: PendingEdit[]
}

/** What the host holds for one signed-in account: nothing of it is visible to another. */
type Kept = {
  documents: Map<string, Held>
  layout: { revision: number; current?: string; namedLayouts?: string }
  /** Unsaved edits left behind when the account was switched away from, offered back as restored. */
  checkpoints: Map<string, PendingEdit[]>
}

export function createFixtureHost(
  dispatch: Dispatch,
  options: FixtureOptions,
): FixtureHost {
  let live = true
  /** `holdEdits`: the host is reachable again once a kept draft has been offered back. */
  let hostBack = false
  const tree = options.tree ?? TREE
  const accounts = new Map<string, Kept>()
  let account = options.account ?? 'ada'
  const keep = (name: string): Kept => {
    let held = accounts.get(name)
    if (!held) {
      held = {
        documents: new Map(),
        layout: { revision: 0 },
        checkpoints: new Map(),
      }
      accounts.set(name, held)
    }
    return held
  }
  const stored = (name: string) => `story-layout:${name}`
  const restoreLayout = (name: string, held: Kept) => {
    if (!options.persistLayout) return
    try {
      const text = localStorage.getItem(stored(name))
      if (text) held.layout = JSON.parse(text) as Kept['layout']
    } catch {
      // No storage: the record lives as long as the host.
    }
  }
  let kept = keep(account)
  restoreLayout(account, kept)
  let documents = kept.documents
  let offset = 0
  const epoch = 1
  /** The terminal's attachment, once something has attached. */
  let terminal:
    { resource: ResourceRef; cols: number; rows: number } | undefined
  /** The branch of the thread the transcript shows, and the revision of the last snapshot sent. */
  let branch = 'root'
  let revision = STORY_CONVERSATION.revision
  const conversationId = STORY_CONVERSATION.conversationId
  /** The draft's attachments, and the model and effort the next turn runs on. */
  let attachments: DraftAttachment[] = []
  let model = 'deepseek-v4-flash'
  let effort = 'medium'
  const sendAttachments = () =>
    send(attachmentsMessage('story-project', conversationId, attachments))
  const sendModels = () =>
    send(
      modelsMessage('story-project', conversationId, {
        models: [
          {
            ref: 'deepseek-v4-flash',
            label: 'DeepSeek V4 Flash',
            contextTokens: 128_000,
          },
          { ref: 'claude-opus', label: 'Claude Opus', contextTokens: 200_000 },
        ],
        selected: model,
        effort,
        efforts: ['low', 'medium', 'high'],
      }),
    )

  /** The transcript of the selected branch: the second branch answers with a different first line. */
  const thread = (): ConversationSnapshot => ({
    ...STORY_CONVERSATION,
    revision,
    context: { usedTokens: 18_400, windowTokens: 128_000 },
    // A thread with branches is shown at rest, so the status row can say which branch it is on.
    ...(options.branches && { run: { state: 'idle' }, approval: undefined }),
    messages: STORY_CONVERSATION.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part, index) =>
        branch === 'b1' &&
        message.role === 'assistant' &&
        index === 0 &&
        part.type === 'text'
          ? {
              ...part,
              text: 'On the other branch I started from the build log: the compiler stops at `src/panel.rs`, one line short of a semicolon.',
            }
          : part,
      ),
    })),
    ...(options.branches && {
      history: {
        rootBranchId: 'root',
        selectedBranchId: branch,
        forks: [{ branchId: 'b1', createdAtMs: 1 }],
        activeRunId: null,
      },
    }),
  })

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
  const changes = (
    options.binaryConflict
      ? [...CHANGES.filter(({ conflict }) => !conflict), BINARY_CONFLICT]
      : CHANGES
  ).map((change) => ({ ...change }))
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
        sessions: options.terminalEmpty
          ? []
          : [
              {
                session: TERMINAL_SESSION,
                profile: 'Shell',
                backend: 'native',
                workspace: WORKSPACE,
                program: 1,
                state: 'running',
                controlledElsewhere: false,
                ...(options.terminalModes
                  ? { modes: options.terminalModes }
                  : {}),
              },
            ],
        ...(options.terminalAdoption
          ? { adoption: options.terminalAdoption }
          : {}),
      })
    // The conversation owner's first snapshot, as its port sends one at connect.
    if (options.transcript)
      dispatch({
        channel: 'host',
        ...snapshotMessage('story-project', thread()),
      })
  })

  const clearDraft = (path: string) => {
    try {
      localStorage.removeItem(draftKey(path))
    } catch {
      // Nothing was kept.
    }
  }

  /** The device record for one document: every edit held, then every edit held behind them, in order. */
  function writeDraft(path: string, held: Held) {
    const all = [...held.pending, ...(held.behind ?? [])]
    if (all.length === 0) return clearDraft(path)
    try {
      localStorage.setItem(
        draftKey(path),
        JSON.stringify({
          workspaceId: WORKSPACE,
          path,
          revision: held.revision,
          draft: JSON.stringify(
            all.map(({ operationId, baseRevision, edits }) => ({
              operationId,
              baseRevision,
              edits,
            })),
          ),
          savedAtMs: DRAFT_SAVED_AT_MS,
        }),
      )
    } catch {
      // Without a store the owner says the draft is held in memory only; a story needs the store.
    }
  }

  /** What `restore` in `documents/documents.ts` reads back: each kept edit, `restored`, with the reason it states. */
  function deviceDraft(path: string, held: Held): PendingEdit[] | undefined {
    try {
      const text = localStorage.getItem(draftKey(path))
      if (!text) return undefined
      const record = JSON.parse(text) as { draft: string }
      const edits = JSON.parse(record.draft) as PendingEdit[]
      hostBack = true
      held.pending = edits.map((edit) => ({
        ...edit,
        state: 'restored' as const,
        reason: `Kept on this device before a reload, against revision ${edit.baseRevision.value}; the document is at revision ${held.revision}`,
      }))
      return held.pending
    } catch {
      return undefined
    }
  }

  function document(effect: Effect): [string, Held] | undefined {
    if (effect.resource.type !== 'document') return undefined
    const path = effect.resource.resourceId
    const held = documents.get(path)
    return held ? [path, held] : undefined
  }

  function perform(effect: Effect) {
    options.performed?.(effect.kind, effect)
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
        if (effect.resource.type !== 'document')
          return refuse(effect, 'Not a document')
        const path = effect.resource.resourceId
        const text = DOCUMENTS[path] ?? effect.payload.seedText ?? ''
        const held = documents.get(path) ?? {
          text,
          revision: 1,
          saved: 1,
          disk: text,
          pending: [],
        }
        documents.set(path, held)
        // Unsaved edits this account left behind come back as restored edits, never applied on their own.
        const restored =
          kept.checkpoints.get(path) ??
          (options.holdEdits ? deviceDraft(path, held) : undefined)
        accept(effect, {
          type: 'documentOpened',
          text: held.text,
          revision: seq(held.revision),
          savedRevision: seq(held.saved),
          dirty: held.revision !== held.saved,
          ...(restored ? { pending: restored } : {}),
        })
        if (restored)
          send({
            type: 'documentLocal',
            resource: effect.resource,
            local: {
              state: 'checkpointed',
              savedAtMs: DRAFT_SAVED_AT_MS,
              recovered: true,
            },
          })
        // The language owner reports what it found in the document as it opens.
        if (options.diagnostics && FINDINGS[path])
          send({
            type: 'diagnosticsSet',
            path,
            revision: seq(held.revision),
            encoding: 'utf16_code_units',
            findings: FINDINGS[path],
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
        const [path, held] = found
        if (options.holdEdits && !hostBack) {
          held.pending.push({
            operationId: effect.payload.operationId,
            baseRevision: seq(held.revision),
            edits: effect.payload.edits,
            state: 'uncertain',
            reason: 'The host did not answer in time',
          })
          send({
            type: 'documentLocal',
            resource: effect.resource,
            local: { state: 'draft' },
          })
          // An edit that reaches the host leaves the queue behind it by its operation id.
          held.behind = held.behind?.filter(
            ({ operationId }) => operationId !== effect.payload.operationId,
          )
          writeDraft(path, held)
          send({
            type: 'documentLocal',
            resource: effect.resource,
            local: {
              state: 'checkpointed',
              savedAtMs: DRAFT_SAVED_AT_MS,
              recovered: false,
            },
          })
          return complete(effect, {
            status: 'uncertain',
            reason: 'The host did not answer in time',
          })
        }
        held.pending.push({
          operationId: effect.payload.operationId,
          baseRevision: seq(held.revision),
          edits: effect.payload.edits,
          state: 'inflight',
        })
        held.text = applyEdits(held.text, effect.payload.edits)
        held.revision += 1
        if (options.holdEdits) {
          // The owner drops an accepted edit from what it holds and says the device copy is no longer needed.
          held.pending = held.pending.filter(
            ({ operationId }) => operationId !== effect.payload.operationId,
          )
          held.behind = held.behind?.filter(
            ({ operationId }) => operationId !== effect.payload.operationId,
          )
          writeDraft(path, held)
          send({
            type: 'documentLocal',
            resource: effect.resource,
            local:
              held.pending.length + (held.behind?.length ?? 0) > 0
                ? {
                    state: 'checkpointed',
                    savedAtMs: DRAFT_SAVED_AT_MS,
                    recovered: false,
                  }
                : { state: 'accepted' },
          })
        }
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
        held.pending = []
        held.behind = []
        kept.checkpoints.delete(found[0])
        clearDraft(found[0])
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
        if (options.diagnostics && effect.resource.type === 'document')
          send({ type: 'diagnosticsCleared', path: effect.resource.resourceId })
        return accept(effect)
      case 'documentKeep': {
        const found = document(effect)
        if (!found) return refuse(effect, 'This document is not open')
        const [path, held] = found
        // The whole queue each time; kept on the device and applied nowhere.
        held.behind = effect.payload.edits.map(
          ({ operationId, baseRevision, edits }) => ({
            operationId,
            baseRevision,
            edits,
            state: 'restored' as const,
          }),
        )
        writeDraft(path, held)
        send({
          type: 'documentLocal',
          resource: effect.resource,
          local:
            held.pending.length + held.behind.length > 0
              ? {
                  state: 'checkpointed',
                  savedAtMs: DRAFT_SAVED_AT_MS,
                  recovered: false,
                }
              : { state: 'accepted' },
        })
        return accept(effect)
      }
      case 'documentSettle':
      case 'documentRevert':
        if (effect.resource.type === 'document') {
          const settled =
            effect.kind === 'documentSettle'
              ? effect.payload.operationId
              : undefined
          const held = documents.get(effect.resource.resourceId)
          if (held) {
            held.pending = settled
              ? held.pending.filter(
                  ({ operationId }) => operationId !== settled,
                )
              : []
            held.behind = settled
              ? held.behind?.filter(
                  ({ operationId }) => operationId !== settled,
                )
              : []
            writeDraft(effect.resource.resourceId, held)
          } else clearDraft(effect.resource.resourceId)
        }
        return accept(effect)
      case 'layoutLoad':
        return accept(effect, {
          type: 'layoutLoaded',
          source: options.deviceLayout ? 'device' : 'account',
          revision: seq(kept.layout.revision),
          ...(kept.layout.current !== undefined && !options.deviceLayout
            ? {
                document: {
                  current: kept.layout.current,
                  namedLayouts: kept.layout.namedLayouts ?? '{}',
                },
              }
            : {}),
        })
      case 'layoutSave': {
        kept.layout = {
          revision: kept.layout.revision + 1,
          current: effect.payload.current,
          namedLayouts: effect.payload.namedLayouts,
        }
        if (options.persistLayout)
          try {
            localStorage.setItem(stored(account), JSON.stringify(kept.layout))
          } catch {
            // No storage: the record lives as long as the host.
          }
        return accept(effect, {
          type: 'layoutSaved',
          revision: seq(kept.layout.revision),
        })
      }
      case 'scmStatus':
        return accept(effect, {
          type: 'scm',
          branch: BRANCH,
          head: HEAD,
          changes: changes,
          state: { head: HEAD, branch: BRANCH },
        })
      case 'scmStage':
      case 'scmUnstage': {
        const staging = effect.kind === 'scmStage'
        for (const change of changes) {
          if (!effect.payload.paths.includes(change.path) || change.conflict)
            continue
          if (staging) {
            change.index = change.worktree === '?' ? 'A' : change.worktree
            change.worktree = ' '
          } else {
            change.worktree = change.index === 'A' ? '?' : change.index
            change.index = change.worktree === '?' ? '?' : ' '
          }
        }
        return accept(effect, { type: 'scmState', head: HEAD, branch: BRANCH })
      }
      case 'scmConflict': {
        // The SCM owner's `ConflictSides`: a binary file's present sides are `""`, an absent one is left out.
        const change = changes.find(({ path }) => path === effect.payload.path)
        if (!change || effect.payload.path !== BINARY_CONFLICT.path)
          return refuse(effect, 'This story has no such conflict')
        return accept(effect, {
          type: 'scmConflict',
          path: change.path,
          conflict: change.conflict,
          binary: true,
          ours: '',
          theirs: '',
        })
      }
      case 'scmResolve': {
        const change = changes.find(({ path }) => path === effect.payload.path)
        if (!change?.conflict) return refuse(effect, 'Not in conflict')
        change.conflict = false
        change.index = 'M'
        change.worktree = ' '
        return accept(effect, { type: 'scmState', head: HEAD, branch: BRANCH })
      }
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
        if (
          effect.resource.type !== 'terminal' &&
          effect.kind === 'terminalAttach'
        )
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
          for (const chunk of options.terminalOutput ?? TERMINAL_BEFORE_RESIZE)
            frame(resource, chunk)
        })
        return
      }
      case 'languageDiagnostics':
        return accept(effect, {
          type: 'languageDiagnostics',
          full: true,
          findings: [],
        })
      case 'conversationSwitchBranch': {
        branch = effect.payload.branchId
        revision += 1
        accept(effect, {
          type: 'conversationOpened',
          conversationId: effect.payload.threadId,
        })
        send(snapshotMessage('story-project', thread()))
        return
      }
      case 'searchQuery': {
        const needle = effect.payload.query.toLowerCase()
        const rows = Object.entries(DOCUMENTS).flatMap(([path, text]) =>
          text.split('\n').flatMap((line, index) => {
            const start = line.toLowerCase().indexOf(needle)
            return needle && start >= 0
              ? [
                  {
                    path,
                    line: index + 1,
                    text: line,
                    matches: [{ start, end: start + needle.length }],
                  },
                ]
              : []
          }),
        )
        accept(effect, { type: 'searchStarted', id: 'search-1' })
        send({
          type: 'searchPage',
          id: 'search-1',
          rows,
          skipped: 0,
          state: 'complete',
          readAt: { workspaceId: WORKSPACE, generation: 1 },
          encoding: 'utf16_code_units',
        })
        return
      }
      case 'searchCancel':
      case 'runConfigure':
      case 'runStop':
        return accept(effect)
      case 'runStart':
        return accept(effect, { type: 'runStarted', handle: 'run-1' })
      case 'runList':
        return accept(effect, {
          type: 'runList',
          runs: options.runExits ? RUNS_WITH_EXITS : RUNS,
        })
      case 'runPoll': {
        const listed = RUNS.find((run) => run.handle === effect.payload.handle)
        // A listed run is one the host already finished or still runs; the one this fixture
        // started ends at once.
        return accept(effect, {
          type: 'runState',
          handle: effect.payload.handle,
          state: listed?.state ?? 'exited',
          exitCode: listed ? (listed.state === 'exited' ? 101 : undefined) : 0,
          stdout: listed
            ? RUN_OUTPUT
            : 'running 2 tests\ntest add ... ok\ntest sub ... ok\n',
          stderr: listed ? RUN_ERRORS : '',
          readAt: { workspaceId: WORKSPACE, generation: 1 },
        })
      }
      case 'conversationAttachPick':
        accept(effect)
        attachments = [
          ...attachments,
          {
            id: `att-${attachments.length + 1}`,
            name: 'build.log',
            contentType: 'text/plain',
            size: 2048,
            state: 'ready',
          },
        ]
        return sendAttachments()
      case 'conversationAttachRemove':
        accept(effect)
        attachments = attachments.filter(({ id }) => id !== effect.payload.id)
        return sendAttachments()
      case 'conversationModels':
        accept(effect)
        return sendModels()
      case 'conversationSetModel':
        accept(effect)
        model = effect.payload.ref
        return sendModels()
      case 'conversationSetEffort':
        accept(effect)
        effort = effect.payload.level
        return sendModels()
      case 'terminalResize':
        return accept(effect)
      case 'terminalInput':
      case 'terminalInputBytes': {
        accept(effect)
        // A tiny line discipline: what is typed comes back as the shell would echo it, and Enter
        // ends the line and shows the prompt again.
        if (terminal) {
          const typed =
            effect.kind === 'terminalInput'
              ? effect.payload.bytes
              : atob(effect.payload.data)
          frame(terminal.resource, echo(typed))
        }
        return
      }
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
    switchAccount(next) {
      // What the old account had not saved is checkpointed under it, as the device would.
      for (const [path, held] of documents)
        if (held.revision !== held.saved) {
          kept.checkpoints.set(
            path,
            held.pending.map((edit) => ({
              ...edit,
              state: 'restored' as const,
            })),
          )
          // The file itself is what was saved: the draft lived only on the device.
          held.text = held.disk
          held.revision = held.saved
          held.pending = []
        }
      send({ type: 'accountChanged', account: next })
      send({ type: 'capabilitiesChanged', capabilities: { granted: [] } })
      send({ type: 'connectionChanged', workspace: WORKSPACE, state: 'closed' })
      account = next
      kept = keep(account)
      restoreLayout(account, kept)
      documents = kept.documents
      later(() => {
        send({
          type: 'workspaceChanged',
          workspace: WORKSPACE,
          environment: 'story',
        })
        send({
          type: 'capabilitiesChanged',
          capabilities: { granted: options.granted },
        })
        send({ type: 'connectionChanged', workspace: WORKSPACE, state: 'open' })
      })
    },
    dispose() {
      live = false
    },
  }
}
