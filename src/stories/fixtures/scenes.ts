// SOURCING: none: the review fixtures for a reply's interactive scene, kept free of components so the story index can read them. The frame page and packages under ./scene/ are Theorem's own builds, not stand-ins:
//
// - host.html is scene-os-web's render_embedded_scene_html, the page the
//   authority serves at /api/scene/v1/host, from Theorem main a7ea1f19d2
//   (`cargo run -p scene-os-web --example embed_sample`). SHA-256
//   9a84189629130b05fe010350421557bef20a59a02862c82c41c7601be9364764; its
//   renderer bundle is web/dist/scene-os.bundle.js at that revision.
// - cpu.json is the "How does a CPU work?" package the same example compiles
//   (the rv32i teaching datapath).
// - adder.json is scene-os-core's tests/fixtures/written-two-bit-adder.json,
//   a model with its code as the agent writes one, compiled with
//   compile_explanation_request. adder-throws.json changes one line of that
//   code so its add phase throws; adder-load-fails.json calls an undefined
//   function while the code loads.
//
// A fixture proves how a scene is drawn, never that the agent wrote one.

/** The policy the authority serves the frame page with (scene-os-web EMBEDDED_SCENE_POLICY). */
export const SCENE_HOST_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

export const STORY_SCENE_HOST = '/story-assets/scene-host.html'

export type SceneFixture = 'cpu' | 'adder' | 'adder-throws' | 'adder-load-fails'

/**
 * Inline presentations for the owner to pick between before SceneOS and the
 * card change. Each is CSS over today's page and card, inline only: expanded
 * stays as it is.
 *
 * - plane: the page drops its header band (the reply already asks the
 *   question) and its zoom tools; the card keeps its faint plane but loses
 *   its edge, and Expand shows on hover or focus.
 * - open: as plane, and the page and card are transparent, so the diagram
 *   sits on the reply itself.
 */
export type SceneStudy = 'plane' | 'open'

const PLANE_PAGE = `
  [data-layout="inline"] .ex-header > :not(.ex-note) { display: none; }
  [data-layout="inline"] .ex-header { padding: 0 16px; border-bottom: 0; }
  [data-layout="inline"] .ex-stage-tools { display: none; }`

/** Added to the frame page by the story route (?study=). */
export const SCENE_STUDY_PAGE_CSS: Record<SceneStudy, string> = {
  plane: PLANE_PAGE,
  open: `${PLANE_PAGE}
  html[data-layout="inline"], html[data-layout="inline"] body { background: transparent !important; }`,
}

const CARD = '[data-slot="theorem-scene-card"]:not(:modal)'
const PLANE_CARD = `
  ${CARD} { border-color: transparent; }
  ${CARD} > button[aria-expanded] { opacity: 0; transition: opacity 150ms; }
  ${CARD}:hover > button[aria-expanded], ${CARD}:focus-within > button[aria-expanded] { opacity: 1; }
  @media (pointer: coarse) { ${CARD} > button[aria-expanded] { opacity: 1; } }`

/** Added to the story page over the card. */
export const SCENE_STUDY_CARD_CSS: Record<SceneStudy, string> = {
  plane: PLANE_CARD,
  open: `${PLANE_CARD}
  ${CARD} { background: transparent; }`,
}

export type SceneStory = {
  id: string
  title: string
  question: string
  fixture: SceneFixture
  /** The reply's words before and after the scene. */
  before: string
  after: string
  /** Expanded into the top layer once it has drawn. */
  expanded?: boolean
  /** The frame page cannot be reached: the card gives up after a short wait. */
  unreachable?: boolean
  /** An inline presentation study instead of today's. */
  study?: SceneStudy
  /** Also open in the workspace panel beside the conversation. */
  panel?: boolean
}

const CPU = {
  question: 'How does a CPU work?',
  fixture: 'cpu' as const,
  before:
    'A CPU repeats one loop: fetch the instruction the program counter points at, decode it, execute it, and write the result back. The model below runs that loop on a small RISC-V datapath.',
  after:
    'Step through one instruction first and watch the program counter move to the next address. Then pick the ALU to see which inputs it combined.',
}

const ADDER = {
  question: 'How does a two-bit adder add?',
  before:
    'A two-bit adder reads both operands, adds them bit by bit, and writes the sum back. Here is one you can step through.',
  after:
    'Try 3 + 2: the sum needs three bits, so the carry out of the top bit is dropped and the register keeps 1.',
}

export const SCENE_STORIES: readonly SceneStory[] = [
  { id: 'scene-cpu-inline', title: 'A compiled CPU scene, inline in its reply', ...CPU },
  {
    id: 'scene-adder-inline',
    title: 'A model the agent wrote, inline in its reply',
    fixture: 'adder',
    ...ADDER,
  },
  {
    id: 'scene-cpu-expanded',
    title: 'The CPU scene expanded into the top layer',
    expanded: true,
    ...CPU,
  },
  {
    id: 'scene-cpu-panel',
    title: 'The CPU scene opened in the workspace panel beside its reply',
    panel: true,
    ...CPU,
  },
  {
    id: 'scene-adder-throws',
    title: "The agent's code throws while it runs: the error and Fix under the scene",
    fixture: 'adder-throws',
    ...ADDER,
  },
  {
    id: 'scene-adder-load-fails',
    title: "The agent's code fails as it loads: the scene could not be drawn",
    fixture: 'adder-load-fails',
    ...ADDER,
  },
  { id: 'scene-study-plane-cpu', title: 'Study plane: the CPU scene inline', study: 'plane', ...CPU },
  {
    id: 'scene-study-plane-adder',
    title: 'Study plane: the model the agent wrote, inline',
    study: 'plane',
    fixture: 'adder',
    ...ADDER,
  },
  { id: 'scene-study-open-cpu', title: 'Study open: the CPU scene inline', study: 'open', ...CPU },
  {
    id: 'scene-study-open-adder',
    title: 'Study open: the model the agent wrote, inline',
    study: 'open',
    fixture: 'adder',
    ...ADDER,
  },
  {
    id: 'scene-host-unreachable',
    title: 'The scene page cannot be reached: the reply falls back to its text',
    unreachable: true,
    ...CPU,
  },
]
