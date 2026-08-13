// A machine that does not exist, for tests that would otherwise install
// software, start a browser or depend on whatever the machine running the suite
// happens to have on it.
//
// Both the module that finds and drives the Homey CLI and the setup walk that
// uses it take the same two seams, so this file serves both and neither test
// has to reinvent them. Nothing here touches the real filesystem or spawns a
// real process: `findHomeyCli` on a contributor's laptop would otherwise answer
// differently depending on whether they had ever run `npx homey`.

import type { CommandRequest, HomeyCliFileSystem, HomeyCliRunResult } from '../../src/homey/homey-cli.js'

export interface FakeTree {
  /** Absolute path to file contents. */
  files: Record<string, string>
  /** Absolute paths that answer to an execute-bit check. */
  executables?: string[]
  /** Absolute path to what it really points at, which is how npm's bin shims are laid out. */
  symlinks?: Record<string, string>
}

export function fakeFileSystem(tree: FakeTree): HomeyCliFileSystem {
  const executables = new Set(tree.executables ?? [])
  const symlinks = tree.symlinks ?? {}

  return {
    async isFile(path) {
      return Object.hasOwn(tree.files, path)
    },
    async isExecutable(path) {
      return executables.has(path)
    },
    async listDirectory(path) {
      const prefix = `${path}/`
      const entries = new Set<string>()
      for (const candidate of Object.keys(tree.files)) {
        if (!candidate.startsWith(prefix)) continue
        const first = candidate.slice(prefix.length).split('/')[0]
        if (first !== undefined && first !== '') entries.add(first)
      }
      // A directory with nothing in it does not exist as far as this fake is
      // concerned, which is what a real readdir of a missing path does too.
      if (entries.size === 0) throw new Error(`no such directory: ${path}`)
      return [...entries]
    },
    async readJson(path) {
      const contents = tree.files[path]
      if (contents === undefined) throw new Error(`no such file: ${path}`)
      return JSON.parse(contents) as unknown
    },
    async resolveRealPath(path) {
      return symlinks[path] ?? path
    },
  }
}

/** A `homey` package manifest, the thing a search actually recognises. */
export function homeyCliManifest(version: string): string {
  return JSON.stringify({ name: 'homey', version, bin: { homey: 'bin/homey.mjs' } })
}

export interface FakeRunner {
  run: (request: CommandRequest) => Promise<HomeyCliRunResult>
  /** Every request in the order it was made, so a test can assert what was and was not run. */
  requests: CommandRequest[]
}

/**
 * Records every command instead of spawning it.
 *
 * `answers` is either one reply per call in order, or a function that decides
 * from the request. Anything left unspecified defaults to a clean exit, because
 * most tests care about one call in a chain of five.
 */
export function fakeRunner(
  answers: Array<Partial<HomeyCliRunResult>> | ((request: CommandRequest) => Partial<HomeyCliRunResult>),
): FakeRunner {
  const requests: CommandRequest[] = []
  let index = 0

  return {
    requests,
    async run(request) {
      requests.push(request)
      const answer = typeof answers === 'function' ? answers(request) : (answers[index] ?? {})
      index += 1
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        message: 'ok',
        ...answer,
      }
    },
  }
}
