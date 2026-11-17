// SOURCING: lib/figures (Theo and Kit), lib/speech/narrate (narrating replies as they stream), coss ui Switch and SegmentedControl (through the appearance page's Choice), the settings frame
import { createFileRoute } from '@tanstack/react-router'
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
