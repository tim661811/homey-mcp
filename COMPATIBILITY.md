# Compatibility

What this server has actually been run against, as opposed to what it is written
to support. The distinction matters here more than in most projects, because the
maintainer owns exactly one Homey and every measured fact in the codebase came
off that one hub.

This file owns the hardware support policy: which hardware is supported, how that
gets established, and what to send. What the version number promises is declared
in the README under "Versioning, and what the public API is", and how a release
is cut is in [RELEASING.md](RELEASING.md). The three do not repeat each other on
purpose, so a change to one of those questions belongs in one file only.

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
| Homey Pro (Early 2023) and newer | Should work, and better | The V3 dialect paths, and any card or token feature added after the older line was frozen. Owner display names for app-owned and manager-owned cards are known to be missing on V3, because the field the V2 library fills is not sent. Not the historical energy report endpoints: no tool here reads them on any generation, so they are probed and reported by `doctor` and nothing more |
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

### When the report is the only thing you can contribute

Which is the normal case, and it is enough. You do not need to read the code,
reproduce anything twice, work out the cause, or open a pull request. The report
is not a lesser contribution here: it is the only route by which hardware nobody
here owns ever produces real data, so it is the thing that moves a row out of the
second table.

What makes a report usable, in the order it is worth doing:

1. **Run it and read it before you send it.** `npx homey-mcp doctor --report`
   scrubs by design, and you should be able to satisfy yourself of that by
   looking rather than by trusting this paragraph. If you see anything in it you
   would not post in public, say so in the issue instead of trimming it silently,
   because a hole nobody knows about is worse than a hole.
2. **Paste it whole.** Which probes failed matters as much as which passed, and a
   report edited down to the interesting part usually loses the deciding line.
3. **Say what you actually did.** Which tools you called and what came back, in
   your assistant's own words. A tool name plus the message it returned is worth
   more than a description of the message.
4. **Say whether creating a Flow worked.** That is the one thing this server does
   that nothing else does, it depends on a session scope and a wire format that
   differ between hardware generations, and it is the likeliest thing to be
   broken on a hub nobody here can test.
5. **Run `npx homey-mcp doctor` without `--report` too** if something failed. The
   plain output names a fix for each failing check, and whether that fix helped
   is part of the answer.

Two things not to do: do not attach anything captured from your Homey, such as a
fixture file or a raw API response, because that publishes the shape of your home
and the report already carries what is needed; and do not wait until you have
something working. A report saying every tool failed on your hardware is as
useful as one saying they all passed. It turns "supported but untested" into a
documented limit, which is the difference between a reader getting a straight
answer and a reader getting a guess.

Whether it worked or not, the result is a row in the table above, credited to you
by whatever name you want, or left anonymous if you say so.
