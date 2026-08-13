import { describe, expect, it } from 'vitest'

import { readFlagValue } from './flags.js'

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
