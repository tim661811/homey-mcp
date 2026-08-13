# Releasing

Written for a maintainer who has not done this before, or who did it once six
months ago and does not remember the details. Everything version-dependent here
was checked against the live registry and the installed npm on 2026-08-13.

`homey-mcp` is published to npm by
[`.github/workflows/release.yml`](.github/workflows/release.yml), which runs when
a GitHub Release is published. There is no npm token in this repository, in its
secrets, or on anybody's laptop. The workflow proves its identity to the registry
with a short-lived GitHub OIDC token, which npm calls trusted publishing.

Two things follow from that, and they are the reason this file exists:

- The trust is pinned to the **filename** `release.yml`. Renaming that file,
  renaming the repository, or renaming the GitHub account breaks publishing, and
  npm reports it as a plain 404 that reads like a missing package.
- Because the credential is minted per run rather than stored, anything that can
  run that workflow can publish. The `npm-publish` environment is what stops that
  being "any run on any ref".

## Cutting a release

Five steps. The only decision is the version number.

```bash
git switch -c release-0.1.1
npm version patch --no-git-tag-version
```

`npm version` writes `package.json` and `package-lock.json` and nothing else.
`--no-git-tag-version` matters: without it npm creates the tag immediately, which
would tag a commit before CI has said anything about it.

```bash
git commit -am "Release 0.1.1"
gh pr create --fill
```

Let CI go green on the pull request, then merge it. The version bump goes through
the same required checks as any other change, which is the point of bumping in a
commit rather than deriving the version from the tag.

```bash
git switch main && git pull
gh run list --commit "$(git rev-parse HEAD)"
```

Wait for every required check on that exact commit to report success. A local
`npm test` passing is not the pipeline passing.

```bash
gh release create v0.1.1 --target "$(git rev-parse HEAD)" --generate-notes
```

Publishing the Release starts `release.yml`. Watch it:

```bash
gh run watch --exit-status
```

The tag must be `v` followed by the exact version in `package.json`. The workflow
refuses to publish otherwise, on purpose: a tag that says one thing while the
tarball says another produces a published version that nobody can find in the
history, and release notes that describe something other than what people
install.

This project uses GitHub Releases as its changelog, so the generated notes are
the release notes. Edit them before publishing if the generated list needs
context.

### Why the version is bumped by hand and not derived from the tag

Three reasons, all of which bite later rather than immediately.

The version has to be inside the tarball. Deriving it from the tag means CI
editing `package.json` at publish time, so the published artifact claims a
version that appears in no commit, and the provenance attestation then points at
a tree that does not contain what shipped.

The alternative, having CI commit the bump back, needs write access to a
protected `main` from an automated job. That is exactly the capability this setup
is built to not have.

And the bump commit is what carries the version through the required checks. A
tag can be created on any commit at any time, including one that never passed CI.

## One-time setup

Done once for the lifetime of the package. Written down because when it needs
redoing (a revoked configuration, a moved repository) it will be years later.

### 1. Turn on two-factor authentication on the npm account

Not optional and not merely advised. `npm trust` refuses to run without
account-level 2FA, and it also refuses granular access tokens that have the
bypass-2FA option set.

### 2. The bootstrap publish, which cannot come from CI

npm will not attach a trusted publisher to a package that does not exist yet, and
`homey-mcp` has never been published. There is no way to pre-register a pending
publisher the way PyPI allows; the request for it is
[npm/cli#8544](https://github.com/npm/cli/issues/8544), still open. So the first
version on the registry has to be pushed by hand.

**A manual publish cannot carry provenance, and no combination of flags changes
that.** Provenance is signed with a CI provider's OIDC token, so npm hard-fails
outside GitHub Actions or GitLab CI with `Automatic provenance generation not
supported for provider: <name>`. Passing `--provenance` from a laptop does not
produce an unsigned attestation, it produces an error.

That is why the bootstrap publish is a deliberate throwaway rather than the real
`0.1.0`. It keeps the one permanently unattested version off the number anyone
actually installs.

```bash
npm login
```

Since December 2025 this issues a session token that lasts two hours and does not
appear in the account's token list, so there is nothing to clean up afterwards.

```bash
# From a scratch directory, NOT from this repository: do not commit a 0.0.0
# version, and do not let prepublishOnly ship a real build under it.
mkdir /tmp/homey-mcp-bootstrap && cd /tmp/homey-mcp-bootstrap
npm init --yes
npm pkg set name=homey-mcp version=0.0.0 license=MIT \
  description="Placeholder. See https://github.com/tim661811/homey-mcp"
npm publish --access public
```

Answer the two-factor prompt. Then, back in this repository:

```bash
npm trust github homey-mcp \
  --repository tim661811/homey-mcp \
  --file release.yml \
  --environment npm-publish \
  --allow-publish
```

`--file` takes the basename only, not a path, and it must match this repository's
workflow filename exactly. `--environment` must match the environment name in
step 3. Confirm with `npm trust list homey-mcp`.

Only one configuration per package is allowed. Replacing it means
`npm trust revoke homey-mcp --id <id>` first, using the id from `npm trust list`.

Once `0.1.0` is out through CI, retire the placeholder:

```bash
npm deprecate homey-mcp@0.0.0 "Placeholder release. Use 0.1.0 or later."
```

Deprecate rather than unpublish. npm's policy is that once `package@version` has
been used it can never be used again, so `0.0.0` is spent either way, and
unpublishing every version of a package blocks the name for 24 hours.

### 3. Create the `npm-publish` environment

npm's trusted publisher can pin the account, the repository and the workflow
filename. It has no field for a branch or a tag, so on the registry side any run
of `release.yml` on any ref would be accepted. The GitHub environment supplies the
missing constraint, and it only counts because the same name was recorded on the
npm side in step 2.

In **Settings, Environments, New environment**, named exactly `npm-publish`:

- Set **Deployment branches and tags** to **Selected branches and tags**.
- Add one rule with ref type **Tag** and pattern `v*`.
- Add no secrets and no variables.

That last point is load-bearing. The moment an `NPM_TOKEN` is added here as a
fallback, the workflow has a long-lived publishing credential again and
everything above becomes decoration.

Optionally add yourself as a required reviewer. That turns publishing into a
button press with a human behind it, at the cost of a release that stalls until
someone is at a computer.

### 4. Close the token door

On the package's npm page, under **Settings, Publishing access**, select
**Require two-factor authentication and disallow tokens**.

Trusted publishing keeps working: that setting only affects traditional token
authentication, and OIDC is not that. If any npm token still exists on the
account for this package, delete it now.

This is worth doing rather than leaving for later. Write-capable granular access
tokens now expire after at most 90 days and default to 7, so a token left lying
around is both a recurring chore and a publishable credential.

## What the provenance badge proves, and what it does not

The published package carries two Sigstore-backed attestations, signed under a
certificate recorded in a public transparency log. Anyone can read them back:

```bash
curl -s https://registry.npmjs.org/-/npm/v1/attestations/homey-mcp@0.1.0 | less
npm audit signatures
```

They prove that this exact tarball was built and published by a specific workflow
run, in this repository, from a specific commit. That is enough for a reader to go
and look at the source at that commit and reason about what they installed.

They do not prove the code is safe. npm says so directly: established provenance
does not guarantee a package has no malicious code. Specifically, provenance says
nothing about whether the source was reviewed, whether the build is reproducible
(nothing re-runs it to compare), whether the person who cut the release should
have been allowed to, or whether the dependency tree is clean. It also says
nothing about the bootstrap `0.0.0`, which has no attestation at all.

What it changes is the question a user has to answer. Instead of trusting the
maintainer's laptop, they trust this repository and a CI run they can inspect.
That is a real reduction in attack surface and nothing more than that.

## When it goes wrong

**`E404 Not Found` on publish, and the package plainly exists.** Almost always a
trust mismatch rather than a missing package. Check that the workflow is still
named `release.yml`, that the repository is still `tim661811/homey-mcp`, and that
`npm trust list homey-mcp` matches all of that including the environment name.

**The job fails at the tag guard.** The tag and `package.json` disagree. Fix the
version in a commit and re-tag. Do not edit either one inside CI; that publishes a
version that exists in no commit.

**The job fails at the npm floor check.** The runner's Node started bundling an
npm older than 11.5.1, which should not happen on Node 24 but is asserted rather
than assumed. Pin the runner to a Node version that bundles a new enough npm.

**Publish succeeded, provenance check failed.** The version is live and
unattested. Nothing rolls it back automatically. Check whether the repository or
the package became private (provenance requires both to be public) and whether the
trust configuration still exists, then release a patch version once fixed.

**A release was cut from a bad commit.** The workflow re-runs typecheck, tests and
build from the tagged tree, both in the verify job and again through
`prepublishOnly`, so a broken tree fails before anything is published. That is the
actual guard, not branch protection: `enforce_admins` is off on `main`, and a
Release can be created from any commit.

## Things not to change without reading this file again

- The filename `release.yml`. It is part of the npm trust configuration.
- The `npm-publish` environment name, on either side. Both must match.
- `prepublishOnly` in `package.json`. It is what builds the gitignored `dist/`
  that the `files` list ships, so removing it publishes an empty package.
- The absence of `--ignore-scripts` on `npm publish`. It belongs on `npm ci`,
  where it stops dependency install hooks running next to a live credential.
  On `npm publish` it would skip `prepublishOnly`.
