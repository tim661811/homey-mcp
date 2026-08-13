// The overview is the first thing a model sees, so these tests pin two things:
// that it orients (the zone tree nests, the counts add up, a broken app is
// visible) and that it stays small (no raw device record, no icon, no image, no
// device setting ever reaches the result).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createHomeCache } from '../../homey/cache.js'
import { HomeyMcpError } from '../../homey/errors.js'
import { createLogger } from '../../util/log.js'
import type { CapabilityRegistry, HomeyConnection } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import { buildZoneTree, registerOverviewTools } from './overview.js'

// ---------------------------------------------------------------------------
// Fixture and harness
// ---------------------------------------------------------------------------

interface HomeFixture {
  zones: Record<string, unknown>
  devices: Record<string, unknown>
  flows: Record<string, unknown>
  advancedFlows: Record<string, unknown>
  flowFolders: Record<string, unknown>
  logicVariables: Record<string, unknown>
  apps: Record<string, unknown>
  users: Record<string, unknown>
  systemInfo: Record<string, unknown>
}

const homeFixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/home-sample.json', import.meta.url), 'utf8'),
) as HomeFixture

interface FakeManagerOverrides {
  getApps?: () => Promise<unknown>
  getUsers?: () => Promise<unknown>
  getDevices?: () => Promise<unknown>
  getFlows?: () => Promise<unknown>
  getAdvancedFlows?: () => Promise<unknown>
  getVariables?: () => Promise<unknown>
}

interface TestHarness {
  context: ServerContext
  requestLabels: string[]
}

function createCapabilityRegistry(): CapabilityRegistry {
  return {
    hardware: { advancedFlow: true, energyReports: false, moods: false, insights: true },
    probedAt: '2026-08-13T08:00:00.000Z',
    notes: ['Historical energy reports are not available on this Homey.'],
    probes: {
      advancedFlow: {
        status: 'available',
        probe: 'flow.getAdvancedFlows',
        statusCode: 200,
        durationMs: 30,
        detail: null,
      },
      energyReports: {
        status: 'unsupported',
        probe: 'GET /api/manager/energy/reports/available',
        statusCode: 404,
        durationMs: 21,
        detail: 'The route is absent on this firmware.',
      },
    },
  }
}

function createTestHarness(overrides: FakeManagerOverrides = {}): TestHarness {
  const requestLabels: string[] = []

  const managers = {
    devices: { getDevices: overrides.getDevices ?? (async () => homeFixture.devices) },
    zones: { getZones: async () => homeFixture.zones },
    flow: {
      getFlows: overrides.getFlows ?? (async () => homeFixture.flows),
      getAdvancedFlows: overrides.getAdvancedFlows ?? (async () => homeFixture.advancedFlows),
      getFlowFolders: async () => homeFixture.flowFolders,
    },
    logic: { getVariables: overrides.getVariables ?? (async () => homeFixture.logicVariables) },
    insights: { getLogs: async () => ({}) },
    apps: { getApps: overrides.getApps ?? (async () => homeFixture.apps) },
    users: { getUsers: overrides.getUsers ?? (async () => homeFixture.users) },
    system: { getInfo: async () => homeFixture.systemInfo },
  }

  const connection: HomeyConnection = {
    api: managers,
    dialect: 'v2',
    identity: {
      id: 'homey-under-test',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: 1,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: 'https://homey.example.invalid',
      addressKind: 'localSecure',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation, label) => {
      requestLabels.push(label)
      return operation()
    },
  }

  const logger = createLogger({ level: 'silent' })
  const capabilities = createCapabilityRegistry()
  const cache = createHomeCache(connection, { logger, capabilities })

  return {
    requestLabels,
    context: {
      connection,
      cache,
      capabilities,
      logger,
      ask: async () => ({ answered: false, value: null, declined: false }),
      askSupported: false,
    },
  }
}

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

interface RegisteredTestTool {
  config: { annotations?: Record<string, unknown>; description?: string }
  handler: ToolHandler
}

function createServerStub(): { server: McpServer; tools: Map<string, RegisteredTestTool> } {
  const tools = new Map<string, RegisteredTestTool>()
  const server = {
    registerTool(name: string, config: RegisteredTestTool['config'], handler: ToolHandler) {
      tools.set(name, { config, handler })
      return {}
    },
  } as unknown as McpServer
  return { server, tools }
}

function takeTool(tools: Map<string, RegisteredTestTool>, name: string): RegisteredTestTool {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`The tool ${name} was never registered`)
  return tool
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured === undefined) throw new Error('The tool returned no structured content')
  return structured
}

/**
 * The error half of a failed tool result.
 *
 * Failures come back as `isError` results carrying `{ ok: false, error: {...} }`
 * rather than as thrown protocol errors, so the model can read the reason and
 * correct itself.
 */
function failureOf(result: CallToolResult): Record<string, unknown> {
  return (structuredOf(result)['error'] ?? {}) as Record<string, unknown>
}

/** The result's text block, which is the part a person actually reads. */
function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

function section(result: CallToolResult, name: string): Record<string, unknown> {
  const value = structuredOf(result)[name]
  if (value === null || typeof value !== 'object') throw new Error(`The overview has no ${name} section`)
  return value as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('homey_home_overview', () => {
  it('is annotated as a read-only tool', () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    expect(takeTool(tools, 'homey_home_overview').config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  it('returns every section by default', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const structured = structuredOf(await takeTool(tools, 'homey_home_overview').handler({}))

    expect(structured['ok']).toBe(true)
    for (const name of ['home', 'zones', 'devices', 'apps', 'variables', 'presence', 'flows', 'capabilities']) {
      expect(structured[name]).toBeDefined()
    }
  })

  it('nests the zone tree and counts devices below each zone', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const zones = section(await takeTool(tools, 'homey_home_overview').handler({ include: ['zones'] }), 'zones')
    const tree = zones['tree'] as Array<Record<string, unknown>>

    const home = tree.find((zone) => zone['name'] === 'Home')
    expect(home).toBeDefined()

    const livingRoom = (home?.['children'] as Array<Record<string, unknown>>).find(
      (zone) => zone['name'] === 'Living room',
    )
    expect(livingRoom?.['deviceCount']).toBe(2)
    // The lamp and the plug sit in the living room, the speaker sits in the
    // nook below it.
    expect(livingRoom?.['deviceCountIncludingChildren']).toBe(3)
    expect((livingRoom?.['children'] as Array<Record<string, unknown>>)[0]?.['name']).toBe('Reading nook')
  })

  it('keeps a zone whose parent is missing, rather than dropping its devices', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const zones = section(await takeTool(tools, 'homey_home_overview').handler({ include: ['zones'] }), 'zones')
    const tree = zones['tree'] as Array<Record<string, unknown>>

    expect(tree.map((zone) => zone['name'])).toContain('Attic')
    expect(zones['count']).toBe(5)
  })

  it('survives a zone parent cycle', () => {
    const first = { id: 'first', name: 'First', parentZoneId: 'second', order: 1, active: false, activeLastUpdated: null, icon: null, raw: {} }
    const second = { id: 'second', name: 'Second', parentZoneId: 'first', order: 2, active: false, activeLastUpdated: null, icon: null, raw: {} }
    const zones = { all: [first, second], byId: new Map([['first', first], ['second', second]]), fetchedAt: 0 }
    const devices = { all: [], byId: new Map(), fetchedAt: 0 }

    // Both zones claim the other as a parent, so neither is a root. The tree is
    // empty rather than infinite, which is the outcome that matters.
    expect(buildZoneTree(zones, devices)).toEqual([])
  })

  it('counts devices by the class the owner sees, not the declared one', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const devices = section(await takeTool(tools, 'homey_home_overview').handler({ include: ['devices'] }), 'devices')
    const byClass = devices['byClass'] as Array<{ name: string; count: number }>

    // The plug is declared `other` and overridden to `socket` in the app.
    expect(byClass.map((entry) => entry.name)).toContain('socket')
    expect(byClass.map((entry) => entry.name)).not.toContain('other')
    expect(devices['count']).toBe(5)
    expect(devices['unavailableCount']).toBe(1)
  })

  it('names the devices Homey cannot reach and why', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const devices = section(await takeTool(tools, 'homey_home_overview').handler({ include: ['devices'] }), 'devices')
    const unavailable = devices['unavailable'] as Array<Record<string, unknown>>

    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]?.['name']).toBe('Attic door sensor')
    expect(unavailable[0]?.['unavailableMessage']).toBe('Battery is empty')
  })

  it('truncates the capability histogram at the limit and says so', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const devices = section(
      await takeTool(tools, 'homey_home_overview').handler({ include: ['devices'], limit: 2 }),
      'devices',
    )

    expect((devices['topCapabilities'] as unknown[]).length).toBe(2)
    expect(devices['capabilitiesTruncated']).toBe(true)
  })

  it('projects apps down to state and drops their contact details and artwork', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const result = await takeTool(tools, 'homey_home_overview').handler({ include: ['apps'] })
    const apps = section(result, 'apps')

    expect(apps['count']).toBe(3)
    expect(apps['crashedCount']).toBe(1)
    expect(apps['updateAvailableCount']).toBe(1)
    expect(JSON.stringify(apps)).not.toContain('example.invalid')
    expect(JSON.stringify(apps)).not.toContain('icon')
  })

  it('reports presence without the account identifiers that come with it', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const presence = section(await takeTool(tools, 'homey_home_overview').handler({ include: ['presence'] }), 'presence')

    expect(presence['count']).toBe(2)
    expect(presence['presentCount']).toBe(1)
    expect(JSON.stringify(presence)).not.toContain('athomId')
    expect(JSON.stringify(presence)).not.toContain('properties')
  })

  it('keeps going when presence is refused', async () => {
    const harness = createTestHarness({
      getUsers: async () => {
        throw new HomeyMcpError('missing_scope', 'This session cannot read household members.')
      },
    })
    const { server, tools } = createServerStub()
    registerOverviewTools(server, harness.context)

    const result = await takeTool(tools, 'homey_home_overview').handler({ include: ['presence', 'devices'] })

    expect(result.isError).toBeUndefined()
    expect(section(result, 'presence')['available']).toBe(false)
    expect(section(result, 'devices')['count']).toBe(5)
  })

  it('keeps going when this hub has no logic variables route', async () => {
    // `logic.getVariables` is a probed capability, so it is not a given. This
    // one call used to be unguarded in the middle of the overview, which meant a
    // hub without the route lost the zone tree, the devices and the flow counts
    // as well, while apps and presence beside it degraded in place.
    const harness = createTestHarness({
      getVariables: async () => {
        throw Object.assign(new Error('Not Found'), { statusCode: 404 })
      },
    })
    const { server, tools } = createServerStub()
    registerOverviewTools(server, harness.context)

    const result = await takeTool(tools, 'homey_home_overview').handler({ include: ['variables', 'devices'] })

    expect(result.isError).toBeUndefined()
    expect(section(result, 'variables')['available']).toBe(false)
    expect(section(result, 'devices')['count']).toBe(5)
    // This route takes no name and no id, so its "not found" can only be the
    // route itself. Reported as a missing item it told the caller to check a
    // name it never sent.
    expect(String(section(result, 'variables')['reason'])).toContain('does not offer that feature')
    expect(String(section(result, 'variables')['reason'])).not.toContain('Check the name or id')
  })

  it('never returns the hub id, which is its public Athom cloud address', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const result = await takeTool(tools, 'homey_home_overview').handler({})
    const home = section(result, 'home')

    // The identity id is the Athom cloud id, which is also the host part of
    // https://<id>.connect.athom.com. homey_doctor already refuses to report it
    // and this tool has to agree: tool output stays in the conversation forever
    // and nothing in this server takes a Homey id as an argument.
    expect(home['id']).toBeUndefined()
    expect(JSON.stringify(structuredOf(result))).not.toContain('homey-under-test')
    // The parts that do help a model reason are still there.
    expect(home['name']).toBe('Test Home')
    expect(home['modelId']).toBe('homey4d')
  })

  it('counts standard and advanced flows separately', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const flows = section(await takeTool(tools, 'homey_home_overview').handler({ include: ['flows'] }), 'flows')

    expect(flows['count']).toBe(4)
    expect(flows['standardCount']).toBe(3)
    expect(flows['advancedCount']).toBe(1)
    expect(flows['brokenCount']).toBe(1)
    expect(flows['disabledCount']).toBe(1)
  })

  it('says the broken flag is not reported rather than counting a confident zero', async () => {
    // Both flow transforms delete `broken` on the V2 firmware, so on the
    // measured hub every flow arrives without it. Counting an absent flag as
    // healthy told the owner "0 broken" about a hub that had said nothing.
    const withoutTheFlag = (source: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(source as Record<string, Record<string, unknown>>).map(([id, flow]) => {
          const { broken: _dropped, ...rest } = flow
          return [id, rest]
        }),
      )

    const { server, tools } = createServerStub()
    const harness = createTestHarness({
      getFlows: async () => withoutTheFlag(homeFixture.flows),
      getAdvancedFlows: async () => withoutTheFlag(homeFixture.advancedFlows),
    })
    registerOverviewTools(server, harness.context)

    const result = await takeTool(tools, 'homey_home_overview').handler({ include: ['flows'] })
    const flows = section(result, 'flows')

    expect(flows['brokenReportedByHomey']).toBe(false)
    expect(flows['brokenCount']).toBe(0)
    expect(textOf(result)).toContain('does not report which flows are broken')
    expect(textOf(result)).not.toContain('0 broken')
  })

  it('asks the hub for nothing when only the capability registry is wanted', async () => {
    const harness = createTestHarness()
    const { server, tools } = createServerStub()
    registerOverviewTools(server, harness.context)

    await takeTool(tools, 'homey_home_overview').handler({ include: ['capabilities', 'home'] })

    expect(harness.requestLabels).toEqual([])
  })

  it('reads each collection once for a full overview', async () => {
    const harness = createTestHarness()
    const { server, tools } = createServerStub()
    registerOverviewTools(server, harness.context)

    await takeTool(tools, 'homey_home_overview').handler({})

    expect(harness.requestLabels.filter((label) => label === 'devices.getDevices')).toHaveLength(1)
    expect(harness.requestLabels.filter((label) => label === 'zones.getZones')).toHaveLength(1)
  })

  it('never leaks a raw device record into the result', async () => {
    const { server, tools } = createServerStub()
    registerOverviewTools(server, createTestHarness().context)

    const serialised = JSON.stringify(structuredOf(await takeTool(tools, 'homey_home_overview').handler({})))

    // Each of these is a real field on a real device record and each is noise or
    // worse: `passwd` is where one device on the measured hub stores its account
    // password.
    for (const forbidden of ['passwd', 'iconObj', 'capabilitiesObj', 'componentsStartAt', 'internalReference']) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('reports a hub failure as an error result rather than throwing', async () => {
    const harness = createTestHarness({
      getDevices: async () => {
        throw new Error('Too many requests')
      },
    })
    const { server, tools } = createServerStub()
    registerOverviewTools(server, harness.context)

    const result = await takeTool(tools, 'homey_home_overview').handler({ include: ['devices'] })

    expect(result.isError).toBe(true)
    // "Too many requests" is the measured rate limit, which carries its own
    // reason apart from the other transient failures.
    expect(failureOf(result)['reason']).toBe('rate_limited')
    expect(failureOf(result)['retryable']).toBe(true)
  })
})
