// Assembling the MCP server.
//
// Three things happen here and nowhere else.
//
// The capability probe runs once, at startup. Every tool then reads the answer
// from the registry instead of discovering the hub's limits by failing against
// them, and the tools for a feature this hub does not have are never registered
// at all. A tool that is not registered cannot be called, which is a much
// clearer answer than a tool that is always there and always fails.
//
// Tool modules are registered in a fixed order. The order a client sees tools in
// is the order they were registered, and a list that reshuffles between runs
// makes a model's behaviour irreproducible.
//
// Annotations are set on every tool. In the MCP SDK `destructiveHint` and
// `openWorldHint` default to TRUE, so an unannotated read tool is presented to
// the user as a destructive call to an external system and prompts on every
// single invocation. The shared annotation constants below exist so that is
// stated once rather than remembered fifteen times.

import { readFileSync } from 'node:fs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

import { createAskFunction, isElicitationSupported } from './ask.js'
import type { ServerContext } from './context.js'
import { buildServerInstructions } from './instructions.js'
import type { HomeCache } from '../homey/cache.js'
import { createHomeCache } from '../homey/cache.js'
import { detectCapabilities } from '../homey/registry.js'
import type { CapabilityRegistry, HomeyConnection } from '../homey/types.js'
import type { Logger } from '../util/log.js'
import { logger as defaultLogger } from '../util/log.js'

/**
 * For a tool that only reads. All three hints matter: without them the client
 * treats the call as destructive and as reaching an open world, and asks the
 * user to confirm reading a temperature.
 */
export const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/** For a tool that changes something but does not remove anything, such as creating a flow. */
export const WRITE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

/**
 * For a tool that overwrites one piece of state, such as a dim level or a variable.
 *
 * `destructiveHint` is true because the previous value is gone and clients use
 * the hint to decide whether to ask the user first. `idempotentHint` is true
 * because sending the same value twice leaves the house in the same state.
 */
export const OVERWRITE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}

/**
 * For a tool that removes something, or that has a fresh effect on the house
 * every time it is called. Deleting a flow and starting one both qualify: a
 * deleted flow is gone from the hub, and every start runs the flow's actions
 * again, so neither is undone by calling it a second time.
 */
export const DESTRUCTIVE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

export interface CreateServerOptions {
  connection: HomeyConnection
  logger?: Logger
  /** A registry that was already probed, for example by `doctor`. Probed here when omitted. */
  capabilities?: CapabilityRegistry
  /** An existing cache. One cache per connection: a second one doubles every read. */
  cache?: HomeCache
  askTimeoutMs?: number
  /** The version reported in the MCP handshake. Read from package.json when omitted. */
  version?: string
}

export interface CreatedServer {
  server: McpServer
  context: ServerContext
  capabilities: CapabilityRegistry
  /** Which tool modules were registered, in registration order. Reported by `doctor`. */
  registeredModules: string[]
}

export async function createServer(options: CreateServerOptions): Promise<CreatedServer> {
  const logger = (options.logger ?? defaultLogger).child('server')
  const connection = options.connection

  const capabilities =
    options.capabilities ?? (await detectCapabilities(connection, { logger: logger.child('capabilities') }))

  const cache = options.cache ?? createHomeCache(connection, { logger: logger.child('cache'), capabilities })

  const server = new McpServer(
    {
      name: 'homey-mcp',
      title: 'Homey Bridge (unofficial)',
      version: options.version ?? readPackageMetadata().version,
    },
    {
      instructions: buildServerInstructions({
        identity: connection.identity,
        dialect: connection.dialect,
        capabilities,
      }),
    },
  )

  const ask = createAskFunction({
    server,
    logger: logger.child('ask'),
    ...(options.askTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.askTimeoutMs }),
  })

  const context: ServerContext = {
    connection,
    cache,
    capabilities,
    logger,
    ask,
    // A getter, not a captured boolean: the client's capabilities are only known
    // once it has completed the handshake, which happens after this object is
    // built and handed to the tool modules.
    get askSupported() {
      return isElicitationSupported(server)
    },
  }

  const registeredModules = await registerToolModules(server, context)

  logger.info('MCP server ready', {
    tools: registeredModules,
    homey: connection.identity.modelName,
    dialect: connection.dialect,
  })

  return { server, context, capabilities, registeredModules }
}

/**
 * Registers every tool module in a fixed order: overview, devices, flows, flow
 * cards, advanced flows, insights, energy, diagnostics.
 *
 * That is an order over MODULES, and each module keeps its own tools together,
 * so the list a client sees is grouped by subject rather than by how dangerous a
 * tool is. `homey_device_set_capability`, `homey_variable_set` and
 * `homey_flow_start` therefore sit at positions four to six, next to the device
 * and flow reads they belong with and ahead of `homey_flows_list`. That is on
 * purpose: a model looking for what it can do with a device reads one
 * contiguous block, and the annotations, not the position in the list, are what
 * tell a client which calls change the house. The comment used to promise "read
 * tools first, then control", which the list has never done.
 *
 * The modules are imported here rather than at the top of the file so that the
 * paths that never build a server do not drag the whole tool graph in with them.
 * `doctor` and `setup` both need this module for the package version alone, and
 * neither should be loading eight tool modules and their dependencies to answer
 * a question about credentials.
 */
async function registerToolModules(server: McpServer, context: ServerContext): Promise<string[]> {
  const registered: string[] = []

  const register = (name: string, registerModule: (server: McpServer, context: ServerContext) => void): void => {
    registerModule(server, context)
    registered.push(name)
  }

  const [overview, devices, flows, flowCards, insights, energy, doctor] = await Promise.all([
    import('./tools/overview.js'),
    import('./tools/devices.js'),
    import('./tools/flows.js'),
    import('./tools/flowcards.js'),
    import('./tools/insights.js'),
    import('./tools/energy.js'),
    import('./tools/doctor.js'),
  ])

  register('overview', overview.registerOverviewTools)
  register('devices', devices.registerDevicesTools)
  register('flows', flows.registerFlowTools)
  register('flowcards', flowCards.registerFlowCardTools)

  // Advanced Flow is both a firmware feature and a paid unlock on the older
  // hardware, so its tools are registered only where the probe actually found
  // the route. A tool that is absent is a much clearer answer to the model than
  // a tool that is always present and always fails.
  if (context.capabilities.hardware.advancedFlow) {
    register('advancedflows', flows.registerAdvancedFlowTools)
  } else {
    context.logger.info('Advanced flow tools were not registered: this Homey does not offer Advanced Flows')
  }

  register('insights', insights.registerInsightsTools)
  register('energy', energy.registerEnergyTools)
  register('doctor', doctor.registerDoctorTools)

  return registered
}

export interface PackageMetadata {
  name: string
  version: string
}

let cachedPackageMetadata: PackageMetadata | null = null

/**
 * Reads the published name and version out of package.json at runtime.
 *
 * Not imported as a module: `rootDir` is `src`, so importing a file above it
 * would move the compiled output into a nested directory and break the `bin`
 * path. Reading it relative to this module works from both `src` and `dist`.
 */
export function readPackageMetadata(): PackageMetadata {
  if (cachedPackageMetadata !== null) return cachedPackageMetadata

  try {
    const contents = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(contents) as { name?: unknown; version?: unknown }
    cachedPackageMetadata = {
      name: typeof parsed.name === 'string' ? parsed.name : 'homey-mcp',
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
    }
  } catch {
    // Reporting an unknown version is honest. Inventing a plausible one would
    // send a bug report chasing a release that was never installed.
    cachedPackageMetadata = { name: 'homey-mcp', version: 'unknown' }
  }

  return cachedPackageMetadata
}
