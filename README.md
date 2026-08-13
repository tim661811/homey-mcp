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
- Nothing else. Setup installs the official Homey CLI and signs you in if you want
  it, and works without it if you do not.

## Setup

```bash
npx homey-mcp setup
```

It checks Node, looks for the official Homey CLI, offers to install it and walks
you through signing in and picking a Homey, then connects and reads your Homey's
identity back before saving anything. Finally it prints the exact command to
register the server with your assistant. No IP addresses to hunt down, no JSON to
hand-edit.

Nothing is installed without asking. If you would rather not have the CLI, decline
and setup uses an Athom Personal Access Token from
<https://tools.developer.homey.app/me> instead. Everything works on that token
except creating Flows, which needs the root scope only Athom's own tool is given.

To do the CLI part yourself instead:

```bash
npm install --global homey
homey login
homey select
```

For an unattended run, `npx homey-mcp setup --yes` accepts those offers up front.
It will not replace credentials you already have.

For Claude Code:

```bash
claude mcp add --scope user --transport stdio homey -- npx -y homey-mcp@latest
```

Check everything at any time:

```bash
npx homey-mcp doctor
```

### What this rests on, and how it can break

The thing that makes this server able to create Flows is also its most fragile
dependency. It is worth knowing before you install rather than after.

Athom withholds flow-write scopes from third-party OAuth clients, and the local
API keys that would carry them do not exist on Homey Pro hardware older than
2023. The one credential that does carry the scope is the session your own
`homey login` created, and the official Homey CLI keeps that session in a file it
owns: `~/.athom-cli/settings.json`, or `~/.homey/settings.json` on newer CLI
releases, or wherever `HOMEY_HOME` points. This server reads that file.

Nothing about it is a public interface. It is another program's private state:
undocumented, not covered by anybody's compatibility promise, and free to change
shape or move in any CLI release. It has moved once already, which is why both
locations are checked. So:

- A Homey CLI update can break this server without a line changing here. The
  symptom is a start that reports no usable credentials, and
  `npx homey-mcp doctor` then says whether the CLI is installed, whether a login
  is stored on this machine and which Homey is selected, which is what separates
  "the file moved again" from "the session simply expired".
- This server only ever **reads** that file. It never writes it, and it never
  drives the CLI in the background. `homey login` and `homey select` are run by
  `setup` only, with you watching.
- A session in it lasts exactly **24 hours**, so a server left running outlives
  its own credential every day. It does not stop when that happens: the first
  call Homey refuses makes it read the credential source again and sign in once
  more, which usually finds the newer session the CLI has already written there.
  So leaving it running is the intended way to use it, and a session expiring is
  not a reason to restart anything. What it will not do is repeat the call it was
  in the middle of when the session died, unless that call only read something:
  a refused write may still have been carried out by Homey, so it is reported
  back with the session renewed and you decide whether to send it again. If
  nothing usable is left in the file, the failure says so and names the command
  that fixes it.
- Five things are read out of it and nothing else: the two tokens, which Homey is
  active, and the session's expiry and scopes. The tokens authenticate to your
  own Homey and, when no local address answers, to `api.athom.com`. Nothing in
  that file is sent anywhere else.
- The way around it is an Athom **Personal Access Token** in `HOMEY_PAT`, from
  <https://tools.developer.homey.app/me>. That is a documented, supported
  credential that does not involve the CLI at all. Everything works on it except
  creating Flows.

If that trade is not one you want to make, the honest summary is that this
project's headline feature depends on a file it does not own, and the supported
credential cannot do the headline feature.

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

## Versioning, and what the public API is

Semantic versioning's first requirement is that a project declares a public API.
For this one that is the **tool surface**, not the TypeScript inside it. The
package ships a command, not a library. It declares no `exports` map and no
library entry point, and while the build does emit `.d.ts` files next to the
compiled JavaScript, nothing they describe is part of the public API: `main` and
`reportExitCode` in `dist/index.js` exist to start the process, and importing
them or anything deeper in `dist/` is unsupported and can break in a patch
release.

**Covered by the version number:**

- The **tool names**. Twenty-two of them, and the two Advanced Flow ones are
  registered only on a hub that has Advanced Flow:

  ```
  homey_home_overview          homey_flows_list          homey_flowcards_search
  homey_devices_search         homey_flow_get            homey_flowcard_describe
  homey_device_get             homey_flow_start          homey_flowcard_autocomplete
  homey_device_set_capability  homey_flow_validate       homey_insights_search
  homey_variable_set           homey_flow_create         homey_insights_query
  homey_energy_live            homey_flow_update         homey_advancedflow_create
  homey_weather                homey_flow_delete         homey_advancedflow_update
  homey_doctor
  ```

- The **input schema of each tool**: parameter names, their types, which are
  required, and the accepted values of the ones that take a fixed set.
- The **structured result fields**: a field that a tool returns keeps its name,
  its type and its unit.
- The **command line**: `serve`, `setup` and `doctor`, the flags each one takes,
  the exit codes, and the environment variables `HOMEY_MCP_CONFIG`, `HOMEY_PAT`
  and `HOMEY_MCP_LOG_LEVEL`.
- That `doctor --report` keeps carrying hardware model, API dialect, firmware
  version, capability probe verdicts and missing endpoints, and keeps carrying
  nothing that identifies a household.

**Not covered, deliberately:** the human-readable text a tool returns, the server
instructions and the wording of errors, all of which are written for a model to
read and get rewritten whenever a model reads them badly; which tools exist on
your particular hub, since that is probed at runtime and reported by `doctor`;
the layout of `src/` and every export in it; the address cache file; and any
field of `doctor --json` beyond the ones named above.

**What 0.x means here.** Semver imposes nothing below 1.0: it says outright that
anything may change at any time. The following is therefore this project's own
promise rather than something the specification gives you:

- a change that breaks anything in the covered list bumps the **minor**, so
  0.1.x becomes 0.2.0;
- new tools, new optional parameters, new result fields and fixes bump the
  **patch**.

Read a 0.x minor bump the way you would read a major one after 1.0. If you have
built anything on top of this, pin it: `homey-mcp@~0.1.0` takes patches only.

**What would earn a 1.0.** Four things, none of them true yet:

1. The V3 dialect confirmed against real 2023-or-newer hardware by at least one
   compatibility report, so the second half of the hardware table stops being a
   reasoned guess.
2. One full minor cycle in which nothing in the covered list had to break.
3. The credential route settled. Creating a Flow depends on a file the Homey CLI
   owns and has already moved once, described under
   [What this rests on](#what-this-rests-on-and-how-it-can-break). A 1.0 needs
   either a supported credential that can create Flows, or a full minor cycle
   showing that route holding still. A 1.0 whose headline feature breaks on
   somebody else's release is a 1.0 in name only.
4. The `doctor --report` field set settled, since the issue templates quote it
   and a compatibility report is only comparable against other reports of the
   same shape.

**What you can rely on today.** Tool names and their arguments do not change
within `0.1.x`. The safety behaviour does not loosen in a patch: new flows are
created disabled in their own folder, touching anything this server did not
create needs an explicit confirmation and keeps a pre-image, there is no generic
"call any endpoint" tool, and credentials never appear in a tool result. There is
no telemetry, and adding any would not be a patch.

Three documents divide this up and are meant not to repeat each other:
this section owns what the version number promises,
[RELEASING.md](RELEASING.md) owns how a release is cut, and
[COMPATIBILITY.md](COMPATIBILITY.md) owns which hardware is supported and how
that is established.

## Hardware support

| Hardware | Status |
|---|---|
| Homey Pro (Early 2019), `homey4d` | **Tested.** Every measured behaviour in this project came from one of these. |
| Homey Pro (Early 2018) | Expected to work: same API generation and firmware line, but untested. |
| Homey Pro (Early 2016) | **Likely not supported.** This generation can report an older API version again (`apiVersion 1`), a third dialect this server does not implement. `doctor` will tell you which one your hub speaks. |
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

**If the report is all you can send, send the report.** It is a complete
contribution on its own, not a lesser version of a pull request: it is the only
route by which hardware nobody here owns ever gets real data, and a row in
[COMPATIBILITY.md](COMPATIBILITY.md) credited to you is the result either way.
You do not need to read the code, reproduce anything twice, or work out what
went wrong. Paste the report, say which tools you called and what came back in
your assistant's own words, and say whether creating a Flow worked, since that
is the one thing here that no other server does and the likeliest thing to break
on hardware I cannot test. A report that says everything failed is worth as much
as one that says everything worked. [COMPATIBILITY.md](COMPATIBILITY.md) has the
full checklist and owns the hardware support policy.

Capabilities are probed at runtime rather than inferred from a version number,
because the two hardware generations publish the same firmware version numbers
while having completely different feature sets. Advanced Flow is a paid unlock as
well as a firmware feature, so its two tools are registered only when the startup
probe found the route, or could not tell. A probe that fails is not a verdict
about your hardware: this hub rate limits its own local API, so one refused
request at startup would otherwise hide a working feature for as long as the
server runs. `doctor` reports which of the two answers each probe gave, and
restarting the server probes again.

**Historical energy comes from Insights on every generation**, and that is worth
stating plainly because it is easy to read the table above as if newer hardware
took a different path. It does not. `homey_energy_live` answers what the house is
drawing right now, and everything over time is computed from Insights logs:
`meter_power`, a cumulative counter where consumption is the difference between
two points, and `measure_power`, instantaneous watts where energy is the area
under the line. The 2019 hardware has no historical energy report endpoints at
all, and on the hubs that do have them this server does not read them either. So
a 2023 hub answers energy history through exactly the same route as a 2019 one.
`doctor` still probes for the report endpoints, because knowing which hubs have
them is what a future version would need.

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
