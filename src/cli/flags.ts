// Reading option values off a subcommand's argument list.
//
// One home for one rule. `serve` and `doctor` both take `--config <path>`, and
// both used to carry a byte-for-byte copy of this function, which is two places
// for a later change to "--config=<path>" or to quoting to land in only one of.

/**
 * Returns the value that follows `flag`, or null when the flag is absent or
 * carries no value.
 *
 * A following token that itself starts with a dash counts as no value rather
 * than as the value. `doctor --config --json` means someone forgot the path, and
 * silently reading a credentials file called "--json" would report a missing
 * credential instead of the typo that caused it.
 */
export function readFlagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  const value = argv[index + 1]
  return value === undefined || value.startsWith('-') ? null : value
}
