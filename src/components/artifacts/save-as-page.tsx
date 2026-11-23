// SOURCING: ui/dialog over Base UI Dialog, @tanstack/react-query for the App's source, the module
// store's useCreatePage (a page file in the vault's Pages folder, written through Theorem's page
// owner in the Theorem vault) and the built-in theorem.app module, which runs an App from its saved
// document by id. What carries over is read from the App's own `theorem:uses` declarations
// (blocks/html-app-handler's appDeclarations); @tanstack/react-router opens the page when a router
// is there. No library models "which of an App's state follows it onto a page".
import { useQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { FilePlus2 } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { appDeclarations } from '@/components/blocks/html-app-handler'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { LayoutData } from '@/lib/modules/contract'
import { newInstanceId } from '@/lib/modules/layout'
import { useCreatePage, useVaultClient } from '@/lib/modules/store'
import type { WorkspaceClient } from '@/lib/workspace/types'
import type { TheoremArtifact } from './artifact-model'
import { representationOf, sourceOf } from './artifact-registry'

const APP_MODULE = 'theorem.app'

/** A page holding one App module, bound to the App's document by its id. */
export const appPageLayout = (documentId: string): LayoutData => ({
  root: { props: {} },
  content: [
    {
      type: APP_MODULE,
      props: { id: newInstanceId(APP_MODULE), app: documentId },
    },
  ],
})

/**
 * What follows the App onto the page, as sentences. The page runs the App
 * from its saved document, so what is in that document comes along; what the
 * App keeps only in its running frame does not, and that is said outright.
 */
export function carryOver(html: string, latest: boolean): string[] {
  const { state, db } = appDeclarations(html).capabilities
  const lines: string[] = []
  if (state.length)
    lines.push(
      `Its saved state (${state.join(', ')}) is kept in its document, so the page shows the same state.`,
    )
  if (db.length)
    lines.push(
      `Its databases (${db.join(', ')}) are kept in this browser: the page shows them on this device only.`,
    )
  if (!state.length && !db.length)
    lines.push(
      'This App keeps its state only in its running frame. That state is not carried over: the page starts the App fresh from its saved source.',
    )
  if (!latest)
    lines.push(
      'This is an earlier revision. The page runs the App as it is saved now; changes made in this revision’s frame are not carried over.',
    )
  return lines
}

/** Save as page, for an App artifact; nothing for any other kind. */
export function SaveAsPage({
  artifact,
  latest,
}: {
  artifact: TheoremArtifact
  latest: boolean
}) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<{ entryId: string; title: string }>()
  if (representationOf(artifact, 'thing').contribution !== 'theorem.app')
    return null
  const { documentId } = artifact
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Save as page"
        title={
          documentId
            ? 'Save as a page that runs this App, pinned in Pages'
            : 'This App has no saved document, so a page cannot run it'
        }
        className="size-8 p-1.5"
        disabled={!documentId}
        onClick={() => {
          setSaved(undefined)
          setOpen(true)
        }}
      >
        <FilePlus2 className="size-4" />
      </Button>
      {saved && <SavedPage {...saved} />}
      {open && documentId && (
        <SaveAppAsPageDialog
          title={artifact.title}
          documentId={documentId}
          latest={latest}
          loadSource={() => sourceOf(artifact, true).load()}
          onClose={() => setOpen(false)}
          onSaved={setSaved}
        />
      )}
    </>
  )
}

/**
 * Save as page for an App document, wherever it came from: an App artifact
 * or a view saved from a reply. The vault is resolved when the dialog opens,
 * not for every App shown.
 */
export function SaveAppAsPageDialog(props: {
  title: string
  documentId: string
  latest: boolean
  /** The App as it is saved now: what the page will run. */
  loadSource: () => Promise<string>
  onClose: () => void
  onSaved: (page: { entryId: string; title: string }) => void
}) {
  const { client, isPending, missing } = useVaultClient()
  return (
    <SaveAsPageDialog
      {...props}
      client={client}
      vaultProblem={
        client || isPending
          ? undefined
          : `A page is a file in the Theorem vault. ${missing}`
      }
    />
  )
}

/** The dialog itself. Exported for its tests, which give the vault and the App's source. */
export function SaveAsPageDialog({
  client,
  vaultProblem,
  title: initialTitle,
  documentId,
  latest,
  loadSource,
  onClose,
  onSaved,
}: {
  client: WorkspaceClient | undefined
  vaultProblem?: string
  /** The page's title to start from: the App's own. */
  title: string
  documentId: string
  latest: boolean
  /** The App as it is saved now: what the page will run. */
  loadSource: () => Promise<string>
  onClose: () => void
  onSaved: (page: { entryId: string; title: string }) => void
}) {
  const [title, setTitle] = useState(initialTitle || 'App')
  const source = useQuery({
    queryKey: ['artifacts', 'save-as-page', documentId],
    queryFn: loadSource,
    retry: false,
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-semibold">
            Save as page
          </DialogTitle>
          <DialogDescription>
            A page in the vault’s Pages folder that runs this App from its saved
            document, pinned to the top of Pages. It keeps its address when
            renamed.
          </DialogDescription>
        </DialogHeader>
        <section aria-label="What carries over" className="text-sm text-ink">
          {source.isPending ? (
            <p className="text-ink-muted">Reading the App…</p>
          ) : source.error ? (
            <p className="text-ink-muted">
              The App’s source did not load ({source.error.message}), so what
              carries over to the page is not known. Its saved document is what
              the page runs.
            </p>
          ) : (
            carryOver(source.data, latest).map((line) => (
              <p key={line}>{line}</p>
            ))
          )}
        </section>
        {client ? (
          <CreateForm
            client={client}
            title={title}
            onTitle={setTitle}
            documentId={documentId}
            onSaved={(page) => {
              onSaved(page)
              onClose()
            }}
          />
        ) : (
          <p role="status" className="text-sm text-ink-muted">
            {vaultProblem ?? 'Opening the vault…'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreateForm({
  client,
  title,
  onTitle,
  documentId,
  onSaved,
}: {
  client: WorkspaceClient
  title: string
  onTitle: (title: string) => void
  documentId: string
  onSaved: (page: { entryId: string; title: string }) => void
}) {
  const create = useCreatePage(client)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const name = title.trim()
    if (!name) return
    create.mutate(
      {
        title: name,
        template: { layout: appPageLayout(documentId) },
        pinned: true,
      },
      { onSuccess: (entry) => onSaved({ entryId: entry.id, title: name }) },
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input
        autoFocus
        aria-label="Page title"
        placeholder="Page title"
        maxLength={120}
        value={title}
        onChange={(event) => onTitle(event.target.value)}
      />
      {create.error && (
        <p role="alert" className="text-sm text-error-ink">
          {create.error.message}
        </p>
      )}
      <DialogFooter>
        <Button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="bg-redwood text-on-redwood hover:bg-redwood-hover"
        >
          Save as page
        </Button>
      </DialogFooter>
    </form>
  )
}

/** What was made, with the way to it. */
export function SavedPage({ entryId, title }: { entryId: string; title: string }) {
  // Absent outside a router, as in this module's tests.
  const router = useRouter({ warn: false }) as
    ReturnType<typeof useRouter> | undefined
  return (
    <span
      role="status"
      className="flex items-center gap-1 text-xs text-ink-muted"
    >
      Saved as the page {title}.
      {router && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            void router.navigate({
              to: '/pages/$pageId',
              params: { pageId: entryId },
            })
          }
        >
          Open it
        </Button>
      )}
    </span>
  )
}
