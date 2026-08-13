# Security

## Reporting a vulnerability

Report security issues through GitHub's private vulnerability reporting on this
repository (Security tab, "Report a vulnerability"). Please do not open a public
issue for anything exploitable. Expect a first response within a week.

## What this server can reach

`homey-mcp` runs as a local process on your own machine and talks to two places:

- **Your Homey**, over your LAN. It reads devices, zones, apps, logic variables,
  flows, flow cards and Insights history, and it can write: set a capability,
  set a variable, start a flow, and create, update or delete flows.
- **`api.athom.com`**, once per session, only to exchange your Athom credential
  for a Homey session token. No home data flows through it.

It exposes no network listener of its own. The transport is stdio, so the only
thing that can call it is the process that spawned it.

## Credential handling

- Credentials are read from, in order: an explicit config file, the
  `HOMEY_PAT` environment variable, or an existing Homey CLI session.
- Anything this server writes itself is written with `0600` permissions to the
  user config directory, never into the repository or the package.
- Tokens are redacted from all log output and from every error message that can
  reach a model or a transcript. A token must never end up in an MCP response,
  because those get stored in conversation history.
- Nothing is ever sent to any third party. There is no telemetry.

## Blast radius, and how it is bounded

An assistant driving this server can change your home. That is the point of it,
and it is also the risk. The mitigations are:

- Every mutating tool carries the MCP `destructiveHint` annotation, so clients
  can prompt before running it.
- Created flows land **disabled** and in a dedicated folder, so nothing starts
  running your house the moment it is written.
- Destructive operations on objects this server did not create require an
  explicit `confirm` argument.
- Delete and update keep a pre-image of the previous state so a mistake can be
  undone.
- There is deliberately no generic "call any API endpoint" tool. Every capability
  is a named tool with its own annotation and validation.

## Known advisories in dependencies

`npm audit` reports four moderate advisories, all of them transitive through
`homey-api`, Athom's own client package:

```
parseuri <2.0.0            ReDoS (GHSA-6fx8-h7jm-663j)
  engine.io-client 3.5.6
  socket.io-client 2.5.0
```

They are not fixable from here. Athom pins the Engine.IO v3 protocol because that
is what Homey Pro (2016 - 2019) speaks, and `npm audit fix --force` would install
`homey-api@3.14.16`, an older major that breaks the client outright.

They are also not reachable in this server. All of it lives in the Socket.IO
connection path, and this server never opens that socket: every tool is a plain
request/response call. If a future feature needs live subscriptions, this note
has to be revisited before that feature ships.

## Supported versions

Only the latest published minor version receives fixes while the project is
pre-1.0.
