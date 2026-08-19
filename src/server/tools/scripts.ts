// HomeyScript: reading, writing and running scripts on the Homey.
//
// HomeyScript is an app, not a firmware feature, so unlike every other tool
// module here the thing these tools talk to may simply not be installed, and may
// be installed a minute from now. Each tool therefore checks before it acts and
// offers to install it, rather than the server deciding once at startup whether
// to register them at all.

import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { HomeyMcpError } from '../../homey/errors.js'
import {
  createScript,
  deleteScript,
  getScript,
  installHomeyScriptApp,
  listScripts,
  readHomeyScriptApp,
  runScript,
  updateScript,
} from '../../homey/homeyscript.js'
import type { ScriptRecord, ScriptSummary } from '../../homey/homeyscript.js'
import type { ServerContext } from '../context.js'
import {
  DESTRUCTIVE_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
} from '../createServer.js'
import { failureResult, invalidRequestResult } from '../errors.js'
import { renderKeyValueLines, renderTextBlock, successResult } from '../render.js'

/**
 * How a script should be written here, said in the place a model actually reads.
 *
 * A script with a device id baked into it works exactly once, for one house, and
 * silently stops working the moment that device is replaced. The reusable shape
 * costs nothing at write time and is the difference between a script that can be
 * given to a second Flow and one that has to be rewritten.
 */
const REUSABILITY_GUIDANCE = [
  'Write scripts to be reusable. Take what varies as an argument rather than baking it in: the HomeyScript Flow card passes text into the script as `args[0]`, so one script can serve several Flows and several rooms.',
  'Prefer looking a device up by what it IS over what its id is, for example by zone and capability, so the script survives a device being replaced.',
  'Prefer returning a value and letting the Flow act on it over acting inside the script. A script that answers "should I open the window" can be reused; one that also opens the window cannot.',
  'A hard-coded device id is acceptable when there is genuinely no other way, or when a lookup would be more fragile than the id. It is the exception, and it is worth a comment saying why.',
].join(' ')

/** UUIDs and Athom's 24 hex character ids, which is what a pasted device id looks like. */
const IDENTIFIER_PATTERN = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})\b/gi

/**
 * Ids that look hard-coded, reported rather than refused.
 *
 * A warning and not a rejection on purpose: the user's own rule is that a baked
 * in id is allowed where nothing else makes sense, so a tool that refused would
 * be enforcing something stricter than was asked for. What it must not do is let
 * one through silently.
 */
export function findHardCodedIdentifiers(code: string): string[] {
  return [...new Set(code.match(IDENTIFIER_PATTERN) ?? [])]
}

function hardCodedIdentifierWarning(code: string): string | null {
  const found = findHardCodedIdentifiers(code)
  if (found.length === 0) return null

  return [
    `This script has ${found.length === 1 ? 'an id' : `${found.length} ids`} written into it (${found.slice(0, 3).join(', ')}${found.length > 3 ? ', ...' : ''}).`,
    'That ties it to these exact devices and it will stop working when one is replaced.',
    'Take them as `args[0]` from the Flow card, or look the device up by zone and capability, unless there is a reason not to. If there is, say so in a comment in the script.',
  ].join(' ')
}

/**
 * Makes sure HomeyScript is there, installing it when the user says yes.
 *
 * Returns a result to hand straight back when the tool cannot continue, and null
 * when it can. The install is never silent: this project installs nothing
 * without an explicit yes, which is the same rule `setup` follows for the Homey
 * CLI.
 */
async function ensureHomeyScript(context: ServerContext): Promise<CallToolResult | null> {
  const app = await readHomeyScriptApp(context.connection)
  if (app.installed) return null

  if (context.askSupported) {
    const answer = await context.ask({
      question: 'HomeyScript is not installed on this Homey. Install it now? It is Athom\'s own free app, and it is what runs scripts.',
      choices: [
        { value: 'install', label: 'Install HomeyScript', description: 'Installs it from the Homey App Store' },
        { value: 'no', label: 'Not now', description: 'Nothing is installed and this call stops here' },
      ],
    })

    if (answer.answered && answer.value === 'install') {
      try {
        await installHomeyScriptApp(context.connection)
      } catch (error) {
        return failureResult(error, { operation: 'install the HomeyScript app', logger: context.logger })
      }

      // Installing is a download and a start, so the app is not usable the
      // instant the call returns. Saying that beats a second call that fails for
      // a reason nobody can act on.
      return successResult(
        'HomeyScript is being installed. Give it a moment to start, then run this again.',
        { ok: true, installed: true, ready: false },
      )
    }
  }

  return failureResult(
    new HomeyMcpError('unsupported_hardware', 'HomeyScript is not installed on this Homey, so there are no scripts to work with.', {
      suggestion: 'Install the free HomeyScript app from the Homey App Store, then try again.',
    }),
    { operation: 'reach HomeyScript' },
  )
}

function summariseScript(script: ScriptSummary): Record<string, unknown> {
  return { id: script.id, name: script.name, version: script.version, lastExecuted: script.lastExecuted }
}

function describeScript(script: ScriptSummary): string {
  const parts = [`"${script.name}" (${script.id})`]
  if (script.version !== null) parts.push(`version ${script.version}`)
  parts.push(script.lastExecuted === null ? 'never run' : `last run ${script.lastExecuted}`)
  return parts.join(', ')
}

interface ScriptResolution {
  script?: ScriptSummary
  failure?: CallToolResult
}

/**
 * Finds a script by id or by name.
 *
 * Names are not unique in HomeyScript, and ids are UUIDs nobody types, so the
 * ambiguous case is asked about rather than guessed. Silently taking the first
 * match would run the wrong script, and running the wrong script is not a read.
 */
async function resolveScript(context: ServerContext, reference: string): Promise<ScriptResolution> {
  const scripts = await listScripts(context.connection)

  const byId = scripts.find((script) => script.id === reference)
  if (byId !== undefined) return { script: byId }

  const wanted = reference.trim().toLowerCase()
  const byName = scripts.filter((script) => script.name.trim().toLowerCase() === wanted)
  if (byName.length === 1) return { script: byName[0] as ScriptSummary }

  if (byName.length > 1) {
    if (context.askSupported) {
      const answer = await context.ask({
        question: `Which script did you mean by "${reference}"?`,
        choices: byName.map((script) => ({
          value: script.id,
          label: script.name,
          description: script.lastExecuted === null ? 'never run' : `last run ${script.lastExecuted}`,
        })),
      })
      const chosen = byName.find((script) => script.id === answer.value)
      if (answer.answered && chosen !== undefined) return { script: chosen }
    }

    return {
      failure: invalidRequestResult(`"${reference}" matches ${byName.length} scripts. Say which one is meant, by id.`, {
        candidates: byName.map(summariseScript),
      }),
    }
  }

  return {
    failure: failureResult(
      new HomeyMcpError('not_found', `No HomeyScript script is called "${reference}".`, {
        suggestion: 'List them with homey_scripts_list and use the name or id it reports.',
      }),
      { operation: 'find a script' },
    ),
  }
}

function renderScript(script: ScriptRecord): string {
  return renderTextBlock([
    { heading: describeScript(script), lines: [] },
    { heading: 'Code', lines: script.code.split('\n') },
  ])
}

export function registerScriptTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_scripts_list',
    {
      title: 'List HomeyScript scripts',
      description: [
        'Lists every HomeyScript script on this Homey with its id, name, version and when it last ran.',
        'Scripts are small pieces of JavaScript that run on the Homey itself and can be started from a Flow, which is how logic that a Flow card cannot express gets done.',
        'Returns no code: read one script with homey_script_get.',
      ].join(' '),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const unavailable = await ensureHomeyScript(context)
        if (unavailable !== null) return unavailable

        const scripts = await listScripts(context.connection)
        return successResult(
          scripts.length === 0
            ? 'HomeyScript is installed and has no scripts yet.'
            : renderTextBlock([{ heading: `${scripts.length} scripts`, lines: scripts.map(describeScript) }]),
          { ok: true, count: scripts.length, scripts: scripts.map(summariseScript) },
        )
      } catch (error) {
        return failureResult(error, { operation: 'list HomeyScript scripts', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_script_get',
    {
      title: 'Read a HomeyScript script',
      description: 'Returns one script including its code. Takes the id or the exact name, as reported by homey_scripts_list.',
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        script: z.string().min(1).describe('The script id, or its exact name.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const unavailable = await ensureHomeyScript(context)
        if (unavailable !== null) return unavailable

        const resolution = await resolveScript(context, input.script)
        if (resolution.failure !== undefined) return resolution.failure

        const script = await getScript(context.connection, (resolution.script as ScriptSummary).id)
        return successResult(renderScript(script), { ok: true, script })
      } catch (error) {
        return failureResult(error, { operation: 'read a HomeyScript script', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_script_create',
    {
      title: 'Create a HomeyScript script',
      description: [
        'Creates a new script and returns the id the Homey assigned to it. Use that id afterwards: the name is not an address, and two scripts may share one.',
        'The script runs on the Homey, so it has the Homey API available as `Homey`, writes output with `log()`, and can hand a value back to the Flow that started it with `return` or `tag()`.',
        REUSABILITY_GUIDANCE,
        'Run it with homey_script_run once created, because a script that has never run is a script nobody has checked.',
      ].join(' '),
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        name: z.string().min(1).describe('A short descriptive name, shown in the HomeyScript app and when picking the script in a Flow.'),
        code: z.string().min(1).describe('The JavaScript to run on the Homey.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const unavailable = await ensureHomeyScript(context)
        if (unavailable !== null) return unavailable

        const created = await createScript(context.connection, { name: input.name, code: input.code })
        const warning = hardCodedIdentifierWarning(input.code)

        return successResult(
          renderTextBlock([
            {
              heading: `Created ${describeScript(created)}`,
              lines: renderKeyValueLines([
                ['id', created.id],
                ['name', created.name],
              ]),
            },
            warning === null ? null : { heading: 'Worth changing', lines: [warning] },
            { heading: 'Next', lines: ['Run it with homey_script_run to see what it answers.'] },
          ]),
          {
            ok: true,
            script: summariseScript(created),
            warnings: warning === null ? [] : [warning],
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'create a HomeyScript script', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_script_update',
    {
      title: 'Replace the code of a HomeyScript script',
      description: [
        'Replaces the code of a script that already exists, found by id or exact name. The previous code is returned so the change can be undone from the result alone.',
        REUSABILITY_GUIDANCE,
      ].join(' '),
      annotations: WRITE_TOOL_ANNOTATIONS,
      inputSchema: {
        script: z.string().min(1).describe('The script id, or its exact name.'),
        code: z.string().min(1).describe('The JavaScript that replaces what is there now.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const unavailable = await ensureHomeyScript(context)
        if (unavailable !== null) return unavailable

        const resolution = await resolveScript(context, input.script)
        if (resolution.failure !== undefined) return resolution.failure

        const id = (resolution.script as ScriptSummary).id
        const before = await getScript(context.connection, id)
        const updated = await updateScript(context.connection, id, input.code)
        const warning = hardCodedIdentifierWarning(input.code)

        return successResult(
          renderTextBlock([
            { heading: `Updated ${describeScript(updated)}`, lines: [] },
            warning === null ? null : { heading: 'Worth changing', lines: [warning] },
            { heading: 'Previous code, in case this needs undoing', lines: before.code.split('\n') },
          ]),
          {
            ok: true,
            script: summariseScript(updated),
            previousCode: before.code,
            warnings: warning === null ? [] : [warning],
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'update a HomeyScript script', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_script_run',
    {
      title: 'Run a HomeyScript script',
      description: [
        'Runs a script on the Homey now and reports what it returned.',
        'A script that throws is reported here as a normal answer with the error and the line it happened on, so this is also how a script gets debugged.',
        'It really runs: anything the script does to the house, it does.',
      ].join(' '),
      // Not idempotent and not a read: a script can switch a light, and running
      // it twice does it twice.
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
      inputSchema: {
        script: z.string().min(1).describe('The script id, or its exact name.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const unavailable = await ensureHomeyScript(context)
        if (unavailable !== null) return unavailable

        const resolution = await resolveScript(context, input.script)
        if (resolution.failure !== undefined) return resolution.failure

        const script = resolution.script as ScriptSummary
        const result = await runScript(context.connection, script.id)

        if (!result.success) {
          return successResult(
            renderTextBlock([
              { heading: `"${script.name}" ran and failed`, lines: [result.error?.message ?? 'No reason was given.'] },
              result.error?.stack === null || result.error?.stack === undefined
                ? null
                : { heading: 'Where', lines: result.error.stack.split('\n') },
            ]),
            { ok: true, ran: true, success: false, error: result.error, script: summariseScript(script) },
          )
        }

        return successResult(
          renderTextBlock([
            {
              heading: `"${script.name}" ran`,
              lines: [result.returns === undefined ? 'It returned nothing.' : `It returned: ${JSON.stringify(result.returns)}`],
            },
          ]),
          { ok: true, ran: true, success: true, returns: result.returns ?? null, script: summariseScript(script) },
        )
      } catch (error) {
        return failureResult(error, { operation: 'run a HomeyScript script', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_script_delete',
    {
      title: 'Delete a HomeyScript script',
      description: [
        'Removes a script from the Homey. It is gone: there is no undo, and any Flow that started it stops working.',
        'The code is returned in the result, so it can be recreated from this answer if that turns out to be a mistake.',
      ].join(' '),
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
      inputSchema: {
        script: z.string().min(1).describe('The script id, or its exact name.'),
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const unavailable = await ensureHomeyScript(context)
        if (unavailable !== null) return unavailable

        const resolution = await resolveScript(context, input.script)
        if (resolution.failure !== undefined) return resolution.failure

        const id = (resolution.script as ScriptSummary).id
        // Read before removing, so the result carries the only remaining copy.
        const before = await getScript(context.connection, id)
        await deleteScript(context.connection, id)

        return successResult(
          renderTextBlock([
            { heading: `Deleted "${before.name}"`, lines: ['Any Flow that started it will no longer find it.'] },
            { heading: 'Its code, the only copy left', lines: before.code.split('\n') },
          ]),
          { ok: true, deleted: summariseScript(before), code: before.code },
        )
      } catch (error) {
        return failureResult(error, { operation: 'delete a HomeyScript script', logger: context.logger })
      }
    },
  )
}
