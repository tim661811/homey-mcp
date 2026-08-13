# homey-mcp

Give an AI assistant real access to your Homey Pro: read the whole home, ask
questions about sensor and energy history, and **build working Flows from a
sentence**.

```
"Turn the hallway light on when the motion sensor sees something after sunset,
 but only when nobody is home."
```

The assistant finds the sensor, finds the light, looks up which Flow cards your
Homey actually has for them, checks the arguments, and writes the Flow. You open
the Homey app and it is there.

## Why this exists

Athom ships an official MCP server at `mcp.athom.com`, and it is good at what it
does: reading device state, running existing Flows, setting Moods. What it cannot
do is **create** an automation. Neither can any of the community Homey MCP servers,
and that turns out not to be an oversight.

Creating a Flow needs a write scope that Athom deliberately withholds from
third-party OAuth clients, and the local API keys that would carry it do not exist
on Homey Pro hardware older than 2023. This server goes through the one route that
does work: the session your own Homey CLI login already holds.

It also does analytics the official server does not: trends, comparisons over time
and energy arithmetic computed from your Insights history.

## Requirements

- A **Homey Pro**. Homey Cloud and Homey Bridge have no local API and are not
  supported.
- **Node 24 or newer** (`homey-api` requires it).
- The official Homey CLI, to sign in to your Athom account:

```bash
npm install --global homey
homey login
homey select
```

## Setup

```bash
npx homey-mcp setup
```

It finds your Homey on the network, verifies it can reach it, and prints the exact
command to register the server with your assistant. No IP addresses to hunt down,
no JSON to hand-edit.

For Claude Code:

```bash
claude mcp add --scope user --transport stdio homey -- npx -y homey-mcp@latest
```

Check everything at any time:

```bash
npx homey-mcp doctor
```

## What it can do

**Understand your home.** One call returns the zone tree, devices by room and
type, installed apps, logic variables and presence. Search devices by room,
capability or name, with live values.

**Control it.** Set a capability, set a logic variable, start an existing Flow.

**Build automations.** Search the Flow cards your Homey actually has (a real hub
has around 800 of them), inspect a card's arguments and tokens, resolve device
arguments, validate a proposed Flow client-side, then create it. Advanced Flows
too, where the hardware supports them.

**Answer questions about history.** Find the right Insights series from a plain
description, query one or several at a resolution, compare two periods, and get
statistics with an honest coverage figure. Live power draw, and energy over time
computed correctly from cumulative meters rather than averaged into nonsense.

## Safety

This software can change your house, so it is deliberately cautious.

- Every mutating tool is annotated so your client can ask before running it.
- New Flows are created **disabled**, in their own folder. Nothing starts running
  your home the moment it is written.
- Updating or deleting a Flow this server did not create requires an explicit
  confirmation, and keeps a copy of the previous version.
- After writing a Flow it is read back and compared against what was sent.
- There is no generic "call any endpoint" tool. Every capability is a named tool
  with its own validation.
- Credentials are stored with `0600` permissions in your user config directory,
  and are stripped from every log line, error message and tool response.

See [SECURITY.md](SECURITY.md) for the full picture.

## Hardware support

| Hardware | Status |
|---|---|
| Homey Pro (Early 2019), `homey4d` | **Tested.** Every measured behaviour in this project came from one of these. |
| Homey Pro (Early 2018) | Expected to work: same API generation and firmware line, but untested. |
| Homey Pro (Early 2016) | Unknown. This generation can report an older API version again (`apiVersion 1`), a third dialect this server does not implement. `doctor` will tell you which one your hub speaks. |
| Homey Pro (Early 2023) and newer | **Supported but untested.** The code detects the newer API dialect and adapts, and the newer hardware is strictly more capable, but nobody has run it against one. Bug reports very welcome. |
| Homey Cloud, Homey Bridge | Not supported. No local API. |

### About the hardware I cannot test

I own one Homey: a Homey Pro (Early 2019). Every measured behaviour in this
project came off that single hub.

That shapes what is useful to send me. A bug that only reproduces on another
generation is one I cannot reproduce, cannot verify a fix for, and cannot keep
working afterwards, so a plain bug report about it does not get anywhere. Two
things do:

- **A hardware compatibility report.** Run `npx homey-mcp doctor --report` and open
  the compatibility issue template with the output. The report is scrubbed by
  design: hardware model, API dialect, firmware version, which capability probes
  passed, which endpoints are missing. No device names, no addresses, no
  credentials. That is enough to fix most things blind, and it is how
  "supported but untested" turns into something real.
- **A pull request with evidence that it works.** A short recording, a screenshot
  of the created Flow in the Homey app, or the doctor report before and after.

Confirmed reports are collected in `COMPATIBILITY.md` with credit.

Capabilities are probed at runtime rather than inferred from a version number,
because the two hardware generations publish the same firmware version numbers
while having completely different feature sets. Advanced Flow is a paid unlock on
older hubs, so its tools appear only when your hub actually has it. Energy report
endpoints do not exist before the 2023 hardware, so historical energy is computed
from Insights instead.

## Privacy

Everything runs on your machine, and there is no telemetry of any kind. Nothing is
ever sent to the author or to any third party.

Where your data actually goes depends on which route reaches your Homey, and the
server tells you which one it used:

- **Over your network**, the normal case. Your credential authenticates straight
  at the hub and no home data touches the internet. `doctor` reports this as a
  local or local TLS connection.
- **Through Athom's cloud**, when no local address answers, for example when this
  server runs somewhere other than your home network. Then every call is relayed
  by Athom, the same as using the Homey app while away. `doctor` says so plainly,
  and the server's own startup log names the route.

Reaching the Athom cloud is also needed the first time, to learn where your Homey
answers on your network. That address is then cached locally so later starts can
skip it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). One rule matters more than the rest: never
commit anything captured from a real Homey, not even pseudonymised. A pre-commit
hook and a CI check enforce it.

## License

MIT. See [LICENSE](LICENSE).

This is an independent project. It is not affiliated with, endorsed by, or
supported by Athom B.V. "Homey" is their trademark, used here only to say what
this software talks to.
