// What a model calls when something is failing.
//
// Every check answers three things: what was tested, whether it passed, and what
// to do next. A check that reports "energy reports: false" and stops is useless,
// because the caller cannot tell a missing feature apart from a broken session.
//
// None of those checks are written here. They come from `collectDoctorReport`,
// the same collector the `doctor` subcommand runs, called with this server's own
// connection, cache and capability registry so no second login and no second
// probe happen. The two doctors used to build their own lists and disagreed
// about the same hub: a probe that merely failed was a warning in one and a
// failure in the other. Sharing the collector is what makes that impossible
// rather than merely unlikely.
//
// What is different here is `forSharing`. Nothing this tool returns names a
// device, zone, flow or user, and nothing says where the household is either: no
// network address, no Athom cloud id (it is the hub's public connect URL) and no
// filesystem path (it carries the account name of whoever is running this). Only
// the KIND of each is reported: which address kind answered, which credential
// source was used. That is a property of the collector rather than a scrub
// applied afterwards, so a check added later cannot leak by being forgotten
// here. The full detail is worth having while debugging, and it is in
// "npx homey-mcp doctor", which prints to the user's own terminal instead of
// into a conversation that is kept forever.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { collectDoctorReport } from '../../cli/doctor.js'
import type { AddressProbeResult } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import { failureResult } from '../errors.js'
import { successResult } from '../render.js'

export function registerDoctorTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_doctor',
    {
      title: 'Diagnose the Homey connection',
      description: [
        'Reports what is and is not working between this server and your Homey:',
        'which kind of address answered and how it was chosen, which kind of credential source was used (never the credential itself),',
        'the hardware model and firmware, which features this Homey generation actually supports and why,',
        'whether the official Homey CLI is installed and signed in (which is what decides whether flows can be created),',
        'and how much of the home has been read so far.',
        'Call this when another Homey tool fails, or before reporting a problem.',
        'Every check comes with a concrete next step. Safe to paste into a public issue: no device, zone or household names,',
        'no network addresses, no Homey id and no file paths. Run "npx homey-mcp doctor" in a terminal for the version that keeps those.',
      ].join(' '),
      inputSchema: {
        includeInventory: z
          .boolean()
          .optional()
          .describe(
            'Count devices, zones, flows, flow cards, Insights logs and variables. Costs a few requests, and the flow card catalogue is the large one. Defaults to true.',
          ),
        includeSystem: z
          .boolean()
          .optional()
          .describe('Ask the hub for memory, uptime and Node version. Defaults to true.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        return await runDoctorTool(context, {
          includeInventory: args.includeInventory !== false,
          includeSystem: args.includeSystem !== false,
        })
      } catch (error) {
        return failureResult(error, { operation: 'homey_doctor', logger: context.logger })
      }
    },
  )
}

interface DoctorOptions {
  includeInventory: boolean
  includeSystem: boolean
}

async function runDoctorTool(context: ServerContext, options: DoctorOptions): Promise<CallToolResult> {
  const report = await collectDoctorReport({
    // Everything the running server already has. Handing all three in is what
    // keeps this to zero extra logins and zero extra capability probes.
    connection: context.connection,
    capabilities: context.capabilities,
    cache: context.cache,
    logger: context.logger.child('doctor'),
    forSharing: true,
    includeSystem: options.includeSystem,
    skipInventory: !options.includeInventory,
    // Only this side has a live queue to report: the subcommand builds a fresh
    // connection and would always report an idle one.
    includeQueue: true,
  })

  const { checks } = report
  const failures = checks.filter((check) => check.status === 'fail')
  const warnings = checks.filter((check) => check.status === 'warn')
  const headline =
    failures.length > 0
      ? `${failures.length} checks failed and ${warnings.length} raised a warning.`
      : warnings.length > 0
        ? `Everything essential works. ${warnings.length} checks raised a warning.`
        : 'Everything checked out.'

  const summary = [
    headline,
    ...checks
      .filter((check) => check.status !== 'pass')
      .map(
        (check) =>
          `${check.status.toUpperCase()} ${check.title}: ${check.detail}${check.fix === null ? '' : ` Next: ${check.fix}`}`,
      ),
  ].join('\n')

  const { identity } = context.connection

  return successResult(summary, {
    status: failures.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    checks,
    serverVersion: report.serverVersion,
    nodeVersion: report.nodeVersion,
    credentialSource: report.credentialSource,
    connectionRoute: report.connectionRoute,
    hardware: {
      modelId: identity.modelId,
      modelName: identity.modelName,
      softwareVersion: identity.softwareVersion,
      platformVersion: identity.platformVersion,
      apiDialect: context.connection.dialect,
      timezone: identity.timezone,
      language: identity.language,
      // The address kind is the useful half and the address is the private half,
      // so only the kind is here. homey_home_overview makes the same call.
      addressKind: identity.addressKind,
    },
    capabilities: context.capabilities,
    // Whether the official CLI is present, and whether it holds a login, decides
    // whether the flow tools can write at all. The collector already withheld
    // the install path and the Homey's name for a shared report.
    homeyCli: report.homeyCli,
    addressProbes: report.addresses.map(summariseAddressProbe),
    inventory: report.inventory,
    cache: context.cache.describe(),
  })
}

/**
 * The four fields of a probe that diagnose something.
 *
 * The collector already withheld the address, the `X-Homey-ID` header and the
 * failure reason for a shared report, so this is a narrowing rather than a
 * scrub: it drops the fields that are now empty instead of returning them as
 * empty strings and nulls that a reader would have to interpret.
 */
function summariseAddressProbe(probe: AddressProbeResult): Record<string, unknown> {
  return {
    kind: probe.kind,
    reachable: probe.reachable,
    durationMs: probe.durationMs,
    statusCode: probe.statusCode,
  }
}
