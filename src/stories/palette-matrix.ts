// SOURCING: none: the palette matrix's list of stories, kept free of components so the story index and the server route can read it. The palettes are the app's own (lib/appearance-policy PALETTES); nothing here copies a colour.
import { PALETTES } from '@/lib/appearance-policy'
import type { StoryMeta } from './index'

/** One palette in one mode: what a person has picked in Settings and the theme switch. */
export type PaletteProfile = {
  /** `github-sharp-dark`: the app's palette value and the mode, the id's last part. */
  id: string
  palette: (typeof PALETTES)[number]['value']
  mode: 'light' | 'dark'
  label: string
}

export const PALETTE_PROFILES: readonly PaletteProfile[] = PALETTES.flatMap(
  ({ value, label }) =>
    (['light', 'dark'] as const).map((mode) => ({
      id: `${value}-${mode}`,
      palette: value,
      mode,
      label: `${label}, ${mode}`,
    })),
)

/** The surfaces AC-28 names, and the one AC-27's theme half reads. */
export const PALETTE_SURFACES = [
  {
    id: 'chat',
    title: 'the Theo chat with a tool call and a diff',
    viewport: { width: 1280, height: 640 },
  },
  {
    id: 'markdown',
    title: 'the Markdown panel in preview with headings, a table, code and a link',
    viewport: { width: 1280, height: 700 },
  },
  {
    id: 'changes',
    title: 'the Changes panel with a diff open',
    viewport: { width: 1280, height: 640 },
  },
  {
    id: 'cabinet',
    title: 'the artifact cabinet',
    viewport: { width: 1280, height: 640 },
  },
  {
    id: 'terminal',
    title: 'a process pane with a terminal test output',
    viewport: { width: 1280, height: 640 },
  },
  {
    id: 'face',
    title: "Theo's face, working, on the status row",
    viewport: { width: 1280, height: 640 },
  },
] as const

export type PaletteSurface = (typeof PALETTE_SURFACES)[number]['id']

export const paletteStoryId = (surface: PaletteSurface, profile: string) =>
  `workbench-palette-${surface}-${profile}`

export const PALETTE_STORIES: readonly StoryMeta[] = PALETTE_SURFACES.flatMap(
  (surface) =>
    PALETTE_PROFILES.map(
      (profile): StoryMeta => ({
        id: paletteStoryId(surface.id, profile.id),
        title: `Workbench palette matrix: ${surface.title}, ${profile.label}`,
        lane: 'original',
        viewport: surface.viewport,
      }),
    ),
)
