// The shape of every tool result, and the pieces its text half is built from.
//
// A tool answers twice: `structuredContent` for the model to compute with, and a
// text block for the human reading the transcript. The text block is not a
// prettier copy of the JSON. It is the short version: what was found, named
// rather than identified by UUID, and what was left out.
//
// Only the helpers the tools actually use live here. Each tool module writes its
// own sentences, because a device list and a flow diff read nothing alike, and a
// generic formatter for both would flatten the differences that matter.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** A titled group of lines. An empty `lines` array renders nothing, heading included. */
export interface TextSection {
  heading?: string | null
  lines: string[]
}

/**
 * Joins sections into one text block, dropping empty ones.
 *
 * Blank line between sections, no trailing newline: MCP clients render the text
 * verbatim, and trailing whitespace shows up as an empty bubble.
 */
export function renderTextBlock(sections: Array<TextSection | string | null | undefined>): string {
  const rendered: string[] = []

  for (const section of sections) {
    if (section === null || section === undefined) continue

    if (typeof section === 'string') {
      if (section.trim() !== '') rendered.push(section.trimEnd())
      continue
    }

    const lines = section.lines.filter((line) => line !== '')
    if (lines.length === 0) continue

    const heading = section.heading
    rendered.push(
      heading === null || heading === undefined || heading === ''
        ? lines.join('\n')
        : `${heading}\n${lines.join('\n')}`,
    )
  }

  return rendered.join('\n\n')
}

/**
 * Renders `label: value` lines with the labels padded to a common width, so a
 * block of facts scans as a column rather than as prose.
 */
export function renderKeyValueLines(entries: Array<[string, unknown]>): string[] {
  const shown = entries.filter(([, value]) => value !== undefined)
  if (shown.length === 0) return []

  const labelWidth = Math.max(...shown.map(([label]) => label.length))
  return shown.map(([label, value]) => `  ${label.padEnd(labelWidth)}  ${formatValue(value)}`)
}

/** One value, formatted the way a human reads it. Null and undefined are shown, never hidden. */
export function formatValue(value: unknown): string {
  if (value === null) return 'unknown'
  if (value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join(', ')
  return JSON.stringify(value) ?? String(value)
}

/** Trims the float noise a hub's own arithmetic leaves behind, without rounding away real precision. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'unknown'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(3)))
}

export interface ToolResultOptions {
  /** The human-readable block. Rendered as the result's only text content. */
  text: string
  /** The machine-readable answer. Must match the tool's declared output schema. */
  structuredContent: Record<string, unknown>
}

/**
 * Builds a successful tool result carrying both halves.
 *
 * Every tool in this server returns through here, so no tool can accidentally
 * ship structured content with no text or the other way round.
 */
export function toolResult(options: ToolResultOptions): CallToolResult {
  return {
    content: [{ type: 'text', text: options.text }],
    structuredContent: options.structuredContent,
  }
}

/**
 * The successful result every tool returns.
 *
 * `ok: true` leads the structured half so that success and failure can be told
 * apart by one field. A failure result carries `ok: false` (see server/errors.ts),
 * and a model that has to infer which it got from the presence of some other key
 * will eventually infer wrong.
 */
export function successResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return toolResult({ text, structuredContent: { ok: true, ...structuredContent } })
}
