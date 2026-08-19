// Who is on the other end of a loopback connection.
//
// This exists because of one thing the README used to claim and the code did not
// do. The consent page hands `pendingId` and `csrfToken` to whoever fetched it,
// and the form post needs nothing else, so the entire authorization can be
// driven with two `fetch` calls and no browser: register, GET /authorize, POST
// /authorize/continue, POST /token. A loopback socket is not a per-user boundary
// on Linux or macOS, so before this module any second account on the machine
// could mint a full-scope token and start a door-opening Flow, with the owner
// never seeing a page.
//
// There is no portable low-friction fix, and it is worth being clear about why.
// Anything the browser can present, a local process can present too: the browser
// holds no secret of its own. So the only thing that separates the owner's
// browser from another account's script is the identity of the process behind the
// socket, or a secret that only the owner can read off the disk. This module does
// the first where the kernel will answer, and `authStore`'s approval code does the
// second where it will not.
//
// Linux answers through `/proc/net/tcp`, which lists the uid that owns each
// socket. macOS has no equivalent that Node can read (SO_PEERCRED is a Unix
// domain socket facility, and lsof is a subprocess on a request path this project
// has no way to test), so it lands in `unknown` and pays the approval code
// instead. That split follows the same rule as the Windows service: ship what can
// be verified on hardware we have, and say plainly what the other platforms get.
//
// WSL is a third case and it took a real sign-in to find. The file is there and
// it answers, but a browser on the Windows side does not reach this server
// directly: WSL relays the connection through a root-owned socket inside the VM,
// so the owner arrives as uid 0. Read literally that is a second account, and
// the owner was refused with advice to run the server under their own account,
// which is what they were already doing. It is the kernel naming the relay, not
// naming the caller, so it belongs with macOS in `unknown`.

import { readFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'

/**
 * The verdict for one connection.
 *
 * `unknown` is a third answer and not a shade of the other two, the same
 * distinction `CapabilityRegistry.hardware` makes. Reading it as "probably fine"
 * is what would put the hole back on every platform that is not Linux.
 */
export type PeerIdentity =
  | { kind: 'same_user' }
  | { kind: 'other_user'; uid: number }
  | { kind: 'unknown'; reason: string }

/** What is needed to name a connection, taken from `request.socket`. */
export interface PeerSocketAddress {
  remoteAddress?: string | undefined
  remotePort?: number | undefined
  localAddress?: string | undefined
  localPort?: number | undefined
}

export type ReadPeerIdentity = (socket: PeerSocketAddress) => Promise<PeerIdentity>

const PROC_NET_TCP = '/proc/net/tcp'
const OS_RELEASE = '/proc/sys/kernel/osrelease'

/**
 * The uid the WSL localhost relay runs as. Anything opened on the Windows side
 * against a port inside the VM arrives on a socket owned by it.
 */
const WSL_RELAY_UID = 0

/**
 * Whether a `/proc/sys/kernel/osrelease` line describes a WSL kernel.
 *
 * Exported and pure so the suite can assert both answers without the machine
 * running it having to be, or not be, WSL.
 */
export function describesWslKernel(osRelease: string): boolean {
  return /microsoft/i.test(osRelease)
}

let wslKernelCheck: Promise<boolean> | null = null

/** Read once: the kernel does not change under a running process. */
async function runsUnderWsl(): Promise<boolean> {
  wslKernelCheck ??= readFile(OS_RELEASE, 'utf8')
    .then(describesWslKernel)
    .catch(() => false)
  return await wslKernelCheck
}

/**
 * The uid that owns the far end, or null when this file does not describe the
 * connection.
 *
 * Exported so a test can drive every branch against captured `/proc/net/tcp`
 * text rather than against whatever the machine running the suite happens to
 * have open.
 *
 * The row wanted is the PEER's, which is the mirror of ours: its `local_address`
 * is our remote address and its `rem_address` is the address this server is
 * listening on. Our own accepted socket appears too, with the two the other way
 * round and our own uid on it, so matching the wrong direction would report every
 * caller as the owner.
 */
export function findPeerUid(
  procNetTcp: string,
  connection: { remoteAddress: string; remotePort: number; localAddress: string; localPort: number },
): number | null {
  const peerLocal = encodeAddress(connection.remoteAddress, connection.remotePort)
  const peerRemote = encodeAddress(connection.localAddress, connection.localPort)
  if (peerLocal === null || peerRemote === null) return null

  for (const line of procNetTcp.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    // sl, local_address, rem_address, st, tx:rx, tr:tm, retrnsmt, uid, ...
    if (fields.length < 8) continue
    if (fields[1] !== peerLocal || fields[2] !== peerRemote) continue

    const uid = Number.parseInt(fields[7] ?? '', 10)
    return Number.isInteger(uid) ? uid : null
  }

  return null
}

/** `127.0.0.1` and a port in the little-endian hex `/proc/net/tcp` writes them in. */
function encodeAddress(address: string, port: number): string | null {
  if (!isIPv4(address)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null

  const octets = address.split('.').map((octet) => Number.parseInt(octet, 10))
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return null

  const hostPart = [...octets]
    .reverse()
    .map((octet) => octet.toString(16).toUpperCase().padStart(2, '0'))
    .join('')
  return `${hostPart}:${port.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * The default reader. Answers `unknown` rather than guessing whenever anything
 * about the lookup does not hold.
 */
export const readPeerIdentity: ReadPeerIdentity = async (socket: PeerSocketAddress) => {
  const ownUid = process.getuid?.()
  if (ownUid === undefined) {
    return { kind: 'unknown', reason: 'this platform has no user ids for a process' }
  }
  if (process.platform !== 'linux') {
    return { kind: 'unknown', reason: `this computer cannot say which account a connection came from on ${process.platform}` }
  }

  const { remoteAddress, remotePort, localAddress, localPort } = socket
  if (remoteAddress === undefined || remotePort === undefined || localPort === undefined) {
    return { kind: 'unknown', reason: 'the connection did not name both of its ends' }
  }

  let contents: string
  try {
    contents = await readFile(PROC_NET_TCP, 'utf8')
  } catch {
    return { kind: 'unknown', reason: `${PROC_NET_TCP} could not be read` }
  }

  const uid = findPeerUid(contents, {
    remoteAddress: normaliseLoopback(remoteAddress),
    remotePort,
    localAddress: normaliseLoopback(localAddress ?? '127.0.0.1'),
    localPort,
  })
  if (uid === null) {
    return { kind: 'unknown', reason: 'no socket in /proc/net/tcp matched this connection' }
  }

  if (uid === ownUid) return { kind: 'same_user' }

  // WSL relays everything that starts on the Windows side through a root-owned
  // socket inside the VM, so the owner's own browser arrives here as uid 0 and
  // reads as a second account. That is the kernel declining to answer rather
  // than answering "someone else", and the difference decides whether the owner
  // can sign in at all: as `other_user` the request is refused outright and the
  // person is told to run the server under their own account, which is exactly
  // what they are already doing. `unknown` puts it on the approval code
  // instead, the same toll macOS pays, and that code is still a secret only the
  // owner's account can read. A second Linux account connecting directly still
  // carries its own uid and is still refused.
  if (uid === WSL_RELAY_UID && (await runsUnderWsl())) {
    return {
      kind: 'unknown',
      reason: 'this connection was relayed from the Windows side of WSL, which hides the account behind it',
    }
  }

  return { kind: 'other_user', uid }
}

/**
 * The IPv4-mapped spelling a dual-stack listener reports.
 *
 * The bind here is plain `127.0.0.1`, so this should not arise, but a mapped
 * address that fell through to `isIPv4` returning false would be reported as
 * `unknown` and would silently ask everyone for the approval code.
 */
function normaliseLoopback(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

/** Where the gate leaves its verdict for the handlers downstream of it. */
export const PEER_IDENTITY_LOCAL = 'homeyPeerIdentity'

/**
 * Reads back what the gate stored.
 *
 * Fails closed: a response that never passed through the gate reads as
 * `unknown`, which costs an approval code rather than granting a token.
 */
export function peerIdentityOf(response: { locals?: Record<string, unknown> }): PeerIdentity {
  const stored = response.locals?.[PEER_IDENTITY_LOCAL]
  if (typeof stored === 'object' && stored !== null && 'kind' in stored) return stored as PeerIdentity
  return { kind: 'unknown', reason: 'the identity of this connection was never checked' }
}
