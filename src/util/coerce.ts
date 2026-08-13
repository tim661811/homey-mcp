// Reading untrusted JSON without pretending it is typed.
//
// Everything the hub returns arrives as `unknown`: the firmware omits fields,
// returns null where the documentation promises a number, and adds fields
// between releases. Casting that to an interface and reading straight off it
// produces a crash three call frames away from the bad value, so every wire
// field goes through one of these instead.
//
// An empty string counts as absent. The hub reports an unset name, timezone or
// language as `""` rather than omitting the key, and `""` in a result reads as
// "the answer is nothing" instead of "nothing was reported".

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** NaN and Infinity are treated as absent: neither is a measurement. */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Non-string entries are dropped rather than stringified, so a bad entry cannot masquerade as a name. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** An array is not a record here: a caller that indexes into one is reading a wire shape it did not get. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
