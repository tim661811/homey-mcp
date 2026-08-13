import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { createServer } from './createServer.js'
import type { HomeCache } from '../homey/cache.js'
import type { CapabilityRegistry, HomeyConnection } from '../homey/types.js'
import { createLogger } from '../util/log.js'

const CAPABILITIES: CapabilityRegistry = {
  hardware: { advancedFlow: false, energyReports: false, moods: true, insights: true },
  probedAt: '2026-08-13T08:00:00.000Z',
  notes: [],
}

function fakeConnection(): HomeyConnection {
  return {
    api: {},
    dialect: 'v2',
    identity: {
      id: 'test-homey',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: 1,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: 'http://homey.invalid',
      addressKind: 'local',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }
}

/**
 * A cache that answers nothing. Registration must not touch the hub, so any call
 * from a tool module during registration should fail this test loudly rather
 * than quietly issue a request.
 */
function unusedCache(): HomeCache {
  const refuse = (): never => {
    throw new Error('The cache must not be read while tools are being registered')
  }
  return {
    getDevices: refuse,
    getZones: refuse,
    getFlows: refuse,
    getFlowFolders: refuse,
    getFlowCards: refuse,
    getAllFlowCards: refuse,
    getInsightsLogs: refuse,
    getLogicVariables: refuse,
    resolveDevice: refuse,
    resolveZone: refuse,
    resolveFlow: refuse,
    resolveLogicVariable: refuse,
    resolveInsightsLog: refuse,
    invalidate: () => {},
    describe: () => [],
  }
}

async function buildClient(capabilities: CapabilityRegistry): Promise<Client> {
  const { server } = await createServer({
    connection: fakeConnection(),
    capabilities,
    cache: unusedCache(),
    logger: createLogger({ level: 'silent' }),
    version: '0.0.0-test',
  })

  const client = new Client({ name: 'test-client', version: '0.0.0-test' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

describe('createServer', () => {
  it('sends instructions naming the hardware that answered', async () => {
    const client = await buildClient(CAPABILITIES)

    expect(client.getInstructions()).toContain('Homey Pro (Early 2019)')
    expect(client.getServerVersion()?.name).toBe('homey-mcp')
  })

  it('registers the whole tool surface exactly once, in the order the specification pins', async () => {
    const client = await buildClient({
      ...CAPABILITIES,
      hardware: { ...CAPABILITIES.hardware, advancedFlow: true },
    })
    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toEqual([
      'homey_home_overview',
      'homey_devices_search',
      'homey_device_get',
      'homey_device_set_capability',
      'homey_variable_set',
      'homey_flow_start',
      'homey_flows_list',
      'homey_flow_get',
      'homey_flow_validate',
      'homey_flow_create',
      'homey_flow_update',
      'homey_flow_delete',
      'homey_flowcards_search',
      'homey_flowcard_describe',
      'homey_flowcard_autocomplete',
      'homey_advancedflow_create',
      'homey_advancedflow_update',
      'homey_insights_search',
      'homey_insights_query',
      'homey_energy_live',
      'homey_weather',
      'homey_doctor',
    ])
    expect(new Set(names).size).toBe(names.length)
  })

  it('spells every hint out on every tool, because the SDK defaults two of them to true', async () => {
    const client = await buildClient({
      ...CAPABILITIES,
      hardware: { ...CAPABILITIES.hardware, advancedFlow: true },
    })

    for (const tool of (await client.listTools()).tools) {
      const annotations = tool.annotations
      expect(annotations, `${tool.name} carries no annotations`).toBeDefined()
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof annotations?.[hint], `${tool.name} leaves ${hint} to the SDK default`).toBe('boolean')
      }
      // Nothing here reaches past the hub on the local network.
      expect(annotations?.openWorldHint, tool.name).toBe(false)
    }
  })

  // The registration comment used to promise "read tools first, then control,
  // then authoring", which the list has never done: the three mutating tools sit
  // at positions four to six, ahead of two flow reads, because each module keeps
  // its own tools together. Pinned here so the comment and the list cannot drift
  // apart again without a test saying so.
  it('groups each module together, so a mutating tool sits with the reads for its subject', async () => {
    const client = await buildClient(CAPABILITIES)
    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names.slice(3, 6)).toEqual(['homey_device_set_capability', 'homey_variable_set', 'homey_flow_start'])
    expect(names.indexOf('homey_flows_list')).toBeGreaterThan(names.indexOf('homey_flow_start'))
  })

  it('registers the tools in a fixed order', async () => {
    const first = await buildClient(CAPABILITIES)
    const second = await buildClient(CAPABILITIES)

    const firstNames = (await first.listTools()).tools.map((tool) => tool.name)
    const secondNames = (await second.listTools()).tools.map((tool) => tool.name)

    expect(firstNames).toEqual(secondNames)
    expect(firstNames[0]).toBe('homey_home_overview')
  })

  it('annotates read tools so a client does not prompt before reading a temperature', async () => {
    const client = await buildClient(CAPABILITIES)
    const tools = (await client.listTools()).tools

    for (const name of ['homey_home_overview', 'homey_devices_search', 'homey_doctor']) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, `${name} is not registered`).toBeDefined()
      // All three matter: destructiveHint and openWorldHint default to true in
      // the SDK, so leaving them out marks a read tool as destructive.
      expect(tool?.annotations?.readOnlyHint, name).toBe(true)
      expect(tool?.annotations?.destructiveHint, name).toBe(false)
      expect(tool?.annotations?.openWorldHint, name).toBe(false)
    }
  })

  it('leaves the advanced flow tools out when the hub does not have them', async () => {
    const client = await buildClient(CAPABILITIES)
    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).not.toContain('homey_advancedflow_create')
    expect(names).not.toContain('homey_advancedflow_update')
  })

  it('registers the advanced flow tools when the hub does have them', async () => {
    const client = await buildClient({
      ...CAPABILITIES,
      hardware: { ...CAPABILITIES.hardware, advancedFlow: true },
    })
    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('homey_advancedflow_create')
    expect(names).toContain('homey_advancedflow_update')
  })
})
