// SOURCING: coss Select over Base UI, the existing native response-style library.
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/coss/select'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { useOutputStyles } from '@/lib/theorem/output-styles'

export function OutputStyleSelect({ threadId }: { threadId?: string }) {
  const { data, error, isPending, refetch, save } = useOutputStyles(threadId)
  if (error)
    return (
      <div role="alert" className="text-sm text-ink-muted">
        Output styles could not be loaded.
        <Button size="sm" variant="ghost" onClick={() => void refetch()}>
          Retry styles
        </Button>
      </div>
    )
  if (isPending)
    return <p className="text-sm text-ink-muted">Loading output styles…</p>
  const selected = threadId
    ? data.selection.conversation
    : data.selection.account
  const items = [
    { value: '', label: threadId ? 'Use my default' : 'Theorem default' },
    ...data.styles.map((style) => ({ value: style.id, label: style.name })),
  ]
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Select
        items={items}
        value={selected ?? ''}
        disabled={save.isPending}
        onValueChange={(value) => {
          if (typeof value === 'string') save.mutate(value || null)
        }}
      >
        <SelectTrigger
          aria-label={
            threadId ? 'Conversation output style' : 'Default output style'
          }
          className="w-full min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="text-xs text-ink-muted">
        {
          data.styles.find(
            (style) =>
              style.id === (selected ?? data.selection.effective.style),
          )?.description
        }
      </p>
      {save.error && (
        <p role="alert" className="text-sm text-ink-muted">
          The output style was not saved. {describeError(save.error)}
        </p>
      )}
    </div>
  )
}
