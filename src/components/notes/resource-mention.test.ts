// SOURCING: bun:test over the note editor's mention node (./resource-mention) in a bare Milkdown editor with the commonmark preset, without the React node view: a mention survives a parse and save, an unknown kind is written back verbatim, and an ordinary link is untouched.
import { Editor, defaultValueCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { getMarkdown } from '@milkdown/kit/utils'
import { describe, expect, test } from 'bun:test'
import { mentionMarkdown } from '@/lib/resources/mention'
import { remarkResourceMention, resourceMentionNode } from './resource-mention'

async function roundTrip(markdown: string) {
  const editor = await Editor.make()
    .config((ctx) => ctx.set(defaultValueCtx, markdown))
    .use(commonmark)
    .use(remarkResourceMention)
    .use(resourceMentionNode)
    .create()
  const out = editor.action(getMarkdown())
  await editor.destroy()
  return out
}

describe('note mention node', () => {
  test('a mention is written back as the same link', async () => {
    const md = `See ${mentionMarkdown({ kind: 'record', objectType: 'company', objectId: 'c 1' }, 'Kiln Co')} today.`
    expect((await roundTrip(md)).trim()).toBe(md)
  })

  test('an unknown kind keeps its token on save', async () => {
    const md = 'A [Widget](theorem-resource:hologram|a%2Fb|c) here.'
    expect((await roundTrip(md)).trim()).toBe(md)
  })

  test('an ordinary link stays a link', async () => {
    const md = 'A [site](https://example.com) here.'
    expect((await roundTrip(md)).trim()).toBe(md)
  })
})
