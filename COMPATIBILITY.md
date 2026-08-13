# Compatibility

What this server has actually been run against, as opposed to what it is written
to support. The distinction matters here more than in most projects, because the
maintainer owns exactly one Homey and every measured fact in the codebase came
off that one hub.

## Confirmed

| Hardware | Model id | API | Firmware | Confirmed by | Date |
|---|---|---|---|---|---|
| Homey Pro (Early 2019) | `homey4d` | v2 (`apiVersion 2`, `platformVersion` absent) | 13.2.4 | maintainer | 2026-08-13 |

On that hub, verified end to end: reading devices, zones, apps, logic variables
and flows; the Insights catalogue and history queries; live energy; creating a
standard Flow and an Advanced Flow through the API and deleting them again.

## Not confirmed

| Hardware | Expectation | What is unknown |
|---|---|---|
| Homey Pro (Early 2018) | Should behave identically | Same API generation and firmware line as the 2019, but nobody has run it |
| Homey Pro (Early 2016) | May not work at all | This generation can report `apiVersion 1`, a third dialect this server does not implement |
| Homey Pro (Early 2023) and newer | Should work, and better | The V3 dialect paths, Energy reports, and any card or token feature added after the older line was frozen. Owner display names for app-owned and manager-owned cards are known to be missing on V3, because the field the V2 library fills is not sent |
| Homey Cloud, Homey Bridge | Will not work | No local API exists |

## Adding to this file

If you own something in the second table, this is the single most useful thing
you can contribute, and it costs you one command:

```bash
npx homey-mcp doctor --report
```

That prints a report which is scrubbed by design: hardware model, API dialect,
firmware version, which capability probes passed, and which endpoints are
missing. No device names, no addresses, no credentials. Open a
[hardware compatibility issue](https://github.com/tim661811/homey-mcp/issues/new?template=hardware-compatibility.yml)
with it and say what you tried.

Confirmed reports get a row above, credited to whoever sent them.

Plain bug reports against hardware nobody can reproduce on tend to go nowhere,
which is why this route exists instead. A pull request carrying evidence that
something works is welcome too, and outranks everything else here.
