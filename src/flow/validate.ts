// Client-side validation, because the hub barely does any.
//
// The firmware checks argument values against a card's own schema and almost
// nothing else. An unknown card id saves and renders as "NO CARD". A condition
// without a `group` saves and crashes the web editor. A droptoken written with
// a colon instead of a pipe saves and shows "Unavailable". A flow that
// references a deleted device saves, reports `broken: false`, and simply never
// fires. Only one structural mistake is caught by the hub at all, and it
// arrives as a raw database error:
//
//   SQLITE_CONSTRAINT: NOT NULL constraint failed: Flow.trigger
//
// So everything a model can get wrong is checked here, before the write, and
// reported in terms of what to do about it.
//
// This is validation only. It never talks to the hub and never runs anything.
// `testFlow` on the firmware EXECUTES the actions for real, so it is not a
// dry run and is not used from here.

import type { FlowCardDescriptor, FlowCardKind, FlowCardLookup, HomeyDialect } from '../homey/types.js'
import { flowCardKindWithArticle } from '../homey/types.js'
import type { CanonicalCard, CanonicalFlow } from './model.js'
import { ACTION_GROUPS, CONDITION_GROUPS } from './model.js'
import { missingRequiredArguments, unknownArguments } from './normalise.js'
import { collectTokenReferences, describeDroptokenProblem } from './tokens.js'
import type { AdvancedNode, CanonicalAdvancedFlow } from './advanced.js'
import { ADVANCED_NODE_TYPES, CARD_BEARING_NODE_TYPES, isValidNodeKey, outgoingTargets } from './advanced.js'

export interface ValidationProblem {
  /** Dotted path into the flow, for example `actions[1].args.text`. */
  path: string
  problem: string
  suggestion?: string
}

export interface ValidationContext {
  /**
   * Every flow card this hub exposes, looked up by kind and id. From
   * `cache.getAllFlowCards()`. Keyed by kind as well as id because the ids are
   * not unique across kinds, so an id-keyed map holds only one meaning of
   * `homey:manager:flow:programmatic_trigger` and validation rejects the other.
   */
  cards: FlowCardLookup
  /** Live device ids, so a reference to a device that was removed is caught. */
  deviceIds: ReadonlySet<string>
  /** Live zone ids. */
  zoneIds: ReadonlySet<string>
  /** Live folder ids, so a stale folder is caught before it silently resets to the root. */
  folderIds?: ReadonlySet<string>
  dialect: HomeyDialect
}

const OWNER_REFERENCE_PATTERN = /homey:(device|zone):([0-9a-fA-F-]{36})/g

/**
 * Everything wrong with a standard flow, in the order a reader would want it.
 *
 * An empty array means the flow is structurally sound and every card, argument
 * and reference in it exists on this hub. It does not mean the automation does
 * what the owner asked for.
 */
export function validateFlow(flow: CanonicalFlow, context: ValidationContext): ValidationProblem[] {
  const problems: ValidationProblem[] = []

  if (flow.name.trim() === '') {
    problems.push({ path: 'name', problem: 'a flow needs a name.', suggestion: 'Describe what it does, as the owner would say it out loud.' })
  }

  if (flow.trigger.id.trim() === '') {
    problems.push({
      path: 'trigger',
      problem: 'a flow must have a trigger card. The firmware stores the trigger in a NOT NULL column and rejects a flow without one with "SQLITE_CONSTRAINT: NOT NULL constraint failed: Flow.trigger".',
      suggestion: 'If the flow is only ever meant to be started by something else, use homey:manager:flow:programmatic_trigger, which never fires on its own.',
    })
  } else {
    validateCard(flow.trigger, 'trigger', 'trigger', context, problems)
  }

  flow.conditions.forEach((condition, index) => {
    validateCard(condition, 'condition', `conditions[${index}]`, context, problems)
    validateConditionGroup(condition, `conditions[${index}]`, context, problems)
  })

  flow.actions.forEach((action, index) => {
    validateCard(action, 'action', `actions[${index}]`, context, problems)
    validateActionGroup(action, `actions[${index}]`, problems)
    validateInterval(action.delay, `actions[${index}].delay`, problems)
    validateInterval(action.duration, `actions[${index}].duration`, problems)
  })

  if (flow.actions.length === 0) {
    problems.push({
      path: 'actions',
      problem: 'the flow has no actions, so nothing will happen when it fires.',
      suggestion: 'Add at least one action card, or say plainly that this flow is meant to do nothing yet.',
    })
  }

  validateFolder(flow.folder, 'folder', context, problems)
  validateStandardFlowTokens(flow, context, problems)

  return problems
}

function validateCard(
  card: CanonicalCard,
  kind: FlowCardKind,
  path: string,
  context: ValidationContext,
  problems: ValidationProblem[],
): void {
  if (!card.id.startsWith('homey:')) {
    problems.push({
      path: `${path}.id`,
      problem: `"${card.id}" is not a flow card id.`,
      suggestion: 'A card id looks like homey:device:<uuid>:on or homey:manager:notifications:create_notification. Find one with homey_flowcards_search.',
    })
    return
  }

  const descriptor = context.cards.get(kind, card.id)
  if (descriptor === undefined) {
    // The id may still name a card of another kind. Saying which one it is beats
    // "no such card", which would send the caller searching for an id it already
    // has.
    const otherKinds = context.cards.findById(card.id)
    if (otherKinds.length > 0) {
      problems.push({
        path: `${path}.id`,
        // One title with every kind after it read "X is a trigger and a action
        // card", which names one card and claims both meanings for it. Each
        // match gets its own title here, and the article follows the kind.
        problem:
          otherKinds.length === 1
            ? `"${otherKinds[0]!.title}" is ${flowCardKindWithArticle(otherKinds[0]!.kind)} card, so it cannot be used as ${flowCardKindWithArticle(kind)}.`
            : `"${card.id}" names ${otherKinds
                .map((entry) => `${flowCardKindWithArticle(entry.kind)} card ("${entry.title}")`)
                .join(' and ')} on this Homey, and none of them can be used as ${flowCardKindWithArticle(kind)}.`,
        suggestion: `Search homey_flowcards_search with kind "${kind}" for a card that fits here.`,
      })
      return
    }

    problems.push({
      path: `${path}.id`,
      problem: `this Homey has no flow card "${card.id}". The hub would store the flow anyway and show the card as "NO CARD" in the app.`,
      suggestion: `Search for the card you meant with homey_flowcards_search, filtering by kind "${kind}".`,
    })
    return
  }

  if (descriptor.deprecated) {
    problems.push({
      path: `${path}.id`,
      problem: `"${descriptor.title}" is deprecated. It still works, but the app that owns it may drop it.`,
    })
  }

  for (const argumentName of unknownArguments(card, descriptor)) {
    problems.push({
      path: `${path}.args.${argumentName}`,
      problem: `"${descriptor.title}" has no argument called "${argumentName}".`,
      suggestion:
        descriptor.args.length === 0
          ? 'This card takes no arguments at all.'
          : `It takes: ${descriptor.args.map((argument) => argument.name).join(', ')}. Call homey_flowcard_describe for the full schema.`,
    })
  }

  for (const argumentName of missingRequiredArguments(card, descriptor)) {
    const argumentDescriptor = descriptor.args.find((argument) => argument.name === argumentName)
    problems.push({
      path: `${path}.args.${argumentName}`,
      problem: `"${descriptor.title}" requires the argument "${argumentName}"${argumentDescriptor?.title === null || argumentDescriptor === undefined ? '' : ` (${argumentDescriptor.title})`}.`,
      suggestion:
        argumentDescriptor?.type === 'autocomplete' || argumentDescriptor?.type === 'device'
          ? 'Resolve it with homey_flowcard_autocomplete and store the whole returned object.'
          : undefined,
    })
  }

  validateArgumentValues(card, descriptor, path, problems)
  validateDroptoken(card, descriptor, path, problems)
  validateOwnerReferences(card, path, context, problems)
}

function validateArgumentValues(
  card: CanonicalCard,
  descriptor: FlowCardDescriptor,
  path: string,
  problems: ValidationProblem[],
): void {
  for (const [argumentName, value] of Object.entries(card.args ?? {})) {
    const argumentDescriptor = descriptor.args.find((argument) => argument.name === argumentName)
    if (argumentDescriptor === undefined) continue

    const argumentPath = `${path}.args.${argumentName}`
    const raw = argumentDescriptor.raw as Record<string, unknown> | null

    if (argumentDescriptor.type === 'dropdown' && argumentDescriptor.values.length > 0) {
      if (typeof value !== 'string' || !argumentDescriptor.values.some((option) => option.id === value)) {
        problems.push({
          path: argumentPath,
          problem: `"${String(value)}" is not one of the choices for "${argumentName}".`,
          suggestion: `Send one of these ids: ${argumentDescriptor.values.map((option) => `${option.id} (${option.title})`).join(', ')}.`,
        })
      }
    }

    if ((argumentDescriptor.type === 'number' || argumentDescriptor.type === 'range') && typeof value !== 'number') {
      problems.push({
        path: argumentPath,
        problem: `"${argumentName}" is a ${argumentDescriptor.type} and needs a JSON number.`,
      })
      continue
    }

    if (typeof value === 'number' && raw !== null) {
      const minimum = typeof raw['min'] === 'number' ? raw['min'] : null
      const maximum = typeof raw['max'] === 'number' ? raw['max'] : null
      if (minimum !== null && value < minimum) {
        problems.push({ path: argumentPath, problem: `${value} is below the card's minimum of ${minimum}. The hub rejects the flow with "Invalid arguments".` })
      }
      if (maximum !== null && value > maximum) {
        problems.push({ path: argumentPath, problem: `${value} is above the card's maximum of ${maximum}. The hub rejects the flow with "Invalid arguments".` })
      }
    }

    if ((argumentDescriptor.type === 'autocomplete' || argumentDescriptor.type === 'device') && (value === null || typeof value !== 'object')) {
      problems.push({
        path: argumentPath,
        problem: `"${argumentName}" stores the whole object the hub's autocomplete returned, not a bare name or id.`,
        suggestion: 'Call homey_flowcard_autocomplete for this argument and store the chosen result verbatim: some cards keep app-specific fields alongside id and name, and dropping them breaks the card.',
      })
    }

    if (argumentDescriptor.type === 'checkbox' && typeof value !== 'boolean') {
      problems.push({ path: argumentPath, problem: `"${argumentName}" is a checkbox and needs true or false.` })
    }
  }
}

function validateDroptoken(
  card: CanonicalCard,
  descriptor: FlowCardDescriptor,
  path: string,
  problems: ValidationProblem[],
): void {
  if (typeof card.droptoken !== 'string' || card.droptoken === '') return

  const problem = describeDroptokenProblem(card.droptoken)
  if (problem !== null) {
    problems.push({ path: `${path}.droptoken`, problem: `"${card.droptoken}" is not a usable droptoken: ${problem}` })
    return
  }

  const raw = descriptor.raw as Record<string, unknown> | null
  if (raw === null) return

  const accepts = raw['droptoken']
  // A V2 descriptor says only whether the card takes a droptoken at all; a V3
  // descriptor lists the types it accepts. Measured on the hub: the field is
  // present only on the cards that do take one, so its absence is the answer
  // "no droptoken slot" rather than a gap in the descriptor.
  const hasDroptokenSlot = accepts === true || typeof accepts === 'string' || Array.isArray(accepts)
  if (!hasDroptokenSlot) {
    problems.push({
      path: `${path}.droptoken`,
      problem: `"${descriptor.title}" does not take a droptoken.`,
      suggestion: 'Put the value in a text argument as [[owner|token]] instead, if the card has one.',
    })
  }
}

function validateOwnerReferences(
  card: CanonicalCard,
  path: string,
  context: ValidationContext,
  problems: ValidationProblem[],
): void {
  // Everything in the card that can name a device or a zone: the card id, the
  // droptoken and every string argument. A reference to something that was
  // deleted saves fine, reports broken: false, and never fires.
  const haystack = [card.id, card.droptoken ?? '', JSON.stringify(card.args ?? {})].join(' ')

  for (const match of haystack.matchAll(OWNER_REFERENCE_PATTERN)) {
    const ownerType = match[1]
    const ownerId = match[2]
    if (ownerId === undefined) continue

    if (ownerType === 'device' && !context.deviceIds.has(ownerId)) {
      problems.push({
        path,
        problem: `this card refers to device ${ownerId}, which is not on this Homey (any more).`,
        suggestion: 'Look the device up with homey_devices_search and use the id it reports.',
      })
    }
    if (ownerType === 'zone' && !context.zoneIds.has(ownerId)) {
      problems.push({ path, problem: `this card refers to zone ${ownerId}, which is not on this Homey (any more).` })
    }
  }
}

function validateConditionGroup(
  condition: CanonicalCard,
  path: string,
  context: ValidationContext,
  problems: ValidationProblem[],
): void {
  const group = condition.group
  if (group === undefined) {
    problems.push({
      path: `${path}.group`,
      problem: 'a condition needs a group. Without one the hub stores the flow and the Homey web editor then fails to render it.',
      suggestion: 'Use group1 unless you want an OR: conditions inside a group are ANDed, and separate groups are ORed.',
    })
    return
  }

  if (context.dialect === 'v2' && !(CONDITION_GROUPS as readonly string[]).includes(group)) {
    problems.push({
      path: `${path}.group`,
      problem: `this Homey accepts only ${CONDITION_GROUPS.join(', ')} as condition groups, not "${group}".`,
      suggestion: 'Three OR branches is the ceiling on this generation. Split the flow if you need more.',
    })
  }
}

function validateActionGroup(action: CanonicalCard, path: string, problems: ValidationProblem[]): void {
  const group = action.group
  if (group === undefined) {
    problems.push({
      path: `${path}.group`,
      problem: 'an action needs a group.',
      suggestion: 'Use "then" for the normal branch, or "else" for what should happen when the conditions are false.',
    })
    return
  }
  if (!(ACTION_GROUPS as readonly string[]).includes(group)) {
    problems.push({ path: `${path}.group`, problem: `an action's group is "then" or "else", not "${group}".` })
  }
}

function validateInterval(seconds: number | null | undefined, path: string, problems: ValidationProblem[]): void {
  if (seconds === null || seconds === undefined) return
  if (!Number.isFinite(seconds) || seconds < 0) {
    problems.push({ path, problem: `${String(seconds)} is not a number of seconds.` })
  }
}

function validateFolder(
  folder: string | null | undefined,
  path: string,
  context: ValidationContext,
  problems: ValidationProblem[],
): void {
  if (folder === null || folder === undefined || folder === '') return
  if (context.folderIds === undefined) return
  if (!context.folderIds.has(folder)) {
    problems.push({
      path,
      problem: `there is no flow folder ${folder} on this Homey. The hub accepts the flow and quietly puts it in the root instead.`,
    })
  }
}

/**
 * Checks that every `[[...]]` reference in a standard flow uses the standard
 * flow dialect AND points at a value that exists.
 *
 * A node reference such as `[[trigger::<uuid>::tag]]` belongs to an advanced
 * flow. Written into a standard flow it saves without complaint and the card
 * shows as "Unavailable" in the app, which reads like a broken app rather than
 * a wrong token.
 *
 * The short `[[<tokenId>]]` form is the other half, and checking only the
 * dialect let it through unread. That form addresses a value published by this
 * flow's OWN trigger, so a short reference to anything else is the same silent
 * "Unavailable": stored by the hub, reported as healthy, dead in the app. The
 * one bare reference in the owner's real flows is exactly this failure, in a
 * flow the hub itself marks broken. So the id is looked up in the trigger
 * card's own token list, and the message names the trigger it checked and what
 * that trigger does publish, because "unknown token" with no context leaves a
 * reader guessing at both halves.
 */
function validateStandardFlowTokens(
  flow: CanonicalFlow,
  context: ValidationContext,
  problems: ValidationProblem[],
): void {
  const cards: Array<{ card: CanonicalCard; path: string }> = [
    { card: flow.trigger, path: 'trigger' },
    ...flow.conditions.map((condition, index) => ({ card: condition, path: `conditions[${index}]` })),
    ...flow.actions.map((action, index) => ({ card: action, path: `actions[${index}]` })),
  ]

  // Undefined when the trigger card is missing or is not on this hub, which
  // `validateCard` has already reported. A second complaint per token would
  // bury the one problem that has to be fixed first.
  const triggerDescriptor = context.cards.get('trigger', flow.trigger.id)
  const publishedTokenIds = (triggerDescriptor?.tokens ?? []).map((token) => token.id)

  for (const { card, path } of cards) {
    for (const { argumentName, reference } of collectTokenReferences(card.args)) {
      const argumentPath = `${path}.args.${argumentName}`

      if (reference.kind === 'local' && triggerDescriptor !== undefined && reference.tokenId !== null) {
        if (!publishedTokenIds.includes(reference.tokenId)) {
          problems.push({
            path: argumentPath,
            problem: `${reference.raw} reads a value from this flow's own trigger, and its trigger "${triggerDescriptor.title}" (${triggerDescriptor.id}) ${
              publishedTokenIds.length === 0
                ? 'publishes no values at all'
                : `publishes only: ${publishedTokenIds.join(', ')}`
            }. The hub stores the flow anyway, reports it as healthy, and the Homey app shows the card as "Unavailable".`,
            suggestion: `The short [[${reference.tokenId}]] form can only name a value the flow's own trigger publishes. A value from anywhere else is written [[<ownerUri>|<tokenId>]], as in [[homey:device:<id>|measure_temperature]]. Call homey_flowcard_describe on ${triggerDescriptor.id} to see what this trigger offers, or pick a trigger that publishes what you need.`,
          })
        }
        continue
      }

      if (reference.kind === 'node') {
        problems.push({
          path: argumentPath,
          problem: `${reference.raw} is an advanced-flow token: it names a node in a graph, and a standard flow has no nodes.`,
          suggestion: 'In a standard flow a value from another device is written [[homey:device:<id>|<capability>]], and a value from this flow\'s own trigger is written [[<tokenId>]].',
        })
      }

      if (reference.kind === 'unrecognised') {
        problems.push({
          path: argumentPath,
          problem: `${reference.raw} is not a token reference this Homey understands.`,
          suggestion: 'Use [[<tokenId>]] for a value from this flow\'s trigger, or [[homey:device:<id>|<capability>]] for a value from elsewhere. Note the pipe: a colon there saves fine and then shows "Unavailable".',
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Advanced flows
// ---------------------------------------------------------------------------

/**
 * Everything wrong with an advanced flow's graph.
 *
 * Beyond the per-card checks a standard flow gets, this covers the graph
 * itself: node keys the firmware will refuse, edges pointing at nodes that do
 * not exist, joins that wait for a branch nobody feeds them, and nodes nothing
 * can ever reach.
 */
export function validateAdvancedFlow(flow: CanonicalAdvancedFlow, context: ValidationContext): ValidationProblem[] {
  const problems: ValidationProblem[] = []

  if (flow.name.trim() === '') {
    problems.push({ path: 'name', problem: 'a flow needs a name.' })
  }

  if (flow.nodes.length === 0) {
    problems.push({ path: 'nodes', problem: 'the graph has no cards in it.' })
    return problems
  }

  const keys = new Set<string>()
  for (const node of flow.nodes) {
    if (keys.has(node.key)) {
      problems.push({ path: `cards.${node.key}`, problem: 'two cards share this key.' })
    }
    keys.add(node.key)

    if (!isValidNodeKey(node.key)) {
      problems.push({
        path: `cards.${node.key}`,
        problem: `"${node.key}" is not a version 4 UUID. The firmware rejects the whole flow with "should NOT have additional properties", which names the wrong thing entirely.`,
        suggestion: 'Every card key in an advanced flow must come from crypto.randomUUID().',
      })
    }

    if (!(ADVANCED_NODE_TYPES as readonly string[]).includes(node.type)) {
      problems.push({
        path: `cards.${node.key}.type`,
        problem: `"${node.type}" is not a card type this Homey understands.`,
        suggestion: `The types are: ${ADVANCED_NODE_TYPES.join(', ')}.`,
      })
    }
  }

  const triggers = flow.nodes.filter((node) => node.type === 'trigger' || node.type === 'start')
  if (triggers.length === 0) {
    problems.push({
      path: 'cards',
      problem: 'the graph has nothing that starts it: no trigger card and no start card.',
      suggestion: 'Add a trigger, or a start card if the flow is only ever launched by another flow.',
    })
  }

  for (const node of flow.nodes) {
    validateAdvancedNode(node, keys, context, problems)
  }

  validateReachability(flow, problems)

  return problems
}

function validateAdvancedNode(
  node: AdvancedNode,
  keys: ReadonlySet<string>,
  context: ValidationContext,
  problems: ValidationProblem[],
): void {
  const path = `cards.${node.key}`

  if (CARD_BEARING_NODE_TYPES.includes(node.type)) {
    if (node.cardId === undefined || node.cardId === '') {
      problems.push({ path: `${path}.id`, problem: `a ${node.type} card needs a flow card id.` })
    } else {
      const kind: FlowCardKind = node.type === 'trigger' ? 'trigger' : node.type === 'condition' ? 'condition' : 'action'
      validateCard(
        { id: node.cardId, args: node.args ?? {}, droptoken: node.droptoken ?? null },
        kind,
        path,
        context,
        problems,
      )
    }
  } else if (node.cardId !== undefined) {
    problems.push({ path: `${path}.id`, problem: `a ${node.type} card carries no flow card, so it should have no id.` })
  }

  if (node.type === 'delay' && (node.delaySeconds === null || node.delaySeconds === undefined)) {
    problems.push({ path: `${path}.delaySeconds`, problem: 'a delay card needs to know how long to wait.' })
  }

  if (node.type === 'note' && (node.value === undefined || node.value === '')) {
    problems.push({ path: `${path}.value`, problem: 'a note card with no text is invisible in the editor.' })
  }

  for (const target of outgoingTargets(node)) {
    if (!keys.has(target)) {
      problems.push({ path, problem: `this card points at "${target}", which is not a card in this flow.` })
    }
  }

  if (node.type === 'all') {
    for (const entry of node.input ?? []) {
      const sourceKey = entry.split('::')[0] ?? ''
      if (!keys.has(sourceKey)) {
        problems.push({ path: `${path}.input`, problem: `this join waits for "${entry}", and "${sourceKey}" is not a card in this flow. It would wait forever.` })
      }
    }
  }

  validateAdvancedNodeTokens(node, keys, problems)
}

/**
 * Checks that every `[[...]]` reference in an advanced flow points somewhere real.
 *
 * Both dialects are legal here: a global token still reads a device capability,
 * and a node token reads the output of an upstream card. What is not legal is a
 * node token naming a node this flow does not contain.
 */
function validateAdvancedNodeTokens(node: AdvancedNode, keys: ReadonlySet<string>, problems: ValidationProblem[]): void {
  for (const { argumentName, reference } of collectTokenReferences(node.args)) {
    const path = `cards.${node.key}.args.${argumentName}`

    if (reference.kind === 'node') {
      if (reference.nodeKey !== null && !keys.has(reference.nodeKey)) {
        problems.push({
          path,
          problem: `${reference.raw} reads a value from card ${reference.nodeKey}, which is not in this flow.`,
          suggestion: 'A node token names the key of the card that produced the value, so allocate the keys first and then fill the arguments in.',
        })
      }
      continue
    }

    if (reference.kind === 'local') {
      problems.push({
        path,
        problem: `${reference.raw} is a standard-flow token. An advanced flow has no single trigger, so a bare token id has nothing to read from.`,
        suggestion: 'Reference the card that produces the value instead: [[trigger::<card key>::<token id>]], or [[action::<card key>::<token id>]].',
      })
      continue
    }

    if (reference.kind === 'unrecognised') {
      problems.push({ path, problem: `${reference.raw} is not a token reference this Homey understands.` })
    }
  }
}

function validateReachability(flow: CanonicalAdvancedFlow, problems: ValidationProblem[]): void {
  const reached = new Set<string>()
  const byKey = new Map(flow.nodes.map((node) => [node.key, node]))

  const queue = flow.nodes.filter((node) => node.type === 'trigger' || node.type === 'start').map((node) => node.key)
  for (const key of queue) reached.add(key)

  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) continue
    const node = byKey.get(key)
    if (node === undefined) continue
    for (const target of outgoingTargets(node)) {
      if (reached.has(target)) continue
      reached.add(target)
      queue.push(target)
    }
  }

  for (const node of flow.nodes) {
    // A note is decoration and is never wired to anything, so it is not orphaned.
    if (node.type === 'note') continue
    if (reached.has(node.key)) continue
    problems.push({
      path: `cards.${node.key}`,
      problem: 'nothing can reach this card: no trigger or start card leads to it, so it will never run.',
    })
  }
}
