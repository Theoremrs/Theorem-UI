// SOURCING: the notebook artifact's frame (NotebookFrame: the hosted App
// frame over BlockFrame, sandbox "allow-scripts" and no network, with the
// page's theme followed in) running @observablehq/notebook-kit cells through
// observable-document; composer-references' store for the selection, as a
// message reference (as scene-part asks about an entity); apps'
// createAppDocument and save-as-page's dialog to keep the view as an App and
// reopen it from Pages; coss's toast for the outcome once the menu has
// closed (as thread-menu says a refusal). No library hosts an agent-written
// Observable notebook inside a chat reply.
//
// A view the agent writes into its reply: Observable cells with d3, Plot,
// Inputs and the reusable `views`, run in the sandboxed frame. It stands in
// the answer as the notebook alone, with a caption when the agent gives one;
// its cells are shown in the terminal. The person works it without a model
// turn, and what they select is put beside the composer as context for the
// next question. Saving it as an App and expanding it are in the reply's
// More menu (view-actions.ts); expanding keeps the running frame.
import { useAui, useAuiState } from '@assistant-ui/react'
import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { NotebookFrame } from '@/components/artifacts/notebook-artifact'
import { SaveAppAsPageDialog } from '@/components/artifacts/save-as-page'
import {
  referenceKey,
  useComposerReferences,
} from '@/components/chat/composer-references'
import { toastManager } from '@/components/coss/toast'
import { Button } from '@/components/ui/button'
import type { AppSelection, FrameError } from '@/lib/blocks/sandbox/protocol'
import { resolvedTheme } from '@/lib/blocks/sandbox/theme'
import type { ThemeState } from '@/lib/blocks/sandbox/theme'
import {
  selectionSays,
  viewReference,
  viewRevision,
} from '@/lib/generative/view-reference'
import { escapeHtml, scriptJson } from '@/lib/notebooks/page'
import {
  observableDocument,
  observablePage,
} from '@/lib/notebooks/observable-document'
import type { SavedView } from '@/lib/notebooks/observable-document'
import { createAppDocument } from '@/lib/theorem/apps'
import { describeError } from '@/lib/theorem/client'
import { cn } from '@/lib/utils'
import { safeHref } from '../utils/href'
import { useViewActions } from './view-actions'

export type InteractiveViewProps = {
  title?: string
  cells?: Array<string>
  data?: unknown
  caption?: string
  source?: string
  sourceUrl?: string
}

/** What the view is saved with: the parameters moved, and every view's state. */
function savedOf(selection?: AppSelection): SavedView | undefined {
  const state = selection?.state
  if (!state) return undefined
  const { params, ...views } = state as { params?: Record<string, unknown> }
  return {
    ...(params && { params }),
    ...(Object.keys(views).length && { state: views }),
  }
}

/** The message Fix sends: the agent wrote the cells, so it is asked to mend them. */
const repairRequest = (title: string, error: FrameError) =>
  `The interactive view "${title}" failed: ${error.message}. Fix its cells and show it again.`

export function InteractiveView(props: InteractiveViewProps) {
  const title = props.title?.trim() || props.caption?.trim() || 'Interactive view'
  const cells = useMemo(
    () => (Array.isArray(props.cells) ? props.cells.filter((cell) => typeof cell === 'string') : []),
    [props.cells],
  )
  const revision = useMemo(() => viewRevision(cells, props.data), [cells, props.data])
  // One notebook per definition: a new revision builds a new page.
  const notebook = useMemo(
    () => ({
      title,
      cells: cells.map((source, index) => ({ id: `c${index + 1}`, kind: 'js' as const, source })),
      data: props.data,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision],
  )
  const build = useCallback((theme: ThemeState) => observableDocument(notebook, theme, { inline: true }), [notebook])

  const threadId = useAuiState((s) => s.threadListItem.remoteId)
  const messageId = useAuiState((s) => s.message.id)
  const id = useId()
  const touch = useViewActions((s) => s.touch)

  // The selection, held for this definition only, and put beside the
  // composer as context; clearing it in the view takes it away again.
  const [held, setHeld] = useState<{ revision: string; selection: AppSelection }>()
  const selection = held?.revision === revision ? held.selection : undefined
  const onSelection = useCallback(
    (next: AppSelection) => {
      setHeld({ revision, selection: next })
      touch(messageId, id)
      if (!threadId) return
      const reference = viewReference({ threadId, messageId, title, revision, selection: next })
      const references = useComposerReferences.getState()
      if (selectionSays(next)) references.add(reference)
      else references.remove(referenceKey(reference))
    },
    [revision, touch, messageId, id, threadId, title],
  )

  const [failure, setFailure] = useState<FrameError>()
  const onError = useCallback((error: FrameError) => setFailure((seen) => seen ?? error), [])
  useEffect(() => setFailure(undefined), [revision])

  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setExpanded(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [expanded])

  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined
  const [saving, setSaving] = useState<{ documentId: string; html: string }>()
  const save = useCallback(async () => {
    try {
      const saved = savedOf(selection)
      const definition = {
        title,
        cells,
        data: props.data ?? null,
        source: props.source,
        revision,
        ...(saved && { saved }),
      }
      const html = await observablePage(notebook, resolvedTheme(), {
        saved,
        head: `<script type="application/json" id="theorem-view">${scriptJson(definition)}</script>\n<meta name="description" content="${escapeHtml(`Interactive view saved from a reply: ${title}`)}">`,
      })
      const { documentId } = await createAppDocument(title, html)
      setSaving({ documentId, html })
    } catch (error) {
      toastManager.add({ type: 'error', title: 'The view was not saved', description: describeError(error, 'document') })
    }
  }, [selection, title, cells, props.data, props.source, revision, notebook])

  const register = useViewActions((s) => s.register)
  useEffect(
    () => register(messageId, id, { save: () => void save(), expand: () => setExpanded(true) }),
    [register, messageId, id, save],
  )

  const sourceHref = safeHref(props.sourceUrl)
  const caption = props.caption?.trim()
  const credit = props.source?.trim()

  return (
    <>
      {expanded && (
        <div
          aria-hidden
          data-slot="interactive-view-backdrop"
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setExpanded(false)}
        />
      )}
      {/* The notebook alone: no frame or toolbar, so it reads as part of the
          answer. Expanded, the same element is lifted over the page, so the
          running frame and what the person did in it stay. */}
      <figure
        data-slot="interactive-view"
        data-expanded={expanded || undefined}
        role={expanded ? 'dialog' : 'group'}
        aria-modal={expanded || undefined}
        aria-label={title}
        className={cn(
          'my-2',
          expanded && 'bg-artifact fixed inset-4 z-50 m-0 overflow-auto rounded-lg p-4 sm:inset-8',
        )}
        onPointerDown={() => touch(messageId, id)}
      >
        {cells.length ? (
          <NotebookFrame
            build={build}
            buildKey={notebook}
            title={title}
            loading="Starting the view…"
            onSelection={onSelection}
            onError={onError}
          />
        ) : (
          <p className="py-3 text-sm text-ink-muted">This view has no cells.</p>
        )}
        {failure && (
          <FailureLine
            failure={failure}
            onFix={() => {
              setFailure(undefined)
              return repairRequest(title, failure)
            }}
          />
        )}
        {(caption || credit) && (
          <figcaption data-appearance-recipe="metadata" className="mt-1.5 text-ink-muted">
            {caption}
            {caption && credit && ' · '}
            {credit &&
              (sourceHref ? (
                <a
                  href={sourceHref}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link underline underline-offset-2"
                >
                  {credit}
                </a>
              ) : (
                credit
              ))}
          </figcaption>
        )}
      </figure>
      {saving && (
        <SaveAppAsPageDialog
          title={title}
          documentId={saving.documentId}
          latest
          loadSource={async () => saving.html}
          onClose={() => setSaving(undefined)}
          onSaved={(page) => {
            setSaving(undefined)
            toastManager.add({
              type: 'success',
              title: `Saved as the page ${page.title}`,
              ...(router && {
                actionProps: {
                  children: 'Open it',
                  onClick: () =>
                    void router.navigate({ to: '/pages/$pageId', params: { pageId: page.entryId } }),
                },
              }),
            })
          }}
        />
      )}
    </>
  )
}

/** A cell's failure where the drawing would be, with Fix, which asks the agent once. */
function FailureLine({ failure, onFix }: { failure: FrameError; onFix: () => string }) {
  const aui = useAui()
  const threadRunning = useAuiState((s) => s.thread.isRunning)
  return (
    <div role="alert" className="mt-2 flex items-start gap-2 font-mono text-xs text-error-ink">
      <span className="min-w-0 flex-1 break-words">{failure.message}</span>
      <Button
        size="xs"
        variant="ghost"
        disabled={threadRunning}
        onClick={() => aui.thread.append(onFix())}
      >
        Fix
      </Button>
    </div>
  )
}
