// The one Node floor, in one place.
//
// Three subcommands care about it and each says something different about it:
// the entry point refuses to load anything else, `doctor` reports it as a check,
// and `setup` names it as the first step it walked through. That is three copies
// of the number waiting to disagree, so the number lives here.
//
// `src/index.ts` deliberately keeps its own copy anyway. Nothing may be imported
// above its version check, because on an old Node an import can fail on syntax
// a dependency uses, and the user then reads a parser error instead of the one
// sentence that explains the problem.

/** The minimum Node this package runs on. `homey-api` declares the same floor. */
export const MINIMUM_NODE_MAJOR_VERSION = 24

export interface NodeVersionVerdict {
  satisfied: boolean
  version: string
  major: number | null
  /** Where this Node came from. Diagnoses "the wrong Node is on PATH", and carries an account name, so never share it. */
  executablePath: string
}

/** Whether the Node running this process is new enough, and the facts a message needs. */
export function checkNodeVersion(): NodeVersionVerdict {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  return {
    satisfied: !Number.isNaN(major) && major >= MINIMUM_NODE_MAJOR_VERSION,
    version: process.versions.node,
    major: Number.isNaN(major) ? null : major,
    executablePath: process.execPath,
  }
}
