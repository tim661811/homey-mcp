import { describe, expect, it } from 'vitest'

import { createHttpEndpointConfig, DEFAULT_HTTP_PORT, portInUseMessage } from './config.js'

describe('createHttpEndpointConfig', () => {
  it('derives every spelling from one port so they cannot drift', () => {
    const config = createHttpEndpointConfig({ port: 9111 })

    expect(config.mcpUrl.href).toBe('http://127.0.0.1:9111/mcp')
    expect(config.issuerUrl.href).toBe('http://127.0.0.1:9111/')
    expect(config.bindHost).toBe('127.0.0.1')
    expect(config.port).toBe(9111)
  })

  it('binds loopback and only loopback', () => {
    // Not configurable on purpose. A LAN bind fails the SDK's own issuer check,
    // widens the exposure of a credential that opens someone's front door, and
    // would need HTTPS to be defensible.
    expect(createHttpEndpointConfig().bindHost).toBe('127.0.0.1')
    expect(createHttpEndpointConfig().mcpUrl.hostname).toBe('127.0.0.1')
  })

  it('allows both loopback spellings as origins, because a browser picks one of them', () => {
    expect(createHttpEndpointConfig({ port: 8431 }).allowedOrigins).toEqual([
      'http://127.0.0.1:8431',
      'http://localhost:8431',
    ])
  })

  it('defaults to a port outside every default ephemeral range', () => {
    // Linux hands out 32768 to 60999, macOS and Windows 49152 up. A default in
    // one of those can be taken transiently by something else between restarts.
    expect(DEFAULT_HTTP_PORT).toBe(8431)
    expect(DEFAULT_HTTP_PORT).toBeGreaterThan(1024)
    expect(DEFAULT_HTTP_PORT).toBeLessThan(32768)
  })
})

describe('portInUseMessage', () => {
  it('names the port and the flag rather than suggesting a fallback', () => {
    const message = portInUseMessage(8431)
    expect(message).toContain('8431')
    expect(message).toContain('--port')
    expect(message).toContain('Nothing was moved to another port on purpose')
  })
})
