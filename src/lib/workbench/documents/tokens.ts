// SOURCING: @tanstack/highlight's createHighlighter and tokenize with the languages components/terminal/terminal-code.ts registers (the same grammars, so a file reads in the editor as it does in the terminal); a span is a token's `className` and its offsets are running UTF-16 lengths, because a JavaScript string is already counted in UTF-16 code units

import { createHighlighter } from '@tanstack/highlight/core'
import { c } from '@tanstack/highlight/languages/c'
import { cpp } from '@tanstack/highlight/languages/cpp'
import { csharp } from '@tanstack/highlight/languages/csharp'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { dockerfile } from '@tanstack/highlight/languages/dockerfile'
import { go } from '@tanstack/highlight/languages/go'
import { graphql } from '@tanstack/highlight/languages/graphql'
import { html } from '@tanstack/highlight/languages/html'
import { ini } from '@tanstack/highlight/languages/ini'
import { java } from '@tanstack/highlight/languages/java'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { kotlin } from '@tanstack/highlight/languages/kotlin'
import { makefile } from '@tanstack/highlight/languages/makefile'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { python } from '@tanstack/highlight/languages/python'
import { ruby } from '@tanstack/highlight/languages/ruby'
import { rust } from '@tanstack/highlight/languages/rust'
import { scss } from '@tanstack/highlight/languages/scss'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { swift } from '@tanstack/highlight/languages/swift'
import { toml } from '@tanstack/highlight/languages/toml'
import { ts } from '@tanstack/highlight/languages/ts'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { yaml } from '@tanstack/highlight/languages/yaml'
import type { TokenSpan } from '../wire'

const highlighter = createHighlighter({
  languages: [
    c,
    cpp,
    csharp,
    css,
    diff,
    dockerfile,
    go,
    graphql,
    html,
    ini,
    java,
    js,
    json,
    jsx,
    kotlin,
    makefile,
    markdown,
    python,
    ruby,
    rust,
    scss,
    shell,
    sql,
    swift,
    toml,
    ts,
    tsx,
    yaml,
  ],
})

/** The registered language a file name's extension (or whole name, as `Dockerfile`) calls for; absent when there is no grammar. */
export function languageOfPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const key = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  const lang = highlighter.normalizeLanguage(key)
  return lang === 'plaintext' ? undefined : lang
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
  const spans: TokenSpan[] = []
  let at = 0
  for (const token of highlighter.tokenize(text, { lang }).tokens) {
    const end = at + token.value.length
    if (token.className && end > at)
      spans.push({ start: at, end, class: token.className })
    at = end
  }
  return spans
}
