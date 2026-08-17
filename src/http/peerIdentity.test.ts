// The lookup that decides whether another account on this machine can sign
// itself in.
//
// Driven against captured `/proc/net/tcp` text rather than against whatever the
// machine running the suite has open, so every branch is asserted rather than
// whichever one today's sockets happen to produce.

import { describe, expect, it } from 'vitest'

import { findPeerUid, peerIdentityOf, PEER_IDENTITY_LOCAL, readPeerIdentity } from './peerIdentity.js'

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'

/** One row in the layout the kernel writes: the tx:rx and tr:tm columns are single tokens. */
function row(options: { local: string; remote: string; uid: number; index?: number }): string {
  return `   ${options.index ?? 0}: ${options.local} ${options.remote} 01 00000000:00000000 00:00000000 00000000  ${options.uid}        0 12345 1 0000000000000000 100 0 0 10 0\n`
}

/** 127.0.0.1:8431 in the little-endian hex the kernel writes it in. */
const SERVER = '0100007F:20EF'
const CLIENT = '0100007F:C350'

describe('findPeerUid', () => {
  it('reads the uid off the peer row, which is the mirror of ours', () => {
    const contents =
      HEADER +
      // Our own accepted socket: the same connection with the ends the other way
      // round and OUR uid on it. Matching this one would report every caller as
      // the owner, which is the whole failure this module exists to prevent.
      row({ local: SERVER, remote: CLIENT, uid: 1000, index: 0 }) +
      row({ local: CLIENT, remote: SERVER, uid: 1042, index: 1 })

    expect(
      findPeerUid(contents, {
        remoteAddress: '127.0.0.1',
        remotePort: 50_000,
        localAddress: '127.0.0.1',
        localPort: 8431,
      }),
    ).toBe(1042)
  })

  it('answers null when no row describes the connection', () => {
    expect(
      findPeerUid(HEADER + row({ local: SERVER, remote: CLIENT, uid: 1000 }), {
        remoteAddress: '127.0.0.1',
        remotePort: 50_000,
        localAddress: '127.0.0.1',
        localPort: 8431,
      }),
    ).toBeNull()
  })

  it('answers null rather than guessing for an address it cannot encode', () => {
    // The bind is IPv4 loopback, so anything else means the assumption behind
    // this lookup no longer holds and the answer has to be "unknown".
    expect(
      findPeerUid(HEADER + row({ local: CLIENT, remote: SERVER, uid: 1042 }), {
        remoteAddress: '::1',
        remotePort: 50_000,
        localAddress: '127.0.0.1',
        localPort: 8431,
      }),
    ).toBeNull()
  })
})

describe('readPeerIdentity', () => {
  it('calls a connection from this very process the same user', async () => {
    if (process.platform !== 'linux') return

    // A real loopback connection made here: this process owns both ends, so the
    // one answer that is certainly right is same_user.
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as { port: number }

    const accepted = new Promise<{ remoteAddress?: string; remotePort?: number; localPort?: number }>(
      (resolve) => server.once('connection', (socket) => resolve(socket)),
    )
    const { connect } = await import('node:net')
    const client = connect(port, '127.0.0.1')
    const socket = await accepted

    expect(await readPeerIdentity(socket)).toEqual({ kind: 'same_user' })

    client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('peerIdentityOf', () => {
  it('reads back what the gate stored', () => {
    expect(peerIdentityOf({ locals: { [PEER_IDENTITY_LOCAL]: { kind: 'same_user' } } })).toEqual({
      kind: 'same_user',
    })
  })

  it('fails closed for a response that never passed the gate', () => {
    // An ungated response reading as same_user would put the whole hole back the
    // moment somebody mounts a route without the middleware.
    expect(peerIdentityOf({}).kind).toBe('unknown')
    expect(peerIdentityOf({ locals: {} }).kind).toBe('unknown')
  })
})
