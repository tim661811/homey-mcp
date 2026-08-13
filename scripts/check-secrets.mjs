#!/usr/bin/env node
// Blocks credentials and household data from entering a public repository.
//
// Runs in two modes:
//   --staged  (pre-commit hook) scans only what is about to be committed
//   default   (CI) scans every tracked file
//
// The rules below are deliberately narrow. A scanner that cries wolf gets
// bypassed with --no-verify within a week, and then it protects nothing.

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const scanStagedOnly = process.argv.includes('--staged')

const RULES = [
  {
    id: 'private-ipv4',
    description: 'private LAN address (exposes the home network layout)',
    pattern: /\b(?:192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/g,
  },
  {
    id: 'dashed-private-ipv4',
    description: 'homeylocal.com style dashed LAN address',
    // The 172.16/12 block is here as well as in `private-ipv4`. It was missing,
    // so a hub on a 172.16-31 network could commit its own dashed hostname while
    // the same address in dotted form was caught. src/util/redact.ts holds the
    // matching pair; change one and change the other.
    pattern: /\b(?:192-168-\d{1,3}|10-\d{1,3}-\d{1,3}|172-(?:1[6-9]|2\d|3[01])-\d{1,3})-\d{1,3}\b/g,
  },
  {
    id: 'email',
    description: 'e-mail address',
    // The final label must be alphabetic. Without that, an npm package spec such
    // as `homey-api@3.14.16` reads as an address, and documentation that pins a
    // version is exactly the kind of false positive that gets a scanner ignored.
    pattern: /\b[\w.+-]+@(?!example\.(?:invalid|com)\b)[\w.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    id: 'bearer-token',
    description: 'bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g,
  },
  {
    id: 'token-assignment',
    description: 'hardcoded token or secret value',
    // Matches access_token: "...", refreshToken='...', HOMEY_PAT=... with a real value.
    pattern: /\b(?:access_?token|refresh_?token|session_?token|api_?key|client_?secret|homey_pat|password)\b\s*[:=]\s*['"`]?[A-Za-z0-9._~+/-]{16,}/gi,
    // `access_token: CLOUD_ACCESS_TOKEN` assigns a constant, not a secret. Every
    // language spells constants in screaming snake case and no real credential
    // looks like one, so this costs no coverage. It is worth the extra rule:
    // a scanner that cries wolf is a scanner people start bypassing.
    skipMatch: (match) => /[:=]\s*[A-Z][A-Z0-9_]*$/.test(match),
  },
  {
    id: 'athom-id',
    description: 'Athom cloud or user id (24 hex characters)',
    pattern: /\b[0-9a-f]{24}\b/g,
    // Scrubbed fixtures legitimately contain 24-hex pseudonyms, so only guard
    // source and documentation.
    onlyPaths: /^(?:src|scripts|docs|\.github)\/|^[^/]+\.(?:md|json|ya?ml)$/,
    ignorePaths: /^package-lock\.json$/,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
]

// Files that may never be committed at all, whatever their content.
const FORBIDDEN_PATHS = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)settings\.json$/,
  /(^|\/)tests\/fixtures\/raw\//,
  // local/ holds pseudonymised captures. Safer than raw, but still a real
  // household's zone tree, device inventory and installed apps, so it is exactly
  // as uncommittable. Both tiers are named in .gitignore and CONTRIBUTING.md;
  // this is the half that survives someone reaching for `git add -f`.
  /(^|\/)tests\/fixtures\/local\//,
  /\.token$/,
]

const BINARY_OR_HUGE = /\.(?:png|jpg|jpeg|gif|ico|pdf|zip|gz|tgz|woff2?|mp4)$/i

function listFiles() {
  const args = scanStagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files']
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function readCandidate(path) {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const findings = []

for (const path of listFiles()) {
  const forbidden = FORBIDDEN_PATHS.find((pattern) => pattern.test(path))
  if (forbidden) {
    findings.push({ path, line: 0, rule: 'forbidden-path', description: 'file must never be committed', sample: path })
    continue
  }

  if (BINARY_OR_HUGE.test(path)) continue

  const content = readCandidate(path)
  if (content === null) continue

  const lines = content.split('\n')
  for (const rule of RULES) {
    if (rule.onlyPaths && !rule.onlyPaths.test(path)) continue
    if (rule.ignorePaths && rule.ignorePaths.test(path)) continue

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes('check-secrets-allow')) continue
      rule.pattern.lastIndex = 0
      const match = rule.pattern.exec(line)
      if (match && !rule.skipMatch?.(match[0])) {
        findings.push({
          path,
          line: index + 1,
          rule: rule.id,
          description: rule.description,
          sample: match[0].slice(0, 48),
        })
        break
      }
    }
  }
}

if (findings.length === 0) {
  console.error(`check-secrets: clean (${scanStagedOnly ? 'staged changes' : 'all tracked files'})`)
  process.exit(0)
}

console.error('\ncheck-secrets: refusing to continue. This repository is public.\n')
for (const finding of findings) {
  console.error(`  ${finding.path}:${finding.line}`)
  console.error(`    ${finding.rule} - ${finding.description}`)
  console.error(`    ${finding.sample}`)
}
console.error(`
${findings.length} problem${findings.length === 1 ? '' : 's'} found.

Fix it rather than bypassing it:
  - raw captures belong in tests/fixtures/raw/, which is gitignored. Publish only
    the output of: node scripts/scrub-fixtures.mjs tests/fixtures/raw tests/fixtures
  - credentials belong in the user config directory, never in the tree
  - if a match is genuinely a false positive, append the comment
    check-secrets-allow to that line and say why
`)
process.exit(1)
