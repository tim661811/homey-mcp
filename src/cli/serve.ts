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

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { connectToHomey, disconnectFromHomey } from '../homey/connect.js'
import { NO_CREDENTIALS_HELP, resolveCredentials } from '../homey/credentials.js'
import { classifyError } from '../homey/errors.js'
import { createServer } from '../server/createServer.js'
import type { Logger, LogLevel } from '../util/log.js'
import { createLogger, LOG_LEVELS } from '../util/log.js'
import { readFlagValue } from './flags.js'

export interface ServeOptions {
  argv?: string[]
  environment?: Record<string, string | undefined>
  logger?: Logger
}

/**
 * Runs until the client disconnects or the process is asked to stop. Resolves
 * with the exit code, so the caller decides how the process ends.
 */
export async function runServe(options: ServeOptions = {}): Promise<number> {
  const argv = options.argv ?? []
  const environment = options.environment ?? process.env
  const configPath = readFlagValue(argv, '--config')
  const requestedLevel = parseLevelFlag(readFlagValue(argv, '--log-level'))

  const logger =
    options.logger ??
    createLogger({
      environment,
      ...(requestedLevel === null ? {} : { level: requestedLevel }),
    })

  const credentials = await resolveCredentials({
    environment,
    logger,
    ...(configPath === null ? {} : { configPath }),
  }).catch((error: unknown) => {
    const failure = classifyError(error, { operation: 'resolveCredentials' })
    if (failure.reason === 'not_connected') {
      // Not an error in the usual sense: the server has simply never been set up,
      // and a stack trace here would hide the one line that fixes it.
      process.stderr.write(`\n${NO_CREDENTIALS_HELP}\n\n`)
      return null
    }
    throw failure
  })

  if (credentials === null) return 1

  const connection = await connectToHomey(credentials, { logger })

  try {
    const { server } = await createServer({ connection, logger })
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

    await closed
    return 0
  } finally {
    await disconnectFromHomey(connection)
  }
}

function parseLevelFlag(value: string | null): LogLevel | null {
  if (value === null) return null
  const normalised = value.trim().toLowerCase()
  return LOG_LEVELS.find((level) => level === normalised) ?? null
}
