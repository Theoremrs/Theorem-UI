// SOURCING: lib/resources preview and open through ./use-resource; the contribution registry's `preview` kind (resolveHandler) so a context-specific renderer can enrich a kind's preview, with the Records field renderer (components/records/fields FieldDisplay) as the shipped one for records (DATA-01); the app's Button.
import type { ComponentType } from 'react'
import { createElement, useState } from 'react'
import { Button } from '@/components/ui/button'
import { commandById, executeCommand } from '@/lib/commands/registry'
import { resolveHandler } from '@/lib/contributions/registry'
import type { PreviewData } from '@/lib/resources/provider'
import { STATE_DETAIL, STATE_LABEL } from '@/lib/resources/state'
import { serveKeys } from '@/lib/resources/types'
import type { ResourceRef } from '@/lib/resources/types'
import { openResource } from './open-resource'
import { usePreview } from './use-resource'

export type PreviewRendererProps = {
  resourceRef: ResourceRef
  preview: PreviewData
}

/** The renderer a `preview` contribution supplies for this kind, narrowest key first. */
function rendererFor(
  ref: ResourceRef,
): ComponentType<PreviewRendererProps> | undefined {
  for (const serves of serveKeys(ref.resource)) {
    const found = resolveHandler('preview', serves, { resourceKey: undefined })
    if (found.handler?.Component) return found.handler.Component
  }
  return undefined
}

/** Title, type, excerpt and fields: what every kind shows when nothing richer is registered. */
export function DefaultPreviewBody({ preview }: { preview: PreviewData }) {
  return (
    <div className="flex flex-col gap-1.5">
      {preview.excerpt && (
        <p className="line-clamp-6 whitespace-pre-wrap text-sm text-ink-muted">
          {preview.excerpt}
        </p>
      )}
      {preview.fields && preview.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {preview.fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="text-ink-muted">{field.label}</dt>
              <dd className="min-w-0 truncate text-ink">
                {String(field.value ?? '')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * The compact preview of a resource with an explicit Open button. Nothing is
 * read until `enabled`. A resource that is not ready says so in plain words
 * and shows nothing it remembered.
 */
/** Work's command, reached by id so this layer does not depend on Work. */
const MAKE_WORK = 'theorem.work.create-from'

export function ResourcePreview({
  resourceRef,
  enabled = true,
}: {
  resourceRef: ResourceRef
  enabled?: boolean
}) {
  const view = usePreview(resourceRef, enabled)
  const [refusal, setRefusal] = useState<string>()
  if (view.status === 'loading')
    return (
      <p role="status" className="text-sm text-ink-muted">
        Loading preview…
      </p>
    )
  if (view.status !== 'ready')
    return (
      <div role="status" className="flex flex-col gap-1 text-sm">
        <strong>{STATE_LABEL[view.status]}</strong>
        <span className="text-ink-muted">{STATE_DETAIL[view.status]}</span>
        {view.tombstone?.kindLabel && (
          <span className="text-xs text-ink-muted">
            {view.tombstone.kindLabel}
          </span>
        )}
      </div>
    )
  const renderer = rendererFor(resourceRef)
  const { preview } = view
  return (
    <section
      className="flex w-72 max-w-full flex-col gap-2"
      aria-label={`Preview of ${preview.title}`}
    >
      <header className="flex flex-col">
        <span className="text-xs text-ink-muted">{preview.typeLabel}</span>
        <h3 className="text-sm font-medium text-ink">{preview.title}</h3>
      </header>
      {renderer ? (
        createElement(renderer, { resourceRef, preview })
      ) : (
        <DefaultPreviewBody preview={preview} />
      )}
      {refusal && (
        <p role="alert" className="text-xs text-ink-muted">
          {refusal}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void openResource(resourceRef).then(setRefusal)}
        >
          Open
        </Button>
        {resourceRef.resource.kind !== 'work-item' &&
          commandById(MAKE_WORK) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void executeCommand(
                  MAKE_WORK,
                  { ref: resourceRef },
                  { focus: 'none', path: window.location.pathname },
                  'menu',
                ).then((result) => {
                  if (!result.ok) setRefusal(result.message)
                })
              }
            >
              Make work item
            </Button>
          )}
      </div>
    </section>
  )
}
