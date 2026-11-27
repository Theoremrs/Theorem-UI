// SOURCING: react-native-marked (useMarkdown, MarkedLexer, Renderer) bound the way assistant-ui's React Native MarkdownText element binds it (per-block memo, throttled streaming); links open in the contextual browser (features/browser); colors and type from src/theme/tokens.ts
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Text as NativeText, View } from 'react-native'
import { MarkedLexer, Renderer, useMarkdown, type MarkedStyles, type useMarkdownHookOptions } from 'react-native-marked'
import { openInBrowser } from '@/features/browser/store'
import { fonts, radius, space, type } from '@/theme/tokens'
import { useTheme } from '@/ui/theme'

/** A streaming reply re-renders at most this often. */
const STREAM_INTERVAL_MS = 50

function useThrottled<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const timer = setTimeout(
      () => {
        last.current = Date.now()
        setThrottled(value)
      },
      Math.max(0, intervalMs - (Date.now() - last.current)),
    )
    return () => clearTimeout(timer)
  }, [value, intervalMs])
  return throttled
}

const OPENABLE = /^(https?|mailto):/i

/** One renderer per block, so keys restart with each parse and a streaming block is not remounted. */
class ReplyRenderer extends Renderer {
  private index = 0

  override getKey(): string {
    return `md-${this.index++}`
  }

  // The base renderer hands every href to Linking.openURL, which would also open
  // tel:, sms: and app deep links. Web links open in the app's browser, as bare
  // URLs in a reply do; any other scheme stays plain text.
  override link(children: string | ReactNode[], href: string, styles?: object): ReactNode {
    const url = href.trim()
    if (!OPENABLE.test(url)) return <NativeText key={this.getKey()}>{children}</NativeText>
    return (
      <NativeText key={this.getKey()} accessibilityRole="link" style={styles} onPress={() => openInBrowser(url)}>
        {children}
      </NativeText>
    )
  }
}

const Block = memo(function Block({ raw, options }: { raw: string; options: useMarkdownHookOptions }) {
  const renderer = useMemo(() => new ReplyRenderer({ selectable: true }), [raw])
  return <>{useMarkdown(raw, useMemo(() => ({ ...options, renderer }), [options, renderer]))}</>
})

/** Agent prose as Markdown: headings, emphasis, lists, quotes, tables and code, selectable. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const { palette, scheme } = useTheme()
  const settled = useDeferredValue(useThrottled(text, STREAM_INTERVAL_MS))
  const options = useMemo<useMarkdownHookOptions>(() => {
    const prose = { fontFamily: fonts.agent, ...type.prose }
    const heading = { fontFamily: fonts.agentStrong, fontWeight: '600' as const, marginTop: space.md, marginBottom: space.xs }
    const styles: MarkedStyles = {
      text: prose,
      li: prose,
      strong: { fontFamily: fonts.agentStrong, fontWeight: '600' },
      paragraph: { paddingVertical: space.xs },
      list: { paddingVertical: space.xs },
      link: { textDecorationLine: 'underline' },
      codespan: { fontFamily: fonts.code, fontSize: 14, backgroundColor: palette.raised },
      code: { backgroundColor: palette.raised, borderRadius: radius.control, padding: space.md, marginVertical: space.sm },
      codeText: { fontFamily: fonts.code, ...type.label, color: palette.ink },
      blockquote: { borderLeftWidth: 2, borderLeftColor: palette.lineControl, paddingLeft: space.md, opacity: 1 },
      hr: { height: 1, marginVertical: space.md, backgroundColor: palette.lineSeparator, borderWidth: 0 },
      h1: { ...heading, fontSize: 22, lineHeight: 30, borderBottomWidth: 0, paddingBottom: 0 },
      h2: { ...heading, fontSize: 19, lineHeight: 26, borderBottomWidth: 0, paddingBottom: 0 },
      h3: { ...heading, fontSize: 17, lineHeight: 24 },
      h4: { ...heading, ...type.prose },
      h5: { ...heading, ...type.prose },
      h6: { ...heading, ...type.prose },
      tableCell: { paddingHorizontal: space.sm, paddingVertical: space.xs },
    }
    return {
      colorScheme: scheme,
      styles,
      theme: { colors: { text: palette.ink, link: palette.link, code: palette.raised, border: palette.lineSeparator } },
    }
  }, [palette, scheme])
  // Each top-level block is lexed on its own, so a streamed update re-renders only the block it touched.
  const blocks = useMemo(() => MarkedLexer(settled, { gfm: true }).filter((token) => token.type !== 'space'), [settled])
  return (
    <View>
      {blocks.map((token, index) => (
        <Block key={index} raw={token.raw} options={options} />
      ))}
    </View>
  )
})
