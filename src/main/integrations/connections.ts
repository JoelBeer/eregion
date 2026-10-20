import { connectionProblems, type Connection, type ConnectionInput } from '@shared/sources'
import { getSetting, setSetting, type Db } from '../db'
import type { FetchLike } from './linear'
import type { SecretCodec } from './linearAuth'

interface StoredConnection extends Connection {
  /** Encrypted with the OS keychain where there is one (see SecretCodec). */
  secret: string
}

/** Who a connection is signed in as. */
export type WhoAmI = (connection: Connection, token: string) => Promise<string>

/**
 * Jira and GitLab accounts, added in Settings › Integrations. Several of each are fine (two Jira sites, a
 * gitlab.com account and a company GitLab). Tokens are encrypted at rest and never sent back to the screens.
 */
export class Connections {
  constructor(
    private readonly db: Db,
    private readonly codec: SecretCodec,
    private readonly whoAmI: Record<Connection['kind'], WhoAmI>
  ) {}

  private stored(): StoredConnection[] {
    return getSetting<StoredConnection[]>(this.db, 'integrations.connections', [])
  }

  private write(connections: StoredConnection[]): void {
    setSetting(this.db, 'integrations.connections', connections)
  }

  list(): Connection[] {
    return this.stored().map(({ secret: _secret, ...connection }) => connection)
  }

  get(id: string): Connection {
    const found = this.list().find((connection) => connection.id === id)
    if (!found) throw new Error("That connection isn't set up any more: pick another in Settings › Integrations")
    return found
  }

  token(id: string): string {
    const found = this.stored().find((connection) => connection.id === id)
    if (!found) throw new Error("That connection isn't set up any more: pick another in Settings › Integrations")
    return this.codec.decrypt(found.secret)
  }

  /** Adds a connection, or edits one; an empty token keeps the saved one. Then checks who it signs in as. */
  async save(input: ConnectionInput): Promise<Connection> {
    const existing = input.id ? this.stored().find((connection) => connection.id === input.id) : undefined
    const problems = connectionProblems(input, Boolean(existing))
    if (problems.length > 0) throw new Error(problems.join('. '))
    const id = existing?.id ?? `${input.kind}-${Date.now().toString(36)}`
    const connection: StoredConnection = {
      id,
      kind: input.kind,
      name: input.name.trim(),
      url: input.url.trim().replace(/\/+$/, ''),
      ...(input.kind === 'jira' ? { email: input.email?.trim() } : {}),
      account: existing?.account ?? null,
      testedAt: existing?.testedAt ?? null,
      error: null,
      secret: input.token.trim() ? this.codec.encrypt(input.token.trim()) : (existing?.secret as string)
    }
    this.write([...this.stored().filter((item) => item.id !== id), connection])
    return this.test(id)
  }

  remove(id: string): void {
    this.write(this.stored().filter((connection) => connection.id !== id))
  }

  /** Signs in and records who as, or what went wrong. */
  async test(id: string): Promise<Connection> {
    const connection = this.get(id)
    let patch: Pick<Connection, 'account' | 'error' | 'testedAt'>
    try {
      patch = { account: await this.whoAmI[connection.kind](connection, this.token(id)), error: null, testedAt: new Date().toISOString() }
    } catch (error) {
      patch = { account: null, error: (error as Error).message, testedAt: new Date().toISOString() }
    }
    this.write(this.stored().map((item) => (item.id === id ? { ...item, ...patch } : item)))
    return this.get(id)
  }
}

/** A JSON request to a REST API, with a readable error when it fails. */
export async function restJson<T>(fetchImpl: FetchLike, service: string, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }): Promise<T> {
  const response = await fetchImpl(url, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : (undefined as unknown as string)
  })
  if (response.status === 401 || response.status === 403) throw new Error(`${service} rejected the token. Check the connection in Settings › Integrations.`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${service} answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}
