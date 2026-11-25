# PR #164: Vitesse code-block refinement

The owner requested the original Vitesse colors for ordinary code blocks, with
the calmer typography established for the terminal. This update also resolves
the PR's conflicts with main while retaining main's Paper Mono, terminal editor
profiles, bare Mermaid replies, graph renderer, and document cards.

Verification used the source tree `cd2d05e64e5491e2336d106c059b2bdb3bf250e0`
before adding this evidence note. Its parents are the existing PR head
`1a2083e8e6f566b0112ea25d5effd8534f6594fd` and main
`1409c0035113252ad63396e2ddc8cee9c603bafd`. This note is the only addition after
that source tree was tested.

## Color behavior

`codeThemeForSurface` preserves every bundled Vitesse foreground, token rule,
and alpha value when the code ground equals that theme's native opaque ground:
`#121212` in dark mode and `#ffffff` in light mode. Equivalent CSS color formats
are accepted. Quiet punctuation and comments retain their authored hierarchy.

Other palettes and Vitesse on an overridden ground continue through the existing
contrast calibration. Explicit caller-provided themes retain their behavior.
Changes to appearance CSS refresh the default theme so an overridden code ground
cannot leave a stale native-ground theme behind. Standalone highlighters paint
`bg-code`, matching the surface used for their calibration.

The browser color oracle now compares Vitesse's rendered text, character by
character, with a separate raw-Shiki pass using the installed theme. It requires
the native background, base foreground, and original token colors and alpha.
Base text, inline code, and selection keep their contrast gates. All syntax
contrast measurements remain diagnostic data; this does not claim that every
authored Vitesse syntax color meets 4.5:1.

## Typography and spacing

| Property                            | Result                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Default code face                   | Main's vendored Paper Mono                                             |
| Default size / line height / weight | 14px / 21px / 400                                                      |
| User controls                       | Existing custom font and code-scale settings retained                  |
| Letter spacing                      | Normal; no tightened filename tracking                                 |
| Whitespace                          | Ordinary source text; always-visible space dots and tab arrows removed |
| Header                              | Minimum 28px; long filenames can truncate while copy remains available |
| Wrapped continuation                | Source indentation, capped at 40% of the containing width              |
| Collapse measurement                | Actual extent of the first N logical lines, including wrapped rows     |

The full `pre` is observed for resizing so width, loaded-font, and scale changes
can update a collapsed block. Copying retains the original source, including
tabs, interior and trailing spaces, and the final newline. The viewport remains
keyboard focusable. The unused whitespace-transformer dependency was removed.

## Regressions addressed

- Header-looking `---` and `+++` source rows remain visible inside diff hunks,
  including miscounted hunks. The terminal's tolerant fallback follows the same
  rule and recognizes explicit boundaries before a subsequent file.
- Multi-file chat patches retain their original diff and all filenames instead
  of presenting every change as the last file. Their gutter numbers describe
  patch lines, and copy still takes the original patch.
- Gutter sizing uses iteration rather than spreading every row into `Math.max`;
  its regression covers 200,000 rows.
- Collapsed blocks account for differently wrapped logical lines, then remeasure
  after resizing. Tests also cover expansion and observer cleanup.
- Document fences preserve colon filenames and quoted filename metadata through
  the same `fenceTitle` contract as chat. Mermaid retains its diagram renderer.

## Verification

| Command or check                                                        | Result                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` with Bun 1.4.3                          | Passed                                                                             |
| `sh terminal/build.sh` with pinned Rust 1.96.1 and wasm-bindgen 0.2.127 | Release WASM build and generated bindings passed                                   |
| `NODE_OPTIONS=--max-old-space-size=4096 bun run typecheck`              | Passed, no diagnostics                                                             |
| `bun run test:composer`                                                 | 1,222 passed; 0 failed; 113 files                                                  |
| `bun run test:appearance`                                               | 201 passed; 0 failed; 15 files                                                     |
| Focused code, theme, document, and terminal suites                      | 192 passed; 0 failed; 1,757 assertions; 13 files                                   |
| `bun run oracle:colors`                                                 | 119 required color edges across 10 palette/mode sets; 2,390 predicates; 0 failures |
| Focused ESLint and Prettier checks                                      | Passed                                                                             |
| `node --check scripts/design-oracles/review-code-contrast.mjs`          | Passed                                                                             |
| `git diff --cached --check origin/main`                                 | Passed for the PR diff                                                             |

The focused suites are `code-theme`, `code-contrast`, and `code-classes` in
`src/lib`; `code-file`, `code-gutter`, and `code-lines` in
`src/components/assistant-ui/elements`; `markdown-document` in
`src/components/artifacts`; and `terminal-code`, `terminal-editor`,
`terminal-theme`, `terminal-roles`, `terminal-ladder`, and `terminal-transcript`
in `src/components/terminal`.

The oracle's exact fidelity comparison was additionally exercised with real
Shiki-generated observations: original light and dark paint passed, while
changed token colors, removed alpha, and a wrong background each failed. These
are comparison-logic checks, not browser observations.

The first composer run was terminated while the Rust build was running. The
isolated rerun completed successfully. TypeScript exceeded Node's default 2GB
heap; its successful final run used the explicit 4GB heap above. Happy DOM tests
emit existing router/React-act and CSS-token fallback diagnostics; the reported
test runs have no failed assertions.

## Remaining visual evidence gap

The installed Chromium could not launch in this environment:
`socket() failed: Operation not permitted`. Consequently the browser-rendered
code oracle, `bun run e2e:composer --built`, and new after screenshots were not
completed locally. The existing November 23 screenshots predate this refinement.

The source-color checks and simulated DOM geometry establish their stated
contracts; they do not establish pixel equivalence or actual Paper Mono layout.
Browser review should cover Vitesse light/dark, a long filename beside copy at a
narrow width, deeply indented wrapped code, and font/scale changes while collapsed.
