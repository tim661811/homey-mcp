import { describe, expect, it } from 'vitest'

import type { SignInPageState } from './page.js'
import { escapeHtml, renderSignInPage, SIGN_IN_PAGE_HEADERS } from './page.js'

const BASE: SignInPageState = {
  formAction: '/authorize/continue',
  pendingId: 'a1b2c3',
  csrfToken: 'd4e5f6',
  homey: { kind: 'not_signed_in', reason: 'The session lapsed.', instruction: 'Run "homey login".' },
}

describe('renderSignInPage', () => {
  it('offers both routes side by side, neither as the fallback', () => {
    const html = renderSignInPage(BASE)

    expect(html).toContain('Use the Homey CLI session')
    expect(html).toContain('Paste a Personal Access Token')
    expect(html).toContain('Run &quot;homey login&quot;.')
  })

  it('says the CLI is only read, never run', () => {
    // A page served by a background daemon running the official CLI is exactly
    // the invisible automatic caller this project forbids.
    expect(renderSignInPage(BASE)).toContain('never runs the CLI')
  })

  it('carries the pending id and the CSRF token in hidden fields rather than a cookie', () => {
    const html = renderSignInPage(BASE)

    expect(html).toContain('<input type="hidden" name="pendingId" value="a1b2c3">')
    expect(html).toContain('<input type="hidden" name="csrfToken" value="d4e5f6">')
  })

  it('shows nothing to decide when there is nothing being authorized', () => {
    const html = renderSignInPage(BASE)
    expect(html).not.toContain('value="allow"')
  })

  it('lets Allow be pressed even when the Homey is unreachable', () => {
    // Refusing to mint a token because the hub is unreachable would rebuild the
    // exact failure this project already fixed: an unactionable red state for a
    // reason that has nothing to do with the client.
    const html = renderSignInPage({
      ...BASE,
      consent: {
        clientName: 'Claude Code (homey-http)',
        redirectHost: 'localhost:3118',
        redirectIsLoopback: true,
        scopes: ['homey'],
      },
    })

    expect(html).toContain('value="allow"')
    expect(html).toContain('You can allow access before your Homey is signed in')
  })

  it('names the redirect host and warns when it is a loopback one', () => {
    const html = renderSignInPage({
      ...BASE,
      consent: {
        clientName: 'Claude Code (homey-http)',
        redirectHost: 'localhost:3118',
        redirectIsLoopback: true,
        scopes: ['homey'],
      },
    })

    expect(html).toContain('localhost:3118')
    expect(html).toContain('a program running on this computer')
  })

  it('escapes anything a client chose for itself', () => {
    const html = renderSignInPage({
      ...BASE,
      consent: {
        clientName: '<script>alert(1)</script>',
        redirectHost: 'localhost:3118',
        redirectIsLoopback: true,
        scopes: ['homey'],
      },
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('says nothing left to do when the Homey is already signed in', () => {
    const html = renderSignInPage({
      ...BASE,
      homey: {
        kind: 'signed_in',
        homeyName: 'Home',
        modelName: 'Homey Pro (Early 2019)',
        firmware: '13.2.4',
        sessionExpiresAt: null,
      },
    })

    expect(html).toContain('Signed in to "Home"')
    expect(html).not.toContain('Paste a Personal Access Token')
  })

  it('loads nothing from anywhere, which is what makes the token field safe', () => {
    const html = renderSignInPage(BASE)

    expect(html).not.toContain('<script')
    expect(html).not.toContain('src=')
    expect(SIGN_IN_PAGE_HEADERS['Content-Security-Policy']).toContain("default-src 'none'")
    // A specification MUST for a consent page.
    expect(SIGN_IN_PAGE_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(SIGN_IN_PAGE_HEADERS['Cache-Control']).toBe('no-store')
    expect(SIGN_IN_PAGE_HEADERS['Referrer-Policy']).toBe('no-referrer')
  })

  it('posts the token field rather than putting it in a URL', () => {
    const html = renderSignInPage(BASE)
    expect(html).toContain('method="post"')
    expect(html).toContain('type="password"')
    expect(html).not.toContain('method="get"')
  })
})

describe('the approval code field', () => {
  const CONSENT: SignInPageState = {
    ...BASE,
    consent: {
      clientName: 'Claude Code',
      redirectHost: 'localhost:3118',
      redirectIsLoopback: true,
      scopes: ['homey'],
    },
  }

  it('is absent when the connection was attributed to this account', () => {
    const html = renderSignInPage(CONSENT)

    expect(html).not.toContain('name="approvalCode"')
    expect(html).not.toContain('approval code')
  })

  it('is on both actions that grant something, and says where the code comes from', () => {
    // One field per form, because a browser only submits the inputs inside the
    // form that was submitted. Allow grants a token; the token field writes a
    // credential to disk. Cancel and recheck grant nothing and stay open.
    const html = renderSignInPage({ ...CONSENT, approvalCodeRequired: true })

    expect(html.match(/name="approvalCode"/g)).toHaveLength(2)
    expect(html).toContain('service status')
    expect(html).toContain('cannot tell which account')
  })
})

describe('escapeHtml', () => {
  it('handles every character that can break out of text or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})
