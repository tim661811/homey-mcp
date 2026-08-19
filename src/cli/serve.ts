// The default subcommand: run the MCP server on stdio.
//
// stdout belongs to the JSON-RPC transport from the moment the transport starts,
// so everything this file has to say goes to stderr. MCP clients collect stderr
// as the server's log, which is where a user will look when something is wrong.
//
// Starting without a credential is deliberately a clean exit with instructions
// rather than a stack trace or a half-built server. There is nothing this server
// can usefully do without a Homey, and a client showing "failed to connect" next
// to a message naming one command to run is more actionable than a tool list
// where every call returns the same error.
//
// The connection is opened through `openReconnectingConnection` rather than
// `connectToHomey`, and that is the difference between a server that works for a
// day and one that can be left running. A Homey session lasts exactly 24 hours.
// This process is normally started once and left alone, so resolving credentials
// once at startup meant every tool call after the first day failed with no route
// back from inside the process.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { openReconnectingConnection } from '../homey/connect.js'
import type { ResolvedCredentials } from '../homey/credentials.js'
import { resolveCredentials } from '../homey/credentials.js'
import { classifyError } from '../homey/errors.js'
import { createServer } from '../server/createServer.js'
import type { Logger, LogLevel } from '../util/log.js'
import { createLogger, LOG_LEVELS } from '../util/log.js'
import { readFlagValue } from './flags.js'

export interface ServeOptions {
  argv?: string[]
  environment?: Record<string, string | undefined>
  logger?: Logger
  /** Where the messages meant for a person go. stdout is the transport's. */
  errorOutput?: NodeJS.WritableStream
}

/**
 * Runs until the client disconnects or the process is asked to stop. Resolves
 * with the exit code, so the caller decides how the process ends.
 */
export async function runServe(options: ServeOptions = {}): Promise<number> {
  const argv = options.argv ?? []
  const environment = options.environment ?? process.env
  const errorOutput = options.errorOutput ?? process.stderr
  const configPath = readFlagValue(argv, '--config')

  const requestedLevel = readLogLevel(argv)
  if (requestedLevel === 'invalid') {
    // Not ignorable: someone who mistypes this is asking to see more, and
    // silently giving them the default level is how a debugging session starts
    // by chasing the wrong thing.
    errorOutput.write(
      `\n"${readFlagValue(argv, '--log-level') ?? ''}" is not a log level. Use one of: ${LOG_LEVELS.join(', ')}.\n\n`,
    )
    return 1
  }

  const logger =
    options.logger ??
    createLogger({
      environment,
      ...(requestedLevel === null ? {} : { level: requestedLevel }),
    })

  // Read again on every reconnect rather than captured here. The Homey CLI
  // refreshes its own session in the same file this reads, so when a 24 hour
  // session dies the replacement is usually already on disk.
  const loadCredentials = (): Promise<ResolvedCredentials> =>
    resolveCredentials({
      environment,
      logger,
      ...(configPath === null ? {} : { configPath }),
    })

  // Missing or expired credentials used to end the process here. That is the
  // wrong answer for a server a client starts: an MCP client cannot show a
  // reason for a process that exited, so the most ordinary situation there is,
  // a session that lapsed overnight, appeared as a red cross with nothing to act
  // on. The server now starts anyway, the handshake succeeds, and every tool
  // that needs the hub says what to do. `homey_authenticate` fixes it from
  // inside the conversation.
  let unauthenticatedReason: string | undefined
  const credentials = await loadCredentials().catch((error: unknown) => {
    const failure = classifyError(error, { operation: 'resolveCredentials' })
    if (failure.reason !== 'not_connected') throw failure
    // Still written to the log, because that is where someone looks when a tool
    // has just told them to sign in.
    logger.warn(failure.message)
    unauthenticatedReason = failure.message
    return undefined
  })

  const connection = await openReconnectingConnection({
    ...(credentials === undefined ? {} : { credentials }),
    loadCredentials,
    logger,
    startWithoutSession: true,
  })

  if (!connection.authenticated && unauthenticatedReason === undefined) {
    unauthenticatedReason = 'The stored credentials did not open a session.'
  }

  try {
    const { server } = await createServer({
      connection,
      logger,
      ...(unauthenticatedReason === undefined ? {} : { unauthenticatedReason }),
    })
    const transport = new StdioServerTransport()

    const closed = new Promise<void>((resolve) => {
      const previousOnClose = server.server.onclose
      server.server.onclose = () => {
        previousOnClose?.()
        resolve()
      }

      const stop = (reason: string): void => {
        logger.info(`${reason}, shutting down`)
        void server.close().finally(resolve)
      }

      process.once('SIGINT', () => stop('Received SIGINT'))
      process.once('SIGTERM', () => stop('Received SIGTERM'))

      // The stdio transport listens for data on stdin and for errors, but never
      // for its end, so a client that closes the pipe leaves this promise
      // pending forever. The process then simply ran out of handles and
      // disappeared: no teardown, and an exit code that came from Node's default
      // rather than from this run. An end of stdin is the client hanging up,
      // which is an ordinary shutdown and has to be reported as one.
      process.stdin.once('end', () => stop('The client closed stdin'))
    })

    await server.connect(transport)
    logger.info('Listening on stdio')
    // Said once, in the log a user actually reads, because the alternative is
    // finding out a day later. Sessions die on a schedule, and this server signs
    // in again by itself instead of needing a restart.
    logger.info('Homey sessions last 24 hours. This server reads your credentials again and signs in once more whenever Homey refuses one, so it can be left running.')

    await closed
    return 0
  } finally {
    await connection.close()
  }
}

/**
 * The requested log level, null when the flag was not given, and 'invalid' when
 * it was given something that is not a level.
 *
 * The three cases were two before, and an unreadable level fell in with an
 * absent one: `--log-level debgu` quietly ran at the default.
 */
function readLogLevel(argv: string[]): LogLevel | null | 'invalid' {
  const value = readFlagValue(argv, '--log-level')
  if (value === null) return null
  const normalised = value.trim().toLowerCase()
  return LOG_LEVELS.find((level) => level === normalised) ?? 'invalid'
}
