// The redactor is applied to every log line, every error message and every tool
// result, so a rule that is too eager damages the server's own prose rather than
// leaking anything. That failure is silent: a sentence only comes out mangled
// once something has already gone wrong and the message is finally printed.
//
// So this walks every string literal this server can emit and asserts the
// redactor leaves it exactly as written. It found four sentences that no test
// had ever printed, and it is here so the fifth cannot ship either.
//
// A literal that genuinely has to carry a credential-shaped example belongs in a
// comment or a fixture rather than in a string this file will read.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { redactString } from './redact.js'

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))

interface StringLiteral {
  value: string
  line: number
}

describe('the redactor against the prose this server ships', () => {
  it('leaves every string literal in src/ exactly as it was written', () => {
    const damaged: string[] = []

    for (const file of collectSourceFiles(SOURCE_ROOT)) {
      for (const literal of extractStringLiterals(readFileSync(file, 'utf8'))) {
        const redacted = redactString(literal.value)
        if (redacted === literal.value) continue
        damaged.push(
          `${file.slice(SOURCE_ROOT.length)}:${literal.line}\n  written:  ${literal.value}\n  redacted: ${redacted}`,
        )
      }
    }

    expect(
      damaged.join('\n\n'),
      'The redactor rewrites these literals, so a user would read the mangled version. Fix the rule in redact.ts rather than rewording the sentence.',
    ).toBe('')
  })

  it('reads the literals it is meant to read', () => {
    // Guards the walker itself: a scanner that silently found nothing would let
    // every sentence above through while reporting success.
    const literals = extractStringLiterals(
      [
        'const greeting = "hello"',
        "const path = 'src/util' // 'not a literal'",
        '/* "not a literal either" */',
        'const pattern = /"[a-z]+"/g',
        'const message = `first ${variable} second`',
        'const escaped = "a \\" quote"',
      ].join('\n'),
    ).map((literal) => literal.value)

    expect(literals).toEqual(['hello', 'src/util', 'first ', ' second', 'a " quote'])
  })
})

function collectSourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...collectSourceFiles(path))
      continue
    }
    // Test files are excluded on purpose: they carry fabricated credentials that
    // the redactor is supposed to mask.
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path)
  }
  return found.sort()
}

/**
 * The characters after which a `/` opens a regular expression rather than
 * dividing. Enough to tell the two apart in this codebase, which is all a test
 * scanner needs: getting it wrong on a division would only mean skipping to the
 * next quote, never a false pass, because a missed literal cannot report damage.
 */
const REGEX_MAY_FOLLOW = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
])

/**
 * Every string, template chunk and escaped literal in a TypeScript file, with
 * comments and regular expressions skipped.
 *
 * Hand written rather than taken from the compiler: this project builds with
 * TypeScript 7, whose npm package exposes the native compiler rather than the
 * JavaScript API that could parse this for us.
 *
 * Each static chunk of a template literal is reported on its own, since an
 * interpolation breaks any run the redactor could match across it anyway.
 */
export function extractStringLiterals(source: string): StringLiteral[] {
  const literals: StringLiteral[] = []
  let index = 0
  let line = 1
  let lastSignificantCharacter = ''

  const record = (value: string, startLine: number): void => {
    if (value !== '') literals.push({ value, line: startLine })
  }

  /** Reads a quoted run and returns its contents with the escapes resolved. */
  const readQuoted = (quote: string): string => {
    let value = ''
    index += 1
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') {
        value += resolveEscape(source[index + 1])
        index += 2
        continue
      }
      if (source[index] === '\n') line += 1
      value += source[index]
      index += 1
    }
    index += 1
    return value
  }

  while (index < source.length) {
    const character = source[index]

    if (character === '\n') {
      line += 1
      index += 1
      continue
    }

    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (character === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }

    if (character === '/' && (lastSignificantCharacter === '' || REGEX_MAY_FOLLOW.has(lastSignificantCharacter))) {
      index += 1
      let insideCharacterClass = false
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') {
          index += 2
          continue
        }
        if (inner === '\n') break
        if (inner === '[') insideCharacterClass = true
        else if (inner === ']') insideCharacterClass = false
        else if (inner === '/' && !insideCharacterClass) break
        index += 1
      }
      index += 1
      while (index < source.length && /[a-z]/.test(source[index] ?? '')) index += 1
      lastSignificantCharacter = '/'
      continue
    }

    if (character === "'" || character === '"') {
      const startLine = line
      record(readQuoted(character), startLine)
      lastSignificantCharacter = character
      continue
    }

    if (character === '`') {
      index += 1
      let value = ''
      let startLine = line

      while (index < source.length) {
        if (source[index] === '\\') {
          value += resolveEscape(source[index + 1])
          index += 2
          continue
        }

        if (source[index] === '`') {
          index += 1
          break
        }

        if (source[index] === '$' && source[index + 1] === '{') {
          record(value, startLine)
          value = ''
          index += 2

          // Walk the interpolation on a brace counter, reading any string inside
          // it as a literal in its own right.
          let depth = 1
          while (index < source.length && depth > 0) {
            const inner = source[index]
            if (inner === '\n') line += 1
            else if (inner === '{') depth += 1
            else if (inner === '}') depth -= 1
            else if (inner === "'" || inner === '"' || inner === '`') {
              const startOfNested = line
              record(readQuoted(inner), startOfNested)
              continue
            }
            index += 1
          }

          startLine = line
          continue
        }

        if (source[index] === '\n') line += 1
        value += source[index]
        index += 1
      }

      record(value, startLine)
      lastSignificantCharacter = '`'
      continue
    }

    if (!/\s/.test(character ?? '')) lastSignificantCharacter = character ?? ''
    index += 1
  }

  return literals
}

function resolveEscape(character: string | undefined): string {
  if (character === 'n') return '\n'
  if (character === 't') return '\t'
  if (character === 'r') return '\r'
  return character ?? ''
}
