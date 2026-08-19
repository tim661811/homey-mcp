import { describe, expect, it } from 'vitest'

import { buildServerInstructions } from './instructions.js'
import type { CapabilityProbeOutcome, CapabilityRegistry, HomeyIdentity } from '../homey/types.js'

// Modelled on the measured hub: a Homey Pro (Early 2019) has no historical
// energy report routes but does have Advanced Flows, Insights and moods, which
// is exactly the case the instructions have to describe honestly.
const IDENTITY: HomeyIdentity = {
  id: 'test-homey',
  name: 'Test Home',
  modelId: 'homey4d',
  modelName: 'Homey Pro (Early 2019)',
  softwareVersion: '13.2.4',
  platformVersion: 1,
  language: 'en',
  timezone: 'Europe/Amsterdam',
  address: 'http://homey.invalid',
  addressKind: 'local',
}

function outcome(status: CapabilityProbeOutcome['status'], probe: string, detail?: string): CapabilityProbeOutcome {
  return { status, probe, statusCode: null, durationMs: 12, detail: detail ?? null }
}

const CAPABILITIES: CapabilityRegistry = {
  hardware: { advancedFlow: false, energyReports: false, moods: true, insights: true },
  probedAt: '2026-08-13T08:00:00.000Z',
  notes: ['This Homey does not offer historical energy reports: the route answered "not found".'],
  probes: {
    advancedFlow: outcome('unsupported', 'flow.getAdvancedFlows'),
    energyReports: outcome('unsupported', 'GET /api/manager/energy/reports/available'),
    moods: outcome('available', 'moods.getMoods'),
    insights: outcome('available', 'insights.getLogs'),
  },
}

function build(capabilities: CapabilityRegistry = CAPABILITIES, askSupported?: boolean): string {
  return buildServerInstructions({
    identity: IDENTITY,
    dialect: 'v2',
    capabilities,
    ...(askSupported === undefined ? {} : { askSupported }),
  })
}

function withProbes(probes: Record<string, CapabilityProbeOutcome>): CapabilityRegistry {
  return { ...CAPABILITIES, probes: { ...CAPABILITIES.probes, ...probes } }
}

describe('buildServerInstructions', () => {
  it('names the hardware that actually answered', () => {
    const instructions = build()

    expect(instructions).toContain('Homey Pro (Early 2019)')
    expect(instructions).toContain('13.2.4')
    expect(instructions).toContain('Europe/Amsterdam')
  })

  it('states what this hub cannot do and what to do instead', () => {
    const instructions = build()

    expect(instructions).toContain('Advanced Flows (the visual, multi-branch kind): not available on this hardware')
    expect(instructions).toContain('Historical energy reports: not available on this hardware')
    expect(instructions).toContain('meter_power')
  })

  // Matched on the numbered steps rather than on the first mention of each tool
  // name, because a step may legitimately name a later tool: step 4 says that
  // homey_flow_validate is what rejects an unresolved device argument.
  it('gives the authoring workflow in the order that works', () => {
    const steps = build()
      .split('\n')
      .filter((line) => /^\d\. /.test(line))

    expect(steps).toHaveLength(7)
    expect(steps[0]).toContain('homey_devices_search')
    expect(steps[1]).toContain('homey_flowcards_search')
    expect(steps[2]).toContain('homey_flowcard_describe')
    expect(steps[3]).toContain('homey_flowcard_autocomplete')
    expect(steps[4]).toContain('"cardId"')
    expect(steps[5]).toContain('homey_flow_validate')
    expect(steps[6]).toContain('homey_flow_create')
  })

  // Step 4 is reached straight from step 3, and the two tools once named the
  // card id differently, so a caller that carried the value over got told a
  // field it had never been shown was missing. The instructions are read before
  // either tool description, so they are the first place the shared name has to
  // hold.
  it('names the card id the same way in both flow card steps', () => {
    const steps = build()
      .split('\n')
      .filter((line) => /^\d\. /.test(line))

    expect(steps[2]).toContain('"cardId"')
    expect(steps[3]).toContain('"cardId"')
  })

  // The instructions are the one place a model reads before any tool
  // description, so they are where a value crossing from one tool into another
  // has to be named. Each line below existed as a broken handoff first.
  describe('writing a script', () => {
    it('tells the model to take what varies as an argument rather than baking in a device', () => {
      // A requirement from the user rather than a nicety: a script with a device
      // id in it works once, for one house, and stops working when that device
      // is replaced. Said here because a model reads the instructions before it
      // reads any tool description.
      const instructions = build()

      expect(instructions).toContain('args[0]')
      expect(instructions).toContain('zone and capability')
      expect(instructions).toMatch(/reusable/i)
    })

    it('says the app may be absent and is never installed without a yes', () => {
      const instructions = build()

      expect(instructions).toContain('may not be installed')
      expect(instructions).toContain('without the user saying yes')
    })

    it('says to run a script after writing it', () => {
      const instructions = build()

      expect(instructions).toContain('homey_script_run')
    })
  })

  describe('the handoffs between tools', () => {
    it('says a card id keeps the name cardId all the way through authoring', () => {
      const instructions = build()

      expect(instructions).toContain('A flow card id is called "cardId" on every tool that takes one')
    })

    it('names the tool a model meets the card id on first among the tools that share the name', () => {
      // Step 2 of the workflow above is homey_flowcards_search, so leaving it
      // out of the list of tools that call the value "cardId" left the one
      // place a model looks first unmentioned.
      const instructions = build()

      const line = instructions.split('\n').find((candidate) => candidate.startsWith('5. A card id is called'))
      expect(line).toContain('homey_flowcards_search')
    })

    it('separates the declared argument list from the values that fill it', () => {
      // Two words a caller meets one after the other: "arguments" is the
      // schema, "args" is what you set. One word for both shapes is what this
      // line exists to prevent.
      const instructions = build()

      expect(instructions).toContain('"arguments" on both "homey_flowcards_search"')
      expect(instructions).toContain('"args" is always the other thing')
    })

    it('points from a device straight at its own history through logId', () => {
      const instructions = build()

      expect(instructions).toContain('"logId"')
      expect(instructions).toContain('homey_insights_query')
    })

    it('separates the two capability shapes by name, and says where the range lives', () => {
      const instructions = build()

      expect(instructions).toContain('"capabilitySummaries"')
      expect(instructions).toContain('"capabilityValues"')
    })

    it('promises the undo pre-images can go straight back in', () => {
      const instructions = build()

      expect(instructions).toContain('"previousFlow"')
      expect(instructions).toContain('"deletedFlow"')
    })

    it('explains the advanced graph handoff only on a Homey that has Advanced Flow', () => {
      // Naming "cards", "x" and "y" on a hub with no Advanced Flow describes
      // tools that were never registered, which is the same untruth the
      // capability lines exist to avoid.
      const withoutAdvancedFlow = build()
      expect(withoutAdvancedFlow).not.toContain('the canvas is laid out again from scratch')

      const withAdvancedFlow = build({
        ...CAPABILITIES,
        hardware: { ...CAPABILITIES.hardware, advancedFlow: true },
        probes: { ...CAPABILITIES.probes, advancedFlow: outcome('available', 'flow.getAdvancedFlows') },
      })
      expect(withAdvancedFlow).toContain('a list called "cards" going in and a list called "cards" coming back')
      expect(withAdvancedFlow).toContain('the canvas is laid out again from scratch')
    })
  })

  // homey_flowcard_autocomplete answers with `choices: [{label, value}]`, so
  // "store the whole object it returns" named the wrapper rather than the thing
  // that goes into the card. The tool's own description was already precise; the
  // instructions were the half that was not.
  it('names the choice value as what goes into an autocomplete argument', () => {
    const step = build()
      .split('\n')
      .find((line) => line.includes('homey_flowcard_autocomplete'))

    expect(step).toBeDefined()
    expect(step).toContain('"value"')
    expect(step).not.toContain('the whole object it returns')
  })

  // A `device` argument needs exactly the same resolution as an `autocomplete`
  // one, and homey_flow_validate rejects a bare device id. Following the old
  // wording literally got a model bounced by this project's own validate step,
  // and the field that says what to do was never named.
  it('sends the model to resolveWith rather than to the autocomplete type alone', () => {
    const step = build()
      .split('\n')
      .find((line) => line.includes('homey_flowcard_autocomplete'))

    expect(step).toContain('resolveWith')
    expect(step).toContain('device')
  })

  it('tells the model to hand an ambiguous choice back when the client cannot ask', () => {
    expect(build(CAPABILITIES, false)).toContain('returns the candidates instead of choosing')
    expect(build(CAPABILITIES, true)).toContain('will ask the user which one is meant')
  })

  it('reports an Advanced Flow capable hub as capable', () => {
    const instructions = buildServerInstructions({
      identity: IDENTITY,
      dialect: 'v3',
      capabilities: withProbes({ advancedFlow: outcome('available', 'flow.getAdvancedFlows') }),
    })

    expect(instructions).toContain('Advanced Flows (the visual, multi-branch kind): available.')
    expect(instructions).toContain('newer (V3)')
  })

  it('announces outdoor weather when the probe found it', () => {
    const instructions = build(withProbes({ weather: outcome('available', 'GET /api/manager/weather/weather') }))

    // 'available' on its own was misleading and cost a real session a detour:
    // it is true of the read and says nothing about flow cards, and this hub has
    // 797 of those with not one weather card among them.
    expect(instructions).toContain('available to READ')
    expect(instructions).toContain('homey_flowcards_search')
    expect(instructions).toContain('HomeyScript')
  })

  it('says outdoors is unavailable rather than promising it on a hub that has no weather route', () => {
    const instructions = build(withProbes({ weather: outcome('unsupported', 'GET /api/manager/weather/weather') }))
    const line = lineFor(instructions, 'Outdoor weather')

    expect(line).toContain('not available on this hardware')
    expect(line).toContain('compare rooms against each other')
  })

  // A probe fails for four different reasons and only one of them is a fact
  // about the hardware. Rendering the other three as "not available on this
  // hardware" tells the model that retrying can never help, which on a hub that
  // rate limits itself is usually the opposite of the truth.
  describe('a probe that did not settle the question', () => {
    it('calls a failed probe unconfirmed rather than unsupported hardware', () => {
      const instructions = build(
        withProbes({ insights: outcome('failed', 'insights.getLogs', 'Homey did not answer in time.') }),
      )
      const line = lineFor(instructions, 'Sensor and energy history (Insights)')

      expect(line).toContain('unconfirmed')
      expect(line).not.toContain('not available on this hardware')
      expect(line).toContain('homey_doctor')
    })

    it('calls a refused probe a permissions problem and names the fix', () => {
      const instructions = build(withProbes({ insights: outcome('forbidden', 'insights.getLogs') }))
      const line = lineFor(instructions, 'Sensor and energy history (Insights)')

      expect(line).toContain('unconfirmed')
      expect(line).toContain('permissions problem')
      expect(line).toContain('homey login')
      expect(line).not.toContain('not available on this hardware')
    })

    it('still says settled when the hardware genuinely lacks the feature', () => {
      const line = lineFor(build(), 'Advanced Flows (the visual, multi-branch kind)')

      expect(line).toContain('not available on this hardware')
      expect(line).toContain('settled')
    })

    // The registration gate asks shouldOfferCapability, so an unsettled probe
    // registers the advanced flow tools. This line has to agree with it: it
    // told the model the tools were not registered in every branch except
    // "available", which contradicted the tool list the same server sent.
    it('does not claim the advanced flow tools are absent when the gate registered them', () => {
      for (const status of ['failed', 'forbidden'] as const) {
        const line = lineFor(
          build(withProbes({ advancedFlow: outcome(status, 'flow.getAdvancedFlows') })),
          'Advanced Flows (the visual, multi-branch kind)',
        )

        expect(line).toContain('unconfirmed')
        expect(line).not.toContain('not registered')
        expect(line).toContain('registered anyway')
      }
    })

    it('still says the advanced flow tools are absent when the hub answered that it lacks them', () => {
      const line = lineFor(build(), 'Advanced Flows (the visual, multi-branch kind)')

      expect(line).toContain('not registered in this session')
    })

    it('says a registry that established nothing cannot tell the two apart', () => {
      // A registry whose entries are null and which carries no probe detail
      // knows nothing at all. The line used to open with "not available", which
      // is the direction a model acts on by giving up, and which states a
      // verdict about someone's hardware that no measurement supports.
      const line = lineFor(
        build({
          hardware: { advancedFlow: null, energyReports: null, moods: null, insights: null },
          probedAt: '2026-08-13T08:00:00.000Z',
          notes: [],
        }),
        'Sensor and energy history (Insights)',
      )

      expect(line).toContain('unconfirmed')
      expect(line).toContain('no probe detail')
      expect(line).not.toContain('not available')
    })

    // The registry entries carry three answers where the probe outcome carries
    // four, so a registry with no probe detail still has to be read for what it
    // says rather than for whether it is truthy.
    it('reads a settled false as settled even with no probe detail behind it', () => {
      const line = lineFor(
        build({
          hardware: { advancedFlow: false, energyReports: false, moods: false, insights: false },
          probedAt: '2026-08-13T08:00:00.000Z',
          notes: [],
        }),
        'Sensor and energy history (Insights)',
      )

      expect(line).toContain('not available on this hardware')
      expect(line).toContain('settled')
    })

    it('never reports a capability as available on the strength of an unsettled probe', () => {
      // The measured residual: with every probe lost to a dropped connection the
      // registry answered true, and this line then told the model the hub has
      // historical energy reports on hardware whose report routes answer a clean
      // 404. Both halves are pinned here, the entry and the sentence.
      const instructions = build({
        hardware: { advancedFlow: null, energyReports: null, moods: null, insights: null },
        probedAt: '2026-08-13T08:00:00.000Z',
        notes: [],
        probes: {
          energyReports: outcome('failed', 'GET /api/manager/energy/reports/available', 'Homey answered with an internal error.'),
          insights: outcome('failed', 'insights.getLogs', 'Homey answered with an internal error.'),
        },
      })
      const line = lineFor(instructions, 'Historical energy reports')

      expect(line).toContain('unconfirmed')
      expect(line).not.toMatch(/Historical energy reports: available/)
      expect(line).not.toContain('not available on this hardware')
    })
  })

  // The energy line used to send the model to the Insights tools two lines under
  // a statement that Insights was unavailable.
  describe('the energy fallback', () => {
    it('points at Insights only while Insights answers', () => {
      const line = lineFor(build(), 'Historical energy reports')

      expect(line).toContain('meter_power')
      expect(line).toContain('measure_power')
    })

    it('does not send the model to Insights when this hub has none', () => {
      const instructions = build(withProbes({ insights: outcome('unsupported', 'insights.getLogs') }))
      const line = lineFor(instructions, 'Historical energy reports')

      expect(line).not.toContain('meter_power')
      expect(line).toContain('homey_energy_live')
    })

    it('does not send the model to Insights when Insights is unconfirmed', () => {
      const instructions = build(withProbes({ insights: outcome('failed', 'insights.getLogs') }))
      const line = lineFor(instructions, 'Historical energy reports')

      expect(line).not.toContain('meter_power')
      expect(line).toContain('homey_doctor')
    })
  })

  // There is no mood tool in this server, so announcing moods as something this
  // hub "can do" promised what nothing keeps.
  describe('moods', () => {
    it('says there is no mood tool even on a hub that has moods', () => {
      const line = lineFor(build(), 'Moods')

      expect(line).toContain('no mood tool')
      expect(line).toContain('homey_flowcards_search')
      expect(line).not.toMatch(/Moods[^:]*: available\./)
    })

    it('says there is no mood tool on a hub without moods either', () => {
      const line = lineFor(build(withProbes({ moods: outcome('unsupported', 'moods.getMoods') })), 'Moods')

      expect(line).toContain('no mood tool')
    })
  })

  // The overview tool returns counts and a class histogram, and names only the
  // devices it found unavailable. Promising a list of devices and what they can
  // do sent a model looking for something that is not in the response.
  it('describes homey_home_overview as the counts it actually returns', () => {
    const line = lineFor(build(), 'homey_home_overview')

    expect(line).toContain('count')
    expect(line).not.toContain('the devices in them and what they can do')
    expect(line).toContain('homey_devices_search')
  })

  // The registry's notes are diagnostic prose meant for a human reading doctor.
  // A failed probe's note embeds the hub's own error message, which on a timeout
  // ends in advice about not repeating a write: nonsense next to a read-only GET
  // probe, and it arrives with a doubled full stop.
  it('does not paste the raw probe notes into the model\'s context', () => {
    const instructions = build(
      withProbes({
        insights: outcome(
          'failed',
          'insights.getLogs',
          'Homey did not answer in time. Check the current state first before repeating anything that changes the house.',
        ),
      }),
    )

    expect(instructions).not.toContain('anything that changes the house')
    expect(instructions).not.toMatch(/[^.]\.\.[^.]/)
  })
})

/** The one capability or workflow line mentioning `label`. */
function lineFor(instructions: string, label: string): string {
  const line = instructions.split('\n').find((candidate) => candidate.includes(label))
  if (line === undefined) throw new Error(`No line mentions ${label}`)
  return line
}
