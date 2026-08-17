import { describe, expect, it } from 'vitest'

import type { FlagSpec } from './flags.js'
import { checkFlags, DOCTOR_FLAGS, readFlagValue, SERVE_FLAGS, SERVICE_FLAGS, SETUP_FLAGS } from './flags.js'

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

describe('the HTTP mode flags', () => {
  it('accepts --http and --port on the subcommands that offer them', () => {
    expect(checkFlags(['--http'], SERVE_FLAGS, 'homey-mcp serve')).toBeNull()
    expect(checkFlags(['--http', '--port', '8431'], SERVE_FLAGS, 'homey-mcp serve')).toBeNull()
    expect(checkFlags(['--http'], SETUP_FLAGS, 'homey-mcp setup')).toBeNull()
    expect(checkFlags(['--http'], DOCTOR_FLAGS, 'homey-mcp doctor')).toBeNull()
    expect(checkFlags(['--port', '9001', '--yes'], SERVICE_FLAGS, 'homey-mcp service install')).toBeNull()
  })

  it('refuses a --port that is not a number', () => {
    // readFlagValue only guarantees a token that does not start with a dash, so
    // without this "--port eight" becomes NaN and the server binds nothing while
    // reporting no problem at all.
    const problem = checkFlags(['--port', 'eight'], SERVE_FLAGS, 'homey-mcp serve') ?? ''

    expect(problem).toContain('needs a whole number')
    expect(problem).toContain('"eight"')
  })

  it('refuses --port 0, which binds a random port while advertising port 0', () => {
    // Measured: "serve --http --port 0" logged "Listening on
    // http://127.0.0.1:0/mcp" while the kernel had bound 45149. Every URL it
    // advertised, every token audience and the client entry all named port 0, so
    // the assistant could never connect. Written into a service unit with
    // Restart=always it picks a different random port on every boot.
    const problem = checkFlags(['--port', '0'], SERVE_FLAGS, 'homey-mcp serve') ?? ''

    expect(problem).toContain('outside the range 1 to 65535')
    expect(problem).toContain('any free port')
  })

  it('refuses a --port above the highest port there is', () => {
    // Without the range this reached "new URL" and died with the bare line
    // "Invalid URL", which names neither the flag nor the value.
    const problem = checkFlags(['--port', '70000'], SERVE_FLAGS, 'homey-mcp serve') ?? ''

    expect(problem).toContain('outside the range 1 to 65535')
  })

  it('applies the range to every subcommand that takes a port', () => {
    for (const [specs, commandName] of [
      [SERVE_FLAGS, 'homey-mcp serve'],
      [SETUP_FLAGS, 'homey-mcp setup'],
      [SERVICE_FLAGS, 'homey-mcp service install'],
      [DOCTOR_FLAGS, 'homey-mcp doctor'],
    ] as const) {
      expect(checkFlags(['--port', '0'], specs, commandName)).toContain('outside the range')
      expect(checkFlags(['--port', '8432'], specs, commandName)).toBeNull()
    }
  })

  it('offers --port to doctor, so it can be aimed at a server on another port', () => {
    // Without it "doctor --http --port 8531" was refused outright and
    // "doctor --http" reported nothing listening on 8431 about a healthy server,
    // then told the user to install a second service.
    expect(checkFlags(['--http', '--port', '8531'], DOCTOR_FLAGS, 'homey-mcp doctor')).toBeNull()
  })

  it('still refuses --port with nothing after it', () => {
    expect(checkFlags(['--port'], SERVE_FLAGS, 'homey-mcp serve')).toContain('needs a number after it')
  })

  it('does not offer --http to a subcommand that has no HTTP mode', () => {
    expect(checkFlags(['--http'], SERVICE_FLAGS, 'homey-mcp service install')).toContain('is not an option')
  })
})
