# Paper Mono provenance

Paper Mono is the app's monospaced face (`--font-mono` in `src/styles.css`),
chosen by the owner on 2026-11-22. It is not published on npm or Fontsource,
so the variable webfont is vendored here from the release archive.

Source: [paper-design/paper-mono](https://github.com/paper-design/paper-mono),
release v1.0 (`paper-mono-v1.0.zip`, SHA-256
`8642652985dc87bf4cfd07c89942899e611c3c774fc25284c0dd4fe86a993a13`).
Licensed under the SIL Open Font License 1.1; the licence travels with the
font in `OFL.txt`, as the OFL requires.

| File                    | What it is                                                                                              | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `paper-mono-wght.woff2` | `fonts/webfonts/PaperMono[wght].woff2` from the archive, renamed: one variable upright, weights 100-800 | `57b28aaaffc46f85ed5b5adeda22bc7bce0fcdbf3e6f84850c327765fe6fdc6b` |
| `OFL.txt`               | The archive's licence, unchanged                                                                        | `ae8bcaf5a046be7e096b5710a8532cdaa5a299462e182752b805dcfa44370e4c` |

The face has Latin, Latin Extended, box drawing and blocks (U+2500-259F),
arrows and the keyboard symbols; other scripts fall back to the next family in
`--font-mono`. It has no italic. To update it, replace both files from a newer
release and update the hashes here.
