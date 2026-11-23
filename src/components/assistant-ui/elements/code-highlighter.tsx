// SOURCING: @tanstack/highlight (the owner's choice, 2026-11-16): its synchronous highlighter over its own language definitions, loaded once in their own chunk; renderTokens for the line-numbered node tree; createThemeBaseCss and createThemeRule for the th-* token classes and each theme's colour variables; its GitHub themes, and Vitesse as a theme object from the colours codemirror-theme-vitesse (MIT) paints, since Highlight ships no Vitesse. The line-number column follows the owner's pasted CodeBlock component. Culori (lib/code-contrast) keeps every token colour readable on the palette's code surface, as the Shiki transformer did.
"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FC } from "react";
import { createHighlighter, renderTokens } from "@tanstack/highlight/core";
import type {
  Highlighter,
  HighlightRenderNode,
  HighlightToken,
} from "@tanstack/highlight/core";
import {
  createThemeBaseCss,
  createThemeRule,
} from "@tanstack/highlight/theme";
import type { HighlightTheme } from "@tanstack/highlight/theme";
import { githubDarkTheme } from "@tanstack/highlight/themes/github-dark";
import { githubLightTheme } from "@tanstack/highlight/themes/github-light";
import { useTheme } from "next-themes";
import { useAppearance } from "@/lib/appearance";
import { appearancePair } from "@/lib/appearance-policy";
import { readableCodeColor } from "@/lib/code-contrast";
import { useCodeThemes } from "@/lib/palette";
import { cn } from "@/lib/utils";

export type SyntaxHighlighterProps = {
  code: string;
  /** A language name or alias; one Highlight does not know reads as plain text. */
  language?: string;
  className?: string;
  style?: CSSProperties;
  /** One-based lines to mark. */
  highlightLines?: readonly number[] | undefined;
  /** Numbers each line in a column of its own. On unless the caller turns it off. */
  lineNumbers?: boolean;
  /** Skips tokenization and renders the plain code while `true`. */
  streaming?: boolean;
  /**
   * `panel` paints the pre as its own opaque surface under a separate header;
   * `glass` leaves it clear inside the glass code block's pane.
   */
  surface?: "panel" | "glass";
};

/** Vitesse's colours as codemirror-theme-vitesse paints them, by Highlight's token classes. */
const vitesseLightTheme: HighlightTheme = {
  name: "vitesse-light",
  type: "light",
  background: "#ffffff",
  foreground: "#393a34",
  tokens: {
    token: "#393a34",
    attr: "#b07d48",
    "code-inline": "#b56959",
    command: "#59873a",
    comment: "#a0ada0",
    deleted: "#b31d28",
    function: "#59873a",
    heading: "#393a34",
    inserted: "#1e754f",
    keyword: "#ab5959",
    link: "#2e808f",
    literal: "#1e754f",
    meta: "#b56959",
    number: "#b07d48",
    operator: "#ab5959",
    property: "#2e8f82",
    selector: "#1e754f",
    string: "#b56959",
    tag: "#1e754f",
    type: "#2e8f82",
    variable: "#59873a",
  },
};
const vitesseDarkTheme: HighlightTheme = {
  name: "vitesse-dark",
  type: "dark",
  background: "#121212",
  foreground: "#dbd7ca",
  tokens: {
    token: "#dbd7ca",
    attr: "#bd976a",
    "code-inline": "#c98a7d",
    command: "#80a665",
    comment: "#758575",
    deleted: "#fdaeb7",
    function: "#80a665",
    heading: "#dbd7ca",
    inserted: "#4d9375",
    keyword: "#cb7676",
    link: "#5d99a9",
    literal: "#4d9375",
    meta: "#c98a7d",
    number: "#bd976a",
    operator: "#cb7676",
    property: "#5da994",
    selector: "#4d9375",
    string: "#c98a7d",
    tag: "#4d9375",
    type: "#5da994",
    variable: "#80a665",
  },
};

/** Highlight's theme for each code theme a palette names (PALETTES.code, which the diffs read too). */
const THEMES: Record<string, HighlightTheme> = {
  "github-light-default": githubLightTheme,
  "github-dark-default": githubDarkTheme,
  "vitesse-light": vitesseLightTheme,
  "vitesse-dark": vitesseDarkTheme,
};

const BASE_CSS = createThemeBaseCss({
  codeBlockSelector: ".aui-code-block pre.th-code",
  lineNumbersSelector: ".aui-code-block .th-code--line-numbers",
});

/** One highlighter for the page, made once its languages have loaded. */
let loading: Promise<Highlighter> | undefined;
let loaded: Highlighter | undefined;
const loadHighlighter = () =>
  (loading ??= import("@tanstack/highlight/languages").then((languages) => {
    loaded = createHighlighter({
      languages: Object.values(languages),
      fallbackLanguage: "plaintext",
    });
    return loaded;
  }));

function useHighlighter() {
  const [highlighter, setHighlighter] = useState(loaded);
  useEffect(() => {
    if (highlighter) return;
    let active = true;
    loadHighlighter().then(
      (ready) => active && setHighlighter(ready),
      (error: unknown) =>
        console.error("[code-highlighter] languages failed to load", error),
    );
    return () => {
      active = false;
    };
  }, [highlighter]);
  return highlighter;
}

/** A colour variable as the browser resolves it on the root. */
function resolvedColor(root: HTMLElement, variable: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.display = "none";
  root.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/**
 * The palette's code theme with every token made readable on the code
 * surface the pre is painted on, read once the palette's variables apply.
 * The panel paints an opaque popover; the glass block is a translucent tint
 * of the sheet's bottom colour over the sheet, so its tokens must also read
 * on that colour (light stone's sheet is far darker than its popover).
 */
function useCodeTheme(surface: "panel" | "glass") {
  const palette = useAppearance((state) => state.appearance.palette);
  const preset = useAppearance((state) => state.appearance.preset);
  const customPalette = useAppearance(
    (state) => state.appearance.customPalette,
  );
  const codeThemes = useCodeThemes();
  const { resolvedTheme } = useTheme();
  const source = useMemo(
    () => ({ palette, preset, customPalette, resolvedTheme }),
    [palette, preset, customPalette, resolvedTheme],
  );
  const [paint, setPaint] = useState<{
    source: typeof source;
    background: string;
    glass: string;
    dark: boolean;
  }>();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = document.documentElement;
      setPaint({
        source,
        background: getComputedStyle(root).getPropertyValue("--popover").trim(),
        glass: resolvedColor(root, "--sheet-to"),
        dark: root.classList.contains("dark"),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [source]);
  return useMemo(() => {
    if (paint?.source !== source || !paint.background) return undefined;
    const named = paint.dark ? codeThemes.dark : codeThemes.light;
    const base =
      THEMES[named] ?? (paint.dark ? githubDarkTheme : githubLightTheme);
    const surfaces =
      surface === "glass" && paint.glass
        ? [paint.glass, paint.background]
        : [paint.background];
    const readable = (color: string) =>
      surfaces.reduce(readableCodeColor, color);
    const theme: HighlightTheme = {
      ...base,
      foreground: readable(base.foreground),
      tokens: Object.fromEntries(
        Object.entries(base.tokens).map(([token, color]) => [
          token,
          readable(color),
        ]),
      ) as HighlightTheme["tokens"],
    };
    const key = `${base.name} ${surfaces.join(" ")}`;
    return {
      key,
      css: createThemeRule(`.aui-code-block[data-code-theme="${key}"]`, theme),
    };
  }, [paint, source, codeThemes, surface]);
}

const RenderNode: FC<{ node: HighlightRenderNode }> = ({ node }) => {
  if (node.type === "text") return node.value;
  const data = Object.fromEntries(
    Object.entries(node.data ?? {}).map(([name, value]) => [
      `data-${name}`,
      value,
    ]),
  );
  return (
    <span className={node.classNames.join(" ")} {...data}>
      {node.children.map((child, index) => (
        <RenderNode key={index} node={child} />
      ))}
    </span>
  );
};

const containerClassName = {
  panel:
    "aui-code-block [&_pre]:border-separator [&_pre]:bg-popover! [&_pre]:overflow-x-auto [&_pre]:rounded-t-none [&_pre]:rounded-b-lg [&_pre]:border [&_pre]:border-t-0 [&_pre]:p-3.5 [&_pre]:text-[13px] [&_pre]:leading-relaxed",
  glass:
    "aui-code-block [&_pre]:bg-transparent! [&_pre]:overflow-x-auto [&_pre]:m-0 [&_pre]:rounded-none [&_pre]:border-0 [&_pre]:px-4 [&_pre]:py-2.5 [&_pre]:text-[13px] [&_pre]:leading-[1.5]",
} as const;

/**
 * Code in the palette's colours, through TanStack Highlight.
 *
 * While `streaming`, or before the languages have loaded, the same lines
 * render untokenized in the same pre, so settling is a colour change rather
 * than a layout shift.
 */
export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  code,
  language,
  className,
  style,
  highlightLines,
  lineNumbers = true,
  streaming = false,
  surface = "panel",
}) => {
  const highlighter = useHighlighter();
  const theme = useCodeTheme(surface);
  const trimmed = code.trim();
  const tokenize = !streaming && highlighter !== undefined;
  const lang = highlighter?.normalizeLanguage(language) ?? "plaintext";
  const highlightKey = highlightLines?.join(",") ?? "";
  const nodes = useMemo(() => {
    const tokens: HighlightToken[] = tokenize
      ? highlighter.tokenize(trimmed, { lang }).tokens
      : [{ value: trimmed }];
    const decorations = highlightKey
      ? highlightKey
          .split(",")
          .map((line) => ({ lines: Number(line), className: "highlighted" }))
      : undefined;
    return renderTokens(tokens, { lineNumbers, decorations });
  }, [tokenize, highlighter, trimmed, lang, lineNumbers, highlightKey]);

  return (
    <div
      className={cn(
        containerClassName[surface],
        streaming && "aui-code-streaming",
        className,
      )}
      data-code-theme={theme?.key}
      data-code-surface={surface}
      style={style}
    >
      <style href="tanstack-highlight-base" precedence="medium">
        {BASE_CSS}
      </style>
      {theme && (
        <style href={`tanstack-highlight ${theme.key}`} precedence="medium">
          {theme.css}
        </style>
      )}
      <pre
        className={cn(
          "th-code",
          `th-code--${lang}`,
          lineNumbers && "th-code--line-numbers",
        )}
        data-language={lang}
        data-appearance-recipe="code"
        {...appearancePair("code", "popover")}
      >
        <code>
          {nodes.map((node, index) => (
            <RenderNode key={index} node={node} />
          ))}
        </code>
      </pre>
    </div>
  );
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
