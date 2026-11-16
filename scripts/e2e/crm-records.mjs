// The typed record API a CRM scenario drives, as the signed-in browser
// reaches it: GraphQL record verbs, and a reset that installs the built-in
// types and removes every record of them.
import { UI } from './config.mjs'
import { READ } from './lib.mjs'
import { turns } from './turns.mjs'

export const BUILT_IN = [
  'Person',
  'Organization',
  'Relationship',
  'Activity',
  'Commitment',
  'Interaction',
  'Goal',
  'Constraint',
]

const RECORD_VERB = `mutation RecordVerb($objectTypeId: String!, $verb: String!, $input: JSON!) {
  invokeRecordVerb(objectTypeId: $objectTypeId, verb: $verb, input: $input)
}`

/** Theorem's typed record API, as the signed-in browser reaches it. */
export function records(session) {
  const { writing } = turns(session)
  async function graphql(query, variables = {}) {
    const response = await session.context.request.fetch(`${UI}/graphql`, {
      ...READ,
      method: 'POST',
      headers: await writing({ 'Content-Type': 'application/json' }),
      data: { query, variables },
    })
    const body = await response.json().catch(() => ({}))
    if (body.errors?.length || !body.data)
      throw new Error(
        `GraphQL refused: ${JSON.stringify(body.errors ?? response.status())}`,
      )
    return body.data
  }
  const verb = async (objectTypeId, name, input) => {
    const out = (
      await graphql(RECORD_VERB, { objectTypeId, verb: name, input })
    ).invokeRecordVerb
    return out?.record ?? out
  }
  const types = async () =>
    (await graphql('{ dataModel(includeObserved: false) { objectTypes } }'))
      .dataModel.objectTypes
  return { graphql, types, verb }
}

/** Install the built-in types and remove every record of them, so a run starts clean. */
export async function reset(api) {
  await api.graphql('mutation { installLifeContextTypes }')
  const byName = Object.fromEntries(
    (await api.types()).map((type) => [type.name_singular, type]),
  )
  for (const name of BUILT_IN) {
    const type = byName[name]
    const page = await api.verb(type.object_type_id, 'find_many', {
      limit: 1000,
      offset: 0,
    })
    for (const record of page.records ?? [])
      await api.verb(type.object_type_id, 'delete_one', {
        id: record.id,
        expected_revision: record.version,
      })
  }
  return byName
}

