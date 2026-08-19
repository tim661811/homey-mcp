// Reading, writing and running HomeyScript scripts.
//
// HomeyScript is an app rather than a firmware feature, so everything here goes
// through the app's own Web API at `/api/app/com.athom.homeyscript/...`, which
// `homey-api` exposes as `get`/`post`/`put`/`delete` on an app record. That also
// means it can be absent, and can be installed while this server is running, so
// nothing about it is probed once at startup the way the hardware capabilities
// are.
//
// The endpoints were measured against a Homey Pro (Early 2019) running
// HomeyScript 3.6.2, because the app publishes no API documentation:
//
//   GET    /script          every script, keyed by id
//   GET    /script/:id      one script, including its code
//   POST   /script          CREATE. Homey assigns the id.
//   PUT    /script/:id      update an existing script
//   DELETE /script/:id      remove one
//   POST   /script/:id/run  run it, and answer with what it returned
//
// `POST` versus `PUT` is the trap in that list and it is not a style preference.
// A `PUT` to an id that does not exist appears to work: it answers with the body
// it was given, and a `GET` of the same path reads it back. The script is not in
// `GET /script`, is not in the HomeyScript app, and cannot be picked in a Flow.
// So `createScript` posts, and the id it returns is the hub's, never the
// caller's. Getting this wrong is not a failed call, it is a script that exists
// just enough to convince the caller it worked.

import { asNumber, asRecord, asString } from '../util/coerce.js'
import { HomeyMcpError } from './errors.js'
import type { HomeyConnection } from './types.js'

export const HOMEYSCRIPT_APP_ID = 'com.athom.homeyscript'

/** A script without its code, which is what listing returns. */
export interface ScriptSummary {
  id: string
  name: string
  /** Bumped by the app on every save. Null when the app did not report one. */
  version: number | null
  /** ISO 8601, or null for a script that has never run. */
  lastExecuted: string | null
}

export interface ScriptRecord extends ScriptSummary {
  code: string
}

/** What running a script answered with. */
export interface ScriptRunResult {
  success: boolean
  /** Whatever the script returned. Undefined when it returned nothing. */
  returns: unknown
  /**
   * The failure, when there was one. HomeyScript reports a syntax error and a
   * thrown error the same way, both with the line number, which is the useful
   * half for whoever has to fix the script.
   */
  error: { message: string; stack: string | null } | null
}

export interface HomeyScriptAppState {
  installed: boolean
  version: string | null
  /** `running`, `crashed`, and so on. Null when the app is not installed. */
  state: string | null
}

interface AppApi {
  get(options: { path: string }): Promise<unknown>
  post(options: { path: string; body?: unknown }): Promise<unknown>
  put(options: { path: string; body?: unknown }): Promise<unknown>
  delete(options: { path: string }): Promise<unknown>
}

interface AppsManager {
  getApp(options: { id: string }): Promise<AppApi>
  getApps(): Promise<unknown>
  installFromAppStore(options: { id: string; channel?: string }): Promise<unknown>
}

function appsOf(connection: HomeyConnection): AppsManager {
  return (connection.api as { apps: AppsManager }).apps
}

/**
 * Whether the app is there, asked fresh every time.
 *
 * Deliberately not cached alongside the hardware capabilities: those describe
 * what the hardware can never do, and this describes something the user can
 * install in the next thirty seconds. A cached "not installed" would outlive the
 * install and make the tools look broken.
 */
export async function readHomeyScriptApp(connection: HomeyConnection): Promise<HomeyScriptAppState> {
  const apps = asRecord(
    await connection.request(() => appsOf(connection).getApps(), 'apps.getApps', true),
  )
  const app = asRecord(apps?.[HOMEYSCRIPT_APP_ID])
  if (app === null) return { installed: false, version: null, state: null }

  return {
    installed: true,
    version: asString(app['version']),
    state: asString(app['state']),
  }
}

/**
 * Installs HomeyScript from the app store.
 *
 * Never called without the user having said yes: the tools ask first. Whether
 * the credential in use is allowed to do this is not something this server can
 * decide, so a refusal from the hub is reported as it arrives rather than
 * translated into advice that might be wrong.
 */
export async function installHomeyScriptApp(connection: HomeyConnection): Promise<void> {
  await connection.request(
    () => appsOf(connection).installFromAppStore({ id: HOMEYSCRIPT_APP_ID }),
    'apps.installFromAppStore',
  )
}

async function callApp(
  connection: HomeyConnection,
  label: string,
  idempotent: boolean,
  action: (app: AppApi) => Promise<unknown>,
): Promise<unknown> {
  return await connection.request(
    async () => await action(await appsOf(connection).getApp({ id: HOMEYSCRIPT_APP_ID })),
    label,
    idempotent,
  )
}

function toSummary(id: string, value: unknown): ScriptSummary {
  const record = asRecord(value) ?? {}
  return {
    id: asString(record['id']) ?? id,
    // The listing keys scripts by id, and for the app's own examples the id IS
    // the readable name, so falling back to the key beats reporting "unnamed".
    name: asString(record['name']) ?? id,
    version: asNumber(record['version']),
    lastExecuted: asString(record['lastExecuted']),
  }
}

export async function listScripts(connection: HomeyConnection): Promise<ScriptSummary[]> {
  const answer = asRecord(await callApp(connection, 'homeyscript.listScripts', true, (app) => app.get({ path: '/script' })))
  if (answer === null) return []

  return Object.entries(answer)
    .map(([id, value]) => toSummary(id, value))
    .sort((first, second) => first.name.localeCompare(second.name))
}

export async function getScript(connection: HomeyConnection, id: string): Promise<ScriptRecord> {
  const answer = asRecord(
    await callApp(connection, 'homeyscript.getScript', true, (app) => app.get({ path: `/script/${encodeURIComponent(id)}` })),
  )
  if (answer === null) {
    throw new HomeyMcpError('not_found', `HomeyScript has no script with id "${id}".`)
  }

  return { ...toSummary(id, answer), code: asString(answer['code']) ?? '' }
}

/**
 * Creates a script and answers with the record the hub made, id included.
 *
 * See the note at the top of this file for why this posts. The returned id is
 * the only one that addresses the script afterwards, so a caller that keeps the
 * name it asked for and uses that as an id is addressing nothing.
 */
export async function createScript(
  connection: HomeyConnection,
  script: { name: string; code: string },
): Promise<ScriptRecord> {
  const answer = asRecord(
    await callApp(connection, 'homeyscript.createScript', false, (app) =>
      app.post({ path: '/script', body: { name: script.name, code: script.code } }),
    ),
  )

  const id = asString(answer?.['id'])
  if (answer === null || id === null) {
    // Not a cosmetic check. Without the id there is nothing to update, run or
    // remove, and a caller told "created" would have no way to reach it again.
    throw new HomeyMcpError(
      'unknown',
      'HomeyScript accepted the new script but did not answer with its id, so it cannot be addressed.',
      { suggestion: 'List the scripts with homey_scripts_list to find it.' },
    )
  }

  return { ...toSummary(id, answer), code: asString(answer['code']) ?? script.code }
}

/**
 * Replaces the code of a script that already exists.
 *
 * The existence check is the point. A `PUT` to an unknown id answers happily and
 * leaves a record that no listing shows, so without this a typo in an id creates
 * a ghost instead of failing.
 */
export async function updateScript(
  connection: HomeyConnection,
  id: string,
  code: string,
): Promise<ScriptRecord> {
  const existing = await getScript(connection, id)

  await callApp(connection, 'homeyscript.updateScript', false, (app) =>
    app.put({ path: `/script/${encodeURIComponent(id)}`, body: { code } }),
  )

  return { ...existing, code }
}

export async function deleteScript(connection: HomeyConnection, id: string): Promise<void> {
  await callApp(connection, 'homeyscript.deleteScript', false, (app) =>
    app.delete({ path: `/script/${encodeURIComponent(id)}` }),
  )
}

/**
 * Runs a script and reports what it answered.
 *
 * A script that throws is NOT a failed call: the hub answers 200 with
 * `success: false` and the error inside. So this never throws for a script that
 * ran and went wrong, and the caller has to read `success`.
 */
export async function runScript(connection: HomeyConnection, id: string): Promise<ScriptRunResult> {
  const answer = asRecord(
    await callApp(connection, 'homeyscript.runScript', false, (app) =>
      app.post({ path: `/script/${encodeURIComponent(id)}/run` }),
    ),
  )

  const success = answer?.['success'] === true
  const returns = answer?.['returns']
  if (success) return { success: true, returns, error: null }

  const failure = asRecord(returns)
  return {
    success: false,
    returns: undefined,
    error: {
      message: asString(failure?.['message']) ?? 'The script failed, and HomeyScript did not say why.',
      stack: asString(failure?.['stack']),
    },
  }
}
