// SOURCING: Shiki's synchronous core (createHighlighterCoreSync) over its JavaScript regex engine, as the chat's code blocks run it (components/assistant-ui/elements/shiki-highlighter.tsx), with the grammars a coding agent writes and Shiki's bundled GitHub Dark Default theme; splitTokens for the ranges a caller marks within the code. No library names a TextMate token by a highlight class; this module reads the class from the colour GitHub Dark gives the token, because the terminal crate's classes are GitHub Dark's colours (terminal/src/lib.rs token_style, terminal/crates/workbench-editor/src/styles.rs).
//
// Code as lines of classed tokens, for the surfaces that colour code
// themselves: the agent terminal (components/terminal/terminal-code.ts) and
// the workbench editor (lib/workbench/documents/tokens.ts). Both draw a class
// in their own roles, so the tokens carry no colour; the class says which
// role. The tokenizing theme is fixed, not the palette's code theme, so a
// token keeps its class, and the terminal its look, in every palette.
import { createHighlighterCoreSync, splitTokens } from 'shiki/core'
import type { ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import c from 'shiki/langs/c.mjs'
import cpp from 'shiki/langs/cpp.mjs'
import csharp from 'shiki/langs/csharp.mjs'
import css from 'shiki/langs/css.mjs'
import diff from 'shiki/langs/diff.mjs'
import docker from 'shiki/langs/docker.mjs'
import go from 'shiki/langs/go.mjs'
import graphql from 'shiki/langs/graphql.mjs'
import html from 'shiki/langs/html.mjs'
import ini from 'shiki/langs/ini.mjs'
import java from 'shiki/langs/java.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import json from 'shiki/langs/json.mjs'
import jsx from 'shiki/langs/jsx.mjs'
import kotlin from 'shiki/langs/kotlin.mjs'
import make from 'shiki/langs/make.mjs'
import markdown from 'shiki/langs/markdown.mjs'
import python from 'shiki/langs/python.mjs'
import ruby from 'shiki/langs/ruby.mjs'
import rust from 'shiki/langs/rust.mjs'
import scss from 'shiki/langs/scss.mjs'
import shellscript from 'shiki/langs/shellscript.mjs'
import sql from 'shiki/langs/sql.mjs'
import swift from 'shiki/langs/swift.mjs'
import toml from 'shiki/langs/toml.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import githubDarkDefault from 'shiki/themes/github-dark-default.mjs'
import { CLASS_OF_COLOUR } from './code-colours'

export const CODE_THEME = githubDarkDefault.name!

const highlighter = createHighlighterCoreSync({
  // ES2018 patterns, not the `v`-flag ones Shiki picks by default: JavaScriptCore
  // (Safari, Bun) mismatches those, and TypeScript loses everything after an
  // arrow's `=>` (code-classes.test.ts).
  engine: createJavaScriptRegexEngine({ target: 'ES2018' }),
  themes: [githubDarkDefault],
  langs: [
    c,
    cpp,
    csharp,
    css,
    diff,
    docker,
    go,
    graphql,
    html,
    ini,
    java,
    javascript,
    json,
    jsx,
    kotlin,
    make,
    markdown,
    python,
    ruby,
    rust,
    scss,
    shellscript,
    sql,
    swift,
    toml,
    tsx,
    typescript,
    yaml,
  ],
})

/** Names, file extensions among them, that the grammars' own aliases leave out. */
const MORE_NAMES: Record<string, string> = {
  h: 'c',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  patch: 'diff',
  golang: 'go',
  htm: 'html',
  xml: 'html',
  cfg: 'ini',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  mk: 'make',
  mak: 'make',
  cmd: 'shellscript',
  console: 'shellscript',
}

const loaded = new Set(highlighter.getLoadedLanguages())

/** The grammar a fence's language, an alias or a file extension names; absent when none is loaded. */
export function languageOf(name: string): string | undefined {
  const key = name.trim().toLowerCase()
  const known = MORE_NAMES[key] ?? key
  return known && loaded.has(known)
    ? highlighter.getLanguage(known).name
    : undefined
}

/** A run of code: its text, where it starts in the code, and its class, absent for plain text. */
export type ClassedToken = { text: string; offset: number; class?: string }

const classOf = ({ color, fontStyle }: ThemedToken) => {
  const name = color && CLASS_OF_COLOUR[color.toLowerCase()]
  // FontStyle.Bold is 2.
  return name === 'number' && fontStyle && fontStyle & 2 ? 'heading' : name
}

/**
 * `code` as lines of classed tokens, in the grammar `lang` names (plain
 * text when it names none). Each offset in `breaks` splits the token it
 * falls in, so a caller can mark a range of the code.
 */
export function classedLines(
  code: string,
  lang: string,
  breaks: number[] = [],
): ClassedToken[][] {
  const grammar = languageOf(lang) ?? 'text'
  const lines = highlighter.codeToTokensBase(code, {
    lang: grammar,
    theme: CODE_THEME,
  })
  return splitTokens(lines, breaks).map((line) =>
    line.flatMap((token) => {
      if (!token.content) return []
      const name = classOf(token)
      return [
        name
          ? { text: token.content, offset: token.offset, class: name }
          : { text: token.content, offset: token.offset },
      ]
    }),
  )
}
