// Signing in, from inside the conversation.
//
// This exists because of how the failure used to look. A Homey session lasts 24
// hours, so a server left registered stops working overnight, and an MCP client
// cannot show a reason for a process that exited: the user saw a red cross and a
// closed connection. The server now starts without a session, and this tool is
// the way out of that state without restarting anything.
//
// What it does NOT do is collect a credential. The MCP specification forbids
// asking for passwords, API keys or access tokens through elicitation, and the
// reason is worth restating: everything a tool returns, and everything a user
// types in answer to one, lands in a conversation transcript that is stored,
// summarised and copied well outside this process. So the secret never travels
// through here. The user signs in where Athom can talk to them directly, and
// this tool picks up the result.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import type { ServerContext } from '../context.js'
import { failureResult } from '../errors.js'
import { successResult } from '../render.js'
import type { HomeyIdentity } from '../../homey/types.js'

/** A connection that can acquire a session, which is what `openReconnectingConnection` returns. */
interface AuthenticatingConnection {
  readonly authenticated?: boolean
  authenticate?: () => Promise<HomeyIdentity>
}

export function registerAuthenticateTools(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'homey_authenticate',
    {
      title: 'Sign in to Homey',
      description: [
        'Signs this server in to the Homey, or confirms that it already is.',
        'Call this when any other tool reports that the server is not signed in. A Homey session lasts 24 hours, so a server that has been running for a day needs this rather than a restart.',
        'It does not ask for a password or a token and never handles one: the user signs in with Athom directly, and this picks up the result.',
        'If it reports that it could not sign in, read the instructions it returns to the user verbatim. They name the exact commands, and which of the two routes keeps working after 24 hours.',
      ].join(' '),
      // The plain read annotations, including openWorldHint false. Signing in
      // does reach Athom, but so does every other tool whenever the hub is
      // reached over the cloud, and this project treats the user's own Homey and
      // the account behind it as one known system rather than an open world.
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {},
    },
    async () => {
      const connection = context.connection as AuthenticatingConnection

      try {
        if (connection.authenticate === undefined) {
          // A connection built without the reconnecting wrapper, which is what a
          // test does. Nothing to sign in with, and saying so is better than
          // pretending the call did something.
          return successResult('This server was started with a fixed connection, so there is nothing to sign in.', {
            ok: true,
            alreadySignedIn: connection.authenticated !== false,
            changed: false,
          })
        }

        const alreadySignedIn = connection.authenticated !== false
        const identity = await connection.authenticate()

        // The cache was filled, or not filled, against whatever came before. A
        // fresh session can be a different hub entirely if the credentials
        // changed, so nothing read earlier is trustworthy now.
        if (!alreadySignedIn) context.cache.invalidate()

        return successResult(
          alreadySignedIn
            ? `Already signed in to "${identity.name}", a ${identity.modelName} on firmware ${identity.softwareVersion}.`
            : `Signed in to "${identity.name}", a ${identity.modelName} on firmware ${identity.softwareVersion}. Every tool works from here.`,
          {
            ok: true,
            alreadySignedIn,
            changed: !alreadySignedIn,
            homey: {
              name: identity.name,
              model: identity.modelName,
              firmware: identity.softwareVersion,
              reachedOver: identity.addressKind,
            },
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'sign in to Homey', logger: context.logger })
      }
    },
  )
}
