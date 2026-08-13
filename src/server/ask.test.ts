import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'

import { buildRequestedSchema, createAskFunction, isElicitationSupported, pendingQuestionResult } from './ask.js'
import type { AskOptions, AskResult } from './context.js'

const QUESTION: AskOptions = {
  question: 'Which light did you mean?',
  choices: [
    { value: 'device-hallway', label: 'Hallway lamp', description: 'Hallway' },
    { value: 'device-porch', label: 'Porch lamp', description: 'Front garden' },
  ],
}

interface Harness {
  client: Client
  askResults: AskResult[]
}

/**
 * Links a client and a server through the in-memory transport pair, with one
 * tool that does nothing but ask the question and report what came back.
 *
 * `elicitationHandler` being undefined is the case that matters most: it means a
 * client that never declared elicitation support, which is what several MCP
 * clients in the wild still are.
 */
async function connectHarness(
  elicitationHandler?: (message: string) => ElicitResult,
): Promise<Harness> {
  const server = new McpServer({ name: 'homey-mcp-test', version: '0.0.0-test' })
  const askResults: AskResult[] = []
  const ask = createAskFunction({ server })

  server.registerTool(
    'homey_devices_search',
    {
      description: 'Asks which device was meant.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const result = await ask(QUESTION)
      askResults.push(result)
      if (!result.answered) {
        return pendingQuestionResult(QUESTION, result, {
          canAsk: isElicitationSupported(server),
          toolName: 'homey_devices_search',
        })
      }
      return {
        content: [{ type: 'text', text: `Chose ${result.value}` }],
        structuredContent: { ok: true, deviceId: result.value },
      }
    },
  )

  const client = new Client(
    { name: 'test-client', version: '0.0.0-test' },
    { capabilities: elicitationHandler === undefined ? {} : { elicitation: {} } },
  )

  if (elicitationHandler !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      const parameters = request.params
      return elicitationHandler('message' in parameters ? parameters.message : '')
    })
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  return { client, askResults }
}

describe('the ask choke point', () => {
  it('hands the question back as structured data when the client cannot ask', async () => {
    const { client, askResults } = await connectHarness()

    const result = await client.callTool({ name: 'homey_devices_search', arguments: {} })

    expect(result.isError).toBe(true)

    const structured = result.structuredContent as {
      ok: boolean
      needsUserInput: { question: string; reason: string; choices: Array<{ value: string; label: string }> }
    }
    expect(structured.ok).toBe(false)
    expect(structured.needsUserInput.question).toBe(QUESTION.question)
    expect(structured.needsUserInput.reason).toBe('client_cannot_ask')
    expect(structured.needsUserInput.choices.map((choice) => choice.value)).toEqual([
      'device-hallway',
      'device-porch',
    ])

    // The whole point: nothing was answered, and in particular the first
    // plausible candidate was not quietly adopted as the answer.
    expect(askResults).toEqual([{ answered: false, value: null, declined: false }])
    expect(JSON.stringify(result.content)).toContain('Do not choose on their behalf')
  })

  it('uses the answer when the client can ask', async () => {
    const { client, askResults } = await connectHarness(() => ({
      action: 'accept',
      content: { answer: 'device-porch' },
    }))

    const result = await client.callTool({ name: 'homey_devices_search', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ ok: true, deviceId: 'device-porch' })
    expect(askResults).toEqual([{ answered: true, value: 'device-porch', declined: false }])
  })

  it('reports a decline as a decline rather than as an answer', async () => {
    const { client, askResults } = await connectHarness(() => ({ action: 'decline' }))

    const result = await client.callTool({ name: 'homey_devices_search', arguments: {} })

    expect(result.isError).toBe(true)
    expect(askResults).toEqual([{ answered: false, value: null, declined: true }])
    expect((result.structuredContent as { needsUserInput: { reason: string } }).needsUserInput.reason).toBe(
      'declined',
    )
  })

  it('treats an accepted but empty form as unanswered', async () => {
    const { client, askResults } = await connectHarness(() => ({ action: 'accept', content: {} }))

    const result = await client.callTool({ name: 'homey_devices_search', arguments: {} })

    expect(result.isError).toBe(true)
    expect(askResults).toEqual([{ answered: false, value: null, declined: false }])
  })
})

describe('buildRequestedSchema', () => {
  it('turns choices into a titled single-select', () => {
    const schema = buildRequestedSchema(QUESTION)

    expect(schema.required).toEqual(['answer'])
    const field = schema.properties['answer']
    expect(field).toBeDefined()
    expect(field && 'oneOf' in field ? field.oneOf : []).toEqual([
      { const: 'device-hallway', title: 'Hallway lamp (Hallway)' },
      { const: 'device-porch', title: 'Porch lamp (Front garden)' },
    ])
  })

  it('adds a separate free text field rather than a sentinel choice', () => {
    const schema = buildRequestedSchema({ ...QUESTION, allowFreeText: true })

    expect(Object.keys(schema.properties)).toEqual(['answer', 'otherAnswer'])
    // Neither is required: an empty submission must be reported as unanswered,
    // not as an empty answer.
    expect(schema.required).toBeUndefined()
  })

  it('asks for plain text when there are no choices', () => {
    const schema = buildRequestedSchema({ question: 'What should the flow be called?' })

    expect(schema.properties['answer']).toEqual({
      type: 'string',
      title: 'Answer',
      description: 'What should the flow be called?',
    })
  })
})
