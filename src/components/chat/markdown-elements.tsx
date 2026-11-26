// SOURCING: the element vocabulary both Markdown adapters render with: assistant-ui's MarkdownTextPrimitive for replies (assistant-ui/elements/markdown-text) and react-markdown for the person's sent turn (chat/user-markdown). Math is remark-math + rehype-katex with assistant-ui's own preprocess helpers (escapeCurrencyDollars, normalizeMathDelimiters); tables are shadcn's Table (ui/table) in its prose variant. Only the voice differs: its type recipe and the surface its paint is measured on (chat typography brief, 2026-11-24).
import {
  escapeCurrencyDollars,
  normalizeMathDelimiters,
} from '@assistant-ui/react-markdown/preprocess'
import type { Element, Root } from 'hast'
import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Pluggable, Plugin } from 'unified'
import { visit } from 'unist-util-visit'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { appearancePair } from '@/lib/appearance-policy'
import { cn } from '@/lib/utils'

/** Who wrote the Markdown: the reply, or the person's own turn. */
export type MarkdownVoice = 'assistant' | 'human'

const SURFACE = {
  assistant: 'assistant-reading',
  human: 'user-message',
} as const

/** Models emit \( \) and \[ \] as often as dollars; prices in prose are not math. */
export const preprocessMarkdown = (text: string) =>
  normalizeMathDelimiters(escapeCurrencyDollars(text))

/**
 * KaTeX's output takes the paint role of the prose around it, so the
 * rendered colour oracle measures formulas as it measures words.
 */
const rehypeMathPaint: Plugin<[MarkdownVoice], Root> = (voice) => (tree) => {
  visit(tree, 'element', (node: Element) => {
    const classes = node.properties.className
    if (Array.isArray(classes) && classes.includes('katex'))
      Object.assign(node.properties, appearancePair('primary', SURFACE[voice]))
  })
}

export const MARKDOWN_REMARK: Pluggable[] = [remarkGfm, remarkMath]

export const markdownRehype = (voice: MarkdownVoice): Pluggable[] => [
  rehypeKatex,
  [rehypeMathPaint, voice],
]

type Props<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> &
  ExtraProps

const HEADING_RECIPE = {
  h1: 'heading.large',
  h2: 'heading.medium',
  h3: 'heading.small',
  h4: 'heading.small',
  h5: 'heading.small',
  h6: 'heading.small',
} as const

function heading(level: keyof typeof HEADING_RECIPE, voice: MarkdownVoice) {
  const Tag = level
  return function Heading({
    node: _node,
    className,
    ...props
  }: Props<typeof level>) {
    return (
      <Tag
        // The person's headings keep their own face at their own size; the
        // reply's take the heading recipes.
        data-appearance-recipe={
          voice === 'assistant' ? HEADING_RECIPE[level] : undefined
        }
        {...appearancePair('primary', SURFACE[voice])}
        className={cn(`aui-md-${level}`, className)}
        {...props}
      />
    )
  }
}

/** Inline code keeps its sentence: reading ink, regular weight, a faint fill. */
export function InlineCode({
  voice,
  node: _node,
  className,
  ...props
}: Props<'code'> & { voice: MarkdownVoice }) {
  return (
    <code
      {...appearancePair('primary', SURFACE[voice])}
      className={cn('aui-md-inline-code', className)}
      {...props}
    />
  )
}

/**
 * The shared elements, without code: each adapter knows its own fenced
 * blocks. A reply's paragraph alone carries `aui-md-p`, the class the
 * reading oracles measure the answer's prose by.
 */
export function markdownElements(voice: MarkdownVoice) {
  const surface = SURFACE[voice]
  return {
    h1: heading('h1', voice),
    h2: heading('h2', voice),
    h3: heading('h3', voice),
    h4: heading('h4', voice),
    h5: heading('h5', voice),
    h6: heading('h6', voice),
    p: ({ node: _node, className, ...props }: Props<'p'>) => (
      <p
        data-appearance-recipe={voice === 'assistant' ? 'prose' : 'prose.human'}
        data-appearance-part="prose-block"
        {...appearancePair('primary', surface)}
        className={cn(voice === 'assistant' && 'aui-md-p', className)}
        {...props}
      />
    ),
    a: ({ node: _node, className, ...props }: Props<'a'>) => (
      <a
        {...appearancePair('link', surface)}
        className={cn(
          'aui-md-a text-link decoration-link/40 hover:decoration-link underline underline-offset-2',
          className,
        )}
        {...props}
      />
    ),
    blockquote: ({ node: _node, className, ...props }: Props<'blockquote'>) => (
      <blockquote
        {...appearancePair('secondary', surface)}
        className={cn(
          'aui-md-blockquote border-separator text-ink-muted border-s-2 ps-4',
          className,
        )}
        {...props}
      />
    ),
    ul: ({ node: _node, className, ...props }: Props<'ul'>) => (
      <ul
        className={cn(
          'aui-md-ul marker:text-ink-faint ms-5 list-disc',
          className,
        )}
        {...props}
      />
    ),
    ol: ({ node: _node, className, ...props }: Props<'ol'>) => (
      <ol
        className={cn(
          'aui-md-ol marker:text-ink-faint ms-5 list-decimal',
          className,
        )}
        {...props}
      />
    ),
    li: ({ node: _node, className, ...props }: Props<'li'>) => (
      <li className={cn('aui-md-li', className)} {...props} />
    ),
    hr: ({ node: _node, className, ...props }: Props<'hr'>) => (
      <hr className={cn('aui-md-hr border-separator', className)} {...props} />
    ),
    strong: ({ node: _node, className, ...props }: Props<'strong'>) => (
      <strong
        {...appearancePair('primary', surface)}
        className={cn('aui-md-strong font-semibold', className)}
        {...props}
      />
    ),
    sup: ({ node: _node, className, ...props }: Props<'sup'>) => (
      <sup
        className={cn('aui-md-sup [&>a]:text-xs [&>a]:no-underline', className)}
        {...props}
      />
    ),
    // A table is part of the document: prose-sized text on an opaque quiet
    // surface, scrolling sideways in its own region when it is wider than
    // the column.
    table: ({ node: _node, className, ...props }: Props<'table'>) => (
      <div className="aui-md-table-wrapper">
        <Table
          variant="prose"
          data-appearance-recipe="prose.table"
          className={cn('aui-md-table', className)}
          {...props}
        />
      </div>
    ),
    thead: ({ node: _node, className, ...props }: Props<'thead'>) => (
      <TableHeader className={cn('aui-md-thead', className)} {...props} />
    ),
    tbody: ({ node: _node, className, ...props }: Props<'tbody'>) => (
      <TableBody className={cn('aui-md-tbody', className)} {...props} />
    ),
    tr: ({ node: _node, className, ...props }: Props<'tr'>) => (
      <TableRow
        className={cn(
          'aui-md-tr border-separator hover:bg-transparent',
          className,
        )}
        {...props}
      />
    ),
    // GFM's authored alignment arrives as the cell's text-align, and a
    // column aligned right is read as figures (appearance.css).
    th: ({ node: _node, className, ...props }: Props<'th'>) => (
      <TableHead
        data-appearance-recipe="prose.table-header"
        {...appearancePair('primary', 'popover')}
        className={cn(
          'aui-md-th text-ink h-auto px-3 py-2 align-bottom whitespace-normal',
          className,
        )}
        {...props}
      />
    ),
    td: ({ node: _node, className, ...props }: Props<'td'>) => (
      <TableCell
        {...appearancePair('primary', 'popover')}
        className={cn(
          'aui-md-td px-3 py-2 align-top whitespace-normal',
          className,
        )}
        {...props}
      />
    ),
  }
}
