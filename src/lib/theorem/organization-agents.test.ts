// SOURCING: none — bun:test over ./organization-agents' pure helpers with agents and packages built by hand
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  agentName,
  agentTurnOptions,
  chosenAgentId,
  forgetRemovedAgent,
  lineageLine,
  packageFileName,
  parsePackage,
  percent,
  reconcileChosenAgent,
  resolutionLine,
  useChosenAgent,
} from './organization-agents'
import type {
  AgentPackage,
  OrganizationAgent,
  OrganizationAgents,
} from './organization-agents'

const agent = (patch: Partial<OrganizationAgent> = {}): OrganizationAgent => ({
  agent_id: 'agent:ada',
  primary: false,
  profile: { name: 'Ada', representation: { kind: 'theo', reference: null } },
  lineage: [],
  knowledge: {},
  knowledge_resolution: {
    state: 'resolved',
    provider: 'rustyred.embedded',
    source: 'default',
  },
  ...patch,
})

describe('agentName', () => {
  test('uses the profile name, else Theo for the primary, else the id', () => {
    expect(agentName(agent())).toBe('Ada')
    expect(agentName(agent({ profile: null, primary: true }))).toBe('Theo')
    expect(agentName(agent({ profile: null }))).toBe('agent:ada')
  })
})

describe('lineageLine', () => {
  test('says nothing for an agent made here', () => {
    expect(lineageLine(agent())).toBeUndefined()
  })
  test('names the source of an imported copy', () => {
    expect(
      lineageLine(
        agent({
          lineage: [
            { kind: 'imported_copy', source_agent_id: 'agent:release' },
          ],
        }),
      ),
    ).toBe('Imported copy of agent:release')
  })
})

describe('resolutionLine', () => {
  test('says where knowledge lives and why', () => {
    expect(resolutionLine(agent().knowledge_resolution)).toBe(
      'Knowledge in rustyred.embedded, the default',
    )
    expect(
      resolutionLine({ state: 'resolved', provider: 'acme', source: 'host' }),
    ).toBe('Knowledge in acme, supplied by this host')
  })
  test('passes a failure on in Theorem’s words', () => {
    expect(
      resolutionLine({
        state: 'failed',
        binding: { provider: 'acme.vectors' },
        reason: 'acme.vectors is not on this host',
      }),
    ).toBe('acme.vectors is not on this host')
  })
})

const read = (
  organizationId: string | null,
  agents: OrganizationAgent[],
): OrganizationAgents => ({
  served: true,
  organizationId,
  revision: 1,
  multipleAgents: true,
  agents,
})

const theo = agent({ agent_id: 'agent:theo', primary: true, profile: null })
const ada = agent()
const bo = agent({ agent_id: 'agent:bo' })

/** As a fresh session finds it: a choice persisted earlier, nothing read yet. */
const persisted = (agentId: string | null, organizationId: string | null) =>
  useChosenAgent.setState({
    agentId,
    organizationId,
    confirmed: false,
    current: null,
  })

describe('agentTurnOptions', () => {
  beforeEach(() => persisted(null, null))
  test('declares nothing while the primary is chosen', () => {
    reconcileChosenAgent(read('org:a', [theo, ada]))
    expect(agentTurnOptions()).toEqual({})
  })
  test('declares the chosen further agent', () => {
    reconcileChosenAgent(read('org:a', [theo, ada]))
    useChosenAgent.getState().choose('agent:ada')
    expect(useChosenAgent.getState().organizationId).toBe('org:a')
    expect(agentTurnOptions()).toEqual({ agent: 'agent:ada' })
  })
  test('declares nothing for a persisted choice no read has confirmed', () => {
    persisted('agent:ada', 'org:a')
    expect(agentTurnOptions()).toEqual({})
    expect(chosenAgentId(useChosenAgent.getState())).toBeNull()
  })
})

describe('reconcileChosenAgent', () => {
  beforeEach(() => persisted(null, null))
  test('confirms a persisted choice this organization still has', () => {
    persisted('agent:ada', 'org:a')
    reconcileChosenAgent(read('org:a', [theo, ada]))
    expect(agentTurnOptions()).toEqual({ agent: 'agent:ada' })
  })
  test('drops a choice made in another organization', () => {
    persisted('agent:ada', 'org:a')
    reconcileChosenAgent(read('org:b', [theo, ada]))
    expect(useChosenAgent.getState().agentId).toBeNull()
    expect(agentTurnOptions()).toEqual({})
  })
  test('falls back to the primary when the agent is gone', () => {
    persisted('agent:ada', 'org:a')
    reconcileChosenAgent(read('org:a', [theo, bo]))
    expect(useChosenAgent.getState().agentId).toBeNull()
    expect(agentTurnOptions()).toEqual({})
  })
  test('falls back to the primary where agents are not served', () => {
    persisted('agent:ada', 'org:a')
    reconcileChosenAgent({ served: false })
    expect(useChosenAgent.getState().agentId).toBeNull()
    expect(agentTurnOptions()).toEqual({})
  })
  test('a later read without the agent withdraws a confirmed choice', () => {
    reconcileChosenAgent(read('org:a', [theo, ada]))
    useChosenAgent.getState().choose('agent:ada')
    reconcileChosenAgent(read('org:a', [theo]))
    expect(agentTurnOptions()).toEqual({})
  })
})

describe('forgetRemovedAgent', () => {
  beforeEach(() => {
    persisted(null, null)
    reconcileChosenAgent(read('org:a', [theo, ada, bo]))
  })
  test('falls back to the primary when the removed agent is still chosen', () => {
    useChosenAgent.getState().choose('agent:ada')
    forgetRemovedAgent('agent:ada')
    expect(useChosenAgent.getState().agentId).toBeNull()
  })
  test('keeps a choice made while the removal ran', () => {
    useChosenAgent.getState().choose('agent:ada')
    // The removal of Ada starts; meanwhile Bo is chosen; then the removal answers.
    useChosenAgent.getState().choose('agent:bo')
    forgetRemovedAgent('agent:ada')
    expect(agentTurnOptions()).toEqual({ agent: 'agent:bo' })
  })
})

describe('parsePackage', () => {
  test('refuses what is not JSON or not a package', () => {
    expect(() => parsePackage('nope')).toThrow('not JSON')
    expect(() => parsePackage('{"format":"other"}')).toThrow(
      'not a Theorem agent package',
    )
  })
  test('reads a package', () => {
    const text = JSON.stringify({
      format: 'theorem.agent-package',
      mode: 'template',
      package_hash: 'h',
      agent: { agent_id: 'agent:ada' },
    })
    expect(parsePackage(text).mode).toBe('template')
  })
})

describe('packageFileName', () => {
  const pkg = (name?: string): AgentPackage => ({
    format: 'theorem.agent-package',
    mode: 'template',
    package_hash: 'h',
    agent: {
      agent_id: 'agent:a',
      profile: name
        ? { name, representation: { kind: 'theo', reference: null } }
        : null,
    },
  })
  test('slugs the agent name', () => {
    expect(packageFileName(pkg('Release Desk!'))).toBe(
      'release-desk.theorem-agent.json',
    )
    expect(packageFileName(pkg())).toBe('agent.theorem-agent.json')
    expect(packageFileName(pkg('???'))).toBe('agent.theorem-agent.json')
  })
})

describe('percent', () => {
  test('rounds recall and shows a dash when nothing was expected', () => {
    expect(percent(0.666)).toBe('67%')
    expect(percent(null)).toBe('–')
  })
})
