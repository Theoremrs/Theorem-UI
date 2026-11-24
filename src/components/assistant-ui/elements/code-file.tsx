"use client";

import { useMemo } from "react";
import type { FC } from "react";
import { CodeBlock } from "@/components/ui/code-block";
import { diffLines, plainLines } from "./code-lines";
import { SyntaxHighlighter } from "./shiki-highlighter";

export type CodeFileProps = {
  code: string;
  /** The fence's language; `rust:src/main.rs` also names the file, and `diff` or `patch` reads a unified diff. */
  language?: string | undefined;
  /** The header's path or label; the file a fence or diff names, else the language, when not given. */
  title?: string | undefined;
  lineNumbers?: boolean;
  streaming?: boolean;
  maxCollapsedLines?: number;
  className?: string;
  viewportClassName?: string;
};

const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);

/**
 * A file's code as an editor pane shows it: its path over numbered rows. A
 * diff shows the changed file in its own language, numbered as the new file
 * numbers it, with a bar beside each added or removed row; copy takes the
 * diff as written.
 */
export const CodeFile: FC<CodeFileProps> = ({
  code,
  language,
  title,
  lineNumbers = true,
  streaming = false,
  maxCollapsedLines,
  className,
  viewportClassName,
}) => {
  const [lang = "", named] = (language ?? "").split(/:(.+)/);
  const isDiff = DIFF_LANGUAGES.has(lang.toLowerCase());
  const read = useMemo(
    () => (isDiff ? diffLines(code) : plainLines(code)),
    [isDiff, code],
  );
  const label = title ?? named ?? read.path ?? (lang || undefined);
  return (
    <CodeBlock
      title={label}
      copyText={code}
      maxCollapsedLines={maxCollapsedLines}
      className={className}
      viewportClassName={viewportClassName}
      data-diff={isDiff ? "" : undefined}
    >
      <SyntaxHighlighter
        code={read.text}
        lines={read.lines}
        language={isDiff ? (read.language ?? "text") : lang || "text"}
        lineNumbers={lineNumbers}
        streaming={streaming}
      />
    </CodeBlock>
  );
};

CodeFile.displayName = "CodeFile";
