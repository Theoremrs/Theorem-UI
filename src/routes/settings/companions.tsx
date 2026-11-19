// SOURCING: lib/figures (Theo and Kit), lib/speech/narrate (narrating replies as they stream), lib/speech/dictation (server dictation status), coss ui Switch, Badge and SegmentedControl (through the appearance page's Choice), the settings frame
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/coss/badge'
import { SegmentedControl } from '@/components/coss/segmented-control'
import { Switch } from '@/components/coss/switch'
import { FaceMark } from '@/components/face/face-mark'
import { Icon } from '@/components/icons'
import {
  SettingsBox,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { Button } from '@/components/ui/button'
import { VISORS, useFigures } from '@/lib/figures'
import { useNarration } from '@/lib/speech/narrate'
import { Choice } from './appearance'

export const Route = createFileRoute('/settings/companions')({
  component: CompanionsSettings,
})

function CompanionsSettings() {
  const figures = useFigures()
  const narrating = useNarration((state) => state.live)
  const setNarrating = useNarration((state) => state.setLive)
  return (
    <SettingsPage
      title="Theo and Kit"
      description="The two figures that share the window with you, on this device."
    >
      <SettingsSection title="Theo">
        <SettingsBox>
          <SettingsRow
            Mark={FaceMark}
            title="Show Theo"
            description="The agent’s face. It shows what Theorem is doing, reacts to you, and sleeps when nothing is happening. Tap it, carry it, or double-tap to send it home."
          >
            <Switch
              aria-label="Theo"
              checked={figures.theo}
              onCheckedChange={figures.setTheo}
            />
          </SettingsRow>
          <SettingsRow
            Mark={Icon.ReadAloud}
            title="Narrate replies as they arrive"
            description="Theo reads each reply aloud from its first sentence while the rest streams in, holding the boombox until it ends. Read aloud on a reply still works with this off."
          >
            <Switch
              aria-label="Narrate replies as they arrive"
              checked={narrating}
              onCheckedChange={setNarrating}
            />
          </SettingsRow>
          <SettingsRow
            Mark={FaceMark}
            title="Visor"
            description="The dark screen behind Theo’s eyes. Auto keeps it in the light theme and drops it in the dark one, where the eyes glow against the page. Without it in the light theme, the eyes are drawn dark."
          >
            <SegmentedControl size="sm" aria-label="Theo’s visor">
              {VISORS.map(({ value, label }) => (
                <Choice
                  key={value}
                  label={label}
                  pressed={figures.visor === value}
                  onPress={() => figures.setVisor(value)}
                />
              ))}
            </SegmentedControl>
          </SettingsRow>
        </SettingsBox>
      </SettingsSection>
      <DictationVoice />
      <SettingsSection title="Kit">
        <SettingsBox>
          <SettingsRow
            Mark={Icon.Sparkle}
            title="Show Kit"
            description="The fox that lives in the window. It is just there: it walks, sits and naps on its own."
          >
            <Switch
              aria-label="Kit"
              checked={figures.kit}
              onCheckedChange={figures.setKit}
            />
          </SettingsRow>
        </SettingsBox>
      </SettingsSection>
    </SettingsPage>
  )
}

/**
 * Dictation runs on Theorem's own engine (pure-Rust Parakeet on burn), reached
 * over a WebSocket; the browser only captures the microphone. Where the server
 * does not serve it, dictation falls back to the browser's own recognition.
 */
/** One manifest model with its installed state, as the server reports it. */
interface DictationModel {
  entry: {
    id: string
    displayName: string
    sizeBytes: number
    license: string
    licenseUrl?: string
  }
  installed: boolean
  installedBytes: number
}

/** How many bytes read as a plain size. */
function bytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.round(n / 1e3)} KB`
}

function DictationVoice() {
  const [status, setStatus] = useState<{
    served: boolean
    model_loaded?: boolean
    execution_provider?: string | null
    blocker?: string | null
  }>()
  const [models, setModels] = useState<DictationModel[]>()
  const [busy, setBusy] = useState<string>()
  const [failed, setFailed] = useState<string>()

  const refresh = () => {
    fetch('/api/chat/v1/dictation/status', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : { served: false }))
      .then(setStatus)
      .catch(() => setStatus({ served: false }))
    fetch('/api/chat/v1/dictation/models', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : { models: [] }))
      .then((body: { models?: DictationModel[] }) => setModels(body.models ?? []))
      .catch(() => setModels([]))
  }

  useEffect(refresh, [])

  const install = (id: string) => {
    setBusy(id)
    setFailed(undefined)
    fetch(`/api/chat/v1/dictation/models/${id}/install`, { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message ?? 'The install failed')
        }
      })
      .catch((error: Error) => setFailed(error.message))
      .finally(() => {
        setBusy(undefined)
        refresh()
      })
  }

  const remove = (id: string) => {
    setBusy(id)
    setFailed(undefined)
    fetch(`/api/chat/v1/dictation/models/${id}`, { method: 'DELETE' })
      .catch((error: Error) => setFailed(error.message))
      .finally(() => {
        setBusy(undefined)
        refresh()
      })
  }

  const served = status?.served === true
  const loaded = status?.model_loaded === true

  return (
    <SettingsSection
      title="Dictation voice"
      description="What the microphone hears with. Theorem transcribes on its own engine (pure-Rust Parakeet), so your voice is processed by your Theorem, not a third party. Where the server does not serve dictation, your browser's own speech recognition is used."
    >
      <SettingsBox>
        <SettingsRow
          Mark={Icon.Microphone}
          title="Parakeet on Theorem"
          description={
            !status ? (
              <Badge variant="outline">Checking…</Badge>
            ) : !served ? (
              <Badge variant="outline">Using browser recognition</Badge>
            ) : loaded ? (
              <Badge variant="success">Ready{status.execution_provider ? ` · ${status.execution_provider}` : ''}</Badge>
            ) : (
              <Badge variant="warning">Model not installed</Badge>
            )
          }
        />
        {served &&
          models?.map((model) => (
            <SettingsRow
              key={model.entry.id}
              Mark={Icon.Download}
              title={model.entry.displayName}
              description={
                busy === model.entry.id ? (
                  <Badge variant="info">Installing…</Badge>
                ) : model.installed ? (
                  <Badge variant="success">Installed · {bytes(model.entry.sizeBytes)}</Badge>
                ) : (
                  <Badge variant="outline">About {bytes(model.entry.sizeBytes)}</Badge>
                )
              }
            >
              {model.installed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => remove(model.entry.id)}
                >
                  Remove
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => install(model.entry.id)}
                >
                  <Icon.Download className="size-4" />
                  Download
                </Button>
              )}
            </SettingsRow>
          ))}
        {failed && (
          <div className="px-3 pb-3 text-xs text-error-ink">{failed}</div>
        )}
        {served && !loaded && status.blocker && (
          <div className="px-3 pb-3 text-xs text-ink-muted">
            {status.blocker}
          </div>
        )}
      </SettingsBox>
    </SettingsSection>
  )
}
