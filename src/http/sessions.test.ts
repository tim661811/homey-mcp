import { describe, expect, it, vi } from 'vitest'

import type { SessionRecord } from './sessions.js'
import { createSessionRegistry } from './sessions.js'

function fakeRecord(clientId: string, lastSeenMs = 0): SessionRecord {
  return {
    transport: { close: vi.fn(async () => undefined) } as unknown as SessionRecord['transport'],
    server: {} as unknown as SessionRecord['server'],
    clientId,
    lastSeenMs,
  }
}

describe('createSessionRegistry', () => {
  it('hands a session back to the client whose token created it', () => {
    const registry = createSessionRegistry()
    registry.register('session-one', fakeRecord('client-one'))

    expect(registry.claim('session-one', 'client-one')).toBeDefined()
  })

  it('answers another client exactly as it answers an unknown session', () => {
    // The specification says a server MUST NOT use sessions for authentication,
    // so a session id is never a way in. One answer for both cases, because from
    // the caller's side they are the same thing.
    const registry = createSessionRegistry()
    registry.register('session-one', fakeRecord('client-one'))

    expect(registry.claim('session-one', 'somebody-else')).toBeUndefined()
    expect(registry.claim('no-such-session', 'client-one')).toBeUndefined()
  })

  it('closes the least recently used session rather than growing without bound', () => {
    let clock = 0
    const registry = createSessionRegistry({ maximumSessions: 2, now: () => clock })

    const oldest = fakeRecord('client-one', 1)
    registry.register('one', oldest)
    registry.register('two', fakeRecord('client-one', 2))

    clock = 10
    registry.claim('two', 'client-one')
    registry.register('three', fakeRecord('client-one', 3))

    expect(registry.size).toBe(2)
    expect(registry.claim('one', 'client-one')).toBeUndefined()
    expect(oldest.transport.close).toHaveBeenCalled()
  })

  it('forgets a session that was closed', () => {
    const registry = createSessionRegistry()
    registry.register('session-one', fakeRecord('client-one'))

    expect(registry.forget('session-one')).toBeDefined()
    expect(registry.size).toBe(0)
  })

  it('closes every open session on shutdown', async () => {
    const registry = createSessionRegistry()
    const first = fakeRecord('client-one')
    const second = fakeRecord('client-two')
    registry.register('one', first)
    registry.register('two', second)

    await registry.closeAll()

    expect(first.transport.close).toHaveBeenCalled()
    expect(second.transport.close).toHaveBeenCalled()
    expect(registry.size).toBe(0)
  })
})
