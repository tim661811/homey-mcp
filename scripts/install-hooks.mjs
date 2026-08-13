#!/usr/bin/env node
// Points git at the repository's own hooks directory, so the secret scan runs
// before every commit without anyone having to remember to install it.
//
// Runs from npm's "prepare" lifecycle, which fires on `npm install` inside a
// clone but not when this package is installed as a dependency. It must never
// break an install: if there is no git repository, or git is unavailable, that
// is a normal situation and not an error.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

try {
  if (!existsSync('.git')) process.exit(0)

  const currentHooksPath = (() => {
    try {
      return execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  })()

  if (currentHooksPath === '.githooks') process.exit(0)

  // Do not silently stomp a hooks path someone deliberately set to something else.
  if (currentHooksPath !== '') {
    console.error(`homey-mcp: leaving core.hooksPath as "${currentHooksPath}".`)
    console.error('homey-mcp: run "git config core.hooksPath .githooks" to enable the secret scan.')
    process.exit(0)
  }

  execFileSync('git', ['config', 'core.hooksPath', '.githooks'])
  console.error('homey-mcp: enabled the pre-commit secret scan (core.hooksPath -> .githooks)')
} catch {
  // Never fail an install over a developer convenience.
  process.exit(0)
}
