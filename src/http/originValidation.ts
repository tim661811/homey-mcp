// Origin checking, which the SDK does not ship.
//
// The specification's wording, and the conditional in it is the important half:
//
//   Servers MUST validate the `Origin` header on all incoming connections to
//   prevent DNS rebinding attacks. If the `Origin` header is present and
//   invalid, servers MUST respond with HTTP 403 Forbidden.
//
// An ABSENT Origin is the ordinary case, because a non-browser MCP client sends
// none, so absent has to pass. Only a present and unrecognised one is refused.
// Getting that backwards would refuse every real client while a browser page on
// some other site walked straight in.
//
// The SDK's transport does carry an `allowedOrigins` option, and it is the wrong
// thing to reach for twice over: it is marked deprecated, and it is ignored
// entirely unless `enableDnsRebindingProtection` is also set, which defaults to
// false. So a server that passed it and nothing else would look protected and be
// wide open.

import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Refuses a request whose `Origin` names something this server did not expect.
 *
 * The body is a JSON-RPC error response with a null `id`, matching what the
 * SDK's own host-header middleware answers with, so a client sees one shape for
 * both halves of the DNS rebinding defence.
 */
export function originValidation(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins)

  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin

    if (origin === undefined) {
      next()
      return
    }

    // A browser sends the literal string "null" for an opaque origin, for
    // instance a page loaded from a file. That is present-and-unknown, not
    // absent, so it is refused like any other unrecognised origin.
    if (allowed.has(origin)) {
      next()
      return
    }

    response.status(403).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Invalid Origin: ${origin}`,
      },
      id: null,
    })
  }
}
