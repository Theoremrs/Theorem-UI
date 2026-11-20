// SOURCING: theorem-appearance-v1 roles, recipes, and Calm manifest.
export const PALETTES = [
  {
    value: 'ember',
    label: 'Ember',
    code: { light: 'github-light-default', dark: 'github-dark-default' },
  },
  {
    value: 'github-sharp',
    label: 'GitHub Sharp',
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
  'composer.content': {
    family: 'text',
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
  code: {
    family: 'mono',
    size: 0.8125,
    lineHeight: 20 / 13,
    weight: 400,
    tracking: 'normal',
    scale: 'code',
  },
  // Headings sit clearly above 17px prose in size and weight.
  'heading.small': {
    family: 'text',
    size: 19 / 16,
    lineHeight: 26 / 19,
    weight: 650,
    tracking: 'normal',
    scale: 'content',
  },
  'heading.medium': {
    family: 'text',
    size: 22 / 16,
    lineHeight: 30 / 22,
    weight: 650,
    tracking: 'normal',
    scale: 'content',
  },
  'heading.large': {
    family: 'text',
    size: 26 / 16,
    lineHeight: 34 / 26,
    weight: 650,
    tracking: 'normal',
    scale: 'content',
  },
} as const

/**
 * The Calm preset's fixed colours: the default (Ember) palette's own,
 * held flat. Placed here from the generator's Ember modes so the manifest
 * and the stylesheet cannot drift; scripts/palettes.ts owns the rules.
 */
export const CALM_COLORS = {
  light: {
    'surface-neutral': '#f7f7f5',
    'surface-sidebar': '#f2f0ee',
    'surface-composer': '#fcfbfb',
    'surface-raised': '#eeece9',
    'surface-user-message': '#fcfbfb',
    'surface-hover': '#f1f0ed',
    'surface-selected': '#e4daeb',
    ink: '#2f2c27',
    'ink-muted': '#635c54',
    'line-separator': '#e2deda',
    'line-control': '#8d857a',
    redwood: '#8761a0',
    'on-redwood': '#fffffe',
    'redwood-ink': '#6f5084',
    focus: '#8b5da8',
    'attention-ink': '#7b5100',
  },
  dark: {
    'surface-neutral': '#1e1c1f',
    'surface-sidebar': '#1e1c1f',
    'surface-composer': '#252327',
    'surface-raised': '#272529',
    'surface-user-message': '#252327',
    'surface-hover': '#252327',
    'surface-selected': '#352c3e',
    ink: '#eae8eb',
    'ink-muted': '#b0adb3',
    'line-separator': '#2f2c30',
    'line-control': '#747077',
    redwood: '#9c7cbc',
    'on-redwood': '#070708',
    'redwood-ink': '#c7a9e6',
    focus: '#a98cc8',
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
