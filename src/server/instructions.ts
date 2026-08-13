// The server instructions string.
//
// This text is handed to the model once, at the start of every session, so it is
// the only place to say things that would otherwise have to be repeated in
// fifteen tool descriptions. It is written for a reader who has never seen a
// Homey and does not know that flow cards come from installed apps, that a hub
// eight years old and a hub two years old expose different features, or that
// asking this particular hub for too much at once makes it stop answering.
//
// It is built per connection rather than written as a constant, because half of
// what matters is which hardware answered: telling a model that Advanced Flows
// are available when this hub does not have them produces a confident attempt at
// something that cannot work.
//
// Two rules govern every sentence here, because this is the first thing the
// model reads and an untruth misdirects the whole session.
//
// It must not promise what this server cannot do. Moods are the example that
// caught it out: the hub has them, so they were announced under "what this hub
// can do", while there is no mood tool and never was.
//
// And it must not turn "we could not tell" into "this hardware cannot". Those
// are different claims, and the second one says that retrying can never help. A
// capability probe fails for four different reasons, and the four are kept apart
// here for exactly that reason.

import type { CapabilityProbeStatus, CapabilityRegistry, HomeyDialect, HomeyIdentity } from '../homey/types.js'

export interface BuildServerInstructionsOptions {
  identity: HomeyIdentity
  /** Which API generation the hub answered as. Lives on the connection, not on the identity. */
  dialect: HomeyDialect
  capabilities: CapabilityRegistry
  /**
   * Whether the connected client can put a question to the user.
   *
   * Usually unknown here: instructions go out in the initialize response, and
   * the server object is built before any client has connected. Leaving it
   * undefined produces wording that is true either way, which is better than
   * asserting the wrong one.
   */
  askSupported?: boolean
}

/**
 * What is known about one capability.
 *
 * `unknown` is the honest answer when a registry carries no probe detail: a bare
 * false cannot be told apart from a probe that never completed.
 */
type CapabilityOutlook = CapabilityProbeStatus | 'unknown'

export function buildServerInstructions(options: BuildServerInstructionsOptions): string {
  const { identity, capabilities } = options

  const insights = capabilityOutlook(capabilities, 'insights', capabilities.hardware.insights)
  const advancedFlow = capabilityOutlook(capabilities, 'advancedFlow', capabilities.hardware.advancedFlow)
  const energyReports = capabilityOutlook(capabilities, 'energyReports', capabilities.hardware.energyReports)
  const moods = capabilityOutlook(capabilities, 'moods', capabilities.hardware.moods)
  // Weather has no `hardware` flag: nothing outside its own tool branches on it,
  // so `false` here only ever means "no probe was recorded", which
  // `capabilityOutlook` reports as unknown rather than as missing.
  const weather = capabilityOutlook(capabilities, 'weather', false)

  const sections: string[] = []

  sections.push(
    [
      `You are connected to a real Athom Homey Pro in someone's home: "${identity.name}", a ${identity.modelName} running firmware ${identity.softwareVersion}.`,
      `It answers on ${describeAddressKind(identity)} and speaks the ${options.dialect === 'v2' ? 'older (V2)' : 'newer (V3)'} Homey API.`,
      `Its timezone is ${identity.timezone}, and every calendar window in sensor history is cut in that zone rather than in yours.`,
      'Actions here switch real lights, open real locks and write real automations. Treat every write as something the user will live with.',
    ].join(' '),
  )

  sections.push(
    [
      'What this hub can do, probed when this server started rather than guessed from its version:',
      renderCapabilityLine('Sensor and energy history (Insights)', insights, 'the history tools cannot answer'),
      renderCapabilityLine(
        'Advanced Flows (the visual, multi-branch kind)',
        advancedFlow,
        'the advanced flow tools are not registered in this session, so build standard flows instead',
      ),
      renderCapabilityLine(
        'Historical energy reports',
        energyReports,
        describeEnergyFallback(insights),
      ),
      renderCapabilityLine(
        'Outdoor weather (the reading Homey itself uses for the home\'s location)',
        weather,
        'nothing here can say what it is like outside, so compare rooms against each other rather than against outdoors',
      ),
      renderMoodsLine(moods),
    ].join('\n'),
  )

  // `capabilities.notes` is deliberately not repeated here. Those notes are
  // written for the human reading `doctor`, and a failed probe's note embeds the
  // hub's own error message verbatim, which on a timeout ends in advice about
  // not repeating a write. That is nonsense next to a read-only GET probe, and
  // it arrived with a doubled full stop besides. Everything in a note that a
  // model needs is on the capability line above, and "homey_doctor" still
  // carries the raw notes for anyone diagnosing the hub.

  sections.push(
    [
      'How to work here:',
      // The tool returns counts and a class histogram, and names only the
      // devices it found unavailable. Promising "the devices in them and what
      // they can do" sent a model looking for a device list that is not there.
      '- Start from a read tool. "homey_home_overview" gives the zone tree with a device count per zone, how many devices of each class there are, the most common capabilities, which devices are currently unavailable, the installed apps, logic variables and flow counts, in one call. It counts rather than lists, so follow it with "homey_devices_search" or "homey_device_get" for the state of a particular device.',
      '- Refer to things by the id a tool gave you, and repeat the name back to the user. Never invent an id and never reuse one from an earlier conversation without looking it up again.',
      describeAmbiguityHandling(options.askSupported),
      '- This hub rate limits itself and starts refusing requests when several arrive together. Calls are queued and spaced automatically, so let a call finish rather than firing a batch, and treat a "temporary" failure as exactly that: wait a moment and repeat the same call.',
      '- Every list tool has a limit and reports when it truncated. A truncated list is not proof that something does not exist.',
    ].join('\n'),
  )

  sections.push(
    [
      'Building an automation, in the order that works:',
      '1. Find the devices involved with "homey_devices_search", so you are holding real ids.',
      '2. Search for cards with "homey_flowcards_search". Flow cards come from the apps installed on this particular Homey, so the catalogue is different on every hub and there are hundreds of them. Never assume a card exists because it exists elsewhere.',
      '3. Call "homey_flowcard_describe" on each card you intend to use, passing the card id as "cardId". That is what tells you its arguments, which of them are required, and which tokens it publishes for later cards to use.',
      // Two mistakes were being invited here. "Any argument the card marks as an
      // autocomplete" left out `device`-typed arguments, which need exactly the
      // same treatment and which homey_flow_validate rejects when they are sent
      // as a bare id. And the field that actually says what to do, `resolveWith`
      // on each argument, went unmentioned. The tool answers with
      // `choices: [{label, value}]`, so "the whole object it returns" named the
      // wrong thing: what goes into the card is the whole `value` of the chosen
      // entry, and a model that stored the choice wrapper instead would write a
      // card the app cannot render.
      //
      // "the same cardId" is spelled out because this is the step a caller
      // arrives at straight from homey_flowcard_describe, and the two tools once
      // named that value differently. Saying it carries over closes the seam in
      // the one place a model reads before either tool description.
      '4. Resolve every argument whose "resolveWith" is not null, which covers "autocomplete" and "device" arguments alike: a device argument needs the same treatment as an autocomplete one, and "homey_flow_validate" rejects a bare device id. Call "homey_flowcard_autocomplete" with the same "cardId" and the argument name, pick a choice, and store that choice\'s whole "value" object as the argument value, not just its id.',
      '5. Check the whole thing with "homey_flow_validate" before writing anything. It is a client-side check that costs nothing and catches the mistakes this firmware reports with misleading messages.',
      '6. Create it with "homey_flow_create". A new flow is created disabled and in a folder named "AI", so nothing starts running the house the moment it is written. Tell the user where to find it and that they must enable it themselves.',
    ].join('\n'),
  )

  sections.push(
    [
      'Two details that cause silent breakage:',
      '- A flow must always have a trigger card, even one that is only ever started by another flow. "homey:manager:flow" / "programmatic_trigger" never fires on its own and is the right card for that.',
      '- Token references are written differently in the two kinds of flow. A standard flow uses [[ownerUri|tokenId]]; an advanced flow refers to the node that produced the token instead. Mixing them produces a flow that saves and then shows as unavailable in the Homey app.',
    ].join('\n'),
  )

  sections.push(
    'When something fails, read the reason. A hardware limitation will never succeed however it is reworded, a permissions problem needs the user to sign in again, and a temporary failure needs nothing but a retry. "homey_doctor" reports the state of the connection, what this hub supports, and why each capability probe answered the way it did.',
  )

  return sections.join('\n\n')
}

function describeAmbiguityHandling(askSupported: boolean | undefined): string {
  if (askSupported === true) {
    return '- When a name matches several devices or flows, the tool will ask the user which one is meant. Do not pick for them.'
  }
  if (askSupported === false) {
    return '- When a name matches several devices or flows, the tool returns the candidates instead of choosing. Put the choice to the user in the conversation and call again with the id they pick.'
  }
  return '- When a name matches several devices or flows, nothing is chosen for the user: depending on what your client supports, the tool either asks them directly or hands the candidates back to you. If you get the candidates, put the choice to the user in the conversation and call again with the id they pick.'
}

/**
 * What the probe actually said about one capability.
 *
 * The registry's `hardware` booleans are the fallback rather than the source,
 * because they carry only two of the four answers. A registry with no probe
 * detail is a test fixture or an older recording; a false there means "not
 * available", not "this hardware lacks it".
 */
function capabilityOutlook(
  capabilities: CapabilityRegistry,
  name: string,
  hardwareFallback: boolean,
): CapabilityOutlook {
  const probe = capabilities.probes?.[name]
  if (probe !== undefined) return probe.status
  return hardwareFallback ? 'available' : 'unknown'
}

/**
 * One capability line.
 *
 * The four probe outcomes stay four outcomes. "NOT available on this hardware"
 * is a claim about the hub that a model cannot work around, so it is reserved
 * for the one outcome that means it. A probe that was refused or that simply
 * failed says "unconfirmed", names why, and points at "homey_doctor", because on
 * a hub that rate limits itself a failed probe is usually temporary.
 *
 * `consequence` reads as a clause and describes what is true while the
 * capability is not available, so it fits every branch below.
 */
function renderCapabilityLine(feature: string, outlook: CapabilityOutlook, consequence: string): string {
  switch (outlook) {
    case 'available':
      return `- ${feature}: available.`
    case 'unsupported':
      return `- ${feature}: not available on this hardware, so ${consequence}. That one is settled: no rewording or retry can change it.`
    case 'forbidden':
      return `- ${feature}: unconfirmed. The probe was refused for this session rather than answered, which is a permissions problem and not a hardware one. For now ${consequence}. Ask the user to run "homey login" and restart this server, and use "homey_doctor" for the detail.`
    case 'failed':
      return `- ${feature}: unconfirmed. The probe itself failed, and this hub refuses requests that arrive together, so a probe can fail on a feature that works. For now ${consequence}, but tell the user it is unconfirmed rather than missing, and call "homey_doctor" to see why.`
    case 'unknown':
      return `- ${feature}: not available, with no probe detail recorded, so a missing feature cannot be told apart from a probe that never completed. For now ${consequence}. "homey_doctor" reports which it is.`
  }
}

/**
 * Where energy over time comes from when the report routes are missing.
 *
 * This used to send the model to the Insights tools unconditionally, two lines
 * under a statement that Insights was unavailable. The advice is only true while
 * Insights actually answers.
 */
function describeEnergyFallback(insights: CapabilityOutlook): string {
  switch (insights) {
    case 'available':
      return 'ask for energy over time through the Insights tools instead, using meter_power for cumulative totals and measure_power for instantaneous draw'
    case 'unsupported':
      return 'and Insights, the only other route to energy over time, is missing from this hardware too, so nothing here can answer historical energy; "homey_energy_live" still reports what the house is drawing right now'
    default:
      return 'energy over time would have to come from the Insights tools, but Insights is unconfirmed on this hub as well, so check "homey_doctor" before promising any energy history'
  }
}

/**
 * Moods, which this server has no tool for.
 *
 * The hub having moods was being reported as a capability of this server, so the
 * positive branch promised something no tool keeps. What is true either way is
 * that the only route to a mood here is a flow card.
 */
function renderMoodsLine(outlook: CapabilityOutlook): string {
  if (outlook === 'available') {
    return '- Moods (a saved set of device states): this hub has them, but this server has no mood tool, so a mood cannot be read or set directly. A mood can still be set from inside a flow: search for a mood card with "homey_flowcards_search" and build it into a flow like any other card.'
  }
  if (outlook === 'unsupported') {
    return '- Moods: not available on this hardware, and this server has no mood tool in any case. Neither a direct call nor a mood flow card will work here.'
  }
  return '- Moods: unconfirmed on this hub, and this server has no mood tool in any case. The only possible route is a mood flow card, if this hub has one; "homey_doctor" reports what the probe said.'
}

function describeAddressKind(identity: HomeyIdentity): string {
  switch (identity.addressKind) {
    case 'local':
      return 'the local network'
    case 'localSecure':
      return 'the local network over TLS'
    case 'cloud':
      return "Athom's cloud, because no local address answered"
    default:
      return 'the network'
  }
}
