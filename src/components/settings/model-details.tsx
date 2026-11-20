// SOURCING: coss ui sheet over Base UI Dialog (the right-side record panel Twenty shows beside its table, without any CRM record-editing behavior); hooks/use-copy-to-clipboard for the canonical ID; lib/theorem/models for the model shape, resolvedModel and the format helpers
import * as React from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from '@/components/coss/sheet'
import { Badge } from '@/components/coss/badge'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { formatContext, formatPrice, resolvedModel } from '@/lib/theorem/models'
import type { ModelOption } from '@/lib/theorem/models'

const SOURCE_LABELS: Record<ModelOption['source'], string> = {
  catalog: 'Configured catalog',
  openrouter: 'OpenRouter',
}

const MODALITY_LABELS: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  file: 'File',
  audio: 'Audio',
  video: 'Video',
}
const modalityLabel = (value: string) =>
  MODALITY_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1)

const tokens = new Intl.NumberFormat('en-US')

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  )
}

/**
 * One model's complete identity beside the catalog: the full name, canonical
 * ID with a copy action, maker and routing provider, limits, prices with
 * their units, modalities, capabilities and description. Inspecting never
 * picks the model; Escape and the close button return focus to the trigger.
 */
export function ModelDetails({
  model,
  starred,
  inUse,
  onClose,
  returnFocusTo,
}: {
  model: ModelOption | undefined
  /** Whether the model is in the composer's picker. */
  starred: boolean
  /** Whether a turn runs on this model now. */
  inUse: boolean
  onClose: () => void
  /** The control that opened the panel; focus returns to it on close. */
  returnFocusTo: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const route = model ? resolvedModel(model.ref) : undefined
  const price = model ? formatPrice(model) : undefined
  return (
    <Sheet
      open={model !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        side="right"
        className="sm:max-w-md"
        finalFocus={returnFocusTo}
        data-model-details={model ? '' : undefined}
      >
        {model && (
          <>
            <SheetHeader className="pe-12">
              <SheetTitle className="text-lg leading-snug">
                {model.name}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-1.5">
                {inUse && (
                  <Badge
                    size="sm"
                    className="border-transparent bg-redwood-container text-redwood-ink"
                  >
                    In use
                  </Badge>
                )}
                {starred && (
                  <Badge size="sm" variant="outline" className="text-ink-muted">
                    <Icon.Star
                      className="size-3 fill-current"
                      aria-hidden="true"
                    />
                    In the picker
                  </Badge>
                )}
              </SheetDescription>
            </SheetHeader>
            <SheetPanel>
              <dl className="flex flex-col gap-4">
                <Field label="Canonical ID">
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 break-all font-mono text-xs">
                      {model.ref}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      aria-label="Copy canonical ID"
                      onClick={() => void copyToClipboard(model.ref)}
                    >
                      {isCopied ? (
                        <Icon.Copied className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Icon.Copy className="size-3.5" aria-hidden="true" />
                      )}
                      {isCopied ? 'Copied' : 'Copy'}
                    </Button>
                  </span>
                </Field>
                <Field label="Vendor">{model.vendor}</Field>
                <Field label="Routing provider">{route?.provider}</Field>
                <Field label="Source">{SOURCE_LABELS[model.source]}</Field>
                <Field label="Context window">
                  {model.contextLength === undefined
                    ? 'Unknown'
                    : `${formatContext(model.contextLength)} tokens (${tokens.format(model.contextLength)})`}
                </Field>
                <Field label="Max output">
                  {model.maxOutput === undefined
                    ? 'Unknown'
                    : `${tokens.format(model.maxOutput)} tokens`}
                </Field>
                <Field label="Price per million tokens">
                  {price ?? 'Unknown'}
                </Field>
                <Field label="Inputs">
                  {model.inputs.length
                    ? model.inputs.map(modalityLabel).join(', ')
                    : 'None listed'}
                </Field>
                <Field label="Native tools">{model.tools ? 'Yes' : 'No'}</Field>
                <Field label="Reasoning">
                  {model.reasoning ? 'Yes' : 'No'}
                  {model.reasoning && model.effortLevels.length > 0 && (
                    <span className="text-ink-muted">
                      {' '}
                      ({model.effortLevels.join(', ')}
                      {model.effortDefault
                        ? `; default ${model.effortDefault}`
                        : ''}
                      )
                    </span>
                  )}
                </Field>
                {model.addedAtMs !== undefined && (
                  <Field label="Added">
                    {new Intl.DateTimeFormat('en-US', {
                      dateStyle: 'long',
                    }).format(new Date(model.addedAtMs))}
                  </Field>
                )}
                {model.expiresOn && (
                  <Field label="Retires">{model.expiresOn}</Field>
                )}
                {model.description && (
                  <Field label="Description">
                    <span className="whitespace-pre-line text-ink-muted">
                      {model.description}
                    </span>
                  </Field>
                )}
              </dl>
            </SheetPanel>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
