#!/usr/bin/env node
// Captures a read-only snapshot of YOUR Homey into a local directory, for
// development and bug reports. Nothing here writes to the Homey.
//
// The output is gitignored on purpose and must never be committed. See
// CONTRIBUTING.md for why, and for how to pseudonymise a capture you want to
// attach to an issue.
//
// Requires the official Homey CLI, which handles the login and the session:
//   npm i -g homey && homey login && homey select
//
// Usage: node scripts/capture-fixtures.mjs [outputDirectory]

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outputDirectory = process.argv[2] ?? 'tests/fixtures/raw'

const ENDPOINTS = [
  ['system-info', '/api/manager/system/'],
  ['system-memory', '/api/manager/system/memory'],
  ['system-storage', '/api/manager/system/storage'],
  ['session-me', '/api/manager/sessions/session/me'],
  ['zones', '/api/manager/zones/zone'],
  ['devices', '/api/manager/devices/device'],
  ['apps', '/api/manager/apps/app'],
  ['logic-variables', '/api/manager/logic/variable'],
  ['flows', '/api/manager/flow/flow'],
  ['advancedflows', '/api/manager/flow/advancedflow'],
  ['flow-folders', '/api/manager/flow/flowfolder'],
  ['cardtriggers', '/api/manager/flow/flowcardtrigger'],
  ['cardconditions', '/api/manager/flow/flowcardcondition'],
  ['cardactions', '/api/manager/flow/flowcardaction'],
  ['insights-logs', '/api/manager/insights/log'],
  ['energy-live', '/api/manager/energy/live'],
]

// The Homey rate limits its own local API: a handful of back-to-back requests
// returns "Too many requests". Space them out rather than racing it.
const SPACING_MILLISECONDS = 400

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function fetchPath(path) {
  const stdout = execFileSync('homey', ['api', 'raw', '--path', path], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const firstBrace = stdout.search(/[[{]/)
  if (firstBrace === -1) throw new Error(`unexpected response for ${path}`)
  return JSON.parse(stdout.slice(firstBrace))
}

mkdirSync(outputDirectory, { recursive: true })

let captured = 0
for (const [name, path] of ENDPOINTS) {
  try {
    const payload = fetchPath(path)
    writeFileSync(join(outputDirectory, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`)
    const size = Array.isArray(payload) ? payload.length : Object.keys(payload).length
    console.error(`captured ${name} (${size} entries)`)
    captured += 1
  } catch (error) {
    const detail = [(error.stdout ?? '').toString(), (error.stderr ?? '').toString(), error.message]
      .join(' ')
      .replace(/\[\d+m/g, '')
      .trim()
      .slice(0, 160)
    console.error(`skipped  ${name}: ${detail}`)
  }
  await delay(SPACING_MILLISECONDS)
}

console.error(`\nCaptured ${captured}/${ENDPOINTS.length} endpoints into ${outputDirectory}`)
console.error('This directory is gitignored. Do not commit it.')
