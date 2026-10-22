import { attributeCursorCosts, CURSOR_SETTLE_MS, sqliteUtcMs, type CursorUsageEvent } from '@shared/cursorCosts'
import type { CursorCostsStatus } from '@shared/integrations'
import { getSetting, setSetting, type Db } from '../db'
import type { FetchLike } from './linear'
import type { SecretCodec } from './linearAuth'

const API = 'https://api.cursor.com'
/** Cursor aggregates usage hourly and asks for polling no more often than that. */
const INTERVAL_MS = 60 * 60 * 1000
/** Runs older than this that never got a cost are left alone. */
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000

interface UnsettledRun {
  id: number
  session_id: string | null
  started_at: string
  ended_at: string
  tokens: number
}

/** The account the Cursor CLI is signed in as, from `cursor-agent status` ("Logged in as you@example.com"). */
export function parseCursorEmail(output: string): string | null {
  return output.match(/Logged in as (\S+@\S+)/i)?.[1] ?? null
}

/**
 * Fills in what Cursor charged for each Cursor run, from the team's Admin API (Team and Enterprise plans).
 * The key is encrypted at rest like the Linear tokens and never sent back to the screens. A run's cost is
 * final two hours after it ends; until then the Costs screen shows it as pending.
 */
export class CursorCosts {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: Db,
    private readonly codec: SecretCodec,
    /** Who the Cursor CLI is signed in as, so a teammate's usage isn't counted. */
    private readonly cliEmail: () => Promise<string | null>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now
  ) {}

  private key(): string | null {
    const stored = getSetting<string | null>(this.db, 'cursor.adminKey', null)
    return stored ? this.codec.decrypt(stored) : null
  }

  configured(): boolean {
    return getSetting<string | null>(this.db, 'cursor.adminKey', null) !== null
  }

  status(): CursorCostsStatus {
    return {
      configured: this.configured(),
      email: getSetting<string | null>(this.db, 'cursor.email', null),
      lastSyncAt: getSetting<string | null>(this.db, 'cursor.lastSyncAt', null),
      lastError: getSetting<string | null>(this.db, 'cursor.lastError', null),
      pending: this.unsettled().length
    }
  }

  /** Checks the key against the Admin API, then saves it with the CLI's account and fills in costs. */
  async saveKey(key: string): Promise<CursorCostsStatus> {
    const trimmed = key.trim()
    if (!trimmed) throw new Error("Paste an Admin API key from your Cursor team's dashboard")
    const end = this.now()
    await this.usageEvents(trimmed, end - 60 * 60 * 1000, end, null)
    setSetting(this.db, 'cursor.adminKey', this.codec.encrypt(trimmed))
    setSetting(this.db, 'cursor.email', await this.cliEmail())
    setSetting(this.db, 'cursor.lastError', null)
    await this.sync()
    return this.status()
  }

  removeKey(): CursorCostsStatus {
    for (const key of ['cursor.adminKey', 'cursor.email', 'cursor.lastSyncAt', 'cursor.lastError']) setSetting(this.db, key, null)
    return this.status()
  }

  private unsettled(): UnsettledRun[] {
    const since = new Date(this.now() - LOOKBACK_MS).toISOString().replace('T', ' ').slice(0, 19)
    return this.db
      .prepare(
        `SELECT id, session_id, started_at, ended_at, COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(tokens_cached, 0) AS tokens
         FROM runs WHERE adapter = 'cursor' AND cost_source IS NULL AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY started_at`
      )
      .all(since) as UnsettledRun[]
  }

  private async usageEvents(key: string, startDate: number, endDate: number, email: string | null): Promise<CursorUsageEvent[]> {
    const events: CursorUsageEvent[] = []
    for (let page = 1; ; page++) {
      const response = await this.fetchImpl(`${API}/teams/filtered-usage-events`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, ...(email ? { email } : {}), page, pageSize: 1000 })
      })
      if (response.status === 401 || response.status === 403) throw new Error("Cursor didn't accept the Admin API key. Check it's an admin key for your team.")
      if (!response.ok) throw new Error(`Cursor's Admin API answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
      const body = (await response.json()) as {
        usageEvents?: { timestamp: string | number; conversationId?: string; isHeadless?: boolean; chargedCents?: number }[]
        pagination?: { hasNextPage?: boolean }
      }
      for (const event of body.usageEvents ?? []) {
        events.push({ timestamp: Number(event.timestamp), conversationId: event.conversationId, isHeadless: event.isHeadless, chargedCents: Number(event.chargedCents ?? 0) })
      }
      if (!body.pagination?.hasNextPage) return events
    }
  }

  /** Fetches usage since the oldest Cursor run without a cost, and settles every run that ended two hours ago. */
  async sync(): Promise<void> {
    const key = this.key()
    if (!key) return
    const runs = this.unsettled()
    if (runs.length === 0) return
    try {
      const windows = runs.map((run) => ({ id: run.id, sessionId: run.session_id, startedMs: sqliteUtcMs(run.started_at), endedMs: sqliteUtcMs(run.ended_at), tokens: run.tokens }))
      const now = this.now()
      const events = await this.usageEvents(key, Math.min(...windows.map((run) => run.startedMs)) - 5 * 60 * 1000, now, getSetting<string | null>(this.db, 'cursor.email', null))
      const cents = attributeCursorCosts(windows, events)
      const settle = this.db.prepare("UPDATE runs SET cost_usd = ?, cost_source = 'cursor' WHERE id = ?")
      this.db.transaction(() => {
        for (const run of windows) {
          if (run.endedMs + CURSOR_SETTLE_MS <= now) settle.run(Math.round(cents.get(run.id) ?? 0) / 100, run.id)
        }
      })()
      setSetting(this.db, 'cursor.lastSyncAt', new Date(now).toISOString())
      setSetting(this.db, 'cursor.lastError', null)
    } catch (error) {
      setSetting(this.db, 'cursor.lastError', (error as Error).message)
    }
  }

  start(): void {
    if (this.timer) return
    setTimeout(() => void this.sync(), 15_000)
    this.timer = setInterval(() => void this.sync(), INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
