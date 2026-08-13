// The wire rule that must not drift.
//
// `homey-api` splits a fully qualified identifier with `id.split(':', 3)`, and
// three separate modules here need the same split: flow card ids, Insights log
// ids, and the `driverId` the library folds the driver uri into. Three copies
// existed, they agreed on the happy path, and they disagreed on the degenerate
// one. These tests pin the rule to the library's answer and pin the callers to
// the one implementation of it, because a second copy passes on the day it is
// written and drifts on the day the first one is corrected.

import { describe, expect, it } from 'vitest'

import { createHomeCache } from './cache.js'
import { splitCanonicalCardId, toCanonicalCardId } from './types.js'
import type { HomeyConnection } from './types.js'
import { createLogger } from '../util/log.js'

/** The library's own rule, written out so the assertions compare against it rather than against a copy of the code. */
function libraryOwnerUri(identifier: string): string {
  return identifier.split(':', 3).join(':')
}

const DEVICE_ID = 'aaaaaaaa-0001-4000-8000-000000000001'

function connectionServing(devices: Record<string, unknown>): HomeyConnection {
  return {
    api: {
      devices: { getDevices: async () => devices },
      zones: { getZones: async () => ({}) },
      flow: {
        getFlows: async () => ({}),
        getAdvancedFlows: async () => ({}),
        getFlowFolders: async () => ({}),
        getFlowCardTriggers: async () => [],
        getFlowCardConditions: async () => [],
        getFlowCardActions: async () => [],
      },
      insights: { getLogs: async () => ({}) },
      logic: { getVariables: async () => ({}) },
    },
    dialect: 'v2',
    identity: {
      id: 'homey-under-test',
      name: 'Test Home',
      modelId: 'homey4d',
      modelName: 'Homey Pro (Early 2019)',
      softwareVersion: '13.2.4',
      platformVersion: 1,
      language: 'en',
      timezone: 'Europe/Amsterdam',
      address: 'https://homey.example.invalid',
      addressKind: 'local',
    },
    queue: { run: async (operation) => operation(), inFlight: 0, queued: 0 },
    request: async (operation) => operation(),
  }
}

describe('splitCanonicalCardId', () => {
  it('splits an owner off exactly where the client library does', () => {
    for (const identifier of [
      `homey:device:${DEVICE_ID}:alarm_contact_true`,
      'homey:manager:notifications:create_notification',
      // A short id carrying colons of its own, which is where a split at the
      // last colon would part company with the library.
      'homey:app:com.example:one:two:three',
    ]) {
      const { ownerUri, shortId } = splitCanonicalCardId(identifier)
      expect(ownerUri).toBe(libraryOwnerUri(identifier))
      expect(toCanonicalCardId(ownerUri, shortId)).toBe(identifier)
    }
  })

  it('answers a degenerate identifier the way the library does, rather than inventing a second answer', () => {
    // Too few segments to carry a short id. The library's split returns the
    // whole string, so this does too: one of the three copies used to return an
    // empty string here, and that disagreement is the whole reason the rule now
    // lives in one place.
    for (const identifier of ['homey:device', 'homey:manager:cron', 'not-an-identifier', '']) {
      expect(splitCanonicalCardId(identifier)).toEqual({ ownerUri: libraryOwnerUri(identifier), shortId: '' })
    }
  })
})

describe('the driver identity in the cache', () => {
  it('takes the owner half through the shared split rather than a copy of it', async () => {
    // `Device.transformGet` folds the driver uri into `driverId` and deletes it,
    // so the owner half has to be split back out. A degenerate identifier is
    // what told the two implementations apart: the shared rule answers with the
    // whole string, the copy that used to live in the cache answered with an
    // empty one.
    const identifier = 'com.example.sensors'
    const cache = createHomeCache(connectionServing({ [DEVICE_ID]: { id: DEVICE_ID, name: 'Hall sensor', driverId: identifier } }), {
      logger: createLogger({ level: 'silent' }),
    })

    const device = (await cache.getDevices()).byId.get(DEVICE_ID)

    expect(device?.driverUri).toBe(splitCanonicalCardId(identifier).ownerUri)
    expect(device?.driverUri).toBe(libraryOwnerUri(identifier))
  })
})
