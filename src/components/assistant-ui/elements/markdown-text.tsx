"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock
} from "@assistant-ui/react-markdown";
import type { CodeHeaderProps, MarkdownTextPrimitiveProps } from "@assistant-ui/react-markdown";
import {
  escapeCurrencyDollars,
  normalizeMathDelimiters,
} from "@assistant-ui/react-markdown/preprocess";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { memo, useMemo, useRef } from "react";
import type { FC } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";

import { MermaidDiagram } from "@/components/assistant-ui/elements/mermaid-diagram.aui";
import { SyntaxHighlighter } from "@/components/assistant-ui/elements/shiki-highlighter.aui";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icons";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { appearancePair } from "@/lib/appearance-policy";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
  componentsByLanguage?: MarkdownTextPrimitiveProps["componentsByLanguage"];
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

// Fenced mermaid blocks render as diagrams under the plain header; every
// other fence is a code block, whose chrome is its header.
const defaultComponentsByLanguage: MarkdownTextPrimitiveProps["componentsByLanguage"] = {
  mermaid: { SyntaxHighlighter: MermaidDiagram, CodeHeader: (props) => <PlainCodeHeader {...props} /> },
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({
  components,
  componentsByLanguage,
}) => {
  const stableComponents = useShallowStable(components);
  const stableComponentsByLanguage = useShallowStable(componentsByLanguage);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      preprocess={preprocessMath}
      className="aui-md"
      components={markdownComponents}
      componentsByLanguage={stableComponentsByLanguage ?? defaultComponentsByLanguage}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

// Models emit \( \) and \[ \] as often as dollars; prices in prose are not math.
const preprocessMath = (text: string) =>
  normalizeMathDelimiters(escapeCurrencyDollars(text));

/** The code block draws its own chrome, so a fence's separate header is empty. */
export const CodeHeader: FC<CodeHeaderProps> = () => null;

/** The header over a block that is not code: a mermaid diagram's language and copy. */
const PlainCodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard({
    copiedDuration: 1500,
  });
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root border-separator bg-raised mt-3 flex items-center justify-between rounded-t-lg border border-b-0 py-1 ps-3.5 pe-1 text-xs">
      <span data-appearance-recipe="metadata" {...appearancePair("secondary", "popover")} className="aui-code-header-language text-ink-muted font-mono lowercase">
        {language}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={onCopy}
        aria-label={isCopied ? "Copied" : "Copy code"}
        className="text-ink-muted"
      >
        {isCopied ? (
          <Icon.Copied className="animate-in fade-in zoom-in-30 -spin-in-20 ease-lift duration-(--duration-lift)" />
        ) : (
          <Icon.Copy className="animate-in fade-in zoom-in-75" />
        )}
        {isCopied ? "copied!" : "copy"}
      </Button>
    </div>
  );
};

/** Inline code longer than this many characters reads as a diagnostic block. */
const DIAGNOSTIC_LENGTH = 72;

const defaultComponents = {
  ...memoizeMarkdownComponents({
    h1: ({ className, ...props }) => (
      <h1
        data-appearance-recipe="heading.large"
        className={cn(
          "aui-md-h1",
          className,
        )}
        {...props}
      />
    ),
    h2: ({ className, ...props }) => (
      <h2
        data-appearance-recipe="heading.medium"
        className={cn(
          "aui-md-h2",
          className,
        )}
        {...props}
      />
    ),
    h3: ({ className, ...props }) => (
      <h3
        data-appearance-recipe="heading.small"
        className={cn(
          "aui-md-h3",
          className,
        )}
        {...props}
      />
    ),
    h4: ({ className, ...props }) => (
      <h4
        data-appearance-recipe="heading.small"
        className={cn(
          "aui-md-h4",
          className,
        )}
        {...props}
      />
    ),
    h5: ({ className, ...props }) => (
      <h5
        data-appearance-recipe="heading.small"
        className={cn(
          "aui-md-h5",
          className,
        )}
        {...props}
      />
    ),
    h6: ({ className, ...props }) => (
      <h6
        data-appearance-recipe="heading.small"
        className={cn(
          "aui-md-h6",
          className,
        )}
        {...props}
      />
    ),
    p: ({ className, ...props }) => (
      <p
        data-appearance-recipe="prose"
        data-appearance-part="prose-block"
        {...appearancePair("primary", "assistant-reading")}
        className={cn(
          "aui-md-p",
          className,
        )}
        {...props}
      />
    ),
    a: ({ className, ...props }) => (
      <a
        {...appearancePair("link", "assistant-reading")}
        className={cn(
          "aui-md-a text-link decoration-link/40 hover:decoration-link underline underline-offset-2",
          className,
        )}
        {...props}
      />
    ),
    blockquote: ({ className, ...props }) => (
      <blockquote
        className={cn(
          "aui-md-blockquote border-separator text-ink-muted my-3 border-s-2 ps-4",
          className,
        )}
        {...props}
      />
    ),
    ul: ({ className, ...props }) => (
      <ul
        className={cn(
          "aui-md-ul marker:text-ink-faint my-3 ms-5 list-disc [&>li]:mt-1",
          className,
        )}
        {...props}
      />
    ),
    ol: ({ className, ...props }) => (
      <ol
        className={cn(
          "aui-md-ol marker:text-ink-faint my-3 ms-5 list-decimal [&>li]:mt-1",
          className,
        )}
        {...props}
      />
    ),
    hr: ({ className, ...props }) => (
      <hr
        className={cn("aui-md-hr border-separator my-5", className)}
        {...props}
      />
    ),
    // A table stays inside the prose column on its own opaque surface and
    // scrolls sideways in its own region (shadcn Table's container).
    table: ({ className, ...props }) => (
      <div className="aui-md-table-wrapper">
        <Table className={cn("aui-md-table", className)} {...props} />
      </div>
    ),
    thead: ({ className, ...props }) => (
      <TableHeader className={cn("aui-md-thead", className)} {...props} />
    ),
    tbody: ({ className, ...props }) => (
      <TableBody className={cn("aui-md-tbody", className)} {...props} />
    ),
    th: ({ className, ...props }) => (
      <TableHead
        data-appearance-recipe="ui.section"
        {...appearancePair("primary", "popover")}
        className={cn(
          "aui-md-th text-ink h-auto px-3 py-2 align-bottom whitespace-normal [[align=center]]:text-center [[align=right]]:text-right",
          className,
        )}
        {...props}
      />
    ),
    td: ({ className, ...props }) => (
      <TableCell
        {...appearancePair("primary", "popover")}
        className={cn(
          "aui-md-td px-3 py-2 align-top whitespace-normal [[align=center]]:text-center [[align=right]]:text-right",
          className,
        )}
        {...props}
      />
    ),
    tr: ({ className, ...props }) => (
      <TableRow
        className={cn("aui-md-tr border-separator hover:bg-transparent", className)}
        {...props}
      />
    ),
    li: ({ className, ...props }) => (
      <li className={cn("aui-md-li leading-6", className)} {...props} />
    ),
    strong: ({ className, ...props }) => (
      <strong
        className={cn("aui-md-strong font-semibold", className)}
        {...props}
      />
    ),
    sup: ({ className, ...props }) => (
      <sup
        className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
        {...props}
      />
    ),
    pre: ({ className, ...props }) => (
      <pre
        data-appearance-recipe="code"
        className={cn(
          "aui-md-pre border-separator bg-popover overflow-x-auto rounded-t-none rounded-b-lg border border-t-0 p-3.5 text-[13px] leading-relaxed",
          className,
        )}
        {...props}
      />
    ),
    code: function Code({ className, children, ...props }) {
      const isCodeBlock = useIsMarkdownCodeBlock();
      if (isCodeBlock)
        return (
          <code
            data-appearance-recipe="code"
            {...appearancePair("primary", "popover")}
            className={className}
            {...props}
          >
            {children}
          </code>
        );
      // A long string in backticks (an error, a path, a command line) is a
      // diagnostic: it gets a contained block of its own instead of running
      // through the sentence.
      if (typeof children === "string" && children.length > DIAGNOSTIC_LENGTH)
        return (
          <code
            data-appearance-recipe="code"
            data-diagnostic=""
            {...appearancePair("primary", "popover")}
            className={cn("aui-md-diagnostic", className)}
            {...props}
          >
            {children}
          </code>
        );
      return (
        <code
          {...appearancePair("code", "assistant-reading")}
          className={cn("aui-md-inline-code", className)}
          {...props}
        >
          {children}
        </code>
      );
    },
    CodeHeader,
  }),
  SyntaxHighlighter,
};
