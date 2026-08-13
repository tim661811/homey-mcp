// Card discovery, which is the make-or-break piece of flow authoring.
//
// The measured hub exposes 808 flow cards totalling 617 KB of JSON. That
// number decides the shape of this whole module: the catalogue can never be
// returned wholesale, an unfiltered search is refused rather than truncated,
// and a search result carries only what is needed to pick a card. The full
// argument schema comes from `homey_flowcard_describe`, one card at a time.
//
// A model finds a card through these three tools or it does not find it at
// all, so their descriptions are written for a reader who has never seen a
// Homey.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { normaliseForComparison, toEntries } from '../../homey/cache.js'
import { HomeyMcpError, classifyError } from '../../homey/errors.js'
import { formatGlobalToken, formatLocalToken, formatNodeToken } from '../../flow/tokens.js'
import type { FlowCardDescriptor, FlowCardKind } from '../../homey/types.js'
import { flowCardKindWithArticle } from '../../homey/types.js'
import type { ServerContext } from '../context.js'
import { READ_ONLY_TOOL_ANNOTATIONS } from '../createServer.js'
import { failureResult, invalidRequestResult } from '../errors.js'
import { successResult } from '../render.js'

const DEFAULT_SEARCH_LIMIT = 25
const MAXIMUM_SEARCH_LIMIT = 100
const DEFAULT_AUTOCOMPLETE_LIMIT = 25

const CARD_KINDS = ['trigger', 'condition', 'action'] as const

/** What the hub's autocomplete route calls each card kind in its `:type` path segment. */
const AUTOCOMPLETE_TYPE_SEGMENTS: Record<FlowCardKind, readonly string[]> = {
  // `flowcardaction` is what real working code sends and what the item ids in
  // the API specification are called. The bare kind is kept as a second
  // attempt because the segment is undocumented and two widely copied
  // references send that form instead.
  trigger: ['flowcardtrigger', 'trigger'],
  condition: ['flowcardcondition', 'condition'],
  action: ['flowcardaction', 'action'],
}

interface FlowAutocompleteCalls {
  getFlowCardAutocomplete(options: {
    id: string
    type: string
    name: string
    query: string
    args?: Record<string, unknown>
  }): Promise<unknown>
}

export function registerFlowCardTools(server: McpServer, context: ServerContext): void {
  // Which `:type` segment this hub answered to, per card kind. The route is
  // undocumented, so it is determined once by trying and then reused rather
  // than paid for on every call.
  const provenAutocompleteSegments = new Map<FlowCardKind, string>()

  server.registerTool(
    'homey_flowcards_search',
    {
      title: 'Search Homey flow cards',
      description: [
        'Finds the flow cards available on this Homey. Flow cards are the building blocks of a flow: a trigger card starts it, condition cards decide whether it continues, and action cards do something.',
        'This Homey exposes hundreds of cards, so at least one filter is required: a search term, a device, an owning app or manager, or an owner uri. An unfiltered call is refused.',
        'Results carry only enough to choose a card. Call homey_flowcard_describe for the full argument schema before using one in a flow.',
      ].join(' '),
      inputSchema: {
        query: z.string().optional().describe('Words to look for in the card title, its short id, its hint or its owner name. For example "turn on", "motion", "notification".'),
        kind: z.enum(CARD_KINDS).optional().describe('Restrict to trigger, condition or action cards.'),
        device: z.string().optional().describe('A device name or id. Returns only the cards that device contributes itself, for example its own on/off action.'),
        owner: z.string().optional().describe('Part of the owning app or manager name, for example "Sonos" or "Notifications".'),
        ownerUri: z.string().optional().describe('An exact owner uri, for example homey:manager:notifications or homey:device:<uuid>.'),
        includeDeprecated: z.boolean().optional().describe('Include cards their app has marked deprecated. Off by default.'),
        limit: z.number().int().min(1).max(MAXIMUM_SEARCH_LIMIT).optional().describe(`Maximum number of cards to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const hasFilter =
          isFilled(input.query) || isFilled(input.device) || isFilled(input.owner) || isFilled(input.ownerUri)

        if (!hasFilter) {
          return invalidRequestResult(
            'This Homey has hundreds of flow cards, far too many to list. Narrow the search first: give a search term, a device, an owning app, or an owner uri.',
            {
              suggestion:
                'For a device\'s own cards pass device: "<device name>". For a search across everything pass query: "<what the card should do>".',
            },
          )
        }

        let ownerUriFilter: string | null = isFilled(input.ownerUri) ? input.ownerUri.trim() : null

        if (isFilled(input.device)) {
          const resolution = await context.cache.resolveDevice(input.device)
          if (resolution.match === null) {
            return invalidRequestResult(
              resolution.reason === 'ambiguous'
                ? `"${input.device}" matches ${resolution.candidates.length} devices, so no cards were searched. Say which one is meant.`
                : `No device on this Homey matches "${input.device}".`,
              {
                reason: resolution.reason,
                candidates: resolution.candidates.map((device) => ({ id: device.id, name: device.name, zoneName: device.zoneName })),
              },
            )
          }
          ownerUriFilter = `homey:device:${resolution.match.id}`
        }

        const index =
          input.kind === undefined ? await context.cache.getAllFlowCards() : await context.cache.getFlowCards(input.kind)

        const ownerNameFilter = isFilled(input.owner) ? normaliseForComparison(input.owner) : null
        const terms = isFilled(input.query) ? normaliseForComparison(input.query).split(' ').filter((term) => term !== '') : []

        const scored: Array<{ card: FlowCardDescriptor; score: number }> = []
        for (const card of index.all) {
          if (card.deprecated && input.includeDeprecated !== true) continue
          if (ownerUriFilter !== null && card.ownerUri !== ownerUriFilter) continue
          if (ownerNameFilter !== null && !normaliseForComparison(card.ownerName).includes(ownerNameFilter)) continue

          const score = terms.length === 0 ? 1 : scoreCard(card, terms)
          if (score <= 0) continue
          scored.push({ card, score })
        }

        scored.sort((first, second) => second.score - first.score || first.card.title.localeCompare(second.card.title))

        const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
        const page = scored.slice(0, limit)

        return successResult(
          page.length === 0
            ? 'No flow card on this Homey matches that. Try fewer words, or drop the device or owner filter.'
            : `${page.length} of ${scored.length} matching flow cards.`,
          {
            totalMatches: scored.length,
            truncated: scored.length > page.length,
            cards: page.map(({ card }) => summariseCard(card)),
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'search flow cards', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flowcard_describe',
    {
      title: 'Describe one Homey flow card',
      description: [
        'Returns everything needed to use one flow card: every argument with its type and allowed values, the values the card emits for later cards to read, whether it accepts a dropped value, and whether it is deprecated.',
        'Call this for each card before building a flow. Guessing an argument name produces a flow that saves and then does nothing.',
      ].join(' '),
      inputSchema: {
        id: z.string().describe('The full card id from homey_flowcards_search, for example homey:manager:notifications:create_notification.'),
        kind: z
          .enum(CARD_KINDS)
          .optional()
          .describe('Which meaning of the id you want, when one id names cards of more than one kind. Omit to be told about all of them.'),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const index = await context.cache.getAllFlowCards()
        const cardId = input.id.trim()
        // Every kind carrying this id, because an id names one card per kind and
        // not one card. homey:manager:flow:programmatic_trigger is both the
        // trigger "this Flow has started" and the action "start a Flow", and
        // answering with only one of them sends the reader off to build the
        // wrong thing.
        const matches = input.kind === undefined
          ? index.findById(cardId)
          : [index.get(input.kind, cardId)].filter((card): card is FlowCardDescriptor => card !== undefined)

        if (matches.length === 0) {
          throw new HomeyMcpError('not_found', `This Homey has no ${input.kind ?? 'flow'} card "${input.id}".`, {
            suggestion: 'Find the right id with homey_flowcards_search. Card ids are case sensitive and always start with homey:.',
          })
        }

        const card = preferredCard(matches)
        const summary =
          matches.length === 1
            ? `${card.title} (${card.kind} card owned by ${card.ownerName || card.ownerUri}).`
            : `"${cardId}" names ${matches.length} cards on this Homey, one per kind: ${matches
                .map((match) => `${match.kind} "${match.title}"`)
                .join(', ')}. Use the one whose kind fits the place in the flow. "card" below holds the ${card.kind}; "cards" holds every one of them.`

        return successResult(summary, {
          card: describeCard(card),
          cards: matches.map((match) => describeCard(match)),
        })
      } catch (error) {
        return failureResult(error, { operation: 'describe a flow card', logger: context.logger })
      }
    },
  )

  server.registerTool(
    'homey_flowcard_autocomplete',
    {
      title: 'Resolve a Homey flow card argument',
      description: [
        'Asks the Homey what a device-typed or autocomplete-typed argument can be set to, and returns the choices.',
        'Store the WHOLE object of the chosen result as the argument value. Cards keep app-specific fields next to the id and the name, for example a Google Cast action stores the host and description alongside them, and rebuilding the object by hand loses those and breaks the card.',
      ].join(' '),
      inputSchema: {
        cardId: z.string().describe('The full card id, for example homey:app:com.google.cast:tts.'),
        kind: z
          .enum(CARD_KINDS)
          .optional()
          .describe('Which meaning of the id you want, for the few ids that name a card of more than one kind. Only needed when the tool asks for it.'),
        argument: z.string().describe('The name of the argument to resolve, taken from homey_flowcard_describe.'),
        query: z.string().optional().describe('What to search for. An empty string lists everything the argument accepts.'),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Arguments already chosen on this card. Some choices depend on an earlier one, for example a playlist depends on the speaker.'),
        limit: z.number().int().min(1).max(MAXIMUM_SEARCH_LIMIT).optional().describe(`Maximum number of choices to return. Defaults to ${DEFAULT_AUTOCOMPLETE_LIMIT}.`),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const index = await context.cache.getAllFlowCards()
        const cardId = input.cardId.trim()
        const matches = input.kind === undefined
          ? index.findById(cardId)
          : [index.get(input.kind, cardId)].filter((entry): entry is FlowCardDescriptor => entry !== undefined)

        if (matches.length === 0) {
          throw new HomeyMcpError('not_found', `This Homey has no ${input.kind ?? 'flow'} card "${input.cardId}".`, {
            suggestion: 'Find the right id with homey_flowcards_search.',
          })
        }

        // The autocomplete route is per kind, so an id that names a card of more
        // than one kind has to be narrowed. The argument usually does it: only
        // one of the two cards declares it. When it does not, ask rather than
        // pick, because the wrong route answers with the wrong choices.
        const declaringArgument = matches.filter((entry) => entry.args.some((argument) => argument.name === input.argument))
        if (declaringArgument.length > 1) {
          throw new HomeyMcpError('invalid_request', `"${cardId}" names a ${declaringArgument.map((entry) => entry.kind).join(' card and a ')} card, and both take "${input.argument}".`, {
            suggestion: 'Send the kind alongside the card id to say which one you mean.',
            kinds: declaringArgument.map((entry) => entry.kind),
          })
        }

        const card = declaringArgument[0] ?? matches[0]!
        const argument = card.args.find((entry) => entry.name === input.argument)
        if (argument === undefined) {
          throw new HomeyMcpError('invalid_request', `"${card.title}" has no argument called "${input.argument}".`, {
            availableArguments: card.args.map((entry) => ({ name: entry.name, type: entry.type })),
          })
        }

        if (argument.type !== 'autocomplete' && argument.type !== 'device') {
          return successResult(
            `"${input.argument}" is a ${argument.type} argument, so it is not resolved through the Homey.`,
            {
              resolvable: false,
              argument: { name: argument.name, type: argument.type, values: argument.values },
              guidance:
                argument.values.length > 0
                  ? 'Send one of the listed ids as the argument value.'
                  : 'Send a plain value of the declared type.',
            },
          )
        }

        const results = await runAutocomplete(card, argument.name, input.query ?? '', input.args)
        const limit = input.limit ?? DEFAULT_AUTOCOMPLETE_LIMIT
        const page = results.slice(0, limit)

        return successResult(
          page.length === 0
            ? `The Homey offered nothing for "${input.argument}"${input.query === undefined || input.query === '' ? '' : ` matching "${input.query}"`}.`
            : `${page.length} of ${results.length} choices for "${input.argument}".`,
          {
            resolvable: true,
            cardId: card.id,
            argument: argument.name,
            truncated: results.length > page.length,
            // Named `value` rather than `result` to say plainly what to do with
            // it: this exact object is what the argument is set to.
            choices: page.map((result) => ({ label: describeChoice(result), value: result })),
          },
        )
      } catch (error) {
        return failureResult(error, { operation: 'resolve a flow card argument', logger: context.logger })
      }
    },
  )

  async function runAutocomplete(
    card: FlowCardDescriptor,
    argumentName: string,
    query: string,
    args: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>[]> {
    const flowManager = (context.connection.api as { flow: FlowAutocompleteCalls }).flow

    const proven = provenAutocompleteSegments.get(card.kind)
    const candidates = proven === undefined ? AUTOCOMPLETE_TYPE_SEGMENTS[card.kind] : [proven]

    let lastError: unknown = null
    for (const segment of candidates) {
      try {
        const raw = await context.connection.request(
          () =>
            flowManager.getFlowCardAutocomplete({
              // Only `id` is passed, never `uri`: `homey-api` derives the owner
              // uri from the id and splits it for a V2 hub, and a uri supplied
              // here would override that derivation with an unsplit value.
              id: card.id,
              type: segment,
              name: argumentName,
              query,
              ...(args === undefined ? {} : { args }),
            }),
          'flow.getFlowCardAutocomplete',
          // A read: it asks an app what a value may be and changes nothing, so a
          // repeat after a timeout cannot do anything twice.
          true,
        )

        provenAutocompleteSegments.set(card.kind, segment)
        // The same "an object keyed by id, or an array" rule every other
        // collection off this hub arrives under, so it uses the same reader.
        return toEntries(raw)
      } catch (error) {
        const classified = classifyError(error, {
          operation: 'flow.getFlowCardAutocomplete',
          notFoundMeans: 'unsupported_hardware',
        })
        // Only a missing route is worth a second attempt with a different path
        // segment. Anything else is the hub answering, and retrying the same
        // question a different way would only hide the answer.
        if (classified.reason !== 'unsupported_hardware') throw classified
        lastError = classified
      }
    }

    throw lastError ??
      new HomeyMcpError('unsupported_hardware', 'This Homey did not answer the flow card autocomplete route.', {
        cardId: card.id,
        argument: argumentName,
      })
  }
}

// ---------------------------------------------------------------------------
// Ranking and rendering
// ---------------------------------------------------------------------------

/**
 * Ranks a card against the search terms.
 *
 * Every term has to appear somewhere on the card, so "turn on light" does not
 * match a card that only knows about "light". Where a term appears decides how
 * strongly it counts: the title is what the owner sees in the app, the short id
 * is what a model is most likely to half-remember, and the hint is the weakest
 * signal.
 */
function scoreCard(card: FlowCardDescriptor, terms: string[]): number {
  const title = normaliseForComparison(card.title)
  const fullId = normaliseForComparison(card.id)
  const shortId = normaliseSearchable(card.shortId)
  const ownerName = normaliseForComparison(card.ownerName)
  const hint = normaliseForComparison(card.hint ?? '')

  let total = 0
  for (const term of terms) {
    let best = 0
    if (title === term) best = 100
    else if (title.startsWith(term)) best = 70
    else if (title.includes(term)) best = 50
    // The short id is compared with its underscores folded to spaces, so the
    // term has to be folded the same way or `alarm_contact_true` typed exactly
    // as the hub spells it matches nothing while "alarm contact true" matches.
    // Measured against the live hub: searching for "programmatic_trigger", the
    // one card id this project recommends by name, returned no results at all.
    const searchableTerm = normaliseSearchable(term)
    if (shortId === searchableTerm) best = Math.max(best, 90)
    else if (shortId.includes(searchableTerm)) best = Math.max(best, 40)
    // Pasting a whole card id, or the owner uri out of one, has to find the
    // card: it is what a search result reports, and it is what the wrong-kind
    // diagnostic in flow validation hands back with "search for the right
    // card". Neither the title nor the short id contains a colon, so an id
    // matched nothing at all and the advice led nowhere. The colon is also what
    // keeps this from adding noise: an ordinary word is never compared against
    // the id, so "device" cannot match every card a device owns.
    if (term.includes(':')) {
      if (fullId === term) best = Math.max(best, 100)
      else if (fullId.startsWith(term)) best = Math.max(best, 80)
      else if (fullId.includes(term)) best = Math.max(best, 60)
    }
    if (ownerName.includes(term)) best = Math.max(best, 25)
    if (hint.includes(term)) best = Math.max(best, 10)

    if (best === 0) return 0
    total += best
  }

  // A card the app hides behind "advanced" is a worse first suggestion than an
  // ordinary one that scored the same.
  if (card.advanced) total -= 5
  if (card.deprecated) total -= 20

  return total
}

function summariseCard(card: FlowCardDescriptor): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: card.id,
    kind: card.kind,
    title: card.title,
    ownerUri: card.ownerUri,
    ownerName: card.ownerName,
    argNames: card.args.map((argument) => argument.name),
  }
  if (card.deprecated) summary['deprecated'] = true
  if (card.advanced) summary['advanced'] = true
  return summary
}

function describeCard(card: FlowCardDescriptor): Record<string, unknown> {
  const raw = card.raw as Record<string, unknown> | null
  const nodeTokenNamespace = nodeTokenNamespaceOf(card.kind)

  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    // The `[[argument]]` placeholders show where each argument lands in the
    // sentence the owner reads, which is the clearest statement of what an
    // argument actually means.
    titleFormatted: typeof raw?.['titleFormatted'] === 'string' ? raw['titleFormatted'] : null,
    hint: card.hint,
    ownerUri: card.ownerUri,
    ownerType: card.ownerType,
    ownerName: card.ownerName,
    deprecated: card.deprecated,
    advanced: card.advanced,
    supportsDuration: raw?.['duration'] === true,
    acceptedDropTokenTypes: normaliseDropTokenTypes(raw?.['droptoken']),
    args: card.args.map((argument) => {
      const argumentRaw = argument.raw as Record<string, unknown> | null
      return {
        name: argument.name,
        type: argument.type,
        title: argument.title,
        placeholder: argument.placeholder,
        required: argument.required,
        values: argument.values,
        min: typeof argumentRaw?.['min'] === 'number' ? argumentRaw['min'] : null,
        max: typeof argumentRaw?.['max'] === 'number' ? argumentRaw['max'] : null,
        step: typeof argumentRaw?.['step'] === 'number' ? argumentRaw['step'] : null,
        resolveWith:
          argument.type === 'autocomplete' || argument.type === 'device'
            ? 'homey_flowcard_autocomplete, storing the whole returned object'
            : null,
      }
    }),
    emitsTokens: card.tokens.map((token) => ({
      id: token.id,
      type: token.type,
      title: token.title,
      example: token.example,
      // Spelled out because the two token dialects are the single most common
      // way a generated flow ends up silently broken. Both forms are built by
      // the same formatters the flow writer uses, so a card cannot be described
      // in a syntax the writer would not produce.
      //
      // The short `[[<tokenId>]]` form addresses a value published by the
      // flow's OWN trigger and nothing else. Offering it for every card handed
      // the reader a reference a condition or an action can never satisfy: the
      // hub stores the flow, reports it as healthy, and the Homey app renders
      // the card as "Unavailable". So only a trigger is described in the short
      // form; every other card gets the owner form, which is the one that can
      // resolve from anywhere in the flow.
      referenceInStandardFlow:
        card.kind === 'trigger' ? formatLocalToken(token.id) : formatGlobalToken(card.ownerUri, token.id),
      referenceInStandardFlowNote:
        card.kind === 'trigger'
          ? `The short form works only inside a flow whose own trigger is this card. Anywhere else the value is written with the owner uri and a pipe, as in ${formatGlobalToken(card.ownerUri, token.id)}.`
          : `A standard flow can use the short form only for a value its own trigger published, and this is ${flowCardKindWithArticle(card.kind)} card, so the owner form above is the one that resolves. To read what one particular card produced part-way through a flow, build an advanced flow and reference that card's node instead.`,
      referenceInAdvancedFlow:
        nodeTokenNamespace === null
          ? null
          : formatNodeToken(nodeTokenNamespace, '<the key of this card in the flow>', token.id),
      ...(nodeTokenNamespace === null
        ? {
            referenceInAdvancedFlowNote:
              'An advanced flow can only address the output of a trigger or an action node, so a condition card\'s values have no node-token form. Read the value from the card that produced it instead.',
          }
        : {}),
    })),
  }
}

/**
 * Which of the cards sharing an id the single `card` field describes.
 *
 * Only reached when the caller did not say which kind it meant. Taking
 * `matches[0]` left the answer to the order the three catalogues happen to be
 * concatenated in, which is triggers first, so the reader was handed the
 * trigger by accident rather than by intent, and a change to the index order
 * would have quietly changed the answer. The preference is stated here instead:
 * a trigger, because it is the one card every flow must have and the one an id
 * is most often looked up for, then an action, then a condition. Every match is
 * returned alongside under `cards` either way, and the summary names which kind
 * this one is.
 */
function preferredCard(matches: FlowCardDescriptor[]): FlowCardDescriptor {
  const order: FlowCardKind[] = ['trigger', 'action', 'condition']
  for (const kind of order) {
    const match = matches.find((candidate) => candidate.kind === kind)
    if (match !== undefined) return match
  }
  return matches[0]!
}

/**
 * The node-token namespace a card of this kind is read through in an advanced
 * flow, or null where there is none.
 *
 * The two vocabularies look alike and are not the same list. A card is a
 * trigger, a condition or an action, while a node token is written `trigger`,
 * `action` or `card`, and that last one addresses an error branch rather than a
 * kind of card. Reusing `card.kind` verbatim therefore handed a model
 * `[[condition::...]]`, which this project's own validator rejects and which the
 * firmware stores without complaint before rendering the card as "Unavailable".
 */
function nodeTokenNamespaceOf(kind: FlowCardKind): 'trigger' | 'action' | null {
  switch (kind) {
    case 'trigger':
      return 'trigger'
    case 'action':
      return 'action'
    case 'condition':
      return null
  }
}

/**
 * Normalises the two shapes a card's `droptoken` field takes.
 *
 * A V2 descriptor answers "does this card accept a dropped value" with a
 * boolean; a V3 descriptor answers "which types" with an array, and sometimes
 * with a bare string. All three are reported the same way here.
 */
function normaliseDropTokenTypes(value: unknown): string[] | null {
  if (value === true) return ['any']
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return null
}

function describeChoice(result: Record<string, unknown>): string {
  const name = result['name']
  const description = result['description']
  if (typeof name === 'string' && typeof description === 'string' && description !== '') return `${name} (${description})`
  if (typeof name === 'string') return name
  const id = result['id']
  return typeof id === 'string' ? id : JSON.stringify(result)
}

function isFilled(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The shared normaliser plus underscore folding.
 *
 * Only used on a card's short id, where `alarm_motion_true` should match the
 * words someone would actually type. Applying it to a title would run two
 * hyphenated words together.
 */
function normaliseSearchable(value: string): string {
  return normaliseForComparison(value.replace(/[_-]+/g, ' '))
}
