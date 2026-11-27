// SOURCING: the CRM's Chip (components/crm/twenty/chip, the catalog's record-presentation entry) for the chip body, the coss popover for the preview, the app's Button, and lib/resources for the owner's answer and for opening. REF-05: explicit open and preview controls that work from the keyboard and by touch; hover is not required.
import { Eye } from 'lucide-react'
import { useState } from 'react'
import { Chip } from '@/components/crm/twenty/chip'
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from '@/components/coss/popover'
import { STATE_LABEL } from '@/lib/resources/state'
import { baseKind } from '@/lib/resources/types'
import type { ResourceRef } from '@/lib/resources/types'
import { cn } from '@/lib/utils'
import { openResource } from './open-resource'
import { ResourcePreview } from './resource-preview'
import { useResolved } from './use-resource'
import type { ResolvedView } from './use-resource'

/** The name a chip shows for a kind when the owner has not named the resource. */
const kindName = (ref: ResourceRef) =>
  ref.resource.kind === 'extension'
    ? ref.resource.extensionKind
    : baseKind(ref.resource).replace(/-/g, ' ')

/**
 * What the chip says. While asking, the hint is shown but marked unverified;
 * once the owner answers anything but ready, the hint is gone: a resource
 * whose access was revoked is never shown under its old name.
 */
export function chipLabel(ref: ResourceRef, view: ResolvedView) {
  if (view.status === 'ready') return { text: view.meta.title, verified: true }
  if (view.status === 'loading')
    return {
      text: ref.hint?.label ?? `Loading ${kindName(ref)}`,
      verified: false,
    }
  return {
    text: `${STATE_LABEL[view.status]} ${kindName(ref)}`.replace(
      /^Available /,
      '',
    ),
    verified: true,
  }
}

export function ResourceChip({
  resourceRef,
  className,
  withPreview = true,
  onOpenFailed,
}: {
  resourceRef: ResourceRef
  className?: string
  /** Offers the explicit preview button beside the chip. */
  withPreview?: boolean
  /** Told why a resource did not open. */
  onOpenFailed?: (reason: string) => void
}) {
  const view = useResolved(resourceRef)
  const [previewing, setPreviewing] = useState(false)
  const label = chipLabel(resourceRef, view)
  const usable = view.status === 'ready' || view.status === 'loading'
  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-0.5', className)}
      data-resource-state={view.status}
      aria-busy={view.status === 'loading'}
    >
      <Chip
        variant="soft"
        onClick={() =>
          void openResource(resourceRef).then((reason) => {
            if (reason) onOpenFailed?.(reason)
          })
        }
        title={usable ? undefined : STATE_LABEL[view.status]}
        aria-label={`Open ${label.text}${label.verified ? '' : ' (not yet checked)'}`}
        color={usable ? 'primary' : 'secondary'}
      >
        {label.text}
      </Chip>
      {withPreview && (
        <Popover open={previewing} onOpenChange={setPreviewing}>
          <PopoverTrigger
            aria-label={`Preview ${label.text}`}
            className="inline-flex size-5 items-center justify-center rounded-sm text-ink-muted hover:bg-ink/4 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Eye className="size-3" aria-hidden />
          </PopoverTrigger>
          <PopoverPopup align="start">
            <ResourcePreview resourceRef={resourceRef} enabled={previewing} />
          </PopoverPopup>
        </Popover>
      )}
    </span>
  )
}
