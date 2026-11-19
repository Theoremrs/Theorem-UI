// SOURCING: the durable skill_load part shared by explicit selections and skill_get.
import { z } from 'zod'
import type { DataMessagePartComponent } from '@assistant-ui/react'
import { Icon } from '@/components/icons'

const receiptSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  source: z.enum(['skill_pack', 'skill_document', 'mcp']).optional(),
  loaded: z.boolean(),
  reason: z.string().optional(),
  selection: z.enum(['explicit', 'model']),
  contentHash: z.string().optional(),
  instructionBytes: z.number().nonnegative().optional(),
})
export const readSkillLoad = (data: unknown) =>
  receiptSchema.safeParse(data).data
const SOURCE = {
  skill_pack: 'Skill pack',
  skill_document: 'Skill document',
  mcp: 'MCP server',
}

export const SkillLoadPart: DataMessagePartComponent = ({ data }) => {
  const receipt = readSkillLoad(data)
  if (!receipt)
    return (
      <p className="text-xs text-ink-muted">
        Theorem could not display this skill receipt.
      </p>
    )
  return (
    <details className="my-1 rounded-lg border border-separator px-3 py-2 text-xs text-ink-muted">
      <summary className="flex cursor-pointer items-center gap-2">
        <Icon.Skill className="size-3.5 shrink-0" />
        <span
          className={receipt.loaded ? 'text-ink' : 'text-warning-foreground'}
        >
          {receipt.loaded ? 'Loaded' : 'Could not load'}{' '}
          {receipt.name ?? receipt.id}
        </span>
        <span className="ms-auto shrink-0">
          {receipt.selection === 'explicit' ? 'You selected' : 'Theo selected'}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        {receipt.reason && <p>{receipt.reason}</p>}
        <p className="wrap-anywhere">
          {receipt.source ? SOURCE[receipt.source] + ' · ' : ''}
          {receipt.id}
        </p>
        {receipt.instructionBytes !== undefined && (
          <p>
            {receipt.instructionBytes.toLocaleString()} bytes of instructions
          </p>
        )}
        {receipt.contentHash && (
          <p className="break-all font-mono" title="Content hash">
            {receipt.contentHash}
          </p>
        )}
      </div>
    </details>
  )
}
