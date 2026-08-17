# Contributing

Thanks for looking. This is a small project with one strict rule, explained first
because it is the one that matters.

## Never commit anything captured from a real Homey

Not even a pseudonymised copy. Replacing names and ids removes the direct
identifiers but still publishes the shape of somebody's home: how many rooms they
have, which apps they run, which kinds of device are in which room. That is not
ours to publish.

A pre-commit hook enforces this. It is installed for you by `npm install` and it
blocks LAN addresses, e-mail addresses, tokens, JWTs and anything under
`tests/fixtures/raw/` or `tests/fixtures/local/`. You can run it by hand:

```bash
npm run check:secrets            # every tracked file
node scripts/check-secrets.mjs --staged   # just what you are about to commit
```

If it blocks something that is genuinely fine, append the comment
`check-secrets-allow` on that line and explain why in the commit message. Do not
reach for `--no-verify`. The same scan runs in CI, where it cannot be bypassed.

## Getting set up

```bash
npm install        # also installs the git hooks
npm test
npm run typecheck
npm run build
```

Node 24 or newer is required, because `homey-api` declares `engines.node >= 24`.

## The two kinds of test fixture

**Committed fixtures** (`tests/fixtures/*.json`) are hand-built. They contain no
household data. Each one exists to pin a specific behaviour that was measured on
real hardware, and each carries a comment saying which. They are what CI runs on,
so the suite works for a contributor who owns no Homey at all.

**Local fixtures** (`tests/fixtures/raw/`, `tests/fixtures/local/`) are captured
from your own Homey, are gitignored, and never leave your machine. They exist
because real hardware produces quirks that hand-written data does not: nulls in
the middle of an Insights series, a firmware that silently accepts an invalid
resolution, a rate limiter nobody documented.

To capture your own:

```bash
npm i -g homey && homey login && homey select
node scripts/capture-fixtures.mjs tests/fixtures/raw
```

If you ever want to attach a capture to a bug report, pseudonymise it first, then
read the result before sending it:

```bash
node scripts/scrub-fixtures.mjs tests/fixtures/raw tests/fixtures/local
```

## Style

- English for all code, comments, documentation and commit messages.
- Spell names out in full. `deviceCount`, not `devCnt`. Single letters only as
  loop indices.
- No em-dashes or en-dashes in prose or comments. ASCII hyphen only.
- Comments say why, not what.
- `console.log` is banned in `src/`: stdout carries the JSON-RPC stream and any
  stray write corrupts it. Log to stderr through `src/util/log.ts`.

## Trying a change in a real client before publishing

Publish last, not first. A published version is permanent, and the failures this
server is most likely to have are the ones no test sees: how it behaves when a
credential expired, what a client shows when it exits, whether the handshake
completes at all.

Register a second server pointing at the local build, alongside the published
one:

```bash
npm run build
claude mcp add --scope user --transport stdio homey-dev \
  -e PATH=/usr/local/bin:/usr/bin:/bin \
  -- node "$PWD/dist/index.js" serve
```

Both then appear in the client: `homey` running whatever is on npm, and
`homey-dev` running the working tree. Rebuild and restart the client to pick up a
change. Remove it with `claude mcp remove homey-dev -s user` when finished.

The explicit `PATH` is not optional decoration. A client passes its own
environment to the server it starts, and that environment is frequently not the
one the terminal has: on the machine this was written on, the client carried an
older Node than the shell did, and the server correctly refused to run on it. See
the note about node versions in CLAUDE.md.

## Releasing

Maintainers only, and the details are easy to get wrong, so they live in
[RELEASING.md](RELEASING.md) rather than here. The short version: bump the version
in a commit, let it go green on `main`, then publish a GitHub Release tagged
`v<version>`. That tag is what triggers the publish, and the workflow refuses to
publish if the tag and `package.json` disagree.

There is no npm token anywhere in this repository. Publishing authenticates with a
short-lived GitHub OIDC token, which also gets the release a provenance
attestation for free.

## Testing against real hardware

Anything touching flow creation should be tried against a real Homey before it
ships. Create flows disabled, in a dedicated folder, and clean up after yourself.
`homey:manager:flow` / `programmatic_trigger` is the safe trigger for test flows:
it only ever fires when something starts the flow explicitly.
