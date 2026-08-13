// Masking of credentials and of the home's network location before anything is
// written to a log line, an error message or an MCP tool result.
//
// The stakes are asymmetric. A masked value that did not need masking costs a
// reader some context in a log file. An unmasked Athom session token that
// reaches a model ends up in conversation history permanently, and that history
// is copied, summarised and stored well outside this process. So every rule
// below errs towards masking.
//
// The same argument covers where the house is on the network. `homey-api`
// reports failures like `No Homey Found At Address: http://<lan ip>` and `No DNS
// results for <dashed ip>.homey.homeylocal.com`, and those messages travel into
// a tool result verbatim. Switching on a lamp must not be the reason a private
// address is preserved in a transcript forever.

/**
 * Words that, when they end a key name, mean the value is a credential.
 *
 * Matched against the key after camelCase has been split into words, so
 * `refreshToken`, `refresh_token` and `REFRESH-TOKEN` all resolve to the same
 * terminal word. `token_type` deliberately does not match: its terminal word is
 * `type` and its value is the harmless string `bearer`.
 */
const SECRET_KEY_TERMINALS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'pat',
  'jwt',
  'apikey',
  'sessionid',
])

/**
 * Full normalised key names that are credentials even though their terminal
 * word alone would be too generic to match on. `key` on its own is a very
 * common innocent field name, so it only counts when qualified.
 */
const SECRET_KEY_SUFFIXES = ['api_key', 'access_key', 'private_key', 'secret_key', 'client_secret']

/** A JSON Web Token: three base64url segments, the first one starting `eyJ`. */
const JSON_WEB_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g

/** `Authorization: Bearer <credential>` and its Basic/Token siblings. */
const AUTHORIZATION_SCHEME_PATTERN = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi

/**
 * A long hexadecimal run. 32 is the threshold because Athom cloud identifiers
 * are 24 hex characters and are not secret: they name a Homey, they do not open
 * one, and masking them would make every log line useless for support.
 */
const HEXADECIMAL_RUN_PATTERN = /\b[0-9a-fA-F]{32,}\b/g

/** Classic base64 with no separators, so a file path can never match. */
const BASE64_RUN_PATTERN = /[A-Za-z0-9+/=]{40,}/g

/**
 * base64url, which shares its alphabet with hyphenated slugs and long file
 * names. Mixed case plus a digit is what separates a credential from
 * `a-very-long-lowercase-slug-like-this-one`.
 */
const BASE64URL_RUN_PATTERN = /[A-Za-z0-9_-]{40,}/g

/**
 * Where the home is on the network. The three patterns below are the same rules
 * `scripts/check-secrets.mjs` enforces on the repository, as `private-ipv4` and
 * `dashed-private-ipv4`: one guards what gets committed, this one guards what
 * gets said. Change one and change the other.
 *
 * The dashed form here also covers the 172.16/12 block, which the scanner's
 * dashed rule does not. That is a deliberate widening rather than drift: a hub
 * on a 172.16-31 network announces itself under exactly that name.
 */
const PRIVATE_IPV4_PATTERN =
  /\b(?:192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/g

const DASHED_PRIVATE_IPV4_PATTERN =
  /\b(?:192-168-\d{1,3}|10-\d{1,3}-\d{1,3}|172-(?:1[6-9]|2\d|3[01])-\d{1,3})-\d{1,3}\b/g

/**
 * The hub's TLS LAN hostname, for example `<dashed lan ip>.homey.homeylocal.com`.
 *
 * Matched before the dashed address rule so the whole name is replaced once
 * rather than leaving a suffix hanging off a placeholder. The bare
 * `homeylocal.com` domain is public and stays readable.
 */
const HOMEY_LOCAL_HOSTNAME_PATTERN = /\b[A-Za-z0-9-]+\.homey\.homeylocal\.com\b/gi

/**
 * What a private address is replaced with. Not `maskSecret`, which keeps the
 * first four characters: `192.` alone already names the subnet, and the length
 * of an address is not worth diagnosing.
 */
const PRIVATE_ADDRESS_PLACEHOLDER = '[redacted private address]'

const CONTAINS_DIGIT = /[0-9]/
const CONTAINS_LETTER = /[A-Za-z]/
const CONTAINS_UPPERCASE = /[A-Z]/
const CONTAINS_LOWERCASE = /[a-z]/

/** Bounds the work done on a deeply nested or self-referential structure. */
const MAXIMUM_DEPTH = 8

/**
 * Replaces a credential with a shape a human can still recognise: enough of the
 * start to tell two tokens apart in a log, plus the original length so a
 * truncation bug is still diagnosable.
 *
 * Short values get no prefix at all, because four characters of an eight
 * character password is not a hint, it is half the password.
 */
export function maskSecret(value: string): string {
  const prefix = value.length > 8 ? value.slice(0, 4) : ''
  return `${prefix}...[${value.length} chars]`
}

/** True when a key name says its value is a credential, whatever the value looks like. */
export function isSecretKey(key: string): boolean {
  const normalisedKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase()

  if (SECRET_KEY_SUFFIXES.some((suffix) => normalisedKey.endsWith(suffix))) return true

  const words = normalisedKey.split('_').filter(Boolean)
  const terminalWord = words[words.length - 1]
  return terminalWord !== undefined && SECRET_KEY_TERMINALS.has(terminalWord)
}

/**
 * True when a string on its own carries something that must not leave the
 * machine: a credential, or the home's address on the network.
 */
export function looksLikeSecret(value: string): boolean {
  return redactString(value) !== value
}

/** Masks every credential-shaped run inside a single string, leaving the rest readable. */
export function redactString(value: string): string {
  // Network location first, and the hostname before the address it contains.
  let output = value.replace(HOMEY_LOCAL_HOSTNAME_PATTERN, PRIVATE_ADDRESS_PLACEHOLDER)
  output = output.replace(PRIVATE_IPV4_PATTERN, PRIVATE_ADDRESS_PLACEHOLDER)
  output = output.replace(DASHED_PRIVATE_IPV4_PATTERN, PRIVATE_ADDRESS_PLACEHOLDER)

  output = output.replace(JSON_WEB_TOKEN_PATTERN, (match) => maskSecret(match))

  output = output.replace(
    AUTHORIZATION_SCHEME_PATTERN,
    (_match, scheme: string, spacing: string, credential: string) =>
      `${scheme}${spacing}${maskSecret(credential)}`,
  )

  output = output.replace(HEXADECIMAL_RUN_PATTERN, (match) => maskSecret(match))

  output = output.replace(BASE64_RUN_PATTERN, (match) =>
    CONTAINS_DIGIT.test(match) && CONTAINS_LETTER.test(match) ? maskSecret(match) : match,
  )

  output = output.replace(BASE64URL_RUN_PATTERN, (match) =>
    CONTAINS_DIGIT.test(match) && CONTAINS_UPPERCASE.test(match) && CONTAINS_LOWERCASE.test(match)
      ? maskSecret(match)
      : match,
  )

  return output
}

/**
 * Walks any value and masks everything that is, or looks like, a credential.
 *
 * Applied to every log line and to every error that can reach a model. The
 * returned structure is a copy: the caller's object is never modified, because
 * the same object is usually about to be used for something real.
 */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>())
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)

  if (value === null || typeof value !== 'object') {
    // bigint has no JSON representation, so it would break a later stringify.
    return typeof value === 'bigint' ? `${value.toString()}n` : value
  }

  if (depth >= MAXIMUM_DEPTH) return '[redaction depth limit reached]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp) return value.toString()

  if (value instanceof Error) {
    const redactedError: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    }
    // Preserve the reason and details a HomeyMcpError carries, since those are
    // exactly what a support conversation needs.
    for (const [key, propertyValue] of Object.entries(value)) {
      redactedError[key] = redactEntry(key, propertyValue, depth + 1, seen)
    }
    return redactedError
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1, seen))
  }

  if (value instanceof Map) {
    const redactedMap: Record<string, unknown> = {}
    for (const [key, entryValue] of value.entries()) {
      const keyAsString = String(key)
      redactedMap[keyAsString] = redactEntry(keyAsString, entryValue, depth + 1, seen)
    }
    return redactedMap
  }

  if (value instanceof Set) {
    return [...value.values()].map((entry) => redactValue(entry, depth + 1, seen))
  }

  const redactedObject: Record<string, unknown> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    redactedObject[key] = redactEntry(key, entryValue, depth + 1, seen)
  }
  return redactedObject
}

function redactEntry(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (!isSecretKey(key)) return redactValue(value, depth, seen)

  // A secret-named key holding a string is masked whole, however short it is.
  if (typeof value === 'string') return maskSecret(value)

  // A secret-named key can also hold a container, as it does in the Homey CLI's
  // session file where `token` is an object of token fields. Keep walking so the
  // fields inside are masked individually rather than losing the whole shape.
  if (value !== null && typeof value === 'object') return redactValue(value, depth, seen)

  return value
}
