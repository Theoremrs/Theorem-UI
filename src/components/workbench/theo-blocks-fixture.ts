// SOURCING: none: a committed constant in the conversation owner's own snapshot type, and the terminal's argsDiff (the same reading the owner makes of a write's or an edit's arguments) for the code the agent writes. Invented, neutral content; no name, project or text of the reference it is held against.
import type { ConversationSnapshot } from '@/lib/workbench/conversation/conversation'
import type { TranscriptPart } from '@/lib/workbench/conversation/transcript'
import { argsDiff } from '@/components/terminal/terminal-code'

/** The owner's clock at the story's first snapshot. Invented: 2026-11-15 09:00 UTC. */
const T0 = Date.UTC(2026, 10, 15, 9, 0, 0)

/** The command still running when the story opens, and how long it has run by then. */
const RUNNING_SINCE = T0 - 8_000

/** The importer's test suite, by module: the running command reports one a step, so its output keeps arriving. */
const SUITE: Record<string, string[]> = {
  parse: [
    'keeps_quoted_commas',
    'reads_the_header',
    'trims_amounts',
    'skips_blank_lines',
    'reads_crlf_endings',
    'rejects_four_fields',
  ],
  rows: [
    'counts_every_row',
    'keeps_a_row_with_no_date',
    'orders_by_id',
    'keeps_duplicate_ids',
    'reads_a_single_row',
    'reads_ten_thousand_rows',
  ],
  dates: [
    'reads_iso_dates',
    'empty_is_none',
    'rejects_month_thirteen',
    'reads_leap_days',
    'trims_spaces',
    'rejects_two_digit_years',
  ],
  amounts: [
    'reads_cents',
    'reads_negative_amounts',
    'rejects_letters',
    'keeps_trailing_zeros',
    'reads_large_amounts',
    'rounds_half_even',
  ],
  header: [
    'names_three_columns',
    'rejects_a_missing_column',
    'ignores_case',
    'rejects_extra_columns',
    'reads_a_bom',
    'reports_the_bad_name',
  ],
  errors: [
    'names_the_line',
    'names_the_field',
    'keeps_reading_after_a_bad_row',
    'stops_on_bad_utf8',
    'reports_an_empty_file',
    'says_what_was_expected',
  ],
}

/** What the running test command prints, a line a step. */
const TEST_OUTPUT = [
  '   Compiling importer v0.4.0 (/work/importer)',
  '    Finished test profile in 3.1s',
  '     Running unittests src/lib.rs',
  `running ${Object.values(SUITE).flat().length} tests`,
  ...Object.entries(SUITE).flatMap(([module, cases]) =>
    cases.map((name) => `test ${module}::${name} ... ok`),
  ),
]

/** The edit the agent is making: the parser keeps a row whose date is empty. */
const EDIT_ARGS = {
  path: 'src/rows.rs',
  old_string: [
    '    let date = parse_date(&fields[1])?;',
    '    rows.push(Row { id, date, amount });',
  ].join('\n'),
  new_string: [
    '    let date = match fields[1].trim() {',
    '        "" => None,',
    '        text => Some(parse_date(text)?),',
    '    };',
    '    rows.push(Row { id, date, amount });',
  ].join('\n'),
}

/** The test file the agent is writing, a line at a time while the story runs. */
const TEST_FILE = [
  'use importer::rows::read_rows;',
  '',
  '#[test]',
  'fn keeps_a_row_with_no_date() {',
  '    let csv = "id,date,amount\\n7,,12.50\\n";',
  '    let rows = read_rows(csv.as_bytes()).unwrap();',
  '    assert_eq!(rows.len(), 1);',
  '    assert_eq!(rows[0].date, None);',
  '}',
  '',
  '#[test]',
  'fn still_reads_a_dated_row() {',
  '    let csv = "id,date,amount\\n8,2026-03-01,4.00\\n";',
  '    let rows = read_rows(csv.as_bytes()).unwrap();',
  '    assert_eq!(rows[0].date.unwrap().to_string(), "2026-03-01");',
  '}',
]

/** How many lines of the test file are written when the story opens. */
const WRITTEN_AT_START = 9

/** The file the edit is made in, as the documents owner holds it: line 42 is the line the edit replaces. */
export const THEO_BLOCKS_DOCUMENTS: Record<string, string> = {
  'src/rows.rs': [
    '//! Rows of an importer file: one per line after the header.',
    '',
    'use crate::dates::parse_date;',
    'use crate::error::Error;',
    '',
    '/// One row of the file.',
    '#[derive(Debug, PartialEq)]',
    'pub struct Row {',
    '    pub id: u32,',
    '    pub date: Option<Date>,',
    '    pub amount: Amount,',
    '}',
    '',
    '/// Every row of `input`, in order.',
    'pub fn read_rows(input: &[u8]) -> Result<Vec<Row>, Error> {',
    '    let text = std::str::from_utf8(input)?;',
    '    let mut lines = text.lines();',
    '    let header = lines.next().ok_or(Error::Empty)?;',
    '    check_header(header)?;',
    '    let mut rows = Vec::new();',
    '    for line in lines {',
    '        read_row(line, &mut rows)?;',
    '    }',
    '    Ok(rows)',
    '}',
    '',
    '/// The header names the three columns, in order.',
    'fn check_header(header: &str) -> Result<(), Error> {',
    '    match header.trim() {',
    '        "id,date,amount" => Ok(()),',
    '        other => Err(Error::Header(other.to_owned())),',
    '    }',
    '}',
    '',
    '/// One line: a row when it has three fields.',
    'fn read_row(line: &str, rows: &mut Vec<Row>) -> Result<(), Error> {',
    "    let fields: Vec<&str> = line.split(',').collect();",
    '    if fields.len() != 3 {',
    '        return Ok(());',
    '    }',
    '    let (id, amount) = (fields[0].trim().parse()?, fields[2].trim().parse()?);',
    '    let date = parse_date(&fields[1])?;',
    '    rows.push(Row { id, date, amount });',
    '    Ok(())',
    '}',
    '',
  ].join('\n'),
}

/** A write or edit as the owner reads it: its diff from the arguments, and the file it opens at. */
function writing(
  id: string,
  name: string,
  args: Record<string, unknown>,
  path: string,
  start: number,
): TranscriptPart {
  return {
    type: 'tool',
    id,
    name,
    args: path,
    status: 'running',
    diff: argsDiff(args, path)?.diff,
    open: { path, start },
  }
}

/** The working turn at one step: the command's output and clock, and the test file, moved on. */
function working(step: number): TranscriptPart[] {
  const shown = Math.min(TEST_OUTPUT.length, 6 + step)
  const lines = Math.min(TEST_FILE.length, WRITTEN_AT_START + step)
  return [
    {
      type: 'reasoning',
      text: 'The fix belongs where the date field is read. A test should pin both the empty case and an ordinary dated row.',
      startedAtMs: T0 - 21_000,
      endedAtMs: T0 - 15_000,
    },
    {
      type: 'text',
      text: 'I will change how the date is read, add a test for the empty case, and run the importer tests.',
    },
    writing('w-edit', 'edit_file', EDIT_ARGS, 'src/rows.rs', 42),
    writing(
      'w-write',
      'write_file',
      {
        path: 'tests/no_date.rs',
        content: TEST_FILE.slice(0, lines).join('\n'),
      },
      'tests/no_date.rs',
      1,
    ),
    {
      type: 'tool',
      id: 'w-run',
      name: 'run_command',
      args: 'cargo test -p importer',
      status: 'running',
      result: TEST_OUTPUT.slice(0, shown).join('\n'),
      startedAtMs: RUNNING_SINCE,
    },
  ]
}

/**
 * The transcript `workbench-theo-blocks` shows: a finished turn (two thoughts, two finished commands, a search,
 * and an answer with a fenced block), the person's next message, and a turn still working (a thought, an edit and
 * a write streaming, a command running with its output).
 */
export const THEO_BLOCKS_CONVERSATION: ConversationSnapshot = {
  conversationId: 'blocks-thread',
  revision: 1,
  loading: false,
  queued: [],
  nowMs: T0,
  run: { state: 'streaming', runId: 'run-2' },
  messages: [
    {
      id: 'b1',
      role: 'user',
      clientMessageId: 'blocks-1',
      status: 'complete',
      attachments: [],
      parts: [
        {
          type: 'text',
          text: 'The importer drops rows whose date is empty. Find where, and tell me what you would change.',
        },
      ],
    },
    {
      id: 'b2',
      role: 'assistant',
      runId: 'run-1',
      status: 'complete',
      attachments: [],
      parts: [
        {
          type: 'reasoning',
          text: 'Rows go missing, so something returns early. The sample data should show which rows.',
          startedAtMs: T0 - 300_000,
          endedAtMs: T0 - 296_000,
        },
        {
          type: 'tool',
          id: 'r-ls',
          name: 'run_command',
          args: 'ls data',
          status: 'complete',
          result: 'march.csv\napril.csv',
          startedAtMs: T0 - 296_000,
          endedAtMs: T0 - 295_000,
        },
        {
          type: 'tool',
          id: 'r-grep',
          name: 'grep',
          args: 'parse_date src',
          status: 'complete',
          result: 'src/rows.rs:42:    let date = parse_date(&fields[1])?;',
          startedAtMs: T0 - 295_000,
          endedAtMs: T0 - 294_500,
        },
        {
          type: 'reasoning',
          text: 'The question mark returns the error for the whole file, and the caller skips the row.',
          startedAtMs: T0 - 294_500,
          endedAtMs: T0 - 291_000,
        },
        {
          type: 'tool',
          id: 'r-test',
          name: 'run_command',
          args: 'cargo test -p importer rows',
          status: 'complete',
          result: 'test result: ok. 6 passed; 0 failed',
          startedAtMs: T0 - 291_000,
          endedAtMs: T0 - 284_000,
        },
        {
          type: 'text',
          text: [
            'The row is dropped in `src/rows.rs`: an empty date fails to parse and the row is skipped. A row like this one goes missing:',
            '',
            '```csv',
            'id,date,amount',
            '7,,12.50',
            '```',
            '',
            'I would read an empty date as no date, and keep the row.',
          ].join('\n'),
        },
      ],
    },
    {
      id: 'b3',
      role: 'user',
      clientMessageId: 'blocks-2',
      status: 'complete',
      attachments: [],
      parts: [{ type: 'text', text: 'Go ahead, and add a test for it.' }],
    },
    {
      id: 'b4',
      role: 'assistant',
      runId: 'run-2',
      status: 'running',
      attachments: [],
      parts: working(0),
    },
  ],
}

/** One second of the working turn a step: the clock moves on, the output and the test file grow. */
export const THEO_BLOCKS_LIVE = {
  everyMs: 1_000,
  frame: (step: number, story: ConversationSnapshot): ConversationSnapshot => ({
    ...story,
    nowMs: T0 + step * 1_000,
    messages: story.messages.map((message) =>
      message.id === 'b4' ? { ...message, parts: working(step) } : message,
    ),
  }),
}
