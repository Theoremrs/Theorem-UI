// SOURCING: bun:test over the real SDK client and lib/theorem/passthrough, with window.fetch answered in process by stories/fake-theorem; no Theorem is running, as for thread-generation's writes
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { installFakeTheorem } from '@/stories/fake-theorem'
import type { FakeRoutes } from '@/stories/fake-theorem'
import { bootstrap } from './client'
import {
  EMPTY_ROSTER,
  modelRef,
  parseRoster,
  parseThreadRoster,
  readConversationRoster,
  refOf,
  rosterLeadRef,
  saveRoster,
  useRoster,
} from './roster'
import { pickedModel } from './models'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

/** A roster write, as it arrived: its revision guard, its participants, and the guards Theorem asks mutations to carry. */
type Written = {
  ifMatch: string | null
  csrf: string | null
  idempotency: string | null
  body: { expectedRosterRevision: number; participants: unknown[] }
}
let written: Written[] = []
let reads = 0
let restore: () => void = () => {}

const wire = (
  participantId: string,
  provider: string,
  model: string,
  label: string,
) => ({
  participantId,
  actorId: `agent:${participantId}`,
  model: { provider, model },
  label,
  status: 'active',
  addedAtMs: 1_700_000_000_000,
})

/**
 * A Theorem holding one thread at `revision`, whose roster is the rows `held`
 * says, and which answers every write with `applied`.
 */
async function theoremWith(
  held: unknown[],
  revision: number,
  applied: (body: Written['body']) => unknown = (body) => ({
    revision: revision + 1,
    participants: body.participants.map((participant, at) => ({
      ...(participant as Record<string, unknown>),
      participantId: `ptc_new${at}`,
      actorId: `agent:ptc_new${at}`,
      addedAtMs: 1_700_000_000_000,
    })),
  }),
  conflict = false,
  gate: Promise<void> | undefined = undefined,
) {
  const routes: FakeRoutes = {
    'GET /api/chat/v1/bootstrap': () => ({ csrfToken: 'csrf', tenantId: 't' }),
    'GET /api/chat/v1/threads/:threadId': () => {
      reads += 1
      return {
        thread: {
          threadId: 't1',
          revision,
          rosterRevision: revision,
          participants: held,
          activeRuns: [],
        },
        messages: [],
      }
    },
    'PUT /api/chat/v1/threads/:threadId/participants': async (
      _params,
      request,
    ) => {
      const body = (await request.json()) as Written['body']
      written.push({
        ifMatch: request.headers.get('If-Match'),
        csrf: request.headers.get('X-CSRF-Token'),
        idempotency: request.headers.get('Idempotency-Key'),
        body,
      })
      // Held open so a seat can be chosen while the write is on its way.
      await gate
      if (conflict && written.length === 1)
        return new Response(
          JSON.stringify({
            code: 'roster_revision_stale',
            title: 'The roster moved.',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        )
      const result = applied(body)
      // A refusal comes back as a Response; a roster the thread applied as a body.
      return result instanceof Response ? result : { roster: result }
    },
  }
  restore = installFakeTheorem(routes)
  await bootstrap(true)
}

const seats = (conversation: string) =>
  useRoster.getState().byConversation[conversation]?.roster.participants ?? []

/** The conversation the composer has open, standing in for the picker's hook. */
function open(conversation: string, remoteId: string | undefined) {
  useRoster.getState().open(conversation, remoteId)
}

afterEach(() => {
  restore()
  written = []
  reads = 0
  useRoster.setState({ byConversation: {}, current: undefined, reads: {} })
})

describe('the wire shape', () => {
  test("a thread's roster reads as participants, a revision and the runs they are doing", () => {
    const roster = parseThreadRoster({
      rosterRevision: 3,
      participants: [
        wire(
          'ptc_sonnet',
          'openrouter',
          'anthropic/claude-sonnet-4-5',
          'Claude Sonnet 4.5',
        ),
      ],
      activeRuns: [{ participantId: 'ptc_sonnet', runId: 'run_1', cursor: 0 }],
    })
    expect(roster).toEqual({
      revision: 3,
      participants: [
        {
          participantId: 'ptc_sonnet',
          actorId: 'agent:ptc_sonnet',
          model: {
            provider: 'openrouter',
            model: 'anthropic/claude-sonnet-4-5',
          },
          label: 'Claude Sonnet 4.5',
          status: 'active',
          addedAtMs: 1_700_000_000_000,
        },
      ],
      activeRuns: [{ participantId: 'ptc_sonnet', runId: 'run_1', cursor: 0 }],
    })
  })

  test('the roster a write returns reads the same, under its own revision field', () => {
    expect(
      parseRoster({
        revision: 4,
        participants: [wire('ptc_b', 'openrouter', 'a/b', 'B')],
      }),
    ).toMatchObject({
      revision: 4,
      participants: [
        {
          participantId: 'ptc_b',
          model: { provider: 'openrouter', model: 'a/b' },
        },
      ],
    })
  })

  test('a thread with no roster is an empty room, not a failure', () => {
    expect(parseThreadRoster({ threadId: 't1', revision: 1 })).toEqual(
      EMPTY_ROSTER,
    )
    expect(parseThreadRoster(undefined)).toEqual(EMPTY_ROSTER)
    // A row nobody can address, or nothing that runs, is dropped rather than seated.
    expect(
      parseRoster({
        participants: [{ label: 'nameless' }, { participantId: 'ptc_x' }, null],
      }),
    ).toEqual(EMPTY_ROSTER)
  })

  test('a reference splits and rejoins as the wire carries it', () => {
    const model = modelRef('openrouter/anthropic/claude-sonnet-4-5')
    expect(model).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    })
    expect(refOf(model)).toBe('openrouter/anthropic/claude-sonnet-4-5')
  })
})

describe('the roster of one conversation', () => {
  test('adding two models seats two participants, each on one model, and the last pick leads', () => {
    open('c1', undefined)
    const roster = useRoster.getState()
    roster.addModel(
      'c1',
      'openrouter/anthropic/claude-sonnet-4-5',
      'Claude Sonnet 4.5',
    )
    roster.addModel('c1', 'openrouter/deepseek/deepseek-v4', 'DeepSeek V4')
    const seated = seats('c1')
    expect(seated.map((part) => refOf(part.model))).toEqual([
      'openrouter/anthropic/claude-sonnet-4-5',
      'openrouter/deepseek/deepseek-v4',
    ])
    expect(new Set(seated.map((part) => part.participantId)).size).toBe(2)
    expect(seated.map((part) => part.label)).toEqual([
      'Claude Sonnet 4.5',
      'DeepSeek V4',
    ])
    expect(seated.every((part) => part.status === 'active')).toBe(true)
    // The lead is the participant the last pick acted on.
    expect(rosterLeadRef()).toBe('openrouter/deepseek/deepseek-v4')
  })

  test('removing one leaves one, and the conversation keeps a lead', () => {
    open('c1', undefined)
    const roster = useRoster.getState()
    roster.addModel('c1', 'openrouter/anthropic/claude-sonnet-4-5')
    roster.addModel('c1', 'openrouter/deepseek/deepseek-v4')
    const [gone] = seats('c1')
    roster.removeParticipant('c1', gone!.participantId)
    expect(seats('c1').map((part) => refOf(part.model))).toEqual([
      'openrouter/deepseek/deepseek-v4',
    ])
    expect(rosterLeadRef()).toBe('openrouter/deepseek/deepseek-v4')
  })

  test('one seat answers what the picked model answered, so a send carries it', () => {
    open('c1', undefined)
    useRoster
      .getState()
      .addModel('c1', 'openrouter/anthropic/claude-sonnet-4-5')
    expect(rosterLeadRef()).toBe('openrouter/anthropic/claude-sonnet-4-5')
    expect(pickedModel()).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    })
    // An empty room leaves the model to the account's pick, as before.
    useRoster.getState().reset('c1')
    expect(rosterLeadRef()).toBeUndefined()
    expect(pickedModel()).toBeUndefined()
  })

  test('a model replaced on a participant keeps the participant and changes the model', () => {
    open('c1', 't1')
    const roster = useRoster.getState()
    roster.addModel(
      'c1',
      'openrouter/anthropic/claude-sonnet-4-5',
      'Claude Sonnet 4.5',
    )
    const [only] = seats('c1')
    roster.replaceModel(
      'c1',
      only!.participantId,
      'openrouter/deepseek/deepseek-v4',
      'DeepSeek V4',
    )
    const seated = seats('c1')
    expect(seated).toHaveLength(1)
    expect(seated[0]?.participantId).toBe(only!.participantId)
    expect(refOf(seated[0]!.model)).toBe('openrouter/deepseek/deepseek-v4')
    expect(seated[0]?.label).toBe('DeepSeek V4')
    expect(rosterLeadRef()).toBe('openrouter/deepseek/deepseek-v4')
  })

  test('a model holds one seat, however often it is added', () => {
    open('c1', undefined)
    const roster = useRoster.getState()
    roster.addModel('c1', 'openrouter/a/b')
    roster.addModel('c1', 'openrouter/a/b')
    expect(seats('c1')).toHaveLength(1)
  })

  test("a conversation's seats are its own: another conversation does not see them", () => {
    const roster = useRoster.getState()
    roster.open('c1', undefined)
    roster.addModel('c1', 'openrouter/a/b')
    roster.open('c2', undefined)
    roster.addModel('c2', 'openrouter/c/d')
    expect(seats('c1').map((part) => refOf(part.model))).toEqual([
      'openrouter/a/b',
    ])
    expect(seats('c2').map((part) => refOf(part.model))).toEqual([
      'openrouter/c/d',
    ])
    // The lead belongs to the conversation the composer has open, which is c2.
    expect(rosterLeadRef()).toBe('openrouter/c/d')
    // A closed conversation leaves the model to the account's pick.
    roster.close('c2')
    expect(pickedModel()).toBeUndefined()
  })
})

describe('the write', () => {
  test('a draft keeps its roster client-side: nothing is sent while there is no thread', async () => {
    open('c1', undefined)
    useRoster.getState().addModel('c1', 'openrouter/a/b')
    await saveRoster('c1')
    expect(written).toEqual([])
    expect(reads).toBe(0)
  })

  test('the room a draft seated goes up when the draft becomes a thread', async () => {
    await theoremWith([], 0)
    open('c1', undefined)
    useRoster.getState().addModel('c1', 'openrouter/a/b', 'B')
    await saveRoster('c1')
    expect(written).toEqual([])

    // The same conversation, now with a thread: the seats it chose go up.
    useRoster.getState().open('c1', 't1')
    await saveRoster('c1')
    expect(written.map((write) => write.body)).toEqual([
      {
        expectedRosterRevision: 0,
        participants: [
          { model: { provider: 'openrouter', model: 'a/b' }, label: 'B' },
        ],
      },
    ])
    expect(useRoster.getState().byConversation.c1?.unsaved).toBe(false)
  })

  test('a seated model is sent without an id, so Theorem mints the participant', async () => {
    await theoremWith([], 0)
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    useRoster
      .getState()
      .addModel('c1', 'openrouter/deepseek/deepseek-v4', 'DeepSeek V4')
    await saveRoster('c1')
    expect(written).toHaveLength(1)
    expect(written[0]?.body).toEqual({
      expectedRosterRevision: 0,
      participants: [
        {
          model: { provider: 'openrouter', model: 'deepseek/deepseek-v4' },
          label: 'DeepSeek V4',
        },
      ],
    })
    // The write carries the mutation guards and no thread revision: the roster
    // revision is the guard, and it travels in the body.
    expect(written[0]?.csrf).toBe('csrf')
    expect(written[0]?.idempotency).toBeTruthy()
    expect(written[0]?.ifMatch).toBeNull()
    // What Theorem applied stands, with the id it minted and no change waiting.
    expect(seats('c1').map((part) => part.participantId)).toEqual(['ptc_new0'])
    expect(useRoster.getState().byConversation.c1?.unsaved).toBe(false)
    expect(useRoster.getState().byConversation.c1?.error).toBeUndefined()
  })

  test('a model replaced on a seated participant sends that participantId', async () => {
    const held = wire(
      'ptc_sonnet',
      'openrouter',
      'anthropic/claude-sonnet-4-5',
      'Claude Sonnet 4.5',
    )
    await theoremWith([held], 3, () => ({
      revision: 4,
      participants: [
        wire('ptc_sonnet', 'openrouter', 'deepseek/deepseek-v4', 'DeepSeek V4'),
      ],
    }))
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    expect(seats('c1').map((part) => part.participantId)).toEqual([
      'ptc_sonnet',
    ])

    useRoster
      .getState()
      .replaceModel(
        'c1',
        'ptc_sonnet',
        'openrouter/deepseek/deepseek-v4',
        'DeepSeek V4',
      )
    await saveRoster('c1')
    expect(written.map((write) => write.body)).toEqual([
      {
        expectedRosterRevision: 3,
        participants: [
          {
            participantId: 'ptc_sonnet',
            model: { provider: 'openrouter', model: 'deepseek/deepseek-v4' },
            label: 'DeepSeek V4',
          },
        ],
      },
    ])
    // The room keeps its identity and takes the new model.
    expect(seats('c1')).toEqual([
      expect.objectContaining({
        participantId: 'ptc_sonnet',
        model: { provider: 'openrouter', model: 'deepseek/deepseek-v4' },
      }),
    ])
    expect(useRoster.getState().byConversation.c1?.roster.revision).toBe(4)
  })

  test('a revision that moved under the edit is re-read and the write retried against it', async () => {
    await theoremWith(
      [wire('ptc_b', 'openrouter', 'a/b', 'B')],
      3,
      undefined,
      true,
    )
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    useRoster.getState().removeParticipant('c1', 'ptc_b')
    await saveRoster('c1')
    // The thread is refused once, read again for its revision, then the same
    // seats go up against it.
    expect(written.map((write) => write.body.expectedRosterRevision)).toEqual([
      3, 3,
    ])
    expect(reads).toBe(2)
    expect(seats('c1')).toEqual([])
    expect(useRoster.getState().byConversation.c1?.error).toBeUndefined()
  })

  test('a refused write says so and keeps the change waiting', async () => {
    await theoremWith(
      [],
      0,
      () =>
        new Response(
          JSON.stringify({
            code: 'chat_model_not_found',
            detail: 'Choose a model Theorem can run.',
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    )
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    useRoster.getState().addModel('c1', 'openrouter/bad/model')
    await saveRoster('c1')
    expect(written).toHaveLength(1)
    expect(useRoster.getState().byConversation.c1?.error).toContain(
      'Choose a model Theorem can run.',
    )
    // Still waiting, so the next change tries again.
    expect(useRoster.getState().byConversation.c1?.unsaved).toBe(true)
  })

  test("a thread's own roster arrives when the conversation opens, and leads with its first seat", async () => {
    await theoremWith(
      [
        wire(
          'ptc_sonnet',
          'openrouter',
          'anthropic/claude-sonnet-4-5',
          'Claude Sonnet 4.5',
        ),
        wire(
          'ptc_deepseek',
          'openrouter',
          'deepseek/deepseek-v4',
          'DeepSeek V4',
        ),
      ],
      3,
    )
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    expect(seats('c1').map((part) => part.participantId)).toEqual([
      'ptc_sonnet',
      'ptc_deepseek',
    ])
    expect(rosterLeadRef()).toBe('openrouter/anthropic/claude-sonnet-4-5')
    // Nothing changed here, so nothing is written, and the thread is read once.
    await saveRoster('c1')
    expect(written).toEqual([])
    expect(readConversationRoster('c1', 't1')).toBeUndefined()
  })

  test('a room changed twice in one turn goes up as one write of where it ended', async () => {
    await theoremWith([], 0)
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    const roster = useRoster.getState()
    roster.addModel('c1', 'openrouter/a/b', 'B')
    const first = saveRoster('c1')
    roster.addModel('c1', 'openrouter/c/d', 'D')
    const second = saveRoster('c1')
    await Promise.all([first, second])
    // Each write waits behind the one before it and sends the room as it stands
    // when it goes out, so a fast room of two is sent once.
    expect(written).toHaveLength(1)
    expect(written[0]?.body.participants).toEqual([
      { model: { provider: 'openrouter', model: 'a/b' }, label: 'B' },
      { model: { provider: 'openrouter', model: 'c/d' }, label: 'D' },
    ])
    expect(useRoster.getState().byConversation.c1?.unsaved).toBe(false)
  })

  test('a seat chosen while the write was on its way goes up after it, against the revision that write moved to', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await theoremWith([], 0, undefined, false, held)
    open('c1', 't1')
    await readConversationRoster('c1', 't1')
    const roster = useRoster.getState()
    roster.addModel('c1', 'openrouter/a/b', 'B')
    const writing = saveRoster('c1')
    while (!written.length)
      await new Promise((resolve) => setTimeout(resolve, 0))
    // The seat is chosen while the first write is still away.
    roster.addModel('c1', 'openrouter/c/d', 'D')
    release()
    await writing
    expect(written.map((write) => write.body)).toEqual([
      {
        expectedRosterRevision: 0,
        participants: [
          { model: { provider: 'openrouter', model: 'a/b' }, label: 'B' },
        ],
      },
      // The revision the first write moved to, and the room as it now stands.
      {
        expectedRosterRevision: 1,
        participants: [
          {
            participantId: 'ptc_new0',
            model: { provider: 'openrouter', model: 'a/b' },
            label: 'B',
          },
          { model: { provider: 'openrouter', model: 'c/d' }, label: 'D' },
        ],
      },
    ])
    expect(useRoster.getState().byConversation.c1?.unsaved).toBe(false)
    // The lead is still the seat the last pick acted on, followed across the
    // ids Theorem minted for the seats that write carried.
    expect(rosterLeadRef()).toBe('openrouter/c/d')
  })

  test('a seat chosen while the thread was being read survives the read', async () => {
    await theoremWith([wire('ptc_b', 'openrouter', 'a/b', 'B')], 3)
    open('c1', 't1')
    const reading = readConversationRoster('c1', 't1')
    useRoster.getState().addModel('c1', 'openrouter/c/d', 'D')
    await reading
    // The read takes the revision the thread stands at and keeps the chosen seat.
    expect(useRoster.getState().byConversation.c1?.roster.revision).toBe(3)
    expect(seats('c1').map((part) => refOf(part.model))).toEqual([
      'openrouter/c/d',
    ])
    await saveRoster('c1')
    expect(written[0]?.body.expectedRosterRevision).toBe(3)
    expect(written[0]?.body.participants).toEqual([
      { model: { provider: 'openrouter', model: 'c/d' }, label: 'D' },
    ])
  })
})
