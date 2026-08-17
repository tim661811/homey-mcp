// The live MCP sessions on the HTTP transport.
//
// Stateful rather than stateless, because the GET stream a client opens after
// `initialize` belongs to a session, and because a future browser page driven
// from a tool call needs a session id to hang an elicitation off.
//
// One rule here is not an optimisation, it is the specification:
//
//   MCP servers that implement authorization MUST verify all inbound requests.
//   MCP Servers MUST NOT use sessions for authentication.
//
// So the bearer check runs in front of every request, session id or not, and on
// top of that a session is bound to the client the token belongs to. A request
// carrying somebody else's session id is answered 404, the same answer a session
// that does not exist gets, because from the caller's side those are the same
// thing.

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { Logger } from '../util/log.js'

/**
 * Eight is generous for a single-user loopback server and still bounds the
 * memory a client that never sends DELETE can pin. The least recently used one
 * goes, because the newest is the one somebody is looking at.
 */
export const MAXIMUM_LIVE_SESSIONS = 8

export interface SessionRecord {
  transport: StreamableHTTPServerTransport
  server: McpServer
  /** The client the token that created this session belonged to. */
  clientId: string
  lastSeenMs: number
}

export interface SessionRegistry {
  register(sessionId: string, record: SessionRecord): void
  /**
   * The session, or undefined when it does not exist or belongs to another client.
   *
   * Deliberately one answer for both, so a caller cannot accidentally tell a
   * probing client which session ids exist.
   */
  claim(sessionId: string, clientId: string): SessionRecord | undefined
  forget(sessionId: string): SessionRecord | undefined
  readonly size: number
  closeAll(): Promise<void>
}

export interface CreateSessionRegistryOptions {
  logger?: Logger
  maximumSessions?: number
  now?: () => number
}

export function createSessionRegistry(options: CreateSessionRegistryOptions = {}): SessionRegistry {
  const sessions = new Map<string, SessionRecord>()
  const maximumSessions = options.maximumSessions ?? MAXIMUM_LIVE_SESSIONS
  const now = options.now ?? ((): number => Date.now())
  const logger = options.logger

  const evictLeastRecentlyUsed = (): void => {
    let oldestId: string | null = null
    let oldestSeenMs = Number.POSITIVE_INFINITY

    for (const [sessionId, record] of sessions) {
      if (record.lastSeenMs < oldestSeenMs) {
        oldestSeenMs = record.lastSeenMs
        oldestId = sessionId
      }
    }

    if (oldestId === null) return
    const evicted = sessions.get(oldestId)
    sessions.delete(oldestId)
    logger?.info('Closing the least recently used MCP session to stay under the limit')
    void evicted?.transport.close().catch(() => undefined)
  }

  return {
    register(sessionId: string, record: SessionRecord): void {
      sessions.set(sessionId, record)
      while (sessions.size > maximumSessions) evictLeastRecentlyUsed()
    },

    claim(sessionId: string, clientId: string): SessionRecord | undefined {
      const record = sessions.get(sessionId)
      if (record === undefined || record.clientId !== clientId) return undefined
      record.lastSeenMs = now()
      return record
    },

    forget(sessionId: string): SessionRecord | undefined {
      const record = sessions.get(sessionId)
      sessions.delete(sessionId)
      return record
    },

    get size(): number {
      return sessions.size
    },

    async closeAll(): Promise<void> {
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(open.map(async (record) => await record.transport.close()))
    },
  }
}
