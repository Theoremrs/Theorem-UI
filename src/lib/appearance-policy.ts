// SOURCING: theorem-appearance-v1 roles, recipes, and Calm manifest.
export const PALETTES = [
  {
    value: 'github-sharp',
    label: 'GitHub Sharp',
    code: { light: 'github-light-default', dark: 'github-dark-default' },
  },
  {
    value: 'ember',
    label: 'Ember',
    code: { light: 'github-light-default', dark: 'github-dark-default' },
  },
  {
    value: 'stone',
    label: 'Stone',
    code: { light: 'github-light-default', dark: 'github-dark-default' },
  },
  {
    value: 'vitesse',
    label: 'Vitesse',
    code: { light: 'vitesse-light', dark: 'vitesse-dark' },
  },
] as const

export type Palette = (typeof PALETTES)[number]['value']

export const SURFACE_ROLES = [
  'canvas',
  'navigation',
  'composer',
  'user-message',
  'assistant-reading',
  'popover',
  'artifact',
  'status',
  'chart',
] as const

export const MATERIALS = ['flat', 'paper', 'glass', 'liquid'] as const
export type Material = (typeof MATERIALS)[number]
export type SurfaceRole = (typeof SURFACE_ROLES)[number]

export const TEXT_RECIPES = {
  // Reading text: 17px on a 27px line, the size long answers are read at.
  prose: {
    family: 'text',
    size: 17 / 16,
    lineHeight: 27 / 17,
    weight: 400,
    tracking: 'normal',
    scale: 'content',
  },
  // What the person writes, in Manrope: their sent turn at 16px on a 26px
  // line, which carries the x-height of 17px Plex beside it (8.6 vs 8.8px).
  'prose.human': {
    family: 'human',
    size: 1,
    lineHeight: 26 / 16,
    weight: 400,
    tracking: 'normal',
    scale: 'content',
  },
  'composer.content': {
    family: 'human',
    size: 1,
    lineHeight: 1.5,
    weight: 400,
    tracking: 'normal',
    scale: 'content',
  },
  'ui.label': {
    family: 'text',
    size: 0.875,
    lineHeight: 20 / 14,
    weight: 400,
    tracking: '0.01em',
    scale: 'ui',
  },
  'ui.section': {
    family: 'text',
    size: 0.875,
    lineHeight: 20 / 14,
    weight: 500,
    tracking: '0.01em',
    scale: 'ui',
  },
  // A navigation group's name (Pinned, Projects, Chats): a step above the
  // rows it heads in size and weight, so the groups read apart without rules.
  'ui.group': {
    family: 'text',
    size: 0.9375,
    lineHeight: 20 / 15,
    weight: 600,
    tracking: 'normal',
    scale: 'ui',
  },
  metadata: {
    family: 'text',
    size: 0.75,
    lineHeight: 1.5,
    weight: 400,
    tracking: '0.01em',
    scale: 'ui',
  },
  // Paper Mono at 14px carries the x-height JetBrains Mono had at 13px.
  code: {
    family: 'mono',
    size: 0.875,
    lineHeight: 21 / 14,
    weight: 400,
    tracking: 'normal',
    scale: 'code',
  },
  // Headings sit clearly above 17px prose in size and at a semibold weight.
  'heading.small': {
    family: 'text',
    size: 19 / 16,
    lineHeight: 26 / 19,
    weight: 600,
    tracking: 'normal',
    scale: 'content',
  },
  'heading.medium': {
    family: 'text',
    size: 22 / 16,
    lineHeight: 30 / 22,
    weight: 600,
    tracking: 'normal',
    scale: 'content',
  },
  'heading.large': {
    family: 'text',
    size: 26 / 16,
    lineHeight: 34 / 26,
    weight: 600,
    tracking: 'normal',
    scale: 'content',
  },
} as const

/**
 * The Calm preset's fixed colours: GitHub Sharp's own, held flat (the
 * default the owner restored on 2026-11-20). scripts/palettes.ts owns the
 * rules; this manifest mirrors its :root/.dark calm output.
 */
export const CALM_COLORS = {
  light: {
    'surface-neutral': '#ffffff',
    'surface-sidebar': '#f2f3f5',
    'surface-composer': '#ffffff',
    'surface-raised': '#ffffff',
    'surface-user-message': '#f2f3f5',
    'surface-hover': '#edeff1',
    'surface-selected': '#d2e1f0',
    ink: '#24292d',
    'ink-muted': '#586069',
    'line-separator': '#e1e4e8',
    'line-control': '#808892',
    redwood: '#3379b3',
    'on-redwood': '#ffffff',
    'redwood-ink': '#286394',
    focus: '#3379b3',
    'attention-ink': '#7b5100',
  },
  dark: {
    'surface-neutral': '#1c1d1e',
    'surface-sidebar': '#1c1d1e',
    'surface-composer': '#262829',
    'surface-raised': '#262829',
    'surface-user-message': '#242627',
    'surface-hover': '#242627',
    'surface-selected': '#2d343a',
    ink: '#c3c6c8',
    'ink-muted': '#a2a5a8',
    'line-separator': '#2c2d2f',
    'line-control': '#85888b',
    redwood: '#4490d0',
    'on-redwood': '#101112',
    'redwood-ink': '#7ebdf7',
    focus: '#7ebdf7',
    'attention-ink': '#fac781',
  },
} as const

export const COLOR_ROLES = {
  canvas: 'surface-neutral',
  navigation: 'surface-sidebar',
  composer: 'surface-composer',
  'user-message': 'surface-user-message',
  'assistant-reading': 'surface-neutral',
  popover: 'popover',
  artifact: 'surface-artifact',
  status: 'error-container',
  hover: 'surface-hover',
  selected: 'surface-selected',
  primary: 'ink',
  secondary: 'ink-muted',
  placeholder: 'ink-muted',
  // Inline code reads in the palette's warm amber, apart from prose.
  code: 'attention-ink',
  link: 'redwood-ink',
  separator: 'line-separator',
  boundary: 'line-control',
  accent: 'redwood',
  'accent-hover': 'redwood-hover',
  'accent-pressed': 'redwood-pressed',
  'on-accent': 'on-redwood',
  focus: 'focus',
  error: 'error-ink',
  'destructive-fill': 'error-solid',
  'on-destructive': 'on-error',
  'success-ink': 'teal-ink',
  'success-fill': 'teal-container',
  'warning-ink': 'ochre-ink',
  'warning-fill': 'ochre-container',
  // An action available now or a pending decision (the co-browse brief's
  // oxblood); a learned relationship or capture confirmation (its gold).
  // Each palette gives these meanings its own hues.
  action: 'action-ink',
  'action-fill': 'action-container',
  insight: 'insight-ink',
  'insight-fill': 'insight-container',
  // The five categorical data-series slots. Categorical, not semantic: a
  // person recolours each independently, and the chart reads them for every
  // line, marker and legend swatch (no inherited root hue survives).
  'series-1': 'series-1',
  'series-2': 'series-2',
  'series-3': 'series-3',
  'series-4': 'series-4',
  'series-5': 'series-5',
} as const

const readableSurfaces = [
  'canvas',
  'navigation',
  'composer',
  'user-message',
  'assistant-reading',
  'popover',
  'artifact',
  'hover',
  'selected',
] as const

type ColorRole = keyof typeof COLOR_ROLES
export type ColorPair = {
  foreground: ColorRole
  background: ColorRole
  minimum: number
}

export const COLOR_PAIRS: readonly ColorPair[] = [
  ...readableSurfaces.flatMap((background) =>
    (['primary', 'secondary', 'link', 'code'] as const).map((foreground) => ({
      foreground,
      background,
      minimum: 4.5,
    })),
  ),
  { foreground: 'placeholder', background: 'composer', minimum: 4.5 },
  ...(['accent', 'accent-hover', 'accent-pressed'] as const).map(
    (background) => ({
      foreground: 'on-accent' as const,
      background,
      minimum: 4.5,
    }),
  ),
  {
    foreground: 'on-destructive',
    background: 'destructive-fill',
    minimum: 4.5,
  },
  { foreground: 'error', background: 'status', minimum: 4.5 },
  { foreground: 'success-ink', background: 'success-fill', minimum: 4.5 },
  { foreground: 'warning-ink', background: 'warning-fill', minimum: 4.5 },
  { foreground: 'action', background: 'action-fill', minimum: 4.5 },
  { foreground: 'insight', background: 'insight-fill', minimum: 4.5 },
  ...readableSurfaces.flatMap((background) =>
    (['action', 'insight'] as const).map((foreground) => ({
      foreground,
      background,
      minimum: 4.5,
    })),
  ),
  // Series marks are graphics: 3:1 against the surfaces they plot on.
  ...readableSurfaces.flatMap((background) =>
    (['series-1', 'series-2', 'series-3', 'series-4', 'series-5'] as const).map(
      (foreground) => ({ foreground, background, minimum: 3 }),
    ),
  ),
  ...(
    ['canvas', 'navigation', 'composer', 'popover', 'artifact'] as const
  ).flatMap((background) =>
    (['focus', 'boundary'] as const).map((foreground) => ({
      foreground,
      background,
      minimum: 3,
    })),
  ),
]

export function appearancePair(foreground: ColorRole, background: ColorRole) {
  return {
    'data-appearance-pair': `${foreground}/${background}`,
    'data-foreground-role': foreground,
    'data-background-role': background,
  }
}

/** Reference IBM Plex Sans Variable 5.3.0, Latin upright. */
export const PLEX_READING_MEASURE = {
  comfortableMeasure: 35.75,
  wideMeasure: 44.75,
  corpusSha256:
    'dbfeea1c559f50254d2a3f66388fe0c732fa7df09ab74fe0de7921d5860904f7',
  fontSha256:
    'e2291e842cf5af167122a22881a740c7f2dda7716f1e8cd76680264f4a859470',
} as const
