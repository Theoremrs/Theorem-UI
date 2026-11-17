// SOURCING: lib/theorem/project-context (Theorem's project context routes, docs/plans/project-context/CONTRACT.md, the chat Library it picks documents from and the project's uploads route a file goes up through), lib/theorem/connections (the GitHub connection's tracked repositories and the connection list, as Settings → Connections reads them), ui/dialog over Base UI Dialog with coss Checkbox and Input and Base UI RadioGroup (as components/workspace/folder-settings-dialog draws its choice), @tanstack/react-router Link for a document's page, lucide-react marks for the four kinds. Each kind points at the owner that holds the thing; the project only says which ones are its own.
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { FileText, FolderGit2, Link2, Plug, Upload, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Checkbox } from '@/components/coss/checkbox'
import { StatusBadge } from '@/components/connections/parts'
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
import { describeError } from '@/lib/theorem/client'
import { useConnections, useGithub } from '@/lib/theorem/connections'
import type { Connection } from '@/lib/theorem/connections'
import {
  CONTEXT_LIMITS,
  DOCUMENT_ACCEPT,
  DOCUMENT_MAX_BYTES,
  contextUnavailable,
  documentHref,
  documentTitle,
  keptLink,
  libraryQuery,
  linkLabel,
  linkProblem,
  repositoryUrl,
  sameReference,
  unavailableNote,
  uploadProjectDocument,
  useEditProjectContext,
  useLibrary,
  useProjectAvailability,
  useProjectContext,
} from '@/lib/theorem/project-context'
import type {
  ContextDocument,
  ContextLink,
  ContextReference,
  LibraryItem,
  ProjectContext,
  ProjectContextKind,
  UnavailableEntry,
} from '@/lib/theorem/project-context'
import { cn } from '@/lib/utils'

/** Rows a kind shows in the column before the rest wait in its editor. */
const SHOWN = 5

const KINDS = {
  documents: {
    Mark: FileText,
    label: 'Documents',
    detail: 'Documents and files every session here reads.',
  },
  repositories: {
    Mark: FolderGit2,
    label: 'Repositories',
    detail: 'Code the project works in, from the repositories Theorem tracks.',
  },
  links: {
    Mark: Link2,
    label: 'Links',
    detail: 'Pages and references kept with the project.',
  },
  connections: {
    Mark: Plug,
    label: 'Connections',
    detail: 'The connections sessions here may use.',
  },
} as const satisfies Record<
  ProjectContextKind,
  { Mark: typeof FileText; label: string; detail: string }
>

/** Partial: a kind a newer Theorem adds still reads as a source. */
const SOURCE_KIND: Partial<Record<ContextReference['kind'], string>> = {
  graph_document: 'Document',
  upload: 'File',
  record_view: 'Record view',
  record: 'Record',
}

const externalLink = 'min-w-0 truncate text-ink hover:underline'

/**
 * The context a project gives every session in it: its documents,
 * repositories, links and connections, each listed where it opens and each
 * with an editor.
 */
export function ProjectContextList({ projectId }: { projectId: string }) {
  const context = useProjectContext(projectId)
  // What the person no longer holds. Sessions are not given those entries.
  const unavailable = useProjectAvailability(projectId).data?.unavailable ?? []
  const [editing, setEditing] = useState<ProjectContextKind>()

  if (context.isPending)
    return <p className="text-sm text-ink-muted">Loading…</p>
  if (context.isError) {
    const why = contextUnavailable(context.error)
    return (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-sm text-ink-muted">
          {why === 'not-served'
            ? 'This Theorem does not serve project context yet.'
            : why === 'no-project'
              ? 'Theorem no longer has this project.'
              : `Could not be read. ${describeError(context.error)}`}
        </p>
        {!why && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void context.refetch()}
          >
            Try again
          </Button>
        )}
      </div>
    )
  }

  const { data } = context
  return (
    <>
      <div className="flex flex-col gap-3">
        <Kind
          kind="documents"
          count={data.documents.length}
          onEdit={() => setEditing('documents')}
        >
          {data.documents.slice(0, SHOWN).map((document) => (
            <li
              key={`${document.reference.kind}:${document.reference.id}`}
              className={entryRow}
            >
              <DocumentLink document={document} />
              <Unavailable
                entry={unavailable.find(
                  (entry) =>
                    entry.list === 'documents' &&
                    sameReference(entry.reference, document.reference),
                )}
              />
            </li>
          ))}
        </Kind>
        <Kind
          kind="repositories"
          count={data.repositories.length}
          onEdit={() => setEditing('repositories')}
        >
          {data.repositories.slice(0, SHOWN).map(({ fullName }) => (
            <li key={fullName} className={entryRow}>
              <a
                href={repositoryUrl(fullName)}
                target="_blank"
                rel="noreferrer noopener"
                className={externalLink}
              >
                {fullName}
              </a>
              <Unavailable
                entry={unavailable.find(
                  (entry) =>
                    entry.list === 'repositories' &&
                    entry.fullName.toLowerCase() === fullName.toLowerCase(),
                )}
              />
            </li>
          ))}
        </Kind>
        <Kind
          kind="links"
          count={data.links.length}
          onEdit={() => setEditing('links')}
        >
          {data.links.slice(0, SHOWN).map((link) => (
            <li key={link.url}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                title={link.url}
                className={externalLink}
              >
                {linkLabel(link)}
              </a>
            </li>
          ))}
        </Kind>
        <ConnectionsKind
          chosen={data.connections}
          unavailable={unavailable}
          onEdit={() => setEditing('connections')}
        />
      </div>
      <ProjectContextDialog
        projectId={projectId}
        kind={editing}
        context={data}
        onClose={() => setEditing(undefined)}
      />
    </>
  )
}

function Kind({
  kind,
  count,
  onEdit,
  action,
  children,
}: {
  kind: ProjectContextKind
  count: number
  onEdit: () => void
  action?: string
  children: ReactNode
}) {
  const { Mark, label, detail } = KINDS[kind]
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center gap-2" title={detail}>
        <Mark
          aria-hidden
          strokeWidth={1.75}
          className="size-4 shrink-0 text-ink-muted"
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {label}
        </h3>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`${action ?? (count ? 'Edit' : 'Add')} ${label.toLowerCase()}`}
          onClick={onEdit}
        >
          {action ?? (count ? 'Edit' : 'Add')}
        </Button>
      </div>
      {count > 0 && (
        <ul className="flex flex-col gap-1 pl-6 text-sm">
          {children}
          {count > SHOWN && (
            <li>
              <button
                type="button"
                onClick={onEdit}
                className="text-ink-muted hover:text-ink hover:underline"
              >
                {count - SHOWN} more
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

const entryRow = 'flex min-w-0 items-center gap-1.5'

/** Said beside an entry sessions are no longer given, as a connection's state is. */
function Unavailable({ entry }: { entry: UnavailableEntry | undefined }) {
  return entry ? (
    <span
      className="shrink-0 text-xs text-ink-muted"
      title="Sessions in this project are not given this."
    >
      · {unavailableNote(entry)}
    </span>
  ) : null
}

function DocumentLink({ document }: { document: ContextDocument }) {
  const { reference, title } = document
  const kind = SOURCE_KIND[reference.kind] ?? 'Source'
  if (reference.kind === 'graph_document')
    return (
      <Link
        to="/notes/$documentId"
        params={{ documentId: reference.id }}
        className={cn(externalLink, 'block')}
        title={`${kind}: ${title}`}
      >
        {title}
      </Link>
    )
  const href = documentHref(reference)
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(externalLink, 'block')}
      title={`${kind}: ${title}`}
    >
      {title}
    </a>
  ) : (
    <span
      className="block min-w-0 truncate text-ink"
      title={`${kind}: ${title}`}
    >
      {title}
    </span>
  )
}

function ConnectionsKind({
  chosen,
  unavailable,
  onEdit,
}: {
  chosen: string[] | null
  unavailable: UnavailableEntry[]
  onEdit: () => void
}) {
  const { data } = useConnections()
  const byId = new Map(data?.connections.map((c) => [c.id, c]))
  return (
    <Kind kind="connections" count={1} onEdit={onEdit} action="Edit">
      {chosen === null ? (
        <li className="text-ink-muted">Every enabled connection</li>
      ) : chosen.length === 0 ? (
        <li className="text-ink-muted">None</li>
      ) : (
        chosen.slice(0, SHOWN).map((id) => {
          const connection = byId.get(id)
          // Said only once the list has arrived: before that every id is merely unknown.
          const gone = unavailable.find(
            (entry) => entry.list === 'connections' && entry.id === id,
          )
          const note = gone
            ? unavailableNote(gone)
            : !data
              ? undefined
              : !connection
                ? 'removed'
                : !connection.enabled
                  ? 'off in Settings'
                  : connection.status !== 'connected'
                    ? 'not connected'
                    : undefined
          return (
            <li key={id} className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-ink">
                {connection?.label ?? id}
              </span>
              {note && (
                <span className="shrink-0 text-xs text-ink-muted">
                  · {note}
                </span>
              )}
            </li>
          )
        })
      )}
      {chosen && chosen.length > SHOWN && (
        <li>
          <button
            type="button"
            onClick={onEdit}
            className="text-ink-muted hover:text-ink hover:underline"
          >
            {chosen.length - SHOWN} more
          </button>
        </li>
      )}
    </Kind>
  )
}

const TITLES: Record<
  ProjectContextKind,
  { title: string; description: string }
> = {
  documents: {
    title: 'Project documents',
    description:
      'Every session in this project reads these, within its context budget. Choose from the Library or upload a file.',
  },
  repositories: {
    title: 'Project repositories',
    description:
      'Sessions here are told which repositories the project works in. Only repositories Theorem tracks can be chosen.',
  },
  links: {
    title: 'Project links',
    description:
      'Sessions here are given these addresses with the project’s instructions.',
  },
  connections: {
    title: 'Project connections',
    description:
      'What sessions here may use when a message does not choose for itself. Theorem’s own tools are always available.',
  },
}

/** The editor for one kind of a project's context. */
export function ProjectContextDialog({
  projectId,
  kind,
  context,
  onClose,
}: {
  projectId: string
  kind: ProjectContextKind | undefined
  context: ProjectContext
  onClose: () => void
}) {
  return (
    <Dialog
      open={kind !== undefined}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="sm:max-w-lg">
        {/* Mounted with each opening, so it starts from the context as it stands now. */}
        {kind && (
          <Editor
            projectId={projectId}
            kind={kind}
            context={context}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Editor({
  projectId,
  kind,
  context,
  onDone,
}: {
  projectId: string
  kind: ProjectContextKind
  context: ProjectContext
  onDone: () => void
}) {
  const save = useEditProjectContext(projectId)
  const { title, description } = TITLES[kind]
  // The context as it stood at opening. Each editor saves what the person
  // changed from it, so an entry someone else adds while it is open (a session,
  // another window) is not taken for one the person removed.
  const [opened] = useState(context)
  const props = { projectId, context: opened, save, onDone }
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="font-heading text-lg font-semibold">
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {kind === 'documents' && <DocumentsEditor {...props} />}
      {kind === 'repositories' && <RepositoriesEditor {...props} />}
      {kind === 'links' && <LinksEditor {...props} />}
      {kind === 'connections' && <ConnectionsEditor {...props} />}
    </div>
  )
}

type EditorProps = {
  projectId: string
  /** The context as it stood when the editor opened. */
  context: ProjectContext
  save: ReturnType<typeof useEditProjectContext>
  onDone: () => void
}

/** Save, with Theorem's refusal said in place and the bound checked first. */
function Footer({
  save,
  problem,
  disabled,
}: {
  save: EditorProps['save']
  problem?: string
  disabled?: boolean
}) {
  const message =
    problem ?? (save.error ? describeError(save.error) : undefined)
  return (
    <>
      {message && (
        <p role="alert" className="text-sm text-error-ink">
          {message}
        </p>
      )}
      <DialogFooter>
        <Button
          type="submit"
          disabled={disabled || !!problem || save.isPending}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

function Choice({
  checked,
  disabled,
  onChange,
  children,
  note,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  children: ReactNode
  note?: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex min-h-8 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-hover',
        disabled && 'cursor-not-allowed opacity-64 hover:bg-transparent',
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(on) => onChange(on === true)}
      />
      <span className="min-w-0 flex-1 truncate text-ink">{children}</span>
      {note && <span className="shrink-0 text-xs text-ink-muted">{note}</span>}
    </label>
  )
}

const ListBox = ({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) => (
  <div
    role="group"
    aria-label={label}
    className="-mx-2 flex max-h-72 flex-col overflow-y-auto"
  >
    {children}
  </div>
)

const referenceKey = ({ kind, id }: ContextReference) => `${kind}:${id}`

function DocumentsEditor({ projectId, context, save, onDone }: EditorProps) {
  const library = useLibrary(projectId, true)
  const [chosen, setChosen] = useState<ContextDocument[]>(context.documents)
  const [query, setQuery] = useState('')
  // Files put in the project from here: ticked, and listed first until saved.
  const [uploaded, setUploaded] = useState<ContextDocument[]>([])
  const [uploading, setUploading] = useState<string>()
  const [uploadProblem, setUploadProblem] = useState<string>()
  const picker = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const isChosen = (reference: ContextReference) =>
    chosen.some((d) => sameReference(d.reference, reference))
  const toggle = (document: ContextDocument, on: boolean) =>
    setChosen((now) =>
      on
        ? [...now, document]
        : now.filter((d) => !sameReference(d.reference, document.reference)),
    )

  const upload = async (files: readonly File[]) => {
    // A save under way has already taken the list it writes, and closes the editor when it lands: a file sent now would reach the Library and miss the project.
    if (save.isPending) return
    setUploadProblem(undefined)
    for (const file of files) {
      if (file.size > DOCUMENT_MAX_BYTES) {
        setUploadProblem(`${file.name} is larger than 16 MB.`)
        continue
      }
      setUploading(file.name)
      try {
        const document = await uploadProjectDocument(projectId, file)
        setUploaded((now) => [...now, document])
        setChosen((now) =>
          now.some((d) => sameReference(d.reference, document.reference))
            ? now
            : [...now, document],
        )
      } catch (cause) {
        setUploadProblem(`${file.name}: ${describeError(cause)}`)
      }
    }
    setUploading(undefined)
    void queryClient.invalidateQueries({
      queryKey: libraryQuery(projectId).queryKey,
    })
  }

  const listed = useMemo(() => {
    const items = library.data ?? []
    const needle = query.trim().toLowerCase()
    const matches = (title: string) =>
      !needle || title.toLowerCase().includes(needle)
    // What the project named when the editor opened comes first, then what was uploaded here, so both are in view; the order holds while boxes are ticked.
    const first = [...context.documents, ...uploaded]
    return {
      // What the project names but the Library does not list stays visible, so it can be taken out. A file just uploaded is one until the Library is read again.
      missing: first.filter(
        (d) =>
          matches(d.title) &&
          !items.some((item) => sameReference(item.reference, d.reference)),
      ),
      items: [
        ...first.flatMap((d) =>
          items.filter((item) => sameReference(item.reference, d.reference)),
        ),
        ...items.filter(
          (item) =>
            !first.some((d) => sameReference(item.reference, d.reference)),
        ),
      ].filter((item) => matches(item.title)),
    }
  }, [library.data, query, context.documents, uploaded])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const added = chosen.filter(
      (d) =>
        !context.documents.some((c) => sameReference(c.reference, d.reference)),
    )
    const removed = context.documents.filter((c) => !isChosen(c.reference))
    if (!added.length && !removed.length) return onDone()
    save.mutate(
      (current) => ({
        ...current,
        documents: [
          ...current.documents.filter(
            (d) =>
              !removed.some((r) => sameReference(r.reference, d.reference)),
          ),
          ...added.filter(
            (a) =>
              !current.documents.some((d) =>
                sameReference(d.reference, a.reference),
              ),
          ),
        ],
      }),
      { onSuccess: onDone },
    )
  }

  const over = chosen.length > CONTEXT_LIMITS.documents
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Search the Library"
          placeholder="Search the Library"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept={DOCUMENT_ACCEPT}
          aria-label="Upload files"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void upload(files)
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={uploading !== undefined || save.isPending}
          onClick={() => picker.current?.click()}
        >
          <Upload aria-hidden data-icon="inline-start" />
          Upload
        </Button>
      </div>
      {uploading !== undefined && (
        <p role="status" className="truncate text-sm text-ink-muted">
          Uploading {uploading}…
        </p>
      )}
      {uploadProblem && (
        <p role="alert" className="text-sm text-error-ink">
          {uploadProblem}
        </p>
      )}
      {library.isPending ? (
        <p className="text-sm text-ink-muted">Reading the Library…</p>
      ) : library.isError ? (
        <p className="text-sm text-ink-muted">
          The Library could not be read. {describeError(library.error)}
        </p>
      ) : (
        <ListBox label="Library">
          {listed.missing.map((document) => (
            <Choice
              key={referenceKey(document.reference)}
              checked={isChosen(document.reference)}
              onChange={(on) => toggle(document, on)}
              note={
                uploaded.some((d) =>
                  sameReference(d.reference, document.reference),
                )
                  ? 'File'
                  : 'Not in the Library'
              }
            >
              {document.title}
            </Choice>
          ))}
          {listed.items.map((item) => (
            <LibraryChoice
              key={referenceKey(item.reference)}
              item={item}
              checked={isChosen(item.reference)}
              onChange={(on) =>
                toggle(
                  {
                    reference: item.reference,
                    title: documentTitle(item.title),
                  },
                  on,
                )
              }
            />
          ))}
          {!listed.missing.length && !listed.items.length && (
            <p className="px-2 text-sm text-ink-muted">
              {query.trim()
                ? 'Nothing in the Library matches.'
                : 'The Library is empty. Upload a file to add one.'}
            </p>
          )}
        </ListBox>
      )}
      <Footer
        save={save}
        disabled={uploading !== undefined}
        problem={
          over
            ? `A project can name at most ${CONTEXT_LIMITS.documents} documents.`
            : undefined
        }
      />
    </form>
  )
}

function LibraryChoice({
  item,
  checked,
  onChange,
}: {
  item: LibraryItem
  checked: boolean
  onChange: (on: boolean) => void
}) {
  // An unusable source already chosen can still be taken out; it cannot be added.
  return (
    <Choice
      checked={checked}
      disabled={!item.usable && !checked}
      onChange={onChange}
      note={item.usable ? (SOURCE_KIND[item.kind] ?? 'Source') : 'Not readable'}
    >
      {item.title || 'Untitled'}
    </Choice>
  )
}

function RepositoriesEditor({ context, save, onDone }: EditorProps) {
  const connections = useConnections()
  const githubEntry = connections.data?.connections.find(
    (c) => c.kind === 'github',
  )
  const connected = githubEntry?.status === 'connected'
  const github = useGithub(connected)
  const [chosen, setChosen] = useState(() =>
    context.repositories.map((r) => r.fullName),
  )
  const tracked = useMemo(() => {
    const named = new Set(
      context.repositories.map((r) => r.fullName.toLowerCase()),
    )
    const first = (name: string) => (named.has(name.toLowerCase()) ? 0 : 1)
    // What the project names comes first, so it is in view, then the rest by name.
    return [
      ...new Set(
        (github.data?.installations ?? []).flatMap((installation) =>
          installation.repos.filter((r) => r.tracked).map((r) => r.fullName),
        ),
      ),
    ].sort((a, b) => first(a) - first(b) || a.localeCompare(b))
  }, [github.data, context.repositories])
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const isChosen = (name: string) => chosen.some((c) => same(c, name))
  const untracked = chosen.filter((name) => !tracked.some((t) => same(t, name)))
  const toggle = (name: string, on: boolean) =>
    setChosen((now) =>
      on ? [...now, name] : now.filter((c) => !same(c, name)),
    )

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const before = context.repositories.map((r) => r.fullName)
    const added = chosen.filter((name) => !before.some((b) => same(b, name)))
    const removed = before.filter((name) => !isChosen(name))
    if (!added.length && !removed.length) return onDone()
    save.mutate(
      (current) => {
        const kept = current.repositories.filter(
          (r) => !removed.some((name) => same(name, r.fullName)),
        )
        return {
          ...current,
          repositories: [
            ...kept,
            ...added
              .filter((name) => !kept.some((r) => same(r.fullName, name)))
              .map((fullName) => ({ fullName })),
          ],
        }
      },
      { onSuccess: onDone },
    )
  }

  const reading = connections.isPending || (connected && github.isPending)
  const failed = connections.isError || github.isError
  // Until the tracked list is on screen nothing is known to be untracked.
  const listed = !reading && !failed
  const over = chosen.length > CONTEXT_LIMITS.repositories
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
      {reading ? (
        <p className="text-sm text-ink-muted">Reading the GitHub connection…</p>
      ) : failed ? (
        <p className="text-sm text-ink-muted">
          The GitHub connection could not be read.{' '}
          {describeError(connections.error ?? github.error)}
        </p>
      ) : (
        <ListBox label="Tracked repositories">
          {untracked.map((name) => (
            <Choice
              key={name}
              checked
              onChange={(on) => toggle(name, on)}
              note="No longer tracked"
            >
              {name}
            </Choice>
          ))}
          {tracked.map((name) => (
            <Choice
              key={name}
              checked={isChosen(name)}
              onChange={(on) => toggle(name, on)}
            >
              {name}
            </Choice>
          ))}
          {!tracked.length && (
            <p className="px-2 text-sm text-ink-muted">
              {connected
                ? 'Theorem tracks no repositories yet.'
                : 'GitHub is not connected.'}{' '}
              <Link to="/settings/connections" className="text-ink underline">
                Choose them in Settings → Connections
              </Link>
              .
            </p>
          )}
        </ListBox>
      )}
      <Footer
        save={save}
        disabled={!listed}
        problem={
          over
            ? `A project can name at most ${CONTEXT_LIMITS.repositories} repositories.`
            : undefined
        }
      />
    </form>
  )
}

function LinksEditor({ context, save, onDone }: EditorProps) {
  const [links, setLinks] = useState<ContextLink[]>(context.links)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()

  const add = () => {
    const wrong =
      linkProblem(url, name) ??
      (links.some((l) => l.url === url.trim())
        ? 'That address is already kept.'
        : undefined)
    setProblem(wrong)
    if (wrong) return
    setLinks((now) => [...now, keptLink(url, name)])
    setUrl('')
    setName('')
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // An address typed but not added yet is what the person meant to keep.
    let next = links
    if (url.trim()) {
      const wrong =
        linkProblem(url, name) ??
        (links.some((l) => l.url === url.trim())
          ? 'That address is already kept.'
          : undefined)
      setProblem(wrong)
      if (wrong) return
      next = [...links, keptLink(url, name)]
    }
    const added = next.filter(
      (l) => !context.links.some((c) => c.url === l.url),
    )
    const removed = context.links.filter(
      (c) => !next.some((l) => l.url === c.url),
    )
    // A link kept at the same address under a different title is an edit too.
    const retitled = next.filter((l) =>
      context.links.some((c) => c.url === l.url && c.title !== l.title),
    )
    if (!added.length && !removed.length && !retitled.length) return onDone()
    save.mutate(
      (current) => {
        const kept = current.links
          .filter((l) => !removed.some((r) => r.url === l.url))
          .map((l) => {
            const edit = retitled.find((r) => r.url === l.url)
            return edit ? keptLink(edit.url, edit.title ?? '') : l
          })
        return {
          ...current,
          links: [
            ...kept,
            ...added.filter((a) => !kept.some((l) => l.url === a.url)),
          ],
        }
      },
      { onSuccess: onDone },
    )
  }

  const over = links.length > CONTEXT_LIMITS.links
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
      {links.length > 0 && (
        <ul
          aria-label="Kept links"
          className="-mx-2 flex max-h-56 flex-col overflow-y-auto"
        >
          {links.map((link) => (
            <li
              key={link.url}
              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-hover"
            >
              <Link2
                aria-hidden
                strokeWidth={1.75}
                className="size-4 shrink-0 text-ink-muted"
              />
              <span
                className="min-w-0 flex-1 truncate text-ink"
                title={link.url}
              >
                {linkLabel(link)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${linkLabel(link)}`}
                onClick={() =>
                  setLinks((now) => now.filter((l) => l.url !== link.url))
                }
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1.5 text-sm">
          Address
          <Input
            inputMode="url"
            placeholder="https://"
            value={url}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setUrl(event.target.value)
              setProblem(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && url.trim()) {
                event.preventDefault()
                add()
              }
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Title (optional)
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!url.trim()}
            onClick={add}
          >
            Add link
          </Button>
        </div>
      </div>
      <Footer
        save={save}
        problem={
          problem ??
          (over
            ? `A project can keep at most ${CONTEXT_LIMITS.links} links.`
            : undefined)
        }
      />
    </form>
  )
}

/**
 * The project's connections after the person's edit, applied to the list as
 * Theorem holds it now. Between two lists only what the person turned on or off
 * changes, so a connection someone else chose meanwhile stays. Choosing every
 * connection, or choosing a list where every connection was on, is the whole
 * answer.
 */
export function connectionsAfter(
  before: readonly string[] | null,
  next: readonly string[] | null,
  current: readonly string[] | null,
): string[] | null {
  if (next === null) return null
  if (before === null || current === null) return [...next]
  const removed = before.filter((id) => !next.includes(id))
  const kept = current.filter((id) => !removed.includes(id))
  return [
    ...kept,
    ...next.filter((id) => !before.includes(id) && !kept.includes(id)),
  ]
}

function ConnectionsEditor({ context, save, onDone }: EditorProps) {
  const connections = useConnections()
  const [mode, setMode] = useState<'all' | 'chosen'>(
    context.connections === null ? 'all' : 'chosen',
  )
  const [chosen, setChosen] = useState<string[]>(context.connections ?? [])
  const roster: Connection[] = connections.data?.connections ?? []
  // Until the list arrives nothing is known to be removed.
  const gone = connections.data
    ? chosen.filter((id) => !roster.some((c) => c.id === id))
    : []
  const toggle = (id: string, on: boolean) =>
    setChosen((now) => (on ? [...now, id] : now.filter((c) => c !== id)))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = mode === 'all' ? null : chosen
    const before = context.connections
    const same =
      next === null || before === null
        ? next === before
        : next.length === before.length &&
          next.every((id) => before.includes(id))
    if (same) return onDone()
    save.mutate(
      (current) => ({
        ...current,
        connections: connectionsAfter(before, next, current.connections),
      }),
      { onSuccess: onDone },
    )
  }

  const over = mode === 'chosen' && chosen.length > CONTEXT_LIMITS.connections
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
      <RadioGroup
        value={mode}
        onValueChange={(value) => setMode(value)}
        aria-label="Which connections"
        className="flex flex-col gap-1.5"
      >
        {(
          [
            ['all', 'Every enabled connection'],
            ['chosen', 'Only the ones chosen here'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <Radio.Root
              value={value}
              className="flex size-4 items-center justify-center rounded-full border border-control outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus data-checked:border-redwood"
            >
              <Radio.Indicator className="size-2 rounded-full bg-redwood" />
            </Radio.Root>
            {label}
          </label>
        ))}
      </RadioGroup>
      {mode === 'chosen' &&
        (connections.isPending ? (
          <p className="text-sm text-ink-muted">Reading your connections…</p>
        ) : connections.isError ? (
          <p className="text-sm text-ink-muted">
            Your connections could not be read.{' '}
            {describeError(connections.error)}
          </p>
        ) : (
          <ListBox label="Connections">
            {gone.map((id) => (
              <Choice
                key={id}
                checked
                onChange={(on) => toggle(id, on)}
                note="Removed"
              >
                {id}
              </Choice>
            ))}
            {roster.map((connection) => (
              <Choice
                key={connection.id}
                checked={chosen.includes(connection.id)}
                onChange={(on) => toggle(connection.id, on)}
                note={
                  !connection.enabled ? (
                    'Off in Settings'
                  ) : connection.status === 'connected' &&
                    (connection.health.state === 'ok' ||
                      connection.health.state === 'unknown') ? undefined : (
                    <StatusBadge
                      status={connection.status}
                      health={connection.health}
                    />
                  )
                }
              >
                {connection.label}
              </Choice>
            ))}
            {!roster.length && !gone.length && (
              <p className="px-2 text-sm text-ink-muted">
                Nothing is connected.{' '}
                <Link to="/settings/connections" className="text-ink underline">
                  Connect something in Settings → Connections
                </Link>
                .
              </p>
            )}
          </ListBox>
        ))}
      <Footer
        save={save}
        disabled={mode === 'chosen' && !connections.data}
        problem={
          over
            ? `A project can name at most ${CONTEXT_LIMITS.connections} connections.`
            : undefined
        }
      />
    </form>
  )
}
