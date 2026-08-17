import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import { originValidation } from './originValidation.js'

const ALLOWED = ['http://127.0.0.1:8431', 'http://localhost:8431']

interface CapturedResponse {
  response: Response
  status: number | null
  body: unknown
}

function captureResponse(): CapturedResponse {
  const captured: CapturedResponse = { response: undefined as unknown as Response, status: null, body: undefined }
  captured.response = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(body: unknown) {
      captured.body = body
      return this
    },
  } as unknown as Response
  return captured
}

function requestWithOrigin(origin?: string): Request {
  return { headers: origin === undefined ? {} : { origin } } as unknown as Request
}

describe('originValidation', () => {
  it('passes a request with no Origin at all', () => {
    // The ordinary case: a non-browser MCP client sends none. Refusing it would
    // block every real client while a page on another site walked straight in.
    const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[] } }
    const captured = captureResponse()

    originValidation(ALLOWED)(requestWithOrigin(), captured.response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(captured.status).toBeNull()
  })

  it('passes a request whose Origin is one this server serves', () => {
    const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[] } }
    const captured = captureResponse()

    originValidation(ALLOWED)(requestWithOrigin('http://localhost:8431'), captured.response, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('refuses a present but unknown Origin with 403 and a JSON-RPC body with no id', () => {
    const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[] } }
    const captured = captureResponse()

    originValidation(ALLOWED)(requestWithOrigin('https://evil.example'), captured.response, next)

    expect(next).not.toHaveBeenCalled()
    expect(captured.status).toBe(403)
    expect(captured.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Origin: https://evil.example' },
      id: null,
    })
  })

  it('refuses the opaque origin a file-loaded page sends', () => {
    // A browser sends the literal string "null" there. That is present and
    // unknown, not absent.
    const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[] } }
    const captured = captureResponse()

    originValidation(ALLOWED)(requestWithOrigin('null'), captured.response, next)

    expect(next).not.toHaveBeenCalled()
    expect(captured.status).toBe(403)
  })

  it('refuses the right host on the wrong port, because that is a different origin', () => {
    const next = vi.fn() as unknown as NextFunction & { mock: { calls: unknown[] } }
    const captured = captureResponse()

    originValidation(ALLOWED)(requestWithOrigin('http://127.0.0.1:9999'), captured.response, next)

    expect(captured.status).toBe(403)
  })
})
