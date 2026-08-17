import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { createServer } from './createServer.js'
import type { HomeCache } from '../homey/cache.js'
import { detectCapabilities } from '../homey/registry.js'
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
 * A connection whose capability probe can be made to answer for real.
 *
 * The registration gate reads what `detectCapabilities` wrote, so the tests
 * below run the actual probe rather than hand-building a registry: the pair of
 * them is what decides whether a tool exists, and a hand-built fixture would
 * pass while the two halves disagreed.
 */
function probingConnection(advancedFlowFails: () => Error): HomeyConnection {
  return {
    ...fakeConnection(),
    api: {
      flow: {
        getAdvancedFlows: async () => {
          throw advancedFlowFails()
        },
      },
      energy: { getLiveReport: async () => ({}) },
      moods: { getMoods: async () => [] },
      insights: { getLogs: async () => [], getStorageInfo: async () => ({}) },
      logic: { getVariables: async () => [] },
      call: async () => ({}),
    },
  }
}

/** Measured on the hardware: an absent method is HTTP 500 with a bracketed code, not a 404. */
function missingApiMethod(): Error & { statusCode: number } {
  return Object.assign(new Error('Er is een onbekende fout opgetreden [missing_api_method]'), { statusCode: 500 })
}

/** Measured on the hardware: four rapid requests are enough to be turned away. */
function rateLimited(): Error & { statusCode: number } {
  return Object.assign(new Error('Too many requests'), { statusCode: 429 })
}

async function probedCapabilities(advancedFlowFails: () => Error): Promise<CapabilityRegistry> {
  return detectCapabilities(probingConnection(advancedFlowFails), { logger: createLogger({ level: 'silent' }) })
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
      // First on purpose: the only tool that works with no session, and the
      // state a model has to leave before any other tool can do anything.
      'homey_authenticate',
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

    // Anchored on the first tool of the group rather than on a fixed index. The
    // hardcoded slice this replaced broke the moment a tool was added anywhere
    // ahead of it, which says nothing about grouping and sends the reader to the
    // wrong place.
    const controlStart = names.indexOf('homey_device_set_capability')
    expect(controlStart).toBeGreaterThan(-1)
    expect(names.slice(controlStart, controlStart + 3)).toEqual([
      'homey_device_set_capability',
      'homey_variable_set',
      'homey_flow_start',
    ])
    expect(names.indexOf('homey_flows_list')).toBeGreaterThan(names.indexOf('homey_flow_start'))
  })

  it('registers the tools in a fixed order', async () => {
    const first = await buildClient(CAPABILITIES)
    const second = await buildClient(CAPABILITIES)

    const firstNames = (await first.listTools()).tools.map((tool) => tool.name)
    const secondNames = (await second.listTools()).tools.map((tool) => tool.name)

    expect(firstNames).toEqual(secondNames)
    expect(firstNames[0]).toBe('homey_authenticate')
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

  // The gate itself, from the probe that decides it. Nothing pinned this before,
  // and both directions of it are load-bearing: the registry is built once at
  // startup and never rebuilt, so whichever way this branch goes, it goes that
  // way for the life of the process.
  describe('the Advanced Flow registration gate', () => {
    it('still registers the tools when the probe failed rather than answered', async () => {
      // This hub rate limits its own local API, so a probe can fail on a feature
      // that works. Refusing to register on that hides working tools for the
      // whole session, and the model is told the hardware cannot author flows.
      const capabilities = await probedCapabilities(rateLimited)
      expect(capabilities.probes?.['advancedFlow']?.status).toBe('failed')
      expect(capabilities.hardware.advancedFlow).toBeNull()

      const names = (await (await buildClient(capabilities)).listTools()).tools.map((tool) => tool.name)

      expect(names).toContain('homey_advancedflow_create')
      expect(names).toContain('homey_advancedflow_update')
    })

    it('leaves them out when the hub answered that the route is absent', async () => {
      // The other half. Keeping an unsettled probe registered is only correct as
      // long as a real verdict about the hardware still closes the door.
      const capabilities = await probedCapabilities(missingApiMethod)
      expect(capabilities.probes?.['advancedFlow']?.status).toBe('unsupported')
      expect(capabilities.hardware.advancedFlow).toBe(false)

      const names = (await (await buildClient(capabilities)).listTools()).tools.map((tool) => tool.name)

      expect(names).not.toContain('homey_advancedflow_create')
      expect(names).not.toContain('homey_advancedflow_update')
    })
  })
})
