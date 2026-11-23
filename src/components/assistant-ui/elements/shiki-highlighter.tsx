// SOURCING: assistant-ui's shiki-highlighter element (registry item shiki-highlighter, https://www.assistant-ui.com/elements/shiki-highlighter; the owner's choice, 2026-11-23): react-shiki/core over Shiki's JavaScript regex engine, one highlighter per engine, languages and themes loaded on demand, the highlight-lines transformer, and the plain code while streaming. Changed: theme objects load as well as bundled names, because the default theme is the palette's code theme (lib/palette) with every colour kept readable on the palette's code ground (--surface-code) by Culori (lib/code-contrast), as the TanStack block did; @shikijs/transformers' render-whitespace marks spaces and tabs; this element's own line transformer numbers each row from the gutter lines it is given (code-lines.ts, which numbers a diff as its new file does), marks the rows a diff added or removed, and hangs a wrapped line under its indentation. The plain code renders the same rows, so settling is a colour change.
"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
  
  
} from "react";
import type { CSSProperties, FC } from "react";
import {
  useShikiHighlighter
  
} from "react-shiki/core";
import type { ShikiHighlighterProps } from "react-shiki/core";
import {
  createHighlighterCore,
  guessEmbeddedLanguages
  
  
  
  
  
} from "shiki/core";
import type {
  HighlighterCore,
  LanguageInput,
  ShikiTransformer,
  ThemeInput,
  ThemeRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import { transformerRenderWhitespace } from "@shikijs/transformers";
import { useTheme } from "next-themes";
import { useAppearance } from "@/lib/appearance";
import { readableCodeColor } from "@/lib/code-contrast";
import { useCodeThemes } from "@/lib/palette";
import { cn } from "@/lib/utils";
import type { GutterLine } from "./code-lines";

export type SyntaxHighlighterProps = Omit<
  ShikiHighlighterProps,
  "children" | "theme"
> & {
  /** A Shiki theme; the palette's code theme, readable on the code ground, when not given. */
  theme?: ShikiHighlighterProps["theme"];
  code: string;
  highlightLines?: readonly number[] | undefined;
  /** Numbers each row in the gutter. On unless the caller turns it off. */
  lineNumbers?: boolean;
  /** What the gutter shows beside each row; every row numbered from one when not given. */
  lines?: readonly GutterLine[] | undefined;
  /** Skips tokenization and renders the plain code while `true`. */
  streaming?: boolean;
};

/** Columns a tab advances, as the pre's tab-size draws it. */
const TAB_SIZE = 4;

/** The columns of a row's leading whitespace, which a wrapped row hangs under. */
const indentOf = (text: string) => {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += TAB_SIZE - (columns % TAB_SIZE);
    else break;
  }
  return columns;
};

type Row = { line?: GutterLine; text: string };

/** A row's gutter attributes: its number, how a diff changed it, and the indentation it hangs under. */
const rowData = ({ line, text }: Row, lineNumbers: boolean) => ({
  data: {
    ...(lineNumbers &&
      line?.number !== undefined && { "data-line": line.number }),
    ...(line?.change && { "data-change": line.change }),
  },
  indent: indentOf(text),
});

/** The widest number's digits, which size the gutter. */
const digitsOf = (lines: readonly GutterLine[]) =>
  String(Math.max(1, ...lines.map((line) => line.number ?? 0))).length;

const rowProps = (row: Row, lineNumbers: boolean) => {
  const { data, indent } = rowData(row, lineNumbers);
  return indent > 0
    ? { ...data, style: { "--indent": `${indent}ch` } as CSSProperties }
    : data;
};

/** The rows untokenized, with the gutter and whitespace marks the highlighted rows carry. */
const PlainCode: FC<{
  code: string;
  lines: readonly GutterLine[];
  lineNumbers: boolean;
}> = ({ code, lines, lineNumbers }) => (
  <pre
    data-line-numbers={lineNumbers ? "" : undefined}
    style={{ "--digits": digitsOf(lines) } as CSSProperties}
  >
    <code>
      {code.split("\n").map((text, index) => (
        <Fragment key={index}>
          {index > 0 && "\n"}
          <span
            className="line"
            {...rowProps({ line: lines[index], text }, lineNumbers)}
          >
          {text.split(/([ \t])/).map((part, at) =>
            part === " " ? (
              <span key={at} className="space">
                {" "}
              </span>
            ) : part === "\t" ? (
              <span key={at} className="tab">
                {"\t"}
              </span>
            ) : (
              part
            ),
          )}
          </span>
        </Fragment>
      ))}
    </code>
  </pre>
);

const textOf = (node: { type: string; value?: string; children?: unknown[] }): string =>
  node.type === "text"
    ? (node.value ?? "")
    : (node.children ?? [])
        .map((child) => textOf(child as Parameters<typeof textOf>[0]))
        .join("");

/** Numbers and marks each row from its gutter line, and hangs a wrapped row under its indentation. */
const createGutterTransformer = (
  lines: readonly GutterLine[],
  lineNumbers: boolean,
): ShikiTransformer => ({
  name: "theorem:gutter",
  pre(node) {
    if (lineNumbers) node.properties["data-line-numbers"] = "";
    node.properties.style = `${node.properties.style ?? ""};--digits:${digitsOf(lines)}`;
  },
  line(node, number) {
    const line = lines[number - 1];
    const text = textOf(node);
    // A hunk header is the diff's own text, not code in the file's language.
    if (line?.change === "hunk") node.children = [{ type: "text", value: text }];
    const { data, indent } = rowData({ line, text }, lineNumbers);
    Object.assign(node.properties, data);
    if (indent > 0) node.properties.style = `--indent:${indent}ch`;
    return node;
  },
});

const createHighlightedLinesTransformer = (
  highlightLines: readonly number[],
): ShikiTransformer => {
  const highlightedLines = new Set(highlightLines);

  return {
    name: "assistant-ui:highlight-lines",
    line(node, line) {
      if (highlightedLines.has(line)) {
        this.addClassToHast(node, "highlighted");
      }
      return node;
    },
  };
};

const whitespaceTransformer = transformerRenderWhitespace({ position: "all" });

type HighlighterOptions = Omit<
  ShikiHighlighterProps,
  "children" | "language" | "theme"
>;
type Engine = NonNullable<ShikiHighlighterProps["engine"]>;
type CodeProps = {
  code: string;
  language: SyntaxHighlighterProps["language"];
  theme: NonNullable<SyntaxHighlighterProps["theme"]>;
  options: HighlighterOptions;
  fallback: FC;
};

const namedEngines = {
  javascript: () => createJavaScriptRegexEngine(),
  oniguruma: () =>
    import("shiki/engine/oniguruma").then(({ createOnigurumaEngine }) =>
      createOnigurumaEngine(import("shiki/wasm")),
    ),
};
const namedEngineKeys = { javascript: {}, oniguruma: {} };

const highlighters = new WeakMap<object, Promise<HighlighterCore>>();
const attemptedLoads = new WeakMap<HighlighterCore, Set<unknown>>();

const getHighlighter = (engine: Engine) => {
  const key = typeof engine === "string" ? namedEngineKeys[engine] : engine;
  const cached = highlighters.get(key);
  if (cached) return cached;
  const highlighter = createHighlighterCore({
    engine: typeof engine === "string" ? namedEngines[engine]() : engine,
  });
  highlighters.set(key, highlighter);
  highlighter.catch(() => highlighters.delete(key));
  return highlighter;
};

const findBundled = <T,>(bundle: Record<string, T>, id: string) =>
  Object.hasOwn(bundle, id) ? bundle[id] : undefined;

type PendingLoad = {
  key: string;
  inputs: unknown[];
  langs: LanguageInput[];
  themes: ThemeInput[];
};

const isThemeObject = (theme: object) =>
  "tokenColors" in theme || "settings" in theme;

const findPendingLoad = (
  highlighter: HighlighterCore,
  { code, language, theme, options }: CodeProps,
): PendingLoad => {
  const attempted = attemptedLoads.get(highlighter);
  const loadedLangs = highlighter.getLoadedLanguages();
  const loadedThemes = highlighter.getLoadedThemes();
  const pending: PendingLoad = { key: "", inputs: [], langs: [], themes: [] };
  const isPending = (input: unknown, id: string, loaded: string[]) =>
    !loaded.includes(id) && !attempted?.has(input);
  const track = (input: unknown, id: string) => {
    pending.inputs.push(input);
    pending.key += `${id}|`;
  };

  const addBundledLanguage = (lang: string) => {
    const id = lang.trim();
    const target =
      Object.entries(options.langAlias ?? {}).find(
        ([alias]) => alias.toLowerCase() === id.toLowerCase(),
      )?.[1] ?? id;
    const bundled = findBundled(bundledLanguages, target);
    if (!bundled || !isPending(target, target, loadedLangs)) return;
    pending.langs.push(bundled);
    track(target, target);
  };

  for (const lang of [
    language,
    ...[options.preloadLanguages ?? []].flat(),
    ...[options.customLanguages ?? []].flat(),
  ]) {
    if (!lang) continue;
    if (typeof lang === "string") {
      addBundledLanguage(lang);
    } else if ("scopeName" in lang) {
      if (!isPending(lang, lang.name, loadedLangs)) continue;
      pending.langs.push(lang);
      track(lang, lang.name);
    } else if (!attempted?.has(lang)) {
      pending.langs.push(lang);
      track(lang, "*");
    }
  }
  if (typeof language === "string") {
    for (const embedded of guessEmbeddedLanguages(code, language)) {
      addBundledLanguage(embedded);
    }
  }

  const themes =
    typeof theme === "string" || isThemeObject(theme)
      ? [theme]
      : Object.values(theme);
  for (const input of themes) {
    if (typeof input === "string") {
      const bundled = findBundled(bundledThemes, input);
      if (!bundled || !isPending(input, input, loadedThemes)) continue;
      pending.themes.push(bundled);
      track(input, input);
    } else if (input && typeof input === "object" && "name" in input) {
      const name = String(input.name);
      if (!isPending(input, name, loadedThemes)) continue;
      pending.themes.push(input as ThemeRegistration);
      track(input, name);
    }
  }
  return pending;
};

/**
 * Keeps one Shiki highlighter per RegExp engine, unlike react-shiki's page-wide
 * singleton, so an explicit `engine` is honored. The JavaScript engine is the
 * default because the Oniguruma engine compiles WebAssembly, which a Content
 * Security Policy without 'wasm-unsafe-eval' blocks.
 */
const useEngineHighlighter = (engine: Engine, props: CodeProps) => {
  const [resolved, setResolved] = useState<{
    engine: Engine;
    highlighter: HighlighterCore;
  }>();
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [failedKey, setFailedKey] = useState<string>();

  useEffect(() => {
    let active = true;
    getHighlighter(engine).then(
      (highlighter) => {
        if (active) setResolved({ engine, highlighter });
      },
      (error: unknown) => {
        console.error("[shiki-highlighter] highlighter failed", error);
      },
    );
    return () => {
      active = false;
    };
  }, [engine]);

  const highlighter =
    resolved?.engine === engine ? resolved.highlighter : undefined;
  const pending = highlighter ? findPendingLoad(highlighter, props) : undefined;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    const load = pendingRef.current;
    if (!highlighter || !load?.key) return;
    const attempted = attemptedLoads.get(highlighter) ?? new Set();
    attemptedLoads.set(highlighter, attempted);
    Promise.all([
      highlighter.loadLanguage(...load.langs),
      highlighter.loadTheme(...load.themes),
    ]).then(
      () => {
        for (const input of load.inputs) attempted.add(input);
        rerender();
      },
      (error: unknown) => {
        console.error("[shiki-highlighter] loading failed", error);
        setFailedKey(load.key);
      },
    );
  }, [highlighter, pending?.key]);

  return pending?.key === "" || pending?.key === failedKey
    ? highlighter
    : undefined;
};

const ShikiCode: FC<CodeProps> = ({
  code,
  language,
  theme,
  options,
  fallback: Fallback,
}) => {
  const highlighted = useShikiHighlighter(code, language, theme, {
    ...options,
    defaultColor: "light-dark()",
  });
  return <>{highlighted ?? <Fallback />}</>;
};

const EngineCode: FC<CodeProps & { engine: Engine }> = ({
  engine,
  ...props
}) => {
  const highlighter = useEngineHighlighter(engine, props);
  if (!highlighter) return <props.fallback />;
  return <ShikiCode {...props} options={{ ...props.options, highlighter }} />;
};

const HighlightedCode: FC<CodeProps> = (props) => {
  const { engine = "javascript", highlighter, ...options } = props.options;
  if (highlighter) return <ShikiCode {...props} />;
  return <EngineCode {...props} options={options} engine={engine} />;
};

type RawTheme = ThemeRegistration & {
  colors?: Record<string, string>;
  tokenColors?: { settings?: { foreground?: string } }[];
};

/** One readable copy of a bundled theme per surface colour, shared by every block. */
const readableThemes = new Map<string, Promise<ThemeRegistration>>();
const readableTheme = (name: string, background: string) => {
  const key = `${name} on ${background}`;
  let theme = readableThemes.get(key);
  if (!theme) {
    const bundled =
      findBundled(bundledThemes, name) ??
      bundledThemes["github-light-default"];
    theme = bundled().then(({ default: base }) => {
      const raw = base as RawTheme;
      const readable = (color: string | undefined) =>
        color && readableCodeColor(color, background);
      return {
        ...raw,
        name: key,
        colors: Object.fromEntries(
          Object.entries(raw.colors ?? {}).map(([slot, color]) => [
            slot,
            slot === "editor.foreground" ? readable(color) : color,
          ]),
        ),
        tokenColors: raw.tokenColors?.map((rule) => ({
          ...rule,
          settings: {
            ...rule.settings,
            ...(rule.settings?.foreground && {
              foreground: readable(rule.settings.foreground),
            }),
          },
        })),
      } as ThemeRegistration;
    });
    readableThemes.set(key, theme);
    theme.catch(() => readableThemes.delete(key));
  }
  return theme;
};

/**
 * The palette's code theme with every token readable on the code ground
 * (--surface-code) the block is painted on, read once the palette's variables apply.
 */
function usePaletteTheme(enabled: boolean) {
  const palette = useAppearance((state) => state.appearance.palette);
  const preset = useAppearance((state) => state.appearance.preset);
  const customPalette = useAppearance(
    (state) => state.appearance.customPalette,
  );
  const codeThemes = useCodeThemes();
  const { resolvedTheme } = useTheme();
  const source = useMemo(
    () => ({ palette, preset, customPalette, resolvedTheme, codeThemes }),
    [palette, preset, customPalette, resolvedTheme, codeThemes],
  );
  const [theme, setTheme] = useState<{
    source: typeof source;
    theme: ThemeRegistration;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // After this commit's effects, the palette's own among them, have set its
    // variables; a timer, unlike a frame, also runs in a background tab.
    const timer = setTimeout(() => {
      const root = document.documentElement;
      const background = getComputedStyle(root)
        .getPropertyValue("--surface-code")
        .trim();
      const dark = root.classList.contains("dark");
      readableTheme(
        dark ? codeThemes.dark : codeThemes.light,
        background || (dark ? "#000000" : "#ffffff"),
      ).then(
        (ready) => active && setTheme({ source, theme: ready }),
        (error: unknown) =>
          console.error("[shiki-highlighter] theme failed to load", error),
      );
    });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, source, codeThemes]);
  return theme?.source === source ? theme.theme : undefined;
}

/**
 * SyntaxHighlighter component, using react-shiki
 *
 * Skips tokenization while `streaming`, or before the theme has loaded, and
 * renders the same rows untokenized, so streaming costs no Shiki work and
 * settling is a colour change rather than a layout shift.
 */
export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  code,
  language,
  theme: themeProp,
  className,
  style,
  // Inert: useShikiHighlighter output has no default styles or language label.
  addDefaultStyles: _addDefaultStyles,
  showLanguage: _showLanguage,
  delay = 150, // the part settles before smooth streaming finishes draining, so code keeps changing for a few frames
  streaming = false,
  highlightLines,
  lineNumbers = true,
  lines: linesProp,
  ...options
}) => {
  // Given gutter lines name the rows as they are; plain code drops the blank lines around it.
  const trimmed = linesProp ? code : code.replace(/^\n+|\s+$/g, "");
  const lines = useMemo(
    () =>
      linesProp ??
      trimmed.split("\n").map((_, index) => ({ number: index + 1 })),
    [linesProp, trimmed],
  );
  const paletteTheme = usePaletteTheme(themeProp === undefined);
  const theme = themeProp ?? paletteTheme;
  const highlightKey = highlightLines?.join(",") ?? "";
  const callerTransformers = options.transformers;
  const transformers = useMemo(
    () => [
      ...(callerTransformers ?? []),
      createGutterTransformer(lines, lineNumbers),
      whitespaceTransformer,
      ...(highlightKey
        ? [createHighlightedLinesTransformer(highlightKey.split(",").map(Number))]
        : []),
    ],
    [highlightKey, callerTransformers, lines, lineNumbers],
  );
  const fallback = useMemo<FC>(
    () =>
      function Plain() {
        return (
          <PlainCode code={trimmed} lines={lines} lineNumbers={lineNumbers} />
        );
      },
    [trimmed, lines, lineNumbers],
  );

  return (
    <div
      className={cn("aui-shiki", streaming && "aui-shiki-streaming", className)}
      style={style}
    >
      {streaming || !theme ? (
        <PlainCode code={trimmed} lines={lines} lineNumbers={lineNumbers} />
      ) : (
        <HighlightedCode
          code={trimmed}
          language={language}
          theme={theme}
          fallback={fallback}
          options={{ ...options, delay, transformers }}
        />
      )}
    </div>
  );
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
