"use client";

import type { FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps as AUIProps } from "@assistant-ui/react-markdown";
import { GlassCodeBlock } from "./glass-code-block";
import type { GlassCodeBlockProps as BaseProps } from "./glass-code-block";

export type HighlighterProps = Omit<BaseProps, "code" | "language"> &
  Pick<AUIProps, "language" | "code"> &
  Partial<Pick<AUIProps, "node" | "components">>;

/**
 * The reply's code blocks, passed to `defaultComponents` in markdown-text.tsx:
 * the glass code block, which carries its own header and copy action.
 * Skips tokenization while the message part streams, so streaming costs no
 * highlighting work and settling is a colour change rather than a layout shift.
 */
export const SyntaxHighlighter: FC<HighlighterProps> = ({
  node: _node,
  components: _components,
  ...props
}) => {
  const isStreaming = useAuiState(
    (s) => s.optional.part?.status.type === "running",
  );

  return <GlassCodeBlock {...props} streaming={isStreaming} />;
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
