'use client'

import '@assistant-ui/react-markdown/styles/dot.css'

import {
  MarkdownTextPrimitive,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown'
import type {
  CodeHeaderProps,
  MarkdownTextPrimitiveProps,
  SyntaxHighlighterProps,
} from '@assistant-ui/react-markdown'
import { memo, useMemo, useRef } from 'react'
import type { FC } from 'react'
import type { TextMessagePartProps } from '@assistant-ui/react'

import { MermaidDiagram } from '@/components/assistant-ui/elements/mermaid-diagram.aui'
import { SyntaxHighlighter } from '@/components/assistant-ui/elements/shiki-highlighter.aui'
import { bareDrawing } from '@/components/assistant-ui/elements/surfaces'
import {
  InlineCode,
  MARKDOWN_REMARK,
  markdownElements,
  markdownRehype,
  preprocessMarkdown,
} from '@/components/chat/markdown-elements'
import { cn } from '@/lib/utils'
import { appearancePair } from '@/lib/appearance-policy'

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0]
  componentsByLanguage?: MarkdownTextPrimitiveProps['componentsByLanguage']
}

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value)
  if (value !== ref.current) {
    const prev = ref.current
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key])
    if (!stable) ref.current = value
  }
  return ref.current
}

/** A fenced mermaid block is the drawing alone, in line with the reply's text;
 * the document rhythm spaces it. */
const MermaidFence: FC<SyntaxHighlighterProps> = (props) => (
  <MermaidDiagram {...props} className={bareDrawing} />
)

// Fenced mermaid blocks render as diagrams with no header, box or fill; every
// other fence is a code block, whose chrome is its header.
const defaultComponentsByLanguage: MarkdownTextPrimitiveProps['componentsByLanguage'] =
  {
    mermaid: { SyntaxHighlighter: MermaidFence, CodeHeader: () => null },
  }

const ASSISTANT_REHYPE = markdownRehype('assistant')

const MarkdownTextImpl: FC<MarkdownTextProps> = ({
  components,
  componentsByLanguage,
}) => {
  const stableComponents = useShallowStable(components)
  const stableComponentsByLanguage = useShallowStable(componentsByLanguage)
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    }
  }, [stableComponents])

  return (
    <MarkdownTextPrimitive
      remarkPlugins={MARKDOWN_REMARK}
      rehypePlugins={ASSISTANT_REHYPE}
      preprocess={preprocessMarkdown}
      className="aui-md"
      components={markdownComponents}
      componentsByLanguage={
        stableComponentsByLanguage ?? defaultComponentsByLanguage
      }
      defer
    />
  )
}

export const MarkdownText = memo(MarkdownTextImpl)

/** The code block draws its own chrome, so a fence's separate header is empty. */
export const CodeHeader: FC<CodeHeaderProps> = () => null

const defaultComponents = {
  ...memoizeMarkdownComponents({
    ...markdownElements('assistant'),
    pre: ({ className, ...props }) => (
      <pre
        data-appearance-recipe="code"
        className={cn(
          'aui-md-pre border-separator bg-popover overflow-x-auto rounded-t-none rounded-b-lg border border-t-0 p-3.5 text-[13px] leading-relaxed',
          className,
        )}
        {...props}
      />
    ),
    // Backticks keep their sentence at any length: a long path or command
    // wraps in the line. Diagnostic panels come from fenced blocks.
    code: function Code({ className, children, ...props }) {
      const isCodeBlock = useIsMarkdownCodeBlock()
      if (isCodeBlock)
        return (
          <code
            data-appearance-recipe="code"
            {...appearancePair('primary', 'popover')}
            className={className}
            {...props}
          >
            {children}
          </code>
        )
      return (
        <InlineCode voice="assistant" className={className} {...props}>
          {children}
        </InlineCode>
      )
    },
    CodeHeader,
  }),
  SyntaxHighlighter,
}
