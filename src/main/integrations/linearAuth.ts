import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { callbackUrl, OAUTH_PORTS, type ImportAssignees, type LinearViewer } from '@shared/integrations'
import { getSetting, setSetting, type Db } from '../db'
import { LinearClient, type FetchLike, type LinearCredential } from './linear'

export const LINEAR_AUTHORIZE = 'https://linear.app/oauth/authorize'
export const LINEAR_TOKEN = 'https://api.linear.app/oauth/token'
const SCOPES = 'read,write'

/** Encrypts secrets at rest. Electron's safeStorage in the app; tests and the web preview store plain text. */
export interface SecretCodec {
  encrypt(text: string): string
  decrypt(text: string): string
}

export const PLAIN_CODEC: SecretCodec = { encrypt: (text) => text, decrypt: (text) => text }

type StoredCredential =
  | { method: 'api-key'; key: string }
  | { method: 'oauth'; accessToken: string; refreshToken: string | null; expiresAt: number | null; clientId: string; clientSecret?: string }

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authorizeUrl(options: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    prompt: 'consent'
  })
  return `${LINEAR_AUTHORIZE}?${params.toString()}`
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#EAF8FB;color:#052E45;display:grid;place-items:center;min-height:90vh"><div style="background:#fff;border-radius:14px;padding:28px 32px;max-width:420px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p style="margin:0">${text}</p></div>`

/** Listens on the first free loopback port for Linear's redirect, and resolves with the code. */
export async function listenForCode(state: string, timeoutMs = 5 * 60_000): Promise<{ redirectUri: string; code: Promise<string>; close: () => void }> {
  for (const port of OAUTH_PORTS) {
    const server = createServer()
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (!listening) continue
    const close = (): void => void server.close()
    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        close()
        reject(new Error('Linear sign-in timed out. Try again.'))
      }, timeoutMs)
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== '/oauth/callback') {
          response.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const received = url.searchParams.get('code')
        const finish = (ok: boolean, message: string): void => {
          response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(ok ? 'Linear is connected' : 'Linear sign-in failed', message))
          clearTimeout(timer)
          setTimeout(close, 100)
        }
        if (url.searchParams.get('state') !== state) {
          finish(false, "This sign-in didn't come from Eregion. Start it again from Eregion.")
          reject(new Error("Linear's answer didn't match this sign-in. Try again."))
        } else if (error || !received) {
          finish(false, url.searchParams.get('error_description') ?? error ?? 'No code came back.')
          reject(new Error(`Linear sign-in failed: ${url.searchParams.get('error_description') ?? error ?? 'no code came back'}`))
        } else {
          finish(true, 'You can close this tab and go back to Eregion.')
          resolve(received)
        }
      })
    })
    // The callback can fail before anyone awaits the code (while the browser is still opening).
    code.catch(() => undefined)
    return { redirectUri: callbackUrl(port), code, close }
  }
  throw new Error(`Ports ${OAUTH_PORTS.join(', ')} are all in use, so Linear can't send you back to Eregion. Close whatever is using them and try again.`)
}

/**
 * The Linear connection: the user's own private OAuth app with PKCE (no client secret), or a
 * personal API key. Credentials live encrypted in the settings table; OAuth tokens refresh themselves.
 */
export class LinearAuth {
  private pending: { close: () => void } | null = null

  constructor(
    private readonly db: Db,
    private readonly codec: SecretCodec,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  clientId(): string | null {
    return getSetting<string | null>(this.db, 'linear.clientId', null)
  }

  setClientId(clientId: string): void {
    setSetting(this.db, 'linear.clientId', clientId.trim() || null)
  }

  viewer(): LinearViewer | null {
    return getSetting<LinearViewer | null>(this.db, 'linear.viewer', null)
  }

  importAssignees(): ImportAssignees {
    return getSetting<ImportAssignees>(this.db, 'linear.importAssignees', { mode: 'me' })
  }

  setImportAssignees(value: ImportAssignees): void {
    setSetting(this.db, 'linear.importAssignees', value.mode === 'people' && value.people.length === 0 ? { mode: 'me' } : value)
  }

  method(): 'oauth' | 'api-key' | null {
    return this.stored()?.method ?? null
  }

  private stored(): StoredCredential | null {
    const sealed = getSetting<string | null>(this.db, 'linear.credential', null)
    if (!sealed) return null
    try {
      return JSON.parse(this.codec.decrypt(sealed)) as StoredCredential
    } catch {
      return null
    }
  }

  private store(credential: StoredCredential | null): void {
    setSetting(this.db, 'linear.credential', credential ? this.codec.encrypt(JSON.stringify(credential)) : null)
  }

  /** A client for the current connection, or null when Linear isn't connected. */
  client(): LinearClient | null {
    const stored = this.stored()
    if (!stored) return null
    const credential: LinearCredential = stored.method === 'api-key' ? { kind: 'api-key', key: stored.key } : { kind: 'oauth', token: () => this.accessToken() }
    return new LinearClient(credential, this.fetchImpl)
  }

  private async tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const response = await this.fetchImpl(LINEAR_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    })
    const body = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } | null
    if (!response.ok || !body?.access_token) throw new Error(`Linear didn't give a token: ${body?.error_description ?? body?.error ?? response.status}`)
    return body as { access_token: string; refresh_token?: string; expires_in?: number }
  }

  /** The OAuth access token, refreshed when it's within five minutes of expiring. */
  async accessToken(): Promise<string> {
    const stored = this.stored()
    if (!stored || stored.method !== 'oauth') throw new Error('Linear is not connected with OAuth')
    if (!stored.expiresAt || stored.expiresAt - Date.now() > 5 * 60_000) return stored.accessToken
    if (!stored.refreshToken) throw new Error('Your Linear sign-in has expired. Connect Linear again in Settings › Accounts.')
    const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: stored.clientId }
    if (stored.clientSecret) params.client_secret = stored.clientSecret
    const token = await this.tokenRequest(params)
    this.store({ ...stored, accessToken: token.access_token, refreshToken: token.refresh_token ?? stored.refreshToken, expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null })
    return token.access_token
  }

  /**
   * Signs in through the browser: opens Linear's consent page for the user's own app, waits for the
   * redirect on a loopback port, and swaps the code for tokens with the PKCE verifier.
   */
  async signIn(openUrl: (url: string) => Promise<void>, clientSecret?: string): Promise<LinearViewer> {
    const clientId = this.clientId()
    if (!clientId) throw new Error('Paste the client ID of your Linear app first')
    this.pending?.close()
    const state = randomBytes(16).toString('base64url')
    const { verifier, challenge } = pkcePair()
    const listener = await listenForCode(state)
    this.pending = listener
    try {
      await openUrl(authorizeUrl({ clientId, redirectUri: listener.redirectUri, state, challenge }))
      const code = await listener.code
      const params: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: listener.redirectUri, client_id: clientId, code_verifier: verifier }
      if (clientSecret) params.client_secret = clientSecret
      const token = await this.tokenRequest(params)
      const credential: StoredCredential = {
        method: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
        clientId,
        ...(clientSecret ? { clientSecret } : {})
      }
      return await this.connect(credential)
    } finally {
      listener.close()
      this.pending = null
    }
  }

  cancelSignIn(): void {
    this.pending?.close()
    this.pending = null
  }

  async useApiKey(key: string): Promise<LinearViewer> {
    if (!key.trim().startsWith('lin_api_')) throw new Error('A Linear personal API key starts with lin_api_')
    return this.connect({ method: 'api-key', key: key.trim() })
  }

  /** Checks the credential works before keeping it. */
  private async connect(credential: StoredCredential): Promise<LinearViewer> {
    const client = new LinearClient(credential.method === 'api-key' ? { kind: 'api-key', key: credential.key } : { kind: 'oauth', token: async () => credential.accessToken }, this.fetchImpl)
    const viewer = await client.viewer()
    this.store(credential)
    setSetting(this.db, 'linear.viewer', viewer)
    return viewer
  }

  signOut(): void {
    this.store(null)
    setSetting(this.db, 'linear.viewer', null)
  }
}
