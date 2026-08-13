import { describe, expect, it } from 'vitest'

import type { FlagSpec } from './flags.js'
import { checkFlags, DOCTOR_FLAGS, readFlagValue, SERVE_FLAGS, SETUP_FLAGS } from './flags.js'

describe('readFlagValue', () => {
  it('returns the token after the flag', () => {
    expect(readFlagValue(['--config', '/tmp/credentials.json'], '--config')).toBe('/tmp/credentials.json')
  })

  it('returns null when the flag is absent', () => {
    expect(readFlagValue(['--json'], '--config')).toBeNull()
  })

  it('returns null when the flag is last and has nothing after it', () => {
    expect(readFlagValue(['--json', '--config'], '--config')).toBeNull()
  })

  it('does not read the next flag as the value', () => {
    // "doctor --config --json" is a forgotten path. Treating "--json" as the
    // credentials file would report a missing credential rather than the typo.
    expect(readFlagValue(['--config', '--json'], '--config')).toBeNull()
  })

  it('reads only the first occurrence, so a repeated flag is not ambiguous', () => {
    expect(readFlagValue(['--config', 'first.json', '--config', 'second.json'], '--config')).toBe('first.json')
  })
})

describe('checkFlags', () => {
  it('accepts every option a subcommand declares, with its value', () => {
    expect(checkFlags(['--json', '--quick', '--config', '/tmp/credentials.json'], DOCTOR_FLAGS, 'homey-mcp doctor')).toBeNull()
    expect(checkFlags(['--log-level', 'debug'], SERVE_FLAGS, 'homey-mcp serve')).toBeNull()
    expect(checkFlags(['-y'], SETUP_FLAGS, 'homey-mcp setup')).toBeNull()
    expect(checkFlags([], DOCTOR_FLAGS, 'homey-mcp doctor')).toBeNull()
  })

  it('refuses a misspelled --report and names the flag that was meant', () => {
    // The regression, and the reason this check exists. "doctor --repot" ran the
    // full terminal report, which carries LAN addresses, the Athom cloud id and
    // filesystem paths, at the moment the user believed they had asked for the
    // scrubbed one they were about to paste into a public issue.
    const problem = checkFlags(['--repot'], DOCTOR_FLAGS, 'homey-mcp doctor')

    expect(problem).not.toBeNull()
    expect(problem).toContain('"--repot" is not an option of "homey-mcp doctor"')
    expect(problem).toContain('Did you mean "--report"?')
  })

  it('lists the options that do exist, so the message is the whole answer', () => {
    const problem = checkFlags(['--verbose'], DOCTOR_FLAGS, 'homey-mcp doctor') ?? ''

    for (const spec of DOCTOR_FLAGS) expect(problem).toContain(spec.name)
    expect(problem).toContain('a scrubbed version to paste into a bug report')
  })

  it('offers no suggestion when nothing is close', () => {
    const problem = checkFlags(['--tail-the-logs-forever'], DOCTOR_FLAGS, 'homey-mcp doctor') ?? ''
    expect(problem).not.toContain('Did you mean')
  })

  it('refuses a flag that belongs to a different subcommand', () => {
    // Every subcommand has its own table: --report on serve is as wrong as
    // --report on a command that has no options at all.
    expect(checkFlags(['--report'], SERVE_FLAGS, 'homey-mcp serve')).toContain('is not an option')
    expect(checkFlags(['--log-level', 'debug'], DOCTOR_FLAGS, 'homey-mcp doctor')).toContain('is not an option')
  })

  it('refuses a value-taking flag with nothing usable after it', () => {
    const problem = checkFlags(['--config', '--json'], DOCTOR_FLAGS, 'homey-mcp doctor') ?? ''
    expect(problem).toContain('"--config" needs a path after it')
  })

  it('explains the joined form rather than dropping the value it carries', () => {
    // "--config=/tmp/credentials.json" used to be ignored whole, so the run went
    // ahead against the default credentials as if no path had been given.
    const problem = checkFlags(['--config=/tmp/credentials.json'], DOCTOR_FLAGS, 'homey-mcp doctor') ?? ''

    expect(problem).toContain('with a space')
    expect(problem).toContain('homey-mcp doctor --config /tmp/credentials.json')
  })

  it('does not read a flag value as an unexpected argument', () => {
    expect(checkFlags(['--config', 'report', '--json'], DOCTOR_FLAGS, 'homey-mcp doctor')).toBeNull()
  })

  it('refuses a bare word, which is a subcommand nobody has', () => {
    expect(checkFlags(['json'], DOCTOR_FLAGS, 'homey-mcp doctor')).toContain('"json" is not something')
  })

  it('accepts --help everywhere, because asking for help must never run the command', () => {
    for (const specs of [SERVE_FLAGS, SETUP_FLAGS, DOCTOR_FLAGS]) {
      expect(checkFlags(['--help'], specs, 'homey-mcp')).toBeNull()
      expect(checkFlags(['-h'], specs, 'homey-mcp')).toBeNull()
    }
  })

  it('shows the value placeholder for the options that take one', () => {
    const specs: FlagSpec[] = [{ name: '--config', takesValue: true, valueName: 'path', description: 'a file' }]
    expect(checkFlags(['--wrong'], specs, 'homey-mcp') ?? '').toContain('--config <path>')
  })
})
