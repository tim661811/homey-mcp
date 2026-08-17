// One source for every URL the HTTP mode says out loud.
//
// RFC 9728 section 3.3 makes the `resource` value in the protected resource
// metadata and the URL that document is served from a matched pair: "If these
// values are not identical, the data contained in the response MUST NOT be
// used." On loopback that is easy to break invisibly, because `localhost` and
// `127.0.0.1` are different resource identifiers and a trailing slash is another
// one again. The client also keys its stored credentials on the URL it was
// given, so a spelling that drifts between the printed client entry, the issuer
// and the metadata does not fail loudly: it re-prompts for authorization
// forever.
//
// So every spelling is derived here, from one port, and nothing else in the
// codebase builds one of these strings itself.

/**
 * Above 1024 so no privilege is needed, outside the default ephemeral ranges on
 * Linux (32768 to 60999), macOS and Windows (49152 up) so the kernel cannot hand
 * it transiently to something else, and not one of the conventional development
 * ports that something else on the machine is likely to want.
 */
export const DEFAULT_HTTP_PORT = 8431

/** The one scope this server issues. A read versus write split is deliberately deferred. */
export const HOMEY_SCOPE = 'homey'

/** Asked for by the client when it wants a refresh token, and only advertised by the authorization server. */
export const OFFLINE_ACCESS_SCOPE = 'offline_access'

/** Shown on the consent page and in the protected resource metadata. */
export const RESOURCE_NAME = 'Homey (via homey-mcp)'

export interface HttpEndpointConfig {
  /** Exactly what the client is told to configure, and exactly the resource identifier. */
  mcpUrl: URL
  /** The authorization server's issuer identifier. */
  issuerUrl: URL
  /** Never anything but a loopback address. See `serveHttp.ts` for why there is no `--bind`. */
  bindHost: string
  port: number
  /**
   * Origins a browser may carry when it reaches these endpoints.
   *
   * Both loopback spellings, because the consent page is opened by whichever one
   * the user's browser resolves, and a same-origin form post then carries that
   * spelling back.
   */
  allowedOrigins: string[]
}

/** The canonical spelling of the loopback host. Used for the bind and for every URL. */
export const LOOPBACK_HOST = '127.0.0.1'

export function createHttpEndpointConfig(options: { port?: number } = {}): HttpEndpointConfig {
  const port = options.port ?? DEFAULT_HTTP_PORT

  return {
    mcpUrl: new URL(`http://${LOOPBACK_HOST}:${port}/mcp`),
    issuerUrl: new URL(`http://${LOOPBACK_HOST}:${port}`),
    bindHost: LOOPBACK_HOST,
    port,
    allowedOrigins: [`http://${LOOPBACK_HOST}:${port}`, `http://localhost:${port}`],
  }
}

/**
 * The message for a port that is already taken.
 *
 * Deliberately a failure rather than a fallback. A fallback port produces a
 * server that is running and unreachable at the address the client was told to
 * use, which the client reports as ConnectionRefused with no explanation at all.
 */
export function portInUseMessage(port: number): string {
  return [
    `Port ${port} is already in use, so this server did not start.`,
    '',
    'Nothing was moved to another port on purpose: the port is part of the address your',
    'assistant stores, so a server listening somewhere else would look exactly like a',
    'server that is not running.',
    '',
    'What to do:',
    `  - Find what holds it: "ss -ltnp | grep ${port}" on Linux, "lsof -iTCP:${port} -sTCP:LISTEN" on macOS.`,
    '  - Or pick another port with "--port <number>". Your assistant\'s entry has to name the',
    '    same port, so update it too, and re-run "npx homey-mcp service install --port <number>"',
    '    if a service is installed.',
  ].join('\n')
}
