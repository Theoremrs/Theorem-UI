# Interactive answer artifacts: presentation and lifecycle

Owner's direction of 2026-11-17, with the execution plan it extends
(`interactive-answer-artifacts-plan.md`, W0-W8). Progress is tracked in
`interactive-answer-artifacts.checklist.json`. The artifact browser (the
Ratatui-derived thread and artifact list) is being redesigned in another
session and is out of scope here.

## Three surfaces, not one

1. **Explanation scenes** (SceneOS on luma.gl): spatial, explorable, the
   flagship. Finished end to end first.
2. **UI artifacts** (OpenUI programs, Apps, notebooks, documents, code,
   diagrams): built from components and code the agent writes.
3. **Gallery/browser**: where artifacts are found, resumed and compared. An
   index, not an immersive surface. It gets its card from the artifacts once
   they look right.

## The same artifact in three contexts

| Context | Purpose | Framing |
| --- | --- | --- |
| Inline (in the answer) | Reading flow; the answer opens into a live space | No visible chrome: no title bar, no window frame, no Interact gate, no Open as the main control. Spacing and containment, and a material plane or faint edge only where it helps legibility. |
| Expanded / focused | Inspect and operate | Light framing is fine: a title if needed, state or revision, controls, Ask about the selection. |
| Gallery | Browse, scan, resume, compare | A card representation. |

## Presentation rules

- Inline artifacts are chromeless by default. The surrounding answer explains
  them, so the title is left out inline unless the reader needs it to get
  their bearings.
- Controls are progressive: each context shows only what it needs.
- Expanding keeps identity and state: the same instance, never a remount
  that looks different.
- The surface reads as part of the answer, not as a foreign app embedded in
  it.
- Every artifact kind shares the same loading, failure and resume patterns.
- No visible chrome, but an invisible frame contract. Every inline artifact
  still has sizing, focus handling, expansion, a lifecycle (loading, ready,
  failed, fallback), revision identity, Ask and continuity hooks, and theme
  awareness. These live in the frame, not in drawn chrome.

## Order

1. One scene artifact finished end to end: inline, selection, state
   continuity, Ask about the exact state, expansion, reopening later, theme,
   fallback, and chromeless presentation (plan W1-W5 for the scene path).
2. The shared presentation contract, drawn from that scene: spacing,
   mount/loading, empty/error, expansion, actions, revision/state metadata,
   and the inline, expanded and gallery transitions.
3. UI artifacts brought up to the same standard on that contract.
4. Gallery cards, built from the artifacts (the browser itself belongs to the
   other session).

## Review fixtures

Design is judged on fixed states, the same ones each round, in dark and light,
full page and tight crop (`/story/<id>`; the ids are listed in the checklist).
The scene fixtures draw the real SceneOS page that Theorem builds
(`scene-os-web`'s `render_embedded_scene_html`), committed with its source
revision and hash. A fixture proves rendering only. Whether the feature works
is shown in live runs with the real agent in the real chat, across varied
questions (plan W0 and W7).
