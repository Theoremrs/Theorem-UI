// SOURCING: none: committed constants in the conversation owner's own snapshot type and the threads seed the Threads panel reads. Invented, neutral content; no name, project or text of the reference it is held against.
import type { ConversationSnapshot } from '@/lib/workbench/conversation/conversation'
import type { FixtureOptions } from './fixture-host'
import { PARITY_THREADS } from './delta-parity-fixture'
import type { ThreadsSeed } from './threads-fixture'

/** The project the story's conversation belongs to, named so the footer under the composer can say it. */
export const COMPOSER_PROJECT = 'Orchard'

/** The parity account with the story's own project listed by name. */
export const THEO_COMPOSER_THREADS: ThreadsSeed = {
  ...PARITY_THREADS,
  projects: [
    ...PARITY_THREADS.projects,
    { id: 'story-project', name: COMPOSER_PROJECT },
  ],
}

/**
 * The owner takes a mid-turn message into the transcript a little after it is queued, so a scenario sees it
 * queued first; a message that mentions the deploy key is refused, as a run that will not take that input.
 */
export const THEO_COMPOSER_OWNER: NonNullable<FixtureOptions['owner']> = {
  takeAfterMs: 4_000,
  refuse: 'deploy key',
  reason: 'the run does not take input about credentials',
}

/**
 * A working run waiting on an approval: the person asked for a change, the run read a file, a cleanup it asked
 * for was allowed (its receipt stands where it was asked), one message sent mid-turn has been taken in, and a
 * write waits on the person. Two more messages sent mid-turn stand over the composer: one the owner holds for
 * the run, one it could not send.
 */
export const THEO_COMPOSER_CONVERSATION: ConversationSnapshot = {
  conversationId: 'composer-thread',
  revision: 1,
  loading: false,
  queued: [
    {
      clientMessageId: 'composer-q1',
      text: 'Keep the old column names working for one release.',
      state: 'queued',
    },
    {
      clientMessageId: 'composer-q2',
      text: 'Then add a note to the changelog.',
      state: 'failed',
      reason: 'the connection closed before it was sent',
    },
  ],
  messages: [
    {
      id: 'c1',
      role: 'user',
      clientMessageId: 'composer-1',
      status: 'complete',
      attachments: [],
      parts: [
        {
          type: 'text',
          text: 'Make the importer skip blank rows, then run its tests.',
        },
      ],
    },
    {
      id: 'c2',
      role: 'assistant',
      runId: 'run-7',
      status: 'requires-action',
      attachments: [],
      parts: [
        {
          type: 'text',
          text: 'I will find where rows are read, clear the stale fixtures, and make the change.',
        },
        {
          type: 'tool',
          id: 'call-1',
          name: 'read_file',
          args: '{"path":"src/import/rows.rs"}',
          status: 'complete',
          result: 'pub fn rows(text: &str) -> Vec<Row> {',
        },
        {
          type: 'tool',
          id: 'call-2',
          name: 'run_command',
          args: '{"command":"rm -r tests/fixtures/stale"}',
          status: 'complete',
          result: '',
          approvalId: 'composer-ap-1',
          approvalOutcome: 'approved',
          approvalSummary: 'Remove the stale test fixtures',
        },
        {
          type: 'input',
          inputId: 'composer-taken',
          text: 'Leave the header row alone when the file is empty.',
          status: 'delivered',
        },
        {
          type: 'text',
          text: 'Understood: an empty file keeps its header. The change goes in the row reader:',
        },
        {
          type: 'tool',
          id: 'call-3',
          name: 'run_command',
          args: '{"command":"cargo test -p importer rows"}',
          status: 'approval',
          approvalId: 'composer-ap-2',
          approvalOutcome: 'awaiting',
        },
      ],
    },
  ],
  run: { state: 'waiting_approval', runId: 'run-7' },
  approval: {
    runId: 'run-7',
    approvalId: 'composer-ap-2',
    toolCallId: 'call-3',
    toolName: 'run_command',
    summary: 'Run the importer row tests',
    risk: 'medium',
    options: [],
  },
}
