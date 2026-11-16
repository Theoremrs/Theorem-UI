// SOURCING: shared Base UI Dialog, generation controls and the native style selector.
import { useAuiState } from '@assistant-ui/react'
import {
  CountControl,
  DetailControl,
} from '@/components/chat/generation-fields'
import { LimitsPanel } from '@/components/chat/run-footer'
import { OutputStyleSelect } from '@/components/settings/output-style-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useGenerationDefaults } from '@/lib/theorem/generation'
import { firstRenderedAt } from '@/lib/theorem/run-parts'
import {
  useConversationGeneration,
  useLatestRunFacts,
} from '@/lib/theorem/use-generation'

const Field = ({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs font-medium text-ink-muted">{label}</span>
    {children}
  </div>
)

/** Conversation overrides are available through /output-settings, outside the toolbar. */
export function OutputSettingsDialog({
  open,
  onOpenChange,
  stylesOnly = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stylesOnly?: boolean
}) {
  const threadId = useAuiState((state) => state.threadListItem.remoteId)
  const { override, change, reset } = useConversationGeneration()
  const defaults = useGenerationDefaults((s) => s.defaults)
  const facts = useLatestRunFacts()
  const active = Object.keys(override).length > 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogTitle>
          {stylesOnly ? 'Output style' : 'Output settings'}
        </DialogTitle>
        <DialogDescription>
          {stylesOnly
            ? threadId
              ? 'Choose the style for this conversation.'
              : 'Choose your account default output style.'
            : 'These settings override your account defaults for this conversation.'}
        </DialogDescription>
        {stylesOnly ? (
          <OutputStyleSelect threadId={threadId} />
        ) : (
          <div
            data-slot="response-control"
            className="flex w-full max-w-full flex-col gap-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">This conversation</h3>
              {active && (
                <Button variant="ghost" size="xs" onClick={reset}>
                  Reset
                </Button>
              )}
            </div>
            <Field label="Response detail">
              <DetailControl
                value={override.responseDetail}
                onChange={(responseDetail) => change({ responseDetail })}
              />
            </Field>
            <Field label="Maximum output per call">
              <CountControl
                label="Maximum output per call"
                value={override.maxOutputTokens}
                placeholder={
                  defaults.maxOutputTokens
                    ? `${defaults.maxOutputTokens} (your default)`
                    : "Model's maximum"
                }
                onChange={(maxOutputTokens) => change({ maxOutputTokens })}
              />
            </Field>
            <Field label="Run budget: output tokens">
              <CountControl
                label="Run budget output tokens"
                value={override.runBudget?.maxOutputTokens}
                placeholder={
                  defaults.runBudget?.maxOutputTokens
                    ? `${defaults.runBudget.maxOutputTokens} (your default)`
                    : 'No cap'
                }
                onChange={(maxOutputTokens) =>
                  change({
                    runBudget: { ...override.runBudget, maxOutputTokens },
                  })
                }
              />
            </Field>
            <Field label="Run budget: steps">
              <CountControl
                label="Run budget steps"
                value={override.runBudget?.maxSteps}
                placeholder={
                  defaults.runBudget?.maxSteps
                    ? `${defaults.runBudget.maxSteps} (your default)`
                    : 'No cap'
                }
                onChange={(maxSteps) =>
                  change({ runBudget: { ...override.runBudget, maxSteps } })
                }
              />
            </Field>
            {facts?.limits && (
              <section className="flex flex-col gap-2 border-t border-separator pt-3">
                <h3 className="text-xs font-medium text-ink-muted">
                  Last reply ran under
                </h3>
                <LimitsPanel
                  limits={facts.limits}
                  timing={facts.timing}
                  firstRenderAtMs={firstRenderedAt(facts.runId)}
                />
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
