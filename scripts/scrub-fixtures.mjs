#!/usr/bin/env node
// Turns raw captures from a real Homey into fixtures that are safe to commit to
// a public repository.
//
// A raw capture carries a household's private layout: device and room names,
// LAN IP addresses, the Homey cloud id, Athom user ids, avatar URLs and the
// names of the people living there. None of that may be published, but the
// SHAPE of the data is exactly what the tests need.
//
// Key-based redaction alone is not enough, and a first attempt proved it: a room
// name reappears inside a flow card's rendered title, and a household member's
// front door shows up in the free text of a notification action. So this works
// in two passes.
//
//   Pass 1 harvests every personal proper noun from the raw capture: zone names,
//          device names, flow names, logic variable names, user names.
//   Pass 2 rewrites those terms wherever they appear in ANY string, alongside
//          regex rules for ids, addresses and e-mail.
//
// Identity mapping is deterministic, so the same input id always maps to the
// same fake id and cross-references between fixtures stay intact: a flow still
// points at a device that exists in the device fixture.
//
// Usage: node scripts/scrub-fixtures.mjs <rawDirectory> <outputDirectory>

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [, , rawDirectory, outputDirectory] = process.argv

if (!rawDirectory || !outputDirectory) {
  console.error('Usage: node scripts/scrub-fixtures.mjs <rawDirectory> <outputDirectory>')
  process.exit(1)
}

// Captures that must never be published at all. The API schema is Athom's own
// specification document rather than our data, and it is large; keep it local.
const EXCLUDED_FILES = new Set(['homey-schema.json'])

// Big collections get subsampled: the tests need variety of shape, not a full
// copy of one household. Value is how many entries to keep.
const SUBSAMPLE = new Map([
  ['live-cardtriggers.json', 40],
  ['live-cardconditions.json', 30],
  ['live-cardactions.json', 40],
  ['live-devices.json', 8],
  ['insights-logs.json', 30],
])

// Keys that are pure secrets or direct locators. Dropped outright.
const DROP_KEYS = new Set([
  'token', 'accessToken', 'refreshToken', 'sessionToken', 'apiKey', 'password',
  'secret', 'authorization', 'cookie', 'email', 'avatar', 'image', 'athomId',
  'bootId', 'cloudId', 'macAddress', 'wifiSsid', 'wifiPassword', 'address',
  'localUrl', 'localUrlSecure', 'remoteUrl', 'host', 'ip', 'ipAddress',
  'latitude', 'longitude', 'ssid', 'hostname',
])

// Keys whose values name something in the household. Harvested in pass 1.
const PERSONAL_NAME_KEYS = ['name', 'zoneName', 'firstname', 'lastname', 'fullname']

const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const HEX24_PATTERN = /\b[0-9a-f]{24}\b/g
const HEX32_PATTERN = /\b[0-9a-f]{32}\b/g
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const DASHED_IP_PATTERN = /\b(?:\d{1,3}-){3}\d{1,3}\b/g
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g

const identifierMap = new Map()
const personalTerms = new Map()

function stableHash(value, length) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

function fakeUuid(original) {
  if (!identifierMap.has(original)) {
    const digest = stableHash(original, 32)
    // Stay a syntactically valid v4 UUID: the firmware validates the version and
    // variant nibbles on advanced-flow node keys, so fixtures must too.
    identifierMap.set(original, [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `8${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join('-'))
  }
  return identifierMap.get(original)
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- Pass 1: harvest -------------------------------------------------------

function harvest(value, key) {
  if (Array.isArray(value)) {
    for (const entry of value) harvest(entry, key)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) harvest(childValue, childKey)
    return
  }
  if (typeof value !== 'string') return
  if (!PERSONAL_NAME_KEYS.includes(key)) return

  // Single very short tokens produce catastrophic false positives ("TV" inside
  // "TVOC"). Require something substantial, then also split multi-word names so
  // "Voordeur sensor" also masks a bare "Voordeur".
  for (const token of [value, ...value.split(/[\s/|,()-]+/)]) {
    const trimmed = token.trim()
    if (trimmed.length < 4) continue
    if (/^\d+$/.test(trimmed)) continue
    if (!personalTerms.has(trimmed.toLowerCase())) {
      personalTerms.set(trimmed.toLowerCase(), `Sample${stableHash(trimmed.toLowerCase(), 4)}`)
    }
  }
}

// --- Pass 2: rewrite -------------------------------------------------------

let personalTermPattern = null

function scrubString(value) {
  let output = value
    .replace(UUID_PATTERN, (match) => fakeUuid(match))
    .replace(HEX32_PATTERN, (match) => stableHash(match, 32))
    .replace(HEX24_PATTERN, (match) => stableHash(match, 24))
    .replace(IPV4_PATTERN, '203.0.113.10')
    .replace(DASHED_IP_PATTERN, '203-0-113-10')
    .replace(EMAIL_PATTERN, 'sample@example.invalid')

  if (personalTermPattern) {
    output = output.replace(personalTermPattern, (match) => personalTerms.get(match.toLowerCase()) ?? match)
  }
  return output
}

function scrub(value) {
  if (Array.isArray(value)) return value.map((entry) => scrub(entry))

  if (value && typeof value === 'object') {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      if (DROP_KEYS.has(childKey)) continue
      output[scrubString(childKey)] = scrub(childValue)
    }
    return output
  }

  if (typeof value === 'string') return scrubString(value)
  return value
}

function subsample(parsed, keep) {
  if (Array.isArray(parsed)) return parsed.slice(0, keep)
  if (parsed && typeof parsed === 'object') {
    return Object.fromEntries(Object.entries(parsed).slice(0, keep))
  }
  return parsed
}

// --- Run -------------------------------------------------------------------

const files = readdirSync(rawDirectory)
  .filter((file) => file.endsWith('.json'))
  .filter((file) => !EXCLUDED_FILES.has(file))

const parsedByFile = new Map()
for (const file of files) {
  const parsed = JSON.parse(readFileSync(join(rawDirectory, file), 'utf8'))
  parsedByFile.set(file, parsed)
  harvest(parsed, null)
}

if (personalTerms.size > 0) {
  const sortedTerms = [...personalTerms.keys()].sort((first, second) => second.length - first.length)
  personalTermPattern = new RegExp(sortedTerms.map(escapeForRegex).join('|'), 'gi')
}
console.error(`Harvested ${personalTerms.size} personal terms from ${files.length} captures`)

mkdirSync(outputDirectory, { recursive: true })

let written = 0
for (const [file, parsed] of parsedByFile) {
  const limited = SUBSAMPLE.has(file) ? subsample(parsed, SUBSAMPLE.get(file)) : parsed
  const serialised = JSON.stringify(scrub(limited), null, 2)

  // Belt and braces: refuse to write anything that still looks private. A silent
  // leak into a public repository cannot be taken back.
  const leaks = []
  if (/\b(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d/.test(serialised)) leaks.push('private IPv4')
  if (/[\w.+-]+@(?!example\.invalid)[\w.-]+\.\w{2,}/.test(serialised)) leaks.push('email address')
  if (leaks.length > 0) {
    console.error(`REFUSED ${file}: still contains ${leaks.join(', ')}`)
    process.exitCode = 1
    continue
  }

  writeFileSync(join(outputDirectory, basename(file)), `${serialised}\n`)
  written += 1
}

console.error(`Scrubbed ${written}/${files.length} fixtures into ${outputDirectory}`)
