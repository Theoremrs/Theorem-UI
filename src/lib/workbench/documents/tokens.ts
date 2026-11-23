// SOURCING: lib/code-classes (Shiki over its JavaScript regex engine) with the grammars components/terminal/terminal-code.ts uses, so a file reads in the editor as it does in the terminal; a span is a token's class and its offsets are Shiki's, which count UTF-16 code units, as a JavaScript string does

import { classedLines, languageOf } from '@/lib/code-classes'
import type { TokenSpan } from '../wire'

/** The registered language a file name's extension (or whole name, as `Dockerfile`) calls for; absent when there is no grammar. */
export function languageOfPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return languageOf(
    name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name,
  )
}

/**
 * The highlight spans of `text`, as UTF-16 code unit offsets into it, one per classed token; plain text is
 * left out. Absent when no grammar is registered for `path`: that is "nothing to draw", not an empty file.
 */
export function tokenSpans(
  path: string,
  text: string,
): TokenSpan[] | undefined {
  const lang = languageOfPath(path)
  if (lang === undefined) return undefined
  return classedLines(text, lang).flatMap((line) =>
    line.flatMap((token) =>
      token.class
        ? [
            {
              start: token.offset,
              end: token.offset + token.text.length,
              class: token.class,
            },
          ]
        : [],
    ),
  )
}
