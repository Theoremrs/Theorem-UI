// SOURCING: assistant-ui form, dropzone, dictation and action primitives;
// the same Milkdown editor, runtime commands and composer parts in each layout;
// the / tools list and the @ list of records and documents to cite.
import {
  AuiIf,
  ComposerPrimitive,
  useAui,
  useAuiEvent,
  useAuiState,
} from '@assistant-ui/react'
import type { AssistantState } from '@assistant-ui/react'
import { useRef } from 'react'
import type { ComponentType, FC } from 'react'
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from '@/components/assistant-ui/elements/attachment.aui'
import { ComposerVoice } from '@/components/assistant-ui/elements/composer-voice'
import { ComposerQuotePreview } from '@/components/assistant-ui/elements/quote.aui'
import { ComposerContextUsage } from '@/components/chat/context-usage'
import { ComposerEditor } from '@/components/chat/composer-editor'
import { ComposerMentionTrigger } from '@/components/chat/composer-mentions'
import {
  ComposerReferences,
  useComposerReferences,
} from '@/components/chat/composer-references'
import { ComposerPlus } from '@/components/chat/composer-plus'
import { ComposerToolTrigger } from '@/components/chat/composer-tools'
import { ModelPicker } from '@/components/chat/model-picker'
import {
  RunInputStatus,
  useBusyComposerInput,
  useRunInputSendDisabled,
} from '@/components/chat/run-input'
import { ToastProvider, toastManager } from '@/components/coss/toast'
import { useLiquidGlass } from '@/components/glass/liquid-glass/use-liquid-glass'
import { Icon } from '@/components/icons'
import { Magnet } from '@/components/motion'
import {
  ComposerReviewTarget,
  useComposerReview,
} from '@/components/review/review-target'
import type { ComposerReview } from '@/components/review/review-target'
import { Button } from '@/components/ui/button'
import { useAppearance } from '@/lib/appearance'
import { appearancePair } from '@/lib/appearance-policy'
import { attendKit } from '@/lib/kit/store'
import { kick, recordLaunch } from '@/lib/motion'
import { useComposerSurface } from '@/lib/surfaces'
import type { ComposerSurface } from '@/lib/surfaces'
import { cn } from '@/lib/utils'

const shouldShowComposerResume = (s: AssistantState) =>
  !!s.thread.canResume && s.composer.type === 'thread' && s.composer.isEmpty

/** A file the composer refuses never reaches its tray, so the refusal is said here. */
const AttachmentRefusals: FC = () => {
  useAuiEvent('composer.attachmentAddError', (event) => {
    toastManager.add({
      type: 'error',
      title:
        event.reason === 'not-accepted'
          ? 'Theorem does not take this kind of file'
          : 'That file could not be added',
      description:
        event.reason === 'not-accepted' ? event.contentType : event.message,
    })
  })
  return <ToastProvider position="top-center" />
}

export type ComposerLayout = 'conversation' | 'sidecar'

export type ComposerSlots = {
  tools?: ComponentType
  settings?: ComponentType
  actions?: ComponentType<{ review: ComposerReview | undefined }>
  context?: ComponentType<{ review: ComposerReview | undefined }>
}

export const Composer: FC<{
  autoFocus: boolean
  layout?: ComposerLayout | undefined
  slots?: ComposerSlots | undefined
}> = ({ autoFocus, layout, slots }) => {
  const aui = useAui()
  // While the mic listens the editor stays mounted (its draft, undo history,
  // and the .theorem-composer target the Skills menu writes to all survive)
  // but is hidden; the waveform takes the editor track instead.
  const dictating = useAuiState((s) => s.composer.dictation != null)
  // While the composer answers a review, sending submits the review and the
  // chat's own send is left out.
  const review = useComposerReview()
  const shellRef = useRef<HTMLDivElement>(null)
  const surface = useComposerSurface()
  const preferredLayout = useAppearance((state) => state.appearance.layout)
  const {
    tools: Tools = ComposerTools,
    settings: Settings = ComposerSettings,
    actions: Actions = ComposerPrimaryActions,
    context: Context = ComposerContext,
  } = slots ?? {}
  useLiquidGlass(shellRef, surface === 'liquid' || surface === 'glass')
  const busyInput = useBusyComposerInput({
    hasReferences: () => useComposerReferences.getState().references.length > 0,
    onError: (description) =>
      toastManager.add({
        type: 'error',
        title: 'Message kept in composer',
        description,
      }),
  })
  // Where the text was, for the new user message to fly up from. Recorded on
  // submit because the composer.send event arrives a microtask after the
  // message has already mounted.
  const recordLaunches = () => {
    const shell = shellRef.current
    if (!shell || !aui.composer.getState().canSend) return
    const input = shell.querySelector('.aui-composer-input') ?? shell
    recordLaunch(input.getBoundingClientRect())
    const footer = shell.closest('.aui-thread-viewport-footer')
    if (footer) recordLaunch(footer.getBoundingClientRect(), 'composer-dock')
  }
  // The composer gives a small kick once the send goes through.
  useAuiEvent('composer.send', (event) => {
    if (event.messageId === undefined && shellRef.current)
      kick(shellRef.current)
  })

  return (
    <ComposerPrimitive.TriggerPopoverRoot>
      <ComposerPrimitive.Root
        onSubmit={(event) => {
          // A review's answer goes to the review, also while a response runs.
          if (review) {
            event.preventDefault()
            if (review.canSend) review.send()
            return
          }
          if (!busyInput.onSubmit(event)) recordLaunches()
        }}
        onKeyDown={busyInput.onKeyDown}
        className="aui-composer-root relative flex w-full min-w-0 flex-col"
        data-composer-layout={layout ?? preferredLayout}
        data-appearance-role="composer-form"
      >
        <ComposerToolTrigger />
        {/* A quote carried in from a reply sits above the draft until sent. */}
        <ComposerQuotePreview />
        <ComposerMentionTrigger />
        {/* The composer lifts off the sheet as the sheet lifts off the rail.
            Glass casts its own shadow, and the glow would show through it. */}
        {surface === 'paper' && (
          <div
            aria-hidden="true"
            className="lift-glow [--glow-radius:var(--composer-radius)]"
          />
        )}
        <AttachmentRefusals />
        <ComposerPrimitive.AttachmentDropzone
          render={
            <div
              ref={shellRef}
              data-slot="aui_composer-shell"
              data-appearance-part="composer"
              data-appearance-radius-role="composer"
              data-surface-role="composer"
              data-material={surface}
              data-appearance-spacing-role="composer-padding"
              data-kit-perch="composer"
              data-face-perch="composer"
              className={cn(
                composerSurface(surface === 'glass' ? 'liquid' : surface),
                'appearance-surface appearance-composer-box data-[dragging=true]:border-focus w-full cursor-text rounded-(--composer-radius) border transition-[border-color] duration-100 data-[dragging=true]:border-dashed',
              )}
            />
          }
        >
          <div className="appearance-composer-context appearance-reading-plane">
            <Context review={review} />
          </div>
          <div
            className="appearance-composer-editor appearance-reading-plane"
            data-appearance-part="editor-track"
          >
            <ComposerEditor
              label="Message input"
              placeholder="Write a message…"
              className={cn('aui-composer-input w-full', dictating && 'hidden')}
              autoFocus={autoFocus}
              onFocus={() => attendKit(true)}
              onBlur={() => attendKit(false)}
            />
            {/* While the mic listens the editor track becomes the waveform;
                the transcript lands back in the editor when it commits. */}
            <ComposerVoice />
          </div>
          <div
            className="appearance-composer-toolbar aui-composer-action-wrapper"
            data-appearance-part="composer-actions"
            data-appearance-spacing-role="related-controls"
          >
            <div className="appearance-composer-tools appearance-reading-plane">
              <Tools />
            </div>
            <div className="appearance-composer-settings appearance-reading-plane">
              <Settings />
            </div>
            <div className="appearance-composer-actions appearance-reading-plane">
              <ComposerContextUsage />
              <Actions review={review} />
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.TriggerPopoverRoot>
  )
}

/**
 * The composer's material (Settings, Appearance): paper with its grain,
 * or glass. Both persisted glass choices use the existing library renderer
 * (glass/liquid-glass). Each sets the shell's border colour at rest and while
 * focused; live glass draws its own
 * contour over the border instead (styles.css surface-liquid).
 */
export const composerSurface = (surface: ComposerSurface) =>
  surface === 'liquid'
    ? 'surface-liquid border-(color:--glass-edge) focus-within:border-(color:--glass-edge-focus)'
    : surface === 'glass'
      ? 'surface-glass border-(color:--glass-edge) focus-within:border-(color:--glass-edge-focus)'
      : surface === 'paper'
        ? 'surface-paper border-(color:--paper-edge) focus-within:border-control'
        : 'border-control focus-within:border-focus'

export const ComposerContext: FC<{ review: ComposerReview | undefined }> = ({
  review,
}) => (
  <>
    <RunInputStatus />
    {review && <ComposerReviewTarget target={review} />}
    <ComposerReferences />
    <ComposerAttachments />
  </>
)

export const ComposerTools: FC = () => (
  <>
    <ComposerAddAttachment />
    <ComposerPlus />
  </>
)

export const ComposerSettings: FC = () => (
  <>
    <ModelPicker />
    <AuiIf condition={(s) => s.thread.capabilities.dictation}>
      <AuiIf condition={(s) => s.composer.dictation == null}>
        <ComposerPrimitive.Dictate
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="aui-composer-dictate text-ink-muted hover:text-ink size-9 rounded-lg"
              aria-label="Start voice input"
            />
          }
        >
          <Icon.Microphone className="aui-composer-dictate-icon size-4" />
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(s) => s.composer.dictation != null}>
        <ComposerPrimitive.StopDictation
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="aui-composer-stop-dictation text-error-ink size-9 rounded-lg"
              aria-label="Stop voice input"
            />
          }
        >
          <Icon.Stop className="aui-composer-stop-dictation-icon size-5 animate-pulse" />
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </AuiIf>
  </>
)

export const ComposerPrimaryActions: FC<{
  review: ComposerReview | undefined
}> = ({ review }) => {
  const chatDisabled = useRunInputSendDisabled()
  // A choice can be sent with nothing written.
  const sendDisabled = review ? !review.canSend : chatDisabled
  const running = useAuiState((s) => s.thread.isRunning)
  // The stop control only cancels the send while no run it could stop is going.
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined &&
      !(s.thread.isRunning && s.thread.capabilities.cancel),
  )

  return (
    <>
      <AuiIf
        condition={(s) =>
          (s.thread.isRunning ||
            !s.composer.canCancel ||
            (s.thread.voice !== undefined &&
              s.composer.submission === undefined)) &&
          !shouldShowComposerResume(s) &&
          // While a reply runs, Send only steers it, so it waits for a draft
          // instead of sitting disabled beside Stop.
          !(
            s.thread.isRunning &&
            s.composer.canCancel &&
            s.composer.isEmpty &&
            review === undefined
          )
        }
      >
        <Magnet>
          <Button
            type="submit"
            disabled={sendDisabled}
            variant="default"
            size="icon"
            // No tile: the plane itself carries the accent, under an ink outline.
            className="aui-composer-send text-ink hover:bg-hover active:bg-selected bg-transparent disabled:opacity-40"
            data-appearance-part="composer-primary-action"
            data-appearance-radius-role="control"
            {...appearancePair('primary', 'composer')}
            aria-label={
              review
                ? 'Send feedback'
                : running
                  ? 'Send to current response'
                  : 'Send message'
            }
            aria-keyshortcuts="Enter Control+Enter Meta+Enter"
          >
            <Icon.Send className="aui-composer-send-icon size-5" />
          </Button>
        </Magnet>
      </AuiIf>
      <AuiIf condition={shouldShowComposerResume}>
        <Magnet>
          <ComposerPrimitive.Resume
            render={
              <Button
                type="button"
                variant="default"
                size="icon"
                // No tile, as Send: the arrows carry the accent under an ink outline.
                className="aui-composer-resume text-ink hover:bg-hover active:bg-selected bg-transparent disabled:opacity-40"
                data-appearance-part="composer-primary-action"
                data-appearance-radius-role="control"
                {...appearancePair('primary', 'composer')}
                aria-label="Resume generating"
              />
            }
          >
            <Icon.Refresh className="aui-composer-resume-icon size-5 animate-in fade-in zoom-in-50 -spin-in-180 ease-lift duration-(--duration-lift)" />
          </ComposerPrimitive.Resume>
        </Magnet>
      </AuiIf>
      <AuiIf
        condition={(s) =>
          s.composer.canCancel &&
          (s.thread.voice === undefined || s.composer.submission !== undefined)
        }
      >
        <Magnet>
          <ComposerPrimitive.Cancel
            render={
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-cancel appearance-destructive-action size-9 rounded-lg disabled:opacity-40"
                data-appearance-part="composer-primary-action"
                data-appearance-radius-role="control"
                {...appearancePair('on-destructive', 'destructive-fill')}
                aria-label={isSending ? 'Cancel sending' : 'Stop generating'}
              />
            }
          >
            <Icon.Stop className="aui-composer-cancel-icon size-5" />
          </ComposerPrimitive.Cancel>
        </Magnet>
      </AuiIf>
    </>
  )
}
