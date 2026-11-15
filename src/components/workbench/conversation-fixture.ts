// SOURCING: none — a committed constant in the conversation owner's own snapshot type (lib/workbench/conversation), so the story's transcript has exactly the fields the owner sends and no others
import type { ConversationSnapshot } from '@/lib/workbench/conversation/conversation'

/**
 * The transcript `workbench-default` shows: a person's turn, a reply with Markdown, a tool call
 * with its output, an edit carrying a structured diff and the file it worked on, a reply with one fenced
 * code block, and a call waiting for approval.
 */
export const STORY_CONVERSATION: ConversationSnapshot = {
  conversationId: 'story-thread',
  revision: 1,
  loading: false,
  queued: [],
  messages: [
    {
      id: 'm1',
      role: 'user',
      clientMessageId: 'story-1',
      status: 'complete',
      attachments: [{ id: 'a1', name: 'build.log', contentType: 'text/plain' }],
      parts: [
        {
          type: 'text',
          text: 'The build fails on the new panel. Can you find out why and fix it?',
        },
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      runId: 'run-1',
      status: 'requires-action',
      attachments: [],
      parts: [
        {
          type: 'text',
          text: 'I read the log first. The error is **a missing semicolon** in `src/panel.rs`, so the fix is one line:',
        },
        {
          type: 'tool',
          id: 'call-1',
          name: 'read_file',
          args: '{"path":"src/panel.rs"}',
          status: 'complete',
          result:
            'fn draw(&self) {\n    let width = self.area.width\n    render(width);\n}',
        },
        {
          type: 'tool',
          id: 'call-3',
          name: 'apply_patch',
          args: '{"path":"src/panel.rs"}',
          status: 'complete',
          result: 'Patched src/panel.rs',
          diff: [
            { k: 'file', t: [{ t: 'src/panel.rs' }] },
            { k: 'hunk', t: [{ t: '@@ -1,3 +1,3 @@' }] },
            { k: 'ctx', t: [{ t: 'fn draw(&self) {' }] },
            { k: 'del', t: [{ t: '    let width = self.area.width' }] },
            {
              k: 'add',
              t: [
                { t: '    let width = self.area.width' },
                { t: ';', e: true },
              ],
            },
            { k: 'ctx', t: [{ t: '    render(width);' }] },
          ],
          open: { path: 'src/panel.rs', start: 1, end: 3 },
        },
        {
          type: 'text',
          text: 'Written as one function, it reads:\n\n```rust\nfn draw(&self) {\n    let width = self.area.width;\n    render(width);\n}\n```\n\nThe change needs a write to disk, so I am asking first.',
        },
        {
          type: 'tool',
          id: 'call-2',
          name: 'edit_file',
          args: '{"path":"src/panel.rs"}',
          status: 'approval',
          approvalId: 'approval-1',
        },
      ],
    },
  ],
  run: { state: 'waiting_approval', runId: 'run-1' },
  approval: {
    runId: 'run-1',
    approvalId: 'approval-1',
    toolCallId: 'call-2',
    toolName: 'edit_file',
    summary: 'Write src/panel.rs',
    risk: 'low',
    options: [],
  },
}
