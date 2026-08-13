// Filling in what the Homey app's editor fills in, and coercing argument values
// to the types the card declares.
//
// The firmware validates argument VALUES against a card's schema but barely
// validates structure, so a flow that omits `group` saves happily and then
// crashes the web editor's renderer. Everything the editor always writes is
// written here too, so an API-built flow is indistinguishable from a hand-built
// one.
//
// Coercion is deliberately conservative: a value that cannot be brought to the
// declared type is left alone and reported as a problem, never replaced with a
// plausible default. Substituting a guess for, say, a dimmer level is exactly
// the class of mistake that ends with the wrong thing happening in someone's
// house.

import type { FlowCardDescriptor, FlowCardArgumentDescriptor, FlowCardLookup } from '../homey/types.js'
import type { CanonicalCard, CanonicalFlow } from './model.js'
import { DEFAULT_ACTION_GROUP, DEFAULT_CONDITION_GROUP } from './model.js'

export interface NormalisationProblem {
  path: string
  problem: string
  suggestion?: string
}

export interface NormalisationResult {
  flow: CanonicalFlow
  problems: NormalisationProblem[]
}

/**
 * Applies every default the Homey editor applies.
 *
 * These are structural requirements of the format, not stand-ins for a value
 * the caller meant to supply: a condition belongs to a group and an action
 * belongs to the `then` branch unless told otherwise, and `args` is an object
 * even when the card takes none.
 */
export function normaliseFlow(flow: CanonicalFlow, cards?: FlowCardLookup): NormalisationResult {
  const problems: NormalisationProblem[] = []

  const normalised: CanonicalFlow = {
    name: flow.name.trim(),
    trigger: normaliseCard(flow.trigger, 'trigger', 'trigger', cards, problems),
    conditions: flow.conditions.map((condition, index) =>
      normaliseCard(condition, 'condition', `conditions[${index}]`, cards, problems),
    ),
    actions: flow.actions.map((action, index) => normaliseCard(action, 'action', `actions[${index}]`, cards, problems)),
  }

  if (flow.enabled !== undefined) normalised.enabled = flow.enabled
  if (flow.folder !== undefined) normalised.folder = flow.folder

  return { flow: normalised, problems }
}

/** Normalises one card: defaults its group, its `inverted` flag and its argument container. */
export function normaliseCard(
  card: CanonicalCard,
  role: 'trigger' | 'condition' | 'action',
  path: string,
  cards: FlowCardLookup | undefined,
  problems: NormalisationProblem[],
): CanonicalCard {
  // Looked up by role as well as by id: the same id can name a card of another
  // kind, and coercing a trigger's arguments against an action's schema would
  // rewrite values that were already right.
  const descriptor = cards?.get(role, card.id)

  const normalised: CanonicalCard = {
    id: card.id.trim(),
    args: coerceArguments(card.args ?? {}, descriptor, path, problems),
  }

  if (typeof card.droptoken === 'string' && card.droptoken !== '') {
    normalised.droptoken = card.droptoken
  }

  if (role === 'condition') {
    normalised.group = card.group ?? DEFAULT_CONDITION_GROUP
    normalised.inverted = card.inverted === true
  }

  if (role === 'action') {
    normalised.group = card.group ?? DEFAULT_ACTION_GROUP
    if (card.delay !== undefined) normalised.delay = card.delay
    if (card.duration !== undefined) normalised.duration = card.duration
  }

  return normalised
}

/** Coerces every supplied argument to the type its descriptor declares. Unknown arguments pass through untouched. */
export function coerceArguments(
  args: Record<string, unknown>,
  descriptor: FlowCardDescriptor | undefined,
  path: string,
  problems: NormalisationProblem[],
): Record<string, unknown> {
  const coerced: Record<string, unknown> = {}

  for (const [argumentName, value] of Object.entries(args)) {
    const argumentDescriptor = descriptor?.args.find((entry) => entry.name === argumentName)
    if (argumentDescriptor === undefined) {
      coerced[argumentName] = value
      continue
    }
    coerced[argumentName] = coerceArgumentValue(argumentDescriptor, value, `${path}.args.${argumentName}`, problems)
  }

  return coerced
}

/**
 * Brings one argument value to its declared type.
 *
 * The mapping follows the Homey apps SDK argument types. `autocomplete` and
 * `device` are pointedly NOT coerced from a string: the stored value has to be
 * the whole object the hub's autocomplete endpoint returned, because cards keep
 * app-specific fields alongside the id, and inventing `{id, name}` from a name
 * loses them.
 */
export function coerceArgumentValue(
  descriptor: FlowCardArgumentDescriptor,
  value: unknown,
  path: string,
  problems: NormalisationProblem[],
): unknown {
  switch (descriptor.type) {
    case 'number':
    case 'range': {
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
      }
      problems.push({
        path,
        problem: `argument "${descriptor.name}" is declared as ${descriptor.type} and needs a JSON number, not ${describeType(value)}.`,
        ...(descriptor.type === 'range'
          ? { suggestion: 'A range is a fraction of its own scale, so half brightness is 0.5 rather than 50.' }
          : {}),
      })
      return value
    }

    case 'checkbox': {
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      problems.push({ path, problem: `argument "${descriptor.name}" is a checkbox and needs true or false, not ${describeType(value)}.` })
      return value
    }

    case 'dropdown': {
      if (typeof value !== 'string') {
        problems.push({ path, problem: `argument "${descriptor.name}" is a dropdown and needs one of its option ids as a string.` })
        return value
      }
      if (descriptor.values.length > 0 && !descriptor.values.some((option) => option.id === value)) {
        const byTitle = descriptor.values.find((option) => option.title.toLowerCase() === value.toLowerCase())
        if (byTitle !== undefined) {
          // The visible label was sent instead of the id. Correcting it is safe
          // because the option was matched exactly, and it is by far the most
          // common way a model fills a dropdown.
          return byTitle.id
        }
        problems.push({
          path,
          problem: `argument "${descriptor.name}" does not accept "${value}".`,
          suggestion: `Allowed ids: ${descriptor.values.map((option) => `${option.id} (${option.title})`).join(', ')}.`,
        })
      }
      return value
    }

    case 'multiselect': {
      if (!Array.isArray(value)) {
        problems.push({ path, problem: `argument "${descriptor.name}" is a multiselect and needs an array of option ids.` })
        return value
      }
      return value
    }

    case 'autocomplete':
    case 'device': {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
      problems.push({
        path,
        problem: `argument "${descriptor.name}" is a ${descriptor.type} argument and stores the whole object the hub returned, not ${describeType(value)}.`,
        suggestion: 'Call homey_flowcard_autocomplete for this argument and store the chosen result object verbatim, including any extra fields the app added.',
      })
      return value
    }

    default:
      return value
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `the string "${value}"`
  return `a ${typeof value}`
}

/** Every argument the descriptor marks as required and the card did not supply. */
export function missingRequiredArguments(card: CanonicalCard, descriptor: FlowCardDescriptor): string[] {
  const supplied = new Set(Object.keys(card.args ?? {}))
  return descriptor.args.filter((argument) => argument.required && !supplied.has(argument.name)).map((argument) => argument.name)
}

/** Every argument the card supplied that the descriptor does not declare. */
export function unknownArguments(card: CanonicalCard, descriptor: FlowCardDescriptor): string[] {
  const declared = new Set(descriptor.args.map((argument) => argument.name))
  return Object.keys(card.args ?? {}).filter((argumentName) => !declared.has(argumentName))
}
