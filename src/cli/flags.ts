// Reading and checking a subcommand's argument list.
//
// One home for one rule. `serve` and `doctor` both take `--config <path>`, and
// both used to carry a byte-for-byte copy of the reader below, which is two
// places for a later change to "--config=<path>" or to quoting to land in only
// one of.
//
// The checking half exists because the reader alone is silent about anything it
// does not recognise, and one of those silences is a privacy trap. `doctor
// --repot` ran the full terminal report, which carries LAN addresses, the Athom
// cloud id and filesystem paths, at the exact moment the user believed they had
// asked for the scrubbed report they were about to paste into a public issue.
// Nothing in the output said the flag had been ignored. So an unrecognised
// option is refused, and a near miss is answered with the flag that was meant.
//
// The tables live here rather than beside each subcommand because `src/index.ts`
// checks the arguments before it loads the subcommand module: the check has to
// cover `setup` as well, and `--version` and `--help` must keep costing nothing
// to answer.

/**
 * Returns the value that follows `flag`, or null when the flag is absent or
 * carries no value.
 *
 * A following token that itself starts with a dash counts as no value rather
 * than as the value. `doctor --config --json` means someone forgot the path, and
 * silently reading a credentials file called "--json" would report a missing
 * credential instead of the typo that caused it. `checkFlags` refuses that
 * combination outright, so by the time a subcommand reads a value here the value
 * is known to be there.
 */
export function readFlagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  const value = argv[index + 1]
  return value === undefined || value.startsWith('-') ? null : value
}

/** One accepted option, in the words the help text uses for it. */
export interface FlagSpec {
  /** The long spelling, leading dashes included. */
  name: string
  /** Other accepted spellings, leading dashes included. */
  aliases?: string[]
  /** True when a separate value token follows, as in `--config <path>`. */
  takesValue?: boolean
  /** What the value is called in the usage line, for example `path` or `level`. */
  valueName?: string
  /**
   * True when the value has to be a whole number.
   *
   * `readFlagValue` only guarantees a token that does not start with a dash, so
   * without this `--port eight` becomes `NaN` and the server binds nothing while
   * reporting no problem at all.
   */
  valueIsWholeNumber?: boolean
  /**
   * The range a whole-number value has to fall in, both ends included.
   *
   * `valueIsWholeNumber` alone lets `--port 0` through, and 0 is the one number
   * that fails in a way nothing reports: `listen(0)` asks the kernel for an
   * ephemeral port, so the server binds something random while every URL it
   * advertises, every token audience and the client entry itself say port 0.
   * Written into a service unit with Restart=always it picks a different random
   * port on every restart. That is the "the port must never fall back" rule
   * reached from a direction the EADDRINUSE guard does not cover.
   */
  valueRange?: { minimum: number; maximum: number }
  /** One line, phrased for someone reading it inside a rejection message. */
  description: string
}

/**
 * `--help` is accepted by every subcommand.
 *
 * `homey-mcp doctor --help` used to run the whole doctor, because only the first
 * argument was ever looked at for help. Asking for help and getting a report of
 * your home instead is the same silence this module exists to end, so help is
 * part of every table and `src/index.ts` answers it before dispatching.
 */
export const HELP_FLAG: FlagSpec = {
  name: '--help',
  aliases: ['-h'],
  description: 'print the usage and exit',
}

const CONFIG_FLAG: FlagSpec = {
  name: '--config',
  takesValue: true,
  valueName: 'path',
  description: 'read credentials from this file instead of the usual places',
}

const HTTP_FLAG: FlagSpec = {
  name: '--http',
  description: 'the loopback HTTP mode, where your assistant signs in through your browser',
}

const PORT_FLAG: FlagSpec = {
  name: '--port',
  takesValue: true,
  valueName: 'number',
  valueIsWholeNumber: true,
  valueRange: { minimum: 1, maximum: 65_535 },
  description: 'the port the HTTP mode listens on (default 8431)',
}

export const SERVE_FLAGS: FlagSpec[] = [
  CONFIG_FLAG,
  {
    name: '--log-level',
    takesValue: true,
    valueName: 'level',
    description: 'silent, error, warn, info (default) or debug',
  },
  HTTP_FLAG,
  PORT_FLAG,
  HELP_FLAG,
]

export const SETUP_FLAGS: FlagSpec[] = [
  {
    name: '--yes',
    aliases: ['-y'],
    description: 'answer yes to the offers to install and sign in, for an unattended run',
  },
  HTTP_FLAG,
  PORT_FLAG,
  HELP_FLAG,
]

export const SERVICE_FLAGS: FlagSpec[] = [
  PORT_FLAG,
  {
    name: '--yes',
    aliases: ['-y'],
    description: 'answer yes to writing or removing the service file, for an unattended run',
  },
  HELP_FLAG,
]

export const DOCTOR_FLAGS: FlagSpec[] = [
  { name: '--json', description: 'the same report as JSON, scrubbed too when --report is given as well' },
  { name: '--report', description: 'a scrubbed version to paste into a bug report' },
  {
    name: '--quick',
    description: 'skip the counts and the memory reading, which cost one request each',
  },
  CONFIG_FLAG,
  HTTP_FLAG,
  // Taken here too, and not as a nicety: without it `doctor --http` could only
  // ever probe 8431, so the one command that says which of four things is wrong
  // could not be aimed at the installation `portInUseMessage` tells the user to
  // create. It reported "nothing is listening on 8431" about a healthy server.
  PORT_FLAG,
  HELP_FLAG,
]

/**
 * Checks an argument list against the options a subcommand accepts.
 *
 * Returns the message to print, or null when every argument was recognised. The
 * message is the whole answer: what was not understood, the closest option when
 * there is one, and every option that does exist. A caller prints it to stderr
 * and exits non-zero.
 *
 * `commandName` is the command as the user typed it, for example
 * "homey-mcp doctor", so the message names the thing they ran.
 */
export function checkFlags(argv: string[], specs: FlagSpec[], commandName: string): string | null {
  const bySpelling = new Map<string, FlagSpec>()
  for (const spec of specs) {
    bySpelling.set(spec.name, spec)
    for (const alias of spec.aliases ?? []) bySpelling.set(alias, spec)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''

    if (!token.startsWith('-')) {
      return [
        `"${token}" is not something "${commandName}" takes.`,
        '',
        ...describeOptions(commandName, specs),
      ].join('\n')
    }

    // `--config=<path>` is a spelling this CLI does not read: the value would be
    // dropped and the default credentials used instead, which is the silent
    // wrong answer rather than an error. Named separately from an unknown flag
    // because the fix is a space, not a different flag.
    const equalsPosition = token.indexOf('=')
    if (equalsPosition !== -1) {
      const spelling = token.slice(0, equalsPosition)
      const spec = bySpelling.get(spelling)
      if (spec !== undefined) {
        return [
          `"${commandName}" expects "${spec.name} ${spec.valueName ?? 'value'}" with a space, not "${spelling}=".`,
          '',
          `Run it as: ${commandName} ${spec.name} ${token.slice(equalsPosition + 1)}`,
        ].join('\n')
      }
      return unknownOption(spelling, commandName, specs)
    }

    const spec = bySpelling.get(token)
    if (spec === undefined) return unknownOption(token, commandName, specs)

    if (spec.takesValue === true) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        return [
          `"${spec.name}" needs ${aOrAn(spec.valueName ?? 'value')} after it, and nothing usable followed it.`,
          '',
          `Run it as: ${commandName} ${spec.name} <${spec.valueName ?? 'value'}>`,
        ].join('\n')
      }
      if (spec.valueIsWholeNumber === true && !/^\d+$/.test(value)) {
        return [
          `"${spec.name}" needs a whole number after it, and "${value}" is not one.`,
          '',
          `Run it as: ${commandName} ${spec.name} 8431`,
        ].join('\n')
      }
      const range = spec.valueRange
      if (range !== undefined && spec.valueIsWholeNumber === true) {
        const numeric = Number.parseInt(value, 10)
        if (numeric < range.minimum || numeric > range.maximum) {
          return [
            `"${spec.name} ${value}" is outside the range ${range.minimum} to ${range.maximum}.`,
            ...(numeric === 0
              ? [
                  '',
                  '0 asks the operating system to pick any free port. The port is part of the address',
                  'your assistant stores, so a server that bound a different port on every start would',
                  'be running and unreachable, which reads as ConnectionRefused with no explanation.',
                ]
              : []),
            '',
            `Run it as: ${commandName} ${spec.name} 8431`,
          ].join('\n')
        }
      }

      // Skipped so a value that happens to look like a word is not read as an
      // unexpected argument on the next pass.
      index += 1
    }
  }

  return null
}

function unknownOption(spelling: string, commandName: string, specs: FlagSpec[]): string {
  const closest = closestSpelling(spelling, specs)
  return [
    `"${spelling}" is not an option of "${commandName}".`,
    ...(closest === null ? [] : ['', `Did you mean "${closest}"?`]),
    '',
    ...describeOptions(commandName, specs),
  ].join('\n')
}

function describeOptions(commandName: string, specs: FlagSpec[]): string[] {
  const usages = specs.map((spec) => {
    const spellings = [spec.name, ...(spec.aliases ?? [])].join(', ')
    return spec.takesValue === true ? `${spellings} <${spec.valueName ?? 'value'}>` : spellings
  })
  const width = Math.max(...usages.map((usage) => usage.length))

  return [
    `What "${commandName}" takes:`,
    ...specs.map((spec, position) => `  ${(usages[position] ?? '').padEnd(width)}  ${spec.description}`),
  ]
}

/**
 * The spelling the user most likely meant, or null when nothing is close.
 *
 * A near miss is the case that matters here: "--repot" for "--report" is one
 * missing letter away from running the unscrubbed report. Three edits is the
 * cut-off, which reaches every single-character slip, transposition and dropped
 * letter without offering "--json" to somebody who typed "--quick".
 */
function closestSpelling(spelling: string, specs: FlagSpec[]): string | null {
  const candidates = specs.flatMap((spec) => [spec.name, ...(spec.aliases ?? [])])
  const wanted = spelling.toLowerCase()

  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  return bestDistance <= 3 ? best : null
}

/** Levenshtein distance, iterative and allocation-light. Used only on flag-sized strings. */
function editDistance(first: string, second: string): number {
  const previousRow: number[] = Array.from({ length: second.length + 1 }, (_unused, column) => column)

  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    let diagonal = previousRow[0] ?? 0
    previousRow[0] = firstIndex

    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const previousDiagonal = previousRow[secondIndex] ?? 0
      const substitutionCost = first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1
      previousRow[secondIndex] = Math.min(
        (previousRow[secondIndex] ?? 0) + 1,
        (previousRow[secondIndex - 1] ?? 0) + 1,
        diagonal + substitutionCost,
      )
      diagonal = previousDiagonal
    }
  }

  return previousRow[second.length] ?? 0
}

function aOrAn(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`
}
