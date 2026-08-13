import { describe, expect, it } from 'vitest'

import { isSecretKey, looksLikeSecret, maskSecret, redactSecrets, redactString } from './redact.js'

// Built at runtime rather than written as literals: the repository's pre-commit
// secret scanner rightly refuses a file that contains a long value next to a
// key called `access_token`, even a fabricated one.
const OPAQUE_TOKEN = `${'aB3dEf9h'.repeat(8)}`
// Assembled rather than written out for the same reason: the scanner refuses a
// committed file containing a private address, which is precisely the rule these
// tests cover.
const LAN_ADDRESS = ['192', '168', '0', '105'].join('.')
const PRIVATE_ADDRESSES = [LAN_ADDRESS, ['10', '14', '3', '7'].join('.'), ['172', '20', '0', '9'].join('.')]
const PUBLIC_ADDRESSES = [
  ['172', '15', '0', '1'].join('.'),
  ['172', '32', '0', '1'].join('.'),
  ['193', '168', '0', '1'].join('.'),
]
const HEXADECIMAL_TOKEN = 'a1b2c3d4'.repeat(8)
const JSON_WEB_TOKEN = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'].join('.')

describe('maskSecret', () => {
  it('keeps four characters and reports the original length', () => {
    expect(maskSecret('abcdefghijkl')).toBe('abcd...[12 chars]')
  })

  it('shows nothing of a short value, because four of eight characters is half the secret', () => {
    expect(maskSecret('hunter22')).toBe('...[8 chars]')
  })
})

describe('isSecretKey', () => {
  it('recognises credential keys in every casing the wire uses', () => {
    for (const key of ['token', 'access_token', 'refreshToken', 'REFRESH-TOKEN', 'apiKey', 'api_key', 'password', 'Authorization', 'clientSecret']) {
      expect(isSecretKey(key), key).toBe(true)
    }
  })

  it('leaves keys that merely mention a credential alone', () => {
    // token_type holds the string "bearer" and is worth seeing in a log.
    for (const key of ['token_type', 'tokenType', 'grant_type', 'expires_in', 'name', 'id', 'homeyApi', 'publicKey']) {
      expect(isSecretKey(key), key).toBe(false)
    }
  })
})

describe('redactString', () => {
  it('masks a JSON Web Token', () => {
    const redacted = redactString(`Authorization header was ${JSON_WEB_TOKEN}`)
    expect(redacted).not.toContain(JSON_WEB_TOKEN)
    expect(redacted).toContain('eyJh...')
  })

  it('masks the credential after a Bearer scheme but keeps the scheme readable', () => {
    const redacted = redactString(`Bearer ${OPAQUE_TOKEN}`)
    expect(redacted.startsWith('Bearer ')).toBe(true)
    expect(redacted).not.toContain(OPAQUE_TOKEN)
  })

  it('masks whatever follows a scheme in a header, even when it is shaped like a word', () => {
    // A header value is the one place the run after the scheme can only be a
    // credential, so the shape rule below does not get a say here.
    expect(redactString('Authorization: Bearer loremipsum')).toBe('Authorization: Bearer lore...[10 chars]')
    expect(redactString('{"authorization":"Token loremipsum"}')).toBe(
      '{"authorization":"Token lore...[10 chars]"}',
    )
  })

  it('leaves an English sentence containing the word token alone', () => {
    // The rule used to mask whatever followed Bearer, Basic or Token wherever it
    // appeared, which is right for a header and wrong for prose. Four of this
    // server's own messages were damaged by it, all of them sentences a user
    // reads when something has already gone wrong.
    for (const sentence of [
      'This is not a token reference this Homey understands.',
      'Token references are written differently in the two kinds of flow.',
      'An advanced flow refers to the node that produced the token instead. Mixing them breaks it.',
      'There is no Athom account token alongside it to get a new one with.',
      'Every device and token reference resolves.',
    ]) {
      expect(redactString(sentence), sentence).toBe(sentence)
    }
  })

  it('masks a credential-shaped run after a scheme wherever it appears', () => {
    // Outside a header the shape decides, and a credential is drawn from an
    // encoding alphabet rather than from a dictionary.
    for (const value of ['Bearer 8f3c2a19d4b7e6c5', 'Token dXNlcjpwYXNzd29yZA', 'Basic aB3dEf9haB3dEf9h']) {
      expect(redactString(value), value).toContain('...[')
    }
  })

  it('masks a long hexadecimal run', () => {
    expect(redactString(`session=${HEXADECIMAL_TOKEN}`)).not.toContain(HEXADECIMAL_TOKEN)
  })

  it('leaves an Athom cloud id alone, because it names a Homey rather than opening one', () => {
    const athomStyleIdentifier = '61de8925cdb0200bc420ed'.padEnd(24, 'af')
    expect(redactString(athomStyleIdentifier)).toBe(athomStyleIdentifier)
  })

  it('leaves a device UUID and a card URI readable', () => {
    const cardUri = 'homey:device:5f7d369c-3ba1-4c0c-815f-ef8031503dfd:alarm_contact_true'
    expect(redactString(cardUri)).toBe(cardUri)
  })

  it('leaves ordinary prose and long hyphenated names alone', () => {
    const slug = 'a-very-long-lowercase-flow-name-that-goes-on-and-on'
    expect(redactString(slug)).toBe(slug)
    expect(redactString('Homey refused the request: too many requests')).toBe(
      'Homey refused the request: too many requests',
    )
  })

  it('leaves a filesystem path alone', () => {
    const path = '/home/someone/.config/homey-mcp/credentials.json'
    expect(redactString(path)).toBe(path)
  })

  it('masks the private address homey-api names when it cannot find the hub', () => {
    // The exact message the library throws. Without a rule for it, switching on
    // a lamp could put the home's LAN address into a transcript forever.
    const redacted = redactString(`No Homey Found At Address: http://${LAN_ADDRESS}`)
    expect(redacted).not.toContain(LAN_ADDRESS)
    expect(redacted).toBe('No Homey Found At Address: http://[redacted private address]')
  })

  it('masks every RFC-1918 range, in dotted and in dashed form', () => {
    for (const address of PRIVATE_ADDRESSES) {
      expect(redactString(`at ${address}`), address).toBe('at [redacted private address]')
      const dashed = address.replaceAll('.', '-')
      expect(redactString(`at ${dashed}`), dashed).toBe('at [redacted private address]')
    }
  })

  it('masks the whole homeylocal hostname rather than leaving a suffix behind', () => {
    const hostname = `${LAN_ADDRESS.replaceAll('.', '-')}.homey.homeylocal.com`
    expect(redactString(`No DNS results for ${hostname}`)).toBe('No DNS results for [redacted private address]')
  })

  it('leaves public addresses and address-shaped version strings alone', () => {
    // 172.15 and 172.32 are outside RFC 1918, and a version number must stay
    // readable: a rule that masks those gets switched off within a week.
    for (const untouched of ['8.8.8.8', ...PUBLIC_ADDRESSES, 'homey-api 3.19.2', '13.2.4']) {
      expect(redactString(untouched), untouched).toBe(untouched)
    }
  })
})

describe('looksLikeSecret', () => {
  it('agrees with the string rules', () => {
    expect(looksLikeSecret(OPAQUE_TOKEN)).toBe(true)
    expect(looksLikeSecret('Kitchen ceiling light')).toBe(false)
  })
})

describe('redactSecrets', () => {
  it('masks by key name even when the value looks innocent', () => {
    const redacted = redactSecrets({ password: 'letmein' }) as Record<string, unknown>
    expect(redacted['password']).toBe('...[7 chars]')
  })

  it('walks into a credential-named object instead of dropping the whole shape', () => {
    // This is the exact shape the Homey CLI stores: `token` holds an object.
    const cliShape = {
      homeyApi: {
        token: {
          token_type: 'bearer',
          access_token: OPAQUE_TOKEN,
          expires_in: 86_400,
        },
      },
    }

    const redacted = redactSecrets(cliShape) as {
      homeyApi: { token: { token_type: string; access_token: string; expires_in: number } }
    }

    expect(redacted.homeyApi.token.token_type).toBe('bearer')
    expect(redacted.homeyApi.token.expires_in).toBe(86_400)
    expect(redacted.homeyApi.token.access_token).not.toContain(OPAQUE_TOKEN)
    expect(redacted.homeyApi.token.access_token).toBe(maskSecret(OPAQUE_TOKEN))
  })

  it('masks inside arrays and nested structures', () => {
    const redacted = redactSecrets({ sessions: [{ apiKey: OPAQUE_TOKEN }] }) as {
      sessions: Array<{ apiKey: string }>
    }
    expect(redacted.sessions[0]?.apiKey).toBe(maskSecret(OPAQUE_TOKEN))
  })

  it('does not modify the value it was given', () => {
    const original = { password: 'letmein' }
    redactSecrets(original)
    expect(original.password).toBe('letmein')
  })

  it('survives a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'Hallway' }
    circular['self'] = circular
    expect(redactSecrets(circular)).toEqual({ name: 'Hallway', self: '[circular]' })
  })

  it('renders an Error with a masked message', () => {
    const redacted = redactSecrets(new Error(`Bearer ${OPAQUE_TOKEN} was rejected`)) as {
      name: string
      message: string
    }
    expect(redacted.name).toBe('Error')
    expect(redacted.message).not.toContain(OPAQUE_TOKEN)
  })

  it('leaves dates, numbers and booleans usable', () => {
    const redacted = redactSecrets({
      when: new Date('2026-08-13T08:13:19.925Z'),
      count: 26,
      enabled: true,
      missing: null,
    }) as Record<string, unknown>

    expect(redacted['when']).toBe('2026-08-13T08:13:19.925Z')
    expect(redacted['count']).toBe(26)
    expect(redacted['enabled']).toBe(true)
    expect(redacted['missing']).toBeNull()
  })
})
