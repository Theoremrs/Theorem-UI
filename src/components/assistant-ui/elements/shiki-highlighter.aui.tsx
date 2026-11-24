"use client";

import { memo } from "react";
import type { FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps as AUIProps } from "@assistant-ui/react-markdown";
import { CodeFile } from "./code-file";
import { fenceTitle } from "./code-lines";
import type { CodeFileProps } from "./code-file";

export type HighlighterProps = Omit<CodeFileProps, "code" | "language"> &
  Pick<AUIProps, "language" | "code"> &
  Partial<Pick<AUIProps, "node" | "components">>;

/** The fence's info string after its language, which remark keeps on the code element's data. */
const metaOf = (node: AUIProps["node"]) => {
  const meta = (node as { data?: { meta?: unknown } } | undefined)?.data?.meta;
  return typeof meta === "string" ? meta : undefined;
};

/**
 * The reply's code blocks, passed to `defaultComponents` in markdown-text.tsx
 * beside the memoized components rather than among them, since
 * memoizeMarkdownComponents drops the `node` that carries the fence's file.
 * Skips tokenization while the message part is streaming and renders the
 * plain rows in the same block, so streaming costs no Shiki work and
 * settling is a colour change rather than a layout shift.
 */
const SyntaxHighlighterImpl: FC<HighlighterProps> = ({
  node,
  components: _components,
  ...props
}) => {
  const isStreaming = useAuiState(
    (s) => s.optional.part?.status.type === "running",
  );
  return (
    <CodeFile
      title={fenceTitle(metaOf(node))}
      {...props}
      streaming={isStreaming}
    />
  );
};

/**
 * Whether two fences render the same block: the code, its language and file,
 * and every prop the block forwards. The node changes identity on each parse;
 * only its meta matters. Streaming is the part's own status, not a caller prop.
 */
export const sameHighlighterProps = (
  prev: HighlighterProps,
  next: HighlighterProps,
) =>
  prev.code === next.code &&
  prev.language === next.language &&
  metaOf(prev.node) === metaOf(next.node) &&
  prev.title === next.title &&
  prev.lineNumbers === next.lineNumbers &&
  prev.maxCollapsedLines === next.maxCollapsedLines &&
  prev.className === next.className &&
  prev.viewportClassName === next.viewportClassName;

export const SyntaxHighlighter = memo(
  SyntaxHighlighterImpl,
  sameHighlighterProps,
);

SyntaxHighlighter.displayName = "SyntaxHighlighter";
