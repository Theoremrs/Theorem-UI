// SOURCING: translated from the 21st.dev Glass Code Block by framecn (https://21st.dev/@framecn/components/glass-code-block, registry item framecn/glass-code-block; the owner's choice, 2026-11-16). Kept: its structure, a 1px frame lit from the top and fading down, around a frosted pane with a lit inner top edge; a 40px chrome row with the three window lights at 60% and the title centred in small, slightly tracked type over a hairline; a numbered body with a narrow number column, roomier padding, 1.55 line height and a little air between lines. Changed: the frost, tint, rim and shadow are this app's glass (--glass-* in styles.css, so it follows the palette in both themes) at a chat block's scale instead of a 1280x720 video frame's, with corners on the artifact radius token so it matches messages, artifacts and the composer; the source's regex tokenizer and fixed colours give way to TanStack Highlight through code-highlighter.tsx (the owner's earlier choice), which keeps every token readable on the palette; the title is the fence's language; a copy action joins the chrome; the editframe Timegroup and the per-line entrance are left out, because a block in a reply re-renders as it streams and remounts as the thread scrolls, so a staggered entrance would replay and hold long files back from being read.
"use client";

import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icons";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { SyntaxHighlighter } from "./code-highlighter";
import type { SyntaxHighlighterProps } from "./code-highlighter";

const LIGHTS = ["#ff5f57", "#febc2e", "#28c840"] as const;

export type GlassCodeBlockProps = SyntaxHighlighterProps & {
  /** The chrome's title; the language when not given. */
  title?: string;
  /** Classes for the frame, around the chrome and the code. */
  frameClassName?: string;
};

/** A code block as a pane of the app's glass: window chrome over numbered, highlighted code. */
export const GlassCodeBlock: FC<GlassCodeBlockProps> = ({
  title,
  frameClassName,
  ...code
}) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard({
    copiedDuration: 1500,
  });
  const label = title ?? code.language ?? "text";
  return (
    <figure
      data-glass-code=""
      className={cn(
        "aui-glass-code relative my-3 min-w-0 rounded-(--appearance-radius-artifact) bg-linear-to-b from-(--glass-code-rim) to-(--glass-code-rim-low) p-px shadow-(--glass-code-shadow)",
        frameClassName,
      )}
    >
      <div className="flex flex-col overflow-hidden rounded-[calc(var(--appearance-radius-artifact)-1px)] bg-(--glass-code-tint) shadow-[inset_0_1px_0_var(--glass-code-inner)] backdrop-blur-(--glass-code-blur) backdrop-saturate-(--glass-saturate)">
        <div className="relative flex h-10 shrink-0 items-center gap-2 border-b border-(--glass-code-line) px-4">
          {LIGHTS.map((color) => (
            <span
              key={color}
              aria-hidden="true"
              className="size-3 rounded-full opacity-60"
              style={{ background: color }}
            />
          ))}
          <figcaption
            data-appearance-recipe="metadata"
            className="aui-code-header-language flex-1 truncate px-16 text-center font-mono text-xs tracking-[0.02em] text-ink-muted lowercase"
          >
            {label}
          </figcaption>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              if (code.code && !isCopied) copyToClipboard(code.code);
            }}
            aria-label={isCopied ? "Copied" : "Copy code"}
            className="absolute end-2 text-ink-muted"
          >
            {isCopied ? (
              <Icon.Copied className="animate-in fade-in zoom-in-30 -spin-in-20 ease-lift duration-(--duration-lift)" />
            ) : (
              <Icon.Copy className="animate-in fade-in zoom-in-75" />
            )}
            {isCopied ? "copied!" : "copy"}
          </Button>
        </div>
        <SyntaxHighlighter {...code} surface="glass" />
      </div>
    </figure>
  );
};

GlassCodeBlock.displayName = "GlassCodeBlock";
