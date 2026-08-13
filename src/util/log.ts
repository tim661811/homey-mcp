// Logging for a process whose stdout is a JSON-RPC transport.
//
// Anything written to stdout is parsed as a protocol frame by the MCP client,
// so a single stray `console.log` corrupts the stream and the session dies with
// a parse error that points nowhere near the cause. Every line this module
// writes goes to stderr, which MCP clients collect as server logs.

import { redactSecrets, redactString } from './redact.js'

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** Environment variable that selects the level. Named in the README and in `doctor` output. */
export const LOG_LEVEL_ENVIRONMENT_VARIABLE = 'HOMEY_MCP_LOG_LEVEL'

export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export interface Logger {
  readonly level: LogLevel
  readonly scope: string
  error(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  debug(message: string, details?: unknown): void
  /** True when a message at this level would actually be written. Lets a caller skip expensive detail building. */
  isEnabled(level: LogLevel): boolean
  /** Returns a logger that prefixes every line with `<parent scope>:<scope>`. */
  child(scope: string): Logger
}

export interface CreateLoggerOptions {
  /** Explicit level. When omitted the level comes from HOMEY_MCP_LOG_LEVEL, then the default. */
  level?: LogLevel
  scope?: string
  environment?: Record<string, string | undefined>
  /** Sink for finished lines, without a trailing newline. Defaults to stderr. Injected by tests. */
  write?: (line: string) => void
  now?: () => Date
}

/**
 * Maps a raw environment value onto a level. An unrecognised value falls back
 * rather than throwing, because a typo in a shell profile must not stop the
 * server from starting, but it does warn once so the typo is visible.
 */
export function parseLogLevel(rawValue: string | undefined, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  if (rawValue === undefined) return fallback
  const normalisedValue = rawValue.trim().toLowerCase()
  if (normalisedValue === '') return fallback
  const match = LOG_LEVELS.find((level) => level === normalisedValue)
  return match ?? fallback
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const environment = options.environment ?? process.env
  const rawLevel = environment[LOG_LEVEL_ENVIRONMENT_VARIABLE]
  const level = options.level ?? parseLogLevel(rawLevel)
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const scope = options.scope ?? 'homey-mcp'

  const levelWasUnrecognised =
    options.level === undefined &&
    rawLevel !== undefined &&
    rawLevel.trim() !== '' &&
    !LOG_LEVELS.some((candidate) => candidate === rawLevel.trim().toLowerCase())

  const logger = buildLogger({ level, scope, write, now })

  if (levelWasUnrecognised) {
    logger.warn(`Ignoring unrecognised ${LOG_LEVEL_ENVIRONMENT_VARIABLE}, using "${level}" instead`, {
      allowed: [...LOG_LEVELS],
    })
  }

  return logger
}

interface LoggerInternals {
  level: LogLevel
  scope: string
  write: (line: string) => void
  now: () => Date
}

function buildLogger(internals: LoggerInternals): Logger {
  const isEnabled = (level: LogLevel): boolean =>
    LEVEL_SEVERITY[internals.level] >= LEVEL_SEVERITY[level] && level !== 'silent'

  const emit = (level: LogLevel, message: string, details?: unknown): void => {
    if (!isEnabled(level)) return
    internals.write(formatLine(internals, level, message, details))
  }

  return {
    get level() {
      return internals.level
    },
    get scope() {
      return internals.scope
    },
    error: (message, details) => emit('error', message, details),
    warn: (message, details) => emit('warn', message, details),
    info: (message, details) => emit('info', message, details),
    debug: (message, details) => emit('debug', message, details),
    isEnabled,
    child: (scope) => buildLogger({ ...internals, scope: `${internals.scope}:${scope}` }),
  }
}

function formatLine(internals: LoggerInternals, level: LogLevel, message: string, details: unknown): string {
  const timestamp = internals.now().toISOString()
  const paddedLevel = level.toUpperCase().padEnd(5, ' ')
  const line = `${timestamp} ${paddedLevel} ${internals.scope} ${redactString(message)}`
  if (details === undefined) return line
  return `${line} ${serialiseDetails(details)}`
}

function serialiseDetails(details: unknown): string {
  try {
    return JSON.stringify(redactSecrets(details)) ?? String(details)
  } catch {
    // A getter that throws, or a value JSON cannot represent. A log line is
    // never worth crashing the server over.
    return '"[undisplayable details]"'
  }
}

/**
 * The process-wide logger. Modules that are handed a logger should use the one
 * they were given; this is the root that the entry point creates children from.
 */
export const logger: Logger = createLogger()
