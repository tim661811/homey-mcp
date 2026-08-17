// The page the user's browser shows.
//
// Two things it is and one it is not. It is this server's authorization and
// consent screen, which the MCP specification leaves entirely to the
// implementation ("The implementation details of the authorization server are
// beyond the scope of this specification"). It is also where the Homey
// credential finally becomes reachable without a terminal. It is NOT elicitation:
// nothing here travels through the model, the MCP client or the transcript, which
// is exactly the guarantee that makes it legitimate to offer a Personal Access
// Token field at all. The prohibition this project already encodes is on FORM mode
// elicitation, and the same passage says a server MUST use the browser for
// sensitive information instead.
//
// This module returns a string and imports nothing from express and nothing from
// the SDK, so both mount points render the same page and a test can read the HTML
// without a server anywhere in sight.

import { RESOURCE_NAME } from '../http/config.js'

/** What the Homey half of the page found when it last looked. */
export type HomeySignInState =
  | { kind: 'signed_in'; homeyName: string; modelName: string; firmware: string; sessionExpiresAt: string | null }
  | { kind: 'not_signed_in'; reason: string; instruction: string }

export interface ConsentDetails {
  /** The client's own name, as it registered itself. */
  clientName: string
  /**
   * The host of the redirect URI, which the specification requires be displayed:
   * "Authorization servers ... MUST clearly display the redirect URI hostname
   * during authorization".
   */
  redirectHost: string
  /** True when the redirect goes to a loopback address, which earns the extra sentence. */
  redirectIsLoopback: boolean
  scopes: string[]
}

export interface SignInPageState {
  /** Where the form posts back to. Same origin, so the CSP `form-action 'self'` holds. */
  formAction: string
  /** Carried in hidden fields rather than a cookie. See `oauthProvider.ts`. */
  pendingId: string
  csrfToken: string
  homey: HomeySignInState
  /** Absent in a mode where nothing is being authorized, present for the consent screen. */
  consent?: ConsentDetails
  /** A sentence about what just happened, for instance a token that did not verify. */
  notice?: { kind: 'good' | 'bad'; message: string }
  /**
   * True when this computer could not say which account the request came from,
   * so the two actions that grant something ask for the code out of the mode
   * 0600 state file. See `http/peerIdentity.ts`.
   */
  approvalCodeRequired?: boolean
}

/** The headers this page is always served with, whatever mounts it. */
export const SIGN_IN_PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  // `frame-ancestors` is a specification MUST for a consent page. `default-src
  // 'none'` is what makes it certain that a credential typed into the field
  // below cannot be exfiltrated by something the page loaded, because the page
  // is allowed to load nothing at all.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
}

/**
 * Renders the whole page.
 *
 * Nothing the caller passes reaches the output unescaped, and the submitted
 * Personal Access Token is not among the inputs at all: it never comes back to
 * this function, so it cannot be re-rendered into the field by accident. That
 * is the point of the `notice` shape being a sentence rather than the form's
 * previous values.
 */
export function renderSignInPage(state: SignInPageState): string {
  const sections = [
    renderIntroduction(state.consent),
    state.notice === undefined ? '' : renderNotice(state.notice),
    renderHomeySection(state),
    state.consent === undefined ? '' : renderDecision(state),
  ]

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(RESOURCE_NAME)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<main>',
    ...sections.filter((section) => section !== ''),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function renderIntroduction(consent: ConsentDetails | undefined): string {
  if (consent === undefined) {
    return [
      '<h1>Sign in to your Homey</h1>',
      '<p>This page is served by homey-mcp, running on this computer. Nothing you type here',
      'leaves this machine except to Athom, and none of it reaches your assistant.</p>',
    ].join('\n')
  }

  const loopbackNote = consent.redirectIsLoopback
    ? ' (a program running on this computer)'
    : ''

  return [
    '<h1>Allow access to your Homey?</h1>',
    `<p><strong>${escapeHtml(consent.clientName)}</strong> is asking homey-mcp for permission to read`,
    'and control your Homey on your behalf.</p>',
    `<p class="detail">It will be returned to <code>${escapeHtml(consent.redirectHost)}</code>${loopbackNote}.</p>`,
    `<p class="detail">Permissions requested: <code>${escapeHtml(consent.scopes.join(' ') || 'none')}</code></p>`,
  ].join('\n')
}

function renderNotice(notice: { kind: 'good' | 'bad'; message: string }): string {
  return `<p class="notice ${notice.kind === 'good' ? 'good' : 'bad'}">${escapeHtml(notice.message)}</p>`
}

function renderHomeySection(state: SignInPageState): string {
  const hidden = renderHiddenFields(state)

  if (state.homey.kind === 'signed_in') {
    const until =
      state.homey.sessionExpiresAt === null
        ? 'It renews itself.'
        : `This session lasts until ${escapeHtml(state.homey.sessionExpiresAt)} and renews itself.`
    return [
      '<section>',
      '<h2>Your Homey</h2>',
      `<p class="good">Signed in to "${escapeHtml(state.homey.homeyName)}", a ${escapeHtml(state.homey.modelName)}`,
      `on firmware ${escapeHtml(state.homey.firmware)}. ${until}</p>`,
      '</section>',
    ].join('\n')
  }

  return [
    '<section>',
    '<h2>Your Homey</h2>',
    `<p class="bad">${escapeHtml(state.homey.reason)}</p>`,
    '<div class="routes">',
    '<div class="route">',
    '<h3>Use the Homey CLI session</h3>',
    `<p>${escapeHtml(state.homey.instruction)}</p>`,
    '<p class="detail">This route can create Flows, because the CLI\'s session carries the scope Athom',
    'withholds from everything else. This page only reads that session, it never runs the CLI.</p>',
    `<form method="post" action="${escapeHtml(state.formAction)}">`,
    hidden,
    '<input type="hidden" name="action" value="recheck">',
    '<button type="submit">Check again</button>',
    '</form>',
    '</div>',
    '<div class="route">',
    '<h3>Paste a Personal Access Token</h3>',
    '<p>Create one at <code>https://tools.developer.homey.app/me</code> and paste it here. It is',
    'checked against your Homey before anything is written to disk.</p>',
    '<p class="detail">This route reads your whole home, its sensor history and its energy use. It',
    'cannot create Flows, because Athom withholds that scope from tokens like this one.</p>',
    `<form method="post" action="${escapeHtml(state.formAction)}" autocomplete="off">`,
    hidden,
    '<input type="hidden" name="action" value="personal_access_token">',
    '<label for="personalAccessToken">Personal Access Token</label>',
    '<input id="personalAccessToken" name="personalAccessToken" type="password" autocomplete="off" spellcheck="false" required>',
    renderApprovalCodeField(state, 'personalAccessTokenApprovalCode'),
    '<button type="submit">Verify and save</button>',
    '</form>',
    '</div>',
    '</div>',
    '</section>',
  ].join('\n')
}

/**
 * Allow works even when the Homey section is unresolved, and that is deliberate.
 *
 * Refusing to mint a token because the hub is unreachable would rebuild the exact
 * failure this project already spent days fixing: a client showing an
 * unactionable red state for a reason that has nothing to do with the client. A
 * token with no Homey session behind it produces a connected server whose tools
 * say what to do, which is strictly better.
 */
function renderDecision(state: SignInPageState): string {
  const hidden = renderHiddenFields(state)

  return [
    '<section class="decision">',
    state.homey.kind === 'signed_in'
      ? ''
      : '<p class="detail">You can allow access before your Homey is signed in. The tools will then say what is missing.</p>',
    renderApprovalCodeExplanation(state),
    `<form method="post" action="${escapeHtml(state.formAction)}">`,
    hidden,
    '<input type="hidden" name="action" value="allow">',
    renderApprovalCodeField(state, 'allowApprovalCode'),
    '<button type="submit" class="primary">Allow</button>',
    '</form>',
    `<form method="post" action="${escapeHtml(state.formAction)}">`,
    hidden,
    '<input type="hidden" name="action" value="cancel">',
    '<button type="submit" class="secondary">Cancel</button>',
    '</form>',
    '</section>',
  ].join('\n')
}

/**
 * The code field, rendered only when the connection could not be attributed to
 * an account.
 *
 * Two fields rather than one shared field, because each form posts on its own
 * and a browser only submits the inputs inside the form that was submitted.
 */
function renderApprovalCodeField(state: SignInPageState, fieldId: string): string {
  if (state.approvalCodeRequired !== true) return ''

  return [
    `<label for="${escapeHtml(fieldId)}">Approval code</label>`,
    `<input id="${escapeHtml(fieldId)}" name="approvalCode" type="text" autocomplete="off" spellcheck="false"`,
    ' inputmode="text" placeholder="0000-0000-0000" required>',
  ].join('')
}

/** Says where the code comes from, once, above the buttons that ask for it. */
function renderApprovalCodeExplanation(state: SignInPageState): string {
  if (state.approvalCodeRequired !== true) return ''

  return [
    '<p class="detail">This computer cannot tell which account opened this page, so approving needs',
    'a code that only your account can read. Run <code>npx homey-mcp service status</code> in a',
    'terminal here and copy the approval code it prints.</p>',
  ].join('\n')
}

function renderHiddenFields(state: SignInPageState): string {
  return [
    `<input type="hidden" name="pendingId" value="${escapeHtml(state.pendingId)}">`,
    `<input type="hidden" name="csrfToken" value="${escapeHtml(state.csrfToken)}">`,
  ].join('\n')
}

/** A page that names a problem and offers nothing to click, for a request with no valid pending sign-in. */
export function renderProblemPage(title: string, detail: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="bad">${escapeHtml(detail)}</p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

const STYLES = [
  ':root{color-scheme:light dark}',
  'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;margin:0;padding:2rem 1rem}',
  'main{max-width:44rem;margin:0 auto}',
  'h1{font-size:1.6rem;margin:0 0 1rem}',
  'h2{font-size:1.15rem;margin:2rem 0 .5rem}',
  'h3{font-size:1rem;margin:0 0 .5rem}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;word-break:break-all}',
  '.detail{font-size:.9rem;opacity:.75}',
  '.notice{padding:.6rem .8rem;border-radius:.4rem;border:1px solid currentColor}',
  '.good{color:#0a7a3d}',
  '.bad{color:#a3260f}',
  '.routes{display:flex;flex-wrap:wrap;gap:1.5rem}',
  '.route{flex:1 1 18rem;border:1px solid rgba(128,128,128,.4);border-radius:.5rem;padding:1rem}',
  '.decision{display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-end;margin-top:2rem}',
  '.decision .detail{flex:1 1 100%;margin:0}',
  'label{display:block;font-size:.9rem;margin-top:.75rem}',
  'input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 .75rem;font-size:1rem}',
  'button{font:inherit;padding:.5rem 1rem;border-radius:.4rem;border:1px solid rgba(128,128,128,.6);cursor:pointer;background:transparent}',
  'button.primary{font-weight:600}',
].join('')

/**
 * Escapes the five characters that can break out of text or an attribute value.
 *
 * Written here rather than pulled in, because the whole page deliberately has no
 * dependencies: a templating library would be a production dependency earned by
 * one function.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
